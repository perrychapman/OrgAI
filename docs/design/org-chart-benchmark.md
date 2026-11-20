# Org chart benchmark

A tool for tuning how the setup Architect recommends an org chart, and how it heals one after a run. It scores what the
Architect produces on scenarios of rising complexity so a prompt or tool-definition edit can be judged by numbers instead of
by feel. The tool only measures; it does not change anything under `src/`.

Files: `scripts/bench-org-chart.mjs` (runner), `scripts/lib/org-bench/` (`scenarios.mjs`, `score.mjs`, `load.mjs`,
`session.mjs`, `report.mjs`, `selfcheck.mjs`, `canned.mjs`, `fixtures/sample-results.json`, the `*.test.mjs` files).

## What is measured

Two families, one runner, one scorer.

- **recommend**: the first org chart. The Architect gets what a real setup run gets (system prompt, setup tools, first
  message) and is asked to design a chart for a project of a known complexity.
- **retro** (self-healing): the project is already set up (`setup.state` complete), so `propose_org_chart` is in revision mode
  (unlisted roles are kept, `remove` drops roles). The Architect gets the retrospective first message with a condensed run
  record that has one planted defect, and is scored on whether it fixes that defect, touches nothing else, keeps unused roles
  and does not raise spend.

The code under test is the recommendation path: `architectPrompt(kind)` in `src/shared/setup.ts`, the setup tool definitions
(`SETUP_TOOL_DEFS`, `proposeOrgChart`, `draftRoleSchema`, `rolesFromDrafts`) in `src/main/runtime/harnessTools.ts`, and the
first message and hidden context `SetupService` composes (`src/main/setup/service.ts`, `profile.ts`).

## How to run

```
npm run bench:org                                  # same as --dry-run: prints the plan, no model, no network
node scripts/bench-org-chart.mjs --dry-run         # the plan, plus the real prompt and tool sizes loaded through jiti
node scripts/bench-org-chart.mjs --model <id> --label baseline            # LIVE: every scenario once (spends tokens)
node scripts/bench-org-chart.mjs --model <id> --scenario c1 --scenario r2 --max-usd 1   # a cheap pilot
node scripts/bench-org-chart.mjs --model <id> --family retro --repeat 3
node scripts/bench-org-chart.mjs --score bench-results/org-chart/<ts>/results.json     # re-score, token-free
node scripts/bench-org-chart.mjs --compare <before.json> <after.json>                  # deltas, token-free
```

Flags: `--model <id>` (required for a live run; there is no default), `--repeat <n>` (1), `--scenario <id>` (repeatable; any
family), `--family recommend|retro|all` (all), `--max-usd <n>` (5), `--out <dir>` (default
`bench-results/org-chart/<UTC timestamp>/`, git-ignored), `--label <text>`, `--timeout-sec <n>` (300 per session),
`--max-turns <n>` (30). `--self-check` is hidden: it imports the real source, runs the real `propose_org_chart` validation on a
canned valid and a canned invalid chart for both families, scores them, and drives the session code against a scripted fake
`query`. Run it before any paid run; it needs no login and makes no network call.

A run writes `results.json` (everything: label, git short sha, date, scorer version, every session with its captured chart or
revision, counts, cost and score) and `report.md`. It rewrites both after every session, so an interrupted run keeps what
finished.

### Spend warning

A live run starts one real model conversation per scenario per repeat (15 scenarios, 15 sessions at `--repeat 1`). Each
session carries the Architect system prompt (about 10,000 characters), ten setup tool definitions (about 11,000 characters), a
first message and the follow-up turns. The cost per session was not measured when this tool was written. Start with a pilot
(`--scenario c1 --max-usd 1`), read the reported cost, then size the run. `--max-usd` (default 5) stops new sessions once the
summed reported cost reaches it (the rest are recorded as skipped) and is also passed to each session as its own budget limit,
so one session cannot overshoot the remaining allowance. The reported cost is the SDK's estimate, not a bill. Without
`--model` the runner never contacts the model. It inherits this shell's Claude login, like `scripts/smoke-staffing.mjs`.

## How a session works

One session per scenario per repeat, in a fresh temporary folder (an "existing" scenario's fixture files are written into it
first).

- Built-in tools: Read, Glob, Grep only. No Bash, web, edits or sub-agents; `settingSources` is empty; turns and time are
  bounded.
- The harness tools are stubs on an in-process SDK MCP server named `orgai`, with the real names, descriptions and zod schemas.
  `propose_architecture` and `propose_org_chart` run the real handlers (so the real `APPROVED` and `REVISE` texts and the real
  validation, including `rolesFromDrafts`, apply). On a `REVISE` the round is counted. On the first valid org chart the
  session captures it and ends. `ask_user` answers "No preference, use your judgment." and is counted. In the retro family
  `complete_setup` runs the real handler and is a valid ending (the "nothing needs to change" answer). Every other setup tool
  answers "not available in this benchmark" and is counted.
- The Architect is told to interview first. When a turn ends with no captured answer, the scenario's `answers` text is sent as
  the next user message (retro scenarios send a short "propose the changes or call complete_setup" nudge), at most twice;
  then the session is recorded as `noChart` (recommend) or `noEnding` (retro). Prose question turns and `ask_user` calls before
  the answer are recorded.
- The session record keeps: scenario, repeat, model, the captured chart (the drafts as proposed and the normalized roles) or
  revision (the drafts, `remove`, and the chart before and after), rationale, revise rounds, questions, turns, duration,
  reported cost and token usage, errors.

All model output is data: it is stored, clipped and escaped in the report, never executed or followed.

## Scenarios

Each has `id`, `kind`, `setupKind`, `complexity` (1 trivial to 4 large), `brief` (what the user typed), `answers` (the reply
to the interview, ending "Go ahead and propose; use your judgment for anything else."), optional `files`, and `expect`.

| id | kind | setup | cx | what it is | expects |
| --- | --- | --- | --- | --- | --- |
| c1 | code | new | 1 | a one-file Python script | 1-3 roles, depth 1, no messaging, no top tier |
| c2 | code | new | 2 | a small TypeScript CLI and library with tests | 2-5 roles, depth 1, no messaging |
| c3 | code | new | 3 | a full-stack web app (UI, API, database, auth) | 4-8 roles, depth 2, some messaging, a reviewer |
| c4 | code | new | 4 | a multi-service platform (web, mobile, services, IaC, data pipeline, SOC 2 and GDPR) | 8-16 roles, depth 3, a middle layer, top allowed, a reviewer |
| c5 | code | existing | 2 | a small URL shortener service (8 fixture files) | 2-5 roles, depth 1, a reviewer |
| c6 | code | existing | 3 | a monorepo with web, api, infra and docs packages (11 fixture files) | 5-10 roles, depth 2, some messaging, a reviewer |
| e1 | engagement | new | 1 | one two-page memo for a food bank | 1-3 roles, depth 1, no developer |
| e2 | engagement | new | 3 | a multi-workstream hospital scheduling assessment, no coding | 4-8 roles, depth 2, a reviewer, no developer |
| e3 | engagement | new | 4 | a data migration across Shopify, NetSuite and Salesforce with coding in scope | 6-12 roles, depth 2, some messaging, a reviewer |
| r1 | retro | existing | 3 | missing specialty: the root wrote the database migrations itself (6-role chart) | a new database role (or an extended one); nothing else touched |
| r2 | retro | existing | 2 | a role lacked a tool: the tester was denied Bash seven times (3-role chart) | the tester gains Bash |
| r3 | retro | existing | 4 | a prompt misled a role: the web implementer edited the API and caused a merge conflict (11 roles, middle layer) | that role's prompt is confined to its brief |
| r4 | retro | existing | 3 | an over-provisioned role: a deep-tier researcher doing mechanical lookups (6 roles) | the researcher's tier goes down |
| r5 | retro | existing | 3 | a healthy run (6 roles) | no change: `complete_setup` or an empty change |
| r6 | retro | existing | 4 | seven roles went unused in a backend-only run (11 roles) | none of the unused roles removed or changed |

`expect` fields. Recommend: `roles {min, max}`, `maxDepth` (levels below the root), `cover` (capability groups: a name plus
regexes matched against a role's name, description, responsibilities and prompt), `forbid` (role-name regexes that must not
appear), `middleLayer`, `allowTop`, `maxDeepShare` (of non-root roles), `wantsReviewer`, `wantsMessaging` (`none`, `some`,
`any`). Retro: `mustChange` (entries naming a slug and what must change: `fields`, `toolsAdded`, `promptMatches`,
`promptNotMatches`, `tierChange`; or `newRole` with `cover` regexes), `mayChange` (slugs whose change is not collateral),
`mustNotChange`, `mustNotRemove`, `allowRemove`, `maxRolesListed`, `allowSpendRaise`, `expectNoChange`.

The scenarios live in `scripts/lib/org-bench/scenarios.mjs`; a saved results file is re-scored against them by id, so an
edited expectation changes old results on `--score`.

## The rubric

Every dimension is the mean of its checks' credit (0 to 1); a check that does not apply to a scenario is `na` and left out.
The session total is the weighted sum, 0 to 100. Every check has a stable id so failures can be counted across scenarios.
`SCORER_VERSION` (now 1) changes whenever a check, weight or threshold changes; compare runs only at the same version (a
`--score` or `--compare` always re-scores with the current one).

### recommend

| dimension | weight | checks |
| --- | --- | --- |
| validity | 15 | `chart-produced` (a session with no chart scores 0 overall); `revise-rounds` (minus 0.25 per REVISE round or tool error) |
| structure | 15 | `one-root`, `unique-names`, `reportsTo-exists`, `spawnable-exist`, `spawnable-covers-reports`, `manager-can-spawn`, `leaf-no-spawn`, `no-cycles`; judged on the drafts as the model wrote them, because normalization (`toRoles`) repairs a missing root or manager and would hide these |
| right-sizing | 20 | `role-count` (partial credit by distance from the range), `depth`, `middle-layer` (only when expected) |
| coverage | 15 | `cover:<group>` per expected capability group; `forbid:<name>` for unwanted roles (a developer in a no-coding engagement) |
| least-privilege | 10 | `readonly-no-write` (roles whose name reads reviewer, researcher, advisor, auditor, critic, inspector or assessor hold no Edit, Write or NotebookEdit); `messaging-matches` (SendMessage/ListAgents against `wantsMessaging`: none means none, some means at least one role but not all); `no-role-has-every-tool` |
| tiering | 10 | `root-deep` (top only when allowed, `inherit` earns half); `no-top`; `deep-share` (non-root roles on deep or top); `no-vendor-model-ids`; `reviewer-present` (a non-root role named review, audit, QA, quality, verify, critic or inspect, when wanted) |
| prompt-quality | 15 | `prompt-length` (60-160 words); `prompt-second-person`; `prompt-refs-document` (the architecture document, or the engagement document or charter for engagements); `writers-stay-in-brief` and `writers-report-files` (non-root roles with Edit, Write or NotebookEdit); `root-no-delegate-all` (code projects with a root that has reports; the engagement prompt asks the lead to plan and gate, so it is not applied there) |

Unscored, reported: a cost proxy (sum over roles of top 5, deep 3, everyday 1, fast 0.3; `inherit` counts as everyday), tool
counts (roles holding each tool), prompt word totals, `ask_user` calls and prose question turns before the chart, REVISE rounds.

### retro (`scoreRevision`)

A role "changed" when its tools, tier, prompt, description, responsibilities, `canSpawn`, reporting line or name differ after the
revision. Spawn-list entries for roles the revision added or removed are its own wiring and do not count. The comparison is
between the real chart before and the normalized chart the proposal would apply, so what is scored is what the user would get.

| dimension | weight | checks |
| --- | --- | --- |
| fix | 35 | one `fix:<slug>` or `fix:new-role:<name>` per `mustChange` entry: 1 when the change is what the defect needs; 0.4 plus a share when the right role changed but not as needed; for a new role, 1 for a new role that covers the work, 0.7 for an existing role extended to cover it, 0.3 for an unrelated new role; `no-change` when `expectNoChange` (the chart ended unchanged: `complete_setup` or an empty change) |
| minimality | 25 | `listed-cap` (roles listed in the call against `maxRolesListed`); `no-collateral` (changed roles outside `mustChange` and `mayChange`); `must-not-change`; `no-extra-roles` |
| stability | 20 | `unused-not-removed` (r6); `no-unprovoked-removal`; `root-intact`; `healthy-untouched` (r5) |
| spend | 10 | `no-tier-raise` (no kept role moved to a higher tier and no added role above everyday), unless `allowSpendRaise` |
| validity | 10 | `revision-ended` (a session that ends with neither `propose_org_chart` nor `complete_setup` scores 0 overall); `revise-rounds` |

Unscored efficiency figures of the healing session: turns, reported cost and duration; plus the change in the chart's cost
proxy (positive means every later run costs more).

## Reading the report

`report.md` has: a header (label, model, date, commit, scorer version, reported spend); a recommendation table (one row per
scenario: n, score, a percent per dimension, role count, depth, tier mix, cost proxy, asks, question turns, revise rounds, cost);
a self-healing table (score, the five dimensions, roles listed, roles before and after, cost proxy change, turns, revise
rounds, cost, time); **the lowest-scoring checks across scenarios with counts** (failed of total, mean credit, the scenarios
and one example), which is the list to work from; and one line per session (the roles and tiers proposed, or what changed).

Tuning loop: run a baseline with `--label baseline` (use `--repeat 3` on the scenarios that matter: a single sample is noise);
read the weakest checks; change the prompt or tool description; run again with a new label; `--compare` the two files. A check
that fails in several scenarios (for example `deep-share` or `prompt-length`) points at the prompt text; one that fails in a
single scenario points at that scenario's expectations as much as at the model.

## What is imported and what is mirrored

Imported from the TypeScript source through jiti (the `@shared` alias, no Electron, no build): `architectPrompt` and
`architectRole` (`src/shared/setup.ts`), `buildRolePrompt` and `composeFirstMessage` (`src/main/runtime/prompts.ts`),
`harnessToolsFor` (so every setup tool's real name, description, zod schema and handler, including `propose_org_chart` through
the unexported `rolesFromDrafts`, and `decisionText`), `SetupService.hiddenContext`, `displayPrompt`, `retroPrompt` and
`retroContext`, `profileRepo` (`src/main/setup/profile.ts`), `newProject` and `toRoles`. A prompt, schema or composer edit
changes what the benchmark measures. The benchmark builds the project through `newProject`, so, as in the app, a recommend
session holds the starter chart; since the 2026-11-19 tuning `hiddenContext` shows it only as one "starter placeholder chart
... carries no weight" line (no role list), and a retro session shows every role's tools, spawning and prompt as data.

Tuning of 2026-11-19 (after the baseline-* passes; no live pass run by its author): sizing guidance that scales with the work
(smallest chart, a root plus at most one checker for a one-file task, leads past about seven specialists or three busy
domains), messaging off by default, a 60-word prompt floor, Edit / Write roles told to keep to their brief's files and report
them, every prompt naming the architecture or engagement document, and revisions as patches (list a role by slug with only the
fields that change). The tool now resolves references by name or slug and returns REVISE for an unresolved one, and treats
an unknown slug in a first proposal as a new role (the likely cause of the fast tier's rejected first proposals: new roles
given invented slugs; the REVISE texts were not recorded, so this is inferred from the accepted second proposals).
`--self-check` adds a patch-style revision case (slug plus tools only).

Mirrored (restated; marked `MIRRORS` in the code):

- The Claude adapter's Architect agent definition (`agents` plus `agent`, the role's tools plus the `mcp__orgai__` names, model
  `inherit`) and the in-process MCP server (`buildHarnessServer`): `claude.ts` is not imported because it loads the whole
  adapter. `scripts/lib/org-bench/load.mjs`, `session.mjs`.
- `ALL_TOOLS` in `score.mjs` mirrors `TOOL_CATALOG`; `--self-check` compares them.
- The run record of a retro scenario is a compact spec expanded into the `RunRecord` fields `retroContext` reads; the
  condenser itself is the real one.

## Limits and what is unverified

- **No live session was run when this was written.** Verified without a model: the real source loads through jiti; the real
  `propose_org_chart` validation accepts the canned valid charts and refuses the canned invalid ones, in both families; the
  scorer on hand-written good and bad charts and revisions (`score.test.mjs`); the stub tools, the follow-up logic, the
  capture-and-end logic and the cost and usage recording against a scripted fake `query` (`--self-check`); the real SDK is used
  to construct the in-process MCP server. Never executed: the real `query()` call, how the CLI handles the options passed
  (`agents`, `agent`, `tools`, `allowedTools`, `disallowedTools`, `permissionMode: 'dontAsk'`, `persistSession`,
  `maxBudgetUsd`), a tool call arriving through the real MCP transport, whether `interrupt()` ends the turn with a result that
  carries the cost, and the exact message field names (taken from `scripts/smoke-staffing.mjs` and the SDK typings).
- If a session is aborted after the capture (the interrupt did not produce a result), its cost is the last reported one and
  `costExact` is false.
- A model that answers with plain prose and a chart in the text, instead of calling `propose_org_chart`, is a `noChart`.
- Coverage matches regexes against role text, including prompts; a root prompt that mentions testing counts as covering it. The
  groups are a proxy for "does the chart have this capability", not a judgment of quality.
- Prompt quality is judged by word counts and phrase patterns, not by reading the prompts.
- The scorer is deterministic, the model is not: use `--repeat` for anything you intend to act on.
- Retro scenarios plant one defect in a hand-written chart and a hand-written run record. They test the revision path the
  prompt describes, not whether real run records look like these. The weights make a fix with sprawl score about 80; read the
  minimality and stability columns, not only the total.
- The model that benchmarks and the model the owner runs setup on can differ: pass the setup model's id to `--model`.
- The "no-top" and "root-deep" checks encode today's prompt guidance (deep for the root, top rarely). If that guidance changes,
  change the scenarios' `allowTop` and the checks together, and bump `SCORER_VERSION`.
