/**
 * The execution core shared by every tool that runs Stata.
 *
 * One Session owns: the engine, the resolved policy mode, the working-directory
 * allow-list, the ledger, and the state tools read back (last graphs). It is
 * constructed once per server and passed to tool handlers as `ctx.session`, so
 * a new tool gets the policy and the ledger for free instead of re-deriving
 * them — the main extensibility win of this layout.
 */

import { EngineError } from './errors.mjs';
import { Ledger } from './ledger.mjs';
import { MODES, checkCwd, checkPolicy } from './policy.mjs';
import { truncate } from './lib/content.mjs';

/** Stricter modes may be requested per call; looser ones are ignored. */
const STRICTNESS = { open: 0, guarded: 1, readonly: 2 };

export class Session {
  constructor({
    engine,
    mode = 'guarded',
    roots = [],
    defaultTimeout = 120,
    maxOutputChars = 20_000,
    persistLedger = true,
    ledger = new Ledger(),
  }) {
    this.engine = engine;
    this.mode = MODES.includes(mode) ? mode : 'guarded';
    this.roots = roots;
    this.defaultTimeout = defaultTimeout;
    this.maxOutputChars = maxOutputChars;
    this.persistLedger = persistLedger;
    this.ledger = ledger;
    this.state = { lastGraphs: [], lastRun: null };
  }

  /** A call may tighten the configured mode, never loosen it. */
  resolveMode(requested) {
    if (!requested || !MODES.includes(requested)) return this.mode;
    return STRICTNESS[requested] >= STRICTNESS[this.mode] ? requested : this.mode;
  }

  /** Refuse before Stata sees the code. */
  gate(code, { cwd, requestedMode } = {}) {
    const mode = this.resolveMode(requestedMode);
    const verdict = checkPolicy(code, { mode });
    const cwdVerdict = checkCwd(cwd, this.roots);
    if (!verdict.allowed || !cwdVerdict.allowed) {
      const reasons = [
        ...verdict.blocked.map((b) => `[${b.rule}] ${b.why} (command: \`${b.text}\`)`),
        ...(cwdVerdict.allowed ? [] : [cwdVerdict.why]),
      ];
      throw new EngineError('POLICY_BLOCKED', `Blocked by policy (${mode}): ${reasons.join(' ')}`, {
        mode,
        blocked: verdict.blocked,
        cwd: cwdVerdict,
      });
    }
    return verdict;
  }

  /**
   * Gate → execute → truncate → record. Every run tool returns this payload,
   * so the contract an agent codes against is defined exactly once.
   */
  async run({ tool, code, cwd, timeout, requestedMode }) {
    const verdict = this.gate(code, { cwd, requestedMode });
    const started = Date.now();
    let result;
    try {
      result = await this.engine.execute({ code, cwd, timeout: timeout ?? this.defaultTimeout });
    } catch (err) {
      await this.ledger.record(
        {
          tool,
          ok: false,
          error: err?.message ?? String(err),
          code: truncate(code, 400).value,
          cwd: cwd ?? null,
          ms: Date.now() - started,
        },
        { cwd, persist: this.persistLedger },
      );
      throw err;
    }
    const elapsedMs = Date.now() - started;
    this.state.lastGraphs = result.graphs;
    this.state.lastRun = { tool, at: new Date().toISOString(), success: result.success };
    const out = truncate(result.output, this.maxOutputChars);
    await this.ledger.record(
      {
        tool,
        ok: result.success,
        returnCode: result.returnCode,
        ms: elapsedMs,
        cwd: cwd ?? null,
        code: truncate(code, 400).value,
        graphs: result.graphs.length,
      },
      { cwd, persist: this.persistLedger },
    );
    return {
      success: result.success,
      returnCode: result.returnCode,
      output: out.value,
      outputTruncated: out.truncated,
      error: result.error || null,
      elapsedMs,
      graphs: result.graphs.map((g) => ({
        name: g.name ?? null,
        png: g.png ?? g.file ?? null,
        svg: g.svg ?? null,
        format: g.format ?? (g.png ? 'png' : 'svg'),
      })),
      policy: { mode: verdict.mode, warnings: verdict.warnings },
    };
  }
}
