/**
 * Orden fraccional (estilo LexoRank / fractional-indexing): cada tarjeta guarda un texto, y el orden de la columna es el orden
 * alfabético de esos textos. Mover una tarjeta entre otras dos cambia UNA fila —la suya—: se le da un texto que cae entre el de
 * sus vecinas. Renumerar la columna entera en cada arrastre bloquearía todas sus filas y haría chocar a dos personas que mueven
 * tarjetas distintas a la vez.
 *
 * Alfabeto `0-9a-z`: en MySQL la columna es `ascii_bin`, así que el orden de la base es el mismo que el de JavaScript. Un rango
 * nunca termina en `0`: si terminara, no habría ningún texto estrictamente menor con ese prefijo y no se podría insertar antes.
 *
 * Algoritmo de `fractional-indexing` (Rocicorp, dominio público en su forma básica), sin la parte entera.
 */
const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz';

export class RankError extends Error {}

function midpoint(a: string, b: string | null): string {
  if (b !== null && a >= b) throw new RankError(`rango fuera de orden: ${a} >= ${b}`);
  if (a.endsWith('0') || (b !== null && b.endsWith('0'))) throw new RankError('un rango no puede terminar en 0');
  if (b !== null) {
    // Prefijo común: el punto medio lo comparte.
    let n = 0;
    while ((a[n] ?? '0') === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const digitA = a ? DIGITS.indexOf(a[0]!) : 0;
  const digitB = b !== null ? DIGITS.indexOf(b[0]!) : DIGITS.length;
  if (digitB - digitA > 1) return DIGITS[Math.round(0.5 * (digitA + digitB))]!;
  // Dígitos consecutivos: si `b` es más largo, su primer dígito ya queda entre ambos; si no, se baja un nivel.
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return DIGITS[digitA]! + midpoint(a.slice(1), null);
}

const VALID = /^[0-9a-z]*[1-9a-z]$/;

export function isValidRank(rank: string): boolean {
  return VALID.test(rank);
}

/** Un rango estrictamente entre `before` y `after` (cualquiera de los dos puede faltar: principio o final de la lista). */
export function rankBetween(before: string | null, after: string | null): string {
  if (before !== null && !isValidRank(before)) throw new RankError(`rango inválido: ${before}`);
  if (after !== null && !isValidRank(after)) throw new RankError(`rango inválido: ${after}`);
  return midpoint(before ?? '', after);
}

/** `count` rangos crecientes después de `after` (para añadir varias tarjetas al final de una columna de una vez). */
export function ranksAfter(after: string | null, count: number): string[] {
  const out: string[] = [];
  let last = after;
  for (let i = 0; i < count; i++) {
    last = rankBetween(last, null);
    out.push(last);
  }
  return out;
}

/**
 * Por encima de este largo se reequilibra la lista. Insertar siempre en el mismo hueco (arrastrar cada tarjeta nueva al principio)
 * alarga el texto ~1 carácter cada 5 veces: mil arrastres al mismo sitio darían más de 255 y no cabrían en la columna.
 */
export const MAX_RANK_LENGTH = 32;

/**
 * `count` rangos cortos, crecientes y equidistantes: lo que se reparte al reequilibrar. Mismo ancho para todos (así el orden
 * alfabético es el numérico) y con hueco entre cada par para seguir insertando. Un rango que acabaría en `0` lleva un `1` detrás:
 * sigue entre sus vecinos porque el paso entre dos rangos es al menos 2.
 */
export function evenRanks(count: number): string[] {
  if (count <= 0) return [];
  let width = 1;
  while (36 ** width < 2 * (count + 1)) width++;
  const space = 36 ** width;
  const step = space / (count + 1);
  const out: string[] = [];
  for (let i = 1; i <= count; i++) {
    let key = Math.floor(i * step).toString(36).padStart(width, '0');
    if (key.endsWith('0')) key += '1';
    out.push(key);
  }
  return out;
}

/** Comparador por rango con desempate por id: dos movimientos simultáneos al mismo hueco pueden dar el mismo texto. */
export function byRank<T extends { rank: string; id?: string; taskId?: string }>(a: T, b: T): number {
  if (a.rank !== b.rank) return a.rank < b.rank ? -1 : 1;
  const ia = a.id ?? a.taskId ?? '';
  const ib = b.id ?? b.taskId ?? '';
  return ia < ib ? -1 : ia > ib ? 1 : 0;
}
