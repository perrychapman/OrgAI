# UX review: agent import, second walk (dev be68cd7)

Walked the built app on mock data (`ORGAI_MOCK=1`, fresh temp `ORGAI_DATA_DIR`) as a first-time user, driving it with playwright-core directly so the window could be resized and the theme switched.
Fixtures (git repos in temp): (a) Claude Code, three agents in `.claude/agents` (`backend-dev` sonnet with Read, Edit, Bash; `reviewer` claude-opus-4-6 with Read, Grep; `mystery` with an unknown model and no tools) plus `AGENTS.md`; (b) opencode, `opencode.json` with a primary `lead`, subagent `coder` (openai/gpt-5-mini, tools `bash` and `write` true) and subagent `docs` (anthropic/claude-haiku-5-5); (c) an OrgAI export (`.orgai/org.json` from Org chart > Export to repo) opened as a project.
Coverage: 1024x640 dark (form, dialog, tab order), 1024x640 light (dialog, stale error, imported banner), 1280x800 dark and light, 1600x1000 light (form lines, opencode dialog). Keyboard-only: form Tab order, dialog focus on open, close and Escape, Tab order inside the dialog, Replace confirm and Undo by Enter. Not done: 1600x1000 dark, a full keyboard-only run of the form submit (I focused controls directly for the later steps), a Windows high-contrast pass.
Screenshots are in `C:\Users\chapp\AppData\Local\Temp\ximp2\shots\` (not committed): `b02-found`, `b03-review-1024`, `b05-after-escape`, `c03-scroll1/2`, `c05-after-stale-click`, `d02-dialog-light-1024`, `d03-stale-scrolled-light`, `d05-imported-light`, `e03-role-models`, `f01-already`, `f04-oc-dialog-1600`, `g04-export-dialog`, `h02-replace-confirm`, `h04-undone`.

What now works well (do not regress): the form names what it found and offers a three-way choice with a submit label that follows it; every role row shows reports to, `from -> to` model with an editable select and a reason, granted tools as chips, a full prompt behind "Read prompt" and its source file; one warnings roll-up; "Nothing is written until you import. Your files are not changed."; Replace asks for a confirmation that names the roles and defaults focus to Cancel; focus returns to the Import agents button after apply; a user's model choice survives Refresh preview; Role models in Settings > Connection lists every role with tier and model.

## Findings, ranked

### P1-1 opencode tool grants are dropped silently, and the "Can run commands" chip contradicts the Granted line
Where: New project > opencode fixture > review dialog (`f04-oc-dialog-1600`).
`coder` declares `tools: { bash: true, write: true }`. The row shows "Granted: Read Glob Grep" and "No tools listed: read-only by default", with no "Not available" or "narrowed" line. The user's explicit grant of Bash and Write is lost without a word. `lead` (no tools key) carries the amber "Can run commands or edit files" chip while its own Granted line says Read, Glob, Grep: the chip is probably `canSpawn`, but its text promises shell and edit access. Both rows give the user a wrong picture of what each role can do.
Fix: parse the opencode `tools` map (`bash`, `write`, `edit` true) into granted tools; when a source key cannot be mapped, add a note "opencode tools bash, write were not recognised; read-only". Split the chip by cause: "Can run commands or edit files" only when Bash, Edit, Write or NotebookEdit are granted, and "Can start other agents" for `canSpawn`.

### P1-2 A stale-preview error appears at the top of the dialog, out of sight, and focus is lost
Where: review dialog scrolled to the last role, a source file changed on disk, click Import (`d03-stale-scrolled-light`).
The red "Nothing was imported" alert renders at the top of the scrolled body (measured 628 px above the viewport; scrollTop stayed 810). The visible screen shows nothing happened. The footer button is the only thing in view. Focus also drops to the page body (the Import button is replaced), so a keyboard user hears nothing.
Fix: on error, scroll the alert into view and move focus to it (`role=alert` with `tabIndex=-1`), or show a one-line error in the footer next to the buttons ("The files changed. Refresh preview") with the Refresh button there. Keep focus on the primary action.

### P1-3 "Review import" on the New project form creates the project first
Where: New project form, submit (`b05-after-escape`).
The label says review, but the project is created with the default chart before the dialog opens. Pressing Escape or Cancel leaves a project with a chart that is not the one the user chose, and a banner "Found 3 Claude Code agents not in this chart" on a project they believed they had not made yet. The form also lets the same folder become a second project: the "This folder is already a project: cc. Open it" line is only advisory and the button still says "Review import" (`f01-already`).
Fix: either rename the submit to "Create project and review import" (and say so under the radio group: "The project is created first; you review the roles next"), or hold creation until Import. When the folder is already a project, turn the primary action into "Open cc" and make creating a duplicate a secondary link.

### P2-1 The raw IPC error leaks into the stale message
Where: stale alert (`c05-after-stale-click`).
Text reads "Error invoking remote method 'projects:applyImport': Error: The agent definitions in the folder changed...". Fix: strip the Electron wrapper in the renderer (take the text after the last "Error: ") for this and every IPC error shown in a banner.

### P2-2 The dialog spends its first screen on repeats, and the roles start below the fold at 1024x640
Where: review dialog at 1024x640 (`b03-review-1024`, `d02-dialog-light-1024`).
Source header, Add/Replace toggle, an amber "3 things to check", a blue AGENTS.md notice, and a paragraph on model mapping use about 400 px; the first role is half visible. The AGENTS.md fact is said twice (a warning bullet "Instruction files are not turned into roles" and the info banner). The sentence "Sources without a hierarchy report to the orchestrator" also shows for the OrgAI export, which has a hierarchy (`g04-export-dialog`).
Fix: drop the AGENTS.md bullet from the warnings list when the info banner is present; make the mapping paragraph a short muted line and show the hierarchy half only when a source has none; collapse the file list to "3 files" with a title. Consider a sticky summary row ("3 roles, 1 warning") so the user sees the count while scrolling.

### P2-3 Add vs Replace is a bare toggle with different defaults per entry
Where: toolbar entry opens on Add; New project opens on Replace (`c02`, `b03`).
Nothing explains the consequence. A first-time user in Add mode sees only the "reviewer-2" rename warning and does not learn that Replace exists to avoid duplicates.
Fix: one muted line under the toggle that changes with the mode ("Adds 3 roles next to the 4 you have" / "Replaces your 4 roles with these 3"), and the same wording in the footer button ("Add 3 roles" / "Replace with 3 roles").

### P2-4 The chart is not fitted after an import
Where: Org chart after apply at 1024x640 (`d05-imported-light`).
Seven nodes were added but the view stays on the old extent; imported roles are cut off at the bottom edge, so the result of the action is invisible without panning.
Fix: call fitView after applying an import or Undo.

### P2-5 Undo is session-only and its aftermath is quiet
Where: banner after apply, after Undo, after restart (`d05`, `h04-undone`).
The Undo button is gone after an app restart (the banner is memory only), and nothing says so. After Undo the "Found N agents not in this chart" banner is replaced by "Import undone", so a user who undid a mistake has lost the prompt to try again (the toolbar button remains). Undo by keyboard drops focus to the page body.
Fix: after Undo keep a "Review import" button in the "Import undone" banner and focus the Import agents button. Persist the undo for the project's current session, or say "You can undo until you close OrgAI" in the success banner.

### P3-1 "Reports to" offers "Not set" and role names without slugs
Where: any row's Reports to select. It lists "Not set", then existing roles, then the other imported roles, with no indication that "Not set" makes the role a second root. Fix: label it "No manager (top of the chart)" and show "(imported)" on new rows; the Orchestrator-only default is correct.

### P3-2 Tools list grows without notice
Where: `backend-dev` declared Read, Edit, Bash and shows Granted Read, Edit, Write, Bash (`c03-scroll1`). Write was added by the Edit mapping with no note. Fix: a muted note "Edit includes Write in OrgAI".

### P3-3 Focus when the dialog closes without a trigger
Where: Escape on the dialog that opened from the New project form (`b05`). Focus lands on the document body. Fix: move focus to the Org chart tab or the banner's Review import button.

### P3-4 Settings > Connection "Role models"
Where: `e03-role-models`. Useful and correct, but the heading is link-coloured text (reads as a link), the rows mix display names (Orchestrator) with slugs (backend-dev, reviewer next to Reviewer), and it does not say which roles were imported. Fix: use the same heading style as other section titles, show display names, and append an "imported" chip.

### P3-5 Form layout
Where: `f01-already`. The checkbox "Use the mock adapter" sits directly under the three radios with the same spacing and reads as a fourth choice (mock mode only). The found line, the already-a-project line and the generic Architect hint stack as three muted lines of equal weight; the already-a-project line should be the visible one and the Architect hint is wrong for the Import choice. Fix: add a divider before the mock checkbox; hide the Architect hint when Import is selected.

## Keyboard summary
Form: Tab order is Browse, Name, brief, radio group (one stop), mock checkbox, submit: sensible. Dialog: focus lands on "Close dialog", Tab then enters the Add/Replace radios, role rows (checkbox, reports to, model, Read prompt), Cancel, Import, Close, and wraps (a real trap). Arrow keys switch the mode. Escape closes the dialog and also closes the Replace confirm alone (focus returns to Import). Enter on Import with Replace opens the confirm with Cancel focused. Export dialog opens focused on Cancel, and focus returns to the Export button afterwards.
