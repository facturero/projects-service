import { describe, expect, it } from 'vitest';
import {
  InvalidPositionError,
  LastAdminError,
  LastSectionError,
  ProjectArchivedError,
  SectionNotEmptyError,
  SubtaskDepthError,
  ValidationError,
  VersionConflictError,
} from '../domain/errors.js';
import { ANA, BETO, actor, projectWithSections, setup } from './helpers.js';

describe('tablero y lista', () => {
  it('crear un proyecto deja a su autor como administrador, con las secciones en el orden dado', async () => {
    const { useCases: uc, store } = setup();
    const { project, sections } = await projectWithSections(uc, actor(ANA), 'members');
    expect(sections.map((s) => s.name)).toEqual(['Por hacer', 'En curso', 'Hecho']);
    expect((await uc.projects.get(actor(ANA), project.id)).members).toEqual([expect.objectContaining({ userId: ANA, role: 'admin' })]);
    expect(store.events('projects.project.created')).toHaveLength(1);
    expect(store.events('projects.section.created')).toHaveLength(3);
  });

  it('las tareas nuevas van al final de su sección; con beforeId/afterId, donde se pidió', async () => {
    const { useCases: uc } = setup();
    const { project, sections } = await projectWithSections(uc, actor(ANA));
    const a = await uc.tasks.create(actor(ANA), { title: 'A', projectId: project.id });
    const c = await uc.tasks.create(actor(ANA), { title: 'C', projectId: project.id });
    await uc.tasks.create(actor(ANA), { title: 'B', projectId: project.id, beforeId: a.id, afterId: c.id });
    await uc.tasks.create(actor(ANA), { title: 'Primera', projectId: project.id, afterId: a.id });

    const board = await uc.tasks.board(actor(ANA), project.id);
    expect(board.cards.filter((x) => x.placement.sectionId === sections[0]!.id).map((x) => x.task.title)).toEqual(['Primera', 'A', 'B', 'C']);
  });

  it('mover una tarjeta a otra columna y entre dos tarjetas cambia solo su posición', async () => {
    const { useCases: uc, store } = setup();
    const { project, sections } = await projectWithSections(uc, actor(ANA));
    const [todo, doing] = sections;
    const x = await uc.tasks.create(actor(ANA), { title: 'X', projectId: project.id, sectionId: doing!.id });
    const z = await uc.tasks.create(actor(ANA), { title: 'Z', projectId: project.id, sectionId: doing!.id });
    const y = await uc.tasks.create(actor(ANA), { title: 'Y', projectId: project.id, sectionId: todo!.id });

    await uc.tasks.move(actor(ANA), y.id, { projectId: project.id, sectionId: doing!.id, beforeId: x.id, afterId: z.id, version: y.version });
    const board = await uc.tasks.board(actor(ANA), project.id);
    expect(board.cards.filter((c) => c.placement.sectionId === doing!.id).map((c) => c.task.title)).toEqual(['X', 'Y', 'Z']);
    expect(store.events('projects.task.moved')).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ fromSectionId: todo!.id, toSectionId: doing!.id }) }),
    ]);
  });

  it('con tareas ocultas entre dos vecinas (filtro de finalizadas) la tarjeta queda justo después de la de antes', async () => {
    const { useCases: uc } = setup();
    const { project } = await projectWithSections(uc, actor(ANA));
    const a = await uc.tasks.create(actor(ANA), { title: 'A', projectId: project.id });
    await uc.tasks.create(actor(ANA), { title: 'oculta', projectId: project.id });
    const b = await uc.tasks.create(actor(ANA), { title: 'B', projectId: project.id });
    const n = await uc.tasks.create(actor(ANA), { title: 'N', projectId: project.id });
    await uc.tasks.move(actor(ANA), n.id, { projectId: project.id, sectionId: (await uc.tasks.board(actor(ANA), project.id)).sections[0]!.id, beforeId: a.id, afterId: b.id, version: n.version });
    const titles = (await uc.tasks.board(actor(ANA), project.id)).cards.map((c) => c.task.title);
    expect(titles).toEqual(['A', 'N', 'oculta', 'B']);
  });

  it('vecinas que ya no están en esa sección o en orden invertido: 422 y nada cambia', async () => {
    const { useCases: uc } = setup();
    const { project, sections } = await projectWithSections(uc, actor(ANA));
    const a = await uc.tasks.create(actor(ANA), { title: 'A', projectId: project.id });
    const b = await uc.tasks.create(actor(ANA), { title: 'B', projectId: project.id });
    const n = await uc.tasks.create(actor(ANA), { title: 'N', projectId: project.id, sectionId: sections[1]!.id });
    await expect(
      uc.tasks.move(actor(ANA), n.id, { projectId: project.id, sectionId: sections[0]!.id, beforeId: b.id, afterId: a.id, version: n.version }),
    ).rejects.toBeInstanceOf(InvalidPositionError);
    expect((await uc.tasks.get(actor(ANA), n.id)).task.version).toBe(n.version);
  });

  it('dos personas que mueven la misma tarjeta con la misma versión: la segunda recibe 409 con la versión actual', async () => {
    const { useCases: uc } = setup();
    const { project, sections } = await projectWithSections(uc, actor(ANA));
    await uc.members.add(actor(ANA), project.id, { userId: BETO, role: 'editor' });
    const t = await uc.tasks.create(actor(ANA), { title: 'T', projectId: project.id });

    await uc.tasks.move(actor(ANA), t.id, { projectId: project.id, sectionId: sections[1]!.id, version: t.version });
    const err = await uc.tasks.move(actor(BETO), t.id, { projectId: project.id, sectionId: sections[2]!.id, version: t.version }).catch((e) => e);
    expect(err).toBeInstanceOf(VersionConflictError);
    expect(err.currentVersion).toBe(t.version + 1);
    expect((await uc.tasks.board(actor(ANA), project.id)).cards[0]!.placement.sectionId).toBe(sections[1]!.id);
  });

  it('arrastrar 300 veces al principio de la columna reequilibra: los rangos siguen cortos y el orden es el pedido', async () => {
    const { useCases: uc, store } = setup();
    const { project, sections } = await projectWithSections(uc, actor(ANA));
    const sectionId = sections[0]!.id;
    const created: string[] = [];
    for (let i = 0; i < 300; i++) {
      const first = created[0];
      const t = await uc.tasks.create(actor(ANA), { title: `T${i}`, projectId: project.id, sectionId, ...(first ? { afterId: first } : {}) });
      created.unshift(t.id);
    }
    const board = await uc.tasks.board(actor(ANA), project.id);
    expect(board.cards.map((c) => c.task.id)).toEqual(created);
    expect(Math.max(...[...store.state.placements.values()].map((p) => p.rank.length))).toBeLessThanOrEqual(32);
  });

  it('un proyecto archivado no se cambia hasta desarchivarlo', async () => {
    const { useCases: uc } = setup();
    const { project } = await projectWithSections(uc, actor(ANA));
    const t = await uc.tasks.create(actor(ANA), { title: 'T', projectId: project.id });
    await uc.projects.archive(actor(ANA), project.id);
    await expect(uc.tasks.create(actor(ANA), { title: 'x', projectId: project.id })).rejects.toBeInstanceOf(ProjectArchivedError);
    await expect(uc.tasks.complete(actor(ANA), t.id)).rejects.toBeInstanceOf(ProjectArchivedError);
    await uc.projects.unarchive(actor(ANA), project.id);
    expect((await uc.tasks.complete(actor(ANA), t.id)).completedAt).not.toBeNull();
  });
});

describe('tareas', () => {
  it('editar con una versión vieja es 409; con la actual, guarda y publica qué cambió', async () => {
    const { useCases: uc, store } = setup();
    const { project } = await projectWithSections(uc, actor(ANA));
    const t = await uc.tasks.create(actor(ANA), { title: 'Borrador', projectId: project.id });
    const v2 = await uc.tasks.update(actor(ANA), t.id, { version: t.version, title: 'Final', dueOn: '2026-11-10' });
    await expect(uc.tasks.update(actor(ANA), t.id, { version: t.version, title: 'Pisado' })).rejects.toBeInstanceOf(VersionConflictError);
    expect(v2.title).toBe('Final');
    expect(store.events('projects.task.updated').at(-1)!.payload.changes).toEqual(['title', 'dueOn']);
  });

  it('cambiar el responsable publica `projects.task.assigned` con a quién avisar, y marca cuándo se asignó', async () => {
    const { useCases: uc, store, advance } = setup();
    const { project } = await projectWithSections(uc, actor(ANA));
    const t = await uc.tasks.create(actor(ANA), { title: 'T', projectId: project.id });
    advance(60_000);
    const v2 = await uc.tasks.update(actor(ANA), t.id, { version: t.version, assigneeUserId: BETO });
    expect(v2.assignedAt).not.toBeNull();
    const ev = store.events('projects.task.assigned').at(-1)!;
    expect(ev.payload).toMatchObject({ assigneeUserId: BETO, previousAssigneeUserId: null, userIds: [BETO], organizationId: project.organizationId });
    // Solo cambió el responsable: no hay además un «updated» vacío.
    expect(store.events('projects.task.updated')).toHaveLength(0);
  });

  it('la fecha de inicio no puede ser posterior a la de entrega', async () => {
    const { useCases: uc } = setup();
    await expect(uc.tasks.create(actor(ANA), { title: 'T', startOn: '2026-11-10', dueOn: '2026-11-01' })).rejects.toBeInstanceOf(ValidationError);
  });

  it('subtareas: un solo nivel, cuentan en la tarjeta de su madre y no aparecen como tarjeta propia', async () => {
    const { useCases: uc } = setup();
    const { project } = await projectWithSections(uc, actor(ANA));
    const madre = await uc.tasks.create(actor(ANA), { title: 'Madre', projectId: project.id });
    const s1 = await uc.tasks.create(actor(ANA), { title: 'Paso 1', parentTaskId: madre.id });
    await uc.tasks.create(actor(ANA), { title: 'Paso 2', parentTaskId: madre.id });
    await uc.tasks.complete(actor(ANA), s1.id);
    await expect(uc.tasks.create(actor(ANA), { title: 'Nieta', parentTaskId: s1.id })).rejects.toBeInstanceOf(SubtaskDepthError);

    const board = await uc.tasks.board(actor(ANA), project.id);
    expect(board.cards.map((c) => c.task.title)).toEqual(['Madre']);
    expect(board.cards[0]!.subtasks).toEqual({ total: 2, completed: 1 });
    expect((await uc.tasks.get(actor(ANA), madre.id)).subtasks.map((s) => s.title)).toEqual(['Paso 1', 'Paso 2']);
  });

  it('una tarea borrada va a la papelera: deja de verse con sus subtareas', async () => {
    const { useCases: uc, store } = setup();
    const { project } = await projectWithSections(uc, actor(ANA));
    const t = await uc.tasks.create(actor(ANA), { title: 'T', projectId: project.id, assigneeUserId: ANA });
    const sub = await uc.tasks.create(actor(ANA), { title: 'sub', parentTaskId: t.id, assigneeUserId: ANA });
    await uc.tasks.delete(actor(ANA), t.id);
    expect((await uc.tasks.board(actor(ANA), project.id)).cards).toEqual([]);
    expect((await uc.tasks.myTasks(actor(ANA))).map((i) => i.task.id)).not.toContain(sub.id);
    expect(store.state.tasks.get(t.id)!.deletedAt).not.toBeNull();
  });

  it('Mis tareas incluye mis tareas personales sin proyecto, y nadie más las ve', async () => {
    const { useCases: uc } = setup();
    const mia = await uc.tasks.create(actor(ANA), { title: 'Llamar al contador' });
    expect((await uc.tasks.myTasks(actor(ANA))).map((i) => i.task.title)).toEqual(['Llamar al contador']);
    await expect(uc.tasks.get(actor(BETO), mia.id)).rejects.toThrow('Tarea no encontrada');
  });

  it('si la transacción falla, no queda ni la tarea ni su evento', async () => {
    const { useCases: uc, store } = setup();
    const { project } = await projectWithSections(uc, actor(ANA));
    const before = store.events().length;
    store.failOnCommit = true;
    await expect(uc.tasks.create(actor(ANA), { title: 'T', projectId: project.id })).rejects.toThrow('fallo simulado');
    expect(store.events().length).toBe(before);
    expect([...store.state.tasks.values()]).toHaveLength(0);
  });
});

describe('secciones y miembros', () => {
  it('borrar una sección con tareas exige decir adónde moverlas; ninguna se pierde', async () => {
    const { useCases: uc } = setup();
    const { project, sections } = await projectWithSections(uc, actor(ANA));
    await uc.tasks.create(actor(ANA), { title: 'A', projectId: project.id, sectionId: sections[0]!.id });
    await uc.tasks.create(actor(ANA), { title: 'B', projectId: project.id, sectionId: sections[0]!.id });
    await uc.tasks.create(actor(ANA), { title: 'C', projectId: project.id, sectionId: sections[1]!.id });

    await expect(uc.sections.delete(actor(ANA), project.id, sections[0]!.id, null)).rejects.toBeInstanceOf(SectionNotEmptyError);
    await uc.sections.delete(actor(ANA), project.id, sections[0]!.id, sections[1]!.id);
    const board = await uc.tasks.board(actor(ANA), project.id);
    expect(board.sections).toHaveLength(2);
    expect(board.cards.filter((c) => c.placement.sectionId === sections[1]!.id).map((c) => c.task.title)).toEqual(['C', 'A', 'B']);
  });

  it('una columna que solo tiene tareas en la papelera se borra sin preguntar', async () => {
    const { useCases: uc } = setup();
    const { project, sections } = await projectWithSections(uc, actor(ANA));
    const t = await uc.tasks.create(actor(ANA), { title: 'A', projectId: project.id, sectionId: sections[2]!.id });
    await uc.tasks.delete(actor(ANA), t.id);
    await uc.sections.delete(actor(ANA), project.id, sections[2]!.id, null);
    expect((await uc.tasks.board(actor(ANA), project.id)).sections).toHaveLength(2);
  });

  it('no se borra la última sección', async () => {
    const { useCases: uc } = setup();
    const { project } = await uc.projects.create(actor(ANA), { name: 'Uno', visibility: 'organization', sectionNames: ['Única'] });
    const [only] = (await uc.tasks.board(actor(ANA), project.id)).sections;
    await expect(uc.sections.delete(actor(ANA), project.id, only!.id, null)).rejects.toBeInstanceOf(LastSectionError);
  });

  it('mover una columna la deja entre las que se pidió', async () => {
    const { useCases: uc } = setup();
    const { project, sections } = await projectWithSections(uc, actor(ANA));
    await uc.sections.move(actor(ANA), project.id, sections[2]!.id, { afterId: sections[0]!.id });
    expect((await uc.tasks.board(actor(ANA), project.id)).sections.map((s) => s.name)).toEqual(['Hecho', 'Por hacer', 'En curso']);
  });

  it('el proyecto nunca se queda sin administrador', async () => {
    const { useCases: uc } = setup();
    const { project } = await projectWithSections(uc, actor(ANA));
    await expect(uc.members.updateRole(actor(ANA), project.id, ANA, 'editor')).rejects.toBeInstanceOf(LastAdminError);
    await expect(uc.members.remove(actor(ANA), project.id, ANA)).rejects.toBeInstanceOf(LastAdminError);
    await uc.members.add(actor(ANA), project.id, { userId: BETO, role: 'admin' });
    await uc.members.remove(actor(ANA), project.id, ANA);
    expect((await uc.projects.get(actor(BETO), project.id)).members.map((m) => m.userId)).toEqual([BETO]);
  });

  it('cualquiera puede salirse de un proyecto; quitar a otro es del administrador', async () => {
    const { useCases: uc } = setup();
    const { project } = await projectWithSections(uc, actor(ANA), 'members');
    await uc.members.add(actor(ANA), project.id, { userId: BETO, role: 'viewer' });
    await expect(uc.members.remove(actor(BETO), project.id, ANA)).rejects.toThrow('rol');
    await uc.members.remove(actor(BETO), project.id, BETO);
    expect((await uc.projects.get(actor(ANA), project.id)).members.map((m) => m.userId)).toEqual([ANA]);
  });
});
