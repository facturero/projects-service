import { byRank, evenRanks, MAX_RANK_LENGTH } from '../domain/rank.js';
import type { Repositories } from '../domain/repositories.js';
import type { Section, TaskPlacement } from '../domain/types.js';

/**
 * Guarda una tarjeta en su nueva posición. Si su rango quedó largo (ver `MAX_RANK_LENGTH`), reparte de nuevo TODA la columna con
 * rangos cortos y equidistantes, conservando el orden, en la misma transacción. Es raro (hace falta insertar muchas veces en el
 * mismo hueco) y la columna se reescribe una vez para que no vuelva a pasar en mucho tiempo.
 *
 * Se reparten todas las tarjetas de la sección, también las de tareas en la papelera: si una se restaura, vuelve a su sitio.
 */
export async function savePlacement(uow: Repositories, placement: TaskPlacement): Promise<TaskPlacement> {
  if (placement.rank.length <= MAX_RANK_LENGTH) {
    await uow.placements.save(placement);
    return placement;
  }
  const same = (p: TaskPlacement) => p.taskId === placement.taskId && p.projectId === placement.projectId;
  const others = (await uow.placements.listBySection(placement.organizationId, placement.sectionId)).filter((p) => !same(p));
  return (await rewrite(uow, [...others, placement].sort(byRank), same)) ?? placement;
}

/** Reparte rangos nuevos a una columna ya ordenada (al borrar una sección y mandar sus tarjetas a otra). */
export async function rewritePlacements(uow: Repositories, ordered: TaskPlacement[]): Promise<void> {
  await rewrite(uow, ordered, () => false);
}

async function rewrite(uow: Repositories, ordered: TaskPlacement[], pick: (p: TaskPlacement) => boolean): Promise<TaskPlacement | undefined> {
  const ranks = evenRanks(ordered.length);
  let picked: TaskPlacement | undefined;
  for (const [i, p] of ordered.entries()) {
    const next = { ...p, rank: ranks[i]! };
    if (pick(p)) picked = next;
    await uow.placements.save(next);
  }
  return picked;
}

/** Lo mismo para las columnas de un proyecto. */
export async function saveSection(uow: Repositories, section: Section): Promise<Section> {
  if (section.rank.length <= MAX_RANK_LENGTH) {
    await uow.sections.save(section);
    return section;
  }
  const others = (await uow.sections.listByProject(section.organizationId, section.projectId)).filter((s) => s.id !== section.id);
  const ordered = [...others, section].sort(byRank);
  const ranks = evenRanks(ordered.length);
  let mine = section;
  for (const [i, s] of ordered.entries()) {
    const next = { ...s, rank: ranks[i]! };
    if (s.id === section.id) mine = next;
    await uow.sections.save(next);
  }
  return mine;
}
