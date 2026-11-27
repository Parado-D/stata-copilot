/**
 * Engine selection and the Engine contract.
 *
 * An *engine* is whatever turns Stata code into a transcript. Tools never
 * import a concrete engine, only this factory, which is what lets the tool
 * surface stay stable when the execution backend changes.
 *
 * Contract — every engine implements:
 *   endpoint: string
 *   status({format?})            -> service/session snapshot
 *   execute({code|file, cwd?, timeout?})
 *                                -> {success, returnCode, output, error, graphs}
 *   break()                      -> interrupt the running command
 *   shutdown()                   -> stop the backend (optional for remote engines)
 *   ensureReady()                -> status, or throw EngineError NOT_READY
 *
 * Adding an engine: implement the contract in ./<name>.mjs, register it below,
 * add a case to the contract test, and document it in docs/EXTENDING.md.
 */

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { EngineError } from '../errors.mjs';
import { HttpEngine, DEFAULT_ENDPOINT } from './http.mjs';
import { PystataEngine } from './pystata.mjs';

/** @type {Record<string, (options: object) => object>} */
export const ENGINES = {
  /** Stata inside the MCP server's own process tree (no extra service). */
  pystata: (options) => new PystataEngine(options),
  /** A running `stata-ai-skill` service over HTTP. */
  http: (options) => new HttpEngine(options),
};

export const ENGINE_DRIVERS = Object.keys(ENGINES);

/** `auto` is a selector, not an engine: it resolves to one of ENGINE_DRIVERS. */
export const DRIVERS = ['auto', ...ENGINE_DRIVERS];

/** Folders that hold `mp-64.dll` / `se-64.dll` on a normal installation. */
const STATA_HOME_CANDIDATES = [
  'C:/Program Files/Stata18', 'C:/Program Files/Stata17', 'C:/Program Files/Stata16',
  'C:/Program Files (x86)/Stata18', 'C:/Program Files (x86)/Stata17',
  'C:/Stata18', 'C:/Stata17',
  // A drive root is a legitimate layout: Stata may be installed as D:\mp-64.dll.
  'C:/', 'D:/', 'E:/', 'F:/',
];

const DLL_NAMES = ['mp-64.dll', 'se-64.dll', 'be-64.dll'];

/** First folder that actually contains a Stata shared library, or null. */
export function findStataHome() {
  for (const candidate of STATA_HOME_CANDIDATES) {
    const root = candidate.replace(/[\\/]+$/, '');
    if (DLL_NAMES.some((dll) => existsSync(`${root}/${dll}`))) return root;
  }
  return null;
}

/**
 * Python 3 that can import `pystata`. Explicit settings win; after that we try
 * `python` on PATH and the interpreter bundled with a DeepSeek Harness install,
 * because that is the one most likely to exist on a machine that is running
 * this server at all.
 */
export function findPython({ python = null } = {}) {
  const candidates = [
    python,
    process.env.STATA_COPILOT_PYTHON,
    'python',
    'python3',
    join(homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe'),
    join(process.env.LOCALAPPDATA ?? 'C:/Users/Default/AppData/Local', 'Programs', 'DeepSeek Harness',
      'resources', 'runtime', 'primary-runtime', 'dependencies', 'python', 'python.exe'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['-c', 'import sys'], { timeout: 5_000, windowsHide: true });
    if (probe.status === 0) return candidate;
  }
  return null;
}

/**
 * Can the standalone engine run here? Returns reasons either way so `--doctor`
 * and the startup log can say *why* a driver was chosen.
 */
export function detectPystata({ stataHome = null, python = null } = {}) {
  const home = stataHome ?? process.env.STATA_COPILOT_STATA_HOME ?? findStataHome();
  if (!home) return { available: false, stataHome: null, python: null, reason: 'no Stata installation found (no mp-64.dll)' };

  const utilities = `${String(home).replace(/[\\/]+$/, '')}/utilities/pystata`;
  if (!existsSync(utilities)) {
    return { available: false, stataHome: home, python: null, reason: `Stata found at ${home} but it has no utilities/pystata` };
  }
  const interpreter = findPython({ python });
  if (!interpreter) return { available: false, stataHome: home, python: null, reason: 'found Stata but no Python 3 that can import pystata' };
  return { available: true, stataHome: home, python: interpreter, reason: 'Stata and pystata are available' };
}

/**
 * Turn the configured driver into a concrete one. `auto` prefers the standalone
 * engine (nothing else to install) and falls back to a running HTTP service.
 */
export function resolveDriver({ driver = 'auto', stataHome = null, python = null } = {}) {
  if (driver !== 'auto') return { driver, detection: null };
  const detection = detectPystata({ stataHome, python });
  return { driver: detection.available ? 'pystata' : 'http', detection };
}

export function createEngine({ driver = 'auto', ...options } = {}) {
  const resolved = driver === 'auto' ? resolveDriver({ ...options, driver }).driver : driver;
  const build = ENGINES[resolved];
  if (!build) {
    throw new EngineError('BAD_REQUEST', `Unknown engine driver "${driver}" (use ${DRIVERS.join('|')}).`, {
      driver,
      available: DRIVERS,
    });
  }
  const engine = build(options);
  for (const method of ['status', 'execute', 'break']) {
    if (typeof engine[method] !== 'function') {
      throw new EngineError('BAD_RESPONSE', `Engine driver "${resolved}" does not implement ${method}().`, { driver: resolved });
    }
  }
  engine.driver = resolved;
  return engine;
}

export { HttpEngine, PystataEngine, DEFAULT_ENDPOINT };
