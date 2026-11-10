# Permissions

Prompt fatigue (#14): allowed folders, rule matching, suggestions, and the permission card UI. Moved out of CLAUDE.md on 2026-11-07; see CLAUDE.md for the index.

## Main

- Permissions (prompt fatigue, GitHub issue #14; ARCHITECTURE.md "Permissions and prompt fatigue"):
  - Ignored saved rules: `permissions:ignored` (`window.orgai.permissions.ignored`, `listIgnoredRules`) lists rules `listRules` drops as `IgnoredPermissionRule { rule, reason, hiddenChar?, cut? }` (max 200, rule cut at 1,000 chars, OrgAI's own reason); `permissions:remove` deletes one by exact text, hidden characters included. No renderer yet; unit-tested only.
  - Allowed folders: `Project.allowedDirectories` (max 20, 1,024 chars each) are extra folders agents may read and
    edit like the project. ProjectStore drops on save and at boot (`cleanAllowedDirectories`, silent, logged at
    debug): relative, roots, UNC/device, the data dir either way, and through `runtime/allowedDirectories.ts`
    `allowedDirectoryRisk` the project or inside it, a folder containing it, home or above, and home config /
    credential / autorun folders (`HOME_CONFIG_DIRS` in permissionRules.ts: .ssh, .claude, .codex, .config,
    AppData/Roaming, .local/bin, Documents/PowerShell, browser profiles ...). projects:save returns the cleaned list.
    RunManager `resolveAllowedDirectories` repeats the rules at run start on real paths (both spellings of home and
    project) and warns per missing or dropped folder. Claude: `Options.additionalDirectories`; Codex:
    `sandbox_workspace_write.writable_roots`; never on trust-restricted runs.
  - Matching (ruleMatch.ts): `prefix:*` = `prefix *`; a `cd` into the project, a worktree or an allowed folder is
    free (lexical; MSYS `/c/` only for bash; win32 names ending in dot or space refused). Refused: pipes, redirects,
    `$(`, backtick, `&`, newline, unquoted `( ) { }` / `@(` / `@{`, a word-initial `@` only on PowerShell, typographic
    quotes and dashes, hidden characters in a rule or command. `programRunsProgram` (curated table in ARCHITECTURE.md)
    refuses, for every rule, options that run another program or read other config: npm-family `--script-shell` /
    `--node-options` / `--prefix` / `-C`..., go `-exec` / `-toolexec`, cargo `--config` / `-Z`, make `-f` / `SHELL=`,
    dotnet `-p:*Event=`, node `--import` / `-r` / `-e`, git global `-c` / `--git-dir`, `--config`, `--template`,
    `--output`, clone `-c`, branch `-D`, stash drop, and `PROGRAM_ENV` assignments (NODE_OPTIONS, GIT_*...); any `$`
    outside single quotes refuses the segment. Bash / PowerShell allow rules never reach the CLI (not in
    `options.allowedTools`, not in canUseTool `updatedPermissions`): the Claude PreToolUse hook is their only allow
    path, through `matchingRule` (reviewer-4 H-A, reviewer-5 H1). The one shell allow source the CLI reads itself is
    `<project>/.claude/settings.json` (`cliProjectSettings`: lstat, regular file, 256 KB, BOM, fail closed): any shell
    call the hook did not allow while that file holds a rule for the tool gets 'ask' naming the rule ("OrgAI:
    Bash(npm test:*) does not cover this command (it can run another program); asking"). Unit-tested; that a hook
    'ask' beats a settings.json allow rule is UNVERIFIED live (`scripts/smoke-permission-hook.mjs`, needs consent). Request cards flag, and project grants and Architect
    proposals never save, a prefix `isTooBroadPrefix` rejects (a quoted or `VAR=x` first word counts as too broad) (`tooBroadRuleRefusal`, the permissions:add wording). Only bare
    shells or shells in the exact `SYSTEM_SHELL_DIRS` are unwrapped.
  - Suggestions (permissionRules.ts): per segment, all or nothing, always covering the command; launchers two words
    (podman, nerdctl, kubectl, terraform, helm too), runner words and gh / aws / az / gcloud three; `isTooBroadPrefix`
    (writers, fetchers, config/eval pairs, container run / exec / compose / buildx / container, gh auth / secret,
    npm init / create, uv tool, interpreters) and blanket or destructive rules (git restore too) are never offered or
    saved, and permissions:add refuses them (`permissionAddRefusal`); folder checks fold case on darwin; a provider setMode survives only as acceptEdits. User-configured
    MCP servers get `mcp__<server>`, agent-installed ones exact tool rules. "Always allow for project" saves rules,
    the folders (ctx.allowDirectories) and acceptEdits only from 'default'. Codex file approvals in accept-edits modes
    accept only paths inside the free folders (lexical and real), never `.git` / `.codex` / `.agents` / `.claude`.
    permissions:add / remove inputs are rebuilt (`permissionRuleArgs`, rule <= 1,000 chars).
  - Mock: `[mock:fatigue]` (compound cd + npm test, a sibling-folder edit with setMode + addDirectories, a repeat
    pre-approved after the session grant); in-project edits are pre-approved in acceptEdits only.
  - Verified by unit tests, the mock and e2e/permissions.mjs. Unverified live: additionalDirectories making cds and
    edits free, session setMode / addDirectories from canUseTool, the CLI's per-segment matching agreeing with ours,
    a restarted query picking up new additionalDirectories, Codex writable_roots and its file-approval wire shape.
- Auto mode classifier and spawn cost (SDK 0.3.318, Claude Code 2.1.318; checked 2026-11-10 with
  `scripts/smoke-automode-classifier.mjs`: `--stub <scenario>` is zero spend against a local Messages stub, `--live`
  spends a few cents; plus the bundled CLI's code, read with an mmap search, and the performance lab's phase1 metering):
  - The extra no-tools request after each spawn is the auto mode classifier's spawn-time check: debug log
    `[Stall] classifier_request_started ... tool=Agent ... stage=xml_s1`, one user message (`<transcript>` of the
    session's user prompts and tool-call inputs, then the action), stop sequence `</block>`. Verified live and in the stub.
  - Normally the API judges tool calls itself (`safeguard_results` in the main response, no extra request). A
    PreToolUse `updatedInput` that changes an Agent call voids that verdict: "[server-classifier] Agent: after the
    server reviewed the response a hook rewrote this call's input ... the local classifier judges this one call". The
    CLI then sends its own billed request. OrgAI's spawn hook almost always changes the call (`name` handle, model,
    effort, isolation, prompt), so every OrgAI spawn pays for one. An `updatedInput` equal to the input did not trigger
    it (live run A). Verified live (run B). Other tools (Bash, Write, SubagentHandback) showed no extra request live
    or in the lab.
  - Model order (CLI code; the live and stub runs confirm each branch named): server config
    (`tengu_auto_mode_config`, first-party login: `claude-sonnet-5[1m]` live) > `CLAUDE_CODE_AUTO_MODE_MODEL` > a
    usable `ANTHROPIC_DEFAULT_SONNET_MODEL` > `claude-sonnet-5` (the documentation's "Sonnet 5", tried once as a
    probe) > the session's main model once that probe failed with anything but a 401. The CLI refuses
    `claude-sonnet-5-5`, `claude-opus-5-5` and `claude-opus-5` as the classifier, both as `CLAUDE_CODE_AUTO_MODE_MODEL`
    ("the API's safeguards refuse the classifier's escalated check on it") and as `ANTHROPIC_DEFAULT_SONNET_MODEL`.
  - Why the lab saw Opus: its connection set `ANTHROPIC_DEFAULT_SONNET_MODEL=claude-sonnet-5-5` (refused). The probe
    went to `claude-sonnet-5`, which the lab relay answers with HTTP 400 and records nothing (`phase1_campaign.py`
    allow list). The CLI then used the root's `claude-opus-5-5` for the rest of the session. The stub reproduces this
    exactly. A proxy that serves `claude-sonnet-5` gets it (stub).
  - `CLAUDE_CODE_AUTO_MODE_MODEL` is ignored on a first-party login because the server-configured model wins (live
    run A). On a proxy it works for an accepted model (stub: `claude-haiku-5-5`) and is ignored for
    `claude-sonnet-5-5`. A usable everyday-tier id already reaches the classifier through
    `ANTHROPIC_DEFAULT_SONNET_MODEL`, which OrgAI sets. So OrgAI does not set the variable.
  - Size: the classifier's own system prompt is about 138.5k to 140.2k characters (debug `sys=`; about 46k to 48k
    tokens, which matches the lab's 48.9k). The transcript part is user prompts and tool-call inputs only: no OrgAI
    system prompt, tool results or assistant text. OrgAI's share is its brief, harness user messages and spawn
    prompts. In the lab, every call wrote 47k to 49k tokens to the cache and read at most 5.8k. Why the cached prefix
    was not reused is unverified.
  - Its usage is missing from the result's `modelUsage` and `total_cost_usd` (live run B and the stub), so OrgAI's
    cost figures leave it out.
  - Subagent end: the CLI's hand-off review is skipped when the subagent ends with SubagentHandback (handback `send` /
    `flagged`, CLI code), which OrgAI roles do. The SubagentHandback call itself is judged like any tool call (the
    server's verdict, or a local request when there is none, stub). A subagent that acted and ended with plain text
    got a local review in the stub. Documented but not seen in OrgAI runs: "reviews its work and its final report"
    (Unverified for OrgAI's path).

## Renderer

- Permissions UI (#14; `docs/design/permissions.md`, walk `docs/design/ux-review-permissions.md`): PermissionCard
  glance block `perm-location[data-kind]` (fails closed to "Working folder unclear"), effect sentence, rule chips with
  `data-broad`, a no-rule line, `perm-settings-link` (window event `orgai:project-settings-section`); a request with `referenceFolder` reads `perm-location[data-kind=reference]` "Touches a reference folder (read only): <folder>" plus `perm-reference-effect`, offers only Allow once and Deny and never synthesizes rules (`referenceLocation` / `REFERENCE_EFFECT` in `lib/permissionCopy.ts`; e2e/engagement.mjs drives it with `[mock:reference-shell]` and `[mock:reference-edit]`), and the reference folder hint (`REFERENCE_FOLDERS_HINT`) says OrgAI refuses edits and asks before any command naming the folder, with no "never" promise; Settings >
  Permissions Allowed folders `allowed-folder-*` (inside the `permissions-summary` disclosure) (quiet notice for folders main dropped on save); rules panel grammar
  check and kind chips. Helpers `lib/permissionCopy.ts` (`referenceEffect(toolName)`: command wording for Bash / PowerShell, "This call reads..." for Read / Glob / Grep; `permissionOffer` is the pure guard that hides scope buttons, chips and the settings link under a `referenceFolder`), `lib/decisionTitle.ts`; `Button` takes `inert` (aria-disabled, focusable, swallows clicks, styled in controls.css) and `ariaDescribedBy`; e2e `e2e/permissions.mjs` (e2e:free).
