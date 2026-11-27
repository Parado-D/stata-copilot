import path from 'node:path';

import { text } from '../lib/content.mjs';

export default {
  name: 'stata_job_list',
  title: 'List background jobs',
  description:
    'List the background Stata jobs recorded under the given working directory, newest first, with their state and duration. Use it after a restart to find a job whose id you no longer have.',
  inputSchema: {
    type: 'object',
    properties: {
      cwd: { type: 'string', description: 'Directory to list jobs from (default: ".").' },
      limit: { type: 'number', minimum: 1, maximum: 200, description: 'Maximum jobs to return (default 20).' },
    },
    additionalProperties: false,
  },
  async handler(ctx, args) {
    const cwd = path.resolve(String(args.cwd ?? '.'));
    const jobs = await ctx.jobs.list(cwd, args.limit ?? 20);
    return { content: [text({ cwd, count: jobs.length, jobs })] };
  },
};
