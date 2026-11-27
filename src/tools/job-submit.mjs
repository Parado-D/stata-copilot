import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { text } from '../lib/content.mjs';
import { EngineError } from '../errors.mjs';
import { MODES } from '../policy.mjs';

/**
 * Shared by `stata_job_submit` and `stata_run_do {background:true}`: the policy
 * sees the do-file's own statements, then the file runs in its own process.
 */
export async function submitJob(ctx, args) {
  const file = path.resolve(String(args.file));
  if (!existsSync(file)) throw new EngineError('FILE_NOT_FOUND', `No such do-file: ${file}`);
  const body = await readFile(file, 'utf8');
  const cwd = args.cwd ? path.resolve(String(args.cwd)) : path.dirname(file);
  ctx.session.gate(body, { cwd, requestedMode: args.mode });
  const timeout = args.timeout ?? ctx.config?.jobTimeout ?? ctx.jobs.defaultTimeout;
  return ctx.jobs.submit({ file, body, cwd, label: args.label ?? null, timeout });
}

export default {
  name: 'stata_job_submit',
  title: 'Start a do-file in the background',
  description:
    'Run a do-file as its own Stata process and return a job id immediately. Use this for analyses that take longer than a couple of minutes: the HTTP service is single-threaded (it answers 409 while busy) and caps each call, while a job has no ceiling and leaves the interactive session free. Poll with stata_job_status.',
  inputSchema: {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'Absolute path to the .do file.' },
      cwd: { type: 'string', description: 'Working directory override (default: the do-file folder).' },
      label: { type: 'string', description: 'Short human label shown in stata_job_list.' },
      timeout: {
        type: 'number',
        minimum: 10,
        maximum: 86_400,
        description: 'Wall-clock ceiling in seconds before the job is killed (default 1800).',
      },
      mode: { type: 'string', enum: MODES, description: 'Tighten the policy for this call.' },
    },
    required: ['file'],
    additionalProperties: false,
  },
  async handler(ctx, args) {
    const job = await submitJob(ctx, args);
    return {
      content: [
        text({
          ...job,
          hint: 'Running in its own Stata process. Poll stata_job_status, read stata_job_log, or stop it with stata_job_kill.',
        }),
      ],
    };
  },
};
