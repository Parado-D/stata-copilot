/**
 * A small JSON-Schema subset used to validate tool arguments *before* a tool
 * handler runs.
 *
 * Why not a real validator: the server is dependency-free on purpose, and the
 * subset below is exactly what tool schemas in this project use — object root,
 * typed properties, required, enum, numeric bounds, array items and
 * `additionalProperties: false`. A schema that uses something outside the
 * subset throws at registry build time (TOOL_DEFINITION), so the subset cannot
 * silently rot.
 */

const TYPES = new Set(['object', 'string', 'number', 'integer', 'boolean', 'array']);

export const SCHEMA_KEYWORDS = new Set([
  'type', 'properties', 'required', 'additionalProperties', 'description',
  'enum', 'default', 'minimum', 'maximum', 'minLength', 'maxLength',
  'items', 'minItems', 'maxItems',
]);

/** Throw if the schema itself is malformed — called once when the registry is built. */
export function assertSchema(schema, where = 'schema') {
  if (!schema || typeof schema !== 'object') throw new Error(`${where}: schema must be an object`);
  for (const key of Object.keys(schema)) {
    if (!SCHEMA_KEYWORDS.has(key)) throw new Error(`${where}: unsupported schema keyword "${key}"`);
  }
  if (schema.type !== undefined && !TYPES.has(schema.type)) {
    throw new Error(`${where}: unsupported type "${schema.type}"`);
  }
  if (schema.type === 'object') {
    for (const [name, sub] of Object.entries(schema.properties ?? {})) {
      assertSchema({ ...sub, type: sub?.type ?? 'string' }, `${where}.${name}`);
    }
    for (const name of schema.required ?? []) {
      if (!schema.properties?.[name]) throw new Error(`${where}: required "${name}" is not a declared property`);
    }
  }
  if (schema.type === 'array' && schema.items) assertSchema(schema.items, `${where}[]`);
}

/**
 * @returns {string[]} human-readable problems; empty means valid
 */
export function validateArgs(schema, args, where = 'arguments') {
  const errors = [];
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return [`${where}: expected an object`];
  }
  const { properties = {}, required = [], additionalProperties = true } = schema ?? {};

  for (const name of required) {
    if (args[name] === undefined) errors.push(`${where}.${name}: required`);
  }
  if (additionalProperties === false) {
    for (const name of Object.keys(args)) {
      if (!properties[name]) errors.push(`${where}.${name}: unknown property`);
    }
  }
  for (const [name, sub] of Object.entries(properties)) {
    if (args[name] === undefined) continue;
    errors.push(...validateValue(sub, args[name], `${where}.${name}`));
  }
  return errors;
}

function validateValue(schema, value, where) {
  const errors = [];
  const { type } = schema;
  if (type === 'string' && typeof value !== 'string') errors.push(`${where}: expected string`);
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${where}: must be at least ${schema.minLength} characters`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${where}: must be at most ${schema.maxLength} characters`);
    }
  }
  if (type === 'boolean' && typeof value !== 'boolean') errors.push(`${where}: expected boolean`);
  if (type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) {
    errors.push(`${where}: expected number`);
  }
  if (type === 'integer' && !Number.isInteger(value)) errors.push(`${where}: expected integer`);
  if (type === 'array') {
    if (!Array.isArray(value)) {
      errors.push(`${where}: expected array`);
    } else {
      if (schema.minItems !== undefined && value.length < schema.minItems) {
        errors.push(`${where}: expected at least ${schema.minItems} items`);
      }
      if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        errors.push(`${where}: expected at most ${schema.maxItems} items`);
      }
      if (schema.items) {
        value.forEach((item, i) => errors.push(...validateValue(schema.items, item, `${where}[${i}]`)));
      }
    }
  }
  if (type === 'object' && (value === null || typeof value !== 'object' || Array.isArray(value))) {
    errors.push(`${where}: expected object`);
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${where}: expected one of ${schema.enum.join('|')}`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${where}: must be >= ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${where}: must be <= ${schema.maximum}`);
    }
  }
  return errors;
}
