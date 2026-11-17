# Desktop auto-update

The desktop app checks GitHub Releases of perrychapman/OrgAI for a newer version, downloads it only when the user asks
and installs it only through "Restart and install" (or on the next normal quit once downloaded). Desktop only: the
`orgai` CLI has no updater and never loads electron-updater. Each fact below says how it was checked; "unverified" means
no test or run confirmed it. A live update against a real published release is UNVERIFIED (no release has carried the
metadata yet).

## Contract

- `src/shared/types.ts` section "Desktop auto-update" (end of file): `UpdateCapability` ('auto' | 'manual' | 'none'),
  `UpdateCapabilityReason` ('dev' | 'test' | 'portable' | 'unpacked' | 'platform'), `UpdateStatus`, `UpdateProgress`,
  `UpdateState`, `UpdateRefusal`, `UpdateActionResult`, `UpdateInstallInput`, the constants (`UPDATE_RELEASES_URL`,
  `UPDATE_NOTES_MAX_CHARS` 4000, `UPDATE_ERROR_MAX_CHARS` 200, `UPDATE_VERSION_MAX_CHARS` 64,
  `UPDATE_FIRST_CHECK_DELAY_MS` 30 s, `UPDATE_CHECK_INTERVAL_MS` 6 h), `UPDATE_MOCK_MODES`, `UPDATE_MOCK_VERSION`,
  `UPDATES_IPC` (declared like `SCHEDULES_IPC`, not spread into `IPC`), `OrgAIApi.updates` and `onUpdatesChanged`.
  `AppSettings.autoUpdateCheck` (optional in the type like `communityPrices`; `store/settings.ts` always writes an
  explicit boolean, default true). Menu action `'check-for-updates'`. Typecheck covers the renderer side.
- Channels, all desktop only (`DESKTOP_ONLY_CHANNELS`, registry `desktop_only`, never on the bus or a socket):
  `updates:get`, `updates:check`, `updates:download`, `updates:install` (`{ force?: true }`), `updates:openReleasePage`,
  push `updates:changed`. Download and install are leased mutations (`DESKTOP_CHANNEL_MUTATES`). Unit-tested
  (`ipcAdapter`, `registry`, `dispatcher`, `params`, `jsonRoundTrip`, `events`, `updaterIpc.test.ts`).

## Main

- `src/main/updater.ts` (Electron-free, electron-updater-free): `updateCapability` / `resolveUpdaterSetup` (pure),
  `plainReleaseNotes`, `updateErrorText`, `releaseUrlFor`, `isUpdateVersion`, `updateInstallArgs` and the
  `UpdateController` state machine over an injected `UpdaterLike`. `updater.test.ts` drives every transition with a fake:
  check -> available -> download progress -> downloaded -> install refused with live runs -> forced install; errors;
  manual and none; the setting stopping and re-arming the timer; no overlapping checks.
- Capability (unit-tested): unpackaged = 'none' ('dev'); packaged with `ORGAI_MOCK=1` (e2e, verify-pack) = 'none'
  ('test'); Windows with `PORTABLE_EXECUTABLE_DIR` = 'manual' ('portable'); Windows without `Uninstall OrgAI.exe` beside
  the executable = 'manual' ('unpacked', e.g. `release/win-unpacked`; the name comes from app-builder-lib
  `templates/nsis/common.nsh` UNINSTALL_FILENAME, read in node_modules); other Windows = 'auto'; macOS and Linux =
  'manual' ('platform'). macOS is manual because Squirrel.Mac needs a signed app and our builds are unsigned unless the
  CSC_LINK secret is set; no signature detection is attempted (open item).
- `src/main/updaterRuntime.ts`: `createDesktopUpdates` picks the source; electron-updater is loaded with a dynamic
  `import('electron-updater')` only for a packaged 'auto' / 'manual' app, so a dev, mock or e2e launch never loads it
  and makes no request (unit-tested with a mocked module that records loading; `out/main/index.js` keeps the import
  external, checked after `npm run build`). Settings applied: `autoDownload = false`, `allowPrerelease = false`,
  `allowDowngrade = false`, `fullChangelog = false`, `autoInstallOnAppQuit = true`; `setFeedURL` is never called, no
  request header or token is set, and an `'error'` listener is attached (an unhandled emit would throw). API checked
  against the installed typings of electron-updater 6.8.11 (`AppUpdater.d.ts`, `BaseUpdater.d.ts`).
- `src/main/updaterMock.ts`: the `ORGAI_UPDATE_MOCK` fake (below). Never used by a packaged app (unit-tested).
- Checks: once `UPDATE_FIRST_CHECK_DELAY_MS` after launch, then every `UPDATE_CHECK_INTERVAL_MS`, only while
  `autoUpdateCheck` is on; a settings change arms or disarms the timer; a manual check always works; a check joins one in
  flight and never runs while downloading, downloaded or installing (unit-tested with fake timers).
- Install (unit-tested with the fake): refused 'unsupported' unless 'auto', 'not-downloaded' unless downloaded,
  'active-runs' (with `activeRuns`) while `RunManager.liveRunCount()` > 0 unless `force` is exactly true, 'quitting'
  while the app quits. Accepted: `app.quit()` on the next tick, so `desktopQuit.ts`'s before-quit runs the shutdown
  coordinator exactly as Quit does (runs stopped and persisted, continuable); `index.ts` calls
  `UpdateController.onAppQuit` from the app's `'quit'` event, which calls `BaseUpdater.install(true, true)` (silent,
  run the app afterwards). Our `'quit'` listener is registered at boot, before electron-updater adds its own after a
  download, so it runs first; electron-updater's then sees `quitAndInstallCalled` and skips (read in
  `node_modules/electron-updater/out/BaseUpdater.js`). Without an accepted install, a downloaded update installs
  silently on the next normal quit through electron-updater's own `'quit'` handler (exit code 0 only), also after the
  shutdown. The 'quit' ordering and the installer run are UNVERIFIED live. A quit that ends through `app.exit` (the
  shutdown failing, the 60 s hard limit) emits no `'quit'`, so nothing installs then.
- Menu: "Check for Updates…" in the OrgAI menu on macOS (after About) and in Help elsewhere (before About OrgAI); its
  click starts `updates.check()` in main, then sends `'check-for-updates'` to the main window (target 'main'). Unit-tested
  in `appMenu.test.ts`; the renderer's handling is the UI lead's (until then the action is ignored by the renderer).

## Security

- No handler takes a URL, path or version from the renderer; install takes only `{ force: true }` (`updateInstallArgs`
  rebuilds it; anything else is `force: false` or refused). Every handler refuses a sender that is not an OrgAI
  `BrowserWindow` (unit-tested in `updaterIpc.test.ts`).
- The feed is the embedded `resources/app-update.yml` (electron-builder.yml `publish: github perrychapman/OrgAI`); no
  `setFeedURL` in any build. The release page is `UPDATE_RELEASES_URL` + `/tag/v<semver>` built in main from a version
  validated by `isUpdateVersion`; a URL from the feed is never opened. Unit-tested.
- Release notes are untrusted: script/style dropped, tags stripped, entities decoded once, C0/C1, bidi and zero-width
  characters removed, at most 4000 characters, before they cross IPC; the renderer must show them as text only.
  Unit-tested.
- Errors cross IPC as one of the fixed sentences of `UPDATE_ERROR_TEXT` (never a path, URL or token); the raw message
  goes to the log only. Unit-tested.
- Known limitation: Windows builds are unsigned, so electron-updater performs no Authenticode publisher check; integrity
  rests on the sha512 in `latest.yml`, fetched over TLS from GitHub (an attacker who can publish a release on the repo can
  ship an update). Nothing electron-updater verifies is disabled.
- The download cache is written by electron-updater outside the data folder (OS per-user cache,
  `<updaterCacheDirName>/pending`), recorded in `writePathInventory.allowlist.ts` as a comment (no call site in our code).

## Packaging and release

- `electron-builder.yml` has the `publish` block only so `app-update.yml` is embedded; every build passes
  `--publish never` (package.json `dist*` scripts, `scripts/pack-local.mjs`, release.yml). `src/cli/packaging.test.ts`
  checks the block and every `--publish never`. `npm run pack -- --dry-run` still prints `--dir --publish never`.
- `release.yml` publish job: checks out the commit, `node scripts/merge-latest-mac.mjs` merges the arm64 and x64
  `latest-mac.yml` into one (fails closed on a missing leg, version mismatch, duplicate or path-like url, arch mixup;
  `scripts/merge-latest-mac.test.mjs` in `test:scripts`) and copies the windows `latest.yml`; both are attached to the
  draft by explicit path. The updater sees a release only once the draft is published by hand, and ignores releases
  marked prerelease (`allowPrerelease = false`). A merged sample parses with the js-yaml 4 electron-updater uses
  (checked by hand with the script's exports; sizes stay numbers). The workflow has not run with these steps
  (UNVERIFIED: the download-artifact folder layout and electron-updater picking the arch file from the merged list).
- Update payloads: the NSIS installer and its `.blockmap` (Windows, differential download), the mac zip (manual for now).
  The portable exe and the dmg are manual downloads only.

## ORGAI_UPDATE_MOCK (renderer e2e)

Honoured only when the app is NOT packaged; an unknown value is ignored (capability 'none'). No network, no installer.

- `up-to-date`: capability 'auto'; checks find nothing.
- `available`: 'auto'; a check finds `UPDATE_MOCK_VERSION` (99.0.0) with HTML notes (shown as text); a download steps
  10/35/60/85/100 % every 150 ms, then 'downloaded'; `updates:install` answers as for real (live runs refuse without
  force) but neither runs an installer nor quits.
- `download-error`: like `available`, but the download fails at 60 % (error text: the offline sentence).
- `error`: 'auto'; every check fails (the offline sentence).
- `manual`: capability 'manual' (reason 'platform'); a check finds 99.0.0; download and install are refused.

The launch check also runs (30 s after launch) when `autoUpdateCheck` is on; an e2e can call `updates.check()` directly.

## Renderer

- One source of truth: `src/renderer/src/store/updatesStore.ts` (zustand). `ensureUpdates()` (called by both surfaces,
  idempotent) reads `updates.get()` once and subscribes to `onUpdatesChanged`; a push that lands before the `get()`
  answer wins; no polling. `check()`'s answer is not written to the store (the push carries it; an answer could be
  older than a push). A failed `get()` lets the next mount retry. Checked by `e2e/updates.mjs` (every state below
  arrives through pushes) and code reading.
- Pure mapping in `lib/updates.ts` (`updates.test.ts`, every status, capability, reason and refusal): the status line,
  the one primary action per state (Check for updates / Checking… -> Download update (auto) or Open release page
  (manual) -> Downloading… -> Restart and install -> Restarting…; a failed download keeps its version and offers Retry
  download, a failed check Check again; 'manual' never offers download or install; 'none' offers nothing), the
  capability notes, the refusal sentences, the active-runs confirmation body and the announcements.
- App settings > About > Updates (`components/updates/UpdatesSection.tsx`, testid `updates-block`, section id
  `appsettings-section-updates`, after the About card): installed version, status line, the capability note
  ('manual'), "Last checked <date time>", a native `<progress>` with `aria-label` and `aria-valuetext` (percent and
  MB) plus a visible text equivalent, the primary action (`updates-action`, one element whose label follows the state;
  `inert` while busy so focus stays on it), a ghost "Open release page" beside Download / Restart for 'auto', a
  feedback line for refusals, the release notes and the "Check for updates automatically" switch bound to
  `autoUpdateCheck` (missing = on; saved at once through AppSettingsView's `patch`). Checked by `e2e/updates.mjs`
  (all five mock modes, both themes, 1024x640 and 1600x1000 without horizontal overflow, the switch persisting across a
  relaunch).
- Release notes are a React text node in a bounded (12rem) scroller (`white-space: pre-wrap`, focusable region named
  "What's new in <v>"); no HTML, Markdown, auto-linking or `dangerouslySetInnerHTML`. `releaseUrl` is never rendered;
  both release-page buttons call `updates.openReleasePage()` with no argument. e2e: the mock's notes arrive as text
  (main stripped the tags), and a crafted `updates:changed` push with `<img onerror>`, `<b>`, a Markdown link and a URL
  renders as the exact literal text with no element and no script run; no anchor to github.com exists in the block;
  Open release page opens `/releases/tag/v99.0.0` through main (`shell.openExternal` stubbed in the e2e).
- Install: `install()` first; on 'active-runs' a `useConfirm` dialog ("Stop runs and install the update?", body
  "Installing restarts OrgAI and stops N working run(s). They stay in History and can be continued, as after Quit.",
  focus on Not now, Esc cancels). After the confirmation the renderer asks again without force and sends
  `install({ force: true })` only when main's count is not above the confirmed one; a higher count asks again. Not now
  says the update installs on the next quit. Every other refusal is one sentence. e2e: dialog with the count, Not now
  leaves `installing` false, the confirmation shows "Restarting to install version 99.0.0…". A run started between the
  final count and the forced call is still stopped (window of one IPC round trip; unverified live).
- Sidebar notice (`components/updates/UpdateNotice.tsx`, inserted above the account footer in `Sidebar.tsx`): "Update
  available: <v>" or "Update ready: <v>" when a newer version is available, downloading or downloaded; hidden on App
  settings, after an install started and for a version dismissed this session (memory only). It never takes focus or
  covers a view; activating it opens About with the Updates heading focused; Dismiss moves focus to the App settings
  button. In the rail it is one icon button (named with the text) without Dismiss. e2e checks text, no focus move,
  open, dismiss and focus after dismiss.
- Help > Check for Updates… (`'check-for-updates'`): `lib/menuActions.ts` `openUpdates()` opens App settings > About
  and the block scrolls to (`scrollWithin`) and focuses its heading (`appsettings-updates-title`); a focus request older
  than 5 s is dropped. e2e: the menu item clicked in main lands focus on the heading and the check result shows.
- Announcements: one sr-only polite region per surface (`updates-announce` in the block, one in the notice). Spoken: a
  status change, a new error, "Download halfway." once (never per step), the finished download, the restart, refusals
  (cleared first so a repeat is read again). The notice does not repeat what the block already said. Speech itself is
  UNVERIFIED (no screen reader run). No animation was added (reduced motion has nothing to stop).
- Atlas: `APP_SETTING_DOCS.autoUpdateCheck` points at `app-settings-about` with honest wording (about 30 s after
  launch; never downloads on its own; a downloaded update installs on restart or the next quit).
- Mock walkthrough: `docs/design/ux-review-updates.md` (no High; fixes and accepted items in its Resolution section).

## Open items

- A live update (check, download, install, relaunch) against a real published release: UNVERIFIED.
- macOS auto-install needs a signed and notarized app; until then macOS stays 'manual'.
- Linux AppImage auto-install is not offered (Linux is 'manual'); checks need `APPIMAGE` set, otherwise a check reports
  "Update checks are not available for this install."
- Renderer: screen-reader speech of the two polite regions, the rail notice without Dismiss, the sidebar notice's faint
  Dismiss in the light theme (ux-review-updates L5) and the Updates block below the fold at 1024x640 when reached by the
  gear (M3, accepted) remain. `e2e/updates.mjs` covers the UI against `ORGAI_UPDATE_MOCK` only.
