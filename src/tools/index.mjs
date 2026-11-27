/**
 * The tool registry.
 *
 * A tool is a plain object: {name, title, description, inputSchema, handler}.
 * This file does three things only — assemble the list, check each definition
 * at startup, and route `tools/call` through argument validation.
 *
 * Adding a tool:
 *   1. create src/tools/<name>.mjs with that default export;
 *   2. import it into TOOL_MODULES below;
 *   3. run `npm test` — the contract test checks the definition, and
 *      `npm run test:stata` exercises it against the live session.
 * Full recipe: docs/EXTENDING.md.
 */

import { silentLogger } from '../log.mjs';
import { EngineError } from '../errors.mjs';
import { assertSchema, validateArgs } from '../lib/schema.mjs';
import { Session } from '../session.mjs';
import { JobStore } from '../jobs.mjs';

import status from './status.mjs';
import run from './run.mjs';
import runDo from './run-do.mjs';
import results from './results.mjs';
import profile from './profile.mjs';
import model from './model.mjs';
import graphs from './graphs.mjs';
import breakTool from './break.mjs';
import history from './history.mjs';
import lint from './lint.mjs';
import signature from './signature.mjs';
import jobSubmit from './job-submit.mjs';
import jobStatus from './job-status.mjs';
import jobLog from './job-log.mjs';
import jobKill from './job-kill.mjs';
import jobList from './job-list.mjs';

export const TOOL_MODULES = [
  status,
  run,
  runDo,
  results,
  profile,
  model,
  graphs,
  breakTool,
  history,
  lint,
  signature,
  jobSubmit,
  jobStatus,
  jobLog,
  jobKill,
  jobList,
];

const NAME_PATTERN = /^[a-z][a-z0-9_]{2,40}$/;

/** Fail fast on a malformed tool definition — it is a code bug, not a usage error. */
export function assertTool(tool, where = 'tool') {
  const fail = (message) => {
    throw new EngineError('TOOL_DEFINITION', `${where}: ${message}`);
  };
  if (!tool || typeof tool !== 'object') fail('must export an object');
  if (!NAME_PATTERN.test(tool.name ?? '')) fail(`name must match ${NAME_PATTERN}, got "${tool.name}"`);
  if (typeof tool.title !== 'string' || tool.title.length < 3) fail('title is required');
  if (typeof tool.description !== 'string' || tool.description.length < 40) {
    fail('description must be at least 40 characters — the agent routes on it');
  }
  if (tool.inputSchema?.type !== 'object') fail('inputSchema.type must be "object"');
  if (typeof tool.handler !== 'function') fail('handler must be a function');
  try {
    assertSchema(tool.inputSchema, `${tool.name}.inputSchema`);
  } catch (err) {
    fail(err.message);
  }
  return tool;
}

/**
 * @param {{engine: object, session: Session, config: object, log: object}} context
 * @param {object[]} modules
 */
export function createRegistry(context, modules = TOOL_MODULES) {
  const tools = Object.create(null);
  for (const [index, module] of modules.entries()) {
    const tool = assertTool(module, `tool[${index}]`);
    if (tools[tool.name]) {
      throw new EngineError('TOOL_DEFINITION', `duplicate tool name "${tool.name}"`);
    }
    tools[tool.name] = tool;
  }

  return {
    tools,
    definitions: Object.values(tools).map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),

    async call(name, args = {}) {
      const tool = tools[name];
      if (!tool) {
        throw new EngineError('UNKNOWN_TOOL', `No such tool: ${name}`, {
          available: Object.keys(tools),
        });
      }
      const problems = validateArgs(tool.inputSchema, args ?? {}, name);
      if (problems.length) {
        throw new EngineError('INVALID_ARGS', `Invalid arguments for ${name}: ${problems.join('; ')}`, {
          problems,
        });
      }
      return tool.handler(context, args ?? {});
    },
  };
}

/** Build the registry bound to one engine + policy configuration. */
export function createTools(options = {}) {
  const session = options.session ?? new Session(options);
  const jobs =
    options.jobs ??
    new JobStore({
      stataExe: options.stataExe,
      defaultTimeout: options.jobTimeout,
      log: options.log ?? null,
      probe: () => session.engine.status(),
    });
  const context = {
    engine: session.engine,
    session,
    jobs,
    config: options,
    log: options.log ?? silentLogger,
  };
  const registry = createRegistry(context, options.modules ?? TOOL_MODULES);
  return { ...registry, session, jobs };
}
