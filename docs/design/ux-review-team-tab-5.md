# UX review: the Team tab, fifth walk (cohesion, flow and design, not accessibility)

Reviewer: UX Researcher. Analysis only, no code changed.

- Build: dev at `573b5dd6` (equals origin/dev), `npm ci` + `npm run build`, driven with a command-file driver on `e2e/lib.mjs` (`e2e/shots/ux/team5/repl.mjs`, not committed).
- Run: `ORGAI_MOCK=1`, throwaway data dir, fixture repo, project "Walk" (default team: Orchestrator, Implementer, Reviewer, Researcher). No tokens spent, no real provider.
- Sizes: 1440x900 (walk) and 1024x640 (check). Themes: dark throughout, light glanced at 1440 (shot 45, 46). One keyboard Tab-order pass (see end). Accessibility is out of scope (reviews 1 to 4).
- Shots: `e2e/shots/ux/team5/NN-name-<size>.png` (gitignored; named below).
- Owner's portable build is v0.1.8 (main 79956c23) or a local 0.1.7-dev1. Two things I walked exist only on dev and are marked **[dev only]**: the role right-click / Shift+F10 menu (Edit role, Add a report, Remove role) and the reworked Pocket Office scene. Everything else applies to the released build too.
- Severity here: **blocks** (user cannot finish or is misled into a wrong result), **slows** (works, but needs a second read or detour), **polish**.
- Statements marked *(inferred)* come from reading code, not from the running app. Only three or four are used.

## (a) Verdict

The Team tab is a capable editor whose parts do not yet add up to one idea. A new user lands on a chart with no instruction about what the screen is for, a tab pair (Role / Catalog) that opens on the wrong one, and four separate stacks of chrome (toolbar, a status line, the chart, a tray, a side panel, a footer hint) all competing for a 640 px window. Individual pieces are well written (the empty states, the Save-template dialog, the delete-with-undo, the "What goes in" list), but the same job is reachable from three or four places, key state (who a new role reports to, who now "leads", what changed on disk) lives far from the action that caused it, and several silent side effects (adding a role gives its manager spawn rights permanently; dropping a drag on a node body does nothing) change a team without telling the user in the place they are looking. The chart itself does not scale: with 14 roles the first render overlaps cards, Auto-layout plus Fit gives ~110x56 px cards that are still cut off at both edges, and at 1024x640 the chart gets 237 to 330 px of height. The chart shows structure well for four roles and almost nothing about capability; the inspector holds the capability but is a 1,640 px scroll with the identity, model and prompt below the fold.

## (b) Per-flow findings

Times are my own effort: "immediate" (understood from the screen), "one read" (had to re-read), "had to experiment".

### Flow 1: land on a fresh project with the default team (1440x900, 1024x640)

What I expected: a short statement of what the Team tab is, one obvious next step.
What I got (shots 01, 02, 03):

- **Slows. The tab opens on the Catalog tab, not Role, with no role selected.** Shot 01: right panel shows "What the whole team can draw on. Open a role to choose what it uses." with Skills · 0 and Connections · 0. Clicking Role gives "No role selected / Select a role on the chart to edit what it can use." (shot 02). The first thing a new user sees in the biggest panel is an empty library, not the team. One read to realise the chart is the thing to click.
- **Slows. Nothing says what the screen is for.** The header of the whole screen is the toolbar. The only explanatory text is the footer hint "Drag from a node's bottom handle to another node to make a report. With a node focused, Enter edits it, Delete removes it and Shift+F10 or a right click shows more." at 11 px, two lines, below a tray. There is no title such as "Team" or "Roles", no count of roles, no "this is who works on your project" sentence. The footer is the only teaching text and it teaches keyboard shortcuts first.
- **Slows. No primary action.** Six same-weight outline buttons (Add role, Import from other tools, Templates, Auto-layout, Canvas style, plus the purple "Recommend tools and skills" in the tray). Purple (primary) is used only in the tray and in the panel ("Add a connection", "Add a skill"). The toolbar has no primary.
- **Slows. A fresh, unedited project says "Team files changed, not committed" with a "Commit team files" link** (shot 01, second toolbar row). I had changed nothing. A new user reads this as "I broke something" or "I must commit before I continue".
- **Slows. The chart is small and floats in a large empty stage.** Four roles at 1440x900 take about 650x270 px of an 850x500 stage (shot 01). Meanwhile the tray takes 290 px (a third of the window) permanently.
- **Slows. Hierarchy of the screen is flat.** Toolbar row 1, row 2 (note + files line), chart, tray header, tray body, footer, and the panel tabs all use the same 12 to 13 px size with similar weights. Nothing marks "this is the thing you are editing" versus "help".
- **Polish.** Edge colours differ per role (blue, green, orange) with no legend; they match the avatar colour of the child (shot 01), which is a nice link, but undiscoverable.

Time to work out where to start: one read plus one wrong click (Catalog).

### Flow 2: add a role, name it, give it a job, tools and model, re-parent, remove, undo

Steps: Add role, rename, describe, open tools editor, set model tier, set Reports to, drag to a new manager, Remove, Undo. 1440x900. Shots 04 to 18.

- **Blocks (misleads). Add role does not add under the root; it adds under whatever is selected.** I had Implementer selected from earlier, so "New role" became Implementer's report (shot 08). The only cue is the toolbar sentence "New roles report to Implementer." which changes silently with each selection (it said "New roles report to Orchestrator." until I clicked a node). Nobody reads a note beside the Canvas-style button as the parent of the next click. Consequence below.
- **Blocks (misleads). Adding a role silently turns its manager into a delegating role, permanently.** Banner in the inspector (shot 08): "Implementer can now create subagents, because New role reports to it." It is an info banner in the side panel, about a different role than the one I am editing, and it stays when I re-parent (shot 10, 13: it still says "Reviewer can now create subagents" while the role now reports to Researcher). After I moved the role away and finally removed it, **Implementer, Reviewer and Researcher all still had May create subagents on** with zero reports (project data after undo: Implementer spawn=true kids=0, Reviewer spawn=true kids=0; chart chip "leads 0", shot 17). Removing or moving the role does not take the permission back, and the permission widens what an agent can do. The only trace is a "leads 0" chip on the node.
- **Slows. The new node appears partly under the tray and the chart does not follow.** Shot 08: "New role" sits at the bottom edge cut off by the tray top. The user must press Fit (the corner icon button) to see what they just made. The panel on the right has focus and shows the role, so the tab is consistent, but the chart gives no "here it is" cue.
- **Slows. Name, then tools, then connections, then skills, then identity. Description and Reports to come after about 600 px of scroll** (shot 04, 05). The inspector order is Name > What it can use > Identity (slug, "When should a manager delegate to this role?", Reports to, Color) > Model > Advanced > Delegation > Instructions (Responsibilities, System prompt). For a new role the job description ("When should a manager delegate...") and the manager are the two required thoughts, yet they sit below an empty Connections block and an empty Skills block that each take 100 px of explanation (shot 04).
- **Slows. The description field has two names.** Label "When should a manager delegate to this role?"; in the chart, the same text never appears; in the Team assistant and elsewhere it is "description". One read.
- **Slows. Model is two controls.** "Model: Everyday" label followed by a select "Everyday (sonnet)", then "Advanced" (an expanded disclosure) with "Tier and effort: Automatic, up to Everyday / high", "No effort is set, so automatic picks may go up to high.", then Staffing, Lowest tier, Highest effort selects (shot 05, 06). A user who picks "Fast" (I did, shot 10) still has to understand the Advanced summary: what "automatic" does to a role I just pinned to Fast. The word "tier" appears in the select ("Deep (opus)") only as a parenthesis and in "Lowest tier".
- **Slows. Tools editor.** Edit toggles to Done and shows a 2-column checklist with raw tool names (Read, Glob, Grep, Edit, Write, Bash, WebSearch, WebFetch, TodoWrite, NotebookEdit, SendMessage, ListAgents; shot 09). The sentence below "What this role may do on your files and shell." is the same whether Read-only or Bash is on. Warning triangles on Edit, Write, Bash, NotebookEdit have no legend on screen (the node tooltip says "Can change files or run commands"; I only found it by hover). Plain-language grouping ("Read files", "Change files", "Run commands", "Browse the web") is missing.
- **Slows. Re-parent has two mechanisms with different feedback.** (1) The Reports to select in the inspector: immediate, works (shot 10). (2) Dragging from a node's bottom handle: dropping on the target's **top handle** worked (shots 14, 15: Docs Writer moved from Reviewer to Researcher, "leads 1" moved too); dropping on the **middle of the node** did nothing and left a stray edge line (shot 13). The handles are about 6 px dots (shot 11). A user who follows "Drag from a node's bottom handle to another node" and drops on the node gets no change and no message. Had to experiment.
- **Slows. After re-parenting the chart does not re-layout.** Docs Writer stayed under the old position with a long diagonal edge (shot 15) until Auto-layout. The reparent control (Reports to) and the layout control (Auto-layout) are separate, and nothing hints that you may need the second.
- **Polish. "Nobody (root orchestrator)" is a choice in the Reports to select of a normal role** (text dump of the Implementer inspector). It offers to orphan a role; the label is also the only place the word "root" appears.
- **Slows. Remove is confirm-then-undo.** Clicking Remove opens a dialog "Remove Docs Writer? You can undo this for a few seconds." with Cancel / Remove role (shot 16), then a toolbar row "Role removed. Undo" at the right of toolbar row 2 (shot 17). Two safeguards for one reversible action; and the Undo row appears in the toolbar, about 700 px from the Remove button in the side panel, and it does not name the role ("Role removed."). Undo restored the role with the same parent and selection (shot 18), which is good.
- **Polish. "Saved 07:12 AM" at the far top right is the only evidence of autosave.** It appeared the moment I added a role. Good, but it is on the project header, far from the edit.

### Flow 3: understanding what a role can do (delegation, tools, connectors, skills)

- **Slows. The chart answers "who reports to whom" and almost nothing else.** Card shows: avatar, name, slug, a tier chip (Deep / Everyday / Fast), "leads N", a key/wrench icon with a tool count and a warning triangle (shot 01). Connections and skills are not on the card at all (no count, no icon), even after granting them *(not granted in this walk; empty state only)*. Tool count "6 ⚠" needs a hover to mean "6 tools, some can change files". The card gives no way to tell "can write files" from "read-only" except the triangle.
- **Slows. "leads 3" is a count of reports, not of delegation.** Orchestrator "leads 3" stayed 3 after I unchecked Implementer in its Delegation list (data: kids=2) and a dashed "not delegable" edge appeared (shot 21). The edge label "not delegable" is ~9 px and low contrast; the count and the line disagree.
- **Slows. "not delegable" is explained nowhere.** The Delegation section lists "May create subagents" plus one checkbox per role plus "Required" (shot 19, 20). A user who unchecks a box discovers the dashed edge by looking at the chart; neither "not delegable" nor "Required" is defined on screen.
- **Blocks (readability). The Delegation grid collapses visually at 1440 with four or more candidates.** Shot 20: checkbox, avatar dot, name and "Required" wrap into each other; "Required" and "Reviewer" overlap ("Re[Reqruired]ewer"), "Docs Writer" wraps to two lines, and "Requir" is clipped at the panel edge with a horizontal scrollbar at the panel bottom. This is the control that decides who a role may spawn. Reproduce: select Orchestrator with five roles, scroll to Delegation.
- **Slows. The delegation list for a non-root role offers its own manager.** Implementer's Delegation list contains Orchestrator (shot 22). Offering a role above you in the hierarchy as someone you may delegate to makes no sense.
- **Slows. "What it can use" mixes three things.** Tools, Connections and Skills are three differently shaped blocks (a text line with Edit, an empty state with a purple button and a link, another empty state with a purple button and a link). The two empty states take 220 px at the top of every new role, pushing identity and model down. "Ask the Team assistant" appears twice here (once per group) and a third time in the tray.
- **Slows. Role pane and Catalog use different words for the same objects.** Role pane: "Connections", "Skills", "Add a connection". Catalog: "Connections", "Skills", "Plugins", "Suggestions from past runs", "Evaluate skills". Tools are in the Role pane only. The word "connector" is used in the tab brief; on screen it is "connection". Not an error, but a user reading both panels meets "tools", "connections", "skills", "plugins" and "suggestions" and has no map.

### Flow 4: the Catalog tab and the Role tab

- **Slows. What is it, and how does it relate to Role?** Catalog says "What the whole team can draw on. Open a role to choose what it uses." (shot 23) and lists Skills, Connections, Plugins at project level. Role says "What it can use" at role level. The relationship (the Catalog is the library; Role is the grant) is only stated in that one Catalog sentence and in "You then choose which roles in this project may use it." in the Connections empty state.
- **Slows. Selecting a role does not change the Catalog.** I had Implementer selected, opened Catalog, and the content was identical to the no-selection state (shot 23, 24). A user looking for "what does this role have" opens Catalog by habit and finds nothing role-specific (one wrong tab per visit; I did it on my first visit because the panel opened there).
- **Slows. "Add a skill" / "Add a connection" exist in both tabs with the same label but different scope.** In Role it adds to this role only (e2e text: "this role only"); in Catalog it adds to the project and says "You then choose which roles in this project may use it". Same purple button.
- **Slows. A second reach to the same assistant.** "Ask the Skill assistant" (Catalog), "Ask the Team assistant" (Role, twice), "Ask the Architect" (end of tray results), plus sidebar "Skill assistant" and "MCP assistant". Five labels for the idea "get help picking these".
- **Polish. "Evaluate skills" is a lone ghost button with the note "Evaluate may use up to 20k tokens to suggest skills."** below it, separated from the row it belongs to (shot 24). The only price disclosure in the panel.

### Flow 5: Team assistant tray (whole team and one role), cost, space

- **Slows. Cost is stated once, in a sentence that has to be read.** "Recommend asks the AI and counts toward your usage. Re-check setup is free." (shots 01, 03). The two buttons beside it are same-sized and adjacent: "Recommend tools and skills" (purple) and "Re-check setup" (outline). Good that there is a sentence; but the costing action is the purple primary, and the sentence is 150 px below it at 12 px.
- **Slows. "Also search outside sources (MCP Registry, anthropics/skills, GitHub)" checkbox with "Searches the internet. Results are unverified."** is a third decision before pressing Recommend, with a text list of three third-party names the user has not met.
- **Slows. The "For" scope is a select ("The whole team" / each role) and a separate "Follow chart" link.** When I changed For to Reviewer (accidentally, shot 10) the tray kept Reviewer while the chart selection moved on; a "Follow chart" link appeared (shot 10, 11) and the tray target stayed Reviewer after the remove (shot 17). A user acts on one role in the inspector and asks the assistant about another without noticing. Chart selection, tray target and toolbar "New roles report to X" are three separate "current role" indicators.
- **Slows. Two tabs of one tray do different jobs with no shared frame.** Recommend (tools and skills) and Design ("Revise with the Architect: Say what should change. The Architect reads the repository ... The session opens on Live ...", shot 25) are in one tray named "Team assistant". Design leaves the Team tab (it opens a session on Live) while the tray sits under the chart. "Team assistant" in Recommend is a one-shot recommender; in Design it is the Architect session. Two different backends under one name.
- **Slows. The tray's gear icon (unlabelled, right of the tabs) leaves the Team tab.** Clicking "Team assistant settings" opened Project settings > Permissions > Advanced > "Team assistant: AI suggestions" (shot 26). That is the only place to turn AI suggestions off, and it is under Permissions. It lost the tray's Design tab state when I came back (tray reset to Recommend, For reset).
- **Blocks (space) at 1024x640.** Window 640 px: stage 330 px, tray 165 px, in default state (shot 03); stage 237 px, tray 211 px after pressing Recommend (shot 47), with the chart's top row cut off and the tray header ("Team assistant", Recommend / Design) scrolled out of view inside the tray. The Team tab badge shows "Team 3" (suggestions), which is the only signal outside the tray. With a result open the user has to scroll the tray to find Apply, and scroll the chart to find the role.
- **Polish. "What I looked at" is a collapsed disclosure at the bottom of a scrolling tray** (shot 01). The sentence above it ("Find tools and skills for your team. I look at this repo, your computer and your library first.") says it already.

### Flow 6: Templates and Import from other tools

- **Slows. Templates menu has two items and one empty line.** "Save this team as a template..." and a disabled "Replace the team with a template..." with "No templates yet" below it (shot 27). The menu overlaps the chart's top row and the Orchestrator node. No built-in templates exist, so on a first visit the menu is a Save-only entry.
- **Works well. Save dialog.** "Save this team as a template: Start new projects with this team. You can remove templates in App settings." with Name prefilled "Walk team", Description (optional), "What goes in: 5 roles with their instructions, models as tiers and tools; Which skills and services each role may use, by name; Kind: Code project. Not included: secret values, folders and run history." (shot 28). After save: a green banner "Saved the template Walk team." with "Manage templates" (shot 29). The banner pushes the chart down 96 px and stays until dismissed.
- **Slows. Replace dialog is clear on risk but gives no preview.** "The current roles are replaced. You can undo until you edit the chart." Templates list shows "Walk team: 5 roles: Orchestrator, Implementer, Reviewer, Researcher and 1 more · Code project" (shot 30). "and 1 more" hides the name; no preview of the structure; the promise to undo "until you edit the chart" is a rule the user has to hold in their head. I did not apply it (see Not driven).
- **Slows. "Import from other tools" label does not say which tools.** Clicking it opens "Import agents / Review the roles found in this folder before they join the org chart." and, with nothing found: "No agent files found. Searched .claude/agents, .opencode/agents, opencode.json, .codex/agents, .github/agents, .gemini/agents, .kiro/agents, .roomodes and .orgai/org.json in <path>." with a disabled "Import 0 roles" primary (shot 31). The scan only happens after the click; a user cannot tell beforehand whether the button is worth pressing. The dialog title "Import agents" differs from the button "Import from other tools" and the dialog's heading "found in this folder" differs again. A useful empty state otherwise: it lists exactly where it looked and says "Nothing is written until you import."
- **Polish. Templates, Import and Replace are three entry points to one idea:** "start from a prepared team". They are in three places (Templates menu, Import button, Design tab) with three wordings.
- *(inferred)* An "agents found" banner stack exists for when files are present; the fixture had none so it was not shown (see Not driven).

### Flow 7: Canvas style, node styles and Pocket Office, editing in each

- **Slows. Canvas style is a presentation chooser for the whole app inside an editor toolbar.** The popover (shot 32) says "Applies across the app, including Live and Team." and lists Presentation (Graph / Pocket Office) plus 7 Graph styles (Default, Blueprint, Constellation, Subway, Mission control, Paper, Hive). A user who opens it to make the org chart readable changes how Live looks too. The popover is taller than its container and scrolls internally (the list is cut off after "Constellation", shot 32), and overlaps both the chart and the side panel. At 1024 the button is an icon-only palette with no text (shot 03).
- **Slows. Style changes how much you can see and how you edit.** Default cards show tier, leads, tool count. Subway (shot 33) and Hive (shot 35) show only an avatar and name: no tier, no leads, no tool count, so the chart loses the "who can do what" content. The footer hint changes with the style ("Drag from a node's bottom handle..." becomes "Drag from a node's right handle..." in Subway, "Point at a node and drag from its handle..." in Hive) while the handles are not visible in Hive (shot 35). "not delegable" labels stay at ~9 px in every style. These styles are display choices that belong to the live run view; in Team they hide the editing signals. *(Conclusion from the screenshots: for editing, only Default and probably Blueprint / Paper keep the information.)*
- **Slows. [dev only] Pocket Office in Team.** Shot 36 to 38: the scene opens at 2x showing a partial office (first view, shot 37); Fit shows the building. Toolbar loses Auto-layout (appropriate), the stage gets "Team layout · roles, not live activity", Zoom out / 1x / Zoom in / Fit, departments labelled "Orchestrators · 1", "Implementer · 1", "Reviewer · 1", "Researcher · 2" (Docs Writer is in the Researcher department), and "Find a person · 5". No reporting lines are drawn: structure is communicated only by room, so "Docs Writer reports to Researcher" is visible only as a head count of 2. People labelled "Implementer / Implementer" twice (name and role are identical for the default team).
- **Slows. [dev only] Editing in Office mode works but is one-way.** Clicking a person opens the same inspector with a "Back to office" strip at the top (shot 38). Reports to still works through the select. Drag-to-re-parent does not exist (footer: "Select a role to edit it. With a role focused, Enter edits it and Delete removes it."). Add role and Templates and Import still work. The Role and Catalog panel is unchanged, so Office gives a pretty scene and no gain for editing; at 1024x640 the scene is cropped to a strip (stage 325 px, shot 39). The text "Canvas presentation: Pocket Office." appears as a status line.
- **Polish. [dev only] The right-click / Shift+F10 menu on a role: "Edit role / Add a report / Remove role"** (shot 44). It duplicates the inspector's Remove, and "Add a report" is the only way to add a role under a chosen parent without first selecting it. Useful and not discoverable except from the footer sentence.

### Flow 8: the "Team files" line

- **Slows. Wording.** Shot 01: "Team files changed, not committed" and "Commit team files". After the click (shot 46): "Team files: in sync .orgai/ in this repository. Committed 15 team files." run together in one line with no punctuation between "in sync" and ".orgai/", and no explanation of what team files are.
- **Blocks (misleads on a fresh project).** The line says "changed" and offers a commit on a project the user has not touched. *(inferred from code: the team files are written the first time so "changed" is true relative to git, but the user did not change them.)*
- **Slows. One click writes to the user's git repository.** "Commit team files" ran immediately and reported "Committed 15 team files." with no confirmation, no commit message, no list of files. Whether this matters depends on the policy, but a first-time user cannot know what a "commit" will include.
- **Slows. The toolbar is the wrong place.** It is the only line in row 2 that is not about the next action, it appears and disappears (an Undo row, banners and a "Role removed" line share the same area), and when it changes size the whole chart shifts (the stage moved down 10 px after Remove and 96 px after the template banner). It is a repository status, not a toolbar control.

### Flow 9: a larger team (14 roles, by repeated Add role)

No built-in template or import fixture existed, so I added nine roles by hand (Add role x 9, selecting different parents). 1440x900 and 1024x640. Shots 41, 42, 43.

- **Blocks. Cards overlap on add, before Auto-layout.** Shot 41: "New role 8" sits on top of Reviewer and Researcher; "New role 6/7/9" are at the bottom, partly clipped; "leads 6", "leads 2", "leads 3" are visible only where a card is not covered. There is no collision avoidance.
- **Slows. Auto-layout plus Fit does not make a 14-role chart usable.** Shot 42: all 14 cards are 110x56 px (about 50% zoom) and still clipped at the left and right (first and last columns are cut off); text in cards is ~6 px. Shot 43 at 1024x640: a 330x~280 px window onto the chart; the Orchestrator top row is cut off. Pan and zoom are the only navigation.
- **Slows. No other view of the team.** No list or table of roles, no search, no "find a role", no filter, no collapse of a branch. To reach "New role 7" I used the node or the For dropdown (15 entries) or the Reports to select. The keyboard Tab order goes through all 14 nodes one by one before reaching the tray (see end).
- **Slows. Default naming.** New roles are "New role", "New role 2", ... "New role 9" with slug "new-role-9", description "Describe when a manager should delegate to this role." (placeholder-looking text that I had to select to replace). Fourteen roles in the For dropdown and the Reports to select are indistinguishable until renamed.
- **Slows. Toolbar holds.** At 1440 nothing broke; at 1024 the toolbar wraps: "New roles report to New role 9." goes to a second row, "Team files changed..." to a third (shot 43, 47 show two to three rows), costing 40 px more of a 237 px stage.
- **Polish. The inspector is no longer the bottleneck at 14 roles, the chart is.** The Reports to and For selects are the only cross-role navigation and are long flat lists with no hierarchy shown.

## (c) Things that work and should be kept

1. **Save-this-team dialog.** The "What goes in" and "Not included" lists (shot 28) tell the user exactly what a template holds. Keep as the model for the Replace and Import dialogs.
2. **Import empty state.** It lists every folder searched, says "Nothing is written until you import. Your files are not changed.", and disables "Import 0 roles" (shot 31).
3. **Remove with undo, and the undo restoring parent and selection** (shots 16 to 18). Keep the undo; reconsider the extra confirm.
4. **Reports to select next to the drag.** Both work; the select is the dependable path (shot 10).
5. **Edge colour = child colour, and avatar initials**, and the dashed "not delegable" edge (shot 21): the chart does show a delegation exception visually.
6. **The node tooltip content** ("Orchestrator. 6 tools. 6 tools including Edit, Write, Bash"; "Can change files or run commands: Edit, Write, Bash") is the clearest wording of capability on the tab; it is only reachable on hover.
7. **Empty-state copy in the Role pane**: "No connections yet. A connection lets this role reach a service such as GitHub or Slack." and "No skills yet. A skill is a how-to this role can load when a task needs it." (shot 04). Plain, one sentence each.
8. **"Saved 07:12 AM"** as autosave evidence.
9. **The cost sentence in the tray** "Recommend asks the AI and counts toward your usage. Re-check setup is free." (the distinction between paid and free is exactly right; placement is the issue).
10. **The tray's recommendation cards**: source ("On this computer: Claude Code", "Curated · GitHub"), pinned version, exact command, "Needs: MOCK_FS_TOKEN", Apply / Dismiss, and the "Roles (1)" scope (shot 47 text). Dense but honest.
11. **Light theme** is consistent (shots 45, 46); no surface lost contrast in the surfaces I looked at.
12. **Auto-layout** exists and works (shot 42).
13. **Team tab badge "Team 3"** (suggestion count) lets suggestions be noticed from another tab (shot 47).

## (d) Missing, and should be removed or moved

### Looked for and did not find

- **Duplicate a role.** Wanted after "Docs Writer" (flow 2). Only Add role (empty) exists; a near-copy needs rebuilding tools, model and prompt.
- **Search or filter roles; a list/table view of roles.** Flow 9: 14 cards cut off in the chart; no other view.
- **Reorder, or sibling order control.** Layout order follows creation; no way to say "Reviewer first".
- **Bulk edit** (set model tier or tools on several roles at once). Flow 9: nine roles with identical defaults must be edited one by one.
- **A validation summary of team problems.** After my edits there were three roles with spawn rights and no reports (data check, flow 2), two roles with the placeholder description, a dashed not-delegable edge: nothing on the tab listed them.
- **A preview of a role's final prompt.** The inspector states "Responsibilities, the list of reports and the project brief are appended automatically at run time." (shot 06) but cannot show the result. The user must trust a sentence.
- **A "what is this tab for" line / role count / team name header.**
- **A legend** for edge colours, the warning triangle, "leads N", "not delegable", "Required".
- **A way to see connections and skills on the chart card** (flow 3).
- **A way to place a new role under a chosen parent without selecting it first** (except dev-only "Add a report" in the context menu).

### Duplicated controls (two or more controls doing the same thing)

| Job | Controls | Where seen |
| --- | --- | --- |
| Re-parent | Reports to select; drag from handle; (dev only) context menu "Add a report" for creating under a parent | shots 10, 14, 44 |
| Remove a role | Remove button in inspector; Delete key; (dev only) context menu "Remove role" | shots 16, 44 |
| Edit a role | Click node; Enter on node; (dev only) "Edit role" in context menu | shot 44 |
| Add a skill / connection | Role pane "Add a skill/connection"; Catalog "Add a skill/connection"; "Ask the Team assistant" x2 in Role pane; tray "Recommend"; sidebar MCP / Skill assistants | shots 04, 23 |
| Start from a prepared team | Templates > Replace; Import from other tools; Design > "Revise with the Architect" | shots 27, 31, 25 |
| Pick the current role | chart selection; tray "For"; the note "New roles report to X" | shots 10, 11 |
| Fit the chart | Fit control button; auto re-fit on resize; Auto-layout | shots 11, 42 |

### Controls whose purpose I could not work out from the screen

- The **tray gear** (unlabelled; leads to Project settings > Permissions > Team assistant, shot 26).
- **"Follow chart"** link next to the For select (appears only after changing For; shot 10).
- **"Required"** next to each delegate (shot 20).
- **"Advanced"** disclosure that shows as an expanded link in the Model block (shot 06) and contains the three Staffing selects (Staffing, Lowest tier, Highest effort).
- **Canvas style's seven graph styles**: what each changes about editing is not stated, only how it looks.
- **The warning triangle on the node and in the tools list** (hover only).
- **"leads N" at 0** on a role (shot 17) with no explanation.

### State that appears far from what caused it

- "Implementer can now create subagents, because New role reports to it." appears in the side panel, about a different role, after clicking a toolbar button (shot 08), and goes stale after re-parent (shot 13).
- "Role removed. Undo" appears in toolbar row 2, 700 px from the Remove button (shot 17).
- "New roles report to X" in the toolbar changes when a node is clicked (shot 04).
- "Saved 07:12 AM" at the top of the window, not near the edit (shot 08).
- The "Team 3" badge on the tab shows after a tray action (shot 47).
- The saved-template banner and the "agents found" / import banners push the chart down inside the stage (shot 29).
- Delegation change shows only as a dashed line on the chart; the checkbox is 1,000 px of scroll away (shots 20, 21).
- The tray's For target persists after the chart selection moved (shot 17).

### Wording that needed a second read

- "Team files changed, not committed" / "Commit team files" on an untouched project (shot 01).
- "Team files: in sync .orgai/ in this repository. Committed 15 team files." (shot 46).
- "New roles report to Implementer." (what is "new roles"? it is the Add role target).
- "What it can use" over "Tools / Connections / Skills" (the section name is correct, the label "Tools" then states "What this role may do on your files and shell.").
- "When should a manager delegate to this role?" as the label of the description field.
- "Nobody (root orchestrator)" as an option in Reports to.
- "May create subagents" (versus "leads N" on the card, "Delegation", "not delegable", "spawn" in the footer).
- "Tier and effort: Automatic, up to Everyday / high" and "No effort is set, so automatic picks may go up to high."
- "Follow the project (Automatic)", "Always as configured", "Lowest tier: No lowest tier", "Highest effort: Up to high (no effort set)".
- "Import from other tools" vs dialog "Import agents".
- "Replace the team with a template" with "You can undo until you edit the chart."
- "Team assistant" for Recommend and for Design (Architect) in the same tray.

### Should be removed or moved (each tied to a moment)

1. **Move "Team files" status and Commit out of the toolbar** (flow 8; toolbar row 2 shifts the chart, shot 46) to a quieter place (project header or the Settings page).
2. **Remove the confirm dialog or the undo row for Remove role** (flow 2: both appear for one reversible action, shots 16, 17).
3. **Move "Canvas style" out of the Team toolbar, or split it:** presentation and graph styles apply "across the app, including Live and Team" (shot 32); editing needs only Layout and one readable style (shots 33, 35).
4. **Remove or limit hive / constellation / subway as Team editing styles**; or keep tier, leads and tool count visible in them (shots 33, 35).
5. **Move the tray out of the vertical stack at 1024x640** (stage 237 to 330 px of 640, shots 03, 47). The tray is the biggest space cost on the tab and is the least used control.
6. **Move the tray gear to a visible label or into the tray body** (flow 5; it leaves the tab).
7. **Open on the Role tab** (or a team summary), not the empty Catalog (shot 01).
8. **Collapse the empty Connections and Skills blocks for a new role** to one line each (shot 04); put Identity and Model above them.
9. **Make the Delegation list a distinct, readable control** (shot 20) and remove the manager from a role's own delegate list (shot 22).
10. **Remove the "New roles report to X" note from the toolbar** as the way to state the Add target; show the parent at the point of creation (flow 2).
11. **Remove the info banner "X can now create subagents"** or make it reversible: the permission it describes stays after the cause is gone (flow 2, shot 17).
12. **Fold "Evaluate skills" and "Suggestions from past runs" into the Skills block** (shot 24).

## Keyboard pass (one, 1024x640, brief; a11y itself is out of scope)

Tab order from Add role: Import, Templates, Auto-layout, Canvas style, then all 14 chart nodes one after another (no skip), Zoom In, Fit View, then the tray (Recommend tab, gear, For, Recommend, Re-check, checkbox, then every card's Roles / Apply / Dismiss / Full command), then "Ask the Architect". The role inspector is last and a "Skip to role panel" link exists at the top. For a 14-role team, the path to the inspector is 20+ stops, and an open recommendation list adds about 15 more. Noted only as a flow cost.

## Not driven (and why)

- **Applying a template** (Replace team) and the template list with more than one entry: did not apply, to keep the walk state; only the dialog was opened and cancelled (shot 30). "Undo until you edit the chart" not exercised.
- **Import with real files**: fixture repo had no `.claude/agents` etc., so I saw only the empty state (shot 31). The "agents found" banner stack, import preview rows, conflicts and duplicate handling were not seen.
- **The team-files approval card that takes over the tray** (needs team files with a pending decision from a run or outside edit); the mock project did not produce it.
- **Connections and skills actually granted to a role** (the chooser, the "Needs sign in" path, the node capability line): only the empty states were seen, because granting needs the connection/skill flows; the e2e for those exists (`e2e/team.mjs`) and was not rerun.
- **Tools editing end to end**: I opened the editor (shot 09); my attempt to tick Edit with the driver did not change state, so I did not verify the node's changed tool count or warning.
- **Light theme at 1024x640**, and the Pocket Office in light: glanced at 1440 graph only (shots 45, 46).
- **Live runs, Pocket Office animation and the Design (Architect) session**: not reached; they spend tokens or need a run.
- **Real provider connections and model lists**: mock only; the model select showed Deep (opus) / Everyday (sonnet) / Fast (haiku) / Top (fable) tiers from defaults.
- **Screen-reader speech**: out of scope.

## Files written

- `docs/design/ux-review-team-tab-5.md` (this file).
- Screenshots and the driver under `e2e/shots/ux/team5/` (gitignored, not committed).
