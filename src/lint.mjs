/**
 * Static checks for the Stata mistakes that fail *silently*.
 *
 * The rules here are not style opinions: each one is a construct that Stata
 * accepts, runs, and gets wrong, or that fails only after the analysis is done.
 * They come from the Stata Journal tips collected in Cox's *Stata Tips* (4th
 * ed.), and from two bugs this project already hit in the field — an
 * `l ambiguous abbreviation` that killed a 17-minute run, and a
 * `gen wvs = 1 if wvs == .` that stopped a replication after 88 seconds.
 *
 * A finding is `{line, rule, severity, message, hint, text}`. `severity` is
 * `error` when Stata will abort, `warning` when the code runs and is probably
 * wrong, `info` when it is a recommendation.
 */

import { existsSync } from 'node:fs';

/** `capture quietly noi cap ...` prefixes are transparent to the checks below. */
const CONTROL_PREFIX = /^(?:(?:capture|cap|quietly|qui|noisily|noi|nolog)\s+)+/i;

/** Statements that invalidate any sort order established earlier in the file. */
const RESETS_ORDER = /^(?:use|sysuse|clear|import\s|append\s|merge\s|preserve|restore|drop\s|keep\s|expand\s|contract\s|sort\s+.*\bseed\b)\b/i;

/** Commands that establish an observation order the rest of the file relies on. */
const SETS_ORDER = /^(?:sort|gsort|bysort|by|xtset|tsset)\b/i;

/**
 * Estimation commands, only used for the one `info` rule that suggests
 * `set varabbrev off` at the top of a do-file.
 */
const ESTIMATION =
  /^(?:areg|binreg|clogit|cloglog|cnreg|coefplot|ereg|frontier|glm|gmm|gsem|heckman|intreg|ivreg|ivreg2|ivprobit|ivtobit|logistic|logit|melogit|mixed|mlogit|mprobit|nbreg|ologit|oprobit|poisson|probit|qreg|regress|reg|rreg|sem|stcox|stcrreg|streg|sureg|suest|tnbreg|tobit|tpoisson|truncreg|xtabond|xtcloglog|xtgee|xthtaylor|xtintreg|xtivreg|xtlogit|xtnbreg|xtpoisson|xtprobit|xtreg|xttobit)\b/i;

export const LINT_RULES = {
  'if-command': {
    severity: 'warning',
    title: '`if` command reads only the first observation',
  },
  'sort-order': {
    severity: 'warning',
    title: 'observation order used before it is established',
  },
  'gen-redefine': {
    severity: 'error',
    title: '`gen` on a variable the file already created',
  },
  'undefined-local': {
    severity: 'warning',
    title: 'local macro used before it is defined',
  },
  'missing-varlist': {
    severity: 'warning',
    title: '`missing()` called with a variable list',
  },
  'varabbrev-on': {
    severity: 'warning',
    title: 'variable abbreviation turned on',
  },
  'no-varabbrev-guard': {
    severity: 'info',
    title: 'do-file does not switch variable abbreviation off',
  },
  'do-missing-file': {
    severity: 'error',
    title: 'do-file referenced but not found',
  },
};

const stripComments = (text) =>
  text
    // /* ... */ blocks, across lines
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ''))
    // `*` at the start of a statement and `//` trailing comments
    .split(/\r?\n/)
    .map((line) => (/^\s*\*/.test(line) ? '' : line.replace(/(^|\s)\/\/.*$/, '$1')))
    .join('\n');

/** A condition is scalar-only when it reads r()/e()/s() results, a macro, or c(). */
const isScalarCondition = (condition) =>
  /(?:\br\(|\be\(|\bs\(|`|\$|_rc\b|\bc\()/.test(condition);

const looksLikeVariableTest = (condition) =>
  /^[A-Za-z_]\w*(?:\s*(?:==|!=|<=|>=|<|>)\s*[-+]?[\d.]+)?$/.test(condition.trim());

const usesObservationIndex = (statement) =>
  /(?:^|[^\w])_n\b|\[\s*_n\s*[-+]/.test(statement);

const isSortedOnThisLine = (statement) => /^(?:sort|gsort|bysort|by)\b/i.test(statement);

/**
 * @param {string} source
 * @param {{file?: string|null, cwd?: string|null}} [options]
 */
export function lintCode(source, options = {}) {
  const { file = null, cwd = null } = options;
  const text = String(source ?? '');
  const lines = text.split(/\r?\n/);
  const findings = [];

  const add = (line, rule, message, hint = null) => {
    findings.push({
      line,
      rule,
      severity: LINT_RULES[rule].severity,
      message,
      hint,
      text: (lines[line - 1] ?? '').trim().slice(0, 160),
    });
  };

  const knownLocals = new Set();
  const generatedVars = new Map();
  let orderKnown = false;

  lines.forEach((rawLine, index) => {
    const line = index + 1;
    const statement = rawLine.replace(CONTROL_PREFIX, '').trim();
    if (!statement) return;

    // --- definitions come first: a local defined on this line may be used on it
    for (const def of statement.matchAll(/\blocal\s+([A-Za-z_]\w*)/gi)) knownLocals.add(def[1]);
    for (const def of statement.matchAll(/\b(?:args|foreach|forvalues|tempname|tempvar|tempfile)\s+([A-Za-z_]\w*)/gi)) {
      knownLocals.add(def[1]);
    }

    // --- gen on a variable this file already made
    const gen = statement.match(
      /^(?:gen|generate)\s+(?:(?:byte|int|long|float|double|str\d*|strL)\s+)?([A-Za-z_]\w*)\s*=/,
    );
    if (gen) {
      const name = gen[1];
      if (generatedVars.has(name)) {
        add(
          line,
          'gen-redefine',
          `\`gen ${name}\` is already defined by line ${generatedVars.get(name)}; Stata stops with r(110) variable ${name} already defined`,
          'Use `replace` when the intent is to overwrite (this is the bug behind the 更富裕是否更幸福 replication stopping at line 4735).',
        );
      }
      generatedVars.set(name, line);
    }

    // --- `if <variable> {` : the if *command* sees only observation 1
    const ifCommand = statement.match(/^if\s+(.+?)\s*\{\s*$/);
    if (ifCommand && !isScalarCondition(ifCommand[1]) && looksLikeVariableTest(ifCommand[1])) {
      add(
        line,
        'if-command',
        `\`if ${ifCommand[1]}\` is the if command: it tests observation 1 only, not every observation`,
        'To select observations use the if qualifier (`regress y x if foreign`); to branch on Stata results use `if r(...)`/`if \`macro\'`.',
      );
    }

    // --- `_n` / `x[_n-1]` without a sort earlier in the file
    if (SETS_ORDER.test(statement)) orderKnown = true;
    if (RESETS_ORDER.test(statement)) orderKnown = false;
    if (usesObservationIndex(statement) && !orderKnown && !isSortedOnThisLine(statement)) {
      add(
        line,
        'sort-order',
        '`_n`-dependent code runs on whatever order the data happen to be in; no `sort`/`bysort` precedes it in this file',
        'Sort first (`sort id year`), or use `bysort` on the same line. Order is a property of the dataset, not of the command.',
      );
      orderKnown = true; // one finding per file is enough
    }

    // --- `missing(a b c)` is a varlist passed to a function that wants expressions
    const missingCall = statement.match(/\bmissing\s*\(([^)]*)\)/);
    if (missingCall) {
      const args = missingCall[1].trim();
      if (args && !args.includes(',') && /\s/.test(args)) {
        add(
          line,
          'missing-varlist',
          `\`missing(${args})\` passes a variable list; \`missing()\` takes a comma-separated list of expressions`,
          'Write `missing(a, b, c)`, or build the comma list once (`vcomma`) and reuse it.',
        );
      }
    }

    // --- `set varabbrev on` is the wrong direction for generated code
    if (/^set\s+varabbrev\s+on\b/i.test(statement)) {
      add(
        line,
        'varabbrev-on',
        '`set varabbrev on` lets Stata resolve `l` to `length` or to `ln_*` depending on what is loaded',
        'Leave abbreviation off in scripts: a mis-resolved variable name runs the wrong model without any error.',
      );
    }

    // --- a do-file that runs from a missing path
    const doCall = statement.match(/^(?:do|run|include)\s+"?([^"]+?\.do)"?/i);
    if (doCall && cwd) {
      const target = doCall[1];
      const resolved = target.match(/^[A-Za-z]:[\\/]|^\//) ? target : `${cwd}/${target}`;
      try {
        if (!existsSync(resolved)) {
          add(line, 'do-missing-file', `\`${statement.split(/\s/)[0]} "${target}"\` does not resolve to a file`, `Looked for ${resolved}.`);
        }
      } catch {
        /* a path we cannot test is not a finding */
      }
    }
  });

  // --- locals referenced but never defined in this file (silently expand to "")
  const referenced = new Map();
  lines.forEach((rawLine, index) => {
    const statement = rawLine.replace(CONTROL_PREFIX, '').trim();
    if (!statement || /^\*/.test(statement)) return;
    for (const ref of statement.matchAll(/`([A-Za-z_]\w*)'/g)) {
      const name = ref[1];
      if (name.startsWith('_') || name.startsWith('__cpl_')) continue;
      if (knownLocals.has(name)) continue;
      const first = referenced.get(name) ?? { line: index + 1, text: statement.slice(0, 120) };
      referenced.set(name, first);
    }
  });
  for (const [name, where] of referenced) {
    add(
      where.line,
      'undefined-local',
      `local \`${name}' is never defined in this file; Stata expands it to an empty string and the command still runs`,
      'Define it in the file, or put the definitions in `locals.do` and `include` that file (locals do not survive a `do`).',
    );
  }

  // --- do-file level advice: no `set varabbrev off` before estimation
  if (file && ESTIMATION.test(text) && !/^set\s+varabbrev\s+off\b/im.test(text)) {
    add(
      1,
      'no-varabbrev-guard',
      'this do-file estimates models but never turns variable abbreviation off',
      'Add `set varabbrev off` after `version`/`clear all` so a mistyped name cannot silently resolve to another variable.',
    );
  }

  findings.sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule));
  const counts = { error: 0, warning: 0, info: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  return { ok: counts.error === 0, counts, findings };
}
