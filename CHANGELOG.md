# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.1]

### Changed — the built-in engine is the default path

The package no longer asks you to run a second service in order to use Stata. `--driver` defaults
to `auto`: it looks for a Stata installation (a folder with `mp-64.dll`, `se-64.dll` or
`be-64.dll`) and a Python 3 that can `import pystata`, and when both exist it runs Stata in this
server's own child process. When they do not, it falls back to `http` and says so in the log.

- `--driver auto` added; `ENGINE_DRIVERS` still lists the concrete engines, `DRIVERS` adds the
  selector. `resolveDriver()` and `detectPystata()` are exported so a host can ask "what would you
  pick here, and why".
- `--doctor` now reports `config.driverResolved` plus `config.autoDetection` (`available`,
  `stataHome`, `python`, `reason`) — a failed auto-detection is a sentence, not a mystery.
- `--stata-home` is auto-detected (common install folders, then drive roots); `--python` falls back
  to `python`/`python3` on `PATH` and to the interpreter bundled with DeepSeek Harness.
- README / README.zh-CN: requirements are Stata + Python + Node; the HTTP service is documented as
  an optional fallback for machines that already run it. `--driver http` remains fully supported.
- `test/smoke.mjs` runs on the default engine now (set `STATA_COPILOT_DRIVER=http` to point the
  same assertions at a service), and asks `stata_graphs` for the exported PNG by path so the graph
  assertions hold in both engines.
- `package.json` description: dropped the "pair it with a local service" clause; the built-in
  engine is now the stated way it runs.

### Fixed — three things the standalone engine needed

- **A break could land before Stata started the command** and be discarded with it, so a long loop
  ran to its timeout instead of stopping. The bridge now keeps re-pressing `StataSO_SetBreak` while
  the command is still running, and clears the flag afterwards so it cannot abort the next command.
- **`interrupted` was never true** when pystata aborted with `SystemError("--Break--")`: the marker
  reaches the exception text, not the transcript. Both places are checked now, and a break that was
  requested and produced `r(1)` counts as one.
- **`set linesize 255` in the session bootstrap.** Stata wraps long output at 80 columns by
  default, which cut the `ROW|…` lines `stata_model` reads into two — the coefficient table came
  back short and the collinear term unmarked under the standalone engine.

## [0.5.0]

### Added — a Stata engine of its own, so the package stands alone

`--driver pystata` runs the session inside this server: a Python child loads Stata's own embedded
interface (`<Stata home>/utilities/pystata` + `mp-64.dll`), and the 16 tools work unchanged. No
`stata-ai-skill` service, no HTTP hop, no second install.

- `bridge/stata_bridge.py` — two threads on purpose. The reader thread answers `status` from a
  startup snapshot and executes `break` immediately, because a break that queues behind the command
  it should interrupt is not a break; the worker thread runs Stata, one command at a time, capturing
  the transcript through `config.set_output_file`. Stata's embedded engine writes to file descriptor
  1 directly, so the bridge hands fd 1 to stderr and keeps a private copy for the JSON frames.
- `src/engines/pystata.mjs` — spawns that child, maps JSON lines onto the engine contract, and turns
  a timeout into `break` + a short grace period, so a caller still receives the partial transcript.
- `stata_break` is real in this mode: `StataSO_SetBreak` interrupts a running loop in ~3 s and the
  session stays usable. `r(NNN)` return codes survive the trip (pystata raises `SystemError`; the
  bridge reads the code out of it rather than trusting `_rc`).
- `--stata-home`, `--python`, `--edition` (`STATA_COPILOT_STATA_HOME`, `STATA_COPILOT_PYTHON`,
  `STATA_COPILOT_EDITION`), and `--doctor` now reports which Stata build the chosen engine loaded.
- `test/pystata.mjs` — 13 live assertions: licence, `sysuse`, coefficients identical to the HTTP
  engine, `r(111)` preserved, busy state, break, session survives the break.
- `NOTICE` — who owns what: StataCorp's `pystata`/`mp-64.dll` (and the fact that `StataSO_SetBreak`
  is an undocumented export, used for `break` only), `stata-ai-skill`'s HTTP contract,
  `claude-code-my-workflow`'s workflow shape, and the *Stata Tips* DOIs behind the lint rules.

### Changed

- `BUSY` is a first-class error code: a second `stata_run` while the pystata bridge is executing is
  refused with an actionable message instead of a silent queue.
- README / README.zh-CN: a "two ways to run Stata" table, the standalone recipe, and the engine
  files added to the code map.

## [0.4.2]

### Changed — the one-line pitch reads like a person wrote it

The plugin list is the first thing anyone sees, and the old description was a feature
inventory ("MCP server + skills that turn an AI coding agent into…"). It now leads with
what you actually get in Chinese, in the register the other DSH plugins use: results as
numbers rather than a table to squint at, dangerous commands stopped before Stata sees
them, long imputations moved off the busy session, silent Stata mistakes named before the
do-file runs.

Same treatment for the skill's frontmatter (Chinese first, English trigger phrases kept)
and the README subtitle.

## [0.4.1]

### Added — Chinese documentation

- `README.zh-CN.md`: the whole guide in Chinese — requirements, the DSH one-click install (and the
  plugin-manager registry pitfall that turns the install into a 404), the 16-tool table, a session
  transcript, why long analyses cannot ride on `stata_run`, the two layers against silent errors,
  fingerprint verification, the safety model and its six boundaries, configuration, code map and
  development commands.
- `package.json` description now carries a Chinese sentence, so the plugin list reads in Chinese too,
  and `README.zh-CN.md` is part of the published files.

## [0.4.0]

### Added — catch the mistakes Stata reports as success

Grounded in *Stata Tips* (Cox, 4th ed.) and in two failures this project hit in the field: a
`l ambiguous abbreviation` that killed a 17-minute run, and `gen wvs = 1 if wvs == .` that stopped a
replication package 88 seconds in.

- `stata_lint { code | file }` — static review, no execution, safe in `readonly` mode. Eight rules:
  `if-command` (tests observation 1 only), `sort-order` (`_n` with no preceding sort), `gen-redefine`
  (`r(110)`), `undefined-local` (expands to `""`), `missing-varlist` (`missing(a b c)`),
  `varabbrev-on`, `no-varabbrev-guard`, `do-missing-file`. Errors block, warnings do not.
- The session now starts with `set varabbrev off` (+ `set more off`) before the first real command,
  so a name Stata cannot resolve is an error rather than a different variable. The preamble is
  applied once, retried if the engine is still starting, and skippable with `--no-bootstrap` style
  wiring (Session option `bootstrap`).
- `stata_run` and `stata_run_do` accept `verify: true`: the data are fingerprinted with
  `datasignature` before and after, and the payload carries `data{before, after, changed,
  sortOrderChanged}`.
- `stata_signature { dataset? }` — the same fingerprint as a tool, so a report can quote
  "same data before and after" instead of asserting it.
- `stata_model` now returns a 95% confidence interval on every coefficient (`ciLo`, `ciHi`) computed
  in Mata with the model's own critical value (`e(df_r)` → t, otherwise the normal 1.96), reports
  that critical value as `fit.crit`, and marks coefficients dropped for collinearity
  (`omitted: true` on the estimate, `fit.omitted: [...]`). The stripe names them `o.<var>`, which
  is the only surviving trace: `e(omit)` does not exist for `regress`.

## [0.3.0]

### Added — installable as a DeepSeek Harness bundle

- `package.json` declares `dsh.bundle.patch`, so the package can be installed as a DSH plugin
  instead of being hand-wired into a client config. `cordis.patch.yml` mounts one loader row — the
  in-box `@deepseek-ai/dsh-mcp-client` bridge — pointing at this package's own bin. Tools then show
  up as `mcp__stata__*` in every session.
- The row spawns the server with `process.execPath` plus `ELECTRON_RUN_AS_NODE=1`: the Desktop
  install runs the Host inside Electron and is not guaranteed to have a standalone `node` on
  `PATH`. The bin path is resolved from the patch's own `baseUrl`, so nothing is hard-coded.
- `failOnStartupError: false` + `reconnect`: no Stata installed, or a stopped `stata-ai-skill`
  service, leaves the tools unavailable instead of breaking profile boot.
- Six bundle contracts in the structural test: the manifest points at a patch that exists, the patch
  is published by `files[]`, it names the bridge without importing it, the namespace and bin agree,
  and the row keeps the inert-safe settings.

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
