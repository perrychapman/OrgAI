# Self-help: asking OrgAI about itself (renderer spec)

Status: built on the UI Lead branch after the runtime phase A (contract in `src/shared/types.ts` section
"Self-knowledge and self-configuration", atlas in `src/shared/view/atlas.ts`). Pre-walk:
`ux-review-self-help-pre.md` (H1-H3, M1-M4, recommendations 1-5).

## 1. Entry points

| Where | What | testid |
| --- | --- | --- |
| Help > Ask OrgAI about itself… | menu action `ask-about-orgai` -> `askOrgAI()`: a fresh Chat start page, the instruction field seeded "How do I " (only when the field is empty), focus in the field, caret after the seed | (native item) |
| App settings > About | "Not sure where something is?" + button "Ask OrgAI about itself" | `ask-orgai-button` |
| Keyboard shortcuts dialog footer | "Not sure where something is?" + "Ask OrgAI" (closes the dialog first) | `shortcuts-ask-orgai` |
| Chat start page | hint "Ask how OrgAI works, where a setting is, or a shortcut. For example:" and three chips | `chat-examples`, `chat-example[data-example=theme|plan-guard|permission-mode]` |
| Dashboard first launch | "Chat now: Ask a question about OrgAI or your work, or hand over a task. No project needed." | (existing) |

Chips: "Where do I change the theme?", "What does the plan guard do?", "Make new projects ask for everything risky". A
chip replaces an empty field, the seed or another example; otherwise it is appended on a new line, so typed text is
never lost. The composer placeholder reads "Ask about OrgAI or describe the task".

## 2. Agent navigation (open_in_app)

Main pushes `AppNavigateEvent { surfaceId, projectId?, runId, agentLabel }` to the main window only (run windows never
get it). `lib/appNavigate.ts` maps every atlas surface to a target (`SURFACE_TARGETS`, total over the ids):

- App settings panes and sections -> `requestAppSettingsSection` (+ the Advanced disclosure for Motion, Terminal,
  New projects (advanced)).
- Project tabs and Settings panes / sections -> select the project, set the pane, `requestProjectSettingsSection`.
  Team and History sub-surfaces open the tab and scroll their first atlas testid into view.
- Run parts -> the project's Live view, or with no project the asking run (side tab switched for Transcript / Usage /
  Knowledge, the composer for `run-composer`).
- Assistant start pages -> `openAssistant(id, { fresh: true })`; Dashboard / New project -> the Dashboard (and the
  New project dialog).
- Shell parts -> focus the sidebar; the shortcuts dialog opens.
- Menu surfaces are never navigated: "<agent> pointed you to Help in the menu bar."

Refused, nothing moves: an unknown surface, a project this window does not have (or a virtual one), an engagement
place on a code project ("<agent> tried to open a project this window does not have.").

Focus lands on the destination heading only (the section title, else the settings pane title, else the view h1),
checked again after 400 ms so a deep link that focuses a control (the canvas style radio, the Team assistant select)
never keeps it. Never the banner, never a primary or destructive action.

Banner (`components/AppNavigateBanner.tsx`, under the Dashboard, App settings or project topbar; info tone, a named
region "Opened for you", not a live region):

- `app-navigate-banner`, text `app-navigate-text`: "<agent> opened <path> for you." Path from `atlasPath` with
  " › ", the leading "Project" replaced by the project's name ("Notes API › Settings › Limits"; "This conversation"
  for the asking chat's own parts). The agent label is cleaned of control and invisible characters and cut at 80.
- `app-navigate-back` "Back to chat": the asking run in its project (Chat for quick runs), composer focused, banner
  cleared. Absent when the destination is the asking run itself.
- Dismiss (the Banner's "Dismiss notice"): clears it and puts focus on the page heading.
- One at a time (the next replaces it); leaving the place (view or project change) clears it.
- On a run view (refusals while chatting, or a part of the asking run) no banner: the run tabs' visible notice says it.
- Every sentence also goes through `announceMenu` (run tabs' notice on a run view, else the sr-only `menu-announce`).

## 3. Proposal cards

- App settings (`appSettings`): head badge "App settings" (`proposal-target-badge`), title "Change app settings",
  table Setting / Now / New grouped by pane (`appsettings-proposal`, `appsettings-group`,
  `appsettings-change[data-field]`, `-now` muted and struck, `-new`), values formatted (On/Off, enum words, "No cap",
  "$5", tier words, accent hex with a swatch), rationale below, helper "Applies now to every project and window.",
  Approve "Apply to App settings".
- Project settings from Chat (`settings` with `target`): title "Change settings of <name>", head badge with the name,
  `proposal-target` "Applies to <name> · <folder> · <connection>" (name only when the project is not loaded), table
  `settings-change[data-field]` with Now from the stored project ("Unknown" when not loaded), every field the payload
  sets listed (a client change too, whatever the guessed kind), wording from the target project's kind, Approve
  "Apply to <name>" (cut at 40).
- Both: footer [Apply…] [Decline] [Request changes]; folded summary "Change N app settings: Theme, … and 2 more" /
  "Change N settings: …"; `proposal-approve` on every proposal card. Main writes the card titles itself; the renderer
  never relies on the agent's title (it shows as the lead line).

## 4. Transcript

`lib/selfHelpRows.ts`: an `app_reference` call and its result are one quiet row "Looked up <query> in OrgAI's
reference" (read: "Read a section of OrgAI's reference", status: "Checked OrgAI's status"), output under "Show output";
`open_in_app` is the harness row "Opened <path> for you" only (call and result hidden; a refusal keeps "Tried to open a
place in OrgAI" and the failed result); the proposals read "Proposed app settings" / "Proposed settings for <project>".
Rows: `self-help-row[data-tool]`.

## 5. Checked and open

Checked: unit tests (appNavigate, settingsTarget pinning, menuActions ask-about-orgai, appSettingsCard, selfHelpRows,
proposalSummary, proposalNext); `e2e/self-help.mjs` at 1024x640 and 1600x1000 (entry points, chips, a pushed
`app:navigate` to Appearance and a project's Limits, unknown project, menu path, Back, Dismiss, leaving clears, no page
scroll, a light-theme shot), plus assistants, menu, proposals and connections e2e still green.

Open: the `[mock:self-config]` / `[mock:self-config-project]` card path is written but SKIPs until the mock markers are
in the build; the cards and transcript rows not looked at by eye; screen reader output; macOS. Not followed from the
pre-walk: Approve is not made inert for more than 3 rows (rec 4, the team-files "read to the end" rule): the tables are
short and the fold summary names the fields; the per-field reasons (rec 4) are one rationale (the contract has one).

## Implementation notes: re-walk fix-up (ux-review-self-help.md)

- M1: while the asking run has an open proposal the banner adds "A change is waiting for you in the chat." (`app-navigate-waiting`) and Back reads "Back to chat to decide" (primary); the plain sentence and label otherwise. Not announced separately (the banner is a region, not a live region).
- M3: the banner stays above the heading in the DOM (it is shared by three views), so Tab from the heading the navigation landed on moves into the banner's first button (`navBannerAnchor`); Esc inside it dismisses. Focus on a section destination lands on the section's own heading (Appearance), not the pane title.
- M2: the folded summary is count + target ("1 app setting · App settings", "1 setting · Notes API"); the table keeps the detail. M5: the cap row reads "Estimated-cost cap per run" (local string until `PROJECT_SETTING_FIELD_LABELS` is in the base). M4: `list_projects` folds to "Listed your OrgAI projects" with the result under Show output. L3: third chip is "How do I make new projects ask before anything risky?".
- Skipped: Decline note initial focus (`ProposalCard.tsx`, not in this brief); opening Advanced on arrival after Approve.
