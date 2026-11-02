# UX review: model tiers, connections and prices (mock data)

Walked on the built app, ORGAI_MOCK=1, fresh temp data dir, dark theme, default window (about 1424x881). Light theme,
1024x640 and a keyboard-only pass were not done. Limits of the walk: the mock offers only the Anthropic connection with
4 Claude models. OpenAI and LiteLLM could not be connected without credentials, so findings about their rows, discovered
non-Claude model lists and the "OpenAI 0 / Other 0" tabs come from the Anthropic card and the code, not a live view.
Screenshots are in e2e/shots (gitignored): d1, c1-c9, o2, t2, t3.

## Ranked findings

### 1. High. A tier never shows the model it will use (Defaults, d1)
Defaults > Models offers "Deep tier (resolves per project)". The user cannot tell what that means in practice. The
sentence below the list ("A tier resolves through each project's connection...") is the only help, and the answer lives
in another screen (Connections > card > Models/Model tiers, two disclosures down) and again in Project settings >
Connection ("Everyday tier: sonnet", only one tier shown). A user on OpenAI or LiteLLM, who picks "Orchestrator: Deep"
cannot see "-> your OpenAI deep model is gpt-x".
Fix: under each tier option in Defaults show a resolution line per connected connection ("Deep: Anthropic opus, OpenAI
gpt-5, LiteLLM none yet"), with a link to Connections. Show all four tiers in Project settings > Connection.

### 2. High. The concrete-model list in Defaults is Claude-only and ordered oddly (d1)
The dropdown lists Top/Deep/Everyday/Fast, then "Fable, Opus, Sonnet, Haiku". A non-Claude user sees no OpenAI or
LiteLLM models, so it reads as "this app is for Claude" and the caption "A specific model applies only where that
connection offers it" has nothing to anchor to. The four tier entries also have no divider or group label.
Fix: group the select (Tiers / Anthropic / OpenAI / LiteLLM) from discovered models of connected connections, and say
"not available on connection X" for the rest.

### 3. High. Long tier labels are clipped in the Defaults selects (d1)
"Deep tier (resolves per proj" is cut off in the monospace select. The key explanation is the part that is hidden.
Fix: widen the control or shorten to "Deep tier" with the "resolves per project" text moved into the row description.

### 4. Medium. The Automatic badge is inconsistent and unexplained (c5, c9)
Before any edit no tier shows a badge. After changing Deep to haiku and applying, Top, Everyday and Fast suddenly show
"Automatic", and Deep shows nothing. Manual tiers have no label of their own, so "no badge" means two things. The
explanation exists only as a hover title ("Chosen automatically; moves to a newer model when one is discovered"), which
a keyboard or touch user never sees. Apply gives no confirmation and no "saved" state.
Fix: show "Automatic" or "Manual" on every row, with a visible line under the heading ("Automatic tiers follow the
newest model found on refresh"), and a per-row "Back to automatic" action. Confirm after Apply.

### 5. Medium. "Last updated" is only a relative phrase in a collapsed card (c1)
"4 models · updated just now" in the subtitle is the only trace. No date or time on hover, and the per-card refresh icon
and the top "Refresh all" are not labelled with the same result. After a refresh there is no visible change for an
unchanged list. A user asking "when did it last fetch?" must infer it.
Fix: absolute time in a tooltip plus text, and a toast or inline "Up to date, checked 14:02" after refresh.

### 6. Medium. Tier editing is buried and allows empty or duplicate tiers (c6, c8)
The editor sits behind a chevron on the card, then "Model tiers (advanced)". The select has a "No model" option, and the
duplicate warning "Same model as Deep" appears under Fast although the duplicate is intentional in many setups (and
Fast and Deep both haiku is a likely mistake on a cost-minded setup). Nothing says what happens to roles on a tier
that has no model. The header row of a card is not clickable, only the small chevron toggles it.
Fix: make the whole header a toggle, rename "advanced" to "Model tiers", warn about "No model" consequence, and show
the impact (roles affected) before Apply, not only afterward.

### 7. Medium. New role: the model is a concrete name, the tier is a second badge (o2)
A new role gets "sonnet - Everyday" with a "Tier: Everyday" chip on the same row, repeating the same fact, and the node
on the canvas shows only "sonnet". It is unclear whether the role stored the tier (follows connection changes) or the
model (does not). "Inherit from parent" is the first option in the list but is not the selected one, so the default
contradicts the Defaults wording ("Report model: Everyday tier"). On the chart the orchestrator reads "haiku" with no
tier, although the Defaults say Deep.
Fix: show the stored choice, not only its resolution: "Everyday tier (sonnet on Anthropic)". Show the tier on the node
chip. Drop the duplicate chip.

### 8. Medium. Near-limit switch does not say which model or whether it applies (t2)
"Use the everyday tier near the limit: Starts reports on the everyday tier when the plan window nears its limit." It is
off and gives no concrete model, no state when the project's connection has no plan window (API key, OpenAI,
LiteLLM). "Threshold: 80% - Change in App settings" points at the App Defaults row "Weekly usage threshold" (a weekly
percent), while the row above says "five-hour window (%)". Two thresholds on two windows with similar wording.
Fix: append "(sonnet on this project)", disable with a reason when the connection reports no plan usage, and name the
window in both places.

### 9. Low. Price sources and the model price table (c1, c3, c4)
- The switch "Community price list" has no off/on text and no state after load (fetching, last fetched, failed). A
  user cannot tell if it works.
- The empty state "No overrides yet and none of your models are listed" is awkward; Claude models are priced but not
  "yours". "Show all 32 prices" is a link inside a sentence.
- Rows with "Built-in" and no way to see a community-sourced row until a model is added. The Source column contents for
  OpenAI/LiteLLM could not be checked.
- Add override: "Connection: Every connection" is a plain select with no hint for which model ids match.
Fix: label the switch state and last fetch time, simplify the empty state to "Showing prices for models you use",
make "Show all" a button.

### 10. Low. Create form (p1)
Skipping the Architect still requires "Describe what you want to build." (the button hint says so). The connection
used is "Runs on Anthropic. Change in App settings > Defaults." A user who wants OpenAI leaves the form. A project is
created on the default connection with no choice in the form.
Fix: allow an empty description when the Architect is off, add a connection select (or a clear "Anthropic - change") in
the form.

### 11. Low. New role is placed on top of an existing node (o2)
"New role" lands over the Researcher node, so after Add role the chart looks broken until the user drags or runs
Auto-layout.
Fix: place the new node in free space, or run layout after add.

## What worked
- The tier names Top/Deep/Everyday/Fast come with a one-line purpose in the editor.
- Project settings > Connection says "4 roles use this connection - Everyday tier: sonnet".
- Defaults states the fallback rule ("the run uses the deep tier and says so in its log").
- Model lists in the card are searchable and filterable by family, with tier chips per model.
