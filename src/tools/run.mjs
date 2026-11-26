import { text } from '../lib/content.mjs';
import { MODES } from '../policy.mjs';

export default {
  name: 'stata_run',
  title: 'Run Stata code',
  description:
    'Execute a block of Stata commands in the live session and return structured results: success, return code, output transcript (truncated), generated graphs, and policy warnings. Set `cwd` when the code uses relative paths, and raise `timeout` for bootstrap/simulation loops.',
  inputSchema: {
    type: 'object',
    properties: {
      code: { type: 'string', description: 'Stata commands, newline separated, as they would appear in a do-file.' },
      cwd: { type: 'string', description: 'Working directory applied before the code runs (absolute path).' },
      timeout: { type: 'number', minimum: 1, maximum: 600, description: 'Seconds before Stata is interrupted (1-600, default 120).' },
      mode: { type: 'string', enum: MODES, description: 'Tighten the policy for this call (can only be stricter than the session mode).' },
    },
    required: ['code'],
    additionalProperties: false,
  },
  async handler(ctx, args) {
    const result = await ctx.session.run({
      tool: 'stata_run',
      code: args.code,
      cwd: args.cwd,
      timeout: args.timeout ?? ctx.session.defaultTimeout,
      requestedMode: args.mode,
    });
    return { content: [text(result)] };
  },
};
