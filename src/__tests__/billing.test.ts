import { describe, expect, it } from 'vitest';
import { buildGroups, hoursQuantity } from '../domain/billing.js';
import { AlreadyBilledError, BillingNotConfiguredError, ForbiddenError, NothingToBillError, ValidationError } from '../domain/errors.js';
import { ANA, BETO, actor, projectWithSections, setup } from './helpers.js';

const CUSTOMER = '99999999-0000-4000-8000-0000000000c1';
const PRODUCT = '99999999-0000-4000-8000-0000000000d1';
const INVOICE = '99999999-0000-4000-8000-0000000000e1';
const biller = (userId: string) => actor(userId, { permissions: ['project:read', 'project:create', 'project:bill'] });

async function configured() {
  const ctx = setup();
  const { useCases: uc } = ctx;
  const { project } = await projectWithSections(uc, actor(ANA));
  await uc.billing.saveSettings(biller(ANA), project.id, {
    customerId: CUSTOMER,
    customerLabel: 'Café Central',
    hourlyRateCents: 2500,
    serviceProductId: PRODUCT,
    serviceProductLabel: 'Servicios profesionales',
    groupBy: 'task',
  });
  const a = await uc.tasks.create(actor(ANA), { title: 'Diseño', projectId: project.id, assigneeUserId: ANA });
  const b = await uc.tasks.create(actor(ANA), { title: 'Desarrollo', projectId: project.id, assigneeUserId: ANA });
  await uc.time.log(actor(ANA), { taskId: a.id, workedOn: '2026-11-03', minutes: 90 });
  await uc.time.log(actor(ANA), { taskId: b.id, workedOn: '2026-11-04', minutes: 31 });
  await uc.time.log(actor(ANA), { taskId: b.id, workedOn: '2026-11-04', minutes: 60, billable: false });
  const m = await uc.tasks.create(actor(ANA), { title: 'Entrega del diseño', projectId: project.id, kind: 'milestone' });
  await uc.billing.setMilestoneAmount(biller(ANA), project.id, m.id, 150_000);
  await uc.tasks.complete(actor(ANA), m.id);
  return { ...ctx, project, a, b, m };
}

describe('facturar: funciones puras', () => {
  it('horas con dos decimales y una línea por tarea, persona o todo junto; los hitos van a precio fijo', () => {
    expect(hoursQuantity(91)).toBe(1.52);
    const entries = [
      { id: '1', taskId: 'a', userId: 'u1', minutes: 90 },
      { id: '2', taskId: 'b', userId: 'u1', minutes: 31 },
      { id: '3', taskId: 'a', userId: 'u2', minutes: 30 },
      { id: '4', taskId: 'c', userId: 'u2', minutes: 0 },
    ];
    const titles = new Map([['a', 'Diseño'], ['b', 'Desarrollo'], ['c', 'Nada']]);
    const byTask = buildGroups({ entries, titles, groupBy: 'task', hourlyRateCents: 2500, milestones: [{ taskId: 'm', title: 'Hito', amountCents: 1000 }] });
    expect(byTask.map((g) => [g.label, g.quantity, g.amountCents])).toEqual([
      ['Diseño', 2, 5000],
      ['Desarrollo', 0.52, 1300],
      ['Hito', 1, 1000],
    ]);
    expect(buildGroups({ entries, titles, groupBy: 'person', hourlyRateCents: 2500, milestones: [] }).map((g) => [g.key, g.quantity])).toEqual([
      ['u1', 2.02],
      ['u2', 0.5],
    ]);
    expect(buildGroups({ entries, titles, groupBy: 'single', hourlyRateCents: 2500, milestones: [] })).toHaveLength(1);
  });
});

describe('facturar el proyecto', () => {
  it('sin project:bill no se ve ni se configura', async () => {
    const { useCases: uc } = setup();
    const { project } = await projectWithSections(uc, actor(ANA));
    await expect(uc.billing.summary(actor(ANA), project.id)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('sin cliente o sin servicio no se reserva nada', async () => {
    const { useCases: uc } = setup();
    const { project } = await projectWithSections(uc, actor(ANA));
    await expect(uc.billing.reserve(biller(ANA), project.id, { includeHours: true, milestoneTaskIds: [] })).rejects.toBeInstanceOf(BillingNotConfiguredError);
  });

  it('reservar aparta las horas facturables y los hitos completados; lo reservado ya no se cambia ni se vuelve a facturar', async () => {
    const { useCases: uc, project, m, store } = await configured();
    const summary = await uc.billing.summary(biller(ANA), project.id);
    expect(summary).toMatchObject({ unbilledMinutes: 121, unbilledEntries: 2 });
    expect(summary.milestones).toEqual([expect.objectContaining({ title: 'Entrega del diseño', amountCents: 150_000, billingId: null })]);

    const { invoice, preview } = await uc.billing.reserve(biller(ANA), project.id, { includeHours: true, milestoneTaskIds: [m.id] });
    expect(preview.groups.map((g) => [g.kind, g.label, g.quantity, g.amountCents])).toEqual([
      ['hours', 'Diseño', 1.5, 3750],
      ['hours', 'Desarrollo', 0.52, 1300],
      ['milestone', 'Entrega del diseño', 1, 150_000],
    ]);
    expect(invoice).toMatchObject({ status: 'pending', minutes: 121, entryCount: 2, milestoneCount: 1, amountCents: 155_050 });
    expect(store.events('projects.invoice.reserved')).toHaveLength(1);

    await expect(uc.billing.reserve(biller(ANA), project.id, { includeHours: true, milestoneTaskIds: [m.id] })).rejects.toBeInstanceOf(NothingToBillError);
    const billed = (await uc.time.report(actor(ANA), { projectId: project.id })).items.find((r) => r.entry.minutes === 90)!.entry;
    await expect(uc.time.update(actor(ANA), billed.id, { minutes: 10 })).rejects.toBeInstanceOf(AlreadyBilledError);
    await expect(uc.time.remove(actor(ANA), billed.id)).rejects.toBeInstanceOf(AlreadyBilledError);
    await expect(uc.billing.setMilestoneAmount(biller(ANA), project.id, m.id, 1)).rejects.toBeInstanceOf(AlreadyBilledError);
    expect((await uc.billing.summary(biller(ANA), project.id)).unbilledMinutes).toBe(0);
  });

  it('enlazar, emitir y anular: al anularse en billing, las horas y el hito vuelven a quedar por facturar', async () => {
    const { useCases: uc, project, m, store } = await configured();
    const { invoice } = await uc.billing.reserve(biller(ANA), project.id, { includeHours: true, milestoneTaskIds: [m.id] });
    const linked = await uc.billing.attach(biller(ANA), invoice.id, INVOICE);
    expect(linked.status).toBe('draft');
    expect((await uc.billing.attach(biller(ANA), invoice.id, INVOICE)).status).toBe('draft'); // repetir no hace nada

    await uc.billing.onInvoiceIssued({ organizationId: invoice.organizationId, invoiceId: INVOICE, number: '001-001-000000123' });
    await uc.billing.onInvoiceIssued({ organizationId: invoice.organizationId, invoiceId: INVOICE, number: '001-001-000000123' });
    expect((await uc.billing.summary(biller(ANA), project.id)).invoices[0]).toMatchObject({ status: 'issued', number: '001-001-000000123' });
    expect(store.events('projects.invoice.issued')).toHaveLength(1);
    await expect(uc.billing.release(biller(ANA), invoice.id)).rejects.toBeInstanceOf(AlreadyBilledError);

    await uc.billing.onInvoiceVoided({ organizationId: invoice.organizationId, invoiceId: INVOICE });
    const after = await uc.billing.summary(biller(ANA), project.id);
    expect(after.unbilledMinutes).toBe(121);
    expect(after.milestones[0]!.billingId).toBeNull();
    expect(after.invoices[0]!.status).toBe('voided');
    expect(store.events('projects.invoice.released').at(-1)!.payload).toMatchObject({ reason: 'voided' });
    // Una factura de billing que no es de ningún proyecto: no pasa nada.
    await uc.billing.onInvoiceVoided({ organizationId: invoice.organizationId, invoiceId: '99999999-0000-4000-8000-0000000000ff' });
  });

  it('liberar a mano antes de emitir; un hito sin completar o fuera del rango de fechas no entra', async () => {
    const { useCases: uc, project, m } = await configured();
    const open = await uc.tasks.create(actor(ANA), { title: 'Hito abierto', projectId: project.id, kind: 'milestone' });
    await uc.billing.setMilestoneAmount(biller(ANA), project.id, open.id, 500);
    const { invoice, preview } = await uc.billing.reserve(biller(ANA), project.id, { includeHours: true, from: '2026-11-04', to: '2026-11-04', milestoneTaskIds: [open.id], groupBy: 'single' });
    expect(preview).toMatchObject({ minutes: 31, milestoneCount: 0, entryCount: 1 });
    expect(preview.groups).toHaveLength(1);
    await uc.billing.release(biller(ANA), invoice.id);
    expect((await uc.billing.summary(biller(ANA), project.id)).unbilledMinutes).toBe(121);
    // El importe del hito ya completado se puede cambiar mientras no esté en una factura.
    expect((await uc.billing.setMilestoneAmount(biller(ANA), project.id, m.id, 200_000))!.amountCents).toBe(200_000);
  });

  it('solo los hitos del proyecto llevan importe; quien no ve el proyecto no lo factura', async () => {
    const { useCases: uc, project, a } = await configured();
    await expect(uc.billing.setMilestoneAmount(biller(ANA), project.id, a.id, 100)).rejects.toBeInstanceOf(ValidationError);
    const { project: secret } = await projectWithSections(uc, actor(ANA), 'members');
    await expect(uc.billing.summary(biller(BETO), secret.id)).rejects.toThrow('Proyecto no encontrado');
  });

  it('si un borrador liberado se emite igual en Facturación, recupera sus horas; las que ya estaban en otra factura quedan como conflicto', async () => {
    const { useCases: uc, project, m, store } = await configured();
    const first = await uc.billing.reserve(biller(ANA), project.id, { includeHours: true, milestoneTaskIds: [m.id] });
    await uc.billing.attach(biller(ANA), first.invoice.id, INVOICE);
    await uc.billing.release(biller(ANA), first.invoice.id);
    // Mientras tanto, el hito entra en otra factura.
    const second = await uc.billing.reserve(biller(ANA), project.id, { includeHours: false, milestoneTaskIds: [m.id] });

    await uc.billing.onInvoiceIssued({ organizationId: first.invoice.organizationId, invoiceId: INVOICE, number: '001-001-000000124' });
    const summary = await uc.billing.summary(biller(ANA), project.id);
    expect(summary.unbilledMinutes).toBe(0);
    expect(summary.invoices.find((i) => i.id === first.invoice.id)).toMatchObject({ status: 'issued', conflicts: 1 });
    expect(summary.milestones[0]!.billingId).toBe(second.invoice.id);
    expect(store.events('projects.invoice.issued').at(-1)!.payload).toMatchObject({ conflicts: 1 });
  });
});

