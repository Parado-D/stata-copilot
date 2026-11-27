* 20-clean.do — derived variables only. Never edit the source .dta in place.
*
* Anything a reader would have to reverse-engineer from the model code belongs
* here, with a label, so the table can print words instead of names.

version 18
clear all
set more off
set varabbrev off
capture log close clean

log using "../output/logs/20-clean.log", replace text name(clean)

use "../data/auto.dta", clear

gen lprice = ln(price)
label variable lprice "Log price"

gen w1000 = weight / 1000
label variable w1000 "Weight (1000 lbs)"

gen byte us = 1 - foreign
label variable us "Built in the US"
label define yesno 0 "No" 1 "Yes"
label values us yesno

* Missingness that matters for the sample must be visible before it bites.
misstable summarize price mpg weight length lprice w1000
count if missing(price) | missing(mpg) | missing(weight) | missing(length)

compress
save "../output/auto-clean.dta", replace

log close clean
