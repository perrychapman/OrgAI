# OrgAI architecture

OrgAI is still an Electron app built with electron-vite and three processes. The main process (src/main) holds the runtime adapters, run manager, usage tracking, setup service, worktrees and JSON stores. The preload (src/preload) exposes window.orgai, the renderer (src/renderer) uses React 19 with React Flow and zustand, and IPC types live in src/shared/types.ts. This revision adds a UI foundation for the responsiveness and hierarchy pass. Radix Primitives provide accessible dialogs, popovers, tabs, switches, menus and tooltips, styled only with our tokens. react-resizable-panels gives resizable, collapsible sidebar, inspector and transcript panels. lucide-react replaces the Unicode glyph icons. CSS container queries and a fixed type and spacing scale in tokens.css handle responsive layout and hierarchy. Anthropic's frontend-design skill is vendored into .claude/skills, and Role gains a skills field that the Claude adapter passes to AgentDefinition.skills, so roles preload skills instead of reading them by hand.

## Stack

- TypeScript (tsc 7, separate node and web tsconfigs, no baseUrl)
- Electron 45 + electron-vite 6 + Vite 8
- React 19, @xyflow/react 12 (React Flow), @dagrejs/dagre, zustand 5, react-markdown + remark-gfm
- radix-ui 1.8 (unstyled Radix Primitives: Dialog, AlertDialog, Popover, Tabs, Switch, RadioGroup, ToggleGroup, DropdownMenu, Tooltip, ScrollArea)
- react-resizable-panels 4.15 (resizable and collapsible app panels)
- lucide-react 1.64 (SVG icons that take their color from currentColor)
- Plain CSS with custom-property design tokens, a type and spacing scale and container queries (no CSS framework)
- Claude Code skills in .claude/skills (vendored anthropics/skills frontend-design, Apache-2.0)
- @anthropic-ai/claude-agent-sdk 0.3.312 (only provider adapter so far), zod 4 for MCP tool schemas
- vitest 3 (node env) for unit tests; playwright-core Electron driver for e2e
- electron-builder (Windows nsis + portable tested; mac dmg and linux AppImage configured, untested)
- Node >= 22, git (worktree isolation)

## Modules

### Shared contracts

IPC-safe types (Project, Role including the new skills: string[] field, RunEvent, UsageStatus, AppearanceSettings, IPC names), defaults, the built-in Architect role and setup tool names

- `src/shared/types.ts`
- `src/shared/defaults.ts`
- `src/shared/setup.ts`

### Runtime core (provider-neutral)

Adapter interfaces, harness MCP tools, role prompts, activity strings, permission scopes, agent handles and messages, WorktreeIntegrator, git worktree commit and merge, run manager, vendor-neutral usage mapping, image attachments (attachments.ts sanitizes untrusted pasted images from IPC: count and size limits, base64 checks, and magic-byte sniffing of PNG, JPEG, GIF and WebP that corrects a wrong declared media type and drops non-images; the bytes live in the on-disk image store of store/runs.ts)

- `src/main/runtime/types.ts`
- `src/main/runtime/harnessTools.ts`
- `src/main/runtime/prompts.ts`
- `src/main/runtime/activity.ts`
- `src/main/runtime/integration.ts`
- `src/main/runtime/permissionRules.ts`
- `src/main/runtime/network.ts`
- `src/main/runtime/attachments.ts`
- `src/main/runtime/runManager.ts`
- `src/main/runtime/worktrees.ts`
- `src/main/runtime/usage.ts`
- `src/main/runtime/testHelpers.ts`

### Provider adapters

SDK event mapping and hook mechanics only. claude.ts maps Role.skills to AgentDefinition.skills; mock.ts records the skills each role preloads so tests can assert it

- `src/main/runtime/claude.ts`
- `src/main/runtime/claudeCost.ts`
- `src/main/runtime/claudePartial.ts`
- `src/main/runtime/mock.ts`

### Setup and drafting

Token-free repo profiler (now also lists .claude/skills), applying approved proposals, writing .orgai/ARCHITECTURE.md, quick org chart drafter

- `src/main/setup/`
- `src/main/ai/`

### Main shell, stores and maintenance

App entry (window icon from brand assets, minimum window size), IPC handlers, logging, notifications, idle usage monitor, JSON stores including appearance and persisted panel sizes, leftover-branch maintenance. Run store layout under the data dir: runs.json (index), runs/<runId>.json (record) and runs/<runId>/images/<sha256>.<ext> (content-addressed image bytes). Records on disk keep ImageAttachment.ref with empty data; loading a record for the renderer rehydrates data, and deleting, pruning or sweeping a run removes its directory

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

### Agent skills

Project skills the roles preload. frontend-design is vendored unmodified with its LICENSE, plus an OrgAI note in docs/design/spec.md on adapting it to a dense desktop tool

- `.claude/skills/frontend-design/`
- `.claude/skills/run-desktop/`

### Brand assets

Canonical logo mark and OrgAI wordmark as SVG (plus lockup), imported by the renderer; scripts/make-icon.mjs output must stay visually consistent with the mark

- `src/renderer/src/assets/brand/`
- `build/icon.png`
- `scripts/make-icon.mjs`

### Theme layer

Design tokens per theme mode (color, spacing scale, radius, elevation, z-index layers), a type scale of 5 to 6 steps with defined roles, container breakpoints, accent derivation, canvas appearance tokens, and the hook that applies AppearanceSettings to the document root

- `src/renderer/src/styles/tokens.css`
- `src/renderer/src/styles/global.css`
- `src/renderer/src/lib/theme.ts`

### UI primitives

Thin OrgAI wrappers over Radix Primitives and lucide icons: Button, IconButton, Dialog, ConfirmDialog (replaces confirm()), Popover, Tabs, Switch, SegmentedControl, Menu, Tooltip, Icon. Plus the panel shell over react-resizable-panels. Views import these, never radix-ui or the panel library directly

- `src/renderer/src/components/ui/`
- `src/renderer/src/styles/primitives.css`
- `src/renderer/src/components/layout/`

### Renderer UI

App shell built on resizable, collapsible panels, projects view, org chart editor, live run view with an in-flow region for cards above the canvas, app and project settings, transcript, usage meter, zustand store, dagre layout

- `src/renderer/src/`

### Scripts, e2e and packaging

SDK smoke tests (spend tokens), icon generation, Electron e2e flows run against out/ (now with screenshots at several window sizes), electron-builder config

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
- Role.skills lists skill names under the project's .claude/skills. The adapter passes them as AgentDefinition.skills and never adds 'Skill' to tools, which the SDK marks deprecated. Unknown skill names are dropped with a log warning, not an error.
- Styling uses design tokens only. Components reference CSS custom properties from tokens.css and never hardcode hex colors, shadows, radii, font sizes or z-indexes. Every token is defined for both dark and light themes.
- Hierarchy comes from the type scale, weight and spacing, not from uppercase micro-labels. Use only the scale's font sizes (no off-scale px values), sentence case for labels, and at most one primary action per region.
- Responsive layout uses container queries on panels and regions (container-type: inline-size). Media queries are only for window-level concerns such as prefers-reduced-motion. The app must work at the minimum window of 1024x640 and at 1920px or wider. Side panels collapse rather than squeeze the canvas.
- Panels are react-resizable-panels behind components/layout. Sizes and collapsed state persist per view. Nothing floats over the React Flow canvas except React Flow's own controls; cards, banners and approvals sit in layout regions.
- Interactive controls come from components/ui (Radix-based). No div or span with onClick, no native confirm(), and every control is reachable by keyboard with a visible :focus-visible ring. Views never import radix-ui directly.
- Icons are lucide-react via the Icon wrapper, sized by tokens, colored with currentColor, and given aria-label when they stand alone. No Unicode glyphs as icons.
- Motion respects prefers-reduced-motion; infinite animations get a static fallback.
- UI roles preload the frontend-design skill and follow it as adapted in docs/design/spec.md: dense tool, restraint, monospace allowed for aligned figures and IDs, no hero sections.
- Appearance (theme mode dark|light|system, accent color, canvas appearance) is an AppearanceSettings type in shared/types.ts. It is persisted in store/settings.ts with defaults in shared/defaults.ts and applied by lib/theme.ts. Changes take effect live, without a reload.
- Brand assets are SVGs in assets/brand/ and are the single source for the logo. Reference them from components rather than inlining copies.
- Accessible contrast: text and accent-on-background pairs meet WCAG AA in both themes, including with user-chosen accents. Derive the foreground color for accents.
- Unit tests are *.test.ts files beside the module they test, run with vitest in the node environment, and never spend tokens. Pure theme logic, panel-size persistence and Role.skills mapping get unit tests.
- Smoke scripts and the e2e scripts setup, history and worktree spend real tokens. Run them only with explicit approval. e2e:free is safe and must pass after UI changes, with selectors updated in the same change. UI changes are checked in e2e screenshots at 1024x640 and 1600x1000 in both themes.
- New dependencies are pinned to exact versions like the rest of package.json. Add a UI dependency only through the components/ui or components/layout wrappers.
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

- Moving to resizable panels and in-flow card regions rewrites App.tsx, LiveRunView.tsx and SettingsView.tsx, the largest renderer files. That shell rewrite must land as one serialized pass before views are restyled in parallel, or merges will conflict.
- The shell and primitives change markup the e2e scripts select on. Every UI change must update the e2e selectors in the same commit, and the token-spending e2e scripts need re-checking with your consent.
- AgentDefinition.skills is untested in OrgAI. It needs one haiku smoke run (with your consent) to confirm that a subagent preloads a project skill under settingSources ['project'], and the result recorded in CLAUDE.md.
- frontend-design is written mostly for marketing pages. Without the adaptation note in spec.md, agents may add hero sections, decorative type or the wrong anti-patterns to a dense tool.
- Radix Popover, Tooltip and Dialog render in portals outside the panel tree, so theme tokens must be set on :root (data-theme) rather than on a container, or portalled content loses its theme.
- React Flow inside a resizable panel must re-fit when the panel resizes or collapses, or the canvas shows stale bounds.
- No lint or format tooling, and the renderer has no component tests. Visual regressions are caught only by e2e screenshots and review.
- No CI configuration. The e2e scripts run against the real %APPDATA%/orgai data directory.
- The SDK is pinned to 0.3.312. Plan usage relies on an experimental API and can break on upgrade.
- claude.ts (about 1,100 lines) is a hotspot for merge conflicts.
- No e2e test covers the packaged app. mac and linux are configured but untested.

_Maintained by OrgAI. Approved by the project owner during setup._
