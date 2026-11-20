# Dashboard overhaul: a personal home (pass 3)

Status: spec, decided, to be built as written. It supersedes `dashboard-2.md` sections 2-4, 6-9 and 12-16 for the layout, copy
and test ids named here; the rules of dashboard-2.md sections 5 (Needs you rows and inline answers), 6.4-6.8 (band rows,
data and performance), 10.3-10.4 (tile signals, project queue) and 11 (data rules) stand unless this file says otherwise.
Baseline: `ux-review-dashboard-3.md` (no new walk was done). Renderer only, plus the two small contracts in section 4.

Why: the owner wants the home screen to "feel more personal" and rejected the operations console. Today it addresses
nobody, remembers nothing about the person, repeats one decision in five places (walk 3 M5) and cannot be arranged.

## 1. Principles

1. **A brief before a board.** The first thing on the page is one or two true sentences about what changed since the person
   was last here and what waits on them. A greeting never appears without state behind it.
2. **One home per fact.** A decision lives in Waiting on you, a live agent in Working now, a finished conversation in Pick
   up. Everywhere else a fact is at most a word or a count that points there. This closes walk 3 M5.
3. **A section exists only when it has something to say.** No empty boxes, no "Nothing needs you." filler. Quiet is designed:
   it is the greeting saying so.
4. **Honest and calm.** Totals are the person's own, never a streak, a target or a comparison. Unknown cost is never $0, a
   partial figure is a lower bound. Colour directs: one tinted block on the page (Waiting on you), everything else is plain.
5. **The person arranges it and it remembers.** Order, hidden sections and pinned projects are theirs, reachable by keyboard,
   reversible with one Reset.

| Borrowed from | Idea | Where it lands |
| --- | --- | --- |
| Sunsama (verified) | A day drafted from your tools that you adjust, calm tone, a closing recap | Today (schedules plus to-dos), Your week, tone of every string |
| Notion Home (verified) | Recents and favourites; a section appears only once it has content; per-section move, hide, Reset | Pick up, pins, the empty-section rule, Customise |
| Stripe Dashboard (verified) | Pinned pages plus most recently visited | Pick up (pinned projects first, then recents) |
| Linear My Issues / Inbox (verified) | Focus order: blocked and urgent first; unread first | Waiting on you order (7.2), ended-since rows first in Pick up |
| Apple Fitness (verified) | "Your next workout", progress as a live instrument | Pick up's one next action per row, Working now marks |
| WakaTime (verified) | Honest personal totals per project, no streaks | Your week, tile foot |
| Codex app, Cursor background agents (verified) | All parallel work in view; run cards lead to artifacts | Working now, "Open output" in Pick up |
| Things 3 (verified) | Never messy or overbearing | Sections unboxed, caps with "Show more", no chrome |
| Spotify (snippets only) | Time-of-day greeting whose content changes with it | Greeting (section 5) |

Rejected on purpose: streaks and goals (guilt), a vanity totals row, a chart-heavy home, a greeting with no state, drag as
the only way to arrange, an "AI summary" (everything on the page is computed from stored facts, no model call).

## 2. Layout

The topbar (h1 "Dashboard", New chat, New project) is unchanged: the app focuses `main .topbar h1` after navigation, so it
stays the page's one h1. The greeting is a paragraph, not a heading.

### 2.1 DOM and reading order (one column of sections, always)

1. `SecretNotices`, `forget-notice` Banner (unchanged, above everything: data-loss and storage notices outrank the brief)
2. Greeting `dashboard-hero` (salutation, brief, name control, Customise button) and the page's one live region
3. Customise bar (only while customising)
4. **Waiting on you** `dash-needs-you` (fixed: first, not hideable)
5. **To finish setting up** `dash-setup` (fixed: second, not hideable, rows only when something is missing)
6. The five arrangeable sections, in the person's order, default: **Pick up where you left off**, **Today**,
   **Working now**, **Your week**, **Projects**
7. Footer line `dashboard-app-facts` (version, Dev and Mock badges)

Visual order equals DOM order at every width; there is no `order`, no `grid-auto-flow: dense`.

### 2.2 Tracks

`.dash-page` is a size container named `dash`. Content width is the container, with page padding `--space-6`.

- Narrow (container under 1000 px; 1024x640 gives about 920): one track, every section full width.
- Wide (container 1000 px and up; 1600x1000 gives about 1320): two equal tracks, gap `--space-8`. Pairing is computed in
  JavaScript by `placeSections` (pure): walking the visible arrangeable sections in order, two consecutive half-width
  sections share a row (left then right); a half-width section with no partner takes the full row. Half: Pick up, Today,
  Working now, Your week. Full: Projects (always), Waiting on you, To finish setting up. So the default wide layout is
  Pick up | Today, Working now | Your week, then Projects across. Hiding Working now gives Pick up | Today, Your week
  (full), Projects. While customising, everything is one full-width track.
- Caps follow the same breakpoint through `useDashCaps` (`WIDE_AT_PX` becomes 1000 and is measured on `.dash-page`).
  `useShortRegion`, `useBandBudget`, `fitBandModel`'s height budget, the "tall" strip and `data-now-empty` are removed: nothing
  on this page sizes itself to a neighbouring column any more.

### 2.3 What collapses first, in order

1. Two tracks become one (under 1000 px).
2. In Your week the ledger drops under the three figures (under 560 px of section width).
3. The second caption line of a row (project and time) joins its first line with a dot, then clips with an ellipsis.
4. Project tiles: 3 columns, then 2 (under 760 px), then 1 (under 440 px); the team marks hide under 440 px.
5. The brief wraps; the Customise button keeps its label down to 560 px of page width, below that it is an icon with the
   same accessible name.

### 2.4 Wireframe, 1600x1000, dark or light (sidebar 232, container about 1320; busy day)

```
+ Dashboard ------------------------------------------ [New chat] [New project] +
| Good morning, Sam.  (pencil)                                      [Customise] |
| 2 decisions are waiting on you. 3 runs finished since you were last here,      |
| costing $1.42.                                                                |
|                                                                                |
| Waiting on you  2                                       (the one tinted block) |
|  Billing API  R3 Fix rounding     Orchestrator wants to run: npm test         |
|     In the project                                  [Allow once] [Deny]        |
|  Q4 audit  Draft summary          specialist-1 wants to edit: notes.md        |
|     In the project                                  [Allow once] [Deny]        |
|                                                                                |
| ---- Pick up where you left off ---+---- Today        Thursday 19 November --- |
|  Finished  Fix rounding   Billing   |  Scheduled                              |
|  3 min ago          [Open output]   |   14:00  Nightly PR monitor  Billing    |
|  Paused  Import job  Docs site      |   Ran 08:00  Weekly digest  Finished    |
|  resumes 14:05      [Resume now]    |  To-dos                                 |
|  Idle  Chat: tax question           |   Follow up with Acme   [Start session] |
|  2 h ago            [Continue]      |   Update the docs index [Start session] |
|  Show 2 more                        |   Show 3 more                           |
| ---- Working now ------------------+---- Your week -------------------------- |
|  Mobile app  R2 Deep tree           |  12 runs   6h 40m+ working   $4.20      |
|   specialist-1  Delegating ...      |  [ledger: 7 columns, Thu is today]      |
|   3 done                            |  Most active: Mobile app, 8 runs        |
|                                     |  Claude plan 62% resets in 2 h          |
| ---- Projects  6 ------------------------------------------------------------ |
|  [* Mobile app ] [  Billing API ] [  Docs site ]                               |
|  [  Q4 audit   ] [  Notes API   ] [  Site v2   ]                               |
+ OrgAI 0.1.7 ----------------------------------------------------------------- +
```

### 2.5 Wireframe, 1024x640 (56 px rail, container about 920, region about 592 px tall; single track)

```
+ Dashboard ------------------------------- [New chat] [New project] +
| Good morning, Sam.                                     [Customise] |
| 2 decisions are waiting on you. 3 runs finished since you were     |
| last here, costing $1.42.                                          |
| Waiting on you  2                                                  |
|  Billing API  R3 Fix rounding                                      |
|   Orchestrator wants to run: npm test   [Allow once] [Deny]        |
|  Q4 audit  Draft summary                                           |
|   specialist-1 wants to edit: notes.md  [Allow once] [Deny]        |
| ---------------------------------------- fold at about y 592 ---- |
| Pick up where you left off                                         |
|  Finished  Fix rounding   Billing API     3 min    [Open output]   |
```

With three decisions the first Pick up row sits at the fold, by design: decisions first. With none, the greeting, four Pick up
rows and the top of Today fit. The page scrolls inside `.dashboard`; the window never does.

### 2.6 First launch (no projects)

Greeting "Welcome to OrgAI." plus its line, then `FirstLaunch` unchanged (`dash-start-choice`, inline form, `empty-chat-now`).
No Customise button, no sections, no footer except app facts. The name control is shown (section 5.3).

## 3. Visual treatment (tokens only, no new typeface, no new dependency)

- Salutation: `--text-display` (24/32) weight 600 from 1000 px, `--text-title-lg` (20/28) below. Brief: `--text-title-sm`
  (14/20) in `--text-secondary`, `max-width: 64ch`, `text-wrap: pretty`. The name is a text node, one line, ellipsis with the
  full text in `title`.
- Section: `h2` at `--text-title-sm` weight 600 in `--text-primary`, an optional count in mono `--text-caption`
  `--text-tertiary` on the same line, a top hairline `--border-subtle` and `--space-4` above the content. No box, no
  `--surface-*` fill. This is what separates the page from the walk-3 "same box everywhere" finding.
- The one tinted block: Waiting on you keeps today's row styling (`dashboard-needs.css`, the warm tint, the row
  buttons). Nothing else on the page uses the warning tint: a tile with a decision shows only its count word, a band run
  with a decision says "Waiting on you" in plain text.
- Rows (Pick up, Today, band, setup): no fill, `--border-subtle` hairline between rows, 44 px minimum row height, the action
  button right-aligned and `size="sm"`, `variant="secondary"` (the only primary on the page stays New project).
- Section rhythm: `--space-8` between sections wide, `--space-6` narrow; rows `--space-3` inside.
- Tiles keep `--surface-1`, `--radius-lg`, `--border-default`; they are the only other boxed thing.
- No new tokens. `--dash-strip-bar`, `--dash-strip-today`, `--halo-working`, `--dur-pulse` stay. The ledger uses the first two.
- Both themes: every colour is a token; the working halo is dark-only as built. Status words come only from
  `lib/runStatus.ts` (Running, Needs you, Idle, Paused, Finished, Stopped, Failed); colour never stands alone.

## 4. The two contracts (land first)

### 4.1 Display name (main plus renderer)

```ts
// src/shared/types.ts, AppSettings
/** The person's own name, for the Dashboard greeting only. Absent = none. Normalised by cleanDisplayName. Never sent to a model. */
displayName?: string
// src/shared/displayName.ts (new, pure)
export const DISPLAY_NAME_MAX_CHARS = 40
/** Trim, collapse inner whitespace to single spaces, refuse control, bidi, zero-width and other format characters
 *  (the check the to-do text cleaner uses), clip nothing: a name over 40 characters or with a refused character is
 *  `undefined` (unset). */
export function cleanDisplayName(input: unknown): string | undefined
```

- Default: absent. Persisted in `settings.json` next to `schedulesPaused`, same shape of change: `store/settings.ts`
  `normalizeSettings` keeps `...(clean ? { displayName: clean } : {})`; `settings.test.ts` gains round trip, whitespace,
  hidden characters, 40 and 41 characters, non-string, and "an absent field clears it". `AppSettingsInfo` inherits it.
  The files that mention `schedulesPaused` are the checklist (`types.ts`, `store/settings.ts` and its test, and check
  `host/bootstrap.ts` and `shared/view/atlas.ts` for a settings listing; add the field only where the others are listed).
- Writers: `settings.set` takes the whole object. Add `saveDisplayName(name: string | null)` beside `saveSchedulesPaused` (same
  serialised read, merge, write; an unsaved result throws "The name was not saved."). Unverified: that every existing
  settings writer spreads the stored settings and so keeps the name; the build greps every `settings.set(` caller and fixes any
  that rebuilds the object.
- Edit surfaces: App settings > General, a new first section "About you" (`appsettings-section-about-you`) with one
  `SettingRow` "Your name", `Input` `display-name-input`, `maxLength` 40, hint "Used for the greeting on the Dashboard. It
  stays on this computer. Leave it empty for no name." Saves on blur and Enter like the other General fields, an inline
  error under it on failure. Inline from the greeting (section 5.3).
- Fallback when unset: the greeting has no name ("Good morning."). Never the OS account name. Why: a login name is often a
  handle ("jsmith2", "admin"), can be a shared or work account the person never chose to be called, and reading it needs a
  new main call. A name the person typed is the only name used.
- Privacy: the name is rendered only in the greeting and the two edit fields. It is not in any prompt, run event, log
  line, notification, window title, tray text or error string. Acceptance 31 checks this by search.

### 4.2 Layout preferences (renderer localStorage, no settings)

Key `orgai.dashboardLayout`, beside `orgai.dashboardSeenAt`. They stay in localStorage because they are a view preference of
this machine's window, main has no use for them, the CLI shares nothing with the desktop, and a settings field would add a
main change, a type and a normaliser for no reader. If localStorage throws, the layout lives in memory for the session and
the defaults load next time; nothing is reported.

```ts
// src/renderer/src/lib/dashboardLayout.ts (new, pure, unit-tested)
export const DASH_SECTIONS = ['resume', 'today', 'working', 'week', 'projects'] as const
export type DashSectionId = (typeof DASH_SECTIONS)[number]
export interface DashboardLayout {
  v: 1
  order: DashSectionId[]        // every id exactly once
  hidden: DashSectionId[]       // subset of order
  pinned: string[]              // project ids, in the order they were pinned, at most 24
}
export const DEFAULT_LAYOUT: DashboardLayout = { v: 1, order: [...DASH_SECTIONS], hidden: [], pinned: [] }
normalizeLayout(raw: unknown): DashboardLayout       // unknown ids dropped, missing ids appended in default order,
                                                     // duplicates dropped, non-strings dropped, wrong version = default
moveSection(l, id, 'up' | 'down'): DashboardLayout   // no-op at the ends
setHidden(l, id, hidden: boolean): DashboardLayout
togglePin(l, projectId): DashboardLayout             // append when pinning, remove when unpinning, cap 24 (refuse past it)
pruneLayoutPins(l, knownProjectIds): DashboardLayout // run when projects load and after a delete
resetLayout(l): DashboardLayout                      // order and hidden back to default; pinned kept
placeSections(visible: DashSectionId[], twoTracks: boolean): { id: DashSectionId; span: 'half' | 'full' }[]
readLayout(storage) / writeLayout(storage, l)        // try/catch, never throws
```

Fixed sections (Waiting on you, To finish setting up) and the secret notices are not in the layout: they cannot be hidden or
moved, because hiding them would hide a decision or a blocker. A hook `useDashboardLayout()` reads once, writes on every
change, and follows the `storage` event so a second window agrees. Reset keeps pins (a pin is a statement about a project,
not about layout; "Unpin" is its own action).

## 5. Greeting (`dashboard-hero`)

### 5.1 Structure

`section.dash-greeting[aria-label="Overview"]` holds `p.dash-salutation` (`dash-greeting-salutation`), `p.dash-brief`
(`dash-greeting-brief`), the name control and the Customise button, and the sr-only live region `dashboard-live`
(unchanged: the page's one polite region). The brief is not live; it never announces. Its text may update while the person
reads (a run finishes); a changing sentence is expected, nothing moves.

### 5.2 Salutation

By local hour at mount and every 30 s (`useNow`): 05:00-11:59 "Good morning", 12:00-16:59 "Good afternoon", 17:00-21:59
"Good evening", 22:00-04:59 "Hello". With a name: "Good morning, Sam." Without: "Good morning." No projects: "Welcome to OrgAI."
(no name, even when one is set; it is a first-launch screen).

### 5.3 Name control

- Name unset: ghost `Button` size sm, "Add your name" (`dash-name-add`), after the brief. Name set: `IconButton` Pencil, label
  "Change your name" (`dash-name-edit`), after the salutation.
- Either opens a `Popover` (existing wrapper) with a labelled `Input` "Your name" (`dash-name-input`, `maxLength` 40, initial
  focus, Enter saves), the hint "Used for the greeting on the Dashboard. It stays on this computer.", `Button` primary "Save"
  (`dash-name-save`) and "Cancel" (`dash-name-cancel`). Saving an empty field clears the name ("Remove name" is the button
  label while a name exists and the field is empty). Esc cancels. Focus returns to the control that opened it.
- Error: a text line under the input, `role="alert"`, `dash-name-error`: "The name was not saved. Try again." The field keeps
  what was typed. Refused input (hidden characters or over 40): "Use up to 40 letters, numbers or spaces." (the input also stops at 40).
- Announce through `dashboardLive`: "Name saved." / "Name removed."

### 5.4 The brief (`lib/dashboardBrief.ts`, pure, unit-tested)

Inputs and where each comes from (all existing):

| Input | Source |
| --- | --- |
| `now`, hour | `useNow()` (Date) |
| `lastSeen`, `firstVisit` | `useLastSeen()` (`orgai.dashboardSeenAt`; `firstVisit` is new: true when no value was stored; `clearedAt` and `markAllSeen` are removed) |
| Finished F, failed X, closed-while-waiting C since `lastSeen` | `sinceLastSeen(useAllSummaries(), lastSeen, now, ...)` items of kind `finished`, `failed`, `closed-waiting` (stopped and closed runs are the person's own act and are not counted) |
| Cost of those runs | `sumCosts(items.map(runCostInput))` then `costView` (known, partial, unknown) |
| Decisions W | `useDecisionTotal()` (the bell) |
| Working agents A, runs R | `bandWorkFacts(...)` through `useBandSnapshot()` (a run waiting on a card is not working) |
| Paused P, resume time | `pausedRuns(summaries)`, earliest `pausedUntil` with `autoResume`, `clockLabel` |
| Any run ever | `useAllSummaries().length > 0` |
| Ready | every project's history loaded (`projects.every(p => p.id in historyByProject)`) |

Composition (at most two sentences):

1. If W > 0, sentence one is the waiting sentence. Then one more sentence: the first present of since (S), closed (C),
   working, paused.
2. If W = 0: the first two present of S, C, working, paused, in that order.
3. If none is present: the quiet sentence. If no run has ever existed: the empty-history line.
4. Until Ready, the brief shows only the present-state sentences (waiting, working, paused) and never the quiet sentence or S
   or C, so "Nothing has changed" cannot flash before history loads; the line keeps its height (`min-height: 2 lines`).
5. When `lastSeen` is older than 7 days, or `firstVisit`, "since you were last here" reads "in the past 7 days".

| Variant | Exact text |
| --- | --- |
| No projects | "Welcome to OrgAI." then "Start a project or just chat. Nothing runs until you say so." |
| Projects, no run ever | "No runs yet. Open a project to start one." |
| Quiet | "Nothing has changed since you were last here, and nothing is waiting on you." |
| Waiting | "1 decision is waiting on you." / "{W} decisions are waiting on you." |
| Finished | "1 run finished since you were last here." / "{F} runs finished since you were last here." |
| Finished and failed | "{F} runs finished and {X} failed since you were last here." |
| Failed only | "1 run failed since you were last here." / "{X} runs failed since you were last here." |
| Cost clause (appended to S, before the full stop) | ", costing $1.42" (known), ", costing at least $1.42" (partial), ", costing less than $0.01" (under one cent); omitted for unknown and for a reported zero |
| Closed while waiting | "1 run was waiting on you when OrgAI closed." / "{C} runs were waiting on you when OrgAI closed." |
| Working | "1 agent is working in 1 run." / "{A} agents are working in {R} runs." |
| Paused | "1 run is paused until 14:05." / "{P} runs are paused until 14:05." / "1 run is paused." |
| Older than 7 days | "{F} runs finished in the past 7 days." (same for failed) |
| Example, things waiting | "2 decisions are waiting on you. 3 runs finished since you were last here, costing $1.42." |
| Example, finished | "Good evening, Sam." / "3 runs finished since you were last here, costing $1.42. 1 agent is working in 1 run." |
| Example, quiet | "Hello." / "Nothing has changed since you were last here, and nothing is waiting on you." |

Plurals through `plural(n, one, many)`. No exclamation marks, no emoji, no "great news". Cost text through `costView` and
`formatUsdCompact`; the clause for a known zero is omitted, never "$0.00".

## 6. Customise

### 6.1 Entry and shape

`Button` ghost with the `SlidersHorizontal` icon, label "Customise" (`dash-customise`, `aria-expanded`), at the end of the
greeting row. Pressing it turns on customise mode in place; the label becomes "Done" (`dash-customise-done` is the same
button). There is no dialog and no Apply step: every change is saved at once (a Stripe-style Apply was rejected because
nothing here is costly to undo and a pending buffer is a state to forget about).

### 6.2 What changes while customising

- A sticky bar `dash-customise-bar` under the greeting: a sentence "Move, hide or show sections. Changes save as you go." and
  `Button` ghost "Reset layout" (`dash-customise-reset`). Sticky at the top of `.dashboard`, `--surface-0` background, hairline
  below.
- Every arrangeable section is listed in the person's order, full width, in a `div[role=group][aria-label="Arrange {title}"]`
  control row (`dash-section-controls[data-section]`) above its content: `IconButton` "Move {title} up" (`dash-section-up`),
  "Move {title} down" (`dash-section-down`), `Button` ghost "Hide" (`dash-section-hide`), and, for Projects only, nothing else
  (pins are set on tiles, section 11.3).
- A section with nothing to show renders as a one-line muted row "{title}: nothing to show right now." so it can still be
  moved or hidden. A hidden section renders as a collapsed row "{title}, hidden" with `Button` "Show" (`dash-section-show`).
  Outside customise mode a hidden or empty section does not render at all.
- Waiting on you and To finish setting up stay where they are, without controls. The greeting is not arrangeable.
- Pins: each tile shows a `Switch`-like `IconButton` "Pin {name} to the top" / "Unpin {name}" with `aria-pressed`
  (`project-tile-pin`). The same action is always in the tile's More menu ("Pin to top" / "Unpin", `project-tile-pin-item`).

### 6.3 Keyboard and focus

- Tab reaches the Customise button, then the bar's Reset, then each section's control row in order (up, down, Hide), then the
  section's own content. All native buttons; no drag anywhere (decision: buttons only, no pointer drag, so there is one path
  and nothing to make accessible twice).
- Move up and down: the section moves, focus stays on the pressed button (re-found by testid after render). At the ends the
  button is `aria-disabled`, not `disabled`, so focus is never lost, and it announces "Today is already first." / "already last."
- Hide: the section becomes its collapsed row and focus moves to that row's Show button. Show: focus moves to the section's
  Hide button.
- Esc leaves customise mode when focus is inside the page and no popover or menu is open; focus returns to the Customise
  button. Done does the same.
- Reset layout: order and hidden return to default, pins stay, focus stays on Reset, the page announces it. No confirm (it is
  recoverable by one move or hide each).
- Announcements through `dashboard-live`: "Today moved up. Position 2 of 5." "Today hidden." "Today shown." "Layout reset to
  the default." "Pinned Mobile app. It is now first." "Unpinned Mobile app." "The pin limit is 24."

### 6.4 Persistence and reset

`orgai.dashboardLayout` (section 4.2), written on every change, read once on mount, followed across windows by the `storage`
event. Reset writes the default order and hidden list; pins are kept; "Unpin" per project removes a pin. Deleting a project
prunes its pin (`pruneLayoutPins`). Nothing about layout is sent to main.

## 7. Sections

Caps are `{narrow / wide}` from `dashCaps.ts` (`NARROW_CAPS` / `WIDE_CAPS`, edited as named in each section). Every capped list
ends with a ghost "Show {N} more" / "Show fewer" button and the heading count is the full number. "Show more" never moves
focus; "Show fewer" moves focus to the button that opened it.

### 7.1 Greeting: section 5.

### 7.2 Waiting on you (`dash-needs-you`) - fixed

Purpose: every pending decision, one answer away. Heading `h2` "Waiting on you" (was "Needs you"); the count equals the
sidebar bell (`useDecisionTotal`: runs' open decisions plus team-files items).

**Inline-answer security rule: carried over unchanged and not widened.** `NeedsRow`, `NeedsInline.tsx`, `lib/needsInline.ts`
(`inlineAllowable`, `inlineOptions`, `hideUserEnded`), the store's `decideIn` / `answerQuestionIn`, the per-row lock until the
`*.resolved` event and the failure line `dash-needs-error` are not edited by this build. Allow once sends only
`{ behavior: 'allow', scope: 'once' }`; Deny sends only the card's deny message; never a session or project scope, a rule, or the
settings link, whatever `suggestions`, `maxScope` or `referenceFolder` say. Allow is offered only when the whole command,
path or URL is shown on the row and in the buttons' names, with the limits in ARCHITECTURE.md "Inline-answer security
rule" and dashboard-2.md 5.2 (shell: no hidden characters, at most 2 lines and 200 chars, compound commands one step per
line, at most 4 steps; file tools only inside the project, a worktree or an allowed folder; WebFetch / WebSearch with the URL or
query; refused: reference folders, MCP, Agent and unknown tools). One-click question options only for a single choice of 2-4
options of at most 40 characters without descriptions. The Reviewer re-checks that the two files' diff is empty.

| Aspect | Spec |
| --- | --- |
| Data | `useWaitingRuns()` and `waitingItems(run, kind)` plus `useTeamAttentionItems()`, as built |
| Order (new) | By kind weight, then run start, then key: plan 0, question 1, permission 2, merge 3, proposal 4, install 5, rules 6, team 7. Why: a blocked plan or a question stops the whole run, a permission one agent. Pure `waitingOrder(items)` in a new file; recomputed only when the set of keys changes, so a row never moves under the pointer |
| Caps | needs 3 / 5, "Show N more" `dash-needs-more` |
| Empty | Section not rendered; the greeting carries "nothing is waiting on you" |
| One | A single row, same markup |
| Many | Cap, then Show more; the count is the full number |
| Error | `dash-needs-error` in the row, announced, as built |
| Loading | Rows render from live runs at once; the arrival baseline rule stays (rows present once history is loaded never animate; 1.5 s settle) |
| Copy | Row strings unchanged (dashboard-2.md section 13): "{agent} wants to run:", "wants to edit:", "Allow once", "Deny", "Long command: open it to review", "Answer in the run", "Touches a reference folder (read only)", "{project} · Team files". Walk 3 M2 is not taken up (decision 2026-11-19): a two-step command is allowed inline (at most 4 steps, ARCHITECTURE.md), so the refusal copy stays as built in `lib/needsInline.ts` ("{N} steps: open it to review" from 5 steps); changing it would mean editing that file, which this build must not do |
| Test ids | Kept: `dash-needs-you`, `dash-needs-row[data-kind][data-inline][data-run][data-key]`, `dash-needs-allow`, `dash-needs-deny`, `dash-needs-option`, `dash-needs-error`, `dash-needs-reference`, `dash-needs-more` |
| Keyboard | As built: per row the main button then its inline buttons; after an inline answer focus goes to the next row's main button, else the previous, else this section's h2 |

### 7.3 To finish setting up (`dash-setup`) - fixed

Purpose: blockers the person can fix (a project's connection, a service that needs sign-in, an unset secret). It is a fixed
section directly under Waiting on you because these stop runs; it is separate from Waiting on you because they are not
decisions and the bell never counts them. Heading "To finish setting up". Rows, actions, data and "names only, never a secret
value" are exactly dashboard-2.md section 8 (`SetupGaps.tsx`, `lib/setupGaps.ts`, unchanged). Cap setup 3 / 5. Empty or under
the mock adapter: not rendered. Test ids unchanged: `dash-setup`, `dash-setup-row[data-kind][data-id]`, `dash-setup-action`.

### 7.4 Pick up where you left off (`dash-resume`) - arrangeable, half width

Purpose: get back into the work in one action. It replaces Paused, Recently ended and the tiles' newest-run line.

Rows (a "thread" is a run chain from `chainGroups`; a row shows the newest member):

| Order | Row kind (`data-kind`) | Condition | One action (`data-action`) |
| --- | --- | --- | --- |
| 1 | `paused` | `pausedRuns(summaries)` | "Resume now" (`resumeNow(id)`) |
| 2 | `closed` | ended with the app while waiting on the person (`endedWithApp`, `endedWhile: 'waiting'`) and still the chain's newest | "Continue" |
| 3 | `failed` | failed since `lastSeen` | "Continue" if `canContinue`, else none |
| 4 | `finished` | finished since `lastSeen` | "Open output" when the chain has outputs, else "Continue", else none |
| 5 | `pinned` | the newest thread of each pinned project, in pin order; a pinned project with no thread gets "{name}, no runs yet" | as its status, or "New run" |
| 6 | `recent` | other threads, newest first | as its status |

Rules: work runs only (`kind === 'work'`), including Chat and the single-agent assistants' conversations of the Chat project;
setup, MCP-assistant and skill-assistant runs are left out. One row per chain. A live chain is left out while Working now is
visible (it is there); if Working now is hidden the live chain appears here as a `recent` row with its status word and the
action "Open". Dismissed or deleted-project runs follow the existing filters (`useAllSummaries`). The main button of a row
(`dash-resume-main`) opens the run (`focusRun`), always; the action button sits beside it.

| Figure | Source |
| --- | --- |
| Name, project, client | `displayRunName(summary)`, `locationLabel(projectId, projects)`, `clientOf` |
| Status word and tone | `statusOfRun` / `statusText` (`lib/runStatus.ts`) |
| Age | `relativeTime(endedAt ?? startedAt, now)`; paused rows `pausedCaption(s)` ("resumes at 14:05 if OrgAI stays open") |
| Cost (muted, only when known and above zero) | `Cost` with `runCostInput`, compact |
| Outputs for "Open output" | `outputs:list(projectId)` through the store's `loadOutputs` / `outputsByProject`, for the projects of the rows shown only (at most 6), queued after first paint with the project queue (3 in flight), kept fresh by the existing `onOutputsChanged`. An output counts when its `runId` is a member of the row's chain and `missing` is not set |
| "Open output" target | `focusRun`, then `openRunOutput(newestId, id)` with `revealOutputsTab()`, as History does; with several outputs the label is "Open outputs" and the list opens |

Caps: resume 4 / 6 (replace `paused` and `ended` caps). Empty: not rendered. One: one row. Many: cap and Show more
(`dash-resume-more`) up to 12, then nothing further (History is the archive). Loading: rows from live runs and loaded
history; "Open output" appears when its list arrives (the action slot reserves the button width, so no row shifts). Error: an
outputs call that fails leaves "Continue" or no action; no message.

Copy: h2 "Pick up where you left off". Row line 1: status word, then name. Line 2: "{project} · {age}" (with client: "{client}
· {project} · {age}"). Detail lines: "Was waiting on you when OrgAI closed." (kind `closed`), the error's first line (kind
`failed`, `errorFirstLine`), "No runs yet." (pinned, empty). Buttons: "Resume now", "Continue", "Open output", "Open outputs",
"New run" (`selectProject`, `openDraft`, `focusComposer`, as the tile does). Accessible names: "Continue {run name}",
"Open the output of {run name}", "Resume {run name} now".

Test ids: `dash-resume`, `dash-resume-row[data-kind][data-run][data-project]`, `dash-resume-main`,
`dash-resume-action[data-action=resume|continue|output|new-run]`, `dash-resume-more`. Keyboard: per row the main button, then
the action; Enter opens. After "Resume now" or "Continue" focus follows the destination (the run's composer); after "New run"
the draft composer. Leaving rows (a run resumes and becomes live) move focus to the next row's main button, else the h2.

### 7.5 Today (`dash-today`) - arrangeable, half width

Purpose: what the app really knows about today, drafted for the person, with a way to start. It is not a planner: nothing can
be dragged into it and no new data is stored.

Header: `h2` "Today" and the date in caption ("Thursday 19 November", `Intl.DateTimeFormat` weekday long, day numeric, month
long). Two optional groups, each an `h3`; a group with no rows is not rendered; with neither the section is not rendered.

**Scheduled** (`dash-today-schedules`). Source: `window.orgai.schedules.list()` with `onSchedulesChanged` (the `useSchedules`
pattern; `Schedule`: `enabled`, `state`, `nextRunAt`, `lastEntry`, `target`, `name`). A row appears for a schedule that is
`enabled` and `state === 'active'` with `nextRunAt` between now and the next local midnight, and for one whose `lastEntry.at`
is today and `lastEntry.result === 'started'`. Order: ran-today by time, then upcoming by time. Row: line 1 the clock time
("14:00", `clockLabel`) then the name; line 2 target ("{project name}" via `scheduleTargetLabel` or "Chat") and, for a run that
started, its outcome word from `lastEntry.outcome` ("Finished", "Stopped", "Needs you", "Failed" through the shared words).
The row's one button opens the Schedules page on that schedule (`openSchedules({ scheduleId })`) or, for a started run with a
`runId`, the run (`focusRun`). When `AppSettings.schedulesPaused` is true (`settings.get`, `onSettingsChanged`): one line
"Schedules are paused. Nothing will start today." with a ghost button "Open schedules" (`dash-today-paused`), no rows.
Cap 4 / 6. Copy for a row's second line when upcoming: "Starts at 14:00 · Billing API".

**To-dos** (`dash-today-todos`). Source: `useTodosStore` (`todos:list` per scope, `initTodos()` keeps it current on
`todos:changed`): the Chat list and each stored project's list, loaded after first paint three at a time (`projectQueue`).
Open items only (`status !== 'done'`), newest `updatedAt` first, across lists. Row: the title (one line, ellipsis, full text in
`title`), a caption with the list ("{project}" or "Chat") and an "agent added" word when `createdBy === 'agent'`
("Added by an assistant"), and `Button` secondary sm "Start session" (`dash-today-start`, accessible name "Start session for
{title}"): `startSessionFromTodo(item, confirm)`, which fills the start page's message box, never sends, never changes the item;
it asks the existing "Replace your unsent message?" confirm when needed. Cap 3 / 5 with "Show {N} more" (`dash-today-more`);
the group heading count is the full number of open items. A list that fails to load is skipped silently. Marking an item done
is not on this page (it needs the to-do page's concurrency handling; see section 14).

Test ids: `dash-today`, `dash-today-schedule[data-id][data-state=upcoming|ran]`, `dash-today-todo[data-id]`,
`dash-today-start`, `dash-today-paused`, `dash-today-more`. Keyboard: rows' buttons in order; "Start session" moves focus to
the composer on success; on a declined confirm focus stays on the button.
Pure model `lib/todayModel.ts` (`scheduledToday(schedules, now)`, `openTodoRows(listsByScope, projects)`), unit-tested around
local midnight and DST.

### 7.6 Working now (`dash-now`) - arrangeable, half width, demoted

Purpose: the live agents, kept as built but quieter. `RightNowBand`, `BandRun`, `lib/dashboardBand.ts`, `useBandSnapshot`,
the working marks and Enter-opens-the-agent behaviour are kept (dashboard-2.md 6). Changes: heading "Working now"; no longer
spans a column or fits a height budget (`useBandBudget`, `fitBandModel` budget argument removed); caps `bandRuns` 3 / 5, agents
per run 4 / 6; a run with open decisions says "Waiting on you" in plain text instead of the tinted line and a decision count
suffix (`decisionsSuffix` becomes " · Waiting on you"), and its root's activity uses `decisionLine`, which prints the decision
label ("Allow: Run npm test"), never the raw command (walk 3 M5). Empty: not rendered (the greeting says nothing is running;
`dash-now-empty` is removed). The counts line `dash-now-counts` stays. Up to 12 marks breathe, as built.

### 7.7 Your week (`dash-week`) - arrangeable, half width

Purpose: the shutdown recap. Honest numbers about the last 7 local days including today (rolling, so it is never empty on a
Monday). No comparison, no target, no streak, no "best day".

Pure model `lib/weekRecap.ts` (`weekRecap(summaries, projects, now)`), built on `dayLedger(summaries, now, 7)`:

| Figure | Test id | Source and rule |
| --- | --- | --- |
| Runs | `dash-week-runs` | `ledgerTotals(days).runs`; work runs of every project, assistants and Chat included; each run id once (as `dayLedger`) |
| Time working | `dash-week-time` | Per run `usage.wallMs - usage.waitingMs - usage.idleMs - usage.limitHoldMs`, floored at 0, summed over the 7 days, `formatDuration`. It is the time runs were busy, not summed across parallel agents (the label's tooltip says so). A run without `usage` (older records) is left out and the figure then reads "6h 40m+" with the accessible text "at least 6h 40m" (the lower-bound rule of costs) |
| Spend | `dash-week-cost` | `ledgerTotals(days).cost` through `Cost` compact: "$4.20", "$4.20+" partial, "unknown" unknown; omitted when the cost is a reported zero or `empty` (flat-rate plans) |
| Most active project | `dash-week-top-project` | The project with the most runs in the window (ties: the newest run); shown only when two or more projects had runs; a button that opens it (`openProject`) |
| Ledger | `dash-strip`, `dash-strip-day`, `dash-strip-readout` | 7 day columns, section 7.7.1 |
| Plan limits | `dash-limits`, `dash-limit` | The existing limit entries of `HeroBand` (`windowEntry`, `SpendBar`, `connectionsInUse`, `usageIsStale` refresh on mount) moved here, hidden under the mock adapter and for API keys, at most 2 and "+N more". A limit line at or past its warning level keeps its tone class |
| Usage link | `dash-week-usage` | Ghost "See usage" calls `openUsage()` |

The "Waited on you" figure of the old strip is not carried over: counting how long the person made agents wait reads as blame.

#### 7.7.1 Ledger (micro-visualisation)

- One instrument, one fact: runs per day. Seven fixed-width columns, oldest left, today right with `--dash-strip-today`
  marking its label; bars in `--dash-strip-bar`. Linear scale from zero, so no scale note; a bar is at least 2 px when the day
  has runs, a day with none is a hairline on the baseline. Track height 40 px narrow, 56 px wide (declared, e2e measures).
  A day with a failed run carries a small hollow ring above its bar (`data-failed`), so failure is a shape as well as a count.
- Labels: the first column's short date and "Today" under the last, weekday initials under every column only when a column is
  24 px or wider; nothing rotated. Drops first below 560 px of section width: initials, then end dates.
- Text alternative: the group is `role="group"` named "Runs per day, last 7 days"; each day is a native button (one Tab stop,
  roving, `useRovingFocus`) whose name is `dayAriaLabel` ("Thu 19 Nov: 3 runs (1 failed), cost $1.42, 2h 10m working"; unknown
  cost reads "cost unknown", the lead word never doubles, walk 3 L1). The readout `dash-strip-readout` is a plain `p` (not live)
  under the ledger: today or the hovered, focused or pinned day in the old words ("Today: 3 runs · $1.42 · 2h 10m working").
  Arrow keys, Home and End move the day, Enter or Space pins (`aria-pressed`), Esc unpins; as built.
- Unit tests: bar heights at the 2 px minimum, empty versus failed days, unknown and partial cost in the readout, the label
  positions, the alternative text.

States: Empty (no runs in 7 days and no limit entries): not rendered. Runs but no limits: figures and ledger only. Loading:
figures show "-" until history is in; no spinner. Error: none possible (derived). One day only: the same columns.

### 7.8 Projects (`dash-projects`) - arrangeable, full width

Purpose: every project, pinned ones first. Unchanged: the search field above 6 projects (`dash-project-search`), the "N of M"
count, no cap, new-project dialog, delete and forget flows, `useProjectSignals` chips and the project queue, tile open and
menu behaviour (dashboard-2.md 10). Changes:

- Order: pinned projects first in pin order (the person's pins), then `projectAttentionOrder` for the rest. A pinned tile shows
  a small Pin glyph (aria-hidden) before its name and "pinned" in the Open button's accessible name.
- A tile loses the newest-run block (`tile-run`, now Pick up's job) and keeps: client caption (`tile-client`), name, team marks
  (`tile-team`), one status line, signal chips (`tile-chips`), and the foot (`tile-folder`, and `tile-cost` "last 7 days" only
  when above zero). The status line is one fact: "2 decisions waiting" (plain text, no tint), "Working", "{N} runs open", "Last
  run 9 days ago", or "No runs yet" (`tileStatusLine`, trimmed; the walk-3 L3 repeat is gone because the newest-run line is gone).
- New: `project-tile-pin` (customise mode) and the More menu item `project-tile-pin-item` "Pin to top" / "Unpin".
- Columns: 3 / 2 / 1 by container width (section 2.3). Empty: not possible (a project exists); search with no match keeps
  "No project matches ..." as built.

### 7.9 Footer (`dashboard-app-facts`)

One quiet line at the bottom of the page: "OrgAI {version}" plus the Dev and Mock adapter `Badge`s (was in the status bar).

## 8. Where the old regions went (removed and kept)

| Region today | Fate |
| --- | --- |
| Status sentence `dash-status-line` | Replaced by the greeting brief. `statusSentence` stays only as long as another caller needs it; the Dashboard stops using it |
| Plan limits `dash-limits` | Kept, moved into Your week (7.7). The sidebar account row still carries the tightest window |
| App facts `dashboard-app-facts` | Kept, footer |
| `dashboard-live` | Kept, in the greeting |
| Needs you | Kept as Waiting on you; inline rule unchanged; new order |
| Right now band | Kept as Working now, demoted, no height budget |
| 14-day strip | Becomes the 7-day ledger inside Your week; the longer view is Usage > Trends via "See usage"; "Waited on you" dropped |
| To set up | Kept, renamed "To finish setting up", fixed below Waiting on you |
| Paused | Pick up rows (kind `paused`) |
| Recently ended and Clear | Pick up rows (kinds `closed`, `failed`, `finished`). Clear, `clearedAt`, `orgai.dashboardClearedAt` and `markAllSeen` are removed (nothing is left to clear: rows are threads, not a to-clear list). Old localStorage value is ignored, not deleted. This also removes walk-3 M3 |
| Project tiles | Kept, slimmed, pinnable |
| Secret notices, forget notice, `AppNavigateBanner` | Kept above the greeting |
| First launch | Kept under the new greeting |
| New project form and dialog, `openNewProject()` | Unchanged |
| `HeroBand.tsx` | Split: greeting (new `Greeting.tsx`), limits (`WeekLimits.tsx`), live region and `useDecisionTotal` move out |
| `useLastSeen` | Kept (`lastSeen`, plus `firstVisit`); `clearedAt` and `markAllSeen` removed |

Walk-3 findings closed: M3, M4 (no two-column height dependence), M5 (one home per fact), M6 (decisions first), L3 (tile repeat),
L7 (no zero-padded 12-hour clock; the pause reason clamps at a clause over two lines).

## 9. Motion

Loops on the page: one, the working marks (`dash-breathe`, `--dur-pulse` 1800 ms, at most 12, staggered), unchanged. Nothing new
loops. Everything else is a one-shot on transform and opacity from the existing recipes in `styles/motion.css`.

| What | Why | Recipe and tokens | Interruption |
| --- | --- | --- | --- |
| A section or row that arrives after the page settled (a new decision, a thread, Today after its data) | Tell the person something is new | `.motion-enter` (160 ms `--dur-base`, 4 px rise, stagger 30 ms capped at 5) through `useArrival`; the first paint and the first 1.5 s never animate | None needed, it is short |
| A row the person removed (Allow, Deny, Resume) | Confirm the act | `useRowExits` fade and fold, 100 ms `--dur-fast`, as built | Row is `inert` and `aria-hidden` while leaving |
| A moved section or a pinned tile in its new place | Let the eye find it after an instant jump | One `.motion-ring` (existing one-shot ring on a pseudo-element, `--dur-slow` x 2.3) | A second move restarts it |
| The Customise bar and the control rows appearing | Mode change | `.motion-fade` (80 ms `--dur-fade`) | None |
| Name popover | Existing `Popover` motion | existing | existing |
| Everything else: the greeting (never typed or faded), hide and show, order changes, ledger bars, readouts, hover, focus, pressed | Not state worth animating, or must be instant | none; focus rings and pressed states are instant | n/a |

Frequent keyboard actions (Tab, arrows in the ledger, Enter on a row, Move up and down, Allow once) are instant: no row
animates in response to a key except the 100 ms exit of a row the key removed. Layout (height, width, grid tracks) never
animates, so hiding a section cuts. Nothing speaks because of motion; announcements are text (section 10).

Reduced motion (`prefers-reduced-motion` and `data-reduce-motion="on"`, the Pause motion switch is the same attribute): the
duration tokens collapse to 0.01 ms, so entries, exits, the ring and the fade become instant; the working marks'
`::after` animation is `none` and the pseudo-element is not drawn, as built; no new `animation` or `transition` is written
without both selectors. State stays visible without motion: status word, colour dot, the "Waiting on you" text, a pinned glyph.
Verification (e2e): with `data-reduce-motion=on`, `getComputedStyle(mark, '::after').animationName === 'none'`, no `.motion-enter`
element has a computed animation duration above 0.01 ms, the ring is absent after a move.

## 10. Accessibility

- One h1 (topbar). A `section aria-labelledby` and an `h2` per section; `h3` for Today's two groups and for each tile name
  (as built). Landmarks: the page is inside the app's `main`; `section`s with names are regions. The customise control rows are
  `role=group` with names.
- One polite live region, `dashboard-live`, nothing else on the page with `aria-live` or `role=status` (the Popover error
  `role=alert` is the one exception, only while it shows). It speaks: new decisions ("New decision in {project}: {ask}"; "{N} new
  decisions" within 1.5 s), inline answers ("Allowed once: {ask}.", "Denied: {ask}.", "Answered {option}."), failures, delete and
  open-folder results, name saved or removed, customise results (6.3), pin results. It never speaks the brief, counts, costs, elapsed
  times, rows appearing, strip readouts or limits. The first data load never speaks.
- Keyboard: everything is a native button, link or input. Order is DOM order. Reorder, hide, show, pin and name edit have
  keyboard paths (6.3, 5.3, 11.3); there is no drag. Focus rings are the shared `--focus-ring` 2 px, never removed. A control
  that disappears hands focus to the next sensible element (rules in each section; Show more never moves it).
- Names: every action names its object ("Continue Fix rounding", "Start session for Follow up with Acme", "Move Today up").
  Visible text appears in the name. The Customise icon-only form keeps "Customise".
- Instruments: the ledger has a text name, per-day names and a readout; the three figures are text; limits keep their `title`
  and a text line. No information is colour only: tone always sits beside a status word, failed days carry a ring.
- Contrast: tokens only; muted text is `--text-secondary` or `--text-tertiary` (5.0:1 or better, from dashboard-2.md 15, computed by
  hand, not measured). The light warning ring (2.6:1) is as on the canvas: reported, not changed; the state is also in words.
- Targets: rows 44 px, `size="sm"` buttons at least 28 px high, tile cover as built.

## 11. States, copy and sizes in one place

### 11.1 Page states

| State | What shows |
| --- | --- |
| First launch | Greeting "Welcome to OrgAI." and its line, `FirstLaunch`, footer. Nothing else |
| Projects, no runs | Greeting "No runs yet. Open a project to start one."; Waiting, Pick up (pinned only), Today if any, Projects |
| Quiet day | Greeting quiet sentence; sections with content only (typically Pick up, Your week, Projects) |
| Busy day | Greeting leads with the waiting sentence; Waiting on you at the top; caps and Show more everywhere |
| Loading | Greeting present-state sentences only; rows from live runs; Pick up and Today fill in when their data returns; nothing shows a spinner |
| Error | Per-call failures are silent (no row, no chip). Inline answer, name save and delete errors show in place and are announced |
| Many projects (over 6) | Search field; all tiles render |
| Long text | Names, runs, projects, to-do titles: one line with ellipsis and `title`; commands two lines; brief wraps |
| Mock adapter | No limits, no setup rows (as built); the Mock badge in the footer |

### 11.2 Strings not given above

Section headings: "Waiting on you", "To finish setting up", "Pick up where you left off", "Today", "Working now", "Your week", "Projects".
Customise: "Customise", "Done", "Reset layout", "Move, hide or show sections. Changes save as you go.", "Hide", "Show",
"{title}: nothing to show right now.", "{title}, hidden". Week: "Runs", "Time working", "Spend", "Most active: {project}, {N} runs",
"See usage". Today: "Scheduled", "To-dos", "Starts at {time} · {target}", "Start session". Footer: "OrgAI {version}".
Tooltip on Time working: "Time runs were busy this week. Time spent waiting for you or idle is left out. Parallel agents are not added together."

### 11.3 Sizes and pin

Check 1024x640 (rail, one track) and 1600x1000 (two tracks), dark and light, plus a 1280x800 spot check of the breakpoint.
Heights above are estimates; the build records measured values. Pinning moves the tile first, announces "Pinned {name}. It is now
first.", refocuses the same control and also leads Pick up. At the limit of 24 the menu item is disabled: "You can pin up to 24
projects."

## 12. Test ids

Kept (same element and meaning): `dashboard`, `dashboard-hero`, `dashboard-live`, `dashboard-app-facts`, `new-project`,
`new-project-dialog`, `projects-new-chat`, `empty-chat-now`, `dash-start-choice`, `forget-notice`, `secret-notices` and its
children, `dash-needs-you`, `dash-needs-row`, `dash-needs-allow`, `dash-needs-deny`, `dash-needs-option`, `dash-needs-error`,
`dash-needs-reference`, `dash-needs-more`, `dash-setup`, `dash-setup-row`, `dash-setup-action`, `dash-now`, `dash-now-counts`,
`dash-now-project`, `dash-now-more`, `dash-running-row`, `dash-agent-row`, `dash-agent-more`, `dash-agent-done`, `dash-strip`,
`dash-strip-day`, `dash-strip-readout`, `dash-limits`, `dash-limit`, `dash-projects`, `dash-project-search`, `project-tile`,
`project-tile-main`, `project-tile-more`, `project-tile-open-folder`, `project-tile-delete`, `project-tile-error`,
`project-tile-new-run`, `project-tile-continue`, `tile-client`, `tile-team`, `tile-chips`, `tile-chip`, `tile-folder`, `tile-cost`.

Renamed: `dash-strip-runs` to `dash-week-runs`; `dash-cost` to `dash-week-cost`; `dash-paused-resume` to
`dash-resume-action[data-action=resume]`; `dash-since-continue` to `dash-resume-action[data-action=continue]`;
`dash-paused-row` and `dash-since-row` to `dash-resume-row[data-kind]`.

Removed: `dash-status-line`, `dash-paused`, `dash-since`, `dash-since-clear`, `dash-now-empty`, `dash-strip-waiting`, `tile-run`.

New: `dash-greeting-salutation`, `dash-greeting-brief`, `dash-name-add`, `dash-name-edit`, `dash-name-input`, `dash-name-save`,
`dash-name-cancel`, `dash-name-error`, `display-name-input`, `appsettings-section-about-you`, `dash-customise` (also the Done
state), `dash-customise-bar`, `dash-customise-reset`, `dash-section[data-section][data-state=shown|hidden|empty]`,
`dash-section-controls[data-section]`, `dash-section-up`, `dash-section-down`, `dash-section-hide`, `dash-section-show`,
`dash-resume`, `dash-resume-row`, `dash-resume-main`, `dash-resume-action`, `dash-resume-more`, `dash-today`,
`dash-today-schedules`, `dash-today-schedule`, `dash-today-todos`, `dash-today-todo`, `dash-today-start`, `dash-today-paused`,
`dash-today-more`, `dash-week`, `dash-week-time`, `dash-week-top-project`, `dash-week-usage`, `project-tile-pin`,
`project-tile-pin-item`.

`data-testid` goes on elements, `data-section`, `data-kind`, `data-action` as listed. e2e selectors in `e2e/dashboard.mjs` and any
script that reads a removed id (`grep dash-since\|dash-paused\|dash-status-line\|tile-run e2e`) change in the same slice that
removes the id.

## 13. Acceptance criteria

Numbered for the UI Lead and QA (mock adapter, throwaway data dir, both sizes, both themes unless said).

1. The page has exactly one h1 ("Dashboard"); each rendered section has an h2 named as in 11.2; DOM order equals visual order
   at both sizes (compare element order with y/x position).
2. First launch shows "Welcome to OrgAI." and the line, `dash-start-choice`, no Customise button and no sections.
3. With a name unset the salutation has no name; with "Sam" it reads "Good morning, Sam." (clock faked for each of the four bands
   at 04:59, 05:00, 11:59, 12:00, 16:59, 17:00, 21:59, 22:00). The OS account name never appears.
4. The brief matches the table in 5.4 for: quiet, waiting, finished with cost, finished and failed, failed only, closed while
   waiting, working, paused, older than 7 days, first visit, no runs ever; never more than two sentences; never "$0.00"; before
   history loads it never says "Nothing has changed".
5. The greeting text is not inside a live region; `dashboard-live` is the only element on the page with `aria-live` or
   `role=status`, except the first-launch New project form's own progress status `new-project-status` (FirstLaunch is
   unchanged, section 2.6; clone and setup steps speak through it).
6. Long text: a 40-character name, a 120-character run name and a 200-character to-do title clip with an ellipsis and a `title`,
   never widen the page or push a button out of its row, at 1024x640 and 1600x1000.
7. Name: Add your name opens the popover with focus in the input; Enter saves; Esc cancels and focus returns; saved name shows
   at once and in Settings > General > About you; clearing removes it; 41 characters and hidden characters are refused with
   the stated sentence; a failed save shows `dash-name-error` and keeps the text; the name survives a relaunch.
8. Waiting on you: rows equal the sidebar bell count; a row with `data-inline=allow` and Allow once removes the row, drops the
   bell by one, announces "Allowed once: ...", moves focus to the next row's main button, and sends no scope other than once
   (assert the IPC argument); no "Allow for session" or "Always allow" text anywhere on the page; Deny sends only the deny message.
9. `git diff` of `components/dashboard/NeedsInline.tsx` and `lib/needsInline.ts` is empty (Reviewer confirms).
10. Waiting order follows 7.2 (plan, question, permission, merge, proposal, install, rules, team; oldest run first) and a row
    does not move when an unrelated event arrives (unit test on `waitingOrder`; e2e with two kinds).
11. A decision appears as a row once: the band run says "Waiting on you" in plain text, the tile says only its count word, and
    no band or tile text contains the raw command (search the page text for the mock's `cd ` command).
12. To finish setting up renders only with rows, directly under Waiting on you, cannot be hidden or moved, and shows no secret value.
13. Pick up: a paused run shows "Resume now" and it resumes; a run ended with the app while waiting shows the detail line and
    Continue; a finished run with an output shows "Open output" and it opens that run's Outputs tab; a pinned project with no runs
    shows "New run"; each chain appears once; setup and assistant runs never appear; at most the cap shows with "Show N more".
14. Today: a schedule due later today shows its time and target; one that ran today shows its outcome; paused schedules show the
    pause line and no rows; open to-dos from at least two lists show with "Start session", which fills the message box and does
    not send (assert no run started); done to-dos never show; a failing list call leaves the rest.
15. Today, Pick up, Your week, Working now and Projects do not render when they have nothing to show (outside customise mode).
16. Working now keeps its rows, folding and Enter-opens-agent behaviour; a waiting run sorts first; no `dash-now-empty`.
17. Your week: runs, time working, spend and most active project match a fixture computed by hand; an unpriced run makes spend
    "unknown" or "+" and never "$0.00"; a run without `usage` makes time end in "+"; most active appears only with two or more
    active projects; the ledger has 7 `dash-strip-day` buttons, today `data-today`, one Tab stop, ArrowLeft changes the
    readout, Enter pins, Esc unpins, counts sum to `dash-week-runs`.
18. The ledger's bar is at least 2 px for a day with runs, a hairline for none, with measured track heights 40 and 56 px.
19. Plan limits appear in Your week only off the mock adapter and not for API keys (unit test the entry builder; e2e checks absence
    on the mock).
20. Projects: pinned first in pin order, then attention order; a tile has no `tile-run`; pinning from More and from the customise
    toggle both work and announce; the 25th pin is refused with the stated sentence; deleting a pinned project prunes the pin.
21. Customise: Done and the entry are one button; every section can move up and down and hide and show by keyboard only; focus
    rules of 6.3 hold (after Move, after Hide, after Show); Esc leaves; Reset restores order and hidden, keeps pins; reload keeps
    the layout; corrupt storage (`"x"`, wrong version, unknown ids, duplicates) loads the default without an error; a second
    window follows a change.
22. The layout in customise mode is one track at 1600x1000; outside it, two tracks pair as `placeSections` says (unit-tested on
    hidden middle sections, one half section, Projects first).
23. At 1024x640: no horizontal overflow; the greeting and Waiting on you (with up to 2 decisions) are inside the viewport; the
    page scrolls inside `.dashboard`, the window does not move.
24. At 1600x1000 with a quiet day and 6 projects there is no page scroll and no column ends more than one row above the other.
25. Motion: only the marks loop; with `data-reduce-motion=on` no mark animates and no `.motion-enter` has a duration above
    0.01 ms; the first paint animates nothing; a decision arriving 2 s after load enters with `.motion-enter`.
26. Both themes: every colour comes from a token (no hex or `rgb(` in the new CSS: grep); screenshots of both sizes and themes
    are attached to the walk.
27. Status words on every row come from `lib/runStatus.ts`; no emoji, exclamation mark or em dash in any new string (grep).
28. The two contracts: `cleanDisplayName` and `normalizeLayout` tests cover every case named in section 4 (40 and 41 characters,
    hidden characters, non-string, unknown and duplicate ids, wrong version, pin cap).
29. Typecheck, the whole unit suite and build are clean; new pure modules have unit tests with exact strings: `dashboardBrief`
    (every row of 5.4, plurals, cost clauses, priority), `dashboardLayout`, `weekRecap`, `todayModel`, `resumeRows`,
    `waitingOrder`, `cleanDisplayName`, the settings normaliser.
30. `e2e/dashboard.mjs` is rewritten against section 12 and passes on the mock at both sizes and themes; `scripts/e2e-select.mjs`
    still maps the dashboard paths to it; `e2e/settings` or `e2e/layout.mjs` gains a check of `display-name-input`.
31. Search of `src/main` and `src/shared` finds `displayName` only in the settings contract, its normaliser and tests: not in
    prompts, run events, logs, notifications or window titles.
32. A UX walkthrough (both sizes, both themes, keyboard pass, reduced motion) is written to `docs/design/ux-review-dashboard-4.md`
    with the states it could not make listed as Not verified.

## 14. Build order (vertical slices, each leaves the page working and e2e green for its area)

Owners: UI Lead assigns; slices 1 and 8 touch hot shared files (`types.ts`, settings) so they take a claim each.

1. **Contracts.** `displayName` in types, `cleanDisplayName`, normaliser and tests, `saveDisplayName`, Settings "About you" row,
   `dashboardLayout.ts` with tests and `useDashboardLayout`. No Dashboard change yet. Gate: unit tests, typecheck, `connections`
   or `layout` e2e for the settings row.
2. **Greeting and shell.** `Greeting.tsx`, `dashboardBrief.ts`, `useLastSeen` (`firstVisit`, drop `clearedAt`), the name control, the
   `.dash-page` container and single-column flow, footer facts, first launch under the greeting. `HeroBand` retired (limits parked
   in `WeekLimits.tsx` unused until slice 5). Old sections still render below in their current order. e2e: greeting, name, first launch.
3. **Waiting on you and setup.** Rename, `waitingOrder`, "2 steps" copy, band suffix change, setup placement. Reviewer: inline rule
   unchanged. e2e: the existing inline-answer checks, now against the new heading.
4. **Pick up.** `resumeRows.ts`, `ResumeSection.tsx`, outputs loading through the queue; remove Paused, Recently ended, Clear and
   `dash-since*`. e2e: pause, closed, continue, open output, no duplicates.
5. **Working now and the two-track layout.** Demote the band (no budget code), `placeSections`, caps at 1000 px, remove
   `useShortRegion` and `useBandBudget`. e2e: sizes, no overflow, order.
6. **Your week.** `weekRecap.ts`, figures, 7-day ledger, limits, "See usage"; remove the 14-day strip component and its `tall` and
   `dense` sizes. e2e: ledger keys, never "$0.00".
7. **Today.** `todayModel.ts`, schedules and to-dos groups, Start session. e2e with `[mock:schedule]` and `[mock:todo]`.
8. **Projects and pins.** Tile slimming, pin in More, pin order, `project-tile-pin`. Needs the layout hook from slice 1.
9. **Customise.** Bar, control rows, hidden and empty rows, announcements, Esc, Reset, storage event. e2e keyboard-only path.
10. **Motion, docs, walk.** Arrival and ring recipes applied, reduced-motion checks, update `.orgai/ARCHITECTURE.md` (Renderer UI
    Dashboard bullet), `CLAUDE.md` (Dashboard notes only if still listed), `docs/agent-notes/renderer.md`, the e2e list; write
    `ux-review-dashboard-4.md`; Reviewer pass on slices 1, 3 and 9.

## 15. Assumptions (decided here; none is left for the owner)

1. Rolling 7 local days, not a calendar week.
2. "Time working" is `wallMs - waitingMs - idleMs - limitHoldMs` per run. Unverified: whether those three can overlap in
   `computeRunUsage`; the result is floored at 0, and the label says what it counts. The build reads `computeRunUsage` and fixes
   the formula if they overlap.
3. `Schedule.nextRunAt` is absent unless enabled and active (types comment); a `once` schedule due while globally paused is marked
   done by main, so it does not show (known gap in `schedules.md`).
4. `Schedule.lastEntry.at` is when the slot was handled and `result: 'started'` means a run exists; `outcome` fills later.
5. `chainGroups` and `canContinue` operate on one project's summaries; Pick up groups per project, then merges by newest member.
6. To open the Chat to-do list or a project's, the build uses `selectProject` and `setView('todos')` (the To-dos tab), reaching Chat the
   way its sidebar row does; this page only uses "Start session", not a list link.
7. Hours: morning 05-11, afternoon 12-16, evening 17-21, "Hello" 22-04 (no "Good night": it reads as a goodbye).
8. A name is up to 40 characters; a refused character invalidates the whole input. Pin cap 24, in pin order; Reset keeps pins.
9. Fixed sections are Waiting on you and To finish setting up. `localStorage` is available (as for sidebar and last-seen keys).
10. Heights, widths and "fits above the fold" statements are estimates from the walk-3 measurements, not measured on a build.
11. Not verified at all: the visuals (no mock-up was rendered), the greeting copy with a screen reader, a 1280-wide window, macOS and
    Linux, light and dark rendering of the new rows, the real plan windows, outputs with many versions, Today with 20 lists loading.

## 16. Later, needs contracts (not part of this build)

- Recent decisions the person made, and "decisions you answered this week" in Your week (needs a recent-decisions channel; `RunUsage` has no
  decision count).
- Marking a to-do done from Today (needs the optimistic-concurrency handling of `todos:save` in a shared hook), and to-do due dates or a
  "plan for today" flag so Today can hold to-dos the person chose rather than all open ones.
- Running a schedule now from Today (`schedules:runNow` spends money; needs the confirm pattern the Schedules page uses).
- A recent-outputs channel across projects (`outputs:listRecent`) so Pick up does not call `outputs:list` per project.
- Per-project "last opened" and a persisted recents order (main-side), so "recent" is about attention and not only runs.
- Layout preferences synced across machines or visible to the CLI (a settings field), and per-section options (rows shown, Notion's
  "show count").
- Agent-time totals summed over parallel agents (a new `RunUsage` field), and a daily wrap-up notification at a time the person picks.
- Reading the OS account name for the greeting (a main call; rejected for now, see 4.1).
- Knowledge counts per engagement, skill-evaluation suggestions and uncommitted team files outside `listAttention`
  (dashboard-2.md section 18 stands).

## 17. Implementation notes (built 2026-11-19, UI Lead)

Built as specified in slices 1 (renderer half) to 10, renderer only; the display-name contract had landed before.
Where the build differs from the text above, and why:

- Assumption 2 resolved: `waitingMs`, `idleMs` and `limitHoldMs` are three independent timers in `runManager.ts` and
  overlap (a usage-limited run's turn ends, so its hold sits inside idle time). Time working is per run
  `max(0, wallMs - idleMs - waitingMs)`; `limitHoldMs` is not subtracted (`lib/weekRecap.ts`, `lib/activityStrip.ts`
  `runWorkMs`). A card left open after a turn ended can still overlap idle; the floor hides that.
- 7.2 walk-3 M2 ("2 steps") dropped, see 7.2; `needsInline.ts` and `NeedsInline.tsx` are byte-for-byte unchanged.
- Section 10 / acceptance 5: on first launch the inline New project form keeps its own `new-project-status`.
- Pin announcement: "Pinned {name}. It is now first." only when it is the only pin; otherwise "Pinned {name}. It is pin
  {n} of {m}." (pins keep pin order, so a later pin is not first; Reviewer L1).
- `saveDisplayName` lives in `lib/dashboardName.ts` (not beside `saveSchedulesPaused` in the schedules hook).
- The section Move up / Move down controls and the tile pin toggle are native buttons with the `icon-btn` classes:
  `IconButton` has no `aria-pressed` and its `inert` blocks the click that must announce "already first".
- Pick up: the action buttons are native `btn sm` buttons (the shared `Button` takes no `data-*`); closed rows show for
  7 days regardless of last seen; a pinned project whose newest thread is live (and Working now visible) gets no row;
  outputs load through `projectQueue` kind 'outputs' (5 min max age).
- Today: a schedule that ran today and is due again shows two rows; to-dos load three at a time with a local pool after
  first paint (projectQueue has no to-do kind); no arrival animation on Today rows.
- Your week counts only `kind === 'work'` runs (Chat included); Most active counts stored projects only.
- Working now sorts waiting runs first (was working first). The worktree label `.dash-wt` keeps `--warning-text`.
- Empty Waiting on you stays mounted with `hidden` (the shared section's focus hand-off needs it); it is not displayed.

Verification (token-free, mock adapter): typecheck clean; whole unit suite with only failures in untouched `src/cli`
and `src/main` symlink / ink-pin tests of this Windows worktree; build; `e2e/dashboard.mjs` rewritten (277 checks
pass at both sizes and themes, keyboard customise path, reduced motion, relaunch), `proposals.mjs`, `usage-app.mjs`
(selector updates) and `layout.mjs` pass. Reviewer: no Critical or High; M1 (Esc in native dialogs), L1, L2, L3, L4
fixed. Screenshots of both sizes and themes in `e2e/shots/dashboard-*.png`, looked at by the UI Lead.

UX walk: `ux-review-dashboard-4.md` (acceptance 32; both sizes and themes, keyboard, reduced motion): no High, five
Medium left open for a follow-up: M1 pause times without a day ("until 10:40 PM" for tomorrow; the Pick up caption
comes from `needsInline.ts` `pausedCaption`, which this build may not edit), M2 saving a name on first launch shows no
change and "Add your name" reads as a caption, M3 the quiet brief beside idle runs that wait for a reply, M4 three
phrases for one state ("Needs you", "Waiting on you", "waiting for you"), M5 the pause reason clipped mid-word.
Open; not verified: the Allow once
IPC argument by spy, a failed name save on screen, the 25th pin, a real second window, a decision entering 2 s after
load, brief variants other than no-runs / waiting / closed on screen (unit tests only), real plan limits, a screen
reader, macOS. Reviewer M3 (main `settings.ts` logs the JSON parse error, which may quote settings text) and L5 (a
name save racing the Settings page's debounced save) are outside this renderer build. The proposal row label repeats
"Schedules: Schedules:" (pre-existing NeedsRow copy, not changed here).

Walk 4 follow-ups, fixed: M3 the brief gains "1 run is idle and waiting on your reply." (plural "2 runs are idle and waiting on your reply."), second after decisions and counted by `bandWorkFacts.awaitingReply`, so it never says nothing is waiting beside an idle run that waits for the reply; M4 the band count, the band agent state word and the brief all say "Waiting on you" or "waiting on you" (no "Needs you" or "waiting for you" left in Dashboard strings; the bell, sidebar and run status badge are unchanged); M2 on first launch a saved name reads "Welcome to OrgAI, Sam." (section 5.2's "no name on first launch" is dropped) and "Add your name" is a bordered secondary button with a plus icon; M5 the paused reason is clamped to two lines with a clean ellipsis and carries the full text as its `title`; M1 the paused row caption comes from `pausedResumeCaption` in `lib/resumeRows.ts` ("resumes tomorrow at 10:40 PM if OrgAI stays open", a weekday within a week, else the date; `needsInline.ts` untouched), while the greeting brief still prints only the clock time of the earliest resume; L6 the schedules "Show more" button has `aria-expanded` (the page's other "Show more" controls carry no `aria-controls`). Checked by unit tests with a fixed clock and the new first-launch checks in `e2e/dashboard.mjs`; the light-theme look of the new button and the real-resize clamp were not looked at.
