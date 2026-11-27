# stata-copilot

[![ci](https://github.com/Parado-D/stata-copilot/actions/workflows/ci.yml/badge.svg)](https://github.com/Parado-D/stata-copilot/actions/workflows/ci.yml)

**English** · [中文说明](README.zh-CN.md)

**An MCP server and skill pack that turn a coding agent into a disciplined Stata analyst.**
**让 AI 像研究助理那样跑 Stata：结果读成数字，危险命令碰不到，每一步都留得下。**

Agents can already type `regress y x` into a terminal. What they cannot do is read Stata's
transcript reliably, tell a coefficient from a footnote, keep their hands off `erase`, or leave
behind a run record you could put in a replication package. `stata-copilot` closes that gap:

| | |
|---|---|
| **Structured results** | `stata_model` returns `{name, b, se, t, p}` per term and `{n, r2, F, df_r}` — not a table to squint at. `stata_results` turns `r()` / `e()` macros into JSON. |
| **Safety rails** | Shell escapes, `erase`, and (in `readonly`) every disk write are refused before they reach Stata. A working directory allow-list keeps runs inside the project. |
| **Reproducibility trail** | Every run is appended to `<cwd>/.stata-copilot/runs.jsonl` with command, cwd, return code, duration and graph count. `stata_history` reads it back. |
| **Zero dependencies** | The server is ~600 lines of plain Node (≥18) speaking JSON-RPC over stdio. No `npm install`, no supply chain. |

## Requirements

- **Stata** 17 or 18 (MP/SE/BE), licensed and discoverable.
- A running **`stata-ai-skill`** service — the local HTTP session manager the server drives
  (default `http://127.0.0.1:19522`). It owns the live Stata process, licence and graph capture.
- **Node.js ≥ 18.17** (only to run the server; Stata work happens in Stata).

If the service is not up, every tool fails with `OFFLINE` and the exact endpoint it tried —
nothing fails silently.

## Install

### DeepSeek Harness: install the bundle, no config file

The package doubles as a DSH carrier bundle (`dsh.bundle.patch` in `package.json`), so it mounts
its own MCP row instead of asking you to edit a JSON file:

1. **Settings → Plugins → install from source**, paste `https://github.com/Parado-D/stata-copilot`.
2. Start a new session. The server's tools appear as `mcp__stata__stata_status`,
   `mcp__stata__stata_run`, …, `mcp__stata__stata_job_submit`. No Host restart is involved —
   MCP entries are read when a session is created.

Or from a shell, with a local checkout:

```bash
dsh plugin --profile <profile> add file:/path/to/stata-copilot   # copy
dsh plugin --profile <profile> add link:/path/to/stata-copilot   # junction, live edits
```

The mount lives in [`cordis.patch.yml`](cordis.patch.yml). Two details worth knowing:

- The row starts the server with **the DSH executable itself plus `ELECTRON_RUN_AS_NODE=1`**, so a
  standalone `node` is not required on `PATH`; on a source checkout `process.execPath` is `node`
  and the variable is inert.
- `failOnStartupError: false` and a `reconnect` block mean a missing Stata or a stopped
  `stata-ai-skill` service degrades to "tool unavailable", never to a profile that will not boot.

**The repository is public**, so the Git URL above installs anonymously — verified: `pnpm add
https://github.com/Parado-D/stata-copilot` resolves and installs `stata-copilot@0.3.0` in about
3 s, and the installed copy boots the MCP server from the bundled patch. If you are installing a
fork you keep private, pnpm's clone has no credentials and returns 404; install that one from a
local path (`file:` / `link:`) instead.

To tune the mount, override the row from your profile's own patch layer instead of editing the
package:

```yaml
- id: stata-copilot-mcp
  config:
    cwd: 'D:\papers\my-study'          # default: your home directory
    env:
      STATA_COPILOT_MODE: readonly     # open | guarded | readonly
      STATA_COPILOT_ROOTS: 'D:\papers'
```

### 1. Get the code

```bash
git clone https://github.com/Parado-D/stata-copilot.git
cd stata-copilot
npm link        # optional: puts `stata-copilot` on PATH; there is nothing to install
```

There are no dependencies, so there is no `npm install` step and nothing to audit. Node ≥ 18.17 is
enough. (Publishing to npm is on the roadmap; until then the git URL is the install source.)

### 2. Register it with your MCP client

**Claude Code** (`.mcp.json` in the project root):

```json
{
  "mcpServers": {
    "stata": {
      "command": "node",
      "args": ["C:/tools/stata-copilot/bin/stata-copilot.mjs", "--mode", "guarded", "--root", "."]
    }
  }
}
```

**Cursor / Windsurf / Claude Desktop** (`mcpServers` block of the client config) — same entry.

**DeepSeek Harness** — use the bundle at the top of this section; nothing is hand-wired. If you
prefer the file-overlay route, [`examples/dsh.cordis.yml`](examples/dsh.cordis.yml) is the same
row as a standalone `--patch` file. Any Cordis client can also run the server directly:

```bash
node bin/stata-copilot.mjs --endpoint http://127.0.0.1:19522 --mode guarded --root ~/projects/paper
```

**Codex / other agents** — MCP over stdio is the whole contract:

```bash
stata-copilot --mode guarded    # after npm link; speaks JSON-RPC on stdin/stdout
```

Copy-paste versions of both configs are in [`examples/`](examples/): `mcp-config.json` for the
`mcpServers` clients and `dsh.cordis.yml` for DeepSeek Harness (`dsh web --patch ...`).

### 3. Prove it works, with or without an agent

`examples/real-analysis/run.mjs` is a minimal MCP client — the same protocol an agent host
speaks. It runs a complete analysis on Stata's `auto` data (profile → summarize → regress →
robust regress → graph → ledger) and writes `report.md`, `estimates.json` and a PNG:

```bash
node examples/real-analysis/run.mjs          # requires the stata-ai-skill service
```

If that command prints coefficients and writes the report, the server half is fine and any
remaining problem is in the client wiring.

[`examples/paper/`](examples/paper/) is the longer version: a study split into numbered do-files
(`10-import` → `20-clean` → `30-describe` → `40-model` → `50-figures`), each one logged and
rerunnable on its own, producing tables, figures and `output/REPORT.md`:

```bash
node examples/paper/run.mjs        # chapters through the MCP server
```

The same five files also run in a plain Stata session (`do analysis/run-all.do`), which is the
point: the agent layer must not be the only way to reproduce the paper.

## Two ways to run Stata

One server, two interchangeable engines. The tool surface — 16 tools, the policy gate, the ledger,
`stata_model`'s numbers — is identical either way; only who owns the Stata session changes.

| | `--driver http` (default) | `--driver pystata` (standalone) |
|---|---|---|
| Stata runs in | the `stata-ai-skill` service on `127.0.0.1:19522` | a Python child that this package starts |
| Extra software | that service | Python 3 + the `pystata` that ships with Stata |
| `stata_break` | HTTP `POST /break` | `StataSO_SetBreak` on `mp-64.dll` |
| Install | two packages | this one only |

### Standalone mode: no second package

Stata 17+ ships an official embedded engine: `<Stata home>/utilities/pystata` plus `mp-64.dll`.
`--driver pystata` loads it in a long-lived child process, so the session (loaded data, `estimates`,
macros) survives between tool calls exactly as before:

```bash
node bin/stata-copilot.mjs --driver pystata --stata-home "D:/" --python "C:/Python312/python.exe"
```

or through the environment:

```bash
set STATA_COPILOT_DRIVER=pystata
set STATA_COPILOT_STATA_HOME=D:\
set STATA_COPILOT_PYTHON=C:\Python312\python.exe
```

- `--stata-home` is the folder holding `mp-64.dll` (`D:/` in the example). The bridge adds
  `<home>/utilities` to `PYTHONPATH` itself, so `import pystata` resolves without setup.
- `stata_break` is real in this mode: the bridge calls the DLL's `StataSO_SetBreak` from its stdin
  thread while Stata is still inside the previous command. A `while 1 { }` loop stops in about
  three seconds and the session stays usable.
- No HTTP hop means no 300-second artificial ceiling; each call carries its own timeout, and
  background jobs (`stata_job_*`) keep working — they spawn a separate batch process either way.

Verified on Windows with Stata 18 MP: `node test/pystata.mjs` runs 13 live assertions (licence,
`sysuse`, coefficients identical to the HTTP engine, `r(111)` preserved, busy state, break, session
survives the break).

## Tools

| Tool | What it is for |
|---|---|
| `stata_status` | Is Stata reachable, which installation, is a command running, what policy is active. |
| `stata_run` | Run a block of commands; returns `success`, `returnCode`, transcript, graphs, policy warnings. |
| `stata_run_do` | Run an existing `.do` file as a file (`do "..."`); `cwd` defaults to its folder. Add `background:true` to get a job id instead of waiting. |
| `stata_results` | `r()`, `e()`, `s()` macros as JSON. |
| `stata_profile_data` | Dataset header plus per-variable type, format, label and missing count. |
| `stata_model` | One estimation command in, a coefficient table and fit statistics out: b, se, t/z, p, 95% interval, omitted terms. |
| `stata_lint` | Static review of Stata code for constructs that run without an error and do the wrong thing. Never executes anything. |
| `stata_signature` | `datasignature` fingerprint of the loaded data, to prove whether a command changed it. |
| `stata_graphs` | The PNG a run exported, attached as an image the model can actually see. |
| `stata_break` | Interrupt a runaway command, then confirm `busy: false`. |
| `stata_history` | The run ledger. |
| `stata_job_submit` | Run a `.do` file in its own Stata process; returns immediately. |
| `stata_job_status` | Job state, elapsed time, return code, first Stata error, log tail. |
| `stata_job_log` | The log the job is writing right now. |
| `stata_job_kill` | Stop a job and keep the log so far. |
| `stata_job_list` | Jobs recorded under a working directory, newest first. |

## A session

```text
> stata_status
  running · Stata 18 MP · D:\StataMP-64.exe · busy false · mode guarded

> stata_profile_data { dataset: "auto" }
  74 obs · 12 vars · make (str18) "Make and model" · price (int) 0 missing …

> stata_model { command: "regress price mpg weight" }
  mpg    b=-49.512   se=86.156   t=-0.575   p=0.567   [ -221.30,  122.28 ]
  weight b=  1.747   se= 0.641   t= 2.723   p=0.008   [    0.47,    3.03 ]
  _cons  b=1946.069  se=3597.05  t= 0.541   p=0.590   [ -5226.1,  9118.2 ]
  fit: n=74  r2=0.293  F=14.74  crit=1.99394  omitted=[]

> stata_run { code: "scatter price mpg\ngraph export \"output/fit.png\", replace width(1200)" }
  success · 1 graph → output/fit.png

> stata_graphs
  [image]
```

## Long analyses

The local service embeds the Stata engine inside its own process, so **one command runs at a time**:
while a command is executing, every other call is answered with
`409 Stata is busy executing another command`, and a call that outlives the service's own limit
comes back without a return code at all. A twenty-minute imputation therefore cannot be driven
through `stata_run`, however the timeout is set.

`stata_job_submit` sidesteps that by not using the HTTP session: it starts
`StataMP-64.exe /e /q do <file>` as a separate OS process, copies the do-file to an ASCII name
first, and returns a job id. The interactive session stays free, there is no per-call ceiling
(default 30 minutes, `--job-timeout`), and the transcript lands in a log file you can read while
the job runs.

```text
> stata_job_submit { file: "analysis/40-impute.do", label: "ice imputation" }
  j-m3x9k1-4f2a · running · pid 9184 · log analysis/__job-j-m3x9k1-4f2a.log

> stata_job_status { jobId: "j-m3x9k1-4f2a" }
  running · 420s elapsed

> stata_job_log { jobId: "j-m3x9k1-4f2a", tail: 4000 }
  Imputing [Perfect prediction detected: using augmlogit to impute moccu; ...
```

A job's state comes from its log, not from the exit code: batch Stata exits `0` even when the
do-file aborts, so `stata_job_status` reports `failed` plus the first `r(NNN);`, the offending
command, and its message. Records live in `<cwd>/.stata-copilot/jobs/`, so `stata_job_list` still
finds a job after the server restarts.

One Windows detail is handled for you: launching a second Stata makes the embedded engine reset the
next connection it accepts (one `ECONNRESET`, then normal). `stata_job_submit` waits for the service
to answer again before returning, so the calls you make right after a submit do not race that
hiccup. `node examples/jobs.mjs` shows the whole flow — submit, an interactive call that still gets
through in ~60 ms, live progress, the verdict, a kill, and the listing.

## Catching the mistakes Stata does not report

Stata is quiet about the worst errors. These are all *valid* programs that run to
completion and produce a different result from the one intended — the kind an
agent will happily summarise into a report:

| Construct | What actually happens |
|---|---|
| `if foreign { ... }` | the `if` **command** tests observation 1 only; it is not a loop over rows |
| `gen gap = price - price[_n-1]` with no `sort` first | `_n` follows whatever order the data happen to be in |
| `gen w = exp(educ)` twice | `r(110) variable w already defined` — this is how a published replication package stops at line 4735 |
| ``display "`cutoff'"`` in a file that never defines it | the macro expands to an empty string, the command still runs |
| `missing(a b c)` | `missing()` wants a comma-separated expression list, not a varlist: it silently tests only `a` |
| `l` meaning `length` | with variable abbreviation on, an unknown name can resolve to another loaded variable |

Two layers answer this. The session starts with `set varabbrev off`, so a name
Stata cannot resolve is an error instead of a different variable. And
`stata_lint` reads the code before Stata sees it:

```text
> stata_lint { file: "analysis/40-model.do" }
  1 error(s), 2 warning(s), 1 note(s)
  line 118  error    gen-redefine    `gen wvs` is already defined by line 96; Stata stops with r(110)
  line  44  warning  if-command      `if foreign` tests observation 1 only, not every observation
  line  12  warning  sort-order      `_n`-dependent code runs on whatever order the data are in
  line   1  info     no-varabbrev-guard  this do-file estimates models but never turns abbreviation off
```

`stata_lint` never executes anything, so it is safe in `readonly` mode and cheap
enough to run on every draft. Errors mean "Stata will abort"; warnings mean "this
runs and is probably wrong"; the caller decides whether that is acceptable.

For the data itself there is `stata_signature` — and `verify: true` on
`stata_run`/`stata_run_do` does the same thing around one call:

```text
> stata_run { code: "replace mpg = mpg + 1", verify: true }
  data.before  { observations: 74, dataHashA: 2537987732, sortedby: null }
  data.after   { observations: 74, dataHashA: 3092844121, sortedby: null }
  data.changed true
```

That turns "the cleaning step only recoded labels" from a claim into a
fingerprint you can quote. Two fingerprints that match mean the data really did
not change; `sortOrderChanged` covers the case where the values are identical but
`_n` now means something else.

## Safety model

Three modes, selected with `--mode` / `STATA_COPILOT_MODE`:

- **`guarded`** (default) — refuses `!`, `shell`, `winexec`, `erase`, `rmdir`; warns on `clear all`.
- **`readonly`** — additionally refuses `save`, `export`, `outreg2`, `esttab`, `log`, `putexcel`,
  `file`, `mkdir`, `copy`, `do` — anything that can write to disk. Use it when an agent is only
  supposed to read and report.
- **`open`** — no checks. The active mode is printed in every result, and a call can only
  *tighten* the session mode, never loosen it.

Working-directory allow-list: `--root` (repeatable) or `STATA_COPILOT_ROOTS` (path-separator
separated). With roots configured, a run whose `cwd` falls outside them is refused. Without roots
the server trusts the caller and says so in `stata_status`.

## Repro trail

Each `stata_run` / `stata_run_do` / `stata_model` appends one JSON line:

```json
{"at":"2026-11-27T00:41:12.480Z","tool":"stata_model","ok":true,"returnCode":0,"ms":412,
 "cwd":"D:/paper","code":"regress price mpg weight"}
```

Disable with `--no-ledger`. The ledger is a convenience for building a replication appendix, not a
substitute for the `.do` files themselves — keep those under version control.

## Skills

`skills/stata-analysis/SKILL.md` is the workflow that sits on top: plan → profile → estimate →
table → figure → audit. Drop the folder into your client's skills directory (`.claude/skills/`,
`.agents/skills/`, or the DSH skill path) and the agent follows it when the user asks for an
analysis rather than a one-off command.

## Configuration

| Flag | Env | Default |
|---|---|---|
| `--endpoint` | `STATA_COPILOT_ENDPOINT` | `http://127.0.0.1:19522` |
| `--driver` | `STATA_COPILOT_DRIVER` | `http`; `pystata` runs Stata in-process (see above) |
| `--stata-home` | `STATA_COPILOT_STATA_HOME` | none; required by `--driver pystata` (`D:/`) |
| `--python` | `STATA_COPILOT_PYTHON` | `python` on PATH (must import `pystata`) |
| `--edition` | `STATA_COPILOT_EDITION` | `mp` (`mp`/`se`/`be`) |
| `--mode` | `STATA_COPILOT_MODE` | `guarded` |
| `--root` | `STATA_COPILOT_ROOTS` | none (no cwd restriction) |
| `--timeout` | `STATA_COPILOT_TIMEOUT` | `120` s per call |
| `--max-output` | `STATA_COPILOT_MAX_OUTPUT` | `20000` chars of transcript |
| `--no-ledger` | `STATA_COPILOT_NO_LEDGER` | ledger on |
| `--log-level` | `STATA_COPILOT_LOG` | `info` (stderr only) |
| `--stata-exe` | `STATA_COPILOT_STATA_EXE` | `D:\StataMP-64.exe` (used by background jobs) |
| `--job-timeout` | `STATA_COPILOT_JOB_TIMEOUT` | `1800` s per background job |

Flags also accept `--flag=value`. Unknown flags are refused rather than ignored, and every option
in this table is generated into `--help` from the same declaration (`src/config.mjs`).

### Is my installation working?

```bash
node bin/stata-copilot.mjs --doctor
```

prints one JSON object — config, engine reachability, the Stata build the service found, licence
state, and the tool inventory — and exits non-zero if the service is unreachable. Paste that output
into a bug report; it answers most "it does not work" questions without a round trip.

## Code map

```
bin/stata-copilot.mjs   entry: config → engine → registry → serve (and --doctor)
src/server.mjs          JSON-RPC over stdio; the protocol only, no Stata knowledge
src/tools/*.mjs         one file per tool; {name, title, description, inputSchema, handler}
src/tools/index.mjs     registry: definition checks, argument validation, dispatch
src/session.mjs         gate → execute → truncate → ledger; the run contract lives here once
src/jobs.mjs            background jobs: spawn Stata in batch mode, poll, kill, finalise from the log
src/policy.mjs          safety rules as data (RULES/WARNINGS), modes, cwd allow-list
src/engines/http.mjs    HTTP adapter for the local service; src/engines/index.mjs registers drivers
src/engines/pystata.mjs standalone engine: spawns the Python bridge, maps JSON lines to the contract
bridge/stata_bridge.py  loads mp-64.dll via pystata; reader thread answers break, worker thread runs
src/parsers/*.mjs       transcripts → numbers (macros, model, profile, distributions, errors)
src/lib/*.mjs           text/image content helpers, schema validation
src/config.mjs          flags + env + --help, all from one table
src/errors.mjs          frozen error codes and the MCP error result shape
cordis.patch.yml        DSH carrier bundle: mounts the MCP client row for this package
examples/paper/         numbered chapters (import → clean → describe → model → figures) + driver
examples/jobs.mjs       the client view of a background job: submit, poll, log, kill, list
```

Each layer has one job and one reason to change. Adding a tool touches two files; adding an engine
touches three; neither requires editing the protocol. See `docs/EXTENDING.md` for the recipes.

## Development

```bash
npm test                  # contracts (45) + offline (50) — no Stata needed
npm run test:contracts    # structural checks only: module graph, tool definitions, config
npm run test:stata        # live Stata session over HTTP, 48 assertions
npm run test:pystata      # live standalone engine, 13 assertions (needs --stata-home + python)
npm run demo:paper        # the chaptered study, end to end, on the live session
npm run demo:jobs         # background jobs: submit, watch, kill, list
npm run check             # syntax + contracts, what pre-commit runs
```

`npm test` is the CI gate: every module must import, every tool definition must validate, every
config flag must appear in `--help`, the registry must still reject bad arguments, and the parsers,
policy rules and JSON-RPC framing must all pass against recorded transcripts and a stub engine.
`npm run test:stata` is the contract that matters: protocol handshake, tool inventory, real
regression coefficients matched against Stata's own output, policy refusal, image attachment,
ledger, and a background job that is submitted, polled, classified as failed from its log, and
killed.


## Roadmap

- [x] `pystata` engine adapter — the session runs inside this server, no external service.
- [ ] `stata_table` — build an `esttab` table from a list of named estimates, returned as CSV + Markdown.
- [ ] Panel / IV diagnostics: warn when an `xtset` variable is missing, or when a model is fitted
      without `vce(cluster ...)` on clustered data.
- [ ] Mac / Linux verification in CI (Stata is licensed per machine, so CI runs the parser and
      protocol tests against recorded transcripts).

## Acknowledgements

The engine contract (`/status`, `/execute`, `/break`, graph capture) comes from
[stata-ai-skill](https://github.com/ZihaoVistonWang/Stata-AI-Skill), which manages the native Stata
session. This project is the agent-facing layer: structure, safety, ledger, and skills.

The standalone engine uses Stata's own embedded interface: `pystata` and `mp-64.dll` ship with
Stata and are the property of StataCorp; this project only calls them, through the documented
`pystata` API and — for `break` alone — the `StataSO_SetBreak` export of the shared library. It is
an alternative to the `http` engine, not a replacement for a Stata licence: running it still
requires an installed, licensed Stata. See `NOTICE` for the full attribution list.

## 中文速用

```json
{
  "mcpServers": {
    "stata": { "command": "node", "args": ["C:/tools/stata-copilot/bin/stata-copilot.mjs"] }
  }
}
```

- 先 `stata_status` 看会话是否就绪；`stata_profile_data` 摸清变量与缺失。
- 回归用 `stata_model`，直接拿 b/se/t/p 与 n/r2，不必从日志里抠表。
- 出图后 `stata_graphs` 取回 PNG；代理模型真的「看」得到图。
- 每次运行都写进 `<cwd>/.stata-copilot/runs.jsonl`，`stata_history` 可回读。
- 默认 `guarded` 模式会拒绝 `!`、`shell`、`erase`；只读审查用 `--mode readonly`。
- **跑得久（插补、bootstrap、上千次循环）不要硬塞进 `stata_run`**：服务是单线程，忙时会回 409，单次还有上限。用 `stata_job_submit` 起独立进程，`stata_job_status` 轮询、`stata_job_log` 看进度、`stata_job_kill` 随时停。

## License

MIT
