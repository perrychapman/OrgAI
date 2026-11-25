# End-to-end scripts

Plain Node scripts that launch the **built** app with playwright-core's Electron driver and click through real
flows. Run `npm run build` first; the scripts use `out/` and never the dev server.

| script | tokens | what it checks |
| --- | --- | --- |
| `layout.mjs` | free | create projects in both form modes with setup skipped; live view layout with a long path; delete |
| `connections.mjs` | free | Connections page (three cards or a load error), project settings sections (connection, MCP servers, plugins, Add from registry), role model picker and tier badge, the project mock-adapter toggle (on saves provider.id mock and disables the connection fieldset, off restores it) and the App settings About block (version, data folder) at 1024x640 and 1600x1000 in both themes; a LiteLLM test against an unreachable URL shows an error, the key never lands in plain text, and Remove connection clears it |
| `permissions.mjs` | free | permission card glance block (what, where it starts, Always allow sentence), rules panel validation, Allowed folders, Settings > Agents trade-off copy, and the `[mock:fatigue]` run: `Bash(npm test:*)` chip, "Outside the project" edit card, no card for the repeat `cd ... && npm test` after Allow for session |
| `maintenance.mjs` | free | plants leftover worktrees and setup files in a fixture repo; merge, conflict, refusal, discard, uninstall |
| `setup.mjs --yes [--new]` | **spends** | full Architect setup, one org-chart revision, applied roles and architecture files |
| `history.mjs --yes` | **spends** | setup run, app restart, run reopened from the Runs tab, records removed with the project |
| `worktree.mjs --yes` | **spends** | two parallel writing reports in isolated worktrees, both merged back |

```sh
npm run build
npm run e2e:free           # the whole free chain (package.json)
node scripts/e2e-select.mjs --base <sha> --head <sha> --print   # which scripts CI runs for a change (--run runs them, --full forces all)
node e2e/setup.mjs --yes   # prints a cost estimate; exits 2 without --yes
```

- Each script creates its own fixture repository (a tiny Express notes API, dependencies not installed) under
  `os.tmpdir()`, deletes the OrgAI project it created, and removes the fixture.
- The app runs against a fresh temp data dir, or `E2E_DATA_DIR` if you set it (an ambient `ORGAI_DATA_DIR`, as CI sets, is ignored so scripts never share state). `lib.mjs` passes the dir to the
  app as `ORGAI_DATA_DIR`, which replaces Electron's userData and also holds the logs (`<dir>/logs/main.log`), so
  your real profile, `~/Library/Logs` on macOS and your other projects are never touched. A temp dir is removed when
  the script passes and kept (its path is printed) when a check fails. With your own `E2E_DATA_DIR`, test projects
  are named `... (orgai test)`; delete leftovers by hand if a script is killed.
- Paths compare against `fs.realpathSync(os.tmpdir())` (`TMP` in `lib.mjs`), because macOS reports `/private/var/...`
  for `/var/...`.
- Output is a `PASS`/`FAIL` line per check; the exit code is 1 when any check failed.
- Screenshots go to `e2e/shots/` (gitignored).
- `lib.mjs` has the shared pieces: `launch`, `createProject`, `deleteProject`, `makeFixtureRepo`, `driveSetup`,
  `check`/`finish`, `screenshot`.
- Slow runners: `E2E_TIME_SCALE=N` (default 1, 3 when `CI` is set; logged once at launch) stretches how long every WAIT may
  take, never a sleep. It scales Playwright's default and navigation timeouts on every window the app opens, every
  `page.setDefaultTimeout(ms)` a script calls and the shared helpers; scripts write their own explicit timeouts as
  `{ timeout: t(8000) }` (`t` is exported by `lib.mjs`) and poll with `until(fn, ms)`. A wait ends the moment its state is
  there, so a fast machine loses nothing. Do not wrap a sleep that orders two things in `t()`: wait on a standing state
  (a MutationObserver installed before the action, `settleUI`, `showFinishedAgents`, a mock hold such as
  `[mock:revise-hold]` or `[mock:model-switch-hold]`).
- "Hide finished agents" (View menu in the run toolbar) is the renderer's own `localStorage['orgai.collapseFinished']`, read
  when a run view mounts. `showFinishedAgents(page, show)` clicks the switch and throws with the page state if it never
  reaches the wanted value, so do not `.catch(() => {})` it away; `resetFinishedAgentsChoice(page)` restores the default (on)
  through the key, for the next run or a reload, when a script needs a known start without another menu interaction.
- Review data (a tool, not a test; not in `e2e:free`): `E2E_DATA_DIR=<folder> node e2e/seed-review.mjs` fills a data folder with
  five projects (code and engagements), runs in many states, outputs with versions and notes, knowledge, to-dos, schedules, a
  Chat, pending decisions and a spending limit, token-free on the mock adapter, so the UI can be reviewed by hand. It refuses
  to run without `E2E_DATA_DIR`, refuses a folder that already holds projects unless `--force`, never deletes anything, and
  puts its throwaway repositories in `<folder>-work`. Run records are spread over two weeks (`--no-backdate` keeps them on
  today). Open the folder afterwards with `ORGAI_MOCK=1` and `ORGAI_DATA_DIR=<folder>`. Runs that were live or waiting come
  back ended and their cards are gone after a restart; `E2E_DATA_DIR=<folder> node e2e/seed-review.mjs --live` opens a seeded
  folder, starts live, waiting and Chat runs again and keeps that window open until it is closed.
- Windows and notifications of a local run (`appEnv()` in `lib.mjs`, used by `launch()`, `relaunch()` and factory-floor's own
  launch; logged once at launch). Locally (`CI` not set, `E2E_FOREGROUND` not `1`) the app starts with `ORGAI_WINDOW_HIDDEN=1`:
  the window is shown to Chromium (so it paints and keeps its frames, timers and visibility) but fully transparent,
  click-through, off the taskbar and shown inactive, so nothing appears on screen and no focus is taken on Windows (observed);
  on macOS Electron may still make the app the active app at launch regardless of `showInactive` (unverified, no Mac
  run), and on Linux the window is simply never shown. The app honours `ORGAI_WINDOW_HIDDEN` and `ORGAI_QUIET` only when
  `ORGAI_DATA_DIR` is also set (`appEnv()` always sets it). `E2E_FOREGROUND=1`
  gives the normal visible window. A script that genuinely needs a shown window passes `window: 'inactive'` to `launch()` /
  `relaunch()` (`ORGAI_WINDOW_INACTIVE=1`: shown, never focused); `window: 'foreground'` leaves the app's default (the
  seed-review `--live` session). A value the caller sets for `ORGAI_WINDOW_HIDDEN` or `ORGAI_WINDOW_INACTIVE` is never
  overridden. CI is unchanged (visible windows). Separately `ORGAI_QUIET=1` is set on every launch, locally and in CI: no OS
  notification, taskbar flash or Dock bounce (`src/main/quietMode.ts`; everything before that last step, the Inbox included,
  behaves as before); `E2E_NOTIFY=1` opts out. No script asserts a real OS notification.
- To try a slow runner on a fast machine: `E2E_CPU_THROTTLE=4` (CDP CPU throttling of the renderer), two cores
  (`cmd /c start /affinity 5 /wait /b node e2e/<script>.mjs` on Windows) and `E2E_TIME_SCALE=3`;
  `E2E_CLAMP_WINDOW=1024x656` opens the window as the macOS runner's small screen does.
