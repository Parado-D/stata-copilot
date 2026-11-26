/**
 * Logging to stderr, never to stdout.
 *
 * stdout carries JSON-RPC frames; a stray log line there corrupts the session.
 * Level comes from STATA_COPILOT_LOG (error|warn|info|debug), default info.
 */

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

export const LOG_LEVELS = Object.keys(LEVELS);

export function createLogger({ level = 'info', prefix = '[stata-copilot]', sink = process.stderr } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const emit = (lvl, message) => {
    if (LEVELS[lvl] > threshold) return;
    sink.write(`${prefix} ${lvl}: ${message}\n`);
  };
  return {
    level,
    error: (m) => emit('error', m),
    warn: (m) => emit('warn', m),
    info: (m) => emit('info', m),
    debug: (m) => emit('debug', m),
    /** A logger that never writes — for tests. */
    silent: () => createLogger({ level: 'error', sink: { write() {} } }),
  };
}

export const silentLogger = createLogger({ level: 'error', sink: { write() {} } });
