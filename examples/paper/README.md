# A paper, one chapter at a time

`real-analysis/` shows the tools talking to each other. This folder shows the
shape a real study takes when an agent is involved: **numbered do-files**, one
job each, a log per file, and every product of the run written under `output/`
so a coauthor can check it without rerunning anything.

```
paper/
  analysis/
    00-plan.md        the question, the data, the design — written before any code
    10-import.do      load, label, assert the unit of observation
    20-clean.do       derived variables, missing-data count, save the analytic file
    30-describe.do    Table 1: describe and compare by group
    40-model.do       Table 2: three models, stored estimates, exported table
    50-figures.do     Figures 1-4, exported at two-column width
    run-all.do        the same five files, in order, from a plain Stata session
  data/auto.dta       Stata's 1978 automobile data
  output/             logs, tables, figures, estimates, REPORT.md (generated)
  run.mjs             drives the chapters through the MCP server
```

## Why numbered files instead of one do-file

The numbers are the order of execution, and that is the only thing they mean.

- **A failure names its step.** `run.mjs` stops at the first chapter that fails
  and prints that chapter's output, so "the run broke" becomes "50-figures.do
  broke, at the coefficient plot".
- **Each file is rerunnable alone.** `10-import.do` does not depend on `40-model.do`
  having run; `50-figures.do` reloads the dataset and the stored estimates it needs.
  You can iterate on the figures without re-estimating anything.
- **A log per file** (`output/logs/40-model.log`) is the audit trail. The log is
  opened at the top of the file and closed at the bottom, so a crash leaves a
  truncated log that says exactly where it stopped.
- **The state travels through `output/`, not through the session.** The cleaned
  dataset is saved by `20-clean.do` and loaded by `30-`/`40-`/`50-`; the models are
  appended by `40-model.do` and reloaded by `50-figures.do`. Nothing depends on
  "the thing I ran two files ago".

## The chapter contract

Every do-file starts the same way:

```stata
version 18
clear all
set more off
capture log close <name>
log using "../output/logs/<file>.log", replace text name(<name>)
```

`version 18` pins the language, `clear all` makes the file independent of whatever
was in memory, and the `capture log close` line makes rerunning a file that died
mid-log safe. The file ends with `log close <name>` — a bare `log close` would
close whichever log happens to be open.

## What each chapter teaches

**`10-import.do` — never assume the unit of observation.** `describe, short`
gives the size, `isid make` asserts one row per car model, and `codebook foreign,
compact` shows the coding of the group variable before anything is computed from
it. If `isid` fails, every later table is suspect.

**`20-clean.do` — cleaning decisions are visible.** Derived variables (`lprice`,
`w1000`) are created here, value labels are attached here, and the number of
observations touched by missing data is *counted* rather than silently dropped by
listwise deletion. `compress` then shrinks the file that the next chapters load.

**`30-describe.do` — Table 1 with a harness, not by hand.** `estpost summarize`
plus `esttab` writes the `.rtf` and a `.csv` for version control; `tabstat ...,
by(foreign)` adds the by-group comparison. The table is regenerated, never
copy-pasted.

**`40-model.do` — every model in a table is a named estimate.** `estimates store
m1` and friends mean the table is built from objects, and `esttab m1 m2 m3 using
...` is the only place the numbers reach the manuscript.

One Stata detail worth knowing: `estimates save` writes the **active** result set,
one set per call. Persisting three stored models takes a loop:

```stata
estimates restore m1
estimates save "../output/estimates/all", replace
estimates restore m2
estimates save "../output/estimates/all", append
estimates restore m3
estimates save "../output/estimates/all", append
```

and reading them back takes the matching form:

```stata
estimates use "../output/estimates/all", number(1)
estimates store m1
estimates use "../output/estimates/all", number(2)
estimates store m2
```

**`50-figures.do` — export the figure you just drew.** `graph export` with
`name()` of an older graph can fail once several graphs are in memory
(`could not find Graph window`); exporting immediately, with no `name()`, always
exports the current graph. Each figure is `width(1200)` so the axis labels survive
a two-column layout.

Two habits this file is trying to install:

- a legend with an explicit `order()` and readable labels — the default legend for
  a four-element `twoway` is unreadable;
- `margins` + `marginsplot` for predicted values, instead of a hand-built grid of
  `predict` calls.

## Running it

Through the server (the path an agent takes):

```bash
node examples/paper/run.mjs
```

Without an agent, in plain Stata:

```stata
cd examples/paper/analysis
do run-all.do
```

Both routes produce the same `output/` tree. `output/REPORT.md` is written by
`run.mjs` and lists the chapters, the artifacts, the figures and the logs — it is
generated, so do not edit it.

Two notes on the agent route:

- each chapter is one `stata_run_do` call, so a failed chapter stops the run and
  the ledger (`analysis/.stata-copilot/runs.jsonl`) gets one row per chapter;
- the do-files run as **files** (`do "..."`), not as pasted code, so relative
  paths, `log using`, `graph export` and `estimates` behave exactly as they do in
  a Stata session you drive by hand.

## What this example is not

`auto.dta` is a teaching dataset with 74 cars. The regression in `40-model.do` is
not a causal estimate, `weight` and `length` are collinear, and the log-price
specification in column 3 is there to show an interaction, not to make a claim.
The example is about the *workflow*: numbered chapters, logged runs, tables and
figures that are regenerated from code.
