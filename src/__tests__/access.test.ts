import { describe, expect, it } from 'vitest';
import { ProjectNotFoundError, ProjectRoleError, TaskNotFoundError } from '../domain/errors.js';
import { ANA, BETO, CARLA, actor, orgAdmin, OTHER_ORG, projectWithSections, readOnly, setup } from './helpers.js';

/** Visibilidad y roles, como en Asana: lo decide el rol DENTRO del proyecto. */
describe('proyectos privados', () => {
  it('un proyecto privado no aparece ni se abre para quien no es miembro (404, no 403: no se revela que existe)', async () => {
    const { useCases: uc } = setup();
    const { project } = await projectWithSections(uc, actor(ANA), 'members');

    expect((await uc.projects.list(actor(BETO))).map((p) => p.project.id)).not.toContain(project.id);
    await expect(uc.projects.get(actor(BETO), project.id)).rejects.toBeInstanceOf(ProjectNotFoundError);
    await expect(uc.tasks.board(actor(BETO), project.id)).rejects.toBeInstanceOf(ProjectNotFoundError);
  });

  it('al sumarlo como miembro lo ve; al quitarlo deja de verlo', async () => {
    const { useCases: uc } = setup();
    const { project } = await projectWithSections(uc, actor(ANA), 'members');
    await uc.members.add(actor(ANA), project.id, { userId: BETO, role: 'editor' });
    expect((await uc.projects.list(actor(BETO))).map((p) => p.project.id)).toContain(project.id);

    await uc.members.remove(actor(ANA), project.id, BETO);
    await expect(uc.projects.get(actor(BETO), project.id)).rejects.toBeInstanceOf(ProjectNotFoundError);
  });

  it('el Administrador de la organización (project:admin) entra a todos, también a los privados ajenos', async () => {
    const { useCases: uc } = setup();
    const { project } = await projectWithSections(uc, actor(ANA), 'members');
    const detail = await uc.projects.get(orgAdmin(CARLA), project.id);
    expect(detail.myRole).toBe('admin');
    expect((await uc.projects.list(orgAdmin(CARLA))).map((p) => p.project.id)).toContain(project.id);
  });

  it('una tarea de un proyecto privado no se abre por su id para quien no es miembro', async () => {
    const { useCases: uc } = setup();
    const { project } = await projectWithSections(uc, actor(ANA), 'members');
    const task = await uc.tasks.create(actor(ANA), { title: 'Secreta', projectId: project.id });
    await expect(uc.tasks.get(actor(BETO), task.id)).rejects.toBeInstanceOf(TaskNotFoundError);
  });

  it('asignarle una tarea a alguien se la comparte aunque el proyecto sea privado, sin revelar el nombre del proyecto', async () => {
    const { useCases: uc } = setup();
    const { project } = await projectWithSections(uc, actor(ANA), 'members');
    const task = await uc.tasks.create(actor(ANA), { title: 'Para Beto', projectId: project.id, assigneeUserId: BETO });

    const detail = await uc.tasks.get(actor(BETO), task.id);
    expect(detail.task.title).toBe('Para Beto');
    expect(detail.projects).toEqual([]);
    expect(detail.canEdit).toBe(false);
    expect(detail.canComplete).toBe(true);
    const mine = await uc.tasks.myTasks(actor(BETO));
    expect(mine.map((i) => i.task.id)).toContain(task.id);
    expect(mine[0]!.projects).toEqual([]);
  });
});

describe('roles dentro del proyecto', () => {
  it('en un proyecto de toda la organización, quien no es miembro lo ve y comenta, pero no edita', async () => {
    const { useCases: uc } = setup();
    const { project } = await projectWithSections(uc, actor(ANA));
    expect((await uc.projects.get(actor(BETO), project.id)).myRole).toBe('commenter');
    await expect(uc.tasks.create(actor(BETO), { title: 'x', projectId: project.id })).rejects.toBeInstanceOf(ProjectRoleError);
  });

  it('un lector (viewer) no mueve tarjetas; un editor sí; solo el admin cambia el proyecto', async () => {
    const { useCases: uc } = setup();
    const { project, sections } = await projectWithSections(uc, actor(ANA), 'members');
    await uc.members.add(actor(ANA), project.id, { userId: BETO, role: 'viewer' });
    await uc.members.add(actor(ANA), project.id, { userId: CARLA, role: 'editor' });
    const task = await uc.tasks.create(actor(ANA), { title: 'Mover', projectId: project.id });

    const move = { projectId: project.id, sectionId: sections[1]!.id, version: task.version };
    await expect(uc.tasks.move(actor(BETO), task.id, move)).rejects.toBeInstanceOf(ProjectRoleError);
    const moved = await uc.tasks.move(actor(CARLA), task.id, move);
    expect(moved.placement.sectionId).toBe(sections[1]!.id);

    await expect(uc.projects.update(actor(CARLA), project.id, { version: project.version, name: 'Otro' })).rejects.toBeInstanceOf(ProjectRoleError);
  });

  it('Solo lectura (sin project:create) no crea proyectos', async () => {
    const { useCases: uc } = setup();
    await expect(uc.projects.create(readOnly(BETO), { name: 'x', visibility: 'organization', sectionNames: ['A'] })).rejects.toThrow('Permiso insuficiente');
  });

  it('el responsable completa su tarea aunque solo comente en el proyecto', async () => {
    const { useCases: uc } = setup();
    const { project } = await projectWithSections(uc, actor(ANA));
    const task = await uc.tasks.create(actor(ANA), { title: 'Tuya', projectId: project.id, assigneeUserId: BETO });
    const done = await uc.tasks.complete(actor(BETO), task.id);
    expect(done.completedAt).not.toBeNull();
    await expect(uc.tasks.update(actor(BETO), task.id, { version: done.version, title: 'cambio' })).rejects.toBeInstanceOf(ProjectRoleError);
  });
});

describe('aislamiento entre organizaciones', () => {
  it('otra organización no ve proyectos ni tareas, aunque conozca los ids', async () => {
    const { useCases: uc } = setup();
    const { project } = await projectWithSections(uc, actor(ANA));
    const task = await uc.tasks.create(actor(ANA), { title: 'Interna', projectId: project.id, assigneeUserId: BETO });
    const intruso = actor(BETO, { org: OTHER_ORG, permissions: ['project:read', 'project:create', 'project:admin'] });

    expect(await uc.projects.list(intruso)).toEqual([]);
    await expect(uc.projects.get(intruso, project.id)).rejects.toBeInstanceOf(ProjectNotFoundError);
    await expect(uc.tasks.get(intruso, task.id)).rejects.toBeInstanceOf(TaskNotFoundError);
    // Aun siendo el mismo usuario y responsable: en otra organización, su «Mis tareas» está vacía.
    expect(await uc.tasks.myTasks(intruso)).toEqual([]);
    await expect(uc.tasks.complete(intruso, task.id)).rejects.toBeInstanceOf(TaskNotFoundError);
  });
});
