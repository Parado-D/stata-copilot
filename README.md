# stata-copilot

**An MCP server and skill pack that turn a coding agent into a disciplined Stata analyst.**

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

Any MCP client works. Add the server to its configuration:

**Claude Code** (`.mcp.json` in the project root):

```json
{
  "mcpServers": {
    "stata": { "command": "npx", "args": ["-y", "stata-copilot", "--mode", "guarded"] }
  }
}
```

**Cursor / Windsurf / Claude Desktop** (`mcpServers` block of the client config) — same entry.

**DeepSeek Harness / any Cordis client** — point it at the same command; or run it directly:

```bash
node bin/stata-copilot.mjs --endpoint http://127.0.0.1:19522 --mode guarded --root ~/projects/paper
```

**Codex / other agents** — MCP over stdio is the whole contract:

```bash
npx -y stata-copilot            # speaks JSON-RPC on stdin/stdout
```

## Tools

| Tool | What it is for |
|---|---|
| `stata_status` | Is Stata reachable, which installation, is a command running, what policy is active. |
| `stata_run` | Run a block of commands; returns `success`, `returnCode`, transcript, graphs, policy warnings. |
| `stata_run_do` | Run an existing `.do` file; `cwd` defaults to its folder. |
| `stata_results` | `r()`, `e()`, `s()` macros as JSON. |
| `stata_profile_data` | Dataset header plus per-variable type, format, label and missing count. |
| `stata_model` | One estimation command in, a coefficient table and fit statistics out. |
| `stata_graphs` | The PNG a run exported, attached as an image the model can actually see. |
| `stata_break` | Interrupt a runaway command, then confirm `busy: false`. |
| `stata_history` | The run ledger. |

## A session

```text
> stata_status
  running · Stata 18 MP · D:\StataMP-64.exe · busy false · mode guarded

> stata_profile_data { dataset: "auto" }
  74 obs · 12 vars · make (str18) "Make and model" · price (int) 0 missing …

> stata_model { command: "regress price mpg weight" }
  mpg    b=-49.512   se=86.156   t=-0.575   p=0.567
  weight b=  1.747   se= 0.641   t= 2.723   p=0.008
  _cons  b=1946.069  se=3597.05  t= 0.541   p=0.590
  fit: n=74  r2=0.293  F=14.74

> stata_run { code: "scatter price mpg\ngraph export \"output/fit.png\", replace width(1200)" }
  success · 1 graph → output/fit.png

> stata_graphs
  [image]
```

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
| `--mode` | `STATA_COPILOT_MODE` | `guarded` |
| `--root` | `STATA_COPILOT_ROOTS` | none (no cwd restriction) |
| `--timeout` | — | `120` s per call |
| `--max-output` | — | `20000` chars of transcript |
| `--no-ledger` | — | ledger on |

## Development

```bash
npm test                  # node test/offline.mjs — no Stata needed, 35 assertions
npm run test:stata        # node test/smoke.mjs — live Stata session, 28 assertions
node --check src/server.mjs
```

`npm test` is the CI gate: parsers, policy rules, JSON-RPC framing and tool contracts, all against
recorded transcripts and a stub engine. `npm run test:stata` is the contract that matters: protocol
handshake, tool inventory, real regression coefficients matched against Stata's own output, policy
refusal, image attachment, ledger.

## Roadmap

- [ ] `spawn` engine adapter — manage the Stata session directly, no external service.
- [ ] `stata_table` — build an `esttab` table from a list of named estimates, returned as CSV + Markdown.
- [ ] Panel / IV diagnostics: warn when an `xtset` variable is missing, or when a model is fitted
      without `vce(cluster ...)` on clustered data.
- [ ] Mac / Linux verification in CI (Stata is licensed per machine, so CI runs the parser and
      protocol tests against recorded transcripts).

## Acknowledgements

The engine contract (`/status`, `/execute`, `/break`, graph capture) comes from
[stata-ai-skill](https://github.com/ZihaoVistonWang/Stata-AI-Skill), which manages the native Stata
session. This project is the agent-facing layer: structure, safety, ledger, and skills.

## 中文速用

```json
{ "mcpServers": { "stata": { "command": "npx", "args": ["-y", "stata-copilot"] } } }
```

- 先 `stata_status` 看会话是否就绪；`stata_profile_data` 摸清变量与缺失。
- 回归用 `stata_model`，直接拿 b/se/t/p 与 n/r2，不必从日志里抠表。
- 出图后 `stata_graphs` 取回 PNG；代理模型真的「看」得到图。
- 每次运行都写进 `<cwd>/.stata-copilot/runs.jsonl`，`stata_history` 可回读。
- 默认 `guarded` 模式会拒绝 `!`、`shell`、`erase`；只读审查用 `--mode readonly`。

## License

MIT
