// A real analysis, driven through the MCP wire protocol by a client that is
// not the test suite: load a course dataset, profile it, fit a model, refit it
// with robust standard errors, export a figure, and write a short report whose
// numbers come from `stata_model` rather than from the printed regression
// table.
//
//   node examples/real-analysis/run.mjs [data.dta]
//
// Output goes to examples/real-analysis/output/. Requires a reachable
// stata-ai-skill service (see README, "Requirements").
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { REPO_ROOT, startServer } from '../mcp-client.mjs';

const NODE = process.execPath;
const OUT = path.join(REPO_ROOT, 'examples', 'real-analysis', 'output');
const dataArg = process.argv[2];
const DATA = dataArg ? path.resolve(dataArg) : path.join(REPO_ROOT, 'examples', 'real-analysis', 'auto.dta');

mkdirSync(OUT, { recursive: true });

const client = startServer({
  command: NODE,
  args: [path.join(REPO_ROOT, 'bin', 'stata-copilot.mjs'), '--root', REPO_ROOT],
});

const log = (...parts) => console.log(...parts);

function payload(result) {
  const textBlock = result.content?.find((block) => block.type === 'text');
  if (!textBlock) throw new Error('the tool returned no text block');
  return JSON.parse(textBlock.text);
}

function requireOk(result, what) {
  const body = payload(result);
  if (result.isError) throw new Error(`${what} failed: ${JSON.stringify(body.error ?? body)}`);
  return body;
}

function table(rows) {
  const header = '| term | b | se | t | p |\n| --- | ---: | ---: | ---: | ---: |';
  const body = rows
    .map(
      (row) =>
        `| ${row.name} | ${row.b.toFixed(4)} | ${row.se.toFixed(4)} | ${row.t?.toFixed(3) ?? ''} | ${row.p.toFixed(4)} |`,
    )
    .join('\n');
  return `${header}\n${body}`;
}

try {
  const init = await client.initialize();
  log(`server ${init.serverInfo?.name} ${init.serverInfo?.version} (protocol ${init.protocolVersion})`);

  const tools = await client.request('tools/list', {});
  log(`tools: ${tools.tools.map((tool) => tool.name).join(', ')}`);

  const status = requireOk(await client.callTool('stata_status', {}), 'stata_status');
  log(`Stata ${status.stata?.version ?? '?'} (${status.stata?.edition ?? '?'}) reachable at ${status.endpoint}`);

  const profile = requireOk(
    await client.callTool('stata_profile_data', { dataset: DATA, cwd: OUT }),
    'stata_profile_data',
  );
  log(`dataset: ${profile.dataset?.source ?? DATA}, ${profile.dataset?.observations ?? '?'} obs, ${profile.variableCount} vars`);

  const summary = requireOk(
    await client.callTool('stata_run', {
      code: 'summarize price mpg weight length, detail',
      cwd: OUT,
    }),
    'stata_run',
  );
  log(`summary ran in ${summary.elapsedMs} ms`);

  const base = requireOk(
    await client.callTool('stata_model', { command: 'regress price mpg weight length', cwd: OUT }),
    'stata_model',
  );
  const robust = requireOk(
    await client.callTool('stata_model', {
      command: 'regress price mpg weight length, vce(robust)',
      cwd: OUT,
      quiet: true,
    }),
    'stata_model',
  );
  log(`model: n=${base.fit.n} r2=${base.fit.r2?.toFixed(4)} df_r=${base.fit.df_r}`);

  const figure = requireOk(
    await client.callTool('stata_run', {
      code: [
        'twoway (scatter price weight, msymbol(oh)) (lfit price weight), ///',
        '    title("Price vs weight") xtitle("Weight (lbs.)") ytitle("Price (USD)")',
        `graph export "${path.join(OUT, 'price-weight.png').replace(/\\/g, '/')}", replace width(1200)`,
      ].join('\n'),
      cwd: OUT,
    }),
    'graph export',
  );
  const graphs = requireOk(await client.callTool('stata_graphs', {}), 'stata_graphs');
  const attached = graphs.files?.filter((file) => file.bytes).length ?? 0;
  log(`figure: ${attached} image(s) attached, ${figure.graphs?.length ?? 0} graph(s) captured`);

  const history = requireOk(await client.callTool('stata_history', { limit: 20 }), 'stata_history');
  const entries = Array.isArray(history.entries) ? history.entries : [];

  const report = [
    '# Stata analysis report (generated)',
    '',
    `Dataset: \`${profile.dataset?.source ?? DATA}\` — ${profile.dataset?.observations ?? '?'} observations, ${profile.variableCount} variables.`,
    `Stata: ${status.stata?.version ?? '?'} ${status.stata?.edition ?? ''} via \`${status.endpoint}\`.`,
    '',
    '## Model: regress price mpg weight length',
    '',
    table(base.estimates),
    '',
    `R² = ${base.fit.r2?.toFixed(4)}, adjusted R² = ${base.fit.r2_a?.toFixed(4)}, N = ${base.fit.n}, df_r = ${base.fit.df_r}.`,
    '',
    '## Same model with heteroskedasticity-robust standard errors',
    '',
    table(robust.estimates),
    '',
    'Compare the `se` columns: the coefficients are identical (same estimator), the',
    'standard errors are not. A table built from printed output would have made that',
    'harder to see than two columns of numbers.',
    '',
    '![Price vs weight](output/price-weight.png)',
    '',
    `Ledger entries recorded by this session: ${entries.length}.`,
    '',
  ].join('\n');

  writeFileSync(path.join(OUT, 'report.md'), report, 'utf8');
  writeFileSync(
    path.join(OUT, 'estimates.json'),
    `${JSON.stringify({ dataset: profile.dataset, base: base.estimates, robust: robust.estimates, fit: base.fit }, null, 2)}\n`,
    'utf8',
  );

  log(`wrote ${path.join(OUT, 'report.md')}`);
  log(`wrote ${path.join(OUT, 'estimates.json')}`);
} finally {
  const stderr = client.stderrText().trim();
  await client.close();
  if (stderr) log(`\n[server stderr]\n${stderr}`);
}
