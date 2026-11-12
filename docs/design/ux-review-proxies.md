# UX review: proxy connections (re-walk of the landed UI)

Reviewer: UX Researcher. Build: 9bff918 (`npm run build`, 0.1.7-dev1). Re-walk of `ux-review-proxies-pre.md`; spec `proxies.md`.

How it ran: built app, `ORGAI_MOCK=1`, throwaway data dir (`%TEMP%\orgai-e2e-data-*`), driven with a Playwright command server on `e2e/lib.mjs` (one long-lived app, steps run from files). Sizes 1024x640 and 1600x1000 (`setContentSize`), dark and light (`data-theme`). Mouse first at 1600x1000 dark for the whole story; the size x theme matrix was shot for the Connections page, the Add proxy dialog and Project settings > Connection; keyboard pass at 1024x640 dark on Connections. No loopback server of my own was started; only the mock proxy (`https://mock-proxy.example.com`). Keys: `mock-bad-key` then `good-key`.
Shots and scripts: `e2e/shots/ux/proxies/` (gitignored). Shot names below are file stems.

Walk as a first-time user: Add proxy (wrong key, then right key), Test and connect, tier mapping with a GPT model, edit, Delete key, second proxy, Use for new projects, New project with the Connection select, Project settings list, Team role Model, Assistant models, Model prices, Dashboard, sidebar, Remove while used, move the project, Remove.

## Verdict

MOSTLY FIXED. The one-proxy shape is gone. A first-time user can add a proxy, read three plain check lines, see which URL carries which model family, pick a connection in New project, and is stopped from removing a proxy a project uses (the reason names the project). No page scroll or overflow at either size or theme, the collapsed card is two Tab stops, and the dialog opens on Name and returns focus. What is left is mostly quiet state loss: the tier mapping control shows "No model" for tiers that are automatic and then hides the automatic badges after Apply, the default silently falls back to Anthropic as "Chosen" when a proxy loses its key, an empty Lite gateway group in every model picker, a price note that contradicts the price table, and focus dropping to the page after Save key / Save changes / Apply mapping. No Critical findings and no finding that stops the task.

## Status of the earlier walk

| Earlier | Status | Evidence |
| --- | --- | --- |
| H1 mixed-family proxy mapped as Claude-only, silent | Partly fixed | Models list is grouped "Claude 4 / GPT 2 / Other 3" with "Claude models use the Anthropic URL; GPT and other models use the OpenAI URL." (shot 12); Exact model is visible in the role panel, not under Advanced (shot 31). But "Top has no model on Lite gateway" in the mapping dialog gives no reason or way out (M3 below), and the tier selects show "No model" (M1). |
| H2 Remove does not name projects | Fixed | Remove proxy is inert with "Work gateway EU is used by: Proxy project A. Move those projects ..." (shot 36); Delete key confirm names the project (shot 35). |
| H3 flat pickers, hard-coded "LiteLLM" suffix | Partly fixed | optgroups per connection, family suffix per model, "Runs on Work gateway EU" line (shot 32). The Lite gateway group is empty (M2). |
| M1 nowhere to add a proxy | Fixed | "Proxies (N)", Add proxy dialog, empty state, collapsed cards (shots 01, 02, 22). |
| M2 LiteLLM-specific copy, env-var key name | Fixed | Name, kind badge, "API key for Work gateway" accessible name. |
| M3 Disconnect no confirm; default fallback reads Chosen | Partly fixed | Delete key confirms (shot 35). The fallback is still unannounced and still reads "Chosen" (M4 below). |
| M4 "No spend reported yet" forever | Partly fixed | Wording is now "This proxy does not report prices or spend. Costs ... unknown" with no "yet" and no $0. Contradicted for built-in priced ids (M5); Dashboard Usage says "No connections in use." (L5). |
| M5 New project "Change" leaves the dialog, no picker | Fixed | `new-project-connection-select`, grouped "Built in / Proxies", default marked, Manage connections link kept (shot 25). |
| M6 three fixed cards on project settings | Fixed | One radio list with kind, status, model count, inert not-connected entry with a reason (shots 27, 28). |
| M7 Dashboard names | Fixed | "Default: Work gateway EU", "Proxies: Work gateway EU, Lite gateway" (shot 34). |
| L2 Apply mapping / Discard shown with nothing edited | Open | Both buttons visible on first open of Model tiers (shot 12). |
| L3 reached / key / models not separated | Fixed | Three check lines, a refused key shows "Reached ..." with a check and "The key was refused" with a cross (shot 05). |
| L4 collapsed card costs 3 to 6 Tab stops | Fixed | Refresh + Expand = 2 stops; a not-connected card adds Connect (keyboard pass). |

## Findings

### High

None.

### Medium

**M1. Tier selects read "No model" for tiers that are Automatic, and Apply mapping then hides the Automatic badges (App settings > Connections > a connected proxy > Model tiers; 1600x1000, dark; shots 12, 13, 14).**
Steps: connect a proxy, open Models and Model tiers, pick `gpt-6-sol · GPT` for Top, Apply mapping. Before touching anything the Deep, Everyday and Fast rows carry an "Automatic" badge but their selects say "No model", although the proxy list beside them tags claude-opus-5 Deep, claude-sonnet-5-5 Everyday, claude-haiku Fast. After Apply the badges and the list chips for Deep / Everyday / Fast are gone and all three selects still say "No model"; only Top (gpt-6-sol) is shown. The roles still resolve to the automatic models (Team > role Model offers "Top (gpt-6-sol), Deep (claude-opus-5) ..."), so the card is wrong, not the mapping. A user will conclude their Deep, Everyday and Fast mappings were wiped by changing Top. No announcement after Apply and focus drops to the page.
Recommendation: show what Automatic resolves to in the select ("Automatic: claude-opus-5") or a first option with that text; keep the Automatic badge and list chips after a partial apply; announce "Mapping applied" through `connections-live`; keep focus on Apply mapping or move it to the Top select; hide Apply mapping / Discard until a tier changed.

**M2. Every model picker has a "Lite gateway" group with no models (App settings > General > Advanced > Assistant models and Default root / report; 1600x1000, dark; shot 32).**
With two proxies that both list nine models, the six selects (Setup, MCP, Skill, Chat, Default root, Default report) show optgroups Tiers (4), Anthropic (5), Work gateway EU (9) and Lite gateway (0 options, read from the DOM). I could not tell whether the second proxy's identical model ids are being de-duplicated or the group is genuinely broken. Either way a user who added Lite gateway to use its models finds a heading with nothing under it, and cannot choose its copy of a model.
Recommendation: never render an empty group; if ids are de-duplicated across connections, say "Same models as Work gateway EU" or key options by connection plus id so each proxy's models are selectable and route correctly.

**M3. The mapping dialog says "Top has no model on Lite gateway" and stops there (Project settings > General > Connection > Review changes; 1600x1000, dark; shot 29).**
The dialog lists Deep, Everyday, Fast mappings and a bare "Top has no model" line, while the proxy serves two GPT models. There is no explanation that Top is only mapped by hand, no link to the card's Model tiers, and the last bullet "Claude models use the Anthropic URL ..." reads as part of the Fast list. First-time users cannot tell whether the switch will break their Top roles.
Recommendation: "Top roles will use Deep on Lite gateway. Set a Top model in App settings > Connections" with a link; separate the URL note from the tier bullets.

**M4. The default silently moves to Anthropic as "Chosen" when the default proxy loses its key; the Remove confirm does not say the proxy is the default (App settings > Connections; 1600x1000, dark; shots 18, 40, 41).**
Steps: make Work gateway the default, edit its Anthropic URL to another host, Save changes. The key is removed (good, the card says so) and the Anthropic card now reads "Default for new projects and assistants - Chosen - Back to automatic", though the user never picked Anthropic. `connections-live` announced only "Work gateway EU changed. Test and connect to apply." Reconnecting moved the default back, again silently. The Remove confirm for the default proxy says only "The stored key is deleted. Past runs keep showing the name as 'Removed proxy'." (no default, no assistants). After removal the live region says "Work gateway EU removed" and Anthropic shows "Automatic", which is right but unannounced.
Recommendation: when the effective default moves, say it on the new default ("Moved here because Work gateway EU is not connected") and in `connections-live`; mode text "Automatic" for a fallback; the Remove confirm adds "It is the default for new projects and assistants; they will use Anthropic."

**M5. The "does not report prices" note contradicts the price table (App settings > Connections > Advanced > Model prices; 1600x1000, dark; shot 33).**
The proxy's models claude-opus-5 and claude-sonnet-5-5 are priced from the built-in table (rows "Built-in" $5.00 / $25.00 and $2.00 / $10.00), while the lines below say "Work gateway EU does not report prices. Costs for these models show as unknown until you set one." That is true only for the proxy's other seven models. Those seven are not in the table, so "until you set one" has no row to act on; the only paths are Add override or Show all 32 prices.
Recommendation: "N of 9 models have no price" with the names (or a link that filters the table to them), an Add price button per proxy, and exclude ids the built-in table covers.

**M6. Focus falls to the page after Save key, Save changes and Apply mapping (App settings > Connections, Project settings; 1600x1000, dark).**
After saving a key (the Save button disappears), Save changes on an edited card and Apply mapping, `document.activeElement` was `body` (observed after a mouse click; a keyboard user pressing Enter on those buttons hits the same unmount). Keyboard and screen reader users restart from the top of the page. Test and connect is fine: with Enter it keeps focus and speaks "Lite gateway: connected. Reached ... 9 models listed". The Apply and key-saved cases are spoken ("Key saved") or silent (Apply, M1), but focus is lost in all three.
Recommendation: move focus to the field or button that logically follows (the key field's Replace, Test and connect, the Top select) and announce the outcome.

### Low

**L1. One failure, said three times (Connections > refused key; 1600x1000, dark; shot 05).** "The key was refused (401)." appears in the card subtitle, the error banner and the check line, plus the page-level live region and a toast-like line above the card. Keep the banner and the check lines; shorten the subtitle to "Key refused".

**L2. Duplicate and wrapping header chrome (shots 15, 22).** The default proxy's header wraps "Chosen" onto its own line between the name and the subtitle; the subtitle repeats the kind already in the badge ("LiteLLM proxy - 9 models"). Header buttons "Connect" (collapsed) and "Test and connect" (expanded footer) are the same action with two names. Put the mode beside the badge or in the footer; drop the kind from the subtitle.

**L3. Two ways to remove a key (shot 09).** "Clear" next to the key field and "Delete key" below; "Clear" has no confirm and the confirm for "Delete key" is the better wording. Drop Clear or point it at the same confirm.

**L4. Replace shows the placeholder "Not set" over a stored key (shot 07).** While replacing, the empty input reads "Not set" although a key is stored; the accessible name says "set, enter a new value to replace it". Placeholder "Enter a new key".

**L5. Dashboard shows nothing about which connection a project uses and Usage says "No connections in use." while Project A runs on Work gateway EU (shot 34).** The Connections card lists proxy names but only the default's status; Lite gateway's state is not visible. Add a connection chip to the project tile and a status per proxy name.

**L6. Selected connection in Project settings is colour only (shots 28, 52).** The radio is visually hidden; a selected entry has a purple border (dark) or a lavender fill (light), "(current)" appears only after the user changes it. Add a checkmark or a visible radio dot.

**L7. Models endpoint on a different host than the Anthropic URL gets no note after an edit (shot 17).** The note works in the dialog when the models host differs from the proxy host (shot 21); after I moved only the Anthropic URL in the edit form to another origin, the mock-proxy models endpoint and OpenAI URL stayed and nothing said the key now goes to hosts that differ from the Anthropic URL. Compare against both base URLs.

**L8. Small copy and layout.** Add proxy dialog puts Name beside Anthropic URL and OpenAI URL alone on its row with half the row empty (shot 02); the "Left empty: ..." hint still shows under a filled OpenAI URL field (shot 17); the Remove-blocked reason ends "(Project settings > General > Connection); OrgAI will not remove it" (use a full stop); the Delete key confirm says "This project uses it: Proxy project A" (plural when more than one); the Team role panel's "Connections / No connections yet" heading means MCP services and sits beside proxy connections elsewhere (rename "Services"); placeholders for empty OpenAI URL / Models endpoint look like disabled fields (shot 50 light); the first-launch inline New project form hides the Connection select behind the sticky submit row at 1600x1000 until scrolled (shot 25); the "Use for new projects" button sits after the destructive Remove proxy in Tab order.

**L9. Add proxy dialog is tight at 1024x640 (shot 51).** It uses 608 of 640 px and scrolls inside its body, footer buttons stay visible; fine, but any added field will push the buttons out. Not a defect today.

## What worked (kept for the record)

- Add proxy: empty submit gives inline reasons and focus stays on the button; duplicate name and `http://` URL are refused with a reason (shot 20); the models-host note appears as you type (shot 21).
- A wrong key (`mock-bad-key`) is saved as a card with "Reached ... / The key was refused" and Connect; replacing it and Test and connect shows three checks and "This proxy does not report prices or spend ..." (shots 05, 09).
- Changing the Anthropic URL to another host removes the key and says so in the card and the live region (shot 18).
- A second proxy collapses the first, expands the new one, moves focus to its heading and announces "Lite gateway added. Connected." (shot 22).
- Remove blocked while a project uses the proxy, allowed after moving it, announced "Work gateway EU removed", focus lands on the "Proxies (1)" heading (shot 41). The project list in Project settings follows.
- No page scroll or horizontal overflow at 1024x640 or 1600x1000 in either theme on the Connections page, the dialog and Project settings (measured scrollWidth/Height equal client size); the sidebar is the rail at 1024. Collapsed proxy card = Refresh + Expand (2 stops); expanded order is Name, URLs, key, Replace, Clear, Test, Delete key, Remove, Use for new projects, Models, Model tiers; every stop has a 2 px outline; Esc on the Delete key confirm returns focus to Delete key; Esc on Add proxy returns to Add proxy.
- Team role Model select: "Use the connection default / Top (gpt-6-sol) / Deep ... " with Exact model grouped by family (Claude, GPT, Other) and "Any model Work gateway EU serves." visible without Advanced (shot 31).

## Not driven

- A real proxy: the mock gives no spend, prices, `/key/info`, `/model/info`; spend periods, price discovery and the sidebar account row with a proxy (the footer reads "Mock adapter" under the mock) were not seen. The "does not report prices or spend" wording is therefore the only spend state I saw.
- A project actually running on a proxy: I started no run (no tokens); Trends and the Cost card with proxy costs, "Removed proxy" in History, and `usedBy` with more than one project or long names are unseen. I did not move a project that had live runs.
- The Apply mapping result "shown after applying, with Undo" (dialog text): I looked for it in Project settings and on the Team tab and saw no notice or Undo; I cannot say whether it exists elsewhere (it may be mock-specific or a gap, so confirm before relying on this).
- More than two proxies (wrap, scroll in the radio list past 5 entries, 20 proxies maximum), long names, the "OpenAI-compatible" kind with an OpenAI-only URL, Connect on the OpenAI card, signing in anywhere.
- Keyboard pass was run on Connections at 1024x640 dark; the Project settings radio list and the New project Select were checked with the mouse only (the e2e covers their keys); no screen reader; macOS and Linux.
- The selected-state of the Connection radios at 1600x1000 light and the light theme of the add dialog at 1600x1000 were captured but not examined for contrast numerically.
