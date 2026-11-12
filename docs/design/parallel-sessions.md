# Parallel `orgai` sessions: design spec

Status: draft 3, 2026-11-12. Draft 1 was reviewed by GPT Astra and Gemini Argon, draft 2 by GPT Astra and Gemini Carbon;
all four reviews BLOCKED. Resolutions are in section 14. Owner direction (2026-11-11): "mirror Claude Code / Codex":
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
  process is never taken over; work left by a crashed process is not resumed or destroyed while processes it started
  may still be running.
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

- **Create**: a missing lock file is created `open(O_CREAT|O_EXCL, 0600)` (losing the race is fine) and never
  written. Before every use the file is checked: regular file (`lstat`, no link or reparse point), owned by this user
  (POSIX), size 0 or a valid SQLite header with journal mode not WAL and no `-wal`/`-journal` sibling. Anything else
  fails closed naming the path.
- **Exclusive**: `BEGIN EXCLUSIVE`. **Shared**: `BEGIN` + `SELECT count(*) FROM sqlite_schema`. **Release**:
  `ROLLBACK`, close. **Probe** (`'held' | 'free' | 'missing'`): open read-only (never creates), shared read; busy =
  an exclusive holder exists. Hostless readers use only probes.
- **Waiting**: try, and on `SQLITE_BUSY` close the connection, sleep (5 ms doubling to 100 ms, ±25 % jitter), reopen
  by path and try again until `waitMs`. Within a process, acquisitions of one path go through a FIFO queue so tasks
  hand off in memory instead of polling. Every other error fails closed; there is no in-process fallback.
- **Never by pid**: no pid, start time, heartbeat or age decides that a holder is gone. A suspended holder keeps its
  lock (tested with `SIGSTOP`).
- **Deletion**: singleton locks are never deleted. A lock file whose subject is unique and finished may be deleted
  (host locks after their host is gone, chain locks when the chain is removed, 5.2) because every acquirer of such a
  lock re-verifies its subject after acquiring and gives up when it is gone; a racer that locks an unlinked or a
  re-created file therefore finds nothing to act on. On Windows an unlink that fails with `EBUSY`/`EPERM` is left for
  a later sweep.
- **Advisory info**: next to a lock, `<lock>.json` may hold `{ pid, hostInstanceId, ownerCwd, since }` for messages.
  It never decides anything (section 9) and every string from it is passed through `sanitizeTty` with a length cap
  before display.
- **Network file systems**: SQLite's locks are not reliable over NFS/SMB (SQLite documentation, unverified here).
  The first start on a folder and `doctor` report a data or lock folder on a network file system (`statfs` on
  macOS/Linux, `GetDriveType` on Windows, unverified on Windows).

Lock folders: `<dataDir>/v2/run/locks/` (data-folder locks) and `<user cache>/orgai/locks/` for locks keyed by a
path outside the data folder (`~/Library/Caches`, `%LOCALAPPDATA%`, `${XDG_CACHE_HOME:-~/.cache}`), named
`<kind>-<sha256(canonical path)[0..32]>.lock` with `pathKey` canonicalisation (`repoLock.ts:122`, code). Both folders
are 0700 on POSIX; on Windows the folder's DACL is set to the current user and SYSTEM with inheritance removed
(`icacls` by absolute path, as `restrictDaemonSecretAcl` does today, `ownership.ts:1091-1118`) and verified before
use; failure fails closed (unverified on Windows; tested in CI with a deliberately permissive parent).

### 4.2 Claims, transaction locks and their order

Two kinds of lock, so the order can be enforced:

- **Claims** are never waited for (`waitMs = 0`): they either succeed at once or the operation is refused. A claim
  can therefore never take part in a deadlock, and claims are exempt from the order. Claims: `host-<id>`, exclusive
  `admission` (4.6), `chain-<chainId>`, `execchain-<execChainId>`, `setup-<pid>`, exclusive `project-<pid>`,
  `worktree-<repo>-<branch>`, exclusive `repo-usage-<repo>`, `housekeeping`.
- **Session holds** are shared locks taken once per session before any transaction lock and held for the session:
  shared `admission` (the only one that waits, 4.6), shared `project-<pid>`, shared `repo-usage-<repo>`.
- **Transaction locks** wait (bounded) and are acquired in this strict order; several locks of one row are taken in
  sorted key order. A debug assertion throws on an out-of-order acquisition, and integration tests drive every real
  nested operation (not just isolated acquisitions) through a recording lock layer.

| Order | Transaction lock | Wait | Held by |
|---|---|---|---|
| 1 | `evolve-<pid>` | 60 s | evolution commit (apply, rollback, `afterRun` ledger write) |
| 2 | `kit` | 60 s | kit import, validation through the last write |
| 3 | `capability-reviews-<pid>` | 60 s | review commit, dismiss, restore, refresh, undo |
| 4 | `skills` | 60 s | library and project skills, undo, proposal apply/rollback |
| 5 | `templates` | 60 s | org templates |
| 6 | `mcp-build-<entryId>` | 60 s | MCP build install, rollback |
| 7 | `oauth-<credentialOwner>` | 60 s | refresh, revoke, retarget, authorise commit (network inside) |
| 8 | `plan-usage-<key>`, `models-discovery`, `codex-start` | 60 s | single-flight network / process start |
| 9 | `team-files-<pid>` | 60 s | every team-files entry point, including the project save hook and its cleanup |
| 10 | `repo-<repo>` (+ legacy `mkdir` lock inside, 6.2) | 60 s | git operations, `.orgai/` and `CLAUDE.md` writes |
| 11 | `outputs-<pid>` | 15 s | every outputs mutation |
| 12 | `knowledge-<pid>` | 15 s | knowledge graph |
| 13 | `notes-<pid>`, `engagement-<pid>`, `staffing-<pid>`, `skill-evaluations-<pid>` | 15 s | per-project data |
| 14 | `permissions-<project folder>` (cache) | 15 s | `permission-rules.json` and `.claude/settings.local.json`, taken inside `permissionRules.ts` |
| 15 | `vault` | 15 s | every vault read-decide-commit |
| 16 | `config` | 15 s | every `SharedJsonFile` update (4.4) |

No transaction lock is held across a model call: evolution's hybrid synthesis and capability reviews run outside
their locks on a snapshot and commit under the lock only if the ledger or review generation they started from is
unchanged (else they refuse with a "changed meanwhile, run again" message, never overwrite). Order 7-8 are the only
locks held across a network call or a process start, and nothing below them is waited for while the call is in
flight.

Flows checked against the order (each is an integration test): evolution 1→4→9→10→16; team-files operation 9→10→16;
kit 2→4→6→7→15→16; OAuth 7→15→16; plan usage 8→16; skills with a save hook 4→9→10→16; knowledge adding a note 12→13;
capability apply 3→4→9→16; setup proposal 9→10→14→16; worktree integrate: claim (exempt) then 10.

### 4.3 Chains and the chain claim

- **Chain identity.** New persisted `RunSummary.chainId`. A new run's own id; a continuation copies its predecessor's.
  Conversion (4.7) computes it with the existing membership rules: connected components over `resumedFrom` edges and
  shared non-empty `sessionId`s (union-find, cycles harmless), id = the component's oldest member (`startedAt`, then
  id). Validated `^run_[A-Za-z0-9_-]{1,80}$`. A run whose provider session id already belongs to another chain is
  refused at start (a test asserts `chainOf` and `chainId` agree on every stored set).
- **One writer per chain.** The process that starts or continues a run claims `chain-<chainId>` before it chooses what
  to start and keeps it until the chain is settled in that process: the run is terminal, its late title arrived or was
  abandoned (60 s cap), evolution flush and exec finalisation are done, no paused auto-resume timer is armed, and the
  per-chain write queue has drained with every write succeeded. `RunManager` serialises summary and record writes on
  that queue and awaits it (and `recordRunInStaffingProfile`, `outputs.runEnded`) before releasing; shutdown drains
  the queues. A failed final write keeps the claim until process exit.
- **Exec chains.** A run started with `overrides.execChainId` also claims `execchain-<execChainId>` for its lifetime,
  so two runs of one exec chain cannot spend its budget at once.
- **RunStore enforces it.** Every mutation (`create`, `upsert`, `patchSummary`, `setUsage`, `saveRecord`,
  `saveImage`, `moveToProject` (summary **and** record), `remove`) takes a `ChainWrite` token, created only by a held
  claim or by `withChainClaim(chainId, fn)` (claim, re-read the chain from disk, verify it still exists, run `fn`,
  release). `usageSummaries` back-fill is in memory only.
- **Continue, resume, `exec --continue`, auto-resume, `resume --now`, `resume --cancel-auto-resume`, `tui <run>` with
  input**: claim the chain; busy refuses with exit 6: "This conversation (R3, run_abc) is live in another orgai (<cwd>,
  pid). Use that one, or quit it first." Under the claim, re-read the chain, recompute the target with today's rules
  (`newestContinuable` / `canContinueIn`) and the remaining budget. If the chain's last holder crashed, the consumer
  check (4.8) runs first.
- **Stored-run writes from another session** (`runs model`, permission mode, `stop` of a paused run, delete, move):
  `withChainClaim`; busy refuses with the same text.
- **Quick runs.** Run id and chain id are minted and the chain claimed before the scratch folder is created; scratch
  folders live at `v2/quick/<chainId>/` (continuations share it). **Promotion** claims every chain of the runs it
  moves (sorted), re-reads membership under the claims, refuses if any member is non-terminal or paused, writes a
  journal (4.9), creates the project with `pending: true` while holding an exclusive `project-<newId>` claim (pending
  projects are hidden and cannot be opened), moves summaries and records, clears `pending`, releases. Recovery rolls
  back or completes from the journal.

### 4.4 Shared JSON files: `SharedJsonFile<T>`

For: `projects.json`, `settings.json`, `skill-library.json`, `mcp-library.json`, `connector-presets.json`,
`models.json`, `model-prices.json`, `retained-run-projects.json`, `org-templates/templates.json`,
`<userDataDir>/tui-hints.json`, `run/plan-usage.json`.

- `read()` is a cached parse revalidated by `stat` (size, mtimeNs, ino) on every call; services that cached derived
  copies (`ConnectionService.discovered`, `CommunityPrices`, settings listeners, the project tier context) read
  through it and re-derive on change.
- `update(fn): Promise<T>` takes `config` (order 16), re-reads from disk, applies `fn`, writes `<file>.tmp-<hostId>-
  <random>` (`wx`, fsync where the store fsyncs today), renames. `durableFs` no longer unlinks a shared fixed tmp name.
- A parse failure keeps the last good copy for reads and refuses `update` naming the file.
- **Projects** carry `revision` (+1 per write). `mutateProject(id, fn)` applies `fn` to the fresh copy; every internal
  caller of `save`/`update` moves to it. Whole-object saves (`saveFromRenderer`, the CLI's project edit) carry the
  revision they read and are refused on a mismatch ("This project changed in another orgai session. Reload and try
  again."). Settings mutate by patch; libraries and presets per entry. `migrateAll` runs inside `update`, only when the
  file version requires it.
- **Save hook (team files).** A project save that has team-file effects: take `team-files-<pid>` (9); compute the
  effects without writing; take `config` (16), check the revision against a fresh read, write `projects.json`,
  release `config`; then apply the computed team-file writes (journaled, 4.9) and run the cleanup that
  `commitAfterSave` scheduled with `setImmediate` (now awaited, not deferred); release `team-files-<pid>`. A refused
  save therefore writes no companion file; the effects belong to the committed revision.
- **Undo and rollback** (`CapabilityService.undo`, `SkillService.undoImport`, proposal rollback, team-files undo)
  record the project revision and the fields they changed; they patch only those fields through `mutateProject` and
  are refused if another writer changed them since ("changed in another session; undo would overwrite it").
  `snapshotForProposal` snapshots only skills and their role grants.

### 4.5 Host claim and registry

- Each host (TUI, exec, management command, desktop) claims `host-<hostInstanceId>` for its lifetime and writes
  `v2/run/hosts/<hostInstanceId>.json` (`{ pid, hostInstanceId, hostKind, appVersion, ownerCwd, projectId?, command,
  startedAt }`, advisory). A host is live exactly when its lock is held (probe).
- Owner-scoped resources carry the `hostInstanceId` in their name and live under `v2/` (never the OS temp dir or a
  shared location): `v2/tmp/skills/<hostId>-*` (replacing `orgai-skills-*` in the OS temp dir), `v2/tmp/codex-catalog/
  <hostId>-<key>.json`, `v2/auth-cwd/<hostId>/`, `v2/harness-workspace/<hostId>/`, `.undo-<hostId>`, tmp files,
  logs. They are swept only when that host's lock is free **and** the consumer check (4.8) passes. Legacy
  `orgai-skills-*` dirs in the OS temp dir are never touched by new code.

### 4.6 Admission

- Every host takes `admission` shared (waiting up to 30 s, printing "Waiting for another orgai to finish <operation>")
  before opening any store, and holds it for life.
- Operations that must be alone: conversion (4.7), vault `init` over an existing vault, `reset`, `undelete`,
  `keep-removed`, key rotation. They run only as their own CLI command, whose process claims `admission` exclusive
  **before** opening any store and refuses with exit 6 naming the sessions when busy. They are not offered inside a
  TUI ("Run `orgai secrets reset` in a terminal with no other orgai."). A live host never drops its shared hold.
- The desktop claims `admission` exclusive for its lifetime (it never shares its folder), so its vault operations are
  already alone.

### 4.7 Format 2: a new tree, conversion and fences

**Layout.** Format-2 data lives in `<dataDir>/v2/`: `v2/projects.json`, `v2/settings.json`, every other store, `v2/runs/`
(per-run files, 5.1), `v2/quick/`, `v2/codex/` (the Codex home), `v2/run/` (locks, hosts, journals), `v2/logs/`. The
format-1 files in `<dataDir>/` are left exactly as they were and never written again by new code. Consequences:

- Old code (any version) only reads and sweeps format-1 paths (`<dataDir>/runs`, `runs.json`, `quick/`, `run/`,
  `auth-cwd/`, `project-skills/*/.undo`, ...), so it cannot read, sweep or overwrite format-2 data, whatever fences it
  honours. A downgraded desktop that follows its own "delete `<dataDir>/run`" advice (`ownership.ts:136-138`, code)
  sees the frozen format-1 state and can only damage that.
- Released CLI v0.1.6 (tag 2026-11-05, code) uses the desktop's folder and has no product marker check; its hostless
  readers read the frozen format-1 files (a stale snapshot, harmless). Its host refuses the fence (below; v0.1.6's
  `ownership.ts` has the same unusable-record rule, code).

**Fences** (for a clear refusal where the old code checks; not for safety):

- Product marker: `{ "product": "orgai-cli/2", "version": 1, "format": 2 }` (desktop `"orgai-desktop/2"`), written by
  a new `overwriteProductMarker` (durable tmp + fsync + rename; `writeProductMarker` is create-only,
  `productMarker.ts:55-64`). `readProductMarker` in new code normalises `"…/2"` to `{ product, format: 2 }` so every
  existing product check (`insideCliMarkedFolder`, `checkCliFolder`, `desktopFolderRefusal`, ...) keeps working.
  Marker-aware old CLIs (unreleased dev builds since 2026-11-08) refuse it as unknown (exit 2).
- `<dataDir>/run/daemon.json` fence `{ "format": 2, "note": "This folder is used by a newer OrgAI. Older versions cannot
  open it; update OrgAI." }`: old hosts (CLI and desktop, v0.1.6 included) refuse it as `daemon_json_unreadable`
  (`ownership.ts:386-410, 594-602`, code). The old CLI says exit 6 "orgai is already running"; the old desktop shows
  "OrgAI could not start" with the delete-`run` hint (`index.ts:348-361`); old `doctor` prints "daemon.json could not
  be read: unexpected shape". Wrong but safe given the separate tree. New hosts re-create the fence if it is missing.

**Conversion** (first new binary on a folder without `v2/`; a CLI process runs it before opening anything; the desktop
the same at start):

1. Take the legacy startup mutex with a new `acquireLegacyStartupMutex(runDir)`: `mkdir run/startup.mkdir` with a valid
   `owner.json` (`{ pid, processStartTime, hostInstanceId, createdAt }`), refreshed every second while held, never
   calling `readDaemonFileState` (`withStartupMutex` does, `ownership.ts:510-516`). Old starters never rob a live,
   confirmed owner (code); the case where they could (unconfirmed start time, or a delayed reclaimer) is covered by
   step 5's check. Take `admission` exclusive (in `v2/run/locks`, created first).
2. Inspect `run/daemon.json`: missing, or the fence: go on. A parseable record whose pid is alive or unconfirmed:
   refuse exit 6 "An older OrgAI is running on this folder (<cwd>, pid). Quit it, then start again." Dead: go on.
   Unusable and not the fence: refuse naming the file.
3. Write the fence (durable).
4. Record a source manifest (path, size, mtimeNs, ino of every format-1 file read), copy into `v2.tmp-<hostId>/`
   (APFS/ReFS clone where available, else copy), transform there (`runs.json` → per-run summaries with sanitised and
   normalised fields and `chainId`s; move per-run records into `runs/`; scratch folders into `quick/<chainId>/`), fsync
   every written file and directory, write `v2.tmp-<hostId>/MANIFEST.json` with counts and SHA-256 of every JSON file,
   and re-read and validate everything against it.
5. Re-check the source manifest against the format-1 files and the fence content and the mutex owner token: any
   difference means an old process touched the folder meanwhile: discard `v2.tmp-*`, refuse ("Another OrgAI changed
   this folder during the upgrade; quit it and start again").
6. Rename `v2.tmp-<hostId>` to `v2` (atomic), fsync `<dataDir>`. This is the commit point.
7. Write the format-2 product marker (durable). Release the mutex and `admission`.

Recovery: `v2/` exists → format 2 (a missing marker or fence is re-written); a leftover `v2.tmp-*` whose host lock is
free is deleted and conversion restarts. Readers: `v2/` exists → read it; else read format 1 (today's reader). A reader
that started on format 1 keeps reading consistent format-1 files (they never change). Format-1 files are kept; `doctor`
reports their size; a later release deletes them after one release of overlap. Downgrade is not supported; `doctor`
says so.

### 4.8 Consumers: processes a host started

A host's death (its lock freed) does not prove that the agents, shells, git or Codex processes it started are gone.

- Each host keeps `v2/run/hosts/<hostId>.children.json` current: every 5 s and on every spawn, the list of its
  descendant processes (pid and start time) from the process table reader `shutdown.ts` already uses (`ps -A -o
  pid=,ppid=,stat=,lstart=`; Windows CIM `Win32_Process`, code), plus each run's chain id and worktree paths.
- **Consumer check** before acting on what a dead host left (resuming its chain, any user action on its worktrees,
  sweeping its owner-scoped dirs): no recorded descendant is still alive with the same start time, and (macOS/Linux)
  no process has its working directory inside an affected worktree (`lsof -a -d cwd -Fn`, measured on macOS). If
  either finds a process, the action is refused: "Processes started by an earlier orgai session are still running in
  this conversation (pid …). Stop them or wait, then try again." Windows has no cwd check; there the resume of a
  crashed chain asks for confirmation instead.
- The check is evidence, not proof (a process can escape the snapshot interval or change cwd); tests kill only the
  host while a mock child keeps writing and assert the refusal. Unverified: that the Claude CLI and Codex app-server
  exit when their host's pipes close.

### 4.9 Journals for multi-file operations

Operations that change more than one file write `v2/run/journal/<op>-<id>.json` (durable, `{ op, hostId, steps,
previous }`) before their first change and delete it after their last. Housekeeping recovers a journal whose host lock
is free (and consumer check passes) by completing or undoing it, per operation: quick promotion, MCP build install and
rollback (staged and old dirs), skill proposal apply and rollback, evolution apply and rollback, team-files apply,
output version commit, project removal, kit import. Each has kill-point tests between every pair of file changes.

## 5. Runs

### 5.1 Layout

- `v2/runs/<id>.summary.json` (the `RunSummary` with `chainId`), `v2/runs/<id>.json` (record), `v2/runs/<id>/images/`.
  Written only with a `ChainWrite` token; tmp + rename; **summary first** on creation, **summary last** on deletion,
  so a record or image dir without a summary is never live.
- Entry patterns (listing and sweeps match only these): summaries `^run_[A-Za-z0-9_-]+\.summary\.json$`, records
  `^run_[A-Za-z0-9_-]+\.json$` (not summaries), image dirs `^run_[A-Za-z0-9_-]+$`, tmp files
  `\.tmp-<hostId>-[0-9a-f]+$`.
- `RunStore.all()` lists summaries with a per-file stat cache and a directory-mtime short cut; target 1,000 summaries
  under 50 ms warm on the owner's Mac (measured when the phase-1 test lands).
- Every summary read is sanitised (split out of the crash normaliser); crash normalisation is 5.3.
- Run numbers (R1, ...) are derived and can shift after pruning; actionable messages also name the run id.

### 5.2 Removing runs

Prune (at every run end and in housekeeping), project removal, orphan-project removal and delete: per chain,
`withChainClaim` (busy: skip); under it re-read, skip unless every member is terminal, delete images, record, summary
(in that order); when no member is left, delete the chain's lock file. Prune at run end runs after the ending run's own
claim is released. Retention is the existing per-project `prune(keepFor)`.

### 5.3 Crash settlement

No constructor normalisation. A non-terminal summary whose chain claim is held by this process is live here; held by
another: live elsewhere (`liveElsewhere`, display only); free: a crash leftover, shown normalised in memory and
settled (claim, re-read, normalise, write, release) by housekeeping. Settlement is metadata only; resuming such a chain
runs the consumer check (4.8).

### 5.4 Housekeeping

Runs in each new host after it is ready, in the background, under a `housekeeping` claim (another process already
sweeping: skip). Every row re-reads what it acts on inside its section.

| Sweep | After |
|---|---|
| crash settlement | 5.3 |
| journals | 4.9 |
| `prune(keepFor)`, orphan projects | 5.2; orphan-project removal re-reads `projects.json` and the retained list; project removal writes both in one `config` section |
| orphan records / image dirs | entries without a summary (5.1 order makes them never live) |
| scratch folders `v2/quick/<chainId>/` | chain claim free and no summary of that chain references it |
| owner-scoped dirs and files (4.5), `.undo-<hostId>`, `v2.tmp-*` | host lock free and consumer check passes |
| host registry, `children.json`, host lock files | host lock free |
| worktree markers | branch no longer exists |
| logs | 6.8 |

## 6. Runtime

### 6.1 RunManager

- In-memory maps describe this process's runs. `list_runs` adds "N runs of this project are live in other orgai
  sessions (not reachable)"; `message_run` to one returns the new result `other-session` instead of `not-live`.
- Writes go through the per-chain write queue (4.3); `emit` and `teardown` enqueue and the queue is awaited at
  settlement and shutdown.

### 6.2 Worktrees and repositories

- `repoLock` becomes the OS lock `repo-<repo>` (order 10) and keeps taking the legacy `mkdir` lock inside it, so old
  binaries still exclude new ones on git operations; the in-process fallback goes.
- A report's process claims `worktree-<repo>-<branch>` before the report may edit (Claude: in the spawn hook that
  decides isolation; Codex: when it creates the worktree) and holds it until integrated or discarded; advisory marker
  `<gitCommonDir>/orgai-worktrees/<branch>.json`. Branch names validated `^worktree-agent-[A-Za-z0-9_-]{1,80}$`.
  **Unverified** that the Claude hook knows the branch before the SDK creates it; if not, the claim is the first
  action of the report's first tool call, and until then the worktree counts as unowned (next rule).
- **Automatic actions touch only this process's own worktrees.** Worktrees it does not hold (another session's,
  crashed sessions', unmarked or legacy ones) are never committed, integrated, discarded or moved automatically:
  `reconcileLeftovers` reports them without committing; `integrate_worktrees` integrates only worktrees this run holds
  plus leftovers the user approves on a card. User-initiated maintenance on a worktree requires its claim free, the
  consumer check, and a confirmation that names what is unknown ("an older OrgAI version may be using it").
- Nested worktrees: an operation on a worktree checks its whole subtree first and aborts if any descendant is held
  elsewhere or cannot be evacuated.
- `uninstallRepo` claims `repo-usage-<repo>` exclusive, runs the consumer check on every worktree and asks for a
  confirmation that names older versions as undetectable.

### 6.3 Projects, setup and project-folder writes

- A host takes `project-<pid>` shared for each project it opens or has a live chain in, then **re-reads `projects.json`**
  and gives up (onboarding in the TUI, refusal elsewhere) if the project is gone. Removal claims it exclusive and
  refuses naming the sessions; under it, journaled (4.9), runs (5.2), secrets, skills and project data are removed.
- Setup-like runs (setup, org change, `org evolve`, Team assistant applying team files, Chat's targeted setup
  proposals) claim `setup-<pid>`: "Setup for <project> is open in another orgai (<cwd>, pid). Finish it there first."
- Setup's `writeArchitecture` writes under `repo-<repo>` by tmp + rename. Permission rules take `permissions-<folder>`
  inside `permissionRules.ts` (`addRules`, `removeRule`), so every caller is covered.
- Team files: every mutating entry point (3.5 list) under `team-files-<pid>` then `repo-<repo>`.
- Evolution: commit under `evolve-<pid>` with generation check (4.2). Capability reviews: model call outside,
  commit under `capability-reviews-<pid>`; `reviewStore.ts` uses unique tmp names.
- Outputs: every mutation listed in 3.5 under `outputs-<pid>`; version numbers chosen inside the lock.
- Kit import: takes `kit` and then the locks of every entry it will change, in order, before validating the target
  digest, and keeps them through the writes.
- Two work runs in one project are allowed; starting one prints a notice when another session has a live run there.

### 6.4 Spend and plan usage

No cross-run cap is added. The plan-usage probe takes `plan-usage-<connectionKey>` (order 8), re-reads
`run/plan-usage.json` (keyed by connection and account), probes only if older than 60 s, writes under `config`,
releases; a crash releases the lock (OS). Each process still probes only when it has no live run.

### 6.5 Codex

- `withCodexStartLock` adds `codex-start` (order 8) around the start (two starts on one home race on Codex's SQLite,
  `codexAppServer.ts:57-60`, code). Catalog files are per host (4.5).
- Running app-servers share `v2/codex/`; Codex keeps its own WAL SQLite and locks (measured layout of `~/.codex`;
  **unverified** for the bundled version with concurrent app-servers; checked by hand in phase 3 and recorded).
- Codex sign-in is Codex's own `auth.json` under its home (`connections/service.ts:934-1005`, code).

### 6.6 MCP OAuth

- `oauth-<credentialOwner>` (order 7) covers refresh, revoke, retarget/removal and the authorisation commit. Tokens
  and their `generation` and `expiresAt` are stored together in one vault entry written by a new
  `SecretStore.setMany` (one `vault` write); the config's `McpOAuthConfig` keeps only display fields, written after
  the vault under `config`. A refresh whose base generation changed uses the stored tokens instead.
- New tokens are saved first after a token response; a crash between the provider rotating a refresh token and that
  save loses it (the user signs in again; documented).

### 6.7 Vault

`vault` (order 15) covers every read-decide-commit: open-time reconcile and legacy retirement, creation, writes,
recovery. Exclusive operations hold `admission` exclusive from before the store opens (4.6).

### 6.8 Logs

Each process writes `v2/logs/orgai-<YYYYMMDD-HHMMSS>-<hostId>.log` (2 MB, one rotation); retention: newest 20 files
or 14 days, never a live host's. The desktop keeps one log as today (in `v2/logs/main.log`). `doctor` names this
process's file; the TUI `/logs` (run logs) is unchanged.

## 7. CLI

### 7.1 Command matrix

| Command | Host | Refusals (exit 6) |
|---|---|---|
| `orgai`, `tui`, `tui <run>` | own host; `project-<pid>` shared | continuing a chain claimed elsewhere; opening it read-only is allowed |
| `resume [run]`, `resume --now`, `resume --cancel-auto-resume`, `exec --continue` | own host | chain claimed elsewhere; without a run: the newest continuable chain tip whose claim is free (others named), re-verified under the claim, retried up to 3 times on a race; consumer check for a crashed chain |
| `exec` | own host | `execchain-<id>` when given and busy |
| `init`, `projects create|edit`, `org`, `team`, `permissions`, `connections`, `models`, `mcp`, `skills`, `knowledge`, `notes`, `kit`, `settings`, `outputs`, `worktrees`, `runs model` | own short host | the operation's claim (`setup-`, chain for `runs model`, `repo-usage` for uninstall) or a stale project revision |
| `projects remove` | own short host | `project-<pid>` exclusive |
| `secrets init|reset|undelete|keep-removed` | own short host, `admission` exclusive first | `admission` busy |
| `status`, `runs list|show`, `projects list|show`, `usage show`, `secrets status`, `completions`, `help`, `--version` | none (hostless reader: reads files and probes locks; never writes, converts, settles or cleans) | never |
| `doctor` | metadata hostless; connection checks in an own short host | never |

A hostless reader on a folder without `v2/` reads format 1. The `SNAPSHOT_NOTE` and "another orgai owns this folder"
texts go.

### 7.2 Status

`orgai status` prints the live sessions and the latest runs per project with live-elsewhere marks.
`--output-format json`: `sessions: [{ pid, hostInstanceId, hostKind, cwd, projectId?, command, startedAt, liveRuns }]`
replaces `host`; `hostState` is `'running'` when any session is live, else `'stopped'`.

### 7.3 TUI

- `/runs` lists every run of the project with live-elsewhere marks; it and the "+N sessions" count refresh on a 2 s
  poll of the `v2/runs` directory stamp and the host registry.
- Enter on a run live elsewhere opens it read-only (record refreshed on stamp change), status line "Live in another
  orgai (<cwd>, pid). Read-only here."; composer, continue, `/model`, `/mode`, stop refuse with that text.
- `/sessions` lists live sessions. Quit confirm: "Quit and stop N run(s) of this session?".
- Exclusive vault operations are not offered (4.6).

### 7.4 Help and docs

`orgai help`, the command table, exit code 6 ("busy in another orgai session: a conversation, a setup, a project
removal, a vault operation, or an older OrgAI"), `doctor`, `cli-standalone-default.md` (G4 and the non-goal marked
superseded), `docs/agent-notes/cli-host.md`, CLAUDE.md, `.orgai/ARCHITECTURE.md`, the self-help corpus: in the
activation phase.

## 8. Write-path inventory

A unit test scans `src/main` and `src/cli` for file writes (`writeFile*`, `appendFile*`, `rename*`, `rm*`, `rmdir*`,
`unlink*`, `mkdir*`, `mkdtemp*`, `cp*`, `copyFile*`, `link*`, `symlink*`, `truncate*`, `createWriteStream`, `open*`
with write flags, `fs/promises` `FileHandle` writes) and fails on any call site not in an allow-list that names the
lock, claim or ownership rule covering it. It catches new unclassified writers; check-to-write gaps and deferred
writers are covered by the operation tests of section 11, not by the scanner.

## 9. Security and trust

- **Metadata only restricts.** Advisory files (lock `.json`, host registry, `children.json`, worktree markers,
  `liveElsewhere`) never authorise a destructive, settling or integrating action; only acquiring the OS lock does,
  plus the consumer check (whose evidence can only refuse). Automatic actions never touch worktrees this process does
  not hold (6.2).
- Lock folders are protected from agents: the self-control gate's control entries (`selfControlGate.ts:149-166`,
  code) gain `v2` (covering `v2/run`, `v2/runs`, `v2/codex`, `v2/evolution`), the realpath of the cache lock folder,
  `realpath(gitCommonDir)/orgai-worktrees` and `orgai-repo.lock`, and each report worktree's `.git` file. **Unverified**
  that the permission rules cover `.git` internals in every adapter and mode; phase 3 adds a test per adapter.
- Ids and names in paths are validated (run and chain ids, branch names, `HOST_INSTANCE_ID_RE`); file name and
  payload id must match or the entry is ignored. Every advisory string displayed goes through `sanitizeTty` with a cap.
- Lock files are checked before use (4.1); folders are 0700 / DACL-restricted (4.1).
- No listening socket: the CLI's dormant socket path (`daemon.secret`, `d-*.sock`, `listen: true`) is removed.

## 10. Desktop app

- Same stores, locks, `v2/` tree and conversion on its own folder, with `"orgai-desktop/2"` and the fence.
- One instance: Electron's `requestSingleInstanceLock` (keyed by userData, so an old and a new desktop exclude each
  other too, code) plus `admission` exclusive for its lifetime. It no longer calls `acquireHostOwnership`.
- Repository, worktree and permission locks in the cache folder coordinate it with `orgai` sessions on the same
  repository.

## 11. Tests

Unit and integration (vitest, real child processes, mock adapter, no tokens):

- `osLock`: every measured behaviour of 4.1 as tests on the CI runners (macOS, Windows, Linux); 0-byte files for
  shared, exclusive and probe; cold-start shared acquisition by several processes; `kill -9` during acquisition (no
  false 'free', no journal); `SIGSTOP`ed holder keeps its lock; lock-file deletion racing a waiter (POSIX inode, Windows
  `EBUSY`), with the subject re-verification; malformed, linked, WAL-mode and foreign-owner lock files fail closed;
  Windows DACL with a permissive parent; FIFO hand-off and jitter; cancellation and shutdown while waiting.
- Lock order: assertion on out-of-order acquisition; each flow of 4.2 driven through the real services with a
  recording lock layer, including concurrent sibling callbacks.
- `SharedJsonFile`: two processes x 200 `update`s end at 400; external writes seen; parse failure; unique tmp names;
  two processes editing different fields of the same project both survive; stale `saveFromRenderer` refused; a
  refused save with team-file effects writes no companion file; deferred cleanup cannot interleave with another
  process.
- Chains: conversion of runs linked only by a shared session id (middle run pruned) gives one `chainId`; dangling
  predecessors; cycles; concurrent `resume` of one run, of two members of one chain, `exec --continue`, auto-resume,
  `resume --now`, `--cancel-auto-resume`: one wins, others exit 6; two runs of one `execChainId` at once refused;
  stored-run writes refused while live elsewhere; late title, failed final write, paused auto-resume, exec
  finalisation and evolution flush keep the claim; an `exec` host exits only after its write queue drained;
  `usageSummaries` never writes; quick promotion with one claimed run creates no project; a pending project cannot be
  opened.
- Conversion: crash at every step (1-7), then a second converter completes; two converters at once; an old starter
  and an old reader (the `ownership.ts`, `productMarker.ts`, `readOnlyStore.ts` of the last release tag and of the
  last marker-aware dev build, extracted into temp modules, plus a full v0.1.6 CLI read-only command against the
  folder) during each step: no format-2 file read or changed by them, refusal where the old code checks; a source
  change during step 4 aborts at step 5; old desktop after following the delete-`run` hint changes nothing in `v2/`;
  power-loss simulation by dropping un-fsynced writes (fault-injecting fs layer).
- Housekeeping (5.4): each row skips live and removes dead; a 24 h-old skill dir and catalog of a live session stay;
  orphan-project removal racing `projects remove --keep-runs` deletes nothing retained; two data folders and
  desktop + CLI never touch each other's owner-scoped files.
- Consumers: kill only the host while a mock child keeps writing in the conversation and in a worktree: resume and
  worktree actions refused, sweeps skipped; after the child exits they proceed.
- Journals: kill points between every pair of file changes of each 4.9 operation, recovery completes or undoes.
- Multi-file operations: distinct output versions from two processes; skill rollback beside another process's skill
  change; MCP build rollback only its own staged dir; concurrent evolution `afterRun` in two processes; capability
  review commit after another's change refused; notes index and bodies consistent; kit import paused after validation
  versus a library edit and an OAuth sign-in: the kit waits, no overwrite.
- Projects: `project-<pid>` shared racing `projects remove` (no resurrection); removal with a foreign live run refused.
- Vault: reset beside another session refused; a host starting during a reset waits then exits 6; OAuth revoke during
  refresh stays revoked; one vault write for both tokens.
- Worktrees: own-only automatic actions; nested subtree with a held descendant aborts; uninstall refused with another
  session in the repository; invalid branch names rejected.
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
- New `e2e/cli-upgrade.mjs`: a format-1 folder made by a fixture writer converts on first start; read-only commands
  before conversion list every run; after conversion the format-1 files are byte-identical.
- Updated: `cli-tui.mjs`, `cli-readonly.mjs`, `cli-exec.mjs` (two execs at once), `separation.mjs` (a second `orgai`
  on B runs; the app still refuses B and the CLI still refuses A).
- `package.json` `e2e:free`, CLAUDE.md's e2e list and `scripts/e2e-select.mjs` (new paths → `cli-parallel`,
  `cli-upgrade`) in the same change.

## 12. Phases

Each phase passes the local gate (typecheck, the whole unit suite, build, `npm run test:scripts`, the e2e scripts of
its area, the Reviewer). Hot files take one claim at a time (CLAUDE.md).

1. **Primitives, dormant**: `osLock` with its tests on all runners, claims and transaction-lock order with the
   assertion, `SharedJsonFile`, `withChainClaim` / `ChainWrite`, host claim and registry, admission, journals,
   consumer check, write-path inventory test (allow-list initially naming "single owner" for every site). Nothing
   calls them in production.
2. **Stores and operations on the new locks, still single-owner**: every 4.4 store on `SharedJsonFile` (async,
   `revision`, `mutateProject`, save hook, undo rules), all transaction locks of 4.2 in their services (evolution,
   kit, capability reviews, skills, templates, MCP builds, OAuth with `setMany`, plan usage, Codex start, team files,
   repo, outputs, knowledge, notes, engagement, staffing, skill evaluations, permissions, vault), per-chain write
   queue awaited, journals for 4.9 operations. The single-owner gate is still in force; behaviour is unchanged.
3. **Activation (one change)**: `v2/` layout and conversion with both fences, per-run summaries and `chainId`, chain
   claims in `RunManager` and `RunStore`, quick runs and promotion, housekeeping, owner-scoped resources, consumer
   snapshots, worktree claims and own-only automation, project and setup claims, `message_run` / `list_runs`, hostless
   readers for both formats, host claim and admission replacing `acquireHostOwnership` in CLI and desktop, the CLI
   matrix, `cli-parallel.mjs`, `cli-upgrade.mjs`, updated e2e scripts and the docs of 7.4.

## 13. Unverified

- Windows: SQLite locking through `node:sqlite`, DACL setup, `GetDriveType`, lock-file unlink behaviour, no cwd check.
- Linux: lock behaviour on CI only.
- Network file systems: SQLite's own warning; detected and reported only.
- Concurrent bundled Codex app-servers on one home; Claude CLI and Codex exiting on host pipe close.
- The Claude spawn hook knowing the worktree branch before creation (6.2).
- Permission rules covering `.git` internals and the cache lock folder in every adapter and mode (9).
- Listing performance beyond the owner's Mac; clone support on the owner's disk for conversion speed.

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
| Ar-H2 `runs/` collisions | 5.1 patterns; locks under `v2/run/locks` |
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
