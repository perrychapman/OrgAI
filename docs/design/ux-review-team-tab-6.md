# UX review: the Team tab, sixth walk (after overhaul phase 2)

Reviewer: UX Researcher. Analysis only, no code changed. This is the "after" walk for `ux-review-team-tab-5.md` (the "before").

- Build: dev at `5ca886b1` (merge of the Team tab phase 2 build), `electron-vite build` run from the worktree against the shared tools in the main checkout (no install, no link). Driven with a polling command-file driver on `e2e/lib.mjs` (`e2e/shots/ux/team6/repl.mjs`, gitignored, not committed).
- Run: `ORGAI_MOCK=1`, throwaway data dir, throwaway fixture git repo under the system temp folder (the team-files commit went to that fixture only). Project "Walk", default team: Orchestrator, Implementer, Reviewer, Researcher. No tokens spent.
- Sizes: 1440x900 (main walk) and 1024x640. Themes: dark throughout, a light pass at 1440x900 only (shots 45 to 49). One keyboard pass at 1024x640 (dark). Accessibility is not the focus, so the keyboard pass is limited to header order and popover focus.
- Spec: `docs/design/team-tab-overhaul.md` sections 0 and 1 (acceptance list 1.10, "As built" 1.14).
- Shots: `e2e/shots/ux/team6/NN-name.png` (gitignored). Names are quoted as "shot NN" below.
- Severity: **blocks** (cannot finish or is misled into a wrong result), **slows** (works, needs a second read or a detour), **polish**.
- Everything below was seen on screen unless marked *(inferred)*. Nothing is inferred in the tables except where stated.

## (a) Verdict

Yes, this is clearly better than walk 5, and the part that changed is now cohesive: one header row reads "Team, 4 roles, No problems, Layout, Start from, Team files: not committed, Add role", the only way to add a role is one small popover that asks "Reports to" before you commit, the editor reads top to bottom as the questions a new user has (who it is, what it does, what it can use, who it can delegate to, model), and every wording trap I listed in walk 5 that I re-checked is gone. The two worst walk 5 failures, the silent permission change on the manager and the drop-on-the-node that did nothing, no longer happen. The tab as a whole is not cohesive yet, because the old design still sits directly beside the new one: the side panel still opens on an empty Catalog tab, the "Team assistant" tray (with its own purple primary button, its own "For" role picker and a Design tab that duplicates "Start from > Redesign with the Architect") takes a third of a 640 px window, and the chart still cannot show a 14-role team (cards cut off at both edges at the minimum zoom, edges tangled, no re-layout after a move). The new notice row is the right idea and never moved the chart, but it has one stale message that never expires and its re-parent message is too long to read where it matters.

## (b) Walk 5 top findings: status now

| # | Walk 5 finding | Status | Evidence now |
| --- | --- | --- | --- |
| 1 | Tab opens on the empty Catalog tab, not the role or the team | **Open** (phase 3) | Shot 01, 02: right panel opens on "Catalog": "What the whole team can draw on. Open a role to choose what it uses." Skills 0, Connections 0. After removing a role the Role tab says "No role selected / Select a role on the chart to edit what it can use." (shot 13). |
| 2 | Nothing says what the screen is for; no title or count | **Partly** | Title "Team" and "4 roles" now exist (shot 01). No sentence of purpose; the first-visit hint (below the chart) teaches how to edit but not what the tab is. |
| 3 | No primary action; six same-weight buttons | **Fixed in the header, open on the tab** | "Add role" is the only purple button in the header. The tray's "Recommend tools and skills" and the Catalog's "Add a skill" / "Add a connection" are still purple (shot 01). A DOM count of visible primary buttons in the Role view found two: "Add role", "Recommend tools and skills". |
| 4 | Untouched project says "Team files changed, not committed" with a Commit link | **Partly** | Now a quiet chip "Team files: not committed" (shot 01) and a popover that explains in one sentence and lists the files (shot 23). It still says "not committed" on a project the user has not touched, but it no longer asks for action. |
| 5 | Add role goes under whatever is selected, signalled only by a toolbar note | **Fixed** | Popover has a labelled "Reports to" prefilled with the selected role (shot 04) and the helper "Implementer will be able to hand work to other roles. You can change that on Implementer." |
| 6 | Adding a role silently gives the manager permanent delegation | **Fixed** for add. **New related issue** for re-parent (N1) | Disclosed before the click in the popover; no "can now create subagents" text anywhere (text scan of the whole Team view found no "subagent", "spawn", "leads", "Required", "Nobody", "May create", "Tier and effort"). |
| 7 | New node appears under the tray; chart does not follow | **Fixed** at 1440, **partly** at 1024 | Shot 05: chart re-fits and the new role is selected and visible. At 1024 with 15 roles the new role is visible but placed far from its manager (shot 44). |
| 8 | Description and Reports to are 600 px down, below empty states | **Fixed** | Shot 04/05: "Who it is" first: Name, "What is this role for?" (focused after Add), "Reports to", Color. Empty Connections and Skills are one line each (shot 06). |
| 9 | Model is two controls plus a three-select Advanced block | **Partly** | One sentence "Runs on Everyday (sonnet). OrgAI chooses how much effort per task." and one select (shot 09). The staffing selects are now behind two stacked fold labels, "Advanced" and "Staffing details" (N8). |
| 10 | Tools editor lists raw names with unexplained warning triangles | **Fixed** | Five groups with a plain sentence, raw names beside, chips "Can change files" and "Can run commands" (shot 07). Summary sentence "Can read files, run commands and browse the web." with "run commands" in warning colour (shot 08). |
| 11 | Dragging onto the middle of a node does nothing | **Fixed** | Shot 11, 12: dropped on the card body; Docs Writer moved to Implementer and the notice said so. |
| 12 | After re-parenting the chart does not re-lay out (long diagonal edge) | **Open** | Shot 10, 12: Docs Writer stays in its old column with a long curved edge. Same after drag. |
| 13 | Remove asks twice and Undo appears far from the button | **Partly** | No confirm for a role without reports (shot 13). Confirm kept for a role with reports: "Remove Implementer? Its 3 reports move up to Orchestrator." Undo is now in the notice row at the bottom of the window, still about 750 px below the Remove button at 1440x900 (N9). |
| 14 | "leads 3" disagrees with the dashed "not delegable" edge | **Fixed** | Shot 16: unticking "Can delegate to it" for Reviewer changed the card to "Delegates to 2" and the dashed edge is labelled "Cannot delegate". |
| 15 | Delegation grid collapses and overlaps at 4+ roles | **Fixed** | Shot 15, 38: direct reports one row each with "Can delegate to it" and "Always involve"; 7 direct reports and 7 others on other branches stay readable. |
| 16 | A role's own manager is offered as someone to delegate to | **Not re-checked** | I opened Orchestrator (no manager) and a leaf with delegation off only. |
| 17 | Role and Catalog use different words; Catalog is role-blind | **Deferred** (phase 3) | Unchanged. |
| 18 | Tray costs a third of the window; at 1024x640 chart gets 237 to 330 px | **Deferred** (phase 3) | Shot 02, 40: stage 326 px high of 640, tray 214 px. Phase 2 added a 31 px notice row under it. |
| 19 | Tray gear leaves the tab; Design vs Architect confusion | **Deferred**, now doubled | "Start from > Redesign with the Architect" and the tray's "Design" tab both exist (shot 01, 17). Not opened the Design tab. |
| 20 | Templates, Import, Design: three entry points for "start from a prepared team" | **Partly** | Templates and Import are now one menu with four items (shot 17); Design tab still in the tray. |
| 21 | Canvas style and Pocket Office inside the Team toolbar | **Fixed** | Not in the header (shot 01). |
| 22 | Team files line in the toolbar shifts the chart | **Fixed** | Chip in the header; stage and notice rectangles were identical before and after add, remove, undo, template save and commit (measured each time: stage `232,93,848,536`, notice `244,869,824,31`). |
| 23 | 14 roles: cards overlap on add; Auto-layout plus Fit still cut off | **Partly** | No overlap on add now. But see N3: edges tangle, Arrange automatically gives a layout wider than the stage at the minimum 0.5 zoom (shot 33, 34). |
| 24 | No list or table of roles | **Deferred** (phase 4) | None. |
| 25 | Import button hides what it will find; label differs from dialog | **Fixed** | Menu shows "None found" (shot 17) or "3 found" before the click (shot 27); dialog title "Import agent files" matches. |
| 26 | Replace-with-template dialog has no preview | **Fixed** (flat list) | Shot 22: right column lists the roles numbered, "top" marker, "Replaces your 5 current roles. You can undo until you change a role." No tree. |
| 27 | Wording: "Nobody (root orchestrator)", "May create subagents", "Required", "Tier and effort", "Team files: in sync .orgai/ ..." | **Fixed** | All replaced (shots 15, 09, 23). One leftover set in the import dialog (N7). |

## (c) New findings

### Slows

**N1. The re-parent notice is too long, is cut off where the important part is, and reports two silent permission changes after the fact.** (1440x900, 1024x640)
Evidence, after changing "Reports to" to Researcher (shot 10): "Docs Writer now reports to Researcher. Reviewer no longer delegates to Docs Writer. Researcher can now hand work to other roles, because Docs Writer reports to it. Reviewer can no longer hand work to other roles: no role is left to delegate to." The row shows the first ~110 characters then "because..." (full text only in the tooltip), so the sentence that says a second role changed its permissions is the one that is clipped. The same four sentences appear after a drag (shot 12). The user chose one thing (a manager) and two other roles changed what they can do; walk 5 flagged this exact pattern, and phase 2 fixed it for Add (disclosed before) but not for moving. Recommended copy: let the notice be one sentence, "Docs Writer now reports to Researcher.", with a "Details" or "What changed" button that opens the four lines in a popover; and put the helper line "Researcher will be able to hand work to other roles." under the Reports to select in the editor, as the Add popover does.

**N2. A stale message "Undo ended because you changed a role." never expires and holds the notice row.** (both sizes)
Evidence: after "Imported 3 roles ..." and then adding a role, the row read "Undo ended because you changed a role." with a green check and an x, and stayed there through six further adds (shots 31, 33, 36, 38, 45) until I dismissed it by hand. During the first add after the import the row showed that message and "+1" instead of "Added Frontend Dev under Implementer." (my log of the six adds: "Undo ended because you changed a role. +1", then "Added Backend Dev under Implementer. +1 Undo", and so on), so the confirmation for the action I had just taken was the thing hidden. It also keeps the first-visit hint away. Recommended: drop it, or give it the same 8 s timeout as "Saved" messages and never rank it above the add the user just made. If it stays, copy: "The import can no longer be undone."

**N3. A moved role is not re-laid out, and a 14 to 15 role team still cannot be seen whole.** (both sizes)
Evidence: after "Reports to" or a drag the card stays in its old column with a long diagonal edge (shots 10, 12). After adding roles under different managers, new cards land away from their manager and edges cross the whole chart (shot 31). Layout > "Arrange automatically" produces cards 110x56 px at zoom 0.5; the viewport transform reported `scale(0.5)`, the zoom-out control is disabled, the Fit control changes nothing, and the first and last columns are cut off (shot 33, 34: "-auditor" at the left edge, "Implement..." at the right edge). "Left to right" is cut vertically instead (shot 36). At 1024x640 the stage is 608x326 and shows about 8 of 15 roles (shot 40, 44). This is the walk 5 chart finding, partly improved (no overlap), not solved. Recommended one-line fixes: re-lay out the moved branch after Reports to or a drop (spec 4.6 already asks for it), and let Fit go below 0.5 or wrap wide levels.

**N4. "No problems" is a static placeholder that reads as a verdict.** (both sizes)
Evidence: the chip says "No problems" with a check on a team where several roles still have the seeded description "Describe when a manager should delegate to this role." and one has a dashed "Cannot delegate" edge (shot 16, 31). At 1024x640 it is only a circled check with no text (shot 02), so a first-time user cannot tell what it means. It is not clickable. Recommended: hide it until phase 4 is live, or label it "Team check: not run yet".

**N5. At 1024x640 the three secondary header controls are unlabelled icons that look alike.** (1024x640)
Evidence: shot 02: Layout and Start from are two outlined rounded squares with different grids; the Team files chip is a document icon; the problems chip is a circled check. The accessible names are right ("Start from", "Team files: not committed", "Layout") but I did not hover to confirm visible tooltips *(not checked)*. A first-time user at the supported minimum size has to open each one to learn what it is. Recommended: keep the text on "Start from" at 1024 (the header has 584 px and the text costs about 70 px; at 1024 the space between the count and the buttons in shot 02 is about 250 px).

**N6. The import count does not go down after importing.** (1440x900)
Evidence: menu said "3 found" (shot 27), I imported 3 roles, and the menu still says "3 found" (shot 42, 48). Opening the dialog again would offer the same three roles *(inferred; I did not open it a second time)*. Recommended: show "3 found, 3 already imported" or "None new".

**N7. Old wording survives in the import dialog.** (1440x900)
Evidence (shot 29): tabs "Add to the chart" and "Replace the chart", text "Adds 3 roles next to the 5 you have.", "roles without a hierarchy report to the orchestrator", and per role "Automatic, up to Everyday / high. No effort is set, so OrgAI may use up to high effort." (the old model phrase that the editor no longer uses). The primary says "Import 3 roles". Recommended: "Add to the team" / "Replace the team", and the same one-sentence model line as the editor.

**N8. The Model section has two stacked folds and an open one at 1024x640.** (both sizes)
Evidence: shot 09: after "Runs on Everyday (sonnet)..." and the Model select there is a link-styled "Advanced" with no triangle, then "Staffing details" with a triangle. The "Model and effort" heading has a chevron that points down (open). At 1024x640 the section is open with its sentence and select (shot 40, 44) although the spec folds it on short windows. Recommended: delete the "Advanced" label; keep "Staffing details".

**N9. The Remove button and its Undo are 750 px apart.** (1440x900)
Evidence: Remove at the top right of the panel (y 138), "Removed Docs Writer. Undo" at the bottom of the window (y 885) (shot 13). The chart also shows the role gone, so the feedback is visible, but the Undo is not where the eye is. Same for "Added ..." (shot 05). Walk 5 listed this as "state far from the cause"; the notice row is more reliable than the old toolbar row (it never moved the chart) but is not nearer. Recommended: nothing structural; consider also placing the notice at the top of the chart stage, where the chart is.

### Polish

**N10. "Add a report" from the right-click menu opens the popover at the header button, not at the role.** Shot 54: popover at x 748, y 90; the clicked role is at x 601, y 203. Prefill is right ("Researcher"). Recommended: anchor to the node.

**N11. The tray has its own "For" role picker in a different order.** Tray "For" lists roles in creation order, flat (Orchestrator, Implementer, Reviewer, Researcher, Docs Writer, api-designer, ...); "Reports to" and Add role list them as an indented tree. It now follows the chart selection (shot 04: switched to Implementer by itself), which is better than walk 5, but a second role picker remains beside the editor.

**N12. "Roles on other branches" on the root includes its own grandchildren.** Shot 16: Orchestrator's "Roles on other branches (1)" lists Docs Writer under "Implementer branch". The warning sentence ("skips the roles in between") fits, the heading does not. Recommended: "Roles further down (1)" for descendants, keep "on other branches" for the rest.

**N13. The first-visit hint is useful once and quiet.** It appeared only when nothing else was in the row (shot 01, 51), said "Click a role to edit it. Drag from its bottom handle onto another role to change who it reports to. Right-click a role for more." with "Got it"; after "Got it" and a reload the row stayed empty. It is the only place the drag is taught, and dropping on the body now works. Keep. It should not be hidden behind N2.

**N14. The Add popover's duplicate-name error works (shot 55).** "There is already a role called reviewer. Pick another name." with Add role disabled. Noted as a keep, not an issue.

## (d) Acceptance checklist 1.10, line by line

Legend: seen-pass, seen-fail, not checked. "Part" lines say what was and was not seen.

| # | Criterion | Result | Notes |
| --- | --- | --- | --- |
| 1 | Header one row at 1440x900 and 1024x640; Team, count, No problems, Layout, Start from, files chip, Add role; none of Canvas style, Templates, Import, Auto-layout | **seen-pass** | Shots 01, 02. At 1024 four items are icon-only (N5). |
| 2 | Exactly one primary-colored button visible on the tab | **seen-fail** | Header passes; the tray's "Recommend tools and skills" is also primary (known, phase 3). |
| 3 | Add role popover: Name selected, Reports to prefilled; Reviewer + Enter adds under Reviewer, selects, opens editor, focus in "What is this role for?" | **seen-pass** (part) | Prefill seen with Implementer selected (shot 04); add under Reviewer and focus in `#role-description` seen. Default to the root with nothing selected not opened. |
| 4 | Notice "Added ... under Reviewer." with Undo; Undo removes it; notice row height unchanged | **seen-pass** | Text is "Added Docs Writer under Reviewer." (shot 05). Undo restored the count 16 to 15. Stage and notice rectangles identical before and after. |
| 5 | No "can now create subagents" anywhere after add or re-parent | **seen-pass** (with N1) | Sentence gone. Re-parent prints "can now hand work to other roles, because ..." (new words, same side effect). |
| 6 | Start from: four items; "None found" with no files; "3 found" with `.claude/agents` fixture; dot gone after opening | **seen-pass** | Shots 17, 26, 27, 28. "3 found" persisted after import (N6). |
| 7 | "Use a template..." disabled with the reason when none; "1 saved" after saving; dialog preview lists role names and "Replaces your N current roles." | **seen-pass** | Disabled text: "No templates yet. Save this team as one first." Shot 17, 22. Preview "Replaces your 5 current roles." (the team then had 5). |
| 8 | Architect dialog opens; no "Advanced: quick draft" anywhere | **seen-pass** (part) | Dialog seen (shot 19). Tray's Design tab was not opened. |
| 9 | Team files chip "Team files: not committed" neutral; popover lists files; Commit opens confirm; Cancel changes nothing; confirm shows notice and chip becomes "Team files: saved" | **seen-pass** | Shots 01, 23, 24, 25. Confirm "Commit 6 team files? ... Nothing is pushed." Fixture log gained one commit "Update OrgAI team files" only after confirming. Focus returned to the chip. |
| 10 | Footer hint sentence gone; first-visit hint with "Got it"; gone after reload | **seen-pass** | `orgai.teamHintSeen` set to "1". A visually hidden description of the chart still carries the old keyboard sentence (seen in the text dump, not on screen). |
| 11 | Editor order Who it is, What it does, What it can use, Who it can delegate to, Model and effort; no "Nobody" for a non-root | **seen-pass** | Shots 04 to 09; options list for a non-root role starts at "Orchestrator". |
| 12 | New role's Connections and Skills one line each | **seen-pass** | Shot 06: "Connections None yet [Add]", "Skills None yet [Add]". |
| 13 | Tools: five groups with raw names; ticking Run commands turns on Bash; "Choose individual tools" lists all 12; summary changes with warning colour and icon | **seen-pass** (part) | Shots 07, 08, 49. Individual-tools fold not opened. The summary change was seen; I did not verify Bash itself changed (the card count went 3 to 6, which is consistent). |
| 14 | Delegation: direct reports first with the two checkboxes; own manager not listed; "Roles on other branches" closed by default with its warning | **seen-pass** (part) | Shots 15, 16, 38. A mid-level role's own manager not checked. |
| 15 | Model: one sentence, one select; "Staffing details" closed with renamed labels; no "Tier and effort", "Follow the project", "Lowest tier", "Always as configured" | **seen-pass** | Scan of the editor: none present. Import dialog keeps a similar old phrase (N7); the extra "Advanced" fold (N8). |
| 16 | "Preview final prompt" visible and disabled with "Not available yet." | **seen-pass** (part) | Visible and disabled (shot 06). The hover text was not tried. |
| 17 | Remove without reports: no dialog, notice with Undo; with reports: confirm with new body | **seen-pass** | Shots 13, 52. |
| 18 | Both themes: readable contrast; spot-check with the contrast checker | **seen-pass** (part) | Chip, popovers, group rows and warning chips read cleanly in light (shots 45 to 49) and dark. I did not run a contrast checker. |

Tally (18 lines): **11 clean seen-pass** (1, 4, 5, 6, 7, 9, 10, 11, 12, 15, 17), **6 seen-pass with a small part not checked** (3, 8, 13, 14, 16, 18), **1 seen-fail** (2, known: the tray is still primary).

## (e) Flow notes (what a first-time user meets)

- **Flow 1, land on a fresh project.** Better, not yet clear. The header names the tab and the next action is the one purple button in it. But the right panel is still the Catalog (N: finding 1), the chart sits in a large empty stage, and a third of the window is the tray; the first-visit hint is at the very bottom. Time to find where to start: one read, no wrong click (walk 5: one read plus one wrong click). Chip "Team files: not committed" no longer alarms.
- **Flow 2, add, describe, tools, model, move, remove, undo.** One pass without a wrong turn. Add role to the described role with tools and a model: 6 actions on mock data, no detour, versus walk 5 where I put a role under the wrong manager and had to scroll 600 px. What still surprises: moving a role leaves the card where it was (N3), and the re-parent message (N1).
- **Flow 3, what a role can do.** Much clearer in the editor: the tools sentence, "Can hand work to other roles", "Delegates to 2" on the card matching the dashed "Cannot delegate" edge. The card still shows only a tool count and warning triangle, no connections or skills (phase 5).
- **Flow 4, Start from.** Descriptions and counts tell what will happen. Cancelled out of Import (empty), Architect and Save as template and Use a template. Not started the Architect.
- **Flow 5, Team files.** Fresh project: neutral chip, popover with the one sentence and the file list, a confirm that lists the same files and says what it will and will not do.
- **Flow 6, notice row.** Feedback appears at the bottom, not where the pointer is, but the chart never moved in any of ten sequences (add, undo, remove, undo, re-parent, drag, template save, commit, import, hint). The first-visit hint is useful and quiet.
- **Flow 7, 14 roles (15 at the end).** Header unchanged at 14 roles ("14 roles"). Reports to and Add role's Reports to show the tree indented (readable, shot 39 text). Orchestrator's delegation list with 6 direct reports and 7 more under "Roles on other branches" is readable. The chart is the problem (N3). Panel scroll height for the root with the delegation fold open: 2228 px.

## (f) What still feels like leftovers of the old design

1. The side panel's Role | Catalog tabs and the Catalog-first landing, with "No role selected" text in the new voice nowhere near the new editor.
2. The tray: second purple primary, its own role picker (N11), cost sentence, and a Design tab beside the new "Start from > Redesign with the Architect".
3. The chart: no list, no legend, card shows tool count only, cards shrink to 110x56 px for a larger team, no re-layout after a move.
4. The import dialog's "chart" and "Automatic, up to Everyday / high" phrases (N7).
5. "Advanced" label in the Model section (N8).
6. The "No problems" chip that does nothing (N4).
7. The chart's visually hidden description still has the old Shift+F10 / Delete sentence, which also says "With a reporting line selected, Delete makes its role report to Orchestrator instead." (seen in the text dump).

## (g) What I could not reach and why

- **Phase 3 to 5 parts** (suggestions drawer, panel overview, list view, capabilities, legend): not built.
- **The tray's Design tab and Recommend results**: not opened (Recommend spends tokens on a real provider; on mock it was out of scope for this walk).
- **Starting the Architect from "Start from"**: cancelled at the dialog; the session opens on Live and I did not follow it.
- **Applying a template and its Undo**: opened the preview and cancelled; not applied.
- **Team files "pending", "problem", "off", "differ" states and the Applied-from-files Undo**: the mock fixture only produced "not committed" and "saved". The non-git case was not tried.
- **Add role with nothing selected (default to the root) and the empty project ("Add first role")**: not opened.
- **Delegation list of a mid-level role (own manager not listed) and "Choose individual tools"**: not opened.
- **Hover tooltips on the icon-only header at 1024x640**: not hovered.
- **Light theme at 1024x640**: not walked (light at 1440x900 only).
- **Contrast checker, screen reader speech**: not run.
- **Shift+F10 on a focused node**: not tried; right-click menu seen (shot 53: "Edit role / Add a report / Remove role").

## Files written

- `docs/design/ux-review-team-tab-6.md` (this file).
- Screenshots and the driver under `e2e/shots/ux/team6/` (gitignored, not committed). The fixture repo (`orgai-e2e-team6-*`) is left in the system temp folder; the data dir is removed by the driver on exit.
