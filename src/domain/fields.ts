import { ValidationError } from './errors.js';
import { type CustomField, type FieldOption, type FieldValue, PROJECT_COLORS, type ProjectColor } from './types.js';

/**
 * Reglas de los campos personalizados. El valor viaja como JSON genérico y aquí se comprueba contra el TIPO del campo, para que
 * una lista no guarde una opción inexistente ni un número llegue como texto. `null` borra el valor.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const MAX_FIELDS_PER_PROJECT = 30;
export const MAX_OPTIONS = 50;

const fail = (message: string): never => {
  throw new ValidationError([{ field: 'value', message }]);
};

export function validateFieldValue(field: CustomField, raw: unknown): FieldValue | null {
  if (raw === null || raw === undefined || raw === '') return null;
  switch (field.type) {
    case 'text':
      if (typeof raw !== 'string') return fail('Debe ser texto.');
      if (raw.length > 500) return fail('Máximo 500 caracteres.');
      return raw.trim() || null;
    case 'number': {
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.replace(',', '.')) : NaN;
      if (!Number.isFinite(n) || Math.abs(n) > 1e12) return fail('Debe ser un número.');
      return n;
    }
    case 'date':
      if (typeof raw !== 'string' || !DATE.test(raw) || Number.isNaN(Date.parse(`${raw}T00:00:00Z`))) return fail('Fecha inválida (AAAA-MM-DD).');
      return raw;
    case 'person':
      if (typeof raw !== 'string' || !UUID.test(raw)) return fail('Persona inválida.');
      return raw.toLowerCase();
    case 'select':
      if (typeof raw !== 'string' || !field.options.some((o) => o.id === raw)) return fail('Esa opción no existe en el campo.');
      return raw;
  }
}

/**
 * Normaliza las opciones de una lista: etiquetas recortadas, sin repetidas (sin distinguir mayúsculas), color del tema. Las que
 * ya tenían id lo conservan; las nuevas reciben uno (`newId`). Así renombrar una opción no cambia el valor de las tareas.
 */
export function normalizeOptions(raw: Array<{ id?: string | null; label: string; color?: string | null }>, newId: () => string): FieldOption[] {
  if (raw.length > MAX_OPTIONS) throw new ValidationError([{ field: 'options', message: `Máximo ${MAX_OPTIONS} opciones.` }]);
  const seen = new Set<string>();
  return raw.map((o) => {
    const label = o.label.trim();
    if (!label || label.length > 60) throw new ValidationError([{ field: 'options', message: 'Cada opción necesita un nombre de hasta 60 caracteres.' }]);
    const key = label.toLocaleLowerCase('es');
    if (seen.has(key)) throw new ValidationError([{ field: 'options', message: `La opción «${label}» está repetida.` }]);
    seen.add(key);
    const color = (PROJECT_COLORS as readonly string[]).includes(o.color ?? '') ? (o.color as ProjectColor) : 'primary';
    return { id: o.id && UUID.test(o.id) ? o.id : newId(), label, color };
  });
}
