<div align="center">

<img src="build/icon.png" alt="OrgAI logo" width="96" height="96">

# OrgAI

**Run a project's org chart of AI agents and watch the work happen.**

Made by [Cybrid Software LLC](https://cybridsoftware.com).

[![Latest release](https://img.shields.io/github/v/release/perrychapman/OrgAI?label=release)](https://github.com/perrychapman/OrgAI/releases/latest)
[![CI](https://github.com/perrychapman/OrgAI/actions/workflows/ci.yml/badge.svg?branch=dev)](https://github.com/perrychapman/OrgAI/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
![Platforms](https://img.shields.io/badge/platforms-Windows%20%7C%20macOS%20%28untested%29-informational)

[Download](#download) · [Quick start](#quick-start) · [How it works](docs/how-it-works.md) · [Contributing](CONTRIBUTING.md)

</div>

<p align="center">
  <img src="docs/media/hero.gif" alt="A run on a code project: the orchestrator appears on the canvas, delegates to two implementers, an approval card for an edit appears and is allowed, and the run goes idle." width="100%">
</p>

OrgAI is a desktop app. You describe a team as an org chart (roles, prompts, tools, who may delegate to whom), give it
a task, and the live view draws that chart as the work runs: every agent appears on the canvas the moment it is
spawned, with its state, activity, tokens and cost. It runs on your own Claude Code login or API key, Codex (OpenAI), or
a LiteLLM or other OpenAI-compatible proxy. Projects, runs and settings are stored on your computer.

## Terminal workspace

After building, run `npm run cli -- tui` (or `orgai` when installed on your PATH). The terminal opens with a
window-sized workspace with the conversation on the left, the configured team on the right, and a prompt at the bottom.
Agent colors match across the conversation and roster. A shimmering activity line above the prompt describes the reported work,
with elapsed time and token totals; one footer keeps the remaining status and shortcuts together.
Type `/` for searchable commands, Ctrl+O to expand tool details, and Tab to move between panes.
Decisions appear inline above the prompt; Shift+Tab selects the decision without interrupting ordinary typing.
Esc twice interrupts a working run from the composer. Enter sends; Alt+Enter adds a line.

Folders that are not registered projects open setup choices in the same terminal flow, at the current window size. Use Up/Down and
Enter to choose a quick run, guided setup, or the default team; the numbered shortcuts still work. The orgai TUI
answers every approval and question card itself.

`--inline` keeps the conversation in terminal scrollback. `--ax-screen-reader` uses plain labels, and
`--no-color` disables styling. Set `ORGAI_REDUCED_MOTION=1` to keep shimmer and activity indicators still. Animation also
stays off in inline mode, for screen readers, dumb terminals and no-color output. Spinners appear only while a
folder check, project setup, or run is actually working.

The input surface follows `COLORFGBG` when available, with a readable dark default.
Set `ORGAI_THEME=light` or `ORGAI_THEME=dark` to choose its appearance explicitly.
The [terminal style guide](docs/design/tui-style.md) follows the app's theme tokens: violet actions, blue work,
distinct agent labels and message directions, and green/amber/red status text. The logo is white on dark and dark ink on light.

Agent messages appear beside the team, with recent exchanges in the agent inspector (Enter on an agent).
The transcript marks teammates joining and finishing, renders basic Markdown, and groups completed tool
activity; Enter in the transcript expands or collapses those groups. A finished run shows its recorded
outcome, elapsed time, file changes and check results. Message previews are bounded and begin when the
terminal attaches; they are not a reconstructed message history.

![Terminal run from prompt through delegation, inline approval, and completion](docs/media/tui-team-dark.gif)

*Actual TUI captured with scripted agents in an isolated demo project: prompt, delegation, inline approval, an approved file edit, and completion. [Light version](docs/media/tui-team-light.gif).*

| | |
| --- | --- |
| **Plan** | An Architect agent interviews you or reads your repository, then proposes the architecture, the org chart and the run settings as cards you approve. |
| **Run** | An orchestrator delegates to the team. Writers work in separate git worktrees and merge back. Runs keep going until their plan is done. |
| **Review** | Edits and commands ask first (or follow rules you saved). Transcripts, costs and past runs are kept per project. |

## Features

### Watch the team work

The orchestrator and every subagent show up on the canvas as they are created, attached to the agent that spawned
them. Click an agent for its transcript, open the Plan, Usage and Logs tabs, or hide finished agents to keep a big
run readable. The canvas has several styles, in dark and light themes. Each agent shows the model tier and effort it
runs on, and the Plan tab shows which steps are ready, waiting or running.

<p align="center"><img src="docs/media/hero-light.png" alt="The same run in the light theme: an orchestrator with two implementers, one reported back and one ended without a result." width="80%"></p>

Prefer something livelier? Switch the canvas presentation to **Pocket Office**: the team becomes one pixel-art building
you pan and zoom, with the orchestrators in the lobby and each department in its own room. People who are working type
at their desks, new agents walk in through the front door, an agent waiting on you raises a hand, and messages appear
as bubbles at the person they are for, with a message log below the scene. Pause motion stops every animation, and
the scene stays still when your system asks for reduced motion.

### Choose how each run runs

Above the composer, a run settings row shows the model, effort, permission mode and goal for the run. Change them
before you start, or switch the model and the permission mode while the conversation goes on (a wider permission
mode asks you to confirm first). Switching to a model on another connection asks you to end the session first; your next
message then carries the conversation over to the new model. The orchestrator also picks a tier and effort for each report it starts, within the limits you set
on the chart.

### Set up with an Architect

A new project starts from an idea or an existing folder. The built-in Architect proposes the architecture, the org
chart and the settings, and nothing is applied until you approve each card or send it back with feedback. The approved
architecture is written to `.orgai/ARCHITECTURE.md` and referenced from `CLAUDE.md`, so later agents inherit it.

<p align="center"><img src="docs/media/setup.gif" alt="A new project is created with the Architect. A command approval and three proposal cards (architecture, org chart, settings) are approved, then the Team tab opens on the proposed chart." width="100%"></p>

### Edit the team

The Team tab is the org chart editor: add roles, set each role's tools, model, skills and connections, and draw who
reports to whom. Templates and team files in the repository let a team travel with the code.

<p align="center"><img src="docs/media/team.png" alt="The Team tab: an Orchestrator leading an Implementer, a Reviewer and a Researcher, with the Orchestrator's settings open." width="100%"></p>

### See what needs you

The Dashboard collects every decision waiting on you across projects, the runs in progress, last week's cost and the
state of your connections. Approvals come as cards (allow once, for the session, or for the project), so an unattended
run stops only when it should. The Usage page breaks cost and tokens down by project, run and model.

<p align="center"><img src="docs/media/dashboard.png" alt="The Dashboard: two decisions waiting under Needs you, five runs, three projects and a cost summary." width="100%"></p>

### Keep what a team learns

Engagement projects (work for a client or a case, in a plain folder) have a Knowledge tab. Agents record people,
organisations, decisions and risks as they work, and you can read, edit and retire them in a list or on a graph.

<p align="center"><img src="docs/media/knowledge.gif" alt="The Knowledge tab of an engagement: the list of recorded items, then the Graph view with Acme Corp, Jane Doe, a decision and a risk." width="100%"></p>

### Keep what a run produces

Documents, workbooks, slide decks, diagrams and data files that agents produce appear in the project's Outputs tab
and in the run's side panel. A revision adds a new version instead of replacing the old one, and notes you leave on an
output are passed to the agents the next time they revise it.

### Start from a repository

New project has a From GitHub segment: paste `owner/name`, pick a folder and OrgAI clones it with your own git (or
forks it with `gh`). A repository's own agent settings stay switched off until you review and allow them.

<p align="center"><img src="docs/media/clone.gif" alt="The New project dialog on From GitHub: a repository address and a folder are typed, Clone is pressed, and the cloned folder is reported with the agents found in it." width="100%"></p>

### Chat without a project

Chat is an assistant that needs no project and is read-only unless you allow edits. There are also an MCP assistant and a Skill assistant that help
you add tools and skills to your library; you manage both under App settings > Connectors and Skill library.

<p align="center"><img src="docs/media/chat.gif" alt="The Chat assistant: a question is typed and answered, then a follow-up." width="100%"></p>

The pictures above come from the built-in mock adapter, so they show scripted agents and made-up projects. They are
generated by `npm run media:readme`.

## Download

Get the latest build from the [Releases page](https://github.com/perrychapman/OrgAI/releases/latest).

- **Windows**: `OrgAI-Setup-<version>.exe` (installer) or `OrgAI-Portable-<version>.exe`. This is the platform it has
  been tested on.
- **macOS**: `.dmg` or `.zip`, for Apple silicon (arm64) or Intel (x64). The builds are unsigned: right-click the app
  and choose Open the first time. Nobody has run OrgAI on a Mac by hand yet; `docs/macos-testing.md` is the checklist.
- **Linux**: an AppImage is configured but untested. Build from source if you want to try it.

## Quick start

1. **Install** OrgAI and start it.
2. **Connect a provider** in App settings > Connections: sign in with Claude Code (`claude` then `/login`) or add an
   Anthropic API key, or connect OpenAI (Codex) or a LiteLLM or OpenAI-compatible proxy. Claude is the most exercised
   connection; Codex and proxies are implemented but have seen less live use.
3. **Create a project**: New project, point it at a repository folder, keep "Set up with the Architect" on, approve the
   proposals, then start a run from the Live tab.

No account to try it first? Start the app with `ORGAI_MOCK=1` (see below) and keep "Use the mock adapter" ticked when you create a
project. It plays scripted agents and spends nothing.

## The `orgai` command

A standalone terminal product, separate from the desktop app: it has its own data folder, its own settings and its own
vault, and shares nothing with the app. Install it with `npm i -g orgai-cli`. From a checkout, run `npm run build` and
then `npm run cli -- <command>`.

```text
$ orgai runs list --project ./acme-billing
RUN  STATUS   NAME                   KIND  STARTED      COST
R1   Stopped  Add a health endpoint  Run   1m ago   $0.01001
```

`orgai projects list` lists the projects the command knows, `orgai exec "<task>"` runs a task headless, `orgai tui`
opens a terminal view (give a run, as in `orgai tui R1`, to open a saved one) and `orgai doctor` checks your setup.
`orgai --help` lists the rest. The CLI has been run on macOS in tests; it has not been run on Windows or Linux yet.

## Build from source

Needs Node 22 or newer.

```sh
npm install
npm run dev          # dev server with hot reload
npm run build        # production bundles into out/
npx electron .       # launch the built app
ORGAI_MOCK=1 npm run dev   # scripted mock adapter: UI work with no tokens
```

In PowerShell, set the variable first: `$env:ORGAI_MOCK=1; npm run dev`.

`npm run check` runs typecheck, unit tests, build and the free end-to-end flows; none of them spend tokens. The full
end-to-end chain takes a while, and CI runs it on Windows and macOS on every push to dev.
See [docs/testing.md](docs/testing.md) for the testing guide.

## Docs and contributing

- [How it works](docs/how-it-works.md): setup, worktree isolation, limits, permission modes, the agent network, unattended
  execution and how to add a provider.
- [.orgai/ARCHITECTURE.md](.orgai/ARCHITECTURE.md): the stack, modules and conventions. [CLAUDE.md](CLAUDE.md) holds the
  notes for working in this repository, including what has and has not been verified.
- [docs/design](docs/design): UI specs and the UX walk-throughs.
- [CONTRIBUTING.md](CONTRIBUTING.md): branches (`dev` for work, `main` for releases), releases and commands.

OrgAI is built with an Electron main process, a React 19 renderer and TypeScript.

## License

OrgAI is made by [Cybrid Software LLC](https://cybridsoftware.com) and released under the MIT License. See
[LICENSE](LICENSE).
