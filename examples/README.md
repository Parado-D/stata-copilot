# Examples

Three kinds of example live here.

## Wiring files

- `mcp-config.json` — the `mcpServers` block shared by Claude Code (`.mcp.json`), Cursor,
  Windsurf and Claude Desktop.
- `dsh.cordis.yml` — the Cordis patch entry for DeepSeek Harness (`dsh web --patch ...`).

Both point at `bin/stata-copilot.mjs` and pass `--mode guarded --root <project>`; edit the paths.

## A real analysis, driven over the wire

`real-analysis/run.mjs` is a client, not a test. It spawns the server exactly as an agent host
does, speaks JSON-RPC over stdin/stdout, and runs a small but complete study on Stata's `auto`
dataset — the copy under `real-analysis/auto.dta` is the 1978 automobile dataset that ships with
Stata:

1. `stata_status` — which Stata answered;
2. `stata_profile_data` — dataset header and 12 variable descriptions;
3. `stata_run` — `summarize ... , detail`;
4. `stata_model` — `regress price mpg weight length`;
5. `stata_model` — the same model with `vce(robust)`, so the two `se` columns can be compared;
6. `stata_run` — a scatter-plus-fit graph exported to PNG;
7. `stata_graphs` — the PNG comes back as an image content block;
8. `stata_history` — the ledger rows the session wrote.

```bash
node examples/real-analysis/run.mjs                  # uses real-analysis/auto.dta
node examples/real-analysis/run.mjs path/to/other.dta
```

It writes `real-analysis/output/report.md`, `output/estimates.json`, `output/price-weight.png`
and the run ledger `output/.stata-copilot/runs.jsonl`. The report's numbers come from the
`stata_model` payloads, not from scraping the printed regression table — that is the whole point
of the server, and the demo would fail loudly if the structured path broke.

## A paper, one chapter at a time

`paper/` takes the same dataset and organises it the way a study is actually written: numbered
do-files, one job each, a log per file, and everything the run produces under `output/`.

```
paper/analysis/
  00-plan.md        question, data, design — written before any code
  10-import.do      load, label, assert the unit of observation
  20-clean.do       derived variables, missing-data count, save the analytic file
  30-describe.do    Table 1, exported as .rtf and .csv
  40-model.do       Table 2 from three named estimates
  50-figures.do     Figures 1-4, each exported at width(1200)
  run-all.do        the five files, in order, from a plain Stata session
```

```bash
node examples/paper/run.mjs        # the agent route
```

The driver stops at the first failing chapter and prints that chapter's output, so a broken run
names its step. It also writes `paper/output/REPORT.md` listing the chapters, artifacts, figures
and logs that the run produced.

The numbered files are deliberately ordinary Stata: `cd paper/analysis && do run-all.do` produces
the same tree without any agent involved. See [`paper/README.md`](paper/README.md) for what each
chapter is meant to teach — including two Stata details that bite (`estimates save` persists one
result set per call; export a figure right after drawing it).

The `output/` directories are generated and ignored by git; run either command to reproduce them.
