# macOS first-test checklist

Nothing here has been run on a Mac yet. Work top to bottom and note the first step that fails. Steps 1 to 9 spend no tokens.

## 1. Prerequisites

- Xcode Command Line Tools: `xcode-select --install` (provides `git`; without it `/usr/bin/git` pops an install dialog and every worktree operation fails).
- Node 22 (`node -v`), npm 10+.
- Optional, for the connection tests: Claude Code CLI logged in (`claude auth status`), `uvx`/`npx`/`docker` if you will test MCP servers.
- Apple Silicon or Intel: note `uname -m`.

## 2. Build and unit checks

```sh
npm ci
npm run typecheck && npm test && npm run build
```

`npm ci` must install the `darwin-<arch>` optional packages: `ls node_modules/@anthropic-ai | grep darwin` and `ls node_modules/@openai | grep darwin`.

## 3. Dev smoke

`npm run dev` from Terminal, then check: the window opens, the menu bar shows OrgAI / Edit / View / Window, Cmd+C / Cmd+V / Cmd+A work in a text field, Cmd+Q quits, closing the window keeps the app in the Dock and clicking the Dock icon reopens it, and the dark and light themes both render.

Dev runs use the app name OrgAI, so dev logs land in `~/Library/Logs/OrgAI`. To test against a scratch data dir instead of your real one, set `ORGAI_DATA_DIR`: when set, user data and logs live under that directory.

```sh
ORGAI_DATA_DIR=/tmp/orgai-scratch npm run dev
```

## 4. Packaged app, launched from Finder

```sh
npm run dist:mac:unsigned     # or: CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:mac
open release/
```

Open the `.dmg`, drag OrgAI to Applications, then right-click the app and choose Open (needed for an unsigned build; if macOS says it is damaged, run `xattr -dr com.apple.quarantine /Applications/OrgAI.app`). Launch it from Finder or the Dock, not from a terminal: that is the case where PATH is minimal.

## 5. PATH discovery (packaged app, launched from Finder)

- Open the log: `open ~/Library/Logs/OrgAI` (the app also has an Open log folder action). The first lines should include `OrgAI <version> starting ... darwin arm64 packaged=true` and a `PATH: N entries added (login shell)` line.
- In the app, confirm `git`, `claude` and `codex` are found: the Claude status pill shows logged in, and starting a project on a git repo works.
- Check the packaged native binaries exist: `ls /Applications/OrgAI.app/Contents/Resources/app.asar.unpacked/node_modules/@anthropic-ai/*/claude` and `.../@openai/codex-darwin-*/vendor/*/codex/codex`.

## 6. Claude login

The status pill reads "logged in" when `claude auth status` works. Try with `claude` logged out (`claude auth logout`) and in again.

## 7. Worktree isolation (scratch repo)

Create `mkdir /tmp/scratch && cd /tmp/scratch && git init && git commit --allow-empty -m init`, add it as a project (note `/tmp` is a symlink to `/private/tmp`; this exercises path handling), start a run that makes a spawnable report edit a file, and check the report branch merges (Maintenance panel shows no leftovers).

## 8. Connections

Settings > Connections: Anthropic (CLI login or API key), OpenAI ChatGPT login via the browser, and via device code, and LiteLLM "test and connect" against your proxy.

## 9. MCP and installs

Add an MCP server (for example an `npx` or `uvx` one) and press Test; it should resolve `npx`/`uvx` through the shell PATH. Trigger an install approval and approve and deny one.

## 10. Token-spending smoke scripts (only with your consent)

Each of these spends real tokens. Run each once, never in a loop.

```sh
node scripts/smoke-litellm.mjs                 # free: lists models (needs LITELLM_BASE_URL, LITELLM_API_KEY)
node scripts/smoke-litellm.mjs --yes           # one tiny query through the proxy
node scripts/smoke-codex.mjs                   # written by the codex engineer
node scripts/smoke-sdk.mjs                     # haiku, two one-turn calls
node scripts/smoke-worktree.mjs
node scripts/smoke-delegation.mjs
node scripts/smoke-network.mjs
node scripts/smoke-images.mjs
node scripts/smoke-usage.mjs
node scripts/smoke-mcp-tools.mjs
```

## CI (landing in this change)

GitHub Actions builds unsigned mac `.dmg`/`.zip` artifacts for arm64 and x64 when a `v*` tag is pushed (`release.yml`), and runs typecheck, tests, build and `e2e:free` on macOS and Windows (`ci.yml`). The CI artifacts are unsigned: right-click the app and choose Open, and if macOS says it is damaged run `xattr -dr com.apple.quarantine /Applications/OrgAI.app`.

## What to send back

- The log: `~/Library/Logs/OrgAI/main.log` (and `main.1.log` if present).
- Screenshots of the first window, the Edit menu, the Claude status pill, a notification (or its absence), and any error dialog.
- `uname -m`, `sw_vers`, `node -v`, `git --version`, and for each failed step the exact step number.

## Known macOS caveats

- Notifications: macOS asks permission on first use; an unsigned build may not appear under System Settings > Notifications or may be listed as Electron. Request events also bounce the Dock icon.
- Gatekeeper: unsigned builds need right-click > Open each time the file is re-downloaded. Signing and notarizing need an Apple Developer ID (`CSC_LINK`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`).
- Separate arm64 and x64 builds (not universal): the native claude and codex binaries are per-arch optional dependencies.
