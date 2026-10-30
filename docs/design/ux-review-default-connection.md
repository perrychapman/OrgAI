# UX review: default connection (commit 4e3cddb)

Walked on mock data (`ORGAI_MOCK=1`, fresh temp `ORGAI_DATA_DIR`) at 1280x800 and 1024x700 in dark, and 1280x800 in light, plus one keyboard pass. Built from this worktree (it contains 4e3cddb; the main-process half is not in it). To get a connected LiteLLM I ran a throwaway local stub on `http://localhost:4000` (`/v1/models`); with no stub the card reports "Could not reach localhost:4000". Screenshots are in `docs/design/screens/` (prefix `dc-`).

Scope note: with ORGAI_MOCK the sidebar status says "Mock adapter" and Anthropic reads "Connected" whatever the real login is, so the truthful-login work cannot be judged here.

## Findings, ranked

### D1 (major) The default can be set to a connection that is not set up, and the UI then shows it as the default
Screens: Defaults select (`dc-21-defaults-s.png`), Connections (`dc-13-after-openai-default-a.png`, `dc-20-connections-s.png`).
Choosing "OpenAI (not set up)" in the Defaults select is accepted and saved. The OpenAI card (Not connected, with a Connect button) then carries the "Default for new projects" badge, and both other cards offer "Use for new projects". The card-side button is correctly hidden for unconnected providers, so the two entry points disagree. The select also says "(not set up)" while the cards say "Not connected" and the project Settings says "Not connected": three words for one state.
Fix: disable the unconnected options in the select (keep the "(not set up)" hint) or, if they stay selectable, show a "Not connected, new projects use Anthropic until you connect it" caption under the badge. Use "Not connected" everywhere.

### D2 (major) The fallback line does not say it is a fallback
Screen: new-project form (`dc-15-projects-openai-fallback`, `dc-16-form-filled-a.png`).
With the default set to the unconfigured OpenAI, the form says "Runs on Anthropic. Change in App settings > Defaults." The user chose OpenAI, so they read this as a bug and the line gives no reason. At the same time the Defaults select still shows OpenAI and the Connections badge sits on OpenAI.
Fix: when falling back, say "Your default (OpenAI) is not connected, so this runs on Anthropic. Connect it in App settings > Connections." with the link.

### D3 (major) "Runs on X" contradicts the mock-adapter checkbox in the same form
Screen: `dc-14-projects-litellm-a.png`.
Directly above the line, "Use the mock adapter (no tokens are spent)" is ticked, yet the line says "Runs on LiteLLM". A first-time user cannot tell which wins. Project Settings > Connection has the same pair ("Run on the mock adapter: On: the connection above does not apply to runs.", `dc-19-project-connection-a.png`).
Fix: when the mock box is ticked, show "Runs on the mock adapter. New runs on <connection> once you turn it off." and make the line reactive to the checkbox.

### D4 (major) The Connections page never explains defaults and "Use for new projects" does not look like a button
Screens: `dc-10-connections-collapsed-a.png`, `dc-20-connections-l.png`.
The page intro is "Where agents get their models. Each project picks one." A new user learns about the default only from a badge on one card. The "Use for new projects" action is a ghost button with no border, so it reads as a status label sitting next to "Connected" (worse in light, `dc-20-connections-l.png`). The Defaults page is the only place that explains "New projects only", and Connections does not link to it.
Where do users look first? Connections, because it lists providers; Defaults is a third settings page away. Only one half of the relationship is explained on each page.
Fix: change the intro to "Sign in and manage keys here. The default decides which one new projects start on; each project can switch in its own Settings." and give the ghost button a visible border or the secondary variant.

### D5 (major) Focus is lost after "Use for new projects", and there is no announcement
Keyboard pass (`dc-24-kb-after-use.png`).
Tab reaches "Use Anthropic for new projects" in a sensible order (Refresh all, then each card), but pressing Enter makes the button disappear (it becomes a badge on that card) and focus drops to `BODY`. A keyboard user is back at the top of the page; a screen reader hears nothing about the change (the only live regions are the card status lines and the "Saved" indicator).
Fix: after the swap, move focus to the badge on the new card (give it `tabIndex=-1`) or to the card heading, and announce "<Name> is now the default for new projects" in a polite live region.

### D6 (minor) Project Settings > Connection does not say the project keeps its own connection or whether it matches the default
Screens: `dc-19-project-connection-a.png`, `dc-23-projconn-s.png`.
The three provider cards mark the current one with a tint only. There is no "Current" text and no marker for which one is the app default. The intro is "Sign-in and keys are set in App settings > Connections." The Defaults page promises "Change an existing project in its Settings > Connection", and that is where you land, but nothing there confirms it is the right place or that the choice affects this project only. The cards are radio inputs with no group label.
Fix: add "This project uses Anthropic. New projects use LiteLLM (App settings > Defaults)." and a "Default" badge on the matching card; label the card group "Connection for this project".

### D7 (minor) The "Runs on" line is easy to miss and appears only inside the new-project form
Screens: `dc-01-launch.png`, `dc-22-projects-s.png`.
It is small muted text between the checkboxes and the submit button. Once any project exists, the Projects view shows a card grid and a "New project" button, so users reach the form only after a click and see the line only when they scroll to the bottom. It does link in words (">" path) but it is not clickable.
Fix: make "App settings > Defaults" a real link, and place the line next to the title or the submit button where the eye lands.

### D8 (minor) Defaults > Connection is a lone row and the model rows below it ignore the connection
Screen: `dc-04-defaults-a.png`.
Changing the default connection does not change the Orchestrator and Report model lists, which stay Fable, Opus, Sonnet and Haiku and are Anthropic's names. A user who picks LiteLLM or OpenAI may think the model defaults will map; the tier mapping lives in the connection card. The Permission mode description also says "Claude decides each call", which is Anthropic wording on a page that now covers every provider.
Fix: add a caption under the model rows such as "Tiers are mapped per connection (Connections > Model tiers)" and change "Claude decides" to "The model decides".

### D9 (minor) Connecting LiteLLM takes two saves and the error state has no path to the default
Screens: `dc-05-litellm-open-a.png`, `dc-07`/`dc-08-litellm-tested-a.png`.
After typing a URL and key there is a "Save" next to the key and a separate "Test and connect". Saving prints "Key saved. Test and connect to apply." A failed probe shows "Could not reach localhost:4000" twice (card detail and the red box) and "Error"; there is no "Use for new projects" until it connects, which is right, but nothing says that is why it is missing.
Fix: collapse to a single "Test and connect" that saves first, and show "Connect successfully to make it the default" under the error box.

### D10 (polish) Naming and vocabulary
- "Anthropic" (cards, select, form line) versus "Claude" ("Claude Code login", "Claude decides each call") versus "LiteLLM proxy" on the card and "LiteLLM" in the select and project Settings. Pick one name per provider.
- The rail sidebar calls the same destination "All projects" (aria and tooltip at 1024) that the expanded sidebar calls "Projects".
- "Default for new projects" is sentence case and consistent; the select option suffix "(not set up)" is the only lowercase parenthetical in the app.

## What works

- The select has a proper accessible name ("Default connection") and a described-by description; the badge text is real text, and the button's name is "Use LiteLLM proxy for new projects", which is better than its visible text.
- The badge moves immediately when a card button is used, and the Defaults select agrees when you open it; a "Saved <time>" indicator confirms persistence.
- The "Runs on" line is accurate when the default is connected: it said LiteLLM after the swap and updated live without a reload.
- Copy on the Defaults row ("New projects only. Change an existing project in its Settings > Connection.") is direct, and "Existing ones keep their own" at the top of the page reinforces it.
- Layout holds at 1024x700 (sidebar collapses to the rail, cards keep badge and button on one row) and the light theme keeps contrast on badge and status chips.
- Connection errors are specific and give "Copy details".
