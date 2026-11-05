import { describe, expect, it } from 'vitest';
import { inTransaction, type UnitOfWorkGateway, type WriteUnitOfWork } from '../application/ports.js';

/**
 * Lo encontró `verify-projects.mjs` (sección 10) contra MySQL: 20 «arrancar cronómetro» y 5 capacidades a la vez acababan en
 * deadlock. MySQL deshace a la víctima entera, así que repetirla es seguro; lo que no se repite es cualquier otro error.
 */
function gateway(failures: unknown[], retryable: (err: unknown) => boolean): UnitOfWorkGateway & { begun: number; committed: number } {
  const g = {
    begun: 0,
    committed: 0,
    async begin() {
      g.begun += 1;
      return { commit: async () => void (g.committed += 1), rollback: async () => {} } as unknown as WriteUnitOfWork;
    },
    isRetryable: retryable,
  };
  return g;
}

const deadlock = Object.assign(new Error('Deadlock found'), { parent: { code: 'ER_LOCK_DEADLOCK', errno: 1213 } });
const isDeadlock = (err: unknown) => (err as typeof deadlock).parent?.errno === 1213;

describe('inTransaction ante un deadlock', () => {
  it('repite la transacción entera y confirma una sola vez', async () => {
    const g = gateway([], isDeadlock);
    let calls = 0;
    const out = await inTransaction(g, async () => {
      calls += 1;
      if (calls < 3) throw deadlock;
      return 'hecho';
    });
    expect(out).toBe('hecho');
    expect(g.begun).toBe(3);
    expect(g.committed).toBe(1);
  });

  it('no repite otros errores, y se rinde tras 5 intentos', async () => {
    const g = gateway([], isDeadlock);
    await expect(inTransaction(g, async () => Promise.reject(new Error('otra cosa')))).rejects.toThrow('otra cosa');
    expect(g.begun).toBe(1);
    const g2 = gateway([], isDeadlock);
    await expect(inTransaction(g2, async () => Promise.reject(deadlock))).rejects.toBe(deadlock);
    expect(g2.begun).toBe(5);
  });
});
