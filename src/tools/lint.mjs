import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { EngineError } from '../errors.mjs';
import { text } from '../lib/content.mjs';
import { lintCode } from '../lint.mjs';

/**
 * Static review before Stata sees the code. This tool never runs anything, so
 * it is safe in `readonly` mode and cheap enough to call on every draft.
 */
export default {
  name: 'stata_lint',
  title: 'Lint Stata code before running it',
  description:
    'Check Stata code for constructs that run without an error yet do the wrong thing: the `if` command (first observation only), `_n` without a sort, `gen` on an existing variable, undeclared locals, `missing(a b c)` as a varlist, variable abbreviation left on. Pass `code` or `file`. Errors block, warnings do not: the caller decides.',
  inputSchema: {
    type: 'object',
    properties: {
      code: { type: 'string', description: 'Stata code to review.' },
      file: { type: 'string', description: 'Path to a .do file to review instead of `code`.' },
      cwd: { type: 'string', description: 'Working directory used to resolve `do "other.do"` references.' },
    },
    additionalProperties: false,
  },
  async handler(ctx, args) {
    if (!args.code && !args.file) {
      throw new EngineError('INVALID_ARGS', 'Pass `code` or `file` to review.');
    }
    const file = args.file ? path.resolve(String(args.file)) : null;
    if (file && !existsSync(file)) throw new EngineError('FILE_NOT_FOUND', `No such do-file: ${file}`);
    const source = file ? await readFile(file, 'utf8') : String(args.code ?? '');
    const cwd = args.cwd ?? (file ? path.dirname(file) : null);
    const report = lintCode(source, { file, cwd });
    return {
      content: [
        text({
          file,
          ...report,
          summary: `${report.counts.error} error(s), ${report.counts.warning} warning(s), ${report.counts.info} note(s)`,
        }),
      ],
      isError: !report.ok,
    };
  },
};
