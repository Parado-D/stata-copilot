/**
 * The `stata_model` Mata transcript → coefficients.
 *
 * Rows are `ROW|equation|name|b|se|lo|hi`; the header is `K=3 N=74 df_r=71 crit=1.99346`.
 * The row separator is `|` and Stata's `printf` never emits it inside a
 * variable name, so a plain split is enough. The interval columns are optional
 * so a transcript written by an older build (or by a test stub) still parses.
 */

import { toNumber } from './text.mjs';

/**
 * `st_matrixcolstripe("e(b)")` names a coefficient omitted for collinearity
 * `o.weight`; the `o.` prefix is the only place that information survives in
 * e(b), because `e(omit)` is not created by regress.
 */
export function isOmittedName(name) {
  return typeof name === 'string' && name.startsWith('o.');
}

export function parseCoefficientRows(source) {
  const rows = [];
  for (const line of String(source ?? '').split(/\r?\n/)) {
    const m = line.match(
      /^\s*ROW\|([^|]*)\|([^|]*)\|\s*(\S+)\|\s*(\S+)(?:\|\s*(\S+)\|\s*(\S+))?\s*$/,
    );
    if (!m) continue;
    const b = toNumber(m[3]);
    const se = toNumber(m[4]);
    if (b === null) continue;
    const name = m[2];
    rows.push({
      equation: m[1] || null,
      name,
      term: isOmittedName(name) ? name.slice(2) : name,
      omitted: isOmittedName(name),
      b,
      se,
      ciLo: toNumber(m[5]),
      ciHi: toNumber(m[6]),
    });
  }
  return rows;
}

export function parseModelHeader(source) {
  const out = {};
  const m = String(source ?? '').match(
    /^\s*K=(\d+)\s+N=([-\d.e]+)\s+df_r=([-\d.e]+)(?:\s+crit=\s*([-\d.e]+))?\s*$/m,
  );
  if (!m) return out;
  out.k = Number(m[1]);
  out.n = toNumber(m[2]);
  out.df_r = toNumber(m[3]);
  out.crit = toNumber(m[4]);
  // Stata reports df_r = 0 for models with no residual df (robust/exact cases).
  if (out.df_r !== null && out.df_r <= 0) out.df_r = null;
  return out;
}
