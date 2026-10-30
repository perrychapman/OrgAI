# UX walkthrough 2: MCP library (partial)

Goal: "I want my agents to use GitHub and a Postgres server, defined once and reused across projects."
Build: worktree agent-aa530d2229fba5eb4, ORGAI_MOCK=1, temp ORGAI_DATA_DIR. Dark theme, 1600x1000 only.
Screenshots: C:/Users/chapp/AppData/Local/Temp/uxr-shots/ (outside the repo).

## Coverage (honest)

Walked live: App Settings > MCP library empty state, Add manually, Add from registry (live registry, online), secrets, row expand, row menu, Test start.
Judged from code only: Authorize / Needs authorization (McpAuth.tsx, TestResultPanel.tsx).
NOT walked (Electron became unlaunchable mid-run because the worktree's node_modules went missing): Configure with AI assistant window and proposal card, project Settings > MCP servers (Add from library, linked vs project-only menus, Open in library, Unlink, promote), New run page notice, setup-run Skip on an mcpServers proposal, light theme, 1024x640, keyboard-only. Re-walk these once `npm ci` is complete.

## Findings, ranked

### High

1. **Secret ticked after typing silently erases the value.** Flow: Add manually > Add variable. Type NAME and a value, then tick "Secret": value is cleared (McpServerForm.tsx `patchRow(..., { secret, value: '' })`). I did exactly this and the saved server showed "Secrets: 0 of 1 set" with no warning (shots 31-after-add-github, 32-library-1row). Expected: the typed value carries over into the secret field, or the box explains it. Fix: move the typed value into the secret input on tick, or warn before clearing. Also consider auto-ticking Secret when the name matches TOKEN, KEY, SECRET, PASSWORD, URL with credentials.

2. **A server with a missing required secret looks fine.** Row github has only a faint blue "Secrets: 0 of 1 set" and a thin amber left edge; no "Needs setup" chip, and no state chip at all (not tested, tested OK, failed) (shot 32-library-1row, 35-library-2rows). Design intent was a status chip on every row, with the last test result persisted and automatic testing after add. Neither exists: Test is a manual button, nothing auto-runs after Add. Fix: a status chip per row ("Needs a secret", "Not tested", "Connected, 12 tools", "Test failed"), auto-test after add when secrets are complete, and persist the result.

3. **Test can hang with no feedback beyond "Testing" and a Cancel.** Clicking Test on github (secret unset) stayed on "Testing" for at least 3.5 s; the stdio probe launches a real `npx` even in mock mode, which may download a package (shot 42-test-result-gh-unset). No elapsed time, no "this may download the package", no timeout, and testing was allowed with a required secret unset. Closing the app mid-test left an Electron process behind in my run. Fix: block or warn on Test when required secrets are unset; show elapsed seconds and "first run may download the package"; cap with a visible timeout.

### Medium

4. **MCP library is buried.** On Settings it sits after three fully expanded Connections cards (Anthropic with a model list and tier mapping) and needs a long scroll (shots 10-appsettings, 11-library-empty). The page has no section nav or anchors. A user looking for "GitHub tools" would not guess it lives under Settings below LiteLLM. Fix: collapse connection cards by default or add a sticky section index, and link to the library from the project's MCP section.

5. **Registry search ranks alphabetically, not by relevance or trust.** Searching "github" returns ai.smithery/Hint-Services-obsidian-github-mcp first; the official GitHub server was not on the first page (shot 22-registry-github, 23-registry-pick). Users cannot tell official from third party. "Pinned" and the `Authorization` key chip are unexplained. Fix: sort by relevance, badge "Official" or verified publishers, tooltip or one-line explanation for "Pinned".

6. **Two Save buttons in the Add dialog.** The inline secret "Save" and the footer "Add server" both look like commit actions (shots 23, 33). Saving the secret inline before the server exists works (it showed "Set / Replace / Clear" afterwards), but it is not obvious that it is stored immediately while the rest is not. Fix: label it "Store secret" or save secrets on Add server only.

7. **Variable rows are cryptic.** The two inputs have no visible labels, the value input has no placeholder, and "Secret" is an unticked checkbox by default (shot 30-env-row). A user who skips it stores a token in plain text. Fix: column headers (Name, Value), placeholder "value", and a one-line plain-text warning when the name looks secret-like.

8. **Row actions are hidden.** Only Test and an unlabeled "..." show; Edit and "Remove from library..." appear inline under the row after clicking "..." (shot 43-row-menu), which pushes the layout down and does not close on outside click or when other things expand. Also the "You" badge is not self-explanatory (it means "added by you", versus Registry or Agent). Fix: label the badge "Added by you", or drop it for the default case.

9. **"Not used by any project" is a dead end.** For the stated goal (reuse across projects) the library row offers no "Add to a project" action. Fix: a per-row "Use in project..." action.

### Low

10. Auth (code review). The mock adapter cannot complete OAuth, so I could not see it live. From code:
   - Pending state shows "Waiting for your browser…" and Cancel only. No timeout text, no "Open the page again" or copyable URL if the browser did not open, so a user whose default browser is blocked is stuck until they press Cancel.
   - When the server needs a pre-registered OAuth app, the Authorize button is disabled until Client ID is typed, with only a paragraph above explaining why; add `aria-describedby` or inline hint on the button.
   - AuthorizeControl returns nothing once authorized, so this component offers no "Sign out / Revoke"; confirm the library row has one.
   - A failed test prints only the last 8 lines of raw output and no hint such as "a required secret is not set"; add a plain-language header above the raw output.
   - TestResultPanel "Needs authorization" banner text is good ("A browser window opens to do that") and the "Use a token instead" escape is a strong pattern.

11. Registry dialog shows an unexplained "Registry version 0.4.0" and long remote URLs; fine for developers, keep.

## What worked

- Empty state and the three Add entry points (registry, manually, with AI) are clear, and the intro line "Define tool servers once, then add them to any project" matches the user goal.
- Name hint "Tools appear to agents as mcp_name_tool" and the stdio warning "Runs code on this machine with your permissions" set the right expectation.
- Secret fields: password input, "Set / Replace / Clear" afterwards, "never shown again". Registry dialog warns when a required header is unset and says it can be set later.
- Row summary ("Runs on this machine", source, "Secrets: 1 of 1 set") is compact and informative.

## Environment note

Electron processes from my driver may still be running (a window titled "OrgAI", PID 39676, possibly mine). I could not kill it (the kill command was denied by the permission classifier). Data dirs left in C:/Users/chapp/AppData/Local/Temp/uxr-data and uxr-data2; driver scripts in C:/Users/chapp/AppData/Local/Temp/uxr.
