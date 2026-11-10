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
  - `SubagentHandback` (SDK 0.3.318, haiku, 2026-11-10; `scripts/smoke-delegation.mjs handback`, one run, plus the lab
    run `phase1-20261110T073250Z/03-ledger-orgai-claude-required-p1-r1` events): in permission mode `auto` a subagent
    reports by calling the built-in tool `SubagentHandback({ message })`; in `default` mode it is not offered and
    subagents end with plain text (`smoke-delegation-gate.mjs A`, same day). The call delivers the report to the caller
    when it runs and ends the subagent's turn. Hook order: `PreToolUse` (with the subagent's `agent_id`) -> `PostToolUse`
    (`tool_response` `{ success: true, message: 'Report delivered to your caller.' }`) -> `SubagentStop` with no
    `last_assistant_message` -> `task_notification` (`handback: 'send'`, `handback_report: { text }`, and a `summary`
    that is a harness note, not the report). The parent's `Agent` result says the report "was delivered to you as a
    message" and carries `handback`. A `PreToolUse` deny of the call reaches the subagent as a tool error; it acted on
    the reason (spawned the worker) and handed back again successfully. A `SubagentStop` block after a successful
    handback is ignored: the subagent did not continue and the parent acted on the first report. A subagent that ends
    with plain text in auto mode gets repeated `SubagentStop`s (`stop_hook_active: true`, the CLI asks it to hand back);
    if it never does, its `Agent` result has `handback: 'withheld'` and says no report was delivered. OrgAI therefore
    takes a report from the subagent's successful `SubagentHandback` (`PostToolUse`), gates required reports at its
    `PreToolUse` (provisional), and never blocks at `SubagentStop` once a report was handed back.
    Unverified (read from the bundled CLI, not run): the root's call (no handback contract) answers `success: false`
    ("not active for this agent"); a second handback to the same caller answers `success: false` ("already
    delivered"); whether a resumed agent may hand back again; `CLAUDE_CODE_DISABLE_SUBAGENT_HANDBACK` turns the tool off.
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
- Tier variable on a subscription login (check 10, 2026-11-10, two runs: the first put (a) and (b) in one session and the
  SDK stream carried no child assistant messages, so the child model could not be attributed; the second used one session
  per spawn and read the child model from `modelUsage`): haiku root, Max login, no `ANTHROPIC_BASE_URL`, `env` with
  `ANTHROPIC_DEFAULT_SONNET_MODEL=claude-haiku-4-5-20251001`. (a) a subagent definition without a model, hook
  `updatedInput.model = 'sonnet'`: spawned, `modelUsage` listed `claude-haiku-4-5-20251001` (the mapped id) and no
  sonnet. (b) a definition with `model: 'sonnet'`, no hook change: spawned, `modelUsage` again the mapped id, no
  sonnet. (c) control, same hook without the variable: `modelUsage` listed `claude-sonnet-5-5`. So the variable DOES
  redirect the `sonnet` alias on a subscription login, from the hook and from a definition. Caveat: the child model
  comes from `modelUsage` (root model plus the one extra id), not from child `message.model`, which this SDK stream
  did not emit for subagents in these sessions. A further run of the final script gave the same three results. Only
  `sonnet` on a Max login was tested: the other three variables and an API-key login are unverified. The control also
  shows the bare aliases today: `sonnet` is `claude-sonnet-5-5`, and `supportedModels()` resolves `fable` to
  `claude-fable-5-1`, not the default model `claude-fable-5-2`, so an alias is not always the newest model of its family.
- OrgAI behaviour since this (Claude adapter, `claude.ts` `sessionEffort` / `reportEffort`; unit tests in
  `claude.test.ts` with the fake `query`, live facts from checks 5, 8b and 9 above): the work session passes the root
  role's effort as `Options.effort` (every build, so restarts and resumes keep it; no key when the root has none).
  Only when it does, a report role without an effort gets `effort: 'medium'` (`CLAUDE_SDK_DEFAULT_EFFORT`) in its
  definition so it stays at the default instead of inheriting the root's; written for any model, since check 9 shows
  it is harmless where effort is unsupported. Roles with an effort keep theirs; values a model does not take go
  through unchanged, as before. `buildCompletionOptions` sets no effort. Not live-checked end to end in a run.
  Run staffing at spawn (spec 4.3; `claude.ts` `staffSpawn`, unit tests "run staffing at spawn" in `claude.test.ts`
  with the fake `query`, live facts from checks 1 to 4 and 10): each `ClaudeSession` holds one `StaffingBook`. For a
  native spawn that passed every denial the hook calls `decide` under the Agent call's `tool_use_id` (the parent is the
  hook's `agent_id`; a tier from an alias or tier name on the call and a valid effort are the `onCall` request; the plan
  guard is its `planGuard` input). The call's final `model` is `CLAUDE_TIER_ALIAS[tier]`, and only when the
  connection resolves that alias (`aliasTarget`: its `ANTHROPIC_DEFAULT_<ALIAS>_MODEL` variable; on a proxy only a
  tier its map names, since the variables come only from that map and the CLI would otherwise send its own native id;
  on the Anthropic connection always, natively), in these cases: the plan guard steered the spawn, or an automatic
  role is moved off the tier its definition runs on, or an automatic (or steered) `inherit` role has a known tier the
  resolver did not reach through its `unmapped` fallback. A report the root spawns on the root's own live tier gets no
  key: for a spawn by the root `inherit` is the main model under either reading, so it keeps the root's exact model (a
  pinned id such as `claude-opus-4-1` included). Otherwise no key. A role's tier is read one way in the resolver and the adapter
  (`staffing.ts` `roleModelTier`): the definition sends `role.model`, so an alias or tier name in it decides before
  `role.tier`. The root's tier is read live (`switchModel` changes it). An automatic role always gets an explicit
  effort, the resolved one or `medium` (`CLAUDE_SDK_DEFAULT_EFFORT`, never above its ceiling), written unless the
  definition already carries it (since 2026-11-10 an automatic report's definition carries `definitionEffort`, the effort
  the resolver picks when nothing is asked, so only a pick, profile default or retry writes one), so neither the CLI's per-model default nor a project `effortLevel` decides; a fixed
  role keeps its definition's effort. The row records what was sent: for a written alias the model it resolves to on
  the connection (its `ANTHROPIC_DEFAULT_<ALIAS>_MODEL` variable, else on a proxy the mapped id, else on the Anthropic
  connection the alias itself: since 2026-11-10 a concrete id in the Anthropic tier map that the session carries no
  variable for is not recorded, because the alias then resolves natively); with nothing written the definition's model (an `inherit` report of the root: the
  root's live model; a nested one: `inherit`). Whatever
  else the model wrote in `model` or `effort` is
  removed; a full id is never passed (it used to pass and fail the spawn), and the plan guard now writes `sonnet`
  instead of the everyday model id. When the spawn runs on other values than were asked (a clamp or the plan guard),
  the caller gets one line, "[OrgAI harness] <Role> was spawned on <label>.", through `PostToolUse`
  `additionalContext` on that Agent call (beside the receipt when there is one); that path is verified for foreground
  spawns (delegation gate facts above), for a background spawn's `async_launched` result it is unverified. The row is
  recorded at `task_started` (`recordStaffing`), an Agent `tool_result` with `is_error` before the agent started
  cancels the decision, and `SubagentStop` or a finishing `task_notification` calls `ended`. `Project.staffing:
  'fixed'` works like a fixed role in an automatic project: the alias and effort on the call are dropped, the report
  runs on its definition's model and effort, only the plan guard writes `sonnet`, and the caller is told in one
  sentence when something it asked for was dropped. The plan guard judges an `inherit` report by the model `inherit`
  resolves to (the root's live tier, a concrete id by its family), also when its parent is unknown to the book. The
  book survives query restarts; a resume in a new process starts with an empty book, so an `inherit` child of a report
  spawned before the resume runs as configured (the root's model, steered by the plan guard), and a step attempted
  before it counts as never attempted. A report resumed by `SendMessage` stays ended in the book. Not live-checked end
  to end in a run. A nested `inherit` follows the spawning subagent (check 11 below); OrgAI still writes the resolved
  tier's alias on every automatic nested `inherit` spawn the connection can resolve, and on a proxy whose map lacks that
  tier nothing is written and the row keeps `inherit` with the parent's tier, which is what runs.
- Nested `inherit` (check 11, 2026-11-10; `scripts/smoke-staffing.mjs 11stub`, zero spend, and `11`, one live session,
  about $0.02): root `lead` on sonnet spawns `mid` (definition model `haiku`), which spawns `grand` (definition model
  `inherit`). Stub (a local Messages stub that tells the agents apart by their system prompts): the grandchild's
  requests went to `claude-haiku-5-5`, the parent's model, not the root's `claude-sonnet-5-5`. Live (Max login, SDK
  0.3.318, `forwardSubagentText`, messages attributed by `parent_tool_use_id`): root `claude-sonnet-5-5`, mid
  `claude-haiku-5-5`, grandchild `claude-haiku-5-5`. So `inherit` in a nested spawn means the spawning subagent's model.
  Only `inherit` from a definition was checked, not an Agent call that omits `model` under a definition without one.
- `SubagentStart` additional context (Unverified, from the typings only): SDK 0.3.318 `sdk.d.ts` declares
  `SubagentStartHookSpecificOutput { hookEventName: 'SubagentStart'; additionalContext?: string }`, and the hook input
  carries `agent_id` and `agent_type` but no Agent `tool_use_id` (its `toolUseID` argument is a hook invocation id,
  above). It could carry the spawn's knowledge block without changing the Agent input (the spawn hook's `prompt`
  rewrite, which costs an auto mode classifier request), but where the context lands and how a start is matched to its
  Agent call are not established; nothing uses it yet.
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

## Live permission mode change (typings only, 2026-11-10; NOT verified live)

Read from the installed typings, no smoke run (no tokens spent). Used by `setPermissionMode` in claude.ts / codex.ts.

- Claude Agent SDK 0.3.318, `sdk.d.ts` interface `Query`: `setPermissionMode(mode: PermissionMode): Promise<void>`, "Change the
  permission mode for the current session. Only available in streaming input mode." OrgAI always uses streaming input.
  `Options.allowDangerouslySkipPermissions` "Must be set to true when using permissionMode: 'bypassPermissions'" and is
  an `Options` field fixed when the query is built, so OrgAI never switches a query to bypass that was built without it.
  `AgentDefinition.permissionMode` exists; OrgAI sets none. `sdk-tools.d.ts` `AgentInput.mode` is "Deprecated; ignored.
  Subagents inherit the parent session's permission mode"; whether a nested report's "parent session" is the root or
  its spawning report (which may still hold an older mode) is not said, so OrgAI adds the parent report's modes.
  Unverified: how the CLI answers bypass on a query built without the flag, whether a Task
  report already running picks up a new mode, and whether a report spawned after `Query.setPermissionMode` inherits
  the new session mode or the query's build-time `Options.permissionMode`.
- Counting in claude.ts (`reportsUnchanged`, fake-query tests in `claude.test.ts` "ClaudeSession live permission
  mode"): a report counts unless every mode it may run under is no wider than the new one. Those modes are fixed when
  the PreToolUse hook approves the Agent call (keyed by tool_use_id, moved onto the report at task_started; an
  approved spawn not started yet counts on its own, an `is_error` tool result drops it) and when the agent is first
  seen: the query's build-time mode (always, because of the open question above), the mode last applied live, a
  change still in flight, a card's accept-edits grant, ctx.project's mode and the parent report's modes. Finished
  reports count too, because SendMessage resumes one; a resumed report that is wider than the live mode gets a run
  warning. So the count over-counts on purpose, for example every report of a run built in acceptEdits counts on any
  later narrowing below it.
- Grants around a change (claude.ts `allowWithScope`): a card answered while the live, pending or (before any switch)
  ctx.project mode is plan or dontAsk loses its setMode update (the rules stay) and does not call
  `ctx.acceptEditsGranted`. A setMode acceptEdits that reaches the CLI while `Query.setPermissionMode` awaits makes the
  adapter send the mode once more; the accept-edits flag clears only when no grant landed meanwhile. An MCP restart
  check stands down while a change is in flight and is scheduled again after it; if the query still changed under the
  await the change is refused. Codex and mock apply the same plan / dontAsk rule to `sessionAcceptEdits`.
- Codex app-server (@openai/codex 0.166.0, `codex app-server generate-ts`, stable and `--experimental`, token-free):
  `v2/TurnStartParams.ts` `approvalPolicy`, `approvalsReviewer`, `sandboxPolicy` (a `SandboxPolicy` object, not the
  mode string) hold "for this turn and subsequent turns". `v2/TurnSettingsUpdateParams.ts` (`turn/settings/update`) changes
  only reviewer, model, effort, summary and service tier of a running turn, and `thread/settings/update` appears only in the
  `--experimental` output. So a running turn keeps its sandbox and approval policy; the change reaches each thread at its
  next `turn/start`.
- `v2/SandboxPolicy.ts` (same generate-ts, re-read 2026-11-10): every `workspaceWrite` field is required
  (`writableRoots`, `networkAccess`, `excludeTmpdirEnvVar`, `excludeSlashTmp`), so an override cannot leave one to the
  user's config. What OrgAI sends (`codexProtocol.ts` `sandboxPolicyFor`): `writableRoots` = the roots the app-server
  was launched with (`sandbox_workspace_write.writable_roots` in the launch config) that `codexWritableRoots(ctx)`
  still returns now, so neither a later allowed folder nor a removed one widens it; `networkAccess: false` always, which
  narrows a user's own `network_access = true` (the only field that only narrows); the two temp switches come from
  `config/read` (stable method, `ConfigReadResponse.config.sandbox_workspace_write`, snake_case, read once per
  app-server with `cwd` = the project): a null section means Codex's defaults (temp folders writable), and a failed
  read or a non-boolean value excludes the folder (narrower than any user setting). Whether `config/read` reports the
  values the running threads were started with, and how Codex applies the object, is unverified live.
- Counting in codex.ts (fake app-server tests in `codex.test.ts` "live permission mode"): `policyPending` holds what
  Codex holds for a thread; a turn/start answered after another switch keeps the entry on the policy it sent so the
  next turn/start corrects it, and the thread counts under both modes meanwhile. A thread inside a turn or with a
  turn/start in flight counts whatever its agent state; a thread with no resolvable role is counted.
- Accept-edits grants: each adapter calls `RuntimeContext.acceptEditsGranted()` once per applied session / project
  grant of a setMode acceptEdits (Claude where `updatedPermissions` carries it, Codex / mock where they set
  `sessionAcceptEdits`), never on allow-once, and drops its own grant when a live change goes to default, plan or
  dontAsk (Claude: the CLI's single session mode is replaced). Unit tests in all three adapters; live unverified.
