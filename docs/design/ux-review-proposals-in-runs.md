# UX review: proposal cards in runs (MCP servers, skills) before they move into work runs

Walked on dev 7967ec8, built app, mock adapter (ORGAI_MOCK=1, fresh temp ORGAI_DATA_DIR, ORGAI_MOCK_SCRIPT for the
custom proposals below). No tokens spent, no smoke scripts. Windows 1024x640 and 1600x1000, dark and light, one
keyboard-only pass. Screenshots are in the gitignored `e2e/shots/proposals-walk/` (numbers below), with the scratch
drivers `walk.mjs` / `walk2.mjs` and the raw DOM measurements in `notes.txt` / `notes2.txt`. This brief allowed one
file in the repo, so the shots are not committed beside this doc.

What was walked:

1. Library Skill assistant (default mock: "Mock skill", one New / Library item). Shots 01-07.
2. Library MCP assistant (default mock: mock-fs, pinned stdio). Shots 08-13.
3. Project-scope MCP assistant (custom script): link mock-fs from the library for one role, add `github-issues`
   (stdio, secret `GITHUB_TOKEN`, two roles). Shots 14-18. Then a second proposal that narrows `github-issues` to the
   Reviewer and removes mock-fs. Shots 19-21. Started through `window.orgai.mcp.startAssist` (the same IPC the Team >
   Catalog dialog calls) and reached from the Needs-you popover.
4. Project-scope Skill assistant: the default project create, then a custom Update (roles changed) + New. Shots 22-27.
5. A project work run (custom script): two reports each leave a background permission card (Edit, Bash), the
   orchestrator asks a question (`ask_user`), then proposes an org chart change (`propose_org_change`, the only proposal
   a work run can raise today, so it stands in for the coming MCP / skills cards), then `request_mcp_install` with a
   secret. Three decisions open at once. Shots 28-36.
6. Keyboard-only: from the Settings tab to a project MCP proposal (two servers, three secrets) through the Needs-you
   row, read it, approve it, then follow the "Open its connections" link. Shots 41-47.

Not walked: the Architect setup session (covered by `ux-review-mcp-3.md`), the native folder picker, a real secret
entry flow after approval (there is none to walk, see H4), Request changes round trips (mock scripts set
`retryOnRevise: false`).

## Verdict

The cards are honest and well structured at 1600x1000, and the tray, stepper and Needs-you path already cope with a
proposal arriving next to permission and question cards in a busy work run. They are not ready to carry project
changes mid-run yet. Five things block that: at 1024x640 the card hides everything behind Details and then shows it
through an 8 to 46 px window while Approve has focus (H1); a removal names an internal id (H2); a change to an existing
server's roles reads as a fresh "Link" with no before and after (H3); promised secrets are never asked for (H4); and
there is no way to say "no" without writing feedback (H5). The work-run timing ("takes effect after the orchestrator's
current turn") is not said anywhere on the card (M1).

## Earlier findings re-walked

| Finding | Status | Evidence |
| --- | --- | --- |
| mcp-3 #2: proposal cards clipped at 1024x640 | Open, changed shape | Body is now folded behind Details at 1024x640 (shots 01, 08, 14, 22, 30). Opened, the body is 46 px of 165-283 px with one card (02, 09, 15, 20, 26) and 8 px of 234 px (org) / 726 px (install) when the stepper shows (31, 36). |
| mcp-3 #3: library proposal used project copy | Fixed | "Library / Changes your MCP library", "Approving saves these MCP servers to your MCP library (available to every project)", no role line (09, 11, 12). |
| mcp-3 #9: omitted roles read "Every role" | Open by code | Not driven (my scripts pass roles). `lib/mcpProposal.ts` `whoCanUse` still returns 'Every role' for `roles === undefined`. |
| mcp-3 #15: re-offers "Link X from your library" for a server already linked | Open, now load-bearing | A role change to the linked `github-issues` reads "Link github-issues from your library" (21). See H3. |
| assistants M4: "unattended" and "Replying to the orchestrator" in assistant runs | Fixed | Run meta has no "unattended" on assistant runs (02, 21); composer reads "Waiting for your answer" / "Reply to the assistant" (01, 17). |
| assistants M8: no next step after approving | Fixed | Run meta shows "Skills saved to your library. Open Skill library", "Saved to your MCP library. Open Connectors", "Servers saved to this project. Open its connections", "Skills saved to this project. Open the Team catalog" (07, 13, 18, 24). |
| assistants keyboard note: card does not take focus on arrival | Partly | Enter on the Needs-you row with one waiting item lands focus on the card's Approve (notes2, shot 41). At 1024x640 that is Approve of a folded card (H1). Arrival focus during typing was not measured. |

## Click counts

| Scenario | 1600x1000 | 1024x640 |
| --- | --- | --- |
| Library Skill assistant: start to approved | row (1), type, Start (1), Approve (1) = 3 | + Details (1) + 2-3 wheel scrolls in a 46 px window = 4 + scrolling |
| Library MCP assistant: start to approved | 3 | 4 + scrolling |
| Project MCP proposal from another tab | Needs you (1), item (1), Approve (1) = 3, second server needs a scroll inside the card (17) | 4 + scrolling; keyboard: Tab (1), Enter (1) lands on Approve, Enter (1) approves without the body ever shown = 3 keys blind |
| Work run, 3 cards open, reach and approve the proposal | answer question: option (1) + Submit (1); proposal is selected next automatically; Approve (1) = 3 | same 3, + Details (1); the 8 px body cannot be read in practice |
| Set the secret the MCP proposal promised | Open its connections (1) lands on Team > Catalog with "GITHUB_TOKEN not set"; no Set button on the row (47) | same; row is below the fold (46) |

## New findings

### High

**H1. At 1024x640 a proposal is approved blind: the body is folded behind Details, opens into an 8-46 px window, and Approve has focus.**
- Flow: every proposal at 1024x640 (frame under 480 px, `section.frame-tray[data-compact=true]`). Shots 01/02 (skills),
  08/09 (MCP library), 14/15 (MCP project), 22, 25/26 (skills project), 30/31 (org chart in a work run, stepper open),
  35/36 (install card, same problem), 41-44 (keyboard).
- Seen: the folded card shows only "Proposal / Skill assistant R1 / Approve skills proposal / Details / Approve /
  Request changes". Nothing names a server, a skill, a role or a secret. Details opens `.decision-body` at
  `max-height: min(30cqh, 200px)`, but the tray does not grow, so the body measures 46 px tall for 165-283 px of
  content with one card and 8 px for 234 px with the stepper (notes.txt, "bodyScroll"). The question card next to it
  is fine because `inline` cards get `min-height: 200px`. Focus on mount goes to Approve because proposal cards do not
  set `focusDetails`. The composer keeps about 95 px under the tray while the card is open.
- A first-time user thinks: "Approve what?" and either approves to make it go away or hunts for the side panel.
- Owner: `styles/cards.css` (compact rules near line 551), `components/ProposalCard.tsx` / `DecisionCard.tsx`
  (`focusDetails`), `components/layout/CanvasFrame` (tray sizing).
- Fix: in a compact frame, an expanded or proposal card takes the frame (stage collapses to its toolbar, body at least
  200 px, the composer folds to one line), proposal cards pass `focusDetails`, and the folded title carries a summary
  ("MCP servers: add github-issues, link mock-fs"). Check: at 1024x640 the first server or skill of the proposal is
  visible without scrolling and the first Tab stop is Details.

**H2. A removal shows the internal id, not the server name.**
- Flow: scenario 3, second proposal ("remove mock-fs"). Shots 19-21 (below the fold at both sizes); text in notes.txt:
  "Removals | Remove mcp_mvzl1cqi0vvzkkxw".
- Cause: `lib/mcpProposal.ts` `removalLabels` looks the id up only in `payload.upsert`; a removed server is never
  there.
- A user thinks: "What is mcp_mvz...? Is this one of mine?" They cannot tell a removal of a shared notes server from a
  typo.
- Fix: resolve the name from the project's servers (and the library for library scope), and say who loses it:
  "Remove mock-fs from this project. Implementer can no longer use it. The library entry stays." Owner:
  `lib/mcpProposal.ts` `removalLabels` (take the current servers) and `ProposalCard.tsx` `McpServersBody` (pass
  `project.mcpServers`). Check: the card names "mock-fs" and its roles.

**H3. A change to an existing server's roles reads as a new "Link", with no before and after.**
- Flow: scenario 3, second proposal narrows `github-issues` from Orchestrator + Implementer to Reviewer. Shot 21.
- Seen: "Link github-issues from your library / Pinned / Runs code on this machine / Who can use it: reviewer".
  Nothing says it is already in the project, that two roles lose it, or that the version does not change. The
  coming "which roles may use them" action is exactly this case.
- Fix: diff the proposal against the project like the org chart card does (shot 33: "1 added, 1 changed", "3
  unchanged roles"): a summary line ("1 access change, 1 removal; 2 servers unchanged"), a Changed badge, and
  "Who can use it: Reviewer (was Orchestrator, Implementer)". Owner: `lib/mcpProposal.ts` `upsertAction` /
  `whoCanUse` (add a `current` argument), `ProposalCard.tsx` `McpServersBody`. Check: the shot 21 case shows Changed
  and both role lists.

**H4. "You will set 1 secret after approving" is a promise nothing keeps.**
- Flow: scenario 3 and the keyboard pass. Shots 15 (card text "You will set 1 secret after approving: GITHUB_TOKEN"),
  18 and 45 (after approval: "Servers saved to this project. Open its connections"), 46-47 (Team > Catalog rows "-
  Authorization not set", "- TRACKER_TOKEN not set" with Test and "..." only).
- Seen: both servers are saved `enabled: true` with every secret empty; per CLAUDE.md such a server never starts and
  the next run gets a warning. Nothing asks for the value, and the follow-up link does not mention it. In a work run
  the orchestrator would be told "approved" and then find the tools missing. The install card in the same tray does
  this well: secret field, Save, "Not set. The server may not work." (34).
- Fix: after approving, the run-meta notice reads "github-issues needs GITHUB_TOKEN before it can start. Set it" and
  opens the secret field; or the card carries optional secret fields like `McpInstallCard`. The decision text to the
  agent names servers still waiting for secrets. Owner: `ProposalCard.tsx`, `lib/proposalNext.ts`, the RunMeta notice;
  the decision text in `harnessTools.ts` is the Runtime Lead's. Check: approving shot 15's card leads to a GITHUB_TOKEN
  field in one click.

**H5. There is no "no": only Approve or Request changes (Skip exists only in setup).**
- Flow: every proposal outside setup. Shots 04, 06, 17, 33.
- Seen: Request changes opens a textarea and Send feedback stays disabled until text is typed (06). In a work run the
  orchestrator's turn waits on the card, so a user who simply does not want an extra server or role must invent a
  reason. The install card next to it has Deny (34), so the two MCP cards in one tray disagree.
- Fix: a quiet "Not now" on every non-setup `mcpServers` / `skills` / `orgChart` card that sends a fixed decline
  ("The user declined this change; carry on without it."), like `SKIP_MCP_FEEDBACK`. Owner: `ProposalCard.tsx`
  (`canSkip`), wording shared with the Runtime Lead. Check: one click declines and the run continues.

### Medium

**M1. Nothing on the card says when the change takes effect.**
- Shots 04, 17, 33. Helpers say "Approving saves these MCP servers to the project" and "Approving replaces the
  project's org chart with these roles". The timing appears only in the transcript tool result, cut off in the side
  panel: "APPROVED. The org chart was updated for future runs. This session keeps its current roles; carry on..." (34).
- A user approving mid-run will expect the agents to have the server now.
- Fix: a work-run helper variant: "Saved to the project now. The orchestrator can use it from its next turn; reports
  already running keep what they have." (org chart: "Applies to future runs; this run keeps its roles."), and the
  same words in the after-approve notice. Owner: `ProposalCard.tsx` `APPLY_NOTE` / `skillsApplyNote`,
  `lib/mcpProposal.ts` `mcpApplyNote`, `lib/proposalNext.ts`. Check: the helper of a work-run proposal says "next turn".

**M2. The kind is missing from Needs-you, the tray chips and the title, and "mcp" is lower-case.**
- Shots 16 ("Proposal: Add GitHub issues and shared notes"), 32 ("Proposal: Add a release writer"), 30 (chip "1 Add a
  release writer" next to "2 Edit notes.js"), 09 ("Approve mcp servers proposal").
- Location is named well ("Proposals walk / R1: Let the reviewer..."), but in a work run with three open decisions a
  user cannot tell an MCP change from a skill or org chart change before opening it.
- Fix: "MCP servers: <title>", "Skills: <title>", "Org chart: <title>" in `lib/needsYou.ts` (line 36) and the chip
  label in `views/LiveRunView.tsx` (line 604); `lib/decisionTitle.ts` `proposalTitle` keeps the label's case
  ("Approve MCP servers proposal"). Check: e2e text match on the chip.

**M3. Roles are shown as slugs.** "Who can use it: orchestrator, implementer" (15), "Roles: researcher" (26), while the
org chart card shows names with role-colour avatars (33). Fix: map slugs to role names (and the role dot) in
`lib/mcpProposal.ts` `whoCanUse` and `ProposalCard.tsx` `SkillsBody`. Check: "Who can use it: Orchestrator,
Implementer".

**M4. Request changes says "The Architect revises and proposes again."** in the Skill assistant (06) and would say it
under an orchestrator's proposal. Fix: use the proposer ("The assistant revises...", "The orchestrator revises...").
Owner: `ProposalCard.tsx` placeholder.

**M5. Proposal cards outside setup name no proposer.** The question and install cards show "OR Orchestrator" (28, 34);
the org chart proposal from the same orchestrator shows only "Run R5: Fix the notes route" (33). `LiveRunView.tsx`
line 605 passes `who` only for setup runs. Fix: pass the proposing agent's name (and `agentId` for the role colour).

**M6. A skill Update hides what changes.** Shot 27: "Update / This project / mock-skill / Checklist review of a change,
now including tests. / Roles: researcher". The skill was loaded by the Orchestrator before; the card does not say so,
and "Show instructions" shows only the new text. Fix: "Loaded by: Researcher (was Orchestrator)" and a "Show
changes" view of the instructions. Owner: `ProposalCard.tsx` `SkillsBody` (needs the current project skill).

**M7. Even at 1600x1000 a two-item proposal scrolls inside the card with no cue.** Shots 17, 21, 27: the second server
or skill is cut under the first, the only hint is a thin scrollbar; body 195 of 226 px, 283 px of content in shot 17.
Fix: the summary line from H3 at the top, and let the tray take up to about 60 % of the frame while a proposal is
open. Owner: `styles/cards.css` `.decision-body` max-height.

### Low

**L1. "Pinned" on a library link** (17, 21): linking does not choose a version, so the badge reads as part of the
change. Show it only for new definitions.

**L2. A link shows "Runs code on this machine" but not the command** (17): `proposalCommand` returns null for a
`libraryId`. Show the library entry's command in the same code block.

**L3. Three vocabularies for access:** "Who can use it" (MCP), "Roles:" (skills), "Scope" (install card, 34). Use "Who
can use it" for MCP and "Who loads it" for skills on every card.

**L4. Org chart diff shows the vendor alias** ("reports to Orchestrator / haiku", 33) for a fast-tier role; the tier
name is what the user chose elsewhere.

## How link / grant / remove skill items should read

Group items in the order New, Link, Access, Update, Remove, and open the list with a summary line like the org chart
card ("1 new, 1 linked, 1 access change, 1 removed; 3 skills unchanged" with the unchanged ones in a disclosure).
Always role names, never slugs. Suggested rows:

| Action | Badge (tone) | Line 1 | Line 2 | Extra |
| --- | --- | --- | --- | --- |
| create | New (success) | `release-notes` + scope badge | "Who loads it: Orchestrator, Implementer" | Show instructions |
| link | From library (info) | "Use `review-checklist` from your library in this project" | "Who loads it: Reviewer" | "Kept in sync with the library; edit it there." Show instructions |
| grant | Access (warning) | "Change who loads `review-checklist`" | "Adds: Reviewer. Removes: Implementer. Keeps: Orchestrator." | "Instructions unchanged." No Show instructions by default |
| update | Changed (warning) | `mock-skill`, "instructions changed" | "Who loads it: Researcher (was Orchestrator)" | Show changes (before / after) |
| remove | Remove (danger) | "Remove `release-notes` from this project" | "Orchestrator and Implementer will no longer load it." | Linked skill: "Unlinks it; the library entry stays." |

The helper under the list in a work run: "Saved to this project now. Agents load it from the orchestrator's next turn."

## Things that already work

- Nothing floats over the canvas: the tray stacks under the stage at both sizes (stage y 120-371, tray from y 371 at
  1024x640; notes.txt), and the canvas nodes say what the root waits on ("Proposing an org chart change...", "Asking
  you to add an MCP server...", 31, 36).
- Three open decisions in one work run: the stepper ("Decisions 3", chips, "1 of 3", Previous / Next), a roving chip
  focus, and after answering the question the proposal is selected next by itself (28, 30).
- Needs-you names the location ("Proposals walk / R1: ..."), the sidebar says "3 decisions / 1 run", the topbar shows
  "Needs you / 1" on other tabs, and Enter on the Needs-you row lands on the card (16, 32, 41).
- Library and project scope are told apart by a badge and a line ("Library / Changes your MCP library", "This project /
  Changes this project's MCP servers"), and the skills helper switches between library and project (04, 09, 15, 27).
- The org chart card is the model the MCP and skills cards should copy: summary, Added / Changed / Removed rows with
  avatars and a disclosure of unchanged roles (33).
- Stdio servers show the exact command with Copy, pinned state and "Runs code on this machine"; secrets are named, never
  valued (15, 17).
- The install card handles a secret inline (field, Save, "Not set. The server may not work.") and names the scope
  choices with consequences (34).
- After-approve pointers in run meta for all four proposal outcomes (07, 13, 18, 24), and a skill granted by an
  approved proposal shows up in the next work run's transcript as "Loaded skill release-notes" (33).
- Both themes are readable; badge tones (New, Update, Library, This project, Pinned) hold contrast in light and dark
  (03, 04, 10, 11, 23).
- Keyboard: every control in the card is reachable, focus rings show, PageDown scrolls the body once a control inside
  it has focus, and focus returns to the composer after the card resolves (notes2).

## Suggested order of work

1. H1 (compact tray and focus) first: it decides whether any of the rest can be seen at 1024x640.
2. H2 and H3 together in `lib/mcpProposal.ts` / `McpServersBody`: diff against the current project servers, real names
   for removals, a summary line (also fixes M7's missing cue).
3. H5 "Not now" and M1 timing copy, agreed with the Runtime Lead so the decision text the orchestrator receives says the
   same as the card.
4. H4 secrets after approval (notice with a Set action, or optional fields on the card).
5. M2-M6 wording and role names, then the skill rows from the table above as the new actions land.
6. Lows.
