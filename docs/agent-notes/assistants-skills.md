# Assistants, skills and self-help

Skills (#11), Team assistant, Chat / MCP / Skill assistants, Chat asks, self-knowledge and self-help. Moved out of CLAUDE.md on 2026-11-07; see CLAUDE.md for the index.

## Main

- Skills (#11): `src/main/skills/` (`SkillService`). Project skills are specs in `Project.skills` with files in
  `<data>/project-skills/<pid>/<sid>/`; the library is `<data>/skill-library.json` + `<data>/skills/<id>/`; a project
  skill with `libraryId` is a link refreshed from its entry on every read, and a link whose entry is gone is kept but
  never run. Grants are `Role.skills`. Repo import scans `.claude/skills`, `.agents/skills`, `.github/skills`,
  `.opencode/skills` and stores a snapshot copy: `digest` covers the stored files (SKILL.md rewritten), `sourceDigest`
  the folder as found, and apply refuses a missing or stale preview digest; `skills:undoImport` restores skills, files
  and grants (one undo per project). Repo and picked folders are untrusted: SKILL.md is re-emitted with name and
  description only, shell-injection bodies (!`cmd`, ```! fences) are refused, UNC/device paths are refused, and
  `skillLibrary:addFromFolder` accepts only a path from the main-process folder picker (`wasPickedFolder`).
  - Claude: granted skills go into a run-scoped temp plugin named `orgai-<8 hex>` (`claudeSkills.ts`), passed as
    `plugins` with `options.skills` (the 0.3.312 typings, sdk.d.ts `Options.skills`, call it a context filter: only the
    listed skills are enabled, unlisted ones are hidden from the listing and rejected by the Skill tool, their files stay
    readable by Read/Bash; the earlier source read found it also adds Skill(<name>) allow rules; neither is checked live), `settings.disableBundledSkills` plus env
    `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS=1`, and `settings.disableSkillShellExecution` on every run; `settingSources`
    stays `['project']`. The PreToolUse Skill gate allows only `<plugin>:<name>` granted to the calling role, before
    any rule; `skill.used` is emitted from PostToolUse. `AgentDefinition.skills` is not used (it preloads content and
    grants nothing). The namespace and the options.skills behaviour were read from the bundled CLI / sdk.mjs source;
    `scripts/smoke-skills.mjs` (gate beats the allow rule, subagent use, input shape) exists, has NOT been run, and
    needs the user's consent.
  - Codex: `list_skills` / `load_skill` dynamic tools, plus a native skill lock per thread cwd (`lockNativeSkills`:
    skills/list, then skills/config/write enabled=false; config keys verified token-free on codex 0.166.0). It fails
    open with a run warning (review M2); that a disabled skill leaves the prompt is unverified.
  - `skill.used` events count into `RunUsage.skills` (at most 1000 loads per run, unknown ids dropped) and write a
    harness transcript row "Loaded skill <name>".
  - Evaluation (`skills:evaluate`): deterministic checks over the newest 20 work runs; the model step (`kind:
    'skills'`) runs only when `skillEvaluationOf(project).enabled` (an unset `enabled` follows the Team assistant
    setting, `teamReviewOf(project).auto === 'ai'`; see Self-configuration) and the estimate fits its `tokenBudget`. Evidence is
    redacted, the report persists at `<data>/skill-evaluations/<pid>.json`, suggestions apply only on the user's call.
    No A/B replay.
  - Grants are not a confidentiality boundary (review M5): skill files sit in the data dir and the temp plugin dir,
    readable by any agent with Read or Bash. Verified by unit tests and the mock adapter only.
- Team assistant (`src/main/capabilities/`, `CapabilityService`, capabilities:* IPC; see ARCHITECTURE.md "Capabilities
  (Team assistant)"): token-free discover (this project, repo, other tools' skill folders and MCP configs on this
  computer, libraries, curated connectors; MCP Registry and `anthropics/skills` only with includeOutside), a one-shot
  `complete({ kind: 'recommend' })` on the everyday tier with a deterministic keyword fallback, digest-bound apply from
  main's own snapshot (renderer sends ids only; send `candidateId` with `recommendationId`, omit `access` to keep the
  recommendation's), one undo per project, and the persisted Team review (`<data>/team-reviews/`, auto
  'ai' by default: model step bounded by everyRuns, tokenBudget and new evidence). Automatic reviews send the model
  local-machine items as kind + name + redacted target only, and library/project MCP servers with a redacted target
  (`TeamReview.modelInput: 'proactive'`); the manual Re-check sends everything ('full'). Local config files are
  untrusted: never spawned, secret names only, credential args dropped, outside candidates pinned only. A local MCP
  server with a missing secret is saved enabled: false.
  - Review fixes (2026-10-31): an MCP item's `target` is the whole command (`NAME=value command arg ...`; the command,
    args and values with whitespace or quotes JSON-quoted; preset env values shown) or `url -H "Name: value"`, never
    cut: over 400 chars (`MCP_TARGET_MAX`) or with control, zero-width, bidi or other invisible characters
    it gets a `blockedReason` ('Command too long to review') and cannot be applied (`sanitize.ts` `reviewTarget`). The
    discovery digest binds a local or registry server by `mcpSpecDigest` (transport, command, args, url, env and header
    names with registry non-secret values, secretEnv, secretHeaders), so any change to the tail or a secret slot makes
    an apply after re-discovery stale. Registry remotes must be https and not a private-IP literal; `spec.url` and
    `registry.identifier` are stored scrubbed. Registry env presets that change what runs (NODE_OPTIONS, PATH, LD_*,
    PYTHON*, NPM_CONFIG_*, UV_*, PIP_*, DOCKER_*, *_PROXY, ...) and routing headers are dropped with a note, and a
    package identifier that is not a plain name (e.g. starts with '-') blocks the item. GitHub skill folder names must start with a letter or digit ("." / ".." refused). After an apply
    the review refresh takes one snapshot slot only (`Snapshot.refresh`), so many applies from one recommend result
    never go stale. `capabilities:dismiss` takes `recommendationId` and/or `candidateId` and also works on a fresh
    recommend result (a stub review, `TeamReview.stub`, bound to that discovery holds the dismissal; the 'opened'
    throttle ignores a stub and a partial discovery is never stubbed). `capabilities:setGrant` was removed
    (no renderer caller). Team reviews at rest (`<data>/team-reviews/<pid>.json`, plain JSON) hold the discovery items
    (secret-free: names, display paths, scrubbed URLs, full MCP targets with credential args dropped) and redacted
    evidence strings (text only, no keys or tokens), never secret values. Verified by unit tests only.
  ORGAI_MOCK=1 uses `<data>/mock-home` and outside fixtures; the first finished mock work run fills the review from the
  keyword fallback without tokens. Verified by unit tests and the mock adapter (claude.ts / codex.ts `complete()`
  accept 'recommend' with no tools and an honoured signal, read and fake-tested). Unverified: real config files on a
  user's machine, the live GitHub contents API (unauthenticated, rate limit 60/h), the live registry shape, the live
  recommend call on Claude and Codex.
- Assistants (main; see ARCHITECTURE.md "Assistants (ad-hoc sessions)"): three virtual project ids (`isVirtualProjectId`):
  'quick' (Chat: `src/main/quick/`, runs:startQuick / runs:promoteQuick; RunKind 'work' with `RunSummary.quick`),
  'harness' (MCP assistant; `McpAssistInput.allowBuild === true`, library scope only, adds a per-run scratch dir
  `RunSummary.buildWorkspace`, Edit/Write/Bash and permission mode 'default') and 'skills' (Skill assistant,
  RunKind 'skill-assist', setup-like, skills:startAssist; propose_skills -> `SkillService.applyProposal`). Quick runs:
  permission mode always 'default', every edit and command asks (see "Chat asks" below), no project
  MCP/plugins/skills/messaging, installs run-scoped only, grants never written to the folder, Claude
  `settingSources: []` with no saved-rules allowedTools, tools from `QUICK_TOOL_DEFS` incl. `list_projects`
  (secret-free ProjectPeek data block), `request_mcp_install`, `list_skill_library`, `read_library_skill`. Scratch dirs only under
  `<data>/quick` (0o700, boot sweep keeps referenced ones). Promote moves the session chain and drops `quick`.
  Mock scripts: a quick run calls `list_projects` once, says "I can see N OrgAI project(s). Tell me what you would
  like to do." and goes idle; follow-ups get "Mock reply to: <text>". A skill-assist run says "I will look at the
  skill library first, then propose a skill.", calls `list_skill_library`, then `propose_skills` (title "Mock skill",
  one create of `mock-skill`, scope 'library' on 'skills', 'project' with the first role's slug on a project), and
  after APPROVED says "The skill is set up." and goes idle. Quick-run markers `[mock:self-config]` (says "Let me look that up in OrgAI's reference.", app_reference locate "theme", open_in_app `app-settings-general-appearance`, propose_app_settings appearance.theme light; "Done: the theme is now light." on APPROVED, "The theme is already light." on "Nothing to change", else "Understood; I left the settings alone.") and `[mock:self-config-project]` (list_projects, propose_project_settings maxBudgetUsd 5 for the first id; "Done: that project now has a $5 cap from its next run." on APPROVED, else "Understood; I left the project alone.", "You have no OrgAI projects yet." without one) call the real bound tools, never retry on REVISE, and are ignored on work runs (mockSelfConfig.test.ts). Verified by unit tests and the mock only; no live run.
  - Chat asks (2026-11-06; ARCHITECTURE.md Assistants "Chat asks instead of being unable"): quick roles always keep
    Edit / Write / Bash / NotebookEdit (team 'single') or each default role's own tools; `allowEdits` is the user's
    declaration only (false "read-only start: an edit or command asks", true "edits allowed: each still asks" plus
    isolateWriters in a git folder) and changes the prompt (`quickChatText`: make the call, OrgAI asks, the user may
    decline, never work around a refusal). RunManager sets on permission cards (adapter values dropped):
    `quickReadOnly: true` (read-only start, QUICK_WRITE_TOOLS), `maxScope: 'session'` on trust-restricted runs
    ('once' with a referenceFolder), `workingFolder` / `workingFolderScratch` on quick runs; `permission.resolved`
    carries `scope` (narrowed; 'project' on a quick run reads 'session'); a session allow on a quick run writes one
    harness row ("You allowed <rule> for this chat."). Session edits: `src/main/quick/sessionEdits.ts`
    (`quickSessionEditSuggestion` on covered edit cards, never sent to a provider; `isQuickSessionEditGrant` in
    decide(); `RuntimeContext.quickSessionEdits`; `quickEditPreApproved` in every adapter after its deny gates; only
    inside the folder by lexical and real path with no symlink or junction component below it (lstat, dangling links
    included), never a Codex change with a move destination, never a raw path with a `.` or `..` segment (refused before any resolution, since a POSIX writer follows `link/..` through the link first; NH1), never under .git/.claude/.codex/.agents/.orgai/.vscode/.idea/.github
    or config files incl. agents.override.md). MCP: `McpInstallRequest.runOnly: true`, approvals narrowed to 'run' and
    never persisted on any `summary.quick` run, `spec.roles` = the caller's role, `[]` (nobody) for an unknown caller;
    per-role MCP grants are not enforced on Codex (open review M6). Rule labels in the "You allowed ..." row are stripped
    of hidden characters. Check-then-write gap and in-folder package.json/Makefile edits: ARCHITECTURE.md Risks.
    Mock markers (quick runs, default script): `[mock:chat-edit]` (list_projects, Edit `<folder>/notes.md` asks;
    allow writes it and says "I wrote notes.md.", deny says "I did not change anything." and stops; then Bash
    `npm test` asks, then idle) and `[mock:chat-mcp]` (request_mcp_install of a pinned stdio server, says the answer,
    idle). Codex (source-read at rust-v0.166.0, not run live): under approval policy `untrusted`, `safety.rs`
    `assess_patch_safety` returns AskUser before the writable-path check, so every apply_patch (in-workspace too)
    raises a file-change approval, and `exec_policy.rs` prompts for every command no execpolicy allow rule matches
    (no bundled "known safe" list found); an ApprovedForSession apply_patch approval is keyed per exact file path
    (`ApplyPatchApprovalKey`). The shell approval key, the first-attempt orchestrator branch and Windows
    restricted-token enforcement were not confirmed. Verified by unit tests, fake query() / fake Codex app-server and the mock only; nothing live.
  - Plan nudges (UX M5): `continuation.ts` `planNudgesApply(run)` is false for a quick run with team 'single' (a
    conversation), and RunManager folds it into `RuntimeContext.autoContinue`, so no adapter's ContinuationDriver
    sends set-plan or continue nudges there; interrupt holds and auto-resume are unchanged, team 'default' keeps nudges.
    Unit-tested (continuation.test.ts, runManagerAssistants.test.ts); the mock script needed no change. Notifier still
    reads the Chat display project (`autoContinue: false`) for every quick run, default team included.
  - Trust-restricted runs (security round, merged at 5e2384a): quick runs and MCP build sessions
    (`RunSummary.buildWorkspace`) are `isTrustRestrictedRun` (`src/main/quick/scratch.ts`). RunManager `isRestricted`
    turns a 'project' permission scope into 'session' in `decide()` for every adapter, `decideRules` keeps a
    'project' rule grant on the run, and `allowedRules` returns the run's grants only (no saved rules from the folder).
    Claude (`claude.ts`): `claudePermissionMode` ask-only (auto / acceptEdits / bypass become 'default'),
    `claudeAllowsBypass` false, `claudeSettingSources` [], `claudeSavedRules` none, `quickSafeDecision` downgrades a
    project scope, and `buildConfigWriteDenial` makes PreToolUse deny Edit / Write / MultiEdit / NotebookEdit under
    `<workspace>/.claude/` (`isWorkspaceConfigPath`: lexical plus the real path of the nearest existing ancestor; a
    missing or non-string path is denied). Codex (`codex.ts`): `onCommandApproval` / `onFileApproval` read
    `ctx.allowedRules` (saved rules only as a fallback when it is absent, never on a restricted run), a project scope
    becomes session in `ask()`, a build-session file change under `.claude/` is declined without a card (log warning
    plus a harness transcript row), and `buildLaunchConfig({ noProjectDocs })` adds `project_doc_max_bytes=0`
    (`NO_PROJECT_DOCS_CONFIG`) for restricted runs and every `complete()`, which also runs with `os.tmpdir()` as cwd;
    the key was found by grepping the bundled codex 0.166.0 binary, its effect is unverified live. `policyFor` takes
    `{ quick, setupWrites }`: a build session whose role writes gets workspace-write with untrusted approvals (bypass
    falls back to the asking default). The mock follows the same rules. Verified by unit tests and the mock only.
  - Build sessions on continue: `RunManager` option `buildProject(summary)` rebuilds the harness project for
    `projectOfRun`; index.ts passes ipc.ts `harnessProjectFor`, which accepts only an existing `<data>/quick/quick_<id>`
    dir and throws "This build session's workspace is gone" for a vanished or forged path (runs:continue is tested
    through the IPC handler in ipcAssistants.test.ts; the auto-resume path through index.ts's `buildProject` only
    with a throwing fake in runManagerAssistants.test.ts). `withBuildTools(role, summary)` keys off
    `RunSummary.buildWorkspace` (mcp/assist.ts `buildToolsFor`; `isBuildWorkspaceProject` is gone).
  - Quick-run input: `checkQuickContinue` (ipc.ts) refuses a runs:continue / runs:send text over
    `QUICK_RUN_MAX_PROMPT_CHARS` on a quick run and re-validates a non-scratch folder; `validateQuickFolder` also
    refuses a folder that contains the data dir ("That folder contains OrgAI's data…"). Promote counts a paused run
    with `autoResume` as live. `ProjectStore.save` and `saveFromRenderer` refuse virtual ids. `list_projects` and `quickChatText`
    tell the agent reading outside the folder may need the user's permission. Unit-tested.
  - Quick-path identity (merged c7d8de7, found by the v0.1.5 release build): `createScratchDir` returns the canonical
    path, and every containment or identity check compares both spellings through `scratch.ts` `isInsideEither` /
    `samePath` / `isReferencedScratch` (`canonicalDeep` resolves the nearest existing ancestor and re-appends the rest;
    `validateQuickFolder` fails closed with "OrgAI could not check that folder against its data folder." when
    resolution throws). Lexical and real paths differ on macOS (`/var` vs `/private/var`) and on the windows-latest
    runner (8.3 temp path `RUNNER~1`), which is why five quickRuns tests passed locally and failed in CI on both OSes.
    `pathKey` keeps a root's separator, so a drive root is refused by M3 (review High, pre-existing). Open Lows: case
    folding of a missing data-dir tail on macOS, a dangling link in the data dir's ancestry, and `mcp/builds.ts`
    `insideWorkspace` still compares lexically. Unit-tested with a junction (Windows) or dir symlink; macOS confirmed
    only by CI.
  - Built MCP servers (`src/main/mcp/builds.ts`, review M5): approving a library proposal from a build session copies
    a stdio server whose command or args point into the workspace to `<data>/mcp-builds/<entryId>/` (regular files
    only, symlinks and junctions skipped, realpath-confined, `.git` / `node_modules` / `.claude` skipped,
    `BUILD_MAX_FILES` 2000 / `BUILD_MAX_BYTES` 50 MB), rewrites the paths, and stores a sha256
    `McpLibraryEntry.buildDigest` over sorted relative paths and bytes; a failure rolls back the installed copies (an old build dir is restored) and discards the staged ones.
    No dependency install: a built server must vendor or bundle its deps. The dir is deleted with its library entry
    and never swept. The renderer cannot set `buildDigest` (stripped on write, malformed values dropped on read) and an
    edit that changes command or args clears it; nothing re-checks the digest at run time. `McpService` takes
    `dataDir`. Unit-tested (`serviceBuilds.test.ts`).
  - `SkillService.applyProposal` snapshots the library and project skill files and restores them on any throw.
    Unit-tested.
  - Reviewer re-check at 5e2384a: H1 and M1-M6 fixed, no Critical or High. Open LOW items (L-a to L-g, L5; listed in
    ARCHITECTURE.md Risks): buildDigest never checked at launch, partial staging of workspace paths (`--entry=`, env,
    relative args), the .claude/ guard skips Bash moves, removeEntry deletes build dirs before later commits, Codex
    empty-path / workspace-grantRoot approvals, case folding on macOS, the skills rollback can overwrite another
    project's concurrent edits. Unverified live: settingSources [] on resume, PreToolUse deny precedence,
    `project_doc_max_bytes=0`, the Codex decline text reaching the agent, workspace-write enforcement on Windows.
- Self-knowledge and self-configuration, phase A (2026-11-07; ARCHITECTURE.md Shared contracts, Runtime core
  "Self-knowledge", Conventions): the atlas `src/shared/view/atlas.ts` (77 surfaces, deep-link id tables, total
  `APP_SETTING_DOCS` / `PROJECT_SETTING_DOCS` / `MENU_ACTION_DOCS`) and `shortcuts.ts`; the reference service
  `src/main/reference/appReference.ts` (search / read / locate / status over atlas, docs, `harnessToolCatalog()`,
  HOST_CHANNEL_REGISTRY, CLI COMMANDS, CONNECTORS and bundled docs); IPC `app:reference` (read) and the desktop-only
  push `app:navigate`; tools `app_reference` (every run kind; status only on Chat, MCP and Skill assistant runs),
  `open_in_app` (Chat, setup, assistants; atlas ids only, 20 per run, one per 2 s, a harness row "Opened <path> for
  you"; the main window only, never reopened, focused only while OrgAI is the foreground app, else flashed),
  `propose_app_settings` / `propose_project_settings` (Chat only, cards; never main-owned, connection, proxy,
  auth, terminal, model-price or permission-rule fields, never bypassPermissions); Help > "Ask OrgAI about itself…"
  (`ask-about-orgai`). New fields, screens and menu actions need their atlas entries (typecheck and atlas.test.ts).
  How checked: unit tests (atlas.test.ts, appReference.test.ts incl. a fake secret that never reaches status,
  argsReference / selfKnowledgeHost / registry / jsonRoundTrip / appMenu tests, harnessToolsSelfKnowledge.test.ts,
  runManagerSelfKnowledge.test.ts, service and prompts tests); `npm run build` was checked to carry the docs in
  `out/main/index.js` and `out/cli/inprocHost.mjs` (about 0.7 MB each); search measured about 2 ms per query. Not
  built yet: the renderer (no handler for `app:navigate` or `ask-about-orgai`, so the Help item does nothing; the
  appSettings card is a one-line APPLY_NOTE placeholder in ProposalCard.tsx; until the real card lands the card title
  is main-written and names every change and the target project, review H1) and a mock script. Until the renderer
  handles `app:navigate`, open_in_app answers "Opened <path>" while nothing visible happens (review L6). Unverified: a real
  window receiving `app:navigate` (fake windows only), any live model using the tools, Codex accepting the four
  names as dynamic tools, atlas summaries that rest on CLAUDE.md rather than the components. Six proposable app
  fields (defaultMaxBudgetUsd, defaultKeepRuns, defaultIsolateWriters, opusGuardThreshold, defaultAutoContinue,
  defaultMaxAutoContinues) have no screen (atlas surface 'none'). `propose_org_change` from Chat was left out.

## Renderer

- Skills UI (#11, `components/skills/`, `lib/skills.ts`): Team > Catalog is ordered Skills, Connections, Plugins (the project Tools pane is gone; `SkillsSection`, `skills-section`, rows `skill-row`, empty `skills-empty`, buttons `skill-add-library` (primary), `skill-new`, `skill-import`, `skill-evaluate`, notices `skill-notice`). A row whose skill no role can load shows the "No role can load this" badge (`loadableByNoRole`). Every add flow (new, from library, import, apply) uses the shared role picker `SkillRoleAccess` (`skill-role-picker`, `skill-roles`, `skill-role-hint`). Row extras sit in a "More actions for <name>" popover; Promote to library and Unlink end in notices (`promotedNotice`, `skillAddedNotice`). Also `skill-library-missing`, `skill-elevated`. `SkillLibrarySection` is the App settings "Skill library" pane (`skill-library-row`, `skill-library-used-by`, `skill-library-remove-body`); `requestSkillLibrary()` (`lib/settingsTarget.ts`) is the deep link from the project section; its remove ConfirmDialog names the roles per project (`libraryRemoveLines`).
- Skill import and evaluation (renderer): `ImportSkillsDialog` + `SkillImportControls` (`skill-import-item`, `-invalid`, `-duplicate-hint`, `-no-roles`, `-apply-error`). The import banner counts importable and refused skills (`importBannerLine`, remembered per project in localStorage, `skillBannerKey`). Dropped-keys (`skill-import-dropped-notice`) and refused (`skill-import-refused-line`) notes stay after import, duplicates are locked, closing a dirty dialog asks a discard confirm. `SkillEvaluationPanel` is a disclosure (`skill-eval-toggle`, `-heading`, `-last`, `-budget`, `-live`) that stays open while suggestions are unresolved; suggestions (`skill-suggestion`, `-dismissed`) have Apply, Dismiss and Undo; after Evaluate focus moves to the result and a live region announces it (`evaluationAnnouncement`). `RoleSkills` is the role inspector's list (`role-skills`, `role-skill`).
- Team assistant (main): dismissals filter capabilities:recommend too (never sent to the model), a manual Re-check merges with the pending list and the held recommend result instead of replacing it, and under ORGAI_MOCK the first finished run always leaves something pending; the mock recommend answer also picks the mock-home `code-review` skill. Unit-tested only.
- Skills in run views: `TranscriptPanel` + `lib/transcriptRows.ts` `collapseSkillLoads` render one "Loaded skill <name>" row (SKILL.md under "Show instructions"); the matching `load_skill` call row is hidden and `list_skills` rows ("Listed its skills") fold into it. `UsagePanel` has a "Skills loaded" table (`usage-skills`, `usage-skill`). e2e: `e2e/skills.mjs` (in e2e:free).
- Skills UI open items: Promote has no role picker; there is no `promotedFrom` origin field; "Used by" projects are not links; the New project form has no "Found N skills" line; Apply and Dismiss are not covered by e2e (the mock gives no suggestions); per-agent skill counts come from transcript rows (5000-entry trim); A/B replay evaluation is not built; `scripts/smoke-skills.mjs` is unrun and needs consent (spends tokens).
- Assistants (renderer; spec `docs/design/assistants-ui.md`): Chat, MCP assistant and Skill assistant are virtual projects (`quick`, `harness`, `skills`) in a sidebar "Assistants" group above Projects (`nav-assistant[data-id=quick|harness|skills]`, rows share the project-row renderer in `Sidebar.tsx`; rail icons MessageSquare / Plug / Sparkles, the Chat tooltip names Ctrl/Cmd+Shift+N). Store: `virtualProjects` (replaces `harnessProject`; `loadVirtualProject` uses `projects.get(id)`, else `lib/assistants.ts` `displayProject`), `openAssistant(id, { instruction?, fresh? })` (an instruction seeds `assistantSeed`), the exported `openNewChat()` (Ctrl/Cmd+Shift+N in App.tsx, `projects-new-chat`, first-launch `empty-chat-now`), `startQuick`, `startSkillAssist`, `startLibraryAssist(instruction, allowBuild)` (the run opens in place, no window), `promoteQuick` and `handleEvent` 'run.moved' (moves the run between `runs` / `historyByProject` / `activeRunByProject`); `loadAllHistory` covers the virtual ids and `startRun` returns early for them. A virtual project's topbar shows the label, Live and History only, no folder chip. Start pages in `components/assistants/` (`ChatStartPage`, `McpAssistantStartPage` and `SkillAssistantStartPage` on `InstructionStartPage`, `AssistantModelLine`; styles in `styles/assistants.css`): `assistant-start-<id>`, `assistant-instruction`, `assistant-start`, `chat-folder`, `chat-folder-browse`, `chat-folder-clear`, `chat-existing-project`, `chat-open-project`, `chat-team`, `chat-allow-edits`, `chat-summary`, `mcp-allow-build`, `assistant-model-line`. An ended virtual run offers Continue, else `assistant-ended` + `assistant-new-session`; the idle label is `ASSISTANT_IDLE_LABEL` ("Your turn. Reply, ask a follow-up, or end the session."); Needs-you locations use `locationLabel`. Save as project: `SaveAsProjectDialog` (`save-as-project-dialog`, `save-as-project-confirm`), `run-save-as-project` in RunActions (ended runs still in the Chat project only, disabled with a reason for scratch), `history-save-as-project` and `history-folder` in Chat History. Org retrospective only for real projects' work runs (`offersRetro`); kind chips through `runKindLabel` (quick = "Chat"). ProposalCard kind 'skills' (`proposal-skill-item[data-skill]`, `skillsApplyNote`); App settings > General > Advanced settings > Assistant models adds `skill-assist-model-row` / `quick-run-model-row` (`lib/assistantModels.ts` `skillAssistModel` / `quickRunModel`, `ASSISTANT_MODEL_FALLBACK`). Elsewhere: Connectors > Custom servers "Configure with AI" calls `openAssistant('harness')` (`mcp-library-assist-banner` while a run is live); Team > Catalog > Skills `skill-ask-assistant` starts a project-scope Skill assistant run. e2e: `e2e/assistants.mjs` (in e2e:free; 1024x640 and 1600x1000, dark and light, mock): the start pages, sidebar, topbar and the Assistant models rows (General > Advanced) are e2e-checked; its run-starting checks (Chat to Idle, scratch Save as project disabled, `history-folder` "Scratch", skill proposal approve) pass on dev against the merged runtime (the orchestrator ran it at 34f6370 and again after 5e2384a); the "SKIP (runtime not merged)" guard only fires when `runs:startQuick` has no handler. Pure helpers in `lib/assistants.ts` are unit-tested.
- Assistants UI after the UX walk (`docs/design/ux-review-assistants.md`, walked 34f6370; fix-up merged at 4ea724f, spec section "Changes after the UX walk"): conversation layout for single-agent runs (`lib/assistants.ts` `isSingleAgentRun`: a Chat with team 'single', 'mcp-assist', 'skill-assist'; `runLayoutFor(summary, chosen?)`, pure, unit-tested). In 'conversation' the stage (`run-conversation`) is the root agent's transcript (`TranscriptPanel variant="conversation"`, `conversation-transcript`), newest at the bottom and kept there unless the user scrolled up (then an in-flow `conversation-jump` "Jump to latest"); the column and the composer are centred at 90ch and the composer stays under the stage even with a wide side panel (`.run-body[data-layout=conversation]` beats `[data-side-wide]`); zoom, legend and Hide finished are hidden; the tray and side panel are unchanged. The toolbar `IconButton` `run-layout-toggle` ("Show agents" / "Show conversation") is on every run, `.run-body[data-layout]` carries the layout, and the pick is remembered per run in the store (`runLayoutByRun` / `setRunLayout`). Sidebar: `lib/assistantNav.ts` `assistantRunToOpen` (pure, unit-tested) opens the run that needs you, else the last viewed live run, else the newest live run, else the start page, never an ended run (ended runs stay in run tabs and History; `settleWorkspace` follows it for virtual ids); `openAssistant(id, { instruction?, fresh? })` with an instruction or `fresh` (New chat / `openNewChat`, Configure with AI `mcp-library-assist`) always shows the start page. After approving a skills or MCP proposal, RunMeta shows a dismissable link (`lib/proposalNext.ts` `proposalNextFor` / `PROPOSAL_NEXT_COPY`, store `proposalNextByRun`): `proposal-next-skills`, `proposal-next-connectors`, `proposal-next-project-skills`, `proposal-next-project-mcp`. Save as project (`run-save-as-project`, `history-save-as-project`) shows only while `offersSaveAsProject` (the run is still in the Chat project); for scratch it is a really disabled `Button` inside `span.run-act-disabled`, which carries the reason as its title. Chat start page: typed path `chat-folder-input` beside Browse (`projects.checkPath`, 300 ms debounce, `chat-folder-error`; an invalid path counts as scratch and Start re-checks); the edits switch is now enabled for scratch too (see "Chat asks, renderer"). Copy (`assistantModeLabel`): "Waiting for your answer" while a card is open, else idle "Your turn. Reply, ask a follow-up, or end the session." (`ASSISTANT_IDLE_LABEL`), else "Reply to the assistant" (`speaksAsAssistant`: virtual projects, single-agent chats, project-scope Skill assistant runs); `composerPlaceholder` drops doubled punctuation. The "+" tab and draft tab of a virtual project read "New chat" (Chat) / "New session" (`newSessionLabel`). RunMeta says "unattended" only on real projects' work runs and shows the MCP assistant's `buildWorkspace` (`run-meta-workspace`, full path in the title). History kind filter chips are hidden for the three virtual projects; `.col-folder` ellipsises and narrows under 900 px; `.skill-prop-md` uses the token `--scroll-region-max`; `.new-run` is a size container that tightens under 560 px of height; the build switch reads "Let it build a server in its workspace, in OrgAI's data folder". e2e/assistants.mjs (mock, in e2e:free) checks: the conversation layout shows the mock reply and the composer at 1024x640 without page scroll (both themes), the toggle both ways, the start page from the sidebar after an ended Chat and from Configure with AI after an ended MCP run, the typed-path error and the Save as project flow from a typed folder (gone from the run strip and History afterwards), the "+" tab labels, no "unattended" on Chat / Skill / MCP assistant runs, the disabled scratch Save as project with its reason, no kind chips in Chat History, and `proposal-next-skills` after a library skills approval. `conversation-jump`, `run-meta-workspace` and the connectors / project proposal links are not driven by e2e.
- Chat asks, renderer (2026-11-07; `docs/design/assistants-ui.md` "Implementation notes: Chat asks for permissions", walk `ux-review-chat-permissions.md` H1, H2, M1, M3, M4): wording in `lib/chatPermissions.ts` (pure, unit-tested). PermissionCard honours `maxScope` through `scopeLimit`: 'session' (Chat, MCP build sessions) has no "Always allow for project", no `perm-scope-project`, no settings link; its effect line is `perm-scope-session` (`sessionScopeCopy`, "... until you end this chat"; the quick session edit offer reads "stops asking for edits in this chat's folder"); a Chat card shows `perm-location[data-kind=chat]` ("Runs in <folder>" / "Runs in this chat's scratch area", `chatPlace`) and with `quickReadOnly` `perm-quick-readonly` ("This chat started read-only. Allowing lets it change ..."). McpInstallCard with `runOnly`: "Add a server: <name>", `mcp-install-run-only`, no scope radios, `mcp-install-approve` "Add for this chat" / `mcp-install-deny` "Don't add" (testids on every install card; a run-only stdio card says "Adding it runs code on this machine until this chat ends.", a remote one that it connects to the address; resolved "Added" / "Not added", a deny note kept). RuleRequestCard drops "Always allow for project" and its sentence on a run with `quick` or `buildWorkspace` (main keeps such grants on the run; the request has no maxScope field yet). Start page: `chat-allow-edits` is `ui/Switch` "Let it make changes", enabled on scratch, hint per folder; `chat-asks-line`; new `chat-summary` copy. RunMeta `run-meta-access[data-state=asks|edits|session]` ("asks first" / "edits allowed" / "changes allowed this session"); 'session' from store `RunState.sessionChanges` (permission.resolved scope 'session' or 'project' on a write or command tool of a quick run; live only), announced once through `tray-announce`. Needs-you captions use `decisionLocationLabel` ("Chat, scratch" / "Chat, <folder>"); `save-as-project-permissions-note`. e2e/assistants.mjs drives `[mock:chat-edit]` (Allow for session by keyboard, chip, harness row, npm test card; Deny path) and `[mock:chat-mcp]` (run-only card), one full flow per size/theme pair plus no page scroll with a card open at all four. Not driven: an MCP build session card, a folder Chat card by e2e, the Chat captions by eye, screen reader output, macOS / Linux; no UX re-walk yet.
- Assistants UI open items (UI Lead, after 4ea724f): in conversation mode the side panel's Transcript tab duplicates the stage (accepted; the panel is collapsed below 1100 px); `proposalNextByRun` entries are cleared only by Dismiss, and the link is untested at narrow toolbar widths; the MCP start page cannot name the build folder before the run starts. Not exercised: the native folder picker, the Save as project 'existing' outcome, a default-team Chat in conversation mode, the project-scope `skill-ask-assistant` run. Not addressed from `ux-review-assistants.md`: L3 (Team disclosure wording), L4 ("Stopped" vs "Ended"), L6 (first-launch focus), L7 (brand lockup), L8 (MCP wording in the start page title), and moving focus to a decision card when it arrives.
- Self-help (renderer; spec `docs/design/self-help.md`, pre-walk `ux-review-self-help-pre.md`): `lib/settingsTarget.ts` re-exports the atlas deep-link tables and `lib/menuActions.ts` the shared SHORTCUTS (pinned as the same objects by unit tests); add panes and sections in `src/shared/view/atlas.ts`. Help > Ask OrgAI about itself (menu action 'ask-about-orgai', `askOrgAI()`, also `ask-orgai-button` in About and `shortcuts-ask-orgai` in the shortcuts dialog) opens a fresh Chat start page seeded "How do I " (`ASK_ORGAI_SEED`, caret at the end); the start page has `chat-examples` with three `chat-example[data-example=theme|plan-guard|permission-mode]` chips (a chip replaces only an empty field, the seed or another example). Agent navigation: `lib/appNavigate.ts` (pure, `SURFACE_TARGETS` per atlas id, `navigationFor`) and `lib/useAppNavigate.ts` (subscribed in AppMenuLayer before useAppMenu; reuses the deep links; focus lands on a heading only, re-checked after 400 ms so a deep link that focuses a control is overridden) with `components/AppNavigateBanner.tsx` under the Dashboard, App settings and project topbars: `app-navigate-banner` (a named region, not a live region), `app-navigate-text` "<agent> opened <path> for you." (project crumbs named), `app-navigate-back` Back to chat (the asking run, composer focused), Dismiss (focus to the heading); one at a time, cleared on leaving the place; refusals ("tried to open a project this window does not have", "pointed you to Help in the menu bar") and navigations inside the asking run show only the run tabs' notice; every sentence also goes through `announceMenu`. Cards: `appsettings-proposal` (Setting / Now / New table grouped by pane, `appsettings-change[data-field]`, `-now`, `-new`), target settings card (`proposal-target-badge`, `proposal-target` "Applies to <name> · <folder> · <connection>", `settings-change[data-field]`, target project's kind, a client change always listed), `proposal-approve` on every proposal card ("Apply to App settings" / "Apply to <project>"), Decline on the primary row for these two; transcript `self-help-row[data-tool=app_reference|open_in_app]` (`lib/selfHelpRows.ts`), "Proposed app settings" / "Proposed settings for <project>". e2e `e2e/self-help.mjs` (in e2e:free, after menu.mjs): entry points, chips, router through a pushed `app:navigate` (Appearance, a project's Limits, unknown project, menu path, Back, Dismiss, both sizes, light shot) pass on this branch; the `[mock:self-config]` / `[mock:self-config-project]` steps (card, Approve, theme, Done lines, Limits cap) SKIP until the mock markers are in the build. Reviewer: not blocked; M1, M2, L1-L4, L6 fixed. Not seen: the cards by eye, screen reader output, macOS.
- Self-help re-walk fix-up (renderer): the navigation banner adds "A change is waiting for you in the chat." and "Back to chat to decide" while the asking run has a card open, Tab from the landed heading enters the banner, Esc dismisses, section destinations focus the section heading; fold summaries read "1 app setting · App settings" / "1 setting · <project>"; `list_projects` folds to "Listed your OrgAI projects". Unit-tested; e2e/self-help.mjs checks the banner text, Tab and Esc.
