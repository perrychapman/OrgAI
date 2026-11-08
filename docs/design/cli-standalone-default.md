# `orgai` as its own app: design spec

Status: draft 5, 2026-11-08. The owner's direction (2026-11-08): "mirror Claude Code and Claude Desktop... they should
have nothing shared"; no runs behind the scenes; no answering from a second terminal; the desktop app offers to
download the standalone CLI, the way Cursor or opencode do, without bundling it. Draft 4 was reviewed by GPT Astra
(14 findings, REVISE); draft 5 resolves each (section 11). Owner decisions taken on 2026-11-08: remove the daemon,
one `orgai` at a time, install button in the app. Draft 3's phase 1 (commit 9510c586, not pushed) is the starting
point.

Every fact says how it was checked: "code" = read from the repo at 9510c586, "measured" = observed on the owner's Mac
on 2026-11-07, "unverified" = from memory, docs or typings, not checked here.

---

## 1. The model

Two products that come from one repository:

| | OrgAI desktop app | `orgai` CLI |
|---|---|---|
| Installed by | the app installer | `npm i -g orgai-cli`, or the app's Install button (5.3) |
| Data (projects, runs, connections, settings, secrets, skills and MCP libraries, logs) | `<app data>/OrgAI` (unchanged) | `<app data>/orgai-cli` (3.1) |
| Data folder override | `ORGAI_DATA_DIR` (unchanged) | `ORGAI_CLI_DATA_DIR`, `--data-dir` (3.1) |
| Vault key custody | `OrgAI Vault` keychain service, `ORGAI_VAULT_*` (unchanged) | `OrgAI CLI Vault`, `ORGAI_CLI_VAULT_*` (3.2) |
| Host | the app process, no listening socket (5.1) | the `orgai` process itself (4) |
| Approvals | the app window | the terminal running `orgai` |
| After quitting | runs end, continuable (unchanged) | runs end, continuable |

Shared on purpose, as Claude Code and Claude Desktop share them:

- The user's repositories and their files (`.orgai/` project files, `CLAUDE.md`, `AGENTS.md`), git and its locks, and
  OrgAI's repository lock `<commonDir>/orgai-repo.lock`, which guards git operations across any two processes
  (`repoLock.ts`, code).
- The Claude agent's own login (`~/.claude`; both products run the Claude Agent SDK as the user, code).
- Third-party configuration both products may **read** to offer imports: home-directory skills, Claude plugins,
  `~/.claude.json`, Cursor, Claude Desktop and Codex MCP configuration (`capabilities/paths.ts`, code). Each product
  imports into its own library under its own data folder (unchanged, code); neither writes those sources.

Not shared: everything under either data folder, including the Codex login: Codex runs with `CODEX_HOME` =
`<dataDir>/codex` (`codexAppServer.ts`, `connections/service.ts`, code), so the CLI has its own Codex sign-in
(`orgai connections login <id>`, code).

## 2. Goals and non-goals

Goals:

- G1. `orgai` never connects to, starts, reads or writes the desktop app's data, sockets, settings or vault.
- G2. `orgai` hosts its runs in its own process; quitting ends them (the quit confirm, continuable later). There is
  no background host.
- G3. The terminal running `orgai` answers every approval and question; no other process can.
- G4. One `orgai` host process per CLI data folder. Another command that needs a host is refused at once (4.2);
  read-only commands keep working beside it (4.3).
- G5. The app does not contain the CLI; it offers to install the standalone package and cleans up the old shim.
- G6. Nothing the owner already has is lost.

Non-goals:

- Parallel independent sessions like Claude Code (several processes writing one data folder; the stores assume one
  writer, cli-spec 3.2, code). Recorded as a possible later project.
- Import or sync between the two products.
- The RunAsNode fuse: the app's system-certificate reader still runs the app binary as Node
  (`systemCerts.ts`, code), so the fuse stays on.

## 3. Separation

### 3.1 Data folder and product identity

- CLI default `userDataDir`: macOS `~/Library/Application Support/orgai-cli`, Windows `%APPDATA%\orgai-cli`, Linux
  `${XDG_CONFIG_HOME:-~/.config}/orgai-cli`; data dir `<userDataDir>/data` as today (`locate.ts`, code). Not `orgai`
  (on a case-insensitive file system that is the app's `OrgAI`), not `~/.orgai` (every project's own folder name).
- CLI overrides: `--data-dir`, then `ORGAI_CLI_DATA_DIR`. The CLI ignores `ORGAI_DATA_DIR`; when it is set and no CLI
  override is, `orgai` prints once per process: "ORGAI_DATA_DIR is the OrgAI app's setting; orgai uses
  ORGAI_CLI_DATA_DIR." The desktop app keeps `ORGAI_DATA_DIR` (`log.ts`, `index.ts`, code) and ignores the CLI's.
- Product marker: `<userDataDir>/product.json` `{ "product": "orgai-cli" | "orgai-desktop", "version": 1 }`, written
  0600 by whichever product creates or first opens the folder after this change.
  - The CLI refuses (exit 2, before any read or write beyond the marker) a folder whose marker says
    `orgai-desktop`, a folder whose canonical path (realpath of the folder and of its parent) equals the desktop's
    default `userDataDir`, and a folder without a marker that already holds data (`data/` non-empty): "<path> belongs
    to the OrgAI app. orgai keeps its own data; choose another folder." An empty or missing folder gets the CLI
    marker.
  - The desktop app refuses a folder marked `orgai-cli` with a dialog naming it and quits; a folder without a marker
    (every existing install) gets the desktop marker on first start.
- Every e2e and test that sets a data folder for the CLI uses `ORGAI_CLI_DATA_DIR` or `--data-dir` with a fresh temp
  folder (`e2e/cliLib.mjs`, code: e2e already uses temp folders).

### 3.2 Vault custody

The vault code is shared (`src/main/store`, code); its custody becomes product-scoped:

- `openSecretStore` takes `product: 'cli' | 'desktop'`. CLI: keychain service `OrgAI CLI Vault`, Secret Service
  attributes `service orgai-cli vault <vaultId>`, label `OrgAI CLI vault`, DPAPI entropy label and key-file variable
  `ORGAI_CLI_VAULT_KEY_FILE` (and every other `ORGAI_VAULT_*` read by the CLI becomes `ORGAI_CLI_VAULT_*`). Desktop:
  unchanged names, so existing desktop vaults keep opening.
- The CLI never reads `ORGAI_VAULT_*`; the app never reads `ORGAI_CLI_VAULT_*`.
- `childEnv.ts` scrubs both families from every agent child (code: it scrubs `ORGAI_VAULT_*` today).
- Tests: a reset or key rotation in either product leaves the other's vault and key item untouched; a key file named
  by one product's variable is never used by the other.

### 3.3 Messages that assumed one shared vault

`VAULT_MESSAGES.pendingLegacy`, `clearRefusedLegacyOnly` and the renderer's recovery notices (`vaultTypes.ts`,
`secretNotices.ts`, code) tell a CLI user to open the app. In the CLI there is no legacy `secrets.json` from the app
(a fresh folder), so those states cannot arise there; the CLI's texts drop the app references, the desktop's keep
their own recovery actions.

## 4. CLI

### 4.1 One host kind

- `--host` and `--secret-env`'s host condition go; every command that needs a host runs `inprocHost` in its own
  process (today's `--host inproc`, code). Environment secrets (`ORGAI_SECRET_*`, `--secret-env`) keep working
  in-process.
- Removed modules: `nodeHost.ts` and `daemon run-node`, `sharedHost.ts`, `terminalAccessSettings.ts`, the launcher's
  app discovery and spawn (`launcher.ts` `locate`, `spawn`, `startBackground`, `waitForReady`, `waitForGone`), and the
  draft-3 additions `shareInproc` / `shareHost` / `decisionNotices.ts`. What `inprocHost` and the hostless reader need
  stays.
- The socket of an in-process host accepts only its owner: a hello without a valid memory-only `ownerProof` is refused
  before any method runs (`not_owner`), whatever `terminalServer` / `terminalAccessLevel` say, even when
  `daemon.secret` is readable and the claimed pid or client kind is forged. The peer check stays as defence in depth.

### 4.2 A second host process: refused at once

Ownership (`src/main/host/ownership.ts`, code) is an atomic startup mutex followed by an incumbent check with start
time, endpoint reachability and unreadable-record handling, and today waits (up to 30 s for a starting owner, plus a
young-record wait). New: `acquireOwnership(..., { wait: 'none' })` for the CLI.

- The decision stays under the mutex; nothing before it is a lock.
- Live incumbent (by the existing liveness rules), a starting owner, a draining owner, or an unreadable record that is
  not provably stale: release the mutex and fail with `owned` and the record (pid, `ownerCwd` when present).
- A provably stale record (dead pid, or differing start time): reclaim as today.
- `daemon.json` gains `ownerCwd` (the owning process's cwd at boot), written by the CLI; absent for older records.
- `ensureHost` maps `owned` to exit 6: "orgai is already running in another terminal (<ownerCwd>, pid <pid>). Use that
  one, or quit it first." Without `ownerCwd`: "orgai is already running (pid <pid>)...". No waiting.
- Tests: two processes starting at once (exactly one wins, the other gets exit 6 at once), pid reuse (differing start
  time is stale), a corrupt record, a crash between mutex and record, release racing a new start.

### 4.3 Command matrix

| Command | After this change |
|---|---|
| `orgai` / `tui [run]` / `resume` / `exec` / `init` and every management command (org, team, worktrees, permissions, connections, models, mcp, skills, knowledge, notes, kit, projects create/edit, secrets init/reset/undelete) | In-process host; refused (4.2) while another `orgai` owns the folder |
| `status`, `runs` (list, show), `projects` (list, show), `usage` (show), `secrets status`, `doctor`, `completions`, `--version`, `help` | Hostless reader from the files when another `orgai` owns the folder, with "orgai is running in another terminal; this is a saved snapshot" (no live cards). With no owner they may start a host as today or read files; either way no write. |
| `watch`, `inbox`, `decide`, `runs message|interrupt|stop`, `attach` | Removed: live runs and their cards exist only inside the owning `orgai`, which has the same actions in its TUI. `orgai tui <run>` opens a saved run. |
| `daemon`, `app`, `terminal-access` | Removed |
| `exec` decision policies | `wait` policies (`--on-permission wait` and the other `wait` values, `decisionPolicy.ts`, code) are refused (exit 2): nothing else can answer. `deny`, `fail`, `allow*` and the headless defaults stay. |

The hostless path of each read-only command is chosen before any connect, so a `not_owner` / `owned` answer never
reaches its fallback (`runRef.ts` today falls back only for listed reasons, code). Tests: each read-only command runs
beside a live owner without a socket hello, store construction, migration or write.

### 4.4 TUI

- The TUI always holds every scope (owner proof). Gone: the version-skew notice, `TUI_NO_DECIDE_NOTICE`, the desktop
  and host-kind decision lines, `DESKTOP_UNAVAILABLE_NOTICE`, read-only cards.
- The quit confirm keeps counting host-wide live runs (draft 3) on every quit path, including onboarding.
- First start of a new CLI data folder prints once (CLI-local, never reads the app's folder): "orgai keeps its own
  projects and settings, separate from the OrgAI app. Projects made with an older orgai are in the OrgAI app."

### 4.5 Help, doctor, completions

`orgai help`, the command table, completions and doctor drop removed commands, `--host` and background-host checks;
doctor reports the data folder, its marker, the vault custody and "another orgai is running (pid, folder)" when owned.

### 4.6 Exec outcomes, exit codes and policies (kept from cli-spec.md)

`cli-spec.md` and `cli-standalone.md` are left out of the self-help corpus whole, not by section (decided in phase 1:
splitting them by heading would keep stale `--host` / daemon text next to the valid parts). What is still true of them
lives here and in the command table (`orgai help exec`, `orgai help tui`, `orgai help secrets`).

- Exit codes: 0 ok, 1 failure, 2 usage, 3 needs the user, 4 usage limit, 5 authentication, 6 another `orgai` owns the
  folder, 130 SIGINT, 143 SIGTERM.
- `orgai exec` exit by outcome: `completed` and `completed-unplanned` 0; `unmerged-conflicts`, `blocked`,
  `incomplete-plan`, `needs-decision`, `budget-exceeded` 3; `rate-limited` 4; `auth-error` 5; `failed` and `stalled` 1;
  `interrupted` 130.
- Decision policies (`--on-permission`, `--on-rules`, `--on-mcp-install`, `--on-question`, `--on-proposal`, `--on-merge`):
  deny / decline / hold / conservative answer or fail the run. `wait` is refused by the exec flags and turned into `fail`
  by the in-process host for any other path, because nothing else can answer a card of an `orgai` run.
- The TUI (`orgai`, `orgai tui [run]`, `orgai resume`) answers cards itself; its status lines say "Resolved by ..." for
  the headless policy or the terminal UI, never "another window".
- Secrets: `orgai secrets status|init|reset|undelete|keep-removed`, never a value as an argument (`--from-env`,
  `--stdin`); the CLI's vault key is its own (3.2).

## 5. Desktop app

### 5.1 No terminals, no socket

- The app acquires ownership with `listen: false` (supported today, `index.ts`, code) and never creates the socket
  server. Second instances keep Electron's `requestSingleInstanceLock` / `second-instance` (code). Gone: the
  `--headless-host` mode and lifecycle (`args.ts`, `hostLifecycle.ts`), handoff (`handoff.ts`, `DesktopHandoff`,
  `waitingForHandoff`), `desktopQuit.ts` parts that only serve socket clients, the socket's terminal sessions in
  `ShutdownCoordinator` inputs for the desktop, Terminal access settings (`terminalServer`, `terminalServerChosen`,
  `terminalAccessLevel`, `terminalAccessLevelChosen`) and their rows.
- Settings files with those keys keep loading; the keys are dropped on read and on the next write
  (`src/main/store/settings.ts`, shared `AppSettings` in `src/shared/types.ts`).
- Shared host code (`bootstrap.ts`, `socketServer.ts`, `shutdown.ts`) keeps what the CLI's in-process host needs.

### 5.2 The packaged app does not contain the CLI

- `electron-builder.yml`: `files` excludes `out/cli/**` (not only `asarUnpack`), the `bin/orgai` launchers and their
  `extraResources` go. The desktop's own runtime dependencies (Claude Agent SDK, Codex, native modules) stay.
- `scripts/verify-pack.mjs`: drops (c)-(g) (app-bundled CLI and CLI-spawns-app); adds "no `out/cli` in app.asar or
  app.asar.unpacked, no `bin/orgai`", keeps the check that the desktop's runtime packages (Claude Agent SDK, Codex, zod)
  are unpacked, and adds a token-free boot of the packed app (temp `ORGAI_DATA_DIR`, `ORGAI_MOCK=1`,
  `ORGAI_WINDOW_HIDDEN=1`: `daemon.json` `ready`, `main.log` written, clean quit). The certificate reader child and the
  Claude and Codex binaries are exercised only as far as that ordinary boot reaches them; they have no check of their own.
- `scripts/verify-npm.mjs` (phase 1): calls without `--host`, its shared helpers move out of `verify-pack.mjs` into a
  small module both import; adds "a fresh install writes `orgai-cli/product.json`" and "`ORGAI_DATA_DIR` is ignored".

### 5.3 Install the orgai command

App settings > Terminal: one row, replacing `CliShimRow`.

- Status without running anything: the existing metadata classification (`orgaiOnPath.ts`, code: inspects files,
  never executes) extended to recognise an npm-installed `orgai-cli` (its `package.json` beside the resolved bin) and
  the old app shim. Shows "Installed (npm, <version from package.json>)", "Old OrgAI app command (no longer works)",
  "Another program named orgai", or "Not installed".
- Install: main-process only, one at a time, cancellable. Resolves `npm` to an absolute path from the resolved PATH
  (no PATH lookup by the child), cwd = the user's home, environment = the resolved login environment minus every
  `ORGAI_*`, `ANTHROPIC_*`, `OPENAI_*`, `CLAUDE_*`, `CODEX_*`, `AWS_*`, `GOOGLE_*`, `AZURE_*` variable (the user's
  npm config and registry stay, so corporate registries work). Arguments are fixed: `install -g orgai-cli@<tag>
  --ignore-scripts` where `<tag>` is `latest` for a stable app and `next` for a prerelease (`release.yml`, code). On
  Windows `npm.cmd` runs through `cmd.exe /d /s /c` with that fixed, quoted argument list; nothing from the user or
  the network reaches the command line. Output: last 200 lines, 64 KB cap, control characters stripped, shown as
  text. Never elevated; EACCES shows npm's message and the `--prefix` hint.
- Copy command: the same `npm install -g orgai-cli@<tag>` string.
- No version pin and no release gate: the CLI updates through npm on its own schedule; an E404 or offline failure
  shows npm's message.
- Old shim cleanup: when the classification finds the app's old shim, the row offers "Remove the old orgai command"
  (and offers it automatically after a successful install), using the existing ownership-checked removal
  (`shimInstaller.ts` uninstall path, code), re-checking ownership right before removal, never touching a foreign
  file, then re-classifying to show which `orgai` now wins on PATH. The install half of `shimInstaller.ts` goes.

## 6. Help and self-knowledge

Updated in the phase that changes the behaviour, not later:

- The runtime reference corpus (`appReference.ts`, `reference/docs.ts`, code) excludes withdrawn and superseded
  designs (`cli-approvals.md`, `cli-spec.md` and `cli-standalone.md`, whole files: phase 1 chose whole-file exclusion over
  filtering by heading); the CLI command table it embeds comes from the new command table, and 4.6 keeps the still-valid
  exec, exit code, policy and TUI facts.
- In-app text about Terminal access, `orgai daemon`, `orgai app` or a shared vault is removed or rewritten.
- Desktop recovery actions for its own vault stay.

## 7. Security

- No process but the owner can talk to a CLI host (4.1); the app has no socket (5.1). Terminal access, scope caps,
  pairing and cli-approvals.md E1-E3 are withdrawn.
- Owner proof stays the only route to `decide` / `configure`. The peer check refusing host descendants and the
  self-control gate (agents may not run `orgai`) stay.
- Separate custody names and variables (3.2) prevent key reuse between products; markers (3.1) prevent either product
  from opening the other's folder.
- Installer (5.3): no execution of unknown PATH programs; fixed argv; scrubbed environment; `--ignore-scripts`.

## 8. Tests and checks

- Unit: `locate.test.ts` (defaults, `ORGAI_CLI_DATA_DIR`, `ORGAI_DATA_DIR` ignored), marker rules (both products,
  aliases via symlink, non-empty unmarked folder), vault custody per product, ownership `wait: 'none'` (4.2 list),
  socket owner-only (4.1 list), command matrix (4.3), exec `wait` policy refusal, settings key drop, installer
  (classification, hostile PATH entry, path with spaces, `.cmd` on Windows simulated, env scrub, output cap, cancel),
  shim cleanup.
- Removed with their code: `daemonNodeHost.int`, `nodeHost.int`, `handoff.int`, `hostSelection.int`, `hostStop.int`
  parts, shim install tests, `e2e/cli-host.mjs`, daemon steps in `cli-readonly.mjs`.
- e2e (in-process only): `cli-exec`, `cli-tui` (a second `orgai` is refused at once; read-only commands work beside
  it), `cli-connections`, `cli-mcp`, `cli-skills-kit`, `cli-org`, `cli-projects`, `cli-readonly`.
- New e2e `separation.mjs`: the desktop app (hidden windows) on temp folder A and `orgai` on temp folder B at the same
  time; proves separate settings, runs, approvals, secrets (vault custody names), libraries, logs; the CLI refuses A,
  the app refuses B; quitting one leaves the other running.
- New e2e `install-row.mjs`: the Terminal row's states with a fake npm on PATH (no network).
- `package.json` `e2e:free`, CLAUDE.md's e2e list and `.github/workflows/ci.yml` updated in the same change.

## 9. Phases

Each phase passes the local gate (typecheck, the whole unit suite, build, `npm run test:scripts`, the e2e scripts of
its area, review) before the next.

1. **CLI separation**: 3.1 (CLI side), 3.2, 3.3 (CLI side), 4, verify-npm (5.2 last bullet), help and doctor (4.5),
   CLI parts of 6.
2. **App separation**: 3.1 (desktop side), 3.3 (desktop side), 5.1, 5.2, app parts of 6, `separation.mjs`.
3. **Install row**: 5.3, `install-row.mjs`.
4. **Docs**: CLAUDE.md (CLI & host notes, e2e list), `docs/agent-notes/cli-host.md` is the owner's uncommitted move and
   is left to them (CLAUDE.md on dev is updated), superseded notes in `cli-spec.md` and `cli-standalone.md`,
   `cli-approvals.md` marked withdrawn, `.orgai/ARCHITECTURE.md`.

## 10. Unverified

- Windows: `npm.cmd` through `cmd.exe` with the fixed list; `orgaiOnPath` recognising an npm global bin; DPAPI label
  change. CI on windows-latest is the first check.
- Linux Secret Service attribute change on a real keyring.
- That every connection kind works on a fresh CLI folder (Claude via the user's login expected; Codex needs its own
  `orgai connections login`).

## 11. Draft 4 review resolutions (GPT Astra)

| Finding | Resolution |
|---|---|
| 1 overrides reach the app's folder | 3.1: `ORGAI_CLI_DATA_DIR`, `ORGAI_DATA_DIR` ignored, product markers, canonical-path check; migration notice is CLI-local (4.4) |
| 2 shared vault key variables | 3.2 product-scoped custody names and variables, scrubbed from children |
| 3 pid check is not a lock | 4.2 `wait: 'none'` inside the ownership mutex, test list |
| 4 read-only commands start hosts | 4.3 matrix; hostless path chosen before connect |
| 5 attach-only commands and wait policies | 4.3 removes them; `wait` policies refused |
| 6 desktop socket claim wrong | 5.1 `listen: false`, no socket server; second instances via Electron |
| 7 installer runs PATH programs | 5.3 metadata only; fixed argv, absolute npm, scrubbed env, Windows cmd rule, output cap |
| 8 old shims break | 5.3 ownership-checked cleanup, re-classification |
| 9 verify-npm uses `--host` | 5.2: phase 1 updates verify-npm, phase 2 excludes `out/cli` from `files` |
| 10 version availability | 5.3 dist-tag by channel, no pin, Copy and Install identical |
| 11 RunAsNode citation | 2: `systemCerts.ts` |
| 12 Codex login, `init` | 1: Codex has its own login per product; `connections login`; `init` not cited for secrets |
| 13 third-party sources | 1: read-only shared inputs, own libraries |
| 14 help corpus | 6, updated per phase; `separation.mjs` two-product e2e |
