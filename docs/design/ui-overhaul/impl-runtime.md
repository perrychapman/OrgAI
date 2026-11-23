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
  - Asks "Use a stronger model for <role>?". Only "Use it" uses the stronger tier; anything else keeps it. The wait ends after 580 s
    with keep and the card is cancelled (all three adapters).
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
- **Report only.** L2 (fixed by the Adapter Engineer, see "Adapter fixes"): the stronger-model question stayed pending after the
  Claude 580 s wait, and Codex and the mock had no timeout. L9: a loose `branchNamePattern` can make a user's branch count as a report branch for delete.

## Adapter fixes (stronger-model wait, budget and spawn-cap gaps)

- **Stronger-model wait (L2).** `staffing.ts decideWithStrongerGate` owns one bounded wait for all three adapters
  (`STRONGER_MODEL_ASK_TIMEOUT_MS`, 580 s, below the 600 s Claude PreToolUse hook timeout). On timeout the role's own tier is
  kept, a run line says "no answer, kept the role's model", and the card is cancelled: `RuntimeContext.requestQuestion` takes an
  optional `{ signal }`; aborting it makes RunManager cancel the card like a run end does (`question.resolved` with
  `cancelled: true`, a `cancelled` tombstone), so it leaves the decision tray and Inbox and a late "Use it" is refused as not
  pending. Checked with fake timers in `claudeProviderRetry.test.ts`, `codexStaffing.test.ts`, `mockProviderRetry.test.ts` and
  through RunManager in `runManagerMockHold.test.ts`. The Codex tool-call timeout for `spawn_report` is not known (no
  timeout is set in `codex.ts`); unverified live.
- **A project budget cap alone now holds a run on every adapter (fixed in main).** `codex.ts` never reads `maxBudgetUsd` or
  `ctx.budgetUsd`; Claude gets its stop from the SDK (`error_max_budget_usd` -> `budgetReached`). `RunManager.checkSpend`
  enforced only `RunSummary.runBudgetUsd` (a per-run cap the user chose or a carried one), so on Codex a project cap alone
  never stopped the run. Now `ownCap` is `runBudgetUsd`, else `projectBudgetUsd(a.ctx.project)` (the project as the run sees it,
  overrides applied), for a non-exec run without a conversation budget (those keep `checkExecBudget`). A reached cap holds the
  run on `budget` (scope `run`) and ends it as `endedBy: 'budget'`, with no exec outcome and no `run.finalized`, exactly as the
  per-run cap and `[mock:budget-stop]` do. For users: a project `maxBudgetUsd` that only produced a warning on Codex runs (and
  on any adapter that does not enforce a budget) now stops them; it can be raised from the hold card.
  - *Unknown prices.* Spend that has no known price (all of it `costSource: 'unknown'`, or `costPartial`) under a cap (per-run or
    project) stops the run too, with a log line saying the limit cannot be enforced and the known part of the spend on the hold,
    instead of counting as $0. This is what start already does for a chosen unpriced model and what an exec run does
    (`allowUnpricedBudget` is honoured).
  - *Claude, two stops.* The SDK compares its own running total, so for the project-cap fallback main compared only the run total
    the adapter reported and never its own estimate from tokens. Whichever stop comes first sets `spendStopped`; the other finds
    it set (`checkSpend` returns, `budgetReached` returns): one hold, one `endedBy`, one log line. A per-run cap keeps comparing
    the best known cost, as before. **Superseded in part by "Third pass" M1 below:** the SDK-first rule now has three
    exceptions (no total yet, a proxy, a 1.5x backstop).
  - Checked by `runManager.projectCap.test.ts` (recording Codex adapter, all four run kinds: reached, under, no cap, per-run
    lower and higher than project, unknown and partly unknown price, held once; recording Claude adapter: main first then SDK
    error, SDK first then cost, not before the SDK total, proxy total; a conversation budget still holds once through
    `checkExecBudget`). Live Codex and Claude behaviour is unverified. Money-affecting: Reviewer.
- **Spawn caps hold across native and bridged agents (fixed in `spawnCaps.ts`, `bridge.ts`, `runManager.ts`, the adapters).**
  Two leaks existed: the snapshot of "what is left" handed to a bridged child was not reduced by agents spawned later, and a
  native spawn counted only the adapter's own agents. Now `RuntimeContext.spawnCapAgents()` (optional, live, present only on a
  run with bridged roles and on its children) returns the agents of the run the session's adapter does not hold: for the run's
  own session every bridged child's agents (root and descendants, ended included); for a child the run's native agents (ids
  prefixed `run:`), the other children's agents and its own root. `spawnCapRefusal` takes them as `extraAgents` (an id in both
  counts once, the root never counts) and Claude, Codex (`CodexAgentNetwork` option) and the mock pass the accessor through. A
  child now gets the whole `maxAgentsPerRun` (read live from the run, so a lowered cap applies) and its roles keep their own
  `maxConcurrent`; it is no longer handed a start-time snapshot, and only a run with no total left hides its spawn roles. Each
  side's check-and-register is synchronous (`bridge.spawn` registers the child before it yields), so racing delegations cannot
  both pass. (A native spawn approved but not yet started was invisible to a bridged delegation checked in that window; fixed
  in "Third pass" L1 below.) Checked by
  `bridgeSpawnCaps.test.ts` (bridged then native, native then bridged, racing children, role cap across both, lowered cap,
  accessor shapes), `spawnCaps.test.ts`, `runManagerBridge.test.ts` (wiring) and the Claude, Codex and mock `SpawnCaps` tests.
  Live providers unverified.
- **Mock markers.** `[mock:budget-stop]` and `[mock:provider-error]` reach `run.hold` through RunManager exactly as a real
  adapter's end does (`runManagerMockHold.test.ts`): budget-stop holds on `budget` only when the run has a cap (per-run or
  project), as on Claude; provider-error holds on `provider`. `[mock:stronger-model]` (work run, default script, first session)
  fails a fast-tier report so the next spawn escalates; with `askBeforeStrongerModel` on, the "Use a stronger model for
  <role>?" card appears.

## Third pass (cap and merge-gate review, approved with fixes)

Reviewer result: no Critical or High, four Medium, some Low. Every fix only enforces more.

- **M1. A Claude run could evade the project cap when the adapter under-reported.** `checkSpend` compared only
  `usage.providerCostUsd` (0 when missing) for a Claude run under the project's cap, so a run priced from Settings (`costSource`
  `computed`) whose SDK total was 0 or low was invisible. Now (`runManager.ts`, `SDK_BACKSTOP_RATIO` = 1.5):
  - First-party Anthropic Claude run under the project cap, SDK total known (> 0): main still compares the SDK's total (plus
    bridged agents), so it does not stop the run before the SDK would.
  - SDK total missing or 0 while tokens were used: the best known cost (main's estimate) decides. The first turn of a run can
    therefore be stopped on the estimate before the SDK's first total arrives.
  - Backstop: the SDK total is under the cap but main's estimate is at 1.5 times the cap or more: held. The old test case
    "computed 15, SDK 3, cap 5" is 3 times the cap, so it is now held (once, one log line, the SDK's later error finds
    `spendStopped` set); the case is restated at 6 against a cap of 5 (1.2x: not held while the SDK is under the cap), 7.2
    (1.44x: not held) and 15 or 20 against 5 (held). 1.5 is a judgement: far enough above the SDK's own rounding and cache pricing differences
    that a hit means the total or the table is wrong, near enough that a run cannot spend several times its cap first.
  - Connection not first-party Anthropic (a proxy; the adapter's total is its own pricing) and a per-run cap the user chose:
    the best known cost, always.
  - The SDK-first ordering and the one-hold rule stay. Tests: `runManager.projectCap.test.ts` (moderate estimate not held; 3x
    held once; just under 1.5x not held; no total yet; total 0; Settings price; proxy; no tokens; total reported holds).
- **M2. Bridged children's spend escaped the Claude project cap.** `bridge.ts` drops a child's `run.cost` and the parent
  session's total covers only its own session, while each child copied `maxBudgetUsd` whole (worst case about (1 + children) x cap).
  Now:
  - `RunManager.spendOf`: the compared cost is `max(run cost, max(parent's total, native agents' priced sum) + bridged agents'
    known cost)`, for every parent adapter; a bridged agent with no known price under a cap follows the unknown-price rule
    (stop, known part on the hold).
  - A child's `ctx.project.maxBudgetUsd` is a live getter: the run's limit (per-run cap, else the project's; an exec or
    conversation budget less its chain) less what the rest of the run has spent, read at every query it builds or restarts
    (`BridgedSessionsDeps.budget`). With nothing left it is `BRIDGE_NO_BUDGET_LEFT_USD` (1e-6; 0 would mean "no cap"), and
    `bridge.spawn` refuses to start a child at all ("This run has used all of its spending limit..."). Main still enforces the
    total on every agent update and ends the run (which stops the children).
  - Daily / monthly caps: `spendRuns` reads `usage.costUsd`, which sums every agent (children included) for a multi-connection
    run, so those were already counted (confirmed, `runManager.capBridged.test.ts`). Not counted: a bridged child on the run's own
    connection (a proxy serving two families), because the adapter's total then stood for the whole run. Fixed: `computeRunUsage`
    ignores the adapter's total when any agent of the run is bridged (`RunUsageInputs.bridgedAgentIds`).
  - Tests: `runManager.capBridged.test.ts` (child spends past the cap while the SDK total is low: held, child stopped; under the
    cap: runs; child cap = remainder, live; per-run cap; no cap; unknown child price; usage with a same-connection child),
    `bridgeSpawnCaps.test.ts` (spawn refused with nothing left, live getter incl. the child's own spend added back).
- **M3. The socket and CLI could raise or remove `Project.maxBudgetUsd`.** `desktopOnlyProjectChanges` now refuses, from any
  non-desktop surface, a `maxBudgetUsd` above the stored cap or absent / 0 / junk / null where a cap is stored (setting one where
  there was none, keeping and lowering stay allowed), and an explicit stored `maxSubagentDepth` / `maxConcurrentSubagents`
  raised, or cleared when the automatic value (org chart depth, the default concurrency) is higher. Setting an explicit depth or
  concurrency where the project was automatic stays allowed. **CLI behaviour change:** `orgai projects set --max-budget none`
  and `--max-budget <more than the stored cap>` (and the TUI settings row) now fail with "These project settings can be changed
  in the OrgAI window only: maxBudgetUsd. Limits can be lowered from here, not raised or removed." (exit 1, nothing stored);
  `--max-budget <usd>` on a project with no budget, and lowering one, work as before; `--max-depth auto` / `--max-concurrent
  auto` fail only when the automatic value would be higher than the stored explicit one. `orgai org` and every other save that
  round-trips the stored values are untouched. The desktop window is unchanged. Team files can still set `maxBudgetUsd`
  through their own gate (`teamFiles/gate.ts`, user review). Tests: `projectSaveGuard.test.ts`, `cli/commands/projects.int.test.ts`,
  `e2e/cli-projects.mjs` (both changed: they cleared a budget with `none`, which the desktop alone may now do).
- **M4. The reviewed-commit merge pinned only the branch tip.** The test command runs repository code as the user and can reach
  the checkout the merge lands in through the shared git folder. Now `rootPin.ts` reads the target checkout before and after the
  command (`integration.ts runTests`) and again, under the repository lock right before the merge (`GateDecision.verify`, run
  before OrgAI's own `mainBranch` switch); any difference refuses the merge with a plain reason and keeps the copy. And the
  merge, `merge --abort`, the conflict listing, worktree removal and move, `branch -d`, and the `mainBranch` checkout run through
  `gitGuarded` (the hostile-config overrides: hooks off through `core.hooksPath`, no fsmonitor, pager, ssh or askpass; the
  read-only environment on a plain `.git` checkout). Exactly:
  - **Pinned:** HEAD's commit and the branch it is on; the index entry by entry (`ls-files -s`); tracked working-tree changes
    (`diff-files --raw`); `.git/config`, `config.worktree`, `info/attributes`; the `hooks` folder (names and content digests).
  - **Neutralised, not pinned:** a hook (the override wins over a hook folder and over `core.hooksPath` in the config), fsmonitor,
    pager, ssh.
  - **Not pinned:** untracked files; a tracked file already modified before the tests and modified again; other refs and other
    worktrees; the object database; the user's system and global config and the hooks folder they name; a process the test
    command leaves running after it ended (the second reading and the one under the lock narrow, not close, that window); the
    working tree of a repository that defines its own filter drivers (`git diff-files` would run the clean program, so it is
    reported "not pinned", as the git summary skips status there).
  - **Not neutralised:** a merge driver (`merge.<name>.driver`), clean filter or textconv the config already named before the
    tests (unchanged config is the user's own, and a change to it is refused); a program the user's own global config names.
  - A hostile test that edits the checkout and puts it back exactly is not seen; one that edits it, then fails, is still reported.
  - Side effect: a repository's own `post-merge`, `pre-merge-commit`, `commit-msg` and `post-checkout` hooks no longer run on
    OrgAI's merge. `commitLeftovers` (the report's own commit in its copy) still runs the repository's hooks as before.
  - `worktrees.test.ts` "commits and merges with OrgAI identity when git has none" now also empties HOME, USERPROFILE and
    XDG_CONFIG_HOME: the guarded runner drops inherited `GIT_*` variables, so `GIT_CONFIG_GLOBAL` no longer hides a machine's
    global identity (the test passes on a machine with none either way). Tests: `integration.rootPin.test.ts` (real git and the real
    gate: a command that commits on the root, stages, edits a tracked file, installs a hook, sets `core.hooksPath`, defines a
    merge driver: each refused and no hook runs; hooks off on the merge itself; the verify under the lock), `integration.test.ts`
    (the pin mocked out), `worktrees.test.ts`.
- **L1.** A native spawn an adapter approved but has not started (Claude's `spawnModes`) now counts in a bridged delegation's cap
  check: `RuntimeContext.spawnCapPending(read)`, registered by the adapter once (Claude only; Codex and the mock register
  their agent at once), kept by the bridge for the run's session and each child, counted by the bridge's own check and shown to
  the other sessions as `pending:` entries of `spawnCapAgents`. Briefly two entries can exist for one spawn (approved, then
  started): it counts more, never less. `bridgeSpawnCaps.test.ts`.
- **L2.** A bridged child's `Role.maxConcurrent` is a getter on its role copies reading the run's live chart (a removed role keeps
  its start value); `maxAgentsPerRun` already was one. No adapter spreads `ctx.project` into a kept copy (the three call-time
  `effectiveSubagentLimits({ ...project })` reads only; a test scans the adapters' sources), and a test lowers both mid-run.
- **L (switchModel).** `runs:switchModel` also refuses an unpriced model under the project's budget or a per-run cap, live and
  saved, nothing stored: "This project has a per-run spending limit, but <model> has no known price, so the limit cannot be
  enforced. Set a model price in Settings or remove the limit." (the daily / monthly sentence is unchanged; an exec run's
  `allowUnpricedBudget` is honoured). `runManager.capPrice.test.ts`.

### Behaviour changes for existing users

- A run under any cap stops when part of its cost has no known price or is unknown (a per-run cap the user chose, the project's
  budget, Claude runs included). Before, that spend counted as $0.
- A project budget now holds Codex runs (and any adapter whose SDK enforces none): a Codex run that only warned before stops, and
  can be continued from the hold card with more budget.
- A first-party Claude run under the project budget also stops on main's estimate when the SDK has reported no total yet (or 0), or
  when the estimate reaches 1.5 times the cap. Bridged reports count against the cap on every adapter; a child's own cap is what
  is left of the run's.
- `runs:switchModel` refuses a model with no known price under any cap (daily, monthly, project budget, per-run).
- An unanswered stronger-model question keeps the role's own tier after 580 s, and the card goes away.
- The test command's environment is an allowlist: scripts that need other variables (cloud credentials, tokens) fail. The run log
  line "<agent>: test output (end):" after "Not merged: the tests failed" carries the tail of the output; a missing variable usually
  shows there as an unset or authorization error.
- A merge is refused, and the copy kept, when the test command changed HEAD, the index, tracked files, `.git/config`, `info/attributes`
  or the hooks folder of the checkout the merge lands in. OrgAI's merge runs with git hooks off.
- The git summary shows no working-tree status on a repository that defines its own filter drivers.
- Non-desktop saves (socket, `orgai`, the TUI) cannot raise or remove `maxBudgetUsd` (nor raise an explicit subagent depth or
  concurrency): `orgai projects set --max-budget none` or a higher figure now fails with a window-only message; setting a budget
  where there was none and lowering one work as before.

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
