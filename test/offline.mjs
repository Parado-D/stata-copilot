#!/usr/bin/env node
/**
 * Offline tests: no Stata, no service. A stub engine returns recorded
 * transcripts, so the protocol, the parsers, the policy and the tool contracts
 * are all exercised in CI where no licence exists.
 *
 *   node test/offline.mjs
 */

import { createServer } from '../src/server.mjs';
import { createTools } from '../src/tools/index.mjs';
import { checkPolicy } from '../src/policy.mjs';
import {
  parseMacroList,
  parseCoefficientRows,
  parseProfileRows,
  parseSignature,
  studentTwoSidedP,
} from '../src/parsers/index.mjs';
import { lintCode } from '../src/lint.mjs';

let passed = 0;
const failures = [];
const check = (name, cond, detail) => {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failures.push(name); console.log(`  FAIL ${name} — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`); }
};

// A transcript exactly as the service returned it (trimmed).
const MODEL_TRANSCRIPT = `
. quietly regress price mpg weight

. mata:
:   printf("K=%g N=%g df_r=%g\\n", cols(__cpl_b), st_numscalar("e(N)"), st_numscalar("e(df_r)"))
K=3 N=74 df_r=71

:       printf("ROW|%s|%s|%20.12g|%20.12g\\n", __cpl_s[__cpl_j,1], __cpl_s[__cpl_j,2], __cpl_b[1,__cpl_j], sqrt(__cpl_V[__cpl_j,__cpl_j]))
ROW||mpg|      -49.51222067|       86.15603887
ROW||weight|       1.746559158|       .6413537894
ROW||_cons|       1946.068668|       3597.049599

: end
. ereturn list
                  e(N) =  74
               e(df_r) =  71
                 e(r2) =  .29338912
               e(r2_a) =  .27392957
                  e(F) =  14.739978
                 e(ll) = -322.48809
            e(cmdline) = "regress price mpg weight"
`;

const PROFILE_TRANSCRIPT = `
. describe, short
Contains data from C:\\data\\auto.dta
 Observations:            74
    Variables:            12                  27 Mar 2024 09:00

. ds
make price mpg weight
. foreach __cpl_v of local __cpl_vars {
  2.     di "PROFILE|..."
  3. }
PROFILE|make|str18|%18s|           0|Make and model
PROFILE|price|int|%8.0g|           0|Price
PROFILE|mpg|int|%8.0g|           0|Mileage (mpg)
`;

const stubEngine = {
  endpoint: 'http://stub',
  async status() {
    return {
      status: 'running', sessionActive: true, busy: false, skillVersion: 'v1.3',
      config: { stataPath: 'C:\\Stata\\StataMP-64.exe' },
      recommendedCandidate: { version: 18, edition: 'mp' }, licenseFound: true,
      setup: { phase: 'ready' }, capabilities: { execute: true },
    };
  },
  async execute({ code }) {
    if (code.includes('datasignature')) {
      return {
        success: true, returnCode: 0, error: '', graphs: [],
        output: '\n. datasignature\n  74:3(101019):2537987732:2244255684\n\nSORTEDBY=foreign\n',
      };
    }
    if (/^ereturn list|^mata:/m.test(code) || code.includes('ereturn list')) {
      return { success: true, returnCode: 0, output: MODEL_TRANSCRIPT, error: '', graphs: [] };
    }
    if (code.includes('describe, short')) {
      return { success: true, returnCode: 0, output: PROFILE_TRANSCRIPT, error: '', graphs: [] };
    }
    if (code.includes('return list')) {
      return { success: true, returnCode: 0, output: 'scalars:\n      r(N) =  74\n   r(mean) =  6165.256756756757\n', error: '', graphs: [] };
    }
    return { success: true, returnCode: 0, output: 'ok', error: '', graphs: [] };
  },
  async break() { return { ok: true }; },
};

console.log('parsers');
check('macro list parses r()', parseMacroList('      r(N) =  74\n   r(mean) =  6165.256756756757\n').r.mean === 6165.256756756757);
check('macro list parses e()', parseMacroList('e(r2) =  .29338912').e.r2 === 0.29338912);
check('coefficient rows parse', parseCoefficientRows(MODEL_TRANSCRIPT).length === 3);
check('coefficient b/se parse', Math.abs(parseCoefficientRows(MODEL_TRANSCRIPT)[1].b - 1.746559158) < 1e-9);
check('profile rows parse', parseProfileRows(PROFILE_TRANSCRIPT).length === 3);
check('profile label parses', parseProfileRows(PROFILE_TRANSCRIPT)[0].label === 'Make and model');
check('t p-value ~0.567 for t=-0.575', Math.abs((studentTwoSidedP(-0.5746, 71) ?? 0) - 0.5675) < 0.002, studentTwoSidedP(-0.5746, 71));
check('large t gives small p', (studentTwoSidedP(-8, 71) ?? 1) < 1e-10);

console.log('policy');
check('shell escape blocked', !checkPolicy('! del x', { mode: 'guarded' }).allowed);
check('shell command blocked', !checkPolicy('shell dir', { mode: 'guarded' }).allowed);
check('erase blocked', !checkPolicy('erase data.dta', { mode: 'guarded' }).allowed);
check('save blocked in readonly', !checkPolicy('save out.dta, replace', { mode: 'readonly' }).allowed);
check('save allowed in guarded', checkPolicy('save out.dta, replace', { mode: 'guarded' }).allowed);
check('capture prefix stripped before the command word', !checkPolicy('capture erase data.dta', { mode: 'guarded' }).allowed);
check('estimation allowed', checkPolicy('regress price mpg', { mode: 'guarded' }).allowed);
check('clear all warns', checkPolicy('clear all', { mode: 'guarded' }).warnings.length === 1);

console.log('protocol');
const registry = createTools({ engine: stubEngine, mode: 'guarded', persistLedger: false });
const server = createServer({ registry });

/** Drive a tool the way a client does, so the server's error→result conversion is exercised. */
let requestId = 100;
async function callTool(srv, name, args = {}) {
  const frame = await srv.handle({
    jsonrpc: '2.0', id: requestId++, method: 'tools/call', params: { name, arguments: args },
  });
  if (frame.error) throw new Error(`protocol error: ${frame.error.message}`);
  return frame.result;
}

const init = await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
check('initialize negotiated', init.result.protocolVersion === '2025-06-18');
check('serverInfo name', init.result.serverInfo.name === 'stata-copilot');

const unknownProto = await server.handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
check('unknown protocol falls back to latest', unknownProto.result.protocolVersion === '2025-06-18');

const list = await server.handle({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} });
check('tools/list returns every tool', list.result.tools.length === 16, list.result.tools.length);
check('every tool has inputSchema', list.result.tools.every((t) => t.inputSchema.type === 'object'));

const notif = await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
check('notification yields no frame', notif === null);

const missing = await server.handle({ jsonrpc: '2.0', id: 4, method: 'bogus/method', params: {} });
check('unknown method is -32601', missing.error.code === -32601);

const badJson = await server.handle({ jsonrpc: '1.0', id: 5, method: 'ping' });
check('bad envelope is -32600', badJson.error.code === -32600);

console.log('tools against a stub engine');
const status = await registry.call('stata_status');
check('status shape', status.content[0].text.includes('"reachable": true'));

const model = await registry.call('stata_model', { command: 'regress price mpg weight' });
const payload = JSON.parse(model.content[0].text);
check('model returns 3 estimates', payload.estimates.length === 3, payload.estimates.map((e) => e.name));
check('model reports n=74', payload.fit.n === 74);
check('model reports r2', Math.abs(payload.fit.r2 - 0.29338912) < 1e-9);
check('model computes t', Math.abs(payload.estimates[1].t - 1.746559158 / 0.6413537894) < 1e-6);
check('model computes p', payload.estimates[1].p > 0 && payload.estimates[1].p < 1);

const profile = await registry.call('stata_profile_data', {});
const prof = JSON.parse(profile.content[0].text);
check('profile counts variables', prof.variableCount === 3);
check('profile reads observations', prof.dataset.observations === 74);

const blocked = await callTool(server, 'stata_run', { code: '! echo hi' });
const blockedPayload = JSON.parse(blocked.content[0].text);
check('policy refusal is an error result', blocked.isError === true && blockedPayload.error.code === 'POLICY_BLOCKED');

const tightened = await callTool(server, 'stata_run', { code: 'erase auto.dta', mode: 'open' });
const tightenedPayload = JSON.parse(tightened.content[0].text);
check('a per-call mode cannot loosen the session', tightened.isError === true && tightenedPayload.error.code === 'POLICY_BLOCKED');

const unknownTool = await registry.call('nope').catch((e) => e);
check('unknown tool throws UNKNOWN_TOOL', unknownTool?.code === 'UNKNOWN_TOOL');

console.log('lint');
const lintIf = lintCode('if foreign {\n    summarize price\n}');
check('if-command is caught', lintIf.findings.some((f) => f.rule === 'if-command'), lintIf.findings);
const lintScalarIf = lintCode('regress price mpg\nif r(2) > 10 {\n    display "f"\n}');
check('if on r() results is not flagged', !lintScalarIf.findings.some((f) => f.rule === 'if-command'), lintScalarIf.findings);
const lintGen = lintCode('gen w = weight\ngen w = mpg');
check('gen-redefine is caught', lintGen.findings.some((f) => f.rule === 'gen-redefine'));
check('gen-redefine blocks (error)', lintGen.ok === false);
const lintLocal = lintCode('display "`cutoff\'"');
check('undefined-local is caught', lintLocal.findings.some((f) => f.rule === 'undefined-local'));
const lintMissing = lintCode('count if missing(price weight)');
check('missing() varlist is caught', lintMissing.findings.some((f) => f.rule === 'missing-varlist'));
const lintSort = lintCode('gen gap = price - price[_n-1]');
check('_n without sort is caught', lintSort.findings.some((f) => f.rule === 'sort-order'));
const lintClean = lintCode('set varabbrev off\nsort id\ngen gap = price - price[_n-1]\nlocal tag = "x"\ndisplay "`tag\'"');
check('clean do-file has no findings', lintClean.findings.length === 0, lintClean.findings);

console.log('signature');
const sig = parseSignature('  74:13(101019):2537987732:2244255684');
check('signature parses observations', sig.observations === 74);
check('signature parses variables', sig.variables === 13);
check('signature keeps both data hashes', sig.dataHashA === 2537987732 && sig.dataHashB === 2244255684);
const sigTool = await registry.call('stata_signature', {});
const sigPayload = JSON.parse(sigTool.content[0].text);
check('stata_signature returns a fingerprint', sigPayload.observations === 74 && sigPayload.sortedby === 'foreign', sigPayload);

const verified = await registry.call('stata_run', { code: 'summarize price', verify: true });
const verifiedPayload = JSON.parse(verified.content[0].text);
check('verify reports before and after', verifiedPayload.data?.before?.observations === 74 && verifiedPayload.data.changed === false, verifiedPayload.data);

const ciRow = parseCoefficientRows('ROW||weight| 1.746559158| .6413537894| 0.4674482| 3.0256701')[0];
check('interval columns parse', Math.abs(ciRow.ciLo - 0.4674482) < 1e-9 && Math.abs(ciRow.ciHi - 3.0256701) < 1e-9, ciRow);
const omittedRow = parseCoefficientRows('ROW||o.weight| 0| 0')[0];
check('o. prefix marks an omitted coefficient', omittedRow.omitted === true && omittedRow.term === 'weight', omittedRow);

console.log('');
if (failures.length === 0) {
  console.log(`PASS — ${passed} checks`);
  process.exit(0);
}
console.log(`FAIL — ${passed} passed, ${failures.length} failed:`);
for (const f of failures) console.log(`  - ${f}`);
process.exit(1);
