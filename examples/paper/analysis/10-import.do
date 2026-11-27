* 10-import.do — load, label, and prove the data are what you think they are.
*
* Every file in analysis/ has the same four-line preamble. It is boring on
* purpose: version pinning, a clean session, no pager, and a log that lands in
* output/logs/ so the transcript is never the only record.

version 18
clear all
set more off
capture log close import

log using "../output/logs/10-import.log", replace text name(import)

use "../data/auto.dta", clear

describe, short
label data "1978 automobile data (Stata auto.dta)"
codebook foreign, compact

* The unit of observation must be stated out loud, not assumed.
di as txt "one row = one car model; N = " _N
isid make

log close import
