import { type Context, Hono } from 'hono';
import type { CollaborationUseCases } from '../../application/use-cases/collaboration-use-cases.js';
import type { MemberUseCases } from '../../application/use-cases/member-use-cases.js';
import type { ProjectUseCases } from '../../application/use-cases/project-use-cases.js';
import type { SectionUseCases } from '../../application/use-cases/section-use-cases.js';
import type { TaskUseCases } from '../../application/use-cases/task-use-cases.js';
import type { TimelineUseCases } from '../../application/use-cases/timeline-use-cases.js';
import type { OrganizeUseCases } from '../../application/use-cases/organize-use-cases.js';
import type { WorkspaceUseCases } from '../../application/use-cases/workspace-use-cases.js';
import type { TimeUseCases } from '../../application/use-cases/time-use-cases.js';
import type { WorkloadUseCases } from '../../application/use-cases/workload-use-cases.js';
import type { BillingUseCases } from '../../application/use-cases/billing-use-cases.js';
import { FormNotFoundError, RuleNotFoundError, type AutomationUseCases } from '../../application/use-cases/automation-use-cases.js';
import type { DashboardUseCases } from '../../application/use-cases/dashboard-use-cases.js';
import { LINK_ENTITIES, type LinkEntity } from '../../domain/types.js';
import { PERMISSION_READ } from '../../domain/access.js';
import {
  AttachmentNotFoundError,
  CommentNotFoundError,
  MemberNotFoundError,
  ProjectNotFoundError,
  SectionNotFoundError,
  TaskNotFoundError,
  TimeEntryNotFoundError,
  ProjectInvoiceNotFoundError,
  ValidationError,
} from '../../domain/errors.js';
import type { Actor } from '../../domain/types.js';
import { type ContextVariables, requireOrganization, requirePermission, requireUser } from './middlewares.js';
import {
  attachmentDto,
  boardDto,
  commentDto,
  dependencyDto,
  fieldDto,
  linkDto,
  memberDto,
  myTaskDto,
  placementDto,
  projectDetailDto,
  projectDto,
  projectWithRoleDto,
  sectionDto,
  statusUpdateDto,
  tagDto,
  taskDetailDto,
  taskDto,
  timeEntryDto,
  timeReportDto,
  timerDto,
  billingPreviewDto,
  billingSettingsDto,
  billingSummaryDto,
  projectInvoiceDto,
  formDto,
  publicFormDto,
  ruleDto,
} from './serializers.js';
import {
  addMemberSchema,
  attachmentSchema,
  bulkSchema,
  createFieldSchema,
  duplicateSchema,
  fieldValueSchema,
  fromTemplateSchema,
  linkSchema,
  tagSchema,
  taskTagSchema,
  updateTagSchema,
  updateFieldSchema,
  commentSchema,
  createProjectSchema,
  decisionSchema,
  dependencySchema,
  followerSchema,
  createSectionSchema,
  createTaskSchema,
  isUuid,
  moveSectionSchema,
  moveTaskSchema,
  parseBody,
  renameSectionSchema,
  statusUpdateSchema,
  updateMemberSchema,
  updateProjectSchema,
  updateTaskSchema,
  capacitySchema,
  logTimeSchema,
  startTimerSchema,
  stopTimerSchema,
  updateTimeSchema,
  attachInvoiceSchema,
  billingCriteriaSchema,
  billingSettingsSchema,
  milestoneAmountSchema,
  formSchema,
  ruleSchema,
  submitFormSchema,
} from './validators.js';

export interface AppDependencies {
  useCases: {
    projects: ProjectUseCases;
    members: MemberUseCases;
    sections: SectionUseCases;
    tasks: TaskUseCases;
    collaboration: CollaborationUseCases;
    timeline: TimelineUseCases;
    organize: OrganizeUseCases;
    workspace: WorkspaceUseCases;
    time: TimeUseCases;
    workload: WorkloadUseCases;
    billing: BillingUseCases;
    automation: AutomationUseCases;
    dashboard: DashboardUseCases;
  };
  corsOrigin: string;
}

type Env = { Variables: ContextVariables };

function actorOf(c: Context<Env>): Actor {
  return { organizationId: c.get('organizationId'), userId: c.get('userId'), permissions: c.get('permissions') ?? [] };
}

/** Un id de ruta que no es uuid es lo mismo que uno que no existe: 404, sin preguntar a la base. */
function param(c: Context<Env>, name: string, NotFound: new () => Error): string {
  const value = c.req.param(name);
  if (!isUuid(value)) throw new NotFound();
  return value;
}

export function healthRoutes(): Hono {
  const r = new Hono();
  r.get('/health', (c) => c.json({ status: 'ok', service: 'projects-service' }));
  return r;
}

/**
 * Todas las rutas cuelgan de `/projects` (el gateway las cubre con `ANY /projects/*`, plugin `projects.tasks_kanban` y permiso
 * `project:read`, que aquí se vuelve a exigir). Lo demás lo decide el rol dentro de cada proyecto (ver `domain/access.ts`).
 *
 * Las rutas fijas (`/projects/my-tasks`, `/projects/tasks/...`) se registran ANTES que `/projects/:id`: si no, `my-tasks` se
 * tomaría por el id de un proyecto.
 */
export function projectRoutes(deps: AppDependencies): Hono<Env> {
  const { projects, members, sections, tasks, collaboration, timeline, organize, workspace, time, workload, billing, automation, dashboard } = deps.useCases;
  const r = new Hono<Env>();
  r.use('/projects', requireOrganization(), requireUser(), requirePermission(PERMISSION_READ));
  r.use('/projects/*', requireOrganization(), requireUser(), requirePermission(PERMISSION_READ));

  // ── Mis tareas y tareas ───────────────────────────────────────────────────
  r.get('/projects/my-tasks', async (c) => {
    const items = await tasks.myTasks(actorOf(c), c.req.query('includeCompleted') === 'true');
    return c.json({ items: items.map(myTaskDto) });
  });

  // ── Reglas y formularios (entregable 7; rutas fijas: antes de `/projects/:projectId`) ──
  r.get('/projects/forms/:formId', async (c) => c.json(publicFormDto(await automation.publicForm(actorOf(c), param(c, 'formId', FormNotFoundError)))));

  r.post('/projects/forms/:formId/submit', async (c) => {
    const id = param(c, 'formId', FormNotFoundError);
    return c.json(await automation.submit(actorOf(c), id, await parseBody(c, submitFormSchema)), 201);
  });

  r.patch('/projects/forms/:formId', async (c) => {
    const id = param(c, 'formId', FormNotFoundError);
    return c.json(formDto(await automation.updateForm(actorOf(c), id, await parseBody(c, formSchema))));
  });

  r.delete('/projects/forms/:formId', async (c) => {
    await automation.deleteForm(actorOf(c), param(c, 'formId', FormNotFoundError));
    return c.body(null, 204);
  });

  r.patch('/projects/rules/:ruleId', async (c) => {
    const id = param(c, 'ruleId', RuleNotFoundError);
    return c.json(ruleDto(await automation.updateRule(actorOf(c), id, await parseBody(c, ruleSchema))));
  });

  r.delete('/projects/rules/:ruleId', async (c) => {
    await automation.deleteRule(actorOf(c), param(c, 'ruleId', RuleNotFoundError));
    return c.body(null, 204);
  });

  r.get('/projects/:projectId/rules', async (c) =>
    c.json({ items: (await automation.listRules(actorOf(c), param(c, 'projectId', ProjectNotFoundError))).map(ruleDto) }),
  );

  r.post('/projects/:projectId/rules', async (c) => {
    const id = param(c, 'projectId', ProjectNotFoundError);
    return c.json(ruleDto(await automation.createRule(actorOf(c), id, await parseBody(c, ruleSchema))), 201);
  });

  r.get('/projects/:projectId/forms', async (c) =>
    c.json({ items: (await automation.listForms(actorOf(c), param(c, 'projectId', ProjectNotFoundError))).map(formDto) }),
  );

  r.post('/projects/:projectId/forms', async (c) => {
    const id = param(c, 'projectId', ProjectNotFoundError);
    return c.json(formDto(await automation.createForm(actorOf(c), id, await parseBody(c, formSchema))), 201);
  });

  r.get('/projects/:projectId/dashboard', async (c) => c.json(await dashboard.dashboard(actorOf(c), param(c, 'projectId', ProjectNotFoundError))));

  // ── Facturar el proyecto (entregable 6; rutas fijas: antes de `/projects/:projectId`) ──
  r.post('/projects/billing/invoices/:billingId/attach', async (c) => {
    const id = param(c, 'billingId', ProjectInvoiceNotFoundError);
    const { invoiceId } = await parseBody(c, attachInvoiceSchema);
    return c.json(projectInvoiceDto(await billing.attach(actorOf(c), id, invoiceId)));
  });

  r.post('/projects/billing/invoices/:billingId/release', async (c) =>
    c.json(projectInvoiceDto(await billing.release(actorOf(c), param(c, 'billingId', ProjectInvoiceNotFoundError)))),
  );

  r.get('/projects/billing/:projectId', async (c) => c.json(billingSummaryDto(await billing.summary(actorOf(c), param(c, 'projectId', ProjectNotFoundError)))));

  r.put('/projects/billing/:projectId/settings', async (c) => {
    const id = param(c, 'projectId', ProjectNotFoundError);
    const input = await parseBody(c, billingSettingsSchema);
    return c.json(billingSettingsDto(await billing.saveSettings(actorOf(c), id, { ...input, customerLabel: input.customerLabel ?? null, serviceProductLabel: input.serviceProductLabel ?? null })));
  });

  r.put('/projects/billing/:projectId/milestones/:taskId', async (c) => {
    const id = param(c, 'projectId', ProjectNotFoundError);
    const taskId = param(c, 'taskId', TaskNotFoundError);
    const { amountCents } = await parseBody(c, milestoneAmountSchema);
    const saved = await billing.setMilestoneAmount(actorOf(c), id, taskId, amountCents);
    return c.json({ taskId, amountCents: saved?.amountCents ?? null });
  });

  r.post('/projects/billing/:projectId/preview', async (c) => {
    const id = param(c, 'projectId', ProjectNotFoundError);
    return c.json(billingPreviewDto(await billing.preview(actorOf(c), id, await parseBody(c, billingCriteriaSchema))));
  });

  r.post('/projects/billing/:projectId/reserve', async (c) => {
    const id = param(c, 'projectId', ProjectNotFoundError);
    const { invoice, preview, settings } = await billing.reserve(actorOf(c), id, await parseBody(c, billingCriteriaSchema));
    return c.json({ invoice: projectInvoiceDto(invoice), preview: billingPreviewDto(preview), settings: billingSettingsDto(settings) }, 201);
  });

  // ── Horas y carga de trabajo (rutas fijas: antes de `/projects/:projectId`; el cronómetro antes de `/time-entries/:entryId`) ──
  r.get('/projects/time-entries/timer', async (c) => c.json(timerDto(await time.currentTimer(actorOf(c)))));

  r.post('/projects/time-entries/timer', async (c) => {
    const { taskId, projectId, previousWorkedOn } = await parseBody(c, startTimerSchema);
    const { timer, stopped } = await time.startTimer(actorOf(c), taskId, { projectId, previousWorkedOn });
    return c.json({ ...timerDto(timer), stopped: stopped ? timeEntryDto(stopped) : null }, 201);
  });

  r.post('/projects/time-entries/timer/stop', async (c) => c.json(timeEntryDto(await time.stopTimer(actorOf(c), await parseBody(c, stopTimerSchema))), 201));

  r.delete('/projects/time-entries/timer', async (c) => {
    await time.discardTimer(actorOf(c));
    return c.body(null, 204);
  });

  r.get('/projects/time-entries', async (c) => {
    const q = (name: string) => c.req.query(name) || undefined;
    const isDate = (v: string | undefined) => (v && !/^\d{4}-\d{2}-\d{2}$/.test(v) ? undefined : v);
    const billable = q('billable');
    const report = await time.report(actorOf(c), {
      userId: q('userId'),
      projectId: q('projectId'),
      taskId: q('taskId'),
      from: isDate(q('from')),
      to: isDate(q('to')),
      billable: billable === 'true' ? true : billable === 'false' ? false : undefined,
    });
    return c.json(timeReportDto(report));
  });

  r.post('/projects/time-entries', async (c) => c.json(timeEntryDto(await time.log(actorOf(c), await parseBody(c, logTimeSchema))), 201));

  r.patch('/projects/time-entries/:entryId', async (c) => {
    const id = param(c, 'entryId', TimeEntryNotFoundError);
    return c.json(timeEntryDto(await time.update(actorOf(c), id, await parseBody(c, updateTimeSchema))));
  });

  r.delete('/projects/time-entries/:entryId', async (c) => {
    await time.remove(actorOf(c), param(c, 'entryId', TimeEntryNotFoundError));
    return c.body(null, 204);
  });

  r.get('/projects/workload', async (c) => {
    const from = c.req.query('from');
    const weeks = Number(c.req.query('weeks') ?? 4);
    const projectId = c.req.query('projectId') || undefined;
    if (!from || !/^\d{4}-\d{2}-\d{2}$/.test(from)) throw new ValidationError([{ field: 'from', message: 'Fecha AAAA-MM-DD.' }]);
    return c.json(await workload.workload(actorOf(c), { from, weeks, projectId }));
  });

  r.put('/projects/workload/capacity/:userId', async (c) => {
    const userId = param(c, 'userId', MemberNotFoundError);
    const { weeklyMinutes } = await parseBody(c, capacitySchema);
    const saved = await workload.setCapacity(actorOf(c), userId, weeklyMinutes);
    return c.json({ userId: saved.userId, weeklyMinutes: saved.weeklyMinutes });
  });

  // ── Buscar, lote, plantillas, etiquetas y vínculos (rutas fijas: antes de `/projects/:projectId`) ──
  r.get('/projects/search', async (c) => {
    const result = await workspace.search(actorOf(c), c.req.query('q') ?? '');
    return c.json({
      tasks: result.tasks.map((r) => ({ ...taskDto(r.task), projects: r.projects })),
      projects: result.projects.map(projectDto),
    });
  });

  r.post('/projects/tasks/bulk', async (c) => {
    const { taskIds, action } = await parseBody(c, bulkSchema);
    return c.json({ results: await workspace.bulk(actorOf(c), taskIds, action) });
  });

  r.get('/projects/templates', (c) => {
    const locale = c.req.query('locale');
    return c.json({ items: workspace.listTemplates(locale === 'en' || locale === 'fr' ? locale : 'es') });
  });

  r.post('/projects/from-template', async (c) => {
    return c.json(projectDto(await workspace.createFromTemplate(actorOf(c), await parseBody(c, fromTemplateSchema))), 201);
  });

  r.get('/projects/tags', async (c) => c.json({ items: (await organize.listTags(actorOf(c))).map((t) => ({ ...tagDto(t), taskCount: t.taskCount })) }));

  r.post('/projects/tags', async (c) => c.json(tagDto(await organize.createTag(actorOf(c), await parseBody(c, tagSchema))), 201));

  r.patch('/projects/tags/:tagId', async (c) => {
    const id = param(c, 'tagId', TaskNotFoundError);
    return c.json(tagDto(await organize.updateTag(actorOf(c), id, await parseBody(c, updateTagSchema))));
  });

  r.delete('/projects/tags/:tagId', async (c) => c.json(await organize.deleteTag(actorOf(c), param(c, 'tagId', TaskNotFoundError))));

  r.get('/projects/linked/:entityType/:entityId', async (c) => {
    const type = c.req.param('entityType') as LinkEntity;
    if (!LINK_ENTITIES.includes(type)) throw new ProjectNotFoundError();
    const items = await organize.linkedTasks(actorOf(c), type, param(c, 'entityId', TaskNotFoundError));
    return c.json({ items: items.map(taskDto) });
  });

  r.post('/projects/tasks/:taskId/links', async (c) => {
    const id = param(c, 'taskId', TaskNotFoundError);
    return c.json(linkDto(await organize.addLink(actorOf(c), id, await parseBody(c, linkSchema))), 201);
  });

  r.delete('/projects/links/:linkId', async (c) => {
    await organize.removeLink(actorOf(c), param(c, 'linkId', TaskNotFoundError));
    return c.body(null, 204);
  });

  r.post('/projects/tasks/:taskId/tags', async (c) => {
    const id = param(c, 'taskId', TaskNotFoundError);
    const { tagId } = await parseBody(c, taskTagSchema);
    return c.json({ items: (await organize.setTag(actorOf(c), id, tagId, true)).map(tagDto) });
  });

  r.delete('/projects/tasks/:taskId/tags/:tagId', async (c) => {
    const items = await organize.setTag(actorOf(c), param(c, 'taskId', TaskNotFoundError), param(c, 'tagId', TaskNotFoundError), false);
    return c.json({ items: items.map(tagDto) });
  });

  r.put('/projects/tasks/:taskId/fields/:fieldId', async (c) => {
    const id = param(c, 'taskId', TaskNotFoundError);
    const fieldId = param(c, 'fieldId', TaskNotFoundError);
    const { value } = await parseBody(c, fieldValueSchema);
    return c.json({ value: await organize.setFieldValue(actorOf(c), id, fieldId, value) });
  });

  r.patch('/projects/fields/:fieldId', async (c) => {
    const id = param(c, 'fieldId', TaskNotFoundError);
    return c.json(fieldDto(await organize.updateField(actorOf(c), id, await parseBody(c, updateFieldSchema))));
  });

  r.delete('/projects/fields/:fieldId', async (c) => {
    await organize.deleteField(actorOf(c), param(c, 'fieldId', TaskNotFoundError));
    return c.body(null, 204);
  });

  r.post('/projects/tasks', async (c) => {
    const task = await tasks.create(actorOf(c), await parseBody(c, createTaskSchema));
    return c.json(taskDto(task), 201);
  });

  r.get('/projects/tasks/:taskId', async (c) => {
    return c.json(taskDetailDto(await tasks.get(actorOf(c), param(c, 'taskId', TaskNotFoundError))));
  });

  r.patch('/projects/tasks/:taskId', async (c) => {
    const id = param(c, 'taskId', TaskNotFoundError);
    return c.json(taskDto(await tasks.update(actorOf(c), id, await parseBody(c, updateTaskSchema))));
  });

  r.delete('/projects/tasks/:taskId', async (c) => {
    await tasks.delete(actorOf(c), param(c, 'taskId', TaskNotFoundError));
    return c.body(null, 204);
  });

  r.post('/projects/tasks/:taskId/move', async (c) => {
    const id = param(c, 'taskId', TaskNotFoundError);
    const { task, placement } = await tasks.move(actorOf(c), id, await parseBody(c, moveTaskSchema));
    return c.json({ ...taskDto(task), placement: placementDto(placement) });
  });

  r.post('/projects/tasks/:taskId/complete', async (c) => {
    return c.json(taskDto(await tasks.complete(actorOf(c), param(c, 'taskId', TaskNotFoundError))));
  });

  r.post('/projects/tasks/:taskId/reopen', async (c) => {
    return c.json(taskDto(await tasks.reopen(actorOf(c), param(c, 'taskId', TaskNotFoundError))));
  });

  r.post('/projects/tasks/:taskId/approval', async (c) => {
    const id = param(c, 'taskId', TaskNotFoundError);
    const { decision } = await parseBody(c, decisionSchema);
    return c.json(taskDto(await tasks.decide(actorOf(c), id, decision)));
  });

  // ── Colaboración: comentarios, seguidores, «me gusta», adjuntos ───────────
  r.post('/projects/tasks/:taskId/comments', async (c) => {
    const id = param(c, 'taskId', TaskNotFoundError);
    const { bodyDoc } = await parseBody(c, commentSchema);
    return c.json(commentDto(await collaboration.addComment(actorOf(c), id, bodyDoc)), 201);
  });

  r.patch('/projects/comments/:commentId', async (c) => {
    const id = param(c, 'commentId', CommentNotFoundError);
    const { bodyDoc } = await parseBody(c, commentSchema);
    return c.json(commentDto(await collaboration.editComment(actorOf(c), id, bodyDoc)));
  });

  r.delete('/projects/comments/:commentId', async (c) => {
    await collaboration.deleteComment(actorOf(c), param(c, 'commentId', CommentNotFoundError));
    return c.body(null, 204);
  });

  r.post('/projects/comments/:commentId/like', async (c) => {
    return c.json({ likedBy: await collaboration.setLike(actorOf(c), 'comment', param(c, 'commentId', CommentNotFoundError), true) });
  });

  r.delete('/projects/comments/:commentId/like', async (c) => {
    return c.json({ likedBy: await collaboration.setLike(actorOf(c), 'comment', param(c, 'commentId', CommentNotFoundError), false) });
  });

  r.post('/projects/tasks/:taskId/like', async (c) => {
    return c.json({ likedBy: await collaboration.setLike(actorOf(c), 'task', param(c, 'taskId', TaskNotFoundError), true) });
  });

  r.delete('/projects/tasks/:taskId/like', async (c) => {
    return c.json({ likedBy: await collaboration.setLike(actorOf(c), 'task', param(c, 'taskId', TaskNotFoundError), false) });
  });

  r.post('/projects/tasks/:taskId/followers', async (c) => {
    const id = param(c, 'taskId', TaskNotFoundError);
    const { userId } = await parseBody(c, followerSchema);
    return c.json({ followers: await collaboration.addFollower(actorOf(c), id, userId) });
  });

  r.delete('/projects/tasks/:taskId/followers/:userId', async (c) => {
    const id = param(c, 'taskId', TaskNotFoundError);
    const userId = param(c, 'userId', TaskNotFoundError);
    return c.json({ followers: await collaboration.removeFollower(actorOf(c), id, userId) });
  });

  r.post('/projects/tasks/:taskId/attachments', async (c) => {
    const id = param(c, 'taskId', TaskNotFoundError);
    return c.json(attachmentDto(await collaboration.addAttachment(actorOf(c), id, await parseBody(c, attachmentSchema))), 201);
  });

  r.delete('/projects/attachments/:attachmentId', async (c) => {
    await collaboration.removeAttachment(actorOf(c), param(c, 'attachmentId', AttachmentNotFoundError));
    return c.body(null, 204);
  });

  // ── Cronograma: dependencias (fin → inicio) ───────────────────────────────
  r.post('/projects/tasks/:taskId/dependencies', async (c) => {
    const id = param(c, 'taskId', TaskNotFoundError);
    const { dependsOnTaskId } = await parseBody(c, dependencySchema);
    return c.json(dependencyDto(await timeline.addDependency(actorOf(c), id, dependsOnTaskId)), 201);
  });

  r.delete('/projects/tasks/:taskId/dependencies/:dependsOnTaskId', async (c) => {
    await timeline.removeDependency(actorOf(c), param(c, 'taskId', TaskNotFoundError), param(c, 'dependsOnTaskId', TaskNotFoundError));
    return c.body(null, 204);
  });

  // ── Proyectos ─────────────────────────────────────────────────────────────
  r.get('/projects', async (c) => {
    const status = c.req.query('status') === 'archived' ? 'archived' : 'active';
    const items = await projects.list(actorOf(c), status);
    return c.json({ items: items.map(projectWithRoleDto) });
  });

  r.post('/projects', async (c) => {
    return c.json(projectDetailDto(await projects.create(actorOf(c), await parseBody(c, createProjectSchema))), 201);
  });

  r.get('/projects/:projectId', async (c) => {
    return c.json(projectDetailDto(await projects.get(actorOf(c), param(c, 'projectId', ProjectNotFoundError))));
  });

  r.patch('/projects/:projectId', async (c) => {
    const id = param(c, 'projectId', ProjectNotFoundError);
    return c.json(projectDto(await projects.update(actorOf(c), id, await parseBody(c, updateProjectSchema))));
  });

  r.delete('/projects/:projectId', async (c) => {
    await projects.delete(actorOf(c), param(c, 'projectId', ProjectNotFoundError));
    return c.body(null, 204);
  });

  r.post('/projects/:projectId/archive', async (c) => {
    return c.json(projectDto(await projects.archive(actorOf(c), param(c, 'projectId', ProjectNotFoundError))));
  });

  r.post('/projects/:projectId/unarchive', async (c) => {
    return c.json(projectDto(await projects.unarchive(actorOf(c), param(c, 'projectId', ProjectNotFoundError))));
  });

  r.get('/projects/:projectId/tasks', async (c) => {
    return c.json(boardDto(await tasks.board(actorOf(c), param(c, 'projectId', ProjectNotFoundError))));
  });

  r.post('/projects/:projectId/duplicate', async (c) => {
    const id = param(c, 'projectId', ProjectNotFoundError);
    return c.json(projectDto(await workspace.duplicate(actorOf(c), id, await parseBody(c, duplicateSchema))), 201);
  });

  r.get('/projects/:projectId/fields', async (c) => {
    const id = param(c, 'projectId', ProjectNotFoundError);
    return c.json({ items: (await organize.listFields(actorOf(c), id)).map(fieldDto) });
  });

  r.post('/projects/:projectId/fields', async (c) => {
    const id = param(c, 'projectId', ProjectNotFoundError);
    return c.json(fieldDto(await organize.createField(actorOf(c), id, await parseBody(c, createFieldSchema))), 201);
  });

  // ── Estado del proyecto ───────────────────────────────────────────────────
  r.get('/projects/:projectId/status-updates', async (c) => {
    const id = param(c, 'projectId', ProjectNotFoundError);
    const limit = c.req.query('limit') ? Number(c.req.query('limit')) : 20;
    return c.json({ items: (await timeline.listStatusUpdates(actorOf(c), id, limit)).map(statusUpdateDto) });
  });

  r.post('/projects/:projectId/status-updates', async (c) => {
    const id = param(c, 'projectId', ProjectNotFoundError);
    return c.json(statusUpdateDto(await timeline.postStatusUpdate(actorOf(c), id, await parseBody(c, statusUpdateSchema))), 201);
  });

  // ── Miembros ──────────────────────────────────────────────────────────────
  r.get('/projects/:projectId/members', async (c) => {
    const list = await members.list(actorOf(c), param(c, 'projectId', ProjectNotFoundError));
    return c.json({ items: list.map(memberDto) });
  });

  r.post('/projects/:projectId/members', async (c) => {
    const id = param(c, 'projectId', ProjectNotFoundError);
    return c.json(memberDto(await members.add(actorOf(c), id, await parseBody(c, addMemberSchema))), 201);
  });

  r.patch('/projects/:projectId/members/:userId', async (c) => {
    const id = param(c, 'projectId', ProjectNotFoundError);
    const userId = param(c, 'userId', MemberNotFoundError);
    const { role } = await parseBody(c, updateMemberSchema);
    return c.json(memberDto(await members.updateRole(actorOf(c), id, userId, role)));
  });

  r.delete('/projects/:projectId/members/:userId', async (c) => {
    await members.remove(actorOf(c), param(c, 'projectId', ProjectNotFoundError), param(c, 'userId', MemberNotFoundError));
    return c.body(null, 204);
  });

  // ── Secciones ─────────────────────────────────────────────────────────────
  r.post('/projects/:projectId/sections', async (c) => {
    const id = param(c, 'projectId', ProjectNotFoundError);
    return c.json(sectionDto(await sections.create(actorOf(c), id, await parseBody(c, createSectionSchema))), 201);
  });

  r.patch('/projects/:projectId/sections/:sectionId', async (c) => {
    const id = param(c, 'projectId', ProjectNotFoundError);
    const sectionId = param(c, 'sectionId', SectionNotFoundError);
    const { name } = await parseBody(c, renameSectionSchema);
    return c.json(sectionDto(await sections.rename(actorOf(c), id, sectionId, name)));
  });

  r.post('/projects/:projectId/sections/:sectionId/move', async (c) => {
    const id = param(c, 'projectId', ProjectNotFoundError);
    const sectionId = param(c, 'sectionId', SectionNotFoundError);
    return c.json(sectionDto(await sections.move(actorOf(c), id, sectionId, await parseBody(c, moveSectionSchema))));
  });

  r.delete('/projects/:projectId/sections/:sectionId', async (c) => {
    const id = param(c, 'projectId', ProjectNotFoundError);
    const sectionId = param(c, 'sectionId', SectionNotFoundError);
    const moveTo = c.req.query('moveTasksTo');
    await sections.delete(actorOf(c), id, sectionId, isUuid(moveTo) ? moveTo : null);
    return c.body(null, 204);
  });

  return r;
}
