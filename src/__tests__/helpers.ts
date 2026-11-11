import type { UnitOfWorkGateway, WriteUnitOfWork } from '../application/ports.js';
import { CollaborationUseCases } from '../application/use-cases/collaboration-use-cases.js';
import { DueSoonUseCase } from '../application/use-cases/due-soon.js';
import { MemberUseCases } from '../application/use-cases/member-use-cases.js';
import { TimelineUseCases } from '../application/use-cases/timeline-use-cases.js';
import { OrganizeUseCases } from '../application/use-cases/organize-use-cases.js';
import { WorkspaceUseCases } from '../application/use-cases/workspace-use-cases.js';
import { TimeUseCases } from '../application/use-cases/time-use-cases.js';
import { WorkloadUseCases } from '../application/use-cases/workload-use-cases.js';
import { BillingUseCases } from '../application/use-cases/billing-use-cases.js';
import { AutomationUseCases } from '../application/use-cases/automation-use-cases.js';
import { DashboardUseCases } from '../application/use-cases/dashboard-use-cases.js';
import type { ProjectForm, ProjectRule } from '../domain/automation.js';
import { ProjectUseCases } from '../application/use-cases/project-use-cases.js';
import { SectionUseCases } from '../application/use-cases/section-use-cases.js';
import { TaskUseCases } from '../application/use-cases/task-use-cases.js';
import { byRank } from '../domain/rank.js';
import type { DomainEvent, Repositories, SubtaskCount } from '../domain/repositories.js';
import type {
  Activity,
  Actor,
  Attachment,
  Comment,
  CustomField,
  CustomFieldValue,
  Dependency,
  MemberCapacity,
  MilestoneAmount,
  Project,
  ProjectBilling,
  ProjectInvoice,
  ProjectMember,
  RunningTimer,
  Section,
  StatusUpdate,
  Tag,
  Task,
  TaskLink,
  TaskPlacement,
  TimeEntry,
} from '../domain/types.js';
import { createApp } from '../interface/http/app.js';

/**
 * Repositorios en memoria con la MISMA semántica que los de MySQL (filtro por organización, papelera, orden por rango). Las
 * transacciones copian el estado al empezar y lo descartan al deshacer: así una prueba ve que un error no deja nada a medias,
 * ni la fila ni su evento.
 */
interface State {
  projects: Map<string, Project>;
  members: Map<string, ProjectMember>;
  sections: Map<string, Section>;
  tasks: Map<string, Task>;
  placements: Map<string, TaskPlacement>;
  comments: Map<string, Comment>;
  followers: Map<string, { taskId: string; userId: string; organizationId: string; at: Date }>;
  likes: Map<string, { target: string; id: string; userId: string; organizationId: string; at: Date }>;
  attachments: Map<string, Attachment>;
  activity: Activity[];
  reminders: Set<string>;
  dependencies: Map<string, Dependency>;
  statusUpdates: StatusUpdate[];
  links: Map<string, TaskLink>;
  tags: Map<string, Tag>;
  taskTags: Map<string, { taskId: string; tagId: string; organizationId: string }>;
  fields: Map<string, CustomField>;
  fieldValues: Map<string, CustomFieldValue>;
  timeEntries: Map<string, TimeEntry>;
  timers: Map<string, RunningTimer>;
  capacity: Map<string, MemberCapacity>;
  billingSettings: Map<string, ProjectBilling>;
  milestoneAmounts: Map<string, MilestoneAmount>;
  projectInvoices: Map<string, ProjectInvoice>;
  rules: Map<string, ProjectRule>;
  forms: Map<string, ProjectForm>;
  outbox: DomainEvent[];
}

const emptyState = (): State => ({
  projects: new Map(),
  members: new Map(),
  sections: new Map(),
  tasks: new Map(),
  placements: new Map(),
  comments: new Map(),
  followers: new Map(),
  likes: new Map(),
  attachments: new Map(),
  activity: [],
  reminders: new Set(),
  dependencies: new Map(),
  statusUpdates: [],
  links: new Map(),
  tags: new Map(),
  taskTags: new Map(),
  fields: new Map(),
  fieldValues: new Map(),
  timeEntries: new Map(),
  timers: new Map(),
  capacity: new Map(),
  billingSettings: new Map(),
  milestoneAmounts: new Map(),
  projectInvoices: new Map(),
  rules: new Map(),
  forms: new Map(),
  outbox: [],
});

function cloneState(s: State): State {
  const copy = <T>(m: Map<string, T>) => new Map([...m].map(([k, v]) => [k, structuredClone(v)]));
  return {
    projects: copy(s.projects),
    members: copy(s.members),
    sections: copy(s.sections),
    tasks: copy(s.tasks),
    placements: copy(s.placements),
    comments: copy(s.comments),
    followers: copy(s.followers),
    likes: copy(s.likes),
    attachments: copy(s.attachments),
    activity: s.activity.map((a) => structuredClone(a)),
    reminders: new Set(s.reminders),
    dependencies: copy(s.dependencies),
    statusUpdates: s.statusUpdates.map((u) => structuredClone(u)),
    links: copy(s.links),
    tags: copy(s.tags),
    taskTags: copy(s.taskTags),
    fields: copy(s.fields),
    fieldValues: copy(s.fieldValues),
    timeEntries: copy(s.timeEntries),
    timers: copy(s.timers),
    capacity: copy(s.capacity),
    billingSettings: copy(s.billingSettings),
    milestoneAmounts: copy(s.milestoneAmounts),
    projectInvoices: copy(s.projectInvoices),
    rules: copy(s.rules),
    forms: copy(s.forms),
    outbox: [...s.outbox],
  };
}

const memberKey = (projectId: string, userId: string) => `${projectId}:${userId}`;
const placementKey = (taskId: string, projectId: string) => `${taskId}:${projectId}`;

function repositories(state: () => State): Repositories {
  const s = () => state();
  return {
    projects: {
      async findById(org, id) {
        const p = s().projects.get(id);
        return p && p.organizationId === org ? structuredClone(p) : null;
      },
      async findByIdForUpdate(org, id) {
        return this.findById(org, id);
      },
      async listByIds(org, ids) {
        return [...s().projects.values()].filter((p) => p.organizationId === org && ids.includes(p.id) && !p.deletedAt).map((p) => structuredClone(p));
      },
      async listVisible(org, userId, { status, allPrivate }) {
        const mine = new Set([...s().members.values()].filter((m) => m.organizationId === org && m.userId === userId).map((m) => m.projectId));
        return [...s().projects.values()]
          .filter((p) => p.organizationId === org && p.status === status && !p.deletedAt)
          .filter((p) => allPrivate || p.visibility === 'organization' || mine.has(p.id))
          .map((p) => structuredClone(p));
      },
      async statsByProjects(org, projectIds, today) {
        // Lo mismo que la consulta agrupada de MySQL: tareas de primer nivel, sin borrar, colocadas en el proyecto.
        const out = new Map<string, { total: number; completed: number; overdue: number; nextDueOn: string | null }>();
        for (const pl of s().placements.values()) {
          if (pl.organizationId !== org || !projectIds.includes(pl.projectId)) continue;
          const t = s().tasks.get(pl.taskId);
          if (!t || t.deletedAt || t.parentTaskId) continue;
          const st = out.get(pl.projectId) ?? { total: 0, completed: 0, overdue: 0, nextDueOn: null };
          st.total += 1;
          if (t.completedAt) st.completed += 1;
          else if (t.dueOn && t.dueOn < today) st.overdue += 1;
          else if (t.dueOn && (!st.nextDueOn || t.dueOn < st.nextDueOn)) st.nextDueOn = t.dueOn;
          out.set(pl.projectId, st);
        }
        return out;
      },
      async save(p) {
        s().projects.set(p.id, structuredClone(p));
      },
    },
    members: {
      async listByProject(org, projectId) {
        return [...s().members.values()].filter((m) => m.organizationId === org && m.projectId === projectId).map((m) => structuredClone(m));
      },
      async find(org, projectId, userId) {
        const m = s().members.get(memberKey(projectId, userId));
        return m && m.organizationId === org ? structuredClone(m) : null;
      },
      async listForUser(org, userId, projectIds) {
        return [...s().members.values()].filter((m) => m.organizationId === org && m.userId === userId && projectIds.includes(m.projectId)).map((m) => structuredClone(m));
      },
      async listByProjects(org, projectIds) {
        return [...s().members.values()]
          .filter((m) => m.organizationId === org && projectIds.includes(m.projectId))
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .map((m) => structuredClone(m));
      },
      async save(m) {
        s().members.set(memberKey(m.projectId, m.userId), structuredClone(m));
      },
      async remove(org, projectId, userId) {
        const m = s().members.get(memberKey(projectId, userId));
        if (m?.organizationId === org) s().members.delete(memberKey(projectId, userId));
      },
    },
    sections: {
      async findById(org, id) {
        const x = s().sections.get(id);
        return x && x.organizationId === org ? structuredClone(x) : null;
      },
      async listByProject(org, projectId) {
        return [...s().sections.values()].filter((x) => x.organizationId === org && x.projectId === projectId).sort(byRank).map((x) => structuredClone(x));
      },
      async save(x) {
        s().sections.set(x.id, structuredClone(x));
      },
      async delete(org, id) {
        if ([...s().placements.values()].some((p) => p.sectionId === id)) throw new Error('FK: la sección tiene tarjetas');
        if (s().sections.get(id)?.organizationId === org) s().sections.delete(id);
      },
    },
    tasks: {
      async findById(org, id) {
        const t = s().tasks.get(id);
        return t && t.organizationId === org ? structuredClone(t) : null;
      },
      async findByIdForUpdate(org, id) {
        return this.findById(org, id);
      },
      async findManyByIds(org, ids) {
        return [...s().tasks.values()].filter((t) => t.organizationId === org && ids.includes(t.id)).map((t) => structuredClone(t));
      },
      async listSubtasks(org, parentTaskId) {
        return [...s().tasks.values()]
          .filter((t) => t.organizationId === org && t.parentTaskId === parentTaskId && !t.deletedAt)
          .sort((a, b) => ((a.subtaskRank ?? '') < (b.subtaskRank ?? '') ? -1 : 1))
          .map((t) => structuredClone(t));
      },
      async subtaskCounts(org, parentIds) {
        const out = new Map<string, SubtaskCount>();
        for (const t of s().tasks.values()) {
          if (t.organizationId !== org || !t.parentTaskId || !parentIds.includes(t.parentTaskId) || t.deletedAt) continue;
          const c = out.get(t.parentTaskId) ?? { total: 0, completed: 0 };
          c.total += 1;
          if (t.completedAt) c.completed += 1;
          out.set(t.parentTaskId, c);
        }
        return out;
      },
      async listByAssignee(org, userId, includeCompleted) {
        return [...s().tasks.values()]
          .filter((t) => t.organizationId === org && t.assigneeUserId === userId && !t.deletedAt && (includeCompleted || !t.completedAt))
          .map((t) => structuredClone(t));
      },
      async listPersonalUnassigned(org, userId, includeCompleted) {
        const placed = new Set([...s().placements.values()].map((p) => p.taskId));
        return [...s().tasks.values()]
          .filter((t) => t.organizationId === org && t.createdBy === userId && !t.assigneeUserId && !t.parentTaskId && !t.deletedAt && !placed.has(t.id))
          .filter((t) => includeCompleted || !t.completedAt)
          .map((t) => structuredClone(t));
      },
      async search(org, query, limit) {
        const q = query.toLowerCase();
        return [...s().tasks.values()]
          .filter((t) => t.organizationId === org && !t.deletedAt && (t.title.toLowerCase().includes(q) || (t.description ?? '').toLowerCase().includes(q)))
          .slice(0, limit)
          .map((t) => structuredClone(t));
      },
      async listScheduled(org, from, to) {
        return [...s().tasks.values()]
          .filter((t) => t.organizationId === org && !t.completedAt && !t.deletedAt && t.assigneeUserId && t.dueOn && t.dueOn >= from && (t.startOn ?? t.dueOn) <= to)
          .map((t) => structuredClone(t));
      },
      async listDueOn(dates) {
        return [...s().tasks.values()]
          .filter((t) => t.dueOn && dates.includes(t.dueOn) && !t.completedAt && !t.deletedAt && t.assigneeUserId)
          .map((t) => structuredClone(t));
      },
      async save(t) {
        s().tasks.set(t.id, structuredClone(t));
      },
    },
    placements: {
      async listByProject(org, projectId) {
        return [...s().placements.values()]
          .filter((p) => p.organizationId === org && p.projectId === projectId && !s().tasks.get(p.taskId)?.deletedAt)
          .sort(byRank)
          .map((p) => structuredClone(p));
      },
      async listBySection(org, sectionId) {
        return [...s().placements.values()].filter((p) => p.organizationId === org && p.sectionId === sectionId).sort(byRank).map((p) => structuredClone(p));
      },
      async listByTasks(org, taskIds) {
        return [...s().placements.values()].filter((p) => p.organizationId === org && taskIds.includes(p.taskId)).map((p) => structuredClone(p));
      },
      async find(org, taskId, projectId) {
        const p = s().placements.get(placementKey(taskId, projectId));
        return p && p.organizationId === org ? structuredClone(p) : null;
      },
      async save(p) {
        s().placements.set(placementKey(p.taskId, p.projectId), structuredClone(p));
      },
    },
    comments: {
      async findById(org, id) {
        const c = s().comments.get(id);
        return c && c.organizationId === org ? structuredClone(c) : null;
      },
      async listByTask(org, taskId) {
        return [...s().comments.values()]
          .filter((c) => c.organizationId === org && c.taskId === taskId)
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1))
          .map((c) => structuredClone(c));
      },
      async save(c) {
        s().comments.set(c.id, structuredClone(c));
      },
    },
    followers: {
      async listByTask(org, taskId) {
        return [...s().followers.values()].filter((f) => f.organizationId === org && f.taskId === taskId).map((f) => f.userId);
      },
      async isFollowing(org, taskId, userId) {
        return s().followers.get(`${taskId}:${userId}`)?.organizationId === org;
      },
      async add(org, taskId, userId, at) {
        if (s().followers.has(`${taskId}:${userId}`)) return false;
        s().followers.set(`${taskId}:${userId}`, { taskId, userId, organizationId: org, at });
        return true;
      },
      async remove(org, taskId, userId) {
        const f = s().followers.get(`${taskId}:${userId}`);
        if (!f || f.organizationId !== org) return false;
        s().followers.delete(`${taskId}:${userId}`);
        return true;
      },
    },
    likes: {
      async usersFor(org, target, ids) {
        const out = new Map<string, string[]>();
        for (const l of s().likes.values()) {
          if (l.organizationId !== org || l.target !== target || !ids.includes(l.id)) continue;
          out.set(l.id, [...(out.get(l.id) ?? []), l.userId]);
        }
        return out;
      },
      async add(org, target, id, userId, at) {
        const key = `${target}:${id}:${userId}`;
        if (s().likes.has(key)) return false;
        s().likes.set(key, { target, id, userId, organizationId: org, at });
        return true;
      },
      async remove(org, target, id, userId) {
        return s().likes.delete(`${target}:${id}:${userId}`);
      },
    },
    attachments: {
      async findById(org, id) {
        const a = s().attachments.get(id);
        return a && a.organizationId === org ? structuredClone(a) : null;
      },
      async listByTask(org, taskId) {
        return [...s().attachments.values()].filter((a) => a.organizationId === org && a.taskId === taskId && !a.deletedAt).map((a) => structuredClone(a));
      },
      async save(a) {
        s().attachments.set(a.id, structuredClone(a));
      },
    },
    activity: {
      async add(a) {
        s().activity.push(structuredClone(a));
      },
      async listByTask(org, taskId) {
        return s().activity.filter((a) => a.organizationId === org && a.taskId === taskId).map((a) => structuredClone(a));
      },
    },
    reminders: {
      async tryAdd(taskId, onDate, kind) {
        const key = `${taskId}:${onDate}:${kind}`;
        if (s().reminders.has(key)) return false;
        s().reminders.add(key);
        return true;
      },
    },
    dependencies: {
      async listDependsOn(org, taskIds) {
        return [...s().dependencies.values()].filter((d) => d.organizationId === org && taskIds.includes(d.taskId)).map((d) => structuredClone(d));
      },
      async listDependents(org, taskIds) {
        return [...s().dependencies.values()].filter((d) => d.organizationId === org && taskIds.includes(d.dependsOnTaskId)).map((d) => structuredClone(d));
      },
      async add(d) {
        const key = `${d.taskId}:${d.dependsOnTaskId}`;
        if (s().dependencies.has(key)) return false;
        s().dependencies.set(key, structuredClone(d));
        return true;
      },
      async remove(org, taskId, dependsOnTaskId) {
        const key = `${taskId}:${dependsOnTaskId}`;
        if (s().dependencies.get(key)?.organizationId !== org) return false;
        return s().dependencies.delete(key);
      },
    },
    statusUpdates: {
      async add(u) {
        s().statusUpdates.push(structuredClone(u));
      },
      async listByProject(org, projectId, limit) {
        return s()
          .statusUpdates.filter((u) => u.organizationId === org && u.projectId === projectId)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .slice(0, limit)
          .map((u) => structuredClone(u));
      },
      async latestByProjects(org, ids) {
        const out = new Map<string, StatusUpdate>();
        for (const u of [...s().statusUpdates].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())) {
          if (u.organizationId === org && ids.includes(u.projectId) && !out.has(u.projectId)) out.set(u.projectId, structuredClone(u));
        }
        return out;
      },
    },
    links: {
      async listByTask(org, taskId) {
        return [...s().links.values()].filter((l) => l.organizationId === org && l.taskId === taskId).map((l) => structuredClone(l));
      },
      async listByEntity(org, type, id) {
        return [...s().links.values()].filter((l) => l.organizationId === org && l.entityType === type && l.entityId === id).map((l) => structuredClone(l));
      },
      async findById(org, id) {
        const l = s().links.get(id);
        return l && l.organizationId === org ? structuredClone(l) : null;
      },
      async add(l) {
        if ([...s().links.values()].some((x) => x.taskId === l.taskId && x.entityType === l.entityType && x.entityId === l.entityId)) return false;
        s().links.set(l.id, structuredClone(l));
        return true;
      },
      async remove(org, id) {
        if (s().links.get(id)?.organizationId !== org) return false;
        return s().links.delete(id);
      },
    },
    tags: {
      async list(org) {
        return [...s().tags.values()].filter((t) => t.organizationId === org).sort((a, b) => a.name.localeCompare(b.name, 'es')).map((t) => structuredClone(t));
      },
      async findById(org, id) {
        const t = s().tags.get(id);
        return t && t.organizationId === org ? structuredClone(t) : null;
      },
      async findByName(org, name) {
        const t = [...s().tags.values()].find((x) => x.organizationId === org && x.name.toLowerCase() === name.toLowerCase());
        return t ? structuredClone(t) : null;
      },
      async add(t) {
        if ([...s().tags.values()].some((x) => x.organizationId === t.organizationId && x.name.toLowerCase() === t.name.toLowerCase())) return false;
        s().tags.set(t.id, structuredClone(t));
        return true;
      },
      async listForTasks(org, taskIds) {
        const out = new Map<string, Tag[]>();
        for (const tt of s().taskTags.values()) {
          if (tt.organizationId !== org || !taskIds.includes(tt.taskId)) continue;
          const tag = s().tags.get(tt.tagId);
          if (tag) out.set(tt.taskId, [...(out.get(tt.taskId) ?? []), structuredClone(tag)].sort((a, b) => a.name.localeCompare(b.name, 'es')));
        }
        return out;
      },
      async attach(org, taskId, tagId) {
        const key = `${taskId}:${tagId}`;
        if (s().taskTags.has(key)) return false;
        s().taskTags.set(key, { taskId, tagId, organizationId: org });
        return true;
      },
      async detach(org, taskId, tagId) {
        return s().taskTags.delete(`${taskId}:${tagId}`);
      },
      async update(t) {
        const clash = [...s().tags.values()].some((x) => x.organizationId === t.organizationId && x.id !== t.id && x.name.toLowerCase() === t.name.toLowerCase());
        if (clash) return false;
        const cur = s().tags.get(t.id);
        if (cur && cur.organizationId === t.organizationId) s().tags.set(t.id, { ...cur, name: t.name, color: t.color });
        return true;
      },
      async remove(org, id) {
        const cur = s().tags.get(id);
        if (!cur || cur.organizationId !== org) return false;
        for (const [k, tt] of s().taskTags) if (tt.tagId === id) s().taskTags.delete(k);
        return s().tags.delete(id);
      },
      async usage(org) {
        const out = new Map<string, number>();
        for (const tt of s().taskTags.values()) if (tt.organizationId === org) out.set(tt.tagId, (out.get(tt.tagId) ?? 0) + 1);
        return out;
      },
    },
    fields: {
      async listByProjects(org, ids) {
        return [...s().fields.values()]
          .filter((f) => f.organizationId === org && ids.includes(f.projectId))
          .sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0))
          .map((f) => structuredClone(f));
      },
      async findById(org, id) {
        const f = s().fields.get(id);
        return f && f.organizationId === org ? structuredClone(f) : null;
      },
      async save(f) {
        s().fields.set(f.id, structuredClone(f));
      },
      async delete(org, id) {
        if (s().fields.get(id)?.organizationId !== org) return;
        s().fields.delete(id);
        for (const [k, v] of s().fieldValues) if (v.fieldId === id) s().fieldValues.delete(k);
      },
      async valuesForTasks(org, taskIds) {
        return [...s().fieldValues.values()].filter((v) => v.organizationId === org && taskIds.includes(v.taskId)).map((v) => structuredClone(v));
      },
      async valuesForField(org, fieldId) {
        return [...s().fieldValues.values()].filter((v) => v.organizationId === org && v.fieldId === fieldId).map((v) => structuredClone(v));
      },
      async setValue(v) {
        s().fieldValues.set(`${v.taskId}:${v.fieldId}`, structuredClone(v));
      },
      async clearValue(org, taskId, fieldId) {
        return s().fieldValues.delete(`${taskId}:${fieldId}`);
      },
    },
    timeEntries: {
      async findById(org, id) {
        const e = s().timeEntries.get(id);
        return e && e.organizationId === org ? structuredClone(e) : null;
      },
      async list(org, f, limit) {
        return [...s().timeEntries.values()]
          .filter(
            (e) =>
              e.organizationId === org &&
              (!f.userId || e.userId === f.userId) &&
              (!f.projectId || e.projectId === f.projectId) &&
              (!f.taskId || e.taskId === f.taskId) &&
              (f.billable === undefined || e.billable === f.billable) &&
              (!f.from || e.workedOn >= f.from) &&
              (!f.to || e.workedOn <= f.to),
          )
          .sort((a, b) => b.workedOn.localeCompare(a.workedOn) || b.createdAt.getTime() - a.createdAt.getTime())
          .slice(0, limit)
          .map((e) => structuredClone(e));
      },
      async totalsByTask(org, taskIds) {
        const out = new Map<string, number>();
        for (const e of s().timeEntries.values()) {
          if (e.organizationId === org && taskIds.includes(e.taskId)) out.set(e.taskId, (out.get(e.taskId) ?? 0) + e.minutes);
        }
        return out;
      },
      async save(e) {
        s().timeEntries.set(e.id, structuredClone(e));
      },
      async delete(org, id) {
        const e = s().timeEntries.get(id);
        return !!e && e.organizationId === org && s().timeEntries.delete(id);
      },
      async listUnbilled(org, projectId, range) {
        return [...s().timeEntries.values()]
          .filter((e) => e.organizationId === org && e.projectId === projectId && e.billable && !e.billingId && (!range.from || e.workedOn >= range.from) && (!range.to || e.workedOn <= range.to))
          .map((e) => structuredClone(e));
      },
      async findManyForUpdate(org, ids) {
        return [...s().timeEntries.values()].filter((e) => e.organizationId === org && ids.includes(e.id)).map((e) => structuredClone(e));
      },
      async assignBilling(org, ids, billingId) {
        for (const id of ids) {
          const e = s().timeEntries.get(id);
          if (e && e.organizationId === org) e.billingId = billingId;
        }
      },
      async releaseBilling(org, billingId) {
        let n = 0;
        for (const e of s().timeEntries.values()) {
          if (e.organizationId === org && e.billingId === billingId) {
            e.billingId = null;
            n += 1;
          }
        }
        return n;
      },
    },
    timers: {
      async get(org, userId) {
        const t = s().timers.get(`${org}:${userId}`);
        return t ? structuredClone(t) : null;
      },
      async add(t) {
        const key = `${t.organizationId}:${t.userId}`;
        if (s().timers.has(key)) return false;
        s().timers.set(key, structuredClone(t));
        return true;
      },
      async replace(t) {
        s().timers.set(`${t.organizationId}:${t.userId}`, structuredClone(t));
      },
      async remove(org, userId) {
        return s().timers.delete(`${org}:${userId}`);
      },
    },
    capacity: {
      async list(org) {
        return [...s().capacity.values()].filter((c) => c.organizationId === org).map((c) => structuredClone(c));
      },
      async set(c) {
        s().capacity.set(`${c.organizationId}:${c.userId}`, structuredClone(c));
      },
    },
    billing: {
      async getSettings(org, projectId) {
        const b = s().billingSettings.get(projectId);
        return b && b.organizationId === org ? structuredClone(b) : null;
      },
      async saveSettings(b) {
        s().billingSettings.set(b.projectId, structuredClone(b));
      },
      async milestones(org, projectId) {
        return [...s().milestoneAmounts.values()].filter((m) => m.organizationId === org && m.projectId === projectId).map((m) => structuredClone(m));
      },
      async findMilestone(org, taskId) {
        const m = s().milestoneAmounts.get(taskId);
        return m && m.organizationId === org ? structuredClone(m) : null;
      },
      async findMilestonesForUpdate(org, taskIds) {
        return [...s().milestoneAmounts.values()].filter((m) => m.organizationId === org && taskIds.includes(m.taskId)).map((m) => structuredClone(m));
      },
      async saveMilestone(m) {
        s().milestoneAmounts.set(m.taskId, structuredClone(m));
      },
      async deleteMilestone(org, taskId) {
        s().milestoneAmounts.delete(taskId);
      },
      async assignMilestones(org, taskIds, billingId) {
        for (const id of taskIds) {
          const m = s().milestoneAmounts.get(id);
          if (m && m.organizationId === org) m.billingId = billingId;
        }
      },
      async releaseMilestones(org, billingId) {
        let n = 0;
        for (const m of s().milestoneAmounts.values()) {
          if (m.organizationId === org && m.billingId === billingId) {
            m.billingId = null;
            n += 1;
          }
        }
        return n;
      },
      async invoices(org, projectId) {
        return [...s().projectInvoices.values()]
          .filter((i) => i.organizationId === org && i.projectId === projectId)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .map((i) => structuredClone(i));
      },
      async findInvoice(org, id) {
        const i = s().projectInvoices.get(id);
        return i && i.organizationId === org ? structuredClone(i) : null;
      },
      async findByInvoiceId(org, invoiceId) {
        const i = [...s().projectInvoices.values()].find((x) => x.organizationId === org && x.invoiceId === invoiceId);
        return i ? structuredClone(i) : null;
      },
      async saveInvoice(i) {
        s().projectInvoices.set(i.id, structuredClone(i));
      },
    },
    rules: {
      async listByProject(org, projectId) {
        return [...s().rules.values()]
          .filter((r) => r.organizationId === org && r.projectId === projectId)
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .map((r) => structuredClone(r));
      },
      async findById(org, id) {
        const r = s().rules.get(id);
        return r && r.organizationId === org ? structuredClone(r) : null;
      },
      async save(r) {
        s().rules.set(r.id, structuredClone(r));
      },
      async delete(org, id) {
        const r = s().rules.get(id);
        return !!r && r.organizationId === org && s().rules.delete(id);
      },
      async recordRun(org, id, at, error) {
        const r = s().rules.get(id);
        if (r && r.organizationId === org) Object.assign(r, { runCount: r.runCount + 1, lastRunAt: at, lastError: error });
      },
    },
    forms: {
      async listByProject(org, projectId) {
        return [...s().forms.values()].filter((f) => f.organizationId === org && f.projectId === projectId).map((f) => structuredClone(f));
      },
      async findById(org, id) {
        const f = s().forms.get(id);
        return f && f.organizationId === org ? structuredClone(f) : null;
      },
      async save(f) {
        s().forms.set(f.id, structuredClone(f));
      },
      async delete(org, id) {
        const f = s().forms.get(id);
        return !!f && f.organizationId === org && s().forms.delete(id);
      },
      async incrementSubmissions(org, id) {
        const f = s().forms.get(id);
        if (f && f.organizationId === org) f.submissionCount += 1;
      },
    },
    outbox: {
      async add(event) {
        s().outbox.push(structuredClone(event));
      },
    },
  };
}

export class InMemoryStore implements UnitOfWorkGateway {
  state: State = emptyState();
  readonly repos: Repositories = repositories(() => this.state);
  /** Para provocar un fallo a mitad de una transacción en las pruebas. */
  failOnCommit = false;

  async begin(): Promise<WriteUnitOfWork> {
    const working = cloneState(this.state);
    const repos = repositories(() => working);
    return {
      ...repos,
      commit: async () => {
        if (this.failOnCommit) throw new Error('fallo simulado al confirmar');
        this.state = working;
      },
      rollback: async () => {},
    };
  }

  events(type?: string): DomainEvent[] {
    return type ? this.state.outbox.filter((e) => e.type === type) : this.state.outbox;
  }
}

export const ORG = '11111111-1111-4111-8111-111111111111';
export const OTHER_ORG = '22222222-2222-4222-8222-222222222222';
export const ANA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const BETO = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const CARLA = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const BASE = ['project:read', 'project:create'];
export const actor = (userId: string, opts: { org?: string; permissions?: string[] } = {}): Actor => ({
  organizationId: opts.org ?? ORG,
  userId,
  permissions: opts.permissions ?? BASE,
});
export const orgAdmin = (userId: string) => actor(userId, { permissions: [...BASE, 'project:admin'] });
export const readOnly = (userId: string) => actor(userId, { permissions: ['project:read'] });
/** Quien administra las etiquetas de la organización (permiso `project_tag:manage`). */
export const tagAdmin = (userId: string) => actor(userId, { permissions: [...BASE, 'project_tag:manage'] });

export function setup() {
  const store = new InMemoryStore();
  let n = 0;
  // Ids de verdad (uuid v4 con forma válida) y deterministas: las rutas HTTP validan el formato.
  const ids = () => {
    n += 1;
    return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  };
  let now = new Date('2026-11-04T15:00:00Z');
  const clock = () => new Date(now);
  const advance = (ms: number) => {
    now = new Date(now.getTime() + ms);
  };
  const tasks = new TaskUseCases(store, store.repos, clock, ids);
  const organize = new OrganizeUseCases(store, store.repos, clock, ids);
  const collaboration = new CollaborationUseCases(store, clock, ids);
  const automation = new AutomationUseCases(store, store.repos, tasks, organize, collaboration, clock, ids);
  tasks.setRuleRunner((actor, events) => automation.run(actor, events));
  const useCases = {
    projects: new ProjectUseCases(store, store.repos, clock, ids),
    members: new MemberUseCases(store, store.repos, clock),
    sections: new SectionUseCases(store, clock, ids),
    tasks,
    collaboration,
    timeline: new TimelineUseCases(store, store.repos, clock, ids),
    organize,
    workspace: new WorkspaceUseCases(store, store.repos, tasks, organize, clock, ids),
    time: new TimeUseCases(store, store.repos, clock, ids),
    workload: new WorkloadUseCases(store, store.repos, clock),
    billing: new BillingUseCases(store, store.repos, clock, ids),
    automation,
    dashboard: new DashboardUseCases(tasks, clock),
  };
  const dueSoon = new DueSoonUseCase(store, store.repos, clock, 'America/Guayaquil');
  const app = createApp({ useCases, corsOrigin: '*' }, { log: false });
  const setNow = (iso: string) => {
    now = new Date(iso);
  };
  return { store, useCases, app, advance, setNow, dueSoon };
}

/** Proyecto listo con tres secciones. */
export async function projectWithSections(
  uc: ReturnType<typeof setup>['useCases'],
  owner: Actor,
  visibility: Project['visibility'] = 'organization',
) {
  const { project } = await uc.projects.create(owner, { name: 'Lanzamiento', visibility, sectionNames: ['Por hacer', 'En curso', 'Hecho'] });
  const board = await uc.tasks.board(owner, project.id);
  return { project, sections: board.sections };
}
