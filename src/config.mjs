/**
 * Configuration: CLI flags and environment variables in one table.
 *
 * The table is the single source of truth for the parser, `--help`, and the
 * `--doctor` report, so a new option cannot be accepted-but-undocumented. Each
 * option declares its flag, placeholder, env var, default and type; parsing is
 * generic and rejects unknown flags instead of silently ignoring typos.
 */

import path from 'node:path';

import { ENGINE_DRIVERS, DEFAULT_ENDPOINT } from './engines/index.mjs';
import { DEFAULT_STATA_EXE } from './jobs.mjs';
import { LOG_LEVELS } from './log.mjs';
import { MODES } from './policy.mjs';

/**
 * @typedef {object} OptionSpec
 * @property {string} key        config property
 * @property {string} flag       CLI flag, also the switch that sets it
 * @property {string} [placeholder]
 * @property {string} [env]
 * @property {any} default
 * @property {'string'|'number'|'boolean'|'paths'} [type]
 * @property {string[]} [choices]
 * @property {boolean} [repeatable]
 * @property {string} help
 */

/** @type {OptionSpec[]} */
export const CONFIG_OPTIONS = [
  {
    key: 'endpoint', flag: '--endpoint', placeholder: '<url>', env: 'STATA_COPILOT_ENDPOINT',
    default: DEFAULT_ENDPOINT, type: 'string',
    help: 'Stata AI Skill service base URL.',
  },
  {
    key: 'driver', flag: '--driver', placeholder: '<name>', env: 'STATA_COPILOT_DRIVER',
    default: 'http', type: 'string', choices: ENGINE_DRIVERS,
    help: `Engine backend (${ENGINE_DRIVERS.join('|')}).`,
  },
  {
    key: 'mode', flag: '--mode', placeholder: '<mode>', env: 'STATA_COPILOT_MODE',
    default: 'guarded', type: 'string', choices: MODES,
    help: 'Policy mode: open allows everything, guarded refuses shell/destructive commands, readonly also refuses disk writes.',
  },
  {
    key: 'roots', flag: '--root', placeholder: '<dir>', env: 'STATA_COPILOT_ROOTS',
    default: [], type: 'paths', repeatable: true,
    help: 'Allowed working directory; repeatable. When set, a run may not set cwd outside these.',
  },
  {
    key: 'defaultTimeout', flag: '--timeout', placeholder: '<seconds>', env: 'STATA_COPILOT_TIMEOUT',
    default: 120, type: 'number',
    help: 'Default Stata timeout in seconds (1-600).',
  },
  {
    key: 'maxOutputChars', flag: '--max-output', placeholder: '<chars>', env: 'STATA_COPILOT_MAX_OUTPUT',
    default: 20_000, type: 'number',
    help: 'Maximum transcript characters returned per call.',
  },
  {
    key: 'persistLedger', flag: '--no-ledger', placeholder: '', env: 'STATA_COPILOT_NO_LEDGER',
    default: true, type: 'boolean',
    help: 'Do not append .stata-copilot/runs.jsonl under the run cwd.',
  },
  {
    key: 'stataExe', flag: '--stata-exe', placeholder: '<path>', env: 'STATA_COPILOT_STATA_EXE',
    default: DEFAULT_STATA_EXE, type: 'string',
    help: 'Stata executable used for background jobs (a separate batch process).',
  },
  {
    key: 'jobTimeout', flag: '--job-timeout', placeholder: '<seconds>', env: 'STATA_COPILOT_JOB_TIMEOUT',
    default: 1800, type: 'number',
    help: 'Wall-clock ceiling for a background job (10-86400).',
  },
  {
    key: 'logLevel', flag: '--log-level', placeholder: '<level>', env: 'STATA_COPILOT_LOG',
    default: 'info', type: 'string', choices: LOG_LEVELS,
    help: `stderr log level (${LOG_LEVELS.join('|')}).`,
  },
];

const BY_FLAG = new Map(CONFIG_OPTIONS.map((option) => [option.flag, option]));

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

function coerce(option, raw) {
  if (option.type === 'number') {
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new ConfigError(`${option.flag} expects a number, got "${raw}"`);
    if (option.key === 'defaultTimeout' && (value < 1 || value > 600)) {
      throw new ConfigError(`${option.flag} must be between 1 and 600 seconds`);
    }
    if (option.key === 'maxOutputChars' && value < 1000) {
      throw new ConfigError(`${option.flag} must be at least 1000 characters`);
    }
    if (option.key === 'jobTimeout' && (value < 10 || value > 86_400)) {
      throw new ConfigError(`${option.flag} must be between 10 and 86400 seconds`);
    }
    return value;
  }
  if (option.choices && !option.choices.includes(raw)) {
    throw new ConfigError(`${option.flag} expects one of ${option.choices.join('|')}, got "${raw}"`);
  }
  return raw;
}

function fromEnv(option, env) {
  const raw = env[option.env];
  if (raw === undefined || raw === '') return undefined;
  if (option.type === 'boolean') return !/^(0|false|no)$/i.test(raw);
  if (option.type === 'paths') return raw.split(path.delimiter).filter(Boolean);
  if (option.type === 'number') return Number(raw);
  return raw;
}

/**
 * @param {string[]} argv  arguments after the executable
 * @param {Record<string,string|undefined>} [env]
 * @returns {{ action: 'run'|'help'|'version'|'doctor', config: object }}
 */
export function parseConfig(argv = [], env = process.env) {
  const config = {};
  for (const option of CONFIG_OPTIONS) {
    const fromEnvironment = fromEnv(option, env);
    config[option.key] = fromEnvironment !== undefined ? fromEnvironment : option.default;
    if (option.type === 'paths' && !Array.isArray(config[option.key])) config[option.key] = [];
  }
  let action = 'run';

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      action = 'help';
      continue;
    }
    if (arg === '--version' || arg === '-v') {
      action = 'version';
      continue;
    }
    if (arg === '--doctor') {
      action = 'doctor';
      continue;
    }
    const [flag, inline] = arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    const option = BY_FLAG.get(flag);
    if (!option) throw new ConfigError(`unknown option "${arg}" (try --help)`);
    if (option.type === 'boolean') {
      // Presence switches it off (`--no-ledger`); `--no-ledger=0` leaves it on.
      config[option.key] = inline === undefined ? false : !/^(0|false|no)$/i.test(inline);
      continue;
    }
    const raw = inline ?? argv[++i];
    if (raw === undefined) throw new ConfigError(`${flag} expects a value`);
    if (option.type === 'paths') {
      if (!Array.isArray(config[option.key]) || config[option.key] === option.default) config[option.key] = [];
      config[option.key] = [...config[option.key], raw];
      continue;
    }
    config[option.key] = coerce(option, raw);
  }
  return { action, config };
}

export function helpText({ name = 'stata-copilot', version = '' } = {}) {
  const lines = [`${name} ${version} — MCP server for Stata analysis`, '', 'Usage', `  ${name} [options]`, '', 'Options'];
  for (const option of CONFIG_OPTIONS) {
    const head = `  ${option.flag}${option.placeholder ? ' ' + option.placeholder : ''}`.padEnd(30);
    lines.push(`${head}${option.help}`);
    const meta = [];
    if (option.env) meta.push(`env ${option.env}`);
    meta.push(`default ${Array.isArray(option.default) ? '(none)' : JSON.stringify(option.default)}`);
    lines.push(`${' '.repeat(30)}(${meta.join('; ')})`);
  }
  lines.push(
    '  --doctor'.padEnd(30) + 'Check configuration and engine reachability, print a JSON report, exit.',
    '  --version'.padEnd(30) + 'Print the version.',
    '  --help'.padEnd(30) + 'Print this help.',
    '',
    'The server speaks MCP over stdio. Configure it in your client, e.g.',
    `  { "mcpServers": { "stata": { "command": "node", "args": ["${'<repo>'}/bin/stata-copilot.mjs"] } } }`,
    '',
  );
  return lines.join('\n');
}
