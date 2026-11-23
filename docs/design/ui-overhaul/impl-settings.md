# UI overhaul: Settings implementation notes

Lead: ov-settings, 2026-11-22. Boards: SettingsGeneral, Appearance, Settings (Permissions), Limits, Branches, About,
Providers, Tools, Skills, Templates. Renderer only; tokens from ov-foundation (merged at 5329de78).

## The frame (all boards)

- **One settings menu** (`components/settings/SettingsNav.tsx`, the boards' `snav`): a glass panel with an "App" group
  and a "Project: <name>" / "Engagement: <name>" group. (Part 2 below made this one view: both groups are tablists and
  every pane shows in place.) The project group follows the selected project and is hidden for Chat / the helpers or
  before a project exists. Narrow widths: a scrolling strip.
- **Pane ids are the atlas ids**, so every deep link still lands. New renderer-only pane `appearance`
  (`lib/settingsMenu.ts` `appSettingsPaneFor` maps the atlas `appearance` and `canvas` sections, and the Motion
  surface, to it).
- **Labels** (owner decision 8, plain language): App: General, Appearance, AI providers, Tools and services, Skills,
  Templates, About and updates. Project: Basics, Permissions, Spending limits, Branches (code) or Maintenance
  (engagements: no branches there).
- **Page header**: top bar h1 "Settings", "Search settings", "Changes save as you make them" and the save indicator;
  each pane opens with a scope caption, the h2 (the tab label, still the deep-link focus target) and one line.
- **Search settings** (`SettingsSearch.tsx`, `lib/settingsSearch.ts`): matches the app atlas's settings surfaces (the
  same source self-help uses) by label, summary and menu location; results are buttons that deep-link (App targets
  through `orgai:settings-section`, project targets through the project's Settings tab). Down/Up/Escape, a polite
  count, closes on blur.
- **Look**: `.settings-card` is a glass group card (`--glass`, `--glass-line`, `--glass-blur`, radius-xl); section
  titles use `--font-display`; `.card-block` inside settings and connector tiles take the same glass.

## Per board

- **SettingsGeneral**: About you (name), Notifications, "New projects start with" (How much the team asks = the
  existing default mode select; AI provider shows the effective default with "Change" to AI providers), "On this
  computer" (the orgai command row, moved out of Advanced; data folder with copy and Open folder). Advanced keeps the
  assistant model rows, renamed "Tools helper model" and "Skills helper model", and the starting tiers.
- **Appearance**: colour mode as three picture cards (native radios; thumbnails mix from black/white so they show the
  mode whatever the current theme is), accent swatches and custom hex (unchanged behaviour), Motion (Match my
  computer / Always reduce), a live preview drawn with the tokens (working dot pulses only without reduced motion),
  then the existing Canvas section (presentation: Graph, Pocket Office, Factory Floor; styles; Customise).
- **Settings (Permissions)**: "How much the team asks you": `PermissionModeCards` (three cards, three more behind
  "More options"), each with a plain title and the exact mode name used elsewhere, the trade-off sentence, Recommended
  on Unattended (the app's own recommended default; the board recommended the middle card) and a danger tag on Bypass.
  Bypass asks for confirmation before it saves. An effects table says what happens to three common actions, worded so
  it holds on every provider (checked against `claude.ts` `claudePermissionMode` and `codexProtocol.ts` `policyFor`).
  The rules and folders summary, folder trust and Advanced (Runs) are unchanged.
- **Limits (Spending limits)**: a hero with this month's spend for the project (`runs.usageOverview`, unknown cost
  says "Cost unknown", partial says "At least"), the per-run cap line when set and "See where it went" (Usage page
  filtered to the project, this month). The cost cap row (metered) or the plan guard line (subscription), then "How big
  a run can get" (depth and concurrency selects, now visible). Staffing, plan guard rows and keep-runs stay in Advanced.
- **Branches**: the existing Maintenance content (worktree cleanup, org review, danger zone) under the Branches label.
- **About and updates**: Updates first (the card takes the accent border when a newer version is waiting; release
  notes stay plain text), then About OrgAI (version, maker, platform, data and logs folders), then Help (Ask OrgAI
  about itself, Keyboard shortcuts).
- **Providers / Tools / Skills / Templates**: plain-language titles ("Your providers", "Services", "Your own tools
  (advanced)", "Your skills"), Tools helper / Skills helper entry points. Part 2 rebuilt them as galleries with a
  detail panel (below).

## Deviations from the boards and why

- (Part 1 only, since resolved by part 2: two views, the galleries not rebuilt, isolation left in Permissions.)
- Permissions: Unattended is "Recommended" (the app's recommendation), not Auto-accept edits as drawn.

## Needs runtime (sent to ov-runtime)

General: open at sign-in, close behaviour, keep awake during runs, per-event notifications, play a sound, language,
date format. Appearance: motion Off, see-through panels, text size, spacing, sidebar activity dots. Limits: day and
month limits, pause vs stop, warn at a percentage, ask before a stronger model, schedules near the plan limit.
Branches: main branch, branch name pattern, tests must pass and test command, keep failed branches N days, size of
finished copies, remove OrgAI's files. About: auto download (consent model), report a problem, support details,
licences. Providers: signed-in account, limit reset time. Tools: the team can / cannot per tool, sign-in expiry.
Skills: origin, duplicate, export. Templates: built-ins, usage count, duplicate. Shared: atlas paths and labels for the
new menu (self-help breadcrumbs).

## Verified

- typecheck and build pass; e2e connections, permissions (incl. new mode-card checks), maintenance, canvas, skills,
  connectors and layout checks pass on the mock adapter (see the hand-back report for the exact runs).
- Screenshots at 1424x855 in dark and light of General, Appearance, About, AI providers, Tools and services, Skills,
  Templates and the four project panes.
- Reviewer: one High (the dontAsk effects overstated safety on Codex) and Mediums fixed; recheck in the report.

## Open

- Atlas path text (shared) still names the old panes; `e2e/self-help.mjs` asserts it.
- `RunActions.tsx` ("App settings > General") and `TeamAssistantTray.tsx` comments use old names (other leads).
- No UX walkthrough of the changed flow yet; no screen reader pass; macOS not checked.

## Part 2 (lead ov-settings-2, 2026-11-22)

### Built

- **One Settings view.** `AppSettingsView` shows both menu groups as native tablists (`SettingsNav` `groups`; testids
  `settings-tab-<app|project>-<pane>`) and renders the project's panes in place (`ProjectSettingsPanes.tsx`). The
  project Settings tab (`views/SettingsView.tsx`, still routed by App.tsx unchanged) embeds the same view, opening on
  the stored project pane and without its own topbar. App.tsx was not touched; ov-shell agreed. In the embedded view
  App deep links are left alone (they navigate to the App settings view), so a caller must `setView('appSettings')`.
- **Shared gallery** `components/settings/SettingsGallery.tsx`: tiles are native buttons (aria-pressed, aria-controls
  the aside) in one roving tab stop (arrows, Home, End), sections with actions and footnotes, search and filter chips
  with a polite count, a sticky glass aside (static under 820 px of window height or a narrow column, scrolls inside
  when taller than the window), Detail parts (header, note, can / cannot list, facts, chips, actions).
- **AI providers** (Providers board): a tile per connection (how it signs in, Default, projects using it, model count,
  status in words; "Needs attention" breathes), a dashed "Add a proxy" tile, the selected connection's full card in the
  aside (`ConnectionCard` / `ProxyCard` `embedded`: always open, no collapse), then "Model tiers on <provider>": all
  four tiers with plain names (Top = Most capable, Deep = Deep thinking, Everyday = Standard, Fast = Fast), each with
  the app tier word, what it is for, the exact model id it resolves to (automatic or mapped) and how many roles in
  your projects use it there. Editing stays in the card's tier editor.
- **Tools and services** (Tools board): the services gallery keeps its tiles, chips, search, ranked order and dialogs
  (other e2e drive them) and gains the detail panel beside it, following the focused or clicked tile: state note,
  "The team can / could" and "cannot" (`connectors/toolCapabilities.ts`: the service's description, the variant's
  read-only declaration worded as enforced by the service not OrgAI, "can" only when connected and used by a project),
  sign-in expiry only when the entry needs attention, preset notes behind "Good to know", projects and roles that use
  it (Role grants through `mcpServersForRole`), the tile's action and "Ask the Tools helper". Presets and "Your own
  tools" stay below as before.
- **Skills** (Skills board): tiles per library skill (source, file count, in use or not, a warning when it carries
  scripts), filters In use / Not used yet, a dashed "Write a skill" tile, and a detail panel with a plain-text preview
  of the instructions (first 1,200 characters, says when cut, bidi controls shown as a replacement mark, re-read after
  an edit), projects and roles that use it, Edit, Remove (focus moves to New skill and a status says so).
- **Templates** (Templates board): tiles per saved template (kind, role count, saved date), kind chips when both kinds
  exist, a detail panel with the role names, what a template keeps, Start a new project and Remove.
- **Permission mode cards**: arrowing previews a mode (dashed card, "not saved yet" bar, the effects table captioned
  "(not saved)"); Enter, Space, a pointer click or "Use <mode>" saves; "Keep <mode>" drops the preview; folding More
  options drops a preview hidden there. Bypass still asks first on every save path.
- **Branches**: "Where work happens" (engagements: "Separate copies", only once opted in) holds worktree isolation and
  merge review, moved from Permissions > Advanced (`WorkCopiesSection.tsx`, same fields and rules).

### Deviations

- Tools: the board's one mixed gallery would replace the services dialog that presets.mjs and team.mjs drive; the
  panel sits beside the existing tiles instead, and custom servers stay in "Your own tools (advanced)".
- Providers: no "Signed in as", "Limit resets", "Last checked N min ago" rows beyond what the cards already show;
  no cost words per tier (a proxy's mapping makes them unreliable).
- Templates: no built-in templates, usage counts or Duplicate (no data). Skills: no Duplicate or Export.
- Branches board rows that need runtime (main branch, branch name pattern, tests must pass, keep failed branches) are
  not drawn.

### Verified

- typecheck, unit tests (new `toolCapabilities.test.ts`, every curated connector checked for host names as
  capabilities), build; e2e connections, connectors, presets, skills, engagement2, permissions (keyboard preview and
  Enter save, isolation on Branches), maintenance on the mock adapter. Screenshots of AI providers and Tools at
  1600x1000 dark / light looked at.
- Reviewer (set2-review): approve, no Critical or High; M1-M8 fixed (M9 is `KitSection.tsx`, reported to its owner),
  L1, L2, L4, L5, L6 fixed.

### Open

- `e2e/layout.mjs` clicks `label.seg-item` "Dark" in Colour mode, which part 1's picture cards replaced; it fails on
  dev independent of part 2 (reported to the orchestrator).
- `KitSection.tsx` "Open connectors" dispatches an App deep link without `setView` (reported).
- Low items left: gallery section and detail headings are h3 like their section title (L3); `dimmed` / `trailing` on
  gallery items are unused (a trailing control would add a Tab stop per tile).
- No UX walkthrough of part 2, no screen reader pass, narrow (1024x640) screenshots of Skills and Templates not looked at.
