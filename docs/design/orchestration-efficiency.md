# Orchestration efficiency: adaptive staffing and parallel execution

Status: executed, 2026-11-10 (design at draft 5). Decisions settled 2026-11-09: the owner accepted every
recommendation in section 6 ("i agree with all your recomendations") and asked for execution. Phases 0 to 6 are
done on `feat/orchestration-efficiency` (section 8); phase 3 closed without new mechanics. Phase 0 (measure)
changed the plan twice: the unforced baseline looked near native, so the ranking was redone (1.5) and the automatic
one-assistant shape was dropped (4.1); the second campaign (1.1a) then showed that the near-parity was an effort
mismatch, that Codex's own sub-agent rule stops the lead from delegating at all, and that the Claude adapter's lead
delegates unprompted. The phase 1 rerun (1.1b) found two defects outside the plan that decided the mandated arm on
Claude (a report's text lost on SDK 0.3.318; a second permission check on every spawn the harness rewrites); both
are fixed. The phase 6 comparison (1.1c, standing in section 7): a mandated team now completes in every run on
both adapters, at a fifth of its earlier cost on Claude; a lead that keeps the work is at or near native on Codex
and ahead of native on Claude from medium tasks up; not reached are a split that beats native, the mandated
targets on a one-minute task, and the tail target. D5 (review by risk) was narrowed at the gate and widened back by the owner afterwards, without a lab rerun (section 6).

Base: `origin/dev` at `aad24c38` (PR #41, required delegation). Every code fact below was read from that commit with
`git show`, not from the local `dev` checkout, which is 310 commits behind it and lacks the delegation runtime.

Goal: a work run costs and takes about what a native Claude Code or Codex session would for the same task, beats it
where the task can be split, and stops paying 2x when a project mandates its team. Today each role's model and effort
are fixed when the org chart is written, a mandated team runs one agent after another, and a lead left to itself
uses no team at all. This spec makes four things a per-run decision, taken from what the project is and what this
run asks for:

1. **how many agents** work on it (the lead alone, a fan-out of reports, or a pipeline),
2. **what runs at the same time** (everything that can),
3. **which tier** each assignment runs on (Haiku / Sonnet / Opus on Anthropic, the connection's tiers elsewhere),
4. **how much effort** each assignment gets.

## 1. Evidence

Source: `~/orca/projects/orgai-performance-lab` (reports, run event logs and driver scripts). The baselines (1.1,
1.1a) are Codex-adapter runs; the first Claude-adapter trials were void (1.1a) and the valid ones are in 1.1b.
Costs are retail-equivalent.

### 1.1 Baseline: OrgAI with nothing forced (`baseline-20261110T051332Z`)

OrgAI at `aad24c38`, the default chart (`defaultRoles`: orchestrator on Sol, implementer and reviewer on Terra,
researcher on Luna), no required reports, no scripted prompt, product defaults. Three runs per cell, medians; the
dashboard has one run per OrgAI arm and its native cells are the earlier pilot's single runs. Every run passed every
check (40 hidden tests, 58 hidden tests, 26 browser checks).

| Task | Codex (Sol, medium) | Claude Code (Opus, medium) | OrgAI team, unforced | OrgAI single assistant |
|---|---|---|---|---|
| Ledger repair | 55.8 s, $0.045 | 42.4 s, $0.167 | 58.1 s, $0.085 | 47.3 s, $0.069 |
| Inventory service | 138.5 s, $0.120 | 207.2 s, $0.850 | 97.7 s, $0.116 | 93.4 s, $0.093 |
| Dashboard from scratch | 455.9 s, $0.332 | 521.4 s, $1.817 | 512.0 s, $0.394 | 580.0 s, $0.409 |

- **The lead never delegated.** In all seven unforced team runs the orchestrator did the whole task itself on Sol,
  in one turn, with a plan and no nudge: no report was spawned, although its role prompt says "Delegate
  implementation, review and testing to your specialist reports". (The ledger task text says not to delegate
  unless a team is configured; the other two say nothing about it.)
- **Unforced OrgAI is not 2x slower.** Against native Codex it took 0.7x to 1.1x the time at 1.0x to 1.9x the cost.
  The 2x of the pilots (1.2) is the price of a mandated pipeline, not of the harness.
- **Effort is confounded.** The Codex adapter sends an effort only when a role sets low, medium or high. The default
  chart sets none, and Codex then ran every call at `low` (relay metering; Codex's catalog default is low for Sol
  and Terra, medium for Luna), against medium for the native Codex arm. The time ratios here flatter OrgAI; 1.1a
  has the effort-matched numbers. What this does establish: low effort passed every check on all three tasks.
- **A team root working alone costs little more than the single assistant**: 1.23x the time on the ledger, 1.05x
  on the inventory, 0.88x on the dashboard. On the small task the difference is the plan tools' round trips (7
  requests against 6) and the 1.5 s continuation wait.
- **Input per call**: Codex 15.4k tokens, single assistant 19.1k, team root 23.4k (ledger medians). The first call
  carries 7.4k more than native Codex for the team root and 3.5k for the single assistant, which matches the
  token-free measurement in 4.6.
- **Run end**: 66 to 76 ms from the last model response to `finished` for the single assistant, about 1,575 ms for
  the team root (the continuation wait; since removed for runs without reports, 4.6).
- The run title is one more call per run. On Codex it carries 10.9k input tokens, Codex's own base prompt. In the
  lab it ran on Sol because the driver passed no fast model; in the app it goes to the fast tier.
- Nothing was learned about worktrees: with isolation on, no writer was spawned.

### 1.1a Effort-matched and mandated arms (`baseline2-20261110T062055Z`)

Same build (`aad24c38`), tasks and graders. `orgai-adaptive-medium` is the unforced team with the root's effort set
to medium; `orgai-required` is the default chart with required reports for implementer and reviewer and nothing
scripted. Medians of three (the dashboard: one run); every run passed its grader.

| Task | Codex (Sol, medium) | OrgAI unforced, medium | OrgAI required reports |
|---|---|---|---|
| Ledger repair | 55.8 s, $0.045 | 70.9 s, $0.088 (1.27x, 1.95x) | 75.7 s, $0.092 |
| Inventory service | 138.5 s, $0.120 | 180.2 s, $0.134 (1.30x, 1.12x) | 113.6 s, $0.113 |
| Dashboard from scratch | 455.9 s, $0.332 | 651.6 s, $0.437 (1.43x, 1.32x) | 638.3 s, $0.440 |

- **At the same effort OrgAI's lead, working alone, takes 1.27x to 1.43x native Codex's time.** The near-parity of
  1.1 was the low effort. This is the harness's own overhead on Codex before phase 1 (the continuation wait, the
  plan round trips, 8k to 12k more input tokens per call).
- **On Codex the lead does not delegate because Codex tells it not to.** Codex 0.167 offers its own multi-agent
  tools beside OrgAI's `spawn_report` and adds a `<multi_agent_mode>` developer message: "Do not spawn sub-agents
  unless the user or applicable AGENTS.md/skill instructions explicitly ask for sub-agents, delegation, or parallel
  agent work." The leads cite it. No unforced run delegated in either campaign, and with required reports 5 of 7
  runs still refused after the harness's correction and ended `delegation-incomplete`; the two that complied did
  the work themselves first and then spawned both reports together. The pilots of 1.2 delegated only because
  their task text asked for it. The tools and the rule come from Codex's model catalog (`multi_agent_version: v2`);
  no feature flag removes them, a `model_catalog_json` override does (checked at a local stub, zero spend).
- **So a mandated team on the default chart is not a pipeline on Codex today, it is a refusal.** The required arm's
  times are a lead working alone at low effort; they are not a baseline for a parallel pipeline.
- The single assistant could not be run at medium effort: nothing in the product sets its effort.
- Input per call: orchestrator 23.4k to 27.5k tokens (first call about 19k to 20k), a report 21k to 23k (first call
  about 13k), native Codex 15.4k to 16.3k (first call 11.6k to 12.5k).
- **Claude adapter.** A headless driver now runs OrgAI's Claude adapter through a proxy connection. Its first seven
  trials are void: the driver's permission settings (`dontAsk`, an empty protected-path list) made the harness
  refuse every edit and shell command, so each run ended `blocked` with the workspace untouched. One thing they
  do show, because it happens before any edit: **on Claude the lead delegates unprompted**, one implementer in
  every unforced run, where the Codex lead never does. Its cost is unmeasured until the corrected rerun (phase 1
  gate).
- Worktrees: still unmeasured; the isolated arm did not delegate.

### 1.1b Phase 1 rerun (`phase1-20261110T073250Z`)

BASE is `aad24c38`, P1 is the phase 1 commit `01ff15fc` (prompts and fixed overhead only: no per-spawn staffing, no
plan graph, Codex's native tools still on). 17 trials, all passed their graders; $12.78 of a $15 cap, so the
Claude-adapter inventory cells have one run per build and the Claude inventory-required cell was not run. The
Claude driver was corrected (permission mode `auto`, the product's protected paths).

Claude adapter (root Opus, reports Sonnet, medium effort), against native Claude Code (ledger 42.4 s $0.167,
inventory 207.2 s $0.850):

| Task, arm | BASE | P1 | P1 / BASE (time, cost) | P1 against Claude Code |
|---|---|---|---|---|
| Ledger, unforced (3 runs each) | 84.8 s, $0.857 | 54.7 s, $0.238 | 0.65x, 0.28x | 1.29x, 1.43x |
| Inventory, unforced (1 run each) | 434.7 s, $1.908 | 196.6 s, $1.464 | 0.45x, 0.77x | 0.95x, 1.72x |
| Ledger, required reports (1 run each) | 150.9 s, $2.120 | 128.2 s, $2.060 | 0.85x, 0.97x | 3.02x, 12.3x |

Codex adapter at medium effort, P1 only (3 / 3 / 1 runs), against native Codex and against `baseline2`:

| Task | P1 | Against native Codex | Against `baseline2` |
|---|---|---|---|
| Ledger | 66.6 s, $0.113 | 1.19x, 2.52x | 0.94x, 1.29x |
| Inventory | 148.8 s, $0.136 | 1.07x, 1.13x | 0.83x, 1.01x |
| Dashboard | 706.9 s, $0.535 | 1.55x, 1.61x | 1.08x, 1.22x |

- **On Claude the sizing rule works.** At BASE the lead delegated in all four unforced runs (an implementer, in two
  of them a reviewer as well); at P1 it did the ledger itself in all three runs and on the inventory spawned one
  reviewer only. That is where the 0.65x and 0.28x come from.
- **On Codex the lead still never delegates**, as expected before the native tools are switched off (phase 2). The
  ledger's remaining gap to native is two more requests (7 against 5, about +22 s) partly bought back by faster
  ones; the inventory is at parity; the dashboard, which splits, is 1.55x because nothing was split. Ledger cost
  ranges from $0.078 to $0.118 over three runs, so its cost ratio is noisy.
- **Fixed overhead.** Run end: 0.06 to 0.08 s on Codex and 0.13 to 0.18 s on Claude (1.64 to 1.68 s at BASE).
  First-call input of a team root: 16.5k to 17.8k tokens on Codex (19.0k to 20.2k in `baseline2`; native 11.6k to
  12.5k, so about 5k above native against a target of 4k) and 19.9k on Claude (23.4k at BASE); a Claude report 7.8k
  to 8.8k (9.1k to 11.3k).
- **Plan calls.** On Codex a response that touches only the plan is now rare (0 or 1 per run, none in the
  dashboard's 23). On Claude it still happens once or twice per run on both builds: the batching sentence did not
  change it there.
- **A mandated team on Claude never completes, and the cause is not the prompt.** Both builds spawned implementer
  and reviewer, were told that both "returned a failed or empty report", spawned both again (at P1 the second pair
  ran together) and ended `delegation-incomplete` with 40 of 40 hidden tests passing. On SDK 0.3.318 a report ends
  by calling the built-in `SubagentHandback` tool, so `SubagentStop.last_assistant_message`, the only place the
  adapter reads a report from, is empty: every receipt has `reportChars` 0, every report's `result` is empty in the
  run view, and nothing can count as a first pass in the profile (4.5). Present on the base commit too. Fixed in
  the adapter (4.6).
- **Every spawn on Claude pays for a second safety check, and in the lab it ran on the root's model.** Under
  `auto` (the product default) each `Agent` call was followed by one request with no tools, 48.8k to 57.2k input
  tokens, on Opus: $0.38 to $0.46 and 1 to 2.5 s per spawn, $1.56 of the $2.06 mandated run. The cause is OrgAI's
  own spawn hook: the API already returns a verdict on the `Agent` call inside the model's response, and when the
  hook changes the call (a generated name, a worktree, a model, an effort) Claude Code discards that verdict and
  asks again itself. The 48k tokens are the check's own system prompt. Its model is the server's choice on a
  first-party login (Sonnet 5), then `CLAUDE_CODE_AUTO_MODE_MODEL`, then the Sonnet alias, then the root's model;
  the lab relay rejects Sonnet 5, so it fell through to Opus there. The request is missing from `modelUsage` and
  `total_cost_usd`, so OrgAI's own cost figures do not show it (`docs/agent-notes/permissions.md`, 4.6).
- **The self-control gate refused 1 to 3 shell commands per run** in 7 of the 10 Claude-adapter trials on both
  builds: "could not check" on long `python3 -c` one-liners, and twice "may not invoke the OrgAI CLI" on one-liners
  that touch no OrgAI path. Each costs a round trip. It fails closed by design and is not changed here (section 10).
- Effort: every root, report and title call on Claude carried medium on both builds.

### 1.1c Phase 6 comparison (`phase2-20261110T093906Z`, reruns `phase2d-20261110T105108Z` and `phase2e-20261110T113308Z`)

Builds: P2 is `377d4e55` (phases 1, 2, 4 and 5 with the two fixes of 1.1b); P2c is `26241714` (P2 plus the Codex
start fix below); P2d (`40f7fc67`) and P2e (`69e8602e`) each reword the sizing rule once (below). The main campaign
ran the Claude-adapter cells on P2 and the Codex-adapter cells on P2c: 23 trials, every one passed its hidden
tests, $7.85. A fourth task joined the lab for the split target: "freight", four modules behind a fixed contract,
41 hidden tests. Everything ran at medium effort; the root is Opus on Claude and the deep tier on Codex, reports
are Sonnet and the everyday tier.

Native references: Claude Code ledger 42.4 s $0.167, inventory 207.2 s $0.850, modules 83.5 s $0.376; Codex ledger
55.8 s $0.045, inventory 138.5 s $0.120, dashboard 455.9 s $0.332, modules 109.9 s $0.074.

| Claude adapter, P2 (runs) | Median | Against Claude Code (time, cost) | What ran |
|---|---|---|---|
| Ledger, unforced (3) | 52.2 s, $0.238 | 1.23x, 1.43x | the lead alone, 3 of 3 |
| Inventory, unforced (2) | 142.5 s, $0.641 | 0.69x, 0.75x | the lead alone, 2 of 2 |
| Modules, unforced (1) | 72.8 s, $0.370 | 0.87x, 0.99x | the lead alone |
| Ledger, required reports (2) | 91.6 s, $0.435 | 2.16x, 2.60x | completed; implementer then reviewer, once each |
| Inventory, required reports (1) | 263.1 s, $0.889 | 1.27x, 1.05x | completed; implementer then reviewer, once each |

| Codex adapter, P2c (runs) | Median | Against native Codex (time, cost) | What ran |
|---|---|---|---|
| Ledger, unforced (3) | 61.1 s, $0.077 | 1.09x, 1.72x | the lead alone, 3 of 3 |
| Inventory, unforced (3) | 275.3 s, $0.369 | 1.99x, 3.09x | an implementer and a reviewer in 3 of 3 |
| Dashboard, unforced (1) | 814.1 s, $0.729 | 1.79x, 2.20x | an implementer on a slice, then a reviewer |
| Modules, unforced (1) | 146.2 s, $0.166 | 1.33x, 2.25x | one implementer for all four modules |
| Ledger, required reports (2) | 94.4 s, $0.138 | 1.69x, 3.07x | completed |
| Inventory, required reports (1) | 198.4 s, $0.243 | 1.43x, 2.03x | completed |
| Dashboard, required reports (1) | 703.6 s, $0.579 | 1.54x, 1.74x | completed |

- **A mandated team now completes.** All 7 mandated runs ended `completed` with every required receipt valid
  (2 of 7 at baseline on Codex, none on Claude before the report-text fix). On Claude each receipt carries the
  report's text (2.1k to 3.5k characters), the pair ran once, each run's log ends "Spawns: 2, rewritten by the
  harness: 0" and no second check request was sent. The mandated ledger on Claude went from 128.2 s and $2.06 at P1
  to 91.6 s and $0.435 (0.71x, 0.21x).
- **A small mandated task stays above the target.** Two reports cost a fixed 40 to 50 s (start, read the brief
  and the code, report back) on a task the lead finishes alone in 50 to 60 s: ledger 2.16x / 2.60x on Claude,
  1.69x / 3.07x on Codex. The ratio falls as the task grows: inventory 1.27x / 1.05x on Claude and 1.43x / 2.03x
  on Codex, dashboard 1.54x / 1.74x on Codex.
- **The tail target is missed in every mandated run** (37% to 89% of the run comes after the first wave of
  reports). On the chart tested the reviewer needs the implementer's result, so the two required reports cannot
  overlap and the review is always tail. On the dashboard the number says something else: the implementer got a
  55 s slice (filters, export, the dialog), the lead built the rest itself and sent the reviewer at 463 s, so most
  of the "tail" is the lead's own building.
- **On Claude the lead works alone when nothing forces a team** (6 of 6), and that is faster and cheaper than
  Claude Code on the two larger tasks. The ledger stays at 1.23x and 1.43x: about 10 s more, and 11 to 13
  requests against 6. One to four of them per run follow a shell command refused by the self-control gate (the
  false refusals of 1.1b), each a wasted round trip; no report was spawned and no second check was sent.
- **No parallel fan-out on Claude.** The lead never split, including on the module task, where doing all four
  modules alone took 72.8 s against 83.5 s native. The overlap target was not exercised there.
- **On Codex, switching off the native tools exposed a different lead.** With Codex's own "do not spawn
  sub-agents" rule gone the lead still does the ledger alone, but on the inventory it handed out work in 3 of 3
  runs: it made the fix itself and at the same time gave an implementer "focused regression tests" for that fix,
  then sent a reviewer because work had been handed out, then went round again on the findings. 1.99x the time and
  3.09x the cost of native, where P1 was at 1.07x and 1.13x with the lead alone. The module task went to one
  implementer while the lead waited (the case the sizing rule names as slower than doing it alone).
- **Starting several Codex app-servers at once could silently undo the native-tools switch.** All app-servers of
  a run share one `CODEX_HOME`, and concurrent starts race on Codex's sqlite state ("failed to initialize sqlite
  state runtime"). OrgAI treated any failed start as "this Codex rejects the catalog override", dropped the
  override for the whole process and deleted the catalog file another server had been launched with. In the lab's
  stub the override was lost in 14 of 15 runs and 7 failed. Fixed in P2c: one start at a time per home (a lock
  with a 60 s ceiling), a failed start no longer deletes the file, and the override is only given up for the
  process when a start without it works and the error names the catalog. After the fix: 15 of 15 kept the
  override, no start errors, start time 293 ms against 297 ms serialized. Every Codex run in the campaign had the
  override active.
- **Fixed overhead.** Codex: a team root's first call is 15.4k to 16.7k input tokens, 3.9k above native (target
  4k); a report's is 10.5k to 11.1k, below a native session's; a run ends 70 to 90 ms after its last response.
  Claude: root first call 20.9k to 22.5k, a report 7.7k to 10.0k, run end 150 to 190 ms (target 150). A response
  that touches only the plan still happens about once per run on both adapters.

**The two rewording passes.** The Codex inventory result was traced to the sizing paragraph, which opened with the
split test and listed tests and review as things to run beside the work: a lead that had decided to keep the work
still found "pieces" to hand out. P2d put the decision in order (the sizing rule decides first; work kept is done
alone; the parallel, contract and review sentences apply to handed-out work) and limited review by risk to
handed-out work. P2e made the split test apply to "what the brief asks for", added "Tests and checks of your own
work are part of it, never pieces to hand out", and changed the team listing from "Delegate to them with the Agent
tool" to "To hand work out, use the Agent tool" (required reports keep their unconditional line). Each pass was
rerun once on a subset (12 trials, $3.89; then 11 trials, $2.98; every trial passed its hidden tests):

| Cell (runs on P2 or P2c; the reruns have 1 unless noted) | P2 / P2c | P2d | P2e |
|---|---|---|---|
| Codex inventory, unforced (3, 3, 3) | 275.3 s, $0.369; handed out in 3 of 3 | 214.0 s, $0.276; handed out in 3 of 3, reviewer in 2 | 153.9 s, $0.125; alone in 2 of 3 |
| Codex ledger, unforced (3) | 61.1 s, $0.077 | 67.0 s, $0.081 | 60.3 s, $0.079 |
| Codex dashboard, unforced | 814.1 s, $0.729 | 521.7 s, $0.518 | 686.2 s, $0.559 |
| Codex modules, unforced | 146.2 s, $0.166; one implementer does all four | 117.8 s, $0.221; three implementers together | 128.4 s, $0.149; the lead and one implementer side by side |
| Codex ledger, required (2) | 94.4 s, $0.138 | 90.8 s, $0.130 | 98.1 s, $0.113 |
| Codex inventory, required | 198.4 s, $0.243 | 308.4 s, $0.384 | 239.5 s, $0.260 |
| Claude ledger, required (2) | 91.6 s, $0.435 | 103.1 s, $0.423 | 95.8 s, $0.404 |
| Claude ledger, unforced (3) | 52.2 s, $0.238 | 51.8 s, $0.247 | 68.8 s, $0.319 |
| Claude inventory, unforced (2) | 142.5 s, $0.641 | 178.6 s, $0.787 | 155.3 s, $0.698 |
| Claude modules, unforced | 72.8 s, $0.370 | 65.2 s, $0.336 | not run (budget guard) |

- **The Codex inventory is back to the lead's own work**: on P2e the median is 1.11x the time and 1.05x the cost
  of native (P1, with the lead alone: 1.07x and 1.13x). Two of the three runs had no report. In the third the lead
  gave an implementer one slice of the fix (validation) and worked beside it for 32 s. No run on P2e handed out
  tests of the lead's own change, and none called a reviewer.
- **Nothing else moved outside its run-to-run spread.** Claude stayed alone in every unforced run on every build,
  and every mandated run on every build completed with valid receipts and, on Claude, no rewritten spawn. The slow
  Claude ledger run on P2e (68.8 s) is seven self-control gate refusals in one run, not a report.
- **Splitting is not settled.** On the module task the Codex lead used one implementer for everything, then three
  at once (117.8 s, 1.07x native, overlap 2.61, the only run in the comparison with reports overlapping that
  much), then one beside itself; on the dashboard an implementer got a slice each time and the run took 814, 522
  and 686 s against 456 s native. No split run reached the native time.
- **Findings going back through the reports is the slow path.** On the mandated Codex inventory the reviewer ran
  once on P2c (198 s), three times with a second implementer on P2d (308 s) and twice on P2e (240 s).

Lab spend for the comparison: $14.73 of a $20 cap (7.85 + 3.89 + 2.98).

### 1.2 Pilots: the team mandated (`native-vs-orgai-pilot-20261109`, `complex-pilot-20261109T092758Z`, `dashboard-pilot-20261109T173008Z`)

One run per arm, OrgAI at `7a988037`. The drivers (`.tmp/*-orgai-pilot.mjs`) set `requiredReports` to every report,
`strictDelegation: true`, a lead prompt that scripts the sequence ("Spawn engineer once to implement and test. After
its report, spawn reviewer once ... inspect the final diff, repair findings, and run tests before ending") and a task
suffix "Delegate and require both reports", with `isolateWriters: false`, `autoContinue: false`,
`continuationDelayMs: 0`, at most 2 or 3 concurrent reports and a relay limit of 3 requests in flight. Effort was
injected by the driver at the protocol level.

| Task | Codex (Sol, medium) | Claude Code (Opus, medium) | OrgAI, team mandated | Time vs Codex / Claude Code | Cost vs Codex / Claude Code |
|---|---|---|---|---|---|
| Ledger repair | 53 s, $0.040 | 38 s, $0.138 | 132 s, $0.359, 20 calls | 2.5x / 3.5x | 9.0x / 2.6x |
| Inventory service | 171 s, $0.107 | 201 s, $0.832 | 497 s, $0.194 | 2.9x / 2.5x | 1.8x / 0.23x |
| Dashboard from scratch | 456 s, $0.332 | 521 s, $1.82 | 1093 s, $0.562 | 2.4x / 2.1x | 1.7x / 0.31x |

Teams: ledger = lead Sol, engineer Opus, reviewer Sol, all medium. Inventory = lead Sol medium, engineer and
reviewer Luna xhigh. Dashboard = lead Sol xhigh, data / frontend / qa Luna medium. Every arm passed every task; on
the dashboard all three scored 26 of 26 after the grader's audit, and one non-blind visual review ranked OrgAI last
(Claude Code 21, Codex 20, OrgAI 19 of 25). The mandated team bought no measured quality. The dashboard run also
ended `delegation-incomplete` (three native `send_message` attempts were interrupted).

Put beside 1.1: the same harness, on the same tasks, takes 58 / 98 / 512 s when the lead works alone and 132 / 497
/ 1093 s when the pipeline is mandated. A project that mandates its team (required reports, strict delegation, or a
role prompt that insists) paid 2.1x to 5.1x for it in these pilots (other teams and efforts than the default chart,
so indicative). `baseline2` reruns this on the default chart with required
reports and nothing scripted.

### 1.3 Where the seconds went in the mandated runs

Derived from each pilot run's `orgai/events.jsonl`, seconds from run start.

| Phase | Ledger (131 s) | Inventory (496 s) | Dashboard (1091 s) |
|---|---|---|---|
| Lead plans before the first spawn | 0 to 16 | 0 to 20 | 0 to 54 |
| Implementation | engineer 16 to 52 (36 s) | engineer 20 to 328 (308 s) | data 54 to 198 (144 s) beside frontend 54 to 476 (422 s) |
| Lead between reports | 52 to 62 | 328 to 340 | integrates 476 to 604 (128 s) |
| Review or QA | reviewer 62 to 110 (48 s) | reviewer 340 to 481 (141 s) | qa 604 to 873 (269 s) |
| Lead finishes | 110 to 131 (21 s) | 481 to 496 (15 s) | fixes and verifies 873 to 1091 (219 s) |
| **Time after the implementation existed** | **79 s, 60%** | **168 s, 34%** | **615 s, 56%** |
| Lead active in total | 63 s, 48% | 75 s, 15% | 544 s, 50% |

- Ledger: the implementation was complete at 52 s, inside the native range. The pipeline after it is the slow part.
- Inventory: the engineer alone, on Luna at xhigh, took 308 s; the unforced lead did the whole task on Sol at low in
  98 s. The cheap tier at high effort sat on the only path there was.
- Dashboard: the two builders ran together, but one took 144 s and the other 422 s, so the split saved nothing. QA
  was written and run only after the build, and the lead (xhigh) was active for half the run.

### 1.4 Shape, model and effort inside OrgAI (earlier screens)

| Comparison (report) | Result |
|---|---|
| Solo against a hierarchy, 3 tasks, 9 trials (`team-benefit-20261109T043231Z`) | Solo Sol: median 33.5 s, $0.209 for three, 3 of 3. Solo Luna medium: 38.1 s, $0.013, 3 of 3. Five-agent hierarchy: 96.8 s, $0.323 (usage incomplete), 2 of 3. |
| Team size, one episode (`scenario-screen-20261108T190810Z`) | Solo 31 s; pair 38 s; lead and three 49 s; hierarchy 79 s (out of budget); swarm 112 s (out of budget). All answers correct. |
| Effort, same four-agent team (`model-effort-pilot-20261108T182044Z`) | Specialists at medium 53 s; at xhigh 74 s; lead at xhigh too 84 s. All correct. |

### 1.5 What follows (ranking redone at the Phase 0 gate, amended after `baseline2`)

The first ranking put a solo shape near the top. The baselines remove it, and they split the problem by adapter:
on Codex the lead never delegates and pays a fixed overhead of about 30% at equal effort; on Claude the lead
delegates whether or not it pays; and a pipeline that is made to run, runs one agent after another.

1. **A mandated pipeline runs one agent after another and spends a third to more than half of the run after the
   work exists** (1.3). This is where the 2x is. It is addressed by running everything that can run together (4.2),
   reviewing by risk and verifying once (4.4), and it applies to every project that requires reports.
2. **The critical path is staffed without regard to time.** A slow tier or a high effort on the longest step sets
   the run's length; xhigh added 40 to 60% with no change in correctness, and low passed everything in the baseline.
   Addressed by staffing each assignment (4.3).
3. **Delegation happens for the wrong reason on both adapters.** On Codex the lead never delegates, because
   Codex's own rule forbids it (1.1a): work that splits gets no speedup (the dashboard took the lone lead 512 s at
   low effort and 652 s at medium, against 456 s native), and required reports are refused. On Claude the lead
   delegates a contained task to one report and waits. When delegation does happen it is cut badly (144 s against
   422 s). Addressed by removing Codex's native tools and rule at launch (4.2), the sizing rule (4.1) and the plan
   graph with ready lines (4.2). The goal is delegation exactly when it pays.
4. **A team root's fixed overhead**: 1.27x to 1.43x native Codex's time at equal effort with the lead alone (1.1a).
   The plan tools' round trips, the continuation wait (fixed), and 8k to 12k more input tokens on every call, most
   of it tool definitions (4.6). It is also the 1.9x cost on the ledger.
5. **Not built: a separate one-assistant shape chosen automatically.** A team root working alone is already within
   1.05x to 1.23x of the single assistant, and item 4 closes most of what is left. Triage, `soloRunProject` and
   `escalate_to_team` are dropped; the single assistant stays what it is, the user's explicit choice.

After the phase 1 rerun (1.1b): phase 1 took the Codex lead from 1.27x and 1.30x to 1.19x and 1.07x of native on
the two contained tasks and left the task that splits where it was; on Claude it stopped the needless delegation.
Not established yet: a mandated pipeline that actually runs on the default chart on either adapter (Codex needs the
native tools off, Claude needs the report text, both built since), whether the lead now splits work that splits,
and the cost of worktree isolation. These are the phase 6 comparison.

After the phase 6 comparison (1.1c): the mandated pipeline runs and completes on the default chart on both
adapters, and on Claude it costs a fifth of what it did; a lead that keeps contained work to itself is at or near
native on Codex and ahead of native on Claude from the inventory's size upward; the lead does not yet split work
that splits in a way that beats native, and a mandated team on a one-minute task still costs about twice the
native run. Worktree isolation was not measured.

## 2. Current behaviour (origin/dev, read 2026-11-09)

- **Model and effort are per role and fixed.** `Role.tier`, `Role.model`, `Role.effort` (`src/shared/types.ts`).
  Claude: `claude.ts` `buildAgents` writes one `AgentDefinition` per role with `model` and `effort`, and at
  `aad24c38` that was the only place the adapter set effort. Codex: `threadParams` takes `role.model`; effort is sent per message and only
  for low / medium / high (`effortOptionsFor`), so a Codex role set to xhigh sends none.
- **The root's effort was not applied on Claude** (fixed in phase 1, `a0d19efc`: `sessionEffort` / `reportEffort`
  in `claude.ts`). The root runs as `agent: root.slug`, and the SDK does not
  apply an `AgentDefinition.effort` to the agent chosen by `Options.agent`: a root defined with `low` ran at the
  default, `medium` (smoke check 5). The orchestrator's effort setting in the chart therefore did nothing on this
  adapter. `Options.effort` does set it (check 8), and a report with no effort of its own then inherits it, so the
  fix gives such a report the default explicitly.
- **One per-spawn override exists**: the plan guard. `claude.ts` `steerToEveryday` rewrites a spawn's `model` through
  the PreToolUse `updatedInput` with the connection's everyday model id. The SDK accepts only the four aliases
  there (below), so the steer works while that id is `sonnet`, the Anthropic default, and fails the spawn with a
  schema error when the tier is mapped to a full model id.
- **The SDK accepts both per spawn** (`scripts/smoke-staffing.mjs`, 0.3.318, recorded in
  `docs/agent-notes/sdk-facts.md`). Through `updatedInput`: `model` as one of `sonnet | opus | haiku | fable` works
  and a full id such as `claude-sonnet-5-5` is rejected by schema validation, no subagent starts and the model
  retries into the same error; `effort` works and overrides the definition's. Both also work when the model sets
  them on the call itself, which the tool's description tells it to do only when instructed.
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
  message. Two foreground spawns in one assistant message do run together (smoke check 6: starts at 1.3 and 1.6 s,
  stops at 8.9 and 9.2 s), but the model put both calls in one message only when told to emphatically.
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

**The team is sized inside the run, by the lead.** A harness paragraph for the root, additive to its role prompt
and yielding to it ("unless your instructions, the brief or required reports say otherwise"):

- Do the work yourself when it is one contained piece and you hold the tools. This is what the lead does today on
  every task, and on small and medium work it is the fastest shape there is (1.1).
- Hand work out when it splits into independent pieces that are each worth more than a couple of minutes of an
  agent's time, when a piece needs a role's tools, skills or connections that you lack, or when a rule demands it.
  Then start every piece in one message (4.2). Splitting pays only when the longest piece is clearly shorter than
  the whole; a lone report doing the entire task while you wait is slower than doing it yourself and is right only
  under the `cost` goal, on a cheaper tier.
- Ask for review by risk, not by habit (4.4).

As built after phase 6 (1.1c) the paragraph reads in decision order. The sizing sentence comes first and decides
whether anything goes out at all; the split test applies to "what the brief asks for"; "Tests and checks of your
own work are part of it, never pieces to hand out"; the parallel, contract and review sentences then speak only of
handed-out work, and the staffing instruction opens "give each step you hand out (the rule above decides if any)".
The team listing says how to hand work out ("To hand work out, use the Agent tool, passing subagent_type exactly
as written") where it used to say "Delegate to them"; a role with required reports keeps its unconditional "You
must delegate to ..." line. The earlier order, split test first with tests and review listed as things to run
beside the work, made the Codex lead hand out tests of its own change on a task it had decided to keep.

`defaultRoles` and the Architect guidance in `setup.ts` get the same wording for new projects, in place of "Delegate
implementation, review and testing to your specialist reports instead of doing everything yourself"; stored charts
keep their text.

**Not built: choosing one assistant before the session.** Drafts 1 and 2 had a `triage.ts` that picked `solo` or
`team` up front, a `soloRunProject` builder and an `escalate_to_team` tool. Phase 0 measured both halves of the
case for it and neither holds: the unforced team root already works alone and is within 1.05x to 1.23x of the
single assistant (1.1), and the one-shot classifier it needed takes 2.1 / 2.5 / 3.3 s (min / median / max of five
haiku calls with `RuntimeAdapter.complete`'s options, 1.2 s of it starting the process; smoke check 7), above the
1.5 s line decision D3 set. `RunTeam 'single'` stays as it is, chosen by the user.

### 4.2 Parallel by default

The orchestrator gets the ability (rules that tell it to), the capability (mechanics that make it possible on every
path) and the feedback (the harness says what is ready and what is idle).

**The plan is a graph.** `PlanStep` gains `after?: string[]` (ids it waits for; none means it can start now) and
`paths?: string[]` (files or folders it will change). `readySteps(plan)` is pure: pending steps whose `after` are
all done or skipped.

**The harness says what is ready, at the moment of decision.**
- `set_plan` and `update_plan` end their result with the ready set and the free slots: "Ready now: p2 (implementer),
  p3 (implementer), p5 (researcher). 6 of 8 agent slots are free. Start all of them in this message."
- Not built in phase 2: a report's delivery message naming the steps its completion unblocks. The plan tools'
  ready line and the `ready` nudge already say it at the two moments the root decides; it comes back only if the
  phase 2 rerun shows ready steps idling after a report lands.
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
- Codex: the native multi-agent tools and their "do not spawn sub-agents unless explicitly asked" rule are removed
  at launch with a `model_catalog_json` override written from the installed binary's own catalog (1.1a), failing
  open to today's launch; until it is in effect the Codex prompt says that the project's instructions ask for
  delegation through `spawn_report`. Without this nothing else in this section happens on Codex.
- Bridged roles on Claude: `delegate_agent` gains `background: true`, returning a handle at once with the report
  delivered later as a harness message, as Codex `spawn_report` already does. Required bridged reports keep the
  blocking form.
- Required reports on Claude stay in the foreground (the receipt needs the tool result). Several foreground spawns
  in one message run together (smoke check 6), so nothing moves to the background. The SDK emits one `assistant`
  message per content block; calls that went out together share a `message.id`, which is how the harness counts
  them.
- Width: the ready line states free slots from `effectiveSubagentLimits`. Not built: reporting one free slot after
  a rate-limit or overload event. The plan tools have no such signal to read (the adapters hold it), and a
  rate-limited run already holds its nudges; section 10 keeps the risk.
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
  `resolveStaffing({ role, project, parentTier, requested, profile, tierModels, adapterEfforts, planGuard,
  escalatedFrom })` returns `{ mode, tier, model, effort, source, note, overrides }`. Order: the requested value,
  else the profile's default (4.5), else the role's own tier and effort, so a run in which the orchestrator states
  no pick behaves as today; clamp to the role's bounds (an effort ceiling of `high` when the chart sets none);
  escalation by one step; plan guard; the nearest lower tier the connection has a model for; the nearest effort the
  adapter supports. `source` is 'orchestrator', 'profile', 'role', 'clamped', 'plan-guard' or 'escalated'. The goal
  and the critical path are the orchestrator's to weigh (the rubric) and the profile's (4.5); the resolver does not
  take them. The spawn's result states the tier and effort actually used.
- Mechanics. Claude: the gate sets `model` and `effort` on the spawn through `updatedInput`. The model it writes is
  the resolved tier's alias (top `fable`, deep `opus`, everyday `sonnet`, fast `haiku`), never a model id: the SDK
  rejects ids there. On a proxy connection the alias already resolves to the connection's model for that tier
  through `ANTHROPIC_DEFAULT_*_MODEL` (`connections/service.ts` `buildRunConnection`). The Anthropic connection
  sets no such variable, so there the alias means the SDK's current model of that family, which is what the default
  `tierModels` name; when a tier is mapped to another id the session gets the same variables, and a Phase 2 smoke
  check confirms they apply on a subscription login before that case is switched on (until then such a role keeps
  its definition's model). The plan guard's steer moves to the same path, which fixes its failure on a tier mapped
  to a full id. A `fixed` role on a concrete model keeps its definition's model and gets no `model` at spawn. A
  `fixed` role, and every role of a `fixed` project, runs at its configured model and effort: an alias or an effort
  the orchestrator puts on the spawn call is dropped (it passed through before this work, so a fixed project could
  run a report above its chart), and only the plan guard may change the model. An automatic `inherit` role
  gets its resolved tier's alias when it is spawned by a report. In a nested spawn `inherit` means the spawning
  report's model (`scripts/smoke-staffing.mjs` check 11, one live run); the alias is written anyway, so the row and
  the model do not depend on that. Spawned by the root on the root's own tier it gets none (a root pinned to an
  exact id keeps it). No alias is ever written that
  the connection cannot resolve: on a proxy that maps no model for the tier the definition's model stands. The
  staffing row records what was sent (the model the alias resolves to, else the definition's). The root's effort goes on `Options.effort` when the session is built; because a report without an
  effort would take the CLI's per-model default or a project settings file's value, an automatic role always has
  an explicit effort, never above its ceiling: its definition carries the one an unrequested spawn resolves to (the
  role's own, else medium), and the spawn call is changed only when a pick, the profile or a retry moves it. A call
  that already says what would run is left exactly as written (4.6, the spawn check). Codex:
  `spawn_report` gains optional `tier` and `effort`; the thread starts on the resolved model and each message
  carries the resolved effort. A bridged role keeps its chart's tier and effort in phase 2: its child session is
  built by RunManager on another connection, and a pick would have to cross `bridge.spawn`. Mock implements the
  whole path.
- Bookkeeping shared by the three adapters is `runtime/staffingBook.ts`, pure like the resolver: which plan step a
  spawn belongs to, the tier its parent resolved to (the ceiling of an `inherit` role), and retries. A spawn for a
  step that is still open after its earlier attempt failed is a retry and goes one step up, at most twice per step
  id whatever edits the step's title or role get. After an attempt that ended without failure the next spawn is a
  plain new attempt: raising it is the orchestrator's call, on the spawn or on the step (the review of 2026-11-10
  found that any ended attempt counted, so a report that succeeded on a step not yet marked done raised the next
  one). A spawn while an attempt is live shares the step (fan-out) and its pick. The adapters keep only the
  mechanics.
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
- The root: tier and effort from the chart. On Claude the effort is applied for the first time (section 2).
- Goal: `StaffingGoal = 'balanced' | 'speed' | 'cost'` on the project, overridable per run. `speed` treats every
  step as on the critical path; `cost` treats none as.

### 4.4 Review and verification by risk

- `Project.reviewPolicy?: 'always' | 'risk' | 'never'`, default `risk`. (Not `review`: `teamReview` and
  `reviewMerges` already mean other things.) Under `risk` the root asks for review when a role prompt or the brief
  demands it, the change touches sensitive or security-relevant code, the diff is large, or verification failed
  once. Required reports always win. The policy is one sentence in the root prompt, written with the rubric; there
  is no project list of sensitive paths.
- Verification runs once per integrated result, by a fast-tier "run the checks" step that starts as soon as the
  result lands, beside any review. The lead reads the evidence; it does not re-run it.
- A reviewer's findings go back to the agent that wrote the code (a message to a live report, or one new spawn),
  not to the lead to repair by hand.

After phase 6 the lab builds applied the conditions about the change (sensitive code, a large diff, a failed
verification) to handed-out work only. The owner reversed that on 2026-11-10 (section 6): they apply to any
change. The sentence ends "else verify and finish". The last two bullets above are not built (section 8, phase 3).

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

Measured in Phase 0 (`scripts/measure-prompt-size.mjs`, token-free; the baseline campaign's run logs).

- **Tool definitions first, prompt text second.** On the default chart OrgAI adds about 9.3k tokens (Claude) or
  10.1k (Codex) to every request of a team root, 3.1k to 3.5k to a report's and 4.7k to 5.0k to the single
  assistant's. Harness tool definitions are 77% of the root's share and 80% of a report's; the prompt paragraphs
  the first draft aimed at are the small part. The largest definitions: `produce_output` (6,058 characters, sent to
  every agent, read-only reviewers included) and the root's four configuration tools `propose_mcp_servers`,
  `propose_org_change`, `propose_skills` and `request_mcp_install` (11.6k characters together). The diet:
  - a description says what the tool does and when to call it; the format rules and examples move into the tool's
    validation errors and into the result of a call with no arguments, which the description names;
  - a unit test pins a budget on the summed harness tool definitions for the default chart's root, a report and
    the single assistant, so the size does not grow back unnoticed;
  - then the paragraphs: `mcpInstallText` (1,102 characters on the root), `outputsText` (1,002),
    `orchestratorIsolationText` (720), and a report gets only what a report can act on.
- **Run end.** The 4 s of the earlier pilots does not reproduce. From the last model response to `finished` the
  single assistant takes 66 ms and a team run 1,579 ms, of which 1,500 is `DEFAULT_CONTINUATION_DELAY_MS`
  (`continuation.ts`: "so a report that just landed can wake the orchestrator first"), paid at the end of every
  team root turn that reaches the nudge decision, in a run that had spawned no report. Change: the wait applies
  only when a report is running or ended inside the window; otherwise the decision is taken at once. Exec
  settlement keeps its semantics (`continuation.test.ts`, the settle tests). The Claude adapter's
  `REPORT_HANDBACK_GRACE_MS` (1.5 s after a report finishes) stays; no lab run has measured it.
- **Run start.** OrgAI's own share is about 0.2 s (version probe, app-server start and handshake, thread start).
  The other 1.5 s of the earlier figure was the lab driver loading. Nothing to cut.
- **Plan round trips.** On the ledger the team root made one request more than the single assistant, a turn spent
  on the plan. The root is told to send `set_plan` in the same message as its first working tool calls and
  `complete_plan` with its last, never a turn that only touches the plan. When a plan is required does not change:
  unattended continuation depends on it. The phase 1 rerun (1.1b): Codex batches them (0 or 1 plan-only response
  per run), Claude still spends one or two responses per run on the plan alone.
- **A report's text on Claude (found by the phase 1 rerun).** SDK 0.3.318 reports hand back through the built-in
  `SubagentHandback` tool and `SubagentStop` then carries no last message. The adapter takes the report from the
  handback call, so receipts, the run view's report text and the profile's first-pass count have it again. Without
  this a required report can never be valid and a mandated run repeats every report once and still fails.
- **The spawn check under `auto` (found by the phase 1 rerun).** The API judges an `Agent` call as part of the
  model's response. Claude Code repeats that check locally, with a 48k-token prompt of its own, only when a hook
  hands back a changed call, and OrgAI's spawn hook changed nearly every call: it added a name, a worktree, a
  model and an effort. The check stays and the hook never answers `allow` for a spawn. What changes is that a
  well-formed spawn no longer needs rewriting: the lead is told to write the name, tier, effort, worktree and
  foreground flag itself, role definitions carry their default effort, and the hook returns nothing when the call
  already says what would run. The rewrite remains for a missing value and for a request above a ceiling, and the
  run logs how many spawns were rewritten and why. Setting `CLAUDE_CODE_AUTO_MODE_MODEL` was tried and does not
  help: Claude Code refuses the current Sonnet and Opus ids as the check's model. The more a run fans out, the
  more this matters.
- **Run title.** One more call per run; on Codex it carries Codex's 10.9k-token base prompt. It already goes to
  the fast tier in the app. Left alone.
- Worktrees: not measured yet (no writer was spawned in the baseline); `baseline2` has an isolated arm.

### 4.7 What the user sees

- Run view and TUI: each agent row shows tier and effort with the reason on expand ("everyday / medium: chosen by
  the orchestrator", "fast: capped by the role"). The plan pane shows ready, running and waiting-on for each step;
  the run strip shows how many agents are working now and how many steps are ready.
- CLI: `--goal balanced | speed | cost`. The team choice in the composer and `--team` stay as they are.
- Team tab, role editor: "Tier and effort: Automatic, up to <tier> / <effort>" or "Always <model> / <effort>" (it sits
  in the Model fold, which shows the word "Model" once; `e2e/connections.mjs` checks that).
- Team files: `staffing` on a role, `reviewPolicy` and `staffingGoal` on the project. The gate treats a raised
  ceiling as "May spend more", like a raised effort today; lowering or switching to automatic needs no card.
- Usage: time to first spawn, overlap and tail beside the existing efficiency signals; cost by tier; runs the lead
  did alone against runs with reports. As built, cost by tier is derived from each model's place in the
  connection's tier mapping, because a run's per-agent staffing does not reach the usage overview rows.
- As built, the per-run goal is offered on the New run page and through `--goal`; quick (Chat) runs and
  continuations take the project's goal.

## 5. Contract (a "Run staffing" section in `src/shared/types.ts`)

- `RoleStaffing`, `Role.staffing?`; `ReviewPolicy`, `Project.reviewPolicy?`; `StaffingGoal`,
  `Project.staffingGoal?`; `Project.staffing?: 'auto' | 'fixed'` (`fixed` runs every role at its configured model
  and effort, as before this work, except that a model or effort on the spawn call no longer passes through; 4.3);
  `RunOverrides.goal?`, carried like `strictDelegation` (socket and in-process clients set it; the desktop start
  handler drops overrides today, so a desktop per-run goal is part of phase 5).
- `PlanStep.after?`, `PlanStep.paths?`, `PlanStep.staff?`.
- `StaffingAssignment { agentId?; stepId?; roleId; tier?; model; effort?; source; note?; at }`;
  `RunStaffing { goal; assignments }` on `RunRecord` (at most 200 assignments, newest kept), written through
  `RuntimeContext.updateStaffing` (RunManager cleans, stores, persists, broadcasts), event `staffing.updated`;
  `RuntimeContext.staffingGoal`. A continuation keeps the goal and starts a new staffing record. Normalizers and
  effective values (`cleanPlanStepGraph`, `cleanRunStaffing`, `effectiveRoleStaffing`, `staffingGoalOf`,
  `reviewPolicyOf`, tier and effort ordering) live in `defaults.ts`. Landed in `75dc5423`.
- `RunEfficiency { reports; firstSpawnMs; reportSumMs; reportBusyMs; maxParallel; tailMs }` on the run's usage
  (built in Phase 0, derived in `runUsage.ts`); `readyIdleMs?` joins it with the plan graph.
- Nudge kind `'ready'`. Tools: `delegate_agent.background`; `spawn_report.tier` and `.effort`.
- `StaffingProfile` stays in main; the Team tab gets a read-only summary.
- All structured-clone safe. Coexists with `RunRecord.delegation`: the ledger says whether obligations were met,
  staffing says who was chosen and why.
- Not in the contract any more: `RunShape`, `RunTriage`, a wider `StartRunInput.team`, `escalate_to_team` (4.1).

Files: new `runtime/staffing.ts` and `store/staffingProfile.ts`, each with tests beside it; changes in
`continuation.ts` (`readySteps`, the `ready` nudge), `harnessTools.ts`, `prompts.ts`, `claude.ts` and
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

**After Phase 0.** D3 and D4 concerned the automatic one-assistant shape. D3's own condition was met (median 2.5 s,
above 1.5 s), which left "rules only"; the baseline then showed there is nothing for those rules to win, because
the lead already works alone when nothing forces a team (1.1, 4.1). The shape is not built, so D3 and D4 have no
effect. This follows the gate rule of phase 0 below and was not a new question to the owner; it can be revisited
if `baseline2` or the Claude arm shows a team root that does not behave this way. D1, D2 and D5 to D9 stand.

**After Phase 6.** D5 is narrower than decided. "By risk" was written for any change; as shipped, the risk
conditions apply to work the lead handed out, and work the lead did itself is reviewed only when a rule or the
brief asks for it (4.4, 1.1c). The reason is measured: a lead that had done the work alone still called a reviewer
for it, and on Codex that review round was most of a 2x. A project that wants every change reviewed sets
`reviewPolicy: 'always'`; restoring the wider default is a one-sentence change in `reviewPolicyText`. This is the
owner's to reverse.

**Reversed by the owner, 2026-11-10 ("widened back").** `risk` again covers any change, the lead's own included:
"only when a rule or the brief demands it, the change touches sensitive or security-relevant code, the diff is
large or verification failed once; else verify and finish". No lab run was made on this wording. The lab builds
(P2d, P2e) carried the narrow one, and the P2c runs, which carried the wide one, are the runs where the Codex lead
called a reviewer for its own work; P2c did not yet have the rule that the lead's own tests are never handed out,
so the two effects are not separated.

**Narrowed once more by the owner, 2026-11-10** (on the recommendation in `split-execution.md` section 8): a large
diff counts only when no report checked it ("a large diff was checked by no report"). A rule, the brief, sensitive
code and a failed verification still call for review whoever did the work.

## 7. Acceptance

Revisited at the Phase 0 gate and once more when `baseline2` reported (1.1a), which filled in the baselines and
changed the form of the mandated target: the mandated arm on the default chart turned out to be a refusal, not a
pipeline, so "0.7x of arm 3" would have compared against a lead working alone. Frozen from here. Lab runs cost real
tokens and run once per phase gate; at least 3 repeats per cell on the ledger and the inventory, 1 on the
dashboard, plus one task that splits into independent modules (to be added to the lab).

Arms:

1. native Codex; 2. native Claude Code;
3. OrgAI with the team mandated: the default chart, required reports for implementer and reviewer, nothing
   scripted (`orgai-required`: 75.7 / 113.6 / 638.3 s on Codex, 5 of 7 runs `delegation-incomplete`). The scripted
   pilots of 1.2 (132 / 497 / 1093 s) are the only runs in which a pipeline ran;
4. OrgAI unforced at `aad24c38`, root at medium effort (`orgai-adaptive-medium`: 70.9 s $0.088, 180.2 s $0.134,
   651.6 s $0.437 on Codex; on the Claude adapter 84.8 s $0.857 on the ledger and 434.7 s $1.908 on the inventory,
   1.1b; its mandated ledger run took 150.9 s $2.120 and ended `delegation-incomplete`);
5. OrgAI single assistant (47.3 / 93.4 / 580.0 s at low effort; it cannot be run at medium, nothing sets its effort);
6. OrgAI with this spec, unforced; 7. OrgAI with this spec, team mandated as in arm 3. Both on each adapter.

Targets:

- **Unforced, small and medium tasks (arm 6 against native Codex at the same model and effort):** wall time within
  1.15x, cost within 1.25x; the lead still works alone on them (no report spawned on the ledger or the inventory).
- **Unforced, work that splits (arm 6 on the dashboard and the module task):** wall time at or below the faster
  native arm, overlap ratio (`reportSumMs / reportBusyMs`) at least 1.5 when it delegates, cost within 1.25x of the
  cheaper native arm.
- **Team mandated (arm 7):** every run ends `completed` with every required receipt valid (2 of 7 at baseline on
  Codex); wall time at most 1.5x and cost at most 2x the native arm of the same adapter at the same model and
  effort (the scripted pilots took 2.4x to 2.9x the time); tail (`tailMs` over the run) under 35%; the required
  reports that do not need each other's result overlap.
- **Fixed overhead:** first-call input tokens within 4k of native Codex for a team root (7.4k today) and within 2k
  for a report; a run with no report ends within 150 ms of its last model response.
- **Quality:** no task loses pass rate against arm 4 or arm 3.
- Claude adapter: the same targets against native Claude Code, from the corrected driver; in arm 6 the lead spawns
  no report on the ledger or the inventory (at baseline it spawns one in every run).

Standing after phase 1 (1.1b; the targets are judged on the phase 6 comparison, not here):

| Target | Codex adapter | Claude adapter |
|---|---|---|
| Small and medium, time within 1.15x | ledger 1.19x, inventory 1.07x | ledger 1.29x, inventory 0.95x (1 run) |
| Small and medium, cost within 1.25x | ledger 2.52x (noisy), inventory 1.13x | ledger 1.43x, inventory 1.72x (1 run) |
| The lead works alone on them | yes, 6 of 6 | ledger 3 of 3; inventory spawned one reviewer |
| Work that splits at or below native | dashboard 1.55x, not split | not run |
| Mandated: completes, 1.5x time, 2x cost | not rerun (refusal at baseline) | 3.02x, 12.3x, `delegation-incomplete` |
| Root first call within 4k of native | about 5k above | not comparable (no native count) |
| Run end within 150 ms | 60 to 80 ms | 130 to 180 ms |

Standing after phase 6 (1.1c). Ratios are against the same adapter's native arm; where the rewording changed a
cell, the last rerun (P2e) is given beside the main campaign:

| Target | Codex adapter | Claude adapter |
|---|---|---|
| Small and medium: time within 1.15x | ledger 1.09x, met; inventory 1.99x on P2c, 1.11x on P2e, met there | ledger 1.23x, not met; inventory 0.69x, met |
| Small and medium: cost within 1.25x | ledger 1.72x, not met; inventory 3.09x on P2c, 1.05x on P2e, met there | ledger 1.43x, not met; inventory 0.75x, met |
| The lead works alone on them | ledger 5 of 5; inventory 0 of 3 on P2c, 2 of 3 on P2e, not met | 9 of 9 over all builds, met |
| Work that splits: at or below native | not met: dashboard 1.79x, 1.14x, 1.51x; modules 1.33x, 1.07x, 1.17x (P2c, P2d, P2e) | modules 0.87x and 0.78x without splitting; no dashboard run |
| Work that splits: overlap at least 1.5 when it delegates | once (modules on P2d, 2.61); 1.0 in the other five split runs | never delegated |
| Work that splits: cost within 1.25x | not met: 1.6x to 3.0x | modules 0.99x and 0.89x |
| Mandated: every run completes, receipts valid | 4 of 4, and 4 of 4 in the reruns, met | 3 of 3, and 2 of 2 in the reruns, met |
| Mandated: time at most 1.5x, cost at most 2x | ledger 1.69x / 3.07x, not met; inventory 1.43x / 2.03x; dashboard 1.54x / 1.74x | ledger 2.16x / 2.60x, not met; inventory 1.27x / 1.05x, met |
| Mandated: tail under 35% | not met, 37% to 89% | not met, 39% to 66% |
| Mandated: required reports that do not need each other overlap | not exercised: the reviewer needs the implementer's result | not exercised |
| Root first call within 4k of native, a report within 2k | 3.9k above, met; a report is below native, met | no native count to compare (20.9k to 22.5k; a report 7.7k to 10.0k) |
| Run end within 150 ms | 70 to 90 ms, met | 150 to 190 ms, not met |
| Quality: no task loses pass rate | every trial passed its hidden tests (46 of 46 over the three campaigns) | same |

In short: the mandated arm went from never completing to always completing, and the lead's own work is at or near
native on Codex and at or ahead of it on Claude except on the smallest task. Not reached: a split that beats
native, the mandated targets on a one-minute task, and the tail target as written (section 10).

## 8. Phases

0. **Measure. Done 2026-11-10.** `RunUsage.efficiency` (`runUsage.ts`); `scripts/measure-prompt-size.mjs`;
   `scripts/smoke-staffing.mjs` and the 0.3.318 facts; the unforced baseline (1.1); where run start and run end go
   (4.6), with the continuation wait fixed. The gate rule applied: the unforced arm was already near native, so the
   ranking in 1.5 was redone and the solo shape dropped. `baseline2` (effort-matched arms, the mandated default
   chart, isolation, a Claude-adapter arm if it can be driven headless) runs beside phase 1.
1. **Prompts and fixed overhead, no contract.** The sizing rule (4.1) and the parallel rules (4.2) in the root
   prompt; default chart and Architect wording; the tool-definition diet with its budget test (4.6); plan calls
   batched with work (4.6); the root's effort applied on Claude through `Options.effort`, with an explicit effort
   on every report so nothing inherits it by accident. The tier and effort rubric waits for phase 2: without the
   resolver's clamp an instruction to set a model on each spawn could spend above the chart. Gate: lab rerun of
   arms 6 and 7 on the phase 1 commit, when `baseline2` has freed the lab. **Built; the rerun is 1.1b.**
2. **Contract, plan graph and per-spawn staffing. Built**, with three review rounds on the spend ceilings and two
   on the team files gate (4.3). Types and defaults; `staffing.ts`; the rubric in the root
   prompt; `readySteps` and the ready lines; mock; Claude gate (aliases, the plan guard on the same path, the tier variables on the Anthropic
   connection behind a smoke check); Codex spawn parameters; the `ready` nudge; background `delegate_agent`; team
   files and the gate rule; the shared `staffingBook.ts`; Codex's native multi-agent tools switched off at launch
   (added after `baseline2`). Reviewer pass on team files and anything that can raise spend. Gate: lab rerun of
   arms 6 and 7 on both adapters, run once as the phase 6 comparison, after the two fixes of 1.1b (a report's text
   on Claude, spawns that need no rewrite) so the mandated arm is measured on a build where it can complete.
   Added at that gate: a spawn's plan step is marked running when its report starts and kept running while the
   report works; Codex app-servers start one at a time per home (1.1c).
3. **Review policy. Closed without new mechanics.** The policy sentence shipped with the rubric in phase 2 and
   was narrowed at the phase 6 gate to handed-out work (4.4). The condition for building more was a lead that
   redoes its reports' work, and the comparison did not show one: in the mandated runs on Claude the lead applied
   the reviewer's small finding itself, verified once and finished. Verification once per result and findings
   going back to the author are therefore not built. The one run where findings did go back through the reports
   (Codex, inventory, required, on P2d: implementer and reviewer two to three times each) took 308 s against
   198 s for the run where the lead fixed the finding itself.
4. **Profile. Built.** `staffingProfile.ts`, the resolver default, the staffing brief; written at run end and read
   at run start by RunManager, never on quick, Ask, setup, build or fixed-staffing runs.
5. **Surfaces. Built.** Run view, TUI, CLI `--goal`, Team tab, usage, the New run page's goal; e2e selectors in
   the same change (`runs.mjs`, `team.mjs`, `team-files.mjs`, `usage.mjs`, `cli-tui.mjs`, `cli-exec.mjs`).
6. **Gate. Done 2026-11-10.** The full comparison against section 7 is 1.1c, with the standing in section 7;
   two rewording passes of the sizing rule came out of it. `docs/agent-notes/core-runtime.md`, `sdk-facts.md`,
   `permissions.md`, `connections-mcp.md` and `.orgai/ARCHITECTURE.md` carry the facts.

Each phase lands on dev behind `Project.staffing` where it changes behaviour for stored projects, after the local
gate (typecheck, the whole unit suite, build, the e2e scripts for the area). Work starts from `origin/dev` in its
own worktree, not the local `dev` checkout, which is behind and carries uncommitted project-instances work that must
not be disturbed.

## 9. Executing this spec

The executing session is the orchestrator: it sequences phases, holds the hot-file claims, reviews each result
against this document, runs the gates and pushes. It writes no feature code. Implementers are subagents on Opus,
Sonnet or Haiku, picked per package by the rubric of 4.3, and packages that touch different files run at the same
time in their own worktrees, by the rules of 4.2:

| Work package | Model | Effort | Runs beside |
|---|---|---|---|
| Contract in `types.ts` / `defaults.ts` (all of section 5 at once) | Opus | high | nothing: hot files |
| `staffing.ts` with tests | Opus | high | everything after the contract |
| Claude spawn gate, root effort, smoke scripts, background `delegate_agent` | Opus | medium | Codex, mock, plan tools |
| Root prompt paragraphs, default chart and Architect wording (wording changes behaviour) | Opus | medium | adapters, tool definitions |
| Tool-definition diet and its budget test | Opus | medium | prompts, adapters |
| Reviewer pass: team files gate, spend ceilings | Opus | high | the next package |
| Lab campaigns and comparison scripts | Opus | medium | everything |
| Phase 0 metrics; Codex spawn parameters; mock; `readySteps`, ready lines and the nudge; `staffingProfile.ts`; team files; review policy | Sonnet | medium | each other |
| Renderer, TUI, CLI flags, usage | Sonnet | medium | each other |
| e2e selectors, fixtures, agent notes, ARCHITECTURE.md, mechanical renames | Haiku | low | everything |

A package that fails its gate once is retried one step up (Haiku to Sonnet, Sonnet to Opus, or one effort level).

## 10. Risks and open items

- The evidence is small: at most three runs per cell, one on the dashboard and the module task, and each rewording
  pass was checked by one rerun of a subset (1.1c). The spread inside one cell is as large as some differences
  read between cells (Claude ledger, unforced: 47 to 69 s over five runs).
- The self-control gate's false refusals are the largest avoidable cost left on a small Claude run: one to four
  per unforced ledger run on P2 and seven in one run on P2e (68.8 s against a 52 s median), each a wasted round
  trip, and the lead retries with variations. They are not addressed here: the gate fails closed on purpose, and
  changing what it accepts is a security change with its own review. A case for that review: with no protected
  path involved, `commandRunsOrgaiCli` returns true for `python3 -c "import ledger; E=[dict(id='t',revision=2,
  account='x',cents=-3,status='posted')]; print(ledger.balances(dict(x=0,z=5),E))"`, which names nothing of
  OrgAI's; each of its two statements alone passes.
- A mandated team on a small task has a fixed cost that staffing cannot remove: two reports take 40 to 50 s
  between them to start, read and report on a task the lead finishes in under a minute (1.1c). The 1.5x and 2x
  targets are met from the inventory's size upward on Claude and nearly on Codex. Making a required report
  cheaper on trivial work means changing what "required" promises, which is the owner's decision and not part of
  this spec.
- `tailMs` counts everything after the first wave of reports. It reads as handover cost only when the lead waits
  for its reports; a lead that builds beside a small slice shows a long "tail" that is its own work (the
  dashboard, 1.1c). The tail target should be restated on time after the last report before it is used again.
- The team listing no longer says "Delegate to them". That line reaches every role with reports, and only the
  root of the default chart has lab runs behind it: a mid-level lead or a setup root whose own prompt does not
  tell it to delegate may now do more itself.
- The spawn check under `auto` is a safety check. This work stops triggering a second copy of it by not
  rewriting well-formed spawns; it does not remove it, and answering `allow` for a spawn from the hook (which
  would) is the owner's decision, not taken here. A lead that ignores the guidance still pays for the rewrite, a
  spawn whose brief names known items is still rewritten (the knowledge block goes into its prompt), and the
  local check's tokens are in no usage figure OrgAI shows.
- Switching off Codex's native multi-agent tools rests on a debug command (`codex debug models`) and a catalog
  field name, checked on Codex 0.167 only. It fails open, and then the prompt sentence is all that stands against
  Codex's rule; whether that sentence is enough is unmeasured. With the tools off the lead is readier to delegate
  than a native session, and the sizing wording alone holds it back; that wording was tuned on four tasks.
- The sizing rule could make the lead delegate small work it does well alone today. It did, on Codex, once the
  native tools were off (1.1c); two rewordings brought the inventory back to 2 of 3 runs alone and to native's
  time and cost on the median. That is three runs on one task. A different model, a different task or a later
  edit of the paragraph can bring it back, which is why its sentences and sizes are pinned in `prompts.test.ts`.
- Asking for parallel fan-out does not make a split good. The dashboard pilot split 144 s against 422 s. In the
  comparison the Codex lead split the module task three different ways in three runs and the Claude lead never
  split; no split run beat native. The "longest piece" rule and the profile's history are the mitigation; overlap
  and tail are measured per run. This is the part of the goal the work has not delivered.
- An under-powered pick that fails and retries can cost more than starting higher. The profile learns this; until
  it has data the rubric keeps implementation on everyday / medium.
- More parallel writers mean more merge conflicts. `paths` and the overlap warning are the mitigation; conflicts per
  run are measured.
- Parallel fan-out against a subscription or a rate-limited key can stall. The width rule in 4.2 is the mitigation;
  it is untested against a real limit.
- Verified by `scripts/smoke-staffing.mjs` (one run each, haiku and sonnet, Max login): aliases and effort through
  `updatedInput`, foreground spawns in one message running together, root effort through `Options.effort`. Seen
  once in the lab on Codex: three reports started together (modules on P2d, 1.1c). Still unverified: whether a
  Claude root batches its spawns into one message when it does split (it never split in the comparison), and the
  tier variables on a subscription login. Plan calls: about one plan-only response per run on both adapters.
- Effort on Codex: an unset effort runs at `low` and OrgAI sends nothing above high. The lab drivers sent xhigh at
  the protocol level and it was applied, so the limit is OrgAI's; lifting it is a small follow-up and automatic
  staffing does not need it. Applying the root's effort on Claude changes what an effort-less report gets unless
  every spawn carries one, which is why phase 1 sets it explicitly.
- Tier changes between spawns do not share a prompt cache; the profile's cost medians show whether mixed tiers on
  small steps save anything on a given connection.
- Stored role prompts that say "delegate everything" still win over the sizing rule. A Team review recommendation
  to relax them is a follow-up, not part of this spec.
- Shorter tool descriptions can make a rarely used configuration tool fail its first call. The detail moves into
  the validation error it returns, and the budget test keeps the saving.
