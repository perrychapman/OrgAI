# Orchestration efficiency: adaptive staffing and parallel execution

Status: draft 2, decisions settled 2026-11-09: the owner accepted every recommendation in section 6 ("i agree with all
your recomendations"). NO code written; implementation has not been requested yet.

Base: `origin/dev` at `aad24c38` (PR #41, required delegation). Every code fact below was read from that commit with
`git show`, not from the local `dev` checkout, which is 310 commits behind it and lacks the delegation runtime. Draft 1
was written against the stale checkout; this draft replaces it.

Goal: a work run costs and takes about what a native Claude Code or Codex session would for the same task, and beats
it where the task can be split. Today the team, each role's model and each role's effort are fixed when the org chart
is written, and nothing makes the orchestrator start independent work together. This spec makes four things a per-run
decision, taken from what the project is and what this run asks for:

1. **how many agents** work on it (one assistant, the lead alone, one report, or a pipeline),
2. **what runs at the same time** (everything that can),
3. **which tier** each assignment runs on (Haiku / Sonnet / Opus on Anthropic, the connection's tiers elsewhere),
4. **how much effort** each assignment gets.

## 1. Evidence

Source: `~/orca/projects/orgai-performance-lab` (reports, run event logs and driver scripts, read 2026-11-09). All
runs used OrgAI's Codex adapter at `7a988037`, which `origin/dev` contains.

### 1.1 Native CLI against OrgAI

One run per arm, sequential, fresh homes, retail-equivalent cost. Exploratory pilots, not qualified benchmarks.

| Task (report) | Codex (Sol, medium) | Claude Code (Opus, medium) | OrgAI | OrgAI time vs Codex / Claude Code | OrgAI cost vs Codex / Claude Code |
|---|---|---|---|---|---|
| Ledger repair, 40 hidden tests (`native-vs-orgai-pilot-20261109`) | 53 s, $0.040, 5 calls | 38 s, $0.138, 6 calls | 132 s, $0.359, 20 calls | 2.5x / 3.5x | 9.0x / 2.6x |
| Inventory service, 58 hidden tests (`complex-pilot-20261109T092758Z`) | 171 s, $0.107 | 201 s, $0.832 | 497 s, $0.194 | 2.9x / 2.5x | 1.8x / 0.23x |
| Dashboard from scratch, 26 browser checks (`dashboard-pilot-20261109T173008Z`) | 456 s, $0.332 | 521 s, $1.82 | 1093 s, $0.562 | 2.4x / 2.1x | 1.7x / 0.31x |

Every arm passed every task. On the dashboard the first grader scored 24 / 25 / 26; after its audit all three scored
26 of 26. One non-blind visual review scored Claude Code 21, Codex 20, OrgAI 19 of 25. So OrgAI bought no measured
quality with the extra time. Its dashboard run also ended `delegation-incomplete` (three native `send_message`
attempts were interrupted; that overhead is in its time).

OrgAI teams: ledger = lead Sol, engineer Opus, reviewer Sol, all medium. Inventory = lead Sol medium, engineer and
reviewer Luna xhigh. Dashboard = lead Sol xhigh, data / frontend / qa Luna medium. Luna costs a twentieth of Sol per
token, which is why OrgAI is cheaper than Claude Code on two tasks while being slower than both.

### 1.2 The OrgAI arm was told to use the whole team, in order

The driver scripts (`.tmp/*-orgai-pilot.mjs`) set `requiredReports` to every report, `strictDelegation: true`, a lead
prompt that scripts the sequence ("Spawn engineer once to implement and test. After its report, spawn reviewer once
... inspect the final diff, repair findings, and run tests before ending") and a task suffix "Delegate and require
both reports". They also set `isolateWriters: false`, `autoContinue: false`, `continuationDelayMs: 0`, at most 2 or 3
concurrent reports, and a relay limit of 3 requests in flight. Effort was injected by the driver at the protocol
level, not by OrgAI.

So these pilots measure a mandated lead, implementer, reviewer, lead pipeline with fixed models, and say nothing
about whether OrgAI would have chosen it. That is still the right thing to fix: the default chart
(`defaults.ts` `defaultRoles`: "Delegate implementation, review and testing to your specialist reports instead of
doing everything yourself ... verify the whole") and the Architect's guidance produce the same pipeline on real
projects. But worktrees, nudges and the continuation delay contributed nothing to the measured gap, because they
were off.

### 1.3 Where the seconds went

Derived from each run's `orgai/events.jsonl` (run status changes, thread starts, agent state changes), seconds from
run start.

| Phase | Ledger (131 s) | Inventory (496 s) | Dashboard (1091 s) |
|---|---|---|---|
| Lead plans before the first spawn | 0 to 16 | 0 to 20 | 0 to 54 |
| Implementation | engineer 16 to 52 (36 s) | engineer 20 to 328 (308 s) | data 54 to 198 (144 s) beside frontend 54 to 476 (422 s) |
| Lead between reports | 52 to 62 | 328 to 340 | integrates 476 to 604 (128 s) |
| Review or QA | reviewer 62 to 110 (48 s) | reviewer 340 to 481 (141 s) | qa 604 to 873 (269 s) |
| Lead finishes | 110 to 131 (21 s) | 481 to 496 (15 s) | fixes and verifies 873 to 1091 (219 s) |
| **Time after the implementation existed** | **79 s, 60%** | **168 s, 34%** | **615 s, 56%** |
| Lead active in total | 63 s, 48% | 75 s, 15% | 544 s, 50% |

- Ledger: the implementation was complete at 52 s, inside the native range (38 to 53 s). The Opus engineer took 36 s
  alone, about what Claude Code took for the whole task. The harness is not the slow part; the pipeline is.
- Inventory: the engineer alone, on Luna at xhigh, took 308 s. Codex finished the whole task in 171 s on Sol at
  medium. The cheap tier at high effort sat on the only path there was.
- Dashboard: the two builders ran together, but one took 144 s and the other 422 s, so the split saved nothing: the
  build ended at 476 s, when both native arms had already finished everything. QA was written and run only after
  the build, and the lead (xhigh) was active for half the run.

### 1.4 Shape, model and effort inside OrgAI

| Comparison (report) | Result |
|---|---|
| Solo against a hierarchy, 3 tasks, 9 trials (`team-benefit-20261109T043231Z`) | Solo Sol: median 33.5 s, $0.209 for three, 3 of 3. Solo Luna medium: 38.1 s, $0.013, 3 of 3. Five-agent hierarchy: 96.8 s, $0.323 (usage incomplete), 2 of 3. |
| Team size, one episode (`scenario-screen-20261108T190810Z`) | Solo 31 s; pair 38 s; lead and three 49 s; hierarchy 79 s (out of budget); swarm 112 s (out of budget). All answers correct. |
| Effort, same four-agent team (`model-effort-pilot-20261108T182044Z`) | Specialists at medium 53 s; at xhigh 74 s; lead at xhigh too 84 s. All correct. |

The six solo trials also show the fixed cost of a run: 5.4 to 6.0 s of each (runs of 20 to 56 s) is outside any model
call, about 1.6 s before the first request and 4.0 s after the last.

### 1.5 What follows, ranked by observed seconds

1. **The tail.** Review, QA and the lead re-checking and integrating take 34 to 60% of the run, after the work
   exists, one after another.
2. **The critical path is staffed without regard to time.** A slow tier or a high effort on the longest step sets
   the run's length; xhigh added 40 to 60% with no change in correctness.
3. **The team is bigger than the task.** In the same harness, one agent is about as fast as the native CLI and a
   cheap solo run passed everything at 6% of the cost.
4. **Parallelism is unused or badly cut.** Two pilots were strictly serial; the third split the work 144 s against
   422 s and wrote its checks only after the build.
5. **Lead time.** 16 to 54 s before anyone starts; the lead active for up to half the run.
6. **Fixed cost.** About 6 s per run, and 1.4x to 4.4x the native input tokens per call (ledger: Codex 14.4k,
   Claude Code 5.8k, OrgAI lead 20.6k, OrgAI Opus engineer 25.5k).

Not established by any of this: the cost of worktree isolation, nudges and the continuation delay (off in the lab),
anything about the Claude adapter (the lab drives only Codex), and how today's runtime behaves when the team is not
forced. Phase 0 measures all three.

## 2. Current behaviour (origin/dev, read 2026-11-09)

- **Model and effort are per role and fixed.** `Role.tier`, `Role.model`, `Role.effort` (`src/shared/types.ts`).
  Claude: `claude.ts` `buildAgents` writes one `AgentDefinition` per role with `model` and `effort`; the root runs as
  `agent: root.slug`, so its effort is its definition's. Codex: `threadParams` takes `role.model`; effort is sent per
  message and only for low / medium / high (`effortOptionsFor`), so a Codex role set to xhigh sends none.
- **One per-spawn override exists**: the plan guard. `claude.ts` `steerToEveryday` rewrites a spawn's `model` through
  the PreToolUse `updatedInput`. A valid model id the orchestrator puts on a spawn is already kept.
- **The SDK accepts both per spawn.** `@anthropic-ai/claude-agent-sdk` 0.3.318 (`sdk-tools.d.ts` `AgentInput`):
  `model?: 'sonnet' | 'opus' | 'haiku' | 'fable'` and `effort?: 'low' | ... | 'max'`. Typings only; no smoke script
  has exercised either, and the tool's own description tells the model to set effort only when instructed.
  `docs/agent-notes/sdk-facts.md` still records 0.3.312.
- **Delegation is mandatory or adaptive** (`delegation.ts`, `docs/design/delegation-enforcement.md`):
  `Role.requiredReports` and `--strict-delegation` are enforced with receipts; everything else is adaptive, and the
  ledger records what adaptive agents used and skipped. Nothing guides the adaptive choice.
- **Shape is all or one.** The whole chart, or `RunTeam 'single'` chosen by the user. `singleRunProject`
  (`defaults.ts`) builds one "Assistant" holding the union of every role's tools, MCP servers and skills, with
  writer isolation and run messaging off, a question-answering prompt, the model from `quickRunModel`, no plan
  nudges, and it is counted as an Ask in usage.
- **Parallel work is possible but not driven.** Limits: 8 concurrent reports by default, 32 at most
  (`effectiveSubagentLimits`). Codex `spawn_report` returns at once and the report arrives later as a message.
  Claude spawns run in the background by default. Writers in worktrees merge one at a time per working directory and
  a conflict is handed to the orchestrator (`integration.ts`). The only sentence that encourages parallel work is in
  `orchestratorIsolationText`, shown when isolation is on. `PlanStep` is `{ id, title, status, note?, owner? }`:
  no dependencies, so the harness cannot tell which steps could run together. `nudgeBlocked` sends nothing while any
  report is running.
- **Two paths are serial by construction.** A required report on Claude is forced to the foreground
  (`run_in_background = false`, so the receipt arrives in the same tool result), and `delegate_agent` for a bridged
  role "returns its final report when it is done". Each blocks its caller unless several calls go out in one
  message; that this runs them together is unverified here.
- **Plans are required.** `unattendedText` tells every team root to start with `set_plan`; `continuation.ts` nudges
  a root that ends its first turn without one.
- **The root prompt is long whatever the task** (`buildRolePrompt`: org change, cross-run, MCP install, skills
  config, outputs, tool hygiene, self-knowledge).
- **Efficiency is partly instrumented already**: the Usage page has cache, cost per run, tokens per turn, retries,
  no-result, nudges, idle and team-against-Ask signals (`usageEfficiency.ts`). `AgentInstance` has `startedAt` and
  `endedAt`. Nothing records overlap, time to first spawn or the tail.

## 3. Principles

- **Quality floor first, then time on the critical path, then cost everywhere else.** That is the default goal
  (`balanced`); a project or a run may ask for `speed` or `cost` instead.
- **Precedence**: the user's explicit choice; then required reports, strict delegation and what a role prompt or the
  brief demands; then project policy (ceilings, review policy, limits); then the project profile; then the
  orchestrator's pick; then defaults.
- **A role's configured tier and effort are a ceiling.** Automatic staffing never spends more per call than the
  chart allows today; it may spend less.
- **Parallel is the default, sequence needs a reason.** A step waits only for a step it names.
- **The orchestrator proposes, the harness clamps and records.** Every pick is visible with its reason.
- **Tiers, never vendor names.** Resolution goes through the connection's `tierModels`.
- Adapters carry hook mechanics only; the decisions live in pure, tested modules.

## 4. Design

### 4.1 Right-size the run

**Before the session: one assistant or the team.** A pure module `runtime/triage.ts` returns
`RunTriage { shape: 'solo' | 'team'; tier; rootEffort; reason; source }` for a work run of a stored project started
without an explicit choice.

- Order: the user's choice (`--team`, composer) wins; a continuation keeps its chain's shape; rules that force
  `team` (the root has required reports or the run is strict; an engagement project; another work run is live in the
  same repository and the project isolates writers); otherwise one fast-tier one-shot through
  `RuntimeAdapter.complete` (the path run titles use, `src/main/ai/runTitle.ts`) with the task text, project kind
  and role names, answered with one word and raced against 3 s. Timeout, error or an unparseable answer: `team`.
- `solo` gets its own builder, `soloRunProject`, not `singleRunProject`: the same union of tools and grants, a
  work prompt (do the task, verify, report what changed), the tier triage picked capped by the root's tier, run
  messaging as the project has it, plan optional, usage kind `work`. Its edits land in the project checkout without
  a worktree, as a team root's own edits do today.
- Way back up: `escalate_to_team({ reason, notes })`. RunManager ends the turn and continues the same session chain
  as a team run with the notes as hidden context, marked as data. Once per chain.
- Never for setup, quick, trust-restricted or assistant runs.
- The one-shot's latency is unknown. Phase 3 measures it first: if the median is above 1.5 s, triage ships with
  rules only and the in-team sizing below carries small tasks.

**Inside a team run: three sizes.** A harness paragraph for the root, additive to its role prompt and yielding to
it: "unless your instructions, the brief or required reports say otherwise" a contained change is done by the lead
itself when it holds the tools; a well-specified piece of work goes to one report with no separate review; the full
pipeline is for work that is large, risky or splittable. The root learns the task by reading the code, which the
triage call cannot, so this is where most right-sizing happens. `defaultRoles` and the Architect guidance in
`setup.ts` get the same wording for new projects; stored charts keep their text.

### 4.2 Parallel by default

The orchestrator gets the ability (rules that tell it to), the capability (mechanics that make it possible on every
path) and the feedback (the harness says what is ready and what is idle).

**The plan is a graph.** `PlanStep` gains `after?: string[]` (ids it waits for; none means it can start now) and
`paths?: string[]` (files or folders it will change). `readySteps(plan)` is pure: pending steps whose `after` are
all done or skipped.

**The harness says what is ready, at the moment of decision.**
- `set_plan` and `update_plan` end their result with the ready set and the free slots: "Ready now: p2 (implementer),
  p3 (implementer), p5 (researcher). 6 of 8 agent slots are free. Start all of them in this message."
- A report's delivery message names the steps that its completion unblocks.
- A new nudge kind, `ready`: when a root turn ends with ready steps nobody is working on and slots free, the harness
  says so once per ready set, even while other reports are running (today `nudgeBlocked` forbids that). It counts
  against `maxAutoContinues` and never fires on a held, rate-limited or waiting run.
- `set_plan` warns when two steps that could run together name overlapping `paths` and treats them as ordered until
  the root separates them. With writer isolation off, parallel writers need disjoint `paths`; with it on, the
  warning saves a merge conflict.

**Rules for the root** (one short paragraph, shown whether or not isolation is on):
- Start every ready step in one message. Calls in one message run together; calls in separate messages do not.
- Cut the longest piece first. A split that leaves one piece nearly as long as the whole saves nothing.
- Fan a role out: several instances of the same role on disjoint scopes (call sites, modules, questions).
- Work from the contract, not the result: once the interface and acceptance criteria are fixed, tests, checks and
  docs start beside the implementation and run when it lands.
- Review beside the next step, not after everything; large diffs get one reviewer per area.
- While reports run, the lead does only a step it owns in the plan, never work it handed out, and otherwise ends its
  turn and waits.

**Mechanics that are missing today.**
- Bridged roles on Claude: `delegate_agent` gains `background: true`, returning a handle at once with the report
  delivered later as a harness message, as Codex `spawn_report` already does. Required bridged reports keep the
  blocking form.
- Required reports on Claude stay in the foreground (the receipt needs the tool result). A smoke script confirms
  that several foreground spawns in one message run together; if they do not, required reports move to a
  background spawn with the receipt attached to the delivery message.
- Width: the ready line states free slots from `effectiveSubagentLimits`. After a rate-limit or overload event the
  harness reports one free slot until the window clears, so a fan-out does not turn into retries.
- Merges stay serialized per working directory; nothing changes in `integration.ts`.

**What is measured**: overlap ratio (summed agent time over wall time), ready-idle time (a ready step with a free
slot and nobody on it), the critical path's length against the run's, time to first spawn.

### 4.3 Model and effort per assignment

- `Role.staffing?: { mode: 'auto' | 'fixed'; minTier?: ModelTier; maxEffort?: Effort }`. Absent means `auto` with the
  role's `tier` and `effort` as the ceiling. A role with a concrete model and no tier (an explicit user pick) is
  `fixed`. `inherit` roles follow their parent's resolved tier.
- `PlanStep.staff?: { role; tier; effort }` is where the orchestrator states its pick. The spawn gate binds a spawn
  to the first unbound ready or in-progress step naming that role and applies its tier and effort; a spawn with no
  matching step uses the resolver's default. A pick made directly on the spawn call is honoured the same way.
- A pure module `runtime/staffing.ts`:
  `resolveStaffing({ role, requested, goal, onCriticalPath, profile, tierModels, planGuard, adapterEfforts })`
  returns `{ tier, model, effort, source, note }`. Order: the requested value, else the profile's default (4.5),
  else the rubric's default for the role; clamp to the role's bounds; plan guard; the nearest effort the adapter
  supports; the nearest lower tier the connection has a model for. `source` is 'orchestrator', 'profile', 'role',
  'clamped', 'plan-guard' or 'escalated'. The spawn's result states the tier and effort actually used.
- Mechanics. Claude: the gate sets `model` and `effort` on the spawn through `updatedInput`; the root's effort is
  set on its `AgentDefinition` when the session is built. Codex: `spawn_report` gains optional `tier` and `effort`;
  the thread starts on the resolved model and each message carries the resolved effort. Bridged roles resolve
  against their own connection. Mock implements the whole path first.
- The rubric (about eight lines in the root prompt, and an explicit instruction to set model and effort on every
  spawn, which the SDK tool otherwise discourages):
  - fast: search, mechanical edits, running checks, summaries;
  - everyday: well-specified implementation, tests, routine review;
  - deep: ambiguous design, cross-module change, hard debugging, security review;
  - effort low for mechanical work, medium by default, high where the reasoning is subtle;
  - on the critical path prefer a higher tier at lower effort to a lower tier at high effort; off it, prefer the
    cheaper tier, since it has slack.
- Escalation: a step whose result fails verification or comes back unresolved may be retried one step up in tier or
  in effort, at most twice, never past the ceiling. xhigh and max are reached only this way or on a `fixed` role.
  `top` is never picked automatically.
- The root: tier from the chart, effort from triage (medium unless the task is ambiguous or the role is `fixed`).
- Goal: `StaffingGoal = 'balanced' | 'speed' | 'cost'` on the project, overridable per run. `speed` treats every
  step as on the critical path; `cost` treats none as.

### 4.4 Review and verification by risk

- `Project.reviewPolicy?: 'always' | 'risk' | 'never'`, default `risk`. (Not `review`: `teamReview` and
  `reviewMerges` already mean other things.) Under `risk` the root asks for review when a role prompt or the brief
  demands it, the change touches paths the project marks sensitive, the diff is large, or verification failed once.
  Required reports always win.
- Verification runs once per integrated result, by a fast-tier "run the checks" step that starts as soon as the
  result lands, beside any review. The lead reads the evidence; it does not re-run it.
- A reviewer's findings go back to the agent that wrote the code (a message to a live report, or one new spawn),
  not to the lead to repair by hand.

### 4.5 Project profile

`<data>/staffing/<projectId>.json`, written by RunManager at run end from what it already holds: the plan (steps,
their assignments, escalations), the delegation ledger (receipts: delivered, verdict, report length) and usage
(time, tokens, cost per agent). Per role, tier and effort: assignments, first-pass count (the step reached done on
its first assignment with a valid receipt), escalations, median wall time, median cost. The last 200 assignments.

It feeds two things: the resolver's default for an unrequested pick (under `balanced` and `cost`, the cheapest tier
and effort with at least 5 assignments and 80% first pass; under `speed`, the fastest such), and a staffing brief of
at most 600 characters in the root's first message ("implementer: everyday / medium passed 9 of 10, median 2 min;
deep was needed for 2 migration steps"). Numbers and role names only, one line, marked as data. Never across
projects. An empty profile means the rubric alone decides.

### 4.6 Fixed overhead

Each item ships only if Phase 0 shows it matters.

- Prompt diet: move the org-change, cross-run, MCP install and skills config paragraphs out of the root prompt and
  into the descriptions of the tools they describe; a report gets only what a report can act on.
- Run end: about 4 s pass between the last model response and run end in the lab's solo trials. Find what it is
  (`REPORT_HANDBACK_GRACE_MS`, the continuation delay, teardown) before changing anything; exec settlement depends
  on those waits.
- Plan: a team root may skip `set_plan` when it does the work itself or hands out one step; `nextNudge` stops
  sending `SET_PLAN_NUDGE` when the first turn ended with the work delivered and nobody running.
- Worktrees and the continuation delay were off in the lab. They are measured in Phase 0 and left alone here.

### 4.7 What the user sees

- Run view and TUI: each agent row shows tier and effort with the reason on expand ("everyday / medium: chosen by
  the orchestrator", "fast: capped by the role"). The plan pane shows ready, running and waiting-on for each step;
  the run strip shows the shape, why, and how many agents are working now.
- Composer: "Team: Automatic / One assistant / Whole team", default Automatic. CLI: `--team auto | single | full`
  (`default` stays a synonym of `full`), `--goal balanced | speed | cost`.
- Team tab, role editor: "Model and effort: Automatic up to <tier> / <effort>" or "Always <model> / <effort>".
- Team files: `staffing` on a role, `reviewPolicy` and `staffingGoal` on the project. The gate treats a raised
  ceiling as "May spend more", like a raised effort today; lowering or switching to automatic needs no card.
- Usage: time to first spawn, overlap and tail beside the existing efficiency signals; cost by tier; solo and team
  counts.

## 5. Contract (a "Run staffing" section in `src/shared/types.ts`)

- `RoleStaffing`, `Role.staffing?`; `ReviewPolicy`, `Project.reviewPolicy?`; `StaffingGoal`,
  `Project.staffingGoal?`; `Project.staffing?: 'auto' | 'fixed'` (`fixed` restores today's behaviour exactly).
- `RunShape = 'solo' | 'team'`, `RunTriage`; `StartRunInput.team` widens to `'auto' | 'single' | 'full'`;
  `StartRunInput.goal?`.
- `PlanStep.after?`, `PlanStep.paths?`, `PlanStep.staff?`.
- `StaffingAssignment { agentId?; stepId?; roleId; tier; model; effort?; source; note? }`;
  `RunStaffing { shape; goal; triage?; assignments }` on `RunRecord`, written through
  `RuntimeContext.updateStaffing` (RunManager stores, persists, broadcasts), event `staffing.updated`.
- `RunEfficiency { firstSpawnMs?; overlapRatio?; readyIdleMs?; tailMs?; criticalPathMs? }` on the run's usage.
- Nudge kind `'ready'`. Tools: `escalate_to_team`; `delegate_agent.background`; `spawn_report.tier` and `.effort`.
- `StaffingProfile` stays in main; the Team tab gets a read-only summary.
- All structured-clone safe. Coexists with `RunRecord.delegation`: the ledger says whether obligations were met,
  staffing says who was chosen and why.

Files: new `runtime/triage.ts`, `runtime/staffing.ts`, `store/staffingProfile.ts`, each with tests beside it;
changes in `continuation.ts` (`readySteps`, the `ready` nudge), `harnessTools.ts`, `prompts.ts`, `claude.ts` and
`codexAgents.ts` / `codex.ts` (mechanics only), `mock.ts`, `runManager.ts`, `defaults.ts`, `setup.ts`, team files
(`doc.ts`, `parse.ts`, `serialize.ts`, `gate.ts`), renderer and TUI. Hot files (`types.ts`, `runManager.ts`,
`defaults.ts`) take one claim at a time, so the contract lands first, alone and complete.

## 6. Decisions (settled by the owner, 2026-11-09)

The "Decided" column is what this spec builds. The last column records what was not taken and why it was offered.

| Decision | Decided | Alternative not taken |
|---|---|---|
| D1. Existing projects | Automatic, each role's current tier and effort as its ceiling | Opt in per project: no surprise, and the gap stays until each project is switched |
| D2. Who picks tier and effort | The orchestrator proposes, the harness clamps and records | Harness rules only: predictable, blind to what the step is |
| D3. Solo triage | Rules plus a fast-tier one-shot (3 s limit), dropped to rules only if its median latency is above 1.5 s | Rules only from the start: no extra call; small tasks rely on the lead doing the work itself |
| D4. Solo edits | In the project checkout, as a team root's own edits today; never chosen while another run is live in an isolating project | Always a worktree: safer beside other runs, adds a merge to every small task |
| D5. Review | By risk | `always`: today's tail on every change |
| D6. Goal | `balanced` | `speed` as default: shortest runs, higher spend on side work |
| D7. Idle-ready nudge | On, once per ready set, counted against the auto-continue limit | Off: the root is told what is ready only when it touches the plan |
| D8. Learning from history | On, per project, local file | Off: rubric only |
| D9. Top tier | Never automatic | Allowed on a second escalation: better odds on the hardest step, least predictable spend |

## 7. Acceptance

The targets below stand as proposed. They were set before the real baseline (arm 4) exists, so they are revisited
once, at the Phase 0 gate, and then frozen.

Arms, at least 3 repeats each, on the three tasks above, one trivial task and one that splits into independent
modules:

1. native Codex; 2. native Claude Code;
3. OrgAI forced (today's driver config), kept for continuity;
4. OrgAI adaptive on `origin/dev` as it is: a neutral default chart, no required reports, no scripted prompt. This
   is the real baseline and does not exist yet;
5. OrgAI single assistant on the native arm's model: the harness's own overhead;
6. OrgAI with this spec.

The adaptive arms run with the relay's in-flight limit at the project's concurrency (it is 3 today, which caps any
fan-out) and with writer isolation on in one variant. A Claude-adapter arm is added before any Claude number counts.

Targets for arm 6 against the native arm on the same model:

- trivial and small tasks: wall time and cost within 1.25x;
- medium: wall time within 1.3x, cost within 1.25x of the cheaper native arm;
- splittable: wall time at or below the faster native arm (stretch 0.8x), overlap ratio at least 1.5, cost within
  1.25x of the cheaper native arm;
- no task loses pass rate against arm 4; tail under 25% of the run; ready-idle under 5%;
- a report's input tokens per call within 1.5x of the native CLI on the same model.

Lab runs cost real tokens and run once per phase gate.

## 8. Phases

0. **Measure.** `RunEfficiency` derived from events RunManager already has; arms 4 and 5; raise the relay limit;
   repeats; the input-token split (prompt, tool schemas, messages); the 4 s at run end; worktree and merge time.
   Gate: a baseline table replaces 1.1 to 1.4. If arm 4 is already near native, the ranking in 1.5 is redone before
   anything else is built.
1. **Prompt-only changes, no contract.** The three-sizes paragraph; the parallel rules (4.2); the tier and effort
   rubric with the instruction to set both on each spawn (Claude accepts them today; Codex follows in Phase 2);
   root effort; default chart and Architect wording; the prompt diet. Gate: lab rerun.
2. **Contract, plan graph and per-spawn staffing.** Types and defaults; `staffing.ts`; `readySteps` and the ready
   lines; mock; SDK smoke scripts (model and effort through `updatedInput`, several foreground spawns in one
   message); Claude gate; Codex spawn parameters; the `ready` nudge; background `delegate_agent`; team files and the
   gate rule. Reviewer pass on team files and anything that can raise spend.
3. **Run shape and review policy.** Triage latency measured first; `triage.ts`; `soloRunProject`;
   `escalate_to_team`; `reviewPolicy`; optional plan for short work.
4. **Profile.** `staffingProfile.ts`, the resolver default, the staffing brief.
5. **Surfaces.** Run view, TUI, composer, CLI flags, Team tab, usage; e2e selectors in the same change (`runs.mjs`,
   `team.mjs`, `team-files.mjs`, `usage.mjs`, `cli-tui.mjs`, `cli-exec.mjs`).
6. **Gate.** The full comparison against section 7; `docs/agent-notes/core-runtime.md`, `sdk-facts.md` (now
   0.3.318) and `.orgai/ARCHITECTURE.md`.

Each phase lands on dev behind `Project.staffing` after the local gate (typecheck, the whole unit suite, build, the
e2e scripts for the area). Work starts from `origin/dev` in its own worktree, not the local `dev` checkout, which is
behind and carries uncommitted project-instances work that must not be disturbed.

## 9. Executing this spec

The executing session is the orchestrator: it sequences phases, holds the hot-file claims, reviews each result
against this document, runs the gates and pushes. It writes no feature code. Implementers are subagents on Opus,
Sonnet or Haiku, picked per package by the rubric of 4.3, and packages that touch different files run at the same
time in their own worktrees, by the rules of 4.2:

| Work package | Model | Effort | Runs beside |
|---|---|---|---|
| Contract in `types.ts` / `defaults.ts` (all of section 5 at once) | Opus | high | nothing: hot files |
| `staffing.ts` and `triage.ts` with tests | Opus | high | everything after the contract |
| Claude spawn gate, smoke scripts, background `delegate_agent` | Opus | medium | Codex, mock, plan tools |
| `escalate_to_team` and the chain continuation in `runManager.ts` | Opus | medium | nothing else in `runManager.ts` |
| Root prompt paragraphs and the prompt diet (wording changes behaviour) | Opus | medium | adapters |
| Reviewer pass: team files gate, spend ceilings, triage input handling | Opus | high | the next package |
| Phase 0 metrics; Codex spawn parameters; mock; `readySteps`, ready lines and the nudge; `staffingProfile.ts`; team files | Sonnet | medium | each other |
| Renderer, TUI, CLI flags, usage; lab arms and comparison scripts | Sonnet | medium | each other |
| e2e selectors, fixtures, agent notes, ARCHITECTURE.md, mechanical renames | Haiku | low | everything |

A package that fails its gate once is retried one step up (Haiku to Sonnet, Sonnet to Opus, or one effort level).

## 10. Risks and open items

- The evidence is small: one run per arm for 1.1 and 1.3, and a forced team. Phase 0 exists to replace it.
- A wrong `solo` on a large task is bounded by `escalate_to_team`; measured as escalations per 100 solo runs.
- An under-powered pick that fails and retries can cost more than starting higher. The profile learns this; until
  it has data the rubric keeps implementation on everyday / medium.
- More parallel writers mean more merge conflicts. `paths` and the overlap warning are the mitigation; conflicts per
  run are measured.
- Parallel fan-out against a subscription or a rate-limited key can stall. The width rule in 4.2 is the mitigation;
  it is untested against a real limit.
- Unverified until the Phase 2 smoke scripts: a full model id through `updatedInput.model` (typed as four aliases;
  the plan guard already relies on it), per-spawn effort through `updatedInput`, several foreground spawns in one
  message running together.
- Codex effort stops at high in OrgAI. The lab drivers sent xhigh at the protocol level and it was applied, so the
  limit is OrgAI's; lifting it is a small follow-up and automatic staffing does not need it.
- The solo assistant holds the union of every role's tools and grants, as the single assistant does today. A
  project that keeps a dangerous tool on one narrow role should set `Project.staffing` to `fixed` or pick the whole
  team; the Team tab says so beside the Automatic choice.
- The triage call sends the task text to the fast-tier model of the run's own connection and nowhere else. Its
  answer is one of two words; anything else means `team`.
- Tier changes between spawns do not share a prompt cache; the profile's cost medians show whether mixed tiers on
  small steps save anything on a given connection.
- Stored role prompts that say "delegate everything" still win over the three-sizes paragraph. A Team review
  recommendation to relax them is a follow-up, not part of this spec.
