---
name: verify-and-report
description: "Checklist for finishing OrgAI work: which checks to run in what order, which commands need the user's consent, how to read a failure, and what a report must contain. Use before reporting any code change as done and before a gate or push decision."
---

# Verify and report

## The local gate (before a push)

Keep it fast. CI runs the full suite on Windows and macOS after every push, so do not repeat it locally.

| Step | Command | When |
| --- | --- | --- |
| Types | `npm run typecheck` | every code change |
| Unit tests | `npm test` (one area while working: `npx vitest run <path>`) | every code change; the whole suite before a push |
| Build | `npm run build` | before any e2e or driving the app |
| e2e | only the scripts for the area you changed: `node e2e/<name>.mjs` | any UI change, or main-process change a script drives |

Do NOT run the whole `npm run e2e:free` chain locally as a gate. Run it whole only when the user asks, or to reproduce a CI failure.

Update e2e selectors in the same change as the UI. New logic gets a `*.test.ts` beside the module.

In worktrees, give Bash plain commands and edit with Edit and Write. A worktree whose `package-lock.json` changed needs `npm ci` before tests.

## CI is the full gate

CI (`.github/workflows/ci.yml`, windows-latest and macos-15) runs typecheck, `npm test`, build, the whole `e2e:free` and the pack jobs on every push to dev. The orchestrator checks the push's run with `gh run list`. A red run is a blocker: triage it at once (`gh run view <id> --log-failed`; e2e screenshots in the `e2e-shots-<OS>` artifacts), fix, push again. Other runs should not push on top of a red dev except to fix it.

The CI runners differ from a dev machine: 8.3 temp paths (`C:\Users\RUNNER~1`), the checkout on `D:` with temp on `C:`, slower CPUs, no git identity.

## CI has no login

The CI runners have no Claude login and no API key: every connection reads "Not connected", the Connections pane shows the "No connection is set up" Banner (a second `role=status` region), the role Model picker renders a disabled `role-model` select with no `role-model-advanced` / `role-exact-model`, assistant lines show no "Runs on" model, and the project General pane has extra tab stops. A dev machine that is logged in hides all of this.

- When your change touches connections, models, role Model pickers, usage or tab-stop counts, run those e2e scripts a second time with `CLAUDE_CONFIG_DIR` set to a fresh empty temp dir (the CLI then reports logged out, the runner's state). Both runs must pass.
- Skip only the checks that genuinely need a connected connection, with a `SKIP <what>: no connection connected` line, keyed on the real state (`window.orgai.connections.list()` any `status.state === 'connected'`, or the control being disabled), never on a size or theme.
- An element inside a closed `<details>` is attached but hidden: wait with `{ state: 'attached' }` before reading `isDisabled()` on it.
- Do not read `isVisible()` right after a click: wait for the expected state (`waitFor({ timeout })`).

## Ask first

These need the user's explicit consent each time. Never run them in a loop:

- Anything under `scripts/smoke-*`, except `smoke-litellm` without `--yes`.
- `e2e/setup.mjs`, `e2e/history.mjs`, `e2e/worktree.mjs`: they spend tokens.
- `npm run probe:connectors`: token-free, but it uses the network.

## When something fails

- A failed e2e script keeps its temp data dir and prints the path. Read `logs/main.log` there. Shots are in `e2e/shots/`.
- Fix the cause. Do not loosen a check to pass it, and do not report a failure you skipped as passing.
- If a failure predates your change, show that and report it separately.

## Before you report

- Contract changes landed in `src/shared/types.ts` first.
- A change to the stack, layout, conventions or commands is recorded in `.orgai/ARCHITECTURE.md`.
- A new fact in `CLAUDE.md` says how it was checked.
- Flag it if the work needs a UX walkthrough (user-facing) or a Reviewer pass (security-relevant). Critical or high findings block.

Reports do not push. The orchestrator pushes `dev` after the local gate, never a red tree and never `main`, then checks that push's CI.

## The report

1. **Result**: what now works, in one or two sentences.
2. **Files touched**: every file.
3. **Checks**: each command run and its result. List what you did not run.
4. **How each claim was checked**: unit test, mock, e2e or live. Say `Unverified` when no run confirmed it.
5. **Open items**: known gaps, follow-ups and anything you need decided.
