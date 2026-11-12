# Parallel `orgai` sessions: design spec

Status: draft 4, 2026-11-12. Draft 1 was reviewed by GPT Astra and Gemini Argon, drafts 2 and 3 by GPT Astra and Gemini
Carbon; all six reviews BLOCKED. Resolutions are in section 14. Owner direction (2026-11-11): "mirror Claude Code / Codex":
any number of `orgai` processes at once, in any projects, on one CLI data folder, each terminal its own session. This
reverses `cli-standalone-default.md` G4 ("one `orgai` host process per CLI data folder") and promotes its non-goal
"parallel independent sessions like Claude Code" to a goal. Written against `pr/team-evolution` at b08d534f (the tip of
the open PR stack #48-#50); line numbers drift as that stack moves.

Every fact says how it was checked: "code" = read from the repo at b08d534f (or 1ee72bfd where it did not change),
"measured" = observed on the owner's Mac on 2026-11-11/12 (scripts in `docs/design/parallel-sessions-locktest/`),
"unverified" = from memory, docs or typings, not checked here.

---

## 1. What Claude Code and Codex do (the model to mirror)

- **Claude Code** (measured, directory layout of `~/.claude`): every session is its own process; a session's
  transcript is its own file, `projects/<escaped cwd>/<session uuid>.jsonl`. Shared files are small. No data-folder
  owner, no "already running" refusal.
- **Codex** (measured, directory layout of `~/.codex`): per-thread files `sessions/YYYY/MM/DD/rollout-*.jsonl(.zst)`;
  shared state in SQLite WAL databases; `session_index.jsonl.lock`, `thread-writer-locks/` (one writer per thread),
  `auth.json.lock`. Many `codex` processes run on one home.

Shared idea: **a session's own state has one writer; shared state is locked on write and re-read when it changes;
exclusion and liveness come from the operating system, never from pid guesses; nothing assumes it is the only
process.**

## 2. Goals and non-goals

Goals:

- P1. Any number of `orgai` processes run at once on one CLI data folder (TUIs in different or the same project,
  `orgai exec`, management commands). None is refused because another exists.
- P2. Each process hosts the runs it starts or continues and answers their cards in its own terminal (unchanged from
  `cli-standalone-default.md` G2/G3). Quitting ends its runs only (continuable later).
- P3. No process writes, ends, prunes, sweeps or integrates another live process's runs, chains, scratch folders,
  worktrees, temp folders or logs; no shared-file write is lost to a concurrent write; a slow, suspended or debugged
  process is never taken over; work left by a crashed process is quarantined: it is not resumed, pruned, swept or
  destroyed while the recorded evidence shows processes it started may still run, and where that evidence is missing
  OrgAI acts only on the user's explicit confirmation (4.8 states the evidence's limits).
- P4. A crashed process's state is recognised and settled by a later process, as a restart does today.
- P5. Every process sees every run; runs live in other sessions are marked and refresh from the files.
- P6. Old binaries never read or write the new format's data (it lives where no old code looks, 4.7); where an old
  binary does check, it is refused instead of showing a stale snapshot.

Non-goals:

- Cross-session `message_run` delivery, shared inboxes, answering another session's cards.
- Two processes driving one chain at once (one writer per chain, Codex's `thread-writer-locks`).
- Several desktop app instances (the desktop keeps one instance per folder, section 10).
- A spend cap summed across processes (none exists today; caps are per run or exec chain, `runManager.ts:2619-2685`).
- Data folders on network file systems (OS locks are not reliable there; `doctor` warns, 4.1).
- Protection against an agent with unrestricted shell access as the same user (true today as well, section 9).

## 3. What blocks it today

From the code (three research passes and four reviews):

1. **One owner per folder.** `startInprocHost` acquires `acquireHostOwnership({ wait: 'none' })`
   (`src/cli/inprocHost.ts:232-262`), refusing with exit 6 (`ownedMessage.ts:14`), because RunStore's constructor
   rewrites non-terminal runs (`ownership.ts:24-26`).
2. **Run index is one file rewritten whole** (`runs.json`, fixed tmp, `.slice(-500)`, `store/runs.ts:186-205`).
3. **Blind crash normalisation** in the RunStore constructor (`runs.ts:197`; it also sanitises fields, 102-126; an
   existing `endedBy` is kept, 128-145).
4. **Load-once, rewrite-whole config stores** with fixed tmp names: `projects.json` (whole-project `save`,
   `projects.ts:579-647`), `settings.json`, `skill-library.json`, `mcp-library.json`, `connector-presets.json`,
   `models.json` (cached in `ConnectionService.discovered`), `model-prices.json` (cached in `CommunityPrices`),
   `retained-run-projects.json`, `org-templates/templates.json`, `<userDataDir>/tui-hints.json`
   (`cli/tui/configApi.ts:37-62`, re-read per call). Knowledge revalidates by stat (`knowledge.ts:332-363`).
5. **Multi-file operations serialised only in memory, or not at all**: evolution (`evolve/service.ts` promise map,
   ledger `evolution/<pid>.json` + projects + project skills + `.orgai/`, with a hybrid model call inside
   `applyCore`); capability reviews (`capabilities/service.ts`: `team-reviews/<pid>.json` written after a model call by
   `proactive` 3 s after every work run, `dismiss`/`restore`/`refreshReview` outside its queue, `undo` restoring
   in-memory role snapshots; `reviewStore.ts:105-123` fixed `<file>.<pid>.tmp`); outputs (`tails` queue, version
   number chosen before `outputs.json` is updated, and `deletePreview`, `forget`, `noteAdd/Update/Remove`,
   `recordRevision`, `runEnded` outside the queue, `outputs/service.ts`); team files (`teamFiles/store.ts` four JSON
   files, `.orgai/`, `projects.json`; mutating entry points `beforeRun`, `beforeSave`, `status`, `approve`, `reject`,
   `enable`, `remove`, `undo`, `overwrite`, `focused`, `listAttention`, `checkAll`, `commit`, `markRemoved`, and a
   `setImmediate` cleanup in `commitAfterSave`, `teamFiles/service.ts:950-1147, 1280`); skills (library and project
   skills, `undoImport` and proposal rollback restoring whole in-memory snapshots, `skills/service.ts:500-758`); MCP
   builds (install renames the old dir aside, `mcp/builds.ts:153-173`); notes (`context/index.json` + `note_<id>.md`);
   engagement document; org templates (`templates.json` + `<id>/org.json`); quick-run promotion (project first, then
   runs; `moveToProject` updates only the summary, `quick/quickRuns.ts:284-299`, `runs.ts:340-360`); kit import
   (digest check then several services, `kit/service.ts:339-355, 666-738`); setup (`writeArchitecture` plain
   `writeFileSync` of `.orgai/ARCHITECTURE.md` and `CLAUDE.md`, `applyProposal` adding permission rules,
   `setup/service.ts:336, 448-465`); permission grants (`permission-rules.json` and the project folder's
   `.claude/settings.local.json`, plain `writeFileSync`, `permissionRules.ts:13-155`).
6. **Run files written outside a live run**: late title (`runManager.ts:3689-3750`), `usageSummaries` back-fill
   (3973-3988), post-run evolution flush (3817-3822), `stopPaused` (4737-4764), stranded exec finalisation
   (5073-5083), `switchModel` / `setPermissionMode` on stored runs, `continueRun` patching paused members (4965-4972),
   promotion; `flush()` swallows write errors (3793-3800); `emit` and `teardown` are synchronous and do not await
   writes (1908, 3704-3706).
7. **Chains**: continuation is a new run id (`continueRun`, 4898-5000); chain membership follows `resumedFrom` edges
   **and** shared non-empty provider session ids (`runManager.ts:640-670`, `runChains.ts:18-52`, regression
   `runManager.test.ts:1986-1997`); exec budgets also sum runs with the same caller-supplied `overrides.execChainId`
   (`runManager.ts:1843, 2651-2662`); "one live run per provider session" is checked in-process only (4914).
8. **Sweeps assume sole ownership**: `orphanRunProjects` + `removeProject`, `prune`, `sweepOrphans`,
   `sweepScratchDirs` (scratch dirs are created before the run exists, `quickRuns.ts:236-249`, and reused by
   continuations, `scratch.ts:6-10, 109-114`), `sweepStaleSkillDirs` (OS temp dir, 24 h, `claudeSkills.ts:134-168`),
   `project-skills/*/.undo`, Codex catalog files (shared names, re-read on every `thread/start`, 24 h,
   `codexNativeCatalog.ts:223-227, 326, 374-410`), `auth-cwd/` wiped when not empty (`anthropicAuth.ts:211-217`), one
   shared `harness-workspace/` (`mcp/assist.ts:33-34`, `skills/assist.ts:22-24`), vault reconcile at open
   (`secrets.ts:717-768, 827-865`).
9. **Worktrees**: `reconcileLeftovers` commits every `worktree-agent-*` worktree's files (`integration.ts:437-456`);
   `integrate_worktrees`, maintenance integrate/discard/uninstall and nested evacuation act on all pending worktrees
   (`harnessTools.ts:826-838`, `maintenance.ts:44-130`, `worktrees.ts:162-190`).
10. **Existing locks are not exclusive under contention or uncertainty**: `repoLock.ts` and the startup mutex reclaim
    "stale" `mkdir` locks by rename-and-reverify and by age for unconfirmed owners (`repoLock.ts:363-398`,
    `ownership.ts:684-763`); `repoLock` falls back to an in-process lock on errors. `withCodexStartLock`, MCP OAuth
    refresh, `UsageMonitor`, `log.ts` coordinate in memory only. OAuth tokens are two vault writes and the OAuth
    config (`generation`, `expiresAt`) lives in `projects.json` / `mcp-library.json` (`mcp/service.ts:1403-1519`,
    `secrets.ts:76-102`).
11. **Host death does not end its children**: Codex and Claude are ordinary subprocesses (`codexAppServer.ts:292-299`);
    the hard-limit shutdown path can exit without confirming descendants died (`shutdown.ts:555-563`).

## 4. Primitives

### 4.1 OS locks: `osLock.ts`

Every lock is an operating-system file lock taken through SQLite (`node:sqlite`, built into Node and Electron; no new
dependency) on a lock file that is never written. Measured (Node 26; Electron 45's Node 24.22 with
`ELECTRON_RUN_AS_NODE=1`):

- `BEGIN EXCLUSIVE` (`busy_timeout = 0`) in one process makes `BEGIN EXCLUSIVE` in another fail at once with
  `database is locked`; `kill -9` of the holder releases it at once. Two connections in one process exclude each
  other the same way. (`hold.cjs`, `try.cjs`, `same.cjs`)
- On a **0-byte** file: shared (`BEGIN` + `SELECT count(*) FROM sqlite_schema`) is held by several processes at once;
  `BEGIN EXCLUSIVE` fails while any is held and succeeds after all are killed; a read-only probe of a 0-byte file held
  exclusively reports `database is locked`. (`shared0.cjs`, `probe0.cjs`)
- Releasing with `ROLLBACK` leaves the file 0 bytes with no `-journal` or `-wal` (`rollback0.cjs`); releasing with
  `COMMIT` wrote a 4 KB header, so the API never commits.

Protocol:

- **Files are always 0 bytes.** A missing lock file is created `open(O_CREAT|O_EXCL, 0600)` and closed before SQLite
  opens it (no SQLite connection to it can exist yet in this process if the create succeeded; if it failed with
  `EEXIST` nothing was opened). It is never written. Before each SQLite open, `lstat` (no descriptor) must show a
  regular, non-link file of size 0 owned by this user (POSIX), with no `-journal`/`-wal` sibling; anything else fails
  closed naming the path. Lock files are never opened, read or closed outside SQLite (closing a raw descriptor would
  drop the process's POSIX locks on the inode, SQLite "how to corrupt" 2.2).
- **Exclusive**: `BEGIN EXCLUSIVE`. **Shared**: `BEGIN` + `SELECT count(*) FROM sqlite_schema`. **Release**:
  `ROLLBACK`, then close. **Probe** (`'held' | 'free' | 'missing'`): open read-only (never creates), shared read; busy
  means an exclusive holder exists. Hostless readers use only probes.
- **In-process coordinator** (one per path, reader-writer aware): shared acquisitions from several tasks share one
  connection with a reference count; an exclusive acquisition waits for in-process shared holders and other exclusive
  holders in FIFO order; **claims** (`waitMs = 0`) never queue: they fail at once on any conflict, in-process or
  OS; **probes** never enter the coordinator. **Reentrancy**: a lock already held by the current async context
  (`AsyncLocalStorage` held-set) is reused, never re-acquired, so a coordinator that pre-acquires its lock set (4.2)
  can call services that ask for the same locks. Async children inherit the held-set; an operation must not run
  sibling mutations concurrently under one held-set (a test asserts the services' operations are sequential).
- **Waiting**: try; on `SQLITE_BUSY` close the connection, sleep (5 ms doubling to 100 ms, ±25 % jitter), reopen by
  path, retry until `waitMs`. On Windows, `EACCES`/`EPERM`/`SQLITE_CANTOPEN` from a sharing violation are retried the
  same way once the folder check (below) has passed. Every other error fails closed; there is no in-process fallback.
  Cancellation (shutdown) aborts waiters.
- **Never by pid**: no pid, start time, heartbeat or age decides that a holder is gone. A suspended holder keeps its
  lock (`SIGSTOP` test).
- **Deletion**: only lock files whose key is never reused may be deleted: `host-<hostId>`, `chain-<chainId>`, and
  per-project locks of a removed project (project ids are never reused). They are deleted by housekeeping (5.4) after
  `ROLLBACK` and close, when a probe says 'free' and the subject is gone; every acquirer of such a lock re-verifies its
  subject after acquiring and gives up when it is gone, so a racer that locked an unlinked or re-created file finds
  nothing to act on. On Windows an unlink that fails is left for a later pass. Locks with reusable keys (`admission`,
  `config`, `vault`, `library`, `execchain-*`, `oauth-*`, `plan-usage-*` and every cache lock: `repo-*`,
  `repo-usage-*`, `worktree-*`, `permissions-*`) are never deleted.
- **Advisory info**: `<lock>.json` beside a lock may hold `{ pid, hostInstanceId, ownerCwd, since }` for messages; it
  never decides anything (section 9); every string from it passes `sanitizeTty` with a length cap before display.
- **Network file systems**: SQLite's locks are not reliable over NFS/SMB (SQLite documentation, unverified here). The
  first start on a folder and `doctor` report a data or lock folder on a network file system (`statfs` on
  macOS/Linux, `GetDriveType` on Windows, unverified on Windows).

**Lock folders**: `<dataDir>/control/locks/` (data-folder locks; `control/` is never copied or published, 4.7) and
`<user cache>/orgai/locks/` for locks keyed by a path outside the data folder (`~/Library/Caches`, `%LOCALAPPDATA%`,
`${XDG_CACHE_HOME:-~/.cache}`), named `<kind>-<sha256(pathKey(path))[0..32]>.lock` (`pathKey`, `repoLock.ts:122`,
code). **Folder trust**, checked once per process before the first lock and failing closed: the lock folder and every
ancestor up to the user's home (POSIX) or profile folder (Windows), after `realpath`, must be owned by the user or
root/SYSTEM, must not be writable by group or others (POSIX; a sticky shared ancestor such as `/tmp` is refused), and
on Windows must grant write, delete or delete-child only to the user's SID, SYSTEM (`S-1-5-18`) and Administrators
(`S-1-5-32-544`), with no reparse point. The lock folders themselves are created 0700, or on Windows with
`icacls /inheritance:r /grant:r *<userSid>:(OI)(CI)F *S-1-5-18:(OI)(CI)F` (absolute `icacls` path as
`restrictDaemonSecretAcl` does today, `ownership.ts:1091-1118`) and verified by SID. Unverified on Windows; CI tests a
permissive ancestor and a rename attempt by another principal where the runner allows it.

### 4.2 Claims, session holds, transaction locks and their order

- **Claims** never wait (`waitMs = 0`): they succeed at once or the operation is refused, so they cannot take part
  in a deadlock and are exempt from the order. Claims: `host-<id>`, exclusive `admission` (4.6), `chain-<chainId>`,
  `execchain-<projectId>-<execChainId>`, `setup-<pid>`, exclusive `project-<pid>`, `worktree-<repo>-<branch>`,
  exclusive `repo-usage-<repo>`, `housekeeping`.
- **Session holds** are shared locks that never wait either (they conflict only with an exclusive claim, which is a
  refusal): shared `project-<pid>` (taken when a session opens, creates, promotes into or runs in a project, at any
  point in the session), shared `repo-usage-<repo>`. The one waiting session hold is shared `admission`, taken first
  at process start before anything else (4.6).
- **Transaction locks** wait (bounded) and are acquired in this order; several locks of one row in sorted key order.
  **Coordinators** (the operations named in the last column) compute the set of locks they will need from a read,
  acquire the whole set in order, re-read and check the set is unchanged (else release all and retry, at most 3
  times), then do their work; services called inside reuse the held locks (4.1 reentrancy). A debug assertion throws
  on an out-of-order acquisition of a lock not already held.

| Order | Transaction lock | Wait | Covers | Coordinators |
|---|---|---|---|---|
| 1 | `library` | 60 s | skill library, MCP library, connector presets, org templates, kit import | library edits, kit import, connection remapping |
| 2 | `team-<pid>` (sorted) | 60 s | everything that composes a project: team files (all entry points, 3.5) and `.orgai/` writes, project skills, project MCP servers, capability reviews/apply/undo, evolution ledger commit, skill-evaluation commit, setup proposals, the project save hook and its cleanup | team-files operations, project skill/server edits, capability, evolution, setup proposals, uninstall, project removal |
| 3 | `repo-<repo>` (sorted; legacy `mkdir` lock inside, 6.2) | 60 s | git operations, `CLAUDE.md` / `ARCHITECTURE.md` writes | worktree integration, maintenance |
| 4 | `oauth-<credentialOwner>` (sorted) | 60 s | refresh, revoke, retarget, authorise commit (network inside) | OAuth service |
| 5 | `plan-usage-<key>`, `models-discovery`, `codex-start` | 60 s | single-flight network or process start | usage monitor, model discovery, Codex start |
| 6 | `outputs-<pid>` | 15 s | every outputs mutation (3.5) | outputs service |
| 7 | `knowledge-<pid>` | 15 s | knowledge graph | knowledge service |
| 8 | `notes-<pid>`, `engagement-<pid>`, `staffing-<pid>` | 15 s | per-project data | their services |
| 9 | `permissions-<rules file>` (cache, keyed by `pathKey(rulesFileOf(target))`, so a project folder's `.claude/settings.local.json` and a data-folder `permission-rules.json` each have their own) | 15 s | permission rules, taken inside `permissionRules.ts` | `addRules`, `removeRule` |
| 10 | `vault` | 15 s | every vault read-decide-commit (6.7) | secret store |
| 11 | `config` | 15 s | every `SharedJsonFile` update (4.4) | stores |

No transaction lock is held across a model call. Evolution's hybrid synthesis, capability reviews and skill
evaluations run their model step outside `team-<pid>` on a snapshot and commit under it only if the generation they
started from is unchanged (else "changed meanwhile, run again", never an overwrite). Only orders 4 and 5 are held
across a network call or a process start, and nothing after them is waited for while that call is in flight.

Flows, each an integration test through the real services with a recording lock layer (3 retries of the coordinator
set included): kit import 1 → 2 (affected linked projects) → 3 → 4 → 10 → 11; library skill or MCP entry change with
linked projects 1 → 2 → 4 → 10 → 11; team-files operation 2 → 3 → 4 (server secrets) → 10 → 11; project skill edit
2 → 11; evolution commit 2 → 3 → 11; setup proposal (every kind) 2 → 3 → 9 → 10 → 11; uninstall 2 → 3; project removal
claim → 2 → 6/7/8 → 10 → 11; OAuth refresh 4 → 10 → 11; plan usage 5 → 11; knowledge adding a note 7 → 8; worktree
integrate: claim (exempt) → 3.

### 4.3 Chains and the chain claim

- **Chain identity.** New persisted `RunSummary.chainId`: a new run's own id; a continuation copies its predecessor's.
  Conversion (4.7) computes it with today's membership rules: connected components over `resumedFrom` edges and shared
  non-empty `sessionId`s (union-find), id = the component's oldest member (`startedAt`, then id). Validated
  `^run_[A-Za-z0-9_-]{1,80}$`. After conversion the persisted `chainId` is authoritative (pruning does not change it).
- **Provider session binding.** Every point that records a provider session id for a run (`session.started`, a
  `run.status` that sets or changes `sessionId`, continuation, restart; `runManager.ts:1883-1938, 4995-4998`, code)
  binds it: create `control/sessions/<sha256(provider + sessionId)>.json` with `{ chainId }` using `O_EXCL`; if it
  exists with another `chainId`, the binding is refused and the run ends with an error ("This provider session belongs
  to another conversation"). Bindings are removed with their chain.
- **One writer per chain.** The process that starts or continues a run claims `chain-<chainId>` before it chooses what
  to start and holds it until the chain is settled in that process: the run is terminal or deliberately paused without
  auto-resume, its late title arrived or was abandoned (60 s cap), evolution flush and exec finalisation are done, no
  auto-resume timer is armed, and the per-chain write queue drained with every write succeeded. `RunManager`
  serialises summary and record writes on that queue and awaits it (and `recordRunInStaffingProfile`,
  `outputs.runEnded`) before releasing; shutdown drains the queues. A failed final write keeps the claim until exit.
- **Exec chains.** A run with `overrides.execChainId` also claims `execchain-<projectId>-<execChainId>` (the budget is
  per project, `runManager.ts:2652-2662`, code) on start and on `continueRun`, after the chain claim, and holds it as
  long as the chain claim (including `waitForReset` timers).
- **RunStore enforces it.** Every mutation (`create`, `upsert`, `patchSummary`, `setUsage`, `saveRecord`,
  `saveImage`, `moveToProject` (summary **and** the record's embedded summary), `remove`) takes a `ChainWrite` token,
  created only by a held claim or by `withChainClaim(chainId, fn)` (claim, re-read the chain from disk, verify it
  exists, run `fn`, release). `usageSummaries` back-fill is in memory only. `getRecord` returns null when the summary is
  missing (no fallback to the record's embedded summary).
- **Continue, resume, `exec --continue`, auto-resume, `resume --now`, `resume --cancel-auto-resume`, `tui <run>` with
  input**: claim the chain; busy refuses with exit 6: "This conversation (R3, run_abc) is live in another orgai
  (<cwd>, pid). Use that one, or quit it first." Under the claim, re-read the chain and recompute the target with
  today's rules (`newestContinuable` / `canContinueIn`) and the remaining budget. A quarantined chain (4.8) runs the
  consumer check first.
- **Stored-run writes from another session** (`runs model`, permission mode, `stop` of a paused run, delete, move):
  `withChainClaim`; busy refuses with the same text.
- **Scratch folders** (quick runs, Chat, MCP `allowBuild` assistants, `dispatcher.ts:1106-1117`): one allocator,
  `allocateScratch(chainWrite)`, which requires a held chain claim and creates `v2/quick/<chainId>/` (continuations
  share it). Both start paths (`QuickRunService.start`, `mcp:startAssist`) mint the run and chain ids and claim the
  chain before calling it. `SCRATCH_NAME` / `scratchDirFor` / `McpService.genuineWorkspace` accept the new form;
  `quick.folder` and `buildWorkspace` point to it.
- **Promotion** claims every chain of the runs it moves (sorted), re-reads membership, refuses if any member is live
  or paused with auto-resume, journals (4.9), creates the project with `pending: true` under an exclusive
  `project-<newId>` claim (pending projects are hidden and cannot be opened), moves summaries and records, clears
  `pending`, releases.

### 4.4 Shared JSON files: `SharedJsonFile<T>`

For `v2/` `projects.json`, `settings.json`, `skill-library.json`, `mcp-library.json`, `connector-presets.json`,
`models.json`, `model-prices.json`, `retained-run-projects.json`, `org-templates/templates.json`, `tui-hints.json`
(moved from `<userDataDir>/tui-hints.json` into `v2/` by conversion), `plan-usage.json`.

- `read()` is a cached parse revalidated by `stat` (size, mtimeNs, ino) on every call; services that cached derived
  copies (`ConnectionService.discovered`, `CommunityPrices`, settings listeners, the project tier context) read
  through it and re-derive on change.
- `update(fn): Promise<T>` takes `config` (order 11), re-reads from disk, applies `fn`, writes
  `<file>.tmp-<hostId>-<random>` (`wx`, fsync where the store fsyncs today), renames. `durableFs` no longer unlinks a
  shared fixed tmp name.
- A parse failure keeps the last good copy for reads and refuses `update` naming the file.
- **Projects** carry `revision` (+1 per write). `mutateProject(id, fn)` applies `fn` to the fresh copy and **refuses
  an id that is no longer present** (fan-out callers such as `relinkProjects`, `remapConnectionProjects` and library
  updates skip it); only `create` inserts. Every internal caller of `save`/`update` moves to it. Whole-object saves
  (`saveFromRenderer`, the CLI's project edit) carry the revision they read and are refused on a mismatch ("This
  project changed in another orgai session. Reload and try again."). Settings mutate by patch; libraries and presets
  per entry; TUI hints by set union. `migrateAll` runs inside `update` only when the file version requires it.
- **Save hook (team files).** A project save with team-file effects runs under `team-<pid>` (order 2): compute the
  effects without writing; `update` under `config` checks the revision against a fresh read and writes `projects.json`;
  then the computed writes (journaled, 4.9) and the cleanup `commitAfterSave` used to defer with `setImmediate` (now
  awaited) run before `team-<pid>` is released. A refused save writes no companion file.
- **Undo and rollback** (`CapabilityService.undo`, `SkillService.undoImport`, proposal rollback, team-files undo)
  record the project revision and the fields they changed; they patch only those fields through `mutateProject` and
  are refused if another writer changed them since. `snapshotForProposal` snapshots only skills and their role grants.

### 4.5 Host claim and registry

- Each host (TUI, exec, management command, desktop) claims `host-<hostInstanceId>` for its lifetime and writes
  `control/hosts/<hostInstanceId>.json` (`{ pid, hostInstanceId, hostKind, appVersion, ownerCwd, projectId?, command,
  startedAt }`, advisory) and an initial empty `control/hosts/<hostInstanceId>.children.json` **before** it can spawn
  anything (4.8). A host is live exactly when its lock is held (probe).
- Owner-scoped resources carry the `hostInstanceId` and live under `v2/`, never the OS temp dir:
  `v2/tmp/skills/<hostId>-*` (replacing `orgai-skills-*` in the OS temp dir; legacy names are never touched),
  `v2/tmp/codex-catalog/<hostId>-<key>.json`, `v2/auth-cwd/<hostId>/`, `v2/harness-workspace/<hostId>/`,
  `.undo-<hostId>`, tmp files, logs. They are swept only when that host's lock is free **and** its consumer check
  passes (4.8).

### 4.6 Admission

- Every host takes `admission` shared first (waiting up to 30 s, printing "Waiting for another orgai to finish
  <operation>"), before opening anything else, and holds it for life. A live host never drops it.
- Operations that must be alone: conversion (4.7), vault `init` over an existing vault, `reset`, `undelete`,
  `keep-removed`, key rotation. They run only as their own CLI command, whose process claims `admission` exclusive
  **instead of** shared, before opening any store; busy refuses with exit 6 naming the sessions. They are not offered
  inside a TUI ("Run `orgai secrets reset` in a terminal with no other orgai.").
- The desktop claims `admission` exclusive for its lifetime (it never shares its folder).

### 4.7 Format 2: control namespace, a new data tree, conversion and fences

**Layout.**

- `<dataDir>/control/`: coordination only (`locks/`, `hosts/`, `journal/`, `sessions/`). Created when first needed
  (also by phase 2, 12), never copied, never published, never deleted. Old code does not know it.
- `<dataDir>/v2/`: format-2 data. It counts as committed only when `v2/FORMAT.json` (`{ format: 2, createdBy,
  manifestSha256 }`) exists and parses; it is written inside the staging folder and published with it by one rename.
  Contents: every store, `runs/`, `quick/`, `mcp-builds/`, `codex/` (the Codex home), `project-skills/`, `evolution/`,
  `projects/`, `staffing/`, `skill-evaluations/`, `team-reviews/`, `org-templates/`, `logs/`, `tmp/`,
  `harness-workspace/`, `auth-cwd/`, the vault files, `tui-hints.json`.
- The format-1 files in `<dataDir>/` (and `<userDataDir>/tui-hints.json`) are left exactly as they were and never
  written again by new code.
- Old code (any version) reads and sweeps only format-1 paths, so it can neither read, sweep nor overwrite format-2 data,
  whatever fences it honours. A downgraded desktop that follows its own "delete `<dataDir>/run`" advice
  (`ownership.ts:136-138`, code) sees the frozen format-1 state. Released CLI v0.1.6 (tag 2026-11-05, code) uses the
  desktop's folder, has no product marker check, and its hostless readers see the frozen format-1 files (stale,
  harmless).

**Fences** (a clear refusal where old code checks; safety does not depend on them): the product marker
`{ "product": "orgai-cli/2", "version": 1, "format": 2 }` (desktop `"orgai-desktop/2"`), written by a new
`overwriteProductMarker` (durable tmp + fsync + rename; `writeProductMarker` is create-only, `productMarker.ts:55-64`);
new code's `readProductMarker` normalises `"…/2"` to `{ product, format: 2 }` so every existing product check keeps
working; marker-aware old CLIs (unreleased dev builds since 2026-11-08) refuse it (exit 2). And `<dataDir>/run/
daemon.json` = `{ "format": 2, "note": "This folder is used by a newer OrgAI. Older versions cannot open it; update
OrgAI." }`, which old hosts (CLI and desktop, v0.1.6 included) refuse as `daemon_json_unreadable`
(`ownership.ts:386-410, 594-602`, code): the old CLI says "orgai is already running" (exit 6), the old desktop "OrgAI
could not start" with the delete-`run` hint (`index.ts:348-361`), old `doctor` "daemon.json could not be read:
unexpected shape". New hosts re-create either fence if it is missing.

**Conversion** (first new binary on a folder without a committed `v2/`; a CLI process runs it before opening
anything, the desktop the same at start):

1. Create `control/`. Take the legacy startup mutex with `acquireLegacyStartupMutex(runDir)`: `mkdir
   run/startup.mkdir` with a valid `owner.json` (`{ pid, processStartTime, hostInstanceId, createdAt }`) refreshed
   every second, never calling `readDaemonFileState` (`withStartupMutex` does, `ownership.ts:510-516`). Claim
   `admission` exclusive (in `control/locks`).
2. Inspect `run/daemon.json`: missing or the fence: go on. A parseable record whose pid is alive or unconfirmed:
   refuse exit 6 "An older OrgAI is running on this folder (<cwd>, pid). Quit it, then start again." Dead: go on.
   Unusable and not the fence: refuse naming the file.
3. Write the `daemon.json` fence (durable).
4. Record a source manifest (path, size, mtimeNs, ino of every format-1 file read). Copy into
   `<dataDir>/v2.staging-<hostId>/` (clone where the file system supports it, else copy) and transform there:
   `runs.json` → per-run summaries (sanitised, non-terminal ones normalised, `chainId`s); records into `runs/`;
   scratch folders into `quick/<chainId>/`; `<userDataDir>/tui-hints.json` into `tui-hints.json`.
   **Path relocation**: every persisted absolute path into the old data folder is rewritten to its new location by a
   typed relocation table (MCP server `command`/`args`/`cwd`/`env` in projects and MCP library entries,
   `RunSummary.quick.folder`, `buildWorkspace`, the summaries embedded in records, project paths of quick and
   assistant projects, skill and template asset paths); then a generic scan of every JSON file in staging fails the
   conversion, listing the field paths, if any string still starts with the old data folder. Paths outside the data
   folder are left alone.
5. Fsync every written file and directory; write `MANIFEST.json` (counts, SHA-256 of every JSON file) and
   `FORMAT.json`; re-read and validate everything. Re-check the source manifest, the fence content and the mutex owner
   token: any difference means an old process touched the folder: discard the staging folder and refuse ("Another
   OrgAI changed this folder during the upgrade; quit it and start again").
6. Rename `v2.staging-<hostId>` to `v2` (it does not exist yet), fsync `<dataDir>`. This is the commit point.
7. Write the format-2 product marker (durable). Release the mutex, then turn the exclusive `admission` claim into the
   process's normal shared hold (release, then take shared like any other start).

Recovery: a committed `v2/` (valid `FORMAT.json`) → format 2, with missing fences re-written. A `v2/` without a valid
`FORMAT.json` cannot be produced by this procedure; if found, it is refused naming it. A leftover `v2.staging-*` whose
host lock is free is deleted and conversion restarts. Readers: committed `v2/` → read it; else format 1 (today's
reader); the format-1 files never change, so a reader that chose format 1 keeps a consistent view. Format-1 files are
kept; `doctor` reports their size; a later release deletes them after one release of overlap. Downgrade is not
supported; `doctor` says so.

### 4.8 Consumers: processes a host started

The OS frees a dead host's locks, but agents, shells, git or Codex processes it started may still run.

- **Evidence**: each host keeps `control/hosts/<hostId>.children.json` current (written empty before the first spawn,
  then on every spawn and every 5 s): its descendants (pid and start time) from the process-table reader `shutdown.ts`
  already uses (`ps -A -o pid=,ppid=,stat=,lstart=`; Windows CIM `Win32_Process`, code), and each live run's chain id
  and worktree paths.
- **Quarantine**: when housekeeping settles a crashed host's chain (5.3), it records `crashedHost: <hostId>` on the
  summaries. A quarantined chain, and every resource of a dead host (its worktrees, owner-scoped dirs, journals, the
  scratch folders of its chains), is acted on only after the **consumer check**: the evidence file exists and is
  readable, none of its recorded descendants is alive with the same start time, and (macOS/Linux) no process has its
  working directory inside an affected worktree or scratch folder (`lsof -a -d cwd -Fn`, measured on macOS). Missing or
  unreadable evidence counts as **uncertain**.
- **Outcomes**: check passes → act. Check finds a process → refuse ("Processes started by an earlier orgai session
  are still running here (pid …). Stop them or wait, then try again."). Uncertain, or Windows (no cwd check) → no
  automatic action; a user action asks for confirmation in a TUI, and in non-interactive commands (`exec --continue`,
  `resume`) refuses with exit 6 unless `--after-crash` is given.
- **Evidence retention**: a dead host's `children.json`, registry entry and lock file are removed only when every
  recorded descendant is gone; quarantine marks are cleared when the consumer check passes. Settlement, prune
  (5.2), scratch sweeps, project removal and resume all apply the check to quarantined chains.
- **Limits** (stated, tested where possible): a grandchild started and orphaned between two snapshots, whose cwd is
  outside the resources, escapes the evidence; OrgAI does not contain processes (no OS job or cgroup control here).
  Tests kill only the host while a mock child keeps writing and assert refusal, run housekeeping twice, delete the
  evidence file, and settle-then-prune. Unverified: that the Claude CLI and Codex app-server exit when their host's
  pipes close.

### 4.9 Journals for multi-file operations

- A journaled operation writes `control/journal/<resourceKey>/<opId>.json` (durable: tmp, fsync, rename, fsync dir)
  under its locks before its first change: `{ op, hostId, resource, steps, expected: { before, after } }` where
  `before`/`after` are the resource generations (project revision, ledger generation, output version list digest,
  build id, ...). It deletes it (unlink, fsync dir) after the commit point. Resource keys: `project-<pid>`,
  `mcp-build-<entryId>`, `library`, `outputs-<pid>`, `notes-<pid>`, `templates`, `chain-<chainId>` (promotion).
- **Fencing**: every operation on a journaled resource, after acquiring its locks and before reading or validating,
  looks for pending journals under its resource keys. One whose host lock is held cannot exist (that host holds the
  locks). One whose host is dead is recovered **inline, under the same locks**, after its consumer check: if the
  resource is at `expected.before` it is undone or rolled forward per the operation's rule; at `expected.after` the
  journal is just removed; at anything else the journal is kept as "needs attention", the operation refuses, and
  `doctor` / the TUI show it. Recovery is idempotent and never re-creates a retired chain or project (subject existence
  is checked first). Housekeeping runs the same recovery by taking the same locks.
- Commit points and recovery rules, per operation (each with kill-point tests between every pair of file changes, and
  a test where a live session touches the resource before housekeeping runs): quick promotion (project un-pended),
  MCP build install and rollback (new dir in place; old dir kept until then), skill proposal apply and rollback, kit
  import, evolution apply and rollback, team-files apply (companion files after `projects.json`), output version
  commit, notes (index after body), templates (index after `org.json`), project removal (removed from `projects.json`
  first, then data).

## 5. Runs

### 5.1 Layout

- `v2/runs/<id>.summary.json` (the `RunSummary` with `chainId`), `v2/runs/<id>.json` (record), `v2/runs/<id>/images/`.
  Written only with a `ChainWrite` token, tmp + rename; **summary first** on creation and **last** on deletion, so a
  record or image dir without a summary is never live (and is never read: `getRecord`/`readRecord` return null).
- Entry patterns: summaries `^run_[A-Za-z0-9_-]+\.summary\.json$`, records `^run_[A-Za-z0-9_-]+\.json$` (not
  summaries), image dirs `^run_[A-Za-z0-9_-]+$`, tmp files `\.tmp-<hostId>-[0-9a-f]+$`.
- `RunStore.all()` lists summaries with a per-file stat cache and a directory-mtime short cut; target 1,000 summaries
  under 50 ms warm on the owner's Mac (measured when the phase-1 test lands).
- Every summary read is sanitised (split out of the crash normaliser); crash settlement is 5.3.
- Run numbers (R1, ...) are derived and can shift after pruning; actionable messages also name the run id.

### 5.2 Removing runs

Prune (at every run end, after the ending run's own claim is released, and in housekeeping), project removal,
orphan-project removal and delete: per chain, `withChainClaim` (busy: skip); under it re-read; skip unless every member
is terminal or deliberately paused, and (if quarantined) the consumer check passes; delete images, record, summary (in
that order), the chain's session bindings; when no member is left, delete the chain's lock file after release (4.1).
Retention is the existing per-project `prune(keepFor)`.

### 5.3 Crash settlement

No constructor normalisation. A summary whose chain claim is held by this process is live here; held by another:
live elsewhere (`liveElsewhere`, display only). Free claim:

- `finished`, `error`, and `paused` with `autoResume` not true: settled states, left alone.
- `paused` with `autoResume: true`: an interrupted auto-resume; settled to `autoResume: false` (and `execOutcome:
  'rate-limited'` when `waitForReset` was set), as `markQuit` does today for a quit (`runManager.ts:4812-4859`, code).
- any other status: a crash leftover; shown normalised in memory, settled by housekeeping (claim, re-read, normalise,
  mark `crashedHost` when the advisory claim info names a host, write, release). Settlement is metadata only.

### 5.4 Housekeeping

Each new host runs it after it is ready, in the background, under a `housekeeping` claim (another process already
sweeping: skip). Each row takes the locks or claims of what it touches and re-reads inside.

| Sweep | After |
|---|---|
| journals | 4.9 recovery under the resources' locks |
| crash settlement | 5.3 |
| `prune(keepFor)`, orphan projects | 5.2; orphan-project removal re-reads `projects.json` and the retained list; project removal writes both in one `config` section |
| orphan records / image dirs | entries without a summary (never live, 5.1) |
| scratch folders `v2/quick/<chainId>/` | chain claim free, no summary of that chain references it, consumer check if quarantined |
| owner-scoped dirs and files (4.5), `.undo-<hostId>`, `v2.staging-*` | host lock free and consumer check passes |
| host registry, `children.json`, host lock files | host lock free and every recorded descendant gone |
| memberless chain locks, locks of removed projects | probe free and subject gone (4.1) |
| worktree markers | branch no longer exists |
| logs | 6.8 |

## 6. Runtime

### 6.1 RunManager

- In-memory maps describe this process's runs. `list_runs` adds "N runs of this project are live in other orgai
  sessions (not reachable)"; `message_run` to one returns the new result `other-session` instead of `not-live`.
- Writes go through the per-chain write queue (4.3); `emit` and `teardown` enqueue; the queue is awaited at
  settlement and shutdown.

### 6.2 Worktrees and repositories

- `repoLock` becomes the OS lock `repo-<repo>` (order 3), which excludes new-version processes from each other. It
  also still takes the legacy `mkdir` lock inside, so old binaries keep whatever exclusion the legacy lock gives them
  today; **mixed-version use of one repository has the legacy lock's guarantees and no more** (its delayed-reclaimer
  race, Astra round 2 finding 1, remains between an old process and anything else, as it is today between two old
  processes). The in-process fallback goes.
- A report's process claims `worktree-<repo>-<branch>` before the report may edit (Claude: in the spawn hook that
  decides isolation; Codex: when it creates the worktree) and holds it until integrated or discarded; advisory marker
  `<gitCommonDir>/orgai-worktrees/<branch>.json`; branch names validated `^worktree-agent-[A-Za-z0-9_-]{1,80}$`.
  **Unverified** that the Claude hook knows the branch before the SDK creates it; if not, the claim is the first action
  of the report's first tool call, and until then the worktree counts as unowned.
- **Automatic actions touch only this process's own worktrees.** Others (another session's, a crashed session's,
  unmarked or legacy) are never committed, integrated, discarded or moved automatically: `reconcileLeftovers` reports
  them without committing; `integrate_worktrees` integrates only worktrees this run holds, plus leftovers the user
  approves on a card. User-initiated maintenance on a worktree requires its claim free, the consumer check (4.8), and a
  confirmation that names what is unknown ("an older OrgAI version may be using it").
- Nested worktrees: an operation on a worktree checks its whole subtree first and aborts if any descendant is held
  elsewhere, fails its consumer check, or cannot be evacuated.
- `uninstallRepo` takes `team-<pid>` then `repo-<repo>` (4.2), claims `repo-usage-<repo>` exclusive, runs the consumer
  check on every worktree, and asks for a confirmation that names older versions as undetectable.

### 6.3 Projects, setup and project-folder writes

- Every host or command that acts on a project (TUI, `exec`, `resume`, and the project-scoped management commands of
  7.1) takes `project-<pid>` shared, then re-reads `projects.json` and gives up (onboarding in the TUI, refusal
  elsewhere) if the project is gone. Removal claims it exclusive and refuses naming the sessions; under it, journaled
  (4.9): the project leaves `projects.json` first, then runs (5.2), secrets, skills and project data are removed.
- Setup-like runs (setup, org change, `org evolve`, Team assistant applying team files, Chat's targeted setup
  proposals) claim `setup-<pid>`: "Setup for <project> is open in another orgai (<cwd>, pid). Finish it there first."
- Setup's `writeArchitecture` writes under `team-<pid>` and `repo-<repo>` by tmp + rename. Permission rules take
  `permissions-<rules file>` inside `permissionRules.ts` (`addRules`, `addRulesReport`, `removeRule`, now async;
  `answerPermission` / `answerRules` await them) and write by tmp + rename.
- Capability reviews, skill evaluations, evolution: model step outside, commit under `team-<pid>` with a generation
  check; `reviewStore.ts` and `skills/evaluation.ts` use unique tmp names.
- Outputs: every mutation (3.5) under `outputs-<pid>`; version numbers chosen inside the lock.
- Kit import: a coordinator (4.2) over `library`, the affected projects' `team-<pid>`, their repos, OAuth owners,
  `vault`, `config`, taken before validating the target digest and held through the writes.
- Two work runs in one project are allowed; starting one prints a notice when another session has a live run there.

### 6.4 Spend and plan usage

No cross-run cap is added. The plan-usage probe takes `plan-usage-<connectionKey>` (order 5), re-reads
`v2/plan-usage.json` (keyed by connection and account), probes only if older than 60 s, writes under `config`,
releases; a crash releases the lock (OS). Each process still probes only when it has no live run.

### 6.5 Codex

- `withCodexStartLock` adds `codex-start` (order 5) around the start (two starts on one home race on Codex's SQLite,
  `codexAppServer.ts:57-60`, code). Catalog files are per host (4.5).
- Running app-servers share `v2/codex/`; Codex keeps its own WAL SQLite and locks (measured layout of `~/.codex`;
  **unverified** for the bundled version with concurrent app-servers; checked by hand in phase 3 and recorded).
- Codex sign-in is Codex's own `auth.json` under its home (`connections/service.ts:934-1005`, code).

### 6.6 MCP OAuth

- `oauth-<credentialOwner>` (order 4) covers refresh, revoke, retarget/removal and the authorisation commit. Tokens,
  their `generation` and `expiresAt` are one vault entry written by a new `SecretStore.setMany` (one `vault` write);
  the config's `McpOAuthConfig` keeps display fields only, written after the vault under `config`. A refresh whose
  base generation changed uses the stored tokens instead.
- New tokens are saved first after a token response; a crash between the provider rotating a refresh token and that
  save loses it (the user signs in again; documented).

### 6.7 Vault

- Reads revalidate `vault.json` by stat and reload when it changed; if a vault appears that this process has no key
  open for (another session created it), the next read that needs it opens the key through the custodian
  (`ensureFreshVault`, async) first.
- Every mutation (`set`, `setMany`, `clear`, `delete`, `deletePrefix`, `undelete`, `confirmDeletes`) becomes async:
  take `vault` (order 10), reload from disk, apply its delta to the fresh vault, commit, release. Creation of the first
  vault runs under `vault` with a fresh "still absent" check. Open-time reconcile and legacy retirement run under it.
- Exclusive operations hold `admission` exclusive from before the store opens (4.6). Phase 2 converts every caller
  (`McpService`, `ConnectionService`, `TeamFilesService`, `SetupService`, `KitService`) to the async API.

### 6.8 Logs

Each process writes `v2/logs/orgai-<YYYYMMDD-HHMMSS>-<hostId>.log` (2 MB, one rotation); retention: newest 20 files
or 14 days, never a live host's. The desktop keeps one log (`v2/logs/main.log`). `doctor` names this process's file;
the TUI `/logs` (run logs) is unchanged.

## 7. CLI

### 7.1 Command matrix

| Command | Host | Refusals (exit 6) |
|---|---|---|
| `orgai`, `tui`, `tui <run>` | own host; `project-<pid>` shared | continuing a chain claimed elsewhere (opening it read-only is allowed); a project being removed |
| `resume [run]`, `resume --now`, `resume --cancel-auto-resume`, `exec --continue` | own host; `project-<pid>` shared | chain claimed elsewhere; without a run: the newest continuable chain tip whose claim is free (others named), re-verified under the claim, retried up to 3 times on a race; a quarantined chain with uncertain evidence without `--after-crash` |
| `exec` | own host; `project-<pid>` shared | `execchain-<projectId>-<id>` busy |
| `init`, `projects create`, connection, model, library, settings commands | own short host | the operation's claim |
| `projects edit`, `org`, `team`, `permissions`, project `mcp`/`skills`, `knowledge`, `notes`, `kit` (per affected project), `outputs`, `worktrees`, `runs model` | own short host; `project-<pid>` shared | `setup-` claim, chain claim for `runs model`, `repo-usage` for uninstall, a stale project revision, a project being removed |
| `projects remove` | own short host | `project-<pid>` exclusive |
| `secrets init|reset|undelete|keep-removed` | own short host with `admission` exclusive instead of shared | `admission` busy |
| `status`, `runs list|show`, `projects list|show`, `usage show`, `secrets status`, `completions`, `help`, `--version` | none (hostless reader: reads files and probes locks; never writes, converts, settles or cleans) | never |
| `doctor` | metadata hostless; connection checks in an own short host | never |

A hostless reader on a folder without a committed `v2/` reads format 1. The `SNAPSHOT_NOTE` and "another orgai owns
this folder" texts go.

### 7.2 Status

`orgai status` prints the live sessions and the latest runs per project with live-elsewhere marks.
`--output-format json`: `sessions: [{ pid, hostInstanceId, hostKind, cwd, projectId?, command, startedAt, liveRuns }]`
replaces `host`; `hostState` is `'running'` when any session is live, else `'stopped'`.

### 7.3 TUI

- `/runs` lists every run of the project with live-elsewhere and quarantine marks; it and the "+N sessions" count
  refresh on a 2 s poll of the `v2/runs` directory stamp and the host registry.
- Enter on a run live elsewhere opens it read-only (record refreshed on stamp change), status line "Live in another
  orgai (<cwd>, pid). Read-only here."; composer, continue, `/model`, `/mode` and stop refuse with that text.
- `/sessions` lists live sessions. Quit confirm: "Quit and stop N run(s) of this session?".
- Exclusive vault operations are not offered (4.6); journals marked "needs attention" are listed in `/sessions`.

### 7.4 Help and docs

`orgai help`, the command table, exit code 6 ("busy in another orgai session: a conversation, a setup, a project
removal, a vault operation, or an older OrgAI"), `--after-crash`, `doctor`, `cli-standalone-default.md` (G4 and the
non-goal marked superseded), `docs/agent-notes/cli-host.md`, CLAUDE.md, `.orgai/ARCHITECTURE.md`, the self-help
corpus: in the activation phase.

## 8. Write-path inventory

A unit test scans `src/main` and `src/cli` for file writes (`writeFile*`, `appendFile*`, `rename*`, `rm*`, `rmdir*`,
`unlink*`, `mkdir*`, `mkdtemp*`, `cp*`, `copyFile*`, `link*`, `symlink*`, `truncate*`, `createWriteStream`, `open*`
with write flags, `fs/promises` `FileHandle` writes) and fails on any call site not in an allow-list that names the
lock, claim or ownership rule covering it. It catches new unclassified writers; check-to-write gaps and deferred
writers are covered by the operation tests of section 11, not by the scanner.

## 9. Security and trust

- **Metadata only restricts.** Advisory files (lock `.json`, host registry, worktree markers, `liveElsewhere`) never
  authorise a destructive, settling or integrating action; only acquiring the OS lock does, plus the consumer check,
  whose evidence can only refuse or, when missing, make the case uncertain (4.8). Automatic actions never touch
  worktrees this process does not hold (6.2).
- **Protected paths** (the self-control gate's control entries, `selfControlGate.ts:149-166`, code): today's entries
  (`run`, `secrets.json`, `codex`, `settings.json`, `auth-cwd`, `evolution`) are applied under `v2/` as well as at
  the folder root, plus `control`, `v2/vault.json`, the realpath of the cache lock folder,
  `realpath(gitCommonDir)/orgai-worktrees` and `orgai-repo.lock`, and each report worktree's `.git` file. Agent
  workspaces stay usable: `v2/quick/<chainId>/`, `v2/harness-workspace/<hostId>/`, `v2/tmp/skills/<hostId>-*` and
  `v2/mcp-builds/` are not protected as a whole; a run's protected set additionally includes every
  `v2/quick/<other chainId>/` except its own scratch folder. **Unverified** that the permission rules cover `.git`
  internals in every adapter and mode; phase 3 adds a test per adapter.
- Ids and names in paths are validated (run and chain ids, branch names, `HOST_INSTANCE_ID_RE`); file name and payload
  id must match or the entry is ignored. Every advisory string displayed goes through `sanitizeTty` with a cap.
- Lock files and folders: 0-byte check and folder trust (4.1).
- No listening socket: the CLI's dormant socket path (`daemon.secret`, `d-*.sock`, `listen: true`) is removed.

## 10. Desktop app

- Same stores, locks, `control/`, `v2/` tree and conversion on its own folder, with `"orgai-desktop/2"` and the fence.
- One instance: Electron's `requestSingleInstanceLock` (keyed by userData, so an old and a new desktop exclude each
  other too, code) plus `admission` exclusive for its lifetime. It no longer calls `acquireHostOwnership`.
- Repository, worktree and permission locks in the cache folder coordinate it with `orgai` sessions on the same
  repository.

## 11. Tests

Unit and integration (vitest, real child processes, mock adapter, no tokens):

- `osLock`: every measured behaviour of 4.1 on the CI runners (macOS, Windows, Linux); 0-byte shared, exclusive and
  probe; several processes taking shared at a cold start; `kill -9` during acquisition (no false 'free', no journal);
  `SIGSTOP`ed holder keeps its lock; a same-process probe of a held lock leaves an external contender excluded;
  non-zero, linked, WAL-sibling and foreign-owner lock files fail closed; deletion of a chain lock racing a waiter
  (POSIX inode, Windows `EBUSY`) with subject re-verification; reusable-key locks never deleted; folder trust with a
  permissive ancestor and (where the runner allows) an ancestor rename by another principal; Windows DACL by SID and
  transient sharing-violation retries; coordinator: shared refcount, claims fail at once in-process, probes bypass,
  reentrancy for a held lock, FIFO hand-off, jitter, cancellation at shutdown.
- Lock order: assertion on out-of-order acquisition; every flow of 4.2 through the real services with a recording lock
  layer (kit with linked projects and templates, team files and project skills in both directions, uninstall, setup
  proposals of every kind, library changes with linked projects, project removal), including the coordinator retry.
- `SharedJsonFile`: two processes x 200 `update`s end at 400; external writes seen; parse failure; unique tmp names;
  different fields of one project from two processes both survive; stale `saveFromRenderer` refused; a refused save
  with team-file effects writes no companion file; `mutateProject` on a removed id refuses and fan-out skips it; TUI
  hints merged from two sessions.
- Vault: two sessions setting different keys both survive; first vault created by A while B is open, B then reads it;
  reset refused beside another session; a host starting during a reset waits then exits 6; OAuth revoke during refresh
  stays revoked; both tokens in one write.
- Chains: conversion of runs linked only by a shared session id (middle run pruned) gives one `chainId`; dangling
  predecessors; cycles; two runs binding the same provider session after both started: one wins; concurrent `resume`
  of one run, of two members of one chain, `exec --continue`, auto-resume, `resume --now`, `--cancel-auto-resume`: one
  wins, others exit 6; two runs of one `execChainId` in one project refused, in two projects allowed, held across a
  `waitForReset` pause; stored-run writes refused while live elsewhere; late title, failed final write, paused
  auto-resume, exec finalisation, evolution flush keep the claim; an `exec` host exits only after its write queue
  drained; `usageSummaries` never writes; a deliberately paused run survives another session's housekeeping and resumes
  with `resume --now`; promotion with one claimed run creates no project; a pending project cannot be opened; a record
  without a summary is not read.
- Scratch: an MCP `allowBuild` start and a quick start suspended after allocation and before the first summary,
  beside another session's housekeeping: the folder survives.
- Conversion: crash at every step (1-7), then a second converter completes and a reader started meanwhile reads
  format 1 consistently; two converters at once; an old starter and an old reader (`ownership.ts`, `productMarker.ts`,
  `readOnlyStore.ts` of the last release tag and the last marker-aware dev build in temp modules, plus a full v0.1.6
  CLI read-only command) during each step: no format-2 file read or changed by them; a source change during step 4
  aborts at step 5; old desktop after following the delete-`run` hint changes nothing in `v2/`; path relocation of a
  migrated scratch conversation and an MCP build session, which then continue and run from `v2/`, while an old
  sweeper runs on the format-1 tree; the generic old-path scan fails on an unlisted field; power-loss simulation by
  dropping un-fsynced writes (fault-injecting fs layer).
- Consumers: kill only the host while a mock child keeps writing in the conversation and in a worktree: resume,
  worktree actions, scratch and owner-scoped sweeps refused; housekeeping twice does not delete the evidence; deleted
  evidence makes the case uncertain (TUI confirmation, `exec --continue` exit 6 without `--after-crash`); settlement then
  prune refused while the child lives; after the child exits all proceed.
- Journals: kill points between every pair of file changes of each 4.9 operation; a live session touching the resource
  before housekeeping recovers inline; recovery twice is idempotent; a resource at an unexpected generation leaves the
  journal "needs attention"; a removed project's journal does not re-create it.
- Agent workspaces: an agent reads and writes its own `v2/quick/<chainId>/`, `v2/harness-workspace/<hostId>/` and
  `v2/tmp/skills/<hostId>-*`; the same tools against another chain's scratch folder, `control/`, `v2/vault.json` and
  `v2/run` are denied.
- Projects: `project-<pid>` shared racing `projects remove` from a TUI, an `exec`, `orgai notes` and a library
  fan-out: nothing re-created; removal with a foreign live run refused.
- Worktrees: own-only automatic actions; nested subtree with a held descendant aborts; uninstall refused with another
  session in the repository; invalid branch names rejected.
- Multi-file operations: distinct output versions from two processes; skill rollback beside another process's skill
  change; MCP build rollback only its own staged dir; concurrent evolution commits in two processes; a capability
  review committed after another's change refused; notes index and bodies consistent; kit import paused after
  validation versus a library edit and an OAuth sign-in: the other side waits, no overwrite.
- Plan usage: two cold probes make one request; a probe owner killed mid-request releases.
- Write-path inventory (section 8). `message_run` `other-session`, `list_runs` notice, setup claim, admission wait,
  registry and status JSON, per-process logs, network-FS warning (simulated `statfs`), advisory strings sanitised.
- Removed or changed: CLI `wait: 'none'` ownership tests; `inprocHost.test.ts` "second host refused";
  `inprocHostRace.test.ts` (becomes "two hosts start at once, both run"); `ensureHost.test.ts` / `manage.test.ts`
  exit-6 cases; `cli.int.test.ts` "beside a running orgai"; snapshot-line tests.
- By hand once, result recorded: two real Codex app-servers on one home (6.5); Claude CLI and Codex exit on host pipe
  close (4.8).

e2e (token-free, mock adapter):

- New `e2e/cli-parallel.mjs`: one temp data folder, two temp git projects. TUI A (project 1), TUI B (project 2), TUI C
  (project 1) and an `orgai exec` (project 1) at once; each starts a mock run with an isolated report; `orgai status`
  lists 4 sessions; `/runs` in A shows C's run as live elsewhere and opens it read-only; `orgai resume` of C's run exits
  6; `orgai projects remove` of project 1 exits 6; quitting B leaves A's and C's runs running; `kill -9` of C (its mock
  child also killed), then a new `orgai` settles C's run and leaves A's live report worktree alone; after all quit,
  `runs list` shows every run once.
- New `e2e/cli-upgrade.mjs`: a format-1 folder made by a fixture writer (runs, a scratch conversation, an installed
  MCP build) converts on first start; read-only commands before conversion list every run; after conversion the
  format-1 files are byte-identical and the scratch conversation continues from `v2/`.
- Updated: `cli-tui.mjs`, `cli-readonly.mjs`, `cli-exec.mjs` (two execs at once), `separation.mjs` (a second `orgai`
  on B runs; the app still refuses B and the CLI still refuses A).
- `package.json` `e2e:free`, CLAUDE.md's e2e list and `scripts/e2e-select.mjs` (new paths → `cli-parallel`,
  `cli-upgrade`) in the same change.

## 12. Phases

Each phase passes the local gate (typecheck, the whole unit suite, build, `npm run test:scripts`, the e2e scripts of
its area, the Reviewer). Hot files take one claim at a time (CLAUDE.md).

1. **Primitives, dormant**: `osLock` with its tests on all runners, claims, session holds, transaction-lock order with
   the assertion and coordinators, `SharedJsonFile`, `withChainClaim` / `ChainWrite`, host claim and registry,
   admission, journals, consumer evidence and check, write-path inventory test (allow-list initially naming "single
   owner" for every site). Nothing calls them in production.
2. **Stores and operations on the new locks, still single-owner, still format 1**: the lock root is
   `<dataDir>/control/locks` from this phase on (never inside a data tree); every 4.4 store on `SharedJsonFile` (async,
   `revision`, `mutateProject`, save hook, undo rules, TUI hints union), the vault (6.7), all transaction locks of 4.2
   in their services, OAuth with `setMany`, per-chain write queue awaited, journals for 4.9 operations, permission rules
   async with tmp + rename. The single-owner gate is still in force; behaviour is unchanged.
3. **Activation (one change)**: `v2/` layout and conversion with relocation and both fences, per-run summaries and
   `chainId`, session bindings, chain and exec-chain claims in `RunManager` and `RunStore`, scratch allocation, quick
   runs and promotion, housekeeping, owner-scoped resources, consumer evidence and quarantine, worktree claims and
   own-only automation, project and setup claims, protected paths, `message_run` / `list_runs`, hostless readers for
   both formats, host claim and admission replacing `acquireHostOwnership` in CLI and desktop, the CLI matrix,
   `cli-parallel.mjs`, `cli-upgrade.mjs`, updated e2e scripts and the docs of 7.4.

## 13. Unverified

- Windows: SQLite locking through `node:sqlite`, DACL setup and ancestor checks, `GetDriveType`, lock-file unlink
  behaviour, no cwd check for consumers.
- Linux: lock behaviour on CI only.
- Network file systems: SQLite's own warning; detected and reported only.
- Concurrent bundled Codex app-servers on one home; Claude CLI and Codex exiting on host pipe close.
- The Claude spawn hook knowing the worktree branch before creation (6.2).
- Permission rules covering `.git` internals and the cache lock folder in every adapter and mode (9).
- Listing performance beyond the owner's Mac; clone support on the owner's disk for conversion speed.
- Consumer evidence completeness (4.8 limits).

## 14. Review resolutions

### 14.1 Draft 1 (Astra A1-A19, Argon Ar-*)

| Finding | Resolution (draft 3) |
|---|---|
| A1 stale `mkdir` reclaim, in-process fallback | 4.1 OS locks only, no reclaim, fail closed; 6.2 legacy lock only inside the OS lock |
| A2 heartbeat expiry, unconfirmed owners | 4.1 never by pid; `SIGSTOP` test |
| A3, Ar-H3 conversion order, readers | 4.7 separate `v2/` tree, copy then atomic rename, format-1 never changed |
| A4 lease per run | 4.3 chain claim by connected-component `chainId` |
| A5, Ar-C3 writes after teardown / by non-owners | 4.3 `ChainWrite`, per-chain write queue awaited |
| A6 stale whole-object saves | 4.4 `revision`, `mutateProject`, save-hook ordering |
| A7, A8, Ar-C4, Ar-H5 missed writers, multi-file operations | 3.5 inventory; 4.2 locks; 4.9 journals; 6.3; 8 |
| A9 project deletion | 6.3 `project-<pid>` with re-read |
| A10 worktree entry points | 6.2 own-only automation, subtree check |
| A11 forged metadata; sanitise vs normalise | 9; 5.1 |
| A12 vault vs registration | 4.6 exclusive admission before any store |
| A13 OAuth | 6.6 one vault entry, `setMany`, per credential owner |
| A14, Ar-H4 sweeps of live resources | 4.5 owner-scoped under `v2/`; 4.8 consumer check; 5.4 |
| A15, Ar-C2 phase order, desktop | 12; 10 |
| A16, Ar-H1 async locks, order | 4.1 async, FIFO; 4.2 claims vs ordered transaction locks |
| A17 plan-usage stampede | 6.4 |
| A18, A19, Ar-L1 CLI details, corrections | 7; 3 |
| Ar-C1 old readers | 4.7 `v2/` tree (old readers never see format 2) plus marker fence |
| Ar-H2 `runs/` collisions | 5.1 patterns; locks under `control/locks` (draft 4) |
| Ar-M1..M5 | 6.2, 9; 4.4; 4.5; 6.1; 4.5 |

### 14.2 Draft 2, Astra (round 2)

| # | Finding | Resolution |
|---|---|---|
| 1 | lock order impossible for real flows | 4.2: claims exempt (never wait), transaction locks reordered from the call graph, sorted keys, model calls outside locks with generation checks, flow list as integration tests |
| 2 | conversion relies on the reclaimable startup mutex | 4.7: safety comes from the separate `v2/` tree; the mutex is best effort with a live owner record; a source change during copy aborts before the commit rename |
| 3 | conversion durability | 4.7 step 4: fsync of files and dirs, manifest with hashes, validation before the atomic rename |
| 4 | reader check/use race | 4.7: format-1 files never change; readers pick by `v2/` existence |
| 5 | released CLI has no marker | 4.7: v0.1.6 reads frozen format-1 files only (stated, not fenced); fences are UX; tests use the real v0.1.6 commands |
| 6 | chainId misses session-id links | 4.3 connected components over both relations |
| 7 | CAS after save-hook side effects; deferred cleanup | 4.4 save-hook ordering, cleanup awaited under the lock |
| 8 | promotion and MCP install need recovery | 4.3 pending project + journal; 4.9 |
| 9 | scratch dir before reservation | 4.3 claim before the dir; dir keyed by chain; 5.4 |
| 10 | OS-wide temp cleanup | 4.5 owner-scoped dirs under `v2/tmp`; legacy names never touched |
| 11 | host death vs surviving children | 4.8 descendant snapshots, cwd check, refusals; tests |
| 12 | nested worktrees, legacy users | 6.2 subtree check; no automatic action on worktrees not held; confirmations name the unknown |
| 13 | admission upgrade | 4.6: exclusive only from a fresh short host before any store; desktop exclusive for life |
| 14 | kit check-to-write | 6.3 kit takes all entry locks before validating |
| 15 | SQLite init and mode | 4.1 never-written 0-byte files (measured), checks, ROLLBACK release, no WAL |
| 16 | Windows protection | 4.1 DACL setup and verification, fail closed, CI test |

### 14.3 Draft 2, Carbon (round 2)

| # | Finding | Resolution |
|---|---|---|
| C1 | 0-byte lock files, probe, DDL race, unlink inode split | Measured: shared, exclusive and probe work on 0-byte files when the read is `sqlite_schema` (Carbon's claim that the probe short-circuits without a lock did not reproduce: it reported "database is locked"); no DDL ever; connections closed between retries; deletion only for unique finished subjects with re-verification (4.1) |
| C2 | rank inversions, model call under lock | 4.2 rebuilt (claims exempt, call-graph order, sorted keys); evolution synthesis outside the lock |
| C3 | desktop fence text, sweep after deleting `run/`, `writeProductMarker` create-only, `acquireStartupLock` name, `/2` checks | 4.7 corrected texts; `v2/` tree; `overwriteProductMarker`; `acquireLegacyStartupMutex`; normalised marker reading |
| H1 | session-id chains, `execChainId`, scratch, promotion re-read and record update | 4.3 |
| H2 | capability reviews, skills undo/rollback, outputs methods, setup, team-files entry points | 3.5, 4.2, 4.4, 6.3 |
| H3 | OAuth one-write claim, sync hot paths | 6.6 `setMany`; 4.3 write queue awaited |
| H4 | project re-read after shared claim | 6.3 |
| M1 | wait budgets, jitter, FIFO | 4.1, 4.2 |
| M2 | admission upgrade | 4.6 |
| M3 | `.git` file of worktrees, cache realpath, terminal sanitising | 9, 4.1 |
| M4 | adversarial tests | 11 |
| L1 | `resume --now`, `--cancel-auto-resume` | 4.3, 7.1 |
| L2 | `tui-hints.json`; scanner primitives | `tui-hints.json` exists (`configApi.ts:37`), kept; scanner list extended (8) |

### 14.4 Draft 3, Astra (round 3)

| # | Finding | Resolution (draft 4) |
|---|---|---|
| 1 | conversion creates `v2/` before committing | 4.7: coordination in `control/`, never published; `v2/` committed only by `FORMAT.json` inside the staging rename |
| 2 | lock cycle team files ↔ skills; reentrancy | 4.2: `library` and `team-<pid>` coarse locks, coordinators take the whole set; 4.1 reentrancy, claims never queue |
| 3 | persisted paths into the old tree | 4.7 step 4: typed relocation table plus a failing generic scan; tests in 11 |
| 4 | consumer evidence incomplete and deleted | 4.8: evidence written before the first spawn, kept until every descendant is gone, missing = uncertain, quarantine applied to prune, sweeps, removal and resume; limits stated |
| 5 | journals vs already-running sessions | 4.9: inline recovery under the resource's locks before any read, generation checks, "needs attention", idempotent, no resurrection |
| 6 | legacy repo lock does not exclude old binaries | 6.2: claim withdrawn; mixed-version use keeps the legacy lock's guarantees only |
| 7 | protecting `v2/` blocks agent workspaces | 9: today's entries under `v2/`, `control/`, workspaces unprotected, other chains' scratch protected |
| 8 | ancestor replacement | 4.1 folder trust over the ancestor chain, fail closed |
| 9 | MCP build start outside the reservation | 4.3 `allocateScratch(chainWrite)` for both start paths; `buildWorkspace` relocated and swept by chain |
| 10 | header validation would close descriptors | 4.1: 0-byte only, checked by `lstat`, never opened outside SQLite |
| 11 | provider session id known only later | 4.3 binding at every point a session id is recorded, `O_EXCL` binding file |

### 14.5 Draft 3, Carbon (round 3)

| # | Finding | Resolution (draft 4) |
|---|---|---|
| C1 | `v2/` created before the rename | as Astra 1 |
| C2 | `v2` protection breaks workspaces | as Astra 7 |
| C3 | kit, team files ↔ skills, uninstall, setup proposals, skill evaluations under a lock, session holds mid-session | 4.2 coarse locks and coordinators with the flows listed as tests; model steps outside; session holds never wait and may be taken at any point |
| C4 | vault reload-before-write, stale reads, first vault, async | 6.7 |
| H5 | `children.json` deleted while descendants live; Windows headless | 4.8, 5.4; `--after-crash` |
| H6 | background-only journal recovery | 4.9 inline recovery |
| H7 | FIFO vs shared and claims; chain lock unlink while open; reusable keys; Windows DACL SIDs and transient errors | 4.1 coordinator, unlink after close by housekeeping, reusable keys listed as never deleted, SID grants, retries |
| H8 | deliberate pause treated as crash; `allowBuild` scratch; exec-chain keying and pauses; session id timing; record fallback | 5.3; 4.3 |
| H9 | project commands and fan-out vs removal | 6.3, 7.1; `mutateProject` refuses removed ids |
| M10 | permission lock keying and truncating writes | 4.2 order 9, 6.3 |
| M11 | `tui-hints.json` outside `v2/`, whole-snapshot writes | 4.4, 4.7 |
| L12 | phase 2 lock root; missing tests | 12 phase 2 uses `control/`; 11 |
