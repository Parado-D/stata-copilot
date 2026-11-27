import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { text } from '../lib/content.mjs';
import { EngineError } from '../errors.mjs';
import { MODES } from '../policy.mjs';
import { submitJob } from './job-submit.mjs';

export default {
  name: 'stata_run_do',
  title: 'Run a .do file',
  description:
    "Execute an existing do-file. The file must already exist on disk (agents should write the file, not push a giant string through stata_run). cwd defaults to the do-file's folder. Set background:true to run it as a separate Stata process and get a job id back instead of waiting.",
  inputSchema: {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'Absolute path to the .do file.' },
      cwd: { type: 'string', description: 'Working directory override (default: the do-file folder).' },
      timeout: { type: 'number', minimum: 1, maximum: 600, description: 'Seconds before Stata is interrupted (1-600, default 300). Ignored in background mode, which takes up to 86400.' },
      mode: { type: 'string', enum: MODES, description: 'Tighten the policy for this call.' },
      background: { type: 'boolean', description: 'Run as a background job; returns a job id instead of the transcript.' },
      label: { type: 'string', description: 'Label for the background job.' },
    },
    required: ['file'],
    additionalProperties: false,
  },
  async handler(ctx, args) {
    if (args.background) {
      const job = await submitJob(ctx, {
        file: args.file,
        cwd: args.cwd,
        mode: args.mode,
        label: args.label,
        timeout: ctx.config?.jobTimeout,
      });
      return {
        content: [
          text({
            ...job,
            hint: 'Submitted in the background. Poll stata_job_status, read stata_job_log, or stop it with stata_job_kill.',
          }),
        ],
      };
    }

    const file = path.resolve(String(args.file));
    if (!existsSync(file)) throw new EngineError('FILE_NOT_FOUND', `No such do-file: ${file}`);
    const body = await readFile(file, 'utf8');
    // The policy reads the file's own statements, so a do-file cannot smuggle
    // a shell escape past a gate that only saw the tool arguments.
    ctx.session.gate(body, { cwd: args.cwd, requestedMode: args.mode });
    const result = await ctx.session.run({
      tool: 'stata_run_do',
      // The body is what the policy sees; `file` is what Stata runs, so relative
      // paths, `do` semantics and native graph export behave exactly as they do
      // in a plain Stata session.
      code: body,
      file,
      cwd: args.cwd ?? path.dirname(file),
      timeout: args.timeout ?? 300,
      requestedMode: args.mode,
    });
    return { content: [text({ file, ...result })] };
  },
};
