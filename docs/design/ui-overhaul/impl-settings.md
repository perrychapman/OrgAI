# UI overhaul: Settings implementation notes

Lead: ov-settings, 2026-11-22. Boards: SettingsGeneral, Appearance, Settings (Permissions), Limits, Branches, About,
Providers, Tools, Skills, Templates. Renderer only; tokens from ov-foundation (merged at 5329de78).

## The frame (all boards)

- **One settings menu** (`components/settings/SettingsNav.tsx`, the boards' `snav`): a glass panel with an "App" group
  and a "Project: <name>" / "Engagement: <name>" group. App settings and a project's Settings tab stay two views (the
  shell owns routing), so each page shows its own panes as a native tablist (roving tabindex, arrows, Home/End) and the
  other page's panes as plain buttons that navigate there. The project group in App settings follows the selected
  project and is hidden for Chat / the helpers or before a project exists. Narrow widths: a scrolling strip.
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
- **Providers / Tools / Skills / Templates**: existing sections restyled to glass in the wide column, plain-language
  titles ("Your providers", "Services", "Your own tools (advanced)", "Your skills"), Tools helper / Skills helper
  entry points ("Ask the Tools helper", "Ask the Skills helper").

## Deviations from the boards and why

- Two views, one menu (see the frame). A true single Settings view needs App.tsx routing (ov-shell).
- The Providers card grid with a detail aside, the Tools / Skills / Templates gallery-with-aside layout and the
  "Fast / Standard / Most capable" tier columns were not rebuilt: the subagent limit blocked handing them to UI
  Engineers and the lead did the frame, permissions, limits, appearance and about. The existing cards and galleries
  (connector tiles with category chips and search already exist) carry the glass look. The app has four tiers (Top,
  Deep, Everyday, Fast), not three; the e2e and the model selects depend on those names.
- Permissions: Unattended is "Recommended" (the app's recommendation), not Auto-accept edits as drawn.
- Isolation and merge review stay in Permissions > Advanced > Runs rather than moving to Branches (permissions e2e and
  deep links depend on them there).

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
