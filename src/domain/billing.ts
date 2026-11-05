/**
 * Facturar el proyecto (entregable 6), funciones puras: de horas e hitos a las líneas de la factura.
 *
 * Una línea de horas cobra `cantidad × tarifa`, con la cantidad en horas y DOS decimales (lo que billing-service y el SRI aceptan sin
 * redondear de nuevo): 1 h 31 min = 1,52 h. El importe se calcula aquí con la misma cantidad redondeada, para que lo que se muestra
 * antes de crear el borrador sea exactamente lo que billing va a sumar.
 */

export type GroupBy = 'task' | 'person' | 'single';
export const GROUP_BY: readonly GroupBy[] = ['task', 'person', 'single'];

export interface BillableEntry {
  id: string;
  taskId: string;
  userId: string;
  minutes: number;
}

export interface BillableMilestone {
  taskId: string;
  title: string;
  amountCents: number;
}

export interface BillingGroup {
  kind: 'hours' | 'milestone';
  /** Por tarea: su id; por persona: el id de la persona; todo junto: ''; hito: el id de la tarea. */
  key: string;
  /** Título de la tarea o del hito (por persona, el cliente pone el nombre). */
  label: string | null;
  minutes: number;
  /** Horas con dos decimales (la cantidad de la línea). En un hito, 1. */
  quantity: number;
  unitPriceCents: number;
  amountCents: number;
}

export function hoursQuantity(minutes: number): number {
  return Math.round((minutes / 60) * 100) / 100;
}

export function lineAmount(quantity: number, unitPriceCents: number): number {
  return Math.round(quantity * unitPriceCents);
}

export function buildGroups(params: {
  entries: BillableEntry[];
  titles: Map<string, string>;
  groupBy: GroupBy;
  hourlyRateCents: number;
  milestones: BillableMilestone[];
}): BillingGroup[] {
  const byKey = new Map<string, { label: string | null; minutes: number }>();
  for (const e of params.entries) {
    const key = params.groupBy === 'task' ? e.taskId : params.groupBy === 'person' ? e.userId : '';
    const label = params.groupBy === 'task' ? (params.titles.get(e.taskId) ?? '') : null;
    const g = byKey.get(key) ?? { label, minutes: 0 };
    g.minutes += e.minutes;
    byKey.set(key, g);
  }
  const hours: BillingGroup[] = [...byKey.entries()].map(([key, g]) => {
    const quantity = hoursQuantity(g.minutes);
    return { kind: 'hours', key, label: g.label, minutes: g.minutes, quantity, unitPriceCents: params.hourlyRateCents, amountCents: lineAmount(quantity, params.hourlyRateCents) };
  });
  // Una línea de 0,00 h (menos de 18 s en total) no se puede facturar.
  const billable = hours.filter((g) => g.quantity > 0).sort((a, b) => b.minutes - a.minutes);
  const milestones: BillingGroup[] = params.milestones.map((m) => ({
    kind: 'milestone',
    key: m.taskId,
    label: m.title,
    minutes: 0,
    quantity: 1,
    unitPriceCents: m.amountCents,
    amountCents: m.amountCents,
  }));
  return [...billable, ...milestones];
}
