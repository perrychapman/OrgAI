---
name: run-desktop
description: "Launch and drive the built OrgAI Electron app with a small command driver: click, type, read text, evaluate in the renderer, take screenshots. Use to check a UI change by hand, reproduce a renderer bug or look at a screen. Runs token-free on the mock adapter with a throwaway data dir. For repeatable checks use e2e scripts instead."
---

# Run and drive OrgAI

`.claude/skills/run-desktop/driver.mjs` in the repo is a stdin REPL over playwright-core's `_electron`. It launches the **built** app from `out/` with the Electron binary in `node_modules` and prints `OK` or `ERR <message>` after every command.

## Rules

- Run `npm run build` first. The driver refuses to launch without `out/main/index.js` and never sees source edits until you rebuild.
- Always set `ORGAI_MOCK=1` and a fresh `ORGAI_DATA_DIR`. Without them the app opens the user's real projects and a run can spend real tokens. Use the real profile only when the user asks for it.
- Run the driver from its repo path, not from the copy beside this file. The driver finds the app and `playwright-core` relative to its own location, so a copy elsewhere needs `ORGAI_APP_DIR` and still may not resolve its import.

## Start it

PowerShell:

```powershell
$env:ORGAI_MOCK='1'; $env:ORGAI_DATA_DIR="$env:TEMP\orgai-walk"
'launch','ss home','quit' | node .claude/skills/run-desktop/driver.mjs
```

Bash:

```sh
printf 'launch\nss home\nquit\n' | ORGAI_MOCK=1 ORGAI_DATA_DIR=/tmp/orgai-walk node .claude/skills/run-desktop/driver.mjs
```

A piped command never matches a saved permission rule, so expect a permission card. If that gets in the way, write a script on `e2e/lib.mjs` instead.

Delete the data dir to reset. App settings > About shows the data and logs folders.

## Commands

| command | does |
| --- | --- |
| `launch` | start the app, wait for `.sidebar` |
| `ss <name>` | screenshot to `e2e/shots/<name>.png` (gitignored); prints the path, open it with Read |
| `click <css or text>` | first CSS match, else first element whose text is exactly / contains `<text>` |
| `type <css> <text>` | fill an input; backtick-quote selectors with spaces: ``type `input[placeholder="My app"]` Demo`` |
| `press <key>` | `Enter`, `Tab`, `Control+A`, ... |
| `text <css>` | print `innerText` |
| `eval <js>` | evaluate an expression in the renderer (awaited); `window.orgai.*` is the preload API, e.g. `eval (await window.orgai.projects.list()).map(p => p.name)` |
| `quit` | close the app and exit (also on stdin EOF) |

`ORGAI_APP_DIR` and `ORGAI_SHOTS_DIR` override the app and screenshot directories.

## Gotchas

- Prefer `[data-testid=...]` selectors. CLAUDE.md and the e2e scripts name them.
- New project form: `[data-testid=architect-setup]` is the "Set up with the Architect" checkbox. Click its label (`label.checkbox`) and leave it unchecked to skip setup. `createProject` in `e2e/lib.mjs` shows the whole flow.
- To know a create finished, wait for `form.card` to disappear.
- Only native dialogs are auto-accepted (echoed as `[dialog accepted]`). The app asks through the in-app `ConfirmDialog`, so click its confirm button yourself.
- `.draft-box` is used by several panels; scope your selector instead of taking the last match.
- `eval` runs in the renderer only, so it can switch the theme (`document.documentElement.setAttribute('data-theme','light')`) but cannot resize the window. For exact window sizes, write a script on `e2e/lib.mjs`.
- For anything repeatable use `e2e/`: `npm run e2e:free` is token-free, and `e2e/lib.mjs` gives `launch`, `createProject`, `screenshot` and `check`.
