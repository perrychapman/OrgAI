# OrgAI – notes for agents working in this repo

Electron + electron-vite + React 19 + TypeScript. React Flow (`@xyflow/react`) for both the org chart editor and
the live view; `@dagrejs/dagre` for tree layout; zustand for renderer state.

- `npm run typecheck` runs both tsconfigs (node + web). Keep it clean. TypeScript 7: no `baseUrl`, paths are `./`-relative.
- Shared types live in `src/shared/types.ts`. Anything crossing IPC must be defined there and be structured-clone safe.
- The renderer only sees normalized `RunEvent`s. Vendor specifics stay inside `src/main/runtime/<provider>.ts`.
- Adding a provider: the adapter is SDK event mapping plus hook mechanics only (spawn enforcement, deciding isolation
  at spawn time, reporting an agent's real cwd, exposing tools). Harness tools live in `harnessTools.ts`, role
  prompts in `prompts.ts`, activity strings in `activity.ts`, the worktree state machine in `integration.ts`
  (`WorktreeIntegrator`, adapter supplies `notify`), permission scopes in `permissionRules.ts`. `mock.ts` is the
  reference adapter; `npm test` runs vitest (`*.test.ts` beside the modules) and never spends tokens.
- Unattended execution: the work-run plan (`RunPlan` on `RunRecord`, `plan.updated` events) is written by the plan
  tools in `harnessTools.ts` through `RuntimeContext.updatePlan` (RunManager stores, persists and broadcasts it).
  `continuation.ts` holds the pure `nextNudge` decision and the `ContinuationDriver` every adapter calls at turn end
  (`turnEnded`), on user messages, on interrupt (`hold`) and at session end; the adapter only delivers the nudge
  through its harness-message path (Claude: `notifyOrchestrator`). Never nudge setup runs.
- Cross-run messages (`message_run`) never override the user: RunManager gates delivery (`peerDeliveryBlocked`) while
  a run is held by an interrupt, usage-limited (`ActiveRun.limitHold`) or has pending cards, holds them in the run's
  inbox (at most `RUN_MESSAGE_QUEUE_LIMIT` 20) and flushes them oldest first, one chained flush at a time, after the
  user's next successful `send()` or the last card's answer. Only the user's send lifts a hold; peers never do, not
  even after an auto-resume. `send()` never waits on that flush. Each `receive()` is raced against
  `RUN_MESSAGE_RECEIVE_TIMEOUT_MS` (30 s): on timeout both runs get a warning, the chain moves on and a direct sender
  gets refusal `timeout`. Caps: 40 per sender per target, 100 inbound per run. A direct `RuntimeSession.receive()`
  call is ungated, so always deliver through RunManager.
- Windows run with `sandbox: false` because the preload is ESM (`index.mjs`) and Electron cannot sandbox an ESM
  preload. The fix is building the preload as CommonJS and enabling the sandbox. Navigation guards
  (`shouldBlockNavigation` in `windowScope.ts`) cover will-navigate, will-redirect and will-frame-navigate and fail closed.
- Run end: RunManager calls `cancelPending` (`pendingCards.ts`) when a run reaches an outcome or `paused`, and at
  teardown. Every open card then gets its `*.resolved` event with `cancelled: true`. `activity.ts` `runOutcome` /
  `settleAgent` relabel agents Finished, Stopped or Failed. Harness-written transcript entries carry
  `source: 'harness'` (Claude, Codex and mock) and render as quiet system rows. Verified by unit tests.
- Decision cards are kept in RunManager's pending maps (`PendingCardMaps` in `pendingCards.ts`) with their request
  objects. `RunManager.pendingCards` (IPC `runs:pendingCards`) hands them to a fresh renderer, which otherwise only
  learns of cards from `*.request` events broadcast at request time. Verified by unit tests. No renderer code calls
  it yet.
- Settings: `AppSettings.appearance` (theme, accent, canvas, reduceMotion; `DEFAULT_APPEARANCE`) and
  `AppSettings.notifications` (the single source of truth; `notifications.setEnabled` in the preload is a deprecated
  mirror) are saved through `settings:set`, which broadcasts `settings:changed`. The renderer applies appearance only
  in `lib/theme.ts` (`initTheme` in `main.tsx`) as `data-theme`, `data-canvas-*`, `data-reduce-motion` and `--canvas-*`
  on `<html>`. Views never read appearance settings themselves. `AppSettings.setupModel` / `mcpAssistModel` (default
  'deep', normalized in `store/settings.ts`; values are tier names or concrete ids, an old saved default 'opus' loads as 'deep') pick the built-in Architect and MCP assistant models, resolved per run by
  `runtime/builtinModel.ts` (deep-tier fallback, one run warning). They are edited in App settings > Defaults >
  "Assistants"; the MCP assist dialog hint and the Org retrospective tooltip name them (`lib/assistantModels.ts`).
  The `orgai:settings-section` window event switches a mounted App settings page to the requested pane.
- Run titles: `RunSummary.title` (at most `RUN_TITLE_MAX_CHARS` = 32) and the `run.title` event come from
  `src/main/ai/runTitle.ts`. RunManager fires it for work runs with prompt text and never awaits it. It is a one-shot
  `complete({ kind: 'title', model: fast tier, connection })` with a 20 s timeout, cleaned by `cleanTitle`. A failure
  leaves the title unset, and the UI falls back to the prompt. Continuations get the earlier run's title as context.
  Auto-resume (`RESUME_TEXT`) keeps the earlier title. The mock answers `kind: 'title'` with the first 4 words of the
  `<message>` text, and `[mock:title-fail]` makes it throw. The live fast-model call is unverified (no smoke script).
- Projects: `projects:checkPath` (`ProjectPathCheck`) never rejects. `projects:create` validates the path, and
  `ProjectCreateInput.mock` is accepted only with `ORGAI_MOCK=1`.
- Agent import (`src/main/setup/import/`, `AgentImportService` in `importer.ts`): `projects:scanAgents` (never
  rejects), `projects:previewImport`, `projects:applyImport` (returns `previousRoles` for Undo), `projects:exportOrg`
  (`.orgai/org.json`, format `orgai.org/1`), `ProjectCreateInput.importAgents` and the `ProjectPathCheck` extras
  (`agentSources`, `instructionFiles`, `existingProjectId/Name`). Sources: OrgAI export, Claude Code, opencode, Codex,
  Copilot, Gemini CLI, Kiro, Roo; AGENTS.md/CLAUDE.md-style files are listed, never roles. Models map to the project's
  connection (`model.ts`, `importTierForModel` in defaults.ts: kept, tier, or 'everyday' default). Preview and apply
  re-scan the stored project's folder (the renderer sends choices, at most 200, never roles); apply requires the
  preview's `digest` (`AgentImportApplyInput`) and refuses a missing or stale one. Items carry the whole `prompt` and
  `elevatedTools` (Bash, Edit, Write, NotebookEdit, 'canSpawn') for the UI to show. A definition with no tool list
  gets read-only Read, Glob, Grep; a 'replace' keeps the old role's MCP grants with a "Keeps MCP access" note.
  The repo is untrusted: absolute roots, realpath-confined regular files outside .git only, no process or network,
  4,000-char YAML lines and linear parser regexes (timing-tested), hard caps (see ARCHITECTURE.md
  Conventions). Every parser is verified only by fixtures written from the docs, not by files the other harnesses
  produced; Copilot, Gemini, Kiro and Roo are best-effort. No renderer code uses it yet.
- Usage and pricing (#10): `src/main/runtime/pricing.ts` (pure) prices per token (`ModelPrice`, each price finite,
  >= 0 and at most `MODEL_PRICE_MAX_PER_TOKEN` 0.01). Per model: override (`AppSettings.modelPrices`, at most 200,
  connection-scoped beats global) > provider-reported cost > 0 > proxy (LiteLLM `RunConnection.pricing` /
  catalog `ProviderModel.price`) > builtin (`BUILTIN_PRICES`, vendor pages read 2026-10-30; 5.x ids are guesses) >
  community (`communityPrices.ts`, off with `AppSettings.communityPrices: false`) > unknown (`costUsd: null`, never
  $0; a partly priced sum sets `costPartial`). `priceFor` is memoized per pricing record (index + 500-entry cache).
  `runUsage.ts` holds `AgentUsage` (adapters only tally tokens per model, turns, tool calls, retries and provider cost
  through `setModelTokens` / `countUsage`) and `RunUsage` (cost, models, roles, wall / waiting / limit-hold / idle
  time, nudges, agents without a result, `skills`). The root agent is never counted as producing nothing. RunManager
  prices every `agent.upsert`, drops an adapter's `run.usage`, and publishes its own at most once per 1 s
  (`USAGE_THROTTLE_MS`, trailing; at once on a terminal status). The adapter's `run.cost` is ignored as a provider
  total when `RunConnection.pricing` is set. Records saved before usage tracking are normalized on read with
  `legacy: true`. `runs:usageStats` (default 500 rows, max 2000; roles, trend and totals cover only the returned rows)
  and `models:prices` (override, proxy and builtin rows) are the IPC. LiteLLM discovery caps: 2,000 models, 200-char
  ids (`validModelId`), 5 MB body. Mock: `[mock:no-price]` makes every agent unpriced, `[mock:computed-cost]` prices
  from the builtin table with no provider cost, and the default script's `mock-report-2` is unpriced and returns
  nothing. Verified by unit tests and the mock only; no live run has checked the builtin ids or which model id the CLI
  or a proxy reports.
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
    'skills'`) runs only when `Project.skillEvaluation.enabled` and the estimate fits its `tokenBudget`. Evidence is
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
  permission mode always 'default', read-only unless allowEdits, no project MCP/plugins/skills/installs/messaging,
  grants never written to the folder, Claude `settingSources: []` with no saved-rules allowedTools, tools from
  `QUICK_TOOL_DEFS` incl. `list_projects` (secret-free ProjectPeek data block). Scratch dirs only under
  `<data>/quick` (0o700, boot sweep keeps referenced ones). Promote moves the session chain and drops `quick`.
  Mock scripts: a quick run calls `list_projects` once, says "I can see N OrgAI project(s). Tell me what you would
  like to do." and goes idle; follow-ups get "Mock reply to: <text>". A skill-assist run says "I will look at the
  skill library first, then propose a skill.", calls `list_skill_library`, then `propose_skills` (title "Mock skill",
  one create of `mock-skill`, scope 'library' on 'skills', 'project' with the first role's slug on a project), and
  after APPROVED says "The skill is set up." and goes idle. Verified by unit tests and the mock only; no live run.
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

- Work-run configuration changes (2026-11-02; see ARCHITECTURE.md Conventions): the work-run root has propose_mcp_servers
  (project-only, enforced in main), list_skill_library, read_library_skill and propose_skills (create / update / link /
  grant / remove, project scope). Approved changes reach the live run through RunManager `setLive` and
  `HarnessToolHooks.configChanged` (Claude: setMcpServers now, restart at idle for new whitelists or a stale skill
  plugin, live gates deny ungrants at once; Codex: app-server restart at idle for MCP, skills 'now'; mock 'now',
  `[mock:config-change]`). Org changes never grant (no grant fields on drafts) and keep ids and grants through
  `setup/orgMerge.ts` mergeOrgChart. Proposal decisions add 'decline' and card-typed MCP `secrets`
  (`proposalSecretKey`), stored in main and never in events (`ProposalOutcome`), and `Proposal.effect`.
  Verified by unit tests, fake query() / fake Codex server tests and the mock (runManagerConfig.test.ts end to end);
  nothing live. The renderer side is the proposal-cards pass (see Renderer below). A grant change also reaches the run's
  own role copies (`runManager.ts` `refreshRoleGrants`: `Role.mcpServers` / `skills` by id, in place, so every adapter
  gate, role lookup and restart sees it; ids and other fields stay, an org change applies from the next run; review M1).
  - Proposal gates (2026-11-02, renderer review): main refuses control, zero-width, bidi and other invisible
    characters (`capabilities/sanitize.ts` `hiddenCharIn` / `hiddenCharProblem`; descriptions are `prose`: tab, line
    breaks, emoji ZWJ, ZWNJ and soft hyphens pass, bidi and zero-width space do not) in every MCP spec string field (`validate.ts` `hiddenCharProblems`, inside
    `validateSpec`, so proposals, library entries and Settings edits alike), in skill proposal name, libraryId,
    draft name and description and role slugs (`skillProposalProblem`), and in allow rules (propose_settings REVISE,
    request_permission_rules "Invalid request", `cleanAllowRules` drops them). `storeProposalSecrets` stores a value
    only for a slot whose serverId the proposal upserts (others dropped with a log warning). Final review fixes: an
    approved redefinition that changes plain env or header names or values clears the stored secrets like a new
    command or URL (`sameLaunch` in mcp/service.ts, `sameTarget` in harnessTools.ts; the tool names the secrets to set
    again) (M2); a name-only toggle or re-grant carries `McpProposalServer.configOnly` (the fields it sets) and approval
    applies only those onto the server as stored then, so a Settings edit made while the card was open survives (L1);
    `SkillService.applyProposal(..., { projectOnly })` refuses scope 'library' on work runs (L3); after
    `DECLINED_PER_KIND_MAX` (3) declined proposals of one kind in a run, further ones of that kind answer DECLINED
    without a card (L6). The SKILL.md body is not checked for hidden characters. Verified by unit tests only.

- Permissions (prompt fatigue, GitHub issue #14; ARCHITECTURE.md "Permissions and prompt fatigue"):
  - Allowed folders: `Project.allowedDirectories` (max 20, 1,024 chars each) are extra folders agents may read and
    edit like the project. ProjectStore drops on save and at boot (`cleanAllowedDirectories`, silent, logged at
    debug): relative, roots, UNC/device, the data dir either way, and through `runtime/allowedDirectories.ts`
    `allowedDirectoryRisk` the project or inside it, a folder containing it, home or above, and home config /
    credential / autorun folders (`HOME_CONFIG_DIRS` in permissionRules.ts: .ssh, .claude, .codex, .config,
    AppData/Roaming, .local/bin, Documents/PowerShell, browser profiles ...). projects:save returns the cleaned list.
    RunManager `resolveAllowedDirectories` repeats the rules at run start on real paths (both spellings of home and
    project) and warns per missing or dropped folder. Claude: `Options.additionalDirectories`; Codex:
    `sandbox_workspace_write.writable_roots`; never on trust-restricted runs.
  - Matching (ruleMatch.ts): `prefix:*` = `prefix *`; a `cd` into the project, a worktree or an allowed folder is
    free (lexical; MSYS `/c/` only for bash; win32 names ending in dot or space refused). Refused: pipes, redirects,
    `$(`, backtick, `&`, newline, unquoted `( ) { }` / `@(` / `@{`, a word-initial `@` only on PowerShell, typographic
    quotes and dashes, hidden characters in a rule or command. `programRunsProgram` (curated table in ARCHITECTURE.md)
    refuses, for every rule, options that run another program or read other config: npm-family `--script-shell` /
    `--node-options` / `--prefix` / `-C`..., go `-exec` / `-toolexec`, cargo `--config` / `-Z`, make `-f` / `SHELL=`,
    dotnet `-p:*Event=`, node `--import` / `-r` / `-e`, git global `-c` / `--git-dir`, `--config`, `--template`,
    `--output`, clone `-c`, branch `-D`, stash drop, and `PROGRAM_ENV` assignments (NODE_OPTIONS, GIT_*...); any `$`
    outside single quotes refuses the segment. `ruleCoversButRefused` says when the Claude hook must answer ask (the CLI
    would approve by its own prefix match); claude.ts does not call it yet (open, reviewer-4 H-A). Only bare
    shells or shells in the exact `SYSTEM_SHELL_DIRS` are unwrapped.
  - Suggestions (permissionRules.ts): per segment, all or nothing, always covering the command; launchers two words
    (podman, nerdctl, kubectl, terraform, helm too), runner words and gh / aws / az / gcloud three; `isTooBroadPrefix`
    (writers, fetchers, config/eval pairs, container run / exec / compose / buildx / container, gh auth / secret,
    npm init / create, uv tool, interpreters) and blanket or destructive rules (git restore too) are never offered or
    saved, and permissions:add refuses them (`permissionAddRefusal`); folder checks fold case on darwin; a provider setMode survives only as acceptEdits. User-configured
    MCP servers get `mcp__<server>`, agent-installed ones exact tool rules. "Always allow for project" saves rules,
    the folders (ctx.allowDirectories) and acceptEdits only from 'default'. Codex file approvals in accept-edits modes
    accept only paths inside the free folders (lexical and real), never `.git` / `.codex` / `.agents` / `.claude`.
    permissions:add / remove inputs are rebuilt (`permissionRuleArgs`, rule <= 1,000 chars).
  - Mock: `[mock:fatigue]` (compound cd + npm test, a sibling-folder edit with setMode + addDirectories, a repeat
    pre-approved after the session grant); in-project edits are pre-approved in acceptEdits only.
  - Verified by unit tests, the mock and e2e/permissions.mjs. Unverified live: additionalDirectories making cds and
    edits free, session setMode / addDirectories from canUseTool, the CLI's per-segment matching agreeing with ours,
    a restarted query picking up new additionalDirectories, Codex writable_roots and its file-approval wire shape.

## Renderer

- Permissions UI (#14; `docs/design/permissions.md`, walk `docs/design/ux-review-permissions.md`): PermissionCard
  glance block `perm-location[data-kind]` (fails closed to "Working folder unclear"), effect sentence, rule chips with
  `data-broad`, a no-rule line, `perm-settings-link` (window event `orgai:project-settings-section`); Settings >
  Agents Allowed folders `allowed-folder-*` (quiet notice for folders main dropped on save); rules panel grammar
  check and kind chips. Helpers `lib/permissionCopy.ts`, `lib/decisionTitle.ts`; e2e `e2e/permissions.mjs` (e2e:free).

- Resizable columns share one width budget (`lib/panelWidth.ts` `panelBudget`): the canvas keeps 280 px (`CANVAS_MIN_PX`); when the side panel minimum (280 px) does not fit it shows as its rail (saved width and choice kept, re-applied when space returns). `SidePanel` `autoCollapseBelow` reacts to first layout and window resizes only, never to handle drags. Resize handles: Enter or double-click resets, arrows move the splitter.

The UI overhaul landed on native elements with container queries. Radix and react-resizable-panels are not installed,
and the frontend-design skill is not vendored in `.claude/skills` (only `run-desktop` is there).

- Cost and usage (#10): every cost goes through `lib/cost.ts` `costView` and `components/ui/Cost.tsx` (unknown is
  never $0, "$0.42+" is a lower bound). The run side panel has a Usage tab (`components/UsagePanel.tsx`, `SideTab`
  'usage'); History switches Runs | Trends (`components/UsageTrends.tsx`, `runs:usageStats`). App settings >
  Connections > Model prices is `components/settings/ModelPricesSection.tsx`; `lib/settingsTarget.ts`
  `requestModelPrice(model?)` deep-links to it with the model pre-filled.
- Layout: `components/layout` (`CanvasFrame` with `FrameToolbar` / `FrameStage` / `FrameTray` / `FrameFooter`,
  `SidePanel`, `SaveIndicator`). Nothing floats over the canvas: decision cards sit in `FrameTray` on the
  `components/DecisionCard.tsx` shell.
- Primitives: `components/ui` (`ConfirmDialog` + `useConfirm` instead of `confirm()`, `Input`, `Textarea`, `Checkbox`,
  `Select`, `SettingRow` and the earlier ones). `IconButton` requires `label`, and `Button` takes `ariaLabel`.
- Shell: sidebar is `BrandLockup` + nav + project list + one 52 px account row (Popover with plan windows) and the gear
  "App settings"; below 1180 px or with Ctrl/Cmd+B it is a 56 px rail (`lib/useSidebarCollapsed.ts`). The topbar is 48 px:
  name, folder name only (`lib/paths.ts`), underline `Tabs` named "Project sections". e2e helpers: `projectTab`,
  `openAppSettings`, `openProject` (via `[data-testid=nav-project][data-name]`); the account row is `[data-testid=auth-pill]`,
  the folder `[data-testid=project-folder]`, run status is read from `.run-tab[aria-selected=true]`.
- Resizable columns: `components/layout/ResizeHandle` is a `role=separator` (vertical, `aria-valuenow/min/max`, focusable) inside the column it resizes, on the edge facing the neighbour, so it never overlaps the canvas. It supports captured pointer drag, Left/Right (16 px, Shift 64 px), Home/End and double-click to reset; `lib/panelWidth.ts` holds the pure clamp/drag/key helpers (tested) and `usePersistedWidth`. Sidebar: 200-420 px (default 232), localStorage `orgai.sidebarW`, App sets `--sidebar-w` on `.app` and the main area keeps at least 480 px; shown only in the full sidebar, not in the rail (the chosen width survives collapse/expand). Right `SidePanel`: 280 px up to whatever leaves the canvas 280 px (no fixed maximum), localStorage `orgai.sidePanelW.<persistKey|default>`, drives `--side-panel-w` on the parent grid (`.editor`, `.run-body`; unset means the CSS default 360 px / clamp(280px, 28cqi, 400px)) and the canvas keeps at least 280 px; hidden while the panel is collapsed. Dragging below the minimum does not snap to the rail. From a measured panel width of 480 px `SidePanel` sets `data-side-wide` on the parent; `.run-body[data-side-wide]` then moves the same `.composer` element (no remount) into the panel column under the transcript. The run frame docks its tray beside the stage only when the tray has content (`.frame-tray:not(:empty)`), else an empty tray column left a blank strip beside the canvas. The account popover's `UsageMeter` has no Refresh button or Updated text: it calls `refreshUsage()` on open when data is older than 60 s, then every 60 s while open (one call in flight, at most one attempt per minute even on failure). A non-current connection gets a section only while it is in use (`connectionInUse` via `lib/usage.ts` `connectionsInUse`) and has a report (`connectionOrder`); stale reports of unused connections neither show nor force a refresh.
- Wide panel: `SidePanel` sets `data-side-wide` on its parent grid at panel width >= `PANEL_WIDE_PX` (480) and clears it below `PANEL_NARROW_PX` (448, hysteresis via `nextWide`). The Live view's canvas refit skips a resize caused by that layout switch. The composer is a container (`composer`) and drops its hint under 560 px; transcript text/user/thinking entries cap at 90ch.
- Dev builds: a package.json version with a `dev` prerelease tag (`0.1.6-dev1`; `lib/buildChannel.ts` `isDevBuild`) shows a quiet info "Dev" Badge beside the wordmark (a "D" pip on the mark in the 56 px rail), `[data-testid=dev-build-badge]`, labelled "Dev build <version>", plus a "Dev build" badge by the version in App settings > About. e2e/layout.mjs expects it whenever package.json says `-dev`; drop the tag for a release. After a release, dev is bumped to `<next patch>-dev1` and the dev number counts up per dev build (`0.1.6-dev1`, `0.1.6-dev2`, ...) until the next release drops the tag.
- Status words come only from `lib/runStatus.ts`: Running, Needs you, Idle, Paused, Finished, Stopped, Failed.
- Run view: one 40 px run strip (`[data-testid=run-strip]`: run tabs plus Interrupt / End session / Org retrospective), then a 32 px canvas toolbar
  (`[data-testid=run-meta]` metadata, Hide finished switch, zoom IconButtons, the legend popover). The tray stacks under the canvas and docks
  beside it only in a frame of 1500 x 560 or more; `section.frame-tray[data-compact=true]` marks a frame under 480 px high.
- "Needs you" counts decisions (cards), never runs: the bell, the Needs-you row, the project row badge and subtitle
  ("3 decisions · 1 run") and the topbar all come from `lib/needsYou.ts` `waitingItems` / `decisionCount`. A run row's dot
  is the run's status. A Needs-you item names the kind and the ask first, then the location, and opens that card.
  A question card shows its options inline at every size (`DecisionCard` `inline`); the tray shows the first open decision.
- Proposal cards (`docs/design/proposal-cards.md`): an org chart card shows a changed role's new prompt ("Show new prompt") and an added role's prompt ("Show prompt") in an `org-diff-prompt` disclosure through `ClampText`/`showHidden` with the hidden-characters badge (review M3; e2e/proposals.mjs); card read errors speak through the frame's one `tray-announce` (`useFrameAnnounce` in `CanvasFrame`).
- Project tabs are Live, History, Org chart and Settings. The org chart editor is `views/OrgChartView.tsx`, and project
  settings are sectioned through `components/settings/*`.
- e2e:free is `e2e/layout.mjs`, `runs.mjs`, `proposals.mjs`, `maintenance.mjs`, `connections.mjs`, `connectors.mjs`, `import.mjs`, `skills.mjs`, `usage.mjs`, `team.mjs` and `assistants.mjs` (package.json). Update selectors in the same change.
- Agent import (renderer): the New project form shows `foundLine` ("Found 2 Claude Code agents and AGENTS.md.") and an "already a project" line from `checkPath` (debounced 300 ms), and with agents present swaps the Architect checkbox for a radio group (`[data-testid=setup-choice]`: import / architect / default; submit "Create project and review import", or "Open <name>" when the folder is already a project, with a secondary "... anyway"). Import creates the project with the default chart and sets `importRequest` in the store; `views/OrgChartView.tsx` then opens `components/import/ImportAgentsDialog.tsx` (mount-only-while-open, re-previews on every choice, always sends the preview digest, ConfirmDialog whenever replacedRoleIds is non-empty on a non-fresh chart; the apply error shows in the footer with Refresh preview and takes focus; `lib/ipcError.ts` strips the IPC wrapper). The Org chart tab has Import agents and Export to repo buttons and, in the `.frame-top` region above the canvas, a "not imported" Banner (remembered in localStorage per project, `lib/agentImport.ts`), the apply notice with Undo (`importNotices` in the store: undo saves `previousRoles` and expires on the first chart edit, comparing against `importedRoles`; the chart is fitted after an import and an Undo) and the export path notice. Project settings > Connection has a read-only "Role models" disclosure. Pure logic and tests are in `lib/agentImport.ts`; e2e is `e2e/import.mjs` (in e2e:free). Not built: a file/folder chooser in the dialog (the contract scans the project folder only), the Architect-setup "sees the agents" note, and a link to Connection settings from the dialog.
- Connectors (renderer): built for 40-60 services (`docs/design/ux-review-connectors-scale.md`). App settings > Connectors (pane id `mcp-library`) is the gallery (`connectors-section`, `connector-tile[data-connector][data-state][data-ease]`, `connector-action`) plus "Custom servers" below; the pane widens that settings column to 1120 px and the grid steps 1 / 2 / 3 columns (560 / 900 px container). A tile is one row (logo, name, method badge `connector-ease` from `connectorEase`: "Sign in", "No sign-in needed", "Paste a token", "Needs your own app"; one clamped line; one button): only "Sign in" and "Add" are filled, "Add token" / "Set up" are outline. Order (`lib/connectors.ts` `sortForGallery`, `gallerySections`): Connected (connectedAt desc, then name), then attention states, then by ease and name; past 24 entries the default view groups under "Easy sign-in" / "Needs a token" / "Needs your own app" and category chips appear. Filter chips (`connector-filter[data-filter]`, `aria-pressed`: All, Connected, Easy sign-in, categories), ranked search (`matchRank`: name, then aliases, vendor, category, description), a polite count (`connector-results-count`) and a no-results card with "Add a custom server". The tile grid is one tab stop (`useRovingFocus`, arrow keys). `requestConnector(id)` (`lib/settingsTarget.ts`, kebab-case ids only) deep-links to a tile: `ConnectorGallery` reads the key on mount or on `orgai:settings-section`, clears search and filters, scrolls, focuses it, sets `data-highlight` for 2 s and announces "Showing <Name>". State label "Not signed in" (was "Needs setup"). `ConnectorDialog` leads per method (`dialogTitle` / `dialogLead`: "Sign in with X" + "Opens your browser. No keys to paste."; "Add X" + "No sign-in needed."; token field first; own app "About 10 minutes, once." with an "I already have a client ID" shortcut that collapses the steps; `connectStep` 'none' makes no authorize call and has no Disconnect) and shows the "not yet tested" note once (`connector-dialog`, `connector-connect` in the footer). Team > Catalog "Add a service" (`AddServiceDialog`, `mcp-add-service`) is a search-first listbox picker (`add-service-search`, `add-service-count`, `add-service-ready` section "Ready to use", `add-service-option`, in-project services say "Manage roles" and jump to their row, one footer row: `add-service-other` with `-assist`, a "Can't find it?" menu `add-service-more` holding `-link` and `-custom`; Easy sign-in is a toggle that combines with a category and All resets both; search also matches the ease words); `connected-service-row`, `connector-use`; `ConnectedServices` folds unused services past 8 behind `connected-more`. Role inspector `role-services` shows brand marks and caps at 5 with "and N more". Plain words only in this path (service, sign in, can read / can read and change). e2e: `e2e/connectors.mjs` (in e2e:free). Walks: `docs/design/ux-review-connectors-2.md`, `-connectors-scale.md`. Not done: Tools sections order / "Services, N connected" count (Team-tab files), the old `.svc-pick*` rules in styles/mcp.css are now unused.
- Skills UI (#11, `components/skills/`, `lib/skills.ts`): Project Settings > Tools is ordered Skills, MCP servers, Plugins (`SkillsSection`, `skills-section`, rows `skill-row`, empty `skills-empty`, buttons `skill-add-library` (primary), `skill-new`, `skill-import`, `skill-evaluate`, notices `skill-notice`). A row whose skill no role can load shows the "No role can load this" badge (`loadableByNoRole`). Every add flow (new, from library, import, apply) uses the shared role picker `SkillRoleAccess` (`skill-role-picker`, `skill-roles`, `skill-role-hint`). Row extras sit in a "More actions for <name>" popover; Promote to library and Unlink end in notices (`promotedNotice`, `skillAddedNotice`). Also `skill-library-missing`, `skill-elevated`. `SkillLibrarySection` is the App settings "Skill library" pane (`skill-library-row`, `skill-library-used-by`, `skill-library-remove-body`); `requestSkillLibrary()` (`lib/settingsTarget.ts`) is the deep link from the project section; its remove ConfirmDialog names the roles per project (`libraryRemoveLines`).
- Skill import and evaluation (renderer): `ImportSkillsDialog` + `SkillImportControls` (`skill-import-item`, `-invalid`, `-duplicate-hint`, `-no-roles`, `-apply-error`). The import banner counts importable and refused skills (`importBannerLine`, remembered per project in localStorage, `skillBannerKey`). Dropped-keys (`skill-import-dropped-notice`) and refused (`skill-import-refused-line`) notes stay after import, duplicates are locked, closing a dirty dialog asks a discard confirm. `SkillEvaluationPanel` is a disclosure (`skill-eval-toggle`, `-heading`, `-last`, `-budget`, `-live`) that stays open while suggestions are unresolved; suggestions (`skill-suggestion`, `-dismissed`) have Apply, Dismiss and Undo; after Evaluate focus moves to the result and a live region announces it (`evaluationAnnouncement`). `RoleSkills` is the role inspector's list (`role-skills`, `role-skill`).
- Team assistant (main): dismissals filter capabilities:recommend too (never sent to the model), a manual Re-check merges with the pending list and the held recommend result instead of replacing it, and under ORGAI_MOCK the first finished run always leaves something pending; the mock recommend answer also picks the mock-home `code-review` skill. Unit-tested only.
- Skills in run views: `TranscriptPanel` + `lib/transcriptRows.ts` `collapseSkillLoads` render one "Loaded skill <name>" row (SKILL.md under "Show instructions"); the matching `load_skill` call row is hidden and `list_skills` rows ("Listed its skills") fold into it. `UsagePanel` has a "Skills loaded" table (`usage-skills`, `usage-skill`). e2e: `e2e/skills.mjs` (in e2e:free).
- Skills UI open items: Promote has no role picker; there is no `promotedFrom` origin field; "Used by" projects are not links; the New project form has no "Found N skills" line; Apply and Dismiss are not covered by e2e (the mock gives no suggestions); per-agent skill counts come from transcript rows (5000-entry trim); A/B replay evaluation is not built; `scripts/smoke-skills.mjs` is unrun and needs consent (spends tokens).
- Assistants (renderer; spec `docs/design/assistants-ui.md`): Chat, MCP assistant and Skill assistant are virtual projects (`quick`, `harness`, `skills`) in a sidebar "Assistants" group above Projects (`nav-assistant[data-id=quick|harness|skills]`, rows share the project-row renderer in `Sidebar.tsx`; rail icons MessageSquare / Plug / Sparkles, the Chat tooltip names Ctrl/Cmd+Shift+N). Store: `virtualProjects` (replaces `harnessProject`; `loadVirtualProject` uses `projects.get(id)`, else `lib/assistants.ts` `displayProject`), `openAssistant(id, { instruction?, fresh? })` (an instruction seeds `assistantSeed`), the exported `openNewChat()` (Ctrl/Cmd+Shift+N in App.tsx, `projects-new-chat`, first-launch `empty-chat-now`), `startQuick`, `startSkillAssist`, `startLibraryAssist(instruction, allowBuild)` (the run opens in place, no window), `promoteQuick` and `handleEvent` 'run.moved' (moves the run between `runs` / `historyByProject` / `activeRunByProject`); `loadAllHistory` covers the virtual ids and `startRun` returns early for them. A virtual project's topbar shows the label, Live and History only, no folder chip. Start pages in `components/assistants/` (`ChatStartPage`, `McpAssistantStartPage` and `SkillAssistantStartPage` on `InstructionStartPage`, `AssistantModelLine`; styles in `styles/assistants.css`): `assistant-start-<id>`, `assistant-instruction`, `assistant-start`, `chat-folder`, `chat-folder-browse`, `chat-folder-clear`, `chat-existing-project`, `chat-open-project`, `chat-team`, `chat-allow-edits`, `chat-summary`, `mcp-allow-build`, `assistant-model-line`. An ended virtual run offers Continue, else `assistant-ended` + `assistant-new-session`; the idle label is `ASSISTANT_IDLE_LABEL` ("Your turn. Reply, ask a follow-up, or end the session."); Needs-you locations use `locationLabel`. Save as project: `SaveAsProjectDialog` (`save-as-project-dialog`, `save-as-project-confirm`), `run-save-as-project` in RunActions (ended runs still in the Chat project only, disabled with a reason for scratch), `history-save-as-project` and `history-folder` in Chat History. Org retrospective only for real projects' work runs (`offersRetro`); kind chips through `runKindLabel` (quick = "Chat"). ProposalCard kind 'skills' (`proposal-skill-item[data-skill]`, `skillsApplyNote`); Defaults > Assistants adds `skill-assist-model-row` / `quick-run-model-row` (`lib/assistantModels.ts` `skillAssistModel` / `quickRunModel`, `ASSISTANT_MODEL_FALLBACK`). Elsewhere: Connectors > Custom servers "Configure with AI" calls `openAssistant('harness')` (`mcp-library-assist-banner` while a run is live); Team > Catalog > Skills `skill-ask-assistant` starts a project-scope Skill assistant run. e2e: `e2e/assistants.mjs` (in e2e:free; 1024x640 and 1600x1000, dark and light, mock): the start pages, sidebar, topbar and Defaults rows are e2e-checked; its run-starting checks (Chat to Idle, scratch Save as project disabled, `history-folder` "Scratch", skill proposal approve) pass on dev against the merged runtime (the orchestrator ran it at 34f6370 and again after 5e2384a); the "SKIP (runtime not merged)" guard only fires when `runs:startQuick` has no handler. Pure helpers in `lib/assistants.ts` are unit-tested.
- Assistants UI after the UX walk (`docs/design/ux-review-assistants.md`, walked 34f6370; fix-up merged at 4ea724f, spec section "Changes after the UX walk"): conversation layout for single-agent runs (`lib/assistants.ts` `isSingleAgentRun`: a Chat with team 'single', 'mcp-assist', 'skill-assist'; `runLayoutFor(summary, chosen?)`, pure, unit-tested). In 'conversation' the stage (`run-conversation`) is the root agent's transcript (`TranscriptPanel variant="conversation"`, `conversation-transcript`), newest at the bottom and kept there unless the user scrolled up (then an in-flow `conversation-jump` "Jump to latest"); the column and the composer are centred at 90ch and the composer stays under the stage even with a wide side panel (`.run-body[data-layout=conversation]` beats `[data-side-wide]`); zoom, legend and Hide finished are hidden; the tray and side panel are unchanged. The toolbar `IconButton` `run-layout-toggle` ("Show agents" / "Show conversation") is on every run, `.run-body[data-layout]` carries the layout, and the pick is remembered per run in the store (`runLayoutByRun` / `setRunLayout`). Sidebar: `lib/assistantNav.ts` `assistantRunToOpen` (pure, unit-tested) opens the run that needs you, else the last viewed live run, else the newest live run, else the start page, never an ended run (ended runs stay in run tabs and History; `settleWorkspace` follows it for virtual ids); `openAssistant(id, { instruction?, fresh? })` with an instruction or `fresh` (New chat / `openNewChat`, Configure with AI `mcp-library-assist`) always shows the start page. After approving a skills or MCP proposal, RunMeta shows a dismissable link (`lib/proposalNext.ts` `proposalNextFor` / `PROPOSAL_NEXT_COPY`, store `proposalNextByRun`): `proposal-next-skills`, `proposal-next-connectors`, `proposal-next-project-skills`, `proposal-next-project-mcp`. Save as project (`run-save-as-project`, `history-save-as-project`) shows only while `offersSaveAsProject` (the run is still in the Chat project); for scratch it is a really disabled `Button` inside `span.run-act-disabled`, which carries the reason as its title. Chat start page: typed path `chat-folder-input` beside Browse (`projects.checkPath`, 300 ms debounce, `chat-folder-error`; an invalid path counts as scratch and Start re-checks); the scratch edits switch stays focusable (`aria-disabled`, separate hint). Copy (`assistantModeLabel`): "Waiting for your answer" while a card is open, else idle "Your turn. Reply, ask a follow-up, or end the session." (`ASSISTANT_IDLE_LABEL`), else "Reply to the assistant" (`speaksAsAssistant`: virtual projects, single-agent chats, project-scope Skill assistant runs); `composerPlaceholder` drops doubled punctuation. The "+" tab and draft tab of a virtual project read "New chat" (Chat) / "New session" (`newSessionLabel`). RunMeta says "unattended" only on real projects' work runs and shows the MCP assistant's `buildWorkspace` (`run-meta-workspace`, full path in the title). History kind filter chips are hidden for the three virtual projects; `.col-folder` ellipsises and narrows under 900 px; `.skill-prop-md` uses the token `--scroll-region-max`; `.new-run` is a size container that tightens under 560 px of height; the build switch reads "Let it build a server in its workspace, in OrgAI's data folder". e2e/assistants.mjs (mock, in e2e:free) checks: the conversation layout shows the mock reply and the composer at 1024x640 without page scroll (both themes), the toggle both ways, the start page from the sidebar after an ended Chat and from Configure with AI after an ended MCP run, the typed-path error and the Save as project flow from a typed folder (gone from the run strip and History afterwards), the "+" tab labels, no "unattended" on Chat / Skill / MCP assistant runs, the disabled scratch Save as project with its reason, no kind chips in Chat History, and `proposal-next-skills` after a library skills approval. `conversation-jump`, `run-meta-workspace` and the connectors / project proposal links are not driven by e2e.
- Assistants UI open items (UI Lead, after 4ea724f): in conversation mode the side panel's Transcript tab duplicates the stage (accepted; the panel is collapsed below 1100 px); `proposalNextByRun` entries are cleared only by Dismiss, and the link is untested at narrow toolbar widths; the scratch edits switch is a local `button[role=switch]` because `components/ui/Switch` cannot take `aria-disabled` (fold it into `Switch` later); the MCP start page cannot name the build folder before the run starts. Not exercised: the native folder picker, the Save as project 'existing' outcome, a default-team Chat in conversation mode, the project-scope `skill-ask-assistant` run. Not addressed from `ux-review-assistants.md`: L3 (Team disclosure wording), L4 ("Stopped" vs "Ended"), L6 (first-launch focus), L7 (brand lockup), L8 (MCP wording in the start page title), and moving focus to a decision card when it arrives.
- Proposal cards (spec `docs/design/proposal-cards.md`, merged at e655838): `components/proposals/*` (`McpProposalBody`,
  `SkillsProposalBody`, `ClampText`, `useCurrent`), `lib/skillProposal.ts`, `lib/proposalSummary.ts`,
  `lib/hiddenChars.ts` (badges hidden characters; main is the gate, see Work-run configuration changes) and
  `styles/proposals.css`. The store keeps `proposalOutcomes` from `proposal.resolved`. Selectors: `proposal-decline`,
  `proposal-decline-note`, `proposal-decline-send`, `proposal-effect`, `mcp-proposal-secret[data-secret]`,
  `mcp-proposal-server[data-change]`, `mcp-proposal-removal`, `proposal-skill-item[data-action]`,
  `proposal-next-secrets`, `tray-announce` and `article.decision-card[data-focus-details]`. At 1024x640 the compact
  frame gives the card the stage; the frame stays compact until 544 px high (`COMPACT_FRAME_HEIGHT` 480 plus
  `COMPACT_EXIT_MARGIN` 64). e2e: `e2e/proposals.mjs` (in e2e:free). Open Lows: switching tray cards drops typed
  secrets and the decline note; the mock has no secret-slot or toggle proposals; the skill link, grant and remove rows
  and the before/after view are not driven by e2e.
- Usage and skills walkthroughs on mock data: `docs/design/ux-review-usage-skills.md` (placement of the usage and skills UI, parts A and B), `ux-review-usage-2.md` (usage UI re-walk) and `ux-review-skills-2.md` (skills UI re-walk at 1024x640 and 1600x1000 in both themes plus a keyboard pass; the native Add from folder picker was not driven).
- Walkthroughs on mock data are in `docs/design/ux-review*.md`. The newest, `ux-review-runs-2.md`, predates the brief A
  run-view merge, so its N1 tray finding needs a re-walk. N2 (run windows miss pending decisions) and the focus and
  wording items are still open.
- Claude Agent SDK facts verified against v0.3.312 (see `scripts/smoke-*.mjs`):
  - `task_started` (system message) arrives before the `SubagentStart` hook and carries `task_id` (= `agent_id`),
    `tool_use_id` of the spawning Agent call, `subagent_type`, `description`, optional `parent_task_id`.
  - The `toolUseID` argument of `SubagentStart`/`SubagentStop` hooks is a hook invocation id, not the Agent tool_use id.
  - Subagent assistant/user messages carry `agent_id` and `parent_tool_use_id`.
  - Subagents run in the background by default; the orchestrator's turn may end (`result`) and auto-resume when a report lands.
  - `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS=1` removes Explore/Plan/general-purpose so only org-chart roles exist.
  - Plan usage (`scripts/smoke-usage.mjs`, Max login): `q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })`
    answers right after init. `rate_limits.five_hour` / `.seven_day` are `{ utilization: 0-100, resets_at: ISO string }`;
    `seven_day_opus` / `seven_day_sonnet` were null and the per-model weekly window came as
    `rate_limits.model_scoped: [{ display_name: 'Fable', utilization, resets_at }]`. A `rate_limit_event` arrives on every
    normal request (status `allowed`); its `resetsAt` is epoch **seconds** and `utilization` a 0-1 **fraction**, and it
    carries an undocumented `unifiedWindows` map. Mapping lives in `src/main/runtime/usage.ts`.
  - In-process MCP tools (`createSdkMcpServer` + `tool` with zod shapes) surface as `mcp__<server>__<tool>` in
    `PreToolUse`, `canUseTool` and `tools` lists. Under `acceptEdits` they still hit `canUseTool`, so the Claude
    adapter auto-allows `mcp__orgai__*`. A handler may block indefinitely; the model receives its returned text.
  - `PermissionMode` includes `'auto'` (a model classifier approves or denies each call and prompts through
    `canUseTool` only when it cannot decide) and `'dontAsk'` (deny anything not pre-approved). Bare `allowedTools`
    entries (e.g. `"WebSearch"`) approve the whole tool before `canUseTool` is consulted (warning
    `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`). Verified in `scripts/smoke-network.mjs` on haiku with a Max login: a whole
    spawn + ListAgents + SendMessage exchange ran under `auto` with zero `canUseTool` calls.
  - `AgentInput.name` injected from `PreToolUse` (`updatedInput`) makes a spawned agent addressable: `ListAgents` lists
    it as `worker-1 [ref] · worker · running`. The SendMessage input seen by hooks is
    `{ to, message, summary, type: 'message', recipient, recipient_kind: 'name' | 'main', content }`. A subagent
    cannot address the root by its role name: the main conversation's address is `"main"` ("No agent named
    'orchestrator' is reachable"). Messages to a report are queued for its next tool round; if it already finished it
    is resumed with the message. `network.ts` maps `main`/`orchestrator` to the root for the canvas.
  - Images (`scripts/smoke-images.mjs`, haiku, Max login): a streaming-input session that starts with a text prompt
    accepts a later user message whose `content` is `[{ type: 'image', source: { type: 'base64', media_type:
    'image/png', data } }, { type: 'text', text }]`, exactly what `claude.ts` `send()` pushes via `userContent()`.
    A 16x16 solid red PNG sent mid-session was answered "Red". Each turn emits its own `init` and `result`.
  - A SendMessage to a finished subagent resumes it, and the SDK emits `task_started` with `task_id` = that agent and
    `parent_task_id` = the messaging agent. A `task_started` for a known agent is therefore a resume, never a re-parent
    (`agentTree.resolveParent`). Observed in a persisted run record on 0.3.312; not yet reproduced by a smoke script.
  - Continuing a run resumes the chain's newest run; RunManager refuses while another live run holds the session.
    Unverified: whether a resumed session reports the same session_id (`forkSession: true` gives a new one); the chain
    therefore follows resumedFrom links and sessionId both (`runManager.sessionChain`). Verified by unit tests only.
- Concurrent runs and cross-run messaging: any number of runs may be live at once (verified by RunManager unit tests on the
  mock adapter). Work-run roots get `list_runs` / `message_run`; RunManager delivers through `RuntimeSession.receive()`,
  framed by `prompts.ts` `peerMessageText` as peer information, never a user instruction. On by default per
  project (`Project.runMessaging`, both ends; an explicit false turns it off), capped per run pair, never for setup-like runs. Unverified: that the Claude
  adapter's notifyOrchestrator delivers a peer message mid-turn (no smoke script). `window:openRun` opens a run-scoped
  window at `#/run/<projectId>/<runId>`; `runs:listLive` lists live runs across projects.
- Setup sessions (`RunSummary.kind === 'setup'`) run the built-in Architect from `src/shared/setup.ts`, never the
  project's roles. Proposals go through `RuntimeContext.requestProposal`; applying them is `src/main/setup/service.ts`.
  - A `PreToolUse` hook answering `permissionDecision: 'allow'` bypasses the permission system in every mode
    (verified in `scripts/smoke-permission-hook.mjs` on haiku under `dontAsk`: the first Bash call was denied, the
    in-process MCP tool got through on the hook alone, and the retried Bash call ran with zero `canUseTool` calls).
    `dontAsk` still runs trivially safe commands such as `echo` without any rule. This is how live permission grants
    work: `request_permission_rules` (every agent) blocks on a card; a grant lands in `RuntimeContext.allowedRules()`
    (saved file rules re-read plus run grants) and the Claude hook allows matching calls through `ruleMatch.ts`,
    so no session restart is needed. `updatedPermissions` can only be returned from `canUseTool`, which the
    classifier never reaches for a call it denies outright.
- Worktree isolation (verified with `scripts/smoke-worktree.mjs`): `isolation: "worktree"` on an Agent call can be
  injected from `PreToolUse` via `updatedInput`. The CLI creates `<repo>/.claude/worktrees/agent-<id>` on branch
  `worktree-agent-<id>` from HEAD, confines Edit/Write to it, and leaves it behind uncommitted when the subagent
  stops. Registering `WorktreeCreate`/`WorktreeRemove` hooks makes the host responsible for creating/removing the
  worktree (the hook must return `worktreePath`), so do not register them just to observe. Commit and merge are
  the harness's job: `src/main/runtime/worktrees.ts`.
- MCP servers added mid-session (`scripts/smoke-mcp-midrun.mjs`, run once on 2026-11-02, haiku, Max login, about
  $0.014; results in its header):
  - In a main-thread `AgentDefinition.tools` whitelist, `mcp__<server>` and `mcp__<server>__*` admit that server's
    tools; `mcp__*` admits nothing (init tools []), and a subagent whose list is only `mcp__*` is refused at spawn
    ("would be spawned with zero tools ... unrecognized [mcp__*]").
  - `Query.setMcpServers` mid-session returns `{ added: [name], removed: [], errors: {} }`; `mcpServerStatus` right
    after shows the server 'pending' with no tools, and the next turn's init shows it 'connected'.
  - Whitelists are exact and fixed per query: with a whitelist that does not name the new server its tools never
    appear in init `tools`, the model is never offered them, and neither PreToolUse nor canUseTool fires. With `tools`
    omitted the new tool appears; the model reached it through ToolSearch, PreToolUse fired (agent_type main), then
    canUseTool (options carry `agentID` and `mcpServer`) and the call ran.
  - A subagent spawned after the add, with `tools` omitted, can call the new server even when its definition says
    `mcpServers: ['alpha']`: `AgentDefinition.mcpServers` does not restrict a subagent to the named servers.
  - Not checked: `reloadSkills()`, `Options.skills` blocking, resume honouring new `agents`, and whether a resumed
    session keeps its session id or `total_cost_usd`.
- Smoke tests cost real tokens (fractions of a cent on haiku). Do not run them in loops.

## Connections, Codex, LiteLLM, MCP and macOS

- Model-agnostic defaults: every default is a tier ('top' | 'deep' | 'everyday' | 'fast', `ModelSetting`) resolved
  through the connection's `tierModels` (`defaults.ts` `modelForTier` / `resolveModelSetting`), never a vendor alias.
  The default chart, `newProject`, built-in roles (fallback 'inherit'), run titles, org chart proposals and the drafter
  (`draft.ts` `toRoles` maps tier names per connection) follow it. Near the plan limit, deep/top spawns move to the
  everyday tier (`Project.preferEverydayNearLimit`; the legacy `preferSonnetNearLimit` is mirrored on renderer saves).
  Verified by unit tests.
- Model discovery: Anthropic via `ClaudeAdapter.listModels` (SDK `supportedModels()`, typings 0.3.312 sdk.d.ts:3096,
  no prompt, `strictMcpConfig`, 10 s timeout). The live list (whether it has 'default', which ids, descriptions that
  feed `catalog.ts` `tierFromDescription`) is UNVERIFIED: `scripts/smoke-models.mjs` (token-free, spawns the CLI)
  has not been run. Anthropic `/v1/models` is not used. The scheduled refresh and autoTiers are unit-tested only.
- Community prices (LiteLLM's public JSON) are unit-tested with a fake fetch; the live JSON shape is unverified.

Each fact says how it was checked. "Unverified" means it comes from docs or typings and no live run has confirmed it.

- Connections and adapters are separate. The connections are `anthropic`, `openai` and `litellm`, and the adapters are
  `claude` and `codex`. `adapterForProject` (`src/shared/defaults.ts`) picks the adapter from the connection, or for
  LiteLLM from the root role's model family. A work run whose roles mix families is refused before the run exists.
  `ConnectionService.runConnection` builds the per-run `RunConnection` (env, API key, Codex home). Verified by unit tests.
- Default connection: `projects:create` passes `ConnectionService.prepareNewProject` to `ProjectStore.create`. A new
  project takes `AppSettings.defaultConnection` when `creationConnection` (`defaults.ts`) finds it usable (anthropic
  always, openai when enabled, litellm when enabled with a base URL and a stored key) and the connection maps every
  tier the roles use; otherwise it stays on anthropic. It gets that connection's provider label, tier models (the
  'switched' remap) and adapter. Mock projects and existing projects are untouched. Verified by unit tests.
- Child env isolation (`src/main/runtime/childEnv.ts` `isolateClaudeEnv`, used by claude.ts `buildEnv`,
  `completionEnv` and `probeUsage`, and by `claude auth status`): the inherited env loses every routing, model,
  gateway and cloud-provider variable (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL`,
  `ANTHROPIC_SMALL_FAST_MODEL`, `ANTHROPIC_DEFAULT_*`, `CLAUDE_CODE_SUBAGENT_MODEL`, `CLAUDE_CODE_USE_*`,
  `ANTHROPIC_{BEDROCK,VERTEX,FOUNDRY,AWS}_*`, `ANTHROPIC_CUSTOM_HEADERS`, `ANTHROPIC_BETAS`, `ANTHROPIC_PROFILE`,
  the workload-identity family `ANTHROPIC_{IDENTITY,SERVICE_ACCOUNT,WORKSPACE,FEDERATION}_*`,
  `ANTHROPIC_ORGANIZATION_ID`, `ANTHROPIC_UNIX_SOCKET`, `AWS_BEARER_TOKEN_BEDROCK`, `CLOUD_ML_REGION`,
  `VERTEX_REGION_*`, `CLAUDE_CODE_SKIP_*_AUTH` and every `CLAUDE_CODE_{DISABLE,ENABLE}_*` behaviour switch). Only the
  connection's env (or OrgAI's own settings, merged after isolation) sets them. The bundled CLI of SDK 0.3.312 names
  about 80 `CLAUDE_CODE_DISABLE_*` and 30 `CLAUDE_CODE_ENABLE_*` switches (grep of the SDK package): gateway and
  API-surface ones (`DISABLE_EXPERIMENTAL_BETAS`, `DISABLE_ADAPTIVE_THINKING`, `ENABLE_GATEWAY_MODEL_DISCOVERY`, `ENABLE_FINE_GRAINED_TOOL_STREAMING`, `ENABLE_PROXY_AUTH_HELPER`,
  `DISABLE_AUTH_REFRESH_LOCK`, `ENABLE_XAA`, `DISABLE_LEGACY_MODEL_REMAP`...), feature toggles and terminal UI ones
  (`DISABLE_MOUSE`, `DISABLE_TERMINAL_TITLE`...) that a headless SDK run does not need. OrgAI sets none of them
  (it sets only `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` / `_MAX_CONCURRENT_SUBAGENTS`, and on work runs
  `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS=1`, added after isolation). The explicit allows
  (`CLAUDE_CODE_ALLOWED_SWITCHES`) are `CLAUDE_CODE_ENABLE_TELEMETRY` (an organisation's OpenTelemetry opt-in;
  `OTEL_*` passes through) and the privacy opt-outs `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` and
  `CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY`. Kept as
  legitimate Anthropic auth sources: `CLAUDE_CODE_OAUTH_TOKEN` (and its refresh token) and `CLAUDE_CONFIG_DIR`.
  `ANTHROPIC_API_KEY` reaches a run only on the anthropic connection for an API-key project, through
  `RunConnection.env` (copied from the project's `auth.envVar`), so run titles get it too; `buildEnv` also copies
  the inherited `auth.envVar` value for a non-proxy API-key project. On LiteLLM the inherited
  API key, OAuth token (and refresh token) and `CLAUDE_CONFIG_DIR` (it holds the claude.ai login) are dropped, so
  only the connection's `ANTHROPIC_AUTH_TOKEN` authenticates. Drafts (no connection) keep an inherited `ANTHROPIC_API_KEY`. Verified by unit tests only; the
  bundled CLI's actual auth choice with this env has not been checked in a live run.
- Anthropic status (`anthropicAuth.ts`), checked token-free on the bundled CLI 2.1.312 (SDK 0.3.312) with a temp
  `CLAUDE_CONFIG_DIR`:
  - `claude auth status --setting-sources project` is rejected (unknown option); the global form
    `claude --setting-sources project auth status` is accepted. Verified.
  - With an `env.ANTHROPIC_AUTH_TOKEN` in the config dir's `settings.json`, plain `auth status` reports
    `loggedIn: true, authMethod: 'oauth_token'`; with `--setting-sources project` it reports `loggedIn: false,
    authMethod: 'none'` and exits 1 with the JSON still on stdout. Verified.
  - `authMethod` values seen: `claude.ai` (a /login), `oauth_token` (`CLAUDE_CODE_OAUTH_TOKEN` or an
    `ANTHROPIC_AUTH_TOKEN` env, indistinguishable), `api_key` with `apiKeySource`, `none`. Verified.
  - The project settings source reads `<cwd>/.claude/settings.json`, so the status runs in `os.tmpdir()`, never the
    home dir. The bundled CLI is tried first (execFile), then PATH candidates found by `execFile(<SystemRoot>\System32\where.exe,
    ['$PATH:claude'])` (PATH only, never the cwd) / `execFile('which', ['-a', 'claude'])`, both in the temp dir with
    no shell and absolute paths only, plus the well-known install
    paths, with no bare `claude` fallback (nothing found reports "Claude Code CLI not found" with the places
    looked). A shell is used only for Windows .cmd/.bat shims without metacharacters; a CLI that rejects the flag is retried without it and its detail says user
    settings could not be excluded. The disconnected detail tells the user to run claude and /login, set an API
    key, or choose another default connection. Wiring is unit-tested with an injected runner.
- Auth failures in a run: `activity.ts` `isAuthFailure` and `authFailureMessage(connection)`. A failure is the SDK
  assistant `error: 'authentication_failed'`; the exact bare CLI reply "Invalid API key · Please run /login"
  (separator `·`, `-` or `.`, nothing else in the text), the only text match without an error flag; short text that
  starts with the CLI's wording ("API Error: 401", "OAuth token has expired"...) when the adapter reports an
  auth-related error (`isError`; a non-auth `errorCode` alone never counts); or auth words / 401 / unauthorized anywhere only with `isError`. The Claude
  adapter sets `isError` on an assistant message only for the codes in claude.ts `AUTH_ERROR_CODES`
  (`authentication_failed`, `oauth_org_not_allowed`, `cloud_credential_error`), never for rate_limit or
  billing_error, and on a result from `is_error`. The Claude adapter then ends the run
  `error` with that one-line message, writes a harness system row whose detail is the scrubbed raw text, and
  `complete()` throws it. `[mock:auth-fail]` drives the mock the same way. The live failure shape is unverified
  (from the 0.3.312 typings and the user's report).
- Codex (`@openai/codex` 0.166.0):
  - `codex app-server` speaks JSON-RPC over stdio, one object per line. The `jsonrpc` field is not needed. The
    client sends `initialize` and then `initialized`. Verified offline against `generate-json-schema` /
    `generate-ts --experimental` (token-free).
  - OrgAI uses its own `CODEX_HOME` at `<data>/codex`, so the user's `~/.codex` config and MCP servers never load.
    Config goes in as `-c key=value` TOML overrides. An API key travels only in the environment
    (`model_providers.orgai.env_key`), never in argv. Verified by unit tests (`codexProtocol.test.ts`).
  - Concurrent Codex runs share that one `CODEX_HOME` at `<data>/codex` (`src/main/connections/service.ts`), each
    with its own app-server. Whether they race on auth refresh or the session database is unverified.
  - `CodexAppServer.start` creates `CODEX_HOME` (mode 0o700) before spawning (issue #8). Verified token-free by
    fake-server unit tests; that codex 0.166.0 exits 1 on a missing dir was verified by the user. Exit errors
    (`codexExitMessage`) carry a redacted stderr tail (last 10 lines, 2,000 chars; exact env values redacted plus
    `maskKeyLike`). Still unverified: whether a LiteLLM proxy serves `/v1/responses` for GPT models.
  - Harness tools are `dynamicTools` on `thread/start`, answered through `item/tool/call`. `update_plan` collides
    with a built-in Codex tool, so it is exposed as `orgai_update_plan`. Subagents are threads started by the
    harness's own `spawn_agent` tool. Unverified: the wire shapes come from the schema, and `scripts/smoke-codex.mjs`
    (spends tokens, consent required) has not been run.
  - It is unverified that dynamic tools survive `thread/resume`. The adapter's MCP restart and run continuation
    assume they do.
  - The ChatGPT login (`account/login/start` with `chatgpt` / `chatgptDeviceCode`), `model/list` and
    `account/rateLimits/read` are unverified (schema-derived). The device-code `expiresAt` field is a guess and
    is optional.
  - The idle Codex plan-usage probe (`probeCodexUsage`: boot, idle, usage:refresh) runs only while the openai
    connection is in use (`connectionInUse` in `src/shared/defaults.ts`: the default connection or a project on it),
    and never spawns the app-server otherwise; live Codex runs still report their own usage. Unit-tested.
- LiteLLM: `/v1/models` and `/model/info` discovery is unverified against a live proxy. The Claude adapter reaches
  LiteLLM through `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` and maps tiers through
  `ANTHROPIC_DEFAULT_{FABLE,OPUS,SONNET,HAIKU}_MODEL`. The Codex adapter reaches it with an `orgai` model provider at
  `<base>/v1`. Both routes are unverified at runtime: `scripts/smoke-litellm.mjs` is free without `--yes` and spends
  tokens with it.
  - Key spend: `ConnectionService.probeLiteLLMUsage` reads `GET {base}/key/info` (the key only as Bearer/x-api-key,
    no `key` param, `redirect: 'error'`, 10 s) through `litellm.ts` `parseKeyInfo` into `UsageStatus.spend`
    (`connection: 'litellm'`, `authMode: 'apiKey'`, no provider). Gated on enabled + base URL + stored key + in use
    (`connectionInUse`: the default connection or a project on litellm); any failure
    (500 without the proxy DB, 403, junk) is null. It is a keyed `UsageMonitor` extra probe ('litellm', boot / idle /
    usage:refresh), and index.ts re-reads it 15 s after a LiteLLM run ends (`RunSummary.connection`). Only the key's own
    budget is read, never a team budget. The renderer must keep the latest usage report per `connection`.
  - Run cost: `/model/info` `model_info.{input,output}_cost_per_token`, `cache_read_input_token_cost` and
    `cache_creation_input_token_cost` become `ProviderModel.price` (+ `upstream` = litellm_params.model) in models.json;
    `runConnection` passes them as `RunConnection.pricing` (`pricing.ts` `pricingFromCatalog`, `priceFor` matches
    exact, normalized, then version-suffix-only). Claude prices each message from it (falls back to the CLI's rates for
    an unpriced model; `run.cost` = sum of agent costs) and Codex prices thread totals (`openAiMix`: input includes
    cached). These adapter estimates now only feed the legacy `AgentInstance.costUsd` / `run.cost`: RunManager
    re-prices every agent (see Usage and pricing above), and an unpriced model is unknown, not 0. The `/key/info` shape and the price fields are unverified against a live proxy
    (source-read only), as is which model name the proxy reports on messages and whether a resumed Codex thread's
    token totals include the earlier run. Prices appear only after the next discovery (connect or models refresh).
- MCP:
  - Claude runs set `strictMcpConfig`, so only the project's enabled servers plus run-scoped installs load (this
    also stops plugin-declared MCP servers).
  - Mid-run installs (2026-11-02): `request_mcp_install`'s result follows the adapter hook's `McpAttachResult`
    (`harnessTools.ts`: `{ prefix, availability: 'now' | 'after-idle', tools? }`). 'now' (mock) says "Its tools are
    available now as mcp__<name>__<tool>..." (tool names `datum`-quoted, at most 20); 'after-idle' (Claude, Codex) says
    they become callable only after the current turn ends and the harness will message the orchestrator once they are
    attached. Both add that calls may still ask the user for permission under the project's permission mode (nothing is
    auto-allowed on approval) and name the roles when the card restricts `roles`. Claude: `addMcpServer` calls
    `Query.setMcpServers` at once (errors surface immediately), reads tool names from `mcpServerStatus` (up to 5 s),
    and because whitelists are fixed per query (smoke facts below) re-creates the query with `resume` and agent
    definitions rebuilt from the live `ctx.mcpServers()` once the root is idle and no report, background task or card
    is open (`mcpRestartBlocker`), then sends `mcpAttachedNotice` through `notifyOrchestrator`. Codex restarts its
    app-server at idle (unchanged, now reported 'after-idle'). Verified by unit tests (fake `query()`) and the mock
    (`[mock:mcp-midrun]`, `mcpMidrun.test.ts`); the resume restart itself has never run live.
  - Claude restart details after the review fixes (7cc7e3b, 5ee83e5; each unit-tested in claude.test.ts with a fake
    `query()`, none run live):
    - Turn end (H1): a successful turn end with a restart pending and no blocker is withheld from the
      ContinuationDriver (`onTurnEnded`), so no plan nudge starves the restart; the attach notice wakes the
      orchestrator. If the restart is blocked, has no budget, fails while building options or throws, `releaseTurnEnd`
      hands the held turn end to the driver, so the run never stalls.
    - Notice (M1): server tool names are untrusted; only `^[A-Za-z0-9_-]{1,64}$` names are kept (`safeMcpToolNames`),
      at most `MCP_NOTICE_TOOL_CAP` 20 per server plus ", and N more", and server, tool and role names go through
      `datum()`. The could-not-attach notice quotes names and reason through `datum()` too.
    - Budget (M2): a restarted query gets `maxBudgetUsd` minus the run's cost so far; with less than
      `MCP_RESTART_MIN_BUDGET_USD` 0.01 left there is no restart (N7), a run warning, and the orchestrator is
      told the server comes with the next run. Whether the SDK counts the earlier cost against `maxBudgetUsd` on a
      resumed query is unverified.
    - Background tasks (M5): non-subagent tasks from `task_started` (ambient and `skip_transcript` ones excluded) are
      tracked until `task_notification` or `task_updated` completed / failed / killed; they block the restart
      (`McpRestartState.backgroundTasks`, blocker 'background tasks are still running') and the last one to end
      re-schedules it. Field shapes from the 0.3.312 typings only.
    - Failed starts (M4): the failure count resets at a restarted query's init. Failures before init: the 1st resumes
      again with the same servers, the 2nd resumes without the new servers (`droppedMcp`, the orchestrator is told), the
      3rd or no budget ends the run `paused` (never error; a throw from `buildOptions` inside `recoverRestart` counts as
      one more failed start, M2) with `pausedUntil` `MCP_RESTART_PAUSE_MS` (5 min) ahead, a
      `pauseReason`, `autoResume: !(held || capTripped)` (N1: an interrupted run waits for the user; RunManager schedules no resume for `autoResume: false`, runManager.test.ts; it gets no
      `pausedUntil`), an error log line and a harness transcript row. A user message that never reached a query that
      sent init (`undeliveredUserMessages`: in `preInit` or unread, harness messages excluded) also makes it
      `autoResume: false`, and the pauseReason adds "Your last message was not delivered; send it again to continue."
      (M1: never replayed, so it cannot arrive twice and RESUME_TEXT never replaces it; a peer message in `preInit` is
      dropped silently). The attach-notice fallback's error log line goes through `redactSecrets` (L3). Each new query gets a fresh input stream; after a
      failed start `replayInput` fills it with every message pushed before the dead query's init (`preInit`, cleared at
      init) plus any unread ones, each once, leaving out notices flagged `restart` because the next query sends them
      again (N2).
    - Pending list (L1): servers leave `pendingMcp` synchronously when the restart starts; their tool names travel with
      it as the notice's fallback.
    - Held runs (L7): before a restarted query starts, a run held by an interrupt or the window cap drops its queued
      plan nudges; other queued harness notices, and an attach or could-not-attach notice arriving while held, are
      delivered with the user's next message.
    - Second review (2026-11-02; N1 and N2 above, all unit-tested only, none run live): a rejected `announceAttached`
      logs a warning, sends a fallback notice with the known tool names (`mcpAttachedNotice` with `roles` undefined
      reads "Only roles the org chart grants it may call it.") and always calls `releaseTurnEnd` (N4). `restartBudget`
      returns null (no restart, the no-budget path) when less than `MCP_RESTART_MIN_BUDGET_USD` is left, so a
      restarted query never gets more than what is left (N7). The request_mcp_install result lists tool names through
      harnessTools.ts `safeMcpToolNames` (twin of claude.ts's, same `^[A-Za-z0-9_-]{1,64}$` rule, keep them in sync)
      with `datum(t, 64)` (N5, harnessTools.test.ts). Third check fixes M1, M2, L3 (6327506, unit-tested
      only, none run live). Open: N3, N6, N8 and the third check's L1, L2, L4 (ARCHITECTURE.md Risks).
  - Per-role MCP grants (`mcpGrants.ts` `mcpCallDenial`): the Claude PreToolUse hook (and the mock) checks every
    `mcp__<server>__<tool>` call against `mcpServersForRole` over the live server list (run-scoped installs and the
    card's `roles` included), root included, before any allow path; unknown callers and unknown or disabled servers
    are denied with a reason naming the role and server. It also enforces `mcp__orgai__*` audiences. The caller's role
    comes from one `callerRole` helper shared with the Skill gate: the hook's `agent_type` first, then the role
    recorded for the agent id (L5; this changed the Skill gate's order). The live list is read only for `mcp__` and
    the resource tools, in try/catch, and an unreadable list denies the call (L2). Resource tools (L3,
    `MCP_RESOURCE_TOOLS`: ListMcpResourcesTool, ReadMcpResourceTool, ReadMcpResourceDirTool; names from the 0.3.312
    typings, unverified live): a named `server` goes through the same per-role check (`orgai` allowed), a read without
    a server is denied, and a list without a server is allowed only when the role is granted every enabled server.
    This is the only grant boundary on Claude: `AgentDefinition.mcpServers` does not restrict a subagent (smoke,
    below). Codex does NOT enforce per-role MCP grants (every thread shares the app-server's servers; review M6,
    open). Unit-tested (claude.test.ts, mcpGrants.test.ts); the mock has the resource-tool gate too (mock.test.ts).
  - Agent-installed servers and server-level rules (M3): "installed this run" is every server an agent asked for
    through `addMcpServer` plus every live server with source 'agent' absent at run start (`agentInstalledServers`).
    For those, server-level rules are skipped in the hook's rule-allow path and dropped from `options.allowedTools` on
    every options build (`withoutServerRules`); exact single-tool rules still apply. The mock does the same (its only
    other parity with these fixes is L3; it attaches at once, so it has no restart). NOT covered: `mcp__<server>` allow
    rules the CLI loads itself from `<project>/.claude/settings.json`, and server-level session rules the CLI adds
    from an "always allow" suggestion. The mock filters its own session rules too (`sessionRules` in its ask path), so
    mock tests are stricter than Claude here. Unit-tested (claude.test.ts, mcpGrants.test.ts, mock.test.ts).
  - Server-level permission rules (`ruleMatch.ts` `mcpServerOfRule`, `matchingRule`): `mcp__<server>` and
    `mcp__<server>__*` match every tool with the exact prefix `mcp__<server>__` (a server name with `__` inside is not
    a server rule); `mcp__*`, other wildcards, `mcp__orgai` and `mcp__orgai__*` are refused by `isValidRule` and
    `isUnsafeAllowRule`. `permissionRules.ts` `ruleLabel` reads both forms as "All tools of <server>" (the rules card
    still shows raw strings). Unit-tested.
  - Skills have no mid-run path: `active.skills` is read once at run start and the Claude skill plugin is built once
    in `prepare()`, before the first query (a restart reuses it), so a skill added or granted during a live run reaches only the next run.
    `Query.reloadSkills()` / `reloadPlugins` exist in the 0.3.312 typings and are untested.
  - `request_mcp_install` needs exact pinned versions and the user's approval. A denial tells the agent to find
    another route. The calling agent's id reaches `McpInstallRequest.agentId`: Codex derives it from the thread, and
    Claude reads it from the PreToolUse `agent_id`. Claude matches the MCP call by a tool_use id in `extra._meta` if
    present (the key is unverified), otherwise first-in-first-out per tool name. Verified by unit and mock tests.
  - Registry search hits `https://registry.modelcontextprotocol.io/v0.1/servers`. The shape is unverified live,
    the tests use a fixture, and registry content is untrusted data.
  - `mcp:test` (`src/main/mcp/probe.ts`) runs initialize + tools/list without a run. It covers stdio and streamable
    HTTP but not legacy SSE. Verified by a stdio fixture server and fake-fetch tests.
  - Secret values live only in `SecretStore` (Electron `safeStorage`, `<data>/secrets.json`). They never cross IPC
    and are redacted from probe errors. `projects:save` (`saveFromRenderer`) keeps the stored `mcpServers`/`plugins`.
  - A server with any unset `secretEnv` / `secretHeaders` slot never starts: `McpService.enabledServers` skips it and
    `skippedServers` feeds one run warning per server naming the empty slots (RunManager `prepareServers`). Unit-tested.
- MCP library and OAuth:
  - The app-wide library lives in `<data>/mcp-library.json` (`McpLibraryStore`). A project server with `libraryId` is a
    link: McpService refreshes its snapshot from the entry on every read (`withLibrary`, `list`, `enabledServers`,
    `resolve`), its secrets and tokens are the entry's, and a link whose entry is gone is kept but never passed to runs.
    Secret keys: project `mcp:<projectId>:<serverId>:{env|header|oauth}:<name>`, library `mcplib:<entryId>:...`.
    Verified by unit tests.
  - OAuth (`src/main/mcp/oauth.ts`): RFC 9728 discovery from the 401 `WWW-Authenticate`, RFC 8414 / OIDC metadata,
    a user-entered client id first, then DCR, else `needsClientId`; PKCE S256, RFC 8707 `resource`, a one-shot
    loopback redirect on 127.0.0.1, refresh with rotation (a missing refresh_token is tolerated). DCR sends
    `application_type: 'native'`. RFC 9207: the callback's `iss` is compared exactly with the metadata `issuer` (else
    the AS URL) before the code exchange; missing `iss` is refused only when the metadata advertises
    `authorization_response_iss_parameter_supported` (`OAuthDiscovery.issuer` / `issParameterSupported`,
    `waitForCode` returns `{ code, iss? }`). No CIMD yet. Verified only with fake fetch and the real loopback in
    unit tests; no live authorization server has been used.
  - The host injects `Authorization: Bearer <access token>` into resolved headers. Unverified: that the bundled
    CLI's undocumented `oauth` block in mcpServers passes through from SDK options (not used); that GitHub's hosted
    server (`https://api.githubcopilot.com/mcp/`) accepts a token from a user's own GitHub OAuth app; how Codex's
    own MCP OAuth behaves when `bearer_token_env_var` is set.
  - Runs refresh tokens that expire within 5 minutes before they start (`prepareForRun`). A server that is still not
    authorized starts without credentials and the run logs a warning. Mid-run re-authorization is out of scope: the
    user authorizes in Settings and the next run picks it up.
  - Harness-level runs (the library MCP assistant) use the virtual project `HARNESS_PROJECT_ID` ('harness', built by
    `harnessProject()` in `mcp/assist.ts`, never stored). Only `mcp-assist` runs may use it.
  - Hardening: install-card edits are allowlisted onto the agent's spec and cannot reuse an existing id; a run-scoped
    server never reads stored secrets. OAuth bearers are injected only when `oauth.resource` matches the server URL.
    The loopback callback ignores (400) any request whose state does not match exactly. OAuth fetches never follow
    redirects and refuse private-IP literals (no DNS check). A connector preset's issuer is enforced
    (`oauth.ts` `presetIssuerFailure`): an issuer-only preset (Asana, HubSpot, Box, Zoom) refuses a sign-in whose
    discovered issuer differs (trailing slash aside) or whose authorization, token or registration endpoint is off the
    issuer's domain, before any secret is sent; a preset with endpoints (Slack 'fallback') falls back to its own
    endpoints when the discovered issuer is off its domain; 'replace' (Google) skips discovery. "Domain" is the last
    two DNS labels (`registrableHost`, no public-suffix list), so preset issuers must be simple vendor hosts, never
    under a multi-label suffix such as co.uk. All of this is unit-tested only; no live sign-in has checked it.
- Connectors (`src/shared/connectors.ts` catalog, `src/main/mcp/connectors.ts`, `McpService.connectors*`): curated
  presets for official remote MCP servers that become library entries (`McpLibraryEntry.connectorId`, written only by
  `connectors:add`, which is idempotent and takes only `{ connectorId, variant? }`; because it is idempotent, switching
  a keyless entry such as Exa or Context7 to its key variant means removing the entry first). IPC `connectors:list`
  (`ConnectorInfo`), `connectors:add`, `connectors:setToken` (token connectors; prefix added in main); ipc.ts
  `connectorArgs` rebuilds both inputs (kebab-case ids at most 64 chars, a token string of at most 4,000 chars or null,
  every other shape refused, extra fields dropped; `ipc.test.ts`); everything else
  reuses mcp:* / mcpLibrary:*. `oauthClient` connectors (Google, Slack) use the user's own client and the fixed
  redirect `http://127.0.0.1:38917/callback` (`CONNECTOR_REDIRECT_URI`, strict listen, no ephemeral fallback).
  ORGAI_MOCK=1 makes connector authorize/test network-free (mock@example.com, fake tools); the stand-in token is
  ignored outside mock mode. Unverified, every preset (`verified: false`): Google accepting a 127.0.0.1 redirect on a
  Web application client and ignoring a missing `resource`; Slack accepting an http loopback redirect at all (its docs
  say HTTPS), the `oauth.v2.user.access` response shape and the scopes it needs; DCR plus loopback on Notion, Linear,
  Sentry, Stripe, Figma and Atlassian (admin allowlist); GitHub's `X-MCP-Readonly` header. Unit-tested only.
  - Contract (2026-10-31): `ConnectorDef.aliases` (lowercase search words; `connectorMatches(def, query)`), 17
    categories (`CONNECTOR_CATEGORIES`; added crm, data, cloud, knowledge, automation, commerce, meetings), auth kind
    `{ kind: 'none' }` (no secret slot, no OAuth; connected once added; mcp:authorize answers `notRequired` without a
    flow, connectors:setToken refuses), `connectorEase(def, variantId?)` -> `ConnectorEase` 'none' | 'signIn' (oauth)
    | 'token' | 'ownApp' (oauthClient) with `EASE_ORDER` / `easeRank` (none first), every `defaultVariant` is its
    easiest variant (test), and `McpLibraryEntry.connectedAt` (epoch ms; main-only: set on authorize success, token
    set, or add of a 'none' preset; cleared by revokeAuth, token null, or losing the connector; stripped from renderer
    writes and linked specs; malformed values dropped on read) surfaced as `ConnectorInfo.connectedAt` only while the
    card is 'connected'.
  - Catalog (41 entries): added Google Docs, Sheets, Slides, Chat (People omitted), Intercom (US/EU), Supabase
    (read-only `?read_only=true` default), DeepWiki and Exa (keyless 'none' default; Exa also an `x-api-key` token
    variant), Cloudflare (oauth + token), Datadog (US1, EU1, US3, US5, AP1), Vercel (reviewed clients only), Asana,
    HubSpot, Box (oauthClient), PayPal (live/sandbox, oauth best effort). Second wave (2026-10-31): Microsoft Learn,
    AWS Knowledge (none), Context7 (keyless 'none' default plus a Bearer key variant), Granola, Neon (read-only
    `?readonly=true` default, full, API key), Amplitude (US/EU), PostHog, Webflow, Miro, GitLab (gitlab.com only)
    (oauth), Zoom (oauthClient, issuer `https://zoom.us`), Zapier (Bearer connection token). A "Not yet" comment at
    the end of the catalog lists vendors left out and why. Every oauthClient preset sets `overrides.issuer` (Asana
    `https://app.asana.com`, HubSpot `https://mcp.hubspot.com`, Box `https://api.box.com`, Zoom; Google and Slack
    carry endpoints); these issuers come from the probe, unverified in a live sign-in. Stripe's key variant is an
    "Agent API key" (Dec 2026 rule); Google setup names the Developer Preview Program and the "Use this client for an
    AI-powered agent" box; Slack notes say no DCR and Marketplace/internal apps only. `status` labels of the new
    entries are unverified. New ids are in renderer `BRAND_GAPS` until their marks are sourced.
  - Probe (`scripts/probe-connectors.mjs`, `npm run probe:connectors`; `--list` parses the catalog without network,
    `--only a,b`, `--out file`): token-free but network-using, so it needs the user's consent each time it runs. It
    POSTs an unauthenticated JSON-RPC initialize to every http variant, follows a 401's `resource_metadata` to the
    RFC 9728 and RFC 8414 / OIDC metadata and reports DCR, CIMD, PKCE methods, the RFC 9207 iss flag, scopes and, for
    'none' variants, whether initialize answered 200 (no credentials, no redirects, 10 s, 64 KB, JSON only, public
    https hosts only after DNS, 6 in flight). Run once on 2026-10-31 (`docs/connector-probe-2026-10-31.json`):
    every oauth entry advertises DCR; CIMD: Notion, Linear, Sentry, Cloudflare, Atlassian, Vercel, Granola, Neon,
    Amplitude, PostHog; iss: Notion, Linear, Sentry, Figma, Supabase, Cloudflare, Neon, Google; DeepWiki, Exa,
    Microsoft Learn, AWS Knowledge and Context7 answer initialize 200 without a key; Datadog US3/US5/AP1 and the
    Google Docs/Sheets/Slides/Chat hosts answer; Slack's metadata issuer is `https://mcp.slack.com` (the preset's
    slack.com endpoints are the fallback only); Zoom's resource metadata names `https://mcp.zoom.us/...`, not the
    documented URL; PayPal's POST /http answers 404, not 401, though resource metadata exists. Advertised metadata
    only: no sign-in was attempted, so DCR plus loopback acceptance is still unverified everywhere.
- macOS is untested; nobody has run it on a Mac yet (`docs/macos-testing.md` is the checklist).
  - `applyShellPath()` runs right after `installLogging()` and merges the login shell's PATH with well-known dirs.
    GUI launches otherwise miss Homebrew, nvm and similar.
  - `listClaudeBinaries` also tries `~/.claude/local/claude`, `~/.local/bin/claude`, `/opt/homebrew/bin/claude` and
    `/usr/local/bin/claude`.
  - The app menu is installed on darwin only. Closing the window keeps the app running, and `activate` re-creates
    the window.
  - These pieces are unit-tested where they are pure. Packaging (`dist:mac`, `dist:mac:unsigned`,
    `build/entitlements.mac.plist`) is unverified.
  - `ORGAI_DATA_DIR` replaces userData and puts the logs under it. e2e (a fresh temp dir per script) and CI use it to
    keep off the real profile. Since 18070b8 the e2e scripts ignore an ambient `ORGAI_DATA_DIR` (`E2E_DATA_DIR` is the
    override): CI's one shared dir let connections.mjs's leftover library entry open a different dialog in team.mjs.
    package.json `productName: "OrgAI"` names the packaged app (`app.name`, log dir).
  - The `pathKey` symlink fix (macOS `/tmp` is `/private/tmp`) and the OrgAI identity fallback for commit and merge are
    unit-tested with a junction/symlink and a git that has no identity config.
  - CI (`.github/workflows/ci.yml`) runs on windows-latest and macos-14. Release legs run on native-arch runners
    (macos-14 arm64, macos-15-intel x64). Nothing in CI spends tokens.
  - Branches: `dev` is integration (agent runs, PRs, dependabot), `main` is stable and protected. CI runs on both;
    `release.yml` only releases `v<version>` tags whose commit is on `main`.
  - The first real CI run has not happened yet. Open items: winCodeSign extraction on windows-latest, macos-15-intel
    really being x64, e2e:free on mac (a possible Keychain prompt), unsigned dmg/zip with hardenedRuntime, the publish job.

<!-- orgai:architecture -->
## Architecture and conventions

Read `.orgai/ARCHITECTURE.md` before changing code. It records the agreed stack, module layout, conventions and commands for this project. Keep it current when they change.
