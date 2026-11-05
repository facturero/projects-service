import { describe, expect, it } from 'vitest';
import { evenRanks, isValidRank, MAX_RANK_LENGTH, rankBetween, RankError, ranksAfter } from '../domain/rank.js';

describe('orden fraccional', () => {
  it('siempre cae estrictamente entre sus vecinas', () => {
    const a = rankBetween(null, null);
    const b = rankBetween(a, null);
    const mid = rankBetween(a, b);
    expect(a < mid && mid < b).toBe(true);
    const first = rankBetween(null, a);
    expect(first < a).toBe(true);
  });

  it('aguanta mil inserciones seguidas en el mismo hueco sin repetir ni desordenar (el caso de arrastrar siempre al principio)', () => {
    const ranks: string[] = [rankBetween(null, null)];
    for (let i = 0; i < 1000; i++) ranks.unshift(rankBetween(null, ranks[0]!));
    for (let i = 0; i < 1000; i++) ranks.splice(1, 0, rankBetween(ranks[0]!, ranks[1]!));
    expect(new Set(ranks).size).toBe(ranks.length);
    expect([...ranks].sort()).toEqual(ranks);
    expect(ranks.every(isValidRank)).toBe(true);
    // Pero crece: por eso los casos de uso reequilibran al pasar de MAX_RANK_LENGTH (ver tasks.test.ts).
    expect(Math.max(...ranks.map((r) => r.length))).toBeGreaterThan(MAX_RANK_LENGTH);
  });

  it('reequilibrar da rangos cortos, válidos, crecientes y con hueco entre cada par', () => {
    for (const n of [1, 2, 35, 36, 500, 5000]) {
      const even = evenRanks(n);
      expect(even).toHaveLength(n);
      expect([...even].sort()).toEqual(even);
      expect(new Set(even).size).toBe(n);
      expect(even.every(isValidRank)).toBe(true);
      expect(Math.max(...even.map((r) => r.length))).toBeLessThanOrEqual(5);
      for (let i = 1; i < n; i++) expect(rankBetween(even[i - 1]!, even[i]!)).toBeTruthy();
    }
  });

  it('una propiedad al azar: 2000 inserciones en posiciones aleatorias mantienen el orden', () => {
    let seed = 42;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const ranks: string[] = [];
    for (let i = 0; i < 2000; i++) {
      const at = Math.floor(rnd() * (ranks.length + 1));
      ranks.splice(at, 0, rankBetween(ranks[at - 1] ?? null, ranks[at] ?? null));
    }
    expect([...ranks].sort()).toEqual(ranks);
    expect(new Set(ranks).size).toBe(ranks.length);
  });

  it('el orden de JavaScript es el de la base (ascii_bin): solo 0-9a-z y nunca termina en 0', () => {
    for (const r of ranksAfter(null, 500)) expect(r).toMatch(/^[0-9a-z]*[1-9a-z]$/);
  });

  it('rechaza vecinas fuera de orden o inválidas', () => {
    expect(() => rankBetween('b', 'a')).toThrow(RankError);
    expect(() => rankBetween('a0', null)).toThrow(RankError);
    expect(() => rankBetween('A', null)).toThrow(RankError);
  });
});
