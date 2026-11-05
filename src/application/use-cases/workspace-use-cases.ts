import { isOrgProjectAdmin, PERMISSION_CREATE } from '../../domain/access.js';
import { AppError, ForbiddenError, ValidationError } from '../../domain/errors.js';
import { byRank, rankBetween, ranksAfter } from '../../domain/rank.js';
import type { Repositories } from '../../domain/repositories.js';
import { findTemplate, type Locale, TEMPLATES } from '../../domain/templates.js';
import type { Actor, Project, ProjectMember, Section, Task, TaskPlacement, Visibility } from '../../domain/types.js';
import { loadProject, rolesInProjects } from '../access-context.js';
import { projectCreatedEvent } from '../events.js';
import { type Clock, type IdGenerator, inTransaction, type UnitOfWorkGateway } from '../ports.js';
import type { OrganizeUseCases } from './organize-use-cases.js';
import type { TaskUseCases } from './task-use-cases.js';
import { visibleTasks } from './timeline-use-cases.js';

const DAY = 86_400_000;
const addDays = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);

export class TemplateNotFoundError extends AppError {
  readonly code = 'TEMPLATE_NOT_FOUND';
  readonly httpStatus = 404;
  constructor() {
    super('Plantilla no encontrada.');
  }
}

export interface SearchResult {
  tasks: Array<{ task: Task; projects: Array<{ projectId: string; name: string; color: Project['color'] }> }>;
  projects: Project[];
}

export type BulkAction =
  | { type: 'complete' | 'reopen' | 'delete' }
  | { type: 'assign'; assigneeUserId: string | null }
  | { type: 'due'; dueOn: string | null }
  | { type: 'move'; projectId: string; sectionId: string }
  | { type: 'tag'; tagId: string };

export interface BulkResult {
  taskId: string;
  ok: boolean;
  code?: string;
  message?: string;
}

/** El proyecto nuevo con su autor como administrador: lo mismo que `ProjectUseCases.create`. */
function newProject(actor: Actor, id: string, now: Date, fields: Pick<Project, 'name' | 'description' | 'color' | 'icon' | 'visibility' | 'defaultView'>): { project: Project; owner: ProjectMember } {
  const project: Project = {
    id,
    organizationId: actor.organizationId,
    ...fields,
    ownerUserId: actor.userId,
    status: 'active',
    version: 1,
    createdBy: actor.userId,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
  return { project, owner: { projectId: id, organizationId: actor.organizationId, userId: actor.userId, role: 'admin', createdAt: now } };
}

function blankTask(actor: Actor, id: string, now: Date, over: Partial<Task>): Task {
  return {
    id,
    organizationId: actor.organizationId,
    parentTaskId: null,
    kind: 'task',
    approvalStatus: null,
    title: '',
    description: null,
    descriptionDoc: null,
    assigneeUserId: null,
    assignedAt: null,
    startOn: null,
    dueOn: null,
    estimatedMinutes: null,
    completedAt: null,
    completedBy: null,
    subtaskRank: null,
    createdBy: actor.userId,
    version: 1,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    ...over,
  };
}

/**
 * Plantillas, duplicar proyectos, buscar y editar en lote: lo que trabaja con muchas tareas a la vez.
 *
 * Crear desde una plantilla o duplicar es UNA acción del usuario: se publica un solo `projects.project.created` (con la plantilla o
 * el origen y cuántas tareas trajo), no un evento por cada tarea copiada, que solo llenaría la bitácora de ruido.
 */
export class WorkspaceUseCases {
  constructor(
    private readonly gateway: UnitOfWorkGateway,
    private readonly repos: Repositories,
    private readonly tasks: TaskUseCases,
    private readonly organize: OrganizeUseCases,
    private readonly clock: Clock,
    private readonly newId: IdGenerator,
  ) {}

  // ── Plantillas ────────────────────────────────────────────────────────────

  listTemplates(locale: Locale) {
    return TEMPLATES.map((t) => ({
      code: t.code,
      icon: t.icon,
      color: t.color,
      name: t.name[locale],
      description: t.description[locale],
      sections: t.sections.map((s) => s.name[locale]),
      taskCount: t.sections.reduce((n, s) => n + s.tasks.length, 0),
    }));
  }

  async createFromTemplate(actor: Actor, input: { templateCode: string; name?: string; visibility: Visibility; startOn: string; locale: Locale }): Promise<Project> {
    if (!actor.permissions.includes(PERMISSION_CREATE)) throw new ForbiddenError();
    const template = findTemplate(input.templateCode);
    if (!template) throw new TemplateNotFoundError();
    const { locale } = input;

    return inTransaction(this.gateway, async (uow) => {
      const now = this.clock();
      const { project, owner } = newProject(actor, this.newId(), now, {
        name: (input.name?.trim() || template.name[locale]).slice(0, 120),
        description: template.description[locale],
        color: template.color,
        icon: template.icon,
        visibility: input.visibility,
        defaultView: template.defaultView,
      });
      await uow.projects.save(project);
      await uow.members.save(owner);

      const byKey = new Map<string, string>();
      const pending: Array<{ taskId: string; after: string[] }> = [];
      let taskCount = 0;
      let lastSection: string | null = null;
      for (const s of template.sections) {
        const section: Section = { id: this.newId(), organizationId: actor.organizationId, projectId: project.id, name: s.name[locale], rank: rankBetween(lastSection, null), createdAt: now, updatedAt: now };
        lastSection = section.rank;
        await uow.sections.save(section);
        const ranks = ranksAfter(null, s.tasks.length);
        for (const [i, tt] of s.tasks.entries()) {
          const start = tt.start ?? 0;
          const milestone = tt.kind === 'milestone';
          const task = blankTask(actor, this.newId(), now, {
            title: tt.title[locale],
            kind: tt.kind ?? 'task',
            approvalStatus: tt.kind === 'approval' ? 'pending' : null,
            startOn: milestone || !tt.days ? null : addDays(input.startOn, start),
            dueOn: addDays(input.startOn, start + Math.max((tt.days ?? 1) - 1, 0)),
          });
          await uow.tasks.save(task);
          const placement: TaskPlacement = { taskId: task.id, projectId: project.id, organizationId: actor.organizationId, sectionId: section.id, rank: ranks[i]!, createdAt: now };
          await uow.placements.save(placement);
          taskCount += 1;
          let lastSub: string | null = null;
          for (const sub of tt.subtasks ?? []) {
            lastSub = rankBetween(lastSub, null);
            await uow.tasks.save(blankTask(actor, this.newId(), now, { title: sub[locale], parentTaskId: task.id, subtaskRank: lastSub }));
          }
          if (tt.key) byKey.set(tt.key, task.id);
          if (tt.after?.length) pending.push({ taskId: task.id, after: tt.after });
        }
      }
      for (const p of pending) {
        for (const key of p.after) {
          const dependsOnTaskId = byKey.get(key);
          if (dependsOnTaskId) await uow.dependencies.add({ taskId: p.taskId, dependsOnTaskId, organizationId: actor.organizationId, createdAt: now });
        }
      }
      const created = projectCreatedEvent(project);
      await uow.outbox.add({ ...created, payload: { ...created.payload, templateCode: template.code, taskCount } });
      return project;
    });
  }

  // ── Duplicar ──────────────────────────────────────────────────────────────

  /**
   * Copia el proyecto con sus secciones, tareas (con subtareas, fechas, tipo y descripción), campos personalizados con sus valores,
   * etiquetas y dependencias. NO copia responsables, miembros, comentarios ni el estado de completado: es el uso de Asana «como
   * plantilla» (un proyecto que se repite cada mes).
   */
  async duplicate(actor: Actor, projectId: string, input: { name?: string }): Promise<Project> {
    if (!actor.permissions.includes(PERMISSION_CREATE)) throw new ForbiddenError();
    return inTransaction(this.gateway, async (uow) => {
      const { project: source } = await loadProject(uow, actor, projectId);
      const org = actor.organizationId;
      const now = this.clock();
      const { project, owner } = newProject(actor, this.newId(), now, {
        name: (input.name?.trim() || `${source.name} (copia)`).slice(0, 120),
        description: source.description,
        color: source.color,
        icon: source.icon,
        visibility: source.visibility,
        defaultView: source.defaultView,
      });
      await uow.projects.save(project);
      await uow.members.save(owner);

      const sectionIds = new Map<string, string>();
      for (const s of (await uow.sections.listByProject(org, source.id)).sort(byRank)) {
        const id = this.newId();
        sectionIds.set(s.id, id);
        await uow.sections.save({ ...s, id, projectId: project.id, createdAt: now, updatedAt: now });
      }

      const fieldIds = new Map<string, string>();
      for (const f of await uow.fields.listByProjects(org, [source.id])) {
        const id = this.newId();
        fieldIds.set(f.id, id);
        await uow.fields.save({ ...f, id, projectId: project.id, createdAt: now, updatedAt: now });
      }

      const placements = await uow.placements.listByProject(org, source.id);
      const roots = new Map((await uow.tasks.findManyByIds(org, placements.map((p) => p.taskId))).filter((t) => !t.deletedAt && !t.parentTaskId).map((t) => [t.id, t]));
      const taskIds = new Map<string, string>();
      const copy = (t: Task, over: Partial<Task>) =>
        blankTask(actor, this.newId(), now, {
          title: t.title,
          description: t.description,
          descriptionDoc: t.descriptionDoc,
          kind: t.kind,
          approvalStatus: t.kind === 'approval' ? 'pending' : null,
          startOn: t.startOn,
          dueOn: t.dueOn,
          estimatedMinutes: t.estimatedMinutes,
          ...over,
        });
      for (const p of placements.sort(byRank)) {
        const t = roots.get(p.taskId);
        const sectionId = sectionIds.get(p.sectionId);
        if (!t || !sectionId) continue;
        const clone = copy(t, {});
        taskIds.set(t.id, clone.id);
        await uow.tasks.save(clone);
        await uow.placements.save({ taskId: clone.id, projectId: project.id, organizationId: org, sectionId, rank: p.rank, createdAt: now });
        for (const sub of await uow.tasks.listSubtasks(org, t.id)) await uow.tasks.save(copy(sub, { parentTaskId: clone.id, subtaskRank: sub.subtaskRank }));
      }

      const oldIds = [...taskIds.keys()];
      for (const v of await uow.fields.valuesForTasks(org, oldIds)) {
        const fieldId = fieldIds.get(v.fieldId);
        if (fieldId) await uow.fields.setValue({ ...v, taskId: taskIds.get(v.taskId)!, fieldId, updatedAt: now });
      }
      for (const [oldId, tags] of await uow.tags.listForTasks(org, oldIds)) {
        for (const tag of tags) await uow.tags.attach(org, taskIds.get(oldId)!, tag.id, now);
      }
      for (const d of await uow.dependencies.listDependsOn(org, oldIds)) {
        const a = taskIds.get(d.taskId);
        const b = taskIds.get(d.dependsOnTaskId);
        if (a && b) await uow.dependencies.add({ taskId: a, dependsOnTaskId: b, organizationId: org, createdAt: now });
      }
      const created = projectCreatedEvent(project);
      await uow.outbox.add({ ...created, payload: { ...created.payload, duplicatedFrom: source.id, taskCount: taskIds.size } });
      return project;
    });
  }

  // ── Buscar ────────────────────────────────────────────────────────────────

  async search(actor: Actor, query: string): Promise<SearchResult> {
    const q = query.trim();
    if (q.length < 2) throw new ValidationError([{ field: 'q', message: 'Escribe al menos 2 caracteres.' }]);
    const found = await this.repos.tasks.search(actor.organizationId, q, 100);
    const viaProjects = new Set((await visibleTasks(this.repos, actor, found)).map((t) => t.id));
    const tasks = found.filter((t) => viaProjects.has(t.id) || t.createdBy === actor.userId || t.assigneeUserId === actor.userId).slice(0, 30);

    const rootIds = tasks.map((t) => t.parentTaskId ?? t.id);
    const placements = await this.repos.placements.listByTasks(actor.organizationId, rootIds);
    const roles = await rolesInProjects(this.repos, actor, placements.map((p) => p.projectId));
    const projects = (await this.repos.projects.listVisible(actor.organizationId, actor.userId, { status: 'active', allPrivate: isOrgProjectAdmin(actor) }))
      .filter((p) => p.name.toLocaleLowerCase('es').includes(q.toLocaleLowerCase('es')))
      .slice(0, 10);
    return {
      tasks: tasks.map((task) => ({
        task,
        projects: placements
          .filter((p) => p.taskId === (task.parentTaskId ?? task.id) && roles.get(p.projectId)?.role)
          .map((p) => {
            const { project } = roles.get(p.projectId)!;
            return { projectId: project.id, name: project.name, color: project.color };
          }),
      })),
      projects,
    };
  }

  // ── Edición en lote ───────────────────────────────────────────────────────

  /**
   * Aplica una acción a varias tareas (hasta 100), como la barra de selección múltiple de Asana. Cada tarea va en su propia
   * transacción con sus propias reglas de acceso: una tarea que no se puede tocar no impide las demás, y la respuesta dice cuál
   * falló y por qué. No exige versión: es una acción explícita sobre lo seleccionado.
   */
  async bulk(actor: Actor, taskIds: string[], action: BulkAction): Promise<BulkResult[]> {
    const ids = [...new Set(taskIds)];
    if (ids.length === 0 || ids.length > 100) throw new ValidationError([{ field: 'taskIds', message: 'Entre 1 y 100 tareas.' }]);
    const results: BulkResult[] = [];
    for (const taskId of ids) {
      try {
        await this.apply(actor, taskId, action);
        results.push({ taskId, ok: true });
      } catch (err) {
        if (!(err instanceof AppError)) throw err;
        results.push({ taskId, ok: false, code: err.code, message: err.message });
      }
    }
    return results;
  }

  private async apply(actor: Actor, taskId: string, action: BulkAction): Promise<void> {
    switch (action.type) {
      case 'complete':
        await this.tasks.complete(actor, taskId);
        return;
      case 'reopen':
        await this.tasks.reopen(actor, taskId);
        return;
      case 'delete':
        await this.tasks.delete(actor, taskId);
        return;
      case 'tag':
        await this.organize.setTag(actor, taskId, action.tagId, true);
        return;
      case 'assign':
      case 'due': {
        const current = await this.tasks.get(actor, taskId);
        await this.tasks.update(actor, taskId, {
          version: current.task.version,
          ...(action.type === 'assign' ? { assigneeUserId: action.assigneeUserId } : { dueOn: action.dueOn }),
        });
        return;
      }
      case 'move': {
        const current = await this.tasks.get(actor, taskId);
        await this.tasks.move(actor, taskId, { version: current.task.version, projectId: action.projectId, sectionId: action.sectionId });
        return;
      }
    }
  }
}
