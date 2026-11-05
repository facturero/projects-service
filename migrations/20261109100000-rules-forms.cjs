/**
 * Entregable 7 (reglas, formularios y panel):
 *
 * - project_rules: «cuando pase X, haz Y» en un proyecto, como las reglas de Asana. Un disparador (tarea agregada, movida a una
 *   sección o completada; opcionalmente solo en una sección) y hasta 5 acciones en JSON. Corren a nombre de quien creó la regla.
 *   `run_count`, `last_run_at` y `last_error` dicen si la regla está funcionando.
 * - project_forms: formulario de solicitud que crea una tarea en el proyecto (preguntas en JSON). Lo llena cualquiera de la
 *   organización, aunque no sea miembro: así se piden cosas a un equipo sin darle acceso a todo su proyecto.
 *
 * El panel no tiene tablas: se calcula con lo que ya hay.
 */
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('project_rules', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      organization_id: { type: Sequelize.CHAR(36), allowNull: false },
      project_id: { type: Sequelize.CHAR(36), allowNull: false, references: { model: 'projects', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },
      name: { type: Sequelize.STRING(120), allowNull: false },
      trigger_type: { type: Sequelize.ENUM('task_added', 'task_moved', 'task_completed'), allowNull: false },
      trigger_section_id: { type: Sequelize.CHAR(36), allowNull: true },
      actions: { type: Sequelize.JSON, allowNull: false },
      enabled: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      run_count: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
      last_run_at: { type: Sequelize.DATE, allowNull: true },
      last_error: { type: Sequelize.STRING(500), allowNull: true },
      created_by: { type: Sequelize.CHAR(36), allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('project_rules', ['organization_id', 'project_id']);

    await queryInterface.createTable('project_forms', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      organization_id: { type: Sequelize.CHAR(36), allowNull: false },
      project_id: { type: Sequelize.CHAR(36), allowNull: false, references: { model: 'projects', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },
      title: { type: Sequelize.STRING(120), allowNull: false },
      description: { type: Sequelize.STRING(1000), allowNull: true },
      questions: { type: Sequelize.JSON, allowNull: false },
      section_id: { type: Sequelize.CHAR(36), allowNull: true },
      assignee_user_id: { type: Sequelize.CHAR(36), allowNull: true },
      enabled: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      submission_count: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
      created_by: { type: Sequelize.CHAR(36), allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('project_forms', ['organization_id', 'project_id']);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('project_forms');
    await queryInterface.dropTable('project_rules');
  },
};
