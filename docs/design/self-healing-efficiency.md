# Self-healing efficiency: findings and fix plan (handoff)

Written 2026-11-25. Line references are against `dev` at `f8c409f1`. This document is the whole handoff: you should
not need the conversation it came from.

"Self-healing" here means everything that changes a project's team between runs without the user editing it by hand:
the org chart, which skills and MCP servers roles hold, and how each agent is sized and instructed.

## Read this with the bench

`docs/design/org-chart-self-healing-bench.md` (2026-11-19) measures how well the team evolution engine *heals*:
which defects it detects, fixes, misses or makes worse, with a token-free simulator (`npm run bench:heal`). Its
"Three changes to make first" cover the quality of the trial, detection and the path to a person.

This document covers what the bench does not: the **cost of each self-healing pass** (repeated disk reads and model
calls), the **Team review** (skill and MCP recommendations), the **retrospective**, and how the loops fail to share
data. Where the two overlap, the bench is the authority and this document only points to it.

## How the evidence was gathered

- The evaluation was first done on `main` at `79956c23`, then every finding was re-checked against `dev` at
  `f8c409f1` and the line references updated. One finding was already fixed on dev and is listed as such.
- **Read**: I read the code at the reference given, on dev.
- **Audit**: reported by a parallel read-only audit of `src/main/capabilities/`. That folder is identical on `main`
  and `dev`. I spot-checked the items marked "Read"; confirm an "Audit" item in code before you build on it.
- Nothing here was confirmed by executing code or tests.

## The four loops today

| Loop | Code | What it changes | Trigger | Model cost |
|---|---|---|---|---|
| Team evolution | `src/main/evolve/` (wired at `src/main/host/bootstrap.ts:746`) | Role tier, effort, staffing floor, read-only tools, skill grants, concurrency limit | CLI / TUI only: `exec --evolve`, `org evolve [loop]`, `org retro --unattended`, `/evolve` | None (deterministic) or one fast-tier call (`hybrid`) |
| Team review | `src/main/capabilities/service.ts` | Recommends existing skills / MCP servers per role (cards the user applies) | Automatic after every finished work run (`bootstrap.ts:439`, 3 s debounce), tab open, manual Re-check | One everyday-tier call, at most every `everyRuns` (default 3) |
| Skill evaluation | `src/main/skills/evaluation.ts`, `evaluate.ts` | Finds repeated routines and corrections, drafts new skills (user applies) | Manual only: Skills panel button, `skills:evaluate` | One everyday-tier call when there are gaps |
| Org retrospective | `src/main/setup/service.ts:244-283` (`setup:retro`) | Org chart structure, through Architect proposals | Manual only | A full Architect session |

The loops share no data. Each re-reads the same run records on its own.

## Findings

### A. Cross-cutting

- **A1. Three consumers re-parse the same finished run records.** (Read) `RunStore.getRecord`
  (`src/main/store/runs.ts:699`) does a synchronous `readFileSync` + `JSON.parse` of the whole record, transcript
  included (up to 5,000 entries), with no cache. Per finished work run:
  - Team review parses the newest 20 (`capabilities/service.ts:1068-1079`).
  - Evolution's post-run pass parses the newest 10 when no trial is open (`evolve/service.ts:341`, through
    `listRunRecords` at `bootstrap.ts:758`), and `diagnose` scans every transcript (`evolve/telemetry.ts:451-455`).
  - Skill evaluation parses the newest 20 when invoked (`skills/evaluation.ts:116-119`).
  A finished run does not change, so all but the newest record were already analysed on the previous pass. All of
  this runs on the main thread.
- **A2. The same analysis is implemented twice.** (Audit) `capabilities/evidence.ts:103-111` recomputes repeated
  tool sequences and repeated corrections, which `skills/evaluate.ts` also computes.

### B. Org chart

- **B1. Nothing changes structure automatically.** (Read) The evolution gate forbids `reportsTo`, `canSpawn`,
  `spawnable` and `requiredReports` (`evolve/ratchet.ts:75`). `ceremonial_layer` only adds a note to the plan
  (`evolve/synthesizer.ts:233`). The bench confirms it: every structural defect is "detected only" or "missed".
- **B2. The only structural path is a full Architect session over one run.** (Read) `retroContext` builds up to
  14,000 characters from a single record.
- **B3. The retrospective has no cross-run memory.** (Read) It is not given the evolution diagnosis, the ledger
  (`<dataDir>/evolution/<projectId>.json`) or the rejected hypotheses, so it can propose what was already tried and
  rolled back.

### C. Skill and MCP recommendations (Team review)

- **C1. Discovery and evidence run before the skip decision.** (Read) `runReview` calls `discoverSnap`
  (`service.ts:1088`) and `collectEvidence(recentRecords)` (`:1091`) before the skip block (`:1100-1112`), so every
  finished work run pays the full disk scan and 20 record parses even when the model step is certain to be skipped.
  Discovery has no mtime or digest cache (Audit: `:394-399`).
- **C2. The `noChange` skip never fires at the default setting.** (Read) `modelInput` is set only when the model
  step runs (`:1160`) and written only when set (`:1220`). A skipped review therefore saves a review with no
  `modelInput`, and the next eligible pass fails the `prev?.modelInput` test at `:1107`. With `everyRuns: 3` the
  model re-runs on identical input every third run.
- **C3. A failed model call still records `modelInput`.** (Audit; a test at `service.test.ts:691` is said to pin
  this) The next pass can then be skipped as `noChange` although no model answer was ever used.
- **C4. Run evidence never reaches the model.** (Audit; `buildRecommendPrompt` at `recommend.ts:104` takes no
  evidence argument) Permission denials, missing tools and repeated corrections only gate the skip and feed the UI.
- **C5. The prompt is unranked and can exceed the budget for good.** (Audit, partly inferred) All roles plus the
  first 150 recommendable candidates in discovery order (`recommend.ts:130`); with many candidates the estimate can
  pass the 20,000-token default and the step is skipped as `budget` every time, with no trimming. The prompt is also
  built twice per model pass (`:1109`, `:469`).
- **C6. No outcome feedback.** (Audit) Nothing in `capabilities/` checks whether an applied skill or server was ever
  used.
- **C7. Smaller items.** (Audit) Each apply triggers a full rediscovery (`:930`) and bumps `project.updatedAt`,
  defeating the 10-minute open throttle; pending cards never expire and `pendingFull` then blocks the model step;
  `readReview` (up to 8 MB) is read two or three times per pass; `dismiss` / `restore` write outside the per-project
  serial chain.

### D. Agent updates from run to run (Team evolution)

- **D1. The desktop app never runs it.** (Read) Nothing under `src/renderer` or `src/preload` calls evolve. A run
  gets a post-run pass only when started with `StartRunInput.evolve` (`runtime/runManager.ts:2047`), which only the
  CLI sets.
- **D2. Each no-trial pass diagnoses from scratch.** (Read) See A1. While a trial is pending the pass is cheap
  (summaries only, `evolve/service.ts:625-632`).
- **D3. It cannot change what an agent is told.** (Read) A prompt patch is accepted only when it is byte-equal to the
  engine's own duplicate-line removal or the fixed file-scope block (`ratchet.ts`, rule `prompt_not_subset` near
  `:373`). This is deliberate (run text must not reach prompts), but no lesson from a run ever lands in a role's
  instructions.
- **D4. Fixed on dev (a97d0833): the hybrid schema no longer asks for `prompt`.** Nothing to do.
- **D5. The hybrid call has no memo and no cooldown hint.** (Read) `buildDigest` (`synthesizer.ts:306`) does not list
  roles in cooldown, so patches for them are trimmed by the gate (`ratchet.ts:176`). `afterRunLocked`
  (`service.ts:655`) repeats the call on every no-trial pass while waste is at or above the threshold, also when the
  previous answer on the same digest was refused or empty. Dev already skips the call when every finding is advisory
  (`synthesizer.ts:434`); the general case is open.
- **D6. Slow, noisy trials; rejections never expire; one plan bundles unrelated patches.** (Read:
  `ratchet.ts:838`, `:876`, `:608`; `service.ts:597-599`) The bench measured this in depth (63 of 78 generations
  rolled back, 1,463 silent re-proposals). Use its "Three changes to make first", item 1; do not design this twice.
- **D7. Skill findings are stale.** (Read) Evolution reads `skillEvaluation.last(projectId)` (`bootstrap.ts:785`),
  which changes only when the user runs a skill evaluation. The bench also shows that when they are fresh,
  `skill_crystallization` alone keeps the waste score above the threshold.
- **D8. New skills from evolution are always dropped.** (Read) The host wires `skills.create`, `remove` and
  `readDraft` but not `setEnabled` (`bootstrap.ts`, the `skills:` block after `:785`), and `planFor` drops new skills
  without that port. The top-ranked gap in the bench (a repeated procedure that should be a skill) cannot heal.
- **D9. Hybrid spend is invisible on the Usage page.** (Read; stated in the code at `service.ts:120`).

## Fix plan

Ordered by value for cost. Steps 1 and 2 change no behaviour the user sees and cannot raise spend. Each step is one
change with its own tests; do not bundle them.

### Step 1. One per-run digest, computed once

Goal: every consumer reads a small cached digest instead of parsing a full record.

1. Add a pure module (suggested `src/main/store/runDigest.ts`) with `digestRun(record): RunDigest`. It holds only
   what the three consumers derive today, as counts and sanitized names, never raw run text:
   - what `evolve/telemetry.ts` takes per run: per-role aggregates (agents, first pass, errors, turns, tokens, cost,
     wall time, fan-out), escalations, failed receipts, plan width and spawn shape, conflict prefixes, tool-error
     counts by category, the repeat keys and the polling counts;
   - what `capabilities/evidence.ts` takes: permission denials, missing tools, rule requests, connection searches;
   - what `skills/evaluate.ts` takes: tool sequences, corrections, which skills were loaded.
2. Store it as a sidecar beside the record (the run's directory already exists for the image store), written lazily
   on first request and reused after. Key it by a `DIGEST_VERSION` constant plus something that changes when a run is
   continued (for example `endedAt` and the transcript length), so a resumed run is re-digested. Remove it in
   `removeRecord` / `removeProject`.
3. Give `RunStore` a `getDigest(runId)` and switch the consumers one at a time, each in its own change:
   `diagnose`, `collectEvidence`, then `evaluateSkills`. Delete the duplicated sequence / correction code in
   `evidence.ts` once it reads the digest (A2).
4. Keep `evaluateActiveTrial` / `measure` working from digests too, so settling a trial parses nothing.

Done when: after one finished run, a post-run pass plus a Team review parse at most one full record (the new run);
the existing unit suites for `evolve/`, `capabilities/` and `skills/` pass with unchanged expected values;
`npm run bench:heal` gives the same `results.json` for seed 1 as before the change (apart from `generatedAt`); a new
test shows a second pass makes no `getRecord` call for already-digested runs and that a continued run is re-digested.

Watch for: the bench drives `createEvolveService` with simulated records through `listRunRecords`, so keep that port
working (derive digests from records when the host gives no digest port). If the digest type goes in
`src/shared/types.ts`, that is a hot file: claim it first.

### Step 2. Team review: two bugs and the skip order

1. (C2) Persist what the last model step actually saw as a hash of (roles, recommendable candidate fingerprints,
   evidence), carried forward unchanged across skipped reviews. Compare against it for `noChange`.
2. (C3) Record it only when the model step succeeded. Update the test that pins the current behaviour and say so in
   the change description.
3. (C1) Decide the skips that need neither discovery nor evidence first (`autoFree`, `everyRuns`, `pendingFull` from
   the stored review), then run only the work whose result is used. The free path still wants fresh discovery for its
   cards; keep that behaviour.
4. (C7) Read the stored review once per pass and pass it down.

Done when: unit tests show (a) no model call on identical input at `everyRuns: 1` and `3`, (b) a failed call is
retried on the next eligible pass, (c) a pass skipped as `everyRuns` reads no run record.

Implemented (2026-11-25): see ARCHITECTURE.md "review (phase 2)" and `docs/agent-notes/assistants-skills.md` "Team
review skip order". Where the audit differed from the code: C1 is only half right (discovery is not wasted, every pass
saves it; the saving is the evidence reads, and a skipped pass now carries the stored evidence list), C3 is not a bug
as such (`modelInput` records which data class was sent, true after a failed call too; the bug was that `noChange`
read it, so it was replaced by a separate `modelSeen` written only on success; the test at `service.test.ts:691`
stays as it was), and C7's "two or three reads" is one read at the start plus the deliberate re-read before saving
(the third, the 'opened' throttle read, is now handed to the pass). `pendingFull` is decided after the pending list is
refined, not from the raw stored count, so its meaning is unchanged; it now precedes `noChange` / `budget` in the order
(only the reported reason can differ when two apply). Left open: discovery has no cache (C1, Audit), applies still
rediscover and bump `updatedAt` (C7), pending cards never expire, and `dismiss` / `restore` stay outside the serial
chain.

### Step 3. Evidence-driven, budgeted recommendations

1. (C5) Rank candidates with the existing keyword scorer (`fallbackRecommend`'s scoring) and trim the list to the
   token budget instead of skipping the step.
2. (C4) Add a fenced, single-line `key=value` evidence block to `buildRecommendPrompt`, following the existing rule
   that every untrusted string is one line inside a fenced section. Respect the proactive data classes
   (ARCHITECTURE.md "Capabilities"): local-machine items stay redacted on automatic reviews.
3. Build the prompt once per pass.

Done when: prompt-builder tests cover ranking, trimming to budget and the evidence block; the injection-shaped
fixtures in the existing recommend tests still pass.

### Step 4. Outcome feedback for applied skills and servers

Use the digest's "skills loaded" and MCP tool-use counts: after N measured runs (suggest 5) in which a role that holds
an applied item never used it, add a "not used since it was added" card offering removal. Never remove automatically.

Done when: a unit test shows the card appears after N unused runs, not before, and disappears once the item is used.

### Step 5. Tighten the hybrid call

1. (D5) List cooldown slugs in the digest as "do not change".
2. (D5) Memo by digest hash in the ledger: when the last hybrid answer for the same digest was empty or refused, use
   the deterministic plan and make no call.
3. (D9) Out of scope unless a helper-call usage ledger is added; leave the existing log line.

Done when: `synthesizer.test.ts` covers both; a service test shows two consecutive post-run passes on an unchanged
digest make one model call.

### Step 6. Give the retrospective the cross-run picture

Append to the retro session's context a short block from evolve `analyze` with strategy `deterministic` (no tokens):
waste score, the findings (already sanitized by `safeLine`), the last decided generations and the rejected
hypotheses, with the instruction not to re-propose rejected changes. Treat it as data inside the existing fencing
conventions (`promptDatum`). This is also the cheapest route for the structural defects the bench shows evolution
cannot touch.

Done when: a unit test shows the block is present, bounded, and absent when there are fewer than three measured runs.

### Step 7. Healing quality: follow the bench

Not designed here. Take the bench's "Three changes to make first" (trial judges the change, calibrated detection, a
path to a person) and its ranked gaps. Two additions from this evaluation:

- (D7) Refresh the deterministic half of skill evaluation (no model step) from the digest when a run ends, so
  evolution never reads stale findings. Nearly free after Step 1. Pair it with the bench's point that advisory
  findings must stay out of the waste score, or every chart will sit above the threshold.
- (D8) Wire `skills.setEnabled` in `bootstrap.ts` so a drafted skill is created disabled for the user to review
  instead of being dropped.

Each of these changes a spend or safety boundary file and needs the Reviewer, as the bench says.

### Step 8. Evolution on the desktop (needs the Reviewer and the owner)

Offer the post-run pass for desktop work runs, deterministic only, with the same unattended rule as today (spend
raises are held, never applied). Do not ship this before Step 7's trial fixes: the bench shows the unattended path
applying harmful cuts to healthy charts in two of three controls. It touches `runManager.ts` (hot file) and needs UI
for history and rollback, which does not exist in the renderer.

## Repo rules that apply to this work

- Read `.orgai/ARCHITECTURE.md` ("Capabilities (Team assistant)" and the "Team evolution" bullet) and the matching
  files in `docs/agent-notes/` before changing code; update them in the same change.
- `npm run typecheck` and `npm test` must stay clean. `npm test` spends no tokens. Run only the e2e scripts for the
  area changed: `e2e/cli-org-evolve.mjs` for evolution, `e2e/skills.mjs` and `e2e/assistants.mjs` for Team review and
  skills. Re-run `npm run bench:heal` for any change under `src/main/evolve/`.
- Hot files take one claim at a time through GitHub issues: `types.ts`, `ipc.ts`, `runManager.ts`,
  `preload/index.ts`, `defaults.ts`, `ARCHITECTURE.md`, `CLAUDE.md`, `package.json`. No issue was open with
  `status: in progress` when this was written. Steps 1, 7 and 8 are likely to touch a hot file.
- A change that can raise spend (defaults, ceilings, the staffing profile) needs the Reviewer. Steps 1, 2, 5 and 6
  lower or hold spend; Step 3 changes what is sent but stays inside the existing budget; Steps 7 and 8 need review.
- Work lands on `dev` through the usual gate; never push `main`. Dev CI was red when this was written (a fix run was
  in progress on `f8c409f1`): check it is green before pushing code. No Claude attribution lines in commits, PRs or
  issues.
- Record how each new fact was checked in the agent notes ("unit tested", "unverified live").

## Open questions for the owner

1. Is deterministic-only evolution on the desktop wanted (Step 8), and on by default or opt-in per project?
2. Should lessons from runs ever reach role prompts (D3)? Today the answer is a deliberate no. A reviewed-card path
   (like skill suggestions) would be the safe way to allow it.
3. Is automatic structural change of the org chart wanted at all, or should structure stay with the retrospective
   (Step 6 only)?
