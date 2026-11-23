# UX review: Team tab overhaul

Reviewer: UX Researcher (first-time-user walk). Build: `26e2fb41` (`npm run build` ran clean). Ran with `ORGAI_MOCK=1`, fresh temp data dir, driven by Playwright scripts on `e2e/lib.mjs` (`setContentSize`, `data-theme`).
Sizes: 1600x1000 and 1024x640. Themes: dark and light. One keyboard pass at 1024x640 dark.
Compared with: `docs/design/team-tab-overhaul.md` (not re-read line by line; the walk is from the user's side).
Shots and scripts: `e2e/shots/ux/team-overhaul/` (gitignored). Paths below are relative to that folder.

## Verdict: MOSTLY WORKING, one High

The redesign is coherent. Header, selected-role toolbar, zoom group, role panel, Import and the engagement variant all work on mock data, and Duplicate, Add a report, Move, Remove and Tidy gave a visible result with an "Undo" or "Saved" cue. Add a report put the new role under the selected one. No page-level scroll at either size. The serif headings and coral accent show in the engagement project.
One High: the "Review the whole project?" confirm cuts off its own cost sentence. The rest are Medium and Low: toolbar clipping, a header that loses labels (and the Theme control) at 1024, a mislabelled Add group, and a keyboard path to the toolbar that nothing tells you about.

## Findings

### High

**H1. "Review with the Architect" confirm clips the cost sentence** (engagement, 1600 and 1024, dark and light)
Shots: `eng-review-confirm-1600-dark.png`, `eng-review-1024-light.png`.
Repro: New project > Engagement (no interview) > Team > top-left line > "Review with the Architect".
Expected: a readable sentence saying what happens and what it costs, then Cancel / Start.
Happened: the body is one non-wrapping line with a horizontal scrollbar. It reads "With nothing written, the Architect reviews the engagement and revises the plar" and stops. Source (read, not seen): the rest is "…, org chart and settings. Starts an org change session {cost}." So the part about spending is not visible without scrolling sideways. Focus lands on Cancel (good); Esc returns focus to the link (good).
Fix: wrap the body (normal white-space) and give the dialog a max width of about 440px. Suggested copy: "The Architect reads the engagement and may revise the plan, org chart and settings. Nothing changes until you approve. This starts a session that uses your AI plan (about {cost})."

### Medium

**M1. The role toolbar is clipped at the canvas edge and the chart does not pan** (1600 dark and 1024 dark)
Shots: `code-1600-dark-addreport.png`, `code-1600-dark-move.png`, `kb3-after-duplicate.png`.
Repro: select the right-most role (or Duplicate a role so the copy lands right of the viewport), look at the toolbar above it.
Happened: "Add a report / Duplicate / Move / Remove" is cut off ("Rem…", or only "Add a report  Duplicate" at 1024). A mouse user cannot click Move or Remove until they pan by hand. The new role from Duplicate or Add a report can be half outside the view with no pan or fit. The toolbar also sits across the incoming reporting line of the selected role and hides it (visible at 1600 and 1024).
Fix: when a role is selected or created, pan it into view with room for the toolbar; align the toolbar to the right edge when it would overflow.

**M2. At 1024x640 the header loses its labels and the Theme control disappears** (all themes)
Shots: `code-1024-dark-selected.png`, `import-1024-dark-startfrom.png`.
Happened: Add group, Import, Layout, Start from and Team files become unlabelled icons (names only in tooltip / accessible name). "Team files: not committed", the one piece of status, is reduced to a small glyph. The Theme button measures 0x0, so it cannot be reached by mouse or keyboard at this size (Tab order at 1024: Start from, Team files, Add role, then the role nodes).
Expected: a first-time user at a laptop size can tell Layout from Theme from Start from. Several icons look alike.
Fix: keep text for the primary three (Import, Start from, Layout) or put the lot in a "More" menu at narrow width; keep a status dot with a visible "Not committed" on Team files; do not drop Theme silently.

**M3. "Theme" is a dropdown with one option**
Shot: `hdr-1600-dark-Theme.png`.
Happened: Theme > "Org chart" is the only choice; the menu says "Pocket Office and Factory floor show a running team on Work." A first-time user reads "Theme" as light/dark, opens it, and finds nothing to choose.
Fix: rename to "View: Org chart" and show it only when there is a second option, or move the explanation into a tooltip.

**M4. "Add group" opens a form titled "Add a role"**
Shot: `addgroup-1600-light.png`.
Repro: header > Add group.
Happened: a popover titled "Add a role", Name "New role" preselected, Reports to Orchestrator, helper "Orchestrator will be able to delegate to it." The tooltip promised "a lead who reports to the top of the team". Nothing on screen says it is a group or a lead. It is the same form as Add role.
Fix: title it "Add a group lead", prefill the name "New group", and say "This role will lead its own group. Add its reports after."

**M5. Keyboard: the toolbar works but nothing tells you where it is**
Shots: `kb3-toolbar-focus.png`, `kb2-selected.png`.
Pass at 1024 dark. Works: Tab order follows header > chart nodes > zoom group > assistant (Ask field, "For" select, Recommend). Left/Right/Home/End move inside the toolbar and wrap; Enter on Duplicate worked; Esc in the Add-role popover returns focus. Visible focus rings (2px violet) on header, toolbar and zoom buttons; the role cards show a focus outline on the card.
Problems:
- The toolbar is a Tab stop after the last node, not next to the selected one (selected Reviewer: Tab went Researcher > toolbar). With 4 roles that is 3 presses; with 30 it is a long trip. No text mentions it; the node label says only "Press Enter to edit, Delete to remove."
- Space on a node selected it and put focus in the panel's Name field in one run (`walk7`), but kept focus on the node in another (`walk6`). Behaviour was not consistent between my two runs.
- Esc on a focused node leaves it selected and moves focus to `<body>` (focus lost). Esc inside the panel returns to the node (good).
- After Delete on a node, focus goes to the Orchestrator (fine) and "Removed Researcher." plus Undo appears in the bottom bar.
Fix: add "Press Shift+Tab or Tab to reach this role's actions" to the node description when selected, or place the toolbar directly after the selected node in the Tab order; make Esc keep focus on the node.

**M6. Import dialog: dead options and mixed vocabulary**
Shots: `import-1600-dark-open.png`, `import-1024-dark-replace.png`.
Happened:
- "Another OrgAI project" and "Choose another" are shown greyed out, and the line "Another OrgAI project and Choosing another folder are not available yet." reads like an error message with a stray capital. A first-time user sees two options that do nothing.
- The row control is "Level" (Standard · sonnet) here but "Model" (Fast / Standard / Advanced / Most capable) in the role panel. Two lines say the same thing ("Not recognised, so the Standard level was used…" and "No model given; using the everyday tier…").
- "Select all" stays visible when all 2 are already selected.
- Replace mode says "Replaces your 4 roles with these 2." but the chart shows 3 after (the existing Orchestrator is kept: "The team goes from 4 to 3 roles"). The warning does explain the orchestrator, but the headline number does not add up.
- Imported roles keep the file slug as the name ("doc-writer", "reviewer-bot").
Good: "Nothing changes until you press Add", the "What will change" preview with +doc-writer / +reviewer-bot chips, per-row Reports to and Level, primary button says "Add 2 roles to the team" / "Replace team with 2 roles", the status "Imported 2 roles from Claude Code. You can undo until you change a role." and focus returns to Start from.
Fix: hide the unavailable options until they exist (or label them "Coming soon" once); use "Model" everywhere; one line per mismatch; "Replaces your 4 roles with these 2 plus the Orchestrator"; title-case imported names ("Doc writer").

**M7. Role panel header is truncated and see-through**
Shots: `code-1600-dark-move.png`, `must-pass-1600-light.png`, `code-1024-dark-selected.png`.
Happened: the sub-line "Implementer · reports to Orch…" is cut off at every size even though the title is short; it repeats the name. When the panel is scrolled (Move, or the must-involve checkbox), "Tools and services / None yet / Add" shows through behind the sticky header and overlaps "Tester" / "Reviewer" (dark and light).
Fix: show "Reports to Orchestrator" without the repeated name; give the sticky header an opaque surface.

**M8. At 1024x640 the chart is small**
Shot: `code-1024-light-selected.png`, `import-1024-dark-after.png`.
Happened: the assistant tray takes about 40 percent of the height, so the chart is about 330px tall and auto-fits to 50 to 60 percent; node text is about 7px. The role panel is wide (about 350px). Role cards are hard to read right after an import.
Fix: collapse the tray to its one-line Ask bar by default at short heights.

### Low

- L1. Light theme: Add group / Import / Layout buttons lose their border (dark has it), so they read as plain text (`code-1600-light-selected.png`).
- L2. Role panel "Choose an exact model" repeats a "Model" select next to the tier buttons, with "Inherit from parent" and "Most capable (fable)", which the four-button choice does not offer (`code-1600-light-exactmodel.png`). The model sentence updates ("Runs on Advanced (opus)").
- L3. Layout menu has "Arrange automatically" while the zoom group has "Tidy". Two names for one action (`hdr-1600-dark-Layout.png`).
- L4. Ticking "Orchestrator must always involve this role before finishing" shows only "Saved" and no mark on the Reviewer or Orchestrator card (`must-pass-1600-light.png`). Suggested status: "Orchestrator will involve Reviewer before finishing."
- L5. Engagement: the Recommend tools and skills button and "Add a skill" stay violet while Add role is coral (`eng-1600-dark.png`); the leading "A" avatar in the top-left line is unexplained. The assistant text says "I look at this repo" in an engagement; suggested "I look at this engagement's folder, your computer and your library first."
- L6. After Remove (toolbar) the chart is not re-fitted: the Orchestrator is cut off at the top (`code-1600-dark-remove.png`). Remove has no confirm but shows "Removed Tester. Undo", which is good.
- L7. Engagement setting page title repeats "Engagement: Acme tax review" twice after "Read the engagement plan"; the link moves to Settings and focus lands on the "Engagement plan" heading, which is good.

## Checked and fine
- Header at 1600: Add group, Import, Theme, Layout, Start from, Team files (menu text clear: "5 files are not in git yet" with Commit team files), Add role. Menus close on Esc with focus back on the trigger.
- Role panel order: What this role does, Model tier (Fast / Standard / Advanced / Most capable), exact model, What it can use, Instructions, delegation, Who it is, must-involve. Tier click updated the sentence and the node chip immediately.
- Engagement: serif headings (Fraunces on the Team h1 and role title), coral add button, selected-node ring and links; "Where it can work" shows "Acme tax review (working folder) Can write" and "Reference folders stay read only for every role."
- No page overflow at 1024x640 (`scrollWidth/Height` = 1024/640) in either theme.

## Not driven
- Ask the Architect: not pressed (the Ask button is disabled with an empty field; I did not spend the one allowed Ask). Recommend tools and skills, Re-check setup and the confirm "Start full review" not pressed.
- Replace-team and Add were each run only at 1024 dark (Add 2 roles); Replace was previewed, not applied.
- Dragging a reporting line, dragging nodes and right-click / Shift+F10 menus were not exercised.
- Screen-reader speech and the status announcements were not heard; I read the status text only.
- Reference folders with entries ("Where it can work" with several folders) cannot be produced without the native folder picker.
- "A kit" import source and "Another OrgAI project" are disabled in the build.
- Mock data only; real model names ("fable", "opus") are mock catalog values.
