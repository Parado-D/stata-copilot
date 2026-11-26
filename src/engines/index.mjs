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

import { EngineError } from '../errors.mjs';
import { HttpEngine, DEFAULT_ENDPOINT } from './http.mjs';

/** @type {Record<string, (options: object) => object>} */
export const ENGINES = {
  http: (options) => new HttpEngine(options),
};

export const ENGINE_DRIVERS = Object.keys(ENGINES);

export function createEngine({ driver = 'http', ...options } = {}) {
  const build = ENGINES[driver];
  if (!build) {
    throw new EngineError('BAD_REQUEST', `Unknown engine driver "${driver}" (use ${ENGINE_DRIVERS.join('|')}).`, {
      driver,
      available: ENGINE_DRIVERS,
    });
  }
  const engine = build(options);
  for (const method of ['status', 'execute', 'break']) {
    if (typeof engine[method] !== 'function') {
      throw new EngineError('BAD_RESPONSE', `Engine driver "${driver}" does not implement ${method}().`, { driver });
    }
  }
  return engine;
}

export { HttpEngine, DEFAULT_ENDPOINT };
