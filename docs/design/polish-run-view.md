# Run view polish pass

Looked at on the mock adapter (token-free), built app, 1024x640 and 1600x1000, dark and light, with a 2-agent work run, a
40-agent `[mock:factory-floor]` run, a provider-error hold, a long project name and run title, Markdown tables, RTL text,
emoji, long unbroken words and URLs, wide code blocks, Chat, the Tools helper start page, the New run page and the one-agent
view. Screenshots are in `e2e/shots/` (gitignored): `polish-a/b/c/d/g/i/j/k/l/m-*`; the regression run writes
`transcript-media-05..08-overlap-*`.

Severity: High = a user loses text or a control, or the feed is unusable; Medium = clipped or misleading, a visible defect in
common use; Low = polish.

## The overlap bug (F1, High, fixed)

**What.** After the feed was taller than its panel, an assistant row (`.entry.text.has-avatar`) was drawn at 24 px while its
text needed 40 px or more, so its last lines painted over the next row. Longer replies (the mock's are one or two lines;
real ones are paragraphs) lost far more: a row shrank to 24 px however long it was.

**Cause (measured).** `.transcript` is a flex column and, in the dock, also the bounded scroller (`.side-run >
[role=tabpanel]`, `overflow-y: auto`). A flex item shrinks (`flex-shrink: 1`) down to its `min-height` when the content is taller
than the box. Rows normally have `min-height: auto`, which is their content height, so they cannot shrink. The avatar row sets
an explicit `min-height: var(--space-6)` (24 px), which replaces `auto`: it shrank to 24 px. Measured in the page:
`entry text has-avatar` rect height 24, `scrollHeight` 40, list `scrollHeight` 708 > `clientHeight` 507; next row's top 12 px
below. No virtualised list or cached height is involved (`TranscriptPanel` renders every row).
It appears only once the dock overflows, which is why it showed up "on subsequent messages", and a narrower dock or longer
replies make it worse.

**Fix.** `transcript.css`: `.transcript > *`, `.conversation-newest > *` and `.conversation-earlier > *` get
`flex-shrink: 0`. The panel scrolls instead. No padding, no JS.

**Regression check.** `e2e/transcript-overlap.mjs` (called at the end of `e2e/transcript-media.mjs`) makes a work run and
sends three messages (short; long multi-paragraph with a list, a code block and an unbroken URL; medium) and measures the
feed rows in the page for each message while the mock streams, after a window resize to 1024x640 and 1600x1000, after the dock
is resized (Home / End on its handle), after Hide then Show, and in a Chat session. It asserts: no two rows' boxes intersect,
no row is shorter than its content (`scrollHeight`), and at the end of the feed the last row is above the composer and inside
its scroller. `E2E_OVERLAP_OLD_CSS=1` re-injects the old behaviour: 11 checks fail with `entry.text 24<60`; without it all pass.

## Findings

| # | What | Where | Sev | State |
| --- | --- | --- | --- | --- |
| F1 | Text drawn over the next message (above) | `transcript.css` | High | Fixed |
| F2 | Feed had under 30 % of the dock at 1024x640 (179 px): the Hide button, "Open agent view", title, tabs, details and a "Show thinking" row each took a line | `canvas-chrome.css`, `TranscriptPanel.tsx`, `transcript.css` | High | Fixed: Hide button sits on the first line (absolute, z-index above the header's 2), "Show thinking" moved to the title line; feed 179 to about 260 px |
| F3 | Settings row (Model, Effort, Permission, Goal) scrolled sideways behind an arrowed system scrollbar and cut chips mid-word; its screen-reader text widened the composer card's scroll area and drew a second scrollbar along the card's bottom edge | `run.css`, `live-model-switch.css` | High | Fixed: chips shrink (value ends in an ellipsis, the model last), `min-width: auto` keeps the label, the row is `position: relative`, the card is `overflow-x: hidden`, the global slim scrollbar applies. At 1024 the row still scrolls a little (4 chips in 250 px), see "left" |
| F4 | Run tab title cut by the close button with no ellipsis; close button 20x20 | `run-tabs.css` | Medium | Fixed: tab reserves room for the button, button is 28x28 |
| F5 | Toolbar: at a 688 px frame (1024 window, dock open) the Theme menu was clipped to a sliver and the last meta chip lost 10 px; same at 752-755 px (1100-1280 windows) | `run-header.css`, `canvas-chrome.css` | Medium | Fixed: the meta's 256 px floor starts at 800 px, groups sit 8 px apart under 800 |
| F6 | Dock tab strip clipped "Logs" at 280 px | `transcript.css` | Medium | Fixed: smaller tab text and tighter gap under 340 px of dock |
| F7 | Chat / conversation layout: the composer card spanned the whole window (1340 px) under a 600 px reading column | `layout.css` | Medium | Fixed: card is as wide as the column (90ch + padding) |
| F8 | Empty composer field drew its own vertical scrollbar when the placeholder wrapped to two lines in a clamped 32 px field | `run.css` | Medium | Fixed (`:placeholder-shown { overflow: hidden }`); the second placeholder line is still cut at the box, see "left" |
| F9 | "Show details / Show output" disclosure hit area 16 px high | `transcript.css` | Low | Fixed: 24 px (4 px padding) |
| F10 | Dock Hide button hidden behind the header in the one-agent view | my own first change to F2 | Medium | Found in testing and fixed (z-index) |
| F11 | Decision card shown twice in the one-agent view: once in the agent's Activity ("Waiting on you") and again in the tray under it, both live | `AgentFocus.tsx`, tray | Medium | Left: a design decision (the board puts the card in the agent view; the tray is kept so a hidden or covered view never hides a decision). Sent to polish-shell |
| F12 | Two buttons with the same speech-bubble icon beside each other when the dock is hidden ("Conversation" and the layout toggle "Show conversation") | `LiveRunView.tsx` toolbar | Low | Left: they do different things (dock vs full-stage conversation); owner to decide labels or one control |
| F13 | Hide finished agents switch is 32x20 (under 24 high) | `ui/Switch` (shared) | Low | Left: shared primitive, not ours |
| F14 | Node activity on a failed root reads "max budget usd" (raw error subtype) and the status chip says "Idle" for `[mock:budget-stop]` with no cap set | main / `AgentNode` text source | Low | Left: text comes from the runtime; no hold card without a cap is by design |
| F15 | Run title built from a marker prompt reads "Budget run mockbudget-stop" | title sanitizer (main) | Low | Left: mock-only artefact |
| F16 | Tools helper start page uses a plain bordered textarea with a resize grip, unlike the run composer | `assistants.css` | Low | Left: owner to decide whether the start pages share the composer card |
| F17 | New run page: five settings in a two-column grid leave the last card alone on its row; top aligned at 1024, centred at 1600 | `new-run.css` | Low | Left: layout decision |
| F18 | 40-agent run: screenshots and Playwright clicks waited up to 30 s while agents were active (software rendering, backdrop blur over large areas) | run view | Medium (unmeasured) | Left: not profiled; needs a GPU-backed Windows check with the performance panel |

Not found (checked): RTL text, emoji, headings, quotes, lists and wide code blocks were looked at in screenshots (they wrap or
scroll inside the bubble); Markdown tables and long unbroken words and URLs were measured (no overlap, no page overflow) but
their bubbles were not opened in a screenshot; horizontal page overflow at both sizes, focus rings on the chips, tabs and composer, the hold card in both
themes (scrolls inside the tray, action row sticky), the New run page in both themes.

## Left for the owner

- One decision card, two places in the one-agent view (F11).
- The settings row at 1024: four chips cannot read in a 250 px dock. Options: one line with a scroll (as built), two lines (costs
  about 30 px of feed) or drop the "Model:" and "Effort:" prefixes under 340 px.
- The two speech-bubble buttons (F12) and the helper start pages' composer (F16).
- Run-level labels for a raw runtime error (F14).

## Unverified

Screen-reader speech, real providers, a GPU-backed machine (F18), macOS and Linux, engagement runs (not walked here: no
engagement project was created), Pocket Office and Factory Floor scenes (other owners), the run window.
