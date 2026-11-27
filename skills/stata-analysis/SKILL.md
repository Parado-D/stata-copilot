---
name: stata-analysis
description: 用 Stata 做一份经得起复核的计量分析：先写计划，摸清数据，按编号写 do 文件（导入→清洗→描述→建模→出图），用结构化结果估计，导出三线表与图，并把每一步留进可复现台账。Stata analysis the way a careful research assistant would — plan, profile the data, scaffold numbered do-files, estimate with structured results, export a publication table and figure, and leave a reproducible run ledger. Use when the user asks for a Stata analysis, a regression, descriptive statistics, a replication, a table or figure "in Stata", or says 帮我跑个回归 / 用 Stata 分析一下 / 做个描述统计 / 出个表.
---

# stata-analysis

The MCP server `stata-copilot` provides the tools; this skill is the discipline around them.
The rule that governs everything: **a result is only as good as the do-file that can reproduce it.**
Never report a number that exists only in a transcript.

## Tools you have

`stata_status` · `stata_profile_data` · `stata_run` · `stata_run_do` · `stata_model` ·
`stata_results` · `stata_graphs` · `stata_break` · `stata_history`

## Step 0 — check the session before promising anything

Call `stata_status`. If it returns `OFFLINE` or `NOT_READY`, stop and report the exact endpoint
and the setup hint; do not attempt to install or start Stata yourself.

## Step 1 — plan (before touching Stata)

Write `analysis/00-plan.md`, three short sections:

- **Question** — the estimand in one sentence.
- **Data** — file, unit of observation, period, what a row means.
- **Design** — the specification, and the variation that identifies it.

If the user has not said which panel/time/unit they mean, ask. A wrong unit of observation is
the most expensive mistake in this workflow, and it is invisible afterwards.

## Step 2 — profile the data

`stata_profile_data { dataset: "path or sysuse name" }`. Then record in `analysis/01-profile.md`:

- observations, variables, the dataset label;
- per variable: type, label, missing count — flag any variable with missing > 20%;
- the panel id and time variable, if any.

Read the labels back to the user when the variable names are cryptic (`gphm`, `x1`, `v37`).
A variable you misread is a result you get wrong.

## Step 3 — scaffold numbered do-files

Never push a long analysis through `stata_run`. Write files, then run them:

```
analysis/
  10-import.do     use/import + label checks
  20-clean.do      recodes, missing handling, sample restrictions
  30-describe.do   table 1 / summary statistics
  40-model.do      estimation, stored estimates
  50-export.do     esttab tables, graph export figures
```

Each file starts with `version 18` (or the session's `c(version)`), `clear all`, `set more off`,
`set varabbrev off`, and a `log using` line into `output/logs/`. Run each with
`stata_run_do { file, cwd }` and fix errors in the file — not by patching the session ad hoc.

Before running a file you just wrote, lint it: `stata_lint { file }`. It catches the Stata mistakes
that run without an error — `if <variable> {` (first observation only), `_n` with no preceding sort,
`gen` on a variable the file already created, a local that is never defined (expands to `""`),
`missing(a b c)` treated as a varlist. Fix every `error`, and judge each `warning` on its merits;
do not run code with an unexplained warning and then report its output as if it were right.

**If a chapter is slow** (imputation, bootstrap, thousands of loops), do not raise the timeout and
do not split the file to fit a limit: hand it to `stata_job_submit { file, label }`. A job runs in
its own Stata process, so the interactive session stays usable, and the tool returns a job id at
once. Then poll `stata_job_status` every ~30 s, read progress with `stata_job_log`, and use
`stata_job_kill` if it is clearly stuck. When it ends, treat its state like any run:

- `ok` → the chapter finished; read the log's tail to confirm the last step you expected actually ran.
- `failed` → `failure.command` and `failure.code` point at the line; fix the do-file, resubmit.
- `timedout` → the ceiling was real (default 30 min). Either the job is genuinely that long —
  say so and raise `timeout` — or it is stuck in a loop you should kill.

Never report "it is still running" without one of these calls behind it.

Every estimation that will appear in a table gets `estimates store <name>`, so step 5 can build
the table from named estimates.

## Step 4 — estimate with structured results

Use `stata_model { command: "regress y x1 x2, vce(cluster id)" }`.
It returns `estimates[{name, b, se, t, p, ciLo, ciHi, omitted}]` and
`fit{n, r2, df_r, crit, F, omitted[]}`. Then:

- **Save it**: write the JSON to `output/estimates/<name>.json`. Tables and prose read this file.
- **Check the fit**: `n` must match the sample you intended; if it shrank, missing values ate rows
  (step 2 should have predicted that).
- **Check the omitted list**: `fit.omitted` non-empty means those terms were dropped for
  collinearity. Either fix the specification or say in the text which term was absorbed and why —
  never present a table that silently lost a variable.
- **Check the inference**: panel data → `xtset` + `vce(cluster <panel id>)`; stratified/clustered
  sampling → clustered SEs. If neither applies, say so explicitly rather than defaulting silently.
- **Report with uncertainty**: coefficient, SE, 95% CI, n. Not a bare point estimate.
- **Never** round to "significant" without the p-value and the CI in the same sentence.

For anything that is not `regress`-shaped (margins, `nlcom`, `test`, counterfactual simulation),
use `stata_run` and then `stata_results` to pull the scalar you need — and copy that scalar into
`output/estimates/` so it, too, has a home outside the transcript.

## Step 5 — table and figure

- Table: `esttab m1 m2 using "output/tables/tab1.rtf", replace se star(* 0.10 ** 0.05 *** 0.01) ///
  stats(N r2_a, labels("N" "Adjusted R2")) label`. Three-line style, no vertical rules, notes below.
- Figure: export PNG at `width(1200)`, then call `stata_graphs` and **look at the image**. Check
  axis labels, units, and whether the pattern you describe is actually visible.
- If a graph comes back only as SVG, say so and give the path; do not describe an image you could
  not see.

## Step 6 — audit before reporting

Run `stata_history` and compare against the files:

- [ ] every number in the answer traces to a do-file in `analysis/` or a file in `output/`;
- [ ] the last run of each do-file succeeded (`ok: true`);
- [ ] simulations have `set seed`;
- [ ] no `capture` is hiding a failed step (policy warnings flag these);
- [ ] the working directory in the ledger is the project, not someone's Desktop;
- [ ] if the cleaning step was supposed to leave the data intact, `stata_run ... , verify: true`
      (or `stata_signature` before and after) confirms `data.changed: false` — say it only if you
      have the fingerprints.

If a check fails, fix the do-file and re-run — do not hand-edit an output file.

## Reporting to the user

Structure: **what was asked → what the data are → what was estimated → what it shows → what it
does not show**. Numbers with uncertainty. Then the artefact list (`analysis/`, `output/`) so the
result is reproducible. If a step was skipped, say which and why.

## Hard rules

- Do not delete or overwrite data. `erase`, `!`, `shell` are refused by the server for a reason.
- Do not re-run an estimation to "make it significant" — changing the specification is a new
  analysis and must be reported as one (and recorded in `00-plan.md`).
- Do not report a coefficient from memory of an earlier run; read it back from
  `output/estimates/*.json` or re-run the do-file.
- If `stata_model` returns `isError` with no `e(b)`, the command was not an estimation — read the
  transcript, fix the command, do not write a table around an empty result.

## 中文速查（给中文用户和中文 agent）

工具与流程同上，这里只列最容易忘的四条：

1. **先看会话**：`stata_status` 确认 Stata 可达、`busy: false`、当前策略模式；不可达时错误里带 endpoint，
   照着 `--endpoint` / `STATA_COPILOT_ENDPOINT` 改，不要猜。
2. **写 do 文件，不要堆命令**：`10-import.do → 20-clean.do → 30-describe.do → 40-model.do → 50-figures.do`，
   每个文件自带 `version 18`、`clear all`、`set more off`、`set varabbrev off`、`log using`。写完先
   `stata_lint`（不执行、只读），error 必改，warning 要么改要么在报告里说明为什么接受。
3. **数字从结构化结果取**：`stata_model` 给 `b/se/t/p/ciLo/ciHi` 与 `fit{n,r2,F,df_r,crit,omitted}`；
   不要从回显里手抄系数，也不要凭记忆报上一轮的数。被 `omitted` 的变量要在报告里点名。
4. **跑得久就转后台**：插补、bootstrap、上千次循环用 `stata_job_submit` 起独立进程，`stata_job_status`
   轮询（带已跑秒数与日志尾）、`stata_job_log` 看进度、`stata_job_kill` 停。作业成败看日志里的
   `r(NNN);`，不看退出码——batch 模式下 do 出错 Stata 也返回 0。

汇报顺序：问题是什么 → 数据是什么 → 估计了什么 → 说明了什么 → **不能说明什么**；最后列 `analysis/` 与
`output/` 的产物清单，让别人能重跑。完整中文说明见仓库的 `README.zh-CN.md`。

