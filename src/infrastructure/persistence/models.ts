import { DataTypes, type InferAttributes, type InferCreationAttributes, Model } from 'sequelize';
import { sequelize } from './sequelize.js';

/** Espejo de `migrations/20261104120000-create-projects-tables.cjs`. La migración es la fuente de verdad: nunca `sync()`. */

export class ProjectModel extends Model<InferAttributes<ProjectModel>, InferCreationAttributes<ProjectModel>> {
  declare id: string;
  declare organization_id: string;
  declare name: string;
  declare description: string | null;
  declare color: string;
  declare icon: string;
  declare visibility: 'organization' | 'members';
  declare owner_user_id: string;
  declare status: 'active' | 'archived';
  declare default_view: 'list' | 'board';
  declare version: number;
  declare created_by: string;
  declare created_at: Date;
  declare updated_at: Date;
  declare deleted_at: Date | null;
}

ProjectModel.init(
  {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    organization_id: { type: DataTypes.CHAR(36), allowNull: false },
    name: { type: DataTypes.STRING(120), allowNull: false },
    description: { type: DataTypes.TEXT, allowNull: true },
    color: { type: DataTypes.STRING(20), allowNull: false },
    icon: { type: DataTypes.STRING(60), allowNull: false },
    visibility: { type: DataTypes.ENUM('organization', 'members'), allowNull: false },
    owner_user_id: { type: DataTypes.CHAR(36), allowNull: false },
    status: { type: DataTypes.ENUM('active', 'archived'), allowNull: false },
    default_view: { type: DataTypes.ENUM('list', 'board'), allowNull: false },
    version: { type: DataTypes.INTEGER, allowNull: false },
    created_by: { type: DataTypes.CHAR(36), allowNull: false },
    created_at: { type: DataTypes.DATE, allowNull: false },
    updated_at: { type: DataTypes.DATE, allowNull: false },
    deleted_at: { type: DataTypes.DATE, allowNull: true },
  },
  { sequelize, tableName: 'projects', timestamps: false },
);

export class ProjectMemberModel extends Model<InferAttributes<ProjectMemberModel>, InferCreationAttributes<ProjectMemberModel>> {
  declare project_id: string;
  declare user_id: string;
  declare organization_id: string;
  declare role: 'admin' | 'editor' | 'commenter' | 'viewer';
  declare created_at: Date;
}

ProjectMemberModel.init(
  {
    project_id: { type: DataTypes.CHAR(36), primaryKey: true },
    user_id: { type: DataTypes.CHAR(36), primaryKey: true },
    organization_id: { type: DataTypes.CHAR(36), allowNull: false },
    role: { type: DataTypes.ENUM('admin', 'editor', 'commenter', 'viewer'), allowNull: false },
    created_at: { type: DataTypes.DATE, allowNull: false },
  },
  { sequelize, tableName: 'project_members', timestamps: false },
);

export class SectionModel extends Model<InferAttributes<SectionModel>, InferCreationAttributes<SectionModel>> {
  declare id: string;
  declare organization_id: string;
  declare project_id: string;
  declare name: string;
  declare rank: string;
  declare created_at: Date;
  declare updated_at: Date;
}

SectionModel.init(
  {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    organization_id: { type: DataTypes.CHAR(36), allowNull: false },
    project_id: { type: DataTypes.CHAR(36), allowNull: false },
    name: { type: DataTypes.STRING(120), allowNull: false },
    rank: { type: DataTypes.STRING(255), allowNull: false },
    created_at: { type: DataTypes.DATE, allowNull: false },
    updated_at: { type: DataTypes.DATE, allowNull: false },
  },
  { sequelize, tableName: 'sections', timestamps: false },
);

export class TaskModel extends Model<InferAttributes<TaskModel>, InferCreationAttributes<TaskModel>> {
  declare id: string;
  declare organization_id: string;
  declare parent_task_id: string | null;
  declare kind: 'task' | 'milestone' | 'approval';
  declare approval_status: 'pending' | 'approved' | 'changes_requested' | 'rejected' | null;
  declare title: string;
  declare description: string | null;
  declare description_doc: Record<string, unknown> | null;
  declare assignee_user_id: string | null;
  declare assigned_at: Date | null;
  declare start_on: string | null;
  declare due_on: string | null;
  declare estimated_minutes: number | null;
  declare completed_at: Date | null;
  declare completed_by: string | null;
  declare subtask_rank: string | null;
  declare created_by: string;
  declare version: number;
  declare created_at: Date;
  declare updated_at: Date;
  declare deleted_at: Date | null;
}

TaskModel.init(
  {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    organization_id: { type: DataTypes.CHAR(36), allowNull: false },
    parent_task_id: { type: DataTypes.CHAR(36), allowNull: true },
    kind: { type: DataTypes.ENUM('task', 'milestone', 'approval'), allowNull: false },
    approval_status: { type: DataTypes.ENUM('pending', 'approved', 'changes_requested', 'rejected'), allowNull: true },
    title: { type: DataTypes.STRING(500), allowNull: false },
    description: { type: DataTypes.TEXT, allowNull: true },
    description_doc: { type: DataTypes.JSON, allowNull: true },
    assignee_user_id: { type: DataTypes.CHAR(36), allowNull: true },
    assigned_at: { type: DataTypes.DATE, allowNull: true },
    start_on: { type: DataTypes.DATEONLY, allowNull: true },
    due_on: { type: DataTypes.DATEONLY, allowNull: true },
    estimated_minutes: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    completed_at: { type: DataTypes.DATE, allowNull: true },
    completed_by: { type: DataTypes.CHAR(36), allowNull: true },
    subtask_rank: { type: DataTypes.STRING(255), allowNull: true },
    created_by: { type: DataTypes.CHAR(36), allowNull: false },
    version: { type: DataTypes.INTEGER, allowNull: false },
    created_at: { type: DataTypes.DATE, allowNull: false },
    updated_at: { type: DataTypes.DATE, allowNull: false },
    deleted_at: { type: DataTypes.DATE, allowNull: true },
  },
  { sequelize, tableName: 'tasks', timestamps: false },
);

export class TaskPlacementModel extends Model<InferAttributes<TaskPlacementModel>, InferCreationAttributes<TaskPlacementModel>> {
  declare task_id: string;
  declare project_id: string;
  declare organization_id: string;
  declare section_id: string;
  declare rank: string;
  declare created_at: Date;
}

TaskPlacementModel.init(
  {
    task_id: { type: DataTypes.CHAR(36), primaryKey: true },
    project_id: { type: DataTypes.CHAR(36), primaryKey: true },
    organization_id: { type: DataTypes.CHAR(36), allowNull: false },
    section_id: { type: DataTypes.CHAR(36), allowNull: false },
    rank: { type: DataTypes.STRING(255), allowNull: false },
    created_at: { type: DataTypes.DATE, allowNull: false },
  },
  { sequelize, tableName: 'task_placements', timestamps: false },
);

export class CommentModel extends Model<InferAttributes<CommentModel>, InferCreationAttributes<CommentModel>> {
  declare id: string;
  declare organization_id: string;
  declare task_id: string;
  declare author_user_id: string;
  declare body_doc: Record<string, unknown>;
  declare body_text: string;
  declare mentioned_user_ids: string[];
  declare created_at: Date;
  declare edited_at: Date | null;
  declare deleted_at: Date | null;
}

CommentModel.init(
  {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    organization_id: { type: DataTypes.CHAR(36), allowNull: false },
    task_id: { type: DataTypes.CHAR(36), allowNull: false },
    author_user_id: { type: DataTypes.CHAR(36), allowNull: false },
    body_doc: { type: DataTypes.JSON, allowNull: false },
    body_text: { type: DataTypes.TEXT, allowNull: false },
    mentioned_user_ids: { type: DataTypes.JSON, allowNull: false },
    created_at: { type: DataTypes.DATE, allowNull: false },
    edited_at: { type: DataTypes.DATE, allowNull: true },
    deleted_at: { type: DataTypes.DATE, allowNull: true },
  },
  { sequelize, tableName: 'task_comments', timestamps: false },
);

export class FollowerModel extends Model<InferAttributes<FollowerModel>, InferCreationAttributes<FollowerModel>> {
  declare task_id: string;
  declare user_id: string;
  declare organization_id: string;
  declare created_at: Date;
}

FollowerModel.init(
  {
    task_id: { type: DataTypes.CHAR(36), primaryKey: true },
    user_id: { type: DataTypes.CHAR(36), primaryKey: true },
    organization_id: { type: DataTypes.CHAR(36), allowNull: false },
    created_at: { type: DataTypes.DATE, allowNull: false },
  },
  { sequelize, tableName: 'task_followers', timestamps: false },
);

export class LikeModel extends Model<InferAttributes<LikeModel>, InferCreationAttributes<LikeModel>> {
  declare target_type: 'task' | 'comment';
  declare target_id: string;
  declare user_id: string;
  declare organization_id: string;
  declare created_at: Date;
}

LikeModel.init(
  {
    target_type: { type: DataTypes.ENUM('task', 'comment'), primaryKey: true },
    target_id: { type: DataTypes.CHAR(36), primaryKey: true },
    user_id: { type: DataTypes.CHAR(36), primaryKey: true },
    organization_id: { type: DataTypes.CHAR(36), allowNull: false },
    created_at: { type: DataTypes.DATE, allowNull: false },
  },
  { sequelize, tableName: 'likes', timestamps: false },
);

export class AttachmentModel extends Model<InferAttributes<AttachmentModel>, InferCreationAttributes<AttachmentModel>> {
  declare id: string;
  declare organization_id: string;
  declare task_id: string;
  declare document_id: string;
  declare file_name: string;
  declare mime_type: string;
  declare size_bytes: number | string;
  declare uploaded_by: string;
  declare created_at: Date;
  declare deleted_at: Date | null;
}

AttachmentModel.init(
  {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    organization_id: { type: DataTypes.CHAR(36), allowNull: false },
    task_id: { type: DataTypes.CHAR(36), allowNull: false },
    document_id: { type: DataTypes.CHAR(36), allowNull: false },
    file_name: { type: DataTypes.STRING(255), allowNull: false },
    mime_type: { type: DataTypes.STRING(150), allowNull: false },
    size_bytes: { type: DataTypes.BIGINT, allowNull: false },
    uploaded_by: { type: DataTypes.CHAR(36), allowNull: false },
    created_at: { type: DataTypes.DATE, allowNull: false },
    deleted_at: { type: DataTypes.DATE, allowNull: true },
  },
  { sequelize, tableName: 'task_attachments', timestamps: false },
);

export class ActivityModel extends Model<InferAttributes<ActivityModel>, InferCreationAttributes<ActivityModel>> {
  declare id: string;
  declare organization_id: string;
  declare task_id: string;
  declare actor_user_id: string | null;
  declare kind: string;
  declare data: Record<string, unknown>;
  declare at: Date;
}

ActivityModel.init(
  {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    organization_id: { type: DataTypes.CHAR(36), allowNull: false },
    task_id: { type: DataTypes.CHAR(36), allowNull: false },
    actor_user_id: { type: DataTypes.CHAR(36), allowNull: true },
    kind: { type: DataTypes.STRING(40), allowNull: false },
    data: { type: DataTypes.JSON, allowNull: false },
    at: { type: DataTypes.DATE, allowNull: false },
  },
  { sequelize, tableName: 'task_activity', timestamps: false },
);

export class DependencyModel extends Model<InferAttributes<DependencyModel>, InferCreationAttributes<DependencyModel>> {
  declare task_id: string;
  declare depends_on_task_id: string;
  declare organization_id: string;
  declare created_at: Date;
}

DependencyModel.init(
  {
    task_id: { type: DataTypes.CHAR(36), primaryKey: true },
    depends_on_task_id: { type: DataTypes.CHAR(36), primaryKey: true },
    organization_id: { type: DataTypes.CHAR(36), allowNull: false },
    created_at: { type: DataTypes.DATE, allowNull: false },
  },
  { sequelize, tableName: 'task_dependencies', timestamps: false },
);

export class StatusUpdateModel extends Model<InferAttributes<StatusUpdateModel>, InferCreationAttributes<StatusUpdateModel>> {
  declare id: string;
  declare organization_id: string;
  declare project_id: string;
  declare status: 'on_track' | 'at_risk' | 'off_track' | 'complete';
  declare body_doc: Record<string, unknown> | null;
  declare body_text: string | null;
  declare author_user_id: string;
  declare created_at: Date;
}

StatusUpdateModel.init(
  {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    organization_id: { type: DataTypes.CHAR(36), allowNull: false },
    project_id: { type: DataTypes.CHAR(36), allowNull: false },
    status: { type: DataTypes.ENUM('on_track', 'at_risk', 'off_track', 'complete'), allowNull: false },
    body_doc: { type: DataTypes.JSON, allowNull: true },
    body_text: { type: DataTypes.TEXT, allowNull: true },
    author_user_id: { type: DataTypes.CHAR(36), allowNull: false },
    created_at: { type: DataTypes.DATE, allowNull: false },
  },
  { sequelize, tableName: 'project_status_updates', timestamps: false },
);

export class TaskLinkModel extends Model<InferAttributes<TaskLinkModel>, InferCreationAttributes<TaskLinkModel>> {
  declare id: string;
  declare organization_id: string;
  declare task_id: string;
  declare entity_type: 'customer' | 'invoice' | 'quote' | 'purchase_order' | 'product';
  declare entity_id: string;
  declare label: string;
  declare created_by: string;
  declare created_at: Date;
}

TaskLinkModel.init(
  {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    organization_id: { type: DataTypes.CHAR(36), allowNull: false },
    task_id: { type: DataTypes.CHAR(36), allowNull: false },
    entity_type: { type: DataTypes.ENUM('customer', 'invoice', 'quote', 'purchase_order', 'product'), allowNull: false },
    entity_id: { type: DataTypes.CHAR(36), allowNull: false },
    label: { type: DataTypes.STRING(200), allowNull: false },
    created_by: { type: DataTypes.CHAR(36), allowNull: false },
    created_at: { type: DataTypes.DATE, allowNull: false },
  },
  { sequelize, tableName: 'task_links', timestamps: false },
);

export class TagModel extends Model<InferAttributes<TagModel>, InferCreationAttributes<TagModel>> {
  declare id: string;
  declare organization_id: string;
  declare name: string;
  declare color: string;
  declare created_by: string;
  declare created_at: Date;
}

TagModel.init(
  {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    organization_id: { type: DataTypes.CHAR(36), allowNull: false },
    name: { type: DataTypes.STRING(60), allowNull: false },
    color: { type: DataTypes.STRING(20), allowNull: false },
    created_by: { type: DataTypes.CHAR(36), allowNull: false },
    created_at: { type: DataTypes.DATE, allowNull: false },
  },
  { sequelize, tableName: 'tags', timestamps: false },
);

export class TaskTagModel extends Model<InferAttributes<TaskTagModel>, InferCreationAttributes<TaskTagModel>> {
  declare task_id: string;
  declare tag_id: string;
  declare organization_id: string;
  declare created_at: Date;
}

TaskTagModel.init(
  {
    task_id: { type: DataTypes.CHAR(36), primaryKey: true },
    tag_id: { type: DataTypes.CHAR(36), primaryKey: true },
    organization_id: { type: DataTypes.CHAR(36), allowNull: false },
    created_at: { type: DataTypes.DATE, allowNull: false },
  },
  { sequelize, tableName: 'task_tags', timestamps: false },
);

export class CustomFieldModel extends Model<InferAttributes<CustomFieldModel>, InferCreationAttributes<CustomFieldModel>> {
  declare id: string;
  declare organization_id: string;
  declare project_id: string;
  declare name: string;
  declare type: 'text' | 'number' | 'select' | 'date' | 'person';
  declare options: unknown;
  declare rank: string;
  declare created_at: Date;
  declare updated_at: Date;
}

CustomFieldModel.init(
  {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    organization_id: { type: DataTypes.CHAR(36), allowNull: false },
    project_id: { type: DataTypes.CHAR(36), allowNull: false },
    name: { type: DataTypes.STRING(60), allowNull: false },
    type: { type: DataTypes.ENUM('text', 'number', 'select', 'date', 'person'), allowNull: false },
    options: { type: DataTypes.JSON, allowNull: false },
    rank: { type: DataTypes.STRING(255), allowNull: false },
    created_at: { type: DataTypes.DATE, allowNull: false },
    updated_at: { type: DataTypes.DATE, allowNull: false },
  },
  { sequelize, tableName: 'custom_fields', timestamps: false },
);

export class CustomFieldValueModel extends Model<InferAttributes<CustomFieldValueModel>, InferCreationAttributes<CustomFieldValueModel>> {
  declare task_id: string;
  declare field_id: string;
  declare organization_id: string;
  declare value: unknown;
  declare updated_at: Date;
}

CustomFieldValueModel.init(
  {
    task_id: { type: DataTypes.CHAR(36), primaryKey: true },
    field_id: { type: DataTypes.CHAR(36), primaryKey: true },
    organization_id: { type: DataTypes.CHAR(36), allowNull: false },
    value: { type: DataTypes.JSON, allowNull: false },
    updated_at: { type: DataTypes.DATE, allowNull: false },
  },
  { sequelize, tableName: 'custom_field_values', timestamps: false },
);

export class OutboxModel extends Model<InferAttributes<OutboxModel>, InferCreationAttributes<OutboxModel>> {
  declare id: string;
  declare aggregate_type: string;
  declare aggregate_id: string;
  declare type: string;
  declare payload: unknown;
  declare occurred_at: Date;
  declare processed_at: Date | null;
}

OutboxModel.init(
  {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    aggregate_type: { type: DataTypes.STRING(50), allowNull: false },
    aggregate_id: { type: DataTypes.CHAR(36), allowNull: false },
    type: { type: DataTypes.STRING(100), allowNull: false },
    payload: { type: DataTypes.JSON, allowNull: false },
    occurred_at: { type: DataTypes.DATE, allowNull: false },
    processed_at: { type: DataTypes.DATE, allowNull: true },
  },
  { sequelize, tableName: 'outbox_messages', timestamps: false },
);

// ── Horas y carga de trabajo (migrations/20261107100000-time-tracking.cjs) ───

export class TimeEntryModel extends Model<InferAttributes<TimeEntryModel>, InferCreationAttributes<TimeEntryModel>> {
  declare id: string;
  declare organization_id: string;
  declare task_id: string;
  declare project_id: string | null;
  declare user_id: string;
  declare worked_on: string;
  declare minutes: number;
  declare billable: boolean;
  declare note: string | null;
  declare source: 'manual' | 'timer';
  declare billing_id: string | null;
  declare created_at: Date;
  declare updated_at: Date;
}

TimeEntryModel.init(
  {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    organization_id: { type: DataTypes.CHAR(36), allowNull: false },
    task_id: { type: DataTypes.CHAR(36), allowNull: false },
    project_id: { type: DataTypes.CHAR(36), allowNull: true },
    user_id: { type: DataTypes.CHAR(36), allowNull: false },
    worked_on: { type: DataTypes.DATEONLY, allowNull: false },
    minutes: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    billable: { type: DataTypes.BOOLEAN, allowNull: false },
    note: { type: DataTypes.STRING(500), allowNull: true },
    source: { type: DataTypes.ENUM('manual', 'timer'), allowNull: false },
    billing_id: { type: DataTypes.CHAR(36), allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: false },
    updated_at: { type: DataTypes.DATE, allowNull: false },
  },
  { sequelize, tableName: 'time_entries', timestamps: false },
);

export class RunningTimerModel extends Model<InferAttributes<RunningTimerModel>, InferCreationAttributes<RunningTimerModel>> {
  declare organization_id: string;
  declare user_id: string;
  declare task_id: string;
  declare project_id: string | null;
  declare started_at: Date;
}

RunningTimerModel.init(
  {
    organization_id: { type: DataTypes.CHAR(36), primaryKey: true },
    user_id: { type: DataTypes.CHAR(36), primaryKey: true },
    task_id: { type: DataTypes.CHAR(36), allowNull: false },
    project_id: { type: DataTypes.CHAR(36), allowNull: true },
    started_at: { type: DataTypes.DATE(3), allowNull: false },
  },
  { sequelize, tableName: 'running_timers', timestamps: false },
);

export class MemberCapacityModel extends Model<InferAttributes<MemberCapacityModel>, InferCreationAttributes<MemberCapacityModel>> {
  declare organization_id: string;
  declare user_id: string;
  declare weekly_minutes: number;
  declare updated_by: string;
  declare updated_at: Date;
}

MemberCapacityModel.init(
  {
    organization_id: { type: DataTypes.CHAR(36), primaryKey: true },
    user_id: { type: DataTypes.CHAR(36), primaryKey: true },
    weekly_minutes: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    updated_by: { type: DataTypes.CHAR(36), allowNull: false },
    updated_at: { type: DataTypes.DATE, allowNull: false },
  },
  { sequelize, tableName: 'member_capacity', timestamps: false },
);

// ── Facturar el proyecto (migrations/20261108100000-project-billing.cjs) ───

export class ProjectBillingModel extends Model<InferAttributes<ProjectBillingModel>, InferCreationAttributes<ProjectBillingModel>> {
  declare project_id: string;
  declare organization_id: string;
  declare customer_id: string | null;
  declare customer_label: string | null;
  declare hourly_rate_cents: number | null;
  declare service_product_id: string | null;
  declare service_product_label: string | null;
  declare group_by: 'task' | 'person' | 'single';
  declare updated_by: string;
  declare updated_at: Date;
}

ProjectBillingModel.init(
  {
    project_id: { type: DataTypes.CHAR(36), primaryKey: true },
    organization_id: { type: DataTypes.CHAR(36), allowNull: false },
    customer_id: { type: DataTypes.CHAR(36), allowNull: true },
    customer_label: { type: DataTypes.STRING(300), allowNull: true },
    hourly_rate_cents: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    service_product_id: { type: DataTypes.CHAR(36), allowNull: true },
    service_product_label: { type: DataTypes.STRING(255), allowNull: true },
    group_by: { type: DataTypes.ENUM('task', 'person', 'single'), allowNull: false },
    updated_by: { type: DataTypes.CHAR(36), allowNull: false },
    updated_at: { type: DataTypes.DATE, allowNull: false },
  },
  { sequelize, tableName: 'project_billing', timestamps: false },
);

export class ProjectInvoiceModel extends Model<InferAttributes<ProjectInvoiceModel>, InferCreationAttributes<ProjectInvoiceModel>> {
  declare id: string;
  declare organization_id: string;
  declare project_id: string;
  declare invoice_id: string | null;
  declare status: 'pending' | 'draft' | 'issued' | 'voided' | 'released';
  declare number: string | null;
  declare minutes: number;
  declare entry_count: number;
  declare milestone_count: number;
  declare amount_cents: number | string;
  declare entry_ids: string[];
  declare milestone_task_ids: string[];
  declare conflicts: number;
  declare created_by: string;
  declare created_at: Date;
  declare updated_at: Date;
}

ProjectInvoiceModel.init(
  {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    organization_id: { type: DataTypes.CHAR(36), allowNull: false },
    project_id: { type: DataTypes.CHAR(36), allowNull: false },
    invoice_id: { type: DataTypes.CHAR(36), allowNull: true },
    status: { type: DataTypes.ENUM('pending', 'draft', 'issued', 'voided', 'released'), allowNull: false },
    number: { type: DataTypes.STRING(50), allowNull: true },
    minutes: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    entry_count: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    milestone_count: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    amount_cents: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    entry_ids: { type: DataTypes.JSON, allowNull: false },
    milestone_task_ids: { type: DataTypes.JSON, allowNull: false },
    conflicts: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    created_by: { type: DataTypes.CHAR(36), allowNull: false },
    created_at: { type: DataTypes.DATE, allowNull: false },
    updated_at: { type: DataTypes.DATE, allowNull: false },
  },
  { sequelize, tableName: 'project_invoices', timestamps: false },
);

export class MilestoneAmountModel extends Model<InferAttributes<MilestoneAmountModel>, InferCreationAttributes<MilestoneAmountModel>> {
  declare task_id: string;
  declare organization_id: string;
  declare project_id: string;
  declare amount_cents: number | string;
  declare billing_id: string | null;
  declare updated_by: string;
  declare updated_at: Date;
}

MilestoneAmountModel.init(
  {
    task_id: { type: DataTypes.CHAR(36), primaryKey: true },
    organization_id: { type: DataTypes.CHAR(36), allowNull: false },
    project_id: { type: DataTypes.CHAR(36), allowNull: false },
    amount_cents: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    billing_id: { type: DataTypes.CHAR(36), allowNull: true },
    updated_by: { type: DataTypes.CHAR(36), allowNull: false },
    updated_at: { type: DataTypes.DATE, allowNull: false },
  },
  { sequelize, tableName: 'milestone_amounts', timestamps: false },
);

// ── Reglas y formularios (migrations/20261109100000-rules-forms.cjs) ───────

export class ProjectRuleModel extends Model<InferAttributes<ProjectRuleModel>, InferCreationAttributes<ProjectRuleModel>> {
  declare id: string;
  declare organization_id: string;
  declare project_id: string;
  declare name: string;
  declare trigger_type: 'task_added' | 'task_moved' | 'task_completed';
  declare trigger_section_id: string | null;
  declare actions: unknown;
  declare enabled: boolean;
  declare run_count: number;
  declare last_run_at: Date | null;
  declare last_error: string | null;
  declare created_by: string;
  declare created_at: Date;
  declare updated_at: Date;
}

ProjectRuleModel.init(
  {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    organization_id: { type: DataTypes.CHAR(36), allowNull: false },
    project_id: { type: DataTypes.CHAR(36), allowNull: false },
    name: { type: DataTypes.STRING(120), allowNull: false },
    trigger_type: { type: DataTypes.ENUM('task_added', 'task_moved', 'task_completed'), allowNull: false },
    trigger_section_id: { type: DataTypes.CHAR(36), allowNull: true },
    actions: { type: DataTypes.JSON, allowNull: false },
    enabled: { type: DataTypes.BOOLEAN, allowNull: false },
    run_count: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    last_run_at: { type: DataTypes.DATE, allowNull: true },
    last_error: { type: DataTypes.STRING(500), allowNull: true },
    created_by: { type: DataTypes.CHAR(36), allowNull: false },
    created_at: { type: DataTypes.DATE, allowNull: false },
    updated_at: { type: DataTypes.DATE, allowNull: false },
  },
  { sequelize, tableName: 'project_rules', timestamps: false },
);

export class ProjectFormModel extends Model<InferAttributes<ProjectFormModel>, InferCreationAttributes<ProjectFormModel>> {
  declare id: string;
  declare organization_id: string;
  declare project_id: string;
  declare title: string;
  declare description: string | null;
  declare questions: unknown;
  declare section_id: string | null;
  declare assignee_user_id: string | null;
  declare enabled: boolean;
  declare submission_count: number;
  declare created_by: string;
  declare created_at: Date;
  declare updated_at: Date;
}

ProjectFormModel.init(
  {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    organization_id: { type: DataTypes.CHAR(36), allowNull: false },
    project_id: { type: DataTypes.CHAR(36), allowNull: false },
    title: { type: DataTypes.STRING(120), allowNull: false },
    description: { type: DataTypes.STRING(1000), allowNull: true },
    questions: { type: DataTypes.JSON, allowNull: false },
    section_id: { type: DataTypes.CHAR(36), allowNull: true },
    assignee_user_id: { type: DataTypes.CHAR(36), allowNull: true },
    enabled: { type: DataTypes.BOOLEAN, allowNull: false },
    submission_count: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    created_by: { type: DataTypes.CHAR(36), allowNull: false },
    created_at: { type: DataTypes.DATE, allowNull: false },
    updated_at: { type: DataTypes.DATE, allowNull: false },
  },
  { sequelize, tableName: 'project_forms', timestamps: false },
);
