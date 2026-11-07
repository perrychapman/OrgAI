<div align="center">

<img src="build/icon.png" alt="OrgAI logo" width="96" height="96">

# OrgAI

**Run a project's org chart of AI agents and watch the work happen.**

Made by [Cybrid Software LLC](https://cybridsoftware.com).

[![Latest release](https://img.shields.io/github/v/release/perrychapman/OrgAI?label=release)](https://github.com/perrychapman/OrgAI/releases/latest)
[![CI](https://github.com/perrychapman/OrgAI/actions/workflows/ci.yml/badge.svg?branch=dev)](https://github.com/perrychapman/OrgAI/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
![Platforms](https://img.shields.io/badge/platforms-Windows%20%7C%20macOS%20%7C%20Linux-informational)

[Download](#download) · [Quick start](#quick-start) · [How it works](docs/how-it-works.md) · [Contributing](CONTRIBUTING.md)

</div>

<p align="center">
  <img src="docs/media/hero.gif" alt="A run on a code project: the orchestrator appears on the canvas, delegates to two implementers, an approval card for an edit appears and is allowed, and the run goes idle." width="100%">
</p>

OrgAI is a desktop app. You describe a team as an org chart (roles, prompts, tools, who may delegate to whom), give it
a task, and the live view draws that chart as the work runs: every agent appears on the canvas the moment it is
spawned, with its state, activity, tokens and cost. It runs on your own Claude Code login or API key, Codex (OpenAI) or
a LiteLLM proxy. Projects, runs and settings are stored on your computer.

## Terminal workspace

After building, run `npm run cli -- tui` (or `orgai` when installed on your PATH). The terminal opens with a
window-sized workspace with a compact header at the top left and a prompt at the bottom. Active runs show the conversation, agents, plan and worktrees, with
live activity and elapsed time. Working agents have individual spinners, and a live activity line sits above
the prompt. A soft shimmer marks thinking labels; the logo, menus and borderless input stay still. Type `/` for searchable commands; Tab moves between panes, Alt+D focuses
decisions, and Esc twice interrupts a working run from the composer. Enter sends; Alt+Enter adds a line.

Folders that are not registered projects open setup choices in the same terminal flow, at the current window size. Use Up/Down and
Enter to choose a quick run, guided setup, or the default team; the numbered shortcuts still work. Any terminal
access limitation appears alongside those choices, without changing the permissions granted by the desktop app.

`--inline` keeps the conversation in terminal scrollback. `--ax-screen-reader` uses plain labels, and
`--no-color` disables styling. Set `ORGAI_REDUCED_MOTION=1` to keep shimmer and activity indicators still. Animation also
stays off in inline mode, for screen readers, dumb terminals and no-color output. Spinners appear only while a
folder check, project setup, or run is actually working.

The input surface follows `COLORFGBG` when available, with a readable dark default.
Set `ORGAI_THEME=light` or `ORGAI_THEME=dark` to choose its appearance explicitly.

Agent messages appear beside the team, with recent exchanges in the agent inspector (Enter on an agent).
The transcript marks teammates joining and finishing, renders basic Markdown, and groups completed tool
activity; Enter in the transcript expands or collapses those groups. A finished run shows its recorded
outcome, elapsed time, file changes and check results. Message previews are bounded and begin when the
terminal attaches; they are not a reconstructed message history.

| | |
| --- | --- |
| **Plan** | An Architect agent interviews you or reads your repository, then proposes the architecture, the org chart and the run settings as cards you approve. |
| **Run** | An orchestrator delegates to the team. Writers work in separate git worktrees and merge back. Runs keep going until their plan is done. |
| **Review** | Edits and commands ask first (or follow rules you saved). Transcripts, costs and past runs are kept per project. |

## Features

### Watch the team work

The orchestrator and every subagent show up on the canvas as they are created, attached to the agent that spawned
them. Click an agent for its transcript, open the Plan, Usage and Logs tabs, or hide finished agents to keep a big
run readable. The canvas has several styles, in dark and light themes.

<p align="center"><img src="docs/media/hero-light.png" alt="The same run in the light theme: an orchestrator with two implementers, one reported back and one ended without a result." width="80%"></p>

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
run stops only when it should.

<p align="center"><img src="docs/media/dashboard.png" alt="The Dashboard: two decisions waiting under Needs you, five runs, three projects and a cost summary." width="100%"></p>

### Keep what a team learns

Engagement projects (work for a client or a case, in a plain folder) have a Knowledge tab. Agents record people,
organisations, decisions and risks as they work, and you can read, edit and retire them in a list or on a graph.

<p align="center"><img src="docs/media/knowledge.gif" alt="The Knowledge tab of an engagement: the list of recorded items, then the Graph view with Acme Corp, Jane Doe, a decision and a risk." width="100%"></p>

### Start from a repository

New project has a From GitHub segment: paste `owner/name`, pick a folder and OrgAI clones it with your own git (or
forks it with `gh`). A repository's own agent settings stay switched off until you review and allow them.

<p align="center"><img src="docs/media/clone.gif" alt="The New project dialog on From GitHub: a repository address and a folder are typed, Clone is pressed, and the cloned folder is reported with the agents found in it." width="100%"></p>

### Chat without a project

Chat is an assistant that needs no project and is read-only unless you allow edits. There are also an MCP assistant and a Skill assistant that help
you add tools and skills to your library.

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
   Anthropic API key, or connect OpenAI (Codex) or a LiteLLM proxy. Claude is the most exercised connection; Codex and
   LiteLLM are implemented but have seen less live use.
3. **Create a project**: New project, point it at a repository folder, keep "Set up with the Architect" on, approve the
   proposals, then start a run from the Live tab.

No account to try it first? Start the app with `ORGAI_MOCK=1` (see below) and keep "Use the mock adapter" ticked when you create a
project. It plays scripted agents and spends nothing.

## The `orgai` command

A terminal front end to the same app and data. In an installed app, turn on Terminal access in App settings and
install the command from General > Advanced > Terminal. From a checkout, run `npm run build` and then
`npm run cli -- <command>`.

```text
$ orgai runs list --project ./acme-billing
RUN  STATUS   NAME                   KIND  STARTED      COST
R1   Stopped  Add a health endpoint  Run   1m ago   $0.01001
```

`orgai projects list` lists your projects, `orgai exec "<task>"` runs a task headless, `orgai tui` opens a terminal view
of a live run, `orgai decide` answers a decision card and `orgai doctor` checks your setup. `orgai --help` lists the
rest. The CLI has been run on macOS in tests; the packaged shim has not been run on
Windows or Linux yet.

## Build from source

Needs Node 22 or newer.

```sh
npm install
npm run dev          # dev server with hot reload
npm run build        # production bundles into out/
npx electron .       # launch the built app
ORGAI_MOCK=1 npm run dev   # scripted mock adapter: UI work with no tokens
```

`npm run check` runs typecheck, unit tests, build and the free end-to-end flows; none of them spend tokens.
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
