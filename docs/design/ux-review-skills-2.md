# UX review: skills UI (#11), walkthrough 2

Built from the merged tree (7a829d5), `ORGAI_MOCK=1`, fresh temp `ORGAI_DATA_DIR`. Fixture: a temp git repo with
`.claude/skills/api-design` (normal), `deploy-check` (extra `allowed-tools` and `hooks` keys) and `env-probe`
(body has !`echo hi`). Walked at 1600x1000 dark, 1024x640 dark and light, 1600x1000 light, plus a keyboard-only pass
at 1280x800. Screenshots stay in the temp dir (`uxs2-*/shots`, prefixes `a2..c3`, `kb`); file names are cited below.
Not driven: the native folder picker behind App settings > Skill library > **Add from folder** (Electron dialog),
so that route is unwalked.

## Verdict

The pattern is a clear improvement on what I proposed in `ux-review-usage-skills.md` part B and mostly follows it:
Skills lead the Tools page, the Roles control is on every row, the inspector has a Skills group, Import reuses the
agent-import shape with Undo, removal copy names who loses access, and "Used by" is on library cards. What hurts is
not the structure but the feedback loop: an evaluation's results are easy to lose, "Apply"/"Promote"/"Add" leave a
skill that nobody can load, and a loaded skill produces three confusing transcript rows.

## Status of my earlier placements (part B)

| Item | Status |
| --- | --- |
| B1 Skills vs Plugins collision | Done. Skills first in Tools, Plugins reworded ("may bundle skills, MCP servers and commands"). Plugin skills listed read-only in the Skills list: not verified (no plugin in the fixture). |
| B2 Roles control plus inspector group | Done (`Roles: Implementer, Reviewer` per row; inspector `Skills · 0 of 2`). MCP not backfilled into the inspector (a "Services" group exists instead; fine). |
| B3 Import skills, found-line | Import button, banner, dialog, Undo: done. New project "Found N skills" line: not done (a5/`s-02`: only "Git repository found."). |
| B4 Skill row in transcript | Done but noisy, see P1-1. No activity-line text on the node was seen. |
| B5 Evaluate in header, Last evaluation row | Header button and summary row done. Suggestions are inline cards, not tray decision cards; no History entry. Acceptable, but see P0-1. |
| B6 Naming | Done ("Skill library", "Skills" heading in Tools). |
| B7 Elevated-tool hints | Partly. Import dialog flags scripts; the inspector grant and Roles control show no "may run shell commands" hint. |

## Findings, ranked

### P0

**P0-1. Evaluation results vanish behind an unlabelled row, and the summary still advertises them.**
Screen: Project Settings > Tools > Skills > Last evaluation (`b6-01-eval-with-suggestion`, `b7-01-error`).
After Evaluate, findings and suggestions render under "Last evaluation". Leave the page and come back (or restart the
app) and the row reads "Checked Oct 30, 17:16 . 2 findings . 1 suggestion" with nothing below it, so the user sees
a promised suggestion with no Apply button. The row is a `<summary>`: clicking it brings the results back, but it
has no chevron, no hover state and no "Show" word (`b7-01-error` shows a flat card). Also, clicking Evaluate gives
no scroll to the results; at 1024x640 they sit two screens below the button (`c1-02-1024-dark-tools-eval`). The
result is a P0 because the one irreversible-looking decision (apply a suggestion) is the one that gets lost.
Fix: render Last evaluation as a visible disclosure (chevron plus "Show 2 findings, 1 suggestion"), default open
while any suggestion is unresolved, and on Evaluate scroll the results into view and move focus to the Last
evaluation heading.

**P0-2. A skill can be created, applied, promoted or added with Roles: none, and nothing says it will never load.**
Screens: Apply a suggestion (`b7-02-suggestion-applied`: new row "Roles: none"), Add from library dialog
(`c3-04-add-lib-dialog`, single radio, no role choice), import dialog (roles default to none,
`a3-01-import-dialog`), New skill form ("Who can load it? (optional)").
A first-time user applies a suggestion and expects it to "work". Role access is the real switch, yet the row shows an
enabled toggle (on) next to "Roles: none" with no warning, and the evaluator's own "never loaded" check is silent
until 3+ runs have passed.
Fix: show a warning chip on a row that is enabled and has no roles ("No role can load this. Choose roles"), reusing
the Roles control. In Apply, Add from library and Import, default the roles picker to open (or preselect the root
role) instead of "optional", and rename "Choose roles (optional)" to "Choose roles" with the consequence in one
line ("Until you choose roles, no agent loads it.").

### P1

**P1-1. One skill load shows as three transcript rows, one of them "---".**
Screen: run, implementer transcript (`b1-02-implementer-transcript`).
Rows: "Used load skill / Show details", then "Loaded skill api-design", then a row labelled "---" with "Show output".
"load skill" is a raw tool name, and "---" is the first line of the skill file leaking as the tool result label. The
user cannot tell which row is the event.
Fix: collapse to one row, "Loaded skill api-design", with the SKILL.md body under "Show instructions"; hide the
raw tool-use and result rows for the harness load tool.

**P1-2. Skills loaded (Usage) is only on the whole-run view, at the very bottom, in a different layout.**
Screen: Usage tab, whole run (`b2-03-usage-whole`).
The section sits below "By role", after the fold at 1024x640, uses stacked lines ("api-design / 2 loads /
implementer") instead of the table pattern above it, and does not appear in the per-agent view
(`b1-03-usage`), where a user selecting the Implementer would look. "2 loads" with a role name is ambiguous
(two agents? two loads by one agent?).
Fix: use the same table (Skill, Loads, Role/agents), put it directly under By role, and show an agent's own loads in
the per-agent view. Make the load count say "2 loads by 2 agents".

**P1-3. Findings are text-only; the user cannot act on them.**
Screen: Last evaluation (`b3-02-eval-off-done`).
"deploy-check has a vague description ... Say what it does" lists "Skills: deploy-check" as plain text. There is no
Edit button or link, no way to dismiss a finding, and the numbers read oddly: "Seen 3 times" and "3 runs" repeat the
same fact. The vague check also fires on a reasonable description ("Use before deploying to verify the release
checklist.", only 5 meaningful words), which makes first impressions untrustworthy.
Fix: put an Edit button on any finding that names a skill (opens the same form), merge the two evidence lines into
one, and loosen the vague rule to 4 words or include one example of a good description.

**P1-4. Dismiss is silent and unrecoverable; Apply leaves the new row off-screen.**
Screens: `b8-02-dismissed`, `b7-02-suggestion-applied`.
Dismiss removes the card with no "Dismissed" state, but the summary still says "1 suggestion". Apply flips the card
to "Applied" while the new row is at the top of the page, out of view at 1024x640, with no link to it.
Fix: keep a dismissed card collapsed with "Dismissed. Undo" for the rest of the session, keep counts in step, and
add "Show skill" on an applied card that scrolls to and flashes the row.

**P1-5. Promote to library gives no feedback and removes the project's Edit button.**
Screens: `a5-03-more-menu`, `a6-01-promoted`.
Promote runs instantly; the row's badge changes from "From the repository" to "From library" and the Edit button
disappears, with no message, and the library card calls the same skill "From the repository"
(`a6-03-library`). A user thinks they lost editing.
Fix: show a notice ("api-design is now in the library. Edits happen there. Edit in library"), and make the badge
wording match on both sides ("Promoted from this project" in the library; "Linked from library" in the project).

**P1-6. Import banner and result lose information.**
Screens: `a2-03-tools-empty`, `a4-02-after-import`.
(a) The banner shows two near-identical sentences ("Found 2 skills in .claude/skills." and "Found 2 skills in the
repository that are not in this project.") and says 2 while the repo has 3 skills; the refused one appears only
after clicking Review. (b) After Import, the "Dropped frontmatter keys: allowed-tools, hooks." note is gone, so the
user never learns that deploy-check lost its tool allowlist and hooks, and the notice reads only "Imported 2
skills." (c) Once nothing importable remains the banner disappears and the refused skill is never mentioned again.
(d) The "Dropped keys" line is styled like body text with a dot, not a warning, and does not say why.
Fix: one banner sentence with the counts ("2 can be imported, 1 cannot"), mention the dropped keys in the import
notice ("deploy-check: dropped allowed-tools, hooks, which OrgAI does not run"), render the note with the warning
treatment, and keep a quiet "1 skill in the repository cannot be imported" line after import.

**P1-7. Keyboard: focus is lost after Evaluate.**
Screen: keyboard pass (`kb-02-kb-import`, log).
Activating Evaluate skills disables the button while it runs, so focus drops to `body`; the live region
(`role=status`) was empty, so a screen reader hears nothing when results land.
Fix: keep the button focusable (aria-busy) or return focus to the Last evaluation row, and announce
"Evaluation finished, 2 findings, 1 suggestion" in the live region.

### P2

**P2-1. Toolbar wraps at every width.** `Import skills` drops to its own row even at 1600 wide
(`a2-03-tools-empty`), looking like a stray button. Group the four actions: primary "Add from library", "New skill",
"Import skills", "Evaluate skills" on one row (or move Evaluate into the Evaluation group where its settings live).

**P2-2. Row actions are inconsistent.** An in-repo skill shows an Edit button and a "..." menu; the menu opens an
inline strip that repeats Edit again beside Promote and Delete (`a5-03-more-menu`). A linked skill shows no Edit,
and the menu offers "Edit in library" and "Unlink...". Use one Edit location, and make the "..." a real popover menu.

**P2-3. Redundant badges.** The inspector Skills list shows both "From the library" and "From library" chips for one
skill (`a8-01-skills-group-open`). The disclosure header ("Skills . 0 of 2") is a small boxed button unlike the
Tools, Services and Delegation headings. A disabled project skill shows "Off" in the inspector but gives no way to
turn it on from there. Show one provenance chip, style the header like its siblings, and make "Off" a link to the
toggle. The role nodes still show only "6 tools", with no skill count.

**P2-4. Add from library cannot choose roles, and links nowhere when empty.** The dialog is a single radio list
(add one skill at a time) and the empty state sends users to "Open App settings" rather than the Skill library pane
(`a6-02-add-from-library`). Make it a checkbox list with an optional role picker, and open the Skill library pane
directly.

**P2-5. New skill errors.** A server-side refusal (!`...` in the body) appears as a banner at the top, away from the
Instructions field (`a5-07`). Field errors are inline and good. Attach the refusal to the Instructions field. The
glyphs "(!`...`)" render as "(!'...')", which is hard to read; show it in a code span.

**P2-6. 1024x640 modal.** In the New skill dialog the "Who can load it?" legend is cut by the sticky footer
(`c1-10-1024-light-newform-errors`); give the body bottom padding so the fieldset is not clipped.

**P2-7. Refused skill is styled as a non-item.** In the import dialog, "Cannot be imported" has no icon or warning
colour, and its path is repeated (once as a chip, once as monospace). Add an error icon and show the path once.

**P2-8. Library provenance.** A promoted skill's library card says "From the repository". "Written in OrgAI" is clear
for created skills; use "Promoted from <project>" for promoted ones. "Used by" is plain text; make each project a
link.

## What works (keep)

- Empty state with three clear routes; Roles control on each row with a count summary; roles checkboxes keyboard
  operable; Escape closes dialogs and returns focus to the invoking button (`kb` log).
- Delete and Unlink confirms name the effect; the library Remove confirm lists the projects that lose access
  (`c3-03-lib-remove-confirm`), which is better than the MCP pattern.
- Per-field validation messages are specific (`a5-05`, `c1-10`); the refusal reason text for env-probe is clear.
- Dark and light are both legible; at 1024x640 the Tools page and library stay usable and the inspector group
  fits (`c1-06`, `c1-12`).
- Evaluation off/on is understandable: the "Model-assisted suggestions are off" info line is the right feedback.

## Ranked summary

1. P0-1 Evaluation results vanish behind an unlabelled `<summary>` row while the count still advertises them.
2. P0-2 Skills can be applied/added/promoted with Roles: none and nothing warns they will never load.
3. P1-1 A skill load shows as three transcript rows, one labelled "---".
4. P1-2 Skills loaded is run-level only, last on the page, and in a different layout.
5. P1-3 Findings are not actionable and the vague-description check false-positives.
6. P1-4 Dismiss is silent with stale counts; Apply leaves the new row off-screen.
7. P1-5 Promote has no feedback, drops Edit, and badges disagree between project and library.
8. P1-6 Import banner is redundant and the dropped-keys note is lost after import.
9. P1-7 Focus is lost and nothing is announced after Evaluate.

Spec-level items for the Product Designer: P0-2 (default roles on apply/add/import) and P1-5 (promote semantics).
