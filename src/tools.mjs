/**
 * The MCP tool surface.
 *
 * Design rule: every tool returns *structure* the agent can branch on, never a
 * raw transcript it has to re-read. The transcript is still there (agents need
 * it to debug), but the fields above it — success, returnCode, estimates, n,
 * missing counts — are the contract.
 */

import { readFile, mkdir, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { EngineError } from './engine.mjs';
import { checkPolicy, checkCwd, MODES } from './policy.mjs';
import {
  parseMacroList,
  parseCoefficientRows,
  parseModelHeader,
  parseProfileRows,
  parseDatasetHeader,
  studentTwoSidedP,
} from './parse.mjs';

const text = (s) => ({ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s, null, 2) });

function truncate(str, max) {
  const s = String(str ?? '');
  if (s.length <= max) return { value: s, truncated: false };
  const head = Math.floor(max * 0.35);
  const tail = max - head;
  return {
    value: `${s.slice(0, head)}\n... [${s.length - max} characters omitted] ...\n${s.slice(s.length - tail)}`,
    truncated: true,
  };
}

class Ledger {
  constructor({ limit = 200 } = {}) {
    this.entries = [];
    this.limit = limit;
  }

  async record(entry, { cwd, persist }) {
    const row = { at: new Date().toISOString(), ...entry };
    this.entries.push(row);
    if (this.entries.length > this.limit) this.entries.shift();
    if (persist && cwd) {
      try {
        const dir = path.join(cwd, '.stata-copilot');
        await mkdir(dir, { recursive: true });
        await appendFile(path.join(dir, 'runs.jsonl'), JSON.stringify(row) + '\n', 'utf8');
      } catch {
        /* the ledger is a convenience, never a reason to fail an analysis */
      }
    }
    return row;
  }
}

/** Build the tool table bound to one engine + policy configuration. */
export function createTools({
  engine,
  mode: configuredMode = 'guarded',
  roots = [],
  maxOutputChars = 20_000,
  defaultTimeout = 120,
  persistLedger = true,
}) {
  const ledger = new Ledger();
  const state = { lastGraphs: [], lastRun: null };

  const resolveMode = (requested) => {
    if (!requested) return configuredMode;
    if (!MODES.includes(requested)) return configuredMode;
    const order = { open: 0, guarded: 1, readonly: 2 };
    // A call may tighten the configured mode, never loosen it.
    return order[requested] >= order[configuredMode] ? requested : configuredMode;
  };

  const gate = async (code, { cwd, requestedMode }) => {
    const mode = resolveMode(requestedMode);
    const verdict = checkPolicy(code, { mode });
    const cwdVerdict = checkCwd(cwd, roots);
    if (!verdict.allowed || !cwdVerdict.allowed) {
      const reasons = [
        ...verdict.blocked.map((b) => `[${b.rule}] ${b.why} (command: \`${b.text}\`)`),
        ...(cwdVerdict.allowed ? [] : [cwdVerdict.why]),
      ];
      throw new EngineError('POLICY_BLOCKED', `Blocked by policy (${mode}): ${reasons.join(' ')}`, {
        mode,
        blocked: verdict.blocked,
        cwd: cwdVerdict,
      });
    }
    return verdict;
  };

  const run = async ({ tool, code, cwd, timeout, requestedMode }) => {
    const verdict = await gate(code, { cwd, requestedMode });
    const started = Date.now();
    let result;
    try {
      result = await engine.execute({ code, cwd, timeout });
    } catch (err) {
      await ledger.record(
        { tool, ok: false, error: err.message, code: truncate(code, 400).value, cwd: cwd ?? null, ms: Date.now() - started },
        { cwd, persist: persistLedger },
      );
      throw err;
    }
    const elapsedMs = Date.now() - started;
    state.lastGraphs = result.graphs;
    state.lastRun = { tool, at: new Date().toISOString(), success: result.success };
    const out = truncate(result.output, maxOutputChars);
    await ledger.record(
      {
        tool,
        ok: result.success,
        returnCode: result.returnCode,
        ms: elapsedMs,
        cwd: cwd ?? null,
        code: truncate(code, 400).value,
        graphs: result.graphs.length,
      },
      { cwd, persist: persistLedger },
    );
    return {
      success: result.success,
      returnCode: result.returnCode,
      output: out.value,
      outputTruncated: out.truncated,
      error: result.error || null,
      elapsedMs,
      graphs: result.graphs.map((g) => ({ name: g.name ?? null, png: g.png ?? g.file ?? null, svg: g.svg ?? null, format: g.format ?? (g.png ? 'png' : 'svg') })),
      policy: { mode: verdict.mode, warnings: verdict.warnings },
    };
  };

  const tools = {
    stata_status: {
      title: 'Stata session status',
      description:
        'Report the Stata session state: service reachability, Stata path/version/edition, licence, whether a command is running, and the active policy mode. Call this first when a Stata tool fails.',
      input: {
        type: 'object',
        properties: {
          format: { type: 'string', enum: ['json', 'stata'], description: '`stata` returns the service\'s raw Stata-side report.' },
        },
        additionalProperties: false,
      },
      handler: async ({ format } = {}) => {
        const st = await engine.status({ format });
        const body = {
          reachable: true,
          endpoint: engine.endpoint,
          status: st.status ?? null,
          sessionActive: Boolean(st.sessionActive),
          busy: Boolean(st.busy),
          skillVersion: st.skillVersion ?? null,
          stata: {
            path: st.config?.stataPath ?? null,
            version: st.recommendedCandidate?.version ?? null,
            edition: st.recommendedCandidate?.edition ?? null,
          },
          licenseFound: Boolean(st.licenseFound),
          setup: st.setup ?? null,
          capabilities: st.capabilities ?? null,
          policy: { mode: configuredMode, roots },
          raw: format === 'stata' ? st : undefined,
        };
        return { content: [text(body)] };
      },
    },

    stata_run: {
      title: 'Run Stata code',
      description:
        'Execute a block of Stata commands in the live session and return structured results: success, return code, output transcript (truncated), generated graphs, and policy warnings. Set `cwd` when the code uses relative paths, and raise `timeout` for bootstrap/simulation loops.',
      input: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'Stata commands, newline separated, as they would appear in a do-file.' },
          cwd: { type: 'string', description: 'Working directory applied before the code runs (absolute path).' },
          timeout: { type: 'number', description: 'Seconds before Stata is interrupted (1-600, default 120).' },
          mode: { type: 'string', enum: MODES, description: 'Tighten the policy for this call (can only be stricter than the session mode).' },
        },
        required: ['code'],
        additionalProperties: false,
      },
      handler: async (args) =>
        ({ content: [text(await run({ tool: 'stata_run', code: args.code, cwd: args.cwd, timeout: args.timeout ?? defaultTimeout, requestedMode: args.mode }))] }),
    },

    stata_run_do: {
      title: 'Run a .do file',
      description:
        'Execute an existing do-file. The file must already exist on disk (agents should write the file, not push a giant string through stata_run). cwd defaults to the do-file\'s folder.',
      input: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'Absolute path to the .do file.' },
          cwd: { type: 'string', description: 'Working directory override (default: the do-file folder).' },
          timeout: { type: 'number', description: 'Seconds before Stata is interrupted (1-600, default 300).' },
          mode: { type: 'string', enum: MODES, description: 'Tighten the policy for this call.' },
        },
        required: ['file'],
        additionalProperties: false,
      },
      handler: async (args) => {
        const file = path.resolve(String(args.file));
        if (!existsSync(file)) throw new EngineError('FILE_NOT_FOUND', `No such do-file: ${file}`);
        const body = await readFile(file, 'utf8');
        await gate(body, { cwd: args.cwd, requestedMode: args.mode });
        const result = await run({
          tool: 'stata_run_do',
          code: body,
          cwd: args.cwd ?? path.dirname(file),
          timeout: args.timeout ?? 300,
          requestedMode: args.mode,
        });
        return { content: [text({ file, ...result })] };
      },
    },

    stata_results: {
      title: 'Read stored results',
      description:
        'Return the macros left behind by the last command: r() from `summarize`/`tabulate`-style commands, e() from estimation, s() from `sreturn`. Use it to turn a transcript into numbers.',
      input: {
        type: 'object',
        properties: {
          scope: { type: 'string', enum: ['all', 'r', 'e', 's'], description: 'Which macro scope to read (default all).' },
          cwd: { type: 'string', description: 'Working directory for the read.' },
          timeout: { type: 'number', description: 'Seconds (default 60).' },
        },
        additionalProperties: false,
      },
      handler: async ({ scope = 'all', cwd, timeout } = {}) => {
        const parts = [];
        if (scope === 'all' || scope === 'r') parts.push('return list');
        if (scope === 'all' || scope === 'e') parts.push('ereturn list');
        if (scope === 'all' || scope === 's') parts.push('sreturn list');
        const result = await run({ tool: 'stata_results', code: parts.join('\n'), cwd, timeout: timeout ?? 60 });
        const macros = parseMacroList(result.output);
        return {
          content: [
            text({
              ...result,
              macros: { r: macros.r, e: macros.e, s: macros.s },
              matrices: macros.matrices,
            }),
          ],
        };
      },
    },

    stata_profile_data: {
      title: 'Profile the dataset in memory',
      description:
        'Describe the data the session is holding: source file, observations, variables, and for each variable its type, display format, variable label and number of missing values. Optionally load a dataset first (Stata `sysuse` name or a file path).',
      input: {
        type: 'object',
        properties: {
          dataset: { type: 'string', description: 'Optional: a `sysuse` dataset name (e.g. "auto") or an absolute .dta path to load first.' },
          cwd: { type: 'string', description: 'Working directory (needed when the .dta path is relative or the file needs a libname).' },
          timeout: { type: 'number', description: 'Seconds (default 120).' },
        },
        additionalProperties: false,
      },
      handler: async ({ dataset, cwd, timeout } = {}) => {
        const lines = [];
        if (dataset) {
          lines.push(/\.dta$/i.test(dataset) || /[\\/]/.test(dataset)
            ? `use "${String(dataset).replace(/"/g, '')}", clear`
            : `sysuse ${dataset}, clear`);
        }
        lines.push(
          'describe, short',
          'ds',
          'local __cpl_vars `r(varlist)\'',
          'foreach __cpl_v of local __cpl_vars {',
          '    capture local __cpl_t : type `__cpl_v\'',
          '    capture local __cpl_f : format `__cpl_v\'',
          '    capture local __cpl_l : variable label `__cpl_v\'',
          '    quietly count if missing(`__cpl_v\')',
          '    di "PROFILE|`__cpl_v\'|`__cpl_t\'|`__cpl_f\'|" %12.0g r(N) "|`__cpl_l\'"',
          '}',
        );
        const result = await run({ tool: 'stata_profile_data', code: lines.join('\n'), cwd, timeout: timeout ?? 120 });
        const header = parseDatasetHeader(result.output);
        const variables = parseProfileRows(result.output);
        return {
          content: [
            text({
              ...result,
              dataset: header,
              variableCount: variables.length,
              variables,
            }),
          ],
        };
      },
    },

    stata_model: {
      title: 'Estimate a model and return a coefficient table',
      description:
        'Run one estimation command (e.g. "regress price mpg weight" or "xtreg y x, fe vce(cluster id)") and return a structured coefficient table — b, se, t/z, two-sided p per term — plus fit statistics. Use this instead of reading a regression table out of the transcript.',
      input: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Exactly one Stata estimation command.' },
          cwd: { type: 'string', description: 'Working directory.' },
          timeout: { type: 'number', description: 'Seconds (default 300).' },
          quiet: { type: 'boolean', description: 'Suppress the estimation output in the transcript (default false).' },
        },
        required: ['command'],
        additionalProperties: false,
      },
      handler: async ({ command, cwd, timeout, quiet = false } = {}) => {
        const pre = quiet ? `quietly ${command}` : command;
        const code = [
          pre,
          'mata:',
          '    __cpl_b = st_matrix("e(b)")',
          '    __cpl_V = st_matrix("e(V)")',
          '    __cpl_s = st_matrixcolstripe("e(b)")',
          '    printf("K=%g N=%g df_r=%g\\n", cols(__cpl_b), st_numscalar("e(N)"), st_numscalar("e(df_r)"))',
          '    for (__cpl_j=1; __cpl_j<=cols(__cpl_b); __cpl_j++) {',
          '        printf("ROW|%s|%s|%20.12g|%20.12g\\n", __cpl_s[__cpl_j,1], __cpl_s[__cpl_j,2], __cpl_b[1,__cpl_j], sqrt(__cpl_V[__cpl_j,__cpl_j]))',
          '    }',
          'end',
          'ereturn list',
        ].join('\n');
        const result = await run({ tool: 'stata_model', code, cwd, timeout: timeout ?? 300 });
        if (!result.success) {
          return { content: [text({ ...result, hint: 'The estimation itself failed; read `output` for the Stata error.' })], isError: true };
        }
        const rows = parseCoefficientRows(result.output);
        const head = parseModelHeader(result.output);
        const macros = parseMacroList(result.output).e;
        const df = head.df_r ?? null;
        if (rows.length === 0) {
          return {
            content: [text({ ...result, hint: 'No e(b) found — the command may not be an estimation command, or `, coeflegend`-style output hid the matrix.' })],
            isError: true,
          };
        }
        const estimates = rows.map((r) => {
          const stat = r.se ? r.b / r.se : null;
          return { ...r, t: stat, z: stat, p: studentTwoSidedP(stat, df) };
        });
        const fit = {
          n: macros.N ?? head.n ?? null,
          k: head.k ?? null,
          df_r: df,
          r2: macros.r2 ?? null,
          r2_a: macros.r2_a ?? null,
          F: macros.F ?? null,
          ll: macros.ll ?? null,
          aic: macros.aic ?? null,
          bic: macros.bic ?? null,
          cmdline: macros.cmdline ?? command,
        };
        return { content: [text({ ...result, estimates, fit })] };
      },
    },

    stata_graphs: {
      title: 'Fetch graph images',
      description:
        'Return Stata graphs as images the agent can actually look at. Defaults to the graphs produced by the most recent run; pass explicit file paths to fetch older ones. PNG/JPEG are returned as image content; SVG-only output is reported by path.',
      input: {
        type: 'object',
        properties: {
          files: { type: 'array', items: { type: 'string' }, description: 'Absolute paths to .png/.jpg files. Omit to use the last run\'s graphs.' },
          max: { type: 'number', description: 'Maximum number of images to attach (default 2).' },
        },
        additionalProperties: false,
      },
      handler: async ({ files, max = 2 } = {}) => {
        const candidates = files?.length
          ? files.map((f) => ({ png: f, svg: null, name: path.basename(f) }))
          : state.lastGraphs;
        if (candidates.length === 0) {
          return { content: [text({ images: 0, note: 'No graphs captured yet. Add `graph export output/foo.png, replace width(1200)` to the code, then call stata_graphs.' })] };
        }
        const content = [];
        const reported = [];
        let attached = 0;
        for (const g of candidates.slice(0, Math.max(1, Number(max) || 2))) {
          const png = g.png ?? g.file ?? null;
          const isPng = png && /\.(png|jpe?g)$/i.test(png) && existsSync(png);
          if (isPng && attached < Math.max(1, Number(max) || 2)) {
            const buf = await readFile(png);
            const mimeType = /\.jpe?g$/i.test(png) ? 'image/jpeg' : 'image/png';
            content.push({ type: 'image', data: buf.toString('base64'), mimeType });
            reported.push({ name: g.name ?? null, path: png, bytes: buf.length });
            attached += 1;
          } else {
            reported.push({ name: g.name ?? null, path: png ?? g.svg ?? null, note: 'not attached (SVG or missing file)' });
          }
        }
        content.unshift(text({ images: attached, files: reported }));
        return { content };
      },
    },

    stata_break: {
      title: 'Interrupt the running command',
      description: 'Send a break signal to Stata. Use after a timeout or runaway loop; then verify with stata_status that `busy` is false before running anything else.',
      input: { type: 'object', properties: {}, additionalProperties: false },
      handler: async () => {
        const res = await engine.break();
        let status = null;
        try {
          const st = await engine.status();
          status = { status: st.status ?? null, busy: Boolean(st.busy), sessionActive: Boolean(st.sessionActive) };
        } catch {
          status = null;
        }
        return { content: [text({ interrupted: true, engine: res, status })] };
      },
    },

    stata_history: {
      title: 'Read the run ledger',
      description: 'List commands executed through this server (newest last), with success, return code, duration and cwd. The same rows are appended to `<cwd>/.stata-copilot/runs.jsonl` — a reproducibility trail for the paper.',
      input: {
        type: 'object',
        properties: { limit: { type: 'number', description: 'How many entries (default 20).' } },
        additionalProperties: false,
      },
      handler: async ({ limit = 20 } = {}) => {
        const n = Math.max(1, Math.min(Number(limit) || 20, 200));
        return { content: [text({ total: ledger.entries.length, entries: ledger.entries.slice(-n) })] };
      },
    },
  };

  return {
    tools,
    definitions: Object.entries(tools).map(([name, t]) => ({
      name,
      title: t.title,
      description: t.description,
      inputSchema: t.input,
    })),
    async call(name, args = {}) {
      const tool = tools[name];
      if (!tool) throw new EngineError('UNKNOWN_TOOL', `No such tool: ${name}`);
      return tool.handler(args ?? {});
    },
  };
}
