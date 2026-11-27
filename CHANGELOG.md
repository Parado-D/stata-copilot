# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added — background jobs, so long analyses are not capped by the service

- Five tools: `stata_job_submit`, `stata_job_status`, `stata_job_log`, `stata_job_kill`,
  `stata_job_list` (`src/jobs.mjs`). A job runs `StataMP-64.exe /e /q do <file>` as its own OS
  process, so it is not subject to the service's single-threaded `409 busy` behaviour or its
  per-call ceiling; the interactive session stays free and the transcript is readable while the
  job runs.
- `stata_run_do {background: true}` — the same thing without switching tools.
- `--stata-exe` (default `D:\StataMP-64.exe`) and `--job-timeout` (default 1800 s, lazy
  enforcement: the timer fires, the job is killed, the log is kept).
- `src/parsers/errors.mjs` — the first `r(NNN);` in a transcript or batch log, with the offending
  command reconstructed across `> ` continuation lines. Batch Stata exits 0 on error, so a job's
  state is decided by this parser, not by the exit code.
- Job records persist as JSON under `<cwd>/.stata-copilot/jobs/`, so `stata_job_list` still reports
  a job after the server restarts.
- Live smoke test grew to 40 assertions: submit, poll, log marker, failure classification
  (`r(111)`), kill, list, background `run_do`.

### Fixed — the first call after a submit no longer loses a race

- Starting a second Stata makes the service's embedded engine reset the next connection it accepts
  (one `ECONNRESET`, then normal). `stata_job_submit` now waits — bounded, best effort — for
  `GET /status` to answer again before it returns, so the caller's first `stata_run` after a submit
  is not the one that eats the hiccup. Symptom it removes: a fresh `OFFLINE … fetch failed` right
  after a successful job submit.
- `stata_job_status` reports elapsed time and the log tail while the job is still running, not only
  after it finishes; `npm run demo:jobs` exercises submit → concurrent interactive call → live
  progress → verdict → kill → list.

### Added — a chaptered paper example

- `examples/paper/` — a study split into numbered do-files (`00-plan.md`, `10-import`, `20-clean`,
  `30-describe`, `40-model`, `50-figures`, `run-all.do`), one log per chapter, and every product
  under `output/`. `run.mjs` drives the chapters through the server and writes `output/REPORT.md`;
  `do run-all.do` reproduces the same tree without an agent.
- `npm run demo:paper` — runs the whole study end to end against the live session.

### Changed — `stata_run_do` runs the file, not a copy of its text

- Do-files are now executed with the engine's `file` mode (`do "..."`) instead of having their
  contents pasted in. Relative paths, `log using`, `graph export` and `estimates` behave exactly as
  they do in a Stata session driven by hand; the policy still reads the file body first, so a
  do-file cannot smuggle a shell escape past the gate.
- `Session.run` accepts `file` and passes it through to the engine.

### Examples: a wire-level client and a real analysis

- `examples/mcp-client.mjs` — a ~120-line MCP stdio client that speaks the same JSON-RPC an agent host does, so the repository can demonstrate and test the client half of the contract.
- `examples/real-analysis/run.mjs` — a complete analysis on Stata's `auto` data (profile → summarize → OLS → robust OLS → graph → ledger) that writes `report.md`, `estimates.json` and a PNG from the `stata_model` payloads.
- `examples/mcp-config.json` and `examples/dsh.cordis.yml` — copy-paste wiring for `mcpServers` clients and for DeepSeek Harness.

### Changed — modular architecture for maintainability
- Split the monolithic `src/tools.mjs`, `src/engine.mjs` and `src/parse.mjs` into layers with one
  reason to change each: `server.mjs` (protocol), `tools/*.mjs` (one file per tool),
  `engines/*` (driver registry), `parsers/*` (pure transcript → numbers), `session.mjs` (the run
  contract), `policy.mjs` (rules as data), `config.mjs` (flags + env + help from one table),
  `errors.mjs` (frozen codes), `lib/*` (content and schema helpers).
- Tool definitions are validated at startup: name pattern, unique name, ≥40-character description,
  object schema, and a whitelist of schema keywords. A malformed tool now fails the boot, not the
  first agent call.
- Arguments are validated against each tool's `inputSchema` before the handler runs
  (`INVALID_ARGS` with a list of problems, instead of a type error inside Stata code).
- Engines are registered drivers with a startup contract check (`status`/`execute`/`break`);
  adding a backend no longer means editing tool code.
- Policy rules are data (`RULES`, `WARNINGS`) with stable ids; `statements()` strips
  `capture`/`quietly`/`noisily` prefixes before matching.
- Version is read from `package.json` once and used by both `serverInfo` and `--help`.

### Added
- `--doctor`: one JSON report — config, engine reachability, Stata build, licence, tool inventory —
  with a non-zero exit when the service is down.
- `--driver`, `--log-level`, `STATA_COPILOT_TIMEOUT`, `STATA_COPILOT_MAX_OUTPUT`,
  `STATA_COPILOT_NO_LEDGER`; `--flag=value` form; unknown flags are refused.
- `test/contracts.mjs` (36 checks): module graph, tool definitions, config table, engine
  registry, error codes, policy modes. `npm test` now runs it before the behavioural suite.
- `docs/EXTENDING.md` (add a tool / engine / policy rule / parser), `CONTRIBUTING.md`, `SECURITY.md`;
  README code map and a configuration table generated from the same option declaration as `--help`.

### Planned
- `spawn` engine adapter: run Stata without the external HTTP service.
- `stata_table`: named estimates → `esttab` → CSV/Markdown.
- Design-aware warnings (missing `xtset`, missing `vce(cluster ...)`, unseeded simulation).
- CI: parser and protocol suites; Stata integration test stays manual (licence-bound).

## [0.1.0] - 2026-11-27

First working version, verified end-to-end against Stata 18 MP on Windows 11.

### Added
- MCP server over stdio, zero runtime dependencies (Node ≥ 18.17).
- Tools: `stata_status`, `stata_run`, `stata_run_do`, `stata_results`, `stata_profile_data`,
  `stata_model`, `stata_graphs`, `stata_break`, `stata_history`.
- `stata_model` reads `e(b)`/`e(V)` through Mata and returns `{name, b, se, t, p}` plus
  `{n, r2, r2_a, F, df_r, ll, aic, bic, cmdline}`; p-values use Student's t when `e(df_r)`
  is available and the normal approximation otherwise.
- `stata_profile_data` returns dataset header and per-variable type, format, label, missing count.
- `stata_graphs` returns exported PNG/JPEG as MCP image content.
- Policy modes `open` / `guarded` / `readonly`; shell escapes, `erase`, and (in `readonly`)
  disk writes are refused before execution. Calls can only tighten the session mode.
- Optional working-directory allow-list (`--root`, `STATA_COPILOT_ROOTS`).
- Run ledger: every execution appended to `<cwd>/.stata-copilot/runs.jsonl`, readable via
  `stata_history`; disable with `--no-ledger`.
- GET retry for transient connection failures; POST `/execute` is never retried.
- Tests: `test/offline.mjs` (parsers, policy, protocol, tool contracts against a stub engine) and
  `test/smoke.mjs` (28 assertions against a live Stata session).
- Skill: `skills/stata-analysis/SKILL.md` — plan → profile → scaffold → estimate → table/figure → audit.
