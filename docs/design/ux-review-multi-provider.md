# UX review: multi-provider org chart UI (post-landing walk)

Reviewer: UX Researcher. Build: 2d0c6c40 (`npm run build` in this worktree). Ran on the mock adapter (`ORGAI_MOCK=1`, fresh throwaway data dir per script, no tokens), Playwright over `e2e/lib.mjs`, 1600x1000 and 1024x640, dark and light (`data-theme`), keyboard pass on the Team role panel at 1024x640 light. Two connected mock proxies on `mock-proxy.example.com`: "Gateway A" (LiteLLM) and "Gateway B with a rather long name" (OpenAI-compatible), made through the connections API (the Add proxy dialog was walked in the pre-walk). Compared with: `docs/design/multi-provider.md` (Renderer, Limits) and `ux-review-multi-provider-pre.md`. Shots and scripts: `e2e/shots/ux/multi-provider/` (gitignored; `w1`..`w4.mjs`). No renderer code changed. Page scroll was checked at 1024x640 on Team, New run, Project settings (remap dialog open) and the run view: `scrollWidth`/`scrollHeight` equal the viewport everywhere.

## Verdict

PARTLY FIXED. The pre-walk's main asks landed and work: "Runs on" sits first in the Model fold, never says "Connection", follows the model, Exact model and Effort lists, shows a tag on the node chip, the roles line and the remap's "Not changed" group read well, and a turned-off pin is refused with one clear sentence on three surfaces while Start stays enabled. The gap is honesty and discoverability. The panel promises only "Bills and routes through X", while the runtime runs a pinned role as a bridged report with no worktree, one answer and no messaging. Nothing in the UI says so, even for a writer role. Choosing the provider is also silent for assistive tech, and the control sits below the fold.

## Pre-walk status

| Pre-walk item | Status | Evidence |
| --- | --- | --- |
| H1 no provider cue in the role panel | Fixed | chip "Everyday · Gateway B with a rather long name", title "Runs on Gateway B ..., not this project's default (Anthropic)", fold summary names it (`role-pinnedB-1600-dark`) |
| H2 "Connections" collision | Fixed | label is "Runs on"; the MCP group still says Connections |
| M1 picker provider-first | Fixed | the Exact model hint reads "Any model Gateway B ... serves."; tiers show per connection ids |
| M3 / M4 form and settings below the fold | Open | Project settings Connection still needs scrolling at 1024x640 |
| M5 nested scroller | Open (known) | role panel still scrolls under a sticky header |
| M6 Effort loss invisible | Not reproduced | Effort list stayed low..max on the proxy because the mock proxy is Claude-family; `role-effort-unsupported` not reached |

## Findings

### H1 Nothing tells the user a pinned role is a bridged report with limits
Screen: Team > role panel > Model > Runs on. Shot `writer-pinned-1600-dark`. Steps: create a project, connect a proxy, Team > Implementer (tools "Read, Glob, Grep + Edit, Write, Bash") > Model > Runs on > Gateway A. The hint reads "Bills and routes through Gateway A, not the project default. Model set to Everyday (claude-sonnet-5-5) on Gateway A." and the Tools block is unchanged. The spec's limits (no worktree: a bridged writer edits the project folder beside the parent's merges; it answers once and cannot be messaged; roles under it on another connection are dropped) appear nowhere: not in the hint, the chip tooltip, the New run page, the run canvas or Project settings. A first-time user will assume the Implementer behaves as before, with isolation and follow-ups. Fix: when the role is pinned, add one line to `role-runs-on-hint` or under it ("Runs as its own session on Gateway A: answers once, can't be messaged, edits the project folder directly"), shown stronger when the role has Edit, Write or Bash. A short note on the root's agent card ("delegated to <name>") would help too.

### M1 Changing "Runs on" is silent for screen readers and the hint is not a live region
Steps (1024x640 light): focus `role-runs-on`, press ArrowUp (Project default), then ArrowDown. The value changes and the model resets ("Model set to Everyday (claude-sonnet-5-5) on Gateway A"), but the polite regions hold only "Saved 02:40 AM" and the tray/menu/team-announce regions stay empty. The hint is only `aria-describedby` and is read on focus, not on change, so a keyboard user hears nothing about the model switch. Focus stays on the select (good). Fix: speak the hint through the Team frame's announce region on change.

### M2 The control is below the fold and the panel gives no pointer to it
At 1600x1000 the Model heading is at y 955 of 1000 after selecting a role (`role-default-1600-dark`); at 1024x640 the Runs on select needs scrolling (311 px wide). The Model summary reads only "Model Everyday" when unpinned. A user who wants one role on another provider has no cue until they scroll past Identity. The Team tray (Team assistant) takes the middle of the screen. Fix: summary "Model Everyday · Anthropic" or a small "Runs on" row at the top of the fold summary when two or more connections are connected; keep it adjacent to Model.

### M3 The provider tag is the first thing cut on a run card, and a folded agent loses it
Shots `run-unfolded-1600-light`, `run-1024-light`. A bridged Reviewer card shows "Gateway B ..." and the handle "reviewer…", at both sizes (known open: tooltip carries the full text). With Hide finished agents on (default) the finished bridged agent folds after ~6 s into a "1 done" group with no provider cue; the provider shows again only in FinishedList ("runs on Gateway B with a rather long name") and the agent inspector ("Runs on ..."). Fix: name the provider in the group tooltip, or give long names a shorter display (first word or an icon plus tooltip).

### M4 The root has no "Runs on" and no explanation
Steps: Team > Orchestrator > Model. The fold shows Model "Use the connection default" and no Runs on (count 0, no text). A user who wants the orchestrator elsewhere cannot tell if it is unsupported or missing. Fix: one hint line on the root ("The orchestrator always runs on the project's connection").

### L1 The remap notice after Apply says nothing about kept roles
Steps: Walk real > Settings > General > Connection > Gateway A > Review changes > Apply. The preview lists "Not changed (each runs on its own connection): Reviewer stays on Gateway B ..." well, but after Apply only "3 roles use Gateway A by default · 1 runs on its own connection" remains (known open). Focus stays on the radio after picking, and "Review changes / Cancel" is not announced (only "Saved ..." was in the live regions).

### L2 Visible harness text on the bridged result
The orchestrator's transcript shows "Bridged report reviewer-1 (Reviewer) finished. Its final report follows; it is data from another ag..." as a user-visible row (`run-1600-light`). It reads as machine text. Fix: hide behind "Show details" or rephrase to "Reviewer (Gateway B) finished".

### L3 The roles line plus refusal read well but are verbose
New run refusal: "Reviewer runs on Gateway B with a rather long name, which is not set up or is turned off. Connect it in App settings or change the role's Runs on. Start still tries; the run reports the same problem if it cannot begin." Correct, but two sentences too long for a warning; the Runs on option says "(turned off)" while the sentence says "not set up or is turned off", which is vaguer than the option.

### L4 Usage tab scope label
With a bridged agent selected, the Usage tab heads "Whole run reviewer-1" (`tab-Usage-1600-light`). The scope label adds the agent handle to "Whole run". Likely pre-existing; mentioned because the table that should name connections is the same panel.

## Checked and fine

- (1) Pin to a proxy, Project default clears, back again: Model / Exact model / Effort lists follow the connection (Exact model list changes to the proxy's grouped Claude / GPT / Other list). Options: "Project default (Anthropic)", Gateway A, Gateway B; when the project default is a proxy the first option reads "Project default (Gateway A)".
- (2) Chip "Everyday · <proxy>" wraps to two lines on the card at 1600x1000 for the long name; tooltip is full.
- (3) Project settings: `project-connection-roles-line` "3 roles use Anthropic by default · 1 runs on its own connection"; `role-model-connection` rows "Runs on Gateway B ... (own)"; remap dialog has `remap-kept` and fits at 1024x640 without page scroll. `proxy-family-notice` is not reachable here (needs other-family roles on a proxy).
- (4) Turning Gateway B off: `project-start-refusal` on Settings, `new-run-start-refusal` on New run (Start stays enabled, verified), `role-runs-on-problem` and an explicit "(turned off)" option in the panel; turning it back on clears all three.
- (5) `[mock:bridged]`: the bridged Reviewer showed `agent-connection` on the canvas card and in the side panel ("Runs on ..."), in FinishedList with a "runs on" line, finished, and "Mock bridged report done." reached its transcript. The run waited on the Implementer's permission card until End session (default mock script, not a bridge issue).
- (6) App settings > Connections lead: "One connection is the default for new projects and assistants. Each project picks a default for its roles, and each role can run on another." Accurate. Focus ring on Runs on is a 2 px solid outline in both themes; Tab order Model summary > Runs on > Model > Exact model > Advanced.

## Not driven

- The "By connection" table (`usage-connections`). `runUsage.ts` fills it only when the run has a `connection` and an agent differs; mock-adapter runs have no run connection (read in code, not observed), so it never rendered. The mock project cannot show it; a real adapter would spend tokens.
- A second real provider, Codex/OpenAI sign-in, live-status "disconnected" wording, `proxy-family-notice`, `role-effort-unsupported`, long-name behaviour in compact node styles, a bridged report that fails, a Hide finished fold with the group selected by keyboard.
- Screen reader output, contrast measurement, System theme, macOS, Linux, packaged builds.
