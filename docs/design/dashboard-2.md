# Dashboard, pass 2 (GitHub issue #36)

Supersedes `dashboard.md` sections 2-5, 7-9 for the home page. `dashboard.md` section 1 (naming), 6 (start paths: New
project dialog, first launch radio group and inline form) and the delete / forget confirms of 5.1 stay as written.

Inputs: `ux-review-dashboard-3-pre.md` (sections A and B, H1, H2, M1-M6, L1, L5, L6), `dashboard-2-inventory.md`,
`ux-review-dashboard-2.md` findings (M3 paused-run wording, L1-L3), `canvas-themes.md` (state colours, rings, name
tags, station marks, legend words). Owner, on #36: "looks very AI generated right now and we need some more usable
items in there."

Constraints: renderer only. No new IPC, no change to `src/shared/types.ts`, `src/main/**`, `src/preload/**`.
`src/shared/view/*` (pure view helpers) may change. Every figure comes from the store or a preload call listed in the
inventory. Tokens only, both themes, container queries, lucide icons through `Icon`, nothing floats over content, at
most one primary action per region, mono (`--font-mono`, `font-variant-numeric: tabular-nums`) for every number.
Status words only from `lib/runStatus.ts`; agent activity only from run state.

Security note: inline "Allow once" / "Deny" and inline question answers (section 5) answer agent requests from a page
that is not the run. That is a security-relevant UI change: it needs a Reviewer pass before merge.

## 1. What the page is for

Open the app, see the organisation at work, decide what needs deciding, notice what is stuck. Each region answers one
question, and no fact is shown twice:

| Region | Question it answers | Replaces |
| --- | --- | --- |
| Status bar (`dashboard-hero`) | Is anything working, and can I start more work (plan limits)? | Hero figure, subline, gradient, Usage card |
| Needs you | What is waiting on me, and can I answer it here? | Needs you (now answerable) |
| Right now (band) | Who is doing what, in which run, how far along, at what cost? | Running now |
| Last 14 days (strip) | What has the organisation done and spent lately? | Cost card, hero cost |
| To set up | What will make the next run fail? | Connections card |
| Paused, Recently ended | What stopped and what can I pick up? | Paused, Since you were last here |
| Projects | Where is each team, and what is left over in it? | Project tiles |

The decision count appears in exactly two places on this page: the Needs you heading and the project tile status line
(the sidebar bell stays as it is). The status bar never repeats it.

## 2. Layout

### 2.1 Grid

`.dashboard` stays the page scroll region (`container-type: size`, one page scroll, no per-column scroll).
`.dashboard-grid` is the inline-size container `dash` with padding `--space-4` (under 1100 px) or `--space-6`.

Rows, top to bottom:

1. Status bar, full width.
2. `forget-notice` Banner when present (unchanged), full width.
3. The work area (grid areas below).
4. Projects, full width.

Work area, container width 880 px and up: two tracks `minmax(340px, 5fr) minmax(0, 7fr)`, column gap `--space-4`,
row gap `--space-4`, `align-items: start`:

```
"needs   now"
"strip   now"
"setup   now"
"paused  now"
"ended   now"
```

`now` spans every row (`grid-row: 1 / -1`). Empty sections render nothing, so their rows collapse.

Band empty (no open run at all, `data-now-empty` on the work area): the band is one line (section 6.7) and the strip
moves into the `now` area at its tall size (section 7.5). Its DOM position does not change (it already follows the
band in the DOM), so DOM order still equals reading order.

Under 880 px: one track, in DOM order: needs, now, strip, setup, paused, ended. Projects follow.

DOM order is needs, now, strip, setup, paused, ended. In two tracks Tab goes Needs you (top left), then the band (right),
then back to the left column below Needs you. This is deliberate: the first row of the page reads left to right, the
most urgent region comes first for keyboard and screen reader users, and the band is never after the whole left
column.

### 2.2 Container breakpoints (`@container dash`)

| Width | Change |
| --- | --- |
| < 560 px | Needs you actions wrap under the text; strip day labels show only the oldest day and Today; tiles one column; agent rows drop the role caption (it stays in the accessible name). |
| 560-879 px | One track. |
| 880-1279 px | Two tracks. Caps "narrow" (section 2.4). |
| >= 1280 px | Two tracks. Caps "wide". Projects grid `minmax(300px, 1fr)`. |
| < 760 px | Status bar wraps to at most three lines (max 72 px). |

Height (`.dashboard` is a size container): `@container (max-height: 600px)` sets the status bar to 36 px min-height.

### 2.3 Sizes at the two checked windows

1024x640, 56 px rail: the content region is about 968 x 584. Padding 16, inner 936 px, two tracks: left about 383 px,
right about 537 px.

| y (px) | Left column | Right column |
| --- | --- | --- |
| 16-56 | Status bar (both columns) | |
| 72-100 | Needs you heading | Right now heading with counts |
| 108-360 | 3 Needs you rows (84 px each with inline actions) | Project group, run headers (44 px), agent rows (32 px) |
| 360-388 | "Show N more" (only past the cap) | |
| 404-542 | Last 14 days strip (138 px) | ...up to 3 runs and 6 agent rows end by about y 548 |
| 558+ | To set up (top edge visible) | |

Above the fold at 1024x640: the status bar, Needs you with up to 3 rows, the band with up to 3 runs and 6 agent rows,
and the strip's totals and bars (with up to 3 decisions). To set up, Paused, Recently ended and Projects are below.

1024x640 with the full sidebar (232 px): the container is about 792 px, so one track: status bar, Needs you, band,
strip. Accepted; the rail is the default under 1180 px.

1600x1000, full sidebar 232 px: content about 1368 x 920, padding 24, inner 1320: left about 543 px, right about
761 px. Caps "wide". In a typical state (2 decisions, 3 runs, 6 agents) both columns end near y 560 and the first two
rows of project tiles (about 160 px each) are on screen. No column ends with more than 200 px of empty space while the
projects grid follows.

### 2.4 Caps

Chosen in JS from the work area's inline size (`useContainerWidth` on `.dashboard-grid`, a ResizeObserver; "wide" at
1280 px and up). Past a cap a ghost Button "Show N more" expands in place; it then reads "Show fewer" and keeps focus.

| Cap | Narrow | Wide |
| --- | --- | --- |
| Needs you rows | 3 | 5 |
| Band runs shown | 3 | 5 |
| Band agent rows, all runs together | 6 | 12 |
| Band agent rows per run | 4 | 6 |
| To set up rows | 3 | 5 |
| Paused rows, Recently ended rows | 4 | 6 |

## 3. Visual identity

The Dashboard borrows the Live canvas's vocabulary instead of inventing a dashboard look. A run in the band is drawn as
a small subway line: the orchestrator is an interchange, its reports are stations on a line in the orchestrator's role
colour, branches drop to deeper reports. The strip is an instrument: a ledger of days, not a chart widget.

What goes:

- The hero card, the 32 px gradient mark, the 3 px gradient edge and the dot-grid wash. The Dashboard no longer uses
  the brand gradient anywhere (this reverses `dashboard.md` section 8's exception).
- The three equal fact cards.
- Uppercase or generic captions ("From the runs OrgAI keeps.", "Since you were last here").

What carries identity:

- Role colour: every agent mark is filled with its role colour (`roleColor(roleId, roleSlug)` as LiveRunView resolves
  it: the project's role colour, else the neutral role token `NEUTRAL_ROLE_TOKEN`). Lines take the parent's role
  colour. A user who knows the team on the canvas recognises it here.
- State as ring and halo, the canvas legend's words: Working, Needs you, Idle, Finished, Failed.
- Name tags: the agent label sits in a compact pill like the canvas "Name tags" style.
- Numbers in mono with tabular figures, set at the right edge of their row, like an instrument readout.
- One quiet motion: working agents breathe. Nothing else moves on its own.

### 3.1 Agent mark (band)

A 12 px circle (`.dash-mark`), `border-radius: var(--radius-full)`, `--role` set inline:

| State (`data-state`) | Agent states | Fill | Ring (2 px border) | Halo |
| --- | --- | --- | --- | --- |
| `working` | starting, thinking, tool, delegating | `color-mix(in oklab, var(--role) 70%, var(--surface-1))` | `--state-working` | `--halo-working`, breathing (3.4) |
| `waiting` | waiting (a card is open) | same | `--state-waiting` | `--halo-dot-warning`, static |
| `idle` | idle | same | `--state-idle` | none |
| `done` | done, inside the 6 s grace | `--state-done` | `--state-done` | none; a 10 px `Check` icon in `--text-on-success` |
| `failed` | error, shown only while it has a live report | `--state-error` | `--state-error` | none; `TriangleAlert` 10 px |

The run header's leading mark is the interchange (`.dash-mark[data-root]`): 14 px, a 2 px ring in the root's role
colour around a 6 px dot in the same colour, the ring colour switching to the state ring above for waiting / idle.

Colour is never alone: the row's activity text and the accessible name carry the state word (section 6.4).

### 3.2 Reporting lines

Inside a run, rows are indented 16 px per depth level (depth 1 = reports to the orchestrator, at most depth 3 drawn;
deeper rows sit at depth 3 with "under <parent label>" in their caption). A 2 px vertical line runs from the
interchange down the left of its reports, and each row has a 2 px elbow from that line to its mark (CSS `::before` /
`::after` on `.dash-agent-row`, `--line-role` set inline to the parent's role colour, stroke `--dash-line`). The line
stops at the last row of that parent. The "N more agents" and "N done" rows sit on the line with a hollow 8 px mark
(dashed 1 px ring in `--canvas-edge-group`), the canvas's folded-group shape.

Lines are decoration that repeats what the indentation and accessible names say; they are `aria-hidden` by
construction (pseudo-elements).

### 3.3 Typography

| Element | Token |
| --- | --- |
| Section headings (h2) | `--text-title`, `--weight-semibold` |
| Project group name in the band (h3) | `--text-title-sm`, semibold, `--text-secondary` |
| Run name in a run header | `--text-body`, semibold, `--text-primary` |
| Status word | `--text-small`, semibold, coloured dot beside it |
| Agent label pill | `--text-small`, semibold, `--surface-2`, 1 px `--border-default`, `--radius-full`, height 20, padding 0 `--space-2`, max 160 px with middle clip (`splitLabelTail`, as the canvas) |
| Role caption, plan step, captions | `--text-caption`, `--text-tertiary` |
| Activity string | `--text-body`, `--text-secondary`, one line, ellipsis |
| Every number (counts, costs, percent, times) | `--font-mono`, `--text-mono`, tabular-nums |
| Status bar sentence | `--text-body`, `--text-primary` |

### 3.4 Motion

| What | How | Duration / easing | Reduced motion |
| --- | --- | --- | --- |
| Working mark breathes | `::after` ring on `.dash-mark[data-state=working]`: `transform: scale(1 -> 1.9)`, `opacity: 0.55 -> 0` in `--state-working`, infinite. Each mark gets `animation-delay: calc(var(--i) * -240ms)` (`--i` = its index among working marks) so marks never blink in step. At most 12 marks animate (the wide cap). | `--dur-pulse` (1800 ms), `--ease-out` | No animation; the static `--halo-working` stays |
| A new agent row appears | `opacity 0 -> 1` and `translateY(4px) -> 0` | `--dur-base`, `--ease-out` | Opacity only, `--dur-fast` |
| An agent settles into "N done" | The "N done" row's background flashes `--success-soft` once, back to transparent | `--dur-slow`, `--ease-in-out` | None |
| Strip bars on first mount | `transform: scaleY(0 -> 1)` from the baseline, `transition-delay` 12 ms per day, oldest first | `--dur-slow`, `--ease-out` | None (bars at full height) |
| Day hover / focus | Column background `--surface-2`; readout text swaps | instant | same |
| Activity text changes | none (it changes too often to animate) | | |

Rows never animate out (a row that leaves is removed at once, so the list never jumps twice). Animations use transform
and opacity only. Both `@media (prefers-reduced-motion: reduce)` and `:root[data-reduce-motion='on']` switch to the
reduced column. Animations pause while `document.visibilityState` is hidden only through the browser's own behaviour; no
JS timers drive motion.

## 4. Status bar (`dashboard-hero`)

A `section` (`aria-label="Overview"`) with no surface: transparent, a 1 px `--border-subtle` bottom border,
min-height 40 px (36 px under 600 px of height), `display: flex; flex-wrap: wrap; align-items: center;
gap: var(--space-2) var(--space-4)`. Three parts, in order: the sentence, the limits, the app facts (pushed right with
`margin-inline-start: auto`). At 1024x640 it is one line in the common case and never taller than 72 px (e2e keeps
the 88 px check).

### 4.1 Sentence (`dash-status-line`)

A `p` with `data-working` (working agents), `data-open` (open runs) and `data-paused`. Built by the pure
`statusSentence(input)` in `lib/dashboard.ts` (replaces `heroFigure` and `heroSublineParts`; both and
`FIRST_LAUNCH_LINE`'s caller move). Parts joined with ". ", ending with ".":

1. Work, first that applies:
   - working agents > 0: "{A} agent(s) working in {R} run(s)" ("1 agent working in 1 run", "3 agents working in 2 runs").
   - working runs > 0 but no agent in a working state (between turns, auto-continuing): "{R} run(s) working".
   - open runs > 0: "{N} run(s) open, none working".
   - else: "Nothing is running".
2. Paused, when paused runs > 0: "{N} paused until {time}" with the soonest `pausedUntil` of runs with `autoResume`
   (time as `toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })`), else "{N} paused".
3. Cut by a quit, when closed-waiting runs > 0 (same count as today: `sinceLastSeen(...).items` of kind
   'closed-waiting'): "{N} was waiting on you when OrgAI closed" / "{N} were waiting on you when OrgAI closed".
   (e2e reads `/waiting on you when OrgAI closed/` in `dashboard-hero`.)

Definitions: a working agent is an agent of an open run in state starting, thinking, tool or delegating; a working run
is an open run whose `statusOfRun` word is "Running" and that is not in Needs you; an open run is `isRunLive` minus
paused. Decisions are not mentioned (Needs you sits beside it).

First launch: "Welcome to OrgAI." then `FIRST_LAUNCH_LINE` ("Start a project or just chat. Nothing runs until you say
so."), no limits.

### 4.2 Limits (`dash-limits`)

A `ul` with one `li.dash-limit` per connection in use (`connectionsInUse`) that reports something, at most 2 (a third
and more add "+{N} more" as text; the full list stays in the sidebar account popover). Hidden entirely when
`appInfo.mockAdapter` is true (the mock reports scripted windows; the popover says "No plan limits apply", walk-3 M5),
for API-key connections, and when no connection in use reports a window or spend.

- Subscription window (`data-kind=window`, `data-connection`, `data-level` '' | 'warn' | 'danger'): from a new export
  `tightestWindowRow(usage)` in `components/UsageMeter.tsx` (same choice as `tightestWindow`, but returns the `Row`, so
  `window.resetsAt` is available). Text: "{Connection} plan" in `--text-secondary`, then "{window label} {pct}%"
  (`windowLabel` from dashboardProjects.ts: "5-hour window 62%"), then "· resets in {duration}" from the new pure
  `resetsInLabel(resetsAt, now)`:
  - under 1 min: "resets in under a minute"; under 1 h: "resets in 25 min"; under 24 h: "resets in 2 h 10 min";
    24 h or more: "resets Thu 09:00" (`toLocaleDateString([], { weekday: 'short' })` plus the time); null: the part is
    left out.
  - Limited (`usage.status === 'rejected'`, the window is `limitedWindow`): "{Connection} plan · limited until 14:00"
    from `limitedUntil`, `data-level=danger`, text in `--danger-text`.
  - A 40 x 4 px bar after the text (the `usage-mini` look, `--radius-full`): accent from 0, `--warning` from 80%
    (`WARN_AT`), `--danger` when limited. `aria-hidden`; the text says it.
- Proxy spend (`data-kind=spend`): `spendRowLabel(spend, id)` ("Work proxy · $3.20 today"), only when the proxy
  reports spend (`reportsSpend`), with `SpendBar` when a budget is set. `title` = `spendSentence`.
- The `li` carries `title` with the full window list of that connection ("5-hour window 62%, resets 14:10. 7-day
  window 41%, resets Thu 09:00.").
- Refresh: on mount, `refreshUsage()` when the newest report is older than 60 s (`usageIsStale`), as the Usage card
  did. Times re-render through `useNow` (30 s). Nothing here is announced.

### 4.3 App facts (`dashboard-app-facts`)

Unchanged content, caption size, `--text-tertiary`: "OrgAI 0.1.7-dev1", the info Badge "Dev" when `isDevBuild`, the
warning Badge "Mock adapter" when `appInfo.mockAdapter`.

### 4.4 Live region (`dashboard-live`)

The page's one polite region stays here: a visually hidden `div role=status aria-live=polite`, rendered empty on mount.
Policy in section 12.

## 5. Needs you (`dash-needs-you`)

Always shown once a project exists (first launch: absent, as today). `section` with h2 "Needs you" (tabIndex -1,
`data-section-heading`) and the count in mono beside it when above zero. Count = `combinedDecisionCount` (unchanged:
equals the bell, e2e checks it).

### 5.1 Rows

Source unchanged: `useWaitingRuns()` x `waitingItems(run, projectKind)` plus `useTeamAttentionItems()`, in that order.
One `li.dash-row.dash-needs-row` per decision (`data-testid=dash-needs-row`, `data-kind`, `data-run`, `data-key`,
`data-inline` = `allow` | `options` | `none`). Surface `--warning-soft`, 1 px `--warning-border`, `--radius-md`,
padding `--space-2` `--space-3`.

Inside, two parts side by side (stacked under 560 px or when the row's own width is under 360 px via
`@container needs-row`):

1. `button.dash-row-main` (`data-row-main`): opens the card (`jumpToDecision(projectId, runId, key)`, or
   `openTeamFilesDecision` for team), as today. Its lines:
   - Line 1, the place first: project name (`locationLabel`, semibold `--text-primary`) · run name (`runName`,
     `--text-secondary`). For team: project name · "Team files".
   - Line 2, the ask (`.dash-needs-ask`), one or two lines, by kind:
     - permission: "{agent label} wants to {verb}:" in caption, then the object. Shell (Bash / PowerShell): the command
       in a `code` element, `--font-mono`, `showHidden` applied, at most 2 lines (CSS line clamp). File tools (Edit,
       Write, MultiEdit, NotebookEdit, Read): the path's file name semibold and its folder in caption (`baseName` and
       the parent). Anything else: `request.summary` one line. Verb: "run" for shells, "edit" for Edit / MultiEdit /
       NotebookEdit, "write" for Write, "read" for Read / Glob / Grep, "use {toolName}" otherwise.
     - question: the question text (`oneLine(question, 200)`), 2-line clamp.
     - other kinds: the existing `label` ("Merge: review impl-2's changes", "Engagement plan: ...").
   - Line 3, only for a permission with `referenceFolder`: `Lock` icon + "Touches a reference folder (read only)"
     (`dash-needs-reference`, the PermissionCard wording from `referenceLocation`).
   - Accessible name: "Open {kind word}: {project}, {run}, {ask as text}" ("Open permission: Billing API, First task,
     impl-2 wants to run npm test").
2. `div.dash-needs-actions` (only when `data-inline` is not `none`), the answer buttons (5.2).

Other kinds (rules, proposal, merge, install, plan, team) have `data-inline=none` and a trailing `ChevronRight` icon in
the main button; they open the card only.

### 5.2 Inline answers

Store: two new renderer actions in `useAppStore` that take the run id instead of reading the active run (the existing
`decide` / `answerQuestion` act on `activeRun`, which is wrong from the Dashboard):

- `decideIn(runId, requestId, decision: PermissionDecision)`: `window.orgai.runs.decide({ runId, requestId, decision })`.
- `answerQuestionIn(runId, questionId, answer: QuestionAnswer)`: `window.orgai.setup.answer({ runId, questionId, answer })`.

The existing `decide` / `answerQuestion` become thin calls to these with the active run id.

Permission (`data-inline=allow`), offered only when `inlineAllowable(request)` (pure, `lib/needsInline.ts`) is true:

- shell: the command has no hidden characters (`hasHidden` false, `isHiddenCommand` false), at most 2 non-empty lines
  and at most 200 characters. Otherwise the row shows the first line clipped plus "Long command: open it to review" in
  caption, and `data-inline=none`.
- file tools: always (the path is shown whole in the accessible name and `title`).
- other tools: when `request.summary` is at most 200 characters and has no hidden characters.

Buttons: secondary sm "Allow once" (`dash-needs-allow`) and ghost sm "Deny" (`dash-needs-deny`, `--danger-text`).
Allow sends `{ behavior: 'allow', scope: 'once' }`; Deny sends `{ behavior: 'deny', message: 'The user declined this
action. Find another way or ask.' }` (the card's text). Never "Allow for session", never "Always allow for project",
never rule chips or the settings link from the Dashboard, whatever `suggestions`, `maxScope` or `referenceFolder` say.
A `referenceFolder` request gets the same two buttons (Allow once and Deny are all it allows anyway). Accessible names:
"Allow once: {ask}" and "Deny: {ask}".

Question (`data-inline=options`), offered only when `inlineOptions(question)` is true: single choice
(`allowMultiple` false), 2 to 4 options, every label at most 40 characters, no option has a `description`. Each option
is a secondary sm Button (`dash-needs-option`, `data-option` = label) sending `{ selected: [label] }` at once; free text
is left to the card. Otherwise `data-inline=none` and the main button reads "Answer in the run" in caption.

While a send is in flight: every button of that row is disabled and the pressed one reads "Sending…". On failure the
row shows `dash-needs-error` (caption, `--danger-text`, `role` none: it is announced through `dashboard-live`):
"Could not send the answer: {message}" with the IPC wrapper stripped (`lib/ipcError.ts`); the buttons come back. The
row leaves when the `*.resolved` event removes the card (never optimistically).

Focus: when the focused row (or a button in it) leaves, focus moves to the next row's main button, else the previous
row's, else the section heading (h2, tabIndex -1). The same rule covers rows answered elsewhere.

### 5.3 Empty and caps

Empty: one quiet line "Nothing needs you." (no icon, no card). Cap 3 narrow / 5 wide with "Show N more"
(`dash-needs-more`).

## 6. Right now (`dash-now`)

The page's signature. A `section` (h2 "Right now", tabIndex -1, `data-section-heading`) with `data-working`,
`data-waiting`, `data-idle` (run counts). Surface `--surface-1`, `--radius-lg`, `--elev-1`, padding `--space-3`
`--space-4`.

### 6.1 Heading line

h2 "Right now" left; right, `dash-now-counts` in caption with mono numbers, parts with a count of zero left out:
"2 working · 1 waiting for you · 1 idle". Each part is a `span[data-group=working|waiting|idle]`. With no open runs:
no counts.

### 6.2 Which runs

Open runs from `runs` (`isRunLive`, not paused), every project, assistants included, deleted projects ignored (as
`useLiveRuns`). Each run belongs to one group:

- working: `statusOfRun` word "Running" and no open decision.
- waiting for you: `waitingItems(run).length > 0` (these are the runs in Needs you; they are not repeated there and
  not listed twice here: the run appears once, in the band, marked).
- idle: the rest (word "Idle").

Grouped by project (`dash-now-project[data-project]`, h3 = `locationLabel`, engagement client as caption), projects
ordered by their most urgent run (working before waiting before idle), then by newest run start. Inside a project,
runs ordered working, waiting, idle, then newest start first.

### 6.3 Run header (`dash-running-row`)

`li.dash-run` (`data-testid=dash-running-row`, `data-status` = status word, `data-run`, `data-project`,
`data-needs` = decision count when above zero) holding one full-width `button.dash-run-head` (`data-row-main`),
min-height 44 px:

- Line 1: interchange mark (3.1), the status dot and word (`statusText(statusOfRun(...))`: "Running", "Needs you",
  "Idle"), the run name (`runName`, semibold, ellipsis), the kind chip for assistant runs (`runKindLabel`: "Chat", "MCP
  assistant", "Skill assistant"); right-aligned in mono: the plan step ("Step 3 of 7", `planStepLabel`, also "Plan
  blocked" / "Plan done") and the cost so far (`Cost` `compact` `labelled`, from `runCostInput(run.summary)`, hidden
  while nothing is spent).
- Line 2 (caption), first that applies:
  - Running and the plan has a current step (first step with status 'in_progress', else the first 'pending'): that
    step's title (`oneLine(title, 120)`).
  - else the root agent's activity, through `nodeActivity` (section 6.6): "Waiting for your reply", "Delegating to 2
    agents", "Waiting for you".
- A run in Needs you: the dot and word are the warning tone, and line 2 ends with " · {N} decision(s) in Needs you".
- Accessible name: "{status word}: {run name}, {project}, {line 2}, {plan step}, cost {cost}, open for {elapsed}"
  (elapsed from `elapsedLabel(startedAt)`; it is in `title` too, not shown).
- Click / Enter: `focusRun(projectId, runId)` then the focus rule in 6.5 with the root as target.

### 6.4 Agent rows (`dash-agent-row`)

Under each run header, a `ul` of agent rows. Which agents show (`bandAgents`, pure, `lib/dashboardBand.ts`):

- Never the root (the header speaks for it).
- An agent whose state is not done / error: shown.
- A done / error agent: shown only while inside the 6 s grace (`isSettledAt(a, now)` false) or while it has a live
  report (`hasLiveDescendant`); otherwise counted in the run's "N done" row. A timer for `nextSettleAt` moves it (same
  pattern as LiveRunView, 250 ms floor).
- Tree order (parent before children, siblings by `startedAt`), depth from `parentId` (normalized with
  `normalizeParents`).

Caps (2.4): rows across runs are allocated run by run in run order; within a run, if it has more agents than its share,
waiting agents are kept first, then working, then idle, then done, and the kept rows stay in tree order. The rest
become one row.

Row: `li` > `button.dash-agent-row` (`data-testid=dash-agent-row`, `data-state` = working | waiting | idle | done |
failed, `data-agent`, `data-run`, `data-depth`), height 32 px, grid columns: indent (16 px x depth) | mark 12 px |
label pill | role caption | activity (1fr) | worktree flag.

- Label pill: `agentLabel(agent)` (handle first, as the canvas).
- Role caption: `agent.name` (the role name), left out when equal to the label. Under 560 px of container width it is
  hidden visually but stays in the accessible name.
- Activity: `nodeActivity(agent, { isRoot: false })`, one line, ellipsis, full text in `title`.
- Worktree flag, only when `agent.worktree.status` is 'conflict', 'review' or 'held': caption in `--warning-text`,
  the canvas words via `worktreeLabel` ("merge conflict", "awaiting your review", "held for later").
- Accessible name: "{label}, {role}, {state word}: {activity}{, under {parent label} when depth > 3}. Opens in
  {run name}." State words: Working, Needs you, Idle, Finished, Failed (the canvas legend words).
- Click / Enter: `focusRun(projectId, runId)`, then `selectAgent(agentId)`, then the focus rule in 6.5.

Summary rows (same height, same line, hollow mark, caption text, each a `button` that opens the run with the root
selected):

- `dash-agent-more[data-count]`: "{N} more agents" (live agents that did not fit).
- `dash-agent-done[data-count][data-failed]`: "{N} done", with failures "{N} done, {F} failed" (the failed part in
  `--danger-text`).

After the band run cap: ghost Button "Show {N} more runs" (`dash-now-more`), then "Show fewer".

### 6.5 Opening a run or an agent, focus

After `focusRun` resolves and the Live view renders (two animation frames), focus
`.react-flow__node[data-id="<agentId>"]` when it exists (React Flow makes nodes focusable; the node is selected, so the
side panel follows it as on a click), else the existing `settleFocus` fallback (composer, else the topbar h1). In the
conversation layout (single-agent runs) there is no node: the fallback applies.

Live updates inside the band never move focus, except when the focused element leaves:

- a focused agent row leaves (its agent settled): focus its run header;
- a focused run header leaves (the run ended): the next run header in the band, else the previous, else the h2.

### 6.6 Shared helpers moved out of AgentNode

`lib/agentActivity.ts` (pure, unit-tested; AgentNode imports it so the two never drift):

- `nodeActivity(agent, { isRoot })`: `agent.usage?.producedNothing` / `agentProducedNothing` on a non-root agent ->
  "Ended without a result"; a root that is idle with activity "Waiting for you" -> "Waiting for your reply"; else
  `agent.activity`. (The streaming `partial` text stays canvas-only; the Dashboard never shows it.)
- `worktreeLabel(worktree)` and the `WORKTREE_LABEL` table, moved verbatim.
- `isWorkingAgent(state)`: starting, thinking, tool, delegating.

### 6.7 Empty

No open run: the band is one line under its heading, "Nothing is running." (`dash-now-empty`), and the strip takes the
`now` area at its tall size (7.5). With paused runs only, the line reads "Nothing is running. {N} paused, see Paused."

### 6.8 Data and performance

- `bandModel(runs, projects, virtualProjects, now, caps)` in `lib/dashboardBand.ts` (pure, unit-tested) returns
  projects > runs > rows plus counts. The component selects a reduced tuple per open run (id, status, plan step
  statuses and titles, summary cost, per agent: id, parentId, state, activity, handle, name, roleId, roleSlug,
  worktree status, startedAt, endedAt, producedNothing) with `useShallow`, and recomputes the model at most every
  250 ms (trailing), so a burst of `agent.upsert` events renders once.
- Re-renders of the elapsed `title` follow `useNow` (30 s). Nothing in the band is announced (section 12).

## 7. Last 14 days (`dash-strip`)

A `section` (h2 "Last 14 days", `data-size` = compact | tall), surface `--surface-1`, `--radius-lg`, `--elev-1`,
padding `--space-3`. Built from `useAllSummaries()` (history merged with live, deleted projects dropped) by the pure
`dayLedger(summaries, now, days = 14)` in `lib/activityStrip.ts`. Zero calls.

### 7.1 Day buckets

- Local calendar days, today and the 13 before (DST-safe: build days with `new Date(y, m, d)`, never by adding
  86,400,000 ms). Each run counts on the local day of its `startedAt`; its whole cost counts there too (a run that
  spans midnight is not split; the readout says "started").
- Per day: `runs` (every run, all kinds, each id once; continuations count as runs, as in Trends), `outcomes`
  (finished, failed, stopped incl. "Ended when OrgAI closed", open, paused; from `statusOfRun` on the summary),
  `cost` = `sumCosts(day.map(runCostInput))` (so unknown stays unknown and a partial sum is a lower bound),
  `waitingMs` = sum of `usage.waitingMs` where present.
- Totals over the 14 days: runs, `sumCosts` of all, waiting.

### 7.2 Header

h2 "Last 14 days" left; right, a `dl.dash-strip-totals` (each `dt` caption, each `dd` mono), in one line, wrapping
as a whole under 360 px:

- "Runs" / "37" (`dash-strip-runs`)
- "Cost" / `Cost compact` of the total (`data-testid=dash-cost` on the `div` wrapping this `dt` / `dd` pair). Nothing
  spent: "—" (the `costView` none text), never "$0.00".
- "Waited on you" / `formatDuration(total waiting)` ("3 h 10 min"), only when above zero (`dash-strip-waiting`).

### 7.3 The days

A `div role=group aria-label="Runs and cost per day, last 14 days"` holding 14 native `button`s in a row
(`dash-strip-day`, `data-day` = `YYYY-MM-DD` local, `data-runs`, `data-cost-kind` = none | known | partial | unknown,
`data-today` on today, `data-pinned` on the pinned day). One Tab stop through `useRovingFocus` (Left / Right, Home /
End; today has `tabIndex 0` at rest).

Each button is a column containing an inline `svg` (`aria-hidden`, `width 100%`, compact height 74, tall height 124),
drawn top to bottom:

- Cost track (compact 40 px, tall 72 px): one bar, width 60% of the column, centred, `rx` 2. Height = linear share of
  this day's known cost over the largest known day cost in the 14 days; any known cost above zero is at least 2 px.
  Fill `--dash-strip-bar`; today `--dash-strip-today`. Partial: the bar plus a hollow 6 px circle (1.5 px stroke
  `--dash-strip-bar`) 3 px above its top. Unknown (runs, no priced cost): no bar, the hollow circle sits on the
  baseline. No runs, or runs that spent nothing: no bar.
- Baseline: 1 px `--border-default` across every column (one line through the strip, like an instrument's zero).
- Run ledger (compact 30 px, tall 48 px) under the baseline: one 3 px tall tick per run, width 60% of the column, 2 px
  apart, stacked downward, at most 6 (tall 10); colour by outcome: finished `--state-done`, failed `--state-error`,
  stopped / ended `--state-idle`, open `--state-working`, paused `--state-waiting`. Order: failed, open, paused,
  finished, stopped, so the rarer, louder outcomes sit nearest the baseline. More runs than ticks: the last tick is
  replaced by a 3 px gap and a 3 px tick in `--text-tertiary` (the readout gives the real count).
- Day label row (16 px, caption, `--text-tertiary`): the oldest day as "24 Oct" (`formatDate` without the year) at the
  left column, "Today" at the right; tall size adds the weekday initial under every column ("M", "T"...). Under 560 px
  only the two ends.

Hover / focus / pin: the column gets `--surface-2` behind it (`--radius-sm`) and the readout shows that day. Pointer
leave and blur return the readout to the pinned day, else today. Click / Enter / Space pins the day (`aria-pressed`
true), again unpins; Esc unpins.

Accessible name of each button: "{Weekday d Mon}: {N} runs ({f} finished, {x} failed, {s} stopped, {o} open),
cost {cost text}, waited on you {duration}" with zero parts left out; "no runs" when there were none.

### 7.4 Readout (`dash-strip-readout`)

One line under the days, `--text-small`, numbers mono, in place (never a floating tooltip over content), not a live
region (the focused button's name already speaks):

- "Today: 3 runs started · $0.42 · waited on you 12 min"
- "Tue 4 Nov: 5 runs started (1 failed) · $1.20+"
- "Sun 2 Nov: no runs"
- Cost unknown: "… · cost unknown" (the `Cost labelled` text).

### 7.5 Sizes and placement

- compact (default, in the `strip` area): about 138 px tall, columns about 26 px wide at 1024x640.
- tall (band empty, in the `now` area): about 190 px, columns about 36 px wide at 1024x640, weekday initials shown.
- No runs at all in 14 days: the days still draw (baseline only), the readout says "No runs in the last 14 days.", the
  totals show "Runs 0", "Cost —".

## 8. To set up (`dash-setup`)

Things that will make a run fail or skip a service. Shown only when non-empty, never counted as decisions, never in the
bell. `section` h2 "To set up" with the count in mono. Rows `li.dash-row.dash-setup-row` (`data-kind`, `data-id`),
surface `--surface-1`, a 2 px left edge `--warning-border`; text left, one secondary sm Button right
(`dash-setup-action`).

| `data-kind` | Source | Text (line 1 / caption) | Action |
| --- | --- | --- | --- |
| `connection` | `connectionProblems(connections, connectionsInUse(...), projects)` | the helper's text: "OpenAI is not connected. 2 projects use it." | "Connection settings": `requestAppSettingsSection(APP_SETTINGS_PANES.connections)` then `setView('appSettings')` |
| `service` | `mcpLibrary.list()`: entries with `usedBy.length > 0`, not `perProjectSecrets`, and `needsSignIn({ spec: info.entry, auth: info.auth, missingSecrets: info.missingSecrets })` | "{entry name} · {waitingLabel(info)}" ("GitHub · Needs sign in") / "Used by Billing API, Docs site" (at most 3 names, then "and N more") | Connector entry (`entry.connectorId`): "Sign in" (oauth) or "Add token" (token): `requestConnector(id)` then `setView('appSettings')`. Other: "Set up": `openMcpLibrary(entry.id)` |
| `project-value` | the same list, `projectSecrets[]` with `missingSecrets.length > 0` | "{entry name} · {waitingLabel({ missingSecrets, secretScope: 'project' })}" ("Notion · Needs a value for this project") / "{projectName}" | "Set value": `openProjectMcp(projectId, serverId)` |
| `project-server` | `mcp.list(projectId)` for projects whose `Project.mcpServers` has an enabled entry without `libraryId`: servers with `needsSignIn(info)` | "{server name} · {waitingLabel(info)}" / "{project name}" | "Set up": `openProjectMcp(projectId, serverId)` |
| `connector` | `connectors.list()`: `state === 'error'` and its library entry is used by a project | "{connector name} has a problem" / "Used by …" | "Open": `requestConnector(id)` then `setView('appSettings')` |

Rows de-duplicate by library entry (a connector entry in error and needing sign-in shows once, as `service`). Order:
connection, service, project-value, project-server, connector; then name. Cap 3 narrow / 5 wide.

Data: `mcpLibrary.list()` and `connectors.list()` once on mount after first paint, again on `onMcpLibraryChanged`
(already pushed) and on `connections.changed`. `mcp.list(projectId)` through the shared project queue (11.4), once per
project per session. Failures: the row source is silently empty (`console.debug`), never an error on the page.

The old Connections card ("Default: Anthropic · Connected") is gone; with nothing to fix this section does not render.

## 9. Paused and Recently ended

### 9.1 Paused (`dash-paused`)

Unchanged rows, buttons and testids (`dash-paused-row`, `dash-paused-resume`), with walk-2 M3's wording: the caption
reads "{location} · resumes at 14:05 if OrgAI stays open" when `autoResume` and `pausedUntil`, else "{location} ·
waits for you to continue". Cap 4 narrow / 6 wide.

### 9.2 Recently ended (`dash-since`)

Renamed from "Since you were last here" (a generic caption; the rows already say when each run ended). Rules of
`dashboard.md` 4.3 and the walk-2 fix-up stay (last seen, `clearedAt`, closed-waiting rows kept until cleared,
`dash-since-continue`, row click focus), plus:

- L5: a run with `endedBy === 'user'` and `endedAt >= performance.timeOrigin` (ended by the user in this window's
  lifetime) is left out: the user just did it.
- The header Button "Mark all seen" becomes ghost "Clear" (`dash-since-clear`, accessible name "Clear recently ended
  runs"); behaviour unchanged (focus moves to the next section's heading).
- Rows keep `dash-since-row[data-status]`, status word through `statusText`, run name, caption "{location} · {relative
  time}" and `Cost compact`. Cap 4 narrow / 6 wide.

## 10. Projects (`dash-projects`)

Section h2 "Projects" with the count; search `dash-project-search` past 6 projects (unchanged); order
`projectAttentionOrder` (unchanged). Grid `repeat(auto-fill, minmax(280px, 1fr))` (300 px from 1280), gap
`--space-4`.

### 10.1 Tile (`project-tile[data-name][data-id][data-state]`)

Surface and states as today (`--warning-soft` with decisions; a 2 px `--state-working` left edge only when the project
has a working run, not merely an open one: walk-2 L3). Top to bottom:

1. Client line (engagements, `tile-client`), unchanged.
2. Head: name (`project-tile-main`, the stretched Open button) and More (`project-tile-more`), unchanged.
3. Status line, unchanged format and wording (`projectStatus(...).subtitle`: "1 decision · 1 run", "Last run 2h ago ·
   Stopped", "No runs yet"), the "Setup pending" Badge. Fix walk-2 L2: dot and text on one grid row, the text wraps
   beside the dot.
4. Newest run (`tile-run[data-status]`), body text: the newest run by `startedAt` across live and history (live wins),
   its `runName` (`--text-body`, `--text-primary`, one line), then a caption line:
   - live: "{status word} · {root activity}" ("Idle · Waiting for your reply", "Running · Step 3 of 7").
   - ended: "{statusText} · {relativeTime(endedAt)}" ("Finished · 2 h ago", "Ended when OrgAI closed · 1 d ago").
   - no runs: the block is absent.
5. Chips (`tile-chips`, only non-zero chips render; none = no row). Each chip is a native `button.tile-chip`
   (`data-testid=tile-chip`, `data-kind`), caption size, 22 px tall, `--radius-full`, 1 px `--border-default`,
   `--surface-2`, an icon 12 px, `position: relative; z-index: 1` so it sits above the stretched Open cover like More:
   - `branches` (code projects only): `GitBranch` "{N} branch(es) waiting" -> `openProjectSettings(id,
     PROJECT_SETTINGS_SECTIONS.maintenance)`.
   - `suggestions`: `Sparkles` "{N} team suggestion(s)" -> `selectProject(id)` then `setView('team')`.
   - `folder-trust`: `ShieldAlert` "Folder settings to review" -> `openFolderTrustReview(id)`
     (FolderTrustNotice.tsx).
   Accessible names add the project: "3 branches waiting in Billing API".
6. Foot (`project-tile-foot`): left, the folder name (`tile-folder`, `folderName(path)`, caption, `--text-tertiary`,
   sans, not mono; full path as `title`); right, `tile-cost` "{cost} last 7 days" (`Cost compact`, mono), only when
   something was spent. "N roles" is gone.

Open button's accessible name: "Open {name}, {status line}, {newest run name}{, setup pending}".

### 10.2 More menu

Items in order: "Open", "New run" (`project-tile-new-run`), "Continue {newest run name}" (`project-tile-continue`,
only when the newest chain's newest member is ended and `canContinue`), "Open folder" (`project-tile-open-folder`),
separator, "Delete project…" / "Forget engagement…" (`project-tile-delete`). Keyboard as today.

- New run: `selectProject(id)`, `openDraft()`, then `focusComposer()`; the New run page's prompt field takes focus,
  else the topbar h1.
- Continue: `continueFromHistory(runId, projectId)` (focus lands in the composer, as `dash-since-continue`).
- The run name in "Continue …" is cut at 32 characters with an ellipsis.

### 10.3 Per-project signals (data)

`useProjectSignals(projects)` (one hook, `components/dashboard/useProjectSignals.ts`) feeds the chips:

- Branches: `window.orgai.maintenance.listWorktrees(projectId)` for code projects (`projectKindOf === 'code'`, not
  virtual). Count = entries with `commitsAhead > 0 || uncommittedFiles > 0` (clean leftovers do not count).
- Suggestions: `seedTeamReview(projectId)` for every real project; `seedTeamReview` changes to return its promise
  (`Promise<void>`, same de-dupe) so the queue can wait for it. Count = `useTeamReviewSummary(id)?.pendingCount`.
- Folder trust: `hasFolderTrustField(project) && project.folderConfigTrust.state === 'untrusted'`. Zero calls. The
  'changed' state needs a review call per project and is not built here.

### 10.4 Throttling (shared project queue)

One module-level queue in `useProjectSignals.ts` serves listWorktrees, seedTeamReview and `mcp.list` (section 8):

- At most 3 calls in flight.
- Started after first paint (`requestIdleCallback`, else a 500 ms timeout) on Dashboard mount only. Never on a timer,
  never on a history or run event.
- Session cache: a Map per call kind keyed by project id holding `{ value, at }`. Team reviews: once per project per
  session (pushes from `onTeamReviewUpdated` keep them fresh). Worktrees and `mcp.list`: re-fetched on a later
  Dashboard mount only when the cached entry is older than 10 minutes.
- Order: projects in tile order, so visible tiles fill first.
- A failed call caches `null` (no chip) until the next allowed re-fetch; nothing is shown to the user.
- A project deleted while queued is skipped; results for unknown project ids are dropped.

## 11. Data rules summary

| Region | Source | Calls | Notes |
| --- | --- | --- | --- |
| Status sentence | `runs`, `useAllSummaries`, last seen | 0 | `statusSentence` pure |
| Limits | `usageByConnection`, `connections`, `defaultConnection`, `appInfo` | `refreshUsage()` on mount when stale | `tightestWindowRow`, `resetsInLabel` |
| Needs you | `useWaitingRuns`, `useTeamAttentionItems`, `runs[id].permissions/questions` | answers only | `inlineAllowable`, `inlineOptions` pure |
| Right now | `runs` (live), `projects`, `virtualProjects` | 0 | `bandModel` pure, 250 ms trailing |
| Strip | `useAllSummaries` | 0 | `dayLedger` pure |
| To set up | `connections`, `mcpLibrary.list`, `connectors.list`, `mcp.list` (few projects) | 2 + N | queue 10.4 |
| Paused / Recently ended | `useAllSummaries`, last seen | 0 | as today plus L5 |
| Tiles | store + `useProjectSignals` | N + N | queue 10.4 |

`src/shared/view/cost.ts` gains `formatUsdCompact(usd)` and `costView(input, { compact: true })`: amounts of $0.01 and
more show two decimals ("$0.03", "$12.40"), amounts above zero and below $0.01 show "<$0.01", partial keeps "+",
unknown and none unchanged; the `title` keeps the full `formatUsd` figure. `Cost` takes `compact`. Used by the band,
strip, tiles and Recently ended (walk-3 L1). Run views and Usage panels keep the full precision.

`lib/settingsTarget.ts` gains `PROJECT_SETTINGS_SECTIONS.maintenance = 'settings-section-maintenance'` mapped to the
'maintenance' pane (the section id already exists in MaintenanceSection).

## 12. Keyboard, focus and announcements

### 12.1 Tab order

Topbar (h1, New chat, New project) -> status bar (no stops) -> Needs you: per row the main button, then its inline
buttons; "Show N more" -> Right now: per run the header, then its agent rows and summary rows; "Show N more runs" ->
Last 14 days: one stop (today), arrows move -> To set up: one action button per row -> Paused: row, Resume now ->
Recently ended: Clear, rows, Continue buttons -> project search -> tiles: Open, chips, More, in tile order.

DOM order equals this order at every width (2.1). Every stop has the `:focus-visible` ring (`--focus-ring`, 2 px,
inside the row's radius). Rows are native buttons; no `div` with `onClick`.

### 12.2 Focus rules

- Inline answer removes a row: next row's main button, else previous, else the Needs you h2 (5.2).
- Band rows leaving: 6.5.
- Clear in Recently ended: the next section's heading, as today.
- Opening a run, agent, chip or setup action moves focus to the destination (6.5; settings deep links focus their
  section as they already do).
- Delete: next tile's Open, else previous, else `new-project` (unchanged).
- Nothing else moves focus. Live updates never steal it.

### 12.3 Live region policy (`dashboard-live`, the only one)

Announces, politely:

| When | Text |
| --- | --- |
| A new decision arrives (a key not seen before, after the first data load) | "New decision in {project}: {ask label}" (`waitingItems` label); several within 1.5 s: "{N} new decisions" |
| Inline Allow once succeeded (the row left) | "Allowed once: {ask label}." |
| Inline Deny succeeded | "Denied: {ask label}." |
| Inline option sent | "Answered {option}." |
| Inline send failed | "Could not send the answer: {message}" |
| Delete / forget / Open folder error | unchanged ("Deleted {name}.", the forget notice text, the error) |

Never announces: agent rows appearing, leaving or changing activity; run counts; the status sentence; plan steps;
costs; limits and reset times; strip readouts; chips and To set up rows loading; elapsed or relative times. Messages
within 1.5 s join into one sentence (the walk-2 M4 rule, kept in `HeroBand`'s successor). The first data load after
mount never speaks (fixes walk-2 L4 for good: the baseline of seen decision keys is taken once history and live runs
are loaded).

## 13. Copy

| Where | Text |
| --- | --- |
| Status sentence | "1 agent working in 1 run" / "{A} agents working in {R} runs" |
| | "{R} run working" / "{R} runs working" |
| | "{N} run open, none working" / "{N} runs open, none working" |
| | "Nothing is running" |
| | "{N} paused until {14:05}" / "{N} paused" |
| | "1 was waiting on you when OrgAI closed" / "{N} were waiting on you when OrgAI closed" |
| First launch | "Welcome to OrgAI." + "Start a project or just chat. Nothing runs until you say so." |
| Limits | "{Connection} plan · {5-hour window} {62}% · resets in {2 h 10 min}" |
| | "resets in under a minute" / "resets in {25} min" / "resets in {2} h {10} min" / "resets {Thu} {09:00}" |
| | "{Connection} plan · limited until {14:00}" |
| | "+{N} more" |
| Needs you | h2 "Needs you"; empty "Nothing needs you."; "Show {N} more" / "Show fewer" |
| | "{agent label} wants to run:" / "wants to edit:" / "wants to write:" / "wants to read:" / "wants to use {tool}:" |
| | "Touches a reference folder (read only)" |
| | "Long command: open it to review" |
| | "Answer in the run" |
| | "Allow once", "Deny", "Sending…" |
| | "Could not send the answer: {message}" |
| | Team row line 1: "{project} · Team files" |
| Right now | h2 "Right now"; counts "{N} working · {N} waiting for you · {N} idle" |
| | Run line 2 suffix: " · {N} decision in Needs you" / " · {N} decisions in Needs you" |
| | "{N} more agents" / "1 more agent"; "{N} done" / "{N} done, {F} failed" |
| | "Show {N} more runs" / "Show fewer" |
| | empty "Nothing is running."; with paused "Nothing is running. {N} paused, see Paused." |
| | caption for deep rows "under {parent label}" |
| Strip | h2 "Last 14 days"; "Runs", "Cost", "Waited on you"; "Today"; |
| | readout "{Today / Tue 4 Nov}: {N} runs started{ ({F} failed)} · {cost} · waited on you {duration}" |
| | "{day}: no runs"; "No runs in the last 14 days."; "cost unknown" |
| | group name "Runs and cost per day, last 14 days" |
| To set up | h2 "To set up"; row texts per section 8; buttons "Connection settings", "Sign in", "Add token", "Set up", "Set value", "Open"; "Used by {a}, {b}, {c} and {N} more" |
| Paused | caption "resumes at {14:05} if OrgAI stays open" / "waits for you to continue"; "Resume now" |
| Recently ended | h2 "Recently ended"; "Clear" (name "Clear recently ended runs"); "Was waiting on you when OrgAI closed."; "Continue" |
| Tiles | "{N} branch waiting" / "{N} branches waiting"; "{N} team suggestion" / "{N} team suggestions"; "Folder settings to review" |
| | "{cost} last 7 days" |
| | menu "Open", "New run", "Continue {run name}", "Open folder", "Delete project…" / "Forget engagement…" |
| Announcements | section 12.3 |

Plurals everywhere through `plural(n, one, many)`. Status words only from `lib/runStatus.ts`; agent state words are
the canvas legend's (Working, Needs you, Idle, Finished, Failed).

## 14. States

| State | Behaviour |
| --- | --- |
| First launch | Status bar "Welcome to OrgAI." line, `dash-start-choice`, inline form / `empty-chat-now` (dashboard.md 6.2). No Needs you, band, strip, setup or projects. |
| Loading (history not yet loaded) | Status sentence and band render from live runs at once. The strip draws baselines and its totals read "—" until summaries arrive; no spinner. Chips and To set up appear when their calls return; chips sit in their own row above the foot, so the newest-run text never moves. |
| Error | Per-project calls and the library list fail silently (no chip, no row). Inline answer errors show in the row and are announced. Open folder errors as today. |
| Nothing open | Band one line, strip tall in the `now` area. |
| Long text | Run, project, agent names: one line, ellipsis (labels middle-clipped), full text in `title` and accessible names. Commands: 2 lines, longer ones lose inline Allow. Questions: 2 lines. Activity: 1 line. |
| Many projects (> 6) | Search field; all tiles render (no cap). |
| Many agents / runs | Caps in 2.4; "N more agents" per run; "Show N more runs". At most 12 marks animate. |
| Many decisions | Cap and "Show N more"; the count is the full number. |
| Reduced motion | Section 3.4 right column, for both the media query and `data-reduce-motion="on"`. |
| Both themes | Every colour from tokens; the light theme has no glow (as the canvas: the halo is the only working cue there). Contrast notes in section 15. |
| Run-scoped windows | The Dashboard is a main-window view only; no change. |

## 15. Tokens

New tokens, all theme-invariant composites in tokens.css section 4 (they resolve per theme through the tokens they
reference, so blocks 1-3 need no new entries and `tokens.test.ts` is unaffected). Resolved values for review:

| Token | Value | Resolves to (dark / light) |
| --- | --- | --- |
| `--halo-working` | `0 0 0 3px color-mix(in oklab, var(--state-working) 28%, transparent)` | info #2bb0ff / #1a86d9 at 28% |
| `--dur-pulse` | `1800ms` | |
| `--dash-strip-bar` | `var(--text-tertiary)` | #8791a8 on #12161f = 5.7:1 / #636d82 on #fafbfd = 5.0:1 |
| `--dash-strip-today` | `var(--accent-text)` | #a592ff on #12161f = 7.0:1 / #4f33d6 on #fafbfd = 7.3:1 |

Element-scoped, tokens.css section 5:

```css
.dash-agent-row,
.dash-run-head {
  --dash-line: color-mix(in oklab, var(--line-role, var(--edge)) 70%, var(--border-default));
}
```

Contrast notes (computed by hand, not measured): state rings on `--surface-1`: working dark #2bb0ff high, light
#1a86d9 3.7:1; waiting light #e08a00 is 2.6:1, under 3:1 for a UI component, as on the canvas today. The state is also
in the activity text and the accessible name, so colour is not the only cue; reported, not changed.

## 16. Test ids

Kept (same element and meaning unless noted): `dashboard`, `dashboard-hero` (now the status bar section; its text
carries the closed-waiting sentence), `dashboard-live`, `dashboard-app-facts`, `new-project`, `new-project-dialog`,
`projects-new-chat`, `empty-chat-now`, `dash-start-choice`, `forget-notice`, `dash-needs-you`,
`dash-needs-row[data-kind]` (incl. `team`; adds `data-run`, `data-key`, `data-inline`), `dash-running-row[data-status]`
(now on the band's run `li`; adds `data-run`, `data-project`, `data-needs`), `dash-since`,
`dash-since-row[data-status]`, `dash-since-continue`, `dash-since-clear`, `dash-paused`, `dash-paused-row`,
`dash-paused-resume`, `dash-cost` (now the strip's cost total pair), `dash-projects`, `dash-project-search`,
`project-tile[data-name][data-id][data-state]`, `project-tile-main`, `project-tile-more`, `project-tile-open-folder`,
`project-tile-delete`, `project-tile-error`, `tile-client`.

New:

| Test id | Element | Attributes e2e reads |
| --- | --- | --- |
| `dash-status-line` | `p` in the status bar | `data-working`, `data-open`, `data-paused` |
| `dash-limits` | `ul` | |
| `dash-limit` | `li` | `data-connection`, `data-kind` (window, spend), `data-level` |
| `dash-needs-allow`, `dash-needs-deny` | Buttons in a Needs you row | |
| `dash-needs-option` | Button | `data-option` |
| `dash-needs-error` | `p` in the row | |
| `dash-needs-reference` | `p` in the row | |
| `dash-needs-more` | ghost Button | |
| `dash-now` | band `section` | `data-working`, `data-waiting`, `data-idle` |
| `dash-now-counts` | `p` | spans `[data-group]` |
| `dash-now-project` | project group `section` | `data-project` |
| `dash-now-empty` | `p` | |
| `dash-now-more` | ghost Button | |
| `dash-agent-row` | `button` | `data-state`, `data-agent`, `data-run`, `data-depth` |
| `dash-agent-more` | `button` | `data-count` |
| `dash-agent-done` | `button` | `data-count`, `data-failed` |
| `dash-strip` | `section` | `data-size` |
| `dash-strip-runs`, `dash-strip-waiting` | `div` (dt + dd) | |
| `dash-strip-day` | `button` | `data-day`, `data-runs`, `data-cost-kind`, `data-today`, `data-pinned` |
| `dash-strip-readout` | `p` | |
| `dash-setup` | `section` | |
| `dash-setup-row` | `li` | `data-kind`, `data-id` |
| `dash-setup-action` | Button | |
| `tile-run` | `div` | `data-status` |
| `tile-chips` | `div` | |
| `tile-chip` | `button` | `data-kind` (branches, suggestions, folder-trust) |
| `tile-folder`, `tile-cost` | `span` | |
| `project-tile-new-run`, `project-tile-continue` | menu items | |

Removed (update CLAUDE.md and `dashboard.md` notes in the same change): `dashboard-figure`, `dash-running`,
`dash-usage`, `dash-usage-row`, `dash-usage-periods`, `dash-connections`, `dash-connection-problem`,
`dash-connections-settings`, `dash-proxies`. None is used by e2e outside `dashboard.mjs` (inventory).

## 17. e2e (`e2e/dashboard.mjs`, mock)

Keep every current check (they still hold: rows equal the bell, a `dash-running-row` exists, the waiting project's
tile is first with "1 decision · 1 run", the More menu, delete confirm, Needs row opens the card, Enter on a tile,
Escape on the dialog, no horizontal overflow and `dash-needs-you` in the viewport at 1024x640, hero at most 88 px,
relaunch Since / Continue / hero sentence, deleted project gone from Since and `dash-cost`). Add:

1. With the permission card open: its `dash-needs-row` has `data-inline=allow`; pressing `dash-needs-allow` removes the
   row, the bell drops by one, focus is on the next row's main button or the Needs you h2, and `dashboard-live` reads
   "Allowed once: …". The run's tray no longer shows the card.
2. A row offers no "Allow for session" / "Always allow" text anywhere on the page.
3. `dash-now` lists the deep-tree run's header (`dash-running-row[data-status]`) and, while it works, at least one
   `dash-agent-row[data-state=working]`; once it settles, a `dash-agent-done[data-count]`. Enter on an agent row opens
   that project's Live view with `.react-flow__node[data-id=<agent>]` selected and focused.
4. The waiting run appears once in the band (its `dash-running-row[data-needs]`), never as a second list row.
5. `dash-strip` has 14 `dash-strip-day`, today `data-today`, the run counts summing to `dash-strip-runs`; ArrowLeft
   changes `dash-strip-readout`; `dash-cost` text never reads "$0.00".
6. Reduced motion (`data-reduce-motion=on`): `getComputedStyle(mark, '::after').animationName` is `none`.
7. `tile-chip` absent on mock projects with nothing pending (no false chips); `dash-setup` absent when everything is
   connected; `dash-limits` absent under the mock.
8. Both sizes and themes: screenshots `dashboard-{w}x{h}-{theme}`; at 1024x640 the strip's top is inside the viewport
   with at most 3 decisions.

Not driven by e2e (state the mock cannot make): real plan windows and reset times, proxy spend, branches waiting, team
suggestions, folder-trust chip, services needing sign-in, question rows with inline options (unit-test
`inlineOptions`), very large runs. Unit tests: `statusSentence`, `resetsInLabel`, `inlineAllowable`, `inlineOptions`,
`bandModel` (caps, priority, grace, tree order, depth clamp), `dayLedger` (DST, local days, unknown and partial
costs, run attribution), `formatUsdCompact`, `nodeActivity`, the project queue (at most 3 in flight, cache ages).

## 18. What it does not build

Each needs a contract or a main-side change; none is faked in the renderer:

- Recent decisions the user made (needs a recent-decisions channel; answered cards are not kept).
- Decisions answered per day in the strip (needs `RunUsage.decisions`).
- Knowledge counts per engagement (whole-graph reads; needs `knowledge:summary`).
- Skill evaluation suggestions (dismissals are not persisted; the count would resurface dismissed items).
- Folder settings "changed since you allowed them" on tiles (needs a review call per trusted project; the topbar
  pointer inside the project still shows it).
- Uncommitted team files outside `listAttention`.
- A paused run cut by a quit offering Continue (walk-2 M3 second half; needs a paused marker from main).
- Update check, run outcome / files changed per finished run, per-project "last opened".
- "Start from template" as a one-click entry (needs a New project form preset entry point; small store addition, left
  for a later pass).

## 19. Skills and assets we lacked

For the UI Lead to raise with the owner; none blocks this spec:

- Motion design skill: a timing and choreography reference (staggers, breathing rates, how many simultaneous loops a
  calm screen tolerates). Durations here reuse the existing tokens and the canvas rates by judgement.
- Micro-visualisation / data-ink skill (sparklines, ledgers, small multiples in the Tufte sense): the strip is designed
  from first principles; a skill would check scale choice (linear vs sqrt for spiky cost days), tick density and
  label placement.
- Iconography: custom glyphs for the interchange and folded-group marks are drawn in CSS; a small set of OrgAI-specific
  SVG marks (interchange, station, ledger tick) in `build/` or `src/renderer/src/assets/` would make them crisper at
  DPR 1 and reusable in the canvas legend.
- A bundled typeface with good tabular figures and a distinctive mono (CSP allows `'self'` fonts): the system stacks
  (Segoe UI Variable, Cascadia) are fine on Windows but vary on macOS and Linux; a bundled pair would make the
  instrument look consistent. Needs an owner decision on licence and size.
- Contrast measurement tooling run against the rendered page in both themes (the numbers in section 15 are by hand),
  and a screen reader pass harness for the announcement policy.

## 20. Build split (2-3 UI engineers, disjoint files)

Land the shared prerequisites first (one engineer, small, before the others start, or in step 1 of engineer C):

- `src/shared/view/cost.ts` `formatUsdCompact` / `costView(..., { compact })`, `components/ui/Cost.tsx` `compact`.
- `lib/agentActivity.ts` (moved helpers) and `AgentNode.tsx` importing it.
- `store/useAppStore.ts` `decideIn`, `answerQuestionIn`.
- `lib/settingsTarget.ts` maintenance section; `store/teamAssistant.ts` `seedTeamReview` returning its promise.
- `views/DashboardView.tsx` grid shell with the six named areas and `useContainerWidth`, `styles/dashboard.css` grid
  and status bar, empty slots for the three regions below.

Then:

| Engineer | Owns | Files |
| --- | --- | --- |
| A, Right now band | Section 3.1-3.4 (band parts), 6 | `components/dashboard/RightNowBand.tsx`, `components/dashboard/BandRun.tsx`, `lib/dashboardBand.ts` (+ test), `styles/dashboard-band.css` |
| B, status bar and strip | Sections 4, 7, 8 | `components/dashboard/HeroBand.tsx` (rewrite to the status bar), `components/dashboard/ActivityStrip.tsx`, `lib/activityStrip.ts` (+ test), `components/dashboard/SetupGaps.tsx`, `lib/setupGaps.ts` (+ test), `lib/dashboard.ts` (`statusSentence`, `resetsInLabel`; remove `heroFigure`, `heroSublineParts`, `weekCost`), `components/UsageMeter.tsx` (`tightestWindowRow` export), `styles/dashboard-strip.css`; delete `components/dashboard/FactsCards.tsx` |
| C, Needs you, lists and tiles | Sections 5, 9, 10, 12.2 for these regions, 17 | `components/dashboard/AttentionColumn.tsx` (Needs you inline, Paused caption, Recently ended), `components/dashboard/NeedsInline.tsx`, `lib/needsInline.ts` (+ test), `components/dashboard/ProjectTile.tsx`, `components/dashboard/ProjectsGrid.tsx`, `components/dashboard/useProjectSignals.ts` (+ test), `styles/dashboard-projects.css`, `e2e/dashboard.mjs` |

B's `SetupGaps` uses C's project queue for `mcp.list`; C exports `enqueueProjectCall(kind, projectId, fn)` from
`useProjectSignals.ts` in its first commit. The page's announcement channel (`DashboardAnnouncement`, the 1.5 s join)
stays in `HeroBand` (B); A and C announce through the `onAnnounce` prop DashboardView already passes. Token additions
(section 15) go in with the shell. A UX walk on mock data at both sizes and themes follows the merge, then the
Reviewer pass for the inline answers.

## 21. Implementation notes (after the first look and the Reviewer, 2026-11-07)

These change the sections above; where they differ, this section wins.

- 5.2 inline Allow (Reviewer H1-H3, M1-M3): what Allow once approves is shown whole on the row and in the buttons'
  accessible names, never a cut.
  - Shell: as written, plus no runs of 2+ spaces and no tab. The command renders unclamped when it can be allowed. The
    2-line clamp stays only for rows that open the card.
  - File tools: offered only when the PermissionCard's `permissionLocation` kind is project, worktree, allowed or
    reference. The context is the same as the card's: project path, allowed and reference folders, the agent's worktree
    path, and `referenceLocation` for a `referenceFolder`. The path must be at most 200 characters.
    - The row adds the card's location line (`dash-needs-where`, warning text when the location needs attention).
    - The folder caption wraps whole, left to right (`<bdi dir=ltr>`, no rtl start-ellipsis).
    - Names carry the full path.
  - Other tools: only WebFetch (`input.url`) and WebSearch (`input.query`), at most 200 characters, with no hidden
    characters or line breaks, shown whole in mono. MCP tools, Agent and unknown tools are `data-inline=none`, because
    main's summary leaves their arguments out.
  - Buttons use `aria-disabled`, not `disabled`, so a pressed button keeps focus. After a successful send the row stays
    locked until its `*.resolved` event removes it, so a second press never answers twice. The option group is named
    "Answer: {question}".
- 7.2: "Waited on you" and the readout's waited part show from 1 second up. A sub-second wait read "0s".
- 8: mock-provider projects use no connection. Under the mock adapter the default connection does not count, so a
  machine with no Claude login (CI) does not get "Anthropic is not connected." on a mock-only Dashboard.
- 2.1: in two tracks the work area has no row gap. Areas below the first row space themselves with a top margin, so a
  region that renders nothing leaves no hole. Before this, each empty named row kept a 16 px gap: 64 px under "Nothing
  needs you." with the band empty.
- 4: measured against the real status bar it is 36 px at 1024x640 (the under-600 px-height rule) and 40 px at
  1600x1000. The earlier 98 px reading was the placeholder. The e2e keeps its 88 px ceiling.
- 10.1: the tile cost hides a reported $0 and spells an unknown cost "Cost unknown". The tile's Open button is pinned
  to the title width, so a long name ellipsises before More instead of running under it.
