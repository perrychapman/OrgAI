# Usage dashboard: options

Status: options for the owner to choose from. No code changed. Existing spec: `docs/design/usage-app.md`.
Page: `src/renderer/src/views/UsageView.tsx`, components in `src/renderer/src/components/usage/`.
Wireframes (neutral grey, 1600x1000): `docs/design/usage-options/option-a.svg`, `option-b.svg`, `option-c.svg`.

Owner request: the app-wide Usage page should look cleaner, report well, and show statistics in a more polished and interactive way.

Evidence key: "code" means read from the source and CSS; "walkthrough" means seen in the running app on mock data. At the time of writing the UX Researcher walkthrough (`e2e/shots/ux/usage-dashboard/`) had not delivered screenshots, so every point below is **inferred from code** and must be confirmed or struck once its screenshots land.

## Constraints that apply to every option

- No new chart dependency: inline SVG as today (`SpendPanel`, `RankedBars`, `ChartTable`), tokens only, both themes, container queries for sizing.
- Shared wrappers and tokens (`ui/` wrappers, `--surface-*`, `--space-*`, `--font-mono`); no new palette.
- Existing period and bucket filters, project / kind / connection filters, chips, live announcements (`usage-live`), CSV export (`useUsageCsv`) and `usageFocus` deep links keep working.
- Unknown cost stays distinct from zero everywhere (`costView`, `ui/Cost.tsx`; `data-cost-kind`; hatched or dashed marks, "$412.30+" lower bounds). Any new mark (sparkline, overlay, ring) needs a shape for unknown, not only a colour.
- Frequent keyboard actions stay immediate. Motion follows `motion-design`: nothing animates for data alone; reduced motion and Pause motion remove every transition listed below.

## 1. Diagnosis

| # | Finding | Evidence |
|---|---------|----------|
| D1 | Everything is a bordered `--surface-1` card (summary tiles near `styles/usage.css` 497, `.usage-view .usage-panel` near 572), so the page is box-in-box with no hierarchy of chrome. | code |
| D2 | About 11 sections stack at equal weight with one uniform `--space-4` gap; nothing says which is the headline. | code |
| D3 | Topbar, scope line, filters, chips and notes all come before the first chart, so the first fold is controls and prose. | code |
| D4 | KPI deltas are text only; no sparkline, so a number gives no sense of shape. `UsageOverviewTrendPoint` already carries the data. | code |
| D5 | The three "where it went" panels (project, model, role, plus connection) each have their own head, bars and "show as table" details: the same pattern four times. | code |
| D6 | Definitions sit at the page bottom, far from the terms they explain. | code |
| D7 | The spend chart already has keyboard arrows, a readout and a legend (`SpendPanel` onKeyDown, `usage-spend-readout`, `usage-spend-legend`), but no previous-period overlay, no metric linkage to the KPI tiles, no click to narrow, no zoom. Interactivity exists but is not discoverable and does not connect to the rest of the page. | code |
| D8 | `useUsageOverview` already fetches the previous period but the chart does not draw it. | code |

Strengths to keep: unknown-versus-zero encoding, the live announcement, the roving keyboard readout on the spend plot, the efficiency instruments with their text alternatives, the CSV paths.

## 2. Options

### Option A: Tidy single page (wireframe `option-a.svg`)

Five-line summary:
1. One sticky filter bar row (period, bucket, project, kind, connection, scope text); the chip line exists only while a filter is active, so there is no empty gap.
2. Borderless KPI band: five columns split by hairlines (cost, runs, cost per run, cache hit, wall time), each with value, delta text plus arrow glyph and a 14-point sparkline of the same series as the hero chart.
3. Hero spend chart (about two thirds width) beside one tabbed "Where it went" card (Project / Model / Role / Connection) that replaces the four panels.
4. Efficiency becomes a compact strip of rails and numbers (staffing and extra signals in disclosures); "Runs worth a look" stays a short table, "All runs" and "What these terms mean" are collapsed disclosures.
5. Chrome drops from card-in-card to one card level plus hairlines; no new data.

Layout:
- 1600x1000: sidebar 232, filter bar 52, KPI band 112, then hero plus breakdown at 360 high. KPI band, hero and breakdown are all above the fold (cutline near y 800).
- 1024x640: filter bar wraps to two rows (period and bucket, then selects) and stays sticky; KPI band becomes 3 plus 2 columns with sparklines dropping to value and delta only below 640 px container width; hero full width at 220 high, breakdown card below it, first fold shows KPIs and the top of the hero.

Charts and interactions:
- Hover and keyboard readout: reuse the `SpendPanel` roving focus and `usage-spend-readout` (fixed-height line under the plot, not a live region).
- Click to filter: row click in the breakdown card and legend click narrow through the existing chip mechanism ("Project: Billing"). Not a toggle: it adds a chip.
- Legend toggle: not added in A.
- Sort: breakdown card has the existing sortable "open as table" via `ChartTable`; Runs worth a look keeps its sort select.
- Compare with previous period: a "vs previous: off" toggle draws the previous period as a dashed outline per bucket in the hero (data already fetched).
- Export: unchanged (Copy as CSV, Save CSV in the topbar).
- Sparklines follow micro-visualisation: drawn only because the numbers are shown beside them; at least a 2 px mark above zero; unknown buckets drawn as gaps with a hollow dot, never as zero; a sqrt scale note is not needed because the sparkline carries no axis.

What stays, moves, goes:
- Stays: `UsageSummary` data, `SpendPanel` plot, `EfficiencyPanel` instruments, `WastefulRuns`, `AllRuns`, `UsageChips`, `UsageFilterBar`.
- Moves: scope line into the filter bar; definitions into per-term popovers plus a collapsed footer; efficiency to a strip.
- Goes: separate Projects / Models / Roles / Connections panels (their bars become the tabbed card), per-panel "show as table" details (one shared action).

Components reused: `UsageSummary` (restyled), `SpendPanel`, `RankedBars`, `ChartTable`, `ProjectsPanel`/`ModelsPanel`/`RolesPanel` bodies, `EfficiencyPanel`, `WastefulRuns`, `AllRuns`, `UsageDefinitions`. New: a small `Sparkline` (inline SVG), a `BreakdownTabs` wrapper over the existing panel bodies.

Contract fit: no new fields. Sparklines and previous overlay read `UsageOverviewTrendPoint` and the already fetched previous period.

Test ids and deep links:
- Kept: `usage-summary-item`, `usage-spend-*`, `usage-eff-*`, `usage-wasteful-*`, `usage-runs`, `usage-run-row`, `usage-scroll`, `usageFocus` `usage`, `usage-efficiency`, `usage-runs`.
- Broken or moved: `usage-projects-panel`, `usage-models`, `usage-roles` exist only in their active tab, so `e2e/usage-app.mjs` must select the tab first or the panels must stay mounted and hidden (hidden is rejected: it hides content from assistive tech correctly but costs e2e visibility checks; prefer selecting the tab in the script). `usage-runs` and `usage-run-row` are inside a closed disclosure and need an open step.

Accessibility and reduced motion:
- Tabs use `role=tablist` with arrow keys and one Tab stop; each sparkline is `aria-hidden` because the value and delta text carry the information; hero keeps its text alternative table.
- Only motion: tab content crossfade 150 ms (off under reduced motion) and the sparkline draw is static (none). Previous-period toggle does not animate.

Size: M. Risks: tab hiding makes three panels one click away (mitigated by default tab Project and a keyboard shortcut-free tablist); the KPI band at 1024 wide is dense; delta glyphs must not rely on colour alone.

### Option B: Tabbed report (wireframe `option-b.svg`)

Five-line summary:
1. Shared sticky filter bar and chips, then a one-line summary (estimated cost, runs, per run, cache hit, wall, deltas in the title) that stays visible on every tab.
2. Tabs Overview / Spend / Breakdown / Efficiency / Runs; each tab is one hero chart plus one sortable table.
3. Overview is a KPI band, spend sparkline, top 3 and three runs worth a look; Breakdown has a group-by switch (Project / Model / Role / Connection) over ranked bars and a sortable table.
4. Efficiency tab holds the eight instruments, the by-project efficiency table and staffing; Runs tab holds Runs worth a look and All runs (sortable, paged).
5. Definitions move to an info popover in the tab strip and to term-adjacent hints.

Layout:
- 1600x1000: header and filter 100, summary line 44, tab strip 40, hero about 420, table below; first view shows the top of the table, scroll happens inside a tab.
- 1024x640: filter bar two rows; tab strip scrolls horizontally only if five labels do not fit (they do at 1024); hero 200 high; table scrolls under it. Tab scroll position is kept per tab.

Charts and interactions:
- Hover and keyboard readout: same roving readout per hero; the ranked-bar hero reads "Billing: $252.10 (61%), 82 runs, cache hit 71%".
- Click to filter: row or bar click adds a chip (does not leave the tab).
- Legend toggle: only on the Spend tab stacked chart (click hides a series, `aria-pressed`).
- Sort: every table sortable via the `ChartTable` / `usageTableParts` pattern (column header buttons, `aria-sort`); Show all 12 expands in place (25 rows then Show more).
- Compare with previous: a "vs previous" column in tables (data already fetched) and an overlay toggle on the Spend tab.
- Export: unchanged, plus per-table "Copy this table" optional (open decision).

What stays, moves, goes:
- Stays: all components and data; filters and chips are shared.
- Moves: every section into the tab it belongs to; scope text into the filter bar; definitions to popover.
- Goes: the single long scroll, the page-level section stack, the three separate "show as table" details.

Components reused: `UsageFilterBar`, `UsageChips`, `SpendPanel`, `RankedBars`, `ChartTable`, panel bodies, `EfficiencyPanel`, `StaffingPanel`, `WastefulRuns`, `AllRuns`. New: `UsageTabs` (shared tab primitive if one exists, else a small `role=tablist`), summary line component, an in-place sortable table.

Contract fit: no new fields. Overview sparkline and Spend use existing trend points.

Test ids and deep links:
- Kept inside their tabs: all existing ids. `usageFocus`: `usage` selects Overview, `usage-efficiency` selects the Efficiency tab then focuses its heading, `usage-runs` selects the Runs tab then focuses its heading (tab chosen first, then scroll or focus).
- Broken: any e2e assertion that expects more than one section visible at once; `usage-scroll` becomes per-tab. `usage-summary-item` moves from the KPI band to the one-line summary (the line must keep one `usage-summary-item` per signal, or the e2e is updated in the same change).

Accessibility and reduced motion:
- `role=tablist`, arrows, Home/End, one Tab stop, panels labelled by their tab, focus moves to the panel heading on deep-link only (not on user tab clicks).
- Tab switch is instant; optional 150 ms crossfade removed under reduced motion. Announce the active filter summary on tab change only when it changed.

Size: L. Risks: hides cross-section comparison (cost versus efficiency on one screen), longest e2e rewrite, five tabs may be more structure than a page this size needs, deep links and scroll-per-tab are easy to get wrong.

### Option C: Explorer (wireframe `option-c.svg`)

Five-line summary:
1. KPI tiles are the metric switch (radio group: cost, tokens, runs; a fourth tile shows quality figures as table columns, not a chart metric).
2. One large stacked chart over time with a group-by switch (Project / Model / Role / Connection), previous-period overlay, bars-or-line toggle, legend toggles (click hides a series, alt-click isolates) and a brush strip with zoom.
3. A fixed readout line plus a tooltip that mirrors it; keyboard: arrows move bucket, up/down move series, Enter narrows, Escape clears.
4. A linked sortable table below shares group, metric and range; hovering or focusing a row highlights its series; each row has a small trend sparkline and a "..." menu (open project, open History).
5. Efficiency, staffing and runs worth a look move into a secondary Insights band under the table; All runs becomes a drawer for "Runs in this selection".

Layout:
- 1600x1000: tiles 76, explorer card 424, linked table header and first rows visible without scroll; Insights below the fold.
- 1024x640: tiles in a 2x2 grid; chart 220 high without brush strip (zoom via the filter period only); table scrolls; legend moves under the plot as a wrapped row.

Charts and interactions: all of those in the summary, plus export of the current view (chart data as CSV through the existing path with group and metric columns). Sqrt scale chosen when the largest bucket is more than 8 times the median, announced in the readout.

What stays, moves, goes: stays filters, chips, CSV, efficiency instruments (moved), runs lists (moved). Goes: the separate Projects/Models/Roles/Connections panels, the standalone KPI tiles as inert numbers, the page-bottom definitions (become hints).

Components reused: `SpendPanel` (extended to a series-aware chart), `ChartTable`, `usageTableParts`, `EfficiencyPanel`, `StaffingPanel`, `WastefulRuns`, `AllRuns`. New: a brush strip, a metric radio group, a series toggle legend, `Sparkline`.

Contract fit: needs new fields. `UsageOverviewTrendPoint` has `byProject` only; group-by over time for model, connection and role needs `byModel`, `byConnection`, `byRole` slices on trend points (shared types, main aggregator, IPC clone-safe, unit tests). Folding client-side from `runs` is capped at 2000 rows and is only a lower bound when `truncated`; that must be shown, not hidden, so it is not an acceptable shortcut. A custom brushed range needs either re-query by date range (supported by the existing period filter) or a client-side slice of already loaded buckets.

Test ids and deep links:
- Kept: `usage-spend-*`, `usage-eff-*`, `usage-wasteful-*`, `usage-runs`, `usage-run-row` (after opening the drawer or scrolling to Insights). `usageFocus` `usage-efficiency` and `usage-runs` scroll to the Insights band and open the drawer.
- Broken: `usage-projects-panel`, `usage-models`, `usage-roles` (replaced by the linked table rows, new ids needed), `usage-summary-item` semantics change from display to a radio control (role and `aria-checked` change; selectors by testid still work).

Accessibility and reduced motion:
- The tiles are `role=radiogroup` with roving focus; the chart stays a single Tab stop with the same roving model; legend entries are toggle buttons with `aria-pressed`; the table is the accessible alternative and stays in sync; brush handles are `role=slider` with arrow keys and Shift for larger steps, plus a "Reset zoom" button.
- Zoom animates the axis swap for 150 ms and never under reduced motion; series hide/show and overlay toggle are instant. Tooltip appears without motion.

Size: L plus a contract change. Risks: broadest scope and the only option that touches shared types and the main aggregator (hot files `types.ts`, `ipc.ts` take one claim at a time); mislabelling a partial series; discoverability of alt-click; brush on touchpads and keyboard; a Reviewer is needed if any spend aggregation is touched (no, it only slices existing totals, but attribution must reconcile to the totals).

### Option D (fourth path): A now, C's chart interactions later

1. Ship A as the first increment (chrome, hierarchy, sparklines, one breakdown card, previous-period overlay).
2. Increment two adds C's non-contract interactions to the A hero: legend toggles, KPI tile as metric switch (cost / tokens), row-to-series highlight, linked table sort.
3. Increment three, only if the owner wants group-by over time, adds `byModel`, `byConnection`, `byRole` to trend points and the group-by switch. Brush and zoom stay out until requested.
Each increment ships behind no flag, passes typecheck, unit tests, build and `e2e/usage-app.mjs`, and carries its own walkthrough.

## 3. Comparison

| | A Tidy page | B Tabbed report | C Explorer | D A then C |
|---|---|---|---|---|
| Cleaner (chrome, hierarchy) | High | High | Medium (denser) | High |
| Reporting depth | Medium | High (per tab) | High | Medium to high over time |
| Interactive | Medium (hover, click, overlay) | Medium (sort, switch) | High | Medium, growing |
| Cross-section comparison on one screen | Yes | No | Yes | Yes |
| Contract change | None | None | `byModel`, `byConnection`, `byRole` on trend points | None until increment three |
| Test ids / deep links broken | Panels behind tabs, disclosures | Section visibility, `usage-scroll`, summary line | Panels replaced, drawer | Same as A first |
| Size | M | L | L plus contract | M, then S, then M |
| Main risk | Dense KPI band at 1024 | Five tabs is too much structure; e2e rewrite | Scope, discoverability, data reconciliation | Slower to the full explorer |

## 4. Recommendation

Option D: build A first. Reasons:
- The diagnosis (D1 to D6) is about chrome, hierarchy and repeated panels, not about missing data; A removes all of them with no contract change and the smallest e2e churn.
- The spend chart already has keyboard roving, a readout and a legend (D7), so C's best interactions (legend toggle, metric switch, overlay, row highlight) are small additions to the A hero rather than a rebuild.
- B adds navigation depth to answer a clutter problem, hides cross-section comparison, and has the largest test and deep-link rewrite.
- C is the strongest "polished and interactive" answer but is the only path needing new trend slices; commit to that only if the owner wants group-by over time.
Decision for the owner: choose A (or D), B or C; and if D or C, whether group-by over time is wanted (it triggers the trend-slice contract change).

## 5. Open decisions

- Whether the tabbed breakdown card replaces the four panels outright, or the panels stay mounted and only the tab visibility changes (affects `e2e/usage-app.mjs`).
- Per-table copy/export beyond the existing CSV.
- Sparklines on all KPIs or only cost and runs.
- Previous-period overlay default (off in the wireframes).

## 6. Unverified

- All diagnosis rows are inferred from code; screenshot confirmation from the UX walkthrough was not available when written.
- The wireframes are neutral grey layouts, not rendered in the app, not checked in dark theme or at 1024x640 beyond the notes above; sizes S/M/L are estimates.
- Whether the KPI band fits at 1024 wide with sparklines was not measured.
- `usageFocus` behaviour per tab and the e2e id list were taken from the brief and a grep of test ids, not re-run.
