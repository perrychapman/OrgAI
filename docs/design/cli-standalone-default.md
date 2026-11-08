# `orgai` as its own app: design spec

Status: draft 3, 2026-11-07. Draft 1 was reviewed by GPT Astra (12 findings, REVISE); draft 2 narrowed the first step
to what holds up under that review and lists the rest as later phases with their blockers; draft 3 folds in the
phase 1 code review (5 findings). Phase 1 (section 4) is
implemented on `feat/cli-standalone-default`. Builds on `docs/design/cli-standalone.md` (Wave 7: npm CLI, Node host,
vault) and `docs/design/cli-approvals.md` (draft: who may answer decisions from a terminal). Owner decisions are
**S1..S6**.

Every fact says how it was checked: "code" = read from the repo at 7a192382, "measured" = observed on the owner's Mac
on 2026-11-07, "unverified" = from memory, docs or typings, not checked here.

---

## 1. Problem

The owner's expectation: `orgai` is a separate app, the way Claude Code and Claude Desktop are separate apps. You open
a terminal, type `orgai`, and it works: it reads the folders that terminal can read, it asks you to approve what its
agents want to do, and nothing else needs to be installed, running or configured.

What happened before this change on a machine with the desktop app or a dev checkout:

1. `orgai` (`--host auto`, the default) found no live host, `HostLauncher.locate()` found the app, and `ensureHost`
   spawned **the Electron app headless** (`ensureHost.ts` step 4, code). The CLI was a client of a hidden app.
2. That hidden app grants terminals `read` + `operate` only (`terminalAccessLevel` default `'operate'`,
   `socketServer.ts` `grantScopes`, code). The TUI said "Approvals and questions are answered in the desktop app...",
   but no window existed, so a card waited with nowhere to answer it.
3. The hidden app outlived the terminal and kept its own build. Measured: pid 90328 `Electron
   /Users/ryanwillen/orca/OrgAI --headless-host`, started 2026-11-06 23:00 from `out/main/index.js` built 2026-11-05
   15:45, before fe3cf50f bumped the version; that build contains the literal `0.1.6-dev1` (measured). The CLI, rebuilt
   2026-11-07, is 0.1.7-dev1, so every connection showed the version-skew warning (`socketServer.ts:839`, code).
4. "OrgAI cannot read /Users/ryanwillen/Documents/Betting/desk. Check its permissions." (`scratch.ts`, code: any errno
   from `accessSync` / `readdirSync`). The folder is `drwxr-xr-x` and a plain `node` started from a terminal lists it
   (measured). Likely macOS privacy protection (TCC) on `~/Documents` denying the background Electron process; the TCC
   log had no entry (cause unverified). The message hid the errno.

`--host inproc` already behaved as the owner expects: the CLI runs the host in its own Node process, proves itself with
`ownerProof` and gets every scope (`inprocHost.ts`, `socketServer.ts` ownerKey, code), uses its own build, and runs
with the terminal's privacy grants (unverified for TCC; it is the terminal's own process).

## 2. Goals and non-goals

Goals:

- G1. `orgai` never starts the desktop app, visible or hidden, unless asked (`--host daemon`, `orgai daemon start`,
  `orgai app`).
- G2. With no other host running, the terminal the user typed `orgai` in answers every approval and question its runs
  raise, on macOS, Windows and Linux.
- G3. On that path the host is the CLI's own build and process: no version skew, the terminal's folder access.
- G4. A second `orgai` in another terminal works instead of waiting and failing.
- G5. Every line the TUI prints about approvals names a place that exists for the host it is talking to.

Non-goals for phase 1 (later phases, section 5):

- Runs that keep going after the terminal that hosts them closes (needs a background host with a secure owner,
  Astra findings 3, 6, 8).
- Answering approvals from a second terminal (needs owner-authorised pairing or E3, Astra finding 2).
- Being independent of an already running desktop app or background host (Astra finding 1, S1).
- Changing `--host daemon` / `orgai daemon start` to the Node host by default (Astra findings 10, 11).

## 3. Host ladder

`ensureHost(ctx, scopes)` with `--host auto` (code after this change):

0. Another command's own in-process host (not this context's, no shared marker) is waited out up to 15 s, then exit 6
   (unchanged).
1. A live host answers: connect (unchanged). This includes a desktop app, a hidden app an older `orgai` started, a
   `daemon start` host, and another terminal's shared TUI host.
2. A host is starting: wait up to 15 s (unchanged).
3. **No live host: run in-process.** One stderr line in text mode (`INPROC_FALLBACK_NOTE`, or `INPROC_SECRETS_NOTE`
   when environment secrets are set). `HostLauncher.locate()` is not called: an installed, dev-checkout or broken app
   changes nothing. The terminal UI's in-process host is started with `shared: true` (`markSharedHost`, code), so
   step 0 in other terminals attaches to it; a command's (`exec`, management) host stays its own.

`--host daemon` and `orgai daemon start` are unchanged: the app when found, else the Node host.

## 4. Phase 1 (implemented)

### 4.1 Default host

`src/cli/client/ensureHost.ts`: step 3 above replaces the old steps 3-4 for `auto`. Old steps 3-4 remain for
`--host daemon` only.

Why in-process and not a background Node host with an owner key (draft 1's recommendation): the review showed that
a background owner key breaks at the first owner loss. A short management command can start the host and exit with
the key (finding 3); the TUI and exec open second connections for `configure` (`session.ts` `withConfigure`,
`exec.ts`, finding 4) that a first-connection-only key refuses; Terminal access stored off would leave a surviving
host nobody can reach (finding 8, `daemon.ts` `runNodeHost` also refuses it). An in-process host has none of these:
its owner is the process itself, and every connection that process opens carries the same proof (code).

### 4.2 Second terminal

The first workspace `orgai` TUI's host is shared. Command-scoped TUIs (assistants started by `orgai` subcommands with
`exitWhenEnded` / `stopOnQuit`, `commands/interactive.ts`) keep their host to themselves (`launchTui(..., { shareHost:
false })`), because they exit on their own when their run ends and would end other terminals' runs without asking
(review 2 finding 1). A second `orgai` (TUI, exec or management command) attaches with what Terminal
access allows (`'operate'` by default: watch and start runs, no `decide`), exactly as it would attach to the desktop
app (code: shared hosts follow the stored level). It no longer waits 15 s and exits 6.

Quitting the owning TUI ends the host and every run on it, as today. The quit confirm ("Quitting stops N live runs in
this in-process host. Quit?", `App.tsx` `requestQuit`, code) used to count only the runs the TUI lists (its project);
it now also asks the host (`inproc.status().handoff`: working, waiting, held and paused runs) and says how many come
from other projects or terminals. Every quit path goes through that check, including Ctrl+C, Ctrl+D, Esc and q on the
onboarding screen (review 2 finding 2), which reserves rows for the confirm box. Ended runs are marked "Ended when OrgAI closed" and can be continued (code). The
second terminal sees the connection drop.

Security: unchanged. A shared marker only decides whether other CLI processes attach or wait; scopes for them come
from Terminal access as for any host (code). The owner proof stays in the owning process's memory.

### 4.3 Approval notices

`src/cli/tui/decisionNotices.ts` picks the no-`decide` line from `hello.hostKind` (code):

| hostKind | Line |
|---|---|
| desktop (or missing: older host) | "Approvals and questions are answered in the desktop app. To answer here: App settings > Terminal access > ..." (unchanged) |
| headless-host | "A hidden OrgAI app is running the host, so approvals are answered in its window (`orgai app` shows it). To run orgai on its own: `orgai daemon stop`, then start orgai again." |
| inproc | "OrgAI's host is running in another terminal (an orgai session, or `orgai daemon start --host inproc`), so this terminal can't answer approvals. Quit that orgai (or `orgai daemon stop`), then start orgai here to answer them." (A foreground `daemon start --host inproc` owner has no approval UI, so the line does not promise one; review 2 finding 4.) |
| node | "The background host (`orgai daemon start`) doesn't let terminals answer approvals. `orgai daemon stop`, then start orgai so it runs its own host; or, while no host runs, `orgai terminal-access on --level full`." |

`hostKind` is a capability, not window presence (finding 5: a headless launch keeps `'headless-host'` after its window
is opened, `src/main/index.ts`). The headless line therefore says how to show the window rather than claiming none
exists. The onboarding screen uses the same line; its "Edits" suffix says "(approvals in desktop)" only for the desktop
line, else "(approvals answered elsewhere)".

### 4.4 Secrets saved only by the app

An existing desktop user whose last secret change was made by the app may have secrets that the vault does not hold
yet; Node and in-process hosts read those as unreadable with `VAULT_MESSAGES.pendingLegacy` (`secrets.ts` resolve,
code), and `orgai doctor` already counts them (`secretsChecks.ts` `vault-pending`, code). Before, `--host auto` hid
this by starting the app. The message now says the order that works with an in-process owner, since the app waits
for that owner to exit (review 2 finding 3): "Saved by the OrgAI app and not yet shared with the orgai command: quit
orgai, open the OrgAI app once, then start orgai again". Proactive detection at TUI start is a follow-up.

### 4.5 Folder access errors

`scratch.ts` `unreadableFolderMessage(text, err)` (code):

- macOS `EPERM`: "macOS blocked OrgAI from reading <folder>. Allow it in System Settings > Privacy & Security > Files
  and Folders (or Full Disk Access) for the program running OrgAI's host (<process.execPath>): for orgai in a
  terminal, that terminal app."
- `EACCES`: "You do not have permission to read <folder>. Check the folder's permissions."
- anything else: the old text with the code in brackets.

### 4.6 Tests and checks changed

- `ensureHost.test.ts`: auto never calls `locate()` or spawns (found and broken), TUI host shared, command host not;
  the old app-spawn, never-ready, broken and lost-race cases now run under `--host daemon`.
- `manage.test.ts`: the "Started the OrgAI host in the background" note under `--host daemon`.
- `scratch.test.ts`: the three message forms. `decisionNotices.test.ts`: the line per host kind.
- `App.test.tsx`: the quit confirm counts runs the host reports beyond the TUI's own list, also from onboarding
  (Ctrl+C, Ctrl+D, Esc). `ensureHost.test.ts`: a command-scoped TUI's host is not shared.
- The app's Terminal access dialog (`CliShimRow.tsx`) no longer says orgai works only with Terminal access on.
- `scripts/verify-pack.mjs` (f) and (g): the packaged-app checks pass `--host daemon` explicitly, since `--host auto`
  no longer starts the app (finding 12). `(e)` keeps covering in-process.
- e2e: the `cli-*.mjs` scripts pass `--host inproc` or `--host daemon` explicitly or use `daemon start` (code), so no
  selector changes. `cli-tui.mjs` attaches second TUIs with `--host daemon` to a shared `daemon start --host inproc`
  host (unchanged).

### 4.7 For the owner's machine now

The hidden app (pid 90328) still answers step 1, so `orgai` keeps attaching to it until it is stopped once:
`orgai daemon stop` (it refuses while runs are working; `--force` ends them as continuable). After that, `orgai` hosts
itself.

## 5. Later phases (not built)

Each has blockers from the review that must be solved first.

### 5.1 Runs that outlive the terminal (S2)

A background Node host started by `orgai` with an owner key (cli-approvals E1). Before it can be the default:

- Owner loss and transfer on every platform: a management command or a closed TUI must not leave a host nobody can
  approve on (finding 3). Candidate: the host asks a surviving owner-attested terminal, or keeps `auto` in-process and
  makes the background host an explicit `orgai --detach`.
- Owner scopes across a process's several connections (`withConfigure`, exec's configure connection; finding 4):
  bind the key to the process (peer pid on macOS / Linux), not to the first socket, or elevate scopes on the primary
  connection.
- Replacement and idle exit must use the handoff predicate (any live, held or resumable run or open card blocks;
  `shutdown.ts` `stop` with `handoff`), not "no run is working" (finding 6). A TUI client counts as activity
  (`attachedClientCount`, `activity.ts`), so an attached TUI never lets a host go idle (finding 7).
- Terminal access stored off: `nodeHostRefusal` and `runNodeHost` both refuse (finding 8).
- Windows: fd-3 key passing to a detached child, and the Node host integration tests are POSIX-only today
  (`nodeHost.int`, `daemonNodeHost.int`, finding 12).
- macOS TCC for a detached Node child of a terminal (unverified): measure before choosing.

### 5.2 Approvals from a second terminal (S3)

Recommended: owner-authorised pairing. The second TUI asks; the owning TUI shows "Terminal <tty>, pid N wants to
answer approvals. Allow? [y/N]" (cli-approvals E2 with the owner terminal in place of the desktop window). Works on
Windows. E3 (attested tty) stays opt-in (finding 2: reparenting, descendant PTYs, claimed pids on Linux, mapping
failures; `peerCheck.ts`).

### 5.3 Independence from a running desktop app (S1)

Today step 1 attaches to any live host, including the desktop app, which then decides scopes, version and folder
access (finding 1). Options:

- (a) Keep one shared data folder; when the desktop app is running the CLI is its client and pairs for approvals
  (E2). Projects, connections and secrets are set up once.
- (b) The CLI gets its own data folder by default (`ORGAI_DATA_DIR` exists, code), like Claude Code and Claude
  Desktop keep separate state, with a one-time "use the desktop app's projects?" choice and explicit import.
- (c) The desktop app becomes a client of a CLI-owned host. Largest change.

No recommendation until the owner says whether shared projects and runs between the two matter.

### 5.4 Background defaults and stale hosts (S4, S5)

- `--host daemon` / `daemon start` default runtime `node`: needs a secret-readiness check before an Electron host's
  data folder is served by Node (a legacy value newer than the vault is unreadable outside the app,
  `secrets.ts`; finding 11), flag scope for `--runtime` (a daemon-command flag today, `flags.ts`; `daemon restart`
  keeps the current runtime; finding 10), and an explicit refusal, not an in-process fallback, for the app-bundled
  CLI.
- Replacing a stale or hidden host automatically: needs window presence in `host.status` (finding 5), a
  non-interactive preflight connection with `configure` (finding 7), the handoff predicate (finding 6), and a build
  identity in hello, since equal versions can be different builds (`version.ts` reads package.json only; finding 9).

## 6. Owner decisions

- **S1** Shared data folder with the desktop app, or the CLI's own by default (5.3).
- **S2** Build background runs (5.1), and as default or as an explicit `--detach`.
- **S3** Second-terminal approvals by owner pairing (recommended) or E3 opt-in (5.2).
- **S4** `daemon start` default runtime `node` (5.4).
- **S5** Automatic replacement of stale or hidden hosts (5.4). Until then the TUI prints the exact command (4.3).
- **S6** None of the above blocks phase 1.

## 7. Unverified

- That the owner's "cannot read" error was TCC (no TCC log entry; EPERM vs EACCES was not captured before 4.4).
- That an in-process host under Terminal / iTerm / Orca's terminal reads `~/Documents` without a prompt (it is the
  terminal's own process; expected, not measured).
- Real two-terminal behaviour with a shared TUI host (unit-tested through the shared marker; no e2e drives two TUIs
  where the first is an `auto` host).
