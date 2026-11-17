# UX review (post-rebuild): app-wide Usage page

Reviewer: UX Researcher. Build: 628214fe (`npm ci`, `npm run build`, worktree). Ran on `ORGAI_MOCK=1` with a throwaway data dir.
Seeded with the three-project, 12-run script and backdated over 52 days (10 runs fall in the 30-day period). 1600x1000 and
1024x640, dark and light, a keyboard pass at both sizes, one pass with App settings Reduce motion on.
Compared with the pre-rebuild review `docs/design/ux-review-usage-dashboard-pre.md`. I did not read code to judge feel.
Shots: `e2e/shots/ux/usage-dashboard-post/` (gitignored); walk scripts `walk1.mjs` to `walk5.mjs` in the same folder.

## Verdict

PARTLY FIXED, mostly a clear improvement. The page is now about half as long, the first screen answers "what did I spend and
on which project", the filter bar is opaque and the chart has a real tooltip, legend chips and a metric switch. Focus is
never lost. The main remaining problems are around narrowing and comparing: clicking a "Where it went" row throws the page
about 680 to 1200 px down so the chart you were narrowing is out of sight, "Compare with previous period" shows a ghost bar
while the Cost tile says "no prior data", and the runs table collides with itself at 1600.

## Page height (measured, `.usage-scroll` scrollHeight, All runs and the disclosures closed)

| Size | Before | After | Viewport |
| --- | --- | --- | --- |
| 1600x1000 | 2906 | 1367 (1.4 screens) | 952 |
| 1024x640 | 3881 | 1998 (3.4 screens) | 592 |

No horizontal page scroll at either size in either theme. The sticky filter bar is 80 px at 1600 and about 80 px at 1024 (one row now).

## Tasks

- "What did I spend this month and on what?" Done in one glance at 1600: $0.027+ with "7 of 10 priced", chart with a busiest-day line,
  legend chips with project totals, and "Where it went". Period buttons include "This month". Good.
- "Which project drove it?" Done: "Billing service is 42% of this period's estimated cost, counting only runs with a known price" plus ranked bars.
- "Compare with last period" Partly: tokens, runs and wall time show "vs prev. 30 d" with a delta, but the Cost tile says "no prior data" (see H2).
- "Find a wasteful run and open it" Done: Runs worth a look, expand arrow, "Open run" opens the run in its project (R3, Usage tab, "All usage" link back). The row link itself also opens it.

## Findings, ranked

### High

**H1. Clicking a row in "Where it went" jumps the page far away from the chart.** Shots `n-1600-narrow.png`, `n-1024-narrow.png`, `i06-narrow.png`.
Repro: 1600x1000, top of page, click "Billing service" in Where it went. Seen: `scrollTop` goes 0 to 677 (1600) and 390 to 1596 (1024),
the "All runs" disclosure opens by itself (page height 1367 to 1629, and 1855 after "Clear all filters", it stays open), a filter chip row is added
above the tiles (about 38 px layout shift), and the chart and tiles you were narrowing are off screen. The only confirmation is the
live region ("Filter added: Project: Billing service. 4 runs, estimated $0.011+.") and the sticky chip. Keyboard focus stays on the clicked row, so focus is not lost,
but a sighted user cannot see the effect of what they clicked. After "Clear all filters" at 1024 the page is left at scrollTop 1028, not back at the top.
Fix: do not scroll and do not open All runs on narrow; let the tiles and chart animate in place. If revealing runs is intended, make it an explicit link: row hint "Click to narrow", and a result line next to the chip "4 runs in Billing service. Show runs". Reserve the chip row height so nothing shifts.

**H2. "Compare with previous period" contradicts the Cost tile.** Shots `i03-compare.png`, `c-week-compare.png`.
Repro: Compare on, 30 days. The Cost tile still says "no prior data" while Tokens/Runs/Wall time say +367%, +400%, +560%. The chart adds one dashed
ghost bar (about $0.01, taller than every real bar, standing at 31 Oct) and rescales the Y axis, so the real bars shrink; in Week view the dashed ghost
sits on top of the 2 Nov bar. There is no total for the prior period anywhere. A user cannot tell what the ghost is, how it maps to a day, or why cost has no baseline.
Fix: say why in the tile: "No priced runs in the previous 30 days" instead of "no prior data" (tokens prove there was a previous period). When Compare is on, add a legend text "previous period: 19 Sep to 18 Oct, $0.0xx, 5 runs" and draw the ghosts at the same day offset with a tooltip line "Previous: Thu 8 Oct, $0.0043".

**H3. The Runs worth a look table collides at 1600.** Shots `1600-dark-s1.png`, `i06-narrow.png`, `i07-run-expand.png`.
Repro: 1600x1000, scroll to Runs worth a look (this table shares the row with Cost by tier). Seen: an inner horizontal scrollbar under the three rows, the "No result"
tag overlaps the date ("No result" sits on "14 Nov 2026" in the second row), the "Why listed" header is clipped ("Why liste"), and the reason is cut with an ellipsis. There is also an extra Tab stop on the table scroller (`DIV` "Runs worth a look", 1600 only). At 1024 the table is single column and fits.
Fix: drop the Why listed column (put the reason on the second line under the run name, as the project is today) or widen the card; keep tags on the name line and let them wrap, not overlay.

### Medium

**M1. Hiding a legend series reports nothing useful, and the rest of the chart dims.** Shot `i04-legend-hide.png`.
Repro: click the "Billing service" chip. Live region says "Chart shows cost." (not that Billing is hidden); the subtitle gains "1 hidden." and the Where card
dims the other two rows and outlines Billing, even though Billing is the one removed. The remaining bars look washed out until the pointer leaves the chip.
Fix: live "Billing service hidden. Chart shows 2 of 3 projects." and do not dim the remaining series on a hide click (only on hover of a visible one).

**M2. Choosing a period also adds a "Period: Last month" chip row.** Shot `e-lastmonth.png`.
Repro: click "Last month". The segmented control already shows it selected, yet a chip "Period: Last month x" and "Clear all filters" appear and push the tiles down 38 px (and the sticky bar grows to 2 rows, so the chart loses ground at 1024).
Fix: no chip for the period; show chips only for project/kind/day filters.

**M3. Cost per run is $0.0043 while the note says "Mean $0.0039".** Efficiency strip at both sizes.
Two different averages near each other with no label for which is which. Fix: "Typical run $0.0043 (median). Mean $0.0039. 3 runs have no price."

**M4. Weekly view ruins the sparklines.** Shot `c-week-compare.png`. In Week the Cost sparkline becomes a nearly flat line with stray dots and Tokens/Runs/Wall time become smooth ramps; the tiles read as trends that do not exist. Fix: keep tile sparklines daily regardless of the chart grouping.

**M5. Weak "can I click this" cues.** The ranked rows in Where it went, and the tiles as chart switches, look static. Only the underline under Cost shows it is the active metric; the other tiles say nothing. Fix: hint under the card title "Click a row to narrow the page" and a title on tiles "Show tokens in the chart".

### Low

- **L1.** The tile accessible name repeats the value ("Estimated cost $0.027+ $0.027+ no prior data Point at the sparkline to read a day; the chart is the keyboard path.") and every tile carries that instruction. Fix: name = "Estimated cost, $0.027+, 7 of 10 priced"; put the instruction once on the page.
- **L2.** Month grouping is dimmed in a 30-day period; the note "Months are available for spans of 60 days or more" only appears with Compare on (text seen in the chart card); show it as a title on the disabled button.
- **L3.** Tiles "Wall time" is not a chart switch and not a Tab stop, while the other three are; no hint says so.
- **L4.** The Runs worth a look sort select is still a native select, unlike the other controls (carried over, was L4 before).
- **L5.** Sparkline hover works (a dot and "8 Nov . 2.5k" appear, `f-spark-hover.png`) but is mouse only; the keyboard path is the chart.
- **L6.** In dark theme the project bars in "Where it went" and chart share colours (good). In light they use dark navy, light blue and dark green; Mobile app (dark green) and Billing (navy) are close at a glance. Check contrast between those two.

## Status of the pre-rebuild findings

| Earlier | Now |
| --- | --- |
| H1 sticky bar see-through, collides with table headers | Fixed: opaque bar, no overlap seen at either size or theme |
| H2 ten cards, 2906 / 3881 px | Fixed in large part: 1367 / 1998 px, disclosures hold the secondary content |
| M1 chart hard to read | Mostly fixed: crosshair tooltip near the bar, chips, every second date under a bar; unknown-cost stub still tiny |
| M2 hover/pick not discoverable | Partly: tooltip and chips are good; day pick no longer explained, ranked rows do not say they narrow (M5 above) |
| M3 caveat repeated | Fixed: one "7 of 10 priced" chip on the tile |
| M4 efficiency wall of text | Fixed: four measures, rest behind "More signals (4)" |
| M5 wasteful table clipped at 1024 | Fixed at 1024, regressed at 1600 (H3) |
| M6 bars carry no meaning | Fixed for project; model/role/connection bars use one colour (acceptable, share is printed) |

## Motion

Reduce motion on (App settings): every element under the page has a computed `transition-duration` of 0; I sampled `document.getAnimations()` on
each of: metric tile switch, Where it went tab change, period change, expand run details, and every one has a 0.01 ms duration, so the KPI bar,
tab underline, bar morph, number tween and row detail expand do not move. Nothing is lost: values, the "7 days" result (11 Nov to 17 Nov, 6 runs, $0.016+),
expanded details and chips were all present. With motion on I only saw the end states (screenshot-based), not the motion quality, so I cannot judge easing.

## Keyboard pass

Start at the period group, Tab to the end of the page. Stops from the filter bar to the last control, in order (1600 / 1024):
period group (one stop), All projects, All kinds, Cost tile, "7 of 10 priced" link, Tokens tile, Runs tile, metric radio group, grouping radio group, Compare, Table, three
legend chips, the chart (one roving stop; first focus lands on the latest bar), Where it went tab list (one stop), the first ranked row, Show as table, Efficiency info buttons (the first one, then More signals (4), Team timing, Show as table),
the sort select, 3 x (details toggle, run link), "Show 5 more", Cost by tier Show as table, All runs summary, What these terms mean. About 33 stops at 1600 and 32 at 1024 (the 1600 list has one extra stop on the table scroller). After the last control focus wraps to "Skip to content" at the top of the app.
Focus was never lost to the document body in 67 stops. Every stop showed a 2 px outline; the KPI tiles show an inset 2 px ring on Tab (`f-kpi-tab-focus.png`). The tiles use `outline: none` plus a ring, visible in the shot. At 1024 no focused control sat under the sticky bar when the browser scrolled to it (probe: none overlapped the bar).
Wall time is not a stop (by design, not a chart metric). Arrow-key navigation inside the chart, the Where tab list and efficiency strip I did not exercise (covered by `e2e/usage-app.mjs`).

## Not driven

- First-launch empty state and a filtered-to-nothing state (no data was removed; the mock seed always has runs).
- A run in progress while the page is open; legacy/partial data notes; real provider prices.
- Save CSV (native dialog); Copy as CSV was not re-run.
- Months... picker, Role / Connection tabs beyond reading their text, the "More signals", "Team timing" and "All runs" disclosure contents beyond a glance, the Efficiency info popovers.
- Motion quality with motion on (easing, stagger); I only verified end states and that Reduce motion zeroes durations.
- Screen reader speech; I read live-region text only.
- Light theme at 1024 was looked at in one screenshot (`1024-light-s1.png`) plus 1600 top; the rest I checked by layout numbers only.
