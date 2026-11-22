# UI/UX overhaul: design mockups and handoff

Status: design only, 2026-11-22. **No app code has been changed.** These are mockups for a full redesign of the
renderer, approved in direction by the owner ("Alright I like it"). The next step is to turn them into a plan and
implement them; nothing here is wired to the app.

Published canvas (private to the owner): https://claude.ai/artifact/5uExK86oRbF6u7PqnyqHFL

## What is in this folder

| Path | What it is |
| --- | --- |
| `project/*.dc.html` | 38 boards, one screen each. Source of truth for the design. |
| `project/tokens.css` | Colour, glass, motion and type tokens for dark and light. Every board links it. |
| `project/canvas.json` | Board index: title, position and size of each board on the canvas. |
| `BOARDS.md` | List of every board by row, generated from `canvas.json`. |
| `tools/render.cjs` | Expands boards to plain HTML in `preview/` without the canvas runtime. |
| `tools/check.cjs` | Renders every board and adds a measuring overlay (natural height, off-page elements). |

`preview/` is git-ignored output.

## How to look at the boards

```
node docs/design/ui-overhaul/tools/check.cjs            # all boards
node docs/design/ui-overhaul/tools/check.cjs Run Inbox  # some boards
```

Then serve `docs/design/ui-overhaul/preview/` over http and open `Run.html`, `Inbox.html` and so on. The page title
and a green bar at the bottom report `natural <height> / board <height>` and how many elements run off the page.
Add `:light` to a name with `render.cjs` (for example `Run:light`) for the light theme.

Limits of this preview: `render.cjs` is a stand-in for the canvas runtime. It expands `<sc-for>`, `<sc-if>` and
`{{holes}}` once with default state. Clicks do nothing, and `<dc-import>` boards (`RunLight`, `ComponentsLight`) are
rendered as their source board with the light theme.

## The board format

Each `.dc.html` is a "Design" artifact component:

- Markup inside `<x-dc>`, with `{{dotted.lookups}}`, `<sc-for list="{{x}}" as="y">` and `<sc-if value="{{x}}">`.
- A `class Component extends DCLogic` in `<script type="text/x-dc">`; `renderVals()` returns the data and click
  handlers the markup reads. `this.state` / `this.setState` drive the interactive boards.
- Most boards share one shell: a sidebar built by `side(activeKey)` and, on settings pages, a settings menu built by
  `snav(activeKey)`. Both are duplicated in every file; change them with a script, not by hand.

To republish, publish each changed file to the artifact above with the Artifact tool, `root` set to this folder.

## Decisions the owner made (do not undo these)

1. **Look:** glass panels, a consistent violet (brand) and cyan (working) scheme, amber for "waiting on you", green
   for done, red for failed. Dark is the default and light is a full second theme. Motion is part of the design
   (pulses, flowing edges, rise-in), with reduced motion honoured.
2. **The canvas is the centrepiece of a run.** Chat is a small dock that can be hidden, never most of the screen.
3. **Built for many agents.** Groups, folds, filters, search and a flat agent list (see `Scale.dc.html`).
4. **Canvas themes are a dropdown**, because more are coming. Drawn: Org chart, Pocket Office, Factory floor.
5. **Code projects and engagements must look separate.** Each has its own Home: `ProjectHome` (workbench look,
   monospace labels, violet) and `EngagementHome` (serif headings, coral accent `--eng`).
6. **Engagements stay ambiguous on purpose**, so any role in any industry can use them. No fixed stages, no
   client / sponsor / deliverable vocabulary, no role-specific layouts. Role names and group names in the mockups
   (Researcher, Analyst, Writer; Research, Analysis, Drafting) are sample content the Architect would replace.
7. **No separate "Context" screen and no per-run source picker.** An earlier draft had both and the owner rejected
   them. Runs use the engagement's existing connections, and the knowledge graph is where engagement context lives.
8. **Plain language everywhere**: "Ask before risky actions", "Fast / Standard / Most capable", "Tools and services".

## How it was checked

- All 38 boards were rendered with `tools/check.cjs` and looked at once, at reduced size. None had content running
  off the page; board heights were adjusted so nothing is cut off.
- Pocket Office and Factory floor were also looked at full size, in dark and light, and fixed.
- **Not checked:** behaviour inside the published canvas (Play mode clicks, the theme dropdown), small text, a
  screen reader, real data volumes. The boards edited last (neutral engagement wording, the neutral
  `EngagementHome`) passed the render check but were not looked at again.

## Things the mockups invent (check before building)

These are proposals, not existing behaviour:

- An **Inbox** that collects every waiting decision across projects.
- **Cost and time estimates** on New run, a weekly cost on Schedules, "Continue from here" on run history.
- The options offered when a run stops (`RunHold.dc.html`): add budget, switch provider mid-run, skip review.
- Individual settings such as "Play a sound" and "Warn me at 80%".
- "The team can / cannot" lists per tool on Tools and services.
- Renamed assistants: "Tools helper" and "Skills helper" for the MCP and Skill assistants.
- A "Home" tab on every project and engagement.
- "Showing the 14 most connected of 42" on Knowledge; the app's notes say the real graph always draws everything.

## Loose ends

- `Settings.dc.html` (Permissions) still has its own, older settings menu, not the shared `snav` one.
- The project "Basics" settings page is in the menu but not drawn.
- `Run.dc.html` has no "Running now | All runs" switch; `History.dc.html` does.
- Pocket Office and Factory floor are drawn at 16 agents only, with plain shapes, not the app's sprites or 3D.
- The 121-agent view exists for the Org chart theme only.
- `RunHold.dc.html` keeps the normal run's conversation dock, which still shows an old `npm test` request.
- Sample data is illustrative throughout (names, costs, counts, provider and model names).

## Where this lands in the app

Read `.orgai/ARCHITECTURE.md` and `docs/agent-notes/renderer.md` first. Rough mapping:

| Boards | Renderer area |
| --- | --- |
| `Main`, `ProjectHome`, `EngagementHome`, `Empty` | `views/DashboardView.tsx`, `components/dashboard/` |
| `Run`, `Scale`, `RunHold`, `Agent`, `Engagement` | `views/LiveRunView.tsx`, `components/canvas/`, `TranscriptPanel`, `DecisionTray` |
| `Office`, `Factory` | `lib/office/`, the Factory Floor scene (on `dev`; see `docs/design/factory-floor.md` there) |
| `Team`, `EngagementTeam`, `Import`, `Templates` | `views/TeamView.tsx`, `components/team/`, `import/`, `templates/` |
| `Components` (decision cards) | `PermissionCard`, `QuestionCard`, `ProposalCard`, `RuleRequestCard`, `MergeReviewCard`, `McpInstallCard` |
| `Files` | `views/OutputsView.tsx`, `components/outputs/` |
| `Knowledge` | `views/KnowledgeView.tsx`, `components/knowledge/` |
| `Usage`, `History` | `views/UsageView.tsx`, `RunHistory`, `UsageTrends` |
| `Schedules` | `views/SchedulesView.tsx` |
| `Settings*`, `Appearance`, `Limits`, `Branches`, `About`, `Providers`, `Tools`, `Skills` | `views/SettingsView.tsx`, `views/AppSettingsView.tsx`, `components/settings/`, `connections/`, `mcp/`, `skills/` |
| `Welcome`, `NewProject`, `NewRun`, `Trust` | `components/dashboard/NewProjectForm.tsx`, `NewRunPage.tsx`, `FolderTrustNotice.tsx` |
| `tokens.css` | `src/renderer/src/styles/tokens.css` |

A sensible first slice is the tokens and shared primitives (`Components.dc.html`), then the run view, because every
other screen reuses them. Existing e2e selectors (`data-testid`s listed in `docs/agent-notes/renderer.md` and
CLAUDE.md) must keep working or be updated in the same change.
