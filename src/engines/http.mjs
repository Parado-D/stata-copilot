/**
 * HTTP engine: drives a `stata-ai-skill` service (default port 19522).
 *
 * The service owns the live Stata session (start, licence, break, graph
 * capture). This module only speaks its stable HTTP contract:
 *
 *   GET  /status            -> session / Stata / config state
 *   GET  /status?format=stata
 *   POST /execute           -> { code | file, cwd?, timeout? }
 *                              => { success, returnCode, output, error, graphs }
 *   POST /break             -> interrupt a running command
 *   POST /shutdown          -> stop the background service
 *
 * It implements the Engine contract documented in ./index.mjs.
 */

import { EngineError } from '../errors.mjs';

export const DEFAULT_ENDPOINT = 'http://127.0.0.1:19522';
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export class HttpEngine {
  constructor({ endpoint = DEFAULT_ENDPOINT, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
    this.endpoint = String(endpoint).replace(/\/+$/, '');
    this.requestTimeoutMs = requestTimeoutMs;
  }

  /**
   * GET requests are retried after a *connection-level* failure: on Windows the
   * first socket to a freshly bound local service can be refused while the
   * listener settles, and that is a transport hiccup, not a Stata answer.
   * POST is never retried — replaying an /execute could run an analysis twice.
   */
  async #get(path, { timeoutMs } = {}) {
    const delays = [0, 150, 400];
    let lastError;
    for (const delay of delays) {
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      try {
        return await this.#request(path, { method: 'GET', timeoutMs });
      } catch (err) {
        if (err instanceof EngineError && (err.code === 'OFFLINE' || err.code === 'UNREACHABLE')) {
          lastError = err;
          continue;
        }
        throw err;
      }
    }
    throw lastError;
  }

  async #request(path, { method = 'GET', body, timeoutMs = this.requestTimeoutMs } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(this.endpoint + path, {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const raw = await res.text();
      if (res.status === 408) {
        throw new EngineError('TIMEOUT', 'Stata is still running the command (HTTP 408). Call stata_break, then retry with a larger timeout.', {
          httpStatus: 408,
          body: raw.slice(0, 2000),
        });
      }
      let json;
      try {
        json = raw ? JSON.parse(raw) : {};
      } catch {
        throw new EngineError('BAD_RESPONSE', `Engine returned non-JSON (HTTP ${res.status}).`, {
          httpStatus: res.status,
          body: raw.slice(0, 2000),
        });
      }
      if (!res.ok) {
        const message = json?.error || json?.message || raw.slice(0, 500);
        throw new EngineError('HTTP_ERROR', `Engine HTTP ${res.status}: ${message}`, {
          httpStatus: res.status,
          body: json,
        });
      }
      return json;
    } catch (err) {
      if (err instanceof EngineError) throw err;
      if (err?.name === 'AbortError') {
        throw new EngineError('UNREACHABLE', `No answer from ${this.endpoint} within ${timeoutMs} ms.`, {
          endpoint: this.endpoint,
        });
      }
      throw new EngineError('OFFLINE', `Cannot reach the Stata AI Skill service at ${this.endpoint}: ${err?.message ?? err}`, {
        endpoint: this.endpoint,
        hint: 'Start the service (stata-ai-skill) or set STATA_COPILOT_ENDPOINT to its address.',
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /** Session / Stata / config snapshot. */
  async status({ format } = {}) {
    return this.#get('/status' + (format === 'stata' ? '?format=stata' : ''), { timeoutMs: 8_000 });
  }

  /**
   * Run Stata code or a do-file.
   * `timeout` is Stata-side seconds (service max 600); the HTTP wait gets a
   * generous margin on top so the two limits do not fight each other.
   */
  async execute({ code, file, cwd, timeout = 120 } = {}) {
    if (!code && !file) {
      throw new EngineError('BAD_REQUEST', 'Provide either `code` or `file`.');
    }
    const seconds = Math.min(Math.max(Number(timeout) || 120, 1), 600);
    const payload = { timeout: seconds };
    if (file) payload.file = file;
    else payload.code = code;
    if (cwd) payload.cwd = cwd;
    const json = await this.#request('/execute', {
      method: 'POST',
      body: payload,
      timeoutMs: seconds * 1000 + 30_000,
    });
    return {
      success: Boolean(json.success),
      returnCode: json.returnCode ?? (json.success ? 0 : 1),
      output: json.output ?? '',
      error: json.error ?? '',
      graphs: Array.isArray(json.graphs) ? json.graphs : [],
    };
  }

  async break() {
    return this.#request('/break', { method: 'POST', timeoutMs: 10_000 });
  }

  async shutdown() {
    return this.#request('/shutdown', { method: 'POST', timeoutMs: 10_000 });
  }

  /** Read status and turn an unusable session into an actionable error. */
  async ensureReady() {
    const st = await this.status();
    if (st.status === 'running' && st.sessionActive) return st;
    const hints = [];
    if (st.needsLicense || st.missing === 'stata_license') hints.push('Stata licence not found for the configured installation.');
    if (st.needsConfiguration) hints.push('No Stata installation selected; open the Stata AI Skill setup and pick one.');
    if (st.setup?.phase && st.setup.phase !== 'ready') hints.push(`Setup phase is "${st.setup.phase}".`);
    throw new EngineError('NOT_READY', `Stata session is not ready (status=${st.status ?? 'unknown'}). ${hints.join(' ')}`.trim(), {
      status: st,
    });
  }
}
