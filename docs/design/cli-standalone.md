# Standalone `orgai` (cli-spec Wave 7): design spec

> **Superseded in part (2026-11-08, `docs/design/cli-standalone-default.md`):** the desktop app and the `orgai` CLI share
> nothing. The app has no socket, no `--headless-host` mode, no handoff and no Terminal access setting; the packaged app
> does not contain the CLI; `orgai` runs in-process on its own data folder (`orgai-cli`). Read the sections below for the
> CLI's command surface and the shared host code only; anything about the app serving terminals, a background host,
> the handoff, `HostKind 'headless-host'` or Terminal access is history.

Status: implemented on wave7/standalone-cli (not merged), 2026-11-06. Written as draft 7, 2026-11-05, revised after
review rounds 1-5; round 6 was folded in as binding implementation rules (13) (GPT Astra, Gemini Argon; resolutions in
section 13). Builds on `docs/design/cli-spec.md` (Waves 0-6, landed on dev; Wave 7 entry in its "Implementation
status"). Owner decisions are marked **D1..D10**; D1 and D10 are decided (below), the rest keep their recommended default.

Every fact says how it was checked: "code" = read from the repo at 15766cc, "measured" = observed on this Mac,
"unverified" = from memory, docs or typings, not checked here.

---

## 1. Summary

Today `orgai` runs without the app's window but not without the app's install: it ships only inside the app bundle,
and secrets the app saved cannot be read by a pure-Node host. This spec makes `orgai` a second, independently
installable artifact:

1. **Distribution**: an npm package (`npm i -g orgai`) with a shrinkwrapped dependency tree; a portable archive later.
2. **Secrets**: a shared vault (`<data>/vault.json`, AES-256-GCM under one data key per data folder) whose key is held
   by the OS credential store and reachable from plain Node. The app writes it too and reconciles its existing
   `secrets.json` into it, so the CLI sees what the app saved, and an older app keeps working on the same folder.
3. **Hosts without the app**: `--host auto` falls back to an in-process host when no app is installed, for every
   command that needs a host; `orgai daemon start` can start a detached pure-Node host (`HostKind 'node'`); the app
   takes over from a Node host only after that process has exited.
4. **The RunAsNode fuse**: once the npm CLI ships, the app-bundled CLI is retired behind a stub and the fuses are set.

Size: about one wave for 1-3 (the vault, its reconciliation and the custodians are most of it) plus the release job.
Phase 4 is a smaller follow-up.

### Goals

- G1. `npm i -g orgai && orgai exec "..."` works on a machine that never had the app, on macOS, Windows and Linux,
  with Claude (subscription login or API key), Codex and LiteLLM connections.
- G2. With the app installed, the npm CLI and the app share one data folder (projects, runs, secrets) and never write
  it at the same time (cli-spec 3.2's one-owner rule).
- G3. Secrets written by any host are encrypted at rest under a key the OS protects for the user; plain-text key
  storage only by explicit opt-in.
- G4. An app one release older than this wave keeps working on a folder this wave has touched, and changes it makes
  there are picked up correctly after the upgrade.
- G5. A path to `electronFuses.runAsNode: false`.

### Non-goals

- A single self-contained executable. The agent runtimes dwarf Node: 263 MB for the Claude SDK's native package, 347
  MB for Codex's (measured, darwin-arm64), against roughly 100 MB for Node (unverified). See 3.3.
- Reading Electron safeStorage ciphertext from plain Node (5.9).
- Isolating secrets from agents running as the same user (5.8).
- Remote hosts, Homebrew, winget, apt.

---

## 2. Current state

- Host code is Electron-free: `bootOrgAIHost` (`src/main/host/bootstrap.ts`) takes a `SecretCipher` (`safeStorage` in
  the app, `NO_CIPHER` in `src/cli/inprocHost.ts`); `noElectronImport.test.ts` (host and CLI) fails if Electron
  creeps back. (code)
- `SecretStore` (`src/main/store/secrets.ts`): `<data>/secrets.json` = `{ version: 1, secrets: { key: base64 } }`,
  loaded once; a parse error loads as empty (line ~115); every change mutates the in-memory map first, then rewrites
  the whole file (writeFileSync tmp + rename, no fsync); non-string values are dropped on load; `has()` is true for a
  stored entry even when `get()` cannot decrypt it. An older app therefore drops unknown shapes on its next write.
  (code)
- `--host inproc`: read-only `SecretStore` plus an overlay from `ORGAI_SECRET_LITELLM_API_KEY` / `--secret-env`
  (`src/cli/secretOverlay.ts`). `prepareContext` refuses these with any `--host` other than `inproc`, including the
  default `auto` (`secretEnvRefusal`). (code)
- `HostKind = 'desktop' | 'headless-host' | 'inproc'` (types.ts), validated by `HOST_KINDS` in `ownership.ts`
  `parseDaemonInfo`; `HostMode` (`--host`) is `auto | daemon | inproc` (`flags.ts`). `registry.ts` `gateRequest`
  refuses `desktopRequired` channels only when `hostKind === 'inproc'`. (code)
- Hello: `socketServer.ts` refuses every hello with `terminal_server_disabled` while `AppSettings.terminalServer` is
  not true, and, across differing app versions on one protocol, refuses every `configure` call except `host.stop`.
  Interactive (TUI) clients are an activity source. (code)
- Forced drain: `activity.ts` `settleWriters` releases ownership after `forceSettleMs` even with writers in flight
  (logged). `inprocHost.ts` cleanup resolves `closed` without ending the process. (code)
- `--host auto` (`ensureHost.ts`; used by `exec`, the TUI and, through `manage.ts` `withHost`, every management
  command) connects, else spawns the app found by `HostLauncher`, else fails. `HostLauncher` looks at
  `ORGAI_ELECTRON_PATH`, then the packaged layout around the bundle, then a dev checkout found by `devAppRoot`, which
  accepts any directory two levels up whose package.json `name` is `orgai`; it never looks in `/Applications` or
  Program Files. (code)
- CLI bundle: ESM `out/cli/orgai.mjs` + chunks, `#!/usr/bin/env node`, externals `CLI_RUNTIME_PACKAGES` =
  claude-agent-sdk, codex, zod (`src/cli/packaging.ts`). package.json: `private`, `bin`, `engines.node >=22`,
  `@openai/codex` 0.166.0, `@anthropic-ai/claude-agent-sdk` 0.3.312. The SDK declares peers `@anthropic-ai/sdk
  >=0.93.0`, `@modelcontextprotocol/sdk ^1.29.0`, `zod ^4.0.0`. (code)
- Claude binary: `claude.ts` computes `packagedClaudeExecutable()` once at import, only inside app.asar; the
  connection probe uses `anthropicAuth.ts` `bundledClaudeBinary()` and its own candidates. Codex: `resolveCodexBinary`
  (`ORGAI_CODEX_PATH`, else the per-platform package's `vendor/<triple>/bin/codex[.exe]` plus `codex-path` for `rg`),
  spawned without a shell. (code)
- `childEnv.ts` `ORGAI_CONTROL_ENV_PATTERNS` strips `ORGAI_DATA_DIR`, `ORGAI_DAEMON_*`, `ORGAI_SECRET_*`,
  `ELECTRON_RUN_AS_NODE` from agent and MCP children. (code)
- `systemCerts.ts`: macOS store read in `process.execPath -e` with `ELECTRON_RUN_AS_NODE=1` and `childEnvFor` (HOME,
  PATH, USER, LOGNAME, TMPDIR, SystemRoot, windir, USERPROFILE, APPDATA, LOCALAPPDATA; exact-case keys); its header
  says the tls APIs need "Node 24.5+". `index.ts` exits at once when `ELECTRON_RUN_AS_NODE` is set. (code)
- `daemon logs` guesses `~/Library/Logs/OrgAI/main.log` on macOS (the app's log dir), while inproc writes
  `<userData>/logs/main.log`. (code)
- `release.yml`: `permissions: contents: read`, a 3-OS build matrix. Windows target NSIS with `oneClick: false`.
  (code)

---

## 3. Distribution

### 3.1 npm package (phase A)

- **Name** (**D1**, decided by the owner 2026-11-06): `orgai-cli`. npm refused `orgai` (too similar to `org.ai`). The bin stays `orgai`, so `npm i -g orgai-cli` installs the `orgai` command. A placeholder `orgai-cli@0.0.1` is already published. Every `orgai` / `@orgai/cli` package name below reads `orgai-cli`; the self-control gate (8.4) keeps denying `orgai` and `@orgai/cli` too.
- **Builder** `scripts/build-npm-package.mjs` writes `release/npm/package/` and `npm pack`s it:
  - `out/cli/**` exactly as `vite.cli.config.ts` emits it, plus `out/cli/install.json` (3.5).
  - Generated `package.json`: `name`, `version` (the app's, same commit), `type: module`, `bin`, `engines.node` (7.1),
    `files`, `license`, `repository`, and `dependencies` pinned exactly to the lockfile versions of
    `@anthropic-ai/claude-agent-sdk`, its peers `@anthropic-ai/sdk` and `@modelcontextprotocol/sdk`, and `zod`. No
    lifecycle scripts in our package.
  - `npm-shrinkwrap.json` generated from the repo lockfile restricted to that dependency closure (npm honours a
    published shrinkwrap; unverified for current npm, checked by `verify-npm.mjs` comparing `npm ls --all --json`
    after install with the shrinkwrap's entries for the runner's platform). This pins the transitive tree we tested, not just the top level.
  - A test asserts the dependency list is `CLI_RUNTIME_PACKAGES` minus Codex (6.2) plus the SDK's declared peers, so a
    new external import or a new peer cannot ship unresolved.
  - `README.md`, `LICENSE`.
- **Install scripts in the tree**: `verify-npm.mjs` lists every installed package with `preinstall`, `install` or
  `postinstall` (`npm query ':attr(scripts, [postinstall])'` and friends, unverified syntax) and fails on any not in
  an allowlist file reviewed with each release. The README documents `--ignore-scripts` as supported if the allowlist
  is empty.
- `npx orgai` works (and is covered by the self-control gate, 8.4).

### 3.2 Portable archive (phase C, only on demand, **D5**)

`orgai-<version>-<platform>-<arch>.tar.gz` / `.zip`: a pinned official Node (checksum verified at build), `out/cli`,
the pruned shrinkwrapped `node_modules`, and `bin/orgai` / `bin/orgai.cmd` launchers. Signing and notarization of the
re-shipped `node` are unverified and part of D5.

### 3.3 Why not a Node SEA

The bundle is ESM with dynamic-import chunks; the agent runtimes are native executables that ship beside it anyway;
and `systemCerts.ts` re-executes `process.execPath -e`, which an SEA binary would not honour. The archive gives the
same outcome without those costs.

### 3.4 Release pipeline

- `release.yml` gains a `verify-npm` job (below) and a single `publish-npm` job: `needs: [meta, build, verify-npm]`,
  `if: needs.meta.outputs.publish == 'true'` (the existing guard: dry runs and commits not on `main` never publish),
  `runs-on: ubuntu-latest`, `permissions: { contents: read, id-token: write }`. It publishes the exact tarball
  `verify-npm` tested (uploaded as an artifact by the job that built it, sha256 compared before `npm publish
  <file>`), never a rebuild, and never inside the build matrix. A version with a prerelease tag publishes with `--tag
  next`; `latest` only for plain versions. npm trusted publishing with `--provenance` (**D2**; fallback a granular
  automation token for the one package). The desktop release stays a draft published by hand (code); npm publishing
  is not reversible after 72 hours, so the owner decides (**D2**) whether `publish-npm` also waits for a manual
  approval (a GitHub environment with a required reviewer; recommended).
- `verify-npm` job (macos-15, windows-latest, ubuntu-latest; Node at the `engines` floor and current 24 LTS), from the
  same tarball, in a temp folder outside the checkout with a temp npm prefix and a temp data folder:
  1. `npm i -g <tgz>` (with and without `--ignore-scripts` when the allowlist is empty); the installed tree equals the
     shrinkwrap's entries whose `os` / `cpu` match the runner (other platforms' optional native packages are absent by
     design), and this platform's Claude native package is present.
  2. `orgai --version` prints the version and `channel npm`.
  3. `orgai doctor --json`: install channel npm, no app, Claude runtime resolved, vault custodian state reported.
  4. Claude runtime starts without inference: the resolved executable answers `--version` (token-free).
  5. `ORGAI_MOCK=1 orgai --host auto exec` on a temp project fixture with a prompt (as `verify-pack.mjs` builds one),
     proving the auto -> inproc fallback with no app.
  6. Vault across processes, proving decryption without printing a value: `orgai secrets init --key-file <tmp>` (the
     only custodian guaranteed on a runner), a LiteLLM connection pointed at a local fake proxy on 127.0.0.1 that
     answers `/v1/models` only when the bearer equals a synthetic key, `connections set-secret litellm` from stdin in
     one process, then `connections test litellm` in a fresh process must report connected; a different valid key
     file must report the vault `key-mismatch`; then delete and test again (disconnected).
  7. Codex (when installed separately on the runner from the pinned version): resolution through PATH and an
     app-server `initialize` handshake (token-free per the Codex schema; unverified until run).
- Packaged integration (the `pack:verify` job on macOS, later Windows): install the verified npm tarball into a temp
  prefix beside the freshly packed app, point discovery at it (`ORGAI_ELECTRON_PATH` for the unpacked pack), and run
  `ORGAI_MOCK=1 orgai --host daemon exec` (was `--host auto`; see cli-standalone-default.md) on a fixture: the npm CLI must find the packaged app, start it headless, run
  the mock to completion and stop it with `orgai daemon stop`. This stays after the fuse change (9), where it is the
  only check of npm CLI -> packaged app.
- Lockstep: same tag, same version, same commit as the app. `-devN` versions publish to `next` only when the owner
  asks.
- `ci.yml` runs build-npm-package and verify-npm (steps 1-6, mock only) on every PR on macOS, Windows and Linux.

### 3.5 Install channel

`out/cli/install.json` = `{ "channel": "npm" | "app" | "archive", "version", "commit" }`, written by each builder;
absent = `dev`. `--version` and `doctor` print it. `HostLauncher` uses it (4.1).

---

## 4. Hosts without the app

### 4.1 `--host auto` and `--host daemon`

> Superseded for `--host auto` by `docs/design/cli-standalone-default.md` (2026-11-07): with no live host, `auto`
> always runs in-process and never starts the app (step 3 below no longer applies to `auto`; it still describes
> `--host daemon`). The packaged-integration checks pass `--host daemon` explicitly.

`--host auto`:

1. A live host answers on the data folder: connect (unchanged).
2. A host is starting: wait (unchanged; the wait grows to 15 s, 5.6).
3. `HostLauncher.resolve()`:
   - `ORGAI_ELECTRON_PATH` (unchanged).
   - The packaged layout around the bundle, only when `install.json` says `app`.
   - A dev checkout only when `install.json` is absent **and** the candidate root has `electron.vite.config.ts` and
     `electron` in its devDependencies; an npm install's own package folder is never a checkout.
   - **Installed app discovery** (new): macOS `/Applications/OrgAI.app`, then `~/Applications/OrgAI.app`; Windows the
     NSIS per-user `%LOCALAPPDATA%\Programs\OrgAI\OrgAI.exe` and per-machine `%ProgramFiles%\OrgAI\OrgAI.exe` (default
     paths unverified for `oneClick: false`); Linux none (an AppImage has no fixed place).
   - The result is `found`, `absent` or `broken` (found but its binary or `app.asar` is missing). `broken` is an error
     naming the path; only `absent` goes on to step 4.
   - Found: spawn it headless and wait (unchanged).
4. **`absent`: start an in-process host**, for every `ensureHost` caller (exec, resume, TUI, bare prompt and every
   `withHost` management command), with one stderr line in text mode ("No OrgAI app or background host found;
   running the host inside this command. `orgai daemon start` keeps one running."). Management commands keep system
   certificates and connection status probes on and turn off only model discovery, community prices and the usage
   monitor (`startBackground` splits into those three flags; `systemCertificates` defaults to true and no longer
   follows `startBackground`).
5. Read-only commands keep the hostless reader (unchanged).

`--host daemon` never runs a host in-process (cli-spec 3.2(3)): with no live host it starts a background host, the app
when step 3 finds one, else a Node host (4.2), and waits for either kind (`ensureHost`'s `ELECTRON_HOST_KINDS` becomes
`BACKGROUND_HOST_KINDS = ['headless-host', 'desktop', 'node']`).

Environment secrets (`ORGAI_SECRET_*`, `--secret-env`):

- `--host daemon`: refused in `prepareContext`, exit 2 (unchanged).
- `--host inproc`: collected, scrubbed, used (unchanged).
- `--host auto`: always collected and scrubbed in `prepareContext`.
  - With no live host the command starts its own in-process host and the secrets go into its overlay; when env
    secrets are present, `auto` skips step 3 (spawning the app) so they are actually used.
  - An explicit `--secret-env` is refused (cli-spec 3.5 text, exit 2) by every command that will not run its own
    in-process host: any command attaching to a live host, `daemon start` / `restart` (the background host never gets
    them), and the hostless commands (`status`, `runs list|show`, `projects list|show`, `doctor`, `daemon`, `logs`,
    `completions`, `app`, `--version`).
  - An ambient `ORGAI_SECRET_*` (no `--secret-env` on the command line) attached to a live host is refused only by
    the commands that would use a secret there: those that start or continue a run (`exec`, `resume`, the TUI and a
    bare prompt, `init` with the Architect, `mcp assist`, `skills assist`, `org retro`) or probe a credential
    (`connections test|connect`, `models refresh`, `mcp test`, `mcp library test`); every other command (`decide`,
    `runs stop|send|interrupt`, `status`, `projects`, ...) prints one stderr warning ("ORGAI_SECRET_* ignored: a
    running OrgAI host keeps its own secrets") and goes on, and so does `daemon start`. Only those secret-using commands
    skip step 3 when no host is live; others spawn the app as usual. Today every command under `auto` is refused, so an
    exported variable no longer blocks unrelated commands.

An npm CLI on a machine with the app still prefers the app as host (step 3).

### 4.2 Detached Node host (`HostKind 'node'`)

- `orgai daemon start [--runtime app|node]`; default `app` when step 3 finds an app, else `node`. `--host` keeps its
  three modes. When a background host is already running and `--runtime` was given explicitly with the other kind,
  `daemon start` exits 1 with "A <kind> host is already running; use `orgai daemon restart --runtime <kind>`".
- `--runtime node` needs a real Node: it is refused (exit 1, "The Node background host comes with the npm package:
  npm i -g orgai") when `install.json` says `app`, because there `process.execPath` is the Electron binary and the
  bundled CLI strips `ELECTRON_RUN_AS_NODE` at startup (`src/cli/index.ts`).
- It spawns `process.execPath <orgai.mjs> daemon run-node` detached (`setsid` on POSIX; `detached`, `windowsHide` on
  Windows), stdio to `<userData>/logs/node-host.log`, and waits for `daemon.json` `ready`. `daemon run-node` is hidden
  from help and completions.
- It is the inproc host plus: `hostKind 'node'`, the idle exit armed (`ORGAI_DAEMON_IDLE_MINUTES`, default 30),
  terminal access as a headless boot sets it (`bootstrap.ts` keeps the user's explicit choice), no TTY.
- Code: `HostKind` and `ownership.ts` `HOST_KINDS` gain `'node'`; `daemon start` / `restart` / `status` wait for and
  print it; `registry.ts` replaces `hostKind === 'inproc'` with a host capability `canOpenWindows` (false for `inproc`
  and `node`); `daemon logs` looks in `<userData>/logs/` (`main.log`, `node-host.log`) and, on macOS without a chosen
  data folder, also `~/Library/Logs/OrgAI/main.log`, newest first.

#### 4.2.1 Terminal access for CLI-owned hosts

Code today: a host's Terminal access is on for a headless session unless the user chose otherwise, and its level is
`full` only for `inproc` or when `AppSettings.terminalAccessLevel` is `full`; otherwise `operate` (read and operate,
never decide or configure). `terminalAccessLevel` cannot be changed over the socket (`stripSocketOwnedSettings`), only
in the app. Without the app a Node host would therefore never allow `orgai decide`, `init`, `connections set-secret`
and the rest. New:

- **inproc**: its owner's client (proven by `RpcHelloParams.ownerProof`, an in-memory key; merged from PR #18) is always
  accepted with every scope, whatever the stored choice. Any other client of that host (a shared `daemon start --host
  inproc` host serves other terminals) follows Terminal access and its level like any host. The stored choice keeps
  applying to background hosts.
- **node**: follows the stored `terminalServer` / `terminalAccessLevel` like the headless host. New in-process-only
  command `orgai terminal-access [on|off] [--level full|operate]` changes them on a machine without the app: it runs
  only when no host owns the data folder (it takes ownership in-process like `--host inproc`, writes the settings,
  releases) and refuses otherwise ("Stop the background host first: orgai daemon stop", or change it in the app).
  Agents cannot run it (the self-control gate denies the `orgai` command). `orgai daemon start --runtime node` (and
  `--host daemon` starting one) refuses when the stored choice is off ("Terminal access is off, so nothing could talk
  to that host; turn it on with `orgai terminal-access on`"), so a Node host never runs unreachable: neither `daemon
  stop` nor `terminal-access` could reach it. `orgai daemon start --runtime node` on an
  interactive terminal with no stored level choice asks once ("Let terminal sessions approve decisions and change
  configuration? [full/operate]") and stores the answer; without a TTY it uses the stored level and prints how to
  change it. Peer checks keep refusing the Node host's own descendants (agents, MCP servers) on macOS and Linux
  (`peerCheck.ts`); on Windows nothing tells an agent from the user, which is why the default stays `operate`
  (**D9**).

### 4.3 Ownership ends with the owner's writes (every host kind)

Today a forced drain may release ownership with writers still in flight (`activity.ts` `settleWriters`, then
`release()` inside `runDrain`, then `onDrained`), the desktop path (`HostDispatcher.invoke`) takes no activity lease and
ignores draining, and any contender can then take the folder. New rule, for desktop, headless, Node and inproc hosts:

- **Every mutation is leased**: `HostDispatcher.invoke` takes the same `inFlightRpcMutations` lease as `invokeRpc`
  for mutating channels (held until a returned promise settles; a synchronous handler stays synchronous and releases
  on return), and refuses new mutations while draining with `host_draining`. Background secret work (vault creation,
  reconciliation, write-back) holds a `backgroundTasks` lease.
- **One shutdown coordinator** for every exit path: `host.stop` (socket), desktop Quit (menu, Cmd+Q, the last window
  closing on Windows and Linux, `before-quit` through `quitGate`), the headless host's idle exit, the Node host's
  idle exit and signals, and the inproc host's cleanup. Today desktop Quit runs `quitGate` (3 s, `stopAll`) and
  `will-quit` closes the socket and releases at once, never settling writers (code). Under the coordinator,
  `before-quit` is held (`event.preventDefault()`) until the sequence below finished, and `will-quit` no longer
  releases. The non-forced drain settles writers too (today `settleWriters` runs only when forced, code).
- **Desktop-only mutating channels** registered directly on `ipcMain` (`kit:applyImport`,
  `skillLibrary:addFromFolder`, `app:setNotifications`, `projects:cloneRepo`, and any later one) take the same lease and
  draining refusal through one wrapper, with a test that every `ipcMain.handle` of a mutating channel uses it.
- **Release only when writers are done**: `runDrain` no longer calls `ownership.release()`; the shutdown sequence does, after `settleWriters` reports nothing in flight and after `closeGracefully`. While writers are in flight the
  host stays `draining` (mutations refused, `daemon.json` kept, so no contender can acquire: a live pid is never
  robbed, code). After a hard limit of 60 s the host kills its tracked child processes (git under the repo lock,
  custodian helpers, agent CLIs) and exits; the exit hooks release. An in-process write cut by that exit leaves the
  previous file, because every store writes temp + rename.
- **Order**: drain; the `host.stop` reply is queued; `HostSocketServer.closeGracefully(2_000)` resolves once every
  queued frame is written or the time is up (a client that stops reading cannot hold it); then release, then exit.
  `onDrained` runs from `setImmediate`, never inside `requestDrain`, so the reply is queued first.
- **Tests**, per owner kind and per exit path (desktop Quit through the real `before-quit` / `will-quit` handlers
  with an Electron test harness, desktop window close on Windows and Linux, `host.stop`, idle exit; headless, Node,
  inproc), each with a racing
  `--host inproc` CLI: (a) a real asynchronous desktop handler (MCP authorize with a delayed token write) started
  before the drain; (b) a writer that finishes after the old drain deadline but before the hard limit; (c) a writer
  that hangs past the hard limit, plus a git child. In (a) and (b) no contender owns the folder before the write
  finished; in (c) only after the children were killed and the process exited.

### 4.4 The app opening while another host owns the folder

Code changes this needs: `HostClientKind` gains `'desktop'` (types.ts; `socketServer.ts` `helloProblem` accepts it);
`hostClient.ts` `parseHelloResult` and `ownership.ts` `HOST_KINDS` accept `hostKind 'node'`; `index.ts` gains a
`waitingForHandoff` state in which `window-all-closed` does not quit and `second-instance` / `activate` focus or
reopen the waiting window (never `createWindow()` before `registerIpc`); `host.stop` gains `handoff: true`.

1. A `--headless-host` launch never shows a dialog: it logs and exits (the CLI that launched it then connects to the
   live owner or reports the busy folder).
2. An interactive launch takes the single-instance lock as now and connects to the owner with `clientKind 'desktop'`
   (5).
3. Owner `inproc` (someone's terminal): never stopped from the app. A small window ("OrgAI's data is in use by the
   orgai command in a terminal") offers **Open when it ends** (wait for that process to exit) and **Quit**.
4. Owner `node`: `host.stop({ force: false, handoff: true })`. The handoff predicate is stricter than idle-exit
   activity: it refuses while any run is live in any form (working, idle, waiting on a card, held, paused with a
   resume pending) or any card is open, besides the existing leases (`busyRunCount` alone does not count runs waiting
   on cards, code). `stopping: true` -> wait for the process to exit (4.3), with no window unless that takes more than
   1 s, so an idle Node host hands over without a flash. `stopping: false` -> the window lists `refusedBecause` and
   `host.status` (live, waiting and paused runs, open cards, attached terminal sessions) with **Open when they
   finish** (retry every 5 s), **Stop them and open** (`host.stop({ force: true })`: runs end through `stopAll({
   reason: 'quit' })`, read "Ended when OrgAI closed" and can be continued; attached terminal sessions are
   disconnected) and **Quit**.
5. **Handoff connection** (**D8**): a `desktop` hello with the `daemon.secret` proof always gets a `handoff` grant,
   whatever Terminal access is (off, `operate` or `full`) and across versions: `socketServer.ts` refuses every method
   on it before dispatch except `host.status` and `host.stop` (forced included; the user confirms the forced stop in
   the app's window). This does not authenticate the app: any same-user process holding `daemon.secret` can claim
   `clientKind 'desktop'` (on Linux the peer pid is client-asserted; on Windows there is no peer check; code). The
   existing descendant check still refuses the host's own descendants (agents, MCP servers) where it works (macOS real
   peer via `lsof`, Linux claimed pid), with a 2 s budget instead of 150 ms for desktop hellos; when it cannot answer the
   hello is allowed, as today. What such a process gains is stopping the Node host (forced stops end live runs as
   "Ended when OrgAI closed", continuable); it could already read every file the host writes. D8 accepts this.
6. The app takes ownership only after the previous owner's process has exited (pid plus start time from
   `processInfo.ts`), then `acquireHostOwnership` as usual; losing the race to another contender goes back to 2. No
   answer within 5 s, or an owner older than this wave (no handoff grant): the window shows the existing message and
   the `orgai daemon stop --force` hint.
7. `orgai app` with a `node` or `inproc` owner launches the app and returns 0 with "OrgAI opened; it takes over once
   the background host stops (see its window)" instead of waiting 10 s for a ready desktop host.

---

## 5. Secrets: a vault plain Node can read

### 5.1 Requirements

- R1. One set of secrets (LiteLLM key, MCP env and header values, OAuth client secrets and tokens) for every host
  kind on a data folder.
- R2. Encrypted at rest under a key the OS protects for the user; a plain key file only by explicit opt-in.
- R3. Secret values and the data key never appear in argv, logs, RPC or IPC responses, broadcasts, or the environment
  of a child that does not consume them. Allowed channels: the existing authenticated secret-write requests to the
  owning host (`connections:setSecret`, `mcp:setSecret`, ...), custodian stdin / stdout pipes, and a consuming child's
  environment (an MCP server's own variables, as today).
- R4. G4: an older app keeps working, and a change it makes later wins over what this wave stored before it.
- R5. Only the owning host writes `vault.json` and `secrets.json`; within that host, one writer at a time.
- R6. `SecretStore.get` / `set` / `delete` stay synchronous for their callers; vault opening and creation are
  asynchronous steps that run before them (5.6).
- R7. After a crash or a failed write, the next open converges to the state just before or just after that write,
  never a mix, and a write that was acknowledged to a caller is never lost.

### 5.2 Format

`<data>/vault.json` (a new file; `secrets.json` is never given a new shape, because an older app rewrites it from its
own map):

```json
{
  "format": "orgai.vault/1",
  "vaultId": "<16 random bytes, hex>",
  "custody": { "scheme": "keychain" | "dpapi-user" | "secret-service" | "key-file", "wrapped": "<b64, dpapi only>", "keyFile": "<canonical path, key-file only>" },
  "check": { "iv": "...", "ct": "...", "tag": "..." },
  "entries": { "<key>": { "iv": "<12 B b64>", "ct": "<b64>", "tag": "<16 B b64>", "at": 1762300000000, "lc": true } },
  "tombstones": { "<key>": { "at": 1762300000000, "by": "vault" | "legacy", "prev": { "iv": "...", "ct": "...", "tag": "..." }, "prevLegacy": "<secrets.json value string>", "legacyHash": "<sha256 hex>" } },
  "legacy": { "<key>": "<sha256 hex of the secrets.json value string at the last reconcile>" },
  "legacyRetired": null | { "at": 1762300000000, "digest": "<sha256 hex of the retired secrets.json bytes>", "keys": { "<key>": "<sha256 hex of its value string>" } }
}
```

- AES-256-GCM (`node:crypto`), a fresh random 96-bit IV per write (one DEK per vault; a vault sees thousands of writes
  at most, far below the random-IV bound), AAD = `orgai.vault/1\0<vaultId>\0<key>`.
- `check`: the constant `orgai-vault-check` encrypted at creation with AAD `orgai.vault/1\0<vaultId>\0\0check`. Every
  open decrypts it first; a tag failure means the key does not match or the check record itself is damaged (state
  `key-mismatch`, 5.4; the two cannot be told apart), even for an empty vault. A tag failure on an entry after the
  check passed means that entry is damaged (`unreadable`).
- DEK: 32 random bytes, created once per vault (5.3). **Never** created while `vault.json` exists; a vault whose key
  cannot be opened stays unopened until `secrets reset` moves it aside (5.6).
- `lc` ("legacy current"): true when `secrets.json` holds the same value (imported from it, or written to both);
  false when only the vault holds the current value.
- `legacy` is the reconciliation baseline (5.5).
- `tombstones`: `by: 'vault'` is a delete made through this wave (`prev` kept 30 days for `secrets undelete`);
  `by: 'legacy'` is a disappearance seen in `secrets.json` (5.5), which keeps `prev` until the user confirms or
  restores it, never on a timer. `prevLegacy` keeps a `secrets.json` value a Node host deleted without being able to
  decrypt it; only the app can restore that one. A tombstone goes once its `prev` is gone and its key is absent from `secrets.json`
  (or the legacy file is retired).
- Keys are the existing `SecretStore` keys, so callers, prefix deletes and `has()` keep their meaning.
- Validation on load: exact iv and tag lengths, base64 shape, known `format` and `scheme`, `check` present. Anything
  else is `corrupt` (5.4).

### 5.3 Key custody (`KeyCustodian`)

```ts
type CustodyFailure = { kind: 'unavailable' | 'locked' | 'missing' | 'denied' | 'timeout'; reason: string }
interface KeyCustodian {
  readonly scheme: 'keychain' | 'dpapi-user' | 'secret-service' | 'key-file'
  probe(): Promise<{ ok: true } | ({ ok: false } & CustodyFailure)>   // can a key be created and read now?
  create(vaultId: string): Promise<{ dek: Buffer; wrapped?: string }> // refuses when an item for vaultId exists
  open(vaultId: string, custody: VaultCustody): Promise<Buffer>        // throws CustodyFailure
}
```

OS tools as child processes (**D3** is a native addon instead). Every helper: absolute executable path, `shell:
false`, `cwd: os.tmpdir()`, values only on stdin / stdout, a 10 s timeout, stderr reduced to a classified failure
(never logged raw), and a **per-custodian environment allowlist** (`custodianEnvFor(scheme, env)`, case-insensitive
key match on Windows so `Path` survives; never `NODE_OPTIONS`, never `ORGAI_*`):

| Scheme | Environment kept | Probe | Create | Open | Unverified |
| --- | --- | --- | --- | --- | --- |
| `keychain` (macOS) | HOME, USER, LOGNAME, TMPDIR, PATH | `security show-keychain-info` on the default keychain (exit 0 = unlocked; 36 / `errSecInteractionNotAllowed` or a lock message = `locked`) | `/usr/bin/security -i -q`, stdin `add-generic-password -s "OrgAI Vault" -a <vaultId> -w <b64 dek>` (quoted per `security -i` rules), no `-U` | `/usr/bin/security find-generic-password -s "OrgAI Vault" -a <vaultId> -w` (44 = `missing`; a user cancel at an unlock prompt, exit 128, and a timeout are `locked`, never `missing`) | `-i -q` reading a pipe without a TTY or echo; no prompt for items `security` created; exit codes; the locked message over SSH: "The macOS keychain is locked or cannot ask in this session. Run `security unlock-keychain`, or use ORGAI_VAULT_KEY_FILE." |
| `dpapi-user` (Windows) | SystemRoot, windir, Path, TEMP, TMP, USERPROFILE, APPDATA, LOCALAPPDATA, ComSpec, PSModulePath | one PowerShell call: `$ExecutionContext.SessionState.LanguageMode` is FullLanguage (else `denied`, naming Constrained Language Mode) and `Add-Type -AssemblyName System.Security` loads (else `denied`) | `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -NonInteractive -Command -`, script and DEK on stdin, `ProtectedData.Protect(dek, entropy, CurrentUser)`, entropy = UTF-8 `orgai.vault/1:<vaultId>`; blob in `custody.wrapped` | same with `Unprotect` (a CryptographicException = `missing`: another user or machine) | latency (estimate 0.3-3 s cold); AppLocker policies |
| `secret-service` (Linux) | HOME, USER, LOGNAME, PATH, DBUS_SESSION_BUS_ADDRESS, XDG_RUNTIME_DIR, DISPLAY, WAYLAND_DISPLAY | `secret-tool` resolved on PATH (else `unavailable`), a session bus address present (else `unavailable`), `secret-tool search service orgai-vault-probe` exits within 10 s (a timeout = `locked`) | after a `lookup` finds none: `secret-tool store --label="OrgAI vault" service orgai vault <vaultId>`, DEK on stdin | `secret-tool lookup service orgai vault <vaultId>` (empty = `missing`) | whether `search` on a locked collection prompts or fails; a desktop unlock prompt during create |
| `key-file` (opt-in) | n/a (no child) | the same validation as open | 5.3.1 | 5.3.1 | the Windows DACL steps |

Choice of scheme: a vault opens only with its recorded scheme. A new vault uses `key-file` when
`ORGAI_VAULT_KEY_FILE` is set or `secrets init --key-file` asked for it, else the platform's OS scheme.

#### 5.3.1 Key file

- Refused anywhere inside the user data folder (`<userData>`, which contains `<data>`), checked on the canonical and
  lexical paths, at init, open and every probe; `ORGAI_VAULT_KEY_FILE` pointing there is refused the same way.
- Content: exactly 32 bytes, or base64 text of 32 bytes with at most one trailing `\n` or `\r\n` (so `openssl rand
  -base64 32 > file` works).
- `orgai secrets init --key-file <path>` creates a new file only (`O_CREAT | O_EXCL | O_NOFOLLOW`); `--import` takes an
  existing file; nothing ever overwrites a key file.
  - POSIX: created with mode 0o600; open uses `O_NOFOLLOW` then `fstat`: regular file, owner = current uid, no group
    or other bits.
  - Windows: create an empty file exclusively, set a protected DACL granting only the current user's SID (from `whoami
    /user /fo csv`, never from environment variables) through `icacls <file> /inheritance:r /grant:r *<SID>:F /remove:g *S-1-5-18 *S-1-5-32-544` (an elevated process's new file carries SYSTEM and Administrators as its own entries; found on the windows-latest runner),
    verify with `icacls` output that no other principal remains, and only then write and flush the key; any failure
    deletes the empty file and fails closed. Open checks the same DACL (unverified: `icacls` output parsing across
    locales; a native check is the fallback under D3).
- `custody.keyFile` records the canonical path chosen at init, so later commands need no variable;
  `ORGAI_VAULT_KEY_FILE` overrides it (moved file, CI).
- The README and the init output say: a backup or sync holding both the key file and the data folder holds every
  secret.

### 5.4 Vault states

| State | Meaning | Reads | Writes |
| --- | --- | --- | --- |
| `absent` | no `vault.json` | app: `secrets.json`; Node, inproc: overlay, and every key in `secrets.json` as `pending-legacy` (unreadable, "saved by the OrgAI app"), so status, promote and copy see it | app: created at boot when the custodian allows, retried (5.6); Node, inproc: created by `prepareWrite` (5.6) |
| `open` | DEK in memory, `check` passed | vault, legacy per 5.5 | allowed |
| `locked` | custodian `locked`, `timeout` or `unavailable` | vault entries unreadable with that reason; legacy per the 5.5 read rule | values: app legacy-only, Node and inproc refused with the reason; deletes: metadata-only on every host (5.5) |
| `missing-key` | custodian `missing` or `denied` | as `locked`, reason "This vault's key is not available for this user on this machine" | as `locked` |
| `key-mismatch` | key found but `check` fails: another key (a different key file, a keychain restored from elsewhere) or a damaged check record | as `locked`, reason "The key does not match this vault, or the vault is damaged" | as `locked` |
| `corrupt` | does not parse or fails validation | **no** automatic legacy reads: the baseline and `lc` are lost, so `secrets.json` may hold rotated or deleted values; every secret reads unreadable, "The secret vault is damaged; run `orgai secrets reset` to start over from the OrgAI app's older copies" | values refused; the file is never rewritten; deletes per 5.5 (removals leave the key, explicit clears refused) |

- An entry whose GCM tag fails after `check` passed is `unreadable`, never "unset".
- `SecretStore.status(key)`: `'set' | 'unset' | { unreadable: reason }`. `has()` keeps meaning "a value exists
  somewhere". Status displays (`McpService` info / statusFor, `ConnectionService.probeLiteLLM`) use `status()` and
  say why ("Saved by the OrgAI app and not yet shared with the orgai command: open the app once", "The secret vault
  is locked: <reason>") instead of "unset" or "set it again".
- **Moves and copies refuse unreadable secrets**: every mutation that reads a secret to store it elsewhere or deletes
  the source after copying (`McpService.promote`, `copyFromLibrary` with `copySecrets` or per-project values, and any
  later caller found by auditing `secrets.get(` in mutating paths) first checks `status()` for every slot it would
  carry and refuses the whole operation, before changing any record, when one is unreadable: "<slot> of <server>
  cannot be read here (<reason>); open the OrgAI app or unlock the vault first." A unit test per operation.

### 5.5 Reconciliation with `secrets.json`

Inputs per key K: L = the `secrets.json` value string or none; the legacy file's state; B = `legacy[K]`; H =
sha256(L); E = the vault entry, with `E.lc`; T = a tombstone for K.

A host "can write back" when it can encrypt with safeStorage: the app host with safeStorage available. An app host
whose vault is open (for example through a key file) but whose safeStorage is unavailable reconciles like a Node host.

**Legacy file states.**

- `ok`: parses, `secrets` is an object.
- `missing`: no file. Older apps never unlink it (their store only rewrites it, code), so a missing file is never read
  as deletions: every baseline is dropped and every entry gets `lc = false`; during the dual-write window a host that
  can write back then recreates the file through the write-back row. With `legacyRetired` set, see Retirement.
- `corrupt`: does not parse, or `secrets` is not an object. No reconciliation, no legacy reads, and no host of this
  wave rewrites the file (the old "load as empty, then overwrite" behaviour of `SecretStore` ends); doctor and an app
  notice report it.
- A single value that safeStorage cannot decrypt (another user, a damaged string) is skipped for that key only, with a
  warning; the rest reconciles.

**Rules** (every host, on open, under ownership, before serving; the first matching row wins):

| # | Case | Meaning | Host that can write back | Other hosts |
| --- | --- | --- | --- | --- |
| 1 | L present, T `by: 'vault'`, H = `T.legacyHash` | the exact legacy value this delete targeted is still there (a delete interrupted after its first step) | delete L from `secrets.json`, then drop `legacy[K]` | same (deleting a key needs no cipher; the other entries are rewritten unchanged) |
| 2 | L absent, T `by: 'vault'`, B present | a delete interrupted after its second step | drop `legacy[K]` | same |
| 3 | L present, B none, no E, no T | never reconciled | import: entry from L, `lc = true`, `legacy[K] = H` | `pending-legacy` (unreadable, "saved by the OrgAI app") |
| 4 | L present, H != B (B none with E or T counts as different), not row 1 | an older app, or this app in legacy-only mode, wrote K after the last reconcile | import L over E or T, `lc = true`, `legacy[K] = H` | `pending-legacy` |
| 5 | L present, H = B, E with `lc` false | the vault is newer | write back: encrypt E to L', write it, `legacy[K] = sha256(L')`, `lc = true` (dual-write window only) | nothing |
| 6 | L absent, B none, E with `lc` false | written only through the vault | write back (as row 5; dual-write window only) | nothing |
| 7 | L absent, file `ok`, B present, no T | the legacy copy disappeared after the last reconcile | soft delete: T `by: 'legacy'` with `prev` = E, drop `legacy[K]` | same (no decryption needed) |
| 8 | anything else | consistent | nothing | nothing |

- **Disappearances are soft**, whatever their number: an older app deleting a key and an older app rewriting a corrupt
  file as nearly empty look the same, so a `by: 'legacy'` tombstone makes the secret read as deleted (the user's last
  action may have been a delete) but keeps its value until the user decides. The app notice ("N saved
  secrets were removed by an older version of OrgAI. Restore / Keep removed") is NOT built (integration review: the
  removal is logged only); until it ships, `orgai doctor` / `orgai secrets status`
  list them; `orgai secrets undelete <key>` restores one (`secrets:undelete`), and "Keep removed" confirms them
  (`secrets:confirmDelete`). Nothing expires them on a timer. This wave's own deletes
  never produce one (see Deletes).
- `pending-legacy` lives in memory. A write of K by that host clears it, sets `legacy[K] = H` (the older app's value is
  superseded) and `lc = false`.
- **Legacy read rule** (the app reading `secrets.json` because the vault is not open, an entry is unreadable, or the key
  is not in the vault): L is used only when H != B, or H = B and `E.lc` is true. Never when H = B and `lc` is false,
  never for a key with a tombstone and H = B, and never while the vault is `corrupt` (5.4).

**Writes** (dual-write applies to hosts that can write back, this release and the next, **D6**):

1. Host that can write back: encrypt with safeStorage to L'; write `secrets.json` with L'; then write `vault.json` with
   the entry, `lc = true`, `legacy[K] = sha256(L')`, T removed. A crash between the two converges to the new value
   (row 4 imports L', the same value).
2. Other hosts with the vault open: write `vault.json` only: entry with `lc = false`, T removed, and `legacy[K] =
   H(L)` when L is present (so the stale legacy copy is never read again), else unchanged.
3. App host in legacy-only mode (vault not open): `secrets.json` only, as today (the app never regresses); the next open
   with a working key imports it (row 4).

**Deletes** (every host and every vault state in which `vault.json` parses: `open`, `locked`, `missing-key`,
`key-mismatch`; the vault steps are metadata only and need no DEK):

1. `vault.json`: T `by: 'vault'` with `legacyHash` = H when L is present (whatever B is: a legacy-only save or a
   `pending-legacy` value has H != B), E removed, `legacy[K]` kept. What is kept for undelete is the newest value:
   when L is newer than E (H != B, or `pending-legacy`), `prevLegacy` = L and no `prev`; otherwise `prev` = E's
   ciphertext. Undelete restores whichever is kept; one with only `prevLegacy` can be restored only by the app (a Node
   host says "This deleted secret was saved by the OrgAI app; open the app to restore it").
2. `secrets.json`: remove K (when present and the file is `ok`).
3. `vault.json`: drop `legacy[K]`.

A crash after step 1 is row 1 (the surviving L is exactly the one targeted, never an older app's later
replacement, which has another hash), after step 2 is row 2; neither ever shows the "older version" notice.

Deletes that are part of a removal (a project, a server, a library entry, `linkLibrary`, a kit replace) never throw,
in any state, so a removal that already changed other stores is never left half done: a key that cannot be handled
under the rules (vault `corrupt`, or a Node host with an `absent` vault and a legacy-only key) is left where it is,
logged, and counted by doctor as orphaned. An explicit clear (`set-secret --clear`, `connectors:setToken` null) is
checked before anything changes and refused in those cases with the reason: with the vault `corrupt` ("run `orgai
secrets reset`"), and on a Node or inproc host whose vault is `absent` for a key that exists only in `secrets.json`
("Saved by the OrgAI app: open the app once, or run `orgai secrets init` first"). Deleting a key that exists nowhere is
a no-op in every state.

**Retirement** (the release after the dual-write window, **D6**), run only by an app host with the vault open and
only when every key in `secrets.json` is reconciled (H = B, nothing `pending-legacy`, nothing undecryptable, no
unconfirmed soft delete); otherwise it waits for a later boot. (1) Durably write `legacyRetired: { at, digest,
keys }` with `digest` = sha256 of the exact `secrets.json` bytes and `keys` = the per-key baseline at that moment
(H for every key), then clear `legacy`; (2) delete `secrets.json`. Once retired, rows 1-7 are off and the write-back
stops. A `secrets.json` present after retirement is compared per key: a key whose H equals `keys[K]` is residue and
ignored; a key with a different or new H was written by an older app after retirement and is newer (a host that can decrypt imports it, `lc = true`, and records the new H in `keys[K]` in the same vault write, so a
file kept because another key is still pending can never replay a consumed value; others mark it
`pending-legacy`). The file is deleted only by a host that resolved
every key in it (never by a Node host while one is pending), and only when its bytes have not changed since it was
read (re-hash before unlink). A whole-file digest equal to `digest` is the fast path for pure residue.

**Durability and failures** (R7):

- POSIX: fsync the temp file, rename, fsync the directory. Windows: fsync the temp file and rename (Node's
  `renameSync` is `MoveFileEx` with `MOVEFILE_REPLACE_EXISTING`); directory fsync is not available there and is
  skipped, so a power loss right after a rename may lose that rename on Windows (accepted, documented; unverified
  whether `MOVEFILE_WRITE_THROUGH` would be reachable without a native call). POSIX file systems that refuse directory
  fsync (`EINVAL`, `ENOTSUP`) are treated like Windows.
- A failure before a rename changes nothing and the caller gets the error.
- A failure at or after a rename (a failed directory fsync, or the second file) means the outcome is not known to be
  durable: the caller gets an error ("The secret may or may not have been saved; check with `orgai secrets
  status`"), never success. The store re-reads both files from disk at once into fresh in-memory maps (so synchronous reads keep serving what is
  on disk). With the vault open it then reconciles; mutations are refused until a reconcile succeeds (retried before
  each later write). With the vault not open (legacy-only mode, metadata-only deletes) there is nothing to reconcile:
  the re-read itself restores consistency and mutations resume.

Prefix deletes apply each rule per key. Required tests (not done): fault injection at every write, fsync and rename
boundary, including visible-but-not-durable renames; upgrade -> Node write -> older app write -> upgrade; Node creates a
new key -> app opens -> older app sees it (with and without an existing `secrets.json`); Node rotate -> app boot with a
locked custodian (must not read the old value); Node delete -> app boot; Node delete of a `pending-legacy` key, then
undelete in the app; a legacy-only app save then clear of a vault-only key, then unlock (stays deleted, no notice);
older app deletes one key; older app rewrites a corrupt `secrets.json` with one, three and four original keys (all
soft deletes, restorable); every delete interrupted after each step (no notice, converges to deleted); retirement
interrupted between its steps, then an unrelated older-app edit (the stale key stays residue), then a Node reopen (file
kept while a key is pending); a vault that turns corrupt after a Node rotation (no legacy read).

### 5.6 Opening and creating

- **Open before boot**: `bootOrgAIHost` is synchronous (code), so a new async step `openSecretStore({ dataDir,
  custodian, cipher, overlay })` runs after `acquireHostOwnership` and before `bootOrgAIHost`, in the desktop shell,
  the headless host, the Node host and the inproc host, and passes the opened `SecretStore` in (new
  `BootOrgAIHostOptions.secrets` instance). It opens an existing vault (decrypting `check`), reconciles, and only then
  does `bootOrgAIHost` build services and start probes, so first probes see CLI-written secrets. `daemon.json` stays
  `starting` meanwhile; the starting wait in `ensureHost`, `daemon.ts`, `doctor.ts` and `exec.ts` grows from 2 s to
  15 s to cover the 10 s custodian timeout.
- **App host creation**: when the vault is `absent`, `openSecretStore` calls `custodian.create` directly (one
  subprocess; its failure is classified like a probe), writes the vault and imports every legacy key. On failure the
  app runs in legacy-only mode and retries in the background every 10 minutes, on window focus after a lock failure,
  and on `secrets:init`: `create` while the vault is `absent`, `open` while it is `locked` (an existing vault is never
  re-created); a success reconciles in place (the store swaps in the vault under its write queue), so no restart is needed.
  Every host kind (Node and inproc too) retries `open` for a `locked` vault, and for `missing-key` when a key file is
  configured, at `prepareWrite()` and on `secrets:init`, so unlocking the keychain over SSH works without restarting
  a Node host.
- **Node / inproc creation is lazy** (no keychain item until a value is stored): `SecretStore.prepareWrite()` is a
  single-flight promise (concurrent callers share one creation; it re-checks `vault.json` after the custodian call and
  opens an existing vault instead of overwriting it). These hosts are reached only through `HostDispatcher.invokeRpc`
  (async). Registry entries that can store a secret gain `storesSecret: (args, host) => boolean`, a predicate over the
  validated arguments and read-only host state (the project and library stores and `SecretStore.keys`, for promote
  and copy) that is true only when the call will store a non-empty value: `connections:setSecret` and
  `connectors:setToken` with a non-empty value, `mcp:setSecret` / `mcpLibrary:setSecret` with a non-empty value,
  `setup:decide` approving an MCP proposal with non-empty `secrets`, `mcp:answerInstall` approving with non-empty
  `secrets` and a scope other than 'run', `mcp:authorize` when its input carries a client secret (it is stored before the browser opens,
  code), `mcp:promote` / `mcp:copyFromLibrary` when the source holds a readable secret (per-project values included,
  whatever `copySecrets` says; with an unreadable source the predicate is false and the handler refuses, 5.4). `invokeRpc` awaits `prepareWrite()` only when the predicate is true, before the handler
  runs, so handlers stay synchronous and read their state after the vault is ready; clears and calls that store nothing never create a vault. Async internal writers await `prepareWrite()` themselves
  immediately before their `set()`: the OAuth authorize flow after the browser step, and `McpService.doRefresh`
  (reached from `mcp:test`, `mcpLibrary:test` and `prepareForRun` for runs, setup and maintenance). `set()` with a value on an `absent` vault in these hosts throws `VaultNotReady` (a bug
  trap); `set(key, null | '')`, `delete` and `deletePrefix` on an `absent` vault touch `secrets.json` only.
- **Test**: a dedicated test (not the `jsonRoundTrip.test.ts` fixtures, which cover few channels) seeds a mock inproc
  host with a project, a project MCP server, a library entry, a connector and pending MCP-proposal and MCP-install
  cards, then drives every channel that reaches `SecretStore` with a value and with a clear, asserting that a value
  call prepares first and a clear never creates a vault. A `SecretStore` spy records every `set` / `delete`; a channel
  that stores without its predicate firing fails the test.
- Host channels: `secrets:status` (`read`; scheme, state, counts, pending, soft deletes, never values),
  `secrets:init` (`configure`; OS scheme or key file), `secrets:reset` (`configure`; served in every vault state),
  `secrets:undelete` (`configure`; "Restore"), `secrets:confirmDelete` (`configure`; "Keep removed": `{ keys }` ->
  `{ confirmed }`, drops the kept values of those soft deletes so they stop listing and no longer hold back
  Retirement). Registry and its tests updated.
- **Reset** (`orgai secrets reset --yes`): refused while a secret write, an OAuth flow or a token refresh is in
  flight ("A sign-in or save is in progress; try again when it ends"); it takes the store's write queue. Then `vault.json` is renamed to `vault.json.reset-<time>` (or
  `.corrupt-<time>`), so the store is `absent` again; nothing in the moved file is read again. The app host then
  creates a fresh vault at once and imports what `secrets.json` holds; Node and inproc hosts stay `absent` until the
  next stored value. The command says before asking: "Secrets saved only through the orgai command are lost; the OrgAI
  app's older copies, which may be outdated, are used instead." The old OS keychain item is left in place (it may
  belong to a vault copied elsewhere); `secrets status` lists such orphans by vault id.

### 5.7 CLI surface

- `orgai connections set-secret`, `orgai mcp set-secret` and `orgai mcp authorize` work on Node and inproc hosts.
  Environment overlays keep winning over stored values.
- `orgai secrets status | init [--key-file <path> [--import]] | reset --yes | undelete <key>`. No command prints a
  value.
- `orgai doctor`: custodian scheme and probe, vault state, legacy file state, pending-legacy count with the "open the
  app once" hint, guard notices. A client of the host when one runs; else it reads `vault.json` metadata only and
  never decrypts.

### 5.8 Threat model

- Protects against: copying the data folder (backups, sync, another machine), another OS user, offline disk access
  without the user's login (DPAPI, a locked keychain or keyring).
- Does not protect against processes running as the same user, agents included. On Windows and Linux the app's
  safeStorage is already in that position. On macOS it is a **weakening**: safeStorage's item is readable without a
  prompt only by OrgAI.app; an item created through `/usr/bin/security` is readable without a prompt by anything that
  runs `/usr/bin/security`.
- Env overlay secrets (`ORGAI_SECRET_*`) stay in the in-process host's own initial environment, which the child scrub does
  not touch; the gate denies `/proc/<pid>/environ` words and `ps` environment flags (integration review), but a script
  reading another process's environment still gets them. Same-user agents are not protected (5.8).
- The self-control gate gets more text rules (8.4); they are a speed bump, not a boundary (a script, or D-Bus from
  Python, reaches the key). **D4** asks the owner to accept agent-reachable custody on all three platforms
  (recommended: the alternative is that the CLI cannot use any secret the app saved), keep macOS app-only, or wait for
  a signed helper with caller checks (needs the archive channel).

### 5.9 Why not decrypt safeStorage from Node

OSCrypt formats (macOS Keychain item owned by the app with a PBKDF2-derived AES key; Windows key wrapped in the app's
`Local State`; Linux libsecret or a fixed fallback key; `v10` / `v11` prefixes) are Chromium internals that change
between releases (unverified at Electron 45.1.0), and reading the app's Keychain item from `node` prompts the user.
The app reconciles its own entries instead (5.5).

---

## 6. Agent runtimes

### 6.1 Claude

One resolver `claudeExecutable(env)` (new `src/main/runtime/claudeBinary.ts`), used by `claude.ts` and
`anthropicAuth.ts`, evaluated per call (not at import): `ORGAI_CLAUDE_PATH` (must exist and be a regular file), the
app.asar.unpacked native package, the SDK's per-platform package through `createRequire` from the bundle, else none.
When resolved, always pass `pathToClaudeCodeExecutable`. When none and the SDK's native package is missing, both the
probe and runs say "The Claude runtime for <platform>-<arch> is not installed; reinstall orgai without
--omit=optional, or set ORGAI_CLAUDE_PATH." The connection probe checks the login with the resolver's binary, so the probe and runs never disagree; a `claude`
found on PATH is mentioned in the error ("a claude on PATH at <path> is not used; set ORGAI_CLAUDE_PATH to use it"),
never used silently.

### 6.2 Codex (**D7**)

Not a dependency of the npm package (347 MB most Claude users never run). Resolution (synchronous, file-system only,
in `resolveCodexBinary`):

1. `ORGAI_CODEX_PATH`.
2. The per-platform package if `createRequire` resolves it from our bundle (the app, the archive).
3. `codex` on PATH, by walking the PATH directories with `statSync` (never the cwd; no `where.exe` spawn). Windows
   order per directory: `codex.exe`, `codex.cmd`, `codex.ps1`; the extensionless sh script npm also writes there is
   skipped. POSIX: `codex`.

A hit is classified by content, not name: a native executable (Mach-O, ELF or PE magic; Homebrew or a release
download) is used as is, with an adjacent `codex-path` folder when present. An npm shim (`.cmd`, `.ps1`, a script
starting `#!`, or a link to `bin/codex.js`) is mapped to its package folder, then to
`@openai/codex-<platform>-<arch>/vendor/<triple>/bin/codex[.exe]` and its `codex-path` folder (nested or hoisted). A
shim is never spawned (`spawn` of a `.cmd` without a shell fails, and a shell would mangle the `-c` TOML arguments).

Version: the native binary's `--version` (async, cached by realpath + mtime + size) runs in `CodexAppServer.start`
(so login, logout, discovery and runs are all covered) and in the OpenAI connection probe for every auth kind,
never in the synchronous resolver. Outside the tested range (today exactly 0.166.x; package.json pins
0.166.0, code): refused with "Codex <found> is not supported; install @openai/codex@0.166.0" when it came from steps
2-3; a run warning only when the user chose it through `ORGAI_CODEX_PATH`.

### 6.3 Environment

`ORGAI_CONTROL_ENV_PATTERNS` gains `/^ORGAI_VAULT_/i`, so the key-file locator never reaches agents, Codex or MCP
children. `ORGAI_CLAUDE_PATH` / `ORGAI_CODEX_PATH` are not secrets and stay.

---

## 7. Plain Node versus the app's Node

### 7.1 Node floor

`systemCerts.ts` feature-detects `tls.getCACertificates` / `setDefaultCACertificates`; its header says Node 24.5+,
and reviewers recalled other 22.x / 24.x minors. Phase A reads the Node changelogs, fixes the comment, and publishes
`engines.node` as the lowest 22.x and 24.x that have both (unverified until then). `doctor` warns when the running Node
lacks them ("Corporate root certificates will not be trusted on Node <v>; upgrade to <floor>"). CI pins the floor
version exactly in the verify-npm matrix.

### 7.2 Differences, each with a test

- `process.versions.electron` undefined: `HostLauncher` and `packagedApp` already branch on it.
- `process.execPath` is `node`: the macOS certificate child gets `ELECTRON_RUN_AS_NODE=1`, which plain Node ignores.
- Logs: `<userData>/logs/main.log`, plus `node-host.log` for a Node host's stdio; `daemon logs` finds both (4.2).
- Data folder defaults match the app's, so the npm CLI and the app share by default (G2).

---

## 8. Coexistence with the app

### 8.1 Versions

- Lockstep releases. On one `HOST_PROTOCOL_VERSION` with different app versions, the host refuses `configure` calls
  except `host.stop` (code): an npm CLI of another version can read and watch the app's runs but cannot change
  settings, secrets or projects. That stays (it is the guard against stores written by mismatched code); the refusal
  text gains the fix: "orgai <v1> and OrgAI <v2> differ; run `npm i -g orgai@<v2>` or update the app". `doctor`
  shows both versions. The compatibility matrix (same version: all scopes; different version, same protocol: read,
  operate, host.stop; different protocol: refused, exit 5) is a test table.
- No high-water mark in this wave: the vault is additive (an older app ignores `vault.json` and keeps working on
  `secrets.json`), so G4 needs none. A guard that older hosts honour must ship one release before the first change
  that an older host could damage; tracked as an open question (12).

### 8.2 Which `orgai` runs

The app's shim installer already refuses symlinks and files without its marker, so it never replaces npm's link
(code). `doctor` lists every `orgai` on PATH in order with channel and version and flags a shadowed newer one. App
settings > Terminal shows "The orgai command from npm (<version>) is on your PATH" and offers no Install when it finds
one.

### 8.3 Ownership

One owner among desktop, headless, Node and inproc hosts; ownership ends with the owner's process (4.3); the app's
handoff per 4.4.

### 8.4 Self-control gate additions

Each with tests in `selfControlGate.test.ts`; all are text checks (cli-spec Wave 6 caveat):

- Package runners naming the package: `npx`, `npm exec`, `npm x`, `pnpm dlx`, `pnpm exec`, `pnpx`, `yarn dlx`, `bunx`,
  with `orgai` or `@orgai/cli` (with or without `@<version>`), including the `-p` / `--package` forms. The scoped name
  is matched on the raw word before `binName`, which keeps only the last path segment and would read `@orgai/cli` as
  `cli` (code). (`CLI_FILE_NAMES` already covers `orgai`, `.exe`, `.cmd`, `.bat`, `.ps1`, `.mjs`, `.js` anywhere,
  code.)
- Reads of any file in `<data>` whose name starts with `vault.json` or `secrets.json` (the `.tmp`, `.reset-*` and
  `.corrupt-*` siblings included; matched as "parent is `<data>` and the basename has that prefix", canonical and
  lexical, not through `controlProtectedPaths`' directory rule `sameOrInside`, and globs in `<data>` that could match
  such a name count, as the gate already does for CLI names), of the key file whether named by `ORGAI_VAULT_KEY_FILE` or by `custody.keyFile`
  (re-read when the vault changes; canonical and lexical paths), and any word referencing `ORGAI_VAULT_*`.
- `security` with `find-generic-password`, `find-internet-password`, `add-generic-password`,
  `delete-generic-password`, `dump-keychain`, `export`, `-i`, reading from stdin, or any word `OrgAI Vault`; any
  `secret-tool` call; `busctl`, `gdbus`, `dbus-send` naming `org.freedesktop.secrets`; PowerShell or `pwsh` text naming
  `ProtectedData` or `Unprotect`.

---

## 9. The RunAsNode fuse (phase D)

1. **Certificate reader**: the desktop and headless hosts read the macOS store through `utilityProcess.fork` on a
   small bundled script file (`out/main/systemCertReader.js`; utilityProcess takes a module path, not `-e` text),
   started from `app.whenReady()` (utilityProcess cannot run before `ready`; `trustSystemCertificates()` is called at
   module top level today, so the call moves). Until it answers, the state is 'pending' as now. `systemCerts.ts` keeps
   an injected launcher so it stays Electron-free; Node and inproc hosts keep `node -e`. `index.ts`'s early exit on
   `ELECTRON_RUN_AS_NODE` stays.
2. **Retire the app-bundled CLI** (**D5** timing). Release N (after phase A): the Terminal row (`CliShimRow`) points
   to `npm i -g orgai`, Install stays, the bundled CLI prints a one-line deprecation note on stderr. Release N+1:
   - `build/bin/orgai` / `orgai.cmd` become stubs that run no JavaScript and print "The orgai command now installs
     separately: npm i -g orgai" (exit 1); `out/cli` and its asarUnpack go (the runtime packages stay unpacked for
     runs).
   - `shimInstaller`: Install is gone (`unavailableReason` says the command installs with npm). `refreshOnLaunch`
     gets a retirement path that runs before its `unavailableReason` check (which today returns 'skipped' first, code)
     and removes its own shims (marker `orgai-shim v1`, pointing at this install's launcher) when another `orgai` is on
     PATH, so a stale shim in `~/.local/bin` never shadows the npm one; otherwise it leaves them pointing at the stub,
     whose message tells the user what to do; the stub also looks for another `orgai` on PATH and, when
     it finds one, names it and the shim to delete.
3. **Fuses**: `runAsNode: false`, `enableNodeOptionsEnvironmentVariable: false`, `enableNodeCliInspectArguments:
   false`; `onlyLoadAppFromAsar` and `enableEmbeddedAsarIntegrityValidation` only after checking them against the
   unpacked runtime packages (unverified).
4. **`verify-pack.mjs`** in release N+1: the CLI steps that use RunAsNode (`--version`, doctor, the inproc exec and
   the background-host exec through the launcher) move to `verify-npm`; added checks are (a) the fuse wire read from
   the packaged binary (`@electron/fuses read`) and (b) `ELECTRON_RUN_AS_NODE=1 <app> -e
   "process.stdout.write('ORGAI_SENTINEL')"` does not print the sentinel, and (c) the stub launcher prints its message
   and exits 1.

---

## 10. Phases and gates

| Phase | Scope | Gate |
| --- | --- | --- |
| A | npm builder with shrinkwrap, `install.json`, launcher changes (checkout marker, installed-app discovery, found / absent / broken), auto -> inproc for every `ensureHost` caller, env-secret refusal moved, Claude resolver, Codex resolution, Node floor, doctor channel and PATH listing, gate package-runner rules, verify-npm and publish jobs | typecheck, unit, build, e2e:free; verify-npm steps 1-5 on three OSes |
| B | Vault, custodians, reconciliation, states, `prepareWrite`, secrets channels and commands, `ORGAI_VAULT_*` scrub and gate rules, Node host, the 4.3 ownership rule and the 4.4 handoff, longer starting wait | unit tests with fake custodians and fault injection; verify-npm step 6; `scripts/probe-custodian.mjs` (token-free; creates, reopens in a fresh process and deletes one item under a throwaway vaultId; reports locked and missing cases) run once per OS with the user's consent; handoff integration test with a real Node host process and a late writer |
| C | Portable archive | archive verify on three OSes |
| D | Fuse (9) | fuse wire read and sentinel check in `pack:verify`; certificate read via utilityProcess on a packaged macOS build |

Anything only checked by unit tests or fakes stays marked unverified in CLAUDE.md, as for earlier waves.

---

## 11. Decisions for the owner

| | Question | Recommended |
| --- | --- | --- |
| D1 | Package name `orgai` or `@orgai/cli` | **Decided (owner, 2026-11-06): `orgai-cli`** (npm refused `orgai`); bin `orgai`. Built and in use throughout the code |
| D2 | npm trusted publishing (OIDC) or an automation token; a manual approval before `publish-npm` | **Accepted (owner, 2026-11-07):** trusted publishing, with approval |
| D3 | OS tools as child processes, or a native keyring addon (`@napi-rs/keyring`, N-API, one build for Node and Electron; a supply-chain dependency with per-platform prebuilds) | **Accepted (owner, 2026-11-07):** child processes; revisit if the custodian probes are unreliable |
| D4 | Agent-reachable vault key on all platforms, including the macOS weakening | **Accepted (owner, 2026-11-07):** accept, documented |
| D5 | When to retire the app-bundled CLI; whether to ship the archive | **Accepted (owner, 2026-11-07):** deprecation in the release after phase A, stub one release later; archive on demand |
| D6 | Dual-write window | **Accepted (owner, 2026-11-07):** this release and the next |
| D7 | Codex: bring-your-own with a version check, or a pinned optional dependency | **Accepted (owner, 2026-11-07):** bring-your-own |
| D8 | Desktop handoff grant (4.4 step 5): `host.status` and `host.stop` (forced included) for any `desktop` hello with `daemon.secret`, whatever Terminal access is. Not an authentication of the app: any same-user process holding the secret can stop a Node host; the descendant check refuses agents where it works | **Accepted (owner, 2026-11-07):** accept |
| D9 | Node host Terminal access level: stored setting (default `operate`), asked once on `daemon start` from a terminal, changed with `orgai terminal-access` | **Accepted (owner, 2026-11-07):** accept; revisit a `full` default for macOS and Linux, where the peer check refuses the host's own descendants |
| D10 | Shrinkwrap in the published package | **Owner decision 2026-11-06, to revisit: `NPM_SHRINKWRAP=none`** in release.yml and ci.yml (exact top-level pins, no `npm-shrinkwrap.json`). With npm 11 a honoured shrinkwrap installed every platform's Claude runtime (about 2 GB); `none` installs about 300 MB. The `full` path stays behind that one setting |

---

## 12. Open questions

- Node host idle exit (30 min) when a TUI user detached and left a run paused for a usage window.
- `--host auto` with no app: inproc (recommended, no surprise background process) or the Node host.
- The first format change an older host could damage needs a guard released one version before it; which store goes
  first and what the guard file looks like.

---

## 13. Review log

### Round 1 (draft 1 -> draft 2)

Astra (gpt-6-astra) and Argon (gemini-4-argon-high), both REVISE. Each finding was checked against the code before it
was accepted.

| Finding | Resolution |
| --- | --- |
| npm package matches `devAppRoot` (name `orgai`), never reaches `APP_NOT_FOUND`; no installed-app discovery (Astra 1, Argon 3) | 4.1: install channel, checkout marker, installed-app discovery, found / absent / broken |
| Fallback only for run commands; management commands use `withHost` (Argon 7) | 4.1 step 4 covers every `ensureHost` caller |
| `--secret-env` refused under default `--host auto` (Argon 7) | 4.1: collect always, refuse only when attached to a non-inproc host |
| Migration resurrects deletes and ignores downgrade edits (Astra 2, Argon 5) | 5.2 tombstones and `legacy` baseline; 5.5 reconciliation table run by every host |
| Dual-write not atomic, no fsync, map mutated before persist (Astra 3) | 5.5 write order (legacy first), fsync file and directory, maps updated after both renames, fault-injection tests |
| `format.json` cannot protect against released hosts and conflicts with G4 (Astra 4, Argon 5) | dropped; 8.1 explains why G4 needs none; open question 12 |
| Forced drain releases with writers in flight; inproc does not exit (Astra 5) | 4.3 step 5 fence on process exit (pid + start time), not on release |
| Undefined locked / corrupt / missing-key states; risk of regenerating the DEK (Astra 6) | 5.4 state table; 5.2 never create a DEK for an existing vault; `secrets reset` explicit |
| Key file: no Windows ACL, link safety, inside-backup warning, path not persisted (Astra 7, Argon 2) | 5.3 key-file row, `custody.keyFile`, refusal inside the data folder, README warning |
| `childEnvFor` drops D-Bus and Windows variables, exact-case `Path` (Astra 8, Argon 1) | 5.3 per-custodian allowlists, case-insensitive on Windows, absolute powershell path |
| `ORGAI_VAULT_KEY_FILE` leaks to agents (Astra 8, Argon 2) | 6.3 scrub pattern; 8.4 gate rule |
| Gate rules trivially bypassed; DPAPI blob without entropy (Astra 9, Argon 4) | 8.4 broader rules; 5.8 states it is a speed bump, D4 accepts agent reach; 5.3 DPAPI entropy bound to vaultId |
| Codex `.cmd` shim cannot be spawned; `rg` folder lost (Astra 10, Argon 9) | 6.2 follow shims to the native binary and `codex-path`; async cached version check. Argon's "0.116.x" is wrong: package.json pins 0.166.0 |
| Exact top-level pins do not reproduce the tree; peers; install scripts (Astra 11) | 3.1 peers pinned, shrinkwrap, install-script allowlist, verify against `npm ls` |
| Version skew blocks `configure` (Astra 12) | 8.1 documents the matrix and the fix text |
| `desktopRequired` check names `inproc` only; scopes not hierarchical; TUI clients block idle (Astra 13) | 4.2 `canOpenWindows`; 4.3 asks `read` + `configure`, names attached sessions, inproc never stopped from the app |
| Terminal access off blocks the app's handoff; status/stop TOCTOU; `endedBy` misstated; reply not flushed before exit (Argon 8) | 4.3 owner-handoff grant (D8), call stop and read `stopping`, correct wording ("Ended when OrgAI closed"), flush before exit |
| Fuse check unreliable; retirement breaks shims; verify-pack depends on the launcher (Astra 14, Argon 15) | 9 fuse wire read plus sentinel; stub launcher for existing shims; verify-pack steps moved |
| Gates do not prove runtimes start; smoke command lacked prompt and fixture; Node floor unresolved (Astra 15, Argon 14) | 3.4 verify-npm steps 1-7; 7.1 floor task with doctor warning; 10 per-phase gates |
| Synchronous `SecretStore` cannot create the vault lazily; boot unwrap exceeds the 2 s wait; no RPC for `secrets` commands (Argon 6) | 5.6 `prepareWrite`, app opens after ready, 15 s wait, `secrets:status` / `secrets:init` channels |
| `ORGAI_CLAUDE_PATH` ignored by `anthropicAuth.ts`, evaluated at import (Argon 10) | 6.1 one resolver per call, used by both |
| `security -i` over SSH with a locked keychain; prompts on stdout (Argon 11) | 5.3 `-i -q`, `locked` mapping with an actionable reason |
| `--host node` not a mode; `HOST_KINDS`; `daemon logs` path (Argon 12) | 4.2 `--runtime` flag on `daemon start`, `HOST_KINDS`, log lookup |
| `has()` vs `get()` mismatch; misleading "set it again" (Argon 13) | 5.4 `status(key)` with reasons used by MCP and connection status |
| Release job permissions and matrix publish (Argon 15) | 3.4 single `publish-npm` job with `id-token: write` |

### Round 2 (draft 2 -> draft 3)

Astra 14 findings (8 High), Argon 10 (2 Critical, 5 High), both REVISE. Checked against the code; Argon's 8 (a
`packages/cli` manifest and a `verify-pack` npm install step) and its systemCerts claim (the child runs
`tls.getCACertificates('system')`, not `/usr/bin/security`) describe text or code that does not exist and were not
taken; its claim that Node and inproc hosts always have terminal access on is wrong (`bootstrap.ts` keeps the user's
explicit choice), which is why the handoff grant stays.

| Finding | Resolution |
| --- | --- |
| A forced drain releases ownership with writers in flight; any contender, not only the app, can take the folder (Astra 1) | 4.3: Node / inproc hosts release only after writers settle, else exit; a three-process test |
| A matching baseline hash does not mean the legacy copy is current; reads could serve a rotated or deleted value (Astra 2, Argon 2) | 5.2 per-entry `lc`; 5.5 legacy read rule; Node writes set the baseline to the current legacy hash; the app writes vault-only values back during the dual-write window |
| A corrupt `secrets.json` turns into mass deletions; an older app may rewrite it as empty (Astra 3) | 5.5 legacy file states (`corrupt` = no reconcile, never rewritten), the mass-deletion guard, tombstones keep `prev` 30 days, `secrets undelete` |
| Retiring `secrets.json` fires the deletion rule (Astra 4) | 5.5 retirement: `legacyRetired` and cleared baselines written first, then the file deleted |
| `prepareWrite` claimed every write path is async (false: `McpService.promote`, `persistInstall`, `applyProposal` and others are sync; `HostDispatcher.invoke` keeps sync handlers sync); no single-flight; await inside read-modify-write (Astra 5, Argon 1, Argon 9) | 5.6: the app creates at boot; Node / inproc hosts await a single-flight `prepareWrite` in `invokeRpc` before handlers flagged `writesSecrets` run, so handlers stay sync and read state afterwards; a registry-wide test |
| Deletes would create a vault and keychain item on a fresh install (Argon 1) | 5.6: deletes never create a vault |
| The app opened the vault after `markReady`, but probes read secrets earlier (Argon 1) | 5.6: every host opens and reconciles before `connections.init` and `monitor.start`; starting wait 15 s |
| Unreadable secrets silently dropped by promote / copy (Astra 6) | 5.4: those operations refuse before changing anything |
| Windows key file written before its DACL is set; the ACL helper keyed to the data dir and environment (Astra 7) | 5.3.1: exclusive empty file, DACL from the SID via `whoami`, verify, then write; fail closed |
| npm publish job lacked the release guard (Astra 8) | 3.4: `needs: [meta, build, verify-npm]`, the `publish` condition, the exact verified tarball |
| `--runtime node` from the bundled CLI runs Electron, not Node (Astra 9) | 4.2: refused when `install.json` says `app` |
| `server.close()` is void; `onDrained` runs before the stop reply is queued (Astra 10, Argon 3) | 4.3: `closeGracefully`, `onDrained` from `setImmediate`, release after the flush |
| Failure contract wrong after a rename (Astra 11) | 5.5 Failures: `needs-reconcile`, re-read from disk, R7 reworded |
| No reset RPC; reset semantics undefined (Astra 12, Argon 9) | 5.6: `secrets:reset` in every state, defined effect; `secrets:undelete` |
| Presence checks cannot prove decryption; "Tested" claimed for tests that do not exist (Astra 13) | 3.4 step 6 uses a local fake LiteLLM that checks the bearer value; 5.5 lists the sequences as required tests |
| R3 contradicted secret-write RPCs (Astra 14) | 5.1 R3 lists the allowed channels |
| `--host daemon` would fall back in-process; `ensureHost` waits only for Electron kinds; `startBackground: false` turned off certificates and status probes; env-secret refusal placement (Argon 4) | 4.1: daemon never in-process and waits for `node` too; background flags split, certificates always on; refusal rules per mode and command |
| `probe()` undefined; `openssl rand -base64` files rejected; key file inside `<userData>`; the gate missed `custody.keyFile` (Argon 5) | 5.3 probe column; 5.3.1 content, location and creation rules; 8.4 |
| `utilityProcess.fork` before `ready` and without a file; Install / refresh keep shims on a stub (Argon 6) | 9.1 bundled script started after `whenReady`; 9.2 Install removed, owned shims removed when another `orgai` is on PATH |
| Codex PATH lookup order on Windows, sync resolution, Homebrew native binaries, contradictory `ORGAI_CODEX_PATH` message (Argon 7) | 6.2 |
| Headless launch would show a dialog; the waiting app had no window; paused runs (Argon 3) | 4.4 steps 1, 2 and 4 |
| `daemon start --runtime` mismatch silently succeeded (Argon 10) | 4.2 |

### Round 3 (draft 3 -> draft 4)

Astra 8 findings (6 High), Argon 11 (1 Critical, 5 High), both REVISE. Argon's 1 (a `build/bin` launcher running
`node` on `<resources>/cli`), 9 (an `ORGAI_CODEX_BIN` variable and a "section 8.2" Codex order) and 11 (a shrinkwrap
`optional` check in a "section 7.4") quote text that is not in the spec and were not taken; the rest were checked
against the code.

| Finding | Resolution |
| --- | --- |
| The ownership rule left desktop and headless hosts releasing with writers in flight; desktop IPC ignores draining (Astra 1) | 4.3 applies to every host kind; `invoke` refuses mutations while draining; tests per owner kind |
| Vault-only secrets never copied back for an older app (Astra 2) | 5.5 row "L absent, B none, E with `lc` false": write back during the dual-write window; test |
| An interrupted retirement read a stale residue as newer (Astra 3) | 5.2 `legacyRetired.digest`; 5.5 residue with the same digest is deleted unread |
| The guard missed small stores; a missing legacy file read as deletions; deletes destroyed newer values (Astra 4, Argon 4) | 5.5 every disappearance is a soft, restorable `by: 'legacy'` tombstone with a notice; a missing file is never deletions |
| A corrupt vault fell back to possibly stale legacy values (Astra 5) | 5.4 `corrupt`: no automatic legacy reads; reset is the explicit way back |
| Readback after a failed directory fsync was acknowledged (Astra 6); Windows has no directory fsync; discarding maps broke reads (Argon 7) | 5.5 Durability: an indeterminate outcome is an error, never success; Windows and refusing file systems documented; maps reloaded from disk, not discarded |
| Static `writesSecrets` created a vault for clears and non-secret calls; the round-trip fixtures cannot exercise it (Astra 7, Argon 2) | 5.6 `storesSecret(args)` predicates; a dedicated seeded test with value and clear inputs |
| No way to tell a wrong key (Astra 8) | 5.2 `check` record; 5.4 `key-mismatch`; 3.4 step 6 expects it |
| `bootOrgAIHost` is synchronous; probe plus create doubled the subprocesses; the app never retried creation (Argon 3) | 5.6 `openSecretStore` before `bootOrgAIHost`; `create` called directly; background retry and in-place swap |
| Reset left `vault.json` in place, so the missing key came back (Argon 5) | 5.6 reset moves the file aside, the store is `absent` |
| `hostClient.ts` rejects `node`; `helloProblem` rejects `desktop`; scopes cannot express the narrow grant; second-instance ignored while waiting; `orgai app` timeout (Argon 6) | 4.4 code list, `handoffOnly` enforced before dispatch, `waitingForHandoff`, `orgai app` returns at once |
| Safe storage unavailable while the vault is open through a key file; one undecryptable legacy value aborting reconcile (Argon 7) | 5.5 vault-only write with `lc = false`; per-key skip |
| Env-secret refusal list missed commands that use secrets; explicit `--secret-env` silently ignored (Argon 8) | 4.1 explicit flag always refused; ambient variable refused except for a fixed list of commands that never use secrets |
| `binName` strips `@orgai/`; `vault.json.*` siblings; keychain write and delete verbs (Argon 10) | 8.4 |

### Round 4 (draft 4 -> draft 5)

Astra 7 findings (5 High), Argon 10 (1 Critical, 4 High), both REVISE. All quoted the spec accurately this round and
were checked against the code.

| Finding | Resolution |
| --- | --- |
| Desktop mutations already in flight are not leased; background vault work untracked (Astra 1) | 4.3: `invoke` leases every mutation; secret background work holds a lease; a real async desktop handler test |
| Process exit at the drain deadline hands the folder over while writers or git children still run; `runDrain` releases before `onDrained` (Argon 2) | 4.3: no release while writers are in flight; a 60 s hard limit kills tracked children before exit; release moves after `closeGracefully`; three test cases |
| A non-forced stop ends runs waiting on cards (`busyRunCount` excludes them) (Astra 2) | 4.4 step 4: `handoff: true` stop predicate counting every live run and open card |
| The handoff grant missed Terminal access at `operate`; forced stop impossible with access off (deadlock) (Astra 3, Argon 5) | 4.4 step 5: a handoff grant whatever Terminal access is, forced stop included, peer-checked on macOS and Linux (D8) |
| A Node host gets `operate` with no way to change it without the app; a stored "off" refuses even the inproc host's own command (Argon 1) | 4.2.1: inproc always full; `orgai terminal-access` (in-process only); asked once on `daemon start`; D9 |
| Closing the waiting window quits the app on Windows and Linux; a window flashes on every handoff (Argon 5) | 4.4: `waitingForHandoff` guards `window-all-closed`; no window unless the handoff takes more than 1 s |
| A legacy-only delete could be undone by write-back; app deletes raised the "older version" notice; Node deletes lost undecryptable newer values; crash ordering (Astra 4, Argon 4) | 5.5 Deletes: three metadata-first steps in every mode, rows 1-2 for interrupted deletes, `prevLegacy`; row 7 only without a tombstone |
| Retirement residue after an older app rewrote the whole map; Node deleting the only copy (Astra 5) | 5.5 Retirement: per-key `keys` baseline; the file is deleted only when every key is resolved and unchanged |
| Missing `secrets.json` never recreated for an older app (Argon 4) | 5.5 `missing`: write-back recreates it |
| The check record cannot tell a wrong key from a damaged record (Astra 6) | 5.2 / 5.4 `key-mismatch` covering both |
| The npm-only suite dropped the packaged npm CLI -> app check (Astra 7) | 3.4 packaged integration in `pack:verify`, kept after the fuse change |
| `storesSecret(args)` cannot see whether promote / copy carry secrets; token refresh writes unlisted; reset during an OAuth flow (Argon 3) | 5.6 `storesSecret(args, host)`; `doRefresh` and authorize await `prepareWrite` themselves; reset refused while a write or flow is in flight |
| `--secret-env` silently ignored by `daemon start` and hostless commands (Argon 6) | 4.1 refusal by every command that will not run its own in-process host |
| The app retried only creation while an existing vault was locked; reconcile without safeStorage (Argon 7) | 5.6 retry `open` when locked; 5.5 "can write back" defines the column |
| `refreshOnLaunch` returns 'skipped' once `unavailableReason` is set (Argon 8) | 9.2 retirement path before that check; the stub names a shadowing shim |
| `npm ls` cannot equal a shrinkwrap with other platforms' optional packages (Argon 9) | 3.1 / 3.4 compare the runner's platform subset |
| Codex version check missed login and API-key probes (Argon 10) | 6.2 check in `CodexAppServer.start` and every OpenAI probe |

### Round 5 (draft 5 -> draft 6)

Astra 6 findings (5 High), Argon 13 (9 High). Argon's 1 (a "Section 3.4" retirement step list and doctor changes),
2 (a `storesSecret` list naming `connections:setApiKey`, `mcp:upsert` and `kit:applyBundle`, and missing
`mcp:setSecret`, which the spec lists) and 3 (`isPackagedRuntime()`, which does not exist in the repo) quote text or
code that is not there and were not taken; the rest were checked against the code.

| Finding | Resolution |
| --- | --- |
| An interrupted delete resurrects a value whose hash differs from the baseline (Astra 1) | 5.5 Deletes record `legacyHash`; row 1 matches it, row 4 excludes it |
| Retirement could classify unimported values as residue; imports after retirement could replay (Astra 2) | 5.5 Retirement runs only when everything is reconciled; imports update `keys[K]` |
| Desktop Quit, window close and direct `ipcMain` channels bypass the drain; non-forced drains skip `settleWriters` (Astra 3, Argon 5) | 4.3 one shutdown coordinator for every exit path; `before-quit` held; desktop-only mutating channels wrapped; tests through the real handlers |
| The OAuth client secret is stored before the browser step (Astra 4) | 5.6 `mcp:authorize` predicate when a client secret is supplied |
| The Linux handoff check trusts a claimed pid; "OrgAI app binary" undefined; `lsof` timeout (Astra 5, Argon 6) | 4.4 step 5 no longer claims to authenticate the app; descendant check only, 2 s budget for desktop hellos; D8 accepts the exposure on every platform |
| A Node host started with Terminal access off can be neither stopped nor fixed (Astra 6, Argon 4) | 4.2.1 `daemon start --runtime node` refuses while access is off |
| A Node host with an absent vault saw legacy keys as unset; deletes destroyed them (Argon 7) | 5.4 `absent` reads legacy keys as `pending-legacy`; 5.5 explicit clears refused, removals leave the key |
| 5.4 and 5.5 disagreed on deletes; removals could throw after other stores changed (Argon 8) | 5.4 deletes metadata-only on every host; 5.5 removals never throw, explicit clears checked first, deleting nothing is a no-op |
| Failure recovery wedged without a DEK; undelete with both `prev` and `prevLegacy` (Argon 9) | 5.5 re-read restores consistency when the vault is not open; only the newest value is kept for undelete |
| A cancelled keychain prompt read as a missing key; Node hosts never retried `open` (Argon 10) | 5.3 cancel and timeout are `locked`; 5.6 every host retries `open` |
| Ambient `ORGAI_SECRET_*` refused `decide`, `stop` and others against a live host (Argon 11) | 4.1 refused only by commands that use a secret there; only those skip spawning the app |
| Probe and runs could disagree about the Claude binary (Argon 12) | 6.1 the probe uses the resolver's binary; a PATH `claude` is named, not used |
| `sameOrInside` cannot match `vault.json.*` siblings (Argon 13) | 8.4 basename-prefix rule in `<data>`, globs included |

### Round 6 (draft 6 -> draft 7): resolutions binding on the implementation

Astra 7 findings (3 High), Argon 8 (5 High), both REVISE; the owner asked to execute the spec, so round 6 is folded in
here as rules the implementation follows rather than a further rewrite. Argon's 8 (desktop-only `ipcMain` channels) was
already covered by 4.3.

1. **One post-retirement baseline** (Astra 1, Argon 3). After retirement `legacyRetired.keys` is the only baseline.
   Every vault write that supersedes a legacy value (a Node write over a `pending-legacy` key, an import, a delete)
   updates `keys[K]` in the same vault write; delete step 3 drops `keys[K]`. Tombstone matching on `T.legacyHash`
   (rows 1-2) stays on after retirement, and runs before any post-retirement import.
2. **Delete recovery without a key** (Astra 4, Argon 2). Rows 1 and 2 need no DEK and run whenever `vault.json` parses
   (`open`, `locked`, `missing-key`, `key-mismatch`), at open and in failure recovery; a failed delete keeps the store
   in a recovery-required state until they have run. The legacy read rule also refuses L when H = `T.legacyHash`.
   Delete step 1 clears `pending-legacy` for K.
3. **Tombstones that hold the only copy** (Argon 1). A tombstone with `prevLegacy` is never collected; the first app
   host with the vault open and safeStorage available decrypts it and re-stores it as `prev` (under the DEK), after
   which the normal 30-day rule applies. A tombstone stays while its key is still in `secrets.json` (pre-retirement).
4. **OAuth commit order** (Astra 2, Astra 5). `McpService.authorize` awaits `prepareWrite()` before its final
   cancellation, owner-existence and resource checks, re-reads the owner after the await, then saves the OAuth
   configuration and every credential synchronously with no further await. The mock authorize path prepares before its
   synthetic token commit. The channel-coverage test distinguishes dispatcher preparation (predicate) from internal
   preparation (the writer awaited `prepareWrite` itself) and accepts either.
5. **Process trees at the hard limit** (Astra 3). Killing "tracked children" is not enough: at the 60 s limit the host
   enumerates every descendant of its own pid from the process table (POSIX `ps -A -o pid=,ppid=`, Windows the
   CIM `Win32_Process` table through PowerShell), sends SIGTERM (Windows `taskkill /T`), waits 5 s, sends SIGKILL
   (`taskkill /T /F`), and releases only once none of them is alive; if the table cannot be read, it waits in 1 s
   steps up to another 60 s before exiting anyway (logged). Tests: a git hook descendant, an agent shell that ignores
   SIGTERM, an MCP server child.
6. **Peer check self-pid shortcut** (Astra 6). `checkPeerAncestry` returns ok for `claimedPid === hostPid` before the
   macOS OS mapping, so a client claiming the host's pid skips the check. The shortcut moves after the OS mapping on
   macOS (only a real peer equal to the host pid passes); the inproc owner is recognised by the owner proof the
   parallel PR #18 work adds (`RpcHelloParams.ownerProof`), not by pid. D9's note about macOS descendant refusal reads
   "after this fix".
7. **Section 2 wording** (Astra 7): the release workflow has three desktop jobs on two OSes (Windows x64, macOS arm64
   and x64), no Linux leg; Linux coverage comes only from the new verify-npm job.
8. **Env secrets with no live host** (Argon 4). When `ORGAI_SECRET_*` or `--secret-env` is present and no host is live,
   every host-backed command except `daemon start` and `app` runs in-process (never spawns a background host in the
   middle of such a session). The refusal list for a live host adds `org draft`, `team review|recommend`, `skills
   evaluate` and `usage refresh`.
9. **Long operations and the drain** (Argon 5). `mcp:authorize` holds a mutation lease only around its final commit;
   the interactive wait is tracked by the existing OAuth-flow activity source. Quiesce aborts pending OAuth flows
   (`McpService.dispose()`), repository clones and Team assistant / evaluation model calls, so Quit and handoff do not
   wait 60 s for a browser the user never finished.
10. **Secrets before other stores** (Argon 6). `McpService.persistInstall` and the proposal path store secrets before
    changing `mcp-library.json` / `projects.json` (or roll those back on a secret-write failure, as `copyFromLibrary`
    does), and `RunManager.storeProposalSecrets` no longer swallows a vault error: the card stays waiting for secrets.
11. **Terminal access choice** (Argon 7). `terminalAccessLevel` is stored explicitly with a `terminalAccessLevelChosen`
    marker, so `daemon start` asks only once; `orgai terminal-access` sets `terminalServerChosen` with
    `terminalServer`, and writes under the `<data>/run/startup.mkdir` mutex after re-checking `daemon.json` inside it.
12. **Inproc owner** (parallel PR #18 work in progress on dev: `ownerProof`). 4.2.1's "inproc always enabled and full"
    becomes: an inproc host always accepts its owner's client (owner proof) with every scope, whatever the stored
    choice; other clients of that host follow Terminal access like any host. Reconcile with that change at merge.

---

## 14. Implementation notes (wave7/standalone-cli)

Written after the build, from the code on the branch. Phases A and B are built; C (archive) and D (fuse) are not.
Deviations from this spec, each checked against the code:

1. **Package and shrinkwrap.** The package is `orgai-cli` (D1). `NPM_SHRINKWRAP=none` in release.yml and ci.yml (D10, to
   revisit), so 3.1's `npm-shrinkwrap.json` is not published; the script now defaults to no shrinkwrap and `--shrinkwrap` is the full path
   (both workflows pass it only for `NPM_SHRINKWRAP=full`; CI dry-runs it with `--shrinkwrap`). verify-npm step 1b is skipped after any failed step 1. `engines.node` is
   `>=22.19.0 <23 || >=24.5.0` (from typings and memory, unverified).
2. **Publish gate.** `publish-npm` also refuses unless the `npm-publish` environment's variable `NPM_PUBLISH_ENABLED` is
   'true' (3.4 asks only for an approval); the checklist is in CLAUDE.md.
3. **Section 2 wording (Round 6 item 7).** release.yml has three desktop build jobs on two OSes and no Linux leg; Linux is
   covered only by verify-npm.
4. **Host selection (4.1).** Instead of attaching to any live host, a command first waits out an 'inproc' host it did not start
   and that is not marked shared (`run/inproc-shared-<id>`, written by `daemon start --host inproc`), also under `--host
   daemon`, then exits 6 if it stays (Round 6 did not cover this; found in review). A dev checkout missing its build or
   electron binary is `broken`, never a fall-through. `ORGAI_SECRET_*` names are refused as `--from-env` sources.
5. **Node host and Terminal access (4.2).** `daemon restart` runs every check that can fail (`nodeHostRefusal`,
   `checkBackground`, the level question, settings readability) before the old host stops; the level answer is stored
   after the stop. A stored 'full' counts as chosen. `HostTakenError` reports a host of another kind that won the race.
   The Node host refuses a socket `settings:set` that turns Terminal access off. The log is rotated only at a start that
   finds no live host; a running host's log is not capped.
6. **Shutdown (4.3).** `quitGate.ts` is deleted; the `ShutdownCoordinator` replaces it. `will-quit` only closes the socket. The
   hard limit kills descendants from the process table (Round 6 item 5), not just tracked children. `mcp:authorize` leases only
   its commit (item 9); `draft:orgChart` keeps its lease and is aborted by quiesce.
7. **Handoff (4.4).** The first, non-forced stop keeps "no answer within 5 s is unavailable"; after a user-confirmed forced stop a
   timeout or closed connection counts as stopping. The exit poll signals every 250 ms and re-reads the start time every 30 s.
   An empty `handoffBlockers` means the run state could not be read. A host that hangs after a confirmed forced stop leaves the
   app waiting (only Quit); no upper bound is built.
8. **Vault (5).** Explicit clears throw, removals never do. An unreadable `vault.json` reports 'locked' with the I/O reason, an
   unreadable `secrets.json` refuses writes on every host. Creation keeps a private copy of the key until the commit. Retirement
   (5.5) and the app's soft-delete notice are not built; `secrets confirmDelete` exists as a channel but not as a CLI command.
   `connections:logout('litellm')` and `revokeAuth` use `clear()`. Claude's secret MCP values and the OAuth bearer leave the
   child's argv. `ORGAI_VAULT_NO_OS_KEYSTORE=1` (set by the unit runner) and the desktop's `ORGAI_MOCK=1` placeholder keep tests and e2e off
   the OS key stores; the mock inproc host uses an OS store never, a key file only.
9. **Custodians (5.3).** keychain exit codes are classified before wording and only a `security: ` line's message counts with exit
   0; a failed read-back removes the new item; macOS key files get an `ls -le` allow-entry check (deny entries accepted).
   `CustodianFactoryOptions.currentCustody` lets the factory follow the vault's recorded custody.
10. **Gate (8.4).** "OrgAI Vault" is denied after `security` and the keyring front ends, not in any word (agents must be able
    to grep the sources). Added: getopt-style `security` options, `launchctl` / `script` unwrapping, single-letter bracket globs,
    `/proc/<pid>/environ` and `ps` environment flags, `localDrivePathOf` for device and admin-share paths in definite mode.
11. **Runtimes (6).** `.js` / `.mjs` / `.cjs` are refused for `ORGAI_CLAUDE_PATH`; a POSIX `#!` wrapper or npm shim in
    `ORGAI_CODEX_PATH` with no package is used as is (the user's choice); a Windows `.cmd` / `.ps1` there is refused.
12. **Terminal row (8.2).** `shimInstaller` `otherCli` prefers an npm or archive `orgai` anywhere on PATH; the shim path counts as ours
    only while an OrgAI shim sits there.
13. **Not built.** The archive (3.2), the fuse and the app-bundled CLI retirement (9), `secrets.json` retirement, the soft-delete
    notice, a log cap for a running Node host, the certificate reader through `utilityProcess` (9.1).
14. **Unverified.** See CLAUDE.md "CLI & host", Wave 7, and ARCHITECTURE.md Risks: Windows and Linux, real key stores, the real
    registry and shrinkwrap behaviour, packaged builds, `scripts/probe-custodian.mjs` (not run), the engines floor.
15. **Review fixes (2026-11-07, PR #24 review: 8 area reviewers, each finding checked by up to three refuters).**
    Gate: the inline-code path variant is built token by token (`codeVariant`), so a cd target with a space (the macOS
    data folder) stays one word after `cd "..."`, `cd -- "..."`, `cd -L`, `cd '...'`, `cd a\ b`, `pushd` and
    `Set-Location -LiteralPath`, and a relative `vault.json` read in `python -c` / `node -e` after it is denied; the old
    whole-text split stays a variant, so the change only adds denials (K6, medium). `yarn|pnpm|bun [run] orgai` and
    `deno ... npm:orgai-cli` count as CLI runs (K7). Vault: a save while the vault is not open and `secrets.json` is
    missing drops every baseline and `lc` flag like a full reconcile's missing branch, so the next unlock no longer
    soft-deletes the other keys (K0). release.yml: later jobs check out the commit meta verified (`meta.outputs.sha`),
    not the tag again (K8); publish-npm refuses unless the `npm-publish` environment has a required reviewer, read from
    the API with `actions: read`, fail closed (K9, unverified live). `findOrgaiOnPath` skips files without an execute bit
    off Windows (K4); `orgai terminal-access` renames with the win32 retry and removes its temp file on failure (K5).
    Open, low: a DPAPI / keychain 'denied' on open shows the generic missing-key text with no retry (K1, as 5.4 says);
    connection discovery is not quiesced before release (K2, pre-existing); a failed forced handoff connect ends the
    handoff (K3). Unit-tested only.
