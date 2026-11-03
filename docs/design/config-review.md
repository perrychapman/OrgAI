# Settings restructure spec (config review)

Status: spec for the next implementation pass. Source: `ux-review-config.md` (audit at bbbbffe, H1-H3, M1-M6), refined by
the orchestrator's decisions. Supersedes `spec.md` 2.3 (pane lists, the Defaults row table and the "shared settings"
paragraph) wherever they differ. Conventions from `spec.md` 2.3 hold: `SettingsPage`, `SettingsNav`, `SettingsSection`
(h3), `SettingsGroup` (h4 caption over a card), `SettingsCard`, `SettingRow` (label and one-line description left,
control right, 56 px rows), `ClampedNumber`; copy from `lib/settingsCopy.ts` (one line per row, sentence case, no
internal tool names). Tokens, the type scale, container queries, lucide icons, both themes, visible focus. Nothing
floats: every disclosure opens in the flow.

## 1. Data the UI reads (runtime contracts landing concurrently)

| Contract | Used for |
| --- | --- |
| `ConnectionInfo.isDefault` (connections:list) | The effective default: the stored one when connected, else the only connected connection. Badge on the card, the New project line, the assistants' model lines. The renderer never computes the default itself (drop `newProjectConnection` fallback logic in `lib/projectsForm.ts`). |
| `AppSettings.defaultConnectionChosen` | Set by main once the user picks. The renderer only writes `defaultConnection` through the card action; settings:set refuses a not-connected id, and the card shows that error inline. |
| `planGuardOf(project)` 'on' / 'off' / 'auto' | Limits plan guard line and its override; writes `Project.preferEverydayNearLimit` true / false / undefined (auto). `opusGuardThreshold` is fixed at 80 and never shown. |
| `effectiveSubagentLimits(project)` | "Automatic (N from the chart)" and "Automatic (8)"; overrides write `maxSubagentDepth` / `maxConcurrentSubagents`, Automatic writes undefined. |
| `skillEvaluationOf(project)` | Derived from `teamReview.auto === 'ai'`; the UI no longer writes `skillEvaluation`. |
| `PERMISSION_MODE_OPTIONS` (provider-neutral) | Mode labels; no "Claude" anywhere in permission copy. |
| `effortOptionsFor(adapterId)` | Role Effort options. |
| `projects.checkPath(path).isGitRepo` | Worktree automatic state for a stored project (call once per pane mount, keyed by `project.path`). |

Metered vs subscription (new pure helper `lib/limits.ts` `isMeteredProject(project, connections)`, unit-tested):
metered when the project's connection is LiteLLM, or its `ConnectionInfo.connection.auth.kind === 'apiKey'`
(Anthropic or OpenAI). Everything else, including the mock adapter on a login connection, is subscription. Unknown
(connections not loaded) renders as subscription without the plan line until loaded.

## 2. The Advanced disclosure primitive

`components/settings/SettingsAdvanced.tsx`, `export function SettingsAdvanced({ paneKey, children })`.

- A native `<details className="settings-advanced" data-testid="settings-advanced" data-pane={paneKey}>` with
  `<summary>` whose visible text is exactly "Advanced settings" (that is its accessible name; no aria-label override,
  so the label-in-name rule holds) and a lucide `ChevronRight` that rotates 90 degrees when open
  (`--dur-fast`, none under reduced motion).
- Styled like the row "Learn more" (`.setting-row-more` in `styles/settings.css`): text button in
  `--text-body`, secondary colour, accent on hover, the shared `:focus-visible` ring. It sits after the pane's last
  section with the normal 32 px section gap and a hairline above; the body uses the same `SettingsGroup` +
  `SettingsCard` + `SettingRow` pattern, so rows inside look like rows outside.
- At most one per pane, always last. Closed by default. Open state remembered per pane in localStorage
  `orgai.settingsAdvanced.<paneKey>` ('1' open, absent closed; read once on mount, written on the `toggle` event,
  storage errors ignored). Pane keys: `app-general`, `app-connections`, `project-permissions`, `project-limits`.
  Not per project.
- Deep links: a target inside Advanced sets `open` before scrolling (the toggle event then stores it, like a click).
- Nothing inside is mounted lazily in a way that moves focus; opening never moves focus.

## 3. App settings: 5 panes

Nav: **General, Connections, Connectors, Skill library, About**. The Defaults pane, `APP_SETTINGS_PANES.defaults`,
`APP_SETTINGS_SECTIONS.defaults` / `.usage`, the highlight-usage logic in `AppSettingsView.tsx` and
`DEFAULT_CONNECTION_COPY` are deleted. Removed from the UI entirely (fields stay in types, untouched): default cost cap,
default runs to keep, default keep-going, default max continues, default isolate writers, default everyday-near-limit,
weekly threshold, the Default connection select.

### 3.1 General

| Where | Row title | Control | Description | Writes |
| --- | --- | --- | --- | --- |
| Visible, section Appearance (`appearance-section`), card | Theme | Segmented Dark / Light / System | System follows your operating system. | `appearance.theme` |
| same card | Accent colour | Swatches + Custom (as today) | none | `appearance.accent` |
| Visible, section Notifications | Notify me when a run needs attention or finishes | Switch `notifications-switch` | Shown by your operating system while OrgAI is in the background. | `notifications` |
| Visible, section New projects (`appsettings-section-new-projects`, testid `new-projects-section`, lead "Starting values for new projects. Existing projects keep their own.") | Permission mode | Select 240 px, short names, testid `default-mode-select` | The selected mode's trade-off sentence (`PERMISSION_MODE_TRADEOFF`) | `defaultPermissionMode` |
| Advanced, group "Motion and canvas" | Motion | Segmented Follow system / Always reduce | Reduce animation across the app. | `appearance.reduceMotion` |
| same | Pattern, Connection lines, Tint with the accent, Minimap | as today | none | `appearance.canvas.*` |
| Advanced, group "Assistant models (used now by every project)", section id `appsettings-section-assistant-models` | Setup model | ModelSelect `setup-model-row-select` | Plans and revises org charts and reviews finished runs. | `setupModel` |
| same | MCP assistant model | `mcp-assist-model-row-select` | Writes and tests connectors with you. | `mcpAssistModel` |
| same | Skill assistant model | `skill-assist-model-row-select` | Writes and revises skills. | `skillAssistModel` |
| same | Chat model | `quick-run-model-row-select` | Answers in Chat. | `quickRunModel` |
| Advanced, group "New projects (advanced)" | Orchestrator starting tier | `default-root-model-row-select` | Leads each new project's runs. | `defaultRootModel` |
| same | Report starting tier | `default-report-model-row-select` | Used by the roles that report to the orchestrator. | `defaultReportModel` |

Under the assistant models card, one muted line: "Tiers resolve through each project's connection." (the long note
goes). ModelSelect options: the four tiers first, each labelled "Everyday tier (sonnet)" with the model it resolves to on
the effective default connection, then an "Exact model" optgroup (concrete ids). Model selects use the sans face and
the 240 px select width (audit L1). At rest the General pane has no model select.

### 3.2 Connections

- Cards as today (`ConnectionsPanel`, `connection-card[data-provider]`). Badge `default-connection-badge` reads
  "Default for new projects and assistants" on the card whose `ConnectionInfo.isDefault` is true. Other connected cards
  show the existing secondary "Use for new projects" button (add testid `connection-make-default`; accessible name
  "Use <Name> for new projects and assistants"); a not-connected card never shows it. One primary action per card stays
  (Connect when not connected).
- Per card, inside the opened card: "Models (N)" and the tier disclosure, renamed "Model tiers" with an "Automatic"
  badge while they match the catalog. Unchanged otherwise.
- Pane Advanced (`app-connections`), section "Costs" (`appsettings-section-costs`, lead "Where cost estimates come
  from."): Community price list (`community-prices-row`, Switch, "Fetches a public price list for models without a
  built-in price. Your prices below win.", `communityPrices`), then `ModelPricesSection` (id
  `appsettings-section-model-prices`, testid `model-prices`, writes `modelPrices`).

### 3.3 Connectors, Skill library, About

Unchanged.

## 4. Project settings: 4 panes

Nav: **General, Permissions, Limits, Maintenance**. `PROJECT_SETTINGS_PANES` becomes `general`, `permissions`,
`limits`, `maintenance`. A stored pane id of `agents` maps to `permissions`; `connection` maps to `general`; `tools`
maps to `general` (in `SettingsView` before the fallback). The "Plugins and skill settings" pane, its
`tools-team-pointer` banner and `open-team` button, and the `SkillEvaluationSettings` mount are deleted. The "Keep going
until the plan is complete" switch is removed (one exception: section 4.2 legacy row).

### 4.1 General (no Advanced)

| Row title | Control | Description | Writes |
| --- | --- | --- | --- |
| Name | Input | none | `name` |
| Working directory | Read-only mono path (full path in `title`) + Button "Change folder" (folder picker) | none | `path` |
| Project brief | Textarea, full width | hint "Added to every role's prompt and used by the drafter." | `brief` |

The typed path input goes (one tab stop instead of two; a typed path was never validated here). Then section
"Connection" (id `settings-section-connection`, `RemapNotices` above it):

- **One line** (testid `project-connection-line`) when fewer than 2 connections are connected and the project's
  connection is connected: "Runs on Anthropic (Claude Code login)." plus the link button "App settings > Connections"
  (`requestAppSettingsSection(APP_SETTINGS_SECTIONS.connections)`). No Role models disclosure, no prices link.
- **The three cards** (today's `ProjectConnection`, fieldset `project-connection`, Review changes, `role-models`,
  `model-prices-link`) when 2+ connections are connected, or when the project's own connection is not connected (the
  user must be able to switch away). The lead keeps "App default for new projects: <Name>." when it differs.
- Auth method words (new `lib/connectionLabel.ts` `authMethodLabel(info)`, shared with the New project form):
  Anthropic "Claude Code login" / "API key", OpenAI "ChatGPT sign-in" / "API key", LiteLLM "proxy key".
- Under ORGAI_MOCK the mock card (`mock-adapter-toggle`) stays last, unchanged.

### 4.2 Permissions

Visible, section Permissions (id `settings-section-permissions`):

| Row title | Control | Description / hint | Writes |
| --- | --- | --- | --- |
| Permission mode | Select 240 px (short names) | Description `permission-mode-tradeoff`: the provider-neutral trade-off ("auto": "The model's safety check approves routine calls and asks when unsure. Fewest prompts."). Hint: "App default for new projects: Unattended" (testid `permission-mode-default`; no reset). No Learn more. | `permissionMode` |
| (note under the row) | none | `permission-mode-note`, as today | |
| Rules and folders you allowed | Button "Show" / "Hide", `aria-expanded`, `aria-controls`, testid `permissions-summary-toggle`; row testid `permissions-summary` | "3 rules and 1 folder you allowed" (plural-aware; zero: "None yet. Approval cards add them here.") | none |

The toggle discloses, in the flow below the row: one paragraph with today's `MODE_MORE` text (de-Claude'd), then the
existing `AllowedDirectoriesSection` and `PermissionRulesPanel` unchanged (their ids, testids and behaviour stay). Folder
count is `project.allowedDirectories.length`; the rule count comes from the same preload call `PermissionRulesPanel`
makes, refreshed when the panel changes. A deep link to `allowedFolders` or `rules` opens the disclosure first.

Advanced (`project-permissions`), one card "Runs":

| Row title | Control | Description | Writes |
| --- | --- | --- | --- |
| Isolate writers in worktrees | Switch; disabled with reason when not a git repo | "Automatic: git repository found." / "Off: not a git repository." / "Off for this project." (when the user turned it off) | `isolateWriters` (false = override off; on writes undefined) |
| Review each report's changes before merge | Switch; disabled unless isolation is effectively on | You merge, hold or discard each diff. | `reviewMerges` |
| Let runs message each other | Switch (label unchanged) | Orchestrators can exchange short notes. | `runMessaging` |
| Max automatic continues per run | ClampedNumber 0..`MAX_AUTO_CONTINUES_LIMIT` | Stops nudging a run after this many. | `maxAutoContinues` |
| Team assistant | Select Off / Free checks / AI suggestions, testid `team-assistant-select` | Off: "Never looks for missing tools or skills." Free: "Checks your runs without the model." AI: "Also asks the model; sends the names of found tools and skills." | `teamReview.auto` ('off' / 'free' / 'ai') |
| Keep going until the plan is complete (legacy) | Switch | Shown only while `autoContinue === false`, so it can be turned back on. | `autoContinue` |

No "every N runs" or token budget fields; their stored values stay untouched.

### 4.3 Limits

Visible, section Limits (id `settings-section-limits`):

- Metered project: row "Estimated-cost cap per run", Input number 120 px, placeholder "No cap", description "Stops a
  run above this USD cost. Blank: no cap." (no Learn more), writes `maxBudgetUsd`.
- Subscription project: one line, no control (testid `plan-guard-line`), from `planGuardOf`: auto "Plan guard:
  automatic. Stops near your five-hour limit and uses the everyday tier when the weekly window passes 80%."; on "Plan
  guard: on. Uses the everyday tier when the weekly window passes 80%."; off "Plan guard: off."

Advanced (`project-limits`), one card:

| Row title | Shown | Control | Description | Writes |
| --- | --- | --- | --- | --- |
| Plan guard | subscription only | Select Automatic / On / Off | Uses the everyday tier when the weekly window passes 80%. | `preferEverydayNearLimit` undefined / true / false |
| Stop at a share of the five-hour window (%) | subscription only | Input number, placeholder "Off" | Stops a run that uses more than this share. | `maxWindowShare` |
| Estimated-cost cap per run | subscription only (visible above when metered) | as above | as above | `maxBudgetUsd` |
| Runs to keep | always | ClampedNumber 1..5000 | Older finished runs are deleted. | `keepRuns` |
| Max subagent depth | always | Select: "Automatic (N from the chart)", 1..`MAX_SUBAGENT_DEPTH_LIMIT` | 1 means reports cannot create subagents. | `maxSubagentDepth` |
| Max concurrent subagents | always | Select: "Automatic (8)", 1, 2, 4, 8, 12, 16, 24, 32 (a saved other value is added) | Reports that may run at once. | `maxConcurrentSubagents` |

The "Threshold: 80% · Change in App settings" hint and the settings fetch in `LimitsSection` go.

### 4.4 Maintenance

Unchanged.

## 5. Elsewhere

- **Team > Catalog**: `PluginsSection` variant 'catalog' becomes the only variant: a third `CatalogGroup`
  (`catalog-plugins`) beside Skills and Connections with Add plugin folder and per-row Remove inline (today's settings
  controls; `plugins-section` body testid moves here). `catalog-plugin-settings` and the "Add them in Plugin
  settings" copy go. On a project whose adapter is not Claude the group says "Plugins are used only on Anthropic
  projects." in its description.
- **New project form** (`new-project-connection`): "Runs on <Name> (<auth method>)." + link "Change"
  (`new-project-connection-change`) to App settings > Connections, from the `isDefault` entry. Nothing connected:
  "Nothing is connected yet." + link "Connect". Mock checked: "Runs on the mock adapter (no tokens)." with no link.
- **Chat start page**: `chat-summary` reads "... Runs on <model> via <Connection>. ..." (connection always present,
  from `isDefault`), without the "Change in App settings > Defaults" sentence; a link button `chat-model-change`
  "Change in App settings" follows the line. `AssistantModelLine` (MCP and Skill assistant start pages) reads "Runs on
  <model> via <Connection>." + "Change in App settings".
- **Role panel** (`RoleInspector`, `RoleModelPicker`): the fold title is "Model" (summary: the tier label, "Inherited"
  or "Custom"). Inside: one Select labelled "Model" (`role-model`) with Inherit plus the four tiers as "Everyday
  (sonnet)"; then a `details.setting-row-more` "Advanced" with "Exact model" (`role-exact-model`, concrete ids) and
  "Effort" (`role-effort`, Default plus `effortOptionsFor(adapter)`). A saved unsupported value stays selected as
  "xhigh (not used on OpenAI)" with a one-line note `role-effort-unsupported`. The `role-tier-badge` and the second
  "Model" label go. canSpawn and spawnable unchanged.
- **Copy**: `SETTINGS_COPY.permissionMode.more`, `PERMISSION_MODE_TRADEOFF.auto` and `MODE_MORE` lose "Claude"
  ("the model's safety check"). Remove `autoContinue` (except the legacy row label), `opusThreshold` and
  `DEFAULT_CONNECTION_COPY`; `preferEveryday` becomes `planGuard`. `RunActions` retro help: "set in App settings >
  General".

## 6. Deep-link retargeting

| Source | Today | New target |
| --- | --- | --- |
| `AssistantModelLine` (MCP / Skill assistant start pages) | `APP_SETTINGS_SECTIONS.defaults`, "Change in App settings > Defaults" | `assistantModels` (General, Advanced opened, group heading focused), "Change in App settings" |
| `McpAssistDialog` `mcp-assist-model-hint` | defaults, same text | `assistantModels`, "Change in App settings" |
| Chat start page `chat-summary` (`lib/assistants.ts` `chatSummaryLine`) | text "Change in App settings > Defaults" | sentence dropped; `chat-model-change` link to `assistantModels` |
| New project form `new-project-connection` | defaults, "App settings > Defaults" | `APP_SETTINGS_SECTIONS.connections`, "Change" |
| `LimitsSection` "Change in App settings" | `usage` (weekly threshold row) | removed (override is in the same pane's Advanced) |
| `RunActions` retro tooltip | text "App settings > Defaults" | text "App settings > General" (no link) |
| `requestModelPrice` (Usage "Set a price", project `model-prices-link`) | `modelPrices` on Connections | unchanged id; opens `app-connections` Advanced first, then scrolls and focuses |
| `PermissionCard` `perm-settings-link` | pane `agents` + `permissions` section | pane `permissions` + same section |
| `PluginsSection` `catalog-plugin-settings` | pane `tools` | removed |
| `ProjectConnection` / `project-connection-line` link, Sidebar auth row | `connections` | unchanged |
| `requestAppSettingsSection` with a removed id (`defaults`, `usage`) | Defaults pane | `appPaneForSection` returns undefined; the page opens on General |

`lib/settingsTarget.ts`: add `newProjects`, `assistantModels`, `costs` to `APP_SETTINGS_SECTIONS` (General, General,
Connections); `PROJECT_SECTION_PANE` maps `permissions`, `allowedFolders`, `rules` to 'permissions'. A new
`ADVANCED_SECTIONS` set (`assistantModels`, `costs`, `modelPrices`) tells `AppSettingsView` to open the pane's Advanced
before landing. `useSectionTarget` moves from `AgentsSection` into the new `PermissionsSection` with
`takeProjectSettingsSection('permissions')`. Update `settingsTarget.test.ts` and `projectsForm.test.ts` /
`assistants.test.ts` in the same change.

## 7. e2e selector plan (same change as the code)

| Script | Today | Becomes |
| --- | --- | --- |
| `connections.mjs` 41-104 | tab "Defaults"; combobox "Default connection"; Setup / MCP assistant model; "A tier resolves..." note; tier-label and clipping checks; Setup model and default connection persistence | tab "General", open `[data-testid=settings-advanced][data-pane=app-general] > summary`; same comboboxes by name; note text "Tiers resolve through each project's connection."; tier and clipping checks run on Advanced selects; Setup model persistence after reopen (Advanced remembered open, assert it); the default-connection block becomes: `default-connection-badge` count 1 on Connections, and `connection-make-default` absent on not-connected cards |
| `connections.mjs` 141-161 | tab "Connection", `#settings-section-connection`, `project-connection` fieldset | tab "General", same section id; `mock-adapter-toggle` unchanged; fieldset checks only when `project-connection` exists, else assert `project-connection-line` |
| `connections.mjs` 131, 166-172 | `catalog-plugins`; `role-model-fold`, `role-model`, `role-tier-badge` | `catalog-plugins` unchanged (+ `plugins-section` inside it); `role-tier-badge` check replaced by "`role-model` selected label ends with a tier word" |
| `usage.mjs` 83-86 | Connections, `model-prices` visible | Connections, open `settings-advanced[data-pane=app-connections]`, then `model-prices` |
| `assistants.mjs` 152, 166-171 | `chat-summary` includes "Change in App settings > Defaults"; tab "Defaults"; `skill-assist-model-row-select`, `quick-run-model-row-select` | `chat-summary` includes " via "; `chat-model-change` visible; tab "General" + open app-general Advanced; same row testids |
| `permissions.mjs` 104-105, 178-182, 210-247 | tab "Agents"; link opens "Agents" pane | tab "Permissions"; link asserts the "Permissions" tab selected; before the allowed-folder steps click `permissions-summary-toggle` (assert `aria-expanded` true) |
| `runs.mjs` 690, 702 | tab "Agents", switch "Let runs message each other" | tab "Permissions", open `settings-advanced[data-pane=project-permissions]`, same switch; after reload the disclosure is still open |
| `runs.mjs` 678, `maintenance.mjs` 74 | tab "Maintenance" | unchanged |
| `layout.mjs` 354-390 | `appearance-section`, Theme radiogroup | unchanged (Theme stays visible) |
| `skills.mjs`, `team.mjs` | Team tab skill evaluation, Skill library tab | unchanged (no settings-pane selectors) |

New checks (added to `connections.mjs` for app panes and `permissions.mjs` for project panes, 1024x640 and
1600x1000, dark and light): the acceptance checks in section 8.

## 8. Acceptance checks

1. App settings has no "Defaults" tab and no text "App settings > Defaults" anywhere in the renderer (grep).
2. Project Permissions pane at 1024x640, Advanced closed and the summary hidden: the settings scroller's
   `scrollHeight <= clientHeight` (no scroll at rest).
3. No visible select at rest (Advanced closed, role panel Advanced closed) has an option whose label is a concrete model
   id without a tier word; App General at rest has no model select.
4. On an API-key or LiteLLM project, Limits (Advanced open or closed) contains no "five-hour" or "weekly" text; on a
   subscription project it shows `plan-guard-line` and no percent input at rest.
5. Tab stops at rest (from the pane h2 to the end of the pane, mock toggle not counted): project General <= 4 with one
   connected connection, Permissions <= 3, Limits <= 2.
6. `settings-advanced` summary has accessible name "Advanced settings", toggles with Enter and Space, shows the focus
   ring, and its open state survives a reload per pane.
7. Every deep link in section 6 lands on the right pane with focus on the pane or group heading.
8. No "Claude" in permission copy on an OpenAI project.

## 9. Not in this pass

- canSpawn / spawnable derived from the chart (R9, R10).
- Settings search (settings-2 N8).
- Gating permission modes on adapter support (`supportsAutoMode`).
- An automatic five-hour window share (the share stays a manual override).
- Team assistant cost estimate ("about $0.02 per review") and derived budgets in the UI.
- Accent swatches as one roving radiogroup; App General tab stops are not budgeted.
- Role panel slug, colour and system prompt moves (R2, R5, R14); auth fields moving into the Connect flow (A9-A14).
