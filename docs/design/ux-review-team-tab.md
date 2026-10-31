# UX review: reshaping the Org chart tab into a team-setup tab

Walked on `dev` (built from this worktree), `ORGAI_MOCK=1`, fresh temp `ORGAI_DATA_DIR`, mock project "Demo" created with the Architect unticked.
Windows: 1600x1000 and 1024x640, dark theme; light spot-checked at 1024x640 (shots 38, 39). Screenshots are in `ux-review-team-tab-shots/`.
Not done: a full keyboard-only pass (this brief was a planning walk, not a release walk), the native "Add from folder" picker, the real registry search (mock only), and a run that actually used GitHub.

The request: rename the Org chart tab so the name covers what is in it, move MCP and skill setup for roles onto it, and put AI help at the heart of finding MCPs and skills from local and outside sources.

## The scenario that matters

"Give my Reviewer role GitHub access and a code-review skill." Walked end to end.

| Step | Where | Clicks so far |
| --- | --- | --- |
| Org chart, click Reviewer, scroll the inspector 800 px past Identity, Model and Tools to find Services (shot 04, 17) | Org chart | 1 plus a scroll |
| Services says "No services yet. Connect and grant them in project Settings > Tools." Click Manage in Tools (shot 06) | Org chart to Settings | 2 |
| Land at the top of Tools (Skills section), scroll to "Services and tools" | Settings > Tools | 2 plus a scroll |
| Add a service, pick GitHub, paste a personal access token, Connect (shots 09, 10) | dialog | 5 |
| "Use GitHub in this project" opens, tick Reviewer, Use in this project (shot 11) | dialog | 8 |
| Skill: Add from library hits an empty library (shot 13); New skill is a blank form (shot 15); fill name, description, instructions, tick Reviewer, Create | dialog | 12 or more, plus typing |
| Back to Org chart, select Reviewer, scroll, open the collapsed "Skills" row to verify (shot 18) | Org chart | 15 or more |

About 9 clicks and one token for GitHub, about 6 more for a skill written from scratch, then 3 more to confirm the result where the user started. Two tabs, four dialogs, and one round trip. The user never sees "Reviewer can now use GitHub (read-only) and code-review" in one place unless they go back.

## Findings, ranked by user impact

### F1. Critical for this redesign: the role's capabilities live in two places that do not agree on who can edit what

- Flow: grant GitHub and a skill to a role. Step: Org chart inspector vs Settings > Tools. Shots: 04, 17, 18, 12, 16.
- Skills are editable checkboxes in the inspector (`RoleSkills`). Services are a read-only chip list (`RoleServices`: "Read-only list ... with a way into project Settings > Tools"). So one capability type is granted in place and the other only from the capability's side, in Settings.
- The Settings side groups by capability ("Can use: Reviewer", "Roles: Reviewer"), the Org chart side groups by role. Both are legitimate views, but neither links to the other. "Manage in Tools" lands at the top of Tools, not on the service or the role.
- Expected: click the role, see and change everything that role can do.
- Severity: High. Fix: one role-first capability section in the Team tab (see layout); keep the capability-first view as a catalog on the same tab.

### F2. High: AI help for tools and skills is not reachable from the org chart at all

- Every AI entry point today is in a different place (shot refs in the table below). From the org chart a user can only reach the Architect, and the Architect only revises roles, models and the chart ("Add a database specialist under the orchestrator, make the reviewer check accessibility..." in shot 03).
- The tool assistant sits under "Other ways to add" (a secondary menu, labelled as a fallback) in project Tools (shot 19), and as "Configure with AI" in a different pane of App settings (shot 28/29). Skill AI is only "Suggest new skills", a switch plus an "Evaluate skills" button in Tools (shot 32), and only after runs exist.
- Expected: describe the job, get recommended tools and skills for each role.

| AI help today | Reached from | Steps from the org chart | Shot |
| --- | --- | --- | --- |
| Revise with the Architect (roles, tiers, delegation) | Org chart side panel, only when no role is selected | 0 to 1 | 03, 35 |
| Quick draft (one-shot, no repo read) | Same panel, "Advanced: quick draft" disclosure | 1 | 36 |
| Describe it to an assistant (MCP servers, project) | Settings > Tools > Services and tools > Other ways to add (menu) | 4 | 19, 20 |
| Configure with AI (MCP servers, app library) | App settings > Connectors, scroll to "Custom servers (advanced)" | 3 and a long scroll | 28, 29 |
| Evaluate skills / Suggest new skills | Settings > Tools > Skills; the model step is off by default | 3 | 32 |
| Org retrospective | Live tab, only after a run, on the run strip | 3 and needs a finished run | 31 |

- Severity: High. Fix: one assistant region on the Team tab, scoped to the selected role or the whole team.

### F3. High: the Architect panel disappears the moment you select a role

- Step: Org chart, no selection, side panel is "Design the org chart with AI" (shot 03, 35). Click a role: the same slot becomes the inspector and the AI panel is gone (shot 04). `OrgChartView` renders `selectedRole ? RoleInspector : DraftPanel` in one `SidePanel`.
- A user working on a role cannot ask the AI about it. Adding tools to the role you are staring at is exactly where AI help is needed.
- Severity: High. Fix: the assistant must not share a slot with the inspector (see layout, tray region).

### F4. High: the "Add from library" primary button is a dead end for a first-time user, and no source is searchable

- Step: Settings > Tools > Skills. The primary (purple) button is "Add from library". On a fresh app the library is empty: "The skill library is empty. Skills you add to the library show up here. [Open the skill library]" (shot 13). That leads to App settings > Skill library, which offers only "New skill" and "Add from folder" (shot 27).
- "Import skills" only scans four folders inside this repo and says "No skills found. Searched .claude/skills, .agents/skills, ..." (shot 14). Nothing looks in the user's own `~/.claude/skills`, other projects, or any outside catalog. No search anywhere for skills.
- MCP is better (curated Connectors gallery, community registry search marked "unverified"), but local discovery is absent: no scan of a repo `.mcp.json` or the user's other tools' configs (searched the source: `.mcp.json` is only read by the runtime, not by any setup UI).
- Expected: "I need a code-review skill" gets me candidates, not an empty list and a blank form.
- Severity: High. Fix: AI recommendations over local plus outside sources, empty library never offered as the primary action.

### F5. High: an AI assistant run drops you into Live as "R1", with a wrong composer, a lookalike of a work run, and no way back

- Steps: Describe it to an assistant, type, Start. The app jumps to the Live tab, creates run "R1 Let the reviewer read GitHub pull reque..." and shows a single "MCP assistant" node (shot 21). The composer says "Replying to Orchestrator" although there is no orchestrator (shot 23). The approval card is docked in the tray and scrolls inside itself, so "Who can use it" is cut off until you scroll the card.
- After Approve, the assistant says "The MCP servers are set up." and then waits for a reply forever ("Waiting for your reply", shot 23). The user must find "End session". There is no "Back to Org chart" or "Reviewer now has GitHub".
- The transcript speaks in tool voice: "APPROVED. Linked from the MCP library to this project: github. Saved to the MCP library and linked ...", "Approve mcp servers proposal".
- The mock also searched "filesystem" for my GitHub request, which is a mock-script limit, not a UX bug, but note the user's stated role ("the reviewer") was not passed as a scope.
- Severity: High. Fix: run the assistant inside the Team tab (sandboxed run in the tray or panel), results land as diff-like "proposed changes" on the role.

### F6. High: AI-proposed access defaults to every role

- The approval card for the proposed server shows "Who can use it: Every role" (mock-fs, from the proposal) and after Approve the project row reads "Can use: All roles" (shot 32). Reviewer, a deliberately read-only role, now has a filesystem server it was never asked about; the inspector shows it as a quiet "mock-fs custom" chip (shot 38). Nothing flags the change.
- Contrast with the manual path, which is least-privilege: "Choose at least one role, or All roles. Agents get no access until you do." (shot 11).
- Severity: High (trust). Fix: AI proposals are per role, default to the roles it was asked about, and show an "added by assistant" diff on those roles.

### F7. Medium: the word "Tools" means three things

- Role inspector "Tools" = built-in tool permissions (Read, Glob, Grep, Edit, Bash, ...), a checkbox grid (shot 04).
- Project Settings "Tools" tab = skills, services, plugins (shot 06).
- "Services and tools" heading, "Connectors" (App settings), "MCP servers" (CLAUDE.md, dialogs, run cards: "Approve mcp servers proposal"), "Custom servers", "Custom servers you added", "services" in the inspector. Seven nouns for roughly two things.
- "Agents" in project settings is permissions and behaviour (permission mode, saved rules, worktrees; shot not kept), not the roles. That blocks "Agents" as a tab name.
- Severity: Medium. Fix: one vocabulary: keep "Tools" for the built-in permissions only, call the rest "Connections" (a service your agents reach) and "Skills" (how-to instructions), and drop "MCP" from user-facing text except in advanced detail.

### F8. Medium: inspector layout scatters the capability sections and buries them

- Order: Identity, Model, Tools, Services, Delegation, Skills, Instructions. Services and Skills are separated by Delegation, Skills is a collapsed disclosure in a different heading style (small, with "· 1 of 1"), and Services has a button while Skills has none.
- At 1600x1000 Services starts 798 px down a 1416 px scroll and Skills at 1002 px. At 1024x640 the first screen shows only Identity and Model (shot 34), so it takes about two scroll screens to even see that capabilities exist.
- The role node on the canvas shows "6 tools", "leads 3", the model; nothing about services or skills (shot 03, 17). So the org chart gives no overview of who can do what.
- Severity: Medium. Fix: group "What this role can use" as one block with Tools, Connections, Skills together, and show a compact capability count on the node.

### F9. Medium: empty and hand-off states point the user elsewhere instead of letting them act

- Inspector Services empty: "No services yet. Connect and grant them in project Settings > Tools." plus "Manage in Tools" (shot 04). The inspector Skills empty: "No skills in this project yet. Add them in Project settings > Tools." with no button at all.
- Tools Services empty state: "You connect services like Slack or Gmail once, in App settings > Connectors. Then you choose here which roles..." and then an "Add a service" button that actually opens a gallery that does the connecting (shot 06, 09). The copy contradicts the button. Two identical "Add a service" buttons are on screen at once (header and empty state).
- Severity: Medium. Fix: inline Add buttons in the role's capability block; one primary action per region.

### F10. Medium: first-run AI cost and setup gates are invisible until you hit them

- "Evaluate skills" (primary-looking toolbar button) on a project with "Suggest new skills" off returns "Model-assisted suggestions are off. Turn them on in the skill settings." and "No problems found." (shot 32). The switch that gates it is above the button, in a card titled Evaluation. A user who clicks Evaluate expecting suggestions gets a deterministic lint.
- The assistant dialogs do say "Runs an assistant on your plan. Counts toward your usage. Runs on Deep tier. Change in App settings > Defaults." This is good; keep it, but it is repeated per entry point.
- Severity: Medium.

### F11. Medium: connect flow has real friction that a recommendation must warn about

- GitHub needs a personal access token and a link to create one ("A fine-grained token with read access to the repositories agents should see. Create one", shot 10). "Not yet tested with OrgAI" sits under the Official badge. Clear and honest, but a recommender will push users into this; show the cost ("needs a token, 2 minutes") before the click.
- The access-level choice is well worded: "Read-only · Can read", "Full access · Can read and change". Reuse it.
- Severity: Medium (planning input, not a defect).

### F12. Low: smaller inconsistencies seen on the way

- Sidebar brand lockup in mock mode: "MOCK" and "Dev" pills crowd the wordmark, which renders as a clipped "(" at 1600x1000 (shot 03). Mock-only noise but it hid the product name.
- Two names for the same AI: "Describe it to an assistant" (project Tools) vs "Configure with AI" (App settings) vs "MCP assistant" (node) vs "Architect".
- The tray approval card is cramped: the proposal, command, pinned badge and "Who can use it" scroll inside a fixed region (shot 23 shows the end state; mid-state not kept).
- The org chart footer hint "Drag from a node's bottom handle..." wraps to two lines at 1024 and eats canvas height.
- Skills settings row "Roles: Reviewer" vs services "Can use: Reviewer": same meaning, two phrasings.
- Project created from the form lands directly on Org chart (good).

### What works and should be kept

- The service gallery cards are plain-language, show category and "Official", and the connect dialog explains Read-only vs Full access in plain words.
- The proposal card for MCP installs shows what trust needs: "Pinned", "From the registry: io.github.mock/fs-server@1.0.0", the exact command, "Runs code on this machine", "Who can use it", and "Approving saves these MCP servers to the project. Secrets are entered separately and stored encrypted." Registry text is labelled untrusted. This is the right trust pattern.
- The skill role picker states the consequence: "Until you choose roles, no agent loads it." / "1 role will be able to load it."
- Import agents / skills never write until confirmed: "Nothing is written until you import. Your files are not changed."

## Naming

The tab must cover roles (the chart), what each role can use (built-in tools, connections, skills) and how the team is designed (the Architect). Note the constraints: "Agents" is already the project-settings pane for permissions and behaviour; "Tools" is overloaded; "Live" and "History" are verbs/time words, so a plain noun fits.

| Candidate | Rationale | Risk |
| --- | --- | --- |
| **Team** (pick) | Short, plain, a noun a non-expert gets: "who is on my team, what each can do". Covers chart plus capabilities, and "Team" scales to "Add a role to the team". Does not clash with an existing label. | "Team" can read as human collaborators. Mitigate with the subtitle "Roles, tools and skills". |
| Crew | Warm, fits "roles with tools". | Quirky, weaker for a professional harness, lower search/recognition value. |
| Setup | Matches the Architect's word ("set up with the Architect") and AI-guided setup. | Verb-ish, suggests one-time, and clashes with the existing "setup" run kind and "Skip AI setup". Also hides the org chart. |
| Workforce | Accurate, covers everything. | Corporate jargon, long, and implies headcount not capability. |
| Org | Short, ties to OrgAI and the existing chart. | Tells nothing new, brand-name overlap, does not say tools or skills. Org chart as one view inside Team is still good. |
| Agents (rejected) | Intuitive. | Already means permissions/behaviour in project settings, and an "agent" in Live means a running instance, not a role. |

Ranked pick: 1. Team, 2. Crew, 3. Setup. Keep "Org chart" as the name of the canvas view inside Team, so the old term remains findable.

## Proposed layout for the Team tab

Principles from the rules: nothing floats over the canvas, side panel and tray regions, container queries, one primary action per region, lucide icons, tokens only.

```
+--------------------------------------------------------------------------------------+
| Demo  fixture  | Live  History  Team  Settings                                       |
+------------------------------------------------------+-------------------------------+
| TOOLBAR: [Add role] [Auto-layout]  [Import...v]      |  SIDE PANEL: segmented        |
|          [Export to repo]  (one primary: Add role)   |  [ Role ] [ Catalog ]         |
+------------------------------------------------------+                               |
| CANVAS (React Flow)                                  |  Role tab (default when a     |
|   role nodes with capability counts:                 |  role is selected):           |
|   Reviewer  sonnet  3 tools  1 connection  1 skill   |   Identity, Model (folded)    |
|                                                      |   What it can use             |
|                                                      |    Tools   chips + edit       |
|                                                      |    Connections  chips +       |
|                                                      |      access level, + Add      |
|                                                      |    Skills  chips + + Add      |
|                                                      |   Delegation, Instructions    |
|                                                      |   (folded below)              |
|                                                      |                               |
|                                                      |  Catalog tab (no selection    |
|                                                      |  or on demand): everything    |
|                                                      |  attached to the project,     |
|                                                      |  grouped by capability, with  |
|                                                      |  "Used by" roles              |
+------------------------------------------------------+-------------------------------+
| TRAY (under canvas, docks beside at >= 1500 x 560, as the Live tray does):           |
|  Team assistant: [ Recommend tools and skills for this team ]  [ Ask... ______ ]     |
|  Proposals as cards: "Give Reviewer: GitHub (read-only), code-review skill"          |
|  Sources, pinned versions, Approve / Request changes                                 |
+--------------------------------------------------------------------------------------+
| FOOTER hint (single line, collapses under 700 px)                                    |
+--------------------------------------------------------------------------------------+
```

Region rules:

- Canvas: roles and delegation only. Nodes show a compact capability line (counts), never a popover. A role with an attached connection or skill shows a quiet icon-plus-count; an AI-proposed but unapproved item shows as a dashed count in the tray, not on the node.
- Side panel, Role tab: the existing inspector, but with one "What it can use" block (Tools, Connections, Skills together) placed straight after Identity, Model and Instructions folded or moved below. Connections and skills are both editable in place (fixes F1). Each has its own "+ Add" that opens the same chooser, pre-scoped to this role.
- Side panel, Catalog tab: project-level view: skills, connections, plugins, each with "Used by" role chips and an on/off switch, which replaces the capability-first lists in Settings > Tools. Selecting a role from "Used by" selects it on the canvas.
- Tray: the AI assistant. It does not share a slot with the inspector (fixes F3), has role context ("for Reviewer" chip when a role is selected, "for the team" when none), and renders proposals as cards using the existing `DecisionCard` shell. Below 480 px frame height the tray goes compact exactly as the Live tray does.
- One primary action per region: toolbar Add role; side panel "+ Add" per section (secondary within the panel, primary only on the empty state); tray primary is "Recommend tools and skills for this team" (empty tray) or Approve (when a proposal is open).
- Container queries: panel switches to the segmented Role/Catalog at < 480 px panel width; at >= 480 px (the existing wide threshold) it can show Role and Catalog stacked. Do not add a floating drawer.

### What stays in Settings and what moves

| Item | Where it ends up | Why |
| --- | --- | --- |
| Per-role grants of connections and skills | Moves to Team (role panel) | Role-first task; the user's stated need |
| Catalog of attached skills, connections, plugins ("Used by", on/off, remove) | Moves to Team > Catalog | Same task from the other direction, in one place |
| Add a connection (gallery), Add skill (new, library, import), registry browse, assistant | Moves to Team; launched from "+ Add" and the assistant | Discovery should happen where the role is |
| Connect and sign in to a service (tokens, OAuth, Manage, Disconnect) | Stays in App settings > Connectors (app-wide) | Credentials are per user, not per project; the connect dialog already works |
| Skill library (app-wide) | Stays in App settings > Skill library | Shared across projects; reduce its prominence in the add flow |
| Model prices, Connection, Limits, Permissions ("Agents"), Maintenance | Stays in Project settings | Not team-shaping |
| Skill evaluation settings (switch, token budget) | Stays in Project settings as "Skills" or under a "Suggestions" row; result surfaces in the assistant tray | Budget is configuration; the suggestions are assistant output |
| Plugins | Stays in Settings (advanced) with a link from Catalog | Rare, runs code, not role-first |
| Project settings > Tools | Becomes a small stub pointing to Team (or is removed) | Avoid two homes for one noun |

## What the assistant should do first

First run for a new user (empty team or default team, no connections): one button in the tray, "Recommend tools and skills for this team". It runs a read-only scan, then proposes. It must not start an interview.

1. Read local evidence, all read-only and listed back to the user in a "What I looked at" row: the repo (`.mcp.json`, `.claude/skills`, `.agents/skills`, `.github/skills`, `.opencode/skills`, language and tooling files, remote URL, CI config), the role descriptions and prompts, the user's already-connected services, and the skill library.
2. Match by role, not by project. Example output for the Reviewer: "GitHub (read-only): you have a GitHub remote and this role reads pull requests", "code-review skill: found in `.claude/skills` in this repo", "Linear (read-only)? Not recommended: no Linear references found."
3. Search outside only on request or after a visible choice: the community registry (already labelled unverified) and any curated list. Local sources first, outside sources second, each result stamped with its source.
4. Show what is missing, not just what is added: "Implementer has Edit and Bash but no test skill."
5. Present proposals per role as approval cards (Approve all, Approve each, Request changes), with a diff view of what changes on each role.

### Making recommendations trustworthy

- Source on every row: "From this repo: `.claude/skills/code-review`", "Curated: Official GitHub connector", "Community registry: unverified". Reuse the existing Official / Preview / unverified badges.
- Evidence line: why it was suggested ("GitHub remote found, Reviewer reads pull requests").
- Pinned versions and the exact command for anything that runs code ("Pinned", "npx -y mock-fs-server@1.0.0", "Runs code on this machine"), as the install card already does. No unpinned installs.
- Access level on every proposal, defaulting to read-only and to the roles named, never "every role" (fixes F6). Show it as a plain sentence: "Reviewer can read repositories, issues and pull requests."
- Approval before any write, with a diff and a one-step Undo (as Agent import does).
- Cost and model named once, inline: "Runs on Deep tier, about N tokens" with a link to the setting, as today; and a "no AI" path for every step (manual Add stays).
- Treat registry and repo text as untrusted data in the UI (the current "Treat it as untrusted" note), and never auto-install.
- Skills drafted by the AI show their full text before create; "elevated" hints (scripts) stay visible.
- Cannot-do honesty: when no source matches, say so and offer "New skill" or "Ask the assistant to draft one", not an empty library.

## Spec-level notes for the Product Designer

- The org chart's canvas has no capability vocabulary; adding a count line to `RoleNode` needs a design pass at the 220 px node width.
- Decide whether Catalog is a second side-panel tab or a canvas view mode. The side-panel tab keeps nothing floating.
- A shared "add to role" chooser (gallery, library, repo, registry, AI) is the central new component; reuse `ConnectorDialog`, the skill role picker and `DecisionCard`.
- Assistant runs need to stay in the Team tab. Today they surface as a Live run (R1) with a wrong "Replying to Orchestrator" composer; the Live view is not the place for a one-shot proposal.
- The Settings > Tools stub and the shell's "Needs you" counts (a pending assistant proposal is a decision) need consistent handling.

## Screenshots

`ux-review-team-tab-shots/` (all dark unless noted): 03 org chart with Architect panel; 04 and 17 and 18 role inspector (Services, Skills); 05 skills section; 06 and 07 Settings > Tools; 09 to 12 service connect and role grant; 13 empty library; 14 import skills; 15 and 16 new skill; 19 Other ways to add; 20, 21, 23 assistant dialog and run; 26 to 29 App settings connectors, skill library, Configure with AI; 30 and 31 work run and Org retrospective; 32 Evaluate skills; 33 to 37 org chart at 1024x640 (Architect panel, quick draft, Import agents); 38 and 39 light theme at 1024x640.
