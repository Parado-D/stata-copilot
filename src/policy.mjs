/**
 * Command safety policy.
 *
 * An agent with a live Stata session can delete data, shell out, or overwrite
 * an analysis that took a week to build. The policy is deliberately small and
 * legible: it reads the command word of every statement and refuses the ones
 * that reach outside the analysis sandbox.
 *
 * The rules are data (RULES below), not code, so widening a list or adding a
 * warning is a one-line change and the reasoning stays next to the rule.
 *
 * Modes
 *   open      no checks (escape hatch; the mode is printed in every result)
 *   guarded   refuse shell escapes and filesystem destruction (default)
 *   readonly  additionally refuse anything that writes to disk
 *
 * What it is not: an OS sandbox. `do` files, `run` files and macros can still
 * write if a user hands them one; see SECURITY.md for the exact boundary.
 */

export const MODES = ['open', 'guarded', 'readonly'];

const SHELL_WORDS = ['shell', 'winexec', 'xshell', 'dos', 'unixcmd'];
const FS_DESTRUCTIVE = ['erase', 'rmdir'];
const WRITE_WORDS = [
  'save', 'saveold', 'export', 'outsheet', 'outfile', 'putexcel', 'putdocx',
  'putpdf', 'esttab', 'estout', 'outreg2', 'estimates', 'file', 'log',
  'mkdir', 'copy', 'type',
];

/**
 * @typedef {object} Rule
 * @property {string} id              appears in the refusal, stable across versions
 * @property {string[]} modes         modes in which the rule fires
 * @property {(s: {text: string, word: string}) => boolean} match
 * @property {(s: {text: string, word: string}) => string} why  agent-facing reason
 */

/** @type {Rule[]} */
export const RULES = [
  {
    id: 'shell-escape',
    modes: ['guarded', 'readonly'],
    match: (s) => s.text.startsWith('!'),
    why: () => '`!` runs a shell command, outside the analysis sandbox.',
  },
  {
    id: 'shell',
    modes: ['guarded', 'readonly'],
    match: (s) => SHELL_WORDS.includes(s.word),
    why: (s) => `\`${s.word}\` runs an external process.`,
  },
  {
    id: 'filesystem-destructive',
    modes: ['guarded', 'readonly'],
    match: (s) => FS_DESTRUCTIVE.includes(s.word),
    why: (s) => `\`${s.word}\` deletes files or directories.`,
  },
  {
    id: 'readonly-write',
    modes: ['readonly'],
    match: (s) => WRITE_WORDS.includes(s.word),
    why: (s) => `\`${s.word}\` writes to disk; the session is in readonly mode.`,
  },
];

/** Non-blocking advice, returned with every run so the agent can correct itself. */
export const WARNINGS = [
  {
    id: 'clear-all',
    match: (s) => s.word === 'clear' && /\ball\b/.test(s.text),
    message: '`clear all` discards data, value labels and programs — usually `clear` is enough.',
  },
];

/** Strip Stata's statement prefixes so the command word can be read. */
export function statements(code) {
  const out = [];
  for (const raw of String(code ?? '').split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith('*') || line.startsWith('//')) continue;
    let guard = 0;
    // `capture qui regress ...` / `cap noi ...` / `qui {`
    for (;;) {
      const m = line.match(/^(capture|cap|quietly|qui|noisily|noi)\b\s*(.*)$/i);
      if (!m || guard++ > 6) break;
      line = m[2].trim();
    }
    if (!line) continue;
    const word = line.match(/^([A-Za-z_][\w-]*)/)?.[1]?.toLowerCase() ?? '';
    out.push({ text: line, word });
  }
  return out;
}

/**
 * @returns {{ allowed: boolean, mode: string, blocked: Array<{rule:string,text:string,why:string}>, warnings: string[] }}
 */
export function checkPolicy(code, { mode = 'guarded' } = {}) {
  if (!MODES.includes(mode)) mode = 'guarded';
  const blocked = [];
  const warnings = [];
  if (mode === 'open') return { allowed: true, mode, blocked, warnings };

  for (const statement of statements(code)) {
    for (const rule of RULES) {
      if (!rule.modes.includes(mode)) continue;
      if (!rule.match(statement)) continue;
      blocked.push({ rule: rule.id, text: statement.text, why: rule.why(statement) });
      break; // one refusal per statement is enough to explain it
    }
    for (const warning of WARNINGS) {
      if (warning.match(statement)) warnings.push(warning.message);
    }
  }
  return { allowed: blocked.length === 0, mode, blocked, warnings };
}

/**
 * cwd guard: when roots are configured, a run may only set cwd inside them.
 * @returns {{ allowed: boolean, why?: string }}
 */
export function checkCwd(cwd, roots = []) {
  if (!cwd || roots.length === 0) return { allowed: true };
  const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const target = norm(cwd);
  const inside = roots.some((root) => {
    const r = norm(root);
    return target === r || target.startsWith(r + '/');
  });
  if (inside) return { allowed: true };
  return { allowed: false, why: `cwd "${cwd}" is outside the configured roots (${roots.join(', ')}).` };
}
