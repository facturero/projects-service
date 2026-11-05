import type { Actor, Task } from '../../domain/types.js';
import { addDaysIso, mondayOf } from '../../domain/workload.js';
import type { Clock } from '../ports.js';
import type { TaskUseCases } from './task-use-cases.js';

export const DASHBOARD_WEEKS = 8;

export interface ProjectDashboard {
  today: string;
  totals: { total: number; open: number; completed: number; overdue: number; unassigned: number; dueThisWeek: number };
  bySection: Array<{ sectionId: string; name: string; open: number; completed: number }>;
  /** Abiertas por responsable (`userId` null = sin responsable), de más a menos. */
  byAssignee: Array<{ userId: string | null; open: number; overdue: number }>;
  /** Completadas por semana (lunes), las últimas 8, de la más vieja a la actual. */
  completedByWeek: Array<{ weekStart: string; count: number }>;
  milestones: Array<{ taskId: string; title: string; dueOn: string | null; completed: boolean }>;
  time: { estimatedMinutes: number; actualMinutes: number };
}

/**
 * Panel del proyecto (entregable 7), como el «Dashboard» de Asana: lo mismo que se ve en la lista, contado. Sale del tablero (mismos
 * permisos: quien no ve el proyecto recibe 404) y no guarda nada. Fechas en UTC, como el resto del servicio.
 */
export class DashboardUseCases {
  constructor(
    private readonly tasks: TaskUseCases,
    private readonly clock: Clock,
  ) {}

  async dashboard(actor: Actor, projectId: string): Promise<ProjectDashboard> {
    const board = await this.tasks.board(actor, projectId);
    const today = this.clock().toISOString().slice(0, 10);
    const weekEnd = addDaysIso(mondayOf(today), 6);
    const cards = board.cards;
    const open = (t: Task) => t.completedAt === null;
    const overdue = (t: Task) => open(t) && !!t.dueOn && t.dueOn < today;

    const bySection = board.sections.map((s) => {
      const inSection = cards.filter((c) => c.placement.sectionId === s.id);
      return { sectionId: s.id, name: s.name, open: inSection.filter((c) => open(c.task)).length, completed: inSection.filter((c) => !open(c.task)).length };
    });

    const assignees = new Map<string | null, { open: number; overdue: number }>();
    for (const { task } of cards) {
      if (!open(task)) continue;
      const a = assignees.get(task.assigneeUserId) ?? { open: 0, overdue: 0 };
      a.open += 1;
      if (overdue(task)) a.overdue += 1;
      assignees.set(task.assigneeUserId, a);
    }

    const firstWeek = addDaysIso(mondayOf(today), -7 * (DASHBOARD_WEEKS - 1));
    const completedByWeek = Array.from({ length: DASHBOARD_WEEKS }, (_, i) => ({ weekStart: addDaysIso(firstWeek, i * 7), count: 0 }));
    for (const { task } of cards) {
      if (!task.completedAt) continue;
      const week = mondayOf(task.completedAt.toISOString().slice(0, 10));
      const slot = completedByWeek.find((w) => w.weekStart === week);
      if (slot) slot.count += 1;
    }

    const milestones = cards
      .filter((c) => c.task.kind === 'milestone')
      .map((c) => ({ taskId: c.task.id, title: c.task.title, dueOn: c.task.dueOn, completed: !open(c.task) }))
      .sort((a, b) => Number(a.completed) - Number(b.completed) || (a.dueOn ?? '9999').localeCompare(b.dueOn ?? '9999'));

    return {
      today,
      totals: {
        total: cards.length,
        open: cards.filter((c) => open(c.task)).length,
        completed: cards.filter((c) => !open(c.task)).length,
        overdue: cards.filter((c) => overdue(c.task)).length,
        unassigned: cards.filter((c) => open(c.task) && !c.task.assigneeUserId).length,
        dueThisWeek: cards.filter((c) => open(c.task) && !!c.task.dueOn && c.task.dueOn >= today && c.task.dueOn <= weekEnd).length,
      },
      bySection,
      byAssignee: [...assignees.entries()].map(([userId, v]) => ({ userId, ...v })).sort((a, b) => b.open - a.open),
      completedByWeek,
      milestones,
      time: {
        estimatedMinutes: cards.reduce((n, c) => n + (c.task.estimatedMinutes ?? 0), 0),
        actualMinutes: cards.reduce((n, c) => n + c.actualMinutes, 0),
      },
    };
  }
}
