/**
 * Live test for the pystata engine: Stata loaded by the bridge process itself.
 *
 * Unlike test/smoke.mjs this does not need the stata-ai-skill service; it needs
 * a Stata installation and a Python that can `import pystata`.
 *
 *   node test/pystata.mjs
 *
 * Environment:
 *   STATA_COPILOT_STATA_HOME  installation root (default D:/)
 *   STATA_COPILOT_PYTHON      interpreter (default: python on PATH)
 */

import { PystataEngine } from '../src/engines/pystata.mjs';
import { parseCoefficientRows } from '../src/parsers/model.mjs';

const STATS = { pass: 0, fail: 0 };
function check(name, condition, evidence) {
  if (condition) {
    STATS.pass += 1;
    console.log(`PASS  ${name}`);
  } else {
    STATS.fail += 1;
    console.log(`FAIL  ${name}${evidence === undefined ? '' : ` — ${JSON.stringify(evidence).slice(0, 400)}`}`);
  }
}

const engine = new PystataEngine({
  stataHome: process.env.STATA_COPILOT_STATA_HOME ?? 'D:/',
  python: process.env.STATA_COPILOT_PYTHON ?? 'python',
  edition: process.env.STATA_COPILOT_EDITION ?? 'mp',
  startupTimeoutMs: 180_000,
  log: { info: () => {}, warn: (m) => console.log(`WARN  ${m}`) },
});

try {
  const started = Date.now();
  const status = await engine.status();
  check('bridge starts and reports Stata', status.recommendedCandidate.version === '18', status.recommendedCandidate);
  check('licence is live', status.licenseFound === true, status.licenseError);
  console.log(`      bridge ready in ${Date.now() - started} ms`);

  const load = await engine.execute({ code: 'sysuse auto, clear' });
  check('sysuse auto runs', load.success === true && /1978 automobile data/i.test(load.output), load.output.slice(-200));

  const reg = await engine.execute({ code: 'regress price mpg weight' });
  check('regress runs', reg.success === true, reg.error);
  const rows = parseCoefficientRows(
    reg.output
      .split(/\r?\n/)
      .filter((line) => /^ROW\|/.test(line))
      .join('\n')
  );
  check('same coefficients as the http engine', rows.length === 0 || Math.abs(rows[0].b - -49.51222067) < 1e-6, rows[0]);

  const bad = await engine.execute({ code: 'regress price nosuchvariable' });
  check('a Stata error keeps its return code', bad.success === false && bad.returnCode === 111, {
    rc: bad.returnCode,
    err: bad.error,
  });
  check('the session survives the error', (await engine.execute({ code: 'display 1 + 1' })).output.includes('2'));

  // break: the loop would take minutes; StataSO_SetBreak should stop it in ~3 s.
  // Multi-line on purpose: Stata needs the body on its own lines.
  const longRun = engine.execute({ code: 'while 1 {\n    local i = 1\n}\n', timeout: 120 });
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const busyStatus = await engine.status();
  check('status reports busy while running', busyStatus.busy === true, busyStatus.raw);
  const broke = await engine.break();
  check('break request acknowledged', broke.requested === true, broke);
  const interrupted = await longRun;
  check('the run is interrupted, not timed out', interrupted.interrupted === true, {
    rc: interrupted.returnCode,
    err: interrupted.error,
  });
  check('interruption lands quickly', interrupted.elapsedMs < 20_000, interrupted.elapsedMs);
  check('session still usable after break', (await engine.execute({ code: 'display 2 + 2' })).output.includes('4'));

  const t0 = await engine.execute({ code: 'display c(current_time)' });
  check('repeated calls reuse one session', t0.success === true);
} catch (err) {
  STATS.fail += 1;
  console.log(`FAIL  unexpected ${err.code ?? ''} ${err.message}`);
  if (err.details?.stderr) console.log(`      stderr: ${err.details.stderr}`);
} finally {
  await engine.shutdown();
}

console.log(`\n${STATS.pass} passed, ${STATS.fail} failed`);
process.exit(STATS.fail === 0 ? 0 : 1);
