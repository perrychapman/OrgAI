# UX review: Connectors, second pass (built feature)

Method: built app of worktree agent-a5dfa4a32c2c33dbc, `ORGAI_MOCK=1`, fresh temp `ORGAI_DATA_DIR`, project "Acme Support" (roles Orchestrator, Implementer, Reviewer, Researcher). Mostly 1024x640 dark, plus 1600x1000 light for the gallery, the Slack dialog and the project Tools page, 1024x640 light for the empty states, and a keyboard-only pass over the gallery (Tab order, Enter, Escape, focus return). Persona: knows Slack and Gmail, not MCP or OAuth. No tokens, no network, no smoke scripts; sign-in, token save and Check connection are mock answers, so real browser hand-off, the Slack http-redirect risk and real error text were NOT seen.
Screenshots (outside the repo): `C:\Users\chapp\AppData\Local\Temp\ux-shots2\` (referenced as `shots/NN`).

## Task outcomes

| Task | Result |
| --- | --- |
| 1. Find and connect Notion | Pass. App settings > Connectors (the gear is the only entry; tab named clearly), tile, Connect, "Connected as ..." (`shots/02`, `03`, `05`). 3 clicks. |
| 2. Connect Slack (client id/secret) | Completes, but the user must leave the app and do developer-console work. Steps are listed, redirect address is copyable; wording and focus problems below (`shots/07`, `08`). |
| 3. Token service (GitHub) | Pass with friction: Connect button is below the fold at 640 high, jargon bullet, "Create one" link gives no scope guidance (`shots/10`). |
| 4. Reviewer, not the others | Pass. Project Settings > Tools > "Use in this project" > tick Reviewer. Row then reads "Can use: Reviewer" (`shots/15`, `16`). |
| 5. Check it works | Partial. "Check connection" lists actions ("Working. Agents can use 3 actions", `shots/06`) but only inside the App-settings dialog. Project row, Live view and composer show only a "Connected" chip. |
| 6. Stop agents using it, then remove | Pass. Toggle "Available to agents" (copy: "Paused in this project. Still connected."), Unlink with a consequence sentence, then Remove with a named-project sentence (`shots/24`, `27`, `30`). |
| 7. Which roles can use what | Partial. Per role: yes, inspector "Services" block (`shots/21`), but it sits below Tools, a long scroll away. Per service: yes, "Can use: Reviewer". Org chart cards show nothing. |

## Resolved since `ux-review-connectors.md`

- #1 (nothing recognisable as Slack or Gmail): resolved. Gallery of named tiles with category, one-line purpose, Official badge, search (`shots/02`).
- #2 (credential the user cannot obtain): mostly resolved. OAuth is one Connect button; token and client-id services get numbered "Before you connect" steps with links; Connect stays disabled with a sentence naming the missing field.
- #3 (Authorize hidden until Test): resolved. State chip on every tile and row (Not connected / Connected as ... / Needs setup).
- #4 (protocol vocabulary): mostly resolved in the Connectors surface ("Connect", "Disconnect", "Available to agents", "Can use: ..."). Remnants below (N3, N4, N7).
- #5 (four ways to add): resolved. One "Add a service", others behind "Other ways to add"; connecting from there chains straight into "Who can use it?" (`shots/36`, `37`); an empty library no longer dead-ends (`shots/46`).
- #5b (no status): partly resolved. Status chips exist everywhere in settings; still nothing in Live or the composer (N5).
- #6 (role grants hidden): partly resolved. Roles are named in the row summary and "All roles" has a clear disabled-reason sentence; role inspector now shows services; org chart cards do not (N6).
- #7 (name wraps one letter per line): resolved, name is fine at 1024 and 1600 (`shots/14`, `33`).
- #8 (disconnect not discoverable, two concepts): resolved. Disconnect, Remove, Pause and Unlink are each explained in a one-line sentence next to the control (`shots/05`).
- #9 (Configure with AI): resolved. Now "Describe it to an assistant" inside the add flow.
- #10 (security messaging): resolved for access level (Read-only vs Full access on GitHub and Linear, plain sentence on others). Technical caveats still leak in (N3).
- #11 (nothing in New project or Live mentions services): still open (N5).

## New findings, ranked by user impact

### N1. High: "Authorize slack" does nothing
- Flow: 6 (after Disconnect), Project Settings > Tools. Screenshot `shots/42`, `43`.
- Step: disconnect a client-id service (Slack) that is linked to a project. The Tools page shows a legacy amber banner "slack is not authorized / Agents will not be able to use it until you sign in" with an "Authorize slack" button. Clicking it shows no dialog, no busy state and no error (tested twice, no alert or live region). The row beside it says "Finish setup", which does work (opens the Slack dialog, `shots/44`).
- Expected: the banner button leads to the same place as Finish setup, or the banner does not exist.
- Also: the banner duplicates the row's own chip, uses the raw lowercase id "slack", and the words disagree ("not authorized" / "Needs setup" / "Authorize" / "Finish setup"); the banner vanishes only after the service is removed (`shots/45`).
- Fix: make the banner action open the connector dialog (or hide the legacy banner for catalogue services), use the display name, and use one verb ("Finish setup").

### N2. High: the Slack dialog opens scrolled to the Client ID field, hiding the safety text
- Flow: 2. Screenshot `shots/07` vs `shots/08`.
- Step: opening Slack at 1024x640 auto-focuses Client ID and scrolls so the header, "Can read and change" notice and the Slack HTTPS-redirect warning are off-screen above; the user starts at "Before you connect" step 1. At 1024x640 the whole form needs a scroll in any case.
- Expected: dialog opens at the top; focus goes to the title or the first step, not the input.
- Fix: focus the dialog heading (or the first link), keep the input focus for after the user starts typing. Same applies to GitHub (`shots/10`: Connect button is under the fold, with no sticky footer action; Close is the only footer button).

### N3. High: caveats and a risk that decides success are phrased for engineers and sit as bullets above the form
- Flow: 2 and 3. Screenshot `shots/08`, `10`.
- Saw, verbatim: "Slack documents that redirect URLs must use HTTPS, so it may refuse OrgAI's http loopback redirect. Unverified."; "Unverified: the token response shape of oauth.v2.user.access and which scopes the server expects"; "Unverified: dynamic client registration with a loopback redirect." (Notion); "stored with Electron safeStorage and sent as Authorization: Bearer"; "Only the read tools (X-MCP-Readonly header)". They also remain on the Connected dialog (`shots/09`) after it worked.
- Impact: the persona cannot tell whether Slack will work. The one sentence that matters (this may fail, here is the fallback) is buried between jargon. The five-step Slack setup also says "the user scopes the MCP server needs" without naming any.
- Fix: one plain "May not work yet: Slack may reject OrgAI's sign-in address. If sign-in fails, ..." line; move engineering notes behind a "Technical details" disclosure; hide caveats once connected; name the scopes or link to the exact page.

### N4. Medium: "Connections" and "Connectors" are adjacent tabs with near-identical names
- Flow: 1. Screenshot `shots/02` (left tab list), content of Connections tab: "Where agents get their models" (Anthropic, OpenAI).
- A first-timer looking for Slack can land in the model-provider page. Fix: rename the older one "AI providers" (or "Model providers") and keep "Connectors" for services. This is a spec-level naming call (to Product Designer).

### N5. Medium: nowhere at run time shows what agents can reach
- Flow: 5. Screenshot `shots/23` (Live empty state, composer).
- Searching the Live view for service names returns nothing. Carried over from #5b and #11. Fix: a compact "Services: GitHub (Reviewer)" line next to the composer with a link to Tools; also the only "check it works" action is in App settings, so add Check connection to the row's "..." menu.

### N6. Medium: org chart cards and the inspector layout hide service access
- Flow: 7. Screenshots `shots/19`, `20`, `21`.
- The Reviewer card says "3 tools" and nothing about GitHub. In the inspector (1024x640) Services is the 4th section below Identity, Model and Tools, reachable only by scrolling (`shots/20` shows no trace of it). It is read-only with "Manage in Tools"; to change who can use a service the user leaves the org chart.
- Fix: a small service chip on role cards (or "+1 service"), move Services above Delegation or give it a section anchor, and later allow toggling per role in place.

### N7. Medium: Disconnect on a client-id service throws away setup
- Flow: 6. Screenshot `shots/41`, `42`.
- After Disconnect the tile and row say "Needs setup" and the dialog is back to an empty Client ID / Client secret form (secrets are not kept). "Disconnect signs out but keeps the service here" suggests an easy reconnect, but the user must re-enter both. Also the state name "Needs setup" is wrong for something the user deliberately disconnected: use "Disconnected" or "Signed out", and the "Available to agents" switch still shows ON beside it.
- Fix: say it in the Disconnect confirmation ("You will need the client secret again"), and relabel the state.

### N8. Medium: GitHub's access level cannot be changed after connecting
- Flow: 3. Screenshot text on `shots/11`: "Access is set when the service is added. To switch it, remove the service and add it again."
- The honest wording is good, but the workaround throws away the saved token. Fix: allow switching level while connected (it is a header/scope choice), or at least keep the token form prefilled-by-"saved" on re-add.

### N9. Low: after Connect in App settings there is no next step
- Flow: 1. Screenshot `shots/05`. "Used by: no project yet. Add it from a project's Tools settings." is text only. The project-side path (Add a service) chains correctly, but the App-settings path ends. Fix: a "Use in a project" button (project picker, then the role dialog).

### N10. Low: small items
- Empty Tools state has two identical "Add a service" buttons (header and card) (`shots/46`).
- "Preview" and "Not yet tested with OrgAI" badges are undefined (what does Preview change for me?); "Official" is clear.
- Row "..." holds "Open in Connectors" and "Unlink..." only; "Unlink" is a third verb next to Disconnect and Remove. The confirmation sentence explains it well, but a hint under the "..." (tooltip) is missing.
- Gallery column is capped near 720 px; at 1600x1000 half the page is blank (`shots/31`). Fine, not harmful.
- Slack dialog "Authorize" in step 4 versus a button labelled "Connect".
- Keyboard-only: Tab order through the gallery is sensible (Manage/Connect buttons carry the service name, e.g. "Connect Gmail"), Enter opens the dialog with focus inside, Escape closes and focus returns to the tile button (`shots/38`). Not tested: role checkboxes by keyboard in the Use dialog.

## Worked well

- Consequence sentences in every destructive confirmation: "Reviewer will lose GitHub right away. The service stays connected in App settings." / "Acme Support will lose access." (`shots/27`, `40`).
- Default-closed grant with a stated reason: "Choose at least one role, or All roles. Agents get no access until you do." (`shots/15`).
- "Available to agents: Off pauses it in this project only." then "Paused in this project. Still connected." (`shots/16`, `24`).
- Connected services sort to the top of the gallery with the account name on the tile (`shots/12`).
- Light and dark themes both read well; no horizontal scroll at 1024.

## Spec-level notes for the Product Designer
1. Rename the older "Connections" settings tab (N4).
2. Decide the home for per-role service access: inspector toggles, org chart chips, or both (N6).
3. Decide a single state vocabulary: Not connected / Connected / Needs setup / Signed out, and which one applies after a deliberate Disconnect (N1, N7).
