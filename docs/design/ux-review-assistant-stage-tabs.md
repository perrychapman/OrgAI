# UX review: assistant sessions without the side panel (stage tabs)

- Reviewer: UX Researcher (first-time-user walk, no source edited)
- Build: `c02d5365` (dev), `npm run build`, run through `e2e/lib.mjs` scripts
- How it ran: `ORGAI_MOCK=1`, fresh temp data dir per script, no tokens. Sizes 1280x800 (dark and light for the work run) and 1024x640 (light; dark for the Chat); keyboard pass at 1024x640 light. Both themes were set through the real settings route. Not every screen was captured in all four size/theme combinations; see "Not driven".
- Compared with: `docs/design/assistants-ui.md`, section "No side panel for assistant sessions (2026-11-11)".
- Shots: `e2e/shots/ux/assistant-stage-tabs/` (gitignored; scripts `walk1.mjs` to `walk6.mjs` beside them).

## Verdict: WORKS, THREE CUES MISSING

A first-time user finds Usage and Logs without help, gets back to the conversation, and a send from any tab lands on Conversation with focus still in the composer. The strip is a proper tab group (one Tab stop, arrows move and select, focus ring visible, shot 12). Nothing blocks a task. What is weak is that the strip hides what the old panel used to show without saying so: a reply that arrives on another tab gives no cue, "Show thinking" is gone from the conversation, and Chat keeps a Plan tab that never has anything in it. The three layouts (assistant strip, work run rail, Ask rail) also disagree about where run details live.

## Findings, ranked

### M1. A reply arriving while Plan, Usage or Logs is open gives no cue on the Conversation tab (open point a)

- Screen: Chat, 1280x800 dark. Shots `03-chat-usage`, `05-usage-after-reply`.
- Repro: start a Chat, send "Say hello...". Open Usage. Type a second message in the composer and press Enter: the stage returns to Conversation (good). Now instead, send, then quickly click Usage before the mock replies (or open Usage while a long reply is streaming). The strip stays exactly as it was when the reply finishes (`05`).
- Experience: the only signal is the composer line changing back to "Your turn. Reply, ask a follow-up, or end the session." That tells the user it is their turn, not that there is text to read. Someone reading the Usage table can sit there waiting. The old side panel had the same blind spot on its Transcript tab, but there the transcript was also visible beside the tab, so the gap is new.
- How much it hurts: medium. Mitigated because Send always returns to Conversation, so it only bites a user who leaves Conversation while a reply is in flight (long replies, approvals, a decision answered from the tray). In a slow real-provider run that is a common thing to do, since the cost and log tabs invite a look.
- Smallest fix: a small dot on the Conversation tab while another tab is selected and the root has added transcript entries since that tab was left; clear it when Conversation is selected. Give the tab the name "Conversation, new reply" while the dot shows, and announce once through the existing polite region: "New reply in Conversation." No count, no animation (motion rules).

### M2. Chat shows a Plan tab that is empty, while MCP and Skill assistants do not (open point c)

- Screen: Chat 1280x800. Shot `03-chat-plan`. Compare `21-mcp-conversation`, `31-skill-lib-conversation`.
- Repro: start a Chat, open Plan.
- Experience: "No plan yet. On work runs the orchestrator writes a plan first; it appears here, and OrgAI keeps the run going until every step is done." A Chat has no orchestrator and will not get a plan, so this reads as something the user is waiting for, or has misconfigured. MCP assistant and Skill assistant strips read Conversation / Usage / Logs; Chat reads Conversation / Plan / Usage / Logs, so the same strip differs for the three assistants for no reason a user can see.
- How much it hurts: medium-low. It costs one wasted click and a small doubt per new user, forever, on the most used assistant.
- Smallest fix: apply the rule the other two already follow (Plan only once a plan exists) to single-agent Chat. If the tab must stay, replace the copy with: "This chat has no plan. Plans appear on work runs."

### M3. Run details live in three different places depending on run kind

- Screens: Chat/MCP/Skill `02-chat-conversation` (strip above the conversation); work run `41-work-toggled-conversation` and `40-work-1280-dark` (collapsed icon rail at the right edge, tabs Transcript / Plan / Usage / Outputs / Logs); Ask run `50-ask-run` (identical conversation page to Chat, a rail at the right, no strip).
- Experience: three conversation-style pages look the same (90ch column, composer below) but Usage is a visible tab on one and a labelless rail icon on the other two. Nothing "moved without a cue" for a new user, who never saw the old panel, but a user who has both an Ask run and a Chat open will not find Usage in the same place twice. A work run in the conversation layout has no strip, so the cleaner discoverability of the Chat version is not shared.
- Ask and the saved-as-project Chat: Ask keeps the rail, and its panel has a Transcript tab that repeats the conversation (confirmed `ASK panel tabs: Transcript, Plan, Usage, Outputs, Logs`). It feels inconsistent, because Ask is a single-agent conversation like Chat. The duplicate is mild while the rail is collapsed by default; it will be noticed when someone opens it.
- How much it hurts: medium for a returning user, low for a new one.
- Smallest fix: next step is to use the same `RunStageTabs` strip for single-agent Ask runs in the conversation layout (they are `isSingleAgentRun`), and leave multi-agent work runs on the panel. Until then, give the rail toggle a visible label or tooltip "Run details" so it is findable.

### M4. "Show thinking" and the agent's token/cost meta line are only on the canvas (open point b)

- Source: `TranscriptPanel.tsx` renders the "Show thinking" checkbox and the agent meta only in the panel variant (read in code; the mock script has no thinking block, so I did not see thinking text hidden). Walked the canvas: `06-chat-canvas`, `15-canvas-node-selected-light-1024`.
- Experience for the meta line: low impact. Cost and elapsed time stay in the run meta row above the strip, model and effort are in the composer's switch row, tokens and cost are in the Usage tab. The only thing truly lost is the in/out token split per agent.
- Experience for Show thinking: medium for the few users who read reasoning, zero for the rest. The conversation view gives no hint that thinking exists or where it went. On the canvas, a node click did not bring out a visible transcript with a toggle in my walk (rail stayed collapsed, shot `15`), so reaching it takes three steps (Show agents, open the rail, select the agent).
- Smallest fix: put the same checkbox at the right end of the strip row, visible only on the Conversation tab ("Show thinking"), writing the same setting the panel variant uses. Keep the meta line off; it duplicates the run meta row.

### M5. Numbers disagree on the same Usage tab (mock artifact, needs a real-run check)

- Screen: `05-usage-after-reply` after a second turn: the By agent row read 1.6k tokens and $0.00285 while the Cost card and run meta still read $0.001425, and 820 tokens. They matched after a moment on the canvas (`06`, $0.00285).
- Experience: two figures for one run on one screen. This may be a mock update ordering issue and is not caused by the change, but the stage tab makes the Usage tab the first place a Chat user looks, so a stale card is more visible than before.
- Smallest fix: verify with a live-provider run; if it reproduces, derive the cards and the table from the same summary.

### L1. Canvas toggle gives no cue that the panel returns

- `06-chat-canvas`: "Show agents" swaps to the canvas and the strip disappears; the panel comes back only as a collapsed rail. A user who was on Usage sees their tab vanish with no sign where it went. Shot `06`. Recommend the toggle tooltip read "Show agents (details move to the side panel)", or reopen the panel on the tab the user was on. Also: returning to Conversation restores the previously selected stage tab (Usage in `07-back`), not Conversation; fine, but combined with M1 it means a user can land on Usage with no cue at all. Prefer returning to Conversation.

### L2. Canvas card and model switch name different models in the mock

- `06-chat-canvas`: node reads "opus-4-5", switch reads "Sonnet · Anthropic". Likely mock data; check on a real run, because the model switch is meant to own the applied selection.

### L3. Composer hint clips at 1024x640

- `10-chat-light-1024`: "Enter to send . Shift+Enter for a new line . paste or drop i..." is truncated, pre-existing, not from this change.

### L4. Plan tab text is offset from the strip

- `03-chat-plan`: the note starts at x=477, the strip at x=445. Small, aligned content column. Fixing M2 makes it moot for Chat.

## What worked (kept short)

- Task flow: Chat > send > Usage > Logs > Conversation > send from Logs returns to Conversation, composer focus kept (`04-after-send-from-logs`).
- MCP assistant and Skill assistant (library, and project through Team > Catalog > Skills > Ask the Skill assistant): strip reads Conversation / Usage / Logs; the proposal card stays in the tray on every tab so a decision cannot be missed (`32-skill-lib-usage-with-card`, `71-skill-1024-light-usage-tray`). At 1024x640 the tray collapses and the Usage table still scrolls; no page scroll.
- Keyboard (1024x640 light): Tab from the Conversation tab goes to the conversation region, "Show output", the model switch, permission, attach, composer; the strip is one stop; ArrowRight moves and selects (Usage after two presses); Tab from Usage goes to the tab panel; Shift+Tab goes back to Show agents. A send by Enter from Usage returns to Conversation with the textarea focused. Focus ring is visible on the strip and composer in both themes (`12-kb-usage-focus-light`).
- Light theme and 1024x640 shots show no clipping of the strip (`10`, `11-chat-light-1024-*`).

## Not driven

- A Chat saved as a project: the "Save as project" button did not appear (0 matches) for a Chat started with a typed folder path in my runs, in a data dir where that folder was and was not yet a project, so I could not drive the promote flow or see the panel returning afterwards. Not judged beyond the Ask observation above.
- The work run at 1024x640 light was captured (`42-work-1024-light`) but not studied beyond layout; no strip, rail only.
- Dark at 1024x640 for the MCP and Skill assistants, light at 1280x800 for them: not captured. 1600x1000 not walked (the brief asked for 1280 and the narrow size).
- Reply timing for M1 was reasoned from a screenshot taken after the reply (the mock replies in about a second); I did not capture a frame mid-stream on another tab.
- Live thinking blocks and real multi-line replies: the mock does not produce them.
- Screen-reader speech: not tested.
