import { describe, expect, it } from 'vitest';
import { ForbiddenError, ProjectRoleError, TimeEntryNotFoundError, TimerNotRunningError, ValidationError } from '../domain/errors.js';
import { addDaysIso, allocate, mondayOf } from '../domain/workload.js';
import { ANA, BETO, CARLA, actor, orgAdmin, projectWithSections, setup } from './helpers.js';

const readAll = (userId: string) => actor(userId, { permissions: ['project:read', 'project:create', 'time_entry:read_all'] });

describe('carga de trabajo: funciones puras', () => {
  it('el lunes de la semana y el reparto entre días laborables', () => {
    expect(mondayOf('2026-11-04')).toBe('2026-11-02'); // miércoles → lunes
    expect(mondayOf('2026-11-08')).toBe('2026-11-02'); // domingo → lunes anterior
    expect(addDaysIso('2026-12-31', 1)).toBe('2027-01-01');
    const weeks = ['2026-11-02', '2026-11-09'];
    // Jueves a martes: 4 días laborables (jue, vie, lun, mar); el fin de semana no se cuenta.
    const a = allocate({ startOn: '2026-11-05', dueOn: '2026-11-10', estimatedMinutes: 480 }, weeks);
    expect(Object.fromEntries(a.minutes)).toEqual({ '2026-11-02': 240, '2026-11-09': 240 });
    expect([...a.weeks]).toEqual(weeks);
    // Una tarea de solo fin de semana pone su tiempo en el día de entrega; sin estimación cuenta la semana, sin minutos.
    expect(Object.fromEntries(allocate({ startOn: '2026-11-07', dueOn: '2026-11-08', estimatedMinutes: 60 }, weeks).minutes)).toEqual({ '2026-11-02': 60 });
    const none = allocate({ startOn: null, dueOn: '2026-11-12', estimatedMinutes: null }, weeks);
    expect(none.minutes.size).toBe(0);
    expect([...none.weeks]).toEqual(['2026-11-09']);
  });
});

describe('registrar horas', () => {
  it('el responsable registra horas; salen en el detalle, en la tarjeta del tablero y en el outbox', async () => {
    const { useCases: uc, store } = setup();
    const { project } = await projectWithSections(uc, actor(ANA));
    const task = await uc.tasks.create(actor(ANA), { title: 'Diseño', projectId: project.id, assigneeUserId: ANA, estimatedMinutes: 600 });
    const entry = await uc.time.log(actor(ANA), { taskId: task.id, workedOn: '2026-11-04', minutes: 90, note: '  Bocetos  ' });
    expect(entry).toMatchObject({ projectId: project.id, billable: true, note: 'Bocetos', source: 'manual' });
    await uc.time.log(actor(ANA), { taskId: task.id, workedOn: '2026-11-04', minutes: 30, billable: false });

    const detail = await uc.tasks.get(actor(ANA), task.id);
    expect(detail.actualMinutes).toBe(120);
    expect(detail.task.estimatedMinutes).toBe(600);
    expect(detail.activity.filter((a) => a.kind === 'time_logged')).toHaveLength(2);
    expect((await uc.tasks.board(actor(ANA), project.id)).cards[0]!.actualMinutes).toBe(120);
    expect(store.events('projects.time_entry.logged')[0]!.payload).toMatchObject({ minutes: 90, projectIds: [project.id], userId: ANA });
  });

  it('horas en subtareas: el total de la tarea las suma (detalle y tablero), con desglose; borrar la subtarea las saca del total', async () => {
    const { useCases: uc } = setup();
    const { project } = await projectWithSections(uc, actor(ANA));
    const task = await uc.tasks.create(actor(ANA), { title: 'Web', projectId: project.id, assigneeUserId: ANA });
    const s1 = await uc.tasks.create(actor(ANA), { title: 'Maqueta', parentTaskId: task.id, assigneeUserId: ANA });
    const s2 = await uc.tasks.create(actor(ANA), { title: 'Textos', parentTaskId: task.id, assigneeUserId: ANA });
    await uc.time.log(actor(ANA), { taskId: task.id, workedOn: '2026-11-04', minutes: 30 });
    await uc.time.log(actor(ANA), { taskId: s1.id, workedOn: '2026-11-04', minutes: 60 });
    await uc.time.log(actor(ANA), { taskId: s1.id, workedOn: '2026-11-05', minutes: 30 });
    await uc.time.log(actor(ANA), { taskId: s2.id, workedOn: '2026-11-05', minutes: 45 });

    const detail = await uc.tasks.get(actor(ANA), task.id);
    expect(detail).toMatchObject({ actualMinutes: 165, ownMinutes: 30, subtasksMinutes: 135 });
    expect(detail.subtaskMinutes.get(s1.id)).toBe(90);
    expect(detail.subtaskMinutes.get(s2.id)).toBe(45);
    expect(detail.timeEntries.map((e) => e.taskId).sort()).toEqual([task.id, s1.id, s1.id, s2.id].sort());
    expect((await uc.tasks.board(actor(ANA), project.id)).cards.find((c) => c.task.id === task.id)!.actualMinutes).toBe(165);
    // La subtarea, por su cuenta, solo cuenta lo suyo.
    expect((await uc.tasks.get(actor(ANA), s1.id)).actualMinutes).toBe(90);

    await uc.tasks.delete(actor(ANA), s2.id);
    expect((await uc.tasks.board(actor(ANA), project.id)).cards.find((c) => c.task.id === task.id)!.actualMinutes).toBe(120);
    expect((await uc.tasks.get(actor(ANA), task.id)).actualMinutes).toBe(120);
  });

  it('quien no puede completar la tarea no registra horas; un registro fuera de rango o en otro proyecto es 422', async () => {
    const { useCases: uc } = setup();
    const { project } = await projectWithSections(uc, actor(ANA));
    const { project: other } = await projectWithSections(uc, actor(ANA));
    const task = await uc.tasks.create(actor(ANA), { title: 'T', projectId: project.id });
    await expect(uc.time.log(actor(BETO), { taskId: task.id, workedOn: '2026-11-04', minutes: 30 })).rejects.toBeInstanceOf(ProjectRoleError);
    await expect(uc.time.log(actor(ANA), { taskId: task.id, workedOn: '2026-11-04', minutes: 24 * 60 + 1 })).rejects.toBeInstanceOf(ValidationError);
    await expect(uc.time.log(actor(ANA), { taskId: task.id, workedOn: '2026-11-04', minutes: 30, projectId: other.id })).rejects.toBeInstanceOf(ValidationError);
  });

  it('solo quien lo hizo (o un administrador de proyectos) cambia o borra un registro; para los demás no existe', async () => {
    const { useCases: uc, store } = setup();
    const { project } = await projectWithSections(uc, actor(ANA));
    const task = await uc.tasks.create(actor(ANA), { title: 'T', projectId: project.id });
    const entry = await uc.time.log(actor(ANA), { taskId: task.id, workedOn: '2026-11-04', minutes: 60 });
    await expect(uc.time.update(actor(BETO), entry.id, { minutes: 1 })).rejects.toBeInstanceOf(TimeEntryNotFoundError);
    expect((await uc.time.update(actor(ANA), entry.id, { minutes: 45, billable: false })).minutes).toBe(45);
    expect(store.events('projects.time_entry.updated')[0]!.payload).toMatchObject({ changes: ['minutes', 'billable'] });
    await uc.time.remove(orgAdmin(CARLA), entry.id);
    expect((await uc.tasks.get(actor(ANA), task.id)).actualMinutes).toBe(0);
    expect(store.events('projects.time_entry.deleted')).toHaveLength(1);
  });
});

describe('reporte de horas', () => {
  it('cada quien ve las suyas; con time_entry:read_all, las de todos, con filtros y totales', async () => {
    const { useCases: uc } = setup();
    const { project } = await projectWithSections(uc, actor(ANA));
    const a = await uc.tasks.create(actor(ANA), { title: 'A', projectId: project.id, assigneeUserId: BETO });
    await uc.time.log(actor(ANA), { taskId: a.id, workedOn: '2026-11-03', minutes: 60 });
    await uc.time.log(actor(BETO), { taskId: a.id, workedOn: '2026-11-04', minutes: 30, billable: false });
    await uc.time.log(actor(BETO), { taskId: a.id, workedOn: '2026-10-30', minutes: 15 });

    const mine = await uc.time.report(actor(BETO), {});
    expect(mine.items.map((r) => r.entry.minutes)).toEqual([30, 15]);
    expect(mine.canReadAll).toBe(false);
    await expect(uc.time.report(actor(BETO), { userId: ANA })).rejects.toBeInstanceOf(ForbiddenError);

    const all = await uc.time.report(readAll(CARLA), { from: '2026-11-01', to: '2026-11-30' });
    expect(all.totalMinutes).toBe(90);
    expect(all.billableMinutes).toBe(60);
    expect(all.items[0]).toMatchObject({ taskTitle: 'A', projectName: project.name, canEdit: false });
    expect((await uc.time.report(readAll(CARLA), { billable: false })).items).toHaveLength(1);
  });
});

describe('cronómetro', () => {
  it('uno por persona: arrancar otro detiene el anterior y registra sus minutos; detener registra; sin cronómetro es 409', async () => {
    const { useCases: uc, advance, store } = setup();
    const { project } = await projectWithSections(uc, actor(ANA));
    const a = await uc.tasks.create(actor(ANA), { title: 'A', projectId: project.id });
    const b = await uc.tasks.create(actor(ANA), { title: 'B', projectId: project.id });

    await uc.time.startTimer(actor(ANA), a.id);
    advance(10 * 60_000);
    // Doble clic sobre la misma tarea: no reinicia ni registra nada.
    expect((await uc.time.startTimer(actor(ANA), a.id)).stopped).toBeNull();
    advance(20 * 60_000);
    const { stopped, timer } = await uc.time.startTimer(actor(ANA), b.id, { previousWorkedOn: '2026-11-04' });
    expect(stopped).toMatchObject({ taskId: a.id, minutes: 30, source: 'timer', workedOn: '2026-11-04' });
    expect(timer.taskTitle).toBe('B');
    expect((await uc.time.currentTimer(actor(ANA)))!.timer.taskId).toBe(b.id);

    advance(45 * 60_000);
    expect((await uc.time.stopTimer(actor(ANA), { workedOn: '2026-11-04' })).minutes).toBe(45);
    expect(await uc.time.currentTimer(actor(ANA))).toBeNull();
    await expect(uc.time.stopTimer(actor(ANA))).rejects.toBeInstanceOf(TimerNotRunningError);
    expect(store.events('projects.time_entry.logged')).toHaveLength(2);
  });

  it('un cronómetro olvidado registra como mucho 24 h; descartarlo no registra nada', async () => {
    const { useCases: uc, advance } = setup();
    const { project } = await projectWithSections(uc, actor(ANA));
    const a = await uc.tasks.create(actor(ANA), { title: 'A', projectId: project.id });
    await uc.time.startTimer(actor(ANA), a.id);
    advance(60 * 3_600_000);
    expect((await uc.time.stopTimer(actor(ANA))).minutes).toBe(24 * 60);
    await uc.time.startTimer(actor(ANA), a.id);
    await uc.time.discardTimer(actor(ANA));
    expect((await uc.tasks.get(actor(ANA), a.id)).timeEntries).toHaveLength(1);
  });
});

describe('carga de trabajo', () => {
  it('reparte la estimación por semana y persona, contra su capacidad; no cuenta lo que quien mira no ve', async () => {
    const { useCases: uc } = setup();
    const { project } = await projectWithSections(uc, actor(ANA));
    const { project: secret } = await projectWithSections(uc, actor(ANA), 'members');
    await uc.tasks.create(actor(ANA), { title: 'Informe', projectId: project.id, assigneeUserId: BETO, startOn: '2026-11-05', dueOn: '2026-11-10', estimatedMinutes: 960 });
    await uc.tasks.create(actor(ANA), { title: 'Llamada', projectId: project.id, assigneeUserId: BETO, dueOn: '2026-11-12' });
    await uc.tasks.create(actor(ANA), { title: 'Secreto', projectId: secret.id, assigneeUserId: ANA, dueOn: '2026-11-04', estimatedMinutes: 120 });
    const done = await uc.tasks.create(actor(ANA), { title: 'Hecha', projectId: project.id, assigneeUserId: BETO, dueOn: '2026-11-04', estimatedMinutes: 600 });
    await uc.tasks.complete(actor(ANA), done.id);

    const w = await uc.workload.workload(actor(BETO), { from: '2026-11-04', weeks: 2 });
    expect(w.weekStarts).toEqual(['2026-11-02', '2026-11-09']);
    expect(w.people.map((p) => p.userId)).toEqual([BETO]);
    const beto = w.people[0]!;
    expect(beto.weeklyMinutes).toBe(2400);
    expect(beto.weeks).toEqual([
      { weekStart: '2026-11-02', minutes: 480, taskCount: 1 },
      { weekStart: '2026-11-09', minutes: 480, taskCount: 2 },
    ]);
    // Ana sí ve la tarea del proyecto privado.
    expect((await uc.workload.workload(actor(ANA), { from: '2026-11-04', weeks: 1 })).people.map((p) => p.userId).sort()).toEqual([ANA, BETO].sort());
    // Filtrado por proyecto.
    expect((await uc.workload.workload(actor(ANA), { from: '2026-11-04', weeks: 2, projectId: secret.id })).people.map((p) => p.userId)).toEqual([ANA]);
    await expect(uc.workload.workload(actor(ANA), { from: '2026-11-04', weeks: 13 })).rejects.toBeInstanceOf(ValidationError);
  });

  it('la capacidad la cambia un administrador de proyectos y se usa en la carga', async () => {
    const { useCases: uc, store } = setup();
    const { project } = await projectWithSections(uc, actor(ANA));
    await uc.tasks.create(actor(ANA), { title: 'X', projectId: project.id, assigneeUserId: BETO, dueOn: '2026-11-05', estimatedMinutes: 60 });
    await expect(uc.workload.setCapacity(actor(ANA), BETO, 1200)).rejects.toBeInstanceOf(ForbiddenError);
    await uc.workload.setCapacity(orgAdmin(ANA), BETO, 1200);
    await uc.workload.setCapacity(orgAdmin(ANA), BETO, 1500);
    const w = await uc.workload.workload(actor(ANA), { from: '2026-11-02', weeks: 1 });
    expect(w.people[0]!.weeklyMinutes).toBe(1500);
    expect(w.capacities).toEqual({ [BETO]: 1500 });
    expect(store.events('projects.capacity.updated').at(-1)!.payload).toMatchObject({ weeklyMinutes: 1500, previousWeeklyMinutes: 1200 });
  });
});

describe('tiempo estimado en la tarea', () => {
  it('se cambia con la versión, queda en el historial y se copia al duplicar', async () => {
    const { useCases: uc } = setup();
    const { project } = await projectWithSections(uc, actor(ANA));
    const t = await uc.tasks.create(actor(ANA), { title: 'T', projectId: project.id });
    const updated = await uc.tasks.update(actor(ANA), t.id, { version: t.version, estimatedMinutes: 150 });
    expect(updated.estimatedMinutes).toBe(150);
    expect((await uc.tasks.get(actor(ANA), t.id)).activity.some((a) => a.kind === 'estimate_changed')).toBe(true);
    const copy = await uc.workspace.duplicate(actor(ANA), project.id, {});
    expect((await uc.tasks.board(actor(ANA), copy.id)).cards[0]!.task.estimatedMinutes).toBe(150);
  });
});
