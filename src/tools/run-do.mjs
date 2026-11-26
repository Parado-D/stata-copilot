import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { text } from '../lib/content.mjs';
import { EngineError } from '../errors.mjs';
import { MODES } from '../policy.mjs';

export default {
  name: 'stata_run_do',
  title: 'Run a .do file',
  description:
    "Execute an existing do-file. The file must already exist on disk (agents should write the file, not push a giant string through stata_run). cwd defaults to the do-file's folder.",
  inputSchema: {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'Absolute path to the .do file.' },
      cwd: { type: 'string', description: 'Working directory override (default: the do-file folder).' },
      timeout: { type: 'number', minimum: 1, maximum: 600, description: 'Seconds before Stata is interrupted (1-600, default 300).' },
      mode: { type: 'string', enum: MODES, description: 'Tighten the policy for this call.' },
    },
    required: ['file'],
    additionalProperties: false,
  },
  async handler(ctx, args) {
    const file = path.resolve(String(args.file));
    if (!existsSync(file)) throw new EngineError('FILE_NOT_FOUND', `No such do-file: ${file}`);
    const body = await readFile(file, 'utf8');
    // The policy reads the file's own statements, so a do-file cannot smuggle
    // a shell escape past a gate that only saw the tool arguments.
    ctx.session.gate(body, { cwd: args.cwd, requestedMode: args.mode });
    const result = await ctx.session.run({
      tool: 'stata_run_do',
      code: body,
      cwd: args.cwd ?? path.dirname(file),
      timeout: args.timeout ?? 300,
      requestedMode: args.mode,
    });
    return { content: [text({ file, ...result })] };
  },
};
