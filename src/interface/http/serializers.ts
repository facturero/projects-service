import type { PublicForm } from '../../application/use-cases/automation-use-cases.js';
import type { ProjectForm, ProjectRule } from '../../domain/automation.js';
import type { BillingPreview, BillingSummary } from '../../application/use-cases/billing-use-cases.js';
import type { TimeReport, TimerView } from '../../application/use-cases/time-use-cases.js';
import type { ProjectDetail, ProjectWithRole } from '../../application/use-cases/project-use-cases.js';
import type { Board, MyTaskItem, TaskDetail } from '../../application/use-cases/task-use-cases.js';
import type {
  Activity,
  Attachment,
  Comment,
  CustomField,
  Dependency,
  Project,
  ProjectMember,
  Section,
  StatusUpdate,
  Tag,
  Task,
  TaskLink,
  TaskPlacement,
  TimeEntry,
  ProjectBilling,
  ProjectInvoice,
} from '../../domain/types.js';

/** JSON de la API en camelCase; fechas con hora en ISO, fechas sin hora tal cual (`YYYY-MM-DD`). Nada interno (organización, papelera). */

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function projectDto(p: Project) {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    color: p.color,
    icon: p.icon,
    visibility: p.visibility,
    ownerUserId: p.ownerUserId,
    status: p.status,
    defaultView: p.defaultView,
    version: p.version,
    createdAt: iso(p.createdAt),
    updatedAt: iso(p.updatedAt),
  };
}

export const tagDto = (t: Tag) => ({ id: t.id, name: t.name, color: t.color });
export const linkDto = (l: TaskLink) => ({ id: l.id, entityType: l.entityType, entityId: l.entityId, label: l.label, createdBy: l.createdBy, createdAt: iso(l.createdAt) });
export const fieldDto = (f: CustomField) => ({ id: f.id, projectId: f.projectId, name: f.name, type: f.type, options: f.options, rank: f.rank });

export function statusUpdateDto(u: StatusUpdate) {
  return { id: u.id, status: u.status, bodyDoc: u.bodyDoc, bodyText: u.bodyText, authorUserId: u.authorUserId, createdAt: iso(u.createdAt) };
}

export const dependencyDto = (d: Dependency) => ({ taskId: d.taskId, dependsOnTaskId: d.dependsOnTaskId });

export const projectWithRoleDto = (r: ProjectWithRole) => ({
  ...projectDto(r.project),
  myRole: r.myRole,
  isMember: r.isMember,
  latestStatus: r.latestStatus ? statusUpdateDto(r.latestStatus) : null,
});

export function memberDto(m: ProjectMember) {
  return { userId: m.userId, role: m.role, addedAt: iso(m.createdAt) };
}

export const projectDetailDto = (d: ProjectDetail) => ({ ...projectWithRoleDto(d), members: d.members.map(memberDto) });

export function sectionDto(s: Section) {
  return { id: s.id, name: s.name, rank: s.rank };
}

export function taskDto(t: Task) {
  return {
    id: t.id,
    parentTaskId: t.parentTaskId,
    kind: t.kind,
    approvalStatus: t.approvalStatus,
    title: t.title,
    description: t.description,
    descriptionDoc: t.descriptionDoc,
    assigneeUserId: t.assigneeUserId,
    assignedAt: iso(t.assignedAt),
    startOn: t.startOn,
    dueOn: t.dueOn,
    estimatedMinutes: t.estimatedMinutes,
    completedAt: iso(t.completedAt),
    completedBy: t.completedBy,
    createdBy: t.createdBy,
    version: t.version,
    createdAt: iso(t.createdAt),
    updatedAt: iso(t.updatedAt),
  };
}

export function placementDto(p: TaskPlacement) {
  return { projectId: p.projectId, sectionId: p.sectionId, rank: p.rank };
}

export function boardDto(b: Board) {
  return {
    project: { ...projectDto(b.project), myRole: b.myRole },
    sections: b.sections.map(sectionDto),
    tasks: b.cards.map((c) => ({
      ...taskDto(c.task),
      sectionId: c.placement.sectionId,
      rank: c.placement.rank,
      subtasks: c.subtasks,
      tags: c.tags.map(tagDto),
      values: c.values,
      actualMinutes: c.actualMinutes,
    })),
    dependencies: b.dependencies.map(dependencyDto),
    fields: b.fields.map(fieldDto),
  };
}

export function commentDto(c: Comment, likedBy: string[] = []) {
  return {
    id: c.id,
    taskId: c.taskId,
    authorUserId: c.authorUserId,
    bodyDoc: c.bodyDoc,
    bodyText: c.bodyText,
    mentionedUserIds: c.mentionedUserIds,
    createdAt: iso(c.createdAt),
    editedAt: iso(c.editedAt),
    deleted: c.deletedAt !== null,
    likedBy,
  };
}

export function attachmentDto(a: Attachment) {
  return {
    id: a.id,
    documentId: a.documentId,
    fileName: a.fileName,
    mimeType: a.mimeType,
    sizeBytes: a.sizeBytes,
    uploadedBy: a.uploadedBy,
    createdAt: iso(a.createdAt),
  };
}

export function activityDto(a: Activity) {
  return { id: a.id, actorUserId: a.actorUserId, kind: a.kind, data: a.data, at: iso(a.at) };
}

export function taskDetailDto(d: TaskDetail) {
  return {
    ...taskDto(d.task),
    links: d.links.map(linkDto),
    tags: d.tags.map(tagDto),
    fields: d.fields.map((f) => ({ ...fieldDto(f.field), value: f.value })),
    blockedBy: d.blockedBy,
    blocking: d.blocking,
    parent: d.parent,
    subtasks: d.subtasks.map(taskDto),
    projects: d.projects,
    followers: d.followers,
    likedBy: d.likedBy,
    attachments: d.attachments.map(attachmentDto),
    comments: d.comments.map((c) => commentDto(c.comment, c.likedBy)),
    activity: d.activity.map(activityDto),
    canComment: d.canComment,
    canEdit: d.canEdit,
    canComplete: d.canComplete,
    canDecide: d.canDecide,
    timeEntries: d.timeEntries.map(timeEntryDto),
    actualMinutes: d.actualMinutes,
    canLogTime: d.canLogTime,
  };
}

export function myTaskDto(i: MyTaskItem) {
  return { ...taskDto(i.task), parent: i.parent, projects: i.projects, subtasks: i.subtasks };
}

// ── Horas y carga de trabajo (entregable 5) ─────────────────────────────────

export function timeEntryDto(e: TimeEntry) {
  return {
    id: e.id,
    taskId: e.taskId,
    projectId: e.projectId,
    userId: e.userId,
    workedOn: e.workedOn,
    minutes: e.minutes,
    billable: e.billable,
    note: e.note,
    source: e.source,
    createdAt: iso(e.createdAt),
    updatedAt: iso(e.updatedAt),
  };
}

export function timeReportDto(r: TimeReport) {
  return {
    items: r.items.map((row) => ({ ...timeEntryDto(row.entry), taskTitle: row.taskTitle, taskDeleted: row.taskDeleted, projectName: row.projectName, canEdit: row.canEdit })),
    totalMinutes: r.totalMinutes,
    billableMinutes: r.billableMinutes,
    truncated: r.truncated,
    canReadAll: r.canReadAll,
  };
}

export function timerDto(v: TimerView | null) {
  if (!v) return { timer: null };
  return { timer: { taskId: v.timer.taskId, taskTitle: v.taskTitle, projectId: v.timer.projectId, startedAt: iso(v.timer.startedAt) } };
}

// ── Facturar el proyecto (entregable 6) ─────────────────────────────────────

export function billingSettingsDto(b: ProjectBilling) {
  return {
    customerId: b.customerId,
    customerLabel: b.customerLabel,
    hourlyRateCents: b.hourlyRateCents,
    serviceProductId: b.serviceProductId,
    serviceProductLabel: b.serviceProductLabel,
    groupBy: b.groupBy,
    updatedAt: iso(b.updatedAt),
  };
}

export function projectInvoiceDto(i: ProjectInvoice) {
  return {
    id: i.id,
    projectId: i.projectId,
    invoiceId: i.invoiceId,
    status: i.status,
    number: i.number,
    minutes: i.minutes,
    entryCount: i.entryCount,
    milestoneCount: i.milestoneCount,
    amountCents: i.amountCents,
    conflicts: i.conflicts,
    createdBy: i.createdBy,
    createdAt: iso(i.createdAt),
    updatedAt: iso(i.updatedAt),
  };
}

export function billingSummaryDto(s: BillingSummary) {
  return {
    settings: billingSettingsDto(s.settings),
    unbilledMinutes: s.unbilledMinutes,
    unbilledEntries: s.unbilledEntries,
    unbilledAmountCents: s.unbilledAmountCents,
    milestones: s.milestones.map((m) => ({ ...m, completedAt: iso(m.completedAt) })),
    invoices: s.invoices.map(projectInvoiceDto),
  };
}

export const billingPreviewDto = (p: BillingPreview) => p;

// ── Reglas, formularios y panel (entregable 7) ──────────────────────────────

export function ruleDto(r: ProjectRule) {
  return {
    id: r.id,
    projectId: r.projectId,
    name: r.name,
    trigger: r.trigger,
    triggerSectionId: r.triggerSectionId,
    actions: r.actions,
    enabled: r.enabled,
    runCount: r.runCount,
    lastRunAt: iso(r.lastRunAt),
    lastError: r.lastError,
    createdBy: r.createdBy,
    createdAt: iso(r.createdAt),
    updatedAt: iso(r.updatedAt),
  };
}

export function formDto(f: ProjectForm) {
  return {
    id: f.id,
    projectId: f.projectId,
    title: f.title,
    description: f.description,
    questions: f.questions,
    sectionId: f.sectionId,
    assigneeUserId: f.assigneeUserId,
    enabled: f.enabled,
    submissionCount: f.submissionCount,
    createdBy: f.createdBy,
    createdAt: iso(f.createdAt),
    updatedAt: iso(f.updatedAt),
  };
}

/** Lo que ve quien llena el formulario: sin sección, responsable ni contador. */
export function publicFormDto(p: PublicForm) {
  return { id: p.form.id, title: p.form.title, description: p.form.description, questions: p.form.questions, projectName: p.projectName };
}
