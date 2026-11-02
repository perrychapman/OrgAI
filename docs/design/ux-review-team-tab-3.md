# UX review: the Team tab, third walk (per-role tools)

Walked on commit 090d334 (branch worktree-agent-aed5289c6f1fa7940, built here with `npm run build`; it contains 5ff6fdf, 11f896c, 2bcde10, 0ea97df, 4ee1c50 and 65e6a2b). `ORGAI_MOCK=1`, fresh temp `ORGAI_DATA_DIR`, two mock projects (Demo, Demo2) made with the Architect unticked. Driven with playwright-core (scratch scripts in the gitignored `e2e/shots/ux3/`, a launcher of its own because `lib.mjs` `launch()` waits for a form). Screenshots: `ux-review-team-tab-3-shots/` (63 files, cited below by number). Sizes 1024x640 and 1600x1000, dark and light, plus one keyboard-only pass. No smoke scripts, no token-spending e2e, no code edited.

Limits: the mock recommender answers instantly (no progress state seen). The Settings > Agents "Team review" group was read from source, not walked. The native folder picker was not driven. Mock quirk: the Architect's org chart proposal replaces all four default roles, so Demo2 ended with Lead and Engineer.

## Verdict

Big step forward. The scenario "Reviewer gets GitHub and a code-review skill" now works end to end from the tray in 4 clicks to "granted" (node, Recommend, Apply, Apply), the skill half finally exists, the Role tab shows "What it can use" without scrolling at 1024x640, the Architect's permission card lives in the tray with the Needs-you pill, and Recommend results land in view. What still stops a first-time user: (1) the Role tab's own "Sign in" button drops you at the top of a 38-tile gallery (the deep link was only wired for the tray), and the way back lands on Live, not Team; (2) the "+ Add" choosers are still a chain of up to four dialogs that forget which role you started from, and the skill chooser cannot reach the local `~/.claude/skills` skill; (3) Dismiss gives no feedback, and AI results do not survive a reload.

## Walk-2 findings 1 to 12

| # | Walk-2 finding | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Design mode stalls on permission cards | Fixed | Start puts the permission card in the tray with focus on "Allow once" (041, 044). The topbar "Needs you . 1" pill switches the tray from Recommend to Design and focuses the card (042). Card label is "Architect / Architect session", no "R?" (checked in text). All five cards answered in the tray: permission, architecture, org chart, run settings, MCP servers (044-048); the chart updated under me (049). Leftovers: N8. |
| 2 | Recommend looks like nothing happened at 1024x640 | Fixed | Results head "3 to review for Reviewer" is focused and in view; first card and its Apply fit at 1024x640 (004). One scroller only (tray). Leftovers: N8, N12 (gap count in the head). |
| 3 | Finish setup / Sign in go to the wrong place | Partly | Tray "Sign in" (curated GitHub) lands on the Connectors tile: scrolled to it, focus on "Finish setup for GitHub", live region "Showing GitHub" (013); Enter opens the token dialog (014). Registry server: "Add GITHUB_TOKEN" opens the edit form with the secret field focused (060, 061). NOT fixed: the Role tab's "Sign in" button (finding N1). Back to Team is not offered (N1). |
| 4 | Results lost on tab switch, Re-check wipes, dismissals return | Partly | Tab switch keeps the list (History and back: same cards). A dismissed card stays gone after Re-check and a fresh Recommend (code-review, mock-fs). Re-check merges (kept the held list). Reload loses AI Recommend results (031: empty tray, "after reload []"); Re-check then brings back the free finds. No "Dismissed (n)" list to restore from (N4). |
| 5 | "What it can use" below the fold | Fixed | Role pane starts at the block: heading at y=252, "Add a connection" y=460, "Add a skill" y=583 of 641 (003). Identity and Model fold behind one-line summaries. Colour swatches are one Tab stop (radio, "Color #22c58b"). Tab stops from the Team tab: 27 to "Add a connection", 29 to "Add a skill" (same count as walk 2, now because the panel follows the chart and tray in DOM order: N10). |
| 6 | Proactive path and skill half never delivered | Mostly fixed | After 2 mock runs (stopped with End session) the tab reads "Team 12", tray says "12 suggestions waiting" (039). The local `code-review` skill is recommended (004) and applies to Reviewer, node line updates (006, 007). Still open: no "On this computer" tab in the skill chooser (N2); the line says "12 suggestions waiting", not "since your last run". |
| 7 | Connection chooser is a three-dialog chain | Open | Same chain, now four dialogs, role not pre-ticked (020-022; N3). |
| 8 | Dismiss and Apply feedback | Partly | Apply: one visible row ("Applied code-review to Reviewer", focus on Undo), no duplicate page-level line (006). Dismiss: no row, no Undo, live region still reads the old "Found 3 recommendations and 1 gap." (030; N4). |
| 9 | Team review on by default and hidden | Partly | Settings > Agents now has a "Team review" group with an explanatory sentence and select Off / Free checks / AI review (source read, AgentsSection.tsx). Default is still AI review; the tray still has no pointer to it. Not walked live. |
| 10 | Catalog duplicates and contradicts | Partly | Fixed: no more "Custom servers you added: None yet" next to "Only in this project github-tools" (063 text). Open: "Evaluate skills" and "Suggestions from past runs" still inside Skills; header description wraps to 4 to 5 lines beside the primary "Add a connection" at 1600 (053); every role chip is shown twice per row ("Used by Reviewer" and "Roles: Reviewer" / "Can use: Reviewer") (053). "Available to agents" still only in Catalog (N11). |
| 11 | Wording | Mostly fixed | The "Pinned" ghost button is gone (scope is a plain "For" select); Design copy now says "in the tray"; no "R?". Open: "Describe it to an assistant" still in the Add a service dialog (AddServiceDialog.tsx:166, McpSection.tsx:323); "Team review" in Settings; "Ask the Architect" on gaps vs "Ask the Team assistant"; the curated card header still prints the docs URL (008, 053). |
| 12 | Keyboard and layout details | Partly | Fixed: swatches one stop; the outside-sources checkbox is below the buttons now; Role tab roving (Role tabindex -1 while Catalog is selected, arrows reach it). Open: chooser opens with focus on "Close dialog" (016, probe), ArrowRight in the chooser tab strip does nothing (N7). |

## Scenario: Reviewer gets GitHub and a code-review skill

Clicks counted as walk 2 did (node click included; typing a token is not a click).

| Route | Steps | Clicks | Ends |
| --- | --- | --- | --- |
| (a) Assistant, granted | node; Recommend; Apply code-review; Apply GitHub (006, 009) | 4 | Reviewer has the skill and GitHub ("Needs sign in" badge on the row). Walk 2 never got the skill. |
| (a) Assistant, working | then tray "Sign in" (lands on the highlighted tile, 013); Enter; paste token; Add token (014) | 7 + paste | GitHub works. |
| (a) Back to Team | sidebar project; Team tab | 9 | Returning lands on Live, not Team (015). |
| (a') Role-row "Sign in" instead of the tray's | click Sign in on the GitHub row (009) | 5 | Top of the gallery, no highlight, no focus, tile 1500 px down (010). N1. |
| (b) Role tab, GitHub, first time | node; Add; Browse tab; "Browse connections"; GitHub; paste; Add token; tick Reviewer; Use in this project (016-022) | 8 + paste | 4 stacked dialogs; Reviewer not pre-ticked (022). |
| (b) Role tab, GitHub, already connected | node; Add; GitHub (023, 024) | 3 | Granted to Reviewer only, "Can read". |
| (b) Role tab, skill | node; Add a skill; tabs This project / Your library / Found in this repo / New skill (016) | n/a | The local `code-review` skill is not reachable here. "This project" says "Every skill in this project is already on this role" in a project with no skills. N2. |

## Tools group, access, canvas line (flow 3)

- Edit tools in place works: Edit toggles a checkbox grid with focus on "Done editing tools"; Edit, Write, Bash, NotebookEdit carry an amber warning triangle (026). Summary line reads "Read, Glob, Grep + 2" while open and after "Done" (027). Saved to the role (Read, Glob, Grep, Bash, Edit); the topbar SaveIndicator shows the check and "Saved 09:05 AM".
- Node line updates: aria-label "Reviewer, role. 5 tools, 1 connection. ...", visible "5 . 1" (icons) at 1024, "3 . 1 . 1" with the skill. The spec words ("3 tools . 1 connection . 2 skills") appear only in the aria-label.
- Connection row: name, "Can read", remove X. There is no access select (spec asked for one): access is a property of the server, fixed when added; the dialog says "To switch it, remove the service and add it again" (014). N13.
- Removal from the row works, focus returns to "Add a connection to Reviewer", and Catalog "Used by" agrees ("no role yet", "Can use: No roles") (063 text).
- The collapsed summary does not say which of the "+ 2" are elevated (see N9).

## What improved

- Role pane leads with the block; Identity and Model fold. Colour swatches are a single Tab stop.
- Recommend: focus goes to the results head, "Found N" is announced, first card and Apply are visible at 1024x640, one scroller. After a run the tab shows a count and the tray says how many are waiting; the primary button turns outline while results are pending, so Apply is the loud one.
- Apply: focus on Undo, one visible row, honest "It stays off until you sign in", "Can't undo after a later change" on stale rows.
- Design mode is real: the permission card, then four proposal cards, all in the tray, the Needs-you pill brings you to it, no run tab appears on Live.
- Registry secret: "Add GITHUB_TOKEN" goes straight to the field. Curated: tray "Sign in" goes to the highlighted tile with a live-region announce.
- Catalog no longer contradicts itself on custom servers; Pinned button gone.
- Light theme: chips (Curated, MCP Registry amber, "Runs code on this machine" red), cards and the amber "Needs sign in" badge are legible (054, 058, 059).

## New findings, ranked

### High

**N1. Role-row "Sign in" ignores the connector deep link, and there is no way back to Team.** Flow 2(a'), shots 009, 010, 011, 015.
- Cause: `src/renderer/src/components/connectors/RoleServices.tsx` `signIn` only calls `requestAppSettingsSection(mcpLibrary)` + `setView('appSettings')`. Only `components/team/openConnectorSetup.ts` (used by the tray) calls `requestConnector`. Result: gallery top, tile at 1512 px, `data-highlight` never set, focus on the "Connectors" nav.
- Also: a custom server missing its secret (github-tools) shows "Custom connection (paused in this project)" with no badge or button (060), while the curated one shows "Needs sign in + Sign in". And after Escape from the dialog or the gallery, the sidebar project click lands on **Live**, not Team (015); App settings has no "Back to Team".
- Expected: the row button opens the same place as the tray (tile or edit form), whichever kind of server; leaving returns to the Team tab and the role.
- Fix: have `RoleServices` call `openConnectorSetup(info.connectorId, info.libraryId)` (pass the spec's connector id; for a non-connector server open its edit form with the secret field focused, as the tray does); add the needs-sign-in badge and button for any granted server with unset secret slots (`needsSignIn` in `lib/roleCapabilities.ts`); remember the origin (`view` + project tab + selected role) and show a "Back to Team" link at the top of App settings when the deep link came from Team, or restore the Team tab on return. Check: click Sign in on the GitHub row, the GitHub tile is in view with `data-highlight` and focus on its action; Escape then one click returns to Team with Reviewer selected.

### Medium

**N2. The skill chooser cannot reach the local skill, and its empty state lies.** Flow 2(b), shot 016.
- Tabs: This project, Your library, Found in this repo, New skill. `~/.claude/skills/code-review` (seeded by `mockHome.ts`, found by discovery, offered by the tray) is in none. "This project" in a project with zero skills says "Every skill in this project is already on this role. Try Your library or New skill." and "Your library" says "Nothing new in your skill library."
- Owner: `components/team/CapabilityChooser.tsx` (skill tabs) and the capabilities discovery (`capabilities:discover` already returns local items).
- Fix: add an "On this computer" tab fed by the same discovery items (apply through `capabilities:apply` so the digest binding holds); empty copy by cause: "This project has no skills yet" vs "All of them are on this role". Check: Add a skill on Reviewer lists code-review under "On this computer" and one click grants it.

**N3. The connection chooser still chains four dialogs and forgets the role.** Flow 2(b), shots 017-022.
- Add a connection -> chooser (opens on an empty "Your connections") -> Browse tab -> "Browse connections" opens "Add a service" -> GitHub opens "Add GitHub with a token" -> "Use GitHub in this project" with **no role ticked** although the chooser said "Only this role gets what you add". Agents get no access until you tick; "Use in this project" is disabled until then.
- Owner: `CapabilityChooser.tsx`, `AddServiceDialog.tsx`, the project-use dialog behind `connector-connect`.
- Fix: open on Browse when "Your connections" is empty; make Browse list the gallery inline (or open the service picker directly, closing the chooser); pass the role through so "Use GitHub in this project" opens with that role ticked (and "All roles" off). Check: first-time GitHub for Reviewer is node, Add, GitHub, token, Add token (5 clicks, 2 dialogs) and Reviewer is granted.

**N4. Dismiss is silent; AI results are lost on reload; no dismissed list.** Flow 4, shots 030, 031.
- Dismiss removes the card, the tray scroll jumps so the heading scrolls out of view (030), the live region still says "Found 3 recommendations and 1 gap." (after Undo it says "Undone." and keeps saying it after a dismiss), no Undo. Focus does go to the next Apply, which is good.
- Reload: the AI Recommend list is gone ("5ff6fdf ... results persist per project" holds for tab switches, not reload). Re-check brings back the free ones only.
- Owner: `TeamAssistantTray.tsx` (announce, dismiss), the persistence in `store/` and `capabilities:` review.
- Fix: on Dismiss show the one-row "Dismissed X. Undo" (8 s) in the list position, announce it, keep scroll; persist the last recommend result with the review (`capabilities` held result) and restore on mount; add a "Dismissed (n)" disclosure with Restore. Check: Dismiss -> announce text names the item; reload -> same cards.

**N5. Recommendations the role already has.** Flow 4, shot 033 and p11 text.
- In Demo2, Reviewer already holds GitHub (granted, token saved), yet Recommend for Reviewer offers "Reviewer can read through GitHub" again (also after Dismiss and re-run). The code-review skill is correctly dropped once granted, so this is the connection path.
- Owner: `src/main/capabilities/` recommend filter (mock `mock.ts`/recommend fallback may be the cause; check the real filter excludes grants for connectors, matching `libraryId`/`connectorId`).
- Fix: exclude candidates whose named roles all already have the item; show "Already has" instead of Apply when partial. Check: after granting GitHub to Reviewer, Recommend for Reviewer does not list GitHub.

**N6. Proactive list is unranked and the badge disagrees with the scope.** Flow 5, shots 039, 054.
- 12 suggestions at once (code-review, GitLab, mock-fs, DeepWiki, GitHub, Cloudflare, Box, PostHog, Sentry, Linear, Google Docs, Figma) from a keyword fallback, most of them unrelated curated services; "Team 12" badge, "12 suggestions waiting" and "12 to review for the whole team" say it three times. With the Reviewer scope the head says "3 to review" while the tab still says 11.
- Fix: cap the proactive list to the top 3 with "Show all 12", say it once, order skill matches first, and keep the tab badge consistent with the list (say "11 waiting for the whole team" when scoped). Also use the spec wording "since your last run" in the line (`data-testid=team-since` currently reads "12 suggestions waiting").

**N7. Chooser keyboard.** Flow 9.
- Initial focus is "Close dialog" (016); ArrowRight/ArrowDown do nothing (tab strip is plain buttons: role=tab without the arrow handler). Escape returns focus to "+ Add" (good).
- Owner: `CapabilityChooser.tsx`. Fix: initial focus on the selected tab (or first item); add the roving arrow handler used by the Team panel tabs; Home/End. Check: open, press ArrowRight, selected tab changes.

### Low

**N8. Tray layout.** Shots 004, 039, 046, 049.
- At 1024x640 the open tray leaves the chart about 215 px and the chart is not refit when the tray grows, so the Reviewer node is cut in half (004, 006); a fit view fixes it (059).
- At 1600x1000 the cards are one full-width column (about 970 px of line) and one fills the screen; two columns would show 4 at a time.
- Design: the "Revise with the Architect" form stays above the decision card, so at 1024 the card's header scrolls off (041); the org chart proposal card has a nested scroller (046); after the session "The Architect session ended." sits in a big empty box under the form (049).
- Fix: refit on tray open/close (`TeamView`/chart `fitView` after `data-phase` change); cards in a two column grid from 900 px tray width (`team.css`); collapse the Revise form to one line while a session is running.

**N9. The Tools summary hides risk.** Shots 026, 027. "Read, Glob, Grep + 2" does not say the 2 are Edit and Bash; the node shows only "5". Fix: list elevated tools by name and warning colour ("Read, Glob, Grep + Bash, Edit") in `RoleCapabilities.tsx`; node line gets the amber marker when Bash/Edit/Write is on.

**N10. Tab order to the block.** 27 Tab stops from the Team tab to "Add a connection": toolbar 4, 3 edge stops, 4 nodes, zoom 3, tray 7, then the panel. Fix: edges `tabIndex=-1`, and a "Skip to role panel" link or move the panel before the tray in DOM order.

**N11. Catalog.** Shot 053. Header wrap at 1600 (Skills 94 px, Connections 76 px headers), duplicate "Used by" plus "Roles:" chips, three primary buttons (Add a skill, Add a connection, Apply) when results are open, "Evaluate skills" row, "Available to agents" only here (not on the Role row, so a paused custom connection cannot be turned on from where you see it is paused).

**N12. Gap count and result head.** "Found 2 recommendations and 1 gap" only lives in the live region now; the visible head says "2 to review" and the gaps are at the bottom. Add "and 1 gap" to the head with a jump link.

**N13. No access select on the connection row.** Spec says Can read / Can read and change in place; the product fixes access at add time per server. Either update `team-tab.md` or add the select to `RoleServices.tsx` (writes the server's read-only variant).

**N14. Copy.** "Describe it to an assistant" (AddServiceDialog.tsx:166, McpSection.tsx:323) -> "Ask the Team assistant"; Settings "Team review" -> "Team assistant: review"; gap action "Ask the Architect" is fine but unlike the chooser link; card header prints a documentation URL as the source (use "Curated" + the vendor name).

## Keyboard and a11y summary

- Passed: Identity open adds one swatch stop; Role tab roving; Recommend by Enter moves focus to the results head; Apply focuses Undo; Undo focuses Recommend (not the restored card); Dismiss focuses the next Apply; Escape from a chooser returns to "+ Add"; Needs-you pill focuses the Architect card.
- Failed: N7 (chooser focus and arrows), N4 (announce text after Dismiss), N10 (27 stops), N1 (deep link).

## Both themes

Light (shots 054, 055, 058, 059): card borders, source chips, red "Runs code" and amber "Needs sign in" chips read well; the grey "Reaches a remote service" flag chip in light has no border and is the weakest (still above 4.5:1 text on white by eye, not measured). No horizontal scroll at either size or theme (measured, scrollWidth equals clientWidth).

## Suggested order of work

1. N1 (one-line wiring plus a Back to Team; unblocks the whole "finish" step).
2. N3 and N2 together in `CapabilityChooser.tsx` (Browse first when empty, pre-ticked role, "On this computer" tab, correct empty copy), then N7 keyboard in the same file.
3. N4 (dismiss feedback, reload persistence, dismissed list) and N5 (no re-offers).
4. N6 (cap and rank proactive list, consistent counts, "since your last run").
5. N8, N9, N10 (layout, risk in summary, tab order).
6. N11 to N14 (catalog tidy, copy).

## Files written

- `docs/design/ux-review-team-tab-3.md`
- `docs/design/ux-review-team-tab-3-shots/` (63 PNGs, 001 to 063)
- Scratch scripts (gitignored, not committed): `e2e/shots/ux3/*.mjs`
