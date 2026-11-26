/**
 * Minimal, dependency-free MCP server over stdio.
 *
 * The protocol is newline-delimited JSON-RPC 2.0 on stdin/stdout; stdout is
 * therefore reserved for frames and everything diagnostic goes to stderr.
 * Implemented by hand on purpose: `git clone` and `node bin/stata-copilot.mjs`
 * needs no install step and no transitive dependency the user has to trust.
 *
 * This module knows the protocol and nothing about Stata: the tool surface is
 * injected as a registry (see tools/index.mjs).
 */

import { createInterface } from 'node:readline';

import { SERVER_INFO } from './version.mjs';
import { EngineError, errorResult } from './errors.mjs';
import { silentLogger } from './log.mjs';

export { SERVER_INFO };

const SUPPORTED_PROTOCOLS = ['2024-11-05', '2025-03-26', '2025-06-18'];
const LATEST_PROTOCOL = SUPPORTED_PROTOCOLS[SUPPORTED_PROTOCOLS.length - 1];

export const INSTRUCTIONS = `Stata analysis over MCP.
- Call stata_status first; it tells you whether Stata is reachable and ready.
- Prefer stata_run_do over stata_run for anything longer than a couple of lines: write a numbered .do file, run it, keep it.
- Use stata_model for regressions; it returns b/se/t/p per term instead of a transcript to read.
- Use stata_profile_data before modelling to learn types, labels and missingness.
- Call stata_graphs after a run that exported a PNG: the image comes back as an attachment.
- Raise timeout for bootstrap/simulation loops; call stata_break if a run hangs.
- Every run is appended to <cwd>/.stata-copilot/runs.jsonl; stata_history reads it back.`;

export function createServer({ registry, log = silentLogger }) {
  return {
    /** @returns {object|null} the response frame, or null for notifications */
    async handle(message) {
      if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0') {
        return errorResponse(null, -32600, 'Invalid Request');
      }
      const { id, method, params } = message;
      const isNotification = id === undefined || id === null;

      try {
        const result = await dispatch(method, params ?? {});
        if (isNotification) return null;
        if (result === undefined) return errorResponse(id, -32601, `Method not found: ${method}`);
        return { jsonrpc: '2.0', id, result };
      } catch (err) {
        if (isNotification) {
          log.error(`notification error: ${err?.message ?? err}`);
          return null;
        }
        if (err instanceof RpcError) return errorResponse(id, err.code, err.message, err.data);
        if (err instanceof EngineError) return errorResponse(id, -32603, err.message, { code: err.code, ...err.details });
        return errorResponse(id, -32603, `Internal error: ${err?.message ?? String(err)}`);
      }
    },
  };

  async function dispatch(method, params) {
    switch (method) {
      case 'initialize': {
        const requested = params.protocolVersion;
        const protocolVersion = SUPPORTED_PROTOCOLS.includes(requested) ? requested : LATEST_PROTOCOL;
        return {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        };
      }
      case 'ping':
        return {};
      case 'tools/list':
        return { tools: registry.definitions };
      case 'tools/call': {
        const { name, arguments: args } = params;
        if (!name) throw new RpcError(-32602, 'tools/call requires `name`');
        log.debug(`tools/call ${name}`);
        try {
          const out = await registry.call(name, args ?? {});
          const content = Array.isArray(out?.content) ? out.content : [{ type: 'text', text: String(out ?? '') }];
          return out?.isError ? { content, isError: true } : { content };
        } catch (err) {
          // A tool failure is a result, not a protocol error: the agent must be
          // able to read the code and correct itself.
          if (err instanceof EngineError) return errorResult(err);
          throw err;
        }
      }
      case 'resources/list':
        return { resources: [] };
      case 'prompts/list':
        return { prompts: [] };
      case 'notifications/initialized':
      case 'notifications/cancelled':
      case 'initialized':
        return undefined;
      default:
        return undefined;
    }
  }
}

class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

function errorResponse(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id: id ?? null, error };
}

/** Wire the server to stdin/stdout and run until the client closes the pipe. */
export function serveStdio(server, { onExit, log = silentLogger } = {}) {
  const rl = createInterface({ input: process.stdin });
  let pending = Promise.resolve();

  const write = (frame) => {
    process.stdout.write(JSON.stringify(frame) + '\n');
  };

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      write(errorResponse(null, -32700, 'Parse error'));
      return;
    }
    // Serialise frames so a long Stata run cannot interleave two responses.
    pending = pending
      .then(() => server.handle(message))
      .then((reply) => {
        if (reply) write(reply);
      })
      .catch((err) => {
        log.error(`fatal: ${err?.stack ?? err}`);
        write(errorResponse(message?.id ?? null, -32603, `Internal error: ${err?.message ?? String(err)}`));
      });
  });

  const shutdown = () => {
    pending.finally(() => {
      if (typeof onExit === 'function') onExit();
      process.exit(0);
    });
  };

  rl.on('close', shutdown);
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
