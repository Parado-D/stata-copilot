/**
 * Command safety policy.
 *
 * An agent with a live Stata session can delete data, shell out, or overwrite
 * an analysis that took a week to build. The policy is deliberately small and
 * legible: it reads the command word of every statement and refuses the ones
 * that reach outside the analysis sandbox.
 *
 * Modes
 *   open      no checks (escape hatch; print the mode in every result)
 *   guarded   refuse shell escapes and filesystem destruction (default)
 *   readonly  additionally refuse anything that writes to disk
 */

export const MODES = ['open', 'guarded', 'readonly'];

const SHELL_WORDS = new Set(['shell', 'winexec', 'xshell', 'dos', 'unixcmd']);
const FS_DESTRUCTIVE = new Set(['erase', 'rmdir']);
const WRITE_WORDS = new Set([
  'save', 'saveold', 'export', 'outsheet', 'outfile', 'putexcel', 'putdocx',
  'putpdf', 'esttab', 'estout', 'outreg2', 'estimates', 'file', 'log',
  'mkdir', 'copy', 'type',
]);

/** Strip Stata's statement prefixes so the command word can be read. */
function statements(code) {
  const out = [];
  for (const raw of String(code ?? '').split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith('*') || line.startsWith('//')) continue;
    let guard = 0;
    // `capture qui regress ...` / `cap noi ...` / `qui {`
    for (;;) {
      const m = line.match(/^(capture|cap|quietly|qui|noisily|noi|capture quietly)\b\s*(.*)$/i);
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
export function checkPolicy(code, { mode = 'guarded', shared = false } = {}) {
  if (!MODES.includes(mode)) mode = 'guarded';
  const blocked = [];
  const warnings = [];
  if (mode === 'open') return { allowed: true, mode, blocked, warnings };

  for (const { text, word } of statements(code)) {
    if (text.startsWith('!')) {
      blocked.push({ rule: 'shell-escape', text, why: '`!` runs a shell command, outside the analysis sandbox.' });
      continue;
    }
    if (SHELL_WORDS.has(word)) {
      blocked.push({ rule: 'shell', text, why: `\`${word}\` runs an external process.` });
      continue;
    }
    if (FS_DESTRUCTIVE.has(word)) {
      blocked.push({ rule: 'filesystem-destructive', text, why: `\`${word}\` deletes files or directories.` });
      continue;
    }
    if (mode === 'readonly' && WRITE_WORDS.has(word)) {
      blocked.push({ rule: 'readonly-write', text, why: `\`${word}\` writes to disk; the session is in readonly mode.` });
      continue;
    }
    if (word === 'clear' && /\ball\b/.test(text)) {
      warnings.push('`clear all` discards data, value labels and programs — usually `clear` is enough.');
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
