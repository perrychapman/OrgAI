# UI overhaul: status per board

Checked 2026-11-23 against the code on dev (read, not run), with the implementation notes `impl-*.md` in this folder. Where
a note and the code disagreed, the code is what this file reports and the note carries a "Corrected" line. "Unverified"
means no screenshot, e2e run or live provider confirmed it. The 38 boards are the ones in `BOARDS.md`.

Words: **built** = the screen exists and reads real data; **partly built** = built with named parts missing or replaced;
**not built** = nothing in the app. Unless a row says otherwise, every built screen was checked only on the mock adapter by
unit tests and e2e scripts, never by a screen reader, never on macOS, never on a live provider.

The Live run view (boards Run, RunLight, Scale, Agent, Engagement, Chat, RunHold) was being reassembled when this was
written. Its rows below say what the code shows (components exist) and nothing more; the detail will come from `impl-run.md`
when it lands.

## Core screens

| Board | Status | Main deviations | Unverified |
| --- | --- | --- | --- |
| Main (Home) | built | Task box "Start run" opens New run with the text and never sends (owner decision below). Working now sits left, Waiting on you right. Customise and Pause motion kept from the redesign. | Screen reader; both themes and sizes by eye; macOS. |
| Run (code project) | run view, not assessed here | Components exist (`canvas/AgentList`, `AgentFocus`, `AgentFilter`, `PlanStrip`, `RunHoldCard`). | Everything; see `impl-run.md`. |
| Team | partly built | The chart stays the React Flow editor, not the board's static three columns; no per-group "Add a role" button (the selected-role toolbar, Add group and Add role cover it); the "Suggested" role card has no token-free source; the Theme dropdown has one item. | The UX walk's High and most Mediums were not re-checked after the fixes (`impl-team.md` "UX walk"); screen reader; glass performance with many roles. |
| RunLight | run view, not assessed here | Light theme tokens are done (`impl-foundation.md`). | The live run view in light. |
| Files | built | List stays the default (the board draws Grid; Grid is remembered per project); one action row instead of a second Open / Revise / Note set; a Sort select was added. | Screen reader; macOS. |
| Usage | partly built | No plan-limit donuts; plan "resets in" wording on the page is not drawn; Compare line draws at bar centres. Spend over time is stacked bars. | Truncated, error and legacy states (the mock cannot produce them); screen reader. |
| Settings (Permissions) | built | Unattended is the "Recommended" card (the app's own default), not the middle one the board marks; arrows preview a mode and Enter saves. | Screen reader; effects wording on live providers (checked against `claude.ts` and `codexProtocol.ts` only). |

## Project and engagement

| Board | Status | Main deviations | Unverified |
| --- | --- | --- | --- |
| NewProject | built | A "How they differ" table shows until a kind is picked; engagement text is neutral. The setup choices fieldset shows on every fresh profile because built-in templates exist. | Both themes and sizes by eye. |
| Engagement (run) | run view, not assessed here | | Everything; see `impl-run.md`. |
| Knowledge | built | The graph draws the 60 most connected above 75 items with "Show all" (the redesign note said the graph always draws everything); a local `KnowledgeChip` instead of the shared `Chip`; no "Used N times". "The team is working" line is built (`impl-data.md` corrected). | Screen reader; real data volumes. |
| ProjectHome (code) | partly built | No "tests passing" or "Dependencies up to date" lines (not recorded); spend has a monthly line, no limit bar; "new run" box opens New run. | The git strip against a real repository (no e2e asserts it); macOS. |
| EngagementHome | partly built | "Plan: Approved by you" has no state to draw; no "Connect another" button (Manage opens Team > Catalog); connections never read "Connected". | Screen reader; both themes and sizes by eye. |

## Canvas themes

| Board | Status | Main deviations | Unverified |
| --- | --- | --- | --- |
| Office | built (chrome only) | The boards' plain-shape scene was not copied; the real pixel scene keeps its logic. "to" replaces the arrow in message rows; zoom group sits over the stage. | Screen reader. |
| Factory | built (chrome only) | No zoom percentage; 3D stations outside a Show filter are not dimmed (their nameplates go); the message capsule is magenta. | The full-size live 3D floor in both themes by eye (the 3D e2e passed); screen reader. |

## Large teams, decision cards and components

| Board | Status | Main deviations | Unverified |
| --- | --- | --- | --- |
| Scale (121 agents) | run view, not assessed here | `AgentList` and `AgentFilter` exist. | Everything; see `impl-run.md`. |
| Components | partly built | Cards: one look; age and "allowed N times" on permission cards, Tests and Review facts on merge cards; no age on other kinds; no "After you answer" receipts with Undo (main has none). | Screenshots of cards in both themes and sizes. |
| ComponentsLight | partly built | As Components. | As Components. |

## Daily use

| Board | Status | Main deviations | Unverified |
| --- | --- | --- | --- |
| Inbox | built | One list for waiting decisions and finished runs; the detail is the run view's own card; key guard stops a held or doubled Enter from answering. | Screen reader; a Reviewer verdict is not recorded in this folder. |
| Chat | run view, not assessed here | | Everything; see `impl-run.md`. |
| NewRun | built | Settings tiles, "who will work on it" with a per-group checkbox and an estimate for exactly that team, per-run spending limit that can only be lower. | Estimate with real history; screen reader. |
| Agent (one agent) | run view, not assessed here | `AgentFocus` exists; message and stop one agent are in `runActions`. | Everything; live `stopTask` and `turn/interrupt`. |

## Looking back and planning ahead

| Board | Status | Main deviations | Unverified |
| --- | --- | --- | --- |
| History | partly built | Per-file added / removed counts and step durations are not recorded, so not drawn; no "Undo the merge" (owner decision); no Delete branch here (it is in Settings > Branches). "Try again" opens an inline confirmation first. | A real retry on a live provider; screen reader. |
| Schedules | built | Run now, Edit, Delete and History stay on the row; the detail is read only; weekly cost and last-runs bars come from `runInsights`. | Catch-up after sleep, OS notifications, macOS. |
| EngagementTeam | partly built | No Undo / Save changes buttons (the Team saves as you edit; Undo is on each notice); "Redo the interview" reads "Review with the Architect". | The walk findings listed under Team. |

## Setup

| Board | Status | Main deviations | Unverified |
| --- | --- | --- | --- |
| Welcome | partly built | No API-key or gateway cards (connections are added in settings; the step lists the real ones); no "Recommended" badge; "Open OrgAI" leads to the start choice and the inline form, not an empty Home. | Screen reader; sign-in flow on a live provider. |
| Providers | built | No cost words per tier; account and "updated N ago" stay in each card; plan limit and reset time show on the tile. | Live proxies; screen reader. |
| Tools | partly built | The existing services dialog and presets stay (e2e drives them); the detail panel sits beside the tiles; custom servers stay under "Your own tools (advanced)". | Real MCP annotations from a live server. |
| Skills | built | Duplicate and Export are built (the first draft said not); the preview shows the first 1,200 characters as plain text. | Narrow (1024x640) screenshot; screen reader. |
| Templates | built | Built-in charts read only with Duplicate and "Used N times". | Narrow screenshot. |

## Settings

| Board | Status | Main deviations | Unverified |
| --- | --- | --- | --- |
| SettingsGeneral | partly built | No Language, no "Dates look like" control (stored, no reader), no automatic download. Open at sign-in, close behaviour, keep awake, three notification switches and Play a sound are live. | The packaged login item and power blocker; macOS. |
| Appearance | partly built | Motion "Off" is not separate (it would equal "Always reduce"). See-through panels, Text size, Spacing and Activity dots are live. | Both themes and sizes by eye for the whole pane. |
| Limits (Spending limits) | partly built | Per day and month caps, "When a limit is reached", "Warn me at", "Most agents in one run" and "Ask before using a more capable model" are live (`PERIOD_CAPS_LIVE` is true). "Let schedules run when I am near the limit" has no control (no behaviour). For plan sign-ins the caps sit in Advanced. | Caps against a live provider. |
| Branches | partly built | Main branch, Tests must pass with its command (an empty command refuses merges), keep failed branches, finished copies size and Delete branch are live. "Name new branches" has no control: no live run applies `branchNamePattern`. | The test gate's POSIX shell and process-group kill; a live merge. |
| About | partly built | Report a problem, support details, licences and Updates built; no "Download updates by themselves" (consent rule); no "Show the welcome tour again". | A live update; screen reader. |

## Edge states

| Board | Status | Main deviations | Unverified |
| --- | --- | --- | --- |
| RunHold | run view, not assessed here | `RunHoldCard` exists; holds, add budget, retry, skip review and switch model are in the runtime contract. | Everything on a live provider; see `impl-run.md`. |
| Trust | partly built | No radiogroup: the real choice is binary (Allow these settings / Stop using these settings). | Screen reader. |
| Import | built | "Suggested" role card has no token-free source; the primary button stays in the footer; "Another OrgAI project" and "Choose another" are wired. | Folder picks through the real dialog (the native picker was not driven). |
| Empty | partly built | The banners (offline, sign-in needed, update ready) and `EmptyState` are restyled; the board's empty states were not walked one by one. | Each empty state in both themes. |

## Needs owner decision

These are not built because building them changes a rule the owner set. Each has a runtime or contract note.

- **Update auto-download.** The updater never downloads on its own (`docs/agent-notes/updates.md`); the About board draws a
  switch for it. No setting, no behaviour.
- **Undo merge.** Rewrites or reverts history on the user's branch. Not built, not drawn.
- **Locale.** The app has no i18n layer; no Language control.
- **Schedules near the plan limit.** `Project.schedulesNearPlanLimit` is stored (desktop saves only) but the scheduler does
  not skip runs near the plan limit, so the control has nothing to switch.
- **One-step Start run from Home.** The task box opens the New run page with the text and never sends, so the run settings,
  spend guards and confirmations stay in one place. A one-click start would bypass them.
- **Branch name pattern.** `Project.branchNamePattern` is validated in main and `branchNameFor` exists, but nothing calls it,
  so no live run applies the pattern (Claude's SDK names its worktree branches) and no control ships.

## Open

- No screen-reader pass anywhere in the overhaul (speech of the role toolbar, tier radios, Inbox, galleries, cards, the
  gallery counts and the zoom readout is unheard).
- macOS and Linux are unchecked, including the login item, the power blocker and the POSIX shell test gate.
- Live providers are unverified for everything runtime-backed: the budget stop, `stopTask`, `turn/interrupt`, `api_retry`
  and Codex `willRetry`, spend caps against real billing, retry and add budget on a real run. Unit tests use fake adapters.
- Screenshots in both themes and both sizes exist per area, not per board; narrow Skills and Templates, the full-size 3D
  floor and the Welcome flow were not all looked at.
- The first-time-user walk of the Team tab (`docs/design/ux-review-team-overhaul.md`) has one High and several Mediums that
  were not re-checked; M3 and M4 are confirmed still present.
- `README.md` in this folder still says "No app code has been changed" and "design only"; it describes the design handoff,
  not the build.
- The Live run view detail is pending `impl-run.md`.
