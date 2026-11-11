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
  are hidden in conversation mode. `.run-body[data-layout]` carries the current layout. The side panel stays for work,
  setup, Ask and org change runs; for assistant sessions see "No side panel for assistant sessions" below.
- No side panel for assistant sessions (2026-11-11): a Chat still in the Chat project, an MCP assistant and a Skill
  assistant run (library or project scope; `lib/assistants.ts` `isAssistantSession`, `hasRunSidePanel(summary, layout)`)
  in the conversation layout render no `SidePanel` (no "run panel" landmark, rail or resize handle;
  `.run-body[data-side-panel=none]` is one column). The panel's Transcript tab only repeated the stage. Its other tabs sit
  in one compact `Tabs` strip above the conversation (`components/RunDetailTabs.tsx` `RunStageTabs`,
  `run-stage-tabs`, label "Session details"): "Conversation" (`run-tab-conversation`, the `transcript` value) first,
  then the panel's own tabs by the panel's own rule (`lib/runTabs.ts`: Plan for every work run, so a Chat has it, and
  for other kinds once a plan exists; Usage; Logs; Outputs and Knowledge never apply to these runs). Other tabs replace
  the stage; the conversation stays mounted and hidden so its scroll position survives; the composer, the run settings
  row and the decision tray stay in place. Tab bodies are the side panel's own (`RunTabBody`, `PlanView` moved there from
  TranscriptPanel), with the same `side-tab-*` test ids, so the reveal helpers and navigation targets work. Selection is
  still `sideTabByRun`; a stored tab the run lacks shows Conversation (`resolveRunTab`). Plan buttons, `sideTab`
  navigation targets and the Usage page return set that value and land in the strip. A send from another tab brings
  Conversation back. On the canvas ("Show agents") the panel returns, since a selected agent is read there; when the
  panel or strip disappears under focus, focus goes to the strip now shown. No application menu item addresses the
  run side panel (Toggle sidebar is the left sidebar); "Show conversation" swaps between the two. Checked by
  `lib/assistants.test.ts`, `lib/runTabs.test.ts` and `e2e/assistants.mjs` `checkStageTabs` (Chat at 1600x1000 and
  1024x640 in both themes, the canvas toggle both ways, a default-team Chat, the project and library Skill assistant,
  the MCP assistant; every tab opens, ArrowRight and Home, a send from Usage returns to Conversation).
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

## Implementation notes: Chat asks for permissions (2026-11-07, `ux-review-chat-permissions.md`)

Chat (quick) runs keep their edit and command tools and every such call raises the normal permission card (runtime:
CLAUDE.md "Chat asks"). The renderer follows the walk's "What the ask path should read" (H1, H2, M1, M3, M4).

- Wording lives in `lib/chatPermissions.ts` (pure, unit-tested; the project wording stays in `lib/permissionCopy.ts`).
- Permission card: `scopeLimit(request)` reads `maxScope`. 'session' (Chat, MCP build sessions) shows no "Always allow
  for project" button, no `perm-scope-project` and no settings link; the effect line is `perm-scope-session`
  (`sessionScopeCopy`: "Allow for session: stops asking for edits in this chat's folder until you end this chat." for
  the quick session edit offer, "... stops asking for "npm test" commands until you end this chat." for a rule; a build
  session says "until you end this session") with the rule chips. 'once' keeps the reference-folder card. A Chat card
  has `perm-location[data-kind=chat]` "Runs in <folder name>" (full path in the title, hidden characters shown) or "Runs
  in this chat's scratch area", and with `quickReadOnly` the line `perm-quick-readonly` "This chat started read-only.
  Allowing lets it change <the scratch area | folder>." (commands: "... lets it run this command in ...").
- Install card with `runOnly`: title "Add a server: <name>", `mcp-install-run-only` "For this chat only. It is not added
  to your library.", no scope radios (always 'run'), buttons `mcp-install-approve` "Add for this chat" and
  `mcp-install-deny` "Don't add" (both testids on every install card), resolved "Added for this chat" / "Not added".
- Rules request card (request_permission_rules): on a run with `quick` or `buildWorkspace` it offers Allow for this run
  and Deny only (no "Always allow for project" or its sentence; main keeps a project grant on the run there).
  `PermissionRuleRequest` has no `maxScope` yet, so the renderer reads the run summary.
- Start page: the switch `chat-allow-edits` is the shared `ui/Switch` "Let it make changes", enabled for scratch too
  (hint through aria-describedby: "Changes happen in a private scratch folder. You approve each one." / "Changes happen
  in <folder>. You approve each one."); `chat-asks-line` "It asks before it changes anything." under the description;
  `chat-summary` "Works in a private scratch area. Asks before it changes a file or runs a command." / "Works in <name>.
  Reads freely, asks before it changes a file or runs a command." / with the switch on "... Ready to make changes; asks
  before each edit and command.".
- RunMeta chip `run-meta-access[data-state=asks|edits|session]`: "asks first", "edits allowed", "changes allowed this
  session" (title explains). 'session' comes from store `RunState.sessionChanges`, set when `permission.resolved`
  carries scope 'session' (or 'project') for a write or command tool (`QUICK_WRITE_TOOLS`) on a quick run; live only (a
  continuation is a new session and starts again). The switch to 'session' is announced once through the frame's
  `tray-announce` ("Changes allowed for the rest of this chat."), never on mount.
- Needs-you captions (bell rows, Dashboard `dash-needs-row`): `decisionLocationLabel` reads "Chat, scratch" / "Chat,
  <folder>" for a Chat decision. Save as project shows `save-as-project-permissions-note` "Permissions you gave this
  chat do not carry over.".
- e2e/assistants.mjs (mock, `[mock:chat-edit]` and `[mock:chat-mcp]`): the edit card's Chat location, read-only line,
  session line and no project button; Allow for session reached by Tab and Enter, the chip turning to 'session' and the
  announcement, the "You allowed" harness row, "I wrote notes.md.", the npm test card (Allow once) at 1024x640 dark; Deny
  and "I did not change anything." with no second card at 1600x1000 light; the run-only install card and "The server
  was added for this chat." at 1024x640 light; at all four size/theme pairs an open card is visible with no page scroll.
- Not driven: the card at every size/theme pair (one full flow each), an MCP build session card (maxScope 'session'
  without a working folder), a folder Chat card's location by e2e, the Needs-you Chat captions and the Save as project
  note by eye, screen reader output, macOS and Linux. No UX re-walk yet.

## Live conversation model selection implementation (2026-11-08)

`LiveModelSwitch` sits with the composer in a shared, scrollable grid region for Chat, setup (including Team Design), MCP assistant, Skill assistant and work runs. One-shot recommendations and drafts have no run-backed model switch. The picker lists concrete models on connected connections and applies only to this conversation's root; defaults and other agents stay unchanged. Pending choices are labelled until applied. Ended selections say "Next message" and take effect when the composer sends a continuation.

The compact model button sits immediately by the composer and remains mounted when ending a session changes the composer mode. Its bounded picker opens above the composer, focuses search, groups concrete choices by connection and shows friendly catalog labels with exact IDs as secondary text. Connection/model pairs remain distinct even when IDs or names match. The current model stays identifiable when its connection or catalog entry is unavailable. Search and selection do not change the applied model. Every switch passes its captured run ID as `expectedRunId`; main refuses a newly resolved chain successor instead of silently applying to it. Dismissal/navigation invalidate pending UI work.

One action follows the current state: use the model at idle, interrupt and switch during a reply, or save it for the next message after the session ends. A connection or adapter handoff requires an explicit confirmation before ending the session; retained transcript text is distinguished from provider session memory. Sending remains a separate composer action. Open decisions and active reports block interruption/session termination for switching. Refresh the run before acting, wait for the intended boundary, and call switch once; a timeout or refusal requires an explicit retry. A successful stop followed by failed selection retains the pending choice and explains that the session ended but the model was not saved. The draft is retained throughout. Escape/cancel/apply return focus to the model button; accessible feedback must not add a persistent redundant success row.

Verification (2026-11-10): `lib/liveModelSwitch.test.ts` has 11 tests covering connection-bound identities/search, same-connection adapter handoff, delayed idle, one-shot interruption, reports/decisions, bounded timeout, confirmation cancellation, partial stop/apply recovery, changed state/transcript/successor and dismissed operations. Typecheck and the combined renderer/runtime/dispatcher targeted suite pass (239 tests). The token-free `e2e/model-switch.mjs` passes with normal configuration and a fresh empty `CLAUDE_CONFIG_DIR` across all five run kinds at 1024x640 and 1600x1000 in dark/light: expanded picker bounds, draft/transcript retention, next-reply models, search focus/Escape, native radio arrows, duplicate IDs across connections, empty fresh catalog/stale current ID, native handoff Cancel, injected apply failure after stop, explicit retry without a second stop, trigger focus, staged Send and paused/error recovery. Direct initial-Chat handoff remains stable after teardown; a pending read dismissed/reopened by the user cannot apply or overwrite the new picker's error. Other fixtures route through a connected mock gateway independently of ambient login. The pre-change mock walk observed redundant persistent feedback and Escape failing to close; post-change probes caught and fixed closed-popover CSS, async geometry growth, modal dismissal and switcher unmount during stop. Run settings row (2026-11-10): `LiveModelSwitch` now renders as the first chip ("Model: …" with a chevron) of the live run settings row, in a fixed `live-settings-bar` at the top of the composer region so it stays mounted through composer mode changes; its search, grouped list, loading and retry come from `components/runSettings/ModelPickerList.tsx`, shared with the New run page's model chip. Every `live-model-*` test id and behaviour is unchanged. The footer adds that roles set to inherit follow the lead's model (`live-model-help`). See `docs/agent-notes/renderer.md` "Run settings row". A synthetic 2,400-model catalog opened in 137 ms and searched in 35 ms in the mock app (single local observation, not a performance guarantee). Live providers, screen-reader speech, 320 px reflow and browser zoom remain unverified.

Model-switch walkthrough/review (2026-11-10): Product Designer accepted the interaction plan; pre/post mock UX walkthroughs and interactive accessibility/security source review approved the inspected flows with no remaining Critical/High findings. A clean direct initial-Chat handoff preserved its selection after 500 ms and 1.7 s, restored focus and kept the draft unsent. An earlier diagnostic incorrectly serialized a void stop response and was retired; it did not demonstrate an application overwrite. The trigger shows transient "Changing model…" feedback during an operation without adding a persistent success row. Reduced-motion-on was inspected; OS motion preferences, screen-reader speech, measured contrast and zoom were not verified. Final combined integration/CI remains the orchestrator's gate.

## Model picker rapid-reopen focus correction (2026-11-10)

Final empty-config integration exposed a native popover event-ordering defect. Electron tracing captured Escape closing the empty-catalog picker, followed by Enter reopening it before the queued `toggle` event: Chromium emitted both `beforetoggle` transitions but one coalesced `toggle` with `oldState: open`, `newState: open`. React retained `open=true` and its mounted search input, so mount-based focus and the shared `[open, placed]` focus effect did not run. The same coalescing could omit the close callback that invalidates a pending model operation.

`Popover` now reports each close synchronously through `beforetoggle`, keeps its native listeners stable, and advances an opening revision for placement and focus on each delivered open event. The picker reloads its catalog on each opening, including a coalesced reopen, while preserving deliberate confirmation recovery. Exit presence, native dismissal, motion tokens and styles are unchanged. The e2e regression forces close and native trigger reactivation in one browser task, checks search focus/reset in both themes at both supported sizes with system/reduced motion, and gates an in-flight read to verify both Escape and coalesced dismissal cancel without applying or overwriting the reopened picker. Failure reports retain a bounded native-event/focus trace; the pending-operation assertion waits for actual busy settlement instead of a fixed delay.

Verification on the correction: typecheck, build, 48 focused picker/motion/token unit tests, the strengthened model-switch e2e with normal configuration and a fresh empty `CLAUDE_CONFIG_DIR`, and `e2e/motion.mjs` passed. Reviewer inspected all 22 shared Popover uses across 18 consumers and approved the concrete product/e2e changes with no actionable findings or Critical/High blockers. No provider, adapter, IPC or proxy-setup code changed. Live providers, screen-reader speech, browser zoom and cross-platform behavior remain unverified.

The focused UX follow-up reran the built mock model-switch matrix and reviewed picker screenshots; it was automated verification plus visual inspection, not a complete first-time keyboard walkthrough. The connection legend is partly clipped by the scrolled list in inspected images; this correction does not change list styling. Canvas checked-radio entry/reopen, Usage Projects-to-Kinds light dismissal, and Add Service More-to-custom-dialog focus handoff were not driven locally and were handed to root QA for the final shared-consumer gate.

## Open items

- M5 (runtime): chats still get the plan nudge ("Continuing: asked the orchestrator to write a plan...", "Mock:
  continuing with the plan."); exempting quick and assistant runs belongs in `continuation.ts` (Runtime Lead).
- Assistant sessions without the side panel (2026-11-11, Reviewer M1/M3). Follow-up (2026-11-11), checked as noted:
  Plan shows in the stage strip only once the run has a plan, a Chat included (`showsPlanTab` `stage`; unit test and
  `e2e/assistants.mjs`: no Plan tab on a Chat without a plan). A reply (new assistant text row) or "your turn" landing
  while another tab is open marks Conversation with a still token dot (`Tabs` `dot`/`dotLabel`), names it
  "Conversation, new reply", makes one polite announcement through the frame's existing announcer ("New reply in the
  conversation") and clears on selecting Conversation (unit tests for `countReplies`/`replyArrived`; the e2e sends,
  moves to Usage and asserts the name, the dot and the clear on the mock adapter; the announcement text was not asserted
  and is untested by screen reader). Show thinking is back at the right end of the strip, on Conversation only (state
  held in LiveRunView, off by default, not persisted, as in the panel; e2e asserts presence on Conversation, absence on
  Usage and no overflow at 1024x640 dark and light). Still open: the agent meta line and staffing detail are reachable
  only through "Show agents" (not asked for). A Chat saved as a project and Ask runs keep the panel and its duplicate
  Transcript tab (not assistant sessions). Screen-reader speech, 320 px reflow, zoom and reduced-motion OS setting are
  unverified (the dot has no animation).
- The MCP start page cannot name the build folder before the run starts (the data-folder wording is shown).
- `proposalNextByRun` entries are cleared only by Dismiss; the pointer is untested at narrow toolbar widths, and the
  connectors and project links are not covered by e2e (the mock gives no MCP proposal on that path).
- Not driven: the native folder picker, the Save as project 'existing' outcome, a default-team Chat in conversation
  mode, the project-scope `skill-ask-assistant` run.
- Not addressed: L3 (Team disclosure wording), L4 ("Stopped" vs "Ended"), L6 (first-launch focus), L7 (brand lockup
  "("), L8 (MCP wording in the start page title), decision-card focus on arrival.
