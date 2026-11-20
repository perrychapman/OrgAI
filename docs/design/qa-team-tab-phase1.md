# QA: Team tab phase 1 defect fixes (D1 to D8)

Date 2026-11-19. Build: `npm run build` of the worktree cut from dev at 73b87c1b (commit 8b31a5f3 on top). Mock adapter
(`ORGAI_MOCK=1`), throwaway data dir, fixture git repos under the OS temp folder, no tokens. Driven through Playwright
(`e2e/lib.mjs` helpers, scratch driver in the gitignored `e2e/shots/qa/`). Windows 11. Screenshots are in the gitignored
`e2e/shots/` (names below; the D5 ones are `qa_d5_<style>_<from>_<to>.png`). Typecheck, unit suite, build gate and the
e2e scripts were not run (the brief assigned them to the main checkout).

Sizes: 1440x900 and 1024x640 content size. Themes: dark and light (switched with `data-theme` on `<html>`; the light
checks cover the delegation list and the commit confirm only, see "Not exercised").

## Verdict: pass with issues

All eight fixes behave as described on the paths I tried. No data loss, no wrong banner, no overlap between roles from
Add. Two things should be fixed (a new role can sit under the zoom controls; the commit confirm ignores the visible
"Keys must not be committed" warnings) and the rest is polish.

## Per item

### D1 Spawn rights follow delegation: pass
Project "QA Team", 1440x900 dark. State read from `window.orgai.projects.list()`, chip text from the nodes, banner text from
the inspector and `team-undo-row`.
- Add under Implementer (inspector "Add a report"): Implementer `canSpawn=true spawnable=[New role]`, chip "leads 1", banner
  "Implementer can now create subagents, because New role reports to it." (`qa-d1-1-added.png`).
- Drag New role to Reviewer: Reviewer on, Implementer off; banner "Reviewer can now create subagents, because New role
  reports to it. Implementer can no longer create subagents: nobody it may delegate to is left." Chips: only Reviewer "leads 1".
- Drag to Researcher: same pattern, Reviewer off, Researcher on (`qa-d1-3-moved-to-researcher.png`).
- Remove (confirm "Remove New role? You can undo this for a few seconds."): Researcher off, undo row reads "Role removed.
  Researcher can no longer create subagents: nobody it may delegate to is left." Undo: Researcher `canSpawn=true
  spawnable=[New role]`, chip "leads 1" back, row gone. Remove again: same as the first removal.
- Reviewer ticked by hand with no reports: stays ticked through the later add/remove of other roles (no chip, as the chip is
  hidden at 0).
- Implementer with two reports, remove one: stays on, chip "leads 2" to "leads 1", row reads only "Role removed." Remove the last:
  off, banner names it. Undo of that: restored (`qa-d1-11-undo-last`).
- Every banner matched the stored state at that moment. A banner is replaced, not stacked, by the next change (adding a second
  report removed the earlier "can now create" text, as designed).

### D2 New roles do not overlap and are visible: pass with one defect
Geometry measured from the DOM after each add: pairwise node box overlap, selected node inside `.frame-stage`, selected node
against `.react-flow__controls`.
- 10 under the root, 1440x900 top-down: no overlaps, new node always inside the stage at the same on-screen spot (the view pans,
  never zooms; node width stayed 156). Roles run in one row to the right (14 siblings); `qa-d2-10-root-1440.png`.
- 10 under the root, 1024x640: no overlaps, inside the stage.
- 5 under a manager, 1440x900 (project "QA B"): no overlaps, inside the stage, but the last node's bottom-right corner sits under
  the zoom controls (856 px2; node 872,469 184x95, controls 1037,518 28x80; `qa-d2-b-5under-1440.png`). Defect X1.
- 10 under the root at 1024x640: node under the controls on every add (594 px2, `qa-d2-c-10root-1024.png`). 5 under a manager at 1024x640:
  780 px2 on adds 4 and 5 (`qa-d2-d-5under-1024.png`).
- Left-right (Subway preset), 5 under a manager at 1024x640: stacked down, no overlap, visible, no controls overlap
  (`qa-d2-subway-5under-1024.png`).
- Radial (Constellation preset), 5 under a manager at 1024x640: no overlap but adds 3 to 5 sit under the controls (581, 501, 405
  px2) and the last node ends within a pixel of the stage edge (`qa-d2-constellation-5under-1024.png`).
- Tray open with results (mock Recommend, "Nothing matched New role 6"), 1024x640, stage 688x326: 3 adds visible, no controls overlap.
- Add while zoomed in and panned away was only exercised implicitly (the chart is panned by each add; I did not zoom in to
  scale 2 or more first). See "Not exercised".
- Fit view with 17 roles (14 siblings): the zoom floor (0.5) stops the fit, so the root and several roles stay outside the view,
  and Auto-layout lays 14 siblings out in one row that is wider than the stage at that floor (`qa-d2-autolayout-17.png`). Polish P1.
- In that project the root is not centred over a widened row of children (placement leaves the manager where it was; the row only
  grows right). Expected from the placement rule; noted.

### D3 Toolbar "Add role" under the root, inspector and menu under the selected role: pass
- Implementer selected, toolbar Add role: New role 2 `reportsTo` Orchestrator; no banner; the text "New roles report to" appears
  nowhere (`qa-d3-toolbar-add.png`).
- Right-click Reviewer: menu "Edit role / Add a report / Remove role"; "Add a report" created New role 3 under Reviewer
  (`qa-d3-menu.png`). Inspector "Add a report" tested under D1 and in the Office.

### D4 Delegation list in the role inspector: pass with polish items
Fixtures: a manager "Lead" with 1, 4, 8 and 14 other roles (children first, then siblings), names including an 91-character
multi-word name, a 94-character name with no spaces, Japanese, `Zoë "Ünïcode" <b>Bold</b> & Co`, and one-letter names; one
Required ticked, three siblings ticked in the 14 case.
- 1440x900 dark, default panel width 360: 1, 4, 8, 14 others all render one row per role, name ellipsis, no horizontal
  scrollbar (`side-body` scrollWidth equals clientWidth, 349 = 349; no `.delegate-row` overflows). Direct reports are listed
  first, "Other roles (n)" is folded with the right count (2, 5, 10 for the 4, 8 and 14 cases... the count is of non-direct roles
  and was correct each time), and it is open by default when one inside is ticked (14 case). The role's own manager
  (Orchestrator) is never offered. HTML in a name is shown as text. Files: `qa-d4-n1-1440-dark.png`, `-n4-`, `-n8-`, `-n14-`.
- Both ends of the panel width at both window sizes and both themes (Home/End on the "Resize team panel" separator: 280 and 928
  at 1440, 280 and 688 at 1024): no horizontal overflow in any of the 8 combinations (`qa-d4-n14-<size>-<narrow|wide>-<theme>.png`).
- "Required" is a checkbox with its own label, readable at 280; the one hint sentence "Required: this role must hand work to
  that report before it finishes." sits above the list.
- Issues: P2 at width 280 each name is cut to about 14 characters ("Senior Principal ...", "Supercalifragilisti...") while the
  "Required" column keeps its full width on every row; two long names with a shared start (Senior Principal Staff ... in both the
  direct and the other group) read identically. The full name is said to be the row `title`; I did not hover to confirm.
  P3 the "Required" box of an unticked role is dimmed (disabled) with no text saying it needs the role ticked first; in light theme
  the dimmed label is pale grey on white. P4 there is no label on the first group (direct reports), so the list has a
  heading-less first group followed by a folded "Other roles".
- Space on the `<summary>` of "Other roles" did not toggle it in my driver, but it also did not toggle any other `<summary>` in
  the app (e.g. "What I looked at"), so I treat it as a driver artefact, not a defect. Enter toggles it. Unverified in a real keyboard.

### D5 Drop on a node body, highlight, cycle refusal, empty drop: pass (all 7 graph styles)
Project "QA Drag", 1440x900, for each of Default, Blueprint, Constellation, Subway, Mission control, Paper, Hive (node styles
card, compact, station, hex; layouts top-down, radial, left-right). Mouse drag from the source handle.
- Reviewer's handle dropped on Researcher's body: Researcher reparented (`Orchestrator -> Reviewer`) in all 7. While hovering,
  the hovered node carries `data-drop="valid"` and a purple outline is visible (Hive: dashed box, Subway: rounded box; the outline
  is a rectangle around hex and station nodes, see P5).
- New role's handle dropped on its own manager Implementer: refused in all 7, `data-drop="invalid"` while hovering, parent
  unchanged, toolbar note "Implementer cannot report to New role: New role already reports to Implementer." Reason is on screen.
- Handle dropped on empty canvas: no state change, no connection line left (`.react-flow__connectionline` count 0) in all 7.
- The refusal note from the previous drop was still on screen after the empty-canvas drop (8 s timer), so for a few seconds an
  unrelated gesture shows an old refusal. Polish P6 (observed text; I did not measure the clear time).

### D6 "leads N" chip and the dashed edge: pass
Project "QA D". Implementer with 5 reports shows "leads 5"; untick New role in its delegation list: chip "leads 4", edge to New
role dashed (`stroke-dasharray 4px, 4px`) with the label "not delegable" and the edge's accessible name "Implementer manages
New role. Press Delete to make New role report to Orchestrator instead." (`qa-d6-untick-1440.png`). Untick all: chip disappears
(`qa-d6-untick-all-1440.png`), `canSpawn` stays true by design, no chart cue that the role may still spawn (P7).
The "not delegable" label is about 8 px high text at fit-view zoom.

### D7 Team files line and commit confirm: pass with one should-fix
Throwaway fixture git repos only.
- Fresh project: "Team files: not committed yet" (no "changed"), `qa-d0-initial.png`.
- "Commit team files" opens "Commit the team files?" listing `.orgai/...` paths, then "Only these files go into the commit;
  anything else you staged stays staged. Nothing is pushed." and Cancel / Commit. Cancel: `git status` and log unchanged (1 commit,
  `.orgai/` untracked), focus returns to the "Commit team files" button.
- 17 files with long paths (QA Del): 12 listed then "and 5 more" (`qa-d7-confirm-many-1440-dark.png`); the list scrolls inside the
  dialog, paths fully shown, no horizontal overflow (dialog 440 wide). The scrolling list has no tab stop in my check, so a
  keyboard user cannot scroll it (the query found no focusable list; P8, my measurement of tabIndex was null because the
  element was not found by my selector, so treat as unverified).
- Commit: 17 and 9 files committed; `git log` shows "Update OrgAI team files"; the line reads "Team files: in sync · .orgai/ in
  this repository. · Committed 17 team files." (`qa-d7-after-commit.png`, `qa-d7-committed-1024-light.png`). Focus lands on the
  status line.
- Editing a committed role (rename) switches the line back to "Team files: not committed yet" even though the files were
  committed before (documented limitation, P9); renaming back returns to "in sync".
- 1024x640 light and dark: the confirm with 9 files fits without scrolling (`qa-d7-confirm-1024-light.png`, `qa-kbd-confirm-1024.png`).
- Should fix S2: in the QA Del project the line carried five warnings ("... It has text that looks like a key. Keys must not be
  committed.") because my role names contain a 94-character unbroken token. The confirm never mentions the warnings, and the
  commit succeeded with them still shown afterwards (the 17 files include the three warned ones). If the warning is a real gate
  the confirm should say so; if it is a false positive on long identifiers, the wording contradicts what just happened. Also the
  warnings expand the toolbar to five lines and push the canvas down 78 px at 1440x900.

### D8 Rename keeps a granted connection: pass
Project "QA Drag", custom connection `qa-docs-server` (HTTP, no sign-in, added through `window.orgai.mcp.upsert`), granted to
Reviewer from "Add a connection" in the role's Connections group.
- Granted: `serverRoles=['reviewer']`; inspector "1 connection, qa-docs-server, Custom connection".
- Renamed to "Code Auditor" (slug code-auditor): `role.mcpServers=['qa-docs']` written, UI still shows the connection.
- After switching to Live and back: still granted. After a full app restart (`relaunch`, same data dir): still granted.
- Renamed back to "Reviewer": still granted. The old slug stays in the server's `roles` list (the known residual).
- I filled the name in one step; per-keystroke typing was not tried.

## Pocket Office
Presentation switched with Canvas style, window about 1424x855, dark. Select Reviewer: inspector with "Back to office" strip and
"Add a report". Add a report: person "New role 2, Reviewer" appears in the roster, banner "Reviewer can now create subagents,
because New role 2 reports to it.", label "Reviewer · 2". Remove: roster loses it, undo row "Role removed. Reviewer can no
longer create subagents: nobody it may delegate to is left." Undo: roster and `canSpawn=true spawnable=[New role 2]` restored
(`qa-office-1-added.png`, `qa-office-2-removed.png`, `qa-office-3-undone.png`). Finding P10: after the add the office view
stays on the Orchestrator at 2x; the new person is not in view (the label "Reviewer · 2" is; I could not see the sprite
itself), unlike the graph which pans to the new node.

## Keyboard pass (1024x640)
Add role button, Enter: new role added under the root and focus moves to the Name field. Enter on a focused chart node opens
the inspector. In the inspector: "May create subagents", then Tab goes to the first delegation checkbox, its Required box, the
"Other roles" summary, then into Instructions; Space on the first checkbox saved `Reviewer spawnable=[New role 2]`.
Commit confirm: Enter opens it with focus on Cancel; Tab cycles Commit, close X, Cancel, Commit (trapped); Escape closes it and
focus returns to "Commit team files". The Space-on-summary result is described under D4.

## Defects, ranked

### Blocks
None found.

### Should fix
- S1 New role under the zoom controls. Add a role so that its box sits in the lower right of the stage and the node's
  corner is covered by the zoom controls. Repro: 1440x900, new project, select Implementer, inspector "Add a report" five times
  (the fifth overlaps by 19 x 45 px); or 1024x640, toolbar "Add role" 10 times (every add overlaps by 594 px2); also in Constellation
  after 3 adds. Location: the pan that places the new node (TeamView), which keeps it inside `.frame-stage` but not clear of
  `.react-flow__controls` although the notes say it is. Remedy: include the controls' box (about 40 px right, 90 px bottom) in
  the clear area.
- S2 The commit confirm does not mention team-file warnings shown right behind it. Repro: project whose role names have a long
  unbroken token (94 characters), "Commit team files", confirm; commit goes through, the same "Keys must not be committed"
  warnings remain. Location: `commitConfirmText` and the status line. Remedy: say in the confirm that files with warnings are
  included, or block them, whichever the owner intends; and check the scanner on long identifiers (I did not read the scanner).

### Polish
- P1 Fit view and Auto-layout at 17 roles (14 siblings in a row) hit the 0.5 zoom floor and leave the root off-screen.
- P2 Delegation list at panel width 280 gives names about 14 characters and the full "Required" column to every row; similar
  long names are indistinguishable by sight.
- P3 Disabled "Required" has no explanation and is pale in light theme.
- P4 Delegation list has no label for the direct-reports group.
- P5 Drop highlight is a rectangle around hex and station nodes.
- P6 The previous refusal note stays on screen after an unrelated empty-canvas drop for up to 8 s.
- P7 A manager ticked "May create subagents" with no delegates has no chip and no chart cue.
- P8 Commit confirm file list: no keyboard stop to scroll (unverified, see D7).
- P9 After editing already-committed team files the line says "not committed yet".
- P10 Pocket Office does not bring a newly added person into view.
- P11 Seen but not part of this work: a role name with a long unbroken token overflows its card across neighbouring cards in the
  default card style (`qa-d4-n14-1440-dark.png`); the sidebar rail at 1024 shows several projects with identical "QA" initials and a
  horizontal scrollbar.

## Not exercised, and why
- Add while zoomed in at 2x and panned far away, and left-right/radial with 10 roles under the root: not run; only the cases
  above were.
- Light theme for D1, D2, D5, D6 and the Office (light was checked on the delegation list and the commit confirm). 200% zoom: not
  tried. Touch drags, screen-reader speech: not tried.
- Per-keystroke renaming with a granted connection; hover `title` text on truncated delegation names; whether Space toggles a
  `<summary>` in a real (non-driver) keyboard session.
- Real provider behaviour: none, mock only. The typecheck, unit suite, build gate and e2e scripts were not run by me.
- Two states carried over between my own experiments (existing nodes overlapping in "QA Drag" after repeated layout switches
  and Auto-layout across 7 styles) were not investigated; the overlaps were among roles that existed before the adds, so I did
  not count them against D2.

Files touched by this QA: this document only. Scratch driver and screenshots live in the gitignored `e2e/shots/`.
