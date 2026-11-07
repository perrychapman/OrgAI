# UX review: connection surfaces before "many named proxies" (pre-feature walk)

Reviewer: UX Researcher. Build: 71c50d5 (`npm run build`, 0.1.7-dev1). Not a re-walk; there is no earlier review of this topic.

How it ran: built app, `ORGAI_MOCK=1`, a throwaway data dir (`E2E_DATA_DIR` under the temp folder), driven with Playwright scripts on `e2e/lib.mjs`.
Sizes 1600x1000 and 1024x640 (`setContentSize`), dark and light (`data-theme`), mouse first, then a Tab pass on App settings > Connections at 1024x640 dark.
Compared with: CLAUDE.md "Self-configuration" / "Settings pages" and the feature brief (N named proxies). No spec exists yet.
Shots and scripts: `e2e/shots/ux/proxies/` (gitignored). Shot names below are the file stems (`NN-...png`).

To see a connected proxy without a network, I ran a loopback stand-in (`fakeproxy.mjs`, 127.0.0.1:48555) that answers only `GET /v1/models` with 11 ids (claude-*, gpt-5*, gemini-2.5-*, qwen3-*, deepseek-v3, llama-3.3-70b) and 404s everything else. That is the shape of the user's real proxy (no /model/info, no /key/info). Test and connect succeeded: "Proxy key · 11 models".

## Verdict

READY TO BUILD ON, with a clear list of places that are one-proxy-shaped. Today's model is "three fixed providers, the third called LiteLLM". The connection concept leaks into about ten surfaces with hard-coded names, flat model lists and one-card layouts. None of them break with one proxy; most get long, ambiguous or wrong with N. The best news: a spend-less proxy already degrades gracefully in most places (no crashes, no $0), and the remove/disconnect paths already tell the user which projects are affected. The worst: the Remove confirm does not name those projects, the tier mapping for a mixed-model proxy is Claude-only and silent, and every model picker names the provider as the string "LiteLLM".

## Findings

### High

**H1. A mixed-model proxy is mapped as if it only served Claude, and nothing says so (Project settings > General > Connection; 1600x1000, dark; shots 33, 34, 36).**
Steps: connect the stand-in proxy, open a project's Settings, pick LiteLLM, Review changes. The "Apply this mapping?" dialog maps opus -> claude-opus-4-1 and sonnet -> claude-sonnet-4-5. The connection's tiers came out as deep/everyday/fast only (no "top"), from `autoTiers`. After applying, a line says "Orchestrator model family: Claude", Team > role Model offers Deep / Everyday / Fast (claude-*), and the 8 other models (gpt-5, gemini, qwen, deepseek, llama) are reachable only under Advanced > Exact model, whose hint reads "Any model the proxy serves."
What the user experiences: a user who added the proxy because it serves GPT, Gemini and Qwen sees a Claude-only project with no explanation of why those models are tucked away, why "Top" vanished, or that GPT roles need the Codex route (OpenAI base URL). With two base URLs (Anthropic and OpenAI) the feature must say which traffic each model takes; today nothing in the UI does.
Recommendation: in the proxy card and the switch dialog, show per model family which URL carries it ("Claude models use the Anthropic URL; GPT models use the OpenAI URL; others are not available"). Put the family on each model row in Models (n). Give the project switch dialog a line for anything that could not be mapped. Make Exact model the visible path for a proxy, not a hidden Advanced.

**H2. Remove connection does not say which projects lose their connection (App settings > Connections; 1600x1000, dark; shot 53).**
Steps: with Px project on LiteLLM, expand the card, Remove connection. The confirm reads "Remove LiteLLM connection? The stored key is deleted and the proxy URL is cleared. Projects using it will need another connection." No count, no names, no link.
Meanwhile the app already knows: after the disconnect the Dashboard said "LiteLLM is not connected. 1 project uses it." and project settings said "LiteLLM is not connected. Connect it to run this project." (shots 63). With N proxies this is the main edit/remove hazard: the user deletes "Work proxy" and cannot tell which of 6 projects break.
Recommendation: the Remove confirm names the projects (first 5, then "and N more"), says what each falls back to, and offers "Move them to <default>" as a checkbox. Disable nothing; this is a confirm, not a block. Same line for a rename that changes identity if ids are derived from names.

**H3. With N proxies every picker is a flat list tagged with a hard-coded provider word (App settings > General > Advanced > Assistant models; 1600x1000; shots 41).**
The four assistant selects (Setup, MCP, Skill, Chat) are each one flat list: 4 tiers, 5 Anthropic models ("Fable · Anthropic"), then the proxy models as "claude-sonnet-4-5 · LiteLLM" ... "llama-3.3-70b · LiteLLM", 20 options for one proxy with 11 models. The Default report and root selects are the same. With three proxies of 10+ models each that is 50+ options, with the same model id repeated under different proxies and only the suffix to tell them apart. The suffix will have to become the proxy's display name, and the suffix is the only thing separating a Claude model on the proxy from the same Claude model on Anthropic.
Recommendation: group by connection with `optgroup` labels (display name), keep tiers first, and show a model's family in the option text when the proxy serves several. Resolve the "Runs on ... via X" lines (Chat start page, assistant start pages) from the proxy's display name. Consider a two-step control (connection, then model) once there are more than 2 connections.

### Medium

**M1. The Connections page is built for three fixed cards; there is nowhere to add one (App settings > Connections; both sizes, both themes; shots 02, 12, 60).**
The page is Anthropic, OpenAI, "LiteLLM proxy", then Advanced. The LiteLLM card is fully expanded by the user, not by default; its fields are Base URL, API key (Save / Replace / Clear), Learn more, Test and connect, Remove connection. There is one URL field, so Claude and Codex traffic cannot be given different URLs, and no models-endpoint field, no display name, no kind.
Layout holds at both sizes (no page scroll, no horizontal overflow at 1024x640 or 1600x1000 in either theme). An expanded card is about 220 px tall, so at 1024x640 only one card is visible at once.
Recommendation: keep the fixed cards (Anthropic, OpenAI) on top and add a "Proxies" group below them with a heading, a count, and one collapsed card per proxy plus an "Add proxy" button at the group's end (also the empty state: "No proxies yet. Add one to route Claude, GPT and other models through a gateway you run."). Add runs a dialog (name, kind, Anthropic URL, OpenAI URL, models endpoint, key) and ends with Test and connect, then focus on the new card. Collapsed rows should show name, kind, status and the one-line summary so N=6 stays scannable. Do not auto-expand more than one.

**M2. Card copy, title and subtitle are LiteLLM-specific and the key line shows an env-var name (Connections; all; shots 03, 12, 60).**
Title "LiteLLM proxy", unconnected text "Enter the proxy URL and key, then test the connection.", connected subtitle "Proxy key · 11 models · updated just now" (reads as an auth method, not a name), after Save "Key saved. Test and connect to apply.", the key input's accessible name is "LITELLM_API_KEY, secret, not set", the placeholder is `http://localhost:4000` and the 'Learn more' disclosure is LiteLLM docs. A generic OpenAI/Anthropic-compatible proxy has none of these.
Recommendation: title is the user's display name with the kind as a badge; subtitle "<kind> · 11 models · updated 2 min ago"; key label "API key for <name>"; per-kind Learn more; per-kind placeholders. The hard-coded provider label also exists in the project switch cards, dashboard lines, picker suffixes and "Runs on ... via LiteLLM" (see H3, M4, M5).

**M3. Disconnect has no confirm, fallback of the default is quiet and reads "Chosen" (Connections; 1024x640 light; shots 60, 62).**
After I made LiteLLM the default ("Chosen") and then pressed "Disconnect and remove key", no dialog appeared and the key was gone at once. The default moved back to Anthropic, which now shows "Default for new projects and assistants · Chosen · Back to automatic", although the user never picked Anthropic. I did not capture whether the connections live region announced the move at the time (the page was reloaded between scripts), so I cannot say if it is silent.
Recommendation: Disconnect is destructive (it deletes the key) and with N proxies is next to Remove: rename to "Delete key" and ask once, naming the dependent projects as in H2. After a default falls back, say so on the new default ("Moved here because Work proxy was disconnected") and keep its mode as Automatic.

**M4. A proxy that reports no spend or prices shows "No spend reported yet." forever (Dashboard Usage card; 1600x1000 dark; shots 43, 50; Advanced > Model prices; shot 06).**
With the stand-in proxy connected, Usage shows the row "LiteLLM / No spend reported yet." both when it is the default and after it was disconnected (a disconnected proxy still has a row). "Yet" promises a figure that this proxy will never send. Model prices (Advanced) says "No overrides yet and none of your models are listed ... Show all 32 prices"; the 11 proxy models are not in the list and no row says "this proxy gives no prices".
Recommendation: per proxy, record what it can report (`reportsSpend`, `reportsPrices`, learned at Test and connect from the 404s on /key/info and /model/info) and word the rows from that: "Spend: not reported by this proxy" with no "yet". Hide the row for a disconnected proxy. In Model prices, group proxy models under the proxy name with an "Add price" call to action and the line "<name> does not report prices. Costs for these models show as unknown until you set one." Costs must stay "unknown", never $0 (this is already the rule; keep it for History > Trends and the Cost card, which I could not drive with a proxy, see Not driven).

**M5. "Change" on New project leaves the dialog and the connection choice lives elsewhere (New project form; 1600x1000 dark; shots 21, 22, 23, 52).**
`new-project-connection` is the sentence "Runs on Anthropic (Claude Code login). Change". It is hidden while "Use the mock adapter" is on (the sentence reads "Runs on the mock adapter (no tokens)."). Change jumps to App settings > Connections with focus on the pane title; the new-project dialog is not visible any more. There is no picker, so with N proxies the user cannot say "this project on Work proxy" until after the project exists (then Project settings > General > Connection, a Review changes + Apply and update roles flow).
Recommendation: replace the sentence with a `Select` (default connection preselected, grouped Anthropic, OpenAI, proxies with status) shown only when two or more are connected; keep "Manage connections" as a link that does not discard the draft. Also needs the tier-mapping preview (H1) at create time, or the new project quietly uses mapped Claude names.

**M6. Project switch cards are a fixed row of three (Project settings > General > Connection; 1600x1000 dark; shots 26, 30, 34).**
Three radio cards (Anthropic, OpenAI, LiteLLM) with a status pill each, then Review changes / Cancel, then an info panel "4 roles use this connection by default · Everyday tier: claude-sonnet-4-5" and a read-only Role models list. With 3+ proxies the row wraps or overflows (not seen; I only had one). The cards carry the proxy name only as the provider's own word. Not-connected cards are selectable and show "LiteLLM is not connected. Connect it to run this project." only after selection.
Recommendation: one radio list (name, kind, status, models count) that scrolls inside its own region past 5 entries, not-connected ones present but marked and not selectable until connected; keep the app default in the section's lead sentence (it is: "App default for new projects: Anthropic").

**M7. A proxy default name collides with the Dashboard's vendor names (Dashboard; 1600x1000; shots 43, 50).**
Connections card says "Default: Claude" while App settings says "Anthropic" (pre-existing). A proxy that is the default prints "Default: LiteLLM" with no display name. With N proxies named by the user this must say the name, and the Usage card must show one row per connection that has anything to show, not a fixed "Claude / LiteLLM" pair.
Recommendation: one naming helper (`connectionLabel(connection)` returns the display name) used by every surface; keep "Anthropic" and "OpenAI" for the two fixed ones and drop "Claude" as a synonym.

### Low

**L1. Account row and popover cannot show proxy usage under the mock (Sidebar footer; all sizes; shot 42).** Under `ORGAI_MOCK=1` the footer reads "Mock adapter" and the popover says "Runs use scripted data. No plan limits apply. No spend is tracked." So the spend row, `spendRowLabel` and the "LiteLLM spend:" tooltip could not be seen for a proxy (see Not driven). Design for N: the footer shows one tightest figure; with proxies that report nothing it should show nothing rather than "No spend reported yet" per proxy.

**L2. Models and Model tiers inside the card (Connections; 1600x1000; shots 12, 14).** Connected card shows "Models updated just now", `Models (11)` and `Model tiers  Automatic` with "Apply mapping" and "Discard" buttons visible with nothing edited. Dead-looking primary button. With N proxies, hide them until a tier is edited. Tier mapping is Claude-shaped (top/deep/everyday/fast); for GPT/Gemini/Qwen "everyday" has no meaning unless chosen by hand.

**L3. Models endpoint is not testable on its own.** The only check is Test and connect ("11 models available" / "Could not reach proxy.example"). For the feature, a wrong models URL and a wrong key both end in a connection error; the error card has Copy details, which is good. Separate "reached the proxy" from "key accepted" from "models listed" in the result lines.

**L4. Keyboard pass (Connections, 1024x640 dark).** Tab order is sensible: Refresh all, each card's Refresh then its expand chevron, then the fields (Base URL, key, Learn more), Test and connect, Remove connection, Advanced settings, then the page's skip links. Enter on the chevron toggles, and `aria-expanded` flips. Every stop has a 2 px outline; the two text inputs also show a shadow ring. Each card puts Refresh before the expander and the Connect button before them, so a card with N controls costs 3 to 6 stops; with N proxies a collapsed card should be one or two stops. The page's polite region `connections-live` is empty at load.
**L5. Remove then Escape works** (Escape on the Remove confirm cancelled and left the card intact), good for the new flow.
**L6. Layout at both sizes and themes is clean** (no overflow at 1024x640 or 1600x1000, dark or light; light theme tokens fine on the cards and badges). The sidebar collapses to the rail at 1024 as designed.

## Where things should live (answers to brief item 3)

- List of N proxies: App settings > Connections, a "Proxies" group under the two fixed cards, one collapsed card per proxy, "Add proxy" as a button at the group's end and as the empty state.
- Add proxy: a dialog (name, kind, Anthropic URL, OpenAI URL, models endpoint, key), ending in Test and connect; the card appears collapsed, focused, announced.
- Edit: expand the card; same fields; changing a URL makes the status "unknown" and asks for Test and connect (the existing tentative behaviour).
- Remove: confirm that names projects, assistants and the default that depend on it, with a "move to <default>" option (H2, M3).
- Labels that would confuse: "LiteLLM" anywhere it is hard-coded (card title, subtitle, switch card, picker suffix, "via LiteLLM", dashboard lines, "LiteLLM proxy: connection error" banner, remove text, key accessible name), "Codex (ChatGPT)" never appeared in this walk but the OpenAI card says "Sign in with ChatGPT" / "Uses your ChatGPT plan through Codex", which is unrelated to a proxy's OpenAI URL: say "OpenAI URL" for the proxy and keep "Codex" out of proxy copy; "Proxy key" as a subtitle; "No spend reported yet."; "Any model the proxy serves."

## Recommendations for the proxy UI (for the UI Lead to turn into briefs)

1. **Naming helper.** One `connectionLabel` and one `connectionKindLabel`; replace every literal "LiteLLM" in the renderer (grep the strings above). Display name is required, unique, trimmed, at most about 40 chars, no hidden characters.
2. **Connections page.** Fixed cards on top, "Proxies (N)" group, collapsed cards (name, kind badge, status, one-line summary, one default Connect/Test button), Add proxy dialog, collapsed by default and one open at a time past three. Keep the default badge and "Use for new projects"; mode text follows rules in M3.
3. **Proxy fields.** Display name, kind (LiteLLM / OpenAI- or Anthropic-compatible), Anthropic base URL (Claude), OpenAI base URL (Codex), models endpoint (prefilled from the OpenAI URL + /v1/models, editable), API key (existing Save / Replace / Clear), per-field help and examples. Each URL optional; the card says which traffic is not enabled when one is empty.
4. **Test result.** Three lines: reached, key accepted, N models listed, plus what it will report ("No spend or prices reported by this proxy"), stored on the connection and used by every cost and usage surface.
5. **Model pickers.** Grouped by connection (`optgroup` with the display name), family shown, route shown where it matters; the assistant selects, Default root/report, project Exact model and the Chat "Runs on" line all use one grouped list component.
6. **Project connection.** A Select on New project when 2+ connections are connected; a scrollable radio list on Project settings; the mapping dialog lists unmapped models and routes (H1).
7. **Removal.** Remove and Delete key confirms that name dependents and offer a move; announced result.
8. **Spend and prices.** A proxy that reports none shows "not reported", never "yet", never $0; Model prices groups proxy models by proxy with a clear "no prices" note and a price-override entry; Dashboard Usage lists only connections that have something to show.
9. **Accessibility.** Collapsed card = at most two Tab stops; the add dialog traps focus and returns it to the new card; add, test, remove and default changes speak through `connections-live`; key field named "API key for <name>".
10. **e2e.** Extend e2e/connections.mjs for add, edit, remove-with-projects and the grouped pickers at both sizes and themes using the loopback stand-in (no network).

## Not driven

- A real LiteLLM or any real proxy; the loopback stand-in gives only /v1/models. No /key/info, /model/info, spend periods or price discovery was exercised (the mock cannot produce them).
- Sidebar account row and its popover with usage or spend for a proxy: hidden under `ORGAI_MOCK=1` (shows "Mock adapter").
- History > Trends and the Cost card with real proxy runs: no runs exist on the mock for a non-mock project and starting a real run would spend tokens. Trends and Cost were seen empty only (shots 43, 44). `[mock:no-price]` / `[mock:computed-cost]` runs were not made.
- N proxies: only one proxy could be added today, so wrapping, scrolling and ordering with several cards, long display names and the add flow are unseen. Statements about them are recommendations, not observations.
- The OpenAI card (Sign in with ChatGPT) and Anthropic sign-out were opened, not used. Test and connect with a wrong key was not driven (the stand-in ignores the key).
- Keyboard pass was run on Connections only (1024x640 dark), not on the project settings, Team panel or pickers; no screen reader. macOS and Linux not driven.
