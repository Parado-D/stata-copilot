#!/usr/bin/env node
/**
 * Contract test: every module must load, and every seam must still be a seam.
 *
 * This runs before the behavioural tests because its failures are structural:
 * a tool with a duplicate name, a schema with an unknown keyword, an engine
 * driver that no longer implements `execute`, or a config flag that is accepted
 * but not documented. Each of those breaks users in a different way, and none
 * of them needs Stata to be running to detect.
 *
 *   node test/contracts.mjs
 */

import { readdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
const failures = [];
const check = (name, cond, detail) => {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failures.push(name); console.log(`  FAIL ${name} — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`); }
};

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.name.endsWith('.mjs')) yield full;
  }
}

console.log('module graph');
const modules = [];
for (const dir of ['src', 'bin']) {
  for await (const file of walk(path.join(ROOT, dir))) modules.push(file);
}
check('source tree is non-trivial', modules.length >= 20, modules.length);

let importErrors = 0;
for (const file of modules) {
  try {
    await import(pathToFileURL(file).href);
  } catch (err) {
    importErrors++;
    console.log(`  FAIL load ${path.relative(ROOT, file)} — ${err.message}`);
  }
}
check('every module imports without error', importErrors === 0, `${importErrors} failed`);

const { TOOL_MODULES, assertTool, createTools } = await import(pathToFileURL(path.join(ROOT, 'src/tools/index.mjs')).href);
const { ENGINE_DRIVERS, DRIVERS, createEngine, ENGINES, resolveDriver, detectPystata } = await import(pathToFileURL(path.join(ROOT, 'src/engines/index.mjs')).href);
const { CONFIG_OPTIONS, parseConfig, helpText, ConfigError } = await import(pathToFileURL(path.join(ROOT, 'src/config.mjs')).href);
const { VERSION, SERVER_INFO } = await import(pathToFileURL(path.join(ROOT, 'src/version.mjs')).href);
const { checkPolicy, checkCwd, MODES } = await import(pathToFileURL(path.join(ROOT, 'src/policy.mjs')).href);
const { EngineError, ERROR_CODES, errorResult } = await import(pathToFileURL(path.join(ROOT, 'src/errors.mjs')).href);
const pkg = JSON.parse(await (await import('node:fs/promises')).readFile(path.join(ROOT, 'package.json'), 'utf8'));

console.log('tool contracts');
check('every tool module is registered (16)', TOOL_MODULES.length === 16, TOOL_MODULES.map((t) => t.name));
const names = TOOL_MODULES.map((t) => t.name);
check('tool names unique', new Set(names).size === names.length);
check('names are lower_snake_case', names.every((n) => /^[a-z][a-z0-9_]{2,40}$/.test(n)), names);
check('every tool has a title', TOOL_MODULES.every((t) => typeof t.title === 'string' && t.title.length > 2));
check('every description is agent-usable', TOOL_MODULES.every((t) => typeof t.description === 'string' && t.description.length >= 40));
check('every tool describes its arguments', TOOL_MODULES.every((t) => t.inputSchema && t.inputSchema.type === 'object'));

let rejected = null;
try {
  assertTool({ ...TOOL_MODULES[0], name: 'Bad-Name' }, 'probe');
} catch (err) {
  rejected = err;
}
check('a malformed definition is rejected at startup', rejected?.code === 'TOOL_DEFINITION', rejected?.message);

const stub = { endpoint: 'http://stub', async status() { return {}; }, async execute() { return { success: true, returnCode: 0, output: '', error: '', graphs: [] }; }, async break() {} };
const registry = createTools({ engine: stub, mode: 'guarded', persistLedger: false });
check('registry exposes every tool definition', registry.definitions.length === TOOL_MODULES.length);
check('unknown tool raises UNKNOWN_TOOL', await registry.call('nope').then(() => false, (e) => e.code === 'UNKNOWN_TOOL'));
check('bad arguments raise INVALID_ARGS', await registry.call('stata_run', { code: 42 }).then(() => false, (e) => e.code === 'INVALID_ARGS'));
check('missing required argument is reported', await registry.call('stata_run', {}).then(() => false, (e) => e.code === 'INVALID_ARGS' && e.details.problems.length > 0));
check('extra arguments are refused', await registry.call('stata_run', { code: 'di 1', shell: true }).then(() => false, (e) => e.code === 'INVALID_ARGS'));

console.log('engine contracts');
check('engines registry is non-empty', ENGINE_DRIVERS.length >= 1, ENGINE_DRIVERS);
check('http driver is registered', Boolean(ENGINES.http));
const http = createEngine({ driver: 'http', endpoint: 'http://127.0.0.1:9' });
check('engine implements status/execute/break', ['status', 'execute', 'break'].every((m) => typeof http[m] === 'function'));
check('unknown driver is refused', (() => { try { createEngine({ driver: 'nope' }); return false; } catch (e) { return e.code === 'UNKNOWN_TOOL' || e.code === 'BAD_REQUEST'; } })());
check('auto is offered as a selector, not an engine', DRIVERS[0] === 'auto' && !ENGINES.auto, DRIVERS);
check('an explicit driver is never second-guessed', resolveDriver({ driver: 'http' }).driver === 'http');
const detection = detectPystata({ stataHome: 'C:/definitely/not/here' });
check('detection explains itself when Stata is missing', detection.available === false && typeof detection.reason === 'string', detection.reason);

console.log('error contracts');
const codes = Object.values(ERROR_CODES);
check('every code is an uppercase identifier', codes.length > 10 && codes.every((c) => typeof c === 'string' && /^[A-Z_]+$/.test(c)));
check('codes are self-describing', codes.every((c) => ERROR_CODES[c] === c));
check('unknown code degrades to BAD_RESPONSE', new EngineError('NOPE', 'x').code === 'BAD_RESPONSE');
check('errorResult is an MCP error', (() => {
  const r = errorResult(new EngineError('POLICY_BLOCKED', 'no'));
  return r.isError === true && JSON.parse(r.content[0].text).error.code === 'POLICY_BLOCKED';
})());

console.log('config contracts');
check('package version is the single source', VERSION === pkg.version, `${VERSION} vs ${pkg.version}`);
check('serverInfo carries name+version', SERVER_INFO.name === pkg.name && SERVER_INFO.version === pkg.version);
const defaults = parseConfig([], {}).config;
check('defaults are usable', defaults.mode === 'guarded' && defaults.driver === 'auto' && defaults.defaultTimeout === 120);
check('--flag=value form parses', parseConfig(['--mode=readonly'], {}).config.mode === 'readonly');
check('--root is repeatable', parseConfig(['--root', 'C:\\a', '--root', 'C:\\b'], {}).config.roots.length === 2);
check('unknown flag is refused', (() => { try { parseConfig(['--nope'], {}); return false; } catch (e) { return e instanceof ConfigError; } })());
check('out-of-range timeout is refused', (() => { try { parseConfig(['--timeout', '900'], {}); return false; } catch { return true; } })());
check('--doctor selects the doctor action', parseConfig(['--doctor'], {}).action === 'doctor');
const help = helpText({ name: pkg.name, version: pkg.version });
check('every documented option appears in --help', CONFIG_OPTIONS.every((o) => help.includes(o.flag)), CONFIG_OPTIONS.map((o) => o.flag));

console.log('policy contracts');
check('modes are ordered simplest to strictest', MODES.join(',') === 'open,guarded,readonly');
check('open mode allows a shell escape', checkPolicy('! dir', { mode: 'open' }).allowed);
check('rules cover shell and destructive verbs', !checkPolicy('shell dir', { mode: 'guarded' }).allowed && !checkPolicy('rmdir x', { mode: 'guarded' }).allowed);
check('cwd outside roots is refused', checkCwd('D:\\elsewhere', ['C:\\work']).allowed === false);
check('cwd inside a root is allowed', checkCwd('C:\\work\\proj', ['C:\\work']).allowed === true);

console.log('DSH bundle contracts');
// A carrier bundle is a manifest field plus one patch file; both must agree, or
// the GUI installer either ships a package that mounts nothing (silent no-op) or
// mounts a file that is not published (install fails at load time).
const patchRel = pkg.dsh?.bundle?.patch;
check('package declares a bundle patch', typeof patchRel === 'string' && patchRel.length > 0);
check('bundle patch is shipped by files[]', Array.isArray(pkg.files) && pkg.files.includes('cordis.patch.yml'));
check('bundle patch exists on disk', patchRel ? existsSync(join(ROOT, patchRel)) : false, patchRel);
const patch = patchRel ? readFileSync(join(ROOT, patchRel), 'utf8') : '';
check('patch mounts a loader row', /^- insert:/m.test(patch) && /name:\s*"@deepseek-ai\/dsh-mcp-client"/.test(patch));
check('patch never imports the in-box bridge', !/from\s+['"]@deepseek-ai\/dsh-mcp-client/.test(patch));
check('row names the MCP server namespace', /serverName:\s*stata\b/.test(patch));
check('row starts this package bin', /bin['"],\s*['"]stata-copilot\.mjs/.test(patch));
check('row ships inert-safe on purpose', /failOnStartupError:\s*false/.test(patch));
check('bin entry matches the patch', pkg.bin?.['stata-copilot'] === 'bin/stata-copilot.mjs');

console.log('');
if (failures.length === 0) {
  console.log(`PASS — ${passed} checks`);
  process.exit(0);
}
console.log(`FAIL — ${passed} passed, ${failures.length} failed:`);
for (const f of failures) console.log(`  - ${f}`);
process.exit(1);
