/**
 * pystata engine: the Stata session lives in this process tree, not in a
 * third-party service.
 *
 * A long-lived Python child (bridge/stata_bridge.py) loads Stata's own embedded
 * engine (`mp-64.dll` through `pystata`), so:
 *
 *   - the session (data, estimates, macros) survives between tool calls;
 *   - `break` is real: the bridge calls the DLL's `StataSO_SetBreak` from the
 *     stdin thread while the worker thread is still inside Stata;
 *   - there is no HTTP layer to time out at 300 s and no second product to
 *     install.
 *
 * Protocol: JSON lines over stdin/stdout, one object per line, replies keyed by
 * an incrementing `id`. stderr is diagnostics only.
 *
 * Options:
 *   python     Python 3 that can import `pystata` (default: `python` on PATH)
 *   stataHome  Stata installation root, e.g. "D:/" (default: STATA_COPILOT_STATA_HOME)
 *   edition    "mp" | "se" | "be" (default: STATA_COPILOT_EDITION or "mp")
 *   bridge     path to stata_bridge.py (default: <repo>/bridge/stata_bridge.py)
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

import { EngineError } from '../errors.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
export const DEFAULT_BRIDGE = join(REPO_ROOT, 'bridge', 'stata_bridge.py');

export class PystataEngine {
  constructor({
    python = process.env.STATA_COPILOT_PYTHON ?? 'python',
    stataHome = process.env.STATA_COPILOT_STATA_HOME ?? null,
    edition = process.env.STATA_COPILOT_EDITION ?? 'mp',
    bridge = process.env.STATA_COPILOT_BRIDGE ?? DEFAULT_BRIDGE,
    startupTimeoutMs = 120_000,
    log = null,
  } = {}) {
    if (!stataHome) {
      throw new EngineError(
        'NOT_READY',
        'The pystata engine needs the Stata installation root. Set STATA_COPILOT_STATA_HOME to the folder that contains mp-64.dll (for example D:/).',
        { driver: 'pystata' }
      );
    }
    this.python = python;
    this.stataHome = String(stataHome).replace(/[\\/]+$/, '');
    this.edition = edition;
    this.bridge = bridge;
    this.startupTimeoutMs = startupTimeoutMs;
    this.log = log;
    this.endpoint = `pystata:${this.python}`;
    this.child = null;
    this.pending = new Map();
    this.nextId = 1;
    this.stderrTail = [];
    this.closed = null;
  }

  /** Path inside the Stata installation root ("D:" + "/mp-64.dll"). */
  #at(name) {
    return `${this.stataHome}/${name}`;
  }

  /** Environment the bridge needs: where `pystata` lives, and which Stata to load. */
  #env() {
    const utilities = process.env.STATA_COPILOT_PYSTATA_HOME ?? this.#at('utilities');
    const existing = process.env.PYTHONPATH ? [process.env.PYTHONPATH] : [];
    return {
      ...process.env,
      PYTHONPATH: [utilities, ...existing].join(';'),
      STATA_COPILOT_STATA_HOME: this.stataHome,
      STATA_COPILOT_EDITION: this.edition,
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1',
    };
  }

  #spawn() {
    if (!existsSync(this.bridge)) {
      throw new EngineError('NOT_READY', `Stata bridge not found at ${this.bridge}.`, { bridge: this.bridge });
    }
    const child = spawn(this.python, ['-u', this.bridge], {
      env: this.#env(),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;

    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.log?.warn?.(`pystata bridge printed a non-JSON line: ${line.slice(0, 200)}`);
        return;
      }
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.ok) waiter.resolve(message.result ?? {});
      else {
        const code = message.code === 'BUSY' ? 'BUSY' : 'BAD_RESPONSE';
        waiter.reject(new EngineError(code, message.error ?? 'bridge error', { op: message.id }));
      }
    });

    child.stderr.on('data', (chunk) => {
      const text = String(chunk);
      this.stderrTail.push(text);
      if (this.stderrTail.length > 20) this.stderrTail.shift();
      this.log?.info?.(`pystata: ${text.trimEnd()}`);
    });

    this.closed = new Promise((resolveExit) => {
      child.on('exit', (code, signal) => {
        const tail = this.stderrTail.join('').trim().split('\n').slice(-6).join('\n');
        for (const waiter of this.pending.values()) {
          waiter.reject(
            new EngineError('UNREACHABLE', `The Stata bridge exited (code ${code}${signal ? `, ${signal}` : ''}).`, {
              code,
              signal,
              stderr: tail,
            })
          );
        }
        this.pending.clear();
        this.child = null;
        resolveExit({ code, signal, stderr: tail });
      });
    });
  }

  async #request(op, payload = {}, { timeoutMs = 60_000 } = {}) {
    if (!this.child) this.#spawn();
    const id = this.nextId++;
    const message = { id, op, ...payload };
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectPromise(new EngineError('TIMEOUT', `The Stata bridge did not answer ${op} in ${timeoutMs} ms.`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolvePromise(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          rejectPromise(err);
        },
      });
      this.child.stdin.write(JSON.stringify(message) + '\n', (err) => {
        if (!err) return;
        const waiter = this.pending.get(id);
        this.pending.delete(id);
        waiter?.reject(new EngineError('OFFLINE', `Could not talk to the Stata bridge: ${err.message}`));
      });
    });
  }

  async status() {
    const raw = await this.#request('status', {}, { timeoutMs: this.startupTimeoutMs });
    return {
      engine: 'pystata',
      status: 'running',
      sessionActive: true,
      busy: Boolean(raw.busy),
      skillVersion: `pystata ${raw.python ?? ''}`.trim(),
      config: { stataPath: this.#at(`${this.edition}-64.dll`) },
      recommendedCandidate: { version: raw.version ?? null, edition: raw.editionName ?? this.edition },
      licenseFound: Boolean(raw.license),
      licenseError: raw.licenseError ?? null,
      capabilities: { execute: true, file: true, break: true, graphs: false },
      raw,
    };
  }

  /**
   * Run code or a do-file. `file` is executed as `do "path"` on purpose: that
   * is Stata's own batch semantics (relative paths, native graph export).
   */
  async execute({ code, file, cwd, timeout = 120 } = {}) {
    if (!code && !file) throw new EngineError('BAD_REQUEST', 'Provide either `code` or `file`.');
    const seconds = Math.min(Math.max(Number(timeout) || 120, 1), 86_400);
    const source = file ? `do "${file.replace(/\\/g, '/')}"` : code;
    const started = Date.now();

    const run = this.#request('run', { code: source, cwd: cwd ?? null }, { timeoutMs: seconds * 1000 + 30_000 });
    let timer;
    const timeoutPromise = new Promise((resolveTimeout) => {
      timer = setTimeout(async () => {
        // Ask Stata to stop, then give the run a short grace period so the
        // caller still receives the output produced up to the interruption.
        try {
          await this.break();
        } catch {
          /* the bridge may already be finishing */
        }
        try {
          const late = await Promise.race([run, new Promise((r) => setTimeout(() => r(null), 10_000))]);
          resolveTimeout(late ?? { output: '', rc: 1, interrupted: true, error: `timed out after ${seconds}s` });
        } catch (err) {
          resolveTimeout({ output: '', rc: 1, interrupted: true, error: err.message });
        }
      }, seconds * 1000);
      timer.unref?.();
    });

    let result;
    try {
      result = await Promise.race([run, timeoutPromise]);
    } finally {
      clearTimeout(timer);
    }

    const output = String(result.output ?? '');
    const rc = Number(result.rc ?? 0);
    return {
      success: rc === 0,
      returnCode: rc,
      output,
      error: result.error ?? '',
      interrupted: Boolean(result.interrupted),
      elapsedMs: Date.now() - started,
      graphs: [],
      mode: 'pystata',
    };
  }

  /** Interrupt the command that is running right now. Safe when idle. */
  async break() {
    return this.#request('break', {}, { timeoutMs: 10_000 });
  }

  async shutdown() {
    if (!this.child) return { bye: true };
    try {
      await this.#request('shutdown', {}, { timeoutMs: 5_000 });
    } catch {
      this.child?.kill();
    }
    await Promise.race([this.closed, new Promise((r) => setTimeout(r, 5_000))]);
    return { bye: true };
  }

  async ensureReady() {
    const st = await this.status();
    if (!st.licenseFound) {
      throw new EngineError(
        'NOT_READY',
        `Stata reported no usable licence for ${this.stataHome} (${st.licenseError ?? 'unknown reason'}).`,
        { stataHome: this.stataHome }
      );
    }
    return st;
  }
}

export default PystataEngine;
