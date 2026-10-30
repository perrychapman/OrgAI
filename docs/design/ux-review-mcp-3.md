# UX walkthrough 3: MCP library and authorization (partial)

Goal: "my agents use GitHub and a Postgres server". Build: this worktree, ORGAI_MOCK=1, fresh temp ORGAI_DATA_DIR, dark theme, about 1264x761 content area (window set to 1280x800). One setup run at 1024x640. Screenshots (outside the repo): C:/Users/chapp/AppData/Local/Temp/uxr3-shots/ (numbers cited below). Driver scripts: C:/Users/chapp/AppData/Local/Temp/uxr3/.

## Coverage (honest)

Walked live: App settings MCP library (add manually http and stdio, secret save, Test on a real remote URL, row menu, remove confirm, Configure with AI, proposal, approve, "MCP library assistant" window and Back to MCP library, registry dialog opening); project MCP section (Add from library with role picking, From your library and Only in this project groups, Test, linked and local row menus, promote, Configure with AI proposal); setup run with the "Suggested tools" proposal, Skip, completion (1024x640).
NOT reached: light theme, 1024x640 for the library and project pages (a script was written, not run), keyboard-only pass, Duplicate/Edit/Unlink results, project AI proposal approval result, New run page auth notice, live registry search, install card. OAuth states cannot be reached on mock; judged from code.

## Findings

### High

1. **The "not authorized" warnings never show for a server nobody has tried to authorize.** Repro: library or project, add github (http), Test: the panel says "Needs authorization" with an Authorize button, but the row itself keeps no chip, and neither the section banner (`mcp-auth-warning`) nor the New run notice appears (shots 11, 28). Cause (code): `authStatusFrom` returns `notRequired` until `spec.oauth` exists, and `oauth` is only saved when Authorize runs (service.ts `saveOAuth`). AuthChip renders nothing for `notRequired`. Expected: a freshly added remote server that needs sign-in is flagged on the row, in the section and before a run. Fix: persist the "auth challenge seen" result from Test (or probe on add) so the state becomes `notAuthorized`; until then show "Sign-in not checked" on remote rows.
2. **Project AI proposal and setup proposal cards are clipped at 1024x640 and 1280x800.** Repro: project Configure with AI, or setup at 1024x640. The card's body gets a ~100px inner scroll area, the title truncates ("MCP ser...") and Approve sits below content the user has not seen (shots 34, 60-setup-5). Expected: read everything approved. Fix: let the tray grow to content up to a max height, or give the body priority over the transcript pane; keep Approve below a visible "n more items" cue.
3. **Library-scope proposal copy is project-scope.** Repro: library Configure with AI, mock proposes mock-fs. Card says "Approving saves these MCP servers to the project" and "Who can use it: Every role" although it only adds to the library (shot 17). Fix: library wording ("Adds mock-fs to your MCP library. Projects choose it separately") and drop the role line.
4. **Setup "Suggested tools" shows "Who can use it: architect".** The Architect is not a project role; after setup the link grants a role that will not exist (shot 60-setup-5). Fix: in setup mode pick the project's real roles (for example the root) or none and say so.

### Medium

5. **A library or project row with a missing secret has no status chip in the library list.** Postgres shows "Secrets: 0 of 1 set" as a quiet link plus an amber edge (shot 9). The project row does better ("Secrets not set in the library: DATABASE_URL. Open in library"). Fix: copy that warning to the library row with a "Set DATABASE_URL" button.
6. **The Test result duplicates itself and is transient.** "Needs authorization" appears as chip and again as the banner title (shot 11); leaving the page loses it. Fix: one heading, and persist the last result on the row.
7. **Test on an http server contacts the real URL in mock mode** (github test reached api.githubcopilot.com). Say "contacts the server" on the Test button tooltip or in the form's "Save first to test" hint.
8. **Link dialog is single-select.** Getting GitHub and Postgres takes two passes through the dialog; the roles list resets each time (shots 23, 24). Fix: checkboxes with per-server role pickers, or a clear "Add another" after confirm. Positive: no roles are preselected and the hint "Choose at least one role" is shown.
9. **Role default is inconsistent.** Library links start with no roles (least privilege); Add manually in a project creates "Roles: 4 of 4" (shot 27). Same for the project AI proposal for mock-fs ("Every role"). Fix: one default, none selected.
10. **Promote ("Add to library") is instant, with no confirmation or notice.** The row moves groups and "Only in this project" is left showing "No project-only servers." (shot 31). Fix: a confirm that names the effect (other projects can now use it; secrets move), and hide the empty group.
11. **Assist run banner never clears.** After approving in the library assistant, the banner "An assistant run is configuring your library. Open run" stays while the session idles (shot 19). The new row appeared, so the user cannot tell it finished. Fix: "Assistant finished: mock-fs added" with Dismiss, or hide when the run is idle.
12. **Sidebar attention item for the library run reads "Project · Run R3".** It is not a project run (shot 17). Fix: label "MCP library assistant".
13. **Settings nav naming mismatch.** Nav item "MCP and plugins" versus heading "MCP servers" (project settings). Minor, rename one.

### Low

14. Skip in setup is recorded in the transcript as "REVISE. The user asked for changes" (harness wording shown to the user under Show output).
15. The project proposal re-offers "Link github from your library" although github is already linked (mock behavior; check the real assistant does not do this).
16. Library row menu opens inline and pushes rows down (shot 12); consider a popover or keep Edit visible.
17. "Not used by any project" has no "Use in a project" action (carried over from review 2). "You" badge still unexplained.

## Verified fixed since reviews 1 and 2

- MCP library has its own Settings nav entry and sits inside the page nav.
- Ticking Secret keeps the typed value (pending secret); http form now explains the Authorization header and OAuth.
- Library row shows "Used by n projects" (expandable); remove confirm names the projects ("Notes API will lose this server...").
- Back to MCP library button and window title "MCP library assistant" work; approved mock-fs appears in the library with a Registry badge.
- Setup: Suggested tools proposal reads in plain language, Skip exists and setup completes.

## OAuth (judged from code, McpAuth.tsx)

Chips (Not authorized, Authorized as X, Expired, Authorization failed) and Authorize/Reauthorize/Try again are well written; the pre-registered client ID path disables Authorize until a client ID is typed with only a paragraph above as explanation. Finding 1 is the blocker: the states are unreachable until the user has already clicked Authorize.

## Install card (code only)

Not reached; see review 1 items 10 and the e2e shots under e2e/shots/ux (05-mcpinstall-card-*) for the scope radio.

## Top 5 fixes for the UI Lead

1. Make a never-authorized remote server read "Not authorized" on the row, section banner and New run notice (finding 1).
2. Stop clipping decision cards in the docked tray (finding 2).
3. Correct proposal copy and role line for library scope and setup scope (findings 3, 4).
4. One least-privilege role default everywhere, and multi-select in the link dialog (8, 9).
5. Surface missing secrets and last test result as persistent row state in the library (5, 6).
