# UX review: Chat and permissions (read-only today, ask path next)

Reviewer: UX Researcher. Build: 6c36046d (worktree build, `npm ci` + `npm run build`). Ran `ORGAI_MOCK=1` with a throwaway data dir, 1024x640 and 1600x1000, dark and light for the start page (all four) and dark plus light for the cards (1024 and 1600), plus one keyboard pass at 1024x640. Compared with: `docs/design/assistants-ui.md`, `ux-review-assistants.md`, `permissions.md`, `ux-review-permissions.md`, ARCHITECTURE "Assistants". Walk script, raw output and shots: `e2e/shots/ux/chat-permissions/` (gitignored; `walk.mjs`, `out.txt`, PNGs named below).

Question: what does the user see today when they ask Chat to change a file or run a command, and what should it read once Chat can ask?

## Verdict: NOT READY for the ask path as the copy stands

Today the UI says three different things about Chat's power. The start-page summary already says "asks before editing" (scratch and folder, edits off), the RunMeta chip says "read-only", and the prompt (read in code, not seen) tells the model it cannot change files or run commands. Once the tools are present, "read-only" will be false the moment a card appears, and the existing card copy has project-scope text that is wrong for a Chat. Fix the copy before the runtime change ships.

Mock limit: the mock Chat script only calls `list_projects` and echoes replies, so no refusal could be seen. To get a card in a Chat I supplied a custom mock script (a Bash `npm test` and an Edit of `notes.md` with `ask: true`); that is a mock artefact, a real read-only Chat cannot raise one today. It did show what a Chat card looks like.

## Findings

### H1. A Chat card offers "Always allow for project" and says it stops asking "in this project"
Shots: `chat-2-after-second-1024-dark.png`, `chat-folder-edits-1600-dark.png`.
Repro: set `ORGAI_MOCK_SCRIPT` to a work script with `{type:'tool',name:'Bash',input:{command:'npm test'},ask:true}`, open Assistants > Chat (no folder), send any text.
Seen: card "Run npm test" with the line "Always allow for project: stops asking for "npm test" commands in this project." and the buttons Allow once / Allow for session / Always allow for project / Deny, plus the chip `Bash(npm test:*)`. A scratch Chat has no project; a Chat on a folder is trust-restricted (main turns project scope into session and saves nothing, per ARCHITECTURE). The button and sentence promise something that does not happen. Misleading, so High.
Fix: on a Chat card hide "Always allow for project" and its line (`permissionOffer` is the existing pure guard, add a Chat case beside the `referenceFolder` case), keep the rule chips only as "Allow for session covers: Bash(npm test:*)".

### H2. The card never says where the command or edit lands, or that this Chat started read-only
Shots: same as H1, plus `card-1024-dark.png` (project run) for comparison.
Seen: the project run card has the glance line "Starts in the project"; the Chat card has no location line at all (scratch: no line; folder with edits: none either). First-time users cannot tell whether `npm test` runs in a scratch dir or in their folder, which is the main safety question for a Chat that began "read-only". The word "read-only" remains in RunMeta (`chat-2-after-second-1024-dark.png`: "Scratch  read-only  1 agent") next to a card that asks to run a command: contradiction on one screen.
Fix: see "What the ask path should read".

### M1. The start-page summary and the switch already contradict "read-only"
Shots: `start-scratch-1024-dark.png`, `start-folder-edits-1024-dark.png`.
Seen: scratch and folder with edits off both read "Reads files, asks before editing." Edits on reads "Reads and edits files, asks before each edit and command." Yet scratch says the switch is for "this folder" and the hint "Choose a folder to allow edits." is the only explanation. Today "asks before editing" is untrue (no edit tools, no ask), so the line is ahead of the product; after the change it is right for the folder case but wrong for the switch, which should become "Allow edits without asking each time" or go away (see below).
Also: with edits off, a user who types "create notes.md" gets either a refusal (today) or a card (after); the page never says which.

### M2. Scratch chat: the switch is disabled with a hint, and Space on it says nothing
Shots: `start-kbd-switch-focus.png`. Keyboard: Tab order folder input > Browse > Team summary > edits switch (described by the hint) > "Change in App settings" > Attach > composer. Reasonable. Space on the aria-disabled switch changes nothing and announces nothing (status regions empty); the hint is read only through `aria-describedby` on focus. Acceptable today; in the ask path the scratch case must not look like "you may not edit" when it can ask, so this control needs new meaning (see recommendation).

### M3. RunMeta chip "read-only" / "edits allowed" is the only mode signal and it is static
Shots: `chat-2-after-second-1024-dark.png` ("read-only"), `chat-folder-edits-1600-dark.png` ("edits allowed", "notes-app"). Seen: it never changes after Allow for session, so after the user allows edits the chip still says "read-only". It sits in a 32 px muted row and is easy to miss.

### M4. Needs-you and sidebar count the Chat decision but the card location is the only place that names Chat
Shot: `chat-folder-edits-1600-dark.png`: sidebar "Chat 2 decisions · 2 runs", the bell "Needs you · 2". Row copy "Run npm test" is fine, but with several Chats the user sees "Run npm test" with no folder or "scratch" in the row. Include "Chat, scratch" or the folder name (the card header already says "Chat R2: ...", the Needs-you row was not driven separately).

### L1. Run and tab titles strip punctuation
Shots: `chat-folder-edits-1600-dark.png`: tab "Create a file notesmd", project run tab "Fix things mockfatigue run". The file name `notes.md` loses its dot, which reads like a typo in exactly the case this feature is about. Title cleaning (`cleanTitle`, read, not changed) should keep dots inside words.

### L2. Chat card heading chip says "Assistant" with initials "AS"
Fine on its own; on a project run it says Orchestrator. No change, noted for parity.

### L3. Layout: no page scroll or clipping
`start-*` shots at 1024x640 and 1600x1000, both themes: scrollWidth/Height equal the window in all four; the composer, summary and switch fit at 1024x640 with the Team row. The typed-folder path truncates in the input (full path in the title); fine.

## Observed copy today (reference)
- Start page: title "Chat with an assistant", description "Ask a question or hand over a task. Nothing becomes a project unless you save it."
- Field "Work in a folder", placeholder "No folder (a scratch area)", switch "Allow edits in this folder", hint (scratch only) "Choose a folder to allow edits."
- Summary: "Works in a private scratch area. Reads files, asks before editing. Runs on Everyday tier (sonnet) via Anthropic. Mock run, no tokens."
- Composer: "Describe the task. ...", after start "Reply to the assistant. ...", with a card open "Waiting for your answer".
- RunMeta: "Scratch  read-only  1 agent  4s  $0.00285" / "notes-app  edits allowed".
- Side tabs on a Chat: Transcript, Plan, Usage, Logs (Usage shows Cost, Tokens, By agent, By role; no mention of permissions).
- Project run card (mock fatigue): "Run npm test", "Starts in the project", rule line and chip, buttons Allow once / Allow for session / Always allow for project / Deny, Ctrl+. focuses Allow once. Second card: "Edit notes.md", "In the project", explicit one-line outcome per button, "Fewer prompts: permission settings".

## What the ask path should read (recommended copy)

Principle: Chat can always ask; the switch only decides how often. Never say "cannot" or "read-only" once tools exist.

1. Start page switch. Rename "Allow edits in this folder" to **"Let it make changes"**, enabled for scratch too. Off (default) = it asks before every edit and command. Keep it simple: if the product keeps the switch only to pre-set the permission mode, label it **"Ask before changes"** (on by default) and drop the scratch disabled state. Hint line under it, scratch: **"Changes happen in a private scratch folder. You approve each one."** Folder: **"Changes happen in <folder name>. You approve each one."**
2. chat-summary line (`chatSummaryLine`): scratch **"Works in a private scratch area. Asks before it changes a file or runs a command."**; folder **"Works in <name>. Reads freely, asks before it changes a file or runs a command."** Keep "Runs on ..." and the usage clause unchanged.
3. RunMeta label: replace "read-only / edits allowed" with **"asks first"** (default) and, after the user chose Allow for session for edits or commands, **"changes allowed this session"**. Title/tooltip: "This chat asks before it changes files or runs commands. You allowed edits for this session." (live label so M3 goes away).
4. Permission card in a Chat that began with edits off: add one glance line above the effect sentence (the same slot as `perm-location`): **"This chat started read-only. Allowing lets it change <scratch area | folder name>."** For a command: **"Runs in <scratch area | folder name>."** Always name the real cwd (scratch vs the typed folder), failing closed to "Working folder unclear" as the project card does.
5. Card buttons for a Chat: **Allow once, Allow for session, Deny.** Remove "Always allow for project" (H1). Effect sentences: Allow once "this call only."; Allow for session "stops asking for `npm test` commands until you end this chat." (not "session" jargon alone); Deny "tells the assistant no; it can try another way." Keep the rule chips.
6. After Allow for session: the chip in RunMeta changes (item 3); the transcript gets one quiet harness row **"You allowed `npm test` for this chat."**; the composer hint stays. A later different command asks again; only the same rule is covered. Do not widen the grant to the whole tool silently. Ending the chat drops the grant; Save as project does not carry it (say so in the Save as project dialog: "Permissions you gave this chat do not carry over.").
7. MCP install card (`request_mcp_install`) from a Chat: title **"Add a server: <name>"**, location line **"For this chat only. It is not added to your library."** (if that is true; if installs persist, say **"Added to your library, available to all projects after you approve"**, and decide before shipping), then the existing pinned version, command/URL, secrets slots and the "may still ask before each tool call" sentence from main. Buttons: **Add for this chat / Don't add**; no project scope. Needs-you row: "Add a server · Chat".
8. First-time orientation: one sentence on the start page under the description, replacing nothing else: **"It asks before it changes anything."** The existing description still stands.

## Not driven
- A real refusal or a real read-only Chat that is asked to change a file: the mock has no such script and the runtime change is in progress; Chat cards only seen through a custom mock script.
- The `request_mcp_install` card from a Chat (no mock path; project-run card seen only for Bash and Edit).
- Light theme for the Chat run view and for the Chat cards (light shots taken of the start page at both sizes and of project cards at both sizes; the Chat run light shot `chat-2-1024-light.png` was captured but I did not inspect it by eye).
- The Needs-you bell popover rows for a Chat decision, History for Chats, Save as project after Allow, screen reader output, native folder Browse, macOS and Linux.
- The prompt text ("You are read-only ...") and the tool lists were read in code only.
