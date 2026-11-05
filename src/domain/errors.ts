export interface ErrorDetail {
  field: string;
  message: string;
}

export abstract class AppError extends Error {
  abstract readonly code: string;
  abstract readonly httpStatus: number;
  readonly details?: ErrorDetail[];

  constructor(message: string, details?: ErrorDetail[]) {
    super(message);
    this.name = new.target.name;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ValidationError extends AppError {
  readonly code = 'VALIDATION_ERROR';
  readonly httpStatus = 422;
  constructor(details: ErrorDetail[], message = 'La petición no es válida.') {
    super(message, details);
  }
}

export class OrganizationContextRequiredError extends AppError {
  readonly code = 'ORG_CONTEXT_REQUIRED';
  readonly httpStatus = 401;
  constructor(message = 'Falta el contexto de organización.') { super(message); }
}

export class UserContextRequiredError extends AppError {
  readonly code = 'USER_CONTEXT_REQUIRED';
  readonly httpStatus = 401;
  constructor(message = 'Falta el contexto de usuario.') { super(message); }
}

export class ForbiddenError extends AppError {
  readonly code = 'FORBIDDEN';
  readonly httpStatus = 403;
  constructor(message = 'Permiso insuficiente.') { super(message); }
}

/** Sí puede ver el proyecto o la tarea, pero su rol no le deja hacer ESO (p. ej. un comentarista que intenta mover una tarjeta). */
export class ProjectRoleError extends AppError {
  readonly code = 'PROJECT_ROLE_INSUFFICIENT';
  readonly httpStatus = 403;
  constructor(message = 'Tu rol en este proyecto no te permite hacer esto.') { super(message); }
}

/**
 * No existe, está en la papelera o es privado y no se es miembro: siempre el mismo 404. Un 403 diría que el proyecto privado
 * existe.
 */
export class ProjectNotFoundError extends AppError {
  readonly code = 'PROJECT_NOT_FOUND';
  readonly httpStatus = 404;
  constructor(message = 'Proyecto no encontrado.') { super(message); }
}

export class TaskNotFoundError extends AppError {
  readonly code = 'TASK_NOT_FOUND';
  readonly httpStatus = 404;
  constructor(message = 'Tarea no encontrada.') { super(message); }
}

export class SectionNotFoundError extends AppError {
  readonly code = 'SECTION_NOT_FOUND';
  readonly httpStatus = 404;
  constructor(message = 'Sección no encontrada.') { super(message); }
}

export class MemberNotFoundError extends AppError {
  readonly code = 'MEMBER_NOT_FOUND';
  readonly httpStatus = 404;
  constructor(message = 'Esa persona no es miembro del proyecto.') { super(message); }
}

export class MemberExistsError extends AppError {
  readonly code = 'MEMBER_EXISTS';
  readonly httpStatus = 409;
  constructor(message = 'Esa persona ya es miembro del proyecto.') { super(message); }
}

/** Otra persona cambió el proyecto o la tarea entre que se leyó y se guardó: se avisa en vez de pisar su cambio. */
export class VersionConflictError extends AppError {
  readonly code = 'VERSION_CONFLICT';
  readonly httpStatus = 409;
  constructor(readonly currentVersion: number) {
    super('Otra persona cambió esto mientras lo editabas. Se recargó la versión actual.', [
      { field: 'version', message: `La versión actual es la ${currentVersion}.` },
    ]);
  }
}

/** Un proyecto sin administrador no lo puede gestionar nadie salvo el Administrador de la organización. */
export class LastAdminError extends AppError {
  readonly code = 'LAST_PROJECT_ADMIN';
  readonly httpStatus = 409;
  constructor(message = 'El proyecto tiene que conservar al menos un administrador.') { super(message); }
}

export class LastSectionError extends AppError {
  readonly code = 'LAST_SECTION';
  readonly httpStatus = 409;
  constructor(message = 'Un proyecto necesita al menos una sección.') { super(message); }
}

export class SectionNotEmptyError extends AppError {
  readonly code = 'SECTION_NOT_EMPTY';
  readonly httpStatus = 409;
  constructor(message = 'La sección tiene tareas: indica a qué sección moverlas.') {
    super(message, [{ field: 'moveTasksTo', message }]);
  }
}

export class SubtaskDepthError extends AppError {
  readonly code = 'SUBTASK_DEPTH';
  readonly httpStatus = 422;
  constructor(message = 'Una subtarea no puede tener subtareas propias.') {
    super(message, [{ field: 'parentTaskId', message }]);
  }
}

/** Las vecinas que mandó el cliente (`beforeId` / `afterId`) no están en esa sección o no están en ese orden. */
export class InvalidPositionError extends AppError {
  readonly code = 'INVALID_POSITION';
  readonly httpStatus = 422;
  constructor(message = 'La posición indicada ya no es válida. Recarga e inténtalo de nuevo.') { super(message); }
}

export class ProjectArchivedError extends AppError {
  readonly code = 'PROJECT_ARCHIVED';
  readonly httpStatus = 409;
  constructor(message = 'El proyecto está archivado. Desarchívalo para cambiarlo.') { super(message); }
}

export class CommentNotFoundError extends AppError {
  readonly code = 'COMMENT_NOT_FOUND';
  readonly httpStatus = 404;
  constructor(message = 'Comentario no encontrado.') { super(message); }
}

export class AttachmentNotFoundError extends AppError {
  readonly code = 'ATTACHMENT_NOT_FOUND';
  readonly httpStatus = 404;
  constructor(message = 'Adjunto no encontrado.') { super(message); }
}

/** A espera a B y B (directa o indirectamente) espera a A: nadie podría empezar nunca. */
export class DependencyCycleError extends AppError {
  readonly code = 'DEPENDENCY_CYCLE';
  readonly httpStatus = 422;
  constructor(message = 'Esa dependencia crearía un ciclo: una tarea terminaría esperándose a sí misma.') {
    super(message, [{ field: 'dependsOnTaskId', message }]);
  }
}

export class TimeEntryNotFoundError extends AppError {
  readonly code = 'TIME_ENTRY_NOT_FOUND';
  readonly httpStatus = 404;
  constructor(message = 'Registro de horas no encontrado.') { super(message); }
}

export class TimerNotRunningError extends AppError {
  readonly code = 'TIMER_NOT_RUNNING';
  readonly httpStatus = 409;
  constructor(message = 'No tienes un cronómetro en marcha.') { super(message); }
}

/** Horas o un hito ya reservados o facturados: cambiarlos descuadraría la factura (entregable 6). */
export class AlreadyBilledError extends AppError {
  readonly code = 'ALREADY_BILLED';
  readonly httpStatus = 409;
  constructor(message = 'Ya está en una factura del proyecto: no se puede cambiar. Anula o libera esa factura primero.') { super(message); }
}

export class NothingToBillError extends AppError {
  readonly code = 'NOTHING_TO_BILL';
  readonly httpStatus = 409;
  constructor(message = 'No hay horas ni hitos por facturar con esos criterios (quizá otra persona acaba de facturarlos).') { super(message); }
}

export class BillingNotConfiguredError extends AppError {
  readonly code = 'BILLING_NOT_CONFIGURED';
  readonly httpStatus = 422;
  constructor(message: string) { super(message, [{ field: 'billing', message }]); }
}

export class ProjectInvoiceNotFoundError extends AppError {
  readonly code = 'PROJECT_INVOICE_NOT_FOUND';
  readonly httpStatus = 404;
  constructor(message = 'Factura del proyecto no encontrada.') { super(message); }
}
