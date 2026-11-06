import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * De dónde salió un cambio que no hizo una persona a mano: una regla del proyecto o un formulario.
 *
 * Las reglas y los formularios corren DENTRO de la petición que los disparó, así que el actor que la bitácora ve (usuario, IP,
 * request-id) es quien movió la tarea o envió el formulario. Eso es correcto: es quien lo causó. Pero sin este dato, «Ana asignó la
 * tarea a Beto» no se distingue de «la regla "Asignar lo nuevo a Beto" lo hizo cuando Ana creó la tarea». Cada evento publicado
 * mientras corre una regla o un formulario lleva `via` en su payload (lo añade el outbox), igual que el actor viaja en el contexto.
 */
export interface ChangeOrigin {
  type: 'rule' | 'form';
  id: string;
  name: string;
}

const storage = new AsyncLocalStorage<ChangeOrigin>();

export function runWithOrigin<T>(origin: ChangeOrigin, fn: () => Promise<T>): Promise<T> {
  return storage.run(origin, fn);
}

export function currentOrigin(): ChangeOrigin | undefined {
  return storage.getStore();
}
