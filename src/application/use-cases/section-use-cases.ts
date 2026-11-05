import {
  InvalidPositionError,
  LastSectionError,
  SectionNotEmptyError,
  SectionNotFoundError,
} from '../../domain/errors.js';
import { byRank, rankBetween } from '../../domain/rank.js';
import { rewritePlacements, saveSection } from '../rebalance.js';
import type { Actor, Section } from '../../domain/types.js';
import { loadProject } from '../access-context.js';
import { sectionCreatedEvent, sectionDeletedEvent, sectionUpdatedEvent } from '../events.js';
import { type Clock, type IdGenerator, inTransaction, type UnitOfWorkGateway } from '../ports.js';

export interface Position {
  /** La sección (o tarjeta) que quedará justo ANTES. */
  beforeId?: string | null;
  /** La que quedará justo DESPUÉS. Sin ninguna de las dos: al final. */
  afterId?: string | null;
}

/**
 * Rango para insertar entre dos vecinas de una lista ya ordenada. Las vecinas las manda el cliente tal como las ve.
 *
 * No tienen que ser contiguas en la base: con «ocultar finalizadas» el cliente no ve todas las tarjetas, y entre dos que para él
 * son vecinas puede haber otras ocultas. Basta con que estén en orden: el elemento queda justo después de `beforeId` (y por tanto
 * antes de `afterId`). Si alguna ya no está en la lista o el orden se invirtió (otra persona movió algo), 422 y el cliente recarga,
 * en vez de dejar el elemento en un sitio que nadie eligió.
 */
export function rankForPosition<T extends { rank: string }>(items: T[], idOf: (item: T) => string, position: Position): string {
  const sorted = [...items].sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : idOf(a) < idOf(b) ? -1 : 1));
  const index = (id: string) => sorted.findIndex((i) => idOf(i) === id);
  const { beforeId, afterId } = position;
  if (!beforeId && !afterId) return rankBetween(sorted.at(-1)?.rank ?? null, null);
  if (beforeId && afterId) {
    const b = index(beforeId);
    const a = index(afterId);
    if (b === -1 || a === -1 || a <= b) throw new InvalidPositionError();
    return safeBetween(sorted[b]!.rank, sorted[b + 1]!.rank);
  }
  if (beforeId) {
    const b = index(beforeId);
    if (b === -1) throw new InvalidPositionError();
    return safeBetween(sorted[b]!.rank, sorted[b + 1]?.rank ?? null);
  }
  const a = index(afterId!);
  if (a === -1) throw new InvalidPositionError();
  return safeBetween(sorted[a - 1]?.rank ?? null, sorted[a]!.rank);
}

/** Dos movimientos simultáneos al mismo hueco pueden dejar dos rangos iguales: entre iguales no cabe nada, se va justo detrás. */
function safeBetween(before: string | null, after: string | null): string {
  if (before !== null && after !== null && before >= after) return rankBetween(before, null);
  return rankBetween(before, after);
}

export class SectionUseCases {
  constructor(
    private readonly gateway: UnitOfWorkGateway,
    private readonly clock: Clock,
    private readonly newId: IdGenerator,
  ) {}

  async create(actor: Actor, projectId: string, input: { name: string } & Position): Promise<Section> {
    return inTransaction(this.gateway, async (uow) => {
      const { project } = await loadProject(uow, actor, projectId, { needs: 'editor', forUpdate: true, writable: true });
      const sections = await uow.sections.listByProject(actor.organizationId, projectId);
      const now = this.clock();
      const section: Section = {
        id: this.newId(),
        organizationId: actor.organizationId,
        projectId,
        name: input.name.trim(),
        rank: rankForPosition(sections, (s) => s.id, input),
        createdAt: now,
        updatedAt: now,
      };
      const saved = await saveSection(uow, section);
      await uow.outbox.add(sectionCreatedEvent(project, saved));
      return saved;
    });
  }

  async rename(actor: Actor, projectId: string, sectionId: string, name: string): Promise<Section> {
    return inTransaction(this.gateway, async (uow) => {
      const { project } = await loadProject(uow, actor, projectId, { needs: 'editor', writable: true });
      const section = await uow.sections.findById(actor.organizationId, sectionId);
      if (!section || section.projectId !== projectId) throw new SectionNotFoundError();
      if (section.name === name.trim()) return section;
      const next: Section = { ...section, name: name.trim(), updatedAt: this.clock() };
      await uow.sections.save(next);
      await uow.outbox.add(sectionUpdatedEvent(project, next, ['name']));
      return next;
    });
  }

  /** Arrastrar una columna del tablero. El proyecto se bloquea: dos columnas movidas a la vez se ordenan una tras otra. */
  async move(actor: Actor, projectId: string, sectionId: string, position: Position): Promise<Section> {
    return inTransaction(this.gateway, async (uow) => {
      const { project } = await loadProject(uow, actor, projectId, { needs: 'editor', forUpdate: true, writable: true });
      const sections = await uow.sections.listByProject(actor.organizationId, projectId);
      const section = sections.find((s) => s.id === sectionId);
      if (!section) throw new SectionNotFoundError();
      const others = sections.filter((s) => s.id !== sectionId);
      const next = await saveSection(uow, { ...section, rank: rankForPosition(others, (s) => s.id, position), updatedAt: this.clock() });
      await uow.outbox.add(sectionUpdatedEvent(project, next, ['rank']));
      return next;
    });
  }

  /** Borra la sección. Si tiene tareas hay que decir adónde van (`moveTasksTo`): ninguna tarea se pierde por borrar una columna. */
  async delete(actor: Actor, projectId: string, sectionId: string, moveTasksTo: string | null): Promise<void> {
    await inTransaction(this.gateway, async (uow) => {
      const { project } = await loadProject(uow, actor, projectId, { needs: 'editor', forUpdate: true, writable: true });
      const sections = await uow.sections.listByProject(actor.organizationId, projectId);
      const section = sections.find((s) => s.id === sectionId);
      if (!section) throw new SectionNotFoundError();
      if (sections.length === 1) throw new LastSectionError();

      // Todas las tarjetas, también las de tareas en la papelera: la clave foránea no deja borrar una sección con tarjetas y, si la
      // tarea se restaura, tiene que tener dónde aparecer. Pero solo las VIVAS obligan a elegir destino: una columna que se ve vacía
      // se borra sin preguntar.
      const cards = (await uow.placements.listBySection(actor.organizationId, sectionId)).sort(byRank);
      const tasks = await uow.tasks.findManyByIds(actor.organizationId, cards.map((c) => c.taskId));
      const alive = tasks.filter((t) => !t.deletedAt).length;
      let target: Section | null = null;
      if (cards.length > 0) {
        target = sections.find((s) => s.id === moveTasksTo && s.id !== sectionId) ?? null;
        if (!target && alive > 0) throw new SectionNotEmptyError();
        target ??= sections.find((s) => s.id !== sectionId)!;
        // Al final de la sección destino, conservando el orden de ambas. Se reparte la columna entera de una vez: añadir N tarjetas
        // una detrás de otra alargaría los rangos (ver MAX_RANK_LENGTH).
        const existing = (await uow.placements.listBySection(actor.organizationId, target.id)).sort(byRank);
        await rewritePlacements(uow, [...existing, ...cards.map((c) => ({ ...c, sectionId: target!.id }))]);
      }
      await uow.sections.delete(actor.organizationId, sectionId);
      await uow.outbox.add(sectionDeletedEvent(project, section, alive, alive > 0 ? (target?.id ?? null) : null));
    });
  }
}
