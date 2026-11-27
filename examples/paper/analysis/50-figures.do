* 50-figures.do — the figures, with enough care for the axis labels.
*
* Rules of thumb that this file is meant to teach:
*   - each figure is exported at width(1200) so it survives a two-column layout;
*   - the export happens right after the figure is drawn, while it is still the
*     current graph; naming an older graph in a later export is what makes a
*     "could not find Graph window" error appear;
*   - a legend gets an explicit order() and labels, because the default is unreadable;
*   - "does the pattern I describe actually appear in the image?" is answered by
*     calling stata_graphs and looking at the PNG, not by trusting the do-file.

version 18
clear all
set more off
capture log close figures

log using "../output/logs/50-figures.log", replace text name(figures)

use "../output/auto-clean.dta", clear

* `estimates use` also moves one result set at a time: load the k-th set by
* number and re-store it under its name before coefplot can find it.
estimates use "../output/estimates/all", number(1)
estimates store m1
estimates use "../output/estimates/all", number(2)
estimates store m2

* --- Figure 1: distribution, with the normal curve for reference -------------
histogram price, percent normal ///
    fcolor(navy%25) lcolor(navy) ///
    xtitle("Price (1978 USD)") ytitle("Percent") ///
    title("Prices cluster below 10,000 USD") ///
    name(fig1, replace)
graph export "../output/figures/fig1.png", width(1200) replace

* --- Figure 2: two markets, two fits ----------------------------------------
* Separate scatters and separate fits: a single pooled line would hide the jump.
twoway (scatter price weight if foreign == 0, msymbol(Oh) mcolor(gs8)) ///
       (scatter price weight if foreign == 1, msymbol(+) mcolor(navy)) ///
       (lfit price weight if foreign == 0, lcolor(gs6)) ///
       (lfit price weight if foreign == 1, lcolor(navy)), ///
    legend(order(1 "Domestic" 2 "Foreign" 3 "Domestic fit" 4 "Foreign fit") rows(2)) ///
    xtitle("Weight (lbs.)") ytitle("Price (1978 USD)") ///
    title("Heavier cars cost more; imports sit higher") ///
    name(fig2, replace)
graph export "../output/figures/fig2.png", width(1200) replace

* --- Figure 3: coefficient plot from stored estimates ------------------------
* The point estimates are identical in m1 and m2; only the intervals move.
* Weight's interval (about 0.5-3.0 USD per pound) is thinner than one pixel on
* this axis — that is the estimate, not a missing confidence interval.
coefplot (m1, label("OLS")) (m2, label("Robust SE")), ///
    drop(_cons) xline(0, lpattern(dash)) ///
    xlabel(-300(100)100) ///
    xtitle("Coefficient on price (1978 USD)") ///
    title("Robust SEs move the interval, not the estimate") ///
    name(fig3, replace)
graph export "../output/figures/fig3.png", width(1200) replace

* --- Figure 4: marginal predictions, the modern way -------------------------
* margins + marginsplot replaces hand-built prediction grids.
quietly regress price i.foreign##c.weight
margins foreign, at(weight = (1800(400)4800))
marginsplot, ///
    ytitle("Predicted price (1978 USD)") xtitle("Weight (lbs.)") ///
    title("The foreign premium grows with weight") ///
    name(fig4, replace)
graph export "../output/figures/fig4.png", width(1200) replace

log close figures
