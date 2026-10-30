# UX review: connecting outside services (MCP today), pre-feature audit

Method: built app, `ORGAI_MOCK=1`, fresh temp `ORGAI_DATA_DIR`, project "Acme Support". Windows 1280x800 (dark) and 1680x1050 (light). Persona: knows Slack and Gmail, not MCP, stdio, transports or OAuth client ids. No tokens spent. I did NOT press Test on any server (it contacts third-party hosts), so the OAuth Authorize/Reauthorize and "authorized" states were read from code (`McpAuth.tsx`, `TestResultPanel.tsx`, `service.ts`), not seen live. The registry search did hit the real public MCP registry.
Screenshots (outside the repo): `C:\Users\chapp\AppData\Local\Temp\ux-shots\` (referenced as `shots/NN`).

## Task outcomes

| Task | Result |
| --- | --- |
| 1. Agents read my Slack | Not achievable by a non-technical user. Registry offers third-party Smithery servers that need a Bearer token from Smithery. Dead end. |
| 2. Connect my Gmail | Same. Results are individual publishers' servers (faithk7, sebastianall1977, waystation). No Google sign-in appears. |
| 3. Which projects/roles can use a service | Per project only, and only after opening Settings > Tools and expanding "Roles: 2 of 4". Library row says "Not used by any project" or nothing. No reverse view. |
| 4. Is it working, how to disconnect | No persistent status. "Secrets: 0 of 1 set" is the only signal; Disconnect is spread across "Unlink..." (project) and "Remove from library..." (app). |

## Findings, ranked by user impact

### 1. Critical: nothing a non-technical user can recognise as "Slack" or "Gmail"
- Where: App settings > MCP library > Add from registry (`shots/12-registry-slack`, `13-registry-gmail`).
- Expected: a tile for Slack, Gmail, Drive, Notion, GitHub, Linear with a logo and "Connect".
- Saw: an empty library, then a developer search box with chips `filesystem github fetch memory playwright`. Search "slack" returns `ai.smithery/smithery-ai-slack`, `ai.waystation/slack`, "Slack MCP by InsightfulPipe". The names are namespaced slugs and the publishers are anonymous. There is no official/verified marker, and "gmail" returns hobbyist servers. A user is being asked to hand mail access to a stranger with no trust cue. The only badges are `http`, `sse`, `Pinned`, which describe versions, not trustworthiness.
- Fix: a curated Connectors gallery (known first-party/official servers, logo, one-line purpose, "what agents can do: read channels, send messages"), with the raw registry demoted to "Advanced: browse community servers" and labelled unverified publishers.

### 2. Critical: the connect step asks for a credential the user cannot obtain
- Where: registry pick > config form (`shots/15-registry-config`).
- Saw: "Authorization (required)", "Bearer token for Smithery authentication", an amber "Authorization is required and not set. You can add the server now and set it later." Add server is enabled, so the user adds a server that cannot work. No link to where a token comes from.
- Expected: a "Connect Slack" button that opens a browser sign-in.
- Fix: gallery entries carry their own auth method. OAuth entries get one Connect button. Token entries get step-by-step "where to get this" text and a link, and Connect stays disabled until the token is valid (test on save).

### 3. High: OAuth "Authorize" is hidden until you press Test
- Where: library row for a remote OAuth server such as Notion (`shots/24-notion-added`).
- Saw: a plain row, "You" badge, "Not used by any project", a Test button. No "Not authorized" chip and no Authorize button; the auth chip renders nothing for `notRequired`, and the server only learns it needs OAuth from a 401 during Test. Code confirms Authorize is offered from the Test result panel.
- Expected: "Needs sign-in" with a Connect button right on the row.
- Fix: probe on add (or ship the auth method in the gallery) and show the state immediately.

### 4. High: vocabulary is protocol-first
- "MCP library", "MCP servers", "Transport stdio / http / sse (legacy)", "Command", "Arguments (one per line)", "Environment variables", "Headers", "Pinned", "Registry version 1.0.0", "Remote server", "client ID", "OAuth app", "Tools appear to agents as mcp__name__tool", "Runs code on this machine with your permissions".
- Inconsistent: the app calls it "MCP library" but the project calls it Tools > "MCP servers" and "Tools your agents can call"; the role editor has a separate "Tools" list (Read, Bash...) that has nothing to do with it. Agents/roles can use a "tool" in three different senses.
- Badge "You" (`shots/24`) means "added by you" and reads as nothing. "Registry", "Library", "Remote server" are all same-weight chips.
- Fix: user words (Connections / Connectors, Connect, Disconnect, "Allowed for", "Needs sign-in"). Keep protocol terms in an Advanced custom connector form.

### 5. High: four ways to add, in two places, with no explained difference
- Project Settings > Tools has Add from library / Add from registry / Add manually / Configure with AI (`shots/31`), and the app library has three of the same. A first-timer cannot tell what "library" is (a per-app list that is empty on first run). In an empty project the primary button is "Add from library", which leads to an empty list.
- The empty state says "Add one from your library to get started" when the library is itself empty. Dead end.
- Fix: one "Add connection" entry that opens the gallery (browse, link, custom, ask AI as tabs or sections). If the library is empty, skip it.

### 5b. High: no status anywhere a user would look
- Library row shows only "Secrets: 0 of 1 set" and an amber left stripe (`shots/17`). Colour stripe is not explained. Test result is not remembered on the row. A project that has a not-authorized server only gets a warning (`McpAuthNotice`) at run start ("agents will not be able to use it. You can still start the run.").
- Live view and run composer show no connected services at all (`shots/35`); the user starting a run cannot see what agents can reach.
- Fix: a status chip on every row (Connected as x / Needs sign-in / Token missing / Failed: reason, last checked), shown also in the project's Tools list and a compact "Connected: Slack, Gmail" line near the run composer.

### 6. High: per-role grants are opt-in but hidden, and invisible from the org chart
- Link dialog "Who can use it?" starts with nothing ticked and a disabled "Add to project" with a hint (`shots/33`). Reasonable default for safety, but "All roles" has no explanation and a disabled button with no reason beside it.
- After linking, the row says "Roles: 2 of 4" with a chevron. Expanding it names roles (`shots/36`), but the summary never names them, and Orchestrator is not granted (an orchestrator that cannot fetch is surprising).
- Org chart role cards show "3 tools" and the role editor (double-click or Enter) has no connections section at all. Question 3 cannot be answered from where a user thinks about roles. (`shots/38`, `39`).
- Fix: show "Slack, Notion" chips on role cards and a "Connections" section in the role editor (same RoleAccess control); name the roles in the summary ("Reviewer, Researcher").

### 7. Medium: layout bug, server name wraps one letter per line
- Where: Project Settings > Tools, link row with the roles panel expanded at 1280 (`shots/36`, `37`): "n o t i o n" stacked vertically. At 1680 (`shots/34`) fine. Needs a min-width or wrapping fix on the row title.

### 8. Medium: disconnect is not discoverable and is two different concepts
- Library row: Remove from library... (hidden under the ... menu together with Edit). Project row: Unlink... and Open in library. Removing a connection from the library also affects every linked project, and "Not used by any project" is the only counter.
- No "Disconnect" for OAuth accounts or "Revoke access" explanation. A user wanting "stop agents reading my Slack" sees an enable toggle (project row) and does not know whether that toggle disconnects or pauses.
- Fix: per connection, one "Disconnect" with a consequence line ("Removes sign-in on this computer; 2 projects lose access"), and the project toggle labelled "Available to agents".

### 9. Medium: "Configure with AI" promises more than it explains
- Dialog (`shots/40`): "An assistant run proposes library servers in its own window. You approve each one there." plus an empty textarea; "Runs on Opus. Change in App settings > Defaults". Good idea for a non-technical user, but it is the last button, and costs tokens without a cost cue.
- Fix: surface as "Not listed? Describe the service" inside the gallery with a token/cost note.

### 10. Medium: security messaging is generic
- "Secrets are stored encrypted on this machine and are never shown again" is good. Missing: what the agent can do with the connection (read-only vs send), and which data leaves. "Connects to a remote server that receives what the agent sends it." is accurate but frightening and unexplained. Per-service permission summaries would help.

### 11. Low
- Add manually dialog opens with Name focused and "Save first to test": a user must save to learn it works. Test before save.
- Registry dialog gives one empty state text; search takes 3-4 s with a skeleton, fine. Rate of unrelated results not filtered.
- Library page copy "Define a server once; any project can link it." is the sole explanation of the library concept.
- Nothing in the project topbar, Live view or New project flow mentions connecting services; the gear icon is the only entry (and it is not labelled).

## What exists and is worth reusing for a Connectors gallery
- `RegistryDialog` (listbox with keyboard nav, skeleton, retry, "add manually" escape hatch): reuse as the "community / advanced" tab.
- `McpServerForm` + `TestResultPanel`: keep as "Custom connector (advanced)".
- `McpAuth` `AuthChip` (icon + words, expiry, account `as ...`) and `AuthorizeControl` (Authorize / Reauthorize / Try again, waiting-for-browser with cancel, client-id fallback): the right status and connect primitives, just surface them on every row and from the gallery tile instead of after Test.
- `RoleAccess` (All roles + per-role checkboxes) and `McpLinkDialog` ("Who can use it?"): reuse in the gallery's connect step and in the role editor.
- `McpAuthNotice` (run-start warning with Authorize buttons) and `McpInstallCard` (agent-requested install approval in the live run): the in-run recovery path already exists; link them from the gallery status.
- `McpAssistDialog`: "describe what agents should do" as the long-tail path.
- `SettingRow`, `Badge`, `Banner`, `ConfirmDialog` for consistent tiles and remove confirmations.
- Library vs project-link model (`libraryId` snapshots; secrets and tokens held once): keep it as the data model. It gives "connect once, grant per project/role".

## Spec-level questions for the Product Designer
1. One list vs two (library and project tools): recommend a single Connections surface with a per-project "Allowed in this project / for these roles" grant.
2. Default grant: none vs orchestrator vs all, and how it is explained.
3. Trust: curated vs community listing, publisher verification, read-only vs write capability labels.
4. Where the status lives: row chips plus a run-composer summary.
