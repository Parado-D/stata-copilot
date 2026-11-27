/**
 * Background jobs: run a do-file as its own Stata process.
 *
 * Why this exists. The AI Skill service embeds the Stata engine (`mp-64.dll`)
 * inside its own process, so it is single-threaded: while one command runs,
 * every other call is refused with `409 Stata is busy executing another
 * command`, and a call that outlives the service's own limit comes back as a
 * timeout with no return code. Neither can be fixed from a client.
 *
 * A batch process can. `StataMP-64.exe /e /q do file.do` is a separate OS
 * process: it has no concurrency limit, no 300 s ceiling, and its log is on
 * disk, so a job can be submitted, polled and killed independently of the
 * HTTP session —which stays free for interactive work.
 *
 * Four behaviours are deliberate and covered by test/smoke.mjs:
 *   1. argv is `['/e', '/q', 'do', name]` —one token each. A single
 *      `do "name"` argument is swallowed by Stata (process exits in ~0.6 s and
 *      writes no log).
 *   2. The do-file is copied to an ASCII name (`__job-<id>.do`) because a
 *      non-ASCII name on the command line collapses to `do` →`r(199)`.
 *   3. `/e` is mandatory; without it Stata opens a GUI and the parent waits
 *      forever.
 *   4. Batch exits 0 even on error, so a job's state comes from the log.
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { EngineError } from './errors.mjs';
import { truncate } from './lib/content.mjs';
import { parseFirstError } from './parsers/errors.mjs';
import { findStataExe } from './stata-paths.mjs';

/**
 * The executable used for batch runs. Resolved once, lazily: a machine with
 * Stata installed somewhere unusual only has to set `--stata-exe` (or
 * `STATA_COPILOT_STATA_EXE`) and the same answer is reused for every job.
 */
export function defaultStataExe() {
  return process.env.STATA_EXE ?? findStataExe() ?? null;
}

/** Kept for callers that imported the old constant. */
export const DEFAULT_STATA_EXE = defaultStataExe();

/** Terminal states; `running` is the only non-terminal one. */
export const JOB_STATES = ['running', 'ok', 'failed', 'timedout', 'killed', 'unknown'];

const ID_PATTERN = /^j-[a-z0-9]{4,}-[a-f0-9]{4}$/;

/** A pid exists if signalling it with 0 does not raise ESRCH. */
function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function nextId() {
  return `j-${Date.now().toString(36)}-${randomBytes(2).toString('hex')}`;
}

export class JobStore {
  /**
   * @param {{stataExe?: string, defaultTimeout?: number, log?: object,
   *          probe?: (() => Promise<unknown>) | null}} [options]
   */
  constructor({ stataExe = null, defaultTimeout = 1800, log = null, probe = null } = {}) {
    this.stataExe = stataExe ?? defaultStataExe();
    this.defaultTimeout = defaultTimeout;
    this.logger = log;
    /** Cheapest call that proves the HTTP service answers (usually GET /status). */
    this.probe = probe;
    /** @type {Map<string, object>} records for jobs submitted in this process */
    this.jobs = new Map();
    /** @type {Map<string, NodeJS.Timeout>} per-job wall-clock timers */
    this.timers = new Map();
  }

  /** Jobs live next to the run's ledger: <cwd>/.stata-copilot/jobs/. */
  dir(cwd) {
    return path.join(cwd, '.stata-copilot', 'jobs');
  }

  #jsonPath(cwd, id) {
    return path.join(this.dir(cwd), `${id}.json`);
  }

  async #persist(record) {
    await mkdir(this.dir(record.cwd), { recursive: true });
    const { outputTail, ...stored } = record;
    await writeFile(this.#jsonPath(record.cwd, record.id), `${JSON.stringify(stored, null, 2)}\n`, 'utf8');
  }

  /** Memory first, then the JSON on disk —a restarted server can still report. */
  async #record(id, cwd) {
    if (!ID_PATTERN.test(String(id ?? ''))) {
      throw new EngineError('INVALID_ARGS', `Not a job id: ${id}`, { pattern: String(ID_PATTERN) });
    }
    const known = this.jobs.get(id);
    if (known) return known;
    let raw;
    try {
      raw = await readFile(this.#jsonPath(cwd, id), 'utf8');
    } catch {
      throw new EngineError('FILE_NOT_FOUND', `No such job: ${id} (looked in ${this.dir(cwd)})`);
    }
    const record = JSON.parse(raw);
    this.jobs.set(id, record);
    return record;
  }

  #arm(record) {
    const ms = Math.max(1, Number(record.timeout) || this.defaultTimeout) * 1000;
    const timer = setTimeout(async () => {
      if (record.state !== 'running') return;
      this.logger?.warn(`job ${record.id} exceeded ${record.timeout}s, killing pid ${record.pid}`);
      await this.kill(record.id, record.cwd).catch(() => {});
    }, ms);
    timer.unref?.();
    this.timers.set(record.id, timer);
  }

  /**
   * Start a do-file in its own Stata process.
   * @param {{file: string, body: string, cwd: string, label?: string|null, timeout?: number}} input
   */
  async submit({ file, body, cwd, label = null, timeout = this.defaultTimeout }) {
    if (!this.stataExe) {
      throw new EngineError(
        'NOT_READY',
        'No Stata executable found for background jobs. Set --stata-exe to StataMP-64.exe (or STATA_COPILOT_STATA_EXE), or run `--doctor` to see what was detected.',
        { hint: 'Background jobs start their own Stata process, so they need the .exe even when the embedded engine works.' }
      );
    }
    const id = nextId();
    const doFile = `__job-${id}.do`;
    await writeFile(path.join(cwd, doFile), body, 'utf8');

    let child;
    try {
      child = spawn(this.stataExe, ['/e', '/q', 'do', doFile], {
        cwd,
        windowsHide: true,
        stdio: 'ignore',
        detached: true,
      });
    } catch (err) {
      throw new EngineError('UNREACHABLE', `Cannot start Stata at ${this.stataExe}: ${err.message}`);
    }
    child.on('error', (err) => {
      this.logger?.error(`job ${id}: cannot start ${this.stataExe}: ${err.message}`);
    });
    child.unref();

    const record = {
      id,
      pid: child.pid ?? null,
      state: 'running',
      label,
      file,
      cwd,
      doFile,
      log: `__job-${id}.log`,
      stataExe: this.stataExe,
      startedAt: new Date().toISOString(),
      startedMs: Date.now(),
      timeout: Math.max(1, Number(timeout) || this.defaultTimeout),
      endedAt: null,
      durationMs: null,
      returnCode: null,
      failure: null,
    };
    this.jobs.set(id, record);
    await this.#persist(record);
    this.#arm(record);
    this.logger?.info(`job ${id} started (pid ${record.pid}) in ${cwd}`);
    // Launching a second Stata makes the embedded engine in the service reset
    // the first connection it gets afterwards (observed on Windows: one
    // ECONNRESET, then normal). Absorb that hiccup here instead of letting the
    // caller's next /execute be the one that fails. Best effort: a service that
    // is really down still returns the job, because a job does not need it.
    await this.#waitForService();
    return this.view(record);
  }

  /** Poll the service after a spawn until it answers again (bounded, best effort). */
  async #waitForService({ attempts = 8, delayMs = 250 } = {}) {
    if (!this.probe) return;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        await this.probe();
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    this.logger?.warn('the Stata service did not answer after starting a job; continuing anyway');
  }

  /** Log text so far, plus whether it exists yet. */
  async #logText(record) {
    try {
      return await readFile(path.join(record.cwd, record.log), 'utf8');
    } catch {
      return '';
    }
  }

  /** Finish a record once its process is gone; `forced` marks why. */
  async #finalize(record, forced = null) {
    if (record.state !== 'running' && !forced) return record;
    const text = await this.#logText(record);
    const failure = parseFirstError(text);
    const state = forced ?? (!text ? 'unknown' : failure ? 'failed' : 'ok');

    record.state = state;
    record.returnCode = failure ? Number(failure.code.replace(/\D/g, '')) : state === 'ok' ? 0 : null;
    record.failure = failure;
    record.endedAt = new Date().toISOString();
    record.durationMs = Date.now() - record.startedMs;
    record.outputTail = truncate(text, 4000).value;
    record.logBytes = text.length;
    await this.#persist(record);

    await unlink(path.join(record.cwd, record.doFile)).catch(() => {});
    const timer = this.timers.get(record.id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(record.id);
    }
    this.logger?.info(`job ${record.id} ${state} after ${(record.durationMs / 1000).toFixed(1)}s`);
    return record;
  }

  view(record, { tailChars = 1200 } = {}) {
    return {
      jobId: record.id,
      state: record.state,
      label: record.label ?? null,
      file: record.file,
      cwd: record.cwd,
      pid: record.pid,
      startedAt: record.startedAt,
      endedAt: record.endedAt ?? null,
      durationMs: record.durationMs ?? null,
      timeoutSeconds: record.timeout,
      returnCode: record.returnCode ?? null,
      failure: record.failure ?? null,
      log: path.join(record.cwd, record.log),
      outputTail: truncate(record.outputTail ?? '', tailChars).value,
    };
  }

  /** Poll one job; a finished process is finalised here, lazily. */
  async status(id, cwd, { tailChars = 1200 } = {}) {
    const record = await this.#record(id, cwd);
    if (record.state === 'running' && !isAlive(record.pid)) {
      await this.#finalize(record);
    }
    if (record.state === 'running') {
      // While it runs there is no endedAt, so report wall-clock time so far and
      // the log as it stands. Batch Stata writes that log as it goes, which is
      // what makes a long job watchable instead of a black box.
      record.durationMs = Date.now() - record.startedMs;
      const text = await this.#logText(record);
      record.outputTail = truncate(text, 4000).value;
      record.logBytes = text.length;
    }
    return this.view(record, { tailChars });
  }

  async log(id, cwd, tailChars = 8000) {
    const record = await this.#record(id, cwd);
    const text = await this.#logText(record);
    return {
      jobId: record.id,
      state: record.state,
      log: path.join(record.cwd, record.log),
      exists: text.length > 0,
      text: truncate(text, tailChars).value,
    };
  }

  async kill(id, cwd) {
    const record = await this.#record(id, cwd);
    if (record.state !== 'running') return this.view(record);
    try {
      process.kill(record.pid);
    } catch (err) {
      if (err.code !== 'ESRCH') {
        throw new EngineError('UNREACHABLE', `Cannot kill pid ${record.pid}: ${err.message}`);
      }
    }
    // Give Stata a moment to flush the log before we classify the run.
    await sleep(700);
    await this.#finalize(record, 'killed');
    return this.view(record);
  }

  async list(cwd, limit = 20) {
    await mkdir(this.dir(cwd), { recursive: true });
    let names = [];
    try {
      names = await readdir(this.dir(cwd));
    } catch {
      return [];
    }
    const records = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -'.json'.length);
      try {
        const record = await this.#record(id, cwd);
        if (record.state === 'running' && !isAlive(record.pid)) await this.#finalize(record);
        records.push(record);
      } catch {
        // A half-written or foreign file is not worth failing a listing over.
      }
    }
    return records
      .sort((a, b) => (b.startedMs ?? 0) - (a.startedMs ?? 0))
      .slice(0, Math.max(1, Number(limit) || 20))
      .map((record) => this.view(record, { tailChars: 0 }));
  }
}
