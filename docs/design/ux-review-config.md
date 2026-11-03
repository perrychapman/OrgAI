# UX review: configuration audit (every option, KEEP / DEFAULT / AUTOMATE / REMOVE)

Method: `npm run build` at bbbbffe, built app driven with playwright-core through `e2e/lib.mjs` (`ORGAI_MOCK=1`, a fresh temp
`ORGAI_DATA_DIR` per script, no tokens spent). First launch, a mock project "Notes API" on a fixture git repo (Existing
repository, default chart), one short mock work run ("Add a health check endpoint...") ended with End session, then
every pane of App settings and Project settings at 1600x1000 and 1024x640 in dark and light, the Connections cards
fully expanded (Models list, Model tiers), the Model prices form, the Team tab role panel, the New project form on a
repo with a Claude Code agent, the Chat and MCP assistant start pages, and a keyboard pass over App Defaults, project
Agents and the "Change in App settings" deep link. Word counts are `innerText` of the pane; heights are the settings
scroller's `scrollHeight` against its `clientHeight`. Screenshots: `docs/design/ux-review-config-shots/NN-*.png`.
Scratch scripts and the full screenshot set (about 95 shots) are in the gitignored `e2e/shots/config/`.

Earlier walks read first: `ux-review-settings.md` (12 findings) and `ux-review-settings-2.md` (N1-N10, follow-up 1-8).
Field list from `src/shared/types.ts` (`AppSettings` line 1504, `Project` line 429, `Role` line 361) and defaults from
`src/shared/defaults.ts` (`DEFAULT_APP_SETTINGS`, `newProject`, `DEFAULT_TEAM_REVIEW`, `DEFAULT_SKILL_EVALUATION`).

## Verdict

Connect-and-go works today for exactly one user: someone with a Claude Code login. That user lands on the New
project form, creates a project in 3-4 clicks and runs without opening a settings page. Everyone else hits configuration
that the harness could decide for itself. The settings pages also grew after the second walk. App Defaults went from
188 to 344 words and 15 rows, and project Agents went from 117 to 222 words and 19 tab stops. Of 71 options on the two
settings pages, about 25 are values the harness already knows or can detect: the tier mapping from the catalog, the
default connection from what is connected, worktree isolation from git, plan guards from the provider's usage report,
and token budgets from the tier. About 30 more are expert tuning that should sit behind one Advanced disclosure. My
proposal shows 11 to 14 options at rest (below).

The biggest blocker (H1) is that connecting OpenAI or LiteLLM does not make OrgAI use it. New projects, Chat, the MCP
assistant and the Skill assistant stay on Anthropic until the user also finds Defaults > Default connection.

## Status of earlier findings

| Earlier finding | Status | Evidence (this walk) |
| --- | --- | --- |
| settings-2 N2 / follow-up 1: deep links drop focus | Fixed | Enter on Limits "Change in App settings" opens Defaults, focus is the h2 "Defaults", the Weekly usage threshold row is scrolled into view and highlighted (shot 19). |
| settings-2 N1 / follow-up 2: rule examples shift layout | Fixed | Examples is a closed disclosure under the rule field (shot 10); nothing appears on focus. |
| settings-2 follow-up 3: cut App Defaults into scannable cards | Partly | Grouped as Connection / Models / Assistants / Safety / Behaviour cards (shots 07, 08), no "Learn more" tab stops left. But the pane grew: 15 rows, 344 words (was 188), 1,311 px against 952 (1.4 screens) at 1600x1000 and 593 (2.2 screens) at 1024x640. |
| settings-2 N3 / follow-up 4: Permission mode row at 1024 | Fixed | Select right-aligned like every other row (shot 12). |
| settings-2 N4 / follow-up 5: pane title = tab label | Fixed | Each pane opens with an h2 equal to the tab, sections are h3 (shots 10, 13). Exception: the "Team assistant: review" group (L3). |
| settings-2 N6 / follow-up 6: not-connected provider cards open by default | Fixed | OpenAI and LiteLLM are collapsed one-liners with a Connect button (shot 04). |
| settings-2 N5 / follow-up 7: accent "Custom..." link | Fixed | A seventh "+" swatch (shot 03). The hex field itself was not opened. |
| settings-1 #7 / follow-up 8: "Default: X" on project rows that shadow an app default | Open | No project row shows its app default or a reset (shots 11, 13). Only "Use the everyday tier near the limit" shows "Threshold: 80% - Change in App settings". |
| settings-1 #8: "Roles on this connection" mystery line | Fixed | Reads "4 roles use this connection - Everyday tier: sonnet" with a Role models list (shot 14). |
| settings-2 N8: no settings search | Open | No search field on either page. |
| settings-2 N9: Agents pane scrolls | Open, worse | 222 words, 1,556 px against 952 at 1600x1000 (1.6 screens), 2.6 screens at 1024x640 (shots 10-12). Allowed folders and Team assistant review were added. |
| settings-1 #12: About "Mock adapter" chip unexplained | Open (low) | Still "0.1.6-dev1 Dev build Mock adapter" with no explanation. |

## Inventory (71 options on the two settings pages, plus role and form options)

Verdicts: KEEP = visible, the user genuinely chooses. DEFAULT = keep, behind Advanced, with a good default.
AUTOMATE = the harness decides (an "Automatic" state with an override in Advanced, or gone). REMOVE = delete the control.

### App settings

| # | Option | Where today | Default | Verdict | Reason | Signal for AUTOMATE |
| --- | --- | --- | --- | --- | --- | --- |
| A1 | Theme | General > Theme | dark | KEEP | Personal, one glance. | |
| A2 | Accent colour | General > Theme | #7c5cff | KEEP | Cheap, personal, one row. | |
| A3 | Motion | General > Theme | follow system | DEFAULT | Already follows the OS; the override is for few users. | OS prefers-reduced-motion (already read) |
| A4 | Canvas pattern | General > Canvas | dots | DEFAULT | Cosmetic. | |
| A5 | Connection lines | General > Canvas | curved | DEFAULT | Cosmetic. | |
| A6 | Tint with the accent | General > Canvas | on | DEFAULT | Cosmetic. | |
| A7 | Minimap | General > Canvas | off | DEFAULT | Better as a canvas toolbar toggle where it is used. | |
| A8 | Notifications | General > Notifications | on | KEEP | Real choice, one row. | |
| A9 | Anthropic auth method (Claude Code login / API key env var) | Connections > Anthropic card | login | AUTOMATE | OrgAI already probes `claude auth status` and can see whether the key variable is set. | `anthropicAuth.ts` status plus whether `ANTHROPIC_API_KEY` is present |
| A10 | Anthropic API key variable name | Anthropic card (API key mode) | ANTHROPIC_API_KEY | DEFAULT | Almost nobody renames it. | |
| A11 | Anthropic on/off (Sign out of OrgAI) | Anthropic card | on | KEEP | An action, not a setting. | |
| A12 | OpenAI auth method (ChatGPT / API key env var) | OpenAI card | ChatGPT | KEEP | A real choice, but only inside the Connect flow. | |
| A13 | OpenAI sign-in method (Browser / Device code) | OpenAI card | Browser | DEFAULT | A fallback ("Can't open a browser?") link is enough. | |
| A14 | OpenAI API key variable name | OpenAI card (API key mode) | OPENAI_API_KEY | DEFAULT | As A10. | |
| A15 | OpenAI connect / disconnect | OpenAI card | off | KEEP | The connection itself. | |
| A16 | LiteLLM base URL | LiteLLM card | '' | KEEP | Only the user knows it. | |
| A17 | LiteLLM API key | LiteLLM card | none | KEEP | Only the user knows it. | |
| A18 | LiteLLM connect / disconnect | LiteLLM card | off | KEEP | The connection itself. | |
| A19 | Model tiers: Top / Deep / Everyday / Fast per connection (12 selects) | Card > "Model tiers (advanced)" | from the catalog, "Automatic" badge | AUTOMATE | Already auto-filled and moved forward (`autoTiers`); it only needs to stay out of sight. | connection's catalog (`tierFromDescription`, `defaultTierModels`) |
| A20 | Community price list | Connections > Price sources | on | DEFAULT | Nobody can judge this before seeing a wrong cost. | |
| A21 | Model price overrides | Connections > Model prices | none | DEFAULT | Needed only for an unpriced model; the Usage tab's "Set a price" deep link already leads here. | |
| A22 | Default connection | Defaults > Connection | anthropic | AUTOMATE | With one connection there is nothing to choose; with two, ask once when the second one connects. | which connections are connected (`ConnectionStatus`), the last one the user connected |
| A23 | Orchestrator model (new projects) | Defaults > Models | deep tier | AUTOMATE | The tier is the right default; the Architect or import sets real roles. | tier mapping + setup Architect proposes per role |
| A24 | Report model (new projects) | Defaults > Models | everyday tier | AUTOMATE | As A23. | as A23 |
| A25 | Setup (Architect) model | Defaults > Assistants | deep tier | DEFAULT | Expert tuning; already resolves per connection. | |
| A26 | MCP assistant model | Defaults > Assistants | deep tier | DEFAULT | As A25. | |
| A27 | Skill assistant model | Defaults > Assistants | deep tier | DEFAULT | As A25. | |
| A28 | Chat model | Defaults > Assistants | everyday tier | DEFAULT | Better as a model chip on the Chat start page, where the line "Runs on Everyday tier via Claude" already sits (shot 18). | |
| A29 | Permission mode for new projects | Defaults > Safety | auto (Unattended) | KEEP | The one safety choice with real consequences. | |
| A30 | Cost cap for new projects | Defaults > Safety | none | AUTOMATE | Matters only on metered connections. | auth kind: subscription (hide) vs API key / LiteLLM (suggest a cap, show the row) |
| A31 | Runs to keep for new projects | Defaults > Safety | 100 | REMOVE | A project value; no one sets a default for it. Keep the project row (P16). | |
| A32 | Keep going until the plan is complete (default) | Defaults > Behaviour | on | REMOVE | Always wanted; see P7. | |
| A33 | Max automatic continues (default) | Defaults > Behaviour | 40 | REMOVE | Project Advanced only (P8). | |
| A34 | Isolate writers in worktrees (default) | Defaults > Behaviour | on | REMOVE | Decided per project by git (P9). | |
| A35 | Use the everyday tier near the limit (default) | Defaults > Behaviour | off | AUTOMATE | Should be on wherever the provider reports a weekly window. | plan usage from the provider (`UsageStatus` windows) |
| A36 | Weekly usage threshold (%) | Defaults > Behaviour (an app-wide value, not a default) | 80 | REMOVE | A user cannot evaluate 80 vs 85; fix it at 80 and expose it only as a project Advanced override if anyone asks. | |

Connectors and Skill library are content libraries, not configuration; they are out of this count and stay as panes.
About is information only.

### Project settings

| # | Option | Where today | Default | Verdict | Reason | Signal for AUTOMATE |
| --- | --- | --- | --- | --- | --- | --- |
| P1 | Name | General | folder name | KEEP | | |
| P2 | Working directory | General | chosen at creation | KEEP | | |
| P3 | Project brief | General | '' | KEEP | The Architect writes it; the user edits it. | |
| P4 | Permission mode | Agents > Permissions | app default (auto) | KEEP | Real safety choice. | |
| P5 | Allowed folders | Agents > Allowed folders | none | DEFAULT | Filled by "Always allow for project" on permission cards; show as a count row. | |
| P6 | Saved permission rules | Agents > Saved permission rules | none | DEFAULT | Filled by the cards; show as a count row with Add rule behind it. | |
| P7 | Keep going until the plan is complete | Agents > Behaviour | on | REMOVE | Interrupt and End session already stop a run; off means a work run stalls at the first turn end. | |
| P8 | Max automatic continues per run | Agents > Behaviour | 40 | DEFAULT | Safety bound, expert only. | |
| P9 | Isolate writers in worktrees | Agents > Behaviour | on | AUTOMATE | It is already silently off without git (`Project.isolateWriters` doc), but the row does not say so. | git repository detected (`ProjectProfile.hasGit` / `checkPath` "Git repository found") |
| P10 | Review each report's changes before merge | Agents > Behaviour | off | DEFAULT | A real workflow choice, but not for a first run. | |
| P11 | Let runs message each other | Agents > Behaviour | on | DEFAULT | Rarely changed. | |
| P12 | Team assistant review (Off / Free checks / AI review) | Agents > Team assistant: review | AI review | DEFAULT | One select is enough; merge P23 into it. | |
| P13 | Review every N finished runs | Agents > Team assistant: review | 3 | REMOVE | Internal throttle. | |
| P14 | Team assistant review token budget | Agents > Team assistant: review | 20000 | REMOVE | Raw token counts cannot be evaluated; derive from the tier price or the plan. | everyday-tier price per token, plan vs metered |
| P15 | Estimated-cost cap per run | Limits | none | KEEP (metered only) | Meaningful on API key and LiteLLM, meaningless on a subscription. | auth kind (as A30) |
| P16 | Runs to keep | Limits | 100 | DEFAULT | Housekeeping. | |
| P17 | Max subagent depth | Limits | 3 | AUTOMATE | The org chart's depth already says how deep spawning can go. | org chart depth; setup Architect proposes it (`propose_settings` already carries it) |
| P18 | Max concurrent subagents | Limits | 8 | DEFAULT | Expert; later automatic from rate-limit events. | `rate_limit_event` / provider limits |
| P19 | Stop at a share of the five-hour window (%) | Limits | off | AUTOMATE | A first-time user cannot judge "share of the five-hour window". | plan usage from the provider (five-hour window present) |
| P20 | Use the everyday tier near the limit | Limits | off | AUTOMATE | As A35. | weekly window present |
| P21 | Connection | Connection | app default | KEEP (only with 2+ connected) | With one connected provider the three cards are noise; in mock they are disabled. | count of connected connections |
| P22 | Plugins | Plugins and skill settings | none | KEEP, move to Team | It is team equipment like MCP servers and skills, which already live on the Team tab. | |
| P23 | Suggest new skills (skill evaluation model step) | Plugins and skill settings | off | REMOVE (merge into P12) | A second "AI looks at recent runs" switch for the same kind of feature. | |
| P24 | Skill evaluation token budget | Plugins and skill settings | 20000 | REMOVE | As P14. | as P14 |

Run on the mock adapter (Connection pane) and Use the mock adapter (New project form) appear only under `ORGAI_MOCK`
and are not counted.

### Role panel (Team tab), for judgement only

| # | Option | Verdict | Reason |
| --- | --- | --- | --- |
| R1 | Name | KEEP | |
| R2 | Slug (subagent type) | AUTOMATE | Derive it from the name; show it in Advanced. |
| R3 | When should a manager delegate to this role? | KEEP | The Architect or import writes it, and the user edits it. |
| R4 | Reports to | KEEP | Also set by dragging on the canvas. |
| R5 | Color | DEFAULT | Auto palette. |
| R6 | Model and tier | KEEP as a tier | Show Top / Deep / Everyday / Fast; a concrete model id goes in Advanced. |
| R7 | Effort | DEFAULT | Offers low, medium, high, xhigh and max on every connection; Codex uses only low, medium and high (`codex.ts` 601, 1064). See M5. |
| R8 | Tools | KEEP | Real safety choice, and it already has a good summary and an Edit button. |
| R9 | May create subagents | AUTOMATE | True exactly when the role has reports in the chart. |
| R10 | Spawnable roles | AUTOMATE | The role's reports in the chart. |
| R11 | MCP grants (Connections) | KEEP | |
| R12 | Skills | KEEP | |
| R13 | Responsibilities | KEEP | The Architect writes them. |
| R14 | System prompt | KEEP (Advanced) | The Architect or import writes it. |

### New project form and Chat start page

| # | Option | Verdict | Reason |
| --- | --- | --- | --- |
| F1 | New idea / Existing repository | AUTOMATE | An empty or missing folder means a new idea, and a folder with files means an existing repo. Keep the switch as an override. |
| F2 | Folder | KEEP | |
| F3 | Name | DEFAULT | Already defaults to the folder name. |
| F4 | Idea text / brief | KEEP | |
| F5 | How should the org chart start (Import / Architect / Default) | KEEP | Good: it appears only when agents are found (shot 02). |
| F6 | (missing) Connection | add a read-only line | "Runs on Anthropic (Claude Code login). Change" so H1 is visible where it bites. |
| C1 | Work in a folder | KEEP | |
| C2 | Team | DEFAULT | Already a closed disclosure (shot 18). |
| C3 | Allow edits in this folder | KEEP | |

## New findings

### High

**H1. Connecting a provider does not make OrgAI use it ("connect and go" stops at Anthropic).**
Flow: a user without Claude Code connects OpenAI or LiteLLM in App settings > Connections, then creates a project or
opens Chat. Code read, not driven (no real sign-in under the mock): `defaultConnection` stays 'anthropic' until the user
changes Defaults > Default connection (shot 07). `creationConnection` (`src/shared/defaults.ts:421`) returns
'anthropic' whenever the default is anything else that is not usable. `quickRuns.ts:95`, `mcp/assist.ts:36` and
`skills/assist.ts:26` all take `settings.defaultConnection`. The New project form never names the connection (shots
01, 02), so the project silently lands on Anthropic and its first run fails on auth. The Default connection select also
offers "OpenAI (Not connected)" and "LiteLLM (Not connected)" as choices, and picking one silently falls back to
Anthropic.
Likely owners: `src/main/connections/service.ts` (on a successful connect), `src/shared/defaults.ts`
`creationConnection`, `src/renderer/src/views/ProjectsView.tsx` (form line), `AppSettingsView.tsx` (Default
connection row).
Expected: with one connected connection, that connection is the default, automatically. When a second one connects,
OrgAI asks once in the card ("Use OpenAI for new projects and assistants?"). The New project form and the Chat start
page show "Runs on <connection>" with a Change link. A not-connected connection cannot be chosen as the default.
Check: with Anthropic disconnected and OpenAI connected, a new project's `provider.connection` is 'openai' and a Chat
run's `RunSummary.connection` is 'openai', with zero visits to Defaults.

**H2. App Defaults mixes three kinds of settings and has outgrown its pane (15 rows, 344 words, 2.2 screens at 1024x640).**
Flow: App settings > Defaults (shots 07, 08, 09). The subtitle says "Starting values for new projects, plus the
assistants that work across all projects". It holds (a) values copied once into new projects (A23, A24, A29-A35), (b)
live app-wide values that change running behaviour now (A25-A28 assistant models, A36 Weekly usage threshold, which
`index.ts:342` reads on every run of every project), and (c) the default connection. Nothing on a row says which kind
it is. Five rows are duplicated in project settings (permission mode, cost cap, runs to keep, keep going, max
continues, isolate writers, everyday near limit), and no project row shows "Default: X" (open since settings-1 #7).
A user who changes "Runs to keep" here and sees no change in the project they are looking at has no way to learn why.
Owner: `src/renderer/src/views/AppSettingsView.tsx`, `components/settings/LimitsSection.tsx`, `AgentsSection.tsx`.
Expected: remove the copy-once duplicates (A31-A34). Keep one "New projects" row (A29). Move the assistant models to an
Advanced group named for what they are ("Assistant models, used now by every project"). Put the weekly threshold behind
the automatic plan guard (H3).
Check: Defaults is gone or under 5 visible rows and under 80 words; no setting appears on both pages without a
"Default: X / Reset" affordance.

**H3. Plan-window options are shown to every user, and no first-time user can evaluate them.**
Flow: Project settings > Limits (shots 13, 21) and App Defaults (shot 08): "Stop at a share of the five-hour window (%)"
(placeholder Off), "Use the everyday tier near the limit" (off), "Weekly usage threshold 80". They appear the same on
the mock, on an API-key project and on LiteLLM, where no plan windows exist, and "Estimated-cost cap per run" appears on
a subscription, where it is not what limits the user. The provider already reports the windows (`UsageStatus`, the
account popover's UsageMeter), so OrgAI knows when these apply.
Owner: `LimitsSection.tsx`, `AppSettingsView.tsx`, `src/shared/defaults.ts` (`newProject` defaults).
Expected: on a connection whose usage probe reports a five-hour or weekly window, the guard is automatic and on. Limits
shows one line, "Plan guard: automatic. Stops a run near your five-hour limit and uses the everyday tier when the
weekly window passes 80%", with Change in Advanced. On API-key and LiteLLM connections the plan rows are hidden and the
cost cap row is shown with a suggested value.
Check: on an API-key project the Limits pane shows no "five-hour" or "weekly" text; on a subscription project it shows
the automatic line and no percent inputs at rest.

### Medium

**M1. Model choice lives in four places with two vocabularies.**
Shots 05, 07, 14, 17. App Defaults has 6 model selects whose options mix tiers and concrete ids ("Top tier | Deep tier |
Everyday tier | Fast tier | Fable | Opus | Sonnet | Haiku"). Connections has 4 tier selects per connection, which are
already "Automatic". Project Connection lists role models read-only. The role panel shows a section "Model sonnet", a
field "Model" with a "Tier: Everyday" badge, and a select reading "sonnet - Everyday". A first-time user meets the word
"tier" before learning what it means, and only the Connections card explains it (in a collapsed "advanced" disclosure).
Owner: `AppSettingsView.tsx`, `components/RoleInspector.tsx`, `components/RoleModelPicker.tsx`.
Expected: outside Advanced, models are chosen by tier only, and each select shows the tier name plus the model it
resolves to ("Everyday (sonnet)"). Concrete ids sit in an "Exact model" sub-select under Advanced. The role panel uses
one "Model" label.
Check: no visible select at rest lists concrete model ids; the role panel shows the word "Model" once.

**M2. Two separate "AI reviews your recent runs" features, each with a raw token budget, on two panes.**
Agents > "Team assistant: review" has 3 controls (Off / Free checks / AI review, "Review every N finished runs" 3,
"token budget" 20000; shot 11). Plugins and skill settings > Evaluation has "Suggest new skills" plus another "Token
budget" 20000 (shot 15). The budget field stays editable while Suggest new skills is off. The two features differ only
in what they suggest (tools versus skills), and both results land on the Team tab.
Owner: `AgentsSection.tsx`, `components/skills/SkillEvaluationSettings` (in the tools pane).
Expected: one "Team assistant" setting (Off / Free checks / AI suggestions) that covers both, with the budget derived
automatically and shown as an estimate ("about $0.02 per review").
Check: one select, no raw token fields at rest.

**M3. The "Plugins and skill settings" pane is a leftover.**
Shot 15. The pane opens with a banner pointing elsewhere ("Roles, connections and skills are on the Team tab"). It
holds Plugins (Claude-only team equipment) and the M2 evaluation switch, and its name is the only two-topic tab name.
Owner: `src/renderer/src/views/SettingsView.tsx`.
Expected: Plugins move to Team > Catalog beside MCP servers and skills, the evaluation switch merges into M2, and the
pane is deleted (project settings then has 4 panes).
Check: no project settings pane exists whose first element is a banner sending the user to another tab.

**M4. Behaviour switches state choices the harness already makes, without saying so.**
Shot 11. "Isolate writers in worktrees" is on for a folder that may not be a git repo, and the harness then turns it off
silently (`Project.isolateWriters` doc). "Keep going until the plan is complete" off makes a work run stop at its first
turn end, and no first-time user wants that. "Let runs message each other" is on and rarely matters.
Owner: `AgentsSection.tsx`.
Expected: worktrees shows an automatic state ("Automatic: git repository found, writers get their own copy" or "Off:
not a git repository"), with an override in Advanced. The keep-going switch is removed, and Max continues moves to
Advanced. Run messaging moves to Advanced.
Check: the Agents pane at rest has Permission mode plus one permissions summary row, and it fits 1024x640 without
scrolling.

**M5. Role Effort offers values the connection ignores, and the role options are not connection-aware.**
Shot 17 and the text dump: Effort lists Default, low, medium, high, xhigh and max on every connection. `codex.ts` passes
effort only when it is low, medium or high (lines 601, 1064), so xhigh and max are silently dropped on OpenAI.
"May create subagents" is a checkbox on a role that has no reports in the chart.
Owner: `RoleInspector.tsx`.
Expected: Effort options come from the project's adapter, and an unsupported saved value shows "not used on <connection>".
canSpawn and spawnable follow the chart (R9, R10).
Check: on an OpenAI project, Effort offers no xhigh or max.

**M6. Permission mode copy names Claude on every connection.**
Shots 07 and 10: "Claude decides each call, asks only when unsure" (Defaults) and "Claude approves safe calls itself"
(Agents), regardless of the default or project connection. Codex maps 'auto' to its own reviewer (`codexProtocol.ts`
329).
Owner: `src/shared/types.ts` `PERMISSION_MODE_OPTIONS`, `AppSettingsView.tsx`, `AgentsSection.tsx`.
Expected: provider-neutral wording ("The model's safety check approves routine calls and asks when unsure") or wording
per connection.
Check: no "Claude" in permission copy on an OpenAI project.

### Low

- **L1.** Model selects render in a monospace face ("Deep tier") while the other selects are sans, and their widths vary
  (Report model is about 40 px wider). Shots 07, 09. Owner `AppSettingsView.tsx` / `ModelSelect`.
- **L2.** The skill evaluation Token budget input is about 20 px narrower than every other number input and is enabled
  while its switch is off. Shot 15.
- **L3.** "Team assistant: review" is a small-caps group label under Behaviour while its siblings are h3 sections, and its
  row title repeats the group name ("Team assistant review"). Shot 11. Owner `AgentsSection.tsx`.
- **L4.** New project form: after a folder with agents is typed under Existing repository, switching to New idea keeps
  "Found 1 Claude Code agent and AGENTS.md." and the import radio group next to "This folder already has files"
  (text dump, `e2e/shots/config/out2/02-*`). Owner `ProjectsView.tsx`.
- **L5.** About still shows a "Mock adapter" chip with no explanation (carried from settings-1 #12).
- **L6.** Unconfirmed: after the Model prices form opened, the whole window was shifted up by about 57 px, with the
  topbar hidden and an empty band at the bottom (shot 20). I saw this only after a scripted `scrollIntoViewIfNeeded`, not
  after a mouse action. Check whether the app root can scroll (`overflow` on `.app` / `body`).

## Click counts

| Scenario | Clicks today | Settings touched | After the proposal |
| --- | --- | --- | --- |
| Claude Code user, first launch to first run (driven) | 4: Existing repository, Browse (+ native dialog) or type the path, Create project, Start in the composer | 0 | 4 |
| OpenAI-only user, first launch to first run (code read) | 11+: gear, Connections, OpenAI Connect, Sign in with ChatGPT (+ browser), Defaults, Default connection select, OpenAI, Projects, Existing repository, Create project, Start. If the Defaults step is missed, the project runs on Anthropic and fails. | 2 panes | 7: gear, Connections, Connect, Sign in (+ browser), Projects, Create project, Start |
| Change how long runs are kept for this project (driven) | 2: Settings tab, Limits (row is visible) | 1 pane | 3: Settings, Limits, Advanced |
| Find why a run switched to the everyday tier (driven) | 4: Settings, Limits, Learn more, Change in App settings (lands on the highlighted threshold row) | 2 pages | 2: Settings, Limits (automatic line explains it) |
| Keyboard: Tab stops from the Defaults tab to the end of the pane | 15 | | 2 at rest |
| Keyboard: Tab stops through project Agents | 19 | | 3 at rest |

## Proposed target structure (one page)

**App settings: 5 panes (Defaults goes away).**
- General. Visible: Theme, Accent colour, Notifications. Advanced: Motion, and the Canvas group (pattern, lines, tint,
  minimap).
- Connections. Visible: one card per provider with its status and one action (Connect / Sign out). The auth method,
  URL and key appear only inside the Connect flow. When a second provider connects, a one-time "Use for new projects
  and assistants" choice replaces Default connection. Advanced per card: Models list, Model tiers (Automatic), key
  variable name, Device code. Advanced for the pane: Costs, with Community price list and Model price overrides (the
  Usage tab's "Set a price" link still deep-links there).
- Connectors, Skill library: unchanged content panes.
- About. In the same pane or under General: "New projects" with Permission mode (visible) and, under Advanced, Assistant
  models (Architect, MCP assistant, Skill assistant, Chat) plus the starting tiers for orchestrator and reports.

**Project settings: 4 panes.**
- General. Visible: Name, Folder, Brief, and Connection (only when 2+ connections are connected; otherwise one line
  "Runs on Anthropic").
- Permissions. Visible: Permission mode, and one summary row "3 rules and 1 folder you allowed" that opens the list.
- Limits. Visible: Cost cap (metered connections only) and the automatic plan guard line (subscriptions only).
- Maintenance: unchanged.
- One Advanced disclosure at the bottom of Permissions and Limits holds: worktrees (Automatic: git found), review
  merges, run messaging, max automatic continues, runs to keep, max subagent depth (Automatic: from the chart), max
  concurrent subagents, plan guard overrides (five-hour share, weekly threshold), and the Team assistant (Off / Free / AI).
- Plugins move to Team > Catalog. Skill evaluation merges into the Team assistant setting.

**Role panel.** Visible: Name, Tier, Tools, Connections, Skills, "When to delegate". Advanced: slug, exact model,
effort, responsibilities, system prompt, color. canSpawn and spawnable come from the chart.

## Count

| | Options today | Visible at rest today (approx.) | Visible at rest after | In Advanced after | Automated or removed |
| --- | --- | --- | --- | --- | --- |
| App settings | 47 (8 General, 24 Connections incl. 12 tier selects, 15 Defaults) | about 32 (tier selects and auth fields sit in collapsed cards) | 7, plus Default connection only with 2+ connected | 14 | 26 (18 automated incl. the 12 tier selects, 5 removed, 3 auth fields moved into the Connect flow) |
| Project settings | 24 | 24 | 4 to 6 (cost cap and connection are conditional) | 8 | 9 (4 automated, 5 removed or merged), plus Plugins moved to Team |
| Total on the settings pages | 71 | about 56 | 11 to 14 | 22 | about 35 |

Verdict tally (rows above): App KEEP 10, DEFAULT 14, AUTOMATE 18 (incl. 12 tier selects), REMOVE 5. Project KEEP 7,
DEFAULT 8, AUTOMATE 4, REMOVE 5.

## Suggested order of work

1. H1: make the connected provider the default automatically, refuse a not-connected default, and add the "Runs on X"
   line to the New project form and the Chat start page. Main plus small renderer changes; this is the only true
   connect-and-go blocker.
2. H3: automatic plan guard driven by the provider's usage report; hide the plan rows on metered connections and the
   cost cap on subscriptions.
3. H2: shrink App Defaults. Delete the copy-once duplicates (A31-A34), move assistant models to Advanced, add "Default:
   X / Reset" where an app value still shadows a project value.
4. M2 and M3: one Team assistant setting with no raw budgets; move Plugins to Team and delete the "Plugins and skill
   settings" pane.
5. M4: Agents pane to Permission mode plus a summary row, with the Advanced disclosure (fits 1024x640).
6. M1 and M5: tier-only model selects at rest, one "Model" label, connection-aware Effort; canSpawn and spawnable from
   the chart.
7. M6 copy, then L1-L6.

## Not driven

- Real sign-ins: OpenAI (ChatGPT browser or device code), LiteLLM URL plus key, the Anthropic API-key mode and its
  variable field. H1 comes from a code read.
- Switching a project's connection: the cards are disabled while a project runs on the mock adapter, and I did not turn
  the mock off.
- Real plan windows (the mock reports none), so the automatic guard proposal in H3 is not checked against live
  `UsageStatus` shapes.
- The orchestrator's spawnable list in the role panel, the Connectors gallery in depth (it is a content pane; 667 words
  and 2 screens at 1600x1000, 4.4 at 1024x640), the native folder pickers, and the accent hex field.
- Settings tablist arrow keys were not re-tested; settings-2 found them working, and only the Tab order and the deep
  link were re-checked here.
