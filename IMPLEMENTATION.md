# projects-service — Proyectos y tareas al estilo Asana

Ficha de diseño (fuente de verdad): `~/Documents/sg-obs/crm-proyect/servicios/projects-service.md`. Puerto **3020**, base
`projects_db`, rama **`main`**, módulo `projects.tasks_kanban`.

## Estado (2026-11-10)

**En producción y a la venta.** Repo `facturero/projects-service` (rama `main`), los 7 entregables desplegados y probados con datos
reales. El 2026-11-10 los cuatro módulos `projects.*` pasaron a «disponible» en el catálogo (migración
`plugin-catalog-service/migrations/20261110120000-publish-projects-plugins.cjs`): el tablero a 4,99 USD/mes por organización; horas
3,99, carga de trabajo 5,99 y facturar el proyecto 6,99.

Hecho después de los 7 entregables (todo en producción):
- **Correo de los avisos**: los 10 avisos de la campana también salen por correo (ver «Correo de los avisos» más abajo).
- **Dimensión «proyecto» en contabilidad**: la factura de un proyecto se contabiliza con el proyecto (ver entregable 6).
- **Recorrido guiado** al comprar el módulo (`useAppTour`, recorrido `projects`): sale solo después de activarlo en el catálogo y se
  relanza desde el menú ⋯ de Mis tareas o de un proyecto.
- Revisión de UI contra REGLAS-FRONT terminada (`frontend/docs/REVISION-PROYECTOS.md`): Ctrl+K con proyectos y tareas, anillo de
  estados en el panel, calendario sobre `v-calendar`, teclado para mover tareas, filas legibles en el teléfono.

Queda (decisión del dueño, no código pendiente): portafolios y objetivos (Goals) como módulo aparte, invitados externos (vía portal de
clientes), vincular cotizaciones desde la pantalla (no hay módulo de cotizaciones), y un nivel gratuito o límites si se quisiera.

### Entregable 7 — reglas, formularios y panel

Todo dentro del módulo base `projects.tasks_kanban` (el «Asana» de $4,99), sin permisos nuevos: lo decide el rol en el proyecto.

| Pieza | Dónde | Estado |
|---|---|---|
| Reglas «cuando pase X, haz Y»: tarea agregada (en una sección), movida a una sección, completada → asignar, fecha de entrega a N días, mover a sección, completar, etiquetar, sumar seguidor (hasta 5 acciones) | tabla `project_rules`, `domain/automation.ts`, `automation-use-cases.ts`; frontend `ProjectRulesDialog.vue` (menú del proyecto) | Hecho |
| Las reglas corren TRAS confirmar el cambio, a nombre de quien la guardó, por los mismos casos de uso que una persona; lo que hace una regla no dispara otras (sin bucles); si fallan, el cambio de la persona se queda y el error va a `last_error` | gancho `TaskUseCases.setRuleRunner` (crear, mover, completar) y `Actor.viaRule` | Hecho |
| Formularios de solicitud: cualquiera de la organización los llena aunque no sea miembro; la tarea cae en la sección elegida, con responsable y entrega; quien la pidió queda como seguidor (ve su tarea, no el proyecto); las reglas también corren | tabla `project_forms`; frontend `ProjectFormsDialog.vue` y `/project-forms/:id` (`FormFillView.vue`) | Hecho |
| Panel del proyecto: abiertas, completadas, vencidas, vencen esta semana, sin responsable; por sección; por responsable; completadas por semana (8); hitos; horas estimadas y registradas | `dashboard-use-cases.ts` (sin tablas), pestaña «Panel» (`ProjectDashboard.vue`) | Hecho |

Verificado: 127 pruebas del servicio, contratos 86 rutas y 58 + 2 eventos, frontend 467 + `lint:ui` + build, `verify-projects.mjs`
**sección 12** contra MySQL (12 tareas movidas a la vez → la regla corre 12 veces y `run_count` = 12 con UPDATE atómico; 15 solicitudes a la
vez de alguien que no es miembro → 15 tareas, ve la suya y el proyecto sigue siendo 404 para él). En la interfaz: el Panel, crear una
regla desde el menú, mover una tarea a «Declaraciones» con el lote → quedó completada y el historial dice «aplicó la regla…», crear un
formulario, llenarlo desde su enlace y abrir la solicitud creada.


### Entregable 6 — facturar el proyecto con el SRI

Módulo aparte y opcional (`projects.project_billing`, depende de Horas y de Facturación electrónica); solo Administrador y Contador
(`project:bill`). Quien compra solo `projects.tasks_kanban` no ve nada de esto. **billing-service no se tocó**: se usa su API de siempre
(crear borrador, añadir líneas) y sus eventos `billing.invoice.issued` / `billing.invoice.voided`.

| Pieza | Dónde | Estado |
|---|---|---|
| Configuración por proyecto: cliente, servicio (producto de tipo servicio: decide el IVA), tarifa por hora, una línea por tarea / persona / todo | tabla `project_billing`, `billing-use-cases.ts` | Hecho |
| Importe fijo por hito; se factura cuando el hito está completado | tabla `milestone_amounts` | Hecho |
| Reserva → borrador en Facturación → enlace: las horas y los hitos se apartan con `FOR UPDATE` ANTES de crear el borrador; si algo falla, se liberan | `reserve` / `attach` / `release`; frontend `ProjectBilling.vue` (pestaña «Facturación») | Hecho |
| Horas e hitos reservados o facturados no se corrigen ni se borran (409 `ALREADY_BILLED`) | `time_entries.billing_id`, `time-use-cases.ts` | Hecho |
| Consumidor de billing: emitida → número; anulada → las horas vuelven a «por facturar» | `infrastructure/messaging/consumer.ts` (cola `projects-service.events`, idempotente por `processed_events`) | Hecho |
| Borrador liberado pero emitido igual (billing no deja borrar ni anular borradores): al emitirse se recuperan sus horas; lo que ya estaba en otra factura queda en `conflicts` y la pantalla lo marca | `onInvoiceIssued`, `project_invoices.entry_ids` | Hecho |
| Permiso `project:bill` (Administrador, Contador); gateway `/projects/billing/*` con módulo y permiso, antes del comodín | `auth-service/migrations/20261108100000-add-project-bill-permission.js`, `gateway.config.ts` | Hecho |

Verificado: 117 pruebas del servicio, contratos 75 rutas, 52 eventos publicados y 2 consumidos, gateway 219, frontend 467 + `lint:ui` +
build, y `verify-projects.mjs` **sección 11** contra MySQL y RabbitMQ reales (10 «facturar» a la vez → una sola reserva; horas reservadas
bloqueadas; `billing.invoice.issued` publicado dos veces → se procesa una; `billing.invoice.voided` devuelve las horas; borrador liberado y
emitido igual → las recupera). En la interfaz: configurar cliente y servicio, vista previa («Servicios profesionales — Conciliar bancos
(1,52 h)», 1,52 × $25 = $38), crear el borrador (en Facturación: $38 + IVA 15 % $5,70 = $43,70, **sin emitir**), liberar con confirmación.

**Dimensión «proyecto» en contabilidad (hecho el 2026-11-10).** billing-service no se tocó: accounting-service escucha
`projects.invoice.linked` (al crear el borrador) y `projects.invoice.issued`, anota factura → proyecto en su tabla `source_projects`, y
al contabilizar `billing.invoice.issued` todas las líneas del asiento salen con ese proyecto (también el costo de ventas que la
referencia y la reversa). Los informes contables aceptan `projectId`. Ver `accounting-service/IMPLEMENTATION.md`, punto 7.


### Entregable 5 — horas y carga de trabajo

| Pieza | Dónde | Estado |
|---|---|---|
| Tiempo estimado de la tarea (`tasks.estimated_minutes`), con su línea en el historial y copiado al duplicar | migración `20261107100000-time-tracking.cjs`, `task-use-cases.ts` | Hecho |
| Registro de horas a mano o con cronómetro, facturables o no, cargadas a uno de los proyectos de la tarea | tabla `time_entries`, `time-use-cases.ts`; frontend `TaskTime.vue` en el detalle | Hecho |
| Cronómetro: uno por persona (arrancar otro detiene y registra el anterior), máximo 24 h por registro, descartar; chip visible en Proyecto, Mis tareas y Horas | tabla `running_timers`, `stores/timer.ts`, `RunningTimerChip.vue` | Hecho |
| Pantalla «Horas» (`/time-tracking`): periodos, persona, proyecto, facturable, totales por persona y proyecto, corregir y borrar, CSV | `TimeTrackingView.vue`, `utils/timeReport.ts` | Hecho |
| Pantalla «Carga de trabajo» (`/workload`): horas estimadas por persona y semana contra su capacidad (verde/naranja/rojo), tareas de cada celda, capacidad editable | `workload-use-cases.ts`, `domain/workload.ts`, tabla `member_capacity`, `WorkloadView.vue` | Hecho |
| Permiso `time_entry:read_all` (Administrador, Contador): ver las horas de otros | `auth-service/migrations/20261107100000-add-time-entry-permission.js` | Migrado en local |
| Gateway: `/projects/time-entries*` exige `projects.time_tracking` y `/projects/workload*` `projects.resource_allocation`, ANTES del comodín | `api-gateway-node/src/config/gateway.config.ts` + prueba | Hecho |

Verificado: 109 pruebas del servicio, contratos 68 rutas y 46 eventos, gateway 218, frontend 464 + `lint:ui` + build, y
`verify-projects.mjs` **sección 10** contra MySQL. En la interfaz: arrancar y detener el cronómetro, estimado de 6 h, registrar «1,5»,
la pantalla Horas con sus totales y la Carga de trabajo (capacidad bajada a 4 h → la semana en rojo, detalle de la celda).

**Bugs que encontró la verificación contra MySQL, corregidos:**
- 20 «arrancar cronómetro» a la vez y 5 capacidades a la vez daban **500**. MySQL elegía una víctima de *deadlock* (dos
  transacciones que chocaron en el `INSERT IGNORE` se quedan con un bloqueo compartido y luego ambas piden el exclusivo), y el
  `rollback()` de Sequelize sobre la transacción ya deshecha lanzaba otro error que tapaba al primero. Ahora `inTransaction` repite la
  transacción entera ante un deadlock (hasta 5 veces; es seguro porque MySQL ya la deshizo), el `rollback` tolera una transacción
  terminada, y el doble clic en la misma tarea se resuelve con un bloqueo compartido, sin pedir el exclusivo. Prueba en `retry.test.ts`.

Decisiones: un número solo se lee como HORAS («2», «1,5», «1:30»; «45 min» para minutos). Al detener el cronómetro el navegador manda
el día LOCAL en que arrancó (el servidor está en UTC). Las horas de una tarea las ve quien ve la tarea; el reporte, las propias salvo
`time_entry:read_all` (que ve también las de proyectos privados: es un permiso deliberado para quien revisa lo facturable). La carga de
trabajo solo muestra a quien tiene tareas con fecha en esas semanas.


### Entregable 4 — vínculos con el ERP, plantillas, campos, etiquetas, búsqueda y lote

| Pieza | Dónde | Estado |
|---|---|---|
| «Vinculado a»: la tarea apunta a un cliente, factura, cotización, OC o producto (lo que Asana no tiene); la ficha del cliente muestra sus tareas y crea una nueva ya vinculada | tabla `task_links` (único tarea+registro), `organize-use-cases.ts`; frontend `TaskLinks.vue`, `LinkedTasksCard.vue` en `CustomerDetailView` | Hecho |
| Etiquetas de la organización (Enter crea; «Urgente» = «urgente») | tablas `tags` (único org+nombre) y `task_tags` | Hecho |
| Campos personalizados por proyecto: lista, texto, número (acepta coma decimal), fecha, persona; columna en la lista, fila en el detalle, chip en la tarjeta | tablas `custom_fields` y `custom_field_values` (PK tarea+campo), `domain/fields.ts`; `ProjectFieldsDialog.vue`, `TaskFieldInput.vue` | Hecho |
| 6 plantillas de fábrica en es/en/fr (incorporación de cliente, cierre contable, obra, lanzamiento, campaña, contratación), con fechas relativas, hitos y dependencias | `domain/templates.ts`, `POST /projects/from-template`; `ProjectTemplateDialog.vue` | Hecho |
| Duplicar proyecto (secciones, tareas, subtareas, campos y valores, etiquetas, dependencias; sin responsables ni finalizadas) | `workspace-use-cases.ts` | Hecho |
| Buscar tareas y proyectos (solo lo visible; `%` y `_` literales) | `GET /projects/search`; `ProjectSearchDialog.vue` | Hecho |
| Edición en lote (hasta 100): finalizar, reabrir, borrar, asignar, fecha, mover, etiquetar; una transacción por tarea, informe por tarea | `POST /projects/tasks/bulk`; `TaskBulkBar.vue` | Hecho |

Verificado: 97 pruebas del servicio; contratos 58 rutas y 42 eventos; `verify-projects.mjs` **sección 9** contra MySQL (en otra
organización). En el frontend: 458 pruebas, `lint:ui` y build. En la interfaz: crear desde la plantilla de cierre contable, crear el
campo «Prioridad» y elegir «Alta», crear la etiqueta «Mensual» con Enter, vincular a un cliente (con su línea en el historial), asignar
2 tareas en lote, chips en el tablero, la tarjeta «Tareas» en la ficha del cliente (y crear desde ahí), buscar y abrir, duplicar.

**Bugs que encontró la verificación contra MySQL (las pruebas en memoria no los ven), corregidos:**
- 20 «vincular» iguales a la vez daban **500**, y 20 valores del mismo campo a la vez daban **409**. Ahora `addLink` y
  `setFieldValue` bloquean la tarea (`FOR UPDATE`) antes de leer y escribir.
- 10 «Urgente»/«urgente» a la vez daban **409**: buscar y luego crear no basta. Ahora es `INSERT IGNORE` y, si otra petición
  ganó, una lectura con bloqueo (`LOCK.SHARE`) devuelve la suya.
- El tablero daba **500** en cuanto una tarea tenía un valor de lista: mysql2 ya entrega la columna JSON decodificada y `json()` la
  volvía a decodificar (y un texto «123» habría acabado convertido en el número 123).
Hay una guardia nueva en `persistence-guard.test.ts` para cada uno.

Las cotizaciones se pueden vincular por la API, pero el frontend todavía no las ofrece: no hay pantalla ni API de cotizaciones.

### Entregable 3 — calendario y cronograma

| Pieza | Dónde | Estado |
|---|---|---|
| Dependencias fin → inicio (bloqueada por / bloquea), sin ciclos (búsqueda por capas, 422 `DEPENDENCY_CYCLE`) | `timeline-use-cases.ts`, tabla `task_dependencies` | Hecho |
| «Ya puedes empezar» al responsable cuando se completa la última que la bloqueaba | `TaskUseCases.notifyUnblocked`, evento `projects.task.unblocked` (proveedor de campana) | Hecho |
| Hitos (`kind = milestone`): rombo en el cronograma y el calendario, «Convertir en hito», próximos hitos en el Resumen | frontend | Hecho |
| Estado del proyecto (en curso / en riesgo / con retraso / completado) con texto enriquecido e historial; el último en la cabecera y en la lista de proyectos | tabla `project_status_updates`, `projects.status_update.posted` (campana a los miembros) | Hecho |
| Pestañas Resumen · Lista · Tablero · Calendario · Cronograma | `ProjectView.vue` | Hecho |
| Cronograma (gantt) propio: barras que se mueven y se estiran con eventos de puntero, flechas de dependencias (rojas si la que espera empieza antes), línea de hoy, clic para programar | `ProjectTimeline.vue`, `utils/timeline.ts` (puras, con pruebas) | Hecho |
| Calendario mensual: tareas por fecha de entrega, arrastrar a otro día (conserva la duración), «+» para crear en un día | `ProjectCalendar.vue` | Hecho |

Sin librería de gantt: las libres son GPL (dhtmlx) o no dejan controlar el arrastre como hace falta. Verificado: 83 pruebas del servicio;
`verify-projects.mjs` sección 8 contra MySQL (15 veces la misma dependencia a la vez → una fila; ciclo A→B→C→A = 422; completar A avisa
a quien tiene B; el estado publicado sale como último en la lista); en la interfaz: arrastrar la barra 2 días (fechas 5–10 → 7–12 en la
base, flecha en rojo por el conflicto) y estirar la entrega 3 días hacia atrás (7–9, flecha otra vez gris), calendario, Resumen y publicar
estado desde el diálogo, panel con «Espera a» / «La esperan».

Corregido tras probarlo: los bordes para estirar pasaron de 8 a 12 px (con 8 costaba atinarles), plural de «tarea/tareas», el mes del
calendario («Noviembre de 2026», no «De»), y el editor del diálogo de estado no recibía el foco al abrirse.

**Arrastre del calendario**: usa el arrastre nativo de HTML5 (como el tablero), que el navegador automatizado no dispara; lo que hace al
soltar es el mismo `reschedule` que el cronograma, que sí se probó arrastrando. Falta que una persona arrastre una tarea entre días.

---

### Entregable 2

### Entregable 2 — colaboración

| Pieza | Dónde | Estado |
|---|---|---|
| Comentarios en texto enriquecido (TipTap) con @menciones; editar y borrar | `projects-service` (`richtext.ts` lista blanca, `collaboration-use-cases.ts`), frontend `RichTextEditor`/`RichTextView`/`TaskConversation` | Hecho |
| Seguidores (dan acceso a la tarea, como en Asana), «me gusta» en tareas y comentarios | idem | Hecho |
| Adjuntos (archivo en document-service, `resourceType` `project_task`) | `TaskAttachments.vue`, `POST /projects/tasks/:id/attachments` | Hecho |
| Historial de la tarea (quién cambió qué) intercalado con los comentarios | `application/activity.ts`, tabla `task_activity` | Hecho |
| Tareas de aprobación (aprobar / pedir cambios / rechazar; «Convertir en aprobación») | `TaskUseCases.decide`, `PATCH kind` | Hecho |
| Aviso diario «vence hoy / mañana» desde las 08:00 locales, uno por tarea y día | `due-soon.ts` (cada hora, `task_reminders` con clave primaria) | Hecho |
| Campana: 8 proveedores solo de campana (asignada, mención, comentario, finalizada, vence, aprobación pedida y respondida, sumado a proyecto) | `notification-service/src/provider-config.json`; el consumidor ahora escucha proveedores SIN plantilla de correo | Hecho |
| Tablero en vivo: aviso mínimo `projects.changed` a la organización | `api-gateway-node/src/realtime/projects-routing.ts` + hub; frontend `stores/projects.onRealtime` | Hecho |
| Atajos de Asana: Tab+Q, Tab+M, Tab+C, Tab+D, Tab+L, Tab+K, Ctrl+Enter, «?» | `useViewShortcuts.ts`, `TaskDetailPanel.vue`, `ShortcutsDialog.vue` | Hecho |
| **Correo** de estos avisos | `notification-service/src/application/project-mail.ts` + ruta interna de auth | Hecho (2026-11-10, ver abajo) |
| Horas en subtareas (2026-11-11, pedido de un cliente): el total de una tarea suma lo registrado en sus subtareas (detalle `actualMinutes` = `ownMinutes` + `subtasksMinutes`, tarjeta del tablero y, por ella, el panel del proyecto); el detalle trae los registros de las subtareas y las horas de cada una. Frontend: «Registrar en» (la tarea o una subtarea) para el cronómetro y el registro manual | `task-use-cases.ts`, `TimeEntryRepository.totalsOfSubtasks`, `TaskTime.vue` | Hecho en local |
| Etiquetas con permiso (2026-11-11): crear, renombrar, cambiar color y eliminar piden `project_tag:manage` (Administrador y Supervisor; migración de auth `20261111100000`); poner/quitar una existente, poder editar la tarea. `PATCH`/`DELETE /projects/tags/:id`, `taskCount` en la lista, eventos `projects.tag.updated`/`deleted`. Frontend: clic en una etiqueta para su color, diálogo «Administrar etiquetas» (Proyectos y el menú de etiquetas) | `organize-use-cases.ts` (`assertCanManageTags`), `TagManagerDialog.vue`, `TagColorSwatches.vue` | Hecho en local |
| Mejoras pedidas por un cliente (2026-11-10): tablas e imágenes en línea en descripción y comentarios, enlaces con texto (los largos pegados tal cual se muestran cortos), la misma barra de formato en los comentarios, color al crear una etiqueta, asignar y borrar subtareas desde la fila, «+» de subtarea como botón, adjuntos con color por tipo | `richtext.ts` (nodos `table`, `tableRow`, `tableHeader`, `tableCell` con solo `colspan`/`rowspan`/`colwidth` acotados; `image` con **solo** `documentId` y `alt`, nunca la URL, que caduca; `file` —documento adjuntado desde el texto, 2026-11-11— con `documentId`, `name` y `mimeType`). Los archivos se adjuntan desde la descripción o un comentario; el recuadro de subida de la tarea se quitó, frontend `RichTextEditor`/`RichTextView`/`RichImage`/`TagColorPicker`/`TaskDetailPanel`/`TaskAttachments` | Hecho en local |

Verificado: 77 pruebas del servicio; `verify-projects.mjs` contra MySQL real con la sección 7 (20 «seguir» y 20 «me gusta» simultáneos
→ una sola fila cada uno con `INSERT IGNORE`, enlace `javascript:` rechazado con 422, mencionado en proyecto privado ve y comenta pero no
edita, descripción JSON intacta tras pasar por MySQL, aprobación); en la interfaz: comentario de «otro compañero» que aparece en vivo
en el panel abierto y suena en la campana («Te mencionaron»), mención eligiendo de la lista con @ y envío con Ctrl+Enter,
convertir en aprobación → asignarme → aprobar, adjuntar (subida real a MinIO).

**Bug encontrado y corregido por la interfaz:** la lista de @menciones salía fuera de pantalla: el panel lateral se desliza con
`transform` y eso convierte `position: fixed` en relativo al panel. Ahora la lista se lleva al `<body>` con `<Teleport>`.

**Correo de los avisos (hecho el 2026-11-10).** projects-service sigue publicando solo ids. notification-service, después de guardar la
campana, pide los correos a auth-service (`GET /internal/organizations/:organizationId/contacts`, con `X-Internal-Secret`, acotado a la
organización del evento: un id de otra empresa no da correo) y escribe a cada destinatario con el canal `smtp` activo en sus
preferencias, nunca a quien causó el aviso. Por defecto llegan por correo: asignada, mención, vence pronto, aprobación pedida y
decidida, y «te añadieron a un proyecto»; comentarios, finalizadas, desbloqueadas y estado del proyecto, solo campana. Es de mejor
esfuerzo: si un correo falla no se reencola el evento (la campana ya quedó y se repetirían los que sí salieron). Orden de despliegue:
auth antes que notification.

---

### Entregable 1

| Pieza | Dónde | Estado |
|---|---|---|
| Servicio | `backend/projects-service` | 50 pruebas, typecheck, `verify:openapi` (25 rutas), `verify:asyncapi` (18 eventos) |
| Permisos `project:read` / `project:create` / `project:admin` | `auth-service/migrations/20261104100000-add-project-permissions.js` | Migrado contra MySQL local |
| Directorio de compañeros `GET /users/directory` | `auth-service` (caso de uso, ruta, openapi, prueba e2e) | 261 pruebas de auth |
| Catálogo: nombres comerciales, `resource_allocation` sin `hr.employees`, perfiles agencia y constructora | `plugin-catalog-service/migrations/20261104110000-projects-plugins-asana.cjs` | Migrado; el módulo sigue `en_construccion` |
| Gateway: `ANY /projects/*` (módulo + `project:read`), `PROJECTS_SERVICE_URL` | `api-gateway-node` (config, env, k8s, prueba) | 213 pruebas |
| Frontend: `/projects`, `/projects/:id` (Lista y Tablero), `/my-tasks`, panel de detalle, Compartir, celebración | `frontend/src/{views,components}/projects`, store, api, i18n es/en/fr, bitácora | typecheck, 449 pruebas, `lint:ui`, build |
| Local | `docker-compose.yml` (`projects-migrate`, `projects-service`), `docker/mysql/init.sql` | Levantado y probado |

## Cómo se verificó

- **Pruebas en memoria** (`npm test`): roles y visibilidad (proyecto privado = 404, responsable ve su tarea sin ver el proyecto,
  aislamiento entre organizaciones), orden fraccional y su reequilibrio, versión y 409, secciones, papelera, atomicidad del outbox.
- **Contra MySQL real** (`node scripts/verify-projects.mjs`, con el servicio en `:3020`): 20 movimientos simultáneos de la misma
  tarjeta → 1 aceptado y 19 conflictos; 30 creaciones simultáneas; privacidad; borrar sección con la FOREIGN KEY real; reequilibrio
  (rango máximo 11); eventos en `outbox_messages` con `organizationId`; rangos en `ascii_bin`. **Todo en verde.**
- **Por la interfaz** (navegador, 1366 px y 375 px): crear proyecto, tablero con sus 3 columnas, alta de tareas seguidas con Enter,
  panel de detalle (asignarme, fecha, subtarea), finalizar con celebración, lista con tachado y recuento de subtareas, Mis tareas con
  captura rápida. Sin errores propios en consola (los 502 de `/telemetry/v1/traces` son del colector OTel que no existe en local).

### Lo que NO se pudo verificar automáticamente

- **Arrastrar con el ratón.** SortableJS usa el arrastre nativo de HTML5 y el ratón simulado del navegador de pruebas no lo dispara.
  Se verificó la mitad que es nuestra (soltar → vecinas → `POST …/move` → persiste tras recargar) llamando al store; **falta que una
  persona arrastre una tarjeta y una columna a mano** en Chrome y en una tablet.
- La fecha con el selector nativo se probó asignando el valor por script (escribir en el selector por automatización no es fiable).

## Decisiones tomadas al construir

- **Descripción en texto plano** en el entregable 1 (columna TEXT). El texto enriquecido con @menciones (TipTap) llega con los
  comentarios en el entregable 2; migrar texto plano a TipTap es directo.
- **Rangos con reequilibrio**: si un rango pasa de 32 caracteres se reparte la columna entera (`application/rebalance.ts`). Sin eso,
  mil arrastres al mismo hueco daban 334 caracteres y no cabían en `VARCHAR(255)` (lo encontró una prueba).
- **Vecinas no contiguas** (`beforeId`/`afterId`) se aceptan si están en orden: con «ocultar finalizadas» el cliente no ve todas las
  tarjetas. Solo es 422 si alguna ya no está en esa sección o el orden se invirtió.
- **Proyecto archivado = solo lectura** (409 `PROJECT_ARCHIVED` al escribir), hasta desarchivarlo.
- **Completar no pide versión**: es idempotente y no debe chocar con una edición de título simultánea.
- **El responsable puede completar su tarea** aunque solo sea comentarista en el proyecto (como Asana).
- **Directorio en auth sin permiso propio**: `GET /users/directory` (id, nombre, correo, foto de los usuarios activos). `GET /users`
  pide `user:read` y un Vendedor no lo tiene, pero tiene que poder asignar tareas.
- **Comentarios, @menciones, seguidores, adjuntos, notificaciones y tablero en vivo**: entregable 2 (hecho, ver arriba).
- **Destinatarios en `userIds`** (no `recipientUserIds`, como se llamaron en el entregable 1): es lo que leen notification-service y el gateway.

## Para subirlo (lo hace el dueño)

1. Crear el repo `facturero/projects-service` (rama `main`) y su secreto `NODE_AUTH_TOKEN` (para bajar `@facturero/outbox-relay`).
2. Base y usuario en el MySQL del clúster (`projects_db`, `projects_user`) y `config/secrets.production.enc` cifrado con SOPS
   (`DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `RABBITMQ_URL`), como los demás servicios.
3. Orden: **auth-service** (permisos —3 migraciones— y directorio) → **plugin-catalog-service** → **projects-service** (7 migraciones: tablas,
   colaboración, cronograma, vínculos/etiquetas/campos, horas, facturación, reglas/formularios) → **notification-service** (10 proveedores de la campana) → **api-gateway-node** (`PROJECTS_SERVICE_URL`,
   tablero en vivo) → **frontend**.
4. Publicar los módulos cuando se hayan probado: `UPDATE plugins SET build_status = 'disponible' WHERE code IN ('projects.tasks_kanban', 'projects.time_tracking', 'projects.resource_allocation', 'projects.project_billing');`
