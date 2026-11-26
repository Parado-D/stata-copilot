#!/usr/bin/env node
/**
 * stata-copilot — MCP server that turns an agent into a disciplined Stata analyst.
 *
 * Usage
 *   stata-copilot [--endpoint URL] [--mode guarded|readonly|open]
 *                 [--root DIR ...] [--timeout SECONDS] [--max-output CHARS]
 *                 [--no-ledger] [--version] [--help]
 *
 * Environment
 *   STATA_COPILOT_ENDPOINT   engine base URL (default http://127.0.0.1:19522)
 *   STATA_COPILOT_MODE       open | guarded | readonly (default guarded)
 *   STATA_COPILOT_ROOTS      path-separated list of allowed working directories
 */

import path from 'node:path';
import { Engine } from '../src/engine.mjs';
import { createTools } from '../src/tools.mjs';
import { createServer, serveStdio, SERVER_INFO } from '../src/server.mjs';
import { MODES } from '../src/policy.mjs';

const HELP = `stata-copilot ${SERVER_INFO.version} — MCP server for Stata analysis

Options
  --endpoint <url>     Stata AI Skill service (default $STATA_COPILOT_ENDPOINT or http://127.0.0.1:19522)
  --mode <mode>        open | guarded | readonly (default guarded)
  --root <dir>         Allowed working directory; repeatable. Defaults to $STATA_COPILOT_ROOTS
  --timeout <seconds>  Default Stata timeout (default 120)
  --max-output <n>     Max transcript characters returned per call (default 20000)
  --no-ledger          Do not append .stata-copilot/runs.jsonl under the run cwd
  --version            Print version
  --help               Print this help

The server speaks MCP over stdio. Configure it in your client, e.g.
  { "mcpServers": { "stata": { "command": "npx", "args": ["-y", "stata-copilot"] } } }
`;

function parseArgs(argv) {
  const opts = {
    endpoint: process.env.STATA_COPILOT_ENDPOINT || 'http://127.0.0.1:19522',
    mode: process.env.STATA_COPILOT_MODE || 'guarded',
    roots: process.env.STATA_COPILOT_ROOTS ? process.env.STATA_COPILOT_ROOTS.split(path.delimiter).filter(Boolean) : [],
    timeout: 120,
    maxOutput: 20_000,
    persistLedger: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`Missing value for ${arg}`);
      return v;
    };
    switch (arg) {
      case '--endpoint': opts.endpoint = next(); break;
      case '--mode': opts.mode = next(); break;
      case '--root': opts.roots.push(next()); break;
      case '--timeout': opts.timeout = Number(next()); break;
      case '--max-output': opts.maxOutput = Number(next()); break;
      case '--no-ledger': opts.persistLedger = false; break;
      case '--version': console.log(SERVER_INFO.version); process.exit(0); break;
      case '--help': case '-h': console.log(HELP); process.exit(0); break;
      default:
        if (arg.startsWith('-')) {
          process.stderr.write(`[stata-copilot] unknown option: ${arg}\n`);
          process.exit(2);
        }
    }
  }
  if (!MODES.includes(opts.mode)) {
    process.stderr.write(`[stata-copilot] unknown mode "${opts.mode}" (use ${MODES.join('|')})\n`);
    process.exit(2);
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const engine = new Engine({ endpoint: opts.endpoint });
const registry = createTools({
  engine,
  mode: opts.mode,
  roots: opts.roots,
  defaultTimeout: opts.timeout,
  maxOutputChars: opts.maxOutput,
  persistLedger: opts.persistLedger,
});
const server = createServer({ registry });

process.stderr.write(
  `[stata-copilot] v${SERVER_INFO.version} ready — engine ${opts.endpoint}, mode ${opts.mode}` +
    `${opts.roots.length ? `, roots ${opts.roots.join(',')}` : ''}\n`,
);

serveStdio(server);
