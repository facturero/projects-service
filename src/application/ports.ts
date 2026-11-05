import type { Repositories } from '../domain/repositories.js';

/** Repositorios que comparten una transacción y saben cerrarla. */
export interface WriteUnitOfWork extends Repositories {
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

/** Abre unidades de trabajo de escritura: en producción, una transacción de Sequelize; en las pruebas, repos en memoria. */
export interface UnitOfWorkGateway {
  begin(): Promise<WriteUnitOfWork>;
  /**
   * ¿El error deshizo la transacción entera y se puede repetir tal cual? En MySQL, un deadlock: la base ya eligió a esta transacción
   * como víctima y la deshizo, así que repetirla no duplica nada.
   */
  isRetryable?(err: unknown): boolean;
}

/** Intentos ante un deadlock. Pasa en escrituras simultáneas sobre la misma fila nueva (dos «arrancar cronómetro» a la vez). */
const MAX_ATTEMPTS = 5;

/**
 * Ejecuta `fn` dentro de una transacción: confirma si termina y deshace si lanza. El cambio y su evento del outbox van juntos o
 * no va ninguno (ver `audit-coverage.test.ts`).
 */
export async function inTransaction<T>(gateway: UnitOfWorkGateway, fn: (uow: WriteUnitOfWork) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    const uow = await gateway.begin();
    try {
      const result = await fn(uow);
      await uow.commit();
      return result;
    } catch (err) {
      await uow.rollback();
      if (attempt >= MAX_ATTEMPTS || !gateway.isRetryable?.(err)) throw err;
      // Espera corta y al azar: si los dos que chocaron reintentan a la vez, vuelven a chocar.
      await new Promise((ok) => setTimeout(ok, 5 + Math.random() * 20 * attempt));
    }
  }
}

export type Clock = () => Date;
export type IdGenerator = () => string;
