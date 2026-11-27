import path from 'node:path';

import { text } from '../lib/content.mjs';

export default {
  name: 'stata_job_kill',
  title: 'Stop a background job',
  description:
    'Terminate a background Stata job by its id and return the final state. Prefer this over guessing: a stuck imputation or an accidental `while` loop is one call away from being stopped, and the log written so far is kept.',
  inputSchema: {
    type: 'object',
    properties: {
      jobId: { type: 'string', description: 'Job id from stata_job_submit.' },
      cwd: { type: 'string', description: 'Directory the job was submitted in (default: the server working directory).' },
    },
    required: ['jobId'],
    additionalProperties: false,
  },
  async handler(ctx, args) {
    const cwd = path.resolve(String(args.cwd ?? '.'));
    const job = await ctx.jobs.kill(String(args.jobId), cwd);
    return { content: [text({ ...job, hint: job.state === 'killed' ? 'Killed. Its log is still on disk.' : `Nothing to kill —state is ${job.state}.` })] };
  },
};
