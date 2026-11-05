# UX review: team files under `.orgai/` (post-landing walk)

- Reviewer: UX Researcher. Build: 680df6e (`npm run build`), Windows 11, `ORGAI_MOCK=1`, fresh temp data dir per script, fixture git repos under the temp dir (lead.md, dev.md, team.json, optional mcp.json), driven with `e2e/lib.mjs`.
- Sizes and themes: 1024x640 and 1600x1000, dark and light, by screenshot for each state; text, geometry and accessibility-tree names sampled at 1024x640 dark. Keyboard pass (Tab order) on the New project form and on the Team tab with the card open, at 1024x640 dark.
- Compared with: `docs/design/team-files.md`, CLAUDE.md "Team files", and my pre-walk `ux-review-team-files-pre.md`.
- Scripts, logs and shots: `e2e/shots/ux/team-files/` (gitignored): `a-found.mjs`, `b-panel.mjs`, `c-team.mjs`, `d-needs.mjs`, logs `c.log`, `d.log`. Shot names are `<script>-NN-<name>.png`.

## Verdict: PARTLY FIXED

The model is right and the pre-walk's structural findings are fixed: a quiet status line in the Team toolbar, a card with before/after, a Needs-you item that opens it, Undo that says which file it rewrites, no "Export", and a found-team panel on New project. It is not safe to ship the card as is. At 1024x640 the approval card shows a sliver of what is being approved (an MCP server's address is not visible at all) and the chart shrinks to about a quarter of the frame, exactly as reported. Status messages also outlive their state.

## Status of the pre-walk findings

| Pre | Status | Evidence |
| --- | --- | --- |
| H1 no place for sync state; Banner too tall | Fixed for the line, open for stacking | `team-files-line` sits in the toolbar's second row (`c-01`), polite `role=status` inside a named group. But notices still stack under it, see H1/M1 below. |
| H2 Export / Import wording | Fixed | No `export-org`; button reads "Import from other tools" (toolbar aria). |
| M1 fresh clone through the import path | Mostly fixed | Panel `team-found` ("This folder already has a team"), primary "Create project", no Replace wording. See M3, M4. |
| M2 counts add the same team twice | Not checked | I did not put `.orgai/` and `.claude/agents/` together. |
| M3 already-a-project is a warning | Fixed | `team-found-existing` plus "Open <name>" and Cancel, no "anyway" (`a-08`). |
| M4 Undo vs git | Fixed | "Undo rewrites .orgai/agents/dev.md. They then show as uncommitted." (but see M6). |
| M5 export notice raw path | Fixed | Replaced by the line and Committed message. |
| M6 no home for approvals with no run | Fixed | Bell, Dashboard row and sidebar badge all appear (see "Needs-you" below). |
| L1 catalog says where things are stored | Open | Catalog copy unchanged ("Claude Code plugin folders", skills and connections with no storage note). |
| L2 role inspector power wording | Not checked | |

## Findings

### High

**H1. The approval card at 1024x640 hides the change it asks you to approve.**
Screens: Team tab, 1024x640, dark and light. Shots `c-13-s6-card-1024-dark`, `c-17-s7-card-and-applied-1024-dark`, `c-25-s11-mcp-1024-dark`.
Steps: open a project on a team repo, change `.orgai/agents/dev.md` to add `Bash` (or add `.orgai/mcp.json` with a server), click `team-files-review`.
Observed: `.frame-top` 167 px, stage 142 px, tray 235 px of a 592 px frame (stage is 24%). The card's own scroll region (`.decision-body`) is 170 px of 334 px; with the line plus the applied or undone notice (199 px top) the visible part of the change is one line or, for the MCP card with a "Rejected" message above it, none (`c-25`: an empty strip then Approve). Approve is fully visible while the thing approved is not. `.decision-body` has `tabindex=-1`; a keyboard user reaches the hidden text only by Tabbing into "Show all tools" or "Copy what docs would run" (kb pass: Review changes, nodes, zoom, then those, then Approve), which scrolls it, but a mouse user must find a 4 px scroll thumb. At 1600x1000 the same card is fully readable (`c-16`), so this is the small-window case the e2e only checks for `Approve` being on screen.
Fix: when the card is open at compact heights, give the tray the stage (as the proposal cards do, CLAUDE.md "At 1024x640 the compact frame gives the card the stage") or move the card into a Dialog; fold the line's message and the notices into one row while the card is open. Add a check that the first change's text and, for an MCP change, `team-files-target` are visible without scrolling.

**H2. The chart shrinks to a quarter of the frame whenever a notice and the card coexist.**
Measured (`c.log`): in sync 325 px stage; pending line only 142 px; card open 142 px; card plus applied notice 142 px (top 199). Shots `c-17`, `c-19` (light). Root cause visible by eye: the toolbar (96 px), line, up to two notices (`team-files-applied`, `team-files-undone`, 50 to 100 px each) and a 235 px tray all take their height first and the canvas takes what is left. Related to H1; confirm both are fixed together. The canvas also keeps a scrollbar-free fit at 142 px so nodes are cut off ("Lead" node half hidden, `c-17`).

### Medium

**M1. Messages outlive their state.** The line's secondary text is the last action result and is not cleared when the state changes:
- After Commit then a new Bash edit: "Team files: 1 change needs your approval **Committed 1 team file.**" (`c-09`).
- After Reject, a conflict file shows "cannot be read ... **Rejected. Runs keep the last approved team.**" (`c-22`), and a new mcp.json shows "needs your approval **Rejected. Runs keep ...**" (`c-25`). Someone arriving later reads that they rejected the new server.
Fix: clear `team-files-message` when `state` changes, or give it a timeout; keep it a status only for the action just taken.

**M2. Duplicate and wrapping text in the line.** Rejected state says the same sentence twice ("You rejected them. Runs keep the last approved team. OrgAI asks again when the files change." then "Rejected. Runs keep ...", `c-21`). Undone: the line repeats the notice ("Undone. Rewrote ... They now show as uncommitted.") so a screen reader hears it twice (`LINE-after-undo`). In `c-25` the "Review changes" button wraps onto the text above it and overlaps it. Fix: one sentence per state, keep the button on its own row when it wraps.

**M3. The found-team panel repeats a warning four times and leads with noise.** `team-found` at 1024x640 (`b-01`): four rows each carrying the same amber badge "First time this repository's team is seen on this computer" ("Dev joins the team", "Lead joins the team", "New service docs would run...", "The project brief changed"). "The project brief changed" is wrong for a brand-new project (nothing changed). The settings list is 13 rows of "not set" (`b-05`) that bury Create project's context. Fix: state the first-time note once above the list; say "Project brief" not "changed"; list only settings that are set. The panel is a long scroll at 1024 (876 px in a 592 px page); the sticky Create project button helps and is good.

**M4. "Let the Architect review the team instead" label.** (`team-architect`, `ARCH-LABEL`) "Skips the files' team and starts the setup interview on this folder." A person who just read "Read it first" may take it as a safe extra. Reword to what happens: "Ignore this team and start from the Architect's interview". Also the checkbox sits after the 876 px panel, so it is seen last.

**M5. A problem file has no next step.** `.orgai/agents/dev.md cannot be read. It has merge conflict markers. The last approved team stays in use.` (`c-22`) says what but not what to do. A person with a fresh clone mid-merge needs "Fix the markers in that file (or finish the merge in git); OrgAI checks again when it changes." The error styling is good and the file is named. The line also has no button to open the file or folder.

**M6. Applied notice can name the wrong file and survives other changes.** After applying Lead's prompt edit and later approving/rejecting other changes, the same notice read "Lead's instructions changed. Undo rewrites .orgai/agents/**dev**.md" (`c-22`, `FRAME-TOP`; it said `lead.md` when it first appeared, `c-17`). I did not click Undo to see which file it rewrites, so I cannot say which half is wrong; either the label or the Undo is stale. Notices should expire when the files they describe change again.

**M7. Opening "Team assistant" in the card hides the card's change.** `team-files-assistant-toggle` ("Team assistant", between Approve and Reject) swaps the tray to the assistant and leaves only the card header (`d-08`). The toggle's name becomes "Hide Team assistant". A person who clicks it mid-review loses what they were reviewing, and Approve and Reject vanish. It also reads as a third decision in the Approve | Team assistant | Reject row. Move it out of the decision row or make it open beside the card.

**M6b. The Live view says nothing while a change waits.** With changes pending and no run open, Live's New run page shows no hint (`d-01`), so a user can start a run on the old team without knowing the files differ. A one-line "Team files differ: runs use the last approved team" with a link to Team would match the Rejected message.

### Low

**L1.** Catalog copy does not say what travels via git vs what needs signing in again (pre-walk L1, unchanged).
**L2.** `team-found-changes` is `ul tabindex=0` with no overflow at 1024x640 (118 of 118 px), an extra Tab stop (kb pass: Tab 2 on `a-found`) with no purpose.
**L3.** Stale status on the New project form: after a team is found, switching to From GitHub keeps the sr-only form status "This folder already has a team: 2 roles and 1 connected service. Review it, then create the project." though the folder field is gone (`GH-ARIA`).
**L4.** Bell and Dashboard row text "Team files: 2 changes need your approval" counts files, while the project tile and Needs-you count say "1 decision". Fine on its own, but the number differs by surface.
**L5.** Focus after Approve, Reject, Commit and Undo lands on `team-files-line` (a `div tabindex=-1`, named "Team files status"), a sensible target. A screen-reader user hears the whole message again when focus arrives plus the live-region announcement.
**L6.** After creating a project from a found team the topbar h1 gets focus and the project name is the folder name when Name is left blank (`orgai-e2e-tfa-...`), as before.

## What worked (seen)

- Status line states (`c-01`, `c-06`, `c-08`): in sync ("Team files: in sync .orgai/ in this repository."), changed not committed with Commit, Committed 1 team file (one real commit, `Update OrgAI team files`, observed in git log), pending with Review changes, rejected, problem. Group name "Team files status", polite status inside it, `data-tone` styling distinct in both themes.
- Needs-you with no run open: bell shows "Needs you 1", popover item `needs-item[data-kind=team]` "Team files: 2 changes need your approval, TF walk · Team"; Dashboard hero "1 needs you", `dash-needs-row[data-kind=team]`, tile "1 decision", sidebar badge named "TW TF walk, 1 needs you". Clicking the bell item or the Dashboard row lands on the Team tab with focus on the card (`article[team-files-card]`, named "Team files: 2 changes to review"). Good.
- Card (1600x1000, `c-16`): plain sentence "Dev gains Bash.", why, "Can now run commands.", full address for the new service, file path, Approve and Reject; Tab order Show all tools, Copy, Approve, Team assistant, Reject. Visible focus rings were not measured by eye beyond the e2e check.
- Existing project on the same folder: "That project already holds this folder's team files, so a second project here would fight it over .orgai/. Open <name> instead." with Open as the primary.

## Wording a fresh-clone person would misread

1. "First time this repository's team is seen on this computer" (repeated): fine, but "The project brief changed" is untrue for them.
2. "Team files changed, not committed" after Approve: seen in my run, where I had edited the files myself. For someone whose files came from a pull or a hand edit, "you changed these" may be untrue; "differ from the last commit" is plainer. (Not checked against a real pull.)
3. "They then show as uncommitted" / "They now show as uncommitted" in the notices: "They" has no noun when one file is named.
4. "differ from the team in use" (rejected state and card intro): "in use" is not defined anywhere; "the team runs are using" is closer. The card intro says "Review what would change."
5. "Skips the files' team" (M4).

## Not driven

- The native Browse picker; the From GitHub path beyond the form: Clone and Fork need the network, so the clone, the clone-then-team-found handoff and `RepoStartPanel` after a clone were not seen (only the form, the empty state and the stale status, L3).
- A real pull or merge (conflict markers were written by hand into the working tree; no git merge state), a skills folder under `.orgai/skills/`, mcp.json with a stdio server, and `.orgai/` beside `.claude/agents/` (pre M2).
- Light theme at 1600x1000 only by screenshot for the card and problem states; 1024 light for the card and notices. No contrast measurements, no screen reader, only the accessibility tree and focus order via Playwright.
- The "Turn on" and shared-folder (off) states and the rejected-then-restored flow beyond the line text; Undo of a pulled change was clicked once (the prompt edit, `c-06`) and the file rewrite was read from the notice, not from disk.
- macOS, Linux, packaged build.
