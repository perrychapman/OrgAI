# UX review: Assistants (re-walk of the ad-hoc runs review)

Walked commit **34f6370** (dev HEAD, "UI Lead: Assistants UI: sidebar, pages, forms"), built in this worktree with `npm ci` + `npm run build`. `ORGAI_MOCK=1`, fresh temp `ORGAI_DATA_DIR`, mock adapter only (no tokens). Driven with a small Playwright-over-Electron harness kept outside the repo; the native folder picker was stubbed in the main process (`dialog.showOpenDialog`) to return a temp git repo, because the picker is the only way to choose a folder (see M1).

Windows: 1600x1000 and 1024x640, dark and light (dark for most flows, light for the start pages, the rail and the skill assistant). One keyboard-only pass of the Chat start page and one of answering the skills proposal. Shots are in `ux-review-assistants-shots/` (24 files, all under 180 KB).

## Verdict

The feature answers the old review. A first-time user now sees "Chat now" next to the project form on first launch (shot 01, 40), a "New chat" button on the Projects view, and an "Assistants" group in the sidebar. A chat with no folder is one click, one typed line and Enter: 1 click + 1 line on first launch, 0 extra screens (old path: about 6 clicks and 2 fields, with a permanent project). The trust line before Start is good (scratch or folder, read-only or edits, model, "Mock run, no tokens"). A finished chat lives in Chat > History with Folder and Kind chip, and Save as project works end to end.

What is not right yet is the thing the user called a "daily chat interface": a Chat run is the project run view, a canvas holding one node, with the actual conversation in a side panel. At 1024 that panel is collapsed on first view, so after sending a message the user sees a node saying "Waiting for your reply" and no answer (shot 05). That is the one finding I would fix before shipping. After it, the rest are small: a stale "Save as project" button that errors after you used it, a "disabled" control that looks enabled, "Configure with AI" landing on the previous finished run, and leftover project vocabulary ("unattended", "Replying to the orchestrator", "Done.").

Naming: "Chat" reads well next to "MCP assistant" / "Skill assistant" in the sidebar (shot 02), better than "Quick run". It is the only one of the three that is a verb-ish noun for the user's own work; the other two are tools. Fine as is. The empty-state title "Chat with an assistant" repeats the word "assistant" that is also the group label; acceptable.

## Scenario counts (1600x1000 unless noted)

| Scenario | Clicks | Typed | Screens | Notes |
| --- | --- | --- | --- | --- |
| 1 First launch, chat with no folder | 1 (Chat now) | 1 line + Enter | 2 (Projects, Chat) | follow-up: 0 clicks, 1 line + Enter. End session 1 click. Find again: History tab 1 click (it is the same Chat row) |
| 2 Chat in a folder with edits, then Save as project | Chat row or Ctrl+Shift+N (1), Browse (1), edits switch (1); later End session (1), Save as project (1), confirm (1) | 1 line + Enter, optional name | 3 + dialog | no way to type a path (M1). Lands on the new project's Live tab, run moved |
| 3a MCP assistant from the sidebar | 1 + Approve (1) | 1 line | 1 | build switch off |
| 3b MCP assistant via Connectors > Configure with AI | gear (1), Connectors (1), scroll, Configure with AI (1), then "+" (1) | 1 line | 3 | extra "+" because it lands on the last run (H2) |
| 4 Skill assistant, library | 1 + Approve (1) + gear (1) + Skill library (1) | 1 line | 3 | skill is there (shot 29) |
| 4b Skill assistant, project scope | project (1), Team (1), Catalog (1), Ask the Skill assistant (1) | 0 | 1 | opens on the project's Live tab with the proposal, "This project", roles listed (verified in text; shot 31 is the entry point) |
| 5 Needs-you while a proposal waits | bell row (1) | 0 | popover | wording ok (shot 19) |
| 6 Rail at 1024 | 0 | 0 | | see below |

## Findings, ranked

### High

**H1. A Chat has no visible conversation.**
- Flow: scenario 1, step "send the first message". Shots 05 (1024, panel collapsed), 06 (panel opened), 12 (1600, panel open).
- Seen: after Enter the Live view shows a one-node canvas ("Assistant, Waiting for your reply, 1.6k tok, $0.00285") and a composer. The reply is only in the right-hand SidePanel Transcript. At 1024 that panel starts collapsed (rail button "Hide run panel" is a bare icon at the top right), so the first answer is invisible; the user must discover the icon. At 1600 the panel is open but a chat still reads as "a graph with a text column".
- Expected: for a chat run (single agent, `kind: quick`, "One assistant" team) the transcript is the main surface and the canvas is secondary or hidden; at minimum the panel opens on first message and stays open.
- Severity: High (the feature's headline use is "a daily chat interface").
- Fix: for `kind === 'quick'` with one agent, render the transcript in the stage column and keep the canvas behind a "Show graph" toggle; cheaper interim fix, auto-expand the SidePanel on the first run of an assistant virtual project. Owner: `components/layout/SidePanel.tsx` + `views/LiveRunView.tsx` (stage choice), `lib/assistants.ts` for the predicate.

**H2. "Configure with AI" in Connectors lands on the previous finished run, not on the start page.**
- Flow: scenario 3b. Shots 21, 22.
- Seen: with an ended MCP assistant run R1 open, Configure with AI selects the MCP assistant row but shows R1 ("Stopped", composer "Continuing this run (from 1 min ago)"). No start page, no instruction field, nothing says "start a new request". The spec (`assistants-ui.md`) promises the start page with the instruction prefilled (`openAssistant('harness', { instruction })`); the prefill is also not applicable here because the page is not shown. First-time users have no run, so they would see the start page; any returning user hits this.
- Expected: Configure with AI always opens a fresh start page (the "New run" tab), seeding the instruction if given.
- Severity: High for returning users (the stated entry point from Connectors); it needs a "+" click to recover and the user may think nothing happened.
- Fix: `openAssistant` should select the start page when called with `instruction` or from an entry point; do not restore the last viewed run. Owner: `store/` `openAssistant`, `components/mcp/McpSection.tsx` caller.

**H3. "Save as project" stays on the run strip after the run was moved, and then errors.**
- Flow: scenario 2, after "created". Shots 14, 16.
- Seen: after Save as project the run lands in the new project (good, shot 14) but the run strip still shows "Save as project" with the tooltip "Saves this chat as a project in its folder". Clicking it opens the same dialog and Save ends with the inline error "Quick run not found." and no way forward.
- Expected: the action disappears once the run belongs to a real project (or opens "Open repo-typo").
- Severity: High (an error on a primary action right after the success path), though recoverable with Cancel.
- Fix: gate `run-save-as-project` on `projectId` being a virtual id, not on the run's kind alone. Owner: `RunActions.tsx` (where `run-save-as-project` is rendered) and the store's `run.moved` handler if it leaves `kind: 'quick'` on the moved summary.

### Medium

**M1. A chat folder can only be chosen with the native picker.**
- Flow: scenario 2. Shot 11. `[data-testid=chat-folder]` has Browse and Clear only; there is no text field and no paste target. The brief for this walk said to type a path; that is impossible. The new-project form has a typed path field with a `checkPath` line, so the two forms disagree, and a folder in a terminal or file explorer cannot be pasted. Drag and drop of a folder is not supported either.
- Expected: Browse plus an editable path, or accept drop/paste on the row. Fix: add an Input in `ChatStartPage` bound to `projects.checkPath`. Owner: `components/assistants/ChatStartPage.tsx`.

**M2. "Save as project" in History is "disabled" but looks and behaves enabled.**
- Flow: scenario 1, History. Shot 09. For a scratch chat `[data-testid=history-save-as-project]` is `aria-disabled="true"`, `title="A scratch chat cannot become a project"`, but computed opacity 1, `cursor: pointer`, full text colour. Clicking does nothing, silently. The same on the run strip (shot 08).
- Expected: dimmed style and a visible reason ("Scratch chats cannot be saved; choose a folder to do that next time"). Fix: add a `[aria-disabled=true]` rule for `.btn` (or reuse the project's disabled token), and put the reason as visible hint text under the button in the run actions. Owner: `styles` for `.btn[aria-disabled]`, `RunActions.tsx`, `HistoryView.tsx`.

**M3. Idle copy "Done." is wrong whenever the assistant asked something.**
- Flow: scenarios 1, 2, 3. Shots 05, 20, 26. The label "Done. Ask a follow-up or end the session." shows directly under a transcript line "Tell me what you would like to do." (shot 12). The status chip says Idle and the node says "Waiting for your reply". Three phrasings for one state, and "Done." claims completion the assistant has not claimed.
- Expected: "Your turn. Reply, ask a follow-up, or end the session." Fix: `ASSISTANT_IDLE_LABEL` in `lib/assistants.ts`.

**M4. Project-run vocabulary leaks into the assistants.**
- Flow: scenarios 3, 4. Shots 18, 26, 36.
  - Run meta says "unattended" on every MCP and Skill assistant run, including while a proposal is waiting for the user (from my own F7, still open). It is wrong here: the assistant needs the user.
  - The composer says "Replying to the orchestrator" in library scope (no orchestrator exists in the user's world), and "Replying to Orchestrator" in the project-scope skill run.
  - The Chat tab "+" and the first tab read "New run" ("New run: a blank page for a new task", shots 02, 33). Listed open item; confirmed. The ended-run area shows "Continuing this run (from 1 min ago)" and a placeholder "What next?. Enter to send..." with a doubled punctuation (shots 08, 22, every ended run).
- Fix: `RunMeta.tsx` (hide "unattended" for virtual projects), composer label in `Composer.tsx`/`LiveRunView.tsx` (use the assistant's label), `RunTabs.tsx` ("New chat" / "New session"), placeholder string "What next?" without the trailing period. Owner: those files.

**M5. Chat run is nudged to "write a plan" and answers with a mock plan line.**
- Flow: scenarios 1, 2. Shots 06, 12. Every chat transcript contains "Continuing: asked the orchestrator to write a plan before it works." and "Mock: continuing with the plan." A chat is not a plan run. In the mock this is the `ContinuationDriver`; for a real model a plan nudge in a one-assistant chat would be noise or an unwanted extra turn and cost.
- Expected: no nudge for `kind: 'quick'` (like setup runs). Fix: exempt quick runs in `nextNudge` / `ContinuationDriver`. Owner: runtime (`continuation.ts`) — flagged for the runtime lead, not verified against a real adapter.

**M6. The Chat start page is tall; the composer is cut off at 1024x640.**
- Shots 03, 33 (composer bottom at y 648 of 641). The empty-state illustration and heading take about 300 px. Start is visible but the composer border is clipped and the page scrolls once a folder note appears (shot 38). Keyboard focus lands in the composer, so it is usable, but the trust line and Start sit at the very bottom. Fix: drop or shrink the illustration under `@container (max-height: 700px)`, or use `justify-content: flex-start` with a smaller top gap. Owner: `components/assistants/InstructionStartPage.tsx` and its css. (Listed open item; confirmed, not blocking.)

**M7. The MCP assistant's "Let it build a server here" does not say where.**
- Shot 17. "here" has no referent (a workspace in the data folder). The trust line for the switch mentions only commands and edits. The Chat page names its folder; this page should name the workspace and say the build is local code. Fix: add a hint with the workspace name or "in a private workspace" like the Chat scratch line. Owner: `McpAssistantStartPage.tsx`.

**M8. No next step after a successful assistant run.**
- Shots 20, 36. After Approve the MCP and Skill assistants just say "The MCP servers are set up." / "The skill is set up." with no link to Connectors or the Skill library, and the run stays Idle until the user ends it. First-time users have no idea where the result went (I had to go to App settings > Skill library myself, shot 29).
- Fix: a quiet "View in Skill library" / "Open Connectors" link in the idle line when a proposal was applied. Owner: `LiveRunView.tsx` idle line or the `ProposalCard` applied state.

### Low

**L1. Folder row shows only the folder name.** Two folders called `app` are indistinguishable; the full path is only in a dialog later (shot 11, 13). Use `title` with the path, as History does, or show a shortened path. `ChatStartPage.tsx`.

**L2. The "Allow edits" switch leaves the tab order when disabled (scratch).** Keyboard Shift+Tab from the composer goes Attach images, Team, Browse and skips the switch, so there is no focusable cue that edits exist (same pattern as the old F7 note). Hint text next to it ("Choose a folder to allow edits.") is run into its label with no separator in the DOM text. Use `aria-disabled` plus `aria-describedby`. `ChatStartPage.tsx`.

**L3. "Team" disclosure wording.** "One assistant / Use the app's default team": "the app's default team" is not defined for a user without a project; it sounds like their projects' org chart. Suggest "A team of agents (orchestrator, implementer, reviewer)". `ChatStartPage.tsx`.

**L4. "Stopped" for a chat the user ended.** The sidebar subtitle reads "Last run 1 min ago · Stopped" and the node says "Stopped", right after the user clicked End session. For chats "Ended" reads better; status words are shared (`lib/runStatus.ts`) so this is a design call.

**L5. Chat History filter chips "All / Run / Setup".** Meaningless for a Chat (shot 09). Hide the kind filter for the virtual projects. `HistoryView.tsx`.

**L6. First-launch focus.** On first launch the cursor sits in the project Name field (shot 01, 40), so the keyboard path leads into the project form and the Chat card comes later in tab order. Acceptable; if "chat first" is the goal, focus the page heading or leave nothing focused.

**L7. Brand lockup "(" next to the MOCK badge** at 1600 is still there (old F7). Not part of this feature. `components/layout/BrandLockup`.

**L8. MCP wording.** The start page title "Set up MCP servers with the assistant" uses "MCP" and "servers" while Connectors and the Catalog use "services" and "connections". A first-time user may not know the acronym. Suggest "Connect tools and services" in the page title, keep "MCP" in the row label.

## Rail at 1024 (scenario 6)

Shots 03, 33, 34. Assistants sit in their own group between two separators with the three icons (message, plug, sparkles) and status pips (grey idle, orange needs you, green open). Tooltips and accessible names are good ("MCP assistant, 1 decision", Chat's title includes "New chat (Ctrl+Shift+N)"). The run list under an assistant is not shown in the rail, so a user in the rail cannot jump to a specific open assistant run, only to the row's default run; that matches projects. No findings; the rail works.

Keyboard in the rail: Tab order is Projects, Needs you, Chat, MCP assistant, Skill assistant, projects, account, settings (full sidebar showed the same plus a "Hide open runs of X" toggle per assistant).

## Keyboard passes

1. Chat start page (1024x640, dark, shots 37 in the earlier run and 38): Ctrl+Shift+N opens the page and focuses the composer. Shift+Tab reaches Attach images, Team, Browse, the "New run" tab, then the run tabs and Live. With a folder: Browse, Clear, Open repo-typo (the existing-project note), Team (Enter opens the radios), Allow edits switch (role=switch, Space toggles), Attach images, composer. The order is logical and nothing traps. Gap: the disabled edits switch is skipped (L2); the disabled Start is skipped until text exists (fine).
2. Answering the skills proposal (shot 26): the card does not take focus when it arrives; from the Live tab it is 12 Tabs to Approve (Live, run tab, New run, Interrupt, End, three zooms, legend, node, Show instructions, Approve). Enter on Approve works and focus moves to the reply composer, which is right. From the sidebar's "Needs you" popover the card is one click away. A "Needs you" arrival should move focus to the card or at least announce it; the tray is not a landmark in the tab order before the canvas controls. Medium-low, applies to all decision cards, not only Assistants.

## Judgement against the earlier recommendation

- Entry point discoverability: resolved. Chat now (first launch), New chat (Projects header), sidebar group, Ctrl+Shift+N.
- Minimum inputs: resolved for scratch (1 line). A folder needs 2 more clicks, plus the picker.
- Trust line before Start: good. "Works in a private scratch area. Reads files, asks before editing. Runs on Everyday tier via Claude." Missing: that web/Bash calls ask too (the edits-on line does say "asks before each edit and command").
- Where a finished one-off lives: Chat > History, Folder column ("Scratch" or folder name), Kind chip "Chat" (shot 09). Good. The History Folder column at 1024 fits (no squeeze); I did not test long folder names.
- Save as project: works ('created': project selected, run moved, Live tab). 'existing' was not reachable (the dialog used the "Quick run not found" path instead, H3). Scratch is disabled correctly but looks enabled (M2).
- Idle copy: see M3.
- Open items the UI Lead listed: "New run" tab confirmed (M4); composer below the fold at 1024x640 confirmed, mild (M6); History Folder column fine at 1024.

## F1 to F7 status

| ID | Then | Now |
| --- | --- | --- |
| F1 no path to a one-off run | Critical | Resolved |
| F2 heavy defaults, no access line | High | Resolved for Chat (one assistant, read-only default, summary line). "unattended" meta remains on the other two (M4) |
| F3 MCP assistant hidden, wrong presentation (second window, "Back to MCP library") | High | Mostly resolved: in-window, sidebar row, no extra window. Still: Configure with AI lands on the last run (H2), "Replying to the orchestrator", "unattended", Done. (M3, M4) |
| F4 no "no folder" / file choice | High | Resolved for no-folder (scratch default) and a folder; single-file grant not offered; path not typeable (M1) |
| F5 a one-off has nowhere to live | Medium | Resolved: sidebar row with "Last run ... · Stopped", History with Folder and Kind chip |
| F6 no Save as project | Medium | Resolved on the success path; stale button and error after the move (H3); scratch cannot be saved (by design, M2 styling) |
| F7 wording | Medium | Partly: kind chip reads "Chat" (fixed), Needs-you says "MCP assistant · R1: ..." not "Project" (fixed, shot 19), the "(" lockup and "unattended" remain |

## What improved

- Needs-you wording: popover, bell and badge name the location with the assistant label ("Proposal: Mock MCP servers / MCP assistant · R1: ..."), and the sidebar count is "1 decision · 1 run" (shot 19).
- The Projects view header and first-launch card are discoverable at 1024 (shot 40) and 1600 (shot 01).
- The skills proposal card is clear: New, Library, name, description, "Approving writes these skills to your library." and project scope "to this project and grants them to the listed roles" (shots 26, 31).
- Project-scope Skill assistant opens in the project's Live tab and shows in that project's sidebar as a run (shot 31).
- Defaults > Assistants shows Skill assistant model and Chat model rows.
- Light theme: start pages, rail and run view are fine (shots 33, 34, 36).

## What I did not test

- The native folder picker (stubbed), the "existing" Save as project outcome, Chat with the "Use the app's default team" option, drag-and-drop of images or a folder, Chat History at 1024 with long folder names, Trends for virtual projects.
- First launch in dark at 1024 (light was checked at 1024; dark at 1600), light theme for the History and Save as project dialog.
- The MCP "build" mode run beyond the proposal card (the mock shows the same script with the switch on; no workspace line appears, M7).
- macOS accelerators and rail tooltips on hover (read from `title`).
- Any real adapter behaviour: M5 is from the mock transcript and the continuation design, not from a live run.

## Shot index

01 first launch 1600 dark; 02 Chat start 1600 dark; 03 Chat start 1024 dark (composer clipped); 05 chat idle 1024 (answer hidden, H1); 06 panel opened; 08 ended chat, Save as project (disabled look); 09 Chat History 1024; 11 folder + edits on; 13 Save as project dialog; 14 after save (stale button); 16 second Save click, error; 17 MCP start page; 18 MCP proposal (run); 19 Needs-you popover; 21 Connectors > Configure with AI; 22 landing on old run (H2); 26 skill proposal; 29 Skill library; 31 project-scope skill assistant entry (Team > Catalog); 33 Chat start 1024 light; 34 rail with MCP proposal 1024 light; 36 Skill assistant 1600 light; 38 Team disclosure open, keyboard; 40 first launch 1024 light.
