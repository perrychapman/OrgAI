# OrgAI UI overhaul: implementation plan

Inputs: `ui-review.md` (findings), `spec.md` (design). Status: the user approved all recommendations D1-D12 in `spec.md` section 11 as written (2026-10-29).

Planning rules, taken from `.orgai/ARCHITECTURE.md` and `CLAUDE.md`:

- Each brief is scoped to one architecture module and lists exact files.
- Wire shared types, then `main/ipc.ts`, then `preload`, then the renderer.
- Styling uses tokens only; both themes define every token.
- Every brief ends with `npm run typecheck`, `npm test`, `npm run build && npm run e2e:free` green, and e2e selectors updated in the same change.
- Token-spending e2e (`setup.mjs`, `history.mjs`, `worktree.mjs`) and smoke scripts are never run by a brief. Their selectors are updated and checked with `node --check` only; the user runs them with consent.
- Each brief lands as one descriptive commit plus a merge commit.

## 0. Revision 2: briefs from the UX review

Source: `ux-review.md` section 4; design decisions in `spec.md` section 12. These briefs follow the earlier B-series. The earlier B5 (shell, navigation, file split) plus the layout regions and primitives of `spec.md` 12.8 (`CanvasFrame`, `SidePanel`, `ConfirmDialog`, `Input`, `Textarea`, `Checkbox`, `IconButton`) is **phase 0, the shell pass**: it lands first, alone, before any parallel restyle below. Tab model per `spec.md` 12.2 (`Live` / `Org chart` / `Settings`) is part of phase 0.

| Phase | Brief | Findings | Scope |
| --- | --- | --- | --- |
| 0 | Shell pass | M11, M15 (skip link, real buttons), L1, L10 | Tabs, sidebar footer, `saveStatus` slice and topbar indicator (M10), layout regions, new primitives, `.pill is-*` status class and `runStatus()` mapping |
| 1 (runtime first) | **C. Settings architecture and appearance** (runtime half) | H2, H8 | `AppSettings.appearance`, notifications single source, `nativeTheme` |
| 2 (parallel after phase 0) | **A. Run view correctness and decisions** | H4, H5, H7, M2, M4, M5, M7, M16 display, M17, M19, L9 | Docked decision tray and one card anatomy (`spec.md` 12.1), clear pending on terminal status, status vocabulary (12.4), run strip overflow |
| 2 | **B. Projects and first run** | H1, H3, M3, M18 | Name derivation, folder validation (possible `projects:checkPath` contract), mock checkbox and badge |
| 2 | **C. Settings architecture and appearance** (UI half) | H2, H8, M10, M11, M12, M13, M14, L1, L10, L11 | App settings pages, sub-nav, Appearance, theme lib, Connections page |
| 2 | **D. Org chart editor and keyboard model** | H6, M8, M9, M15, L3, L4 | `OrgChartView` split, inspector on keyboard, `ConfirmDialog` for the five `confirm()` calls, draft panel only here |
| 3 (after A) | **E. Setup completion and history surfaces** | M1, M6, M16 harness text, L2 | Org-chart proposal diff (`spec.md` 12.3), setup-complete banner, Recent runs, transcript humanizing |
| 3 | **F. Mock and MCP polish** | L7, L8, L12, M3 mock script | `mock.ts` pinned server (Adapter Engineer only), registry dedupe, one test-failure message |

Sequencing from `ux-review.md`: runtime half of C first; then A, B, C-UI and D in parallel except shared files (`SettingsView.tsx` C and D, split first in phase 0; `LiveRunView.tsx` A then E; `ProjectsView.tsx` B then D; `shell.css` A and C). The H7 rename (`pill live` to `pill is-running`) can ship on its own and is folded into phase 0.

## 1. Dependency graph and waves

```
Wave 0 (parallel)    E0 e2e selector map   B0 brand assets   B1 token migration (serial CSS)   B2 shared + main
                          |                      |                  |                              |
Wave 1 (parallel)         |                      |             B3 theme layer  <------ needs B1, B2
                          |                      |             B4 ui primitives <----- needs B1
                          |                      |                  |
Wave 2 (serial)           +----------------------+------------> B5 shell, store, file split  (needs B3, B4, E0)
                                                                    |
Wave 3 (parallel)      B6 projects | B7 project settings | B8 app settings | B9 org chart | B10 run canvas | B11 side panel + history
                                                                    |
Wave 4                                                          B12 decisions (needs B10)
                                                                    |
Wave 5 (serial)                                                 B13 cleanup, guards, theme QA
```

Calendar view: Wave 0 and Wave 1 can overlap in time except the stated "needs". Wave 3 is the main parallel block (six briefs). B12 starts after B10 because both touch `LiveRunView.tsx` mounting points.

## 2. Contract changes (shared types, IPC, preload)

Only B2 touches shared types or main. Order inside B2: `src/shared/types.ts` and `src/shared/defaults.ts`, then `src/main/store/settings.ts` (normalization, defaults, migration), then `src/main/index.ts` (and `src/main/ipc.ts` only if the settings handler needs the notifier or window), then `src/preload` (expected: no change).

Proposed type (names final unless the user objects):

```ts
export type ThemeMode = 'dark' | 'light' | 'system'
export type CanvasPattern = 'dots' | 'grid' | 'none'
export type CanvasEdgeStyle = 'curved' | 'orthogonal' | 'straight'

export interface AppearanceSettings {
  theme: ThemeMode                 // default 'dark' until the light theme is signed off, then 'system'
  accent: string                   // '#rrggbb', default '#7c5cff'
  canvas: { pattern: CanvasPattern; tint: boolean; edges: CanvasEdgeStyle; minimap: boolean }
  reduceMotion: 'system' | 'on'    // default 'system'
}

// AppSettings gains:  appearance: AppearanceSettings
// AppSettingsInfo gains (read-only, filled by main):  appVersion: string
```

Why no new IPC channel: `settings.get/set` already carry the whole `AppSettings`, so appearance travels with them. Main applies side effects inside the existing `settings.set` path: `nativeTheme.themeSource` (so native menus, scrollbars and dialogs follow) and the notifier toggle. `BrowserWindow.backgroundColor` is chosen at boot from the persisted theme to avoid a wrong-color flash.

Dead-setting bug (H3): B2 makes `AppSettings.notifications` the single source of truth. On boot and on every `settings.set`, main calls `notifier.setEnabled(settings.notifications !== false)`. The `notifications.setEnabled` channel stays for now (unused by the renderer after B5) and is removed in a later cleanup if the user agrees (D11).

Anything else needing shared/IPC changes: none planned. If B8 wants "Open log folder" it uses the existing `app.openLogs()` and `app.logPath()`. If a brief discovers a need for a new channel it must go back through B2's order (types, ipc, preload) in its own commit before the renderer change.

## 3. File ownership after Wave 1 (prevents parallel conflicts)

| File or folder | Owner brief |
| --- | --- |
| `styles/tokens.css` | B1 (B13 removes the legacy alias block) |
| `styles/global.css` (imports and base) | B1 |
| `styles/ui.css`, `components/ui/*` | B4 |
| `styles/shell.css`, `App.tsx`, `components/Sidebar.tsx`, `ProjectHeader.tsx`, `AccountCard.tsx`, `UsageMeter.tsx`, `store/useAppStore.ts` (UI-state additions) | B5 |
| `styles/projects.css`, `views/ProjectsView.tsx`, `components/NewProjectDialog.tsx`, `components/ProjectCard.tsx` | B6 |
| `styles/project-settings.css`, `views/ProjectSettingsView.tsx`, `components/RepositoryPanel.tsx`, `components/PermissionRulesPanel.tsx` | B7 |
| `styles/app-settings.css`, `views/AppSettingsView.tsx`, `components/AppearanceSettings.tsx`, `components/ProviderAuthPicker.tsx` | B8 |
| `styles/editor.css`, `views/OrgChartView.tsx`, `components/RoleNode.tsx`, `RoleInspector.tsx`, `DraftPanel.tsx`, `ColorPicker.tsx` | B9 |
| `styles/run.css`, `views/LiveRunView.tsx`, `components/run/*`, `AgentNode.tsx`, `DoneGroupNode.tsx` | B10 |
| `styles/transcript.css`, `components/TranscriptPanel.tsx` (becomes the side panel), `FinishedList.tsx`, `Markdown.tsx`, `views/HistoryView.tsx`, `components/RunHistory.tsx` | B11 |
| `styles/cards.css`, `components/attention/*`, `ProposalCard.tsx`, `QuestionCard.tsx`, `MergeReviewCard.tsx`, `DiffView.tsx` | B12 |
| `lib/theme.ts`, `lib/canvas.ts`, `store/appearance.ts`, `main.tsx` | B3 |
| `e2e/selectors.mjs` | E0 creates; every brief edits only its own export block |
| `e2e/lib.mjs`, `e2e/layout.mjs`, `e2e/maintenance.mjs` | edited by several briefs in separate functions; expect trivial textual merges (see risks) |
| `.orgai/ARCHITECTURE.md` | B4 (dependencies and new modules), B13 (final pass); nobody else |

Rule for Wave 3: a brief that needs a style or a component owned by another brief asks for it via the primitive (B4) or does not use it. No brief edits `tokens.css` after B1; a missing token is added in a small follow-up commit to B1's file by the integrator (new tokens only, never changes).

## 4. Briefs

Size: S under 1 day, M 1-2 days, L 3+ days of focused work.

---

### E0: e2e selector map (module: Scripts, e2e and packaging) - S

Goal: make later selector changes one-line edits and give the app stable hooks.
Files:
- `e2e/selectors.mjs` (new): exports `shell`, `projects`, `projectSettings`, `appSettings`, `orgChart`, `run`, `decisions` objects of selector strings and role/name pairs. Initially encodes today's selectors exactly (see `spec.md` section 10).
- `e2e/lib.mjs`, `e2e/layout.mjs`, `e2e/maintenance.mjs`, `e2e/setup.mjs`, `e2e/history.mjs`, `e2e/worktree.mjs`: import from `selectors.mjs`; no behavior change.
- `e2e/README.md`: document the file and the `data-testid` naming rule (`kebab-case`, element role first, e.g. `branch-row`, `decision-card`).
Dependencies: none. Parallel with B0, B1, B2.
Acceptance: `npm run e2e:free` green; `node --check` on the three token-spending scripts; no change under `src/`.

### B0: brand assets (module: Brand assets) - S

Files:
- `src/renderer/src/assets/brand/mark.svg`, `mark-glyph.svg`, `wordmark.svg`, `lockup.svg`, `lockup-vertical.svg` (new). Geometry follows `spec.md` section 9 and must match `build/icon.png`.
- `scripts/make-icon.mjs` and `build/icon.png`: only if the glyph geometry is refined; otherwise unchanged.
- `src/renderer/src/env.d.ts`: ensure `vite/client` types for `*.svg` imports (or a `declare module '*.svg'`).
Dependencies: none; parallel with everything. Needs D12.
Acceptance: SVGs render at 16, 24, 48 and 512 px; the mark matches the icon pixel-for-pixel in layout; wordmark and glyph use `currentColor`; typecheck green.

### B1: token migration (module: Theme layer) - L, strictly serialized

This is the single pass that rewrites every rule of `global.css`. No other brief may touch `styles/` while it is open. No TSX changes.

Files:
- `src/renderer/src/styles/tokens.css` (new): all tokens from `spec.md` section 4 for dark (`:root`), light (`:root[data-theme='light']`), and system (`@media (prefers-color-scheme: light) { :root[data-theme='system'] ... }`); `color-scheme` per theme; default accent values statically derived for `#7c5cff`; a clearly marked **legacy alias block** mapping every current variable to the new tokens: `--bg`, `--bg-elev`, `--bg-elev-2`, `--panel`, `--border`, `--border-strong`, `--text`, `--text-dim`, `--text-faint`, `--accent-2`, `--ok`, `--radius`, `--radius-lg`, `--shadow`, `--font`, `--mono`. This lets the 119 inline styles and TSX hex-free references keep working until their briefs land.
- `src/renderer/src/styles/global.css`: becomes the entry: `@import` of `tokens.css` and the feature partials below, plus reset/base only (`html`, `body`, scrollbars, `:focus-visible`, `prefers-reduced-motion`, font setup).
- New partials, each a verbatim move of the matching current rules with every literal replaced by a token, class names unchanged: `styles/shell.css` (sidebar, brand, nav, topbar, tabs, pills), `controls.css` (btn, field, input, check, chip, card, empty), `projects.css`, `editor.css` (editor layout, side panel, role node), `run.css` (live layout, agent node, composer, permissions, legend, run strip, pause banner, done group), `transcript.css` (entry, agent-summary, logs, run history, finished list, markdown), `cards.css` (proposal, question, merge review, draft box, diff view, maint rows), `usage.css`, `flow.css` (React Flow overrides using the `--xy-*` mapping from `spec.md` section 6.2).
- `src/renderer/index.html`: `<html lang="en" data-theme="dark">`, `<meta name="color-scheme" content="dark light">`, inline `background` matching `--surface-0`.
- `src/renderer/src/styles/tokens.test.ts` (new, vitest, node env): parses `tokens.css` and asserts the dark and light blocks define the same set of custom properties.
Dependencies: none (E0 and B2 may run in parallel since they touch other folders).
Not in scope: markup, new classes, removing the alias block, new components.
Acceptance:
- Dark mode visually matches current screenshots within the intended token deltas (surface steps, text-tertiary and accent-on-fill contrast fixes); side-by-side `e2e/shots/` check.
- With `data-theme="light"` set in devtools, every screen is legible (list of screens in the review's section 2); light is not user-selectable yet.
- `grep` shows no hex, `rgb(`, `rgba(` or `box-shadow` literal outside `tokens.css` and no px radius literal.
- Sizes use the type tokens; no font-size below 11 px.
- typecheck, test, e2e:free green.

### B2: shared contracts and main (modules: Shared contracts; Main shell, stores and maintenance) - M

Files, in order:
1. `src/shared/types.ts`: `ThemeMode`, `CanvasPattern`, `CanvasEdgeStyle`, `AppearanceSettings`; `AppSettings.appearance`; `AppSettingsInfo.appVersion`.
2. `src/shared/defaults.ts`: `DEFAULT_APPEARANCE`, merged into `DEFAULT_APP_SETTINGS`.
3. `src/main/store/settings.ts` (+ a `settings.test.ts` beside it): normalization for missing or malformed `appearance` (bad hex falls back to the default; unknown enums to defaults), migration of existing `settings.json` files.
4. `src/main/index.ts`: read persisted settings before creating the window; `backgroundColor` from theme (dark `#0b0d12`, light `#f4f5f9`; `system` uses `nativeTheme.shouldUseDarkColors`); set `nativeTheme.themeSource`; apply `notifications` to the notifier at boot; fill `appVersion`.
5. `src/main/ipc.ts`: only if the `settings.set` handler must call into `index.ts` for `nativeTheme` and the notifier.
6. `src/preload/index.ts`, `src/preload/index.d.ts`: expected unchanged; verify types flow.
Dependencies: none for code; needs D9 and D11 answered. Parallel with B0, B1, E0.
Acceptance: unit tests for normalization and migration; typecheck for node and web; the existing Settings page still saves; flipping the Settings notifications checkbox now changes behavior (verify by test of the settings-to-notifier wiring).

### B3: theme layer logic (module: Theme layer) - M

Files:
- `src/renderer/src/lib/theme.ts`: `resolveTheme(mode)`, `deriveAccent(hex, mode)` (algorithm in `spec.md` section 5), `contrastRatio`, `readableOn(color)`, `applyAppearance(appearance)` (sets `data-theme`, accent CSS variables, canvas variables, `data-motion`), `useResolvedToken(name)` hook, `matchMedia` listener for `system` and `prefers-reduced-motion`.
- `src/renderer/src/lib/theme.test.ts`: contrast guarantees for a table of accents (`#7c5cff`, `#f5a524`, `#22c58b`, `#ffffff`, `#000000`, grays) in both modes; fill vs foreground >= 4.5, `accent-text` >= 4.5 on surfaces 0 and 3, hover/active >= 4.5; `readableOn` for the role palette; invalid hex handling.
- `src/renderer/src/lib/canvas.ts`: maps `AppearanceSettings.canvas` to React Flow props (`Background` variant, edge `type`, minimap flag) and a `useCanvasOptions()` hook.
- `src/renderer/src/store/appearance.ts`: zustand slice `{ appearance, hydrate(), applyLocal(a) }`; `hydrate` runs `settings.get()` at boot.
- `src/renderer/src/main.tsx`: hydrate before first render, call `applyAppearance`.
Dependencies: B1 (tokens), B2 (types).
Parallel with: B4.
Acceptance: tests above; toggling appearance in devtools (`useAppearance.getState().applyLocal`) switches theme, accent and canvas live, no reload; both themes pass the contrast table in the spec.

### B4: UI primitives and library adoption (module: Renderer UI) - L

Requires D1 (and D2 for Sonner). Files:
- `package.json`, `package-lock.json`: add `radix-ui`, `lucide-react`, optionally `sonner`, `react-resizable-panels`, `@fontsource-variable/inter` and `jetbrains-mono` (D2, D5). Exact versions chosen at install.
- `src/renderer/src/components/ui/`: `Button.tsx`, `IconButton.tsx`, `Input.tsx` (Input, Textarea, Select), `Field.tsx`, `SettingRow.tsx`, `SettingsLayout.tsx` (sub-nav + scroll-spy + `SettingsSection` card), `Checkbox.tsx`, `Switch.tsx`, `RadioGroup.tsx`, `SegmentedControl.tsx`, `Tabs.tsx`, `Badge.tsx`, `StatusDot.tsx`, `Card.tsx`, `ListRow.tsx`, `Dialog.tsx`, `ConfirmDialog.tsx` (+ `useConfirm()` promise helper to ease replacing `confirm()` call sites), `Sheet.tsx`, `Popover.tsx`, `DropdownMenu.tsx`, `Tooltip.tsx`, `Toast.tsx`, `Banner.tsx`, `Toolbar.tsx`, `EmptyState.tsx`, `Progress.tsx`, `Avatar.tsx` (uses `readableOn`), `Kbd.tsx`, `Code.tsx`, `index.ts`.
- `src/renderer/src/styles/ui.css`: styles for the primitives using tokens and `data-state` selectors; imported from `global.css` by B1's import list (one-line addition by this brief, the only edit to `global.css`).
- `src/renderer/src/components/ui/ui.dev.tsx` (a gallery route, `?gallery`, dev only) so both themes can be screenshotted per component state.
- `.orgai/ARCHITECTURE.md`: record the dependency decision, the `components/ui` module and the stylesheet partials. Needs the user's approval of D1.
Dependencies: B1 (tokens), B3 not required (Avatar can import `readableOn` once B3 lands; stub until then).
Parallel with: B3.
Acceptance: every primitive has the states in `spec.md` section 3 in the gallery in both themes; keyboard operation verified (tab order, arrow keys, `Esc`); no hex literals; the unused-import size impact of the bundle is recorded in the commit body.

### B5: shell, navigation and file split (module: Renderer UI) - L, serialized

Does the structural moves once so Wave 3 briefs own disjoint files.

Files:
- `src/renderer/src/store/useAppStore.ts`: replace `settingsTab` and the `'settings'` view with `projectTab: 'run' | 'org' | 'history' | 'settings'`, `projectSettingsSection`, `appSettingsPage`, `sidebarCollapsed`; keep selectors stable; add `openProjectTab()`. Project creation navigates to `org` (today: `settings`).
- `src/renderer/src/App.tsx`: new shell.
- `src/renderer/src/components/Sidebar.tsx`, `ProjectHeader.tsx`, `AccountCard.tsx`, `UsagePopover.tsx` (new); `UsageMeter.tsx` rewritten as shared bars used by the popover and the app settings page.
- Delete `NotificationsToggle.tsx` and `LogsLink.tsx` (functions move to B8's pages).
- `src/renderer/src/views/SettingsView.tsx`: split **as-is, no restyle** into `views/OrgChartView.tsx` (canvas, toolbar without the tab pair, inspector/draft side) and `views/ProjectSettingsView.tsx` (project settings form), with `MaintenancePanel` moved verbatim to `components/RepositoryPanel.tsx`; delete `SettingsView.tsx`.
- `src/renderer/src/views/HistoryView.tsx` (stub rendering the existing run list) and `components/RunHistory.tsx` (the existing `RunHistory` function extracted verbatim from `TranscriptPanel.tsx`; `TranscriptPanel` imports it until B11 removes the tab).
- `src/renderer/src/styles/shell.css` rewrite.
- `e2e/selectors.mjs` (`shell`, `projects` entry points), `e2e/layout.mjs`, `e2e/lib.mjs` navigation helpers: tab and nav selectors per `spec.md` section 10.
Dependencies: B3, B4, E0, B2 (notifications).
Acceptance: all screens still render with their old inner content; the new nav, header, tabs, account card, usage popover and collapsible sidebar work; Settings shows no AI panel yet beside it; `Logs` and the notifications toggle no longer in the sidebar; `e2e:free` green with updated selectors; both themes screenshotted.

### B6: projects page (module: Renderer UI) - M

Files: `views/ProjectsView.tsx`, `components/ProjectCard.tsx`, `components/NewProjectDialog.tsx`, `styles/projects.css`; e2e: `selectors.projects` and the `createProject` and `deleteProject` helpers in `e2e/lib.mjs`, assertions in `e2e/layout.mjs`.
Spec: section 2.4. Delete through `ConfirmDialog`.
Dependencies: B5. Parallel with B7-B11.
Acceptance: keyboard-reachable cards; empty state; dialog flow creates project with setup skipped (e2e `layout.mjs` covers both modes); status badge reflects running/needs-attention from the store.

### B7: project settings (module: Renderer UI) - M

Files: `views/ProjectSettingsView.tsx`, `components/RepositoryPanel.tsx`, `components/PermissionRulesPanel.tsx`, `styles/project-settings.css`; `e2e/maintenance.mjs`, `selectors.projectSettings`.
Spec: section 2.3 (project). Replaces `confirm()` for discard and uninstall with `ConfirmDialog`, so `maintenance.mjs` dialog handlers become button clicks. Danger zone includes `Delete project` (shares the confirm with B6's card menu via `useConfirm`).
Dependencies: B5. Does not touch `ProviderAuthPicker` (owned by B8); uses it as is.
Acceptance: all sections reachable from the sub-nav; the branch maintenance flows in `maintenance.mjs` pass with updated selectors; disabled `Review each report's changes` explains why when isolation is off.

### B8: app settings and appearance (module: Renderer UI) - M

Files: `views/AppSettingsView.tsx`, `components/AppearanceSettings.tsx` (theme, accent with contrast readout, canvas options, reduce motion, live preview card), `components/ProviderAuthPicker.tsx`, `styles/app-settings.css`; uses `store/appearance.ts` and `lib/theme.ts` from B3. e2e: `selectors.appSettings`; add a token-free e2e step in `layout.mjs`: set light theme through the UI, assert `data-theme`, screenshot, restore.
Spec: section 2.3 (app). Notifications row writes `AppSettings.notifications` only. `Data and about` shows `appVersion`, data dir, `Open log folder`.
Dependencies: B5 (and B2, B3). Parallel with others in Wave 3.
Acceptance: changing theme, accent and canvas options updates the whole UI live and persists across restart; an accent that fails contrast is adjusted and the readout says so; typecheck, test, e2e:free green.

### B9: org chart editor (module: Renderer UI) - M

Files: `views/OrgChartView.tsx`, `components/RoleNode.tsx`, `RoleInspector.tsx`, `DraftPanel.tsx`, new `components/ColorPicker.tsx`, `styles/editor.css`; `selectors.orgChart`.
Spec: section 2.7 and 6. Uses `useCanvasOptions()`, `colorMode`, token-based edges and markers (removes the hex literals at `SettingsView.tsx:61-65,185`, which move with the file). `Remove role` via `ConfirmDialog`.
Dependencies: B5. Acceptance: both themes; selection, connect, add role, auto-layout work; `e2e/layout.mjs` editor assertions pass.

### B10: run canvas, run bar and composer (module: Renderer UI) - L

Files: `views/LiveRunView.tsx` (slimmed), `components/run/RunBar.tsx`, `RunSelector.tsx` (replaces `RunStrip.tsx`, which is deleted), `Composer.tsx`, `PauseBanner.tsx`, `FoldToggle`/`Legend` inside React Flow controls, `components/AgentNode.tsx`, `components/DoneGroupNode.tsx`, `components/attention/AttentionHost.tsx` (new, **placeholder**: renders the existing permission, proposal, question and merge cards unchanged in a docked column so the layout no longer overlaps the toolbar; B12 completes it), `styles/run.css`; `selectors.run`.
Spec: section 2.5 and 6.3. Removes every `top: 52/56/96` offset and the `RunStrip` overlay.
Dependencies: B5. Acceptance: nothing is absolutely positioned relative to a sibling; node states in both themes per `spec.md` 6.3; `layout.mjs` live assertions (empty state, composer, long path) pass; node footer slots are stable.

### B11: side panel and history (module: Renderer UI) - M

Files: `components/TranscriptPanel.tsx` (tabs `Inbox`, `Agent`, `Log`; Inbox renders an optional `inbox` slot prop), `components/FinishedList.tsx`, `components/Markdown.tsx`, `components/transcript/*` (entry, ToolEntry collapsible, AgentHeader, StatChips), `views/HistoryView.tsx`, `components/RunHistory.tsx`, `styles/transcript.css`; optional `react-resizable-panels` wiring for the panel width (state in `store/useAppStore.ts` is owned by B5, so persist width in `localStorage` here).
Spec: sections 2.5 (side panel) and 2.6.
Dependencies: B5. Parallel with B6-B10; the props contract `TranscriptPanel({ agent, entries, logs, finished, inbox?, inboxCount? })` is stable and `LiveRunView` keeps passing the existing props until B12 adds `inbox`.
Acceptance: tool results collapse; thinking toggle; log tab with error count; no nested interactive elements in History; `maintenance`/`layout` e2e unaffected.

### B12: decisions, approvals and diff (module: Renderer UI) - M

Files: `components/attention/DecisionCard.tsx`, `PermissionCard.tsx` (extracted from `LiveRunView`), `ProposalCard.tsx`, `QuestionCard.tsx`, `MergeReviewCard.tsx`, `DiffView.tsx`, `AttentionHost.tsx` (tray plus sheet, collapsed banner), `views/LiveRunView.tsx` (one-line change to pass `inbox` and to mount `AttentionHost`), `styles/cards.css`; `e2e/lib.mjs` (`driveSetup`, proposal selectors), `selectors.decisions`.
Spec: section 2.5 (attention). Keeps button names `Approve`, `Request changes`, `Send feedback`.
Dependencies: B10 (host), B11 (inbox slot). Requires D4.
Acceptance: permission tray, proposal sheet, dismissal into the run bar banner and Inbox badge; `aria-live` announcement; diff readable in both themes; token-spending e2e scripts pass `node --check` and their selectors map to the new `data-testid`s (the user runs them).

### B13: cleanup, guards and theme QA (modules: Renderer UI; Scripts, e2e) - M

Files:
- `styles/tokens.css`: delete the legacy alias block; `styles/*.css`: remove dead selectors left by the restructure.
- `styles/tokens.test.ts`: extend to scan `src/renderer/src/**/*.{css,tsx}` for hex, `rgb(`, `rgba(` and `box-shadow:` literals outside `tokens.css` (allowlist: `assets/`, user-data role colors); fail the test on any other match.
- Remaining inline `style={{}}` that sets static visual values are moved to classes (dynamic CSS-variable injection like `--role` stays).
- `e2e/lib.mjs`: `screenshot(name)` also writes `-light` variants by switching appearance through `window.orgai.settings` (token-free); a short `e2e/README.md` update.
- `.orgai/ARCHITECTURE.md`: final pass (modules, conventions, risks resolved).
Dependencies: all. Acceptance: tests, typecheck, e2e:free green; a final screenshot set of every screen in dark and light attached to the PR; accessibility checklist of `spec.md` section 8 ticked.

## 5. Parallelism summary

| Can run in parallel | Why it is safe |
| --- | --- |
| E0, B0, B1, B2 | disjoint folders: `e2e/`, `assets/` and `scripts/`, `styles/` + `index.html`, `shared/` + `main/` |
| B3 and B4 | `lib/` + `store/appearance.ts` + `main.tsx` versus `components/ui/` + `styles/ui.css` + `package.json` |
| B6, B7, B8, B9, B10, B11 | disjoint views, components and style partials by the ownership table; shared pieces (primitives, tokens, theme, store, shell, `SettingsLayout`) are finished earlier |
| Not parallel | B1 with any other `styles/` edit; B5 with every renderer brief; B10 then B12; B13 last |

Residual conflict points (expect small textual merges, not logic conflicts): `e2e/lib.mjs` and `e2e/layout.mjs` are edited by B5, B6, B10 and B12 in different functions; `package-lock.json` only in B4; `useAppStore.ts` only in B5 (later briefs add UI state to feature-local stores or `localStorage` instead).

## 6. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| B1 is large and any concurrent `styles/` edit conflicts. | Strict serialization; no TSX changes; legacy alias block keeps the rest working; review as a mechanical diff (class names unchanged). |
| Light theme exposes untested corners (React Flow, diff, markdown). | Every Wave 3 brief screenshots its screens in both themes; B13 adds the light screenshot set and the literal guard test. |
| Radix adds behavior changes (focus traps, portals) that break e2e. | E0 selector map plus `data-testid` contract; confirm dialogs become role-based clicks; button names kept verbatim. |
| Sheet-based decisions change a core workflow. | Behind D4; fallback is the docked column implemented as B10's placeholder. |
| Setup-flow e2e scripts cannot be run without spending tokens. | Selectors updated and syntax-checked; one supervised run by the user after B12, with consent. |
| Accent derivation edge cases (near-white, near-black accents). | Unit tests in B3 for extreme inputs; the settings UI shows the adjusted result and contrast ratios. |
| 1024 px minimum window. | Sidebar collapses; side panel collapsible; verified with a 1024x680 screenshot in B5, B10 and B9. |
| Bundle growth (Radix + icons + fonts). | Per-primitive imports and per-icon imports; measure before and after in B4; fonts optional (D5). |

## 7. Definition of done (every brief)

1. `npm run typecheck`, `npm test`, `npm run build && npm run e2e:free` pass.
2. No hex, rgba or shadow literal and no px radius in files the brief touches, except in `tokens.css`.
3. Dark and light screenshots of every changed screen reviewed (`e2e/shots/`), including 1024x680.
4. Keyboard walk-through of the new controls (tab, arrows, `Esc`, focus return).
5. e2e selectors updated in the same commit; button names relied on by scripts unchanged unless listed in `spec.md` section 10.
6. One descriptive commit and a merge commit, body explaining why.

## 8. Revision 3: placement and brand briefs

Source: `ui-review-2.md` (findings P1-P15, B1-B10 and the code audit AU1-AU14; full briefs with file lists, selector changes and the exclusivity matrix are in its section D). Decisions are reflected in `spec.md` (Revision 3 note and section 9). Phase 1 is serialized and lands before Phase 2; Phases 2 and 3 run their briefs in parallel on disjoint files; Phase 4 is serial.

| Phase | Brief | Scope | Closes | Size | Depends on |
| --- | --- | --- | --- | --- | --- |
| 1 | 1A Tokens, brand assets, primitives | `tokens.css` surfaces, borders, gradient and type tokens; `mark.svg`, `mark-glyph.svg`; `Badge`, `Popover`, `Tabs`, `EmptyState`, `BrandLockup`; neutral disabled button; avatar tint | B1, B2, B3, B5, B6, B7, AU4, AU10 | L | none |
| 1 | 1B Shell | Sidebar (lockup, rail below 1180 px, Ctrl/Cmd+B, Needs-you popover, account row with usage popover, gear), topbar (folder name, underline tabs, one status carrier), status carriers, window title, skip link; all shell selector updates in `e2e/*.mjs` | P3, P4, P5, P6, P9, P10, P15, B4, AU2, AU5, AU6, AU8, AU9, AU13 | L | 1A |
| 2 | 2A Run workspace | Merge run strip and header (40 px), canvas toolbar (metadata, zoom, fold, legend popover), tray under the canvas (remove the `max-height: 420px` dock), side panel auto-collapse, composer 96 px, `NewRunPage` | P1, P2, P3, P7 (layout), P13, B3, B6, B9, AU1, AU11 | L | 1B |
| 2 | 2B Decision cards | Action-as-title card anatomy, compact mode, `Badge` kind chips (security pass) | P7, B3, B4 | M | 1B |
| 2 | 2C Transcript and History | Side-panel tabs, transcript text size, History status badge (security pass on Markdown) | P6, B6 | M | 1B |
| 3 | 3A Org chart tab | Primary Add role, single heading, conditional drafting primary, 320 px panel, role nodes | P8, B8 | M | Phase 2 |
| 3 | 3B Projects and New project | Cards (folder, last run, overflow menu), grid, form two-column with sticky submit | P11, P14 | M | Phase 2 |
| 3 | 3C Settings pages | One heading per page, section pattern, surfaces | P10, P12 | M | Phase 2 |
| 4 | 4A Nodes | Node content, working ring colour, remove glow and three of four loops | B8, AU3, AU14 | M | Phase 3 |
| 4 | 4B Cleanup and keyboard | Delete `.pill` and `.chip`, small-text and raw-px sweep, Tab-order assertion | rest of B3, B6, P15 | S | 4A |

Selector changes to carry with the briefs: `.nav-item` Settings becomes the "App settings" gear button; `.topbar .tabs` becomes the `Project sections` tablist; `.topbar .pill` (path and run status) becomes `[data-testid=project-folder]` and the selected run tab; `.run-header` becomes `[data-testid=run-strip]` and `[data-testid=run-meta]`; `.side .tabs` becomes the side-panel tablist. Contract request to the Runtime Lead (non-blocking): a brand-tonal `ROLE_COLORS` palette in `src/shared/defaults.ts`.
