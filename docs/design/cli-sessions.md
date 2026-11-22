# Sessions: several `orgai` processes on one data folder

Status: implemented, 2026-11-22, in two steps on that day. The first replaced the rule "one `orgai` per CLI data
folder" (`cli-standalone-default.md` G4) with one session per project. The second lifted that too: sessions share
projects (rules 4 and 5 below; the section "Sharing a project" lists what that took). This is the built answer to the
goal `parallel-sessions.md` set out. That spec stays as the record of a larger design (a new data tree, journals,
per-chain claims); none of it beyond the lock primitive is used. Where the two differ, this document describes the
product. A different design, one host process that every terminal connects to, was specified, reviewed and dropped:
see "Considered and not built" at the end.

Every fact below says how it was checked. "Unit" = vitest, fake adapters. "Processes" = real child processes in a unit
test. "e2e" = `e2e/cli-parallel.mjs`, terminal UIs on real pseudo-terminals with the mock adapter. Only macOS was
run by the author; Linux and Windows are covered by CI.

## What you can do

- Open the terminal UI in one project and, in another terminal, open it in a second project. And a third. Each is its
  own process with its own runs; quitting one ends only its runs (e2e).
- Open the terminal UI in the **same** project in a second terminal. Each starts and steers its own runs; the status
  bar of each says how many terminals are in the project ("Alpha (2 terminals)"), and each shows the other's runs
  read-only, as last saved (e2e, unit).
- Run `orgai exec`, or any management command (`settings`, `connections`, `models`, `mcp`, `skills`, `projects`,
  `team`, `permissions`, `knowledge`, `notes`), in another terminal while a terminal UI is open, in its project or
  another (e2e).
- `orgai status` lists every running session: what it runs, where, its pid and the projects it has open. Read-only
  commands show a run another session hosts as live (e2e).
- Chats without a project run in any number of sessions at once (unit).

What is refused, with exit 6 and a sentence naming the other session's folder and pid:

- Changing a run another session hosts: sending to it, stopping it, answering its cards, continuing its conversation
  before it has ended there. A run is steered in the terminal that hosts it (unit, e2e).
- Removing a project, moving it to another folder, or taking OrgAI out of its repository, while another session has
  it open (unit, e2e).
- Merging or discarding report branches while another session hosts a run that is working in that project (unit).
- `orgai secrets init` and `reset` while another session runs: they replace secure storage under everyone (unit).

## The model

A **session** is one `orgai` host process. Five rules make any number of them safe on one folder.

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
4. **A project is open in any number of sessions, and held alone only to remove or move it.** A session has the
   projects it works in *open*: `project-<hash>.lock`, held shared. Removing a project, moving it to another
   folder, or taking OrgAI out of its repository takes the same lock exclusively, which succeeds only when nobody else
   has it open; meanwhile nobody opens it. One session at a time tries for a project alone (`alone-turn.lock`), so two
   sessions that both have it open and both want it alone never both step aside. The host does this before every changing request (`host/sessionGuard.ts`): the projects the request names are
   opened, or held alone for the length of the request. (Processes: a shared hold in another process keeps an
   exclusive one out, and is gone when that process is killed.)
5. **A project's own files are changed as one step, on their newest content.** Rule 2 for everything scoped to one
   project: its record, its notes and document, its knowledge graph, its team files and their state, its staffing
   profile, its outputs, its skills, its permission rules, its evolution ledger. And a run leaves alone the report
   branches it did not make while any other run is working in the project. See "Sharing a project".

The desktop app is untouched. It keeps one process per data folder and its own data folder; its stores get a sync
that does nothing (`SOLO`), so every path there is byte for byte what it was. (Unit: the whole existing suite.)

## Files

```
<data>/run/
  daemon.json              the one host an older orgai sees (see "Older versions")
  startup.mkdir/           the startup mutex (unchanged)
  d-<id>.sock              each session's liveness endpoint (unchanged)
  compile-cache/<version>/ V8 compile cache of the host and TUI chunks
  sessions/
    <id>.lock              a session's lock: 0 bytes, never written
    <id>.json              its record: pid, cwd, command, claimed projects
    project-<hash>.lock    a project's lock: 0 bytes, never deleted; shared by every session that has it open
    work-<hash>.lock       a named lock held across awaits (team evolution, output changes of one project)
    alone-turn.lock        the turn to try for a project alone (held for milliseconds)
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
- **Housekeeping.** The start-up sweeps (runs of removed projects, record files and scratch folders nothing points
  to, stale temp folders) are only right while nobody else is working: a run another session is just creating looks
  like an orphan. They run when a session finds itself alone, inside the startup mutex so that nobody can join
  meanwhile; otherwise that start skips them. (Unit.)
- **Retention.** Dropping a project's oldest ended runs past its `keepRuns` still happens at every run end, in every
  session. It runs under the write lock on the newest index and never drops a run that is not ended, so its outcome is
  the same whichever session does it. (Unit: `runsShared.test.ts`.)
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

The one gap: for up to 2 s (a survivor's next check) `daemon.json` can be missing or name a session that is gone,
and an older `orgai` starting right then would take the folder. That happens after a crash of the advertised session,
and when the advertised session and the one it hands the record to quit at the same moment while a third keeps
running. It needs an old binary and that window together. (Unverified: no older binary was run against this build;
the rule was read from `ownership.ts` at the previous release.)

## Sharing a project

Every service scoped to one project was written for a single writer. What it took for two sessions to work in one
project, by kind of state (inventory of 2026-11-22):

- **Files read, changed and rewritten in synchronous code** go under the write lock as one step, so two sessions do
  it one after the other, each on what the other left. Three ways, by how the code is shaped:
  a function with a locked wrapper (knowledge graph, notes, engagement document, permission rules, staffing profile:
  the work is in its `...Unlocked` half); `TeamFilesService.oneChange` around each check and change of the team files
  and their state; and `oneChangePerCall` (`storeSync.ts`), which wraps a whole service so that each call into it is
  one step (skills, skill evaluation, MCP servers, outputs, setup, team reviews; `host/bootstrap.ts`). A call that
  returns a promise holds the lock for its synchronous start only, so code that awaits and then saves must save onto
  what is stored then, not onto the copy it started with (`SetupService.prepare` does; the outputs service takes the
  lock again around each read-snapshot-index step). (Processes: two processes each add 60 notes,
  60 knowledge nodes, 60 permission rules and 60 roles at the same moment; all 480 are there. With one lock taken
  away the test fails: between 34 and 57 of the 120 were lost in four runs.)
- **The project record** is saved whole, from a copy read earlier. A save now stores a three-way merge: the store
  keeps the versions it has handed out (by `updatedAt`, the last 8 per project), finds the one the caller's copy was
  made from, and puts only what the caller changed onto what the file holds now. Fields are compared whole; lists of
  things with an `id` (roles, MCP servers, skills) per item. (`store/projectMerge.ts`; unit, processes.)
- **Work that spans awaits** (evolving a team; changing a project's outputs) takes a named lock for its length
  (`store/shared/namedLock.ts`): one at a time per project across sessions, waiting up to 60 s for the other.
- **Agent worktrees.** A run start used to commit "leftover" work in every `worktree-agent-*` worktree of the
  repository and offer them for merging, and `integrate_worktrees` merged any of them; neither could tell that another
  live run was working in one. Now a run leaves alone every report branch it did not make while another run is
  working in the project (starting, running or stopping), in this process or another session
  (`RuntimeContext.otherRunsLive`, `runtime/integration.ts`), and `orgai worktrees merge|discard` is refused while
  another session hosts a run that is working there. A run that only waits for its user has no report at work, so
  the branches it left are leftovers as before. This also closes the same hole between two runs of one project in
  the desktop app. An idle run still counts while one of its reports works in the background or its branch waits at
  a merge card (`hasWorktreeAtWork`; for a run in another session, read from its saved record). (Unit.)
- **What one process keeps in memory about a project** is rebuilt from the files where it matters: the team files'
  status cache is keyed on the saved state too, so a change by another session invalidates it (unit); a skill's undo
  backups are no longer wiped at start while another session runs.
- **Runs.** Nothing new: a run belongs to the session that hosts it (rule 3). The run index tells each session which
  runs of the project are live elsewhere (`RunSummary.liveElsewhere`, added on read, never stored).

In the terminal UI a run that is live in another session is read-only: its record is re-read every 1.5 s (a host
saves a live run about that often), the status says where it is live, and it is never the run a terminal opens by
default. Once it has ended there it is an ordinary ended run, continuable from any terminal.

## What stores do

| File | Rule |
|---|---|
| `runs.json` | write lock, merged per run; `owners`; a run hosted elsewhere is read-only |
| `projects.json` | write lock, merged per project; a save from an older copy is merged per field and per role (`projectMerge.ts`) |
| `settings.json` | write lock; a save that meets a newer file keeps the fields the caller did not change; other sessions' listeners hear the change |
| `vault.json` | write lock for every commit; a value change re-reads first; a creation re-checks under the lock; a vault another session created is opened in the background |
| `skill-library.json`, `mcp-library.json`, `connector-presets.json`, `org-templates/templates.json`, `retained-run-projects.json` | write lock, merged per entry |
| `models.json`, `model-prices.json` | write lock; a session picks up what another discovered or fetched |
| `projects/<id>/outputs.json` | write lock (the Chat's index is shared by every session) |
| run records, images | written by the run's host only |
| a project's notes, document, knowledge graph, team-file state, staffing profile, skills, team review; its `.orgai/` files and `ARCHITECTURE.md` | write lock, one step per change (see "Sharing a project") |
| a project's `.claude/settings.local.json` (permission rules) | write lock among orgai sessions; other tools may write it too |
| `evolution/<projectId>.json`, a project's output versions and notes | a named lock per project for the whole operation |

A re-read that cannot parse a file keeps the store's memory and never writes an emptied copy back.

## Limits

- **A run is steered only in the terminal that hosts it.** Another terminal shows it read-only, as it was last saved
  (about 1.5 s behind), and cannot send to it, stop it or answer its cards. Answering from another terminal would
  need one process to trust another with approvals; see "Considered and not built".
- **Two runs in one project share its checkout.** Each orchestrator works in the project's own folder, as two runs
  in the desktop app do; writing reports are isolated in worktrees when the project isolates writers, and merges are
  serialised by the repository lock. Two orchestrators editing the same file at once is not prevented.
- **Leftover report branches wait while another run is working.** A run start neither commits nor offers branches
  left by earlier runs while another run is working in the project; the next run that starts when none is does.
- **The same field, or the same role, saved by two sessions at once:** the later save wins. Different fields and
  different roles are both kept.
- **A change to the team, the MCP servers or the skills made in one terminal does not reach a run that is live in
  another.** It is saved, and the next run (or continuation) uses it. (The desktop app applies such changes to its
  live runs; an `orgai` session does not, in its own runs either.)
- **Runs in different sessions do not message each other** (`message_run` answers that the target is not live here).
- **Undo of a skill or team change** works in the session that made the change, while it runs.
- **A team review** (the Team assistant's recommendations and what was dismissed) is saved whole: one computed or
  edited in one session replaces what another saved meanwhile. It is advisory data.
- **A project created in one terminal is open there from its next request on**, not from the moment it is created.
- **An output changed outside OrgAI while one session is saving an edit of it** can be recorded twice (once as an
  outside change by a delete preview in another session, once as the edit). Nothing is lost.
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
- The compile cache (`<data>/run/compile-cache/<version>`) saves about 30 to 40 ms per command that starts a host.
- The terminal UI's chunk loads while the host starts, not before it. Not measured separately.
- Sessions cost a start nothing that shows: the numbers above are with sessions on.
- A session running a mock turn peaks at about 150 MB of memory, before and after.

## Not done

- Answering or steering another session's run (see below).
- A `/sessions` view that updates by itself (it reads the sessions when opened; the status bar's terminal count does
  update).
- Trimming `osLock.ts`. The modules `parallel-sessions.md` phase 1 added for its larger design (`lockOrder`,
  `sharedJsonFile`, `journal`, `atomicWrite`, `paths`, `hostRegistry`, `consumers`, `startTokens`, `chainClaim`,
  `sessionBinding`) were removed on 2026-11-22: nothing in the product called them. `osLock.ts` stays, because the
  session locks are built on its file checks and probe; its asynchronous waiting API is now used only by its own tests.

## Considered and not built: one host for every terminal

On 2026-11-22 the owner of this change asked for "the proper way, even if it is a hard cutover". The design that looks
cleanest was specified and partly built: one detached `orgai` host process per data folder, every terminal a client
over the existing authenticated socket. Inside one process every per-project service is already correct, and any
terminal could follow and answer any run. An independent review of the spec (Gemini Carbon, checked against the code)
stopped it, for two reasons that are properties of the product, not of the draft:

- **Who may approve.** Today an approval exists only in the memory of the `orgai` process the user is typing in (a
  memory-only owner key, `socketServer.ts`), so nothing an agent starts can answer the cards of its own run. A host
  that serves every process holding `daemon.secret` can be reached by a script an agent runs. What stands in the way
  is a gate that calls itself "a speed bump and not a boundary" for shell commands (`runtime/selfControlGate.ts`) and a
  peer check that trusts the client's claimed pid on Linux, cannot run on Windows, and is escaped by a double fork on
  macOS (`host/peerCheck.ts`); Node has no kernel peer credentials. The safe version needs trust tiers: a terminal
  that joins may steer only the runs it started, and changing settings or steering another terminal's run needs a
  "yes" in a terminal that is already trusted.
- **Whose environment.** A run's agents inherit the environment of the process that hosts them: the terminal's
  `PATH`, an activated virtualenv, `direnv` variables, API keys. With one host, each terminal's environment has to be
  carried into every place the host reads its own: the eight channels that start a run, the connection service's key
  lookups and probes, finding the `claude` and `codex` executables, and the one-shot calls that spawn them.

One process per terminal has neither problem, and what it needed instead (the list in "Sharing a project") is local,
of one shape, and testable with two real processes. What it cannot give is answering a run from another terminal;
that is the feature the trust tiers above would be for.

