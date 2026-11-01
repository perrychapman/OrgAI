# Assistants (renderer): spec and notes

Status: spec for the renderer side of the "Assistants" feature. Inputs: `ux-review-adhoc-runs.md` (F1 to F7 and its
Recommendation), `quick-runs.md` (decisions), the contract in `src/shared/types.ts` ("Assistants" sections, merged at
977f2eb). The decisions below are settled; this file records how the renderer realises them, the store API, the test
ids and the open items. The orchestrator folds the "Notes for CLAUDE.md / ARCHITECTURE.md" section into those files.

## What the user sees

Three ad-hoc sessions, each a virtual project shown in the main window like a project:

| Virtual id | Label (`VIRTUAL_PROJECT_LABELS`) | Rail icon (lucide) | Start call |
| --- | --- | --- | --- |
| `quick` | Chat | `MessageSquare` | `runs.startQuick(QuickRunInput)` |
| `harness` | MCP assistant | `Plug` | `mcp.startAssist({ scope: 'library', instruction, allowBuild })` |
| `skills` | Skill assistant | `Sparkles` | `skills.startAssist({ scope: 'library', instruction })` |

### Sidebar
- A group labelled "Assistants" sits between the nav (Projects, Needs you) and the "Projects" label. Order: Chat, MCP
  assistant, Skill assistant. Each row is built like a project row: chevron (only with open runs), status dot, name,
  "Last run · status" / "N decisions · N runs" subtitle when active (`projectStatus`), an attention `Badge` with the
  decision count, and the open-runs list under it when expanded.
- In the 56 px rail each row is its icon (with the status dot as a pip) and a tooltip / accessible name
  ("Chat, 2 decisions"). The Chat row's tooltip adds the accelerator ("New chat (Ctrl+Shift+N)" / "⌘⇧N" on macOS).
- Selecting a row selects that virtual project id and the Live tab (like `openProject`: the run that needs the user,
  else the last viewed one, else the newest open one, else the start page).
- Ctrl/Cmd+Shift+N opens Chat on its start page (accelerator only; ignored while focus is in a contenteditable).

### Projects view
- Header: "New project" (primary) and a secondary "New chat" button beside it (`projects-new-chat`).
- First launch (no projects): two cards side by side, "Start with a project" (the existing form, its primary submit)
  and "Chat now" (one sentence, a primary "Chat now" button, `empty-chat-now`, that opens the Chat start page). Each card
  is its own region, so each has one primary. Under 720 px container width they stack.

### Topbar for a virtual project
- `h1` is the label, no folder chip, tabs Live and History only, no Team / Settings tab, no "Back to MCP library".
- Window title: `<label> · R1: <run> · OrgAI`, else `<label> · OrgAI`.

### Start pages (Live tab, no selected run; same layout as `NewRunPage`: `EmptyState` then the form)
One primary action (Start) per page. Each page root is `[data-testid=assistant-start-<id>]`.

Chat (`assistant-start-quick`):
- EmptyState "Chat with an assistant" / "Ask a question or hand over a task. Nothing becomes a project unless you save it."
- The `Composer` (placeholder "Describe the task", primary "Start", image attachments as today). Submit calls
  `startQuick` and opens the run.
- "Work in a folder" row (`chat-folder`): the folder name or "No folder (a scratch area)", Browse
  (`projects.pickDirectory`) and, with a folder, Clear. A chosen folder that is already a project
  (`projects.checkPath` → `existingProjectId/Name`) shows "This folder is the project <name>." with a secondary
  "Open <name>" (`chat-open-project`); Start stays available (a chat may still run there).
- Disclosure "Team" (`chat-team`, a native `details`/`summary`): radio "One assistant" (default) / "Use the app's default
  team" (`QuickRunTeam`).
- Switch "Allow edits in this folder" (`chat-allow-edits`), off by default, disabled for scratch with the hint "Choose a
  folder to allow edits."
- One muted line before the composer's submit row (`chat-summary`): where ("Works in a private scratch area" / "Works in
  <folder>"), what ("Reads files, asks before editing" / "Reads and edits files, asks before each edit and command"),
  "Runs on <model> via <connection>. Change in App settings > Defaults." (`useAssistantModelName('quickRunModel')`),
  "Counts toward your usage" ("Mock run, no tokens" in mock mode).

MCP assistant (`assistant-start-harness`):
- EmptyState "Set up MCP servers with the assistant" / one line on what it does (library scope).
- Textarea `assistant-instruction`, label "What should agents be able to do?" (McpAssistDialog copy).
- Switch "Let it build a server here (asks before every command and edit)" (`mcp-allow-build`).
- Model hint (`mcpAssistModel`), primary Start (`assistant-start`). The run opens in place.

Skill assistant (`assistant-start-skills`):
- EmptyState "Improve your skills with the assistant" / one line (library scope; project sessions start from the
  project's Skills section).
- Textarea `assistant-instruction`, label "What should your agents get better at?", model hint (`skillAssistModel`),
  primary Start (`assistant-start`).

Elsewhere:
- App settings > Connectors > Custom servers: "Configure with AI" selects the MCP assistant row and shows its start
  page with the instruction prefilled (no window, no dialog run). Project-scope MCP assistant (McpSection) unchanged.
- Team > Catalog > Skills (`SkillsSection`): secondary "Ask the Skill assistant" (`skill-ask-assistant`) starts a
  'skill-assist' run with scope 'project' on that project and opens it in that project's Live tab.

### Run views
- `LiveRunView`, `RunTabs`, `SidePanel`, decision cards and the bell are reused unchanged.
- For a virtual project run: the composer while idle says "Done. Ask a follow-up or end the session." (mode label);
  on an ended run there is no "New run" choice: Continue when the chain can continue, else the composer is replaced by
  a line and a "New session" button (Chat: "New chat") that opens the start page.
- Org retrospective is not offered for quick runs or assistant runs.
- `RunMeta` of a quick run: the folder name or "Scratch", and "edits allowed" / "read-only".
- Needs-you items (sidebar popover, bell, notifications, topbar) name the location with the virtual label, never
  "Project" (`lib/assistants.ts` `locationLabel`).

### History
- Kind chips use `RUN_KIND_LABELS` (never the raw kind); a quick run's chip reads "Chat".
- Chat History adds a Folder column (`history-folder`): the folder name (full path in the title) or "Scratch".
- Chat History row action "Save as project" (same dialog as below; disabled for scratch).

### Save as project
- `RunActions` of a quick run: secondary "Save as project" (`run-save-as-project`); for a scratch run it is disabled
  with the tooltip "A scratch chat cannot become a project" (native button, `aria-disabled`, stays focusable). It shows
  for ended runs only; the main process refuses a live chain and the dialog shows any refusal inline.
- `ConfirmDialog` (`save-as-project-dialog`): an editable name (proposed by `promoteName`: the folder name, else the run
  title, else "Chat"), the folder path read-only, confirm "Save as project". `{ kind: 'created' }` selects the new
  project and opens the moved run on its Live tab; `{ kind: 'existing' }` swaps the body to "This folder is already the
  project <name>." with "Open <name>".
- The store handles `run.moved` (moves the run between `runs` / `historyByProject` / `activeRunByProject`).

### Skills proposal card
- `ProposalCard` kind 'skills': per item the action ("New" / "Update"), scope ("Library" / "This project"), name,
  description, roles (project scope), a "Show instructions" disclosure with the body through `Markdown`; then the
  rationale; Approve / Revise like the MCP card. Helper: "Approving writes these skills to your library" or "...to this
  project and grants them to the listed roles."

### App settings > Defaults > Assistants
- Rows "Skill assistant model" (`skill-assist-model-row`) and "Chat model" (`quick-run-model-row`) beside the existing
  Architect and MCP assistant rows. `lib/assistantModels.ts` `AssistantKey` gains `skillAssistModel` and
  `quickRunModel` (fallback display 'deep' / 'everyday' when the saved settings lack the key).

## Store API (renderer)

- `virtualProjects: Partial<Record<VirtualProjectId, Project>>` replaces `harnessProject`. Loaded with
  `projects.get(id)` on first selection; when that returns null (an older main process) a display project is
  synthesised (`lib/assistants.ts` `displayProject(id)`: `newProject` with the label, empty path and no roles).
- `selectedProject` resolves virtual ids from that map.
- `openAssistant(id, opts?: { instruction?: string })`: loads the virtual project, selects it, `view: 'run'`, opens the
  default run or the start page; `opts.instruction` seeds the start page (`assistantSeed`).
- `startQuick(input)`, `startSkillAssist(input)`, `startLibraryAssist(instruction, allowBuild)`: start and show the run
  in its project (library scopes select the virtual project).
- `promoteQuick(runId, name): Promise<QuickRunPromoteResult>`: on 'created' adds the project, selects it and opens the
  run on Live.
- `handleEvent` 'run.moved'. `loadAllHistory` also loads the three virtual ids. `focusRun` / `jumpToDecision` accept any
  virtual id. `startRun` is never called for a virtual project.

## Test ids

`nav-assistant[data-id=quick|harness|skills]`, `assistant-start-<id>`, `assistant-instruction`, `assistant-start`,
`chat-folder`, `chat-folder-browse`, `chat-open-project`, `chat-team`, `chat-allow-edits`, `chat-summary`,
`mcp-allow-build`, `projects-new-chat`, `empty-chat-now`, `run-save-as-project`, `save-as-project-dialog`,
`history-folder`, `history-save-as-project`, `skill-ask-assistant`, `skill-assist-model-row`, `quick-run-model-row`,
`proposal-skill-item`.

## Notes for CLAUDE.md / ARCHITECTURE.md

- Assistants (renderer): the sidebar "Assistants" group (`nav-assistant[data-id=quick|harness|skills]`, Chat /
  MCP assistant / Skill assistant, rail icons MessageSquare / Plug / Sparkles, Chat tooltip names Ctrl+Shift+N) sits
  above Projects; project and assistant rows share one renderer in `Sidebar.tsx`. Each is a virtual project:
  `useAppStore.virtualProjects` (replaces `harnessProject`; `loadVirtualProject` uses `projects.get(id)` and falls back to
  `lib/assistants.ts` `displayProject`), `openAssistant(id, { instruction })` (+ `assistantSeed`), the exported
  `openNewChat()` (Ctrl/Cmd+Shift+N in App.tsx, Projects header `projects-new-chat`, first-launch `empty-chat-now`),
  `startQuick`, `startSkillAssist`, `startLibraryAssist(instruction, allowBuild)` (shows the run in place, no window),
  `promoteQuick`, `run.moved` handling, `loadAllHistory` covers the virtual ids, `startRun` is a no-op for them.
  Topbar for a virtual id: label, Live + History only, no folder chip ("Back to MCP library" removed). Start pages in
  `components/assistants/` (`ChatStartPage`, `McpAssistantStartPage`, `SkillAssistantStartPage` on the shared
  `InstructionStartPage`, `AssistantModelLine`), testids `assistant-start-<id>`, `assistant-instruction`,
  `assistant-start`, `chat-folder`, `chat-folder-browse`, `chat-folder-clear`, `chat-existing-project`,
  `chat-open-project`, `chat-team`, `chat-allow-edits`, `chat-summary`, `mcp-allow-build`, `assistant-model-line`.
  An ended virtual run has no "New run" choice (Continue, else `assistant-ended` + `assistant-new-session`); idle mode
  label "Done. Ask a follow-up or end the session." (`ASSISTANT_IDLE_LABEL`). Needs-you locations use `locationLabel`.
- Save as project: `components/assistants/SaveAsProjectDialog.tsx` (`save-as-project-dialog`,
  `save-as-project-confirm`), `run-save-as-project` in RunActions, `history-save-as-project` + `history-folder` in Chat
  History. Org retrospective only for real projects' work runs (`offersRetro`). RunMeta of a quick run: folder or
  "Scratch", "edits allowed" / "read-only", never "unattended". Kind chips through `runKindLabel` (`RUN_KIND_LABELS`,
  quick = "Chat").
- ProposalCard kind 'skills': `proposal-skill-item[data-skill]`, "Show instructions" through Markdown, helper
  `skillsApplyNote`. App settings > Defaults > Assistants adds `skill-assist-model-row` / `quick-run-model-row` (select
  testids `<row>-select`); `lib/assistantModels.ts` keys `skillAssistModel` / `quickRunModel` with
  `ASSISTANT_MODEL_FALLBACK`.
- Entry points elsewhere: Connectors > Custom servers "Configure with AI" selects the MCP assistant row
  (`openAssistant('harness')`; `mcp-library-assist-banner` links to it while a run is live); Team > Catalog > Skills
  `skill-ask-assistant` starts a project-scope Skill assistant run on that project's Live tab.
- e2e: `e2e/assistants.mjs` (in e2e:free) at 1024x640 and 1600x1000, dark and light; its run-starting checks skip with
  "SKIP (runtime not merged)" while `runs:startQuick` has no handler.

## Changes after the UX walk (`ux-review-assistants.md`, walked 34f6370)

These supersede the earlier text above where they differ (idle label, "+" tab, Save as project, `openAssistant`).

- H1 conversation layout: `lib/assistants.ts` `isSingleAgentRun` (a Chat with team 'single', 'mcp-assist',
  'skill-assist') and `runLayoutFor(summary, chosen?)` decide the Live view layout; the user's choice per run is
  `useAppStore.runLayoutByRun` / `setRunLayout`. In 'conversation' the stage (`run-conversation`) is the root agent's
  transcript (`TranscriptPanel variant="conversation"`, `conversation-transcript`), newest at the bottom, stuck to the
  bottom unless the user scrolled up (then `conversation-jump` "Jump to latest", in flow under the list). The column and
  the composer are centred at 90ch and the composer stays under the stage even with a wide side panel
  (`.run-body[data-layout=conversation]` overrides `[data-side-wide]`). The decision tray is unchanged. A toolbar
  `IconButton` `run-layout-toggle` ("Show agents" / "Show conversation") is on every run; zoom, legend and Hide finished
  are hidden in conversation mode. `.run-body[data-layout]` carries the current layout. The side panel is unchanged.
- H2: `openAssistant(id, { instruction?, fresh? })`: an instruction or `fresh` (Configure with AI `mcp-library-assist`,
  `openNewChat`) shows the start page; a plain sidebar click opens the run that needs you, else a live run, else the
  start page, never an ended run (`lib/assistantNav.ts` `assistantRunToOpen`; `settleWorkspace` follows it for virtual
  ids). Ended runs stay in the run tabs and History.
- H3: `run-save-as-project` / `history-save-as-project` show only while `offersSaveAsProject` (the run is still in the
  Chat project). M2: the scratch case is a real disabled `Button` inside `span.run-act-disabled`, which carries the
  reason as its title.
- M1: typed path `chat-folder-input` beside Browse (checkPath, 300 ms debounce, `chat-folder-error`; an invalid path
  counts as scratch and Start re-checks). L2: the scratch edits switch stays focusable (`aria-disabled`,
  `aria-describedby` to a separate hint).
- M3/M4 copy: `assistantModeLabel`: "Waiting for your answer" while a card is open, else idle "Your turn. Reply, ask a
  follow-up, or end the session." (`ASSISTANT_IDLE_LABEL`), else "Reply to the assistant" (`speaksAsAssistant` covers
  virtual projects, single-agent chats and project-scope Skill assistant runs). `composerPlaceholder` drops doubled
  punctuation ("What next? Enter to send..."). RunMeta shows "unattended" only on real projects' work runs, and the MCP
  assistant's `buildWorkspace` folder (`run-meta-workspace`, full path in the title). The "+" tab and the draft tab of
  a virtual project read "New chat" / "New session".
- M6: `.new-run` is a size container; under 560 px of height the hero glyph goes and gaps tighten; Team and the edits
  switch share a row. M7: the build switch reads "Let it build a server in its workspace, in OrgAI's data folder" with
  the ask-first hint below. M8: after approving a skills / MCP proposal RunMeta shows a dismissable pointer
  (`proposalNextByRun`, `lib/proposalNext.ts`): `proposal-next-skills` (Skill library), `proposal-next-connectors`,
  `proposal-next-project-skills`, `proposal-next-project-mcp`.
- L5: History kind chips are hidden for the three virtual projects; `.col-folder` ellipsises and narrows under 900 px.
  `.skill-prop-md` uses the token `--scroll-region-max`.
- e2e/assistants.mjs adds: the conversation layout shows the mock reply and the composer at 1024x640 without page
  scroll (both themes), the toggle both ways, the start page after an ended Chat and after Configure with AI, the
  typed-path promote flow with Save as project gone afterwards, the "+" tab label, no "unattended", the disabled look.

New test ids: `run-conversation`, `conversation-transcript`, `conversation-jump`, `run-layout-toggle`,
`chat-folder-input`, `chat-folder-error`, `run-meta-workspace`, `proposal-next-skills`, `proposal-next-connectors`,
`proposal-next-project-skills`, `proposal-next-project-mcp`.

## Open items

- M5 (runtime): chats still get the plan nudge ("Continuing: asked the orchestrator to write a plan...", "Mock:
  continuing with the plan."); exempting quick and assistant runs belongs in `continuation.ts` (Runtime Lead).
- In conversation mode the side panel's Transcript tab duplicates the stage (accepted; the panel is collapsed below
  1100 px).
- The MCP start page cannot name the build folder before the run starts (the data-folder wording is shown).
- `proposalNextByRun` entries are cleared only by Dismiss; the pointer is untested at narrow toolbar widths, and the
  connectors and project links are not covered by e2e (the mock gives no MCP proposal on that path).
- The scratch edits switch is a local `button[role=switch]` because `ui/Switch` takes no `aria-disabled`; fold that into
  `Switch` later.
- Not driven: the native folder picker, the Save as project 'existing' outcome, a default-team Chat in conversation
  mode, the project-scope `skill-ask-assistant` run.
- Not addressed: L3 (Team disclosure wording), L4 ("Stopped" vs "Ended"), L6 (first-launch focus), L7 (brand lockup
  "("), L8 (MCP wording in the start page title), decision-card focus on arrival.
