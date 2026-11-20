# Team tab overhaul: build spec, phases 2 to 5

Status: spec only. Author: Product Designer. Builds on `docs/design/team-tab.md` (keep its vocabulary table: **Tools**, **Connections**, **Skills**) and on `docs/design/ux-review-team-tab-5.md` (the evidence; "shot N" and "Flow N" refer to it).

Two things about the inputs:

- `outputs/team-tab-overhaul.md` (the analysis, sections 3 to 7) was not present in this worktree. This spec is written from the owner's decisions in the brief, the fifth UX review, the current spec and the current source. Anything that the analysis may have said differently is listed in "Open questions".
- Nothing here was driven in the running app. Sizes of regions are estimates from the review's measurements (stage 330 px high at 1024x640 with a 165 px tray) and from the code. Marked "unverified" where it matters. The shadcn connector was unavailable; every component named below is already in the repo.

Phase 1 (defect pass, landing in parallel) is assumed to exist: spawn rights cleared when a manager loses its last report, non-overlapping placement of new roles, toolbar Add role adds under the root and the role has "Add a report", a readable delegation list with direct reports first, drop-anywhere re-parenting, a chip counting delegable reports, and a confirm before committing team files.

## 0. Decisions this spec builds on (not reopened)

1. Pocket Office and the decorative graph styles leave the Team editor. One fixed, readable node style. Layout direction stays as the only Team canvas control. Canvas style stays on Live and in App settings.
2. The Catalog becomes a full-width **Capabilities** view of the stage (items as rows, roles as columns), not a side-panel tab.
3. "Commit team files" stays on the tab, inside a status chip's popover, behind a confirmation listing the files.
4. The quick draft is removed. The Architect is reached from a **Start from** menu, not from the tray.
5. A role delegates to its own direct reports by default. Cross-branch delegation is an explicit advanced choice.
6. The side panel has no tabs. Nothing selected shows the team overview, a selected role shows the role editor.
7. The permanent tray becomes a **Suggestions** drawer, closed by default, opened by a header button with the pending count. Its scope follows the selection: no "For" select, no "Follow chart".
8. One primary action on the tab: **Add role**, which asks "Reports to" explicitly, pre-filled with the selected role or the root.

### 0.1 Vocabulary and one-word rules (apply to every string below)

| Idea | The one word | Replaces |
| --- | --- | --- |
| Handing work to another role | **delegate** ("can delegate to", "delegation") | "May create subagents", "spawn", "subagent", "leads N", "manages", "Required" (see 2.5) |
| Structure | **reports to** / **reports** | "manager" is allowed only as the label for the role someone reports to, in one phrase: "Reports to" |
| Tools, Connections, Skills | unchanged (team-tab.md section 1) | "MCP", "connector" (except App settings > Connectors) |
| The AI helper that proposes tools and skills | **Suggestions** (drawer, button, count) | "Team assistant", "Recommend", "Design" tab |
| The AI helper that redesigns the chart | **Architect** | "Design", "Revise with the Architect" as a tab label |
| Saving the team to the repository | **team files** | unchanged |

This retires "Team assistant" as a visible name on the Team tab (team-tab.md section 1 named it the only AI helper). The Settings pointer keeps its label "Team assistant: AI suggestions" in Project settings until its owner renames it; the drawer links to it with the words "Suggestion settings". Open question 1.

### 0.2 Regions and the shared frame

Everything uses `CanvasFrame` slots, `SidePanel`, `Banner`, `Button`, `Popover`, `Tabs`/segmented, `IconButton`, `Badge`, `Chip`-style classes already in `ui.css`, tokens and lucide icons. Nothing floats over the stage. Dialogs only for confirmations and the existing import, template and Architect flows.

```
+--------------------------------------------------------------------------+ side panel
| HEADER  Team  5 roles  [No problems]  [Chart|List|Capabilities]          |  (SidePanel,
|                  [Layout v] [Start from v] [Team files v] [Suggestions 3] [+ Add role]  |  no tabs)
+--------------------------------------------------------------------------+
| STAGE   chart  | list  | capabilities matrix (one at a time)             |  nothing selected:
|                                                                          |    Team overview
|                                                                          |  role selected:
+--------------------------------------------------------------------------+    Role editor
| SUGGESTIONS DRAWER (FrameTray, closed by default)                        |
+--------------------------------------------------------------------------+
| NOTICE ROW (reserved height)                      legend (chart only)    |
+--------------------------------------------------------------------------+
```

- Header and notice row replace the toolbar rows, the import banner stack and the footer hint. The stage's top and bottom edges never move because of a notice: the notice row is always rendered and reserves 32 px.
- Estimated stage size, closed drawer: 1440x900 about 850 x 560 (unverified); 1024x640 about 640 x 380 (unverified; the review measured 330 px high with a 165 px tray and two toolbar rows, the new header is one row and there is no tray, so the stage grows).
- Both themes: only tokens (`--surface-*`, `--text-*`, `--accent*`, `--warning*`, `--danger*`, `--border*`). No literal colors. Sizes use the existing spacing and type tokens.

### 0.3 File ownership and the shared hot file

`views/TeamView.tsx` is touched by every phase. To keep briefs disjoint, each phase puts its UI in new component files and limits its `TeamView.tsx` edit to mount points and state wiring, merged in order 2, 3, 4, 5. Phase 2's first task is the extraction listed in 1.9 so later phases do not conflict.

## 1. Phase 2: Header and role editor

### 1.1 Header (one line, `TeamHeader.tsx`)

```
1440x900
| Team   5 roles   (check) No problems   [Chart|List|Capabilities]          [Layout v] [Start from v] [Team files: saved v] [Suggestions 3] [+ Add role] |
1024x640 (container < 720 px: secondary controls become icons with labels in tooltips)
| Team  5 roles  (check) No problems  [view switch]      [Layout][Start from v][Files v][Suggestions 3][+ Add role]
```

Left group, in order:

| Element | Content | Notes |
| --- | --- | --- |
| Title | `Team` (h1, `--text-primary`, 15 px semibold) | `data-testid="team-title"`. One line under 560 px: title only, count moves into the title tooltip. |
| Role count | `5 roles` / `1 role` (13 px, `--text-secondary`) | `team-role-count`. |
| Problem count (placeholder in phase 2) | Neutral chip `No problems` with a check icon. Rendered in phase 2 as a static chip with `data-state="none"` and no click. Phase 4 makes it live. | `team-problems-chip`. Never shows "0 problems". |
| View switch (placeholder in phase 2) | The slot `team-view-switch` exists in the DOM. In phase 2 it renders nothing (only the chart exists). Phase 4 renders `Chart | List`, phase 5 adds `Capabilities`. | Segmented control (`Tabs compact`), `aria-label="Team view"`. Persisted per project in `localStorage` key `orgai.teamView.<projectId>`. |

Right group, in order (left to right):

| Control | Label | Behaviour |
| --- | --- | --- |
| Layout | `Layout` + chevron, icon `LayoutGrid` | Popover menu, three items: `Top to bottom`, `Left to right` (radio, current checked), separator, `Arrange automatically`. The two direction items set the Team layout direction; "Arrange automatically" is the old Auto-layout (glide, then fit). See open question 2 for where the direction is stored. |
| Start from | `Start from` + chevron, icon `LayoutTemplate`. A small dot (`--accent`) on the button while agent files are found and the "found" memory is not dismissed. | Menu, section 1.3. |
| Team files chip | See 1.4. | |
| Suggestions | `Suggestions` and a count badge when there are pending suggestions (`3`); no badge at 0. Icon `Sparkles`. | Not rendered in phase 2 (the drawer does not exist yet). Phase 3 adds it (section 2.2). |
| Add role | `Add role`, `variant="primary"`, icon `Plus`. The only primary button on the tab. | Opens the Add role popover, 1.2. |

Rules:

- Exactly one `variant="primary"` button is visible on the tab in the default state (Add role). Inside popovers and dialogs the confirm button is primary as usual.
- Wrapping: never wraps to a second row. Under 880 px container width the chip, Layout and Start from lose their text and keep an icon with `title` and `aria-label`; under 640 px Layout and Start from merge into one `More` menu (icon `Ellipsis`). Add role and the Suggestions button never collapse.
- The old "New roles report to X." note, the "Canvas style" button, the Templates menu, the Import button and the Pocket Office branch are removed from the Team view in this phase (Decision 1). `CanvasStyleButton`, `OfficeScene` and `withOfficeDepartments` stay in the code base for Live and App settings; they just stop being imported by `TeamView.tsx`.
- The Team view stops reading `options.nodeStyle`, `options.presentation`, `options.edges` from the shared canvas options. It uses fixed values (section 4.2 states them). `options.layout` is replaced by the Team layout direction.

### 1.2 Add role popover (`AddRolePopover.tsx`)

Opens from the header button, from a role's context menu item "Add a report" (pre-filled with that role) and from the chart's empty-state button. `Popover`, `placement="bottom-end"`, width 320 px, `role="dialog"`, `aria-label="Add a role"`, `data-testid="add-role-popover"`.

```
+--------------------------------------+
| Add a role                           |
| Name                                 |
| [ New role                         ] |   selected on open
| Reports to                           |
| [ Reviewer                         v]|   select, indented by depth
| Reviewer will be able to delegate    |
| to it.                               |
|            [Cancel]  [Add role]      |   primary
+--------------------------------------+
```

- **Name**: prefilled with `nextRoleName`, all text selected. Testid `add-role-name`. Label `Name`.
- **Reports to**: a `Select` listing every role in chart order with two spaces of indent per depth level ("Orchestrator", "  Reviewer", "    Docs Writer"). Default value: the selected role if there is one, otherwise the root. Testid `add-role-parent`. Label `Reports to`. No "Nobody" option. When the project has no role at all the control is replaced by the text `The first role becomes the top of the team.` and the button reads `Add first role`.
- **Helper line** under the select, live with the choice: `{Parent} will be able to delegate to it.` (phase 1 makes this true by default). If the parent is a role that currently cannot delegate: `{Parent} will be able to hand work to other roles. You can change that on {Parent}.`
- Buttons: `Cancel` (secondary), `Add role` (primary). Enter in the name field submits. Escape cancels and returns focus to the header button.
- Name validation: empty name keeps the button disabled with no error text; a name equal to an existing role (case-insensitive) shows `There is already a role called {name}. Pick another name.` and disables Add role.
- On submit: the role is added with the phase 1 defaults (description unchanged placeholder, tools `Read, Glob, Grep`, Everyday tier, non-overlapping placement). Popover closes. The new role is selected, the chart pans to it if it is off screen (4.6), the role editor opens and **focus goes to the Description field** (the name is already known; description and tools are what a new role needs). Notice row: `Added {name} under {Parent}.` with `Undo` (12 s). Undo removes the role again and restores the manager's previous delegation settings. Testid `team-notice-undo`.
- The role editor's old inline banner "{Manager} can now create subagents, because ..." is deleted. Nothing replaces it: the helper line above is the only disclosure, shown before the action, where the user chooses.

### 1.3 "Start from" menu (`StartFromMenu.tsx`)

`Popover role="menu"`, width 300 px, items are `menuitem` buttons with a title line and a one-line description in `--text-secondary` 12 px. Arrow keys, Home and End move (reuse `onTemplateMenuKey`).

| Item (title) | Description line | Count / state shown before clicking | On click |
| --- | --- | --- | --- |
| `Use a template...` | `Replace the team with one you saved.` | Right side: `{n} saved` (`2 saved`). With none: item is `aria-disabled`, description changes to `No templates yet. Save this team as one first.` | `ApplyTemplateDialog` with the preview (below). |
| `Import agent files...` | `Roles from .claude, .codex, .opencode and other tools in this folder.` | Right side, from the existing scan (`scanAgents`): `{n} found` (`3 found`, accent badge) when n > 0; `None found` (muted) when 0; `Checking...` while the scan runs. The item stays clickable in every state (the dialog's empty state lists where it looked). | `ImportAgentsDialog`. |
| `Redesign with the Architect...` | `Describe what should change. The Architect proposes it on Live.` | If an Architect session is open for this project: right side `Session open`, and the title changes to `Open the Architect session`. | Opens the Architect dialog (below), or opens the open session. |
| separator | | | |
| `Save as template...` | `Keep this team to start other projects from.` | Disabled when the team has one role: `Add a role first.` | `SaveTemplateDialog` (unchanged content). |

Count details: `n` is the sum of `agentCount` over `importSourcesFor(scan.sources, filesOn)` (the same number the old "Agents found" banner used). Opening the menu while n > 0 counts as seeing it: write the banner memory `dismissed` (as the old banner's dismiss did) and remove the dot. The old "Agents found" banner (`import-found`) is deleted; the menu and its dot replace it.

**Template preview** (`ApplyTemplateDialog.tsx`, UI part): two columns at 640 px dialog width (list left 240 px, preview right). Preview shows the selected template: name, description, `{n} roles`, kind, then the role names in chart order as a plain numbered list (the first is marked `top`). Under it: `Replaces your {m} current roles. You can undo until you change a role.` A role-structure tree in the preview needs the template's reporting lines; `OrgTemplateInfo` has only `roleNames`. **Contract change, marked**: add reporting structure to `OrgTemplateInfo` (see 5.2). Until then the list is flat.

**Architect dialog**: reuses the "Say what should change" textarea and button from `DraftPanel` (moved to `components/team/ArchitectDialog.tsx`). Title `Redesign with the Architect`. Body: `Say what should change. The Architect reads the repository and the current chart, then proposes the revised team. The session opens on Live and nothing changes until you approve.` Placeholder: keep the current example text. Buttons: `Cancel`, primary `Start the Architect` (or `Send to the open session` when one is open). Testids: `org-change-start` stays on the primary button; the textarea keeps its current testid. Quick draft (`Advanced: quick draft`, `applyDraft`, `discardDraft`) is deleted with its state.

### 1.4 Team files chip and popover (`TeamFilesChip.tsx`, replaces `TeamFilesLine.tsx`)

A chip button in the header, left of Suggestions. Text and tone come from `teamFilesLine(status)` with these label changes (so the chip never shouts on an untouched project):

| State | Chip text | Tone | Icon |
| --- | --- | --- | --- |
| `in-sync`, nothing uncommitted | `Team files: saved` | quiet | `FileCheck` |
| `in-sync`, uncommitted, git repo | `Team files: not committed` | **neutral** (was attention) | `FileText` |
| `in-sync`, uncommitted, not git | `Team files: saved` | quiet | `FileCheck` |
| `pending` | `Team files: {n} to approve` | accent | `FileWarning` |
| `problem` | `Team files: problem` | danger | `TriangleAlert` |
| `rejected` | `Team files: differ` | quiet | `FileText` |
| `off` (removed) | `Team files: off` | attention | `FileX` |
| `off` (other reasons) | `Team files: off` | quiet | `FileX` |
| `off` with `engagement` or `virtual` | chip not rendered | | |

Popover (`role="dialog"`, width 360 px, testid `team-files-popover`):

```
Team files
OrgAI keeps this team as plain files in .orgai/ in your
repository, so it can be reviewed and shared.

[status sentence]            e.g. "3 files are not in git yet."
  .orgai/org.json
  .orgai/agents/reviewer.md
  .orgai/agents/implementer.md
  and 1 more

[ Commit team files ]    (secondary)
[message from the last action]
[warnings, up to 3]
```

- Status sentence per state: not committed `{n} {file|files} not in git yet.`; in-sync `Everything is saved and committed.` (git) or `Saved in .orgai/ in this folder.` (no git); pending `{n} changes need your approval.` plus button `Review changes` (secondary; closes the popover and opens the review in the side panel, section 2.4); problem uses `line.text` and `line.detail` unchanged; rejected and off use the existing `detail` text.
- File list: from `uncommittedFiles`, first 8, then `and {n} more`. `<code>`-style mono, folder-relative. Text from files stays text (`showHidden`).
- **Commit confirmation** (`useConfirm`, phase 1 adds the confirm; this spec fixes its content): title `Commit {n} team {file|files}?`; body `This makes one commit in your repository with these files:` then the list (up to 8, `and {n} more`) then `Nothing is pushed.`; confirm label `Commit {n} {file|files}`; cancel `Cancel`. After success: chip returns to `Team files: saved`, notice row `Committed {n} team files.` (no undo), focus returns to the chip. "Nothing is pushed" is true only if `teamFiles:commit` makes a local commit and never pushes: unverified, confirm with the Runtime owner before shipping the sentence.
- The popover also holds `TeamFilesAppliedNotice` content (Undo of "applied at once" changes): row `Applied {n} changes from the files.` + `Undo`.
- Moves out of the chip popover to the notice row: nothing. Moves out of the toolbar: the whole `team-files-line` row (its testid `team-files-line` is kept on the chip, `data-state` and `data-tone` unchanged, so `e2e/team-files.mjs` selectors mostly survive; `team-files-commit` moves inside the popover and needs the popover opened first).

### 1.5 Notice row (`TeamNoticeRow.tsx`) and first-visit hint

One 32 px row below the stage, always rendered (`FrameFooter` always has content on Team; its text is empty when idle). Left: one message with an optional action and a dismiss. Right: the legend slot (empty until phase 5). `role="status"` polite. Testid `team-notice-row`.

Message kinds, priority high to low (only the highest is shown; the rest wait, and a `+N` text button opens a popover listing the waiting ones):

| Priority | Kind | Text | Action | Expires |
| --- | --- | --- | --- | --- |
| 1 | Error | `Could not {action}: {message}` (from `cleanIpcError`) | `Dismiss` | stays until dismissed |
| 2 | Undoable edit | `Added {name} under {Parent}.` / `Removed {name}.` + if it had reports ` Its {n} {report now reports|reports now report} to {Parent}.` / `{name} now reports to {Parent}.` / `Applied the template {name}.` / `Imported {n} {role|roles}.` | `Undo` | 12 s (imports and templates: until the next edit, as today) |
| 3 | Open session | `{Run name} is open. {status}.` (from `OrgChangePointer`) | `Open session` | while open |
| 4 | Saved | `Saved the template {name}.` / `Committed {n} team files.` | `Manage templates` for the template | 8 s |
| 5 | First-visit hint | `Click a role to edit it. Drag from its bottom handle onto another role to change who it reports to. Right-click a role for more.` | `Got it` | until dismissed; stored in `localStorage` key `orgai.teamHintSeen` |

- The row never changes height. A message that is too long is clamped to one line with `title` carrying the full text.
- The footer hint sentence "Drag from a node's bottom handle... Shift+F10..." is removed. Its keyboard sentence moves to the team overview's closed disclosure `Keyboard shortcuts` (2.1): `With a role focused: Enter edits it, Delete removes it, Shift+F10 opens its menu.`
- The import and template banners (`import-notice`, `template-notice`, `template-saved-notice`, `import-undone`, `template-undone`) become messages of kind 2 and 4 in this row. Their testids move to the row's message element (`data-kind` selects the variant); see 1.10 for e2e.
- The old `toolbar-undo` "Role removed." row is removed. Remove no longer asks first when the role has no reports; with reports the existing confirm remains because the effect (reports move up) is not obvious. Open question 3.

### 1.6 Role editor: order and sections (`RoleInspector.tsx`)

The panel header stays: avatar, `h2` with the role name, `Remove` (danger, small; absent on the root). Order of sections, each an `h3.side-section-title`:

1. **Who it is**
2. **What it does**
3. **What it can use**
4. **Who it can delegate to**
5. **Model and effort**

Folding on short windows: `roomy` (>= 800 high and >= 1280 wide) keeps every section open. Otherwise sections 1 to 3 open, section 4 open when the role can delegate, section 5 folded behind its sentence (it already is one line). The old `role-identity-fold` and `role-model-fold` details are replaced by `role-section-who`, `role-section-does`, `role-section-use`, `role-section-delegate`, `role-section-model` (`<details>` only for section 5 and the sub-folds named below).

#### Who it is (testid `role-section-who`)

| Field | Label | Control | Notes |
| --- | --- | --- | --- |
| Name | `Name` | `Input` (`role-name-input`, unchanged id) | Slug follows the name as today. |
| Description | `What is this role for?` | `Textarea`, 3 rows | Helper under it: `Managers read this to decide when to hand work to it.` Placeholder replaces the seeded sentence: when the text equals the seeded `Describe when a manager should delegate to this role.` show it as the placeholder in `--text-tertiary` and treat it as empty. Testid `role-description`. |
| Reports to | `Reports to` | `Select`, options indented by depth, own subtree disabled (`wouldCycle`) | Root: the select is replaced by the text `Top of the team. It does not report to anyone.` Non-root: no "Nobody" option. Changing it re-lays out that branch (4.6) and shows the notice `{Role} now reports to {Manager}.` with `Undo`. |
| Color | `Color` | radio swatches, unchanged | |
| Technical name | `Details` fold (closed): `ID used in team files` + mono input | `Input mono` | Helper: `Used in .orgai/ files and when a manager starts this role. It follows the name unless you edit it.` Replaces the visible "Slug (subagent type)". Id stays `role-slug`. |

#### What it does (testid `role-section-does`)

- `Responsibilities` textarea (placeholder `One per line`), unchanged behaviour, id `role-responsibilities`.
- `Instructions` textarea (mono, 8 rows; label was `System prompt`), id `role-prompt`. Helper: `Responsibilities, the roles it can delegate to and the project brief are added when it runs.`
- `Preview final prompt` button (secondary, small, icon `Eye`), testid `role-preview-prompt`. **Placeholder, needs main-process work** (5.2). In phase 2 it renders disabled with `aria-describedby` text `Not available yet.` shown on hover and focus. When main exposes the assembled prompt, the button opens a read-only dialog `Final prompt for {name}` with the text in mono, `Copy` button, and `This is what the role receives at the start of a run. Text from your repository is shown as written.` Do not design the contract here.

#### What it can use (testid `role-capabilities`, existing)

Keep `RoleCapabilities`, `CapabilityGroup`, `RoleServices`, `RoleSkills` and the chooser. Changes:

- **Order**: Tools, Connections, Skills (unchanged). The block stays a single section.
- **Empty groups are one line** (replaces the 100 px empty states). Connections: row `Connections` + muted `None yet` + `Add` (secondary small, testid `role-add-connection`) + text link `Suggest one` (opens the Suggestions drawer scoped to this role, phase 3; until phase 3 the link is omitted). Skills: same with `Skills`, `role-add-skill`. The longer sentences "A connection lets this role reach a service such as GitHub or Slack." and "A skill is a how-to this role can load when a task needs it." move into the `title` of the group heading and into the chooser's header (they are good copy, keep them there).
- **Tools in plain-language groups, raw names secondary.** Collapsed state shows one summary sentence (replaces "Read, Glob, Grep + Bash, Edit"): built from the groups on, joined: `Can read files.` / `Can read files and browse the web.` / `Can read files, change files and run commands.` Elevated groups in `--warning` text with a `TriangleAlert` icon and the words (so the meaning does not depend on the icon). `Edit` button (`role-edit-tools`) toggles the editor.
- Editor (open): one checkbox row per **group**, with a checkbox that shows the mixed state when only some of the group's tools are on:

| Group (label) | Description (12 px, secondary) | Raw names (11 px mono, tertiary, after the description) | Elevated |
| --- | --- | --- | --- |
| `Read files` | `Look at files and search the project.` | `Read, Glob, Grep` | no |
| `Change files` | `Create, edit and overwrite files.` | `Edit, Write, NotebookEdit` | yes: chip `Can change files` |
| `Run commands` | `Run commands in a shell on this computer.` | `Bash` | yes: chip `Can run commands` |
| `Browse the web` | `Search the web and fetch pages.` | `WebSearch, WebFetch` | no |
| `Plan and message` | `Keep a to-do list and message other running agents.` | `TodoWrite, SendMessage, ListAgents` | no |

  Under the groups, a closed disclosure `Choose individual tools` shows the current 12-checkbox grid (testids `role-tool-<Name>` unchanged; the group checkboxes get `role-tool-group-<id>` with ids `read`, `change`, `run`, `web`, `plan`). The group mapping lives in a new `lib/toolGroups.ts` over `TOOL_CATALOG`; a tool not in a group falls into `Plan and message` so a future tool never disappears.
- Role that has no tools: summary `No tools. It can only answer from what it is told.`
- The two "Ask the Team assistant" links and the per-group "Ask..." wiring are replaced in phase 3 by `Suggest one` (above). In phase 2 `onAskAssistant` is kept and ignored.

#### Who it can delegate to (testid `role-section-delegate`)

Phase 1 delivers the readable list and direct-reports-first order. Phase 2 sets the words and the structure:

- Toggle (`Checkbox`, testid `role-can-delegate`): label `Can hand work to other roles`, description `Turn this off to make it a role that only does the work it is given.` (replaces `May create subagents`). Off: the section shows only the toggle.
- On: heading line `Direct reports`. One row per direct report: avatar dot, name, checkbox `Can delegate to it` (default on), second checkbox `Always uses` (replaces `Required`; `title`: `Every time this role finishes, the team must hand a task to this one.`, disabled unless delegable; testid `role-required-report-<slug>` unchanged). No reports: `No reports yet. Add a role that reports to {name} to delegate work.` with the link-button `Add a report` (opens the Add role popover with this role as parent).
- Below, a closed disclosure `Roles on other branches ({n})` (hidden when n is 0). Its body starts with `Delegating across branches skips the roles in between. Use it only when you mean it.` and lists the other roles that are neither a direct report nor the role's own manager chain, grouped by branch head, each with a `Can delegate to it` checkbox (default off; no "Always uses" here). A role's own manager and ancestors are never listed (review Flow 3, shot 22). Opening the disclosure is the explicit choice (Decision 5).
- A cross-branch delegation that already exists opens the disclosure by default and shows a note chip `{n} on other branches`.

#### Model and effort (testid `role-section-model`)

One sentence plus one control, details folded.

- Sentence (`role-model-sentence`): composed from the current picker value and staffing line, in this form:
  - Auto staffing, tier set: `Runs on {Tier label} ({model}). OrgAI chooses how much effort per task, up to {effort}.`
  - Auto, no effort set: `Runs on {Tier label} ({model}). OrgAI chooses how much effort per task.`
  - Fixed: `Always runs on {Tier label} ({model}) at {effort} effort.` (no effort set: `Always runs on {Tier label} ({model}).`)
  - Inherit: `Uses the same model as {Manager}.`
  - Tier labels: `Top`, `Deep`, `Everyday`, `Fast`; the raw model id is in parentheses only when the connection exposes it.
- Control: the existing `RoleModelPicker` (select) labelled `Model`, directly under the sentence. Testid unchanged.
- Fold `Staffing details` (closed, `role-staffing-fold`): contains `RoleStaffingControls` with the rewritten strings below. The `Tier and effort:` bold prefix is removed (the sentence above replaces it).

Rewrite table for `lib/roleStaffing.ts` and `RoleStaffingControls.tsx` (values unchanged, only labels):

| Today | New |
| --- | --- |
| `Staffing` (field label) | `How the model is chosen` |
| `Follow the project (Automatic)` | `Same as the project (chosen per task)` |
| `Automatic` (mode label) | `Chosen per task` |
| `Always as configured` | `Always this model` |
| `Lowest tier` | `Cheapest model it may use` |
| `No lowest tier` | `Any model` |
| `Highest effort` | `Most effort it may use` |
| `The role's effort ({e})` | `This role's effort ({e})` |
| `Up to high (no effort set)` | `Up to high (default)` |
| `This project is set to Always as configured, so this role does not change per assignment.` | `This project always uses the configured model, so this role does not change per task.` |
| `No effort is set, so automatic picks may go up to high.` | `No effort is set, so OrgAI may use up to high effort.` |

The tests that assert these labels (`roleStaffing.test.ts` lines 93 and 94 and the like) change in the same commit.

### 1.7 The wording that needed a second read: exact replacements

| Where | Today | New string |
| --- | --- | --- |
| Team files chip, fresh project | `Team files changed, not committed` + `Commit team files` | chip `Team files: not committed` (neutral); button inside popover `Commit team files` |
| Team files after commit | `Team files: in sync .orgai/ in this repository. Committed 15 team files.` | chip `Team files: saved`; notice `Committed 15 team files.`; popover `Everything is saved and committed.` |
| Toolbar note | `New roles report to Implementer.` | removed; the Add role popover says `Reports to` |
| Tools heading helper | `What this role may do on your files and shell.` | summary sentence, e.g. `Can read files and run commands.` |
| Description label | `When should a manager delegate to this role?` | `What is this role for?` + helper `Managers read this to decide when to hand work to it.` |
| Reports to, root | `Nobody (root orchestrator)` | non-root: option removed; root: `Top of the team. It does not report to anyone.` |
| Delegation switch | `May create subagents` | `Can hand work to other roles` |
| Card chip | `leads 3` | `Delegates to 3` (counts delegable direct reports, phase 1 rule; hidden at 0) |
| Edge label | `not delegable` | `Cannot delegate` |
| Edge aria | `{A} manages {B}. Press Delete to make {B} report to {Root} instead.` | `{B} reports to {A}.` (delegable) / `{B} reports to {A}, which cannot delegate to it.` ; the Delete-key sentence stays only in the chart's accessible description |
| Required | `Required` | `Always uses` |
| Model | `Tier and effort: Automatic, up to Everyday / high` | sentence in 1.6 |
| Model fold labels | see 1.6 table | see 1.6 table |
| Import button / dialog | `Import from other tools` / `Import agents` / `found in this folder` | menu `Import agent files...`; dialog title `Import agent files`; body `Review the roles found in this folder before they join the team.`; primary `Import {n} {role|roles}` |
| Replace | `Replace the team with a template...` + `You can undo until you edit the chart.` | menu `Use a template...`; dialog line `You can undo until you change a role.` |
| Assistant name | `Team assistant` (Recommend and Design) | `Suggestions` (drawer) and `Architect` (Start from) |
| Remove (no reports) | confirm `Remove {name}?` | immediate; notice `Removed {name}.` + `Undo` |
| Remove (with reports) | `Its 2 reports move up to its manager. You can undo this for a few seconds.` | `Remove {name}?` / `Its {n} {report moves|reports move} up to {Parent}.` / confirm `Remove role` / notice `Removed {name}. Its {n} {report now reports|reports now report} to {Parent}.` + `Undo` |
| Role empty state, panel | `No role selected / Select a role on the chart to edit what it can use.` | replaced by the team overview (section 2.1) |

### 1.8 States (header and role editor)

| Region | State | What shows |
| --- | --- | --- |
| Header | one role only | count `1 role`; Add role primary; chip `No problems` suppressed (phase 4). |
| Header | project switching | header re-renders per project; popovers close. |
| Add role popover | submit error (save failed) | popover stays open, `Banner tone="danger"` inside it with the message; Add role re-enabled. |
| Start from | scan pending | `Checking...` on the import item; item clickable. |
| Start from | scan failed | import item right side `Could not check`; clickable. |
| Team files chip | status not loaded | chip hidden (as today the line is hidden). |
| Team files chip | busy commit | `Commit team files` shows spinner and is disabled; chip text unchanged. |
| Role editor | root selected | `Remove` hidden; Reports to is text; delegation section as for any role. |
| Role editor | role removed while open | panel returns to the team overview, focus to the chart node nearest the removed one. |
| Role editor | tools editor open | group rows as 1.6; closing with `Done` returns focus to `Edit`. |
| Preview final prompt | any | disabled placeholder until the main-process work lands. |

### 1.9 Behaviour at the two window sizes

| | 1440x900 | 1024x640 |
| --- | --- | --- |
| Header | One row, all labels visible. | One row; chip and Layout lose text under 880 px container; Start from and Layout merge into `More` under 640 px. Add role and (phase 3) Suggestions stay. |
| Panel | Side panel at its persisted width (about 360); every editor section open. | About 320; sections 1 to 3 open, 4 open when the role can delegate, 5 shows its sentence. First screen shows Who it is and the top of What it does without scrolling past the header; What it can use is reached within about one scroll (estimate, unverified). The panel may rail by `panelBudget`; selecting a role expands it. |
| Notice row | 32 px, text up to about 110 characters before clamping. | Same height; text clamps at about 70 characters, full text in `title`. |
| Popovers | Anchored under their button. | Anchored; Add role popover 320 px wide fits; Start from menu 300 px; Team files popover 360 px but never wider than the frame minus 16 px. |

### 1.10 Acceptance criteria (tester, mock data)

Default mock project "Walk" (Orchestrator, Implementer, Reviewer, Researcher), dark and light, both sizes.

- [ ] The header is one row at 1440x900 and 1024x640. It shows `Team`, `4 roles`, `No problems`, Layout, Start from, the Team files chip and `Add role`. No `Canvas style`, Templates, Import or Auto-layout button is on the toolbar.
- [ ] Exactly one primary-colored button is visible on the tab (Add role).
- [ ] Add role opens a popover with `Name` selected and `Reports to` set to the root. After selecting Implementer on the chart and opening it again, `Reports to` is Implementer. Choosing Reviewer and pressing Enter adds the role under Reviewer, selects it, opens the editor and puts focus in `What is this role for?`.
- [ ] The notice row says `Added New role under Reviewer.` with Undo; Undo removes it and the notice row height does not change during the whole sequence (measure the stage top and bottom before and after: equal).
- [ ] No sentence "can now create subagents" appears anywhere after adding or re-parenting a role.
- [ ] Start from lists four items. On a folder with no agent files the import item shows `None found`; on a folder containing `.claude/agents/*.md` (use the import e2e fixture) it shows `3 found` (the real count) before any click, and the button has a dot that disappears after the menu is opened once.
- [ ] `Use a template...` shows `0 saved` as disabled with the reason when none exist; after saving a template it shows `1 saved` and the dialog preview lists that template's role names and `Replaces your 4 current roles.`
- [ ] `Redesign with the Architect...` opens the dialog; there is no `Advanced: quick draft` anywhere on the tab.
- [ ] The Team files chip on a fresh project reads `Team files: not committed` in neutral tone (not attention). Its popover lists the uncommitted files and a `Commit team files` button. Pressing it opens a confirm listing the same files; Cancel changes nothing; confirming shows `Committed {n} team files.` in the notice row and the chip becomes `Team files: saved`.
- [ ] The footer hint sentence is gone. On a first visit (clear `orgai.teamHintSeen`) the notice row shows the hint with `Got it`; after `Got it` and a reload it does not return.
- [ ] Role editor order, top to bottom: Who it is, What it does, What it can use, Who it can delegate to, Model and effort. The Reports to select is in the first section and has no "Nobody" option for a non-root role.
- [ ] A new role's empty Connections and Skills each take one line (heading, `None yet`, `Add`).
- [ ] Tools editor shows five plain-language groups with raw names beside each; ticking `Run commands` turns on `Bash`; `Choose individual tools` still lists all 12; the collapsed summary changes to `Can read files and run commands.` with `run commands` in the warning color and an icon.
- [ ] Delegation shows direct reports first with `Can delegate to it` and `Always uses`; the role's own manager is not listed anywhere; `Roles on other branches` is closed by default and shows its warning sentence when opened.
- [ ] Model and effort shows one sentence and one select; `Staffing details` is closed and contains the renamed labels; no visible string `Tier and effort`, `Follow the project`, `Lowest tier` or `Always as configured` remains.
- [ ] `Preview final prompt` is visible and disabled with `Not available yet.`
- [ ] Removing a role without reports shows no dialog and a notice with Undo; removing one with reports shows the confirm with the new body.
- [ ] Both themes: chip, popovers, group rows and chips keep readable contrast (spot-check with the contrast checker on `Can run commands` chip text and the neutral chip).

### 1.11 Files touched (phase 2)

Edit: `src/renderer/src/views/TeamView.tsx` (extract the header, notices, add-role and import wiring into the new files; remove Canvas style, Office branch, Templates menu, toolbar note, footer hint, `toolbar-undo`, the tray slot is untouched until phase 3); `src/renderer/src/components/RoleInspector.tsx`; `src/renderer/src/components/team/RoleCapabilities.tsx` (tools groups, empty lines); `src/renderer/src/components/team/CapabilityBlock.tsx` (one-line empty variant); `src/renderer/src/components/connectors/RoleServices.tsx`, `src/renderer/src/components/skills/RoleSkills.tsx` (empty-state text only); `src/renderer/src/components/RoleModelPicker.tsx` (label only); `src/renderer/src/components/team/RoleStaffingControls.tsx`; `src/renderer/src/lib/roleStaffing.ts` and `roleStaffing.test.ts`; `src/renderer/src/lib/teamFiles.ts` (chip text, commit confirm text) and its test; `src/renderer/src/components/team/useTeamFilesActions.ts` (confirm); `src/renderer/src/components/templates/ApplyTemplateDialog.tsx`; `src/renderer/src/components/import/ImportAgentsDialog.tsx` (strings); `src/renderer/src/lib/roleOps.ts` (depth-indented parent options helper, delegation defaults if phase 1 did not); `src/renderer/src/styles/team.css`, `editor.css`, `teamFiles.css`.
New: `components/team/TeamHeader.tsx`, `AddRolePopover.tsx`, `StartFromMenu.tsx`, `TeamFilesChip.tsx`, `TeamNoticeRow.tsx`, `ArchitectDialog.tsx`, `RoleToolGroups.tsx`, `RoleDelegation.tsx`, `RoleModelSentence.tsx`, `lib/toolGroups.ts`, `lib/teamNotices.ts` (the priority queue, pure, unit tested), with unit tests beside them.
Remove (end of phase 2 or 3, see 2.5): `components/team/TeamFilesLine.tsx`.

### 1.12 e2e selectors that change (phase 2)

- `e2e/team.mjs`: the Add role button now opens a popover (click `add-role-submit` or press Enter); the inline banner assertions go; `role-identity-fold` and `role-model-fold` are replaced by the section testids; tools editing uses `role-tool-group-*`; description label text changes.
- `e2e/team-files.mjs` (35 hits): the line becomes a chip with a popover; `team-files-commit` needs the popover opened and now opens a confirm (`confirm-ok`); `team-files-review` keeps its id inside the popover; `toolbar` assertions go.
- `e2e/import.mjs`: `import-agents` button becomes the `Start from` menu item (`start-from-import`); `import-found` banner assertions become the menu count and dot; `import-notice`, `import-undo`, `template-*` notices move to `team-notice-row` messages.
- `e2e/canvas.mjs`: any Team-tab Canvas style or Pocket Office steps are removed (those remain valid on Live and in App settings).
- `e2e/layout.mjs`: header single-row and no-overlap checks at both sizes; footer hint text removed; the stage height assertion changes.
- `e2e/org-change.mjs`, `e2e/proposals.mjs`: `architect-open` and Design tab steps become `Start from > Redesign with the Architect`.
- `e2e/connections.mjs` and `e2e/multi-provider.mjs`: label strings only (`Model` fold, `Tier and effort`).
- New ids: `team-title`, `team-role-count`, `team-problems-chip`, `team-view-switch`, `team-layout`, `team-start-from`, `start-from-template`, `start-from-import`, `start-from-architect`, `start-from-save`, `add-role-popover`, `add-role-name`, `add-role-parent`, `add-role-submit`, `team-files-chip`, `team-files-popover`, `team-notice-row`, `team-notice-undo`, `team-hint-dismiss`, `role-section-*`, `role-description`, `role-can-delegate`, `role-model-sentence`, `role-preview-prompt`.

### 1.13 Needs main-process or shared-contract work (phase 2)

- **Preview final prompt**: main must assemble the final prompt (responsibilities, delegation list, project brief) and expose it read-only. Marked. Until then the button is a disabled placeholder.
- **Template role structure** for the preview tree: `OrgTemplateInfo` carries role names only. Optional; the flat list ships without it.
- `teamFiles:commit` must not push (verify, then keep the sentence `Nothing is pushed.`).
- Nothing else; the rest is renderer-only.

## 2. Phase 3: Side panel, Suggestions drawer, team files approval

### 2.1 Side panel with no tabs

`SidePanel` keeps its width, persistence, rail and `data-side-wide` behaviour. The tab strip, `TeamCatalog` and the `Skip to role panel` target change as below. The panel label stays `team panel`.

| Selection | Panel shows |
| --- | --- |
| Nothing | **Team overview** (this section) |
| One role | **Role editor** (section 1.6) |
| An item in the Capabilities view | **Capability detail** (phase 5, 4.5) |
| Team files review requested | **Team files review** replaces the content with a `Back` button at the top (2.4) |

Selecting a role from anywhere (chart, list, problem click, "Used by" chip) switches the panel to the editor. Clicking the stage background, pressing Escape in the editor (focus returns to the node, selection stays) or `Back to team` (a ghost button at the top of the editor, `role-back-to-team`, clears the selection) shows the overview. The panel never opens on a tab the user did not choose; it opens on the overview. `panelTab` state and `PANEL_TABS` are deleted; `team-panel-tabs`, `team-panel-tab-role`, `team-panel-tab-catalog` testids go.

**Team overview content** (`TeamOverview.tsx`, testid `team-overview`), top to bottom, each block hidden when it has nothing to say:

1. Header: `Your team` (h2) and `{n} roles, {m} levels` in secondary text.
2. **Check** block: `Needs attention` heading with the top three problems from the Team check (phase 4; in phase 3 the block is omitted). Each is a button row: severity icon, wording, chevron. `Show all {n}` text button.
3. **Who can change things** block: `Can change files: Implementer, Orchestrator` and `Can run commands: Implementer` as name chips (click selects the role). Empty: `No role can change files or run commands.` This answers the question the chart cards could not (review Flow 3).
4. **Models**: chips per tier with counts: `Deep 1`, `Everyday 2`, `Fast 1` (click does nothing in phase 3; in phase 4 it filters the List view).
5. **Capabilities summary**: `{n} connections, {m} skills in use` and a text button `Open Capabilities` (phase 5; absent before). Needs-sign-in count when present: `{n} need sign-in`.
6. **Architect session pointer**: the existing `OrgChangePointer` line, here also (it is also a notice row message while the user edits).
7. **Team files strip** when `pending` or `problem`: one sentence + `Review changes` (2.4).
8. Closed disclosure `Keyboard shortcuts`: `With a role focused: Enter edits it, Delete removes it, Shift+F10 opens its menu.`
9. Empty team (root only): the block `Your team has one role.` / `Add a role to give the {RootName} someone to hand work to.` with a secondary `Add role` button (same popover) and a text button `Start from a template or import`. Opens the Start from menu.

States: loading project (skeleton lines, no spinner text); no problems (block hidden, not "0"); sizes: single column; at 1024x640 blocks 1 and 3 and 7 are visible without scrolling, others below.

### 2.2 Suggestions drawer (replaces the tray)

**Header button** (phase 3 adds it to `TeamHeader`): `Suggestions` + count badge (pending count from `useTeamReviewSummary(project.id).pendingCount`, the same number the Team tab badge shows). Toggle button (`aria-expanded`, `aria-controls`), testid `team-suggestions-toggle`. The drawer is a `FrameTray` (stacked under the stage, beside the stage only in a 1500x560 frame as `FrameTray` already decides) mounted only while open, then exit-animated by the existing `useExitPresence`. Closed by default on every visit; the choice is not remembered across visits except that a pending badge persists. Opening never moves focus off the button except into the drawer's first control; Escape closes and returns focus to the button.

Size: height `clamp(200px, 40% of the frame, 320px)`; header 40 px fixed, body scrolls. At 1024x640 the open drawer leaves the stage about 190 to 220 px (estimate, unverified), which is why it is closed by default and closes on `Close`, Escape and a second click on the button.

```
+----------------------------------------------------------------+
| Suggestions   For Reviewer                  [Suggestion settings] [x] |  header 40 px
| [Find tools and skills] [Re-check setup]                         |
| Find tools and skills asks the AI and counts toward your usage.  |
| Re-check setup is free.                                          |
| [ ] Also search outside sources (MCP Registry, anthropics/skills, GitHub) |
|     Searches the internet. Results are unverified.               |
| ---------------------------------------------------------------- |
| 3 to review for Reviewer - 11 waiting for the whole team         |
| [ Card ] [ Card ] [ Card ]    (CapabilityCard, unchanged)        |
+----------------------------------------------------------------+
```

- **Scope** is read-only text in the header: `For {role name}` when a role is selected, `For the whole team` otherwise. It follows the selection live; no select, no pin, no `Follow chart`. While a search is running, a selection change does not change the running search's scope: the header text keeps the scope the search started with and shows `Looking for {scope}` until it ends. The `scope` prop passed to the pane is the selection (`TeamScope`); the pane's `pinned` state is deleted.
- **On/off setting**: the Project settings choice (Off / Free checks / AI suggestions, `Settings > Permissions > Advanced`) stays where it is. In the drawer header a text button `Suggestion settings` (replaces the unlabelled gear; testid `team-assistant-settings` kept) opens it through `openProjectSettings`. The drawer states below say which setting applies. Which setting values exist and their exact semantics were not verified in this pass (only the comment in `TeamAssistantTray.tsx` names them); the three drawer variants below are the intended mapping, open question 4.
- **Cost sentence**: directly under the two buttons, one line each: `Find tools and skills asks the AI and counts toward your usage.` `Re-check setup is free.` Replaces the sentence far below the buttons. The AI button is `secondary` while results are open, `secondary` always (Add role owns primary on this tab); the existing logic that made it primary when no results exist is removed.
- **Outside sources** checkbox moves under the cost sentence, unchanged text and persistence.
- Buttons: `Find tools and skills` (was `Recommend tools and skills`; testid `team-recommend` kept), `Re-check setup` (testid `team-recheck`).

**States** (all inside the same drawer; `data-phase` as today):

| State | What the body shows |
| --- | --- |
| Closed | Nothing mounted. Header button badge shows pending count. |
| Open, first run, no results | `Find tools and skills for your team. I look at this repo, your computer and your library first.` (+ `{n} signals from past runs will inform the choice.` when evidence exists) and the two buttons above. |
| Open, setting is Off | `Suggestions are off for this project.` + button `Turn on in settings` (opens Project settings). The two action buttons are not shown. The header badge is hidden. |
| Open, setting is Free checks | Buttons shown; `Find tools and skills` disabled with reason text `AI suggestions are off for this project. Change this in the suggestion settings.` |
| Working | The AI button becomes `Looking...` (disabled, spinner), `Cancel` appears; progress list below with the existing rows (`Reading this repo`, etc.); Escape cancels. Header shows `Looking for {scope}`. |
| Results (proactive or recommended) | Heading `{N} to review` / `3 to review for Reviewer - 11 waiting for the whole team` (existing `resultsHeadText`), the since line, `CapabilityCard`s unchanged (top 3 with `Show all {n}` when proactive or scoped), `Gaps`, `Dismissed ({n})`, `What I looked at`. |
| No match | `Nothing matched {scope}. Add one yourself from What it can use, or describe the need to the Architect.` + `Open the Architect` (opens the Architect dialog, 1.3). |
| Error | `Banner tone="danger"` `Could not finish` + message + `Try again`, unchanged. |
| Rate-limited / partial | unchanged hint lines (`Partial results: the search stopped early.`, per-source problem lines). |
| Applied | `AppliedRow` with Undo, unchanged. After Apply the role editor (if that role is open) updates through the existing store. |

**Cards sit in the drawer unchanged.** `CapabilityCard`, `AppliedRow`, `DismissedRow`, `DismissedList`, `CapabilityGaps`, `lib/capabilities.ts` and the store `teamAssistant.ts` are not edited. The only code that changes inside `TeamAssistantTray.tsx` is: remove the `Design` tab and `DraftPanel`, remove `Tabs`, `team-mode` panes, the `For` select, `pinned`, `Follow chart`, the gear icon button (becomes the text button), and the tray head's `Team assistant` heading (becomes `Suggestions`). `data-tray-phase` becomes `results | recommend` and the chart refit rule keeps working off it.

**Entry points**: header button; role editor link `Suggest one` in an empty Connections or Skills group (opens the drawer, scope is the selected role, focus on `team-recommend`); Needs-you and the Team tab badge click (existing deep link that selects the tab opens the drawer when pending > 0 and focuses its heading); Architect dialog's `Open the Architect` from `No match`.

**Where the Design tab went**: nowhere in the tray. Section 1.3 covers the Architect. The Team tab badge continues to show suggestion count only.

### 2.3 Behaviour at the two window sizes

| | 1440x900 | 1024x640 |
| --- | --- | --- |
| Drawer | stacked under the stage, 40% of frame up to 320 px, stage about 270 to 330 px while open (estimate, unverified) | stacked, about 220 px, stage about 190 px while open; chart refits; cards collapse to the compact layout (`useFrameCompact`) with the count line expanding in place as today |
| Docked beside | only at frames of 1500x560 and up (not at either size) | n/a |
| Header button | text + badge | icon + badge, `aria-label="Suggestions, 3 to review"` |

### 2.4 Team files approval card without the tray

The approval card (`TeamFilesCard`, unchanged anatomy: Approve, Reject, scroll-to-end rule, Details in compact) moves into the **side panel as a review view**:

- Trigger: chip popover `Review changes`, the panel strip `Review changes` (2.1 block 7 and a one-line sticky strip at the top of the role editor while pending: `Team files need your approval.` + `Review changes`), and the Needs-you request (`teamFilesFocus`). Nothing opens it automatically on tab load, so a user mid-edit is not interrupted.
- The panel shows a top row `Back` (ghost, `team-files-back`) and the card below it filling the panel (its body scrolls, footer pinned). `Back` returns to what the panel showed before (overview or the selected role). Approve or Reject also returns it and puts focus on the chip.
- When state is `pending` the chip is accent-toned and the Team tab sidebar badge / Needs-you counts are unchanged.
- `Ask the Team assistant` link in the card head is deleted along with `assistantOpen` and `onToggleAssistant` (`e2e/team-files.mjs` assertions on `team-files-assistant-toggle` go).
- The card used `useFrameCompact` and `useAnnounceOnce` from `CanvasFrame` context; the side panel is outside the frame. The engineer either renders the card with a local polite region or passes `compact` as a prop (compact when the viewport is under 700 px high). Not designed further here.
- The `team-files-card` testid, `team-files-approve`, `team-files-reject`, `team-files-body` stay.

### 2.5 Removals in phase 3

`PANEL_TABS`, `panelTab`, `TeamCatalog` mount, `EmptyState "No role selected"`, `assistant` mode state, the `FrameTray` team-files branch, `assistantShown`, `team-assistant-slot`. `TeamFilesLine.tsx` is deleted once nothing imports it. `DraftPanel` is deleted after `ArchitectDialog` took its Architect part (phase 2). `TeamCatalog.tsx` stays until phase 5 replaces its content, but is no longer mounted in phase 3: **between phase 3 and phase 5 the project-level Catalog is unreachable on Team**. To avoid that gap the phases ship together, or phase 3 keeps a temporary header `Catalog` button that opens the existing `TeamCatalog` in the panel (testid `team-catalog-temp`), removed in phase 5. Recommendation: ship phase 5's matrix before or with phase 3; if not possible, use the temporary button. Open question 5.

### 2.6 Acceptance criteria (phase 3)

- [ ] The panel has no tab strip. With nothing selected it shows the team overview; clicking a node shows the role editor; clicking the stage background returns to the overview.
- [ ] The overview shows the `Can change files` and `Can run commands` blocks with the right roles on the mock team (Implementer has Edit, Write, Bash on the default team; verify against the data), and the `Models` chips add up to the role count.
- [ ] `Back to team` clears the selection; Escape in the editor returns focus to the node and keeps the selection.
- [ ] No tray is visible by default at either size; the stage is taller than before by at least the old tray height (compare to the review's 165 px).
- [ ] The header `Suggestions` button shows the pending count when there is one (the mock review gives 3) and none when zero; clicking it opens the drawer, clicking again or Escape closes it.
- [ ] With Reviewer selected the drawer header says `For Reviewer`; selecting Implementer changes it to `For Implementer`; clearing the selection changes it to `For the whole team`. There is no select and no `Follow chart` link anywhere.
- [ ] Start a search, then select another role: the header keeps the original scope until the search finishes.
- [ ] The cost sentence is directly under the two buttons. The buttons are secondary (no purple button inside the drawer).
- [ ] Mock results show the unchanged `CapabilityCard` fields (source, pin, access sentence, flags, roles). Apply, Dismiss with Undo, Restore, `Show all`, Gaps and `What I looked at` still work.
- [ ] Turn AI suggestions off in Project settings: the drawer says `Suggestions are off for this project.` with `Turn on in settings`.
- [ ] A `pending` team-files state (use `e2e/team-files.mjs` fixture): chip accent, panel strip visible, `Review changes` shows the card in the panel with Back; Approve is locked until the list is scrolled to its end as today; Approve returns to the overview and focus to the chip.
- [ ] There is no Design tab, no `Advanced: quick draft`, no gear icon.
- [ ] At 1024x640 the open drawer does not overflow the frame, the chart refits and stays visible (at least 180 px high), and cards are compact.

### 2.7 Files touched (phase 3)

Edit: `views/TeamView.tsx` (panel and tray wiring only); `components/team/TeamAssistantTray.tsx` (drawer; remove tabs, For, Follow chart, gear, Design pane); `components/team/TeamFilesCard.tsx` (remove assistant toggle, compact/announce source); `components/team/OrgChangePointer.tsx` (reused in overview, no edit unless styling); `components/team/TeamHeader.tsx` (Suggestions button); `components/RoleInspector.tsx` (sticky files strip, `Back to team`, `Suggest one` links via `RoleCapabilities.tsx`); `components/layout/SidePanel.tsx` only if the sticky strip needs a header slot (otherwise untouched); `styles/team.css`, `teamFiles.css`.
New: `components/team/TeamOverview.tsx`, `components/team/SuggestionsDrawer.tsx` (wraps the pane: header, scope text, settings link, off-state), `lib/teamOverview.ts` (pure: levels, who can change files, tier counts).
Delete: `components/DraftPanel.tsx` (after phase 2), `components/team/TeamFilesLine.tsx`, the `Tabs`-based `MODE_TABS`.

### 2.8 e2e selectors that change (phase 3)

`e2e/team.mjs` (26 hits): `team-mode-recommend`, `architect-open`, `team-scope-select`, panel tab ids go; add `team-suggestions-toggle`, `team-suggestions-drawer`, `team-scope-text`. `e2e/team-files.mjs`: card is found in the side panel (`team-files-back`), no tray label `Team files approval`. `e2e/org-change.mjs`, `e2e/proposals.mjs`, `e2e/engagement2.mjs`, `e2e/permissions.mjs` (the settings link), `e2e/layout.mjs` (panel tab strip assertions, tray stacking assertions become drawer assertions).

### 2.9 Needs main-process or contract work (phase 3)

None required. The pending count and the setting already exist. Verify the three setting values (open question 4).

## 3. Phase 4: List view and Team check

### 3.1 List view (`TeamListView.tsx`)

Enabled in the header view switch as `List`. The stage shows a toolbar row and a table. Selection is shared with the chart: clicking a row name selects the role and the panel shows its editor. Checkboxes (multi-select) are separate from selection.

```
+--------------------------------------------------------------------------------+
| [Search roles        ] [Filter v] [Sort: Chart order v]            12 of 14 roles |
| [ ] Role               Reports to  Model     Tools          Conn  Skills Delegates  Check |
| [ ] (o) Orchestrator   Top         Deep      Reads, edits... 1     2      3          -    |
| [ ] (o)  Implementer   Orchestrator Everyday  Changes files   0     1      0          !    |
+--------------------------------------------------------------------------------+
```

Columns (container width >= 720 px; narrower collapses, below):

| Column | Content | Sort | Notes |
| --- | --- | --- | --- |
| Select | checkbox; header checkbox selects all visible | | `aria-label="Select {name}"` |
| Role | avatar, name, indented by depth when sorted by `Chart order`; second line (11 px, secondary) the description clamped to one line | A to Z | Click selects (and opens the editor). |
| Reports to | manager name, `Top` for the root | A to Z | |
| Model | tier chip (`Top`, `Deep`, `Everyday`, `Fast`, `Same as manager`) | by tier rank | |
| Tools | summary words, same wording as 1.6: `Reads files`, `Changes files`, `Runs commands`, `Browses the web` (up to two, then `+n`), elevated in warning color | by risk (none, read, change, run) | |
| Connections | count (`2`), `Needs sign-in` badge when any is unsigned | numeric | |
| Skills | count | numeric | |
| Delegates to | count of delegable direct reports | numeric | |
| Check | icon only: error (danger), warning (warning), none; click opens that role's first problem | severity | `aria-label` carries the wording |

- **Default sort**: `Chart order` (depth-first from the root, siblings by position then name). Header click cycles ascending, descending, back to chart order; the current sort shows in the `Sort` menu text and the header chevron. Sorting never renames or reorders roles in the data.
- **Search** (`Search roles`, `team-list-search`): matches name, description, slug and model tier, case-insensitive, substring; 150 ms debounce. Shows `{n} of {m} roles`. No match: `No role matches "{text}".` with `Clear search`.
- **Filter** (popover with checkbox groups, `team-list-filter`): `Model` (Top, Deep, Everyday, Fast, Same as manager), `Can` (Change files, Run commands, Delegate), `Uses` (A connection, A skill, Nothing), `Problems` (Has problems), `Branch` (a select of roles: only that role and the roles below it). Active filters show as removable chips under the toolbar row (`Model: Fast x`); `Clear filters` text button. Filter and search combine with AND.
- **Empty states**: one role only: `Your team has one role. Add a role to see it compared here.` + Add role. Filters match nothing: `No role matches these filters.` + `Clear filters`.
- **Multi-select**: click checkboxes; Shift-click selects a range in the current order; header checkbox selects all visible, shows mixed state; Escape clears the multi-selection when focus is in the table. A bulk bar replaces the filter chips row (in flow, not floating; the table scrolls under it) while at least one row is checked:

```
3 selected   [Set model v] [Tools v] [Duplicate]   [Clear]
```

  - `Set model`: menu `Top`, `Deep`, `Everyday`, `Fast`. Sets `tier` and `model` through the same `modelForTier` mapping a single role uses; roles on `inherit` change to the tier too. Roles whose connection has no model for that tier are skipped and the notice says so: `Set 2 roles to Fast. Skipped Researcher: its connection has no Fast model.`
  - `Tools`: popover with the five plain-language groups from 1.6. Each shows `On for all`, `Mixed` (mixed checkbox) or `Off for all` across the selection. Clicking a group sets it on or off for every selected role. A confirmation line appears inline when the change turns `Change files` or `Run commands` on for roles that do not have them: `This lets {n} roles change files.` with `Apply` and `Cancel`. Turning groups off applies at once.
  - `Duplicate`: enabled only when exactly one role is checked (tooltip when disabled: `Select one role to duplicate it.`).
  - Result notice (notice row): `Set 3 roles to Fast.` / `Changed the tools of 3 roles.` with `Undo` (one undo restores all affected roles; implemented as a roles snapshot taken before the batch, valid until the next edit or 12 s, whichever is first).
- **Duplicate role** (also in the role editor header as a `Duplicate` button next to `Remove`, and in the chart context menu `Duplicate role`): creates `{Name} copy` (next free: `{Name} copy 2`), same manager, same description, instructions, responsibilities, tools, model, tier, effort, staffing, color (next color in the palette), same connection and skill grants, same delegation toggle; **no reports and no delegation targets** (a duplicate does not take over the original's reports). Placement next to the original (non-overlapping). Selected after creation; focus on `Name` with the text selected. Notice: `Duplicated {name}.` with `Undo`. Root cannot be duplicated (the menu item is disabled with `The top role cannot be duplicated.`).

**Narrow layout** (container under 720 px, which is 1024x640 with the panel open): columns Connections, Skills and Delegates to merge into one `Uses` column showing `2 conn., 3 skills` (the word `connections` spelled out when room allows) and `Delegates to` is dropped to the editor. `Reports to` and `Model` remain. The table scrolls horizontally only below 520 px (not expected at the supported sizes). Row height 36 px (compact 32 px at under 480 px frame height).

Keyboard: the table is a `table` with `role="grid"`-free native semantics; rows reachable by Tab through their name button and checkbox; Space toggles the checkbox, Enter opens the editor; Escape clears multi-select. (Existing keyboard paths unchanged; not a focus of this spec.)

### 3.2 Team check (`lib/teamCheck.ts`, pure; `TeamCheckPopover.tsx`, `TeamCheckList.tsx`)

Computed locally on every project change from the project, the app store's model catalogs and the cached `mcp:list` result. No AI call, no spend, no network. The result is a sorted list of problems.

**Header chip**: `No problems` (neutral, check icon) when there are no errors or warnings; `{n} to check` (warning tone, `TriangleAlert`) with warnings only; `{n} to fix` (danger tone) when any error exists, where `n` counts errors plus warnings. Notes never change the chip. The chip opens a popover (width 380 px, max height 60% of the frame, scroll) with the list; each row is a button. The same list renders in the team overview (top three) and, as a column, in the List view.

Severity meanings: **error** = a run would fail or a rule would be broken; **warning** = likely not what the user wants; **note** = informational, shown only in the popover under a `Notes` heading and never counted.

| id | Severity | Trigger (local) | Wording (`{x}` filled) | Click does |
| --- | --- | --- | --- | --- |
| `no-root` | error | no role with `reportsTo === null` | `The team has no top role.` | Opens Start from menu. |
| `many-roots` | error | more than one role with `reportsTo === null` | `{n} roles have no one to report to: {names}.` | Selects the first, focuses Reports to. |
| `orphan` | error | `reportsTo` points at a missing role | `{Role} reports to a role that no longer exists.` | Selects the role, focuses Reports to. |
| `required-not-delegable` | error | id in `requiredReports` missing from `spawnable`, or its manager has `canSpawn` false | `{Role} must use {Report} but cannot delegate to it.` | Selects the role, opens `Who it can delegate to`, focuses the row. |
| `duplicate-slug` | error | two roles share a slug | `{A} and {B} share the ID {slug}. Runs cannot tell them apart.` | Selects the second, opens `Details`, focuses `ID used in team files`. |
| `report-not-delegable` | warning | direct report not in the manager's `spawnable`, or manager `canSpawn` false while it has reports | `{Manager} cannot delegate to {Report}, which reports to it.` | Selects the manager, focuses the report's row in the delegation list. |
| `delegate-without-reports` | warning | `canSpawn` true and no direct reports and no cross-branch targets | `{Role} can hand work to others but has nobody to hand it to.` | Selects the role, focuses `Can hand work to other roles`. |
| `no-description` | warning | description empty or the seeded placeholder | `{Role} has no description. Managers use it to choose who to hand work to.` | Selects the role, focuses `What is this role for?`. |
| `no-tools` | warning | role has zero tools and zero connections | `{Role} has no tools or connections, so it can only answer from what it is told.` | Selects the role, opens the tools editor. |
| `needs-sign-in` | warning | a connection granted to the role has unset secrets (the same `perProjectState(...).missingCount > 0` rule `RoleCapabilities` uses) | `{Role} uses {Connection}, which needs sign-in.` | Calls `openConnectorSetup` for it (App settings > Connectors) with the Back to Team affordance. |
| `model-unavailable` | warning | role model not in the connection's loaded catalog (skipped while the catalog is not loaded) | `{Role} uses a model that {Connection} does not offer: {model}.` | Selects the role, focuses the Model select. |
| `duplicate-name` | warning | two roles with equal names (case-insensitive) | `Two roles are called {name}.` | Selects the second, focuses Name. |
| `default-name` | note | name equals `New role` or `New role N` | `{Role} still has its default name.` | Selects the role, focuses Name. |
| `cross-branch` | note | a role delegates to a role that is not its descendant | `{A} can delegate to {B} on another branch.` | Selects `{A}`, opens `Roles on other branches`. |
| `lonely-team` | note | one role in total | `The team has one role. Add a role to give it someone to delegate to.` | Opens Add role. |

Sorting: errors, warnings, notes; within a severity by role depth then name. A problem about two roles counts once. Clicking a row closes the popover (not the overview), selects the role (expanding any collapsed branch that hides it, 4.4) and moves focus to the named field; if the field is in a folded section the section opens. In the List view the `Check` column icon opens the same popover filtered to that role.

States: loading (a project with no roles loaded): chip hidden; no problems: popover is not offered (the chip is a non-interactive neutral chip); problems: the list. The popover heading is `Team check`; footer text `Checked on this computer. Nothing is sent anywhere.`

### 3.3 Acceptance criteria (phase 4)

- [ ] Header switch shows `Chart | List`; choosing `List` keeps the selected role selected, and the panel shows its editor. The choice survives a reload and is per project.
- [ ] Add 10 roles (use Add role repeatedly); the list shows 11 rows; search `New role 7` leaves one row; clearing restores all; the count reads `1 of 11 roles` then `11 roles`.
- [ ] Filter `Can: Run commands` shows only roles with Bash; the removable chip clears it; `Problems: Has problems` shows only roles with a Check icon.
- [ ] Sorting by `Model` orders Deep, Everyday, Fast (Top first when present); `Chart order` puts every report under its manager with indentation.
- [ ] Check three roles; the bulk bar shows `3 selected`; `Set model > Fast` sets all three (each node's chip in the chart reads Fast); the notice row offers Undo and one Undo restores all three tiers.
- [ ] Bulk `Tools`: with one role having Bash and two not, `Run commands` shows `Mixed`; turning it on for all shows the inline confirmation `This lets 2 roles run commands.`; Apply sets Bash on all three.
- [ ] `Duplicate` is disabled with two checked; with one checked it creates `{Name} copy` with the same tools, model, skills and connections, no reports, same manager; the editor opens with the name selected.
- [ ] Root cannot be duplicated.
- [ ] Team check on a seeded project: set a role's description to empty and a non-delegating manager with a report: chip reads `2 to check`; popover lists both with the wording above; clicking `no-description` selects the role and focuses `What is this role for?`; clicking `report-not-delegable` focuses the report's row.
- [ ] Create a cycle-free orphan via a hand-edited project file (or unit test the pure function): `orphan` shows as error and the chip reads `to fix`.
- [ ] Notes do not change the chip: a team with only `New role` names still reads `No problems`.
- [ ] At 1024x640 with the panel open the list shows `Uses` instead of three columns and no horizontal scrollbar; at 1440x900 all columns show.
- [ ] No network or IPC call is made by computing the check (assert via the preload mock: no `capabilities:*` calls on chip render).

### 3.4 Files touched (phase 4)

New: `components/team/TeamListView.tsx`, `TeamListToolbar.tsx`, `TeamBulkBar.tsx`, `TeamCheckPopover.tsx`, `TeamCheckList.tsx`, `lib/teamCheck.ts` (+ `.test.ts`, covers every id), `lib/roleBulk.ts` (+ test: bulk tier, bulk tool groups, snapshot undo), `lib/roleDuplicate.ts` (+ test), `lib/teamListModel.ts` (rows, sort, filter, search; + test).
Edit: `views/TeamView.tsx` (view switch mount, selection wiring); `components/team/TeamHeader.tsx` (live chip, switch); `components/team/TeamOverview.tsx` (check block, tier chips filter into List); `components/RoleInspector.tsx` (Duplicate button); chart context menu in `TeamView.tsx` (`Duplicate role`); `styles/team.css`.

### 3.5 e2e selectors (phase 4)

`e2e/team.mjs`: new section for List view, check popover, bulk edit, duplicate. New ids: `team-list`, `team-list-row` (`data-role-id`), `team-list-search`, `team-list-filter`, `team-list-sort`, `team-list-select-all`, `team-list-select` (per row), `team-bulk-bar`, `team-bulk-model`, `team-bulk-tools`, `team-bulk-duplicate`, `team-check-popover`, `team-check-row` (`data-id`, `data-severity`), `role-duplicate`, `role-menu-duplicate`. `e2e/layout.mjs` (list at both sizes).

### 3.6 Needs main-process or contract work (phase 4)

None. All inputs exist in the renderer. The `model-unavailable` check depends on the model catalogs the renderer already loads; skip the check while a catalog is absent.

## 4. Phase 5: Capabilities matrix and chart

### 4.1 Capabilities view (`TeamCapabilitiesView.tsx`)

Enabled in the header switch as `Capabilities` (third option). It fills the stage. The side panel stays beside it (overview or editor of the selected role, or the item detail, 4.5).

```
+----------------------------------------------------------------------------------------------+
| [Search items   ] [Show: Skills Connections Plugins v] [Roles shown: 8 of 14 v]   [+ Add v]    |
|                                          Orch  Impl  Revw  Rsch  Docs  QA    Ops   Sec  ...   |  sticky header
| SKILLS                                    (o)   (o)   (o)   (o)   (o)   (o)   (o)   (o)       |
| code-review        Project skill   --      [x]    [ ]   [x]   [ ]   [ ]   [ ]   [ ]   [ ]       |
| write-tests        Your library    --      [ ]    [x]   [ ]   [ ]   [ ]   [ ]   [ ]   [ ]       |
| CONNECTIONS                               ...                                                   |
| GitHub  Can read   Needs sign-in   [on]    [x]   !x!   [x]   ...                                |
| PLUGINS                                                                                          |
| docs-plugin        Project         [on]    (project wide, no role columns)                      |
+----------------------------------------------------------------------------------------------+
```

- **Rows**: three sections with sticky section headings (`Skills`, `Connections`, `Plugins`), items listed by name. Row left block: name, below it the kind/source in 11 px secondary (`Skill - Your library`, `Connection - Curated`, `Plugin`), and access for connections (`Can read` or `Can read and change`).
- **Columns**: first sticky column (item, 220 px at 1440x900, 180 px at 1024x640), second sticky column `On` (56 px) with the project-level switch for connections and plugins and a `No role can load this` badge for a skill nobody has (`loadableByNoRole`), then one column per role in chart order, 72 px each. Role column header: avatar with initials, name truncated to 8 characters plus ellipsis (full name in `title` and `aria-label`), click selects the role (opens its editor in the panel). The selected role's column is highlighted (`--surface-2`).
- **Cell states** (each cell is a toggle button, `role="switch"`-style checkbox, 28 px target in a 36 px row):

| State | Cell shows | Meaning | Click |
| --- | --- | --- | --- |
| Granted | filled check in an accent chip | the role may use it | Revokes (same call the role editor uses). |
| Not granted | empty bordered box | | Grants. |
| Granted, needs sign-in | check chip with a warning dot, `title`/label `{Connection} needs sign-in` | the connection has unset secrets | Revokes on click; the row's `Sign in` action (below) fixes it. |
| Granted, needs values | check chip with warning dot, label `{Connection} needs values` | `perProjectState(...).missingCount > 0` | same |
| Project-off | cell dimmed, check kept, label `Off for this project` | row's `On` switch is off | Toggle still works; takes effect when the row is turned on. |
| Pending | spinner in the cell | the grant call is running | disabled |
| Error | danger dot, label `Could not save. Try again.` | call failed | Retry on click; the error text also goes to the notice row |
| Not applicable | a muted `-` | plugin rows (project-wide) | none |

- **Row actions**: a `More actions` button at the end of the first column (menu): `Edit`, `Sign in` (connections that need it; goes to `openConnectorSetup`), `Promote to library`, `Unlink`, `Remove`, each the existing action from `SkillsSection`/`McpSection`. A row needing sign-in or values shows a small `Sign in` / `Fill in` button inline in the first column (testids `matrix-sign-in`, `matrix-fill-in`).
- **Search / filter**: search matches item name and source; `Show` multi-select of the three sections; `Problems only` toggle shows rows with needs-sign-in or needs-values or `No role can load this`.
- **Adding an item**: `+ Add` menu in the matrix toolbar: `Add a skill`, `Add a connection`. Each opens the existing `CapabilityChooser` without a role (project scope; `Your connections / Browse / Ask` tabs and `This project / Your library / On this computer / Found in this repo / New skill`). After adding, the new row appears with every cell empty, scrolls into view, takes focus on its first cell, and the notice row says `Added {name}. Choose who can use it.` (a connection that needs sign-in also shows the inline `Sign in`). If the chooser was opened from a selected role's column header menu `Add to {Role}` the grant is applied to that role (optional; omit if it complicates the chooser: open question 6).
- **Beyond about 8 roles**: the matrix scrolls horizontally with both left columns and the header row sticky; 8 role columns fit at 1440x900 with the panel open and about 4 at 1024x640 (estimates, unverified). `Roles shown` menu (checkbox list with `All roles`, `Only the selected role's branch`, and each role) limits the columns; the default shows all. Role headers at 12 or more roles drop to avatar only with name in `title`. Rows beyond 12 add vertical scroll with the header sticky; no virtualization needed below about 200 cells visible (14 roles x 14 rows).
- **Empty states**: no items at all: `Nothing to grant yet.` / `Skills and connections you add appear here, with one column per role.` + buttons `Add a skill` (secondary), `Add a connection` (secondary) and text link `Suggest some` (opens the drawer, scope whole team). Filter with no match: `No item matches.` + `Clear`.
- **Loading**: skeleton rows (three per section) while `skills.list` and `mcp.list` are pending. Error loading: `Banner tone="danger"` `Could not load capabilities` + `Try again`.
- **Footer legend** (notice row right slot): `Legend` popover: `Check: the role can use it`, `Warning dot: needs sign-in or values`, `On: the whole project can use it`.

### 4.2 Capability detail in the panel (item selected)

Clicking an item name in the matrix selects the item (not a role); the panel shows `CapabilityDetail`: item name, kind and source badges, `Used by` role chips (click selects that role), the `On` switch, the existing details and edit form mounted from `McpSection` / `SkillsSection` through a new prop that restricts them to one item (`onlyId`). Back returns to the overview. Selecting a role column clears the item selection.

### 4.3 Deep links that opened the Catalog

Today `openProjectMcp(projectId, serverId?, {edit?})` sets `mcpFocus`, `TeamView` switches the panel tab to Catalog and `McpSection` scrolls to and focuses the row. Callers: `McpAuthNotice`, `RoleCapabilities` (Fill in), `TeamAssistantTray` finishSetup, `SetupGaps`, `RunMeta`, `RoleServices`, `McpLibrarySection`, `AppSettingsView` (back link).

New behaviour, same function name and signature (so callers do not change):

1. Sets the project view to Team and the Team view to `Capabilities` (stored per project).
2. Scrolls the matrix to the item's row, highlights it for 2 s (`data-highlight`, token `--accent-subtle`, no motion under reduced motion), and puts focus on the row's primary action: `Sign in` or `Fill in` when it needs one, otherwise the row name button.
3. With `{edit: true}` it also selects the item so the panel shows its edit form focused on the first unset variable (as `McpSection` does today).
4. If the server id is unknown (removed): the matrix opens and the notice row says `That connection is no longer in this project.`
5. `requestSkillLibrary()` is unchanged. The temporary `team-catalog-temp` button (2.5) and `TeamCatalog.tsx` are deleted.
6. Any caller that expects the panel's Catalog tab (`team-panel-tab-catalog`) is updated; `e2e/connectors.mjs`, `e2e/skills.mjs` and `e2e/connections.mjs` navigate with `openTeamView(page, 'Capabilities')`.

### 4.4 Chart changes (`RoleNode`, `TeamView.tsx`, `lib/canvas*`)

**One fixed node style.** Team stops reading the shared canvas options. Values used by Team: node style `card`, edges `smoothstep` (the Default style's resolved values; the engineer copies them from `useCanvasOptions` defaults and does not change the shared defaults), presentation `graph`, layout direction from the Team control. Card box 220 x 112 (was 96; the extra row holds the new line). `ROLE_NODE_SIZE.card` is the only size Team uses; `roleNodeSize` is no longer called by Team.

**Card content** (`RoleNode`, Team variant `data-team="true"`), top to bottom:

1. Avatar, **name** (14 px semibold, one line, ellipsis), tier chip at the right (`Deep`, `Everyday`, `Fast`, `Top`; `Same as manager` shows `Inherits`).
2. **Description**, one line, clamped, 12 px `--text-secondary` (empty or placeholder: `No description yet` in `--text-tertiary` italic).
3. **Chip row** (11 px, icon plus number, each with a `title` and in the node's `aria-label`): `Tools` (icon `Wrench`, number of tools; warning-colored with `TriangleAlert` text label `Changes files` / `Runs commands` replaced by icon only when the card is narrower than 200 px), `Connections` (`Plug`, `2`), `Skills` (`BookOpen`, `3`), `Delegates to {n}` (`Share2`, hidden at 0). A connection that needs sign-in puts a warning dot on the `Plug` chip. Zero counts are omitted except Tools. Order is fixed so columns line up across cards.
4. Collapse button (4.4 below) at the bottom center on a role with reports: `ChevronUp` (collapse) / `ChevronDown` + `+{n}` (collapsed).

`aria-label` (used for the node): `{name}, {role|top role}. {n} tools, {c} connections, {s} skills. Delegates to {d}.` plus the existing Enter and Delete sentence. Tooltips on chips use the review's good wording: `Can change files or run commands: Edit, Write, Bash`.

**Edges**: one neutral stroke (`--canvas-edge-ink` mixed as the Default style does) for every reporting line, no per-child color (the color-by-child behaviour was undiscoverable and relies on node colour); the child's avatar color remains on its card. Delegable edges are solid with an arrow; non-delegable are dashed with the label `Cannot delegate` at 11 px in `--text-secondary` on `--surface-1` (was 9 px visual and low contrast).

**Legend** (notice row, right; a `Legend` popover button, icon `Info`, testid `team-legend`; closed by default; visible only in the Chart view):

```
Solid line with arrow    Reports to, and can delegate to
Dashed line              Reports to, but cannot delegate to
Triangle                 Can change files or run commands
Plug                     Connections the role can use
Book                     Skills the role can use
Delegates to N           Roles it can hand work to
```

**Branch collapse**: a role with at least one report shows a collapse button. Collapsing hides every role below it (nodes and edges) and shows `+{n} below` on the card. State is local UI state per project in `localStorage` key `orgai.teamCollapsed.<projectId>` (array of role ids); it never changes data. Layout treats a collapsed branch as one node. Any action that selects a hidden role (list click, problem click, deep link, search) expands the collapsed ancestors first. `Collapse all` and `Expand all` are items in the Layout menu (shown only when there are 8 or more roles). Collapsing re-fits the chart if the visible tree no longer fills the stage.

**Re-layout after add, re-parent and remove** (replaces the "press Auto-layout" gap):

| Action | What moves | Viewport |
| --- | --- | --- |
| Add role (phase 1 placement, then this rule) | The new role is placed in the next free slot under its parent in the Team layout direction without moving other roles; siblings are not re-spaced unless two would overlap. | If the new node is not fully inside the viewport, pan (no zoom change, `setCenter` with the current zoom) to center it; if the whole chart now fits at a zoom below 1, do nothing else. |
| Re-parent (select, drag, drop-anywhere) | Only the moved role and its subtree are laid out under the new manager (the same slot rule); the old branch is not re-spaced. | Pan to keep the moved role visible; it stays selected. |
| Remove | The removed role's reports (now under its manager) are laid out under the manager; remaining roles stay. | None. |
| `Arrange automatically` | Everything, with the existing glide, then fit. | Fit with padding 0.3. |
| Layout direction change | Everything re-laid out for the new direction, then fit. | Fit. |

A user-dragged position is kept until `Arrange automatically` or a direction change. Reduced motion: no glide, positions set at once. The existing `beginCanvasGlide`, `fitMs`, `refitMs` and `useNodeArrival` stay.

**Empty chart**: a project with zero roles shows the `EmptyState` `Your team has no roles.` / `Add the first role, or start from a template or import.` with `Add first role` (primary replaces nothing: the header Add role is the primary; the empty state button is secondary) and `Start from`.

### 4.5 Behaviour at the two window sizes (phase 5)

| | 1440x900 | 1024x640 |
| --- | --- | --- |
| Chart | Cards 220 x 112 at zoom 1 for up to about 6 roles across; the legend popover in the notice row. | Same card; the chart fits to about 0.7 for the default team; collapse is the answer for large teams (a 14-role team at about 0.4 would be unreadable, so `Collapse all` is offered). |
| Capabilities | About 8 role columns visible, first column 220 px. | About 4 role columns visible, first column 180 px; `Roles shown` offers `Only the selected role's branch`. The panel may rail to widen the matrix. |
| List | all columns | `Uses` merged column |

### 4.6 Acceptance criteria (phase 5)

- [ ] On the Team tab no node style other than the fixed card can be chosen; there is no Canvas style control and no Pocket Office; Live's canvas style and App settings still work (spot check `e2e/canvas.mjs`).
- [ ] Every card shows name, tier chip, one description line and the chip row. A role with 2 connections and 3 skills shows `2` and `3`; a role with Bash shows the warning `Runs commands` indication; a role with no connections or skills shows only Tools.
- [ ] Reduce motion and both themes: card text contrast is readable at 100% zoom (spot check); `Cannot delegate` label is legible at 11 px.
- [ ] Add a report under a leaf: the new card does not overlap another; if it is off screen the viewport pans to it and zoom is unchanged.
- [ ] Re-parent a role with two reports to another branch (select and drag): the role and its two reports move under the new manager; other roles do not move; no manual Auto-layout is needed.
- [ ] Remove a role with reports: its reports sit under its manager without overlapping.
- [ ] Collapse a branch: its roles and edges vanish, the card shows `+N below`, reload keeps it collapsed; clicking one of its roles in the List view expands it and selects it on the chart.
- [ ] The legend popover lists the six entries and matches what the chart shows.
- [ ] Capabilities view: the default team shows rows for the project's skills and connections (seed one of each via the mock), one column per role, granted cells match the Role editor's lists exactly (toggle a cell, open that role in the editor: the same item appears or disappears; toggle in the editor, the cell changes).
- [ ] A connection with an unset secret shows the warning dot in granted cells and an inline `Sign in`; pressing it opens App settings > Connectors on that connection with `Back to Team` returning to the Capabilities view.
- [ ] `openProjectMcp(projectId, serverId)` from `McpAuthNotice` (trigger by a run needing sign-in, or the e2e helper) lands on Team > Capabilities, scrolls to the row, highlights it and focuses its primary action.
- [ ] `+ Add > Add a skill` adds a project skill; the new row has empty cells, is focused, and the notice row says `Added {name}. Choose who can use it.`
- [ ] With 14 roles the matrix scrolls horizontally, the first two columns and the header stay visible, `Roles shown > Only the selected role's branch` limits the columns.
- [ ] A plugin row shows `-` in role columns and a project switch in `On`.
- [ ] No `TeamCatalog` mount or `team-catalog-temp` button remains.

### 4.7 Files touched (phase 5)

New: `components/team/TeamCapabilitiesView.tsx`, `CapabilityMatrix.tsx`, `CapabilityCell.tsx`, `CapabilityDetail.tsx`, `TeamLegend.tsx`, `lib/capabilityMatrix.ts` (+ test: rows, cell state from grants and server state), `lib/teamCollapse.ts` (+ test), `lib/teamLayoutOps.ts` (+ test: slot placement for add, subtree layout for re-parent and remove).
Edit: `views/TeamView.tsx` (view switch third option, fixed options, collapse, re-layout calls, remove `TeamCatalog` and temp button); `components/RoleNode.tsx` (Team variant, chip row, collapse button); `components/team/CapabilityChooser.tsx` (project scope without a role; `role` optional); `components/mcp/McpSection.tsx`, `components/skills/SkillsSection.tsx` (`onlyId`, matrix-safe actions; no behaviour change otherwise); `store/useAppStore.ts` (`openProjectMcp` retarget: Team view `Capabilities`, highlight request; `mcpFocus` consumer moves from `TeamView` panel tab to the matrix); `components/mcp/McpAuthNotice.tsx` (no edit expected; verify), `components/dashboard/SetupGaps.tsx`, `components/RunMeta.tsx`, `components/connectors/RoleServices.tsx`, `views/AppSettingsView.tsx` (verify the deep link text and `Back to Team` target only); `lib/canvas.ts` (Team uses a fixed `TEAM_CANVAS` const; shared options untouched); `styles/team.css`, `canvas.css`, `mcp.css`.
Delete: `components/team/TeamCatalog.tsx` (with the temporary button).

### 4.8 e2e selectors (phase 5)

`e2e/connectors.mjs`, `e2e/skills.mjs`, `e2e/connections.mjs`: any step that clicks `team-panel-tab-catalog` or reads `team-catalog` now uses the `Capabilities` view and `matrix-*` ids; the `skills-section`, `skill-row`, `skill-add-library`, `skill-new`, `mcp-add-service`, `connected-service-row` ids stay on the components when mounted in `CapabilityDetail` or the chooser. `e2e/team.mjs`: card chips, legend, collapse, re-layout, matrix toggles. `e2e/canvas.mjs`: Team no longer offers canvas styles (assert absent). `e2e/layout.mjs`: matrix and chart at both sizes. New ids: `team-capabilities`, `matrix-row` (`data-item-id`, `data-kind`), `matrix-cell` (`data-role-id`, `data-state`), `matrix-on` (project switch), `matrix-search`, `matrix-roles-shown`, `matrix-add`, `matrix-sign-in`, `matrix-fill-in`, `matrix-more`, `capability-detail`, `team-legend`, `node-collapse` (per node), `node-chip-tools`, `node-chip-connections`, `node-chip-skills`, `node-chip-delegates`.

### 4.9 Needs main-process or contract work (phase 5)

- None required for the matrix: grants use `skills.update`, `mcp.upsert`, `mcp.linkLibrary`, the calls the Role editor already uses; project-level on/off uses the existing calls from `McpSection` and `PluginsSection`. A bulk "grant to several roles" call would reduce round trips but is not needed (one cell is one call).
- Plugins are project-wide today; per-role plugin grants do not exist. The matrix shows them as `On` only. If per-role plugins are ever wanted that is a contract change (not proposed).

## 5. Cross-phase summary

### 5.1 Merge order and conflicts

Order: 2, then 3, then 4, then 5. Phases 4 and 5 can run in parallel after 3 if both limit `TeamView.tsx` to their mount lines; `TeamHeader.tsx` is edited by 2, 3 and 4 (live chip) in sequence. `RoleInspector.tsx` is owned by 2, with a one-button addition in 4. `styles/team.css` is shared: each phase appends its own labelled block.

| File | P2 | P3 | P4 | P5 |
| --- | --- | --- | --- | --- |
| `views/TeamView.tsx` | yes | yes | mount | yes |
| `components/RoleInspector.tsx` | yes | strip | Duplicate | |
| `components/team/TeamHeader.tsx` | new | button | chip live, switch | switch |
| `components/team/TeamAssistantTray.tsx` | | yes | | |
| `components/RoleNode.tsx` | | | | yes |
| `components/team/TeamCatalog.tsx` | | unmounted | | deleted |
| `store/useAppStore.ts` | | | | `openProjectMcp` |

### 5.2 Everything that needs main-process or shared-contract work

1. **Preview final prompt** (phase 2): main-process assembly of the final prompt, exposed read-only. Not designed here.
2. **Template reporting structure** (phase 2, optional): `OrgTemplateInfo` gains reporting lines (or a `roles` array with parent index) so the preview can draw a tree. The flat list ships without it.
3. **Verify `teamFiles:commit` never pushes** (phase 2) before using the sentence `Nothing is pushed.` Not a contract change.
4. No change to `Role`, `Project`, IPC or run contracts is required by phases 3 to 5. Phase 1's delegation defaults and the delegable-report count are assumed.

### 5.3 What was not verified

- The pixel sizes and the stage heights quoted (estimates from the review and the code, not measured).
- The three Team-assistant settings values and their effect on the drawer (open question 4).
- That removing the quick draft and the Design tab leaves no other caller of `DraftPanel` (grep before deleting).
- That `useFrameCompact` and `useAnnounceOnce` inside the side panel behave (2.4).
- Contrast of the new chips in light theme at 1024x640; run the screenshots in both themes in the phase's walkthrough.
- Whether the analysis document (`outputs/team-tab-overhaul.md`) said anything that conflicts with sections 1 to 4 here.

## 6. Open questions

Each lists my recommended answer; none blocks starting phase 2.

1. **Retire the name "Team assistant" on the Team tab?** I could not settle this from the material: `team-tab.md` made it the single AI name. Recommendation: yes, use `Suggestions` for the drawer and `Architect` for the redesign flow, update `team-tab.md` section 1 when phase 3 lands, and rename the Project settings label from `Team assistant: AI suggestions` to `Suggestions` in the same change.
2. **Where is the Team layout direction stored?** Canvas options (`layout`) are shared with Live. Recommendation: Team keeps its own value in `localStorage` (`orgai.teamLayout`, `top-down` or `left-right`, default `top-down`), independent of Live; radial is not offered on Team.
3. **Remove confirm.** The review called the confirm plus undo double protection but no decision was recorded. Recommendation: no confirm when the role has no reports (undo covers it); keep the confirm when it has reports because they move.
4. **Exact meaning of the Off / Free checks / AI suggestions setting.** Only a comment names them. Recommendation: Off hides the badge and the drawer buttons, Free checks allows `Re-check setup`, AI suggestions allows both; confirm against `Settings > Permissions > Advanced` before building the three drawer variants.
5. **The gap between phases 3 and 5 (no Catalog on Team).** Recommendation: ship 3 and 5 in one release, or keep the temporary `team-catalog-temp` header button until 5 lands.
6. **Add to a role from a matrix column header** (the chooser with a role). Recommendation: omit in the first build; the role editor already does it.
7. **Rename the card chip `leads N` to `Delegates to N`.** Phase 1 keeps `leads`. Recommendation: rename in phase 2 so the tab uses one word for delegation; the engineer must also update any e2e text match for `leads`.
8. **Does the first-visit hint need to appear per project or once per app?** Recommendation: once per app (`orgai.teamHintSeen`), because the teaching is about the screen, not the project.
9. **Bulk model change on `inherit` roles.** Recommendation: set an explicit tier on them (as written in 3.1) and say so in the notice only when any role was on `inherit`: `{n} roles that followed their manager now have their own model.`
10. **Capabilities matrix default roles shown on teams over 12 roles.** Recommendation: all roles, horizontal scroll, with `Only the selected role's branch` one click away; revisit after a walkthrough on 14 roles.
