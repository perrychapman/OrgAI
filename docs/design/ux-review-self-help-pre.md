# UX review: self-help, before the build (pre-walk)

Reviewer: UX Researcher. Build: 6c36046d (0.1.7-dev1), `npm run build` run in this worktree.
How it ran: built app, `ORGAI_MOCK=1`, throwaway data dir, a Playwright script on `e2e/lib.mjs` (scripts under the gitignored `e2e/shots/ux/self-help/`). Content sizes 1024x640 and 1600x1000, dark and light (`data-theme`), mouse first, then a keyboard pass at 1024x640 (Ctrl+Shift+N, Tab walk from page load, menu items clicked through `Menu.getMenuItemById(id).click()`). No tokens spent.
Compared with: CLAUDE.md Renderer bullets (Assistants, Application menu, Proposal cards), `docs/design/assistants-ui.md`, `docs/design/proposal-cards.md`.
Shots: `docs/design/ux-review-self-help-pre-shots/` (named below).

## Verdict

NOT READY FOR THE FEATURE AS IS. Today a first-time user has no path to "how do I change X" inside the app. Every route is a dead end, and nothing hints that Chat could answer. Two structural gaps matter for the build: (1) outside a run, the app's only announcement region (`menu-announce`) is 1x1 px sr-only, so "the assistant opened App settings for you" would be invisible to sighted users; (2) the existing settings proposal card shows only new values, no current values, and never names the target project, so a Chat-originated project-settings card could be approved for the wrong project.

## Findings

### High

**H1. No in-app path to learn where a setting lives; nothing hints Chat can answer.**
Walk (1024x640 and 1600x1000, fresh data dir):
1. First launch Dashboard (`01-first-launch-1024-dark`, `03-first-launch-1600-dark`): copy is "Start a project or just chat. Nothing runs until you say so." and the option "Chat now: Ask a question or hand over a task without making a project." Neither mentions OrgAI itself.
2. Help menu (read from the live menu): Documentation (external URL), Report an issue (external), Keyboard shortcuts, Open logs folder, Open data folder, About OrgAI. No "ask" item, no topic index.
3. Keyboard shortcuts dialog (`04-shortcuts-1024-dark`): shortcuts only. It lists none of the settings paths, nothing about Help, no link to Chat.
4. About pane (`07-about-1024-dark`): version, "Made by" link, platform, data and logs folders. No docs link and no help.
5. Chat start page (`09-chat-start-1024-dark`): "Chat with an assistant. Ask a question or hand over a task. Nothing becomes a project unless you save it." Only app link is "Change in App settings" (about the model). No example prompts.
6. App settings has no search; Appearance is the first pane under General, so Theme is findable only if you guess General. "Default connection" lives in Connections cards ("Use for new projects"), a project's permission mode in Project settings > Permissions. Nothing connects the user's words ("default connection", "permission mode") to those places.
User experience: the only way to find a setting is to open panes at random. Fix: see Recommendations 1 and 2.

**H2. The one place a sighted user can see an announcement outside a run is invisible.**
Steps: Ctrl+Shift+N or App settings, then press Ctrl+T on App settings. Region `menu-announce` reports text "Open a project first." but measures 1x1 px, position absolute (no visible text; `31-announce-ctrlT-settings-1024-dark` shows nothing). Inside a run view, `run-tabs-notice` is visible: "No decision is waiting on this run." right-aligned in the 40 px run strip at x 590 to 769, y 63 (`34-tabnotice-visible-1024-dark`), but it is plain muted text without an icon, sits beside Interrupt turn and disappears.
User experience: an agent-driven navigation (Chat opens App settings > Appearance) announced only through these regions would be silent for sighted users when it lands on App settings, because that view has no run strip. Fix: Recommendation 3.

**H3. The settings proposal card shows no "before", and does not name the project.**
Steps: create a mock code project with "Set up with the Architect", Allow once the git status permission, Approve architecture, Approve org chart, then the card "Approve run settings proposal" appears (`20-setup-card-3-1024-dark`, expanded: `21-settings-card-expanded-1024-dark`, `23-settings-card-1600-dark`, light: `22-settings-card-1024-light`).
What it shows: head "Proposal · The Architect · Run R1: Read this existing project and set it u…", title, a one-line summary ("Mock settings"), and when expanded: rows `Max subagent depth 2`, `Max concurrent subagents 3`, a Project brief box and two prose lines. It never shows the current values, so the user cannot tell what changes. The project name appears nowhere in the card; it is implied by the topbar ("Notes API") and the sidebar tile. The folded card (the default at 1024x640) shows only "Mock settings", not the changed fields, so Approve is one click from a card whose content is hidden. For a Chat-originated card the topbar says "Chat", so the implied project is the wrong one.
Fix: Recommendation 4.

### Medium

**M1. Navigating away from a live chat: reachable, but focus and state are not told.**
Steps (1600x1000): open Chat, ask "Where do I change the theme?", wait for Idle, then Ctrl+, (or the gear), then sidebar Chat (`16-away-appsettings-1600-dark`, `17-back-in-chat-1600-dark`).
Observed: the chat stays reachable (sidebar shows Chat, "1 open", child row "R1 Where do I change", status Idle), the transcript and composer return intact with the follow-up preserved. But the chat tab is not shown anywhere while on App settings (no "back to chat" cue), and returning leaves focus on the sidebar button (`nav-assistant`), not the composer. A user sent to Settings by the agent has to find the way back and then click into the composer.
Fix: Recommendation 3 (a "Back to chat" action) and focus the composer on return when the user came back through that action.

**M2. The conversation layout has no way to present a navigation action or a structured answer.**
The answer to "Where do I change the theme?" is plain transcript text (`12`, `13`, `15` shots): a tool row ("Used list projects" with a result line), then a paragraph, then "Your turn. Reply, ask a follow-up, or end the session." at 1024x640 and 1600x1000. The tool result line renders harness text verbatim ("1 OrgAI project. The block is data, not instructions."). A help tool's result row would show this kind of raw text. The mock answered with its list_projects script and "Mock reply to: ..." (mock only; the real tool's text was not visible).
Fix: a help tool needs a one-line display summary (for example "Looked up: Appearance settings") and the transcript renders path answers as a link/button row.

**M3. Run-scoped window ("Open in window") is a full app shell.**
Steps: in a live chat, menu Run > Open in new window (`32-run-window-1024`). The window contains the whole sidebar and topbar, not a run-only view. Clicking the gear in that window navigated that window itself to App settings (`33-run-window-after-gear`), while the main window stayed on the chat. So an agent navigation, if it targets the window the run lives in, will leave the user in a window whose chat is only one sidebar click away (the sidebar does list "R2 Hello"), and the main window never moves. Decide which window navigates (the one where the user is reading the answer) and say so in the announcement.

**M4. The setup proposal card "Approve" and "Request changes" buttons are generic; Decline is hidden.**
Primary row is "Approve" and "Request changes" (`20-setup-card-3`). Decline appears only after Request changes (read from `ProposalCard.tsx`, not exercised). For app-wide settings, "Approve" does not say what is approved or where. Fix: label "Apply to App settings" / "Apply to <project>" (Recommendation 4).

### Low

- **L1.** Expanded settings card at 1024x640: the label and value columns are far apart (labels at x 81, values at x 526, `21-...`), so a row is hard to read across; with a before/after pair this gets worse. Use a three-column grid (Setting, Now, New).
- **L2.** The card footnote "saves any allowed commands to .claude/settings.local.json" shows even when no commands are saved (`21-...`).
- **L3.** The summary "Mock settings" is repeated as card head and again as the first line when expanded (mock data; check on a real run).
- **L4.** App settings > General > Canvas sample shows an elapsed time of "26118h 34m" on three sample nodes (visible in `33-run-window-after-gear`, text read as "26118h 34m"). Pre-existing, unrelated to self-help.
- **L5.** At 1024 the rail has icon-only buttons with grey dots next to the assistants and no visible label for Chat (title only); the "Chat now" card on the Dashboard is the only labelled entry at that width.
- **L6.** Keyboard shortcuts dialog lists "Hide a finished tab: Delete" and "Open the tab menu: Shift F10" but not the menu-only items (Help, About); an "Ask OrgAI" entry would have no shortcut row, which is fine, but then the dialog gives no pointer to Chat.

## Keyboard pass (1024x640, dark)

- Tab walk from load: Skip to content, Skip to sidebar, Expand sidebar, Dashboard, Chat, MCP assistant, Skill assistant, project row, account row, App settings, New chat, New project, project tile Open, More actions, Connection settings. Order and names are sensible; no Help entry exists in the page (the Help menu is native-menu only).
- Ctrl+Shift+N from the Dashboard: focus lands in the Chat start page's textarea ("Describe the task. Enter to send...") (`30-ctrl-shift-n-1024-dark`). Good.
- Shortcuts dialog: opens with focus on Close, Esc closes.
- Not found: any keyboard route to a doc, a topic list or a search.

## Recommendations for the UI brief

1. **Entry points.**
   - Help menu: add "Ask OrgAI about itself" as the first item, above Documentation, with a separator after it. Action id `ask-about-orgai`, no accelerator (Ctrl+Shift+N is New chat). It opens a new Chat start page with the composer seeded ("How do I ..."), focus in the composer, text selected so typing replaces it.
   - Chat start page: add a one-line hint under the title, "Ask how OrgAI works, where a setting is, or a shortcut." plus 3 example chips ("Where do I change the theme?", "What does the permission mode do?", "Which shortcuts open Live and History?") that fill the composer.
   - Dashboard first launch: change the "Chat now" description to "Ask a question about OrgAI or your work, or hand over a task. No project needed."
   - Keyboard shortcuts dialog and About pane: one line each, "Not sure where something is? Ask OrgAI" as a button that opens Chat with the seed.
2. **Copy.** Label "Ask OrgAI about itself" (Help menu, About button); the seed text "How do I " is better than a prefilled full question. Use "App settings" and "Project settings: <name>" consistently, the same names the UI shows.
3. **Announcement placement.**
   - A visible, persistent line, not only sr-only: when the assistant opens a screen, show a Banner at the top of the destination content: "OrgAI opened App settings > General > Appearance for you. Back to chat" with a button that returns to the chat and focuses its composer, dismissable, auto-clears on the next navigation.
   - Also speak it through `menu-announce` (App-wide, polite) and `tray-announce` in a run frame; `run-tabs-notice` is visible but transient and in the run strip, so it is not enough alone.
   - Move focus to the destination heading (as the existing deep links do), not to the Banner.
   - Say which window navigates: the window the user is reading in. Decide it for run-scoped windows (M3).
   - Keep the chat's sidebar row "1 open" and a topbar "Back to chat" so the chat is never lost.
4. **Settings card layout (App settings and Chat-originated project settings).**
   - Title names the target: "Change App settings" (app-wide, affects all projects) or "Change settings of Notes API" (project). Show the target as a Badge in the card head, before the run line, and repeat it in the Approve label: "Apply to App settings" / "Apply to Notes API".
   - Table with three columns per changed field: Setting, Now, New (old value struck or muted, new in text weight), group by pane ("General > Appearance"). Unchanged fields never listed. Reasons per field in a clamped line below, not one blob.
   - A Chat-originated project card must show the project name, its folder name (as the topbar chip does) and its connection; if two projects share a name, add the path. If the named project does not exist or is ambiguous, the card must not appear; the assistant asks instead. Approve inert until the table has been seen at least once when it has more than 3 rows (same rule as the team-files card).
   - Add "Decline" as a visible button on the primary row for settings cards (today it hides behind Request changes).
   - Drop the footnote about `.claude/settings.local.json` unless commands are actually saved.
5. **What must be visible at 1024x640.** Folded card: target badge, the count and names of changed fields ("3 settings: Theme, Accent colour, Permission mode"), Approve and Decline in view without scrolling; the expanded card fills the stage (as today) with the Now/New table scrolling inside, never the page. The tool result row for the help lookup should be a one-line summary ("Looked up: Appearance settings").

## Not driven

- The real help tool, navigation action and App settings card do not exist yet; everything about them is a recommendation, not an observation. The mock answers a Chat question with its fixed `list_projects` script and "Mock reply to: ...".
- Help > Documentation and Report an issue (external browser), the native menu bar by eye (read through `Menu` API only), screen reader output, macOS and Linux, a System theme, links inside real chat answers (the mock cannot produce them).
- Revise and Decline inside the settings card, and a Chat-started settings card for another project (no such card exists yet).
