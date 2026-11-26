/**
 * Parsers for the text Stata prints into `output`.
 *
 * The engine returns a console transcript. Everything here turns that
 * transcript into structure an agent can reason about — macros from
 * `return list`, coefficient rows emitted by `stata_model`'s Mata block, and
 * per-variable profile rows. Each parser is tolerant: a change in Stata's
 * column padding must never make a tool throw.
 */

const NUM = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;

export function toNumber(value) {
  const s = String(value ?? '').trim();
  if (!NUM.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse `return list` / `ereturn list` / `sreturn list` / `creturn list`.
 * Stata prints one macro per line as `            r(N) =  74`, plus matrix
 * lines that carry no `= value` and are only reported by name.
 */
export function parseMacroList(text) {
  const macros = { r: {}, e: {}, s: {}, c: {}, matrices: [] };
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = line.match(/^\s*([resc])\(([^)]+)\)\s*=\s*(.*?)\s*$/);
    if (m) {
      const [, prefix, name, rawValue] = m;
      let value = rawValue;
      if (value.startsWith('"') && value.endsWith('"')) {
        macros[prefix][name] = value.slice(1, -1);
      } else {
        const n = toNumber(value);
        macros[prefix][name] = n === null ? value : n;
      }
      continue;
    }
    const mx = line.match(/^\s*([resc])\(([^)]+)\)\s*:\s*(.*)$/);
    if (mx) macros.matrices.push({ prefix: mx[1], name: mx[2], shape: mx[3] });
  }
  return macros;
}

/** Rows emitted by the Mata block in `stata_model`: ROW|eq|var|b|se */
export function parseCoefficientRows(text) {
  const rows = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = line.match(/^\s*ROW\|([^|]*)\|([^|]*)\|\s*(\S+)\|\s*(\S+)\s*$/);
    if (!m) continue;
    const b = toNumber(m[3]);
    const se = toNumber(m[4]);
    if (b === null) continue;
    rows.push({ equation: m[1] || null, name: m[2], b, se });
  }
  return rows;
}

/** Header emitted by the same Mata block: K=3 N=74 df_r=71 */
export function parseModelHeader(text) {
  const out = {};
  const m = String(text ?? '').match(/^\s*K=(\d+)\s+N=([-\d.e]+)\s+df_r=([-\d.e]+)\s*$/m);
  if (m) {
    out.k = Number(m[1]);
    out.n = toNumber(m[2]);
    out.df_r = toNumber(m[3]);
    if (out.df_r !== null && out.df_r <= 0) out.df_r = null;
  }
  return out;
}

/** `PROFILE|name|type|format|nmiss|label` rows from stata_profile_data. */
export function parseProfileRows(text) {
  const vars = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = line.match(/^\s*PROFILE\|([^|]*)\|([^|]*)\|([^|]*)\|\s*(\S*)\|\s*(.*)$/);
    if (!m) continue;
    vars.push({
      name: m[1],
      type: m[2],
      format: m[3],
      missing: toNumber(m[4]) ?? null,
      label: m[5].trim(),
    });
  }
  return vars;
}

/**
 * `describe` header facts.
 * Works for both `describe` and `describe, short`, whose header reads
 *   Contains data from  auto.dta
 *     Observations:            74
 *        Variables:            12
 */
export function parseDatasetHeader(text) {
  const t = String(text ?? '');
  return {
    source: t.match(/Contains data from\s+(.+?)\s*$/m)?.[1]?.trim() ?? null,
    observations: toNumber(t.match(/Observations:\s+([\d,]+)/)?.[1]?.replace(/,/g, '') ?? ''),
    variables: toNumber(t.match(/Variables:\s+(\d+)/)?.[1] ?? ''),
    size: t.match(/Size:\s+([\d,.]+[KM]?)/)?.[1] ?? null,
    label: t.match(/^\s*Label:\s*(.+?)\s*$/m)?.[1]?.trim() ?? null,
  };
}

/** Two-sided p from a normal approximation (Stata z), used when df_r is absent. */
export function normalTwoSidedP(z) {
  if (z === null || z === undefined || !Number.isFinite(z)) return null;
  return 2 * (1 - normalCdf(Math.abs(z)));
}

export function normalCdf(x) {
  // Abramowitz & Stegun 7.1.26 via erfc approximation.
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const pdf = Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
  const upper = poly * pdf;
  return x >= 0 ? 1 - upper : upper;
}

/** Two-sided p from Student's t, via the incomplete beta approximation. */
export function studentTwoSidedP(t, df) {
  if (t === null || !Number.isFinite(t)) return null;
  if (!df || df <= 0 || !Number.isFinite(df)) return normalTwoSidedP(t);
  const x = df / (df + t * t);
  return betai(df / 2, 0.5, x);
}

function gammaln(x) {
  const cof = [76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (const c of cof) ser += c / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

function betacf(a, b, x) {
  const MAXIT = 200;
  const EPS = 3e-12;
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** Regularised incomplete beta I_x(a,b) — the two-sided t tail. */
function betai(a, b, x) {
  if (x <= 0) return 1;
  if (x >= 1) return 0;
  const bt = Math.exp(
    gammaln(a + b) - gammaln(a) - gammaln(b) + a * Math.log(x) + b * Math.log(1 - x),
  );
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
}
