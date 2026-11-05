import { randomUUID } from 'node:crypto';
import type { Repositories } from '../domain/repositories.js';
import type { Actor, Task } from '../domain/types.js';

/**
 * Historial de la tarea («Ana cambió la fecha de entrega de 4 nov a 6 nov»), como el de Asana bajo los comentarios. Se escribe en
 * la MISMA transacción que el cambio: si el cambio se deshace, su línea también.
 *
 * `kind` es una clave estable (el frontend la traduce): created, title_changed, description_changed, assigned, unassigned,
 * due_changed, start_changed, moved, completed, reopened, approval_decided, attachment_added, attachment_removed.
 */
export async function recordActivity(
  uow: Repositories,
  actor: Actor | null,
  task: Task,
  kind: string,
  data: Record<string, unknown>,
  at: Date,
): Promise<void> {
  await uow.activity.add({
    id: randomUUID(),
    organizationId: task.organizationId,
    taskId: task.id,
    actorUserId: actor?.userId ?? null,
    kind,
    data,
    at,
  });
}

/** Quién debe enterarse de algo de la tarea: seguidores y responsable (y quien la creó), menos quien lo hizo y los excluidos. */
export async function audience(uow: Repositories, task: Task, actorId: string | null, exclude: string[] = []): Promise<string[]> {
  const followers = await uow.followers.listByTask(task.organizationId, task.id);
  const out = new Set([...followers, task.createdBy, ...(task.assigneeUserId ? [task.assigneeUserId] : [])]);
  if (actorId) out.delete(actorId);
  for (const id of exclude) out.delete(id);
  return [...out];
}
