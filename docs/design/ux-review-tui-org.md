# UX review: the terminal UI against the desktop org chart

Date 2026-11-06. Scope: `src/cli/tui/` (Ink 8, Wave 4) compared with the desktop Live run view. Brief: make the TUI "more in
line with what the app shows for the agent org chart", give terminal users the run view's functions, and do not flood the
terminal. This is a findings and design document for the Runtime Lead to turn into an implementation brief. No code was
changed.

## 0. What was driven, what was not

Driven:

- Desktop app, built (`npm run build`), `ORGAI_MOCK=1`, throwaway data dir, Playwright through `e2e/lib.mjs` (script kept
  outside the repo). Window 1600x1000 (all steps) and 1024x640 (default-script run, selection, a 14-step Tab pass), dark
  theme. A `[mock:deep-tree]` run (root -> `mock-lead` -> `mock-lead-report-1` / `-2`) and a default-script run (root ->
  `implementer-1` that asks to edit a file). Screenshots (gitignored, local): `e2e/shots/tuiorg-01..11-*.png`.
- TUI frames by `ink-testing-library` through the real `App`, real selectors and real panes over a hand-built `TuiState` (root;
  `mock-lead` thinking with two reports, one done and one waiting on a Bash permission with a worktree; two finished
  top-level agents, one failed; one open permission card). Sizes 120x40 and 90x30 full-screen, 80x24 inline, and the tree
  pane alone at 60x14. Colour off (so tones are not judged), a fake session (no host). The test file was deleted; the repo is
  clean apart from this document.

Not driven:

- The real `orgai tui` in a console. The agent shell has no TTY, `e2e/cli-tui.mjs` SKIPs on win32, and the self-control
  gate refused the agent running `node out/cli/orgai.mjs` (correct, not worked around). So key handling, colour, resize and
  the alternate screen are judged from source and unit frames only. Someone with a Windows console should run
  `$env:ORGAI_MOCK='1'; npm run cli -- tui` once against section 4 below.
- Light theme and a keyboard pass of the desktop beyond the Tab order noted in 1.4. Not needed for a terminal brief.
- Message edges between agents: the mock sends no `agent.message` events (known, CLAUDE.md canvas themes), so what the app
  draws for them is read from source (`AgentMessage`, `.msg-edge`), not seen.

## 1. What the desktop Live view conveys

### 1.1 Per agent node (seen, 1600x1000)

Node text, in order: avatar initials in the role colour, **role name**, **handle** · **model** (`mock-lead · sonnet-4-5`), one
**activity line** ("Delegating to implementer", "Needs approval: Editing example.ts", "Waiting for your reply", "Reported
back"), then **tokens** and **cost** (`2.5k tok  $0.004275`). State is the border/edge colour (blue working, amber needs
you, green finished, red failed) plus the activity wording; selection is a purple border with a leading bar. Worktree state,
when present, is a badge on the node. A dashed animated edge shows the active report line. Message edges are dotted lines
between the two agents (`AgentMessage { from, to, toHandle, text }`), drawn on `agent.message`.

Folding ("Hide finished agents", on by default, count in the label, `(3)`): settled subtrees (done or failed, worktree
settled, 6 s grace, nothing live under them) collapse into ONE `N done  $cost  v` node under the nearest agent still
shown. In the deep-tree walk: while running 4 nodes; after the reports finish 2 nodes plus `2 done $0.00285`; expanding the
group shows the lead's subtree as `3 done` again under the root (the nested fold). The rule is `foldFinished` in
`src/renderer/src/lib/foldFinished.ts` (pure, takes `agents`, `isSettled`, `expanded`, `collapse`).

### 1.2 Selection and the side panel

Clicking a node opens the right panel for that agent: header `R1 Orchestrator orchestrator`, tabs **Transcript | Plan | Usage |
Logs**, a one-line facts strip (`claude-opus-4-5  2.4k in / 60 out  $0.004275  10s  idle`), then that agent's transcript
(`Show thinking` switch). Usage tab: cost, tokens, wall time, cache hit, By agent and By role tables, "More numbers".
No node selected means the whole run's feed.

### 1.3 Run-level surfaces and actions

| Surface / action | App |
| --- | --- |
| Run strip | run tabs (`R1 Deep tree...` with status dot, one tab per chain), `+` New run, **Interrupt turn**, **End session** |
| Meta line | `4 agents`, wall time, cost, started, "unattended", Hide finished (N), zoom out / in / fit, canvas style, legend, Show conversation (layout toggle) |
| Needs you | sidebar group "Needs you . N", project badge ("1 decision . 1 run"), a decision card in the tray under the canvas (type chip, the asking agent's avatar and name, run tag, title, location, effect, preview, Allow once / for session / always for project / Deny), the asking node is amber |
| Ended run | composer says "Session ended ... Send to continue with its memory"; strip gets **Org retrospective** (Architect reviews the run, `setup:retro`) |
| Menu Run | New run, Open in new window, Go to decision (Ctrl+.), Show what needs you, Interrupt turn, End session, Save chat as project, Org retrospective |
| History | one row per chain: Open, Continue, Retrospective, Open in Live; Runs / Trends |
| Others | Plan tab, Logs tab, Usage tab, canvas style gallery (13 themes, layouts), legend, conversation layout for single-agent runs |

### 1.4 Desktop keyboard notes (while there)

The first Tab after clicking a node lands on the node itself, then the decision details and buttons, then the composer. Not a
TUI concern; recorded only so nobody copies it as a model.

## 2. What the TUI shows now

Frames below are real output (colour off). Status bar first, then the panes, tray, composer.

```
120x40 (split)
Demo . R1 Build the thing . Needs you . $0.51 . 1 needs you . 1 live   Enter sends . / commands . Alt+D decisions . Tab...
Agents (6)
* o Orchestrator  Delegating        $0.31
    Waiting for reports
  |- v designer-1 (Designer)  Fini... $0.04
                                                      <- blank "activity" line
  |- x writer-1 (Writer)  Failed    $0.04
                                                      <- blank
  `- * mock-lead (Lead)  Thinking   $0.12
       Reviewing mock-lead-report-1
    |- v mock-lead-report-1 (Repor... $0.02
                                                      <- blank
    `- ! mock-lead-report-2 (Repor... $0.03
         Wants to run: npm test
Worktrees (1)                                          Plan
* worktree-agent-r2  mock... 2 files -> main           No plan yet
 ...                                                    (transcript empty, column mostly blank)
Needs you (1) . R1 permission: Run npm test            <- 5 tray rows, 12 reserved of 40
 Run npm test / Command: npm test / No rule can cover this command ...
y Allow once . n Deny . Esc Back
>  Message the run

90x30 (stacked)
Agents (6)
* o Orchestrator  Delegating                     $0.31
  |- v designer-1 (Designer)  Finished            $0.04
  |- x writer-1 (Writer)  Failed                  $0.04      <- 3 of 6 agents; the waiting agent is out of view
Plan ... / Worktrees (1) ... / Needs you (1) tray ... / composer
```

What it does well: one state glyph plus a state word (never colour only), `agentLabel` handles like the app, cost per row
from `costView`, reports nested with box-drawing, "Earlier sessions" group for chain members, a tray that is exact and safe,
an ASCII/screen-reader path, a pinned 3-line footer inline. What it does not do is below.

## 3. Gap list

Legend: Yes / Partial / No. "Reach" is how a terminal user gets it today.

| # | App capability | TUI | Reach today | Note |
| --- | --- | --- | --- | --- |
| G1 | Agent identity: handle, role, avatar | Yes | tree row | role shown in parens even when it adds nothing; truncated state word before role (see F2) |
| G2 | State colour + word + activity | Yes | tree row, activity on a second line | second line is emitted for every row (blank when no activity) |
| G3 | Cost per agent | Yes | row, right | |
| G4 | Tokens, model, turns, tool calls per agent | No | nowhere | `AgentInstance.model`, `inputTokens`, `outputTokens`, `usage` are in state, never selected |
| G5 | Worktree state on the node | Partial | separate Worktrees pane (branch, status, files); `/diff`, `v` | not on the tree row; the pane eats 40% of the left column for one line |
| G6 | Needs-you on the node | Partial | `!` glyph + "Needs you" word; tray and status bar count | no way to see which card belongs to which agent from the tray header (it shows `R1 permission: <title>`, not the agent); no "next waiting agent" key |
| G7 | Fold finished into "N done" | No | nowhere | tree is flat and grows without bound; `foldFinished` is renderer-only |
| G8 | Hide finished toggle, expand a group | No | nowhere | |
| G9 | Message edges between agents | No | nowhere | `state.ts` drops `agent.message` ("changes nothing the TUI keeps") |
| G10 | Select agent -> its transcript / usage / plan | No | the transcript pane always shows the whole chain's feed (rows carry `agentLabel` as a prefix) | selection (`selectedAgent`) is kept in App and used for nothing |
| G11 | Usage tab (by agent, by role, tokens, cache hit, wall time) | No | status bar shows one run total | `RunSummary.usage` is in state (`run.usage` is reduced) |
| G12 | Logs tab | No | nowhere | decide if wanted; low value in a terminal |
| G13 | Plan tab | Yes | Plan pane | |
| G14 | Interrupt turn | Yes | Esc on the composer, `/interrupt` | |
| G15 | End session | Yes | `/stop` (confirm) | |
| G16 | Org retrospective | No | nowhere | `setup:retro` is a socket-invokable operate channel; `TuiHostConnection.client` can call it |
| G17 | Continue an ended run | Yes | composer mode `continue`, `/run R2` | |
| G18 | New run, new ask | Yes | `/new`, `/ask` | no Ctrl+T-style key |
| G19 | Run tabs / chains / switch | Partial | `/run R#`, `/runs` (text table in the pager) | no strip; the status bar names one run only; other live runs are a count ("1 live") |
| G20 | History (Open, Continue, Retrospective) | Partial | `/runs` prints a table; no action on a row | |
| G21 | Go to decision | Yes | Alt+D / F2 / Ctrl+. | |
| G22 | Decision cards, all six kinds | Yes | Decision Tray | parity with `orgai decide` |
| G23 | Open run window / Save chat as project / Show conversation layout | Partial / No / No | `/app` opens the run in the desktop | a conversation-only layout is just `/tree` + `/plan` + `/worktrees` toggled off |
| G24 | Zoom, fit, canvas style, legend | n/a | | replaced by subtree focus (F7) and a glyph legend (F9) |
| G25 | Key discoverability | Partial | status-bar hint (focus-aware but one line, truncated at 120 cols), `/help` | `HELP_TEXT` lists no tree, transcript, plan or worktrees keys at all |

## 4. Findings and proposals

Each finding: what the app does, what the TUI does now, the proposal, files, and whether it needs a new contract. Priorities
use the info-density principle: the default view stays minimal (a tree you can read at a glance), everything else is one key
away.

### F1 (Must) Fold finished subtrees into "N done" rows, on by default

- App: see 1.1. Default on, nested, a group row shows count, summed cost, the failed count when any.
- TUI now: flat list of every agent ever started. A run with 20 reports buries the three agents that matter, and the stacked
  layout (see F3) shows 3 rows.
- Proposal: the tree selector folds with the app's rule. Default view for the deep-tree run: three rows, not six.

```
Agents 6 . 1 working . ! 1 need you                 h: show finished
o Orchestrator                   Delegating        $0.31
|- * mock-lead  (Lead)           Thinking          $0.12
|  |- ! mock-lead-report-2       Needs you   2f    $0.03
|  `- v 1 done                                     $0.02   >
`- v 2 done  (1 failed)                            $0.08   >
```

  `>` / Right expands a group in place (children appear with their own nested folds), `<` / Left folds it back, `h` toggles
  Hide finished for the pane (also `/fold`). A group row is selectable; Enter on it expands. Failed agents are counted in the
  group text, never hidden entirely (a failure is a "needs a look" signal; the app shows the same in its tooltip). Groups
  hang under the nearest visible ancestor exactly as the app does, so the two surfaces agree on shape.
- Reuse: move `foldFinished.ts` (+ `COLLAPSE_GRACE_MS`, `isSettledAt`, `nextSettleAt`, `settleTimerDelay`) and `agentTree.ts`
  (`normalizeParents`, `ancestorsOf`, `hasLiveDescendant`; `agentLabel` there duplicates `cli/render.ts agentLabel`, keep one) to
  `src/shared/view/` with one-line re-export stubs in `renderer/src/lib/` (pattern and `reexports.test.ts` already exist;
  `noRendererImports.test.ts` applies, and both files only import `@shared/types` and `hiddenChars`, which is already
  shared). `@shared/types` alias inside shared/view: check how the other moved files import it.
- Timing: the grace is 6 s of wall clock. The TUI has no tick, so App adds one `setTimeout` to `nextSettleAt` (same as the
  app) so reports fold while the run is still Running. Selection must survive a fold (selection moves to the group row if its
  agent folded, never silently to the top).
- Files: `selectors.ts` (`orgTreeRows` gets `{ collapse, expanded, now }`), `types.ts` (`OrgTreeRow` adds `kind: 'agent' | 'group'`,
  `count`, `failed`, `expandable`, `expanded`), `OrgTreePane.tsx` (rows, `Left` / `Right` / `h`), `App.tsx` (state, timer),
  `slashCommands.ts` (`/fold`).
- Contract: none new. TUI-local types only.

### F2 (Must) One-line rows, activity on demand, state word before role

- App: node shows role, handle, activity, cost; there is room because a node is a card.
- TUI now: `label (Role)  Word  $cost` plus a second activity line for EVERY row whenever `items + rows <= height`, so rows
  without activity print an empty line (visible in all three frames). In the 41-column left column the state word is cut
  ("Fini...") while the dim role in parentheses stays.
- Proposal: (a) no second line at all by default; show the activity of the selected row only, in a one-line footer under the
  tree (`mock-lead-report-2: Wants to run: npm test`) or in the inspector (F4). (b) Cut order when narrow: role first, then
  the activity, then the handle's middle (reuse `splitLabelTail` so `-report-1` and `-report-2` stay distinguishable, the
  app does this for name tags), never the state word. (c) Drop the role when the handle already carries it or equals it.
  (d) Spawn depth indent capped at 4 with a `+N` marker beyond.
- Files: `OrgTreePane.tsx` (`rowLine`, `withActivity`), `selectors.ts` (a `roleShown` flag), `panes/lines.tsx` (cut priorities).
- Contract: none.

### F3 (Must) Give the tree room and a sane layout in small windows

- TUI now: at 90x30 stacked, the tree got 3 rows; the open permission tray takes 8 rows and the composer 3; the waiting agent
  is scrolled out of sight while the tray is asking about it. At 120x40 the tray reserves 12 rows (30%) and the transcript
  column is nearly empty in a run with no transcript yet; Worktrees takes 40% of the left column for one line.
- Proposal: the tree is the one pane that is never dropped; `STACKED_DROP_ORDER` already drops worktrees then plan, but it
  keeps the tree's share at 30% of the body. Give the tree `max(6, 30%)` and drop plan / worktrees before it shrinks. Cap the
  tray at its card's real height (it is 5 lines here, 12 reserved). With F5/F6 the Worktrees and Plan panes become one-line
  chips and collapse into the tree and the status bar by default, and return as panes via `/wt`, `/plan`.
- Files: `layout.ts` (`STACKED_SHARE`, tray height), `App.tsx` (`trayRows`), `layout.test.ts`.
- Contract: none.

### F4 (Must) Agent inspector on Enter: the per-agent detail the app puts in its side panel

- App: select a node, get role, handle, model, tokens in/out, cost, wall time, state, that agent's transcript, Usage and Plan
  tabs.
- TUI now: nothing. Selection is stored and unused. `AgentInstance.model`, `inputTokens`, `outputTokens`, `usage`, `startedAt`,
  `endedAt`, `lastText`, `result`, `worktree` are all in `TuiRun.agents`.
- Proposal: Enter on an agent row opens an inspector that replaces the right column in split layout (the plan and transcript
  move under it as one-line summaries) and the whole body in stacked/inline layout; Esc closes it and returns focus to the
  same row. Content, top to bottom, each block omitted when empty:

```
mock-lead-report-2  (Reporter)   ! Needs you
model sonnet-4-5 . 2m 14s . 1.6k in / 0.3k out . $0.03 . 4 turns . 9 tool calls
now      Wants to run: npm test                      -> d: decide
worktree worktree-agent-r2  active  2 files -> main  -> w: diff
messages sent 1 (to mock-lead) . got 2 (from mock-lead)       [F6]
-- transcript (this agent) --------------------------------
 ... TranscriptRow filtered by agentId, newest at the bottom, scrollable ...
```

  Keys inside: `d` focus this agent's decision card, `w` open the diff in the pager, `t` toggle thinking rows (the app's "Show
  thinking"), `u` the run's usage table (G11) in the pager, Up/Down scroll the transcript. The filtered transcript is the cheap
  part: `transcriptRows` already puts `agentId` on every row; `TranscriptPane` gets an `agentId?` prop.
- Files: new `InspectorPane.tsx` (+ test), `selectors.ts` (`agentDetail(state, id)`), `App.tsx` (overlay slot beside the
  existing `Overlay`), `layout.ts`, `types.ts`.
- Contract: none. Use `AgentUsage` as is (turns / tool calls exist on `AgentInstance.usage` per `runUsage`; if a field is
  missing in the mock, hide the field).

### F5 (Must) Needs-you on the node, and a key that goes to it

- App: the asking node is amber; the decision card names the agent (avatar + name) and the run; Go to decision (Ctrl+.).
- TUI now: the row has a `!` and "Needs you"; the tray header reads `R1 permission: Run npm test` with no agent. Alt+D focuses
  the tray's first card, not the one for the agent you are looking at. A card that is not for the selected agent gives no clue
  which one it is.
- Proposal: (a) row chip `! 1` (count of that agent's open cards, from `pendingItems` / the card's `agentId`; merge reviews carry
  `agentId`; for card kinds without one, attribute to the run's root and say so). A parent that is folded or off-screen shows
  the roll-up chip `! 1` on the folded group (a waiting agent is never folded, so this only applies to a subtree scrolled
  out of view: show `!N below` in the pane title). (b) tray header gets the agent: `Needs you (1) . R1 . mock-lead-report-2 .
  permission`. (c) `n` / `N` in the tree jump to the next / previous agent that needs you; Enter on such a row (or `d` in the
  inspector) focuses the tray on THAT card (needs a `focusedCardKey` prop on `DecisionTray`; trays show the first card today).
  (d) status bar keeps the count. Alt+D stays.
- Files: `selectors.ts` (`cardsByAgent`), `OrgTreePane.tsx`, `DecisionTray.tsx` (header, `focusKey`), `decisions.ts` (title
  text), `App.tsx`.
- Contract: none if every card kind exposes `agentId`; check `UserQuestion`, `Proposal`, `PermissionRuleRequest`, `McpInstallRequest`
  (the app's card shows the agent for all of them, so the data is there; the renderer reads it from `WaitingItem`).

### F6 (Should) Message lines between agents as annotations, not edges

- App: dotted edges drawn when agents message each other; the transcript shows the call.
- TUI now: dropped in `state.ts`.
- Proposal: keep a bounded `messages` list per run in TUI state (newest 200 of `{from, to, toHandle, at}`; text excluded, it is
  untrusted and already in the transcript as the SendMessage call). In the tree: the selected row's footer line shows
  `-> writer-1 (2)  <- mock-lead (1)`; rows with traffic in the last 10 s get a `~` after the state word (a pulse, no
  colour dependence). In the inspector: counts and last peer. Nothing on unselected rows by default (density).
- Files: `state.ts`, `types.ts` (`TuiRun.messages`), `selectors.ts`, `OrgTreePane.tsx`, inspector.
- Contract: none. `agent.message` is already a `RunEvent` and the TUI's stream receives all run events; confirm in a pty run
  that `runs:subscribe` forwards it to `clientKind: 'tui'`.

### F7 (Should) Focus one subtree (the terminal's zoom)

- App: zoom and fit to look into a large canvas.
- Proposal: `z` roots the tree at the selected agent (title becomes a breadcrumb `Orchestrator > mock-lead`), the transcript is
  filtered to that subtree, `Z` / Backspace pops one level. Persist nothing. Folding still applies inside.
- Files: `selectors.ts` (`orgTreeRows({ rootId })`), `OrgTreePane.tsx`, `TranscriptPane.tsx` (filter), `App.tsx`.
- Contract: none.

### F8 (Should) Show run switching and the run's chain without a tab strip

- App: tabs with status dots, one per chain, `+`.
- TUI now: `/run R2`, `/runs` as a pager table. The status bar names the followed run and says "1 live".
- Proposal: in the status bar's second segment show the live runs as chips `R1* R2!` (`*` followed, `!` needs you, finished
  ones omitted), `[` / `]` switch run from any pane (same as `/run`), Ctrl+T equivalent is `/new` only (document it; terminals
  eat Ctrl+T less than Ctrl+W, but keep the slash path as the baseline). `/runs` becomes selectable: Enter opens, `c`
  continues, `r` runs an Org retrospective (G20, G16). Reuse `runForRef`.
- Files: `StatusBar.tsx` (`StatusSummary.liveRunsList`), `selectors.ts` (`statusSummary`), `slashCommands.ts`, new run picker
  overlay, `App.tsx`.
- Contract: none.

### F9 (Must) Make the keys discoverable without a permanent legend

- App: toolbar buttons, tooltips, legend popover.
- TUI now: one hint line (focus-aware, set in `hintsFor`) that is truncated at 120 columns when the status segments are long;
  tree focus says `Tab next pane . Shift+Tab previous . Esc composer`, i.e. nothing about moving or acting. `HELP_TEXT` has no
  pane keys at all, and `?` is only a command alias typed after `/`.
- Proposal: (a) `hintsFor('tree')` returns the 4 to 5 keys that matter now and swaps by row type, e.g. `Up/Down move . Enter
  details . Right fold open . n next needs-you . ? all keys`; the hint is the first thing dropped when the status line is
  too long, but the focus-specific hint moves to the pane's own bottom border (one dim line, only for the focused pane) so
  it is never lost to status text. (b) `?` while any pane (not the composer) has focus opens a one-screen which-key overlay of
  that pane's keys plus the global ones, built from a single `KEYMAP` table that also feeds `/help` and the footer hint, so
  they cannot drift. (c) A glyph legend line in that overlay (`o working  * thinking  # tool  ! needs you  v finished  x
  failed  > folds`). (d) Esc from any pane already returns to the composer: keep.
- Files: `App.tsx` (`hintsFor`, `?` dispatch), new `keymap.ts`, `slashCommands.ts` (`HELP_TEXT` generated), `OrgTreePane.tsx`
  and the other panes (register their keys in the table), `StatusBar.tsx` (hint drop order).
- Contract: none.

### F10 (Should) Worktree and plan state on the tree row; panes become secondary

- Proposal: row chip `2f` for a worktree with changes, `review` / `conflict` in the state tone, `held`; a merge review is a
  card, so F5 already covers it. The Worktrees pane stays (diff on `v`), off by default when there is no worktree in review
  or conflict (today it shows whenever one exists). Plan: one line in the tree title (`Plan 2/5`) while the plan pane is
  hidden by F3.
- Files: `OrgTreePane.tsx`, `selectors.ts`, `App.tsx` (default visibility), `layout.ts`.
- Contract: none.

### F11 (Should) Usage view

- App: Usage tab (cost, tokens, wall time, cache hit, by agent, by role).
- Proposal: `/usage` (and `u` in the inspector) opens a text view through the existing `openText` pager: the same two tables,
  built from `RunSummary.usage` (`RunUsage`) and `AgentInstance.usage`; the shared `usageView.ts` is already in `src/shared/view/`.
  Whole chain summed like the app's status cost.
- Files: new `usageText.ts` (pure), `slashCommands.ts`.
- Contract: none (`run.usage` already reduced in `state.ts`).

### F12 (Should) Org retrospective and Save chat as project from the palette

- Proposal: `/retro` on an ended work run of a real project calls `setup:retro { projectId, runId }` through the host client
  (operate scope; confirm text names the Architect model tier as the app's tooltip does, from `lib/assistantModels.ts` logic
  if it can move to shared), then follows the new run. `/save-project <name>` for the Chat project's runs (`runs:promoteQuick`,
  currently in the registry's configure group: say so and gate with `readOnlyReason`-style refusal). Availability mirrors the
  app's `offersRetro` / `offersSaveAsProject`.
- Files: `slashCommands.ts`, `session.ts` (two methods on `TuiSessionApi` in `types.ts`).
- Contract: none new; verify `setup:retro` scope for `clientKind: 'tui'` (TUI connects with read, operate, decide).

### F13 (Could) Conversation layout

- App: "Show conversation" for single-agent runs.
- Proposal: `/focus` (or `m`) maximises the transcript and hides all other panes, `Esc` restores. For team 'single' runs start
  in that layout automatically (the app does). Today `/tree`, `/plan`, `/worktrees` toggles do it in three commands.
- Files: `App.tsx`, `slashCommands.ts`.

### F14 (Could) Role colour on the glyph

- App colours the avatar by role. A 6-colour role ring on the state glyph competes with the state tone (state is the signal),
  so skip it. Optionally colour the handle only for the selected row's ancestors (a breadcrumb in the footer line). Low value.

### F15 (Could) Logs tab

- Skip in the TUI; `orgai watch` and the pager cover it. Only add a `/logs` text view if a user asks.

### F16 Wording and small items (Low)

- Tray header lacks the agent (F5). `Earlier sessions` header is fine; its rows should fold the same way as current ones.
- `Agents (6)` should count working and waiting: `Agents 6 . 1 working . ! 1`.
- Status bar: `Needs you` (run status word) and `1 needs you` (count) read as the same thing twice in a row at 120 cols
  (`R1 Build the thing . Needs you . $0.51 . 1 needs you`). Keep the word when the run is waiting and the count only when
  more than the active run is involved, or show the count once with the amber tone.
- The hint text on the right of the status bar is cut mid-word at 120 cols ("Alt+D decisions . Tab..."). Move it (F9).

## 5. Proposed default screen (120x40, deep-tree run, one permission waiting)

```
Demo . R1* R2   Needs you . $0.51 . ! 1                               Esc composer  ? keys
+ Agents 6 . 1 working . ! 1 -------------------+ Transcript -------------------------------+
| o Orchestrator          Delegating      $0.31  | mock-lead: Reviewing report 1             |
| |- * mock-lead          Thinking        $0.12  | mock-lead-report-2: I need to run the tests|
| |  |- ! mock-lead-report-2 Needs you 2f  $0.03 | > Bash npm test  (asks you)                |
| |  `- v 1 done                         $0.02 >|                                           |
| `- v 2 done (1 failed)                 $0.08 >|                                           |
| mock-lead-report-2: Wants to run: npm test     |                                           |
| Up/Down . Enter details . n next waiting . h   |                                           |
+------------------------------------------------+-------------------------------------------+
! Needs you (1) . R1 . mock-lead-report-2 . permission: Run npm test
 y Allow once . s Allow for session . a Always . n Deny . Esc back
>  Message the run
```

Default content: the tree (5 rows), the selected row's activity, the tray, the composer. Plan and Worktrees are not drawn
unless something is in review, conflict, or the user asks. Enter opens F4's inspector over the right column.

## 6. Priorities and sequencing

Must (the org chart parity the brief asks for, no new host work):

1. F1 fold finished into "N done", default on, with expand/collapse and `h` (move `foldFinished` and `agentTree` into
   `src/shared/view/` with stubs).
2. F2 one-line rows, activity for the selected row only, state word never cut before the role.
3. F3 tree keeps room in stacked and small windows; tray height from its content; panes fold into chips.
4. F4 inspector on Enter (model, tokens, cost, time, worktree, filtered transcript).
5. F5 needs-you on the node, agent in the tray header, `n` / `N` and Enter-to-card.
6. F9 pane-aware hints, `?` which-key overlay, one `KEYMAP` table feeding hints, `/help` and the overlay.

Should: F6 messages as counts, F7 subtree focus, F8 run chips and `[` `]`, F10 worktree and plan chips, F11 `/usage`, F12
`/retro` and save as project.

Could: F13 conversation layout, F14 role colour, F15 logs.

## 7. Contracts and channels

- New host channel: none. Every proposal reads data the TUI already receives (`agent.upsert`, `agent.message`, `run.usage`,
  `plan.updated`, pending cards) or uses channels already in `HOST_CHANNEL_REGISTRY` (`setup:retro`, `runs:promoteQuick`,
  `runs:get`).
- `src/shared/types.ts`: no change. All new types (`OrgTreeRow` kinds, `TuiRun.messages`, inspector view) are TUI-local in
  `src/cli/tui/types.ts`.
- `src/shared/view/`: add `foldFinished.ts` and `agentTree.ts` (moved from the renderer, stubs left behind, tests move with
  them; `reexports.test.ts` and `noRendererImports.test.ts` pin the rule). Keep one `agentLabel` (the renderer's and `cli/render.ts`'s
  are the same rule written twice; the shared one should win, `render.ts` re-exports it).
- To verify before building (flagged, not assumed): (a) the tray's cards all expose an agent id; (b) the TUI stream receives
  `agent.message` events; (c) `AgentUsage` carries turns and tool calls for the mock and real adapters; (d) `setup:retro` and
  `runs:promoteQuick` scopes allow the TUI's `clientKind`.

## 8. Test plan hints

- Pure: `foldFinished` moved tests; `orgTreeRows` fold and expand (deep-tree fixture: 3 rows after settle, `2 done` and `1 done`
  groups, a waiting agent never folded); selection survives a fold; `cardsByAgent`; `agentDetail`.
- Frames (ink-testing-library, as in this review): 120x40, 90x30, 80x24 inline, 100x24 minimum full-screen, ASCII and
  screen-reader modes; assert the waiting agent row is visible at 90x30 and 100x24; no blank row between agents.
- pty e2e (`e2e/cli-tui.mjs`, macOS): `[mock:deep-tree]` run, wait for the fold, `Right` expands, `n` jumps to a waiting agent,
  Enter opens the inspector, `?` opens the keys overlay. Not runnable on win32 (SKIP); a real-console run on Windows is the
  open check from section 0.
