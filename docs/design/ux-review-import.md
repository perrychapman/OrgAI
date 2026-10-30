# UX review: project import assistance (pre-feature)

Walked the built app on mock data (`ORGAI_MOCK=1`, fresh temp `ORGAI_DATA_DIR`) as a first-time user. Fixture: a git repo with `.claude/agents/backend-dev.md` (tools Read, Edit, Bash, WebFetch; model `claude-3-5-sonnet-20241022`), `.claude/agents/reviewer.md` (tools Read, Grep; model `opus`) and `AGENTS.md`.
Scope and limits: one size (about 1424x881) in the dark theme, mouse only. The driver cannot resize or switch theme, so the 1024x640 / 1600x1000 / light / keyboard passes were not done. The findings are about information and placement, not pixel layout. No repo files were changed by the app.
Screenshots (temp dir, not committed), all in `C:\Users\chapp\AppData\Local\Temp\ximp\shots\`:
`i03-form-noarchitect.png`, `i04-created-noarchitect.png`, `i05-orgchart.png`, `i10-form-architect.png`, `i11-setup-running.png`, `i12-setup-later.png`, `i20-connection.png`, `i21-role-editor.png`.

## What a user sees today (the baseline the feature must change)

1. New project > "Existing repository" (`i03`). The path check line says only "Git repository found." The hint says "The Architect scans it and reads the code before proposing anything." Nothing mentions the two agent files already in the folder.
2. Architect off (`i04`, `i05`). The project is created and lands on the Org chart with the generic default chart: Orchestrator (opus), Implementer, Reviewer, Researcher (sonnet). The fixture's `reviewer` (opus, Read+Grep) is silently ignored, and a default "Reviewer" with a different prompt and model takes its slug. `backend-dev` appears nowhere. There is no sign anything was found, skipped or could be imported.
3. Architect on (`i11`, `i12`). Lands on Live with a setup run. The first Architect line is generic ("I will look at the repository first, then propose the architecture") and the first ask is a permission card for `git status`. The Architect never names `.claude/agents`. The real profiler (`src/main/setup/profile.ts`) lists `AGENTS.md` and `CLAUDE.md` as docs to read, skips `.orgai`, and has no notion of agent files. The Architect would therefore propose a chart that ignores or contradicts them.
4. Connection pane (`i20`). Project Settings > Connection shows three provider cards, "4 roles use this connection · Everyday tier: sonnet", and the mock toggle. It shows tiers but never lists what model each role gets.
5. Role editor (`i21`). Model is a select of `fable · Top`, `opus · Deep`, `sonnet · Everyday`, `haiku · Fast`, "Inherit from parent", with a "Tier: Everyday" chip. A foreign id such as `claude-3-5-sonnet-20241022` or `gpt-4o` has no place in this list.
6. Model change feedback exists only as `RemapNotices` (a Banner at the top of the project settings and org chart column, `remap-notice` with per-role `from -> to` rows, an "Inherit" warning for unmapped, per-project Undo, Dismiss) and `RemapPreviewDialog` (read-only list before a switch). This is the pattern to reuse; it is the one place users already learn "before -> after, and I can undo".

## Findings, ranked

### P1-1 No detection or hint anywhere (the core gap)
Flow: add project, step 1 (`i03`). Expected: the path check line to say what it found, since it already inspects the folder. Today it reports git only.
Severity: P1.
Fix: extend `ProjectPathCheck` with `agentSources` (kind, file count, role count) and render a second `field-msg info` line under "Git repository found.", for example "Found 2 Claude Code agents and AGENTS.md. You can import them as roles." Same pattern and `aria-describedby` as the existing line. Show it for the "New idea" tab too only if the folder is non-empty and has sources, with the existing "already has files" warning.

### P1-2 The default chart silently shadows a found one
Flow: add project with Architect off (`i04`/`i05`). Expected: the org chart reflects my agents, or at least tells me it did not use them. Today a role named Reviewer with different behavior appears and the user may assume it is theirs.
Severity: P1 (data trust).
Fix: when sources were detected and the user chose "Create project" (Architect off), do not drop them. Either import as the starting chart behind a review step (P1-3) or show a Banner in the Org chart tab ("Found agents from Claude Code that were not imported. Review import") and make the default chart's gap explicit. Make "Import agents" the one primary action of that Banner.

### P1-3 The review step must be a Dialog or full view, with one primary action, and shown before anything is written
Expected content, in this order (what the user must see before applying):
1. Source: "Claude Code, `.claude/agents` (2 files)", with the file paths as muted mono text. Several sources get a source filter or grouped sections (Claude Code, opencode, Codex `AGENTS.md`, OrgAI export).
2. Roles as a list with a checkbox per role (default on), each row: name, slug, "reports to" select (foreign formats have no hierarchy, so default under the orchestrator and say so), tools as chips, and an expandable prompt preview (first 3 lines, "Show full prompt").
3. Tools dropped: per role, a quiet warn line "Not available in OrgAI: WebFetch, mcp__github__*" with a tooltip on why. Never silent. Dropped means narrower, so also say "Granted: Read, Grep".
4. Model before -> after: reuse `RemapRoleRows` (role, from mono, arrow, to mono, `Inherit` warn for unmapped) so users meet one pattern, plus the reason in the title ("claude-3-5-sonnet-20241022 -> sonnet, your Everyday tier"). The "after" should be an inline select so a wrong guess is fixable in place, not only by undoing.
5. Warnings roll-up at the top: unmapped model, duplicate slug against existing roles, no orchestrator found, `AGENTS.md` has instructions but is not an agent definition (it becomes project brief, not a role; say so explicitly because users will expect a role).
6. Conflict handling when roles already exist (Org chart entry, below): per role "Add / Replace / Skip". Default Add with a renamed slug, never Replace.
Primary action: "Import 2 roles" (count updates with the checkboxes). Secondary: Cancel. Footer says "Nothing is written until you import. Your files are not changed."
Severity: P1.

### P1-4 Undo has no home yet
After apply, show the existing `RemapNotice`-style Banner in the org chart column: "Imported 2 roles from Claude Code. [Undo] [Dismiss]". Undo restores the previous chart in one click, with no ConfirmDialog (it is itself the undo). This matches Remap Undo ("Reverted" state, "Retry undo" on error). Do not offer Undo through a toast or anything floating over the canvas. Keep the Banner until dismissed, because the Remap one already persists in the store.
Severity: P1.

### P2-1 Entry point on the Org chart tab
Today the toolbar is `Add role`, `Auto-layout`, and a hint "New roles report to Orchestrator." (`i05`). Put "Import agents" as a secondary Button with the `Download` icon next to `Add role` (icon plus label, not an icon-only button). It opens the P1-3 dialog and starts by scanning the working directory, with "Choose another folder or file" as a link in the dialog for agents stored elsewhere (or a user-level `~/.claude/agents`, labeled as user-level and off by default). When nothing is found, the dialog's EmptyState says what was searched: "No agent files found in `.claude/agents`, `.opencode/agent`, `opencode.json`, `AGENTS.md` or `.orgai/org.json`" with a "Choose a file" button. Never a dead end.
Placement conflict to avoid: the right SidePanel already carries "Revise with the Architect" as its primary purple button. Keep Import out of that panel, so each region has one primary action.
Severity: P2.

### P2-2 Settings > Connection has no per-role model readout, so "adjusted to models you actually have" is unverifiable
`i20` shows "4 roles use this connection · Everyday tier: sonnet" only. Import maps foreign ids to tiers, then the user cannot confirm where. Fix: add a collapsible "Role models" summary in that pane, and in the import review show the resolved connection ("Models mapped to Anthropic: Top = fable, Deep = opus, Everyday = sonnet, Fast = haiku") with a link "Change in Settings > Connection". For a mock project, say plainly "Mapped to the connection's tiers; this project currently runs on the mock adapter".
Severity: P2.

### P2-3 The new-project flow needs a choice, not another checkbox
Today: a segmented type, a path, and two checkboxes ("Set up with the Architect", "Use the mock adapter"). Adding a third checkbox for import will bury the primary decision. Recommended: when sources are detected, show one radio-style group under the path check: "Import the 2 agents found (review first)" (default), "Let the Architect set up from scratch", "Start with the default roles". The Architect checkbox collapses into this group. Submit label follows the choice: "Review import" / "Create and start setup" / "Create project". Creating with import should open the review Dialog on the Org chart, not create-then-import blind.
Severity: P2.

### P2-4 Informing the Architect needs to be visible to the user
Expected: if the Architect runs after an import, the user sees that it knows. Fix: the first setup line or the setup run header should read "Using 2 imported roles from Claude Code as the starting point"; the repo profile should list detected agent files, and `AGENTS.md` content already read as a doc should not be duplicated into role prompts. In the Architect proposal card, mark roles that came from the import with a source chip so the user can tell what changed. The generic first message in `i11` is the wrong place to bury this.
Severity: P2.

### P3-1 Wording
- Use "Import agents" (tab and button) and "Import N roles" (apply). Avoid "convert" and "migrate". Users think in "my existing agents".
- Use "Not available in OrgAI" for dropped tools, not "dropped" or "stripped".
- Say "model" and "tier" with the same words as the editor ("sonnet · Everyday"), since that is what they will see next.
- Use the existing statuses "Inherit" for unmapped models. Warn that Inherit means "uses the parent's model".
- Label sources by tool name ("Claude Code", "opencode", "Codex", "OrgAI export"), with the path in muted mono beside it.
Severity: P3.

### P3-2 Small existing issues that the import flow will inherit
- The Name field on the existing-repo form did not accept the name from my driver (my selector); the second project was created with the same folder and the same name "fixture-app" and no warning. The sidebar then shows two identical entries. Importing into an already-added folder needs a "This folder is already a project" check line, and that line is also where an import entry could live.
- The Org chart has no empty state or onboarding line after a no-Architect create, so a Banner for import will be the first guidance there.
- The "Needs you" first action in a setup run is a Bash permission card (`git status`) before the user has seen anything useful. Not an import issue, but it competes with an import notice if one is added on Live.
Severity: P3.

## Recommended placements (summary)

| Moment | Pattern | Primary action |
| --- | --- | --- |
| New-project form, path typed | second `field-msg info` line under the git check; radio group replaces the Architect checkbox | Submit button label changes to "Review import" |
| After create with import | `Dialog` (review) over the Org chart tab, not a floating card; per-role checkboxes, prompt preview, tools dropped, model before -> after rows via `RemapRoleRows` | "Import N roles" |
| Org chart tab, anything detected but not imported | `Banner` in the top of the column (same region as `RemapNotices`), `Import agents` as its button | "Import agents" |
| Org chart tab toolbar | secondary `Button` `Import agents` (Download icon) beside `Add role` | none (secondary) |
| Empty scan | `EmptyState` inside the Dialog listing places searched, with `Choose a file` | "Choose a file" |
| After apply | `RemapNotice`-style Banner "Imported N roles from <source>" with Undo and Dismiss | Undo |
| Replace or Remove existing roles | `ConfirmDialog` (`useConfirm`) naming each role replaced, only if the user picks Replace | "Replace N roles" |
| Settings > Connection | read-only "Role models" disclosure and a one-line mapping summary | none |
| Architect session | line at the top of the setup run naming imported roles and the source | none |

Everything stays in layout regions (toolbar, column Banner, tray, Dialog). Nothing is placed over the canvas.

## Spec-level questions for the Product Designer
1. Does Replace exist at all in v1, or is import strictly additive with renamed slugs?
2. Where does the hierarchy come from when the source has none (Claude Code, opencode)? Recommended: default under the orchestrator, editable in the review, never inferred silently.
3. Is `AGENTS.md` a role source or a project-brief source? Recommended: brief only, shown as a separate row "Project instructions" with a checkbox.
