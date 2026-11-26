// A tiny MCP stdio client. It exists so the repository can demonstrate — and
// test — the server exactly the way an agent host (Claude Code, Cursor, DSH,
// Codex) does: spawn the binary, speak newline-delimited JSON-RPC on stdin and
// stdout, and read `tools/call` results back as content blocks.
//
// Nothing here is Stata-specific; it is the client half of the wire contract
// documented in docs/PROTOCOL.md.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '..');

export function startServer({ command, args = [], env = {}, cwd = REPO_ROOT } = {}) {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let buffer = '';
  let nextId = 1;
  const pending = new Map();
  const stderr = [];

  child.stderr.on('data', (chunk) => {
    // The server logs to stderr on purpose: stdout belongs to the protocol.
    stderr.push(chunk.toString());
    if (stderr.join('').length > 20000) stderr.splice(0, stderr.length - 20);
  });

  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue; // a stray log line on stdout: ignore rather than crash
      }
      if (message.id !== undefined && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) reject(Object.assign(new Error(message.error.message), { rpc: message.error }));
        else resolve(message.result);
      }
    }
  });

  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code ?? -1)));

  function send(message) {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  function request(method, params, { timeoutMs = 600000 } = {}) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timed out waiting for ${method} (${timeoutMs} ms)`));
      }, timeoutMs);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      send({ jsonrpc: '2.0', id, method, params });
    });
  }

  function notify(method, params) {
    send({ jsonrpc: '2.0', method, params });
  }

  return {
    child,
    stderrText: () => stderr.join(''),
    request,
    notify,
    async initialize({ protocolVersion = '2025-06-18', name = 'stata-copilot-example' } = {}) {
      const result = await request('initialize', {
        protocolVersion,
        capabilities: { roots: { listChanged: false } },
        clientInfo: { name, version: '0.0.0' },
      });
      notify('notifications/initialized', {});
      return result;
    },
    async callTool(name, args) {
      const result = await request('tools/call', { name, arguments: args ?? {} });
      return result;
    },
    async close() {
      child.stdin.end();
      child.kill();
      await exited;
    },
    exited,
  };
}
