# OrgAI – notes for agents working in this repo

Electron + electron-vite + React 19 + TypeScript. React Flow (`@xyflow/react`) for both the org chart editor and
the live view; `@dagrejs/dagre` for tree layout; zustand for renderer state.

- `npm run typecheck` runs both tsconfigs (node + web). Keep it clean. TypeScript 6: no `baseUrl`, paths are `./`-relative.
- Shared types live in `src/shared/types.ts`. Anything crossing IPC must be defined there and be structured-clone safe.
- The renderer only sees normalized `RunEvent`s. Vendor specifics stay inside `src/main/runtime/<provider>.ts`.
- Adding a provider: the adapter is SDK event mapping plus hook mechanics only (spawn enforcement, deciding isolation
  at spawn time, reporting an agent's real cwd, exposing tools). Harness tools live in `harnessTools.ts`, role
  prompts in `prompts.ts`, activity strings in `activity.ts`, the worktree state machine in `integration.ts`
  (`WorktreeIntegrator`, adapter supplies `notify`), permission scopes in `permissionRules.ts`. `mock.ts` is the
  reference adapter; `npm test` runs vitest (`*.test.ts` beside the modules) and never spends tokens.
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
    carries an undocumented `unifiedWindows` map. Mapping lives in `src/main/runtime/usage.ts`.
  - In-process MCP tools (`createSdkMcpServer` + `tool` with zod shapes) surface as `mcp__<server>__<tool>` in
    `PreToolUse`, `canUseTool` and `tools` lists. Under `acceptEdits` they still hit `canUseTool`, so the Claude
    adapter auto-allows `mcp__orgai__*`. A handler may block indefinitely; the model receives its returned text.
- Setup sessions (`RunSummary.kind === 'setup'`) run the built-in Architect from `src/shared/setup.ts`, never the
  project's roles. Proposals go through `RuntimeContext.requestProposal`; applying them is `src/main/setup/service.ts`.
- Worktree isolation (verified with `scripts/smoke-worktree.mjs`): `isolation: "worktree"` on an Agent call can be
  injected from `PreToolUse` via `updatedInput`. The CLI creates `<repo>/.claude/worktrees/agent-<id>` on branch
  `worktree-agent-<id>` from HEAD, confines Edit/Write to it, and leaves it behind uncommitted when the subagent
  stops. Registering `WorktreeCreate`/`WorktreeRemove` hooks makes the host responsible for creating/removing the
  worktree (the hook must return `worktreePath`), so do not register them just to observe. Commit and merge are
  the harness's job: `src/main/runtime/worktrees.ts`.
- Smoke tests cost real tokens (fractions of a cent on haiku). Do not run them in loops.

<!-- orgai:architecture -->
## Architecture and conventions

Read `.orgai/ARCHITECTURE.md` before changing code. It records the agreed stack, module layout, conventions and commands for this project. Keep it current when they change.
