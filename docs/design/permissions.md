# Permissions: fewer prompts (renderer spec)

Answers `docs/design/ux-review-permissions.md` (H1-H4, M1-M4, L1-L4). Builds on spec.md 12.1 (decision cards, tray). Copy comes only from the pure helpers `lib/permissionCopy.ts` and `lib/decisionTitle.ts`; strings below are quoted from them, and a change to one changes the other in the same commit. `components/DecisionCard.tsx` (the shell) does not change. Nothing floats over the canvas; token colours only; both themes.

Runtime contract (final, main):

- `Project.allowedDirectories?: string[]`: extra absolute folders agents may read and edit like the project folder. Main drops relative paths, roots, UNC, OrgAI's data folder or a folder containing it, and duplicates, silently. At most 20 (`PROJECT_ALLOWED_DIRECTORIES_MAX`), each at most 1024 chars (`PROJECT_ALLOWED_DIRECTORY_MAX_CHARS`). Saved through `projects:save`.
- `PermissionRequest.suggestions`: `addRules` (one rule per command step, e.g. `Bash(npm test:*)`; a `cd` into the project is free), `addDirectories`, `setMode` ('acceptEdits'). `ruleLabels` come from main: "Edits and reads in <dir>", "Auto-accept file edits in this project", or the rule string.
- Scopes. Allow once: this call. Allow for session: the rules, folders and mode for the rest of this run. Always allow for project: rules saved to the project's rules file (`.claude/settings.local.json`), folders saved to allowed folders, and for an edit in a project on "Ask for everything risky" the project switches to "Auto-accept file edits".

## 1. Permission card anatomy (top to bottom)

| Region | Content | Compact (frame under 480 px tall or `section.frame-tray[data-compact=true]`) |
| --- | --- | --- |
| Header | Kind chip `Permission` (warning), agent avatar and name, run label, header badges (below) | Shown |
| Title | `permissionTitle(toolName, input)`, title-sm, one line | Shown |
| Glance `.perm-glance` | Location line, then the effect line and rule chips | Shown, never behind Details |
| Detail | Request summary, Command / Tool input preview | Behind Details |
| Helper | Scope list `perm-scopes`, settings link | Behind Details |
| Footer | Allow once (primary), Allow for session, Always allow for project, Deny (quiet danger, right) | Shown, unchanged |

Header badges (attention tone, at most two plus "Hidden characters"):

| When | Badge |
| --- | --- |
| Shell command whose first line has 2 or more steps (`shellSegments`) | "N steps" |
| Several non-empty lines | "N lines" |
| First line clipped in the title | "Long command" |
| Any other shell command | "Command" |
| Control, zero-width or bidi characters in the command | "Hidden characters" |

Title. Shell (Bash, PowerShell): `shellAction` names the last step that is not a change of folder (`cd`, `chdir`, `pushd`, `Set-Location`, `sl`), with "(+N more)" for the other real steps. `cd <wt> && git add -A && git commit -m x` reads "Run git commit -m x (+1 more)"; `cd <wt> && npm test` reads "Run npm test". Extra lines add "(+N lines)", a clipped line ends "(long command)". Files: "Edit server.js", "Write notes.md", "Read a.ts". Others: "Fetch <host>", "Search the web: <q>", "Use <tool>". Fixes M2.

Glance block (fixes H3, H4, M1):

- Location line `[data-testid=perm-location][data-kind=project|worktree|allowed|outside|unknown]` from `permissionLocation(toolName, input, { projectPath, allowedDirectories, agentCwd })`. Absent when it returns null (tools with no path or `cwd`). The full path is the `title`.

| kind | Label (file tools) | Label (shell tools) | Icon (lucide) | Tone |
| --- | --- | --- | --- | --- |
| project | "In the project" | "Starts in the project" | FolderOpen | secondary text |
| worktree | "In worktree <name> (inside the project)" | "Starts in worktree <name> (inside the project)" | FolderOpen | secondary text |
| allowed | "In an allowed folder: <folder>" | "Starts in an allowed folder: <folder>" | FolderOpen | secondary text |
| outside | "Outside the project: <folder>" | "Starts outside the project: <folder>" | TriangleAlert | attention |
| unknown | "Working folder unclear: <step or path>" | same | TriangleAlert | attention |

  Shell labels say "Starts in" because a command can still act on other paths; the line is a hint, never a guarantee. The secondary detail (`detail`: the path below the named folder, e.g. `src/server.js`, or the file name outside) follows in mono, `--text-tertiary`, ellipsis; the full path (invisible characters replaced) is the tooltip. Paths are compared as text: links, junctions and 8.3 names are not followed.

  Shell location is the folder after every `cd` before the last real step, and it fails closed (review H1): kind unknown for a command of several lines, a subshell or group (`(cd / && …)`), a nested shell (`bash -c "…"`, `pwsh -Command`, `cmd /c`, `eval`), and any `cd` whose argument is not exactly one plain word or one fully quoted string (options such as `--` or `-P`, `~`, `$X`, `%X%`, globs, `cd` alone, `cd -`, `cd ''/etc`, `popd`). `cd /d X`, `cd/d X`, PowerShell `cd..` and `Set-Location -Path X` are followed. A drive-relative path (`C:x`, `C:..\..`), a path rooted on the current drive (`\x`) in a Windows project, or a backslash in a POSIX project is unclear for file tools and `cwd` too.
- Effect line `[data-testid=perm-scope-project]`: the `scopeCopy(...).project` sentence, e.g. 'Always allow for project: stops asking for "npm test" commands in this project.' Absent when the card has no project scope. The mode change is named first so the two-line clamp in compact mode never hides it.
- Rule chips `[data-testid=perm-rule-chip]`, one per `ruleLabels` entry, through `ruleChip(label)`. A broad rule gets `data-broad=true` and the attention tone: a whole tool (bare tool name, also `data-whole-tool=true` and the suffix "whole tool") or every tool of an MCP server (`mcp__<server>`, main's label "All tools of <server>").
- No-rule line `[data-testid=perm-no-rule]`: a shell card with no suggestions says "No rule can cover this command (pipes, redirects and $(…) always ask)." instead of silently dropping the scope buttons.

Detail block: request summary (hidden for shell when the command block is open, L1), then the Command or Tool input preview, the card's only inner scroll. Edit and Write previews open by default like Bash (L2). Hidden characters are escaped visibly in the command block.

Helper: `[data-testid=perm-scopes]` lists the three `scopeCopy` sentences (once, session, project) in that order, `--text-small`, `--text-secondary`. Under it the quiet link button `[data-testid=perm-settings-link]` "Fewer prompts: permission settings" opens Project settings > Agents and focuses the Permissions section heading (`lib/settingsTarget.ts` `requestProjectSettingsSection` plus the `orgai:project-settings-section` window event; the Agents pane takes it on mount or on the event). Not shown on Chat, MCP assistant or Skill assistant runs (virtual projects have no project settings).

Keyboard and focus: unchanged from spec.md 12.1. Focus lands on Allow once when the card mounts, except a shell command in compact mode, where it lands on Details first. Tab order: Details, settings link (when the helper shows), Allow once, Allow for session, Always allow for project, Deny. The tray's polite live region announces the title only.

## 2. Scope copy (`scopeCopy`, `ruleSubject`)

Once is always "Allow once: this call only." Session reads "Allow for session: <phrases> until you end this session." (L3). Project reads "Always allow for project: <phrases>." Phrases join with commas and a final "and", in the order mode, folders, rules.

| Suggestion | Subject / session phrase | Project phrase |
| --- | --- | --- |
| `Bash(npm test:*)` or `Bash(npm test *)` | stops asking for "npm test" commands | stops asking for "npm test" commands in this project |
| `Bash(git status)` (exact) | stops asking for the command "git status" | ... in this project |
| `WebSearch` (whole tool) | stops asking for every WebSearch call | ... in this project |
| `Bash` / `PowerShell` whole tool | stops asking for every shell command | ... in this project |
| `mcp__github`, `mcp__github__*` | stops asking for every github tool | ... in this project |
| other `Tool(x)` | stops asking for Tool calls matching x | ... in this project |
| `addDirectories` | allows edits and reads in <dir> | adds <dir> to this project's allowed folders |
| `setMode` acceptEdits | auto-accepts file edits | switches this project to Auto-accept file edits (only when the project mode is `default`, "Ask for everything risky") |
| `setMode` other | uses permission mode <mode> | none |

When no project phrase applies, the project sentence is "Always allow for project: the same as Allow for session; nothing is saved for later runs." No suggestions: only Allow once and Deny show, `perm-scopes` has the once line only, and there is no effect line or chip.

## 3. Project settings > Agents > Permissions

Order in the section: mode, allowed folders, saved rules. One primary action per region (Add).

Mode: the existing `Select` (labels from `PERMISSION_MODE_OPTIONS`). Under it one line `[data-testid=permission-mode-tradeoff]` with `PERMISSION_MODE_TRADEOFF[mode]`, e.g. default "Every edit and command asks. Most prompts." Then the note `[data-testid=permission-mode-note]`: "Saved rules and allowed folders apply in every mode except Plan only and Bypass." When `rulesApplyInMode(mode)` is false: "Saved rules and allowed folders are not used in this mode." (fixes M3).

Allowed folders `#settings-section-allowed-folders`, `[data-testid=allowed-folders-section]`, heading "Allowed folders":

- Hint: "Agents may read and edit files here without asking, under the same permission mode as the project folder. OrgAI's data folder can never be added."
- Rows `[data-testid=allowed-folder-row]`: the path in mono (ellipsis at the end, full path as `title`), and an `IconButton` X `[data-testid=allowed-folder-remove]` labelled "Remove <path>". Remove saves at once; focus moves to the next row's remove button, else the input.
- Empty: "No extra folders. Agents work in the project folder and its worktrees."
- Add row: mono `Input` `[data-testid=allowed-folder-input]` (label "Folder path"), `Button` Browse `[data-testid=allowed-folder-browse]` (native folder picker; fills the input), `Button primary` Add `[data-testid=allowed-folder-add]`. Enter in the input adds.
- Inline error `[data-testid=allowed-folder-error]` (`role=alert`, under the row) from `allowedFolderDraftProblem`: "Enter a folder path first.", "That path is too long (1024 characters at most).", "That folder is already listed.", "A project can list at most 20 folders." At 20 rows Add is disabled with the last line as its reason.
- Dropped by main: after the save resolves, `droppedFolders(sent, saved.allowedDirectories)` gives one quiet notice each `[data-testid=allowed-folder-notice]` (dismissable, inside an always-mounted `role=status` list): "<path> was not saved: must be an absolute folder, not a drive root, not OrgAI's data folder, and not the same folder as one already listed." The input keeps the text so it can be fixed. Saves go through the store's `saveProjectNow` (after `updateProject`, so no older debounced snapshot lands later).
- Save error (IPC rejects): inline error with the `lib/ipcError.ts` text; the list shows the last saved state.

Saved rules panel (fixes M4): the section note names the file: "Saved in .claude/settings.local.json in the project folder." Each rule row: the rule in mono, a kind chip `[data-testid=rule-kind]` from `ruleInfo(rule).label` ("command prefix", "exact command", "whole tool", "all tools of <server>", "pattern"; whole tool in attention tone), and the explain line, e.g. "Any command starting with npm test, from any folder; every step of a && command must be covered.", "Exactly git status.", "Every WebSearch call, whatever its input, before any prompt.", "Every tool of the github server.", "Applied by the provider when a run starts, not in runs already open."

Duplicates in the file are shown once with a "saved N times" chip (`[data-testid=rule-count]`, `collapseRules`).

Draft field: examples `Bash(npm test:*)`, `Bash(npm test *)`, `Bash(git status)`, `WebSearch`, `mcp__github`. `checkRuleDraft` runs on every change; Add stays enabled and a refused draft shows its reason as the field error `[data-testid=rule-draft-error]` on Add, e.g. "A whole-tool Edit rule would approve edits anywhere on this computer. Add the folder under Allowed folders instead." (Bash, PowerShell, Edit, Write, MultiEdit, NotebookEdit, `Bash(*)`, `Bash(*:*)`, `Bash( )`, `mcp__orgai`, a wildcard other than `mcp__<server>__*`, multi-line, over 500 chars; format reason `RULE_FORMAT_HINT`). A file rule with one leading slash (`Edit(/Users/me/docs/**)`) is refused with "Claude Code reads a single leading / as relative to the project; write // for an absolute path (e.g. Edit(//Users/me/docs/**))." An accepted draft shows the line `[data-testid=rule-draft-kind]` (linked by `aria-describedby`, not a live region): "<Kind label>: <explain> Takes effect in open runs too." when `info.live` (prefix in both forms, exact, whole tool, server), else "Pattern: Applied by the provider when a run starts, not in runs already open." A destructive prefix (rm, sudo, git push, curl...) or a server-wide rule adds a warning `[data-testid=rule-draft-warning]` but is not refused. Main validates again.

## 4. States

| State | Rule |
| --- | --- |
| No suggestions | Allow once and Deny only; one line in `perm-scopes`; no effect line, no chips |
| Answer in flight | Footer buttons disabled with `aria-busy` on the card; an IPC error shows inline above the footer and focus returns to Allow once |
| Settings loading | The rules list reads "Loading…"; the folder list renders from the project at once |
| Compact vs roomy | Compact keeps header, title, glance and footer; Details toggles detail and helper. Roomy shows all, detail and helper open |
| Dark and light | Token colours only (`--text-*`, `--attention-*`, `--surface-*`); attention location and whole-tool chip must keep 4.5:1 in both |
| Keyboard | Every control reachable by Tab, visible `:focus-visible` ring; the settings link and remove buttons are real buttons |
| Saving a folder or rule | The input stays focusable: `readOnly` with `aria-busy` (never `disabled`), and Enter is ignored until the save settles. Add, Browse and Remove are disabled meanwhile; focus is restored after the save settles, never onto a still-disabled control |
| Folder added | Focus is in the cleared input; the sr-only `role=status` `[data-testid=allowed-folder-announce]` says "Added <path>." (Remove says "Removed <path>.") |
| Folder refused or save failed | Focus stays in (or returns to) the input; the input keeps the text; the error is linked by `aria-describedby` |
| Folder notices | The `role=status` list is always mounted and never `hidden`; CSS `:empty` collapses it, so the first notice is announced |
| Rule or folder removed | Focus moves to the next row's Remove (the previous one for the last row), else the add input; on a failed remove it returns to the same row's Remove. A rule's Remove `[data-testid=rule-remove]` shows a spinner and "Removing…" while busy, and its name reads "Removing rule <rule>" to match |
| Untrusted text | Paths, commands, rule strings and labels are plain React text, never HTML; `oneLine` strips control and bidi characters in titles, labels and chips; the command block shows hidden characters escaped |

Test ids (new): `perm-location`, `perm-scope-project`, `perm-rule-chip`, `perm-scopes`, `perm-settings-link`, `permission-mode-tradeoff`, `permission-mode-note`, `allowed-folders-section`, `allowed-folder-row`, `allowed-folder-remove`, `allowed-folder-input`, `allowed-folder-browse`, `allowed-folder-add`, `allowed-folder-error`, `allowed-folder-notice`, `allowed-folders-empty`, `perm-no-rule`, `rules-section`, `rule-row` (`data-rule`), `rule-kind` (`data-kind`), `rule-count`, `rule-input`, `rule-add`, `rule-example`, `rule-draft-error`, `rule-draft-kind`, `rule-draft-warning`.

e2e impact (`e2e/runs.mjs` or a new permissions check in e2e:free, mock): at 1024x640 the location line and effect line are visible without opening Details; a `cd <wt> && npm test` card is titled "Run npm test" with "In worktree <name> (inside the project)"; the settings link focuses the Permissions section; adding and removing an allowed folder, a refused `Edit` draft and a dropped relative path notice. Existing selectors on the card footer do not change. Unit tests cover the helpers (`decisionTitle.test.ts`, `permissionCopy.test.ts`).

## 5. Open items

- Batch allow (M6): "Allow all N once" in the tray stepper when every open card is a permission card. Not in this pass.
- Session grants list (M5): what this run may now do, with Save for project and Revoke. Needs a contract.
- Needs-you location (L4): reuse the location label in `lib/needsYou.ts` items. Not in this pass.
- `Bash(prefix *)` is shown as live: the Runtime Lead confirmed the parallel runtime change makes `ruleMatch.ts` match the space form like `prefix:*` (Claude hook, Codex, mock). If that change does not land, mark it `live: false`.
- The Always allow button has no `aria-describedby` to the effect line: `components/ui/Button` takes no such prop. Add the prop to Button, then wire it.
- Details' `aria-expanded=false` in compact mode while the glance is visible: DecisionCard's toggle controls the whole body; a prop to point it at the detail and helper only would make it exact.
- Main's `permissions:add` does not refuse whole-tool shell and edit rules or a single leading slash; only the renderer does (a direct IPC call still saves `Bash`).
- The location for Chat, MCP and Skill assistant runs (virtual projects) is not shown.
