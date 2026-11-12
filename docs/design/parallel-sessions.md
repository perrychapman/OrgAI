# Parallel `orgai` sessions: design spec

Status: draft 2, 2026-11-12 (draft 1 reviewed by GPT Astra and Gemini Argon, both BLOCKED; resolutions in section 13).
Owner direction (2026-11-11): "mirror Claude Code / Codex": any number of `orgai` processes at once, in any projects,
on one CLI data folder, each terminal its own session. This reverses `cli-standalone-default.md` G4 ("one `orgai` host
process per CLI data folder") and promotes its non-goal "parallel independent sessions like Claude Code" to a goal.
Written against `pr/team-evolution` at 1ee72bfd (the tip of the open PR stack #48-#50, which carries the CLI/host
changes of #49); line numbers drift as that stack moves.

Every fact says how it was checked: "code" = read from the repo at 1ee72bfd, "measured" = observed on the owner's Mac
on 2026-11-11/12, "unverified" = from memory, docs or typings, not checked here.

---

## 1. What Claude Code and Codex do (the model to mirror)

- **Claude Code** (measured, directory layout of `~/.claude`): every session is its own process; a session's
  transcript is its own file, `projects/<escaped cwd>/<session uuid>.jsonl`. Shared files (`settings.json`,
  `history.jsonl`) are small. There is no data-folder owner and no "already running" refusal.
- **Codex** (measured, directory layout of `~/.codex`): sessions are per-thread files
  `sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl(.zst)`; shared state is SQLite in WAL mode (`state_5.sqlite` with
  `-wal`/`-shm`), plus `session_index.jsonl` with `session_index.jsonl.lock`, a `thread-writer-locks/` folder (one
  writer per thread) and `auth.json.lock`. Many `codex` processes run on one home.

The shared idea: **a session's own state has one writer; shared state is locked on write and re-read when it changes;
liveness and exclusion come from the operating system, not from pid guesses; nothing assumes it is the only process.**

## 2. Goals and non-goals

Goals:

- P1. Any number of `orgai` processes run at once on one CLI data folder (TUIs in different or the same project,
  `orgai exec`, management commands). None is refused because another exists.
- P2. Each process hosts the runs it starts or continues and answers their cards in its own terminal (unchanged from
  `cli-standalone-default.md` G2/G3). Quitting ends its runs only (continuable later).
- P3. No process can write, end, prune or sweep another live process's runs, chains, scratch folders, worktrees, temp
  folders or logs, and no write to a shared file is lost to a concurrent write. A process that is merely slow,
  suspended or being debugged is never taken over.
- P4. A process that dies (crash, `kill -9`, power loss) leaves state that any later process recognises as crashed and
  settles, as a restart does today.
- P5. Every process sees every run; runs live in other sessions are marked and refresh from the files.
- P6. Old binaries (CLI or desktop, data folder format 1) can neither read nor host on a converted folder, and no
  binary converts a folder an old binary is using.

Non-goals:

- Cross-session `message_run` delivery, shared inboxes, answering another session's cards. A live run in another
  session is visible, not reachable (as in Claude Code and Codex).
- Two processes driving one chain at once (one writer per chain, Codex's `thread-writer-locks`).
- Several desktop app instances. The desktop keeps one instance per data folder; it gets the new store layout and the
  new lock primitives through the shared code (section 9).
- A spend cap summed across processes (none exists today, code: caps are per run or chain, `runManager.ts:2619-2685`).
- Data folders on network file systems (section 4.1, the OS locks are not reliable there; `doctor` warns).

## 3. What blocks it today

From the code at 1ee72bfd (store inventory and runtime read by three research passes and both reviews):

1. **One owner per folder.** `startInprocHost` acquires `acquireHostOwnership({ wait: 'none' })`
   (`src/cli/inprocHost.ts:232-262`); a live owner refuses with exit 6 (`ownedMessage.ts:14`). Reason given
   (`ownership.ts:24-26`): RunStore's constructor rewrites non-terminal runs.
2. **Run index is one file rewritten whole.** `RunStore` loads `runs.json` once and rewrites it in full (fixed
   `runs.json.tmp`, `.slice(-500)`) on `upsert`, `setUsage`, `prune`, `moveToProject`, `removeProject`
   (`store/runs.ts:186-205`).
3. **Crash normalisation is blind.** The constructor runs `normalizeCrashedRunSummary` on every summary
   (`runs.ts:197`): a non-terminal run becomes `finished`, `endedBy` kept or set to `'app'`, `autoResume` deleted. The
   same function also sanitises fields (`runs.ts:102-126`).
4. **Config stores are load-once, rewrite-whole**, fixed tmp names: `projects.json`, `settings.json`,
   `skill-library.json`, `mcp-library.json`, `connector-presets.json`, `models.json` (cached in
   `ConnectionService.discovered`), `model-prices.json` (cached in `CommunityPrices.prices`). `durableFs`
   documents "one writer per data folder" (`durableFs.ts:105-125`). `ProjectStore.save(project)` replaces a whole
   project from the caller's copy (`projects.ts:579-605`, `saveFromRenderer` 614-647). Knowledge is the exception: it
   revalidates by stat (`knowledge.ts:332-363`).
5. **Multi-file operations are serialised only in memory**: evolution (`evolve/service.ts:159-172` promise map;
   ledger `evolution/<pid>.json`, plus projects, project skills and `.orgai/` team files), outputs (`outputs/service.ts`
   `tails` queue; version number chosen before `outputs.json` is updated, 346-363), team files (four JSON files per
   project plus `.orgai/` and `projects.json`, `teamFiles/store.ts:53-59`, called from `beforeRun` on every run start
   and from `ProjectStore`'s save hook), skills (library and project skills with `.undo/` snapshots restored whole on
   rollback, `skills/service.ts:724-748`), MCP builds (rollback removes the installed dir, `mcp/builds.ts:153-173`),
   notes (`projects/<pid>/context/index.json` plus `note_<id>.md`, `projectData.ts:256-266, 407-446`), engagement
   document (`ENGAGEMENT.md` + `ENGAGEMENT.meta.json`), org templates (`templates.json` + `<id>/org.json`), quick-run
   promotion (creates a project, then moves runs, `quick/quickRuns.ts:284-299`), permission rules (data folder
   `permission-rules.json`, and for code projects `<project>/.claude/settings.local.json` with plain `writeFileSync`,
   `permissionRules.ts:13-49, 118-155`).
6. **Run files are written outside a live run**: late title after a normal end (`runManager.ts:3689-3750`), usage
   back-fill in `usageSummaries` (`setUsage`, 3973-3988), evolution flush after the run (3817-3822), `stopPaused`
   (4737-4764), stranded exec finalisation (5073-5083), `switchModel` / `setPermissionMode` on a stored run
   (`patchSummary`), `continueRun` patching paused chain members (4965-4972), `QuickRunService.promote`. `flush()`
   swallows write errors (3793-3800).
7. **Continuation is a new run id** (`continueRun`, 4898-5000); "one live run per provider session" is checked only
   against this process's runs (4914).
8. **Boot and on-demand sweeps assume sole ownership**: `orphanRunProjects` + `removeProject`, `prune`,
   `sweepOrphans`, `sweepScratchDirs` (`bootstrap.ts:621-636`); `sweepStaleSkillDirs` deletes `orgai-skills-*` temp
   dirs older than 24 h (`claudeSkills.ts:134-168`, `bootstrap.ts:722`); `SkillService` removes every
   `project-skills/*/.undo`; Codex catalog files have shared hash names that running app-servers re-read on every
   `thread/start` and are deleted after 24 h (`codexNativeCatalog.ts:223-227, 326, 374-410`); `privateAuthCwd` wipes a
   shared `auth-cwd/` (`anthropicAuth.ts:211-217`); `harness-workspace/` is one shared folder (`mcp/assist.ts:33-34`);
   the vault reconciles and may rewrite both vault files at open (`secrets.ts:827-865`).
9. **Worktrees**: `reconcileLeftovers` commits uncommitted files of every `worktree-agent-*` worktree
   (`integration.ts:437-456`); `integrate_worktrees`, maintenance integrate / discard / uninstall and nested-worktree
   evacuation act on all pending worktrees (`harnessTools.ts:826-838`, `maintenance.ts:44-130`,
   `worktrees.ts:162-190`). Already a latent bug between the desktop app and `orgai` on one repository.
10. **Locks that exist are not exclusive under contention or uncertainty.** `repoLock.ts` and the startup mutex
    reclaim a "stale" `mkdir` lock by rename-and-reverify, which can displace a fresh holder (Astra finding 1);
    `repoLock` falls back to an in-process lock when the lock dir cannot be created (`repoLock.ts:363-366`).
    `withCodexStartLock` (`codexAppServer.ts:57-130`), MCP OAuth refresh (`mcp/service.ts:269-289, 1437-1518`),
    `UsageMonitor` and `log.ts` coordinate in memory only.
11. **Reads never see other writers** (except knowledge).

## 4. Primitives

### 4.1 OS locks: `osLock.ts`

All exclusion in this spec uses operating-system file locks through SQLite (`node:sqlite`, built into Node; no new
dependency). A lock is a lock file (an empty SQLite database). Measured on the owner's Mac (Node 26 and Electron 45's
Node 24.22; scripts kept in the spec branch under `docs/design/parallel-sessions-locktest/`):

- `BEGIN EXCLUSIVE` with `busy_timeout = 0` in one process makes `BEGIN EXCLUSIVE` in another fail at once with
  `database is locked` (`SQLITE_BUSY`).
- `kill -9` of the holder releases the lock at once (the kernel drops the process's locks); the next attempt succeeds.
- Two connections in one process exclude each other the same way.
- Shared mode (`BEGIN` + a read) is held by any number of processes at once; `BEGIN EXCLUSIVE` fails while any is
  held, and succeeds after all holders are killed.

API (async; acquisition never blocks the event loop):

- `acquire(path, mode: 'exclusive' | 'shared', { waitMs }): Promise<OsLock>` tries once, then retries with
  `setTimeout` backoff (5 ms doubling to 100 ms) until `waitMs`; `waitMs = 0` means try once. `OsLock.release()` ends
  the transaction and closes the connection.
- `probe(path): 'held' | 'free' | 'missing'` opens read-only (never creates the file), tries a shared read: busy means
  an exclusive holder exists. Used by hostless readers; writes nothing.
- No pid, start time or heartbeat is ever used to decide that a holder is gone: a suspended process keeps its locks
  (P3). The lock files never move or get renamed; a lock file is deleted only when the thing it guards no longer
  exists and every acquirer re-verifies that thing after acquiring (4.3, 5.5).
- Errors other than `SQLITE_BUSY` fail closed: the operation is refused with the lock path in the message. There is no
  in-process fallback.
- Advisory info: next to a lock, `<lock>.json` may hold `{ pid, hostInstanceId, ownerCwd, since }` for messages. It is
  never read to decide anything (section 8).
- Network file systems: SQLite's locks are not reliable over NFS/SMB (SQLite documentation, unverified here). `doctor`
  and the first start on a folder report a data folder or lock folder on a network file system (`statfs` type on
  macOS/Linux, `GetDriveType` on Windows; unverified on Windows).

Lock locations:

- Data-folder locks: `<dataDir>/run/locks/<name>.lock` (folder 0700).
- Locks keyed by a path outside the data folder (a repository, a project folder), shared by every data folder and both
  products: `<user cache>/orgai/locks/<kind>-<sha256(canonical path)[0..32]>.lock` where `<user cache>` is
  `~/Library/Caches` (macOS), `%LOCALAPPDATA%` (Windows), `${XDG_CACHE_HOME:-~/.cache}` (Linux); folder 0700. The
  canonical path is `realpath` plus the platform's case folding (`pathKey` in `repoLock.ts:122`, code).

### 4.2 Lock catalogue and order

Every lock has a fixed rank; a task may acquire a lock only if its rank is higher than every lock it holds (reentrant
for the same lock in the same async chain via `AsyncLocalStorage`). A debug assertion throws on an order violation and
a unit test drives every documented nesting.

| Rank | Lock | Mode | Held for |
|---|---|---|---|
| 1 | `admission` (data folder) | shared by every host for its lifetime; exclusive for 4.6 operations | process / operation |
| 2 | `host-<hostInstanceId>` (data folder) | exclusive, by its host, lifetime | process |
| 3 | `project-<projectId>` (data folder) | shared while a process has the project open or a live chain in it; exclusive for project removal | session / operation |
| 4 | `chain-<chainId>` (data folder) | exclusive by the chain's writer (4.3) | run lifetime and after (4.3) |
| 5 | `setup-<projectId>` (data folder) | exclusive, setup-like runs (6.3) | run lifetime |
| 6 | `repo-usage-<repo>` (cache) | shared while a process has a live run in the repository; exclusive for uninstall and for touching unowned worktrees (6.2) | session / operation |
| 7 | `repo-<repo>` (cache) plus the legacy `mkdir` lock (6.2) | exclusive | git operation |
| 8 | `worktree-<repo>-<branch>` (cache) | exclusive by the report's process | worktree lifetime |
| 9 | `team-files-<projectId>`, `evolve-<projectId>` | exclusive | operation |
| 10 | `outputs-<projectId>`, `notes-<projectId>`, `engagement-<projectId>`, `knowledge-<projectId>`, `staffing-<projectId>`, `skills`, `mcp-build-<entryId>`, `templates`, `permissions-<folder>` (cache, keyed by the project folder) | exclusive | operation |
| 11 | `config` (data folder) | exclusive | read-modify-write of config files (4.4) |
| 12 | `vault` (data folder) | exclusive | vault read-decide-commit |
| 13 | `oauth-<credentialOwner>`, `plan-usage-<connectionKey>`, `models-discovery`, `codex-start`, `housekeeping` | exclusive | operation (the only ranks that may span a network call or process start) |

Locks of rank 9-13 never span a model call. The ProjectStore save hook (team files) runs under rank 9 before the rank
11 section, never inside it (4.4).

### 4.3 Chains and the chain lease

- New persisted field `RunSummary.chainId`: a new run's own id; a continuation copies its predecessor's `chainId`.
  Conversion (4.7) computes it for existing runs by walking `resumedFrom` within the stored set (the root's id; a
  predecessor that was already pruned makes the oldest stored member the root). Validated `^run_[A-Za-z0-9_-]{1,80}$`.
- **One writer per chain.** The process that starts or continues a run holds `chain-<chainId>` exclusively from before
  it chooses what to start until the chain is settled in that process: the run is terminal, its late title has
  arrived or been abandoned (60 s cap after the end), its evolution flush and exec finalisation are done, no paused
  auto-resume timer is armed, and the last record and summary writes succeeded. A failed final write keeps the lease
  until process exit (the next process then settles the chain, 5.3).
- **RunStore enforces it.** Every RunStore mutation (`create`, `upsert`, `patchSummary`, `setUsage`, `saveRecord`,
  `saveImage`, `moveToProject`, `remove`) takes a `ChainWrite` token for the run's chain. Tokens are created only by
  `withChainLease(chainId, fn)` (acquire, re-read the chain's summaries from disk, run `fn`, release) or by a held
  lease. A compile-time-only API: there is no way to write a run file without one.
- **Continue / resume / `exec --continue` / auto-resume / `tui <run>` with input:** acquire the chain lease with
  `waitMs = 0`; on busy refuse with exit 6: "This conversation (R3, run_abc) is live in another orgai (<cwd>, pid).
  Use that one, or quit it first." (pid and cwd from the advisory info). Under the lease, re-read the chain and
  recompute the continuation target with today's rules (`newestContinuable` / `canContinueIn`,
  `runChains.ts:138-156`) and the remaining budget, then start.
- **Writes to a stored run from another session** (`runs model` / `switchModel`, permission mode, `stop` of a paused
  run, user delete, move): `withChainLease(chainId, waitMs 0)`; busy refuses with the same text. `usageSummaries`
  back-fill becomes in-memory only (never persisted by a reader).
- **Quick-run promotion** acquires the chain leases of every run it moves before creating the project, creates the
  project, moves the runs, releases; a failure after the project exists removes that project in the same section.

### 4.4 Shared JSON files: `SharedJsonFile<T>`

Replaces "load once, rewrite whole from memory" for: `projects.json`, `settings.json`, `skill-library.json`,
`mcp-library.json`, `connector-presets.json`, `models.json`, `model-prices.json`, `retained-run-projects.json`,
`org-templates/templates.json`, `<userDataDir>/tui-hints.json`, `run/plan-usage.json` (6.4).

- `read(): T`: cached parse revalidated by `stat` (size, mtimeNs, ino) on every call. Services that cached derived
  copies (`ConnectionService.discovered`, `CommunityPrices.prices`, `SettingsStore` change listeners, `ProjectStore`'s
  tier context) read through `read()` and re-derive on a stamp change (`onExternalChange`).
- `update(fn): Promise<T>` acquires `config` (rank 11), re-reads from disk, applies `fn`, writes, releases. Writes:
  tmp `<file>.tmp-<hostInstanceId>-<random>` created `wx`, fsync where the store fsyncs today, rename. `durableFs`
  stops unlinking a shared fixed tmp name.
- A parse failure keeps the last good copy for reads and refuses `update` naming the file; existing corrupt-file
  handling (vault `.corrupt-*`) is kept.
- **No stale whole-object overwrites.** Each project carries `revision` (integer, +1 per write). `mutateProject(id,
  fn)` applies `fn` to the fresh copy inside `update`; every internal caller of `save`/`update` moves to it.
  `saveFromRenderer` and other whole-object saves compare `revision` and refuse on a mismatch ("This project changed in
  another orgai session. Reload and try again."). Settings mutate by patch inside `update`; libraries and presets by
  per-entry operations.
- `ProjectStore`'s boot migration (`migrateAll`) runs inside `update` and only when the file version requires it.
- Team-file side effects of a project save run under `team-files-<pid>` (rank 9) before the `config` section, with the
  digest check `teamFiles/service.ts:1168-1207` (code) moved inside that lock.

Per-project files are covered by their operation lock (rank 9-10) instead of `config`: `staffing/<pid>.json`,
`skill-evaluations/<pid>.json`, `team-reviews/<pid>.json`, `projects/<pid>/{permission-rules.json, outputs.json,
outputs/**, notes, revisions, knowledge.json, context/**, ENGAGEMENT.md, ENGAGEMENT.meta.json, team-files/*.json}`,
`evolution/<pid>.json`, `org-templates/<id>/org.json`. Each operation re-reads what it changes after acquiring its lock.

### 4.5 Host lock and registry

- Each host process (TUI, exec, management command, desktop) holds `host-<hostInstanceId>` exclusively for its
  lifetime and writes `run/hosts/<hostInstanceId>.json` (`{ pid, hostInstanceId, hostKind, appVersion, ownerCwd,
  projectId?, command, startedAt }`, advisory). A host is live exactly when its lock is held (`probe`).
- Hosts remove their files at exit; a dead host's files are removed by the `housekeeping` sweep (5.5) after a failed
  probe. Hostless readers list hosts by probing and never remove anything.
- Everything owner-scoped carries the `hostInstanceId` in its name (temp skill dirs, `auth-cwd`, `.undo`, tmp files,
  Codex catalog files, per-process logs) and is swept only after its host's lock is free.

### 4.6 Admission and exclusive operations

- Every host takes `admission` shared before opening any store and holds it for life.
- Operations that need to be the only process take `admission` exclusive with `waitMs = 0`: conversion (4.7), vault
  `init` over an existing vault, `reset`, `undelete`, `keep-removed`, key rotation. Busy: exit 6 "Another orgai is
  running on this folder (<sessions>). Quit the others first." (a host releases its own shared lock first and takes it
  back after).
- A host that starts while an exclusive operation holds `admission` waits up to 30 s (it prints "Waiting for another
  orgai to finish <operation>...") and then exits 6.

### 4.7 Data folder format 2, conversion and the old-binary fence

Two fences, because old binaries reach the folder through two paths:

- **Product marker** (fences every old command: `checkCliFolder` runs before both the hostless readers and the host,
  `productMarker.ts` / `context.ts`, code; old `readProductMarker` accepts only `"orgai-cli"`). Format 2 writes
  `{ "product": "orgai-cli/2", "version": 1, "format": 2 }` (desktop: `"orgai-desktop/2"`). New binaries accept both
  spellings. Old CLIs refuse `"orgai-cli/2"` as an unknown marker (exit 2, the "does not know" refusal,
  `productMarker.ts:140, 173`, code). An old desktop logs an unknown marker in its default folder and continues
  (`cli-standalone-default.md` 13), so the desktop relies on the second fence.
- **`run/daemon.json` fence** (fences old hosts, CLI and desktop): `{ "format": 2, "note": "This folder is used by a
  newer OrgAI. Older versions cannot open it; update OrgAI." }`. It parses as JSON but not as `DaemonInfo` and names no
  pid, so old `acquireHostOwnership` refuses it as `daemon_json_unreadable` (`ownership.ts:386-410, 594-602`, code:
  an unusable record without a provably dead pid is never "no incumbent"); the old CLI maps that to exit 6
  (`inprocHost.ts:253-262`), the old desktop to its "already running" dialog. Their texts are wrong but safe; old
  `doctor` prints "daemon.json could not be read: unexpected shape" (`doctor.ts:214-226`, code). New binaries never
  call `acquireHostOwnership` (section 9) and recognise the fence.

Conversion runs once per folder, in the first new binary that starts on a format-1 folder, holding the old startup
mutex (`acquireStartupLock`, `run/startup.mkdir`, so no old binary can start meanwhile) and `admission` exclusive (so
no other new binary is running). Steps, each idempotent:

1. Inspect `run/daemon.json`: missing, or our fence (an interrupted conversion): go on. A parseable `DaemonInfo`: its
   pid alive or unconfirmed (`processInfo.ts:188-217`): refuse exit 6 "An older OrgAI is running on this folder (<cwd>,
   pid). Quit it, then start again."; dead: go on. Unusable and not our fence: refuse exit 6 naming the file.
2. Write the fence (durable write).
3. For every summary in `runs.json`: sanitise, normalise non-terminal ones (no new-format host can exist, old ones are
   fenced), compute `chainId`, write `runs/<id>.summary.json` unless present. `runs.json` stays.
4. Write the format-2 marker (durable).
5. Rename `runs.json` to `runs.json.format1` (kept one release for support, then deleted by a later conversion step).

Readers: a format-1 marker reads `runs.json` (today's reader); format 2 reads summaries. Between steps 4 and 5 both
exist and summaries win. Crash at any step: the next new binary sees the fence or the format-1 marker and resumes. A
hostless reader on a format-1 folder never converts. Downgrade is not supported; `doctor` says so on format 2.

## 5. Runs

### 5.1 Layout

- `runs/<id>.summary.json`: the `RunSummary` (now with `chainId`), written only under that chain's lease, tmp + rename.
- `runs/<id>.json` (record) and `runs/<id>/images/` unchanged, under the chain lease.
- `run/locks/chain-<chainId>.lock` (+ advisory `.json`).
- Entry partitioning in `runs/` (sweeps and listing match exactly these, everything else is left alone): summaries
  `^run_[A-Za-z0-9_-]+\.summary\.json$`, records `^run_[A-Za-z0-9_-]+\.json$` (not `.summary.json`), image dirs
  `^run_[A-Za-z0-9_-]+$`, tmp files `\.tmp-<hostInstanceId>-[0-9a-f]+$`.
- Listing: `RunStore.all()` lists summaries with a per-file stat cache and a directory-mtime short cut. Target, checked
  by a phase-2 test: 1,000 summaries listed under 50 ms warm on the owner's Mac (measured when the test lands).
- Every summary read is sanitised (the field checks of `runs.ts:102-126`, split out of the crash normaliser); crash
  normalisation is separate (5.3).
- Run numbers (R1, R2) are derived from the stored set (`runLabels.ts:12-16`, code) and can shift after pruning;
  messages that a user may act on name the run id as well.

### 5.2 Removing runs

Prune, project removal, orphan-project removal and user delete run under `housekeeping` (or the user's operation) and,
per run, `withChainLease(chainId, waitMs 0)`: skip when busy; under the lease re-read the summary, skip unless terminal,
delete record, images and summary; when the chain has no members left, delete its lock files last (an acquirer that
races this re-verifies the chain under its lease and finds nothing, 4.3). Retention stays the per-project
`prune(keepFor)` that already runs at every run end and at boot (code); the 500-entry positional trim of `runs.json`
has no equivalent.

### 5.3 Crash settlement

- No constructor normalisation. A non-terminal summary whose chain lease is held by this process is live here; held by
  another host: live elsewhere (`RunSummary.liveElsewhere` display field, never persisted, advisory pid/cwd); free:
  a crash leftover, shown normalised in memory.
- The `housekeeping` sweep of each new host (after it is ready, in the background) settles crash leftovers: acquire
  the chain lease (`waitMs 0`), re-read, normalise, write, release.
- A process creating a run holds the chain lease before its first summary write; a lease with no summary yet is
  invisible to listing and harmless.

### 5.4 Settlement of title, evolution, exec and pause

The chain lease is held until each of these finishes in the owning process (4.3); they never write after release.
`flush()` reports failures to its caller; the final flush's failure keeps the lease (4.3).

### 5.5 Housekeeping (boot, background, under `housekeeping`)

| Sweep | Today (code) | After |
|---|---|---|
| crash normalisation | constructor | 5.3, per chain under its lease |
| `prune(keepFor)` | terminal runs beyond the per-project count | 5.2 |
| `orphanRunProjects` + `removeProject` | runs of projects not in `projects.json` / retained list | re-read both files inside the section; project removal writes `projects.json` and the retained list in one `config` section; 5.2 per run |
| `sweepOrphans` | records/dirs not in this process's index | records/image dirs (5.1 patterns) with no summary, whose chain lock is free, older than 10 min |
| `sweepScratchDirs` | unreferenced `quick/quick_*` | unreferenced and older than 10 min; a quick run creates its dir after taking the chain lease |
| `sweepStaleSkillDirs` | `orgai-skills-*` in the OS temp dir older than 24 h | names `orgai-skills-<hostInstanceId>-*`; removed only when that host's lock is free (age plays no part); old unnamed ones older than 24 h as today |
| `project-skills/*/.undo` | removed at `SkillService` construction | `.undo-<hostInstanceId>`; removed when that host's lock is free |
| Codex catalog files | shared hash names, deleted after 24 h | `orgai-model-catalog-<hostInstanceId>-<key>.json`; removed when that host's lock is free |
| `auth-cwd/` | one folder, wiped when not empty | `auth-cwd/<hostInstanceId>/` created on demand by `privateAuthCwd`; dead hosts' removed |
| `harness-workspace/` | one shared folder | `harness-workspace/<hostInstanceId>/` |
| `run/` leftovers | stale tmp, sockets | tmp names carry `hostInstanceId`; dead hosts' files and `run/hosts/*.json` removed; the CLI socket path is gone |
| logs | `main.log`, rotate at 2 MB | 6.8 |
| vault open reconcile | at open, unlocked | under `vault` (6.7) |

## 6. Runtime

### 6.1 RunManager

- `runs` map, timers, holds, inbox and decision index describe this process's runs (now the documented meaning).
- `list_runs` lists this process's peers as today and adds "N runs of this project are live in other orgai sessions
  (not reachable)" when any exist.
- `message_run` to a run live elsewhere returns the new result `other-session` ("R4 (run_x) runs in another orgai
  session; it cannot receive messages from this one.") instead of `not-live`.
- The "one live run per provider session" check (`runManager.ts:4914`) is covered across processes by the chain lease
  (a provider session belongs to one chain).
- Budgets read stored usage under the chain lease (4.3), so a chain's prior spend cannot be counted by two writers.

### 6.2 Worktrees and repositories

- `repoLock` becomes the OS lock `repo-<repo>` (rank 7) and keeps taking the legacy `mkdir` lock inside it, so old
  binaries still exclude new ones on git operations (the legacy lock's reclaim race now only exists against old
  binaries). The in-process fallback on lock-dir errors goes (fail closed).
- A report's process takes `worktree-<repo>-<branch>` (rank 8) before its report may edit: the adapter takes it in
  the spawn hook that decides isolation (Claude) or when it creates the worktree (Codex), and holds it until the
  worktree is integrated or discarded; the advisory marker `<gitCommonDir>/orgai-worktrees/<branch>.json` names run,
  session and pid. Branch names are validated `^worktree-agent-[A-Za-z0-9_-]{1,80}$` before any path is built; markers
  of branches that no longer exist are removed by the next sweep. **Unverified**: that the Claude spawn hook knows the
  branch name before the SDK creates the worktree; if not, the adapter takes the lock as the first action of the
  report's first tool call, and the gap is covered by the next rule.
- Every destructive worktree operation (leftover commit, `integrate_worktrees`, maintenance integrate and discard,
  nested evacuation) runs under the repository lock and acts on a worktree only when this process holds its worktree
  lock, or the worktree lock is free **and** this process holds `repo-usage-<repo>` exclusively (no other new-format
  process has a live run in the repository). Otherwise the worktree is listed and left alone ("may belong to another
  orgai session").
- `uninstallRepo` takes `repo-usage-<repo>` exclusive (`waitMs 0`) and refuses naming the sessions.

### 6.3 Projects, setup and project-folder writes

- A host takes `project-<pid>` shared for each project it has open (the TUI's project, an exec's project) or has a
  live chain in. Project removal takes it exclusive (`waitMs 0`) and refuses naming the sessions; under it, the run
  removal of 5.2, secrets, skills and project data removal follow (`dispatcher.ts:542-555`, code).
- Setup-like runs (setup, org change, `org evolve`, the Team assistant applying team files) take `setup-<pid>`
  (`waitMs 0`): "Setup for <project> is open in another orgai (<cwd>, pid). Finish it there first."
- Team files: every `TeamFilesService` operation (`beforeRun`, `status`, `approve`, `reject`, `enable`, `remove`,
  `undo`, `overwrite`) runs under the repository lock then `team-files-<pid>`.
- Evolution: `EvolveService.serialize` adds `evolve-<pid>` around the whole ledger + project + skills + team-files
  transaction (manual and the automatic `afterRun`).
- Permission grants: `permissions-<project folder>` (cache, so the desktop app and other data folders coordinate too)
  around read-modify-write of `.claude/settings.local.json` and `permission-rules.json`; written by tmp + rename.
- Two work runs in one project are allowed (Claude Code allows two sessions in one folder). Starting one prints a
  notice when another session has a live run there: "Another orgai is running R4 here (pid 123). Reports work in their
  own worktrees; both orchestrators edit this checkout."

### 6.4 Spend and plan usage

No cross-run cap exists or is added. The plan-usage probe (`usageMonitor.ts`) takes `plan-usage-<connectionKey>`,
re-reads `run/plan-usage.json` (keyed by connection and account), probes only when the cached value is older than 60 s,
writes and releases; a crash mid-probe releases the lock (OS). Each process still probes only when it has no live run.

### 6.5 Codex

- `withCodexStartLock` keeps its in-memory map and adds `codex-start` around the start ("two simultaneous starts in
  one home race on Codex's sqlite and one exits", `codexAppServer.ts:57-60`, code, applies across processes).
- Running app-servers share `CODEX_HOME`; Codex itself keeps WAL SQLite and writer locks for many processes
  (measured layout of `~/.codex`; **unverified** for the bundled version with concurrent app-servers: phase 3 runs
  two real app-servers on one home and one token-free fake test).
- Codex sign-in (`orgai connections login`) is Codex's own `auth.json` under `CODEX_HOME`
  (`connections/service.ts:934-1005`, code), guarded by Codex (`auth.json.lock` seen in `~/.codex`, measured layout).

### 6.6 MCP OAuth

- `oauth-<credentialOwner>` (the project server or library entry that owns the tokens) covers refresh, revoke,
  retarget/removal and the authorisation commit. Under it the process re-reads the stored credential and its
  `generation`; a refresh whose base generation changed uses the stored tokens instead of refreshing.
- Access token, refresh token and the server config generation are committed in one vault write.
- New tokens are saved as the first action after a successful token response; a crash between the provider rotating a
  refresh token and that save loses the new token (the user signs in again; documented, unavoidable).
- Interactive flows stay per process (ephemeral loopback ports, or strict and reported busy, code).

### 6.7 Vault

- `vault` (rank 12) covers every read-decide-commit: open-time reconcile and legacy retirement
  (`secrets.ts:717-768, 827-865`), creation (`1316-1382`), writes, recovery. Reads revalidate by stat.
- Exclusive operations (4.6) hold `admission` exclusive for their whole duration, so no host can register and open
  the old vault meanwhile.

### 6.8 Logs

- Each process writes `logs/orgai-<YYYYMMDD-HHMMSS>-<hostInstanceId>.log` (2 MB, one rotation `.1`); retention: the
  newest 20 files or 14 days, never a live host's (lock probe). The desktop keeps `main.log`.
- `doctor` names this process's log file. The TUI's `/logs` (run logs, `slashCommands.ts:513-528`) is unchanged.

## 7. CLI

### 7.1 Command matrix

| Command | Host | Refusals (exit 6) |
|---|---|---|
| `orgai`, `tui`, `tui <run>` | own host, `project-<pid>` shared | continuing a chain leased elsewhere (4.3); opening a leased run is allowed read-only |
| `resume [run]`, `exec --continue` | own host | as above; without a run: the newest continuable chain tip (`newestContinuable`) whose chain lease is free; chains leased elsewhere are skipped and named; the pick is re-verified under the lease and retried up to 3 times on a race |
| `exec` | own host | none for other sessions |
| `init`, `projects create|edit`, `org`, `team`, `permissions`, `connections`, `models`, `mcp`, `skills`, `knowledge`, `notes`, `kit`, `settings`, `outputs`, `worktrees`, `runs model` | own short host | the operation's lock (`setup-`, `project-` exclusive for remove, chain lease for `runs model`, `repo-usage` for uninstall) |
| `secrets init|reset|undelete|keep-removed` | own short host | `admission` exclusive (4.6) |
| `projects remove` | own short host | `project-<pid>` exclusive |
| `status`, `runs list|show`, `projects list|show`, `usage show`, `secrets status`, `completions`, `help`, `--version` | none (hostless reader) | never |
| `doctor` | metadata checks hostless; connection checks start an own short host (no longer skipped beside other sessions) | never |

Hostless readers never write, convert, settle or clean; they read summaries (format 2) or `runs.json` (format 1) and
probe locks. The `SNAPSHOT_NOTE` and "another orgai owns this folder" texts go.

### 7.2 Status and JSON

- `orgai status` prints the sessions ("3 orgai sessions: ~/a (pid 1, R2 running), ~/b (pid 7), exec in ~/a
  (pid 9)") and the latest runs per project with live-elsewhere marks.
- `--output-format json`: `sessions: [{ pid, hostInstanceId, hostKind, cwd, projectId?, command, startedAt,
  liveRuns }]` replaces `host`; `hostState` becomes `'running'` when any session is live, else `'stopped'` (kept for
  scripts).

### 7.3 TUI

- `/runs` lists every run of the project with live-elsewhere marks; the list and the "+N sessions" status-bar count
  refresh on a 2 s poll of the `runs/` directory stamp and the host registry.
- Enter on a run live elsewhere opens it read-only (transcript from its record, refreshed when the record's stamp
  changes) with the status line "Live in another orgai (<cwd>, pid). Read-only here."; the composer, `c` (continue),
  `/run` with input, `/model`, `/mode` and stop refuse with that text.
- `/sessions` lists the live sessions (cwd, project, pid, live runs). No cross-session actions.
- Quit confirm counts this process's runs (already, `App.tsx:306-308`): "Quit and stop N run(s) of this session?".

### 7.4 Help and docs

`orgai help`, the command table, exit code 6 text ("busy in another orgai session: a conversation, a setup, a project
removal, a vault operation, or an older OrgAI"), `doctor`, `cli-standalone-default.md` (G4 and the non-goal marked
superseded), `docs/agent-notes/cli-host.md`, CLAUDE.md, `.orgai/ARCHITECTURE.md`, the self-help corpus: in the
activation phase.

## 8. Security and trust

- **Metadata only restricts.** Advisory files (lock `.json`, host registry, worktree markers, `liveElsewhere`) never
  authorise a destructive or settling action; only acquiring the OS lock does. Forging or deleting advisory files can
  at most change a message or make OrgAI more conservative (a forged marker cannot make a worktree removable: removal
  needs the free worktree lock plus exclusive `repo-usage`, 6.2).
- Deleting a lock file while it is held does not release the lock for the holder but lets a new acquirer lock a new
  file (a different inode). Lock folders are therefore protected: the self-control gate's control entries
  (`selfControlGate.ts:149-166`, code) gain `runs`, `run/locks` (under `run`, already listed), `evolution` is already
  listed, and the cache lock folder `<user cache>/orgai`; `<gitCommonDir>/orgai-worktrees` and
  `<gitCommonDir>/orgai-repo.lock` are added for every project root. **Unverified**: that the permission rules cover
  `.git` internals in every adapter and permission mode; phase 3 adds a test per adapter. An agent with unrestricted
  shell access as the same user can always break local state; that is outside this spec, as today.
- Ids and names used in paths are validated before use (run and chain ids, branch names, `hostInstanceId`
  `HOST_INSTANCE_ID_RE`, code); file names and payload ids must match or the entry is ignored.
- New folders are 0700, files 0600, owned by this user, checked like `run/` is today (`ownership.ts:556`).
- No listening socket: the CLI's dormant socket path (`daemon.secret`, `d-*.sock`, the `listen: true` test path) is
  removed.

## 9. Desktop app

- Uses the same stores, locks and conversion (4.7) on its own folder, with `"orgai-desktop/2"` and the fence.
- Single instance: Electron's `requestSingleInstanceLock` (code) plus `admission` exclusive held for the app's
  lifetime (it never shares its folder). It no longer calls `acquireHostOwnership`; its refusal dialog for a held
  `admission` keeps today's text.
- Worktree, repository and permission locks (cache folder) coordinate it with any number of `orgai` sessions on the
  same repository.

## 10. Tests and checks

Unit (vitest, no tokens) and integration (`*.int.test.ts`, real child processes, mock adapter):

- `osLock`: the four measured behaviours (4.1) as tests on the CI runners (macOS, Windows, Linux); `SIGSTOP`ed holder
  keeps its lock past any timeout; probe never creates a file; non-BUSY errors fail closed; lock-order assertion for
  every nesting in 4.2; cancellation and shutdown while waiting.
- Write-path inventory test: scans `src/main` and `src/cli` for file writes (`writeFile*`, `rename*`, `rm*`,
  `unlink*`, `mkdir*`, `append*`, `cp*`, `mkdtemp*`, `symlink*`) and fails on any module not in an allow-list that
  names the lock or ownership rule covering it. New writers must be classified in the same change.
- `SharedJsonFile`: two processes x 200 `update`s end at 400; external write seen by `read`; parse failure keeps the
  last good copy; unique tmp names. Two processes editing different fields of the **same project** both survive;
  `saveFromRenderer` with a stale revision is refused.
- Chain lease: concurrent `resume` of the same run, of two different members of one chain, `exec --continue` and an
  auto-resume all race: exactly one wins, the others exit 6; `runs model`, permission mode and `stop` on a chain live
  elsewhere refuse; late title after the end, failed final flush, paused auto-resume, exec finalisation and evolution
  flush all keep the lease until done; `usageSummaries` never writes; quick promotion with one leased run creates no
  project.
- Conversion: crash after each step 1-5 then a second converter completes; two converters at once; an old-version
  starter during each step (the released `ownership.ts` and `productMarker.ts`, extracted from the last release tag
  into a temp module, refuse the folder after step 2 and step 4 respectively); a hostless reader interleaved with each
  step reads a complete run list.
- Housekeeping (5.5 table): every row skips a live host's or live chain's resource and removes a dead one's; a live
  session whose temp skill dir and Codex catalog are older than 24 h keeps them; orphan-project removal racing a
  `projects remove --keep-runs` deletes nothing retained.
- Multi-file operations: two processes committing output versions of one project get distinct numbers; skill
  rollback beside another process's skill change keeps that change; MCP build rollback removes only its own staged
  dir; concurrent `afterRun` evolution in two processes produces distinct generations and a consistent ledger; notes
  index and bodies stay consistent under concurrent saves.
- Project removal with a foreign live run is refused; vault reset beside another session refused, and a host starting
  during a reset waits then exits 6; OAuth revoke during refresh leaves the credential revoked; two cold plan-usage
  probes make one request; a probe owner killed mid-request releases.
- Worktrees: leftover commit, integrate (tool and maintenance), discard and evacuation skip a worktree whose lock is
  held by another process; unmarked worktrees untouched while another process uses the repository; uninstall refused;
  invalid branch names rejected.
- `message_run` `other-session`, `list_runs` notice, setup lease, admission wait, registry and status JSON, per-process
  logs and retention, network-FS warning (simulated `statfs`).
- Removed or changed: the CLI's `wait: 'none'` ownership tests (desktop ownership tests move to the admission lock),
  `inprocHost.test.ts` "second host refused", `inprocHostRace.test.ts` (becomes "two hosts start at once, both run"),
  `ensureHost.test.ts` / `manage.test.ts` exit-6 cases, `cli.int.test.ts` "beside a running orgai", snapshot-line
  tests (`readOnlyMatrix`, `status`, `runs`, `runRef`).
- Two real Codex app-servers on one `CODEX_HOME` (6.5), run once by hand with the result recorded.

e2e (token-free, mock adapter):

- New `e2e/cli-parallel.mjs`: one temp data folder, two temp projects (git repos). TUI A (project 1), TUI B
  (project 2), TUI C (project 1) and an `orgai exec` (project 1) at once; each starts a mock run with an isolated report;
  `orgai status` lists 4 sessions; `/runs` in A shows C's run as live elsewhere and opens it read-only; `orgai resume`
  of C's run exits 6 naming it; `orgai projects remove` of project 1 exits 6; quitting B leaves A's and C's runs
  running; `kill -9` of C, then a new `orgai` settles C's run as ended by the app and does not touch A's live report
  worktree; after all quit, `runs list` shows every run once.
- New `e2e/cli-upgrade.mjs`: a format-1 folder with runs (made by the fixture writer, no old binary needed) converts
  on first start; the old marker and fence refusals are checked with the extracted old modules (unit), and the e2e
  checks the converted layout and that read-only commands before conversion still list every run.
- Updated: `cli-tui.mjs`, `cli-readonly.mjs`, `cli-exec.mjs` (two execs at once both succeed), `separation.mjs`
  (a second `orgai` on B runs; the app still refuses B and the CLI still refuses A).
- `package.json` `e2e:free`, CLAUDE.md's e2e list and `scripts/e2e-select.mjs` (map the new lock, store and
  housekeeping paths to `cli-parallel` and `cli-upgrade`) in the same change.

## 11. Phases

Each phase passes the local gate (typecheck, the whole unit suite, build, `npm run test:scripts`, the e2e scripts of
its area, the Reviewer) before the next. Hot files (`runManager.ts`, `types.ts`, CLAUDE.md, ARCHITECTURE.md) take one
claim at a time (CLAUDE.md).

1. **Primitives, dormant**: `osLock` (+ tests on all CI runners), lock catalogue and order assertion, `SharedJsonFile`,
   `withChainLease` / `ChainWrite`, host lock and registry, admission, write-path inventory test. Nothing calls them in
   production yet.
2. **Stores and operations on the new locks, still single-owner**: every 4.4 store on `SharedJsonFile` (async
   mutations, `revision`, `mutateProject`), the rank 9-13 operation locks (evolution, outputs, team files, skills, MCP
   builds, notes, engagement, templates, permissions, vault, OAuth, plan usage, Codex start), `repoLock` on the OS
   lock, owner-scoped temp names, per-process logs. The single-owner gate is still in force, so behaviour is unchanged
   apart from file names; every lock is uncontended.
3. **Activation**: format 2 conversion and both fences, per-run summaries and `chainId`, `RunStore` with `ChainWrite`
   and no constructor normalisation, chain leases in `RunManager` (4.3, 5.4), housekeeping (5.5), worktree and repo
   usage locks (6.2), project and setup locks (6.3), `message_run` / `list_runs`, hostless readers for both formats,
   the new ownership (host lock, admission) for CLI and desktop with `acquireHostOwnership` removed from both, the CLI
   matrix (7.1-7.3), `cli-parallel.mjs`, `cli-upgrade.mjs` and the updated e2e scripts, and the docs of 7.4. One
   change: nothing is half-enabled.

## 12. Unverified

- Windows: SQLite locking through `node:sqlite` (used by SQLite everywhere, not run here), `GetDriveType`, the
  'unconfirmed' pid path of conversion step 1.
- Linux: lock behaviour on CI only.
- Network file systems: SQLite's own warning; only detected and reported.
- Concurrent bundled Codex app-servers on one home beyond the start race (6.5).
- That the Claude spawn hook knows the worktree branch before creation (6.2).
- That permission rules keep agents out of `.git` internals and the cache lock folder in every adapter and mode (8).
- Listing performance beyond the owner's Mac (5.1).
- Live providers under several concurrent processes (rate limits are the user's; nothing here adds calls).

## 13. Draft 1 review resolutions

Astra (GPT-6 Astra, 19 findings) and Argon (Gemini 4 Argon, 15 findings). A finding that both raised is listed once.
Two Argon details referred to text draft 1 did not contain (an `Atomics.wait` lock, a `run/procs` registry); their
underlying concerns (async locking, registry semantics) are addressed.

| Finding | Resolution |
|---|---|
| A1 stale `mkdir` lock reclaim can displace a fresh holder; in-process fallback | 4.1 OS locks only, no reclaim, fail closed; `repoLock` on the OS lock with the legacy lock inside (6.2) |
| A2 heartbeat expiry is not death; unconfirmed owners | 4.1 no pid/heartbeat decisions; a suspended holder keeps its lock (test in 10) |
| A3, Ar-H3 conversion order, crash recovery, readers during conversion | 4.7 fence first, migrate, marker, rename; recovery from every step; readers by marker format; tests in 10 |
| A4 per-run lease does not cover a chain | 4.3 `chainId`, chain lease acquired before choosing the target, re-verified under it |
| A5, Ar-C3 writes after teardown and from non-owners | 4.3 `ChainWrite` tokens on every RunStore mutation; lease held through title, evolution, exec, pause (5.4); `usageSummaries` in memory only; quick promotion |
| A6 stale whole-object project saves | 4.4 `revision`, `mutateProject`, CAS for whole-object saves |
| A7, Ar-C4 evolution, notes paths, `.claude/settings.local.json` missed | 3.5 inventory corrected; 6.3 `evolve-<pid>`, `notes-<pid>`, `permissions-<folder>`; write-path inventory test (10) |
| A8, Ar-H5 multi-file operations | 4.2 rank 9-10 operation locks; 4.3 quick promotion; 10 tests |
| A9 project deletion vs foreign live runs | 6.3 `project-<pid>` shared/exclusive |
| A10 worktree entry points, age-based ownership | 6.2 worktree locks, every destructive operation, unowned worktrees only when alone in the repository |
| A11 forged metadata authorising destruction; sanitise vs normalise | 8 metadata only restricts; protected paths; 5.1 sanitise split from 5.3 normalise |
| A12 vault exclusivity races registration | 4.6 admission lock; 6.7 |
| A13 OAuth refresh vs other credential mutations | 6.6 per credential owner, generation, one write |
| A14, Ar-H4 age-based sweeps of live resources, missed sweeps | 5.5 owner-scoped names, lock-probed liveness; vault reconcile, orphan projects, `auth-cwd` on demand |
| A15, Ar-C2 phases activate pieces separately; desktop unspecified | 11 dormant primitives, single-owner store phase, one activation phase; 9 desktop |
| A16, Ar-H1 sync API vs async lock; lock order | 4.1 async acquisition; 4.2 ranks, reentrancy, assertion |
| A17 plan-usage cache stampede | 6.4 lock held across the probe |
| A18, Ar-L1 CLI matrix, hostless writes, doctor, resume rules, TUI Enter | 7.1-7.3 |
| A19, Ar-L1 corrections (knowledge re-reads, `endedBy` kept, Codex login, old doctor text, `orgai logs`, R numbers) | 3.3, 3.4, 4.7, 5.1, 6.5, 6.8 |
| Ar-C1 old read-only commands not fenced; old doctor text | 4.7 product marker fence `"orgai-cli/2"` |
| Ar-H2 `runs/` entry collisions, dead leases | 5.1 entry patterns; leases are lock files under `run/locks` |
| Ar-M1 marker paths, branch validation, orphan markers | 6.2, 8 |
| Ar-M2 cached derived state in services; boot migration | 4.4 |
| Ar-M3 Codex catalog deletion | 5.5 per-host catalog names |
| Ar-M4 `list_runs` / `message_run` | 6.1 |
| Ar-M5 shared `harness-workspace` | 5.5 per host |
