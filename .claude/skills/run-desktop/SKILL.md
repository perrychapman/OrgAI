---
name: run-desktop
description: Launch and drive the built OrgAI Electron app
---

# Run and drive OrgAI

`driver.mjs` (next to this file) is a stdin REPL over playwright-core's `_electron`. It launches the **built** app
from `out/` with the Electron binary in `node_modules` and prints `OK` or `ERR <message>` after every command.

## Prerequisites

- `npm run build` first. The driver refuses to launch without `out/main/index.js`, and it never sees source edits
  until you rebuild.
- The app uses the real user data dir (`%APPDATA%/orgai`), so you see the user's projects. Delete any project you
  create. Tick **Skip AI setup** when creating projects: setup sessions and runs spend real tokens.

## Start it

Scripted (works everywhere, including Windows without tmux):

```sh
printf 'launch\nclick Projects\nss projects\nquit\n' | node .claude/skills/run-desktop/driver.mjs
```

Interactive under tmux (WSL, macOS, Linux):

```sh
tmux new-session -d -s orgai 'node .claude/skills/run-desktop/driver.mjs'
tmux send-keys -t orgai 'launch' Enter
tmux capture-pane -p -t orgai | tail -20
```

## Commands

| command | does |
| --- | --- |
| `launch` | start the app, wait for the sidebar |
| `ss <name>` | screenshot to `e2e/shots/<name>.png` (gitignored); prints the path, open it with Read |
| `click <css or text>` | first CSS match, else first element whose text is exactly / contains `<text>` |
| `type <css> <text>` | fill an input; backtick-quote selectors with spaces: ``type `input[placeholder="My app"]` Demo`` |
| `press <key>` | `Enter`, `Tab`, `Control+A`, ... |
| `text <css>` | print `innerText` |
| `eval <js>` | evaluate an expression in the renderer (awaited); `window.orgai.*` is the preload API, e.g. `eval (await window.orgai.projects.list()).map(p => p.name)` |
| `quit` | close the app and exit (also on stdin EOF) |

`ORGAI_APP_DIR` and `ORGAI_SHOTS_DIR` override the app and screenshot directories.

## Gotchas

- The "Skip AI setup" checkbox input is visually hidden; `click Skip AI setup` (its label text) works, clicking
  `input[type=checkbox]` times out.
- Chips render uppercase via CSS, so `text` returns `1 UNCOMMITTED`; match case-insensitively.
- `confirm()` dialogs (Delete project, Discard, Remove OrgAI files) are auto-accepted and echoed as `[dialog accepted]`.
- `.draft-box` is used by several panels; scope selectors (e.g. the Maintenance block) instead of taking `.last()`.
- The projects view has its own `.topbar`; to know a create finished, wait for `form.card` to disappear.
- Ready-made flows live in `e2e/` (`npm run e2e:free` is token-free); reuse `e2e/lib.mjs` for longer scripts.
