# Multi-provider org charts: bridged reports (phase 1)

Status: built 2026-11-07 in the main process, then the renderer (section "Renderer"). Verified by unit tests, fake
`query()`, a fake Codex app-server, the mock adapter and e2e/multi-provider.mjs. Nothing has run live.

## Problem

A project has one connection (`Project.provider.connection`), one run uses one adapter, and the adapter's child
process carries one `RunConnection` (env, key, base URL). Every Claude subagent shares the root CLI process and its
env.

Neither SDK can route a single subagent to another provider:

- Claude Agent SDK 0.3.312 `AgentDefinition` has no apiKey, baseUrl, provider or env field. The researcher checked
  this in the typings and docs on 2026-11-07.
- The Codex 0.166.0 app-server documents one configured provider per process. `thread/start` has a `modelProvider`
  field in upstream source, but mixing providers in one process is undocumented, so OrgAI does not rely on it.

## Design

### Contract

- `Role.connection?` sets the connection a role's agents run on. Read it only through `roleConnection(role, project)`
  (defaults.ts).
  - The root always runs on the project's connection; a `connection` on the root is ignored.
  - A role's model and tier resolve against its own connection's tier mapping and catalog (`roleTierContext`).
- `adapterForProject` fills `AdapterChoice.bridged` with `{ roleId, connection, adapter }`. A role is bridged when:
  - it is a non-root role on another connection, or
  - it sits on the root's proxy but its model family needs the other adapter.

  `mismatched` keeps its meaning, but only for roles on the root's connection. On mock projects, a role whose
  connection differs from the project's is bridged on 'mock'.
- `mixedFamilyRefusal` code is unchanged. Because mismatched proxy roles are now bridged, it refuses only when a proxy
  root has no model family, or when a built-in connection holds a role of the other family.
- `roleConnectionProblems(project, settings, statuses?)` lists roles whose connection is unknown, not configured or
  disconnected. Each entry carries one sentence, used by the UI and by the run refusal.
- `AgentInstance.connection` is set by RunManager on every agent.
- `RunUsage.connections` holds cost and agent count per connection. It is filled only when an agent ran on a
  connection other than the run's.

### Runtime

- RunManager (`resolveBridged`) builds one `RunConnection` per distinct (connection, adapter) at run start through
  `ConnectionService.runConnectionFor`.
  - The project's own API-key env var applies only to the project's own connection.
  - A role whose connection cannot be used refuses the work run before the run exists. The message names the role
    and the connection.
  - Setup-like, quick, single, virtual-project and trust-restricted runs never bridge.
- `runtime/bridge.ts` `BridgedSessions` starts a child `RuntimeSession` on the role's adapter with a derived
  `RuntimeContext`:
  - **Roles:** the role as the child's root, plus the roles reachable through its spawnable chain on the same
    (connection, adapter).
  - **Connection:** its own `RunConnection` only.
  - **Project:** the run's project with `isolateWriters: false`. Depth and concurrency are reduced by what the parent
    already uses; with no depth left, the child's roles cannot spawn.
  - **Continuation:** `autoContinue: false`.
  - **Child marker:** `bridgedChild` is set. Because of it, harnessToolsFor gives no 'root'-audience tools and the
    adapters build a report prompt (`PromptFlags.bridged`).
  - **Pass-through:** cards, rules, folders, folder config trust, MCP, skills, knowledge and notes go to the parent's
    hooks, with agent ids remapped.
  - **Refused:** proposals are declined, merge reviews are held, and a rate limit in the child only warns.
- The child's `run.*`, `plan.updated` and card events are dropped. Its root agent gets a fresh `ag_…` id under the
  delegating agent, with a unique handle and its connection. Its other agents become `<rootId>:<childId>`.
- The child completes when its root reports 'idle' and its settlement is quiescent. The final text, cut at
  `BRIDGE_RESULT_MAX_CHARS`, is handed back fenced as data. A failure resolves with "Bridged report failed: …".
- Interrupt, stop, End session, quit and teardown stop every child first. Children count as working, and they hold
  off exec settlement.
- Every secret of every `RunConnection` of the run is redacted from forwarded text. Card display fields are redacted
  too; tool input is not.
- Spawn checks happen in two places:
  - `bridge.spawn` checks the caller role's `canSpawn` and `spawnable`, plus depth and concurrency, counting native
    and bridged agents. While a spawning report is live, it refuses a caller it cannot identify.
  - Claude also checks `delegate_agent` in PreToolUse, using the hook's `agent_type`.
- Pricing: each agent is priced with its own connection's pricing record and tier aliases.

### Adapters

- **Claude:** a bridged role gets no `AgentDefinition`, so the CLI cannot spawn it. PreToolUse denies Agent / Task for
  its subagent_type with "<role> runs on <connection>: call delegate_agent instead". `delegate_agent` is an
  in-process MCP tool. The 0.3.312 typings say such calls are unbounded unless `MCP_TOOL_TIMEOUT` or the server's
  `timeout` is set.
- **Codex:** there is no `delegate_agent`. `spawn_agent` for a bridged role calls `ctx.bridge.spawn`, answers the tool
  call with the handle at once, and later delivers the result as the usual "Harness:" report message.
- **Mock:** the `[mock:bridged]` marker. The root calls `delegate_agent` for the first bridged role, and the child
  answers "Mock bridged report done.".
- **Architect:** `propose_org_chart` drafts may name a configured connection (`RuntimeContext.connectionModels`). Any
  other value is answered REVISE with the valid ids. The draft's tier maps through that connection.

## Limits (phase 1)

- **No worktree:** bridged writers work in the project folder, not a worktree, alongside the parent's merges.
- **One answer:** a bridged report answers once. It cannot be messaged mid-task (no SendMessage across sessions), and
  it ends after its first root turn.
- **No nested bridging:** roles under a bridged role on yet another connection are dropped from the child's chart.
- **Claude caller:** a Claude `delegate_agent` call carries no tool_use id, so `spawnToolUseId` is null.
- **Budget:** a child Claude query gets the project's `maxBudgetUsd` as its own cap. The run's exec budget still sees
  the child's cost through pricing.
- **Behaviour change:** proxy projects whose reports use the other model family now run those reports as bridged
  sessions on the other adapter. Before this change they went through the root CLI. This needs the proxy to serve
  `/v1/responses` for Codex, which is unverified.
- **UI:** built 2026-11-07, see "Renderer" below.

## Unverified live

- That a long `delegate_agent` call survives the Claude CLI's MCP idle timeout (`CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`)
  and its auto-background behaviour. Both were found only in the binary's text.
- That a Codex dynamic-tool answer and a later harness message behave as the fake server does.
- Real child sessions on Anthropic, OpenAI and a proxy at once, and `runConnectionFor` against real settings.

## Renderer

Built 2026-11-07 from the UX pre-walk (`ux-review-multi-provider-pre.md`, answers 1-4, findings H1, H2, M1-M4, M6).

### What was built

- **Helpers:** `lib/roleConnection.ts` (pure, unit-tested) rebuilds the defaults.ts input from connections:list
  (`connectionsViewOf`, `connectionStatesOf`) and words role problems in the panel's terms (`roleProblems`,
  `roleProblemText`). `ownConnection` is main's switch rule: a non-root role with any valid `connection` keeps it on a
  project switch, even when it equals the project's. `isPinned` means "differs from the project's" and drives tags.
- **Team role panel:** "Runs on" (`role-runs-on`), a native select, first in the Model fold above Model and Exact
  model. It never uses the word "Connection", which means MCP services in that panel (H2).
  - Shown with two or more enabled connections, or when the role is pinned. Never on the root.
  - Options: "Project default (<name>)" (clears `connection`), every other enabled connection ("(not connected)" when
    it is not), "<project's> (kept if the project switches)" for an explicit same-connection pin, and a removed or
    turned-off pin as its own option ("Removed proxy", "<name> (turned off)").
  - `role-runs-on-problem` (aria-invalid, aria-describedby) shows the problem sentence. `role-runs-on-hint` says the
    role bills and routes through the other connection, and what a change did to the model.
  - A change moves a tier role to the same tier there. A custom id the new connection does not serve, or a tier it
    does not map, falls back like Exact model's "Not set" (saved tier, Everyday, first mapped tier).
  - Model, Exact model, tier labels, the proxy grouping and hint, and `role-effort` follow the role's connection
    (`roleTierContext`, `adapterOnConnection`). `role-effort-unsupported` names it ("max is not used on OpenAI").
- **Chips:** `role-model-chip[data-connection]` reads "Everyday · OpenAI" only when the role runs elsewhere; its title
  and the node's aria-label say "Runs on OpenAI, not this project's default (Anthropic)". The Model fold summary adds
  the same tag.
- **Project settings > General > Connection:** the lead says it is the default for roles.
  `project-connection-roles-line` reads "4 roles use Anthropic by default · 1 runs on its own connection". Role models
  rows show each role's connection (`role-model-connection`). The remap dialog lists kept roles under "Not changed
  (each runs on its own connection)" (`remap-kept`, `remap-kept-role`). Undo restores models and tiers only, so pins
  are never touched.
- **Refusal:** `lib/remap.ts` `projectStartRefusal` gives role problems first, then `mixedFamilyRefusal`. Other-family
  roles on a proxy never refuse: `proxy-family-notice` says they run as bridged reports in their own session.
  `project-start-refusal` (Project settings) and `new-run-start-refusal` (New run: a warning, Start stays enabled, the
  run's own refusal is the truth, hidden in Ask mode) show it.
- **TierEditor:** its preview covers projects with any role on the edited connection, and only those roles, like main.
- **Live run:** `agent-connection` on agent cards (tooltip and sr-only text in compact styles), in the side panel agent
  line ("Runs on X") and in FinishedList, when the agent's connection differs from the run's.
- **Usage:** UsagePanel "By connection" (`usage-connections`, `usage-connection[data-connection]`) with two or more
  entries; costs through `Cost`, unknown never $0.
- **Copy:** the App settings Connections lead and the mock-adapter line no longer say one connection per project.

### Checked

- Unit tests: roleConnection, roleModels, remap (kept list, same-connection pins, mapping-edit scope, refusal).
- `e2e/multi-provider.mjs` (in e2e:free; mock, two mock proxies on `mock-proxy.example.com`, 1024x640 and 1600x1000,
  dark and light, no page scroll):
  - pin through `role-runs-on`, Project default clears it, the chip tag and title, the fold summary;
  - a `[mock:bridged]` run: the tagged agent finishes, the inspector names the provider and the run record holds
    "Mock bridged report done.";
  - the roles line and the switch preview's `remap-kept`;
  - with the proxy turned off: the refusals on Project settings and New run (Start enabled) and
    `role-runs-on-problem`, at every size and theme.
- Screenshots looked at by eye: the Team tab at 1024x640 light and the bridged run. The agent card tag was cut to one
  letter there; now the model gives way first, then the tag and the handle ellipsise (full text in their titles).

### Not seen or open

- A real second provider. The 'disconnected' live-status wording: main refuses only for unknown or not configured
  connections, so for a merely disconnected one the New run warning says more than the run does.
- The By connection table and compact node styles with a tag, by eye; screen reader output.
- Per-connection cost is always labelled computed (the contract carries no source or partial flag per connection).
- The remap notice after Apply lists only changes, not the kept roles.
- The role panel's nested scroller with its sticky header (pre-walk M5) is unchanged.
