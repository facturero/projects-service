import { randomUUID } from 'node:crypto';
import { MAX_FIELDS_PER_PROJECT, normalizeOptions, validateFieldValue } from '../../domain/fields.js';
import { PERMISSION_TAG_MANAGE } from '../../domain/access.js';
import { AppError, ForbiddenError, ValidationError } from '../../domain/errors.js';
import { rankBetween } from '../../domain/rank.js';
import type { Repositories } from '../../domain/repositories.js';
import type { Actor, CustomField, FieldType, LinkEntity, ProjectColor, Tag, Task, TaskLink } from '../../domain/types.js';
import { assertTaskWritable, loadProject, loadTask, projectIdsOf } from '../access-context.js';
import { recordActivity } from '../activity.js';
import {
  fieldCreatedEvent,
  fieldDeletedEvent,
  fieldUpdatedEvent,
  linkAddedEvent,
  linkRemovedEvent,
  tagCreatedEvent,
  tagDeletedEvent,
  tagUpdatedEvent,
  taskFieldSetEvent,
  taskTaggedEvent,
  taskUntaggedEvent,
} from '../events.js';
import { type Clock, type IdGenerator, inTransaction, type UnitOfWorkGateway } from '../ports.js';
import { visibleTasks } from './timeline-use-cases.js';

export class NotFoundError extends AppError {
  readonly code: string;
  readonly httpStatus = 404;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Lo que une Proyectos con el resto del ERP y lo que organiza las tareas sin ser una tarea: vínculos (cliente, factura, OC…),
 * etiquetas de la organización y campos personalizados de cada proyecto.
 *
 * Quién puede: vincular, etiquetar y llenar un campo lo hace quien puede EDITAR la tarea; definir los campos de un proyecto, un
 * editor o administrador de ese proyecto. Las etiquetas son de toda la organización: crearlas, renombrarlas, cambiarles el color y
 * borrarlas pide `project_tag:manage` (ver `domain/access.ts`); ponerlas en una tarea, solo poder editar esa tarea.
 */
export class OrganizeUseCases {
  constructor(
    private readonly gateway: UnitOfWorkGateway,
    private readonly repos: Repositories,
    private readonly clock: Clock,
    private readonly newId: IdGenerator,
  ) {}

  // ── Vínculos con el ERP ───────────────────────────────────────────────────

  async addLink(actor: Actor, taskId: string, input: { entityType: LinkEntity; entityId: string; label: string }): Promise<TaskLink> {
    return inTransaction(this.gateway, async (uow) => {
      // Con la tarea bloqueada: dos «vincular» iguales a la vez se ordenan, y la segunda ve el vínculo de la primera (sin el bloqueo,
      // su foto de la base es anterior y no lo encuentra).
      const ctx = await loadTask(uow, actor, taskId, { forUpdate: true });
      assertTaskWritable(ctx);
      const now = this.clock();
      const link: TaskLink = {
        id: this.newId(),
        organizationId: actor.organizationId,
        taskId: ctx.task.id,
        entityType: input.entityType,
        entityId: input.entityId.toLowerCase(),
        label: input.label.trim(),
        createdBy: actor.userId,
        createdAt: now,
      };
      if (await uow.links.add(link)) {
        await recordActivity(uow, actor, ctx.task, 'link_added', { entityType: link.entityType, label: link.label }, now);
        await uow.outbox.add(linkAddedEvent(ctx.task, link, projectIdsOf(ctx)));
        return link;
      }
      // Ya estaba vinculada a eso: se devuelve el vínculo existente (idempotente).
      return (await uow.links.listByTask(actor.organizationId, ctx.task.id)).find((l) => l.entityType === link.entityType && l.entityId === link.entityId)!;
    });
  }

  async removeLink(actor: Actor, linkId: string): Promise<void> {
    await inTransaction(this.gateway, async (uow) => {
      const link = await uow.links.findById(actor.organizationId, linkId);
      if (!link) throw new NotFoundError('LINK_NOT_FOUND', 'Vínculo no encontrado.');
      const ctx = await loadTask(uow, actor, link.taskId);
      assertTaskWritable(ctx);
      await uow.links.remove(actor.organizationId, linkId);
      await recordActivity(uow, actor, ctx.task, 'link_removed', { entityType: link.entityType, label: link.label }, this.clock());
      await uow.outbox.add(linkRemovedEvent(ctx.task, link, projectIdsOf(ctx)));
    });
  }

  /** Las tareas vinculadas a un cliente (o factura, OC…) que quien pregunta puede ver: la pestaña «Tareas» de la ficha del cliente. */
  async linkedTasks(actor: Actor, entityType: LinkEntity, entityId: string): Promise<Task[]> {
    const links = await this.repos.links.listByEntity(actor.organizationId, entityType, entityId.toLowerCase());
    const tasks = await this.repos.tasks.findManyByIds(actor.organizationId, links.map((l) => l.taskId));
    const byPlacement = new Set((await visibleTasks(this.repos, actor, tasks)).map((t) => t.id));
    // Las personales (sin proyecto) de quien pregunta también cuentan.
    return tasks
      .filter((t) => !t.deletedAt && (byPlacement.has(t.id) || t.createdBy === actor.userId || t.assigneeUserId === actor.userId))
      .sort((a, b) => Number(!!a.completedAt) - Number(!!b.completedAt) || (a.dueOn ?? '9999').localeCompare(b.dueOn ?? '9999'));
  }

  // ── Etiquetas ─────────────────────────────────────────────────────────────

  async listTags(actor: Actor): Promise<Array<Tag & { taskCount: number }>> {
    const [tags, usage] = await Promise.all([this.repos.tags.list(actor.organizationId), this.repos.tags.usage(actor.organizationId)]);
    return tags.map((t) => ({ ...t, taskCount: usage.get(t.id) ?? 0 }));
  }

  private assertCanManageTags(actor: Actor): void {
    if (!actor.permissions.includes(PERMISSION_TAG_MANAGE)) {
      throw new ForbiddenError('Crear, cambiar o eliminar etiquetas es de quien administra las etiquetas (permiso «Administrar etiquetas»).');
    }
  }

  /** Crea la etiqueta, o devuelve la que ya existe con ese nombre (sin distinguir mayúsculas): nadie termina con «Urgente» y «urgente». */
  async createTag(actor: Actor, input: { name: string; color?: ProjectColor }): Promise<Tag> {
    this.assertCanManageTags(actor);
    const name = input.name.trim();
    if (!name || name.length > 60) throw new ValidationError([{ field: 'name', message: 'Entre 1 y 60 caracteres.' }]);
    return inTransaction(this.gateway, async (uow) => {
      const existing = await uow.tags.findByName(actor.organizationId, name);
      if (existing) return existing;
      const tag: Tag = { id: this.newId(), organizationId: actor.organizationId, name, color: input.color ?? 'primary', createdBy: actor.userId, createdAt: this.clock() };
      if (!(await uow.tags.add(tag))) {
        // Otra petición la creó entretanto: se devuelve esa (lectura con bloqueo, para verla aunque sea posterior a nuestra foto).
        const winner = await uow.tags.findByName(actor.organizationId, name, { lock: true });
        if (winner) return winner;
        throw new ValidationError([{ field: 'name', message: 'No se pudo crear la etiqueta; vuelve a intentarlo.' }]);
      }
      await uow.outbox.add(tagCreatedEvent(tag));
      return tag;
    });
  }

  /** Renombrar o cambiar el color: afecta a todas las tareas que la llevan. Un nombre que ya usa otra etiqueta se rechaza. */
  async updateTag(actor: Actor, tagId: string, input: { name?: string; color?: ProjectColor }): Promise<Tag> {
    this.assertCanManageTags(actor);
    const name = input.name?.trim();
    if (name !== undefined && (!name || name.length > 60)) throw new ValidationError([{ field: 'name', message: 'Entre 1 y 60 caracteres.' }]);
    return inTransaction(this.gateway, async (uow) => {
      const previous = await uow.tags.findById(actor.organizationId, tagId);
      if (!previous) throw new NotFoundError('TAG_NOT_FOUND', 'Etiqueta no encontrada.');
      const next: Tag = { ...previous, name: name ?? previous.name, color: input.color ?? previous.color };
      if (next.name === previous.name && next.color === previous.color) return previous;
      const taken = name ? await uow.tags.findByName(actor.organizationId, name) : null;
      if ((taken && taken.id !== tagId) || !(await uow.tags.update(next))) {
        throw new ValidationError([{ field: 'name', message: 'Ya hay otra etiqueta con ese nombre.' }]);
      }
      await uow.outbox.add(tagUpdatedEvent(next, previous));
      return next;
    });
  }

  /** La quita de todas las tareas que la llevan. Devuelve en cuántas estaba. */
  async deleteTag(actor: Actor, tagId: string): Promise<{ taskCount: number }> {
    this.assertCanManageTags(actor);
    return inTransaction(this.gateway, async (uow) => {
      const tag = await uow.tags.findById(actor.organizationId, tagId);
      if (!tag) throw new NotFoundError('TAG_NOT_FOUND', 'Etiqueta no encontrada.');
      const taskCount = (await uow.tags.usage(actor.organizationId)).get(tag.id) ?? 0;
      await uow.tags.remove(actor.organizationId, tag.id);
      await uow.outbox.add(tagDeletedEvent(tag, taskCount));
      return { taskCount };
    });
  }

  async setTag(actor: Actor, taskId: string, tagId: string, attached: boolean): Promise<Tag[]> {
    return inTransaction(this.gateway, async (uow) => {
      const ctx = await loadTask(uow, actor, taskId);
      assertTaskWritable(ctx);
      const tag = await uow.tags.findById(actor.organizationId, tagId);
      if (!tag) throw new NotFoundError('TAG_NOT_FOUND', 'Etiqueta no encontrada.');
      const changed = attached ? await uow.tags.attach(actor.organizationId, ctx.task.id, tag.id, this.clock()) : await uow.tags.detach(actor.organizationId, ctx.task.id, tag.id);
      if (changed) await uow.outbox.add((attached ? taskTaggedEvent : taskUntaggedEvent)(ctx.task, tag, projectIdsOf(ctx)));
      return (await uow.tags.listForTasks(actor.organizationId, [ctx.task.id])).get(ctx.task.id) ?? [];
    });
  }

  // ── Campos personalizados ─────────────────────────────────────────────────

  async listFields(actor: Actor, projectId: string): Promise<CustomField[]> {
    await loadProject(this.repos, actor, projectId);
    return this.repos.fields.listByProjects(actor.organizationId, [projectId]);
  }

  async createField(
    actor: Actor,
    projectId: string,
    input: { name: string; type: FieldType; options?: Array<{ id?: string | null; label: string; color?: string | null }> },
  ): Promise<CustomField> {
    const name = input.name.trim();
    if (!name || name.length > 60) throw new ValidationError([{ field: 'name', message: 'Entre 1 y 60 caracteres.' }]);
    const options = input.type === 'select' ? normalizeOptions(input.options ?? [], randomUUID) : [];
    if (input.type === 'select' && options.length === 0) throw new ValidationError([{ field: 'options', message: 'Una lista necesita al menos una opción.' }]);
    return inTransaction(this.gateway, async (uow) => {
      const { project } = await loadProject(uow, actor, projectId, { needs: 'editor', forUpdate: true, writable: true });
      const existing = await uow.fields.listByProjects(actor.organizationId, [projectId]);
      if (existing.length >= MAX_FIELDS_PER_PROJECT) throw new ValidationError([{ field: 'name', message: `Máximo ${MAX_FIELDS_PER_PROJECT} campos por proyecto.` }]);
      const now = this.clock();
      const field: CustomField = {
        id: this.newId(),
        organizationId: actor.organizationId,
        projectId,
        name,
        type: input.type,
        options,
        rank: rankBetween(existing.at(-1)?.rank ?? null, null),
        createdAt: now,
        updatedAt: now,
      };
      await uow.fields.save(field);
      await uow.outbox.add(fieldCreatedEvent(project, field));
      return field;
    });
  }

  /**
   * Renombrar el campo o cambiar sus opciones. Una opción quitada deja vacías las tareas que la tenían (en vez de dejarlas apuntando
   * a algo que ya no existe); el tipo no se cambia: convertir números en fechas no tiene una regla que no pierda datos.
   */
  async updateField(
    actor: Actor,
    fieldId: string,
    input: { name?: string; options?: Array<{ id?: string | null; label: string; color?: string | null }> },
  ): Promise<CustomField> {
    return inTransaction(this.gateway, async (uow) => {
      const field = await uow.fields.findById(actor.organizationId, fieldId);
      if (!field) throw new NotFoundError('FIELD_NOT_FOUND', 'Campo no encontrado.');
      const { project } = await loadProject(uow, actor, field.projectId, { needs: 'editor', writable: true });
      const changes: string[] = [];
      const next: CustomField = { ...field };
      if (input.name !== undefined && input.name.trim() !== field.name) {
        const name = input.name.trim();
        if (!name || name.length > 60) throw new ValidationError([{ field: 'name', message: 'Entre 1 y 60 caracteres.' }]);
        next.name = name;
        changes.push('name');
      }
      if (input.options !== undefined && field.type === 'select') {
        next.options = normalizeOptions(input.options, randomUUID);
        if (next.options.length === 0) throw new ValidationError([{ field: 'options', message: 'Una lista necesita al menos una opción.' }]);
        if (JSON.stringify(next.options) !== JSON.stringify(field.options)) changes.push('options');
        const kept = new Set(next.options.map((o) => o.id));
        for (const v of await uow.fields.valuesForField(actor.organizationId, field.id)) {
          if (!kept.has(String(v.value))) await uow.fields.clearValue(actor.organizationId, v.taskId, field.id);
        }
      }
      if (changes.length === 0) return field;
      next.updatedAt = this.clock();
      await uow.fields.save(next);
      await uow.outbox.add(fieldUpdatedEvent(project, next, changes));
      return next;
    });
  }

  async deleteField(actor: Actor, fieldId: string): Promise<void> {
    await inTransaction(this.gateway, async (uow) => {
      const field = await uow.fields.findById(actor.organizationId, fieldId);
      if (!field) throw new NotFoundError('FIELD_NOT_FOUND', 'Campo no encontrado.');
      const { project } = await loadProject(uow, actor, field.projectId, { needs: 'editor', writable: true });
      await uow.fields.delete(actor.organizationId, field.id);
      await uow.outbox.add(fieldDeletedEvent(project, field));
    });
  }

  /** Llenar (o vaciar con `null`) un campo de una tarea. El campo tiene que ser de uno de los proyectos donde está la tarea. */
  async setFieldValue(actor: Actor, taskId: string, fieldId: string, raw: unknown): Promise<string | number | null> {
    return inTransaction(this.gateway, async (uow) => {
      // Bloqueo de la tarea: el valor se guarda leyendo y luego creando o cambiando la fila; dos a la vez chocarían en la clave.
      const ctx = await loadTask(uow, actor, taskId, { forUpdate: true });
      assertTaskWritable(ctx);
      const field = await uow.fields.findById(actor.organizationId, fieldId);
      if (!field || !ctx.placements.some((p) => p.projectId === field.projectId)) throw new NotFoundError('FIELD_NOT_FOUND', 'Ese campo no es de ningún proyecto de la tarea.');
      const value = validateFieldValue(field, raw);
      const now = this.clock();
      if (value === null) await uow.fields.clearValue(actor.organizationId, ctx.task.id, field.id);
      else await uow.fields.setValue({ taskId: ctx.task.id, fieldId: field.id, organizationId: actor.organizationId, value, updatedAt: now });
      const shown = value === null ? null : field.type === 'select' ? (field.options.find((o) => o.id === value)?.label ?? null) : String(value);
      await recordActivity(uow, actor, ctx.task, 'field_set', { field: field.name, value: shown }, now);
      await uow.outbox.add(taskFieldSetEvent(ctx.task, field, shown, projectIdsOf(ctx)));
      return value;
    });
  }
}
