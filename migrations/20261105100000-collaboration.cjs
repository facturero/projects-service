/**
 * Entregable 2 (colaboración, al estilo Asana):
 *
 * - tasks.kind / approval_status: tareas de APROBACIÓN (aprobar / pedir cambios / rechazar) además de las normales.
 * - tasks.description_doc: la descripción en texto enriquecido (documento de TipTap, validado en el servidor con una lista blanca de
 *   nodos y marcas). `description` (TEXT) queda como su versión en texto plano, para buscar y para los avisos.
 * - task_comments: comentarios, también en documento de TipTap, con las @menciones extraídas (`mentioned_user_ids`).
 * - task_followers: seguidores. En Asana seguir una tarea te la comparte: un seguidor la ve aunque el proyecto sea privado.
 * - likes: «me gusta» en tareas y comentarios (uno por persona y cosa).
 * - task_attachments: adjuntos. El archivo vive en document-service; aquí solo su id, nombre, tipo y tamaño.
 * - task_activity: el historial de la tarea (quién cambió qué y cuándo), solo de escritura.
 * - task_reminders: un aviso de «vence pronto» por tarea, día y tipo como máximo (la clave primaria lo garantiza aunque el proceso
 *   corra dos veces a la vez).
 */
const DOC = 'JSON';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('tasks', 'kind', {
      type: Sequelize.ENUM('task', 'milestone', 'approval'),
      allowNull: false,
      defaultValue: 'task',
    });
    await queryInterface.addColumn('tasks', 'approval_status', {
      type: Sequelize.ENUM('pending', 'approved', 'changes_requested', 'rejected'),
      allowNull: true,
    });
    await queryInterface.addColumn('tasks', 'description_doc', { type: DOC, allowNull: true });

    await queryInterface.createTable('task_comments', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      organization_id: { type: Sequelize.CHAR(36), allowNull: false },
      task_id: {
        type: Sequelize.CHAR(36),
        allowNull: false,
        references: { model: 'tasks', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      author_user_id: { type: Sequelize.CHAR(36), allowNull: false },
      body_doc: { type: DOC, allowNull: false },
      body_text: { type: Sequelize.TEXT, allowNull: false },
      mentioned_user_ids: { type: DOC, allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false },
      edited_at: { type: Sequelize.DATE, allowNull: true },
      deleted_at: { type: Sequelize.DATE, allowNull: true },
    });
    await queryInterface.addIndex('task_comments', ['task_id', 'created_at']);

    await queryInterface.createTable('task_followers', {
      task_id: {
        type: Sequelize.CHAR(36),
        primaryKey: true,
        references: { model: 'tasks', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      user_id: { type: Sequelize.CHAR(36), primaryKey: true },
      organization_id: { type: Sequelize.CHAR(36), allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('task_followers', ['organization_id', 'user_id']);

    await queryInterface.createTable('likes', {
      target_type: { type: Sequelize.ENUM('task', 'comment'), primaryKey: true },
      target_id: { type: Sequelize.CHAR(36), primaryKey: true },
      user_id: { type: Sequelize.CHAR(36), primaryKey: true },
      organization_id: { type: Sequelize.CHAR(36), allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.createTable('task_attachments', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      organization_id: { type: Sequelize.CHAR(36), allowNull: false },
      task_id: {
        type: Sequelize.CHAR(36),
        allowNull: false,
        references: { model: 'tasks', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      // Referencia lógica a document-service (sin FOREIGN KEY entre servicios).
      document_id: { type: Sequelize.CHAR(36), allowNull: false },
      file_name: { type: Sequelize.STRING(255), allowNull: false },
      mime_type: { type: Sequelize.STRING(150), allowNull: false },
      size_bytes: { type: Sequelize.BIGINT, allowNull: false },
      uploaded_by: { type: Sequelize.CHAR(36), allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false },
      deleted_at: { type: Sequelize.DATE, allowNull: true },
    });
    await queryInterface.addIndex('task_attachments', ['task_id', 'created_at']);

    await queryInterface.createTable('task_activity', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      organization_id: { type: Sequelize.CHAR(36), allowNull: false },
      task_id: {
        type: Sequelize.CHAR(36),
        allowNull: false,
        references: { model: 'tasks', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      actor_user_id: { type: Sequelize.CHAR(36), allowNull: true },
      kind: { type: Sequelize.STRING(40), allowNull: false },
      data: { type: DOC, allowNull: false },
      at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('task_activity', ['task_id', 'at']);

    await queryInterface.createTable('task_reminders', {
      task_id: {
        type: Sequelize.CHAR(36),
        primaryKey: true,
        references: { model: 'tasks', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      on_date: { type: Sequelize.DATEONLY, primaryKey: true },
      kind: { type: Sequelize.ENUM('today', 'tomorrow'), primaryKey: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('tasks', ['due_on', 'completed_at']);
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('tasks', ['due_on', 'completed_at']);
    await queryInterface.dropTable('task_reminders');
    await queryInterface.dropTable('task_activity');
    await queryInterface.dropTable('task_attachments');
    await queryInterface.dropTable('likes');
    await queryInterface.dropTable('task_followers');
    await queryInterface.dropTable('task_comments');
    await queryInterface.removeColumn('tasks', 'description_doc');
    await queryInterface.removeColumn('tasks', 'approval_status');
    await queryInterface.removeColumn('tasks', 'kind');
  },
};
