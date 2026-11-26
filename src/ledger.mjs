/**
 * The run ledger — the reproducibility trail.
 *
 * Every execution appends one row to `<cwd>/.stata-copilot/runs.jsonl`. The
 * JSONL file is the artefact a replication package can ship; the in-memory
 * ring buffer is what `stata_history` answers from without touching disk.
 *
 * Writing is best-effort: a read-only project directory must never make an
 * analysis fail, so persistence errors are swallowed (and logged at debug).
 */

import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

export class Ledger {
  constructor({ limit = 200 } = {}) {
    this.entries = [];
    this.limit = limit;
  }

  /**
   * @param {object} entry  tool, ok, returnCode, ms, code, graphs…
   * @param {{cwd?: string, persist?: boolean}} options
   */
  async record(entry, { cwd, persist = true } = {}) {
    const row = { at: new Date().toISOString(), ...entry };
    this.entries.push(row);
    if (this.entries.length > this.limit) this.entries.shift();
    if (persist && cwd) {
      try {
        const dir = path.join(cwd, '.stata-copilot');
        await mkdir(dir, { recursive: true });
        await appendFile(path.join(dir, 'runs.jsonl'), JSON.stringify(row) + '\n', 'utf8');
      } catch {
        /* a convenience, never a reason to fail an analysis */
      }
    }
    return row;
  }

  /** The newest `n` rows, oldest first. */
  tail(n = 20) {
    return this.entries.slice(-Math.max(1, n));
  }
}
