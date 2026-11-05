/**
 * Entregable 4 (vínculos con el ERP, etiquetas y campos personalizados):
 *
 * - task_links: una tarea apunta a algo del ERP (cliente, factura, cotización, orden de compra, producto). El id es una referencia
 *   lógica a otro servicio (sin FOREIGN KEY); `label` guarda el texto que se veía al vincular («Café Central», «001-001-000123»)
 *   porque este servicio no puede preguntarle a los demás. La misma cosa no se vincula dos veces a la misma tarea (UNIQUE).
 * - tags / task_tags: etiquetas de la organización (como las de Asana), con color del tema. El nombre es único por organización.
 * - custom_fields / custom_field_values: campos personalizados POR PROYECTO (texto, número, lista de opciones, fecha, persona). Las
 *   opciones de una lista llevan id propio: renombrar una no cambia el valor de las tareas que la tienen.
 */
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('task_links', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      organization_id: { type: Sequelize.CHAR(36), allowNull: false },
      task_id: {
        type: Sequelize.CHAR(36),
        allowNull: false,
        references: { model: 'tasks', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      entity_type: { type: Sequelize.ENUM('customer', 'invoice', 'quote', 'purchase_order', 'product'), allowNull: false },
      entity_id: { type: Sequelize.CHAR(36), allowNull: false },
      label: { type: Sequelize.STRING(200), allowNull: false },
      created_by: { type: Sequelize.CHAR(36), allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('task_links', ['task_id', 'entity_type', 'entity_id'], { unique: true, name: 'task_links_unique' });
    // «Tareas de este cliente»: la ficha del cliente lo pregunta.
    await queryInterface.addIndex('task_links', ['organization_id', 'entity_type', 'entity_id']);

    await queryInterface.createTable('tags', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      organization_id: { type: Sequelize.CHAR(36), allowNull: false },
      name: { type: Sequelize.STRING(60), allowNull: false },
      color: { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'primary' },
      created_by: { type: Sequelize.CHAR(36), allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('tags', ['organization_id', 'name'], { unique: true, name: 'tags_org_name_unique' });

    await queryInterface.createTable('task_tags', {
      task_id: {
        type: Sequelize.CHAR(36),
        primaryKey: true,
        references: { model: 'tasks', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      tag_id: {
        type: Sequelize.CHAR(36),
        primaryKey: true,
        references: { model: 'tags', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      organization_id: { type: Sequelize.CHAR(36), allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('task_tags', ['tag_id']);

    await queryInterface.createTable('custom_fields', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      organization_id: { type: Sequelize.CHAR(36), allowNull: false },
      project_id: {
        type: Sequelize.CHAR(36),
        allowNull: false,
        references: { model: 'projects', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      name: { type: Sequelize.STRING(60), allowNull: false },
      type: { type: Sequelize.ENUM('text', 'number', 'select', 'date', 'person'), allowNull: false },
      options: { type: 'JSON', allowNull: false },
      rank: { type: 'VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin', allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('custom_fields', ['project_id', 'rank']);

    await queryInterface.createTable('custom_field_values', {
      task_id: {
        type: Sequelize.CHAR(36),
        primaryKey: true,
        references: { model: 'tasks', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      field_id: {
        type: Sequelize.CHAR(36),
        primaryKey: true,
        references: { model: 'custom_fields', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      organization_id: { type: Sequelize.CHAR(36), allowNull: false },
      value: { type: 'JSON', allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('custom_field_values', ['field_id']);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('custom_field_values');
    await queryInterface.dropTable('custom_fields');
    await queryInterface.dropTable('task_tags');
    await queryInterface.dropTable('tags');
    await queryInterface.dropTable('task_links');
  },
};
