# QA: app-wide Usage page (re-walk of fixed findings, break-ui, motion, keyboard)

QA Engineer, 2026-11-17. Build: dev at merge 26997cdc (`npm ci`, `npm run build` in a worktree). Everything ran on the built app
with `ORGAI_MOCK=1` and throwaway data dirs, no provider, no tokens. Windows 11, Electron via `e2e/lib.mjs` (Playwright).
Screenshots: `e2e/shots/ux/usage-dashboard-qa/` (gitignored; named below). Walk scripts and the data seeding/backdating scripts
sit in the same folder (`seed.mjs`, `mutate.mjs`, `walk1.mjs` to `walk12.mjs`, `probe.mjs`, `qa.mjs`); they are scratch files, not
part of the repo.

## Verdict: PASS

No Critical and no High defect. The five fixed walk findings (H1 to H3, M1, M2) are fixed. The worst cases did not produce
overlap, a "$0" for an unknown cost, page-level sideways scroll, or a stuck animation. There are three Medium and several Low
defects, listed below with repro. The standard gates (typecheck, unit tests, build, usage-app/motion/usage/layout e2e) were run by
the orchestrator, not here; I only built.

## Data used

Seeded through the IPC like `e2e/usage-app.mjs` (mock adapter), then run records and `runs.json` backdated by script so there is
a multi-day chart and a previous period:

| Set | Content |
| --- | --- |
| base | 3 projects (one 63-character name), 12 runs (priced, unpriced "mock-unpriced", "no result" agents) spread over 52 days: 10 runs in the 30-day period, 3 in the previous one |
| many | 14 projects (one 63-character name), 320 runs over 85 days, 31 of 110 runs in the 30 days unpriced |
| dense | 14 projects, 270 runs in 30 days (128 chart segments) |
| ninety | 14 projects, 150 runs over 150 days |
| single | exactly one run |
| unpriced | base with every price removed |
| huge | base with tokens x 40000 (984.80M tokens, $1,377.60+) |

## 1. Re-walk of the fixed findings (1600x1000 and 1024x640, dark; light looked at in screenshots)

| Check | Result | Evidence |
| --- | --- | --- |
| H1 a "Where it went" row narrows without scrolling the page | PASS both sizes. At 1600 and at 1024 (row scrolled into view first, then a mouse click) `scrollTop` did not change by the click; it moved 16 px only because the page got 16 px shorter (see L5, scroll anchoring keeps the chart in place) | `1600-h1-narrowed.png`, `1024-h1-narrowed-scrolled.png` |
| H1 does not open All runs | PASS (`details.open` false before and after) | same |
| H1 no layout shift from the chip line | PASS: the KPI band top is 178 px before and after at 1600; the chip lives on the always-present scope line. The 16 px shift below the KPI band is the Cost tile losing its "not compared" caveat when the narrowed project has nothing unpriced (content, not the chip) | `1600-h1-narrowed.png` |
| H1 clearing filters leaves a sensible scroll position | PASS with a note. From the top it stays at 0. From scrollTop 300 "Clear all filters" jumps to 0 (see L1); the earlier walk's 1028 px jump is gone | walk1 log |
| H2 Cost tile explains itself with Compare on | PASS: "not compared: some runs have no price" in the base set (some runs unpriced); "No priced runs in the previous 30 days" in the unpriced set. No "no prior data" where tokens prove a previous period | `1600-h2-compare-day.png`, `unpriced-1600-dark-top.png` |
| H2 overlay key names the previous period and total | PASS: "Previous 30 days: $0.0043+" and "previous cost unknown" | `1600-h2-compare-day.png` |
| H2 outlines on matching buckets | PASS: measured offset between each dashed outline and the bar centre of the same bucket is 0.00 px in Day grouping and 0 px in Week grouping, both sizes | `1600-h2-compare-day.png`, `1600-h2-compare-week.png`, `1024-h2-compare-week.png` |
| H2 tooltip "Previous:" line | PASS: "Previous: no runs" on a bucket with no previous value, a value on others | `1600-h2-tooltip.png` |
| H3 Runs worth a look at 1600: no inner horizontal scrollbar, no tag over the date, no clipped header | PASS: no scroller wider than its box, no clipped `th`, no overlapping text boxes in any row; tags ("Stopped", "Run", "No result") sit on the name line; the table has no extra Tab stop | `1600-h3-wasteful-crop.png` |
| M1 hiding a legend series announces it and does not dim the rest | PASS: live region says "<project> hidden from the chart." and "shown on the chart." on the way back; every remaining segment and ranked row is at opacity 1. The announcement arrives after more than 1.2 s (heard after waiting 3 s, empty after 1.2 s), see L7 | `1600-m1-hidden.png` |
| M2 no Period chip | PASS: Last month leaves zero chips and no "Clear all filters"; the filter bar (`usage-filters`) stays 47 px at both sizes | `1600-m2-lastmonth.png`, `1024-m2-lastmonth.png` |

## 2. Worst cases (break-ui)

| Case | Result | Evidence |
| --- | --- | --- |
| 60-character project name (63 chars) | PASS. Legend chip, ranked row, picker button, run table and the project chip all truncate or wrap without overlap; the chip shows the full name. Legend shows a doubled ellipsis (L3) | `1600-h1-narrowed.png`, `many-1600-dark-top.png` |
| 14 projects: legend and ranked rows | PASS. Legend caps at 5 + "Other (9 projects)"; ranked rows top 5 + "Show all 14"; unpriced projects read "No price" with a hollow bar, never $0 | `many-1600-dark-top.png`, `many-1600-where-showall.png` |
| One run only | PASS. Four tiles read "no prior data", chart has one bar, one legend chip, one ranked row; no NaN. The sparkline draws a rise from zero days to the run (reads as trend, acceptable) | `single-1024-light-top.png` |
| All runs unpriced | PASS. Cost tile "No price", chart defaults to Tokens, Where rows "No price", Efficiency "Cost per run: No price"; no "$0.00" anywhere (scanned the page text and titles) | `unpriced-1600-dark-top.png` |
| Very large values | PASS. "984.80M" tokens, "$1,377.60+", axis "$200", nothing wraps or clips in the tiles at 1024 | `huge-1024-light-top.png`, `huge-1600-dark-top.png` |
| 90+ day period in Day grouping | PASS with a Low. A 92-day span selected through Months... defaults to Week; choosing Day draws 92 bars (8 px wide at 1600, 9 px at 1024), 91 segments, 93 running animations on a metric switch (under the 120 cap). The chart gets an inner horizontal scrollbar and the last axis label is clipped (L4). 92 table rows render without page overflow | `ninety-day-1600.png`, `ninety-day-1024.png`, `ninety-day-table-1600.png` |
| 120-segment cap | PASS. With 128 segments (dense set) a metric switch starts 2 animations (the plot fade) instead of a morph; worst frame gap 14 ms; tooltip lists top series + "Other (6 projects)" | `dense-1600.png`, `dense-1024-tooltip.png` |
| Enough chips for two lines | PASS with the known open item. 8 project chips wrap to two lines at 1024; the sticky block grows to 141 px (from about 86) and the content moves down by the extra line; no overflow, "Clear all filters" stays on the second line | `chips-wrap-1024.png`, `chips-wrap-1600.png` |
| 300 or more runs in All runs | PASS. 320 runs: the list shows 100 and "Show 220 more"; after it, a labelled region (`role=region`, `aria-label` "All runs table", one Tab stop) windows the rows (38 in the DOM of 320), detail toggles are absent as designed, open buttons work, sorting responds in about 1.2 s. At 1024 the table has an inner horizontal scroll (L6) | `runs300-1600.png`, `runs320-1024.png` |
| 1024x640 in both themes | PASS: no page or scroller horizontal overflow in any set, both themes; a probe for text overflowing the viewport found only the closed-table case in M2 | `many-1024-light-top.png`, `many-1024-light-bottom.png`, `1024-light-top.png` |

## 3. Motion (motion on, then App settings Reduce motion)

Method: a requestAnimationFrame recorder inside the renderer lists every running animation whose target is under the Usage view and
every distinct text a KPI tile showed, frame by frame.

| Check | Motion on | Reduce motion |
| --- | --- | --- |
| First load of the page | PASS with a note: only the skeleton placeholders' pulse and fade (loading cue) and 50 ms hover colour transitions on buttons; no content animation, KPI values appear once ("$0.034+", "25k", "10", "25s") | PASS: no animation at all |
| Periodic refresh (live run started, 36 s watched, KPI values changed 25k to 28k, 25s to 51s) | PASS: zero animations, KPI values jump (no intermediate values) | PASS |
| KPI tween after a user filter change | PASS: 19 intermediate values for cost ($0.040+ down to $0.019+), 16 for tokens, 7 for runs over about 260 ms; legend, segments and ranked rows fade 100 ms | PASS: values jump ($0.040+ to $0.019+), no animation |
| KPI tween after a metric change | PASS: bar morph (260 ms WAAPI) and KPI indicator slide (260 ms); the tile numbers do not tween (metric change is not a filter change) | PASS: nothing |
| Rapid metric switching (12 clicks, 40 ms apart), 6 project narrow/clear cycles, 5 period switches | PASS: ends with exactly one tile pressed, metric valid, bar count unchanged (30), no running animation, no stuck transform/opacity (all segments opacity 1), no chip, KPI values equal a fresh load | PASS (same) |
| Rapid legend toggles + tab switching (8 each, 30 ms) | PASS: one tab selected, exactly one panel mounted, legend toggled an even number of times back to pressed, no running animation | PASS (same) |
| Nothing lost under Reduce motion | PASS: the same final values, chips, panels | |

Screenshots: `motion-on-end.png`, `motion-on-F.png`, `motion-reduce-end.png`, `motion-reduce-F.png`.

## 4. Keyboard (1024x640, dark; light checked for the focus ring)

- Tab count: 33 stops inside the Usage view plus 1 topbar stop before it (34 in the pass from Save CSV to the "Skip to content" wrap).
  In order: period group (1, radio group), All projects, All kinds, Cost tile, "N of M priced" link, Tokens tile, Runs tile, metric radio group,
  Group by radio group, Compare, Table, three legend chips, the chart (1 roving), Where tabs (1), the first ranked row, Show as table,
  Efficiency info (1), More signals, Team timing, Show as table, sort select, three times (details, run link), Show 8 more, tier
  Show as table, All runs, What these terms mean. Wall time is not a stop (not a chart switch).
- Focus never on body in 34 stops; none off-screen except the wrap target; none under the sticky bar (measured: every stop's top is
  below the bar's bottom, also 12 Shift+Tabs backwards from All runs). Every stop has a 2 px solid outline; the KPI tiles show a purple
  inset ring on Tab (`kb-kpi-tab-dark.png`, `kb-kpi-tab-light.png`). The tile reports `outline: none` on the element itself, so a
  forced-colors check of that ring was not done.
- Worked by keyboard (21 checks, all PASS): Space/Enter on KPI tiles switches the chart, announces "Chart shows tokens." and keeps focus;
  legend chip Space hides/shows the series and keeps focus; chart ArrowLeft moves the tooltip; Escape hides the tooltip and keeps focus
  on the bar; Enter on a bar adds the day chip, Escape at bucket level removes it and focus lands on the filter bar (not body);
  Where tabs ArrowRight, End, Home; Enter on the first ranked row narrows and focus stays on it; sort header Enter sorts descending
  and announces "Sorted by Cost", Space flips to ascending, focus stays; run details Space opens, Enter closes, the next stop is the
  run's Open link; the project picker Escape returns focus to its button; period arrows move 30 days to 7 days and back.
- Escape on a page narrowed by a ranked row does nothing (chip stays, focus stays): only the day chip is cleared by Escape.
  That matches the design but is worth knowing.
- `kb-1024-end.png`, `kb-kpi-focus.png`, `kb-run-detail.png`, `kb-chart-dark.png`, `kb-chart-light.png`.

## Defects

None Critical or High.

### Medium

**M-A. The "Months..." range picker bloats the sticky filter block.** Trigger: any data, choose Months... in the Period group.
Seen: "From" and "to" and their selects stack in a column, "All kinds" wraps to a second line, and the sticky block (`.usage-sticky`)
is 180 px high at 1600 and 215 px at 1024, against about 86 px normally (bottom edge 134 px from the window top, minus the 48 px topbar). At
1024x640 the page scroller is 592 px tall, so a third of it is a permanent bar while the chart, tables and All runs scroll under the
remaining ~380 px. Location: the Months picker markup in the filter bar (`src/renderer/src/components/usage/`, the months range
control) and `usage*.css`. Remedy: lay "From" and "to" out inline on one row with the selects at their natural width, move the
selects' labels inside (visually-hidden "From"/"to" labels or placeholders), and let the Months pickers share the first row with Projects
and Kinds like the other presets. Screens: `months-picker.png`, `ninety-1024-top.png`, `runs320-1024.png`.

**M-B. "Show as table" in the Where it went card is unreadable at 1600.** Trigger: 1600x1000 (chart and Where side by side), Where it
went > Show as table, any data. The table is 854 px wide in a 371 px wrapper with `overflow-x: auto`, so only the Project column is
visible; Cost, Runs and the sort headers (x 1590 to 1654) are behind an inner horizontal scroll that appears only at the bottom of the
card. At 1024 the card is full width and the table fits. Location: `BreakdownCard` table wrapper. Remedy: let the table size to the
card (table-layout fixed, the name column shrinking with an ellipsis), or drop the min-width on the table at card widths under 600 px.
Screens: `many-1600-where-table-open.png` (the closed table already measures 1139 to 1992 px in the DOM).

**M-C. Hero cards stretch to equal height and leave a hole under the chart.** Trigger: 1600x1000, Where it went > Show all 14
or Show as table open with 14 projects (the card grows to 682 px). Seen: the chart card keeps its 270 px plot and leaves about 300 px of
empty card below the axis; also in `many-1600-where-showall.png`. With 1 project the Where card has a ~120 px empty gap between its
sentence and its single row (`1600-h1-narrowed.png`). Impact is cosmetic but the card looks broken. Remedy: let the chart plot flex to
the card height (or `align-items: start` on the hero row once the Where card is expanded). I rated it Medium because it appears in
the very first screen after a normal user action; Low is defensible.

### Low

- **L1. "Clear all filters" or a chip removal while scrolled jumps the page to the top.** Repro: 1024 or 1600, scroll to 300 px,
  click a ranked row (page stays), click "Clear all filters": `scrollTop` 284 to 0. Cause: the post-removal focus
  (`UsageView.tsx` around line 338, `.focus()` on `[data-testid=usage-period] input:checked` or the first bar control) has no
  `preventScroll`, and the visually hidden radio sits at the top of the content. Remedy: `.focus({ preventScroll: true })`. Effect
  today: the KPI band and chart are in view after clearing, so it reads as acceptable; a user deep in All runs would lose their place.
- **L2. Chip lines that wrap still push the content down** (known open item in usage-app.md 20.6). Repro: 8 project chips at 1024:
  sticky block about 86 to 141 px. `chips-wrap-1024.png`.
- **L3. Legend names clipped with a doubled ellipsis.** Repro: any 63-character project name: "Northwind Logi......" (and in the
  tooltip "Northwind Lo…(phase two)"). The legend text is truncated to a character limit that appends "…", then CSS clips again. Remedy: one
  mechanism (CSS ellipsis with `title`).
- **L4. A 92-day Day-grouped chart gets an inner horizontal scrollbar under the plot and the last axis label is clipped** ("31"
  instead of "31 Oct") at 1600. Repro: Months... July to October (or any span over 90 days), choose Day. Bars are fixed at 8 px;
  `ninety-day-1600.png`. Remedy: drop the min bar width to a 3 px floor or keep Week when the span exceeds the plot at 8 px.
- **L5. Narrowing a project can change the KPI band height by 16 px** when the Cost tile loses its caveat line, so the chart moves up
  16 px (scroll anchoring keeps the viewport stable). `1600-h1-narrowed.png` against `1600-h2-compare-day.png`. Remedy: reserve one
  caveat line in the tile.
- **L6. All runs at 1024 scrolls sideways inside its card** (table 995 px in a 926 px wrapper): the Time column and part of Cache hit are
  hidden. Seen with the long project name and 14 project names in the 100-row set; in the 1600 view the table fits (1232/1232).
  `runs300-1024.png`. Remedy: let the Project column shrink or drop a column under 1100 px.
- **L7. The "hidden from the chart" announcement is late** (empty after 1.2 s; present within 3 s). It may be a debounce for the
  polite region. Same for the "shown" announcement. Not measured precisely.
- **L8. At 1024 the sidebar rail with 14 projects scrolls horizontally (a white square marks a second scrollbar) and shows 14 identical
  "QA" labels.** Outside the Usage page, noted in passing: `many-1024-dark-top.png`.
- **L9. Sparklines under a single value draw a rise from zero** (single-run set); with unpriced buckets the cost sparkline becomes dots.
  Read in context it is accurate; mentioned for the label "no prior data" sitting beside a rising line.

## Not driven

- Live provider data, real prices, and anything beyond the mock adapter. No token spend.
- Screen-reader speech (live-region text was read from the DOM only), forced colors, Windows high contrast.
- macOS and Linux.
- The truncated/error/legacy-data states with the new layout; Save CSV and Copy as CSV (native dialog/clipboard).
- The intermediate tween values beyond what the rAF recorder saw; easing quality and stagger by eye. I sampled text and animation
  lists, not video.
- The 40 tab stops with the Months picker open, the Efficiency info popovers' content, and the Team timing grid.
- Light theme at 1600x1000 for the worst-case sets (looked at one screenshot per set at 1024; the re-walk set was captured at 1600
  light in `1600-light-top.png` and `1600-light-bottom.png`).
- A previous period that is longer than 90 days or a Week/Month grouping with Compare on across a month boundary.
- Contrast ratios by measurement (L6 in the earlier walk: Mobile app vs Billing colours in light) were not re-measured.

## Touched files

Only `docs/design/qa-usage-dashboard.md` (this file) and the scratch scripts and screenshots in
`e2e/shots/ux/usage-dashboard-qa/` (gitignored). No feature code, e2e script or test was changed.
