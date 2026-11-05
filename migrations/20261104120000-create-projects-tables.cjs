/**
 * Tablas de projects-service (projects_db), entregable 1: proyectos, miembros, secciones, tareas y dónde aparece cada tarea.
 *
 * - projects: `visibility` (toda la organización / solo miembros) y `version` (concurrencia optimista). Papelera con `deleted_at`.
 * - project_members: rol DENTRO del proyecto (admin / editor / comentarista / lector), como en Asana.
 * - sections: columnas del tablero y grupos de la lista, ordenadas por `rank`.
 * - tasks: tareas y subtareas (un nivel: `parent_task_id`). Las fechas son DATE (sin hora): una entrega no cambia de día por la zona
 *   horaria de quien mira. `assigned_at` alimenta «Recién asignadas» de Mis tareas.
 * - task_placements: en qué proyecto, sección y posición aparece cada tarea raíz. Una tarea puede estar en VARIOS proyectos
 *   (multi-hogar de Asana), así que sección y orden viven aquí. Una tarea sin filas aquí es personal («solo mía»).
 * - outbox_messages / processed_events: patrón Outbox, esquema de @facturero/outbox-relay 0.2.x (igual que restaurant-service).
 *
 * Los `rank` son texto `0-9a-z` en `ascii_bin`: el orden de la base es byte a byte, el mismo que el de JavaScript (ver
 * src/domain/rank.ts). Con la colación por defecto (insensible a mayúsculas) también saldría bien con este alfabeto, pero `ascii_bin`
 * no depende de esa coincidencia.
 *
 * Usuarios (`*_user_id`, `created_by`) y organización son referencias lógicas a auth-service: sin FOREIGN KEY entre servicios.
 */
const RANK = 'VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('projects', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      organization_id: { type: Sequelize.CHAR(36), allowNull: false },
      name: { type: Sequelize.STRING(120), allowNull: false },
      description: { type: Sequelize.TEXT, allowNull: true },
      // Token del tema ('primary', 'success'…), nunca un hexadecimal.
      color: { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'primary' },
      icon: { type: Sequelize.STRING(60), allowNull: false, defaultValue: 'mdi-folder-outline' },
      visibility: { type: Sequelize.ENUM('organization', 'members'), allowNull: false },
      owner_user_id: { type: Sequelize.CHAR(36), allowNull: false },
      status: { type: Sequelize.ENUM('active', 'archived'), allowNull: false, defaultValue: 'active' },
      default_view: { type: Sequelize.ENUM('list', 'board'), allowNull: false, defaultValue: 'list' },
      version: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
      created_by: { type: Sequelize.CHAR(36), allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
      deleted_at: { type: Sequelize.DATE, allowNull: true },
    });
    await queryInterface.addIndex('projects', ['organization_id', 'status', 'visibility']);

    await queryInterface.createTable('project_members', {
      project_id: {
        type: Sequelize.CHAR(36),
        primaryKey: true,
        references: { model: 'projects', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      user_id: { type: Sequelize.CHAR(36), primaryKey: true },
      organization_id: { type: Sequelize.CHAR(36), allowNull: false },
      role: { type: Sequelize.ENUM('admin', 'editor', 'commenter', 'viewer'), allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false },
    });
    // «¿En qué proyectos estoy?»: lo pregunta la lista de proyectos en cada carga.
    await queryInterface.addIndex('project_members', ['organization_id', 'user_id']);

    await queryInterface.createTable('sections', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      organization_id: { type: Sequelize.CHAR(36), allowNull: false },
      project_id: {
        type: Sequelize.CHAR(36),
        allowNull: false,
        references: { model: 'projects', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      name: { type: Sequelize.STRING(120), allowNull: false },
      rank: { type: RANK, allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('sections', ['project_id', 'rank']);

    await queryInterface.createTable('tasks', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      organization_id: { type: Sequelize.CHAR(36), allowNull: false },
      parent_task_id: {
        type: Sequelize.CHAR(36),
        allowNull: true,
        references: { model: 'tasks', key: 'id' },
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      },
      title: { type: Sequelize.STRING(500), allowNull: false },
      description: { type: Sequelize.TEXT, allowNull: true },
      assignee_user_id: { type: Sequelize.CHAR(36), allowNull: true },
      assigned_at: { type: Sequelize.DATE, allowNull: true },
      start_on: { type: Sequelize.DATEONLY, allowNull: true },
      due_on: { type: Sequelize.DATEONLY, allowNull: true },
      completed_at: { type: Sequelize.DATE, allowNull: true },
      completed_by: { type: Sequelize.CHAR(36), allowNull: true },
      subtask_rank: { type: RANK, allowNull: true },
      created_by: { type: Sequelize.CHAR(36), allowNull: false },
      version: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
      deleted_at: { type: Sequelize.DATE, allowNull: true },
    });
    // Mis tareas: lo asignado a una persona, sin completar primero.
    await queryInterface.addIndex('tasks', ['organization_id', 'assignee_user_id', 'completed_at']);
    await queryInterface.addIndex('tasks', ['parent_task_id', 'subtask_rank']);
    await queryInterface.addIndex('tasks', ['organization_id', 'created_by']);

    await queryInterface.createTable('task_placements', {
      task_id: {
        type: Sequelize.CHAR(36),
        primaryKey: true,
        references: { model: 'tasks', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      project_id: {
        type: Sequelize.CHAR(36),
        primaryKey: true,
        references: { model: 'projects', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      organization_id: { type: Sequelize.CHAR(36), allowNull: false },
      // RESTRICT: borrar una sección exige mover antes sus tarjetas (ver SectionUseCases.delete).
      section_id: {
        type: Sequelize.CHAR(36),
        allowNull: false,
        references: { model: 'sections', key: 'id' },
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      },
      rank: { type: RANK, allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('task_placements', ['project_id', 'section_id', 'rank']);
    await queryInterface.addIndex('task_placements', ['section_id']);

    await queryInterface.createTable('outbox_messages', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      aggregate_type: { type: Sequelize.STRING(50), allowNull: false },
      aggregate_id: { type: Sequelize.CHAR(36), allowNull: false },
      type: { type: Sequelize.STRING(100), allowNull: false },
      payload: { type: Sequelize.JSON, allowNull: false },
      occurred_at: { type: Sequelize.DATE, allowNull: false },
      processed_at: { type: Sequelize.DATE, allowNull: true },
    });
    await queryInterface.addIndex('outbox_messages', ['processed_at']);

    await queryInterface.createTable('processed_events', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      event_type: { type: Sequelize.STRING(100), allowNull: false },
      routing_key: { type: Sequelize.STRING(200), allowNull: false },
      payload: { type: Sequelize.JSON, allowNull: false },
      status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'processed' },
      last_error: { type: Sequelize.TEXT, allowNull: true },
      processed_at: { type: Sequelize.DATE, allowNull: false },
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('processed_events');
    await queryInterface.dropTable('outbox_messages');
    await queryInterface.dropTable('task_placements');
    await queryInterface.dropTable('tasks');
    await queryInterface.dropTable('sections');
    await queryInterface.dropTable('project_members');
    await queryInterface.dropTable('projects');
  },
};
