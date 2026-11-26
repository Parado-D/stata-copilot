import { text } from '../lib/content.mjs';
import { parseDatasetHeader, parseProfileRows } from '../parsers/index.mjs';

export default {
  name: 'stata_profile_data',
  title: 'Profile the dataset in memory',
  description:
    'Describe the data the session is holding: source file, observations, variables, and for each variable its type, display format, variable label and number of missing values. Optionally load a dataset first (Stata `sysuse` name or a file path).',
  inputSchema: {
    type: 'object',
    properties: {
      dataset: { type: 'string', description: 'Optional: a `sysuse` dataset name (e.g. "auto") or an absolute .dta path to load first.' },
      cwd: { type: 'string', description: 'Working directory (needed when the .dta path is relative).' },
      timeout: { type: 'number', minimum: 1, maximum: 600, description: 'Seconds (default 120).' },
    },
    additionalProperties: false,
  },
  async handler(ctx, { dataset, cwd, timeout } = {}) {
    const lines = [];
    if (dataset) {
      const isPath = /\.dta$/i.test(dataset) || /[\\/]/.test(dataset);
      lines.push(isPath ? `use "${String(dataset).replace(/"/g, '')}", clear` : `sysuse ${dataset}, clear`);
    }
    lines.push(
      'describe, short',
      'ds',
      "local __cpl_vars `r(varlist)'",
      'foreach __cpl_v of local __cpl_vars {',
      "    capture local __cpl_t : type `__cpl_v'",
      "    capture local __cpl_f : format `__cpl_v'",
      "    capture local __cpl_l : variable label `__cpl_v'",
      "    quietly count if missing(`__cpl_v')",
      '    di "PROFILE|`__cpl_v\'|`__cpl_t\'|`__cpl_f\'|" %12.0g r(N) "|`__cpl_l\'"',
      '}',
    );
    const result = await ctx.session.run({
      tool: 'stata_profile_data',
      code: lines.join('\n'),
      cwd,
      timeout: timeout ?? 120,
    });
    const variables = parseProfileRows(result.output);
    return {
      content: [
        text({
          ...result,
          dataset: parseDatasetHeader(result.output),
          variableCount: variables.length,
          variables,
        }),
      ],
    };
  },
};
