* 40-model.do — estimation, stored estimates, table 2.
*
* One model per block; every model that appears in a table is `estimates store`d
* so the table is built from named estimates rather than retyped numbers.

version 18
clear all
set more off
set varabbrev off
capture log close model

log using "../output/logs/40-model.log", replace text name(model)

use "../output/auto-clean.dta", clear

* (1) Baseline: does size explain price?
regress price mpg weight length
estimates store m1

* (2) Same specification, heteroskedasticity-robust standard errors.
regress price mpg weight length, vce(robust)
estimates store m2

* (3) Log price with an origin-specific slope on weight.
regress lprice i.foreign##c.w1000
estimates store m3

esttab m1 m2 m3 using "../output/tables/tab2-models.rtf", replace ///
    b(%9.3f) se(%9.3f) star(* 0.10 ** 0.05 *** 0.01) ///
    stats(N r2 r2_a, labels("N" "R2" "Adjusted R2") fmt(%9.0f %9.3f %9.3f)) ///
    mtitles("Price" "Price, robust SE" "Log price") ///
    label title("Table 2. Price models") ///
    note("Heteroskedasticity-robust SE in column 2. Column 3: OLS on log price.")

esttab m1 m2 m3, b(%9.3f) se(%9.3f) star(* 0.10 ** 0.05 *** 0.01) stats(N r2)

* Stored estimates live in memory only. `estimates save` writes the ACTIVE
* result set — one set per call — so each model is restored and appended in
* turn: one file, three result sets, in the order m1, m2, m3.
estimates restore m1
estimates save "../output/estimates/all", replace
estimates restore m2
estimates save "../output/estimates/all", append
estimates restore m3
estimates save "../output/estimates/all", append

* Factor notation is not a temporary flourish: `i.foreign##c.w1000` adds the
* expanded terms to the dataset as ordinary variables, and `estimates restore`
* brings them back with the snapshot. The chapter's product is the .ster file
* and the table, not a mutated dataset, so hand the next chapter a clean copy.
use "../output/auto-clean.dta", clear

log close model
