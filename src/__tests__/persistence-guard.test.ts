import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Guardias del guardado, como en restaurant-service. Son revisiones por heurística: no sustituyen la verificación contra MySQL real
 * (`scripts/verify-projects.mjs`), la protegen de que alguien deshaga sin darse cuenta lo que la hace correcta.
 */
function leerCodigo(ruta: string): string {
  return readFileSync(ruta, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const codigo = leerCodigo(join(process.cwd(), 'src', 'infrastructure', 'persistence', 'repositories.ts'));

function cuerpo(metodo: string, desde = 0): string {
  const inicio = codigo.indexOf(`async ${metodo}(`, desde);
  expect(inicio, `no se encontró ${metodo}`).toBeGreaterThan(-1);
  const fin = codigo.indexOf('\n    async ', inicio + 10);
  return codigo.slice(inicio, fin === -1 ? undefined : fin);
}

describe('los repositorios guardan por clave primaria', () => {
  it('no usan `upsert`: el ON DUPLICATE KEY de MySQL reacciona a cualquier índice único y pisaría otra fila', () => {
    expect(/\.upsert\(/.test(codigo)).toBe(false);
  });
});

describe('las lecturas que deciden la versión son lecturas con bloqueo', () => {
  // Sin FOR UPDATE, dos personas que mueven la misma tarjeta leen la misma versión, ninguna recibe 409 y la segunda pisa a la
  // primera en silencio: exactamente lo que el control de versión existe para evitar.
  it.each([
    ['proyecto', codigo.indexOf('function projectRepository')],
    ['tarea', codigo.indexOf('function taskRepository')],
  ])('findByIdForUpdate de %s usa `lock: tx.LOCK.UPDATE`', (_nombre, desde) => {
    expect(/lock:\s*tx\.LOCK\.UPDATE/.test(cuerpo('findByIdForUpdate', desde))).toBe(true);
  });
});

describe('las escrituras del entregable 4 que pueden llegar repetidas a la vez', () => {
  // Encontrado con `verify-projects.mjs` contra MySQL: sin bloqueo, 20 «vincular» iguales daban 500 y 20 valores del mismo campo, 409.
  const casos = leerCodigo(join(process.cwd(), 'src', 'application', 'use-cases', 'organize-use-cases.ts'));
  it.each(['addLink', 'setFieldValue'])('%s bloquea la tarea antes de leer y escribir', (metodo) => {
    const inicio = casos.indexOf(`async ${metodo}(`);
    const fin = casos.indexOf('\n  async ', inicio + 10);
    expect(/loadTask\([^)]*forUpdate:\s*true/.test(casos.slice(inicio, fin === -1 ? undefined : fin))).toBe(true);
  });
  it('una etiqueta se crea con INSERT IGNORE (dos con el mismo nombre a la vez no chocan con el índice único)', () => {
    expect(/INSERT IGNORE INTO tags/.test(cuerpo('add', codigo.indexOf('function tagRepository')))).toBe(true);
  });
});
