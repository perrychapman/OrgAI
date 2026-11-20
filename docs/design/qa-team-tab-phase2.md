# QA: Team tab phase 2 (stress and edge cases)

Date: 2026-11-20. Build: worktree cut from dev at 5ca886b1, `npm run build` run by path (no install). Mock adapter, throwaway data dirs under the OS temp folder, no tokens spent. Driven with Playwright scripts kept outside the repo (OS temp). Screenshots are in `e2e/shots/` (gitignored), named below as `qaN-*`. Projects were seeded through `window.orgai.projects.save` (roles with long names, 50 roles, 0 roles); every other action went through the UI.

## Verdict: FAIL (one blocking defect, two should-fix)

The header, notice row, Undo, remove, tools, delegation, model sentence, files chip, canvas-style independence, keyboard activation and Layout menu held up under abuse. One defect blocks: the Add role path does not enforce the unique-ID rule, and duplicate IDs make the team files drop roles.

## Defects

### Blocks

**B1. Add role writes duplicate IDs (slugs); team files then lose roles.**
- Trigger: Add role with names whose ID collides: `Role-1`, `Role 1.`, `role_1` when `Role 1` exists (all become `role-1`); any name with no ASCII letter or digit: `!!!`, `???`, Arabic, CJK (all become `role`).
- Seen (script s15, window 1024x640): a 3-role team (`role-0`, `role-1`, `role-2`) plus those five adds gave 8 roles and the IDs `role-1` x4 and `role` x2 in the saved project. No duplicate-name warning appeared (the check is on the name, and the names differ). Then the Team files chip popover read "4 files are not in git yet" and listed only `.orgai/agents/role-0.md`, `role-1.md`, `role-2.md` and `.orgai/team.json`: five roles have no file of their own.
- Also seen (s3): adding `!!! ???`, `### $$$`, `مهندس`, `مدير` gave four roles with ID `role`.
- Contrast: renaming through the editor is correct. `Role 2` renamed to `Role 1` became `role-1-2`; renaming a role to Arabic then another role to CJK gave `role` then `role-2` (s14). Typing a taken ID in Details is refused ("Another role already uses this ID.", also for `ROLE-1`) and "An ID needs at least one letter or number." for `!!!` (s3).
- Where: the add path (`addRoleUnder` in `lib/roleOps`, called from `TeamView`'s Add role submit); the rename path uses the unique-ID helper and the add path does not. Inferred from behaviour, source not edited.
- Remedy: run the new role's slug through the same unique-ID rule the rename path uses (suffix `-2`, `-3`), and give names with no ASCII letter a stable fallback that is then suffixed.

### Should fix

**S1. Long unbroken names overflow the role card and run over neighbouring cards.**
- Trigger: a role named `W` x 200 (Add role accepts it, no cap) or `Senior Infrastructure ... WithAnUnbrokenTokenThatKeepsGoing1` (the name has no break point).
- Seen: `qa2-04-add-200-after.png` (1024x640 dark): the name and the ID line under it run past the right edge of the 220 px card. `qa6-01-deleg-root.png` and `qa6-05-deleg-cross.png`: names bleed onto the next card in a row of cards. The editor panel, notice row, delegation rows and Add role popover all clamped correctly; only the node does not.
- Remedy: `overflow-wrap: anywhere` plus a line clamp on the node name and ID, or an ellipsis.

**S2. Fit view cannot show a team of 12 or more roles; the stage is short.**
- Seen: 12 roles after "Arrange automatically" then Fit view: viewport scale 0.5 (the floor), Role 1, 3, 4 and others cut off at the stage edges, no scrollbars and no minimap (`qa4b-02-arranged-fit.png`, 1024x640; `qa5-03-waiting.png`, 1440x900, Role 3 and 4 half cut). 20 roles top to bottom: layout spans 1890 px against a stage about 850 px wide, so about half is off-stage; left to right spans 1053 px against 540 (`qa11-20-02-layout-left-right-20.png`). At 1024x640 the stage is 608x326 (Team assistant tray open plus side panel); the tray's height was not new in phase 2 (inferred).
- Impact: node text at 0.5 is about 5 px; a user has to pan by hand to reach a role; my own clicks on off-stage roles timed out (Playwright "outside of the viewport").
- Remedy: allow a lower min zoom in Fit view for large teams, or restore a minimap, or cap the tray.

### Polish

**P1. The tools summary does not say when a group is only partly on.** Only `Edit` ticked (group shows mixed) reads "Can change files." Edit plus Bash reads "Can change files and run commands." (`qa7-03-tools-mixed.png`). The sentence otherwise always matched the ticks (see Tools below). Also, `innerText` of the sentence has a double space after "Can" and after commas for elevated phrases: "Can  change files,  run commands and browse the web." (an inline gap I did not see on screen; check the accessible name).

**P2. "Arrange automatically" leaves no notice and no Undo.** It discards manual positions; the row kept showing the first-visit hint (s11, s4).

**P3. Selected node can sit under the zoom controls at 1024x640.** Role 4 selected, its card overlaps the zoom buttons (`qa7-03-tools-mixed.png`). The brief says the view pans clear of the controls.

**P4. Role pane header is two rows for a long name.** At 1024x640 the title is clipped with an ellipsis and Remove moves to its own row: about 110 px of the pane stays pinned (`qa6-05-deleg-cross.png`, `qa2-04-add-200-after.png`).

**P5. The ID field silently stops at 48 characters.** Typing 120 `a` kept 48 (s3 first run). No message.

**P6. The static "No problems" chip shows a green check while the files chip reports a problem** (`qa9-02-pop-warn.png`, where `.orgai/agents/role-1.md cannot be read`). Known placeholder; noted only for the pair.

## What held up (observed)

### Header (script s1, s13)
- Roles: 1, 5, 12, 50. Project names: 60 characters ("A very long project name that goes..."), and 50 `N`. Window: 1440x900, 1200x800, 1024x640; light and dark. The window will not go narrower than 1008 content px (setContentSize(900/800/700/600) came back as 1008x640/615), so 1024 is effectively the narrowest.
- Always one row, 28 px high (top 56, bottom 84) at every size; Add role right edge inside the header (1068 at 1440, 652 at 1024), never hidden or overlapping. At 1200 and below the header goes compact (Layout, Start from and the files chip become icons). The page title stays "Team"; the long project name truncates in the project bar only. Count text: "1 role", "12 roles", "50 roles".
- 200% zoom (webContents zoom 2 at 1440x900, and 1.5 and 2 at 1024x640 which is a 512x320 CSS viewport): header still one row, Add role at right 460 of 512 CSS px, no horizontal page overflow. Screenshots at zoom came out cropped to the top-left (tooling), so this is geometry only. The Add role popover at 200% on 1024x640 measured 140..460 by 31..311 inside 512x320.
- Popovers at 1024x640: Add role 332..652 x 90..370; Layout 251..475; Start from 483..783 x 88..381 (it extends over the side panel); files popover 197..557, 324 to 448 px tall with a scroll bar, all inside the window.

### Add role (s2, s14, s15, s16)
- Empty and whitespace-only: the submit button is disabled. `role 1` while `Role 1` exists: "There is already a role called role 1. Pick another name." and disabled (`qa2-02-add-dup.png`).
- 200 characters, emoji with ZWJ, Arabic, `<img src=x onerror=alert(1)><b>bold</b>`: all added, shown as text (no markup, no script), notice text clamped with ellipsis for 200 W and Undo still reachable (`qa2-04-add-200-after.png`).
- Enter twice quickly: one role. Opening the popover and changing the selection: the "Reports to" value stayed on the first parent (my chart click was blocked by the popover; so the selection-change case could not be exercised that way). 20 adds in a row: 20 roles, 20 unique role ids, 20 unique slugs for ASCII names (the duplicate-slug result is B1). Adding under a leaf: helper text "Role 4 will be able to hand work to other roles. You can change that on Role 4." and the leaf did become a manager (canSpawn true, report listed). Zero-role project: header "Team | 0 roles | No problems | Add role", popover "The first role becomes the top of the team." with "Add first role", notice "Added New role as the top of the team."

### IDs and grants (s3)
- Renaming `Role 2` to `Role 1` gave ID `role-1-2`; the server grant `qa-docs` (listed against `role-2`) moved to the role (`mcpServers: ['qa-srv']`) and stayed after renaming again, after switching to Settings and back, and after an app restart (relaunch on the same data dir).

### Notice row, Undo (s4, s4b, s5, s12, s16)
- Measured before and after every action (add, re-parent, remove with and without dialog, drag refusal, Undo, template save): the stage box, notice row box and header box never changed (stage 56,93 608x326; notice 68,609 584x31 at 1024x640).
- Each Undo undid its own action: add A1 then re-parent Role 5 then Undo returned Role 5 and kept A1; remove leaf then add A2 then Undo removed A2 only; remove manager Role 1 (3 reports: dialog "Remove Role 1? | Its 3 reports move up to Role 0.", `qa4-*-remove-confirm.png`) then Undo restored all four relationships and the manager's delegation (the manager's canSpawn true again with its report listed).
- Refused drag onto the root: "Role 0 is the root and cannot report to anyone." (error, short-lived, replaced the Undo with "+1"). Drag that would form a loop: "Role 6 cannot report to Role 7: Role 7 already reports to Role 6." The "+1" popover listed the waiting re-parent message with its Undo; after the error expired the Undo came back and restored Role 7 under Role 2.
- Add then Save as template: the saved notice ("Saved the template T T T ... .", name clamped) took the row and the add's Undo moved under "+1" (no Undo button visible in the row until the saved notice ends). Add then wait 13 s: the row returned to the hint and the new role stayed.
- Double Delete key on a focused role removed one role; two rapid clicks on Undo gave a consistent tree with unique ids.
- The first-visit hint reappears whenever the row is empty until "Got it" is pressed; after "Got it" and an app restart the row stays empty (`orgai.teamHintSeen = 1`), and the Layout choice persisted (`orgai.teamLayout`).
- Remove with 3 reports, not 5 (see not exercised).

### Tools (s7)
- Each group on and off; the stored tools list, the three-state checkbox and the summary agreed every time: read only, all off ("No tools. It can only answer from what it is told."), change on (`Edit,Write,NotebookEdit`), run on (+`Bash`), web on, plan on, only `Edit` (mixed), `Edit`+`Bash`. Space and Enter open and close "Choose individual tools"; Space and Enter on "Edit tools"/"Done" toggle editing.

### Delegation (s6, s6b)
- Manager with 14 reports, names of 100+ characters with an unbroken token, side panel 349 px wide at 1024x640: names ellipsize with the full name in the title attribute; no element wider than the pane (`n: 0` measured). "Can hand work to other roles" off (canSpawn false, section collapses to its one sentence) and on again restored 13 delegates and the required report. "Always involve" ticks stored as `requiredReports`; un-delegating a role dropped it from `requiredReports` too. Cross-branch: "Roles on other branches (13)" opened with Space, two ticks gave the chip "2 on other branches" and the roles moved into the manager's spawnable list.

### Model (s7)
- Options: Inherit, Top (fable), Deep (opus), Everyday (sonnet), Fast (haiku). The sentence matched each: "Uses the same model as Role 1.", "Runs on Top (fable). OrgAI chooses how much effort per task.", ..., effort low to max: "...up to max.", Fixed: "Always runs on Fast (haiku) at max effort." Stored model, tier and effort agreed. "Default" and "Auto" staffing read the same.

### Team files chip (s8, s9)
- Fresh project: "Team files: not committed", popover "31 files are not in git yet." with eight paths and "and 23 more" (30 roles). Commit confirm "Commit 31 team files?" stays inside 1024x640 (292..732 x 134..506) with the confirm button visible; "Committed 31 team files." then chip "saved". Edit after commit: "9 files are not in git yet" (the edited role, its manager and its six reports; plausible). With broken files (six 70-character names, one with a right-to-left override, one overwritten by hand): chip danger, popover "Team files: .orgai/agents/role-1.md cannot be read", the override character is shown as `‮`, list scrolls (`qa9-02-pop-warn.png`). I did not see the commit confirm with warnings because the chip offered no action in the problem state.

### App-wide canvas style (s10)
- Default, Blueprint, Constellation (radial, compact), Subway (left to right, station), Terminal, Paper, Hive (hex), minimap on, Pocket Office and Factory floor set in settings: Team always had role card nodes (`react-flow__node-role`, 148x76 px at fit), top to bottom, no canvas element. Add role and rename under Pocket Office and Factory floor worked. I reset it to default.

### Keyboard (s12)
- Layout, Start from, Add role and the files chip each open on Space and on Enter and return focus to the trigger on Escape. Details and "Model and effort" disclosures toggle with Space and Enter. Space on a focused node selects it and the pane opens (swallowed-Space regression not present).

### Layout menu (s11)
- 4 and 20 roles: Top to bottom, Left to right and Arrange automatically gave 0 overlapping cards in each (the seeded layout had 6 overlaps with 20 roles; arrange fixed them). The menu shows the current direction checked; the direction survives restart. Fit-view limits are S2.

## Not exercised
- Panel narrower than 349 px (no way found to resize it); width below 1008 px (the window refuses); real 200% zoom screenshots (tooling crops them).
- A manager with exactly 5 reports being removed (did 3). Add role from the node menu and the editor's Add a report. Drag re-parenting at 1024x640 (done at 1440x900 only).
- Light theme: header and chart geometry at 1440 and 1024, one 1024 screenshot (`qa13-07-zoom-light-1024-z1.png`); popovers, notice row, files chip and editor were not looked at in light.
- Screen reader speech (notice row, mixed checkboxes); Start from items beyond opening the menu (Architect, import); a real error from a failed save; Undo after an app restart; unknown tool names on a role (not in the five groups) kept or dropped.
- Two Undo-order cases where the same role is edited twice inside 12 s (only one edit slot exists by design, so a first edit's Undo is gone once a second edit posts).

## Files touched
- Added `docs/design/qa-team-tab-phase2.md` (this file). No source edited. Scripts are outside the repo (`%TEMP%\qa\*.mjs`); screenshots written to `e2e/shots/qa*.png` (gitignored); `out/` built locally (ignored).
