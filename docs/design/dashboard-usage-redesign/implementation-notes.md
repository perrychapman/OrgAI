# Dashboard and Usage redesign: implementation notes

Built 2026-11-21 from the approved design system in `project/` (README, dashboard.md, usage.md, motion.md, tokens.json,
components/*). Renderer only: no change to `src/shared`, `src/main`, `src/preload`, the CSP or dependencies. The
Decisions figure reads `RunUsage.decisions`, which main added on dev in a separate change (see Open items).

How each fact was checked is named in brackets: [unit] unit tests beside the module, [e2e] the named e2e script on the
mock adapter, [walk] the mock UX walkthrough `docs/design/ux-review-dashboard-usage-redesign-post.md`, [review] the
Reviewer pass, [code] read in code only.

## Foundation

- Tokens added to `styles/tokens.css`: `--aura-from` / `--aura-to` (dark, light and system-light blocks),
  `--dur-draw` 480 ms and `--dur-signal` 2400 ms, `--text-stat*`, `--text-display-lg*`, `--text-figure*`. `--dur-draw` collapses to
  0.01 ms in both reduce-motion blocks. The role colours `role-1..8` in tokens.json were not added: agents already carry
  their own role colour (team files, `roleColorFor`), which the redesign uses for marks and lines. [code]
- `styles/motion.css` gained the Draw and page-arrival recipes (`motion-draw-trace`, `-line`, `-wipe`, `-col`, `-grow`,
  `motion-arrive-hero`, `motion-arrive-band`, stagger capped at 6). `styles/instruments.css` holds `.hero-card` (one per page) and the plan
  gauge. [e2e motion, dashboard, usage-app]
- `lib/pageArrival.ts` + `lib/usePageArrival.ts`: arrival is staged once per navigation, skipped on return without a
  data change (a per-page data signature kept for the session), never under reduced motion or Pause motion, classes
  dropped after 800 ms. [unit, e2e dashboard and usage-app: classes present on first visit, absent on return]
- `lib/countUp.ts` + `lib/useCountUp.ts`: count up from zero over `--dur-draw` on arrival. Live changes tween over
  `--dur-slow`. Changes under 1% snap, and unknown never counts up and is never tweened from. [unit]
- `lib/gauge.ts` (arc paths, donut segments) [unit]; `components/limits/useLimitEntries.ts` and `PlanGauge.tsx`, shared by the
  Briefing and Pacing (max two gauges, "+N more", none for API keys or the mock; the arc and the percentage text both
  change colour with the level). [code; the mock reports no limits, so gauges were not seen in the app]
- `lib/dashboardLayout.ts` version 2 (sections week, pickup, upnext, projects, engagements, commits, todos; focus figure;
  `motionPaused`), with a version-1 migration (resume to Pick up, today to Up next and To-dos, working dropped, old default
  order to new default). [unit, e2e dashboard: corrupt storage, migration, storage event, reload]
- `store/useAppStore.ts`: `openUsage({ metric })` sets `usageFocus.metric`. [e2e usage-app, dashboard]
- `lib/usageDefinitions.ts` replaces the Definitions disclosure. [unit]

## What landed, per area

Dashboard (`views/DashboardView.tsx`, `components/dashboard/*`):
- The Briefing (`Briefing.tsx`, `NameControl.tsx`, `CustomiseBar.tsx`) has these parts:
  - the greeting in `--text-display-lg`, with the name only when saved;
  - the visible status sentence (`dash-greeting-brief`), with decision counts from the bell's source;
  - the since line (`lib/sinceSummary.ts`), including runs that were waiting on you when OrgAI closed;
  - quick actions: Continue <project>, New chat, New project, Customise;
  - Team pulse;
  - plan gauges;
  - the setup checklist line with its popover;
  - Pause motion, an `aria-pressed` toggle with a constant name.

  [unit sinceSummary, dashboardBrief; e2e dashboard]
- Team pulse (`TeamPulse.tsx`, pure `lib/teamPulse.ts`) is SVG and DOM only and is fed by `RunState.agents`, `roster` and `messages`. It is recomputed at most every 250 ms and has at most 12 nodes, with the rest folded into the caption. Lines trace and nodes pop on arrival. The signal dot moves with transform-only keyframes along the elbow's points, at most 3 dots. It imports nothing from Pocket Office or the Factory Floor. [unit 27+; e2e dashboard; review: offset-path input is numeric only]
- Needs you and Right now are fixed regions, drawn only with content. Inline answers are unchanged: Allow once and Deny only, and only when the whole request is visible. After the last answer, focus moves to the Right now heading or the status sentence and "Nothing else needs you." is said once. [e2e dashboard; review]
- Your week:
  - Four stat cards (`StatCards.tsx`, `lib/weekRecap.ts`), each one native button. Spend opens Usage on 7 days with Cost pressed; Runs opens with Runs pressed; Agent time and Decisions open the same period with no metric.
  - The 14 x 6 activity map (`ActivityMap.tsx`, `lib/activityMap.ts`) has one text alternative and a today footer.

  [unit; e2e dashboard and usage-app, including seeded multi-day history]
- Pick up (`PickUpSection.tsx`, `lib/resumeRows.ts`) is one list of runs, newest first. Each row has a state mark and a word; the cost is shown, or "Not priced"; the stop reason is shown when known. The single button is Continue or Open, and its name includes the run title. The list shows 4 rows (6 from 1280 px), then "Show N more". [unit; e2e dashboard, proposals]
- Up next (`UpNextSection.tsx`, `lib/upNext.ts`) reads the Schedules hook and has Pause all and Resume, with focus kept on the counterpart button. To-dos (`TodosSection.tsx`) is the to-do half of the old Today. [e2e dashboard, todos, todos-edge]
- Projects: pinned first, with an accent edge and a faint wash. The pin is a separate toggle after the tile in tab order. [e2e dashboard]
- Customise reorders and hides the seven arrangeable sections and sets the lead figure. It never lists Needs you or Right now. [e2e dashboard]
- There is one page-wide budget of 12 breathing marks. Right now's marks take it first, and Team pulse gets the remainder. [unit; e2e dashboard: at most 12 `[data-breathe]`]

Usage (`views/UsageView.tsx`, `components/usage/*`):
- Pacing (`Pacing.tsx`, `lib/usagePacing.ts`) has these parts:
  - the period spend as the page's one `--text-figure`, counted up on arrival;
  - the pace against the previous period at the same point;
  - a burn dial with a tick and a visible caption;
  - plan gauges.

  The projection rules from usage.md are pinned word for word in tests: "Projected", "Projection needs more data" under a fifth elapsed, and "Projection hidden: some usage is not priced". [unit; e2e usage-app]
- KPI band (`UsageSummary.tsx`): all four tiles are Tab stops, and no tile reads its value twice. The pressed tile has `aria-pressed` and a sliding bar. Definitions are `DefinedTerm` native-button toggletips. The "N of M priced" chip is kept. [e2e usage-app, motion]
- Spend over time (`SpendPanel.tsx`, `lib/usageAreas.ts`):
  - Stacked areas, with the largest series at the bottom, and unpriced usage hatched rather than drawn as zero.
  - The plot is one Tab stop, `role="slider"`. Left, Right, Home and End move the visible crosshair and tooltip, and `aria-valuetext` carries the same sentence. The hidden readout is retired.
  - Legend toggles, Compare, the Table view and CSV export are kept.

  [unit; e2e usage-app]
- Where it went (`BreakdownCard.tsx`, `RankedBars.tsx`, `lib/usageRibbon.ts`):
  - A proportional ribbon, top five then Other. It is `aria-hidden` and pointer-only (buttons with `tabIndex=-1`); the rows are the keyboard path.
  - Row bars grow on draw, and rows glide when they reorder.
  - The card is its own container and drops optional columns under 560 px, so there is no inner scroll at 1024x640.

  [unit; e2e usage-app]
- Efficiency has four measures, each with a reading: Cost per run, Overlap, Time to first report and No result. "Not enough runs yet" shows under 3 runs. Runs worth a look carries the reasons, each defined word a toggletip. Cost by tier is a donut (`TierDonut.tsx`) that writes "$X+" and "at least" when some runs are unpriced. [unit; e2e usage-app]
- Draw motion (`useDrawGen.ts`, `lib/usageDraw.ts`) runs once on arrival and once per filter or metric change the person makes. A background refresh never redraws. [unit; e2e motion, usage-app]

## Deviations from the spec, with reasons

- **D1: Engagements, Commits this week and To-dos are kept as optional Customise sections after Projects.** The spec neither kept nor retired them. This was the owner's decision, relayed by main, so nothing outside the Retired list was deleted.
- **D2: The activity map's link opens Usage on 30 days, not 14.** Usage has no 14-day period, and the filter bar is "unchanged" by the spec.
- **D3: Rolling periods (7 or 30 days ending today) show no projection.** A straight line to the end of today restates spend so far. The text reads "No projection for a rolling period". Calendar periods (this month, months) follow the usage.md rules exactly. Further texts the spec does not name:
  - "Projection hidden: older runs in this period are not loaded" (truncated);
  - "No projection: this period is over";
  - "Pacing needs the whole period: remove the day chip to see it" (a day chip is picked).

  usage.md should gain these.
- **D4: The burn dial is drawn only where a projection exists.** Its fill equals elapsed share by construction, so its caption says what the fill and the tick mean.
- **D5: Efficiency shows Cost per run, Overlap, Time to first report and No result,** following the preview. Cache hit and retries became run reasons. Tokens per turn remains only in the by-project table. The team timing disclosure (Tail, after the last report) was retired with More signals.
- **D6: Definitions with no label on the page were removed.** These were Tokens per turn, Waiting on you, Limit hold, Team vs Ask, Truncated and Legacy; the last two notes state their meaning in full.
- **D7: Needs you shows decisions only.** A run idle on a reply appears in the status sentence and Right now, not as a Needs you row; the old reply tiles are retired.
- **D8: Project tiles lost the hue band and working edge.** Order is pinned, then newest run; decisions no longer reorder tiles.
- **D9: Pick up lost "Open output" and "New run".** Its actions are Continue (resume for a paused run, the composer for an ended chain) or Open.
- **D10: Models, Roles and Connections rows in Where it went now take rank colours `chart-s1..s5`,** matching the ribbon.
- **D11: The greeting keeps "Hello" from 22:00 to 04:59, the existing rule, and has no full stop.**
- **D12: The Decisions card appears only when a run of the week carries `RunUsage.decisions`.** It shows a lower bound "N+" when some runs lack the count. The Customise option is disabled with a reason until then.

## Open items

- `lib/activityStrip.ts` `decisionsOf()` reads `RunUsage.decisions` through a local cast. Main added the field on dev; drop the cast once this branch is on dev with it.
- Not seen in the app, because the mock does not produce them:
  - plan and budget gauges;
  - setup popover rows;
  - Pacing "Projection needs more data" and the truncated text;
  - the Decisions card with real counts;
  - a 12-node Team pulse and deep trees (unit only);
  - month grain.
- Not verified at all:
  - screen-reader speech (names read from the DOM and Playwright aria snapshots only);
  - forced colours;
  - contrast measured in the app for the new aura and heat cells;
  - macOS;
  - the signal dot's look by eye.
- `lib/dashboard.ts` `projectAttentionOrder` is now used only by its test. `efficiencyItems` and `efficiencySummary` in `lib/usageEfficiency.ts` are still exported and tested but not rendered.
- Reviewer lows left:
  - L1 is resolved: the signal is transform-only now.
  - The `usage-breakdown.css` inner scroll is resolved.
  - The pre-existing literal 150 ms in `dashboard-band.css`, width transitions in `usage.css`, and the second `role="status"` (loading line) in UsageView remain.
- The "No result" chip in Runs worth a look duplicates the first reason (walk L5); kept because of an e2e check.
