#!/usr/bin/env node
/**
 * End-to-end smoke test: drives the MCP server over stdio against a live
 * Stata session and asserts the structured fields the README promises.
 *
 *   node test/smoke.mjs            # requires Stata + the AI Skill service
 *
 * Exits non-zero on the first failed assertion so CI (and you) can trust it.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.join(here, '..', 'bin', 'stata-copilot.mjs');

let passed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL ${name}${detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
  }
}

class Client {
  constructor({ cwd }) {
    this.proc = spawn(process.execPath, [serverEntry, '--no-ledger'], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = '';
    this.proc.stderr.on('data', (d) => {
      this.stderr += d.toString();
    });
    // A crashed child would otherwise leave every request waiting for its timer.
    this.proc.on('exit', (code) => {
      const tail = this.stderr.trim().split(/\r?\n/).slice(-8).join(' | ');
      for (const [, resolver] of this.pending) {
        resolver({ error: { message: `server exited with code ${code}: ${tail}` } });
      }
      this.pending.clear();
    });
    let buffer = '';
    this.proc.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        let frame;
        try {
          frame = JSON.parse(line);
        } catch {
          failures.push(`unparsable frame: ${line.slice(0, 200)}`);
          continue;
        }
        const resolver = this.pending.get(frame.id);
        if (resolver) {
          this.pending.delete(frame.id);
          resolver(frame);
        }
      }
    });
  }

  request(method, params) {
    const id = this.nextId++;
    const frame = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }, 30_000);
      this.pending.set(id, (reply) => {
        clearTimeout(timer);
        if (reply.error) reject(new Error(`${method}: ${reply.error.message}`));
        else resolve(reply.result);
      });
      this.proc.stdin.write(JSON.stringify(frame) + '\n');
    });
  }

  async call(name, args = {}) {
    const result = await this.request('tools/call', { name, arguments: args });
    const textBlock = (result.content ?? []).find((c) => c.type === 'text');
    const images = (result.content ?? []).filter((c) => c.type === 'image');
    let payload = null;
    if (textBlock) {
      try {
        payload = JSON.parse(textBlock.text);
      } catch {
        payload = textBlock.text;
      }
    }
    return { isError: Boolean(result.isError), payload, images };
  }

  close() {
    this.proc.stdin.end();
    this.proc.kill();
  }
}

const workdir = await mkdtemp(path.join(os.tmpdir(), 'stata-copilot-'));
const client = new Client({ cwd: workdir });

try {
  console.log('handshake');
  const init = await client.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'smoke', version: '0' },
  });
  check('initialize returns serverInfo', init.serverInfo?.name === 'stata-copilot', init.serverInfo);
  check('initialize echoes protocol', init.protocolVersion === '2025-06-18', init.protocolVersion);
  check('initialize carries instructions', typeof init.instructions === 'string' && init.instructions.length > 50);
  await client.request('notifications/initialized', {}).catch(() => {});

  console.log('tools/list');
  const list = await client.request('tools/list', {});
  const names = (list.tools ?? []).map((t) => t.name).sort();
  check('nine tools exposed', names.length === 9, names);
  check('every tool has an inputSchema', (list.tools ?? []).every((t) => t.inputSchema?.type === 'object'));

  console.log('stata_status');
  const status = await client.call('stata_status');
  check('status reachable', status.payload?.reachable === true, status.payload);
  check('status reports a running session', status.payload?.sessionActive === true, status.payload?.sessionActive);
  check('status reports a Stata version', Boolean(status.payload?.stata?.version), status.payload?.stata);

  console.log('stata_run');
  const summary = await client.call('stata_run', { code: 'sysuse auto, clear\nsummarize price', cwd: workdir });
  check('run succeeded', summary.payload?.success === true, summary.payload?.output?.slice(-400));
  check('run returns rc 0', summary.payload?.returnCode === 0);
  check('transcript contains the mean', /6165\.2/.test(summary.payload?.output ?? ''), summary.payload?.output?.slice(-300));

  console.log('stata_results');
  await client.call('stata_run', { code: 'quietly summarize price', cwd: workdir });
  const results = await client.call('stata_results', { scope: 'r', cwd: workdir });
  check('r(mean) parsed as a number', results.payload?.macros?.r?.mean === 6165.256756756757, results.payload?.macros?.r);
  check('r(N) parsed as a number', results.payload?.macros?.r?.N === 74, results.payload?.macros?.r?.N);

  console.log('stata_model');
  const model = await client.call('stata_model', { command: 'regress price mpg weight', cwd: workdir, quiet: true });
  const est = model.payload?.estimates ?? [];
  const mpg = est.find((e) => e.name === 'mpg');
  check('three coefficients returned', est.length === 3, est.map((e) => e.name));
  check('mpg coefficient matches Stata', Math.abs((mpg?.b ?? 0) - -49.51222067) < 1e-6, mpg);
  check('mpg standard error matches Stata', Math.abs((mpg?.se ?? 0) - 86.15603887) < 1e-6, mpg?.se);
  check('mpg p-value computed', typeof mpg?.p === 'number' && mpg.p > 0.5 && mpg.p < 0.6, mpg?.p);
  check('fit reports N=74', model.payload?.fit?.n === 74, model.payload?.fit);
  check('fit reports r2', Math.abs((model.payload?.fit?.r2 ?? 0) - 0.2934) < 1e-3, model.payload?.fit?.r2);

  console.log('stata_profile_data');
  const profile = await client.call('stata_profile_data', { cwd: workdir });
  check('profile sees 12 variables', profile.payload?.variableCount === 12, profile.payload?.variableCount);
  check('profile reports observations', profile.payload?.dataset?.observations === 74, profile.payload?.dataset);
  const weight = (profile.payload?.variables ?? []).find((v) => v.name === 'weight');
  check('profile carries the variable label', weight?.label === 'Weight (lbs.)', weight);

  console.log('policy');
  const blocked = await client.call('stata_run', { code: '! echo pwned', cwd: workdir });
  check('shell escape blocked', blocked.isError === true && blocked.payload?.error?.code === 'POLICY_BLOCKED', blocked.payload);
  const outside = await client.call('stata_run', { code: 'display 1', cwd: path.parse(workdir).root });
  check('run outside roots is allowed without roots configured', outside.payload?.success === true, outside.payload);

  console.log('graphs');
  const graphed = await client.call('stata_run', {
    code: 'sysuse auto, clear\nscatter price mpg\ngraph export "g.png", replace width(600)',
    cwd: workdir,
  });
  check('graph run succeeded', graphed.payload?.success === true, graphed.payload?.output?.slice(-300));
  const images = await client.call('stata_graphs', {});
  check('one image attached', images.images.length >= 1, { images: images.images.length, files: images.payload?.files });
  check('image payload is base64 png', images.images[0]?.mimeType === 'image/png' && images.images[0]?.data?.length > 1000);

  console.log('ledger');
  const history = await client.call('stata_history', { limit: 50 });
  check('ledger recorded the runs', (history.payload?.entries ?? []).length >= 5, history.payload?.total);
} catch (err) {
  failures.push(`exception: ${err.message}`);
  console.log(`  FAIL exception — ${err.message}`);
} finally {
  client.close();
  await rm(workdir, { recursive: true, force: true }).catch(() => {});
}

console.log('');
if (failures.length === 0) {
  console.log(`PASS — ${passed} checks`);
  process.exit(0);
}
console.log(`FAIL — ${passed} passed, ${failures.length} failed:`);
for (const f of failures) console.log(`  - ${f}`);
process.exit(1);
