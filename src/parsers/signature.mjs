/**
 * `datasignature` output is the cheapest way to answer "did anything change the
 * data?" (Stata tip 35). The command prints something like
 *
 *     74:13(101019):2537987732:2244255684
 *
 *     obs : vars (vars hash) : two data hashes
 *
 * The hashes depend only on the data, so the same dataset saved and loaded
 * again produces the same signature — which is what makes a before/after
 * comparison meaningful.
 */

const SIGNATURE = /(\d+):(\d+)\((\d+)\):(\d+):(\d+)/;
const SORTED_BY = /^\s*SORTEDBY=(.*)$/m;

export function parseSignature(source) {
  const text = String(source ?? '');
  const match = text.match(SIGNATURE);
  if (!match) return null;
  return {
    signature: match[0],
    observations: Number(match[1]),
    variables: Number(match[2]),
    variablesHash: Number(match[3]),
    dataHashA: Number(match[4]),
    dataHashB: Number(match[5]),
  };
}

/** `local s : sortedby` prints nothing when the data are unsorted. */
export function parseSortedBy(source) {
  const match = String(source ?? '').match(SORTED_BY);
  if (!match) return null;
  const value = match[1].trim();
  return value.length > 0 ? value : null;
}
