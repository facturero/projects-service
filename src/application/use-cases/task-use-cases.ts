import { atLeast } from '../../domain/access.js';
import {
  InvalidPositionError,
  ProjectArchivedError,
  ProjectRoleError,
  SectionNotFoundError,
  SubtaskDepthError,
  ValidationError,
  VersionConflictError,
} from '../../domain/errors.js';
import type { Repositories, SubtaskCount } from '../../domain/repositories.js';
import { byRank, rankBetween } from '../../domain/rank.js';
import { parseRichText, RichTextError } from '../../domain/richtext.js';
import type {
  Activity,
  Actor,
  ApprovalDecision,
  Attachment,
  Comment,
  CustomField,
  Dependency,
  FieldValue,
  Project,
  ProjectRole,
  RichDoc,
  Section,
  Tag,
  Task,
  TaskKind,
  TaskLink,
  TaskPlacement,
  TimeEntry,
} from '../../domain/types.js';
import { assertTaskWritable, loadProject, loadTask, projectIdsOf, rolesInProjects } from '../access-context.js';
import type { RuleEvent } from '../../domain/automation.js';
import { audience, recordActivity } from '../activity.js';
import {
  approvalDecidedEvent,
  approvalRequestedEvent,
  taskAssignedEvent,
  taskUnblockedEvent,
  taskCompletedEvent,
  taskCreatedEvent,
  taskDeletedEvent,
  taskMentionedEvent,
  taskMovedEvent,
  taskReopenedEvent,
  taskUpdatedEvent,
} from '../events.js';
import { type Clock, type IdGenerator, inTransaction, type UnitOfWorkGateway, type WriteUnitOfWork } from '../ports.js';
import { savePlacement } from '../rebalance.js';
import { visibleTasks } from './timeline-use-cases.js';
import { type Position, rankForPosition } from './section-use-cases.js';

export interface CreateTaskInput extends Position {
  title: string;
  /** Texto plano (entregable 1) o documento de TipTap (`descriptionDoc`); si llegan los dos, manda el documento. */
  description?: string | null;
  descriptionDoc?: unknown;
  kind?: TaskKind;
  assigneeUserId?: string | null;
  startOn?: string | null;
  dueOn?: string | null;
  estimatedMinutes?: number | null;
  /** En un proyecto (con su sección; sin ella, la primera). Sin proyecto ni madre: tarea personal, «solo mía». */
  projectId?: string | null;
  sectionId?: string | null;
  /** Subtarea de esta tarea. */
  parentTaskId?: string | null;
}

export interface UpdateTaskInput {
  version: number;
  /** «Convertir en aprobación» (o volver a tarea normal), como el menú de Asana. */
  kind?: TaskKind;
  title?: string;
  description?: string | null;
  descriptionDoc?: unknown;
  assigneeUserId?: string | null;
  startOn?: string | null;
  dueOn?: string | null;
  estimatedMinutes?: number | null;
}

export interface MoveTaskInput extends Position {
  version: number;
  projectId: string;
  sectionId: string;
}

export interface ProjectChip {
  projectId: string;
  name: string;
  color: Project['color'];
  sectionId: string;
  sectionName: string | null;
}

export interface CommentView {
  comment: Comment;
  likedBy: string[];
}

/** Una tarea vecina en el grafo de dependencias, con lo justo para mostrarla y saber si ya no bloquea. */
export interface LinkedTask {
  id: string;
  title: string;
  dueOn: string | null;
  completed: boolean;
}

export interface TaskDetail {
  task: Task;
  links: TaskLink[];
  tags: Tag[];
  /** Los campos de los proyectos de la tarea que quien pregunta puede ver, con su valor (o `null`). */
  fields: Array<{ field: CustomField; value: FieldValue | null }>;
  /** Lo que esta tarea espera (si alguna sigue abierta, la tarea está bloqueada). Solo las que el actor puede ver. */
  blockedBy: LinkedTask[];
  /** Lo que espera a esta tarea. */
  blocking: LinkedTask[];
  parent: Pick<Task, 'id' | 'title'> | null;
  subtasks: Task[];
  projects: ProjectChip[];
  followers: string[];
  likedBy: string[];
  attachments: Attachment[];
  comments: CommentView[];
  activity: Activity[];
  canComment: boolean;
  canEdit: boolean;
  canComplete: boolean;
  /** Solo el responsable de una tarea de aprobación decide. */
  canDecide: boolean;
  /** Horas registradas en la tarea (las ve quien ve la tarea, como el «tiempo real» de Asana), las más recientes primero. */
  timeEntries: TimeEntry[];
  actualMinutes: number;
  /** Registrar horas: el responsable o un editor (`complete`). */
  canLogTime: boolean;
}

export interface BoardCard {
  task: Task;
  placement: TaskPlacement;
  subtasks: SubtaskCount;
  tags: Tag[];
  values: Record<string, FieldValue>;
  /** Minutos registrados en la tarea. */
  actualMinutes: number;
}

export interface Board {
  project: Project;
  myRole: ProjectRole;
  sections: Section[];
  cards: BoardCard[];
  /** Dependencias ENTRE tareas de este proyecto: las flechas del cronograma. */
  dependencies: Dependency[];
  /** Campos personalizados del proyecto: columnas de la lista. */
  fields: CustomField[];
}

export interface MyTaskItem {
  task: Task;
  parent: Pick<Task, 'id' | 'title'> | null;
  projects: Array<Pick<ProjectChip, 'projectId' | 'name' | 'color'>>;
  subtasks: SubtaskCount;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function assertDates(startOn: string | null, dueOn: string | null): void {
  if (startOn && dueOn && startOn > dueOn) {
    throw new ValidationError([{ field: 'startOn', message: 'La fecha de inicio no puede ser posterior a la de entrega.' }]);
  }
  for (const [field, value] of [['startOn', startOn], ['dueOn', dueOn]] as const) {
    if (value && !DATE.test(value)) throw new ValidationError([{ field, message: 'Fecha inválida (AAAA-MM-DD).' }]);
  }
}

/** Valida el documento de TipTap; un documento fuera de la lista blanca es 422, no un 500. */
export function richOrFail(field: string, raw: unknown): { doc: RichDoc; text: string; mentions: string[] } {
  try {
    return parseRichText(raw);
  } catch (err) {
    if (err instanceof RichTextError) throw new ValidationError([{ field, message: err.message }]);
    throw err;
  }
}

/** Las tarjetas VIVAS de una sección: lo que el cliente ve, y por tanto contra lo que se interpretan `beforeId`/`afterId`. */
async function liveCards(uow: Repositories, organizationId: string, projectId: string, sectionId: string, excludeTaskId?: string): Promise<TaskPlacement[]> {
  return (await uow.placements.listByProject(organizationId, projectId)).filter((p) => p.sectionId === sectionId && p.taskId !== excludeTaskId);
}

/** Seguir la tarea: quien la crea, su responsable y quien es mencionado en ella (como en Asana). */
async function follow(uow: Repositories, task: Task, userIds: Array<string | null>, at: Date): Promise<void> {
  for (const id of new Set(userIds.filter((u): u is string => !!u))) await uow.followers.add(task.organizationId, task.id, id, at);
}

/** Avisa a los mencionados por primera vez (ni el autor ni quien ya estaba mencionado) y los hace seguidores. */
export async function notifyMentions(
  uow: Repositories,
  actor: Actor,
  task: Task,
  params: { mentions: string[]; previous: string[]; where: 'comment' | 'description'; text: string; commentId?: string; projectIds: string[]; at: Date },
): Promise<string[]> {
  const fresh = params.mentions.filter((id) => id !== actor.userId && !params.previous.includes(id));
  await follow(uow, task, params.mentions, params.at);
  if (fresh.length) {
    await uow.outbox.add(
      taskMentionedEvent(task, { where: params.where, text: params.text, commentId: params.commentId, projectIds: params.projectIds, userIds: fresh }),
    );
  }
  return fresh;
}

export class TaskUseCases {
  constructor(
    private readonly gateway: UnitOfWorkGateway,
    private readonly repos: Repositories,
    private readonly clock: Clock,
    private readonly newId: IdGenerator,
  ) {}

  /** Reglas del proyecto (entregable 7). Se conecta después de construir, porque las reglas usan a su vez estos casos de uso. */
  private ruleRunner: ((actor: Actor, events: RuleEvent[]) => Promise<void>) | null = null;
  setRuleRunner(run: (actor: Actor, events: RuleEvent[]) => Promise<void>): void {
    this.ruleRunner = run;
  }

  /**
   * Tras CONFIRMAR el cambio (la regla nunca deshace lo que hizo la persona). Lo que hace una regla no dispara otras: sin bucles.
   * Un fallo de una regla no se propaga: queda en `last_error` de la regla.
   */
  private async fireRules(actor: Actor, events: RuleEvent[]): Promise<void> {
    if (!this.ruleRunner || actor.viaRule || events.length === 0) return;
    try {
      await this.ruleRunner(actor, events);
    } catch (err) {
      console.error('[projects-service] reglas:', err);
    }
  }

  // ── Lecturas ──────────────────────────────────────────────────────────────

  /** Lista y tablero salen de lo mismo: secciones y tarjetas de tareas raíz vivas, con el recuento de subtareas. */
  async board(actor: Actor, projectId: string): Promise<Board> {
    const { project, role } = await loadProject(this.repos, actor, projectId);
    const [sections, placements] = await Promise.all([
      this.repos.sections.listByProject(actor.organizationId, projectId),
      this.repos.placements.listByProject(actor.organizationId, projectId),
    ]);
    const tasks = await this.repos.tasks.findManyByIds(actor.organizationId, placements.map((p) => p.taskId));
    const byId = new Map(tasks.filter((t) => !t.deletedAt && !t.parentTaskId).map((t) => [t.id, t]));
    const ids = [...byId.keys()];
    const [counts, tags, fields, values, minutes] = await Promise.all([
      this.repos.tasks.subtaskCounts(actor.organizationId, ids),
      this.repos.tags.listForTasks(actor.organizationId, ids),
      this.repos.fields.listByProjects(actor.organizationId, [projectId]),
      this.repos.fields.valuesForTasks(actor.organizationId, ids),
      this.repos.timeEntries.totalsByTask(actor.organizationId, ids),
    ]);
    const ownFields = new Set(fields.map((f) => f.id));
    const valuesByTask = new Map<string, Record<string, FieldValue>>();
    for (const v of values) {
      if (!ownFields.has(v.fieldId)) continue;
      valuesByTask.set(v.taskId, { ...(valuesByTask.get(v.taskId) ?? {}), [v.fieldId]: v.value });
    }
    const cards = placements
      .filter((p) => byId.has(p.taskId))
      .sort(byRank)
      .map((placement) => ({
        task: byId.get(placement.taskId)!,
        placement,
        subtasks: counts.get(placement.taskId) ?? { total: 0, completed: 0 },
        tags: tags.get(placement.taskId) ?? [],
        values: valuesByTask.get(placement.taskId) ?? {},
        actualMinutes: minutes.get(placement.taskId) ?? 0,
      }));
    const dependencies = (await this.repos.dependencies.listDependsOn(actor.organizationId, ids)).filter((d) => byId.has(d.dependsOnTaskId));
    return { project, myRole: role, sections: [...sections].sort(byRank), cards, dependencies, fields };
  }

  /** El panel de detalle: la tarea, sus subtareas, dónde aparece, y todo su hilo (comentarios, historial, adjuntos, seguidores). */
  async get(actor: Actor, taskId: string): Promise<TaskDetail> {
    const ctx = await loadTask(this.repos, actor, taskId);
    const org = actor.organizationId;
    const id = ctx.task.id;
    const [subtasks, followers, attachments, comments, activity, taskLikes] = await Promise.all([
      ctx.task.parentTaskId ? Promise.resolve([]) : this.repos.tasks.listSubtasks(org, id),
      this.repos.followers.listByTask(org, id),
      this.repos.attachments.listByTask(org, id),
      this.repos.comments.listByTask(org, id),
      this.repos.activity.listByTask(org, id),
      this.repos.likes.usersFor(org, 'task', [id]),
    ]);
    const commentLikes = await this.repos.likes.usersFor(org, 'comment', comments.map((c) => c.id));
    const [dependsOn, dependents] = await Promise.all([this.repos.dependencies.listDependsOn(org, [id]), this.repos.dependencies.listDependents(org, [id])]);
    const linked = await visibleTasks(
      this.repos,
      actor,
      await this.repos.tasks.findManyByIds(org, [...dependsOn.map((d) => d.dependsOnTaskId), ...dependents.map((d) => d.taskId)]),
    );
    const asLinked = (t: Task): LinkedTask => ({ id: t.id, title: t.title, dueOn: t.dueOn, completed: t.completedAt !== null });
    const visibleProjectIds = ctx.placements.filter((p) => ctx.projects.get(p.projectId)?.role).map((p) => p.projectId);
    const [links, tagMap, fields, values, timeEntries] = await Promise.all([
      this.repos.links.listByTask(org, id),
      this.repos.tags.listForTasks(org, [id]),
      ctx.task.parentTaskId ? Promise.resolve([]) : this.repos.fields.listByProjects(org, visibleProjectIds),
      this.repos.fields.valuesForTasks(org, [id]),
      this.repos.timeEntries.list(org, { taskId: id }, 500),
    ]);
    const blockedByIds = new Set(dependsOn.map((d) => d.dependsOnTaskId));
    const blockingIds = new Set(dependents.map((d) => d.taskId));

    const projects: ProjectChip[] = [];
    for (const p of ctx.placements) {
      const entry = ctx.projects.get(p.projectId);
      // El responsable o un seguidor ve la tarea aunque el proyecto sea privado, pero no el nombre de un proyecto que no puede abrir.
      if (!entry?.role) continue;
      const section = await this.repos.sections.findById(org, p.sectionId);
      projects.push({ projectId: p.projectId, name: entry.project.name, color: entry.project.color, sectionId: p.sectionId, sectionName: section?.name ?? null });
    }
    return {
      task: ctx.task,
      links,
      tags: tagMap.get(id) ?? [],
      fields: fields.map((field) => ({ field, value: values.find((v) => v.fieldId === field.id)?.value ?? null })),
      blockedBy: linked.filter((t) => blockedByIds.has(t.id)).map(asLinked),
      blocking: linked.filter((t) => blockingIds.has(t.id)).map(asLinked),
      parent: ctx.task.parentTaskId ? { id: ctx.root.id, title: ctx.root.title } : null,
      subtasks,
      projects,
      followers,
      likedBy: taskLikes.get(id) ?? [],
      attachments,
      // Un comentario borrado deja su hueco («Comentario eliminado») pero no su texto.
      comments: comments.map((comment) => ({
        comment: comment.deletedAt ? { ...comment, bodyDoc: { type: 'doc', content: [] }, bodyText: '', mentionedUserIds: [] } : comment,
        likedBy: commentLikes.get(comment.id) ?? [],
      })),
      activity,
      canComment: ctx.access.canComment,
      canEdit: ctx.access.canEdit,
      canComplete: ctx.access.canComplete,
      canDecide: ctx.task.kind === 'approval' && ctx.task.assigneeUserId === actor.userId,
      timeEntries,
      actualMinutes: timeEntries.reduce((n, e) => n + e.minutes, 0),
      canLogTime: ctx.access.canComplete,
    };
  }

  /**
   * Mis tareas: lo asignado a mí (también subtareas y tareas de proyectos privados donde no soy miembro: asignarme algo me lo
   * comparte) más mis tareas personales sin responsable. La agrupación «Recién asignadas / Hoy / Próximas / Más tarde» la hace el
   * cliente, que conoce la fecha local de quien mira.
   */
  async myTasks(actor: Actor, includeCompleted = false): Promise<MyTaskItem[]> {
    const [assigned, personal] = await Promise.all([
      this.repos.tasks.listByAssignee(actor.organizationId, actor.userId, includeCompleted),
      this.repos.tasks.listPersonalUnassigned(actor.organizationId, actor.userId, includeCompleted),
    ]);
    const tasks = [...new Map([...assigned, ...personal].map((t) => [t.id, t])).values()].filter((t) => !t.deletedAt);

    const parentIds = [...new Set(tasks.map((t) => t.parentTaskId).filter((id): id is string => !!id))];
    const parents = new Map((await this.repos.tasks.findManyByIds(actor.organizationId, parentIds)).map((t) => [t.id, t]));
    const rootOf = (t: Task) => (t.parentTaskId ? parents.get(t.parentTaskId) ?? null : t);
    const alive = tasks.filter((t) => {
      const root = rootOf(t);
      return root !== null && !root.deletedAt;
    });

    const rootIds = [...new Set(alive.map((t) => rootOf(t)!.id))];
    const placements = await this.repos.placements.listByTasks(actor.organizationId, rootIds);
    const projects = await rolesInProjects(this.repos, actor, placements.map((p) => p.projectId));
    const counts = await this.repos.tasks.subtaskCounts(actor.organizationId, alive.filter((t) => !t.parentTaskId).map((t) => t.id));

    return alive.map((task) => {
      const root = rootOf(task)!;
      const chips = placements
        .filter((p) => p.taskId === root.id && projects.get(p.projectId)?.role)
        .map((p) => {
          const { project } = projects.get(p.projectId)!;
          return { projectId: project.id, name: project.name, color: project.color };
        });
      return {
        task,
        parent: task.parentTaskId ? { id: root.id, title: root.title } : null,
        projects: chips,
        subtasks: counts.get(task.id) ?? { total: 0, completed: 0 },
      };
    });
  }

  // ── Escrituras ────────────────────────────────────────────────────────────

  async create(actor: Actor, input: CreateTaskInput): Promise<Task> {
    const startOn = input.startOn ?? null;
    const dueOn = input.dueOn ?? null;
    assertDates(startOn, dueOn);
    const rich = input.descriptionDoc !== undefined && input.descriptionDoc !== null ? richOrFail('descriptionDoc', input.descriptionDoc) : null;
    const kind = input.kind ?? 'task';
    let added: RuleEvent | null = null;

    const created = await inTransaction(this.gateway, async (uow) => {
      const now = this.clock();
      const assignee = input.assigneeUserId ?? null;
      const task: Task = {
        id: this.newId(),
        organizationId: actor.organizationId,
        parentTaskId: null,
        kind,
        approvalStatus: kind === 'approval' ? 'pending' : null,
        title: input.title.trim(),
        description: rich ? rich.text || null : input.description?.trim() || null,
        descriptionDoc: rich?.doc ?? null,
        assigneeUserId: assignee,
        assignedAt: assignee ? now : null,
        startOn,
        dueOn,
        estimatedMinutes: input.estimatedMinutes ?? null,
        completedAt: null,
        completedBy: null,
        subtaskRank: null,
        createdBy: actor.userId,
        version: 1,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      };

      let projectIds: string[] = [];
      if (input.parentTaskId) {
        const parent = await loadTask(uow, actor, input.parentTaskId, { forUpdate: true });
        if (parent.task.parentTaskId) throw new SubtaskDepthError();
        assertTaskWritable(parent);
        const siblings = await uow.tasks.listSubtasks(actor.organizationId, parent.task.id);
        task.parentTaskId = parent.task.id;
        task.subtaskRank = rankBetween(siblings.map((s) => s.subtaskRank!).filter(Boolean).sort().at(-1) ?? null, null);
        projectIds = projectIdsOf(parent);
        await uow.tasks.save(task);
      } else if (input.projectId) {
        await loadProject(uow, actor, input.projectId, { needs: 'editor', writable: true });
        const section = await this.resolveSection(uow, actor, input.projectId, input.sectionId ?? null);
        const cards = await liveCards(uow, actor.organizationId, input.projectId, section.id);
        const placement: TaskPlacement = {
          taskId: task.id,
          projectId: input.projectId,
          organizationId: actor.organizationId,
          sectionId: section.id,
          rank: rankForPosition(cards, (c) => c.taskId, input),
          createdAt: now,
        };
        projectIds = [input.projectId];
        added = { trigger: 'task_added', projectId: input.projectId, taskId: task.id, sectionId: section.id };
        await uow.tasks.save(task);
        await savePlacement(uow, placement);
      } else {
        await uow.tasks.save(task);
      }

      await follow(uow, task, [actor.userId, assignee], now);
      await recordActivity(uow, actor, task, 'created', {}, now);
      await uow.outbox.add(taskCreatedEvent(task, projectIds));
      if (assignee) {
        await uow.outbox.add(taskAssignedEvent(task, null, projectIds, actor.userId));
        if (kind === 'approval' && assignee !== actor.userId) await uow.outbox.add(approvalRequestedEvent(task, projectIds));
      }
      if (rich) await notifyMentions(uow, actor, task, { mentions: rich.mentions, previous: [], where: 'description', text: rich.text, projectIds, at: now });
      return task;
    });
    if (added) await this.fireRules(actor, [added]);
    return created;
  }

  async update(actor: Actor, taskId: string, input: UpdateTaskInput): Promise<Task> {
    const rich = input.descriptionDoc !== undefined && input.descriptionDoc !== null ? richOrFail('descriptionDoc', input.descriptionDoc) : null;

    return inTransaction(this.gateway, async (uow) => {
      const ctx = await loadTask(uow, actor, taskId, { forUpdate: true });
      assertTaskWritable(ctx);
      const { task } = ctx;
      if (task.version !== input.version) throw new VersionConflictError(task.version);

      const next: Task = { ...task };
      const changes: string[] = [];
      const set = <K extends keyof Task>(key: K, value: Task[K] | undefined) => {
        if (value === undefined || JSON.stringify(value) === JSON.stringify(task[key])) return;
        next[key] = value;
        changes.push(key);
      };
      set('title', input.title?.trim());
      set('kind', input.kind);
      if (changes.includes('kind')) next.approvalStatus = next.kind === 'approval' ? (task.approvalStatus ?? 'pending') : null;
      if (rich) {
        set('descriptionDoc', rich.doc);
        if (changes.includes('descriptionDoc')) next.description = rich.text || null;
      } else if (input.descriptionDoc === null || input.description !== undefined) {
        set('descriptionDoc', null);
        set('description', input.description === undefined ? null : input.description?.trim() || null);
      }
      set('startOn', input.startOn);
      set('dueOn', input.dueOn);
      set('estimatedMinutes', input.estimatedMinutes);
      set('assigneeUserId', input.assigneeUserId);
      if (changes.length === 0) return task;
      assertDates(next.startOn, next.dueOn);

      const now = this.clock();
      const reassigned = changes.includes('assigneeUserId');
      if (reassigned) next.assignedAt = next.assigneeUserId ? now : null;
      next.version = task.version + 1;
      next.updatedAt = now;
      await uow.tasks.save(next);

      const projectIds = projectIdsOf(ctx);
      for (const change of changes) {
        if (change === 'title') await recordActivity(uow, actor, next, 'title_changed', { from: task.title, to: next.title }, now);
        if (change === 'kind') await recordActivity(uow, actor, next, 'kind_changed', { from: task.kind, to: next.kind }, now);
        if (change === 'dueOn') await recordActivity(uow, actor, next, 'due_changed', { from: task.dueOn, to: next.dueOn }, now);
        if (change === 'startOn') await recordActivity(uow, actor, next, 'start_changed', { from: task.startOn, to: next.startOn }, now);
        if (change === 'estimatedMinutes') await recordActivity(uow, actor, next, 'estimate_changed', { from: task.estimatedMinutes, to: next.estimatedMinutes }, now);
        if (change === 'assigneeUserId') {
          await recordActivity(uow, actor, next, next.assigneeUserId ? 'assigned' : 'unassigned', { from: task.assigneeUserId, to: next.assigneeUserId }, now);
        }
      }
      if (changes.includes('descriptionDoc') || changes.includes('description')) await recordActivity(uow, actor, next, 'description_changed', {}, now);

      const others = changes.filter((c) => c !== 'assigneeUserId');
      if (others.length) await uow.outbox.add(taskUpdatedEvent(next, others.map((c) => (c === 'descriptionDoc' ? 'description' : c)), projectIds));
      // Convertirla en aprobación ya asignada pide la aprobación a su responsable.
      const becameApproval = changes.includes('kind') && next.kind === 'approval' && !reassigned;
      if (becameApproval && next.assigneeUserId && next.assigneeUserId !== actor.userId) await uow.outbox.add(approvalRequestedEvent(next, projectIds));
      if (reassigned) {
        await follow(uow, next, [next.assigneeUserId], now);
        await uow.outbox.add(taskAssignedEvent(next, task.assigneeUserId, projectIds, actor.userId));
        if (next.kind === 'approval' && next.assigneeUserId && next.assigneeUserId !== actor.userId && next.approvalStatus !== 'approved' && next.approvalStatus !== 'rejected') {
          await uow.outbox.add(approvalRequestedEvent(next, projectIds));
        }
      }
      if (rich && changes.includes('descriptionDoc')) {
        const previous = task.descriptionDoc ? parseRichText(task.descriptionDoc).mentions : [];
        await notifyMentions(uow, actor, next, { mentions: rich.mentions, previous, where: 'description', text: rich.text, projectIds, at: now });
      }
      return next;
    });
  }

  /**
   * Arrastrar una tarjeta: a otra sección o a otro sitio de la misma, en UN proyecto (si la tarea está en varios, los demás no se
   * tocan). La tarea se lee con `FOR UPDATE` y se compara la versión: dos personas que mueven la misma tarjeta a la vez no se pisan
   * en silencio, la segunda recibe 409 y ve dónde quedó.
   */
  async move(actor: Actor, taskId: string, input: MoveTaskInput): Promise<{ task: Task; placement: TaskPlacement }> {
    let moved: RuleEvent | null = null;
    const result = await inTransaction(this.gateway, async (uow) => {
      const ctx = await loadTask(uow, actor, taskId, { forUpdate: true });
      const { task } = ctx;
      if (task.parentTaskId) throw new ValidationError([{ field: 'taskId', message: 'Las subtareas se ordenan dentro de su tarea, no en el tablero.' }]);
      const current = ctx.placements.find((p) => p.projectId === input.projectId);
      const entry = ctx.projects.get(input.projectId);
      if (!current || !entry) throw new InvalidPositionError();
      if (!atLeast(entry.role, 'editor')) throw new ProjectRoleError();
      if (entry.project.status === 'archived') throw new ProjectArchivedError();
      if (task.version !== input.version) throw new VersionConflictError(task.version);

      const section = await uow.sections.findById(actor.organizationId, input.sectionId);
      if (!section || section.projectId !== input.projectId) throw new SectionNotFoundError();
      const cards = await liveCards(uow, actor.organizationId, input.projectId, section.id, task.id);
      const target: TaskPlacement = { ...current, sectionId: section.id, rank: rankForPosition(cards, (c) => c.taskId, input) };
      const now = this.clock();
      const next: Task = { ...task, version: task.version + 1, updatedAt: now };

      const placement = await savePlacement(uow, target);
      await uow.tasks.save(next);
      if (current.sectionId !== placement.sectionId) {
        const from = await uow.sections.findById(actor.organizationId, current.sectionId);
        await recordActivity(uow, actor, next, 'moved', { projectId: input.projectId, from: from?.name ?? null, to: section.name }, now);
        moved = { trigger: 'task_moved', projectId: input.projectId, taskId: next.id, sectionId: section.id };
      }
      await uow.outbox.add(taskMovedEvent(next, current, placement));
      return { task: next, placement };
    });
    if (moved) await this.fireRules(actor, [moved]);
    return result;
  }

  async complete(actor: Actor, taskId: string): Promise<Task> {
    return this.setCompleted(actor, taskId, true);
  }

  async reopen(actor: Actor, taskId: string): Promise<Task> {
    return this.setCompleted(actor, taskId, false);
  }

  /** Sin versión: completar es idempotente y lo hace con un clic quien está mirando la tarea; no debe chocar con un cambio de título. */
  private async setCompleted(actor: Actor, taskId: string, completed: boolean): Promise<Task> {
    let done: RuleEvent[] = [];
    const result = await inTransaction(this.gateway, async (uow) => {
      const ctx = await loadTask(uow, actor, taskId, { forUpdate: true });
      assertTaskWritable(ctx, 'complete');
      const { task } = ctx;
      if ((task.completedAt !== null) === completed) return task;
      const now = this.clock();
      const next: Task = {
        ...task,
        completedAt: completed ? now : null,
        completedBy: completed ? actor.userId : null,
        version: task.version + 1,
        updatedAt: now,
      };
      await uow.tasks.save(next);
      await recordActivity(uow, actor, next, completed ? 'completed' : 'reopened', {}, now);
      const projectIds = projectIdsOf(ctx);
      await uow.outbox.add(completed ? taskCompletedEvent(next, projectIds, await audience(uow, next, actor.userId)) : taskReopenedEvent(next, projectIds));
      if (completed) await this.notifyUnblocked(uow, actor, next);
      // Las reglas «al completar» son de la tarea raíz en sus proyectos (una subtarea no está en ningún tablero).
      if (completed && !next.parentTaskId) done = projectIds.map((projectId) => ({ trigger: 'task_completed' as const, projectId, taskId: next.id, sectionId: null }));
      return next;
    });
    await this.fireRules(actor, done);
    return result;
  }

  /**
   * Decidir una aprobación, como en Asana: solo su responsable. Aprobar o rechazar la cierra; pedir cambios la deja abierta para que
   * quien la pidió corrija y vuelva a asignarla.
   */
  async decide(actor: Actor, taskId: string, decision: ApprovalDecision): Promise<Task> {
    return inTransaction(this.gateway, async (uow) => {
      const ctx = await loadTask(uow, actor, taskId, { forUpdate: true });
      const { task } = ctx;
      if (task.kind !== 'approval') throw new ValidationError([{ field: 'decision', message: 'Esta tarea no es una aprobación.' }]);
      if (task.assigneeUserId !== actor.userId) throw new ProjectRoleError('Solo la persona a quien se le pidió la aprobación puede decidirla.');
      for (const p of ctx.placements) if (ctx.projects.get(p.projectId)?.project.status === 'archived') throw new ProjectArchivedError();

      const now = this.clock();
      const closes = decision !== 'changes_requested';
      const next: Task = {
        ...task,
        approvalStatus: decision,
        completedAt: closes ? (task.completedAt ?? now) : null,
        completedBy: closes ? (task.completedBy ?? actor.userId) : null,
        version: task.version + 1,
        updatedAt: now,
      };
      await uow.tasks.save(next);
      await recordActivity(uow, actor, next, 'approval_decided', { decision }, now);
      await uow.outbox.add(approvalDecidedEvent(next, decision, projectIdsOf(ctx), await audience(uow, next, actor.userId)));
      return next;
    });
  }

  /** A la papelera (con sus subtareas, que dejan de verse porque su madre no está). */
  async delete(actor: Actor, taskId: string): Promise<void> {
    await inTransaction(this.gateway, async (uow) => {
      const ctx = await loadTask(uow, actor, taskId, { forUpdate: true });
      assertTaskWritable(ctx);
      const now = this.clock();
      const next: Task = { ...ctx.task, deletedAt: now, updatedAt: now, version: ctx.task.version + 1 };
      await uow.tasks.save(next);
      await uow.outbox.add(taskDeletedEvent(next, projectIdsOf(ctx)));
    });
  }

  /**
   * Al completar una tarea, las que la esperaban y ya no esperan a NADA abierto quedan libres: su responsable recibe «ya puedes
   * empezar» (Asana). Se lee dentro de la misma transacción, que ya ve esta tarea como completada.
   */
  private async notifyUnblocked(uow: WriteUnitOfWork, actor: Actor, done: Task): Promise<void> {
    const dependents = await uow.dependencies.listDependents(actor.organizationId, [done.id]);
    if (dependents.length === 0) return;
    const waiting = (await uow.tasks.findManyByIds(actor.organizationId, dependents.map((d) => d.taskId))).filter(
      (t) => !t.deletedAt && !t.completedAt && t.assigneeUserId,
    );
    if (waiting.length === 0) return;
    const blockers = await uow.dependencies.listDependsOn(actor.organizationId, waiting.map((t) => t.id));
    const blockerTasks = new Map((await uow.tasks.findManyByIds(actor.organizationId, blockers.map((b) => b.dependsOnTaskId))).map((t) => [t.id, t]));
    for (const task of waiting) {
      const stillBlocked = blockers.some((b) => b.taskId === task.id && (() => {
        const blocker = blockerTasks.get(b.dependsOnTaskId);
        return !!blocker && !blocker.deletedAt && !blocker.completedAt;
      })());
      if (stillBlocked) continue;
      const placements = await uow.placements.listByTasks(actor.organizationId, [task.parentTaskId ?? task.id]);
      const userIds = task.assigneeUserId && task.assigneeUserId !== actor.userId ? [task.assigneeUserId] : [];
      await uow.outbox.add(taskUnblockedEvent(task, done.id, placements.map((p) => p.projectId), userIds));
    }
  }

  private async resolveSection(uow: WriteUnitOfWork, actor: Actor, projectId: string, sectionId: string | null): Promise<Section> {
    const sections = (await uow.sections.listByProject(actor.organizationId, projectId)).sort(byRank);
    const section = sectionId ? sections.find((s) => s.id === sectionId) : sections[0];
    if (!section) throw new SectionNotFoundError();
    return section;
  }
}
