import {
  answersToTask,
  MAX_RULES_PER_PROJECT,
  RULE_TRIGGERS,
  ruleMatches,
  validateActions,
  validateQuestions,
  type ProjectForm,
  type ProjectRule,
  type RuleAction,
  type RuleEvent,
  type RuleTrigger,
} from '../../domain/automation.js';
import { atLeast, PERMISSION_CREATE, PERMISSION_READ } from '../../domain/access.js';
import { AppError, ProjectRoleError, ValidationError } from '../../domain/errors.js';
import type { Repositories } from '../../domain/repositories.js';
import type { Actor, Project } from '../../domain/types.js';
import { addDaysIso } from '../../domain/workload.js';
import { loadProject } from '../access-context.js';
import { recordActivity } from '../activity.js';
import { formDeletedEvent, formSavedEvent, formSubmittedEvent, ruleAppliedEvent, ruleDeletedEvent, ruleSavedEvent } from '../events.js';
import { type Clock, type IdGenerator, inTransaction, type UnitOfWorkGateway } from '../ports.js';
import type { CollaborationUseCases } from './collaboration-use-cases.js';
import type { OrganizeUseCases } from './organize-use-cases.js';
import type { TaskUseCases } from './task-use-cases.js';

export class RuleNotFoundError extends AppError {
  readonly code = 'RULE_NOT_FOUND';
  readonly httpStatus = 404;
  constructor(message = 'Regla no encontrada.') { super(message); }
}

export class FormNotFoundError extends AppError {
  readonly code = 'FORM_NOT_FOUND';
  readonly httpStatus = 404;
  constructor(message = 'Formulario no encontrado o cerrado.') { super(message); }
}

export interface RuleInput {
  name: string;
  trigger: RuleTrigger;
  triggerSectionId: string | null;
  actions: unknown;
  enabled: boolean;
}

export interface FormInput {
  title: string;
  description: string | null;
  questions: unknown;
  sectionId: string | null;
  assigneeUserId: string | null;
  enabled: boolean;
}

export interface PublicForm {
  form: ProjectForm;
  projectName: string;
}

/** Quien «hace» lo que hace la regla: su creador, con lo mínimo. Lo demás lo decide su rol en el proyecto, como a mano. */
function ruleActor(rule: ProjectRule): Actor {
  return { organizationId: rule.organizationId, userId: rule.createdBy, permissions: [PERMISSION_READ, PERMISSION_CREATE], viaRule: rule.id };
}

/**
 * Reglas y formularios (entregable 7), como en Asana.
 *
 * - Reglas: las definen y cambian los editores del proyecto; las ven sus miembros. Corren tras confirmar el cambio que las disparó, a
 *   nombre de quien las creó y por los MISMOS casos de uso que una persona (así respetan roles, versión, eventos y avisos). Lo que
 *   hace una regla no dispara otras.
 * - Formularios: los definen los editores; los llena cualquiera de la organización (aunque no sea miembro). La solicitud se crea a
 *   nombre de quien hizo el formulario y quien la envió queda como seguidor: así ve SU tarea y sus comentarios, no todo el proyecto.
 */
export class AutomationUseCases {
  constructor(
    private readonly gateway: UnitOfWorkGateway,
    private readonly repos: Repositories,
    private readonly tasks: TaskUseCases,
    private readonly organize: OrganizeUseCases,
    private readonly collaboration: CollaborationUseCases,
    private readonly clock: Clock,
    private readonly newId: IdGenerator,
  ) {}

  // ── Reglas ────────────────────────────────────────────────────────────────

  async listRules(actor: Actor, projectId: string): Promise<ProjectRule[]> {
    const { project } = await loadProject(this.repos, actor, projectId);
    return this.repos.rules.listByProject(actor.organizationId, project.id);
  }

  async createRule(actor: Actor, projectId: string, input: RuleInput): Promise<ProjectRule> {
    return inTransaction(this.gateway, async (uow) => {
      const project = await this.editableProject(uow, actor, projectId);
      if ((await uow.rules.listByProject(actor.organizationId, project.id)).length >= MAX_RULES_PER_PROJECT) {
        throw new ValidationError([{ field: 'rules', message: `Hasta ${MAX_RULES_PER_PROJECT} reglas por proyecto.` }]);
      }
      const now = this.clock();
      const rule: ProjectRule = {
        id: this.newId(),
        organizationId: actor.organizationId,
        projectId: project.id,
        ...(await this.checkedRule(uow, project, input)),
        runCount: 0,
        lastRunAt: null,
        lastError: null,
        createdBy: actor.userId,
        createdAt: now,
        updatedAt: now,
      };
      await uow.rules.save(rule);
      await uow.outbox.add(ruleSavedEvent(rule, true));
      return rule;
    });
  }

  /** Quien la cambia pasa a ser su dueño: la regla corre con SU rol (como en Asana, que la firma quien la edita por última vez). */
  async updateRule(actor: Actor, ruleId: string, input: RuleInput): Promise<ProjectRule> {
    return inTransaction(this.gateway, async (uow) => {
      const current = await uow.rules.findById(actor.organizationId, ruleId);
      if (!current) throw new RuleNotFoundError();
      const project = await this.editableProject(uow, actor, current.projectId);
      const rule: ProjectRule = { ...current, ...(await this.checkedRule(uow, project, input)), createdBy: actor.userId, lastError: null, updatedAt: this.clock() };
      await uow.rules.save(rule);
      await uow.outbox.add(ruleSavedEvent(rule, false));
      return rule;
    });
  }

  async deleteRule(actor: Actor, ruleId: string): Promise<void> {
    await inTransaction(this.gateway, async (uow) => {
      const rule = await uow.rules.findById(actor.organizationId, ruleId);
      if (!rule) throw new RuleNotFoundError();
      await this.editableProject(uow, actor, rule.projectId);
      await uow.rules.delete(actor.organizationId, rule.id);
      await uow.outbox.add(ruleDeletedEvent(rule));
    });
  }

  /** Lo llama TaskUseCases tras confirmar un cambio. Nunca lanza: el error queda en la regla (`last_error`) y en la bitácora. */
  async run(actor: Actor, events: RuleEvent[]): Promise<void> {
    for (const event of events) {
      const rules = (await this.repos.rules.listByProject(actor.organizationId, event.projectId)).filter((r) => ruleMatches(r, event));
      for (const rule of rules) {
        let error: string | null = null;
        const as = ruleActor(rule);
        try {
          for (const action of rule.actions) await this.apply(as, rule, event, action);
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
        }
        try {
          await inTransaction(this.gateway, async (uow) => {
            await uow.rules.recordRun(rule.organizationId, rule.id, this.clock(), error);
            const task = await uow.tasks.findById(rule.organizationId, event.taskId);
            if (task) await recordActivity(uow, as, task, 'rule_applied', { rule: rule.name, error }, this.clock());
            await uow.outbox.add(ruleAppliedEvent(rule, event.taskId, error));
          });
        } catch (err) {
          console.error('[projects-service] no se pudo registrar la ejecución de la regla', rule.id, err);
        }
      }
    }
  }

  private async apply(as: Actor, rule: ProjectRule, event: RuleEvent, action: RuleAction): Promise<void> {
    const fresh = async () => {
      const t = await this.repos.tasks.findById(as.organizationId, event.taskId);
      if (!t || t.deletedAt) throw new ValidationError([{ field: 'taskId', message: 'La tarea ya no existe.' }]);
      return t;
    };
    switch (action.type) {
      case 'assign': {
        const t = await fresh();
        if (t.assigneeUserId !== action.userId) await this.tasks.update(as, t.id, { version: t.version, assigneeUserId: action.userId });
        return;
      }
      case 'set_due': {
        const t = await fresh();
        const due = addDaysIso(this.clock().toISOString().slice(0, 10), action.days);
        const startOn = t.startOn && t.startOn > due ? null : undefined;
        await this.tasks.update(as, t.id, { version: t.version, dueOn: due, ...(startOn === null ? { startOn: null } : {}) });
        return;
      }
      case 'move_to_section': {
        const t = await fresh();
        const placement = (await this.repos.placements.listByTasks(as.organizationId, [t.id])).find((p) => p.projectId === rule.projectId);
        if (placement && placement.sectionId !== action.sectionId) {
          await this.tasks.move(as, t.id, { version: t.version, projectId: rule.projectId, sectionId: action.sectionId });
        }
        return;
      }
      case 'complete':
        await this.tasks.complete(as, event.taskId);
        return;
      case 'add_tag':
        await this.organize.setTag(as, event.taskId, action.tagId, true);
        return;
      case 'add_follower':
        await this.collaboration.addFollower(as, event.taskId, action.userId);
        return;
    }
  }

  private async checkedRule(repos: Repositories, project: Project, input: RuleInput) {
    const name = input.name.trim();
    if (!name || name.length > 120) throw new ValidationError([{ field: 'name', message: 'Entre 1 y 120 caracteres.' }]);
    if (!RULE_TRIGGERS.includes(input.trigger)) throw new ValidationError([{ field: 'trigger', message: 'Disparador inválido.' }]);
    const sectionIds = new Set((await repos.sections.listByProject(project.organizationId, project.id)).map((s) => s.id));
    if (input.triggerSectionId && !sectionIds.has(input.triggerSectionId)) {
      throw new ValidationError([{ field: 'triggerSectionId', message: 'La sección no es de este proyecto.' }]);
    }
    return {
      name,
      trigger: input.trigger,
      triggerSectionId: input.trigger === 'task_completed' ? null : input.triggerSectionId,
      actions: validateActions(input.actions, sectionIds),
      enabled: input.enabled,
    };
  }

  private async editableProject(repos: Repositories, actor: Actor, projectId: string): Promise<Project> {
    const { project, role } = await loadProject(repos, actor, projectId);
    if (!atLeast(role, 'editor')) throw new ProjectRoleError();
    return project;
  }

  // ── Formularios ───────────────────────────────────────────────────────────

  async listForms(actor: Actor, projectId: string): Promise<ProjectForm[]> {
    const project = await this.editableProject(this.repos, actor, projectId);
    return this.repos.forms.listByProject(actor.organizationId, project.id);
  }

  async createForm(actor: Actor, projectId: string, input: FormInput): Promise<ProjectForm> {
    return inTransaction(this.gateway, async (uow) => {
      const project = await this.editableProject(uow, actor, projectId);
      const now = this.clock();
      const form: ProjectForm = {
        id: this.newId(),
        organizationId: actor.organizationId,
        projectId: project.id,
        ...(await this.checkedForm(uow, project, input)),
        submissionCount: 0,
        createdBy: actor.userId,
        createdAt: now,
        updatedAt: now,
      };
      await uow.forms.save(form);
      await uow.outbox.add(formSavedEvent(form, true));
      return form;
    });
  }

  async updateForm(actor: Actor, formId: string, input: FormInput): Promise<ProjectForm> {
    return inTransaction(this.gateway, async (uow) => {
      const current = await uow.forms.findById(actor.organizationId, formId);
      if (!current) throw new FormNotFoundError();
      const project = await this.editableProject(uow, actor, current.projectId);
      const form: ProjectForm = { ...current, ...(await this.checkedForm(uow, project, input)), createdBy: actor.userId, updatedAt: this.clock() };
      await uow.forms.save(form);
      await uow.outbox.add(formSavedEvent(form, false));
      return form;
    });
  }

  async deleteForm(actor: Actor, formId: string): Promise<void> {
    await inTransaction(this.gateway, async (uow) => {
      const form = await uow.forms.findById(actor.organizationId, formId);
      if (!form) throw new FormNotFoundError();
      await this.editableProject(uow, actor, form.projectId);
      await uow.forms.delete(actor.organizationId, form.id);
      await uow.outbox.add(formDeletedEvent(form));
    });
  }

  /** El formulario para llenarlo: cualquiera de la organización, si está abierto y su proyecto activo. */
  async publicForm(actor: Actor, formId: string): Promise<PublicForm> {
    const form = await this.repos.forms.findById(actor.organizationId, formId);
    if (!form || !form.enabled) throw new FormNotFoundError();
    const project = await this.repos.projects.findById(actor.organizationId, form.projectId);
    if (!project || project.deletedAt || project.status !== 'active') throw new FormNotFoundError();
    return { form, projectName: project.name };
  }

  /** Crea la solicitud como tarea del proyecto. Devuelve su id: quien la envió la sigue y la ve en «Mis tareas → seguidas». */
  async submit(actor: Actor, formId: string, input: { title: unknown; answers: unknown }): Promise<{ taskId: string }> {
    const { form } = await this.publicForm(actor, formId);
    const { title, lines, dueOn } = answersToTask(form.questions, input.title, input.answers);
    const owner: Actor = { organizationId: form.organizationId, userId: form.createdBy, permissions: [PERMISSION_READ, PERMISSION_CREATE] };
    const paragraphs = lines.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] }));
    let task;
    try {
      task = await this.tasks.create(owner, {
        title,
        descriptionDoc: paragraphs.length ? { type: 'doc', content: paragraphs } : null,
        projectId: form.projectId,
        sectionId: form.sectionId,
        assigneeUserId: form.assigneeUserId,
        dueOn,
      });
    } catch (err) {
      // Quien hizo el formulario perdió el permiso de editar el proyecto (o la sección ya no existe): el formulario ya no sirve.
      if (err instanceof ProjectRoleError) throw new FormNotFoundError('Este formulario ya no recibe solicitudes: avisa a quien lo creó.');
      throw err;
    }
    if (actor.userId !== form.createdBy) await this.collaboration.addFollower(owner, task.id, actor.userId).catch(() => undefined);
    await inTransaction(this.gateway, async (uow) => {
      await uow.forms.incrementSubmissions(form.organizationId, form.id);
      await recordActivity(uow, actor, task, 'form_submitted', { form: form.title }, this.clock());
      await uow.outbox.add(formSubmittedEvent(form, task.id, actor.userId));
    });
    return { taskId: task.id };
  }

  private async checkedForm(repos: Repositories, project: Project, input: FormInput) {
    const title = input.title.trim();
    if (!title || title.length > 120) throw new ValidationError([{ field: 'title', message: 'Entre 1 y 120 caracteres.' }]);
    const description = input.description?.trim() || null;
    if (description && description.length > 1000) throw new ValidationError([{ field: 'description', message: 'Hasta 1000 caracteres.' }]);
    if (input.sectionId) {
      const section = await repos.sections.findById(project.organizationId, input.sectionId);
      if (!section || section.projectId !== project.id) throw new ValidationError([{ field: 'sectionId', message: 'La sección no es de este proyecto.' }]);
    }
    // Una pregunta que viene con su id lo conserva (validateQuestions): editar el formulario no confunde respuestas a medio llenar.
    const questions = validateQuestions(input.questions, () => this.newId());
    return { title, description, questions, sectionId: input.sectionId, assigneeUserId: input.assigneeUserId, enabled: input.enabled };
  }
}
