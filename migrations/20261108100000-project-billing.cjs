/**
 * Entregable 6 (facturar el proyecto con el SRI):
 *
 * - project_billing: a quién y cómo se factura el proyecto. El cliente y el producto de servicio son referencias lógicas a
 *   customer-service y product-service (sin FOREIGN KEY); `*_label` guarda lo que se veía al elegirlos. El producto decide el IVA de la
 *   línea en billing-service.
 * - milestone_amounts: importe fijo de un hito («Entrega del diseño: $1.500»). Se factura cuando el hito está completado.
 * - project_invoices: cada factura del proyecto. Nace como RESERVA (`pending`): las horas y los hitos quedan apartados con su
 *   `billing_id` ANTES de crear el borrador en billing-service, así dos personas no facturan lo mismo. Luego se enlaza a la factura de
 *   billing (`draft`), y sigue su vida por los eventos de billing (`issued`, `voided`); `released` = se liberó a mano antes de emitir.
 * - time_entries.billing_id: la reserva o factura que se llevó esas horas. Con él, el registro ya no se edita ni se borra.
 */
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('project_billing', {
      project_id: { type: Sequelize.CHAR(36), primaryKey: true, references: { model: 'projects', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },
      organization_id: { type: Sequelize.CHAR(36), allowNull: false },
      customer_id: { type: Sequelize.CHAR(36), allowNull: true },
      customer_label: { type: Sequelize.STRING(300), allowNull: true },
      hourly_rate_cents: { type: Sequelize.INTEGER.UNSIGNED, allowNull: true },
      service_product_id: { type: Sequelize.CHAR(36), allowNull: true },
      service_product_label: { type: Sequelize.STRING(255), allowNull: true },
      group_by: { type: Sequelize.ENUM('task', 'person', 'single'), allowNull: false, defaultValue: 'task' },
      updated_by: { type: Sequelize.CHAR(36), allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.createTable('project_invoices', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      organization_id: { type: Sequelize.CHAR(36), allowNull: false },
      project_id: { type: Sequelize.CHAR(36), allowNull: false, references: { model: 'projects', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'RESTRICT' },
      invoice_id: { type: Sequelize.CHAR(36), allowNull: true },
      status: { type: Sequelize.ENUM('pending', 'draft', 'issued', 'voided', 'released'), allowNull: false },
      number: { type: Sequelize.STRING(50), allowNull: true },
      minutes: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
      entry_count: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
      milestone_count: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
      amount_cents: { type: Sequelize.BIGINT.UNSIGNED, allowNull: false, defaultValue: 0 },
      // Qué se llevó la reserva. Si alguien libera un borrador y luego lo emite igual en Facturación (billing no deja borrar ni anular
      // borradores), al llegar billing.invoice.issued se vuelven a tomar esas horas; las que ya estén en otra factura cuentan en
      // `conflicts` y la pantalla pide revisarlas.
      entry_ids: { type: Sequelize.JSON, allowNull: false },
      milestone_task_ids: { type: Sequelize.JSON, allowNull: false },
      conflicts: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
      created_by: { type: Sequelize.CHAR(36), allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    // Una factura de billing se enlaza a UNA sola reserva; y el consumidor de eventos la busca por ese id.
    await queryInterface.addIndex('project_invoices', ['invoice_id'], { unique: true, name: 'project_invoices_invoice_unique' });
    await queryInterface.addIndex('project_invoices', ['organization_id', 'project_id']);

    await queryInterface.createTable('milestone_amounts', {
      task_id: { type: Sequelize.CHAR(36), primaryKey: true, references: { model: 'tasks', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'RESTRICT' },
      organization_id: { type: Sequelize.CHAR(36), allowNull: false },
      project_id: { type: Sequelize.CHAR(36), allowNull: false },
      amount_cents: { type: Sequelize.BIGINT.UNSIGNED, allowNull: false },
      billing_id: { type: Sequelize.CHAR(36), allowNull: true },
      updated_by: { type: Sequelize.CHAR(36), allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('milestone_amounts', ['organization_id', 'project_id']);

    await queryInterface.addColumn('time_entries', 'billing_id', { type: Sequelize.CHAR(36), allowNull: true, after: 'source' });
    await queryInterface.addIndex('time_entries', ['billing_id']);
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('time_entries', ['billing_id']);
    await queryInterface.removeColumn('time_entries', 'billing_id');
    await queryInterface.dropTable('milestone_amounts');
    await queryInterface.dropTable('project_invoices');
    await queryInterface.dropTable('project_billing');
  },
};
