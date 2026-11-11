import type { RichDoc } from './types.js';

/**
 * Texto enriquecido de descripciones y comentarios: un documento de TipTap (ProseMirror en JSON).
 *
 * El navegador lo arma, pero el servidor NO se fía: lo recorre y solo acepta una lista blanca de nodos, marcas y atributos. Así un
 * cliente modificado no puede colar HTML, `javascript:` en un enlace, atributos de estilo ni un documento gigante. De paso saca el
 * texto plano (para buscar y para los avisos) y las @menciones (para avisar a esas personas y hacerlas seguidoras).
 *
 * Lo que no está aquí se rechaza con un error de validación, no se limpia en silencio: si el editor del frontend produjera algo
 * fuera de la lista, es mejor enterarse que perder contenido sin que nadie lo note.
 */
export class RichTextError extends Error {}

const BLOCKS = new Set(['doc', 'paragraph', 'bulletList', 'orderedList', 'listItem', 'blockquote', 'codeBlock', 'table', 'tableRow', 'tableHeader', 'tableCell', 'image']);
/** Celdas de tabla: solo su tamaño (cuántas columnas/filas ocupa y el ancho que dejó la persona), en números acotados. */
const CELLS = new Set(['tableHeader', 'tableCell']);
const MAX_SPAN = 20;
const INLINE = new Set(['text', 'hardBreak', 'mention']);
const MARKS = new Set(['bold', 'italic', 'strike', 'code', 'link']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_LINK = /^(https?:\/\/|mailto:)/i;

export const MAX_DOC_CHARS = 20_000;
const MAX_NODES = 5_000;
const MAX_DEPTH = 12;

export interface ParsedRichText {
  doc: RichDoc;
  text: string;
  mentions: string[];
}

type Node = { type?: unknown; text?: unknown; attrs?: unknown; marks?: unknown; content?: unknown };

/** Valida y normaliza el documento. Devuelve una COPIA limpia (sin claves que no conocemos), su texto y sus menciones. */
export function parseRichText(input: unknown): ParsedRichText {
  let nodes = 0;
  let chars = 0;
  const mentions: string[] = [];
  const lines: string[] = [];
  let line = '';
  let inCell = 0;

  const flush = () => {
    lines.push(line);
    line = '';
  };

  function walk(raw: unknown, depth: number): Record<string, unknown> {
    if (depth > MAX_DEPTH) throw new RichTextError('El texto está demasiado anidado.');
    if (++nodes > MAX_NODES) throw new RichTextError('El texto es demasiado largo.');
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new RichTextError('Formato de texto inválido.');
    const node = raw as Node;
    const type = node.type;
    if (typeof type !== 'string' || (!BLOCKS.has(type) && !INLINE.has(type))) throw new RichTextError(`Elemento no permitido: ${String(type)}`);

    const out: Record<string, unknown> = { type };

    if (type === 'text') {
      if (typeof node.text !== 'string' || node.text.length === 0) throw new RichTextError('Texto vacío.');
      chars += node.text.length;
      if (chars > MAX_DOC_CHARS) throw new RichTextError(`Máximo ${MAX_DOC_CHARS} caracteres.`);
      out.text = node.text;
      line += node.text;
      if (node.marks !== undefined) out.marks = walkMarks(node.marks);
      return out;
    }

    if (type === 'hardBreak') {
      flush();
      return out;
    }

    if (type === 'mention') {
      const attrs = (node.attrs ?? {}) as { id?: unknown; label?: unknown };
      if (typeof attrs.id !== 'string' || !UUID.test(attrs.id)) throw new RichTextError('Mención inválida.');
      const label = typeof attrs.label === 'string' ? attrs.label.slice(0, 120) : '';
      out.attrs = { id: attrs.id.toLowerCase(), label };
      if (!mentions.includes(attrs.id.toLowerCase())) mentions.push(attrs.id.toLowerCase());
      line += `@${label}`;
      return out;
    }

    if (type === 'image') {
      // La imagen guarda el id del archivo en document-service, NO su URL: la URL firmada caduca en una hora y el navegador pide una
      // nueva con la sesión al mostrarla (así, además, una imagen de otra empresa no se ve aunque alguien copie el documento).
      const attrs = (node.attrs ?? {}) as { documentId?: unknown; alt?: unknown };
      if (typeof attrs.documentId !== 'string' || !UUID.test(attrs.documentId)) throw new RichTextError('Imagen inválida.');
      out.attrs = { documentId: attrs.documentId.toLowerCase(), alt: typeof attrs.alt === 'string' ? attrs.alt.slice(0, 200) : '' };
      return out;
    }

    if (CELLS.has(type) && node.attrs !== undefined) {
      const attrs = node.attrs as { colspan?: unknown; rowspan?: unknown; colwidth?: unknown };
      const span = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= MAX_SPAN ? v : 1);
      const widths = Array.isArray(attrs.colwidth) && attrs.colwidth.every((w) => typeof w === 'number' && Number.isInteger(w) && w > 0 && w <= 2000)
        ? (attrs.colwidth as number[]).slice(0, MAX_SPAN)
        : null;
      out.attrs = { colspan: span(attrs.colspan), rowspan: span(attrs.rowspan), colwidth: widths };
    }

    if (type === 'orderedList' && node.attrs !== undefined) {
      const start = (node.attrs as { start?: unknown }).start;
      if (typeof start === 'number' && Number.isInteger(start) && start > 0 && start < 10_000) out.attrs = { start };
    }

    if (node.content !== undefined) {
      if (!Array.isArray(node.content)) throw new RichTextError('Formato de texto inválido.');
      if (CELLS.has(type)) inCell += 1;
      out.content = node.content.map((child) => walk(child, depth + 1));
      if (CELLS.has(type)) inCell -= 1;
    }
    // Cada fila de una tabla es una línea del texto plano (búsqueda y avisos), con sus celdas separadas por tabuladores.
    if (type === 'paragraph' || type === 'codeBlock') {
      if (inCell > 0) line += '\t';
      else flush();
    }
    if (type === 'tableRow') {
      line = line.replace(/\t+$/, '');
      flush();
    }
    return out;
  }

  function walkMarks(raw: unknown): Array<Record<string, unknown>> {
    if (!Array.isArray(raw)) throw new RichTextError('Formato de texto inválido.');
    return raw.map((m) => {
      const mark = m as { type?: unknown; attrs?: unknown };
      if (typeof mark.type !== 'string' || !MARKS.has(mark.type)) throw new RichTextError(`Formato no permitido: ${String(mark.type)}`);
      if (mark.type !== 'link') return { type: mark.type };
      const href = (mark.attrs as { href?: unknown } | undefined)?.href;
      if (typeof href !== 'string' || !SAFE_LINK.test(href) || href.length > 2000) throw new RichTextError('Enlace no permitido.');
      return { type: 'link', attrs: { href } };
    });
  }

  const doc = walk(input, 0);
  if (doc.type !== 'doc') throw new RichTextError('El texto debe ser un documento.');
  if (line) flush();
  const text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { doc, text, mentions };
}

/** Documento de un solo párrafo a partir de texto plano (descripciones del entregable 1, que eran texto). */
export function docFromText(text: string): RichDoc {
  const paragraphs = text.split(/\n/).map((p) => (p ? { type: 'paragraph', content: [{ type: 'text', text: p }] } : { type: 'paragraph' }));
  return { type: 'doc', content: paragraphs };
}
