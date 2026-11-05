/**
 * Entregable 3 (calendario y cronograma, al estilo Asana):
 *
 * - task_dependencies: «esta tarea espera a aquella» (fin → inicio). Una tarea puede esperar a varias y bloquear a varias; el
 *   servidor impide los ciclos (A espera a B y B espera a A) antes de guardar. Las dos tareas son de la misma organización; pueden
 *   estar en proyectos distintos.
 * - project_status_updates: las actualizaciones de estado del proyecto («en curso», «en riesgo», «con retraso», «completado»), con
 *   texto enriquecido (mismo documento de TipTap que los comentarios). Solo se agregan; la última es el estado actual.
 */
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('task_dependencies', {
      task_id: {
        type: Sequelize.CHAR(36),
        primaryKey: true,
        references: { model: 'tasks', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      depends_on_task_id: {
        type: Sequelize.CHAR(36),
        primaryKey: true,
        references: { model: 'tasks', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      organization_id: { type: Sequelize.CHAR(36), allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false },
    });
    // «¿A quién bloquea esta tarea?»: se pregunta al completarla (aviso de «ya se puede empezar») y al buscar ciclos.
    await queryInterface.addIndex('task_dependencies', ['depends_on_task_id']);

    await queryInterface.createTable('project_status_updates', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      organization_id: { type: Sequelize.CHAR(36), allowNull: false },
      project_id: {
        type: Sequelize.CHAR(36),
        allowNull: false,
        references: { model: 'projects', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      status: { type: Sequelize.ENUM('on_track', 'at_risk', 'off_track', 'complete'), allowNull: false },
      body_doc: { type: 'JSON', allowNull: true },
      body_text: { type: Sequelize.TEXT, allowNull: true },
      author_user_id: { type: Sequelize.CHAR(36), allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('project_status_updates', ['project_id', 'created_at']);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('project_status_updates');
    await queryInterface.dropTable('task_dependencies');
  },
};
