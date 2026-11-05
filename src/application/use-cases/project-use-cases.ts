import { effectiveRole, isOrgProjectAdmin, PERMISSION_CREATE } from '../../domain/access.js';
import { ForbiddenError, VersionConflictError } from '../../domain/errors.js';
import type { Repositories } from '../../domain/repositories.js';
import { rankBetween } from '../../domain/rank.js';
import type {
  Actor,
  Project,
  ProjectColor,
  ProjectMember,
  ProjectRole,
  ProjectStatus,
  ProjectView,
  Section,
  StatusUpdate,
  Visibility,
} from '../../domain/types.js';
import { loadProject } from '../access-context.js';
import {
  projectArchivedEvent,
  projectCreatedEvent,
  projectDeletedEvent,
  projectUnarchivedEvent,
  projectUpdatedEvent,
  sectionCreatedEvent,
} from '../events.js';
import { type Clock, type IdGenerator, inTransaction, type UnitOfWorkGateway } from '../ports.js';

export interface CreateProjectInput {
  name: string;
  description?: string | null;
  color?: ProjectColor;
  icon?: string;
  visibility: Visibility;
  defaultView?: ProjectView;
  /** Columnas iniciales («Por hacer», «En curso», «Hecho»): las manda el cliente en el idioma de quien crea el proyecto. */
  sectionNames: string[];
}

export interface UpdateProjectInput {
  version: number;
  name?: string;
  description?: string | null;
  color?: ProjectColor;
  icon?: string;
  visibility?: Visibility;
  defaultView?: ProjectView;
}

export interface ProjectWithRole {
  project: Project;
  myRole: ProjectRole;
  isMember: boolean;
  /** Último estado publicado («en riesgo»…), como el color de estado de los proyectos en Asana. */
  latestStatus: StatusUpdate | null;
}

export interface ProjectDetail extends ProjectWithRole {
  members: ProjectMember[];
}

export class ProjectUseCases {
  constructor(
    private readonly gateway: UnitOfWorkGateway,
    private readonly repos: Repositories,
    private readonly clock: Clock,
    private readonly newId: IdGenerator,
  ) {}

  /** Proyectos que el actor puede ver, con su rol en cada uno (para que la interfaz sepa qué botones mostrar). */
  async list(actor: Actor, status: ProjectStatus = 'active'): Promise<ProjectWithRole[]> {
    const projects = await this.repos.projects.listVisible(actor.organizationId, actor.userId, {
      status,
      allPrivate: isOrgProjectAdmin(actor),
    });
    const memberships = await this.repos.members.listForUser(actor.organizationId, actor.userId, projects.map((p) => p.id));
    const mine = new Map(memberships.map((m) => [m.projectId, m]));
    const latest = await this.repos.statusUpdates.latestByProjects(actor.organizationId, projects.map((p) => p.id));
    return projects
      .flatMap((project) => {
        const member = mine.get(project.id) ?? null;
        const myRole = effectiveRole(project, member, actor);
        return myRole ? [{ project, myRole, isMember: member !== null, latestStatus: latest.get(project.id) ?? null }] : [];
      })
      .sort((a, b) => a.project.name.localeCompare(b.project.name, 'es'));
  }

  async get(actor: Actor, projectId: string): Promise<ProjectDetail> {
    const { project, member, role } = await loadProject(this.repos, actor, projectId);
    const [members, latest] = await Promise.all([
      this.repos.members.listByProject(actor.organizationId, projectId),
      this.repos.statusUpdates.listByProject(actor.organizationId, projectId, 1),
    ]);
    return { project, myRole: role, isMember: member !== null, members, latestStatus: latest[0] ?? null };
  }

  async create(actor: Actor, input: CreateProjectInput): Promise<ProjectDetail> {
    if (!actor.permissions.includes(PERMISSION_CREATE)) throw new ForbiddenError();
    const now = this.clock();
    const project: Project = {
      id: this.newId(),
      organizationId: actor.organizationId,
      name: input.name.trim(),
      description: input.description?.trim() || null,
      color: input.color ?? 'primary',
      icon: input.icon ?? 'mdi-folder-outline',
      visibility: input.visibility,
      ownerUserId: actor.userId,
      status: 'active',
      defaultView: input.defaultView ?? 'list',
      version: 1,
      createdBy: actor.userId,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    // Quien crea el proyecto lo administra: si no, un proyecto privado recién creado no lo vería ni su autor.
    const owner: ProjectMember = { projectId: project.id, organizationId: actor.organizationId, userId: actor.userId, role: 'admin', createdAt: now };

    return inTransaction(this.gateway, async (uow) => {
      await uow.projects.save(project);
      await uow.members.save(owner);
      await uow.outbox.add(projectCreatedEvent(project));
      let previous: string | null = null;
      for (const name of input.sectionNames) {
        const section: Section = {
          id: this.newId(),
          organizationId: actor.organizationId,
          projectId: project.id,
          name: name.trim(),
          rank: rankBetween(previous, null),
          createdAt: now,
          updatedAt: now,
        };
        previous = section.rank;
        await uow.sections.save(section);
        await uow.outbox.add(sectionCreatedEvent(project, section));
      }
      return { project, myRole: 'admin', isMember: true, members: [owner], latestStatus: null };
    });
  }

  async update(actor: Actor, projectId: string, input: UpdateProjectInput): Promise<Project> {
    return inTransaction(this.gateway, async (uow) => {
      const { project } = await loadProject(uow, actor, projectId, { needs: 'admin', forUpdate: true });
      if (project.version !== input.version) throw new VersionConflictError(project.version);

      const changes: string[] = [];
      const next: Project = { ...project };
      const set = <K extends keyof Project>(key: K, value: Project[K] | undefined) => {
        if (value === undefined || value === project[key]) return;
        next[key] = value;
        changes.push(key);
      };
      set('name', input.name?.trim());
      set('description', input.description === undefined ? undefined : input.description?.trim() || null);
      set('color', input.color);
      set('icon', input.icon);
      set('visibility', input.visibility);
      set('defaultView', input.defaultView);
      if (changes.length === 0) return project;

      next.version = project.version + 1;
      next.updatedAt = this.clock();
      await uow.projects.save(next);
      await uow.outbox.add(projectUpdatedEvent(next, changes));
      return next;
    });
  }

  async archive(actor: Actor, projectId: string): Promise<Project> {
    return this.setStatus(actor, projectId, 'archived');
  }

  async unarchive(actor: Actor, projectId: string): Promise<Project> {
    return this.setStatus(actor, projectId, 'active');
  }

  private async setStatus(actor: Actor, projectId: string, status: ProjectStatus): Promise<Project> {
    return inTransaction(this.gateway, async (uow) => {
      const { project } = await loadProject(uow, actor, projectId, { needs: 'admin', forUpdate: true });
      if (project.status === status) return project;
      const next: Project = { ...project, status, version: project.version + 1, updatedAt: this.clock() };
      await uow.projects.save(next);
      await uow.outbox.add(status === 'archived' ? projectArchivedEvent(next) : projectUnarchivedEvent(next));
      return next;
    });
  }

  /** A la papelera: sus tareas dejan de verse por ese proyecto (las que también están en otro siguen vivas allí). */
  async delete(actor: Actor, projectId: string): Promise<void> {
    await inTransaction(this.gateway, async (uow) => {
      const { project } = await loadProject(uow, actor, projectId, { needs: 'admin', forUpdate: true });
      const now = this.clock();
      const next: Project = { ...project, deletedAt: now, updatedAt: now, version: project.version + 1 };
      await uow.projects.save(next);
      await uow.outbox.add(projectDeletedEvent(next));
    });
  }
}
