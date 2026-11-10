# UX review: Pocket Office, does it feel alive and make sense?

- **Reviewer:** UX Researcher (evaluation, not spec compliance)
- **Build:** `e5e1de2f` (worktree build, `npm run build`)
- **How it ran:** `ORGAI_MOCK=1`, throwaway data dir, scripted mock runs (`ORGAI_MOCK_SCRIPT`), Playwright over `e2e/lib.mjs`. Presentation Pocket Office, palette Color. Window set with `setContentSize` to 1600x1000 and 1024x640. Dark first, light sampled at both sizes. One keyboard pass at 1600x1000 light.
- **Compared with:** the owner's complaint ("not any motion", "feels clunky", "not enough visual assets", "floors doesn't feel right"). Not compared with the spec.
- **Shots and raw samples:** `e2e/shots/ux/pocket-office-eval/` (gitignored). Walk scripts `walk1.mjs` to `walk6.mjs`, per-200 ms sprite samples `samples-*.json`, analysis `an.cjs`, floor surveys `floors-*.json`.

## Verdict: the owner's complaint is confirmed

The scene is a still room with captions under it. In a 102 s mock run with six agents and seven messages, anything moved for about 6 % of the time (30 of 512 samples at 200 ms), in six sub-second walks. At the default zoom in the same kind of run nothing moved at all for 88 s, because the people talking were never on the same floor. The art is charming at 3x, but most of the stage is blank beige, rooms are copies of each other, and the floor count changes with zoom (a 4-person team is 1 floor at 1x, 2 at 2x and 4 at 3x, one person per floor). I would not call this a "pocket office" yet. It reads as an org chart drawn with furniture.

## Numbers measured

| Measure | Result |
| --- | --- |
| Time with any sprite moving, 102 s run, 6 agents, 1x zoom, floor 1 | 5.9 % (30 / 512 samples). Six walks, each 0.6 to 1.0 s. |
| Same kind of run, 2x zoom (the default at 1600x1000), 88 s | 0.2 % (1 sample, and that was a person being re-laid out onto another floor). Zero walks. |
| Messages that produced a walk | 6 of 7 in the 1x run; 0 of 4 at 2x |
| Quiet working stretch, 0 to 20 s | Zero movement. People pop in at about 3 s intervals with no transition. |
| Share of stage that is empty floor, 6 agents live, 1x, 1600x1000 (nothing else open) | about 71 % (building about 640x278 px inside a 985x619 stage) |
| Same, 4-person Team view, 1x, 1600x1000 | about 67 % |
| Same, 1-person Team view, 1x, 1600x1000 | about 92 % |
| Same, 33-role Team view floor 1, 1x, 1600x1000 | about 47 %, with 17 people |
| Floors, 4-person team, 1600x1000 | 1x: 1, 2x: 2, 3x: 4, 4x: 4 |
| Floors, 4-person team, 1024x640 (Team view) | 1x: 2, 2x: 4, 3x: 4, 4x: 4 |
| Floors, 6 live agents, 3 departments, both sizes (Live) | 1x: 2, 2x: 3, 3x: 3, 4x: 3 (same at 1600x1000 and 1024x640) |
| Floors, 33 roles, 1600x1000 | 1x: 2, 2x: 5, 3x: 5 |
| Floors, 33 roles, 1024x640 | 1x: 5, 2x: 5, 3x: 5 |
| Stage height with a permission card open, Live | 301 px at 1600x1000, 114 px at 1024x640 (279 px and 619 px without it) |
| Cost to find a person on another floor | 2 clicks (open "Find a person", click the row), then the floor jumps |

## Motion

### H1. For most of a run, nothing on screen moves, and nothing marks that anything is happening

- **Shot:** `bursts/w3-dark-1600x1000-z1-quiet-0.png` to `quiet-3.png`; `01-t12s.png`
- **Steps:** Live, Pocket Office, start a mock run that spawns 5 agents, one message every 3 s. Watch 100 s. Sample sprite x/y, pose and frame every 200 ms.
- **Saw:** Spawn: a person simply appears at its desk (at 5.0 s, 8.7 s, 11.8 s, 14.8 s, 17.8 s), no arrival, no door, no fade. Working: the sprite is frozen; no typing, no screen glow, no idle sway. A working person and a finished person differ by arm position only (`cmp-working-vs-finished.png`), which is invisible at 1x. Waiting for the user ("Needs you"): the sprite is the same as working, only the nameplate text changes, and in a multi-floor team the person is often on another floor so you cannot see it at all. Failed: the orchestrator turns "Failed" with an unchanged sprite and no red cue (`fail-state.png`). The only thing that ever moves is a walk to another person.
- **Why it feels clunky:** a live agent run is minutes of silence punctuated by a half-second walk. The user cannot tell a running scene from a screenshot.
- **Severity:** High.
- **Direction:** every state needs a visible idle loop (typing at the desk, glancing, a thinking bubble, a raised hand for "Needs you", slumped or red cue for failed, an exit and a settled pose for finished). Arrivals and departures need a short transition.

### H2. Walks are the only motion and they are too short and too rare to read as conversation

- **Shot:** `bursts/w3-dark-1600x1000-z1-delivery1-0-t27.png` to `delivery6-5-t27.png`
- **Steps:** same run. When `office-deliveries` reports an active delivery, take six screenshots 120 ms apart.
- **Saw:** An outbound walk, settle, return lasts 0.6 to 1.0 s (for example lead-a: 20.8 s to 21.4 s). The walker covers a few tiles between neighbouring desks, then walks back. During the walk the sprite passes behind the neighbouring nameplate, so "Alan Running" is cut to "Alan Runni" under Alice's plate. A user who looks away for a second misses it. The speech is not shown at the people; it goes to a caption strip.
- **Severity:** High (the headline feature barely registers).
- **Direction:** the message should be visible at the two people for the length of the exchange (a bubble that lingers), and the walk should be long enough to read, with the recipient reacting.

### H3. Which agents talk to which cannot be told from the scene, and the caption sits far from them

- **Shot:** `bursts/w3-dark-1600x1000-z1-delivery2-1-t27.png`
- **Steps:** as above. Look at where the caption appears while Alan walks to Alice.
- **Saw:** The caption "Alan to Alice · Endpoint is drafted, tests next?" is at the bottom of the stage strip, about 400 px below the people, at the left edge, and it disappears when the walk ends (0.6 to 1.0 s after it appears at 1x). The caption is the only way to know who is speaking. Without it a walk is just a person strolling. Nothing connects the caption to the two people (no highlight, no line).
- **Severity:** High.

### H4. Messages between floors never animate, and at the default zoom that can mean no motion for the whole run

- **Shot:** `01-t12s.png`, `03-waiting-before-allow.png`, `f-nocard-dark-1600x1000-z2-floor1.png`
- **Steps:** 6-agent, 3-department mock run at the default 2x zoom, 1600x1000. Messages between the two department leads, and between members.
- **Saw:** Floor 1 holds the Central room with the orchestrator only. Ada's department is on floor 2 and Bea's on floor 3. Every message was cross-floor or off-floor, so there were zero walks in 88 s and the caption strip said "Messages appear here as agents communicate." for most of the run, then briefly "Bea to Ada · Floor 3 to floor 2: Can you share the API shape for the guide?". The scene I was looking at had one idle person in a 20 by 25 tile room.
- **Severity:** High.

### M1. People change floor under you while you watch

- **Steps:** same run at 2x. Sample the sprites on floor 1 every 200 ms.
- **Saw:** Ada and Alan appeared on the visible floor at 5.0 s and 7.6 s, and both vanished at 10.0 s, when the next department joined and rooms were repacked onto new floors. Nothing announced it. "Floor 1 of 2" became "Floor 1 of 3" without a cue.
- **Severity:** Medium.

### M2. A pending approval crushes the scene

- **Shot:** `f-dark-1024x640-z2-floor2.png`, `03-waiting-before-allow.png` equivalent `bursts/w3-dark-1600x1000-z1-waiting.png`
- **Steps:** the mock run asks for a tool permission. Open Live at 1024x640.
- **Saw:** The permission card takes the bottom of the pane and the stage shrinks to 114 px tall at 1024x640 (301 px at 1600x1000). At 1024x640 you see the tops of heads and nameplates. This is the exact moment the scene could say "someone is waiting for you", and it is the moment it is least visible.
- **Severity:** Medium.

## Visual assets

### H5. The rooms look alike and the building is mostly empty floor

- **Shots:** `f-nocard-dark-1600x1000-z1-floor1.png`, `t-default-1600x1000-z1-floor1.png`, `t-one-1600x1000-z1-floor1.png`, `t-large-1600x1000-z1-floor1.png`
- **Saw (1 person):** one small room (about 190 by 215 px) in the top-left corner of a 1008 by 499 stage, about 92 % empty beige. See `t-one-1600x1000-z1-floor1.png`.
- **Saw (4 to 6 people, 2 to 3 departments):** the rooms are the same template repeated: rug and sofa, lamp, picture, a row of identical monitor-and-chair pairs, a plant, a bookshelf, a printer, a desk. Only the label differs. About 70 % of the stage to the right and below is blank patterned floor.
- **Saw (33 roles):** rooms fill the width (about 47 % empty), but people are 16 px sprites with 40 px nameplates, every desk is the same, and "Worker..." and "Depart..." truncate (`t-large-1600x1000-z1-floor1.png`).
- **Walls, doors, corridors:** walls are a thick purple-brown line, doors are gaps in the bottom wall, and there is no corridor or lobby. Nothing says "building". It reads as cubicles on a beige grid.
- **Severity:** High for the 1 to 6 person case, which is the common one.
- **Direction:** fewer, bigger, more varied rooms; a visible corridor or lobby that links them; props that differ by department.

### M3. Nameplates are bigger than the people and cover them

- **Shot:** `cmp-working-vs-finished.png`
- **Saw:** At 1x the sprite is 16 by 24 px and its plate is about 56 by 40 px, drawn on top of the person's legs and the walking path. Names truncate: "Orches...", "Resear...", "Imple...". The status word on the plate ("Running") is the main state cue. At 2x and above the plates are proportionally smaller and fine (`t-default-1600x1000-z3-floor1.png`).
- **Severity:** Medium.

### M4. State is carried by text, not by the picture

- **Shot:** `cmp-working-vs-finished.png`, `fail-state.png`
- **Saw:** Running, Idle, Needs you, Finished and Failed share the same sprite, apart from a small arm change for finished and failed. No colour cue, no icon, no badge. From across the room you cannot see which person needs you.
- **Severity:** Medium.

### L1. The Team view label says "Role" where the Live view says a status

- **Shot:** `t-default-1600x1000-z1-floor1.png`
- **Saw:** every nameplate in Team view reads "<name> / Role". The second line is wasted; a title or department would be more useful.
- **Severity:** Low.

### L2. Message wording mismatch between scene and the side panel (mock data)

- **Shot:** `k-light-after-find-bea.png`
- **Saw:** the caption said "Bea to Ada" while the right panel's "Office messages" said "Implementer to Implementer" for the same message. This may be a mock artefact (role names versus handles). I did not trace it.
- **Severity:** Low (unverified cause).

## Floors

### H6. "Floors" are a pagination artefact, and the floor count depends on zoom

- **Shots:** `t-default-1600x1000-z3-floor1.png`, `t-default-light-1024x640-z2.png`, `f-nocard-dark-1600x1000-z1-floor1.png`
- **Steps:** Team view, default 4-role team. Press Zoom in repeatedly.
- **Saw:** 1x: "Floor 1 of 1", all four rooms side by side. 2x: "Floor 1 of 2". 3x and 4x: "Floor 1 of 4", one person per floor. At 1024x640 it is already 2 floors at 1x and 4 at 2x. A user who only wants to see their own four-person team larger ends up with four floors, which are not floors in any real sense; they are the same level cut into pages. The Live 6-agent case went from 2 floors (1x) to 3 (2x and up). Window size mattered only in the Team view at 1024x640 and for the 33-role team at 1x (2 floors at 1600x1000, 5 at 1024x640). For the 6-agent live team both sizes gave the same count.
- **Severity:** High. This is the owner's "floors doesn't feel right", confirmed.

### H7. You cannot follow a conversation across floors

- **Shots:** `03-waiting-before-allow.png` (caption "Bea to Ada · Floor 3 to floor 2"), `k-light-after-find-bea.png`
- **Steps:** Live, a message goes from a person on floor 3 to one on floor 2. Try to watch it.
- **Saw:** a caption "Bea to Ada · Floor 3 to floor 2: ..." appears for about a few seconds with no walk. To see the people you click Previous or Next floor, one click per floor, and neither person is highlighted, so you need to find them by nameplate among others. The caption is gone by the time you arrive.
- **Severity:** High.

### M5. Finding out which floor someone is on takes the roster, and the roster is the only cue

- **Shot:** `k-light-after-find-bea.png`
- **Steps:** collapse state: "Find a person · 6 across 3 floors". Click it (1 click), click a person (2nd click).
- **Saw:** the floor jumps (1 to 3) and the person is selected, which opens the inspector. The roster rows say status, session and role, but the row text did not say a floor number ("Bea Running · Current session · Reports to Orchestrator · Delegating to implementer"); the floor is only in an attribute I read from the DOM. After the jump the room label was scrolled off the top of the stage, so "Bea · 2" was not visible either. The roster also pushed the composer down.
- **Severity:** Medium.

### M6. Stage scrolling and floors both claim the same gesture

- **Steps:** at 2x, 1600x1000, floor stage shows 975 x 619 with 640 px of content, so the stage scrolls by 21 px. Focus the stage and press Down twice.
- **Saw:** the stage moved by 1 px. At 3x and 4x the stage scrolls by hundreds of pixels while floors also page. A scrollbar and a floor pager on the same small area compete; the user does not know whether more is a scroll away or a floor away. After "Find a person" jumped to floor 3 the stage was left scrolled partway, which hid the room label.
- **Severity:** Medium.

### M7. Previous and Next floor are far from the thing you are looking at

- **Shot:** `f-nocard-dark-1600x1000-z1-floor1.png`
- **Saw:** the controls are a toolbar above the stage ("Floor 1 of 2" between Previous and Next). There is no mini-map, no floor badge on a person, and no "3 people on floor 2" hint on floor 1.
- **Severity:** Medium.

### Team view (static roles) for the same team

- **Shots:** `t-default-1600x1000-z1-floor1.png`, `t-large-1600x1000-z1-floor1.png`
- Same floors, same counts as above. Static, so no motion complaint. The 33-role team at 1x is the best-looking state in the whole walk (17 people on floor 1), which suggests the layout works when the building is dense and breaks when it is sparse.

## Keyboard pass (1600x1000 light, Live, after run finished)

- Tab order in the scene: Zoom out, Zoom in, Fit, Next floor (Previous disabled), the stage (labelled "Office scene, scroll to pan"), then one person button for the visible floor, then the message strip, then "Find a person". 8 stops to reach the composer area. That is reasonable. Focus ring is a visible 2 px outline on every stop.
- A person who is on another floor cannot be reached by Tab at all; you have to open "Find a person" or press Next floor.
- Arrow keys on the focused stage scroll it (1 px at 2x here). The label says "scroll to pan", so a user will expect more. There is no keyboard way to "go to the person who just spoke".
- The disabled Previous floor button is skipped; fine.

## Light theme sample

- **Shots:** `k-light-after-find-bea.png`, `t-default-light-1024x640-z2.png`
- The scene keeps its own beige palette in light and dark, so the art is fine in both. App chrome around it follows the theme. Nothing broke. The scene has no light or dark feel of its own (no night lighting), so it does not read as a change in the place.

## What would make it feel right (ranked, as an observer)

1. **Make something move all the time, in every state.** Idle loops, typing, thinking, a hand up for "Needs you", a clear failed pose, an arrival and a departure. This is the owner's first complaint and it is the largest gap I saw (about 6 % of time moving, and 0 % at the default zoom).
2. **Drop floors as a user-visible idea. Make the building one continuous, pannable space** (or a fixed-size map with a minimap) and let zoom change only the magnification. Today zoom changes the number of floors, which makes the same team look like a different building.
3. **Show the conversation where it happens.** A bubble or message trail over the two people, lasting long enough to read, and a visible link while it lasts. Today the only text is a caption 400 px away, shown for about a second.
4. **Make messages cross rooms and corridors, not just desks.** A person should be seen leaving one room and arriving in another, including between departments. At present cross-department messages never animate when departments land on different floors.
5. **Scale the building to the team.** One or two people should not get a 92 % empty beige field. Fill the stage, or centre and size the building to the stage and add a lobby, a corridor, outdoor space.
6. **Vary the rooms.** Different furniture and colour by department, more than the 4 tile frames now drawn, props that hint at the work (a whiteboard for design, servers for engineering).
7. **Put state in the picture.** Colour, badge or pose for running, waiting, finished and failed so it reads from across the room, and shrink or move the nameplate so it does not cover the person.
8. **Keep the scene visible when a decision is waiting.** At 1024x640 a permission card leaves a 114 px stage. Consider a pinned compact card or letting the scene hold its minimum height.

## Not driven or not verified

- A real provider run. Mock only, with a custom script (`ORGAI_MOCK_SCRIPT`). Timing of real runs (longer pauses, more tool calls) may change the motion share; the mock's own 1.2 s to 3 s step delay set the pace of my runs.
- Failed and waiting for a single non-root agent. The mock's `fail` step failed the root only (`fail-state.png`); I saw "Needs you" on a report during a tool approval but not a failed report.
- Zoom 3x and 4x on Live with an active conversation, and a Live run on the 33-role team (the mock cannot spawn 33 named agents cheaply). The large-team observations are from the Team view only.
- Screen reader output and live announcements.
- Reduced-motion mode (`reduceMotion: 'on'`): not walked in this pass; the question here is how the default feels.
- Palettes Neutral and Green were not viewed.
- Window sizes between the two listed, and other display scales. The 1x, 2x, 3x, 4x floor counts for the 6-agent live team at both sizes came from one run each.
- The cause of the "Implementer to Implementer" wording in the side panel (L2).
- The share of empty stage is an estimate from bounding boxes in screenshots, not a pixel count.
