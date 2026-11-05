import type { Context } from 'hono';
import { z } from 'zod';
import { ValidationError } from '../../domain/errors.js';
import {
  APPROVAL_DECISIONS,
  type ApprovalDecision,
  FIELD_TYPES,
  type FieldType,
  LINK_ENTITIES,
  type LinkEntity,
  PROJECT_COLORS,
  PROJECT_HEALTH,
  type ProjectHealth,
  PROJECT_ROLES,
  PROJECT_VIEWS,
  type ProjectRole,
  type ProjectView,
  TASK_KINDS,
  type TaskKind,
  VISIBILITIES,
  type Visibility,
} from '../../domain/types.js';

const uuid = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida (AAAA-MM-DD).');
const name = z.string().trim().min(1, 'Obligatorio.').max(120, 'Máximo 120 caracteres.');
const description = z.string().max(20_000, 'Máximo 20 000 caracteres.').nullable();
const icon = z.string().regex(/^mdi-[a-z0-9-]+$/, 'Icono inválido.');

export const createProjectSchema = z.object({
  name,
  description: description.optional(),
  color: z.enum(PROJECT_COLORS).optional(),
  icon: icon.optional(),
  visibility: z.enum(VISIBILITIES as [Visibility, ...Visibility[]]),
  defaultView: z.enum(PROJECT_VIEWS as [ProjectView, ...ProjectView[]]).optional(),
  sectionNames: z.array(name).min(1, 'Al menos una sección.').max(20, 'Máximo 20 secciones.'),
});

export const updateProjectSchema = z.object({
  version: z.number().int().positive(),
  name: name.optional(),
  description: description.optional(),
  color: z.enum(PROJECT_COLORS).optional(),
  icon: icon.optional(),
  visibility: z.enum(VISIBILITIES as [Visibility, ...Visibility[]]).optional(),
  defaultView: z.enum(PROJECT_VIEWS as [ProjectView, ...ProjectView[]]).optional(),
});

const role = z.enum(PROJECT_ROLES as [ProjectRole, ...ProjectRole[]]);
export const addMemberSchema = z.object({ userId: uuid, role });
export const updateMemberSchema = z.object({ role });

const position = {
  beforeId: uuid.nullable().optional(),
  afterId: uuid.nullable().optional(),
};

export const createSectionSchema = z.object({ name, ...position });
export const renameSectionSchema = z.object({ name });
export const moveSectionSchema = z.object(position);

const title = z.string().trim().min(1, 'Obligatorio.').max(500, 'Máximo 500 caracteres.');

// El documento de TipTap llega como objeto y lo valida el dominio (`richtext.ts`, lista blanca): aquí solo se exige que sea un objeto.
const richDoc = z.record(z.unknown());

/** Tiempo estimado: hasta 10 000 h, que ya es un proyecto, no una tarea. */
const minutesEstimate = z.number().int().min(0).max(600_000);

export const createTaskSchema = z.object({
  title,
  description: description.optional(),
  descriptionDoc: richDoc.nullable().optional(),
  kind: z.enum(TASK_KINDS as [TaskKind, ...TaskKind[]]).optional(),
  assigneeUserId: uuid.nullable().optional(),
  startOn: date.nullable().optional(),
  dueOn: date.nullable().optional(),
  estimatedMinutes: minutesEstimate.nullable().optional(),
  projectId: uuid.nullable().optional(),
  sectionId: uuid.nullable().optional(),
  parentTaskId: uuid.nullable().optional(),
  ...position,
});

export const updateTaskSchema = z.object({
  version: z.number().int().positive(),
  kind: z.enum(TASK_KINDS as [TaskKind, ...TaskKind[]]).optional(),
  title: title.optional(),
  description: description.optional(),
  descriptionDoc: richDoc.nullable().optional(),
  assigneeUserId: uuid.nullable().optional(),
  startOn: date.nullable().optional(),
  dueOn: date.nullable().optional(),
  estimatedMinutes: minutesEstimate.nullable().optional(),
});

export const moveTaskSchema = z.object({
  version: z.number().int().positive(),
  projectId: uuid,
  sectionId: uuid,
  ...position,
});

export const commentSchema = z.object({ bodyDoc: richDoc });
export const followerSchema = z.object({ userId: uuid });
export const attachmentSchema = z.object({
  documentId: uuid,
  fileName: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().min(1).max(150),
  // 100 MB: el tope lo pone document-service al firmar la subida; esto solo evita números absurdos.
  sizeBytes: z.number().int().min(0).max(100 * 1024 * 1024),
});
export const dependencySchema = z.object({ dependsOnTaskId: uuid });
export const statusUpdateSchema = z.object({
  status: z.enum(PROJECT_HEALTH as [ProjectHealth, ...ProjectHealth[]]),
  bodyDoc: richDoc.nullable().optional(),
});
export const linkSchema = z.object({
  entityType: z.enum(LINK_ENTITIES as [LinkEntity, ...LinkEntity[]]),
  entityId: uuid,
  label: z.string().trim().min(1).max(200),
});
export const tagSchema = z.object({ name: z.string().trim().min(1).max(60), color: z.enum(PROJECT_COLORS).optional() });
export const taskTagSchema = z.object({ tagId: uuid });
const option = z.object({ id: uuid.nullable().optional(), label: z.string(), color: z.string().nullable().optional() });
export const createFieldSchema = z.object({
  name: z.string().trim().min(1).max(60),
  type: z.enum(FIELD_TYPES as [FieldType, ...FieldType[]]),
  options: z.array(option).max(50).optional(),
});
export const updateFieldSchema = z.object({ name: z.string().trim().min(1).max(60).optional(), options: z.array(option).max(50).optional() });
export const fieldValueSchema = z.object({ value: z.union([z.string(), z.number(), z.null()]) });
export const fromTemplateSchema = z.object({
  templateCode: z.string().min(1).max(60),
  name: z.string().trim().max(120).optional(),
  visibility: z.enum(VISIBILITIES as [Visibility, ...Visibility[]]),
  startOn: date,
  locale: z.enum(['es', 'en', 'fr']).default('es'),
});
export const duplicateSchema = z.object({ name: z.string().trim().max(120).optional() });
export const bulkSchema = z.object({
  taskIds: z.array(uuid).min(1).max(100),
  action: z.discriminatedUnion('type', [
    z.object({ type: z.literal('complete') }),
    z.object({ type: z.literal('reopen') }),
    z.object({ type: z.literal('delete') }),
    z.object({ type: z.literal('assign'), assigneeUserId: uuid.nullable() }),
    z.object({ type: z.literal('due'), dueOn: date.nullable() }),
    z.object({ type: z.literal('move'), projectId: uuid, sectionId: uuid }),
    z.object({ type: z.literal('tag'), tagId: uuid }),
  ]),
});

export const decisionSchema = z.object({ decision: z.enum(APPROVAL_DECISIONS as [ApprovalDecision, ...ApprovalDecision[]]) });

/** Lee y valida el cuerpo JSON. Un error de forma sale como 422 con el detalle por campo, igual que en el resto de servicios. */
export async function parseBody<S extends z.ZodTypeAny>(c: Context, schema: S): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ValidationError([{ field: 'body', message: 'El cuerpo debe ser JSON.' }]);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues.map((i) => ({ field: i.path.join('.') || 'body', message: i.message })));
  }
  return parsed.data;
}

/** Los ids de la ruta también se validan: un id que no es uuid es 404, no un error de la base. */
export function isUuid(value: string | undefined): value is string {
  return !!value && uuid.safeParse(value).success;
}

// ── Horas y carga de trabajo (entregable 5) ─────────────────────────────────

const minutes = z.number().int().min(1).max(24 * 60);
const note = z.string().max(500).nullable().optional();

export const logTimeSchema = z.object({
  taskId: uuid,
  workedOn: date,
  minutes,
  billable: z.boolean().optional(),
  note,
  projectId: uuid.nullable().optional(),
});

export const updateTimeSchema = z.object({
  workedOn: date.optional(),
  minutes: minutes.optional(),
  billable: z.boolean().optional(),
  note,
  projectId: uuid.nullable().optional(),
});

export const startTimerSchema = z.object({
  taskId: uuid,
  projectId: uuid.nullable().optional(),
  /** Día local en que arrancó el cronómetro anterior, si este lo detiene. */
  previousWorkedOn: date.optional(),
});

export const stopTimerSchema = z.object({ workedOn: date.optional(), billable: z.boolean().optional(), note });

export const capacitySchema = z.object({ weeklyMinutes: z.number().int().min(0).max(7 * 24 * 60) });

// ── Facturar el proyecto (entregable 6) ─────────────────────────────────────

const groupBy = z.enum(['task', 'person', 'single']);
const cents = z.number().int().min(0).max(10_000_000);

export const billingSettingsSchema = z.object({
  customerId: uuid.nullable(),
  customerLabel: z.string().max(300).nullable().optional(),
  hourlyRateCents: cents.nullable(),
  serviceProductId: uuid.nullable(),
  serviceProductLabel: z.string().max(255).nullable().optional(),
  groupBy,
});

export const milestoneAmountSchema = z.object({ amountCents: cents.nullable() });

export const billingCriteriaSchema = z.object({
  from: date.optional(),
  to: date.optional(),
  includeHours: z.boolean(),
  milestoneTaskIds: z.array(uuid).max(200).default([]),
  groupBy: groupBy.optional(),
});

export const attachInvoiceSchema = z.object({ invoiceId: uuid });

// ── Reglas y formularios (entregable 7): la forma; el detalle de acciones y preguntas lo valida el dominio (automation.ts) ──

export const ruleSchema = z.object({
  name: z.string().max(120),
  trigger: z.enum(['task_added', 'task_moved', 'task_completed']),
  triggerSectionId: uuid.nullable().default(null),
  actions: z.array(z.record(z.unknown())).min(1).max(5),
  enabled: z.boolean().default(true),
});

export const formSchema = z.object({
  title: z.string().max(120),
  description: z.string().max(1000).nullable().default(null),
  questions: z.array(z.record(z.unknown())).max(20),
  sectionId: uuid.nullable().default(null),
  assigneeUserId: uuid.nullable().default(null),
  enabled: z.boolean().default(true),
});

export const submitFormSchema = z.object({ title: z.string().max(500), answers: z.record(z.string().max(4000)).default({}) });
