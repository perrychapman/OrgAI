# Quick runs (ad-hoc runs outside of projects): plan

Status: contract designed, NO code written. Input: `ux-review-adhoc-runs.md` (findings 1 to 7). Name chosen from its ranking: **Quick run** (button), **Quick runs** (sidebar row and page). Internal name: ad-hoc run.

## Decisions from the UX walk
- Entry: a "Quick run" row at the top of the sidebar project list (icon in the 56 px rail), the same button beside "New project" on the Projects view, Ctrl+Shift+N as accelerator only; the first-launch empty state offers "Start with a project" and "Run a task now" side by side.
- Inputs (same layout as `NewRunPage`: `EmptyState` + `Composer`): the prompt; "Work in a folder" (default "No folder (a scratch area)"); image attachments as today; team "One assistant" (default) with a disclosure for "Use the app's default team"; "Allow edits in this folder" switch, off by default; one muted line before Start: where it works (scratch or folder), what it may do, "Runs on <model> via <connection>. Change in App settings > Defaults.", usage note. No name, brief or Architect.
- Presentation: a "Quick runs" pseudo-project in the main window with Live and History only (reuse `LiveRunView`, `RunTabs`, `SidePanel`, `RunHistory`, decision cards, the bell); `window:openRun` stays as an optional "Open in a window". Idle copy "Done. Ask a follow-up or end the session." Needs-you location reads "Quick run", never "Project". History kind chips get plain words.
- Afterwards: Quick runs History with a Folder / "Scratch" column and the projects' "Last run · status" subtitle.
- Save as project: secondary button on the run strip and a History row action; `ConfirmDialog` with a proposed name and the folder; creates a project with the default chart, moves the run chain into it, lands on Live; if the folder is already a project it offers "Open <name>". A scratch run cannot be promoted.
- Trust: never permission mode `auto`; read-only by default (Edit, Write, Bash, NotebookEdit removed), worktree isolation kept for a git folder with edits on; no project MCP servers, plugins or skills; scratch dir under the data dir, never Home or Downloads; the folder's own `.claude/settings*.json` must not pre-approve anything or run hooks (see the adapter gap).

## Contract (Runtime Lead, settled, to be written into `src/shared/types.ts` in a "Quick runs" section)
- `QUICK_PROJECT_ID = 'quick'` (second virtual project id beside `HARNESS_PROJECT_ID`; never stored or listed; `projects:get` returns a display project "Quick runs" with no roles; `projects:save` / `remove` refuse it).
- `QuickRunTeam = 'single' | 'default'`, `QUICK_RUN_TEAMS`; `QUICK_RUN_MAX_PROMPT_CHARS = 100_000` (longer is refused, not cut).
- `QuickRunInput { prompt; folder?; team?; allowEdits?; images?: ImageAttachment[] }`.
- `QuickRunInfo { folder: string (always the real working dir, scratch included); scratch?: true; team; allowEdits; gitRepo }` as `RunSummary.quick`; `kind` stays `'work'` (titles, nudges, usage, pricing and continuation unchanged).
- `QuickRunPromoteInput { runId; name }`; `QuickRunPromoteResult = { kind: 'created'; project; run } | { kind: 'existing'; projectId; name }`.
- `RunEvent { type: 'run.moved'; runId; fromProjectId; projectId }`, one per moved run.
- IPC `runs:startQuick`, `runs:promoteQuick`; preload `window.orgai.runs.startQuick(input)`, `runs.promoteQuick(input)`.
- `src/shared/defaults.ts`: `quickRoleTools(tools, allowEdits)` (edits off removes Edit, Write, Bash, NotebookEdit); `quickRunTools(team, allowEdits)` ('single': Read, Glob, Grep, WebSearch, WebFetch, plus Edit, Write, Bash with edits on; 'default': the default chart's tools filtered); `quickRunPermissionMode(allowEdits)` = `'default'` in both cases (never `auto`, `acceptEdits` or `dontAsk`: a read outside the folder raises a card instead of a silent denial).

## Runtime design (settled)
- Scratch dir `<data>/quick/<scratchId>` with its own `newId('quick')` (not the run id: `RunManager.start` makes the run id and continuations reuse the dir), mode 0o700; removed only when no run record points to it (guard recomputes `<data>/quick/<basename>`); a boot sweep removes unreferenced scratch dirs.
- `src/main/quick/quickRuns.ts`: folder validation (realpath, directory, not a file, not the data dir or its children, no UNC/device paths), `quickProject(settings, info)` from `newProject(settings)` with the roles swapped in, `isolateWriters = allowEdits && gitRepo`, empty MCP/plugins/skills, run messaging off, then `ConnectionService.prepareNewProject` (mock provider under ORGAI_MOCK=1); `QuickRunService` start / projectFor / promote.
- RunStore: `onRunsRemoved` hook (prune and removeProject) and `moveToProject(runIds, projectId)`. `knownProjects` in `index.ts` must include `QUICK_PROJECT_ID` or boot housekeeping deletes every quick run.
- RunManager: `StartInput.quick`; start accepts `QUICK_PROJECT_ID` only for a `'work'` run with `quick` set; continuations carry `from.quick`; option `quickProject(summary)` rebuilds the project for resumeNow / continue (`runs:continue` in ipc.ts uses it); `allowedRules` uses the run's grants only (never `listRules(folder)`); `decideRules` turns a "project" scope into "run" for quick runs so grants never land in the user's folder; `CapabilityService.runEnded` skips the quick id; `windowScope.checkRunTarget` accepts the id.
- Promote moves the whole session chain (`sessionChain`), refuses while any run of the chain is live, refuses scratch runs, and creates the project like `projects:create` (`prepareNewProject`, default chart).

## Adapter gap (Adapter Engineer, security)
`claude.ts` uses `settingSources: ['project']` and builds `allowedTools` from `listRules(project.path)`: a quick run in an untrusted folder would load that folder's `.claude/settings.json` (hooks can run shell commands) and its allow rules. For `ctx.run.quick`: `settingSources: []`, no saved-rules `allowedTools`, no project-scope "always allow" suggestions (cost: the folder's CLAUDE.md is not loaded). Codex: a role without write tools already gets a read-only sandbox.

## Order of work
1. Runtime Lead: contract (types, defaults with tests, ipc names, preload), commit. 2. Adapter Engineer: the claude.ts quick-run change (+ mock parity). 3. Runtime Lead: quickRuns.ts, RunStore, RunManager, index.ts, windowScope, ipc handlers (field-by-field rebuild), tests; ARCHITECTURE.md / CLAUDE.md. 4. Reviewer security pass (IPC, preload, permissions, cwd). 5. UI Lead: entry points, Quick runs view, form line, Save as project, Needs-you wording, `e2e/quick.mjs` in e2e:free; CLAUDE.md renderer bullets and the dev-build note (`0.1.5-devN` until the 0.1.5 release). 6. UX re-walk at 1024x640 and 1600x1000, both themes. 7. QA gate.
