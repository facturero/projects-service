import { atLeast, effectiveRole, taskAccess, type TaskAccess } from '../domain/access.js';
import { ProjectArchivedError, ProjectNotFoundError, ProjectRoleError, TaskNotFoundError } from '../domain/errors.js';
import type { Repositories } from '../domain/repositories.js';
import type { Actor, Project, ProjectMember, ProjectRole, Task, TaskPlacement } from '../domain/types.js';

export interface ProjectContext {
  project: Project;
  member: ProjectMember | null;
  role: ProjectRole;
}

/**
 * Carga el proyecto y el rol de quien pide. Si no lo puede ver, 404 (nunca 403: no se revela que un proyecto privado existe); si lo
 * ve pero su rol no alcanza, 403. Con `writable`, además, un proyecto archivado no se cambia.
 */
export async function loadProject(
  repos: Repositories,
  actor: Actor,
  projectId: string,
  opts: { needs?: ProjectRole; forUpdate?: boolean; writable?: boolean } = {},
): Promise<ProjectContext> {
  const project = opts.forUpdate
    ? await repos.projects.findByIdForUpdate(actor.organizationId, projectId)
    : await repos.projects.findById(actor.organizationId, projectId);
  if (!project) throw new ProjectNotFoundError();
  const member = await repos.members.find(actor.organizationId, projectId, actor.userId);
  const role = effectiveRole(project, member, actor);
  if (!role) throw new ProjectNotFoundError();
  if (opts.needs && !atLeast(role, opts.needs)) throw new ProjectRoleError();
  if (opts.writable && project.status === 'archived') throw new ProjectArchivedError();
  return { project, member, role };
}

/** Rol del actor en cada proyecto de la lista (`null` donde no entra), con dos consultas en total. */
export async function rolesInProjects(repos: Repositories, actor: Actor, projectIds: string[]): Promise<Map<string, { project: Project; role: ProjectRole | null }>> {
  const out = new Map<string, { project: Project; role: ProjectRole | null }>();
  if (projectIds.length === 0) return out;
  const [projects, memberships] = await Promise.all([
    repos.projects.listByIds(actor.organizationId, projectIds),
    repos.members.listForUser(actor.organizationId, actor.userId, projectIds),
  ]);
  const byProject = new Map(memberships.map((m) => [m.projectId, m]));
  for (const p of projects) out.set(p.id, { project: p, role: effectiveRole(p, byProject.get(p.id) ?? null, actor) });
  return out;
}

export interface TaskContext {
  task: Task;
  /** La propia tarea o, si es subtarea, su madre: de ella salen los proyectos. */
  root: Task;
  placements: TaskPlacement[];
  projects: Map<string, { project: Project; role: ProjectRole | null }>;
  access: TaskAccess;
}

/** Carga una tarea con lo necesario para decidir qué puede hacer el actor con ella. Si no la puede ver: 404. */
export async function loadTask(repos: Repositories, actor: Actor, taskId: string, opts: { forUpdate?: boolean } = {}): Promise<TaskContext> {
  const task = opts.forUpdate
    ? await repos.tasks.findByIdForUpdate(actor.organizationId, taskId)
    : await repos.tasks.findById(actor.organizationId, taskId);
  if (!task || task.deletedAt) throw new TaskNotFoundError();
  const root = task.parentTaskId ? await repos.tasks.findById(actor.organizationId, task.parentTaskId) : task;
  if (!root) throw new TaskNotFoundError();

  const placements = await repos.placements.listByTasks(actor.organizationId, [root.id]);
  const projects = await rolesInProjects(repos, actor, placements.map((p) => p.projectId));
  // Un proyecto en la papelera ya no cuenta: sus tarjetas no deben dar acceso.
  const live = placements.filter((p) => projects.has(p.projectId));
  // Seguir la tarea (o su madre) la comparte, como en Asana.
  const isFollower =
    (await repos.followers.isFollowing(actor.organizationId, task.id, actor.userId)) ||
    (root.id !== task.id && (await repos.followers.isFollowing(actor.organizationId, root.id, actor.userId)));
  const access = taskAccess({ actor, task, root, rolesInProjects: live.map((p) => projects.get(p.projectId)!.role), isFollower });
  if (!access.canView) throw new TaskNotFoundError();
  return { task, root, placements: live, projects, access };
}

/** ¿Se puede escribir en la tarea? Además del rol: ninguno de sus proyectos puede estar archivado. */
export function assertTaskWritable(ctx: TaskContext, kind: 'edit' | 'complete' | 'comment' = 'edit'): void {
  const allowed = kind === 'edit' ? ctx.access.canEdit : kind === 'complete' ? ctx.access.canComplete : ctx.access.canComment;
  if (!allowed) throw new ProjectRoleError();
  for (const p of ctx.placements) {
    if (ctx.projects.get(p.projectId)?.project.status === 'archived') throw new ProjectArchivedError();
  }
}

/** Proyectos donde aparece la tarea (los de su madre, si es subtarea): a dónde avisa el tablero en vivo. */
export function projectIdsOf(ctx: TaskContext): string[] {
  return ctx.placements.map((p) => p.projectId);
}
