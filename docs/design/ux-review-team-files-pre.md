# UX review (pre-feature): team files under `.orgai/`

- Reviewer: UX Researcher. Build: 634d077 (`npm run build`), Windows 11, `ORGAI_MOCK=1`, throwaway data dir, fixture repo under the temp dir.
- Method: script `e2e/shots/ux/team-files-pre/walk.mjs` on `e2e/lib.mjs` (gitignored). Team tab matrix at 1024x640 and 1600x1000, dark and light (screenshots only; text and geometry sampled at 1024x640 dark). Keyboard pass (40 Tabs from the Team tab) at 1024x640 dark.
- Compared with: no spec (this is before the feature). Brief: team = plain files under `.orgai/`, Commit button, clone finds the team, pulled changes apply with Undo, power-adding changes ask first, Export to repo goes away.
- Shots: `e2e/shots/tf-NN-ux/team-files-pre/*.png` (the shot helper nests the prefix, so each lives in its own folder). Key ones: tf-01 first launch form, tf-03 Team after import, tf-05 export notice, tf-08 form on a folder already a project, tf-09 form on a folder with `.orgai/org.json`, tf-10 clone import dialog, tf-12..15 Team matrix, tf-16 keyboard.

## Verdict

Nothing exists today that says "your team is in sync with the repo". Team state lives only in the app data dir; `.orgai/org.json` is a one-off export, found later as "agents". The notice area in the Team tab is stacked Banners that already eat 191 of 592 px at 1024x640, so a permanent line must not be another Banner. The wording ("Export", "Import agents", "Found N OrgAI export agents", "Replaces your N roles") assumes two copies and a manual copy step, and misleads once files are the truth.

## Findings

### High

**H1. No place today tells the user the team differs from the repo; the Team tab at 1024x640 cannot take another Banner.**
Steps: 1024x640 dark, create a project from a folder with agents, Import (tf-03), then Export (tf-05, `export-notice`). `.frame-top` measured [56,48,608,191]: toolbar 70 px, two Banners (`import-notice` 104 px, `export-notice`), stage left with 326 px of 592. Banners stack and each needs a dismiss; Tab order puts `import-undo` and Dismiss between the toolbar and the canvas (extra stops before the first node). Where someone would look: the Team tab toolbar/header, the Settings tab, or the Dashboard tile; none show anything. Fix: a one-line persistent status in the toolbar hint row (the "New roles report to Orchestrator." line under the buttons, `.frame-toolbar`, 70 px tall at 1024), or `FrameFooter` (`TeamView.tsx:784`, currently the drag hint at 48 px). Put "Team files not committed" + Commit there; keep transient Banners for events only, and collapse two Banners into one.

**H2. "Export to repo" and "Import agents" teach the wrong model.**
`export-org` dialog: "This writes one file, .orgai/org.json ... Nothing is committed. Another OrgAI can import it with Import agents." `import-agents` dialog and the form line "Found 3 OrgAI export agents." treat the team file as a foreign source beside Claude Code files. With files as source of truth, "export/import" implies a copy that can drift. Fix: when `.orgai/` exists, call it "the team in this repo", never "export"; keep Import agents only for other tools' agent files (Claude Code, Codex...) and rename it to say so ("Import from other tools").

### Medium

**M1. Fresh clone: the team is found, but through the "agents" path and a review dialog.**
Steps: delete the project (folder keeps `.orgai/org.json`), New project on that folder (tf-09). Form says "Found 3 OrgAI export agents. The agent files are read, not changed. You review the roles before they join the chart." and offers three choices ("Import the 3 agents (review first)" / "Let the Architect set up" / "Start with the default chart"); the Architect choice is offered even though a team exists. Submit goes to the import dialog (tf-10) in Replace mode: "Replaces your 4 roles with these 3." The user has never seen the 4 default roles; this reads as destructive. Result banner: "Imported 3 roles from OrgAI export. You can undo until you edit the chart." A fresh-clone person expects: open the folder, see the team, and a plain line "Team loaded from .orgai/ in this repo", with no choice screen and no "replace". Only unfamiliar power (new connectors, tools) needs a prompt.

**M2. Counts add the same team twice.**
With `.orgai/org.json` and `.claude/agents/` both present the form says "Found 3 OrgAI export agents and 2 Claude Code agents." and the choice "Import the 5 agents" (tf-08). The 3 include the 2 (names backend-dev, reviewer). Under a files model, `.orgai/` should win and other sources be offered separately.

**M3. Folder already a project is a warning, not a route.**
Same form (tf-08): amber "This folder is already a project: TF walk." with a secondary "Open TF walk" and a primary "Create project and review import anyway". It is the same folder opening on another computer's clone only if names collide; on one computer it is right. With files, a second project on one folder is a conflict (two writers on `.orgai/`). Make "Open <name>" the primary and drop "anyway", or block it.

**M4. Undo semantics clash with git.**
`import-undo` says "You can undo until you edit the chart" and saves `previousRoles` in the app; with files, Undo would have to rewrite the files, and an Undo for a pulled change must say what it reverts to (the old file contents, not a git revert). The text must also say the files were changed on disk. Existing pattern: `importNotices` in the store, expires on first chart edit (CLAUDE.md "Agent import (renderer)").

**M5. Export notice shows a raw absolute path and is the only trace of the write.**
`export-notice`: "Exported the org chart C:\Users\...\.orgai\org.json" with no next step (commit it), no state afterwards, and it stays until dismissed. For edits that now write files on every change, per-edit notices will be noise; use the status line instead.

**M6. No decision surface in the Team tab for approvals when no run is open.**
Decision cards today live in the run view tray (`FrameTray`, `components/DecisionCard.tsx`, "Needs you" counts from `lib/needsYou.ts` `waitingItems`, bell and sidebar badges) and are tied to runs. The Team tab's `FrameTray label="Team assistant"` (`TeamView.tsx:776`) holds the Team assistant tray, so an "added power" approval has no home with no run open. The bell and Dashboard `dash-needs-row` come from runs only. Reuse: `DecisionCard` shell inside the Team `FrameTray` (it is the same frame component), plus a Needs-you item with its own `kind` ("Team change") so the bell and the Dashboard tile count it; then a pull applied while the app is closed still surfaces on open. I did not see this combination work (it does not exist).

### Low

**L1. Skills and connections catalog reads as app state.** Catalog (tf-06): "What the whole team can draw on. Open a role to choose what it uses." Skills "Instructions an agent loads on demand", Connections "Services your agents can reach, like Slack or Gmail", Plugins "Claude Code plugin folders" (a plugin folder path is a per-computer path; it would not travel). Nothing says where each is stored. Expectation to travel: roles, prompts, tool grants, skill files and which roles may load them, connector definitions (service, access level, which roles). Expect to sign in again: connector tokens, OAuth, secret values (CLAUDE.md: secrets live in SecretStore, never in files), per-project secret values, local plugin folder paths, mock-adapter/connection choice. Existing words to reuse: "Not signed in", "Needs sign in" (`connector-tile` state), `waitingLabel` "Needs a value for this project". A pulled connector should arrive as "Not signed in", never as connected.

**L2. Role inspector shows power without location.** Role tab (tf-07): "Tools Edit; Read, Glob, Grep + Edit, Write, Bash", "Delegation May create subagents", node badge with a warning icon next to tool count. These are the very fields an "adds power" check will compare; the node warning icon is unlabelled at a glance. Reuse the same elevated-tool wording as the import dialog ("Edits files", "Runs commands", "Can start other agents").

**L3. Two Banners at 1600x1000 look fine (stage 524 px high); the squeeze is a 1024x640 issue** (stage 326 px). No page scroll in either size (scrollHeight equals window height). No theme-specific problems seen in the matrix screenshots.

## What exists, for reuse

- Notices: `Banner` (`components/ui/Banner`, `TeamView.tsx:629-740`; testids `import-notice`, `import-undo`, `export-notice`, not-imported banner). Persistent bar candidates: toolbar hint row, `FrameFooter`, `SaveIndicator` (`components/layout/SaveIndicator.tsx`, not driven here).
- Dialog/approval: `DecisionCard` shell, `FrameTray`, `ConfirmDialog`/`useConfirm` (`confirmTestId`), Needs-you via `lib/needsYou.ts`.
- Import preview already lists elevated tools, dropped tools and "Replaces N roles" with a digest check (`import-dialog`, `import-apply-error`, Refresh preview): the right shape for "this pull adds power", but modal and per-import.
- Keyboard (Team tab, Tab order): skip link, Add role, Import agents, Export to repo, Templates, Auto-layout, Canvas style, then notice controls (Undo, Dismiss), then nodes, zoom, assistant tray, side panel. A status line with Commit must sit after Auto-layout and before notices, with a live region (one polite status, as `tray-announce` does).

## Questions answered

- Where would someone look to learn their team is uncommitted? The Team tab header/toolbar first, then the project tile / sidebar row (project rows already carry badges), then Settings. Today none show it.
- Misleading wording once files are truth: "Export to repo", "Nothing is committed", "Another OrgAI can import it", "Found N OrgAI export agents", "Replaces your N roles", "You can undo until you edit the chart", "agent files are read, not changed".
- Existing components: Banner for events, DecisionCard in FrameTray plus Needs-you for approvals, ImportAgentsDialog preview pattern for diffs, `importNotices` Undo.
- Fresh clone expectation: open folder, team already there, one quiet line saying where it came from; no choice of how to start, no Replace.

## Not driven

No real git: no commit, no pull, no clone with history, no uncommitted state (the feature does not exist). A changed `.orgai/org.json` while the app is open was not tested. Catalog with skills/connectors in it and a role with connections were not seen (empty catalog on a new project); connector sign-in states were read from CLAUDE.md, not driven. Light theme and 1600x1000 only by screenshot of the Team tab, not read in detail; the keyboard pass was at one size and I did not check focus rings by eye. Native folder picker (Browse), macOS and Linux, packaged builds were not driven.
