# UX review: Pocket Office rework (one building, living scene)

Reviewer: UX Researcher. Build: `bb2d055e` (worktree `agent-a4319757cd7f13de9`), `npm run build` run first.
How it ran: `ORGAI_MOCK=1`, a fresh temp data dir per pass, `ORGAI_MOCK_SCRIPT` runs written in a scratch folder outside the repo (spawn, message, finish, tool with `ask`, fail). No tokens, no smoke scripts. Window sizes 1600x1000 and 1024x640 (`setContentSize`), light and dark, Color, Neutral and Green palettes, one keyboard pass at 1600x1000 light, Reduce motion app setting on once.
Compared with: `docs/design/pocket-office.md` lines 1-134 and `ux-review-pocket-office-eval.md` (the earlier H1-H7).
Screenshots: `e2e/shots/ux/pocket-office-rework/ux-*.png` (gitignored). Names below drop the `ux-` prefix and `.png`.

## Verdict: PARTLY FIXED

The three things the owner named are mostly answered at 1600x1000. There are no floors: one building with a lobby, a corridor and visibly different department rooms (`m-1600-light-color-fit`). There is motion: I sampled the sprite frame every 60 ms for 4 s and each Running and Needs-you person changed frame 8 times (typing and waving), the arrival walk, the message walk, the bubble, the talk mark, the cheer and the slump all happened on cue. The state grammar reads without the side panel at 2x: amber question mark over a waving person (`n-1600-light-needs-4x`), green check on a finished person (`team-t20-1600-light`), red crossed screen plus mark on a failed person (`f-1600-light-failed-b`).

What is still wrong is not the art or the motion, it is where the camera and the page put you. (1) The moment something needs you, the permission card shrinks the scene to 291 px (1600x1000) or 114 px (1024x640). (2) The default 2x view shows a cropped map, so message bubbles and marks land on people who are off-screen or cut by the stage edge. (3) At Fit and 1x the building is small in a big empty stage and the cues are 16 px. An observer who sees the default view at 1024x640 with a permission card open would still say the office is tiny and nothing is going on.

## Status of the earlier eval (`ux-review-pocket-office-eval.md`)

| Earlier item | Now | Evidence |
| --- | --- | --- |
| H1 nothing moves for most of a run | Fixed at 2x, weaker at 1x and below | frame changes measured at 2x; at 1x and Fit the cues are 16 px (see M3) |
| H2 walks too short and rare | Fixed | `team-t7`, `team-t9`: outbound, settle, return, dev-a1 crosses a door into the corridor |
| H3 cannot tell who talks to whom | Partly fixed | talk mark plus bubble plus inverted plates (`team-t9`); breaks when an end is off-screen (H2 below) |
| H4 cross-floor messages never animate | Fixed | no floors; both ends get a mark and bubble |
| H5 rooms alike, mostly empty floor | Fixed | four rooms with four looks (`m-1600-light-color-fit`, `t33-1600-light-fit`) |
| H6/H7, M5-M7 floors | Fixed | no floor controls or strings seen |
| M1 people change floor | Fixed | n/a |
| M2 a pending approval crushes the scene | Open, worse in effect | H1 below |
| M3 plates bigger than people | Fixed at 1x (no plates), partly at 2x | plates still cover the aisle rug at 2x (L2) |
| M4 state carried by text | Fixed | marks, poses, screens |
| L1 Team says "Role" | Changed: now the department name, which duplicates the name for leads (L1 below) | `t33-1600-light-default` |
| L2 scene vs panel wording | Open | M5 below |

## Findings

### H1. A Needs-you card turns the scene into a thumbnail, and the card does not say who is waving

- Where: Live, any size, one permission card open. Shots `final`, `n-1600-light-needs`, `n-1024-dark-needs`.
- Repro: run a script where a report (`dev-a1`) makes a tool call with `ask: true`. Wait for the amber mark. Resize to 1024x640.
- Saw: stage height 291 px at 1600x1000 and 114 px at 1024x640 (measured `clientHeight`). At 1024 the Needs-you person and the question mark are about 5 px. Press Fit and it goes to ½× (`n-1024-dark-needs`). The card says "Permission / Implementer / Edit example.ts / Run R1: Needs team". The scene calls the same person `dev-a1`. Nothing links them: no "Show" on the card, no ring on the person. The owner's test ("who needs you without reading the side panel") fails here, and it is the one state where the user must act.
- Spec says the permission-card layout is out of scope for this rework. The owner will still see it first, because Needs you is the moment they look.
- Fix: (a) keep a minimum stage height (say 240 px) and let the card area scroll inside the frame at 1024x640. (b) Give the card a person link: a button `Show {name}` that pans and rings the waving person, same as the strip's Show. (c) Put the person's name in the card title: `{name} wants to edit example.ts`. (d) While any person is in Needs you, the stage header could say `1 needs you: dev-a1` with the same Show button.

### H2. The default view crops the building; marks and bubbles land off-screen with no hint

- Where: Live, 1600x1000, any run with 3 or more departments. Shots `team-t3-1600-light`, `team-t9-1600-light`, `team-t14-1600-light`.
- Repro: 3 leads, 2 reports, message dev-a1 to dev-b1, then lead-b to lead-c. Do not touch the camera.
- Saw: default zoom 2 with the lobby centred shows the lobby and two rooms. The third department (lead-c) is wholly off-screen, and dev-b1, the recipient of the first message, is cut by the stage's bottom edge (plate half hidden, `team-t9`). The lead-b to lead-c message produced a bubble and a talk mark that were both outside the visible stage (state said `bubbles: lead-c=...`, `marks: lead-b:talk`; `team-t14` shows neither person on screen). The strip row exists, but a user watching the stage sees nothing happen. Only scrollbars hint that more exists. This recreates the old "I saw no motion" complaint for cross-room messages.
- Fix: choose the default view by content, not just by fit-at-2x: if the building does not fit at 2x and has two or more rooms, open at the largest zoom where it fits (usually 1x) or add 1.5x to the set (see M3). Add a small edge indicator when a bubble or Needs-you mark is outside the viewport, e.g. a chip at the stage edge `lead-c: message` that pans there. At minimum, when a message arrives off-screen and the user has not panned for 10 s, pan once to include recipient and sender (the spec forbids following conversations automatically; an opt-in `Follow messages` toggle is the cheap middle ground).

### M1. Fit leaves most of the stage empty; zoom steps are too coarse

- Where: Live 1600x1000 (`m-1600-light-color-fit`), Team 33 roles (`t33-1600-light-fit`).
- Saw: Fit on a 42x23-tile building is 1x (672x365 px) in a 985x619 stage, about 25% of the area; the next step down is ½× (`m-1600-light-color-half`), where people are 8 px and the Orchestrator's plate is bigger than the lobby's desk. Team 33 at Fit is ½×, a 470 px wide block in a 1000 px stage.
- Fix: add 1.5x to the zoom set (Fit rounds to the nearest 0.5 step), or let Fit use a non-integer scale up to 2x while keeping the discrete steps for `+`/`-`. Copy for the readout stays `1½×`.

### M2. At 1024x640 Fit in Team view does not fit; the building is clipped

- Where: Team, 33 roles, 1024x640. Shots `t33-1024-dark-neutral-fit`, `t33-1024-light-green-fit`.
- Repro: open Team, press Fit.
- Saw: stage is about 210 px tall; the building at ½× needs 264 px, so Fit is clipped top and bottom with a vertical scrollbar. The Engineering row is half off the top. Fit's promise ("whole building") is broken because the floor is 0.5.
- Fix: let Fit go below ½ only for Fit (¼× is unreadable, so instead raise the Team stage minimum height to about 300 px by collapsing the Team assistant panel under the stage at 1024), or say it: when Fit cannot fit, show `Zoomed out as far as it goes. Scroll for the rest.` in the zoom readout's `title`.

### M3. At 1x and Fit, "who is working" is a 16 px guess

- Where: Live at Fit (`m-1600-light-color-fit`, `m-1024-dark-color-fit`).
- Saw: the check on the finished person is clear at 1x. Running people read as seated people at lit screens; I could not tell Running from Idle at 1x by looking, since the difference is a dark screen versus a lit one and a 2-frame flicker. Neutral and Green are the same (`m-1600-dark-neutral-fit`, `m-1600-light-green-fit`). The Needs-you question mark at 1x was not captured at a readable size (see Not driven).
- Fix: a 1x-only cue that survives distance: a 2 px state strip under the desk edge (Running = accent bar, Idle = none) or draw the screen glow wider at 1x. Check this with the owner's test: three people, one idle, ask which is idle.

### M4. Pause motion shows no pressed state and its label never changes

- Where: stage toolbar (`f-pause-toolbar`). 
- Repro: click `Pause motion` with the mouse and move the pointer away.
- Saw: `aria-pressed="true"`, but the button is identical to unpressed (white fill, regular weight, same text). A sighted user cannot tell the scene is paused; the first thing they think on later returning is that the office broke. Under the Reduce motion app setting the button stays active and does nothing (the clock is already stopped).
- Fix: label swap `Pause motion` / `Resume motion`, plus the same selected fill the Fit button uses when it is current. Under Reduce motion show `Motion is off in Settings` and disable it.

### M5. Names in the side panel and the scene disagree; "Implementer to Implementer"

- Where: Inspector on a selected person, `k-show-after` (bottom right "Office messages").
- Saw: strip says `dev-a1 to lead-c`, the inspector says `Implementer to Implementer`. With shared roles (the normal case) the panel is unreadable as a conversation.
- Fix: use the same handle in both: `dev-a1 to lead-c`.

### M6. Escape does nothing from a person; the way back is a late Tab stop

- Where: Live, keyboard. Shots `k-person-enter-inspector`, `k-after-escape`.
- Repro: Tab to a person, Enter, Escape.
- Saw: the inspector stays on that person and focus stays on the person button. `Back to office` is Tab stop 22 of about 28, after the composer. I did not find another keyboard route out. The brief asked for "Escape back".
- Fix: Escape on a person or in the inspector deselects and returns to Orchestrator (or closes the panel) and keeps focus on the person; or put `Back to office` before the composer in tab order. Announce `Back to the office` once.

### M7. Show pans to the person but the bubble is cut by the stage edge; Find panel squeezes the stage

- Where: `k-show-after`, `k-find-open`.
- Saw: Show lead-c placed lead-c with 24 px margin, so the bubble above it was clipped at the top (only `we merge it to main.` visible). Opening `Find a person` (6 rows) took the stage from 619 to about 450 px at 1600x1000; the row text is a full sentence of status each, repeating what the plate says.
- Fix: when the target has an active bubble, include the bubble's height (about 80 px) in the margin. Make the Find list a compact name list (`lead-c · Running`) and cap it at 4 visible rows.

### L1. Team: the lead's plate says the same thing twice; department names come from lead names

- Where: Team, `t33-1600-light-default`.
- Saw: `Engineering lead / Engineering lead`, `Orchestrator / Orchestrators`, room label `Engineering lead · 8`. With real teams named like "Platform lead" the department becomes "Platform lead". Live had the same naming (`lead-a · 2`).
- Fix: for the lead, show the role title on line 2 only if it differs from the name, else `Lead`. Strip a trailing ` lead` from the department label. Needs a small decision from the design owner (listed as open in the spec).

### L2. At 2x the plates cover the aisle rug and neighbouring props

- `team-t3-1600-light`: plates sit on the aisle rug, two lines high, and are wider than the person they label at 2x. Fix: one line (`name` only) with the status as a 3 px state dot, full two lines on hover and focus.

### L3. Failed reads as a red blob

- `f-1600-light-failed-b`: red crossed screen and a red triangle mark on the same screen area. At 2x the mark is lost against the glass. Fix: lift the mark above the head instead of over the screen for the failed state, or draw it on a paper-coloured disc (as the question mark and check already are).

### L4. Small ones

- Announcement text duplicates: `Showing lead-b, lead-b` (name equals room label in my data). Fix: skip the room label when it equals the name.
- The stage label does not mention Home, and there is no visible Home or drag hint. Fix: `Office scene. Arrow keys pan, plus and minus zoom, 0 fits, Home resets the view. Drag to pan.`
- Message strip: with 2 rows a small vertical scrollbar shows at the strip's right edge (`team-t14`), so the "last 3 messages" log scrolls inside a 48 px box. Fix: size the strip to its rows or hide the scrollbar until 3 rows overflow.
- Solo run: the lobby is a large mostly empty room with one desk; the door glyphs sit outside the left wall (`solo-1600-light`). Fix: use the lobby's reception desk for the single worker, or centre the orchestrator on the reception.
- Dark theme: the inspector `Back to office` header is a bright cream bar (`m-1600-dark-neutral-fit`); it is the paper-and-ink style, but it is the brightest thing on a dark screen. Check with the owner.

## What passed

- Motion exists and is measurable: typing and waving swap frames (8 changes in 4 s each); `data-office-animated` was 4 to 6 with 6 people; clock `running` during the run and `stopped` after Idle, in Team, with Pause, and under Reduce motion.
- Arrival walk seen (`lead-b` and `lead-c` `arriving/arrive` at t0), outbound/settle/return seen for dev-a1 and dev-c1, the bubble for a 70-character message stayed up about 4 s, which was enough to read in the screenshots.
- Cheer then settle: `finished/cheering` one second, then `none` with the check mark staying. Slump: `failed/slumping` then `none`.
- Reduced motion: every `data-office-cue` was `none`, clock `stopped`, and the bubble still appeared (`k-reduced`).
- Keyboard: Tab order is toolbar (Zoom out, Zoom in, Fit, Pause), stage, people in building order, Find a person, composer. Arrows pan 48 px, Shift+arrow 192 px, `+`/`=` and `-` step zoom (4, 3, 2, 1, 0.5), `0` Fit, `Home` returns to the default view, drag pans, `Show {name}` and Find select, pan and announce (`Showing lead-c, lead-c`). Focus rings are visible on buttons and on Pause; the person focus ring is a thin dark box and was the weakest ring I saw (`k-person-focus`).
- No page scroll at either size (`pageScroll: false` in every sampled state).
- Neutral and Green carry the marks by shape (check seen in `m-1600-dark-neutral-fit`, `m-1600-light-green-fit`).

## Not driven or not verified

- Needs-you at readable size in Neutral and Green, and the failed state in Neutral and Green at 2x (I only looked at the Color palette at readable size).
- A walk for lead-b to lead-c: I polled once per second and saw a mark and a bubble but no walking cue; I cannot say whether the route was too long or the walk was skipped.
- Mouse wheel pan, hover plates at 1x, touch.
- Find a person open at 1024x640 and the solo run at 1024x640.
- A failed report: the mock only fails the root (`fail` step). After the root failed, the three reports stayed Running, which is mock behaviour, not necessarily real behaviour.
- More than 12 people animating at once, the 3-walk cap, and the arrival queue (my runs had at most 7 people).
- Real provider timing, screen reader speech for Pause and Find announcements, and any perceived performance on a 33-person live team (Team view has no clock).
- A real first-time user: this is one researcher's read, not a task test.
- Two shot names are mislabelled: `m-1600-light-color-1x` is actually ½× (my zoom clicks).
