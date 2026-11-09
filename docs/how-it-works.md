# How OrgAI works

Internals for people who want to know what the harness does or who want to extend it. For what OrgAI is and how to
start, see the [README](../README.md). The repository conventions are in [.orgai/ARCHITECTURE.md](../.orgai/ARCHITECTURE.md)
and [CLAUDE.md](../CLAUDE.md); this page is the overview they build on.

Some sections describe the Claude adapter (worktree isolation, subscription usage windows). The Codex and LiteLLM
connections share the same session core in `src/main/runtime/`.

## Source layout

```
src/shared/         types shared across processes (Project, Role, RunEvent, IPC names)
src/main/           Electron main process
  runtime/types.ts  RuntimeAdapter / RuntimeSession interfaces
  runtime/claude.ts Claude adapter over @anthropic-ai/claude-agent-sdk
  runtime/mock.ts   scripted, token-free adapter for tests and UI work (ORGAI_MOCK=1)
  runtime/harnessTools.ts, prompts.ts, activity.ts, integration.ts, network.ts  provider-neutral session core
  runtime/continuation.ts  unattended execution: when to remind the orchestrator of its plan
  runtime/runManager.ts  active runs, permission and proposal round-trips, event broadcast
  setup/profile.ts  token-free repository profile (tree, manifests, docs, git log)
  setup/service.ts  setup prompts, applying approved proposals, writing .orgai/ARCHITECTURE.md
  ai/draft.ts       quick org chart drafter (prompt + JSON -> roles)
  store/            JSON stores under the app data dir (`%APPDATA%/orgai/data` on Windows, `~/Library/Application Support/orgai/data` on macOS; `ORGAI_DATA_DIR` overrides) (projects, run index, one record per run)
src/shared/setup.ts the built-in Architect role and proposal tool names
src/preload/        contextBridge API (window.orgai)
src/renderer/       React UI: projects, org chart editor, live run view
scripts/            SDK smoke tests (cost well under a cent each)
```

## How setup works

- A setup session is an ordinary run (`kind: 'setup'`) whose only role is the Architect: read-only tools plus web
  search, no spawning. It shows on the live canvas like any run.
- The Architect's proposals are in-process MCP tools (`mcp__orgai__propose_*`). Each call blocks until you decide in
  the UI; the tool result tells the model `APPROVED` or `REVISE` plus your feedback, so it iterates in the same session.
- Approving applies immediately in the main process: architecture to the repo, roles and settings to the project.
  `complete_setup` marks the project ready. Setup never edits code. For a new project the live view then offers
  **Scaffold the project**, a normal run of the approved org chart that builds the initial structure from the
  architecture document.
- Every run is persisted: the summary in the run index, and agents, transcript and logs in a per-run record. The
  **Runs** tab in the live view lists past runs and redraws any of them on the canvas after a restart.

## How parallel work stays safe

- With **Isolate writing reports in git worktrees** on (the default, in a git repository), every report the
  orchestrator spawns that can edit files gets `isolation: "worktree"` injected by the spawn hook. Claude Code
  creates `.claude/worktrees/agent-<id>` on branch `worktree-agent-<id>` and confines the report's edits to it.
- When the report finishes, the harness commits whatever it left, merges the branch into the main checkout with a
  merge commit, removes the worktree, and tells the orchestrator what landed. A conflict keeps the branch and hands
  it to the orchestrator, which can resolve it with git or call `integrate_worktrees` after committing its own work.
- Isolation nests. A writing report spawned by an isolated report gets its own worktree too, on a branch cut from
  its parent's branch. When it finishes, its branch merges into the parent's worktree, not the main checkout, and
  the parent's branch carries it to the main checkout later. A parent that finishes first waits until its reports
  are integrated. If a child conflicts with its parent, the child's branch is kept and the orchestrator is told
  both branch names; the parent still merges, and the child's branch stays pending for `integrate_worktrees` or
  the maintenance panel. Writers under a report that is not isolated (a read-only lead) share its checkout.
- Merges into the same checkout run one at a time. With review on, nested merges are reviewed against the parent's
  branch. Nodes on the canvas show the worktree state: isolated, merging, waiting for its reports, merged, no
  changes, or merge conflict.

## Cleanup and retention

- **Maintenance panel** (project settings) lists every report branch still in the repository with its commits
  ahead, uncommitted files and touched paths. Merge it into the main checkout or discard it. Conflicts are reported
  and the branch is kept.
- **Startup reconciliation.** When an isolated work run starts, leftover branches from earlier runs get their
  uncommitted work committed, and the orchestrator is told they exist so it can merge or recommend discarding.
- **Retention.** Each project keeps its newest N runs (default 100); older finished runs and their transcripts are
  deleted when a run ends. On launch the app also drops runs of deleted projects and record files nobody indexes.
- **Deleting a project** removes its runs and transcripts too. Files in the repository are untouched.
- **Remove OrgAI files from repository** deletes `.orgai/ARCHITECTURE.md`, the CLAUDE.md section, the
  `.git/info/exclude` entry and any empty worktrees. It refuses while a report branch still holds unmerged work.

## Subscription limits and auto-resume

- On a claude.ai login the limits that matter are the plan's five-hour and seven-day windows (plus per-model weekly
  windows on some plans), not dollars. While a session is live the Claude adapter polls the SDK's (experimental) usage
  method every minute and reads the `rate_limit_event`s that accompany requests; the sidebar meter shows each window's
  use and reset time. If the usage method is missing or fails, the meter just says usage is not reported.
- Cost figures are the SDK's API-price estimate. On a subscription they are shown as `≈$0.09` and are not billed; the
  per-run cost cap is then a safety cap, not money.
- **Pause and auto-resume.** When a request is rejected at a limit, the session ends and the run is marked *paused*
  with the reset time. At the reset the harness continues it (same SDK session) with a resume message; the live view
  offers *Resume now* and *Cancel auto-resume*. Timers live only in the app process: after a restart a paused run shows
  as finished and can be continued by hand. Reports cut off by the limit leave their worktrees; the continued run's
  startup reconciliation commits them and tells the orchestrator.
- **Window cap** (project setting): stop a run once it has used more than N% of the five-hour window. The turn is
  interrupted and the orchestrator is told why with your next message.
- **Prefer Sonnet near the limit** (project setting): while the Opus weekly window (or the seven-day window on plans
  without one) is at or above the threshold in app settings (default 80%), new reports whose role uses Opus are
  spawned on Sonnet.

## How the org chart is enforced

- Each role becomes a programmatic subagent definition; the root role runs the main thread.
- A role gets the `Agent` tool only if it may spawn. A `PreToolUse` hook denies any spawn whose
  `subagent_type` is not in the parent's `spawnable` list, so the model cannot work around the chart.
- Depth and concurrency caps come from project settings (new projects: 8 concurrent reports, depth 3; up to 32
  and 5); an optional per-run spend cap ends the session.
- Permission prompts (`canUseTool`) surface as approval cards in the live view.

## Permission modes

| Mode | What happens |
| --- | --- |
| `auto` (default, **unattended**) | A model classifier approves or denies each tool call; only calls it cannot decide become approval cards. The live toolbar shows an *unattended* pill. |
| `acceptEdits` | File edits are approved; every shell command asks. |
| `default` | Anything risky asks. |
| `dontAsk` | Never asks: anything a saved rule does not pre-approve is denied. |
| `plan` | Plan only, no changes. |
| `bypassPermissions` | No permission checks at all (dangerous). |

- **Saved rules never ask.** "Always allow (project)" on an approval card, and the safe-command allowlist the Architect
  proposes during setup (`allowRules` on the settings proposal: the project's build/test/lint/dev commands, read-only
  git, and the git operations the harness uses; never `rm`, `git push`, `git reset --hard` or `sudo`), are merged into
  `<project>/.claude/settings.local.json` under `permissions.allow` and passed to every run as `allowedTools`. The
  harness drops bare shell rules and destructive commands from a proposal before saving. A bare tool name such as
  `WebSearch` approves the whole tool before any prompt; the rules panel labels such rules *whole tool*.
- Setup sessions run the Architect in `acceptEdits`, or in `auto` when the project is unattended.
- **Agents ask for rules instead of hitting walls.** When the policy denies a call (the `auto` classifier refuses
  `gh repo create --public`, say), any agent calls `request_permission_rules` with the narrowest rules and a reason.
  A *Permission request* card shows who asks, the rules (flagged when broad or destructive) and the reason:
  **Allow for this run** grants them until the run ends, **Always allow (project)** also saves them to the project,
  **Deny** sends your optional note back. A grant applies at once, with no restart: the harness itself allows
  matching calls (`src/main/runtime/ruleMatch.ts`: bare tool names, `Bash(prefix:*)` as whole words, exact commands,
  and `&&`/`;` chains whose every part is covered; pipes, redirects and substitutions still go through the provider).
- **Edit rules in the app.** Project settings → *Saved permission rules* lists, adds and removes rules; additions reach
  runs that are already open on the project as well as new ones.
- Every permission request and its outcome (tool, summary, decision, scope) is written to the main log at info level.

## Agent network

- Every report gets a **handle**: the spawn hook names it `<role slug>-<n>` in spawn order (`implementer-1`,
  `implementer-2`) unless the Agent call passed `name`. Nodes show the handle under the name.
- Roles with the `SendMessage` and `ListAgents` tools can message other running agents by handle and see who is
  running; every role that may spawn gets both automatically, so leads can send follow-ups to a running report instead
  of re-spawning it. The orchestrator's prompt explains this; the Architect gives the tools to roles that must
  coordinate (peers handing off an interface, an implementer and its reviewer) and may let spawnable lists cross teams.
- Each message is an `agent.message` event (sender, recipient resolved by handle, role slug or `user`, first 200
  characters) and a line on the sender's transcript (`→ implementer-2: …`). The live view draws it as a dashed,
  animated pink edge labelled *msg* for 12 seconds; a message to or from a folded report attaches to its *done* group.

## Unattended execution

Work runs keep going until the job is done instead of stopping after each turn to ask "shall I continue?".

- **Plan tools.** The orchestrator gets four harness tools: `set_plan({ goal, steps: [{ title, owner? }] })` creates
  or replaces the plan (steps `p1..pn`, all pending), `update_plan({ steps: [{ id, status, note? }], add? })` marks
  steps `in_progress`, `done`, `skipped` or `blocked` (and reactivates a blocked plan), `complete_plan({ summary })`
  finishes it, and `mark_blocked({ reason })` stops it for a decision only the user can make. `ask_user` (the
  multiple-choice card setup uses) is available too. Its prompt tells it to plan first, keep the last step for
  verification (build and tests), and stop only for genuine decisions.
- **The feedback loop** (`src/main/runtime/continuation.ts`, used by every adapter). When a turn ends, the harness
  waits about 1.5 s (a report that just landed wakes the orchestrator first), re-checks, and if the plan is active with
  steps left it sends the orchestrator a reminder: progress, the remaining steps by id, and "continue with the next
  step now". The root node shows *Continuing: <next step>*. Without a plan after the first turn it asks once for one.
  It never nudges while reports are still running, while a permission, proposal, question or merge card waits for
  you, at a usage limit, or while the run is stopping. Each reminder counts as one automatic continue.
- **Seeing it.** The side panel's **Plan** tab lists the goal and steps (○ pending, ● in progress, ✓ done,
  ! blocked, – skipped) with notes and the automatic-continue count; the toolbar shows *3/7 steps* (click it for the
  Plan tab) and the run strip shows the progress. A blocked plan shows its reason in an amber banner above the
  composer; your reply goes to the orchestrator, which resumes the plan with `update_plan`. A plan that completes or
  blocks raises an OS notification like a finished run.
- **Stopping it.** *Interrupt turn* pauses the loop until you send a message; *End session* stops the run. Turn
  it off per project with **Keep the orchestrator going until the plan is complete** (project settings, *Unattended
  execution*), and bound it with **Max automatic continues per run** (default 40). At the limit the orchestrator
  waits for you, and the transcript and logs say why. App settings hold the defaults for new projects, and the
  Architect proposes both in its settings card. Continuing a finished run carries its plan over with a fresh count.

## Asking OrgAI about itself

Chat can answer questions about OrgAI: where a setting lives, what a screen does, which shortcut or menu item opens
it, what the `orgai` command can do and which tools agents have. Help > "Ask OrgAI about itself…" opens Chat for that.
The answers come from the app's own registries, not from a hand-written manual: an atlas of every screen with its path
and how to reach it, a description of every app and project setting, the menu actions and shortcuts, the harness
tools per run kind, the host channels, the CLI commands, the connector catalog and the docs bundled with the app
(this file among them). A new screen, setting or menu action cannot land without its entry, because the build checks
it.

Agents read this reference through the `app_reference` tool (search, read, locate and, in Chat and the assistants, a
status snapshot without any secrets). Chat, the Architect and the MCP and Skill assistants can also show you a place
with `open_in_app`, which switches the main window to that screen and says who opened it; it only ever opens screens
the atlas knows, a few at a time. Chat can propose changes to app settings (appearance, notifications, defaults for
new projects, assistant models) and to a project's settings; nothing changes until you approve the card. Connections,
keys, proxies, model prices, saved permission rules and the default connection are not proposable:
change them in App settings yourself.

## Adding a provider

Implement `RuntimeAdapter` in `src/main/runtime/`, register it in `src/main/index.ts`, and add its id to
`ProviderId` in `src/shared/types.ts`. The renderer never talks to a vendor directly.

An adapter only maps its SDK's events and hooks onto normalized `RunEvent`s. The rest is shared in
`src/main/runtime/`: `harnessTools.ts` (proposal, `ask_user`, `complete_setup` and `integrate_worktrees` tools as
zod schemas plus handlers; expose them through your SDK's custom-tool mechanism), `prompts.ts` (role system prompts),
`activity.ts` (node activity strings), `integration.ts` (`WorktreeIntegrator`: commit, review, merge and orchestrator
notifications for isolated reports; you supply `notify`), `continuation.ts` (`ContinuationDriver`: call `turnEnded`,
`userMessage`, `hold` and `dispose`, and deliver its `nudge` like a harness message), and `permissionRules.ts`
(suggestions and allow scopes).
`mock.ts` is a reference adapter that uses all of them without an SDK.

For UI work without spending tokens, start the app with `ORGAI_MOCK=1`; the mock adapter then becomes selectable in
a project's settings (until that toggle lands, set the project's `provider.id` to `"mock"` in `projects.json` under the
data folder). `ORGAI_MOCK_SCRIPT=<file.json>` swaps in your own `MockScript`.
