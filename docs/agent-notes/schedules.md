# Schedules

Recurring or one-off jobs that start a fresh team (work) run on a project or an ask (Chat quick) run at a due time,
without the user present. Desktop app only, only while it is running. Full spec, "As built" notes and the review
history: `docs/design/schedules.md`. Each fact below says how it was checked; "unverified" means no test or run
confirmed it.

## Contract

- `src/shared/types.ts` section "Schedules" (end of file): `Schedule`, `ScheduleTiming` (once / interval / daily /
  cron), `ScheduleTarget` (team on a project, optional single assistant; ask with an optional folder),
  `ScheduleHistoryEntry`, `ScheduleSaveInput`, `SchedulesProposalPayload`, the limits, `SCHEDULES_IPC` (declared like
  `OUTPUTS_IPC`, not spread into `IPC`), `OrgAIApi.schedules` and `onSchedulesChanged`. `Schedule.lastEntry` is the
  newest history entry for list rows. `RunSummary.scheduleId` / `scheduleName` mark a run a schedule started;
  a user's continuation drops them, a usage-limit auto-resume keeps them. `AppSettings.schedulesPaused` is the global
  pause. Proposal kind `'schedules'`.
- `src/shared/schedule.ts` (pure, no dependency): `parseCron` (5 fields, local time), `scheduleTimingProblem`,
  `compileScheduleTiming`, `nextScheduleRun`, `upcomingScheduleRuns`, `describeScheduleTiming`, `cleanScheduleInput`.
  Minimum interval 15 minutes (a denser cron is refused); a cron that never matches is refused. DST: a missing local
  time fires at the next valid minute, a repeated one fires once. Unit-tested with `TZ=America/New_York`.
- Channels: `schedules:list` / `history` (read, every surface), `save` / `remove` / `setEnabled` (configure) and
  `runNow` (operate) are refused on every surface but the desktop; `schedules:changed` is a desktop-only push through
  `DesktopHooks.schedulesChanged`. Unit-tested (dispatcher, registry, params, jsonRoundTrip).

## Main (`src/main/schedules/`)

- `store.ts`: `<data>/schedules.json` (version 1, durable atomic writes, `.bak`); an unreadable file is never
  overwritten and the store goes read-only. Unit-tested.
- `validate.ts`: field rules shared by save, proposal apply and the tool; `effectiveScheduleMode` (the schedule's
  mode, else the target project's) may never be bypassPermissions; `scheduledRunCap` = min(schedule budget, project
  cap).
- `service.ts` `ScheduleService`: save / remove / setEnabled / runNow / history / `applyProposal` (all or nothing,
  refuses an update whose schedule changed since it was proposed) and `fire`, the only place a schedule starts a run.
  It starts runs through `RunManager.start` (team) or `QuickRunService.start` (ask) with the desktop start choices, so
  the catalog, price, permission-mode and folder checks of a user's start apply. A capped scheduled run always gets
  `conversationBudgetUsd`, so main enforces the cap. Nothing is auto-approved: a run that needs approval waits with its
  card. A start is raced against a 5 minute timeout.
- `scheduler.ts`: one timer with an injected clock; started only by the desktop shell (`index.ts`), never on the CLI's
  in-process host. Rules: the slot is marked before the start (no refire after a crash); lateness over 5 minutes is a
  missed slot with at most one catch-up inside 24 h; one run per schedule at a time (a run whose reports still work
  counts as live; a per-schedule starting count closes the double-start race); at most two scheduled runs at once;
  three consecutive failures disable the schedule; the list and the global pause are re-read before every start.
  `ORGAI_SCHEDULE_TEST_TICK_MS` shortens the wake interval only with `ORGAI_MOCK=1`.
- Conversation: harness tools `list_schedules` and `propose_schedule` (`harnessTools.ts`) on the roots of Chat, team
  and single runs on the desktop host; refused on a scheduled run. Main writes the card title, each item's summary
  (target, timing, resolved mode, model, cap or "No spend cap") and next runs. An agent cannot set bypass, a mode
  wider than the target project's, or (from a work run) another project or an ask target. The two tool definitions add
  about 2,400 characters to every work and single run request.
- Mock markers: `[mock:schedule]` (daily 00:00 "Nightly PR monitor") and `[mock:schedule-once]` (once, 10 s ahead);
  replies start APPROVED / REVISE / DECLINED / REFUSED.

## Renderer

- App view `'schedules'` (`views/SchedulesView.tsx`, `components/schedules/*`, view-model `src/shared/view/schedules.ts`),
  sidebar entry, View > Schedules (`show-schedules`), atlas surface `schedules`. Editor presets map to
  `ScheduleTiming`; a Chat target offers only the Chat permission modes; widening a mode asks with schedule wording.
  History is a disclosure under each row. Proposal body `components/proposals/SchedulesProposalBody.tsx`. Run meta
  shows "Scheduled: <name>". Test ids: `docs/design/schedules.md` 5.1.

## Checked

- Unit tests beside the modules (store, service, `service.review.test.ts` for the review findings, scheduler with a
  fake clock, boot, harness tools, mock markers, view-models).
- `e2e/schedules.mjs` (token-free, in `e2e:free`, mapped in `scripts/e2e-select.mjs`): form create and validation, run
  now, history, pause / resume, edit, delete, ask target, the chat card (approve, decline), a due-time fire, pause all,
  restart persistence.
- Reviewer: renderer approved; main first Block (an idle run with working reports counted as done, stale scheduler
  snapshot, start race, inherited bypass, misleading update card, catch-up freeze), fixed, recheck "Pass with Lows".

## Open and unverified

- The handover-grace sweep (`service.ts` `sweep()`, `HANDOVER_GRACE_MS`) was written after the last Reviewer recheck
  and has not been reviewed.
- The proposal card's "Spend cap" row shows the schedule's own budget, not min(budget, project cap); the main-written
  summary line is right.
- A `once` schedule that comes due while all schedules are paused is marked Done and never runs.
- Not driven: catch-up after sleep or a closed app, auto-pause, the two-run cap, update / remove / pause / resume
  proposals, OS notifications, the close prompt with pending schedules, both window sizes and themes in e2e, live
  providers, macOS.
