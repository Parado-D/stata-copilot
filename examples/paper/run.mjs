// examples/paper/run.mjs — run the paper, chapter by chapter, through the
// MCP server. Each do-file is one `stata_run_do` call, so a failure names the
// step that failed and the ledger gets one row per chapter.
//
//   node examples/paper/run.mjs
//
// The numbered files are also runnable on their own (`do run-all.do` from a
// plain Stata session), which is the point: the agent layer must not be the
// only way to reproduce the paper.
import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { REPO_ROOT, startServer } from '../mcp-client.mjs';

const HERE = path.join(REPO_ROOT, 'examples', 'paper');
const OUT = path.join(HERE, 'output');
const CHAPTERS = ['10-import.do', '20-clean.do', '30-describe.do', '40-model.do', '50-figures.do'];

if (!existsSync(path.join(HERE, 'data', 'auto.dta'))) {
  console.error('missing examples/paper/data/auto.dta');
  process.exit(2);
}

const client = startServer({
  command: process.execPath,
  args: [path.join(REPO_ROOT, 'bin', 'stata-copilot.mjs'), '--mode', 'guarded', '--root', REPO_ROOT],
});

const payload = (result) => JSON.parse(result.content.find((block) => block.type === 'text').text);

function listing(dir) {
  const abs = path.join(HERE, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs)
    .filter((name) => !name.startsWith('.'))
    .map((name) => {
      const file = path.join(abs, name);
      return { name: `${dir}/${name}`, bytes: statSync(file).size };
    });
}

try {
  const init = await client.initialize();
  console.log(`connected: ${init.serverInfo?.name} ${init.serverInfo?.version}`);

  const status = payload(await client.callTool('stata_status', {}));
  console.log(`Stata: ${status.stata?.version} ${status.stata?.edition}\n`);

  const ran = [];
  for (const chapter of CHAPTERS) {
    const file = path.join(HERE, 'analysis', chapter);
    // Lint first: the whole point is to catch the mistakes Stata would accept
    // silently, and a chapter is exactly the unit where that matters.
    const lint = payload(await client.callTool('stata_lint', { file, cwd: path.join(HERE, 'analysis') }));
    const blocking = (lint.findings ?? []).filter((finding) => finding.severity === 'error');
    if (blocking.length > 0) {
      console.error(`\n${chapter} has ${blocking.length} blocking lint error(s):`);
      for (const finding of blocking) console.error(`  line ${finding.line}  ${finding.rule}  ${finding.message}`);
      process.exitCode = 1;
      break;
    }

    const started = Date.now();
    const result = await client.callTool('stata_run_do', {
      file,
      cwd: path.join(HERE, 'analysis'),
      timeout: 300,
      verify: true,
    });
    const body = payload(result);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    if (result.isError || body.success === false) {
      console.error(`\n${chapter} FAILED after ${seconds}s\n${body.output ?? JSON.stringify(body)}`);
      process.exitCode = 1;
      break;
    }
    const changedLabel =
      body.data?.changed === true
        ? 'data changed'
        : body.data?.changed === false
          ? 'data unchanged'
          : 'no baseline';
    ran.push({
      chapter,
      seconds,
      returnCode: body.returnCode,
      graphs: body.graphs?.length ?? 0,
      changed: body.data?.changed ?? null,
    });
    console.log(
      `ok  ${chapter.padEnd(16)} ${seconds}s  rc=${body.returnCode}  graphs=${body.graphs?.length ?? 0}  ${changedLabel}`,
    );
  }

  if (process.exitCode) throw new Error('stopped at the first failing chapter');

  // The figures are the last chapter's product. Do-files run through the engine
  // as files, so Stata writes the PNGs natively; hand the paths to stata_graphs
  // to get them back as image attachments and prove they exist.
  const figureFiles = listing('output/figures')
    .map((file) => path.join(HERE, file.name))
    .filter((file) => file.endsWith('.png'))
    .slice(0, 5);
  const graphs = payload(await client.callTool('stata_graphs', { files: figureFiles, max: 5 }));

  const tables = listing('output/tables');
  const figures = listing('output/figures');
  const logs = listing('output/logs');

  const report = [
    '# Paper run (generated)',
    '',
    'Every number below is produced by the numbered do-files in `analysis/`; this',
    'file only records what they wrote. Re-run with `node examples/paper/run.mjs`',
    'or, without an agent, `do analysis/run-all.do`.',
    '',
    '## Chapters',
    '',
    '| chapter | seconds | return code | graphs | data changed |',
    '| --- | ---: | ---: | ---: | :---: |',
    ...ran.map(
      (row) =>
        `| \`${row.chapter}\` | ${row.seconds} | ${row.returnCode} | ${row.graphs} | ${
          row.changed === null ? '—' : row.changed ? 'yes' : 'no'
        } |`,
    ),
    '',
    '## Artifacts',
    '',
    ...[...tables, ...figures].map((file) => `- \`${file.name}\` (${file.bytes} bytes)`),
    '',
    '## Figures',
    '',
    ...figures
      .filter((file) => file.name.endsWith('.png'))
      .map((file) => `![${path.basename(file.name)}](${file.name})`),
    '',
    `Images attached to the client: ${graphs.images ?? 0}.`,
    '',
    '## Logs',
    '',
    ...logs.map((file) => `- \`${file.name}\` (${file.bytes} bytes)`),
    '',
  ].join('\n');

  writeFileSync(path.join(OUT, 'REPORT.md'), report, 'utf8');
  console.log(`\nfigures attached: ${graphs.images ?? 0}`);
  console.log(`wrote ${path.join(OUT, 'REPORT.md')}`);
} catch (error) {
  console.error(`\n${error.message}`);
  process.exitCode = 1;
} finally {
  const stderr = client.stderrText().trim();
  await client.close();
  if (process.exitCode && stderr) console.error(stderr);
}
