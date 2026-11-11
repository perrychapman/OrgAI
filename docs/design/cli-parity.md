# CLI and TUI parity: everything a terminal-only user is missing

Status: executed, 2026-11-10 (section 7 says what was built and what was held back). Written as draft 1 the same day. Written from three read-only audits of the code at the fork's dev
(`1664b49f`): project settings and connections; the team and what a role can be given; running work and seeing what
happens. Every "missing" below was checked by searching `src/cli` and `src/main/host` for the field, event or
channel. Nothing was run for the audits.

Why now: the owner works only in the CLI and TUI, on a separate machine. Agents there ran on old models and
compacted constantly, and nothing in the terminal showed which model an agent was on, which model a tier meant, or
that compaction was happening. The switch that would have worked around it (project staffing mode) exists only in
the desktop app. The CLI and the desktop app are separate apps with separate data folders
(`docs/agent-notes/cli-host.md`), so nothing set in one reaches the other: whatever the CLI cannot set, a CLI-only
user cannot set at all.

## 1. Principles

- **A terminal-only user can see and change everything that affects a run.** View first, then change. A setting
  the CLI cannot show is treated as a defect even when it cannot be changed yet.
- **Commands before screens.** Every capability lands as a command with `--output-format json`; the TUI calls the
  same host methods afterwards. A TUI screen is never the only way.
- **The host stays the authority.** A command is `projects:get` plus `projects:save`, or an existing channel. New
  channels only where none exists. Shared types in `src/shared/types.ts`.
- **Nothing an agent can run may approve what an agent did.** Approvals (team files, folder trust, proposals)
  keep the terminal gate of `docs/design/cli-approvals.md`: a human at an interactive terminal, never a command an
  agent's shell can call. The self-control gate already keeps agents off the `orgai` command; approvals do not rely
  on that alone.
- **Concrete names.** Wherever a tier is shown, the model id it resolves to is shown beside it.

## 2. Gaps, by severity for a terminal-only user

### 2.1 Blockers

| # | Gap | Today |
|---|---|---|
| B1 | Concrete model per agent | `exec` prints "on everyday / medium"; the TUI tree shows the tier; the id is in the inspector for one agent, and in `runs show --json` |
| B2 | Models actually used | `usage show` and `/usage` have no per-model rows; `runs:usageOverview` is never called |
| B3 | Project staffing mode and goal | No view, no set; `exec --goal` covers one run |
| B4 | Tier to model mapping | Viewable (`connections show`), not changeable; the host's `connections:update` accepts `tierModels` and the CLI never sends it |
| B5 | Role editing | No command creates, deletes, renames or reparents a role, or changes its prompt, model, tier, effort, tools, spawning, required reports, connection or staffing; only wholesale import, template or the Architect |
| B6 | Team-file changes | Editing `.orgai/team.json` or an agent file creates a pending change; `teamFiles:approve/reject/undo/enable/commit` are `desktop_only`; the CLI never calls `teamFiles:listAttention`, so the user is not told |
| B7 | A drafted chart cannot be kept | `org draft` prints "not saved" and there is no apply |
| B8 | Switching a run's model | `runs:switchModel` exists (operate scope) with no CLI or TUI caller |

### 2.2 Important

| # | Gap |
|---|---|
| I1 | Compaction and context use are invisible on every surface: the Claude adapter maps no compaction event and `codexEvents.ts` ignores `contextCompaction` |
| I2 | No tier resolution at run start, and no warning when a tier resolves to an old or built-in fallback model |
| I3 | No `orgai settings`: defaults for new projects, `defaultRootModel`, `defaultReportModel`, the assistants' models (`setupModel`, `mcpAssistModel`, `skillAssistModel`, `quickRunModel`), price overrides, notifications |
| I4 | `reviewPolicy`, `reviewMerges`, `maxWindowShare`, `keepRuns` have no view or set; `projects set` has no `--connection` |
| I5 | Folder config trust (`projects:folderConfig`, `projects:setFolderConfigTrust`): no CLI caller, set is `desktop_only` |
| I6 | Per-role staffing and per-role connection show only in `--json` |
| I7 | Harness warnings: `exec` text drops `log` events; the TUI shows them as expiring notices; `runs show` text has no logs |
| I8 | A paused run: `runs:resumeNow` and `runs:cancelAutoResume` have no caller |
| I9 | TUI run start cannot pass overrides (goal, permission mode, strict delegation); `session.ts` sends `{projectId, prompt, team}` |
| I10 | MCP role scoping after creation (`mcp update --role`), and `Role.mcpServers` |
| I11 | Revising the chart with an instruction (`setup:start` with `instruction` is never passed) |
| I12 | Usage after a run: cost by model, cost by tier, efficiency, runs worth a look |
| I13 | Outputs (`outputs:list/preview/revise/noteAdd`): no command |
| I14 | `AgentInstance.connection` and `run.model` / `modelSelection` are not shown |
| I15 | Images on `exec` and `resume` |
| I16 | `doctor` has no connection, auth or model-catalog check; `models list` text hides `source` and `contextWindow` |

### 2.3 Minor

Auto-continue count; the live plan-window bar in the TUI; quick runs with edits in the TUI; scaffold runs;
`knowledgeAutoContext`, `teamReview` and `skillEvaluation` settings; `brief` in `projects show`; project path;
self-help entry point; clearing the knowledge graph; run rename, dismiss and promote.

## 3. Design

### 3.1 Seeing models and context (B1, B2, I1, I2, I14, I16)

- **Run start line.** At run start the host logs one line per tier in use, at level `info`, and the CLI prints it:
  `Models: deep = claude-opus-5-5, everyday = claude-sonnet-5-5 (Anthropic)`. A second line at `warn` when a tier
  resolves to a model that is not the newest of its family in the connection's catalog, to a built-in fallback
  (catalog `source` not `discovered`), or when discovery last failed: it names the tier, the model and the fix
  (`orgai models refresh`, `orgai connections tier`). Pure decision in a module beside the tier mapping, tested.
- **Model id everywhere a tier is shown.** `staffingLabel` gains the model id: `everyday (claude-sonnet-5-5) /
  medium`. Applies to the `exec` staffing line, `agentTreeLines` and `summaryLines` of `runs show`, the TUI tree
  row (truncated last when narrow) and the inspector, which lists every model the agent used, not the first.
  `AgentInstance.connection` joins the row when a run spans more than one connection; the status bar shows the
  root's live model (`run.model`).
- **Compaction.** The adapters emit a normalized `RunEvent` `agent.compacted { agentId, at, trigger?, tokensBefore?
  }` (Claude: the SDK's compact boundary message; Codex: `contextCompaction`). RunManager counts them per agent on
  the record. `exec` prints `Lead compacted its context (3rd time).`; the TUI shows the count on the agent row and
  a notice; `runs show` prints the counts. More than two compactions of one agent without a finished plan step in
  between logs one `warn` naming the model and its context window. The mechanism of the thrash itself is the
  separate compaction fix (branch `fix/compaction`); this section is the visibility.
- **`orgai models resolve [--project]`**: for each tier and each role, the model id on the project's connection,
  the fallback taken if any, the catalog source and the context window.
- **`models list`** text gains SOURCE and CONTEXT columns. **`doctor`** gains checks: each enabled connection's
  last discovery (`modelsError`), each tier mapped, no tier on a built-in fallback or an older family member.
- **Usage.** `usage show` and `/usage` gain "By model" from `ModelUsageEntry.model`; `usage show --overview` uses
  `runs:usageOverview` for cost by model, by tier, lead against team, and runs worth a look.

### 3.2 Project and app settings (B3, B4, I3, I4)

- `projects set` gains `--staffing auto|fixed`, `--staffing-goal balanced|speed|cost`, `--review-policy
  always|risk|never`, `--review-merges on|off`, `--max-window-share <0-1|auto>`, `--keep-runs <n|auto>`,
  `--connection <id>` (through the same preview and remap as `models remap`). `projects show` prints all of them
  and the brief.
- `orgai connections tier <connection> [<tier>=<model> ...]`: with no pair, shows the mapping with each model's
  source and context window; with pairs, sets them through `connections:update` after validating each id against
  the catalog, then prints which projects' roles are affected (`projects:previewRemap`). `--reset` returns a tier to
  discovery's choice.
- `orgai settings [get <key> | set <key> <value> | list]` over `settings:get` / `settings:set`, with a closed list
  of keys that matter in a terminal: the `default*` project defaults, `defaultRootModel`, `defaultReportModel`,
  `setupModel`, `mcpAssistModel`, `skillAssistModel`, `quickRunModel`, `opusGuardThreshold`, `communityPrices`,
  `notifications`. `orgai models prices set <model> ...` / `unset` for price overrides. Appearance stays out.

### 3.3 The team (B5, B7, I6, I10, I11)

- `orgai team role add <name> --reports-to <role> [flags]`, `team role set <role> [flags]`, `team role rm <role>
  [--reparent-to <role>]`, `team role move <role> --reports-to <role>`. Flags: `--name`, `--description`,
  `--prompt <text>` / `--prompt-file <path>` / `--edit` (opens `$EDITOR`, terminal only), `--model <tier|id>`,
  `--effort`, `--staffing auto|fixed|inherit`, `--min-tier`, `--max-effort`, `--tools a,b` / `--add-tool` /
  `--rm-tool`, `--can-spawn on|off`, `--spawnable a,b`, `--required-reports a,b`, `--connection <id|inherit>`,
  `--mcp a,b`. Built on `projects:get` and `projects:save` with the same cleaning the desktop save path uses;
  validation errors name the field. A change that raises what a role may spend (a higher tier or effort ceiling,
  automatic staffing switched on, a new connection) prints the same "May spend more" sentence the team files gate
  uses and needs `--yes` or a confirmation at a terminal.
- `team role <name>` and `org show` text gain staffing, effort and connection.
- `org draft --apply [--mode replace|merge] [--yes]` saves the drafted chart, returning `previousRoles` in JSON as
  `org import` does. `org revise "<instruction>"` starts the Architect with `instruction`.
- `mcp update <server> --role a,b | --no-roles`.

### 3.4 Approvals at the terminal (B6, I5)

- `orgai team files status` lists pending team-file changes (`teamFiles:listAttention`) with the gate's summary of
  each, including its "May spend more" sentence. Any command that starts a run, and the TUI on open, says when
  changes are pending.
- `orgai team files approve|reject|undo|commit <id>` and `orgai projects trust show|allow|deny`. These channels
  leave `desktop_only` for a new scope that the host grants only to a connection it has verified as an
  interactive terminal session started by the user (the mechanism of `cli-approvals.md`, section 1), never to
  `exec`, never to a session whose ancestry includes an agent process, never with `--yes`. The TUI offers the
  same as cards in the Decision Tray.
- This phase gets an independent security review before merge; a Medium or higher finding blocks it.
- As built (cp/approvals, read-only; `docs/agent-notes/cli-host.md` "Approvals at the terminal"): `orgai team files
  status`, `orgai projects trust show`, the run-start line and a read-only TUI `/approvals` ship; nothing in the terminal
  approves. The approve path was built and held back: two independent reviews found that a terminal session cannot be
  told apart from one an agent drives. Approving from a terminal needs an OS-level confirmation and a store agents cannot
  write; until then approving is done in the desktop app. The channels stay `desktop_only`; no scope was added.

### 3.5 Acting on a run (B8, I7, I8, I9, I15)

- TUI `/model [<tier|id>]` and `orgai runs model <run> <tier|id>` over `runs:switchModel`, with the guard the
  desktop's switch applies (`lib/liveModelSwitch.ts` moves to shared code).
- TUI `/new` and `/ask` accept `--goal`, `--permission-mode`, `--strict-delegation`; bare `orgai` takes the same
  flags as `exec` for the first run.
- `orgai resume <run> --now` and `--cancel-auto-resume`; TUI keys on a paused run.
- Logs: `exec` text prints `warn` and `error` log events (and `info` with `--verbose`); `runs show --logs`; TUI
  `/logs` keeps the run's warnings in a scrollable list.
- `exec --image <path>` and `resume --image <path>` (repeatable; size and type limits of `ImageAttachment`).

### 3.6 After a run (I12, I13)

- The usage additions of 3.1.
- `orgai outputs list|show|revise|note` over the existing `outputs:*` channels; TUI `/outputs`.

### 3.7 TUI screens (after the commands)

A Team pane that shows the saved roles (not the run's agents) with the edit actions of 3.3, and a Settings pane over
3.2. Both call the same host methods as the commands. Built last; nothing depends on them.
- As built (cp/tuiPanes; `docs/agent-notes/cli-host.md` "TUI Team and Settings views"): `/team` and `/settings` are
  views over the run view (the status bar stays), keyboard only, Esc backs out. Edits use the commands' own functions
  (the role planners of `teamRoleEdit.ts`, `setPatch`, `permissionModeArg`, `planTierChange`, `parseSettingValue`) and
  channels. The host allows saving during a live run; the live run keeps its start-time team, so the view says the change
  applies from the next run. The project's connection is shown read-only (`orgai projects set --connection`).

## 4. Phases

Each phase lands on the fork's dev after its gate: typecheck, the whole unit suite, build, and the CLI e2e scripts
(`cli-exec`, `cli-readonly`, `cli-tui`, `cli-projects`, `cli-org`, `cli-connections`), selectors and fixtures
updated in the same change.

1. **See it.** 3.1 without the compaction event's adapter mapping if the compaction fix has not landed (the event
   type and the surfaces go in; the adapters emit it when that branch merges).
2. **Set it.** 3.2.
3. **The team.** 3.3.
4. **Run control.** 3.5.
5. **Approvals.** 3.4, with the security review. As built: read-only (see 3.4); approving waits for an OS-level
   confirmation.
6. **After a run.** 3.6.
7. **TUI panes.** 3.7.
8. **Docs.** `docs/design/cli-spec.md` command reference, `docs/agent-notes/cli-host.md`, `README` CLI section,
   shell completions.

## 5. Acceptance

- A user with only a terminal can: see the model id of every agent in a live run and after it; see and change what
  each tier maps to; be warned at run start when a tier points at an old or fallback model; see every compaction;
  switch a project between automatic and fixed staffing; edit any field of any role; keep a drafted chart; learn
  of team-file changes and read them in full (approving them at a terminal is deferred, see 3.4 "As built"); switch a
  run's model; read a run's warnings.
- Every new command has `--output-format json`, unit tests beside it and a row in the CLI e2e scripts.
- No approval command succeeds from `exec`, from a non-interactive session or from an agent's shell (tested).

## 6. Risks

- Role editing from the CLI is a second writer of the chart beside the desktop editor and the team files; it must
  go through the same cleaning and the same spend gate or the three will disagree.
- The terminal gate for approvals is the security boundary of phase 5; getting it wrong lets an agent approve its
  own change.
- The TUI is narrow: adding the model id to rows must not push out the state and the step.
- The audits were code reading. A capability listed as covered may still fail in use; the e2e rows are the check.

## 7. As built (2026-11-10)

All phases ran on `feat/cli-parity` and were pushed to the fork's dev after each gate (typecheck, the whole unit
suite, build, the CLI e2e scripts).

| Gap | Outcome |
|---|---|
| B1, B2 model per agent, models used | Built: model ids on `exec`, `runs show`, the TUI tree, inspector and status bar; `usage show` by model and `--overview` |
| B3 project staffing mode and goal | Built: `projects set --staffing`, `--staffing-goal` and the other project flags; `projects show` |
| B4 tier mapping | Built: `connections tier` (view, set with `--dry-run`, `--reset`), `models resolve` |
| B5 role editing | Built: `team role add|set|rm|move` and TUI `/team`; some fields are command-only (description, spawn lists, required reports, per-role connection, MCP grants) |
| B6 team-file changes | **Partly.** Visible (`team files status`, the notice, read-only `/approvals`); approving at a terminal is NOT built (below) |
| B7 drafted chart | Built: `org draft --apply`, `--from`; `org revise` |
| B8 model switch | Built: `runs model`, TUI `/model` |
| I1 compaction | Built: `agent.compacted` on both adapters, counts on every surface, a thrash guard, re-attach after a lead compaction (scripted events only, no live compaction) |
| I2 tier resolution at run start | Built: the `Models:` line and the `Model check:` warning |
| I3, I4 settings | Built: `orgai settings`, the project flags, `models prices set|unset`, TUI `/settings` |
| I5 folder trust | View only (`projects trust show`); allowing is not built |
| I6, I14 role staffing and connection in text | Built |
| I7 logs | Built: `exec` prints warnings and errors, `runs show --logs`, TUI `/logs` |
| I8 paused runs | TUI only (`/resume-now`, `/cancel-resume`): a run is paused inside the process that owns it, so the commands cannot reach it from another terminal |
| I9 TUI run-start flags | Built |
| I10 MCP role scoping | Built: `mcp update --role|--no-roles|--all-roles` |
| I11 revise the chart | Built: `org revise` (interactive terminal only) |
| I12 usage after a run | Built |
| I13 outputs | Built: `outputs list|show|revise|note`, TUI `/outputs` (`revise` and `note` checked against a fake host only) |
| I15 images | Built on `exec` and `resume --exec` |
| I16 doctor and models list | Built |

**Held back: approving at a terminal (3.4).** A gate was built and reviewed twice by an independent reviewer. Both
times the reviewer obtained an approval that no person gave, the second time with no window and no prompt, and the
tightened rules refused most real terminals. A terminal session cannot be told apart from one an agent drives. A
sound design needs an OS-level confirmation and a store agents cannot write. The work is kept on the local branch
`cp/approvals-full-gate`. Until then a terminal-only user changes the team with the role commands, which save
directly and create no pending change; a hand-edited team file stays pending.

Not verified: no run went through a real compaction with the new handling; opening `$EDITOR` from `/team`; the
plan-window indicator in the TUI against live events; anything on Windows or Linux.

