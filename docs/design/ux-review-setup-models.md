# UX review: Architect and MCP assistant model settings (issue #9)

Pre-planning walk on mock data (ORGAI_MOCK=1, temp data dir), 1424x881, dark theme only (light and keyboard-only not walked; this is a placement and copy review). Shots in `e2e/shots/` (gitignored): `s2.png` (Defaults), `s3.png` (Connections), `s4.png` (MCP library), `m1.png` (Configure with AI dialog).

## Findings, ranked by user impact

### 1. High: the Defaults pane promises "new projects only" and the new controls break that promise
Evidence: `s2.png`. Section blurb "For new projects. Existing ones keep their own." The Connection row repeats "New projects only." Models, Safety and Behaviour all sit under that blurb.
A user will read an Architect model select there as "applies to new projects", change it, and see no effect on an existing project's retrospective or revision.
Recommendation: do not put the new selects in the same card as Orchestrator and Report model. Add a separate group in the Defaults pane, titled "Assistants (all projects)", with its own one-line description. Reword the section blurb so it is true: "Starting values for new projects, plus the assistants that work across all projects." Alternatively move the blurb down to the Connection and Models groups as group descriptions ("New projects only. Existing ones keep their own.") and leave the pane with no blurb.

### 2. High: nothing at the point of use says which model runs or where to change it
Evidence: `m1.png` (the "Configure with AI" dialog says only "An assistant run proposes library servers in its own window"). `NewRunPage.tsx` "Start setup" / "Resume setup", `DraftPanel.tsx` "Revise with the Architect", and the run action "Org retrospective" (tooltip: "Have the Architect review this run... Starts a session (spends tokens)") name no model either. The New project form also says "Set up with the Architect (recommended)" with no model or cost hint.
Since these runs are hardcoded to Opus today, the user cannot learn the cost tier of the most expensive-looking actions.
Recommendation: add the model to each place as quiet helper text, with a link to the setting.
- MCP dialog description: "An assistant run (uses Opus) proposes library servers in its own window. You approve each one there. Change the model in App settings > Defaults." Fill the model name from the setting, not a literal.
- Retrospective tooltip: "...Starts a session on the Architect model (Opus). Spends tokens."
- Start setup / Revise: one muted line, "Architect model: Opus. Change in App settings > Defaults."
A link that opens App settings on the Defaults pane (`APP_SETTINGS_SECTIONS.defaults` exists) is better than prose only. This is the main discoverability fix; the setting alone is not enough.

### 3. Medium: the model options mean different things per connection, and the Models group does not say so
Evidence: `s2.png` offers Opus and Sonnet for the Orchestrator and Report selects. `s3.png` shows connections list "4 models" for Anthropic and have tier mapping for OpenAI and LiteLLM (`TierEditor.tsx`, `ProjectConnection.tsx`). Architect and MCP assistant runs are not tied to a project's connection the way work runs are, so a user on LiteLLM-only cannot tell whether "Opus" resolves through their proxy mapping, the default connection, or fails.
Recommendation: store and show the choice as a tier (Fable / Opus / Sonnet / Haiku, the same labels as `modelOptions`) rather than a raw model id, and state the rule in the row description: "Runs on the default connection ({Anthropic}), using its {Opus} mapping." If the default connection is not usable, show an inline warning on the row: "Default connection is not connected. These runs will fail until you connect it." For a project-scoped run (revision, retrospective) say which connection wins; the plan should decide this before UI copy is written, and the copy must match: either "uses the project's connection" or "always uses the default connection". Flag this to the Product Designer as a spec question.

### 4. Medium: label and description proposals
- Group title: "Assistants" (not "Models"), so the existing Models group stays about role defaults.
- Row 1, title "Architect model", description "Plans and revises org charts, and reviews finished runs (setup, revision and retrospective). Applies to every project."
- Row 2, title "MCP assistant model", description "Used by Configure with AI in the MCP library. Applies to every project."
- Select labels must equal the titles (matches the existing `Select label=` pattern). Wire `describedBy` with `settingDescId` as the Connection and Safety rows do; the Models rows today have no ids or descriptions, so this would be the first described pair there.
- Place the group between Models and Safety, or last in the pane, not inside the Models card.
- Show the default value with an "(default)" suffix or helper "Default: Opus" so the user can return to it; `modelOptions` has no reset today.
- Consider a cost hint on the cheaper choices ("Faster and cheaper, may plan less carefully"). Keep it to one line.

### 5. Low-medium: adjacent confusion in the existing Models group
Evidence: `s2.png`.
- "Orchestrator model" and "Report model" have no descriptions at all, while every other row in the pane has one. A new user does not know a "report" is a sub-agent. Suggested: "Orchestrator model: Leads each new project's run." "Report model: Used by the roles that report to the orchestrator."
- The same words "Orchestrator" and "Report" appear nowhere on the Architect or MCP pages, so adding "Architect model" next to them makes four unrelated "model" rows; the grouping fix in finding 4 resolves this.
- "Prefer Sonnet near the Opus limit" (Behaviour, below the fold) is an Opus-specific switch; if the Architect can be set to Sonnet, say whether the switch affects it. Spec question.
- Default connection row says "New projects only", while the pane blurb says the same; the repetition is harmless but should go once the blurb changes.

### 6. Low: Connections page does not mention the assistants
Evidence: `s3.png` says "Where agents get their models. One connection is the default for new projects." Extend it: "The default connection also runs the Architect and MCP assistant." Only true if the plan resolves finding 3 that way.

## What works
- The Defaults pane already uses a consistent SettingRow with a described Select pattern; the new rows fit it.
- The "Configure with AI" dialog is short and its error banner has a clear title; adding one line of model text is cheap.
- Mock mode is clearly labelled (MOCK pill, "Mock mode") so a walkthrough cannot be mistaken for a live run.

## Spec questions for the Product Designer / planner
1. Do revision and retrospective runs use the setting even when the project is on LiteLLM or OpenAI, and how is the tier resolved?
2. Is "Fable" an allowed option for the Architect, as it is for Orchestrator (`modelOptions(..., false)`)?
3. Should the pane blurb change, or should "new projects only" move to group descriptions?

## Limits
Dark theme at one size only. No light theme, 1024x640 or keyboard pass, since no UI exists yet for the new controls. A walk of the built feature is still needed after implementation.
