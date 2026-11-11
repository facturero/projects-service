import { describe, expect, it } from 'vitest';
import { ForbiddenError, ProjectRoleError, ValidationError } from '../domain/errors.js';
import { TEMPLATES } from '../domain/templates.js';
import { ANA, BETO, actor, projectWithSections, readOnly, setup, tagAdmin } from './helpers.js';

const CUSTOMER = '99999999-0000-4000-8000-000000000001';

describe('vínculos con el ERP', () => {
  it('una tarea se vincula a un cliente; la ficha del cliente ve solo las tareas que quien pregunta puede ver', async () => {
    const { useCases: uc, store } = setup();
    const { project: open } = await projectWithSections(uc, actor(ANA));
    const { project: secret } = await projectWithSections(uc, actor(ANA), 'members');
    const a = await uc.tasks.create(actor(ANA), { title: 'Cotizar ampliación', projectId: open.id });
    const b = await uc.tasks.create(actor(ANA), { title: 'Negociar descuento', projectId: secret.id });
    await uc.organize.addLink(actor(ANA), a.id, { entityType: 'customer', entityId: CUSTOMER, label: 'Café Central' });
    await uc.organize.addLink(actor(ANA), b.id, { entityType: 'customer', entityId: CUSTOMER, label: 'Café Central' });
    // Vincular dos veces lo mismo no duplica.
    await uc.organize.addLink(actor(ANA), a.id, { entityType: 'customer', entityId: CUSTOMER, label: 'Café Central' });

    expect((await uc.organize.linkedTasks(actor(ANA), 'customer', CUSTOMER)).map((t) => t.title).sort()).toEqual(['Cotizar ampliación', 'Negociar descuento']);
    expect((await uc.organize.linkedTasks(actor(BETO), 'customer', CUSTOMER)).map((t) => t.title)).toEqual(['Cotizar ampliación']);
    expect((await uc.tasks.get(actor(ANA), a.id)).links).toEqual([expect.objectContaining({ entityType: 'customer', label: 'Café Central' })]);
    expect(store.events('projects.link.added')).toHaveLength(2);
  });

  it('quien no edita la tarea no la vincula', async () => {
    const { useCases: uc } = setup();
    const { project } = await projectWithSections(uc, actor(ANA));
    const a = await uc.tasks.create(actor(ANA), { title: 'T', projectId: project.id });
    await expect(uc.organize.addLink(actor(BETO), a.id, { entityType: 'invoice', entityId: CUSTOMER, label: '001-001-000123' })).rejects.toBeInstanceOf(ProjectRoleError);
  });
});

describe('etiquetas', () => {
  it('«Urgente» y «urgente» son la misma etiqueta; poner y quitar publica sus eventos', async () => {
    const { useCases: uc, store } = setup();
    const t1 = await uc.organize.createTag(tagAdmin(ANA), { name: 'Urgente', color: 'error' });
    const t2 = await uc.organize.createTag(tagAdmin(BETO), { name: 'urgente' });
    expect(t2.id).toBe(t1.id);
    const task = await uc.tasks.create(actor(ANA), { title: 'T' });
    expect((await uc.organize.setTag(actor(ANA), task.id, t1.id, true)).map((t) => t.name)).toEqual(['Urgente']);
    expect(await uc.organize.setTag(actor(ANA), task.id, t1.id, false)).toEqual([]);
    expect(store.events('projects.task.tagged')).toHaveLength(1);
    expect(store.events('projects.task.untagged')).toHaveLength(1);
  });

  it('crear, renombrar, cambiar el color y eliminar piden «Administrar etiquetas»; poner una existente, solo poder editar la tarea', async () => {
    const { useCases: uc } = setup();
    const tag = await uc.organize.createTag(tagAdmin(ANA), { name: 'Urgente', color: 'error' });
    await expect(uc.organize.createTag(actor(BETO), { name: 'Mía' })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(uc.organize.createTag(readOnly(BETO), { name: 'Mía' })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(uc.organize.updateTag(actor(BETO), tag.id, { name: 'Basura' })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(uc.organize.deleteTag(actor(BETO), tag.id)).rejects.toBeInstanceOf(ForbiddenError);
    const task = await uc.tasks.create(actor(BETO), { title: 'Mía' });
    expect((await uc.organize.setTag(actor(BETO), task.id, tag.id, true)).map((t) => t.name)).toEqual(['Urgente']);
  });

  it('renombrar y cambiar el color: se ve en todas las tareas; un nombre repetido se rechaza; publica el cambio', async () => {
    const { useCases: uc, store } = setup();
    const urgente = await uc.organize.createTag(tagAdmin(ANA), { name: 'Urgente', color: 'error' });
    await uc.organize.createTag(tagAdmin(ANA), { name: 'Cliente' });
    const task = await uc.tasks.create(actor(ANA), { title: 'T' });
    await uc.organize.setTag(actor(ANA), task.id, urgente.id, true);
    const changed = await uc.organize.updateTag(tagAdmin(ANA), urgente.id, { name: 'Prioridad', color: 'warning' });
    expect(changed).toMatchObject({ name: 'Prioridad', color: 'warning' });
    expect((await uc.tasks.get(actor(ANA), task.id)).tags.map((t) => [t.name, t.color])).toEqual([['Prioridad', 'warning']]);
    await expect(uc.organize.updateTag(tagAdmin(ANA), urgente.id, { name: 'cliente' })).rejects.toBeInstanceOf(ValidationError);
    expect(store.events('projects.tag.updated')[0]!.payload).toMatchObject({ name: 'Prioridad', previousName: 'Urgente', color: 'warning', previousColor: 'error' });
  });

  it('eliminar la quita de todas las tareas, dice en cuántas estaba y la lista cuenta el uso', async () => {
    const { useCases: uc, store } = setup();
    const tag = await uc.organize.createTag(tagAdmin(ANA), { name: 'Vieja' });
    for (const title of ['A', 'B']) {
      const t = await uc.tasks.create(actor(ANA), { title });
      await uc.organize.setTag(actor(ANA), t.id, tag.id, true);
    }
    expect((await uc.organize.listTags(actor(BETO))).find((t) => t.id === tag.id)?.taskCount).toBe(2);
    expect(await uc.organize.deleteTag(tagAdmin(ANA), tag.id)).toEqual({ taskCount: 2 });
    expect(await uc.organize.listTags(actor(ANA))).toEqual([]);
    expect(store.events('projects.tag.deleted')[0]!.payload).toMatchObject({ name: 'Vieja', taskCount: 2 });
  });
});

describe('campos personalizados', () => {
  it('cada tipo valida su valor; el tablero y el detalle traen campos y valores', async () => {
    const { useCases: uc } = setup();
    const { project } = await projectWithSections(uc, actor(ANA));
    const prio = await uc.organize.createField(actor(ANA), project.id, {
      name: 'Prioridad',
      type: 'select',
      options: [{ label: 'Alta', color: 'error' }, { label: 'Baja', color: 'success' }],
    });
    const budget = await uc.organize.createField(actor(ANA), project.id, { name: 'Presupuesto', type: 'number' });
    const t = await uc.tasks.create(actor(ANA), { title: 'T', projectId: project.id });

    await uc.organize.setFieldValue(actor(ANA), t.id, prio.id, prio.options[0]!.id);
    expect(await uc.organize.setFieldValue(actor(ANA), t.id, budget.id, '1500,50')).toBe(1500.5);
    await expect(uc.organize.setFieldValue(actor(ANA), t.id, budget.id, 'mucho')).rejects.toBeInstanceOf(ValidationError);
    await expect(uc.organize.setFieldValue(actor(ANA), t.id, prio.id, '00000000-0000-4000-8000-000000000999')).rejects.toBeInstanceOf(ValidationError);

    const board = await uc.tasks.board(actor(ANA), project.id);
    expect(board.fields.map((f) => f.name)).toEqual(['Prioridad', 'Presupuesto']);
    expect(board.cards[0]!.values).toEqual({ [prio.id]: prio.options[0]!.id, [budget.id]: 1500.5 });
    expect((await uc.tasks.get(actor(ANA), t.id)).fields.map((f) => [f.field.name, f.value])).toEqual([
      ['Prioridad', prio.options[0]!.id],
      ['Presupuesto', 1500.5],
    ]);
  });

  it('quitar una opción deja vacías las tareas que la tenían; renombrarla no', async () => {
    const { useCases: uc } = setup();
    const { project } = await projectWithSections(uc, actor(ANA));
    const f = await uc.organize.createField(actor(ANA), project.id, { name: 'Etapa', type: 'select', options: [{ label: 'Diseño' }, { label: 'Obra' }] });
    const [design, build] = f.options;
    const a = await uc.tasks.create(actor(ANA), { title: 'A', projectId: project.id });
    const b = await uc.tasks.create(actor(ANA), { title: 'B', projectId: project.id });
    await uc.organize.setFieldValue(actor(ANA), a.id, f.id, design!.id);
    await uc.organize.setFieldValue(actor(ANA), b.id, f.id, build!.id);

    await uc.organize.updateField(actor(ANA), f.id, { options: [{ id: design!.id, label: 'Diseño y planos' }] });
    const cards = (await uc.tasks.board(actor(ANA), project.id)).cards;
    expect(cards.find((c) => c.task.id === a.id)!.values).toEqual({ [f.id]: design!.id });
    expect(cards.find((c) => c.task.id === b.id)!.values).toEqual({});
  });

  it('un campo de otro proyecto no se llena en esta tarea; solo un editor define campos', async () => {
    const { useCases: uc } = setup();
    const { project: p1 } = await projectWithSections(uc, actor(ANA));
    const { project: p2 } = await projectWithSections(uc, actor(ANA));
    const other = await uc.organize.createField(actor(ANA), p2.id, { name: 'X', type: 'text' });
    const t = await uc.tasks.create(actor(ANA), { title: 'T', projectId: p1.id });
    await expect(uc.organize.setFieldValue(actor(ANA), t.id, other.id, 'hola')).rejects.toThrow('Ese campo no es de ningún proyecto de la tarea.');
    await expect(uc.organize.createField(actor(BETO), p1.id, { name: 'Y', type: 'text' })).rejects.toBeInstanceOf(ProjectRoleError);
  });
});

describe('plantillas y duplicar', () => {
  it('cada plantilla de fábrica crea su proyecto con secciones, tareas fechadas desde el inicio, hitos y dependencias', async () => {
    const { useCases: uc, store } = setup();
    for (const template of TEMPLATES) {
      const project = await uc.workspace.createFromTemplate(actor(ANA), { templateCode: template.code, visibility: 'organization', startOn: '2026-12-01', locale: 'es' });
      const board = await uc.tasks.board(actor(ANA), project.id);
      expect(board.sections.map((s) => s.name)).toEqual(template.sections.map((s) => s.name.es));
      expect(board.cards).toHaveLength(template.sections.reduce((n, s) => n + s.tasks.length, 0));
      expect(board.cards.every((c) => c.task.dueOn && c.task.dueOn >= '2026-12-01')).toBe(true);
      const expectedDeps = template.sections.flatMap((s) => s.tasks).reduce((n, t) => n + (t.after?.length ?? 0), 0);
      expect(board.dependencies).toHaveLength(expectedDeps);
    }
    const close = (await uc.projects.list(actor(ANA))).find((p) => p.project.name === 'Cierre contable mensual')!;
    const cards = (await uc.tasks.board(actor(ANA), close.project.id)).cards;
    expect(cards.find((c) => c.task.kind === 'milestone')!.task.dueOn).toBe('2026-12-09');
    expect(store.events('projects.project.created').at(-1)!.payload).toMatchObject({ templateCode: 'hiring' });
  });

  it('las plantillas salen en el idioma pedido; Solo lectura no crea proyectos desde plantilla', async () => {
    const { useCases: uc } = setup();
    expect(uc.workspace.listTemplates('en').find((t) => t.code === 'month_end_close')!.name).toBe('Month-end close');
    await expect(uc.workspace.createFromTemplate(readOnly(BETO), { templateCode: 'hiring', visibility: 'organization', startOn: '2026-12-01', locale: 'es' })).rejects.toThrow('Permiso insuficiente');
  });

  it('duplicar copia secciones, tareas, subtareas, campos con sus valores, etiquetas y dependencias; no responsables ni finalizadas', async () => {
    const { useCases: uc } = setup();
    const { project } = await projectWithSections(uc, actor(ANA));
    const f = await uc.organize.createField(actor(ANA), project.id, { name: 'Etapa', type: 'select', options: [{ label: 'Uno' }] });
    const tag = await uc.organize.createTag(tagAdmin(ANA), { name: 'Mensual' });
    const a = await uc.tasks.create(actor(ANA), { title: 'Conciliar', projectId: project.id, assigneeUserId: BETO, dueOn: '2026-11-30' });
    const b = await uc.tasks.create(actor(ANA), { title: 'Declarar', projectId: project.id });
    await uc.tasks.create(actor(ANA), { title: 'Paso', parentTaskId: a.id });
    await uc.organize.setFieldValue(actor(ANA), a.id, f.id, f.options[0]!.id);
    await uc.organize.setTag(actor(ANA), a.id, tag.id, true);
    await uc.timeline.addDependency(actor(ANA), b.id, a.id);
    await uc.tasks.complete(actor(ANA), a.id);

    const copy = await uc.workspace.duplicate(actor(ANA), project.id, { name: 'Cierre de diciembre' });
    const board = await uc.tasks.board(actor(ANA), copy.id);
    const ca = board.cards.find((c) => c.task.title === 'Conciliar')!;
    expect(ca.task.assigneeUserId).toBeNull();
    expect(ca.task.completedAt).toBeNull();
    expect(ca.task.dueOn).toBe('2026-11-30');
    expect(ca.subtasks.total).toBe(1);
    expect(ca.tags.map((t) => t.name)).toEqual(['Mensual']);
    expect(Object.values(ca.values)).toEqual([f.options[0]!.id]);
    expect(board.fields[0]!.id).not.toBe(f.id);
    expect(board.dependencies).toHaveLength(1);
  });
});

describe('buscar y editar en lote', () => {
  it('la búsqueda no devuelve tareas de proyectos privados ajenos', async () => {
    const { useCases: uc } = setup();
    const { project: open } = await projectWithSections(uc, actor(ANA));
    const { project: secret } = await projectWithSections(uc, actor(ANA), 'members');
    await uc.tasks.create(actor(ANA), { title: 'Contrato del hosting', projectId: open.id });
    await uc.tasks.create(actor(ANA), { title: 'Contrato confidencial', projectId: secret.id });
    expect((await uc.workspace.search(actor(BETO), 'contrato')).tasks.map((r) => r.task.title)).toEqual(['Contrato del hosting']);
    expect((await uc.workspace.search(actor(ANA), 'contrato')).tasks).toHaveLength(2);
    await expect(uc.workspace.search(actor(ANA), 'c')).rejects.toBeInstanceOf(ValidationError);
  });

  it('en lote: aplica a las que puede y explica las que no, sin deshacer las demás', async () => {
    const { useCases: uc } = setup();
    const { project } = await projectWithSections(uc, actor(ANA));
    const { project: theirs } = await projectWithSections(uc, actor(BETO));
    const a = await uc.tasks.create(actor(ANA), { title: 'A', projectId: project.id });
    const b = await uc.tasks.create(actor(ANA), { title: 'B', projectId: project.id });
    const c = await uc.tasks.create(actor(BETO), { title: 'C', projectId: theirs.id });

    const results = await uc.workspace.bulk(actor(ANA), [a.id, b.id, c.id], { type: 'assign', assigneeUserId: BETO });
    expect(results.map((r) => r.ok)).toEqual([true, true, false]);
    expect(results[2]!.code).toBe('PROJECT_ROLE_INSUFFICIENT');
    expect((await uc.tasks.get(actor(ANA), a.id)).task.assigneeUserId).toBe(BETO);

    await uc.workspace.bulk(actor(ANA), [a.id, b.id], { type: 'complete' });
    expect((await uc.tasks.board(actor(ANA), project.id)).cards.every((x) => x.task.completedAt)).toBe(true);
  });
});
