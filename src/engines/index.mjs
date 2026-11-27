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
import { join } from 'node:path';
import { homedir } from 'node:os';

import { EngineError } from '../errors.mjs';
import {
  describeStata,
  editionFromDll,
  editionFromHome,
  findStataExe,
  findStataHome,
  normalizeRoot,
} from '../stata-paths.mjs';
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
 *
 * The edition comes from the library that is actually present, so a Stata/SE
 * install (`se-64.dll`) is loaded as SE instead of failing on `mp`.
 */
export function detectPystata({ stataHome = null, stataExe = null, python = null, search = true, registry = true } = {}) {
  const home = findStataHome({ stataHome, stataExe, search, registry });
  if (!home) {
    return {
      available: false,
      stataHome: null,
      stataExe: findStataExe({ stataExe, stataHome }),
      edition: null,
      python: null,
      reason: 'no Stata installation found (no mp-64.dll, se-64.dll or be-64.dll)',
    };
  }

  const utilities = `${normalizeRoot(home)}/utilities/pystata`;
  if (!existsSync(utilities)) {
    return {
      available: false,
      stataHome: home,
      stataExe: findStataExe({ stataExe, stataHome: home }),
      edition: editionFromHome(home),
      python: null,
      reason: `Stata found at ${home} but it has no utilities/pystata`,
    };
  }
  const interpreter = findPython({ python });
  if (!interpreter) {
    return {
      available: false,
      stataHome: home,
      stataExe: findStataExe({ stataExe, stataHome: home }),
      edition: editionFromHome(home),
      python: null,
      reason: 'found Stata but no Python 3 that can import pystata',
    };
  }
  return {
    available: true,
    stataHome: home,
    stataExe: findStataExe({ stataExe, stataHome: home }),
    edition: editionFromHome(home),
    python: interpreter,
    reason: 'Stata and pystata are available',
  };
}

/**
 * Turn the configured driver into a concrete one. `auto` prefers the standalone
 * engine (nothing else to install) and falls back to a running HTTP service.
 */
export function resolveDriver({ driver = 'auto', stataHome = null, stataExe = null, python = null } = {}) {
  if (driver !== 'auto') return { driver, detection: null };
  const detection = detectPystata({ stataHome, stataExe, python });
  return { driver: detection.available ? 'pystata' : 'http', detection };
}

export function createEngine({ driver = 'auto', ...options } = {}) {
  const detection = driver === 'auto' || driver === 'pystata' ? detectPystata(options) : null;
  const resolved = driver === 'auto' ? (detection?.available ? 'pystata' : 'http') : driver;
  const build = ENGINES[resolved];
  if (!build) {
    throw new EngineError('BAD_REQUEST', `Unknown engine driver "${driver}" (use ${DRIVERS.join('|')}).`, {
      driver,
      available: DRIVERS,
    });
  }
  // A discovered home/edition is the default; an explicit setting still wins.
  const engineOptions = {
    ...options,
    ...(detection?.stataHome ? { stataHome: options.stataHome ?? detection.stataHome } : {}),
    ...(detection?.edition ? { edition: options.edition ?? detection.edition } : {}),
  };
  const engine = build(engineOptions);
  for (const method of ['status', 'execute', 'break']) {
    if (typeof engine[method] !== 'function') {
      throw new EngineError('BAD_RESPONSE', `Engine driver "${resolved}" does not implement ${method}().`, { driver: resolved });
    }
  }
  engine.driver = resolved;
  return engine;
}

export { HttpEngine, PystataEngine, DEFAULT_ENDPOINT };
export {
  describeStata,
  editionFromDll,
  editionFromHome,
  findStataExe,
  findStataHome,
  normalizeRoot,
};
