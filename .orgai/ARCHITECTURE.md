# OrgAI architecture

OrgAI is an Electron app built with electron-vite. It has three processes. The main process (src/main) holds the runtime adapters, run manager, plan-usage tracking, setup service, worktree integration and the JSON stores. The preload (src/preload) exposes window.orgai over contextBridge. The renderer (src/renderer) is React 19 with React Flow and zustand. Any type that crosses IPC lives in src/shared/types.ts. The renderer only ever sees normalized RunEvents, and provider-specific code stays inside runtime/<provider>.ts. New in this revision: a brand asset set (icon plus wordmark as SVG, the single source the app icon is generated from) and a token-based theme layer. The theme layer covers dark, light and system modes, a user accent color and canvas appearance, driven by an Appearance setting in the app settings store. Unit tests use vitest, sit beside each module and never spend tokens. The e2e scripts drive the built app through playwright-core.

## Stack

- TypeScript (tsc 7, separate node and web tsconfigs, no baseUrl)
- Electron 45 + electron-vite 6 + Vite 8
- React 19, @xyflow/react 12 (React Flow), @dagrejs/dagre, zustand 5, react-markdown + remark-gfm
- Plain CSS with custom-property design tokens (no CSS framework)
- @anthropic-ai/claude-agent-sdk 0.3.312 (only provider adapter so far), zod 4 for MCP tool schemas
- vitest 3 (node env) for unit tests; playwright-core Electron driver for e2e
- electron-builder (Windows nsis + portable tested; mac dmg and linux AppImage configured, untested)
- Node >= 22, git (worktree isolation)

## Modules

### Shared contracts

IPC-safe types (Project, Role, RunEvent, UsageStatus, AppearanceSettings, IPC names), defaults, built-in Architect role and setup tool names

- `src/shared/types.ts`
- `src/shared/defaults.ts`
- `src/shared/setup.ts`

### Runtime core (provider-neutral)

Adapter interfaces, harness MCP tools, role prompts, activity strings, permission scopes, agent handles and messages, WorktreeIntegrator, git worktree commit/merge, run manager, vendor-neutral usage mapping

- `src/main/runtime/types.ts`
- `src/main/runtime/harnessTools.ts`
- `src/main/runtime/prompts.ts`
- `src/main/runtime/activity.ts`
- `src/main/runtime/integration.ts`
- `src/main/runtime/permissionRules.ts`
- `src/main/runtime/network.ts`
- `src/main/runtime/runManager.ts`
- `src/main/runtime/worktrees.ts`
- `src/main/runtime/usage.ts`
- `src/main/runtime/testHelpers.ts`

### Provider adapters

SDK event mapping and hook mechanics only. claude.ts is the real adapter; mock.ts is the token-free reference adapter (ORGAI_MOCK=1)

- `src/main/runtime/claude.ts`
- `src/main/runtime/claudeCost.ts`
- `src/main/runtime/claudePartial.ts`
- `src/main/runtime/mock.ts`

### Setup and drafting

Token-free repo profiler, applying approved proposals, writing .orgai/ARCHITECTURE.md, quick org chart drafter

- `src/main/setup/`
- `src/main/ai/`

### Main shell, stores and maintenance

App entry (window icon from brand assets), IPC handlers, logging, notifications, idle usage monitor, JSON stores including persisted appearance settings, leftover-branch maintenance

- `src/main/index.ts`
- `src/main/ipc.ts`
- `src/main/log.ts`
- `src/main/notifications.ts`
- `src/main/usageMonitor.ts`
- `src/main/maintenance.ts`
- `src/main/store/`

### Preload bridge

contextBridge API window.orgai and its typings

- `src/preload/`

### Brand assets

Canonical logo mark and OrgAI wordmark as SVG (plus lockup), imported by the renderer; scripts/make-icon.mjs output must stay visually consistent with the mark

- `src/renderer/src/assets/brand/`
- `build/icon.png`
- `scripts/make-icon.mjs`

### Theme layer

Design tokens (color, spacing, radius, type, elevation) as CSS custom properties per theme mode, accent derivation, canvas appearance tokens, and the hook that applies AppearanceSettings to the document root (data-theme, accent vars, canvas options)

- `src/renderer/src/styles/tokens.css`
- `src/renderer/src/styles/global.css`
- `src/renderer/src/lib/theme.ts`

### Renderer UI

App shell with branded header/nav, projects view, org chart editor, live run view, app and project settings (structure decided by the UI review), cards, usage meter, transcript, zustand store, dagre layout

- `src/renderer/src/`

### Scripts, e2e and packaging

SDK smoke tests (spend tokens), icon generation, Electron e2e flows run against out/, electron-builder config

- `scripts/`
- `e2e/`
- `electron-builder.yml`

## Conventions

- Keep `npm run typecheck` clean for both tsconfigs. Paths are ./-relative with aliases @shared and @renderer. Never add baseUrl.
- Every type that crosses IPC is defined in src/shared/types.ts and must be structured-clone safe. Wire new IPC through shared types, then main/ipc.ts, then preload/index.ts and index.d.ts, then the renderer.
- The renderer only consumes normalized RunEvents. Vendor SDK details never leave runtime/<provider>.ts.
- Adapters contain only event mapping and hook mechanics. Shared behaviour goes in harnessTools.ts, prompts.ts, activity.ts, integration.ts, permissionRules.ts, network.ts or usage.ts, and mock.ts is updated to match.
- usage.ts stays vendor-neutral and never imports the SDK. Mind the unit mismatch: usage responses give 0-100 percent and ISO resets, while rate_limit_event gives a 0-1 fraction and epoch seconds.
- SDK spawns go through the adapter's EXECUTABLE_OPTION, and the native CLI stays in asarUnpack.
- Styling uses design tokens only. Components reference CSS custom properties from tokens.css and never hardcode hex colors, shadows or radii. Every token must be defined for both the dark and light themes.
- Appearance (theme mode dark|light|system, accent color, canvas appearance) is an AppearanceSettings type in shared/types.ts. It is persisted in store/settings.ts with defaults in shared/defaults.ts and applied by lib/theme.ts. Changes take effect live, without a reload.
- Brand assets are SVGs in assets/brand/ and are the single source for the logo. Reference them from components rather than inlining copies.
- Accessible contrast: text and accent-on-background pairs meet WCAG AA in both themes, including with user-chosen accents. Derive the foreground color for accents.
- Unit tests are *.test.ts files beside the module they test, run with vitest in the node environment, and never spend tokens. Pure theme logic (accent derivation, settings migration) gets unit tests.
- Smoke scripts and the e2e scripts setup, history and worktree spend real tokens. Run them only with explicit approval. e2e:free is safe and must pass after UI changes, with selectors updated in the same change.
- SDK behaviour claims are verified with a smoke script and recorded in CLAUDE.md with the SDK version.
- Worktree commit and merge belong to the harness. Never register WorktreeCreate or WorktreeRemove hooks just to observe.
- Each feature lands as one descriptive commit plus a merge commit ('Merge <feature>'). Messages are imperative and sentence-style, and the body explains why.
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
- Package Windows: `npm run dist`
- Package unpacked dir: `npm run dist:dir`
- Regenerate icon: `npm run icon`

## Risks and gaps

- global.css is about 1,800 lines of hardcoded dark colors. Moving it to tokens is a large change that conflicts easily, so it should land as one serialized pass before the parallel restyling work.
- A settings reorganization moves markup that the e2e scripts select on (permission card, Logs tab, settings fields). e2e:free and the token-spending e2e need selector updates.
- A light theme and user accents could break React Flow node and edge contrast and the diff view colors, so they need a visual check in both themes.
- No lint or format tooling, and the renderer has no unit tests. Visual regressions are caught only by the e2e screenshots and manual review.
- No CI configuration.
- The e2e scripts run against the real %APPDATA%/orgai data directory.
- The SDK is pinned to 0.3.312. Plan usage relies on an experimental API and can break on upgrade.
- claude.ts (about 1,100 lines) is a hotspot for merge conflicts.
- No e2e test covers the packaged app. mac and linux are configured but untested.

_Maintained by OrgAI. Approved by the project owner during setup._
