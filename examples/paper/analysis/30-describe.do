* 30-describe.do — table 1.
*
* `estpost summarize` + `esttab` is the shortest path from numbers to a table a
* journal would accept; the .rtf opens in Word, the .csv is for checking.

version 18
clear all
set more off
set varabbrev off
capture log close describe

log using "../output/logs/30-describe.log", replace text name(describe)

use "../output/auto-clean.dta", clear

estpost summarize price mpg w1000 lprice, detail
esttab using "../output/tables/tab1-descriptives.rtf", replace ///
    cells("count mean sd min p50 max") ///
    noobs nonumber label ///
    title("Table 1. Descriptive statistics") ///
    note("Source: Stata auto.dta, 74 cars. Price in 1978 USD.")

esttab using "../output/tables/tab1-descriptives.csv", replace ///
    cells("count mean sd min p50 max") noobs nonumber plain

* Distribution by origin, because a mean hides the two markets.
tabstat price mpg w1000, by(foreign) statistics(n mean p50 sd) format(%9.2f)

log close describe
