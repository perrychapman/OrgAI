# UI overhaul: status per board

Checked 2026-11-23 against the code on dev (read, not run), with the implementation notes `impl-*.md` in this folder, and
updated the same day for the fixes since the first pass (UX walk findings, the Live run view, review rounds). Where
a note and the code disagreed, the code is what this file reports and the note carries a "Corrected" line. "Unverified"
means no screenshot, e2e run or live provider confirmed it. The 38 boards are the ones in `BOARDS.md`.

Words: **built** = the screen exists and reads real data; **partly built** = built with named parts missing or replaced;
**not built** = nothing in the app. Unless a row says otherwise, every built screen was checked only on the mock adapter by
unit tests and e2e scripts, never by a screen reader, never on macOS, never on a live provider.

The Live run view (boards Run, RunLight, Scale, Agent, Engagement, Chat, RunHold) is built on dev; the detail is in
`impl-run.md` and `impl-run-header.md`, and the rows below summarise it. Its checks are the mock adapter's: `e2e/run-hold.mjs`,
`runs.mjs`, `run-start.mjs`, `canvas.mjs`, `model-switch.mjs`, `live-changes.mjs`, screenshots in both themes at 1024x640 and
1600x1000 for the hold card, the one-agent view, the header and the dock. The mock's largest run is 40 agents
(`[mock:factory-floor]`), so nothing larger was drawn.

## Core screens

| Board | Status | Main deviations | Unverified |
| --- | --- | --- | --- |
| Main (Home) | built | Task box "Start run" opens New run with the text and never sends (owner decision below). Working now sits left, Waiting on you right. Customise and Pause motion kept from the redesign. "Your week" says "No prior data" when the week before holds no run (no growth from zero). | Screen reader; both themes and sizes by eye; macOS. |
| Run (code project) | partly built | The conversation dock is a right-hand column against the window edge, not the board's floating card (a margin broke the resize handle's width arithmetic); open / hidden / rail by the run view's width, only the user's Hide hides the composer; the chart stays the React Flow node chart, not department boxes; the settings row is one scrolling line, so the composer is cramped at 1024x640; no dock shortcut. Header chips fold into a "more" menu (status never; permission mode to an icon before cost). The proposal next step is a note row above the run body. | Screen reader; forced colours; a header with many chips folded; reduced motion for the dock glide (end states only). |
| Team | partly built | The chart stays the React Flow editor, not the board's static three columns; no per-group "Add a role" button (the selected-role toolbar, Add group and Add role cover it); the "Suggested" role card has no token-free source; the Theme dropdown has one item. Fixed since the walk: toolbar kept in view and next in Tab order, new role panned into view, "Add group lead" form, compact Theme control at 1024, zoom buttons disable at limits, assistant fold choice remembered for the session. | Walk H1 (the "Review with the Architect" confirm clipped its cost sentence) and the Lows were not re-walked; screen reader; glass performance with many roles. |
| RunLight | partly built | Light theme tokens are done (`impl-foundation.md`); the header, hold card and one-agent view were looked at in light at both sizes. | The whole run view in light by eye (dock, tray, scenes); screen reader. |
| Files | built | Opens in Grid when no choice is saved (`readViewMode`), the saved per-project choice wins (`impl-data.md` said List: corrected); one action row instead of a second Open / Revise / Note set; a Sort select was added. | Screen reader; macOS. |
| Usage | partly built | No plan-limit donuts; plan "resets in" wording on the page is not drawn; Compare line draws at bar centres. Spend over time is stacked bars. | Truncated, error and legacy states (the mock cannot produce them); screen reader. |
| Settings (Permissions) | built | Unattended is the "Recommended" card (the app's own default), not the middle one the board marks; arrows preview a mode and Enter saves. One set of mode names (`lib/permissionWords.ts`) on the Home task box, run settings, Settings, the settings proposal card and first launch (the walk found four). | Screen reader; effects wording on live providers (checked against `claude.ts` and `codexProtocol.ts` only). |

## Project and engagement

| Board | Status | Main deviations | Unverified |
| --- | --- | --- | --- |
| NewProject | built | A "How they differ" table shows until a kind is picked; engagement text is neutral (no client, sponsor or deliverable words anywhere in the renderer; the stored `client` field is plain data). The setup choices fieldset shows on every fresh profile because built-in templates exist. | Both themes and sizes by eye. |
| Engagement (run) | partly built | `.run-view[data-kind='engagement']`: serif headings, coral selection and plan accents, the same dock; neutral wording; no Context screen, no per-run source picker. | Seen on the mock only; the coral plan strip segment (visible only while a step is in progress) was not seen; screen reader. |
| Knowledge | built | The graph draws the 60 most connected above 75 items with "Show all" (the redesign note said the graph always draws everything); a local `KnowledgeChip` instead of the shared `Chip`; no "Used N times". "The team is working" line is built (`impl-data.md` corrected). "Recorded by" is one choice, Everyone / You / Team (`impl-data.md` said chips). | Screen reader; real data volumes. |
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
| Scale (121 agents) | partly built | `AgentFilter` (All / Working / Waiting with counts, dims, never hides, "N of M agents shown"), Find an agent opening the Agents tab with a searchable flat `AgentList`, and the existing finished-agent folds; no department boxes (the chart is still the node chart); the toolbar drops the Show filter under 1100 px of frame, Find under 900. | **The 121-agent look is unverified**: the mock's largest run is 40 agents (3 leads, 9 sub-leads, 27 workers), checked at both sizes ("Showing 40 of 40"); the minimap did not render in that look; folded finished groups were not on screen; screen reader. |
| Components | partly built | Cards: one look; age and "allowed N times" on permission cards, Tests and Review facts on merge cards; no age on other kinds; no "After you answer" receipts with Undo (main has none). | Screenshots of cards in both themes and sizes. |
| ComponentsLight | partly built | As Components. | As Components. |

## Daily use

| Board | Status | Main deviations | Unverified |
| --- | --- | --- | --- |
| Inbox | built | One list for waiting decisions and finished runs; the detail is the run view's own card; key guard stops a held or doubled Enter from answering; focus lands on the first row on arrival (J / K work), and the empty state names how many teams have a run going. | Screen reader; a Reviewer verdict is not recorded in this folder. |
| Chat | partly built | A Chat session keeps the conversation-first layout (no dock) with the composer, settings row and `LiveModelSwitch`; the glass look and the decision cards are shared with the run view. | Not walked against the board by eye; screen reader. |
| NewRun | built | Settings tiles, "who will work on it" with a per-group checkbox and an estimate for exactly that team, per-run spending limit that can only be lower. "Save as a schedule" carries what a schedule can hold and names what it could not; a one-shot Team / Ask mode from another page is applied once and not remembered. | Estimate with real history; screen reader. |
| Agent (one agent) | partly built | `AgentFocus` takes the stage from "Open agent view" or a double click; Escape or "Back to chart" returns focus to the opener; shows elapsed time; message and stop one agent go through `runActions`. | Live `stopTask` and `turn/interrupt`; screen reader. |

## Looking back and planning ahead

| Board | Status | Main deviations | Unverified |
| --- | --- | --- | --- |
| History | partly built | Per-file added / removed counts and step durations are not recorded, so not drawn; no "Undo the merge" (owner decision); no Delete branch here (it is in Settings > Branches). "Try again" (continues a failed run) opens an inline confirmation first; "Run it again" (opens New run with the request) sits beside it, each with a line saying what it does. | A real retry on a live provider; screen reader. |
| Schedules | built | Run now, Edit, Delete and History stay on the row; the detail is read only; weekly cost and last-runs bars come from `runInsights`. | Catch-up after sleep, OS notifications, macOS. |
| EngagementTeam | partly built | The header carries the latest change's Undo (the notice row's own action) and says the Team saves as you edit; no Save changes button; "Redo the interview" reads "Review with the Architect". | Walk H1 and the Lows listed under Team. |

## Setup

| Board | Status | Main deviations | Unverified |
| --- | --- | --- | --- |
| Welcome | partly built | Step 3 names the real permission modes with the shared words; no API-key or gateway cards (connections are added in settings; the step lists the real ones); no "Recommended" badge; "Open OrgAI" leads to the start choice and the inline form, not an empty Home. | Screen reader; sign-in flow on a live provider. |
| Providers | built | No cost words per tier; account and "updated N ago" stay in each card; plan limit and reset time show on the tile. | Live proxies; screen reader. |
| Tools | partly built | The existing services dialog and presets stay (e2e drives them); the detail panel sits beside the tiles; custom servers stay under "Your own tools (advanced)". | Real MCP annotations from a live server. |
| Skills | built | Duplicate and Export are built (the first draft said not); the preview shows the first 1,200 characters as plain text. | Narrow (1024x640) screenshot; screen reader. |
| Templates | built | Built-in charts read only with Duplicate and "Used N times". | Narrow screenshot. |

## Settings

| Board | Status | Main deviations | Unverified |
| --- | --- | --- | --- |
| SettingsGeneral | partly built | No Language, no "Dates look like" control (stored, no reader), no automatic download. Open at sign-in, close behaviour, keep awake, three notification switches and Play a sound are live. | The packaged login item and power blocker; macOS. |
| Appearance | partly built | Motion "Off" is not separate (it would equal "Always reduce"). See-through panels, Text size, Spacing and Activity dots are live. | Both themes and sizes by eye for the whole pane. |
| Limits (Spending limits) | partly built | Per-run, per day and per month limits, "When a limit is reached", "Warn me at", "Most agents in one run" and "Ask before using a more capable model" are live (`PERIOD_CAPS_LIVE` is true) and every limit shows at rest on every sign-in (the first pass hid the caps in Advanced on a plan sign-in: corrected). "Let schedules run when I am near the limit" has no control (no behaviour). | Caps against a live provider. |
| Branches | partly built | Main branch, Tests must pass with its command (an empty command refuses merges), keep failed branches, finished copies size and Delete branch are live. "Name new branches" has no control: no live run applies `branchNamePattern`. Merges now run neutral (hooks off, global git config ignored, git 2.32 or newer) and refuse a file with a `filter` attribute: see Open. | The test gate's POSIX shell and process-group kill; a live merge. |
| About | partly built | Report a problem, support details, licences and Updates built; no "Download updates by themselves" (consent rule); no "Show the welcome tour again". | A live update; screen reader. |

## Edge states

| Board | Status | Main deviations | Unverified |
| --- | --- | --- | --- |
| RunHold | built | `RunHoldCard` replaces the pause, plan-blocked and run-error banners and shows the six hold kinds from `RunSummary.hold`. Add budget, Skip review, Try again and Continue ask first through a confirmation that names the amount or the gate (focus on Cancel, one in-flight guard); refusals show inline; Use another model focuses the model switch. The card is tall at 1024x640 (the tray scrolls, the action row is sticky). Checked on `[mock:budget-stop]` and `[mock:provider-error]`. | Everything on a live provider (the budget stop, `api_retry`, Codex `willRetry`); screen reader. |
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
- **The 1.5x backstop figure.** A first-party Claude run under only the project budget is stopped by the SDK's own total;
  main steps in earlier only when the SDK has reported no total yet, or when its own estimate reaches 1.5 times the cap
  (`SDK_BACKSTOP_RATIO` in `runManager.ts`). 1.5 is a judgement: far enough above the SDK's rounding and cache pricing
  differences that a hit means the total or the price table is wrong, near enough that a run cannot spend several times its
  cap first. The owner may want a different figure; changing it can raise spend, so it needs the Reviewer.

## Open

- A Reviewer pass on the run view's hold actions, dock and focus handling is not recorded in this folder.
- Git-lfs repositories (any file with a `filter` attribute that a report changes) refuse automatic merges: OrgAI's neutral
  merge runs no filter program, so the branch is kept and the user merges by hand with git. Also changed for everyone: merges
  run with hooks off and the user's global git config ignored, and need git 2.32 or newer. Unverified on a real git-lfs
  repository and on an older git.
- Known limits of the merge pin (`impl-runtime.md`): configuration pulled in by `include.path` is not pinned;
  `commit.gpgsign` and `gpg.program` in the repository config are not forced off; `discardWorktree` and `commitLeftovers`
  use the unguarded git runner (outside the merge path); the pin cannot tell the user's own edit from the test command's, so
  with no review card the merge is refused, and another OrgAI process (the `orgai` CLI) merging into the same checkout reads
  as a change by someone else; an agent that runs `git merge` itself is not blocked.
- `src/renderer/src/styles/layout.css` still holds an unused `.run-meta-next-list` rule (the proposal next step moved to
  `ProposalNextNote`, which uses `.proposal-next-list`); left alone because this pass changed docs only.

- No screen-reader pass anywhere in the overhaul (speech of the role toolbar, tier radios, Inbox, galleries, cards, the
  gallery counts and the zoom readout is unheard).
- macOS and Linux are unchecked, including the login item, the power blocker and the POSIX shell test gate.
- Live providers are unverified for everything runtime-backed: the budget stop, `stopTask`, `turn/interrupt`, `api_retry`
  and Codex `willRetry`, spend caps against real billing, retry and add budget on a real run. Unit tests use fake adapters.
- Screenshots in both themes and both sizes exist per area, not per board; narrow Skills and Templates, the full-size 3D
  floor and the Welcome flow were not all looked at.
- The first-time-user walk of the Team tab (`docs/design/ux-review-team-overhaul.md`): the Mediums were fixed (toolbar in
  view, labels and Theme at 1024, "Add group lead", Tab order, import wording) and the code was read, not re-walked; M3 (the
  Theme dropdown has one item) is still true, and H1 (the "Review with the Architect" confirm clipped its cost sentence) and
  the Lows were not re-checked. The first-time-user walk of the rest (`ux-review-ui-overhaul.md`): its three Highs
  (neutral engagement words, limits at rest, one set of mode names) and the Mediums on the Inbox (M4, M5), the week recap
  (M7) and History's two buttons (M11) are fixed in the code; M2 stays an owner decision (above); the other Mediums and the
  Lows were not checked here. Nothing was re-walked.
- The 121-agent Scale board and a run with every header chip folded were never drawn (the mock tops out at 40 agents).
- `docs/design/ui-overhaul/README.md` is the design handoff; its status line now points here.
