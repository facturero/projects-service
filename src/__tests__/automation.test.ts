import { describe, expect, it } from 'vitest';
import { FormNotFoundError } from '../application/use-cases/automation-use-cases.js';
import { answersToTask, ruleMatches, validateActions } from '../domain/automation.js';
import { ProjectRoleError, ValidationError } from '../domain/errors.js';
import { ANA, BETO, CARLA, actor, projectWithSections, setup } from './helpers.js';

describe('reglas y formularios: dominio', () => {
  it('una regla coincide por proyecto, disparador y (si la tiene) sección', () => {
    const base = { id: 'r', organizationId: 'o', projectId: 'p', name: 'x', actions: [], enabled: true, runCount: 0, lastRunAt: null, lastError: null, createdBy: 'u', createdAt: new Date(), updatedAt: new Date() };
    const moved = { trigger: 'task_moved' as const, projectId: 'p', taskId: 't', sectionId: 's2' };
    expect(ruleMatches({ ...base, trigger: 'task_moved', triggerSectionId: 's2' }, moved)).toBe(true);
    expect(ruleMatches({ ...base, trigger: 'task_moved', triggerSectionId: 's1' }, moved)).toBe(false);
    expect(ruleMatches({ ...base, trigger: 'task_moved', triggerSectionId: null }, moved)).toBe(true);
    expect(ruleMatches({ ...base, trigger: 'task_moved', triggerSectionId: null, enabled: false }, moved)).toBe(false);
    expect(ruleMatches({ ...base, trigger: 'task_added', triggerSectionId: null }, moved)).toBe(false);
  });

  it('las acciones se validan; una sección de otro proyecto no vale', () => {
    expect(() => validateActions([], new Set())).toThrow(ValidationError);
    expect(() => validateActions([{ type: 'move_to_section', sectionId: 'otra' }], new Set(['s1']))).toThrow(ValidationError);
    expect(() => validateActions([{ type: 'borrar_todo' }], new Set())).toThrow(ValidationError);
    expect(validateActions([{ type: 'set_due', days: 3 }, { type: 'complete', extra: 1 }], new Set())).toEqual([{ type: 'set_due', days: 3 }, { type: 'complete' }]);
  });

  it('las respuestas del formulario van a la descripción; la fecha marcada, a la entrega', () => {
    const qs = [
      { id: 'a', label: 'Área', type: 'select' as const, required: true, options: ['Ventas', 'Contabilidad'], mapsToDue: false },
      { id: 'b', label: 'Para cuándo', type: 'date' as const, required: false, options: [], mapsToDue: true },
    ];
    expect(answersToTask(qs, ' Nuevo logo ', { a: 'Ventas', b: '2026-11-20' })).toEqual({ title: 'Nuevo logo', lines: ['Área: Ventas', 'Para cuándo: 2026-11-20'], dueOn: '2026-11-20' });
    expect(() => answersToTask(qs, 'X', {})).toThrow(ValidationError);
    expect(() => answersToTask(qs, 'X', { a: 'Otra' })).toThrow(ValidationError);
  });
});

describe('reglas', () => {
  it('«al pasar a Hecho: completar y asignar a Beto»: corre tras mover, queda en el historial y en la bitácora', async () => {
    const { useCases: uc, store } = setup();
    const { project, sections } = await projectWithSections(uc, actor(ANA));
    const done = sections[2]!;
    const rule = await uc.automation.createRule(actor(ANA), project.id, {
      name: 'Cerrar al terminar',
      trigger: 'task_moved',
      triggerSectionId: done.id,
      actions: [{ type: 'complete' }, { type: 'assign', userId: BETO }],
      enabled: true,
    });
    const t = await uc.tasks.create(actor(ANA), { title: 'Informe', projectId: project.id });
    await uc.tasks.move(actor(ANA), t.id, { version: t.version, projectId: project.id, sectionId: done.id });

    const d = await uc.tasks.get(actor(ANA), t.id);
    expect(d.task.completedAt).not.toBeNull();
    expect(d.task.assigneeUserId).toBe(BETO);
    expect(d.activity.some((a) => a.kind === 'rule_applied' && a.data.rule === 'Cerrar al terminar')).toBe(true);
    expect(store.events('projects.rule.applied')[0]!.payload).toMatchObject({ ruleId: rule.id, taskId: t.id, error: null });
    expect((await uc.automation.listRules(actor(ANA), project.id))[0]).toMatchObject({ runCount: 1, lastError: null });
  });

  it('«al agregar en Por hacer: vence en 3 días y etiquetar»; las tareas de otra sección no la disparan', async () => {
    const { useCases: uc } = setup();
    const { project, sections } = await projectWithSections(uc, actor(ANA));
    const tag = await uc.organize.createTag(actor(ANA), { name: 'Nueva' });
    await uc.automation.createRule(actor(ANA), project.id, {
      name: 'Recién llegadas',
      trigger: 'task_added',
      triggerSectionId: sections[0]!.id,
      actions: [{ type: 'set_due', days: 3 }, { type: 'add_tag', tagId: tag.id }],
      enabled: true,
    });
    const a = await uc.tasks.create(actor(ANA), { title: 'A', projectId: project.id, sectionId: sections[0]!.id });
    const b = await uc.tasks.create(actor(ANA), { title: 'B', projectId: project.id, sectionId: sections[1]!.id });
    const da = await uc.tasks.get(actor(ANA), a.id);
    expect(da.task.dueOn).toBe('2026-11-07');
    expect(da.tags.map((x) => x.name)).toEqual(['Nueva']);
    expect((await uc.tasks.get(actor(ANA), b.id)).task.dueOn).toBeNull();
  });

  it('lo que hace una regla no dispara otras: dos reglas que se mueven entre sí no entran en bucle', async () => {
    const { useCases: uc } = setup();
    const { project, sections } = await projectWithSections(uc, actor(ANA));
    const [s1, s2, s3] = sections;
    await uc.automation.createRule(actor(ANA), project.id, { name: 'A', trigger: 'task_moved', triggerSectionId: s2!.id, actions: [{ type: 'move_to_section', sectionId: s3!.id }], enabled: true });
    await uc.automation.createRule(actor(ANA), project.id, { name: 'B', trigger: 'task_moved', triggerSectionId: s3!.id, actions: [{ type: 'move_to_section', sectionId: s2!.id }], enabled: true });
    const t = await uc.tasks.create(actor(ANA), { title: 'T', projectId: project.id, sectionId: s1!.id });
    await uc.tasks.move(actor(ANA), t.id, { version: t.version, projectId: project.id, sectionId: s2!.id });
    const card = (await uc.tasks.board(actor(ANA), project.id)).cards.find((c) => c.task.id === t.id)!;
    expect(card.placement.sectionId).toBe(s3!.id);
  });

  it('si quien creó la regla ya no puede editar, la regla falla sin deshacer el cambio de la persona y deja el error', async () => {
    const { useCases: uc } = setup();
    const { project, sections } = await projectWithSections(uc, actor(ANA), 'members');
    await uc.members.add(actor(ANA), project.id, { userId: BETO, role: 'editor' });
    await uc.automation.createRule(actor(BETO), project.id, { name: 'De Beto', trigger: 'task_completed', triggerSectionId: null, actions: [{ type: 'move_to_section', sectionId: sections[2]!.id }], enabled: true });
    await uc.members.remove(actor(ANA), project.id, BETO);
    const t = await uc.tasks.create(actor(ANA), { title: 'T', projectId: project.id });
    await uc.tasks.complete(actor(ANA), t.id);
    expect((await uc.tasks.get(actor(ANA), t.id)).task.completedAt).not.toBeNull();
    const rule = (await uc.automation.listRules(actor(ANA), project.id))[0]!;
    expect(rule.runCount).toBe(1);
    expect(rule.lastError).toBeTruthy();
  });

  it('solo un editor define reglas', async () => {
    const { useCases: uc } = setup();
    const { project } = await projectWithSections(uc, actor(ANA));
    await expect(
      uc.automation.createRule(actor(BETO), project.id, { name: 'X', trigger: 'task_added', triggerSectionId: null, actions: [{ type: 'complete' }], enabled: true }),
    ).rejects.toBeInstanceOf(ProjectRoleError);
  });
});

describe('formularios', () => {
  it('alguien que no es miembro llena el formulario: crea la tarea con responsable, entrega y respuestas, y la puede seguir', async () => {
    const { useCases: uc, store } = setup();
    const { project, sections } = await projectWithSections(uc, actor(ANA), 'members');
    await uc.automation.createRule(actor(ANA), project.id, { name: 'Etiquetar solicitudes', trigger: 'task_added', triggerSectionId: null, actions: [{ type: 'add_follower', userId: CARLA }], enabled: true });
    const form = await uc.automation.createForm(actor(ANA), project.id, {
      title: 'Pedidos a diseño',
      description: 'Cuéntanos qué necesitas',
      questions: [
        { label: 'Área', type: 'select', required: true, options: ['Ventas', 'Contabilidad'] },
        { label: 'Para cuándo', type: 'date', required: false, mapsToDue: true },
      ],
      sectionId: sections[1]!.id,
      assigneeUserId: ANA,
      enabled: true,
    });
    const view = await uc.automation.publicForm(actor(BETO), form.id);
    expect(view.projectName).toBe(project.name);
    const [area, when] = view.form.questions;

    const { taskId } = await uc.automation.submit(actor(BETO), form.id, { title: 'Banner para la feria', answers: { [area!.id]: 'Ventas', [when!.id]: '2026-11-20' } });
    const d = await uc.tasks.get(actor(BETO), taskId);
    expect(d.task).toMatchObject({ title: 'Banner para la feria', assigneeUserId: ANA, dueOn: '2026-11-20', description: 'Área: Ventas\nPara cuándo: 2026-11-20' });
    expect(d.followers).toEqual(expect.arrayContaining([BETO, CARLA])); // CARLA la añadió la regla: las reglas corren también con formularios
    expect(d.projects).toEqual([]); // Beto ve SU solicitud, no el proyecto privado
    expect((await uc.tasks.board(actor(ANA), project.id)).cards.find((c) => c.task.id === taskId)!.placement.sectionId).toBe(sections[1]!.id);
    expect(store.events('projects.form.submitted')[0]!.payload).toMatchObject({ formId: form.id, taskId, submittedBy: BETO });
    expect((await uc.automation.listForms(actor(ANA), project.id))[0]!.submissionCount).toBe(1);

    await expect(uc.automation.submit(actor(BETO), form.id, { title: 'Sin área', answers: {} })).rejects.toBeInstanceOf(ValidationError);
    await uc.automation.updateForm(actor(ANA), form.id, { title: form.title, description: null, questions: view.form.questions, sectionId: null, assigneeUserId: null, enabled: false });
    await expect(uc.automation.publicForm(actor(BETO), form.id)).rejects.toBeInstanceOf(FormNotFoundError);
  });
});

describe('panel del proyecto', () => {
  it('cuenta abiertas, vencidas, por sección y responsable, completadas por semana, hitos y horas', async () => {
    const { useCases: uc } = setup();
    const { project, sections } = await projectWithSections(uc, actor(ANA));
    const a = await uc.tasks.create(actor(ANA), { title: 'Vencida', projectId: project.id, assigneeUserId: BETO, dueOn: '2026-11-01', estimatedMinutes: 120 });
    await uc.tasks.create(actor(ANA), { title: 'Esta semana', projectId: project.id, dueOn: '2026-11-06' });
    const c = await uc.tasks.create(actor(ANA), { title: 'Hecha', projectId: project.id, sectionId: sections[2]!.id });
    await uc.tasks.complete(actor(ANA), c.id);
    await uc.tasks.create(actor(ANA), { title: 'Entrega', projectId: project.id, kind: 'milestone', dueOn: '2026-11-30' });
    await uc.time.log(actor(BETO), { taskId: a.id, workedOn: '2026-11-03', minutes: 45 });

    const p = await uc.dashboard.dashboard(actor(ANA), project.id);
    expect(p.totals).toEqual({ total: 4, open: 3, completed: 1, overdue: 1, unassigned: 2, dueThisWeek: 1 });
    expect(p.bySection.map((s) => [s.name, s.open, s.completed])).toEqual([
      ['Por hacer', 3, 0],
      ['En curso', 0, 0],
      ['Hecho', 0, 1],
    ]);
    expect(p.byAssignee).toEqual([
      { userId: null, open: 2, overdue: 0 },
      { userId: BETO, open: 1, overdue: 1 },
    ]);
    expect(p.completedByWeek).toHaveLength(8);
    expect(p.completedByWeek.at(-1)).toEqual({ weekStart: '2026-11-02', count: 1 });
    expect(p.milestones).toEqual([{ taskId: expect.any(String), title: 'Entrega', dueOn: '2026-11-30', completed: false }]);
    expect(p.time).toEqual({ estimatedMinutes: 120, actualMinutes: 45 });
  });
});
