# Usage page (app-wide): UI spec

Status: spec, 2026-11-07. Author: Product Designer. Builder: UI Lead. Contract: Runtime Lead (`runs:usageOverview`, `runs:usageOverviewCsv`; names may shift, section 14 lists what this spec needs from it).

Inputs read: CLAUDE.md (Cost and usage, Dashboard, Renderer notes), `UsageTrends.tsx`, `lib/cost.ts` (re-export of `shared/view/cost.ts`), `outputs/token-efficiency-research.md`, `package.json` (no chart library is installed), `styles/tokens.css`.

Pre-walk: `docs/design/ux-review-usage-app-pre.md` (read in the revision of 2026-11-07). Section 15 maps every finding to where this spec answers it. Owner decisions of that date are recorded inline and in section 18.

## 1. Purpose and non-goals

The page answers three questions across every run of every project and the assistants:

1. Where did the money go (over time, project, model, role)?
2. Is it spent well (cache, retries, runs that produced nothing, waiting, team vs one assistant)?
3. Which runs should I look at first?

Non-goals: budgets or alerts (a later brief), per-agent drilldown (that stays in a run's Usage tab), live per-token streaming, changing prices (the existing "Set a price" link stays the only editor), comparing against other people.

Estimated cost is always an estimate (provider-reported or computed from model prices). The page never says "bill" or "invoice".

## 2. Entry points and placement

- Store View id: `'usage'` (add to `View` in `useAppStore.ts`). It is not project-scoped: opening it clears nothing and does not change `activeProjectId`. The topbar for this view is the app topbar used by Dashboard and App settings (title "Usage", no project crumbs, no project tabs).
- Sidebar: nav item "Usage" directly under "Dashboard", `nav-usage`, icon `ChartColumn`, `aria-current="page"` when active. In the 56 px rail the same item is an icon with the tooltip and accessible name "Usage". A needs-you count never appears on it.
- Menu: View > Usage, action `show-usage`, NO accelerator (owner decision: CmdOrCtrl+1..4 are project sections, and a fifth number key would read as one; the sidebar item and menu are the paths; the menu enable state is "always", it does not need a project). Routing is 'main' like the other navigation actions. Atlas surface id `usage` (path "Usage"), summary: "App-wide usage: cost over time, by project, model and role, and which runs wasted the most." Deep-link table entries: `usage`, `usage-efficiency`, `usage-runs` (focuses the section heading). `announceMenu` sentence on arrival: "Usage, all projects."
- Dashboard: the "Last 14 days" heading in `ActivityStrip` becomes a link "Last 14 days" with a trailing `ArrowUpRight` and title "Open Usage"; testid `dash-strip-usage-link`. Owner decision: it opens the page on the "30 days" preset (no 14-day range exists on the page). A strip day button keeps its readout on click; Enter on a focused day opens the page on 30 days with the chip "Day: <date>" (pre-walk M7), so the strip and the page agree on local days.
- Per-project Trends (History > Trends): kept as is (section 13).
- Assistants: Chat, MCP and Skill assistant runs are part of the data (project kind "Assistants", see 3.3).

## 3. Filters

One filter bar, `usage-filters`, a single row at 1600 px that wraps to two rows at 1024 px (period and bucket on row one, the rest on row two). It is sticky at the top of the page scroller with a hairline under it; its height is measured once and never changes with data.

### 3.1 Period

`SegmentedControl` "Period" (`usage-period`): `7 days` | `30 days` | `This month` | `Last month` | `Months...`.

- Presets are local-calendar: "7 days" = the last 7 local days including today, "30 days" likewise, "This month" = 1st 00:00 local to now, "Last month" the previous calendar month.
- `Months...` reveals a native `select` `usage-month` (last 12 months, same `monthOptions` as Trends) and a second `usage-month-to` select labelled "to" so a custom span of months is possible (From must be on or before To; choosing a From after To moves To up with the announcement "To month moved to <month>").
- Default on first open: 30 days.
- Period label under the bar (`usage-period-label`, plain text): "6 Oct to 5 Nov 2026 (30 days)", dates through `lib/dates.ts`.
- Scope line (`usage-scope`, one line under the `h1`, pre-walk M2): "All projects and chats, 6 Oct to 5 Nov 2026 · 212 runs" (names the project, "3 projects" or the kinds when narrowed). It repeats in the sticky bar's sr-only text so the scope is known after scrolling. Subtitle under it: "What your runs cost and where the time and tokens went. Costs are estimates unless your provider reports them."
- Month comparison: the summary deltas (4.3) are the "this month vs last month" answer; "Last month" is one click away and the page keeps no second chart for it.

### 3.2 Bucket

`SegmentedControl` "Group by" (`usage-bucket`): Day | Week | Month. Day is disabled (inert with reason) past 92 days of span; Month is inert under 60 days; the reason shows as the control's title and is not announced unless focused. Default follows the span: up to 31 days Day, up to 92 Week, else Month. A manual choice survives period changes while still valid.

### 3.3 Projects

`usage-projects` is a button with a popover (native `popover=auto`, listbox of checkboxes) labelled "Projects". Button text: "All projects" or "3 projects" or the single name. The popover has: a search field (shown from 8 projects), "Select all" / "Clear" text buttons, then groups in this order: Code projects, Engagements (grouped under the client name when two or more clients, as in the sidebar), Assistants (Chat, MCP assistant, Skill assistant, shown as one row each). Each row: checkbox, name, and the period's cost right-aligned (`Cost` compact). Rows for projects with no runs in the period are dimmed and sorted last, still selectable. A deleted ("Forgotten") project that still has runs appears under "Removed projects" with the stored name. All checked = absent filter (`projectIds` omitted).

### 3.4 Other filters

- Run kinds: `usage-kinds` popover of checkboxes, default all: Work runs, Setup (includes org change sessions), Ask, Chat, Assistants (MCP and Skill). Button text "All kinds" / "2 kinds".
- Connection: `usage-connection` native select "Connection": All connections, then one option per connection that has runs in the period, named by `connectionLabel(id)` (never "LiteLLM" for a proxy). Hidden when only one connection has runs.
- "Team or Ask" is not a filter. It is a chart-level split in the efficiency panel (6.5).

### 3.5 Active filter chips and what persists

Beneath the bar, `usage-chips` (a `ul`, one row, wraps) shows one chip per narrowing that is not the default: project chips ("Project: Billing"), model, role, connection, kind, day (a drilled bucket), and "Period: ..." only when it is not 30 days. Each chip has an X button named "Remove filter: Project Billing"; the last item is a text button "Clear all filters" (`usage-clear-all`), which resets drilldown narrowings AND the bar's project, kind and connection selections but keeps the period and bucket. The chip list is a polite region (`usage-live`, 6.9) that announces "Filter added: Project Billing. 14 runs." / "Filters cleared. 212 runs.".

Persistence: store `usageFilters` in memory per window for the session, plus localStorage `orgai.usage.v1` with `{ period, bucket }` only. Projects, kinds, connection, and drilldown chips are NOT persisted (a stale project filter hiding most spend is the worse failure; a reload opens the wide view). Leaving the page and coming back in the same window keeps everything in memory. There is no URL state.

## 4. Page structure (reading order = DOM order = tab order)

All regions are in one scroller (the page scrolls, like Dashboard; the filter bar sticks). Width: content max 1280 px, centred, side padding `--space-6` at 1600, `--space-4` at 1024. Container query `usage` on the page root; breakpoints in section 9.

1. Header: `h1` "Usage" (one text line) + right-aligned actions: Copy as CSV, Save CSV... (reuse the Trends handlers over `runs:usageOverviewCsv`, same status line wording and roles), a quiet "Updated 14:02" text (`usage-updated`).
2. Filter bar (3) and chip row (3.5).
3. Summary strip `usage-summary`: a `dl` of five figures: Estimated cost, Runs, Cost per run, Cache hit, Wall time. Each has a one-line delta vs the previous equal period ("up 12% on the previous 30 days", text only, no arrows needing colour). The previous-period totals come from a second query from the renderer (`runs:usageOverview` over the equal prior span, totals only), not a contract field; it fires after the main fetch settles, a failure or a truncated prior period omits the delta line (never zero), and it never delays first paint.
Cost-coverage line (pre-walk H3): under Estimated cost, always when any run is partial or unknown: "from 3 of 4 runs" plus a link button "1 run has no price" (`usage-no-price-link`), which adds the chip "Cost: no price" and opens All runs filtered to those runs. Never a bare "+" without this line; the "+" stays on the figure and its title reads "A lower bound. Runs with no known price are left out of the sum." Unknown total with no priced run: "No price" and "0 of 4 runs".
4. Spend over time (6.1), full width.
5. "Where it went": three panels in one row at 1600 (By project, By model, By role), a column of three at 1024 (stacked, each full width) (6.2-6.4).
6. Efficiency `usage-efficiency` (6.5).
7. Runs worth a look `usage-wasteful` (6.6).
8. All runs `usage-runs` (7.3), shown only after a project drilldown or on request (disclosure "All runs, N", closed by default; open when a project is drilled).
9. Footer notes: definitions disclosure `usage-definitions` (section 12.2) and the data notes (truncated, legacy, unpriced) as they apply.

Chart panels are `section` elements with `aria-labelledby` the panel `h2`. Every panel head is: `h2`, a one-line summary sentence in muted text that states the finding in words ("Billing is 61% of this period's estimated cost."), and on the right a `Show as table` toggle button (`aria-pressed`, testid `usage-<panel>-table-toggle`). The table replaces nothing by default: chart first, table in a native `details` underneath named "Show as table" like Trends. The panel toggle is not needed; use the `details`.

## 5. Drawing rules (shared by every chart)

- No chart library. Inline SVG drawn by new small components in `components/usage/` (`SpendChart.tsx`, `RankedBars.tsx`, `EfficiencyMeters.tsx`, `ChartTable.tsx`), pure scale and tick helpers in `lib/usageCharts.ts` (unit-tested: nice ticks, bucket fill, stack order, top-N + "Other" folding, unknown encoding). Justification: the page needs one stacked bar chart and horizontal ranked bars, both a few hundred lines of SVG, and the micro-visualisation rules (tokens, text alternatives, roving readouts) are already written for hand-drawn marks. A library would add weight and its own focus and colour model to fight. Revisit only if a later brief asks for zoom/brush on time axes.
- All colour comes from CSS variables, never literals in TSX. New tokens (both themes, in `tokens.css`, the light block too): `--chart-s1` to `--chart-s6` (series), `--chart-other` (neutral, `--text-muted` mixed to 70%), `--chart-unknown` (hatch stroke, `--text-muted`), `--chart-grid` (`--border-subtle`), `--chart-axis` (`--text-muted`), `--chart-focus` (`--accent`). Series values: derive from the existing hues so the page matches the canvas role colours: s1 accent, s2 info, s3 success, s4 warning, s5 danger, s6 a teal/pink step. Owner decision: the hex values are measured at build time with better-colors against a 3:1 target (each fill against `--surface-1`, and each adjacent pair in the stack, both themes; text on bars is never used); the spec fixes roles and target, not hex, and the build records the measured ratios in the token file. Colour is never the only cue: the legend rows carry the project name and the cost, and the stacked bars have a 1 px `--surface-1` gap between segments.
- Series assignment is stable for the period: projects are ranked by cost in the whole filtered period; the top 5 take s1-s5 in rank order, the rest fold into one "Other (N projects)" in `--chart-other`. A project keeps its colour while the period is unchanged, even when a filter hides others, so a drilled view does not recolour. Different periods may reassign (accepted, the legend and labels always name the project).
- Unknown and partial cost (the rule is lib/cost.ts's; this is how it draws):
  - Known: solid fill.
  - Partial (a lower bound, "$4.20+"): solid fill plus a 4 px diagonal hatch overlay in `--chart-unknown` at the top 8 px of the segment, and the label carries "+".
  - Unknown (tokens but no price): no value to draw. Segment is an outlined stub 6 px tall (dashed `--chart-unknown` stroke, no fill) at the base of that project's slot, labelled "unknown" in the readout. It adds nothing to the axis scale, and the panel note says so. A whole bucket that is unknown shows the stub only.
  - Nothing spent: no mark at all, the bucket label still exists.
  - Legacy (recorded before usage tracking): the figure stays solid but a small `~` precedes it in readouts ("~$0.40") and `Cost`'s title adds the legacy sentence; panel note counts legacy runs (section 11).
  Every figure text goes through `costView`; never format a USD by hand. Totals use `sourceMixed: true`.
- Cost decimals, ONE rule for every figure on the page (summary, legend, ranked bars, readouts, tables, chips, efficiency, wasteful table; pre-walk M3): an amount of $1.00 or more shows 2 decimals ("$42.10", thousands separated); $0.01 to under $1.00 shows 3 ("$0.426"); above $0 and under $0.01 shows 4 decimals ("$0.0019") and "< $0.0001" below that (no "< $0.01" floor); $0 is only a real zero ("$0.00"). The "+" and "~" marks append unchanged. The full-precision value (up to 6 decimals) is the element's `title` and the CSV value. Only chart axis tick labels use `formatUsdCompact` ("$5", "$12k"). Within one table column the rule applies per cell (no padding to equal decimals), figures are right-aligned with tabular-nums. This rule is added to `shared/view/cost.ts` (`costView` `precision: 'page'`) so tests pin it, and Dashboard strip / Trends adopt it when they next change.
- Partial rule (pre-walk H3): a figure carries "+" if and only if at least one run folded into it has unknown cost, decided by the same fold for the total, every ranked row and every role row, so a total can never read complete while one of its rows reads partial.
- Axis and ticks: value axis from 0, 3 to 5 nice ticks, labels `formatUsdCompact`; gridlines `--chart-grid` 1 px; no top axis, no rounded corners over 2 px; bars have a minimum drawn width of 6 px and gap of at least 2 px. Time axis labels thin out to avoid overlap (every Nth label), the first and last always shown, local dates.
- Type: chart text is `--font-sm` tabular-nums (`font-variant-numeric: tabular-nums`), labels never rotate; long names are middle-clipped with the full name in the readout and table.
- Motion: bars do not animate in. Hover/focus changes are instant (no transitions on data marks). Chart re-render on data update: cross-fade is not used; the new geometry swaps in the same frame. This keeps the live-update policy (10) free of motion and passes both reduced-motion switches with no special case.

## 6. Panels

### 6.1 Spend over time (`usage-spend`)

- Head: `h2` "Spend over time"; summary "Estimated $42.10 across 212 runs; busiest day 3 Nov, $9.80." (or "unknown" wording when everything is unknown). Right side: `SegmentedControl` "Chart shows": Cost | Tokens (`usage-spend-metric`; Tokens stacks the same way by project and is the one honest view of a period where nothing is priced; when every bucket is unknown the control selects Tokens and the panel note says "No prices known for this period; showing tokens.").
- Chart: stacked vertical bars, one per bucket, segments by project (5.2 palette). Height 220 px at 1600, 180 px at 1024. Plot has a left axis gutter of 48 px.
- Legend (`usage-spend-legend`): a `ul` right of the plot at 1600 (min 200 px) and below it at 1024. Each row is a toggle-free button: swatch, project name, period cost. Clicking a legend row is the project drilldown (narrows to that project, 7.1). The `Other` row opens the project popover instead. Rows are in rank order.
- Hover or focus on a bar shows the readout (`usage-spend-readout`, a single fixed-height line under the plot, no floating tooltip: "Tue 3 Nov: $9.80, 14 runs. Billing $6.10, Docs $3.70."; unknown parts say "Notes unknown"). Pointer hover updates the same line; no tooltip box over the plot.
- Selected state: clicking a bar (or Enter on it) narrows to that bucket (7.2) and the chip "Day: Tue 3 Nov" (or "Week of 2 Nov", "Month: Oct 2026") appears; the bar selection is drawn as a 2 px `--chart-focus` outline on the column; other columns dim to 55% opacity.
- Keyboard: the plot is one Tab stop (`role="group"` with `aria-label` "Spend per day, bar chart. Arrow keys move between days, Enter narrows to a day"), roving `tabindex`, Left/Right between buckets, Home/End first/last, Up/Down move between the project segments of the focused bucket (the readout then names that segment), Enter on a segment narrows to that bucket AND that project, Enter on a bucket narrows to the bucket, Esc clears the bucket selection, no type-ahead. Focus ring is the `--chart-focus` 2 px outline offset 2 px on the column.
- Text alternative: `role="img"` is NOT used on the plot (it would hide the keyboard readout). The group carries a summary `aria-label`; the table below is the full alternative: columns Period, Runs, Tokens, Cost, then one column per legend project; rows only for buckets with runs; sticky first column.
- Test ids: `usage-spend`, `usage-spend-plot`, `usage-spend-bar[data-bucket][data-state=known|partial|unknown|empty]`, `usage-spend-segment[data-project]`, `usage-spend-legend`, `usage-spend-readout`, `usage-spend-table`.

### 6.2 By project (`usage-projects-panel`)

Horizontal ranked bars, one row per project (code projects and engagements and assistants alike, with a small kind mark `Briefcase` for engagements and none for code). Row: name (clipped), bar sized by cost, cost, runs. Rows sorted by cost descending; unknown-cost projects sort after all known, ordered by tokens, with the stub encoding. Show 7 by default and "Show N more" (`usage-projects-more`); this list is a roving listbox.

- Click or Enter: narrows to that project (chip) and opens "All runs" with that project's runs (7.1).
- A second control on the focused row, Right arrow or the `More` button: "Open project" navigates to the project's Live view (no filter change). `More` is a native popover menu `usage-project-more` with "Narrow to this project", "Open project", "Open History" (the project's History tab). Shift+F10 opens it.
- The Assistants appear as three rows named Chat, MCP assistant, Skill assistant; "Open project" opens that assistant.
- Table alternative columns: Project, Kind, Runs, Tokens, Cost, Cost per run, Cache hit.

### 6.3 By model (`usage-models`)

Horizontal ranked bars by model id (as the provider reported, middle-clipped, family badge from `lib/modelFamily.ts`), with the connection name in muted text under it. Cost bar, tokens, share of tokens. Unpriced models always sort by tokens after the priced ones and each carries the `UnpricedNote` ("No price known." with the **Set a price** link `usage-set-price` calling `requestModelPrice(model)`, which leaves the page for App settings and returns here via Back). A model that is priced from the builtin table shows nothing extra; a community or proxy price shows a quiet source word in the table, not on the bar. Click narrows to the model (chip "Model: claude-sonnet-4-5"): the filter keeps runs that used that model, and (owner decision) the cost shown for the other panels is the model's own cost in those runs. While a model chip is present the summary label reads "Model cost" instead of "Estimated cost", with the title "Cost of this model only, not of the whole runs." Run counts stay whole runs; Cost per run reads "Model cost per run".

### 6.4 By role (`usage-roles`)

Ranked bars per role, keyed project + role ("Billing / Reviewer"), the project name in muted text. When a single project is filtered the project part drops. The same sums as Trends' By role table, plus cost. Sort by cost then tokens. Click narrows to that role in that project (chip "Role: Billing / Reviewer"); then the page lists runs where that role spent tokens. Role rows also show the role's retries when above zero ("3 retries") as plain text, not colour.

### 6.5 Efficiency (`usage-efficiency`)

One panel, `h2` "Efficiency", summary sentence generated from the weakest signal ("Cache hit is 41%, lower than the 70% your other projects reach.": only worded when a comparison exists, else "Cache hit is 41%.").

Layout: a grid of eight small instruments (`usage-eff-item[data-signal]`), 4 columns at 1600, 2 at 1024. Each instrument is a `dl` pair: name (with an info button `usage-eff-info` opening a definition in a popover), the value large, and one small drawn element beneath (a 100% rail, a dot-and-range, or a 14-bucket sparkline with the same tokens as ActivityStrip). Instruments:

| Signal | Value | Drawn element | Notes |
|---|---|---|---|
| Cache hit | `cacheRead / (input + cacheRead + cacheWrite)` as a percent | 100% rail | Unknown when no run reports cache fields: "Not reported" (never 0%). Codex and proxies that do not report show "Not reported by <connection>". |
| Cost per run | median and mean | median tick on a range line | Median is the headline; mean in the title. Unknown runs excluded and counted: "2 runs have no price". |
| Tokens per turn | total tokens / turns | sparkline over buckets | Hidden when no run reports turns. |
| Retries | retries per 100 turns and the count | rail | Text "12 retries across 9 runs". |
| No result | share of tokens spent by agents that returned nothing (`noResultTokens / total tokens`) | rail | See 12.2 for the definition; 0% is a real zero when usage was tracked. |
| Nudges | nudges per run | small count | "Nudge" = the app asked an agent to keep going. |
| Waiting and idle | share of wall time waiting on you, idle, held by limits | 3-segment rail (tokens `--chart-s*` not used; uses `--info`, `--text-muted`, `--warning`) | Text reads all three: "Waiting on you 18%, idle 7%, limit hold 2%". |
| Team vs Ask | cost per run of team runs vs Ask runs | two ranked dots on one scale | Needs at least 3 runs of each; else the item reads "Not enough Ask runs to compare" and shows counts. |

Rails are 8 px tall, 100% = full width, a target marker is never drawn (no invented "good" line). Thresholds are not coloured red/green; the page does not judge, it states and compares. The only emphasis is the summary sentence.

Drilldown: clicking an instrument's value or Enter narrows nothing; it sets the wasteful runs table's sort to the matching signal and moves focus to that table's heading ("Sorted by lowest cache hit"). Retries and no-result do the same. This is the efficiency-to-runs link.

Keyboard: the eight instruments are a roving group (`role="group"` per instrument is not needed; each instrument's value is one `button`). One Tab stop for the grid, arrows move in reading order.

Table alternative: a single table "Efficiency by project": Project, Runs, Cost per run, Cache hit, Tokens per turn, Retries, No-result share, Idle share. Sortable on every column (`aria-sort`).

### 6.6 Runs worth a look (`usage-wasteful`)

A table of up to 10 runs (25 behind "Show more"), sorted by a chosen signal. Heading `h2` "Runs worth a look", with a `select` "Sort by" (`usage-wasteful-sort`):

1. **Cost with no result** (default): estimated cost of the run's agents that returned nothing, plus the cost of runs that ended Failed. Needs `noResultCostUsd` in the contract (section 14); until then the default falls back to "Most expensive".
2. Most expensive
3. Lowest cache hit (runs of at least 20k input tokens only, so tiny runs do not top the list)
4. Most retries
5. Most nudges
6. Most idle time (share of wall time)

Columns: Run (title or prompt, via `displayRunName`, project name muted under it), When, Cost, Why listed (a plain sentence for the active sort, naming the agent for no-result: "implementer-2 spent 820 tokens and produced no result" or "implementer-2 and 1 other spent 1,640 tokens and produced no result"; other sorts: "Retried 2 times", "Auto-continued 3 times", "Waited on you 12 min", "Cache hit 31%"; pre-walk H2/M6), a text tag "No result" beside the run name when it applies (never dimming alone), Status word (`lib/runStatus.ts`). Agent names are `agentLabel` (handle first); contract needs `noResultAgents` (item 14.15). The first column is a `button` that drills (7.3). Rows with unknown cost sort after the known and show "unknown" with the tokens as the sorting figure; a footnote explains. The table never claims a run was a mistake: heading note "These are where spend and results diverge most. A long run that did its job can also appear." (`usage-wasteful-note`).

Empty state for this table alone: "Nothing stands out in this period." when no run has a non-zero signal.

## 7. Drilldowns

### 7.1 Narrow, then list

Every chart element narrows through one store action `narrowUsage({ project?, model?, role?, bucket?, connection? })`, which updates `usageFilters`, adds chips, refetches, and announces. The page does not navigate on a narrowing; it stays scrolled where it is. Focus stays on the clicked element if it still exists, else on the chip that was added (chips are focusable buttons), so the keyboard user is never dropped to the top.

Drill path for a project: panel row click -> chip "Project: X" -> "All runs, N" opens and scrolls into view -> run row Enter -> run opens.

### 7.2 Buckets narrow the period

Clicking a day bar adds a "Day" chip that narrows every panel to that day (period unchanged underneath so Remove returns to the span). Clicking a week bar narrows to that week and offers the bucket switch to Day through the chip's title "Switch to days"; a month bar likewise. Narrowing to a bucket does not change the bucket control. The spend chart keeps showing the whole period with the selected bucket outlined and others dimmed, so the user sees context; the other panels recompute for the bucket.

### 7.3 Runs list and opening a run

`usage-runs` is a table "All runs" (up to 100 rows with "Show N more"; windowing past 300, same rule as `lib/knowledgeList.ts`), columns: Run, Project, When, Kind (`runKindWord`), Models (first plus "+N"), Tokens, Cost, Cache hit, Time. Sortable by Run, When, Cost, Tokens. The first cell's button opens the run in its project: `openRun(projectId, runId)` switches `activeProjectId`, View 'run', side tab 'usage', exactly as the History "N outputs" link does for Outputs. A run in a project that was forgotten has no button; the row says "Project removed" and the figures stay. Assistants' runs open in their assistant project. A live run opens live. On arrival at a window under 1100 px the run's side panel opens expanded to its wide width (at least 480 px) on the Usage tab, so agent names are not clipped (pre-walk M5); `UsagePanel` agent cells always show the handle first, then the role name, and the full name in `title`, so two reports of one role ("mock-lead-report-1", "-2") stay distinguishable, and an agent that produced nothing carries the text tag "No result" and is named in the sentence above the table. Back (Alt+Left or the app's Back where one exists) returns here with filters intact because `usageFilters` is in the store; the store records `usageReturn` so the run view shows nothing extra (no banner).

### 7.4 Out of scope

No drilldown to agents or to model-by-run matrices. The run's own Usage tab is the end of the road.

## 8. Run kinds and project kinds in the data

- Project kind column: `code` | `engagement` | `assistant` (Chat, MCP, Skill). Engagements show a Briefcase mark in the By project panel and the runs table. Client names appear only as the grouping label in the projects popover and in the CSV.
- Kinds in the filter map to rows: work -> "Work runs", setup + org-change -> "Setup", team single -> "Ask", quick -> "Chat" (quick team default stays "Chat"), mcp-assist and skill-assist -> "Assistants". Kind words come from `runKindWord` / `runKindLabel`.

## 9. Layout at both sizes

Page root is a size container. Measured for the two e2e windows (content area after sidebar 232 px at 1600; rail 56 px at 1024).

- 1600x1000: content width about 1300 px: max 1280 px. Spend chart plus legend side by side; the three "Where it went" panels in one row of three equal columns (min 360 px each); efficiency 4 columns; runs tables full width. First view without scrolling shows header, filters, summary, spend chart and the top of the three panels.
- 1024x640 (rail, 56 px): content width about 944 px minus padding. Filter bar two rows. Summary strip five figures in one row of 5 at 168 px each; if narrower than 840 px, 3 + 2. Spend chart full width, legend below it as a two-column list. The three panels stack, each full width, shown 5 rows by default. Efficiency 2 columns. No horizontal page scroll at any width from 880 px. Tables sit in `overflow-x: auto` wrappers with sticky first column and `tabindex=0` when they overflow (the same pattern as Trends), never forcing the page to scroll sideways.
- Under 880 px of container: one column everywhere; the filter bar collapses the Projects, Kinds and Connection buttons into one "More filters" popover (`usage-filters-more`, like `knowledge-filters-more`).
- Heights: charts have fixed pixel heights (220/180), so loading or refreshing never moves what is below. The empty and loading states reserve the same heights as the loaded panels.

Both themes: all marks from tokens in 5; the page is checked in dark and light at both sizes. Light-theme hatch uses `--text-muted` at 60% so it stays visible against pale series fills; dark-theme series fills at 85% lightness range per the token pass.

## 10. Data, loading and the live-run policy

- Query: `runs:usageOverview({ since/until or range, kinds, bucket, projectIds, limit: 2000 })`, with the model/role/connection/bucket narrowings applied client-side on the returned rows where possible (so chips respond without a refetch) and by query only for period, kinds, projectIds. Contract needs for the rest in section 14.
- Fetch on mount, on a period, kinds or project change (debounced 150 ms so a multi-select does not fire per click), and on Retry. Never on a timer by itself.
- Live runs: the page subscribes to the same run events the store already holds (status `run.status`). It refetches (a) when any run in the current scope reaches an ended or paused status (at most once per 5 s, trailing), and (b) while at least one run in scope is live, every 30 s (trailing, only when the window is focused and the page is mounted). A refetch is silent: it keeps the current data on screen (`data-stale` is NOT set while refreshing), swaps geometry in one frame, never changes chart heights, never moves focus, never resets scroll, never clears a drilldown. A narrowed selection that vanishes (the bucket gets no runs) keeps its chip and shows the empty state for that chip rather than clearing it.
- Live runs are drawn in totals (the contract's rows include them) and marked: the summary strip gets the line "1 run is still going; its figures will grow." (`usage-live-note`); the run's row in tables carries the status word Running. Live bars show no special cue (no pulse, no breathing: this is a ledger, not a monitor).
- `usage-updated` shows the last successful fetch time; it changes with every fetch but is not live-announced.
- Loading: first load shows skeleton blocks at the final heights, with `aria-busy` on the page root and a single `role=status` line "Loading usage..." in the footer region. A refetch after a filter change dims nothing (the old data stays until the new arrives, then swaps; `aria-busy` true meanwhile).
- Errors: a Banner (danger, "Could not load usage", Retry) in place of the panels, filters stay enabled. A refetch failure after data is shown keeps the data and adds a warning Banner "Could not refresh usage. Showing the data from 14:02." with Retry.
- Truncated: when the contract sets `truncated` (the 2000-row limit cut the oldest), a warning Banner under the chips (`usage-truncated`): "Showing the newest 2,000 runs. Runs before 12 Oct are left out, so totals are a lower bound. Narrow the period to see everything." with the action "Use 30 days" when the span is longer. All headline totals gain the "+" lower-bound mark through `costPartial`-style treatment, the summary strip adds "at least" in the visually shown text: "At least $412.30". The bucket chart draws buckets before the cut as hatched empty columns labelled "not loaded" (not zero).

## 11. States

- First launch, no runs ever: the whole page is an `EmptyState` (`usage-empty-all`, icon `ChartColumn`): title "No usage yet", description "Usage appears here once a run has spent tokens. Start a run in any project." with primary "Go to Dashboard". Filters are hidden.
- Runs exist, none in the filter: panels are replaced by `EmptyState` (`usage-empty`) "No runs match these filters", description names the strongest cause ("No runs in the last 7 days. The most recent run was on 28 Oct."), buttons "Clear all filters" and, when the period is the cause, "Use 30 days". The filter bar and chips stay.
- Everything unknown: totals show "unknown", the spend chart switches to Tokens as in 6.1, the By model panel lists models with "Set a price" links, and a banner-less `usage-unpriced-note` says "No prices are known for <N> models, so cost cannot be shown. Tokens are counted." Never $0.
- Partly unknown: totals show "$42.10+" with the title naming the models without a price; `usage-partial-note` under the summary: "N runs have no known price, so costs are at least these figures."
- Legacy: `usage-legacy-note` "N runs are from before OrgAI measured usage. Their tokens and cost are rough, and they have no efficiency figures." Efficiency instruments count only non-legacy rows and say so in their titles ("Based on 190 of 212 runs").
- Mock adapter: no special handling; all figures are labelled estimated like real ones.
- Proxy that reports no spend or prices: models show "not reported by this proxy" in the By model table (the existing wording), never $0.

## 12. Copy

### 12.1 Labels

Page title Usage. Summary labels: Estimated cost, Runs, Cost per run, Cache hit, Wall time. Section titles: Spend over time, By project, By model, By role, Efficiency, Runs worth a look, All runs. Controls: Period, Group by (Day, Week, Month), Chart shows (Cost, Tokens), Projects, Kinds, Connection, Sort by, Show as table, Show N more, Clear all filters, Copy as CSV, Save CSV... Run kinds: Work runs, Setup, Ask, Chat, Assistants. Status words from `lib/runStatus.ts`. Chip text: "Project: <name>", "Model: <id>", "Role: <project> / <role>", "Connection: <name>", "Kind: <kind>", "Day: <date>", "Week of <date>", "Month: <month year>".

Announcements (all through `usage-live`, polite, one at a time, joined with a full stop between sentences by `joinAnnouncement`): "Usage loaded. 212 runs, estimated $42.10." / "Filter added: <chip>. 14 runs, estimated $6.10." / "Filter removed: <chip>. ..." / "Filters cleared. ..." / "Sorted by <signal>." / "Could not load usage." Announced after the fetch settles, never per keystroke or per focus move. Maximum one announcement per 2 s.

### 12.2 Definitions (`usage-definitions`, a `details` "What these terms mean", and each as the title of its info button)

- **Estimated cost**: What the provider reported, or what OrgAI computed from model prices. It is an estimate, not an invoice. A "+" means at least this much, because some models have no known price. "unknown" means tokens were used but no price is known.
- **Cache hit**: The share of input tokens the provider read from its prompt cache instead of processing again. Higher is cheaper. "Not reported" means the connection does not say.
- **Cost per run**: The median estimated cost of a run in this view. The mean is in the tooltip.
- **Tokens per turn**: Tokens used divided by the number of turns agents took.
- **Retries**: Times a failed request was sent again. Counted per 100 turns.
- **No result**: Tokens spent by agents that finished without giving a report back. The root agent is never counted here.
- **Nudges**: Times OrgAI asked an agent to keep going after it stopped before the work was done.
- **Wall time**: The clock time a run was open, from start to end, including time waiting on you.
- **Waiting on you**: Time a run was paused on a decision or answer.
- **Idle**: Time a run was open with nothing running and nothing waiting on you.
- **Limit hold**: Time a run was paused because the plan or account limit was reached.
- **Team vs Ask**: Team runs use the whole org chart; Ask runs use one assistant. Costs are compared per run.
- **Truncated**: The newest 2,000 runs are loaded. Older ones in this period are left out.
- **Legacy**: Recorded before usage tracking; figures are approximate.

### 12.3 Never

Do not call figures "spend you owe", "charged", "bill", "savings", or "waste" outside the table heading "Runs worth a look". Say "estimated". Do not write "LiteLLM" for a proxy. Do not state a recommendation as fact ("use Ask instead"); the page reports, the tips line of the token-efficiency plan item 10 is a separate brief.

## 13. Existing per-project Trends

Keep History > Trends unchanged, with one addition: below its controls, a quiet link (`trends-see-all`) "See all projects" with `ArrowUpRight`, which opens the Usage page with the same period (when it maps to a preset or month) and `projectIds: [thisProject]`, showing the "Project: X" chip. The Trends range is not shared with the page; each persists on its own key. The Usage tab inside a run gets one addition (owner decision): a quiet link "All usage" (`run-usage-all`, `ArrowUpRight`) at the top of the tab, opening the Usage page with `projectIds: [that project]` and the "Project: X" chip, period 30 days; for an assistant run it filters to that assistant. Otherwise the tab is unchanged.

## 14. Contract needs beyond the planned shape

Send these to the Runtime Lead:

1. Bucket day boundaries in local time: the query carries `tzOffsetMinutes` (or a time zone id) so buckets, "today" and months match the Dashboard strip's local days; the returned bucket carries its start as epoch ms plus the label key. Without it, the page cannot draw days the user recognises.
2. Per-row fields the page reads: `startedAt`, `endedAt` (null while live), `status` word source (`outcome`, `endedBy`, `endedWhile`), `title`, `team: 'single'` flag, `quick`, `kind`, `legacy`, live flag, `connection` id, per-model entries with `input`, `output`, `cacheRead`, `cacheWrite`, `costUsd | null`, `priceSource`.
3. `noResultCostUsd` (and null when unknown) per run and per project rollup. The default "wasteful" sort needs it. Fall back sort is cost.
4. Cache fields reported-or-not: `cacheReported: boolean` per model (or per run), so "Not reported" is not drawn as 0%.
5. Trend buckets: per bucket per project `costUsd | null`, `costUnknownRuns`, `runs`, tokens including cache. Also an "other" bucket is NOT wanted; the renderer folds projects itself. Per bucket also total wall/waiting ms for the Waiting/idle instrument (optional).
6. `truncated: true` plus `oldestIncludedAt` (epoch ms) so the banner can name the cut date.
7. (Withdrawn.) Previous-period totals are NOT a contract field: the renderer makes a second `runs:usageOverview` query for the equal prior span (3 / 4.3).
8. `generatedAt` (epoch ms) for `usage-updated`.
9. Project rollups include `projectRemoved: true` and the stored name for forgotten projects; assistants carry projectId 'quick' | 'harness' | 'skills' and `projectKind: 'assistant'`.
10. Role rows: per project + role `retries`, `noResultTokens`, `cost`, `runs`, tokens including cache (so By role and the efficiency table need no second query).
11. Connection rollups with the proxy's `kind` and whether it reports spend/prices, for the "not reported by this proxy" wording.
12. A client-side narrowing by model or role needs run rows to carry `models` and `roles` with token and cost; confirm rows have both (the planned shape does).
13. CSV: add period filters echo and the model/role column set already in `runs:usageCsv`; keep formula-injection quoting; add `project_kind`, `connection`, `cache_read`, `cache_write`, `retries`, `nudges`, `no_result_tokens`, `idle_ms`. Same query shape for `runs:usageOverviewCsv`. Atlas: new `usage` surface and `MENU_ACTION_DOCS` entry for `show-usage` (typecheck enforces).
14. The page needs the event or poll cadence to be cheap: the overview should be answerable in under 300 ms for 2,000 rows (it is a pure fold over stored summaries). No streaming.
15. `noResultAgents` per run: up to 3 `{ agentId, label, tokens }` of agents that returned nothing (root excluded), so the wasteful table and the run's Usage tab can name the agent (pre-walk H2/M6).
16. `costKnownRuns` / `costUnknownRuns` per rollup (total, project, model, role) for "from 3 of 4 runs" (pre-walk H3).

## 15. Pre-walk findings mapped to the spec (`ux-review-usage-app-pre.md`)

- H1 (no cross-project, model or month view; strip days do not navigate; Chat spend nowhere): the page itself (2); project, model, role, kind and connection breakdowns (6.2-6.4, 3.4); month totals and "Last month" with deltas (3.1, 4.3); strip heading link and Enter on a day open the page (2); Chat and the other assistants are rows in By project and a group in the Projects popover (3.3, 6.2, 8), and the chip "Kind: Chat" isolates them. The Dashboard `$0.06+` and the page now use one decimals rule (5), so they can be reconciled.
- H2 (efficiency only per run; the no-result agent not named): Efficiency panel over all runs (6.5) and "Runs worth a look" with sort by cost-with-no-result, retries, nudges, idle, cache (6.6); the agent is named in the sentence and tagged "No result" (6.6, 7.3, contract 14.15).
- H3 (bare "+" mixes known, partial, unknown; role "+" vs total without): the cost-coverage line "from 3 of 4 runs" with the "1 run has no price" link, and the one partial rule (4.3, 5); unknown reads "No price" in cells with the model id in the title, "unknown" only in prose labelled as such (5, 6.1).
- M1 (keyboard on chart bars): roving bars with readout, Enter drills, plus tables (6.1, 6.2, 6.5).
- M2 (scope not stated): `usage-scope` line and sticky bar (3.1).
- M3 (inconsistent decimals): the single decimals rule (5).
- M4 (no home for Chat and Ask): rows under Assistants, Ask is a kind filter and the Team vs Ask instrument (3.3, 3.4, 6.5, 8).
- M5 (run drilldown cramps at 1024 with duplicate role names): wide side panel on arrival, handle-first names with titles (7.3).
- M6 (culprit not named, colour-only dim): named sentence plus text tag (6.6).
- M7 (strip leads nowhere): see H1.
- L1 (account popover under the mock): not a page matter; the plan-window meter stays where it is (not driven).
- L2 ("Estimated cost" vs "Cost"): the page says "Estimated cost" for figures priced here and "Model cost" with a model filter; provider-reported figures use the same word, the definition says "What the provider reported, or what OrgAI computed" (12.2).
- L3 (undefined terms: run time, wall, waiting, idle): definitions disclosure and info buttons (12.2); label "Wall time".
- L4 (legacy note): `usage-legacy-note` with "~" marks (5, 11). Suggested pre-walk wording is adopted: "N runs are from before OrgAI measured usage. Their tokens and cost are rough, and they have no efficiency figures." replaces the 11 sentence.
- Empty month: "No runs match these filters" names the cause with the last run date (11).

## 16. Test ids

Page: `usage-view`, `nav-usage`, `usage-header`, `usage-updated`, `usage-live`, `usage-filters`, `usage-period`, `usage-month`, `usage-month-to`, `usage-bucket`, `usage-projects`, `usage-kinds`, `usage-connection`, `usage-filters-more`, `usage-period-label`, `usage-chips`, `usage-chip[data-kind=project|model|role|connection|kind|bucket|period]`, `usage-chip-remove`, `usage-clear-all`, `usage-summary`, `usage-summary-item[data-signal]`, `usage-live-note`, `usage-truncated`, `usage-partial-note`, `usage-unpriced-note`, `usage-legacy-note`, `usage-empty-all`, `usage-empty`, `usage-error`, `usage-loading`, `usage-copy-csv`, `usage-save-csv`, `usage-csv-status`, `usage-definitions`.
Panels: `usage-spend*` (6.1), `usage-projects-panel`, `usage-project-row[data-id][data-state]`, `usage-projects-more`, `usage-project-more`, `usage-models`, `usage-model-row[data-model][data-state]`, `usage-set-price`, `usage-roles`, `usage-role-row[data-project][data-role]`, `usage-efficiency`, `usage-eff-item[data-signal=cache|cost-per-run|tokens-per-turn|retries|no-result|nudges|idle|team-vs-ask]`, `usage-eff-info`, `usage-eff-table`, `usage-wasteful`, `usage-wasteful-sort`, `usage-wasteful-row[data-run]`, `usage-wasteful-note`, `usage-runs`, `usage-run-row[data-run][data-project]`, `usage-run-open`. Every chart `details` table: `usage-<panel>-table`. Dashboard link `dash-strip-usage-link`; Trends link `trends-see-all`.

## 17. What the UX walk must check

Mock data (seed several projects incl. an engagement, Chat, and `[mock:no-price]`, `[mock:computed-cost]` runs; cross-project fixtures need a multi-project seed the walk script creates), 1024x640 and 1600x1000, dark and light, then a keyboard pass:

1. Entry: sidebar and rail item, View > Usage (no accelerator), the Dashboard strip link (opens on 30 days) and Enter on a strip day, the run Usage tab's "All usage" link; Back from a run returns with filters intact. Cost decimals identical on every view (one rule); "from N of M runs" present whenever "+" is; a run opened from the page shows its side panel wide at 1024 with unclipped, distinguishable agent names.
2. Every figure goes through `costView`: unknown never $0, "+" on partial, "~" on legacy; stub segments for unknown; the hatch visible in both themes.
3. Drilldowns: legend, bar, project row, model row, role row, efficiency instrument, bucket; chips add and remove; Clear all; announcements are single and ordered; focus never lost to body; run opens in its project on the Usage tab.
4. Keyboard: each chart one Tab stop, arrows/Home/End/Enter/Esc as specified, focus ring visible on every mark, tables reachable, no mouse-only function.
5. Live update: start a mock run while the page is open; no layout shift (measure panel offsets before/after), no focus move, no scroll jump, no animation; figures grow after the run ends within 5 s; the live note appears and goes.
6. States: first launch empty, filter-empty, truncated (seed past 2,000 rows or stub the limit), error with Retry, partly unknown, all unknown, legacy runs.
7. Layout: no page-level horizontal scroll at both sizes; the three panels in a row at 1600 and stacked at 1024; filter bar wraps to two rows without clipping; sticky bar does not cover focused elements (`scroll-padding-top` equals its height).
8. Contrast of series fills and labels in both themes by measurement, not by eye; reduced motion on (nothing to change).
9. Copy: terms match section 12; "Estimated" everywhere; no "LiteLLM" for a proxy; no "waste" outside the one heading.
10. CSV: Copy and Save produce the same rows as the table; filters echoed.

## 18. Open decisions

Decided by the owner, 2026-11-07 (no longer open): a model filter shows the model's own cost, labelled "Model cost" (6.3); the Dashboard strip link opens the page on Last 30 days (2); no accelerator for show-usage (2); the run's Usage tab has a quiet "All usage" link filtered to its project (13); series hex values are measured at build time with a 3:1 target (5).

Still open:
- Budgets and alerts, and tips copy (token-efficiency plan item 10), are separate briefs.
- Whether Dashboard strip and Trends adopt the page's decimals rule in the same change or the next (5).
