/**
 * The `stata_model` Mata transcript → coefficients.
 *
 * Rows are `ROW|equation|name|b|se`; the header is `K=3 N=74 df_r=71`.
 * The row separator is `|` and Stata's `printf` never emits it inside a
 * variable name, so a plain split is enough.
 */

import { toNumber } from './text.mjs';

export function parseCoefficientRows(source) {
  const rows = [];
  for (const line of String(source ?? '').split(/\r?\n/)) {
    const m = line.match(/^\s*ROW\|([^|]*)\|([^|]*)\|\s*(\S+)\|\s*(\S+)\s*$/);
    if (!m) continue;
    const b = toNumber(m[3]);
    const se = toNumber(m[4]);
    if (b === null) continue;
    rows.push({ equation: m[1] || null, name: m[2], b, se });
  }
  return rows;
}

export function parseModelHeader(source) {
  const out = {};
  const m = String(source ?? '').match(/^\s*K=(\d+)\s+N=([-\d.e]+)\s+df_r=([-\d.e]+)\s*$/m);
  if (!m) return out;
  out.k = Number(m[1]);
  out.n = toNumber(m[2]);
  out.df_r = toNumber(m[3]);
  // Stata reports df_r = 0 for models with no residual df (robust/exact cases).
  if (out.df_r !== null && out.df_r <= 0) out.df_r = null;
  return out;
}
