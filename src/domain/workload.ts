/**
 * Carga de trabajo (entregable 5), funciones puras.
 *
 * Como el «Workload» de Asana: cada tarea abierta con responsable reparte su tiempo estimado entre los días LABORABLES (lunes a
 * viernes) que van de su inicio a su entrega; sin inicio, todo cae el día de la entrega. Una semana suma lo que le toca de cada
 * tarea. Las fechas son `YYYY-MM-DD` y se calculan en UTC para que la zona horaria del servidor no mueva ningún día.
 */

export const DEFAULT_WEEKLY_MINUTES = 40 * 60;
export const MAX_WEEKS = 12;

const DAY = 86_400_000;

function toTime(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y!, m! - 1, d!);
}

function toIso(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

export function addDaysIso(iso: string, days: number): string {
  return toIso(toTime(iso) + days * DAY);
}

/** Lunes de la semana de esa fecha. */
export function mondayOf(iso: string): string {
  const weekday = new Date(toTime(iso)).getUTCDay(); // 0 domingo … 6 sábado
  return addDaysIso(iso, -((weekday + 6) % 7));
}

function isWorkday(iso: string): boolean {
  const weekday = new Date(toTime(iso)).getUTCDay();
  return weekday !== 0 && weekday !== 6;
}

/** Días de [from, to], inclusive. Un rango al revés se trata como de un solo día (`to`). */
export function daysBetween(from: string, to: string): string[] {
  const start = toTime(from <= to ? from : to);
  const end = toTime(to);
  const out: string[] = [];
  for (let t = start; t <= end; t += DAY) out.push(toIso(t));
  return out;
}

export interface ScheduledTask {
  startOn: string | null;
  dueOn: string;
  estimatedMinutes: number | null;
}

/**
 * Minutos de la tarea que caen en cada semana pedida (por lunes), y en qué semanas «está» la tarea aunque no tenga estimación (para
 * contar tareas). Una tarea de fin de semana pone su tiempo en el día de entrega: no se pierde.
 */
export function allocate(task: ScheduledTask, weekStarts: string[]): { minutes: Map<string, number>; weeks: Set<string> } {
  const span = daysBetween(task.startOn && task.startOn <= task.dueOn ? task.startOn : task.dueOn, task.dueOn);
  const workdays = span.filter(isWorkday);
  const billedDays = workdays.length ? workdays : [task.dueOn];
  const perDay = (task.estimatedMinutes ?? 0) / billedDays.length;
  const wanted = new Set(weekStarts);
  const minutes = new Map<string, number>();
  const weeks = new Set<string>();
  for (const day of span) {
    const week = mondayOf(day);
    if (wanted.has(week)) weeks.add(week);
  }
  if (perDay > 0) {
    for (const day of billedDays) {
      const week = mondayOf(day);
      if (wanted.has(week)) minutes.set(week, (minutes.get(week) ?? 0) + perDay);
    }
  }
  for (const [week, m] of minutes) minutes.set(week, Math.round(m));
  return { minutes, weeks };
}

/** Minutos entre dos instantes, redondeados al minuto y al menos 1 (un cronómetro detenido al instante igual cuenta). */
export function elapsedMinutes(startedAt: Date, now: Date): number {
  return Math.max(1, Math.round((now.getTime() - startedAt.getTime()) / 60_000));
}
