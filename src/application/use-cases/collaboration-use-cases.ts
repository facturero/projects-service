import { atLeast, isOrgProjectAdmin } from '../../domain/access.js';
import { AttachmentNotFoundError, CommentNotFoundError, ProjectRoleError, ValidationError } from '../../domain/errors.js';
import type { Actor, Attachment, Comment, LikeTarget } from '../../domain/types.js';
import { assertTaskWritable, loadTask, projectIdsOf, type TaskContext } from '../access-context.js';
import { audience, recordActivity } from '../activity.js';
import {
  attachmentAddedEvent,
  attachmentRemovedEvent,
  commentCreatedEvent,
  commentDeletedEvent,
  commentUpdatedEvent,
  followerAddedEvent,
  followerRemovedEvent,
} from '../events.js';
import { type Clock, type IdGenerator, inTransaction, type UnitOfWorkGateway, type WriteUnitOfWork } from '../ports.js';
import { notifyMentions, richOrFail } from './task-use-cases.js';

export interface AddAttachmentInput {
  documentId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}

/** ¿Administra algún proyecto de la tarea? Sirve para moderar: borrar el comentario o el adjunto de otra persona. */
function moderates(ctx: TaskContext, actor: Actor): boolean {
  return isOrgProjectAdmin(actor) || ctx.placements.some((p) => atLeast(ctx.projects.get(p.projectId)?.role ?? null, 'admin'));
}

/**
 * Comentarios, seguidores, «me gusta» y adjuntos: la parte social de la tarea (entregable 2).
 *
 * Quién puede: comentar, seguir, dar «me gusta» y adjuntar lo hace cualquiera que pueda comentar la tarea (comentarista o más en el
 * proyecto, el responsable o un seguidor). Editar o borrar un comentario es de su autor; borrar el de otro, del administrador del
 * proyecto. Un proyecto archivado no admite nada de esto (`assertTaskWritable`).
 */
export class CollaborationUseCases {
  constructor(
    private readonly gateway: UnitOfWorkGateway,
    private readonly clock: Clock,
    private readonly newId: IdGenerator,
  ) {}

  // ── Comentarios ───────────────────────────────────────────────────────────

  async addComment(actor: Actor, taskId: string, bodyDoc: unknown): Promise<Comment> {
    const rich = richOrFail('bodyDoc', bodyDoc);
    if (!rich.text) throw new ValidationError([{ field: 'bodyDoc', message: 'El comentario está vacío.' }]);

    return inTransaction(this.gateway, async (uow) => {
      const ctx = await loadTask(uow, actor, taskId);
      assertTaskWritable(ctx, 'comment');
      const now = this.clock();
      const comment: Comment = {
        id: this.newId(),
        organizationId: actor.organizationId,
        taskId: ctx.task.id,
        authorUserId: actor.userId,
        bodyDoc: rich.doc,
        bodyText: rich.text,
        mentionedUserIds: rich.mentions,
        createdAt: now,
        editedAt: null,
        deletedAt: null,
      };
      await uow.comments.save(comment);
      // Quien comenta empieza a seguir la tarea (Asana): se entera de las respuestas.
      await uow.followers.add(actor.organizationId, ctx.task.id, actor.userId, now);
      const projectIds = projectIdsOf(ctx);
      const mentioned = await notifyMentions(uow, actor, ctx.task, {
        mentions: rich.mentions,
        previous: [],
        where: 'comment',
        text: rich.text,
        commentId: comment.id,
        projectIds,
        at: now,
      });
      // Los mencionados ya reciben su propio aviso: no se les avisa dos veces del mismo comentario.
      const followers = await audience(uow, ctx.task, actor.userId, [...mentioned, ...rich.mentions]);
      await uow.outbox.add(commentCreatedEvent(ctx.task, comment, projectIds, followers));
      return comment;
    });
  }

  async editComment(actor: Actor, commentId: string, bodyDoc: unknown): Promise<Comment> {
    const rich = richOrFail('bodyDoc', bodyDoc);
    if (!rich.text) throw new ValidationError([{ field: 'bodyDoc', message: 'El comentario está vacío.' }]);

    return inTransaction(this.gateway, async (uow) => {
      const { comment, ctx } = await this.loadComment(uow, actor, commentId);
      if (comment.authorUserId !== actor.userId) throw new ProjectRoleError('Solo quien escribió el comentario puede editarlo.');
      assertTaskWritable(ctx, 'comment');
      const now = this.clock();
      const next: Comment = { ...comment, bodyDoc: rich.doc, bodyText: rich.text, mentionedUserIds: rich.mentions, editedAt: now };
      await uow.comments.save(next);
      const projectIds = projectIdsOf(ctx);
      // Solo las menciones NUEVAS avisan: corregir una falta no debe volver a llamar a todos.
      await notifyMentions(uow, actor, ctx.task, {
        mentions: rich.mentions,
        previous: comment.mentionedUserIds,
        where: 'comment',
        text: rich.text,
        commentId: comment.id,
        projectIds,
        at: now,
      });
      await uow.outbox.add(commentUpdatedEvent(ctx.task, next, projectIds));
      return next;
    });
  }

  async deleteComment(actor: Actor, commentId: string): Promise<void> {
    await inTransaction(this.gateway, async (uow) => {
      const { comment, ctx } = await this.loadComment(uow, actor, commentId);
      if (comment.authorUserId !== actor.userId && !moderates(ctx, actor)) throw new ProjectRoleError('Solo su autor o el administrador del proyecto pueden borrarlo.');
      assertTaskWritable(ctx, 'comment');
      const next: Comment = { ...comment, deletedAt: this.clock() };
      await uow.comments.save(next);
      await uow.outbox.add(commentDeletedEvent(ctx.task, next, projectIdsOf(ctx)));
    });
  }

  private async loadComment(uow: WriteUnitOfWork, actor: Actor, commentId: string): Promise<{ comment: Comment; ctx: TaskContext }> {
    const comment = await uow.comments.findById(actor.organizationId, commentId);
    if (!comment || comment.deletedAt) throw new CommentNotFoundError();
    const ctx = await loadTask(uow, actor, comment.taskId);
    return { comment, ctx };
  }

  // ── Seguidores ────────────────────────────────────────────────────────────

  /** Seguirla uno mismo, o sumar a otra persona (eso comparte la tarea con ella: lo hace quien puede editarla). */
  async addFollower(actor: Actor, taskId: string, userId: string): Promise<string[]> {
    return inTransaction(this.gateway, async (uow) => {
      const ctx = await loadTask(uow, actor, taskId);
      assertTaskWritable(ctx, userId === actor.userId ? 'comment' : 'edit');
      if (await uow.followers.add(actor.organizationId, ctx.task.id, userId, this.clock())) {
        await uow.outbox.add(followerAddedEvent(ctx.task, userId, projectIdsOf(ctx)));
      }
      return uow.followers.listByTask(actor.organizationId, ctx.task.id);
    });
  }

  /** Dejar de seguirla uno mismo, o quitar a otra persona (quien puede editarla). */
  async removeFollower(actor: Actor, taskId: string, userId: string): Promise<string[]> {
    return inTransaction(this.gateway, async (uow) => {
      const ctx = await loadTask(uow, actor, taskId);
      if (userId !== actor.userId && !ctx.access.canEdit) throw new ProjectRoleError();
      if (await uow.followers.remove(actor.organizationId, ctx.task.id, userId)) {
        await uow.outbox.add(followerRemovedEvent(ctx.task, userId, projectIdsOf(ctx)));
      }
      return uow.followers.listByTask(actor.organizationId, ctx.task.id);
    });
  }

  // ── «Me gusta» ────────────────────────────────────────────────────────────

  /** Devuelve quién le da «me gusta» después del cambio. Sin evento: no es una acción que la bitácora deba registrar. */
  async setLike(actor: Actor, target: LikeTarget, id: string, liked: boolean): Promise<string[]> {
    return inTransaction(this.gateway, async (uow) => {
      let taskId = id;
      if (target === 'comment') {
        const comment = await uow.comments.findById(actor.organizationId, id);
        if (!comment || comment.deletedAt) throw new CommentNotFoundError();
        taskId = comment.taskId;
      }
      const ctx = await loadTask(uow, actor, taskId);
      assertTaskWritable(ctx, 'comment');
      if (liked) await uow.likes.add(actor.organizationId, target, id, actor.userId, this.clock());
      else await uow.likes.remove(actor.organizationId, target, id, actor.userId);
      return (await uow.likes.usersFor(actor.organizationId, target, [id])).get(id) ?? [];
    });
  }

  // ── Adjuntos ──────────────────────────────────────────────────────────────

  /**
   * Registra un archivo ya subido a document-service (el frontend lo sube con su URL firmada y aquí manda el id). No se comprueba
   * contra document-service: descargarlo exige sesión de la MISMA organización, así que un id ajeno no da acceso a nada.
   */
  async addAttachment(actor: Actor, taskId: string, input: AddAttachmentInput): Promise<Attachment> {
    return inTransaction(this.gateway, async (uow) => {
      const ctx = await loadTask(uow, actor, taskId);
      assertTaskWritable(ctx, 'comment');
      const now = this.clock();
      const attachment: Attachment = {
        id: this.newId(),
        organizationId: actor.organizationId,
        taskId: ctx.task.id,
        documentId: input.documentId,
        fileName: input.fileName.trim(),
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        uploadedBy: actor.userId,
        createdAt: now,
        deletedAt: null,
      };
      await uow.attachments.save(attachment);
      await recordActivity(uow, actor, ctx.task, 'attachment_added', { fileName: attachment.fileName }, now);
      await uow.outbox.add(attachmentAddedEvent(ctx.task, attachment, projectIdsOf(ctx)));
      return attachment;
    });
  }

  /** Quitar un adjunto: quien lo subió o quien puede editar la tarea. El archivo en document-service no se toca aquí. */
  async removeAttachment(actor: Actor, attachmentId: string): Promise<void> {
    await inTransaction(this.gateway, async (uow) => {
      const attachment = await uow.attachments.findById(actor.organizationId, attachmentId);
      if (!attachment || attachment.deletedAt) throw new AttachmentNotFoundError();
      const ctx = await loadTask(uow, actor, attachment.taskId);
      if (attachment.uploadedBy !== actor.userId && !ctx.access.canEdit) throw new ProjectRoleError();
      assertTaskWritable(ctx, 'comment');
      const now = this.clock();
      const next: Attachment = { ...attachment, deletedAt: now };
      await uow.attachments.save(next);
      await recordActivity(uow, actor, ctx.task, 'attachment_removed', { fileName: attachment.fileName }, now);
      await uow.outbox.add(attachmentRemovedEvent(ctx.task, next, projectIdsOf(ctx)));
    });
  }
}

