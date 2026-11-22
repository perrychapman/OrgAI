# Sessions: several `orgai` processes on one data folder

Status: implemented, 2026-11-22. Replaces the rule "one `orgai` per CLI data folder" (`cli-standalone-default.md` G4)
and is the built answer to the goal `parallel-sessions.md` set out. That spec stays as the record of a larger design
(a new data tree, journals, per-chain claims); none of it beyond the lock primitive is used. Where the two differ, this
document describes the product.

Every fact below says how it was checked. "Unit" = vitest, fake adapters. "Processes" = real child processes in a unit
test. "e2e" = `e2e/cli-parallel.mjs`, two terminal UIs on real pseudo-terminals with the mock adapter. Only macOS was
run; Linux and Windows are covered by CI when it runs, not by the author.

## What you can do

- Open the terminal UI in one project and, in another terminal, open it in a second project. And a third. Each is its
  own process with its own runs; quitting one ends only its runs (e2e).
- Run `orgai exec`, or any management command (`settings`, `connections`, `models`, `mcp`, `skills`, `projects`), in
  another terminal while a terminal UI is open (e2e).
- `orgai status` lists every running session: what it runs, where, its pid and the projects it holds. Read-only
  commands show a run another session hosts as live (e2e).
- Chats without a project run in any number of sessions at once (unit).

What is refused, with exit 6 and a sentence naming the other session's folder and pid:

- A second session on a project another session holds: opening the terminal UI there, `orgai exec` there, changing
  the project from outside (e2e).
- Changing a run another session hosts: sending to it, stopping it, continuing its conversation (unit).
- `orgai secrets init` and `reset` while another session runs: they replace secure storage under everyone (unit).

## The model

A **session** is one `orgai` host process. Four rules make any number of them safe on one folder.

1. **A session is alive exactly while it holds its lock.** `<data>/run/sessions/<id>.lock` is locked for the life of
   the process with an operating system lock (SQLite's `BEGIN EXCLUSIVE` on an empty file; `store/shared/syncLock.ts`
   over `osLock.ts`). The kernel releases it when the process ends, however it ends. Nothing ever reasons from a pid,
   a start time, a heartbeat or a file's age. (Processes: a killed holder's lock is free at once.)
2. **A shared file is changed on its newest content, one writer at a time.** Every store that keeps a JSON file in
   memory routes through `store/shared/storeSync.ts`: a change takes the data folder's one write lock, re-reads the
   file if another session changed it, applies the change, writes, and lets go. A read re-checks the file's stamp first
   (one `stat`, about a microsecond), so a session sees another's save on its next read. One lock for the whole folder
   means sections can nest and cannot deadlock. It is held only inside synchronous code, for milliseconds. (Processes:
   two processes x 100 runs, none lost.)
3. **A run belongs to the session that hosts it.** `runs.json` carries `owners`: run id to session id, for runs that
   are not ended. A run whose owner is alive keeps its status in every other session and cannot be written there. A
   run whose owner is gone is a crashed run and is settled as "ended when orgai closed" by whoever looks next, with no
   write needed. (Processes: a killed host's run.)
4. **One session per project.** A session claims the projects it works in (`project-<hash>.lock`, held like its own
   lock). The host checks every changing request: the stored projects and runs it names must be this session's
   (`host/sessionGuard.ts`). That keeps a project's own files (team, worktrees, notes, outputs, staffing profile,
   evolution ledger) with a single writer, which is what every project service was written for. The terminal UI
   claims its project when it opens.

The desktop app is untouched. It keeps one process per data folder and its own data folder; its stores get a sync
that does nothing (`SOLO`), so every path there is byte for byte what it was. (Unit: the whole existing suite.)

## Files

```
<data>/run/
  daemon.json              the one host an older orgai sees (see "Older versions")
  startup.mkdir/           the startup mutex (unchanged)
  d-<id>.sock              each session's liveness endpoint (unchanged)
  compile-cache/           V8 compile cache of the host and TUI chunks
  sessions/
    <id>.lock              a session's lock: 0 bytes, never written
    <id>.json              its record: pid, cwd, command, claimed projects
    project-<hash>.lock    a project claim: 0 bytes, never deleted, reused
    write.lock             the data folder's write lock
<data>/runs.json           { version, runs, owners? }
```

`<data>/run` is the folder agent tools are kept out of (`runtime/selfControlGate.ts`), so no new path needed
protecting.

## Starting and ending

- **Start.** Under the startup mutex: judge `daemon.json`; if a live session-sharing host is there, join it (write no
  `daemon.json`); otherwise become the advertised host. Either way sweep what dead sessions left and register. Two
  sessions starting together therefore register one after the other. A starting `orgai` waits up to 15 s for one that
  holds the mutex, instead of failing at once. (Processes: two started together both start.)
- **Housekeeping.** Pruning runs and deleting record files, scratch folders and stale temp folders is only right while
  nobody else is working. It runs when a session finds itself alone, inside the startup mutex so that nobody can join
  meanwhile; otherwise that start skips it. (Unit.)
- **End.** The session releases its claims and removes its record and lock file. If it was the advertised host and
  others run, it rewrites `daemon.json` to name the oldest of them rather than removing it. (Processes, e2e.)
- **Crash.** A killed session leaves its files; its locks are gone with it. Its runs read as crashed everywhere at
  once, its projects are free, and the next start sweeps its files. If it was the advertised host, a survivor takes
  `daemon.json` over on its next check (every 2 s). (Processes, e2e.)

## Older versions

An `orgai` from before sessions knows nothing of them. It decides from `daemon.json` alone, and on a free folder it
would settle every open run as crashed and sweep. So `daemon.json` always names one live session while any runs
(handed over at a clean end, taken over after a crash), with a field older versions ignore: `sessions: true`.

- Older `orgai` starts beside sessions: it sees a live host and refuses (exit 6), as it always did.
- New `orgai` starts beside an older one: the record has no `sessions`, so nobody joins it; refused (exit 6) with the
  old sentence. Read-only commands then answer from the saved files with the "saved snapshot" note, as before.

The one gap: between a crash of the advertised session and a survivor's next check (up to 2 s) an older `orgai`
starting right then would take the folder. It needs an old binary, a crash and that window together. (Unverified: no
older binary was run against this build; the rule was read from `ownership.ts` at the previous release.)

## What stores do

| File | Rule |
|---|---|
| `runs.json` | write lock, merged per run; `owners`; a run hosted elsewhere is read-only |
| `projects.json` | write lock, merged per project; `update()` reads and saves under one hold |
| `settings.json` | write lock; a save that meets a newer file keeps the fields the caller did not change; other sessions' listeners hear the change |
| `vault.json` | write lock for every commit; a value change re-reads first; a creation re-checks under the lock; a vault another session created is opened in the background |
| `skill-library.json`, `mcp-library.json`, `connector-presets.json`, `org-templates/templates.json`, `retained-run-projects.json` | write lock, merged per entry |
| `models.json`, `model-prices.json` | write lock; a session picks up what another discovered or fetched |
| `projects/<id>/outputs.json` | write lock (the Chat's index is shared by every session) |
| run records, images | written by the run's host only |
| everything under a stored project | the one session that holds the project |

A re-read that cannot parse a file keeps the store's memory and never writes an emptied copy back.

## Limits

- **Same project, two sessions: not supported.** It needs per-conversation claims, worktree ownership and merged
  project edits. The claim refuses it cleanly instead.
- **A run another session hosts is not followed live** from a second session. Read-only commands show it as it was
  last saved (a record is flushed every 1.5 s).
- **A process stopped inside a write** (SIGSTOP in the few milliseconds a section takes) makes other sessions' writes
  wait up to 15 s and then fail with an error naming the lock. A crash there loses nothing: files are replaced whole.
- **Settings merge is per field and best effort**: two sessions changing the same field at the same moment, the later
  one wins.
- **MCP builds and the logs** rely on convention, not a lock: a build belongs to the one assistant run that makes it;
  log lines are single appends.
- **Network file systems** are not supported for the data folder (operating system locks are unreliable there).
- **Plan-usage probes and model discovery** run in every long-lived session, so N terminal UIs probe N times.
- Each session is a whole process with its own memory (about 150 MB while it runs a turn, measured with `exec`).

## Startup cost

Measured on the owner's Mac, mock adapter, the built CLI before (origin/dev at d10dea58) and after, the same new data
folder for each, median of 11 runs (5 for exec).

| | temp folder with 80,000 entries | | clean temp folder | |
|---|---|---|---|---|
| | before | after | before | after |
| `orgai settings list` (starts a host) | 335 ms | 206 ms | 236 ms | 204 ms |
| `orgai exec`, one mock turn | 760 ms | 633 ms | 661 ms | 631 ms |
| `orgai status` (no host) | 64 ms | 65 ms | | |

- Two full reads of the temp folder on every host start are gone (`ownership.ts` only reads it for data folders whose
  socket path does not fit in the run folder; stale skill folders are swept off the start path, and only when alone).
  That is the whole difference between the two halves of the table: about 100 ms on a temp folder with 80,000 entries
  (this Mac's, full of test leftovers), a few milliseconds on a clean one.
- The compile cache (`<data>/run/compile-cache`) saves about 30 to 40 ms per command that starts a host.
- The terminal UI's chunk loads while the host starts, not before it. Not measured separately.
- Sessions cost a start nothing that shows: the numbers above are with sessions on.
- A session running a mock turn peaks at about 150 MB of memory, before and after.

## Not done

- Following another session's live run from the terminal UI.
- A `/sessions` view that updates by itself (it reads the sessions when opened).
- Removing the unused modules of `parallel-sessions.md` phase 1 (`lockOrder`, `sharedJsonFile`, `journal`,
  `hostRegistry`, `consumers`, `startTokens`, `chainClaim`, `sessionBinding`). Only `osLock.ts` is in use.
