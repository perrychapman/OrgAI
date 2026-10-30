# Local testing guide

Command-first. Steps are marked **free (mock)** (no tokens) or **spends tokens** (needs a real login and the owner's
consent). "e2e" names the script that already automates a step; everything else is manual.

## 1. Prerequisites

- Node >= 22 (`engines`), npm 10+, git on PATH (worktree isolation needs it).
- `npm install` (`npm ci` for a clean tree). It installs the Electron 45 binary and the native Claude and Codex CLIs.
- Anthropic runs: the `claude` CLI logged in (`claude auth status`), or an API key. Free testing needs neither.
- Optional: `codex` login for the OpenAI connection (OrgAI keeps its own Codex home in `<data>/codex`), a LiteLLM proxy
  URL and key, `npx`/`uvx`/`docker` for MCP servers.

Versions observed on the baseline run (Windows 11, 2026-10-29): Node v22.22.3, npm 10.9.8, git 2.47.0.windows.2,
Electron 45.1.0, electron-vite 6.0.0, Vite 8.3.5, TypeScript 7.0.2, vitest ^3.2.4, Claude Agent SDK 0.3.312,
@openai/codex 0.166.0.

## 2. The free gate

```sh
npm run check        # typecheck && test && build && e2e:free (script added by the Runtime Lead)
```

Or each step on its own (always in this order, because e2e uses `out/`):

| command | covers | observed |
| --- | --- | --- |
| `npm run typecheck` | `tsc --noEmit` for `tsconfig.node.json` and `tsconfig.web.json` | pass, ~1 s |
| `npm test` | vitest, node env, `*.test.ts` beside modules: 51 files, 639 passed, 2 skipped (the live `codex app-server` suite, `describe.skipIf(!live)` in `codexAppServer.test.ts`) | pass, ~21 s |
| `npm run build` | `electron-vite build` into `out/` (main, preload, renderer) | pass, ~2 s (renderer bundle is ~2 MB) |
| `npm run e2e:free` | `layout.mjs`, `maintenance.mjs`, `connections.mjs` against `out/` with the mock adapter: 103 PASS, 0 FAIL | pass, ~43 s |

The e2e scripts print one `PASS`/`FAIL` line per check and exit 1 on any FAIL. A temp data dir is kept (path printed)
when a check fails. Screenshots go to `e2e/shots/` (gitignored). Nothing in the gate spends tokens or touches your real
profile (`ORGAI_DATA_DIR` is set to a temp dir).

## 3. Token-free interactive testing

```sh
# bash
ORGAI_MOCK=1 ORGAI_DATA_DIR=/tmp/orgai-scratch npm run dev
# PowerShell
$env:ORGAI_MOCK='1'; $env:ORGAI_DATA_DIR="$env:TEMP\orgai-scratch"; npm run dev
```

`ORGAI_MOCK=1` registers the `MockAdapter` (`src/main/runtime/mock.ts`). `ORGAI_DATA_DIR` replaces userData and holds the
logs, so your real projects and runs are untouched. Delete the directory to reset.

### Putting a project on the mock adapter

- **Today:** create the project in the UI (any form mode; "Skip AI setup" is simplest), quit the app, edit
  `<data>/projects.json` and set `"provider": { "id": "mock", ... }` on that project (keep the other fields), then start
  the app again. The `mock` id exists in `ProviderId` and only works with `ORGAI_MOCK=1`.
- **After this change (not verified here):** a project-settings toggle for the mock adapter lands in the UI. Use it
  instead of editing JSON.

The e2e scripts set `ORGAI_MOCK=1` themselves and drive the same adapter.

### What the default script exercises

`DEFAULT_MOCK_SCRIPT` (400 ms between steps) plays:

- **Work run:** thinking, text, a `Read` tool, a spawned report (`mock-report-1`) that reads and then edits with an
  **approval** (`ask: true`), finishes with a report-back, and the orchestrator summarises. Follow-up messages get
  `Mock reply to: {text}`.
- **Setup run (Architect):** `Glob`, a `Bash` call that needs approval, then `propose_architecture`,
  `propose_org_chart` (Lead + Engineer), `propose_settings` and `complete_setup`. Each proposal waits for Approve or
  Request changes (a revise re-runs the call).
- **MCP assist run:** `list_mcp_servers`, `search_mcp_registry`, a proposal for a `mock-fs` server.
- Step types also cover `message` (agent to agent), `plan` / `planUpdate` / `planComplete`, `rateLimit`, `background`
  tool calls and any harness tool by name, so `ask_user`, install cards and plan nudges are scriptable. `continue` holds
  the turns played for automatic nudges.
- The default script touches no real files, so it raises no merge card. Use `e2e/maintenance.mjs` for leftover
  worktrees.

### Custom scripts

`ORGAI_MOCK_SCRIPT=<path to JSON>` loads a `MockScript` (`delayMs`, `work`, `setup`, `mcpAssist`, `reply`, `continue`);
missing keys come from the default. A bad path or bad JSON logs an error and falls back to the default.

```json
{ "delayMs": 150,
  "work": [
    { "type": "plan", "goal": "Demo", "steps": ["Read", { "title": "Edit", "owner": "engineer" }] },
    { "type": "harness", "name": "ask_user", "args": { "question": "Which file?" } },
    { "type": "text", "text": "Done." }
  ],
  "continue": [[{ "type": "text", "text": "Nudge received." }]] }
```

Check the exact harness-tool argument shapes in `src/main/runtime/harnessTools.ts` before scripting them (the `ask_user`
args above are illustrative).

## 4. Manual test checklist

Run these in the mock-enabled dev app unless a step says otherwise. Test at both **1024x640** and **1600x1000** (the e2e
window sizes) in dark and light themes.

### Projects
1. New project, "Existing repository" mode: pick a git folder, name it, tick "Skip AI setup". Expect the org chart
   editor with 4 default roles and no setup run. free (mock). e2e: `layout.mjs`.
2. New project, "New idea" mode: enter a brief and folder. Expect the project and its stored brief. free (mock). e2e: `layout.mjs`.
3. Delete a project (in-app confirm dialog). Expect it gone from the sidebar and its run records removed from
   `<data>/runs`. free (mock). e2e: `layout.mjs`; `history.mjs` for run records (spends tokens).
4. Long project path: sidebar stays visible, path pill fits, no horizontal page scroll. free. e2e: `layout.mjs`.

### Setup / Architect
1. Create a project with AI setup on (mock provider). Expect an Architect run: tool calls, an approval for `Bash`
   (Allow / Deny), then an architecture proposal card. free (mock). e2e: `setup.mjs` (spends tokens, real Architect).
2. Approve the architecture, request changes on the org chart once, then approve. Expect the proposal to re-run and
   `complete_setup`. free (mock).
3. Expect applied results: roles in the editor, project settings, and `.orgai/ARCHITECTURE.md` in the repo (plus a
   CLAUDE.md section and an exclude line). free (mock).
4. For an existing project, the repo profiler runs before the interview without tokens. free.

### Org chart editor
1. Select a role: inspector shows name, prompt, tools, model picker and tier badge. free. e2e: `connections.mjs` (picker and badge).
2. Add a role, set Reports to, toggle canSpawn and the spawnable list. Expect the edge to appear and the dagre layout
   to re-flow; deleting a role removes or re-parents its edges. free.
3. Change tier and model; switching the project connection reports a remap notice with Undo (see Connections). free.
4. Save, reload the app: the chart persists. free.

### Live run view
1. Start a work run with a task. Expect nodes spawning on the canvas, activity text moving, cost and token numbers
   rising, and transcript entries per agent. free (mock).
2. Approval: the report's `Edit` raises an approval card in a layout region (never floating over the canvas); Allow,
   Allow for session, Deny. Expect the run to continue or the tool to report denial. free (mock).
3. `ask_user` card (custom script): answer by option or free text; the run resumes. free (mock, custom script).
4. Plan panel: scripted `plan` / `planUpdate` steps tick through; with autoContinue on, a turn that ends with work left
   is followed by a harness nudge until the plan completes, `maxAutoContinues` is hit or a step is blocked. Setup runs
   are never nudged. free (mock, custom script with `continue`).
5. Interrupt: press Stop mid-run. Expect agents to stop, nudging to hold, and the run to end as stopped, not errored. free (mock).
6. Image paste: paste a PNG into the composer. Expect a thumbnail with a "Remove image 1" button, the composer keeping
   its size, a thumbnail in the sent transcript entry, the file under `<data>/runs/<id>/images/`, and it rehydrating
   after reload. free (mock). e2e: `layout.mjs`.
7. `rateLimit` step: the run ends with a rate-limit state. free (mock, custom script).
8. A real Claude run end to end (one short task). spends tokens. e2e: only `worktree.mjs` covers a work run.

### Runs tab, history and Continue
1. After a run, the run strip lists it; opening it from the Runs tab redraws canvas and transcript from disk. free (mock).
   e2e: `layout.mjs` (reopen); `history.mjs` (with restart; spends tokens).
2. Continue a finished run: expect a new run chained to it; Continue is offered only on the chain's newest member. While
   a chain member is live, Continue is refused with "Session already open: run <id> ...". free (mock).
3. Quit the app mid-run and restart: the run shows as finished (ended with app) and stays continuable. free (mock).
4. Visible focus ring on run chips at both sizes. free. e2e: `layout.mjs`.

### Worktrees and maintenance
1. Run `node e2e/maintenance.mjs` (free): it plants a clean branch, a conflicting branch and setup files.
2. By hand: the maintenance list shows pending `worktree-agent-*` branches with touched files. Merge a clean one (merge
   commit appears); a conflicting one reports the file and stays; Discard removes it; Uninstall refuses while work is
   pending and afterwards removes `.orgai/`, the CLAUDE.md section and the exclude line. free. e2e: `maintenance.mjs`.
3. Live isolation: two parallel writing reports each get a worktree under `.claude/worktrees/` and a merge review card;
   approving merges both. spends tokens. e2e: `worktree.mjs`.

### Connections (App settings > Connections)
1. Three cards render: Anthropic, OpenAI, LiteLLM, each with a status badge. free. e2e: `connections.mjs`.
2. LiteLLM: enter `http://127.0.0.1:9` and Test and connect. Expect an error state, no crash, the key never in plain text
   under the data dir; Remove connection clears the key. free. e2e: `connections.mjs`.
3. Anthropic probe runs `claude auth status` (free). OpenAI sign-in (browser or device code) and a live LiteLLM proxy are
   unverified; they need a real login or proxy, and a run on them spends tokens.
4. Project settings connection picker: switching connection reports a remap notice listing changed roles with Undo; Undo
   restores them. A work run whose roles mix model families on LiteLLM is refused before it starts. free (mock).

### MCP servers, plugins, registry, install cards
1. Project settings has MCP servers and plugins sections and an "Add from registry" button. free. e2e: `connections.mjs`.
2. Add a stdio server (name, command, args, pinned versions). Secret env/header values are write-only (only a has-flag
   comes back). Run the test button (`mcp:test`: initialize + tools/list; stdio and streamable HTTP, not legacy SSE).
   free (the server command must be installed).
3. Registry search hits `registry.modelcontextprotocol.io` (network, no tokens); the response shape is unverified live.
4. MCP assist run (mock): proposal card for `mock-fs`; approve and the server is added. free (mock).
5. Install card: a spawner role's `request_mcp_install` shows an approval card; deny tells the agent to find another
   route. Needs a custom script; mid-run attach (`setMcpServers`) is unverified on Claude. free (mock, custom script).
6. Deleting a project removes its MCP secrets. free.

### Usage meter
1. The meter shows plan windows (5 h, 7 d, model-scoped) for a Claude login and Codex plan usage for OpenAI; without a
   login it shows an unavailable state. Real numbers need a login (the probe spends no tokens).
2. Mock runs show synthetic cost on the canvas (about $3 per million tokens), not plan usage. free (mock).

### Settings
1. Theme: switch dark and light; every screen must use tokens in both. free. e2e: all three scripts screenshot both themes.
2. Notifications toggle. free (mock).
3. Logs link opens the folder holding `main.log` (`<data>/logs/main.log` with `ORGAI_DATA_DIR`). free.

### Window sizes
The e2e scripts resize to **1024x640** and **1600x1000** (`BrowserWindow.setContentSize`) in dark and light, and assert
no horizontal scroll, composer and run strip inside the viewport, and no clipped Runs tab row. Open `e2e/shots/` and
look for clipped panels, overlapping cards, a squeezed canvas, off-scale text and missing focus rings; the scripts do
not judge those.

### Keyboard reachability
Tab through the sidebar, tabs, canvas controls, composer, approval cards and dialogs. Every control must be reachable
and show a visible `:focus-visible` ring; dialogs should close with Escape. free. e2e: only the run chip focus ring.

## 5. Token-spending verification (consent required)

Never run these in loops, and not without the owner's explicit approval. The e2e ones refuse to run without `--yes`.

| command | proves | rough cost |
| --- | --- | --- |
| `node e2e/setup.mjs --yes [--new]` | Full Architect setup, one org-chart revision, applied roles and architecture files | $0.30-$1.50 (opus), 3-8 min |
| `node e2e/history.mjs --yes` | Setup run, app restart, run reopened from the Runs tab, records removed with the project | $0.30-$1.50, 3-8 min |
| `node e2e/worktree.mjs --yes` | Two parallel writing reports in worktrees, both merged back | $0.20-$1.00, 2-5 min |
| `node scripts/smoke-sdk.mjs` | Claude Agent SDK basic path (two haiku turns) | cents |
| `node scripts/smoke-delegation.mjs` | SubagentStart/Stop hook and `task_started` fields, `agent_id` / `parent_tool_use_id` | cents |
| `node scripts/smoke-mcp-tools.mjs` | In-process MCP tool round trip and tool names in hooks | cents |
| `node scripts/smoke-network.mjs` | `auto` permission mode, Agent `name` addressability, SendMessage input shape | cents |
| `node scripts/smoke-images.mjs` | Mid-session base64 image delivery as `claude.ts` sends it | fraction of a cent |
| `node scripts/smoke-usage.mjs` | Plan usage API response and `rate_limit_event`s (Max login) | one haiku turn |
| `node scripts/smoke-usage-probe.mjs` | Usage readable without sending a prompt | meant to spend none; still ask first |
| `node scripts/smoke-worktree.mjs` | `isolation: "worktree"` injection and what is left in the repo | cents |
| `node scripts/smoke-codex.mjs --yes` | `codex app-server` handshake, dynamic tools, resume | two short turns |
| `LITELLM_BASE_URL=... LITELLM_API_KEY=... node scripts/smoke-litellm.mjs [--yes]` | Without `--yes`: lists models only (free). With it: one tiny query | cents |

Costs for the smoke scripts are estimates from their headers, not measurements.

## 6. Packaging checks

```sh
npm run pack        # build + electron-builder --dir --publish never -> release/win-unpacked (no installer)
npm run dist:win    # build + electron-builder --win -> release/ (NSIS installer + portable exe)
```

Output lands in `release/` (gitignored). If winCodeSign extraction fails for lack of symlink rights (Developer Mode
off), set `signAndEditExecutable: false` in `electron-builder.yml`; the exe then keeps Electron's icon. Launch the
unpacked `OrgAI.exe`, create a project and confirm `claude` is found (the SDK's native CLI is in `asarUnpack`). No e2e
covers the packaged app. macOS: [macos-testing.md](macos-testing.md) (untested on a Mac).

These two commands were not run for this guide.

## 7. Where things live

Data dir: `ORGAI_DATA_DIR` if set, otherwise Electron userData (`%APPDATA%\OrgAI` on Windows, `~/Library/Application
Support/OrgAI` on macOS).

```
<data>/projects.json        projects, roles, MCP specs (no secret values)
<data>/settings.json        app settings, connections
<data>/models.json          persisted model catalog
<data>/secrets.json         safeStorage ciphertext (LiteLLM key, MCP env/header values)
<data>/runs.json            run index
<data>/runs/<id>.json       one run record
<data>/runs/<id>/images/    pasted images, <sha256>.<ext>
<data>/codex/               OrgAI's own CODEX_HOME
<data>/logs/main.log        with ORGAI_DATA_DIR (rotates to main.1.log at 2 MB)
```

Without `ORGAI_DATA_DIR` the log is in `app.getPath('logs')`: `<userData>\logs` on Windows, `~/Library/Logs/OrgAI` on
macOS. Screenshots: `e2e/shots/` (gitignored). Build output: `out/`, `release/`.

## 8. Known failures and gaps

### Known failures
None on the baseline run (Windows 11, `main` at 60f4d53): typecheck, test, build and e2e:free all passed. A fresh
worktree has no `node_modules`; run `npm install` first (about 33 s). It prints npm audit findings (15 vulnerabilities),
which are not part of the gate.

### Gaps that affect local testing (from ARCHITECTURE.md "Risks and gaps")
- Codex wire shapes, dynamic tools surviving `thread/resume`, the ChatGPT login and the device-code expiry field are
  unverified until `smoke-codex` runs. LiteLLM and MCP registry shapes are unverified against live services.
- Claude: agent attribution by tool_use id is unverified with a FIFO fallback (can misattribute concurrent calls);
  `Query.setMcpServers` for mid-run installs is unverified at runtime.
- The UI was verified only against stubbed or empty states for connections and MCP. The renderer has no component tests
  and the repo has no lint or format tooling.
- `projects:previewRemap` exists but is not wired into the UI (previews are computed in the renderer).
- Sync `safeStorage` is removed in Electron 46; stay on 45 until SecretStore moves to the async API.
- The UI overhaul shell pass (Radix, resizable panels, frontend-design skill) may rewrite App, LiveRunView and
  SettingsView; e2e selectors must be updated in the same change.
- CI and release workflows have not had a real run; macOS is untested; no e2e covers the packaged app.
