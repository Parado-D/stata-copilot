/**
 * Tail probabilities, so `stata_model` can return a p-value the agent does not
 * have to look up in a table.
 *
 * Stata's `regress` uses Student's t with `e(df_r)`; commands that report z
 * (probit, logit, most GMM) leave `e(df_r)` empty. The t tail is computed from
 * the regularised incomplete beta function (Numerical Recipes, continued
 * fraction), which is accurate to ~1e-10 over the range that matters here.
 */

/** Standard normal CDF (Abramowitz & Stegun 7.1.26). */
export function normalCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const pdf = Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
  const upper = poly * pdf;
  return x >= 0 ? 1 - upper : upper;
}

/** Two-sided p from a z statistic. */
export function normalTwoSidedP(z) {
  if (z === null || z === undefined || !Number.isFinite(z)) return null;
  return 2 * (1 - normalCdf(Math.abs(z)));
}

/** Two-sided p from Student's t; falls back to the normal when df is unusable. */
export function studentTwoSidedP(t, df) {
  if (t === null || !Number.isFinite(t)) return null;
  if (!df || df <= 0 || !Number.isFinite(df)) return normalTwoSidedP(t);
  return betai(df / 2, 0.5, df / (df + t * t));
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

/** Regularised incomplete beta I_x(a,b). */
function betai(a, b, x) {
  if (x <= 0) return 1;
  if (x >= 1) return 0;
  const bt = Math.exp(
    gammaln(a + b) - gammaln(a) - gammaln(b) + a * Math.log(x) + b * Math.log(1 - x),
  );
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
}
