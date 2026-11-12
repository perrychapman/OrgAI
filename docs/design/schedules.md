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

All types are structured-clone safe. Append the section at the end of types.ts; `SCHEDULES_IPC` is spread into `IPC`.

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
- `cleanScheduleInput(input)` - shape and limit checks shared by IPC and the proposal tool; returns the problem or the
  cleaned value. `SCHEDULE_PERMISSION_MODES` = every PermissionMode except 'bypassPermissions'.

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

Every write channel rebuilds its input through `cleanScheduleInput` and refuses unknown ids. On the CLI's in-process
host the write channels and runNow are refused (desktop only) and nothing ticks.

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
- Run end: the service listens to run events, fills the history entry's `outcome` / `costUsd`, bumps `unread` and
  notifies through `notifications.ts` (respecting `AppSettings.notifications`): always on failure and on "needs you"
  (the run is waiting on a card), on success only for a catch-up or when the user is not focused on that run.
- Unattended behaviour: nothing is auto-approved. A scheduled run that needs an approval waits with its card exactly
  like a run the user started, shows in Needs-you and notifies. Session-only grants do not exist at start; project
  allow rules apply. Plan nudges apply as for any work run.
- Background: a pending enabled schedule counts as activity for the quit gate's "Keep working in the background"
  question (the existing dialog; wording gains "or scheduled runs are due").

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
  outcome tells the agent the saved ids and next run times.
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

## 6. Security and spend notes (for the Reviewer)

- A schedule is standing consent to spend. It can only be created by the user's own form save or an approved card;
  both show the timing, the next runs and the unattended / token sentence. Agents cannot enable, widen or re-time a
  schedule without a card; scheduled runs cannot touch schedules at all.
- The prompt is user-approved text stored locally; it is delivered as the run's first user message like any prompt.
- No permission widening: no bypass mode, no auto-approve, no carried session grants; an ask target stays
  trust-restricted like every Chat run. An ask target's folder goes through `validateQuickFolder` at each fire.
- Bounds: minimum interval 15 minutes, one run per schedule at a time, two scheduled runs at once, one catch-up, auto
  disable after three consecutive failures, optional per-run cap, a global pause, 50 schedules.
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
