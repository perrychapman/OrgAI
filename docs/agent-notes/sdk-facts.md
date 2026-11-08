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
  - Not checked: `reloadSkills()`, `Options.skills` blocking, resume honouring new `agents`, and whether a resumed
    session keeps its session id or `total_cost_usd`.
