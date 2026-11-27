import path from 'node:path';

import { text } from '../lib/content.mjs';

export default {
  name: 'stata_job_log',
  title: 'Read a background job log',
  description:
    'Return the tail of the log a background job is writing (Stata batch writes <do-file>.log next to the do-file). Use it to see progress —counts, the current table, a long imputation step —while the job is still running.',
  inputSchema: {
    type: 'object',
    properties: {
      jobId: { type: 'string', description: 'Job id from stata_job_submit.' },
      cwd: { type: 'string', description: 'Directory the job was submitted in (default: the server working directory).' },
      tail: { type: 'number', minimum: 200, maximum: 60_000, description: 'Characters from the end (default 8000).' },
    },
    required: ['jobId'],
    additionalProperties: false,
  },
  async handler(ctx, args) {
    const cwd = path.resolve(String(args.cwd ?? '.'));
    const log = await ctx.jobs.log(String(args.jobId), cwd, args.tail ?? 8000);
    return { content: [text(log)] };
  },
};
