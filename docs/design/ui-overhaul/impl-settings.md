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

### Runtime-backed settings (ov-runtime branch worktree-agent-af7cf20682e2c8be9, merged with git merge)

- **General**: Notifications gains "When a team needs me", "When a run finishes", "When a schedule finds something"
  (under the master switch, disabled while it is off) and "Play a sound" (off by default). New section "While OrgAI
  runs": "Open OrgAI when I sign in", "When I close the window" (Keep running / Quit), "Keep the computer awake during
  runs". Main stores and applies each (store/settings.ts, appBehaviour.ts, notifications.ts).
- **Play a sound**: `lib/sound.ts` (pure `chimeDecision`, WebAudio two-note chime, no asset, no network) and
  `lib/useAttentionSound.ts`, mounted once in App.tsx: chimes when a new decision key appears in any run, never for
  decisions already waiting at start or when the switch turns on, at most once per 4 s. `<html data-chime-count>`
  mirrors the count for e2e. Each window that renders App chimes for its own runs (a run window too).
- **Appearance** "Panels and text": See-through panels, Text size (Small / Default / Large), Spacing (Comfortable /
  Compact), Activity dots in the sidebar. `lib/theme.ts` writes `data-glass='off'`, `data-text-size`,
  `data-density='compact'`, `data-activity-dots='off'` (only for non-default values, before first paint from the
  cache); `tokens.css` adds attribute-scoped blocks (glass off = opaque surfaces, no blur; text ramp +/-; compact
  control heights and middle spacing). `noMotion` sets the existing `data-reduce-motion`; the Motion control keeps its
  two choices because Off and Always reduce behave the same under that rule. Sidebar keeps a quiet dot when activity
  dots are off (counts stay).
- **Branches** (code projects) "Before anything reaches main": Main branch (from `gitInfo.branches`, detected default
  first), Tests must pass, Test command (one line, saved on blur or Enter), Keep branches of failed runs for. Main
  enforces: the merge test gate in integration.ts, retention in maintenance.ts.
- **About** Help: Report a problem (opens the prefilled new-issue page), Details for support (copied), Licences.
- **Templates**: built-in charts in "Comes with OrgAI" (read only, test id `template-builtin`, no Remove), "Used N
  times" from `appliedCount`, Duplicate on every template.
- **Tools**: the test result marks each tool "Reads only" / "Can change or delete" from the server's MCP annotations
  when it gives them, with a one-line summary that says nothing enforces them.
- **Providers**: the plan window closest to its limit and its reset time per plan sign-in (`usageByConnection`).
- **Skills**: Updated date; the preview re-reads on `updatedAt`.

### Deviations

- Tools: the board's one mixed gallery would replace the services dialog that presets.mjs and team.mjs drive; the
  panel sits beside the existing tiles instead, and custom servers stay in "Your own tools (advanced)".
- Providers: the signed-in account and "updated N ago" stay in each card's status line; the plan limit and its reset
  show on the tile; no cost words per tier (a proxy's mapping makes them unreliable).
- Not built (ov-runtime: no main support, by decision): Language, Download updates by themselves (the consent model
  never downloads on its own), Name new branches (`Project.branchNamePattern` is validated in main but no live run applies
  it: Claude's SDK names its branches), "Let schedules run when I am near the limit" (`schedulesNearPlanLimit` is stored;
  no near-limit skip of scheduled runs exists to switch), "Dates look like" (main stores `dateFormat`; no renderer date
  formatting reads it yet, so no control ships), Show the welcome tour again (About board; onboarding is not a settings
  file).
- Corrected 2026-11-23 (the first draft listed these as not built; they are built and live): "Ask before using a more
  capable model" (`LimitsSection.tsx`, `Project.askBeforeStrongerModel`), "Most agents in one run"
  (`maxAgentsPerRun`, copy says it counts per run session), the day and month caps with "When a limit is reached" and
  "Warn me at" (`PERIOD_CAPS_LIVE` is `true`), the size of finished copies (`BranchRulesSection.tsx`,
  `maintenanceExtra.finishedCopiesSize`), Delete branch (`MaintenanceSection.tsx`), and Skills Duplicate and Export
  (`SkillsSection.tsx`, `skillsExtra`). Main now refuses every merge when "Tests must pass" is on and the command is empty
  and the pane says so ("while this is empty, merges are refused because there is nothing to run"); the refusal is in
  `integration.test.ts` and `testGate.test.ts`. The "Verified" and "Reviewer" lines below that say merges go untested
  without a command are the old behaviour.
- Motion "Off" (`noMotion`) is not offered separately: by rule it uses the Reduce motion switch, so it would behave
  exactly like "Always reduce".
- Day / month caps and the run-size "Most agents in one run" sit at rest only for metered projects; on a plan sign-in
  they are in Advanced (the at-rest tab-stop budget of the Limits pane, permissions.mjs).
- Built-in templates make the new-project form show its setup choices on every fresh profile (orchestrator decision);
  `e2e/lib.mjs` `pickSetup` drives either the checkbox or the choices.

### Verified

- typecheck, unit tests (new `toolCapabilities.test.ts`, every curated connector checked for host names as
  capabilities), build; e2e connections, connectors, presets, skills, engagement2, permissions (keyboard preview and
  Enter save, isolation on Branches), maintenance on the mock adapter. Screenshots of AI providers and Tools at
  1600x1000 dark / light looked at.
- Reviewer (set2-review): approve, no Critical or High; M1-M8 fixed (M9 is `KitSection.tsx`, reported to its owner),
  L1, L2, L4, L5, L6 fixed.
- Runtime-backed part: unit tests `sound.test.ts` (first observation, loaded runs, rate limit, off), `theme.test.ts`
  (attributes), `planLimit.test.ts`, `toolCapabilities.test.ts` (`toolSummary`); e2e connections.mjs (Appearance
  attributes after a change and after a reload, defaults remove them, Play a sound off and no chime, General rows
  save, built-in templates read only, Duplicate and remove), permissions.mjs (Main branch Automatic first, Tests must
  pass and Keep branches save). Reviewer (set2-review2): its High (caps shown while project spend was the stub) is
  handled by holding the caps back; Mediums M1-M7 fixed in the UI (M2's copy now says merges go untested without a command; the main-side refusal
  is requested from ov-runtime); Lows L1, L2, L5, L6, L9, L10 fixed.
- Final run on dev 3b0efe71 + this branch: typecheck clean; unit suite 15323 passed, 6 failed (Windows symlink and
  CLI timing tests in src/cli and src/main/runtime, failing on the unchanged base too); build; e2e connections,
  connectors, presets, skills, permissions, maintenance, project-connection, multi-provider, engagement2 all passed.

### Open

- Resolved since this was written (checked in the code 2026-11-23): the real `projectSpend` landed and `PERIOD_CAPS_LIVE`
  is `true` (day / month caps, at-cap behaviour and Warn me at show); `maxAgentsPerRun` has its row ("Most agents in one
  run"); main refuses a merge when "Tests must pass" is on with an empty command; the test panel shows MCP tool
  annotations when a server gives them.
- The attention chime plays in every window that renders App (a run window too).
- Resolved: `e2e/layout.mjs` no longer clicks `label.seg-item` (it was reported broken by the picture cards), and
  `KitSection.tsx` "Open connectors" now calls `setView('appSettings')` before dispatching the deep link.
- The atlas path text in `src/shared/view/atlas.ts` still names the old panes ("App settings > About > Updates" style);
  `e2e/self-help.mjs` asserts the old text.
- Low items left: gallery section and detail headings are h3 like their section title (L3); `dimmed` / `trailing` on
  gallery items are unused (a trailing control would add a Tab stop per tile).
- No UX walkthrough of part 2, no screen reader pass, narrow (1024x640) screenshots of Skills and Templates not looked at.
