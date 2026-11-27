import { text } from '../lib/content.mjs';
import {
  parseCoefficientRows,
  parseMacroList,
  parseModelHeader,
  studentTwoSidedP,
} from '../parsers/index.mjs';

/**
 * Why Mata: `e(b)` and `e(V)` are matrices, and the printed regression table
 * is a lossy rendering of them (stars, footnotes, wrapped names). Reading the
 * matrices gives b, se and a confidence interval at full precision, and works
 * the same for regress, xtreg, ivregress, margins and anything else that leaves
 * e(b) behind.
 *
 * `st_matrixcolstripe("e(b)")` is k×2 — one row per coefficient, columns
 * equation and variable name — not 2×k. Indexing it as [1, j] is what made the
 * first version fail with r(3301).
 *
 * The interval uses the model's own critical value: `e(df_r)` when the model
 * reports one (t), otherwise the normal 1.96 (z). It is computed here rather
 * than in JavaScript so the number is the one Stata itself would print, and so
 * a caller never has to know which family the model belongs to (Stata tip 53).
 */
const MATA_BLOCK = [
  'mata:',
  '    __cpl_b = st_matrix("e(b)")',
  '    __cpl_V = st_matrix("e(V)")',
  '    __cpl_s = st_matrixcolstripe("e(b)")',
  '    __cpl_df = st_numscalar("e(df_r)")',
  '    if (__cpl_df < .) {',
  '        __cpl_crit = invttail(__cpl_df, 0.025)',
  '    }',
  '    else {',
  '        __cpl_crit = invnormal(0.975)',
  '    }',
  '    printf("K=%g N=%g df_r=%g crit=%12.9g\\n", cols(__cpl_b), st_numscalar("e(N)"), __cpl_df, __cpl_crit)',
  '    for (__cpl_j=1; __cpl_j<=cols(__cpl_b); __cpl_j++) {',
  '        __cpl_se = sqrt(__cpl_V[__cpl_j,__cpl_j])',
  '        printf("ROW|%s|%s|%20.12g|%20.12g|%20.12g|%20.12g\\n", __cpl_s[__cpl_j,1], __cpl_s[__cpl_j,2], __cpl_b[1,__cpl_j], __cpl_se, __cpl_b[1,__cpl_j]-__cpl_crit*__cpl_se, __cpl_b[1,__cpl_j]+__cpl_crit*__cpl_se)',
  '    }',
  'end',
];

export default {
  name: 'stata_model',
  title: 'Estimate a model and return a coefficient table',
  description:
    'Run one estimation command (e.g. "regress price mpg weight" or "xtreg y x, fe vce(cluster id)") and return a structured coefficient table — b, se, t/z, two-sided p per term — plus fit statistics. Use this instead of reading a regression table out of the transcript.',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', minLength: 1, description: 'Exactly one Stata estimation command.' },
      cwd: { type: 'string', description: 'Working directory.' },
      timeout: { type: 'number', minimum: 1, maximum: 600, description: 'Seconds (default 300).' },
      quiet: { type: 'boolean', description: 'Suppress the estimation output in the transcript (default false).' },
    },
    required: ['command'],
    additionalProperties: false,
  },
  async handler(ctx, { command, cwd, timeout, quiet = false } = {}) {
    const code = [quiet ? `quietly ${command}` : command, ...MATA_BLOCK, 'ereturn list'].join('\n');
    const result = await ctx.session.run({ tool: 'stata_model', code, cwd, timeout: timeout ?? 300 });
    if (!result.success) {
      return {
        content: [text({ ...result, hint: 'The estimation itself failed; read `output` for the Stata error.' })],
        isError: true,
      };
    }
    const rows = parseCoefficientRows(result.output);
    const head = parseModelHeader(result.output);
    const macros = parseMacroList(result.output).e;
    if (rows.length === 0) {
      return {
        content: [
          text({
            ...result,
            hint: 'No e(b) found — the command may not be an estimation command, or the model was not fitted (read `output`).',
          }),
        ],
        isError: true,
      };
    }
    const df = head.df_r ?? null;
    const estimates = rows.map((row) => {
      const stat = row.se ? row.b / row.se : null;
      // `t` for models with residual df, `z` for the ones that report z; both
      // keys are present so a caller never has to probe which family it is in.
      return {
        ...row,
        t: stat,
        z: stat,
        p: row.omitted ? null : studentTwoSidedP(stat, df),
      };
    });
    const fit = {
      n: macros.N ?? head.n ?? null,
      k: head.k ?? null,
      df_r: df,
      crit: head.crit ?? null,
      r2: macros.r2 ?? null,
      r2_a: macros.r2_a ?? null,
      F: macros.F ?? null,
      ll: macros.ll ?? null,
      aic: macros.aic ?? null,
      bic: macros.bic ?? null,
      cmdline: macros.cmdline ?? command,
      omitted: estimates.filter((e) => e.omitted).map((e) => e.term),
    };
    return { content: [text({ ...result, estimates, fit })] };
  },
};
