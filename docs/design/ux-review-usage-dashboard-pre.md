# UX review (pre-change): app-wide Usage page

Reviewer: UX Researcher. Build: d81e2425 (`npm run build`, worktree). Ran on `ORGAI_MOCK=1` with a throwaway data dir.
Sizes 1024x640 and 1600x1000, dark and light, one keyboard pass at 1024 dark. Compared with `docs/design/usage-app.md`.
Shots: `C:\Users\chapp\Projects\OrgAI\e2e\shots\ux\usage-dashboard\` (gitignored). Walk scripts and seed: `e2e/shots/ux/` in the worktree (gitignored, not committed).

Purpose: evidence of what a first-time user sees today, before the redesign. No source was changed.

## Data used

Two projects (Billing service, Mobile app), 7 mock runs seeded through the IPC, then cloned into 20 run records with
start times backdated by editing the run files and `runs.json` in the data dir before launch (0.2 to 27.5 days ago).
So the 30-day chart has 14 populated days. Limits of the data: every run has the same tokens (3.3k), cost ($0.0057) and
cache hit (63%) and ends the same way (stopped with one agent that "returned nothing"), so the Wasteful runs list
shows all 20 runs with the identical reason, and Efficiency figures (50% no result, 0 nudges, 1.0x overlap) are flat.
Those are mock artefacts, not page defects. Bars differ only by number of runs per day and by 3 unpriced runs.

## Verdict

NOT CLEAN. The page is correct and well worded, and the keyboard model is good (one roving stop for the chart, a visible
2 px focus ring everywhere). But it is a single long stack of ten same-weight bordered cards. At 1024x640 it is 3881 px
tall (6.6 screens of 592 px); at 1600x1000 it is 2906 px (3 screens of 952 px). The sticky filter bar eats a fifth of
the small viewport and is not opaque, so content shows through it. The one chart is the weakest element: it is mostly
empty, hard to map to dates and its hover and day-pick behaviour is invisible until tried.

## Above the fold

| Size | What is visible without scrolling |
| --- | --- |
| 1024x640 (page area 592 px tall) | Scope line and subtitle, Period / Group by / date range / project / kind controls on two rows (102 px), five summary cards, the unpriced note, and the heading, subtitle, Cost/Tokens switch and top 200 px of the spend chart. The chart baseline, axis and legend are below the fold (`1024-dark-01-top.png`). |
| 1600x1000 (952 px) | Same, plus the whole spend chart with legend and axis, and the top of By project / By model / By role (`1600-dark-01-top.png`). Filter bar is one row (66 px). |

## Scroll needed per section (measured, px from the top of the scroll area)

| Section | 1024x640 top (height) | 1600x1000 top (height) |
| --- | --- | --- |
| Filters | 70 (102) | 70 (66) |
| Summary | 188 (102) | 153 (86) |
| Spend over time | 346 (458) | 295 (440) |
| By project / model / role | 820 / 1078 / 1428 (stacked) | all at 751, 3-up (366 high) |
| Efficiency (with timing) | 1810 (766) | 1133 (478) |
| Cost by tier + lead compare (Staffing) | 2592 (403) | 1627 (403) |
| Runs worth a look | 3011 (737) | 2046 (727) |
| All runs (collapsed, 52 px) | 3764 | 2789 |
| Total / viewport | 3881 / 592 | 2906 / 952 |

At 1024 a user reaches All runs after about 6 screens. The sticky bar takes 102 px of 592 (17%) while scrolling.

## Findings, ranked

### High

**H1. The sticky filter bar is see-through and collides with sticky table headers.**
Repro: open Usage at 1024x640, scroll to Runs worth a look (or at 1600 scroll to the Lead alone table).
Seen: the table header text ("Run", "When", "Cost", or "Runs", "Count", "Median wall time", "Median cost") draws over the
filter bar, on top of the kind picker or Period control, and rows scroll visibly behind the bar.
At 1600 with "Months..." open the From select overlaps the bar and the bar shows a stacked table header.
Shots: `1024-dark-s07.png`, `1600-dark-s04.png`, `1600-dark-i07-months.png`.
Why High: controls become partly unreadable and unclickable-looking on the main interaction surface. (Table header stickiness vs bar is
from observation; I did not read the CSS for the cause.)
Fix: make the bar opaque (surface token, bottom border) and give table headers `top` equal to the bar height or stop them being sticky; do not let two sticky layers share a z-level.

**H2. Too much page, no way to jump: ten equal cards in one column.**
Repro: scroll at 1024x640. Seen: 6.6 screens; Efficiency alone is 766 px (eight tiles, each a number, a bar and a sentence, then four
definition tiles); Wasteful runs 737 px; All runs is collapsed to one line at the end. Nothing orients the reader (no section index, no sticky
section title, no collapse for secondary sections), so "where is the expensive stuff" needs a full scroll. `1024-dark-s04.png`, `s05.png`, `s09.png`.
Fix: lead with a decision-sized overview (cost, change vs previous period, top spender) and put Efficiency, Staffing, Wasteful and All runs behind a
section switch or anchored sub-nav. Suggested nav labels: "Overview", "Where it goes", "Efficiency", "Runs".

### Medium

**M1. Spend chart is hard to read.** `1600-dark-01-top.png`, `1600-dark-i01-hover.png`.
- 14 populated days of 18 slots, bars about 20 px wide in a 900 px plot, so most of the plot is empty space.
- Y axis stops at $0.02 with $0.005 steps; x labels every second day while bars are daily, so a label sits between bars, not under one ("20 Oct" between two bar slots).
- The unknown-cost stub (dashed, 14 px, "1 Nov", "16 Nov") is a tiny symbol at the axis; the hatched top on 11 Nov is similar. Both are explained only in a 12 px grey paragraph under the chart.
- The legend (project colour + total) is on the right and is also the project filter, but nothing says so.
Fix: label every bar or tick weekly with dates under the bar, a lighter grid, widen bars when few days; place the readout as a tooltip near the bar; show the legend as filter chips ("Show only Mobile app").

**M2. Hover and day pick are not discoverable and the result is jumpy.** `1600-dark-i01-hover.png`, `1600-dark-i02-daypick.png`.
Seen: the only hint is "30 days. Hover or focus one for its figures." in small grey text. Hovering shows a sentence below the axis
("Sun 1 Nov: unknown, 1 run. Billing service unknown.") far from the pointer. Clicking a bar adds a chip row above the summary, pushing everything down by about 40 px, and
the page title scope now says "1 run". Panels below switch to "No price" states with no link back to the picked day other than the chip.
Fix: hint copy "Click a day to see only its runs"; keep the chip row reserved (no layout shift); on pick, scroll nothing and flash the changed counts once.

**M3. Summary cards repeat the same caveat three times.** `1024-dark-01-top.png`.
"$0.097+", "from 17 of 20 runs / 3 runs have no price" (link), then a line under the cards "3 runs have no known price, so costs are at least these figures", then the chart subtitle "Estimated $0.097+ across 20 runs".
Cards carry no comparison (previous period, change) and have identical weight; "Runs 20" and "Wall time 3m 00s" are not distinct from the money cards.
Fix: one caveat, once, attached to the cost card; add "vs previous 30 days" under cost and runs.
Recommended copy: card "Estimated cost" / "$0.097 or more" / "3 of 20 runs have no price. Set prices"; delete the line under the cards.

**M4. Efficiency is a wall of small text.** `1024-dark-s04.png`, `1024-dark-s05.png`, `1600-dark-s02.png`.
Eight tiles plus four definition tiles each with an info icon and a long explanatory sentence ("How many reports were working at the same moment, on average. 1.0x means ...").
Some tiles use bars (cache hit, retries, no result, waiting), some a tick strip (cost per run, tokens per turn), some none (time to first spawn, overlap, tail), so scanning does not work.
The title sentence "50% of tokens went to agents that returned nothing" is the only conclusion and it is 13 px.
Fix: show the top three signals as larger tiles; fold the rest under "More measures"; move definitions into the info popover only.

**M5. Wasteful runs table is clipped at 1024.** `1024-dark-s07.png`, `1024-dark-s09.png`.
The Status column is cut off ("Stopp") and a horizontal scrollbar sits inside the card. The "Why listed" column is the widest and holds the same sentence on every row.
Fix: drop the sentence column to a tooltip or second line under the run name; keep Run, When, Cost, Status.

**M6. Model, role and project bars carry no meaning.** `1024-light-s03.png`, `1024-dark-s02.png`.
Light theme model and role bars are all the same dark slate; in dark they are pale grey. Only By project uses the legend colours. The share of the whole is in a right-aligned sentence, not in the bar length (each bar is scaled to its own maximum, so two bars with 57% and 28% differ in length but the percent is a separate small number).
Fix: label bars with the share inside or at the bar end, and use one accent for the leader.

### Low

**L1.** Filter bar at 1024 wraps the kind picker to its own row, so the bar is 102 px and the date range text floats to the right of Group by. Fix: move the date range into the Period control's label or drop it (it is also in the header line).
**L2.** "Months..." opens a From and a To select inline with a 400 px wide From select and a "-" glyph; a month picker would be quicker. `1600-dark-i07-months.png`.
**L3.** Every card has its own border and inner tables add row rules, so the page is dense with lines; cards inside cards (Staffing holds a table with its own header band). `1024-light-s06.png`.
**L4.** The sort select in Runs worth a look is the only native-styled select on the page and looks unlike the filter dropdowns. `1600-dark-s04.png`.
**L5.** All runs is a 22 px heading on a collapsed card, larger than any other heading on the page (the others are 13 px bold). The hierarchy is inverted: the biggest element is the one most hidden. `1024-dark-s09.png`.
**L6.** "What these terms mean" is a small disclosure at the page end; definitions are needed next to Efficiency, not after All runs.
**L7.** Run names show raw markers ("Priced work mockcomputed-cost"): a mock artefact (the prompt marker), not a page defect.

## Interactions that exist but are hard to find

- Click a spend bar to filter to a day (only a 12 px hint).
- Click a project legend row to filter to that project (looks like a plain legend).
- Click a row in By project to drill to its runs (rows look static; the hint is in the spec, not on screen). I did not drive this on screen beyond reading the roving stops in the keyboard pass.
- "Show as table" under every card (visible, small).
- "Set a price" link inside the models panel and "3 runs have no price" link in the summary.
- Weeks/Month grouping: "Month" is dimmed in a 30-day period with no explanation of why.

## Statistics a user would expect and cannot find

All of these were looked for on the page and not found (not checked in code):
- Change versus the previous period (cost, runs, cost per run).
- A projected end-of-month figure or any budget/limit line against the spend chart.
- Spend per day for the picked project beyond the stacked bars; spend by hour or weekday.
- Input vs output vs cached tokens split in the summary.
- Search or project filter inside All runs (it is filtered by the top bar only; sort buttons exist on columns).
- Cost per model over time; which role or model grew the most.

## Keyboard pass (1024 dark)

Tab order from the topbar: Copy as CSV, Save CSV..., then (Months selects were open from earlier) Period radio group, project picker, kind picker, chip remove, Clear all, the spend bars as one roving stop, legend rows, "Show as table" per card, panel rows, info buttons, the Wasteful sort select, run links, All runs summary and its column sort buttons and run links, "What these terms mean", then sidebar. About 40 stops to leave the page: the content tab stops come after the filter bar, so the order matches reading order.
Observed: every stop had a 2 px solid outline; the bar stop (`1024-dark-k*.png`) is a single roving stop. Focus moves under the sticky bar (stops listed at y of 423 to 436 right below the 150 px bar, so they land near the bar edge) which I did not judge as hidden. I did not use arrow keys to move between bars in this pass (the e2e script `e2e/usage-app.mjs` covers it).

## Light theme

Same layout. Contrast looks adequate for body text; the muted grey on small captions (the "Updated 16:01", axis labels, "30 days. Hover or focus..." line) is the lowest. Model and role bars are one slate colour (M6). The bars in the Cost by tier strip (blue and dark green) read well. No light-only defects other than those above (`1600-light-01-top.png`, `1024-light-s03.png`, `1024-light-s06.png`).

## Not driven

- First launch empty state and the filtered-empty state (covered by `e2e/usage-app.mjs`; not re-walked).
- A live run with the page open, the legacy and partial-data notes, and real provider data.
- CSV Save... (native file dialog; Copy as CSV was clicked and said "Copied 20 runs as CSV."; clipboard contents not read).
- Arrow-key navigation inside the chart and the efficiency grid; screen reader speech.
- Mouse project-row and legend drilldowns beyond the spend bar day pick; Week and Tokens views were switched but not reviewed in detail (`1600-dark-i10-tokens-week.png` exists).
- Dark and light at 1024 x 640 and 1600 x 1000 were screenshotted at each scroll step; I looked at a subset (the top, the middle and the end of 1024 dark, the top and run tables at 1600 dark, two 1024 light and the 1600 light top).
- The message with this list to the Product Designer (`designer-usage-2`) could not be delivered: that agent could not be resumed.
