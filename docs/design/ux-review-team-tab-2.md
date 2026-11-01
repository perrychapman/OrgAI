# UX review: the Team tab, second walk

Walked on `dev` (commit e02f191, built in this worktree with `npm run build`), `ORGAI_MOCK=1`, fresh temp `ORGAI_DATA_DIR`, two mock projects (Demo, Demo2) created with the Architect unticked. Driven with playwright-core through `e2e/lib.mjs` helpers (scratch scripts under the gitignored `e2e/shots/ux2/`). Screenshots are in `ux-review-team-tab-2-shots/` (86 files, named below by number).
Sizes: 1600x1000 and 1024x640, dark and light. One keyboard-only pass (Tab walk, node Enter, chooser, Escape). No smoke scripts, nothing token-spending.

Limits of this walk:
- The mock recommender returns instantly, so the progress state and Cancel were never visible (shot 11 is already the finished state). A real run is not judged here.
- The proactive "since your last run" badge never appeared in the mock (finding 6), so flow 3's badge, the "since your last run" line and the badge at 10+ were not seen live. The 10+ badge was simulated by injecting a `.tabs-count` span (shots 120).
- The mock's `code-review` skill (`~/.claude/skills/code-review`, in `mockHome.ts`) is found by discovery but never recommended, so the skill half of the scenario was walked only as far as the choosers allow.
- The brief's "mock-code-review" and "one anthropics/skills skill from outside sources" do not exist in this build: the mock offers one local MCP server (`mock-fs`), one curated connector (GitHub) and, with outside sources ticked, one registry server (`github-tools`).
- The Architect's first mock step is a permission card (`git status --short`). Finding 1 means I had to allow it through the preload API to see the rest of the Design flow.

## Verdict

The tab is much closer to the brief: the name is plain, the role-first "What it can use" block works, the Architect no longer hijacks Live, and the trust chips on cards are good. But three things would stop a first-time user cold:

1. A Design session stalls forever on a permission card the Team tab cannot show, while the app keeps saying "Needs you".
2. At 1024x640 the user clicks Recommend and nothing visibly happens.
3. "Finish setup" and "Sign in" drop you on the generic Connectors gallery, nowhere near the thing that needs finishing.

## The scenario: "give the Reviewer role GitHub access and a code-review skill"

Earlier walk: 9 or more clicks for GitHub, 6 more for a skill written from scratch, 3 to confirm, over two tabs and four dialogs (about 15+).

| Route | Steps | Clicks | Ends |
| --- | --- | --- | --- |
| (a) Team assistant, whole way | click Reviewer node (scope chip follows it, shot 10); Recommend; scroll the tray to the GitHub card; Apply ("Applied GitHub to Reviewer. It stays off until you sign in."); Finish setup; find the GitHub tile on a 38-service page (shot 22, 600 px down, "Not signed in / Finish setup"); paste token, Add token; click Team tab to go back | 7 | GitHub works. Skill: never offered (finding 6), so the scenario's second half is not completed |
| (a) assistant, up to Apply only | node, Recommend, Apply | 3 | Role has GitHub but it is off |
| (b) Role tab, GitHub, first time | node; Add; Browse tab; "Browse connections"; GitHub row; paste token + Add token; tick Reviewer in "Use GitHub in this project"; Use in this project | 8 | Role has GitHub (three stacked dialogs, shots 31, 32b, 33, 34) |
| (b) Role tab, GitHub already connected | node; Add; GitHub row in "Your connections" | 3 | Granted to Reviewer only, "GitHub / Can read" in the block (shot 35) |
| (b) Role tab, skill | Add a skill; This project (empty); Your library (empty); Found in this repo; "Review skills found in this repo" ... | 4+ and still no code-review | the home skill is not in any tab (shots 36, 37) |

What improved: GitHub for a role is 3 to 8 clicks on one tab (was 9 to 15 over two), and the result shows in the same block you started from. The assistant route is the shortest to "granted", but the secret step undoes the saving (finding 3).

## What improved since the first walk

- The tab is "Team", the project lands on it after Create, and the canvas keeps its room. First screen says what it is for ("What the whole team can draw on. Open a role to choose what it uses.") and the tray has one sentence on what Recommend does and what it costs.
- Selecting a role retargets the assistant's "For" chip (shot 31); no extra click.
- "What it can use" groups Tools, Connections and Skills with in-place Add; the result sentence is least-privilege: "Reviewer can read through github-tools. Roles (1)". Apply grants only the named role (checked: Reviewer only).
- Trust information on cards reads well: "Runs code on this machine", "Pinned: 1.2.0 npx -y @mock/github-tools@1.2.0", "Unverified", "Needs: GITHUB_TOKEN", "From the MCP Registry. Unverified: check it before use." (shot 13, 14).
- Undo exists on the applied row and focus lands on it. "It stays off until you add GITHUB_TOKEN" is honest.
- The Architect now runs in the tray: no R-run on the Live strip (shot 85), the tab stays Team, the chart updates under you after Approve (shot 84), and the org chart proposal is a clear added/removed diff.
- Settings > Tools slimmed to "Plugins and skill settings" with an "Open Team" pointer. Escape from a chooser returns focus to "+ Add". Enter on a node focuses its Name field.
- Light theme: card borders, chips (red "Runs code", amber "Needs:") stay legible (shot 93).

## Findings, ranked by user impact

### 1. Critical: Design mode stalls on permission cards the tray cannot show

- Flow 4, Design, step "Revise with the Architect". Shots 72, 73, 79, 80, 81.
- After Start the tray says "The Architect is working. Its questions and proposals appear here." and never changes. Meanwhile the topbar and sidebar bell say "Needs you · 1". The pending item is a permission ("Allow: Run git status --short", "Demo2 . R?: Revise this project's org chart and set..."). Clicking the pill or the bell entry does nothing visible (shot 80). Live shows no such run. `pendingCards` for the run confirms one open permission.
- Cause: `DraftPanel` renders only `questions` and `proposals`. Permission, rule request, MCP install and merge-review cards are not hosted. The old Live flow showed all of them, so this is a regression (decision cards and Needs-you are lost for Design mode).
- Expected: the card in the tray, or at least a Needs-you item that opens it.
- Fix: host every pending card kind of a `surface: 'team'` run in the tray (the `DecisionCard` shell), and make `waitingItems` navigate to the tray. Until then, a banner "The Architect is waiting for you" that scrolls the card into view. The card label "Run R?" should say "Architect" (no run id exists on this surface).
- Spec-level: team-tab.md must say which card kinds the tray hosts.

### 2. High: at 1024x640 Recommend looks like it did nothing

- Flow 1/2, Recommend at 1024x640. Shots 91, 92, 93.
- The tray is about 150 px of visible height (the editor takes the rest). After Recommend the visible part is identical: scope, buttons, checkbox. The "Found 2 recommendations and 1 gap." line and the cards are below, reachable only by scrolling a tiny viewport. No auto-scroll to results, no count visible. The first card then has its own inner scroll (nested scrollbars, shot 93) and Apply is under it.
- At 1600x1000 it is better but only about one card shows (shot 12, 13); Apply needs a tray scroll plus the card's own scroll. The chart stage keeps 524 px at 1600 and 326 px at 1024; a long empty canvas above short cards is the wrong trade when results arrive.
- Fix: when results arrive, scroll the tray to them and give the tray the space (or let the tray grow to about 50% of the frame while results are open); show the "Found N" line and an "Apply all safe" or a compact one-line card list first (name, source, Apply, Dismiss) with details on expand; lay cards out two per row at 1600.

### 3. High: "Finish setup" and "Sign in" lead to the wrong place

- Flow 5, trust. Shots 16, 21, 22, 23, 19.
- After Apply of the curated GitHub card, "Finish setup" opens App settings > Connectors at the top of the 38-tile gallery. GitHub's tile ("Not signed in", "Finish setup") is 600 px down under "Needs a token" (shot 22). No scroll-to, no highlight, no "Back to Team".
- For a registry server with an env secret (github-tools, `GITHUB_TOKEN not set`), the Role row's "Sign in" goes to the same gallery, where that server does not exist. The working path is Catalog > "More actions" > Edit > Environment variables > value > Save (shot 19), a developer form with Transport and Command fields.
- Wording: the card says "It stays off until you sign in", the destination says "Add GitHub with a token / Paste a token" (shot 23). The registry card says "add GITHUB_TOKEN". Three words for one step.
- Fix: deep link straight to the connector dialog (or the server's secret field) as a dialog over Team, not a navigation away; one phrase ("Add your GitHub token"); on save return to Team and show the role row turn "On".

### 4. High: results do not survive leaving the tab, and Re-check setup erases them

- Flow 3. Shots 61, 63.
- Recommend (3 cards), switch to History and back: 0 cards, tray idle (shot 61). Reload: 0 cards. Re-check setup after a Recommend (and one Dismiss): "Found 0 recommendations and 0 gaps." (the free check returns nothing in the mock and replaces the list).
- Dismissal: I dismissed `mock-fs`; on a later Recommend (new session, after reload) it was offered again. The e2e check "dismissed card does not return after Re-check setup" passes only because Re-check returns nothing.
- Expected: the list stays until I act on it, and a dismissed item stays gone (with a way to see dismissed ones).
- Fix: persist the last result per project and restore it on mount; Re-check should merge, not replace; keep a "Dismissed (2)" disclosure with Restore.

### 5. High: "What it can use" is still below the fold, and far by keyboard

- Flow 2, Role tab. Shots 15, 130.
- Role pane order is Identity, Model, then the block. The block's top is at y=689 at both sizes; at 1024x640 (viewport 641) the first screen shows Identity and Model only (shot 130 1024). First finding F8 is not fixed, only moved into the right panel. By keyboard it is 17 Tab stops from the Name field to "Add a connection" (8 colour swatches, Model, Effort, Tools Edit on the way); 27 keys from the Team tab.
- Fix: put the capability block first for the Team tab (identity and model collapsed under "Details"), or at least sticky "What it can use" with counts in the header; make the colour swatches one tab stop (roving radio group).

### 6. High (unverified): the proactive path and the skill half never delivered anything in the mock

- Flow 3 and 2. Shots 36, 37, 55, 58, 60.
- After 5 work runs ended (R2 to R6; R1 died with a relaunch) the Team badge never appeared and no "since your last run" line showed. `lastReview` shows `trigger: runEnded, mode: free, modelSkipped: mockFree, recommendations: [], pendingCount: 0, runsSinceModel: 4`. The mock's free review yields nothing, and the AI mode (default, every 3 runs) is skipped as "mockFree".
- The local `code-review` skill is discovered (`mockHome.ts`) but neither Recommend (scopes Reviewer and whole team, outside sources on and off) nor any chooser offers it. The "Found in this repo" tab only scans the repo (shot 37), so a user's own `~/.claude/skills` skill cannot be reached from a role.
- I could not tell whether the real proactive path, the badge and the "since your last run" copy work. Ask for a mock script that makes the free review return the local skill, and for the skill chooser to include "On this computer".
- Also: a run you End shows "Stopped", and the review fires on `finished|error` only. A user who ends sessions by hand (the mock waits for a reply forever, shot 57) never triggers a review.

### 7. Medium: the connection chooser is a three-dialog chain with an empty first tab

- Flow 2b. Shots 31, 32, 32b, 33, 34.
- Add a connection opens "Your connections" (empty on a fresh project: "Nothing else to add... Use Browse"), Browse says "Pick a service from the gallery" and offers a "Browse connections" button, which opens "Add a service" (a second dialog), then GitHub opens "Add GitHub with a token" (third), then "Use GitHub in this project" (fourth) with no role ticked although it was opened from Reviewer's chooser ("tick Reviewer" in the hint of shot 32).
- Fix: open on Browse when "Your connections" is empty, make Browse the gallery itself, and pre-tick (and lock) the role the chooser was opened for. The gallery footer still says "Describe it to an assistant" (shot 32b), a third name for the Team assistant.

### 8. Medium: Dismiss and Apply feedback

- Flow 3. Shots 62, 14.
- Dismiss removes the card with no toast and no Undo; the tray scroll jumps (shot 62). Apply shows the "Applied ..." row, but a page-level "Applied github-tools to Reviewer." line also shows at the top of the tray, so the same message appears twice. The applied row is inline in the list and moves.
- Fix: one announcement; Dismiss shows "Dismissed X. Undo" for 8 seconds.

### 9. Medium: Team review is on by default and hidden

- Flow 6. Shots 102b, 103.
- Settings > Agents > Behaviour, last row: "Team review: AI review, every 3 finished runs, token budget 20000". AI review is the default, so a first-time user opts into token spend without knowing (the tray warns about Recommend's cost, the setting does not). It is at the very bottom of a long pane (shot 102), under a name ("Team review") that is a third name for the assistant, and the pane is "Agents", which is permissions.
- The slimmed pane is called "Plugins and skill settings" and contains plugins, the evaluation switch and a token budget; a user looking for MCP or "Tools" will not guess it. Its first line "Roles, connections and skills are on the Team tab / Open Team" is good.
- Fix: default to Free checks, show the cost line, and surface the setting from the tray ("Team review: Free checks. Change").

### 10. Medium: Catalog duplicates and contradicts

- Flow 6. Shots 18, 19, 14.
- Catalog > Connections says "Custom servers you added: None yet. Custom servers are defined in App settings." while "Only in this project" lists `github-tools` (a custom server added by Apply). Skills has a primary "Add a skill", Connections a primary "Add a connection", the tray a primary Recommend: three competing purple buttons on one screen.
- The Role tab and Catalog show the same GitHub grants twice (role row, "Used by Reviewer"); that is fine, but only the Catalog row has the "Available to agents" switch and Edit, so enabling or fixing a server is Catalog-only.
- At 1600 the "Connections . 2" header squeezes its description into a 4-line column beside the "Add a connection" button (shot 18, 14, 93). Move the button below or shrink the copy.
- Panel opens on Catalog with nothing selected; Role with nothing selected is an empty prompt. A first-time user looking at "Skills . 0 / Suggestions from past runs / Evaluate skills / Connections . 0 / Plugins . 0" sees a long list of empties before any suggestion.
- The Catalog's skills block still has the old "Evaluate skills" / "Suggestions from past runs: Not run yet" row (from the old Tools pane), a second suggestion concept next to the Team assistant's.

### 11. Medium: wording and small contradictions

- "Pinned" ghost button next to the scope chip (`title`: "Follow the role selected on the chart again") reads as status text, and "Pinned: 1.0.0" on cards means a version pin. Rename to "Follow chart selection" and keep "Pinned" for versions (shots 10, 121).
- Design copy still says "proposes the revised roles on the live view" (shot 70), "Starts an Architect session (mock, no tokens)". The session is on this tab now.
- The Architect cards read "Run R?: Revise this project's org chart and set..." (shot 81). There is no run.
- "The Architect needs your answer." appears in the topbar and in the tray (shot 84).
- The curated card header shows a long documentation URL as the source ("https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md"); the chips "Can change data" and "Reaches a remote service" sit above "Read-only: a chosen role has no tool that changes things", which reads as a contradiction until you think. Say "Read-only mode" first.
- "Needs you" pill is a button that does nothing from the tray (finding 1).

### 12. Low: keyboard and layout details

- Tab order in the tray: Recommend tab, scope, Recommend, Re-check, then the outside-sources checkbox, then "What I looked at". The checkbox is visually above the buttons. Design and Role tabs are reached by arrows (roving, correct), but "Catalog" selected means "Role" cannot be reached by Tab at all.
- Chooser dialogs open with focus on "Close dialog" (shot 96) rather than the first choice; arrows do not switch the chooser's tabs (Tab only). Escape and focus return work.
- Badge at 12 (simulated, 13 px wide) is a plain number beside the label (shot 120); fine, but it reads as a count, not as "suggestions waiting". The accessible name "Team, 12 suggestions" is right.
- Sidebar lockup "(" and the rail's "D" pip are mock noise, not rated.

## Flow checklist

1. Fresh app, create project, open Team: clear (name, first sentence, Recommend). Slight overload of empties in Catalog (finding 10).
2. Scenario: counts above. Better than before; skill half blocked (6).
3. Run from Live, back to Team: badge and line not seen (6). Dismiss/Undo: Undo on an applied row works and the card returns; Dismiss has no undo and does not stay gone (4, 8).
4. Design: stays on Team (good), nothing lost in the happy path (question/proposal cards), but permission cards and every non-question card are lost (1).
5. Trust: source, pin, "Runs code on this machine", needs-secret and the access sentence are understandable. The "stays off until you add GITHUB_TOKEN" line leads somewhere only by a long route (3).
6. Catalog and Settings: contradiction in custom servers (10); Settings pointer lands well; Team review default and location (9). No deep link needed an extra navigation except Finish setup and Sign in.
7. Layout: 1024x640 tray (2); text wrap in Connections header at 1600 (10); light-theme chips OK; Pinned button unclear (11); badge 12 OK.

## Open from the first walk

- F8 (role pane order) is only partly fixed (5). F4 (home-folder skills unreachable) is still open (6). F11 (show the cost before the click) is fixed for tokens ("Needs: GITHUB_TOKEN") but not for how to supply them (3). F12's naming drift remains ("Describe it to an assistant", "Team review").

## Suggested order of work

1. Host every card kind in the Design tray, and make Needs-you navigate to it (1).
2. Make Recommend results visible at 1024x640 and persist them; make Re-check merge; keep dismissals (2, 4).
3. Finish setup and Sign in open the right dialog in place (3).
4. Capability block first in the Role pane; pre-tick the role in pickers; Browse as the default chooser tab (5, 7).
5. Mock: free review returns the local skill; skill chooser gets "On this computer" (6). Then re-walk flow 3.
6. Copy and default pass (9, 10, 11).
