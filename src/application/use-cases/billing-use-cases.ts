import { buildGroups, type BillingGroup, type GroupBy } from '../../domain/billing.js';
import {
  AlreadyBilledError,
  BillingNotConfiguredError,
  ForbiddenError,
  NothingToBillError,
  ProjectInvoiceNotFoundError,
  ValidationError,
} from '../../domain/errors.js';
import type { Repositories } from '../../domain/repositories.js';
import type { Actor, MilestoneAmount, Project, ProjectBilling, ProjectInvoice, Task, TimeEntry } from '../../domain/types.js';
import { loadProject, loadTask } from '../access-context.js';
import {
  billingSettingsUpdatedEvent,
  invoiceIssuedEvent,
  invoiceLinkedEvent,
  invoiceReleasedEvent,
  invoiceReservedEvent,
  milestoneAmountSetEvent,
} from '../events.js';
import { type Clock, type IdGenerator, inTransaction, type UnitOfWorkGateway, type WriteUnitOfWork } from '../ports.js';

/** Facturar un proyecto: Administrador y Contador. Ver la pestaña Facturación también lo exige (muestra tarifas e importes). */
export const PERMISSION_BILL = 'project:bill';

/** $100 000 por hora o por hito: más que eso es un error de tecleo (y no cabe sin perder precisión en la línea de billing). */
const MAX_AMOUNT_CENTS = 10_000_000;

export interface BillingSettingsInput {
  customerId: string | null;
  customerLabel: string | null;
  hourlyRateCents: number | null;
  serviceProductId: string | null;
  serviceProductLabel: string | null;
  groupBy: GroupBy;
}

export interface BillingCriteria {
  /** Rango de días trabajados (inclusive). Sin él, todas las horas sin facturar. */
  from?: string;
  to?: string;
  includeHours: boolean;
  milestoneTaskIds: string[];
  groupBy?: GroupBy;
}

export interface MilestoneRow {
  taskId: string;
  title: string;
  dueOn: string | null;
  completedAt: Date | null;
  amountCents: number | null;
  billingId: string | null;
}

export interface BillingSummary {
  project: Project;
  settings: ProjectBilling;
  unbilledMinutes: number;
  unbilledEntries: number;
  /** Lo que costarían todas las horas sin facturar con la tarifa actual (sin IVA). */
  unbilledAmountCents: number;
  milestones: MilestoneRow[];
  invoices: ProjectInvoice[];
}

export interface BillingPreview {
  groups: BillingGroup[];
  entryCount: number;
  milestoneCount: number;
  minutes: number;
  amountCents: number;
}

function requireBill(actor: Actor): void {
  if (!actor.permissions.includes(PERMISSION_BILL)) throw new ForbiddenError('Facturar proyectos es del Administrador o el Contador.');
}

function emptySettings(project: Project, actor: Actor): ProjectBilling {
  return {
    organizationId: project.organizationId,
    projectId: project.id,
    customerId: null,
    customerLabel: null,
    hourlyRateCents: null,
    serviceProductId: null,
    serviceProductLabel: null,
    groupBy: 'task',
    updatedBy: actor.userId,
    updatedAt: project.updatedAt,
  };
}

/**
 * Facturar el proyecto (entregable 6): lo que Asana no tiene. Las horas facturables y los hitos completados con importe se convierten
 * en un borrador de factura electrónica en billing-service, que se emite al SRI desde Facturación.
 *
 * El orden importa para no facturar dos veces:
 *  1. `reserve`: aparta las horas y los hitos con `FOR UPDATE` (dos personas a la vez: la segunda ya no los ve libres) y crea la
 *     factura del proyecto en estado `pending`.
 *  2. el navegador crea el borrador en billing-service con las líneas que devolvió la reserva;
 *  3. `attach`: enlaza ese borrador (`draft`). Si el paso 2 falla, `release` devuelve todo a «por facturar».
 *  4. los eventos de billing la siguen: emitida (`issued`) o anulada (`voided`, y las horas vuelven a quedar por facturar).
 */
export class BillingUseCases {
  constructor(
    private readonly gateway: UnitOfWorkGateway,
    private readonly repos: Repositories,
    private readonly clock: Clock,
    private readonly newId: IdGenerator,
  ) {}

  async summary(actor: Actor, projectId: string): Promise<BillingSummary> {
    requireBill(actor);
    const { project } = await loadProject(this.repos, actor, projectId);
    const org = actor.organizationId;
    const settings = (await this.repos.billing.getSettings(org, project.id)) ?? emptySettings(project, actor);
    const [entries, milestones, invoices] = await Promise.all([
      this.repos.timeEntries.listUnbilled(org, project.id, {}),
      this.milestoneRows(project),
      this.repos.billing.invoices(org, project.id),
    ]);
    const groups = buildGroups({ entries, titles: new Map(), groupBy: 'single', hourlyRateCents: settings.hourlyRateCents ?? 0, milestones: [] });
    return {
      project,
      settings,
      unbilledMinutes: entries.reduce((n, e) => n + e.minutes, 0),
      unbilledEntries: entries.length,
      unbilledAmountCents: groups.reduce((n, g) => n + g.amountCents, 0),
      milestones,
      invoices,
    };
  }

  async saveSettings(actor: Actor, projectId: string, input: BillingSettingsInput): Promise<ProjectBilling> {
    requireBill(actor);
    if (input.hourlyRateCents !== null && (!Number.isInteger(input.hourlyRateCents) || input.hourlyRateCents < 0 || input.hourlyRateCents > MAX_AMOUNT_CENTS)) {
      throw new ValidationError([{ field: 'hourlyRateCents', message: 'Tarifa por hora entre 0 y 100 000.' }]);
    }
    return inTransaction(this.gateway, async (uow) => {
      const { project } = await loadProject(uow, actor, projectId);
      const settings: ProjectBilling = {
        organizationId: actor.organizationId,
        projectId: project.id,
        customerId: input.customerId,
        customerLabel: input.customerId ? input.customerLabel?.trim() || null : null,
        hourlyRateCents: input.hourlyRateCents,
        serviceProductId: input.serviceProductId,
        serviceProductLabel: input.serviceProductId ? input.serviceProductLabel?.trim() || null : null,
        groupBy: input.groupBy,
        updatedBy: actor.userId,
        updatedAt: this.clock(),
      };
      await uow.billing.saveSettings(settings);
      await uow.outbox.add(billingSettingsUpdatedEvent(settings));
      return settings;
    });
  }

  /** Importe fijo de un hito del proyecto (null lo quita). No se cambia si ya está en una factura. */
  async setMilestoneAmount(actor: Actor, projectId: string, taskId: string, amountCents: number | null): Promise<MilestoneAmount | null> {
    requireBill(actor);
    if (amountCents !== null && (!Number.isInteger(amountCents) || amountCents <= 0 || amountCents > MAX_AMOUNT_CENTS)) {
      throw new ValidationError([{ field: 'amountCents', message: 'Importe mayor que 0 y hasta 100 000.' }]);
    }
    return inTransaction(this.gateway, async (uow) => {
      const ctx = await loadTask(uow, actor, taskId);
      if (ctx.task.kind !== 'milestone' || !ctx.placements.some((p) => p.projectId === projectId)) {
        throw new ValidationError([{ field: 'taskId', message: 'Solo los hitos de este proyecto tienen importe.' }]);
      }
      const current = await uow.billing.findMilestone(actor.organizationId, ctx.task.id);
      if (current?.billingId) throw new AlreadyBilledError();
      let saved: MilestoneAmount | null = null;
      if (amountCents === null) {
        if (current) await uow.billing.deleteMilestone(actor.organizationId, ctx.task.id);
      } else {
        saved = { organizationId: actor.organizationId, projectId, taskId: ctx.task.id, amountCents, billingId: null, updatedBy: actor.userId, updatedAt: this.clock() };
        await uow.billing.saveMilestone(saved);
      }
      await uow.outbox.add(milestoneAmountSetEvent(actor.organizationId, projectId, ctx.task, amountCents));
      return saved;
    });
  }

  /** Lo que se facturaría con esos criterios, sin apartar nada (la vista previa). */
  async preview(actor: Actor, projectId: string, criteria: BillingCriteria): Promise<BillingPreview> {
    requireBill(actor);
    const { project } = await loadProject(this.repos, actor, projectId);
    const settings = (await this.repos.billing.getSettings(actor.organizationId, project.id)) ?? emptySettings(project, actor);
    const entries = criteria.includeHours ? await this.repos.timeEntries.listUnbilled(actor.organizationId, project.id, criteria) : [];
    const milestones = await this.billableMilestones(this.repos, actor, project.id, criteria.milestoneTaskIds, false);
    return this.compose(this.repos, actor, settings, criteria, entries, milestones);
  }

  /** Aparta las horas y los hitos y abre la factura del proyecto (`pending`). Devuelve las líneas para el borrador de billing. */
  async reserve(actor: Actor, projectId: string, criteria: BillingCriteria): Promise<{ invoice: ProjectInvoice; preview: BillingPreview; settings: ProjectBilling }> {
    requireBill(actor);
    return inTransaction(this.gateway, async (uow) => {
      const { project } = await loadProject(uow, actor, projectId);
      const settings = await uow.billing.getSettings(actor.organizationId, project.id);
      if (!settings?.customerId) throw new BillingNotConfiguredError('Elige el cliente al que se factura el proyecto.');
      if (!settings.serviceProductId) throw new BillingNotConfiguredError('Elige el servicio con el que se facturan las horas (decide el IVA).');
      if (criteria.includeHours && !settings.hourlyRateCents) throw new BillingNotConfiguredError('Pon la tarifa por hora del proyecto.');

      const candidates = criteria.includeHours ? await uow.timeEntries.listUnbilled(actor.organizationId, project.id, criteria) : [];
      // Lectura con bloqueo: si otra persona las reservó mientras tanto, aquí ya se ven con su `billingId` y se descartan.
      const entries = (await uow.timeEntries.findManyForUpdate(actor.organizationId, candidates.map((e) => e.id))).filter(
        (e) => e.billingId === null && e.billable && e.projectId === project.id,
      );
      const milestones = await this.billableMilestones(uow, actor, project.id, criteria.milestoneTaskIds, true);
      if (entries.length === 0 && milestones.length === 0) throw new NothingToBillError();

      const preview = await this.compose(uow, actor, settings, criteria, entries, milestones);
      const now = this.clock();
      const invoice: ProjectInvoice = {
        id: this.newId(),
        organizationId: actor.organizationId,
        projectId: project.id,
        invoiceId: null,
        status: 'pending',
        number: null,
        minutes: preview.minutes,
        entryCount: preview.entryCount,
        milestoneCount: preview.milestoneCount,
        amountCents: preview.amountCents,
        entryIds: entries.map((e) => e.id),
        milestoneTaskIds: milestones.map((m) => m.taskId),
        conflicts: 0,
        createdBy: actor.userId,
        createdAt: now,
        updatedAt: now,
      };
      await uow.billing.saveInvoice(invoice);
      await uow.timeEntries.assignBilling(actor.organizationId, entries.map((e) => e.id), invoice.id);
      await uow.billing.assignMilestones(actor.organizationId, milestones.map((m) => m.taskId), invoice.id);
      await uow.outbox.add(invoiceReservedEvent(invoice));
      return { invoice, preview, settings };
    });
  }

  /** Enlaza el borrador que se creó en billing-service. Repetirlo con el mismo id no hace nada. */
  async attach(actor: Actor, billingId: string, invoiceId: string): Promise<ProjectInvoice> {
    requireBill(actor);
    return inTransaction(this.gateway, async (uow) => {
      const invoice = await this.loadVisibleInvoice(uow, actor, billingId);
      if (invoice.invoiceId === invoiceId && invoice.status !== 'pending') return invoice;
      if (invoice.status !== 'pending') throw new AlreadyBilledError('Esta factura del proyecto ya está enlazada a otra factura.');
      const next: ProjectInvoice = { ...invoice, invoiceId, status: 'draft', updatedAt: this.clock() };
      await uow.billing.saveInvoice(next);
      await uow.outbox.add(invoiceLinkedEvent(next));
      return next;
    });
  }

  /** Devuelve las horas y los hitos a «por facturar». Solo antes de emitir: una factura emitida se anula en Facturación. */
  async release(actor: Actor, billingId: string): Promise<ProjectInvoice> {
    requireBill(actor);
    return inTransaction(this.gateway, async (uow) => {
      const invoice = await this.loadVisibleInvoice(uow, actor, billingId);
      if (invoice.status === 'released' || invoice.status === 'voided') return invoice;
      if (invoice.status === 'issued') throw new AlreadyBilledError('La factura ya se emitió al SRI: anúlala en Facturación y sus horas volverán a quedar por facturar.');
      return this.doRelease(uow, invoice, 'released', 'manual');
    });
  }

  // ── Eventos de billing-service ────────────────────────────────────────────

  /** `billing.invoice.issued`: si es una factura de un proyecto, queda emitida con su número. Idempotente. */
  async onInvoiceIssued(payload: { organizationId?: unknown; invoiceId?: unknown; number?: unknown }): Promise<void> {
    if (typeof payload.organizationId !== 'string' || typeof payload.invoiceId !== 'string') return;
    const { organizationId, invoiceId } = payload as { organizationId: string; invoiceId: string };
    await inTransaction(this.gateway, async (uow) => {
      const invoice = await uow.billing.findByInvoiceId(organizationId, invoiceId, { forUpdate: true });
      if (!invoice || invoice.status === 'issued') return;
      let conflicts = 0;
      if (invoice.status === 'released' || invoice.status === 'voided') {
        // Se liberó el borrador y aun así se emitió en Facturación (billing no deja borrarlo ni anularlo): lo emitido manda, así que
        // se vuelven a tomar sus horas e hitos. Lo que mientras tanto entró en OTRA factura no se toca: queda en `conflicts`.
        const entries = await uow.timeEntries.findManyForUpdate(organizationId, invoice.entryIds);
        const freeEntries = entries.filter((e) => e.billingId === null).map((e) => e.id);
        const milestones = await uow.billing.findMilestonesForUpdate(organizationId, invoice.milestoneTaskIds);
        const freeMilestones = milestones.filter((m) => m.billingId === null).map((m) => m.taskId);
        await uow.timeEntries.assignBilling(organizationId, freeEntries, invoice.id);
        await uow.billing.assignMilestones(organizationId, freeMilestones, invoice.id);
        conflicts = invoice.entryIds.length - freeEntries.length + (invoice.milestoneTaskIds.length - freeMilestones.length);
      }
      const next: ProjectInvoice = { ...invoice, status: 'issued', conflicts, number: typeof payload.number === 'string' ? payload.number : null, updatedAt: this.clock() };
      await uow.billing.saveInvoice(next);
      await uow.outbox.add(invoiceIssuedEvent(next));
    });
  }

  /** `billing.invoice.voided`: la factura se anuló, así que sus horas y sus hitos vuelven a quedar por facturar. Idempotente. */
  async onInvoiceVoided(payload: { organizationId?: unknown; invoiceId?: unknown }): Promise<void> {
    if (typeof payload.organizationId !== 'string' || typeof payload.invoiceId !== 'string') return;
    const { organizationId, invoiceId } = payload as { organizationId: string; invoiceId: string };
    await inTransaction(this.gateway, async (uow) => {
      const invoice = await uow.billing.findByInvoiceId(organizationId, invoiceId, { forUpdate: true });
      if (!invoice || invoice.status === 'voided' || invoice.status === 'released') return;
      await this.doRelease(uow, invoice, 'voided', 'voided');
    });
  }

  // ── Internos ──────────────────────────────────────────────────────────────

  private async doRelease(uow: WriteUnitOfWork, invoice: ProjectInvoice, status: 'released' | 'voided', reason: 'manual' | 'voided'): Promise<ProjectInvoice> {
    await uow.timeEntries.releaseBilling(invoice.organizationId, invoice.id);
    await uow.billing.releaseMilestones(invoice.organizationId, invoice.id);
    const next: ProjectInvoice = { ...invoice, status, updatedAt: this.clock() };
    await uow.billing.saveInvoice(next);
    await uow.outbox.add(invoiceReleasedEvent(next, reason));
    return next;
  }

  /** La factura del proyecto, con bloqueo, si quien pregunta puede ver ese proyecto. Si no: 404. */
  private async loadVisibleInvoice(uow: WriteUnitOfWork, actor: Actor, billingId: string): Promise<ProjectInvoice> {
    const invoice = await uow.billing.findInvoice(actor.organizationId, billingId, { forUpdate: true });
    if (!invoice) throw new ProjectInvoiceNotFoundError();
    try {
      await loadProject(uow, actor, invoice.projectId);
    } catch {
      throw new ProjectInvoiceNotFoundError();
    }
    return invoice;
  }

  private async milestoneTasks(repos: Repositories, project: Project): Promise<Task[]> {
    const placements = await repos.placements.listByProject(project.organizationId, project.id);
    const tasks = await repos.tasks.findManyByIds(project.organizationId, placements.map((p) => p.taskId));
    return tasks.filter((t) => t.kind === 'milestone' && !t.deletedAt && !t.parentTaskId);
  }

  private async milestoneRows(project: Project): Promise<MilestoneRow[]> {
    const [tasks, amounts] = await Promise.all([this.milestoneTasks(this.repos, project), this.repos.billing.milestones(project.organizationId, project.id)]);
    const byTask = new Map(amounts.map((a) => [a.taskId, a]));
    return tasks
      .map((t) => ({
        taskId: t.id,
        title: t.title,
        dueOn: t.dueOn,
        completedAt: t.completedAt,
        amountCents: byTask.get(t.id)?.amountCents ?? null,
        billingId: byTask.get(t.id)?.billingId ?? null,
      }))
      .sort((a, b) => (a.dueOn ?? '9999').localeCompare(b.dueOn ?? '9999'));
  }

  /** Los hitos pedidos que se pueden facturar: de este proyecto, completados, con importe y sin factura. */
  private async billableMilestones(repos: Repositories, actor: Actor, projectId: string, taskIds: string[], lock: boolean): Promise<Array<MilestoneAmount & { title: string }>> {
    if (taskIds.length === 0) return [];
    const amounts = lock
      ? await repos.billing.findMilestonesForUpdate(actor.organizationId, taskIds)
      : (await repos.billing.milestones(actor.organizationId, projectId)).filter((m) => taskIds.includes(m.taskId));
    const tasks = new Map((await repos.tasks.findManyByIds(actor.organizationId, amounts.map((a) => a.taskId))).map((t) => [t.id, t]));
    return amounts
      .filter((m) => m.projectId === projectId && m.billingId === null && m.amountCents > 0)
      .filter((m) => {
        const t = tasks.get(m.taskId);
        return !!t && !t.deletedAt && t.completedAt !== null;
      })
      .map((m) => ({ ...m, title: tasks.get(m.taskId)!.title }));
  }

  private async compose(
    repos: Repositories,
    actor: Actor,
    settings: ProjectBilling,
    criteria: BillingCriteria,
    entries: TimeEntry[],
    milestones: Array<MilestoneAmount & { title: string }>,
  ): Promise<BillingPreview> {
    const titles = new Map((await repos.tasks.findManyByIds(actor.organizationId, [...new Set(entries.map((e) => e.taskId))])).map((t) => [t.id, t.title]));
    const groups = buildGroups({
      entries,
      titles,
      groupBy: criteria.groupBy ?? settings.groupBy,
      hourlyRateCents: settings.hourlyRateCents ?? 0,
      milestones: milestones.map((m) => ({ taskId: m.taskId, title: m.title, amountCents: m.amountCents })),
    });
    return {
      groups,
      entryCount: entries.length,
      milestoneCount: milestones.length,
      minutes: entries.reduce((n, e) => n + e.minutes, 0),
      amountCents: groups.reduce((n, g) => n + g.amountCents, 0),
    };
  }
}
