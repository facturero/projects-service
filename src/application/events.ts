import { randomUUID } from 'node:crypto';
import type { DomainEvent } from '../domain/repositories.js';
import type { ProjectForm, ProjectRule } from '../domain/automation.js';
import type {
  ApprovalDecision,
  Attachment,
  Comment,
  CustomField,
  MemberCapacity,
  Project,
  ProjectBilling,
  ProjectInvoice,
  ProjectMember,
  ProjectRole,
  Section,
  StatusUpdate,
  Tag,
  Task,
  TaskLink,
  TaskPlacement,
  TimeEntry,
} from '../domain/types.js';

/**
 * Eventos de Proyectos y tareas. Cada uno arma su payload A MANO (nunca la entidad entera): el contrato es `asyncapi.yaml`, la
 * bitácora de auditoría los muestra con su etiqueta `audit.event.projects_*` y `notification-service` (entregable 2) avisará con
 * ellos. Todos llevan el prefijo `projects.`; la routing key es el `type`.
 *
 * Lección de purchasing-service (AGENTS.md, problema conocido 8): pasar la entidad tal cual metió `bigint` en el JSON del outbox y
 * dejó `organizationId` vacío. Aquí no hay importes, pero la regla es la misma.
 */
export function domainEvent(params: {
  type: string;
  aggregateType: string;
  aggregateId: string;
  organizationId: string;
  payload: Record<string, unknown>;
}): DomainEvent {
  return {
    eventId: randomUUID(),
    aggregateType: params.aggregateType,
    aggregateId: params.aggregateId,
    type: params.type,
    // La bitácora exige organizationId en el payload de todo mensaje.
    payload: { ...params.payload, organizationId: params.organizationId },
    occurredAt: new Date(),
  };
}

// ── Proyecto ────────────────────────────────────────────────────────────────

function projectPayload(p: Project): Record<string, unknown> {
  return { projectId: p.id, name: p.name, visibility: p.visibility, status: p.status };
}

function projectEvent(type: string, p: Project, extra: Record<string, unknown> = {}): DomainEvent {
  return domainEvent({ type, aggregateType: 'project', aggregateId: p.id, organizationId: p.organizationId, payload: { ...projectPayload(p), ...extra } });
}

export const projectCreatedEvent = (p: Project) => projectEvent('projects.project.created', p, { color: p.color, defaultView: p.defaultView });
export const projectUpdatedEvent = (p: Project, changes: string[]) => projectEvent('projects.project.updated', p, { changes });
export const projectArchivedEvent = (p: Project) => projectEvent('projects.project.archived', p);
export const projectUnarchivedEvent = (p: Project) => projectEvent('projects.project.unarchived', p);
export const projectDeletedEvent = (p: Project) => projectEvent('projects.project.deleted', p);

// ── Miembros ────────────────────────────────────────────────────────────────

function memberEvent(type: string, p: Project, m: Pick<ProjectMember, 'userId' | 'role'>, extra: Record<string, unknown> = {}): DomainEvent {
  return domainEvent({
    type,
    aggregateType: 'project',
    aggregateId: p.id,
    organizationId: p.organizationId,
    // `userIds`: a quién avisar (la convención que leen notification-service y el gateway). Lo calcula este servicio para que
    // ellos no tengan que saber qué es un proyecto.
    payload: { projectId: p.id, projectName: p.name, userId: m.userId, role: m.role, userIds: [m.userId], ...extra },
  });
}

export const memberAddedEvent = (p: Project, m: ProjectMember) => memberEvent('projects.member.added', p, m);
export const memberUpdatedEvent = (p: Project, m: ProjectMember, previousRole: ProjectRole) =>
  memberEvent('projects.member.updated', p, m, { previousRole });
export const memberRemovedEvent = (p: Project, m: ProjectMember) => memberEvent('projects.member.removed', p, m);

// ── Secciones ───────────────────────────────────────────────────────────────

function sectionEvent(type: string, p: Project, s: Section, extra: Record<string, unknown> = {}): DomainEvent {
  return domainEvent({
    type,
    aggregateType: 'project',
    aggregateId: p.id,
    organizationId: p.organizationId,
    payload: { projectId: p.id, projectName: p.name, sectionId: s.id, name: s.name, ...extra },
  });
}

export const sectionCreatedEvent = (p: Project, s: Section) => sectionEvent('projects.section.created', p, s);
export const sectionUpdatedEvent = (p: Project, s: Section, changes: string[]) => sectionEvent('projects.section.updated', p, s, { changes });
export const sectionDeletedEvent = (p: Project, s: Section, movedTasks: number, movedToSectionId: string | null) =>
  sectionEvent('projects.section.deleted', p, s, { movedTasks, movedToSectionId });

// ── Tareas ──────────────────────────────────────────────────────────────────

function taskPayload(t: Task): Record<string, unknown> {
  return {
    taskId: t.id,
    title: t.title,
    kind: t.kind,
    parentTaskId: t.parentTaskId,
    assigneeUserId: t.assigneeUserId,
    dueOn: t.dueOn,
    completed: t.completedAt !== null,
  };
}

function taskEvent(type: string, t: Task, extra: Record<string, unknown> = {}): DomainEvent {
  return domainEvent({ type, aggregateType: 'task', aggregateId: t.id, organizationId: t.organizationId, payload: { ...taskPayload(t), ...extra } });
}

/** `projectIds`: dónde aparece (la raíz, si es subtarea). Sirve a la bitácora y, en el entregable 2, al tablero en vivo. */
export const taskCreatedEvent = (t: Task, projectIds: string[]) => taskEvent('projects.task.created', t, { projectIds });
export const taskUpdatedEvent = (t: Task, changes: string[], projectIds: string[]) => taskEvent('projects.task.updated', t, { changes, projectIds });
/** `actorId`: quien asignó; asignarse una tarea a uno mismo no avisa. */
export const taskAssignedEvent = (t: Task, previousAssigneeUserId: string | null, projectIds: string[], actorId: string) =>
  taskEvent('projects.task.assigned', t, {
    previousAssigneeUserId,
    projectIds,
    userIds: t.assigneeUserId && t.assigneeUserId !== actorId ? [t.assigneeUserId] : [],
  });
export const taskMovedEvent = (t: Task, from: TaskPlacement, to: TaskPlacement) =>
  taskEvent('projects.task.moved', t, {
    projectId: to.projectId,
    fromSectionId: from.sectionId,
    toSectionId: to.sectionId,
    projectIds: [to.projectId],
  });
/** `userIds`: seguidores y autor, menos quien la completó (como Asana: te avisa de lo que sigues). */
export const taskCompletedEvent = (t: Task, projectIds: string[], userIds: string[] = []) =>
  taskEvent('projects.task.completed', t, { completedBy: t.completedBy, projectIds, userIds });
export const taskReopenedEvent = (t: Task, projectIds: string[]) => taskEvent('projects.task.reopened', t, { projectIds });
export const taskDeletedEvent = (t: Task, projectIds: string[]) => taskEvent('projects.task.deleted', t, { projectIds });

// ── Colaboración (entregable 2) ─────────────────────────────────────────────

/** Para la campana y la bitácora: el comienzo del texto, nunca el documento entero. */
export function excerpt(text: string, max = 140): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function commentEvent(type: string, t: Task, c: Comment, projectIds: string[], extra: Record<string, unknown> = {}): DomainEvent {
  return domainEvent({
    type,
    aggregateType: 'task',
    aggregateId: t.id,
    organizationId: t.organizationId,
    payload: { taskId: t.id, title: t.title, commentId: c.id, projectIds, ...extra },
  });
}

/** `userIds`: seguidores y responsable que NO fueron mencionados (los mencionados reciben `projects.task.mentioned`) ni son el autor. */
export const commentCreatedEvent = (t: Task, c: Comment, projectIds: string[], userIds: string[]) =>
  commentEvent('projects.comment.created', t, c, projectIds, { excerpt: excerpt(c.bodyText), userIds });
export const commentUpdatedEvent = (t: Task, c: Comment, projectIds: string[]) => commentEvent('projects.comment.updated', t, c, projectIds);
export const commentDeletedEvent = (t: Task, c: Comment, projectIds: string[]) => commentEvent('projects.comment.deleted', t, c, projectIds);

/** Una o varias personas mencionadas por primera vez en un comentario o en la descripción. */
export const taskMentionedEvent = (
  t: Task,
  params: { where: 'comment' | 'description'; text: string; commentId?: string; projectIds: string[]; userIds: string[] },
) =>
  taskEvent('projects.task.mentioned', t, {
    where: params.where,
    commentId: params.commentId ?? null,
    excerpt: excerpt(params.text),
    projectIds: params.projectIds,
    userIds: params.userIds,
  });

export const followerAddedEvent = (t: Task, userId: string, projectIds: string[]) =>
  taskEvent('projects.follower.added', t, { userId, projectIds });
export const followerRemovedEvent = (t: Task, userId: string, projectIds: string[]) =>
  taskEvent('projects.follower.removed', t, { userId, projectIds });

function attachmentEvent(type: string, t: Task, a: Attachment, projectIds: string[]): DomainEvent {
  return taskEvent(type, t, { attachmentId: a.id, documentId: a.documentId, fileName: a.fileName, projectIds });
}
export const attachmentAddedEvent = (t: Task, a: Attachment, projectIds: string[]) => attachmentEvent('projects.attachment.added', t, a, projectIds);
export const attachmentRemovedEvent = (t: Task, a: Attachment, projectIds: string[]) => attachmentEvent('projects.attachment.removed', t, a, projectIds);

/** Se pide una aprobación a su responsable (al crear la tarea de aprobación ya asignada, o al asignarla). */
export const approvalRequestedEvent = (t: Task, projectIds: string[]) =>
  taskEvent('projects.approval.requested', t, { projectIds, userIds: t.assigneeUserId ? [t.assigneeUserId] : [] });

/** El responsable decidió: avisa a quien la pidió y a los seguidores. */
export const approvalDecidedEvent = (t: Task, decision: ApprovalDecision, projectIds: string[], userIds: string[]) =>
  taskEvent('projects.approval.decided', t, { decision, projectIds, userIds });

/** Aviso de «vence hoy / mañana» al responsable. Lo publica el proceso diario, no una petición: no lleva actor. */
export const taskDueSoonEvent = (t: Task, when: 'today' | 'tomorrow', projectIds: string[]) =>
  taskEvent('projects.task.due_soon', t, { when, projectIds, userIds: t.assigneeUserId ? [t.assigneeUserId] : [] });

// ── Cronograma y estado del proyecto (entregable 3) ─────────────────────────

export const dependencyAddedEvent = (t: Task, dependsOn: Task, projectIds: string[]) =>
  taskEvent('projects.dependency.added', t, { dependsOnTaskId: dependsOn.id, dependsOnTitle: dependsOn.title, projectIds });
export const dependencyRemovedEvent = (t: Task, dependsOnTaskId: string, projectIds: string[]) =>
  taskEvent('projects.dependency.removed', t, { dependsOnTaskId, projectIds });

/** La última tarea que la bloqueaba se completó: «ya puedes empezar», al responsable (como Asana). */
export const taskUnblockedEvent = (t: Task, blockedByTaskId: string, projectIds: string[], userIds: string[]) =>
  taskEvent('projects.task.unblocked', t, { blockedByTaskId, projectIds, userIds });

/** Nueva actualización de estado del proyecto: avisa a sus miembros (menos a quien la publica). */
export const statusUpdatePostedEvent = (p: Project, u: StatusUpdate, userIds: string[]) =>
  domainEvent({
    type: 'projects.status_update.posted',
    aggregateType: 'project',
    aggregateId: p.id,
    organizationId: p.organizationId,
    payload: {
      projectId: p.id,
      projectName: p.name,
      statusUpdateId: u.id,
      status: u.status,
      excerpt: excerpt(u.bodyText ?? ''),
      projectIds: [p.id],
      userIds,
    },
  });

// ── Vínculos, etiquetas y campos (entregable 4) ─────────────────────────────

export const linkAddedEvent = (t: Task, l: TaskLink, projectIds: string[]) =>
  taskEvent('projects.link.added', t, { linkId: l.id, entityType: l.entityType, entityId: l.entityId, label: l.label, projectIds });
export const linkRemovedEvent = (t: Task, l: TaskLink, projectIds: string[]) =>
  taskEvent('projects.link.removed', t, { linkId: l.id, entityType: l.entityType, entityId: l.entityId, label: l.label, projectIds });

export const tagCreatedEvent = (tag: Tag) =>
  domainEvent({ type: 'projects.tag.created', aggregateType: 'tag', aggregateId: tag.id, organizationId: tag.organizationId, payload: { tagId: tag.id, name: tag.name, color: tag.color } });
export const taskTaggedEvent = (t: Task, tag: Tag, projectIds: string[]) => taskEvent('projects.task.tagged', t, { tagId: tag.id, tagName: tag.name, projectIds });
export const taskUntaggedEvent = (t: Task, tag: Tag, projectIds: string[]) => taskEvent('projects.task.untagged', t, { tagId: tag.id, tagName: tag.name, projectIds });

function fieldEvent(type: string, p: Project, f: CustomField, extra: Record<string, unknown> = {}): DomainEvent {
  return domainEvent({
    type,
    aggregateType: 'project',
    aggregateId: p.id,
    organizationId: p.organizationId,
    payload: { projectId: p.id, projectName: p.name, fieldId: f.id, name: f.name, fieldType: f.type, ...extra },
  });
}
export const fieldCreatedEvent = (p: Project, f: CustomField) => fieldEvent('projects.field.created', p, f);
export const fieldUpdatedEvent = (p: Project, f: CustomField, changes: string[]) => fieldEvent('projects.field.updated', p, f, { changes });
export const fieldDeletedEvent = (p: Project, f: CustomField) => fieldEvent('projects.field.deleted', p, f);
/** El valor va como texto para la bitácora (el de una lista, con el nombre de la opción). */
export const taskFieldSetEvent = (t: Task, f: CustomField, shown: string | null, projectIds: string[]) =>
  taskEvent('projects.task.field_set', t, { fieldId: f.id, fieldName: f.name, value: shown, projectIds });

// ── Horas y carga de trabajo (entregable 5) ─────────────────────────────────

/** Horas registradas, cambiadas o borradas: la bitácora las muestra y el entregable 6 factura sobre ellas. */
function timeEntryEvent(type: string, e: TimeEntry, title: string, projectIds: string[], extra: Record<string, unknown> = {}): DomainEvent {
  return domainEvent({
    type,
    aggregateType: 'time_entry',
    aggregateId: e.id,
    organizationId: e.organizationId,
    payload: {
      entryId: e.id,
      taskId: e.taskId,
      title,
      projectId: e.projectId,
      userId: e.userId,
      workedOn: e.workedOn,
      minutes: e.minutes,
      billable: e.billable,
      source: e.source,
      projectIds,
      ...extra,
    },
  });
}
export const timeEntryLoggedEvent = (e: TimeEntry, title: string, projectIds: string[]) => timeEntryEvent('projects.time_entry.logged', e, title, projectIds);
export const timeEntryUpdatedEvent = (e: TimeEntry, title: string, projectIds: string[], changes: string[]) =>
  timeEntryEvent('projects.time_entry.updated', e, title, projectIds, { changes });
export const timeEntryDeletedEvent = (e: TimeEntry, title: string, projectIds: string[]) => timeEntryEvent('projects.time_entry.deleted', e, title, projectIds);

export const capacityUpdatedEvent = (c: MemberCapacity, previousWeeklyMinutes: number) =>
  domainEvent({
    type: 'projects.capacity.updated',
    aggregateType: 'member_capacity',
    aggregateId: c.userId,
    organizationId: c.organizationId,
    payload: { userId: c.userId, weeklyMinutes: c.weeklyMinutes, previousWeeklyMinutes },
  });

// ── Facturar el proyecto (entregable 6) ─────────────────────────────────────

function billingEvent(type: string, organizationId: string, projectId: string, aggregateId: string, payload: Record<string, unknown>): DomainEvent {
  // `projectId` en el payload: la bitácora lo muestra y el tablero en vivo refresca la pestaña Facturación de ese proyecto.
  return domainEvent({ type, aggregateType: 'project_invoice', aggregateId, organizationId, payload: { projectId, ...payload } });
}

export const billingSettingsUpdatedEvent = (b: ProjectBilling) =>
  billingEvent('projects.billing.updated', b.organizationId, b.projectId, b.projectId, {
    customerId: b.customerId,
    customerLabel: b.customerLabel,
    hourlyRateCents: b.hourlyRateCents,
    serviceProductId: b.serviceProductId,
    groupBy: b.groupBy,
  });

export const milestoneAmountSetEvent = (organizationId: string, projectId: string, task: Task, amountCents: number | null) =>
  billingEvent('projects.milestone_amount.set', organizationId, projectId, task.id, { taskId: task.id, title: task.title, amountCents });

const invoicePayload = (i: ProjectInvoice) => ({
  billingId: i.id,
  invoiceId: i.invoiceId,
  status: i.status,
  minutes: i.minutes,
  entryCount: i.entryCount,
  milestoneCount: i.milestoneCount,
  amountCents: i.amountCents,
});

export const invoiceReservedEvent = (i: ProjectInvoice) => billingEvent('projects.invoice.reserved', i.organizationId, i.projectId, i.id, invoicePayload(i));
export const invoiceLinkedEvent = (i: ProjectInvoice) => billingEvent('projects.invoice.linked', i.organizationId, i.projectId, i.id, invoicePayload(i));
export const invoiceIssuedEvent = (i: ProjectInvoice) =>
  billingEvent('projects.invoice.issued', i.organizationId, i.projectId, i.id, { ...invoicePayload(i), number: i.number, conflicts: i.conflicts });
/** `reason`: `manual` (alguien la liberó antes de emitir) o `voided` (billing anuló la factura). Las horas vuelven a quedar por facturar. */
export const invoiceReleasedEvent = (i: ProjectInvoice, reason: 'manual' | 'voided') =>
  billingEvent('projects.invoice.released', i.organizationId, i.projectId, i.id, { ...invoicePayload(i), reason });

// ── Reglas y formularios (entregable 7) ─────────────────────────────────────

const ruleSummary = (r: ProjectRule) => ({ ruleId: r.id, projectId: r.projectId, name: r.name, trigger: r.trigger, enabled: r.enabled, actionTypes: r.actions.map((a) => a.type) });

export const ruleSavedEvent = (r: ProjectRule, created: boolean) =>
  domainEvent({ type: 'projects.rule.saved', aggregateType: 'project_rule', aggregateId: r.id, organizationId: r.organizationId, payload: { ...ruleSummary(r), created } });
export const ruleDeletedEvent = (r: ProjectRule) =>
  domainEvent({ type: 'projects.rule.deleted', aggregateType: 'project_rule', aggregateId: r.id, organizationId: r.organizationId, payload: ruleSummary(r) });
/** Cada vez que una regla corre (con `error` si alguna acción falló): la bitácora dice qué cambió una regla y no una persona. */
export const ruleAppliedEvent = (r: ProjectRule, taskId: string, error: string | null) =>
  domainEvent({
    type: 'projects.rule.applied',
    aggregateType: 'project_rule',
    aggregateId: r.id,
    organizationId: r.organizationId,
    payload: { ...ruleSummary(r), taskId, projectIds: [r.projectId], error },
  });

const formSummary = (f: ProjectForm) => ({ formId: f.id, projectId: f.projectId, title: f.title, enabled: f.enabled, questionCount: f.questions.length });

export const formSavedEvent = (f: ProjectForm, created: boolean) =>
  domainEvent({ type: 'projects.form.saved', aggregateType: 'project_form', aggregateId: f.id, organizationId: f.organizationId, payload: { ...formSummary(f), created } });
export const formDeletedEvent = (f: ProjectForm) =>
  domainEvent({ type: 'projects.form.deleted', aggregateType: 'project_form', aggregateId: f.id, organizationId: f.organizationId, payload: formSummary(f) });
export const formSubmittedEvent = (f: ProjectForm, taskId: string, submittedBy: string) =>
  domainEvent({
    type: 'projects.form.submitted',
    aggregateType: 'project_form',
    aggregateId: f.id,
    organizationId: f.organizationId,
    payload: { ...formSummary(f), taskId, submittedBy, projectIds: [f.projectId] },
  });
