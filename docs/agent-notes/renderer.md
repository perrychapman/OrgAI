# Renderer (general)

## Dashboard and Usage redesign (2026-11-21)

Spec: `docs/design/dashboard-usage-redesign/project/` (README, dashboard.md, usage.md, motion.md, components/*).
As built, deviations and open items: `docs/design/dashboard-usage-redesign/implementation-notes.md`. Renderer only.

- **Shared pieces:**
  - Tokens `--aura-*`, `--dur-draw` (0.01 ms under both reduce-motion switches), `--dur-signal`, `--text-stat*`, `--text-display-lg*` and `--text-figure*`.
  - In `motion.css`: the Draw recipes (`motion-draw-trace|line|wipe|col|grow`) and `motion-arrive-hero|band`.
  - In `instruments.css`: `.hero-card` and the plan gauge.
  - Arrival: `lib/usePageArrival.ts`, staged once per navigation and skipped on return without a data change.
  - Figures: `lib/useCountUp.ts`. The tween skips changes under 1% and never starts from unknown.
  - `lib/gauge.ts`.
  - `components/limits/{useLimitEntries.ts, PlanGauge.tsx}`, used by the Briefing and Pacing.
  - `openUsage({ metric })` sets `usageFocus.metric`.
  - `lib/usageDefinitions.ts`, used by the `DefinedTerm` toggletips.

  Checked by unit tests (pageArrival, countUp, gauge, dashboardLayout).
- **Dashboard layout and storage:** `orgai.dashboardLayout` is now version 2. It holds the order and hidden sections (week, pickup, upnext, projects, engagements, commits, todos), pins, the `focus` lead figure and `motionPaused`, and a version-1 value migrates. Working now and Waiting on you are fixed regions: they have no customise controls and are not in the layout.
- **Page regions (as built by the UI overhaul, see "UI overhaul: shell, Home and Inbox" below; this replaces the redesign's Needs you left / Right now right order):** `HomeHero` (the task box; none on first launch), the Briefing hero (`Briefing.tsx`), then Working now (`RightNowBand`, left) and Waiting on you (`NeedsYouRegion`, right), then the arrangeable sections. The work area is two columns from an 880 px `dash` container, and Pick up and Up next pair from 1280 px. Gutters sit on `.dash-inner` because a container query cannot change its own padding.
- **Page-wide breathing budget:** 12. Working now reports its count through the context, and Team pulse gets the rest (`pulseBreathBudget`).
- **Pause motion** (`dash-pause-motion`, constant name, `aria-pressed`) does four things:
  - sets `data-motion-paused`;
  - stops the breathing and signal loops;
  - suppresses page arrival;
  - draws the gauges at rest.
- **Startup appearance and page arrival (2026-11-21):** `main.tsx` renders at once; it must never wait for `settings:get`. A
  window that waited (commit 899d7394) subscribed to run events late, and a just-opened run window could take a trailing
  `run.usage` as a placeholder run stuck on `starting` (CI macOS `e2e/model-switch.mjs`, reproduced locally with a delayed
  settings reply). Instead `lib/theme.ts` applies a localStorage copy of the last saved appearance (`orgai.appearance`,
  written only from the settings reply and `settings:changed`) before the first paint, and `isAppearanceKnown()` gates the
  page arrival (`lib/pageArrival.ts` `stagesArrival`): no arrival before the saved Reduce motion is known, so only a first
  launch of a data dir whose settings reply lands after the Dashboard mounts skips it. In the store, a placeholder made by a
  non-status event takes its status, end facts and (if it holds none) transcript from the record in `fillSummary`
  unless a `run.status` event reached the window first (`lib/runPlaceholder.ts`). Checked by unit tests (theme,
  pageArrival, runPlaceholder), `e2e/model-switch.mjs` with a 650 ms delayed settings reply under the old gate (fails
  without the store fix, passes with it) and `e2e/dashboard.mjs` MO with a 400 ms delay.
- **Team pulse** (`lib/teamPulse.ts`):
  - It reads `RunState.agents`, `roster` and `messages`, with a 250 ms trailing recompute that publishes only on change.
  - Signals count only messages after mount within 4.8 s.
  - The dot is a transform-only keyframe walk over 17 points.
  - It imports nothing from Pocket Office or the Factory Floor.
- **Your week:**
  - Agent time is per run `max(0, wallMs - idleMs - waitingMs)`, and its definition names the difference from Usage's Wall time.
  - Decisions sums `RunUsage.decisions` from run rows; absent means unknown, and the figure is a lower bound when partial.
  - The activity map is pure `lib/activityMap.ts`.
- **Retired with their code, styles and tests:**
  - Dashboard:
    - the footer app facts;
    - the attention and reply tiles;
    - the hero stat tiles (`heroStats`);
    - the To set up list (now a popover);
    - the 14-day strip, WeekLedger, WeekShare and `projectShare`;
    - WeekLimits;
    - ResumeSection;
    - TodaySection and `scheduleRail`.
  - Usage:
    - the old stacked bars' metric morph (the UI overhaul brought stacked bars back as the plot shape, without the morph);
    - the hidden chart readout;
    - More signals and the team timing disclosure;
    - the Definitions section.
- **Usage, as built:**
  - **Pacing** (`lib/usagePacing.ts`): it uses the usage.md projection rules for calendar periods, and none for rolling periods.
  - **KPI band:** four Tab stops.
  - **Spend over time:**
    - stacked bars, one per bucket slot with rounded tops and a 2 px minimum (the UI overhaul, `impl-data.md`, redrew the redesign's stacked areas as bars; the stacking, crosshair and extent maths stay in `lib/usageAreas.ts` and the wrapper keeps `data-testid="usage-spend-areas"`);
    - the plot is one `role="slider"` Tab stop, and keyboard moves show the crosshair and tooltip;
    - unpriced usage is shown by `usage-spend-gap` and `usage-spend-lane`.
  - **Where it went:** the ribbon (`lib/usageRibbon.ts`) is `aria-hidden`, and the rows are the keyboard path.
  - **Cost by tier:** a donut.
  - **Draw generation:** `useDrawGen`, `lib/usageDraw.ts`, `data-draw` on the plot. It draws on arrival and on the person's changes only.
  - **Wording:** unknown cost reads "Not priced" across the page.
- **How it was checked:**
  - unit tests for every lib named above;
  - e2e (mock adapter, multi-day history seeded into each script's own throwaway data dir, never the mock adapter):
    - `e2e/dashboard.mjs`
    - `e2e/usage-app.mjs`
    - `e2e/motion.mjs`
    - `e2e/usage.mjs`
    - `proposals`, `todos`, `todos-edge`, `engagement`, `engagement2` and `layout` by the e2e engineer;
  - a Reviewer pass: its one High (stale e2e) and its Mediums M1-M7 were fixed;
  - mock UX walks, before and after: `docs/design/ux-review-dashboard-usage-redesign-{pre,post}.md`. Its Highs (focus after the last inline answer; keyboard crosshair not drawn) were fixed.
- **Unverified:**
  - screen-reader speech;
  - forced colours;
  - plan gauges, setup popover rows and real decision counts in the app;
  - macOS.

## UI overhaul: shell, Home and Inbox (2026-11-22)

Design: `docs/design/ui-overhaul/` (status per board in `STATUS.md`). Notes: `impl-foundation.md` (tokens, primitives,
cards), `impl-shell.md`, `impl-project-home.md`, `impl-data.md`. Where a note and the code disagreed, the code wins and
this section says what the code does (checked by reading it on dev 2026-11-23). The Live run view has its own section
below, "Live run view (UI overhaul)". Fixes after the first pass (walk findings, review rounds) are listed under "Later
fixes that change the notes above".

- **Foundation.** Glass tokens, the new palette, bundled Space Grotesk and the `data-glass` / `data-text-size` /
  `data-density` / `data-activity-dots` switches are in `.orgai/ARCHITECTURE.md` "Theme layer". Shared pieces: `ui/Chip`
  (native `aria-pressed` button, class `ui-chip`), `Banner live`, `SettingsGallery`, `.kbd-hint`, motion classes
  `.motion-pulse / -breathe / -flow-v / -flow-h / -sheen / -lift / -rise`. Known limit: the tray's breathing dot stops
  only under reduced motion, because only the Home page sets `[data-motion-paused]`. `--panel` is still `--surface-1`;
  the boards' `--panel` means `--surface-2`. Decision cards: one look, amber kind chip, "Review and merge" / "New tool".
- **Shell.** Sidebar order: Search (`sidebar-search`, Ctrl/Cmd+K), Home (`nav-home`), Inbox (`nav-inbox`, amber
  `nav-inbox-count`; the Needs-you popover stays as a bell beside it), Chat, a "Helpers" group (Tools helper, Skills
  helper), Projects with `+` (`nav-new-project`), footer Usage, Schedules, Settings (`app-settings-button`) and the plan
  account row (`auth-pill`). `layout/CommandPalette.tsx` + pure `lib/commandPalette.ts`: groups This project, Open runs,
  Go to, Projects, Create; it calls the store paths the sidebar rows call. Ctrl+K is in the shortcuts table
  (`src/shared/view/shortcuts.ts`, so the impl-shell open item is closed). `layout/AppBanners.tsx`: offline, sign-in
  needed, update ready. Project header: a kind chip and `project-settings-button`; `<main data-kind="engagement">`.
  Tab ids and test ids are kept (`tab-outputs` reads "Files"); a project opens on Live, not Home, because every area's
  e2e expects the composer after `nav-project`.
- **Sound.** `lib/sound.ts` (pure `chimeDecision`), `lib/useAttentionSound.ts` mounted once in `App.tsx`: a two-note
  WebAudio chime when a new decision key appears, never for decisions already waiting at start or when the switch turns
  on, at most once per 4 s; `<html data-chime-count>` mirrors the count for e2e. Every window that renders App chimes for
  its own runs (a run window too). Checked by `sound.test.ts` and `e2e/connections.mjs` (off by default, no chime).
- **First launch.** `components/dashboard/FirstLaunch.tsx` + `lib/welcome.ts`: three steps (`welcome-setup`,
  `data-stage` 1 to 3), Back / Skip setup / focus to the step heading, then the start choice. Step 1 lists the real
  connections with their real status (a connected pick becomes the default through `setDefaultConnection`); step 3 saves
  one of three real modes through `settings:set`. No API-key or gateway cards, no "Recommended" badge. `e2e/lib.mjs`
  `launch()` marks setup done unless `welcome: true`; `layout.mjs` W1 to W4 walk the steps.
- **Home** (`views/DashboardView.tsx`, view id `projects`, h1 "Home"; replaces the redesign's Needs you left / Right now
  right order): `HomeHero` task box (target chip: a stored project or Chat; scope and permission chips; the one primary
  "Start run"; "Try" starters that only fill the box; never sends: it opens the project's New run page with the task as
  the draft, or a new Chat with it as the seeded instruction), `Briefing`, then Working now (`RightNowBand`, left) beside
  Waiting on you (`NeedsYouRegion`, right), then the arrangeable sections (Your week, Pick up, Up next, Projects,
  Engagements, Commits this week, To-dos). The two columns are fixed, show an EmptyState when idle and are not in
  Customise. Layout storage and Pause motion are as in the redesign section above.
- **Inbox** (`views/InboxView.tsx`, `components/inbox/`, `lib/inbox.ts`, store view `inbox`, e2e checks at the end of
  `dashboard.mjs`): rows from the same `waitingItems` the badge and popover count, plus team-files items and runs finished
  since the last visit; filter chips per kind present (Permissions, Questions, Reviews, Proposals, Other, Finished); the
  selected row shows the run view's own decision card. **Key guard** (`KeyGuard`, `guardPress / guardRelease /
  guardArrive / guardSwallows`): Enter on a row only moves focus; Enter and Space are swallowed in the detail pane until
  the key that was down at arrival is released plus a short dwell; a repeating keydown never presses a card button;
  after an answer focus goes to the next row. `scripts/e2e-select.mjs` now maps Inbox, project Home, palette and banner
  files to `dashboard` / `runs` / `proposals`, `per-project` / `engagement` / `engagement2` and `layout` / `updates`.
- **Project Home tab** (`views/ProjectHomeView.tsx`, `components/home/`, `lib/projectHome*.ts`, `styles/home.css`,
  `e2e/home-checks.mjs` called from `per-project.mjs`, `engagement.mjs`, `engagement2.mjs`): `CodeHome` and
  `EngagementHome`. Data comes from `gitInfo.summary` (repo strip, health, merged lately; feature-detected, so a build
  without it leaves those lines out), `runInsights.scheduleHistory` (the schedule outcome bar without clearing unread),
  `runInsights.projectSpend` ("spend this month", "of $X a month" from the monthly cap only, a projection and a typical run once 3
  priced runs exist), the run store, schedules, to-dos, outputs, knowledge and `mcp.list`. Corrections to
  `impl-project-home.md` (written before those contracts landed): the git calls are `window.orgai.gitInfo.*`, not
  `projects.gitSummary`; the nightly bar and the spend section exist; "Spend this month" now has a limit line from the
  project's monthly cap (no bar), because `maxMonthlyUsd` exists. Still not built: "tests passing" and "Dependencies up to date" (not recorded).
  Start boxes never start a run (`mergeDraftText` adds to the draft). A connection is never called "Connected".
- **Files / Knowledge / Usage / History / Schedules / To-dos** (`impl-data.md`): glass tiles; Files sort select
  (`outputs-sort`, `localStorage['orgai.outputsSort.<projectId>']`); Knowledge graph limit above 75 items (the 60 most
  connected, "Show all" kept per project) and the toolbar line "The team is working" with a recorded count while a run of
  the project is working (`lib/knowledgeRecording.ts`, rendered in `KnowledgeView.tsx`; impl-data first said it was not
  built, it is); Usage "Spend over time" stacked bars (see the redesign section) and `RunStatusMark`; History agent strip
  (`useAgentStrip.ts`, lazy, three at a time), merge words, "What it left" and "Try again" (inline confirmation naming the
  project and request, acts on key-up, ref guard, `runActions.retry`; `runs.retryRun` is real in main now, impl-data wrote
  it was a stub); Schedules week strip (`lib/schedulesBoard.ts`), per-row `Switch` named "<name>, on/off" and a read-only
  detail. Not drawn because not recorded: per-file +/- counts, step durations; "Undo the merge" is not built (owner
  decision).
- **New run page** (`components/NewRunPage.tsx`, `components/newRun/`, `styles/new-run.css`): settings tiles (Model,
  Effort, Permission, Goal, Spending limit), `WhoWorksPanel` (a checkbox per group leaves it and everyone below it out
  via `StartRunInput.excludeRoleIds`; the estimate for that team from `runInsights.estimate`, hook `useRunEstimate`),
  `PickUpList`, the one Start and "save as a schedule". `SpendLimitControl` sends `maxBudgetUsd` and refuses a figure above
  the project cap with the reason. A wider permission mode at Start asks first (`wideningConfirmOptions`).
- **Checked by:** unit tests beside each lib; e2e `layout` (W1 to W4), `dashboard`, `per-project`, `engagement*`,
  `assistants`, `updates`, `folder-trust`, `connections` and the area scripts named in each impl note, all on the mock
  adapter. **Unverified:** screen-reader speech anywhere in the overhaul; macOS and Linux; both themes and both sizes by
  eye for every screen (screenshots were taken per area, not per board); the Home git strip against a real repository;
  live providers.

### Later fixes that change the notes above (read on dev 2026-11-23)

- **Mode names.** The screens that name a permission mode (Home task box, run settings control, Settings mode cards and
  Permissions page, the settings proposal card, first launch step 3) read it from `lib/permissionWords.ts`
  (`PERMISSION_TITLE`, `permissionWords`): the first pass had four different names for the same modes (UX walk H3). The exact engine name is
  secondary text. Engagement screens use neutral words (no client / sponsor / deliverable; the stored `Project.client`
  field is plain data), and the interview wording in main is neutral too.
- **Spending limits.** The per-run, per-day and per-month limits, "When a limit is reached" and the app-wide warning all sit
  at rest in the pane on every sign-in (`LimitsSection.tsx`, `limitCopy.ts`; `e2e/limits-checks.mjs`). `impl-settings.md`
  still says day and month caps sit in Advanced on a plan sign-in: that is out of date.
- **Files** opens in Grid when the project has no saved choice (`readViewMode(null)` is `'grid'`); the saved per-project
  choice wins. `impl-data.md` says List is the default: out of date.
- **Knowledge "Recorded by"** is one exclusive choice, Everyone / You / Team, over the origin filter (`KnowledgeFilters.tsx`;
  `knowledge-origin` test id and `data-origin` all / user / agent kept). `impl-data.md` says it "stays chips".
- **Team assistant fold.** `TeamAssistantTray` remembers the user's last fold choice across tab switches in a module
  variable (`lastFold`): not saved to disk, so a restart follows the window size and results again.
- **Proposal next step.** It is `proposals/ProposalNextNote.tsx`, a note row above `.run-body`, not a chip in `RunMeta`
  (test ids `proposal-next-note`, `proposal-next-lead`, `proposal-next-deferred` kept). `layout.css` still holds an unused
  `.run-meta-next-list` rule.
- **Home "Start run"** still opens New run with the text and never sends. "Save as a schedule" carries what a schedule can hold
  (model, permission mode except Bypass, limit, single) and names what it could not carry (`scheduleSeed`,
  `schedule-not-kept-note`); the Inbox focuses its first row on arrival (J / K work); a fresh Enter on a row always moves focus into the card, except
  while the key that opened the Inbox is still down (the hold ends at its key-up through `keys.whenReleased`, not on a timer; a
  held key's repeats are always swallowed), and J / K / Esc move row focus at once (a pending animation frame once undid a fast
  Enter; checked by `e2e/dashboard.mjs` IBR1 with the frame held back 300 ms, which failed before). It names the teams with a run going when empty; Home "Your week" says "No prior data" instead of growth from zero; History
  has separate "Run it again" (opens New run) and "Try again" (continues a failed run, confirms first) with a line under each.
- **Team tab.** The selected-role toolbar stays inside the visible chart and is the next Tab stop after its role; a new role
  is panned into view; Add group opens "Add group lead"; the header shows the Theme control compactly at 1024; the zoom
  readout buttons disable at the limits. The Theme menu still has one item. The "Review with the Architect" confirm that
  clipped its cost sentence (walk H1) was not re-checked.

## Live run view (UI overhaul)

Spec and notes: `docs/design/ui-overhaul/impl-run.md` (dock, hold, focus), `impl-run-header.md` (strip, chips). Where an
older line in those files disagrees with this section, the code was read and this section follows it. Checked on the mock
adapter by `e2e/run-hold.mjs`, `runs.mjs`, `run-start.mjs`, `canvas.mjs`, `model-switch.mjs`, `live-changes.mjs`,
`layout.mjs` and unit tests (`runHold.test.ts`, `agentFocus.test.ts`, `canvasAgents.test.ts`, `decisionCard.test.ts`).
Not checked: screen-reader speech, a run with 121 agents (the mock's largest is 40, `[mock:factory-floor]`), forced colours,
macOS, live providers.

- **Dock.** `.run-body[data-dock]` is `open`, `hidden` or `rail` on canvas-layout runs. It is computed in `LiveRunView.tsx`
  from the `SidePanel` report (`noRoom`, `auto`, `collapsed`): `rail` when there is no room (about 560 px) or the panel is
  auto-folded, `hidden` only when `collapsed` is the user's own saved choice, else `open`. **Only the user's Hide hides the
  composer** (saved as `orgai.sidePanel.run`; an earlier rule that auto-hid it below 1100 px was removed). Under 900 px
  (`DOCK_AUTO_HIDE_BELOW`) with no saved choice the panel is the 40 px rail (`autoAsRail`), the composer, settings row and
  `LiveModelSwitch` sit under the canvas, and the toolbar "Conversation" button (`dock-show`) opens the dock and saves "open".
  The width alone saves nothing; the fold is measured 120 ms after the last window resize and reverses when the grid grows
  past 900 px. The composer region is one mounted element in every state, so the draft, focus, the model switch and scroll
  survive. Hide moves focus to `dock-show`; keyboard show moves focus to the composer, a mouse click does not. A decision
  answer, History's Continue, the plan strip and Find an agent show a hidden dock first. Unread dot and "(new)" for a root
  reply or decision that arrived while hidden. Chat, setup, Tools helper and Skills helper keep the conversation-first layout.
- **Stage.** What stays on the stage under the canvas: the decision tray and `RunHoldCard` (dock shown or not) and the
  `PlanStrip` in the frame footer; compact tray threshold 570 px. The decision tray stays so a hidden dock never hides a card.
- **CanvasThemeMenu.** Replaces the presentation radios (same `saveCanvas` setting), Live only. It is the scene switch of
  the canvas toolbar: swatch and the scene's name (the trigger's name is "Canvas theme: Org chart"), name dropped when the
  plan says compact, the whole group hidden under 320 (then App settings > Canvas).
- **Canvas toolbar declutter (2026-11-24, `docs/design/canvas-toolbar-declutter.md`).** `lib/canvasToolbar.ts`
  (`planToolbar`, pure, `canvasToolbar.test.ts`) decides which controls the 32 px row draws and in what form; LiveRunView
  measures the run frame (ResizeObserver, 8 px steps, read in a layout effect so no wrong form paints) and renders the plan.
  Row: scene switch (CanvasThemeMenu), Find (icon button, only with more than 5 agents), the Show filter and Zoom out / Zoom in
  (only from a 1100 px frame, else in the View menu), Fit, `CanvasViewMenu`, then after a separator the Conversation button
  (`dock-show`, dock hidden or rail) or the layout toggle (`run-layout-toggle`; while the dock is hidden it sits in the View
  menu, so there is one speech-bubble button, not two). **View menu** = the old Canvas style popover under the same test ids
  (`canvas-style-button` trigger, `canvas-style-popover` panel, now named "View options") with rows above: Find, Show,
  zoom steps, layout toggle, Hide finished agents (`view-fold-row`, label `view-fold-label` carries the count; the switch is
  still the `Hide finished agents` switch), then a Canvas style row (`canvas-style-disclosure`, the seven presets fold behind
  it), the legend (`canvas-legend-trigger` / `canvas-legend`, a disclosure now, not a popover) and More canvas settings.
  Focus enters on the first row (`ViewRows`), not on the checked preset, so the rows are not scrolled out of sight. e2e:
  `openViewMenu(page)` in `e2e/lib.mjs`; `showFinishedAgents` goes through it. A control is in exactly one place (unit
  tested), and the View menu button and its zoom / Fit hide with the stage while an expanded proposal collapses it
  (`layout.css`). Pause motion stays in the Pocket Office log head and the Factory floor control row (scene-owned).
- **AgentFilter / Find / AgentList.** `AgentFilter` (All / Working / Waiting, counts, "N of M agents shown") dims other
  nodes with `.node-dim` (0.35 opacity), never hides. Find an agent opens the Agents tab (`openAgentFinder`): search, sort
  and the flat `AgentList` ("Showing 40 of 40" on the mock). Scenes keep their own Find and filter; the org-chart Show
  filter, Find and "Hide finished agents" render on the org chart only.
- **PlanStrip.** Segments from the run plan; opens the Plan tab (shows a hidden dock first). Reporting edges carry
  `edge-done` / `edge-live`. The coral segment of an engagement run is visible only while a step is in progress and was
  not seen.
- **RunHoldCard.** Replaces the pause, plan-blocked and run-error banners (classes `pause-banner`, `plan-blocked-banner`,
  test id `run-error` kept; `lib/runHold.ts` is the pure copy). Add budget, Skip review, Try again and Continue ask through
  a confirmation naming the amount, the gate or the fact that a new provider turn can spend; focus starts on Cancel, so a
  held Enter never confirms; one in-flight guard covers every action (double activation, key repeat); a refusal from main
  shows inline; Resume now does not ask; Use another model focuses the model switch. One polite announcement per hold
  through the frame announcer (quiet on remount). The card is tall at 1024x640: the tray scrolls and the action row is sticky.
- **AgentFocus.** One agent on the stage (org chart layout), from "Open agent view" or a double click; Escape or "Back to
  chart" closes and focus returns to the opener (found by test id after a re-mount). Shows Time (`formatElapsed`, "so far"
  while working); message and stop one agent go through `runActions` (live `stopTask` / `turn/interrupt` unverified).
- **Run header** (`RunTabs`, `RunMeta`, `RunActions`; `run-header.css`, `run-tabs.css`). **Fold order** (`useMetaFold`,
  `data-prio`, highest number first, ties the later chip): fact chips fold first; then chips that hold a button (a count
  that opens a tab, a link), which stay reachable from the "more" menu (`run-meta-more`) because the menu button calls the
  original and keeps its test id; then, when only status, permission mode and cost are left, the status word shortens to an
  ellipsis (`data-squeeze`), the permission mode (`data-compactable`) shortens to its icon (words stay in its name and title)
  and only then does cost fold. Status (`data-prio` 0) and the permission mode never fold. `impl-run-header.md` said cost
  folds second to last; the permission mode now shortens first. **Transitions are off on the meta row**
  (`transition-property: none`): under reduced motion `global.css` gives every element a 0.01 ms transition and with `all`
  and `interpolate-size` it animated width, so the line was measured mid-transition and a chip that did not fit read as
  fitting (found with the permission chip at 1024 px). Folds that keep replacing each other stop after six changes in 200 ms.
- **ProposalNextNote.** Renders in `LiveRunView.tsx` above `.run-body`, never folds, so the result of an approved proposal
  and its one next step are visible without opening anything.
- **DecisionCard focus rule** (`typingElsewhere`, `DecisionCard.tsx`): a card that mounts while focus is in a text field outside
  it (input, textarea, contenteditable, the composer empty or not) never takes focus (a Send empties the composer just
  before a permission card can arrive, so "Allow once" used to sit under the Enter key); a card that mounts while a key is
  held waits for the key-up and takes focus only if focus is nowhere. The tray still announces it; Tab, a click or the
  Needs-you jump reach it. The end of `e2e/runs.mjs` checks it.
- **Composer.** Enter and Ctrl+Enter send once per press: a repeat, or an Enter that went down before the field had focus
  (it opened the page or pressed a button that moved focus), does nothing (`enterDownElsewhere`).
- **New run one-shot mode.** `store.newRunMode` (`team` or `ask`, with a project id) is applied once by `NewRunPage`
  (`takeNewRunMode`) and is not written to the remembered per-project choice.
- **Engagement runs.** `.run-view[data-kind='engagement']`: serif headings, coral selection and plan accents (the selected
  agent ring is drawn in `--eng` by `run-header.css`), neutral wording; no Context screen and no per-run source picker. The
  engagement run was looked at on the mock (2026-11-23).
- **Deviations from the boards.** The dock is a right-hand column against the window edge, not a floating card (a margin
  would break the resize handle's width arithmetic); the org chart stays the React Flow node chart, not department boxes;
  the settings row is one scrolling line in the dock, so the composer is cramped at 1024x640 (placeholder clipped); no dock
  shortcut in `shared/view/shortcuts.ts`.
- **Open.** Reduced motion for the dock was checked as end states only; the minimap did not render in the 1024 and 1600
  looks of the 40-agent run; `layout.css` `.run-meta-next-list` is unused; a run with many chips folded (staffing,
  recorded, revision, schedule together) and forced colours were not looked at.

## Factory Floor, slice 1 (2026-11-19)

Spec and implementation notes: `docs/design/factory-floor.md`. Live only (owner decision 2026-11-19): `LiveRunView`
mounts `components/canvas/factory/FactoryScene.tsx` when the presentation is `'factory-floor'`; `TeamView` keeps the
Graph and was not edited. Slice 1 is the dependency (three 0.187.0), the contract, an empty hall (floor, walls, gantry,
booth box, lights, both themes), render on demand, context loss and restore, dispose, the floor plan fallback, the
section 8 notices and the test state (`<output hidden data-testid="factory-state">`, JSON, written at most every
500 ms, so poll it). Stations, robots, layout, camera input and keyboard navigation come in slice 2.

- Developer switch (not user-facing): `localStorage['orgai.factory.renderer']`, read when the scene mounts: `floor-plan`
  forces the floor plan (reason `forced`, no notice); `no-webgl2` shows the "3D view unavailable" notice; `chunk-failed`
  shows "3D view did not load" (Try 3D again keeps failing while the key is set). Anything else is ignored. Used by
  `e2e/factory-floor.mjs`.
- `e2e/factory-floor.mjs` launches with `--use-angle=swiftshader --enable-unsafe-swiftshader` (only in that script;
  `E2E_FACTORY_SWGL=0` uses the machine's GPU). On this Windows machine both give a WebGL2 context that passes
  `failIfMajorPerformanceCaveat`; GitHub runners are unverified.
- Checked: `lib/factory` unit tests (capability, snapshot, boundary), `e2e/factory-floor.mjs` 54/54 on SwiftShader and
  on the RTX 3060, `e2e/canvas.mjs` and `e2e/office.mjs` unchanged, screenshots in
  `docs/design/factory-floor-shots/slice-1/`. Unverified: the packed asar app, screen-reader speech, macOS and Linux.

## Factory Floor, slice 2 (2026-11-20)

Layout, procedural kits, camera input, mirror keyboard, labels, Find a worker and the control row are wired (spec
"Implementation notes, Slice 2"). Facts for the next slice:

- Kits: `FactoryCanvas.tsx` passes `factoryKits` from `builders/index.ts`; the placeholder kits are gone. The engine
  reports real heights through `onHeights`; `FactoryScene` bumps a version so label anchors recompute.
- `cameraController.ts` (beside the components, not under `lib/`) owns pointer, wheel, key and tween input for both the
  3D view and the floor plan; the maths stays in `lib/factory/camera.ts`. The floor plan has its own zoom limits
  (`PLAN_LIMITS`: zoom 12 to 60, fit 22 to 40 px per metre) so tiles keep their text.
- Nameplates anchor 0.75 m north of the station centre (booth 1 m) at the kit's plate height; line signs end at the head
  zone's east edge and grow west (`align: 'end'` in `FactoryLabels`), so neither covers a station.
- Software WebGL (the e2e default) runs at quality `minimal`: far LOD and no shadows at every zoom. Look at the scene
  on the GPU (`E2E_FACTORY_SWGL=0`) before judging art.
- A new decision card takes focus on mount (`DecisionCard`'s existing auto-focus). The `[mock:factory-floor]` tour's
  background permission ask arrives after the floor is complete, so `e2e/factory-floor.mjs` waits for the card before
  its 40-agent keyboard walk.
- Machine variants follow `stableHash(roleSlug) % 4`; the default team's roles give variants 1, 2 and 3 only
  (orchestrator and implementer 1, reviewer 2, researcher 3), so variant 0 (press) has not been seen in the app.
- Checked: `e2e/factory-floor.mjs` 147/147 on SwiftShader and on the RTX 3060, 142/142 with `E2E_FACTORY_PLAN=1`;
  `e2e/canvas.mjs` and `e2e/office.mjs` pass; screenshots in `docs/design/factory-floor-shots/slice-2/`.

## Factory Floor, slice 3 (2026-11-20)

Live state in static end states (spec "Implementation notes, Slice 3"). Facts for slice 4:

- `lib/factory/model.ts` `buildFloorModel(input, layout, needsYouIds, plan, runStatus, mode)` is the only place state is
  decided (lamp, pose, shutter, barrier, fence, crate, step chips, board, dock count, hall, earlier sessions). The engine
  (`EngineFloor = { model, selectedId }`), the mirror, the labels and the test state all read it. `factoryAgent` in
  `agentView.ts` maps an `AgentInstance` (moved out of `LiveRunView`).
- Engine: `engine/poses.ts` (seven poses, per-part matrices about the robot kit's pivots) and `engine/floorInstances.ts`
  (every pool's instances from the model; pure apart from three maths, unit tested with hand-built models). Optional kit
  methods (`shutter`, `barrier`, `fence`, `crate`, `holdPad`, `boardLamp`, `boardLampColour`) and station anchors
  ('pad', 'hold', 'inbox', 'robot.machine', 'robot.dispatch', 'robot.rest', 'robot.dock') are the builder contract in
  `builders/types.ts`; a missing kit is skipped.
- Mirror hooks added: `data-pose`, `data-status`, `data-fenced`, `data-crate`, `data-steps`; `factory-plan-board` button
  (`data-total`, `data-done`, `data-blocked`); `factory-dock` `data-count` (both renderers); `factory-scene` `data-hall`.
  Nameplate `data-status` is the shown word ("Paused" on the booth while paused); the mirror's is the model word.
- Focus pan (`lib/factory/camera.ts` `panIntoView`): a footprint far off the stage, behind the camera or straddling its
  plane is first centred, then converged. Before this, focusing a station many rows away at near zoom panned to the
  hall clamp and showed an empty view (found on the slice 3 screenshots; unit tested).
- Screenshot driver used for `docs/design/factory-floor-shots/slice-3/` was a temporary script (not in the repo): near
  views come from focusing a worker button after zooming with `+`.
- Checked: factory unit tests, `e2e/factory-floor.mjs` in all three modes, `e2e/canvas.mjs`, `e2e/office.mjs` (counts in
  the spec notes).

## Factory Floor, slice 4 (2026-11-20)

Cues and motion (spec "Implementation notes, Slice 4"). Facts for later slices:

- Timing lives only in `lib/factory/motion.ts` (every section 5 number, `ambientSet`, `ambientWave`, `cueEase`,
  `motionSession` for Pause motion: module-level, never saved). `lib/factory/cues.ts` owns what moves: `diffCues(prev,
  next, cursor, now)` (prev null = mount or run id change: baseline only, nothing cues or logs) and `CueScheduler` (caps,
  coalescing, `cancelFor`, `finishAll`, `recent`, `peaks`; pure, fixed-clock tests). `lib/factory/floorLog.ts` has the
  log templates (cap 50) and `AnnounceGate` (one per 2 s). None of it imports three or anything from Pocket Office.
- `FactoryScene` holds one scheduler per mount and run id, pushes cues only in live mode with motion 'full', and calls
  `finishAll()` on Pause motion, reduced motion, a paused or ended hall (then pushes only the hall cue), hidden document,
  off-screen stage and unmount. The engine reads a `CueFeed` (types.ts); `engine/cueRender.ts` overlays the active cues
  and ambient loops on the `floorInstances` end-state lists each frame (hides the child station while its tote flies, a
  dock crate until it lands). Fades are by scale (shared materials have no per-instance opacity).
- Render loop: 0 frames with nothing active; ambient-only frames at most one per 30 ms (about 29 fps measured); reduced
  or paused motion renders on demand only. `KitPool` compares float32 colours with a 1e-6 tolerance and `setView` skips
  an unchanged view (both used to render a frame on every model change).
- Test state adds `recentCues` (last 40 pushed), `cuePeaks` (carriers, perSender, parts, crates, arrivalsPerSecond,
  ambient), `logEntries`; `workers[].ambient` is the loop running now. Read short cues from `recentCues`: the state is
  written at most twice a second (and on every push).
- e2e: gated scripts (a root Bash `ask: true` tool step holds the run while the scene mounts; Allow releases the events);
  windows that expect no frames or no cues wait for a quiet model first (the mock keeps changing lamps for 1 to 2 s after
  its last marker). The floor log's "assigned" line names the child by its label at first upsert, which in the mock is
  the role name ("Implementer"), not the handle.
- Screenshot and measurement driver (not in the repo; `e2e/shots/` is gitignored): stage a team before the gate, press
  Fit, Allow, then shoot when the test state lists a cue kind (wait 250 to 900 ms into its flight).

## Factory Floor, slice 6 (2026-11-20): hardening and sample

Spec "Implementation notes, Slice 6" and "Final summary". Facts for whoever touches the scene next:

- Developer key (not user-facing): `localStorage['orgai.factory.renderer']`, read at mount; `floor-plan` forces the floor
  plan (reason `forced`), `no-webgl2` and `chunk-failed` force those notices. Any other value or a storage error is
  ignored (`capability.ts`). The Reviewer judged it harmless.
- Fallback decision is pure: `lib/factory/fallback.ts` `factoryReason` (forced > no-webgl2 > too-many > context-lost >
  chunk-failed; too-many is more than 120 current-session agents, earlier sessions do not count), `noticeCopy`, and
  `ContextLossWatch` (5 s restore timeout, third loss in 10 minutes). Context loss can be driven from a test through the
  canvas's own `WEBGL_lose_context` extension; no app hook exists.
- Quality steps: `lib/factory/quality.ts` (`createQualityGovernor`, `qualitySettings`). The engine feeds it display-frame
  intervals while animating (cues, ambient, camera tween) and skips the interval in which `setFloor` ran (a model change
  carries the host's React commit, which a lower quality cannot shorten; without that skip the 40-agent arrival burst
  stepped an RTX 3060 to low once). Steps are applied in place (pixel ratio, shadow map size or off, far LOD); MSAA stays
  as created. Test state: `quality` is current, `qualityStart` the probe's choice; `perf.memoryBytes` (own DataTextures plus
  the shadow map, width x height x 4) and `perf.pixelRatio`.
- Test state carries no agent text: the message cursor is `at|from|to|#<fnv hash>` (it used to hold 32 characters of the
  message); a unit guard in `snapshot.test.ts` walks every string.
- `FactorySceneHandle.focusFind()` backs "Load earlier sessions" (LiveRunView calls it, then falls back to a query).
- Nameplates hide for stations the cue layer hides (`lib/factory/cueVisibility.ts`, full motion only), so a child's plate
  appears when its tote lands.
- A focused worker that leaves the floor moves focus to the tab stop instead of the page body; a paused booth's accessible
  name uses the shown word "Paused".
- Settings sample: `FactorySample.tsx` is one `<img data-testid="factory-sample-image" data-sample-theme>` per the html
  `data-theme`, inside `role="img"` "Static sample factory floor". The PNGs are rendered from the real scene by
  `node scripts/render-factory-sample.mjs` after `npm run build` (needs a GPU, run by hand); carriers art is checked in an
  offscreen harness, `node scripts/render-factory-carriers.mjs --tag after`.
- e2e switches of `e2e/factory-floor.mjs`: default SwiftShader launch switches (that script only); `E2E_FACTORY_SWGL=0`
  machine GPU; `E2E_FACTORY_PLAN=1` floor plan throughout; `E2E_FACTORY_PERF=1` asserts the section 9.1 timing targets
  and prints `PERF` lines (use with `E2E_FACTORY_SWGL=0`; the interval is the page's rAF p95 over the burst's first 5 s);
  `E2E_FACTORY_WAIT_MS`, `E2E_FACTORY_DEBUG`. The script drives 122 agents through 121 scripted mock spawns for the Large
  team notice (3D path only).
- Verified on Windows 11 with an RTX 3060 and SwiftShader only. `npm run pack` cannot run inside a worktree (no
  `node_modules` there and installs are not allowed), so the packed asar app stays unverified.

## Context menus (2026-11-18)

Contract and evaluation table: `docs/design/context-menus.md`. One primitive, `components/ui/ContextMenu.tsx`
(`useContextMenu<T>()`, `<ContextMenu>`, `<MenuButton>`), pure rules in `lib/contextMenu.ts` (placement, roving index,
type-ahead, `isMenuKey`, `nativeMenuWins`; unit tested in `lib/contextMenu.test.ts`). No dependency, no new IPC.

- Surfaces: run tabs (`RunTabs.tsx`, testid `run-tab-ctx`), Knowledge rows (`KnowledgeList.tsx`, `knowledge-row-more`,
  handled on the listbox; `KnowledgeRow` no longer has `onMenu`), Dashboard tiles (`ProjectTile.tsx`,
  `project-tile-menu`, More button `project-tile-more`; was a `Popover`), sidebar project and open-run rows
  (`nav-project-menu`, `nav-run-menu`), History rows (`history-menu`, visible `history-more`; Save as project and
  Retrospective moved into it), schedule cards (`schedule-menu`), Outputs list rows and grid tiles
  (`useOutputRowMenu` in `OutputsList.tsx`, `output-row-menu`, off in select mode), org chart nodes (`TeamView.tsx`,
  `role-node-menu`). `usage/RankedBars.tsx` keeps its own row menu.
- Item testids that e2e and helpers rely on were kept: `project-tile-new-run|continue|open-folder|delete`,
  `knowledge-row-edit-note|retire`, `history-save-as-project`, `history-retro`.
- Rules the code depends on: the panel is `popover="manual"` and only mounted while open (e2e waits for
  `[data-testid=...][role=menu]`); it unhides (`data-placed`) before focusing, since focus on a `visibility: hidden`
  element is a no-op (found by e2e: menus opened with focus left on the row); it closes on a wheel event outside, not
  on `scroll` (focusing the tab scrolled `.run-tablist` and closed the tab menu in about half of the runs); a keyboard
  open ignores the platform's `contextmenu` echo for 600 ms unless a pointer press came after it (without that
  condition a real right click right after Shift+F10 and Escape was swallowed, found by `e2e/team.mjs`); an invoker that cannot take focus falls back to
  `fallbackFocus`; a menu whose target disappears closes itself.
- Reduced motion (2026-11-21): the global rule in `global.css` sets `transition-duration: 0.01ms !important` on every
  element, so an element with no transition of its own (initial `transition-property: all`) transitions everything,
  including the `visibility` it inherits. The menu's items stayed hidden through the synchronous unhide-then-focus:
  focus stayed on the invoker, Escape did nothing and the text read empty. `ui.css` sets `.ctx-menu * {
  transition-property: none }`. Found from red CI on `e2e/dashboard.mjs`: its MO block ends with
  `emulateMedia({ reducedMotion: null })`, which hands the page from Playwright's forced no-preference to the runner's
  own setting (reduce on the CI runners, inferred from the failures). Reproduced locally with
  `--force-prefers-reduced-motion` and with emulateMedia, and at the pre-redesign head a1743b35 too (so the bug was there
  already). `e2e/context-menus.mjs` now opens the tile menu under both the OS and the app setting. Any other "unhide, then
  focus in the same task" code under a reduced-motion rule has the same hazard; `Popover` waits a frame and is not affected.
- A real right click in a field, on a link or over a selection pops the native menu from main
  (`src/main/textContextMenu.ts`); e2e cannot dismiss it, so `e2e/context-menus.mjs` dispatches `contextmenu` from
  script for those cases and checks the event is not cancelled.
- Checked by: `e2e/context-menus.mjs` (71 checks, 3 green runs in a row), `e2e/team.mjs` `sectionNodeMenu`,
  `e2e/assistants.mjs` (History More), the existing knowledge/dashboard scripts, a Reviewer pass (no Critical or High)
  and a mock walkthrough of all nine surfaces (`docs/design/ux-review-context-menus.md`). Unverified: screen-reader
  speech, OS hand-offs (open folder, reveal, open in default app, new window) from a menu, Windows high contrast.

## Desktop updater UI (2026-11-17)

App settings > About > Updates, the sidebar update notice and Help > Check for Updates… are described, with how each
fact was checked, in `docs/agent-notes/updates.md` "Renderer" (store `store/updatesStore.ts`, pure `lib/updates.ts`,
`components/updates/`, `styles/updates.css`, `e2e/updates.mjs` on `ORGAI_UPDATE_MOCK`). The notice is the one
`Sidebar.tsx` addition: a row above the footer that takes over the footer's `margin-top: auto`.

## Native popover rapid reopen (2026-11-10)

Chromium can coalesce a native close/reopen into one `toggle` from open to open.
The model-switch failure was captured with real Electron beforetoggle/toggle and
focus tracing at the empty-catalog Escape/Enter checkpoint; React's unchanged
open state left focus on the trigger. `Popover` now notifies closes synchronously
from `beforetoggle` and reruns placement/focus for each delivered open event using
an opening revision. Native listeners stay installed across consumer renders.
`LiveModelSwitch` also reloads the fresh catalog on every open callback. Its close
epoch still cancels ordinary dismissals and exempts deliberate confirmation.
Motion, exit retention, CSS and native light dismiss are unchanged. The strengthened
model-switch e2e forces coalescing in a single browser task across themes, sizes
and reduced motion, and checks a dismissed pending read cannot switch a model.
Typecheck, build, 48 focused picker/motion/token tests, strengthened model-switch
e2e with normal and fresh-empty Claude configuration, and motion e2e passed.
Reviewer approved the concrete patch after inspecting all 22 shared uses across
18 consumers; no actionable findings or Critical/High blockers remained.
Focused UX follow-up reran the mock model-switch matrix and inspected picker
screenshots; it did not complete a first-time keyboard walkthrough. Canvas radio
entry/reopen, Usage Projects-to-Kinds light dismissal and Add Service custom-dialog
focus handoff remain root QA checks, not locally verified claims.
Live providers, screen-reader speech, zoom and cross-platform behavior are unverified.

## Late focus hand-backs (2026-11-24)

A focus call that runs a frame or a timer after the handler (`requestAnimationFrame`, `setTimeout`) runs late on a busy or
throttled window, after the person has moved on. A hand-back to the control that opened something (Esc or Cancel on a
composer or dialog, Done on an editor, a declined confirm, Show fewer) must go through `lib/laterFocus.ts`:
`focusLaterUnlessMoved` (frames) or `focusAfterUnlessMoved` (timer). Both take `from` when called and focus only if focus is
still there, fell to the page or `from` left the page. Moving focus forward to something that has just mounted (a new
field, the heading of the next item, an error summary) stays a plain call. The note composer's Esc hand-back was unguarded:
Esc, reopen at once and type could land the keys on the opener (reproduced by holding timers of 100 ms or less for 1.5 s in
`e2e/outputs-notes.mjs`, all four size and theme passes failed before the guard). Guarded: NoteComposer, NotesPanel,
OutputsView, VersionsPanel, ExternalEditStatus, KitImportDialog, EngagementPlanSection, TeamView, DashboardView, TodosSection,
UpNextSection, ConnectorGallery, the three knowledge sections, LivePermissionMode, MaintenanceSection, TranscriptPanel.

## Unified proxy setup (2026-11-10)

`AddProxyDialog` has one setup without a Kind selector. New records use
`openai-compatible` with `litellmFeatures: false`; `proxy-litellm-features` is the
optional native **Use LiteLLM reporting** checkbox in both Add and edit. Its hint
explains that the key is sent to reporting endpoints and figures may be unavailable.
`ProxyCard` derives the saved choice from `litellmFeatures ?? (kind === 'litellm')`,
saves the flag independently, and preserves id, kind and credentials. Base and
OpenAI endpoint defaults and origin-change key removal retain their existing
contract. Labels distinguish Proxy base URL, OpenAI base URL and the model-list
endpoint. Invalid submits focus the first invalid field. Proxy badges say Proxy;
Model prices uses actual check results, and usage visibility uses the reporting
capability with legacy fallback rather than kind alone. No motion was added.

Before-walk: a live root mock build showed the forced LiteLLM default promising
prices/spend before a test returned neither. Adding a mock proxy listed nine
mixed-family models, focused its heading and exposed the existing encrypted key
controls. Partial keyboard checks confirmed Name autofocus and Escape restoring
Add proxy. Only light at approximately 1024x615 and dark at approximately 1600x960
were viewed before implementation; those are not the full supported-size matrix.

Source verification: 45 focused tests passed across proxyForm, proxyChecks,
connectionLabel and usage; changed connections/multi-provider e2e scripts passed
syntax checks, and diff whitespace checks passed. Reviewer-2 approved all eleven
changed source/test files and the final label/legacy edit additions with no
actionable findings or Critical/High blockers. The e2e additions cover generic
default off, keyboard opt-in, and editing a legacy proxy while retaining id/kind/key.
Combined typecheck/build passed on root `ae8cde39`. The postwalk checked 1024x640
and 1600x1000 in dark/light: the dialog fits without overflow, the reporting
checkbox works by keyboard, invalid submission focuses the field, an opt-in mock
proxy adds nine models, and legacy id/kind/key/reporting survive edits.
Connections, multi-provider, project-connection and usage e2e passed against that
build normally and with fresh empty `CLAUDE_CONFIG_DIR`. Wrong-key handling and a
transient dialog observation after rapid driver input still need targeted QA;
the latter is not a confirmed defect. The final adapter integration gate remains
the orchestrator's responsibility. No live provider, paid test, screen-reader
speech, full keyboard-only task, zoom/reflow or measured performance claim was verified.

Shell, layout, primitives, motion, canvas (fold, themes), run view and run chains, dashboard, settings pages, application menu, cost UI, proxy and multi-provider UI, proposal cards, org change sessions. Moved out of CLAUDE.md on 2026-11-07; see CLAUDE.md for the index.

- Pocket Office (rework 2026-11-10, spec `docs/design/pocket-office.md` "Living office rework" and its implementation notes): the Canvas style popover and Settings Canvas section pick Graph/Pocket Office and Color (default)/Neutral/Green; presentation changes keep every graph preference, and the Settings sample is one inert framed picture. Team and Live draw one building per team and no floors: a lobby for the root agents, a corridor and themed department rooms (at most eight desks each, stable slots, labels `{Department} · {n}`), with the roster optional and every person a native 24 px button aligned with the sprite. Live adds one clock (`useOfficeClock`) that drives cues (typing, waving, glance, arriving, cheering, slumping, walking) from run state, at most twelve animated people; reduced motion or the Pause motion button (`aria-disabled` under Reduce motion, visibly pressed otherwise) stops it with no replay, and so does hiding the window. Messages (`useOfficeDeliveries`, `lib/office/scheduler.ts`) show a talk mark at the sender, a distance-based walk, a bubble at the recipient for a readable time and a 48 px strip log of the last three messages with `Show {To}`; the log holds still while focus is inside the strip and catches up when it leaves. A person with a live bubble or Needs-you mark outside the stage gets a chip in the controls row (`OfficeOffscreen`) that pans to them and hands them keyboard focus without changing the stage height. The camera (`useOfficeCamera`, `lib/office/camera.ts`) has zoom steps ½, 1, 2, 3, 4 (announced once as `Zoom 300%`), Fit, arrow-key pan, `+`/`-` that keep the focused person in view, `0` and Home, drag, and Find/Show with a ring and one `Showing {name}, {room}` line (the frame announcer joins lines said within a second of each other). Code: `components/canvas/office/*` and `lib/office/*` (pure rules, unit tested beside them). Checked by the `lib/office` unit tests, `npm run build`, `e2e/office.mjs` (runs `e2e/pocket-office.mjs`, also imported by `e2e/canvas.mjs`) on the mock adapter at 1024x640 and 1600x1000 in both themes and three palettes, and the spec's mock walk; screen-reader speech, a really minimised window, macOS and Linux, and a failed non-root agent in a live run are unverified.

The UI overhaul landed on native elements with container queries. Radix and react-resizable-panels are not installed,
and the frontend-design skill is not vendored in `.claude/skills` (only `run-desktop` is there).
- Primitives: `components/ui` (`ConfirmDialog` + `useConfirm` instead of `confirm()`, `Input`, `Textarea`, `Checkbox`,
  `Select`, `SettingRow` and the earlier ones). `IconButton` requires `label`, and `Button` takes `ariaLabel`.
- Shell: sidebar is `BrandLockup` + nav + project list + one 52 px account row (Popover with plan windows) and the gear
  "App settings"; below 1180 px or with Ctrl/Cmd+B it is a 56 px rail (`lib/useSidebarCollapsed.ts`). The topbar is 48 px:
  name, folder name only (`lib/paths.ts`), underline `Tabs` named "Project sections". e2e helpers: `projectTab`,
  `openAppSettings`, `openProject` (via `[data-testid=nav-project][data-name]`); the account row is `[data-testid=auth-pill]`,
  the folder `[data-testid=project-folder]`, run status is read from `.run-tab[aria-selected=true]`.
- Layout: `components/layout` (`CanvasFrame` with `FrameToolbar` / `FrameStage` / `FrameTray` / `FrameFooter`,
  `SidePanel`, `SaveIndicator`). Nothing floats over the canvas: decision cards sit in `FrameTray` on the
  `components/DecisionCard.tsx` shell.
- Run view: one 40 px run strip (`[data-testid=run-strip]`: run tabs plus Interrupt / End session / Org retrospective), then a 32 px canvas toolbar
  (`[data-testid=run-meta]` metadata, Hide finished switch, zoom IconButtons, the legend popover). The tray stacks under the canvas and docks
  beside it only in a frame of 1500 x 560 or more; `section.frame-tray[data-compact=true]` marks a frame under 480 px high.
- Run view without the side panel (assistant sessions 2026-11-11, every run kind 2026-11-12): `lib/assistants.ts`
  `hasRunSidePanel(layout)` is true only for the canvas layout (Pocket Office included) and false in the conversation
  layout for every run kind (Chat, Chat saved as a project, MCP / Skill assistant, Ask, setup, Team assistant / org
  change, team work runs shown as a conversation or opened as one by the ended-narrow rule; `isAssistantSession` is
  gone). LiveRunView then renders no `SidePanel`, marks `.run-body[data-side-panel=none]`
  (one grid column) and wraps the conversation in `components/RunDetailTabs.tsx` `RunStageTabs` (`run-stage-tabs`,
  first tab `run-tab-conversation`). The run detail tabs have one implementation: `lib/runTabs.ts` (pure:
  `showsPlanTab`, `showsOutputsTab`, `showsKnowledgeTab`, `runTabIds`, `resolveRunTab`) and `RunDetailTabs.tsx`
  (`useRunTabs`, `RunTabBody`, `PlanView`), used by both TranscriptPanel (side panel) and the stage strip; the tab test
  ids (`side-tab-plan`, `-usage`, `-logs`, ...) are shared. The strip shows Plan before a plan exists only for team
  work runs (not Chat/quick, not `team: 'single'`); returning to the canvas with an agent selected reopens the panel
  (`SidePanel` `revealOnMount`, auto-collapse still wins). Selection stays `sideTabByRun`; the conversation stays
  mounted (hidden) under other tabs; a send resets the tab to Conversation. Every run on the canvas keeps the panel;
  Outputs and Knowledge appear in the strip by `showsOutputsTab` / `showsKnowledgeTab` (work runs of stored projects,
  engagements for Knowledge; their bodies work at stage width because `RunOutputs` falls back to its list/detail mode
  without a `.side-panel` ancestor). The strip's Plan tab needs a plan for every kind
  (`showsPlanTab` `stage`; the side panel still gives every work run one, with its "No plan yet" note, which is the only
  thing a work run in the conversation layout does not get; the steps chip and the blocked-plan banner need a plan
  anyway). A selected sub-agent's transcript and the agent meta/staffing lines belong to the canvas panel only. Checked by
  `lib/assistants.test.ts`, `e2e/assistants.mjs` (team work run both layouts), `e2e/engagement2.mjs` (Ask run), `layout.mjs`,
  `usage-app.mjs`; mock adapter only; `RunStageTabs` marks Conversation
  (`Tabs` `dot`/`dotLabel`, "Conversation, new reply") when a reply or "your turn" lands under another tab and calls
  `onReply` (LiveRunView's `setArrival`, the CanvasFrame announcer); Show thinking is a strip control held by LiveRunView
  (`TranscriptPanel` `showThinking` prop, not a store key: it never was one). Usage tab: By agent rows come from
  `agent.upsert` immediately while `summary.usage` (Cost card, run meta) is throttled up to `USAGE_THROTTLE_MS` (1 s,
  `runManager.ts` `refreshUsage`), so the two can differ briefly after a turn; the mock e2e shows them equal after 2.5 s.
  Checked by `lib/assistants.test.ts`,
  `lib/runTabs.test.ts` and `e2e/assistants.mjs` (`checkStageTabs`); design notes and open items in
  `docs/design/assistants-ui.md`.
- Resizable columns share one width budget (on the run view only while the canvas shows, since the conversation layout has no panel; `lib/panelWidth.ts` `panelBudget`): the canvas keeps 280 px (`CANVAS_MIN_PX`); when the side panel minimum (280 px) does not fit it shows as its rail (saved width and choice kept, re-applied when space returns). `SidePanel` `autoCollapseBelow` reacts to first layout and window resizes only, never to handle drags. Resize handles: Enter or double-click resets, arrows move the splitter.
- Resizable columns: `components/layout/ResizeHandle` is a `role=separator` (vertical, `aria-valuenow/min/max`, focusable) inside the column it resizes, on the edge facing the neighbour, so it never overlaps the canvas. It supports captured pointer drag, Left/Right (16 px, Shift 64 px), Home/End and double-click to reset; `lib/panelWidth.ts` holds the pure clamp/drag/key helpers (tested) and `usePersistedWidth`. Sidebar: 200-420 px (default 232), localStorage `orgai.sidebarW`, App sets `--sidebar-w` on `.app` and the main area keeps at least 480 px; shown only in the full sidebar, not in the rail (the chosen width survives collapse/expand). Right `SidePanel`: 280 px up to whatever leaves the canvas 280 px (no fixed maximum), localStorage `orgai.sidePanelW.<persistKey|default>`, drives `--side-panel-w` on the parent grid (`.editor`, `.run-body`; unset means the CSS default 360 px / clamp(280px, 28cqi, 400px)) and the canvas keeps at least 280 px; hidden while the panel is collapsed. Dragging below the minimum does not snap to the rail. From a measured panel width of 480 px `SidePanel` sets `data-side-wide` on the parent; `.run-body[data-side-wide]` then moves the same `.composer` element (no remount) into the panel column under the transcript. The run frame docks its tray beside the stage only when the tray has content (`.frame-tray:not(:empty)`), else an empty tray column left a blank strip beside the canvas. The account popover's `UsageMeter` has no Refresh button or Updated text: it calls `refreshUsage()` on open when data is older than 60 s, then every 60 s while open (one call in flight, at most one attempt per minute even on failure). A non-current connection gets a section only while it is in use (`connectionInUse` via `lib/usage.ts` `connectionsInUse`) and has a report (`connectionOrder`); stale reports of unused connections neither show nor force a refresh.
- Wide panel: `SidePanel` sets `data-side-wide` on its parent grid at panel width >= `PANEL_WIDE_PX` (480) and clears it below `PANEL_NARROW_PX` (448, hysteresis via `nextWide`). The Live view's canvas refit skips a resize caused by that layout switch. The composer is a container (`composer`) and drops its hint under 560 px; transcript text/user/thinking entries cap at 90ch.
- Dev builds: a package.json version with a `dev` prerelease tag (`0.1.6-dev1`; `lib/buildChannel.ts` `isDevBuild`) shows a quiet info "Dev" Badge beside the wordmark (a "D" pip on the mark in the 56 px rail), `[data-testid=dev-build-badge]`, labelled "Dev build <version>", plus a "Dev build" badge by the version in App settings > About. e2e/layout.mjs expects it whenever package.json says `-dev`; drop the tag for a release. After a release, dev is bumped to `<next patch>-dev1` and the dev number counts up per dev build (`0.1.6-dev1`, `0.1.6-dev2`, ...) until the next release drops the tag.
- Status words come only from `lib/runStatus.ts`: Running, Needs you, Idle, Paused, Finished, Stopped, Failed. An ended run's word comes from the summary (`endedBy` 'user' = Stopped; 'app' or `endedWithApp` = Stopped shown as "Ended when OrgAI closed" through `statusText`, which every status text uses; `isStoppedRun` only for old records).
- An ended run cut by OrgAI carries `endedWhile` (shared `cutWhile` in `shared/view/runStatus.ts`, `cutWhileWords` in `runChains.ts`): "waiting" only with an open decision (a waiting or Needs-approval agent, or main saw a card or blocked plan), "idle" when the root sat idle with none (notice "OrgAI closed while this run was idle. Send to pick up where it stopped."), "working" otherwise. Only "waiting" is dashboard kind `closed-waiting` (the "were waiting on you when OrgAI closed" count and attention row); idle-at-close is `closed`. Checked by unit tests (`runEnded.test.ts`, `runChainsView.test.ts`, `dashboard.test.ts`); not walked in a live app.
- "Needs you" counts decisions (cards), never runs: the bell, the Needs-you row, the project row badge and subtitle
  ("3 decisions · 1 run") and the topbar all come from `lib/needsYou.ts` `waitingItems` / `decisionCount`. A run row's dot
  is the run's status. A Needs-you item names the kind and the ask first, then the location, and opens that card.
  A question card shows its options inline at every size (`DecisionCard` `inline`); the tray shows the first open decision.
- Project tabs are Live, History, Team and Settings. The org chart editor is `views/TeamView.tsx`, and project
  settings are sectioned through `components/settings/*`.
- Motion (spec `docs/design/motion.md`, section 7 is what landed): tokens in `styles/tokens.css` (`--dur-instant/fast/base/slow/fade/pulse`, `--ease-out/in/in-out/spring`, `--motion-distance(-sm)`, `--motion-scale-from`, `--motion-stagger`; ~0 under both reduced-motion switches, and global.css forces 0.01 ms incl. `::backdrop` / `::details-content`), recipes in `styles/motion.css` (`.motion-enter`, `.motion-view`, `.motion-pop`, `.motion-ring`, `[data-ping]`, `.motion-collapse[data-collapsed]`, native `details` content fades in on open with its layout final at once and closes instantly, never a height glide, since e2e reads and measures right after a click; `.motion-none` opts out), hooks `lib/useArrival.ts` (entry only for arrivals, never first paint / relaunch / scope switch), `lib/useExitPresence.ts` (`exitProps`: retained leaving nodes are inert + aria-hidden; focus is moved or dropped in the same tick, never left inside), `lib/layoutMotion.ts` (`<html data-layout-moving>` defers canvas refits, `data-columns-moving` lets side panel columns glide), `lib/useBellCue.ts`, `lib/transcriptFollow.ts`, canvas `useNodeArrival` / `beginCanvasGlide` (`.react-flow[data-canvas-gliding]`, up to 60 nodes) / `fitMs` / `refitMs` / `reducedMotionNow` in `lib/canvas.ts`. Dialogs and popovers fade and scale in and fade out (content kept for `--dur-fast`), tab indicators slide, sidebar and side panel Hide / Show glide, tray cards rise with a one-shot ring, the bell pings when decisions rise (5 s throttle), canvas nodes pop in and glide on auto-layout, every live cue breathes at `--dur-pulse` (canvas cap 12). e2e `e2e/motion.mjs` (in e2e:free) checks running transitions with motion on, ~0 ms with Reduce motion on, inert leaving dialogs, quick open/close cycles and the breathe cap; `setReduceMotion` / `motionOff` in e2e/lib.mjs; a test that reopens a dialog right after closing it waits for `[open]`, not "visible". Open: `BannerPresence` (ui/Banner.tsx) has no callers, band and New project heights snap, radio dots, side panel glide only for the Hide / Show buttons; screen reader output and macOS not checked.
- Transcript follow (motion.md 3.11, as built): one hook, `lib/useTranscriptFollow.ts`, serves the Conversation stage list, the side panel transcript and the Logs tab (`RunDetailTabs`); the decisions are pure in `lib/transcriptFollow.ts` (`nextFollowing`, `followDecision`, `easeStep`, `FOLLOW_RESUME_IDLE_MS` 10 s, `STICK_PX` 48; unit tested). Behaviour: a list opens at its end instantly whenever it attaches, `runId`/agent changes or a hidden list is shown again (a resize observer sees the 0 to N size change), and layout that settles later is pinned instantly for 0.8 s. Root cause of "starts at the top" (reproduced in the built mock app before the fix, scrollTop 8 of 1914 in the first frame after returning): the Conversation panel stays mounted under `hidden`, the old follow effect ran on `lastEntryId`/`partial` while it was `display: none`, wrote `scrollTop = scrollHeight (0)` and nothing re-pinned on show. Run switches and relaunch cold loads already landed at the end in the mock app (each run's view is its own instance), so the per-instance `stuck`/`prevLast` leak in the hypothesis was not reproduced; the side panel and Logs pinned unconditionally on every update, so they could not be scrolled up while text streamed. Release: wheel up, finger down, up-keys and a scrollbar drag release at once, even for a notch inside `STICK_PX` (the old code re-pinned it on the next token); scrolling back within `STICK_PX` or "Jump to latest" follows again. After 10 s without a user scroll the next row or streamed text glides the list back (instant under reduced motion); nothing moves it when the time merely elapses or while content arrives inside the 10 s. Chain focus and rows prepended by "Load earlier sessions" call `holdHere()` and count as a user scroll. The follow's own writes are recognised by position (`setTop`) so they never read as the user leaving; one rAF glide (time constant `--dur-base` / 3) tracks a growing end so streaming growth never restarts it; opening a `summary` also holds still. Checked by `transcriptFollow.test.ts` (39 tests) and `e2e/runs.mjs` (tab and run switch, small and large wheel up during a mock stream, return by wheel and by the button, the 10 s return with `Date.now` moved forward, reduced motion, side panel); not checked: touch and screen reader use, a live provider stream, real trackpad momentum.
- Run chains (spec 2.5 "Finished run", `docs/design/ux-review-continue.md`): a run and its continuations are one conversation. One tab per chain (`.run-tab-wrap[data-chain]` = oldest member id, `data-run` = newest), title and tag from the first member, status from the newest; openRun always shows the newest member (sends, Interrupt, End session go there) and `loadChain` fetches earlier records lazily (newest 10 members, 4 fetches at a time, older ones behind `chain-load-earlier`; the merged feed caps at 5000 items behind a `chain-omitted` row; the composer draft is keyed by chain). The feed merges every member oldest first with a `chain-divider` row per continuation ("Continued 3 min later" / "Continued after OrgAI closed"; the adapters' "Continued from run" row is hidden); earlier members' agents fold into "Earlier: N agents" groups; the root sums tokens and cost. An ended continuable run's composer continues by default (`endedComposerCopy`: "Session ended ... Send to continue with its memory.", primary Send, `composer-cut-notice` when OrgAI closed, `go-to-latest` on an older member); New run is the "+" tab / Ctrl+T only. Under 1100 px an ended continuable work run opens in the conversation layout. History is one row per chain (`N sessions` badge, `history-sessions-toggle` member rows, summed cost). Open chain tabs are restored per project on relaunch (`lib/openTabs.ts`); focus stays in the composer after a continue and End session. e2e: `e2e/runs.mjs` (continue in the same tab, divider, relaunch "Ended when OrgAI closed"; `relaunch()` in e2e/lib.mjs). Not done: the Usage tab "Whole conversation" switch; earlier groups sit under the root, not above.
- React Flow 13 (`@xyflow/react`, from 12.12): `onNodesChange` / `onEdgesChange` receive a `NodeChangeset` / `EdgeChangeset` (call `.toArray()`; type the callback `OnNodesChange<T>` / `OnEdgesChange`); `useStore` is gone (`useViewportStore` for `transform`, `useOptionsStore` for `domNode`, in `CanvasBackdrop` / `CanvasMinimap`); a bare number `fitView` padding is now pixels, so every fit goes through `lib/canvasFit.ts` `legacyFitPadding(p)` (the old factor as a per-side percentage, e.g. 0.3 is `11.54%`; Team editor, Live run, settings sample); the stylesheet is `@layer xyflow`, so our unlayered rules beat it whatever the specificity (`flow.css` leaves `cursor` to the library on draggable nodes); `elevateEdgesOnSelect` is passed `false` (v13 defaults to true); the fit default padding is 5% (we always pass one). Colour mode follows `:root[data-theme]` through the library's own `[data-theme]` rules. Checked: typecheck, unit tests, build and the canvas e2e scripts (see the PR 61 report); live pointer feel not compared against 12 side by side.
- Canvas fold: Hide finished agents (`lib/foldFinished.ts`, pure, unit-tested): an agent folds when it has a parent, is settled (done or failed, worktree settled, 6 s grace; a done agent with no `endedAt` settles at once) and nothing under it is live; a hidden agent's whole subtree joins the group of its nearest visible ancestor, so a finished subtree is one `done-group` under the agent still shown above it (never a parentless group; earlier-session groups hang under the root). Counts, failed, unmerged and cost cover the subtree; the tooltip names direct reports first. `expandedGroups` is keyed by the group's key (that visible ancestor's id, or an earlier-session key): expanding shows the direct reports, whose own finished reports fold into one group per report; turning the switch off and on again folds everything back. The side panel `FinishedList` lists the whole subtree, newest first, with an "under <name>" line for members that are not direct reports. The grace is timed by one `setTimeout` for the next settle moment (`nextSettleAt` / `settleTimerDelay`, 250 ms floor, keyed only on that moment, never on the agents array), so reports fold while the run is still Running. Agents are named by `lib/agentTree.ts` `agentLabel` (handle first, as the canvas node shows it, else the role name; a handle with hidden or control characters falls back to the role name, longer than 64 chars is cut) in the group tooltip, the expand button label, the "Showing N agents under X" announcement and `FinishedList` (role name as a caption beside the handle). A report group's expansion stores its time: reports finished by then stay shown, ones that finish later fold again. UX walk: `docs/design/ux-review-fold.md` (d6e57b6); H1 (no fold while events stream), H2 (role names instead of handles) and M1 (sticky expansion) are fixed, unit-tested only (no app or e2e run); open: M2 (unreadable fit after a large expand), M3 (Enter/Space now select a focused node, fixed with canvas themes phase B; focus ring checked only by eye), M4 (cascading folds and re-fits), L1-L5, focus is lost when a focused node folds, and a report whose worktree settles after an expansion stays shown. The node carries `data-testid=done-group` and `data-count`. e2e/runs.mjs drives it with the mock marker `[mock:deep-tree]` (work runs, default script): root -> `mock-lead` -> `mock-lead-report-1` / `-2`, all reports finish; the run goes idle and finishes on End session. Checks: one "3 done" group under the root, expand to `mock-lead` plus a "2 done" group with an edge, fold back, both themes at 1024x640 and 1600x1000.
- Canvas themes, phase A (spec `docs/design/canvas-themes.md`, walk `ux-review-canvas-themes.md`; ARCHITECTURE.md
  "Canvas"): App settings > General > Canvas (`components/settings/CanvasSection.tsx`, right after Appearance, outside
  Advanced, whose group is now "Motion"; `APP_SETTINGS_SECTIONS.canvas`, the deep link focuses the checked style) has a
  live sample (`canvas-preview`, inert, `lib/canvasSample.ts`), the style gallery (`canvas-preset[data-preset]`, a
  one-stop radiogroup, Custom only when no available preset matches) and a Customise disclosure (`canvas-customise`,
  localStorage `orgai.canvasCustomise`; `canvas-backdrop-select`, wrappers `canvas-layout` / `canvas-edges` /
  `canvas-node-style` around native radios, switches `canvas-tint` / `canvas-minimap`), announced through
  `canvas-announce`. The Live and Team toolbars have `canvas-style-button` (popover `canvas-style-popover`, picks apply
  at once through `lib/canvasSettings.ts` `saveCanvas` and speak through the frame's `tray-announce`; `canvas-style-more`
  opens the section). `lib/theme.ts` writes `data-canvas-{pattern,edges,layout,node-style,tint,minimap}` on `<html>`;
  canvases read only `lib/canvas.ts` `useCanvasOptions()`. Each canvas draws `components/canvas/CanvasBackdrop`
  (`canvas-backdrop[data-pattern]`, 9 patterns, `circle.canvas-ring` guides in radial on Live and the sample,
  `div.canvas-scanlines` on Terminal), `CanvasMinimap` (bottom-left, `minimapSize` from the stage, one shape per node
  through `useNodeDims`), `.react-flow[data-layout]`, `layoutCanvas` (dagre TB / LR or `radialLayout`; the Team editor
  uses it for Auto-layout only) and `RadialEdge`; nodes carry `data-style` (card or compact 160 x 40 pills, detail in
  the tooltip) and call `useHandleRefresh` so edges follow a layout switch. Edges are `edgeStroke` mixes; messages are
  dotted `.msg-edge` in `--edge-message`. The legend has eight entries (Working, Needs you, Finished, Failed, Selected,
  Folded finished agents, Reporting line, Message between agents). e2e `e2e/canvas.mjs` (in e2e:free; mock, 1024x640
  and 1600x1000, both themes): the section and gallery keyboard, Customise, every backdrop on Live, Terminal in light,
  the three layouts on `[mock:deep-tree]` (and edges leaving the right side in left to right), compact sizes, the
  minimap count and size and that neither popover lands on it, reduced motion, the popover's focus return and deep
  link (`windowShift`), and the Team editor following backdrop, lines, minimap, name tags and Auto-layout. Unverified:
  message-edge styling and the Starfield glow (the mock sends no agent messages), contrast ratios (computed by hand in
  the spec, not measured), custom accents and role colours, System theme, large runs, ring guides in the Team editor
  (none drawn: its positions are the user's).
  - Phase B (spec sections 4b, 4c, 11): node styles `station` (subway map: a 32 px circle in `--role-ink`, the role
    colour through the edge mix, name pill `.station-name` beside it top down and below it otherwise per
    `stationGeometry`, the root an interchange, handles on the circle; 6 px lines in the lead's colour through
    `reportingLineRole`, no arrows, never dashed, smoothstep radius 12; a folded group is a `.station-terminus` bar) and
    `hex` (120 x 104 flat-top `.hex-tile` / `.hex-fill`, radial packs a honeycomb through `honeycombSnap` with no ring
    guides, radial edges clip at the hexagon or circle through `canvasShapes.ts` `exitPoint`). Subway and Hive show in
    the gallery and popover; "Agents as" offers Cards, Name tags, Stations, Honeycomb; the legend swaps its Finished,
    Folded and Reporting line shapes per style. A "Default" gallery entry (`data-preset=default`, renderer-only,
    `shownStyle`) is checked on the DEFAULT_APPEARANCE canvas, so a fresh profile no longer reads Custom.
  - Re-walk fixes (`ux-review-canvas-themes-2.md`): non-card nodes show `agentLabel` (handle first, middle-clipped
    through `splitLabelTail`), the role name is the tooltip caption; Enter / Space on a focused Live node selects it
    (React Flow 'select' changes in onNodesChange; the group chevron stops the key); message edges use the side
    handles facing each other (`messageSides`, ids `msg-out-<side>` / `msg-in-<side>`); selection wins over state
    colours and adds a shape cue (a 4 px leading bar on cards, a 3 px border on name tags) so it never reads as focus;
    radial cards fit no lower than zoom 0.7 (`canvasFit.ts`); the settings preview is sticky in the one-column layout
    with `scroll-padding-top` on the scroller.
  - e2e/canvas.mjs adds: Subway and Hive from the gallery, station lines from mock-lead share edgeStroke of its role
    colour (6 px, no marker), a station terminus, hex tiles 120 x 104 without overlap and without rings, no page scroll
    in both styles at both sizes and themes, Team role nodes in both styles, name tags showing distinct handles, Enter
    and Space selecting, Default checked on a fresh profile and after Blueprint, the sticky preview. Unverified:
    message edges in a live run (the mock sends no agent messages; side choice is unit-tested and seen in the settings
    sample), radial messages, contrast of `--role-ink` shapes (computed from the edge mix, not measured), hex and
    station at large runs, the Team editor selection cue by eye, System theme.
- Approved changes reach mounted surfaces through `project.updated` (store `handleEvent` replaces the project): `useProjectSkills`
  reloads when a value string of the project's skill ids and role grants changes (not references, so chart drags do not refetch;
  skipping the ones its own `apply()` pushed); saved rules refresh through the store's `rulesChangedByProject` counter
  (`lib/rulesChange.ts`, bumped on project-scope `rules.resolved` grants, `project.updated` and `permission.resolved` with
  `savedToProject`, the permission card's "Always allow for project") read by `PermissionRulesPanel`, which refreshes under a
  sequence guard; the MCP list already reloaded on `project.mcpServers`. Checked by unit tests of the helper and of
  RunManager.decide only; no e2e, not seen in the app.
- Team tab phase 1 defect fixes (2026-11-19; walk `docs/design/ux-review-team-tab-5.md`, overhaul spec
  `docs/design/team-tab-overhaul.md` is phase 2). D1 spawn rights follow delegation: `lib/roleOps.ts` `setReportsTo` and
  `removeRole` clear `canSpawn` on a role whose `spawnable` list the change empties (a role with no delegates before the
  change keeps a hand-ticked right; no new persisted field); `addRoleUnder` grants it; `RemovedRole.delegation` snapshots
  `canSpawn` / `spawnable` / `requiredReports` and `RemovedRole.leftBy` records the same fields right after the removal;
  `restoreRole` works field by field: a field still equal to `leftBy` goes back to its pre-removal value, a field the user
  changed since keeps the user's value (`spawnable` then only gets the role appended; `canSpawn` is never raised above a
  value the user set, so unticking "May create subagents" or a Required box after the removal survives Undo; review M1);
  `spawnNotice(before, after, cause)` is the one banner text for gained and lost rights, used by addRole, drag,
  Delete-on-edge (reparentToRoot) and the inspector's Reports to (a change with no spawn effect clears the banner); a removal
  appends the lost sentence to the toolbar undo row (`team-undo-row`). D2 `lib/rolePlacement.ts` `placeNewRole` (pure):
  first report below the manager, later ones right of the rightmost sibling (left-right layout: right of the manager, stacked
  down), stepping past any node box plus a 40 px gap, measured sizes when known; TeamView then pans (never zooms) so the new
  node sits inside `.frame-stage` clear of the bottom controls. D3 toolbar Add role always adds under the root; the
  "New roles report to X." note is gone; the inspector header has "Add a report" (`role-add-report`) beside Remove, as does
  the node menu. D4 delegation list (`lib/delegation.ts` `delegationChoices`): direct reports first, the rest under a native
  "Other roles (n)" `<details>` (`role-delegate-other`, open when one inside is ticked); a role's manager and ancestors are
  never offered unless already ticked; one grid row per role (`.delegate-row`, `minmax(0,1fr) auto`, name ellipsis with the
  full name as `title`); Required's accessible name is "Required: <role>"; one hint sentence explains Required; testIds
  `role-delegate-<slug>` and `role-required-report-<slug>`. D5 drop anywhere on a node: a second transparent target `Handle`
  (`id="drop"`, `.role-drop`, `isConnectableStart={false}`) covers the node (React Flow takes handle pointer events
  only while a connection is in progress, so clicks and selection are unchanged); `useConnection` sets `data-drop`
  valid / invalid for the outline; `isValidConnection` refuses self and cycles and `onConnectEnd` puts the reason in the
  toolbar (`team-drop-note`, 8 s). The "stray line" of the walk was not reproducible (React Flow cancels the line on
  release); a guess is a mid-drag screenshot. D6 "leads N" (`role-node-leads`) counts direct reports the role may delegate
  to (`delegateCount`) and is hidden at 0. D7 team files line: "Team files: not committed yet" instead of "changed"
  (`TeamFilesStatus` carries paths only, so new and edited files cannot be told apart: a contract field such as an
  untracked flag would be needed to say "new"); Commit opens a confirm listing `uncommittedFiles` (12 named, then
  "and N more", "at least" at `TEAM_FILES_LIST_MAX`; `commitConfirmText`), Cancel commits nothing; the line's parts are
  separated by an `aria-hidden` dot. Main re-reads git at commit time, so a file that changed between the confirm and the
  click is committed too (it is still only team files); the confirm says so (review M2: lead "Git reports N changed team
  files in .orgai/ right now:", footnote "OrgAI commits the team files git reports as changed when you confirm, and
  only team files. ..." since the button may read "Commit anyway"; a stricter check in main is a follow-up). D8 rename: grants `McpServerSpec.roles` are role slugs and
  `projects:save` keeps the stored `mcpServers` (store/projects.ts `saveFromRenderer`), so a rename dropped slug grants;
  `renamePatch` / `slugPatch` add the server ids to `Role.mcpServers` in the same role patch. Review H1: the patch is
  computed against a `RenameStart` (slug and `mcpServers`) RoleInspector takes when the Name or Slug edit begins (focus, or
  the first keystroke when no focus came; keyed to role and project id), always `start grants ∪ servers naming the start
  slug`, so an in-between slug while typing never copies another role's server in. Once anything is carried the patch
  carries it at every slug, the starting one included (recheck: main is getting a rule that moves an old slug's servers to
  ids on a save of a slug change, and debounced saves carry in-between slugs, so typing back must keep the ids; a
  redundant id grant is harmless); nothing to carry leaves `mcpServers` alone. Slugs are unique in the project like the
  CLI's `teamRoleEdit` rule: `renamePatch` gives a colliding `slugify(name)` the next free suffix (`uniqueSlug`: `qa-2`,
  `qa-3`), the name stays as typed, so "QA Lead" never passes through another role's `qa`; the Slug field refuses a
  taken slug (`slugFieldEdit`) with the field error "Another role already uses this ID." (`role-slug-error`,
  `aria-invalid`, the typed text stays in the field until blur) and applies nothing. RoleInspector records the
  `mcpServers` each rename patch wrote; on the next keystroke a different value (changed from outside) settles the open
  edit and takes a fresh snapshot, as does a snapshot of another role or project; the cleanup effect depends on role and
  project id. Review M3: when the edit ends (blur, role or project switch or unmount through an effect cleanup) and the slug changed, `settleRename`
  saves the store's project with `projects:save` (awaited, through `trackSave`; its result is not put back in the store,
  so an edit typed meanwhile is not overwritten), then re-reads `mcp.list`, and only when no role holds the old slug sends
  one `mcp.upsert` per server whose explicit `roles` still names it and that the renamed role holds by id, dropping the old
  slug and only that slug (recheck: other slugs no current role holds stay, as they may belong to a role removed with
  Undo on screen or named by team files awaiting approval). A failed save sends nothing; a failure says so in the
  inspector banner if that role is still shown, otherwise (role or project switched, inspector closed) through
  `onSettleError` in the Team view's warning banner `team-rename-note`. From the upsert answer only `mcpServers` is applied over the store copy. A rename
  therefore makes 0 calls per keystroke and at its end one save plus at most one upsert per affected server (0 when main
  already dropped the slug itself). `revokePlan` removes only the revoked role's slug. L1: a drop on the manager a role already
  reports to does nothing; `moveNotice` names roles that no longer delegate to the moved role. L2: "Nobody (root
  orchestrator)" is offered only on the root. Known gap: `RoleCapabilities` applies an `mcp.upsert` answer with
  `replaceProject(r.project)` whole, which can replace newer unsaved role edits (pending 350 ms debounce) with main's copy
  in the store; not fixed here (file owned by another run). Skills (`Role.skills`), `spawnable` and `requiredReports` are
  ids and were unaffected. Checked by unit tests (roleOps, roleCapabilities, rolePlacement, delegation, teamFiles) and e2e
  team.mjs (add target, no overlap and in-stage at both sizes, body drop, same-parent drop, cycle reason, leads chip,
  banners, undo), canvas.mjs (body drop per node style), team-files.mjs (confirm wording, Cancel, keyboard commit,
  separators); layout.mjs unchanged. The rename settle path has no e2e (unit tests with fake save/list/upsert only).
  QA phase 1 follow-ups (2026-11-19): S1 the pan after an add (`revealRole`) measures the rendered node when it exists
  and uses `lib/rolePlacement.ts` `revealShift` (pure) to keep it inside the stage and 8 px clear of
  `.react-flow__controls` (bottom right) and `.react-flow__minimap` (bottom left); e2e team.mjs checks adds 2 and 3 at
  1440x900 and the add at 1024x640 against both (other graph styles, e.g. Constellation, not checked by e2e). S2 the
  commit confirm repeats `status.warnings` (file and message through `showHidden`, capped at 12, warning Banner
  `team-files-commit-warnings`), the lead says some team files have warnings and the button reads "Commit anyway"; it does
  not block (unit test only: no cheap fixture makes main produce a warning in team-files.mjs). P4 the direct reports group
  of the delegation list is labelled "Direct reports". P6 `team-drop-note` clears on the next drag start or a pane click. Not checked: the delegation list by eye at every size and
  theme, touch drags, screen-reader speech, radial / left-right placement by eye.
- Proposal cards (`docs/design/proposal-cards.md`): an org chart card shows a changed role's new prompt ("Show new prompt") and an added role's prompt ("Show prompt") in an `org-diff-prompt` disclosure through `ClampText`/`showHidden` with the hidden-characters badge (review M3; e2e/proposals.mjs); card read errors speak through the frame's one `tray-announce` (`useFrameAnnounce` in `CanvasFrame`). Long proposals (fix 2026-11-07, proposal-cards.md section 12): a proposal body is always its own scroller (`overflow: auto` beside its cap in cards.css; the Team tab's Architect tray set `overflow: visible`, so a capped body ran on under the footer and never scrolled), and while it overflows `DecisionCard` gives it one Tab stop (`data-scrolls`, `role=group`, inset focus ring). e2e/proposals.mjs scenario 4 drives a 29-change org chart in the Live tray of a work run and of an org change session (the Team tab's Architect tray is gone, see Org change sessions) at both sizes and themes.
- Proposal cards (spec `docs/design/proposal-cards.md`, merged at e655838): `components/proposals/*` (`McpProposalBody`,
  `SkillsProposalBody`, `ClampText`, `useCurrent`), `lib/skillProposal.ts`, `lib/proposalSummary.ts`,
  `lib/hiddenChars.ts` (badges hidden characters; main is the gate, see Work-run configuration changes) and
  `styles/proposals.css`. The store keeps `proposalOutcomes` from `proposal.resolved`. Selectors: `proposal-decline`,
  `proposal-decline-note`, `proposal-decline-send`, `proposal-effect`, `mcp-proposal-secret[data-secret]`,
  `mcp-proposal-server[data-change]`, `mcp-proposal-removal`, `proposal-skill-item[data-action]`,
  `proposal-next-secrets`, `tray-announce` and `article.decision-card[data-focus-details]`. At 1024x640 the compact
  frame gives the card the stage; the frame stays compact until 544 px high (`COMPACT_FRAME_HEIGHT` 480 plus
  `COMPACT_EXIT_MARGIN` 64). e2e: `e2e/proposals.mjs` (in e2e:free). Open Lows: switching tray cards drops typed
  secrets and the decline note; the mock has no secret-slot or toggle proposals; the skill link, grant and remove rows
  and the before/after view are not driven by e2e.
- Org change sessions (owner decision 2026-11-07, walk `docs/design/ux-review-org-change-session-pre.md` "Status after the change"): Team > Design "Revise with the Architect" (`org-change-start`) and Settings > Maintenance "Review the org chart and setup" (`maintenance-org-review`, on every project) start an ordinary setup run through one hook, `components/team/useOrgChange.ts` (`startSetup(orgChangePrompt(text, kind))`, focus to the composer, run-tabs notice "Org change session started..."); while one is open both send into it / open it instead (button "Send to the open session"), so two Architects never revise one chart. It has a run tab, a sidebar row (`nav-run[data-kind=org-change]` with `nav-run-kind-mark`), History (`run-kind[data-kind=org-change]` "Org change", under the Setup filter), Dashboard and Needs-you rows, and restores after a relaunch like any run. The renderer no longer starts or hides `surface: 'team'` runs (`lib/runSurface.ts`, `ArchitectDecisions`, `designRun` / `designJump` are gone; main still accepts the field, old records list and get R numbers). `lib/orgChange.ts` (pure, tested) holds the prompt contract (`ORG_CHANGE_PREFIX`, `ORG_REVIEW_PROMPT[_ENGAGEMENT]`, legacy Maintenance prefix), `isOrgChangeRun` (kind 'setup' + prompt), `orgChangeTitle` / `displayRunName` ("Org chart: add a database specialist", "Org chart review"; used by run tabs, sidebar, History, RunLabel, Needs-you, Dashboard, NewRunPage, document title), `runKindWord`, `setupBannerShows` (the "Setup complete" / "Org change applied" banner never shows on a run cut off by a quit, and an org change needs an approval seen in that view; walk M2) and `liveOrgChangeRun`. The Team tray shows `org-change-pointer` / `org-change-open` above both modes while a session is live; RunMeta `run-meta-kind` reads "Org change session". `RunLabel` never prints "R?" (name only while unindexed). e2e `e2e/org-change.mjs` (in e2e:free; both sizes and themes, relaunch) and team.mjs `sectionDesignDecisions`. Open: the banner's approvals are view-local (gone after a remount or a decision in another window), other `runTag` callers can still print "R?" while history loads, no History "Org change" filter.
- (History: superseded for structure by "Dashboard and Usage redesign (2026-11-21)" at the top of this file.) Dashboard (overhaul, pass 3, 2026-11-19; spec `docs/design/dashboard-overhaul.md`, which supersedes dashboard-2.md
  2-4, 6-9 and 12-16; renderer only, the one main contract is `AppSettings.displayName`). `views/DashboardView.tsx`
  (store View id stays 'projects'): `.dashboard` is the page scroll, `.dash-page` the `dash` inline-size container. One
  column in DOM order: secret and forget notices, the greeting `dashboard-hero` (`Greeting.tsx`: salutation by local
  hour, the brief from pure `lib/dashboardBrief.ts`, the name control, the Customise button, the page's one polite
  region `dashboard-live` in `DashboardLive.tsx`), the customise bar, the fixed Waiting on you `dash-needs-you`
  (`AttentionColumn.tsx`, order from pure `lib/waitingOrder.ts`, recomputed only when the key set changes) and To finish
  setting up `dash-setup` (`SetupGaps.tsx`), then the five arrangeable sections in the person's order inside
  `.dash-arranged`: Pick up where you left off `dash-resume` (`ResumeSection.tsx`, pure `lib/resumeRows.ts`, outputs
  through the `projectQueue` kind 'outputs'), Today `dash-today` (`TodaySection.tsx`, pure `lib/todayModel.ts`),
  Working now `dash-now` (`RightNowBand.tsx`, `lib/dashboardBand.ts`, no height budget, waiting runs first, " · Waiting on
  you" in plain text, decision label never a raw command), Your week `dash-week` (`WeekSection.tsx`, `WeekLedger.tsx`
  7-day ledger, pure `lib/weekRecap.ts` over `lib/activityStrip.ts` `dayLedger`, limits `WeekLimits.tsx`), Projects
  `dash-projects` (`ProjectsGrid.tsx` / `ProjectTile.tsx`, pins first via `pinnedFirst`, slim tile without `tile-run`),
  then the footer `dashboard-app-facts`. Every arrangeable section renders through `DashSection`
  (`DashboardContext.tsx`): slot `dash-section[data-section][data-state=shown|hidden|empty][data-span=half|full]`, h2,
  count, customise control row; outside customise a hidden or empty section renders nothing and reports itself empty
  so `placeSections` (pure `lib/dashboardLayout.ts`) pairs only visible halves in two tracks (from 1000 px of
  `.dash-page`, `dashCaps.ts` `WIDE_AT_PX`; caps needs 3/5, setup 3/5, resume 4/6 up to 12, schedules 4/6, to-dos 3/5,
  band runs 3/5). Layout `orgai.dashboardLayout` in localStorage (`useDashboardLayout`: read once, written on change,
  follows the `storage` event; order, hidden, pins up to 24; corrupt values load the default). Customise: one
  button (`dash-customise`, aria-expanded, label Customise / Done, icon-only under 560 px), sticky bar with Reset
  (keeps pins), per-section Move up / Move down (native `icon-btn` buttons with aria-disabled at the ends, so they still
  announce) and Hide / Show with the focus rules of spec 6.3, Esc leaves unless a dialog, menu, listbox or popover holds
  it, a one-shot `.motion-ring` on a moved section (skipped under reduced motion). `useLastSeen` returns `lastSeen` and
  `firstVisit`; Clear, `clearedAt`, `orgai.dashboardClearedAt`, `statusSentence`, HeroBand, ActivityStrip, Paused and
  Recently ended are gone. Display name: `lib/dashboardName.ts` `saveDisplayName` (serialised read-merge-write; clearing
  sends an own `displayName: undefined`), shown only in the salutation, the popover input and Settings > General >
  About you `display-name-input`. Time working = per run `max(0, wallMs - idleMs - waitingMs)`: `limitHoldMs` is not
  subtracted because a usage-limited run's turn ends and its hold sits inside idle time (runManager timers). Inline
  answers and `NeedsInline.tsx` / `lib/needsInline.ts` are unchanged (rules in ARCHITECTURE.md). Checked by unit tests
  (dashboardLayout, dashboardBrief, dashboardName, waitingOrder, resumeRows, todayModel, weekRecap, activityStrip,
  dashboardBand, dashCaps, dashboardProjects, dashboard), `e2e/dashboard.mjs` (rewritten against spec 12 and 13) plus
  proposals / usage-app selector updates, and a Reviewer pass (no Critical or High). Open items and what was not
  verified: spec section 17 "Implementation notes".
- (History: superseded by "Dashboard and Usage redesign (2026-11-21)"; the greeting stat tiles, lead band, attention tiles, footer, strip, share bar and Today rail described here are gone.) Dashboard visual pass and board (2026-11-20; spec `docs/design/dashboard-overhaul.md` section 18 "Visual pass", which
  overrides section 3 and parts of 7 and 9 for drawing only; data and behaviour as above). Sections are cards
  (`.dash-section`: `--surface-1`, `--radius-lg`, `--border-subtle`, `--elev-1`, a `.dash-section-icon` chip from the
  `icon` prop of `DashSection` / `AttentionSection`). Project identity: tokens `--project-1..8` and `--project-ink` in
  every theme block (measured: ink on hue 10.5-14.9 dark, 5.0-7.3 light; hue on `--surface-1` >= 4.8); pure
  `lib/projectIdentity.ts` (`hashedHue` FNV-1a of the id, `assignProjectHues` collision-free in stored project order,
  `registerProjectHues` called by DashboardView every render, `projectHue`, `projectMonogram`); `ProjectBadge.tsx`
  (`dash-project-badge[data-project][data-hue]`, aria-hidden, sizes xs/sm/md/lg); any element with `data-hue` gets
  `--dash-hue`. Page: greeting with stat tiles (`dash-hero-stat[data-stat=waiting|working|finished|today|spend]`, pure
  `lib/heroStats.ts`; a button to its section's h2 when that section exists, else a static figure; the brief stays as
  the sr-only accessible summary `dash-greeting-brief`), then the lead band `.dash-lead` (left `.dash-lead-main`:
  Waiting on you as attention tiles `dash-attn-tile[data-kind=decision|reply|team]` from pure `lib/attentionTiles.ts`,
  `AttentionTile.tsx`, the all-clear card `dash-needs-clear`, and To finish setting up; right `.dash-lead-side`: Commits
  this week `dash-commits`, `CommitsSection.tsx`, pure `lib/commitChart.ts`), then six arrangeable sections (the layout
  model gained `engagements`, inserted at its default place before Projects by `normalizeLayout`): Pick up tiles, Today
  time rail (pure `lib/scheduleRail.ts`) and to-do cards, Working now run cards with agent marks and a plan bar
  (`dash-now-plan`), Your week stat blocks, a 72 / 96 px ledger and the share bar `dash-week-share` (pure
  `lib/projectShare.ts`, `WeekShare.tsx`), Engagements `dash-engagements` (`EngagementsSection.tsx`, pure
  `lib/engagementTiles.ts`), Projects tiles with a hue band and a 7-day sparkline `tile-spark` (pure
  `lib/projectSparkline.ts`). Reply tiles summarise the root's newest non-harness text block from the store's
  transcript through `plainSummary` (text only, each line capped at 400 characters before any pattern, linear separator
  test: Reviewer High fixed). Commit data: `window.orgai.projects.commitActivity` through a feature-detecting accessor
  (desktop, read-only, once after first paint and on a work run's end, at most every 10 minutes); Engagements reads
  `engagement.listNotes` and `knowledge.get` for at most the shown engagements through its own project queue, retired
  items not counted. Motion: the board rises in (`.dash-page[data-entering]`, `motion-rise-lg`, `--dur-slow`, 30 ms
  stagger capped at 5) on the first Dashboard of an app session only, never under reduced motion or Pause motion; new
  attention tiles use `.motion-enter` after the arrival settle; nothing new loops. Checked by unit tests (projectIdentity,
  heroStats, attentionTiles, scheduleRail, projectShare, commitChart, engagementTiles, projectSparkline,
  dashboardLayout) and `e2e/dashboard.mjs` (VP checks: two text lines per tile, one hue per project across sections, text
  alternatives, cards, Commits right of Waiting on you at 1600x1000, stat tiles focus their section). Not verified: the
  Commits chart with real data in e2e (the contract was not in the build worktree; the empty card was), Engagements in
  e2e, screen-reader speech, macOS, real data volumes.
- Cost and usage (#10): every cost goes through `lib/cost.ts` `costView` and `components/ui/Cost.tsx` (unknown is
  never $0, "$0.42+" is a lower bound). The run side panel has a Usage tab (`components/UsagePanel.tsx`, `SideTab`
  'usage'); History switches Runs | Trends (`components/UsageTrends.tsx`, `runs:usageStats`). App settings >
  Connections > Model prices is `components/settings/ModelPricesSection.tsx`; `lib/settingsTarget.ts`
  `requestModelPrice(model?)` deep-links to it with the model pre-filled. The account popover shows the quiet line
  `usage-no-five-hour` ("Five-hour window: not reported by your plan right now.", `UsageMeter.tsx` `missingFiveHour`)
  when a subscription report lists plan windows but no five-hour one (seen 2026-11-04 on a Max login: `five_hour:
  null` beside Seven-day and the Fable weekly window), and the sidebar footer bar shows the tightest reported window
  (`tightestWindow`); unit-tested in `components/usageMeter.test.ts`, not driven by e2e (the footer meter is hidden
  under the mock adapter).
  - Account row at a glance (2026-11-12): the row shows figures, not provider or login names. `UsageMeter.tsx`
    `accountRowView` (pure, tested) picks them: `5h 22%` and `7d 18%` (`rowFigures`; one if only one is reported; else
    the tightest model window as `Fable 20%`), a proxy's `spendRowFigure` ("$3.20 today"), else one or two words
    ("Claude", "API key", "Key not set", the proxy's name), or a problem word ("Not connected", "Error",
    "Connecting…", "Checking…", "Spend unavailable", "Mock adapter"). A figure at 80 percent or over (or limited)
    is semibold in warn/danger colour; `tabular-nums` and a 4ch value width keep it from shifting (`usage.css`
    `.account-fig*`); the 4 px bar still shows the tightest window. The old full sentence stays as the popover title,
    the tooltip and the trigger's accessible name, with the window names in words ("Claude, Claude Code login,
    five-hour 22 percent, seven-day 18 percent"). The live look is verified by unit tests and code reading only (the
    meter is hidden under the mock adapter).
  - LiteLLM spend by period (2026-11-04, walk + notes `docs/design/ux-review-litellm-periods.md`): the account row shows one figure from `lib/usage.ts` `spendRowLabel` ("LiteLLM · $3.20 today" with `UsageSpend.periods`, else the budget text); under about 244 px of sidebar `.sidebar-footer` (an inline-size container) hides the name to sr-only (`span.account-name`) so "$142.10 today" never clips, and the 4 px bar yields first; `title` and the rail name carry `spendSentence` ("LiteLLM spend: $3.20 today, $12.40 this week, $31.00 this month. $42.10 of $50.00 budget." / "... No budget set."). Bar and dot tone stay the budget level. The popover `SpendSection` adds a `dl` `spend-periods` (`spend-period[data-period=day|week|month][data-present]`, `spend-period-value`, `dt` title "Since <date> (UTC)" from `periodSince`; rows from `spendPeriodRows`), else `spend-periods-missing` showing the fixed `periodsNote`, then `spend-lifetime` ("Lifetime $X" from `lifetimeText`, only when `totalUsd` differs from `usd`), then the Stale line (`usage-stale`); the head figure is `spend-budget`. Dashboard Usage card: `spendRowFigure`, the bar, `dash-usage-periods` ("$12.40 this week · $31.00 this month"), empty text "No spend reported yet.". Helpers `periodText`, `spendRowLabel`, `spendRowFigure`, `spendSentence`, `periodsCaption`, `periodSince`, `lifetimeText`, `SPEND_PERIOD_LABEL`, `SPEND_PERIOD_ORDER` are unit-tested; the UI was hand-checked with a fake report through a throwaway hook (not in the repo) at both sizes and themes; never driven by e2e (the mock reports no LiteLLM spend) and never seen with a real proxy.
- Usage page (app-wide; spec `docs/design/usage-app.md`, contract ARCHITECTURE.md "App-wide usage overview"): store View 'usage' (not project-scoped), `usageFilters` / `setUsageFilters` (only period and bucket persist, localStorage `orgai.usage.v1`), `openUsage({ projectIds?, period?, day?, section? })`, `usageFocus`, `openUsageRun` (focusRun, side tab 'usage', `usageReturn`, so `SidePanel` `arrival` opens it at least 480 px wide under 1100 px for that visit, never saved). Entry points: sidebar `nav-usage` (rail too), View > Usage (`show-usage`, 'main', no accelerator, announces the scope), Dashboard `dash-strip-usage-link` (30 days; Enter on a strip day adds the Day chip), Trends `trends-see-all`, run Usage tab `run-usage-all`; atlas `usage`, `usage-efficiency`, `usage-runs` (`SURFACE_TARGETS` kind 'usage'). `lib/usageOverview.ts` (pure): periods, bucket rules, `overviewQuery` (period, kinds, projects only; limit 2000), `usageKindOf` (Chat wins over Ask), `needsClientFold` / `usageData` (server rollups unless a model, role, bucket, connection, no-price or Ask/Chat-within-work narrowing applies, then `foldRows` over the rows, `lowerBound` when truncated; a model chip shows the model's own cost and roles with unknown cost "Model cost per role is not recorded"), chips. `lib/usagePage.ts` (copy, deltas from a second query over the prior span, live refetch decisions), `lib/usageCharts.ts` (ticks, bucket fill, series, folding), `lib/usageEfficiency.ts` / `lib/usageRuns.ts`. Components `components/usage/*` on `panelProps.ts`; inline SVG only; `--chart-*` tokens in every theme block with measured ratios in tokens.css (`--chart-hatch` is `--surface-1`); every figure `Cost precision="page"` (`shared/view/cost.ts` `formatUsdPage`: 2 decimals from $1, 3 from $0.01, 4 above, "< $0.0001"; Dashboard and Trends not migrated yet). The run tab's old `.usage-panel` class is now `.run-usage-panel`. `scrollWithin` now honours the scroller's `scroll-padding-top`. Checked: unit tests for every lib above plus cost, appMenu, atlas, menuActions, scrollWithin, panelWidth; `e2e/usage-app.mjs` (in e2e:free; mock, two code projects, an engagement and a Chat with `[mock:no-price]` / `[mock:computed-cost]`, 1024x640 and 1600x1000, both themes: entry points, no $0 for unknown, coverage line, drilldowns and chips, focus never on body, keyboard on the plot / rows / efficiency grid, filtered-empty and first-launch empty, panels three across vs stacked, no page scroll, no layout shift from a live run) plus usage, dashboard, menu and self-help e2e; two screenshots looked at by eye (1600 dark, 1024 light). Reviewer: no Critical or High; M1-M7 and L2, L3, L4, L7, L8 fixed. Open: L1 (bars nest role=button segments inside a focusable group), L5 (several status regions, `aria-busy` on the root), L6 (test ids `usage-scope`, `usage-roles`, `usage-empty`, `usage-no-result-tag` exist on both the page and the run Usage tab), "Other" legend row does not open the Projects popover, the CSV ignores client-side narrowings (the status line says so), Efficiency uses the returned rows when truncated (it says so). Not driven: truncated, error / refresh-failed, legacy and all-unknown states (the mock cannot produce them), Months selects, More filters under 880 px, CSV contents, Day chip from the strip, screen readers, contrast by measurement in the app, macOS; no UX walk of the built page yet.
- (History: superseded by "Dashboard and Usage redesign (2026-11-21)"; the stacked bars, hidden readout, More signals, team timing disclosure and Definitions section described here are gone.) Usage page dashboard rework (2026-11-17; option D of `docs/design/usage-dashboard-options.md` plus `docs/design/usage-dashboard-motion.md`; as built in `docs/design/usage-app.md` section 20). Layout: one opaque sticky block (`.usage-sticky`: filter bar in one row, then an always-present line with the date, run count and chips, no Period chip, a hairline once the page scrolls); a four-tile KPI band (`UsageSummary`: Estimated cost, Tokens, Runs, Wall time; Cost/Tokens/Runs are aria-pressed toggles that set the chart metric, a sliding `usage-kpi-indicator`, one-line delta chips, an "N of M priced" chip that is the no-price link, sparklines with pointer scrub that moves the chart crosshair); the hero row (`.usage-hero`, equal heights) of `SpendPanel` (Group by rendered by the view into its header, Cost/Tokens/Runs, Compare with previous period, a Table button driving `ChartTable` in controlled mode, legend toggle chips above a full-width plot, crosshair plus `usage-chart-tooltip`, a hidden `usage-spend-readout`) and `BreakdownCard` (Project/Model/Role/Connection tabs, only the active panel mounted, sliding `usage-where-indicator`, top-5 one-line ranked rows); Efficiency as a four-measure strip with "More signals"; Runs worth a look (3 rows, expandable `usage-run-toggle` / `usage-run-detail`) and Cost by tier stacked (side by side only from a 1500 px container); All runs and definitions closed. Interaction state lives in `UsageView`: `chosenMetric`, `hidden` series (reset when the period or projects change), `overlay` (off), `highlight` (both ways between legend, segments and project rows; a hidden series is never highlighted), `scrub`, `tweenKey` (bumped by user filter changes only; a bump arms the tween for 5 s). A row, segment or bar narrowing neither opens All runs nor scrolls (only the priced link opens it). `previousQuery` now uses the chart's bucket so the Compare overlay lines up. Motion only on user changes: KPI bar and tab underline slide (`--dur-slow`), metric morph and legend toggle via WAAPI with a 120-segment cap, bucket-set change `.motion-fade`, compare fade, highlight dim 0.35, tab body `.motion-view` and row rise (6), FLIP reorder (8, armed 5 s after a filter change), number tween (rAF, skip under 1%, never from unknown), run detail `.motion-collapse`; every CSS rule has both reduced-motion selectors and every script reads `useReducedMotion()`; no sliding pill on segmented controls (motion.md 3.16 kept, owner). Checked: unit tests (`usageDashboard`, `usageSpend`, `tween`, `rankFlip`, `usagePage`, `usageCharts`), `e2e/usage-app.mjs` (tabs, metric switch, legend toggle, overlay, highlight, sort, crosshair/tooltip, Table button, scrub, run rows, one-row bar, hero heights, KPI tile heights, plot width, page height), `e2e/motion.mjs` (indicator durations, morph start, nothing under Reduce motion), `usage.mjs`, `layout.mjs`; looked at by eye on backdated mock data at both sizes and themes; UX walk `docs/design/ux-review-usage-dashboard-post.md`; Reviewer approve (no Critical/High; Mediums fixed). Open and unverified: see section 20.
- Usage, team timing and staffing (orchestration-efficiency 4.7; `lib/usageStaffing.ts`, pure, with tests): EfficiencyPanel shows Time to first spawn, Overlap (reportSumMs / reportBusyMs, "1.8x") and Tail (tailMs / wallMs) as medians over runs with `usage.efficiency.reports > 0` (`usage-timing`, `usage-timing-item`); `StaffingPanel` shows Cost by tier (`usage-staffing`, `usage-tier-row`, `usage-tier-table`) and Lead alone vs With reports (`usage-lead-row`; team work runs; lead alone = no efficiency record and one agent). `RunStaffing` and per-agent usage do NOT reach the renderer (UsageOverviewRow carries RunUsage only), so a tier is read from each model entry: the run connection's `tierModels` (store `connections`), else `tierForModel`; the remainder ("Not tied to a tier") = total - tiers, so parts add to the total (rows-only total when main truncated). Unverified in the app: no e2e run, no screenshot.
- Settings overhaul (2026-11-22): one Settings view, plain-language pane names, galleries and the runtime-backed rows.
  Merged into "Settings, UI overhaul" at the end of this file; the older "Settings pages" bullet below is history for the
  pane names and the Advanced disclosures (the disclosure rules still hold).
- Settings pages (2026-11-03, `docs/design/config-review.md` + Implementation notes; ARCHITECTURE.md "Settings
  pages"): App panes General (Appearance, Notifications, New projects; Advanced: Motion and canvas, Assistant models,
  New projects (advanced)), Connections (cards; Advanced: Costs, Model prices), Connectors, Skill library, About; the
  Defaults pane is gone and its old ids open General. Project panes General (with the Connection section),
  Permissions (`PermissionsSection`, replaced Agents), Limits, Maintenance; stored ids agents / connection / tools map
  over, Plugins moved to Team > Catalog. Each pane has at most one closed "Advanced settings" disclosure
  (`settings-advanced[data-pane]`, open state in localStorage `orgai.settingsAdvanced.<paneKey>`; deep links open it).
  `requestAppSettingsSection` targets: `appsettings-section-connections`, `-model-prices` and `-costs` (Connections),
  `-assistant-models` and `-new-projects` (General), `-mcp-library`, `skill-library`, `-about`; the Chat start page
  (`chat-model-change`), `AssistantModelLine` and the MCP assist dialog's "Change in App settings" go to Assistant
  models. Store: `defaultConnection` from `ConnectionInfo.isDefault`, `defaultConnectionChosen` /
  `defaultConnectionStored` from settings, `setDefaultConnection(id | null)` the only writer. Testids:
  `settings-advanced[data-pane]`, `new-projects-section`, `default-mode-select`, `*-model-row-select`,
  `default-connection-badge`, `default-connection-mode` ("Chosen" only on the user's pick, "Automatic" on a fallback),
  `connection-make-default`, `connection-default-auto`, `connection-default-error`, `connections-live`,
  `community-prices-row`, `project-connection-line`, `proxy-family-notice` (only with other-family roles),
  `project-start-refusal` (`lib/remap.ts` `startRefusal` = shared `mixedFamilyRefusal`), `project-path`,
  `permission-mode-tradeoff`, `permission-mode-default`, `permissions-summary`, `permissions-summary-toggle`,
  `team-assistant-select`, `plan-guard-line`, `new-project-connection`, `new-project-connection-change`,
  `chat-model-change`, `role-model`, `role-model-advanced`, `role-exact-model`, `role-effort`,
  `role-effort-unsupported`, `plugin-add`. Removed: `role-tier-badge`, `catalog-plugin-settings`, `tools-team-pointer`,
  `open-team`, `skill-settings-section`. e2e (mock, Anthropic only): connections.mjs checks the panes, Advanced
  disclosures and deep links, the default badge, `project-connection-line` and the role Model select (`role-model`
  inside `role-model-fold`); assistants.mjs checks `chat-model-change`; permissions.mjs checks the Permissions pane,
  its summary toggle and the Limits pane (`plan-guard-line`). Not driven by e2e: `new-project-connection`,
  `role-exact-model`, make-default, Back to automatic,
  setDefault refusals, the multi-connection project cards, the LiteLLM notices and the unsupported-effort note
  (`defaultMode`, `defaultChangeAnnouncement`, `startRefusal` and `lib/roleModels.ts` are unit-tested).
  - Fix-up after the re-walk (39e0da6, `docs/design/ux-review-config-2.md` "Status after fix-up", config-review.md
    Implementation notes): deep links inside settings scroll with `lib/scrollWithin.ts` (only the nearest scroll
    container; shifted ancestors, html and body are reset), never `scrollIntoView`; e2e `lib.mjs` `windowShift(page)`
    checks the window did not move. The plan guard line is `lib/settingsCopy.ts` `planGuardLine(mode,
    maxWindowShare)`: automatic moves to the everyday tier past 80% of the weekly window, a run that reaches a plan
    limit pauses until it resets, and the five-hour share sentence appears only when a share is set.
    `PERMISSION_MODE_SHORT` (settingsCopy.ts) is the one short-name table for App General, project Permissions and the
    permission card. `perm-settings-link` targets the `rules` section (Permissions pane, disclosure open, "Saved
    permission rules" focused); `team-assistant-settings` (gear in the Team assistant tray) opens Permissions >
    Advanced with `team-assistant-select` focused (`lib/openProjectSettings.ts`, `PROJECT_ADVANCED_SECTIONS` in
    settingsTarget.ts). Role panel: `lib/roleModels.ts` `exactModelValue` (Exact model shows a pinned id only for a
    Custom role; "Not set" returns to the saved tier) and `roleChipLabel` (the org chart node chip shows the tier word,
    the model id in its tooltip). Assistant lines share `lib/assistantModels.ts` `useAssistantRunsOn` /
    `assistantModelLabel` / `runsOnText` ("Runs on Everyday tier (sonnet) via Anthropic"); `assistant-models-note`
    names the default connection. e2e (mock, Anthropic only): assistants.mjs checks the "Runs on" wording on the MCP
    and Skill lines and the dialog hint plus `windowShift` after every Assistant models link at both sizes;
    connections.mjs the App deep links' window shift, the shared mode names, the note and one "Model" in the role fold;
    permissions.mjs the plan guard line with and without a share, the card link landing on the open rules,
    `team-assistant-settings` in one click and the review switch's reason; team.mjs Exact model Not set and the
    custom round trip (skipped when the mock catalog has no id outside the tiers). Unit tests: scrollWithin,
    settingsCopy, roleModels, assistantModels, settingsTarget, permissionCopy. Non-Anthropic connections are not
    driven. Open: N7, N9, N13 and the Lows in ARCHITECTURE.md Risks.
- Application menu (renderer; `docs/design/ux-review-menu.md` Implementation notes): `lib/menuActions.ts` holds
  `routeMenuAction` (installed once by `lib/useAppMenu.ts` through `installMenuRouter`, also fed by `window.orgai.onMenuAction`
  and by `runMenuAction` from keydown handlers; unknown names ignored, never throws), the store fallbacks, `menuStateFor` /
  `menuStateChanged` (the five `MenuState` booleans, sent once on mount and then only on change), `announceMenu`, the one
  `SHORTCUTS` table, `openRunWindow` and `closeCurrentTab` (shared by Ctrl+W and Window > Close tab). A screen-local handler
  from `lib/menuRegistry.ts` runs first; it returns the sentence to announce when the action does not apply, else the store
  fallback runs. Announcements use the run tabs' `tabNotice` when a project is in the run view, else the app-wide sr-only
  status region `menu-announce` in `components/AppMenuLayer.tsx` (which also mounts `KeyboardShortcutsDialog`,
  `keyboard-shortcuts-dialog`, styles in `styles/menu.css`). `useRunTabShortcuts` routes Ctrl+T / Ctrl+W through
  `runMenuAction('new-run' | 'close-tab')`; LiveRunView registers the canvas, Hide finished, Show conversation and Go to
  decision handlers (Ctrl+. / Alt+D call `runMenuAction('go-to-decision')`, no tray guard), RunActions registers Save chat
  as project and Org retrospective only while they apply. The `run-tabs-notice` status span is always mounted and
  `setTabNotice` clears and re-sets a repeated text (a per-call sequence, so an older timer never clears a newer notice;
  Reviewer M1). A click on a greyed native item never reaches the renderer; only key presses or stale commands announce.
  Unit-tested (menuActions.test.ts, mocked store and window) and e2e/menu.mjs (in e2e:free; mock, 1024x640 and 1600x1000,
  dark and light: items clicked through `Menu.getMenuItemById(id).click()`; Team enabled/greyed, View > Team, New run and
  Ctrl+T one draft, Show conversation, Interrupt enabled while the session is open, Org retrospective on a live run
  announced, the shortcuts dialog with Esc and focus back, New chat, About, Ctrl+T on Projects announced). Not driven:
  macOS (Cmd keys may run twice if both the menu and the keydown fire; reviewer L2), run-scoped windows, canvas zoom/fit.
- Proxy connections (renderer, 2026-11-06; spec `docs/design/proxies.md`, pre-walk `ux-review-proxies-pre.md`): `lib/connectionLabel.ts` `connectionLabel(id)` is the one name (Anthropic, OpenAI, a proxy's name, "Removed proxy" when the id is not in the loaded list, "Proxy" before load; the store fills `setConnectionRegistry` and reloads on `connections.changed`); `connectionKindLabel`, `isProxyId`. Never write "LiteLLM" for a proxy; `CONNECTION_NAME` (shared) is no longer used by the renderer. Connections pane: `proxies-heading`, `proxy-add` (inert at PROXIES_MAX with `proxy-add-reason`), `proxies-empty`, `proxy-dialog` (`proxy-name`, `proxy-kind`, `proxy-anthropic-url`, `proxy-openai-url`, `proxy-models-url`, `proxy-key`), `connection-card[data-provider=<id>][data-kind=proxy]`, `proxy-save`, `proxy-test`, `proxy-delete-key`, `proxy-remove` (+ `proxy-remove-reason`), `proxy-checks` / `proxy-check[data-check][data-ok]`, `proxy-reports-note`, `proxy-models-host-note`. Pickers group by connection with the family (`lib/assistantModels.ts`, `lib/modelFamily.ts`, `ModelSelect`); on a proxy project Exact model is in the main role panel. New project: `new-project-connection-select` (two or more connected; else the `new-project-connection` sentence); the project is created on the default and then switched with `projects:remapModels` (no contract field; a failed switch holds the form and starts no setup). Project settings: `project-connection-option[data-id][data-state]` radio list. Usage: `spend-not-reported`, `dash-proxies`, `model-prices-unreported`; a proxy that reports no spend/prices says "not reported by this proxy", never $0 or "yet". e2e: `connections.mjs` (rewritten: proxy add/test/edit/delete key/remove refused then removed, four proxies and PROXIES_MAX, both sizes and themes), `project-connection.mjs` (in e2e:free), proxy blocks in `assistants.mjs` and `team.mjs`. Verified on the mock host only (reviewer: no Critical or High; M1-M3 fixed). Not seen: a real proxy, a LiteLLM-kind proxy that reports spend/prices, the sidebar footer with a proxy (hidden under the mock), screen reader output, the scroll-past-5 radio list. Open Lows from review: dialog closable while busy, no focus on invalid submit, card landmarks, store entries of a removed proxy linger. `npm test` has 7 failures in `src/cli/tui/*` (ink colour assertions) in this worktree, untouched by this change.
- Multi-provider org charts (renderer, 2026-11-07; spec `docs/design/multi-provider.md` "Renderer", pre-walk `ux-review-multi-provider-pre.md`): `lib/roleConnection.ts` (pure, unit-tested) turns connections:list into defaults.ts input (`connectionsViewOf`, `connectionStatesOf`), words problems ("Reviewer runs on OpenAI, which is not connected. Connect it in App settings or change the role's Runs on."), `ownConnection` (main's switch rule: a non-root role with any valid `connection` is kept on a switch, even when it equals the project's), `isPinned` (differs from the project's: tags and chips), `runsOnOptions` / `showRunsOn`, `connectionTag` / `connectionTagTitle`. Team role panel: `role-runs-on` first in the Model fold (2+ enabled connections or a pinned role, never the root; '' = Project default; a removed or turned-off pin stays as its own option; `role-runs-on-problem` with aria-invalid, `role-runs-on-hint` says what a change did to the model: a custom id the new connection does not serve or an unmapped tier falls back like Exact model's Not set); Model, Exact model, tiers and `role-effort` follow the role's connection, `role-effort-unsupported` names it. Chip `role-model-chip[data-connection]` "Everyday · OpenAI" only when pinned elsewhere (also in the node's aria-label); fold summary likewise. Live: `agent-connection` on agent cards, the side panel agent line and FinishedList when an agent's connection differs from the run's; UsagePanel `usage-connections` / `usage-connection[data-connection]` with 2+ entries. Project settings: `project-connection-roles-line`, Role models rows `role-model-connection`, remap dialog `remap-kept` / `remap-kept-role`, `project-start-refusal` from `lib/remap.ts` `projectStartRefusal` (role problems first, then `mixedFamilyRefusal`; other-family proxy roles never refuse, `proxy-family-notice` says they run as bridged reports); TierEditor previews projects with any role on the edited connection. New run: `new-run-start-refusal` (warning, Start stays enabled, hidden in Ask mode). e2e `e2e/multi-provider.mjs` (in e2e:free; mock, two mock proxies, both sizes and themes). Not seen: a real second provider, the By connection table and the disconnected (live status) wording by eye, compact node styles with a tag, screen reader output.
- Usage and skills walkthroughs on mock data: `docs/design/ux-review-usage-skills.md` (placement of the usage and skills UI, parts A and B), `ux-review-usage-2.md` (usage UI re-walk) and `ux-review-skills-2.md` (skills UI re-walk at 1024x640 and 1600x1000 in both themes plus a keyboard pass; the native Add from folder picker was not driven).
- Walkthroughs on mock data are in `docs/design/ux-review*.md`. The newest, `ux-review-runs-2.md`, predates the brief A
  run-view merge, so its N1 tray finding needs a re-walk. N2 (run windows miss pending decisions) and the focus and
  wording items are still open.
- Run staffing display (spec `docs/design/orchestration-efficiency.md` 4.7; not driven by e2e, not looked at in a live app): `lib/runStaffing.ts` (pure: newest assignment per agent via `assignmentOf`, `tierEffortLabel` "everyday / medium" never the model id, `staffingReason` words every `source` and appends the note) and `lib/planGraph.ts` (thin over `src/shared/planGraph.ts`, the one definition also used by main `continuation.ts` `readySteps` / `pathOverlaps` and the TUI: ready = pending, every existing `after` done or skipped, plus the later of two path-sharing parallel steps waits; missing ids ignored, cycles end, never throws; `planHasGraph` = any step with `after`, `paths` or `staff`, and without it nothing new shows). Three places, all silent for the orchestrator, older runs and plans without the graph: the card-style canvas node's sub line (`agent-staffing` chip, hover = reason and model; compact styles get it in the tooltip and sr-only line), the side panel agent header (`<details>` `agent-staffing-detail`: summary `agent-staffing-summary`, body `agent-staffing-reason`, `agent-staffing-model`), and the run meta line (`run-meta-staffing` with `run-meta-working`, `run-meta-ready`, each only above zero; hidden under 420 px with the agent count). Plan tab steps get `plan-step-state` (data-state running | ready | waiting; "Waiting on A, B and 2 more", titles cut to 28 chars) and `plan-step-staff` ("reviewer, everyday / medium"). Counts: working = agents in a working state, shown once the run has assignments or the plan has the graph. Not built: the pocket-office inspector, Dashboard and finished list rows show no staffing.

- Run staffing controls (`docs/design/orchestration-efficiency.md` 4.7; not driven in the app, unit-tested only): `lib/roleStaffing.ts` (pure) is the one place for the copy and the writes; effective values come from `effectiveRoleStaffing`, `staffingModeOf`, `staffingGoalOf`, `reviewPolicyOf`, nothing is re-derived. Role editor: `components/team/RoleStaffingControls.tsx` under the Model picker in the Model fold (`role-staffing`, `data-kind` root | exact | editable, `role-staffing-line`, `-note`, `-explain`, `role-staffing-mode`, `-min-tier`, `-max-effort`); the mode select's "Follow the project" clears `Role.staffing`, "Always" keeps no bounds, a floor or cap makes the role explicitly automatic; the root and exact-model roles get a line and a sentence but no controls. Project settings: `components/settings/StaffingSettings.tsx` is a "Run staffing" group inside the Limits pane's Advanced settings (it was a section at rest until the 2026-11-10 gate: `e2e/permissions.mjs` allows the pane two tab stops at rest) (`project-staffing`, `project-staffing-goal`, `project-review-policy`, segmented controls); choosing the default writes `undefined`. Import dialog: `import-spend` hint under Model, from the previewed `preview.roles` entry. Kit preview: `kit-role-spend` appears only when a `KitPreviewRole` carries `model` (it does not yet; `KitPreviewRole` has no model, effort or staffing, and `src/shared/types.ts` plus `main/kit/format.ts` `parseTemplate` must add them).

## Run settings row: Model, Effort, Permission, Goal (2026-11-10)

Spec: `docs/design/ux-review-run-start-pre.md` (H1-H3, M1-M8). Contract: `StartRunInput.modelSelection` / `effort` /
`permissionMode`, `RunSummary.rootEffort` / `permissionMode` / `permissionModeChosen` / `sessionPermissionMode`,
`runs:setPermissionMode` and the `run.permissionMode` event (src/shared/types.ts).

- Pure rules: `lib/runSettings.ts` (+ test). Defaults are what main would run anyway (`defaultRunModel`: Team = root role
  model on the project connection, Ask = `AppSettings.quickRunModel` through the tier mapping; `defaultRunEffort`: root
  role effort, none for Ask). `startChoicesToSend` sends only what differs, and never an effort the model's adapter does
  not take (`fitEffort` clamps down, the UI says so in `run-effort-fallback`). Narrowing/widening mirrors main's
  `canNarrowPermissionMode` (a parity test loads main's module by path). `permissionModeEventPatch` /
  `applyPermissionModePatch` read the `run.permissionMode` snapshot structurally (useAppStore replaces all three fields);
  `modeInForce` / `modeInForceLabel` show a card's accept-edits grant ("· edits accepted this session") without changing
  the run's own mode. `livePermissionOutcome` always shows main's reason and the running-reports count, applied or not.
- Components: `components/runSettings/` (`RunSettingsRow` group `run-settings[data-surface=start|live]`,
  `ModelPickerList` + `useModelCatalog` shared with `LiveModelSwitch`, `StartModelControl`, `EffortControl` /
  `EffortReadOnly`, `PermissionModeControl`, `LivePermissionMode`, `GoalControl` / `GoalReadOnly`), styles
  `styles/run-settings.css`. Every chip is one Tab stop with a Popover; `data-default`, and `data-tone=warning` plus a
  ShieldAlert icon for auto and acceptEdits; bypass is the danger tone with ShieldOff.
- Effort is a native radio `SegmentedControl` ordered least to most inside a popover (the "slider": arrow keys step,
  every level named; a native range would hide the names). Live it is read-only: the contract has no mid-run effort.
- Permission: the picker stages a choice and "Use this mode" applies it, because native radios fire change while arrow
  keys pass over options (applying on change would open the bypass confirm on the way). A widening (`isWideningMode`)
  goes through `ConfirmDialog` (`run-permission-confirm`, danger for bypass, cancel "Keep current mode"); narrowing
  applies at once. Live outcomes: `run-permission-note` (visible, `data-tone` ok | saved | refused) plus sr-only
  `run-permission-status`; thrown refusals in `run-permission-error`. A refusal while the run is replying offers
  `run-permission-interrupt` ("Interrupt and change": one interrupt, bounded wait for idle, one retry; blocked by open
  decisions or active reports like the model switch). Ended runs read "Permission: Next message: <mode>" and show the
  mode the continuation will carry. Open permission cards are never touched. The control is hidden on setup-like and
  assistant runs (`runPermissionModeChoices` empty); Chat shows only modes its adapter keeps.
- Choices are per run: never written to the project, not remembered across starts; they survive a refused start
  (Composer keeps the draft, `composer-error` shows main's text without the IPC prefix) and reset after a successful one.
- Live row placement: a fixed bar at the top of `.live-composer-region` (`live-settings-bar`), not inside Composer's
  `settings` slot: the slot remounts `LiveModelSwitch` when an ended assistant swaps the composer, which cancels a model
  handoff in flight (`e2e/model-switch.mjs` caught it). Visual order is therefore chips, then "Replying to X".
- RunMeta: `run-meta-permission[data-mode]` for every work-run mode except plain "Ask for everything risky" (auto keeps
  `run-meta-unattended`), "(this run)" when chosen, and the session grant.
- New run page fixes: Goal is a labelled chip ("Optimise for": Balanced / Faster / Cheaper), placeholder no longer
  repeats the hint, Ask's duplicate line is gone, one-sentence lead, composer widened to 768 px (shared `.new-run-inner`,
  so the Chat and instruction start pages widened too), role chips capped at 5 plus `new-run-more-roles`, label always
  "New run" / "Ask one assistant", setup pending shows `new-run-skip-setup` "Start without setup" (secondary) and no
  settings row, focus lands in the live composer textarea after Start.
- `ui/Popover` places itself again when its content resizes (a ResizeObserver while open, only when the panel's
  offsetWidth / offsetHeight differ from the last placement, so it cannot loop): the start model picker grew past the
  window after its catalog loaded. Focus moves into the panel in a requestAnimationFrame after placement, to a search input
  (`input[type=search]`) if present, else the checked radio (`input[type=radio]:checked`), else the first control, retried for a few frames, and a control the content already
  focused (the model picker's search box) is kept. Cause of the old "Enter leaves focus on the chip": on a popover's
  very first open the focus call ran inside the `toggle` event task, before the panel was rendered as an open popover, and
  was silently dropped (later opens worked, keys did not matter). This applies to every Popover user; no other screen's
  e2e changed.
- Interrupt and change (`LivePermissionMode`): the note stores `covered` (the baseline the choice or its confirmation
  was measured against) and `seen` (the mode in force when it was written). A `run.permissionMode` event that moves the
  mode in force clears the note; if a retry would now widen (`retryNeedsConfirm`, checked before the interrupt and again
  after the wait for the boundary) the same `ConfirmDialog` (`wideningConfirmOptions`) is shown, declining clears the
  note. A result for another run of the chain (`result.run.id !== run.id`) says "This conversation continued
  elsewhere..." and never claims the mode changed. Start page: a staged mode resets when the project's own mode changes,
  and Start confirms a staged widening that was not confirmed against the project's current mode (declining restores
  the draft with no error banner). Permissive options in the list carry the hidden icon (ShieldAlert, ShieldOff for bypass) (`run-permission-option-icon`);
  "Use this mode" is guarded so a double click opens one dialog.
- The start model default always uses the project's connection: `Role.connection` is ignored on the root
  (`defaults.ts` `roleConnection`, `Role.connection` doc, main `runManager` / `claude.ts`), so a stale value on the root
  role does not move the chip or the "same as default" test (unit-pinned in `runSettings.test.ts`).
- RunMeta on an ended or paused run shows the chip's value (`metaPermission`: `livePermissionValue`, not what the finished
  session ran with), prefixed `Next message:` (`data-next=true`) only when it is a pending user choice
  (`permissionModeChosen`); the chip's prefix follows the same rule. The plain default stays hidden.
- Tones: `permissionTone` (Bypass = danger with a ShieldOff icon on the chip, the list and RunMeta; Unattended and
  Auto-accept edits = warning with ShieldAlert). The "Default" tag is gone from every chip (an untouched default keeps
  its tone, only a picked change says "Changed"), which also lets the row fit on one line at 1024 and 1600. The reset link
  is one string (`RESET_TO_DEFAULT_LABEL`, "Use default") for model and effort.
- "Interrupt and change" is replaced by a hint while a decision is open or reports run (read from the store, so it comes
  back when they close) and is withdrawn when the mode in force moves (retry offers only; outcome sentences stay).
- Chat / assistants: no settings row on the Chat start page because `QuickRunInput` carries no model, effort or mode (the
  page keeps its summary line and "Change in App settings"); the live Chat chip resolves a tier alias ("everyday") to the
  catalog's friendly label through the connection's tier mapping and keeps the exact setting in the title; every assistant
  start (`showStartedAssistant`) puts focus in the live reply box like a project start.
- Popover first-open focus: reproduced with the e2e driver on the first open of every popover (Enter or Space alike); a
  hand walk that opens one before, or waits, sees it work. Whatever the cause of the walker's difference, the new
  rAF focus step is covered by run-start section 9 on first open.
- Not done (L3): when a project change narrows a run to Plan / Don't ask main drops the accept-edits grant, but the native
  session may keep accepting edits until it restarts. The `run.permissionMode` snapshot cannot say why a grant went away
  (a user change, a project change or a session end look alike), so the renderer shows no "may still accept edits until
  restart" suffix; it needs a contract field.
- Checked: typecheck, renderer unit tests (runSettings 27 tests, runGoal), build, `e2e/run-start.mjs` (start page, refusal
  with a real main refusal, widening confirm/cancel, saved-for-next-message, keyboard order and Escape, both themes and
  sizes), model-switch, runs, layout, permissions, assistants, engagement2. Run-start sections 5, 6 and 8 (applied
  mid-run change, `[mock:mode-refuse]`, `[mock:mode-reports-unchanged]`) needed the merged tree with the adapter's mock:
  the orchestrator ran `e2e/run-start.mjs` on merged dev d4258a4a and all checks passed.
  Unverified: real Codex effort fallback and Codex turn-boundary refusal, multi-connection pickers, screen-reader speech,
  reduced motion and forced colours, 320 px reflow, the stale "Interrupt and change" path in the app (the idle mock cannot
  stage a mid-reply refusal; the decision is unit-tested). Popover focus-in on first open is now asserted by run-start
  section 9 (it was a NOTE).

## Mid-run roster (2026-11-18)

An org chart a work run proposes and the user approves is usable in that run. The store keeps `RunState.roster`
(`run.roster` replaces it; runs loaded from a record carry it through `stateFromRecord`). `lib/runRoster.ts`
(`rolesForRun`, `resolveRunRole`, `runRoleColor`) resolves an agent's role from the roster first, then the project's
roles. Readers: live canvas colours (`LiveRunView`), the decision card avatar (`DecisionCard`) and the dashboard band
(`BandRunIn.roster`, part of `bandSignature`). Agent names and the side panel role label come from the agent itself and
Pocket Office people use agent names only, so they need no lookup. A removed role stays in the roster, so agents that
started on it keep their colour. Copy: the org chart card's effect line is `orgChartEffectCopy` (now / after-turn; other
effects keep the generic line). After-turn says new and changed roles can be used once no agent is working and the session
restarts (the Claude adapter waits for that, not for the turn end); both say removed roles stop being available at once.
The RunMeta note announces once per run and note (ref keyed by run id, never on mount or on a switch back); an approved outcome with `roster` leaves a RunMeta note (`rosterNextFor`, kind
`orgRoster`, never cleared by the card's own approve) listing deferred roles and OrgAI's reasons as plain text, announced
through the frame announcer. Checked by `runRoster.test.ts`, `proposalNext.test.ts`, `store/runRoster.test.ts`,
typecheck and build. `e2e/proposals.mjs` scenario 5 (`Staff up [mock:org-change]`) covers the flow and needs the mock
marker. Unverified: screen-reader speech, the deferred list at 1024x640 (the meta line wraps it; not looked at).

Card diff base (security fix): the org chart card diffs the proposed roles against `payload.runBaseline` (the run's own
roles when the card was created, set by main) when present, else the stored project's roles; `orgDiffBase` in
`shared/view/orgDiff.ts` is the one place that decides (an empty array counts as present). Without it a role whose
proposed prompt equals a pulled stored prompt showed as unchanged although approval changed the running run. The role
diff now also reads effort, staffing and connection (missing reads "none", connection "project default"), shown as
ordinary `field: from -> to` lines. A role the proposal leaves as the run has it is listed as unchanged. Checked by
`orgDiff.test.ts`; `ProposalCard` reads `runBaseline` through a local intersection type until `OrgChartProposalPayload`
declares it (drop the cast then). `e2e/proposals.mjs` ran without the field (Runtime Lead's change not yet merged).

Card reach lines (security review): an added role's row names what the new role may start and must delegate to
(`addedRoleLines` in `orgDiff.ts`: "spawns: A, B" / "spawns: any" / "spawns: cannot spawn (the listed roles are ignored)",
"must delegate to: A"), resolved against the proposed chart with the id as fallback, same wording as a changed role's
lines; they sit in the row's body (open the row), run through `showHidden` and count toward its hidden-characters badge.
A tier-only change (a concrete model with no tier gaining its own tier, or the reverse) shows "tier: none (fixed) ->
Everyday" because it flips staffing between fixed and automatic. Checked by `orgDiff.test.ts` and `e2e/proposals.mjs`
scenario 5 (root row names Roster Tester). Unverified: the added row's body at 1024x640 with a long spawn list.

## Run tabs: hide, re-enter, blank workspace (2026-11-18)

- `dismissRun` announces through `setTabNotice` only when a tab was hidden (sequence guard, repeated text re-announced, no own timer). Checked by `store/runTabs.test.ts` with fake timers (two hides in a row, no early clear); screen-reader speech unverified. Hiding a tab (X, Ctrl+W / Close tab, Delete, tab menu; all through `dismissRun`) also ends the session when `hideEndsSession` holds: root `idle`, `pendingDecisionCount === 0` and no non-root agent in a working state (`isWorkingAgent`). It fires `runs.stop` without awaiting (the hide, tab selection and ghost animation never wait on IPC) and says `HIDDEN_ENDED_NOTICE`; a refused stop keeps the tab hidden and says `HIDDEN_END_FAILED_NOTICE`. A usage-limit hold on an idle run is not visible to the renderer (only a `paused` status carries `pausedUntil`/`autoResume`), so it is not part of the rule. Otherwise the notice is state-true (`hiddenLiveNotice`): starting/running "It keeps working", idle with a card or working report, or stopping, "Its session stays open"; the Hide titles (`hideTitle` in `RunTabs.tsx`) say "Ends its idle session." or "The session stays open." from the same function. The sidebar run row menu has Close after a separator (`closeRun`: same hide path, ends the session of an idle, running, starting or paused run; `closeConfirmFor` asks via `useConfirm` first when live work or a card would end; focus falls back to the next or previous run row, else the project row). Checked by `store/runTabs.test.ts` (rule, rejection, closeRun), `e2e/runs.mjs` (idle mock run hidden with Delete ends: gone from listLive and the sidebar) and `e2e/context-menus.mjs` (sidebar Close on an idle run); the confirm dialog path and the working/card Close flows are only unit-checked, not walked in the app. The New run page heading comes from `otherRunsHeading` (decision-based `needsYou`: "1 other run needs you", "2 other runs keep going, 1 needs you"; the needs-you run's link gets " (needs you)"); unit tested in `runTabs.test.ts`.
- Re-entering a project (`openProject`) stays on the New run page when the user left it there, and `defaultRunToOpen(..., { hidden, startPage })` skips hidden chains in its fallbacks; only a run with an open decision opens over either. `settleWorkspace` passes `hidden`. Checked by `runTabs.test.ts`; `e2e/runs.mjs` and `assistants.mjs` still pass.
- `showStartIfNothing` shows the New run page when `openRun` of a history-only run fails to load (project, assistant and `settleWorkspace` paths). Checked by `runTabs.test.ts` (a history row whose record is missing); the failing-load path was not driven in the app.
- `cutWhile`: an agent showing "Needs approval" counts as waiting whatever its state; "Waiting for you" only on a non-idle agent (`runEnded.test.ts`).

## To-dos (2026-11-18)

- A project section tab "To-dos" (`App.tsx`, view `'todos'`) on every stored project and on Chat, never on the MCP /
  Skill assistants (`todoScopeFor` in `src/shared/view/todos.ts`). Its quiet count is the open items; no dot, pulse or
  toast when an assistant adds one. Placement reasons, behaviour and test ids: `docs/design/todos.md` "Renderer (as
  built)".
- `views/TodosView.tsx`, `components/todos/*`, `styles/todos.css`; data in a separate zustand store
  `store/todosStore.ts` (not useAppStore) that follows `todos:changed`. Agent-written title, detail and role name are
  text nodes only; shortened copies use `clampLabel`.
- Start session (`lib/todoStart.ts`) only fills the New run page or Chat start page composer with `todoStartPrompt` and
  focuses it; `linkedStart` wraps those two pages' `onSubmit` and calls `todos.linkRun` after the user's own send. A
  draft emptied without sending drops the link, and so does a send whose text no longer begins with the prefilled
  first line (`lead`). While linked, `TodoDraftNote` (`todo-draft-note`) sits under the composer, tied by
  `Composer`'s `describedBy`. The item's run link uses the run's own label (`R2: name`), "Session N" as fallback; an
  assistant item with a detail says "Saved context" on its disclosure.
- Checked: typecheck, build, `todos.test.ts` / `todoStart.test.ts`, Reviewer (no Critical or High; Mediums fixed).
  `e2e/todos.mjs` and `e2e/todos-edge.mjs` are in `e2e:free` and pass on the mock (2026-11-18). Not looked at in the running app (themes, sizes, keyboard, screen reader).

## Saves reach live runs: status line (2026-11-19)

- Main answers every desktop MCP / skills mutation with optional `liveRuns` (`LiveRunChange`); `projects:save` returns only the
  Project (its feedback is the run's log line, so the org chart editor shows nothing and has no "keeps its team" note).
- `lib/liveRunChange.ts` (pure, unit tested) words each line from what the user did (`LiveChangeAction`: grant, revoke,
  saved-ungranted, updated, changed) and the run's availability, status first and the run title last in quotes so truncation never
  lands before the effect: "Can use api-design now · run “Idle run”", "No longer uses Context7 · ...", "Has api-design; no role can
  load it yet · ...", "Updated X is in use now" ("in use now" is the one phrase for the generic wording). `inferAction` reads the
  action from the item list before and after a save (`serverReach` / `skillReach`: how many roles can use it);
  `useProjectSkills.update` names a text edit explicitly. A deferral's reason is only in the tooltip (`full`).
  `store/liveChangeStore.ts` (`reportLiveRuns(projectId, surface, liveRuns, action)`) keeps one note per project for 20 s, tagged
  with the surface that saved (`mcp`, `skills`, `role:<roleId>`); a later save replaces it, one without live runs clears it.
  `components/LiveChangeNote.tsx` (`projectId` + `surface`) is an always-mounted polite `role=status` region that draws only the
  note of its own surface, so one save is one visible line and one announcement. Rows have a success check icon and token text.
  While the project has a live work run the region reserves `--live-rows` rows (min-height in `mcp-library.css`), so the content
  below does not move when a line appears or clears.
- Reporting sites: `McpSection.applyResult` (covers ConnectedServices, dialogs, writers), `RoleCapabilities.applyResult` (its
  skill grant now goes through `skills.update`, so it reports like the Catalog) and
  `useProjectSkills.apply` (every skills mutation, import and suggestion; the role chooser passes `role:<id>` as its surface). Other `mcp.*` call sites that pass their own result
  elsewhere (Team-only editors) do not report.
- `ProposalCard` passes `{ otherLiveRuns }` to `proposalEffectCopy`: true for mcpServers / skills / orgChart cards when another open
  `work` run of the same stored project is in the store (no IPC).
- Org chart saves and events (2026-11-19, follow-up): main broadcasts `run.liveChange` (runId, projectId, `what`, `change`) once per live
  run per applied change, and again when a 'pending' answer resolves. `useAppStore.handleEvent` hands it to
  `liveChangeStore.reportLiveEvent` and returns (no run state). Exactly `what.includes('orgChart')` (every projects:save, also a
  grants-only one such as a skill removed in the role inspector; never the mcp:* / skills:* routes) is the 'orgChart' surface: one note
  per save (events of one save for several runs within 5 s share it, a pending line is replaced by its final one), drawn by
  `<LiveChangeNote surface="orgChart">` (placement changed in the re-walk fix below; an empty region is visually hidden but
  mounted). Any other event never adds a line (the result path already shows it); it only replaces that
  save's 'pending' line with the final answer, worded from the stored `action`. That is the dedupe: one save, one line, one polite
  region with text.
- Wording: `LiveChangeAction` has `orgchart` ("Org chart changes are in use now"). For `changed` / `orgchart`, the run's own
  `grants` word the line (`actionFromGrants`: "No longer uses api-design and Context7", "Can use a, b and 2 more now"; mixed
  directions keep the generic wording). `LiveChangeLine.details` are plain text rows under the line (rename `notes`, deferred
  roles "Name waits for the next run: reason", and a next-run `reason`), always on screen, never tooltip-only.
- Re-walk fixes (2026-11-19, `ux-review-live-changes.md` "Re-walk"): the org chart note is no longer in the footer (it grew to 248 px
  with four runs and `teamFiles.css` hides the footer under the approval card). Its one mount line is the last child of `FrameStage` in
  `TeamView`; CSS (`mcp-library.css`) makes it an absolutely positioned overlay at the stage's top right (width <= 30rem, max height
  min(11rem, stage - 2 rows), its own scroll, `pointer-events` only on the card), so it takes no layout room, nothing moves when it
  appears or clears and the approval card (in the tray below) is never covered. Deviation from "nothing floats over the canvas": it is a
  transient status (20 s), and it can cover the top nodes of a small chart meanwhile. Two or more runs show ONE summary row
  ("Org chart changes · 4 live runs: 2 now · 1 once idle · 1 from the next run", `summarizeLines`) that is a native `<details>`
  summary (Enter and Space; the summary stops Space reaching React Flow's window pan key, which cancels it) with the per-run rows
  inside (run title first and truncating, the effect wrapping, so rows never differ only in a hidden tail). A caveat every run shares is
  shown once above the rows; rows keep the order of the run tabs (the app store's run order), so a slow answer never reshuffles them.
  The region has `aria-atomic="true"`: the summary is one short sentence and a pending line replaced by its final answer must be read in
  full, not as a fragment. The catalog and inspector regions use the same component; the inspector's `role:<id>` notes carry a `part`
  (`connections` / `skills`) and mount under their own group header (skill grant and revoke under Skills, connection under
  Connections; the Skills chooser's `useProjectSkills` notes default to `skills`); the region reserves one row once a note has shown
  there (catalog: one row while a run is live), not one per run. A role inspector save through the project save (skill removed, a role's
  connection list narrowed) calls `expectInspectorSave` so its `run.liveChange` event (which carries grants) is drawn in the inspector
  under that group, not in the org chart note. `serverReach` names a connection by `serviceFor(spec).label` ("Context7", not the slug).
  Added / removed role and a prompt edit get their own wording ("Added X to this run", "Removed X from this run", "Updated X is in use
  now") from `roleChangeAction`, a diff of the roles the always-mounted org chart note tracks (`trackRoles`; the event does not say, so
  a rename or several changes at once stay generic). The note expires 20 s after the last answer (the final one replaces a pending one)
  and never later than 30 s after the save. Not verified: screen-reader speech; the role diff when the project list is updated by a
  route other than the renderer's own save (a stale roster gives the generic wording).
- Checked: typecheck, build, `liveRunChange.test.ts`, `liveChangeStore.test.ts`, `e2e/live-changes.mjs` (idle mock run: skill create + grant, role rename,
  status line wording, one visible line and one text-bearing status region per save, no layout move when it clears, run log lines,
  only harness notices added to the transcript, line inside the section at 1600x1000 and 1024x640 in both themes, screenshots
  looked at). The script now also covers the org chart line (rename note, prompt edit), the role inspector's "No longer uses", and
  four live runs answering one grant (now, `[mock:host-after-idle]`, `[mock:host-slow]` pending then final, `[mock:host-reject]` reason).
  Not looked at: the role-inspector and Connections placements in the browser, screen-reader speech, a run with a long title beyond the mock's, 'after-idle' / 'pending' on a live provider.

## Team tab phase 2: header, Add role, Start from, team files chip, notice row, role editor (2026-11-19)

- Spec `docs/design/team-tab-overhaul.md` sections 0 and 1 ("As built" notes there list every deviation). `views/TeamView.tsx` is
  mount points and state wiring; the UI lives in `components/team/TeamHeader.tsx` (in `FrameToolbar`: h1, role count, static
  `team-problems-chip`, empty `team-view-switch`, Layout menu `team-layout`, `StartFromMenu`, `TeamFilesChip`, `AddRolePopover`
  trigger `team-add-role`, the only primary), `TeamNoticeRow.tsx` (always in `FrameFooter`, fixed 32 px, `team-notice-row`),
  `AddRolePopover.tsx`, `StartFromMenu.tsx`, `ArchitectDialog.tsx` (the only Architect form: the tray's Design tab and `DraftPanel`
  with its quick draft are deleted, so `org-change-start` exists once; the tray keeps `OrgChangePointer` and its "Open the Architect"
  opens this dialog through `onOpenArchitect`; the store's `draftOrgChart` / `applyDraft` / `discardDraft` are dead code for phase 3), `TeamFilesChip.tsx` (replaces the deleted `TeamFilesLine.tsx`; `team-files-line` stays on its wrapper with
  `data-state` / `data-tone`; the commit confirm is owned by the chip and keeps review M2's note plus "Nothing is pushed."),
  `RoleDelegation.tsx`, `RoleModelSentence.tsx`, `RoleToolGroups.tsx`. Pure, unit-tested libs: `teamNotices.ts` (priority queue;
  the first-visit hint shows only when nothing else is in the row and is never counted in `+N`), `teamEdits.ts` (field-by-field
  Undo of add and re-parent), `teamPrefs.ts` (`orgai.teamLayout`, `orgai.teamHintSeen`), `startFrom.ts`, `toolGroups.ts`,
  `roleModelSentence.ts`, `delegation.ts` `delegationView`, `teamFiles.ts` `teamFilesChip` / `teamFilesPopoverSentence`,
  `roleOps.ts` `parentOptions`. CSS per owner: `teamHeader.css`, `teamStartFrom.css`, `roleEditor.css`, `teamFiles.css`, `team.css`.
- The Team editor no longer reads `useCanvasOptions()`: card nodes (220x96), `EDGE_TYPE[DEFAULT_STYLE.canvas.edges]` (bezier, not
  the spec's smoothstep), graph only, its own direction (`orgai.teamLayout`, top-down | left-right). `RoleNode` takes optional
  `data.team` / `data.layout` and its chip reads "Delegates to N". Pocket Office, Canvas style, Templates, Import, Auto-layout,
  the footer hint, `toolbar-undo`, the banner stack and `import-found` are gone from Team (OfficeScene and CanvasStyleButton stay
  for Live and App settings). `panActivationKeyCode={null}` on the Team ReactFlow: Space no longer pans, so it reaches buttons and
  `<summary>` (e2e/team.mjs checks Space on "Choose individual tools"). RoleInspector ignores an Escape that comes from inside a
  `dialog` or `[popover]` (TeamView's `focusNode` runs a frame later and used to steal the chooser's focus return).
- Notices: added / removed / now reports to with 12 s Undo; remove asks only when the role has reports; import and template notices
  keep their testids on the row's message element (`data-kind`). No "subagent" wording remains (`spawnNotice` / `moveNotice`
  reworded). The team files approval card no longer hides the footer: `e2e/live-changes.mjs` now asserts the notice row stays and
  Approve / Reject are inside the window and clear of it at 1024x640 and 1600x1000.
- Security recheck carry-overs: `reservedSlugs` (a slug named by a server's explicit `roles` and not the edit's starting slug is
  taken, for `renamePatch` and `slugFieldEdit`), `renameSnapshot` keeps the starting slug across re-snapshots of the same role
  and project, `slugFieldEdit` refuses a value with no letter or number ("An ID needs at least one letter or number."), and the
  store's debounced save applies only `mcpServers` from `projects:save`'s answer (`store/projectSave.test.ts`).
- Checked: both tsconfigs, `vitest run src/renderer src/shared`, build, and on the mock: e2e team, team-files, import, canvas,
  layout, org-change, proposals, connections, multi-provider, office, pocket-office, engagement2, skills, connectors, live-changes.
  Not verified: screen-reader speech of the notice row and the mixed tool checkboxes, the zero-roles popover state, the `+N`
  waiting list contents, the dot-before-open state of Start from in e2e (import.mjs reaches Team after the import wrote its memory).
- Security review fixes (M1, M2): M1 fixed: the debounced save applies main's `mcpServers` only when the store's list still equals what that save sent, so a quicker `mcp:upsert`/`mcp:remove` is never overwritten by a late answer (`store/projectSave.test.ts`, "keeps a newer server list"). M2 fixed: a new role's slug comes from `newRoleSlug` (`lib/roleOps.ts`: unique among roles and clear of every slug a server's `roles` names), so "QA!" beside "QA" gets `qa-2` and a role removed with Undo showing passes no connections to a same-named new one (`roleOps.test.ts`, "newRoleSlug"). Also: unnamed or off-catalog tools form the elevated "use other tools" group; notice text and scanned file names go through `showHidden`; the problems chip is out of the DOM until phase 4; Start from says "Imported" after an import this session (the scan cannot tell which agents the team holds).

## Team tab, UI overhaul (2026-11-22)

- As built, deviations, review fixes and open items: `docs/design/ui-overhaul/impl-team.md`. Plain tier words come from
  `lib/tierWords.ts` (`TIER_LABEL` in `lib/roleModels.ts`): Fast, Standard, Advanced, Most capable; stored values unchanged.
- New testids: `role-node-toolbar` (NodeToolbar on the selected role; buttons `role-node-add-report`, `-duplicate`, `-move`,
  `-remove`; actions through `components/team/roleNodeActions.ts` context), `role-menu-duplicate`, `team-add-group`,
  `team-import`, `team-theme` / `team-theme-menu` / `team-theme-org-chart`, `team-group-count`, `team-zoom-level`,
  `team-tidy`, `team-provenance` (+ `-plan`, `-review`, engagements only), `import-hidden-chars`. `team-role-count` keeps
  "N roles". The Team ReactFlow's Controls are custom ControlButtons (horizontal); `.react-flow__controls-fitview` stays.
- A NodeToolbar is portalled but React bubbles its events to the node wrapper: the toolbar row stops them (else a toolbar
  click re-selects the node). Checked by e2e/team.mjs sectionNodeMenu.
- Engagement styling hangs off `.team-editor[data-kind=engagement]` (TeamView root).
- The first-time-user walk `docs/design/ux-review-team-overhaul.md` (build 26e2fb41, mock data) found one High and eight
  Mediums; the code on dev 2026-11-23 still shows M3 (the Theme dropdown has one item) and M4 (Add group opens a popover
  titled "Add a role"); the rest (the clipped confirm sentence H1, toolbar clipping M1, labels lost at 1024 wide M2,
  keyboard route to the toolbar M5, truncated panel header M7, small chart at 1024x640 M8) were not re-checked. Import's
  "Another OrgAI project" and "Choose another" (M6) are wired to `importSources` now. See `impl-team.md` "UX walk".

## Scenes, UI overhaul (2026-11-22)

- Pocket Office and Factory Floor roots are transparent inside the run view's `.frame-stage`; the host owns the frame.
  The Office Show filter lives in `OfficeScene` (`lib/office/showFilter.ts`), the Factory one in `FactoryScene`
  (`lib/factory/showFilter.ts`, merged into the label layer's hidden set by `labelFocus`). Unit tested; checked by
  `e2e/office.mjs` and `e2e/factory-floor.mjs` (both renderers). Notes: `docs/design/ui-overhaul/impl-scenes.md`.
- Testids kept: `office-pause` moved into the Message log card; Find a worker moved out of `factory-controls` (the
  toolbar now holds Zoom out, Zoom in, Fit, Pause motion). New: `office-log`, `office-show-filter`,
  `factory-show-filter`, `factory-legend`.
- Deviations and open items are in `impl-scenes.md` (the 3D stations outside a Show filter are not dimmed, only their
  nameplates go; no Factory zoom percentage; the full-size live 3D floor in both themes was not looked at by eye).

## Settings, UI overhaul (2026-11-22)

One section for what two leads wrote in parts (`docs/design/ui-overhaul/impl-settings.md`, corrected against the code).

- **One view.** `AppSettingsView` shows both menu groups as native tablists (`SettingsNav` `groups`, testids
  `settings-tab-<app|project>-<pane>`, tab ids `<idBase>-tab-<group>-<pane>`; the `settings-nav-link-*` buttons are gone)
  and renders the project's panes in place (`ProjectSettingsPanes.tsx`). `views/SettingsView` (the project Settings tab)
  embeds it with `project`, opening on the stored project pane, without its own topbar; there App deep links are ignored,
  so a caller of `requestAppSettingsSection` must also `setView('appSettings')` (`KitSection` does).
- **Panes** (`lib/settingsMenu.ts`; atlas pane ids unchanged, so deep links land). App: General, Appearance (renderer-only
  id `appearance`, `appSettingsPaneFor` maps the atlas appearance / canvas sections and Motion to it), AI providers
  (`connections`), Tools and services (`mcp-library`), Skills (`skill-library`), Templates (`kit`), About and updates
  (`about`). Project: Basics (`general`), Permissions, Spending limits (`limits`), Branches (`maintenance`; "Maintenance"
  on engagements). Page h1 "Settings", Search settings (`settings-search-input`, `settings-search-hit`,
  `lib/settingsSearch.ts` over the atlas surfaces). The atlas path text (`src/shared/view/atlas.ts`) still names the old
  panes and `e2e/self-help.mjs` asserts it.
- **Galleries** (`SettingsGallery.tsx`): AI providers (`provider-tile[data-provider|data-kind|data-name|data-default]`,
  the selected `ConnectionCard` / `ProxyCard` `embedded`, `provider-tiers` with Most capable / Deep thinking / Standard /
  Fast, the plan window closest to its limit and its reset time per plan sign-in); Tools and services (keeps its tiles and
  dialogs, adds `connector-detail` from `toolCapabilities.ts`: can / could / cannot come from the preset and the server's
  own declaration, never an OrgAI-enforced limit; a test result marks tools "Reads only" / "Can change or delete" from MCP
  annotations when the server gives them); Skills (`skill-gallery`, `skill-library-row`, `skill-library-detail` with a
  plain-text preview of the first 1,200 characters, bidi controls shown as a mark; Edit, Duplicate, Export, Remove);
  Templates (`template-gallery`, `template-row`, `template-detail`; "Comes with OrgAI" built-ins `template-builtin` read
  only, "Used N times", Duplicate on every template).
- **Permissions.** `PermissionModeCards`: arrows preview a mode (`permission-mode-pending`, `-use`, `-keep`, effects table
  captioned "(not saved)"); Enter, Space, click or "Use <mode>" saves; Bypass asks first on every save path
  (`permission-bypass-confirm`). Unattended is the "Recommended" card (the app's own default), not the board's middle one.
  Worktree isolation and merge review moved to Branches (`work-copies-section`).
- **Runtime-backed rows (all live).** General: Notifications with "When a team needs me", "When a run finishes", "When a
  schedule finds something" (under the master switch) and "Play a sound"; "While OrgAI runs": open at sign-in, close
  behaviour, keep awake. Appearance "Panels and text": See-through panels, Text size, Spacing, Activity dots (attributes in
  ARCHITECTURE.md "Theme layer"); Motion keeps two choices because `noMotion` would equal "Always reduce". Spending limits:
  this month's spend (`runs.usageOverview`; "Cost unknown" / "At least"), per-run cap, "Per day and per month" caps with
  "When a limit is reached" (`onSpendLimit`) and "Warn me at" (`spendWarnPercent`) (`PERIOD_CAPS_LIVE` is true; metered
  projects show them at rest, plan sign-ins in Advanced to keep the at-rest tab-stop budget), "Most agents in one run"
  (`maxAgentsPerRun`, copy says it counts per run session) and "Ask before using a more capable model". Branches (code
  projects): Main branch (`gitInfo.branches`, detected default first), Tests must pass and Test command (main refuses
  every merge when tests are required and the command is empty), Keep branches of failed runs for, Finished copies size
  (`maintenanceExtra.finishedCopiesSize`) and Delete branch (`MaintenanceSection.tsx`: a confirm naming the branch and the
  commits lost, a ref guard against a double activation; not offered for the current, default or main branch). About:
  Report a problem, Details for support (copied), Licences.
- **Not offered (no behaviour in main, or an owner decision):** Language, Download updates by themselves, Name new branches
  (`branchNamePattern` is validated but no live run applies it), "Let schedules run when I am near the limit"
  (`schedulesNearPlanLimit`), "Dates look like" (`dateFormat` is stored; no renderer date formatting reads it), the welcome
  tour again, and Motion "Off".
- **Checked by:** `toolCapabilities.test.ts`, `sound.test.ts`, `theme.test.ts`, `planLimit.test.ts`, the tokens tests; e2e
  `connections`, `connectors`, `presets`, `skills`, `permissions`, `maintenance`, `engagement2`, `multi-provider`,
  `project-connection`; Reviewer approve with fixes. **Unverified:** a screen reader on any pane; macOS; narrow
  (1024x640) screenshots of Skills and Templates; the packaged login item and power blocker; live providers.
