import { describe, expect, it } from 'vitest';
import { parseRichText, RichTextError } from '../domain/richtext.js';

const ANA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const p = (...content: unknown[]) => ({ type: 'paragraph', content });
const doc = (...content: unknown[]) => ({ type: 'doc', content });

describe('texto enriquecido (lista blanca)', () => {
  it('acepta lo que produce el editor: párrafos, listas, negrita, enlaces y menciones; saca texto y menciones', () => {
    const out = parseRichText(
      doc(
        p({ type: 'text', text: 'Hola ' }, { type: 'mention', attrs: { id: ANA, label: 'Ana' } }, { type: 'text', text: ', revisa', marks: [{ type: 'bold' }] }),
        { type: 'bulletList', content: [{ type: 'listItem', content: [p({ type: 'text', text: 'la portada', marks: [{ type: 'link', attrs: { href: 'https://x.ec' } }] })] }] },
      ),
    );
    expect(out.mentions).toEqual([ANA]);
    expect(out.text).toBe('Hola @Ana, revisa\nla portada');
  });

  it('descarta claves desconocidas (estilos, clases) en vez de guardarlas', () => {
    const out = parseRichText(doc({ type: 'paragraph', attrs: { style: 'color:red' }, content: [{ type: 'text', text: 'x', extra: 1 }] }));
    expect(out.doc).toEqual(doc(p({ type: 'text', text: 'x' })));
  });

  it.each([
    ['un nodo que el editor no produce (imagen, HTML)', doc({ type: 'image', attrs: { src: 'x' } })],
    ['un enlace javascript:', doc(p({ type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] }))],
    ['una marca no permitida', doc(p({ type: 'text', text: 'x', marks: [{ type: 'textStyle' }] }))],
    ['una mención con un id que no es uuid', doc(p({ type: 'mention', attrs: { id: '1 OR 1=1' } }))],
    ['algo que no es un documento', p({ type: 'text', text: 'x' })],
    ['un texto gigante', doc(p({ type: 'text', text: 'x'.repeat(20_001) }))],
  ])('rechaza %s', (_n, input) => {
    expect(() => parseRichText(input)).toThrow(RichTextError);
  });

  it('una misma persona mencionada dos veces cuenta una sola vez', () => {
    const m = { type: 'mention', attrs: { id: ANA, label: 'Ana' } };
    expect(parseRichText(doc(p(m, { type: 'text', text: ' y ' }, m))).mentions).toEqual([ANA]);
  });
});
