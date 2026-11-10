# Claude Agent SDK facts

What was verified against SDK v0.3.312 by smoke scripts: task events, hooks, permission modes, worktree isolation, MCP servers added mid-session. Moved out of CLAUDE.md on 2026-11-07; see CLAUDE.md for the index.

- Claude Agent SDK facts verified against v0.3.312 (see `scripts/smoke-*.mjs`):
  - `task_started` (system message) arrives before the `SubagentStart` hook and carries `task_id` (= `agent_id`),
    `tool_use_id` of the spawning Agent call, `subagent_type`, `description`, optional `parent_task_id`.
  - The `toolUseID` argument of `SubagentStart`/`SubagentStop` hooks is a hook invocation id, not the Agent tool_use id.
  - Subagent assistant/user messages carry `agent_id` and `parent_tool_use_id`.
  - Subagents run in the background by default; the orchestrator's turn may end (`result`) and auto-resume when a report lands.
  - `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS=1` removes Explore/Plan/general-purpose so only org-chart roles exist.
  - Plan usage (`scripts/smoke-usage.mjs`, Max login): `q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })`
    answers right after init. `rate_limits.five_hour` / `.seven_day` are `{ utilization: 0-100, resets_at: ISO string }`;
    `seven_day_opus` / `seven_day_sonnet` were null and the per-model weekly window came as
    `rate_limits.model_scoped: [{ display_name: 'Fable', utilization, resets_at }]`. A `rate_limit_event` arrives on every
    normal request (status `allowed`); its `resetsAt` is epoch **seconds** and `utilization` a 0-1 **fraction**, and it
    carries an undocumented `unifiedWindows` map. Mapping lives in `src/main/runtime/usage.ts`. Probed again on
    2026-11-04 (`scripts/smoke-usage-probe.mjs`, token-free, same Max login): `five_hour` was null, `seven_day` and
    `model_scoped` (Fable) were present, new keys `seven_day_breakdown`, `weekly_scoped_shares`, `pace` (null) and
    `spend` appeared, and there was no `limits[]` in the control reply; `mergeUsage` therefore keeps a window only an
    event reported (e.g. five_hour from `unifiedWindows`) until its reset passes, instead of letting the next poll erase it.
    UsageMonitor observes every usage.status broadcast and merges the idle probe onto the newest Claude status the same
    way, so the row survives between runs until its reset (`usageMonitor.ts` `observe`, fed from index.ts `broadcast`;
    unit-tested only).
  - In-process MCP tools (`createSdkMcpServer` + `tool` with zod shapes) surface as `mcp__<server>__<tool>` in
    `PreToolUse`, `canUseTool` and `tools` lists. Under `acceptEdits` they still hit `canUseTool`, so the Claude
    adapter auto-allows `mcp__orgai__*`. A handler may block indefinitely; the model receives its returned text.
  - `PermissionMode` includes `'auto'` (a model classifier approves or denies each call and prompts through
    `canUseTool` only when it cannot decide) and `'dontAsk'` (deny anything not pre-approved). Bare `allowedTools`
    entries (e.g. `"WebSearch"`) approve the whole tool before `canUseTool` is consulted (warning
    `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`). Verified in `scripts/smoke-network.mjs` on haiku with a Max login: a whole
    spawn + ListAgents + SendMessage exchange ran under `auto` with zero `canUseTool` calls.
  - `AgentInput.name` injected from `PreToolUse` (`updatedInput`) makes a spawned agent addressable: `ListAgents` lists
    it as `worker-1 [ref] · worker · running`. The SendMessage input seen by hooks is
    `{ to, message, summary, type: 'message', recipient, recipient_kind: 'name' | 'main', content }`. A subagent
    cannot address the root by its role name: the main conversation's address is `"main"` ("No agent named
    'orchestrator' is reachable"). Messages to a report are queued for its next tool round; if it already finished it
    is resumed with the message. `network.ts` maps `main`/`orchestrator` to the root for the canvas.
  - Images (`scripts/smoke-images.mjs`, haiku, Max login): a streaming-input session that starts with a text prompt
    accepts a later user message whose `content` is `[{ type: 'image', source: { type: 'base64', media_type:
    'image/png', data } }, { type: 'text', text }]`, exactly what `claude.ts` `send()` pushes via `userContent()`.
    A 16x16 solid red PNG sent mid-session was answered "Red". Each turn emits its own `init` and `result`.
  - A SendMessage to a finished subagent resumes it, and the SDK emits `task_started` with `task_id` = that agent and
    `parent_task_id` = the messaging agent. A `task_started` for a known agent is therefore a resume, never a re-parent
    (`agentTree.resolveParent`). Observed in a persisted run record on 0.3.312; not yet reproduced by a smoke script.
  - Continuing a run resumes the chain's newest run; RunManager refuses while another live run holds the session.
    Unverified: whether a resumed session reports the same session_id (`forkSession: true` gives a new one); the chain
    therefore follows resumedFrom links and sessionId both (`runManager.sessionChain`). Verified by unit tests only.
- Worktree isolation (verified with `scripts/smoke-worktree.mjs`): `isolation: "worktree"` on an Agent call can be
  injected from `PreToolUse` via `updatedInput`. The CLI creates `<repo>/.claude/worktrees/agent-<id>` on branch
  `worktree-agent-<id>` from HEAD, confines Edit/Write to it, and leaves it behind uncommitted when the subagent
  stops. Registering `WorktreeCreate`/`WorktreeRemove` hooks makes the host responsible for creating/removing the
  worktree (the hook must return `worktreePath`), so do not register them just to observe. Commit and merge are
  the harness's job: `src/main/runtime/worktrees.ts`.
- MCP servers added mid-session (`scripts/smoke-mcp-midrun.mjs`, run once on 2026-11-02, haiku, Max login, about
  $0.014; results in its header):
  - In a main-thread `AgentDefinition.tools` whitelist, `mcp__<server>` and `mcp__<server>__*` admit that server's
    tools; `mcp__*` admits nothing (init tools []), and a subagent whose list is only `mcp__*` is refused at spawn
    ("would be spawned with zero tools ... unrecognized [mcp__*]").
  - `Query.setMcpServers` mid-session returns `{ added: [name], removed: [], errors: {} }`; `mcpServerStatus` right
    after shows the server 'pending' with no tools, and the next turn's init shows it 'connected'.
  - Whitelists are exact and fixed per query: with a whitelist that does not name the new server its tools never
    appear in init `tools`, the model is never offered them, and neither PreToolUse nor canUseTool fires. With `tools`
    omitted the new tool appears; the model reached it through ToolSearch, PreToolUse fired (agent_type main), then
    canUseTool (options carry `agentID` and `mcpServer`) and the call ran.
  - A subagent spawned after the add, with `tools` omitted, can call the new server even when its definition says
    `mcpServers: ['alpha']`: `AgentDefinition.mcpServers` does not restrict a subagent to the named servers.
  - Delegation gate facts (`scripts/smoke-delegation-gate.mjs`, SDK 0.3.318, haiku, 2026-11-08, variants A-D):
    `SubagentStop` returning `{ decision: 'block', reason }` keeps the subagent running, it acts on the reason, and its
    next stop has `stop_hook_active: true`. `PostToolUse` `hookSpecificOutput.additionalContext` on an `Agent` call
    reaches the calling model, for the root and for a subagent's own `Agent` call; `updatedToolOutput` did not reach the
    model. `PreToolUse` `updatedInput` with `run_in_background: false` makes `Agent` synchronous, in the order child
    `SubagentStop` -> `task_updated` -> `task_notification` -> parent `PostToolUse` -> `tool_result`; without it the call
    returns `async_launched` at once. Main-thread hooks carry `agent_type` = the root agent's name when `agent` is set, so
    use `agent_id` (absent on the main thread) to tell a subagent.
  - Not checked: `reloadSkills()`, `Options.skills` blocking, resume honouring new `agents`, and whether a resumed
    session keeps its session id or `total_cost_usd`.

## Verified against v0.3.318 by `scripts/smoke-staffing.mjs` (2026-11-09)

Haiku root, sonnet only where a check needs a second model or effort support; Max login. Model ids: `sonnet` resolves
to `claude-sonnet-5-5`, `haiku` to `claude-haiku-5-5` (`supportedModels()` is token-free). Hook input carries
`effort.level` on every tool call, and the default level was `medium` for the root and for subagents.

- Model through the hook, FULL id: NOT accepted. A `PreToolUse` `updatedInput.model = 'claude-sonnet-5-5'` on an
  `Agent` call is rejected by schema validation: the call returns an error tool_result "PreToolUse hook for Agent
  returned updatedInput that failed schema validation" with the allowed values `sonnet | opus | haiku | fable`, no
  subagent starts, and the model retries (same failure again). Only the four aliases pass through `updatedInput`.
- Model through the hook, alias: works. `updatedInput.model = 'sonnet'` over a definition that says `haiku`: the
  child's assistant messages carry `claude-sonnet-5-5` and `modelUsage` lists both models.
- Effort through the hook: works. Definition `effort: 'high'` (sonnet), hook sets `updatedInput.effort = 'low'`: the
  `PreToolUse` input for the child's own Bash call reports `effort.level = "low"`.
- Model and effort set by the model: works. Told to pass `model "sonnet"` and `effort "low"`, the root's Agent
  `tool_input` carried both; the child ran on `claude-sonnet-5-5` and its Bash hook input reported `low` (definition
  said `high` and haiku).
- Subagent effort from its definition (no override, definition `low`, sonnet): the child's Bash hook input reports
  `low` (the root's own level was `medium`).
- Root effort from its definition: NOT verified as working. `Options.agent = 'lead'` with a definition
  `effort: 'low'` (sonnet): the root's own Bash `PreToolUse` input reported `effort.level = "medium"`, not `low`. So
  an `AgentDefinition.effort` applies to a spawned subagent but, in this run, not to the main-thread agent chosen by
  `Options.agent`. `Options.effort` does set the root's effort (check 8): with `Options.effort: 'low'`, `model:
  'sonnet'` and no `Options.agent`, the root's Bash `PreToolUse` input reported `effort.level = "low"`; with
  `Options.agent: 'lead'` (sonnet, no `effort` field) plus `Options.effort: 'low'`, the root's own Bash call also
  reported `"low"`. So OrgAI sets the root's effort through `Options.effort`, not the root's definition.
- Effort inheritance (check 8b): with `Options.effort: 'low'` and a `worker` definition with NO `effort` field
  (sonnet), the worker's own Bash `PreToolUse` input reported `effort.level = "low"`: a report without an effort of
  its own inherits the session's `Options.effort` (it did not fall back to the default `medium`). One run, sonnet.
- Definition effort on a model without effort levels (check 9, 2026-11-10, one run): `supportedModels()` lists
  `claude-haiku-4-5-20251001` with no `supportsEffort` / `supportedEffortLevels` (every other row lists levels). A
  haiku root spawning a `worker` defined with `model: 'claude-haiku-4-5-20251001'`, `effort: 'medium'`: the subagent
  started, its assistant messages carry `claude-haiku-4-5-20251001`, its Bash ran, and its `PreToolUse` input had no
  `effort` (`effort.level` null). So an explicit effort on such a model is accepted and silently dropped, no error.
- OrgAI behaviour since this (Claude adapter, `claude.ts` `sessionEffort` / `reportEffort`; unit tests in
  `claude.test.ts` with the fake `query`, live facts from checks 5, 8b and 9 above): the work session passes the root
  role's effort as `Options.effort` (every build, so restarts and resumes keep it; no key when the root has none).
  Only when it does, a report role without an effort gets `effort: 'medium'` (`CLAUDE_SDK_DEFAULT_EFFORT`) in its
  definition so it stays at the default instead of inheriting the root's; written for any model, since check 9 shows
  it is harmless where effort is unsupported. Roles with an effort keep theirs; values a model does not take go
  through unchanged, as before. `buildCompletionOptions` sets no effort. Not live-checked end to end in a run.
- Parallel foreground spawns: works. Two Agent calls in ONE assistant message (same `message.id`), both forced to
  `run_in_background = false` by the hook, each child running `sleep 5` (about 7.5 s per child including model
  turns): SubagentStart at 1.3 s and 1.6 s, SubagentStop at 8.9 s and 9.2 s, so they overlapped almost completely.
  Sum of child durations 15.2 s, total wall 11.9 s (the rest is the root's two turns). The model put both calls in
  one message when told to in capital letters; without such an instruction that is not verified. The SDK emits one
  `assistant` message per content block, so count calls per `message.id`, not per message. Both receipts returned
  as separate `tool_result`s after their own `SubagentStop`.
- One-shot latency (haiku, same options as `buildCompletionOptions`: custom system prompt, `tools: []`,
  `maxTurns: 1`, `settingSources: []`, strict empty MCP; mirrored, the adapter was not imported; 5 sequential
  calls, ~60-word system prompt, one-word answer, all answered "solo"): total 2062 / 2502 / 3274 ms
  (min / median / max); median 1226 ms to the `init` message (process spawn and handshake) and 2019 ms to the first
  assistant message, so roughly half is process start and half model time. Above the 1.5 s median line in the
  design, so triage as a model call does not meet it on this machine.
