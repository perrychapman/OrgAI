# UX review: saves reaching live runs

- Reviewer: UX Researcher. Build: `78043317` (dev, `npm run build` ok).
- How it ran: built app, `ORGAI_MOCK=1`, throwaway data dir, mock script `delayMs: 200`, runs started with `[mock:model-switch]` so they idle. 1600x1000 and 1024x640 (setContentSize), dark and light (`data-theme`), mouse first, then a keyboard pass at 1600x1000. Two live runs driven by starting a second run through `window.orgai.runs.start`.
- Compared with: the brief, `docs/agent-notes/renderer.md` "Saves reach live runs", `e2e/live-changes.mjs`, `LiveChangeNote.tsx`.
- Shots and walk scripts: `e2e/shots/ux/live-changes/` (gitignored). Screenshot names below are in that folder.

## Verdict: PARTLY WORKS

The line appears instantly, is polite, truncates safely and clears after 20 s, and the run's log gets the matching line. But it reads as noise, not as feedback: it is a bare grey line with no statement of what changed, it is drawn in two or three places at once, it contradicts the neighbouring warning when a skill has no roles, and it stays up on unrelated screens. Two of the five edit paths (granting a skill from the role inspector, any org chart save) give no line, and a role rename silently lands "from the next run" with an internal-sounding reason in the log. Fix H1 to H3 before release.

## Findings

### H1. The same line shows in several places at once, and in places unrelated to what was saved
Shots: `06-mcp-line`, `13-skill-granted`, `15-role-inspector`, `30-two-runs-1600-dark`.
Repro: start a mock work run, leave it idle. Team > Catalog. Add Context7 through "Add a connection" > Add > Use in this project (Implementer). The line "Idle run for live: in use now" appears under the Skills header (above "No skills yet") and again under the Connections header. Select the Implementer node and the same line is still shown in the Role inspector between Connections and Skills. Observed with two runs: four lines on the Catalog (two per section), 22 px apart.
What the user experiences: an MCP save produces a message in the Skills section; a skill save produces one in Connections; the line in the role inspector is a leftover from an action done on another screen. The store is keyed per project, so every `LiveChangeNote` mounted shows every note. Two polite regions update at once, so a screen reader would likely hear it twice (speech not verified).
Recommend: key notes by section (`mcp`, `skills`, `role`) and render a note only in the section that was saved; clear a note when the user selects another node or tab.

### H2. "in use now" contradicts the warning next to it, and the line never says what changed
Shot: `30-two-runs-1024-light`, `30-two-runs-1600-dark`.
Repro: with a live run, Add a skill > New skill > Save without choosing roles. Immediately under the "Add a skill" row it says "Please migrate the entire: in use now" and directly below, the banner says "api-design created. No role can load it yet." The run log also says "You changed the skill api-design; this run uses it now."
What the user experiences: "in use now" for a skill no role can load is false in effect, and the line has no subject, so the user cannot tell whether it is about the skill, the grant or something else. The same bare wording follows the MCP grant and the revoke ("Idle run for live: in use now" after Remove Context7 from Implementer, shot `24-after-revoke`), where "in use" is the opposite of what happened.
Recommend: name the change and say the effect. For example:
- Skill created, no roles: "api-design saved. No agent can load it yet." (no run line, or "Run 'Idle run for live' is up to date.")
- Grant: "Run 'Idle run for live' can use api-design now." / "...once its agents are idle." / "...from the next run: <reason>."
- Revoke: "Run 'Idle run for live' no longer uses Context7."
For the log: "You changed role grants; this run uses them now."

### H3. Org chart saves (rename, prompt) give no on-screen feedback, and a rename cannot reach the live run
Shots: `40-rename-team-view`, `41-run-log-view`.
Repro: Team, select Implementer, change Name to "Implementer Prime". The slug field changes by itself from `implementer` to `implementer-prime`. No status line appears; the only feedback is "Saved 08:19 AM". In the run's Logs the user gets, in order: "Org chart roles that apply from the next run: Implementer." then "You changed the org chart; this run uses it from the next run: The saved chart gave this new role the identity of another role, or its slug is already used in this run; it applies from the next run. Waiting for the next run: Implementer." A later prompt edit logged "You changed the org chart; this run uses it now."
What the user experiences: the user cannot know without opening Logs (a tab on the right of the run view, not on the Team screen) that the rename was deferred. The wording ("new role", "identity of another role", "slug") describes an internal cause, not what the user did. They renamed a role and are told it is a new role. Also a rename silently rewrites the slug, which is the identity the run uses; that is why it is deferred. The transcript carries only the last notice ("The user changed the configuration; in effect now") so the deferred rename is not visible there.
Recommend: show the same status line beside the Saved indicator for org chart saves, and rewrite the deferred message: "Renamed Implementer. Run 'Idle run for live' keeps the old name until its next run." Do not change the slug on a rename of a role used by a live run (or say so in the field). Log: "You renamed Implementer. This run keeps the old name until the next run."
Status (runtime, 2026-11-19): main now broadcasts `run.liveChange` for every applied host change (org chart saves included), so the renderer can show the line without projects:save returning it. A rename now reaches the live run: the new name and any other edited fields apply at once; the run keeps the role's slug until its next run and says so ("Renamed to Implementer Prime. This run keeps calling it implementer until the next run.", `LiveRunChange.notes`), instead of a deferral. The save still stores the new slug (unchanged). The remaining deferral reasons were rewritten in plain language. The renderer line is the UI Engineer's follow-up; not walked yet.

### M1. Granting a skill from the role inspector gives no line; granting a connection from it does
Shots: `21-role-skill-granted` (no line), `23-role-conn-granted` (line).
Repro: select Implementer, Add a skill, pick api-design. The chooser closes, focus returns to the Add a skill button, no line. The log has "You changed role grants; this run uses it now." Then Add a connection, pick Context7, choose roles, Use in this project: line appears in the inspector.
What the user experiences: identical actions, inconsistent feedback; the skill grant takes the org chart save path (no line, same as H3).
Recommend: give the role skill grant the same line as the catalog skill grant, with the role named: "Implementer can load api-design now in run 'X'."

### M2. The line is easy to miss and has no visual identity
Shots: `06-mcp-line`, `15-role-inspector`.
It is a single 12 px secondary-colour line with no icon, no live indicator and no separation from the helper text above it. In the role inspector it reads as part of the "Add a connection" helper text. It shifts layout: the line (18 px plus gap) pushes the Connections rows down when it appears and pulls them up when it clears at 20 s (Connections block moved 30 px up at expiry, measured 701 to 671 px). A user reaching for a row at that moment can click the wrong one. Two live runs add another row each (22 px each).
Recommend: reserve the space while a run is live (min-height for the note) or draw the note as a dismissible row with a check icon; keep it 20 s but do not remove it while the pointer or focus is inside it.

### M3. Focus is lost after the "Use in this project" dialog closes
Repro: Add a connection > Context7 > Add > Implementer > Use in this project. After the dialog closed `document.activeElement` was `<body>`. A keyboard user restarts from the top of the page and does not land near the new line or row. (Dialog focus return was not compared with a run-less project, so this may predate the change.)
Recommend: return focus to "Add a connection" or the new service row, as the role inspector does after a revoke (focus lands on `role-add-connection`).

### L1. Truncated run title reads oddly
Shot: `30-two-runs-1600-dark`. Titles are cut to 48 characters and the run's generated title was already four words: "Please migrate the entire: in use now", "Second parallel run…: in use now". The colon after a cut sentence reads badly. Recommend: "Run 'Please migrate the entire…' can use it now" or lead with the run number used in the sidebar ("R1: in use now"). Full text is in the title attribute (hover only; not reachable by keyboard).

### L2. Wording differences
"once the agents are idle" and "being applied" were not producible in the mock (see below), so their fit is untested. Log lines say "this run uses it now" for revokes too. "in use now" in the sidebar-adjacent line and "in effect now" in the transcript differ; pick one.

## What works

- Line appears within ~2 ms of the save, clears at 20 s (measured t+10 present, t+21 gone).
- Status regions are always mounted with `role=status` and `aria-live=polite` (read from the DOM), one list item per run, 4 items with two runs.
- No horizontal scroll or clipping at 1024x640 dark and light; lines 321 px wide, ellipsis set, not clipped in the cases tried (`30-two-runs-1024-light`).
- Keyboard: toggling a role checkbox with Space keeps focus on the checkbox; the line is not a tab stop (correct); the tab order after it goes on to Suggestions and Evaluate skills with visible focus. Revoke returned focus to "Add a connection".
- Nothing says "next run only" except the deferred rename (H3). No line shows without a live run.

## Not driven

- Screen-reader speech: not verified; only the DOM attributes were read.
- The wordings "once the agents are idle", "being applied" and the `next-run` reasons for MCP/skills: the mock answers "now" for an idle run, so I did not see them (the rename's `next-run` case appeared only in the log).
- A busy (non-idle) run, an ended run and a project with a run in another project.
- Org chart proposal cards in another session ("other live team runs take the change when their session can"): not reached.
- Hover tooltip of the line (read the `title` attribute only).
- The MCP row toggle on/off ("switch on an MCP server") as a separate action; I used Add and Remove.
- Packaged build, real providers.

---

# Re-walk, 2026-11-19

- Reviewer: UX Researcher. Build: `52f99364` (dev, `npm run build` ok).
- How it ran: built app, `ORGAI_MOCK=1`, throwaway data dir, mock script `delayMs: 200`, no tokens. The project was created from a folder that holds `.orgai/` (roles Lead and Dev) so the team-files approval card could be raised. Runs were started with `window.orgai.runs.start` and `[mock:model-switch]` so they idle; the four answers came from `[mock:host-after-idle]`, `[mock:host-slow]` + `[mock:host-after-idle]`, `[mock:host-reject]`, plus a long-prompt run. 1600x1000 and 1024x640 (setContentSize), dark and light (`data-theme`), mouse first, then a Tab pass at 1600x1000.
- Compared with: this review, `e2e/live-changes.mjs`, `LiveChangeNote.tsx`.
- Shots and walk scripts: `e2e/shots/ux/live-changes-2/` (gitignored; scripts `a.mjs` to `f.mjs`). Shot names are in that folder, prefix `uxlc2-NN-`.
- Mock caveat: the mock titles a run from its first prompt, so runs show as "Mockhost-reject rejecting run…". That is the mock, not the app; I do not count it.

## Verdict: PARTLY FIXED

The wording and the one-line-per-save design work: each save now names what it did ("Can use api-design now", "No longer uses api-design", "Renamed to Lead Prime. This run keeps calling it lead until the next run."), each save speaks from one place, and the line lasts. But the org chart line lives in the canvas footer, and that footer is the weak spot. At 1024x640 with three or more live runs it grows to 248 px, runs 52 px off the bottom of the window, cuts off the last line and crushes the Team assistant to 25 px. With the team-files approval card open (any window under 720 px high) the footer is hidden, so a rename shows nothing at all. Fix those two before release.

## Status of earlier findings

| Item | Status | Evidence |
| --- | --- | --- |
| H1 duplicate lines in several places | Fixed | A skill grant made exactly one line on the page; a rename one line in the footer; a connection grant one line in the inspector. Only one region held text each time (`data-surface` `orgChart` or `role:<id>`). Shots `b03-role-skill-granted-1024-dark`, `a01-rename-1600-dark`. Remaining: the rename's detail sentence repeats once per run (M3 below). |
| H2 "in use now" contradicts, no subject | Mostly fixed | Lines now say "Can use api-design now", "once its agents are idle", "from the next run", "Applying access to api-design", "No longer uses api-design". The no-role skill wording ("Has api-design; no role can load it yet") I did not re-drive; `e2e/live-changes.mjs` asserts it. |
| H3 org chart saves give no status | Partly fixed | A line now appears (0.9 s after typing) for rename, prompt edit, add role and remove role, shot `a01-rename-1600-dark`. It is hidden while the approval card is open at 1024x640 (H2 below), clipped with several runs (H1 below), and sits at the bottom of the window, not by the Name field. The Slug field still changes silently (`lead` to `lead-prime`, same shot, right panel). |
| M1 role skill grant gave no line | Fixed | `b03-role-skill-granted-1024-dark`: "Can use api-design now · run “Idle run for the”" in the inspector. New inconsistency: M2 below. |
| M2 layout shift / easy to miss | Partly fixed | Catalog and inspector lines reserve their rows, so nothing moved there. The footer line still shifts the page (M1 below) and the reserved rows are now a blank gap (M4). It has a check icon now, which helps. |
| M3 focus lost after the dialog | Fixed for the role inspector | After Add Context7 from "Add a connection" the focus was on `role-add-connection`; after a skill remove, `role-add-skill`. The catalog "Use in this project" path was not re-walked. |
| L1 truncated run title | Open | `d03-four-runs-1600-dark`: lines are cut with an ellipsis at 321 px (see M2 below). |
| L2 wording variety | Partly open | "in use now" is gone from the inspector lines but the footer still says "Org chart changes are in use now", the log says "this run uses it now". Acceptable, one vocabulary would be better. |

## Findings

### H1. At 1024x640 with several live runs the org chart footer overflows the window and crushes the Team assistant
Shots: `f01-4lines-1024-dark`, `f01-4lines-1024-light`, `e02-card-4lines-1024-dark`.
Repro: start four work runs (the three markers plus a plain one), open Team at 1024x640, select Lead, rename it.
Measured: footer 48 px before; 248 px after (bottom at 692 in a 640 px window, so the last line and its detail are off screen); Team assistant tray 148 px before, 25 px after (only its top edge is left); the canvas stays 326 px. With one run the tray drops from 148 to 92 px (`a03-1024-dark-rename`). At 1600x1000 the same four lines make the footer 230 px and shrink the canvas from 612 to 381 px next to the card (`e03-card-4lines-1600-dark`).
What the user experiences: saving a rename makes the Team assistant vanish for 20 s, the fourth run's line is not visible and there is no way to scroll to it (footer `overflow: visible`). Then everything jumps back.
Recommend: cap the footer line area. Show the first line and "and 3 more runs" as a summary ("Org chart changes reached 4 runs. 2 apply now, 1 once idle, 1 from the next run"), the full list in the tooltip or a Details disclosure; give the note a `max-height` with its own scroll; or reserve the note a fixed row beside the hint instead of stacking under it.

### H2. With the team-files approval card open, the org chart line is not shown (and not announced) at 1024x640
Shots: `e01-card-1024-dark`, `e02-card-4lines-1024-light`.
Repro: put a power change in `.orgai/agents/dev.md` (add Bash) so "1 change needs your approval" shows the card, 1024x640 (any height under 720 px), then rename Lead with a live run.
Observed: `.frame-footer` is `display: none` while the card is open (`teamFiles.css` line 136), so the line is attached to the DOM but `isVisible()` is false. The text was in the region (all four lines, read from `textContent`), nobody could see it, and a display-none region is not read by assistive tech. At 1600x1000 the line shows under the card and does not overlap it, but pushes the card and canvas up (canvas 612 to 381 with four runs).
What the user experiences: they rename a role in the middle of a team-files review and get no feedback at all, the exact gap H3 described.
Recommend: put the org chart line in the Role inspector under the Name field (the surface that already works for grants) and keep the footer for the hint only, or move the line out of the hidden footer when the card is open.

### M1. The footer line pushes the canvas and tray, then pulls them back at expiry
Shots: `a01-rename-1600-dark`, `a02-1024-dark-idle`, `a03-1024-dark-rename`.
At 1600x1000 the canvas went 612 to 582 px high when the line appeared and 582 to 638 px when it cleared (t+19 s present, t+21 s gone), so the nodes move twice. At 1024x640 the tray took the loss instead (148 to 92 px). The earlier M2 asked for reserved room; the catalog and inspector lines do that, the footer line does not.
Recommend: reserve one row at the foot of the footer while a run is live (as the others do), and keep a long list inside it.

### M2. The skill grant's line sits under Connections, and revoke lands in a different place
Shots: `b03-role-skill-granted-1024-dark`, `b04` (`uxlc2-05-b04-role-skill-revoked-1024-dark`), `c04-conn-revoked-1024-dark`.
Repro: select Dev, Add a skill > api-design. The line "Can use api-design now" appears between the "Add a connection" row and the Skills header, so it reads as a connection message. Then remove the skill with the X: the line "No longer uses api-design" shows in the canvas footer, at the bottom of the window, not in the inspector. A connection grant and its removal both stay in the inspector (`data-surface` `role:<id>`).
What the user experiences: the same panel gives feedback in two places, and the skill one is far from the control. Also "Can use context7 now" uses the slug where the row says "Context7".
Recommend: show every inspector grant or revoke in the line directly under the group header it belongs to (Skills for skills, Connections for connections), use the display name, and never send inspector revokes to the footer.

### M3. The rename sentence repeats once per run and four runs make a wall of text
Shot: `e03-card-4lines-1600-dark`.
With four runs the footer has four identical "Renamed to Lead Primer. This run keeps calling it lead until the next run." sentences, one under each line. The order of the lines also changed (the slow run moved last when its answer came), so the list reshuffles.
Recommend: when every run has the same note, say it once ("Renamed to Lead Primer. Runs keep calling it Lead until their next run."), keep lines in the order of the run tabs (R1, R2...).

### M4. Reserved room shows as an empty gap in the Role inspector
Shots: `d03-four-runs-1600-dark`, `f01-4lines-1024-dark`.
With four live runs the inspector keeps four rows free under "Add a connection" at all times, about 100 px of blank space before Skills, even when nothing was saved. It trades the layout shift for a hole that looks like a rendering bug and costs height at 1024x640.
Recommend: reserve one row only; let extra rows push the content once, in a place where the user is already looking.

### M5. Four lines are cut at 321 px and differ only at the end
Shots: `d02-four-runs-1024-dark-t3`, `d03-four-runs-1600-dark`.
"Can use api-design once its agents are idle · run “Moc…” " appears twice with different runs, indistinguishable without a hover. Full text is in `title` (hover only). Title text also repeats the run's first words, which are not distinctive.
Recommend: lead with the run number the sidebar uses ("R2 · after its agents are idle") and drop the quoted title, or wrap the line to two lines in the narrow panel.

### M6. The footer line is far from where the user is looking
Shots: `a01-rename-1600-dark`, `a03-1024-light-rename`.
The user types in the Name field at the top right; the confirmation appears at the bottom left, 6 px from the window edge, in a footer under the Team assistant. At 1600x1000 it sat at y 950 to 994. It does appear (checked 0.9 s after typing) and a new user who watches the footer will see it; one who watches the inspector will not. The 12 px grey text with a check icon is easy to miss.
Recommend: also show the first line beside the "Saved 09:40 PM" indicator at the top right, or under the Name field.

### L1. Add role, remove role and a prompt edit show the same generic line
Shots: `a04-prompt-1024-dark`, `a05` (`uxlc2-08-a05-addrole-1024-dark`), `a07-removed-1024-dark`.
All three read "Org chart changes are in use now · run “Idle run for the”" with no detail. I could not tell from the screen whether the second and third saves were taken or whether it was the line of the first one still showing, since the text is identical and the 20 s timer was still running. Recommend a subject: "Added the role New role. This run can use it now." / "Removed New role. This run no longer sees it." (I did not read the run log for these two.)

### L2. Timer
Single idle run: line present at t+19 s, gone at t+21 s. With the slow run, the footer still showed the lines about 22 s after the save (the slow answer replaced its line, which likely restarted the clock). Fine, but it means the line can outlast the 20 s promise.

### L3. A silent slug change remains
Shot `a01-rename-1600-dark`: renaming changes the Slug field and the identity line to `lead-prime` with no word about it. The footer note now explains the run keeps the old name. Recommend a helper under Name: "The internal name (slug) follows the name until the first run uses it."

## Did the rename note read clearly?

For "Lead" the sentence "This run keeps calling it lead until the next run" reads naturally; the word slug never appears, which is right. I only tried single-word names. For a name like "Code Reviewer" the old slug is `code-reviewer`, which will look like a typo; recommend showing the old display name: "This run keeps calling it Code Reviewer until the next run." (not walked).

## Keyboard and announcements

- Tab order from the Name field: Edit tools, Add a connection, Ask the Team assistant, Add a skill, Ask the Team assistant, Identity, Model, then the fields, then the page chrome. The footer line and its detail rows are not tab stops (correct for text); they are not reachable except through the screen reader's browse mode, in DOM order: line text, then the detail rows in a list labelled "Details".
- After a role-inspector revoke, focus stays on the control that owns the row (`role-add-skill`, `role-add-connection`).
- Each region is `role=status` with `aria-live=polite`; `aria-atomic` is not set. The org chart region and the role region are separate regions, and only the one that was saved holds text. With the card open at 1024x640 the org chart region is inside a `display: none` footer, so it cannot speak (H2).
- A second save with identical text ("Org chart changes are in use now" twice) may not be re-announced because the text does not change. Not verifiable here.
- Screen-reader speech cannot be verified in this environment; all of the above is DOM, attributes and tab order only.

## What works now

- One line per save, in one region (H1 of the first walk).
- Plain wording of what changed and when ("now", "once its agents are idle", "from the next run", "Applying access to…"), with the reason for a next-run answer as plain text under the line ("Some grants name a server or skill this run does not have; they apply from the next run.").
- Each theme and size showed no horizontal scroll and the lines did not clip sideways.
- Focus returns to the owning control after a revoke.
- A connection grant from the inspector gives a line, so grant and revoke are symmetric for connections.

## Fix before release

1. H1 (footer overflow and crushed Team assistant at 1024x640 with several runs).
2. H2 (line invisible while the approval card is open).
3. M2 (inspector revoke lands in the footer; skill line under Connections) is a small change and worth doing in the same pass; M1 and M4 follow from the same fix as H1.

## Not driven

- Screen-reader speech: not verified.
- The catalog "Use in this project" path and the "no role can load it yet" line: not re-walked.
- The run log text for the add and remove role saves.
- A busy (non-idle) run, an ended run, and the "being applied" case for an MCP grant; the slow case was driven only on a skill grant and a rename.
- Role names with spaces; the real provider; the packaged build.
- Time from clicking a skill to the dialog closing while a slow run is pending: at 0.5 s the chooser was still open and no line was shown, at 3 s all lines were up; the exact moment was not measured.

## Fix status (UI Engineer, 2026-11-19)

H1, H2, M1 to M6 and L1, L2 are addressed; the design and checks are in `docs/agent-notes/renderer.md` "Saves reach live runs" (re-walk fixes) and `e2e/live-changes.mjs` (phases e and f). L3 (silent slug change) stays with the inspector owner. Open: the overlay can cover top nodes of a small chart for up to 20 s; screen-reader speech is not verified.
