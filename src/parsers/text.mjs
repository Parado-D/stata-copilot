/** Number parsing shared by every parser. Stata pads columns; trim first. */

const NUM = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;

/** A finite number, or null — never NaN and never a silent 0. */
export function toNumber(value) {
  const s = String(value ?? '').trim();
  if (!NUM.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
