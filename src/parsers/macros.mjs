/**
 * `return list` / `ereturn list` / `sreturn list` / `creturn list` → objects.
 *
 * Stata prints one macro per line as `            r(N) =  74`; postestimation
 * matrices print as `e(b) :  1 x 3` with no value, so they are reported by
 * name and shape rather than silently dropped.
 */

import { toNumber } from './text.mjs';

export function parseMacroList(source) {
  const macros = { r: {}, e: {}, s: {}, c: {}, matrices: [] };
  for (const line of String(source ?? '').split(/\r?\n/)) {
    const kv = line.match(/^\s*([resc])\(([^)]+)\)\s*=\s*(.*?)\s*$/);
    if (kv) {
      const [, prefix, name, raw] = kv;
      let value = raw;
      if (value.startsWith('"') && value.endsWith('"')) {
        macros[prefix][name] = value.slice(1, -1);
      } else {
        const n = toNumber(value);
        macros[prefix][name] = n === null ? value : n;
      }
      continue;
    }
    const matrix = line.match(/^\s*([resc])\(([^)]+)\)\s*:\s*(.*)$/);
    if (matrix) macros.matrices.push({ prefix: matrix[1], name: matrix[2], shape: matrix[3] });
  }
  return macros;
}
