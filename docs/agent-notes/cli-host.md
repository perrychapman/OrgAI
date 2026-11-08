# CLI and host

Waves 0-7: host ownership, dispatcher, socket server, self-control gate, exec, TUI, packaged and standalone CLI, vault, shutdown and handoff, repository lock. Moved out of CLAUDE.md on 2026-11-07; see CLAUDE.md for the index.

- CLI & host (docs/design/cli-spec.md; Waves 0-5 landed: the socket server, `--headless-host` / `--host inproc` hosts, the
  self-control gate, the read-only `orgai` CLI, headless exec, the terminal UI and the management commands; see the
  spec's "Implementation status" for deviations and what is unverified):
  - Wave 7 (standalone `orgai`; docs/design/cli-standalone.md, its section 13 Round 6 is binding; cli-spec.md "Implementation
    status, Wave 7"; merged to dev via PR #24, 2026-11-07). Verified on macOS by unit tests, real
    in-process / Node host integration tests and a few e2e scripts; nothing ran on Windows or Linux, against a real OS key
    store, the real npm registry or a packaged build (see Unverified at the end of this bullet).
  - Package and channel: npm package `orgai-cli` (bin `orgai`; owner decision D1 2026-11-06, npm refused `orgai`), built by
    `scripts/build-npm-package.mjs` (`--dry-run`, `--shrinkwrap` (default: none); pure parts in `scripts/lib/npmPackage.mjs`) into
    `release/npm/package` + `orgai-<v>.tgz` from `out/cli` plus `out/cli/install.json` (`{ channel: 'npm'|'app'|'archive',
    version, commit }`, written and removed by `scripts/write-install-info.mjs`; `withInstallInfoCleanup` removes it after
    electron-builder, also on SIGINT / SIGTERM / SIGHUP, not SIGKILL; absent = 'dev'; a file that is present but invalid
    reads as 'dev' with `source: 'invalid'` and is never treated as a checkout; `src/cli/installInfo.ts`, `--version` and
    doctor print it). Dependencies are pinned exactly; `engines.node` is `>=22.19.0 <23 || >=24.5.0` (from the typings and
    memory of the Node changelog, UNVERIFIED); no lifecycle scripts in our package, and `scripts/npm-install-scripts-allowlist.json`
    lists the install scripts verify-npm tolerates in the tree. Owner decision D10 (2026-11-06, to revisit):
    `NPM_SHRINKWRAP=none` in release.yml and ci.yml (no `npm-shrinkwrap.json`); with npm 11.12.1 a honoured shrinkwrap
    installed every platform's Claude runtime (about 2 GB, which makes verify-npm step 1 fail), `none` installs about 300 MB. `full` stays behind that one setting
    and CI always dry-runs the full derivation. release.yml: `npm-package` -> `verify-npm` (macos-15, windows-latest,
    ubuntu-latest x Node at the engines floor and 24; `scripts/verify-npm.mjs` implements spec 3.4 steps 1-7: step 1b
    `--ignore-scripts` is skipped after a failed step 1; step 6 is the vault flow with a key file and a local fake LiteLLM
    proxy, run on the built bundle by `cli/vaultCli.int.test.ts`) -> `publish-npm` (needs meta, build, npm-package and
    verify-npm; environment `npm-publish`, OIDC with `--provenance`, `--tag next` for prereleases, sha256-compares the
    verified tarball, refuses unless the environment variable `NPM_PUBLISH_ENABLED` is 'true'). Release checklist: in
    Settings > Environments > npm-publish add required reviewers, limit deployment branches and tags to the tag pattern `v*` (publish runs on a tag ref; the meta job already checks the commit is on main), set
    `NPM_PUBLISH_ENABLED=true` there (never at repository or organisation level); add the `NPM_TOKEN` secret for the first
    publish (D2 fallback). release.yml has three desktop build jobs on two OSes (Windows x64, macOS arm64, macOS x64) and
    no Linux leg: Linux is covered only by verify-npm. `pack:verify` checks (f) and (g) now also require `daemon status` to
    report a running 'headless-host' and `daemon stop` to answer `stopped: true` ((g) is the only check that the npm CLI
    drives the packaged app). The RunAsNode fuse is NOT changed (phase D not built); the app-bundled CLI is not retired.
  - Host selection (`src/cli/client/ensureHost.ts`, `launcher.ts`, `sharedHost.ts`): `--host auto` falls back to an
    in-process host (one stderr line) when `HostLauncher.resolve()` finds no app (`absent`); a found-but-missing binary is
    `broken` and an error naming the path, as is a dev checkout (both markers) without `out/main/index.js` or its electron
    binary. Installed-app discovery: `/Applications/OrgAI.app`, `~/Applications`, NSIS per-user / per-machine paths; Linux none. `--host daemon` never runs a
    host in-process: with none live it starts the app, else a Node host (`BACKGROUND_HOST_KINDS` desktop, headless-host,
    node). Step 0 (review): under auto and daemon an 'inproc' host that is neither the context's own nor shared is never
    used: the command prints `OTHER_COMMAND_HOST_NOTE`, waits (`waitForGone`, `HOST_STARTING_WAIT_MS` 15 s total, at most 5
    rounds) and then exits 6 (`OTHER_COMMAND_HOST_MESSAGE`) if it stays. A shared host is one started by `orgai daemon start
    --host inproc` (also `--foreground`), told apart by the marker `<data>/run/inproc-shared-<hostInstanceId>` (0600, pid;
    written after ownership, removed on cleanup, stale ones swept by a new shared host); tests and e2e that hand-start a
    host for other contexts must pass `shared: true`. A host started by an older CLI has no marker and is waited out
    (accepted). `ORGAI_SECRET_*` / `--secret-env` rules follow spec 4.1 (Round 6 item 8); `ORGAI_SECRET_*` names are refused as
    `--from-env` / `--client-secret-from-env` / `decide --secret` sources (exit 2).
  - Node host (`HostKind 'node'`, `src/cli/nodeHost.ts`, hidden `daemon run-node`): `orgai daemon start [--runtime app|node]`
    spawns `process.execPath <orgai.mjs> daemon run-node` detached (stdio to `<userData>/logs/node-host.log`, rotated to
    `node-host.old.log` above 5 MB only by a start that finds no live host; a running host's log is not capped, open
    Low); refused on the app-bundled CLI (Electron execPath). `HostLauncher.checkBackground('node')` and the Terminal-access
    level question run before anything is stored or stopped (`daemon restart` also does `nodeHostRefusal` and
    `assertSettingsWritable` before the old host stops; the answer is stored after the stop, a failed write then warns and
    starts with the stored level). `waitForReady` rejects with `HostTakenError` when the spawned host handed off to a ready
    host of another kind (exit 0 without `--runtime`, 1 with an explicit other kind). Terminal access: `orgai terminal-access
    [on|off] [--level full|operate]` runs in-process, only when no host owns the folder, writes `terminalServer`,
    `terminalServerChosen`, `terminalAccessLevel` and `terminalAccessLevelChosen` under `<data>/run/startup.mkdir` after
    re-checking `daemon.json`; a live process starting past the wait gives exit 6 with `hostStartingMessage`. `daemon start`
    refuses a Node host when the stored choice is off. The level question ("... [full/operate] (Enter keeps <stored>)") is
    asked once on a terminal; a stored 'full' without the marker counts as chosen. A Node host refuses a socket `settings:set`
    with `terminalServer` false while it is stored on (`NODE_TERMINAL_ACCESS_OFF_REFUSED`, `turnsNodeTerminalAccessOff`). Default level
    `operate` (D9). `registry.ts` uses `canOpenWindows` (false for inproc and node). Unit-tested; `nodeHost.int.test.ts` and
    `daemonNodeHost.int.test.ts` spawn a real Node host on macOS (skip on Windows; the two bundle tests run again after the
    build in ci.yml with `ORGAI_REQUIRE_NODE_HOST_INT=1`).
  - Shutdown and handoff (`src/main/host/shutdown.ts` `ShutdownCoordinator`; `quitGate.ts` is deleted): every exit path
    (host.stop, the app's handoff stop, desktop Quit through `desktopQuit.ts` `beforeQuitHandler` which holds before-quit,
    the last window on Windows / Linux, headless and Node idle exit, signals via `installShutdownSignals`, inproc cleanup)
    runs: drain (state 'draining', mutations refused `host_draining`, quiesce, `RunManager.stopAll({ reason: 'quit' })` for at
    most 3 s then `markQuit`, when forced or any run is live), `settleWriters` (no deadline of its own), `onDrained` from
    setImmediate (the host.stop reply is queued first), `HostSocketServer.closeGracefully` (`SOCKET_CLOSE_GRACE_MS` 2 s),
    `ownership.release()`, exit; will-quit only closes the socket. At `SHUTDOWN_HARD_LIMIT_MS` (60 s) `killHostDescendants`
    reads the process table (POSIX `ps`, Windows CIM `Win32_Process`), SIGTERM / `taskkill /PID`, `KILL_TERM_GRACE_MS` 5 s,
    SIGKILL / `/F`, then 1 s steps up to `KILL_WAIT_MS` 60 s, then `exitAtHardLimit`; the desktop's own Electron helpers and
    the coordinator's own helper processes (and anything under them; Windows rows older than their claimed parent) are never
    targets. `HostDispatcher.invoke` leases every mutating channel and ipc.ts wraps every mutating desktop-only channel the
    same way (`ipcLeases.test.ts`); `mcp:authorize` leases only its final commit (`COMMIT_LEASED_CHANNELS`); quiesce aborts OAuth
    flows (`McpService.dispose`), repository clones, Team assistant / evaluation model calls and `draft:orgChart`
    (`draftOrgChart` takes an AbortSignal). Handoff (`src/main/handoff.ts` `DesktopHandoff`, `index.ts` `waitingForHandoff`): an
    interactive launch whose folder a Node host owns sends `host.stop({ force: false, handoff: true })` over a 'desktop'
    connection (D8: `host.status` / `host.stop` only, whatever Terminal access is); the wait window shows after
    `HANDOFF_WINDOW_DELAY_MS` (1 s), lists `handoffBlockers` / `refusedBecause` and offers "Open when they finish" (retry 5 s),
    "Stop them and open" (forced; once sent, a timeout or closed connection counts as stopping) and Quit; empty blockers means the
    host could not read its run state (fails closed). An inproc owner is never stopped ("Open when it ends" / Quit). The app takes
    the folder only after the owner process exited (`ownerExitCheck`: signal probe per 250 ms poll, start time re-read every
    `HANDOFF_START_TIME_RECHECK_MS` 30 s); no answer or an owner older than Wave 7 shows the busy-folder dialog with the
    `orgai daemon stop --force` hint and exits 6; a headless launch never hands over. `orgai app` with a node / inproc owner
    returns 0 with `HANDOFF_OPENED_MESSAGE`. Peer check (`peerCheck.ts`): the self-pid shortcut now follows the macOS OS mapping
    (Round 6 item 6). Unit tests, real owner-process integration tests (`shutdown.int`, `handoff.int`, `inprocShutdown.int`) on macOS;
    the desktop Quit through a real Electron before-quit and the window parts are not driven.
  - Vault (`src/main/store/`: `secrets.ts` `SecretStore`, `vaultTypes.ts`, `vaultCrypto.ts`, `vaultFile.ts`, `vaultMetadata.ts`,
    `reconcile.ts`, `durableFs.ts`, `unavailableCustodian.ts`, tests `vaultStore.fixture.ts`): `<data>/vault.json`
    (`orgai.vault/1`, AES-256-GCM, one data key per folder, AAD binds format, vault id and key; `check` record; tombstones;
    `legacy` baseline; `legacyRetired`) is written by every host kind; the app keeps `secrets.json` (safeStorage) in step during
    the dual-write window and reconciles it by the spec 5.5 rules (an older app keeps working; disappearances are soft
    deletes; retirement is NOT built, `legacyRetired` is only read). States absent / open / locked / missing-key / key-mismatch /
    corrupt; an unreadable `vault.json` follows the corrupt rules but reports 'locked' with the I/O reason, an unreadable
    `secrets.json` refuses value writes on every host. `openSecretStore` runs after `acquireHostOwnership` and before
    `bootOrgAIHost` and uses the real custodians by default (`createCustodianFactory`); the desktop under `ORGAI_MOCK=1` passes
    `unavailableCustodianFactory` so e2e never writes an OS key item, and the unit runner sets `ORGAI_VAULT_NO_OS_KEYSTORE=1`
    (vitest.config.ts); tests must inject a fake custodian or a key file in a temp folder, never the OS schemes. Node and inproc
    hosts create the vault lazily in `prepareWrite()` (single-flight); `HostDispatcher.invokeRpc` awaits it when the channel's
    `storesSecret` predicate (`host/storesSecret.ts`) is true; `set()` with a value on an absent vault throws `VaultNotReady` (a
    bug trap). `set(key, null|'')` and `clear(key)` are explicit clears and throw the store's sentence when refused (corrupt,
    recovery pending, `secretClearFailedMessage`, `notDurable`); `delete()` / `deletePrefix()` are removals that never throw
    and leave keys they cannot handle (counted orphaned); `connectors:setToken` null, `connections:logout('litellm')` and `revokeAuth` call `clear()`
    (a failed save throws and the record is not changed, integration review). Approved MCP proposals use one slot rule (`mcp/proposalSecrets.ts`
    `proposalTypedSlots`); secrets are stored before any record changes (`storeFirst`, `commitOAuth`) and rolled back with
    `status()` priors (a key unreadable before keeps the new value, warning logged); `ProposalSecretsNotSaved` keeps the card open. Integration review fixes: on the Claude adapter secret MCP env values, secret headers and the OAuth bearer leave the `claude` child's argv
    (placeholders in `--mcp-config`, real values in `options.env`; `setMcpServers` keeps real values as a control message); host git
    no longer inherits `ORGAI_SECRET_*` / `ORGAI_VAULT_*`; the mock inproc host never uses an OS key store without a key file (e2e
    `cliLib` names a throwaway one); an inproc host has no idle exit.
    `secrets:reset` refuses while a predicate-prepared write, a sign-in or a refresh is in flight (`setResetBusyCheck`).
    Failures repeat in the log at most once per `VAULT_REPEAT_LOG_MS` (24 h). `SecretsStatusResult.readError` carries the
    I/O sentence. ConnectionService says "The LiteLLM API key cannot be read here: <reason>." for an unreadable key. Channels
    `secrets:status` (read), `secrets:init`, `secrets:reset`, `secrets:undelete`, `secrets:confirmDelete` (configure); CLI
    `orgai secrets status [--probe] | init [--key-file <path> [--import]] | reset --yes | undelete <key>` (no value ever
    printed; no `confirm-delete` command, the app notice is not built so removed secrets are listed by doctor / status),
    `connections set-secret`, `mcp set-secret` and `mcp authorize` work on Node and inproc hosts. Unit tests with fault
    injection at every write boundary, `secretChannelsReal` (real store + key-file custodian), `vaultCli.int`, `doctorVault.int`.
  - Custodians (`src/main/store/custodians/`, child processes only, absolute binaries, `shell: false`, tmpdir cwd, 10 s timeout,
    per-scheme environment allowlist, values on stdin / stdout): keychain (`/usr/bin/security -i -q`, service "OrgAI
    Vault"; exit codes are classified before wording, and with exit 0 only a `security: ` error line's message counts),
    dpapi-user (PowerShell `ProtectedData`, entropy `orgai.vault/1:<vaultId>`, Constrained Language Mode = denied),
    secret-service (`secret-tool`, needs a session bus), key-file (opt-in through `ORGAI_VAULT_KEY_FILE` or `secrets init
    --key-file`; never inside the user-data folder; created `O_EXCL|O_NOFOLLOW` 0600; Windows protected DACL through `icacls`;
    macOS `ls -le` ACL check refuses allow entries, gap: it reads the path, not the descriptor). Create reads the key back and
    removes the item on a failed or different read-back. `CustodianFactoryOptions.currentCustody` is read per call;
    `CustodianCreated.keyFile` is the canonical path. `childEnv.ts` scrubs `ORGAI_VAULT_*` from Claude, Codex and MCP children.
    The gate also denies `/proc/<pid>/environ` words and `ps` environment flags (a script reading another process's environment still gets `ORGAI_SECRET_*`). Threat model: same-user processes (agents included) can reach the key on all platforms; on macOS this weakens safeStorage's
    app-only item (D4 accepted). Fakes and fixtures only: `scripts/probe-custodian.mjs` (creates, reopens in a fresh process and
    deletes one item under a throwaway id) exists and has NOT been run (needs the owner's consent).
  - Self-control gate additions (`selfControlGate.ts`, `referenceDirectories.ts`): package runners naming `orgai-cli` / `orgai` /
    `@orgai/cli` (with `--package=`, `-p`, `npm:`, `@version`, and globs keeping 3 of the letters of "orgaicli" in order); reads of
    `<data>/vault.json*` / `secrets.json*`, the key file and any `ORGAI_VAULT_*` word; `security` read as getopt does
    (`--`, `-pX`, `-p X`) and unwrapped through `launchctl asuser|bsexec` and `script`; `secret-tool`, D-Bus tools naming
    `org.freedesktop.secrets`, PowerShell `ProtectedData` / `Unprotect`; the name "OrgAI Vault" only after `security`, `keyring`,
    `kwallet-query`, `kwalletcli`, `kwallet5-query`, `kwallet6-query` (a plain `grep -rn 'OrgAI Vault' src` passes; code runners
    still deny it anywhere, and `print('security')` is denied as a side effect); bracket globs that can match only one letter
    count as that letter (`globKeptLetters`); `localDrivePathOf` maps `\\?\C:\`, `\\.\C:\`, `//?/C:/`, `\\localhost\c$` to the
    drive path in definite (self-control) mode on win32 only (reference mode still treats every UNC word as touching). They are text
    checks, a speed bump, not a boundary. The scan-cost test checks linearity (best of 3, 2n under 3x n plus 100 ms), not a wall clock.
    Unit tests and pure-function probes only; never run in a real shell against the real tools or on Windows.
  - Agent runtimes: `runtime/claudeBinary.ts` `claudeExecutable(env)` is the one resolver (claude.ts runs, probes, completions and
    `anthropicAuth.ts`), evaluated per call: `ORGAI_CLAUDE_PATH` (absolute, existing regular file, not .cmd / .bat / .ps1 / .js /
    .mjs / .cjs; when set it decides), the app.asar.unpacked native package, the SDK per-platform package via `createRequire` from
    the bundle and then from the SDK's own folder, else `claudeRuntimeMissingMessage`. `claude auth status` runs `execFile` on
    that binary only; a `claude` on PATH or in a well-known folder is only named in the error. An apiKey connection also reports
    'error' when no runtime resolves. `runtime/codexBinary.ts` `lookupCodexBinary`: `ORGAI_CODEX_PATH` first (when set it decides; a
    POSIX `#!` wrapper that maps to no package is used as is, a Windows .cmd / .ps1 is refused), then `@openai/codex-<platform>-<arch>`,
    then a synchronous PATH walk (never the cwd). Hits are classified by content: native binaries used as is, npm shims mapped to the
    vendor binary and never spawned. `checkCodexBinary` runs `--version` (cached by realpath + mtime + size) in
    `CodexAppServer.start` and the OpenAI probe; outside 0.166.x it refuses ("Codex <v> is not supported; install
    @openai/codex@0.166.0"), except `ORGAI_CODEX_PATH`, which gets one run warning (a test ties package.json's pin to
    `CODEX_PINNED_VERSION`). Codex is not a dependency of the npm package. The Codex MCP restart creates no app-server after End
    session; `codex --version` / app-server children untrack from `host/shutdown.ts` on 'error' and 'close' as well as 'exit'.
    Unit-tested with fake file systems and fake servers only; no real claude or codex binary was resolved through these paths.
  - Doctor (`src/cli/doctor/`): installChecks (channel, every `orgai` on PATH, shadowed newer one), runtimeChecks, secretsChecks (vault
    state 'absent' is ok on Node and inproc hosts, a warning on the app where creation failed; reads `vault.json` metadata only
    without a host and never decrypts). `shimInstaller` `otherCli` prefers an npm or archive `orgai` anywhere on PATH; the shim path
    counts as this install's own only while an OrgAI shim sits there, so npm's link in `~/.local/bin` is named "The orgai command from
    npm (<v>) is on your PATH at <path>. OrgAI leaves it alone." and Install is refused (`CliShimRow`, `lib/cliShim.ts`).
  - PR #24 review fixes (2026-11-07, unit-tested only, nothing live): MCP secrets that leave argv (cli-standalone R3) go into the
    agent CLI's environment under random per-query names `ORGAI_MCP_<16 hex>_<n>_<k>` (Codex: per launch, `..._H<k>`). The
    self-control gate denies any word referencing ORGAI_MCP_ or ORGAI_VAULT_ (and shortened prefixes such as `ORGAI_` or `ORGAI*`)
    and, best effort, bare whole-environment dumps (env / printenv with no name, bare set / export -p / declare -x, compgen -v,
    gci env:, [Environment]::GetEnvironmentVariables). This is not a boundary: code runners, script files and stdio MCP servers can
    still read the environment (open Lows: compgen -A variable, `${!O@}`, wrappers, Read of /proc/self/environ). `validateSpec`
    refuses `${` in plain command, args, env values, URL, header values and per-project overrides; specs stored earlier are not
    re-checked. `claude auth status` never runs in os.tmpdir(), where a planted `<tmp>/.claude/settings.json` was loaded as project
    settings. Its probe children are tree-killed on timeout, abort and ConnectionService.dispose. `ps` / `lsof` / `secret-tool` come
    from fixed absolute paths (`systemBinaries.ts` psExecutable / lsofExecutable). `SecretStore.purge` removes a rolled-back MCP
    proposal secret without a tombstone. "Keep removed" on the Dashboard secret notice asks first (`secret-keep-removed-confirm`).
    `orgai secrets reset` moves the old vault aside (`vault.json.reset-*`) and does not delete it: those copies stay in the data
    folder, still encrypted with the old key, until removed by hand, and the gate keeps agents away from them. Tests and e2e that
    create vault key files use `src/main/testSupport/privateTempDir.ts` / `e2e/privateDir.mjs`: on win32 a %TEMP% that grants other
    accounts inheritable write makes keyFile.ts refuse the folder.
  - Unverified (Wave 7): Windows and Linux entirely (Node host spawn / log rotation, named pipes, the `withStartupMutex` win32 tests
    run only with an injected platform, DACL, DPAPI latency, taskkill / CIM paths); any real OS key store (keychain, DPAPI, Secret
    Service: only fakes, a key file and the macOS `ls -le` against temp dirs); the real `security` stderr shape; the real npm
    registry (publish, provenance, `NPM_PUBLISH_ENABLED` resolving from the environment, how npm treats a published shrinkwrap; the
    workflow YAML has not run; ci.yml's `none` install and the always-full dry run have not run in CI); verify-npm on Windows and
    Linux; packaged builds (pack:verify (f) / (g) with the new status / stop checks ran only against a fake runner); the Node
    version floor; a real Electron quit and the handoff window by eye; a real Node host draining more than 5 s under a forced
    handoff (if it hangs after a confirmed forced stop, only Quit is offered, no upper bound); `scripts/probe-custodian.mjs`. Hidden e2e
    windows are the owner's local preference and are not in the branch.
  - Wave 5: `init`, `projects`, `org`, `team`, `worktrees`, `permissions`, `connections`, `models`, `usage`, `notes`,
    `mcp`, `skills`, `knowledge`, `kit` in `src/cli/commands/` over `src/cli/manage.ts` (`confirm` asks on /dev/tty
    whenever stdin is a terminal, else exit 2 without --yes). Contracts: `McpAuthorizeInput.openBrowser` /
    `announceUrl` with the `connections:event` 'mcp.authorize' variant (the browser is opened first; a failed open is
    logged and the flow keeps waiting), `EngagementNoteSaveInput.expectedUpdatedAt` (`stale_revision`). Exit rules
    beyond the spec: kit import is 1 when any item is refused; init is 1 when /stop ends the Architect before
    complete_setup; `mcp overrides` merges onto the stored map and a dropped name is 1. worktrees calls wait 10 min
    (the repo lock alone may take 60 s); `usage csv` to a terminal is sanitized. Org import / template replace never promise
    Desktop Undo (they say it cannot be undone; --json carries `previousRoles`); the TUI's `stopOnQuit` exits 130 only
    when the run ended or runs:stop succeeded, else 1 ("Could not stop ... The run keeps going."). Unit, inproc integration and e2e
    (`cli-projects`, `cli-org`, `cli-connections`, `cli-mcp`, `cli-skills-kit`) on macOS; SSH forward, device-code login
    against a real server and the Windows / Linux URL openers are unverified.
  - TUI org chart (2026-11-06, `docs/design/ux-review-tui-org.md` "Implementation notes"): the Agents pane folds finished
    subtrees like the app (`foldFinished`/`agentTree` now in `src/shared/view/`, renderer stubs; `treeRows.ts`; `h` and `/fold`
    toggle, Right/Left expand, one line per agent, selected row's activity in a footer), tree-first layout, `! N` / worktree
    chips, `n`/`N` to waiting agents, Enter on one focuses its card (`DecisionTray` `focusKey`), Enter on another agent opens
    `InspectorPane` (also `/agent`), `z`/`Z` subtree focus, `m`/`/focus`, run chips in the status bar with `[` `]`, a
    selectable `/runs`, `/usage` (`usageText.ts`), `/retro` (`session.startRetro`, `setup:retro`), `agent.message` kept as counts
    only (`TuiRun.messages`, no text). `keymap.ts` is the one key table behind hints, `HELP_TEXT` and the `?` overlay.
    No save-as-project (`runs:promoteQuick` is configure scope, the TUI has none). Verified by unit and ink-testing-library
    frames (120x40, 90x30, 100x24, inline 80x24, ASCII, screen reader); the pty steps in `e2e/cli-tui.mjs` and a real console
    were NOT run (Windows SKIP); `agent.message` forwarding to a tui client and the message marks are unverified live.
  - Wave 4: the Ink TUI in `src/cli/tui/` (ink 8.0.0, loaded only through `await import('../tui/index')`, the
    `out/cli/tui.mjs` chunk; lazyTui.test.ts): `orgai tui [--run]`, `attach`, bare `orgai` / `orgai [--] <prompt>`,
    `resume` without --exec. `terminal.ts` owns raw mode, paste, cursor and the alternate screen (mode chosen once;
    TERM=dumb is inline) and holds SIGINT / SIGTSTP / SIGCONT while the pager owns the terminal (`suspendForChild`);
    `session.ts` `TuiConnection` owns the one shared client and every reconnect replacement (streams `keepClient: () =>
    true`), 'configure' only on a separate per-call connection for createProject. `DecisionTray` sends the exact 5.3
    payloads (revise `feedback`, rules deny `message`) with a 750 ms swap guard; `pager.ts` spawns the absolute path,
    shell-free; while the pager or a stop owns the terminal the App drops notifications, renders the last shown state,
    defers resizes to resume and Ink's stdout is wrapped in `terminal.ts` `gateWrites`. `orgai [--] <prompt>` aims the
    composer at a new run first (`App.tsx` `startLaunchRun`; never a runs:send to a focused live run, `--team` kept).
    Unit tests (ink-testing-library) and e2e `cli-tui.mjs` through a python3 pty on macOS (SKIP on win32);
    Merge Review, the real pager and CSI-u Ctrl+. on real terminals are not driven.
  - Wave 6 (packaged CLI; spec "Implementation status, Wave 6"): `build/bin/orgai` / `orgai.cmd` in `<Resources>/bin` run
    the OrgAI binary with ELECTRON_RUN_AS_NODE=1 on `app.asar.unpacked/out/cli/orgai.mjs`, so the RunAsNode fuse stays
    on (accepted deviation from spec 7(2), recorded with its risk); `host/packagedLayout.ts` (layout, shim render /
    parse) and `host/shimInstaller.ts` (PATH shim, never over a foreign file or symlink; launch refresh only for an
    older-format shim of this install or a vanished launcher); Linux AppImage cannot install the shim;
    `npm run pack:verify` (`scripts/verify-pack.mjs`, CI pack job) checks a local unpacked pack token-free: files,
    unpacked imports, `--version`, doctor, a mock exec on `--host inproc` and through the spawned background app
    (passes on macOS arm64 only). Desktop-only IPC `app:cliShimStatus` / `installCliShim` / `uninstallCliShim`
    (`CliShimStatus` / `CliShimResult`, never reject, refused over the socket); App settings > General > Advanced >
    Terminal `CliShimRow` (`cli-shim-row`, `-status[data-state]` (a live region), `-path-hint` (named by the buttons'
    aria-describedby), `-notice`; `lib/cliShim.ts`); an install never turns Terminal access on by itself (review H2):
    while it is off the row asks (`cli-shim-terminal-confirm`). The Terminal access text names the same-user trust
    model and `terminal-access-level` picks `AppSettings.terminalAccessLevel` (`lib/terminalAccess.ts`).
    `orgai doctor` adds install and shim checks. Unit-tested (packagedLayout, shimInstaller, cliShim, doctor,
    launcher, packaging.test.ts keeps `asarUnpack` in step with `CLI_RUNTIME_PACKAGES`); unverified: Windows
    (orgai.cmd, its argument passing, the shim), Linux, signed / notarized and x64 macOS builds, the row by eye.
  - Wave 3: adapters call `ctx.onRootTurnEnded` on every root turn end before 'idle' and expose `settlement()`;
    `ContinuationDriver.isSettledForTurn(gen)`; RunManager `trySettleExecRun` (pure `execSettle.ts`), stall watchdog,
    idempotent `finalizeExecRun` -> one `run.finalized` with `RunSummary.execOutcome`, chain budget (an override `maxBudgetUsd` 0
    is real; a stored project cap <= 0 is no cap, `projectBudgetUsd`), headless decision policy (`decisionPolicy.ts`), `expectedRevision` / `DecisionOutcome` on every decision
    method, tombstones (`decisionIndex.ts`, socket-only `runs:findDecision`). Widening overrides need 'configure'
    (`allowWidening`, never persisted; only the timer-driven waitForReset resume keeps it, and an operate-only
    `resume --exec` drops carried allowPeerMessages / allowUnpricedBudget). `runs:stop` ends a paused run (an exec
    one in flight finalizes 'interrupted'); a waitForReset run that can no longer resume finalizes 'rate-limited', and one
    continued as a desktop run finalizes 'interrupted' first; a Claude report's hand-back (until the next root init or
    `REPORT_HANDBACK_GRACE_MS`) keeps the session unsettled; policy merge holds never count as denials; exec timer
    overrides are capped at `MAX_TIMER_DELAY_MS` (2^31 - 1 ms). CLI `orgai exec` / `-p`,
    `resume --exec`, `decide`, `runs send / interrupt / stop`; exec followers subscribe `nonInteractive` so they never
    hold `humanGraceMs`. Mock markers `[mock:exec-plan|exec-blocked|exec-question|turn-fail|rate-limit|exec-slow]`.
    Unit tests with fake adapters / query() / app-server and e2e `cli-exec.mjs` (macOS); nothing live.
  - Wave 2: `src/main/host/socketServer.ts` serves every host's socket; `AppSettings.terminalServer` ("Terminal access")
    gates host.hello and closes authenticated sockets when turned off; a headless / inproc boot opens it for that
    session only (never saved) while `terminalServerChosen` (main-owned, set by a settings:set that changes it) is
    unset. host.hello grants at most what `AppSettings.terminalAccessLevel` allows ('operate' default: read + operate;
    'full' adds decide + configure; raised only in the desktop window); on an inproc host only the CLI process that
    started it gets every scope (`ownerProof`, an in-memory key). A `--headless-host` launch
    stays in the background after its last window closes and leaves through its idle exit, unless runs are working:
    then it asks like a desktop launch (Windows / Linux) or stays (macOS). `runtime/selfControlGate.ts`
    (before every rule and mode in claude.ts, codex.ts, mock.ts) denies the orgai CLI (file names, this install's
    `out/cli` / `src/cli` via `setOrgaiCliRoots`, ELECTRON_RUN_AS_NODE assignments) and reads, searches or shell words
    reaching `<data>/run`, `<data>/secrets.json`, `<data>/codex` (home variables and globs followed; Grep rooted at or
    above them denied, unless every Grep filter given (`glob` and `type` both, a `glob` with no whitespace and no comma
    outside braces) or the Glob pattern only matches source / document extensions).
    A shell command the gate cannot read to the end (over 256 KB, 20,000 words, 40,000 parts or 2,000 segments, shells
    or quoting nested past three levels), an internal gate error, or a run whose protected paths are unavailable is
    denied (`SELF_CONTROL_UNCHECKED_MESSAGE`), never handed to bypassPermissions. Data-only Bash here-documents are
    left out of the scan (`stripDataHeredocs`; never next to an option, or its GNU / git prefix, that reads file names
    from stdin or runs a program, and never for sort, whose `--compress-program` runs it), a pipe into an interpreter running a script file is data, and test
    runners over this install's own `src/cli` test files are allowed (PR #18 review M2 / M3; cli-spec Wave 2 notes). Program and script words are read after brace expansion, backslash escapes and globs (`<Resources>/bin/orga?`),
    and pipes / here-strings into a shell and `$(...)` bodies are scanned (Wave 6 review; limits in the file header). The CLI is `src/cli/` (bundled `out/cli/orgai.mjs`, `npm run cli`); its help and completions
    read `commandTable.ts`; host text goes through `sanitizeTty`. The launcher hears the spawned app's 'error' and
    non-zero exit (waitForReady rejects) and filters by `hostKinds`; `orgai app` refuses (exit 6) while a `--host
    inproc` host owns the folder, and `daemon start` never spawns over a live host that refused or did not answer.
    Unit, integration (real inproc host) and e2e (`cli-host.mjs`, `cli-readonly.mjs`) on macOS only.
  - Wave 1 (`src/main/host/`, Electron-free): `bootstrap.ts` `bootOrgAIHost` builds every store and service and runs
    housekeeping; `index.ts` is the Electron shell over it (windows, menu, notifications, quit gate). `dispatcher.ts`
    `HostDispatcher` owns every request handler (`invoke` desktop path; `invokeRpc` wire path: `registry.ts`
    `gateRequest` -> `unknown_channel` / `scope_denied` / `bad_request`, mutations refused `host_draining` while
    draining, an `inFlightRpcMutations` lease each, `host.status` / `host.stop` served here, `host.stop` holds no lease
    and a second stop joins the drain); `ipc.ts` is a thin adapter (one handle per dispatcher channel plus the 18
    `DESKTOP_ONLY_CHANNELS`; arg builders moved to `host/args.ts`, re-exported, deep validators added for the decision
    and run-message channels). `HOST_CHANNEL_REGISTRY` maps every channel (registry.test.ts: dispatcher channels equal
    the socket-invokable set); `params.ts` is shallow. `events.ts` `HostEventBus` carries the 8 socket-subscribable
    pushes (the shell forwards them to windows; `app:focusRun` / `menu:action` / `projects:cloneProgress` stay window-only). `activity.ts`
    `HostActivityTracker`: `ACTIVITY_LEASE_KINDS` leases and polled sources (RunManager `activeResumeTimerCount` /
    `inFlightResumeCount`, MCP / connection OAuth flows, Team assistant and skill evaluation in-flight counts, repo
    locks), idle exit (`ORGAI_DAEMON_IDLE_MINUTES`, default 30, 0 = never) never armed on the desktop host; one shared
    drain: 'draining' at once, quiesce (CapabilityService.dispose), forced: RunManager.stopAll quit within 3 s else
    `markQuit`, then up to 10 s for writers, then `ownership.release()`. Unit-tested only (registry, params, args,
    dispatcher, activity, events, bootstrap, ipcAdapter, runManagerActivity, a booted mock host over `invokeRpc`).
    Open: desktop `invoke` ignores draining; a forced drain past 10 s releases with writers in flight (logged).
  - Repository lock: `worktrees.ts` `withRepoLock` (delegating to `runtime/repoLock.ts`) serializes ALL git operations
    per repository, keyed by the common git dir, across processes through `<commonDir>/orgai-repo.lock` (owner.json with
    pid, start time and host instance id, 2 s heartbeat, 60 s `RepoLockTimeoutError`, dead or leftover owners reclaimed
    with a read-only index.lock / MERGE_HEAD notice, carried on the lease as `repoLockRecovery()`), reentrant per async
    call chain (`RepoLockLease.released` stops detached work from reusing an ended scope) and never held across a merge
    review. A worktree and the main checkout of one repo now queue behind each other; different repos do not. The
    info/exclude line follows `git rev-parse --git-path info/exclude`, so linked worktrees and `.git`-file checkouts
    write the common dir's file. Unfinished git state (spec 3.2 (5) 4): under the lock, integrateWorktree (target and
    worktree), commitLeftovers and discardWorktree (the worktree) first look for index.lock, MERGE_HEAD,
    CHERRY_PICK_HEAD, REVERT_HEAD, rebase-merge / rebase-apply in the checkout's git dir; if any is there they run no git
    command (no merge --abort, worktree remove, branch -D, add or reset): integrate answers 'conflict' with a message
    naming the files (and the reclaimed lock), commitLeftovers an error, discardWorktree throws `UnfinishedGitStateError`
    (maintenance answers ok: false). A git-layer throw settles the worktree 'conflict', never stuck 'merging'.
    Unit-tested with real git repos (repoLock.test.ts, worktrees.test.ts, incl. the contended 2-actor test) on macOS only.
  - Host ownership (`src/main/host/ownership.ts` `acquireHostOwnership`, pure Node): index.ts calls
    `app.requestSingleInstanceLock()` after the userData override, then takes `<data>/run/` before any store is built
    (RunStore's constructor rewrites live runs): `startup.mkdir` mutex (a live holder is never robbed; a dead one is
    reclaimed by rename to `.stale-<uuid>`), `daemon.json` (`DaemonInfo`, tmp + rename, starting -> ready -> draining,
    rewritten only by its own hostInstanceId), `daemon.secret` (0600, for the later handshake) and a per-instance
    listener `d-<hostInstanceId>.sock` (runtime-dir fallback past 100 bytes; it accepts and drops connections until the
    host server lands). A confirmed live pid in daemon.json is never robbed (HostAlreadyRunningError); a failure shows
    a startup dialog and quits; released on will-quit and process exit. Liveness and start times: `host/processInfo.ts`
    (darwin `ps -o lstart=` under LC_ALL=C TZ=UTC; `processLiveness` 'same' / 'unconfirmed' / 'dead'; the async
    cached form in ownership and the repo lock; win32 self start time from Node's time origin, compared within 10 s),
    ids `host/identity.ts` (12 hex). Review fixes (Group A, unit-tested; Windows UNVERIFIED): an unconfirmed pid with a
    dead endpoint (unless its daemon.json says `listening: false`: an Electron host with Terminal access off has no
    listener, so it counts as running and only a 'dead' pid is reclaimed, except by an Electron launch, which holds the
    single-instance lock and so reclaims an Electron incumbent's record, `singleInstanceLockHeld`; `--host inproc`
    keeps the refusal), or an unconfirmed startup.mkdir owner past
    60 s, is reclaimed; an unreadable daemon.json refuses
    (`daemon_json_unreadable`) unless it names a dead pid; refusals name `<data>/run`; renames retry transient win32
    EPERM / EBUSY / EACCES (`host/fsRetry.ts`); icacls is fatal only for headless / inproc and for setListening(true)
    (`secretAcl`; a best-effort desktop acquire gets `secretAclWarning`, which the socket server reads at every hello
    through `secretAclProblem` and refuses while set, never cached; the server runs no icacls of its own); system programs run by absolute path from the temp dir and git through
    `host/systemBinaries.ts` `gitExecutable` (never a cwd); the repo lock also counts a fresh heartbeat as live; win32
    shims write non-ASCII paths as `%LOCALAPPDATA%\...` (`batchPath`). Crash injection at every boundary
    (`OWNERSHIP_BOUNDARIES` / `RELEASE_BOUNDARIES`) in ownership.test.ts.
  - `log.ts` no longer imports electron (app hooks in `electronLogHooks.ts`); `host/noElectronImport.test.ts` imports log.ts,
    the host modules, the stores, RunManager, the adapters and services with electron mocked to throw.
  - Pure view-models moved to `src/shared/view/` (no renderer, DOM or React imports, `noRendererImports.test.ts`); the old
    `src/renderer/src/lib/<name>.ts` paths are thin `export * from '@shared/view/<name>'` re-exports (reexports.test.ts),
    so renderer imports are unchanged and new pure view logic the CLI also needs goes in `src/shared/view/`.
  - Contracts in types.ts: `HOST_IPC`, host wire-protocol types, `RunOverrides`, `HeadlessDecisionPolicy`,
    `DecisionOutcome`, `ExecOutcome`, `RunEndedBy` 'policy' / 'budget', `run.finalized`, bundle / CAS inputs. RunStore
    keeps 'policy' / 'budget' and a finalized exec run's endedBy on read (runs.test.ts). Nothing emits them yet.
  - `host/jsonCodec.ts`: safe reviver (`parseJsonSafe` drops `__proto__` / `constructor` / `prototype` keys) and a per-channel codec
    (`CHANNEL_JSON_FIELDS`) that carries undefined / clearable optional fields over JSON; `jsonRoundTrip.test.ts` walks
    every request and push channel. Not wired to any transport yet.
  - MCP secret env clashes (`shared/mcpSecretClash.ts` `secretEnvClashes`): `codexProtocol.ts` refuses a later stdio
    server whose secret env name another enabled server uses with a different value (a run summary line, no config
    line); MCP Settings rows show `secretClashLine`. Unit-tested; the Codex side is not run live.
  - Bundles and CAS: `SkillServiceApi.libraryAddFromBundle` / skills `readBundle` (host-validated relative paths,
    caps, shell-injection refusal), kit export / import from a bundle with an optional `targetDigest` compare-and-set
    (`kit/bundle.test.ts`); `knowledge:saveNode` takes `expectedUpdatedAt` (stale -> `stale_revision`) and
    `appendFacts`, and with `nodeId` may omit kind and name (an append-only save that never reverts a rename).
    Unit-tested only (serviceBundle.test.ts, knowledgeAppend.test.ts).
  - PR #18 review fixes (2026-11-05, cli-spec "Review fixes, PR #18"; unit tests on macOS, e2e:free on macOS, nothing
    run on Windows): window close asks before working runs go to the background (`RunManager.workingRunCount`; the
    `liveRuns` source is `busyRunCount`, runs waiting on the user do not count); `NARROWS_FROM.default` drops
    'dontAsk' (M1); stall watchdog ceiling `EXEC_STALL_BUSY_ROUNDS` (M4); a transient index.lock is re-checked before
    a merge refusal (M5); `--prompt-file` for untrusted prompts (M12; the .cmd passes %* through cmd.exe);
    `--from-env` secrets leave the environment before a host is spawned (M13); JSON output escapes C1 / bidi / U+2028
    (M15); `trustSystemCertificates` after the single-instance lock and in `--host inproc` (M16); cli-exec.mjs drives
    the win32 interrupt through `runs stop` (H4, unrun on Windows); dev's 7 channels in the registry and dev's
    knowledge / transcriptRows bodies in `shared/view`, reexports.test compares export names (H5, H6).
  - Unverified: Windows named pipes and their ACLs, Windows / Linux process start times, packaged builds, the startup
    dialogs by eye.
