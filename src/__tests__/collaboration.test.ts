import { describe, expect, it } from 'vitest';
import { ProjectRoleError, TaskNotFoundError, ValidationError } from '../domain/errors.js';
import { ANA, BETO, CARLA, actor, projectWithSections, setup } from './helpers.js';

const mention = (id: string, label: string) => ({ type: 'mention', attrs: { id, label } });
const comment = (...content: unknown[]) => ({ type: 'doc', content: [{ type: 'paragraph', content }] });
const text = (t: string) => ({ type: 'text', text: t });

describe('comentarios y menciones', () => {
  it('mencionar a alguien le avisa (projects.task.mentioned), lo hace seguidor y le comparte una tarea de un proyecto privado', async () => {
    const { useCases: uc, store } = setup();
    const { project } = await projectWithSections(uc, actor(ANA), 'members');
    const task = await uc.tasks.create(actor(ANA), { title: 'Contrato', projectId: project.id });

    await uc.collaboration.addComment(actor(ANA), task.id, comment(text('¿Lo revisas, '), mention(BETO, 'Beto'), text('?')));

    expect(store.events('projects.task.mentioned')).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ userIds: [BETO], where: 'comment', excerpt: '¿Lo revisas, @Beto?' }) }),
    ]);
    // Beto no es miembro del proyecto privado, pero ahora sigue la tarea: la ve y la comenta, no la edita.
    const detail = await uc.tasks.get(actor(BETO), task.id);
    expect(detail.followers).toContain(BETO);
    expect(detail.canComment).toBe(true);
    expect(detail.canEdit).toBe(false);
    expect(detail.projects).toEqual([]);
  });

  it('el aviso de comentario va a los seguidores que no fueron mencionados ni son el autor', async () => {
    const { useCases: uc, store } = setup();
    const { project } = await projectWithSections(uc, actor(ANA));
    const task = await uc.tasks.create(actor(ANA), { title: 'T', projectId: project.id, assigneeUserId: CARLA });
    await uc.collaboration.addFollower(actor(BETO), task.id, BETO);

    await uc.collaboration.addComment(actor(BETO), task.id, comment(text('Listo, '), mention(CARLA, 'Carla')));
    const created = store.events('projects.comment.created').at(-1)!;
    // Ana (autora de la tarea) sí; Carla no (ya la avisa la mención); Beto no (escribió el comentario).
    expect(created.payload.userIds).toEqual([ANA]);
  });

  it('editar un comentario solo avisa a las menciones NUEVAS; solo su autor lo edita', async () => {
    const { useCases: uc, store } = setup();
    const { project } = await projectWithSections(uc, actor(ANA));
    const task = await uc.tasks.create(actor(ANA), { title: 'T', projectId: project.id });
    const c = await uc.collaboration.addComment(actor(ANA), task.id, comment(mention(BETO, 'Beto')));
    await uc.collaboration.editComment(actor(ANA), c.id, comment(mention(BETO, 'Beto'), text(' y '), mention(CARLA, 'Carla')));

    expect(store.events('projects.task.mentioned').map((e) => e.payload.userIds)).toEqual([[BETO], [CARLA]]);
    await expect(uc.collaboration.editComment(actor(BETO), c.id, comment(text('x')))).rejects.toBeInstanceOf(ProjectRoleError);
  });

  it('un comentario borrado deja su hueco sin el texto; borrar el de otro es del administrador del proyecto', async () => {
    const { useCases: uc } = setup();
    const { project } = await projectWithSections(uc, actor(ANA));
    await uc.members.add(actor(ANA), project.id, { userId: BETO, role: 'editor' });
    const task = await uc.tasks.create(actor(ANA), { title: 'T', projectId: project.id });
    const c = await uc.collaboration.addComment(actor(BETO), task.id, comment(text('secreto')));

    await expect(uc.collaboration.deleteComment(actor(CARLA), c.id)).rejects.toThrow();
    await uc.collaboration.deleteComment(actor(ANA), c.id);
    const [shown] = (await uc.tasks.get(actor(ANA), task.id)).comments;
    expect(shown!.comment.deletedAt).not.toBeNull();
    expect(shown!.comment.bodyText).toBe('');
  });

  it('un lector (viewer) ve la tarea pero no comenta', async () => {
    const { useCases: uc } = setup();
    const { project } = await projectWithSections(uc, actor(ANA), 'members');
    await uc.members.add(actor(ANA), project.id, { userId: BETO, role: 'viewer' });
    const task = await uc.tasks.create(actor(ANA), { title: 'T', projectId: project.id });
    await expect(uc.collaboration.addComment(actor(BETO), task.id, comment(text('hola')))).rejects.toBeInstanceOf(ProjectRoleError);
  });

  it('un comentario vacío o con HTML colado es 422', async () => {
    const { useCases: uc } = setup();
    const task = await uc.tasks.create(actor(ANA), { title: 'T' });
    await expect(uc.collaboration.addComment(actor(ANA), task.id, { type: 'doc', content: [] })).rejects.toBeInstanceOf(ValidationError);
    await expect(uc.collaboration.addComment(actor(ANA), task.id, { type: 'doc', content: [{ type: 'html', text: '<b>' }] })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('seguidores, «me gusta» y adjuntos', () => {
  it('quien crea la tarea y su responsable la siguen solos; seguir es idempotente', async () => {
    const { useCases: uc, store } = setup();
    const task = await uc.tasks.create(actor(ANA), { title: 'T', assigneeUserId: BETO });
    expect((await uc.tasks.get(actor(ANA), task.id)).followers.sort()).toEqual([ANA, BETO].sort());
    await uc.collaboration.addFollower(actor(ANA), task.id, ANA);
    expect(store.events('projects.follower.added')).toHaveLength(0);
  });

  it('dejar de seguir una tarea de un proyecto privado quita el acceso que daba', async () => {
    const { useCases: uc } = setup();
    const { project } = await projectWithSections(uc, actor(ANA), 'members');
    const task = await uc.tasks.create(actor(ANA), { title: 'T', projectId: project.id });
    await uc.collaboration.addFollower(actor(ANA), task.id, BETO);
    expect((await uc.tasks.get(actor(BETO), task.id)).task.id).toBe(task.id);
    await uc.collaboration.removeFollower(actor(BETO), task.id, BETO);
    await expect(uc.tasks.get(actor(BETO), task.id)).rejects.toBeInstanceOf(TaskNotFoundError);
  });

  it('«me gusta» en tareas y comentarios: uno por persona', async () => {
    const { useCases: uc } = setup();
    const task = await uc.tasks.create(actor(ANA), { title: 'T' });
    expect(await uc.collaboration.setLike(actor(ANA), 'task', task.id, true)).toEqual([ANA]);
    expect(await uc.collaboration.setLike(actor(ANA), 'task', task.id, true)).toEqual([ANA]);
    const c = await uc.collaboration.addComment(actor(ANA), task.id, comment(text('bien')));
    await uc.collaboration.setLike(actor(ANA), 'comment', c.id, true);
    const detail = await uc.tasks.get(actor(ANA), task.id);
    expect(detail.likedBy).toEqual([ANA]);
    expect(detail.comments[0]!.likedBy).toEqual([ANA]);
    expect(await uc.collaboration.setLike(actor(ANA), 'task', task.id, false)).toEqual([]);
  });

  it('adjuntar deja la línea en el historial y el evento; lo quita quien lo subió o quien edita la tarea', async () => {
    const { useCases: uc, store } = setup();
    const { project } = await projectWithSections(uc, actor(ANA));
    await uc.members.add(actor(ANA), project.id, { userId: BETO, role: 'commenter' });
    const task = await uc.tasks.create(actor(ANA), { title: 'T', projectId: project.id });
    const file = { documentId: '99999999-9999-4999-8999-999999999999', fileName: 'plano.pdf', mimeType: 'application/pdf', sizeBytes: 1200 };
    const a = await uc.collaboration.addAttachment(actor(BETO), task.id, file);
    const b = await uc.collaboration.addAttachment(actor(ANA), task.id, file);

    await expect(uc.collaboration.removeAttachment(actor(BETO), b.id)).rejects.toBeInstanceOf(ProjectRoleError);
    await uc.collaboration.removeAttachment(actor(BETO), a.id);
    const detail = await uc.tasks.get(actor(ANA), task.id);
    expect(detail.attachments.map((x) => x.id)).toEqual([b.id]);
    expect(detail.activity.map((x) => x.kind)).toEqual(['created', 'attachment_added', 'attachment_added', 'attachment_removed']);
    expect(store.events('projects.attachment.added')).toHaveLength(2);
  });
});

describe('historial, aprobaciones y descripción enriquecida', () => {
  it('cada cambio deja su línea en el historial, con antes y después', async () => {
    const { useCases: uc } = setup();
    const { project, sections } = await projectWithSections(uc, actor(ANA));
    const t = await uc.tasks.create(actor(ANA), { title: 'T', projectId: project.id });
    const v2 = await uc.tasks.update(actor(ANA), t.id, { version: t.version, dueOn: '2026-11-10', assigneeUserId: BETO });
    await uc.tasks.move(actor(ANA), t.id, { projectId: project.id, sectionId: sections[1]!.id, version: v2.version });
    await uc.tasks.complete(actor(ANA), t.id);

    const activity = (await uc.tasks.get(actor(ANA), t.id)).activity;
    expect(activity.map((a) => a.kind)).toEqual(['created', 'due_changed', 'assigned', 'moved', 'completed']);
    expect(activity[1]!.data).toEqual({ from: null, to: '2026-11-10' });
    expect(activity[3]!.data).toMatchObject({ from: 'Por hacer', to: 'En curso' });
  });

  it('aprobación: avisa al responsable, solo él decide; aprobar la cierra y pedir cambios la deja abierta', async () => {
    const { useCases: uc, store } = setup();
    const { project } = await projectWithSections(uc, actor(ANA));
    const t = await uc.tasks.create(actor(ANA), { title: 'Aprobar presupuesto', projectId: project.id, kind: 'approval', assigneeUserId: BETO });
    expect(t.approvalStatus).toBe('pending');
    expect(store.events('projects.approval.requested')[0]!.payload.userIds).toEqual([BETO]);

    await expect(uc.tasks.decide(actor(ANA), t.id, 'approved')).rejects.toBeInstanceOf(ProjectRoleError);
    const changes = await uc.tasks.decide(actor(BETO), t.id, 'changes_requested');
    expect(changes.completedAt).toBeNull();
    const approved = await uc.tasks.decide(actor(BETO), t.id, 'approved');
    expect(approved.completedAt).not.toBeNull();
    expect(store.events('projects.approval.decided').map((e) => e.payload.decision)).toEqual(['changes_requested', 'approved']);
    expect(store.events('projects.approval.decided')[1]!.payload.userIds).toEqual([ANA]);
  });

  it('convertir una tarea asignada en aprobación la deja pendiente y se la pide a su responsable', async () => {
    const { useCases: uc, store } = setup();
    const t = await uc.tasks.create(actor(ANA), { title: 'Presupuesto', assigneeUserId: BETO });
    const v2 = await uc.tasks.update(actor(ANA), t.id, { version: t.version, kind: 'approval' });
    expect(v2.approvalStatus).toBe('pending');
    expect(store.events('projects.approval.requested')[0]!.payload.userIds).toEqual([BETO]);
    const v3 = await uc.tasks.update(actor(ANA), t.id, { version: v2.version, kind: 'task' });
    expect(v3.approvalStatus).toBeNull();
  });

  it('una tarea normal no se «aprueba»', async () => {
    const { useCases: uc } = setup();
    const t = await uc.tasks.create(actor(ANA), { title: 'T', assigneeUserId: ANA });
    await expect(uc.tasks.decide(actor(ANA), t.id, 'approved')).rejects.toBeInstanceOf(ValidationError);
  });

  it('la descripción enriquecida guarda el documento, su texto, y avisa a quien se menciona en ella', async () => {
    const { useCases: uc, store } = setup();
    const t = await uc.tasks.create(actor(ANA), { title: 'T' });
    const v2 = await uc.tasks.update(actor(ANA), t.id, { version: t.version, descriptionDoc: comment(text('Pide a '), mention(CARLA, 'Carla'), text(' el logo')) });
    expect(v2.description).toBe('Pide a @Carla el logo');
    expect(store.events('projects.task.mentioned')[0]!.payload).toMatchObject({ where: 'description', userIds: [CARLA] });
    // Guardar otra vez lo mismo no vuelve a avisar.
    await uc.tasks.update(actor(ANA), t.id, { version: v2.version, descriptionDoc: comment(text('Pide a '), mention(CARLA, 'Carla'), text(' el logo ya')) });
    expect(store.events('projects.task.mentioned')).toHaveLength(1);
  });

  it('completar avisa a seguidores y autor, no a quien la completó; asignarse uno mismo no avisa', async () => {
    const { useCases: uc, store } = setup();
    const t = await uc.tasks.create(actor(ANA), { title: 'T', assigneeUserId: BETO });
    await uc.tasks.complete(actor(BETO), t.id);
    expect(store.events('projects.task.completed')[0]!.payload.userIds).toEqual([ANA]);
    const mine = await uc.tasks.create(actor(ANA), { title: 'Mía', assigneeUserId: ANA });
    expect(store.events('projects.task.assigned').find((e) => e.payload.taskId === mine.id)!.payload.userIds).toEqual([]);
  });
});

describe('vence pronto', () => {
  it('a partir de las 08:00 locales avisa una sola vez por tarea y día (hoy y mañana), aunque corra dos veces', async () => {
    const { useCases: uc, store, setNow, dueSoon } = setup();
    // 07:30 en Guayaquil (12:30 UTC): todavía no.
    setNow('2026-11-04T12:30:00Z');
    await uc.tasks.create(actor(ANA), { title: 'Hoy', assigneeUserId: BETO, dueOn: '2026-11-04' });
    await uc.tasks.create(actor(ANA), { title: 'Mañana', assigneeUserId: BETO, dueOn: '2026-11-05' });
    await uc.tasks.create(actor(ANA), { title: 'Lejos', assigneeUserId: BETO, dueOn: '2026-11-20' });
    await uc.tasks.create(actor(ANA), { title: 'Sin responsable', dueOn: '2026-11-04' });
    expect((await dueSoon.run()).sent).toBe(0);

    setNow('2026-11-04T13:30:00Z');
    expect((await dueSoon.run()).sent).toBe(2);
    expect((await dueSoon.run()).sent).toBe(0);
    const sent = store.events('projects.task.due_soon');
    expect(sent.map((e) => [e.payload.title, e.payload.when, e.payload.userIds])).toEqual([
      ['Hoy', 'today', [BETO]],
      ['Mañana', 'tomorrow', [BETO]],
    ]);
  });

  it('a las 23:00 en Ecuador sigue siendo «hoy» aunque en UTC ya sea mañana', async () => {
    const { useCases: uc, store, setNow, dueSoon } = setup();
    setNow('2026-11-05T04:00:00Z');
    await uc.tasks.create(actor(ANA), { title: 'Hoy', assigneeUserId: BETO, dueOn: '2026-11-04' });
    await dueSoon.run();
    expect(store.events('projects.task.due_soon')[0]!.payload.when).toBe('today');
  });
});
