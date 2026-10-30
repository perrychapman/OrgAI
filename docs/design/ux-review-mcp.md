# UX review: MCP (code walkthrough)

Method and limit: the worktree has no node_modules and the sandbox refused the junction needed to build, so I did not drive the app and took no screenshots at 1280x800 or 1024x700. This is a read-through of the components as a first-time user, for the goal "my agents use GitHub and a Postgres server". Layout and visual claims are untested. Verify the Medium and Low items on a built mock run.

Mock reachability: the mock `mcp-assist` script (mock.ts DEFAULT_MCP_ASSIST) lists servers, searches the registry for "filesystem" and proposes a ProposalCard for `mock-fs`. The mock work script never calls `request_mcp_install`, so McpInstallCard was judged from code only.

## Findings

### Critical

1. **No proper way to use GitHub's hosted server (OAuth).** Repro: Add manually, http, `https://api.githubcopilot.com/mcp/`; the only option is a secret header you must mint yourself. Expected: "Connect GitHub" and a browser sign-in. Fix: see the OAuth section below. Until then, tell the user in the form that a personal access token goes in `Authorization: Bearer ...` and link how to make one. Today the form gives no hint of the header name or value format.

### High

2. **Postgres is a dead end for non-experts.** Repro: Add from registry, search "postgres". The user picks a package, then supplies a connection string in an env var. Nothing says that string contains a password, that it should be a dev or read-only database, or that the agent can run arbitrary SQL. Fix: a "What this can do" line on the registry detail and the form (read/write, network, filesystem), and mark secret-looking variables as Secret by default.
3. **Secrets are the most fragile step.** In the add form a secret value is held in memory until Add server, then written in a second call. If that fails the dialog says "server was saved, but some secrets were not", leaving a row marked "not set". An AI-proposed server arrives unusable because the proposal card says "Secrets are entered separately": the user must find Settings, MCP, row, Edit. Fix: after approving a proposal, deep-link to the server and open its missing-secret prompt; make "needs a secret" a primary row action ("Set GITHUB_TOKEN"), not only a warning tint.
4. **Test is optional and gated behind a save.** The form footer says "Save first to test." A server can be enabled and granted to every role with a wrong command, and the user learns only when an agent fails mid-run. Fix: auto-run Test after Add server and keep a persistent state on the row ("Never tested", "Connected, 3 tools", "Failed"), not a transient panel.
5. **Run-time failure has no path back to settings.** If a server fails or a secret is missing during a run, nothing in the run view (from the code read) links to the server's row. Fix: a run-level notice "github failed to connect" with a button that opens that project's MCP section with the row focused.

### Medium

6. **Three equal-looking entry points.** "Add from registry" (primary), "Add manually", "Configure with AI". The AI route is the best for a novice but is third. The empty state ("ask an assistant") is vague. Fix: when the list is empty, offer "I know what I want / Help me choose".
7. **AI assist leaves the page.** Start assistant run closes the dialog; the only trace is a banner with Open run. The user must approve in the run view and then find their way back. Fix: a "Back to settings" in that run and a notice on completion linking to the new rows.
8. **Role access defaults to all roles.** A Postgres server is granted to every role, including ones that should never touch the database. Fix: ask "Who can use this?" in the add flow, preselecting only the lead role for sensitive servers (database, shell, filesystem).
9. **ProposalCard for mcpServers is dense.** It renders mono lines (`roles: every role`, `secrets to set after approving: ...`). A novice cannot tell what approving does beyond "saves". Fix: plain sentences, a "Runs code on this machine" or "Connects to remote host X" line, and the Pinned or "Version not pinned" badges the registry dialog already uses.
10. **Install card is clear but context-poor** (code only, not reachable on mock). Title, Why, exact command, secrets and scope are good. Gaps: the default scope is "this run", so the same card returns next run; the scope choice is not explained. Fix: one sentence per scope and a labelled "Always allow for this project". Add a mock step so this can be tested.
11. **Transport jargon.** "stdio / http / sse" with no explanation. Fix: "Local program (stdio)", "Remote URL (http)", SSE under "Legacy".
12. **Name rule appears only after an error.** Show the lowercase-and-hyphen rule as the standing hint.

### Low

13. Arguments "one per line" is non-obvious for people who paste a full command. Fix: accept a pasted command line and split it.
14. Edit, the common action, is behind the ellipsis menu. Fix: a visible Edit button.
15. Remove confirm lists roles that lose tools, which is good; it does not mention that running agents lose the tool immediately.
16. App Settings has no MCP content at all (no match in AppSettingsView). A user looking for "my servers" finds only Connections and About. This is the root of the next section.

## App-wide library, setup mode, OAuth

**Harness-wide list.** App Settings is the expected home: an "MCP library" section beside Connections, mirroring how connections are defined once and chosen per project. Users expect "define once, reuse everywhere".

**Picking in a project.** Project settings, MCP servers shows two groups: "From your library" (toggle on, per-role access) and "Only in this project". Add becomes: from library, from registry, manually, with AI. Use reference semantics with a visible "Library" badge and a "Make project-specific copy" action, so an edit in the library never surprises a project silently (show "used by 3 projects" before saving).

**Setup mode.** Do not put MCP in the Architect interview. Offer it as one optional proposal card at the end ("Suggested tools: GitHub, since you mentioned a GitHub repo") that can be skipped, picking from the library first. After setup, a one-time notice "Give your agents tools" links to the MCP section. Never block run start on it.

**OAuth.** The Authorize action belongs on the server row and the library row as a status chip plus button: "Not authorized: Authorize", "Authorized as @user", "Expired: Reauthorize". In the add form for an http server, Test should detect an auth challenge and replace the header field with an Authorize button. In a run, when a server needs reauthorization, show a card in the same region as install and permission cards ("github needs you to sign in again") with Reauthorize and Skip. Pause only calls to that server, not the run, and tell the agent the tool is unavailable so it does not retry.

## Recommendations for the two-level MCP design

Suggested information architecture:
- App Settings, MCP library: list, Add (registry, manually, with AI), status chip per server (tested, authorized). Credentials and OAuth live here once.
- Project settings, MCP servers: picks from the library, per-role access, project-only servers, status mirrored from the library.
- Run view: install, reauthorization and failure cards, always linking to the owning row.
- AI at both levels: the library assistant finds and proposes servers; the project assistant picks from the library first, then proposes new ones. Both end on the same ProposalCard with plain-language effects.

The top five things the UI must get right:
1. One place for credentials, with clear states (not set, set, authorized as X, expired) visible on every row without opening anything.
2. Testing is automatic after add and the last result persists.
3. Least-privilege role access with a plain statement of what each server can do.
4. Failures in a run link straight to the fix, and reauthorization never kills the run.
5. Library versus project scope is unmistakable: badges, a reference-versus-copy rule, and no silent cross-project edits.
