import type { Repositories } from '../../domain/repositories.js';
import { taskDueSoonEvent } from '../events.js';
import { type Clock, inTransaction, type UnitOfWorkGateway } from '../ports.js';

/** Fecha y hora LOCALES de la zona de la organización (Ecuador: no hay horario de verano, pero se usa Intl igual). */
export function localNow(now: Date, timeZone: string): { date: string; tomorrow: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  const date = `${get('year')}-${get('month')}-${get('day')}`;
  const [y, m, d] = date.split('-').map(Number);
  const next = new Date(Date.UTC(y!, m! - 1, d! + 1));
  const tomorrow = next.toISOString().slice(0, 10);
  return { date, tomorrow, hour: Number(get('hour')) };
}

/**
 * «Vence pronto» de Asana: a partir de las 08:00 locales, un aviso al responsable de cada tarea sin completar que vence hoy, y otro
 * de las que vencen mañana. Corre cada hora (`infrastructure/jobs`); la tabla `task_reminders` (clave primaria por tarea, día y
 * tipo) garantiza un solo aviso aunque corra dos veces a la vez o se reinicie el servicio a media corrida.
 *
 * Una tarea por transacción: si una falla, las demás siguen y la fallida se reintenta en la próxima hora.
 */
export class DueSoonUseCase {
  constructor(
    private readonly gateway: UnitOfWorkGateway,
    private readonly repos: Repositories,
    private readonly clock: Clock,
    private readonly timeZone: string,
    private readonly fromHour = 8,
  ) {}

  async run(): Promise<{ sent: number; skipped: number }> {
    const now = this.clock();
    const { date, tomorrow, hour } = localNow(now, this.timeZone);
    if (hour < this.fromHour) return { sent: 0, skipped: 0 };

    const tasks = await this.repos.tasks.listDueOn([date, tomorrow]);
    let sent = 0;
    let skipped = 0;
    for (const task of tasks) {
      const when = task.dueOn === date ? 'today' : 'tomorrow';
      try {
        const published = await inTransaction(this.gateway, async (uow) => {
          if (!(await uow.reminders.tryAdd(task.id, date, when, now))) return false;
          const rootId = task.parentTaskId ?? task.id;
          const projectIds = (await uow.placements.listByTasks(task.organizationId, [rootId])).map((p) => p.projectId);
          await uow.outbox.add(taskDueSoonEvent(task, when, projectIds));
          return true;
        });
        if (published) sent += 1;
        else skipped += 1;
      } catch (err) {
        console.error(`[projects-service] aviso de vencimiento de la tarea ${task.id} falló; se reintenta en la próxima corrida:`, err);
      }
    }
    return { sent, skipped };
  }
}
