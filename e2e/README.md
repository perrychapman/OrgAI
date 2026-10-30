# End-to-end scripts

Plain Node scripts that launch the **built** app with playwright-core's Electron driver and click through real
flows. Run `npm run build` first; the scripts use `out/` and never the dev server.

| script | tokens | what it checks |
| --- | --- | --- |
| `layout.mjs` | free | create projects in both form modes with setup skipped; live view layout with a long path; delete |
| `connections.mjs` | free | Connections page (three cards or a load error), project settings sections (connection, MCP servers, plugins, Add from registry), role model picker and tier badge at 1024x640 and 1600x1000 in both themes; a LiteLLM test against an unreachable URL shows an error, the key never lands in plain text, and Remove connection clears it |
| `maintenance.mjs` | free | plants leftover worktrees and setup files in a fixture repo; merge, conflict, refusal, discard, uninstall |
| `setup.mjs --yes [--new]` | **spends** | full Architect setup, one org-chart revision, applied roles and architecture files |
| `history.mjs --yes` | **spends** | setup run, app restart, run reopened from the Runs tab, records removed with the project |
| `worktree.mjs --yes` | **spends** | two parallel writing reports in isolated worktrees, both merged back |

```sh
npm run build
npm run e2e:free           # layout + maintenance + connections
node e2e/setup.mjs --yes   # prints a cost estimate; exits 2 without --yes
```

- Each script creates its own fixture repository (a tiny Express notes API, dependencies not installed) under
  `os.tmpdir()`, deletes the OrgAI project it created, and removes the fixture.
- The app runs against a fresh temp data dir, or `ORGAI_DATA_DIR` if you set it. `lib.mjs` passes the dir to the
  app as `ORGAI_DATA_DIR`, which replaces Electron's userData and also holds the logs (`<dir>/logs/main.log`), so
  your real profile, `~/Library/Logs` on macOS and your other projects are never touched. A temp dir is removed when
  the script passes and kept (its path is printed) when a check fails. With your own `ORGAI_DATA_DIR`, test projects
  are named `... (orgai test)`; delete leftovers by hand if a script is killed.
- Paths compare against `fs.realpathSync(os.tmpdir())` (`TMP` in `lib.mjs`), because macOS reports `/private/var/...`
  for `/var/...`.
- Output is a `PASS`/`FAIL` line per check; the exit code is 1 when any check failed.
- Screenshots go to `e2e/shots/` (gitignored).
- `lib.mjs` has the shared pieces: `launch`, `createProject`, `deleteProject`, `makeFixtureRepo`, `driveSetup`,
  `check`/`finish`, `screenshot`.
