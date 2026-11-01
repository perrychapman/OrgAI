# UX review: the Team tab, fourth walk (after the walk-3 fixes)

Walked on commit b23dd12 (branch worktree-agent-a804f393e0c8200e5, built here with `npm run build`). `ORGAI_MOCK=1`, fresh temp `ORGAI_DATA_DIR`, four mock projects (Architect unticked). Driven with playwright-core (scratch scripts in the gitignored `e2e/shots/ux4/`). Screenshots: `ux-review-team-tab-4-shots/` (36 files, cited by number; names carry the size and theme when it is not 1024 dark). Sizes 1024x640 and 1600x1000, dark and light, one keyboard pass. No smoke scripts, no token-spending e2e, no code edited.

Limits: the first-time run in light was spot-checked (shots 025, 026, 030), not repeated for every flow. The "already linked but unconnected" grant path and the native folder picker were not walked. Mock quirk: the Architect's org chart proposal replaces the four default roles with Lead and Engineer.

## Verdict

The scenario now works the way a first-time user expects. "Reviewer gets GitHub and a code-review skill" is 3 to 4 clicks to granted, the Role-row Sign in lands on the highlighted tile and Back to Team brings you home with the role selected and focus on the row, the first-time GitHub path is two dialogs, the skill chooser reaches the local skill in one click, and the tray no longer re-offers what the role holds. What is left is small: the "Dismissed. Undo" row scrolls out of sight at 1024x640, the "N suggestions since your last run" line never showed in three tries, the skill chooser opens on an empty tab, the token dialog opens on Close, and Tab stops are still many (a skip link now makes it one).

## Walk-3 findings N1 to N14

| # | Finding | Status | Evidence |
| --- | --- | --- | --- |
| N1 | Role-row Sign in ignores the deep link; no way back | Fixed | Click Sign in on the GitHub row: GitHub tile in view, highlighted, focus on "Finish setup for GitHub" (005). Sticky "Back to Team" at the top of Connectors; one click returns to Team, Reviewer selected, focus on the row's "Sign in to GitHub" (006), tray scroll kept. Row shows "Needs sign in" + Sign in. Not walked: custom server edit form, and leaving App settings by another route (code path only, e2e covers). |
| N2 | Skill chooser cannot reach the local skill | Fixed | Tabs: This project, Your library, On this computer, Found in this repo, New skill. "On this computer" lists `code-review` with "On this computer: Claude Code" (008); one click grants it, dialog closes, focus on the new skill row (010). Empty copy now "This project has no skills yet." Leftover: S1. |
| N3 | Connection chooser chains four dialogs | Fixed | node, Add a connection, GitHub, Add token: 4 clicks, 2 dialogs (Add a service, token dialog); Reviewer alone gets GitHub (server roles `["reviewer"]`, node "1 connection"), focus returns to "Add a connection to Reviewer" (011, 012). The token dialog also offers Read-only / Full access up front. Leftover: S2 (focus), S3 (picker title does not name the role). |
| N4 | Dismiss silent, results lost on reload, no dismissed list | Partly | "Dismissed mock-fs. Undo" row, announce "Dismissed mock-fs.", focus on Undo, gone after 8 s with focus on the next Apply, "Dismissed (1)" disclosure with Restore, Restore announces "Restored mock-fs." and focuses its Apply (016 to 018). Results persist across a reload (019). Open: M1, the row can be out of view. |
| N5 | Recommend re-offers a held connection | Fixed | After GitHub and code-review were granted, Recommend for Reviewer offered mock-fs and Gmail only (014). Whole team still offers GitHub for the others (015). |
| N6 | Proactive list unranked, counts disagree | Mostly fixed | After 2 runs: "Top 3 to review", skill first, "Show all 5" reveals 5 (021, 022); count not repeated in the tab line. Scoped head "4 to review for Reviewer · 1 waiting for the whole team" (023). Open: "since your last run" line never seen (M2); scoped list shows 4, not 3, and has no cap. |
| N7 | Chooser keyboard | Fixed | Opens focused on the selected tab; Right, Right, Down, End, Home each move focus and selection (007 text). Escape returns focus to "Add a skill" / "Add a connection". |
| N8 | Tray layout | Mostly fixed | Chart refits when the tray grows (Reviewer whole in 002, 004, 028); cards in two columns at 1600 (021, 023); Design: the Revise form is one line while a session runs, the permission card sits in the tray with focus on "Allow once" (033, 034), the org chart proposal card has no nested scroller (checked: 0), after the session the form returns without an empty box (036). Leftover: S4. |
| N9 | Tools summary hides risk | Fixed | "Read, Glob, Grep + Edit, Bash" with the names in amber (dark rgb 245,183,61 on 11,13,18; light rgb 125,74,0 on 250,251,253, both clearly above 4.5:1) (029, 030). Node gets the amber triangle (`role-node-elevated`). Leftover: the node aria-label still says "5 tools" and not that two are elevated. |
| N10 | 27 Tab stops | Partly | First Tab from the project tabs is "Skip to role panel"; Enter lands on the panel's tab strip. Edges have no tabindex. Raw count to "Add a connection" is 41 with three tray cards open (4 toolbar, 4 nodes, 3 zoom, then the tray's buttons), more than walk 3's 27, but the skip link makes it 2. |
| N11 | Catalog tidy | Fixed | No header wrap beside the primary at 1600 (024, 025); one "Used by Reviewer" chip set with "Change roles"; "Evaluate skills" is a ghost row; results head carries "and 1 gap" with a jump button (002). Two primaries ("Add a skill", "Add a connection") remain in an empty project, acceptable. |
| N12 | Gap count | Fixed | "3 to review for Reviewer   and 1 gap" is visible (002). |
| N13 | Access spec vs product | Fixed | `team-tab.md` line 72 now says access is fixed per server at add time; row shows "Can read", no select. Apply cards and the token dialog carry the Can read / Can read and change choice. |
| N14 | Copy | Mostly fixed | "Ask the Team assistant" everywhere I saw, Settings "Team assistant review", card header "Curated · GitHub". The endpoint URL is still shown in a code box on the card ("This is what gets added"), not under Details; I read that as intended trust information. |

## Scenario: Reviewer gets GitHub and a code-review skill (clicks as before, node click included)

| Route | Steps | Walk 3 | Now | Ends |
| --- | --- | --- | --- | --- |
| (a) Assistant, granted | node; Recommend (the proactive list may already be there); Apply skill; Apply GitHub | 4 | 4 (3 when results are already showing) | both granted, "Needs sign in" on the row |
| (a) then working | Sign in on the row (005); Enter; paste; Add token | 7 | 8 | GitHub works |
| (a) back to Team | Back to Team | 9, landed on Live | 9, lands on Team with Reviewer selected | |
| (a') row Sign in | node; Recommend; Apply; Apply; Sign in | 5, top of gallery | 5, highlighted tile, focus on its action | |
| (b) first-time GitHub | node; Add a connection; GitHub; Add token | 8 + paste, 4 dialogs | 4 + paste, 2 dialogs, role granted | |
| (b) skill | node; Add a skill; On this computer tab; code-review | not reachable | 4 | skill on Reviewer |

## New findings, ranked

### Medium

**M1. The "Dismissed X. Undo" row can be out of view at 1024x640.** Shots 016, 028. After Dismiss the tray keeps its scroll offset and the row (focused Undo button, y 252 against a tray top of 332) sits above the visible tray, so the sighted user sees the card vanish with no feedback. Fix: scroll the row into view (`block: 'nearest'`) when it is created, or when the card was the first or the list is scrolled, keep the row at the scroll top. Check: dismiss the first card at 1024x640 and see the row.

**M2. "N suggestions since your last run" never appeared.** Fresh Demo3 after 2 runs and Demo4 (polled for 30 s) and Demo3 after a third run: `team-since` absent each time, although the Team tab showed a count (5). Likely `newCount` is cleared (or the line hidden) before the pane renders, or the mock review does not mark items new. Owner: `TeamAssistantTray.tsx` ~185. Check: finish a run, open Team, the line is visible.

### Low

**S1. The skill chooser opens on "This project" even when it is empty.** Shot 007: a first-time user sees "This project has no skills yet" and must find the third tab. Open on the first tab that has something (here "On this computer"), or add the tabs' counts.

**S2. The token dialog opens with focus on "Close dialog"** (011); the token field should have it.

**S3. The "Add a service" dialog does not name the role** that will get it (009); the chooser said "Only this role gets what you add". Add "for Reviewer" to the title or the lead.

**S4. At 1024x640 the tray is a 150 to 260 px strip** (028, 036: only the top of "Revise with the Architect" fits after the session ends). Every flow works but the tray and the Role panel share a short column; consider a taller default tray after Design finishes.

**S5. Node aria-label** reads "5 tools" and does not say two are elevated; the marker has no spoken counterpart.

**S6. Scoped list is not capped** ("4 to review for Reviewer", no Show all) while the whole-team list says "Top 3".

## Keyboard and a11y

Passed: skip link first; chooser tabs by arrows, Home, End; Escape returns focus to "+ Add"; Apply focuses Undo; Dismiss focuses Undo, then the next Apply after expiry; Restore focuses the restored Apply; Back to Team focuses the row's Sign in; Design permission card has focus on "Allow once". Failed: M1 (visible feedback), S2.

## Both themes

Light (025, 026, 030): source chips, amber "Needs: MOCK_FS_TOKEN", red "Runs code on this machine", the grey "Reaches a remote service" chip (still unbordered, text legible), and the elevated tool names read well. No horizontal scroll seen at either size.

## What is still open

M1, M2, S1 to S6; the custom-server Sign in path and the "already linked, unconnected" grant were not walked; the live recommend results come from the keyword fallback on the mock.

## Files written

- `docs/design/ux-review-team-tab-4.md`
- `docs/design/ux-review-team-tab-4-shots/` (36 PNGs, 001 to 036)
- Scratch scripts (gitignored): `e2e/shots/ux4/*.mjs`
