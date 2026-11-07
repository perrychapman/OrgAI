# UX review: model and connection surfaces before multi-provider org charts (pre-walk)

Reviewer: UX Researcher. Build: d53360d3 (`npm run build` in this worktree). Ran on the mock adapter (`ORGAI_MOCK=1`, throwaway data dir), Playwright over `e2e/lib.mjs`, 1600x1000 and 1024x640, dark and light (`data-theme`). Mouse first, then a Tab pass through the Team role panel at 1024x640. Compared with: CLAUDE.md "Proxy connections", "Settings pages" and `docs/design/proxies.md` (read only). Shots and raw output: `e2e/shots/ux/multi-provider/` (gitignored; scripts `walk1..6.mjs`, outputs `walk*.out`). No renderer code changed.

Setup: a mock proxy "Mock gateway" (LiteLLM kind, host mock-proxy.example.com, key `any-key`) added through the Add proxy dialog (shot `proxy-dialog-1600-dark`), then connected. It lists 9 models: Claude 4, GPT 2, Other 3. Anthropic showed "Connecting / Waiting for the browser sign-in" on the very first load and "Connected, 5 models" a few seconds later (mock timing; not a finding).

## Verdict

NOT READY FOR PER-ROLE CONNECTIONS WITHOUT COPY AND LAYOUT WORK. Today a project has one connection, roles hold only a tier or a model id, and the role panel never names a provider. The picker already groups by model family inside a proxy, which is the closest thing to what the feature needs. Three things would break or mislead: the word "Connections" already means MCP services in the role panel, "Default connection for roles" copy and the remap dialog assume one connection, and the family notice lives only in Project settings.

## Answers to the brief

1. Where a per-role Connection choice lives. In the role panel's Model section (shot `role-proxy-1024-dark`), as the first control inside the "Model" disclosure, above Model and Exact model, because the model list depends on it. Show it only when two or more connections are connected (same rule as `new-project-connection-select`); otherwise keep today's UI and say nothing. Default value "Project default (Mock gateway)". Do NOT call it "Connection": the same panel already has a "Connections" group that means MCP services ("Add a connection", `role-add-connection`). Suggested words: label "Runs on", options "Project default (Anthropic)", "OpenAI", "Mock gateway (proxy)"; node chip: tier word plus a short provider tag only when it differs from the project default ("Everyday · OpenAI"); tooltip "Runs on OpenAI, not this project's default (Anthropic)". The chip today shows only the tier word or a bare model id (`gpt-6-sol`, shot `orch-gpt-1600-dark`), never the provider.
2. Remap today. Project settings > General > Connection is a radio list; picking another connection shows a dashed "(current)" marker and a "Review changes / Cancel" row (shot `remap-step`), then the dialog "Apply this mapping?" lists each role as `opus -> claude-opus-5`, a per-connection block "On Mock gateway" with Deep / Everyday / Fast mapping, a "Top is not mapped" note and "This preview is computed from your current settings. The result is shown after applying, with Undo." (shot `remap-dialog-1024-light`). It rewrites every role. With per-role connections, a remap must say which roles it touches: roles on "Project default" move, roles pinned to a connection keep it. The dialog needs a second list ("Not changed: Reviewer stays on OpenAI") and Undo must restore pins. A pinned role whose connection is later disconnected needs the same inert/not-connected treatment the radio list already has ("Not connected. Connect it in App settings > Connections.").
3. Copy that says one connection per project (all seen in the app unless marked code):
   - Project settings > Connection lead: "Default connection for roles in this project. App default for new projects: Anthropic." (already says "default"; keep, it is the right hook) and the select/radio group name "Default connection for roles".
   - Summary line: "4 roles use Mock gateway by default · Everyday tier: claude-sonnet-5-5" (also says "by default"; it will need "N roles pinned elsewhere").
   - "Role models on Mock gateway" disclosure title: assumes one provider.
   - New project: "Roles start on this connection's models. Manage connections" (fine, "start"), and the sentence "Runs on the mock adapter (no tokens)." for mock projects.
   - App settings > Connections lead: "One connection is the default for new projects and assistants; each project can switch in its own Settings." Must add "each role can use another".
   - Mock-adapter project: "This project runs on the mock adapter, so the connection applies once you turn it off." (project-level only).
   - Proxy family notice: "OpenAI orchestrator; 2 roles on other model families run through the proxy." Family wording, not connection wording.
   - Code only (not seen): `mixedFamilyRefusal` / `startRefusal`, "one connection per project" in ARCHITECTURE.md and CLAUDE.md prose.

## Findings

### H1 The role panel gives no hint which provider a model runs on, and no notice appears where the choice is made
Screen: Team > role panel. Shots `role-gpt-proxy-1600-dark`, `orch-gpt-1600-dark`. Steps: create a project with the Mock gateway chosen in the New project Connection select, open Team, click Reviewer, open Model, pick `gpt-6-sol` under Exact model. The node chip becomes `gpt-6-sol`; no banner or hint on the Team tab. The only notice ("OpenAI orchestrator; 2 roles on other model families run through the proxy.", `proxy-family-notice`) is on Project settings, a different tab, and says "family", not provider. With several providers, a user cannot tell from the Team tab that the Reviewer now bills and routes elsewhere. Fix: provider tag on the chip and a line under the model select ("Runs on Mock gateway"), a Team-tab notice that links to the settings line when roles differ from the project default.

### H2 "Connections" in the role panel already means MCP services
Screen: role panel, group "Connections" with "Add a connection" and "Ask the Team assistant" (shot `role-adv-1024-dark`). A first-time user looking for provider choice finds this group first. A new "Connection" control beside it would collide in labels, screen reader headings and `role-add-connection`. Fix: name the provider control "Runs on" (see Q1), and consider "Services" for the MCP group; do not reuse "connection" for both in one panel.

### M1 Picker never says which connection a model list belongs to
Exact model options on the proxy project are grouped by family only: Claude, GPT, Other, each option suffixed `· Claude` / `· GPT` (shot `role-proxy-1024-dark`; the select hint reads "Any model Mock gateway serves."). On the Anthropic project the list is just `fable, opus, sonnet, haiku, mock-lyric` with no hint. The hint line is the only provider cue. With per-role connections the picker needs the provider first, family second (optgroup "Mock gateway · GPT"), and the hint must change when the connection changes. Model tiers (Deep/Everyday/Fast) resolve per connection, so tier labels like "Everyday (claude-sonnet-5-5)" must be re-evaluated per role connection; "Top" vanishes on the proxy (not mapped) and would silently differ per role.

### M2 The panel header says "Model Everyday" while the real model is a Custom or pinned one, and "Advanced" looks like a link
Shots `role-proxy-1024-light`, `orch-gpt-1600-dark`. The disclosure summary reads "Model  Everyday" (tier word) or "Model  Custom"; the pinned id shows only after opening. "Advanced" is plain accent text with no chevron, so its affordance is weak. Adding a provider control would make three nested levels (Model > Advanced > Effort). Keep provider and model in the main Model block; leave only Effort under Advanced.

### M3 Connection choice at project creation is hidden below the sticky submit row at 1600x1000 and below the fold at 1024x640
Shot `newproject-1600-dark` (first walk): the "Connection" label sits at the very bottom, partly under the sticky "Create project" row; the select is the last field, after the mock-adapter checkbox. At 1024x640 the form needs a scroll to reach it (`np-1024-light`). It only appears when two or more connections are connected, so first-time users meet it unprepared. Per-role connections reduce its importance (it becomes "default for roles"); move it above the checkboxes and label it "Default for roles".

### M4 Project settings Connection block is below the fold at 1024x640 and the remap needs two steps with an easy-to-miss row
Shot `ps-proxy-1024-light`: the Connection heading is at y~588 of 640. After choosing a radio, "Review changes / Cancel" appears below the list (`remap-step`) with no announcement I could verify; focus stays on the radio. Adding a per-role "Pinned roles" list below would push this further down. Put the mapping summary in the same card and move focus/announce on selection.

### M5 Role panel is a nested scroller with a sticky header, 311 px wide at 1024x640
Metrics: the Model select is 311 px wide at 1024x640 (321 px at 1600), at y=359 only after scrolling; the panel header ("RE Reviewer / Remove") overlays the scrolled content (the Description textarea is cut mid-line under it, shots `role-proxy-1024-dark`, `role-adv-1024-dark`). A new "Runs on" select above Model adds ~60 px to a panel that already needs scrolling to reach Model, and the 4th-level Effort. Under the keyboard Tab pass (Role tab > Remove > Name > tools Edit > Add a connection > Ask the Team assistant > Add a skill > Ask > Identity summary > Slug > Description > Reports to > Color > Model summary > Model > Advanced summary > Exact model > Effort > Responsibilities > System prompt) there are 20 stops before the prompt; Model is stop 15. A new select adds a stop; keep it adjacent to Model and make sure focus scrolls it into view (it did for existing controls; ring is a 2 px outline everywhere, seen in both themes).

### M6 Effort options change with the model but the reason is invisible
Reviewer (Claude): Default, low, medium, high, xhigh, max. Orchestrator after picking a GPT id: Default, low, medium, high (shot `orch-gpt-1600-dark`, Effort list from `walk6.out`). `role-effort-unsupported` was not shown in any state I could reach (its text query timed out), so a role moved to another provider silently loses `xhigh`/`max`, and a stored `max` would become unsupported with no message I saw. Per-role connections make this common. Say "Not available on OpenAI: max" next to Effort.

### L1 Pinning the root to GPT in a Claude project shows no refusal or warning in this walk
Orchestrator -> `gpt-6-sol` on the proxy project: no alert on Team, Live or Start (alerts text in `walk6.out` shows only "Saved 12:48 AM"). The "This project cannot start as configured" banner was not reproduced; I did not find a state that triggers it (needs a LiteLLM root with no family). Treat the banner as unverified.

### L2 Chip shows a bare model id, not a friendly name
`gpt-6-sol` as the entire chip (shot `team-after-gpt`). Fine for a power user, but with provider tag it should read "gpt-6-sol · OpenAI".

### L3 Fresh project says "Team files changed, not committed" on the Team tab
Appears immediately after creation in every team shot (`team-1600-dark`). Pre-existing, unrelated, noted because it shares the toolbar row where a provider notice would go.

## What must not break

- New project: `new-project-connection-select` appears only with 2+ connected; sentence `new-project-connection` otherwise; mock projects hide it. A refused remap holds the form and starts no setup.
- Project settings: `project-connection-option[data-state]` radios (disconnected one marked and inert), "(current)" marker, Review changes dialog with Undo, mock-adapter line.
- Role panel: `role-model`, `role-model-fold`, `role-model-advanced`, `role-exact-model` (Custom when a pinned id is outside the tiers; Not set returns to the tier), `role-effort`, node chip tier word with the model in the tooltip.
- Proxy hint "Any model <name> serves." and "does not report prices or spend" wording; unknown cost never $0.
- Both themes and 1024x640 without page scroll (verified: `scrollWidth` equals `clientWidth` at all four size/theme combos in the role panel and on Settings).
- Focus ring and tab order of the role panel (verified above).

## Not driven

- Anthropic and OpenAI sign-in (OpenAI stayed "Not connected"; so no state with three connected providers and no real family/provider mismatch beyond the single proxy).
- A real remap with Apply and Undo (I only opened the dialog); remap with pinned roles (does not exist yet).
- The "This project cannot start as configured" banner and `project-start-refusal` (could not reach the state).
- `role-effort-unsupported`, the disabled picker when no connection is connected, screen reader output, System theme, macOS and Linux, packaged build.
- Starting a run on a mixed-provider chart (the mock adapter accepted the Start click; I did not verify what the run did).
