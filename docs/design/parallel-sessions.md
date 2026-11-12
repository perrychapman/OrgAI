# Parallel `orgai` sessions: design spec

Status: draft 12, 2026-11-12. Draft 1 was reviewed by GPT Astra and Gemini Argon, drafts 2-11 by GPT Astra and Gemini
Carbon; all twenty-two reviews BLOCKED. Resolutions are in section 14. Owner direction (2026-11-11): "mirror Claude Code / Codex":
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
   normalises non-terminal runs in memory and the next write persists that (`ownership.ts:24-26`).
2. **Run index is one file rewritten whole** (`runs.json`, fixed tmp, `.slice(-500)`, `store/runs.ts:186-205`).
3. **Blind crash normalisation** in the RunStore constructor (in memory, persisted by the next write; `runs.ts:186-204`; it also sanitises fields, 102-126; an
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
  opens it; it is never written. Before each SQLite open, `lstat` (no descriptor) must show a regular, non-link file of
  size 0 owned by this user (POSIX), with no `-journal`, `-wal` or `-shm` sibling; anything else fails closed naming the path.
  Lock files are never opened, read or closed outside SQLite (closing a raw descriptor would drop the process's POSIX
  locks on the inode, SQLite "how to corrupt" 2.2).
- **Exclusive**: `BEGIN EXCLUSIVE`. **Shared**: `BEGIN` + `SELECT count(*) FROM sqlite_schema`. **Release**:
  `ROLLBACK`, then close. **Probe** (`'held' | 'free' | 'missing'`): open read-only (never creates), shared read; busy
  means an exclusive holder exists. Hostless readers use only probes.
- **In-process coordinator** (one per path, reader-writer aware): shared acquisitions share one connection with a
  reference count; an exclusive acquisition waits for in-process holders in FIFO order; **claims** (`waitMs = 0`) never
  queue and fail at once on any conflict, in-process or OS; **probes** bypass the coordinator.
- **Reentrancy is mode-checked.** A lock the current async context already holds (`AsyncLocalStorage` held-set) is
  reused: held exclusive satisfies shared and exclusive; held shared satisfies only shared, and an exclusive request in
  that context throws (an assertion). Async children inherit the held-set; operations do not run sibling mutations
  concurrently under one held-set (tested).
- **Upgrading a session hold.** Removing a project and uninstalling a repository need the exclusive form of a lock the
  session itself holds shared (`project-<pid>`, `repo-usage-<repo>`). SQLite cannot upgrade a shared read in place, so
  the upgrade runs **inside the resource's transaction lock** (`team-<pid>` for `project-<pid>`; `team-<pid>` then
  `repo-<repo>` for `repo-usage-<repo>`), and every exclusive claim of those two keys anywhere is taken only inside the
  same transaction lock. No other process can therefore try the exclusive form during the transition, and the only
  possible conflict is other processes' shared holds, which never block re-taking shared. `upgradeHold(key)`: only
  when this process's hold is the only in-process holder and no run or operation of this process uses the resource;
  mark the resource transitioning in-process (local users wait); on the coordinator's connection `ROLLBACK`, `BEGIN
  EXCLUSIVE` (`waitMs = 0`); on busy, re-take shared (cannot fail, see above), clear the mark, report busy (exit 6).
  `downgradeHold(key)` after a declined or failed operation, still inside the transaction lock: `ROLLBACK`, re-take
  shared, re-read that the resource still exists. After a completed removal the hold is simply released and the
  session leaves the project (onboarding in the TUI).
- **Waiting**: try; on `SQLITE_BUSY` close the connection, sleep (5 ms doubling to 100 ms, ±25 % jitter), reopen by
  path, retry until `waitMs`. On Windows, `EACCES`/`EPERM`/`SQLITE_CANTOPEN` from a sharing violation are retried the
  same way once folder trust (below) has passed. Every other error fails closed; no in-process fallback. Shutdown
  aborts waiters.
- **Never by pid**: no pid, start time, heartbeat or age decides that a holder is gone. A suspended holder keeps its
  lock (`SIGSTOP` test).
- **Lock files are kept.** No lock file is ever deleted, except a host lock by its own host at a clean exit (no other
  process ever acquires a host lock; probers that open a deleted path see 'missing', which means the host is gone,
  which it is). Chain, project, exec-chain, session-binding and every other lock file stay (0 bytes each; a sweep for
  them is not needed and would reintroduce the unlink race of SQLite "how to corrupt" 2.4). A crashed host's lock file
  is removed by housekeeping together with its registry entry (5.4); no process other than that host ever acquires it.
- **Advisory info**: `<lock>.json` beside a lock may hold `{ pid, hostInstanceId, ownerCwd, since }` for messages; it
  never decides anything (section 9); every string from it passes `sanitizeTty` with a length cap before display.
- **Network file systems**: SQLite's locks are not reliable over NFS/SMB (SQLite documentation, unverified here). The
  first start on a folder and `doctor` report a data or lock folder on a network file system (`statfs` on
  macOS/Linux, `GetDriveType` on Windows, unverified on Windows).

**Lock folders**: `<dataDir>/control/locks/` (data-folder locks; `control/` is never copied or published, 4.7) and
`<user cache>/orgai/locks/` for locks keyed by a path outside the data folder (the whole `<user cache>/orgai/` tree,
`locks/` and `journal/`, is control state: folder trust below and the gate's protection, 9, apply to all of it) (`~/Library/Caches`, `%LOCALAPPDATA%`,
`${XDG_CACHE_HOME:-~/.cache}`), named `<kind>-<sha256(pathKey(path))[0..32]>.lock` (`pathKey`, `repoLock.ts:122`,
code).

**Folder trust**, checked once per process before the first lock and failing closed:

- The lock folder itself: owned by the user, mode 0700 (POSIX), created so; on Windows created with
  `icacls /inheritance:r /grant:r *<userSid>:(OI)(CI)F *S-1-5-18:(OI)(CI)F` (absolute `icacls` path as
  `restrictDaemonSecretAcl` in `host/protocol.ts` does, called from `ownership.ts:1091-1118`; the SYSTEM grant is new)
  and verified by SID.
- Ancestors, walking up from `realpath(lockFolder)` to `realpath(home)` when inside it, else to the file-system root:
  - POSIX: owned by the user or root; not group/other writable, **except** a root-owned directory with the sticky bit
    (such as `/tmp`, `/private/tmp`) whose child on the path is a real directory owned by the user (sticky semantics:
    nobody else can rename or remove it).
  - macOS: ACLs read with `/bin/ls -ledn` (numeric ids; any line that does not parse fails closed). `deny` entries
    are ignored. An `allow` entry carrying `delete`, `delete_child`, `add_file`, `add_subdirectory`, `write`,
    `writesecurity` or `chown` on the lock folder or an ancestor (or inherited into the lock folder with any of them)
    is accepted only for `user:<own uid>` (and `user:0` above the lock folder); any `group:*` or `everyone` entry with
    one of them fails. Read-only entries (`list`, `search`, `read*`) are fine.
  - Windows: no reparse point; on each component no ACE granting `DELETE`, `WRITE_DAC`, `WRITE_OWNER` or
    `GENERIC_ALL`, and on each parent no ACE granting `FILE_DELETE_CHILD`, to a principal other than the user, SYSTEM
    and Administrators (`S-1-5-32-544`), including inherited ACEs; a create-subdirectory grant to others on a shared
    parent is allowed (it gives no rights over the protected child).
- Unverified on Windows; CI tests a permissive ancestor, a sticky `/tmp` parent, a macOS ACL grant on an ancestor
  (including `delete` only and a `group:` grant), a Windows `DELETE`-only grant, and
  (where the runner allows) an ancestor rename by another principal.

### 4.2 Claims, session holds, transaction locks and their order

- **Claims** never wait (`waitMs = 0`): they succeed at once or the operation is refused, so they cannot take part
  in a deadlock and are exempt from the order. Claims: `host-<id>`, exclusive `admission` (4.6), `chain-<chainId>`,
  `execchain-<projectId>-<execChainId>`, `setup-<pid>`, exclusive `project-<pid>` and `repo-usage-<repo>` (through
  `upgradeHold`, 4.1), `worktree-<repo>-<branch>`, `housekeeping`.
- **Session holds** are shared locks that never wait (they conflict only with an exclusive claim, which is a refusal):
  shared `project-<pid>` (taken when a session opens, creates, promotes into or runs in a stored project, at any point),
  shared `repo-usage-<repo>`. Shared `admission` is the one waiting hold, taken first at process start (4.6).
- **Transaction locks** wait (bounded) and are acquired in this order; several locks of one row in sorted key order.
  **Coordinators** compute the lock set they need from a read, acquire it in order, re-read and check the set is
  unchanged (else release all and retry, at most 3 times), then work; services called inside reuse the held locks and
  **assert** that every lock they need is already held (a missing one is a bug, not a late acquisition). A debug
  assertion also throws on an out-of-order acquisition. **Save-hook closure**: any lock set that saves a stored
  project includes, for each such project, `team-<pid>` and (when its team files are active) `repo-<its repo>`, plus
  the `oauth-<owner>` locks of credentials the save moves; when team files are active it also includes `vault` (and
  the `oauth-<owner>` of an evicted server) because an auto-applied server removal can evict a tombstone and delete
  that server's secrets (`commitTombstones`, `teamFiles/service.ts`, code), and `library` when an active team-files
  project's documents reference a catalog connector not yet in the library (`serverFor` → `connectorEntry` →
  `connectorsAdd`). **Every row of the table below is a base set**: the coordinator adds the save-hook closure for
  each stored project the operation saves, so a row never needs to repeat it, and the recording-lock tests check the
  final set.
  **Effect discovery**: a coordinator's read includes every effect **and dependency** its services may have: library
  entries they link to or copy from (`linkLibrary`, `copyFromLibrary`: the source must not change or disappear during
  the link), templates they read, and connector entries a team-files or capability operation may add to or remove
  from the library (`connectorEntryForTeam` /
  `connectorsAdd` / `discardConnectorEntryForTeam`, `mcp/service.ts:1743-1768`, code); if one is possible, `library`
  is in the set. A lock-contract assertion is never caught and turned into an ordinary lookup failure.

| Order | Transaction lock | Wait | Covers |
|---|---|---|---|
| 1 | `library` | 60 s | skill library, MCP library and its builds (`v2/mcp-builds/`), connector presets, org templates |
| 2 | `team-<pid>` (sorted) | 60 s | everything that composes a stored project: team files (every entry point, 3.5) and `.orgai/` writes, project skills and their undo, project MCP servers, capability reviews/apply/undo, evolution ledger, skill-evaluation commit, setup proposals, the save hook and its cleanup |
| 3 | `repo-<repo>` (sorted; legacy `mkdir` lock inside, 6.2) | 60 s | git operations, `CLAUDE.md` / `ARCHITECTURE.md` writes |
| 4 | `oauth-<credentialOwner>` (sorted) | 60 s | refresh, revoke, retarget, authorise commit (network inside) |
| 5 | `plan-usage-<key>`, `models-discovery`, `prices-refresh` | 60 s | single-flight network |
| 6 | `codex-start` | 60 s | Codex app-server start (may be taken under order 5) |
| 7 | `outputs-<pid>` (sorted) | 15 s | every outputs mutation |
| 7b | `output-file-<hash>` (cache; `<hash>` = `sha256(pathKey(canonical destination))[0..32]`, the destination being `join(realpath(dirname(dest)), basename(dest))`; sorted) | 15 s | the physical file of a registered output: validation (stale-content and unseen-change checks) through replacement or deletion and the metadata commit; two projects (or data folders) that registered the same file serialise on it |
| 8 | `knowledge-<pid>` | 15 s | knowledge graph |
| 9 | `notes-<pid>`, `engagement-<pid>`, `staffing-<pid>` | 15 s | per-project data (staffing: `recordRunInStaffingProfile`) |
| 10 | `permissions-<rules file>` (cache, keyed by `pathKey(rulesFileOf(target))`) | 15 s | permission rules, taken inside `permissionRules.ts` |
| 11 | `vault` | 15 s | every vault read-decide-commit (6.7) |
| 12 | `config` | 15 s | every `SharedJsonFile` update (4.4) |

No transaction lock is held across a model call: evolution's hybrid synthesis, capability reviews and skill
evaluations run their model step outside `team-<pid>` on a snapshot and commit under it only if the generation they
started from is unchanged. **Process starts and network calls under locks**: provider, MCP server, Codex and custodian
processes, and network calls, start only under orders 4-6 or with no transaction lock held at all (custodians: no lock,
6.7). Two bounded local helpers are allowed under the locks that need them: `git` under `repo-<repo>` (order 3) and
the OS trash call under `output-file-<hash>` (order 7b).

**Lock sets per operation** (each an integration test through the real services with a recording lock layer,
coordinator retry included):

| Operation | Lock set |
|---|---|
| kit import | 1 → 2 (affected and linked projects) → 3 → 4 → 11 → 12 |
| library skill/MCP/preset/template edit or removal with linked projects; `skills:promote`, `mcp:promote`, `persistInstall` with scope `library` (MCP install card), template save-from-project and apply | 1 → 2 (source and linked projects) → 3 (their repos) → 4 (when credentials move) → 11 → 12 |
| setup proposal | by kind: `mcpServers`/`skills` that create, update or **link** library entries 1 → 2 (target and linked projects); project-only proposals without links 2; then 3 for `.orgai/`/`CLAUDE.md`, 9 (`engagement-<pid>`) for an engagement `architecture`, 10 for `settings` permission rules, 11, 12 |
| capability apply / undo | 1 when a connector is added or removed, a library MCP server or library skill is linked (`libraryMcp`, `librarySkill`), or undo removes a created library entry → 2 (target, and linked projects on undo) → 3 → 4 when undo clears credentials → 11 → 12 |
| `projects:create` | 1 when a template is used or team-files adoption may add a connector → 2 (`team-<newId>`) → 3 → 4 (when adoption moves credentials) → 11 → 12; the new project's shared hold is taken after the project exists |
| team-files operation (approve, reject, enable, remove, undo, overwrite, commit, `createFromFolder`, `evaluate`'s auto-apply) | 1 when a connector entry may be added or removed → 2 → 3 → 4 (server secrets) → 11 → 12 |
| team-files read checks (`status`, `focused`, `beforeRun`, each project of `listAttention` / `checkAll`) | inspect read-only first; when a change is needed, release and run the team-files operation's coordinator |
| project MCP server add, edit, remove; `persistInstall` with scope `project` | 2 → 3 → 4 (when credentials move or clear) → 11 → 12 |
| `mcp:copyFromLibrary`, `mcp:linkLibrary`, `skills:linkLibrary` | 1 → 2 → 3 → 11 → 12 |
| setup lifecycle saves (`prepare`, `complete`, `markScaffolded`, `markArchitectureUpdated`, `applyOrg`) | 2 → 3 → 9 (`engagement-<pid>` for an engagement architecture) → 12 |
| accept edits for a project (`acceptEditsForProject` sets `permissionMode`, a team-owned field) | 2 → 3 → 12 |
| capability apply / undo, setup proposals, kit import, evolution | as listed, with the save-hook closure |
| project skill create, update, removal | 2 → 3 → 12 |
| team definition import (`projects:applyImport`; the folder digest re-checked under the locks) | 2 → 3 → 12 |
| team definition export (`projects:exportOrg`, writes `.orgai/org.json`) | 2 → 3 |
| community price refresh (`CommunityPrices.refresh`, single flight) | 5 (`prices-refresh`) → 12 |
| evolution commit | 2 → 3 → 12 |
| uninstall | 2 → 3 → `repo-usage` upgrade (4.1) |
| project removal | 2 → `project` upgrade or exclusive claim (4.1) → claims on every chain of the project (6.3) → 3 → 7, 8, 9 → 11 → 12 |
| OAuth refresh/revoke/authorise | 4 → 11 → 12; the **OAuth slice** (the whole `McpOAuthConfig` sub-object of a project server or library entry, plus `McpLibraryEntry.connectedAt`) is patched by `SharedJsonFile.update` / `mutateProject` under 12 only (it has no team-file effects), never through `library` or `team` saves; the manual `clientId` / `clientSecret` saved before the browser opens is its own 4 → 11 → 12 section, released before the browser wait |
| model discovery | 5 (`models-discovery`) → 6 (Codex) → 12 (`models.json`); release; then project remapping as its own coordinator 2 (affected projects) → 3 (their repos) → 12 |
| `projects:remapModels`, `connections:update` remapping | 2 (affected projects) → 3 (their repos) → 12 |
| plan usage | 5 → 6 (Codex) → 12 |
| knowledge linking note ids | 8 → 9 |
| quick promotion (`runs:promoteQuick`) and its recovery | sorted chain claims → 2 (`team-<newId>`) → exclusive `project-<newId>` claim inside it → 12 |
| app settings toggles (`app:setNotifications` and every other `settings.set`) | 12, as a patch through `SharedJsonFile.update` |
| output edit, delete, restore, `deletePreview`'s capture, `OutputWatcher.tick`, `produce_output`, `register_output` | 7 (`outputs-<pid>`) → 7b (`output-file-<hash>`); `produce_output` renders outside the locks, then under them re-checks collision and capacity, writes and commits |
| `outputs:revise` | 7 → 7b for validation and the capture, released before it starts, continues or sends to the run; 7 again around `recordRevision` and, on a failed send, `runEnded` |
| file writers outside the outputs service: `outputs:saveAs`, `outputs:saveImage`, `exec --output-last-message`, `usage csv` export | 7b (`output-file-<hash>` of the destination) only: content and any dialog are prepared first; under the lock the destination's shared locators are checked (4.9) and the file is written; the hostless `usage csv` takes this cache lock too (it is outside the data folder) |
| `projects:setFolderConfigTrust` | 2 → 3 → 10 (`permissions-<rules file>`) → 12; the rule removal runs before the `config` update, never inside its transform |
| `skills:applySuggestion` | 2 → 3 → 11 → 12, re-checking under the locks that the suggestion is not yet applied |
| connections add, update, remove, logout, key save | 4 (when OAuth) → 11 → 12, following the endpoint-bound key protocol (6.9); a background probe's status rewrite 12 |
| `projects:save` (`projects edit`), `skills:applyImport`, `skills:undoImport`, `plugins:upsert`, `plugins:remove`, `mcp:setProjectOverrides` | 2 → 12 (closure added) |
| staffing record at run end | 9 (`staffing-<pid>`) |
| worktree integrate | claim (exempt) → 3 |
| journal recovery | the journal's recorded `requiredLocks` (4.9) |

### 4.3 Chains and the chain claim

- **Chain identity.** New persisted `RunSummary.chainId`: a new run's own id; a continuation copies its predecessor's.
  Conversion (4.7) computes it with today's membership rules: connected components over `resumedFrom` edges and shared
  non-empty `sessionId`s (union-find), id = the component's oldest member (`startedAt`, then id). Validated
  `^run_[A-Za-z0-9_-]{1,80}$`. After conversion the persisted `chainId` is authoritative and immutable: a `ChainWrite`
  for chain C refuses to write a summary whose on-disk or new `chainId` differs from C.
- **Chain ownership record.** `control/chains/<chainId>.json` `{ hostId, state: 'open' | 'clean', since }`, written
  under the chain claim (durable) **before** anything for the chain is spawned or written, and set to `clean` only
  after the chain is settled in that process (below). Whoever next claims the chain (resume, prune, promotion,
  stored-run writes, housekeeping) reads it first, under the claim:
  - `clean`: normal. `clean` means **writes settled and consumers released**: the owning host writes it only after
    the chain's provider processes and their descendants (from its own process table, 4.8) have exited, or after
    leaving them to a protection that outlives the chain (the epoch rule for skill and MCP build versions, 6.3). While a descendant of
    the chain lingers, the host keeps the record `open` with `lingering: [pids]` and re-checks every 5 s; if the host
    exits first, the next claimer runs the consumer check.
  - `open` (its host's claim was released without a clean settlement, so that host died): **unclean**; the consumer
    check (4.8) runs inline before anything else, whatever the run statuses say (a host can die after writing
    `finished`).
  - missing for a chain that has format-2 runs: **uncertain** (4.8).
  - Conversion writes every migrated chain's record (4.7 step 5) as `legacy-uncertain`: format 1 kept no evidence of
    the processes a run started, and a scan cannot prove them gone (a shell in a project root names no OrgAI path).
    `legacy-uncertain` counts as uncertain (4.8). The first TUI start after an upgrade asks once: "Conversations from
    before the upgrade: confirm that no older OrgAI is still running (all its terminals and agents have stopped)." A
    yes runs, in a host, over every chain: `withChainClaim` (`waitMs = 0`; busy → skip, a live session owns it), re-read
    the record, and write `clean` only if it is still `legacy-uncertain`. `orgai doctor --confirm-legacy-stopped` does
    the same as a short host command (not the hostless `doctor`), and `--after-crash` covers a single command. A scan for known-live processes (cwd inside a scratch folder,
    worktree or project root of the folder's projects; command lines naming a format-1 path component-wise, excluding
    this process, live format-2 hosts and their recorded descendants; on Windows CIM `Win32_Process.CommandLine`, no
    cwd) runs before the question and lists what it found; it only ever adds warnings, never clears.
- **Provider session binding.** Every point that records a provider session id (`session.started`, a `run.status`
  that sets or changes `sessionId`, continuation, restart; `runManager.ts:1883-1938, 4995-4998`, code) binds it under
  the chain claim: key `sha256("<adapter>\0<sessionId>")` with `<adapter>` the adapter whose session store holds it
  (`claude`, `codex`, or `mock` in tests); the exec-finalising path that records a session id (the
  `active.finalizing && !active.finalEmitting` early return, `runManager.ts:1885`, code) binds it before returning; the binding file `control/sessions/<key>.json` `{ chainId }` is published atomically (write
  `<key>.json.tmp-<hostId>-<random>` with `wx`, fsync, `link` to `<key>.json`, unlink the tmp; `EEXIST` → read the
  existing file: same `chainId` is success (idempotent), another `chainId` refuses the binding and ends the run with an
  error, "This provider session belongs to another conversation"). Conversion creates the bindings of migrated
  summaries before its commit (4.7 step 5). Bindings are removed with their chain (5.2) and swept when their chain has
  no summary and its claim is free (5.4).
- **One writer per chain.** The process that starts or continues a run claims `chain-<chainId>` before it chooses what
  to start and holds it until the chain is settled in that process: the run is terminal or deliberately paused without
  auto-resume, its late title arrived or was abandoned (60 s cap), evolution flush and exec finalisation are done, no
  auto-resume timer is armed, and the per-chain write queue drained with every write durable. Then it writes the
  ownership record `clean` and releases. At the 60 s title cap the title request is aborted (`titleAbort.abort()`) and
  its `ChainWrite` token invalidated before release, so a late answer cannot write. A follow-up in the **same**
  process during that tail (the user types right after a run ends) does not refuse: it aborts the title, awaits the
  tail's write queue, and takes over the claim the process already holds. `RunManager` serialises summary and record writes on that queue and awaits it
  (and `recordRunInStaffingProfile`, `outputs.runEnded`) before settling; shutdown drains the queues. A failed final
  write keeps the claim (and `open`) until exit.
- **Exec chains.** A run with `overrides.execChainId` also claims `execchain-<projectId>-<execChainId>` (the budget is
  per project, `runManager.ts:2652-2662`, code) on start and on `continueRun`, after the chain claim, held as long as
  the chain claim (including `waitForReset` timers).
- **RunStore enforces it.** Every mutation (`create`, `upsert`, `patchSummary`, `setUsage`, `saveRecord`,
  `saveImage`, `moveToProject` (summary **and** the record's embedded summary), `remove`) takes a `ChainWrite` token,
  created only by a held claim or by `withChainClaim(chainId, fn)` (claim, read the ownership record and classify,
  re-read the chain from disk, verify it exists, run `fn`, release). A chain exists when at least one summary carries
  its `chainId` (its first run may have been pruned). `usageSummaries` back-fill is in memory only.
  `getRecord` returns null when the summary is missing.
- **Continue, resume, `exec --continue`, auto-resume, `resume --now`, `resume --cancel-auto-resume`, `tui <run>` with
  input**: claim the chain; busy refuses with exit 6: "This conversation (R3, run_abc) is live in another orgai
  (<cwd>, pid). Use that one, or quit it first." Under the claim, classify (above), re-read the chain and recompute the
  target with today's rules (`newestContinuable` / `canContinueIn`) and the remaining budget.
- **Stored-run writes from another session** (`runs model`, permission mode, `stop` of a paused run, delete, move):
  `withChainClaim`; busy refuses with the same text.
- **Scratch folders** (quick runs, Chat, MCP `allowBuild` assistants, `dispatcher.ts:1106-1117`): one allocator,
  `allocateScratch(chainWrite)`, requiring a held chain claim, creates `v2/quick/<chainId>/` (continuations share it).
  Both start paths (`QuickRunService.start`, `mcp:startAssist`) mint run and chain ids and claim the chain first.
  `SCRATCH_NAME` / `scratchDirFor` / `McpService.genuineWorkspace` accept the new form; `quick.folder` and
  `buildWorkspace` point to it.
- **Promotion** claims every chain of the runs it moves (sorted), classifies each, re-reads membership, refuses if any
  member is live or paused with auto-resume, takes `team-<newId>` and inside it the exclusive `project-<newId>` claim
  (as every exclusive project claim is taken, 4.1), journals (4.9), creates the project with `pending: true` under
  `config` (pending projects are hidden and cannot be opened), moves summaries and records, clears `pending`,
  releases.

### 4.4 Shared JSON files: `SharedJsonFile<T>`

For `v2/` `projects.json`, `settings.json`, `skill-library.json`, `mcp-library.json`, `connector-presets.json`,
`models.json`, `model-prices.json`, `retained-run-projects.json`, `org-templates/templates.json`, `tui-hints.json`
(moved from `<userDataDir>/tui-hints.json` into `v2/` by conversion), `plan-usage.json`.

- `read()` is a cached parse revalidated by `stat` (size, mtimeNs, ino) on every call; services that cached derived
  copies (`ConnectionService.discovered`, `CommunityPrices`, settings listeners, the project tier context) read
  through it and re-derive on change.
- `update(fn): Promise<T>` takes `config` (order 12), re-reads from disk, applies `fn`, writes
  `<file>.tmp-<hostId>-<random>` (`wx`, fsync, rename, fsync the directory). `durableFs.writeFileDurable` uses the
  same unique tmp names everywhere (no fixed `<file>.tmp`, no unlinking another writer's tmp).
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

- Each host (TUI, exec, management command, desktop) claims `host-<hostInstanceId>` for its lifetime, reads the
  **version epoch** `E` (6.3) and writes `control/hosts/<hostInstanceId>.json` (`{ pid, hostInstanceId, hostKind,
  appVersion, ownerCwd, projectId?, command, startedAt, epoch: E }`) before opening any store. The registry is
  advisory for messages; its `epoch` is the one value version retirement trusts (it lives in protected `control/`, 9),
  and a held host lock without a readable registry entry blocks all version retirement and an initial empty `control/hosts/<hostInstanceId>.children.json` **before** it can spawn
  anything (4.8). A host is live exactly when its lock is held (probe).
- Owner-scoped resources carry the `hostInstanceId` and live under `v2/`, never the OS temp dir:
  `v2/tmp/skills/<hostId>/` with one `<runId>-<random>/` folder per run, removed at run end (replacing
  `orgai-skills-*` in the OS temp dir; legacy names are never touched),
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

- `<dataDir>/control/`: coordination only (`locks/`, `hosts/`, `chains/`, `journal/`, `sessions/`, `epoch.json`).
  Conversion creates `epoch.json` as `{ epoch: 1 }` if absent (kept across retries).
- **Two paths, not one**: code receives `rootDataDir` (`<dataDir>`) and `storeDir` (`<dataDir>/v2`) separately.
  Containment guards (`ProjectStore.createPathError`, `resolveAllowedDirectories`, the self-control gate, the vault's
  key-file location checks `keyFileArg` and `keyFilePathProblem`) refuse the whole `rootDataDir`; stores and scratch allocation use `storeDir`; `openPathRefusal` allows `storeDir` except
  vault files and never `control/`. Created when first needed
  (also by phase 2, 12), never copied, never published, never deleted. Old code does not know it.
- `<dataDir>/v2/`: format-2 data. It counts as committed only when `v2/FORMAT.json` (`{ format: 2, createdBy,
  manifestSha256 }`) exists and parses; it is written inside the staging folder and published with it by one rename.
  Contents: every store, `runs/`, `quick/`, `skills/` (library skill bodies), `mcp-builds/`, `codex/` (the Codex
  home), `project-skills/`, `evolution/`,
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
   **Path relocation**: every persisted operational path into a legacy location is rewritten to its new location by a
   typed relocation table (MCP server `command`/`args`/`cwd`/`env` in projects and MCP library entries, installed MCP
   build paths (into `v2/mcp-builds/<entryId>/<buildId>/`, 6.3), `RunSummary.quick.folder`, `buildWorkspace`, the
   summaries embedded in records, project paths of quick and assistant projects, skill and template asset paths).
   A legacy location is a path whose components, after `<dataDir>`, start with a format-1 top-level name (anything
   but `v2`, `v2.staging-*` and `control`), compared component by component. The fail-closed check scans the
   operational stores and fields only (`projects.json`, `settings.json`, the libraries, presets, templates, summaries
   and records' embedded summaries, excluding `title`, `prompt`, `error`, `transcript`, `logs` and other free text)
   and fails the conversion, listing the field paths, if a legacy location remains. Transcripts and logs are copied
   as history, unchanged. Paths outside the data folder are left alone. A unit test runs the exhaustive scan over
   synthetic fixtures with the free-text exclusion list, so a new operational field is caught.
   **Skills and builds** become version folders: `skills/<entryId>/` → `skills/<entryId>/<versionId>/`,
   `project-skills/<pid>/<skillId>/` → `project-skills/<pid>/<skillId>/<versionId>/`, `mcp-builds/<entryId>/` →
   `mcp-builds/<entryId>/<buildId>/`, with `versionId` / `buildId` written into `skill-library.json`, `projects.json`
   and `mcp-library.json` (6.3).
5. Fsync every written file and directory; write `MANIFEST.json` (path, size and SHA-256 of every regular file in
   staging except the Codex home's caches) and then `FORMAT.json`, fsync both and the staging directory; re-read and
   validate everything. Write, durably, every migrated chain's ownership record (`legacy-uncertain`, 4.3) and provider
   session binding in `control/`, each tagged with this **conversion attempt id** (also recorded in `FORMAT.json`), so
   they exist before the commit. Before writing, under the still-held exclusive `admission` and with no committed
   `v2/`, every chain record and binding carrying a different conversion attempt id (an aborted earlier attempt) is
   removed (lock files are kept); a retry therefore never meets a stale binding. After the commit, records whose
   attempt id differs from `FORMAT.json`'s are removed by the next start. Re-check the source manifest, the fence content and the mutex owner
   token: any difference means an old process touched the folder: discard the staging folder and refuse ("Another
   OrgAI changed this folder during the upgrade; quit it and start again").
6. Rename `v2.staging-<hostId>` to `v2` (it does not exist yet), fsync `<dataDir>`. This is the commit point.
7. Write the format-2 product marker (durable). Release the mutex, then turn the exclusive `admission` claim into the
   process's normal shared hold (release, then take shared like any other start). A crash during step 7 is finished
   by the next start (missing fences are re-written).

Recovery: a committed `v2/` (valid `FORMAT.json`) → format 2, with missing fences re-written. A `v2/` without a valid
`FORMAT.json` cannot be produced by this procedure; if found, it is refused naming it. A leftover `v2.staging-*` whose
host lock is free is deleted and conversion restarts. Readers: committed `v2/` → read it; else format 1 (today's
reader); the format-1 files never change, so a reader that chose format 1 keeps a consistent view. Format-1 files are
kept; `doctor` reports their size; a later release deletes them after one release of overlap. Downgrade is not
supported; `doctor` says so.

### 4.8 Consumers: processes a host started

The OS frees a dead host's locks, but agents, shells, git, MCP servers or Codex processes it started may still run.

- **Evidence**: each host keeps `control/hosts/<hostId>.children.json` current (durable). Before every process it
  spawns it records a **pending spawn** `{ chainId?, kind, since }` (`chainId` absent for host-level processes:
  Codex app-server, MCP stdio servers, git checks); after the spawn it replaces that entry with the child's pid and
  start time (durable); an unresolved pending spawn makes the evidence uncertain. The Claude adapter passes a spawn
  callback to the SDK (`spawnClaudeCodeProcess`, **unverified** in SDK 0.3.318, `package.json`). **Fallback** when the
  callback is not available: the adapter serialises the start of Claude `query()` calls per host and resolves the one
  open pending spawn from a process-table read that includes the command line (`ps -A -o pid=,ppid=,lstart=,args=`;
  Windows CIM `ProcessId`, `ParentProcessId`, `CreationDate`, `ExecutablePath`, `CommandLine`; a new reader beside
  `shutdown.ts`'s, which has no command column), matching a new child of this host whose executable and arguments are
  exactly the `executable` / `pathToClaudeCodeExecutable` the adapter passed. It polls at once when the query yields
  its `system/init` message, and otherwise every 250 ms. The serialisation wait is bounded (5 s after `system/init`, or
  15 s after the start): if the child is still unmatched, the pending spawn is kept as a sticky `uncertain` record for
  the life of that query (crash recovery stays uncertain) and the start gate is released, so other queries in the
  host never wait on it. A failed table read counts as no match. `probeUsage` and `listModels` await their `drain`
  before their query counts as settled. When a query settles with its pending spawn unresolved, the host takes one
  descendant snapshot and then clears it. One observation never discharges more than one spawn, and no other child
  (git, Codex, MCP servers) can match. Read-only probes that run before the host is registered (shell environment, system
  certificates, folder-trust `ls`/`icacls`, the host's own start-time `ps`) are exempt: they run in a neutral folder
  and finish before anything is opened. Every 5 s it adds
  newly seen descendants and keeps every descendant it has ever recorded until it has seen that process exit (a
  reparented descendant stays listed). Contents: its descendants (pid and start time) from the process-table reader
  `shutdown.ts` already uses (`ps -A -o pid=,ppid=,stat=,lstart=`; Windows CIM `Win32_Process`, code), and each live
  run's chain id, scratch folder, worktree paths and MCP build directories in use.
- **Where it applies**: an unclean, `open` or uncertain (including `legacy-uncertain`, cleared only by the user's
  confirmation, 4.3) chain, and every resource of a dead host (its worktrees,
  owner-scoped dirs, journals, the scratch folders of its chains, skill and MCP build versions it may have used).
- **Consumer check**: the dead host's evidence file exists and is readable; none of its recorded descendants is alive
  with the same start time; no pending spawn is unresolved; and (macOS/Linux) no process has its working directory
  inside an OrgAI-private folder of the chain (its scratch folder, its report worktrees, the dead host's
  `harness-workspace` and `auth-cwd`) (`lsof -a -d cwd -Fn`, measured on macOS), not counting this process, its
  ancestors, live format-2 hosts and their recorded descendants. Processes whose working directory is the project
  folder (the user's shell, editor, another session) do not count against the check; when the case is uncertain
  anyway, they are listed in the confirmation as a warning. Missing or unreadable evidence, or an ownership record that
  names no host, is **uncertain**.
- **Outcomes**: passes → act, and the chain's ownership record becomes `clean`. Finds a process → refuse ("Processes
  started by an earlier orgai session are still running here (pid …). Stop them or wait, then try again.").
  Uncertain, or Windows (no cwd check) → no automatic action; a user action asks for confirmation in a TUI, and
  non-interactive commands (`exec --continue`, `resume`, `projects remove`) refuse with exit 6 unless `--after-crash`
  is given. Prune, scratch sweeps and promotion skip uncertain chains.
- **Evidence retention**: a dead host's `children.json`, registry entry and lock file are removed only when its
  consumer check passes (uncertain evidence keeps them, so the host stays known as dead-and-uncertain), or when the user
  confirms it stopped (`--after-crash`, the TUI confirmation).
- **Limits** (stated, tested where possible): a grandchild started and orphaned between two snapshots, whose cwd is
  outside the resources, escapes the evidence; OrgAI does not contain processes (no OS job or cgroup control). Tests
  kill only the host while a mock child keeps writing and assert refusal, run housekeeping twice, delete the evidence,
  resume before housekeeping, crash after a `finished` summary, and settle-then-prune. Unverified: that the Claude CLI
  and Codex app-server exit when their host's pipes close.

### 4.9 Journals for multi-file operations

- **Record**: a journaled operation writes `control/journal/ops/<opId>.json` under its locks before its first change:
  `{ op, hostId, requiredLocks, resources: [keys], steps: [{ id, kind, args, done }], state }` with `state` `active`
  → `committed`. Each step is an idempotent action (write this file version, patch these project fields, publish this
  directory version, remove this entry) with a precondition and postcondition it can check (the identity the target
  must have before and after: a file version, a field value, a directory's existence), and a conditional inverse.
  For every resource key it touches an immutable **locator** `control/journal/by-resource/<key>/<opId>` (an empty file
  whose name is the operation id) is created and its parent fsynced, so an operation on any of those resources finds
  it; state is always read from the canonical `ops/<opId>.json`, never through a locator. Resource keys: `project-<pid>`, `library`, `mcp-build-<entryId>`, `skill-<entryId>`,
  `outputs-<pid>`, `output-file-<hash>`, `notes-<pid>`, `templates`, `chain-<chainId>` (promotion). An operation on an
  output file also writes a **shared locator** `<user cache>/orgai/journal/output-file-<hash>/<folderId>-<opId>.json`
  (`{ dataFolder, opId }`, durable, written with the local locators and removed with them in step 4, before the
  canonical journal). Another data folder that takes `output-file-<hash>` and finds a shared locator from a different
  folder X checks X's canonical journal `X/control/journal/ops/<opId>.json`: X gone, or the journal absent or
  `committed` → the locator is stale and is removed (under `output-file-<hash>`), and the operation proceeds; the
  journal present and not committed → refuse ("An unfinished change to this file from <folder> must be finished
  there first; start OrgAI on that folder."); X unreadable → refuse with `doctor` guidance. A folder's own recovery
  also removes its shared locators whose canonical journal is absent. Ids are validated and `dataFolder` is shown
  through `sanitizeTty` with a cap.
- **Durable ordering**: (1) locators (local, and shared for output files) written and fsynced, then the canonical
  journal (files and directories fsynced); a locator whose canonical journal is absent is stale and any contender
  removes it; (2) for each step: mark it `started` (durable), make its effect durable (tmp + fsync + rename + directory
  fsync through one shared atomic-write helper, which notes, templates and every other journaled store use), mark it
  `done` (durable); (3) `state: committed` (durable) only after **every** step, including the post-commit ones
  (companion files after `projects.json`, data after the project left `projects.json`), is done; (4) locators, then
  the canonical journal unlinked, directories fsynced. Canonical updates are tmp + rename of `ops/<opId>.json`.
- **Recovery** never infers completion from a resource's generation. A pending journal found under a resource key:
  - its `requiredLocks` not all held by this operation: release everything, run a recovery coordinator that acquires
    `requiredLocks` in order (and, if the journal's host is dead, runs its consumer check), recover, release, and
    restart the operation from the beginning. `requiredLocks` may include claims (chain, project); a busy or
    uncertain claim defers recovery (the journal stays; the operation refuses with the claim's message);
  - `committed`: only remove it;
  - `active` or `abandoned` with **no step `started`**: it made no change; remove its locators and the journal (never
    re-create locators, never roll forward);
  - `active`: per the operation's rule. **Roll forward** (the default): for each step not `done`, check its
    postcondition (already applied → mark done) else its precondition (→ apply, mark done), then commit. **Roll back**
    (only where the rule says so, and only while no step past the rule's point of no return has `started`): for every
    step that is `started` or `done`, in reverse, check its postcondition and apply the conditional inverse if it
    holds; rollback progress is recorded (`undone`) so an interrupted rollback continues. A step whose pre- and
    postcondition both fail (the target changed outside the operation) stops recovery, keeps the journal as
    `needs-attention`, refuses the operation and shows it in `doctor` and `/sessions`;
  - a locator whose canonical journal is missing is removed; a canonical journal whose locators are incomplete gets
    them re-created before anything else;
  - idempotent; never re-creates a retired chain or project (existence checked first).
  A journal can be pending while its own host is alive (the operation threw, or its finally-handler could not finish):
  the host marks it `abandoned` when it can; either way, whoever next holds `requiredLocks` recovers it.
  Housekeeping uses the same recovery coordinator.
- **Project fields**: journaled steps patch only fields owned by `team-<pid>`. The only fields a `config`-only patch
  may change are `allowedDirectories` (from `allowDirectories`) and the OAuth slice (4.2); they are listed in
  `projects.ts`.
  Journal steps that patch `mcpServers` or library entries merge by server or entry id and keep the live on-disk OAuth
  slice (4.2: the whole `McpOAuthConfig` and `connectedAt`) when the endpoint and credential owner are unchanged; the
  OAuth slice is never part of a step's pre- or postcondition. Metadata-only library edits carry `buildId` over with
  `buildDigest` when the target is the same (`sameTarget`). `permissionMode` is team-owned (`acceptEditsForProject` takes `team-<pid>`, 4.2).
- **Output-file steps** carry the destination's content hash as their precondition and the new content's hash as
  their postcondition, so recovery never overwrites a change made in between.
- **Needs attention**: `orgai doctor --resolve-journal <opId> (--finish | --discard)` (a short host command, with a
  confirmation naming the files involved) and the same action in the TUI's `/sessions` let the user settle a
  `needs-attention` journal; nothing else clears one.
- **Operations** (rule: F = roll forward, B = roll back), each with kill-point tests between every pair of steps, a
  live session touching the resource before housekeeping, a host alive after a thrown error, a crash after each
  effect and before its `done` mark, a crash during rollback, and power-loss tests (un-fsynced writes dropped after
  journal removal): quick promotion (F if the pending project exists in `projects.json`, else B; recovery uses
  promotion's own lock set from 4.2: sorted chain claims → `team-<newId>` → exclusive `project-<newId>` inside it →
  `config`);
  MCP build install and replacement (F: publish the version, repoint the entry); MCP library entry removal (F); every
  skill folder writer (F: publish a version, repoint, update linked projects): library create, update, removal,
  `libraryAddFromFolder`, `libraryAddFromBundle`, `libraryImportForKit`, project skill create, update, removal,
  promotion, `applyImport`, `undoImport`, `addSnapshot` (capability apply), `TeamFilesService.applyDoc`'s
  `storeFiles` / `removeFiles`, and proposal rollback; skill proposal apply (F) and rollback (F); kit import (F); evolution apply and
  rollback (F); team-files apply (F); output version commit (F); notes (F: body, then index); templates (F: `org.json`,
  then index); project removal (F: out of `projects.json`, then data); team definition import (`projects:applyImport`,
  F).
- **Durability scope**: the ordering above is exact for process crashes on every platform (each step is visible to
  the next process once its call returned). Power-loss ordering additionally needs directory fsync, which
  `durableFs` performs on macOS and Linux and cannot perform on Windows or on file systems that refuse it
  (`durableFs.ts:75-89`, code). There the guarantee is narrowed: after a power loss a recent rename may be lost even
  though its journal was removed; `durableFs` reports which case applied, `doctor` states the narrower guarantee on
  such systems, and the power-loss tests run against the narrowed contract there.
- Journals become active in the activation phase together with host claims and consumer evidence (12).

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
orphan-project removal and delete: per chain, `withChainClaim` (busy: skip); under it classify the ownership record
(4.3; unclean or uncertain chains are skipped unless the consumer check passes) and re-read; prune only members that are
terminal or deliberately paused; delete their images, record, summary (in that order). A provider session binding is
removed only when no remaining summary of the chain carries that session; the chain's ownership record only when the
chain has no summary and no scratch folder left. Lock files are never deleted (4.1). Retention is the existing
per-project `prune(keepFor)`, which removes runs one by one, not whole chains.

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
| superseded skill and MCP build versions | 6.3 epoch rule, under `library` (library skills, builds) or `team-<pid>` (project skills), after journals and before host cleanup |
| `prune(keepFor)`, orphan projects | 5.2; orphan-project removal re-reads `projects.json` and the retained list; project removal writes both in one `config` section |
| orphan records / image dirs | entries without a summary (never live, 5.1) |
| scratch folders `v2/quick/<chainId>/` | under the chain claim (busy: skip), ownership record classified, no summary of that chain references it |
| owner-scoped dirs and files (4.5), `.undo-<hostId>`, `v2.staging-*` | host lock free and consumer check passes |
| host registry, `children.json`, host lock files | host lock free and consumer check passes, or the user confirmed (the only lock files ever deleted, 4.1) |
| provider session bindings | under the binding's chain claim (busy: skip): no summary of that chain carries the session |
| quarantine of unclean chains | consumer check (4.8); passes → ownership record `clean` |
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
  elsewhere) if the project is gone. Removal claims it exclusive and refuses naming the sessions. Before anything
  is written it claims every chain of the project (busy: refuse with exit 6, never skip), classifies each ownership
  record, runs the consumer check (4.8) on every unclean or uncertain chain and every worktree of the project (live
  process: refuse; uncertain or Windows: refuse with exit 6 without `--after-crash`), and keeps those claims until the
  removal journal commits. Then, journaled (4.9): the project leaves `projects.json`, then runs (5.2), secrets,
  skills and project data are removed.
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
- **Virtual projects** (`quick`, `harness`, `skills`, `VIRTUAL_PROJECT_IDS`, code) are reserved ids that are never in
  `projects.json` and are never removed: they take no `project-` hold and no existence check; their resources are
  chain-scoped (scratch folders, 4.3) or host-scoped (`harness-workspace`, 4.5). Promotion out of `quick` is 4.3.
- **Skill and MCP build versions.** Library skill bodies (`v2/skills/<entryId>/<versionId>/`), project skills
  (`v2/project-skills/<pid>/<skillId>/<versionId>/`) and MCP builds (`v2/mcp-builds/<entryId>/<buildId>/`) are
  immutable version folders; metadata points at the current version. Every writer (4.9 list) publishes a new version
  and repoints under its journal; nothing is replaced in place. Readers (Claude staging, Codex, `load_skill`,
  `read_library_skill`, `SkillService.read`/`readFiles`, kit export, MCP server starts and restarts) resolve the
  current version from fresh metadata and read it directly; they take no hold.
- **Retirement by version epoch.** `control/epoch.json` holds a counter (an integer, never a clock), updated under
  `config`. When a version stops being current (repointed, its entry or skill removed, `undoImport`, team-files
  removal), the operation's **final** journal step, after every pointer change (library entries and every linked
  project) is durable, under `config` (in every such lock set, after `library` / `team-<pid>`): increments the counter
  to `R` (durable), then writes the sidecar
  `<versionDir>.retired.json` `{ retiredEpoch: R }` (durable). No version directory is ever removed inline (except under
  project removal's claims, 6.3). A host registered with `epoch ≥ R` read the counter after the pointers changed, so
  it can only ever resolve the new pointers. Housekeeping deletes a version only when, under `library` (library skills,
  builds) or `team-<pid>` (project skills): its sidecar exists; no entry points at it; no pending or `needs-attention`
  journal names it; every held host lock has a readable registry entry and every live host's `epoch ≥ R`; and every
  dead host whose `epoch < R` has passed its consumer check (dead hosts with uncertain evidence stay registered, 4.8,
  and block it). A version with no pointer, no sidecar and no journal (a crash before its journal existed) gets a
  sidecar through the same counter step, under the same locks (housekeeping runs it as a coordinator `library` or
  `team-<pid>` → `config`), and then follows the same rule. No wall-clock time is compared. **A retired version is
  never pointed at again**: rollback and undo publish a fresh version id with the snapshot version's content (a clone)
  and retire the version they leave, so a sidecar is never stale.
- **Skills**: `SkillService`'s constructor no longer removes `.undo` folders (housekeeping does, 5.4); undo backups
  live at `v2/project-skills/<pid>/.undo-<hostId>/<undoId>`. With version folders, `snapshotForProposal` records the
  current version ids of the locked target project's skills (and the affected library entries) instead of copying
  files; rollback publishes fresh versions with those contents and repoints the target project, the library entries
  and every linked project its proposal had updated (all already in its lock set), never other projects.
- **Staffing**: `recordRunInStaffingProfile` becomes async under `staffing-<pid>`.
- **Team-files status cache**: `TeamFilesService.check()`'s memo key adds the stat stamps of the project's team-files
  state files and the revisions of linked library entries, so another session's approval or rejection is seen.
- **Evolution ledger**: `readLedger` is pure on read paths (`evolve:history`, `analyze`); a corrupt ledger is set aside
  only by a writer holding `team-<pid>`.
- Two work runs in one project are allowed; starting one prints a notice when another session has a live run there.

### 6.4 Spend and plan usage

No cross-run cap is added. The plan-usage probe takes `plan-usage-<connectionKey>` (order 5), re-reads
`v2/plan-usage.json` (keyed by connection and account), probes only if older than 60 s, writes under `config`,
releases; a crash releases the lock (OS). Each process still probes only when it has no live run.

### 6.5 Codex

- `withCodexStartLock` adds `codex-start` (order 6) around the start (two starts on one home race on Codex's SQLite,
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
- **Destination binding** (as connections, 6.9):
  - `destinationDigest` = `sha256` of canonical JSON of the credential owner, the transport, the URL (origin and path)
    or command, arguments and working folder, the **values** of plain headers and plain environment entries, and for a
    project server its `envOverrides` / `headerOverrides`, for a library entry its sorted `perProjectEnv` list. Secret
    slot names and generations are not part of it.
  - Two generations, by lock owner: `secretGeneration` on the server or entry (changed by server and library edits,
    `1`/`2 → 3 → 4 → 11 → 12`), and `oauthGeneration` inside `McpOAuthConfig` (changed by OAuth, `4 → 11 → 12`). Vault
    keys carry them: `<owner>:secret:<slot>:g<n>`, `<owner>:oauth:g<n>`, each with the `destinationDigest` it belongs
    to. Adding a secret slot writes only that slot under the current generation; the others stay valid.
  - Changes: same destination and a new secret → replace only that slot under the current generation (one vault
    write; its digest is unchanged). A destination change → write the server
    with `secretGeneration: g+1` and its OAuth cleared (`oauthGeneration: null`) first, then purge the old generations
    (re-entered secrets are written under `g+1`). `mcp:authorize` records the destination digest before opening the
    browser and, at commit (`4 → 11 → 12`), refuses unless the live server's digest still equals it; then it writes
    `oauth g+1`, the OAuth slice, and purges `g`.
  - Readers re-read the server definition right before resolving credentials and use a credential only if its
    generation is the definition's current one and its digest equals the fresh definition's digest; otherwise re-read
    (up to 3 times) and fail with "This server is being changed in another session; try again." A retained
    specification is never combined with credentials directly.
  - Format-1 credentials (`mcp:<pid>:<sid>:*`, `mcplib:<eid>:*`) are used only while the server has no
    `secretGeneration` / `oauthGeneration` field at all (it has not changed since conversion, so the conversion-time
    pairing still holds); the first change writes the definition with its generation first and then purges them.
  - CLI `--secret-env` MCP values (`ORGAI_SECRET_MCP_*`, `ORGAI_SECRET_MCPLIB_*`, `secretOverlay.ts`, code) are bound at
    process start to the server's `destinationDigest` then, and refused after it changes.
  - Housekeeping purges MCP credential generations no definition names, under `11 → 12` with the vault, `projects.json`
    and `mcp-library.json` read under both.

### 6.7 Vault

- Reads revalidate `vault.json` by stat and reload when it changed; if a vault appears that this process has no key
  open for (another session created it), the next read that needs it opens the key through the custodian
  (`ensureFreshVault`, async) first.
- **Refresh boundaries**: `ensureFreshVault()` (async) runs at every dispatcher RPC entry, before `RunManager`
  resolves secrets for a run start or a probe, and before connection and MCP operations; it stat-checks `vault.json`,
  reloads it when changed, and re-opens the key through the custodian when this process has none or when the vault's
  `vaultId` changed. Synchronous reads (`get`, `has`, `keys`, `status`) then serve the refreshed state.
- Every mutation (`set`, `setMany`, `clear`, `delete`, `deletePrefix`, `purge`, `undelete`, `confirmDeletes`) becomes async:
  take `vault` (order 11), reload from disk, apply its delta to the fresh vault, commit, release. No custodian call
  (macOS Keychain `security`, Secret Service `secret-tool`, DPAPI through PowerShell; possibly an interactive unlock)
  runs under `vault` or under any other transaction lock: the first vault's key is prepared before any lock, then
  under `vault` the absence is re-checked and `vault.json` written with that id. If another session won, the loser
  discards its candidate **by scheme**: OS keyring custodians addressed by `vaultId` (`keychain`, `secret-service`)
  delete the candidate's own item; the key-file custodian (`ORGAI_CLI_VAULT_KEY_FILE`, which ignores `vaultId`,
  `custodians/keyFile.ts:780-816`, code) and DPAPI (key inline in the vault file) only zero the candidate in memory and
  never delete a key file. Creating a missing key file is published atomically (tmp, fsync, `link`; `EEXIST` → read
  the committed file) so no session sees a half-written key. `ensureFreshVault()` opens keys outside every lock. A
  coordinator throws a retry signal under `vault` (release the whole set, `ensureFreshVault()`, start over) only when
  its vault operation needs the key (`set`, `setMany`, `undelete`) **and** the vault's `vaultId` differs from the one
  `ensureFreshVault()` already tried for this operation. Metadata-only operations (`delete`, `deletePrefix`, `purge`,
  `confirmDeletes`) work on a locked or key-less vault as today; a cancelled unlock prompt fails the operation once,
  with no repeat prompt. Open-time reconcile and legacy retirement take `vault` only for their disk read-decide-write.
- Exclusive operations hold `admission` exclusive from before the store opens (4.6). Phase 2 converts every caller
  (`McpService`, `ConnectionService`, `TeamFilesService`, `SetupService`, `KitService`, `RunManager` (install cards),
  `dispatcher.ts` (project removal)) to the async API.

### 6.8 Logs

Each CLI process writes `v2/logs/orgai-<YYYYMMDD-HHMMSS>-<hostId>.log` (2 MB, one rotation); retention: newest 20
files or 14 days, never a live host's. The desktop keeps today's log location (`app.getPath('logs')/main.log`, or
`<ORGAI_DATA_DIR>/logs` when `ORGAI_DATA_DIR` is set, `index.ts`, code); it is the folder's only host, so one file is
safe. `doctor` names this process's file; the TUI `/logs` (run logs) is unchanged.

### 6.9 Connection endpoints and keys

A connection's endpoint (in `settings.json`) and its key (in the vault) are bound so a mismatched pair is never used:

- **Digest**: `endpointDigest` = `sha256` of canonical JSON `{ urls: sorted(normalised origin + path of every
  credential-bearing URL), authScheme }`: `anthropicBaseUrl`, `openaiBaseUrl`, `modelsUrl`, and the OAuth or proxy URL
  (`proxyOrigins` alone drops paths, `connections/service.ts`, code; two paths on one gateway are different
  destinations).
- **Storage**: each key is stored as `connection-<id>-g<generation>` with the `endpointDigest` it belongs to; the
  connection in `settings.json` carries `keyGeneration` (a number), `null` (no key), or nothing (a format-1 connection
  not changed since conversion).
- **Changes**, under 4 (if OAuth) → 11 → 12: a new key → write `g+1` with the new digest, then the connection with the
  new endpoint and `keyGeneration: g+1`, then `purge` (not `delete`, which would leave a removed-secret record) `g`. An
  endpoint change on the same host without a new key → re-wrap the existing key into `g+1` with the new digest, same
  order. A new host without a new key → write the connection with `hasApiKey: false, keyGeneration: null` first, then
  `purge` `g`. A crash at any point leaves one complete pair or no key.
- **Format-1 keys** (`connection:<id>:apiKey`, `connection:litellm:apiKey`): read only while the connection has no
  `keyGeneration` field at all; the first change writes the connection with its new `keyGeneration` (or `null`) before
  purging the legacy key.
- **CLI environment keys** (`ORGAI_SECRET_LITELLM_API_KEY`, `ORGAI_SECRET_PROXY_<hex>_API_KEY`, `secretOverlay.ts`,
  code): bound at process start to the connection's `endpointDigest` then; served only while the live connection's
  digest still matches, else refused ("This connection was changed in another session; restart orgai with the new
  key.").
- **Readers** (run starts, discovery, probes) read the connection, then the key of its `keyGeneration`, and use it only
  if the key's digest equals the digest of the connection they read; otherwise re-read (up to 3 times) and fail with
  "This connection is being changed in another session; try again." No lock is held across the network call.
- **Cleanup**: housekeeping takes 11 → 12, reads the vault and `settings.json` under both, and purges generations the
  connection no longer names (and legacy keys of connections that have a `keyGeneration`).

## 7. CLI

### 7.1 Command matrix

| Command | Host | Refusals (exit 6) |
|---|---|---|
| `orgai`, `tui`, `tui <run>` | own host; `project-<pid>` shared | continuing a chain claimed elsewhere (opening it read-only is allowed); a project being removed |
| `resume [run]`, `resume --now`, `resume --cancel-auto-resume`, `exec --continue` | own host; `project-<pid>` shared | chain claimed elsewhere; without a run: the newest continuable chain tip whose claim is free (others named), re-verified under the claim, retried up to 3 times on a race; a quarantined chain with uncertain evidence without `--after-crash` |
| `exec` | own host; `project-<pid>` shared | `execchain-<projectId>-<id>` busy |
| `init`, `projects create`, connection, model, library, settings commands, `usage refresh`, `doctor --confirm-legacy-stopped` | own short host | the operation's claim |
| `projects edit`, `org`, `team`, `permissions`, project `mcp`/`skills`, `knowledge`, `notes`, `kit` (per affected project), `outputs`, `worktrees`, `runs model` | own short host; `project-<pid>` shared | `setup-` claim, chain claim for `runs model`, `repo-usage` for uninstall, a stale project revision, a project being removed |
| `projects remove` | own short host | `project-<pid>` exclusive |
| `secrets init|reset|undelete|keep-removed` | own short host with `admission` exclusive instead of shared | `admission` busy |
| `status`, `runs list|show`, `projects list|show`, `usage show|csv` (the CSV file itself under its output-file lock, 4.2), `completions`, `help`, `--version` | none (hostless reader: reads files and probes locks; never writes, converts, settles or cleans) | never |
| `secrets status [--probe]` | file checks hostless; custodian state and `--probe` in an own short host, read-only (never reconciles or writes); during an exclusive admission the custodian part is reported as a warning | never |
| `doctor` | metadata hostless; connection checks in an own short host | never: if `admission` is held exclusive past the wait, the connection checks are reported as a warning ("skipped: another orgai is upgrading or resetting this folder") |

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
- **Protected paths** (the self-control gate, `selfControlGate.ts:149-166`, code): the whole of `control/` and `v2/`
  is protected, with these carve-outs that stay usable by agents: the run's own scratch folder
  `v2/quick/<its chainId>/` and its host's `v2/harness-workspace/<hostId>/` (read and write), and the run's own staged
  skills `v2/tmp/skills/<hostId>/<runId>-<random>/`: `Read`, `Glob` and `Grep` allowed; file-edit tools denied. New in
  phase 3, for **both `Bash` and `PowerShell`**: a command that references the staged folder is allowed only when it
  matches a strict grammar: exactly one simple command; no leading environment assignments; no redirection, pipe,
  command substitution or subshell; and either (a) the program itself is a file inside `<staged>/skills/<skillId>/`
  (never `SKILL.md` or `.claude-plugin/**`), or (b) the program is one of `sh`, `bash`, `zsh`, `python`, `python3`,
  `node`, `bun`, `ruby` with **no option before** the script operand, or `deno run` with only `--allow-*` options, or
  `pwsh` / `powershell` with only `-NoProfile` and then `-File`; the first operand must resolve lexically and
  canonically to such a file; later operands are data and must not reach `v2/` or `control/` outside the run's
  carve-outs. Every other reference is a hard deny
  (today's reference-directory checks only ask, so this is new). Because the agent runs as the same user, file modes
  cannot stop a determined `chmod`; the staged folder is therefore re-staged fresh for every `query()` (or its
  `plugin.json` and `SKILL.md` hashes verified before reuse). Files are still made `0400` (`0500` for scripts) and
  folders `0500` on POSIX, read-only attributes on Windows, against accidents; cleanup and housekeeping restore
  `0700`/`0600` before removing them. Everything
  else under `v2/` (stores, `runs/`, `projects/`, `FORMAT.json`, `MANIFEST.json`, `mcp-builds/`, `codex/`, other
  chains' scratch folders, vault files) and today's entries at the folder root stay protected, plus the whole
  `<user cache>/orgai/` tree (lock folder and shared journal locators, lexical and canonical paths), `realpath(gitCommonDir)/orgai-worktrees` and `orgai-repo.lock`, and each report worktree's `.git`
  file. For those git paths, `Grep`/`Glob` are denied only when the search root is at or under `.git`, or the
  pattern or glob explicitly names `.git`; ordinary searches from a repository root or a worktree are allowed (search
  tools skip `.git` by default; **unverified** for every adapter's `Glob`, so a test per adapter checks it). The other
  product's folder (`otherProductDataDirs`) has `control/` and `v2/` protected with no carve-outs. A path counts as
  inside a carve-out only when both its lexical path and its canonical path (`canonicalDeep`: realpath of the nearest
  existing ancestor plus the rest) are inside it, so a symlink in a scratch folder pointing at `v2/` or `control/` is
  denied. The gate needs a carve-out form ("protected root except these subtrees for this run"), added in phase 3 with
  tests per adapter that an agent can use its own workspace while edits to a summary's `chainId` or status, another
  chain's scratch folder, `control/` and the vault are denied. **Unverified** that the permission rules cover `.git`
  internals in every adapter and mode.
- **Searches**: the gate's exemption for `Grep`/`Glob` searches rooted above a protected path when filtered to "safe"
  extensions (`SAFE_SEARCH_EXTS` / `SAFE_SEARCH_TYPES`, `selfControlGate.ts:1931-1951`, code: it relies on "no protected
  file has one") no longer applies when the search can reach `v2/` or `control/`; only searches rooted inside a
  carve-out pass. Tests: `Grep` with `type: md` from `<dataDir>` and `~`, `Glob` `**/*.{md,js}` from `~`.
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
  non-zero, linked, WAL-sibling and foreign-owner lock files fail closed; no lock file but a host's own is ever
  deleted (a pruned chain keeps its lock file); folder trust with a
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
- Agent workspaces: an agent reads and writes its own `v2/quick/<chainId>/` and `v2/harness-workspace/<hostId>/`,
  reads but cannot write its own `v2/tmp/skills/<hostId>/<runId>-<random>/`; the same tools against another chain's
  scratch folder, another run's staged skills, `control/`, `v2/vault.json` and `v2/run` are denied.
- Projects: `project-<pid>` shared racing `projects remove` from a TUI, an `exec`, `orgai notes` and a library
  fan-out: nothing re-created; removal with a foreign live run refused.
- Worktrees: own-only automatic actions; nested subtree with a held descendant aborts; uninstall refused with another
  session in the repository; invalid branch names rejected.
- Multi-file operations: distinct output versions from two processes; skill rollback beside another process's skill
  change; MCP build rollback only its own staged dir; concurrent evolution commits in two processes; a capability
  review committed after another's change refused; notes index and bodies consistent; kit import paused after
  validation versus a library edit and an OAuth sign-in: the other side waits, no overwrite.
- Plan usage: two cold probes make one request; a probe owner killed mid-request releases; OpenAI model discovery and
  Codex plan usage take `codex-start` under order 5 and then remap projects as a separate coordinator.
- Draft-5 cases: mode-checked reentrancy (held shared never satisfies exclusive); `worktrees uninstall` and desktop
  project removal succeed when only this host holds the session hold and exit 6 when a second host holds it; a project
  skill edit meeting a dead host's kit-import journal releases, recovers through the journal's `requiredLocks` and
  restarts; a journal left by a live host after a thrown error is recovered by the next holder; resume before
  housekeeping and a crash after a `finished` summary both run the consumer check (ownership record `open`); a deleted
  ownership record is uncertain; a new chain being published is never affected by any sweep (lock files kept);
  provider session binding killed mid-publish, the same chain rebinding idempotently, migrated bindings present after
  conversion, orphan bindings swept; a live MCP server keeps reading its build while another session replaces and
  removes the library entry; relocation of quick-run and installed-MCP fixtures passes the component-wise check while
  transcripts mentioning old paths do not fail the conversion; folder trust accepts a 0700 folder under sticky `/tmp`
  and refuses a macOS ACL grant on an ancestor; virtual-project starts (quick, MCP build, skills assistant) beside
  housekeeping; setup proposals that create library entries beside a library fan-out with a second linked project;
  capability connector apply/undo, `skills:promote`, `mcp:promote`, MCP install card with library scope, OAuth display
  update, all through the recording lock layer; `SkillService` construction in a second session leaves the first
  session's undo folders; staffing records from two runs ending at once both kept; an agent's file-tool edit of a
  summary's `chainId` denied; `doctor` during an exclusive admission reports the warning.
- Draft-6 cases: library skill/MCP changes and project skill edits with team files on, fanning out to two
  repositories, through the recording lock layer (services assert held locks); a chain whose recorded child outlives
  terminal publication and queue drain stays `open` and resume/prune run the consumer check; the same through
  format-1 conversion (`legacy-uncertain` until the user confirms); a crash after `projects.json` is published and
  before each companion write: recovery rolls forward; a multi-resource journal (kit import) found from a project skill
  edit through its `by-resource` link; an OAuth display patch while a project journal is pending does not block its
  recovery; an MCP starter paused after resolving V1 while V1 is replaced keeps V1 until it exits (epoch rule); direct library
  skill edits killed between version publication, library repoint and each linked-project update, with a concurrent
  materialisation getting one complete version; two simultaneous hold upgrades and a downgrade racing a removal;
  conversion killed between the control writes and the commit rename, and after it; partial-chain prune keeps a
  binding still in use; agent searches with safe extensions from `~` and `<dataDir>` denied; staged skills of another
  run unreadable and own staged skills read-only; `ls -ledn` parsing with unparseable lines failing closed; team
  definition import and export through the recording lock layer; library skill bodies (`skills/`) present after
  conversion and a linked project skill working.
- Draft-7 cases: team-files approval with a not-yet-installed connector (and its rollback) beside a library edit, and
  the same through a project save hook; a canonical journal replaced after each step and recovered through every
  locator, including a crash during locator cleanup; a crash after each promotion move and before its `done` mark,
  and during rollback: every run kept and both summary copies restored; a legacy direct child writing in a project
  root after its host died: conversion and repeated housekeeping keep `legacy-uncertain` until the user confirms;
  conversion run as `orgai --data-dir <dir>` does not match itself; skill and build versions in use by a host started
  before supersession survive housekeeping, are deleted after it exits; a newly published version not yet pointed at
  survives housekeeping; migrated skills land in version folders; Codex runs and `read_library_skill` read a version
  being superseded; `acceptEditsForProject` beside a pending team-files journal; OAuth display refresh during a
  pending project journal keeps both; project removal with a busy, open or uncertain chain refuses before writing
  anything; team-files read checks escalate to the coordinator; setup lifecycle saves through the recording lock
  layer; project MCP server edits and `copyFromLibrary` racing a library removal.
- Draft-8 cases: capability `libraryMcp` / `librarySkill` apply and a project-only skill proposal that links a library
  skill, each racing removal of that library entry; capability undo clearing credentials; `projects:create` from a
  template with team-files adoption; host killed right after a child starts and before its evidence update, the child
  writing in the project root: resume, removal and housekeeping refuse; a reparented descendant stays in the evidence
  until it exits; an injected clock moved backwards across a replacement while an older host keeps V1: V1 survives
  (no clock is compared); a new host registering while pointers are being repointed never resolves a retired version;
  removing a library entry or skill whose version a live host uses: the version survives until that host exits; a held
  host lock without a registry entry blocks retirement; an aborted conversion whose source changed so a chain's
  representative changes: the retry completes with exactly its own bindings; dead-host evidence missing: the registry
  stays and blocks retirement across repeated passes; legacy confirmation while another session has resumed a migrated
  chain: that chain stays `open`; promotion recovery at the pending-project boundary; an OAuth sign-in's saved client id
  and `connectedAt` survive a concurrent library edit and journal replay; `usage refresh` beside another session;
  `e2e/cli-upgrade.mjs` asserts refusal before the legacy confirmation and continues after it.
- Draft-9 cases: two projects (and two data folders) registering one output file: concurrent edits serialise, a delete
  paused after its unseen-change check while the other publishes refuses instead of deleting, a pending output journal
  found through the other project is recovered; Windows/unsupported directory sync reported and the narrowed
  power-loss contract tested; recovery with an unrelated shell in the project folder passes the check, while an
  unresolved pending spawn or missing evidence still needs confirmation; Claude adapter killed right after the SDK
  spawns and before the pending spawn resolves: uncertain; a two-item skill proposal whose second item fails rolls back
  to a fresh version, then a new host, then a further edit and housekeeping: no version a live host reads is deleted;
  housekeeping's sidecar step passes the `config` assertion; `Grep({pattern})`, `Glob({pattern: "**/*.json"})` and
  `Glob({pattern: "*"})` from a repository root and a worktree succeed, a symlink in a scratch folder to `v2/vault.json`
  or to the other product's `v2/` is denied; `setFolderConfigTrust`, an auto-applied server removal at the tombstone
  limit, `skills:applySuggestion` from two sessions, a connection proxy change, `OutputWatcher.tick` and
  `outputs:revise` through the recording lock layer; a slow custodian during first-vault creation does not hold
  `vault`; a same-TUI follow-up during the title tail succeeds; `withChainClaim` on a chain whose first run was pruned;
  team-files status seen by another session after an approval; project creation at `rootDataDir` or `control/`
  refused.
- Draft-10 cases: crash after each step of an endpoint change and a reader paused between reading the connection and
  its key: the destination only ever receives its own key; two sessions creating the first vault with one provisioned
  key file (existing and not yet existing), the loser's cleanup, then a fresh process opens the winner's vault; a vault
  created by another session met inside a coordinator: release, open the key outside locks, retry; output `produce`,
  `restore` and `register` on a file another project registered, with a delete paused after its check; `outputs:revise`
  recording its revision under the outputs lock; a crash in data folder X between replacing an output file and its
  metadata, then an edit from folder Y refused until X recovers; every project-saving row of 4.2 with team files active
  and an evictable tombstone and an uninstalled catalog connector, through the recording lock layer (closure added);
  staged skills: edit tools and non-script `Bash` references denied, scripts run, cleanup succeeds after the modes;
  two concurrent and one fast-failing Claude `query()` under the process-table fallback: pending spawns resolved or
  cleared, never left open in a live host.
- Draft-11 cases: fallback mode with a snapshot that sees only the first child while a second query starts: the
  second start waits, and after killing the first child and the host, resume, prune and cleanup refuse; a project-only
  MCP test or run paused between reading its definition and resolving credentials while another session retargets and
  signs in: neither destination receives the other's credential; agent tools writing or deleting under
  `<user cache>/orgai/journal/` denied; a crash between removing the shared locator and the canonical journal (both
  orders) and a deleted owning folder: the other folder unblocks; a proxy retargeting only `openaiBaseUrl` while a run
  starts; a same-host path edit re-wraps the key; a new host without a key; a converted format-1 key works and is
  purged on first change; a CLI environment key refused after another session retargets; housekeeping interleaved with
  an update never purges `g+1`; Bash and PowerShell against staged skills (direct script, `python3` script, `chmod`,
  `-c`, redirection into `SKILL.md`, symlink from scratch) and re-staging per query; quick promotion through the
  recording lock layer with kill points around the pending project; `projects remove` and `mcp remove` on a key-less
  vault with no retry, and a cancelled unlock prompt on `secrets set` asking once.
- Draft-12 cases: converted authenticated project and library MCP servers keep working; a reader paused across the
  first post-conversion retarget, with and without `--secret-env`: each destination gets only its own credential; a
  plain header or environment value retarget without re-entering secrets refuses old credentials; adding a second
  secret slot keeps the first; a server edit during `mcp:authorize`'s browser wait refuses the commit; deletion paused
  after its check while `saveAs`, `saveImage`, `exec --output-last-message` and `usage csv` target the same file, and
  the same against a pending journal from another folder; folder X killed after writing its canonical output journal
  and before any step, Y commits the file, X then discards its unstarted journal and both folders stay usable;
  `doctor --resolve-journal`; a concurrent `git` or MCP child while a Claude pending spawn is open does not resolve it;
  a failed process-table read during a long session leaves the record uncertain without blocking `titleRun` or a
  second run; a timed-out `probeUsage` drains before the next query; two paths on one gateway are different
  connection destinations; the staged-skill grammar against `node -e`, `node --import`, `python3 -m`, `NODE_OPTIONS=`,
  `pwsh -co`, `powershell /c`, `pwsh -ec`; `secrets status --probe` beside another session.
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
   in their services, OAuth with `setMany`, per-chain write queue awaited, durable atomic-write helper, permission rules
   async with tmp + rename. Multi-file operations keep today's behaviour here; their journals come in phase 3. The single-owner gate is still in force; behaviour is unchanged.
3. **Activation (one change)**: journals and recovery (4.9), `v2/` layout and conversion with relocation and both fences, per-run summaries and
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

### 14.6 Draft 4, Astra (round 4)

| # | Finding | Resolution (draft 5) |
|---|---|---|
| 1 | quarantine bypassed before housekeeping or without metadata | 4.3 chain ownership record written before spawning, `clean` only after settlement, classified inline by every claimer; missing = uncertain; legacy leftovers classified at conversion |
| 2 | lock cleanup races a chain being published | 4.1 lock files are kept (only a host deletes its own lock; a dead host's by housekeeping, never acquired by others) |
| 3 | setup proposals need `library` | 4.2 lock sets by proposal kind |
| 4 | run metadata writable by agents | 9 whole `control/` and `v2/` protected with workspace carve-outs; `ChainWrite` refuses a changed `chainId` |
| 5 | MCP build replaced under a live server | 6.3 immutable build versions, use holds, sweep by exclusive claim |
| 6 | relocation validator rejects `v2/` paths | 4.7 component-wise legacy namespaces, operational fields only |
| 7 | journal removal before durable resource writes; conversion metadata | 4.9 durable ordering and a shared fsyncing helper; 4.7 step 5 |
| 8 | macOS ACLs | 4.1 folder trust with `ls -led` ACL checks |
| 9 | virtual projects fail existence checks | 6.3 reserved ids, chain- or host-scoped |
| 10 | journals before their prerequisites; live-host exceptions | 12 journals in phase 3; 4.9 `abandoned` and recovery by the next holder |

### 14.7 Draft 4, Carbon (round 4)

| # | Finding | Resolution (draft 5) |
|---|---|---|
| F1 | order-5 row, discovery remapping, setup, capability, promotions, OAuth display fields | 4.2: `codex-start` its own order after 5; remapping a separate coordinator; lock sets per operation; OAuth display fields under `config` only |
| F2 | mode-blind reentrancy; self-conflicting session holds | 4.1 mode-checked reentrancy, `upgradeHold` / `downgradeHold` |
| F3 | inline recovery with too few locks; `mcp-build` unranked | 4.9 `requiredLocks` and a recovery coordinator; builds under `library` and immutable (6.3) |
| F4 | generic scan fails on transcripts | 4.7 operational fields only; exhaustive scan in a unit test |
| F5 | sticky `/tmp`, walk boundary, Windows ancestors | 4.1 folder trust rules |
| F6 | session binding atomicity, idempotence, migration, orphans, key | 4.3 `link` publication, same-chain success, created at conversion, swept (5.4), key `adapter\0sessionId` |
| F7 | `SkillService` constructor sweep; `snapshotForProposal` scope and temp dir | 6.3 |
| F8 | vault `purge`, refresh boundaries, `vaultId`, callers | 6.7 |
| F9 | staffing profile writer; `readLedger` rename on read | 4.2 order 9, 6.3 |
| F10 | `doctor` and exclusive admission; tests | 7.1; 11 |

### 14.8 Draft 5, Astra (round 5)

| # | Finding | Resolution (draft 6) |
|---|---|---|
| 1 | coordinator sets miss the save hook's repo locks | 4.2 save-hook closure applied to every set; services assert held locks |
| 2 | `clean` before consumers stop; legacy terminal chains | 4.3 `clean` = writes settled and consumers released (`lingering` while not); `legacy-uncertain` until the legacy release scan passes |
| 3 | journal completion inferred from a generation | 4.9 step log with `done` flags and `committed` after every step; recovery rolls forward or back by rule, never by generation |
| 4 | MCP build reservation for starters | 6.3 reserve under the use hold, `RETIRED` marker, re-resolve |
| 5 | ordinary skill mutations | 6.3 immutable skill versions; 4.9 operations list; materialisation under a use hold |
| 6 | folder trust misses `delete` / `DELETE` | 4.1 |
| 7 | failed hold upgrade restoration | 4.1 upgrade inside the transaction lock, so re-taking shared cannot fail |
| 8 | chain-lock deletion contradictions | 4.1, 5.2, 11: lock files are never deleted except a host's own (earlier rows in 14.3 describing deletion are superseded) |

### 14.9 Draft 5, Carbon (round 5)

| # | Finding | Resolution (draft 6) |
|---|---|---|
| H1 | `expected.after` skips post-commit steps; single resource key; `config`-only patches vs journals | 4.9 step log, `committed` after all steps, `by-resource` links, journal-owned vs `config`-only project fields |
| H2 | control records written after the commit rename | 4.7 step 5 writes them before step 6 |
| H3 | chain-lock deletion; partial prune removing live bindings; probe-only sweeps | 5.2, 5.4 |
| H4 | upgrade drops the shared lock | 4.1 inside the transaction lock |
| H5 | safe-extension search exemption | 9 |
| H6 | `skills/` missing from the layout | 4.7 |
| M1 | manifest hashes JSON only | 4.7 step 5 every file |
| M2 | staged skills per host and writable | 9 per run, read only |
| M3 | macOS ACL parsing | 4.1 `ls -ledn`, group/everyone refused, fail closed |
| M4 | team definition import/export; price refresh | 4.2 |
| L1 | stale order numbers | fixed |
| L2 | desktop log location | 6.8 |

### 14.10 Draft 6, Astra (round 6)

| # | Finding | Resolution (draft 7) |
|---|---|---|
| 1 | team-files operations may write the library | 4.2 effect discovery; `library` in the team-files set when a connector may be added or removed; assertions never swallowed |
| 2 | hard-linked journal indexes go stale | 4.9 immutable empty locators; state read from the canonical journal only; locator repair rules |
| 3 | rollback skips effects done before their `done` mark | 4.9 `started` marks, pre/postconditions, conditional inverses, recorded rollback progress, roll forward by default; promotion forward once the pending project exists |
| 4 | legacy scan marks surviving consumers clean | 4.3 every migrated chain `legacy-uncertain` until the user confirms once; the scan only adds warnings |
| 5 | contradictions (binding timing, staged-skill test) | 4.3, 11 |

### 14.11 Draft 6, Carbon (round 6)

| # | Finding | Resolution (draft 7) |
|---|---|---|
| H1 | skill versioning: conversion, readers without holds, missing writers | 4.7 step 4 wraps skills and builds into version folders; 6.3 epoch retirement needs no reader holds (Codex, tools and kit export included); 4.9 lists every skill folder writer |
| H2 | retirement vs publication; missing dead-host evidence | 6.3 epoch rule: only superseded versions, under `library` / `team-<pid>`, no pending journal, all live hosts newer, dead hosts without surviving or uncertain evidence; 5.4 row ordered after journals |
| H3 | lock-set omissions (remapping, team-files connectors, project MCP servers, copy/link from library) | 4.2 rows added |
| H4 | legacy scan self-match, Windows, stale `legacy-unclean` | 4.3 confirmation instead of auto-clear; scan excludes this process and format-2 hosts; Windows uses CIM; stale sentence removed |
| H5 | `permissionMode` and `oauth` sub-objects across the field split | 4.2 `acceptEditsForProject` under `team-<pid>`; 4.9 field list, id merges keeping `oauth` display data |
| H6 | project removal before chain checks | 6.3 claims every chain and runs consumer checks before writing |
| M1 | team-files read checks and setup lifecycle saves | 4.2 rows |
| M2 | staged skills path and permissions | 4.5, 9, 11 |
| L1 | `control/chains`, stale step reference, `-shm` | 4.7, 4.3, 4.1 |

### 14.12 Draft 7, Astra (round 7)

| # | Finding | Resolution (draft 8) |
|---|---|---|
| 1 | library links need `library` | 4.2 effect discovery includes dependencies; capability, setup and create rows |
| 2 | empty evidence certifies a crash right after spawning | 4.8 pending spawn intents, descendants kept until seen to exit, project-folder cwd check |
| 3 | wall-clock epoch | 6.3 logical counter; hosts record it at registration; sidecar written after pointers are durable |
| 4 | aborted conversion bindings poison retries | 4.7 conversion attempt id, stale records removed under exclusive admission |
| 5 | stale test text | 11 |

### 14.13 Draft 7, Carbon (round 7)

| # | Finding | Resolution (draft 8) |
|---|---|---|
| H1 | nowhere to record retirement on removal; unpointed versions deleted under readers | 6.3 sidecars on every way a version stops being current; no inline removal; one rule for all |
| H2 | retirement before pointers durable; registry gaps | 6.3 final journal step after all pointers; 4.5 epoch recorded before opening stores; held lock without registry blocks retirement |
| H3 | capability, undo, `projects:create` lock sets | 4.2 |
| H4 | dead-host registry removed despite uncertain evidence | 4.8, 5.4 removal only when the consumer check passes or the user confirms |
| H5 | bulk legacy confirmation overwrites open chains | 4.3 per-chain claim, only `legacy-uncertain` → `clean`, in a host |
| M1 | promotion partition; claims in `requiredLocks` | 4.9 |
| M2 | OAuth slice | 4.2, 4.9 |
| L1 | `usage csv|refresh`; upgrade e2e confirmation | 7.1, 11 |

### 14.14 Draft 8, Astra (round 8)

| # | Finding | Resolution (draft 9) |
|---|---|---|
| 1 | one physical output file registered by two projects | 4.2 order 7b `output-file-<path>` (cache, so other data folders too); journal resource key; tests |
| 2 | Windows directory sync | 4.9 durability scope: exact for process crashes, narrowed and reported for power loss where directory sync is impossible |

### 14.15 Draft 8, Carbon (round 8)

| # | Finding | Resolution (draft 9) |
|---|---|---|
| H1 | project-folder cwd check locks users out; Claude spawns not observable; host-level and pre-host spawns | 4.8 hard check only on OrgAI-private folders, project-folder processes as warnings; SDK spawn callback (unverified) with process-table fallback; optional `chainId`; pre-host probes exempt |
| H2 | epoch counter lock; stale sidecars after rollback; linked projects on rollback; `epoch.json` in layout | 6.3 counter under `config`; rollback publishes fresh versions; rollback covers linked projects; 4.7 |
| H3 | git paths break repo searches; other product's `v2`/`control`; symlink escape | 9 |
| H4 | folder-config trust, tombstone eviction, connections, suggestions, output watcher and revise | 4.2 rows and save-hook closure |
| H5 | custodian calls under `vault` | 6.7 |
| M1 | `rootDataDir` vs `storeDir` | 4.7 |
| M2 | title abort, same-host follow-up, pruned chain root, `mock` adapter, finalising binding | 4.3 |
| M3 | team-files status memo | 6.3 |
| L1 | citations | 4.1, 6.8; `RunStore` method names in 4.3 are the new API (today's `upsert`, `saveRecord`, `removeRecord` map onto them) |

### 14.16 Draft 9, Astra (round 9)

| # | Finding | Resolution (draft 10) |
|---|---|---|
| 1 | endpoint and key published separately | 6.9 generation-named keys bound to an endpoint digest; readers check the binding |
| 2 | loser cleanup deletes a shared key file | 6.7 scheme-aware discard; key files and DPAPI never deleted |
| 3 | output journals not discoverable across data folders | 4.9 shared locator in the cache; other folders refuse until recovered |
| 4 | rows vs closure; process starts under order 3 | 4.2 rows are base sets, closure added by the coordinator; explicit process-start rule |
| Low | §3 wording | 3 |

### 14.17 Draft 9, Carbon (round 9)

| # | Finding | Resolution (draft 10) |
|---|---|---|
| 1 | key-file candidate discard, half-written key file, custodian calls under other locks | 6.7 |
| 2 | output `produce` / `restore` / `register`, revise, locator key, trash call | 4.2, 4.9 |
| 3 | rows missing the closure; unlisted saving RPCs | 4.2 base sets plus closure (library, OAuth owner, vault included); rows added |
| 4 | staged-skill modes claimed but absent | 9 specified as new work |
| 5 | Claude fallback with concurrent or fast `query()` | 4.8 |
| 6 | SDK version, finalising guard name | 4.8, 4.3 |

### 14.18 Draft 10, Astra (round 10)

| # | Finding | Resolution (draft 11) |
|---|---|---|
| 1 | one observation discharges several pending spawns | 4.8 fallback serialises Claude starts; one observation resolves one spawn |
| 2 | MCP credentials not bound to the definition | 6.6 `definitionDigest` binding, fresh definition read before credentials |
| 3 | shared journal locators unprotected | 4.1, 9 the whole `<user cache>/orgai/` tree is control state |
| Low | §3.1 wording | 3 |

### 14.19 Draft 10, Carbon (round 10)

| # | Finding | Resolution (draft 11) |
|---|---|---|
| 1 | connection digest, re-wrap, new host without key, format-1 keys, CLI environment keys, cleanup locks and purge | 6.9 rewritten |
| 2 | shared locator order, deleted owning folder, protection, display | 4.9, 4.1, 9 |
| 3 | staged-skill shell rule | 9 explicit rule for Bash and PowerShell, re-staging per query |
| 4 | quick promotion lock set and hold invariant | 4.2 row, 4.3 |
| 5 | vault retry loop | 6.7 retry only when the key is needed and the vault changed |
| 6 | settings toggles, knowledge row | 4.2 |

### 14.20 Draft 11, Astra (round 11)

| # | Finding | Resolution (draft 12) |
|---|---|---|
| 1 | MCP credential migration and `--secret-env` | 6.6: format-1 credentials valid while no generation exists (definition unchanged since conversion); first change writes the generation then purges; overrides bound at start |
| 2 | file writers outside the outputs service | 4.2 row: `saveAs`, `saveImage`, `exec --output-last-message`, `usage csv` under the output-file lock with locator checks |
| 3 | promotion recovery wording | 4.9 |

### 14.21 Draft 11, Carbon (round 11)

| # | Finding | Resolution (draft 12) |
|---|---|---|
| 1 | fallback cannot identify Claude, can deadlock, settles before drain | 4.8: command-line process read and exact match, immediate poll on `system/init`, bounded wait with a sticky uncertain record, `drain` awaited |
| 2 | MCP digest values vs names, generations by lock owner, format-1, overlays, GC, authorize | 6.6 rewritten |
| 3 | unstarted journal recovery overwrites or wedges | 4.9 locators first, unstarted journals discarded, content-hash conditions, `doctor --resolve-journal` |
| 4 | promotion recovery order | 4.9 |
| 5 | connection digest without paths | 6.9 |
| 6 | staged-skill grammar | 9 strict grammar |
| 7 | `secrets status --probe`; key-file checks | 7.1, 4.7 |
