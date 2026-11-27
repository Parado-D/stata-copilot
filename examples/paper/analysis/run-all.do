* run-all.do — the whole paper, in order, from a plain Stata session.
*
* This is the file you hand a referee or a coauthor: it needs no agent and no
* MCP server, only Stata and the two packages the tables use (estout, coefplot).
*
*     cd examples/paper/analysis
*     do run-all.do
*
* Under an agent, prefer `examples/paper/run.mjs`, which runs the same files
* one at a time through `stata_run_do` so each step is a separate ledger row and
* a failure names the step that failed.

version 18
clear all
set more off
capture log close

log using "../output/logs/run-all.log", replace text name(all)
di as txt "run-all started: " c(current_date) " " c(current_time)

do "10-import.do"
do "20-clean.do"
do "30-describe.do"
do "40-model.do"
do "50-figures.do"

di as txt "run-all finished: " c(current_date) " " c(current_time)
log close all
