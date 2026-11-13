# Schedules

Status: design and contract (2026-11-12). Nothing here is verified until the implementation notes at the end say so.

## 1. What the user gets

A schedule is a saved job: a name, a prompt, a target (a team run on a project, or an ask run in Chat), a timing and a
few limits. At each due time OrgAI starts a fresh run with that prompt, without the user present.

Example: in Chat or to a project's orchestrator the user says "I need a PR monitor that runs nightly at midnight and
reviews and merges new PRs". The agent calls `propose_schedule`; the user sees a card with the name, the prompt, the
target, "Every day at 00:00", the next three run times, the permission mode and the spend cap; Approve saves it. The
Schedules page lists every schedule and lets the user create, edit, pause, run now and delete, and shows each
schedule's history.

Scope of v1: the desktop app only, and only while the app is running (window open or kept in the background). The
`orgai` CLI has no long-lived process and gets no scheduler. No OS-level wake-up, no cloud runs, no event triggers
(webhooks, new-PR events): time only.

## 2. What other harnesses do (research 2026-11-12, sources in the run report)

| Decision | Copied from | Avoided problem |
| --- | --- | --- |
| Saved object, created from chat through a tool plus a confirmation card, and from a form | Claude Desktop, Codex, Cursor | |
| Presets plus 5-field cron, local time, optional one-off; show next runs at creation | Claude, OpenClaw | |
| Fresh session per run | Claude Desktop, Codex | memory poisoning across runs (Cursor warning) |
| At most one catch-up for the latest missed slot, others recorded as skipped | Claude Desktop | catch-up storms on restart (Claude #74055, #44128) |
| Skip when the previous run of the schedule is still live; global cap | Claude Desktop, OpenClaw | pile-ups, duplicate fires (Claude #50619) |
| Permission mode per schedule; a needed approval parks as a card and notifies | Claude Desktop, Codex | silent stalls |
| Per-run spend cap, auto-pause after consecutive failures, global pause | gh-aw, Devin, OpenClaw | runaway spend |
| History with skip reasons and a link to the run | Claude Desktop, Codex | "did it run?" confusion (Claude #47022, #95966) |
| Versioned registry, atomic writes, backup file | | registry wiped by an update (Claude #85565) |
| A scheduled run cannot create or change schedules | Claude, Cursor | self-perpetuating jobs |

## 3. Shared contract (`src/shared/types.ts` section "Schedules", `src/shared/schedule.ts` pure helpers)

All types are structured-clone safe. The section is at the end of types.ts. `SCHEDULES_IPC` is NOT spread into `IPC` (IPC is
declared earlier in the file and a const cannot be read before it is initialised); like `OUTPUTS_IPC` it is listed
separately in `jsonCodec.allChannels`, the registry and the tests. Landed (2026-11-12): the code below plus
`SCHEDULE_NAME_MAX_CHARS` 80, `SCHEDULE_PROMPT_MAX_CHARS` 8,000, `SCHEDULE_CRON_MAX_CHARS` 120, `LIST_SCHEDULES_TOOL`,
`PROPOSE_SCHEDULE_TOOL`, `ScheduleProposalItem`, `SchedulesProposalPayload` and `OrgAIApi.schedules` / `onSchedulesChanged`.
`'show-schedules'` was added to `MENU_ACTIONS` with the renderer (section 5.1), and `Schedule.lastEntry?` (the newest
history entry, main-owned) was added for the list rows.

```ts
export type ScheduleTiming =
  /** One run at a wall-clock instant (epoch ms). The schedule disables itself after firing or being missed. */
  | { kind: 'once'; at: number }
  /** Every n minutes from `anchor` (epoch ms, set by main at save). SCHEDULE_MIN_INTERVAL_MINUTES..SCHEDULE_MAX_INTERVAL_MINUTES. */
  | { kind: 'interval'; everyMinutes: number; anchor?: number }
  /** Local time 'HH:MM' on the given weekdays (0 = Sunday; absent or empty = every day). */
  | { kind: 'daily'; time: string; days?: number[] }
  /** 5-field cron in local time (minute hour day-of-month month day-of-week; lists, ranges, steps, names not supported). */
  | { kind: 'cron'; expression: string }

export type ScheduleTarget =
  /** A work run of a stored project; `team: 'single'` runs one assistant instead of the org chart (StartRunInput.team). */
  | { kind: 'team'; projectId: string; team?: RunTeam }
  /** A Chat (quick) run. No folder = a scratch folder per run. `allowEdits` as QuickRunInput. */
  | { kind: 'ask'; folder?: string; allowEdits?: boolean }

export type ScheduleMissedPolicy = 'run-once' | 'skip'
export type ScheduleState = 'active' | 'paused' | 'error' | 'done'

export interface Schedule {
  id: string                       // 'sch_<hex>', main-owned
  name: string                     // 1..SCHEDULE_NAME_MAX_CHARS (80), no hidden characters
  prompt: string                   // 1..SCHEDULE_PROMPT_MAX_CHARS (8,000)
  target: ScheduleTarget
  timing: ScheduleTiming
  enabled: boolean
  missed: ScheduleMissedPolicy     // default 'run-once'
  /** Root model for each run (StartRunInput.modelSelection). Absent = the project's / Chat's default. */
  modelSelection?: { model: string; connection: ConnectionId }
  /** Permission mode of each run. Absent = the project's mode. Never 'bypassPermissions' (refused on save). */
  permissionMode?: PermissionMode
  /** Spend cap per run in USD (the run's conversation budget). Absent = the project's own cap, if any. */
  budgetUsd?: number
  /** Disable after this instant (epoch ms). */
  expiresAt?: number
  // main-owned from here on; ignored on save
  state: ScheduleState
  /** Why the state is 'error' or 'done', one plain sentence. */
  stateReason?: string
  createdAt: number
  updatedAt: number
  createdBy: 'user' | 'agent'      // 'agent' = an approved proposal
  nextRunAt?: number               // absent when not enabled / done
  lastSlotAt?: number              // the last slot handled (started, skipped or missed), so no slot fires twice
  consecutiveFailures: number
  unread: number                   // history entries the user has not seen
}

export type ScheduleRunResult = 'started' | 'skipped' | 'failed'
export type ScheduleSkipReason = 'previous-running' | 'too-many-running' | 'app-closed' | 'paused-globally'
  | 'project-missing' | 'usage-limited' | 'start-refused'

export interface ScheduleHistoryEntry {
  id: string
  scheduleId: string
  slotAt: number                   // the due time this entry answers
  at: number                       // when it was handled
  trigger: 'timer' | 'catch-up' | 'manual'
  result: ScheduleRunResult
  reason?: ScheduleSkipReason
  /** A plain OrgAI-written sentence for 'failed' / 'start-refused' (never a raw provider message). */
  detail?: string
  runId?: string
  projectId?: string               // the run's project id (a virtual id for ask runs)
  /** Filled when the run ends: how it ended and what it cost (null = unknown). */
  outcome?: 'finished' | 'error' | 'stopped' | 'needs-you'
  costUsd?: number | null
}

export interface ScheduleSaveInput {  // schedules:save. No id = create.
  id?: string
  name: string; prompt: string; target: ScheduleTarget; timing: ScheduleTiming
  enabled?: boolean; missed?: ScheduleMissedPolicy
  modelSelection?: { model: string; connection: ConnectionId } | null
  permissionMode?: PermissionMode | null
  budgetUsd?: number | null
  expiresAt?: number | null
  /** Refuse when the stored schedule changed since the form loaded it. */
  expectedUpdatedAt?: number
}

export interface SchedulesChangedEvent { scheduleIds: string[]; removed?: string[] }
```

Limits: `SCHEDULES_MAX` 50, `SCHEDULE_HISTORY_MAX` 50 entries per schedule, `SCHEDULE_MIN_INTERVAL_MINUTES` 15,
`SCHEDULE_MAX_INTERVAL_MINUTES` 43,200 (30 days), `SCHEDULE_MAX_CONCURRENT_RUNS` 2, `SCHEDULE_FAILURES_TO_PAUSE` 3,
`SCHEDULE_CATCH_UP_WINDOW_MS` 24 h, `SCHEDULE_BUDGET_MAX_USD` 1,000, `SCHEDULE_PROPOSAL_MAX_ITEMS` 5.
A cron expression whose two closest fires are less than 15 minutes apart is refused.

`RunSummary.scheduleId?: string` and `RunSummary.scheduleName?: string` (main-owned) mark a run a schedule started;
continuations do not carry them (the user took over).

`AppSettings.schedulesPaused?: boolean` is the global pause (kill switch). While true nothing fires and due slots are
recorded as skipped `paused-globally` (one entry per schedule per pause, not one per slot).

### Pure helpers (`src/shared/schedule.ts`, unit-tested, no Node or DOM imports)

- `scheduleTimingProblem(timing): string | null` - a readable sentence or null.
- `nextScheduleRun(timing, after: number, lastSlotAt?: number): number | null` - the first slot strictly after `after`,
  in local time. DST: a local time that does not exist that day fires at the next valid minute; a local time that
  occurs twice fires once (the first). Must terminate for every valid expression (bounded search, 5 years).
- `upcomingScheduleRuns(timing, after, count)` (count <= 5), `describeScheduleTiming(timing, locale?)`
  ("Every day at 00:00", "Weekdays at 09:30", "Every 2 hours", "Once on 14 Nov 2026 at 08:00", "Cron: 0 0 * * 1").
- `parseCron(expression)` - hand-written, 5 fields, `*`, lists, ranges, steps; day-of-month and day-of-week combine
  like Vixie cron (either matches when both are restricted). No dependency is added.
- `cleanScheduleInput(input: unknown)` - shape and limit checks shared by IPC and the proposal tool; returns
  `{ ok: true, value: ScheduleSaveInput }` or `{ ok: false, problem }`. It rebuilds from known fields (main-owned fields
  are dropped), trims name and prompt, refuses hidden characters (`view/hiddenChars.hasHidden`; the name also any control
  character) and keeps `null` on the clearable fields. It does not know projects, folders, models or the clock.
  `parseCron` returns `{ ok, cron } | { ok: false, problem }`. `SCHEDULE_PERMISSION_MODES` = every PermissionMode except
  'bypassPermissions'.
- `interval` slots are `anchor + k * everyMinutes` for k >= 1 (the anchor, the save time, is not itself a slot); without
  an anchor the first slot is `after + everyMinutes`. `nextScheduleRun` also searches strictly after `lastSlotAt`.
- `scheduleTimingProblem` also refuses a cron that never matches a date (`0 0 31 2 *`), judged over a fixed four-year
  calendar; `nextScheduleRun` returns null for it. It does not look at the clock, so a `once` in the past is main's check.

### IPC (`SCHEDULES_IPC`; preload `window.orgai.schedules`)

| Channel | Args -> result | Scope |
| --- | --- | --- |
| `schedules:list` | () -> Schedule[] (by name) | read |
| `schedules:history` | (scheduleId) -> ScheduleHistoryEntry[] newest first; clears `unread` | read |
| `schedules:save` | (ScheduleSaveInput) -> Schedule | configure, desktop only |
| `schedules:remove` | (scheduleId) -> void (history removed; runs kept) | configure, desktop only |
| `schedules:setEnabled` | ({ id, enabled }) -> Schedule (enabling clears 'error' and the failure count) | configure, desktop only |
| `schedules:runNow` | (scheduleId) -> ScheduleHistoryEntry (trigger 'manual'; works while paused; overlap rule applies) | operate, desktop only |
| `schedules:changed` | push SchedulesChangedEvent to every window | |

Every write channel rebuilds its input through `cleanScheduleInput` and refuses unknown ids. "Desktop only" means: the
registry scope is `configure` / `operate` (it only gates the params) and the dispatcher handler refuses any surface but
`'desktop'` with `scope_denied`, like `runs:setPermissionMode`; so a socket client and the CLI's in-process host cannot
save, remove, enable or run a schedule, and nothing ticks there. `schedules:changed` is a desktop-only push (registry).
Params: `schedules:history` / `remove` / `runNow` take an id (`^[A-Za-z0-9_-]{1,128}$`), `save` / `setEnabled` an object.
`schedules:save` lists `modelSelection`, `permissionMode`, `budgetUsd` and `expiresAt` as nullable in the JSON codec.

## 4. Main (`src/main/schedules/`)

- `store.ts` `ScheduleStore`: `<data>/schedules.json` (`{ version: 1, schedules, history }`), written through
  `store/durableFs.ts`, with the previous good file kept as `schedules.json.bak`. A file that exists but does not parse
  is never overwritten: the store loads the backup if it parses, otherwise starts empty in a read-only state where
  writes refuse with a sentence naming the file (the knowledge-graph rule). Junk entries are dropped on read.
- `service.ts` `ScheduleService`: validation, save / remove / setEnabled / runNow, `fire(schedule, slotAt, trigger)`,
  history, `applyProposal`. Starting a run goes through the same entry points as the user's own start
  (`RunManager.start` for a team target, `QuickRunService.start` for an ask target) with the desktop flag, so every
  existing check applies (catalog model, price under a cap, folder trust, permission-mode choices, usage limits).
  `budgetUsd` becomes the run's conversation budget. The service never talks to an adapter.
- `scheduler.ts` `Scheduler`: one timer, injected clock (`now`, `setTimeout`) for tests. It wakes at the earliest
  `nextRunAt` (at most every 60 s, so a sleep / clock change is noticed) and handles every due schedule in name order:
  1. A slot is due when `nextRunAt <= now`. `lastSlotAt` is written before the run starts, so a crash never refires.
  2. Lateness over 5 minutes (sleep, app closed) makes it a missed slot: with `missed: 'run-once'` and within
     `SCHEDULE_CATCH_UP_WINDOW_MS` exactly one run starts for the latest missed slot (trigger 'catch-up'); every
     other case records one skipped entry `app-closed`. Never more than one run per schedule per wake.
  3. Overlap: a schedule whose previous run is still live (not ended and not paused) skips with `previous-running`.
     More than `SCHEDULE_MAX_CONCURRENT_RUNS` live scheduled runs skips with `too-many-running`.
  4. A start that throws records 'failed' with a plain sentence. A run that ends in `error`, and a failed start, count
     toward `consecutiveFailures`; a finished run resets it. At `SCHEDULE_FAILURES_TO_PAUSE` the schedule goes to
     state 'error', is disabled and the user is notified. A missing project disables it at once.
  5. `once` schedules and expired ones go to state 'done'.
  6. Catch-up runs after boot start no earlier than 30 s after startup and 10 s apart.
  The scheduler starts only in the desktop shell (`index.ts`), after stores and RunManager, and stops in the quit path.
  The desktop's single-instance lock is the "one scheduler" guard.
- As built (2026-11-12, unit-tested, see 9):
  - `validate.ts` holds the main-side checks shared by `schedules:save`, `applyProposal` and `propose_schedule`:
    `mergeScheduleInput` (on update an absent optional field keeps the stored value, `null` clears it; an interval's
    anchor is set at save and kept while the interval is unchanged) and `scheduleFieldsProblem` (stored project, ask
    folder through `validateQuickFolder`, an ask target only takes Ask / Never ask / Plan, a `once` or end date in the
    past, a next run before the end date, and no bypass: a team schedule without its own mode whose project runs with
    bypassPermissions is refused with `SCHEDULE_INHERITS_BYPASS`, "Its project runs with bypass permissions, which a
    schedule cannot use. Choose a permission mode for the schedule."; `effectiveScheduleMode` resolves the mode).
  - Start paths: a team target calls `RunManager.start({ project, prompt, schedule, team?, userChoice, conversationBudgetUsd })`
    with the stored project's `maxBudgetUsd` and the run's `conversationBudgetUsd` both set to `scheduledRunCap` =
    `min(budgetUsd, project cap)` (the project cap alone when the schedule has none; neither when nothing caps it), so
    main enforces the cap on every unattended run, not only the adapter. An ask target calls
    `QuickRunService.start(input, { schedule })` (a main-only `QuickStartOptions.schedule`), which does the same on the
    quick project. A consequence: a capped scheduled run on a model with no known price is refused before launch (the
    existing priced-model-under-a-cap rule), like a capped desktop continuation. A user's own runs are unchanged.
    `modelSelection` / `permissionMode` go in as `StartInput.userChoice`, so `checkStartChoice` (catalog model,
    `runPermissionModeChoices`) applies. `StartInput.schedule` is set only by the service (never from IPC input) and
    becomes `RunSummary.scheduleId` / `scheduleName`; RunManager passes it on only to its own usage-limit auto-resume
    of a scheduled run (`SCHEDULED_RESUME`), never to a user's continuation.
  - "Live" for the overlap rule and the global cap (`runBlocks` plus the service's own counts): starting, running,
    stopping, or idle while it still works without the user (`ScheduleRunFacts.working`, RunManager's `runActivity`
    state 'working' / 'ending': reports at work, peer messages queued or flushing, a continuation nudge due) or waits
    with an open card or a usage-limit hold; a run paused at a usage limit whose auto-resume is armed
    (`RunManager.hasAutoResume`); and a start still in flight (a per-schedule "starting" count taken before the start
    is awaited and released when it settles, so a double Run now or Run now racing the timer cannot start two). An idle
    run with nothing left counts as done (outcome 'finished'). Only runs this process started are tracked (memory
    only); a deleted schedule's runs stay counted until they end.
  - Outcomes: a card request sets 'needs-you'; idle with nothing left (not working, no card, no hold) or 'finished'
    sets 'finished' (an idle run that still works is looked at again on its next idle or its end); `error` sets
    'error'; `endedBy` 'user' / 'app' / 'policy' set 'stopped'; `endedBy` 'budget' sets 'error' (it counts toward
    auto-pause). A run paused at a usage limit is not an outcome: its auto-resume continuation carries the schedule id,
    is tracked in its place (same history entry) and its end fills that entry.
  - A start that throws records result 'failed', reason 'start-refused' and the fixed sentence `START_FAILED_DETAIL`;
    the thrown message goes to the main log only (it may carry provider text). A start that has not returned after
    `SCHEDULE_START_TIMEOUT_MS` (5 minutes) records 'failed' with `START_TIMED_OUT_DETAIL` and the pass moves on; a run
    that arrives later is tracked (it counts toward the overlap rule and the cap until it ends, without counting a
    second failure) and stopped through `RunManager.stop`. A team schedule whose project was switched to bypass after
    the save is not started: 'failed' with `SCHEDULE_BYPASS_NOT_STARTED` (counts toward auto-pause).
  - The scheduler acts on fresh state: every iteration of a pass re-reads the schedule and the global pause and skips
    a schedule that was deleted, paused or re-timed while an earlier start was awaited; `claimSlot` refuses a disabled
    or missing schedule. The catch-up walk compiles the timing once (`compileScheduleTiming` in `src/shared/schedule.ts`)
    and starts at `now - SCHEDULE_CATCH_UP_WINDOW_MS - LATE_MS`; when no slot lies in that window the reported missed
    slot is the first missed one (harmless: the next run is computed from now and such a slot is never caught up).
  - Proposal updates: an `update` item's `schedule` holds the fully merged schedule (explicit `null` for a cleared
    optional field) and `expectedUpdatedAt` (the stored `updatedAt` when the card was built); `applyProposal` refuses
    when the stored schedule changed since ("The schedule changed since this was proposed; ask again."). Main-written
    summaries name the resolved permission mode, the model and the real cap ("No spend cap" when nothing caps it); a
    `resume` item's summary carries target, timing, mode, model and cap; double quotes in a name are replaced with `'`
    in main-written titles, summaries and notifications.
  - `unread` grows by one per history entry; `lastEntry` mirrors the newest entry and its outcome.
  - Earlier slots passed over by an on-time fire (a short sleep) get one 'app-closed' entry. An expired schedule whose
    next slot is past `expiresAt` goes to 'done' without an entry.
  - `ORGAI_SCHEDULE_TEST_TICK_MS` (50 ms .. 60 s, only with `ORGAI_MOCK=1`) replaces the 60 s maximum sleep.
  - `schedules:changed` is not on the host event bus: like `teamFiles:changed` it goes through
    `DesktopHooks.schedulesChanged` to every window (index.ts), which also re-plans the timer. A settings change
    re-plans too (the global pause).
  - 'usage-limited' is never recorded in v1 (a run at a usage limit is reported by its own outcome).
- Run end: the service listens to run events (bootstrap's bus listener), fills the history entry's `outcome` /
  `costUsd` and updates `consecutiveFailures`. Notifications: the existing run Notifier already notifies an unfocused
  user about a scheduled run's cards, end and failure (title = project name), so the service adds only what it alone
  knows, through `Notifier.notice` (respects `AppSettings.notifications`, shown even while focused): a start that
  failed, a schedule paused after `SCHEDULE_FAILURES_TO_PAUSE` failures, a schedule stopped because its project is gone.
  No separate "success" notice (deviation from the first draft: it would duplicate the Notifier's "Run finished").
- Unattended behaviour: nothing is auto-approved. A scheduled run that needs an approval waits with its card exactly
  like a run the user started, shows in Needs-you and notifies. Session-only grants do not exist at start; project
  allow rules apply. Plan nudges apply as for any work run.
- Background: an enabled schedule with a next run (and no global pause) makes the last-window close ask the existing
  "Keep working in the background" question (`hostLifecycle.windowAllClosedAction` `pendingSchedules`; the message reads
  "A scheduled run is due later." or "<n> runs are still working, or scheduled runs are due."). While in the
  background the pending schedules count under the activity kind `pausedAutoResumes` (a timer-like wait, never a
  writer the quit drain settles), so the idle exit does not quit before they run; `pendingCount()` is 0 while the
  global pause is on. The scheduler stops at the drain's quiesce and on will-quit.
- The schedule harness hooks (`RunManagerOptions.schedules`) are wired only on the desktop host: the CLI's in-process
  host never fires a schedule, so it offers neither `list_schedules` nor `propose_schedule`.

### Conversational creation

- Harness tools in `harnessTools.ts`: `list_schedules` (non-blocking; names, timing descriptions, targets, state, next
  run; every string through `promptDatum`) and `propose_schedule` (blocking, a proposal card). Audience: the root of
  Chat runs (added to `CHAT_CONFIG_TOOLS`) and the root of work runs of stored projects. Not on setup-like runs, not
  on reports, and refused on any run with `RunSummary.scheduleId` ("A scheduled run cannot create or change
  schedules.").
- `Proposal` kind `'schedules'`, payload `SchedulesProposalPayload { items: ScheduleProposalItem[]; rationale }`, an
  item is `{ action: 'create' | 'update' | 'remove' | 'pause' | 'resume', scheduleId?, schedule?: ScheduleSaveInput,
  summary: main-written description, nextRuns: number[] }`. From a work run the target defaults to that project and a
  different project is refused; from Chat a team target must name a stored project (main fills the name, never agent
  text). An agent can never set `bypassPermissions`, and a proposed `permissionMode` wider than the target project's
  own mode is refused (the user can widen it in the form).
- Approval applies through `ScheduleService.applyProposal` (validate all, then write), effect 'now'. The proposal
  outcome tells the agent the saved ids and next run times (the tool reads them through
  `RuntimeContext.schedules.applied(payload)`, keyed by the payload object, so `ProposalOutcome` is unchanged).
- As built: the tools are offered on Chat, team work and single runs, audience 'root'. On a run with
  `RunSummary.scheduleId` both tools (list too) answer "REFUSED: A scheduled run cannot create or change schedules.",
  and RunManager refuses such an apply again. From a work run an ask target is refused like another project. The card
  title and each item's `summary` are written by main from the merged fields; `nextRuns` holds three slots. The two
  tool definitions add about 2,400 characters to every work and single run request (`toolDefinitionSize.test.ts`
  bounds raised). `CHAT_CONFIG_TOOLS` lists the two names as string literals (the constants are declared later in
  types.ts; a test checks they match).
- `app_reference` / atlas: a `schedules` surface so "where are my schedules" works and `open_in_app` can open the page.

## 5. Renderer

- App-level view `'schedules'` (`views/SchedulesView.tsx`, `components/schedules/*`), reached from the sidebar's app
  area next to Usage, View > Schedules (menu action `show-schedules`, target 'main') and the atlas surface.
- List: name, target (project or Chat), timing description, next run (relative and absolute), state chip
  (Active / Paused / Needs attention / Done), last result, unread dot. Row actions: Run now, Pause / Resume, Edit,
  Delete (confirm). A page-level "Pause all schedules" switch (`schedulesPaused`) with a banner while on.
- Editor (dialog or side sheet, shared primitives): Name; What to do (prompt); Run as: Team run on <project> (optional
  single assistant) or Ask (Chat; optional folder); When: Daily / Weekdays / Weekly / Every n hours / Once / Custom
  (cron) with the next three run times live from `upcomingScheduleRuns`; If missed: run once when OrgAI is next open /
  skip; Model (existing picker, optional); Permission mode (the run's choices minus bypass) with the sentence "If a
  step needs your approval the run waits for you"; Spend cap per run; a plain note: "Runs only while OrgAI is open.
  Each run uses tokens."
- History: per schedule, newest first: time, trigger, result with the skip reason in words, outcome, cost, and a link
  that opens the run. Opening it clears the unread count.
- Proposal card for kind 'schedules' (`ProposalCard` family): one block per item with the same fields in words, the
  next three runs, and the cost / unattended sentence. Approve / Ask for changes / Decline as other cards.
- A run a schedule started shows a small "Scheduled: <name>" label in its run meta, linking to the schedule.
- Empty state teaches the chat path: "Ask in Chat, for example: 'Review new pull requests every night at midnight'",
  with a New schedule button.
- Both themes, both supported window sizes, keyboard reachable, reduced motion respected (no new motion needed).

### 5.1 As built (renderer, 2026-11-12)

Files: `views/SchedulesView.tsx`, `components/schedules/{useSchedules.ts, ScheduleRow.tsx, ScheduleHistory.tsx,
ScheduleEditor.tsx}`, `styles/schedules.css`, `components/proposals/SchedulesProposalBody.tsx`, `lib/scheduleProposal.ts`,
the pure view-model `src/shared/view/schedules.ts` (row, chip, history wording, editor <-> `ScheduleSaveInput`, permission
choices; CLI-reusable), the store's `view: 'schedules'` / `openSchedules({ scheduleId? })` / `schedulesFocus`, the sidebar
entry after Usage, View > Schedules (`show-schedules`, target 'main', no accelerator, always enabled), the atlas surface
`schedules` (also the surface of `APP_SETTING_DOCS.schedulesPaused`) and its `open_in_app` target.

Contract addition (approved): `Schedule.lastEntry?` (the newest history entry) feeds the row's "Last result", because
`schedules:history` clears `unread` and cannot be read per row. Without it the row falls back to "N failed in a row" /
"Last due <time>" / "Not run yet".

Deviations and decisions:
- Editor is the shared `Dialog` (size lg). "Every n hours" is "Every few hours" with a count and an hours / minutes unit
  (an agent-made 90-minute interval stays editable); Weekly has weekday checkboxes (Monday first); Custom shows the
  five-field hint. Problems show after the first Save (timing problems at once, since the next runs depend on them); Save
  focuses the field a problem is about. A single run in the past is refused in the form ("Choose a time in the future.").
- The interval anchor is kept while the interval is unchanged, so an edit does not move the slots. Edit sends `null` to
  clear model / mode / cap the stored schedule had, and `expectedUpdatedAt`; create sends `enabled: true`. Expiry is not
  editable in v1 (kept as stored).
- Permission modes: a team target offers every work-run mode, a Chat target only the Chat modes (Ask for everything risky,
  Never ask, Plan only); never bypass. Switching target drops a mode the new target refuses. A mode that asks less than
  the target's own (the project's mode; Chat: Ask for everything risky) is confirmed with schedule wording ("Let every run
  of this schedule use X? ... including while you are away"), unless mode and target are both unchanged.
- Model uses the New run page's model chip (`StartModelControl`); with nothing picked it reads "Project default" for
  both targets (for Chat that means the Chat model).
- Pause all is a switch in the page header, saved through `settings:set`; the page trusts only the value main returns, so
  a build whose main drops `schedulesPaused` says "The pause setting was not saved." While on, a warning banner explains
  that due times are recorded as skipped, and rows read "Held: all schedules paused".
- History is a disclosure per row (loading it clears unread; the list reloads only when the row had unread): a table of
  when (title: due and handled times), trigger (On schedule / Missed run, caught up / Run now), result badge plus the reason
  in words, outcome in run status words (Finished / Failed / Stopped / Needs you; "Running" before it ends), cost (unknown
  is "unknown", not ended is a dash) and "Open run" (focusRun, then the run view, focus settled on the composer).
- Run now, Pause / Resume, Edit, Delete (ConfirmDialog, danger) per row; a Done schedule offers no Resume (edit it).
  Action results go to one polite live region; failures show as a danger banner (role=alert), not twice.
- The "Scheduled: <name>" run meta button opens the page on that schedule's row (heading focused).
- The proposal card lists per item: action, name, main summary, What to do, Runs as, Folder (full path, Chat), When, Next
  runs (main-written), If a run is missed, Model, Permission mode, Spend cap, and the unattended / approval sentences
  under create / update / resume. Buttons: Approve, Request changes, Not now.
- Error path: every `window.orgai.schedules` call may reject; the page shows "Schedules could not be loaded" with Try
  again, the editor shows the save refusal in view (role=alert), the history shows its own error line.

Stable test ids (for `e2e/schedules.mjs`): page `schedules-view`, nav `nav-schedules`, `schedules-new`,
`schedules-empty` / `schedules-empty-new` / `schedules-empty-chat`, `schedules-error` / `schedules-retry`,
`schedules-loading`, `schedules-list`, `schedules-live`, `schedules-action-error`, `schedules-pause-all`,
`schedules-paused-banner`; row `schedule-row` (`data-schedule-id`, `data-state`), `schedule-state`,
`schedule-state-reason`, `schedule-unread`, `schedule-target`, `schedule-timing`, `schedule-next`, `schedule-last`,
`schedule-run-now`, `schedule-toggle`, `schedule-edit`, `schedule-delete`, `schedule-delete-confirm`,
`schedule-history-toggle`, `schedule-history`, `schedule-history-row` (`data-result`, `data-reason`),
`schedule-history-open`, `schedule-history-empty`, `schedule-history-error`, `schedule-history-open-error`; editor
`schedule-editor`, `schedule-field-name`, `-prompt`, `-target-team`, `-target-ask`, `-project`, `-single`, `-folder`,
`-folder-browse`, `-folder-clear`, `-allow-edits`, `-preset`, `-time`, `-days`, `-day-<0..6>`, `-every`, `-every-unit`,
`-once-date`, `-once-time`, `-cron`, `-missed-run-once`, `-missed-skip`, `-model` (chip inside: `run-model-change`),
`-permission`, `-budget`, `schedule-next-runs`, `schedule-next-run`, `schedule-error-<field>`,
`schedule-unattended-note`, `schedule-save`, `schedule-cancel`, `schedule-save-error`, `schedule-permission-confirm`;
card `proposal-schedules`, `proposal-schedule-item` (`data-action`), `proposal-schedule-next`,
`proposal-schedule-note`, `proposal-schedule-hidden`; run meta `run-meta-scheduled`.

Verified: unit tests (`src/shared/view/schedules.test.ts`, `lib/scheduleProposal.test.ts`, `lib/proposalSummary.test.ts`,
`lib/runSettings.test.ts`, `src/main/appMenu.test.ts`, atlas and appNavigate tests); a token-free walk of the built app on
the mock adapter before the runtime half merged (error state, editor, validation, next runs, Chat modes, keyboard order,
save refusal in view, pause refusal; 1024x640 and 1600x1000, dark and light). Not verified: the list, rows, history,
Run now, the proposal card and the run meta label against real data (need the runtime half), the widening confirmation
in the app (mock projects run Unattended), screen-reader speech.

## 6. Security and spend notes (for the Reviewer)

- A schedule is standing consent to spend. It can only be created by the user's own form save or an approved card;
  both show the timing, the next runs and the unattended / token sentence. Agents cannot enable, widen or re-time a
  schedule without a card; scheduled runs cannot touch schedules at all.
- The prompt is user-approved text stored locally; it is delivered as the run's first user message like any prompt.
- No permission widening: no bypass mode, neither chosen nor inherited from the project (checked at save, at proposal
  apply and again at each fire against the project as it is then), no auto-approve, no carried session grants; an ask
  target stays trust-restricted like every Chat run. An ask target's folder goes through `validateQuickFolder` at each
  fire.
- Bounds: minimum interval 15 minutes, one run per schedule at a time, two scheduled runs at once (both counting
  starts in flight, idle runs whose reports still work, runs paused with an armed auto-resume and its continuation,
  and runs of deleted schedules), one catch-up, auto disable after three consecutive failures, a per-run cap of
  min(schedule cap, project cap) enforced by main, a global pause, 50 schedules, a 5-minute start timeout.
- An approved update card applies exactly what it showed: the merged schedule, refused if the schedule changed since.
- The history `detail` and notifications carry only OrgAI-written sentences.

## 7. Tests

- Unit: `schedule.test.ts` (cron parsing, next-run over DST forward and back in a fixed zone, month ends, leap day,
  intervals, termination, refusals), `store.test.ts` (atomic write, backup, unreadable file never overwritten, junk
  dropped), `scheduler.test.ts` with a fake clock (no double fire, crash between mark and start, sleep catch-up once,
  skip reasons, overlap, global cap, auto-pause, once / expiry, global pause, boot stagger), `service.test.ts` on the
  mock adapter (team and ask starts, budget and mode passed, refusal sentences, proposal apply), harness tool tests
  (audience, scheduled-run refusal, mode widening refusal), registry / params / jsonRoundTrip counts.
- e2e (token-free, mock): `e2e/schedules.mjs` in `e2e:free` and `scripts/e2e-select.mjs`: create from the form, see
  next runs, Run now starts a mock run and history links to it, pause / resume, edit, delete, the proposal card from a
  `[mock:schedule]` Chat marker, global pause banner. A due-time fire is driven with `ORGAI_SCHEDULE_TEST_TICK_MS`
  (test-only, honoured only with `ORGAI_MOCK=1`) and a `once` schedule a few seconds ahead.

## 8. Not in v1

Event triggers, running while the app is closed (OS task scheduler / a daemon), a worktree per scheduled run beyond
what the project's isolation already does, schedules in the CLI, time zones other than the system's, chaining a run's
output into the next run, per-schedule run-count caps.

## 9. Implementation notes, main process (2026-11-12)

Checked by unit tests only (`npx vitest run src/main/schedules`, no tokens): `store.test.ts` (atomic write, `.bak`,
unreadable file never overwritten and the store read-only, junk dropped, caps), `scheduler.test.ts` (fake clock: one
fire per slot, mark before start, crash between mark and start, one catch-up after a sleep with the boot delay and
the 10 s gap, app-closed skips, on-time within 5 minutes, global pause one entry per pause, once / expiry to done,
overlap, stop), `service.test.ts` (save / update / clear, refusals, enable / pause, history and unread, fire with
model, mode, budget and single team, folder re-check, overlap, global cap, project missing, auto-pause with an OrgAI
sentence only, run-end outcomes and cost, proposal apply with origin and mode-widening refusals, all or nothing),
`boot.test.ts` (a booted host on the mock adapter: a team schedule's run carries `scheduleId`, `scheduleName`, mode
'plan' and `conversationBudgetUsd`; an ask schedule starts a Chat run; a refused model records a failed start;
socket and in-process surfaces get `scope_denied` on every write and runNow, list and history answer). The tool
tests are `runtime/harnessToolsSchedules.test.ts`. Not verified: a live provider run, the desktop timer in the
packed app (index.ts wiring), OS notifications, the close prompt and the background idle exit, sleep / resume of a
real machine, DST transitions on a live clock, the RunManager apply branch of an approved card end to end (applied
through ScheduleService directly in the tests).

Security and spend review fixes (2026-11-12, unit tests only, no tokens): `service.review.test.ts` (H1 an idle run
that still works blocks and keeps its outcome open; M2 a double Run now and starts in flight against the cap; M3 save,
apply and fire refuse an inherited bypass; M4 a stale or unstamped update card is refused; claimSlot refuses a paused
or deleted schedule; L1 a paused run with an armed auto-resume blocks and its scheduled continuation is tracked into
the same entry, a user continuation is not; L2 a deleted schedule's run still counts; L5 quotes in notification
titles; L7 no pending count under the global pause; L9 the start timeout and a late run tracked and stopped;
`scheduledRunCap`), `scheduler.test.ts` ("Scheduler re-reads state between starts": a schedule deleted, paused or
globally paused while an earlier start is awaited does not start; "catch-up walk over a long gap": a 15-minute cron
six months back resolves in milliseconds, 22.8 s before), `schedule.test.ts` (`compileScheduleTiming` agrees with
`nextScheduleRun`), `harnessToolsSchedules.test.ts` (merged update items with explicit nulls and
`expectedUpdatedAt`, resolved mode / model / cap in summaries, bypass refusal, quote-safe names, full resume summary),
`runManagerOutputs.test.ts` (`liveRunFacts.working`), `noElectronImport.test.ts` (the schedules modules load in plain
Node). Not verified: the RunManager auto-resume passing `SCHEDULED_RESUME` on a real usage-limit pause (the service
side is tested with fake events; the RunManager branch is checked by typecheck and reading only), the
`liveRunFacts.working` value for an idle root with live reports on a real adapter, and the 5-minute timeout on a real
hung start.
