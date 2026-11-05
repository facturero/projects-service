import { LastAdminError, MemberExistsError, MemberNotFoundError } from '../../domain/errors.js';
import type { Repositories } from '../../domain/repositories.js';
import type { Actor, ProjectMember, ProjectRole } from '../../domain/types.js';
import { loadProject } from '../access-context.js';
import { memberAddedEvent, memberRemovedEvent, memberUpdatedEvent } from '../events.js';
import { type Clock, inTransaction, type UnitOfWorkGateway, type WriteUnitOfWork } from '../ports.js';

/**
 * Miembros de un proyecto («Compartir» en Asana). Solo el administrador del proyecto (o el de la organización) los cambia, y el
 * proyecto nunca se queda sin administrador: el proyecto se bloquea con `FOR UPDATE` para que dos personas que se quitan el rol a
 * la vez no lo dejen huérfano.
 *
 * Que el usuario exista en la organización no se comprueba aquí (es de auth-service): el frontend lo elige del directorio
 * (`GET /users/directory`), y un id ajeno no da acceso a nada, porque todas las consultas filtran por la organización del token.
 */
export class MemberUseCases {
  constructor(
    private readonly gateway: UnitOfWorkGateway,
    private readonly repos: Repositories,
    private readonly clock: Clock,
  ) {}

  async list(actor: Actor, projectId: string): Promise<ProjectMember[]> {
    await loadProject(this.repos, actor, projectId);
    return this.repos.members.listByProject(actor.organizationId, projectId);
  }

  async add(actor: Actor, projectId: string, input: { userId: string; role: ProjectRole }): Promise<ProjectMember> {
    return inTransaction(this.gateway, async (uow) => {
      const { project } = await loadProject(uow, actor, projectId, { needs: 'admin', forUpdate: true });
      if (await uow.members.find(actor.organizationId, projectId, input.userId)) throw new MemberExistsError();
      const member: ProjectMember = { projectId, organizationId: actor.organizationId, userId: input.userId, role: input.role, createdAt: this.clock() };
      await uow.members.save(member);
      await uow.outbox.add(memberAddedEvent(project, member));
      return member;
    });
  }

  async updateRole(actor: Actor, projectId: string, userId: string, role: ProjectRole): Promise<ProjectMember> {
    return inTransaction(this.gateway, async (uow) => {
      const { project } = await loadProject(uow, actor, projectId, { needs: 'admin', forUpdate: true });
      const current = await uow.members.find(actor.organizationId, projectId, userId);
      if (!current) throw new MemberNotFoundError();
      if (current.role === role) return current;
      if (current.role === 'admin') await this.assertAnotherAdmin(uow, actor, projectId, userId);
      const next: ProjectMember = { ...current, role };
      await uow.members.save(next);
      await uow.outbox.add(memberUpdatedEvent(project, next, current.role));
      return next;
    });
  }

  /** Quitar a alguien, o salirse uno mismo (eso no exige ser administrador). */
  async remove(actor: Actor, projectId: string, userId: string): Promise<void> {
    await inTransaction(this.gateway, async (uow) => {
      const leaving = userId === actor.userId;
      const { project } = await loadProject(uow, actor, projectId, { needs: leaving ? 'viewer' : 'admin', forUpdate: true });
      const current = await uow.members.find(actor.organizationId, projectId, userId);
      if (!current) throw new MemberNotFoundError();
      if (current.role === 'admin') await this.assertAnotherAdmin(uow, actor, projectId, userId);
      await uow.members.remove(actor.organizationId, projectId, userId);
      await uow.outbox.add(memberRemovedEvent(project, current));
    });
  }

  private async assertAnotherAdmin(uow: WriteUnitOfWork, actor: Actor, projectId: string, userId: string): Promise<void> {
    const members = await uow.members.listByProject(actor.organizationId, projectId);
    if (!members.some((m) => m.role === 'admin' && m.userId !== userId)) throw new LastAdminError();
  }
}
