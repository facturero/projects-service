/**
 * Modelo de Proyectos y tareas (al estilo Asana). Ficha completa: `servicios/projects-service.md` en la bóveda.
 *
 * Se trabaja con objetos planos y funciones puras (ver `access.ts`, `rank.ts`): el dominio son reglas de visibilidad y de orden,
 * no comportamiento de entidades, y así la copia en memoria de las pruebas y la de MySQL guardan exactamente lo mismo.
 */
export type Visibility = 'organization' | 'members';
export type ProjectRole = 'admin' | 'editor' | 'commenter' | 'viewer';
export type ProjectStatus = 'active' | 'archived';
export type ProjectView = 'list' | 'board';

export const VISIBILITIES: readonly Visibility[] = ['organization', 'members'];
export const PROJECT_ROLES: readonly ProjectRole[] = ['admin', 'editor', 'commenter', 'viewer'];
export const PROJECT_VIEWS: readonly ProjectView[] = ['list', 'board'];
/** Tokens del tema del frontend: nunca un hexadecimal (regla de UI-UX.md). */
export const PROJECT_COLORS = ['primary', 'secondary', 'success', 'warning', 'error', 'info'] as const;
export type ProjectColor = (typeof PROJECT_COLORS)[number];

export interface Project {
  id: string;
  organizationId: string;
  name: string;
  description: string | null;
  color: ProjectColor;
  icon: string;
  visibility: Visibility;
  ownerUserId: string;
  status: ProjectStatus;
  defaultView: ProjectView;
  /** Concurrencia optimista: cada escritura la sube; un PATCH con otra versión es 409. */
  version: number;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  /** Papelera: nada se borra de verdad. */
  deletedAt: Date | null;
}

export interface ProjectMember {
  projectId: string;
  organizationId: string;
  userId: string;
  role: ProjectRole;
  createdAt: Date;
}

export interface Section {
  id: string;
  organizationId: string;
  projectId: string;
  name: string;
  rank: string;
  createdAt: Date;
  updatedAt: Date;
}

export type TaskKind = 'task' | 'milestone' | 'approval';
export type ApprovalStatus = 'pending' | 'approved' | 'changes_requested' | 'rejected';
export type ApprovalDecision = 'approved' | 'changes_requested' | 'rejected';
export const TASK_KINDS: readonly TaskKind[] = ['task', 'milestone', 'approval'];
export const APPROVAL_DECISIONS: readonly ApprovalDecision[] = ['approved', 'changes_requested', 'rejected'];

/** Documento de TipTap ya validado por `richtext.ts` (lista blanca de nodos y marcas). */
export type RichDoc = Record<string, unknown>;

export interface Task {
  id: string;
  organizationId: string;
  /** Un solo nivel de subtareas: una subtarea no tiene subtareas (ver `SubtaskDepthError`). */
  parentTaskId: string | null;
  kind: TaskKind;
  /** Solo en tareas de aprobación: la decide su responsable. */
  approvalStatus: ApprovalStatus | null;
  title: string;
  /** Texto plano de la descripción (búsqueda, avisos). Si hay `descriptionDoc`, sale de él. */
  description: string | null;
  descriptionDoc: RichDoc | null;
  assigneeUserId: string | null;
  /** Cuándo se asignó al responsable actual: alimenta «Recién asignadas» de Mis tareas. */
  assignedAt: Date | null;
  /** Fechas sin hora, `YYYY-MM-DD`: una fecha de entrega no cambia de día por la zona horaria de quien la mira. */
  startOn: string | null;
  dueOn: string | null;
  /** «Tiempo estimado» de Asana, en minutos. Alimenta la carga de trabajo. */
  estimatedMinutes: number | null;
  completedAt: Date | null;
  completedBy: string | null;
  /** Orden entre hermanas (solo subtareas); las tareas raíz se ordenan por su `TaskPlacement.rank` en cada proyecto. */
  subtaskRank: string | null;
  createdBy: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

/**
 * Dónde aparece una tarea raíz: en qué proyecto, en qué sección y en qué posición. Una tarea puede estar en VARIOS proyectos a la
 * vez (multi-hogar de Asana): por eso la sección y el orden viven aquí y no en la tarea. Una tarea sin ninguna es personal («solo
 * mía»): la ven quien la creó y su responsable.
 */
export interface TaskPlacement {
  taskId: string;
  projectId: string;
  organizationId: string;
  sectionId: string;
  rank: string;
  createdAt: Date;
}

export interface Comment {
  id: string;
  organizationId: string;
  taskId: string;
  authorUserId: string;
  bodyDoc: RichDoc;
  bodyText: string;
  mentionedUserIds: string[];
  createdAt: Date;
  editedAt: Date | null;
  deletedAt: Date | null;
}

export interface Attachment {
  id: string;
  organizationId: string;
  taskId: string;
  /** El archivo vive en document-service: aquí solo la referencia y lo que se muestra sin pedirlo. */
  documentId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  uploadedBy: string;
  createdAt: Date;
  deletedAt: Date | null;
}

export type LikeTarget = 'task' | 'comment';

/** Una línea del historial de la tarea («Ana cambió la fecha de entrega»). Solo se escribe; nunca se edita. */
export interface Activity {
  id: string;
  organizationId: string;
  taskId: string;
  actorUserId: string | null;
  kind: string;
  data: Record<string, unknown>;
  at: Date;
}

/** «Esta tarea espera a aquella» (fin → inicio), como las dependencias de Asana. */
export interface Dependency {
  taskId: string;
  dependsOnTaskId: string;
  organizationId: string;
  createdAt: Date;
}

export type ProjectHealth = 'on_track' | 'at_risk' | 'off_track' | 'complete';
export const PROJECT_HEALTH: readonly ProjectHealth[] = ['on_track', 'at_risk', 'off_track', 'complete'];

/** Actualización de estado del proyecto («en riesgo: falta el proveedor»). Solo se agregan; la última es el estado actual. */
export interface StatusUpdate {
  id: string;
  organizationId: string;
  projectId: string;
  status: ProjectHealth;
  bodyDoc: RichDoc | null;
  bodyText: string | null;
  authorUserId: string;
  createdAt: Date;
}

// ── Entregable 4: vínculos con el ERP, etiquetas y campos personalizados ────

export type LinkEntity = 'customer' | 'invoice' | 'quote' | 'purchase_order' | 'product';
export const LINK_ENTITIES: readonly LinkEntity[] = ['customer', 'invoice', 'quote', 'purchase_order', 'product'];

/** «Esta tarea es de este cliente / esta factura / esta OC». `label` es el texto que se veía al vincular (este servicio no puede preguntarlo). */
export interface TaskLink {
  id: string;
  organizationId: string;
  taskId: string;
  entityType: LinkEntity;
  entityId: string;
  label: string;
  createdBy: string;
  createdAt: Date;
}

export interface Tag {
  id: string;
  organizationId: string;
  name: string;
  color: ProjectColor;
  createdBy: string;
  createdAt: Date;
}

export type FieldType = 'text' | 'number' | 'select' | 'date' | 'person';
export const FIELD_TYPES: readonly FieldType[] = ['text', 'number', 'select', 'date', 'person'];

export interface FieldOption {
  id: string;
  label: string;
  color: ProjectColor;
}

/** Campo personalizado de un proyecto (como en Asana: «Prioridad», «Presupuesto», «Etapa»…). */
export interface CustomField {
  id: string;
  organizationId: string;
  projectId: string;
  name: string;
  type: FieldType;
  /** Solo en `select`. */
  options: FieldOption[];
  rank: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Texto, número, fecha `YYYY-MM-DD`, id de una persona o id de una opción, según el tipo del campo. */
export type FieldValue = string | number;

export interface CustomFieldValue {
  taskId: string;
  fieldId: string;
  organizationId: string;
  value: FieldValue;
  updatedAt: Date;
}

// ── Horas y carga de trabajo (entregable 5) ─────────────────────────────────

export type TimeSource = 'manual' | 'timer';

/** Horas trabajadas en una tarea. `projectId`: el proyecto al que se cargan (una tarea puede estar en varios); null si es personal. */
export interface TimeEntry {
  id: string;
  organizationId: string;
  taskId: string;
  projectId: string | null;
  userId: string;
  /** Día trabajado, `YYYY-MM-DD` (sin hora: no cambia de día por la zona horaria). */
  workedOn: string;
  minutes: number;
  billable: boolean;
  note: string | null;
  source: TimeSource;
  /** La reserva o factura del proyecto que se llevó estas horas (entregable 6). Con ella el registro ya no se cambia. */
  billingId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** El cronómetro en marcha de una persona (uno a la vez, como en Asana). */
export interface RunningTimer {
  organizationId: string;
  userId: string;
  taskId: string;
  projectId: string | null;
  startedAt: Date;
}

/** Horas por semana de una persona para la carga de trabajo. Sin fila: 40 h. */
export interface MemberCapacity {
  organizationId: string;
  userId: string;
  weeklyMinutes: number;
  updatedBy: string;
  updatedAt: Date;
}

// ── Facturar el proyecto (entregable 6) ─────────────────────────────────────

/** A quién y cómo se factura un proyecto. Cliente y producto son de otros servicios: se guarda lo que se veía al elegirlos. */
export interface ProjectBilling {
  organizationId: string;
  projectId: string;
  customerId: string | null;
  customerLabel: string | null;
  hourlyRateCents: number | null;
  serviceProductId: string | null;
  serviceProductLabel: string | null;
  groupBy: 'task' | 'person' | 'single';
  updatedBy: string;
  updatedAt: Date;
}

/** Importe fijo de un hito; `billingId` si ya está reservado o facturado. */
export interface MilestoneAmount {
  organizationId: string;
  projectId: string;
  taskId: string;
  amountCents: number;
  billingId: string | null;
  updatedBy: string;
  updatedAt: Date;
}

export type ProjectInvoiceStatus = 'pending' | 'draft' | 'issued' | 'voided' | 'released';

/** Una factura del proyecto: reserva de horas e hitos, enlazada luego al borrador de billing-service. */
export interface ProjectInvoice {
  id: string;
  organizationId: string;
  projectId: string;
  invoiceId: string | null;
  status: ProjectInvoiceStatus;
  number: string | null;
  minutes: number;
  entryCount: number;
  milestoneCount: number;
  /** Subtotal sin impuestos que se calculó al reservar (el IVA lo pone billing según el producto). */
  amountCents: number;
  /** Lo que se llevó la reserva (para volver a tomarlo si un borrador liberado se emite igual). */
  entryIds: string[];
  milestoneTaskIds: string[];
  /** Horas o hitos que, al emitirse un borrador ya liberado, estaban en OTRA factura: hay que revisarlos. */
  conflicts: number;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Quién hace la petición: lo inyecta el gateway desde el token (`X-User-Id`, `X-Permissions`). */
export interface Actor {
  organizationId: string;
  userId: string;
  permissions: readonly string[];
  /**
   * Si la acción la hace una regla (entregable 7): su id. Lo que hace una regla NO dispara otras reglas (sin bucles: «al mover a Hecho,
   * mover a Revisión» y al revés).
   */
  viaRule?: string;
}
