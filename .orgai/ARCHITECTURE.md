# OrgAI architecture

OrgAI is an Electron app built with electron-vite. It has three processes. The main process (src/main) holds the runtime adapters, run manager, setup service, worktree integration and the JSON stores. The preload (src/preload) exposes window.orgai over contextBridge. The renderer (src/renderer) is React 19 with React Flow and zustand. Any type that crosses IPC lives in src/shared/types.ts. The renderer only ever sees normalized RunEvents, and provider-specific code stays inside runtime/<provider>.ts. Unit tests use vitest, sit beside each module and never spend tokens. The e2e scripts drive the built app through playwright-core. Some of them spend tokens and only run when given --yes.

## Stack

- TypeScript (tsc 7, separate node and web tsconfigs, no baseUrl)
- Electron 45 + electron-vite 6 + Vite 8
- React 19, @xyflow/react 12 (React Flow), @dagrejs/dagre, zustand 5, react-markdown + remark-gfm
- @anthropic-ai/claude-agent-sdk 0.3.312 (only provider adapter so far), zod 4 for MCP tool schemas
- vitest 3 (node env) for unit tests; playwright-core Electron driver for e2e
- electron-builder for Windows packaging
- Node >= 22, git (worktree isolation)

## Modules

### Shared contracts

IPC-safe types (Project, Role, RunEvent, IPC names), defaults, built-in Architect role and setup tool names

- `src/shared/types.ts`
- `src/shared/defaults.ts`
- `src/shared/setup.ts`

### Runtime core (provider-neutral)

Adapter interfaces, harness MCP tools, role prompts, activity strings, permission scopes, the WorktreeIntegrator state machine, and the run manager that does permission and proposal round-trips

- `src/main/runtime/types.ts`
- `src/main/runtime/harnessTools.ts`
- `src/main/runtime/prompts.ts`
- `src/main/runtime/activity.ts`
- `src/main/runtime/integration.ts`
- `src/main/runtime/permissionRules.ts`
- `src/main/runtime/runManager.ts`
- `src/main/runtime/worktrees.ts`

### Provider adapters

SDK event mapping and hook mechanics only. claude.ts is the real adapter. mock.ts is the scripted, token-free reference adapter (ORGAI_MOCK=1)

- `src/main/runtime/claude.ts`
- `src/main/runtime/claudeCost.ts`
- `src/main/runtime/claudePartial.ts`
- `src/main/runtime/mock.ts`

### Setup and drafting

Token-free repo profiler, applying approved proposals, writing .orgai/ARCHITECTURE.md, the quick org chart drafter

- `src/main/setup/`
- `src/main/ai/`

### Main shell, stores and maintenance

App entry, IPC handlers, logging, OS notifications, JSON stores under %APPDATA%/orgai/data, leftover-branch maintenance

- `src/main/index.ts`
- `src/main/ipc.ts`
- `src/main/log.ts`
- `src/main/notifications.ts`
- `src/main/maintenance.ts`
- `src/main/store/`

### Preload bridge

contextBridge API window.orgai and its typings

- `src/preload/`

### Renderer UI

Projects view, org chart editor, live run view, settings, proposal, question and merge-review cards, transcript, zustand store, dagre layout

- `src/renderer/src/`

### Scripts and e2e

SDK smoke tests (spend tokens), icon generation, Electron e2e flows run against out/

- `scripts/`
- `e2e/`

## Conventions

- Keep `npm run typecheck` clean for both tsconfigs. Paths are ./-relative with aliases @shared and @renderer. Never add baseUrl.
- Every type that crosses IPC is defined in src/shared/types.ts and must be structured-clone safe. Wire new IPC through shared types, then main/ipc.ts, then preload/index.ts and index.d.ts, then the renderer.
- The renderer only consumes normalized RunEvents. Vendor SDK details never leave runtime/<provider>.ts.
- Adapters contain only event mapping and hook mechanics. Shared behaviour goes in harnessTools.ts, prompts.ts, activity.ts, integration.ts or permissionRules.ts, and mock.ts is updated to match.
- Unit tests are *.test.ts files beside the module they test, run with vitest in the node environment, and never spend tokens. Use testHelpers.ts and the mock adapter.
- Smoke scripts (scripts/smoke-*.mjs) and the e2e scripts setup, history and worktree spend real tokens. Run them only with explicit approval and never in loops. e2e:free is safe.
- SDK behaviour claims are verified with a smoke script and recorded in CLAUDE.md along with the SDK version.
- Worktree commit and merge belong to the harness (worktrees.ts and integration.ts). Never register WorktreeCreate or WorktreeRemove hooks just to observe.
- Each feature lands as one descriptive commit plus a merge commit ('Merge <feature>'), in imperative, sentence-style messages.
- Build output (out/, release/, *.tsbuildinfo) is gitignored. Never commit it.

## Commands

- Install: `npm install`
- Dev (hot reload): `npm run dev`
- Dev without tokens: `ORGAI_MOCK=1 npm run dev`
- Typecheck: `npm run typecheck`
- Unit tests: `npm test`
- Build: `npm run build`
- E2E (free, needs build): `npm run build && npm run e2e:free`
- E2E (spends tokens): `node e2e/setup.mjs --yes | node e2e/history.mjs --yes | node e2e/worktree.mjs --yes`
- Package Windows: `npm run dist`

## Risks and gaps

- No lint or format tooling (no ESLint or Prettier), so style is enforced only by typecheck and review.
- The renderer has no unit tests. All React components and the zustand store are covered only by the e2e scripts.
- No CI configuration. Typecheck, tests and e2e:free run only when someone runs them locally.
- The e2e scripts run against the real %APPDATA%/orgai data directory, so a killed script leaves test projects behind.
- The SDK is pinned to 0.3.312 and several verified hook behaviours depend on it. Upgrading needs the smoke scripts re-run and CLAUDE.md updated.
- Packaging targets Windows only.

_Maintained by OrgAI. Approved by the project owner during setup._
