# UX review: OrgAI for engagement work (non-developer consultant)

- Reviewer: UX Researcher (mock-data walkthrough, no code changes). Input for the "engagement" project kind brief.
- Build: 1bf2c1a (worktree HEAD), `npm run build`, version 0.1.6-dev1.
- How it ran: built Electron app driven by playwright-core through `e2e/lib.mjs` `launch()`, `ORGAI_MOCK=1`, a fresh
  temp `ORGAI_DATA_DIR` per script, three walk scripts. A custom `ORGAI_MOCK_SCRIPT` work script read a CSV in an
  exports folder, wrote a memo in the project folder, edited a file in a "OneDrive" share and ran a Python command; the
  setup run used the default mock Architect. Sizes 1600x1000 and 1024x640 (`setContentSize`), dark and light through
  `settings.appearance.theme`, one keyboard-only Tab pass over the New project dialog, the Permissions pane and the
  Save as project dialog at 1024x640. No tokens, no smoke scripts, no network.
- Persona: an independent consultant (any field) who is not a developer. Fixtures, none of them git repositories:
  a deliverables folder `Acme Access Review 2026` (an engagement letter, kickoff notes), a client share
  `OneDrive - Acme Corp\Shared with consultant`, an exports folder `Acme exports`, a library with two custom MCP
  servers (`client-idp-admin` stdio, `crm-export` http) and two runbook skills.
- Compared with: `docs/design/dashboard.md`, `permissions.md`, `assistants-ui.md`, `config-review.md`, the earlier
  walks `ux-review-dashboard-2.md`, `ux-review-permissions.md`, `ux-review-assistants.md`; CLAUDE.md "Renderer".
- Screenshots: `docs/design/ux-review-engagement-shots/NN-what-size-theme.png` (20 files; number 15 was dropped to
  stay at 20, so the list skips it). Walk scripts and raw text dumps (`raw.json`, `raw2.json`, `raw3.json`):
  `e2e/shots/ux/engagement/` (gitignored).
- Labels: "seen" = observed in the app; "read in code" = from source, not observed; "mock-limited" = the mock cannot
  produce the real behaviour, so the finding rests on copy or code.

## Verdict

NOT READY FOR NON-CODE WORK. A consultant can finish every step on mock data, and some parts already fit them well:
the permission card names an allowed folder ("In an allowed folder: C:\...\Acme exports"), Chat with a folder is
read-only by default and says so, Save as project works, and the Dashboard shows cost per project. But three things
would hurt this user on day one: OrgAI writes its own files (`.orgai/ARCHITECTURE.md`, `CLAUDE.md`,
`.claude/settings.local.json`) into the client deliverables folder (H1); there is no way to say "agents may read this
folder but never change it", so an edit to a client's OneDrive file is shown like any other allowed edit (H2); and the
user's own custom MCP servers cannot be found from the Team tab's "Add a service" search (H3). Around those, almost
every screen on the way assumes a code repository: "Existing repository", "Not a git repository yet", "reads the
code", a first approval card for `git status --short`, an architecture proposal with Stack / Modules / Commands, a
default chart of Orchestrator / Implementer / Reviewer / Researcher described in code terms, and Maintenance and
Advanced settings that only speak of branches, worktrees and merges. The engagement kind should fix the three Highs
structurally (H1 and H2 belong in its contract) and swap the copy per kind; the code kind can keep its wording.

## Status of earlier findings touched by this walk

| Item | Status | Evidence |
| --- | --- | --- |
| ux-review-dashboard-2 M4: first launch scrolls at 1024x640 | Open | `div.dashboard` scrollHeight 831 / client 592 at 1024x640 (shot 02); the submit sits below the fold. |
| ux-review-dashboard-2 L3: wordmark squeezed to "( MOCK Dev" | Open | Shots 01, 04, 10, 17 at 1600: the lockup still reads "( MOCK Dev". |
| ux-review-dashboard-2 L2: mock announced many times | Open | First launch: MOCK badge, "Mock adapter" hero badge, mock checkbox, "Runs on the mock adapter (no tokens).", account row "Mock adapter" (shot 01). Mock-only, no effect on real users. |
| ux-review-assistants L6: first-launch focus | Not re-checked | First launch was entered by mouse. |
| Save as project from Chat (assistants-ui) | Works | After End session, "Save as project" appears in the run strip and opens the dialog with the typed folder (shot 21). |

## Findings, ranked

### H1. Setup writes OrgAI files into the client deliverables folder

- Where: setup run, architecture proposal (shot 06) and run settings proposal; Project settings > Permissions >
  Saved permission rules (shot 10); Maintenance (shot 12).
- Flow: New project > Existing repository > deliverables folder > Create and start setup > approve the three proposals.
- What the user sees: the architecture card ends "Approving writes .orgai/ARCHITECTURE.md into the working directory
  and references it from CLAUDE.md."; the settings card "Approving updates the project settings and brief, and saves
  any allowed commands to .claude/settings.local.json."; the rules panel "Saved in .claude/settings.local.json in the
  project folder." After setup the folder held `.orgai/ARCHITECTURE.md` and `CLAUDE.md` next to "Engagement
  letter.txt" (seen, listed on disk after the walk).
- Why it matters for this user: a deliverables folder is often synced or shared with the client (OneDrive, SharePoint,
  a data room). Hidden dot-folders and a file named after a vendor's coding tool appear in the client's view, and the
  user cannot tell what `CLAUDE.md` is or whether deleting it breaks OrgAI. Maintenance then offers "Remove OrgAI files
  from repository", which presumes they wanted them there.
- Likely owner: main `src/main/setup/service.ts` (architecture write and CLAUDE.md reference), the saved-rules store
  (`permissionRules` / the rules file path), `components/ProposalCard.tsx` (`architecture` effect line), contract in
  `src/shared/types.ts` (`Project.kind`).
- Recommendation: for `kind: 'engagement'`, keep the engagement document, saved rules and every OrgAI note in OrgAI's
  data folder and pass them to agents in the prompt; write nothing into the working folder unless the user turns on
  "Keep OrgAI's notes in this folder" (off by default). Card copy: "Approving saves the engagement plan in OrgAI.
  Nothing is written to your folder." Rules panel: "Saved in OrgAI for this project."
- Checkable: after an engagement setup with every proposal approved, the working folder contains only the files the
  user put there (no `.orgai`, `.claude`, `CLAUDE.md`), and the rules panel names no file path.

### H2. A folder agents must only read cannot be marked read-only; an edit to it looks routine

- Where: Project settings > Permissions > "Rules and folders you allowed" > Allowed folders (shots 10, 19); the
  permission card in a work run (shots 13, 14).
- Flow: add the OneDrive share and the exports folder under Allowed folders; start a run whose report edits
  `Access policy v3.txt` in the share.
- What the user sees: the only folder list says "Agents may read and edit files here without asking, under the same
  permission mode as the project folder." The edit card reads "Edit Access policy v3.txt / In an allowed folder:
  C:\...\OneDrive - Acme Corp\Shared with consultant", with the same neutral styling, the same four buttons and an
  "Auto-accept file edits in this project" chip (shot 14). Nothing marks it as client material. The brief the user
  typed ("read them, never change them") is only prompt text.
- Why it matters: changing a client's source file is the one mistake this user cannot afford; under the default
  Unattended mode (M6) the model's safety check may approve such an edit with no card at all (read in code; the mock
  forces a card with `ask: true`, so mock-limited).
- Likely owner: contract `Project.referenceDirectories` (new, `src/shared/types.ts`), enforcement in every adapter's
  edit gate and in `RunManager.resolveAllowedDirectories`, `lib/permissionCopy.ts` (location kind), `PermissionCard.tsx`,
  `components/settings/AllowedDirectoriesSection.tsx`.
- Recommendation: see "Reference folders" below. In short: a separate "Reference folders (read only)" list, writes
  into them refused in main without a card, and the card naming the folder kind on reads.
- Checkable: with the share as a reference folder, a mock Edit / Write / Bash write into it ends as a refusal row in
  the transcript ("Refused: <file> is in a reference folder (read only)") and no permission card; a Read shows no
  card in every mode except "Ask for everything risky".

### H3. The user's own custom servers are not findable from "Add a service"

- Where: Team > Catalog > Connections > "Add a connection" (shot 18), then "Can't find it? More ways" (shot 20).
- Flow: with `client-idp-admin` in the MCP library, open Add a service and type "idp".
- What the user sees: "38 services", a list led by AWS Knowledge, Context7, DeepWiki, Exa and Microsoft Learn
  (developer documentation tools), no "Ready to use" section, and for "idp" the count "No services" (seen,
  `raw3.json`). The library server is reachable only through "Can't find it? More ways > Add from your custom
  servers", three levels deep.
- Why it matters: for this user the custom servers for the client's platforms are the main connections; a search that
  says "No services" reads as "my server is gone". The default list order also signals "this is for developers".
- Likely owner: `components/connectors/AddServiceDialog.tsx`, `components/mcp/McpLinkDialog.tsx`, `lib/connectors.ts`
  (`matchRank`).
- Recommendation: put a "Your servers" section first (library entries not yet in the project, then connected
  connectors), let search match library entries by name and description, and keep vendor services below. Empty search
  copy when nothing matches: "No service or saved server matches "idp". Set up a custom server".
- Checkable: with one library entry, the dialog's first section is "Your servers" listing it; typing a word from its
  name or description shows it with an "Add" action.

### M1. The New project form frames every folder as a code repository

- Where: first launch and the New project dialog (shots 01, 02, 03, 04).
- What the user sees: "Start a project: The Architect sets up a team of agents for an idea or a repository."; the
  type switch "New idea / Existing repository"; the field "Repository folder"; the amber warning "Not a git repository
  yet (that's fine)." on a plain folder; "The Architect scans it and reads the code before proposing anything."; the
  New idea placeholder "...stack, constraints, must-haves"; with agent files present, "Found 1 Claude Code agent and
  CLAUDE.md." and "Import the 1 agent (review first)".
- Why: the user has a folder of documents. Amber means "something is wrong", "git" and "the code" are unknown words,
  and "repository" makes them doubt the product is for them before they start.
- Owner: `components/dashboard/NewProjectForm.tsx`, `FirstLaunch.tsx`, `lib/projectsForm.ts` (`pathStatus`),
  `lib/agentImport.ts` (`foundLine`).
- Recommendation: the kind choice described in "Where the kind choice belongs"; for engagement no git status line at
  all, the folder field labelled "Working folder" with "Where the team saves deliverables. Your files stay where they
  are." Code kind: show the git line as info (not warn) or only when it is a repository.
- Checkable: with the engagement card picked, the form text contains none of "git", "repository", "code", "stack",
  "CLAUDE.md".

### M2. The setup run opens with a git command and proposes a software architecture

- Where: the setup run (shots 05, 06).
- What the user sees: the first decision of their first session is "Run git status --short / Starts in the project /
  Always allow for project: stops asking for "git status" commands" with a `Bash(git status:*)` chip, in a folder that
  is not a repository. Then "Approve architecture proposal" with headings Stack, Modules, Conventions, Commands, Risks
  and gaps, and "Approve org chart proposal" listing removed Orchestrator / Implementer / Reviewer / Researcher.
- Mock-limited: the git call and the TypeScript content are the mock script. But the card headings are fixed by the
  `propose_architecture` contract (read in code, `ProposalCard.tsx`), and the Architect prompt asks about "stack
  preferences" and to "explore the code" (read in code, `src/shared/setup.ts` lines 20-23). The real interview's
  questions were not reachable.
- Owner: `src/shared/setup.ts` (a separate engagement interview prompt), `ProposalCard.tsx` and a new engagement plan
  proposal shape in `src/shared/types.ts`.
- Recommendation: the engagement interview asks only the brief's six questions and proposes an "Engagement plan"
  card with headings taken from the answers: "Client", "Field", "Platforms", "Phase", "Deliverables", "Coding in
  scope". No shell call during setup; the setup role gets Read, Glob, Grep only. Card effect line: "Approving saves
  the plan in OrgAI. Agents read it at the start of every run."
- Checkable: an engagement setup on the mock shows no permission card and no heading named Stack, Modules or Commands.

### M3. The default chart and the role inspector speak code

- Where: Team tab after a project made without the Architect, and the role inspector (shot 09; `raw2.json`).
- What the user sees: roles Orchestrator ("Lead agent. Plans the work, delegates to specialists..."), Implementer
  ("Writes and edits code to complete a precisely scoped task. Use for feature work and bug fixes."), Reviewer
  ("Read-only code reviewer. Use to check a change for bugs, security issues and missed cases."), Researcher
  ("Explores the codebase or the web..."). The inspector shows "Tools: Read, Glob, Grep", "What this role may do on your
  files and shell.", "Slug (subagent type)", "Reports to: Nobody (root orchestrator)", and the hint "No connections yet.
  A connection lets this role reach a service such as GitHub or Slack."
- Owner: `src/shared/defaults.ts` (default chart), `components/RoleInspector.tsx`, `components/team/RoleCapabilities.tsx`.
- Recommendation: the engagement chart from the brief (Engagement Lead, the Specialist the interview names, Analyst,
  Writer, Reviewer, optional Developer), descriptions in plain work terms, e.g. Analyst "Reads the reference material
  and pulls out facts, figures and gaps.", Writer "Drafts deliverables in the working folder.", Reviewer "Checks each
  deliverable against the brief and the sources. Never edits." Inspector labels for every kind: "Tools" list rendered
  as plain capabilities ("Read files, Search files, Edit files, Run commands"), "Slug (subagent type)" moved under
  Advanced as "Internal name", "Nobody (root orchestrator)" -> "Nobody (leads the team)".
- Checkable: an engagement project's Team tab and inspector contain none of "code", "codebase", "Glob", "Grep",
  "shell", "orchestrator", "subagent".

### M4. Maintenance and Advanced settings only talk about git, and say something untrue

- Where: Permissions > Advanced settings (shot 11), Maintenance (shot 12).
- What the user sees: "Isolate writers in worktrees - Off: not a git repository.", "Review each report's changes
  before merge - Needs worktree isolation (above).", "No report branches waiting", "Architecture document", "Remove
  OrgAI files from repository", Learn more "...a short section in CLAUDE.md, plus a .git/info/exclude entry for agent
  worktrees." Meanwhile the stored project has `isolateWriters: true` (seen in `raw.json` after the setup proposal),
  so the row's "Off" is derived, not the saved value.
- Owner: `lib/settingsCopy.ts` (`isolateWriters`, `reviewMerges`, `ISOLATE_WRITERS_STATE`),
  `components/settings/MaintenanceSection.tsx`.
- Recommendation: for engagement (and for any folder without git) hide the isolation and merge rows and the branch
  list; Maintenance shows "Engagement plan: Review with the Architect" and, only if OrgAI ever wrote into the folder,
  "Remove OrgAI's notes from this folder". Do not store `isolateWriters: true` for a folder without git.
- Checkable: an engagement project's Settings contain none of "worktree", "branch", "merge", "repository", ".git".

### M5. Cost per project is close to billable but the numbers disagree and cannot leave the app

- Where: Dashboard Cost card and tile (shot 17), History > Trends (shot 16), run Usage tab (`raw.json` `usagePanel`).
- What the user sees: the Dashboard says the project cost "$0.01673" in the last 7 days; Trends for the same project
  says "Runs 1, Cost $0.01103". The difference is the setup run ($0.0057), which Trends leaves out (seen). Ranges are 7,
  30 or 90 days, not a calendar month; there is no export or copy; the cost note elsewhere says it is "Measured at API
  prices. On a subscription this is a safety cap, not money you are billed."
- Why: a consultant wants "what did Acme cost me in October" to pass on or to price the next engagement; two numbers
  for one question, no month and no export make it a manual job.
- Owner: `components/UsageTrends.tsx`, `runs:usageStats` (main), `components/dashboard/FactsCards.tsx`.
- Recommendation: Trends counts every run of the project (setup and saved chats included, with a kind column), adds
  "This month" and "Last month" ranges, and a "Copy as CSV" button (date, run title, kind, tokens, estimated cost).
  Label every money figure "Estimated cost" with the existing unknown / lower-bound rules. Engagements grouped by client
  get a per-client total (see "Engagement grouping").
- Checkable: for one project, the Dashboard 7-day figure equals Trends "7 days" Cost; "Copy as CSV" puts one row per
  run on the clipboard.

### M6. Unattended is the default mode for client work

- Where: Permissions (shot 10), run strip "unattended" (shots 13, 14), App settings > General > New projects.
- What the user sees: "Permission mode: Unattended - The model's safety check approves routine calls and asks when
  unsure. Fewest prompts." chosen for them; the run strip says "unattended".
- Why: on client material the user is accountable for every change; "the model decides" is the wrong default the
  first time, and the six mode names ("Never ask", "Plan only", "Bypass all prompts") are a lot to judge.
- Owner: `newProject` defaults per kind (main), `lib/settingsCopy.ts` `PERMISSION_MODE_SHORT`.
- Recommendation: engagement projects start on "Ask for everything risky" (with reference folders enforced in every
  mode, H2); show the four everyday modes and put "Never ask" and "Bypass all prompts" under Advanced for engagements.
  Mode sentence for engagements: "Asks before agents change files or run commands. Reading your folders never asks."
- Checkable: a new engagement project's mode select value is `default`.

### M7. Run and team pages explain themselves in agent-framework words

- Where: Live new run page (shot 07), Team assistant tray, Team toolbar (shot 09).
- What the user sees: "Give Lead something to do. Type a task below. The orchestrator plans it and delegates to its
  reports. Every subagent appears here the moment it is created, attached to the agent that spawned it."; "Find tools
  and skills for your team. I look at this repo, your computer and your library first."; buttons "Import agents" and
  "Export to repo".
- Owner: `components/NewRunPage.tsx`, `components/team/TeamAssistantTray.tsx`, `views/TeamView.tsx`.
- Recommendation: "Give Engagement Lead a task. It plans the work and hands parts to the team. Each person on the
  team appears here when they start." (role name from the chart); "I look at this project's folder, your computer and
  your library first."; for engagement hide "Import agents" and "Export to repo" behind the toolbar's More menu.
- Checkable: the strings "orchestrator", "subagent", "spawned", "repo" do not appear on an engagement project's Live
  and Team tabs.

### M8. Saved permission rules are a command grammar with developer examples

- Where: Permissions > Saved permission rules (shots 10, 19).
- What the user sees: input placeholder "Bash(npm test:*)", Examples "Bash(npm test:*)", "Bash(git status)",
  "WebSearch", "mcp__github", and the card chip `Bash(python transform_roles.py:*)` (`raw.json` `workCard4`).
- Why: the user can approve cards (that works), but cannot read or write this list.
- Owner: `components/PermissionRulesPanel.tsx`, `lib/permissionRules.ts` `ruleLabel`.
- Recommendation: list each rule by its `ruleLabel` sentence first and the raw rule second in mono ("Run python
  transform_roles.py ... / Bash(python transform_roles.py:*)"); for engagements move "Add rule" under the pane's
  Advanced disclosure; examples neutral of any toolchain: "WebSearch", "WebFetch", "mcp__<your server>".
- Checkable: every rule row shows a sentence; the examples list names no package manager or git.

### L1. Catalog copy assumes a repository and a vendor tool

- Shot 08: "Write one, add one from the library, or import the skills in your repository."; "Plugins - Claude Code
  plugin folders that bundle skills, tools and commands."; Skills Evaluate "may use up to 20k tokens". Owner:
  `components/skills/SkillsSection.tsx`, `components/mcp/PluginsSection.tsx`. Fix: "...or import skills from this
  project's folder."; for engagements fold Plugins into "Advanced" ("Plugin folders: bundles of skills and tools").
  Checkable: no "repository" or "Claude Code" in an engagement Catalog.

### L2. "without asking" in the Allowed folders hint is contradicted by the cards

- Shots 10, 13: the hint says agents "may read and edit files here without asking, under the same permission mode as
  the project folder", and the next run asks to read a file there (mock forces the card, so partly mock-limited; the
  sentence still contradicts itself). Owner: `AllowedDirectoriesSection.tsx` `ALLOWED_FOLDERS_HINT`. Fix: "Agents may
  read and change files here, with the same permission mode as the working folder." Checkable: the hint does not say
  "without asking".

### L3. Keyboard: the project type is the last stop, and Save as project focuses Close

- New project dialog at 1024x640 (`raw.json` `kbNewProject`): focus opens on Name; Tab goes brief, folder, Browse,
  Architect, mock, Cancel, Close dialog, and only then the "New idea" type radio. Save as project (`raw3.json`
  `kbSaveAs`): focus opens on "Close dialog", then Project name. Focus rings are visible (2 px) on every stop, and the
  Permissions pane order matches the visual order (`raw2.json`). Owner: `NewProjectForm.tsx` (focus target),
  `SaveAsProjectDialog`. Fix: once the kind choice exists, it is the first stop and gets initial focus; Save as project
  focuses Project name. Checkable: `document.activeElement` after open.

### L4. Save as project always makes a "default team" code project

- Shot 21: "Creates a project with the default team and moves this chat and its earlier turns into it." The default
  team is the code chart (M3) and there is no kind choice. Owner: `SaveAsProjectDialog`, `runs:promoteQuick`. Fix:
  two radio cards "Code project / Engagement" in the dialog (engagement selected when the folder holds no git), copy
  "Creates an engagement with the standard team and moves this chat into it. You can run the setup interview later."

### L5. A finished setup run stays open and dominates the Dashboard

- Shot 17: after setup completes the setup run is "Idle", the tile says "1 open", the hero says "1 running" and
  Running now lists "Idle Read this existing project and set it u..." until the user presses End session. Owner:
  setup flow (end the setup session after `complete_setup` once the closing message is shown, or label it "Setup
  done"). Checkable: after setup completes, the hero does not count the setup run as running.

### L6. "Import agents" wording and the list of vendor folders

- Shot 03 and the Import agents dialog (`raw3.json`): "Found 1 Claude Code agent and CLAUDE.md.", "Searched
  .claude/agents, .opencode/agents, opencode.json, .codex/agents, .github/agents, .gemini/agents, .kiro/agents,
  .roomodes and .orgai/org.json in ...". Fine for developers; noise for engagements. Fix: for engagement show the
  import choice only when agent files exist, worded "This folder has 1 saved team member from another tool. Use it?",
  and collapse the searched-folders list behind "Where OrgAI looked".

## Where the kind choice belongs

- Placement: the first thing in the New project form (inline on first launch and in the dialog), above Name, replacing
  today's "New idea / Existing repository" switch. Two radio cards in one fieldset with the legend "What is this
  project for?". It gets initial focus (L3). Arrow keys move between cards. Default: none picked on first launch;
  afterwards the kind of the user's last created project.
- Card copy (no field names, no industry words):
  - "Code project" / "Software in a repository. Agents read and change the code, run tests and work in separate
    copies when several write at once."
  - "Engagement" / "Work for a client or a case: research, analysis and documents. Agents read the material you point
    them to and write deliverables in one working folder."
- Second question, code only: "New idea / Existing code" (today's switch, renamed from "Existing repository").
- Fields shown per kind:

| Field | Code project | Engagement |
| --- | --- | --- |
| Name | "Name" placeholder "My app" | "Name" placeholder "Client or case name" |
| Folder | "Repository folder" / "Folder to create it in"; git line as info | "Working folder", hint "Where the team saves deliverables. Your files stay where they are."; no git line |
| Reference folders | not shown | "Folders the team may read (optional)", a list with Browse; hint "Read only. Agents can never change files here." |
| Brief | "What do you want to build?" | "What is the engagement about? (optional)" placeholder "Who the client is, what you deliver, and anything the team must not touch. The setup interview asks about the rest." |
| Setup | "Set up with the Architect (recommended)" | "Start with the setup interview (recommended)" + "Turn off to start with the standard engagement team." |
| Import agents | radio when agent files are found | only when agent files are found, wording per L6 |
| Submit | "Create and start setup" | "Create and start interview" |

- What the form hides for engagement: git status, "reads the code", "stack", agent-tool names, CLAUDE.md. What it
  must not hide: the connection line and (mock builds) the mock checkbox.
- The kind is shown afterwards in Project settings > General as a read-only line "Kind: Engagement" with "Change"
  behind Advanced (changing it swaps defaults only for new runs and never rewrites the chart without a proposal).

## Reference folders

- Where: Project settings > Permissions, inside the same "Rules and folders you allowed" disclosure, as the first of
  two folder cards, above Allowed folders. The summary line counts both: "2 reference folders, 1 folder you allowed".
  For engagements also in the New project form (above) and in the setup interview's proposal ("Platforms" and
  "Deliverables" answers may name folders).
- Labels:
  - "Reference folders (read only)" / hint "Agents can read files here. They can never change, add or delete
    anything, in any permission mode."
  - "Allowed folders (read and change)" / hint "Agents may read and change files here, with the same permission mode
    as the working folder."
  - Each row shows a small lock icon and the word "Read only" for reference folders, a pencil and "Can change" for
    allowed ones, so the difference survives a screenshot in grey scale. Moving a row between lists is a row action
    ("Make read only" / "Allow changes"), never silent.
  - A folder may be in one list only; adding a reference folder that is already allowed asks "Make it read only?".
  - The working folder can never be a reference folder (error: "This is the working folder. Pick a folder inside it
    or elsewhere.").
- Permission card:
  - Reads inside a reference folder: no card in any mode except "Ask for everything risky"; when shown, the location
    line reads "In a reference folder (read only): C:\...\Shared with consultant" with the lock icon, and the
    "Always allow for project" sentence says "stops asking to read this folder".
  - Writes, edits, deletes, moves or shell commands whose target is in a reference folder: no card; main refuses and
    the transcript gets a quiet system row "Refused: Access policy v3.txt is in a reference folder (read only)." The
    agent is told to write a copy in the working folder instead. The run's Logs tab counts refusals.
  - A shell command that only mentions a reference path (e.g. reads a CSV) is treated as a command card with the
    location "Reads from a reference folder" so the user sees it, never offered "Always allow" for writing there.
- Contract notes for the brief: `Project.referenceDirectories` beside `allowedDirectories`, cleaned by the same rules
  (`allowedDirectoryRisk`, max 20), never overlapping; enforcement in main and every adapter gate before any allow
  rule, like the per-role MCP gate. Codex: not in `writable_roots`. Unverified until built: whether the CLI's own file
  tools can be fenced read-only with the hook alone (needs a smoke check with consent).

## Engagement grouping

Nothing exists yet; this section is a proposal, not an observation.

- Grouping key: the interview's "client" answer, stored as a plain text field on the project (the user's own words,
  never a category list). Projects without it group under "Other".
- Sidebar: under "Projects", engagements group by client with a collapsible header row "Acme Corp (2)"; code projects
  stay in a flat "Code" group below. With fewer than two clients, no headers (a flat list, as today). In the 56 px rail
  the groups become a thin divider only. Header row is a button with `aria-expanded`; its state is remembered.
- Dashboard tiles: an engagement tile shows the client on its first line ("Acme Corp") above the project name, the
  working folder name, the status line and "Estimated $0.02 this month". A "Group by client" toggle above the grid
  (on by default when at least two engagements share a client) groups tiles under client headers with a per-client
  total. The Cost card lists clients instead of projects when grouped.
- Topbar: name, then the client as quiet text ("Acme Corp"), then the folder chip as today. Tabs stay Live, History,
  Team, Settings for both kinds. No kind badge in the topbar; the kind shows in the tile and in Settings > General.
- Needs-you row and project row subtitle unchanged ("1 decision . 2 runs"; seen in shot 13's sidebar), but the
  Needs-you item's location reads "Acme Corp / Access review" for engagements.

## Copy to keep neutral

Strings seen in the app (or read in code where marked) that name code concepts, with the neutral text for engagement
projects. The code kind may keep the left column. "File" is the owner unless stated.

| Current string | Where | Neutral alternative |
| --- | --- | --- |
| "The Architect sets up a team of agents for an idea or a repository." | `FirstLaunch.tsx` | "The Architect sets up a team of agents for your project." |
| "New idea" / "Existing repository" | `NewProjectForm.tsx` | kind cards (above); code sub-switch "New idea" / "Existing code" |
| "Repository folder" | `NewProjectForm.tsx` | "Working folder" |
| "Not a git repository yet (that's fine)." (amber) | `lib/projectsForm.ts` | engagement: no line; code: info tone "No version history (git) in this folder. That is fine." |
| "Choose the repository folder." | `lib/projectsForm.ts` | "Choose the working folder." |
| "The Architect scans it and reads the code before proposing anything." | `NewProjectForm.tsx` | "The Architect looks through the folder before proposing anything. Nothing is changed until you approve." |
| placeholder "...stack, constraints, must-haves..." | `NewProjectForm.tsx` | "...what you deliver, constraints, must-haves..." |
| "Found 1 Claude Code agent and CLAUDE.md." | `lib/agentImport.ts` | "Found 1 saved team member from another tool." (details behind "Where OrgAI looked") |
| "Read this existing project and set it up for OrgAI." (setup prompt and run title) | setup start (read in code: store `startSetup`) | "Set up this project with me." |
| "Approving writes .orgai/ARCHITECTURE.md into the working directory and references it from CLAUDE.md." | `ProposalCard.tsx` | "Approving saves the plan in OrgAI. Nothing is written to your folder." |
| "...saves any allowed commands to .claude/settings.local.json." | `ProposalCard.tsx` | "...saves any allowed actions for this project." |
| "Isolate writers in worktrees" | `ProposalCard.tsx`, `lib/settingsCopy.ts` | hidden for engagement; code: "Give each writer its own copy (git worktrees)" |
| Stack / Modules / Conventions / Commands headings | architecture card | engagement plan: Client / Field / Platforms / Phase / Deliverables / Coding in scope |
| "Give Lead something to do ... The orchestrator plans it and delegates to its reports. Every subagent appears here..." | `NewRunPage.tsx` | "Give <lead role> a task. It plans the work and hands parts to the team. Each team member appears here when they start." |
| "The Architect scans the repository, reads the code, and proposes an architecture document..." | `NewRunPage.tsx` (read in code) | "The Architect looks through the folder and proposes a plan, a team and settings. You approve each one." |
| "If it is not a git repository yet, run git init..." (scaffold prompt) | `NewRunPage.tsx` (read in code) | engagement: not offered |
| Orchestrator / Implementer / Reviewer / Researcher and their code descriptions | `src/shared/defaults.ts` | engagement chart from the brief, descriptions in work terms (M3) |
| "Slug (subagent type)", "Nobody (root orchestrator)" | `RoleInspector.tsx` | "Internal name" (Advanced), "Nobody (leads the team)" |
| "Read, Glob, Grep" / "What this role may do on your files and shell." | `RoleCapabilities.tsx` | "Read files, Search files" / "What this role may do with files and commands." |
| "A connection lets this role reach a service such as GitHub or Slack." | `RoleCapabilities.tsx` | "A connection lets this role reach a service such as your email or a client system." |
| "Import agents", "Export to repo", "Export the org chart to the repository?" | `TeamView.tsx` | "Import team", "Save team to folder", "Save the org chart to the project folder?" |
| "I look at this repo, your computer and your library first." | `TeamAssistantTray.tsx` | "I look at this project's folder, your computer and your library first." |
| "...or import the skills in your repository." / "From the repository" | `SkillsSection.tsx`, `lib/skills.ts` | "...or import skills from this project's folder." / "From the project folder" |
| "Claude Code plugin folders that bundle skills, tools and commands." | `PluginsSection.tsx` | "Plugin folders that bundle skills, tools and commands." |
| "No extra folders. Agents work in the project folder and its worktrees." | `AllowedDirectoriesSection.tsx` | "No extra folders. Agents work in the working folder." |
| "Saved in .claude/settings.local.json in the project folder." | `PermissionRulesPanel.tsx` | engagement: "Saved in OrgAI for this project." |
| Examples "Bash(npm test:*)", "Bash(git status)" | `PermissionRulesPanel.tsx` | "WebSearch", "WebFetch", "mcp__<your server>" |
| "Off: not a git repository." / "Needs worktree isolation (above)." | `lib/settingsCopy.ts` | hidden for engagement |
| "No report branches waiting", "Merge into main checkout", "Discard branch" | `MaintenanceSection.tsx` | hidden for engagement |
| "Remove OrgAI files from repository" / "Deletes the files OrgAI created in this repository." | `MaintenanceSection.tsx` | "Remove OrgAI's notes from this folder" / "Deletes the files OrgAI created in this folder. Your own files stay." |
| "...references it from CLAUDE.md... .git/info/exclude entry for agent worktrees." | `MaintenanceSection.tsx` | engagement: name the files actually present, or hide the row |
| Canvas node badge "isolated worktree", "merge conflict", "merged into parent" | `AgentNode.tsx` (read in code; no worktree on a non-git folder) | engagement never shows them; no change needed if isolation is off |
| "Creates a project with the default team..." | Save as project dialog | "Creates a project with the standard team for its kind..." (L4) |

## Click counts

| Task | Today | With the proposal |
| --- | --- | --- |
| Add a client share agents may only read | Not possible (Allowed folders are read and change); 5 to add it as allowed: Settings, Permissions, Show, type or Browse, Add folder | 0 extra in the New project form; 4 later: Settings, Permissions, Show, Add (Reference folders) |
| Give a role a custom server from the library | 6: Team, Catalog, Add a connection, Can't find it? More ways, Add from your custom servers, pick it (then roles) | 4: Team, Catalog, Add a connection, pick it under "Your servers" |
| See what one client cost this month | Not possible (7/30/90 days; Trends leaves out setup) | 2: History, Trends > This month (or 0 on the Dashboard per client) |
| Start an engagement project | 6-7 with code wording (type switch, folder, name, brief, Architect, Create) | Same count, kind card first, no code words |

## Suggested order of work

1. Contract first (`src/shared/types.ts`): `Project.kind`, `Project.referenceDirectories`, the client field, the
   engagement plan proposal shape; main-side refusal of writes into reference folders (H2) and the no-write rule for
   OrgAI's own files on engagements (H1).
2. H3: "Your servers" first in Add a service and search over library entries (independent of the kind).
3. New project form kind cards and per-kind fields (M1, L3), then the engagement interview and chart (M2, M3).
4. Per-kind settings: hide git rows and Maintenance branches (M4), engagement default mode (M6), rules panel
   sentences (M8).
5. Billing: Trends counts every run, month ranges, Copy as CSV (M5); then client grouping in sidebar and Dashboard.
6. Copy table sweep for the engagement kind (M7, L1, L2, L4, L6); L5 setup-run lifetime.

## Not driven

- The real Architect interview (mock-limited): its questions, whether it runs shell commands in a non-git folder,
  and what it proposes for a document folder. Only the prompt text was read.
- Real file effects of agent edits: mock tool calls do not change files (the OneDrive file was unchanged after an
  "allowed" edit), so whether Unattended would have approved that edit without a card is unverified.
- Native folder pickers (Browse in the form, Allowed folders and Chat); paths were typed.
- OneDrive placeholders, sync conflicts and long Windows paths (beyond the 1,024-char cap) in folder lists.
- Team assistant suggestions after a run (the Team tab showed a "4" badge; contents not opened). The mock recommends
  a `code-review` skill (read in CLAUDE.md), which would be one more code-flavoured default for this user.
- Codex / OpenAI and LiteLLM connections, plan-limit pauses, the MCP and Skill assistants, Skill import from a folder.
- The Usage tab inside a run was opened (cost, tokens, by agent, by role all present) but its shot was dropped to stay
  within 20 screenshots; its text is in `raw.json` `usagePanel`.
- Engagement grouping, reference folders and the kind choice do not exist yet; those sections are proposals.
