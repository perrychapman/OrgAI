# Parallel `orgai` sessions: design spec

Status: draft 1, 2026-11-11. Owner direction (2026-11-11): "mirror Claude Code / Codex": any number of `orgai` processes
at once, in any projects, on one CLI data folder, each terminal its own session. This reverses
`cli-standalone-default.md` G4 ("one `orgai` host process per CLI data folder") and promotes its non-goal "parallel
independent sessions like Claude Code" to a goal. Written against `pr/team-evolution` at 1ee72bfd (the tip of the open
PR stack #48-#50, which carries the CLI/host changes of #49).

Every fact says how it was checked: "code" = read from the repo at 1ee72bfd, "measured" = observed on the owner's Mac
on 2026-11-11, "unverified" = from memory, docs or typings, not checked here.

---

## 1. What Claude Code and Codex do (the model to mirror)

- **Claude Code** (measured, `~/.claude`): every session is its own process. A session's transcript is its own file,
  `projects/<escaped cwd>/<session uuid>.jsonl`, written only by that session. Shared files (`settings.json`,
  `history.jsonl`) are small and written rarely. There is no data-folder owner and no "already running" refusal;
  `--resume` lists sessions from the files.
- **Codex** (measured, `~/.codex`): sessions are per-thread files `sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl(.zst)`;
  the shared index is SQLite in WAL mode (`state_5.sqlite`, `-wal`, `-shm`) plus `session_index.jsonl` with a
  `session_index.jsonl.lock`; a `thread-writer-locks/` folder holds one writer lock per thread; `auth.json.lock` guards
  the login refresh. Many `codex` processes run at once on one home.

The shared idea: **a session's own state is its own file with one writer; shared state is small, locked on write and
re-read when it changes; nothing assumes it is the only process.** That is the shape this spec gives OrgAI.

## 2. Goals and non-goals

Goals:

- P1. Any number of `orgai` processes run at once on one CLI data folder: `orgai` in project A, `orgai` in project B,
  a second `orgai` in project A, `orgai exec` from a script, and management commands, all at the same time. None is
  refused for another one existing.
- P2. Each process hosts the runs it starts and answers their approvals in its own terminal (unchanged from
  `cli-standalone-default.md` G2/G3). Quitting it ends its runs only (continuable later).
- P3. No process can corrupt, end, prune or sweep another live process's runs, records, scratch folders, worktrees or
  logs, and no write to a shared file is lost to a concurrent write.
- P4. A process that dies (crash, `kill -9`, power loss) leaves runs that any later process recognises as crashed
  and normalises, exactly as a restart does today.
- P5. Every process sees every run: lists, `status`, `usage` and the TUI's `/runs` include runs of other live
  sessions (marked as such), refreshed from the files.
- P6. Old `orgai` binaries (single-owner, data folder format 1) can never run on a folder that a new binary has
  converted, and a new binary never converts a folder an old binary is using.

Non-goals:

- Cross-process `message_run`, `list_runs` delivery, shared inboxes, or answering another session's cards. A live run in
  another process is visible but not reachable (as in Claude Code and Codex, sessions do not talk to each other).
- Two processes driving the same run at once. One writer per run (Codex's `thread-writer-locks`).
- The desktop app. It keeps its own data folder and its single instance (Electron lock plus `acquireHostOwnership`);
  it gets the new store layout through the shared code, nothing else.
- A project-wide or global spend cap summed across processes (none exists today, see 6.4).

## 3. What blocks it today

From the code at 1ee72bfd:

1. **One owner per folder.** `startInprocHost` (`src/cli/inprocHost.ts:241-262`) calls `acquireHostOwnership({ wait:
   'none' })`; a live `daemon.json` owner refuses with exit 6 (`ownedMessage.ts:14`). The stated reason
   (`ownership.ts:14-17`): "RunStore's constructor rewrites non-terminal runs: a second host must never get that far".
2. **Run index is one file rewritten whole.** `RunStore` loads `runs.json` once in its constructor and rewrites it in
   full (fixed `runs.json.tmp` + rename, `.slice(-500)`) on every `upsert`, `setUsage`, `prune`, `moveToProject`,
   `removeProject` (`store/runs.ts:186-205`). Two processes overwrite each other's entries.
3. **Crash normalisation is blind.** The constructor runs `normalizeCrashedRunSummary` on every summary
   (`runs.ts:197`): any non-terminal run becomes `finished`, `endedBy 'app'`, `autoResume` deleted. Persisted on the
   next write. A second process would end the first one's live runs.
4. **Every config store is load-once, rewrite-whole** with a fixed tmp name: `projects.json`, `settings.json`,
   `skill-library.json`, `mcp-library.json`, `connector-presets.json`, `models.json`, `model-prices.json`
   (store inventory, code). `durableFs.writeFileDurable` documents "one writer per data folder" and unlinks any
   existing `<target>.tmp` (`durableFs.ts:105-125`).
5. **Boot housekeeping assumes sole ownership** (`host/bootstrap.ts:621-636`): `orphanRunProjects` + `removeProject`,
   `prune`, `sweepOrphans` (deletes `runs/*.json` and `runs/<id>/` not in this process's index), `sweepScratchDirs`
   (`quick/quick_*` not referenced by this process's runs). `SkillService`'s constructor removes every
   `project-skills/*/.undo` (`skills/service.ts:104-109`). `anthropicAuth` wipes `auth-cwd/` when it is not empty
   (`connections/anthropicAuth.ts:213-217`).
6. **Worktree leftovers.** `WorktreeIntegrator.reconcileLeftovers` (`runtime/integration.ts:437-456`) treats every
   `worktree-agent-*` worktree in the repository as an earlier run's leftover and commits its uncommitted files. A live
   report of another process would get a commit "uncommitted work left by an earlier run" mid-edit, and its
   orchestrator would be told to integrate it. (Latent today: the desktop app and `orgai` already may share a
   repository.) `integrate_worktrees` (`harnessTools.ts:826-838`) acts on all pending worktrees of the repository.
7. **Process-wide singletons that are only in-process.** `withCodexStartLock` (`codexAppServer.ts:57-130`, an
   in-memory `Map`) guards against two Codex app-servers starting on one `CODEX_HOME` ("one exits"); MCP OAuth token
   refresh with rotation (`mcp/service.ts:269-289`); `log.ts` (`main.log`, size counter in a module variable, rotate by
   rename at 2 MB).
8. **Reads never see other writers.** No store re-reads its file; the TUI, `status` and `runs` would show only this
   process's view.

## 4. Shared primitives (new, `src/main/store/shared/`)

### 4.1 Folder lock: `withDataLock(dataDir, name, fn)`

A cross-process mutex for short read-modify-write sections, generalised from `runtime/repoLock.ts` (code: atomic
`mkdir` of a lock dir, `owner.json` with pid, process start time, `hostInstanceId`, token; heartbeat `utimes` every 2
s; stale only when the pid is dead (start-time checked) **and** the heartbeat is older than 4 intervals; reclaim by
renaming to `.stale-<uuid>` and re-verifying; in-process queue first; reentrant per async chain).

- Lock dirs: `<dataDir>/run/locks/<name>.lock/`. Names: `config` (every config file of 4.2), `runs-index` (run creation
  and removal, 5.2), `vault`, `codex-start`, `oauth-<serverId>`, `migrate`.
- The shared lock core moves to `src/main/store/shared/dirLock.ts`; `repoLock.ts` keeps its API and delegates.
- Timeout 10 s for `config`/`runs-index` (sections are milliseconds), 60 s for `codex-start` and `oauth-*`. A timeout
  is an error naming the holder (pid, cwd from the host registry, 4.4).
- Sections never call out to a model, the network or git while holding a lock (OAuth refresh is the one network call
  under its own `oauth-*` lock, 6.6).

### 4.2 Shared JSON file: `SharedJsonFile<T>`

Replaces "load once in the constructor, rewrite whole from memory".

- `read(): T` returns a cached parse, revalidated by `stat` (size, mtimeNs, ino) on every call; a changed stamp
  re-reads and re-parses. Cost: one `stat` per read (the knowledge store already works this way, `knowledge.ts:354-363`,
  code).
- `update(fn: (current: T) => T): T` takes `withDataLock(dataDir, 'config')`, re-reads from disk (ignoring the cache),
  applies `fn`, writes, releases. A store's mutation methods become `update` calls; nothing mutates a cached copy.
- Writes: tmp name `<file>.tmp-<hostInstanceId>-<random>` (never a fixed `.tmp`), `wx`, fsync where the store did
  before (`durableFs` for the vault), rename. `durableFs.writeFileDurable` stops unlinking a shared fixed tmp name.
- A parse failure on re-read keeps the last good copy for reads and refuses `update` with the file named (today's
  per-store corrupt handling is kept where it exists, e.g. the vault's `.corrupt-*` path).
- Change hooks: `onExternalChange(cb)` fires when a `read` finds a stamp this process did not write, so a store can
  re-run derived work (the TUI's project list refresh, `tierContext`).

Applies to: `projects.json`, `settings.json`, `skill-library.json`, `mcp-library.json`, `connector-presets.json`,
`models.json`, `model-prices.json`, `retained-run-projects.json`, `org-templates/templates.json`,
`<userDataDir>/tui-hints.json`, and per-project `staffing/<pid>.json`, `skill-evaluations/<pid>.json`,
`team-reviews/<pid>.json`, `projects/<pid>/{permission-rules.json,outputs.json,notes.json,knowledge.json,
team-files/*.json}`. Files already read per operation (`outputs.json`, `retained-run-projects.json`) only need the
locked update and the unique tmp name.

### 4.3 Run lease: one writer per run

Mirrors Codex's `thread-writer-locks`.

- `runs/<id>.lease/` (atomic `mkdir`) with `owner.json` `{ pid, processStartTime, hostInstanceId, acquiredAt }` and the
  same heartbeat as 4.1. Held from the moment a process creates or continues a run until that run is terminal in that
  process and its last record write is flushed (`runManager.ts:3640-3674` teardown, after `flushRecord`).
- Only the lease holder writes `runs/<id>.json`, `runs/<id>.summary.json` (5.1) and `runs/<id>/images/`.
- **Continue / resume / `tui <run>` with input**: acquire the lease first. Held by a live process: refuse with exit 6,
  "R3 is open in another orgai (<cwd>, pid <pid>). Use that one, or quit it first." (the same words as today's
  refusal, now about one run). Opening a leased run read-only is always allowed (7.3).
- **Liveness**: a lease is live when its pid is live with a matching start time (`processInfo.ts` rules, code). A pid
  that cannot be compared ('unconfirmed', Windows) is live while its heartbeat is fresh (under 4 intervals).
- **Crash reclaim**: a dead lease is reclaimed (rename `.stale-<uuid>`, re-verify, remove) by whoever needs the run: a
  continue, the crash sweep (5.3) or a prune. The reclaimer normalises the run with `normalizeCrashedRunSummary` and
  writes it, under the lease it now holds, then releases it unless it is continuing the run.

### 4.4 Host registry

Replaces the CLI's use of `daemon.json` as an exclusive owner record.

- `<dataDir>/run/hosts/<hostInstanceId>.json`: `{ pid, processStartTime, hostInstanceId, hostKind: 'inproc', appVersion,
  ownerCwd, projectId?, startedAt, command }` written at host start (tmp + rename), removed at release. One file per
  live `orgai` process. Read by `status`, `doctor`, refusal texts and lock-timeout texts.
- Stale entries (dead pid, start-time mismatch) are removed by any process that lists the registry.
- The startup mutex `run/startup.mkdir` stays, but only around the format check of 4.5 and registry writes, never held
  across the boot.
- `daemon.secret` and the per-host socket: the CLI does not listen in production today (`context.ts:95-104`,
  `listen` defaults to false, code). They are dropped from the CLI path; the `listen: true` test path goes with them.
  The desktop keeps `acquireHostOwnership` unchanged on its own folder.

### 4.5 Data folder format 2 and the old-binary fence

- `<userDataDir>/product.json` gains `"format": 2` (`version: 1` stays, so the product check is unchanged). New binaries
  read `format` (absent = 1). Old binaries ignore the field (`productMarker.ts:26` reads only `product`, code), so the
  marker alone does not fence them.
- The fence is `run/daemon.json`, written once at conversion and never removed: `{ "format": 2, "note": "This folder
  is used by orgai with parallel sessions. Older orgai versions cannot open it; update orgai." }`. It is valid JSON that
  `parseDaemonInfo` rejects and that names no pid, so `readDaemonFileState` returns `unusable` with no pid
  (`ownership.ts:386-410`, code), and `acquireHostOwnership` refuses it as `daemon_json_unreadable` because no pid is
  "provably gone" (`ownership.ts:594-602`, code: review M9, an unusable record is never "no incumbent"). The CLI maps
  that refusal to exit 6 (`inprocHost.ts:253-262`, code). The old binary's text ("orgai is already running") is wrong
  but safe; its `doctor` prints the path and the note. Phase 1's test runs the `ownership.ts` of the last release tag
  (from git, in a temp module) against the fence and asserts the refusal. The desktop app uses its own folder and
  never reads the CLI's (`cli-standalone-default.md` 3.1).
- **Conversion** (first start of a new binary on a format-1 folder), under `withDataLock('migrate')` and the startup
  mutex: if `daemon.json` names a live old-format owner, refuse with exit 6 ("An older orgai is running on this folder
  (<cwd>, pid). Quit it, then start again.") and convert nothing. Otherwise: migrate `runs.json` (5.4), write the fence,
  set `format: 2`. Idempotent and resumable: each step checks whether it already ran.
- Downgrade is not supported; `orgai doctor` says so for a format-2 folder.

## 5. Runs

### 5.1 Layout

- `runs/<id>.summary.json`: the `RunSummary` (the same object `runs.json` holds today). Written by the lease holder
  only, tmp + rename, on every place that today calls `upsert`/`setUsage` for that run.
- `runs/<id>.json` (`RunRecord`) and `runs/<id>/images/` unchanged, lease holder only. `getRecord` keeps overlaying
  the summary from `<id>.summary.json` (today from the index, `runs.ts:351-353`).
- `runs.json` is gone after conversion (5.4).
- Listing: `RunStore.all()` lists `runs/*.summary.json`, using a per-file stat cache (re-parse only changed files) and a
  directory mtime check to skip the listing when nothing was added or removed. Measured target for the phase-2 test:
  1,000 summaries listed under 50 ms warm on the owner's Mac.
- Ordering stays `startedAt`, then id (`shared/view/runLabels.ts:12-20`, code: run numbers R1.. are derived, not
  stored, so they are stable across processes).

### 5.2 Creating and removing runs

- Create: `newId('run')` (unique), acquire the lease, write the record and summary. No shared index to update, so no
  lock beyond the lease.
- Remove (prune, `removeProject`, `orphanRunProjects`, user delete): under `withDataLock('runs-index')`, for each
  candidate: skip unless terminal; acquire its lease (skip if held by a live process); delete record, images, summary;
  release (delete) the lease dir.
- `moveToProject`: lease holder, or acquire the lease (refuse when live elsewhere).
- The 500-run positional trim of `runs.json` (`runs.ts:203`, code) has no equivalent: retention is the per-project
  `prune(keepFor)` that already runs at every run end and at boot (`runManager.ts:3674`, `bootstrap.ts:632`, code).

### 5.3 Crash normalisation without a boot-time rewrite

- `RunStore`'s constructor no longer normalises. Instead, when a summary is read and is non-terminal:
  - its lease is held by this process: it is live here;
  - its lease is held by another live process: it is reported as live elsewhere (`RunSummary.liveElsewhere: { pid,
    hostInstanceId, ownerCwd? }`, display only, never persisted);
  - otherwise (no lease, or a dead lease): it is a crash leftover. Reads normalise it in memory (as the read-only
    reader does today, `readOnlyStore.ts:113-115`, code); the boot sweep of each new process reclaims dead leases and
    persists the normalisation (4.3), in the background after the host is ready, so a crash of one process is
    settled by the next start of any.
- A run created by a live process between its `mkdir` lease and its first summary write has no summary yet; listing
  ignores lease dirs without a summary, and the orphan sweep (5.5) gives them a grace period.

### 5.4 Migration from `runs.json`

During conversion (4.5): for each summary in `runs.json` (all non-terminal ones normalised first, since no live owner
exists at that point), write `runs/<id>.summary.json` unless it exists; then rename `runs.json` to
`runs.json.format1` (kept one release for support, deleted by the next conversion step of a later version). Records
whose summary was trimmed from `runs.json` by the 500 cap stay unindexed and are swept as today.

### 5.5 Boot housekeeping, made lease-aware

Each sweep runs in every process at boot (as today) but only touches what no live process holds:

| Sweep | Today (code) | After |
|---|---|---|
| crash normalisation | constructor, all non-terminal runs | 5.3: only runs with no live lease, persisted under the reclaimed lease |
| `prune(keepFor)` | terminal runs beyond the per-project count | 5.2 rules: lease required to delete |
| `orphanRunProjects` + `removeProject` | runs of unknown projects | 5.2 rules; the project list is re-read (4.2) first |
| `sweepOrphans` | records/dirs not in this process's index | records without `<id>.summary.json`, no live lease, and mtime older than 10 min |
| `sweepScratchDirs` | `quick/quick_*` no run references | also skip dirs whose run has a live lease, and dirs newer than 10 min |
| `project-skills/*/.undo` | removed at `SkillService` construction | undo dirs become `.undo-<hostInstanceId>`; only dirs of dead hosts are removed |
| `run/` leftovers (`ownership.ts:805-850`) | stale tmp, sockets | tmp names carry `hostInstanceId`; only dead hosts' files are removed |
| `auth-cwd/` | wiped when not empty | per process: `auth-cwd/<hostInstanceId>/`; dead hosts' dirs removed |
| `harness-workspace/` | one shared folder | per process: `harness-workspace/<hostInstanceId>/` |
| Codex catalog files | stale `orgai-model-catalog-*` deleted | unchanged (per-pid random tmp already, code); deletion skips files younger than 10 min |

## 6. Runtime

### 6.1 RunManager

- Unchanged per process: the `runs` map, timers, holds, inbox, decision index, auto-resume. They describe this
  process's runs only, which is now the documented meaning.
- `listRunsFor` / `list_runs` (`runManager.ts:3931-3953`): unchanged list of this process's runs, plus a line "N runs
  of this project are live in other orgai sessions (not reachable)" when there are any, so an orchestrator does not
  assume it is alone.
- `message_run` to a run live elsewhere: refused with the new refusal reason `other-session` ("R4 runs in another orgai
  session; it cannot receive messages from this one."), instead of today's `not-live` (`runManager.ts:3963-3967`).
- `chainPriorCost`, budgets (`runManager.ts:1621-1679`, `2619-2685`): unchanged; they read stored usage, which other
  processes keep current through their throttled summary writes. A chain can only be continued by one process at a time
  (the lease), so chain spend cannot be double-counted.
- `usageStats` / `usageOverview` merge stored summaries with this process's live runs (code); runs live elsewhere
  show their last written usage (throttled, `refreshUsage`). Documented in `orgai usage` output as "live in other
  sessions: last saved".

### 6.2 Worktrees

- Owner marker: when a report worktree is registered (`WorktreeIntegrator`, both adapters), write
  `<gitCommonDir>/orgai-worktrees/<branch>.json` `{ runId, hostInstanceId, pid, processStartTime, dataProduct:
  'cli' | 'desktop', createdAt }` under the repository lock; remove it when the worktree is integrated or discarded.
  Keyed by the repository, not the data folder, because the desktop app and other data folders may share the repository.
- `reconcileLeftovers`, `integrate_worktrees`'s pending list, and maintenance's discard / uninstall
  (`maintenance.ts:60-130`) skip worktrees whose marker names a live process other than this one. Worktrees without a
  marker are treated as leftovers only when older than 10 minutes (covers the window between the SDK creating a
  worktree and the hook registering it, and worktrees of older versions).
- Uninstall (`maintenance.uninstallRepo`) is refused while any live process has a marker in that repository, naming it.
- Git itself stays guarded by the repository lock (code, already cross-process).

### 6.3 Project-folder writers

- Setup-like runs (setup, org change, `org evolve`, Team assistant applying team files) take a project lease,
  `projects/<pid>/setup.lease/` (4.3 mechanics). A second setup-like run on the same project in any process is refused:
  "Setup for <project> is open in another orgai (<cwd>, pid). Finish it there first." Work runs do not take it.
- Two work runs in one project at once are allowed (Claude Code allows two sessions in one folder). Starting one prints
  a notice when another session has a live run there: "Another orgai is running R4 here (pid 123). Reports work in
  their own worktrees; both orchestrators edit this checkout."
- Team files approve/reject keep their digest check (`teamFiles/service.ts:1168-1207`, code); their state file moves
  to 4.2.

### 6.4 Spend

There is no project-wide or daily cap today (code: caps are per run or chain). Unchanged. The plan-usage probe
(`usageMonitor.ts`) caches its last result in `run/plan-usage.json` (4.2, 60 s freshness) so N processes do not each
probe; each still probes only when it has no live runs.

### 6.5 Codex

- `withCodexStartLock` becomes cross-process: the in-memory map plus `withDataLock(dataDir, 'codex-start')` around the
  start (the comment's "two simultaneous starts in one home race on Codex's sqlite" applies across processes too).
- Running app-servers share `CODEX_HOME` as `codex` itself does (measured: Codex keeps SQLite WAL and writer locks for
  many processes; **unverified** for the bundled Codex version under concurrent app-servers; phase 3 runs two fake
  app-server starts and one real two-process smoke).

### 6.6 MCP OAuth and connections

- Token refresh with rotation: under `withDataLock(dataDir, 'oauth-<serverId>')`, re-read the stored tokens; if they
  changed since this process read them (another process refreshed), use them instead of refreshing.
- Interactive OAuth flows stay per process (loopback ports are ephemeral, or strict and reported as busy, code).
- Connection logins (`orgai connections login`) write through the vault (6.7).

### 6.7 Vault

- `SecretStore` writes under `withDataLock('vault')` and reloads before every write (it already has `reload()`, code).
  Reads revalidate by stat (4.2).
- Exclusive operations stay single-session: `secrets init` over an existing vault, `reset`, `undelete`,
  `keep-removed`, and key rotation are refused with exit 6 while any other `orgai` is registered (4.4), naming them.
  Another process holding the old key would otherwise fail every read.

### 6.8 Logs

- Each CLI process writes its own `logs/orgai-<YYYYMMDD-HHMMSS>-<pid>.log` (2 MB, one rotation `.1`), so no two
  processes share a size counter or rename each other's file. Retention: the newest 20 files or 14 days, swept at boot
  skipping files of live registry entries.
- `orgai logs` (the TUI `/logs`) shows this process's file; `orgai doctor` names the folder.
- The desktop app keeps `main.log`.

## 7. CLI

### 7.1 Starting

- `orgai`, `orgai tui`, `orgai resume`, `orgai exec`, `orgai init` and every management command start their own
  in-process host and never refuse because another `orgai` runs. Exit 6 now means "busy in another orgai": a run lease
  (4.3), a project setup lease (6.3), a vault exclusive operation (6.7), an older binary on the folder (4.5), or a lock
  timeout (4.1).
- `ensureHost` / `startInprocHost` drop the ownership acquire for the CLI and do: format check/conversion (4.5),
  registry write (4.4), logging, vault, boot.
- `orgai resume` without a run picks the project's newest ended run that is not leased elsewhere; when every candidate
  is leased elsewhere it says which and exits 6.

### 7.2 Read-only commands

- `status`: lists live sessions from the registry ("3 orgai sessions: ~/a (pid 1, R2 running), ~/b (pid 7), exec in ~/a
  (pid 9)") and the latest runs per project with their live-elsewhere marks. The "Another orgai running: yes/no" line
  and `SNAPSHOT_NOTE` go.
- `runs list|show`, `projects list|show`, `usage show`, `secrets status`, `doctor`: keep their hostless file readers
  (now reading summary files and the registry); no snapshot note; runs live elsewhere show "running in another orgai
  (pid)". `doctor` runs its connection checks regardless of other sessions (they no longer conflict).
- The hostless reader keeps never writing (it does not reclaim dead leases).

### 7.3 TUI

- `/runs` lists every run of the project with live-elsewhere marks. Opening a run leased elsewhere shows it read-only
  (transcript from its record, refreshed when the record's stamp changes, 2 s poll) with the status line "Live in
  another orgai (<cwd>, pid). Read-only here." The composer is disabled with that text; `/run`, `c` (continue) and Enter
  on such a run say so instead of acting.
- The quit confirm counts this process's runs (already true, `App.tsx:306-308`); its text becomes "Quit and stop N
  run(s) of this session?".
- Status bar: "+2 sessions" when other `orgai` processes are registered; `/sessions` lists them (cwd, project, pid,
  live runs). No cross-session actions.

### 7.4 Help and docs

`orgai help`, the command table, `doctor`, exit code text ("6 busy in another orgai: a run, a setup, a vault operation
or an older orgai"), `cli-standalone-default.md` (G4 and the non-goal marked superseded by this spec),
`docs/agent-notes/cli-host.md`, CLAUDE.md, `.orgai/ARCHITECTURE.md`, and the self-help corpus, in the phase that
changes the behaviour.

## 8. Security

- New files live under the data folder (`run/` stays 0700; leases, registry, locks are created 0700/0600, owned by
  this user, checked like `run/` is today, `ownership.ts:556`). No new listening sockets; the CLI's dormant socket path
  is removed.
- The self-control gate keeps protecting `run`, `settings.json`, `secrets.json`, `codex`, `auth-cwd` from agents
  (`selfControlGate.ts:149`, code); `runs/*.lease` and `run/locks` are under protected roots or added to the list, so an
  agent cannot forge a lease to block or steal a run.
- A forged registry or lease entry can at worst make a run look live elsewhere (refusal, never data loss): liveness
  always checks pid plus start time.
- The worktree marker lives in `.git/`, which agents can write in their own worktree but not the common dir of the
  main checkout through the permission rules (**unverified**; phase 3 checks the rules cover `<commonDir>/orgai-worktrees`).

## 9. Tests and checks

Unit (vitest, no tokens):

- `dirLock`: contention between two child processes, stale reclaim after `kill -9`, pid reuse (start-time mismatch),
  heartbeat on 'unconfirmed', timeout text names the holder. `repoLock` tests keep passing over the shared core.
- `SharedJsonFile`: 2 child processes x 200 `update`s of one counter end at 400; stat revalidation picks up an external
  write; parse failure keeps the last good copy and refuses `update`; tmp names are unique.
- Each converted store: a write in process B is visible to process A's next read; no lost updates (two-process test
  per store family: projects, settings, libraries, vault).
- Run lease: continue refused with exit 6 while held; reclaimed after `kill -9` and the run normalised exactly once;
  hostless reader never reclaims.
- `RunStore`: per-run summaries, listing cache, 1,000-run listing under the 5.1 target, migration from `runs.json`
  (idempotent, interrupted halfway then rerun), no constructor normalisation.
- Sweeps (5.5 table): each one skips a live lease / live host's files and removes a dead one's.
- Worktrees: `reconcileLeftovers` skips a live foreign marker and handles a dead one; unmarked worktrees younger than
  10 min are skipped; uninstall refused with a live marker.
- Format fence: the released `ownership.ts` (checked out from git into a temp module) refuses a format-2 folder; a new
  binary refuses a folder with a live format-1 owner and converts nothing.
- `message_run` `other-session`, `list_runs` notice, setup lease, vault exclusive refusal, registry listing and stale
  entry removal, per-process logs and their retention.
- Removed or changed: the `wait: 'none'` ownership tests for the CLI path (kept for the desktop), `inprocHost.test.ts`
  "a second host ... is refused", `inprocHostRace.test.ts` (becomes "two hosts start at once, both run"),
  `ensureHost.test.ts`/`manage.test.ts` exit-6 cases, `cli.int.test.ts` "beside a running orgai", the snapshot-line
  tests (`readOnlyMatrix`, `status`, `runs`, `runRef`).

Integration (`*.int.test.ts`, real processes, mock adapter):

- Two in-process hosts on one folder start mock work runs in two projects and one in the same project; all finish; all
  summaries and records present; usage of both visible to a third reader.
- `kill -9` one host mid-run; a new host normalises only that run; the surviving host's run continues and finishes.

e2e (token-free, mock adapter, hidden windows not involved):

- New `e2e/cli-parallel.mjs`: one temp data folder, two temp projects. Two TUIs (A in project 1, B in project 2) and a
  third TUI in project 1 run at once; each starts a mock run; `orgai exec` runs alongside; `orgai status` lists 4
  sessions; `/runs` in A shows B's project-1 run as live elsewhere and opens it read-only; `orgai resume <that run>`
  exits 6 naming it; quitting B leaves A's runs running; `kill -9` of the third TUI, then a new `orgai` shows its run
  as ended by the app; `runs list` after all quit shows every run once.
- Updated: `cli-tui.mjs` (the "second orgai is refused" steps become "a second orgai runs"), `cli-readonly.mjs`
  (beside-an-owner steps: no snapshot note, no exit 6), `cli-exec.mjs` (two execs at once both succeed),
  `separation.mjs` (a second `orgai` on B runs; the app still refuses B and the CLI still refuses A).
- `package.json` `e2e:free`, CLAUDE.md's e2e list, `scripts/e2e-select.mjs` (map the new store/shared, run lease and
  registry paths to `cli-parallel`) in the same change.

## 10. Phases

Each phase passes the local gate (typecheck, the whole unit suite, build, `npm run test:scripts`, the e2e scripts of
its area, the Reviewer) before the next. Hot files touched: `runManager.ts`, `types.ts`, CLAUDE.md, ARCHITECTURE.md
(one claim at a time per CLAUDE.md).

1. **Primitives and fence**: `dirLock` (with `repoLock` on it), `SharedJsonFile`, run lease, host registry, format 2
   marker and fence with the old-binary test. No behaviour change yet (still single owner).
2. **Stores**: every 4.2 store onto `SharedJsonFile`; vault locked writes and exclusive operations; `RunStore` per-run
   summaries, listing, migration, constructor normalisation removed (5.3); lease taken by `RunManager` for every run
   start / continue; per-process logs.
3. **Sweeps and runtime**: 5.5 table, 6.1-6.6 (worktree markers, setup lease, Codex start lock, OAuth refresh lock,
   plan-usage cache, `message_run` / `list_runs`).
4. **CLI switch**: drop the single-owner acquire (7.1), registry-based `status`/`doctor`, read-only commands, TUI 7.3,
   exit 6 meanings, tests of 9 that assert the old refusal.
5. **e2e and docs**: `cli-parallel.mjs`, updated scripts, e2e lists, help, docs of 7.4.

## 11. Unverified

- That the released `orgai` refuses a format-2 marker or the fence record (phase 1 test decides the fence).
- Concurrent Codex app-servers on one `CODEX_HOME` beyond the start race (6.5).
- Windows: `mkdir` lease and lock semantics are used by `repoLock` on Windows already but have not run there
  (`platform-ci.md`); pid start-time 'unconfirmed' path (4.3).
- Listing performance on a slow disk or network home folder (5.1 target is measured only on the owner's Mac).
- Live providers under several concurrent processes (rate limits per account are the user's; nothing here adds calls).
