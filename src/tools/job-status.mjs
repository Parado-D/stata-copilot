import path from 'node:path';

import { text } from '../lib/content.mjs';

export default {
  name: 'stata_job_status',
  title: 'Check a background job',
  description:
    'Report one background Stata job: state (running/ok/failed/timedout/killed), elapsed time, return code, the first Stata error if the do-file aborted, and the tail of its log. Call it in a loop with a pause between calls instead of blocking on a long run.',
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
    const job = await ctx.jobs.status(String(args.jobId), cwd);
    const hint = job.state === 'running'
      ? 'Still running. Wait a few seconds, then call stata_job_status again; do not resubmit.'
      : job.state === 'ok'
        ? 'Finished with returnCode 0. Read the log or the produced files.'
        : job.state === 'failed'
          ? `Aborted at ${job.failure?.code ?? 'an error'}${job.failure?.command ? ` in \`${job.failure.command}\`` : ''}. Fix, then resubmit.`
          : job.state === 'timedout'
            ? 'Killed by its timeout. Raise stata_job_submit.timeout only if the work is genuinely that long.'
            : 'Killed on request.';
    return { content: [text({ ...job, hint })] };
  },
};
