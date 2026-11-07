# Proposal cards in work runs (MCP servers, skills, org chart)

Status: agreed 2026-11-02. Source: `docs/design/ux-review-proposals-in-runs.md` (walked on 7967ec8). Extends
`spec.md` 12.1 (decision cards and tray) and 12.3 (org chart diff). Proposal kinds covered: `mcpServers`, `skills`,
`orgChart`, when they sit in a work run's tray beside permission, question and install cards. Setup runs keep their
current behaviour except where a rule says "every proposal".

Rules that do not change: nothing floats over the canvas; the tray is a `CanvasFrame` grid area; one primary action
(Approve) per card; token colours only, both themes; `DecisionCard` is the shell for every kind.

## 1. Card anatomy

| Region | Content |
| --- | --- |
| Header | Kind chip, proposer, run, title |
| Summary | One line under the title (`decision-summary`), ellipsis, full text in its `title` |
| Body | Kind body (sections 4 to 6), own scroll, scroll cue |
| Footer | Approve (primary), Request changes, then the second-pass Not now (section 7) |

- Kind chip and every kind label come from `PROPOSAL_KIND_LABEL` (`lib/decisionTitle.ts`). The label keeps its case.
- Title: "Approve MCP servers proposal", "Approve skills proposal", "Approve org chart proposal". "MCP" is never
  lower-cased.
- Summary line examples: "add github-issues, link mock-fs, change access to notes, remove old-fs" (MCP),
  "add release-notes, change who loads review-checklist" (skills), "add Reviewer, change Implementer" (org chart).
  Server and skill names as written; roles by name.
- Proposer: outside setup, the proposing agent's avatar (role colour, from `agentId`) and name, like the question and
  install cards. Setup keeps "The Architect".
- Request changes placeholder: "What should change? <who> revises and proposes again." where <who> is
  "The Architect" (setup), "The assistant" (MCP and Skill assistant runs) or "The orchestrator" (work runs).

## 2. Kind everywhere

The same prefix in the Needs-you popover rows and the tray stepper chips:

- "MCP servers: <title>"
- "Skills: <title>"
- "Org chart: <title>"

<title> is the proposal's own title. Owners: `lib/needsYou.ts` (item label) and the chip label in
`views/LiveRunView.tsx`. The location line ("Project / R1: ...") is unchanged.

## 3. Tray sizing

### Compact frame (frame under 480 px high, `section.frame-tray[data-compact=true]`)

Folded (default on arrival): kind chip, proposer, run, title, summary line, footer. No body.

Expanded (Details pressed):

- The tray takes the frame in flow. The stage row collapses to 0; the canvas stays mounted (no remount, no refit
  loop) and nothing is drawn over it.
- The card body is at least 200 px high.
- The tray stepper ("1 of 3", Previous / Next, chips) stays visible.
- The composer folds to one line.
- Collapsing (Details again, resolving the card, or stepping to a non-proposal card) restores the stage, the composer
  and the earlier tray height.

Check: at 1024x640 with Details open, the first server, skill or role row is visible without scrolling.

### Roomy frames (480 px high or more)

- While a proposal is the shown card, the tray may grow to about 60 % of the frame height. Other kinds keep their
  current limits.
- A body that can scroll shows a scroll cue: a token shadow at the bottom edge (and the top edge once scrolled). No
  cue when the content fits.

## 4. MCP servers body

Top: summary line (`proposal-summary`), for example "1 new, 1 linked, 1 access change, 1 changed, 1 removal; 2 servers
unchanged". Zero counts are left out. Unchanged servers sit in a disclosure ("2 servers unchanged") after the rows.

Rows (`mcp-proposal-server[data-server][data-change]`), grouped in this order:

| Group | `data-change` | Badge (tone) | Lines |
| --- | --- | --- | --- |
| New | `new` | New (success) | Name, transport, command or URL with Copy, Pinned, "Runs code on this machine" for stdio, "Who can use it: Orchestrator, Implementer", secrets named |
| Link | `link` | From library (info) | "Link <name> from your library", the library entry's command or URL with Copy, "Who can use it: ..." |
| Access | `access` | Changed (warning) | "Who can use it: Reviewer (was Orchestrator, Implementer)" |
| Update | `update` | Changed (warning) | Changed fields, then "Who can use it: ..." with "(was ...)" when roles change |

Removals (`mcp-proposal-removal[data-server]`), after the groups above:

- Badge Remove (danger).
- "Remove mock-fs from this project"
- "Implementer can no longer use it." (the roles that had it; omitted when none did)
- Linked server: "The library entry stays."
- The name comes from the project's servers (library scope: the library). Never an internal id.

Rules:

- Role names, never slugs. Unknown slug: show it as written.
- "Pinned" only on new definitions, never on a link, access or update row.
- A link shows its command or URL with Copy, the same code block as a new server.
- Access wording: "Who can use it" on every MCP row and card. Skills say "Who loads it".
- A server already in the project is never shown as Link. Matching is by server id, then library id.

## 5. Skills body

Top: summary line (`proposal-summary`), for example "1 new, 1 linked, 1 access change, 1 removed; 3 skills unchanged",
unchanged skills in a disclosure. Groups in order New, Link, Access, Update, Remove. Items are
`proposal-skill-item[data-skill][data-action]`, `data-action` one of `create`, `link`, `grant`, `update`, `remove`.

| Action | Badge (tone) | Line 1 | Line 2 | Extra |
| --- | --- | --- | --- | --- |
| create | New (success) | `release-notes` + scope badge | "Who loads it: Orchestrator, Implementer" | Show instructions |
| link | From library (info) | "Use `review-checklist` from your library in this project" | "Who loads it: Reviewer" | "Kept in sync with the library; edit it there." Show instructions |
| grant | Access (warning) | "Change who loads `review-checklist`" | "Adds: Reviewer. Removes: Implementer. Keeps: Orchestrator." | "Instructions unchanged." No instructions body |
| update | Changed (warning) | `mock-skill`, "instructions changed" | "Who loads it: Researcher (was Orchestrator)" | Show changes (before and after) |
| remove | Remove (danger) | "Remove `release-notes` from this project" | "Orchestrator and Implementer will no longer load it." | Linked: "Unlinks it; the library entry stays." No instructions body |

Role names, never slugs. An update with unchanged roles shows "Who loads it: ..." without "(was ...)".

## 6. Org chart body

As `spec.md` 12.3, with one change: a role's model shows the tier name ("Fast", "Everyday", "Deep", "Top") when the
role's model is a tier, not the vendor alias. "reports to Orchestrator · Fast", "model Everyday -> Deep". A concrete
model id is shown as written.

Prompts (review M3, so a work-run orchestrator cannot rewrite a role's instructions unseen): a Changed or Renamed row
whose prompt changed keeps its "prompt changed" line and adds a "Show new prompt" disclosure (`org-diff-prompt`) with
the whole new text; an Added row shows its prompt behind "Show prompt" the same way. The text is untrusted: plain text
through `ClampText` (hidden characters escaped by `showHidden`, clamped at 4 lines with Show more), with the
"Contains hidden characters" badge inside the disclosure (`org-diff-prompt-hidden`) and on the row itself, visible
without opening anything (`org-diff-hidden` on a Changed row). Role names, field values and tools go through
`showHidden` too. Rows are `org-diff-row[data-change=added|changed][data-role]`. The diff helper carries both texts as
`ChangedRole.prompt` (`lib/orgDiff.ts` `promptChange`). Responsibilities go into the system prompt too, so a changed
list (compared in order) is a "responsibilities changed" line with a "Show new responsibilities" disclosure
(`org-diff-responsibilities`, items through `showHidden`, counted in the row's hidden-characters badge;
`responsibilitiesChange`), and a tier change the model line does not already show reads "tier Deep -> Everyday". A read error in an MCP or skills body is said once through the
frame's announcer (`tray-announce`, `useFrameAnnounce`); the line itself is a live region only outside a canvas frame.

## 7. Second pass (contract pending)

Slots are prepared in this pass and not wired until the runtime contract lands. Do not ship them visible before then.

- Not now (`proposal-decline`): a quiet button (ghost, never primary, never danger) after Request changes on every
  non-setup `mcpServers`, `skills` and `orgChart` card. One click sends a fixed decline text owned by the Runtime Lead.
  No confirm, no textarea.
- Effect line (`proposal-effect`): helper text above the footer, `--text-small`, `--text-secondary`. One of:
  - "Takes effect after the orchestrator's current turn. Reports already running keep what they have." (MCP and skills
    in a work run)
  - "Applies to future runs. This run keeps its roles." (org chart in a work run)
  - "Takes effect now." (assistant and setup runs)
  The after-approve run-meta notice uses the same words.
- Secret fields (`mcp-proposal-secret[data-secret]`): optional password inputs on New and Update MCP rows, one per
  secret slot, labelled by the secret name. Values go out only with the decision; they are never shown, echoed in the
  summary, the transcript or the notice. Empty is allowed.
- After approve (H4): when a saved server still has an empty secret, the run-meta notice reads
  "<server> needs <SECRET> before it can start. Set it", and "Set it" opens that secret's field in one click.

## 8. Keyboard, focus and live regions

Tab order inside a card: Details (folded compact card only), kind body controls in reading order (Copy, Show
instructions, disclosures, second-pass secret fields), Approve, Request changes, Not now (second pass).

- First focus on arrival, or when Enter on a Needs-you row lands on the card: Details when the card is folded
  (`focusDetails`), else the first body control or Approve when the body has none. A proposal card never lands focus on
  Approve while its body is hidden.
- Expanding keeps focus on Details; collapsing keeps it there too.
- The stepper chips keep their roving focus; arrow keys move between chips.
- On resolve, focus returns to the composer (12.1, M15).
- The tray keeps `role="region"`, `aria-label="Decisions"`, `aria-live="polite"`. The summary line is read with the
  card title; no extra live region per card.
- PageUp / PageDown scroll the body once focus is inside it.

## 9. Selectors

| Test id | Where |
| --- | --- |
| `decision-summary` | Summary line under the title (every proposal card) |
| `proposal-summary` | Counts line at the top of the MCP and skills body |
| `mcp-proposal-server[data-server][data-change]` | One MCP row; `data-change` new / link / access / update |
| `mcp-proposal-removal[data-server]` | One MCP removal row; `data-server` is the server name |
| `proposal-skill-item[data-skill][data-action]` | One skills row |
| `proposal-decline` | Not now (second pass) |
| `proposal-effect` | Effect line (second pass) |
| `mcp-proposal-secret[data-secret]` | Secret input on an MCP row (second pass) |

Existing ids stay: `mcp-proposal-command`, `section.frame-tray[data-compact=true]`.

## 10. e2e impact

- Text matches on "Approve mcp servers proposal" or "Proposal: ..." in Needs-you and chips change to the forms in
  sections 1 and 2. Update selectors in the same change (`e2e/assistants.mjs`, `runs.mjs`, `team.mjs`).
- Compact checks: at 1024x640 the first Tab stop on a proposal card is Details; with Details open the first
  `mcp-proposal-server` or `proposal-skill-item` is in view and the canvas element is still in the DOM.
- Removal check: `mcp-proposal-removal[data-server=mock-fs]` and no text matching `mcp_`.

## 11. Finding map

| Finding | Pass | Section |
| --- | --- | --- |
| H1 approved blind at 1024x640 | This pass | 1, 3, 8 |
| H2 removal shows internal id | This pass | 4 |
| H3 access change reads as Link | This pass | 4 |
| H4 promised secrets never asked for | Second pass | 7 |
| H5 no way to say no | Second pass | 7 |
| M1 no timing on the card | Second pass | 7 |
| M2 kind missing, "mcp" lower-case | This pass | 1, 2 |
| M3 roles as slugs | This pass | 4, 5 |
| M4 Request changes names the Architect | This pass | 1 |
| M5 no proposer outside setup | This pass | 1 |
| M6 skill update hides what changes | This pass | 5 |
| M7 scrolling with no cue at 1600x1000 | This pass | 3, 4, 5 |
| L1 Pinned on a link | This pass | 4 |
| L2 link without its command | This pass | 4 |
| L3 three access vocabularies | This pass | 4, 5 |
| L4 vendor alias in the org chart diff | This pass | 6 |

## 12. Fix: long proposals (2026-11-07)

Report: an org chart proposal with many changes could not be scrolled to its end, and Approve / Request changes / Not now
sat in the middle of the list.

- Cause: the Team tab's Architect tray (`team.css`, `.architect-decisions .decision-body`) sets `overflow: visible` and
  `max-height: none` on card bodies so they scroll with the tray, but `.decision-card.kind-proposal .decision-body` in
  `cards.css` is more specific and kept its `max-height: min(55cqh, 480px)`. A proposal body was therefore capped and
  overflowing visibly: the list ran on under the footer and over the tray, and the body never scrolled. The Live tray was
  not affected (its body keeps `overflow: auto`); checked with a 29-change proposal in every Live state (compact folded and
  expanded, roomy stacked, docked beside the stage, conversation layout, every disclosure open).
- Fix: the proposal body rule carries `overflow: auto` beside its cap (and so does the compact expanded rule), so a proposal
  body is always the one scroller with the footer after it, wherever the card is mounted. While a proposal body overflows,
  `DecisionCard` gives it one Tab stop (`tabindex=0`, `role=group`, "<Kind> details, scrollable", `data-scrolls`) with a
  2 px inset `:focus-visible` ring, so the keyboard can scroll a list that has no controls of its own.
- Checked by `e2e/proposals.mjs` scenario 4 (29 changes, a work run in the Live tray and an Architect session in the Team
  tab, 1024x640 and 1600x1000, dark and light): the body is its own scroller, scrolls to its end, the last block ends inside
  it, the footer sits below it, the page does not scroll, Tab reaches the body with a ring.
- Open: in the Team tab at 1024x640 the Architect tray (about 210 px) is shorter than the proposal card, so the tray
  scrolls to reach the footer (focus moves to Approve at arrival, which should scroll it into view; not asserted). Making the card fill that tray needs
  `team.css` / `TeamView` changes (a flex chain down to the card, a larger tray share), outside this fix.
