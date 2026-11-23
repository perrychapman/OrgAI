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
- **M4. The reviewed-commit merge pinned only the branch tip.** (Refined by "Third pass, fix round" R2 and S2 below: OrgAI's own
  merges while the tests run are not drift, untracked `.gitattributes` are pinned, and the merge ignores global config and
  attributes.) The test command runs repository code as the user and can reach
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

### Third pass, fix round (recheck approved with fixes: two regressions, security Mediums, Lows)

- **R1. A first-party Claude run under a project cap was stopped in its first turn on "unknown price".** The unknown-price stop
  (`runManager.ts checkSpend`) fired before the SDK's first total arrived, so any model or subagent missing from main's price
  table ended an ordinary run on its first agent update. Now, while the SDK-first rule applies (adapter `claude`, first-party
  Anthropic connection, a project cap and no per-run cap; a run with no recorded connection resolves through
  `projectConnection`, which defaults to `anthropic`), main's own unknown-price stop is not applied to the run's own session:
  the SDK's budget error stays the stop, and so does the 1.5 x backstop (and the plain comparison when no SDK total exists yet)
  on main's estimate of the priced part. A bridged agent with no known price still stops the run (the SDK never sees it). A
  proxy connection, Codex and a per-run cap the user chose keep the unknown-price stop. Tests: `runManager.projectCap.test.ts`
  ("an unpriced model or subagent in main's table does not stop a first-party run": no SDK total yet, an all-unknown first agent,
  an SDK total under the cap then reaching it (one hold), the priced backstop, a legacy run without a connection, a per-run cap;
  and the proxy that is still stopped).
- **R2. The test gate refused merges nothing malicious caused.** Several reports finishing together, the user's own commit while
  the tests ran, another run's main-branch switch all moved the pinned checkout. Now (`rootPin.ts`, `orgaiMoves.ts`,
  `worktrees.ts recordingMoves`, `integration.ts runTests`):
  - Every OrgAI move of a checkout's HEAD (a merge, the switch to `mainBranch`) is recorded under the repository lock with the
    HEAD and branch it started from and the ones it produced, and advances a per-checkout generation (in memory, this process:
    another OrgAI process such as the `orgai` CLI merging into the same checkout reads as a change by someone else). The pin
    carries the generation it was read at and is read, before and after the command, under the same lock.
  - HEAD moved only through an unbroken chain of recorded moves and the staged and unstaged changes against HEAD (`changes`) are
    as before: the pin is read again and the merge goes on, on top of the other report's merge (the reviewed commit is the one
    that lands; conflicts are handled as always). A commit by someone else between two OrgAI merges breaks the chain.
  - `.git/config`, `config.worktree`, `info/attributes`, the hooks folder and, new, the untracked `.gitattributes` of the root and
    of the folders the merge changes: always a refusal, whoever did it.
  - HEAD, the index or tracked files moved by something else: the user's own commit or edit in the project folder while the
    tests ran, or the test command itself, which git cannot tell apart. With a review card in the merge (`reviewMerges`) the user
    is asked once more, with the plain reason ("The project folder changed while the tests ran", with the new commits) in the
    card's summary text and a log line; approving re-pins and the merge goes on, declining keeps the copy (held or discarded as
    chosen). Without a review card nobody can be asked, so the merge is refused as before, with a sentence saying OrgAI cannot
    tell its changes from yours. Under the repository lock right before the merge a further change is refused, not asked.
  - The re-ask is not built into the card's own fields: the reason rides on the existing `stat` text; a dedicated renderer line is
    open.
  - Tests (real git, real gate): `integration.rootPinMoves.test.ts` (two reports finishing together both merge, with and without a
    card, the second one not asked again; a user commit between two OrgAI merges is not explained; an edit made as well is not
    hidden; a user commit during the tests asks again with the reason and merges, can be declined, an edit asks too; without a card
    the same is refused; config change refused even with a card; a command that commits on the root still refused; an untracked
    `.gitattributes` planted by the command refused), `orgaiMoves.test.ts` (the chain rules), `integration.rootPin.test.ts` (the
    earlier cases, unchanged).
- **S1. Caps could still be shed from other surfaces.**
  - (a) Approving a settings card that raises or removes a guarded limit (`maxBudgetUsd`, `maxSubagentDepth`,
    `maxConcurrentSubagents`; `maxBudgetUsd: null` removes the cap) from any surface but the window is refused. `setup:decide` and
    `runs:decide` are not surface-gated by scope, so the card's decision now carries `decidedBy` into the card's resolve
    (`pendingCards.ts`), RunManager passes `nonDesktop` to `SetupService.applyProposal` for a decision from `cli`, `tui` or
    `policy`, and the apply runs the same `desktopOnlyProjectChanges` rule a project save follows; the card comes back as a
    revise with the window-only sentence and nothing is saved. Lowering a limit or setting one where there was none still
    applies. An internal caller with no `decidedBy` is trusted as before. The false comment in `projectSaveGuard.ts` is corrected.
  - (b) `projects:remove` from a non-desktop surface is refused for a project that carries any guarded field
    (`guardedFieldsOf`: budget, daily/monthly, agent caps, explicit subagent limits below the automatic ones, role caps, role
    knowledge restrictions, the test gate, the spend-limit action, the main branch, the branch pattern, the stronger-model
    question): removing it and creating it at the same path would start it with none. A project with none removes as before.
  - (c) `templates:apply` and `projects:applyImport` from a non-desktop surface run the resulting project through the same rule
    before saving (`widenGuard`): a replace that drops a role's cap or restriction is refused; a merge keeps every role, so it
    passes. `projects:remapModels` only rewrites models (`remapProject` spreads each role), so it needs no guard; a test says so.
  - Tests: `setup/settingsProposalBoundary.test.ts`, `runtime/runManagerSelfKnowledge.test.ts` (`decidedBy` to `nonDesktop`),
    `host/projectSaveGuard.test.ts` (`guardedFieldsOf`, remove, template and import wiring), `setup/templates.test.ts`,
    `setup/import/importer.test.ts`, `connections/remap.test.ts`.
- **S2. The merge could still be altered through configuration the pin does not cover.** (The carried set below is replaced by
  the smaller, validated, earlier-read one of "Security fix round" H1.) `mergeInto` (`worktrees.ts`):
  - runs with the user's system and global git config and attributes ignored (`GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL`,
    `GIT_ATTR_NOSYSTEM=1`, `-c core.attributesFile`, all the null file: `NUL` on Windows, `/dev/null` elsewhere, because git cannot
    open `\\.\nul` as a config), and with `-c merge.default=text`; a small allowlist of values is read from the user's config as git
    reads it for a commit and passed as `-c` (`mergeCarriedConfigArgs`): `user.name` and `user.email` (OrgAI's identity when git has
    none), the settings that decide how files on disk compare with the index (`core.autocrlf`, `eol`, `safecrlf`, `filemode`,
    `symlinks`, `ignorecase`, `longpaths`, `fscache`, `precomposeunicode`, `protectntfs`, `protecthfs`, `checkstat`, `trustctime`) and
    `safe.directory`. Without the line-ending settings a stock Git for Windows (system `core.autocrlf=true`) saw every CRLF file as
    edited and refused to merge (found by `teamFiles/service.sync.test.ts`; `integration.rootPinMoves.test.ts` "line-ending");
  - refuses the merge, before running it, when an attribute selects a merge other than git's own text merge, `binary` or none for a
    file it changes (`mergeAttributeRefusal`: `git check-attr merge` on the root's working tree, `info/attributes` included, and on
    a scratch index holding the commit to merge, so the branch's own `.gitattributes` is read): `merge=union` and any driver name
    are named in the message and the copy is kept; a failed read refuses too;
  - the guarded runner drops every inherited `GIT_*` variable and sets `GIT_NO_REPLACE_OBJECTS=1` for a linked worktree as well as for
    a plain checkout (`guardedGitEnv`), so a replace ref cannot make a commit read as other content.
  - Not closed: a merge driver the repository's own config names and an attribute selects is refused by the attribute check, and a
    changed config is refused by the pin, but a file named by `include.path` in the repository config is not pinned; git older than
    2.32 does not know `GIT_CONFIG_GLOBAL` (unverified); a custom driver is never run, so a merge that needed one now stops.
  - Tests: `integration.rootPinMoves.test.ts` (a global driver and a global attributes file do not run and the content is the plain
    text merge, checked by hand to fail with the isolation off; the global identity is kept; `merge=union` from an untracked
    `.gitattributes`, from `.git/info/attributes` and from the branch's own file refused; `binary`, `text` and unset allowed; a
    failed read refuses; the linked-worktree environment).
- **Lows.** `rootPin.ts` opens a config, attributes or hook file only after `lstat`, without following a link or blocking
  (`O_NOFOLLOW`, `O_NONBLOCK` where they exist), and reads only regular files up to 4 MB: a link, a FIFO, a device, a folder or a
  larger file is an unreadable reading that never equals another (so it counts as moved); a hook that is a link is recorded by its
  target. `runUsage.ts`: with a bridged child on the run's own connection the root's cost is the larger of the adapter's total and
  its native agents' sum (a root with no per-agent cost no longer counts as 0 in the daily and monthly figure), plus the bridged
  agents' known cost (`runManager.capBridged.test.ts`; `integration.rootPinMoves.test.ts` for the file reads).

### Security fix round (the merge gate: one High, four Mediums, Lows)

Reviewer blocked the push on H1; fixed here with real-git tests (`runtime/integration.mergeGateFix.test.ts` unless named).

- **H1. The merge read the user's global git config AFTER the test command, and carried `core.protectNTFS` / `core.protectHFS`
  from it.** The test command is repository code run as the user and can edit `~/.gitconfig`; with the protections carried as
  `-c core.protectNTFS=false`, a branch tree holding an entry that aliases `.git` (`.git::$INDEX_ALLOCATION`, `.git.`, `GIT~1`;
  `.git ` is the same class) made the merge write into the real `.git`. Reproduced on this Windows machine with the old code
  (the three names above wrote `.git/pwned`; the test fails there and passes now). Now:
  - (a) `core.protectNTFS=true` and `core.protectHFS=true` are forced on every guarded git call (`WRITE_SAFETY_OVERRIDES` in
    `gitGuarded`), on every platform; a `-c` beats every config file, and neither key is ever carried.
  - (b) The carried settings are read ONCE, before the test command runs, in the same locked reading as the root pin
    (`integration.ts runTests`), and handed through `GateDecision.carried` to `mergeInto`. With no test command they are read
    when the gate would have pinned (after the review approval; with no gate at all, in `integrateWorktree`'s first locked step).
    `mergeInto` reads no config. The re-ask path keeps the snapshot of the first reading.
  - (c) The carried set is `user.name`, `user.email`, `core.autocrlf`, `core.eol`, `core.safecrlf`, `core.filemode`,
    `core.symlinks`, each validated (booleans, `input`, `lf` / `crlf` / `native`, `warn`; name and email without control
    characters, angle brackets or spaces in the email), and only when the winning value comes from the system or global scope
    (`git config --show-scope`): a value the repository's own config sets is read by the merge itself, and a command-line copy
    would override it. `core.ignorecase`, `longpaths`, `fscache`, `precomposeunicode`, `checkstat`, `trustctime` are no longer
    carried (the repository's own config holds ignorecase; the others were not shown to be needed). `safe.directory` is never
    copied from config: when the user's config trusts the folder (its exact path, or `*`) the merge gets
    `-c safe.directory=<root>` with the path OrgAI computed (a linked worktree has no pinned `GIT_DIR`).
  - Tests: four alias names with the protections switched off globally by the gate step (nothing is written under `.git`, the
    merge is refused); a test command rewriting global `user.name` / `core.autocrlf` (without and with a review card) does not
    change the merge commit's author or the CRLF handling; the guarded runner forces both protections over a repository config
    that turns them off; the carried set is exact and validated; a repository value is not copied over. The earlier line-ending
    tests (`integration.rootPinMoves.test.ts` "line-ending", `teamFiles/service.sync.test.ts`) pass unchanged.
- **M1. The merge ledger could record someone else's move as OrgAI's.** The ledger no longer takes a HEAD snapshot at function
  entry and one in a `finally`. `mergeInto` reads HEAD immediately before each `git merge` attempt and records a move only when
  the new HEAD is a merge commit whose first parent is that HEAD and whose second parent is the merged sha (or, for a
  fast-forward, is the merged sha with the old HEAD as ancestor): `mergeMadeMove`. `ensureMainBranch` records the exact old HEAD
  and the exact commit it checked out. A plumbing `update-ref` or commit that lands between the gate and the merge is therefore
  not in the ledger, and the chain check (`rootVerdict`) reports it as a change by someone else. Tests: a commit landing in the
  verify window gives `folder` (fails with the old ledger), `mergeMadeMove` cases, the `mainBranch` switch chain, the plain merge
  still `orgai`.
- **M2. The re-ask card did not show the root's own change.** `folderChangeNote` (`rootPin.ts`) now carries, in the card's
  existing `stat` text field (`MergeReview.stat`; the renderer is not changed), a bounded plain-text summary: up to five commit
  subjects, `git diff --stat` between the pinned and the current HEAD, and the stat of the staged and of the unstaged changes (the
  unstaged one only when the repository defines no filter driver, as the pin; else a line says so). Each block is cut to 12
  lines and 1.6 KB with "... n more lines not shown", every line clamped to 120 characters, control and bidirectional characters
  removed, no external diff or textconv program run (guarded runner). The note says the project folder itself changed while the
  tests ran and that approving merges the report on top of that change, and labels the block "text from the repository (commit
  subjects, file names), not from OrgAI".
- **M3. The org chart and settings cards had no non-desktop guard on two paths.** `SetupService.applyProposal` with `nonDesktop`
  (a decision from `cli`, `tui` or `policy`): the `orgChart` case runs `desktopOnlyProjectChanges` on the merged project (the merge
  drops every current role the proposal omits and a second proposal can add a same-named uncapped role: a role's `maxConcurrent`
  or `knowledgeWrite: false` cannot be shed that way), and the `settings` case also refuses turning `reviewMerges` off. Both come
  back as a revise with the window-only sentence, nothing saved; the window is unchanged. `requireTestsPass` and `testCommand`
  were already refused by the same function. A project save from a terminal may still turn `reviewMerges` off (`orgai projects set
  --review-merges off` is unchanged). The false comment in `projectSaveGuard.ts` is corrected: team files DO carry
  `maxBudgetUsd`, `maxSubagentDepth` and `maxConcurrentSubagents`, and `teamFiles/gate.ts` holds any change that raises them
  (effective values) for the desktop review (`gate.test.ts` "looser settings pend"). `keepFailedBranchesDays` is not counted in
  `guardedFieldsOf`: a new project starts without it, which only keeps copies longer, so removing a project sheds no protection.
  Tests: `setup/settingsProposalBoundary.test.ts`.
- **M4. Filters (git-lfs and other clean / smudge programs).** The neutral merge ignores filter drivers in the user's global and
  system config and runs none, so it would write the stored form of a filtered file (git-lfs pointer files) and the folder would
  show them as modified. Decision: the automatic merge is refused, before anything is merged, when a `filter` attribute is set
  for any path the merge changes (read like the merge attributes: the root's working tree and `info/attributes`, and the
  attributes the merged commit itself carries). The message names the files, says OrgAI runs no filter program, and says to merge
  it by hand with git in the project folder (`git merge <sha>`), where the user's filters run; the branch is kept. No filter
  program is run. For the pin: `pinRoot` already reports the working tree "not pinned" under a repository filter driver and
  builds `changes` from HEAD, the index and the staged difference (all read without running a filter), so parallel OrgAI merges
  chain; the report said `changes` was unreadable there, which the code does not do. A test pins it (two reports finishing together
  with a repository `filter.*.clean` configured both merge, no re-ask); it passed before this round as well.
- **Lows.** `mergeAttributeRefusal` looks up attributes under both names of a renamed file (`git diff --name-status -M -z` on
  `HEAD...sha`, plus the renames of the checkout's own side) and refuses when the paths cannot be read. The scratch index of that
  check lives in its own `mkdtemp` folder (`use-xxxx`, owner-only where the platform has modes) under `<tmp>/orgai-merge-scratch/`,
  removed after the check, and the first use in a process removes `use-*` folders and loose `*.index` / `*.index.lock` files older
  than ten minutes there (`sweepMergeScratch`); it is not called from the desktop boot.

### Behaviour changes for existing users

- A run under any cap stops when part of its cost has no known price or is unknown (a per-run cap the user chose, the project's
  budget). A first-party Claude run under the project's budget is the exception for its own session: its SDK stops it, and a model
  or subagent missing from OrgAI's price table does not end it in its first turn. Before, that spend counted as $0.
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
- **Merges run with the repository's git hooks off.** `pre-merge-commit`, `commit-msg`, `post-merge` and `post-checkout` do not run
  for OrgAI's merge, its branch switch (`mainBranch`) and its cleanup. This affects git-lfs hooks, secret scanners that sit in
  those hooks and signing prompts started from them. The report's own commit in its copy (`commitLeftovers`) still runs the
  repository's hooks.
- **Merges ignore the user's global and system git config and attributes.** A merge driver, `core.attributesFile`, signing
  settings (`commit.gpgsign`) or other settings that live only in the user's global config do not apply to the merge commit; only
  the user's `user.name` and `user.email` and `core.autocrlf`, `core.eol`, `core.safecrlf`, `core.filemode`, `core.symlinks`
  are used for it, read before the test command runs (a command that rewrites the global config does not change the merge), and
  git's `core.protectNTFS` / `core.protectHFS` are forced on for every OrgAI git call whatever any config says. `core.longpaths`,
  `core.fscache`, `core.precomposeunicode`, `core.checkstat` and `core.trustctime` set only in the user's global config no
  longer reach the merge; `safe.directory` reaches it only as the project folder's own path, when the user's config trusts it.
  A merge whose files an attribute sends to a custom merge driver or
  to `merge=union` is refused before it runs ("Not merged: a merge attribute selects a custom merge ..."), the copy is kept; git's
  own text merge, `merge=binary`, `merge=text` and `-merge` are unaffected.
- **Inherited `GIT_*` variables are dropped** for OrgAI's git calls on a plain checkout (as before) and now on a linked worktree
  too, and replace objects are ignored in both: `GIT_AUTHOR_*` / `GIT_COMMITTER_*` / `GIT_DIR` / `GIT_INDEX_FILE` and the like set in
  the environment OrgAI was started from no longer reach a merge, a branch deletion or a history query. A merge commit takes its
  identity from git config (or OrgAI's), not from those variables.
- **Pending native spawns count toward `maxAgentsPerRun`.** A native report an adapter approved but has not started (Claude's
  approved-but-not-yet-started spawn) counts in a bridged delegation's cap check; briefly it may count twice (approved, then
  started): never fewer.
- **The project folder changes while the tests run.** A merge of another report into the same checkout by OrgAI itself while the
  tests run is not a change: the merge goes on on top of it. A commit, an edit of a tracked file or a staged change by anyone else
  (you, or the test command: git cannot tell them apart) moves the pin: with a review card in the merge you are asked once more,
  with the reason "The project folder changed while the tests ran" and the new commits; without a review card the merge is refused
  and the copy kept, as before, with a sentence saying so. A change to `.git/config`, `config.worktree`, `info/attributes`, the
  hooks folder or an untracked `.gitattributes` is always refused. A test command that commits on the root is refused when there is
  no review card (with one, you are asked).
- The git summary shows no working-tree status on a repository that defines its own filter drivers.
- **A merge that touches a file with a `filter` attribute (git-lfs, any clean / smudge filter) is refused, and the branch kept.**
  "Not merged: a filter is set for <files> (filter=lfs) ... Merge it by hand with git in the project folder". OrgAI's merge runs no
  filter program and would otherwise have written pointer files instead of content. Merge those branches yourself with git (your
  filters run there), or discard or hold them. Repositories whose filter attributes sit only on files a report did not touch are
  unaffected. In such a repository the test gate still pins HEAD, the index and the staged changes (not the working tree), so
  parallel OrgAI merges chain as before.
- **A renamed file is checked for merge and filter attributes under both its old and its new name**, so a merge that was
  accepted before because the attribute sat on the old name is now refused.
- **When the review card is asked again ("The project folder changed while the tests ran"), it now lists the change**: commit
  subjects, the `git diff --stat` between the old and new HEAD, and the staged and unstaged stat, bounded, as plain text marked as
  coming from the repository, and says approving merges the report on top of that change.
- **From a terminal, TUI or the headless policy, approving an org chart card that drops or replaces a role carrying a cap
  (`maxConcurrent`) or a knowledge restriction, and approving a settings card that turns Review merges off, is refused** (the card
  comes back as a revise). The window is unchanged, and `orgai projects set --review-merges off` still works.
- **Non-desktop surfaces (socket, `orgai`, the TUI, the headless policy) cannot raise or remove a spending or agent limit, and now
  cannot shed one by another road.** Before: `orgai projects set --max-budget none` or a higher figure fails with a window-only
  message (setting a budget where there was none and lowering one work as before). New in this pass, from those surfaces:
  - approving a settings card in a terminal (`setup:decide` / `runs:decide`) that raises or removes `maxBudgetUsd` or raises an
    explicit `maxSubagentDepth` / `maxConcurrentSubagents` is refused and the card comes back as a revise;
  - `orgai projects remove` (and `projects:remove` from a socket client) fails for a project that carries any guarded limit (a
    budget, a daily or monthly cap, an agent cap, a role cap or restriction, the test gate, the main branch ...) with "This project
    carries limits (...), so it can be removed in the OrgAI window only"; a project with none removes as before;
  - `templates:apply` and `projects:applyImport` (the org commands that replace a chart) fail when the resulting chart drops a
    role's cap or knowledge restriction; adding to a chart ("merge") is unaffected;
  - the window is unchanged in every case.
- **Automatic merges need git 2.32 or newer** (`GIT_CONFIG_GLOBAL`, which the neutral merge relies on). `git --version` is read once
  per process; on an older git the merge is refused before it runs with "the installed git is X and the automatic merge needs 2.32
  or newer", and the branch is kept. The checkout to `mainBranch`, the worktree removal and the branch deletion after a merge now
  run neutral too, with the line-ending settings of the snapshot taken before the tests. A second review round reuses the snapshot
  of the first; if your git name, email or line-ending settings differ when the second round starts (a test command rewrote them),
  the merge is refused with "your git settings changed while the tests ran".
- **The re-ask note does not list untracked files** (it says so), and when the folder's HEAD went backwards it names the old and new
  short sha. Invisible characters (every format character, variation selectors, tag characters, the Braille blank, Hangul and
  Khmer fillers) are removed from repository text in it.
- **`orgai projects set --review-merges off` still works from a terminal, by design**: proposals (cards) cannot turn review off.
- Known limits, not fixed in this round: configuration pulled in by `include.path` is not pinned; `commit.gpgsign` / `gpg.program`
  in the repository config are not forced off; `discardWorktree` and `commitLeftovers` still use the unguarded git runner (both are
  outside the merge path).

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

## With several sessions on one data folder

The overhaul's main-process code was written before the CLI sessions work (`docs/design/cli-sessions.md`: several `orgai`
processes on one data folder, one write lock, `storeSyncFor(dataDir).locked`, re-read before change). The merge of the two
was audited writer by writer (the labels are in `writePathInventory.allowlist.ts`). The desktop app keeps one process per
data folder, so none of this applies to it.

| Writer or reader | Result |
| --- | --- |
| `ProjectStore` (new fields, `cleanProjectLimits`, `cleanRoleLimits`) | Correct as is: pure cleaning inside the existing `change` / `load`; a load that cleans something persists inside `migrateAll`'s change. |
| `SettingsStore.set` and `OVERHAUL_KEYS` | Correct as is: with a newer file the merge is `{ ...stored, ...changedFields(base, given) }`, so a field the caller did not change keeps the other session's value, and a key the caller left out (an older renderer) is filled from the stored one. Test: `sharedStores.test.ts` "the UI overhaul fields merge like the others" and "a save that leaves the overhaul fields out". |
| `allowCounter.ts` (`allow-counts.json`) | Fixed. The write was atomic (unique temp name, rename) but the read-change-write of `bumpAllowCount`, and the version 1 migration inside a read, ran without the lock. Both now run under the write lock (a busy lock means "not counted", never a throw). Bumps come from the desktop decide path only. Test: `allowCounter.test.ts` "counter file on a data folder several sessions share". |
| `TemplateService.countApplied` (built-in and saved apply counts) | Fixed: it read the index and rewrote it without the lock (every other index change already had it). It now runs under the lock. `duplicate` now holds the lock from reading the source to saving the copy. Test: `templatesBuiltIn.test.ts`. |
| The widening check of `projects:save`, `projects:applyImport`, `templates:apply` (`projectSaveGuard.ts`) | Fixed: the check read the stored project and the save followed it outside one hold, so a cap another session lowered in between could be raised again by a save that had passed the check. Check and save are now one step under the write lock (`ProjectStore.locked`, the store's own sync, not the process registry: a test that hosts two sessions in one process has two syncs on one folder). A caller whose copy is older than a cap another session lowered is still refused when its copy carries the higher value (fails closed). Test: `projectSaveGuard.test.ts` "the widening check and the save are one step". |
| `SkillService.duplicate` | Correct as is: the whole service is wrapped in `oneChangePerCall` (bootstrap), so a call is one step under the lock. |
| `SkillService.exportTo` | Correct as is: it writes a new folder in a destination the user picked (`mkdir` fails with `EEXIST`, files with `wx`), never overwrites, and reads the skill under the wrapper's lock. Two sessions exporting to one place get two folders. |
| Daily and monthly spend (`spendGuard`, `projectSpend`, `RunManager.spendRuns`) | Correct as is: the totals are pure and are built from `RunStore.list`, which re-reads the index when another session changed it, with live runs of this process replacing their stored copy. A session's usage reaches the index when it publishes usage (throttled), so another session sees it with that delay. Gap: a start check is not atomic across sessions, so two sessions starting at the same moment can both pass a cap that only one of them fits; the overshoot is bounded by one usage publish. |
| Run store fields (`hold`, `runBudgetUsd`, `excludedRoleIds`, `providerRetry`) | Correct as is: validated in `normalizeCrashedRunSummary`, a pure function; `providerRetry` is kept only with `opts.live` (the session that hosts the run is still running) and dropped for a run whose host is gone. No new file. |
| `orgaiMoves.ts` (merge ledger, `rootPin.ts`) | Correct as is, now tested: the ledger is per process, so another session's merge into the same checkout is not in it. A pin read before that merge finds no unbroken chain from the pinned HEAD, so the gate reads it as someone else's change and refuses (fails closed). Test: `orgaiMoves.test.ts` "a move another session made". |
| Finished-copies sweep at boot (`startFinishedCopiesSweep`) | Correct as is: only `hostKind === 'desktop'` runs it (`bootstrap.test.ts`); the `orgai` host never does, so a second session cannot sweep copies another one uses. `deleteBranch` rechecks under the repository lock (cross-process). |
| `appBehaviour.ts`, `overhaulIpc.ts` | Correct as is: desktop only, no file of their own. |

### A rename that overlaps another process's read (Windows)

`src/main/store/sameProject.test.ts` ("each adds 60 notes ... 60 roles at the same moment") failed on the merged tree with
`EPERM: rename 'projects.json.tmp' -> 'projects.json'`. It was not caused by the overhaul: unmodified `origin/dev` failed
4 runs in 8 on the same machine at the time (merged tree before the fix: 3 in 11). A store replaces its file by renaming a temp file over
it, and Windows refuses that rename for as long as another process has the target open, even for a read of one
millisecond. A second process re-reading the file in a loop made 445 of 647 renames fail; the same loop without the
reader made 0 of 3593 fail. The readers were the stores' own `refresh` re-reads (`ProjectStore.get`, phase 4 of the test:
both children save in a tight loop, each save makes the other's next `get` re-read), which ran outside the lock.

Fix (`store/shared/storeSync.ts`): a re-read of a file another session changed (and the first load) now runs under the
write lock, taken only when the stamp differs (so an unchanged file still costs one `stat`). The wait is bounded
(`READ_LOCK_WAIT_MS`, 2 s); if the lock stays held that long the read goes ahead unprotected, as before, rather than fail.
`ReentrantSyncLock.acquireWithin(ms)` is the new bounded acquire. Tests: `shared/storeSyncReads.test.ts`,
`shared/syncLock.test.ts`; the real-process test is `sameProject.test.ts` itself (10 of 10 passes after the fix; 3 failures in 11 runs
before it on this tree, 4 in 8 on `origin/dev`).

Still open: a read that is not a re-read of a synced store file (a plain `readFileSync` of a notes, graph, template or
counter file in a list call) can still overlap another session's rename of that file and make that session's write fail
with EPERM on Windows; the window is a millisecond. The only complete cure is a retry on the rename
(`host/fsRetry.ts renameSyncRetry`, which `runs.ts`, `sessions.ts` and the repository lock already use and the
`projects.json` / `settings.json` / project-data writers do not). That was not added here.

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
