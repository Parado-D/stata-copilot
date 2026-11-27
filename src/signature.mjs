/**
 * Data fingerprints around a run.
 *
 * The point is not to detect every write (Stata cannot tell us that): it is to
 * make "this do-file changed N observations" a fact the agent can report
 * instead of a guess. The fingerprint comes from `datasignature`, so it is
 * computed by Stata and covers the data in memory, not the bytes on disk.
 */

import { EngineError } from './errors.mjs';
import { parseSignature, parseSortedBy } from './parsers/index.mjs';

/**
 * One line for the signature, one for the sort order. `sortedby` is printed
 * separately because a signature that matches can still hide a changed sort
 * order, and sort order silently changes what `_n` means.
 */
export const SIGNATURE_CODE = [
  'datasignature',
  'local __cpl_sorted : sortedby',
  'display "SORTEDBY=`__cpl_sorted\'"',
].join('\n');

/**
 * @param {{ execute: (req: object) => Promise<object> }} engine
 * @param {{cwd?: string, timeout?: number}} [options]
 */
export async function readSignature(engine, { cwd, timeout = 60 } = {}) {
  const result = await engine.execute({ code: SIGNATURE_CODE, cwd, timeout });
  const parsed = parseSignature(result.output);
  if (!parsed) {
    throw new EngineError('BAD_RESPONSE', 'datasignature printed no signature — is a dataset loaded?', {
      output: String(result.output ?? '').slice(-400),
    });
  }
  return { ...parsed, sortedby: parseSortedBy(result.output) };
}

/** True when the two fingerprints differ in data or shape (sort order excluded). */
export function signaturesDiffer(before, after) {
  if (!before || !after) return null;
  return (
    before.dataHashA !== after.dataHashA ||
    before.dataHashB !== after.dataHashB ||
    before.observations !== after.observations ||
    before.variables !== after.variables
  );
}
