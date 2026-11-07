# UX review: Dashboard, pre-feature walk (walk 3, before the redesign)

- Reviewer: UX Researcher. Build: `cf3b1a41` (`npm run build`, version shown 0.1.7-dev1).
- How it ran: `ORGAI_MOCK=1`, fresh temp data dir, no tokens. Windows, Electron driven through `e2e/lib.mjs`
  (scripts kept in the gitignored `e2e/shots/ux/dash3/`). Sizes 1600x1000 and 1024x640 (`setContentSize`), dark and
  light, mouse pass and a keyboard-only pass at 1024x640.
- Seeded state: 3 code projects (Billing API, Mobile app, Docs site), 1 engagement (Q4 audit, client Acme Corp);
  a run waiting on a permission card in Billing API and another in Q4 audit; a live `[mock:deep-tree]` run in Mobile
  app (it settles to "Waiting for your reply" after 2 s); an ended run in Docs site (End session); a Chat run (idle).
- Compared with: `docs/design/dashboard.md` sections 2-5, `ux-review-dashboard.md`, `ux-review-dashboard-2.md`.
- Shots: `docs/design/ux-review-dashboard-3-pre-shots/` (11 files).

## Verdict: WORKS, BUT NOT A CONTROL ROOM

Nothing is broken that a user would trip on: the page fits at both sizes (no horizontal overflow, every stop has a
ring, Enter on rows lands on a real element). The problem is what it says. It repeats the same one fact (how many
decisions are open) five times (hero, bell, Needs you, Running now, tile), and says nothing about the thing only this
product has: an organisation of agents, doing named work, right now, across projects. A first-time user who runs
several teams a day sees counts and cards, not their teams. The owner's "looks AI generated" is accurate and has
concrete causes (section A). The data for a much better page mostly already sits in the renderer store (section B).

Numbers measured (1600x1000 dark, same in light): the content ends at y 780 of 944 px, the projects column at 580, the
right column at 630, so 160-360 px of every column is empty. At 1024x640 the page is 819 px tall in a 584 px region
(scrolls 235 px) and Usage, Cost and Connections are all below the fold.

## A. Why it reads as generic

1. **Layout is the SaaS template.** A hero band with a big figure, then a card grid, then three equal fact cards.
   Same skeleton as every analytics dashboard. Nothing in the layout expresses a hierarchy of agents, work flowing,
   or time. (`dash-1600x1000-dark.png`)
2. **The hero spends 120 px (88 at 1024) to say what the bell already says.** "2 need you" is also the sidebar
   "Needs you . 2", the rail badge and the Needs you section heading. The line under it, "4 projects . 4 runs open .
   $0.02571 in the last 7 days", is set in the code font and reads like a log line. The gradient edge and mark are
   decoration with no information.
3. **Information repeated, not layered.** One permission card shows up as: a Needs you row ("Allow: Edit
   example.ts"), a Running now row whose status word is again "Needs you", the project tile ("1 decision . 1 run"),
   the sidebar project badge, and the hero figure. Two Needs you rows have the identical first line "Allow: Edit
   example.ts"; only the caption tells them apart.
4. **Figures that tell nothing or disagree.**
   - "Running now 4" lists runs whose status is Idle (Chat, Deep tree), Needs you and Running. In the 1600 dark shot
     zero runs were working. The heading and the hero's "4 runs open" both overstate.
   - "Idle" on the Mobile app row while its canvas shows an orchestrator "Waiting for your reply" and three agents
     "Reported back" (`explore-live.png`). The row has no word for that, so the user cannot tell finished-waiting from
     stuck.
   - Usage card: "Anthropic 5-hour window . 100%" in a red bar, while the sidebar popover says "Mock adapter. Runs use
     scripted data. No plan limits apply." (`explore-popover.png`). Mock-only data, but it shows the card prints a
     figure without saying where it comes from.
   - Cost "$0.02571" and tile "$0.00573 7 d": six decimals and a bare "7 d" suffix that reads like a unit, not "last
     7 days". Mock prices are tiny; real figures would be 2 digits, but the "7 d" stays cryptic.
5. **Nothing agent-shaped.** No role, no handle, no activity string, no branch, no step. A run is its truncated
   prompt ("Help me plan the", "Fix the typos in", "Deep tree mockdeep-tree"). The Live canvas shows "Reported back",
   "Waiting for your reply", tokens and cost per agent; the Dashboard shows none of it.
6. **Tiles lead with noise.** The brightest text in a tile after the name is the working-folder name in mono
   (`orgai-e2e-billing-...` here, a long path in real use). The unique content, the newest run, is one dim clamped
   line. "4 roles" is a constant most days. No thumbnail of the team, nothing a tile could show only for an
   agent-org (who is working, who is blocked).
7. **Dead space.** See the measurements above; the right and middle columns end early and the bottom third of the
   1600x1000 page is empty while the 1024x640 page hides its facts under the fold.
8. **Copy.** "Since you were last here", "From the runs OrgAI keeps.", "Connections: Default: Anthropic . Connected",
   "Mark all seen" are generic dashboard captions. The one human line ("Was waiting on you when OrgAI closed.") only
   appears after a quit. "All quiet" (not seen in this state; spec 3) is the same register.
9. **Motion and colour carry no meaning here.** The Live canvas uses colour for state, halo on live nodes and edges
   that carry work; the Dashboard uses one amber tint for "needs you" and otherwise identical grey cards.

What the strongest screens have that the Dashboard lacks:

| Screen | Quality | Dashboard today |
| --- | --- | --- |
| Live canvas | The domain object (agents, reports, edges) is the layout; state is colour plus a word on the node; every number is per agent | Counts of runs; no agent appears |
| Knowledge graph | Spatial memory (positions persist), size and colour mean something, hover reveals detail in place | Fixed grid, everything same weight |
| Team tab | The assistant tray proposes the next action with a reason | No suggestion anywhere on the page |

## B. What a user running several teams wants first

Ranked by value for "open the app, see my organisation, decide what to do next". "Data today" says whether it is
visible somewhere in the app now; "Renderer-only" says whether the Dashboard could show it with no new contract.
Statements marked (code) are read from code or CLAUDE.md, not seen in this walk.

| # | Candidate | Value | Data visible today | Renderer-only | Clicks from Dashboard today |
| --- | --- | --- | --- | --- | --- |
| 1 | Who is working right now across runs, on what (agent handle, role, activity string) | Highest: the control-room view; answers "is my money doing something" | Yes, on each run's canvas (`explore-live.png`: "Waiting for your reply", "Reported back"). `runs[runId].agents` with the activity is in the store (code: `useAppStore.ts` RunState) | Yes | 1 click per run (Running row opens it), and one run at a time, so N runs = N visits |
| 2 | Needs you with the actual ask and an inline answer (Allow / Deny / pick an option) | Highest: the loop closes without leaving | Cards live on the run; the row shows only the label | List yes; answering inline would reuse existing `decide` calls (code), still renderer-only | 1 click to open the card, then 1 to answer (2) |
| 3 | Plan limits and when the window resets, for the connections in use | High for subscription users: it gates all work | Yes: sidebar account popover (mock shows "No plan limits apply", so the real window list was not seen). Dashboard Usage card shows only the tightest window and no reset time | Yes (`usageByConnection`, `tightestWindow`) | 1 (sidebar footer). Card: 0 but no reset |
| 4 | Runs ending soon / paused with a resume time ("resumes 14:05") | High: unattended work stalls here | Yes (Paused section, spec 4.4). Not seen: the mock pauses for 1.5 s then auto-resumes | Yes | 0 to see (section), 1 to Resume |
| 5 | Branches left waiting to merge | High for code projects: work is not done until merged | Per project: Settings > Maintenance, and "unmerged" chip on canvas nodes. Maintenance read "No report branches waiting" in the mock (`explore-maint.png`, copy runs together) | Per-project call `maintenance.listWorktrees(projectId)` exists (code, `preload`); one call per project | 3 per project (tile, Settings, Maintenance) |
| 6 | Team assistant suggestions pending per project | Medium-high: the harness proposing improvements | Team tab tray (`explore-team.png`); the tab count badge appears only with suggestions (none in this state) | Needs `teamAssistant` store state per project (code: `store/teamAssistant.ts`), probably yes | 2 per project |
| 7 | Services needing sign-in or a missing secret | Medium-high: silent cause of failed runs | Connectors pane tiles and Team > Catalog rows ("Needs sign in", "Needs a value for this project"). None seeded; not seen | Yes if the connection list is in the store; per-project needs an extra call (code) | 2 global; 3 per project |
| 8 | Team files awaiting approval / repo config awaiting trust | Medium: rare but blocking | Already counted as a Needs you decision of kind `team` (code, `dash-needs-row[data-kind=team]`); trust shows as a topbar badge inside the project and a notice on the New run page. Not seen (needs a git repo with those files) | Team files yes (already in Needs you); trust needs `folderConfigTrust` per project, present on `Project` (code) | 1-2 once inside the project |
| 9 | Continue the last chat / last run | Medium: the most common "resume my day" action | Sidebar Chat row opens the live chat; Since section has "Continue" only after a quit | Yes | 1 (sidebar); Dashboard Running row also 1 |
| 10 | Activity strip, last 14-30 days (runs and cost per day) | Medium: shows rhythm and spend at a glance | History > Trends per project (`explore-trends.png`) | Yes via `runs:usageStats` (all rows, cross-project); the Cost card already uses summaries | 3 per project; no cross-project view |
| 11 | Quick actions: start from a template, new run in project X | Medium: shortens the first action | New project dialog "Start from a template" | Yes (`openNewProject`); a per-tile "New run" would be new UI only | New project 1, radio 2, template pick 3, create 4+ |
| 12 | Last decision the user made | Low-medium: reassurance and undo | Not visible anywhere I found except inside that run's transcript | No: decisions are not kept as a list the renderer can read (not verified; would need main) | Unreachable without opening the run |
| 13 | Recent outputs | Out of scope per brief (another run owns it) | No | No | n/a |

**What would make it feel like the control room.** 1, 2, 4 and 5 together: a live "Your organisation right now" band
showing agents grouped by project with their activity string and state colour (the canvas vocabulary, so users already
know it), the decisions answerable in place, and a "waiting to merge" and "resumes at" line per project. These are the
things the user has to leave the Dashboard to learn today. 3 belongs there as a quiet line with a reset time, not a
card. 6, 7 and 8 are attention items that fit the existing attention column as extra kinds; they should appear only
when non-zero.

**What is noise today.** The hero figure and its subline (duplicates the bell), the Connections card when everything is
connected ("Default: Anthropic . Connected" plus a link, always, at the cost of 101 px), the "4 roles" tile foot, the
working-folder mono line as the tile's second-brightest text, "Since you were last here" for runs the user just ended
themselves (here: the run I ended appears as "Stopped ... just now"), and the status echo in Running now rows for runs
already listed in Needs you. The Cost card is useful but the six-decimal figures and "7 d" need fixing.

## Findings, ranked

### H1. The page never shows what the agents are doing

- Screen: Dashboard, both sizes, both themes (`dash-1600x1000-dark.png`, `explore-live.png`).
- Steps: seed as above, open Dashboard. Compare with Mobile app > Live.
- Experience: the Dashboard lists runs by truncated prompt with a status word. The same run on its canvas shows
  agents, roles, "Waiting for your reply" / "Reported back", tokens and cost. A user running several teams must open
  each run to learn who is doing what.
- Fix: a Running band built from `runs[*].agents` (handle, role, activity string, state colour), grouped by project,
  capped, each row opens that agent in its run. Same strings as the canvas nodes so no new copy.

### H2. "Running now" and the hero count include idle and waiting runs

- Steps: seed, read Running now at 1600x1000 dark: heading count 4, rows read Needs you, Idle, Needs you, Idle; hero
  "4 runs open"; nothing is working.
- Experience: the section name and numbers promise activity that is not happening, and the user cannot tell "waiting
  for my reply" from "stuck". Idle appears on a run whose orchestrator says "Waiting for your reply".
- Fix: name the section "Open runs" (or split Working / Waiting for you / Idle), count only working runs in any
  "running" wording, and show the root's activity string on an Idle row.

### M1. The same fact is shown five times

- Steps: one permission card, find it in the hero, bell, Needs you, Running now ("Needs you" word) and the tile.
- Fix: hero becomes a single quiet line or goes; Running now drops runs already in Needs you (or marks them with the
  existing amber dot only); tile keeps the decision count.

### M2. Needs you rows are indistinguishable at a glance, and cannot be answered from here

- Steps: `dash-needs-row` x2, both "Allow: Edit example.ts"; only the caption differs. Enter opens the run and focus
  lands on a primary button (Q4 audit: the card's button) after 1.5 s.
- Fix: lead with project and run name, show the command or file, and offer Allow once / Deny inline for permission
  cards using the existing decision calls.

### M3. Dead space at 1600x1000 and facts under the fold at 1024x640

- Measured as above (columns end at y 580 / 630 / 780 of 944; 1024x640 scrolls 235 px, Usage, Cost, Connections hidden
  until scrolled: `keys-end.png`).
- Fix: use the space for H1's band and an activity strip; move Connections out unless it has a problem (spec 5.4 already
  only needs that row when a connection is down).

### M4. Tile hierarchy puts folder noise ahead of work

- `dash-1024x640-light.png`: the mono folder name outweighs the newest run line; cost reads "$0.00573 7 d".
- Fix: folder to the tooltip or a quiet caption, newest run in the body font with its activity, cost as "$0.57 this
  week" with the unit spelled out, no "4 roles" unless it changed.

### M5. Usage card contradicts the popover in mock; no reset time

- Steps: Dashboard Usage card "5-hour window . 100%" red; sidebar footer popover "No plan limits apply".
- Not verified with a real plan (mock). Fix: say where the figure comes from, add "resets in 2 h 10 min", hide the
  card when the popover would say no limits.

### M6. Quick, per-project facts need three clicks and cannot be compared

- Merge waiting, assistant suggestions and trends are 2-3 clicks deep per project and never cross-project. See the
  click counts table. Fix: surface the non-zero ones on the tile or as attention rows.

### L1. Cost figures: six decimals and "7 d" (hero "$0.02571", Cost card "$0.02571", tiles "$0.00573 7 d"). Mock prices; the suffix is a real wording issue.
### L2. Maintenance "No report branches waiting" runs two sentences together (`explore-maint.png`); the Dashboard cannot use it until that is clear.
### L3. Run names from mock markers read "mockdeep-tree", "mockrate-limit" (the `[mock:...]` brackets and colon are dropped from the prompt title); mock-only but visible on every row.
### L4. Wordmark reads "( MOCK Dev" with a clipped glyph in the full sidebar header (already open from walk 2 L-list).
### L5. "Since you were last here" lists the run the user just ended themselves ("Stopped Fix the typos in, just now"). Suggest hiding runs ended by `endedBy: 'user'` this session.
### L6. Tab from the last stop ("Connection settings") goes to "Skip to content" at the top, scrolling the region; fine, but "Mark all seen" focus scrolls the page 235 px at 1024x640 on first reaching it.

## Click counts from the Dashboard today (mouse; keyboard is the same plus Tab stops)

| Target | Path | Clicks |
| --- | --- | --- |
| Agents working in one run | Running row -> Live canvas | 1 (then 1 back per extra run) |
| Answer a permission | Needs you row -> Allow | 2 |
| Plan limits and reset | sidebar footer popover | 1 |
| Branches waiting (one project) | tile -> Settings -> Maintenance | 3 |
| Team assistant suggestions | tile -> Team | 2 |
| Services needing sign-in | gear -> Connectors | 2 (per-project values 3) |
| Repo config trust | tile (topbar badge) / Live -> New run notice | 1 / 2 |
| Team files awaiting approval | Needs you row (kind team) or tile -> Team | 1 / 2 |
| 14-30 day activity | tile -> History -> Trends | 3 per project |
| Continue last chat | sidebar Chat row, or Running row | 1 |
| Start from a template | New project -> template radio -> pick -> Create | 4+ |
| Last decision made | not reachable | n/a |

Counts for the first six rows were done by hand in the app; the trust and team files rows are from code (those states
were not seeded).

## Keyboard pass (1024x640, dark)

Order observed from the h1: New chat, New project, Needs you rows (2), Running rows (4), Mark all seen, Since row,
then each tile (Open, More) x4, Connection settings, then the skip links. 21 stops. DOM order equals visual order.
Every stop shows an outline; the tile's Open ring is drawn on the tile (`keys-mid.png`). Usage and Cost have no stops
(correct, nothing to act on). Enter on a Running or Needs you row opens the run and lands focus on the card's primary
button; Enter on a tile Open lands on the topbar h1. Not a finding, but the Needs you rows are the same label twice,
so a keyboard or screen reader user hears "Allow: Edit example.ts" twice before the project.

## Not driven

- Paused section: the mock pauses a `[mock:rate-limit]` run for about 1.5 s and then auto-resumes, so the section never
  stayed on screen; its wording and Resume now were not seen.
- Real plan windows and reset times (mock hides the footer meter and says no limits), LiteLLM spend lines, a
  disconnected connection row.
- Team assistant suggestion badges, services needing sign-in, missing secrets, repo config trust notice, team files
  card, branches waiting (all need states the mock did not produce here without extra setup); the table marks them as
  read from code.
- "All quiet" and first-launch states (walked in walks 1-2, not repeated); Dashboard with more than 6 projects (search,
  caps, Show more); delete flow; relaunch ("Ended when OrgAI closed", Continue).
- System theme, screen reader output, macOS, Linux.
- The sidebar rail's own affordances were looked at only where they appear in the 1024 shots.
