#!/usr/bin/env node
/**
 * Entry point: parse configuration, build the engine and the tool registry, and
 * serve MCP over stdio.
 *
 *   node bin/stata-copilot.mjs                 # serve
 *   node bin/stata-copilot.mjs --doctor        # JSON diagnostic, no server
 *   node bin/stata-copilot.mjs --help
 *
 * Nothing is written to stdout except MCP frames; diagnostics go to stderr.
 */

import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { PACKAGE_NAME, VERSION, SERVER_INFO } from '../src/version.mjs';
import { parseConfig, helpText, ConfigError } from '../src/config.mjs';
import { createEngine, resolveDriver } from '../src/engines/index.mjs';
import { createTools } from '../src/tools/index.mjs';
import { createServer, serveStdio } from '../src/server.mjs';
import { createLogger } from '../src/log.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

async function main(argv) {
  let parsed;
  try {
    parsed = parseConfig(argv);
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${PACKAGE_NAME}: ${err.message}\n`);
      return 2;
    }
    throw err;
  }

  const { action, config } = parsed;
  if (action === 'help') {
    process.stdout.write(helpText({ name: PACKAGE_NAME, version: VERSION }));
    return 0;
  }
  if (action === 'version') {
    process.stdout.write(`${PACKAGE_NAME} ${VERSION}\n`);
    return 0;
  }

  const log = createLogger({ level: action === 'doctor' ? 'error' : config.logLevel });
  const resolved = resolveDriver({ driver: config.driver, stataHome: config.stataHome ?? undefined, python: config.python });
  if (config.driver === 'auto' && resolved.detection) {
    log.info(`driver auto → ${resolved.driver} (${resolved.detection.reason})`);
  }
  log.info(`${PACKAGE_NAME} ${VERSION} (${action}) driver=${resolved.driver} endpoint=${config.endpoint} mode=${config.mode}`);

  let engine;
  try {
    engine = createEngine({
      driver: resolved.driver,
      endpoint: config.endpoint,
      stataHome: resolved.detection?.stataHome ?? config.stataHome ?? undefined,
      python: resolved.detection?.python ?? config.python,
      edition: config.edition,
      log,
    });
  } catch (err) {
    log.error(`cannot create engine: ${err.message}`);
    return 2;
  }

  if (action === 'doctor') {
    const report = await diagnose({ engine, config, resolved });
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return report.reachable ? 0 : 1;
  }

  const registry = createTools({ ...config, engine, log });
  const server = createServer({ registry, log });
  log.info('serving MCP over stdio');
  serveStdio(server, { log, onExit: () => log.info('stdio closed, exiting') });
  return null; // the process stays alive until the client closes the pipe
}

/** `--doctor`: one JSON object explaining this installation, never throws. */
async function diagnose({ engine, config, resolved }) {
  const report = {
    name: PACKAGE_NAME,
    version: VERSION,
    serverInfo: SERVER_INFO,
    entry: path.join(HERE, 'stata-copilot.mjs'),
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    config: {
      endpoint: config.endpoint,
      driver: config.driver,
      driverResolved: resolved?.driver ?? config.driver,
      autoDetection: resolved?.detection ?? null,
      mode: config.mode,
      roots: config.roots,
      defaultTimeout: config.defaultTimeout,
      maxOutputChars: config.maxOutputChars,
      persistLedger: config.persistLedger,
      stataExe: config.stataExe,
      jobTimeout: config.jobTimeout,
    },
    reachable: false,
    service: null,
    jobs: {
      stataExeExists: existsSync(config.stataExe),
      stataExe: config.stataExe,
      defaultTimeoutSeconds: config.jobTimeout,
      hint: existsSync(config.stataExe)
        ? 'Background jobs will spawn this executable (batch, /e /q).'
        : 'Set --stata-exe to a real StataMP-64.exe path; background jobs cannot start.',
    },
    tools: null,
    hint: null,
  };

  try {
    const status = await engine.status();
    report.reachable = true;
    report.service = {
      status: status.status ?? null,
      skillVersion: status.skillVersion ?? null,
      sessionActive: status.sessionActive ?? null,
      busy: status.busy ?? null,
      stataPath: status.config?.stataPath ?? null,
      stataVersion: status.recommendedCandidate?.version ?? null,
      edition: status.recommendedCandidate?.edition ?? null,
      licenseFound: status.licenseFound ?? null,
      setupPhase: status.setup?.phase ?? null,
      capabilities: status.capabilities ?? null,
    };
  } catch (err) {
    report.service = { error: err.message, code: err.code ?? 'UNKNOWN' };
    report.hint = err.code === 'OFFLINE'
      ? 'Start the Stata AI Skill service (it exposes http://127.0.0.1:19522), then retry, or pass --endpoint.'
      : null;
  }

  try {
    const registry = createTools({ ...config, engine });
    report.tools = registry.definitions.map((tool) => tool.name);
  } catch (err) {
    report.tools = { error: err.message };
  }

  return report;
}

/** Only start the process when invoked as a program, not when a test imports it. */
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => {
      if (typeof code === 'number') process.exit(code);
    },
    (err) => {
      process.stderr.write(`${PACKAGE_NAME}: fatal: ${err?.stack ?? err}\n`);
      process.exit(1);
    },
  );
}
