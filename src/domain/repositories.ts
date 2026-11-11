import type {
  Activity,
  Attachment,
  Comment,
  CustomField,
  CustomFieldValue,
  Dependency,
  LinkEntity,
  LikeTarget,
  MemberCapacity,
  MilestoneAmount,
  Project,
  ProjectBilling,
  ProjectInvoice,
  ProjectMember,
  ProjectStatus,
  RunningTimer,
  Section,
  StatusUpdate,
  Tag,
  Task,
  TaskLink,
  TaskPlacement,
  TimeEntry,
} from './types.js';
import type { ProjectForm, ProjectRule } from './automation.js';

/**
 * Puertos de persistencia. Todo método filtra por organización: es la primera línea del aislamiento entre empresas (la segunda son
 * las reglas de `access.ts`). Nunca `upsert` en la implementación de MySQL: ver `persistence-guard.test.ts`.
 */
export interface ProjectRepository {
  findById(organizationId: string, id: string): Promise<Project | null>;
  /** Lectura con bloqueo (`FOR UPDATE`): serializa a quienes cambian el mismo proyecto para que la versión decida. */
  findByIdForUpdate(organizationId: string, id: string): Promise<Project | null>;
  /** Los que no están en la papelera, de toda la organización (la visibilidad la filtra `access.ts`). */
  listByIds(organizationId: string, ids: string[]): Promise<Project[]>;
  /**
   * Proyectos que el usuario puede ver: los de toda la organización, los privados donde es miembro y, con `allPrivate`, todos.
   * La consulta filtra en la base para no traer los privados ajenos.
   */
  listVisible(organizationId: string, userId: string, opts: { status: ProjectStatus; allPrivate: boolean }): Promise<Project[]>;
  /**
   * Lo contado de las tareas de cada proyecto, para su tarjeta en la lista. Una sola consulta agrupada para todos: con una por
   * proyecto, una organización con 40 proyectos haría 40 viajes a la base cada vez que alguien abre la lista. `today` es la fecha
   * local de la organización (qué cuenta como vencida). Un proyecto sin tareas no aparece en el mapa.
   */
  statsByProjects(organizationId: string, projectIds: string[], today: string): Promise<Map<string, ProjectTaskStats>>;
  save(project: Project): Promise<void>;
}

/** Tareas de primer nivel de un proyecto (las del tablero; las subtareas no cuentan, igual que en el panel). */
export interface ProjectTaskStats {
  total: number;
  completed: number;
  /** Abiertas con fecha de entrega anterior a hoy. */
  overdue: number;
  /** La fecha de entrega más cercana, de hoy en adelante, entre las abiertas. */
  nextDueOn: string | null;
}

export interface MemberRepository {
  listByProject(organizationId: string, projectId: string): Promise<ProjectMember[]>;
  find(organizationId: string, projectId: string, userId: string): Promise<ProjectMember | null>;
  /** La membresía del usuario en cada uno de esos proyectos (para calcular su rol en todos de una vez). */
  listForUser(organizationId: string, userId: string, projectIds: string[]): Promise<ProjectMember[]>;
  /** Los miembros de varios proyectos de una vez (para las caras de cada tarjeta de la lista). */
  listByProjects(organizationId: string, projectIds: string[]): Promise<ProjectMember[]>;
  save(member: ProjectMember): Promise<void>;
  remove(organizationId: string, projectId: string, userId: string): Promise<void>;
}

export interface SectionRepository {
  findById(organizationId: string, id: string): Promise<Section | null>;
  /** Ordenadas por rango. */
  listByProject(organizationId: string, projectId: string): Promise<Section[]>;
  save(section: Section): Promise<void>;
  delete(organizationId: string, id: string): Promise<void>;
}

export interface SubtaskCount {
  total: number;
  completed: number;
}

export interface TaskRepository {
  findById(organizationId: string, id: string): Promise<Task | null>;
  findByIdForUpdate(organizationId: string, id: string): Promise<Task | null>;
  findManyByIds(organizationId: string, ids: string[]): Promise<Task[]>;
  /** Subtareas vigentes (no en la papelera), por su orden entre hermanas. */
  listSubtasks(organizationId: string, parentTaskId: string): Promise<Task[]>;
  subtaskCounts(organizationId: string, parentTaskIds: string[]): Promise<Map<string, SubtaskCount>>;
  /** Mis tareas: las vigentes asignadas a esa persona; las completadas solo si `includeCompleted`. */
  listByAssignee(organizationId: string, userId: string, includeCompleted: boolean): Promise<Task[]>;
  /** Tareas raíz personales (sin proyecto) creadas por esa persona y sin responsable: también son «suyas» en Mis tareas. */
  listPersonalUnassigned(organizationId: string, userId: string, includeCompleted: boolean): Promise<Task[]>;
  /** Búsqueda por título o descripción (sin distinguir mayúsculas). Vivas; la visibilidad la filtra el caso de uso. */
  search(organizationId: string, query: string, limit: number): Promise<Task[]>;
  /** «Vence pronto», de TODAS las organizaciones: vivas, sin completar, con responsable y con entrega en alguna de esas fechas. */
  listDueOn(dates: string[]): Promise<Task[]>;
  /**
   * Carga de trabajo: vivas, sin completar, con responsable, que tocan el rango [from, to]: entrega desde `from` y empiezan (o, sin
   * inicio, vencen) hasta `to`. La visibilidad la filtra el caso de uso.
   */
  listScheduled(organizationId: string, from: string, to: string): Promise<Task[]>;
  save(task: Task): Promise<void>;
}

export interface CommentRepository {
  findById(organizationId: string, id: string): Promise<Comment | null>;
  /** Vivos y borrados (un comentario borrado deja su hueco: «Comentario eliminado»), por fecha. */
  listByTask(organizationId: string, taskId: string): Promise<Comment[]>;
  save(comment: Comment): Promise<void>;
}

export interface FollowerRepository {
  listByTask(organizationId: string, taskId: string): Promise<string[]>;
  isFollowing(organizationId: string, taskId: string, userId: string): Promise<boolean>;
  /** Idempotente: devuelve `false` si ya lo seguía. */
  add(organizationId: string, taskId: string, userId: string, at: Date): Promise<boolean>;
  /** Devuelve `false` si no lo seguía. */
  remove(organizationId: string, taskId: string, userId: string): Promise<boolean>;
}

export interface LikeRepository {
  /** Quién dio «me gusta» a cada uno de esos objetos. */
  usersFor(organizationId: string, target: LikeTarget, ids: string[]): Promise<Map<string, string[]>>;
  add(organizationId: string, target: LikeTarget, id: string, userId: string, at: Date): Promise<boolean>;
  remove(organizationId: string, target: LikeTarget, id: string, userId: string): Promise<boolean>;
}

export interface AttachmentRepository {
  findById(organizationId: string, id: string): Promise<Attachment | null>;
  /** Solo los vivos, por fecha. */
  listByTask(organizationId: string, taskId: string): Promise<Attachment[]>;
  save(attachment: Attachment): Promise<void>;
}

export interface ActivityRepository {
  add(activity: Activity): Promise<void>;
  listByTask(organizationId: string, taskId: string): Promise<Activity[]>;
}

export interface DependencyRepository {
  /** Lo que esperan esas tareas (aristas cuyo `taskId` está en la lista). */
  listDependsOn(organizationId: string, taskIds: string[]): Promise<Dependency[]>;
  /** A quién bloquean esas tareas (aristas cuyo `dependsOnTaskId` está en la lista). */
  listDependents(organizationId: string, taskIds: string[]): Promise<Dependency[]>;
  /** Idempotente: `false` si ya existía. */
  add(dependency: Dependency): Promise<boolean>;
  remove(organizationId: string, taskId: string, dependsOnTaskId: string): Promise<boolean>;
}

export interface StatusUpdateRepository {
  add(update: StatusUpdate): Promise<void>;
  /** Las más recientes primero. */
  listByProject(organizationId: string, projectId: string, limit: number): Promise<StatusUpdate[]>;
  /** La última de cada proyecto (para la lista de proyectos). */
  latestByProjects(organizationId: string, projectIds: string[]): Promise<Map<string, StatusUpdate>>;
}

export interface LinkRepository {
  listByTask(organizationId: string, taskId: string): Promise<TaskLink[]>;
  listByEntity(organizationId: string, entityType: LinkEntity, entityId: string): Promise<TaskLink[]>;
  findById(organizationId: string, id: string): Promise<TaskLink | null>;
  /** `false` si esa tarea ya estaba vinculada a esa misma cosa. */
  add(link: TaskLink): Promise<boolean>;
  remove(organizationId: string, id: string): Promise<boolean>;
}

export interface TagRepository {
  list(organizationId: string): Promise<Tag[]>;
  findById(organizationId: string, id: string): Promise<Tag | null>;
  /**
   * `lock`: lectura con bloqueo (ve lo último confirmado aunque la transacción ya tenga su foto). Se usa tras un `add` que no insertó
   * porque otra petición creó la misma etiqueta un instante antes.
   */
  findByName(organizationId: string, name: string, opts?: { lock?: boolean }): Promise<Tag | null>;
  /** `INSERT IGNORE` sobre el índice único (organización, nombre): false si ya existía una con ese nombre. */
  add(tag: Tag): Promise<boolean>;
  /** Etiquetas de cada tarea. */
  listForTasks(organizationId: string, taskIds: string[]): Promise<Map<string, Tag[]>>;
  attach(organizationId: string, taskId: string, tagId: string, at: Date): Promise<boolean>;
  detach(organizationId: string, taskId: string, tagId: string): Promise<boolean>;
  /** Cambia nombre y color. false si el nombre choca con otra etiqueta de la organización (índice único). */
  update(tag: Tag): Promise<boolean>;
  /** Borra la etiqueta; sus vínculos con tareas caen con ella (clave foránea en cascada). */
  remove(organizationId: string, id: string): Promise<boolean>;
  /** En cuántas tareas está cada etiqueta (para avisar antes de borrar una muy usada). */
  usage(organizationId: string): Promise<Map<string, number>>;
}

export interface FieldRepository {
  /** Por orden. */
  listByProjects(organizationId: string, projectIds: string[]): Promise<CustomField[]>;
  findById(organizationId: string, id: string): Promise<CustomField | null>;
  save(field: CustomField): Promise<void>;
  delete(organizationId: string, id: string): Promise<void>;
  valuesForTasks(organizationId: string, taskIds: string[]): Promise<CustomFieldValue[]>;
  valuesForField(organizationId: string, fieldId: string): Promise<CustomFieldValue[]>;
  setValue(value: CustomFieldValue): Promise<void>;
  clearValue(organizationId: string, taskId: string, fieldId: string): Promise<boolean>;
}

export interface TimeEntryFilter {
  userId?: string;
  projectId?: string;
  taskId?: string;
  /** Rango de días trabajados, inclusive. */
  from?: string;
  to?: string;
  billable?: boolean;
}

export interface TimeEntryRepository {
  findById(organizationId: string, id: string): Promise<TimeEntry | null>;
  /** Más recientes primero (día trabajado y luego creación). */
  list(organizationId: string, filter: TimeEntryFilter, limit: number): Promise<TimeEntry[]>;
  /** Minutos registrados por tarea («tiempo real» de Asana). */
  totalsByTask(organizationId: string, taskIds: string[]): Promise<Map<string, number>>;
  save(entry: TimeEntry): Promise<void>;
  delete(organizationId: string, id: string): Promise<boolean>;
  /** Facturables, cargadas al proyecto y sin reservar, en el rango (entregable 6). */
  listUnbilled(organizationId: string, projectId: string, range: { from?: string; to?: string }): Promise<TimeEntry[]>;
  /** Con `FOR UPDATE` y en orden de id (dos reservas a la vez se esperan en el mismo orden, sin deadlock). */
  findManyForUpdate(organizationId: string, ids: string[]): Promise<TimeEntry[]>;
  assignBilling(organizationId: string, ids: string[], billingId: string | null): Promise<void>;
  /** Suelta las horas de una reserva (anulada o liberada). */
  releaseBilling(organizationId: string, billingId: string): Promise<number>;
}

export interface TimerRepository {
  /**
   * `forUpdate`: lectura con bloqueo exclusivo (ordena dos «detener» simultáneos). `share`: con bloqueo compartido, para ver la fila
   * que otra transacción acaba de confirmar sin pedir el exclusivo (que tras un INSERT IGNORE fallido acaba en deadlock).
   */
  get(organizationId: string, userId: string, opts?: { forUpdate?: boolean; share?: boolean }): Promise<RunningTimer | null>;
  /** `INSERT IGNORE` por la clave (organización, usuario): false si ya había uno en marcha. */
  add(timer: RunningTimer): Promise<boolean>;
  /** Cambia el cronómetro existente a otra tarea (arrancar otro detiene el anterior). */
  replace(timer: RunningTimer): Promise<void>;
  remove(organizationId: string, userId: string): Promise<boolean>;
}

export interface BillingRepository {
  getSettings(organizationId: string, projectId: string): Promise<ProjectBilling | null>;
  /** Por clave primaria (proyecto): `INSERT IGNORE` y, si ya existía, `UPDATE`. */
  saveSettings(settings: ProjectBilling): Promise<void>;
  milestones(organizationId: string, projectId: string): Promise<MilestoneAmount[]>;
  findMilestone(organizationId: string, taskId: string): Promise<MilestoneAmount | null>;
  findMilestonesForUpdate(organizationId: string, taskIds: string[]): Promise<MilestoneAmount[]>;
  saveMilestone(milestone: MilestoneAmount): Promise<void>;
  deleteMilestone(organizationId: string, taskId: string): Promise<void>;
  assignMilestones(organizationId: string, taskIds: string[], billingId: string | null): Promise<void>;
  releaseMilestones(organizationId: string, billingId: string): Promise<number>;
  invoices(organizationId: string, projectId: string): Promise<ProjectInvoice[]>;
  findInvoice(organizationId: string, id: string, opts?: { forUpdate?: boolean }): Promise<ProjectInvoice | null>;
  /** La reserva enlazada a esa factura de billing-service (la usa el consumidor de eventos). */
  findByInvoiceId(organizationId: string, invoiceId: string, opts?: { forUpdate?: boolean }): Promise<ProjectInvoice | null>;
  saveInvoice(invoice: ProjectInvoice): Promise<void>;
}

export interface RuleRepository {
  listByProject(organizationId: string, projectId: string): Promise<ProjectRule[]>;
  findById(organizationId: string, id: string): Promise<ProjectRule | null>;
  save(rule: ProjectRule): Promise<void>;
  delete(organizationId: string, id: string): Promise<boolean>;
  /** Suma una ejecución (y deja el último error, o lo limpia). Con UPDATE atómico: dos ejecuciones a la vez no pierden la cuenta. */
  recordRun(organizationId: string, id: string, at: Date, error: string | null): Promise<void>;
}

export interface FormRepository {
  listByProject(organizationId: string, projectId: string): Promise<ProjectForm[]>;
  findById(organizationId: string, id: string): Promise<ProjectForm | null>;
  save(form: ProjectForm): Promise<void>;
  delete(organizationId: string, id: string): Promise<boolean>;
  incrementSubmissions(organizationId: string, id: string): Promise<void>;
}

export interface CapacityRepository {
  list(organizationId: string): Promise<MemberCapacity[]>;
  /** Por clave primaria (organización, usuario). No es un upsert: `INSERT IGNORE` y, si ya existía, `UPDATE`. */
  set(capacity: MemberCapacity): Promise<void>;
}

export interface ReminderRepository {
  /** Registra el aviso; `false` si ya existía (otra corrida lo mandó). Lo garantiza la clave primaria, no una lectura previa. */
  tryAdd(taskId: string, onDate: string, kind: 'today' | 'tomorrow', at: Date): Promise<boolean>;
}

export interface PlacementRepository {
  /** Lo que muestra el tablero: las tarjetas del proyecto cuya tarea no está en la papelera. */
  listByProject(organizationId: string, projectId: string): Promise<TaskPlacement[]>;
  listBySection(organizationId: string, sectionId: string): Promise<TaskPlacement[]>;
  listByTasks(organizationId: string, taskIds: string[]): Promise<TaskPlacement[]>;
  find(organizationId: string, taskId: string, projectId: string): Promise<TaskPlacement | null>;
  save(placement: TaskPlacement): Promise<void>;
}

/** Evento de dominio saliente: se guarda en `outbox_messages` en la misma transacción y el relay lo publica a RabbitMQ. */
export interface DomainEvent {
  eventId: string;
  aggregateType: string;
  aggregateId: string;
  type: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
}

export interface OutboxRepository {
  add(event: DomainEvent): Promise<void>;
}

export interface Repositories {
  projects: ProjectRepository;
  members: MemberRepository;
  sections: SectionRepository;
  tasks: TaskRepository;
  placements: PlacementRepository;
  comments: CommentRepository;
  followers: FollowerRepository;
  likes: LikeRepository;
  attachments: AttachmentRepository;
  activity: ActivityRepository;
  reminders: ReminderRepository;
  dependencies: DependencyRepository;
  statusUpdates: StatusUpdateRepository;
  links: LinkRepository;
  tags: TagRepository;
  fields: FieldRepository;
  timeEntries: TimeEntryRepository;
  timers: TimerRepository;
  capacity: CapacityRepository;
  billing: BillingRepository;
  rules: RuleRepository;
  forms: FormRepository;
  outbox: OutboxRepository;
}
