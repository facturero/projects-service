#!/usr/bin/env node
/**
 * Verificación contra el servicio REAL con MySQL (no la copia en memoria de las pruebas): lo que solo una base de verdad puede
 * demostrar. Habla con projects-service directamente, con las cabeceras que inyectaría el gateway.
 *
 *     PROJECTS_URL=http://localhost:3020 node scripts/verify-projects.mjs
 *
 * Opcional: MYSQL_CONTAINER (por defecto `cmr-mysql`) para revisar el outbox y la colación de los rangos con `docker exec`.
 *
 * Comprueba:
 *   1. 20 movimientos SIMULTÁNEOS de la misma tarjeta con la misma versión → exactamente 1 gana y 19 reciben 409 (FOR UPDATE + versión).
 *   2. 30 tareas creadas a la vez en la misma columna → las 30 existen y el tablero las devuelve todas.
 *   3. Proyecto privado: otro usuario recibe 404 y no lo ve en su lista; el responsable de una tarea sí la abre.
 *   4. Borrar una sección con tareas las mueve (la FOREIGN KEY RESTRICT de MySQL no salta) y conserva el orden.
 *   5. 60 inserciones seguidas al principio → los rangos se reequilibran y nunca pasan de 32 caracteres.
 *   6. Cada escritura dejó su evento en `outbox_messages`, con `organizationId`, y los rangos son `ascii_bin`.
 *   7-8. Colaboración y cronograma (entregables 2 y 3).
 *   9. Entregable 4, en OTRA organización (para no alterar los conteos de la 6): vínculos, etiquetas y valores de campo repetidos a
 *      la vez dejan una sola fila (índices únicos + INSERT IGNORE / clave primaria); quitar una opción borra sus valores; plantilla,
 *      duplicado, búsqueda (con `%` y `_` literales) y edición en lote contra MySQL.
 *   10. Entregable 5, también en su organización: arrancar y detener el cronómetro a la vez (uno solo registra), SUM() de horas,
 *       reporte y su permiso, capacidad escrita a la vez (una fila) y carga de trabajo por semana.
 *   11. Entregable 6: 10 «facturar» a la vez (una sola reserva), horas reservadas bloqueadas y, si hay RabbitMQ (RABBITMQ_URL, por
 *       defecto amqp://localhost:5672), el consumidor de verdad: billing.invoice.issued (dos veces el mismo) y billing.invoice.voided.
 *   12. Entregable 7: una regla corre sobre 12 tareas movidas a la vez (contador atómico), 15 solicitudes por formulario a la vez de
 *       alguien que no es miembro, y el panel.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const BASE = (process.env.PROJECTS_URL ?? 'http://localhost:3020').replace(/\/+$/, '');
const MYSQL = process.env.MYSQL_CONTAINER ?? 'cmr-mysql';
const ORG = randomUUID();
const ANA = randomUUID();
const BETO = randomUUID();
const PERMS = 'project:read,project:create';

let failures = 0;
const ok = (msg) => console.log(`  OK   ${msg}`);
const fail = (msg) => {
  failures += 1;
  console.log(`  FAIL ${msg}`);
};
const check = (cond, msg) => (cond ? ok(msg) : fail(msg));

async function call(method, path, { user = ANA, body, perms = PERMS, org = ORG } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Organization-Id': org, 'X-User-Id': user, 'X-Permissions': perms },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

function sql(query) {
  return execFileSync('docker', ['exec', MYSQL, 'mysql', '-uroot', '-proot123', '-N', '-B', 'projects_db', '-e', query], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

console.log(`projects-service en ${BASE}, organización de prueba ${ORG}`);

const health = await fetch(`${BASE}/health`).catch(() => null);
if (!health?.ok) {
  console.error('El servicio no responde en /health.');
  process.exit(1);
}

// ── Preparación ─────────────────────────────────────────────────────────────
const created = await call('POST', '/projects', {
  body: { name: 'Verificación', visibility: 'members', sectionNames: ['Por hacer', 'En curso', 'Hecho'] },
});
check(created.status === 201, `crear proyecto privado (${created.status})`);
const projectId = created.json.id;
const board0 = await call('GET', `/projects/${projectId}/tasks`);
const [todo, doing, done] = board0.json.sections;

// ── 1. Movimientos simultáneos de la misma tarjeta ──────────────────────────
console.log('1. carrera de movimientos');
const t = await call('POST', '/projects/tasks', { body: { title: 'Disputada', projectId, sectionId: todo.id } });
const targets = [doing.id, done.id];
const race = await Promise.all(
  Array.from({ length: 20 }, (_, i) =>
    call('POST', `/projects/tasks/${t.json.id}/move`, { body: { projectId, sectionId: targets[i % 2], version: t.json.version } }),
  ),
);
const won = race.filter((r) => r.status === 200).length;
const conflicts = race.filter((r) => r.status === 409 && r.json.code === 'VERSION_CONFLICT').length;
check(won === 1 && conflicts === 19, `20 movimientos con la misma versión → ${won} aceptado(s), ${conflicts} conflicto(s)`);
const detail = await call('GET', `/projects/tasks/${t.json.id}`);
check(detail.json.version === t.json.version + 1, `la versión subió exactamente una vez (${detail.json.version})`);

// ── 2. Creaciones simultáneas ───────────────────────────────────────────────
console.log('2. creaciones simultáneas');
const many = await Promise.all(
  Array.from({ length: 30 }, (_, i) => call('POST', '/projects/tasks', { body: { title: `Paralela ${i}`, projectId, sectionId: todo.id } })),
);
check(many.every((r) => r.status === 201), `30 tareas creadas a la vez: ${many.filter((r) => r.status === 201).length}/30`);
const board1 = await call('GET', `/projects/${projectId}/tasks`);
check(board1.json.tasks.filter((x) => x.sectionId === todo.id).length === 30, 'el tablero devuelve las 30 en su columna');

// ── 3. Privacidad ───────────────────────────────────────────────────────────
console.log('3. proyecto privado');
check((await call('GET', `/projects/${projectId}`, { user: BETO })).status === 404, 'otro usuario recibe 404 al abrirlo');
check((await call('GET', '/projects', { user: BETO })).json.items.length === 0, 'y no lo ve en su lista');
const forBeto = await call('POST', '/projects/tasks', { body: { title: 'Para Beto', projectId, assigneeUserId: BETO } });
const seen = await call('GET', `/projects/tasks/${forBeto.json.id}`, { user: BETO });
check(seen.status === 200 && seen.json.projects.length === 0 && seen.json.canComplete === true, 'el responsable abre su tarea, sin ver el nombre del proyecto');
const otherOrg = await fetch(`${BASE}/projects/tasks/${forBeto.json.id}`, {
  headers: { 'X-Organization-Id': randomUUID(), 'X-User-Id': BETO, 'X-Permissions': PERMS },
});
check(otherOrg.status === 404, 'desde otra organización, la misma tarea es 404');

// ── 4. Borrar una sección con tareas ────────────────────────────────────────
console.log('4. borrar sección con tareas');
const beforeOrder = board1.json.tasks.filter((x) => x.sectionId === todo.id).map((x) => x.id);
const del409 = await call('DELETE', `/projects/${projectId}/sections/${todo.id}`);
check(del409.status === 409 && del409.json.code === 'SECTION_NOT_EMPTY', 'sin destino: 409 SECTION_NOT_EMPTY');
const del = await call('DELETE', `/projects/${projectId}/sections/${todo.id}?moveTasksTo=${done.id}`);
check(del.status === 204, `con destino: 204 (${del.status})`);
const board2 = await call('GET', `/projects/${projectId}/tasks`);
const moved = board2.json.tasks.filter((x) => x.sectionId === done.id).map((x) => x.id);
check(beforeOrder.every((id) => moved.includes(id)), 'ninguna tarea se perdió');
const relative = moved.filter((id) => beforeOrder.includes(id));
check(JSON.stringify(relative) === JSON.stringify(beforeOrder), 'y conservan su orden relativo');

// ── 5. Reequilibrio ─────────────────────────────────────────────────────────
console.log('5. reequilibrio de rangos');
let first = null;
for (let i = 0; i < 60; i++) {
  const r = await call('POST', '/projects/tasks', { body: { title: `Arriba ${i}`, projectId, sectionId: doing.id, ...(first ? { afterId: first } : {}) } });
  first = r.json.id;
}
const board3 = await call('GET', `/projects/${projectId}/tasks`);
const col = board3.json.tasks.filter((x) => x.sectionId === doing.id && x.title.startsWith('Arriba'));
check(col[0]?.title === 'Arriba 59' && col.at(-1)?.title === 'Arriba 0', 'el orden es el pedido (la última creada arriba)');
const maxLen = Math.max(...board3.json.tasks.map((x) => x.rank.length));
check(maxLen <= 32, `el rango más largo mide ${maxLen} (≤ 32)`);

// ── 7. Colaboración (entregable 2) ──────────────────────────────────────────
console.log('7. colaboración');
const collab = await call('POST', '/projects/tasks', { body: { title: 'Con hilo', projectId } });
const followRace = await Promise.all(Array.from({ length: 20 }, () => call('POST', `/projects/tasks/${collab.json.id}/followers`, { body: { userId: ANA } })));
check(followRace.every((r) => r.status === 200), '20 «seguir» simultáneos de la misma persona: ninguno falla');
const likeRace = await Promise.all(Array.from({ length: 20 }, () => call('POST', `/projects/tasks/${collab.json.id}/like`)));
check(likeRace.every((r) => r.status === 200), '20 «me gusta» simultáneos: ninguno falla');
const mentionDoc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Mira esto ' }, { type: 'mention', attrs: { id: BETO, label: 'Beto' } }] }] };
const posted = await call('POST', `/projects/tasks/${collab.json.id}/comments`, { body: { bodyDoc: mentionDoc } });
check(posted.status === 201 && posted.json.bodyText === 'Mira esto @Beto', `comentario con mención (${posted.status})`);
const sneaky = await call('POST', `/projects/tasks/${collab.json.id}/comments`, {
  body: { bodyDoc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] }] }] } },
});
check(sneaky.status === 422, `un enlace javascript: se rechaza (${sneaky.status})`);
const asBeto = await call('GET', `/projects/tasks/${collab.json.id}`, { user: BETO });
check(asBeto.status === 200 && asBeto.json.canComment === true && asBeto.json.canEdit === false, 'Beto, mencionado en un proyecto privado, ve y comenta la tarea pero no la edita');
const withDesc = await call('PATCH', `/projects/tasks/${collab.json.id}`, { body: { version: (await call('GET', `/projects/tasks/${collab.json.id}`)).json.version, descriptionDoc: mentionDoc } });
check(withDesc.status === 200 && JSON.stringify(withDesc.json.descriptionDoc) === JSON.stringify(mentionDoc), 'la descripción enriquecida vuelve de MySQL tal cual');
const approval = await call('POST', '/projects/tasks', { body: { title: 'Aprobar', projectId, kind: 'approval', assigneeUserId: BETO } });
const decided = await call('POST', `/projects/tasks/${approval.json.id}/approval`, { user: BETO, body: { decision: 'approved' } });
check(decided.status === 200 && decided.json.approvalStatus === 'approved' && decided.json.completedAt, 'Beto aprueba lo que le pidieron y la tarea queda cerrada');
try {
  const followers = sql(`SELECT COUNT(*) FROM task_followers WHERE task_id='${collab.json.id}' AND user_id='${ANA}'`);
  const likes = sql(`SELECT COUNT(*) FROM likes WHERE target_id='${collab.json.id}'`);
  check(followers === '1' && likes === '1', `una sola fila de seguidor y de «me gusta» (seguidor ${followers}, me gusta ${likes})`);
  const mentions = sql(`SELECT COUNT(*) FROM outbox_messages WHERE type='projects.task.mentioned' AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.taskId'))='${collab.json.id}'`);
  // Una por el comentario y otra por la descripción (cada sitio avisa la primera vez que menciona a alguien).
  check(mentions === '2', `menciones avisadas: comentario y descripción, una vez cada una (${mentions})`);
} catch (err) {
  fail(`no se pudo consultar MySQL: ${err.message}`);
}

// ── 8. Cronograma (entregable 3) ────────────────────────────────────────────
console.log('8. cronograma');
const ta = await call('POST', '/projects/tasks', { body: { title: 'Fase A', projectId, startOn: '2026-11-02', dueOn: '2026-11-06' } });
const tb = await call('POST', '/projects/tasks', { body: { title: 'Fase B', projectId, assigneeUserId: BETO } });
const tc = await call('POST', '/projects/tasks', { body: { title: 'Fase C', projectId } });
const depRace = await Promise.all(Array.from({ length: 15 }, () => call('POST', `/projects/tasks/${tb.json.id}/dependencies`, { body: { dependsOnTaskId: ta.json.id } })));
check(depRace.every((r) => r.status === 201), '15 veces la misma dependencia a la vez: ninguna falla');
await call('POST', `/projects/tasks/${tc.json.id}/dependencies`, { body: { dependsOnTaskId: tb.json.id } });
const cycle = await call('POST', `/projects/tasks/${ta.json.id}/dependencies`, { body: { dependsOnTaskId: tc.json.id } });
check(cycle.status === 422 && cycle.json.code === 'DEPENDENCY_CYCLE', `un ciclo A → B → C → A se rechaza (${cycle.status})`);
const boardDeps = (await call('GET', `/projects/${projectId}/tasks`)).json.dependencies;
check(boardDeps.length === 2, `el tablero trae las 2 flechas (${boardDeps.length})`);
await call('POST', `/projects/tasks/${ta.json.id}/complete`);
const posted2 = await call('POST', `/projects/${projectId}/status-updates`, { body: { status: 'at_risk' } });
const listed = (await call('GET', '/projects')).json.items.find((p) => p.id === projectId);
check(posted2.status === 201 && listed?.latestStatus?.status === 'at_risk', 'el estado publicado aparece como el último en la lista de proyectos');
try {
  const rows = sql(`SELECT COUNT(*) FROM task_dependencies WHERE task_id='${tb.json.id}'`);
  check(rows === '1', `una sola fila de dependencia (${rows})`);
  const unblocked = sql(
    `SELECT COUNT(*) FROM outbox_messages WHERE type='projects.task.unblocked' AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.taskId'))='${tb.json.id}'`,
  );
  check(unblocked === '1', `completar «Fase A» avisa a quien tiene «Fase B» que ya puede empezar (${unblocked})`);
} catch (err) {
  fail(`no se pudo consultar MySQL: ${err.message}`);
}

// ── 9. Vínculos, etiquetas, campos, plantillas, búsqueda y lote (entregable 4) ──
console.log('9. organizar (entregable 4)');
const ORG4 = randomUUID();
const c4 = (method, path, opts = {}) => call(method, path, { ...opts, org: ORG4 });
const CUSTOMER = randomUUID();
const p4 = (await c4('POST', '/projects', { body: { name: 'Org 4', visibility: 'members', sectionNames: ['Uno', 'Dos'] } })).json;
const open4 = (await c4('POST', '/projects', { body: { name: 'Abierto', visibility: 'organization', sectionNames: ['Uno'] } })).json;
const secretTask = (await c4('POST', '/projects/tasks', { body: { title: 'Contrato 100% confidencial', projectId: p4.id } })).json;
const openTask = (await c4('POST', '/projects/tasks', { body: { title: 'Contrato del hosting', projectId: open4.id } })).json;

const linkRace = await Promise.all(
  Array.from({ length: 20 }, () => c4('POST', `/projects/tasks/${secretTask.id}/links`, { body: { entityType: 'customer', entityId: CUSTOMER, label: 'Café Central' } })),
);
check(linkRace.every((r) => r.status === 201) && new Set(linkRace.map((r) => r.json.id)).size === 1, '20 vínculos iguales a la vez: todos 201 y el mismo vínculo');
await c4('POST', `/projects/tasks/${openTask.id}/links`, { body: { entityType: 'customer', entityId: CUSTOMER, label: 'Café Central' } });
const linkedAna = (await c4('GET', `/projects/linked/customer/${CUSTOMER}`)).json.items.length;
const linkedBeto = (await c4('GET', `/projects/linked/customer/${CUSTOMER}`, { user: BETO })).json.items.map((x) => x.title);
check(linkedAna === 2 && linkedBeto.length === 1 && linkedBeto[0] === 'Contrato del hosting', `la ficha del cliente: Ana ve 2, Beto solo la del proyecto abierto (${linkedBeto.join(', ')})`);

const tagRace = await Promise.all(['Urgente', 'urgente', 'URGENTE', 'Urgente', 'urgente'].flatMap((n) => [n, n]).map((name) => c4('POST', '/projects/tags', { body: { name } })));
check(tagRace.every((r) => r.status === 201) && new Set(tagRace.map((r) => r.json.id)).size === 1, '10 etiquetas «Urgente»/«urgente» a la vez: una sola etiqueta');
const tagId = tagRace[0].json.id;

const field = (await c4('POST', `/projects/${p4.id}/fields`, { body: { name: 'Prioridad', type: 'select', options: [{ label: 'Alta' }, { label: 'Baja' }] } })).json;
const [alta, baja] = field.options;
const valueRace = await Promise.all(Array.from({ length: 20 }, (_, i) => c4('PUT', `/projects/tasks/${secretTask.id}/fields/${field.id}`, { body: { value: i % 2 ? alta.id : baja.id } })));
check(valueRace.every((r) => r.status === 200), '20 valores del mismo campo a la vez: ninguno falla');
const budget = (await c4('POST', `/projects/${p4.id}/fields`, { body: { name: 'Presupuesto', type: 'number' } })).json;
const num = await c4('PUT', `/projects/tasks/${secretTask.id}/fields/${budget.id}`, { body: { value: '1500,75' } });
check(num.status === 200 && num.json.value === 1500.75, `«1500,75» se guarda como número (${JSON.stringify(num.json)})`);
await c4('PUT', `/projects/tasks/${secretTask.id}/fields/${field.id}`, { body: { value: alta.id } });
await c4('PATCH', `/projects/fields/${field.id}`, { body: { options: [{ id: baja.id, label: 'Baja' }] } });
const afterRemove = (await c4('GET', `/projects/${p4.id}/tasks`)).json.tasks.find((x) => x.id === secretTask.id);
check(afterRemove.values[field.id] === undefined && afterRemove.values[budget.id] === 1500.75, 'quitar la opción «Alta» vacía esa tarea; el presupuesto sigue');

const tpl = await c4('POST', '/projects/from-template', { body: { templateCode: 'construction_job', visibility: 'organization', startOn: '2026-12-01', locale: 'es' } });
const tplInfo = (await c4('GET', '/projects/templates?locale=es')).json.items.find((x) => x.code === 'construction_job');
const tplBoard = (await c4('GET', `/projects/${tpl.json.id}/tasks`)).json;
check(
  tpl.status === 201 && tplBoard.tasks.length === tplInfo.taskCount && tplBoard.dependencies.length > 0,
  `plantilla de obra: ${tplBoard.tasks.length}/${tplInfo.taskCount} tareas y ${tplBoard.dependencies.length} dependencias`,
);
await c4('POST', `/projects/tasks/${secretTask.id}/tags`, { body: { tagId } });
const dup = await c4('POST', `/projects/${p4.id}/duplicate`, { body: { name: 'Org 4 (copia)' } });
const dupBoard = (await c4('GET', `/projects/${dup.json.id}/tasks`)).json;
const dupTask = dupBoard.tasks.find((x) => x.title === secretTask.title);
check(
  dup.status === 201 && dupBoard.fields.length === 2 && dupTask?.tags.length === 1 && Object.values(dupTask.values).includes(1500.75),
  'duplicar copia campos, valores y etiquetas',
);

const pct = (await c4('GET', `/projects/search?q=${encodeURIComponent('0%')}`)).json.tasks.map((x) => x.title);
check(pct.length === 2 && pct.every((x) => x.includes('100% confidencial')), `buscar «0%» encuentra el «%» literal, no todo (${pct.length}: original y copia)`);
const under = (await c4('GET', `/projects/search?q=${encodeURIComponent('__')}`)).json.tasks.length;
check(under === 0, `«__» no actúa como comodín (${under})`);
const betoSearch = (await c4('GET', '/projects/search?q=contrato', { user: BETO })).json.tasks.map((x) => x.title);
check(betoSearch.length === 1 && betoSearch[0] === 'Contrato del hosting', `Beto no encuentra tareas del proyecto privado (${betoSearch.join(', ')})`);

const lot = await Promise.all(Array.from({ length: 5 }, (_, i) => c4('POST', '/projects/tasks', { body: { title: `Lote ${i}`, projectId: p4.id } })));
const bulk = await c4('POST', '/projects/tasks/bulk', { body: { taskIds: [...lot.map((r) => r.json.id), openTask.id], action: { type: 'tag', tagId } } });
const bulkOk = bulk.json.results.filter((r) => r.ok).length;
check(bulkOk === 6, `etiquetar 6 en lote: ${bulkOk} aplicadas`);
const asBetoBulk = await c4('POST', '/projects/tasks/bulk', { user: BETO, body: { taskIds: lot.map((r) => r.json.id), action: { type: 'complete' } } });
check(asBetoBulk.json.results.every((r) => !r.ok), `Beto no completa en lote tareas de un proyecto privado que no ve (${asBetoBulk.json.results[0]?.code})`);
try {
  const links = sql(`SELECT COUNT(*) FROM task_links WHERE task_id='${secretTask.id}'`);
  const tags = sql(`SELECT COUNT(*) FROM tags WHERE organization_id='${ORG4}'`);
  const values = sql(`SELECT COUNT(*) FROM custom_field_values WHERE task_id='${secretTask.id}' AND field_id='${field.id}'`);
  check(links === '1' && tags === '1' && values === '0', `filas: vínculos ${links}, etiquetas ${tags}, valores de la opción quitada ${values}`);
  const tagged = sql(
    `SELECT COUNT(*) FROM outbox_messages WHERE type='projects.task.tagged' AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.organizationId'))='${ORG4}'`,
  );
  check(tagged === '7', `projects.task.tagged en el outbox: 7 (1 + 6 del lote) — hay ${tagged}`);
} catch (err) {
  fail(`no se pudo consultar MySQL: ${err.message}`);
}

// ── 10. Horas y carga de trabajo (entregable 5) ─────────────────────────────
console.log('10. horas y carga (entregable 5)');
const ORG5 = randomUUID();
const c5 = (method, path, opts = {}) => call(method, path, { ...opts, org: ORG5 });
const p5 = (await c5('POST', '/projects', { body: { name: 'Horas', visibility: 'organization', sectionNames: ['Uno'] } })).json;
const t5 = (await c5('POST', '/projects/tasks', { body: { title: 'Con horas', projectId: p5.id, assigneeUserId: ANA } })).json;

const startRace = await Promise.all(Array.from({ length: 20 }, () => c5('POST', '/projects/time-entries/timer', { body: { taskId: t5.id } })));
check(startRace.every((r) => r.status === 201) && startRace.every((r) => r.json.stopped === null), `20 «arrancar» a la vez en la misma tarea: todos 201 y ninguno registra horas (${startRace.map((r) => r.status).join(',').slice(0, 40)})`);
const stopRace = await Promise.all(Array.from({ length: 10 }, () => c5('POST', '/projects/time-entries/timer/stop', { body: { workedOn: '2026-11-04' } })));
const stoppedOk = stopRace.filter((r) => r.status === 201).length;
const notRunning = stopRace.filter((r) => r.status === 409 && r.json.code === 'TIMER_NOT_RUNNING').length;
check(stoppedOk === 1 && notRunning === 9, `10 «detener» a la vez: 1 registra y 9 reciben 409 (${stoppedOk}/${notRunning})`);

await c5('POST', '/projects/time-entries', { body: { taskId: t5.id, workedOn: '2026-11-03', minutes: 90, billable: false, note: 'Reunión con el cliente' } });
await c5('POST', '/projects/time-entries', { body: { taskId: t5.id, workedOn: '2026-11-04', minutes: 30 } });
const est = await c5('PATCH', `/projects/tasks/${t5.id}`, { body: { version: t5.version, estimatedMinutes: 480, startOn: '2026-11-05', dueOn: '2026-11-10' } });
check(est.status === 200 && est.json.estimatedMinutes === 480, `tiempo estimado guardado (${est.status})`);
const card = (await c5('GET', `/projects/${p5.id}/tasks`)).json.tasks.find((x) => x.id === t5.id);
check(card.actualMinutes === 121, `la tarjeta suma con SUM() de MySQL: ${card.actualMinutes} min (1 del cronómetro + 90 + 30)`);
const rep5 = (await c5('GET', '/projects/time-entries?from=2026-11-01&to=2026-11-30')).json;
check(rep5.totalMinutes === 121 && rep5.billableMinutes === 31 && rep5.items.some((i) => i.billable === false && i.note === 'Reunión con el cliente'), `reporte: total ${rep5.totalMinutes}, facturable ${rep5.billableMinutes}; el «no facturable» vuelve como false`);
const others = await c5('GET', `/projects/time-entries?userId=${BETO}`);
check(others.status === 403, `sin time_entry:read_all, pedir las horas de otro es 403 (${others.status})`);

const ADMIN = `${PERMS},project:admin`;
const capRace = await Promise.all([600, 1200, 1800, 2400, 300].map((weeklyMinutes) => c5('PUT', `/projects/workload/capacity/${BETO}`, { perms: ADMIN, body: { weeklyMinutes } })));
check(capRace.every((r) => r.status === 200), `5 capacidades distintas a la vez para la misma persona: ninguna falla (${capRace.map((r) => r.status).join(',')})`);
const w5 = (await c5('GET', '/projects/workload?from=2026-11-04&weeks=2')).json;
const ana5 = w5.people.find((p) => p.userId === ANA);
check(
  JSON.stringify(ana5?.weeks.map((w) => w.minutes)) === JSON.stringify([240, 240]) && ana5.weeklyMinutes === 2400,
  `carga de Ana: 8 h de jue a mar → ${ana5?.weeks.map((w) => w.minutes / 60 + ' h').join(' + ')}, capacidad ${ana5?.weeklyMinutes / 60} h`,
);
try {
  const caps = sql(`SELECT COUNT(*) FROM member_capacity WHERE organization_id='${ORG5}'`);
  const timers = sql(`SELECT COUNT(*) FROM running_timers WHERE organization_id='${ORG5}'`);
  const logged = sql(`SELECT COUNT(*) FROM outbox_messages WHERE type='projects.time_entry.logged' AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.organizationId'))='${ORG5}'`);
  check(caps === '1' && timers === '0' && logged === '3', `filas: capacidad ${caps}, cronómetros en marcha ${timers}, eventos de horas ${logged} (de 3)`);
} catch (err) {
  fail(`no se pudo consultar MySQL: ${err.message}`);
}

// ── 11. Facturar el proyecto (entregable 6) ─────────────────────────────────
console.log('11. facturar el proyecto (entregable 6)');
const ORG6 = randomUUID();
const BILL = `${PERMS},project:bill`;
const c6 = (method, path, opts = {}) => call(method, path, { perms: BILL, ...opts, org: ORG6 });
const p6 = (await c6('POST', '/projects', { body: { name: 'Facturable', visibility: 'organization', sectionNames: ['Uno'] } })).json;
const cfg = await c6('PUT', `/projects/billing/${p6.id}/settings`, {
  body: { customerId: randomUUID(), customerLabel: 'Café Central', hourlyRateCents: 2500, serviceProductId: randomUUID(), serviceProductLabel: 'Servicios', groupBy: 'task' },
});
check(cfg.status === 200 && cfg.json.hourlyRateCents === 2500, `configurar la facturación (${cfg.status})`);
const noBill = await c6('GET', `/projects/billing/${p6.id}`, { perms: PERMS });
check(noBill.status === 403, `sin project:bill, la pestaña Facturación es 403 (${noBill.status})`);
const t6 = (await c6('POST', '/projects/tasks', { body: { title: 'Desarrollo', projectId: p6.id, assigneeUserId: ANA } })).json;
for (const minutes of [90, 31, 45]) await c6('POST', '/projects/time-entries', { body: { taskId: t6.id, workedOn: '2026-11-04', minutes } });
const hito = (await c6('POST', '/projects/tasks', { body: { title: 'Entrega', projectId: p6.id, kind: 'milestone' } })).json;
await c6('PUT', `/projects/billing/${p6.id}/milestones/${hito.id}`, { body: { amountCents: 150000 } });
await c6('POST', `/projects/tasks/${hito.id}/complete`);

const criteria = { includeHours: true, milestoneTaskIds: [hito.id] };
const reserveRace = await Promise.all(Array.from({ length: 10 }, () => c6('POST', `/projects/billing/${p6.id}/reserve`, { body: criteria })));
const won6 = reserveRace.filter((r) => r.status === 201);
const lost6 = reserveRace.filter((r) => r.status === 409 && r.json.code === 'NOTHING_TO_BILL').length;
check(won6.length === 1 && lost6 === 9, `10 «facturar» a la vez: 1 reserva y 9 reciben NOTHING_TO_BILL (${won6.length}/${lost6}; ${reserveRace.map((r) => r.status).join(',')})`);
const reserved = won6[0]?.json;
check(reserved?.invoice.amountCents === 3750 + 1300 + 1875 + 150000 || reserved?.invoice.amountCents === Math.round(2.77 * 2500) + 150000, `importe reservado: ${reserved?.invoice.amountCents} centavos (166 min a $25/h + hito $1.500)`);
const billedEntry = (await c6('GET', `/projects/time-entries?projectId=${p6.id}`)).json.items[0];
const locked = await c6('PATCH', `/projects/time-entries/${billedEntry.id}`, { body: { minutes: 5 } });
check(locked.status === 409 && locked.json.code === 'ALREADY_BILLED', `horas reservadas no se corrigen (${locked.status} ${locked.json?.code})`);
const INV6 = randomUUID();
const att = await c6('POST', `/projects/billing/invoices/${reserved.invoice.id}/attach`, { body: { invoiceId: INV6 } });
check(att.status === 200 && att.json.status === 'draft', `enlazar el borrador de billing (${att.json?.status})`);
try {
  const rows = sql(`SELECT COUNT(*) FROM time_entries WHERE billing_id='${reserved.invoice.id}'`);
  check(rows === '3', `las 3 filas de horas quedaron con la reserva en MySQL (${rows})`);
} catch (err) {
  fail(`no se pudo consultar MySQL: ${err.message}`);
}

// El consumidor de verdad: se publica en RabbitMQ lo que publicaría billing-service y se espera a que projects-service lo procese.
const RABBIT = process.env.RABBITMQ_URL ?? 'amqp://localhost:5672';
let amqp = null;
try {
  amqp = await import('amqplib');
} catch {
  // Sin amqplib no se prueba el consumidor.
}
const waitFor = async (probe, ms = 8000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await probe()) return true;
    await new Promise((ok) => setTimeout(ok, 250));
  }
  return false;
};
let conn = null;
try {
  conn = amqp ? await (amqp.default ?? amqp).connect(RABBIT) : null;
} catch {
  conn = null;
}
if (!conn) {
  console.log(`  ---  RabbitMQ no disponible en ${RABBIT}: no se prueba el consumidor`);
} else {
  const ch = await conn.createChannel();
  const send = (type, payload, eventId) =>
    ch.publish('crm.events', type, Buffer.from(JSON.stringify(payload)), { persistent: true, headers: { eventId } });
  const issuedId = randomUUID();
  send('billing.invoice.issued', { organizationId: ORG6, invoiceId: INV6, number: '001-001-000000777' }, issuedId);
  send('billing.invoice.issued', { organizationId: ORG6, invoiceId: INV6, number: '001-001-000000777' }, issuedId);
  const issued = await waitFor(async () => (await c6('GET', `/projects/billing/${p6.id}`)).json.invoices[0]?.status === 'issued');
  const inv = (await c6('GET', `/projects/billing/${p6.id}`)).json.invoices[0];
  check(issued && inv.number === '001-001-000000777', `billing.invoice.issued por RabbitMQ → emitida con número (${inv?.status} ${inv?.number})`);
  const rel = await c6('POST', `/projects/billing/invoices/${reserved.invoice.id}/release`);
  check(rel.status === 409, `una factura emitida no se libera a mano (${rel.status})`);
  send('billing.invoice.voided', { organizationId: ORG6, invoiceId: INV6 }, randomUUID());
  const voided = await waitFor(async () => (await c6('GET', `/projects/billing/${p6.id}`)).json.unbilledMinutes === 166);
  const after6 = (await c6('GET', `/projects/billing/${p6.id}`)).json;
  check(voided && after6.invoices[0].status === 'voided' && after6.milestones[0].billingId === null, `billing.invoice.voided → las horas y el hito vuelven a «por facturar» (${after6.unbilledMinutes} min, ${after6.invoices[0].status})`);
  // Liberar un borrador y emitirlo igual en Facturación: al llegar el evento, recupera sus horas (nadie las tomó entretanto).
  const again = await c6('POST', `/projects/billing/${p6.id}/reserve`, { body: { includeHours: true, milestoneTaskIds: [] } });
  const INV7 = randomUUID();
  await c6('POST', `/projects/billing/invoices/${again.json.invoice.id}/attach`, { body: { invoiceId: INV7 } });
  await c6('POST', `/projects/billing/invoices/${again.json.invoice.id}/release`);
  send('billing.invoice.issued', { organizationId: ORG6, invoiceId: INV7, number: '001-001-000000778' }, randomUUID());
  const reclaimed = await waitFor(async () => (await c6('GET', `/projects/billing/${p6.id}`)).json.unbilledMinutes === 0);
  const inv7 = (await c6('GET', `/projects/billing/${p6.id}`)).json.invoices.find((i) => i.invoiceId === INV7);
  check(reclaimed && inv7?.status === 'issued' && inv7.conflicts === 0, `borrador liberado y emitido igual → recupera sus 166 min (${inv7?.status}, conflictos ${inv7?.conflicts})`);
  try {
    const issuedEvents = sql(`SELECT COUNT(*) FROM outbox_messages WHERE type='projects.invoice.issued' AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.organizationId'))='${ORG6}'`);
    check(issuedEvents === '2', `dos facturas emitidas y el mismo billing.invoice.issued repetido una vez: 2 eventos (${issuedEvents})`);
  } catch (err) {
    fail(`no se pudo consultar MySQL: ${err.message}`);
  }
  await ch.close();
  await conn.close();
}

// ── 12. Reglas, formularios y panel (entregable 7) ──────────────────────────
console.log('12. reglas, formularios y panel (entregable 7)');
const ORG7 = randomUUID();
const c7 = (method, path, opts = {}) => call(method, path, { ...opts, org: ORG7 });
const p7 = (await c7('POST', '/projects', { body: { name: 'Automatizado', visibility: 'members', sectionNames: ['Entrada', 'En curso', 'Hecho'] } })).json;
const [entrada, , hecho] = (await c7('GET', `/projects/${p7.id}/tasks`)).json.sections;
const rule7 = await c7('POST', `/projects/${p7.id}/rules`, {
  body: { name: 'Cerrar al terminar', trigger: 'task_moved', triggerSectionId: hecho.id, actions: [{ type: 'complete' }, { type: 'assign', userId: BETO }] },
});
check(rule7.status === 201 && rule7.json.actions.length === 2, `crear la regla (${rule7.status}); sus acciones vuelven de la columna JSON`);
const many7 = await Promise.all(Array.from({ length: 12 }, (_, i) => c7('POST', '/projects/tasks', { body: { title: `R${i}`, projectId: p7.id, sectionId: entrada.id } })));
const moves7 = await Promise.all(many7.map((r) => c7('POST', `/projects/tasks/${r.json.id}/move`, { body: { projectId: p7.id, sectionId: hecho.id, version: r.json.version } })));
check(moves7.every((r) => r.status === 200), '12 tareas movidas a Hecho a la vez');
const board7 = (await c7('GET', `/projects/${p7.id}/tasks`)).json.tasks.filter((t) => t.title.startsWith('R'));
check(board7.every((t) => t.completedAt && t.assigneeUserId === BETO), `la regla completó y asignó las 12 (${board7.filter((t) => t.completedAt).length} completadas)`);
const rules7 = (await c7('GET', `/projects/${p7.id}/rules`)).json.items;
check(rules7[0].runCount === 12 && rules7[0].lastError === null, `run_count = 12 con 12 ejecuciones a la vez (UPDATE atómico): ${rules7[0].runCount}`);

const form7 = await c7('POST', `/projects/${p7.id}/forms`, {
  body: {
    title: 'Pedidos',
    questions: [
      { label: 'Área', type: 'select', required: true, options: ['Ventas', 'Bodega'] },
      { label: 'Para cuándo', type: 'date', mapsToDue: true },
    ],
    sectionId: entrada.id,
    assigneeUserId: ANA,
  },
});
check(form7.status === 201, `crear el formulario (${form7.status})`);
const pub7 = await c7('GET', `/projects/forms/${form7.json.id}`, { user: BETO });
check(pub7.status === 200 && pub7.json.questions.length === 2, `Beto, que no es miembro del proyecto privado, abre el formulario (${pub7.status})`);
const [qArea, qWhen] = pub7.json.questions;
const sends7 = await Promise.all(
  Array.from({ length: 15 }, (_, i) =>
    c7('POST', `/projects/forms/${form7.json.id}/submit`, { user: BETO, body: { title: `Pedido ${i}`, answers: { [qArea.id]: 'Bodega', [qWhen.id]: '2026-12-01' } } }),
  ),
);
check(sends7.every((r) => r.status === 201), `15 solicitudes a la vez: todas 201 (${sends7.filter((r) => r.status === 201).length})`);
const mine7 = await c7('GET', `/projects/tasks/${sends7[0].json.taskId}`, { user: BETO });
check(mine7.status === 200 && mine7.json.dueOn === '2026-12-01' && mine7.json.assigneeUserId === ANA, 'Beto ve su solicitud con entrega y responsable');
check((await c7('GET', `/projects/${p7.id}`, { user: BETO })).status === 404, 'pero el proyecto privado sigue siendo 404 para él');
const forms7 = (await c7('GET', `/projects/${p7.id}/forms`)).json.items;
check(forms7[0].submissionCount === 15, `submission_count = 15 (${forms7[0].submissionCount})`);
const dash7 = (await c7('GET', `/projects/${p7.id}/dashboard`)).json;
check(dash7.totals.total === 27 && dash7.totals.completed === 12 && dash7.totals.open === 15, `panel: ${dash7.totals.total} tareas, ${dash7.totals.completed} completadas, ${dash7.totals.open} abiertas`);
try {
  const applied = sql(`SELECT COUNT(*) FROM outbox_messages WHERE type='projects.rule.applied' AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.organizationId'))='${ORG7}'`);
  check(applied === '12', `projects.rule.applied: 12 en el outbox (${applied})`);
} catch (err) {
  fail(`no se pudo consultar MySQL: ${err.message}`);
}

// ── 6. Outbox y colación ────────────────────────────────────────────────────
console.log('6. outbox y base');
try {
  const counts = sql(
    `SELECT type, COUNT(*) FROM outbox_messages WHERE JSON_UNQUOTE(JSON_EXTRACT(payload,'$.organizationId')) = '${ORG}' GROUP BY type ORDER BY type`,
  );
  const byType = Object.fromEntries(counts.split('\n').filter(Boolean).map((l) => l.split('\t')));
  check(Number(byType['projects.project.created']) === 1, 'projects.project.created en el outbox con organizationId');
  check(Number(byType['projects.task.moved']) === 1, `projects.task.moved: exactamente 1 (el movimiento que ganó) — hay ${byType['projects.task.moved']}`);
  check(Number(byType['projects.task.created']) === 1 + 30 + 1 + 60 + 2 + 3, `projects.task.created: ${byType['projects.task.created']} de 97 (1 + 30 + 1 + 60, 2 de la sección 7 y 3 de la 8)`);
  check(Number(byType['projects.section.deleted']) === 1, 'projects.section.deleted');
  const collations = sql(
    "SELECT CONCAT(TABLE_NAME,'.',COLUMN_NAME,'=',COLLATION_NAME) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='projects_db' AND COLUMN_NAME IN ('rank','subtask_rank') ORDER BY 1",
  );
  check(collations.split('\n').every((l) => l.endsWith('=ascii_bin')), `rangos en ascii_bin (${collations.replace(/\n/g, ', ')})`);
} catch (err) {
  fail(`no se pudo consultar MySQL con docker exec ${MYSQL}: ${err.message}`);
}

console.log(failures ? `\n${failures} comprobación(es) fallaron.` : '\nTodo en verde.');
process.exit(failures ? 1 : 0);
