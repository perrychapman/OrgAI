# Usage dashboard: declutter and motion plan

Status: plan for the UI Lead (`ui-lead-usage`), written from screenshots of the rebuilt page. No code changed. The rebuilt code was not in this worktree, so component names for the new parts are best guesses (marked "unverified name").
Builds on: `docs/design/usage-dashboard-options.md` (option D, increments 1 and 2), `docs/design/ux-review-usage-dashboard-pre.md`, `docs/design/usage-app.md`, `docs/design/motion.md` (the app's motion system; it wins over anything quoted below).
Screens read: `e2e/shots/ux/usage-dashboard-new/` (1600 and 1024, dark and light, `1600-dark-interact.png`) and the old `usage-dashboard/` set.

Owner request: less crowded, more interactive elements with animation, smooth and modern, same look and feel.

Evidence key: **[src]** read live from the URL; **[rec]** a Researcher's recollection, not read; **[own]** my inference; **[repo]** read in this repo.

## 0. What the screenshots show (diagnosis)

| # | Finding | Evidence |
|---|---|---|
| R1 | KPI tiles: delta text wraps to 3 lines ("up 400% on the previous 30 days"), so tiles are uneven (Cost has 5 lines, Cost per run 3). Sparkline is about 60 px wide in a 200 px tile, ragged baseline, hardly legible. | screenshot, 1600 top |
| R2 | Cache hit and Cost per run appear twice: in the KPI band and again in the Efficiency strip. | screenshot |
| R3 | Spend chart: plot is about 520 of 810 px of the card; the right third is a legend column of three rows with a lot of air. Under the plot are three lines of prose ("30 days. Hover or focus...", "Dashed box under the axis...") plus an empty gap, then "Show as table". About 110 px of the 430 px card is explanation. | screenshot |
| R4 | "Where it went" card is shorter than the chart card, so a blank block sits under it; each ranked row spends two lines (name and value, bar, then "4 runs" alone below). | screenshot |
| R5 | "Group by Day/Week/Month" sits in the page filter bar but only changes the chart; the page bar carries 5 controls plus a date string, so at 1024 the selects wrap onto a second row. | screenshot, 1024 |
| R6 | Subtitle plus scope line repeat the date range three times (scope heading, date text right of the bar, chart subtitle). | screenshot |
| R7 | Lower sections are full width: "Runs worth a look" repeats the same reason sentence in every row and has a Status column that says "Stopped" five times; "Cost by tier" is a single full-width bar. | screenshot, mid |
| R8 | 1024: the sticky bar (about 100 px of 640) is translucent and chart content shows behind it (pre-review H1 still visible in `1024-dark-mid.png`). | screenshot |

## 1. Declutter

### 1.1 Principles borrowed

- Rank by importance: the most important data gets the largest area and highest contrast, at the top, with the least important last; limit metrics and remove anything that distracts. Carbon dashboards https://carbondesignsystem.com/data-visualization/dashboards/ **[src]**. White space groups and signals priority (same page; its "almost 20 percent" comprehension claim is the page's own citation, do not repeat it as a fact).
- Do not fill the chart frame with elements; a tooltip should repeat the point's values on both axes plus relevant detail. Carbon chart anatomy https://carbondesignsystem.com/data-visualization/chart-anatomy/ **[src, via Researcher]**.
- More than two levels of disclosure typically have low usability, so: overview, then one level of detail. NN/g progressive disclosure https://www.nngroup.com/articles/progressive-disclosure/ **[src, via Researcher]**.
- A dashboard is read at a glance with minimal interaction, one job per dashboard; length and 2D position are the encodings to use. NN/g https://www.nngroup.com/articles/dashboards-preattentive/ **[src]**. This is why the plan adds readouts and highlights, not drill-down screens.
- Whenever more than one item is shown, a legend is required; use more than colour alone; 3:1 contrast for marks; offer a table and CSV. Primer https://primer.style/product/ui-patterns/data-visualization/ **[src]**. The page already does all of these; keep them.

### 1.2 Remove, merge, shorten, move

| Change | From | To |
|---|---|---|
| Remove duplicates | Cache hit and Cost per run in KPI band and Efficiency | Keep them only in Efficiency (R2). KPI band is four tiles. |
| KPI band | 6 tiles | 4 tiles: Estimated cost, Tokens, Runs, Wall time. Each tile: label (one line), value with delta chip on the same row, full-width sparkline below. See 1.3. |
| Delta copy | "up 400% on the previous 30 days" | Chip "▲ 400%" (glyph plus sign, not colour alone) and a muted "vs prev. 30 d" that may drop at narrow width; the full sentence goes to `title` and the tile's accessible name. Flat: "● 0%". Unknown/no baseline: "no prior data". |
| Unpriced note | Two lines in the Cost tile ("On chart / from 7 of 10 runs / 3 runs have no price") | One compact chip after the cost value: "7 of 10 priced" opening the existing unpriced explanation in a popover (the link "3 runs have no price" keeps its target). The "$0.030+" lower-bound plus stays. |
| "On chart" | Text line in the selected tile | The selected tile shows a 2 px top bar (already there) that slides (see 2.3); drop the words. The accessible state is `aria-pressed` or `aria-checked` (keep what exists). |
| Group by | Page filter bar | Chart card header, next to Cost / Tokens / Runs and Compare. It only changes the chart (R5). The page bar becomes Period, date text, Project, Kind: one row at 1024 (about 800 of 968 px, [own] estimate, verify). |
| Scope text | Scope heading, subtitle, date text, chart subtitle | One line in the filter bar: "19 Oct to 17 Nov 2026, 30 days · 10 runs". Delete the page-level subtitle sentence "What your runs cost..." (move to the page header `title` or the definitions popover) and the chart subtitle repeats only what the chart adds ("busiest day 2 Nov, $0.0043"). |
| Chart legend | Right column, 3 rows | One row of toggle chips above the plot, left aligned, each with a swatch, name and total ("Billing service $0.013+"); wraps to two lines at most, then "+3 more" menu. Plot takes the full card width. |
| Chart prose | "30 days. Hover or focus one for its figures." and "Dashed box under the axis..." | Delete the first (the crosshair makes it self-evident; the keyboard hint goes in `aria-describedby` text and a "?" tooltip in the card header). The second becomes a legend-key chip "┆ cost unknown" shown only when unknown buckets exist. |
| Show as table | Link at the bottom of each card | Icon button with label "Table" in the card header (aria-expanded). Opens the existing `ChartTable` below the plot (one disclosure level). |
| Where it went rows | Name + value, bar, "4 runs" on a third line | One row: name, bar, value, "4 runs" muted inline right of the value. Top 5 rows, "Show all 12" below. Card stretches to the chart card height (`align-items: stretch`, no empty block). |
| Runs worth a look | 5 rows with a long "Why listed" column and a Status column | 3 rows, then "Show 12 more". Columns: Run (with kind chip), When, Cost, Why (truncated one line, full text in the expanded detail, see 2.7). Drop the Status column; status becomes a small dot with `title` beside the run name. |
| Cost by tier | Full-width bar plus 2-row legend | Moves beside Runs worth a look as a narrow card (see 1.3). |
| Staffing, team timing | Disclosures | Unchanged, but collapsed by default, one summary line each. |
| Sticky bar | Translucent | Opaque `--surface-0` plus a 1 px bottom border that appears only once the page scrolls (also fixes R8). |

### 1.3 Target layout

Page area is the right of the sidebar; widths below are content widths inside the 24 px page gutters.

**1600x1000 (about 952 px of page height).** [own, sizes to verify]

| Band | Height | Contents |
|---|---|---|
| Filter bar (sticky) | 48 | Period segmented, scope text, Project, Kind |
| KPI band | 96 | 4 tiles, equal width, hairline separators, no card chrome |
| Hero row | 360 | Spend chart card (about 66%) + Where it went card (about 34%), same height |
| Efficiency strip | 120 | Heading plus 4 tiles on one line, "More signals" disclosure |
| Lower row | about 320 | Runs worth a look (about 66%) + Cost by tier (about 34%) |
| Disclosures | about 120 | Staffing, All runs, What these terms mean (collapsed) |

Above the fold: filter bar, KPIs, the whole hero row and the Efficiency strip heading (about 700 px). Target total page height about 1500 to 1700 px, against 2906 for the old page. The rebuilt page is already about 2400 (estimate from the screenshots).

**1024x640 (592 px of page height).**

| Band | Height | Contents |
|---|---|---|
| Filter bar (sticky) | 48 | one row (period, project, kind; scope text hides under 900 px and goes to the `title` of the period control) |
| KPI band | 88 | 4 tiles in one row, sparkline under value; below 760 px container width 2x2 |
| Hero | 300 | Chart full width, plot 200 high |
| Where it went | 300 | full width below the chart |

Above the fold: bar, KPIs and the chart header with the top of the plot (about 440 px). Target total height about 2300 px, against 3881. Lower row becomes one column; Efficiency becomes a 2x2 grid.

### 1.4 KPI tile, one line each

`[label]` / `[value] [▲ 400%]` / `[sparkline, full tile width, 28 px high]`. Value is `--text-display` with tabular numerals (`font-variant-numeric: tabular-nums`). Cost: "$0.030+" and the "7 of 10 priced" chip on the label row at right. Tokens: "25k" with "in 6.0k · out 620" moved to the tile's `title` and the chart tooltip. No tile has more than three text lines at 1024. Verify by an e2e height check (section 5).

### 1.5 Sparklines

Draw as inline SVG per `micro-visualisation`: 1.5 px stroke in `--text-secondary` (selected tile: `--accent-text`), end dot, `vector-effect: non-scaling-stroke`, width 100% of the tile, `preserveAspectRatio: none`. Unknown buckets are gaps with a hollow dot, never zero. `aria-hidden` because value and delta carry the facts. Same bucket series as the hero chart (already in `UsageOverviewTrendPoint`). If a tile has fewer than 3 buckets, show no sparkline.

## 2. Interactive elements (eight, ranked)

Existing components: `SpendPanel`, `UsageSummary`, `RankedBars`, `UsageFilterBar`, `WastefulRuns`, `AllRuns`, `usageTableParts`, shared `Tabs` (`.tabs-indicator`, **[repo]** motion.md 3.3 and section 7).

### 2.1 Crosshair and anchored tooltip on the spend chart (highest value)

- Behaviour: pointer over the plot snaps to the nearest bucket (the whole column is the hit area, not the thin bar). A 1 px vertical rule (`--border-strong`) and a faint column highlight (`--surface-2` at 60%) mark the bucket; one tooltip anchored to the top of the rule shows: date, total for the selected metric, one line per series in legend order with swatch and value, previous-period value when Compare is on, "N runs, M unpriced". Flips left of the rule near the right edge. Carbon and Primer both say a tooltip repeats the point's values and relevant details, and Primer says crosshairs connect a point to its axis label **[src]**.
- Instant, not animated: the rule and tooltip follow bucket changes with no transition (hover readouts must be immediate, motion.md principle 8). The tooltip's first appearance may fade `--dur-fade`. Entering and leaving the plot hide it at once.
- Implementation: `pointermove` writes `--cx` and `--cy` custom properties on the plot element and changes React state only when the bucket index changes. [own, rAF-throttle]
- Keyboard: the existing roving stop (Left and Right, Home and End, one Tab stop) moves the same crosshair and tooltip; Escape hides the tooltip but keeps focus; focus leaving hides it. The existing fixed readout line (`usage-spend-readout`) is replaced by this tooltip; keep a visually hidden `usage-spend-readout` element with the same sentence for assistive tech and e2e. Not a live region (only the existing `usage-live` filter-change announcement stays).
- Touch/click: click or Enter on a bucket keeps the current "day pick" (pins the tooltip until Escape or another click).
- Test ids: `usage-chart-tooltip`, `usage-chart-crosshair`, existing `usage-spend-*`.

### 2.2 KPI tile as metric switch, with a sliding indicator and a linked chart

- Tiles for Cost, Tokens, Runs are a radio group (already so); Wall time stays an inert tile. Click or Arrow keys plus Space select; the 2 px selected top bar slides to the new tile (transform) in `--dur-slow`, `--ease-in-out`. Chart bars morph (see 3, row M2). Same metric also available in the chart header segmented control; the two stay in sync.
- Announcement: none new (the selected state is the radio state); the chart title text changes to "Cost over time".
- Lives in `UsageSummary` plus `SpendPanel` (metric state already shared).

### 2.3 Sliding indicator on segmented controls and tabs

- Period, Cost / Tokens / Runs, Group by (now in the chart header) and the Where it went tab strip: one indicator element slides under or behind the selected segment using the existing `Tabs` indicator mechanism (translateX plus scaleX from measured offsets, `--dur-slow`, `--ease-in-out`, no slide on first paint or resize, **[repo]** motion.md 3.3). For a segmented pill, the indicator is a filled `--surface-3` rounded box behind the label.
- Deviation to note: motion.md 3.16 says segmented controls have no slide; this plan reverses that for the Usage page only, because the owner asked for it. Record it in motion.md section 7 when built.
- Keyboard: unchanged. Selection by arrow keys (radiogroup) moves the indicator at once with the same transition.
- Lives in the shared `Tabs` and the segmented wrapper that the filter bar uses (unverified name); add a `variant="pill"`.

### 2.4 Linked highlight, both ways

- Pointer or keyboard focus on a legend chip, a Where it went row or a stacked bar segment sets `data-hl="<series id>"` on the card pair (chart card and Where it went card share a parent). CSS dims everything else to `opacity: 0.35` over `--dur-fast`, `--ease-out`, and restores on leave. The highlighted series' ranked row also gets a `--surface-2` background. Primer's rule applies (never colour only): the highlighted row and segment get a 2 px outline, not just the dimmed others **[src]**.
- Click on a legend chip toggles the series (existing `aria-pressed`); click on a ranked row adds a filter chip (existing mechanism, per option D) and does not leave the page.
- Keyboard: legend chips and rows are native buttons in the tab order; focus triggers the highlight; Escape clears nothing (highlight is focus-bound).
- No announcement.
- Lives in `SpendPanel`, `RankedBars` and the new legend row.

### 2.5 Animated number change on KPIs (and chart totals)

- Only when the shown number changes because of a user filter or metric change after the page was shown, never on first paint, relaunch, or the periodic data refresh ("Updated 07:56" poll). Tween from old to new over `--dur-slow` with `--ease-out`, one rAF loop (all tiles share one). Values keep their formatter (cost with the "+" lower bound, "25k", "25s"), tabular numerals, so width does not jitter; final value is written at the end and also immediately in `aria-label` and `title`. Skip when the change is under 1% or the period is the same and only the refresh brought new data.
- A flash of a wrong number must never show: unknown cost is not tweened from zero; "$0.030+" tweens its numeric part and keeps the "+" throughout.
- Reduced motion: set final value at once.
- Lives in a small `useTweenedNumber` hook (new, `lib/`, unit-testable) used by `UsageSummary`.

### 2.6 Ranked rows: smooth tab change and reorder, drill chip

- Tab change (Project / Model / Role / Connection): rows that exist in both tabs (rare) are matched by key; otherwise the old rows are replaced and the new rows rise in with `.motion-enter` and stagger `--motion-stagger`, at most 6 (`--i` capped at 5). Bars draw via `transform: scaleX` from 0 to its value over `--dur-slow` (origin left). A sort or period change that reorders the same keys uses FLIP with the Web Animations API: measure first and last `getBoundingClientRect`, animate `transform: translateY(delta)` to none over `--dur-slow`, `--ease-in-out`, visible rows only and at most 8.
- Click or Enter on a row: adds a filter chip (and a one-line live announcement via the existing `usage-live`: "Filtered to Billing service"). Focus stays on the row.
- Keyboard: one Tab stop per row (native button), Up and Down arrow between rows is optional (open decision).
- Lives in `RankedBars` and the Where it went tablist (tab content crossfade `--dur-fade`, `.motion-view`, user tab change only).

### 2.7 Expandable run rows

- In Runs worth a look and All runs, each row has a chevron button at the start ("Show details", `aria-expanded`). Expands one level inside the table row, not a drawer: full "why listed" sentence, tokens in/out, cache hit, unpriced note, "Open run" link. Height reveal uses the existing `.motion-collapse` grid recipe (`--dur-base`, `--ease-in-out`, chevron `rotate` `--dur-fast`); the collapsed content is `visibility: hidden`, so it is out of the tab order and the accessibility tree (**[repo]** motion.md 3.7, section 7).
- Keyboard: Enter or Space on the chevron toggles; focus stays on it. The run name remains a link.
- Two disclosure levels at most (NN/g, above): table row, then its detail; no nested expanders.
- Test ids: `usage-run-toggle`, `usage-run-detail`; existing `usage-run-row` unchanged.

### 2.8 KPI sparkline scrub, linked to the chart

- Pointer over a tile's sparkline shows a dot and replaces the delta line with the bucket's value ("2 Nov · $0.0043") while hovering; the hero crosshair moves to the same bucket (2.1). Leaving restores. Instant, no transition.
- Pointer only; the chart is the keyboard equivalent (the tile stays one Tab stop for the metric switch, and a sparkline has no keyboard path by design). State this in the tile's description.
- Lives in `UsageSummary` and a shared `hoveredBucket` state in `UsageView`; update through a ref and a CSS variable, with React state only on bucket change.

Considered but left out: brush and zoom, group-by-over-time (increment three), drag to reorder.

## 3. Motion spec

Tokens exist in `src/renderer/src/styles/tokens.css` **[repo]**: `--dur-instant` 50 ms, `--dur-fade` 80 ms, `--dur-fast` 100 ms, `--dur-base` 160 ms, `--dur-slow` 260 ms, `--ease-out` `cubic-bezier(0.2,0.8,0.2,1)`, `--ease-in` `cubic-bezier(0.4,0,1,1)`, `--ease-in-out` `cubic-bezier(0.4,0,0.2,1)`, `--ease-spring` (not used here), `--motion-distance` 8 px, `--motion-distance-sm` 4 px, `--motion-scale-from` 0.96, `--motion-stagger` 30 ms, plus the shared classes in `styles/motion.css` (`.motion-enter`, `.motion-view`, `.motion-fade`, `.motion-collapse`, `.motion-none`) and hooks `useArrival`, `useExitPresence`, `tokenMs` and `useReducedMotion` (`lib/canvas.ts`). **No new token is proposed.** Everything below fits the existing set, which sits inside the ranges outside sources recommend: NN/g puts most animation at 100 to 500 ms, simple feedback about 100 ms, bigger changes 200 to 300 ms, entering slightly longer than leaving https://www.nngroup.com/articles/animation-duration/ **[src]**; Carbon's productive set is 70, 110, 150, 240, 400 ms with standard, entrance and exit curves https://carbondesignsystem.com/elements/motion/overview/ **[src]**. Material 3 duration values were not readable from the fetched page (https://m3.material.io/styles/motion/easing-and-duration/applying-easing-and-duration returned no numbers), so none are quoted.

| ID | Trigger | Property | Duration | Easing | Stagger / notes |
|---|---|---|---|---|---|
| M1 | Selected segment or tab changes | `transform` (translateX, scaleX) of one indicator | `--dur-slow` | `--ease-in-out` | none; no slide at first paint or resize |
| M2 | Metric changes (tile or switch) with the same buckets | bar `transform: scaleY` per bucket (origin bottom), keyed by bucket date and series; y axis labels swap at the start of the move (snap) | `--dur-slow` | `--ease-in-out` | none (all bars together; max about 120 bars, else skip) |
| M3 | Bucket set changes (period, group by, project filter) | chart body `opacity` 0 to 1 | `--dur-fade` | `--ease-out` | none; bars do not morph (cannot be paired), use `.motion-fade` |
| M4 | Compare toggled | previous-period outlines `opacity` | `--dur-base` | `--ease-out` | none |
| M5 | Legend toggle (series hidden or shown) | segment `opacity` and `transform: scaleY` of the series | `--dur-base` | `--ease-in-out` | none |
| M6 | Crosshair hover or arrow key | none (rule and tooltip move at once); tooltip first show `opacity` | `--dur-fade` (first show only) | `--ease-out` | none |
| M7 | Linked highlight on or off | `opacity` of the other series and rows | `--dur-fast` | `--ease-out` | none |
| M8 | KPI value changes after a user filter or metric change | text content, rAF | `--dur-slow` | `--ease-out` (computed in JS) | tiles together; skip under 1% change |
| M9 | Where it went tab changed | tab body `opacity` plus translateY `--motion-distance-sm`; rows `.motion-enter`; bars `scaleX` 0 to 1 | `--dur-fade` body, `--dur-base` rows, `--dur-slow` bars | `--ease-out` | `--motion-stagger`, rows up to 6 |
| M10 | Rows reorder (sort or period change, same keys) | FLIP `transform: translateY` | `--dur-slow` | `--ease-in-out` | none; at most 8 rows |
| M11 | Run row detail opens or closes | `grid-template-rows` 0fr to 1fr (the app's one height exception), chevron `rotate` | `--dur-base`, chevron `--dur-fast` | `--ease-in-out` | none |
| M12 | Sticky bar border appears on scroll | `opacity` of a 1 px border | `--dur-fast` | `--ease-out` | none |
| M13 | Press on a segment, tile or chip | `scale(0.98)` | `--dur-instant` in, `--dur-fast` out | `--ease-out` | existing button press recipe |

### 3.1 What must never animate

- First paint of the page, a project or tab switch, relaunch, or a restored state (arrival rule, motion.md principle 6): no count-up on load, no bar growth on load, no sparkline draw-in.
- The periodic refresh ("Updated hh:mm") and any change that is not the result of a user action: numbers and bars update silently.
- The crosshair, tooltip position, roving keyboard focus, focus rings, text selection, scrolling, the select pickers, the unknown-cost marks (hatching and dashed boxes stay static shapes).
- Layout: filter bar wrapping, the KPI band height, card heights. Only M11 is a height transition.
- Anything above its cap: more than about 120 bars (M2), more than 8 rows (M10), more than 6 staggered items (M9); these update at once.
- `box-shadow`, `filter`, `backdrop-filter`, `width` or `height` (except M11), or a looping animation. Nothing here loops; this page has no live cue.
- Nothing blocks input: no `pointer-events: none` during any of them, no waiting on `animationend` before acting.

### 3.2 Reduced motion and Pause motion

- Reduce motion (system preference or `AppearanceSettings.reduceMotion`, `data-reduce-motion='on'`): the tokens already set durations to 0.01 ms and distances to 0, so every CSS item above degrades to an instant change with no per-component code. JS-driven motion does not read CSS: M8 (tween) and M10 (FLIP) must read `useReducedMotion()` and `tokenMs('--dur-slow')` and apply the final state at once (**[repo]** motion.md 3.11 uses the same rule for the transcript follow). The crosshair and tooltip are unaffected (they never animate).
- Pause motion: in the repo this string exists only in the Pocket Office (`office.css`, `OfficeScene.tsx`, `OfficeSprites.tsx`), so I treat it as Office-only and the Usage page follows Reduce motion. **Open decision:** if the owner means a global Pause motion, say so; this page would then read the same flag as Reduce motion. Unverified: I did not find an app-wide setting by that name.
- State never lives in motion: the selected metric, the highlight, the open run detail and the tooltip content are all present with motion off.

### 3.3 Performance limits

- Transform and opacity first. Simultaneous animations: at most about 40 bar elements in M2 at once (for 30 buckets by 3 series that is 90 shapes; cap at 120, else skip), 6 staggered rows, one rAF loop for tweens with at most 6 numbers, one indicator per control. No more than three of these categories overlap in time.
- No permanent `will-change`; add it for the duration of M2 and remove it at the end. Prefer one SVG `<g>` per series for M5 so one element animates, not every rect.
- The crosshair writes two CSS variables per `pointermove` in an rAF, and React state only when the bucket changes.
- Charts are inline SVG; no canvas, no new dependency.
- View Transitions: Electron 45.2.3 (`package.json`), which `docs/design/motion.md` records as Chromium 140, supports them, but they are **not used**: motion.md D2 rejected them (a full-page snapshot overlay) and the Usage page's transitions are local, so CSS and the Web Animations API are enough. Mozilla's page confirms the snapshot overlay sits over all content and recommends feature-detecting https://developer.mozilla.org/en-US/docs/Web/API/View_Transition_API **[src]**. (The compatibility versions did not come through the fetch; Chromium 111 for same-document transitions is [rec], unverified.)
- Height reveal for M11 uses the existing `.motion-collapse` grid recipe, which does not need `interpolate-size`. `interpolate-size: allow-keywords` is already set on `:root` (**[repo]**); the Chrome documentation says it and `calc-size()` ship from Chrome 129 https://developer.chrome.com/docs/css-ui/animate-to-height-auto **[src, via Researcher]**.
- `@starting-style` (Chromium 117+, [rec]) may be used for the tooltip's first appearance; a plain CSS animation is equally acceptable.

## 4. Copy

- Delta chip: "▲ 400%", "▼ 12%", "● 0%", "no prior data"; accessible name: "Tokens 25k, up 400% on the previous 30 days".
- Cost chip: "7 of 10 priced"; popover title "Some runs have no price", body from the existing unpriced note.
- Chart legend key for unknown: "cost unknown".
- Table toggle: "Table" (expanded: "Hide table"). Compare toggle: "Compare with previous period" (keep).
- Tooltip rows: "2 Nov", "$0.0043", "Billing service $0.0021", "Previous: $0.0032", "2 runs, 1 unpriced".
- Row detail toggle: "Show details" / "Hide details".
- Show more: "Show 12 more", "Show all 12".
- Escape copy for drill: live text "Filtered to Billing service" (via `usage-live`, polite).

## 5. Ordered build list for the UI Lead

Each step is small, passes typecheck and the unit tests, and has an e2e check. Keep existing test ids; new ones are named below. Both themes, 1600x1000 and 1024x640, for each.

1. **Declutter pass, no motion.** Four KPI tiles (cost, tokens, runs, wall time); remove the duplicate cache hit and cost per run from the band; one-line delta chip; "7 of 10 priced" chip; move Group by into the chart header; legend row above the plot with the plot at 100% width; delete the two prose lines; "Table" icon button in the header; scope text merged into the filter bar; opaque sticky bar; ranked rows to one line with a top 5 and "Show all N". Check in `e2e/usage-app.mjs`: `usage-summary-item` count is 4; each tile is at most 3 text lines high at 1024 (measure `getBoundingClientRect().height` under 110); the plot's width is at least 90% of its card's inner width; the filter bar is a single row at 1024 (height under 56); "Cache hit" occurs once in the page.
2. **Page grid.** Hero row equal heights; Runs worth a look (3 rows) beside Cost by tier at 1600; Efficiency strip on one line at 1600 and 2x2 at 1024. Check: total scroll height at 1600 under 1800 and at 1024 under 2500 on the mock data (tune the numbers if the data differs); no card shorter than its neighbour in the hero row (heights equal).
3. **Sliding indicators (M1, M12, M13).** `variant="pill"` on the shared segmented control and `Tabs` for Where it went; sticky bar border on scroll. Check in `e2e/motion.mjs`: after selecting a different segment the indicator's computed `transition-duration` is the `--dur-slow` value, and under Reduce motion it reads about 0; indicator x equals the selected segment's offset after settle; `usage-summary-item` keeps `aria-pressed` or `aria-checked`.
4. **Crosshair and tooltip (2.1, M6).** Replace the readout line; keep the hidden `usage-spend-readout` with the same text. Check in `e2e/usage-app.mjs`: pointer move onto bucket N shows `usage-chart-tooltip` containing that date and the total; ArrowRight moves it to N+1; Escape hides it and focus stays on the plot; the tooltip never covers the pointer bucket's top edge; at the right edge it flips (its right edge is inside the card); there is no running animation on the crosshair (`getAnimations()` is empty on it).
5. **Linked highlight and legend toggle (2.4, M5, M7).** `data-hl` on the card pair. Check: focus on a legend chip sets `data-hl`; the other series' computed `opacity` is under 0.5 after settle; blur restores; the e2e still toggles a series with `aria-pressed`; under Reduce motion the transition is about 0.
6. **Metric morph, compare fade, bucket-set crossfade (2.2, M2, M3, M4).** Check in `e2e/motion.mjs`: switching Cost to Tokens starts transforms on bars (one `getAnimations()` or computed transition non-zero) and ends with correct heights; a period change gives only a fade (no bar transform animations); under Reduce motion nothing runs; with more than 120 bars no bar animation starts.
7. **Number tween (2.5, M8).** `useTweenedNumber` hook with a unit test (mount shows final at once; a change tweens; a change under 1% does not; the `+` stays; reduced skips). Check: first render of the page has no running number tween; a period change shows an intermediate value within the tween window and the final value after; `aria-label` has the final value immediately.
8. **Sparkline scrub (2.8).** Check: pointer over a tile's sparkline shows the bucket text and moves the chart crosshair to the same bucket; leaving restores the delta text.
9. **Ranked rows (2.6, M9, M10).** Tab body fade, row rise, bar `scaleX`, FLIP on reorder, row click adds the chip and announces. Check: switching tabs keeps exactly one tabpanel visible; the existing `usage-projects-panel`, `usage-models`, `usage-roles` ids are selected after choosing their tab; clicking a row adds a chip and the totals change; rows beyond 6 have no stagger delay; under Reduce motion no row animation runs.
10. **Expandable run rows (2.7, M11).** Check: toggle sets `aria-expanded`; the detail is `visibility: hidden` and not focusable when closed (Tab skips it); `usage-run-row` ids are unchanged; keyboard Enter toggles.
11. **Walkthrough and docs.** A UX Researcher walk (both sizes and themes, a keyboard pass and Reduce motion on), then update `docs/design/usage-app.md`, add a section 7 to `docs/design/motion.md` for the Usage deviations (pill indicator) and a Usage line in `docs/agent-notes/renderer.md`.

### Not now

- View Transitions (rejected in motion.md D2; page-local transitions do not need them).
- Brush, zoom, drag to reorder, group-by-over-time (needs trend-slice contract changes, option D increment three).
- Count-up on first load, bars growing on first paint, sparkline draw-in, looping or ambient animation, parallax, hover tilt, confetti, sound.
- Scroll-driven animation to shrink the sticky bar (supported by Chromium; extra complexity for a small gain).
- Any chart or animation library, `will-change` everywhere, `backdrop-filter` blur on the sticky bar, donut or gauge charts (NN/g: area and angle are hard to read, gauges waste space).
- A drawer or modal for run details (one inline level is enough).
- A new Pause motion setting for this page (Office-only today; see 3.2).
- Per-table copy and export beyond the existing CSV.

## 6. Open decisions

1. Four KPIs (Cost, Tokens, Runs, Wall time) as proposed, or keep Cost per run instead of Wall time.
2. Pill-style sliding indicator on segmented controls, which reverses motion.md 3.16 for this page. Confirm or restrict the slide to the Where it went tabs.
3. Whether a global "Pause motion" exists beyond the Office.
4. Arrow keys between ranked rows (optional).
5. Whether the chart is a column chart only or also offers a line type (not planned).

## 7. Sources and what is unverified

Read live **[src]**: Carbon dashboards https://carbondesignsystem.com/data-visualization/dashboards/; Carbon motion https://carbondesignsystem.com/elements/motion/overview/; Primer data visualisation https://primer.style/product/ui-patterns/data-visualization/; NN/g animation duration https://www.nngroup.com/articles/animation-duration/; NN/g dashboards https://www.nngroup.com/articles/dashboards-preattentive/; MDN View Transition API https://developer.mozilla.org/en-US/docs/Web/API/View_Transition_API (without the browser table). Read live by the Researcher, relayed **[src, via Researcher]**: NN/g progressive disclosure https://www.nngroup.com/articles/progressive-disclosure/; Carbon chart anatomy https://carbondesignsystem.com/data-visualization/chart-anatomy/; Chrome animate to height auto https://developer.chrome.com/docs/css-ui/animate-to-height-auto; MDN reduced-motion handling for view transitions.

Could not read: Material 3 motion tokens (page text empty), Polaris Viz (connection closed), Apple HIG Charts (page text empty). Do not cite them. Everything the Researcher listed as recollection (the ranked ten, bar morph at 300 ms, 120 ms dims, FLIP at 300 ms, stagger 15 to 30 ms, 200-bar cutoff, `@starting-style` from Chromium 117, scroll-driven header) is **[rec]**; the durations here use the app's tokens instead, and the 120-bar and 8-row caps are **[own]**.

Not verified: page heights and band sizes in 1.3 (estimates from screenshots, not measured); whether one filter bar row fits at 1024; the unverified component names (segmented wrapper, legend row); that Electron 45.2.3 is Chromium 140 (from motion.md); that nothing in the rebuilt code already implements parts of this; any of the motion by eye (nothing was built or seen); screen reader speech for the tooltip and the filter announcement.
