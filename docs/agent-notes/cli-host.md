# CLI and host

Waves 0-7: host ownership, dispatcher, socket server, self-control gate, exec, TUI, packaged and standalone CLI, vault, shutdown and handoff, repository lock. Moved out of CLAUDE.md on 2026-11-07; see CLAUDE.md for the index.

- CLI & host: THE MODEL (docs/design/cli-standalone-default.md, status "implemented on feat/cli-standalone-default", 2026-11-08). The `orgai` CLI (npm package `orgai-cli`) and the OrgAI desktop app share NOTHING, like Claude Code and Claude Desktop: separate data folders (app `<userData>/data`, override `ORGAI_DATA_DIR`; CLI `orgai-cli`, override `--data-dir` / `ORGAI_CLI_DATA_DIR`; `ORGAI_DATA_DIR` is ignored by the CLI; product markers in each folder), separate vaults and key custody (desktop `OrgAI Vault` / `ORGAI_VAULT_*`; CLI `OrgAI CLI Vault` / `ORGAI_CLI_VAULT_*`), approvals, libraries and Codex logins. The app has no socket server, no `--headless-host`, no handoff and no Terminal access setting, and its package does not contain the CLI; it offers an Install row (App settings > Terminal) that runs `npm install -g orgai-cli`. `orgai` runs in-process; no run lives behind the scenes. The sections below are partly HISTORY (cli-spec.md and cli-standalone.md are superseded where they differ); the spec's section 6 lists the corpus exclusions.
  - Waves 0-5 landed the socket protocol, the in-process host, the self-control gate, the read-only `orgai` CLI, headless exec, the terminal UI and the management commands; see cli-spec.md "Implementation status" for deviations and what is unverified.
  - Wave 7 (standalone `orgai`; docs/design/cli-standalone.md; merged to dev via PR #24, 2026-11-07; its Node host, daemon and handoff parts are removed). Verified on macOS by unit tests, in-process integration tests and a few e2e scripts; nothing ran on Windows or Linux, against a real OS key store, the real npm registry or a packaged build (see Unverified at the end of this bullet).
  - Package and channel: npm package `orgai-cli` (bin `orgai`; owner decision D1 2026-11-06, npm refused `orgai`), built by
    `scripts/build-npm-package.mjs` (`--dry-run`, `--shrinkwrap` (default: none); pure parts in `scripts/lib/npmPackage.mjs`) into
    `release/npm/package` + `orgai-<v>.tgz` from `out/cli` plus `out/cli/install.json` (`{ channel: 'npm'|'app'|'archive',
    version, commit }`, written by `scripts/write-install-info.mjs` for the npm package and tests only; `npm run pack` writes none
    (cli-standalone-default.md 5.2), `withInstallInfoCleanup` is now used only by its test; absent = 'dev'; a file that is present but invalid
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
    no Linux leg: Linux is covered only by verify-npm. The app no longer contains the CLI (standalone spec 5.2); `pack:verify` has no CLI-driven checks.
  - Model (docs/design/cli-standalone-default.md, implemented 2026-11-08): see the first bullet. `orgai` always runs its host in-process (`src/cli/inprocHost.ts`, ownership in `src/main/host/ownership.ts`, one `orgai` per CLI data folder, a second one is refused with exit 6; read-only commands read files beside an owner, `src/cli/client/readOnlyStore.ts`). There is no `--host`, daemon, Node or headless host, no `orgai app`, `terminal-access`, `watch`, `inbox`, `decide` or `attach`, and no launcher or shared host. Cards are answered inside the owning TUI. `ORGAI_SECRET_*` / `--secret-env` rules follow spec 4.1 (Round 6 item 8); `ORGAI_SECRET_*` names are refused as `--from-env` / `--client-secret-from-env` sources (exit 2).
  - PR 49 (in-memory dispatch, lazy loading, run choices, exec flags; review fixes 2026-11-12). Each item says how it was checked; nothing here was run against a live provider, and no e2e beyond the area scripts listed in the PR 49 fix report.
    - `orgai exec -q` / `--quiet`: stdout carries only the sanitized final answer, logs go nowhere or to stderr, JSON output is unchanged (exec.test.ts "--quiet ..." cases).
    - `--output-last-message <file>`: the final answer is written to a temporary file and renamed over the destination (relative to the cwd), never through a link; a failed write fails the command (exec.test.ts; the link case needs symlink privilege and fails with EPERM on a Windows account without it, a test-environment limit).
    - `exec --model <tier|id>` / `--effort`: resolved against the project connection's catalog and sent as `runs:start` choices, which the host accepts from `inproc` only with `configure` (exec.test.ts tier cases, dispatcherRunChoice.test.ts). `--continue` / `-c` continues the newest continuable work run headless and refuses new-run choices (exec.test.ts, `newestContinuable` in runChains).
    - Piped stdin beside a prompt argument is fenced between two random `STDIN-<hex>` lines labelled as data (`fencePiped`; exec.test.ts checks a `</stdin>` inside the input cannot close the fence and that a colliding tag is re-rolled).
    - TUI `/mode`: shows or changes the permission mode; widening a followed live run asks first (`confirm`), narrowing and staging do not. Shift+Tab on the composer chooses a waiting decision; with none it steps a live run's mode narrower only (auto, acceptEdits, default, plan, no wrap; at plan it says to use /mode) or cycles the next run's staged mode (default, acceptEdits, plan; `auto` only through /mode); a Shift+Tab within 750 ms of the tray emptying is ignored (App.shell.test.tsx, runControls.test.ts, workstreamC.controls.test.ts; ink-testing-library with a fake session, no real terminal).
    - TUI `/copy` copies the last assistant message or its code block (OSC 52 plus the platform tool, `clipboard.ts`); `/save-project` turns an ended Chat (quick) run into a project and follows it; Ctrl+G edits the draft in `$VISUAL` / `$EDITOR` through a private temp file it removes afterwards (workstreamC.controls.test.ts; no real clipboard or editor was driven).
    - Team files at create / init: there is no terminal flag to adopt a folder's `.orgai` team. `orgai projects create` / `init` never send a digest, print that the changes stay pending (`orgai team files status`), and the host refuses `projects:create` with `teamFiles.digest` from `inproc` and socket clients (projects.test.ts, dispatcherTeamFiles.test.ts). An `--adopt-team-files` flag in the contributed PR was removed in review (cli-parity 3.4 / 7).
    - A plain TUI continue passes `{ desktop: true }`, not `allowWidening`: stored exec overrides re-clamp to the current project. A continue with its own overrides (a staged `/goal`) keeps `allowWidening` for those fields only: `continuedOverrides` drops carried keys that would widen the project now, except on `resume --exec` and the automatic resume (runManager.startChoice.test.ts "re-clamps", runManagerExec.test.ts, dispatcherRunChoice.test.ts; fake adapters).
    - `/mode` compares a widening with the run's own mode as well as the mode in force, so a session-only accept-edits grant is not saved as the run's mode without the question; Shift+Tab steps from the run's own mode; an ignored Shift+Tab says so (App.shell.test.tsx).
    - Crash recovery without a socket: the `listen: false` host binds a liveness-only endpoint (`livenessProbe` in daemon.json); an unconfirmed pid with a dead endpoint is reclaimed, and exit 6 names the run folder to delete when nothing runs (ownership.test.ts, inprocHost.test.ts on Windows with a real named pipe; the posix socket path and the posix shutdown integration suites did not run, and no real crash plus pid reuse was staged). `memoryStreamPair` defaults to a 1 MiB high-water mark; a 5 MiB frame still crosses intact (inprocHost.test.ts).
  - Shutdown (`src/main/host/shutdown.ts` `ShutdownCoordinator`; handoff is gone with the app's host): every exit path (desktop Quit through `desktopQuit.ts` `beforeQuitHandler`, the last window on Windows / Linux, `installShutdownSignals`, the `orgai` in-process cleanup, `host.stop` from the TUI) runs drain (state 'draining', mutations refused `host_draining`, quiesce, `RunManager.stopAll({ reason: 'quit' })` for at most 3 s then `markQuit`), `settleWriters`, `ownership.release()`, exit. At `SHUTDOWN_HARD_LIMIT_MS` (60 s) `killHostDescendants` terminates what is left (POSIX `ps`, Windows CIM; the coordinator's own helpers are never targets). `HostDispatcher.invoke` leases every mutating channel (`mcp:authorize` leases only its final commit, `COMMIT_LEASED_CHANNELS`) and ipc.ts wraps every mutating desktop-only channel the same way (`ipcLeases.test.ts`); quiesce aborts OAuth flows, repository clones, Team assistant / evaluation model calls and `draft:orgChart`. Unit tests and real owner-process integration tests (`shutdown.int`, `inprocShutdown.int`) on macOS; a real Electron quit is not driven.
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
    and `ORGAI_CLI_VAULT_NO_OS_KEYSTORE=1` (vitest.config.ts; the CLI uses only the `ORGAI_CLI_VAULT_*` family, so e2e uses `ORGAI_CLI_VAULT_KEY_FILE`; each product reads the other's key file variable only to refuse a key file equal to it, `keyFilePathProblem`); tests must inject a fake custodian or a key file in a temp folder, never the OS schemes. the in-process CLI
    host creates the vault lazily in `prepareWrite()` (single-flight); `HostDispatcher.invokeRpc` awaits it when the channel's
    `storesSecret` predicate (`host/storesSecret.ts`) is true; `set()` with a value on an absent vault throws `VaultNotReady` (a
    bug trap). `set(key, null|'')` and `clear(key)` are explicit clears and throw the store's sentence when refused (corrupt,
    recovery pending, `secretClearFailedMessage`, `notDurable`); `delete()` / `deletePrefix()` are removals that never throw
    and leave keys they cannot handle (counted orphaned); `connectors:setToken` null, `connections:logout('litellm')` and `revokeAuth` call `clear()`
    (a failed save throws and the record is not changed, integration review). Approved MCP proposals use one slot rule (`mcp/proposalSecrets.ts`
    `proposalTypedSlots`); secrets are stored before any record changes (`storeFirst`, `commitOAuth`) and rolled back with
    `status()` priors (a key unreadable before keeps the new value, warning logged); `ProposalSecretsNotSaved` keeps the card open. Integration review fixes: on the Claude adapter secret MCP env values, secret headers and the OAuth bearer leave the `claude` child's argv
    (placeholders in `--mcp-config`, real values in `options.env`; `setMcpServers` keeps real values as a control message); host git, the desktop clone's git and gh (`gitEnv` / `ghEnv`) and doctor's `git --version` (`scrubControlEnv` on every git spawn)
    no longer inherits `ORGAI_SECRET_*` / `ORGAI_VAULT_*` / `ORGAI_CLI_VAULT_*`; the mock inproc host never uses an OS key store without a key file (e2e
    `cliLib` names a throwaway one); an inproc host has no idle exit.
    `secrets:reset` refuses while a predicate-prepared write, a sign-in or a refresh is in flight (`setResetBusyCheck`).
    Failures repeat in the log at most once per `VAULT_REPEAT_LOG_MS` (24 h). `SecretsStatusResult.readError` carries the
    I/O sentence. ConnectionService says "The LiteLLM API key cannot be read here: <reason>." for an unreadable key. Channels
    `secrets:status` (read), `secrets:init`, `secrets:reset`, `secrets:undelete`, `secrets:confirmDelete` (configure); CLI
    `orgai secrets status [--probe] | init [--key-file <path> [--import]] | reset --yes | undelete <key>` (no value ever
    printed; no `confirm-delete` command, the app notice is not built so removed secrets are listed by doctor / status),
    `connections set-secret`, `mcp set-secret` and `mcp authorize` work on the in-process host. Unit tests with fault
    injection at every write boundary, `secretChannelsReal` (real store + key-file custodian), `vaultCli.int`, `doctorVault.int`.
  - Custodians (`src/main/store/custodians/`, child processes only, absolute binaries, `shell: false`, tmpdir cwd, 10 s timeout,
    per-scheme environment allowlist, values on stdin / stdout): keychain (`/usr/bin/security -i -q`, service "OrgAI
    Vault" for the desktop and "OrgAI CLI Vault" for the CLI (Secret Service attributes `service orgai-cli` for the CLI), chosen by the `openSecretStore` `product` option; exit codes are classified before wording, and with exit 0 only a `security: ` error line's message counts),
    dpapi-user (PowerShell `ProtectedData`, entropy `orgai.vault/1:<vaultId>`, Constrained Language Mode = denied),
    secret-service (`secret-tool`, needs a session bus), key-file (opt-in through `ORGAI_VAULT_KEY_FILE` (desktop) / `ORGAI_CLI_VAULT_KEY_FILE` (CLI) or `secrets init
    --key-file`; never inside the user-data folder; created `O_EXCL|O_NOFOLLOW` 0600; Windows protected DACL through `icacls`;
    macOS `ls -le` ACL check refuses allow entries, gap: it reads the path, not the descriptor). Create reads the key back and
    removes the item on a failed or different read-back. `CustodianFactoryOptions.currentCustody` is read per call;
    `CustodianCreated.keyFile` is the canonical path. `childEnv.ts` scrubs both `ORGAI_VAULT_*` and `ORGAI_CLI_VAULT_*` from Claude, Codex and MCP children.
    The gate also denies `/proc/<pid>/environ` words and `ps` environment flags (a script reading another process's environment still gets `ORGAI_SECRET_*`). Threat model: same-user processes (agents included) can reach the key on all platforms; on macOS this weakens safeStorage's
    app-only item (D4 accepted). Fakes and fixtures only: `scripts/probe-custodian.mjs` (creates, reopens in a fresh process and
    deletes one item under a throwaway id) exists and has NOT been run (needs the owner's consent).
  - Self-control gate additions (`selfControlGate.ts`, `referenceDirectories.ts`): package runners naming `orgai-cli` / `orgai` /
    `@orgai/cli` (with `--package=`, `-p`, `npm:`, `@version`, and globs keeping 3 of the letters of "orgaicli" in order); reads of
    `<data>/vault.json*` / `secrets.json*`, the key file and any `ORGAI_VAULT_*` / `ORGAI_CLI_VAULT_*` word; `security` read as getopt does
    (`--`, `-pX`, `-p X`) and unwrapped through `launchctl asuser|bsexec` and `script`; `secret-tool`, D-Bus tools naming
    `org.freedesktop.secrets`, PowerShell `ProtectedData` / `Unprotect`; the names "OrgAI Vault" and "OrgAI CLI Vault" only after `security`, `keyring`,
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
    state 'absent' is ok on the CLI's in-process host (doctor never reaches an app host); reads `vault.json` metadata only
    without a host and never decrypts). `shimInstaller` `otherCli` prefers an npm or archive `orgai` anywhere on PATH; the shim path
    counts as this install's own only while an OrgAI shim sits there, so npm's link in `~/.local/bin` is named "The orgai command from
    npm (<v>) is on your PATH at <path>. OrgAI leaves it alone." and Install is refused (`CliShimRow`, `lib/cliShim.ts`; SUPERSEDED, removed).
  - Install row (standalone spec 5.3, replaces `CliShimRow` and the shim install half; the lines above are history): App settings >
    Terminal `CliCommandRow` (`cli-command-row`, `-status[data-state]`, `-install`, `-cancel`, `-remove-old`, `-text`, `-hint`,
    `-output`; `lib/cliCommand.ts`) over `src/main/host/cliInstaller.ts`. Status is metadata only (`orgaiOnPath.ts` also reads an
    `orgai-cli` package.json beside the bin; an empty login PATH falls back to the process PATH). Install: absolute npm from PATH,
    `install -g orgai-cli@<latest|next> --ignore-scripts`, cwd home, env scrubbed of ORGAI_/ANTHROPIC_/OPENAI_/CLAUDE_/CODEX_/AWS_/
    GOOGLE_/AZURE_, one at a time, cancellable, 200 lines / 64 KB output. `shimInstaller.ts` is cleanup only (ownership re-checked
    before unlink). IPC `app:cliCommandStatus|installCliCommand|cancelCliInstall|removeOldCliShim`. `e2e/install-row.mjs` uses a
    fake npm; Windows (npm.cmd through cmd.exe, taskkill) is unit-tested only.
  - PR #24 review fixes (2026-11-07, unit-tested only, nothing live): MCP secrets that leave argv (cli-standalone R3) go into the
    agent CLI's environment under random per-query names `ORGAI_MCP_<16 hex>_<n>_<k>` (Codex: per launch, `..._H<k>`). The
    self-control gate denies any word referencing ORGAI_MCP_, ORGAI_VAULT_ or ORGAI_CLI_VAULT_ (and shortened prefixes such as `ORGAI_` or `ORGAI*`)
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
  - Unverified (Wave 7): Windows and Linux entirely (named pipes, the `withStartupMutex` win32 tests
    run only with an injected platform, DACL, DPAPI latency, taskkill / CIM paths); any real OS key store (keychain, DPAPI, Secret
    Service: only fakes, a key file and the macOS `ls -le` against temp dirs); the real `security` stderr shape; the real npm
    registry (publish, provenance, `NPM_PUBLISH_ENABLED` resolving from the environment, how npm treats a published shrinkwrap; the
    workflow YAML has not run; ci.yml's `none` install and the always-full dry run have not run in CI); verify-npm on Windows and
    Linux; packaged builds (pack:verify (e) boot, (f) certificate reader and (g) agent `--version` checks ran only against a fake runner); the Node
    version floor; a real Electron quit by eye; `scripts/probe-custodian.mjs`. Hidden e2e
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
    `out/cli/tui.mjs` chunk; lazyTui.test.ts): `orgai tui [--run]`, bare `orgai` / `orgai [--] <prompt>`,
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
  - Wave 6 (history, removed 2026-11-08): the app-bundled `orgai` launcher, `app:cliShim*` IPC and `CliShimRow`. The packaged app holds no CLI, and the RunAsNode fuse stays on (accepted: the certificate reader runs the app binary as Node, so any local process can run JS as the signed OrgAI binary with its entitlements via `ELECTRON_RUN_AS_NODE=1`; the self-control gate's rule for that assignment is a text check; standalone spec section 2); `npm run pack:verify` (`scripts/verify-pack.mjs`) checks that, that the app keeps its own unpacked runtime packages, and (check (e)) boots hidden on the mock adapter with a temp `ORGAI_DATA_DIR` and quits cleanly (CI step is `continue-on-error` until (e) has passed once on both runners; standalone spec section 12). The only shim code left is cleanup of old OrgAI-written shims (`shimInstaller.ts`, Install row below).
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
    `resume --exec` (`decide` and `runs send / interrupt / stop` removed 2026-11-08); exec followers subscribe `nonInteractive` so they never
    hold `humanGraceMs`. Mock markers `[mock:exec-plan|exec-blocked|exec-question|turn-fail|rate-limit|exec-slow]`.
    Unit tests with fake adapters / query() / app-server and e2e `cli-exec.mjs` (macOS); nothing live.
  - Wave 2 (history; the app now serves no socket, the owning `orgai` serves it for its own in-process host only): owner-only socket `src/main/host/socketServer.ts` (`ownerProof`, an in-memory key, grants every scope to the process that started the host). `runtime/selfControlGate.ts` (before every rule and mode in claude.ts, codex.ts, mock.ts) denies the orgai CLI (file names, this install's `out/cli` / `src/cli` via `setOrgaiCliRoots`, ELECTRON_RUN_AS_NODE assignments) and reads, searches or shell words reaching `<data>/run`, `<data>/secrets.json`, `<data>/codex`, `settings.json` and `auth-cwd` (cross-product: the other product's default data folder, its control entries plus `vault.json`, is protected for both products through `controlProtectedPaths(..., { otherProductDataDirs })`; an env override of the other product's folder is not covered, spec 13) (home variables and globs followed; Grep rooted at or above them denied, unless every Grep filter given (`glob` and `type` both, a `glob` with no whitespace and no comma outside braces) or the Glob pattern only matches source / document extensions). A shell command the gate cannot read to the end (over 256 KB, 20,000 words, 40,000 parts or 2,000 segments, shells or quoting nested past three levels), an internal gate error, or a run whose protected paths are unavailable is denied (`SELF_CONTROL_UNCHECKED_MESSAGE`), never handed to bypassPermissions. Data-only Bash here-documents are left out of the scan (`stripDataHeredocs`; never next to an option, or its GNU / git prefix, that reads file names from stdin or runs a program, and never for sort, whose `--compress-program` runs it), a pipe into an interpreter running a script file is data, and test runners over this install's own `src/cli` test files are allowed (PR #18 review M2 / M3; cli-spec Wave 2 notes). Program and script words are read after brace expansion, backslash escapes and globs (`<Resources>/bin/orga?`), and pipes / here-strings into a shell and `$(...)` bodies are scanned (Wave 6 review; limits in the file header). The CLI is `src/cli/` (bundled `out/cli/orgai.mjs`, `npm run cli`); its help and completions read `commandTable.ts`; host text goes through `sanitizeTty`. Unit, integration (real inproc host) and e2e (`cli-readonly.mjs`) on macOS only.
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
    locks), idle exit (`ORGAI_DAEMON_IDLE_MINUTES`, default 30, 0 = never) armed only by the desktop's 'Keep working in the background' mode (`goBackground` in index.ts), never by the inproc CLI host; one shared
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
    rewritten only by its own hostInstanceId), and, only for the in-process CLI host, `daemon.secret` (0600) and a per-instance
    listener `d-<hostInstanceId>.sock` (runtime-dir fallback past 100 bytes). The desktop passes `listen: false` (daemon.json `listening: false`, no secret, no listener). A confirmed live pid in daemon.json is never robbed (HostAlreadyRunningError); a failure shows
    a startup dialog and quits; released on will-quit and process exit. Liveness and start times: `host/processInfo.ts`
    (darwin `ps -o lstart=` under LC_ALL=C TZ=UTC; `processLiveness` 'same' / 'unconfirmed' / 'dead'; the async
    cached form in ownership and the repo lock; win32 self start time from Node's time origin, compared within 10 s),
    ids `host/identity.ts` (12 hex). Review fixes (Group A, unit-tested; Windows UNVERIFIED): an unconfirmed pid with a
    dead endpoint (unless its daemon.json says `listening: false`: the app never listens (`listen: false`) and has no
    listener (history: Terminal access), so it counts as running and only a 'dead' pid is reclaimed, except by an Electron launch, which holds the
    single-instance lock and so reclaims an Electron incumbent's record, `singleInstanceLockHeld`; the in-process `orgai`
    keeps the refusal), or an unconfirmed startup.mkdir owner past
    60 s, is reclaimed; an unreadable daemon.json refuses
    (`daemon_json_unreadable`) unless it names a dead pid; refusals name `<data>/run`; renames retry transient win32
    EPERM / EBUSY / EACCES (`host/fsRetry.ts`); icacls is fatal for inproc (and for setListening(true))
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
    (M15); `trustSystemCertificates` after the single-instance lock and in the in-process `orgai` (M16); cli-exec.mjs drives
    the win32 interrupt through `runs stop` (H4, unrun on Windows; command removed 2026-11-08); dev's 7 channels in the registry and dev's
    knowledge / transcriptRows bodies in `shared/view`, reexports.test compares export names (H5, H6).
  - Unverified: Windows named pipes and their ACLs, Windows / Linux process start times, packaged builds, the startup
    dialogs by eye.
- Run staffing in the CLI and TUI (orchestration-efficiency 4.7; checked by unit tests only, no live run):
  - `exec` and `resume --exec` take `--goal balanced|speed|cost` (`overrides.goal`; a bad value is a usage error naming the
    three). Text mode prints one line per staffed report from `staffing.updated`, once per assignment that has an
    `agentId`: `engineer-1 on everyday / medium (chosen by the orchestrator)`; json and stream-json are unchanged.
  - `src/cli/staffingText.ts` holds the pure words (label, reason from `source` and `note`, newest assignment per agent);
    `src/cli/tui/planGraph.ts` is a thin view over `src/shared/planGraph.ts`, the one ready / waiting definition shared with the host (`readySteps`) and the desktop app: ready = pending, every existing `after` done or skipped, and of two parallel steps sharing a path the later waits for the earlier, so the TUI ready count matches the host's.
  - TUI: agent rows end with the staffing text (dim) only when the whole row fits with it; the inspector has a
    `staffing` fact line; the plan pane adds running / ready / waiting-on (two titles, then "and N more") and the step's
    pick for plans where any step has `after`, `paths` or `staff`; the status bar adds "N working" and "N ready" (first
    segments to give way) for runs with staffing data or a graph plan. All run text goes through `safeLine`.
- Seeing models (cli-parity 3.1, first two bullets; unit-tested, no live run): at a work run's start (not mock, not
  setup-like) RunManager emits `runModelLogs` (`src/main/runtime/runModels.ts`): one `info` "Models: deep = <id>,
  everyday = <id> (Anthropic); fast = <id> (OpenAI)" from the roles' `model` / `tier` on each role's connection, and
  at most one `warn` "Model check: ..." for a tier on an older family member (`compareModelIds`: numeric tokens are
  the version, the rest the family; dates, `[1m]`, provider prefixes set aside; cannot tell = no warning), on a
  catalog entry whose `source` is not `discovered`, or on a connection with `modelsError` (RunManagerOptions
  `modelsError`, ConnectionService `modelsErrorFor`). `exec` text prints warn / error logs and the Models line
  (`execLogLine`, also from the snapshot's `logs`); the TUI makes the Models line a notice. `staffingLabel` reads
  "everyday (claude-sonnet-5-5) / medium"; tree rows carry `model` / `staffingPick` / `connection` (the last only when
  the run spans several connections) and `fitModelText` cuts the id first, then drops it, then the text. The
  inspector lists every `usage.models` entry; the status bar and `runs show` (`Model:`) show the root's live model
  (`run.model` now sets `summary.modelSelection` in `state.ts`).
- Run control (cli-parity 3.5, branch cp/runControl, 2026-11-10; unit and ink tests only, nothing live, e2e rows added
  but not run). The live model switch's guard (`performModelSwitch`, `modelSwitchBlock`, `needsModelHandoff`, the
  handoff wording) moved to `src/shared/liveModelSwitch.ts`; the renderer's `lib/liveModelSwitch.ts` re-exports it.
  `src/cli/modelSwitch.ts` loads the connected connections' catalog, resolves a tier (the run connection's
  `tierModels` via `modelForTier`) or id, and switches through the shared guard (a host request for a transcript
  handoff is retried once after confirming). `orgai runs model <run> [<tier|id>] [--connection] [--yes]`
  (`commands/runsModel.ts`; `runs list|show` stay hostless, `runs model` starts a host) and TUI `/model` (a pick
  overlay without an argument). `orgai resume <run> --now` (`commands/resumeActions.ts`: runs:resumeNow in the TUI's
  prepare, then the TUI follows the resumed run) and `--cancel-auto-resume` (one-shot). A pause exists only inside the
  orgai that ran the run (a new host's boot normalization ends it), so from another terminal both answer "Run is not
  paused" plus a hint to `orgai resume <run>`; inside the TUI `/resume-now` and `/cancel-resume` act on the followed
  paused run, whose completion block (now also shown for paused runs) names them. Run flags: `/new` and `/ask` take
  `--goal`, `--permission-mode`, `--strict-delegation`; bare `orgai` takes exec's run-shaping flags for the first run
  (`runStartFlags.ts`, validated by exec's `overridesFromFlags`, `execMode` dropped; headless-only flags are refused).
  `session.ts` sends `overrides` on start, continue and quick; widening ones go through a one-call 'configure'
  connection (`callConfigured`), as exec asks for 'configure'.
- Approvals at the terminal (cli-parity 3.4 and principle 4, branch cp/approvals, 2026-11-10; read-only as built; unit,
  ink and in-process integration tests, e2e rows in `e2e/cli-org.mjs` not run). What ships:
  - `orgai team files [status]` (read scope, `teamFiles:listAttention`): each pending change with the gate's summary,
    "May spend more: ..." first, tools gained, MCP target, secrets, reach, git's view of who wrote it (OrgAI records no
    author) and, when undo is open, what Undo would bring back (`TeamFilesStatus.undoChanges`, filled by the
    listAttention handler from `TeamFilesService.undoChanges`; the service's own status and the desktop push do not
    carry it). `orgai projects trust [show]` (read scope, `projects:folderConfig`). Both with `--output-format json`.
  - `exec` and `resume --exec` print one stderr line (text mode) before the run while the project's team files wait
    (`approvalText.ts` `pendingTeamFilesLine`); the TUI shows a notice on open.
  - TUI `/approvals` (aliases team-files, trust) is read-only: a text overlay with every waiting item in full (the same
    words, prompts before and after, what Undo would bring back, a folder's own config) ending with "Approving is done in
    the OrgAI desktop app for now: a terminal cannot yet prove that a person, not an agent, is answering."
  - `orgai team files approve|reject|undo|commit|enable` and `orgai projects trust allow|deny` decide nothing: they say
    so, exit 2 and start no host, whatever flags follow.
  - No new channel or scope: the registry is unchanged; the desktop's team files decisions and
    `projects:setFolderConfigTrust` stay `desktop_only`.
  - The CLI starts Node with the inspector signal disabled (`src/cli/inspectorSignal.ts`; `src/cli/bin.ts` is the
    bundle's entry and loads it before the rest of the CLI, which comes in as its own chunk; `npm run cli` also passes
    `--disable-sigusr1`; `inspectorSignal.test.ts`).
  - Why approving was held: an approval path at the terminal was built and reviewed twice. Both independent reviews
    found that a terminal session cannot be told apart from one an agent drives, so an agent could approve its own change.
    Approving from a terminal needs a confirmation from the operating system that an agent cannot produce, and a record of
    what was approved that agents cannot write. That work is preserved on the local branch `cp/approvals-full-gate`.
  - Known gap: the desktop app keeps its own data folder, so approving there does not clear a pending change of a project
    in the CLI's data folder; a terminal-only user can see such a change but not clear it today.
- TUI Team and Settings views (cli-parity 3.7, branch cp/tuiPanes, 2026-11-10; unit and ink tests only, nothing live, e2e
  rows in `e2e/cli-tui.mjs` added but not run). `/team` (`TeamView.tsx`, words in `teamModel.ts`) shows the project's SAVED
  roles as a tree (roleTree): name, tier with the id it resolves to (models.ts `resolveRole`), effort, staffing in words,
  "on <connection>" when it differs; rows drop runs-on, then long staffing words, then the model id, then effort before
  the name is cut. Enter opens the details (`roleSummaryLines`, resolved model, prompt preview). Keys m model, e effort,
  s staffing (then bounds for automatic), t tools, r reparent, n rename, p prompt, a add under, x remove (picks who takes
  its reports). Every edit re-reads the project and goes through the commands' planners, now exported from
  `commands/teamRoleEdit.ts` (`planRoleSet`, `planRoleAdd`, `planRoleMove`, `planRoleRemove`, `spendQuestion`; the
  commands call the same functions), then projects:save; a "May spend more" plan and every removal wait for `y`. The
  prompt opens $VISUAL / $EDITOR through `editTextIn` (shared with `team role set --edit`, synchronous, inside
  `suspendForChild` / `resumeFromChild`, resume 50 ms after the editor exits); a terminal without those names
  `orgai team role set <slug> --edit`. `/settings` (`SettingsView.tsx`, rows in `settingsModel.ts`): Project rows through
  `projects set`'s `setPatch` and `staffingSpendSentence`, the permission mode through `permissions mode`'s
  `permissionModeArg`; Tiers of the project's connection through `connections tier`'s `planTierChange` and
  `previewTierChange` (now exported; the touched roles are listed before `y`), then connections:update; App rows through
  `orgai settings`' `SETTING_KEYS` / `parseSettingValue`, then settings:set. The project's connection row is read-only.
  Host calls: `TuiSessionApi.config` (`configApi.ts`), reads on the shared client, writes on a one-call 'configure'
  connection (`callConfigured`); a save updates the session's project. Mid-run: the host lets a project be saved while a
  run is live and RunManager keeps the live run's roles as they started, so a save during a live run says it applies from
  the next run. Both views are overlays of the body (status bar, tray and composer stay), focus target 'config', Esc
  backs out one level. The first time a terminal opens a project it shows one notice naming /team and /settings
  (`<userDataDir>/tui-hints.json`, `hintStore`).
