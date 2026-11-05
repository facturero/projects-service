import { ValidationError } from './errors.js';

/**
 * Reglas y formularios (entregable 7), tipos y validación pura.
 *
 * Una regla es «cuando pase X en este proyecto, haz Y», como las de Asana. Las acciones son pocas y concretas a propósito: cada una
 * corre por el mismo caso de uso que si la hiciera una persona (con sus eventos, avisos e historial), así una regla nunca deja una
 * tarea en un estado que a mano no se podría.
 */

export type RuleTrigger = 'task_added' | 'task_moved' | 'task_completed';
export const RULE_TRIGGERS: readonly RuleTrigger[] = ['task_added', 'task_moved', 'task_completed'];

export type RuleAction =
  | { type: 'assign'; userId: string | null }
  | { type: 'set_due'; days: number }
  | { type: 'move_to_section'; sectionId: string }
  | { type: 'complete' }
  | { type: 'add_tag'; tagId: string }
  | { type: 'add_follower'; userId: string };

export const MAX_RULE_ACTIONS = 5;
export const MAX_RULES_PER_PROJECT = 50;

export interface ProjectRule {
  id: string;
  organizationId: string;
  projectId: string;
  name: string;
  trigger: RuleTrigger;
  /** Solo en esa sección (agregada en / movida a). Sin ella, en cualquiera. «Completada» no lo usa. */
  triggerSectionId: string | null;
  actions: RuleAction[];
  enabled: boolean;
  runCount: number;
  lastRunAt: Date | null;
  lastError: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Lo que dispara las reglas: lo emite TaskUseCases tras confirmar el cambio. */
export interface RuleEvent {
  trigger: RuleTrigger;
  projectId: string;
  taskId: string;
  /** Sección a la que se agregó o movió la tarea. */
  sectionId: string | null;
}

export function ruleMatches(rule: ProjectRule, event: RuleEvent): boolean {
  if (!rule.enabled || rule.projectId !== event.projectId || rule.trigger !== event.trigger) return false;
  if (rule.trigger === 'task_completed' || !rule.triggerSectionId) return true;
  return rule.triggerSectionId === event.sectionId;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Normaliza y valida las acciones; las secciones tienen que ser de este proyecto. */
export function validateActions(raw: unknown, sectionIds: Set<string>): RuleAction[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_RULE_ACTIONS) {
    throw new ValidationError([{ field: 'actions', message: `Entre 1 y ${MAX_RULE_ACTIONS} acciones.` }]);
  }
  return raw.map((a, i): RuleAction => {
    const field = `actions[${i}]`;
    const bad = (message: string) => new ValidationError([{ field, message }]);
    const x = (a ?? {}) as Record<string, unknown>;
    switch (x.type) {
      case 'assign':
        if (x.userId !== null && (typeof x.userId !== 'string' || !UUID.test(x.userId))) throw bad('Persona inválida.');
        return { type: 'assign', userId: (x.userId as string | null) ?? null };
      case 'set_due':
        if (!Number.isInteger(x.days) || (x.days as number) < 0 || (x.days as number) > 365) throw bad('Entre 0 y 365 días.');
        return { type: 'set_due', days: x.days as number };
      case 'move_to_section':
        if (typeof x.sectionId !== 'string' || !sectionIds.has(x.sectionId)) throw bad('La sección no es de este proyecto.');
        return { type: 'move_to_section', sectionId: x.sectionId };
      case 'complete':
        return { type: 'complete' };
      case 'add_tag':
        if (typeof x.tagId !== 'string' || !UUID.test(x.tagId)) throw bad('Etiqueta inválida.');
        return { type: 'add_tag', tagId: x.tagId };
      case 'add_follower':
        if (typeof x.userId !== 'string' || !UUID.test(x.userId)) throw bad('Persona inválida.');
        return { type: 'add_follower', userId: x.userId };
      default:
        throw bad('Acción desconocida.');
    }
  });
}

// ── Formularios ─────────────────────────────────────────────────────────────

export type QuestionType = 'text' | 'long_text' | 'date' | 'select';

export interface FormQuestion {
  id: string;
  label: string;
  type: QuestionType;
  required: boolean;
  /** Solo en `select`. */
  options: string[];
  /** Una pregunta de fecha puede ser la fecha de entrega de la tarea. */
  mapsToDue: boolean;
}

export interface ProjectForm {
  id: string;
  organizationId: string;
  projectId: string;
  title: string;
  description: string | null;
  questions: FormQuestion[];
  /** Sección donde caen las solicitudes (sin ella, la primera). */
  sectionId: string | null;
  /** Responsable que recibe cada solicitud. */
  assigneeUserId: string | null;
  enabled: boolean;
  submissionCount: number;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export const MAX_QUESTIONS = 20;

export function validateQuestions(raw: unknown, newId: () => string): FormQuestion[] {
  if (!Array.isArray(raw) || raw.length > MAX_QUESTIONS) throw new ValidationError([{ field: 'questions', message: `Hasta ${MAX_QUESTIONS} preguntas.` }]);
  let dueMapped = false;
  return raw.map((q, i): FormQuestion => {
    const x = (q ?? {}) as Record<string, unknown>;
    const field = `questions[${i}]`;
    const label = typeof x.label === 'string' ? x.label.trim() : '';
    if (!label || label.length > 200) throw new ValidationError([{ field, message: 'Cada pregunta necesita un texto (hasta 200 caracteres).' }]);
    const type = x.type as QuestionType;
    if (!['text', 'long_text', 'date', 'select'].includes(type)) throw new ValidationError([{ field, message: 'Tipo de pregunta inválido.' }]);
    const options = type === 'select' && Array.isArray(x.options) ? [...new Set(x.options.map((o) => String(o).trim()).filter(Boolean))].slice(0, 30) : [];
    if (type === 'select' && options.length === 0) throw new ValidationError([{ field, message: 'Una lista necesita al menos una opción.' }]);
    const mapsToDue = type === 'date' && x.mapsToDue === true && !dueMapped;
    if (mapsToDue) dueMapped = true;
    return {
      id: typeof x.id === 'string' && UUID.test(x.id) ? x.id : newId(),
      label,
      type,
      required: x.required === true,
      options,
      mapsToDue,
    };
  });
}

/**
 * De las respuestas a la tarea: el título lo escribe quien pide (siempre), y cada pregunta respondida va como un párrafo
 * «Pregunta: respuesta» en la descripción. La fecha marcada como entrega pasa a `dueOn`.
 */
export function answersToTask(questions: FormQuestion[], title: unknown, answers: unknown): { title: string; lines: string[]; dueOn: string | null } {
  const t = typeof title === 'string' ? title.trim() : '';
  if (!t || t.length > 500) throw new ValidationError([{ field: 'title', message: 'Escribe qué necesitas (hasta 500 caracteres).' }]);
  const a = (answers && typeof answers === 'object' ? answers : {}) as Record<string, unknown>;
  const lines: string[] = [];
  let dueOn: string | null = null;
  for (const q of questions) {
    const raw = a[q.id];
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value) {
      if (q.required) throw new ValidationError([{ field: `answers.${q.id}`, message: `«${q.label}» es obligatoria.` }]);
      continue;
    }
    if (value.length > 4000) throw new ValidationError([{ field: `answers.${q.id}`, message: 'Respuesta demasiado larga.' }]);
    if (q.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new ValidationError([{ field: `answers.${q.id}`, message: 'Fecha inválida.' }]);
    if (q.type === 'select' && !q.options.includes(value)) throw new ValidationError([{ field: `answers.${q.id}`, message: 'Opción inválida.' }]);
    if (q.mapsToDue) dueOn = value;
    lines.push(`${q.label}: ${value}`);
  }
  return { title: t, lines, dueOn };
}
