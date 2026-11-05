import { taskAccess } from '../../domain/access.js';
import { DependencyCycleError, ValidationError } from '../../domain/errors.js';
import type { Repositories } from '../../domain/repositories.js';
import type { Actor, Dependency, ProjectHealth, StatusUpdate, Task } from '../../domain/types.js';
import { assertTaskWritable, loadProject, loadTask, projectIdsOf, rolesInProjects } from '../access-context.js';
import { recordActivity } from '../activity.js';
import { dependencyAddedEvent, dependencyRemovedEvent, statusUpdatePostedEvent } from '../events.js';
import { type Clock, type IdGenerator, inTransaction, type UnitOfWorkGateway } from '../ports.js';
import { richOrFail } from './task-use-cases.js';

/** Hasta dónde se busca un ciclo. Un plan real no tiene cadenas de 500 tareas; esto solo evita recorrer un grafo enfermo sin fin. */
const MAX_CYCLE_SEARCH = 500;

/**
 * ¿Agregar «`taskId` espera a `dependsOnTaskId`» cerraría un ciclo? Lo cierra si, siguiendo lo que espera `dependsOnTaskId` (y lo
 * que espera eso, etc.), se llega a `taskId`. Búsqueda en anchura, por capas, con una consulta por capa.
 */
export async function closesCycle(repos: Repositories, organizationId: string, taskId: string, dependsOnTaskId: string): Promise<boolean> {
  if (taskId === dependsOnTaskId) return true;
  const seen = new Set<string>([dependsOnTaskId]);
  let frontier = [dependsOnTaskId];
  while (frontier.length > 0 && seen.size < MAX_CYCLE_SEARCH) {
    const edges = await repos.dependencies.listDependsOn(organizationId, frontier);
    frontier = [];
    for (const e of edges) {
      if (e.dependsOnTaskId === taskId) return true;
      if (!seen.has(e.dependsOnTaskId)) {
        seen.add(e.dependsOnTaskId);
        frontier.push(e.dependsOnTaskId);
      }
    }
  }
  return false;
}

/**
 * De esas tareas, las que el actor puede ver por sus proyectos (o porque son suyas). Sirve para no mostrar el título de una tarea de
 * un proyecto privado en «bloqueada por» solo porque alguien la enlazó. No mira seguidores: puede ocultar de más, nunca de menos.
 */
export async function visibleTasks(repos: Repositories, actor: Actor, tasks: Task[]): Promise<Task[]> {
  const live = tasks.filter((t) => !t.deletedAt);
  if (live.length === 0) return [];
  const parentIds = [...new Set(live.map((t) => t.parentTaskId).filter((id): id is string => !!id))];
  const parents = new Map((await repos.tasks.findManyByIds(actor.organizationId, parentIds)).map((t) => [t.id, t]));
  const rootOf = (t: Task) => (t.parentTaskId ? (parents.get(t.parentTaskId) ?? null) : t);
  const rootIds = [...new Set(live.map((t) => rootOf(t)?.id).filter((id): id is string => !!id))];
  const placements = await repos.placements.listByTasks(actor.organizationId, rootIds);
  const projects = await rolesInProjects(repos, actor, placements.map((p) => p.projectId));
  return live.filter((task) => {
    const root = rootOf(task);
    if (!root) return false;
    const roles = placements.filter((p) => p.taskId === root.id && projects.has(p.projectId)).map((p) => projects.get(p.projectId)!.role);
    return taskAccess({ actor, task, root, rolesInProjects: roles }).canView;
  });
}

/**
 * Dependencias (fin → inicio) y estado del proyecto: lo que el cronograma necesita además de las fechas.
 *
 * Crear o quitar una dependencia lo hace quien puede EDITAR la tarea que espera, y tiene que poder VER la tarea a la que espera.
 */
export class TimelineUseCases {
  constructor(
    private readonly gateway: UnitOfWorkGateway,
    private readonly repos: Repositories,
    private readonly clock: Clock,
    private readonly newId: IdGenerator,
  ) {}

  async addDependency(actor: Actor, taskId: string, dependsOnTaskId: string): Promise<Dependency> {
    return inTransaction(this.gateway, async (uow) => {
      const ctx = await loadTask(uow, actor, taskId, { forUpdate: true });
      assertTaskWritable(ctx);
      const blocker = await loadTask(uow, actor, dependsOnTaskId);
      if (await closesCycle(uow, actor.organizationId, ctx.task.id, blocker.task.id)) throw new DependencyCycleError();
      const now = this.clock();
      const dependency: Dependency = { taskId: ctx.task.id, dependsOnTaskId: blocker.task.id, organizationId: actor.organizationId, createdAt: now };
      if (await uow.dependencies.add(dependency)) {
        await recordActivity(uow, actor, ctx.task, 'dependency_added', { dependsOn: blocker.task.title }, now);
        await uow.outbox.add(dependencyAddedEvent(ctx.task, blocker.task, projectIdsOf(ctx)));
      }
      return dependency;
    });
  }

  async removeDependency(actor: Actor, taskId: string, dependsOnTaskId: string): Promise<void> {
    await inTransaction(this.gateway, async (uow) => {
      const ctx = await loadTask(uow, actor, taskId, { forUpdate: true });
      assertTaskWritable(ctx);
      if (await uow.dependencies.remove(actor.organizationId, ctx.task.id, dependsOnTaskId)) {
        const [blocker] = await uow.tasks.findManyByIds(actor.organizationId, [dependsOnTaskId]);
        await recordActivity(uow, actor, ctx.task, 'dependency_removed', { dependsOn: blocker?.title ?? null }, this.clock());
        await uow.outbox.add(dependencyRemovedEvent(ctx.task, dependsOnTaskId, projectIdsOf(ctx)));
      }
    });
  }

  /** Publicar el estado del proyecto: lo hace un editor o administrador del proyecto, como en Asana. */
  async postStatusUpdate(actor: Actor, projectId: string, input: { status: ProjectHealth; bodyDoc?: unknown }): Promise<StatusUpdate> {
    const rich = input.bodyDoc !== undefined && input.bodyDoc !== null ? richOrFail('bodyDoc', input.bodyDoc) : null;
    return inTransaction(this.gateway, async (uow) => {
      const { project } = await loadProject(uow, actor, projectId, { needs: 'editor' });
      const update: StatusUpdate = {
        id: this.newId(),
        organizationId: actor.organizationId,
        projectId: project.id,
        status: input.status,
        bodyDoc: rich?.text ? rich.doc : null,
        bodyText: rich?.text || null,
        authorUserId: actor.userId,
        createdAt: this.clock(),
      };
      await uow.statusUpdates.add(update);
      const members = await uow.members.listByProject(actor.organizationId, project.id);
      await uow.outbox.add(statusUpdatePostedEvent(project, update, members.map((m) => m.userId).filter((id) => id !== actor.userId)));
      return update;
    });
  }

  async listStatusUpdates(actor: Actor, projectId: string, limit = 20): Promise<StatusUpdate[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ValidationError([{ field: 'limit', message: 'Entre 1 y 100.' }]);
    await loadProject(this.repos, actor, projectId);
    return this.repos.statusUpdates.listByProject(actor.organizationId, projectId, limit);
  }
}

