import { col, fn, Op, QueryTypes, type Transaction, UniqueConstraintError } from 'sequelize';
import { withActor } from '@facturero/outbox-relay';
import { currentOrigin } from '../../application/origin.js';
import { sequelize } from './sequelize.js';
import {
  ActivityModel,
  AttachmentModel,
  CommentModel,
  CustomFieldModel,
  CustomFieldValueModel,
  DependencyModel,
  FollowerModel,
  LikeModel,
  MemberCapacityModel,
  MilestoneAmountModel,
  ProjectBillingModel,
  ProjectFormModel,
  ProjectRuleModel,
  ProjectInvoiceModel,
  OutboxModel,
  ProjectMemberModel,
  ProjectModel,
  RunningTimerModel,
  SectionModel,
  StatusUpdateModel,
  TagModel,
  TaskLinkModel,
  TaskModel,
  TaskTagModel,
  TaskPlacementModel,
  TimeEntryModel,
} from './models.js';
import type {
  ActivityRepository,
  AttachmentRepository,
  BillingRepository,
  CapacityRepository,
  FormRepository,
  RuleRepository,
  CommentRepository,
  DependencyRepository,
  DomainEvent,
  FieldRepository,
  LinkRepository,
  FollowerRepository,
  LikeRepository,
  MemberRepository,
  ReminderRepository,
  StatusUpdateRepository,
  TagRepository,
  OutboxRepository,
  PlacementRepository,
  ProjectRepository,
  ProjectTaskStats,
  Repositories,
  SectionRepository,
  SubtaskCount,
  TaskRepository,
  TimeEntryFilter,
  TimeEntryRepository,
  TimerRepository,
} from '../../domain/repositories.js';
import type {
  Activity,
  Attachment,
  Comment,
  CustomField,
  CustomFieldValue,
  Dependency,
  FieldOption,
  MemberCapacity,
  MilestoneAmount,
  Project,
  ProjectBilling,
  ProjectInvoice,
  ProjectColor,
  ProjectMember,
  RunningTimer,
  Section,
  StatusUpdate,
  Tag,
  Task,
  TaskLink,
  TaskPlacement,
  TimeEntry,
} from '../../domain/types.js';
import type { UnitOfWorkGateway, WriteUnitOfWork } from '../../application/ports.js';
import type { FormQuestion, ProjectForm, ProjectRule, RuleAction } from '../../domain/automation.js';

/**
 * Repositorios de MySQL. Reglas que vigila `persistence-guard.test.ts`:
 *   - Guardar es `findByPk` + `update`/`create`, nunca `upsert` (el ON DUPLICATE KEY de MySQL reacciona a cualquier índice único).
 *   - Las lecturas `…ForUpdate` usan `lock: tx.LOCK.UPDATE`: sin el bloqueo, dos movimientos de la misma tarjeta leerían la misma
 *     versión y ninguno daría 409.
 */

// ── Mappers ─────────────────────────────────────────────────────────────────

const toProject = (m: ProjectModel): Project => ({
  id: m.id,
  organizationId: m.organization_id,
  name: m.name,
  description: m.description,
  color: m.color as ProjectColor,
  icon: m.icon,
  visibility: m.visibility,
  ownerUserId: m.owner_user_id,
  status: m.status,
  defaultView: m.default_view,
  version: Number(m.version),
  createdBy: m.created_by,
  createdAt: m.created_at,
  updatedAt: m.updated_at,
  deletedAt: m.deleted_at,
});

const toMember = (m: ProjectMemberModel): ProjectMember => ({
  projectId: m.project_id,
  organizationId: m.organization_id,
  userId: m.user_id,
  role: m.role,
  createdAt: m.created_at,
});

const toSection = (m: SectionModel): Section => ({
  id: m.id,
  organizationId: m.organization_id,
  projectId: m.project_id,
  name: m.name,
  rank: m.rank,
  createdAt: m.created_at,
  updatedAt: m.updated_at,
});

/** MySQL devuelve JSON ya parseado con mysql2; si llegara como texto (otro driver o una versión vieja), se parsea aquí. */
function json<T>(value: unknown): T {
  return (typeof value === 'string' ? JSON.parse(value) : value) as T;
}

const toTask = (m: TaskModel): Task => ({
  id: m.id,
  organizationId: m.organization_id,
  parentTaskId: m.parent_task_id,
  kind: m.kind ?? 'task',
  approvalStatus: m.approval_status ?? null,
  title: m.title,
  description: m.description,
  descriptionDoc: m.description_doc ? json<Record<string, unknown>>(m.description_doc) : null,
  assigneeUserId: m.assignee_user_id,
  assignedAt: m.assigned_at,
  startOn: m.start_on,
  dueOn: m.due_on,
  estimatedMinutes: m.estimated_minutes === null || m.estimated_minutes === undefined ? null : Number(m.estimated_minutes),
  completedAt: m.completed_at,
  completedBy: m.completed_by,
  subtaskRank: m.subtask_rank,
  createdBy: m.created_by,
  version: Number(m.version),
  createdAt: m.created_at,
  updatedAt: m.updated_at,
  deletedAt: m.deleted_at,
});

const toPlacement = (m: TaskPlacementModel): TaskPlacement => ({
  taskId: m.task_id,
  projectId: m.project_id,
  organizationId: m.organization_id,
  sectionId: m.section_id,
  rank: m.rank,
  createdAt: m.created_at,
});

// ── Repositorios ────────────────────────────────────────────────────────────

function projectRepository(tx?: Transaction): ProjectRepository {
  return {
    async findById(organizationId, id) {
      const m = await ProjectModel.findOne({ where: { id, organization_id: organizationId }, transaction: tx });
      return m ? toProject(m) : null;
    },
    async findByIdForUpdate(organizationId, id) {
      const m = await ProjectModel.findOne({
        where: { id, organization_id: organizationId },
        transaction: tx,
        ...(tx ? { lock: tx.LOCK.UPDATE } : {}),
      });
      return m ? toProject(m) : null;
    },
    async listByIds(organizationId, ids) {
      if (ids.length === 0) return [];
      const rows = await ProjectModel.findAll({
        where: { organization_id: organizationId, id: { [Op.in]: [...new Set(ids)] }, deleted_at: null },
        transaction: tx,
      });
      return rows.map(toProject);
    },
    async listVisible(organizationId, userId, { status, allPrivate }) {
      const where = {
        organization_id: organizationId,
        status,
        deleted_at: null,
        ...(allPrivate
          ? {}
          : {
              [Op.or]: [
                { visibility: 'organization' },
                // Privados donde es miembro: subconsulta para no traer a memoria los privados ajenos.
                {
                  id: {
                    [Op.in]: sequelize.literal(
                      `(SELECT pm.project_id FROM project_members pm WHERE pm.organization_id = ${sequelize.escape(organizationId)} AND pm.user_id = ${sequelize.escape(userId)})`,
                    ),
                  },
                },
              ],
            }),
      };
      const rows = await ProjectModel.findAll({ where, transaction: tx });
      return rows.map(toProject);
    },
    async statsByProjects(organizationId, projectIds, today) {
      const out = new Map<string, ProjectTaskStats>();
      if (projectIds.length === 0) return out;
      // DATE_FORMAT y no la fecha tal cual: en una consulta cruda mysql2 devuelve un DATE como Date a medianoche LOCAL del
      // proceso, y en un servidor en UTC eso corría el día. Como texto `YYYY-MM-DD` llega igual que el resto de fechas de la API.
      const rows = (await sequelize.query(
        `SELECT p.project_id AS projectId,
                COUNT(*) AS total,
                SUM(t.completed_at IS NOT NULL) AS completed,
                SUM(t.completed_at IS NULL AND t.due_on < :today) AS overdue,
                DATE_FORMAT(MIN(CASE WHEN t.completed_at IS NULL AND t.due_on >= :today THEN t.due_on END), '%Y-%m-%d') AS nextDueOn
           FROM task_placements p
           JOIN tasks t ON t.id = p.task_id AND t.organization_id = p.organization_id
          WHERE p.organization_id = :organizationId
            AND p.project_id IN (:projectIds)
            AND t.deleted_at IS NULL
            AND t.parent_task_id IS NULL
          GROUP BY p.project_id`,
        { replacements: { organizationId, projectIds: [...new Set(projectIds)], today }, type: QueryTypes.SELECT, transaction: tx },
      )) as Array<{ projectId: string; total: number | string; completed: number | string | null; overdue: number | string | null; nextDueOn: string | null }>;
      // SUM devuelve DECIMAL, que mysql2 entrega como texto: se pasa a número aquí y no en cada pantalla.
      for (const r of rows) {
        out.set(r.projectId, {
          total: Number(r.total),
          completed: Number(r.completed ?? 0),
          overdue: Number(r.overdue ?? 0),
          nextDueOn: r.nextDueOn ?? null,
        });
      }
      return out;
    },
    async save(p) {
      const values = {
        organization_id: p.organizationId,
        name: p.name,
        description: p.description,
        color: p.color,
        icon: p.icon,
        visibility: p.visibility,
        owner_user_id: p.ownerUserId,
        status: p.status,
        default_view: p.defaultView,
        version: p.version,
        created_by: p.createdBy,
        created_at: p.createdAt,
        updated_at: p.updatedAt,
        deleted_at: p.deletedAt,
      };
      const existing = await ProjectModel.findByPk(p.id, { transaction: tx });
      if (existing) await existing.update(values, { transaction: tx });
      else await ProjectModel.create({ id: p.id, ...values }, { transaction: tx });
    },
  };
}

function memberRepository(tx?: Transaction): MemberRepository {
  return {
    async listByProject(organizationId, projectId) {
      const rows = await ProjectMemberModel.findAll({
        where: { organization_id: organizationId, project_id: projectId },
        order: [['created_at', 'ASC']],
        transaction: tx,
      });
      return rows.map(toMember);
    },
    async find(organizationId, projectId, userId) {
      const m = await ProjectMemberModel.findOne({ where: { organization_id: organizationId, project_id: projectId, user_id: userId }, transaction: tx });
      return m ? toMember(m) : null;
    },
    async listForUser(organizationId, userId, projectIds) {
      if (projectIds.length === 0) return [];
      const rows = await ProjectMemberModel.findAll({
        where: { organization_id: organizationId, user_id: userId, project_id: { [Op.in]: [...new Set(projectIds)] } },
        transaction: tx,
      });
      return rows.map(toMember);
    },
    async listByProjects(organizationId, projectIds) {
      if (projectIds.length === 0) return [];
      const rows = await ProjectMemberModel.findAll({
        where: { organization_id: organizationId, project_id: { [Op.in]: [...new Set(projectIds)] } },
        order: [['created_at', 'ASC']],
        transaction: tx,
      });
      return rows.map(toMember);
    },
    async save(m) {
      const where = { project_id: m.projectId, user_id: m.userId };
      const existing = await ProjectMemberModel.findOne({ where, transaction: tx });
      if (existing) await existing.update({ role: m.role }, { transaction: tx });
      else await ProjectMemberModel.create({ ...where, organization_id: m.organizationId, role: m.role, created_at: m.createdAt }, { transaction: tx });
    },
    async remove(organizationId, projectId, userId) {
      await ProjectMemberModel.destroy({ where: { organization_id: organizationId, project_id: projectId, user_id: userId }, transaction: tx });
    },
  };
}

function sectionRepository(tx?: Transaction): SectionRepository {
  return {
    async findById(organizationId, id) {
      const m = await SectionModel.findOne({ where: { id, organization_id: organizationId }, transaction: tx });
      return m ? toSection(m) : null;
    },
    async listByProject(organizationId, projectId) {
      const rows = await SectionModel.findAll({
        where: { organization_id: organizationId, project_id: projectId },
        order: [['rank', 'ASC'], ['id', 'ASC']],
        transaction: tx,
      });
      return rows.map(toSection);
    },
    async save(s) {
      const values = { organization_id: s.organizationId, project_id: s.projectId, name: s.name, rank: s.rank, created_at: s.createdAt, updated_at: s.updatedAt };
      const existing = await SectionModel.findByPk(s.id, { transaction: tx });
      if (existing) await existing.update(values, { transaction: tx });
      else await SectionModel.create({ id: s.id, ...values }, { transaction: tx });
    },
    async delete(organizationId, id) {
      await SectionModel.destroy({ where: { id, organization_id: organizationId }, transaction: tx });
    },
  };
}

function taskRepository(tx?: Transaction): TaskRepository {
  return {
    async findById(organizationId, id) {
      const m = await TaskModel.findOne({ where: { id, organization_id: organizationId }, transaction: tx });
      return m ? toTask(m) : null;
    },
    async findByIdForUpdate(organizationId, id) {
      const m = await TaskModel.findOne({
        where: { id, organization_id: organizationId },
        transaction: tx,
        ...(tx ? { lock: tx.LOCK.UPDATE } : {}),
      });
      return m ? toTask(m) : null;
    },
    async findManyByIds(organizationId, ids) {
      if (ids.length === 0) return [];
      const rows = await TaskModel.findAll({ where: { organization_id: organizationId, id: { [Op.in]: [...new Set(ids)] } }, transaction: tx });
      return rows.map(toTask);
    },
    async listSubtasks(organizationId, parentTaskId) {
      const rows = await TaskModel.findAll({
        where: { organization_id: organizationId, parent_task_id: parentTaskId, deleted_at: null },
        order: [['subtask_rank', 'ASC'], ['id', 'ASC']],
        transaction: tx,
      });
      return rows.map(toTask);
    },
    async subtaskCounts(organizationId, parentTaskIds) {
      const out = new Map<string, SubtaskCount>();
      if (parentTaskIds.length === 0) return out;
      const rows = (await TaskModel.findAll({
        attributes: [
          'parent_task_id',
          [sequelize.fn('COUNT', sequelize.col('id')), 'total'],
          [sequelize.fn('SUM', sequelize.literal('CASE WHEN completed_at IS NULL THEN 0 ELSE 1 END')), 'completed'],
        ],
        where: { organization_id: organizationId, parent_task_id: { [Op.in]: [...new Set(parentTaskIds)] }, deleted_at: null },
        group: ['parent_task_id'],
        raw: true,
        transaction: tx,
      })) as unknown as Array<{ parent_task_id: string; total: number | string; completed: number | string | null }>;
      for (const r of rows) out.set(r.parent_task_id, { total: Number(r.total), completed: Number(r.completed ?? 0) });
      return out;
    },
    async listByAssignee(organizationId, userId, includeCompleted) {
      const rows = await TaskModel.findAll({
        where: {
          organization_id: organizationId,
          assignee_user_id: userId,
          deleted_at: null,
          ...(includeCompleted ? {} : { completed_at: null }),
        },
        order: [['due_on', 'ASC'], ['created_at', 'ASC']],
        transaction: tx,
      });
      return rows.map(toTask);
    },
    async listPersonalUnassigned(organizationId, userId, includeCompleted) {
      const rows = await TaskModel.findAll({
        where: {
          organization_id: organizationId,
          created_by: userId,
          assignee_user_id: null,
          parent_task_id: null,
          deleted_at: null,
          ...(includeCompleted ? {} : { completed_at: null }),
          id: { [Op.notIn]: sequelize.literal('(SELECT tp.task_id FROM task_placements tp)') },
        },
        order: [['created_at', 'ASC']],
        transaction: tx,
      });
      return rows.map(toTask);
    },
    async search(organizationId, query, limit) {
      // LIKE con comodines escapados: buscar «50%» no debe traer todo.
      const like = `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      const rows = await TaskModel.findAll({
        where: {
          organization_id: organizationId,
          deleted_at: null,
          [Op.or]: [{ title: { [Op.like]: like } }, { description: { [Op.like]: like } }],
        },
        order: [['completed_at', 'ASC'], ['updated_at', 'DESC']],
        limit,
        transaction: tx,
      });
      return rows.map(toTask);
    },
    async listScheduled(organizationId, from, to) {
      const rows = await TaskModel.findAll({
        where: {
          organization_id: organizationId,
          completed_at: null,
          deleted_at: null,
          assignee_user_id: { [Op.ne]: null },
          due_on: { [Op.gte]: from },
          [Op.or]: [{ start_on: { [Op.lte]: to } }, { start_on: null, due_on: { [Op.lte]: to } }],
        },
        transaction: tx,
      });
      return rows.map(toTask);
    },
    async listDueOn(dates) {
      if (dates.length === 0) return [];
      const rows = await TaskModel.findAll({
        where: { due_on: { [Op.in]: dates }, completed_at: null, deleted_at: null, assignee_user_id: { [Op.ne]: null } },
        transaction: tx,
      });
      return rows.map(toTask);
    },
    async save(t) {
      const values = {
        organization_id: t.organizationId,
        parent_task_id: t.parentTaskId,
        kind: t.kind,
        approval_status: t.approvalStatus,
        title: t.title,
        description: t.description,
        description_doc: t.descriptionDoc,
        assignee_user_id: t.assigneeUserId,
        assigned_at: t.assignedAt,
        start_on: t.startOn,
        due_on: t.dueOn,
        estimated_minutes: t.estimatedMinutes,
        completed_at: t.completedAt,
        completed_by: t.completedBy,
        subtask_rank: t.subtaskRank,
        created_by: t.createdBy,
        version: t.version,
        created_at: t.createdAt,
        updated_at: t.updatedAt,
        deleted_at: t.deletedAt,
      };
      const existing = await TaskModel.findByPk(t.id, { transaction: tx });
      if (existing) await existing.update(values, { transaction: tx });
      else await TaskModel.create({ id: t.id, ...values }, { transaction: tx });
    },
  };
}

function placementRepository(tx?: Transaction): PlacementRepository {
  return {
    async listByProject(organizationId, projectId) {
      const rows = await TaskPlacementModel.findAll({
        where: {
          organization_id: organizationId,
          project_id: projectId,
          task_id: { [Op.in]: sequelize.literal(`(SELECT t.id FROM tasks t WHERE t.organization_id = ${sequelize.escape(organizationId)} AND t.deleted_at IS NULL)`) },
        },
        order: [['rank', 'ASC'], ['task_id', 'ASC']],
        transaction: tx,
      });
      return rows.map(toPlacement);
    },
    async listBySection(organizationId, sectionId) {
      const rows = await TaskPlacementModel.findAll({
        where: { organization_id: organizationId, section_id: sectionId },
        order: [['rank', 'ASC'], ['task_id', 'ASC']],
        transaction: tx,
      });
      return rows.map(toPlacement);
    },
    async listByTasks(organizationId, taskIds) {
      if (taskIds.length === 0) return [];
      const rows = await TaskPlacementModel.findAll({
        where: { organization_id: organizationId, task_id: { [Op.in]: [...new Set(taskIds)] } },
        transaction: tx,
      });
      return rows.map(toPlacement);
    },
    async find(organizationId, taskId, projectId) {
      const m = await TaskPlacementModel.findOne({ where: { organization_id: organizationId, task_id: taskId, project_id: projectId }, transaction: tx });
      return m ? toPlacement(m) : null;
    },
    async save(p) {
      const where = { task_id: p.taskId, project_id: p.projectId };
      const existing = await TaskPlacementModel.findOne({ where, transaction: tx });
      if (existing) await existing.update({ section_id: p.sectionId, rank: p.rank }, { transaction: tx });
      else await TaskPlacementModel.create({ ...where, organization_id: p.organizationId, section_id: p.sectionId, rank: p.rank, created_at: p.createdAt }, { transaction: tx });
    },
  };
}

const toComment = (m: CommentModel): Comment => ({
  id: m.id,
  organizationId: m.organization_id,
  taskId: m.task_id,
  authorUserId: m.author_user_id,
  bodyDoc: json<Record<string, unknown>>(m.body_doc),
  bodyText: m.body_text,
  mentionedUserIds: json<string[]>(m.mentioned_user_ids) ?? [],
  createdAt: m.created_at,
  editedAt: m.edited_at,
  deletedAt: m.deleted_at,
});

function commentRepository(tx?: Transaction): CommentRepository {
  return {
    async findById(organizationId, id) {
      const m = await CommentModel.findOne({ where: { id, organization_id: organizationId }, transaction: tx });
      return m ? toComment(m) : null;
    },
    async listByTask(organizationId, taskId) {
      const rows = await CommentModel.findAll({
        where: { organization_id: organizationId, task_id: taskId },
        order: [['created_at', 'ASC'], ['id', 'ASC']],
        transaction: tx,
      });
      return rows.map(toComment);
    },
    async save(c) {
      const values = {
        organization_id: c.organizationId,
        task_id: c.taskId,
        author_user_id: c.authorUserId,
        body_doc: c.bodyDoc,
        body_text: c.bodyText,
        mentioned_user_ids: c.mentionedUserIds,
        created_at: c.createdAt,
        edited_at: c.editedAt,
        deleted_at: c.deletedAt,
      };
      const existing = await CommentModel.findByPk(c.id, { transaction: tx });
      if (existing) await existing.update(values, { transaction: tx });
      else await CommentModel.create({ id: c.id, ...values }, { transaction: tx });
    },
  };
}

/** `INSERT IGNORE`: la clave primaria decide si ya existía (dos «seguir» a la vez no fallan ni se duplican). No es un `upsert`. */
async function insertIgnore(sql: string, replacements: Record<string, unknown>, tx?: Transaction): Promise<boolean> {
  const [, meta] = (await sequelize.query(sql, { replacements, transaction: tx })) as [unknown, { affectedRows?: number } | number];
  const affected = typeof meta === 'number' ? meta : (meta?.affectedRows ?? 0);
  return affected > 0;
}

function followerRepository(tx?: Transaction): FollowerRepository {
  return {
    async listByTask(organizationId, taskId) {
      const rows = await FollowerModel.findAll({ where: { organization_id: organizationId, task_id: taskId }, order: [['created_at', 'ASC']], transaction: tx });
      return rows.map((r) => r.user_id);
    },
    async isFollowing(organizationId, taskId, userId) {
      return (await FollowerModel.count({ where: { organization_id: organizationId, task_id: taskId, user_id: userId }, transaction: tx })) > 0;
    },
    async add(organizationId, taskId, userId, at) {
      return insertIgnore(
        'INSERT IGNORE INTO task_followers (task_id, user_id, organization_id, created_at) VALUES (:taskId, :userId, :organizationId, :at)',
        { taskId, userId, organizationId, at },
        tx,
      );
    },
    async remove(organizationId, taskId, userId) {
      return (await FollowerModel.destroy({ where: { organization_id: organizationId, task_id: taskId, user_id: userId }, transaction: tx })) > 0;
    },
  };
}

function likeRepository(tx?: Transaction): LikeRepository {
  return {
    async usersFor(organizationId, target, ids) {
      const out = new Map<string, string[]>();
      if (ids.length === 0) return out;
      const rows = await LikeModel.findAll({
        where: { organization_id: organizationId, target_type: target, target_id: { [Op.in]: [...new Set(ids)] } },
        order: [['created_at', 'ASC']],
        transaction: tx,
      });
      for (const r of rows) out.set(r.target_id, [...(out.get(r.target_id) ?? []), r.user_id]);
      return out;
    },
    async add(organizationId, target, id, userId, at) {
      return insertIgnore(
        'INSERT IGNORE INTO likes (target_type, target_id, user_id, organization_id, created_at) VALUES (:target, :id, :userId, :organizationId, :at)',
        { target, id, userId, organizationId, at },
        tx,
      );
    },
    async remove(organizationId, target, id, userId) {
      return (await LikeModel.destroy({ where: { organization_id: organizationId, target_type: target, target_id: id, user_id: userId }, transaction: tx })) > 0;
    },
  };
}

const toAttachment = (m: AttachmentModel): Attachment => ({
  id: m.id,
  organizationId: m.organization_id,
  taskId: m.task_id,
  documentId: m.document_id,
  fileName: m.file_name,
  mimeType: m.mime_type,
  sizeBytes: Number(m.size_bytes),
  uploadedBy: m.uploaded_by,
  createdAt: m.created_at,
  deletedAt: m.deleted_at,
});

function attachmentRepository(tx?: Transaction): AttachmentRepository {
  return {
    async findById(organizationId, id) {
      const m = await AttachmentModel.findOne({ where: { id, organization_id: organizationId }, transaction: tx });
      return m ? toAttachment(m) : null;
    },
    async listByTask(organizationId, taskId) {
      const rows = await AttachmentModel.findAll({
        where: { organization_id: organizationId, task_id: taskId, deleted_at: null },
        order: [['created_at', 'ASC']],
        transaction: tx,
      });
      return rows.map(toAttachment);
    },
    async save(a) {
      const values = {
        organization_id: a.organizationId,
        task_id: a.taskId,
        document_id: a.documentId,
        file_name: a.fileName,
        mime_type: a.mimeType,
        size_bytes: a.sizeBytes,
        uploaded_by: a.uploadedBy,
        created_at: a.createdAt,
        deleted_at: a.deletedAt,
      };
      const existing = await AttachmentModel.findByPk(a.id, { transaction: tx });
      if (existing) await existing.update(values, { transaction: tx });
      else await AttachmentModel.create({ id: a.id, ...values }, { transaction: tx });
    },
  };
}

function activityRepository(tx?: Transaction): ActivityRepository {
  return {
    async add(a: Activity) {
      await ActivityModel.create(
        { id: a.id, organization_id: a.organizationId, task_id: a.taskId, actor_user_id: a.actorUserId, kind: a.kind, data: a.data, at: a.at },
        { transaction: tx },
      );
    },
    async listByTask(organizationId, taskId) {
      const rows = await ActivityModel.findAll({ where: { organization_id: organizationId, task_id: taskId }, order: [['at', 'ASC'], ['id', 'ASC']], transaction: tx });
      return rows.map((m) => ({
        id: m.id,
        organizationId: m.organization_id,
        taskId: m.task_id,
        actorUserId: m.actor_user_id,
        kind: m.kind,
        data: json<Record<string, unknown>>(m.data) ?? {},
        at: m.at,
      }));
    },
  };
}

function reminderRepository(tx?: Transaction): ReminderRepository {
  return {
    async tryAdd(taskId, onDate, kind, at) {
      return insertIgnore(
        'INSERT IGNORE INTO task_reminders (task_id, on_date, kind, created_at) VALUES (:taskId, :onDate, :kind, :at)',
        { taskId, onDate, kind, at },
        tx,
      );
    },
  };
}

const toDependency = (m: DependencyModel): Dependency => ({
  taskId: m.task_id,
  dependsOnTaskId: m.depends_on_task_id,
  organizationId: m.organization_id,
  createdAt: m.created_at,
});

function dependencyRepository(tx?: Transaction): DependencyRepository {
  return {
    async listDependsOn(organizationId, taskIds) {
      if (taskIds.length === 0) return [];
      const rows = await DependencyModel.findAll({ where: { organization_id: organizationId, task_id: { [Op.in]: [...new Set(taskIds)] } }, transaction: tx });
      return rows.map(toDependency);
    },
    async listDependents(organizationId, taskIds) {
      if (taskIds.length === 0) return [];
      const rows = await DependencyModel.findAll({
        where: { organization_id: organizationId, depends_on_task_id: { [Op.in]: [...new Set(taskIds)] } },
        transaction: tx,
      });
      return rows.map(toDependency);
    },
    async add(d) {
      return insertIgnore(
        'INSERT IGNORE INTO task_dependencies (task_id, depends_on_task_id, organization_id, created_at) VALUES (:taskId, :dependsOnTaskId, :organizationId, :createdAt)',
        { taskId: d.taskId, dependsOnTaskId: d.dependsOnTaskId, organizationId: d.organizationId, createdAt: d.createdAt },
        tx,
      );
    },
    async remove(organizationId, taskId, dependsOnTaskId) {
      return (await DependencyModel.destroy({ where: { organization_id: organizationId, task_id: taskId, depends_on_task_id: dependsOnTaskId }, transaction: tx })) > 0;
    },
  };
}

const toStatusUpdate = (m: StatusUpdateModel): StatusUpdate => ({
  id: m.id,
  organizationId: m.organization_id,
  projectId: m.project_id,
  status: m.status,
  bodyDoc: m.body_doc ? json<Record<string, unknown>>(m.body_doc) : null,
  bodyText: m.body_text,
  authorUserId: m.author_user_id,
  createdAt: m.created_at,
});

function statusUpdateRepository(tx?: Transaction): StatusUpdateRepository {
  return {
    async add(u) {
      await StatusUpdateModel.create(
        {
          id: u.id,
          organization_id: u.organizationId,
          project_id: u.projectId,
          status: u.status,
          body_doc: u.bodyDoc,
          body_text: u.bodyText,
          author_user_id: u.authorUserId,
          created_at: u.createdAt,
        },
        { transaction: tx },
      );
    },
    async listByProject(organizationId, projectId, limit) {
      const rows = await StatusUpdateModel.findAll({
        where: { organization_id: organizationId, project_id: projectId },
        order: [['created_at', 'DESC'], ['id', 'DESC']],
        limit,
        transaction: tx,
      });
      return rows.map(toStatusUpdate);
    },
    async latestByProjects(organizationId, projectIds) {
      const out = new Map<string, StatusUpdate>();
      if (projectIds.length === 0) return out;
      // La más reciente de cada proyecto: pocas filas por proyecto, así que basta traerlas ordenadas y quedarse con la primera.
      const rows = await StatusUpdateModel.findAll({
        where: { organization_id: organizationId, project_id: { [Op.in]: [...new Set(projectIds)] } },
        order: [['created_at', 'DESC'], ['id', 'DESC']],
        transaction: tx,
      });
      for (const r of rows) if (!out.has(r.project_id)) out.set(r.project_id, toStatusUpdate(r));
      return out;
    },
  };
}

const toLink = (m: TaskLinkModel): TaskLink => ({
  id: m.id,
  organizationId: m.organization_id,
  taskId: m.task_id,
  entityType: m.entity_type,
  entityId: m.entity_id,
  label: m.label,
  createdBy: m.created_by,
  createdAt: m.created_at,
});

function linkRepository(tx?: Transaction): LinkRepository {
  return {
    async listByTask(organizationId, taskId) {
      const rows = await TaskLinkModel.findAll({ where: { organization_id: organizationId, task_id: taskId }, order: [['created_at', 'ASC']], transaction: tx });
      return rows.map(toLink);
    },
    async listByEntity(organizationId, entityType, entityId) {
      const rows = await TaskLinkModel.findAll({ where: { organization_id: organizationId, entity_type: entityType, entity_id: entityId }, transaction: tx });
      return rows.map(toLink);
    },
    async findById(organizationId, id) {
      const m = await TaskLinkModel.findOne({ where: { id, organization_id: organizationId }, transaction: tx });
      return m ? toLink(m) : null;
    },
    async add(l) {
      return insertIgnore(
        `INSERT IGNORE INTO task_links (id, organization_id, task_id, entity_type, entity_id, label, created_by, created_at)
         VALUES (:id, :organizationId, :taskId, :entityType, :entityId, :label, :createdBy, :createdAt)`,
        { id: l.id, organizationId: l.organizationId, taskId: l.taskId, entityType: l.entityType, entityId: l.entityId, label: l.label, createdBy: l.createdBy, createdAt: l.createdAt },
        tx,
      );
    },
    async remove(organizationId, id) {
      return (await TaskLinkModel.destroy({ where: { id, organization_id: organizationId }, transaction: tx })) > 0;
    },
  };
}

const toTag = (m: TagModel): Tag => ({
  id: m.id,
  organizationId: m.organization_id,
  name: m.name,
  color: m.color as ProjectColor,
  createdBy: m.created_by,
  createdAt: m.created_at,
});

function tagRepository(tx?: Transaction): TagRepository {
  return {
    async list(organizationId) {
      const rows = await TagModel.findAll({ where: { organization_id: organizationId }, order: [['name', 'ASC']], transaction: tx });
      return rows.map(toTag);
    },
    async findById(organizationId, id) {
      const m = await TagModel.findOne({ where: { id, organization_id: organizationId }, transaction: tx });
      return m ? toTag(m) : null;
    },
    async findByName(organizationId, name, opts = {}) {
      const m = await TagModel.findOne({
        where: { organization_id: organizationId, name },
        transaction: tx,
        ...(opts.lock && tx ? { lock: tx.LOCK.SHARE } : {}),
      });
      return m ? toTag(m) : null;
    },
    async add(t) {
      // Buscar y luego crear no basta: dos «Urgente» a la vez leen «no existe» y la segunda choca con el índice único (409).
      return insertIgnore(
        'INSERT IGNORE INTO tags (id, organization_id, name, color, created_by, created_at) VALUES (:id, :organizationId, :name, :color, :createdBy, :createdAt)',
        { id: t.id, organizationId: t.organizationId, name: t.name, color: t.color, createdBy: t.createdBy, createdAt: t.createdAt },
        tx,
      );
    },
    async listForTasks(organizationId, taskIds) {
      const out = new Map<string, Tag[]>();
      if (taskIds.length === 0) return out;
      const links = await TaskTagModel.findAll({ where: { organization_id: organizationId, task_id: { [Op.in]: [...new Set(taskIds)] } }, transaction: tx });
      if (links.length === 0) return out;
      const tags = new Map(
        (await TagModel.findAll({ where: { organization_id: organizationId, id: { [Op.in]: [...new Set(links.map((l) => l.tag_id))] } }, transaction: tx })).map((m) => [m.id, toTag(m)]),
      );
      for (const l of links) {
        const tag = tags.get(l.tag_id);
        if (tag) out.set(l.task_id, [...(out.get(l.task_id) ?? []), tag].sort((a, b) => a.name.localeCompare(b.name, 'es')));
      }
      return out;
    },
    async attach(organizationId, taskId, tagId, at) {
      return insertIgnore(
        'INSERT IGNORE INTO task_tags (task_id, tag_id, organization_id, created_at) VALUES (:taskId, :tagId, :organizationId, :at)',
        { taskId, tagId, organizationId, at },
        tx,
      );
    },
    async detach(organizationId, taskId, tagId) {
      return (await TaskTagModel.destroy({ where: { organization_id: organizationId, task_id: taskId, tag_id: tagId }, transaction: tx })) > 0;
    },
    async update(t) {
      try {
        await TagModel.update({ name: t.name, color: t.color }, { where: { id: t.id, organization_id: t.organizationId }, transaction: tx });
        return true;
      } catch (err) {
        // Otra petición tomó ese nombre entre la comprobación y el UPDATE: el índice único (organización, nombre) lo frena.
        if (err instanceof UniqueConstraintError) return false;
        throw err;
      }
    },
    async remove(organizationId, id) {
      // Los vínculos con tareas se borran a mano además de por la cascada: así no depende de que la clave foránea exista en cada base.
      await TaskTagModel.destroy({ where: { organization_id: organizationId, tag_id: id }, transaction: tx });
      return (await TagModel.destroy({ where: { id, organization_id: organizationId }, transaction: tx })) > 0;
    },
    async usage(organizationId) {
      const rows = (await TaskTagModel.findAll({
        attributes: ['tag_id', [fn('COUNT', col('task_id')), 'n']],
        where: { organization_id: organizationId },
        group: ['tag_id'],
        raw: true,
        transaction: tx,
      })) as unknown as Array<{ tag_id: string; n: number | string }>;
      return new Map(rows.map((r) => [r.tag_id, Number(r.n)]));
    },
  };
}

const toField = (m: CustomFieldModel): CustomField => ({
  id: m.id,
  organizationId: m.organization_id,
  projectId: m.project_id,
  name: m.name,
  type: m.type,
  options: json<FieldOption[]>(m.options) ?? [],
  rank: m.rank,
  createdAt: m.created_at,
  updatedAt: m.updated_at,
});

const toFieldValue = (m: CustomFieldValueModel): CustomFieldValue => ({
  taskId: m.task_id,
  fieldId: m.field_id,
  organizationId: m.organization_id,
  // Sin `json()`: mysql2 ya entrega la columna JSON decodificada, y volver a decodificar un texto («Hola», o el id de una opción)
  // revienta o, peor, convierte el texto «123» en el número 123.
  value: m.value as string | number,
  updatedAt: m.updated_at,
});

function fieldRepository(tx?: Transaction): FieldRepository {
  return {
    async listByProjects(organizationId, projectIds) {
      if (projectIds.length === 0) return [];
      const rows = await CustomFieldModel.findAll({
        where: { organization_id: organizationId, project_id: { [Op.in]: [...new Set(projectIds)] } },
        order: [['rank', 'ASC'], ['id', 'ASC']],
        transaction: tx,
      });
      return rows.map(toField);
    },
    async findById(organizationId, id) {
      const m = await CustomFieldModel.findOne({ where: { id, organization_id: organizationId }, transaction: tx });
      return m ? toField(m) : null;
    },
    async save(f) {
      const values = {
        organization_id: f.organizationId,
        project_id: f.projectId,
        name: f.name,
        type: f.type,
        options: f.options,
        rank: f.rank,
        created_at: f.createdAt,
        updated_at: f.updatedAt,
      };
      const existing = await CustomFieldModel.findByPk(f.id, { transaction: tx });
      if (existing) await existing.update(values, { transaction: tx });
      else await CustomFieldModel.create({ id: f.id, ...values }, { transaction: tx });
    },
    async delete(organizationId, id) {
      await CustomFieldModel.destroy({ where: { id, organization_id: organizationId }, transaction: tx });
    },
    async valuesForTasks(organizationId, taskIds) {
      if (taskIds.length === 0) return [];
      const rows = await CustomFieldValueModel.findAll({ where: { organization_id: organizationId, task_id: { [Op.in]: [...new Set(taskIds)] } }, transaction: tx });
      return rows.map(toFieldValue);
    },
    async valuesForField(organizationId, fieldId) {
      const rows = await CustomFieldValueModel.findAll({ where: { organization_id: organizationId, field_id: fieldId }, transaction: tx });
      return rows.map(toFieldValue);
    },
    async setValue(v) {
      const where = { task_id: v.taskId, field_id: v.fieldId };
      const existing = await CustomFieldValueModel.findOne({ where, transaction: tx });
      if (existing) await existing.update({ value: v.value, updated_at: v.updatedAt }, { transaction: tx });
      else await CustomFieldValueModel.create({ ...where, organization_id: v.organizationId, value: v.value, updated_at: v.updatedAt }, { transaction: tx });
    },
    async clearValue(organizationId, taskId, fieldId) {
      return (await CustomFieldValueModel.destroy({ where: { organization_id: organizationId, task_id: taskId, field_id: fieldId }, transaction: tx })) > 0;
    },
  };
}

function withOrigin(payload: Record<string, unknown>): Record<string, unknown> {
  const origin = currentOrigin();
  return origin && payload.via === undefined ? { ...payload, via: origin } : payload;
}

function outboxRepository(tx?: Transaction): OutboxRepository {
  return {
    async add(event: DomainEvent) {
      await OutboxModel.create(
        {
          id: event.eventId,
          aggregate_type: event.aggregateType,
          aggregate_id: event.aggregateId,
          type: event.type,
          // Actor, IP y request-id viajan en el contexto de la petición: la bitácora sabe QUIÉN hizo cada cosa. Y si lo hizo una regla
          // o un formulario en su nombre, `via` dice cuál (ver application/origin.ts).
          payload: withActor(withOrigin(event.payload)),
          occurred_at: event.occurredAt,
          processed_at: null,
        },
        { transaction: tx },
      );
    },
  };
}

// ── Horas y carga de trabajo (entregable 5) ─────────────────────────────────

const toTimeEntry = (m: TimeEntryModel): TimeEntry => ({
  id: m.id,
  organizationId: m.organization_id,
  taskId: m.task_id,
  projectId: m.project_id,
  userId: m.user_id,
  workedOn: m.worked_on,
  minutes: Number(m.minutes),
  billable: !!m.billable,
  note: m.note,
  source: m.source,
  billingId: m.billing_id ?? null,
  createdAt: m.created_at,
  updatedAt: m.updated_at,
});

function timeEntryRepository(tx?: Transaction): TimeEntryRepository {
  const where = (organizationId: string, f: TimeEntryFilter) => {
    const w: Record<string | symbol, unknown> = { organization_id: organizationId };
    if (f.userId) w.user_id = f.userId;
    if (f.projectId) w.project_id = f.projectId;
    if (f.taskId) w.task_id = f.taskId;
    if (f.billable !== undefined) w.billable = f.billable;
    if (f.from || f.to) w.worked_on = { ...(f.from ? { [Op.gte]: f.from } : {}), ...(f.to ? { [Op.lte]: f.to } : {}) };
    return w;
  };
  return {
    async findById(organizationId, id) {
      const m = await TimeEntryModel.findOne({ where: { id, organization_id: organizationId }, transaction: tx });
      return m ? toTimeEntry(m) : null;
    },
    async list(organizationId, filter, limit) {
      const rows = await TimeEntryModel.findAll({
        where: where(organizationId, filter),
        order: [['worked_on', 'DESC'], ['created_at', 'DESC']],
        limit,
        transaction: tx,
      });
      return rows.map(toTimeEntry);
    },
    async totalsByTask(organizationId, taskIds) {
      const out = new Map<string, number>();
      if (taskIds.length === 0) return out;
      const rows = (await TimeEntryModel.findAll({
        attributes: ['task_id', [sequelize.fn('SUM', sequelize.col('minutes')), 'total']],
        where: { organization_id: organizationId, task_id: { [Op.in]: [...new Set(taskIds)] } },
        group: ['task_id'],
        raw: true,
        transaction: tx,
      })) as unknown as Array<{ task_id: string; total: string | number }>;
      for (const r of rows) out.set(r.task_id, Number(r.total));
      return out;
    },
    async save(e) {
      const values = {
        organization_id: e.organizationId,
        task_id: e.taskId,
        project_id: e.projectId,
        user_id: e.userId,
        worked_on: e.workedOn,
        minutes: e.minutes,
        billable: e.billable,
        note: e.note,
        source: e.source,
        billing_id: e.billingId,
        created_at: e.createdAt,
        updated_at: e.updatedAt,
      };
      const existing = await TimeEntryModel.findByPk(e.id, { transaction: tx });
      if (existing) await existing.update(values, { transaction: tx });
      else await TimeEntryModel.create({ id: e.id, ...values }, { transaction: tx });
    },
    async delete(organizationId, id) {
      return (await TimeEntryModel.destroy({ where: { id, organization_id: organizationId }, transaction: tx })) > 0;
    },
    async listUnbilled(organizationId, projectId, range) {
      const rows = await TimeEntryModel.findAll({
        where: where(organizationId, { projectId, billable: true, from: range.from, to: range.to }) as never,
        transaction: tx,
      });
      return rows.map(toTimeEntry).filter((e) => e.billingId === null);
    },
    async findManyForUpdate(organizationId, ids) {
      if (ids.length === 0) return [];
      const rows = await TimeEntryModel.findAll({
        where: { organization_id: organizationId, id: { [Op.in]: [...new Set(ids)] } },
        order: [['id', 'ASC']],
        transaction: tx,
        ...(tx ? { lock: tx.LOCK.UPDATE } : {}),
      });
      return rows.map(toTimeEntry);
    },
    async assignBilling(organizationId, ids, billingId) {
      if (ids.length === 0) return;
      await TimeEntryModel.update({ billing_id: billingId }, { where: { organization_id: organizationId, id: { [Op.in]: ids } }, transaction: tx });
    },
    async releaseBilling(organizationId, billingId) {
      const [n] = await TimeEntryModel.update({ billing_id: null }, { where: { organization_id: organizationId, billing_id: billingId }, transaction: tx });
      return n;
    },
  };
}

const toTimer = (m: RunningTimerModel): RunningTimer => ({
  organizationId: m.organization_id,
  userId: m.user_id,
  taskId: m.task_id,
  projectId: m.project_id,
  startedAt: m.started_at,
});

function timerRepository(tx?: Transaction): TimerRepository {
  return {
    async get(organizationId, userId, opts = {}) {
      const lock = tx && opts.forUpdate ? tx.LOCK.UPDATE : tx && opts.share ? tx.LOCK.SHARE : undefined;
      const m = await RunningTimerModel.findOne({
        where: { organization_id: organizationId, user_id: userId },
        transaction: tx,
        ...(lock ? { lock } : {}),
      });
      return m ? toTimer(m) : null;
    },
    async add(t) {
      // Dos «arrancar» a la vez: buscar y luego crear chocaría con la clave primaria; INSERT IGNORE deja que gane uno.
      return insertIgnore(
        'INSERT IGNORE INTO running_timers (organization_id, user_id, task_id, project_id, started_at) VALUES (:organizationId, :userId, :taskId, :projectId, :startedAt)',
        { organizationId: t.organizationId, userId: t.userId, taskId: t.taskId, projectId: t.projectId, startedAt: t.startedAt },
        tx,
      );
    },
    async replace(t) {
      await RunningTimerModel.update(
        { task_id: t.taskId, project_id: t.projectId, started_at: t.startedAt },
        { where: { organization_id: t.organizationId, user_id: t.userId }, transaction: tx },
      );
    },
    async remove(organizationId, userId) {
      return (await RunningTimerModel.destroy({ where: { organization_id: organizationId, user_id: userId }, transaction: tx })) > 0;
    },
  };
}

const toCapacity = (m: MemberCapacityModel): MemberCapacity => ({
  organizationId: m.organization_id,
  userId: m.user_id,
  weeklyMinutes: Number(m.weekly_minutes),
  updatedBy: m.updated_by,
  updatedAt: m.updated_at,
});

function capacityRepository(tx?: Transaction): CapacityRepository {
  return {
    async list(organizationId) {
      return (await MemberCapacityModel.findAll({ where: { organization_id: organizationId }, transaction: tx })).map(toCapacity);
    },
    async set(c) {
      const inserted = await insertIgnore(
        'INSERT IGNORE INTO member_capacity (organization_id, user_id, weekly_minutes, updated_by, updated_at) VALUES (:organizationId, :userId, :weeklyMinutes, :updatedBy, :updatedAt)',
        { organizationId: c.organizationId, userId: c.userId, weeklyMinutes: c.weeklyMinutes, updatedBy: c.updatedBy, updatedAt: c.updatedAt },
        tx,
      );
      if (!inserted) {
        await MemberCapacityModel.update(
          { weekly_minutes: c.weeklyMinutes, updated_by: c.updatedBy, updated_at: c.updatedAt },
          { where: { organization_id: c.organizationId, user_id: c.userId }, transaction: tx },
        );
      }
    },
  };
}

// ── Facturar el proyecto (entregable 6) ─────────────────────────────────────

const toBilling = (m: ProjectBillingModel): ProjectBilling => ({
  organizationId: m.organization_id,
  projectId: m.project_id,
  customerId: m.customer_id,
  customerLabel: m.customer_label,
  hourlyRateCents: m.hourly_rate_cents === null ? null : Number(m.hourly_rate_cents),
  serviceProductId: m.service_product_id,
  serviceProductLabel: m.service_product_label,
  groupBy: m.group_by,
  updatedBy: m.updated_by,
  updatedAt: m.updated_at,
});

const toMilestone = (m: MilestoneAmountModel): MilestoneAmount => ({
  organizationId: m.organization_id,
  projectId: m.project_id,
  taskId: m.task_id,
  amountCents: Number(m.amount_cents),
  billingId: m.billing_id,
  updatedBy: m.updated_by,
  updatedAt: m.updated_at,
});

const toProjectInvoice = (m: ProjectInvoiceModel): ProjectInvoice => ({
  id: m.id,
  organizationId: m.organization_id,
  projectId: m.project_id,
  invoiceId: m.invoice_id,
  status: m.status,
  number: m.number,
  minutes: Number(m.minutes),
  entryCount: Number(m.entry_count),
  milestoneCount: Number(m.milestone_count),
  amountCents: Number(m.amount_cents),
  // Sin `json()`: mysql2 ya entrega la columna JSON decodificada (ver toFieldValue).
  entryIds: Array.isArray(m.entry_ids) ? m.entry_ids : [],
  milestoneTaskIds: Array.isArray(m.milestone_task_ids) ? m.milestone_task_ids : [],
  conflicts: Number(m.conflicts ?? 0),
  createdBy: m.created_by,
  createdAt: m.created_at,
  updatedAt: m.updated_at,
});

function billingRepository(tx?: Transaction): BillingRepository {
  const lock = (forUpdate?: boolean) => (forUpdate && tx ? { lock: tx.LOCK.UPDATE } : {});
  return {
    async getSettings(organizationId, projectId) {
      const m = await ProjectBillingModel.findOne({ where: { organization_id: organizationId, project_id: projectId }, transaction: tx });
      return m ? toBilling(m) : null;
    },
    async saveSettings(b) {
      const values = {
        organizationId: b.organizationId,
        projectId: b.projectId,
        customerId: b.customerId,
        customerLabel: b.customerLabel,
        hourlyRateCents: b.hourlyRateCents,
        serviceProductId: b.serviceProductId,
        serviceProductLabel: b.serviceProductLabel,
        groupBy: b.groupBy,
        updatedBy: b.updatedBy,
        updatedAt: b.updatedAt,
      };
      const inserted = await insertIgnore(
        `INSERT IGNORE INTO project_billing (project_id, organization_id, customer_id, customer_label, hourly_rate_cents, service_product_id, service_product_label, group_by, updated_by, updated_at)
         VALUES (:projectId, :organizationId, :customerId, :customerLabel, :hourlyRateCents, :serviceProductId, :serviceProductLabel, :groupBy, :updatedBy, :updatedAt)`,
        values,
        tx,
      );
      if (!inserted) {
        await ProjectBillingModel.update(
          {
            customer_id: b.customerId,
            customer_label: b.customerLabel,
            hourly_rate_cents: b.hourlyRateCents,
            service_product_id: b.serviceProductId,
            service_product_label: b.serviceProductLabel,
            group_by: b.groupBy,
            updated_by: b.updatedBy,
            updated_at: b.updatedAt,
          },
          { where: { organization_id: b.organizationId, project_id: b.projectId }, transaction: tx },
        );
      }
    },
    async milestones(organizationId, projectId) {
      return (await MilestoneAmountModel.findAll({ where: { organization_id: organizationId, project_id: projectId }, transaction: tx })).map(toMilestone);
    },
    async findMilestone(organizationId, taskId) {
      const m = await MilestoneAmountModel.findOne({ where: { organization_id: organizationId, task_id: taskId }, transaction: tx, ...lock(true) });
      return m ? toMilestone(m) : null;
    },
    async findMilestonesForUpdate(organizationId, taskIds) {
      if (taskIds.length === 0) return [];
      const rows = await MilestoneAmountModel.findAll({
        where: { organization_id: organizationId, task_id: { [Op.in]: [...new Set(taskIds)] } },
        order: [['task_id', 'ASC']],
        transaction: tx,
        ...lock(true),
      });
      return rows.map(toMilestone);
    },
    async saveMilestone(m) {
      const inserted = await insertIgnore(
        `INSERT IGNORE INTO milestone_amounts (task_id, organization_id, project_id, amount_cents, billing_id, updated_by, updated_at)
         VALUES (:taskId, :organizationId, :projectId, :amountCents, :billingId, :updatedBy, :updatedAt)`,
        { taskId: m.taskId, organizationId: m.organizationId, projectId: m.projectId, amountCents: m.amountCents, billingId: m.billingId, updatedBy: m.updatedBy, updatedAt: m.updatedAt },
        tx,
      );
      if (!inserted) {
        await MilestoneAmountModel.update(
          { project_id: m.projectId, amount_cents: m.amountCents, billing_id: m.billingId, updated_by: m.updatedBy, updated_at: m.updatedAt },
          { where: { organization_id: m.organizationId, task_id: m.taskId }, transaction: tx },
        );
      }
    },
    async deleteMilestone(organizationId, taskId) {
      await MilestoneAmountModel.destroy({ where: { organization_id: organizationId, task_id: taskId }, transaction: tx });
    },
    async assignMilestones(organizationId, taskIds, billingId) {
      if (taskIds.length === 0) return;
      await MilestoneAmountModel.update({ billing_id: billingId }, { where: { organization_id: organizationId, task_id: { [Op.in]: taskIds } }, transaction: tx });
    },
    async releaseMilestones(organizationId, billingId) {
      const [n] = await MilestoneAmountModel.update({ billing_id: null }, { where: { organization_id: organizationId, billing_id: billingId }, transaction: tx });
      return n;
    },
    async invoices(organizationId, projectId) {
      const rows = await ProjectInvoiceModel.findAll({ where: { organization_id: organizationId, project_id: projectId }, order: [['created_at', 'DESC']], transaction: tx });
      return rows.map(toProjectInvoice);
    },
    async findInvoice(organizationId, id, opts = {}) {
      const m = await ProjectInvoiceModel.findOne({ where: { id, organization_id: organizationId }, transaction: tx, ...lock(opts.forUpdate) });
      return m ? toProjectInvoice(m) : null;
    },
    async findByInvoiceId(organizationId, invoiceId, opts = {}) {
      const m = await ProjectInvoiceModel.findOne({ where: { invoice_id: invoiceId, organization_id: organizationId }, transaction: tx, ...lock(opts.forUpdate) });
      return m ? toProjectInvoice(m) : null;
    },
    async saveInvoice(i) {
      const values = {
        organization_id: i.organizationId,
        project_id: i.projectId,
        invoice_id: i.invoiceId,
        status: i.status,
        number: i.number,
        minutes: i.minutes,
        entry_count: i.entryCount,
        milestone_count: i.milestoneCount,
        amount_cents: i.amountCents,
        entry_ids: i.entryIds,
        milestone_task_ids: i.milestoneTaskIds,
        conflicts: i.conflicts,
        created_by: i.createdBy,
        created_at: i.createdAt,
        updated_at: i.updatedAt,
      };
      const existing = await ProjectInvoiceModel.findByPk(i.id, { transaction: tx });
      if (existing) await existing.update(values, { transaction: tx });
      else await ProjectInvoiceModel.create({ id: i.id, ...values }, { transaction: tx });
    },
  };
}

// ── Reglas y formularios (entregable 7) ─────────────────────────────────────

// Las columnas JSON llegan ya decodificadas de mysql2 (ver toFieldValue): no se pasan por `json()`.
const toRule = (m: ProjectRuleModel): ProjectRule => ({
  id: m.id,
  organizationId: m.organization_id,
  projectId: m.project_id,
  name: m.name,
  trigger: m.trigger_type,
  triggerSectionId: m.trigger_section_id,
  actions: Array.isArray(m.actions) ? (m.actions as RuleAction[]) : [],
  enabled: !!m.enabled,
  runCount: Number(m.run_count),
  lastRunAt: m.last_run_at,
  lastError: m.last_error,
  createdBy: m.created_by,
  createdAt: m.created_at,
  updatedAt: m.updated_at,
});

function ruleRepository(tx?: Transaction): RuleRepository {
  return {
    async listByProject(organizationId, projectId) {
      const rows = await ProjectRuleModel.findAll({ where: { organization_id: organizationId, project_id: projectId }, order: [['created_at', 'ASC']], transaction: tx });
      return rows.map(toRule);
    },
    async findById(organizationId, id) {
      const m = await ProjectRuleModel.findOne({ where: { id, organization_id: organizationId }, transaction: tx });
      return m ? toRule(m) : null;
    },
    async save(r) {
      const values = {
        organization_id: r.organizationId,
        project_id: r.projectId,
        name: r.name,
        trigger_type: r.trigger,
        trigger_section_id: r.triggerSectionId,
        actions: r.actions,
        enabled: r.enabled,
        run_count: r.runCount,
        last_run_at: r.lastRunAt,
        last_error: r.lastError,
        created_by: r.createdBy,
        created_at: r.createdAt,
        updated_at: r.updatedAt,
      };
      const existing = await ProjectRuleModel.findByPk(r.id, { transaction: tx });
      if (existing) await existing.update(values, { transaction: tx });
      else await ProjectRuleModel.create({ id: r.id, ...values }, { transaction: tx });
    },
    async delete(organizationId, id) {
      return (await ProjectRuleModel.destroy({ where: { id, organization_id: organizationId }, transaction: tx })) > 0;
    },
    async recordRun(organizationId, id, at, error) {
      await sequelize.query(
        'UPDATE project_rules SET run_count = run_count + 1, last_run_at = :at, last_error = :error WHERE id = :id AND organization_id = :organizationId',
        { replacements: { at, error: error ? error.slice(0, 500) : null, id, organizationId }, transaction: tx },
      );
    },
  };
}

const toForm = (m: ProjectFormModel): ProjectForm => ({
  id: m.id,
  organizationId: m.organization_id,
  projectId: m.project_id,
  title: m.title,
  description: m.description,
  questions: Array.isArray(m.questions) ? (m.questions as FormQuestion[]) : [],
  sectionId: m.section_id,
  assigneeUserId: m.assignee_user_id,
  enabled: !!m.enabled,
  submissionCount: Number(m.submission_count),
  createdBy: m.created_by,
  createdAt: m.created_at,
  updatedAt: m.updated_at,
});

function formRepository(tx?: Transaction): FormRepository {
  return {
    async listByProject(organizationId, projectId) {
      const rows = await ProjectFormModel.findAll({ where: { organization_id: organizationId, project_id: projectId }, order: [['created_at', 'ASC']], transaction: tx });
      return rows.map(toForm);
    },
    async findById(organizationId, id) {
      const m = await ProjectFormModel.findOne({ where: { id, organization_id: organizationId }, transaction: tx });
      return m ? toForm(m) : null;
    },
    async save(f) {
      const values = {
        organization_id: f.organizationId,
        project_id: f.projectId,
        title: f.title,
        description: f.description,
        questions: f.questions,
        section_id: f.sectionId,
        assignee_user_id: f.assigneeUserId,
        enabled: f.enabled,
        submission_count: f.submissionCount,
        created_by: f.createdBy,
        created_at: f.createdAt,
        updated_at: f.updatedAt,
      };
      const existing = await ProjectFormModel.findByPk(f.id, { transaction: tx });
      if (existing) await existing.update(values, { transaction: tx });
      else await ProjectFormModel.create({ id: f.id, ...values }, { transaction: tx });
    },
    async delete(organizationId, id) {
      return (await ProjectFormModel.destroy({ where: { id, organization_id: organizationId }, transaction: tx })) > 0;
    },
    async incrementSubmissions(organizationId, id) {
      await sequelize.query('UPDATE project_forms SET submission_count = submission_count + 1 WHERE id = :id AND organization_id = :organizationId', {
        replacements: { id, organizationId },
        transaction: tx,
      });
    },
  };
}

// ── Ensamblaje ──────────────────────────────────────────────────────────────

export function buildRepositories(tx?: Transaction): Repositories {
  return {
    projects: projectRepository(tx),
    members: memberRepository(tx),
    sections: sectionRepository(tx),
    tasks: taskRepository(tx),
    placements: placementRepository(tx),
    comments: commentRepository(tx),
    followers: followerRepository(tx),
    likes: likeRepository(tx),
    attachments: attachmentRepository(tx),
    activity: activityRepository(tx),
    reminders: reminderRepository(tx),
    dependencies: dependencyRepository(tx),
    statusUpdates: statusUpdateRepository(tx),
    links: linkRepository(tx),
    tags: tagRepository(tx),
    fields: fieldRepository(tx),
    timeEntries: timeEntryRepository(tx),
    timers: timerRepository(tx),
    capacity: capacityRepository(tx),
    billing: billingRepository(tx),
    rules: ruleRepository(tx),
    forms: formRepository(tx),
    outbox: outboxRepository(tx),
  };
}

/** Lecturas sin transacción (listados, tablero, detalle). */
export const readOnlyRepositories: Repositories = buildRepositories(undefined);

class SequelizeUnitOfWork implements WriteUnitOfWork {
  readonly projects;
  readonly members;
  readonly sections;
  readonly tasks;
  readonly placements;
  readonly comments;
  readonly followers;
  readonly likes;
  readonly attachments;
  readonly activity;
  readonly reminders;
  readonly dependencies;
  readonly statusUpdates;
  readonly links;
  readonly tags;
  readonly fields;
  readonly timeEntries;
  readonly timers;
  readonly capacity;
  readonly billing;
  readonly rules;
  readonly forms;
  readonly outbox;

  constructor(private readonly tx: Transaction) {
    const repos = buildRepositories(tx);
    this.projects = repos.projects;
    this.members = repos.members;
    this.sections = repos.sections;
    this.tasks = repos.tasks;
    this.placements = repos.placements;
    this.comments = repos.comments;
    this.followers = repos.followers;
    this.likes = repos.likes;
    this.attachments = repos.attachments;
    this.activity = repos.activity;
    this.reminders = repos.reminders;
    this.dependencies = repos.dependencies;
    this.statusUpdates = repos.statusUpdates;
    this.links = repos.links;
    this.tags = repos.tags;
    this.fields = repos.fields;
    this.timeEntries = repos.timeEntries;
    this.timers = repos.timers;
    this.capacity = repos.capacity;
    this.billing = repos.billing;
    this.rules = repos.rules;
    this.forms = repos.forms;
    this.outbox = repos.outbox;
  }

  async commit(): Promise<void> {
    await this.tx.commit();
  }

  async rollback(): Promise<void> {
    // Tras un deadlock MySQL ya deshizo la transacción y Sequelize la da por terminada: un segundo rollback lanzaría otro error que
    // taparía el verdadero (se vio como «Transaction cannot be rolled back…» y un 500).
    if ((this.tx as unknown as { finished?: string }).finished) return;
    await this.tx.rollback();
  }
}

export class SequelizeUnitOfWorkFactory implements UnitOfWorkGateway {
  constructor(private readonly onBegin?: (tx: Transaction) => void) {}

  isRetryable(err: unknown): boolean {
    const e = err as { parent?: { code?: string; errno?: number }; original?: { code?: string; errno?: number } };
    const cause = e?.parent ?? e?.original;
    return cause?.code === 'ER_LOCK_DEADLOCK' || cause?.errno === 1213;
  }

  async begin(): Promise<WriteUnitOfWork> {
    const tx = await sequelize.transaction();
    // El relay publica el outbox justo tras el commit; sin este enganche los eventos esperan el barrido de respaldo del relay.
    this.onBegin?.(tx);
    return new SequelizeUnitOfWork(tx);
  }
}
