import { describe, expect, it } from 'vitest';
import { ANA, BETO, CARLA, actor, projectWithSections, setup } from './helpers.js';

/** Lo que muestra cada tarjeta de la lista de proyectos: avance, vencidas, próxima entrega y caras. */
describe('resumen de cada proyecto en la lista', () => {
  it('cuenta las tareas de primer nivel: terminadas, vencidas y la próxima entrega; sin subtareas ni borradas', async () => {
    const { useCases: uc, setNow } = setup();
    setNow('2026-11-04T15:00:00Z'); // 10:00 en Guayaquil
    const { project } = await projectWithSections(uc, actor(ANA));
    const done = await uc.tasks.create(actor(ANA), { title: 'Hecha', projectId: project.id, dueOn: '2026-11-01' });
    await uc.tasks.complete(actor(ANA), done.id);
    await uc.tasks.create(actor(ANA), { title: 'Vencida', projectId: project.id, dueOn: '2026-11-03' });
    await uc.tasks.create(actor(ANA), { title: 'Hoy', projectId: project.id, dueOn: '2026-11-04' });
    const later = await uc.tasks.create(actor(ANA), { title: 'Después', projectId: project.id, dueOn: '2026-11-20' });
    await uc.tasks.create(actor(ANA), { title: 'Subtarea vencida', parentTaskId: later.id, dueOn: '2026-10-01' });
    const gone = await uc.tasks.create(actor(ANA), { title: 'Borrada', projectId: project.id, dueOn: '2026-10-01' });
    await uc.tasks.delete(actor(ANA), gone.id);

    const [item] = await uc.projects.list(actor(ANA));

    expect(item!.summary).toMatchObject({ total: 4, completed: 1, overdue: 1, nextDueOn: '2026-11-04' });
  });

  it('«vencida» se decide con la fecha de Ecuador, no con la de UTC', async () => {
    const { useCases: uc, setNow } = setup();
    const { project } = await projectWithSections(uc, actor(ANA));
    await uc.tasks.create(actor(ANA), { title: 'Para el 4', projectId: project.id, dueOn: '2026-11-04' });

    // 21:00 del 4 en Guayaquil = 02:00 del 5 en UTC: la tarea todavía es de hoy.
    setNow('2026-11-05T02:00:00Z');
    const [item] = await uc.projects.list(actor(ANA));
    expect(item!.summary).toMatchObject({ overdue: 0, nextDueOn: '2026-11-04' });
    expect((await uc.dashboard.dashboard(actor(ANA), project.id)).totals.overdue).toBe(0);
  });

  it('un proyecto sin tareas sale en cero, y las caras van con los administradores primero', async () => {
    const { useCases: uc } = setup();
    const { project } = await projectWithSections(uc, actor(ANA));
    await uc.members.add(actor(ANA), project.id, { userId: BETO, role: 'editor' });
    await uc.members.add(actor(ANA), project.id, { userId: CARLA, role: 'admin' });

    const [item] = await uc.projects.list(actor(BETO));

    expect(item!.summary).toEqual({ total: 0, completed: 0, overdue: 0, nextDueOn: null, memberCount: 3, memberUserIds: [ANA, CARLA, BETO] });
  });
});
