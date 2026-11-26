# Examples

Two kinds of example live here.

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

The `output/` directory is generated and ignored by git; run the command to reproduce it.
