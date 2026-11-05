import { describe, expect, it } from 'vitest';
import { DependencyCycleError, ProjectRoleError, TaskNotFoundError } from '../domain/errors.js';
import { ANA, BETO, CARLA, actor, projectWithSections, setup } from './helpers.js';

describe('dependencias (fin → inicio)', () => {
  it('«B espera a A»: aparece en el detalle de las dos y como flecha del tablero', async () => {
    const { useCases: uc, store } = setup();
    const { project } = await projectWithSections(uc, actor(ANA));
    const a = await uc.tasks.create(actor(ANA), { title: 'Diseño', projectId: project.id });
    const b = await uc.tasks.create(actor(ANA), { title: 'Desarrollo', projectId: project.id });
    await uc.timeline.addDependency(actor(ANA), b.id, a.id);

    expect((await uc.tasks.get(actor(ANA), b.id)).blockedBy.map((t) => t.title)).toEqual(['Diseño']);
    expect((await uc.tasks.get(actor(ANA), a.id)).blocking.map((t) => t.title)).toEqual(['Desarrollo']);
    expect((await uc.tasks.board(actor(ANA), project.id)).dependencies).toEqual([expect.objectContaining({ taskId: b.id, dependsOnTaskId: a.id })]);
    expect(store.events('projects.dependency.added')).toHaveLength(1);
    // Repetirla no duplica ni vuelve a publicar.
    await uc.timeline.addDependency(actor(ANA), b.id, a.id);
    expect(store.events('projects.dependency.added')).toHaveLength(1);
  });

  it('rechaza ciclos: directos, indirectos y consigo misma', async () => {
    const { useCases: uc } = setup();
    const a = await uc.tasks.create(actor(ANA), { title: 'A' });
    const b = await uc.tasks.create(actor(ANA), { title: 'B' });
    const c = await uc.tasks.create(actor(ANA), { title: 'C' });
    await uc.timeline.addDependency(actor(ANA), b.id, a.id);
    await uc.timeline.addDependency(actor(ANA), c.id, b.id);
    await expect(uc.timeline.addDependency(actor(ANA), a.id, b.id)).rejects.toBeInstanceOf(DependencyCycleError);
    await expect(uc.timeline.addDependency(actor(ANA), a.id, c.id)).rejects.toBeInstanceOf(DependencyCycleError);
    await expect(uc.timeline.addDependency(actor(ANA), a.id, a.id)).rejects.toBeInstanceOf(DependencyCycleError);
  });

  it('no se enlaza a una tarea que no se puede ver; y no se muestra el título de una bloqueante de un proyecto privado ajeno', async () => {
    const { useCases: uc } = setup();
    const { project: secret } = await projectWithSections(uc, actor(ANA), 'members');
    const hidden = await uc.tasks.create(actor(ANA), { title: 'Secreta', projectId: secret.id });
    const { project: shared } = await projectWithSections(uc, actor(ANA));
    await uc.members.add(actor(ANA), shared.id, { userId: BETO, role: 'editor' });
    const mine = await uc.tasks.create(actor(BETO), { title: 'Mía', projectId: shared.id });
    await expect(uc.timeline.addDependency(actor(BETO), mine.id, hidden.id)).rejects.toBeInstanceOf(TaskNotFoundError);

    // Ana, que ve las dos, enlaza; Beto ve «Mía» pero no debe ver el título de «Secreta».
    await uc.timeline.addDependency(actor(ANA), mine.id, hidden.id);
    expect((await uc.tasks.get(actor(ANA), mine.id)).blockedBy.map((t) => t.title)).toEqual(['Secreta']);
    expect((await uc.tasks.get(actor(BETO), mine.id)).blockedBy).toEqual([]);
  });

  it('solo quien edita la tarea que espera crea o quita dependencias', async () => {
    const { useCases: uc } = setup();
    const { project } = await projectWithSections(uc, actor(ANA));
    const a = await uc.tasks.create(actor(ANA), { title: 'A', projectId: project.id });
    const b = await uc.tasks.create(actor(ANA), { title: 'B', projectId: project.id });
    await expect(uc.timeline.addDependency(actor(BETO), b.id, a.id)).rejects.toBeInstanceOf(ProjectRoleError);
  });

  it('al completar la última que la bloqueaba, su responsable recibe «ya puedes empezar»; si aún espera a otra, no', async () => {
    const { useCases: uc, store } = setup();
    const a = await uc.tasks.create(actor(ANA), { title: 'A' });
    const b = await uc.tasks.create(actor(ANA), { title: 'B' });
    const c = await uc.tasks.create(actor(ANA), { title: 'C', assigneeUserId: CARLA });
    await uc.timeline.addDependency(actor(ANA), c.id, a.id);
    await uc.timeline.addDependency(actor(ANA), c.id, b.id);

    await uc.tasks.complete(actor(ANA), a.id);
    expect(store.events('projects.task.unblocked')).toHaveLength(0);
    await uc.tasks.complete(actor(ANA), b.id);
    expect(store.events('projects.task.unblocked')).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ taskId: c.id, blockedByTaskId: b.id, userIds: [CARLA] }) }),
    ]);
  });
});

describe('estado del proyecto', () => {
  it('un editor publica el estado; avisa a los demás miembros; la lista de proyectos muestra el último', async () => {
    const { useCases: uc, store, advance } = setup();
    const { project } = await projectWithSections(uc, actor(ANA), 'members');
    await uc.members.add(actor(ANA), project.id, { userId: BETO, role: 'editor' });
    await uc.members.add(actor(ANA), project.id, { userId: CARLA, role: 'viewer' });

    await uc.timeline.postStatusUpdate(actor(ANA), project.id, { status: 'on_track' });
    advance(60_000);
    const body = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Falta el proveedor del hosting' }] }] };
    await uc.timeline.postStatusUpdate(actor(BETO), project.id, { status: 'at_risk', bodyDoc: body });

    const posted = store.events('projects.status_update.posted').at(-1)!;
    expect(posted.payload).toMatchObject({ status: 'at_risk', excerpt: 'Falta el proveedor del hosting' });
    expect((posted.payload.userIds as string[]).sort()).toEqual([ANA, CARLA].sort());
    expect((await uc.projects.list(actor(ANA)))[0]!.latestStatus?.status).toBe('at_risk');
    expect((await uc.timeline.listStatusUpdates(actor(CARLA), project.id)).map((u) => u.status)).toEqual(['at_risk', 'on_track']);
    await expect(uc.timeline.postStatusUpdate(actor(CARLA), project.id, { status: 'complete' })).rejects.toBeInstanceOf(ProjectRoleError);
  });
});
