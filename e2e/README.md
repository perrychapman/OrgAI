# End-to-end scripts

Plain Node scripts that launch the **built** app with playwright-core's Electron driver and click through real
flows. Run `npm run build` first; the scripts use `out/` and never the dev server.

| script | tokens | what it checks |
| --- | --- | --- |
| `layout.mjs` | free | create projects in both form modes with setup skipped; live view layout with a long path; delete |
| `maintenance.mjs` | free | plants leftover worktrees and setup files in a fixture repo; merge, conflict, refusal, discard, uninstall |
| `setup.mjs --yes [--new]` | **spends** | full Architect setup, one org-chart revision, applied roles and architecture files |
| `history.mjs --yes` | **spends** | setup run, app restart, run reopened from the Runs tab, records removed with the project |
| `worktree.mjs --yes` | **spends** | two parallel writing reports in isolated worktrees, both merged back |

```sh
npm run build
npm run e2e:free           # layout + maintenance
node e2e/setup.mjs --yes   # prints a cost estimate; exits 2 without --yes
```

- Each script creates its own fixture repository (a tiny Express notes API, dependencies not installed) under
  `os.tmpdir()`, deletes the OrgAI project it created, and removes the fixture.
- The app runs against the real user data directory (`%APPDATA%/orgai` on Windows), so your other projects show up.
  Test projects are named `... (orgai test)`; delete leftovers by hand if a script is killed.
- Output is a `PASS`/`FAIL` line per check; the exit code is 1 when any check failed.
- Screenshots go to `e2e/shots/` (gitignored).
- `lib.mjs` has the shared pieces: `launch`, `createProject`, `deleteProject`, `makeFixtureRepo`, `driveSetup`,
  `check`/`finish`, `screenshot`.
