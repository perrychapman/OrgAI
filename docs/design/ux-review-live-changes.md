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
