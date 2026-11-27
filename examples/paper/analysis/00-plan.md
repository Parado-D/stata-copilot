# Plan

**Question.** How much of the price of a 1978 automobile is explained by size and
efficiency, and does the answer survive heteroskedasticity-robust inference?

**Data.** `data/auto.dta` — Stata's 1978 automobile data. One row per car model
(74 rows). `price` in USD, `weight` in lbs, `mpg` in miles per gallon,
`foreign` = 1 for imports.

**Design.** OLS of `price` on `mpg`, `weight`, `length`; the same specification
with `vce(robust)`; and a log-price model with an interaction between origin and
weight. The identifying variation is cross-sectional: cars differ in size and
efficiency, and no causal claim is made beyond conditional association.

**What this is not.** A causal estimate. `weight` and `length` are collinear by
construction, so individual coefficients are unstable even when the fit is
stable — the robustness table shows exactly that.
