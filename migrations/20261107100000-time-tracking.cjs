/**
 * Entregable 5 (horas y carga de trabajo):
 *
 * - tasks.estimated_minutes: el «tiempo estimado» de Asana. Alimenta la carga de trabajo (cuántas horas tiene cada persona por semana).
 * - time_entries: horas trabajadas en una tarea, a mano o con el cronómetro, facturables o no. `project_id` es el proyecto al que se
 *   cargan (una tarea puede estar en varios): es lo que el entregable 6 factura. La FOREIGN KEY a tasks NO borra en cascada: las
 *   tareas solo van a la papelera, y unas horas trabajadas (quizá ya cobradas) no deben desaparecer con su tarea.
 * - running_timers: el cronómetro en marcha, UNO por persona (clave primaria organización + usuario, como en Asana: arrancar otro
 *   detiene el anterior). Al detenerlo se convierte en una fila de time_entries.
 * - member_capacity: horas por semana de cada persona para la carga de trabajo (sin fila = 40 h).
 */
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('tasks', 'estimated_minutes', { type: Sequelize.INTEGER.UNSIGNED, allowNull: true, after: 'due_on' });

    await queryInterface.createTable('time_entries', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      organization_id: { type: Sequelize.CHAR(36), allowNull: false },
      task_id: { type: Sequelize.CHAR(36), allowNull: false, references: { model: 'tasks', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'RESTRICT' },
      project_id: { type: Sequelize.CHAR(36), allowNull: true },
      user_id: { type: Sequelize.CHAR(36), allowNull: false },
      worked_on: { type: Sequelize.DATEONLY, allowNull: false },
      minutes: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false },
      billable: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      note: { type: Sequelize.STRING(500), allowNull: true },
      source: { type: Sequelize.ENUM('manual', 'timer'), allowNull: false, defaultValue: 'manual' },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    // Reporte por persona y por proyecto en un rango de fechas; total de una tarea.
    await queryInterface.addIndex('time_entries', ['organization_id', 'user_id', 'worked_on']);
    await queryInterface.addIndex('time_entries', ['organization_id', 'project_id', 'worked_on']);
    await queryInterface.addIndex('time_entries', ['task_id']);

    await queryInterface.createTable('running_timers', {
      organization_id: { type: Sequelize.CHAR(36), primaryKey: true },
      user_id: { type: Sequelize.CHAR(36), primaryKey: true },
      task_id: { type: Sequelize.CHAR(36), allowNull: false, references: { model: 'tasks', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },
      project_id: { type: Sequelize.CHAR(36), allowNull: true },
      started_at: { type: Sequelize.DATE(3), allowNull: false },
    });

    await queryInterface.createTable('member_capacity', {
      organization_id: { type: Sequelize.CHAR(36), primaryKey: true },
      user_id: { type: Sequelize.CHAR(36), primaryKey: true },
      weekly_minutes: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false },
      updated_by: { type: Sequelize.CHAR(36), allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('member_capacity');
    await queryInterface.dropTable('running_timers');
    await queryInterface.dropTable('time_entries');
    await queryInterface.removeColumn('tasks', 'estimated_minutes');
  },
};
