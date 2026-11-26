import { text } from '../lib/content.mjs';
import { parseMacroList } from '../parsers/index.mjs';

export default {
  name: 'stata_results',
  title: 'Read stored results',
  description:
    'Return the macros left behind by the last command: r() from `summarize`/`tabulate`-style commands, e() from estimation, s() from `sreturn`. Use it to turn a transcript into numbers.',
  inputSchema: {
    type: 'object',
    properties: {
      scope: { type: 'string', enum: ['all', 'r', 'e', 's'], description: 'Which macro scope to read (default all).' },
      cwd: { type: 'string', description: 'Working directory for the read.' },
      timeout: { type: 'number', minimum: 1, maximum: 600, description: 'Seconds (default 60).' },
    },
    additionalProperties: false,
  },
  async handler(ctx, { scope = 'all', cwd, timeout } = {}) {
    const parts = [];
    if (scope === 'all' || scope === 'r') parts.push('return list');
    if (scope === 'all' || scope === 'e') parts.push('ereturn list');
    if (scope === 'all' || scope === 's') parts.push('sreturn list');
    const result = await ctx.session.run({
      tool: 'stata_results',
      code: parts.join('\n'),
      cwd,
      timeout: timeout ?? 60,
    });
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
};
