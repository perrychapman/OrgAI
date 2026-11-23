# UI overhaul: runtime implementation notes

Status: 2026-11-22, Runtime Lead branch `worktree-agent-af7cf20682e2c8be9`. Main-process, shared-type and preload
support for what the overhaul boards draw that the app did not have. The orchestrator folds what matters into
`.orgai/ARCHITECTURE.md`, CLAUDE.md and `docs/agent-notes/`.

## Rules that hold throughout

- Every figure comes from recorded data (run history, schedule history, the price book, git). No basis means an explicit
  `null` or `basis: 'none'`, never 0 and never a guess. A run's cost is known only when `usage.costSource` is
  `provider` or `computed` (`runtime/estimate.ts knownRunCostUsd`).
- Every new channel (`OVERHAUL_IPC`, `src/shared/types.ts` section "UI overhaul runtime support") is desktop-only. It is
  registered by `src/main/overhaulIpc.ts` with an app-window check and listed in `DESKTOP_CHANNEL_MUTATES`
  (`src/main/overhaulIpc.test.ts` fails when one is missing). None is on the host dispatcher, so the socket, the CLI and
  agents (self-control, `message_run`) cannot reach them.
- Run actions are explicit user actions and go through RunManager's existing enforcement: budget caps, permission
  modes, required delegation and merge review. Nothing widens a cap or waives a gate silently.

## Contract (window.orgai)

- `runInsights.estimate({projectId, team?, excludeRoleIds?})` returns `RunEstimate`. It uses finished work runs of the
  project started the same way (team or single), within 90 days, with a known cost, newest 20, and needs at least 3.
  Ranges are the 25th/50th/75th percentile from 5 runs, else min/median/max. Minutes are wall-clock time.
- `runInsights.scheduleCosts()` returns `ScheduleCostReport`. The per-run figure is the median of the newest 7 history
  entries that have a cost. Runs per week are counted with the scheduler's own timing math
  (`shared/schedule.ts compileScheduleTiming`).
- `runInsights.scheduleHistory(scheduleId)` reads the history without clearing `unread`.
- `runInsights.projectSpend(projectId)` returns today's and this month's spend (local calendar), the caps, and a month
  projection once 3 days have passed.
- `runActions.hold / addBudget / retry / skipReview / messageAgent / stopAgent`.
  - `RunSummary.hold` carries the hold, and `run.hold` and `run.spendWarning` events carry changes.
  - RunManager drops these events if an adapter emits them.
- `gitInfo.summary / branches` give read-only git facts of a code project.
- `importSources.pickAgentFolder` feeds `AgentImportInput.sourcePath` and `fromProjectId`.
- `templatesExtra.duplicate`; `OrgTemplateInfo.builtIn` and `appliedCount`.
- `about.supportDetails / reportProblem / openLicences`.
- New optional fields:
  - AppSettings: `playSound`, `spendWarnPercent`, `openAtLogin`, `closeBehavior`, `keepAwakeDuringRuns`,
    `notifyNeedsMe`, `notifyRunFinished`, `notifyScheduleFindings`, `dateFormat`.
  - AppearanceSettings: `noMotion`, `glass`, `textSize`, `density`, `sidebarActivityDots`.
  - Project: `maxDailyUsd`, `maxMonthlyUsd`, `onSpendLimit`, `maxAgentsPerRun`, `schedulesNearPlanLimit`,
    `mainBranch`, `requireTestsPass`, `testCommand`, `keepFailedBranchesDays`.
  - Role: `maxConcurrent`, `knowledgeWrite`.
  - AgentInstance: `brief`.
  - RunSummary: `hold`, `excludedRoleIds`, `runBudgetUsd`.
  - StartRunInput: `excludeRoleIds`, `maxBudgetUsd`.
  - PermissionRequest: `requestedAt`, `priorAllows`.
  - MergeReview: `checks`.
  - McpTestResult `toolDetails[]`: `readOnly`, `destructive`.

## Enforcement and semantics

- **Holds** (`runtime/runHold.ts`).
  - Kinds:
    - `budget`: the run's own cap. On Claude this is the SDK `error_max_budget_usd` turn end, or main's check of
      `runBudgetUsd` and the conversation budget.
    - `spend-limit`: the project's daily or monthly cap.
    - `usage-limit`: a paused run.
    - `provider`: an error end. The reason is fixed OrgAI text, never the provider message.
    - `agent-failed` / `plan-blocked`: from a blocked plan.
  - `actions` is recomputed on every read.
  - Codex reads no budget, so a Codex run with only the project cap gets no `budget` hold.
- **Add budget.**
  - Only on an ended run held on `budget`.
  - The continuation's own cap is the added amount.
  - Refused above `project.maxBudgetUsd` ("Raise the project's limit in Settings") or above what is left of the
    daily or monthly cap.
  - A conversation chain's cap rises by the amount, still bounded by the project cap.
  - The predecessor's hold is cleared, and the run log says "You added $X to this run's budget."
- **Per-run cap and left-out roles** (`StartRunInput.maxBudgetUsd`, `excludeRoleIds`).
  - Desktop only: the dispatcher refuses both from any other surface.
  - The cap only narrows: `min(choice, project cap)`.
  - Left-out roles: refused for the root, unknown ids, single and setup runs. A role leaves with its subtree.
    Obligations that pointed at a left-out role become delegation preflight warnings, never silent waivers.
  - Continuations carry both.
- **Daily and monthly caps** (`runtime/spendGuard.ts`).
  - Checked before every start of a stored project, all kinds, schedules, continuations and auto-resume included.
  - Checked live on each `agent.upsert` and `run.cost`.
  - At a cap:
    - `pause` (the default): status `paused`, `pausedUntil` = the period reset, `autoResume: false`. It never
      resumes on its own.
    - `stop`: ends like a budget stop (`endedBy: 'budget'`, reads Finished).
    - Exec runs always stop.
- **Spend warning:** once per run and scope (run, conversation, day, month) at `spendWarnPercent` (50..99; off by
  default), as an event and a run log line.
- **Skip review:** a fixed sentence plus the user's note, delivered through `send()` and logged. The ledger, the review
  policy and merge review are unchanged.
- **Message one agent:** delivered through `send()` to the orchestrator, addressed to the agent.
- **Stop one agent:** Claude uses `Query.stopTask`, Codex uses `turn/interrupt` of the report's thread, and the mock
  always stops. Never the root. Returns `stopped: false` where unsupported.
- **Spawn caps** (`runtime/spawnCaps.ts`): `Role.maxConcurrent` and `Project.maxAgentsPerRun`, read live. Approved but
  unstarted spawns count. Gap: `bridge.ts delegate_agent` does not apply them.
- **Who may set spend and command fields.**
  - `projects:save` from the socket or the in-process CLI is refused when it would raise or remove a daily or monthly
    cap, change `onSpendLimit`, `requireTestsPass` or `testCommand`, or turn on `schedulesNearPlanLimit`
    (`host/projectSaveGuard.ts`).
  - Team files and settings proposals never carry these fields (tests: `teamFiles/overhaulBoundary.test.ts`,
    `setup/settingsProposalBoundary.test.ts`).
- **Test gate** (`runtime/testGate.ts`).
  - The user's command runs in the finished copy before merge:
    - cmd.exe or /bin/sh;
    - provider and OrgAI variables scrubbed;
    - stdin closed;
    - 10 minutes, after which the process tree is killed;
    - the last 4000 characters kept.
  - A failure refuses the merge, with status `conflict` and `refused: 'tests'`.
  - Merge cards get `checks.tests`. `checks.review` comes from delegation ledger receipts.
- **mainBranch:** merges into the main checkout land on it when it exists. The checkout is switched only when tracked
  files are clean; otherwise nothing is merged. The branch is never created.
- **keepFailedBranchesDays:** a desktop-host boot sweep. It removes only old `conflict`, `removed` or errored copies of
  stored runs, never while a run of the project is live, never one with uncommitted work.
- **gitInfo.**
  - `execFile`, no shell, 5 s timeout, 4 MB cap, the read-only env of `worktrees.ts`.
  - Every call carries the hostile-config overrides (fsmonitor, hooks, pager, ssh off).
  - Refs are always passed as `refs/heads/<name>`.
  - A folder whose `.git` is a file gives null.
- **Knowledge write:** a role with `knowledgeWrite: false` on an engagement is refused `upsert_node`, `link` and
  `retire` at call time. The tool is still listed.
- **App behaviours** (`appBehaviour.ts`).
  - Login item: only on a packaged win32 or darwin build.
  - Keep awake: one `prevent-app-suspension` blocker while a run is working.
  - Keep running: closing the last window keeps the app in the background instead of asking.
  - Per-event notification switches sit under the master switch. `notifyScheduleFindings` gates Schedules' notices,
    which today are failures and pauses.

## Needs owner decision (not built)

- **Update autoDownload.** It would change the updater's consent rule in `docs/agent-notes/updates.md`, which says the
  app never downloads on its own.
- **Undo merge.** It rewrites or reverts history on the user's branch.
- **Locale.** The app has no i18n layer.
- **`schedulesNearPlanLimit`.** Scheduled runs are not skipped near the plan limit today, so the switch has no
  behaviour to control. Settings leaves these four controls out.

## Second batch (in progress on this branch)

- The `bridge.ts delegate_agent` spawn caps.
- The `priorAllows` counter.
- `askBeforeStrongerModel`.
- `runActions.retryAgent`.
- `skillsExtra.duplicate` and `skillsExtra.export`.
- `branchNamePattern`.
- `maintenanceExtra.finishedCopiesSize` and `maintenanceExtra.deleteBranch`.
- Provider retry counters: the `provider.retry` event, `RunSummary.providerRetry` and `RunHold.provider.tries`.

## Not built, and why

- **Undo of an answered decision.** Agents act on an answer at once, so taking back an answered permission, question,
  proposal or merge is not real. Only a saved "Always allow" rule can be undone, through the existing `permissions.remove`.
  Session grants live inside the adapter session and have no revoke path.
- **`PermissionRequest.priorAllows`.** Main keeps no allow counter, so the field stays absent (unknown).
- **`schedulesNearPlanLimit`.** No near-limit skip of scheduled runs exists: they start and pause at the limit. The
  field is stored and has no consumer.
- **Not built at all:** locale, update autoDownload (the consent model says the app never downloads on its own),
  branchNamePattern (the SDK names worktree branches), askBeforeStrongerModel, the byte size of finished copies, skill
  duplicate and export, provider retry counters, retry with a stronger model, and undo merge or delete branch
  (destructive git writes).
- **Not recorded today:** per-file +/- counts per run, plan step durations, and test or dependency health.

## Verification

See the Runtime Lead report for the commands and results.
- Unit tests sit beside every module listed above and use fake adapters and real temporary git repositories; none
  spends tokens.
- **Unverified:**
  - live Claude and Codex behaviour (the budget stop, `stopTask` on a foreground report, `turn/interrupt`);
  - the packaged login item and power blocker;
  - POSIX shell and process-group kill for the test gate;
  - macOS;
  - the real desktop IPC path for the import fields;
  - the renderer wiring of all of the above.
