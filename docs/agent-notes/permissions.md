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

## Renderer

- Permissions UI (#14; `docs/design/permissions.md`, walk `docs/design/ux-review-permissions.md`): PermissionCard
  glance block `perm-location[data-kind]` (fails closed to "Working folder unclear"), effect sentence, rule chips with
  `data-broad`, a no-rule line, `perm-settings-link` (window event `orgai:project-settings-section`); a request with `referenceFolder` reads `perm-location[data-kind=reference]` "Touches a reference folder (read only): <folder>" plus `perm-reference-effect`, offers only Allow once and Deny and never synthesizes rules (`referenceLocation` / `REFERENCE_EFFECT` in `lib/permissionCopy.ts`; e2e/engagement.mjs drives it with `[mock:reference-shell]` and `[mock:reference-edit]`), and the reference folder hint (`REFERENCE_FOLDERS_HINT`) says OrgAI refuses edits and asks before any command naming the folder, with no "never" promise; Settings >
  Permissions Allowed folders `allowed-folder-*` (inside the `permissions-summary` disclosure) (quiet notice for folders main dropped on save); rules panel grammar
  check and kind chips. Helpers `lib/permissionCopy.ts` (`referenceEffect(toolName)`: command wording for Bash / PowerShell, "This call reads..." for Read / Glob / Grep; `permissionOffer` is the pure guard that hides scope buttons, chips and the settings link under a `referenceFolder`), `lib/decisionTitle.ts`; `Button` takes `inert` (aria-disabled, focusable, swallows clicks, styled in controls.css) and `ariaDescribedBy`; e2e `e2e/permissions.mjs` (e2e:free).
