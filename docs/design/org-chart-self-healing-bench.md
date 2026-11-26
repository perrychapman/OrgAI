# Org chart self-healing bench

Goal (owner): "an org chart should ALWAYS be self-healing in an efficient way", for teams of varying complexity. This
bench measures how far the team evolution engine (`src/main/evolve/`, ARCHITECTURE.md "Team evolution") is from that
on its unattended path. It changes no product code. Token-free: no model call, no network, no Electron.

## Running it

- `node scripts/bench-org-heal.mjs` writes `bench-results/org-heal/<UTC timestamp>/results.json` and `report.md`
  (about 20 s for 46 cases). Flags: `--seed <n>` (default 1), `--case <id>` (`small:serial`, a defect id such as
  `serial` for all three charts, a complexity, or `control`), `--out <dir>`, `--json` (print results.json),
  `--no-skill-eval` (no skill findings reach the engine; see "Simulator limits").
- Same seed, same `results.json` apart from `generatedAt` (checked by running twice and comparing, and by the last test
  in `heal.test.mjs`).
- `node --test scripts/lib/org-bench/heal/heal.test.mjs`: the bench runs deterministically and its metric functions are
  right. It does not assert that the engine heals; the bench reports that.
- package.json (added at merge): `"bench:heal": "node scripts/bench-org-heal.mjs"` and
  `scripts/lib/org-bench/heal/heal.test.mjs` appended to `test:scripts`.

Files: `scripts/bench-org-heal.mjs` (runner), `scripts/lib/org-bench/heal/charts.mjs` (reference charts and hidden
truth), `defects.mjs` (injectors, the healing mechanism and blocker per defect), `simulate.mjs` (run-record simulator),
`measure.mjs` (pure metrics and the report), `heal.test.mjs`.

## Method

1. Reference charts (`charts.mjs`), field-neutral names, right-sized by definition (every role's tier and effort equal
   the hidden truth of its work):
   - small, 4 roles: lead (deep/medium, root), builder (deep/medium), researcher (fast/low), reviewer (everyday/high).
   - medium, 7 roles, flat: lead, researcher, builder-a, builder-b (deep/medium), writer, checker (everyday/medium),
     reviewer (everyday/high).
   - large, 12 roles: director (root) over three leads (build-lead, content-lead, quality-lead, everyday/medium), over
     builder-a/b/c, researcher, analyst, writer, checker, reviewer.
   Each has a weighted task mix of plan templates (steps with `after` and `paths`), and a project skill
   (`build-routine`) granted to the builders.
2. Defects (`defects.mjs`), each injected on a suitable role of each chart: in the engine's vocabulary (tier
   over-provisioned, tier under-provisioned, effort too high, serial bottleneck, merge conflict hotspot, tool friction,
   prompt bloat, ceremonial layer, a repeated procedure that should be a skill) and structural (missing specialty,
   redundant role, wrong reporting line, a role lacking a write tool, a guard role with prompt bloat, a guard role on
   deep). Controls: each healthy chart. 46 cases (wrong reporting line needs leads: large only).
3. Loop, per case, through the real unattended path: `createEvolveService` (`service.ts`) loaded through jiti with an
   in-memory project store and a temporary ledger folder (deleted after the case). After every simulated run: `analyze`
   (read-only, for detection and the gate rules seen), then `afterRun({ evolve: true, strategy: 'deterministic' })`,
   exactly the host's post-run pass (settle a trial, else diagnose, synthesize, gate, hold spend raises, apply as a
   trial). No `expectedFingerprint`, no `allowSpendRaise`: it never raises spend. 60 runs per case; once 6 generations
   are applied and decided, later runs get no pass (the horizon stays 60 so costs compare).
4. Two counterfactuals on the same run indices and the same random draws: the frozen reference (healthy chart,
   evolution off) and the frozen defective chart ("left alone").
5. Measures per case: detected (a finding of the expected kind on the expected role, and the first run it appeared);
   a plan proposed for the defect; gate rules seen per pass; spend raises held; healed (the defect's fields equal the
   reference, the final waste under the engine's threshold 15, and the symptom: last 10 runs within 2% cost, 5% wall
   time and no more failed steps than the reference); generations applied / promoted / rolled back and the run of the
   last change; collateral (fields changed at the end that the defect did not touch); oscillation (an apply returning a
   field to an earlier value); rejected hypotheses re-proposed (the plan the synthesizer builds with no memory holds a
   patch on the ledger's rejected list); blind trials (a generation promoted or rolled back although no patched role ran
   in any run of its decision window, which runs from the apply to the run whose post-run pass decided it; until
   2026-11-25 the runner took the first `evalWindowRuns` runs after the apply, which is the same window for an engine
   that decides on exactly those runs); excess cost over the reference with evolution on and left alone. Controls: any applied change is a false positive.

## Simulator rules

The full list is the header of `simulate.mjs`. In short: one task per run drawn by weight; a step for role X is spawned
along X's reportsTo chain in the current chart (one agent per intermediate role per run), and a missing role's steps
are done by its nearest reference ancestor itself; capability = tier index + 0.5 x effort index against the role's
hidden need, plus noise; an attempt fails with a probability that rises with the capability gap, with extra hops off
the reference reporting line, with an under-capable lead above it and with a missing write tool; a failure is followed
by one retry (staffing source 'escalated' for a capability gap, else 'role'), and a failed retry ends the run 'error';
turns, tokens and wall time follow the kind of work, the effort and the prompt size; prices are per tier; missing tools
are called twice and fail with "No such tool available"; a builder without the routine skill runs a six-call routine;
a "Shared files:" line makes agents touch a shared folder, conflicting when two agents overlap in time; at most
`maxConcurrentSubagents` step agents run at once.

## Simulator limits, and where it is circular with the engine

- The rules were written after reading the engine, so they are not blind to its thresholds. Where a rule sits next to a
  threshold: work sizes (lookup 4 turns, check 5, review 9, analyze 8, write 9, build 14) decide which roles the
  over-provisioned rule sees as "short, simple work" (avg turns <= 6 and output <= 4,000); the bloat defect (six copies)
  was sized to pass `PROMPT_BUDGET_PER_ROLE` (900); the hop input formula (results flow back to the spawner) decides
  whether a coordinator reaches the ceremonial rule's 20,000 input tokens; tool errors carry the exact text
  `classifyError` matches. These choices decide detection, not the outcome after a change.
- Circular in the outcome: the file-scope block cutting shared-folder edits from 0.6 to 0.12 is my assumption that the
  engine's fix works. The "conflict" symptom heals because of it.
- The assumption that drives most "made worse" and false-positive outcomes: a lead or checker cut below its need hurts
  quality (children fail 0.15 more per tier step a lead is short; a short check still needs everyday). Short is not
  easy in this simulator. If real leads and checkers do fine on fast, those cuts are savings, not harm.
- The hidden truth and the reference charts are mine; a different "sensible" chart (a checker on fast, a researcher on
  everyday/low) would change which controls are false positives.
- Prices, tokens, turns and wall times are invented (Claude-like ratios). Cost conclusions are relative.
- The engine counts a failed first attempt as a first pass when it finished 'done' (`telemetry.ts firstPassOf`), so
  only escalated retries lower the first-pass rate. The simulator records plain re-spawns for context failures, which the
  engine cannot see at all. Both are real readings of the code; whether the runtime records retries this way is not
  verified.
- Skill findings: the host's evolve service reads `skillEvaluation.last(projectId)`, and the skill evaluation runs only
  on request (`skills:evaluate`), so in the app the findings are stale or absent. The bench assumes a fresh evaluation
  at every pass (an upper bound); `--no-skill-eval` is the other end.
- Concurrency counts step agents only (leads and the root do not take a slot). Every run has a clean plan with paths.
  Real models are rarely offered tools they lack (they hit permission denials with other text), so tool-friction
  detection on a live run is unverified.
- Not exercised: the hybrid strategy (needs a model), a person approving raises, the orchestrator's
  `propose_org_change`, the Architect retrospective, team files, staffing goals other than balanced, fixed staffing,
  skill quality findings (never loaded, overlap).

## Robustness

Seed 1 is the reported run. Same code, other runs (status counts over the 43 defect cases):

| Run | healed | symptom healed | negligible here | detected only | missed | made worse | controls changed | generations applied / promoted / rolled back |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| seed 1 | 7 | 4 | 9 | 15 | 6 | 2 | 2 of 3 (both rolled back) | 78 / 15 / 63 |
| seed 2 | 5 | 1 | 8 | 12 | 4 | 13 | 2 of 3 (large: three lead cuts promoted, worse) | 87 / 53 / 34 |
| seed 3 | 5 | 2 | 10 | 19 | 7 | 0 | 2 of 3 (large worse) | 90 / 22 / 68 |
| seed 1, --no-skill-eval | 5 | 3 | 11 | 13 | 9 | 2 | 1 of 3 | 67 / 12 / 55 |

Twelve of seed 2's thirteen "made worse" cases are on the large chart (the thirteenth is small ceremonial): in the
control and in most large cases the engine cut
quality-lead, build-lead and content-lead to fast and promoted the cuts on clean three-run windows (one after a
rolled-back trial had left error runs in the next baseline). Without skill findings the small and medium prompt bloat
is no longer healed: the bloat finding alone stays under the waste threshold, so in the default run it was the
unrelated skill_crystallization finding that pushed the waste over the gate.

## What it shows

- Healed (fields restored), unattended, in most charts and seeds: prompt bloat on a non-guard role (only when something
  else lifts the waste over 15), tool friction for a read-only tool (small, seed 1: rolled back by noise), effort too
  high on an everyday role with short work. Everything else is detected only, missed, or healed only as a symptom.
- Never healed unattended, by design: anything that raises spend (under-provisioning, concurrency: 308 held passes),
  any structural change (`chartProblems` rejects role, reportsTo and spawnable changes), write tools, guard prompts,
  skills (no `setEnabled` port in the host).
- The ratchet's trial is the weakest part. 63 of 78 generations were rolled back; a correct patch was rolled back on
  runs that never used the role and is never retried (rejections never expire: 1,463 silent re-proposals over 31
  cases); harmful cuts were promoted when the baseline already held error runs (a defect's own failures, or the window
  of a trial just rolled back, both in `diagnosis.metrics` of the newest 10 runs); one plan bundles unrelated patches,
  so a harmful cut rides along with a good one (large:effort-high gen_2).
- The engine can cut but not restore: once a cut it promoted proves harmful, the raise back is a spend raise and is
  held forever (medium:tier-under, `checker.tier`).
- Detection is length-based: short work reads as over-provisioned (leads and checkers in the controls), long work never
  does (a deep reviewer, $8 to $10 left alone over 60 runs, is invisible), a fast role's effort is never judged, and the
  over-provisioned rule stops at everyday/low.
- The waste score never fell under 15 in any case (median 60): skill_crystallization from ordinary tool routines keeps
  every healthy chart at 49 to 60, so `MIN_WASTE_DEFAULT` no longer gates anything when skill findings are fresh.

## Three changes to make first

1. Make a trial judge the change, not the week (`ratchet.ts evaluateActiveTrial` / `compareMetrics`, `service.ts
   settleTrial`, `applyCore`'s baseline, `addRejected`). Count only runs where a patched role (or the changed limit)
   was exercised; compare the patched roles' own figures (first pass, escalations, cost per agent) before and after;
   keep the window of a rolled-back trial and of runs with an open defect out of the next baseline; one role patch per
   generation (or decide each patch separately) so a bad cut cannot ride with a good one; let a rejection expire after
   a number of exercised runs. Spend and safety: no new raise and no gate rule loosened; trials take longer (more runs
   per decision), and an expired rejection re-tries a change that once regressed, bounded by the trial itself. It
   changes the rollback logic of a spend and security boundary file, so the Reviewer should see it.
2. Calibrate detection (`telemetry.ts diagnose`, `skills/evaluate.ts`). Do not take a role-wide tier cut from length
   alone: exclude spawners (canSpawn) from tier_overprovisioned and use the existing `exploration` (1 in K steps one tier
   down, with its own first-pass record) before cutting a role; judge effort on fast roles too; keep advisory findings
   (skill_crystallization, ceremonial_layer, exploration) out of the waste score that gates a plan; drop orchestration
   tools (Agent, TodoWrite, Skill) and windows of fewer than 3 distinct tools from repeated-sequence findings; add
   findings for a spawner doing step work itself and for a role never spawned in N runs (advisory). Spend: fewer cuts
   means less saved than today in the cases where a cut was right; no raise. Safety: none (detection only).
3. Give what unattended mode may not do a path to a person, and let it undo its own cuts. A raise that only restores
   a value an earlier promoted generation of the engine itself lowered (never above the value before that generation,
   never a user-only value) could apply unattended, since it never spends above what the user configured; everything
   else that is held (raises, concurrency, write tools, structural findings that persist N runs, drafted skills)
   becomes one decision card or `org evolve` proposal per change instead of being held silently on every pass, and the
   under-provisioned path proposes the tier step directly when a floor at the ceiling would change nothing. Spend: the
   restore-only raise spends more than today's held state but never more than the user's own chart did; everything else
   still needs a person. This loosens `holdSpendRaises` for one narrow case and touches `spend.ts`: the Reviewer must
   pass it.

## Results (2026-11-19, de960168)

# Org chart self-healing bench

Seed 1, commit de960168, horizon 60 runs per case, 46 cases. Strategy deterministic, unattended post-run pass (createEvolveService afterRun, evolve on), token-free. Skill findings: a fresh skill evaluation over the newest 20 runs at every pass.

Cell: status, run of first detection (det), run from which the defect's fields held the reference values to the end (heal), generations applied, fields changed at the end that the defect did not touch (collateral), simulated excess cost over the frozen reference across the horizon.

Status: healed = the defect's fields hold the reference values at the end; symptom healed = fields not restored, the chart was changed, and the last 10 runs are within 2% cost, 5% wall time and no more failed steps than the reference; negligible here = the defect, left alone, never left those tolerances over the horizon in this simulator; detected only = a matching finding, still costly; missed = no matching finding; made worse = the evolved chart is worse than leaving the defect alone on the same last 10 runs.

| Defect | small | medium | large |
| --- | --- | --- | --- |
| Tier over-provisioned (lookup role on deep) (engine) | symptom healed, det r6, 1 gen, +$2.35 | detected only, det r1, 2 gen, +$4.30 | detected only, det r3, 3 gen, +$6.13 |
| Tier under-provisioned (builder on everyday) (engine) | detected only, det r1, +$8.56 | made worse, det r2, 1 gen, 2 collateral, +$2.18 | detected only, det r2, 3 gen, +$4.79 |
| Effort too high (simple-work role on high) (engine) | negligible here, +$0.68 | healed, det r1, heal r6, 2 gen, +$0.08 | healed, det r1, heal r10, 4 gen, 2 collateral, +$1.09 |
| Serial bottleneck (concurrency 1) (engine) | detected only, det r1, +$0.00 | detected only, det r1, 1 gen, -$0.03 | detected only, det r1, 3 gen, +$2.08 |
| Merge conflict hotspot (overlapping file scopes) (engine) | symptom healed, det r3, 1 gen, 1 collateral, +$0.57 | symptom healed, det r1, 2 gen, 1 collateral, +$0.92 | symptom healed, det r1, 4 gen, 1 collateral, +$3.28 |
| Tool friction (lookup role lacks Grep) (engine) | negligible here, det r6, 1 gen, +$0.80 | healed, det r1, heal r3, 2 gen, +$0.08 | healed, det r3, heal r3, 4 gen, +$1.15 |
| Prompt bloat (six pasted copies) (engine) | healed, det r1, heal r4, 1 gen, +$0.17 | healed, det r1, heal r3, 2 gen, +$0.01 | healed, det r1, heal r3, 4 gen, +$1.12 |
| Ceremonial layer (coordinator with one report) (engine) | made worse, det r23, 1 gen, 2 collateral, +$10.85 | detected only, det r3, 1 gen, +$14.04 | detected only, det r8, 4 gen, 2 collateral, +$5.55 |
| Repeated procedure that should be a skill (engine) | detected only, det r3, +$18.80 | detected only, det r3, 1 gen, +$23.75 | detected only, det r5, 3 gen, +$35.61 |
| Missing specialty (root or lead does lookups itself) (structural) | missed, +$7.79 | missed, 1 gen, +$20.81 | negligible here, 3 gen, +$3.66 |
| Redundant role never used (structural) | negligible here, +$0.10 | negligible here, 1 gen, +$0.10 | negligible here, 3 gen, +$2.22 |
| Wrong reporting line (analyst under the build lead) (structural) | n/a | n/a | missed, 3 gen, +$3.74 |
| Role lacks a write tool it needs (structural) | detected only, det r1, +$20.18 | detected only, det r3, 1 gen, +$4.72 | detected only, det r4, 3 gen, +$7.67 |
| Guard role (reviewer) prompt bloat (structural) | negligible here, det r1, +$0.32 | negligible here, det r1, 1 gen, +$0.26 | negligible here, det r1, 3 gen, +$2.37 |
| Guard role (reviewer) on deep (structural) | missed, +$8.78 | missed, 1 gen, +$8.05 | missed, 3 gen, +$9.97 |

Totals over 43 defect cases: detected only 15, healed 7, missed 6, negligible here 9, symptom healed 4, made worse 2.

## The ratchet across all cases

- Generations applied 78: promoted 15, rolled back 63, still on trial at the end 0.
- Trials decided on runs in which no patched role ran (the change was never exercised): 2 (promoted 1, rolled back 1).
- Passes on which a rolled-back patch was rebuilt and silently dropped (rejected hypothesis re-proposed): 1463 over 31 cases.
- Passes that held a spend raise: 308 over 6 cases.
- Cases where the final waste score is under the engine threshold (15): 0 of 46; median final waste 60. Final findings on the healthy controls: skill_crystallization, tier_overprovisioned.

## Controls

False positives: 2 of 3 healthy charts had a change applied.

| Chart | Status | Generations (applied / promoted / rolled back) | Changes applied | Final waste | Excess cost |
| --- | --- | --- | --- | --- | --- |
| small | clean | 0 / 0 / 0 | none | 49 | +$0.00 |
| medium | false positive | 1 / 0 / 1 | gen_1 checker: tier fast (rolled_back: trial regressed: error-run rate rose 33 points (0 to 0.3333)) | 54 | -$0.03 |
| large | false positive | 3 / 0 / 3 | gen_1 quality-lead: tier fast (rolled_back: trial regressed: error-run rate rose 33 points (0 to 0.3333)); gen_2 checker: tier fast; content-lead: tier fast (rolled_back: trial regressed: error-run rate rose 57 points (0.1 to 0.6667)); gen_3 build-lead: tier fast (rolled_back: trial regressed: cost x time worsened 249% without a better first-pass rate) | 60 | +$2.08 |

## Per case

Cost, wall and failed steps against the frozen reference on the same runs: "left alone" is the defective chart with evolution off over the whole horizon; "last 10" is the evolved chart over the last 10 runs. Excess $: evolved run costs minus the reference over the horizon; left alone $: the same for the frozen defective chart. Blind trials: generations decided on runs where no patched role ran.

| Case | Status | Detected | Plan for the defect | Gate rules seen (passes) | Spend held | Healed field / waste < 15 / symptom | Gens (a/p/r) | Last change | Left alone: cost, wall, fails | Last 10: cost, wall, fails | Changes applied | Collateral at end | Oscillation | Rejected re-proposed (passes) | Blind trials | Excess $ / left alone $ |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| small:control | clean | no finding kind | no | none | none | no / no (49) / no | 0/0/0 | none | +0%, +0%, 0 (ref 0) | +0%, +0%, 0 (ref 0) | none | none | 0 | 0 | none | 0 / 0 |
| small:tier-over | symptom healed | run 6 | yes | none | none | no / no (49) / yes | 1/1/0 | run 17 | +4%, +4.8%, 0 (ref 0) | +1.4%, +1.3%, 0 (ref 0) | r17 researcher: tier everyday | none | 0 | 0 | none | 2.35 / 3.86 |
| small:tier-under | detected only | run 1 | yes | spend_held 58 | builder.staffing | no / no (70) / no | 0/0/0 | none | +8.8%, +4.5%, 46 (ref 0) | +13.9%, +10.6%, 7 (ref 0) | none | none | 0 | 0 | none | 8.56 / 8.56 |
| small:effort-high | negligible here | no | no | none | none | no / no (49) / no | 0/0/0 | none | +0.7%, +1.5%, 0 (ref 0) | +0.5%, +1%, 0 (ref 0) | none | none | 0 | 0 | none | 0.68 / 0.68 |
| small:serial | detected only | run 1 | yes | spend_held 58 | project.concurrency | no / no (64) / no | 0/0/0 | none | +0%, +16.4%, 0 (ref 0) | +0%, +18.3%, 0 (ref 0) | none | none | 0 | 0 | none | 0 / 0 |
| small:conflict | symptom healed | run 3 | yes | role_cooldown 4 | none | no / no (49) / yes | 1/1/0 | run 3 | +2.4%, +0.6%, 0 (ref 0) | +0.1%, +0%, 0 (ref 0) | r3 lead: prompt | lead.prompt 349 chars -> 537 chars | 0 | 0 | none | 0.57 / 2.32 |
| small:tool-friction | negligible here | run 6 | yes | none | none | no / no (65) / no | 1/0/1 | run 9 | +0.8%, +1.2%, 0 (ref 0) | +0.6%, +1%, 0 (ref 0) | r6 researcher: tools | none | 0 | 51 | gen_1 rolled_back | 0.8 / 0.8 |
| small:prompt-bloat | healed | run 1 | yes | none | none | yes / no (49) / yes | 1/1/0 | run 4 | +1.7%, +0%, 0 (ref 0) | +0%, +0%, 0 (ref 0) | r4 builder: prompt | none | 0 | 0 | none | 0.17 / 1.67 |
| small:ceremonial | made worse | run 23 | no | none | none | no / no (49) / no | 1/1/0 | run 7 | +12.8%, +9.4%, 1 (ref 0) | +6.4%, +8.1%, 0 (ref 0) | r7 coordinator: tier fast | coordinator.tier everyday -> fast; coordinator.model everyday -> fast | 0 | 0 | none | 10.85 / 12.42 |
| small:skill-routine | detected only | run 3 | no | none | none | no / no (57) / no | 0/0/0 | none | +19.4%, +11.3%, 0 (ref 0) | +20.4%, +12%, 0 (ref 0) | none | none | 0 | 0 | none | 18.8 / 18.8 |
| small:missing-specialty | missed | no finding kind | no | none | none | no / no (49) / no | 0/0/0 | none | +8%, +9%, 0 (ref 0) | +5.7%, +6.5%, 0 (ref 0) | none | none | 0 | 0 | none | 7.79 / 7.79 |
| small:redundant-role | negligible here | no finding kind | no | none | none | no / no (49) / no | 0/0/0 | none | +0.1%, +0%, 0 (ref 0) | +0.1%, +0%, 0 (ref 0) | none | none | 0 | 0 | none | 0.1 / 0.1 |
| small:missing-write | detected only | run 1 | no | none | none | no / no (69) / no | 0/0/0 | none | +20.8%, +15.7%, 0 (ref 0) | +13.2%, +8%, 0 (ref 0) | none | none | 0 | 0 | none | 20.18 / 20.18 |
| small:guard-bloat | negligible here | run 1 | no | none | none | no / no (51) / no | 0/0/0 | none | +0.3%, +0%, 0 (ref 0) | +0.4%, +0%, 0 (ref 0) | none | none | 0 | 0 | none | 0.32 / 0.32 |
| small:guard-tier-over | missed | no | no | none | none | no / no (49) / no | 0/0/0 | none | +9%, +17.9%, 0 (ref 0) | +10.1%, +19.8%, 0 (ref 0) | none | none | 0 | 0 | none | 8.78 / 8.78 |
| medium:control | false positive | no finding kind | no | none | none | no / no (54) / no | 1/0/1 | run 9 | +0%, +0%, 0 (ref 0) | +0%, +0%, 0 (ref 0) | r6 checker: tier fast | none | 0 | 44 | none | -0.03 / 0 |
| medium:tier-over | detected only | run 1 | yes | none | none | no / no (54) / no | 2/1/1 | run 12 | +5.7%, +6.5%, 0 (ref 0) | +2.8%, +2.2%, 0 (ref 0) | r5 researcher: tier everyday; r9 checker: tier fast | none | 0 | 39 | none | 4.3 / 8.02 |
| medium:tier-under | made worse | run 2 | yes | spend_held 55, role_cooldown 1 | builder-a.staffing, checker.tier | no / no (85) / no | 1/1/0 | run 6 | +2.5%, +1.6%, 33 (ref 0) | +1.4%, +6%, 11 (ref 0) | r6 checker: tier fast | checker.tier everyday -> fast; checker.model everyday -> fast | 0 | 0 | none | 2.18 / 3.55 |
| medium:effort-high | healed | run 1 | yes | role_cooldown 4 | none | yes / no (54) / yes | 2/1/1 | run 17 | +0.8%, +2.4%, 0 (ref 0) | +0%, +0%, 0 (ref 0) | r6 checker: effort medium; r14 checker: tier fast | none | 0 | 34 | none | 0.08 / 1.08 |
| medium:serial | detected only | run 1 | yes | spend_held 55 | project.concurrency | no / no (69) / no | 1/0/1 | run 9 | +0%, +31%, 0 (ref 0) | +0%, +26.9%, 0 (ref 0) | r6 checker: tier fast | none | 0 | 44 | none | -0.03 / 0 |
| medium:conflict | symptom healed | run 1 | yes | role_cooldown 4 | none | no / no (54) / yes | 2/1/1 | run 10 | +3.3%, +1.5%, 0 (ref 0) | +0.1%, +0%, 0 (ref 0) | r3 lead: prompt; r7 checker: tier fast | lead.prompt 349 chars -> 537 chars | 0 | 41 | none | 0.92 / 4.66 |
| medium:tool-friction | healed | run 1 | yes | none | none | yes / no (54) / yes | 2/1/1 | run 10 | +1.1%, +1.6%, 0 (ref 0) | +0%, +0%, 0 (ref 0) | r3 researcher: tools; r7 checker: tier fast | none | 0 | 41 | none | 0.08 / 1.55 |
| medium:prompt-bloat | healed | run 1 | yes | none | none | yes / no (54) / yes | 2/1/1 | run 10 | +0.2%, +0%, 0 (ref 0) | +0%, +0%, 0 (ref 0) | r3 writer: prompt; r7 checker: tier fast | none | 0 | 41 | none | 0.01 / 0.22 |
| medium:ceremonial | detected only | run 3 | no | none | none | no / no (60) / no | 1/0/1 | run 9 | +10.1%, +9.8%, 2 (ref 0) | +12.6%, +12%, 0 (ref 0) | r6 checker: tier fast; coordinator: tier fast | none | 0 | 51 | none | 14.04 / 14.22 |
| medium:skill-routine | detected only | run 3 | no | none | none | no / no (63) / no | 1/0/1 | run 9 | +16.9%, +8.9%, 0 (ref 0) | +16.7%, +8.6%, 0 (ref 0) | r6 checker: tier fast | none | 0 | 44 | none | 23.75 / 23.78 |
| medium:missing-specialty | missed | no finding kind | no | none | none | no / no (54) / no | 1/0/1 | run 9 | +14.8%, +15.5%, 0 (ref 0) | +14.4%, +14.6%, 0 (ref 0) | r6 checker: tier fast | none | 0 | 44 | none | 20.81 / 20.84 |
| medium:redundant-role | negligible here | no finding kind | no | none | none | no / no (54) / no | 1/0/1 | run 9 | +0.1%, +0%, 0 (ref 0) | +0.1%, +0%, 0 (ref 0) | r6 checker: tier fast | none | 0 | 44 | none | 0.1 / 0.13 |
| medium:missing-write | detected only | run 3 | no | none | none | no / no (67) / no | 1/0/1 | run 9 | +3.4%, +3.7%, 0 (ref 0) | +2.1%, +2.1%, 0 (ref 0) | r6 checker: tier fast | none | 0 | 44 | none | 4.72 / 4.76 |
| medium:guard-bloat | negligible here | run 1 | no | none | none | no / no (56) / no | 1/0/1 | run 9 | +0.2%, +0%, 0 (ref 0) | +0.2%, +0%, 0 (ref 0) | r6 checker: tier fast | none | 0 | 44 | none | 0.26 / 0.3 |
| medium:guard-tier-over | missed | no | no | none | none | no / no (54) / no | 1/0/1 | run 9 | +5.8%, +13.2%, 0 (ref 0) | +6.3%, +13.8%, 0 (ref 0) | r6 checker: tier fast | none | 0 | 44 | none | 8.05 / 8.08 |
| large:control | false positive | no finding kind | no | none | none | no / no (60) / no | 3/0/3 | run 32 | +0%, +0%, 0 (ref 0) | +0%, +0%, 0 (ref 0) | r6 quality-lead: tier fast; r10 checker: tier fast; content-lead: tier fast; r29 build-lead: tier fast | none | 0 | 51 | none | 2.08 / 0 |
| large:tier-over | detected only | run 3 | yes | none | none | no / no (64) / no | 3/0/3 | run 32 | +2.2%, +3.9%, 0 (ref 0) | +3.5%, +6%, 0 (ref 0) | r6 quality-lead: tier fast; r10 checker: tier fast; content-lead: tier fast; researcher: tier everyday; r29 build-lead: tier fast | none | 0 | 51 | none | 6.13 / 4.24 |
| large:tier-under | detected only | run 2 | yes | spend_held 37 | builder-a.staffing | no / no (79) / no | 3/0/3 | run 38 | +1.9%, +1.1%, 24 (ref 0) | +5%, +1.2%, 5 (ref 0) | r6 quality-lead: tier fast; r10 checker: tier fast; content-lead: tier fast; r35 build-lead: tier fast | none | 0 | 51 | none | 4.79 / 3.77 |
| large:effort-high | healed | run 1 | yes | role_cooldown 4 | none | yes / no (63) / no | 4/1/3 | run 32 | +0.5%, +2.4%, 0 (ref 0) | -1.2%, +4.3%, 1 (ref 0) | r6 quality-lead: tier fast; r10 checker: effort medium; content-lead: tier fast; r18 checker: tier fast; r29 build-lead: tier fast | content-lead.tier everyday -> fast; content-lead.model everyday -> fast | 0 | 51 | none | 1.09 / 0.95 |
| large:serial | detected only | run 1 | yes | spend_held 45 | project.concurrency | no / no (60) / no | 3/0/3 | run 32 | +0%, +63.8%, 0 (ref 0) | +0%, +50.7%, 0 (ref 0) | r6 quality-lead: tier fast; r10 checker: tier fast; content-lead: tier fast; r29 build-lead: tier fast | none | 0 | 51 | none | 2.08 / 0 |
| large:conflict | symptom healed | run 1 | yes | role_cooldown 4 | none | no / no (68) / yes | 4/1/3 | run 32 | +5.8%, +2.7%, 0 (ref 0) | +1.7%, +0%, 0 (ref 0) | r3 build-lead: prompt; r7 content-lead: tier fast; quality-lead: tier fast; r11 checker: tier fast; r29 build-lead: tier fast | build-lead.prompt 212 chars -> 400 chars | 0 | 50 | none | 3.28 / 11.27 |
| large:tool-friction | healed | run 3 | yes | none | none | yes / no (60) / yes | 4/1/3 | run 32 | +0.4%, +1%, 0 (ref 0) | +0%, +0%, 0 (ref 0) | r3 researcher: tools; r7 content-lead: tier fast; quality-lead: tier fast; r11 checker: tier fast; r29 build-lead: tier fast | none | 0 | 50 | none | 1.15 / 0.81 |
| large:prompt-bloat | healed | run 1 | yes | none | none | yes / no (60) / yes | 4/1/3 | run 32 | +0.1%, +0%, 0 (ref 0) | +0%, +0%, 0 (ref 0) | r3 writer: prompt; r7 content-lead: tier fast; quality-lead: tier fast; r11 checker: tier fast; r29 build-lead: tier fast | none | 0 | 50 | none | 1.12 / 0.2 |
| large:ceremonial | detected only | run 8 | no | none | none | no / no (62) / no | 4/1/3 | run 32 | +2.7%, +2.8%, 1 (ref 0) | +3.2%, +5.8%, 1 (ref 0) | r6 quality-lead: tier fast; r10 checker: tier fast; content-lead: tier fast; r17 coordinator: tier fast; r29 build-lead: tier fast | coordinator.tier everyday -> fast; coordinator.model everyday -> fast | 0 | 51 | gen_3 promoted | 5.55 / 5.27 |
| large:skill-routine | detected only | run 5 | no | none | none | no / no (67) / no | 3/0/3 | run 32 | +16.9%, +8.7%, 0 (ref 0) | +14.9%, +6.4%, 0 (ref 0) | r6 quality-lead: tier fast; r10 checker: tier fast; content-lead: tier fast; r29 build-lead: tier fast | none | 0 | 51 | none | 35.61 / 33.02 |
| large:missing-specialty | negligible here | no finding kind | no | none | none | no / no (60) / no | 3/0/3 | run 32 | +1.1%, +3.9%, 0 (ref 0) | +1.7%, +5.7%, 0 (ref 0) | r6 quality-lead: tier fast; r10 checker: tier fast; r29 build-lead: tier fast | none | 0 | 51 | none | 3.66 / 2.07 |
| large:redundant-role | negligible here | no finding kind | no | none | none | no / no (60) / no | 3/0/3 | run 32 | +0.1%, +0%, 0 (ref 0) | +0.1%, +0%, 0 (ref 0) | r6 quality-lead: tier fast; r10 checker: tier fast; content-lead: tier fast; r29 build-lead: tier fast | none | 0 | 51 | none | 2.22 / 0.14 |
| large:wrong-line | missed | no finding kind | no | none | none | no / no (61) / no | 3/0/3 | run 32 | +1.1%, +0.6%, 1 (ref 0) | +0.2%, +0%, 0 (ref 0) | r6 quality-lead: tier fast; r10 checker: tier fast; r29 build-lead: tier fast | none | 0 | 51 | none | 3.74 / 2.1 |
| large:missing-write | detected only | run 4 | no | none | none | no / no (73) / no | 3/0/3 | run 32 | +3.2%, +4.8%, 1 (ref 0) | +5.4%, +7.4%, 0 (ref 0) | r6 quality-lead: tier fast; r10 checker: tier fast; content-lead: tier fast; r29 build-lead: tier fast | none | 0 | 51 | none | 7.67 / 6.31 |
| large:guard-bloat | negligible here | run 1 | no | none | none | no / no (62) / no | 3/0/3 | run 32 | +0.1%, +0%, 0 (ref 0) | +0.2%, +0%, 0 (ref 0) | r6 quality-lead: tier fast; r10 checker: tier fast; content-lead: tier fast; r29 build-lead: tier fast | none | 0 | 51 | none | 2.37 / 0.28 |
| large:guard-tier-over | missed | no | no | none | none | no / no (60) / no | 3/0/3 | run 32 | +4%, +12.5%, 0 (ref 0) | +5.8%, +16.6%, 0 (ref 0) | r6 quality-lead: tier fast; r10 checker: tier fast; content-lead: tier fast; r29 build-lead: tier fast | none | 0 | 51 | none | 9.97 / 7.76 |

## Ranked gaps

Ranked by the simulated excess cost of the unhealed cases (the price of not healing over the horizon).

1. **Repeated procedure that should be a skill** (small detected only, medium detected only, large detected only; +$78.16). Could heal it today: the hybrid strategy drafts a skill (created disabled; a person turns it on), or the skills suggestion flow. What stops the unattended path: synthesizer.ts fromFindings: skill_crystallization is a note on the deterministic strategy; service.ts planFor drops new skills without the skills.setEnabled port, which host/bootstrap.ts does not wire (create, remove, readDraft only), so even a hybrid plan only reports them. Separately, skills/evaluate.ts toolSequenceFindings fires on any 4-call window seen in 3 of the last 20 runs, so ordinary routines raise the same finding on healthy charts (the controls).
2. **Role lacks a write tool it needs** (small detected only, medium detected only, large detected only; +$32.57). Could heal it today: a person, propose_org_change in a work run, or the Architect retrospective. What stops the unattended path: synthesizer.ts fromFindings adds only Read, Glob and Grep; ratchet.ts validateEvolutionPlan rejects the whole plan for any write or exec tool (write_tool_added / write_tool_to_readonly), also from the hybrid model.
3. **Missing specialty (root or lead does lookups itself)** (small missed, medium missed, large negligible here; +$32.26). Could heal it today: propose_org_change in a work run or the Architect retrospective. What stops the unattended path: telemetry.ts diagnose skips the root agent (isRoot) and has no finding for work a spawner does itself; ratchet.ts chartProblems rejects adding a role (chart_broken).
4. **Ceremonial layer (coordinator with one report)** (small made worse, medium detected only, large detected only; +$30.44). Could heal it today: propose_org_change in a work run or the Architect retrospective (a person approves the new chart). What stops the unattended path: synthesizer.ts fromFindings turns ceremonial_layer into a note only; ratchet.ts chartProblems rejects any change to reportsTo, spawnable or the role set (chart_broken), so no evolve strategy can remove a layer.
5. **Guard role (reviewer) on deep** (small missed, medium missed, large missed; +$26.79). Could heal it today: deterministic evolve if the review work were short; otherwise a person. What stops the unattended path: telemetry.ts diagnose: the over-provisioned rule needs short work (avg turns <= 6, output <= 4,000); a review of 9 turns never qualifies, so cost waste on long-work roles is invisible. Note the gate does NOT protect a guard role's tier (only its prompt, tool removals and skills).
6. **Tier under-provisioned (builder on everyday)** (small detected only, medium made worse, large detected only; +$15.53). Could heal it today: interactive `orgai org evolve --apply` with a person approving the raise (two generations), the hybrid strategy with approval, propose_org_change in a work run, or the Architect retrospective. What stops the unattended path: service.ts applyCore: the post-run pass never sets allowSpendRaise, so spend.ts holdSpendRaises strips every raise (rule spend_held). Even approved, synthesizer.ts fromFindings first proposes `staffing.minTier = current tier` (a floor equal to the ceiling, which changes nothing under goal balanced with no orchestrator request: runtime/staffing.ts resolveStaffing already runs at the ceiling); only the next generation raises the tier. The same hold means a tier CUT the engine promoted itself can never be undone unattended once it proves harmful (medium: checker.tier held). Gate rules seen: role_cooldown, spend_held. Held raises: builder-a.staffing, builder.staffing, checker.tier.
7. **Tier over-provisioned (lookup role on deep)** (small symptom healed, medium detected only, large detected only; +$12.78). Could heal it today: deterministic evolve (one step per generation). What stops the unattended path: telemetry.ts diagnose: the over-provisioned rule stops at everyday when effort is low (`!(runtimeTier === 'everyday' && role.effort === 'low')`) and never fires on fast; synthesizer.ts fromFindings steps one tier per generation and service.ts cooldownOf holds the role for COOLDOWN_RUNS (5) runs after each decision.
8. **Merge conflict hotspot (overlapping file scopes)** (small symptom healed, medium symptom healed, large symptom healed; +$4.76). Could heal it today: deterministic evolve treats the symptom (the fixed file-scope block in the spawner's prompt); the overlapping scope lines themselves only by hand or propose_org_change. What stops the unattended path: ratchet.ts validateEvolutionPlan accepts a prompt patch only as compressPrompt output or the fixed SCOPE block on the conflict's lead (prompt_not_subset), so the builders' own scope lines are never edited. Gate rules seen: role_cooldown.
9. **Wrong reporting line (analyst under the build lead)** (small n/a, medium n/a, large missed; +$3.74). Could heal it today: propose_org_change in a work run or the Architect retrospective. What stops the unattended path: telemetry.ts diagnose has no finding for "spawned through the wrong lead"; plain re-spawns (staffing source role) are counted as first passes; ratchet.ts chartProblems rejects reportsTo and spawnable changes (chart_broken).
10. **Guard role (reviewer) prompt bloat** (small negligible here, medium negligible here, large negligible here; +$2.95). Could heal it today: a person or the Architect retrospective (by design). What stops the unattended path: plan.ts isGuardRole protects review/verify/QA/audit/security/test roles; synthesizer.ts fromFindings notes it and ratchet.ts validateEvolutionPlan trims any prompt change (prompt_protected).
11. **Redundant role never used** (small negligible here, medium negligible here, large negligible here; +$2.42). Could heal it today: the Architect retrospective or a person; nothing measures an unused role. What stops the unattended path: telemetry.ts diagnose aggregates only agents that ran, so a role never spawned has no finding (unless its prompt passes 900 characters); ratchet.ts chartProblems rejects removing a role (chart_broken).
12. **Serial bottleneck (concurrency 1)** (small detected only, medium detected only, large detected only; +$2.05). Could heal it today: interactive `orgai org evolve --apply` with a person approving the concurrency raise. What stops the unattended path: spend.ts spendRaisesOf counts a higher concurrency limit as a raise; service.ts applyCore holds it on the post-run pass (spend_held). telemetry.ts spawnShape also reads only the ROOT's direct reports, so a chart whose leads fan out is measured on the leads, not the workers. Gate rules seen: spend_held. Held raises: project.concurrency.
13. **Tool friction (lookup role lacks Grep)** (small negligible here, medium healed, large healed; +$0.80). Could heal it today: deterministic evolve (adds Read, Glob or Grep). What stops the unattended path: ratchet.ts evaluateActiveTrial / compareMetrics judge a trial on whole-team medians of the next 3 runs whatever tasks they were, so a correct patch can be rolled back when those runs never used the role (small chart, seed 1); service.ts rollbackCore then records it with addRejected, which never expires, and deterministicPlan drops the same patch on every later pass.
14. **Effort too high (simple-work role on high)** (small negligible here, medium healed, large healed; +$0.68). Could heal it today: deterministic evolve on everyday/deep roles; nothing on a fast role. What stops the unattended path: telemetry.ts diagnose: the over-provisioned rule requires `tierDown(runtimeTier)` (deep or everyday), so effort waste on a fast role is never a finding; on an everyday role it fires only for short work (avg turns <= 6 and output <= 4,000 tokens).

## After the trial rework (2026-11-25)

Change: item 1 of "Three changes to make first" (trial rule 2, `src/main/evolve/ratchet.ts` "trial rule 2", `service.ts`;
ARCHITECTURE.md "Team evolution"). In short: a trial counts only runs that exercised the change and waits for 3 of them
(rolled back as inconclusive after 15 trial runs without them); it judges the patched role's own first pass, errors,
escalations and cost per agent, its reports' first pass, errors and escalations, and keeps today's whole-team rule as a
guard, all against a clean baseline fixed at apply time (no rolled-back trial window, no error run of a role flagged
under-provisioned); the service applies one role patch per generation and never cuts a role with reports; a trial's
rejection expires after 20 runs that used its roles, 40 after a second strike, never after a third or a person's rollback.
Detection was not changed here (item 2 is separate work), so the same findings drive both columns.

How it was measured: `npm run bench:heal -- --seed <n> --out <temp dir>` for seeds 1 to 3, before on 3c21900f and after on
the trial rework, plus an analysis of each `results.json` outside the repository for the figures the report does not
print (median runs from apply to decision; promoted cuts on a right-sized role, that is a promoted tier or effort cut on a
role the defect did not target, every such role being right-sized in the reference charts). The runner's blind-trial
window was changed first, in its own commit (83821518), to run from the apply to the pass that decided the generation;
on the old engine it gives the identical `results.json` for all three seeds (compared without `generatedAt` and `sha`).
It is still non-zero if a trial is decided although no patched role ran in any run of that window: an inconclusive
rollback at the cap on runs that never used the role, or a fault in the exercised-run rule (a role matched by the wrong
key, a root or limit rule counting runs it should not).

Status counts are over the 43 defect cases; generations over all 46 cases.

| Measure | seed 1 before | seed 1 after | seed 2 before | seed 2 after | seed 3 before | seed 3 after |
| --- | --- | --- | --- | --- | --- | --- |
| healed / symptom / negligible / detected / missed / made worse | 7 / 4 / 9 / 15 / 6 / 2 | 6 / 3 / 10 / 18 / 6 / 0 | 5 / 1 / 8 / 12 / 4 / 13 | 7 / 3 / 10 / 18 / 5 / 0 | 5 / 2 / 10 / 19 / 7 / 0 | 8 / 4 / 7 / 17 / 7 / 0 |
| generations applied / promoted / rolled back (on trial at the end) | 78 / 15 / 63 (0) | 77 / 9 / 67 (1) | 87 / 53 / 34 (0) | 75 / 13 / 62 (0) | 90 / 22 / 68 (0) | 75 / 14 / 61 (0) |
| blind trials (promoted) | 2 (1) | 0 | 1 (1) | 0 | 0 | 0 |
| rejected re-proposed, passes (cases) | 1463 (31) | 988 (31) | 1299 (31) | 785 (30) | 1493 (33) | 753 (31) |
| controls with a change: medium, large (a / p / r) | 1/0/1, 3/0/3 | 2/0/2, 2/0/2 | 1/0/1, 4/3/1 (worse) | 2/0/2, 2/0/2 | 1/0/1, 4/1/3 (worse) | 2/0/2, 2/0/2 |
| promoted cuts on a right-sized role | 4 | 0 | 43 | 0 | 12 | 0 |
| median runs from apply to decision (max) | 3 (3) | 4 (10) | 3 (3) | 4 (10) | 3 (3) | 4 (6) |

What moved, from the per-case rows:

- Harmful cuts: none promoted on any seed. Seed 2's large-chart lead cuts (quality-lead, build-lead, content-lead to
  fast in 12 cases) are no longer applied: the first rework run, before the `cut_on_lead` rule, still promoted them on
  windows with no failed step at all (for example large:control seed 2, gen_1 promoted with the lead's first pass 1 to 1,
  its reports' 1 to 1, no error), because their harm is retries of the reports that the run record does not attribute to
  the lead. The checker cut in the medium and large charts is now rolled back on its own figures ("the changed role:
  first pass fell 50 points") instead of on whole-team noise; small:ceremonial (seeds 1 and 2) and medium:tier-under
  (seed 1) are no longer made worse because the coordinator cut is not applied and the checker cut is rolled back.
- Made worse: 2 / 13 / 0 to 0 / 0 / 0. A first rework run with rejections expiring after 10 exercised runs was worse
  (22 / 21 / 13): known-harmful cuts were retried two or three times and their trial runs landed in the last-10 window;
  20 / 40 / never fixed it.
- Correct patches kept: small:tool-friction is healed on all three seeds (before: rolled back on seeds 1 and 3); medium
  tool friction and prompt bloat (seed 2) and large tool friction and prompt bloat (seed 3) are healed where they were
  negligible. Lost on seed 1: medium:effort-high and large:effort-high (healed before) and small:tier-over (symptom healed
  before): each correct cut passed its own-role rule and was rolled back by the whole-team guard on its three exercised
  runs ("team: cost x time worsened 34%" for the medium checker's effort, "1027%" for the small researcher's tier); the
  retry after the rejection expired was rolled back again by the same guard (medium:effort-high, run 40, "114%") or was
  still on trial at the horizon (small:tier-over, applied run 57). That guard is today's rule, kept so no cut is easier
  to promote than before; on three runs of a mixed task stream its medians are noisy.
- Rejected re-proposals fall by a third to a half but stay in the hundreds: in every medium and large case (controls
  included) the checker cut is rolled back twice (the second time after the 20-run expiry) and then backs off, and the
  synthesizer, which has no memory, rebuilds it on every later pass (23 to 30 passes per case). The measure counts the
  rejection working, not a fault.
- Trials take longer: median 3 to 4 runs from apply to decision, at most 10 (the cap of 15 was not reached in a decided
  trial; one seed 1 trial was still open at the end).
- Spend and safety: no raise is applied (passes that held a raise: 308 / 313 / 287 before, 311 / 318 / 301 after, the
  hold itself unchanged; the count is of passes, which shift with when trials open and close), no gate rule was
  loosened; the new rules only remove patches or add ways to roll back. A rejection expiring re-tries a change that once
  regressed, at most twice per fingerprint, each retry an ordinary trial.

Not changed and still open: the whole-team cost x time guard (above); detection (item 2) and a path to a person (item 3).
