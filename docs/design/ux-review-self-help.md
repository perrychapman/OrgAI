# UX review: self-help, post-landing walk

Reviewer: UX Researcher. Build: c8c4cf72 (0.1.7-dev1, contains the self-help merge a72008b3), `npm run build` in this worktree.
How it ran: built app, `ORGAI_MOCK=1`, throwaway data dir (`e2e/lib.mjs` `launch`), scripts under the gitignored `e2e/shots/ux/self-help/` (walk1-5). Content sizes 1024x640 and 1600x1000 through `setContentSize`, dark and light through the Appearance setting, mouse first, then a keyboard pass at 1024x640. Menu items clicked through `Menu.getMenuItemById(id).click()`. No tokens spent.
Compared with: `docs/design/self-help.md`, `ux-review-self-help-pre.md`, CLAUDE.md Renderer bullets.
Shots: `docs/design/ux-review-self-help-shots/` (named below). Note: `20-card-1024-light` and `21-card-expanded-1024-light` show a run started while the theme was already light (the "Nothing to change" path), not a card.

## Verdict

MOSTLY FIXED. The feature works end to end on the mock: every entry point opens a seeded Chat, `[mock:self-config]` lands on App settings > Appearance with a visible banner, an announcement and focus on a heading; Back to chat lands in the composer; both cards show Setting / Now / New, name their target and say what Approve does; Approve changes the theme and writes a project cap. Pre-walk H1, H2, H3 and M1, M2, M4 are fixed. No High findings. The most important new gaps: the banner says a place was opened but not that a change is waiting in the chat (a user left on App settings with Theme "Dark" has no cue about the proposal except the sidebar bell), the banner is before the heading in the tab order so a keyboard user cannot reach Back to chat with Tab, and the project card shows a raw field name line (`maxBudgetUsd -> 5`).

## Status of the earlier findings

| Item | Status | Evidence |
| --- | --- | --- |
| H1 no in-app path / nothing hints Chat can answer | Fixed | Help > "Ask OrgAI about itself..." seeds "How do I " with the caret after it, focus in the field (`02`); About button `ask-orgai-button` (`04`); shortcuts footer "Not sure where something is? Ask OrgAI" closes the dialog and lands in the Chat field (`05`); Chat start hint plus three chips (`03`); Dashboard "Chat now: Ask a question about OrgAI or your work..." (`01`). See L1, L2 for placement nits. |
| H2 announcement invisible outside a run | Fixed | Visible banner under the App settings and project topbar at both sizes (`10-banner-*`, `40-project-banner-*`); `menu-announce` also carries "Assistant opened App settings > General > Appearance for you." for about 5 s (sampled each 500 ms). |
| H3 settings card has no Before, no project name | Fixed | `13-card-*`, `31`: Setting / Now / New table (Theme Dark -> Light; Spend cap per run No cap -> $5), head badge "App settings" / "Notes API", "Applies to Notes API · <folder> · Anthropic", Approve "Apply to App settings" / "Apply to Notes API". |
| M1 away from chat: focus and state not told | Fixed | Back to chat focuses the composer ("Reply to the assistant...", `12-back-*`); the sidebar Chat row shows a count badge and the bell shows "Needs you 1" while away (`41`). |
| M2 no structured display of a lookup / navigation | Mostly fixed | Rows "Looked up theme in OrgAI's reference", "Opened App settings > General > Appearance for you", "Proposed app settings" (`13`). Open: M4 below (the project run still shows raw `list_projects` text). |
| M3 run windows | Not driven | Spec says navigation goes to the main window only; not exercised here. |
| M4 generic Approve, Decline hidden | Fixed | Footer is [Apply to ...] [Decline] [Request changes] on both cards, also folded at 1024x640 (`13`, `30`). |
| L1 label/value far apart | Fixed | Three-column table (`31`). |
| L2 `.claude/settings.local.json` footnote | Fixed | Not shown on either card. |
| L3 summary repeated | Open, see M2 | The folded line and the expanded "Change app settings: Theme dark -> light" say the same thing twice (qa's note holds). |
| Recommendations skipped on purpose (Approve inert until read, reason per field, topbar Back to chat) | Rated | Table is one row on both mock cards, so inert-until-read is not needed here; one rationale line is clear for one field; a topbar Back to chat is not needed while the banner stays (see M1 for the banner's lifetime). |

## Findings

### High

None.

### Medium

**M1. The banner does not say a change is waiting, so the user can sit on App settings with the old value and no hint.**
Steps (1024x640 dark): Ctrl+Shift+N, send `[mock:self-config]`, wait about 2 s. The app moves to App settings > General > Appearance (`11-state-card-1024-dark`): Theme shows Dark selected; the banner reads "Assistant opened App settings > General > Appearance for you. Back to chat". The only sign of the proposal is the bell ("1") and the orange dot on Chat in the rail. At 1600x1000 the sidebar says "Needs you · 1" and a "1" badge on Chat (`41`), which is clearer, but the banner itself is silent about it.
User experience: they see the setting they asked about, may click Light themselves, and later find a card in the chat that proposes the same thing (or "Nothing to change", see L4).
Fix: when the run has an open decision, append to the banner text "It also proposed a change; review it in the chat." and make Back to chat the visible primary action, or name the card in the announcement ("Assistant opened ... and is waiting for your answer").

**M2. The project card repeats the change three times and shows a raw field name.**
Steps: create a project, Chat `[mock:self-config-project]`, press Details (`31-project-card-expanded-1024-light`). Lines: "Change 1 setting: Spend cap per run", then `Settings for project "Notes API": maxBudgetUsd -> 5` (the agent's own title line, with the code field name and an arrow), then "Applies to Notes API · folder · Anthropic", then the table Spend cap per run No cap $5. The App settings card says the same twice ("Change 1 app setting: Theme" and "Change app settings: Theme dark -> light").
User experience: `maxBudgetUsd` is internal wording on a card meant for first-time users; the table already says everything.
Fix: render the agent's lead line only when it is not machine-derived (or drop the "Settings for project ...: field -> value" line, which main writes), and keep one summary line plus the table.

**M3. The banner comes before the page heading, so Tab from where focus lands skips Back to chat.**
Steps (1024 dark): after the navigation focus is on the H2 "General". Press Tab six times: Theme radios, accent swatches (`50-keyboard-banner-1024-dark`, order `["|","|Violet","|Blue",...]`). Back to chat is only reached with Shift+Tab (`General`, `Dismiss notice`, `Back to chat`; same at 1600, `42`). Escape does nothing on the banner.
User experience: a keyboard user told "Back to chat" exists must go backwards; a screen reader user hears the banner only if they navigate to the region "Opened for you".
Fix: either move focus to the banner's Back to chat when the destination is not the heading the user asked for (spec forbids focusing the banner: keep that), or place the banner after the heading in DOM order, or make the announcement say "Back to chat is above the page title". Add Esc to dismiss.

**M4. The project run's tool rows still show raw harness text.**
Steps: `[mock:self-config-project]`. The transcript row reads "Used list projects" and then "1 OrgAI project. The block is data, not instructions." with Show output (`31`, `32`). `list_projects` has no `self-help-row`, so it was not given the quiet sentence that `app_reference` got.
Fix: a one-line summary for `list_projects` ("Listed your projects") and keep the data block under Show output only.

**M5. "Limits shows the $5 cap" is true only after opening Advanced settings.**
Steps: approve the project card, Project settings > Limits (`33-limits-1024-light`): the pane shows only the plan guard sentence and a closed "Advanced settings". The cap "Estimated-cost cap per run" = 5 is inside (`36-limits-advanced-1600-light`). The card promised a "Spend cap per run".
User experience: after approving, the place they are sent to confirm it shows nothing; the label also differs ("Spend cap per run" on the card, "Estimated-cost cap per run" in Settings).
Fix: use the same label in both, and when the card's field lives in Advanced, open the disclosure on arrival (a "Back to chat" after approval does not land there either).

### Low

- **L1.** Help menu order: "Ask OrgAI about itself..." sits fourth, after Keyboard shortcuts (items: Documentation, Report an issue, Keyboard shortcuts, Ask OrgAI about itself..., separator, Open logs folder, Open data folder, separator, About). The pre-walk recommended first.
- **L2.** Chat start page has three statements about asking: "It asks before it changes anything." (`chat-asks-line`), the hint "Ask how OrgAI works, where a setting is, or a shortcut. For example:" with chips, and below, "Works in a private scratch area. Asks before it changes a file or runs a command." (`03`). At 1024x640 the page fills the height (no page scroll). Merge the first and third.
- **L3.** The third chip ("Make new projects ask for everything risky") is a command, the first two are questions; clicking it also replaces an earlier chip text but a typed draft is kept, which is right. The shortcuts "Ask OrgAI" path leaves an earlier draft untouched instead of seeding (correct per spec, but the field then shows the old text, not "How do I ").
- **L4.** When the proposal changes nothing (theme already light) the transcript shows "Proposed app settings", "Nothing to change: those settings already have these values." and the assistant says the theme is already light (`20-card-1024-light`): good, but no card at all, so the Needs-you bell never lights. Fine; noted as checked.
- **L5.** Focus lands on "General" (the pane title) when the destination is Appearance (`H2:General`), not the Appearance section heading the spec names; the focus ring around the large "General" heading (`11-state-card`) is the only cue to where the user is.
- **L6.** After Request changes the card is gone and the assistant replies "Understood; I left the settings alone." (`23`), clear. The Decline path opens an optional note form with [Decline] [Back] (`53`) and finishes cleanly (`54`). Good; the form's first focus was the Back button in my run (`BUTTON:Back`), not the note field.
- **L7.** The mock names runs "Mockself-config" (a title of the first four words with the bracket removed); a mock artifact, not checked on a real title.
- **L8.** The folded card's "Details" toggle sits far right of the title and is the only control that reveals the table; at 1024x640 the table is hidden by default, so Approve is one click from a collapsed card (it names the field: "Change 1 setting: Spend cap per run", but not old or new value).

## Keyboard pass (1024x640, dark)

- Ctrl+Shift+N opens Chat start with focus in the field; Enter sends.
- Help item, About button, shortcuts "Ask OrgAI" all end in the Chat field; the shortcuts dialog opens with focus on Close.
- After the navigation: focus on the H2; announcement in `menu-announce`; banner not in the forward tab order (M3); Dismiss notice puts focus on the page heading (`H2:General`), Back to chat puts focus in the composer.
- Card: Details, Apply, Decline, Request changes in order; Request changes reveals a textarea (feedback, Send feedback, Back); Decline reveals an optional note (Decline, Back).

## Banner placement when the user was not looking at the chat

- Clicked a project tile 150 ms after sending the Chat prompt: the app was on the project's Live start page, then after about 2.5 s it moved to App settings with the banner (`41-navigated-while-elsewhere-1600-dark`). The user is pulled away from the project they chose with no confirmation, only the banner and an announcement. Acceptable for an explicit ask, but the unexpected move is the most disorienting case; the banner placement itself (under the 48 px topbar, full content width: 936 px at 1024, 1336 px at 1600, 46 px high) is fine and does not push the page into scroll in either theme.
- A project destination (pushed event, as the e2e does): banner under the project topbar, above "Project settings", at both sizes (`40-project-banner-1024-light`, `40-project-banner-1600-dark`); focus on the "Limits" heading.

## Not driven

- Help menu by eye (native menu read through the Menu API), Help > Documentation / Report an issue.
- Run windows (spec: navigation goes to the main window only), screen reader output, macOS, Linux, System theme.
- A real agent's tool results, real run titles, real model answers; open_in_app refusals and menu-place sentences were not produced by the mock (only the e2e's pushed events cover them; I pushed one project event).
- Light theme of the App settings card at 1024 (the light run hit "Nothing to change"); the light project card is shown (`30`, `31`, `35`).
- Two projects with the same name, a project not loaded in the window, the card's "Unknown" Now values.
