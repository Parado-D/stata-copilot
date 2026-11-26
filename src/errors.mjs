/**
 * Errors with machine-readable codes.
 *
 * Every failure an agent can act on a different way carries a code from
 * ERROR_CODES: OFFLINE means start the service, POLICY_BLOCKED means change
 * the command, INVALID_ARGS means fix the arguments, and so on. Codes are
 * frozen here so tools, tests and docs cannot drift apart, and an unknown code
 * fails loudly at construction time instead of surfacing as a mystery string.
 */

export const ERROR_CODES = Object.freeze({
  /** Nothing is listening on the engine endpoint. */
  OFFLINE: 'OFFLINE',
  /** The endpoint answered nothing within the request budget. */
  UNREACHABLE: 'UNREACHABLE',
  /** Stata itself exceeded the requested timeout (HTTP 408). */
  TIMEOUT: 'TIMEOUT',
  /** The engine answered, but not with the JSON contract. */
  BAD_RESPONSE: 'BAD_RESPONSE',
  /** The engine answered with a non-2xx status. */
  HTTP_ERROR: 'HTTP_ERROR',
  /** The session exists but cannot run code (licence, setup, busy). */
  NOT_READY: 'NOT_READY',
  /** The command was refused before it reached Stata. */
  POLICY_BLOCKED: 'POLICY_BLOCKED',
  /** The working directory is outside the configured roots. */
  CWD_BLOCKED: 'CWD_BLOCKED',
  /** Tool arguments did not match the tool's inputSchema. */
  INVALID_ARGS: 'INVALID_ARGS',
  /** The engine rejected the request as malformed. */
  BAD_REQUEST: 'BAD_REQUEST',
  /** A file the tool needed does not exist. */
  FILE_NOT_FOUND: 'FILE_NOT_FOUND',
  /** No tool with that name is registered. */
  UNKNOWN_TOOL: 'UNKNOWN_TOOL',
  /** A tool module is malformed — a programming error, not a user error. */
  TOOL_DEFINITION: 'TOOL_DEFINITION',
});

const KNOWN = new Set(Object.values(ERROR_CODES));

export class EngineError extends Error {
  /**
   * @param {keyof typeof ERROR_CODES} code
   * @param {string} message  what happened, in the agent's language
   * @param {object} [details] structured evidence the agent can branch on
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'EngineError';
    this.code = KNOWN.has(code) ? code : ERROR_CODES.BAD_RESPONSE;
    this.details = details;
  }

  toJSON() {
    return { code: this.code, message: this.message, details: this.details };
  }
}

export const isEngineError = (err) => err instanceof EngineError;

/** The MCP result shape for a failed tool call. */
export function errorResult(err) {
  const payload = isEngineError(err)
    ? { error: err.toJSON() }
    : { error: { code: 'INTERNAL', message: String(err?.message ?? err) } };
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  };
}
