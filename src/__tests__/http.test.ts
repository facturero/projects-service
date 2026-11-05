import { describe, expect, it } from 'vitest';
import { ANA, BETO, ORG, setup } from './helpers.js';

/** Por HTTP, con las cabeceras que inyecta el gateway: lo que el frontend ve de verdad. */
function client(app: ReturnType<typeof setup>['app']) {
  return async (method: string, path: string, opts: { user?: string; perms?: string; body?: unknown } = {}) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-Organization-Id': ORG };
    if (opts.user !== undefined) headers['X-User-Id'] = opts.user;
    headers['X-Permissions'] = opts.perms ?? 'project:read,project:create';
    const res = await app.fetch(
      new Request(`http://localhost${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }),
    );
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
}

describe('API de proyectos', () => {
  it('flujo completo: crear proyecto, tarea, moverla, completarla y verla en Mis tareas', async () => {
    const { app } = setup();
    const call = client(app);

    const created = await call('POST', '/projects', {
      user: ANA,
      body: { name: 'Web nueva', visibility: 'organization', defaultView: 'board', color: 'success', sectionNames: ['Por hacer', 'Hecho'] },
    });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ name: 'Web nueva', myRole: 'admin', color: 'success', members: [{ userId: ANA, role: 'admin' }] });
    const projectId = created.json.id as string;

    const board = await call('GET', `/projects/${projectId}/tasks`, { user: ANA });
    const [todo, done] = board.json.sections;

    const task = await call('POST', '/projects/tasks', { user: ANA, body: { title: 'Maqueta', projectId, assigneeUserId: ANA, dueOn: '2026-11-06' } });
    expect(task.status).toBe(201);

    const moved = await call('POST', `/projects/tasks/${task.json.id}/move`, { user: ANA, body: { projectId, sectionId: done.id, version: task.json.version } });
    expect(moved.status).toBe(200);
    expect(moved.json.placement.sectionId).toBe(done.id);

    const stale = await call('POST', `/projects/tasks/${task.json.id}/move`, { user: ANA, body: { projectId, sectionId: todo.id, version: task.json.version } });
    expect(stale.status).toBe(409);
    expect(stale.json).toMatchObject({ code: 'VERSION_CONFLICT', currentVersion: moved.json.version });

    const mine = await call('GET', '/projects/my-tasks', { user: ANA });
    expect(mine.json.items).toEqual([expect.objectContaining({ title: 'Maqueta', dueOn: '2026-11-06', projects: [{ projectId, name: 'Web nueva', color: 'success' }] })]);

    expect((await call('POST', `/projects/tasks/${task.json.id}/complete`, { user: ANA })).json.completedAt).not.toBeNull();
    expect((await call('GET', '/projects/my-tasks', { user: ANA })).json.items).toEqual([]);
  });

  it('sin `project:read` (o sin módulo: el gateway ni deja pasar) es 403', async () => {
    const { app } = setup();
    const res = await client(app)('GET', '/projects', { user: ANA, perms: 'customer:read' });
    expect(res.status).toBe(403);
  });

  it('sin usuario es 401', async () => {
    const { app } = setup();
    expect((await client(app)('GET', '/projects')).status).toBe(401);
  });

  it('un id que no es uuid es 404 sin tocar la base, y `my-tasks` no se confunde con un id de proyecto', async () => {
    const { app } = setup();
    const call = client(app);
    expect((await call('GET', '/projects/no-es-un-id', { user: ANA })).status).toBe(404);
    expect((await call('GET', '/projects/my-tasks', { user: ANA })).status).toBe(200);
  });

  it('los errores de validación salen como 422 con el detalle por campo', async () => {
    const { app } = setup();
    const res = await client(app)('POST', '/projects', { user: ANA, body: { name: '', visibility: 'todos', sectionNames: [] } });
    expect(res.status).toBe(422);
    expect(res.json.details.map((d: { field: string }) => d.field).sort()).toEqual(['name', 'sectionNames', 'visibility']);
  });

  it('un proyecto privado ajeno es 404 por la API (no revela que existe)', async () => {
    const { app } = setup();
    const call = client(app);
    const created = await call('POST', '/projects', { user: ANA, body: { name: 'Privado', visibility: 'members', sectionNames: ['A'] } });
    expect((await call('GET', `/projects/${created.json.id}`, { user: BETO })).status).toBe(404);
    expect((await call('GET', '/projects', { user: BETO })).json.items).toEqual([]);
  });
});
