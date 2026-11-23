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
  unstarted spawns count. (First draft: `bridge.ts delegate_agent` did not apply them. Corrected: it does, see "Second
  batch" and the code, `spawnCapRefusal` / `spawnAllowanceAfter` in `bridge.ts`.)
- **Who may set spend and command fields.**
  - `projects:save` from the socket or the in-process CLI is refused when it would raise or remove a daily or monthly
    cap, change `onSpendLimit`, `requireTestsPass` or `testCommand`, or turn on `schedulesNearPlanLimit`
    (`host/projectSaveGuard.ts`).
  - Team files and settings proposals never carry these fields (tests: `teamFiles/overhaulBoundary.test.ts`,
    `setup/settingsProposalBoundary.test.ts`).
- **Test gate** (`runtime/testGate.ts`).
  - The user's command runs in the finished copy before merge:
    - cmd.exe or /bin/sh;
    - environment is an allowlist (PATH, home, temp, locale, CI and what Node needs);
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

## Second batch

- **Bridge spawn caps.** `bridge.ts delegate_agent` applies `spawnCapRefusal`, counting the whole run's agents plus
  pending bridged spawns.
  - Gap: inside a bridged child session, the child's adapter counts only its own agents.
  - Gap: a native Claude spawn does not see bridged children.
- **`priorAllows`** (`runtime/allowCounter.ts`).
  - Counts only "Allow once" answered on the desktop. The key is the allow rules from the card's own suggestions,
    falling back to `permissionRules.ts` keying.
  - Stored at `<data>/projects/<id>/allow-counts.json`: at most 500 keys, counts capped at 9999.
  - Absent when unknown.
- **`askBeforeStrongerModel`** (`staffing.ts` gate, used by the Claude, Codex and mock spawn paths).
  - Asks "Use a stronger model for <role>?". Only "Use it" uses the stronger tier; anything else keeps it. The Claude
    wait ends after 580 s with keep.
  - Because `resolveStaffing` clamps to the role's tier, today it fires only on a retry escalation.
- **`runActions.retryAgent`.** A user instruction to the orchestrator, sent through `send()`. Staffing still clamps the
  tier.
- **Provider retries.**
  - Claude maps the SDK `api_retry` message. Codex maps `error` with `willRetry` (no delay known). The mock has
    `[mock:provider-retry]`.
  - RunManager rebuilds the event, keeps `RunSummary.providerRetry` and sets `hold.provider.tries`.
- **Skills.**
  - `duplicate` names the copy `<name>-copy`, because skill names allow only lowercase letters, digits and hyphens. It
    copies no grants.
  - `export` writes a new folder under the picked folder, never overwrites, and refuses symlinks.
- **Branches.**
  - `finishedCopiesSize` is an lstat walk with a bounded entry count.
  - `deleteBranch` goes through the guarded git helpers. It refuses the current, default and main branch, branches in
    use by a live run, non-report branches, unfinished git state, and a branch with no copy that has unmerged commits.
  - `branchNamePattern` is validated and offered through `branchNameFor`. No live run applies it yet: Claude's SDK
    names its branches. Corrected: `branchNameFor` (`runtime/branchNames.ts`) has no caller outside its tests, and
    `codexAgents.ts` carries no note about it (the first draft said it did). Worktree recognition still keys on
    `worktree-agent-`.

## Reviewer fixes (first pass blocked on H1)

- **H1.** `settings:set` from the socket or the in-process CLI cannot change `openAtLogin`, `closeBehavior`,
  `keepAwakeDuringRuns` or `spendWarnPercent`.
- **M1.** Daily and monthly caps count every run that overlaps the period.
- **M2.** A start under a daily or monthly cap is refused when a role model has no known price, and a live run warns
  once when its cost turns unknown.
- **M3.**
  - The test gate scrubs token, secret and password variables and cloud credentials.
  - With merge review on, it runs after the user approves.
  - `requireTestsPass` with an empty command refuses the merge.
- **M4.** `gitInfo` skips `git status` when the repository defines its own filter drivers.
- **M5.** Non-desktop saves cannot widen the agent caps, `knowledgeWrite`, retention, `mainBranch`,
  `branchNamePattern` or `askBeforeStrongerModel`.
- **M6.** The knowledge write gate fails closed for an unresolved caller.
- **M7.** Bridge caps (see Second batch).
- **M8.** `spendWarnPercent` can switch between a number and null.
- **L1.** One `destroyed` listener per window.
- **Open, Low:**
  - **L2.** `maxAgentsPerRun` counts per session, so a continuation starts a fresh count. The UI should say "per run
    session".
  - **L3.** A live org change may re-add left-out roles. Unverified.
  - **L4.** Agent names and blocked reasons are data and must render as text.
  - **L5.** The retention sweep takes no activity lease.
  - **L6.** A `mainBranch` checkout switch is not named in the merge message.
  - **L7.** An agent that runs `git merge` itself is not blocked by the gate.

## Reviewer fixes (second pass, approved with fixes)

- **M1.** `runs:switchModel` (any surface) refuses, `applied: false` with the start refusal's wording, a model with no known
  price on a project with a daily or monthly cap: a live switch, and a selection saved for the next continuation. Nothing is
  saved. A mock run is exempt as at start.
- **M2.** The merge gate records the branch's commit before the review card and the test command (`worktrees.ts branchTip`,
  passed to the gate), merges that commit, not the branch name, and refuses when the branch moved. With merge review on,
  `reviewGate` asks the user again (once) about the new tip when the tests committed to it, then refuses.
- **M3.** `gitInfo` skips `git status` when `extensions.worktreeConfig` is set, a `.git/config.worktree` exists, or any
  `filter.*` key sits in a scope other than the user's system and global config (`config --show-scope`).
- **M4.** A non-desktop save cannot remove a role that carries `maxConcurrent` or `knowledgeWrite: false`, re-add it under
  a new id, or add another role with the same slug or name that lacks the limit. `ProjectStore` does not stop role id
  changes (a role's id is whatever the saved copy says), so the guard does.
- **L1.** `allow-counts.json` is version 2: SHA-256 of each key. A version 1 file is hashed and rewritten on first read.
- **L3.** A bridged child gets what is left of `maxAgentsPerRun` and of each capped role (`spawnCaps.ts spawnAllowanceAfter`);
  with nothing left it cannot spawn.
- **L4.** `strongerModelCheck` treats an unknown role and parent tier as everyday, so a result above everyday asks.
- **L5.** `retryAgent` sends the agent's brief fenced and labelled as agent-written data (`fencedAgentBrief`).
- **L6.** The test command's environment is an allowlist; its output tail is scrubbed of obvious credentials and goes only
  to the run log and the maintenance result shown to the user, never to a model message.
- **L7.** A skill export folder never takes a Windows device name (`con`, `nul`, `com1`...).
- **L8.** `deleteBranch` asks its refusal questions again under the repository lock; branch names compare case-insensitively
  on Windows and macOS.
- **Report only.** L2: the stronger-model question stays pending after the Claude 580 s wait, and Codex and the mock have no
  timeout (adapter work). L9: a loose `branchNamePattern` can make a user's branch count as a report branch for delete.

## Not built, and why

- **Undo of an answered decision.** Agents act on an answer at once, so taking back an answered permission, question,
  proposal or merge is not real. Only a saved "Always allow" rule can be undone, through the existing `permissions.remove`.
  Session grants live inside the adapter session and have no revoke path.
- **Owner decision needed.** autoDownload, undo merge, locale and `schedulesNearPlanLimit` (see "Needs owner
  decision").
- **Not recorded today:** per-file +/- counts per run, plan step durations, and test or dependency health.

## Checked against the code (2026-11-23)

Read on dev: `OVERHAUL_IPC` has 22 channels, all in `DESKTOP_CHANNEL_MUTATES` (`overhaulIpc.test.ts`); `PERIOD_CAPS_LIVE`
is `true` in the renderer; `runs.retryRun` is real; the merge gate refuses an empty test command
(`integration.ts testGateMissingCommand`) and merges the recorded `branchTip`; `allowCounter.ts` hashes keys (version 2);
`bridge.ts` applies the spawn caps; `projectSaveGuard.ts` also guards `maxAgentsPerRun`, `Role.maxConcurrent`,
`knowledgeWrite`, `keepFailedBranchesDays`, `mainBranch`, `branchNamePattern` and `askBeforeStrongerModel` (narrowing only);
`RunManager` drops adapter-sent `run.hold` / `run.spendWarning` and rebuilds `provider.retry`. Not changed by this check:
every "Unverified" line below.

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
