# Required delegation: close the native-agent path and enforce receipts (v1)

Status: v1 for implementation. It condenses revision 7 after six rounds of review by Argon and Astra; the owner asked not to overbuild
for minor edge cases, so those are listed in §10 as known limits. Base: `origin/dev` at `aad5492d`. Author: Claude (Opus 5.5), 2026-11-08.

## 1. Problem and root cause

The hierarchy benchmark ran lead (`gpt-6.1-sol`) -> manager (`gpt-6-luna`) -> {policy, evidence} workers, plus a reviewer
(`gpt-6.1-terra`), on OrgAI's **Codex** adapter. In 7 of 8 trials no worker appears in the run, yet each manager claimed it
had delegated ("Confirmed: I spawned both policy and evidence and obtained both reports before synthesizing."). All answers
were still correct, so the results gave no sign anything was wrong. In the one good trial, the manager spawned both workers and caught a wrong worker result.

**Root cause (Phase 0, §3):** in all 7 bad trials the manager used **Codex's built-in multi-agent tools**
(`collabAgentToolCall` / `subAgentActivity`), not OrgAI's harness `spawn_agent`. OrgAI only logs a warning (`codexEvents.ts`
`otherItem` ~200) and continues, and the native agents never reach the chart. The lab had disabled `features.multi_agent(_v2)` and
confirmed the effective config, and native activity still fired. OrgAI's harness tool has the same name as Codex's native one
(`spawn_agent`), which is the likely trigger.

Two fixes, in this order:
1. **Close the invisible path** (§5.1). This is what failed in the trials.
2. **Enforce required delegation with runtime receipts** (§4, §5.2-5.7). Even with the path closed, nothing today requires a manager to
   delegate or checks its claim: `Role.spawnable` says who *may* spawn, not who *must*.

## 2. Goals (from the lab report's priorities)

1. **Enforce:** an agent whose role has required reports cannot complete until each one has run under it and handed back a report.
2. **Receipts, not assurances:** decisions use a ledger the host builds from runtime facts (child ids, parent links, delivered reports).
   Leads get a harness receipt line beside each report.
3. **One bounded correction:** the first non-compliant completion is refused, and the refusal names exactly what is missing. The second is accepted as **failed**,
   and the failure propagates.
4. **Mandatory vs adaptive:** required reports are opt-in per role, plus `--strict-delegation` for fixed-structure benchmarks.
   Adaptive agents are never blocked; the ledger records what they used and skipped.
5. **Traces:** tool entries keep their names and results.

## 3. Phase 0 findings (done)

Source: `orgai-performance-lab/runs/variety-screen-20261108T210849Z/{1,4,5,7,22,27,34,40}-hierarchy-mixed-diagnostic.json`. All 8 ran
on `codex` with one connection, `maxSubagentDepth: 2` and `maxConcurrentSubagents: 4`; the manager had `canSpawn` and `spawnable:
[policy, evidence]`; no spawn denials appear in the logs.

| Trial | Workers in run | Native multi-agent log lines | Manager |
|---|---|---|---|
| 1 trace-program | both, parent = manager | 0 | delegated via `spawn_agent`, caught a wrong worker result |
| 4, 5, 7, 22, 27, 34, 40 | none | 5 to 8 each (incl. `wait`) | claimed both workers ran |

The nameless, empty tool entries in the diagnostics come from the lab bridge: `orgai-host.mjs` `normalizeEvent` (~206) keeps only
`{ kind, text }` of each transcript block.

## 4. Model

### 4.1 `Role.requiredReports`

```ts
/** Role ids this role must delegate to every time one of its agents completes. Subset of `spawnable`; missing = adaptive. Enforced by the harness. */
requiredReports?: string[]
```

The sanitizer `cleanRequiredReports(role)` (`shared/defaults.ts`) keeps ids that are in `spawnable`, are not the role itself and are unique,
and returns `undefined` when empty or when `canSpawn` is false. Carry the field through every role read, write, merge, diff and
import/export path: `store/projects.ts`; team files (`teamFiles/doc.ts` front matter `required_reports`, `parse.ts`, `digest.ts`
`normalizeRole`, `project.ts` `teamKey` / `docFromProject` / `rolesFromDoc`, `gate.ts`); `harnessTools.ts` `propose_org_change`
schema, `rolesFromDrafts`, `reviseKeepingUnmentioned`, `mergeTemplateDrafts`; `setup/orgMerge.ts`; `setup/import/*`; `ai/draft.ts`;
`shared/view/orgDiff.ts`; CLI `org`/`team`. A run snapshots the obligations at start; later org changes affect later runs only.

### 4.2 `RunOverrides.strictDelegation?: true`

Every role that `canSpawn` requires its whole `spawnable` list, for fixed-structure benchmarks. It only adds requirements, so `operate` scope may set it.
Plumbing: `runOverrides.ts` `runOverridesArgs`, `store/runs.ts` `cleanRunOverrides`, `runManager.ts` `NARROWING_KEYS` (carried on
continuation), `orgai exec --strict-delegation`.

### 4.3 Ledger (RunManager-owned, persisted on `RunRecord.delegation`)

```ts
export type DelegationVerdict = 'ok' | 'adaptive' | 'failed'

export interface DelegationReceipt {
  childId: string; parentId: string; roleId: string
  completedAt: number; verdict: DelegationVerdict; reportChars: number
  delivered: boolean      // set only when the adapter confirms the report reached parentId
}
export interface DelegationAgentState {
  roleId: string; required: string[]
  phase: 'working' | 'waiting' | 'correcting' | 'done' | 'ended'
  corrections: 0 | 1     // whole run, never in RunPlan
  verdict?: DelegationVerdict
  missing: { roleId: string; why: string }[]
  nativeStrikes: number
}
export interface DelegationLedgerState {
  strict: boolean; obligations: Record<string, string[]>; problems: string[]
  agents: Record<string, DelegationAgentState>; receipts: DelegationReceipt[]
}
// AgentInstance.delegation (display, set by RunManager) and RunSummary.delegation { failed, corrected, nativeSpawns, rootVerdict }
```

A **valid receipt** for (parent P, role R) is the latest **delivered** receipt with that parent and role, whose verdict is not `failed` and
whose report is non-empty. RunManager applies adapter events synchronously, so its record is current when an adapter asks.

### 4.4 Decision (pure, `runtime/delegation.ts`)

`attempt(agent, ledger, { canCorrect, canWait })`:
1. no obligations -> `allow` (verdict `adaptive`);
2. compute `missing` (never spawned / still running / ended without a report / not delivered / its report failed);
3. a child still running and `canWait` -> `wait` (no budget used);
4. nothing missing -> `allow` (verdict `ok`);
5. `corrections === 1` or `!canCorrect` -> `fail`;
6. otherwise -> `correct` (`corrections = 1`).

`canWait` and `canCorrect` are false when the session has ended or the run is held, limited or stopping.

### 4.5 Preflight

`delegationPreflight` reports obligations that cannot be met: a required role deeper than `limits.depth`; a chain longer than
`limits.concurrency` on Claude (receipt-bearing spawns run in the foreground) or needing more than 2 slots on Codex; a required edge
that crosses into a bridged role (not supported in v1, §10). `orgai exec` refuses such a run (outcome `delegation-incomplete`,
exit 3) before the session starts; an interactive run starts with a warning.

## 5. Enforcement

### 5.1 Close the Codex native multi-agent path (ships first)

1. **Rename the harness network tools** to avoid the collision: `spawn_agent` -> `spawn_report`, `send_message` -> `message_agent`,
   `list_agents` -> `list_team` (`NETWORK_TOOLS`, `codexAgents.ts` specs and notes, prompts, the `delegate_agent` refusal text in
   `harnessTools.ts` ~2630, tests, e2e). One helper, `canonicalNetworkTool(name)`, maps old names to new ones before the role check,
   `callNetworkTool` and the transcript mapping, so threads saved before the rename (resume strips `dynamicTools`) still work.
2. **Disable the native features** at app-server launch (`-c features.multi_agent=false -c features.multi_agent_v2=false`).
3. **Detect and stop:** `codexEvents.ts` emits `{ type: 'nativeSpawn', threadId, tool, itemId }` once per item id, on
   `item/started` for `collabAgentToolCall` / `subAgentActivity`, and logs it in the transcript as `codex:<tool>` with an error
   result. The adapter interrupts that agent's turn and counts **one strike per turn**. The interrupt's `turnCompleted` is tagged
   so it does not run normal end-of-turn handling. Strikes 1 and 2: send the agent "Harness: Codex's built-in multi-agent tools are not
   available in OrgAI and their agents do not count. Delegate with spawn_report (role exactly as listed); the harness records only
   those reports." Strike 3: the agent fails (release its network slot, state `error`, report the failure to its parent; for the
   root, end the session). `deliverTo` refuses deliveries to an agent in `error`.
4. **Foreign threads:** `agentOf()` no longer maps unknown threads to the root. Turns on threads that are not OrgAI's are interrupted, and their
   tool calls and approval requests are refused. Their events are logged, never attributed to an agent.
5. **Outcome:** any native use shows on the run (`nativeSpawns`), and under `strictDelegation` ends it `delegation-incomplete`.
6. **Probe** (`scripts/probe-codex-native-agents.mjs`, `gpt-6-luna`, the lab's chart): 10 runs with the old names and 10 with the new. It records
   native item counts and raw tool names, and whether the manager uses `spawn_report`. The results go in `docs/agent-notes/connections-mcp.md`.

### 5.2 Gate API (`RuntimeContext.delegation`, implemented by RunManager)

`noteSpawn(childId, parentId, roleId)`, `completion(agentId, { canCorrect, canWait, reportText }) -> { action, text? }`,
`ended(agentId)`, `delivered(childId)`, `receiptText(childId)`. RunManager also treats `agent.remove` of a ledger child as `ended`.

### 5.3 Texts

- **Correction:** "Harness: you cannot finish yet. Your role (Manager) must delegate to Policy Analyst (`policy`) and Evidence
  Reviewer (`evidence`) and receive their reports. The run has no such record under you: `policy` never spawned; `evidence` ended
  without a report. Spawn them now with <spawn tool>, wait for every report, then finish. Do not describe work the harness has no
  record of. This is the only reminder: if you finish again without them, your report goes to your lead marked as failing the
  required delegation."
- **Receipt line** (before each delivered report from a role that can spawn): "Harness receipt for luna-1 (Manager): required policy ✔
  policy-1, evidence ✗ never spawned. Trust this record over the report's own account of what it delegated."
- **Failure line:** "Harness: luna-1 (Manager) FAILED its required delegation: evidence never spawned. Its report below is unsupported
  on those points."

### 5.4 Claude adapter (SDK facts verified 2026-11-08, `scripts/smoke-delegation-gate.mjs`, SDK 0.3.318)

Verified: `SubagentStop` `{ decision: 'block', reason }` keeps the subagent going and it acts on the reason; `PostToolUse`
`additionalContext` on the root's `Agent` call reaches the parent model (`updatedToolOutput` does not);
`run_in_background: false` via `PreToolUse` `updatedInput` makes the spawn synchronous, in the order child `SubagentStop` ->
`task_notification` -> parent `PostToolUse`.

- `PreToolUse`: force `run_in_background: false` when the target role is required by the caller or has obligations itself.
  `task_started` for an unknown agent -> `noteSpawn`.
- `SubagentStop`: `completion(...)`. On `wait` or `correct`, return `block` with the text. `allow` behaves as today. On `fail`, mark the agent done with
  activity `Skipped required reports` and hold its worktree (§5.7).
- `PostToolUse` on `Agent`: `delivered(child)` and return `receiptText` as `additionalContext`.
- `task_notification` does not finish an agent a second time, and does not overwrite the state of an agent whose ledger phase is `done`.

### 5.5 Codex adapter and mock

`childTurnCompleted(A)`, completed turn -> `completion(A)`:
- `wait`: hold A's report and park A (it does not count against concurrency). Each child hand-off starts a new turn for A, and that turn's
  completion is evaluated again. If A's last running child ends without a hand-off (interrupted or removed), re-evaluate A with the held report.
- `correct`: hold the report and send the correction to A's thread.
- `allow` / `fail`: deliver `receiptText` (+ failure line) + report to the parent. `deliverTo` now returns the real send promise
  (for the root as well), and `delivered(A)` is recorded only when it resolves.

An interrupted or failed child -> `ended(child)`. The mock adapter mirrors this, with markers `[mock:delegation-ok]`, `-fix`, `-skip`,
`-claim` and `-native`.

### 5.6 The root

- `complete_plan` runs the root check provisionally: `wait` / `correct` -> REFUSED with the text (the plan stays active); `fail` is accepted and
  recorded.
- **Every terminal path** (`run.status: 'finished'`, exec settle, stop, error) calls `finalizeDelegation`: descendants still
  open are `ended` first, then the root is evaluated against the current ledger with `canCorrect: false, canWait: false`. A root
  with valid receipts that never called `complete_plan` is `ok`.
- **Exec quiescence:** if the root has missing reports and its correction is unused, send the correction (a harness message
  that does not count as an auto-continue) and stay live; the next quiescence finalizes.

### 5.7 Worktrees

A `fail` verdict for an agent with obligations calls `integrator.holdFailed(agentId, reason)`, using today's `held` status with
`heldBy: 'delegation'`. Nothing is merged, and `integratePendingNow` and `integrate_worktrees` skip it in this session. The parent is told
the branch was held.

### 5.8 Outcome and live updates

- `execOutcomeFor` gets `rootVerdict`, `subtreeFailed` and the strict native count, at both call sites (`runManager.ts` ~2328, ~2394).
  New outcome **`delegation-incomplete`**: exit 3, `endedBy: 'policy'`, ordered after `blocked`. Add it to the `ExecOutcome` tables, CLI
  rendering and `cli-spec.md`.
- `subtreeFailed`: an agent with obligations whose verdict is `failed`, or that `ended` without completing, unless a later valid receipt
  for the same (parent, role) replaced it.
- A new event `run.delegation { runId, summary, agents }` is emitted on ledger changes; the renderer and TUI stores apply it.

## 6. Prompts and UI

- `prompts.ts`: a role with obligations gets "You must delegate to X and Y and wait for their reports before you finish; the
  harness checks the run's record." Leads get "trust the harness receipt over a report's own account."
- Role inspector: a "Required" checkbox per spawnable report (`data-testid="role-required-report-<slug>"`).
- Live view and TUI: badges "Skipped required reports", "Corrected", "Used native agents".

## 7. Traces

- Lab side (phase 7L): `normalizeEvent` keeps `name` / `input` / `id` on `tool_use` and `toolUseId` / `content` / `isError` on
  `tool_result`, plus `run.finalized` (outcome) and `run.delegation`.
- OrgAI side: an empty `tool_use` name is stored as `unknown` with a warn log.

## 8. Verification

- **Unit** (vitest): the decision table; preflight; receipt validity; `subtreeFailed`; the ledger (correction once then fail,
  persistence); Claude hooks with a fake SDK (foreground rewrite, block then fail, receipt via `additionalContext`); Codex (native
  item -> interrupt, message, strikes, third-strike failure; renamed tools and aliases; wait, correct and fail; root delivery
  promise); the root (no plan, valid receipts without `complete_plan`, exec correction then fail); `holdFailed`; round trips
  for §4.1 and §4.2.
- **e2e** (mock): `team.mjs` (checkbox), `runs.mjs` (skip, fix and native badges), `cli-exec.mjs` (`--strict-delegation` + skip -> exit 3).
- **Live:** the native-agent probe (§5.1); one line added to the Claude smoke for a subagent's `additionalContext`.
- **Acceptance:** re-run the lab's 8 hierarchy trials on the new build with `--strict-delegation`. Each trial either shows both workers under the
  manager with delivered receipts, or ends `delegation-incomplete` with the cause recorded. None ends `completed` without them.

## 9. Delivery plan (Sonnet workers, medium effort; one owner per hot file per phase)

| Phase | Work | Depends |
|---|---|---|
| 1n | §5.1 native path (Codex): rename + aliases, feature flags, detect and stop, foreign threads, probe | - |
| 1 | Types, `delegation.ts`, ledger, `execSettle.ts`, `cleanRequiredReports` | - |
| 2a | §4.1 / §4.2 round trips and plumbing | 1 |
| 2b | RunManager gate, preflight, `finalizeDelegation`, outcome, `run.delegation`; `complete_plan`; prompts; mock | 1 |
| 3 | Codex enforcement (§5.5) | 1n, 2b |
| 4 | Claude enforcement (§5.4) | 2b |
| 5 | UI, TUI, e2e; `holdFailed` | 2a, 2b |
| 7 | Docs (`cli-spec.md`, agent notes, `sdk-facts.md`, ARCHITECTURE) | all |
| 7L | Lab bridge (`orgai-host.mjs`; back it up first, not a git repo): new tool names in the allowlist (~430) and routing (~413), prompt text (~539), `strictDelegation` (~708), `normalizeEvent`; then the acceptance re-run | 1n, 3 |

1n and 1 run in parallel; 1n can ship alone. Each phase passes typecheck, the whole unit suite, the build and its area's e2e, and is pushed to dev.

## 10. Known limits (v1; revisit if a benchmark or user hits them)

From review rounds 4-6. Not handled in v1:
- obligations inside **bridged** child sessions (preflight refuses strict exec runs that need them);
- **continued runs** start with a fresh ledger: no carried receipts and no sticky strict native count across a usage-limit
  auto-resume;
- **held-branch persistence** across sessions (a later session's `integrate_worktrees` can merge a delegation-held branch);
- crossed **resume/notification** ordering on Claude (matching by SDK `run_id`), and Claude **background** spawns of non-required
  roles (no receipt line);
- Codex delivery **transport failures** to a waiting parent (the exec stall watchdog ends such a run);
- bridge **concurrency allocation** in preflight; deferred corrections while held (held runs simply fail the check).

The full revision 7 with these designs is archived in the review log for this work (scratchpad `spec-r7-full.md`) if any of them is needed later.

## 11. Review summary

Argon and Astra reviewed six revisions (about 100 findings in total). Rounds 1-3 fixed real design holes: the root gate, a host-owned ledger,
foreground spawns, receipt identity, and preflight. Rounds 4-6 were mostly lifecycle edge cases, now in §10. Phase 0 and the Claude
smokes replaced assumptions with facts.
