import { isOrgProjectAdmin } from '../../domain/access.js';
import { ForbiddenError, ValidationError } from '../../domain/errors.js';
import type { Repositories } from '../../domain/repositories.js';
import type { Actor, MemberCapacity, TaskKind } from '../../domain/types.js';
import { addDaysIso, allocate, DEFAULT_WEEKLY_MINUTES, MAX_WEEKS, mondayOf } from '../../domain/workload.js';
import { loadProject } from '../access-context.js';
import { capacityUpdatedEvent } from '../events.js';
import { type Clock, inTransaction, type UnitOfWorkGateway } from '../ports.js';
import { visibleTasks } from './timeline-use-cases.js';

export interface WorkloadTask {
  id: string;
  title: string;
  kind: TaskKind;
  startOn: string | null;
  dueOn: string;
  estimatedMinutes: number | null;
  /** Minutos que le tocan a cada semana mostrada (por lunes). */
  minutesByWeek: Record<string, number>;
  /** Semanas mostradas que la tarea toca, tenga o no estimación. */
  weeks: string[];
}

export interface WorkloadPerson {
  userId: string;
  weeklyMinutes: number;
  /** Por semana: minutos estimados y cuántas tareas la tocan. */
  weeks: Array<{ weekStart: string; minutes: number; taskCount: number }>;
  tasks: WorkloadTask[];
}

export interface Workload {
  weekStarts: string[];
  people: WorkloadPerson[];
  /** Capacidad configurada de cada persona (quien no esté aquí tiene `defaultWeeklyMinutes`). */
  capacities: Record<string, number>;
  defaultWeeklyMinutes: number;
}

/** Hasta 168 h: una semana entera. 0 vale (de vacaciones). */
const MAX_WEEKLY_MINUTES = 7 * 24 * 60;

/**
 * Carga de trabajo (entregable 5), como el «Workload» de Asana: por persona y semana, cuántas horas estimadas le tocan según las
 * fechas de sus tareas abiertas, contra su capacidad semanal. Solo cuenta lo que quien mira puede ver: a una persona sin acceso a un
 * proyecto privado la carga de los demás le sale incompleta, pero nunca le revela esas tareas.
 */
export class WorkloadUseCases {
  constructor(
    private readonly gateway: UnitOfWorkGateway,
    private readonly repos: Repositories,
    private readonly clock: Clock,
  ) {}

  async workload(actor: Actor, input: { from: string; weeks: number; projectId?: string }): Promise<Workload> {
    if (!Number.isInteger(input.weeks) || input.weeks < 1 || input.weeks > MAX_WEEKS) {
      throw new ValidationError([{ field: 'weeks', message: `Entre 1 y ${MAX_WEEKS} semanas.` }]);
    }
    const org = actor.organizationId;
    const first = mondayOf(input.from);
    const weekStarts = Array.from({ length: input.weeks }, (_, i) => addDaysIso(first, i * 7));
    const last = addDaysIso(weekStarts.at(-1)!, 6);

    let tasks = await visibleTasks(this.repos, actor, await this.repos.tasks.listScheduled(org, first, last));
    if (input.projectId) {
      await loadProject(this.repos, actor, input.projectId); // 404 si no lo puede ver
      const rootIds = [...new Set(tasks.map((t) => t.parentTaskId ?? t.id))];
      const inProject = new Set(
        (await this.repos.placements.listByTasks(org, rootIds)).filter((p) => p.projectId === input.projectId).map((p) => p.taskId),
      );
      tasks = tasks.filter((t) => inProject.has(t.parentTaskId ?? t.id));
    }

    const capacities: Record<string, number> = {};
    for (const c of await this.repos.capacity.list(org)) capacities[c.userId] = c.weeklyMinutes;

    const people = new Map<string, WorkloadPerson>();
    for (const task of tasks) {
      if (!task.assigneeUserId || !task.dueOn) continue;
      const { minutes, weeks } = allocate({ startOn: task.startOn, dueOn: task.dueOn, estimatedMinutes: task.estimatedMinutes }, weekStarts);
      if (weeks.size === 0) continue;
      let person = people.get(task.assigneeUserId);
      if (!person) {
        person = {
          userId: task.assigneeUserId,
          weeklyMinutes: capacities[task.assigneeUserId] ?? DEFAULT_WEEKLY_MINUTES,
          weeks: weekStarts.map((weekStart) => ({ weekStart, minutes: 0, taskCount: 0 })),
          tasks: [],
        };
        people.set(task.assigneeUserId, person);
      }
      for (const w of person.weeks) {
        w.minutes += minutes.get(w.weekStart) ?? 0;
        if (weeks.has(w.weekStart)) w.taskCount += 1;
      }
      person.tasks.push({
        id: task.id,
        title: task.title,
        kind: task.kind,
        startOn: task.startOn,
        dueOn: task.dueOn,
        estimatedMinutes: task.estimatedMinutes,
        minutesByWeek: Object.fromEntries(minutes),
        weeks: weekStarts.filter((w) => weeks.has(w)),
      });
    }
    for (const p of people.values()) p.tasks.sort((a, b) => a.dueOn.localeCompare(b.dueOn) || a.title.localeCompare(b.title));
    return { weekStarts, people: [...people.values()], capacities, defaultWeeklyMinutes: DEFAULT_WEEKLY_MINUTES };
  }

  /** Horas por semana de una persona (vacaciones = 0, medio tiempo = 20 h). Lo cambia un administrador de proyectos. */
  async setCapacity(actor: Actor, userId: string, weeklyMinutes: number): Promise<MemberCapacity> {
    if (!isOrgProjectAdmin(actor)) throw new ForbiddenError('Solo un administrador de proyectos cambia la capacidad de las personas.');
    if (!Number.isInteger(weeklyMinutes) || weeklyMinutes < 0 || weeklyMinutes > MAX_WEEKLY_MINUTES) {
      throw new ValidationError([{ field: 'weeklyMinutes', message: 'Entre 0 y 168 horas por semana.' }]);
    }
    return inTransaction(this.gateway, async (uow) => {
      const previous = (await uow.capacity.list(actor.organizationId)).find((c) => c.userId === userId)?.weeklyMinutes ?? DEFAULT_WEEKLY_MINUTES;
      const capacity: MemberCapacity = { organizationId: actor.organizationId, userId, weeklyMinutes, updatedBy: actor.userId, updatedAt: this.clock() };
      await uow.capacity.set(capacity);
      await uow.outbox.add(capacityUpdatedEvent(capacity, previous));
      return capacity;
    });
  }
}
