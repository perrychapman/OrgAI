# Team tab: design spec

Status: spec only. Input: `ux-review-team-tab.md` (findings F1 to F12; "finding N" below means F-N). Pick of the name: the user chose **Team**.
Contract names marked "per the contract" come from the Runtime Lead's `capabilities:*` work and may change; the renderer imports them from `src/shared/types.ts` and reaches them only through `preload/index.d.ts`.

## 1. Naming and copy

### Names

| Thing | Name | Notes |
| --- | --- | --- |
| Project tab | **Team** (`tab-team`, view id `team`) | Subtitle in the empty state and `aria-description`: "Roles, tools and skills". |
| Canvas inside Team | **Org chart** | Used as the canvas region label (`aria-label="Org chart"`), in the footer hint and in docs. Not a tab. |
| AI helper | **Team assistant** | The only user-facing name, everywhere: tray heading, buttons, Settings pointer, run labels, App settings > Connectors "Configure with AI" becomes "Ask the Team assistant" (finding 10, F12). |
| Architect | "Architect" stays, described as "Designs roles and reporting lines" | It is a mode of the Team assistant surface (section 3), not a second assistant. |

### One vocabulary (finding 7)

Three nouns, used in every Team-path string, dialog title, empty state, aria-label and announcement:

| Noun | Means | Never say |
| --- | --- | --- |
| **Tools** | Built-in permissions of a role (Read, Glob, Grep, Edit, Write, Bash, ...) | "permissions" in the same block, "built-ins" |
| **Connections** | A service agents reach (GitHub, Slack, a custom server) | "MCP", "MCP server", "service", "connector" (except "Connectors" as the App settings pane that holds sign-in, and "connector" inside that pane) |
| **Skills** | Reusable how-to instructions a role can load | "plugins" (plugins stay a separate advanced noun) |

"MCP" appears only in an "Advanced" detail line (command, transport, registry id). The access sentence reuses "Can read" / "Can read and change" (existing connect dialog wording). "Used by" is the one phrase for the reverse view (replaces "Roles:" and "Can use:", F12). A role's block is titled "What it can use".

Data and code names (`McpServerSpec`, `mcp-*` test ids, `mcpServers`) are unchanged. Only visible text changes.

## 2. Layout

Everything uses `CanvasFrame` (`FrameToolbar`, `FrameStage`, `FrameTray`, `FrameFooter`), `SidePanel`, `DecisionCard`, `Tabs`/segmented control, `Banner`, `IconButton`, tokens and lucide icons. Nothing floats over the canvas: no popover drawer, no overlay panel; dialogs remain only for credential flows and confirmations.

```
Topbar   Demo | Live  History  Team  Settings
+--------------------------------------------+------------------------+
| FrameToolbar                               | SidePanel              |
|  [Add role]* Auto-layout  Import v  Export | [ Role | Catalog ]      |
+--------------------------------------------+ Role:                  |
| FrameStage: Org chart (React Flow)         |  Identity, Model       |
|  node: name, model, "3 tools - 1 conn."    |  What it can use       |
|        "- 2 skills"                        |   Tools        [Edit]  |
|                                            |   Connections [+ Add]  |
|                                            |   Skills      [+ Add]  |
|                                            |  Delegation            |
|                                            |  Instructions (folded) |
+--------------------------------------------+ Catalog: Skills,       |
| FrameTray: Team assistant                  |  Connections, Plugins  |
|  [scope chip] [Recommend tools and skills]*|  each with Used by,    |
|  recommendation cards, Gaps                |  on/off                |
+--------------------------------------------+------------------------+
| FrameFooter: one-line hint (hidden < 700 px)                        |
```

`*` marks the single primary action of a region.

### Toolbar (`FrameToolbar`)
- Primary: **Add role**. Secondary: Auto-layout, Import (menu: Import agents, Import skills), Export to repo. No assistant button here; the assistant has its own region.
- The "not imported" Banner, import notice with Undo and export notice stay in `.frame-top` above the canvas as today.

### Canvas nodes
- `RoleNode` keeps name, model, "leads N". The old "6 tools" line becomes one compact capability line: `3 tools - 1 connection - 2 skills` (icon plus number at node widths under 200 px, words above, via container query on the node). Zero counts are omitted; a role with nothing beyond default tools shows only "3 tools".
- Unapproved assistant proposals never appear on nodes. A dashed ring is not used; the tray holds them.
- Node tooltip not used (nothing floats). The line is `aria-label`led in full ("Reviewer. 3 tools, 1 connection, 2 skills").

### Side panel: segmented Role | Catalog
- `SidePanel` keeps its persisted width and `data-side-wide` behaviour. A `SegmentedControl` (two options, `role=tablist`, arrow keys) sits at the panel top, labelled "Team panel". Role is selected whenever a role is selected on the canvas; Catalog is selected when nothing is selected, and the user's explicit choice sticks until the selection changes from nothing to something (selecting a role then switches to Role; selecting the pane background keeps the user's last explicit tab). The Architect no longer owns this slot (section 3).
- **Role tab** order: Identity (name, description), Model (folded behind a one-line summary when the panel is under 480 px), **What it can use**, Delegation, Instructions (folded, summary of first line).
- **What it can use** is one block with three groups, each `Heading + summary + chips/list + scoped "+ Add"`:
  - Tools: checkbox grid as today, summarised with elevated tools always named in the warning text colour: "Read, Glob, Grep + Bash, Edit" (other overflow becomes "N more"); editing in place. The node's tools line carries an amber marker and its aria-label says "5 tools including Bash, Edit" when Bash, Edit, Write or NotebookEdit is on (walk 3, N9). Heading "Tools"; helper "What this role may do on your files and shell."
  - Connections: row per connection with name, a read-only access label (`Can read` / `Can read and change`) and a remove icon. **Access is fixed per server when it is added** (walk 3, N13, decided 2026-11-01): it is a property of the server (a connector's read-only or full variant, or a custom server's command), not of the grant, so the row shows it but does not edit it; to switch, remove the connection and add the other variant ("To switch it, remove the service and add it again" in the connector dialog). "+ Add" opens a chooser pre-scoped to this role: Your connections (already in project or app library), Browse (gallery), Ask the Team assistant. When Your connections is empty, "+ Add" opens the service picker directly; a service added from there is granted to this role only (the token or sign-in dialog's success grants it, no extra "Use in this project" step) (N3). A connection with any unset secret slot, curated or custom, shows a "Needs sign in" badge with a button that goes where the tray goes: a connector's highlighted gallery tile, or the custom server's edit form with the secret field focused (`openConnectorSetup`, N1). App settings > Connectors then shows a "Back to Team" button that returns to Team with the role selected.
  - Skills: checkbox/row list as `RoleSkills` today, "+ Add" opens the same chooser (This project, Your library, On this computer, Found in this repo, New skill, Ask the Team assistant). "On this computer" lists local skill folders from `capabilities:discover` and grants through `capabilities:apply` with the candidate id and discovery digest (N2). Empty copy names the cause ("This project has no skills yet." vs "All of them are on this role."). The chooser opens with focus on the selected tab; arrows and Home/End move between tabs (N7).
  - All three are editable (finding 1). Changes save through the existing project save path; a save indicator is the normal `SaveIndicator`.
  - Each "+ Add" is secondary. In an empty group the empty state replaces it with a primary "Add a connection" / "Add a skill" plus "Ask the Team assistant" as a link (finding 9). Never "Manage in Tools".
  - Elevated skills show their `skill-elevated` hint; elevated tools (Bash, Edit, Write) keep their warning style.
- **Catalog tab**: three sections (Skills, Connections, Plugins), each a list of project items: name, kind badge, source badge, **Used by** role chips (click selects that role and switches to Role), on/off switch (Connections, Plugins) or a "No role can load this" badge (Skills; existing `loadableByNoRole`), `More actions` popover with the existing actions (Promote to library, Unlink, Remove, Edit). Section headers have the "+ Add" chooser (unscoped). Plugins section is a short list with a link "Plugin settings" (stays in Project settings, section 5). Skill evaluation shows as a single row "Suggestions from past runs" at the bottom of Skills with the existing disclosure (`SkillEvaluationPanel`), configuration of budget stays in Settings.
- Catalog rows show one set of role chips ("Used by"); the role editor is a quiet "Change roles" button that discloses the checklist in place (N11). Group headers stack the actions under the heading below a 640 px container width.
- Container queries: at panel widths under 360 px chips wrap; at >= 480 px (wide) Catalog items show two-line rows with Used by inline. No fixed pixel heights on the groups; the panel scrolls as one column and the segmented control is sticky.

### Tray: Team assistant (`FrameTray`)
Docking follows Live: stacked under the canvas; docked beside it only in a frame of 1500 x 560 or more and only when the tray has content; `data-compact=true` under 480 px high, where the tray shows a single-line header with the primary button and the cards collapse to a count ("3 recommendations") that expands in place into a scrollable list.

Header row (always visible, one line): `Team assistant`, scope chip, **Recommend tools and skills** (primary), overflow `More` menu (Ask a question, Design the org chart (Architect), What I looked at).
- **Scope chip** is a select: "The whole team" or a role name. Default follows canvas selection (select a role: "Reviewer"; none: "The whole team"). The user can pin it; pinned scope shows a tiny lock-less "Pinned" text and survives selection changes until cleared. The scope is sent as `roleIds` in the request per the contract.
- Include outside sources: a checkbox under the header, off by default, label "Also search outside sources (MCP Registry, anthropics/skills, GitHub)", with a one-line note "Searches the internet. Results are unverified." Remembered per project in localStorage. Local sources (this repo, this computer, your library, this project) always run.
- Cost line, once, inline: "Runs on <tier> tier. Counts toward your usage." with a link to App settings > Defaults > Assistants. No repeat per entry point (finding 10).

#### States
1. **First run / empty** (no recommendations ever, default team or no connections): a short body "Find tools and skills for your team. I look at this repo, your computer and your library first." and the primary button. No interview. A secondary text button "Add one yourself" focuses the Role tab "What it can use" (or opens the Catalog chooser). Manual path never depends on AI (finding 4). The empty library is never offered as a primary action.
2. **Working**: the header button becomes a disabled "Looking..." with a spinner; below it a progress list streaming the discover phases ("Reading this repo", "Checking this computer", "Checking your library", "Searching the MCP Registry"), each with a check, skipped (outside sources off), or failed state; a **Cancel** button (secondary, `Escape` also cancels when focus is in the tray). Cancel keeps any candidates already found (marked "Partial") and says so. Not a Live run: the run is a sandboxed assistant run owned by the Team tab (finding 5), never switches tabs, never shows "R1".
3. **Results**: recommendation cards (below), then a **Gaps** section, then a "What I looked at" disclosure (list of sources with counts).
4. **No matches**: "Nothing matched <scope>. Describe what you need." with a text field ("Ask...") and offers "New skill" and "Draft a skill with the assistant". Never an empty list without a way forward.
5. **Error**: Banner `danger` inside the tray: plain message from `lib/ipcError.ts`, `Try again`, and `Add manually` link. Partial candidates survive.
6. **Rate-limited outside source**: per-source row shows "MCP Registry is busy. Try again in 60 s" (from the contract's source status), with the rest of the run continuing; local results are shown immediately. If the whole plan is rate limited, reuse the plan-limit wording of existing usage UI and offer local-only results.
7. **Applied**: cards collapse to "Applied" rows with Undo (section 3 of behaviour below).
8. **Dismissed** (walk 3, N4): Dismiss swaps the card for a one-row "Dismissed <name>. Undo" in the same list position for 8 s (focus on Undo; when the row expires with focus on it, focus moves to the next Apply); the polite live region says "Dismissed <name>." and, after Undo or Restore, "Restored <name>.". A "Dismissed (n)" disclosure at the bottom of the results lists dismissals (this session plus the review's persisted ones) with Restore (`capabilities:restore`). Recommend results persist with the review, so they survive a reload.

Results head and counts (N6, N12): "N to review" for the whole team, "3 to review for Reviewer · 11 waiting for the whole team" when scoped, so the Team tab badge (whole-team pending count) never disagrees; plus "and N gaps" as a link that focuses the Gaps heading. A proactive list (from a review after a run) shows the top 3 cards with "Show all N", skills first. The since-line reads "N suggestions since your last run". Curated cards show "Curated · <vendor>" as the source; the documentation URL sits in the card's Details disclosure (N14). Cards flow in two columns from a 900 px tray width. Opening, closing or changing the tray's phase (`data-tray-phase`) refits the chart (N8).

#### Recommendation card
Built on the `DecisionCard` shell (so it shares the frame/tray visual language and `Needs you` accounting is not triggered; assistant cards are not decisions of a run, they are in-tab proposals that the user may leave pending. They are not counted in the bell or sidebar badges).

Card anatomy, one per capability (grouped under the role heading when the scope is the team):
- Title line: kind icon (skill / connection), name, **source badge**.
- Source badge text (per the contract's `origin` + `sourceLabel`): "Found in this repo" (repo), "On this computer: <tool>" (local, `<tool>` from the label e.g. Claude Code), "Your library" (library), "This project" (project; used for gap fixes), "MCP Registry" (registry), "anthropics/skills" or "GitHub: owner/repo" (github), "Curated" (catalog; with existing Official / Preview badges). Outside origins (registry, github) additionally carry "Unverified" with the existing untrusted-note styling.
- **Evidence**: one sentence "why" from the recommendation reason, rendered as plain text (never markdown, never HTML) and clamped to 2 lines with "More".
- **Pin**: "Pinned: io.github.x/fs-server@1.0.0" or "Digest: abc123" in a mono token; unpinned outside candidates are not applicable (disabled, "Not pinned. Can't be added").
- **Access sentence** (plain, per role): "Reviewer can read repositories, issues and pull requests." Default is read-only and the named roles only, never "every role". A compact segmented "Can read | Can read and change" lets the user raise access (per the contract `access: 'read' | 'full'`); raising to full shows a one-line warning "Lets the Reviewer change things."
- **Flags**: "Runs code on this machine" (`elevated`/runs code, with exact command in a disclosure "Show details"), "Needs a token (about 2 minutes)" (`needsSecrets`), "Includes scripts" for elevated skills. A needs-secret candidate applies as "Add and sign in", sending the user into the existing `ConnectorDialog`; the grant is applied after sign-in.
- **Roles**: chips of the roles that would get it (checkable; at least one required, else Apply is disabled with the hint "Choose a role. Nobody gets it until you do.").
- Skills drafted by AI: "Show instructions" disclosure with full SKILL.md text (as the import dialog does) before Apply.
- Actions: **Apply** (primary on the first card only; others secondary), Dismiss. After apply: "Applied to Reviewer" with Undo.
- Header of the results: "Apply all" is offered only when no card needs secrets or runs code; otherwise only per-card Apply. No auto-apply, ever.

#### Gaps section
Short list under the cards: "Implementer can edit files and run Bash but has no test skill", each with an action chip (Ask the assistant to draft one / Browse skills / Dismiss). Gaps come from the contract's `gaps` and have no apply of their own.

#### Behaviour contract (renderer side, per the contract)
- `capabilities:discover` (scope, includeOutside) -> candidates; `capabilities:recommend` (scope, candidates) -> recommendations with `roleIds`, `reason`, `access`, `gaps`; `capabilities:apply` (selected recommendations, with chosen roles and access) -> result with an undo token; `capabilities:undo` (token); a per-role grant channel (event or call) the Role tab subscribes to so a grant made elsewhere updates chips live. Candidate: `kind` skill/mcp/connector, `origin` repo/local/library/project/registry/github/catalog, `sourceLabel`, pinned `version` or `digest`, `elevated`, `needsSecrets`. If any of these differ, only `lib/capabilities.ts` (the thin adapter and view model) changes.
- The renderer sends choices and ids, never full candidate bodies it did not receive from main (same trust model as agent import: the preview digest/stale check applies if the contract offers one; show the stale error with a Refresh).
- Undo is available until the first manual edit to those roles, like import Undo (`importNotices`).

## 3. Architect and the assistant (findings 3 and 5)

- The side-panel slot belongs to Role | Catalog. The Architect ("Design the org chart with AI") chat moves into the **tray** as a mode of the Team assistant: tray `More > Design the org chart (Architect)` or the toolbar-free empty team first-run link "Design the team with the Architect". Its chat uses the tray area (taller allowed: the tray grows to a maximum of 50% of the frame height, stacked; docked beside at >= 1500 x 560) so the inspector stays visible while the user talks. The Quick draft disclosure moves inside the Architect mode under "Advanced".
- Mode switch: a two-state `Tabs` in the tray header, "Recommend | Design", sharing the scope chip (Design is always the whole team and hides the chip). Only one mode runs at a time; switching away from a running mode keeps it running with an indicator on the tab.
- Assistant run no longer sends the user to Live (finding 5): the run is started by a Team-scoped start call, the renderer does not call `setView('run')`, no R1 run tab appears in the Live run strip while the run is a team-assistant run (it is hidden from run tabs and `History`; the contract should mark it `kind: 'assistant'`/setup-like so the store excludes it; mark as open dependency with the Runtime Lead). Results never use the "Replying to Orchestrator" composer; the tray has its own input "Ask..." and the existing MCP assistant approval card is replaced by recommendation cards (the MCP install card remains only for agent-initiated `request_mcp_install` in Live runs).
- A pending proposal that is mid-air when the user leaves the tab survives in the store; returning to Team restores it. Leaving Team while it runs: the tab label gets a small spinner dot (`aria-label` "Team, Team assistant working").
- The Architect's role changes keep their current proposal/approval flow; role-structure proposals use the existing proposal card in the tray.
- Org retrospective stays on Live.

## 4. Access, trust and copy rules (security-relevant UI)

- All candidate text (names, descriptions, reasons, SKILL.md, registry text, repo file content, README snippets) is untrusted. Render as text nodes only, clamp long text, no markdown rendering, no links from candidate text. External links are limited to a fixed set (token-creation help from the curated catalog) opened via the existing external-open path. Include a Reviewer security pass for this surface.
- Commands/paths in details are shown in `<code>` verbatim, never run by the renderer.
- Registry and GitHub results are labelled "Unverified". Anything not pinned cannot be applied.
- Default access: read, named roles only. Raising to full or adding Bash/Edit-capable skills needs the explicit control above.
- Announce outcomes with a polite live region (section 6).

## 5. What moves, what stays

| Today | Becomes |
| --- | --- |
| Settings > Tools > Skills (list, add, import, evaluate) | Team > Catalog > Skills and Role > Skills. Add skill chooser lives in Team. The Evaluate button and suggestions panel move to Catalog > Skills > "Suggestions from past runs" |
| Settings > Tools > Services and tools (connected-service rows, add service, other ways to add, library link, assistant) | Team > Catalog > Connections and Role > Connections. "Describe it to an assistant" becomes the Team assistant |
| Settings > Tools > Plugins | Stays in Project settings as a pane "Plugins" (advanced; Catalog lists them with a link) |
| Skill evaluation settings (switch, token budget) | Stays in Project settings > "Skills" (small pane), result surfaces in Catalog |
| Sign in, tokens, OAuth, Manage, Disconnect | App settings > Connectors, unchanged |
| Skill library (app-wide) | App settings > Skill library, unchanged; no longer a primary action in any add flow |
| Permissions / "Agents" | Project settings, unchanged |

**Settings > Tools** becomes **Settings > Plugins and suggestions** (slim): sections Plugins and Skill suggestions settings, with a `Banner` at top "Roles, connections and skills are now on the Team tab" and a `Button` "Open Team". The pane id `tools` is kept (so stored settings sub-tab, links and tests keep working), only label and contents change. If the content is empty it shows only the pointer.

**Deep links**
- `openProjectMcp(projectId, serverId?)` (used by `McpAuthNotice`): sets the project view to Team, opens the Catalog tab, scrolls to and highlights the connection row, and focuses its primary action (Sign in / Reconnect). A pre-existing consumer of the Settings > Tools target in `useAppStore` (`mcpTarget`) is retargeted; the exported name stays for compatibility, the implementation navigates to `team`.
- `requestSkillLibrary()` stays an App settings deep link, called from the skill chooser's "Open the skill library" and from Catalog > Skills "Manage library".
- Any code that does `setView('org')` becomes `setView('team')` (`View` type, `SECTION_VIEWS`, `App.tsx` tab config, `newProject` landing, `LiveRunView` "Open org chart" button label becomes "Open Team"). Persisted last-view in localStorage/store must map `'org'` to `'team'` on read.

## 6. Sizes, keyboard, focus, announcements

### 1024 x 640
- Sidebar rail (< 1180). Canvas keeps 280 px minimum; the side panel (280+) may auto-collapse to its rail by `panelBudget`; in rail form the Role | Catalog control is a two-icon stack and selecting a role expands the panel. The tray stacks under the canvas and is compact (< 480 px frame high) by default: one-line header, the primary button, results as a count that expands in place. The expanded tray takes at most 50% of the frame height and scrolls inside.
- Footer hint hidden under 700 px wide; toolbar secondary buttons collapse into a `More` menu under 640 px frame width, Add role stays visible.
- What it can use shows Tools as a summary line; Identity and Model are folded so the first screen reaches the capability block without scrolling (finding 8).

### 1600 x 1000
- Side panel may be wide (`data-side-wide` at 480): Catalog and Role can show chips inline. The tray docks beside the canvas only at 1500 x 560 with content; at 1600 x 1000 with content it docks right of the stage (max 360 px, the stage keeps 280). Tray content remains in the same DOM order.

### Both themes
Token colours only; source badges use the existing Official/Preview/unverified badge tones; Unverified uses the warning tone, "Runs code on this machine" uses the danger-subtle tone, access uses neutral. Contrast checked in light and dark for the dashed/flag chips. Verify with screenshots 1024 x 640 and 1600 x 1000 in both themes.

### Keyboard order
Topbar tabs, toolbar, canvas (React Flow focus, arrows move selection per existing behaviour), side panel (segmented, then groups in order Identity, Model, Tools, Connections, Skills, Delegation, Instructions), tray (header: scope, include-outside checkbox, primary, More; then cards top to bottom, within a card: roles, access, details, Apply, Dismiss), footer. `Escape` in the tray cancels a running search; `Escape` in a chooser popover returns focus to its "+ Add" button.
Focus after apply: focus moves to the card's replacement "Applied to Reviewer. Undo" row's Undo button; after Undo, to the primary Recommend button. When a card is dismissed, focus moves to the next card's first control (or the primary button when none). After "+ Add" completes in a role group, focus returns to the added item in the list.
Live regions: a single polite `role=status` in the tray announces "Looking at this repo", "Found 5 recommendations for Reviewer and 1 gap", "Partial results: MCP Registry did not answer", "Applied GitHub (can read) to Reviewer", "Undone". The Role tab announces "Reviewer can now use GitHub" when the per-role grant channel changes it from elsewhere. Errors use `role=alert`.

## 7. e2e impact

Update selectors in the same change as the code.

- `e2e/lib.mjs` `projectTab(page, name)` (line ~407): doc comment lists "Team"; callers pass `'Team'`. Test ids: `tab-org` becomes `tab-team`; add helpers `openTeam(page)` and `teamPanelTab(page, 'Role' | 'Catalog')`.
- `e2e/layout.mjs` (line ~311 and org-chart assertions): tab name, resize/side-panel checks keep working through `SidePanel`; add assertions for the segmented control and for the tray docking (stack at 1024 x 640, `.frame-tray:not(:empty)` rule).
- `e2e/import.mjs` (comment line 2 and "Org chart entry points" ~70): Team tab; Import agents / Export to repo buttons keep ids; banner and notices unchanged.
- `e2e/skills.mjs`: now opens Team > Catalog (and Role) rather than Settings > Tools (line 21 `projectTab(page,'Settings')` goes). Keep `skills-section`, `skill-row`, `skill-add-library`, `skill-new` ids on the moved components; a skills-section id may sit under Catalog. Import banner and evaluation ids stay.
- `e2e/connectors.mjs` (lines 116, 145, 172, 209): `projectTab('Org chart')` becomes `'Team'`; the `Settings` hops go; `mcp-add-service`, `mcp-add-other`, `mcp-add-library`, `mcp-group-connectors`, `connected-service-row`, `connector-use`, `role-services` re-homed under Catalog / Role. Prefer renaming only where behaviour changed; new ids: `team-panel-tabs`, `role-capabilities` (the block), `role-add-connection`, `role-add-skill`, `catalog-skills`, `catalog-connections`, `catalog-plugins`, `catalog-used-by`.
- `e2e/connections.mjs` (lines 126, 163, 193): same tab rename; settings > Connection stays in Settings.
- `e2e/maintenance.mjs` line 73, `e2e/history.mjs`, `e2e/usage.mjs`, `e2e/worktree.mjs`: only Settings/History/Live; unchanged unless Settings > Tools label is asserted.
- New: `e2e/team.mjs` (added to `e2e:free`): select Reviewer, grant a skill and a connection from "What it can use", run the Team assistant on mock, check recommendation card fields (source, pin, access sentence, flags), Apply, Undo, no navigation to Live, scope chip, cancel. New ids: `team-assistant`, `team-scope`, `team-recommend`, `team-include-outside`, `team-progress`, `team-cancel`, `capability-card[data-kind][data-origin]`, `capability-apply`, `capability-dismiss`, `capability-undo`, `capability-gaps`.
- The mock adapter needs a scripted discover/recommend/apply (Adapter Engineer/Runtime Lead).

## 8. Phased build and briefs (disjoint files)

### Brief 1: Rename and shell (lands first, serialized)
Files: `src/renderer/src/App.tsx`, `store/useAppStore.ts` (View `'team'`, `setView`, persisted-view migration, `openProjectMcp` retarget, `newProject` landing), `views/OrgChartView.tsx` -> `views/TeamView.tsx` (rename, region layout: toolbar, stage, tray slot, `SidePanel` with Role/Catalog placeholders, move `DraftPanel`/Architect chat into the tray as the Design mode, selection-to-tab behaviour), `components/layout/*` only if the segmented panel needs a `SidePanel` header slot, `components/ui/SegmentedControl.tsx` (new, if absent), `components/RoleNode` (capability line, canvas files), `views/LiveRunView.tsx` (label/`setView`), `views/SettingsView.tsx` and `components/settings/*` (Tools pane relabelled "Plugins and suggestions" with the pointer Banner, no removal yet), `styles/*` related, `docs`, `e2e/lib.mjs`, `e2e/layout.mjs`, `e2e/import.mjs`. Exposes slots: `<RoleCapabilities role onChange />`, `<TeamCatalog project />`, `<TeamAssistantTray project scope />` as stubs that later briefs fill. Keeps the existing inspector content working until brief 2a lands.

### Brief 2a: Role "What it can use" block (parallel)
Files (new/owned): `components/team/RoleCapabilities.tsx`, `components/team/CapabilityChooser.tsx`, `components/RoleServices.tsx` (replaced), `components/RoleSkills.tsx` (restyled into the block), `components/team/capabilityLabels.ts`, tests; role-scoped parts of `lib/skills.ts` only by new helper files, `lib/roleCapabilities.ts`. Uses `ConnectorDialog`, `SkillRoleAccess` without editing them (wrap).

### Brief 2b: Catalog (parallel)
Files: `components/team/TeamCatalog.tsx`, `components/skills/SkillsSection.tsx` (moved into Catalog usage, props only), `components/mcp/*` (project connected-service list moved; edit only the project-section files), `components/connectors/ConnectorUse*` if separate, `components/settings/ToolsSection.tsx` (slimmed to plugins and suggestions settings), `e2e/skills.mjs`, `e2e/connectors.mjs`, `e2e/connections.mjs`, `lib/settingsTarget.ts` (deep link mapping). Must not touch `RoleCapabilities.tsx`.

### Brief 2c: Team assistant tray (parallel, after contract lands)
Files: `components/team/TeamAssistantTray.tsx`, `components/team/CapabilityCard.tsx` (on `DecisionCard`), `components/team/CapabilityGaps.tsx`, `lib/capabilities.ts` (view model over the contract), `store/teamAssistant.ts` (zustand slice or a new file), `styles/team.css`, `e2e/team.mjs` (new) and the mock-script request to the Adapter Engineer (messaged, not edited). Needs: contract shapes in `src/shared/types.ts`, `preload/index.d.ts` surface, mock behaviour, and the assistant-run exclusion from Live run tabs.

Order: Runtime contract (parallel, Runtime Lead) -> Brief 1 -> 2a, 2b, 2c in parallel -> Reviewer after each phase (security pass on 2c: untrusted candidate text, external links, grant paths; also on 2b for deep links) -> UX Researcher walk of the scenario "Give my Reviewer role GitHub access and a code-review skill" (target: from the Team tab, under 6 clicks, one place to confirm).

## 9. Open questions / dependencies
- Contract must mark team-assistant runs so the Live run strip and History exclude them, or expose the assistant as a non-run call with progress events.
- Whether `capabilities:apply` takes the user's role/access edits per recommendation (spec assumes yes) and returns an undo token.
- Mock adapter script for the whole flow.
- Needs-secret candidates: spec routes through `ConnectorDialog` and applies the grant after sign-in; the contract must allow a "pending grant" or the renderer calls apply after the sign-in succeeds.
- Reduced-motion: spinner and progress ticks respect `data-reduce-motion`.
