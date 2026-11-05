import { AlreadyBilledError, ForbiddenError, TimeEntryNotFoundError, TimerNotRunningError, ValidationError } from '../../domain/errors.js';
import { isOrgProjectAdmin } from '../../domain/access.js';
import type { Repositories, TimeEntryFilter } from '../../domain/repositories.js';
import type { Actor, RunningTimer, Task, TimeEntry } from '../../domain/types.js';
import { elapsedMinutes } from '../../domain/workload.js';
import { assertTaskWritable, loadTask, projectIdsOf, type TaskContext } from '../access-context.js';
import { recordActivity } from '../activity.js';
import { timeEntryDeletedEvent, timeEntryLoggedEvent, timeEntryUpdatedEvent } from '../events.js';
import { type Clock, type IdGenerator, inTransaction, type UnitOfWorkGateway, type WriteUnitOfWork } from '../ports.js';

/** Ver (y filtrar por) las horas de otras personas: Administrador y Contador. Sin él, cada quien ve solo las suyas. */
export const PERMISSION_TIME_READ_ALL = 'time_entry:read_all';

/** Un registro cubre un día: más de 24 h en una sola fila es un error de tecleo (o un cronómetro olvidado). */
export const MAX_ENTRY_MINUTES = 24 * 60;
export const MAX_REPORT_ROWS = 5000;

export interface LogTimeInput {
  taskId: string;
  workedOn: string;
  minutes: number;
  billable?: boolean;
  note?: string | null;
  projectId?: string | null;
}

export interface UpdateTimeInput {
  workedOn?: string;
  minutes?: number;
  billable?: boolean;
  note?: string | null;
  projectId?: string | null;
}

export interface TimeReportRow {
  entry: TimeEntry;
  taskTitle: string;
  taskDeleted: boolean;
  projectName: string | null;
  canEdit: boolean;
}

export interface TimeReport {
  items: TimeReportRow[];
  totalMinutes: number;
  billableMinutes: number;
  /** Se cortó en `MAX_REPORT_ROWS`: el total no incluye lo que quedó fuera. */
  truncated: boolean;
  canReadAll: boolean;
}

export interface TimerView {
  timer: RunningTimer;
  taskTitle: string;
}

function canReadAll(actor: Actor): boolean {
  return actor.permissions.includes(PERMISSION_TIME_READ_ALL);
}

function checkMinutes(minutes: number): void {
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_ENTRY_MINUTES) {
    throw new ValidationError([{ field: 'minutes', message: 'Entre 1 minuto y 24 horas por registro.' }]);
  }
}

function cleanNote(note: string | null | undefined): string | null {
  const n = note?.trim() ?? '';
  if (n.length > 500) throw new ValidationError([{ field: 'note', message: 'Máximo 500 caracteres.' }]);
  return n || null;
}

/**
 * El proyecto al que se cargan las horas. Una tarea puede estar en varios proyectos (multi-hogar): se usa el pedido, si es uno de
 * los suyos, o el primero. Una tarea personal no tiene proyecto (null): sus horas no se facturan a nadie.
 */
function projectFor(ctx: Pick<TaskContext, 'placements'>, requested: string | null | undefined): string | null {
  const ids = ctx.placements.map((p) => p.projectId);
  if (requested) {
    if (!ids.includes(requested)) throw new ValidationError([{ field: 'projectId', message: 'La tarea no está en ese proyecto.' }]);
    return requested;
  }
  return ids[0] ?? null;
}

/**
 * Horas (entregable 5), como el registro de tiempo de Asana: a mano o con el cronómetro, facturables o no.
 *
 * Quién puede:
 * - registrar horas en una tarea: su responsable o un editor del proyecto (lo mismo que completarla);
 * - cambiar o borrar un registro: quien lo hizo, o un administrador de proyectos (`project:admin`);
 * - ver horas: las de una tarea, quien ve la tarea; el reporte, las propias, y las de todos con `time_entry:read_all`.
 */
export class TimeUseCases {
  constructor(
    private readonly gateway: UnitOfWorkGateway,
    private readonly repos: Repositories,
    private readonly clock: Clock,
    private readonly newId: IdGenerator,
  ) {}

  async log(actor: Actor, input: LogTimeInput): Promise<TimeEntry> {
    checkMinutes(input.minutes);
    const note = cleanNote(input.note);
    return inTransaction(this.gateway, async (uow) => {
      const ctx = await loadTask(uow, actor, input.taskId);
      assertTaskWritable(ctx, 'complete');
      const now = this.clock();
      const entry: TimeEntry = {
        id: this.newId(),
        organizationId: actor.organizationId,
        taskId: ctx.task.id,
        projectId: projectFor(ctx, input.projectId),
        userId: actor.userId,
        workedOn: input.workedOn,
        minutes: input.minutes,
        billable: input.billable ?? true,
        note,
        source: 'manual',
        billingId: null,
        createdAt: now,
        updatedAt: now,
      };
      await this.saveNew(uow, actor, ctx.task, entry, projectIdsOf(ctx));
      return entry;
    });
  }

  async update(actor: Actor, entryId: string, input: UpdateTimeInput): Promise<TimeEntry> {
    if (input.minutes !== undefined) checkMinutes(input.minutes);
    return inTransaction(this.gateway, async (uow) => {
      const { entry, task, projectIds } = await this.loadOwned(uow, actor, entryId);
      const next: TimeEntry = { ...entry };
      const changes: string[] = [];
      const set = <K extends 'workedOn' | 'minutes' | 'billable' | 'note' | 'projectId'>(key: K, value: TimeEntry[K] | undefined) => {
        if (value === undefined || value === entry[key]) return;
        next[key] = value;
        changes.push(key);
      };
      set('workedOn', input.workedOn);
      set('minutes', input.minutes);
      set('billable', input.billable);
      if (input.note !== undefined) set('note', cleanNote(input.note));
      if (input.projectId !== undefined) {
        const placements = await uow.placements.listByTasks(actor.organizationId, [task.parentTaskId ?? task.id]);
        set('projectId', input.projectId === null ? null : projectFor({ placements }, input.projectId));
      }
      if (changes.length === 0) return entry;
      next.updatedAt = this.clock();
      await uow.timeEntries.save(next);
      await uow.outbox.add(timeEntryUpdatedEvent(next, task.title, projectIds, changes));
      return next;
    });
  }

  async remove(actor: Actor, entryId: string): Promise<void> {
    await inTransaction(this.gateway, async (uow) => {
      const { entry, task, projectIds } = await this.loadOwned(uow, actor, entryId);
      await uow.timeEntries.delete(actor.organizationId, entry.id);
      await uow.outbox.add(timeEntryDeletedEvent(entry, task.title, projectIds));
    });
  }

  /** Reporte de horas: por persona, proyecto, tarea, rango y facturable. Sin `time_entry:read_all`, siempre las propias. */
  async report(actor: Actor, filter: TimeEntryFilter): Promise<TimeReport> {
    const all = canReadAll(actor);
    if (!all && filter.userId && filter.userId !== actor.userId) throw new ForbiddenError('Solo puedes ver tus propias horas.');
    const effective: TimeEntryFilter = { ...filter, userId: all ? filter.userId : actor.userId };
    const org = actor.organizationId;
    const rows = await this.repos.timeEntries.list(org, effective, MAX_REPORT_ROWS + 1);
    const truncated = rows.length > MAX_REPORT_ROWS;
    const entries = rows.slice(0, MAX_REPORT_ROWS);
    const tasks = new Map((await this.repos.tasks.findManyByIds(org, [...new Set(entries.map((e) => e.taskId))])).map((t) => [t.id, t]));
    const projectIds = [...new Set(entries.map((e) => e.projectId).filter((id): id is string => !!id))];
    const projects = new Map((await Promise.all(projectIds.map((id) => this.repos.projects.findById(org, id)))).filter((p) => !!p).map((p) => [p!.id, p!]));
    const admin = isOrgProjectAdmin(actor);
    return {
      items: entries.map((entry) => ({
        entry,
        taskTitle: tasks.get(entry.taskId)?.title ?? '',
        taskDeleted: !!tasks.get(entry.taskId)?.deletedAt,
        projectName: entry.projectId ? (projects.get(entry.projectId)?.name ?? null) : null,
        canEdit: entry.userId === actor.userId || admin,
      })),
      totalMinutes: entries.reduce((n, e) => n + e.minutes, 0),
      billableMinutes: entries.filter((e) => e.billable).reduce((n, e) => n + e.minutes, 0),
      truncated,
      canReadAll: all,
    };
  }

  // ── Cronómetro ────────────────────────────────────────────────────────────

  async currentTimer(actor: Actor): Promise<TimerView | null> {
    const timer = await this.repos.timers.get(actor.organizationId, actor.userId);
    if (!timer) return null;
    const task = await this.repos.tasks.findById(actor.organizationId, timer.taskId);
    return { timer, taskTitle: task?.title ?? '' };
  }

  /**
   * Arranca el cronómetro en una tarea. Como en Asana, solo hay uno por persona: si había otro en marcha en OTRA tarea, se detiene
   * y sus minutos se registran (`stopped`). Arrancarlo dos veces en la misma tarea no lo reinicia.
   *
   * `INSERT IGNORE` primero y, si ya había uno, lectura con bloqueo: dos «arrancar» a la vez (doble clic, dos pestañas) no chocan
   * con la clave primaria ni registran dos veces las horas del anterior.
   */
  async startTimer(actor: Actor, taskId: string, opts: { projectId?: string | null; previousWorkedOn?: string } = {}): Promise<{ timer: TimerView; stopped: TimeEntry | null }> {
    return inTransaction(this.gateway, async (uow) => {
      const ctx = await loadTask(uow, actor, taskId);
      assertTaskWritable(ctx, 'complete');
      const now = this.clock();
      const timer: RunningTimer = { organizationId: actor.organizationId, userId: actor.userId, taskId: ctx.task.id, projectId: projectFor(ctx, opts.projectId), startedAt: now };
      if (await uow.timers.add(timer)) return { timer: { timer, taskTitle: ctx.task.title }, stopped: null };

      // Ya había uno. El caso común es el doble clic sobre la MISMA tarea: se mira con bloqueo compartido (el que ya dejó el INSERT
      // IGNORE) y se devuelve sin escribir. Solo si es otra tarea hace falta el exclusivo para cambiarlo.
      const seen = await uow.timers.get(actor.organizationId, actor.userId, { share: true });
      if (seen && seen.taskId === ctx.task.id) return { timer: { timer: seen, taskTitle: ctx.task.title }, stopped: null };
      const running = await uow.timers.get(actor.organizationId, actor.userId, { forUpdate: true });
      if (running && running.taskId === ctx.task.id) return { timer: { timer: running, taskTitle: ctx.task.title }, stopped: null };
      const stopped = running ? await this.recordTimer(uow, actor, running, now, opts.previousWorkedOn) : null;
      if (running) await uow.timers.replace(timer);
      else await uow.timers.add(timer);
      return { timer: { timer, taskTitle: ctx.task.title }, stopped };
    });
  }

  /**
   * Detiene el cronómetro y registra sus minutos. `workedOn`: el día LOCAL en que arrancó, que manda el navegador (el servidor está
   * en UTC: un cronómetro arrancado a las 20:00 en Ecuador ya sería «mañana»). Si falta, el día UTC del arranque.
   */
  async stopTimer(actor: Actor, opts: { workedOn?: string; billable?: boolean; note?: string | null } = {}): Promise<TimeEntry> {
    return inTransaction(this.gateway, async (uow) => {
      const running = await uow.timers.get(actor.organizationId, actor.userId, { forUpdate: true });
      if (!running) throw new TimerNotRunningError();
      await uow.timers.remove(actor.organizationId, actor.userId);
      return this.recordTimer(uow, actor, running, this.clock(), opts.workedOn, opts.billable, cleanNote(opts.note));
    });
  }

  /** Descarta el cronómetro sin registrar nada (se arrancó por error). */
  async discardTimer(actor: Actor): Promise<void> {
    await inTransaction(this.gateway, async (uow) => {
      if (!(await uow.timers.remove(actor.organizationId, actor.userId))) throw new TimerNotRunningError();
    });
  }

  // ── Internos ──────────────────────────────────────────────────────────────

  private async recordTimer(
    uow: WriteUnitOfWork,
    actor: Actor,
    running: RunningTimer,
    now: Date,
    workedOn?: string,
    billable = true,
    note: string | null = null,
  ): Promise<TimeEntry> {
    const task = await uow.tasks.findById(actor.organizationId, running.taskId);
    if (!task) throw new TimerNotRunningError();
    const placements = await uow.placements.listByTasks(actor.organizationId, [task.parentTaskId ?? task.id]);
    const entry: TimeEntry = {
      id: this.newId(),
      organizationId: actor.organizationId,
      taskId: task.id,
      projectId: running.projectId,
      userId: actor.userId,
      workedOn: workedOn ?? running.startedAt.toISOString().slice(0, 10),
      // Un cronómetro olvidado el fin de semana no debe cargar 60 h: se corta en 24 h y la persona lo corrige si hace falta.
      minutes: Math.min(MAX_ENTRY_MINUTES, elapsedMinutes(running.startedAt, now)),
      billable,
      note,
      source: 'timer',
      billingId: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.saveNew(uow, actor, task, entry, placements.map((p) => p.projectId));
    return entry;
  }

  private async saveNew(uow: WriteUnitOfWork, actor: Actor, task: Task, entry: TimeEntry, projectIds: string[]): Promise<void> {
    await uow.timeEntries.save(entry);
    await recordActivity(uow, actor, task, 'time_logged', { minutes: entry.minutes, workedOn: entry.workedOn }, entry.createdAt);
    await uow.outbox.add(timeEntryLoggedEvent(entry, task.title, projectIds));
  }

  /** El registro, si es de quien pregunta o este administra proyectos. Si no: 404 (no se revela que existe). */
  private async loadOwned(uow: WriteUnitOfWork, actor: Actor, entryId: string): Promise<{ entry: TimeEntry; task: Task; projectIds: string[] }> {
    const entry = await uow.timeEntries.findById(actor.organizationId, entryId);
    if (!entry || (entry.userId !== actor.userId && !isOrgProjectAdmin(actor))) throw new TimeEntryNotFoundError();
    // Ya está en una factura del proyecto: cambiarla descuadraría lo facturado (se libera anulando o liberando esa factura).
    if (entry.billingId) throw new AlreadyBilledError();
    const task = await uow.tasks.findById(actor.organizationId, entry.taskId);
    if (!task) throw new TimeEntryNotFoundError();
    const placements = await uow.placements.listByTasks(actor.organizationId, [task.parentTaskId ?? task.id]);
    return { entry, task, projectIds: placements.map((p) => p.projectId) };
  }
}
