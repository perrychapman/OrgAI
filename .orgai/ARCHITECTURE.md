# OrgAI architecture

OrgAI is an Electron app built with electron-vite and three processes. The main process (src/main) holds the runtime adapters, run manager, connections and model catalog, MCP servers and secrets, usage tracking, setup service, worktrees and JSON stores. The preload (src/preload) exposes window.orgai. The renderer (src/renderer) uses React 19 with React Flow and zustand. IPC types live in src/shared/types.ts. Two provider adapters exist: Claude (Claude Agent SDK) and Codex (`codex app-server`). They are reached through three connections: Anthropic, OpenAI and LiteLLM.

An approved UI-overhaul plan is PLANNED but has not landed. It covers Radix Primitives, react-resizable-panels panels, a components/layout shell, the vendored frontend-design skill and Role.skills. Items below marked PLANNED do not exist in the code yet.

## Stack

- TypeScript (tsc 7, separate node and web tsconfigs, no baseUrl)
- Electron 45 + electron-vite 6 + Vite 8
- React 19, @xyflow/react 12 (React Flow), @dagrejs/dagre, zustand 5, react-markdown + remark-gfm
- lucide-react 1.64 (SVG icons that take their color from currentColor)
- Plain CSS with custom-property design tokens (no CSS framework)
- @anthropic-ai/claude-agent-sdk 0.3.312 (Claude adapter), zod 4 for harness tool schemas
- @openai/codex 0.166.0 (Codex adapter and the OpenAI connection: `codex app-server`, JSON-RPC over stdio)
- vitest 3 (node env) for unit tests; playwright-core Electron driver for e2e
- electron-builder (Windows nsis + portable tested; mac dmg and linux AppImage configured, untested)
- Node >= 22, git (worktree isolation)
- PLANNED, not installed: radix-ui (unstyled Radix Primitives), react-resizable-panels, the vendored anthropics/skills frontend-design skill in .claude/skills

## Modules

### Shared contracts

IPC-safe types (Project, Role, RunEvent, UsageStatus, connections, models, remaps, MCP servers, plugins, install requests, IPC names), defaults (adapterForProject, builtin models, tier helpers, MCP secret names), the built-in Architect and MCP assistant roles and setup tool names. Role.skills is PLANNED and not in the contract yet.

- `src/shared/types.ts`
- `src/shared/defaults.ts`
- `src/shared/setup.ts`

### Runtime core (provider-neutral)

- Adapter interfaces and the run manager. RunManager picks the adapter, resolves the connection and MCP servers per run, and handles approvals, proposals, questions, merges and MCP install cards.
- Harness tools, each with an audience: 'root', or 'spawners' for the MCP tools. Callers pass a HarnessToolCaller when they know the calling agent.
- Role prompts, activity strings, permission scopes, agent handles and messages, the continuation driver, WorktreeIntegrator and git worktree commit/merge.
- Vendor-neutral usage mapping.
- Image attachments. attachments.ts sanitizes untrusted pasted images: count and size limits, base64 checks, and magic-byte sniffing.

- `src/main/runtime/types.ts`
- `src/main/runtime/harnessTools.ts`
- `src/main/runtime/prompts.ts`
- `src/main/runtime/activity.ts`
- `src/main/runtime/continuation.ts`
- `src/main/runtime/integration.ts`
- `src/main/runtime/permissionRules.ts`
- `src/main/runtime/network.ts`
- `src/main/runtime/attachments.ts`
- `src/main/runtime/runManager.ts`
- `src/main/runtime/worktrees.ts`
- `src/main/runtime/usage.ts`
- `src/main/runtime/testHelpers.ts`

### Provider adapters

SDK event mapping and hook mechanics only. Only the Adapter Engineer edits claude.ts and mock.ts.

- Claude: the files below. Harness tools run in an in-process MCP server named "orgai". PreToolUse records which agent called them.
- Codex: codexAppServer.ts is the JSON-RPC client and binary lookup, codexProtocol.ts holds policies, launch config, dynamic tool specs and parsers, codexEvents.ts maps events, codexAgents.ts runs harness-side subagents as threads, and codex.ts is the adapter.
- mock.ts is the reference adapter.

- `src/main/runtime/claude.ts`
- `src/main/runtime/claudeCost.ts`
- `src/main/runtime/claudePartial.ts`
- `src/main/runtime/codex.ts`
- `src/main/runtime/codexAppServer.ts`
- `src/main/runtime/codexProtocol.ts`
- `src/main/runtime/codexEvents.ts`
- `src/main/runtime/codexAgents.ts`
- `src/main/runtime/mock.ts`

### Connections and model catalog

ConnectionService covers:

- probes and status, the OpenAI ChatGPT login (browser or device code) through Codex, and the LiteLLM key
- model discovery (LiteLLM /v1/models and /model/info, Codex model/list), with the catalog persisted to models.json
- tier mapping and project remaps, including the projects:previewRemap dry run
- the per-run RunConnection, and Codex plan usage

anthropicAuth.ts runs `claude auth status` and lists candidate claude binaries.

- `src/main/connections/`

### MCP servers and plugins

McpService covers:

- persisting Project.mcpServers / Project.plugins, with secret values only in SecretStore
- resolving servers for runs and saving installs that the user approved with scope 'project'
- registry search (registry.ts, the official MCP Registry)
- the token-free server test (probe.ts: initialize + tools/list for stdio and streamable HTTP)
- spec validation (validate.ts: pinned versions, names) and the MCP assistant context (assist.ts)

- `src/main/mcp/`

### Setup and drafting

- A token-free repo profiler.
- Applying approved proposals, including MCP server proposals. Removed servers lose their secrets.
- Writing .orgai/ARCHITECTURE.md.
- A quick org chart drafter.

- `src/main/setup/`
- `src/main/ai/`

### Main shell, stores and maintenance

- The app entry. Startup order: installLogging, applyShellPath, stores, SecretStore(safeStorage), ConnectionService, McpService, SetupService, adapters, RunManager, IPC, connections.init(). Then installAppMenu, and createWindow last.
- IPC handlers, logging and notifications.
- The idle usage monitor (the Claude plan, plus Codex through extraProbes).
- JSON stores.
- shellEnv.ts gives macOS and Linux GUI launches the login shell's PATH. appMenu.ts is the macOS application menu.
- Leftover-branch maintenance.
- Run store layout under the data dir: runs.json (index), runs/<runId>.json (record), runs/<runId>/images/<sha256>.<ext>.
- Secrets live in secrets.json (safeStorage ciphertext) and the model catalog in models.json. OrgAI's own Codex home is <data>/codex.

- `src/main/index.ts`
- `src/main/ipc.ts`
- `src/main/log.ts`
- `src/main/notifications.ts`
- `src/main/usageMonitor.ts`
- `src/main/maintenance.ts`
- `src/main/shellEnv.ts`
- `src/main/appMenu.ts`
- `src/main/store/` (projects, runs, settings, secrets.ts)

### Preload bridge

The contextBridge API window.orgai and its typings.

- `src/preload/`

### Agent skills

- `.claude/skills/run-desktop/`
- PLANNED: `.claude/skills/frontend-design/` (not vendored yet)

### Brand assets

- `src/renderer/src/assets/brand/`
- `build/icon.png`
- `scripts/make-icon.mjs`

### Theme layer

- `src/renderer/src/styles/tokens.css`
- `src/renderer/src/styles/global.css`
- `src/renderer/src/lib/theme.ts`

### UI primitives

components/ui is built on native elements today: Badge, Banner, Button, IconButton, Dialog/ConfirmDialog, Switch, CopyButton, ModelSelect, SecretField, ConnectionStatusBadge, RemapNotice and Icon. PLANNED: Radix-based versions, and a components/layout panel shell over react-resizable-panels. Neither exists yet.

- `src/renderer/src/components/ui/`

### Renderer UI

- The app shell, projects view, org chart editor, live run view, app and project settings, transcript, usage meter, zustand store and dagre layout.
- Connections settings (components/connections/).
- MCP servers, plugins, registry dialog and install cards (components/mcp/).

- `src/renderer/src/`
- `src/renderer/src/components/connections/`
- `src/renderer/src/components/mcp/`

### Scripts, e2e and packaging

- SDK and provider smoke tests. They spend tokens, except smoke-litellm without --yes.
- Icon generation.
- Electron e2e flows run against out/.
- electron-builder config, macOS entitlements, and the macOS first-test checklist.

- `scripts/`
- `e2e/`
- `electron-builder.yml`
- `build/entitlements.mac.plist`
- `docs/macos-testing.md`

## Conventions

- Keep `npm run typecheck` clean for both tsconfigs. Paths are ./-relative with aliases @shared and @renderer. Never add baseUrl.
- Every type that crosses IPC is defined in src/shared/types.ts and must be structured-clone safe. Wire new IPC in this order: shared types, main/ipc.ts, preload/index.ts and index.d.ts, then the renderer.
- The renderer only consumes normalized RunEvents and ConnectionEvents. Vendor SDK details never leave runtime/<provider>*.ts.
- Adapters contain only event mapping and hook mechanics. Shared behaviour goes in harnessTools.ts, prompts.ts, activity.ts, integration.ts, permissionRules.ts, network.ts, continuation.ts or usage.ts, and mock.ts is updated to match.
- Connections and adapters are separate. The connections are anthropic, openai and litellm, and the adapters are claude and codex.
  - Anthropic always runs on Claude and OpenAI always on Codex.
  - On LiteLLM the root role's model family picks the adapter (adapterForProject).
  - A work run whose roles mix families is refused before the run exists.
- Remaps:
  - Role.tier plus each connection's tierModels drive remaps. A remap never clobbers an explicit pick of a valid catalog model, except when the project switches connection.
  - Remaps are reported as projects.remapped with Undo in the UI.
  - projects:previewRemap is the main-process dry run.
- Secrets live only in SecretStore (Electron safeStorage). Covered secrets: the LiteLLM key and MCP env and header values.
  - They never cross IPC. Write-only inputs are allowed, and responses carry has-flags only.
  - They are never logged and are redacted from probe output. An API key reaches Codex only through the environment.
- projects:save (ProjectStore.saveFromRenderer) keeps the stored mcpServers and plugins. Those change only through mcp:* and plugins:*, approved setup or MCP proposals, and installs approved with scope 'project'. Deleting a project deletes its MCP secrets.
- OrgAI's Codex home is <data>/codex, so it never loads the user's ~/.codex config.
- MCP:
  - Claude runs use strictMcpConfig, so only the project's enabled servers and run-scoped installs load.
  - Agents add servers only through request_mcp_install. It needs exact pinned versions and the user's approval on an install card.
  - A denial means the agent finds another route.
  - Registry content is untrusted data: it is quoted as data and never followed as instructions.
- Setup-like runs (setup, mcp-assist) use built-in roles (the Architect, the MCP assistant) and are never nudged by the continuation driver.
- Harness tool audiences: 'root' tools go to the root role only. 'spawners' tools (list_mcp_servers, search_mcp_registry, request_mcp_install) go to the root and every canSpawn role.
- usage.ts stays vendor-neutral and never imports the SDK. Mind the unit mismatch: usage responses give 0-100 percent and ISO resets, while rate_limit_event gives a 0-1 fraction and epoch seconds.
- SDK spawns go through the adapter's EXECUTABLE_OPTION, and the native CLIs stay in asarUnpack.
- PLANNED, with the UI overhaul (not in force for code that does not use them yet):
  - Radix-based components/ui and a components/layout panel shell.
  - Container queries everywhere.
  - Role.skills passed as AgentDefinition.skills.
- Styling uses design tokens only. Never hardcode hex colors, shadows, radii, font sizes or z-indexes. Every token is defined for both dark and light themes.
- Hierarchy comes from the type scale, weight and spacing, not from uppercase micro-labels. Labels use sentence case, with at most one primary action per region.
- Nothing floats over the React Flow canvas except React Flow's own controls. Cards, banners and approvals sit in layout regions.
- No div or span with onClick and no native confirm(). Every control is reachable by keyboard with a visible :focus-visible ring.
- Icons are lucide-react via the Icon wrapper. No Unicode glyphs as icons.
- Motion respects prefers-reduced-motion.
- Unit tests are *.test.ts files beside the module they test. They run with vitest in the node environment and never spend tokens.
- Smoke scripts and the e2e scripts setup, history and worktree spend real tokens. Run them only with explicit approval. e2e:free is safe and must pass after UI changes, with selectors updated in the same change.
- New dependencies are pinned to exact versions like the rest of package.json.
- SDK and provider behaviour claims are verified with a smoke script and recorded in CLAUDE.md with the version, or marked unverified there.
- Worktree commit and merge belong to the harness. Never register WorktreeCreate or WorktreeRemove hooks just to observe.
- Each feature lands as one descriptive commit plus a merge commit ('Merge <feature>').
- Build output (out/, release/, release-*/, *.tsbuildinfo) is gitignored. Never commit it.

## Commands

- Install: `npm install`
- Dev (hot reload): `npm run dev`
- Dev without tokens: `ORGAI_MOCK=1 npm run dev`
- Typecheck: `npm run typecheck`
- Unit tests: `npm test`
- Build: `npm run build`
- E2E (free, needs build): `npm run build && npm run e2e:free`
- E2E (spends tokens): `node e2e/setup.mjs --yes | node e2e/history.mjs --yes | node e2e/worktree.mjs --yes`
- Smoke, spend tokens, consent required: `node scripts/smoke-codex.mjs --yes`, `node scripts/smoke-litellm.mjs --yes`. Without --yes, smoke-litellm only lists models and is free.
- Package Windows: `npm run dist`
- Package unpacked dir: `npm run dist:dir`
- Package macOS: `npm run dist:mac` (signed when an identity is available) or `npm run dist:mac:unsigned`
- Regenerate icon: `npm run icon`

## Risks and gaps

- Codex:
  - It is unverified that dynamic tools (the harness tools) survive thread/resume. The adapter's MCP restart and run continuation assume they do.
  - All Codex, LiteLLM and MCP-registry wire shapes come from docs and schemas until smoke-codex and smoke-litellm run with your consent.
  - The device-code expiry field is a guess.
- Claude:
  - Calling agents are attributed by tool_use id from extra._meta (the key is unverified), else first-in-first-out per tool name. FIFO can misattribute concurrent calls.
  - Query.setMcpServers for mid-run installs is unverified at runtime.
- macOS is untested. The user tests on a MacBook with docs/macos-testing.md. Packaging and entitlements are unverified.
- The UI was verified only against stubbed or empty states. The connection and MCP screens have not been run against live services.
- The UI overhaul shell pass has not landed: Radix, resizable panels, components/layout, the frontend-design skill and Role.skills. When it lands it rewrites App.tsx, LiveRunView.tsx and SettingsView.tsx and must go in as one serialized pass before parallel restyles.
- Renderer remap previews (lib/remap.ts) are computed in the renderer. projects:previewRemap exists but is not wired into the UI yet.
- No lint or format tooling, and the renderer has no component tests.
- No CI configuration. The e2e scripts run against the real %APPDATA%/orgai data directory.
- The Claude SDK is pinned to 0.3.312. Plan usage relies on an experimental API and can break on upgrade.
- claude.ts and codex.ts are large hotspots for merge conflicts.
- No e2e test covers the packaged app.

_Maintained by OrgAI. Approved by the project owner during setup._
