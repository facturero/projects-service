import type { Actor, Project, ProjectMember, ProjectRole, Task } from './types.js';

/**
 * Quién puede hacer qué en un proyecto. Igual que en Asana, lo decide el rol DENTRO del proyecto, no un permiso global por acción:
 *
 *   - `viewer`     ve;
 *   - `commenter`  ve y (entregable 2) comenta;
 *   - `editor`     además crea, edita, mueve y completa tareas y secciones;
 *   - `admin`      además cambia el proyecto, sus miembros y su visibilidad, lo archiva o lo borra.
 *
 * Quien no es miembro de un proyecto de toda la organización lo ve como `commenter`: lo encuentra y lo sigue, pero para editar lo
 * tienen que sumar. A un proyecto privado (`members`) solo entran sus miembros. El permiso `project:admin` (el Administrador de la
 * organización) da `admin` en todos: es la llave para recuperar el proyecto privado de alguien que se fue.
 */
const RANK: Record<ProjectRole, number> = { viewer: 0, commenter: 1, editor: 2, admin: 3 };

export const PERMISSION_READ = 'project:read';
export const PERMISSION_CREATE = 'project:create';
export const PERMISSION_ADMIN = 'project:admin';

export function isOrgProjectAdmin(actor: Actor): boolean {
  return actor.permissions.includes(PERMISSION_ADMIN);
}

export function maxRole(...roles: Array<ProjectRole | null>): ProjectRole | null {
  let best: ProjectRole | null = null;
  for (const r of roles) if (r && (best === null || RANK[r] > RANK[best])) best = r;
  return best;
}

export function atLeast(role: ProjectRole | null, needed: ProjectRole): boolean {
  return role !== null && RANK[role] >= RANK[needed];
}

/** Rol efectivo de `actor` en `project`, o `null` si no puede ni verlo. */
export function effectiveRole(project: Project, member: ProjectMember | null, actor: Actor): ProjectRole | null {
  if (project.organizationId !== actor.organizationId || project.deletedAt) return null;
  return maxRole(
    member?.userId === actor.userId ? member.role : null,
    isOrgProjectAdmin(actor) ? 'admin' : null,
    project.visibility === 'organization' ? 'commenter' : null,
  );
}

export interface TaskAccess {
  canView: boolean;
  /** Comentar, dar «me gusta», seguir y adjuntar: comentarista o más, el responsable o un seguidor. Un lector solo mira. */
  canComment: boolean;
  canEdit: boolean;
  /** El responsable puede completar o reabrir SU tarea aunque solo comente en el proyecto (como en Asana). */
  canComplete: boolean;
}

/**
 * Acceso a una tarea a partir de los roles del actor en los proyectos donde aparece su tarea raíz (`rolesInProjects`, `null` donde
 * no puede entrar). Una subtarea hereda los proyectos de su madre.
 *
 *   - Con proyectos: se ve si se ve alguno de ellos, y se edita si en alguno es editor. El responsable y los seguidores de la tarea
 *     siempre la ven y la comentan (en Asana, asignarle algo a alguien o sumarlo como seguidor se lo comparte aunque el proyecto sea
 *     privado); editarla sigue siendo del rol en el proyecto.
 *   - Sin proyectos (tarea personal): quien la creó y el responsable la manejan; un seguidor la ve y la comenta.
 */
export function taskAccess(params: {
  actor: Actor;
  task: Task;
  root: Task;
  rolesInProjects: Array<ProjectRole | null>;
  /** ¿El actor sigue la tarea (o su madre, si es subtarea)? */
  isFollower?: boolean;
}): TaskAccess {
  const { actor, task, root, rolesInProjects } = params;
  const isFollower = params.isFollower === true;
  if (task.organizationId !== actor.organizationId || task.deletedAt || root.deletedAt) {
    return { canView: false, canComment: false, canEdit: false, canComplete: false };
  }
  const isAssignee = task.assigneeUserId === actor.userId || root.assigneeUserId === actor.userId;
  if (rolesInProjects.length === 0) {
    const mine = root.createdBy === actor.userId || isAssignee;
    return { canView: mine || isFollower, canComment: mine || isFollower, canEdit: mine, canComplete: mine };
  }
  const best = maxRole(...rolesInProjects);
  const canEdit = atLeast(best, 'editor');
  return {
    canView: best !== null || isAssignee || isFollower,
    canComment: atLeast(best, 'commenter') || isAssignee || isFollower,
    canEdit,
    canComplete: canEdit || task.assigneeUserId === actor.userId,
  };
}
