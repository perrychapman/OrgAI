# Factory Floor: a 3D overhead scene of a working team

Status: slice 1 built 2026-11-19 (see "Implementation notes"); slices 2, 3, 4 and 6 to follow. Live only by owner
decision 2026-11-19 (Team keeps the Graph). Written 2026-11-19 for the next run, which builds it in the slices of section 11.
Owner's words, which carry the authority: "a 3rd person overhead factory theme", "in 3D", "decent fidelity", and
"this should feel separate from the other themes entirely".

Every number in this document is a design value or a target. Everything marked **Unverified** comes from docs,
typings, source reading or reports and has not been run in this app. Real choices left to the owner are in section 13.

---

## 0. Summary of the main decisions

| # | Decision | Value |
| --- | --- | --- |
| D1 | Metaphor | The run is one factory hall on one shift. Agents are robot workers at stations; the orchestrator works in the control booth on the gantry. |
| D2 | Hierarchy | Every agent with reports runs a numbered **line** (a conveyor row). Its reports are the stations on that line. Line signs and painted floor routes connect a lead's station to its line. |
| D3 | State | A three-lamp **stack light** per station (top Failed, middle Needs you, bottom Running), plus pose, station props and a DOM nameplate with icon and status word. Never colour alone. |
| D4 | Stack | Plain `three` 0.187.0 (pinned exact), `WebGLRenderer` on WebGL2, one engine class owned by one React component, lazy-loaded chunk. No react-three-fiber, no post-processing, no workers, no WASM. |
| D5 | Art | Procedural low-poly geometry with flat shading and `MeshStandardMaterial` (metalness 0 to 0.2). No image textures; small `DataTexture`s only. GLB is optional and later (section 13, Q2). |
| D6 | Camera | Perspective, 28 degree vertical FOV, 55 degree pitch, fixed yaw (north up). Pan, zoom 7 to 60 px per metre, fit, focus-into-view. No rotation in the first build (Q3). |
| D7 | Layout | Pure, append-only: lines are created in the order their first report appears; new stations take the next slot; nobody moves when agents arrive or leave. |
| D8 | Motion | Event cues only (message capsules, work-order totes, tool parts, merge crates), each bounded; one ambient rate (2.8 s) for running stations, at most 12 animate. Reduced motion and Pause motion show every end state at once. |
| D9 | Accessibility | A DOM mirror of native buttons, one per worker plus the plan board, positioned over the projected stations; the canvas is `aria-hidden`. One Tab stop, arrow keys move spatially. |
| D10 | Fallback | Without WebGL2 (or after repeated context loss, too many agents, or a chunk load failure) the mirror itself becomes a visible 2D **floor plan** with the same layout and interactions. e2e passes on either path. |
| D11 | Palette | Follows the app theme only (light "day shift", dark "night shift"). The existing scene palette setting does not apply and its choices are hidden for this presentation. |
| D12 | Settings sample | A static image (one per app theme), never a second WebGL context. |

---

## 1. Concept and metaphor

### 1.1 The factory

A team run is one factory hall seen from above and slightly south, on one shift. North is the top of the screen.

- **Gantry** along the north wall. On it: the **control booth** (the root agent, the orchestrator), the **shipping
  dock** (where branches merged into the main checkout end up) and the **plan board** (the run plan's steps).
- **Lines**: east-west conveyor rows filling the hall below the gantry. Each line belongs to one lead (any agent with
  at least one report, including the root). The line's stations are that lead's direct reports.
- **Stations**: a 3 x 3 m base plate with a machine, a console, a short outfeed belt and a stack light. A robot
  worker stands at each. A station stays where it was placed for the whole session.
- **Head zone**: a 4 m strip along the west wall holding the line signs and the painted floor routes that lead from a
  lead's station to the head of its line.

Why lines: a factory line is the most legible "who feeds whom" structure there is, it reads at a glance from above, it
tiles into a compact rectangle for 1 to 40 agents, and appending to the end of a line or adding a new line at the
bottom of the hall never disturbs existing stations (section 3).

### 1.2 Station kinds (from structure, never from role names)

| Kind | Who | Look |
| --- | --- | --- |
| `booth` | The root of the current session (`parentId === null`, `session === 'current'`) | Raised glass-fronted booth on the gantry, desk with three screens, its own stack light. 6 x 4 m. |
| `lead` | Any other agent that has at least one report in the input | Station with a dispatch desk and a line-number plate on the floor in front ("Runs line 3"). |
| `bench` | Every other agent | Station with one of four machine silhouettes. |

The four machine silhouettes (`variant` 0 to 3: press, arm, spindle, frame) are chosen by a stable hash of
`roleKey` (`roleSlug` live, `role.id` in team mode), so agents of the same role share a silhouette. The silhouette is
decoration only: it must not suggest a job ("inspection", "welding") and the copy never names it. The inspector's role
name is the truth. A bench whose agent gains its first report becomes a `lead` in place (same slot, the dispatch desk
replaces the machine); it does not move.

### 1.3 Data the scene receives (verified fields only)

| Field | Source (verified in this repo) |
| --- | --- |
| id, name, parentId | `AgentInstance.id`, `agentLabel(agent)` (`lib/agentTree.ts`), `AgentInstance.parentId` (`src/shared/types.ts` line 2978) |
| roleKey, handle | `AgentInstance.roleSlug`, `AgentInstance.handle` |
| state | `AgentState`: `starting`, `thinking`, `tool`, `waiting` (a permission decision), `delegating`, `idle`, `done`, `error` (types.ts line 2968) |
| status word | `lib/runStatus.ts` `StatusWord`: Running (starting, thinking, tool, delegating), Needs you (waiting), Idle, Finished, Failed. Same mapping the existing per-agent views use. |
| activity | `nodeActivity(agent, { isRoot })` (`lib/agentActivity.ts`): the truthful one-line activity, including "Ended without a result" and "Waiting for your reply" |
| toolCalls | `AgentInstance.usage?.toolCalls ?? 0` (`AgentUsage.toolCalls`, types.ts line 2469) |
| worktree | `AgentInstance.worktree.status` (`WorktreeStatus`: active, merging, merged, empty, conflict, removed, review, held, waiting-children) and `.mergeTarget` ('main' or 'parent', absent means 'main') |
| startedAt | `AgentInstance.startedAt` |
| messages | `RunState.messages: AgentMessage[]` (`from`, `to` or null, `toHandle`, `text` at most 200 chars, `at`), kept to the last 100 by `useAppStore.ts` (`MAX_MESSAGES = 100`, line 242). Live only, never persisted. |
| plan | `RunPlan` (`goal`, `steps: PlanStep[]` with `id`, `title`, `status` pending / in_progress / done / blocked / skipped, optional `owner`; plan `status` active / done / blocked). Present in LiveRunView as `run.plan`; **not passed to a scene today**, so this spec adds it. |
| run status | `RunStatus`: starting, running, idle, stopping, finished, error, paused. In LiveRunView; **not passed today**, added. |
| decisions waiting on an agent | `PermissionRequest.agentId`, `UserQuestion.agentId`, `PermissionRuleRequest.agentId`, `MergeReview.agentId` exist (types.ts). The host derives `needsYouIds` from the same pending items the decision tray shows. **Unverified**: the exact variable in LiveRunView (`decisionItems`) and whether each item exposes the agent id directly. Proposals carry no agent id: they count against the root. |
| session | LiveRunView already knows which agents come from earlier sessions of a chain (`chain.origin`). Passed as `session: 'current' or 'earlier'`. |
| team roles | Team mode: `project.roles` (`id`, `name`, `reportsTo`). |

Nothing else is shown. No invented thoughts, chatter, speech, walking errands or idle wandering.

### 1.4 Event and state to factory cue

"Mount" means the moment the scene mounts or the run id changes. Anything already true at mount is shown in its end
state; only changes observed after mount produce moving cues (section 5.4).

| Run event or state | Source field | Factory cue | Static end state (also reduced motion) |
| --- | --- | --- | --- |
| Agent appears | `agent.upsert` with a new id; `AgentInstance.startedAt`, `parentId` | Station rises from its floor plate (200 ms). If it has a parent on the floor, a **work-order tote** flies from the parent's station to the new station first (section 5.2). | Station present, lamps per state. |
| Root starts | root `agent.upsert` | Booth lights switch on (one frame, no tween). | Booth lit. |
| starting / thinking | `AgentState` | Bottom lamp (Running) lit. Worker at the console. Ambient: console screen glow loop. | Lamp lit, pose `console`. |
| tool | `AgentState` | Bottom lamp lit. Worker at the machine. Ambient: machine stroke loop. | Lamp lit, pose `machine`. |
| delegating | `AgentState` | Bottom lamp lit. Worker at the dispatch desk (lead) or console (bench). Ambient: screen glow loop. | Lamp lit, pose `dispatch`. |
| A tool call completes | `usage.toolCalls` increases between two upserts | One **part** pops out of the machine and rides the outfeed belt into the bin. One part per increase; increases during flight coalesce (section 5.3). | Nothing (parts are transient). |
| waiting (permission) or a pending decision names the agent | `AgentState 'waiting'`, `needsYouIds` | Middle lamp (Needs you) lit. Worker turns to face south with one arm raised. No blinking. | Same. |
| Plan blocked | `RunPlan.status === 'blocked'` | Booth middle lamp lit; plan board's blocked step lamps amber. | Same. |
| idle | `AgentState` | All lamps off, base lamp dim. Worker stands beside the station. | Pose `rest`. |
| done | `AgentState` | Station shutter lowers over the machine (260 ms). Worker turns to its dock and powers down (head lowered). | Shutter down, pose `docked`. |
| error | `AgentState` | Top lamp (Failed) lit. A striped barrier drops across the station front (200 ms). Worker slumps (head and arms down). Announced (section 7.5). | Barrier down, pose `down`. |
| Agent messages agent | `agent.message` (`from`, `to`) | A **message capsule** flies on an overhead arc from sender to recipient (section 5.2). | Nothing; the floor log keeps the line. |
| Agent messages the user or an unknown handle | `agent.message` with `to === null` | The capsule rises from the sender into the roof and fades. | Nothing; the floor log says "to {toHandle}". |
| Agent works in a worktree | `worktree.status === 'active'` | A low mesh fence encloses the station on three sides (an isolated work cell). | Fence. |
| Branch merging | `worktree.status === 'merging'` | A crate appears on the outfeed pad. | Crate on pad. |
| Branch merged | `worktree.status === 'merged'` | The crate travels to its target: the shipping dock (`mergeTarget` main) or the parent's station pad (parent). Fence lifts. | Crate counted on the dock or parent pad; no fence. |
| Merge conflict | `'conflict'` | The crate slides to a hold pad beside the station with hazard stripes; top lamp is not used (the agent did not fail). Announced. | Crate on the hold pad, striped. |
| Waiting for merge review | `'review'` | Crate on the outfeed pad with the Needs you lamp (it is a decision). | Same. |
| Held | `'held'` | Crate parked on the hold pad, no stripes. | Same. |
| No changes | `'empty'` | Fence lifts; no crate. | No fence. |
| Waiting for its own reports | `'waiting-children'` | Crate waits on the outfeed pad. | Same. |
| Worktree gone | `'removed'` | Fence lifts; no crate. | No fence. |
| Agent removed | `agent.remove` | Station powers down and fades (160 ms); its slot shows a dashed "vacant" outline for the rest of the session. In-flight cues to or from it end where they are (120 ms fade). | Vacant outline. |
| Plan set or updated | `plan.updated` (`RunPlan.steps`) | Plan board lamps update in place (one per step). | Same. |
| Plan step owned by a worker | `PlanStep.owner` equals one current agent's `handle` exactly, or the `roleSlug` of exactly one current agent | The step id ("p3") appears on that worker's nameplate while the step is `in_progress`. No match, no chip. | Same. |
| Run paused (usage limit) | `RunStatus 'paused'` | Hall lights dim to the paused level (260 ms); every ambient loop and in-flight cue stops at its end state. Booth plate says "Paused". | Dim hall. |
| Session ended | `RunStatus 'finished'` or `'error'` | Hall lights dim to night level; ambient stops. Agents keep their end lamps. | Dim hall. |

Later candidates, each tied to a real event but outside the first build: `skill.used` (a binder lands on the
station's shelf), `agent.compacted` (the station's maintenance light blinks once; would need a motion review),
`knowledge.recalled`. Not built until asked for.

---

## 2. Camera

| Property | Value | Reason |
| --- | --- | --- |
| Projection | `PerspectiveCamera`, vertical FOV 28 degrees | Narrow FOV keeps sizes nearly uniform (about plus or minus 15 percent across the view at fit, **unverified until screenshots**) while stack lights, arcs and the gantry read as height. |
| Pitch | 55 degrees below horizontal | Shows the station fronts (lamps, workers' poses) and still lays the floor out like a plan. |
| Yaw | 0 (looking north), fixed | Keeps the DOM mirror order, keyboard arrows and labels stable. Rotation is Q3. |
| Zoom unit | Pixels per metre at the ground point under the stage centre (`ppm`) | One number the layout, the label rules and the tests share. |
| Zoom limits | `ppm` 7 (far) to 60 (near) | At 7, the 4 m slot pitch is 28 px, so 24 px hit targets never overlap. At 60 a station fills about 180 px. |
| Fit | Frame booth, dock, plan board and all current-session stations with 8 percent padding; `ppm = clamp(fitPpm, 7, 32)` | 32 stops a one-agent floor from filling the screen. If the floor does not fit at 7, fit shows the gantry and the top rows and the user pans. |
| Default | Fit on first mount. On stage resize, refit only if the user has not panned or zoomed since the last fit. New stations never move the camera. | No surprise motion. |
| Pan | Drag with the primary or middle button on any part of the stage that is not a control; a press on a worker button that moves more than 4 px becomes a pan and cancels the click. Clamp the target to floor bounds plus 8 m. | |
| Wheel | Zoom about the cursor, factor 1.1 per 100 units of `deltaY`; `ctrlKey` wheel (trackpad pinch) the same. No tween. | Direct manipulation is never animated. |
| Focus into view | When a worker is focused by keyboard or chosen in Find a worker and its footprint is off-stage or within 48 px of an edge, pan (never zoom) until it is 96 px inside. Click selection never moves the camera. | |
| Transitions | Fit, zoom buttons, menu commands and focus pans tween over `--dur-slow` (260 ms) with ease-out; 0 ms under reduced motion or Pause motion. | Read with the existing `tokenMs`. |
| Keyboard (focus inside the floor) | Shift+Arrow pans 4 m; `+` or `=` zooms in; `-` zooms out; `0` fits. | Arrow keys without Shift move focus (section 6.3). |
| Handle | `zoomIn()`: `ppm x 1.25` about the stage centre. `zoomOut()`: `ppm / 1.25`. `fit()`: fit as above. `focusWorker(id)`: focus that worker's button, pan into view, return false when the id is not on the floor. | The app menu's Zoom in, Zoom out and Fit canvas already call the live view's scene handle; Team mode gets the same handle. |

Camera maths is pure (`lib/factory/camera.ts`, section 10): `distanceForPpm(ppm, stageHeightPx)`,
`ppmForDistance`, `fitView(bounds, stage)`, `clampTarget`, `zoomAbout(view, factor, screenPoint, stage)`,
`panIntoView(view, footprint, stage)`, `project(view, stage, point3)` and `projectFootprint`. It uses its own small
vector types so its tests do not load three. The engine copies the pure view into the three camera each frame it
renders. A test checks that the pure `project` agrees with three's `Vector3.project` to within 0.5 px for 50 sample
points (run once in a jsdom-free vitest that imports three's math only).

---

## 3. Layout

### 3.1 Units and constants (`lib/factory/layout.ts`)

1 world unit = 1 metre; x grows east, z grows south, y is up. All positions snap to a 0.5 m grid.

| Constant | Value | Meaning |
| --- | --- | --- |
| `HEAD_W` | 4 | Head zone, x 0 to 4 (signs at x 2, routes at x 1 to 2.5) |
| `SLOT_PITCH` | 4 | Station footprint 3 m plus a 1 m gap |
| `SLOTS_PER_ROW` | 8 | A line longer than 8 continues on a continuation row |
| `ROW_PITCH` | 7 | Station 3 m (z 0 to 3 of the row), belt 1 m (z 3 to 4), aisle 3 m (z 4 to 7) |
| Station centre | `x = 6 + 4 * (slot % 8)`, `z = 1.5 + 7 * row` | |
| Aisle centre line | `z = 5.5 + 7 * row` | |
| Gantry | z -10 to -2 | |
| Booth | centre (7, -6), 6 x 4 m (x 4 to 10) | Fixed: never moves |
| Shipping dock | centre (17, -6), 6 x 4 m | Fixed; crates in a 3 x 3 grid, the tenth and later counted on its label |
| Plan board | centre (25, -9.5) on the north wall, 6 m wide | Fixed; live mode with a plan only |
| Hall | x 0 to `max(30, 6 + 4 * (widestRowSlots - 1) + 4)`; z -10 to `7 * rows + 1` (rows = 0 gives z 2) | Walls move outward as the floor grows; stations never move |

### 3.2 Algorithm (live mode, append-only)

Input: current-session agents. Output: `FloorLayout` plus updated `LayoutMemory`. Pure; same input and memory, same
output.

1. **Root.** The current-session agent with `parentId === null`; if several, the earliest `startedAt`, then the
   smallest id. The others with no parent, and any agent whose `parentId` is not in the input, are treated as reports
   of the root (they sit on the root's line). No root yet: an empty hall with the gantry only.
2. **Order.** Sort non-root agents by `(startedAt, id)`. This is creation order and is the same whether agents
   arrive one by one or all at once at mount.
3. **Place.** For each agent `a` in order:
   - If `memory.slots[a.id]` exists, keep it.
   - Let `p` be its parent (or the root). If `memory.lines[p]` does not exist, create it: `number = memory.nextLine++`
     (the root's line is Line 1), `rows = [memory.nextRow++]`, `count = 0`.
   - `slot = line.count++`; `rowIndex = floor(slot / 8)`; if `rowIndex === line.rows.length`, append
     `memory.nextRow++` to `line.rows` (a continuation row, always at the bottom of the hall).
   - Record `memory.slots[a.id] = { lead: p, slot }`.
4. **Removal.** An id that leaves the input keeps its slot in memory as **vacant** for the rest of the session. Slots
   are never reused within a session (a returning id gets its old slot back).
5. **Kinds.** `booth` for the root, `lead` for any agent that leads a line, else `bench`.
6. **Reset.** Memory resets when `runKey` changes (the run id, or `team:{projectId}` in team mode). A remount
   recomputes from the full list, which equals the incremental result except that vacancies from removed agents
   are dropped (an intended compaction).
7. **Routes.** For every line except Line 1, a painted floor route from the lead's station front
   `(x, 5.5 + 7 * leadRow)` west along that aisle to `(1 + 0.25 * lane, same z)`, south along the head zone to the
   line's first row centre z, then east to the sign at x 2. `lane = (lineNumber - 2) % 6`. Line 1's route runs from the
   booth front (7, -3.5) west to x 1 and south to row 0. Continuation rows get a short route from the previous row of
   the same line down the head zone.
8. **Signs.** "Line {n} · {lead name}" at (2, row centre z) for the first row of each line; continuation rows read
   "Line {n} · {lead name}, continued".

**Team mode** uses the same geometry with a different order: roles are walked depth-first in `project.roles` order
(children of a role in the order they appear in `project.roles`), lines are created in that preorder, and the layout
is recomputed from scratch on every change (team is static editing; there are no vacancies).

**Why append-only instead of a balanced tree.** A balanced or tidy tree re-centres parents and shifts siblings every
time an agent arrives, so a 40-agent run would move most stations dozens of times. Append-only never moves a
station; the cost is that a line which outgrows 8 stations after other lines exist continues further down the hall,
which the "continued" sign and the painted route make readable. Typical runs create lines in near breadth-first
order (the root spawns leads, the leads then spawn specialists), which reads naturally.

### 3.3 Worked examples

| Team | Placement | Hall (x by z extent) |
| --- | --- | --- |
| 1 agent (root only) | Booth only | 30 x 12 m (x 0 to 30, z -10 to 2) |
| 5: root, leads A and B, A1 under A, B1 under B | Line 1 (root) row 0: A (6, 1.5), B (10, 1.5). Line 2 (A) row 1: A1 (6, 8.5). Line 3 (B) row 2: B1 (6, 15.5) | 30 x 32 m |
| 15: root, leads A, B, C with 4, 4 and 3 reports | Row 0: A, B, C at x 6, 10, 14. Row 1: A's 4 (x 6 to 18). Row 2: B's 4. Row 3: C's 3 | 30 x 39 m |
| 40 flat: root and 39 reports | Line 1 rows 0 to 4 holding 8, 8, 8, 8, 7 | 38 x 46 m |
| 40 deep: root → A; A has 6 reports including B; B has 7 including C; C has 8 including D; D has 9 including E; E has 8 (D's 9 arrive before E's) | Row 0 Line 1 (A); row 1 Line 2 (6); row 2 Line 3 (7); row 3 Line 4 (8); rows 4 and 5 Line 5 (8 then 1, "continued"); row 6 Line 6 (E's 8) | 38 x 60 m |
| Arrival mid-run | Appended to its lead's line, or a new line at the bottom. No other station moves. | Hall may grow east or south |
| Removal mid-run | Slot becomes a vacant outline; nothing moves | Unchanged |

### 3.4 Layout tests (`layout.test.ts`)

- The five examples above produce exactly those coordinates.
- Property (seeded, 500 random sequences of upserts and removals, up to 60 agents, depth up to 8): no placed
  station's centre ever changes after it is first placed.
- Folding upserts one at a time in `startedAt` order equals one-shot layout of the final list (no removals).
- No two stations overlap; every station is inside the hall; routes stay inside the head zone and aisles.
- Team preorder: a fixture of 12 roles gives a fixed, snapshot-free coordinate table.

---

## 4. Art direction

### 4.1 Look

**Clean industrial low-poly**: bevelled boxes and cylinders of 6 to 16 segments, flat shading on faceted parts,
smooth shading on round ones, no outlines, no texture images. Matte painted steel, rubber belts, safety-yellow floor
paint. Workers are compact wheeled robots (no legs, so no walking is ever implied) about 1.4 m tall, with a head
block, a dark visor and two two-segment arms. Detail comes from silhouette and form, not from surface texture.

### 4.2 Lighting and shadows

- `HemisphereLight` (sky and ground colours per theme) for fill, one `DirectionalLight` key from the north-west
  (direction (-0.45, -1, 0.35) normalised, pointing down and south-east) with a shadow map, and per-theme
  `AmbientLight` at a low level. No point lights per station (cost); lamps are unlit materials (below).
- **Shadows**: `PCFShadowMap`, 2048 x 2048 (1024 at low quality, off at software quality). The shadow camera is an
  orthographic box fitted to the hall bounds plus 2 m, recomputed on layout change. Only static meshes (walls,
  gantry, stations, machines, shutters, fences, barriers) cast. `renderer.shadowMap.autoUpdate = false`;
  `needsUpdate = true` only when the layout or a static prop changes. Moving things (workers' poses, capsules, totes,
  parts, crates) use a **blob shadow**: one instanced quad with a procedural radial `DataTexture`.
- Colour management: three's default sRGB output with `ColorManagement` on; palette values below are sRGB hex.
- No post-processing, no bloom, no SSAO, no environment map in the first build.

### 4.3 Palettes (follow the app theme only)

The engine reads `data-theme` on `<html>` (`lib/theme.ts` resolves 'system' to 'dark' or 'light') and the status
tokens through `getComputedStyle`. On a theme change it updates material colours and lights in place (no rebuild)
and renders one frame. Values are starting points for the Technical Artist; the rule each must meet is listed.

| Role | Dark ("night shift") | Light ("day shift") | Rule |
| --- | --- | --- | --- |
| Clear colour | #0e1118 | #eef0f4 | Close to `--surface-0` so the stage edge does not frame the scene |
| Floor | #2a2f3a | #d6d9df | |
| Floor grid (1 m faint, 4 m strong) | #323845 / #3b4250 | #cbcfd6 / #bfc4cc | Grid barely visible at fit |
| Walls, gantry deck | #1f2430, #3a4252 | #e2e5ea, #b4bbc7 | |
| Station plate | #3a4252 | #b9c0cc | |
| Machine body, panels | #5a657b, #7c8aa5 | #8d97a8, #6c7689 | |
| Belt, rollers | #1b1f27, #6b7385 | #3a3f48, #9aa2b1 | |
| Robot body, joints, visor | #c9d1e0, #3d4556, #11141a | #3f4a5e, #c7ceda, #11141a | Robot silhouette to floor luminance contrast at least 3:1, measured on screenshots |
| Floor paint (routes, aisle edges) | #b8932a | #c99a1a | Not used for any state |
| Crate, tote, capsule, part | #a07a4a, #5b6b8c, #d8dde8, #9aa2b1 | #a7804d, #6c7c9c, #ffffff, #7d8696 | |
| Hazard stripes | #f5c518 / #1b1f27 | #e0b000 / #2a2f3a | Stripes are a shape cue as much as a colour |
| Lamp Running / Needs you / Failed | `--success` / `--warning` / `--danger` | same tokens (light values) | Read from tokens so states match the rest of the app |
| Lamp off | #2f3542 | #a9b0bc | |
| Selection ring | `--accent-text` | `--accent-text` | |
| Hemisphere sky / ground | #9fb3d1 / #1a1d24, 0.55 | #ffffff / #b9bec8, 0.9 | |
| Directional key | #ffffff, 1.4 | #fff7ea, 1.8 | |
| Hall dim (paused, ended) | lights x 0.55 | lights x 0.7 | |

Lit lamps use `MeshBasicMaterial` with per-instance colour, so token colours reach the screen without lighting
shifts. Off lamps use a standard material.

### 4.4 State without colour alone

| State | Shape and position cue | Word and icon (nameplate, mirror) |
| --- | --- | --- |
| Running | Bottom lamp lit; worker at console, machine or desk | "Running", lucide `Activity` |
| Needs you | Middle lamp lit; worker faces south, one arm raised | "Needs you", `CircleAlert` |
| Failed | Top lamp lit; striped barrier across the front; worker slumped | "Failed", `OctagonX` |
| Idle | No lamp; worker beside the station | "Idle", `Pause` |
| Finished | Shutter down over the machine; worker docked, head lowered | "Finished", `Check` |
| Merge conflict | Crate on the striped hold pad | "Merge conflict" in the nameplate's second line |
| Role (team mode) | No stack light; worker at rest | Name only |

Lamp position (top, middle, bottom) is the redundant cue inside the 3D view; the nameplate word is the redundant
cue everywhere.

### 4.5 Level of detail

| `ppm` | Name | What changes |
| --- | --- | --- |
| 24 and above | near | Full robots, rollers, console screens, parts on belts |
| 12 to 24 | mid | Rollers hidden (belt box only), console screens unlit |
| below 12 | far | Robots swap to a 120-triangle capsule-with-visor; parts are not shown; machines swap to their bounding block with the silhouette's top profile; lamps stay full size |

LOD swaps are instant (no fade) and happen only when a zoom settles.

### 4.6 Procedural or GLB, object list for the first playable

First playable is **fully procedural** (D5). GLB is reserved for the robot and the four machines if the owner picks
a CC0 kit (Q2); each GLB object keeps its procedural builder as the fallback when loading fails.

| Object | Built from | Triangle budget (near) | Instanced |
| --- | --- | --- | --- |
| Floor slab with grid | Procedural plane + 16 x 16 px `DataTexture` repeated per metre | 2 | no |
| Walls and pillars (boundary, 1.2 m high) | Procedural boxes | 400 total | pillars yes |
| Gantry deck, stairs, railing | Procedural | 1,500 | railing posts yes |
| Control booth (desk, three screens, glass front) | Procedural | 2,500 | no |
| Shipping dock (platform, bollards, crate slots) | Procedural | 800 | bollards yes |
| Plan board (panel, up to 12 lamps) | Procedural | 600 | lamps yes |
| Station plate and console | Procedural | 400 | yes |
| Lead dispatch desk and line plate | Procedural | 500 | yes |
| Machine silhouettes (press, arm, spindle, frame) | Procedural (GLB optional) | 900 each | yes, one instanced mesh per variant part |
| Outfeed belt and rollers (per station) | Procedural | 300 | yes |
| Stack light (pole and three lamps) | Procedural, 12 segments | 200 | yes (lit and off meshes) |
| Robot worker | Procedural (GLB optional), jointed: base, torso, head, visor, 2 x 2 arm segments | 1,200 near, 120 far | yes, one instanced mesh per body part, pose via per-instance matrices |
| Shutter, striped barrier, worktree fence | Procedural | 150, 120, 300 | yes |
| Crate, tote, capsule, part | Procedural | 60, 80, 120, 12 | yes |
| Selection ring, vacant outline, floor-paint routes | Procedural flat quads with `polygonOffset` | 64, 32, 2 per segment | yes |
| Blob shadows | One quad, radial `DataTexture` | 2 | yes |
| Line signs, labels, nameplates | DOM, not geometry | 0 | |

At 40 agents near: about 40 x (400 + 900 + 300 + 200 + 1,200 + 300) = 132,000 triangles for stations and workers,
plus about 6,000 for the hall: within the 250,000 frame budget (section 9).

Assets folder: `src/renderer/src/assets/factory/` with `manifest.json` (empty `assets` array until a GLB lands),
`sample-dark.png` and `sample-light.png` (section 6.6) and, later, `models/*.glb` and `licenses/*.txt`.

**GLB rules (only when Q2 says yes).** Uncompressed glTF 2.0 binary only. No images, no `KHR_texture_*`, no Draco,
no meshopt, no KTX2, no external URIs (three's `GLTFLoader` turns embedded images into blob URLs, which the CSP
blocks; **unverified in r187 source**, read from older versions). Licence CC0 1.0 only. At most 400 kB per file and
1.5 MB in total (a target). Materials are replaced at load by palette materials, matched by mesh or material name.
Each file has a manifest entry `{ file, source, author, licence: "CC0-1.0", licenceUrl, sha256, bytes, triangles,
modified: "what was changed" }`; a unit test hashes every file and fails on a mismatch or an unlisted file. Loading
never touches the network: the GLB is imported with Vite's `?inline` (a data URL baked into a lazy chunk), decoded to
an `ArrayBuffer` by a pure helper and passed to `GLTFLoader.parse`. **Unverified**: that `?inline` works for `.glb`
(it may need `assetsInclude: ['**/*.glb']` in the renderer block of `electron.vite.config.ts`). If it does not, a
build step writes each GLB as a base64 TypeScript module instead; either way no `fetch`, no `blob:`, no `data:`
fetch (the CSP's `connect-src` falls back to `'self'`).

---

## 5. Motion

Motion means "something is alive or just changed". Every moving thing below traces to a row of section 1.4. Timing
constants live in one pure module, `lib/factory/motion.ts`; chrome around the scene uses the CSS duration tokens.

### 5.1 Ambient loops (running stations only)

| Loop | When | Shape |
| --- | --- | --- |
| Machine stroke | `state === 'tool'` | Press head down 0.3 m and back, arm swings 40 degrees, spindle turns once, frame carriage travels 0.6 m |
| Screen glow | starting, thinking, delegating | Console screen emissive between 0.7 and 1.0 |

- One rate for the whole scene: `FACTORY_CYCLE_MS = 2800`, ease-in-out (inside the 2.4 to 3.2 s range of the
  project's motion rules). **Flag:** the CSS token `--dur-pulse` is 1800 ms, outside that range; the factory does
  not use it.
- At most 12 stations loop at once. Priority: the selected worker, then stations on screen in layout order, then the
  rest. The others show the same lit lamp and pose, static.
- Phase offset 150 ms per looping station index, so neighbours never pulse together.
- Idle, Needs you, Finished and Failed never loop. Needs you never blinks.

### 5.2 Event cues

| Cue | Path and timing | Bounds |
| --- | --- | --- |
| Station arrive | Plate and station scale y from 0.2 to 1 with opacity 0 to 1, 200 ms ease-out | At most 12 arrivals animate per 1 s window; the rest appear at once |
| Station leave | Fade to the vacant outline, 160 ms | |
| Work-order tote (delegation) | Quadratic arc from parent station to child station, apex `3.5 + min(0.1 * distance, 4)` m; speed 8 m/s, duration clamped to 600 to 2,000 ms, ease-in-out; the child's arrive cue starts when the tote lands | Counts against the carrier cap |
| Message capsule | Same arc form between sender and recipient; speed 10 m/s, 500 to 1,800 ms. `to === null`: rises 4 m and fades over 600 ms | Carrier cap 6 in flight, at most 2 per sender. Messages from the same sender to the same recipient within 800 ms coalesce into one capsule (slightly larger, the log lists each). Queue at most 12; older queued capsules are dropped from the animation (never from the log) |
| Tool part | Pops on the machine's outfeed (scale 0 to 1, 120 ms), rides 1.2 m of belt in 700 ms linear, drops into the bin and fades (120 ms) | At most 1 in flight per station, at most 1 queued; increases while one is in flight coalesce into the queued one. Global cap 12 |
| Merge crate | Low arc (apex 1 m) from outfeed pad to dock slot or parent pad, 5 m/s, 800 to 2,400 ms | Cap 4 in flight; others land at once |
| Shutter, barrier | 260 ms and 200 ms ease-out | |
| Pose change | 160 ms blend of joint angles | |
| Hall dim / undim | 260 ms | |

### 5.3 Concurrency, coalescing, interruption

- `CueScheduler` (pure, section 10) owns every transient cue: `push(cues, now)`, `advance(now)` returns active cues
  with progress 0 to 1, `cancelFor(workerId, now)`, `finishAll()`. It takes `now` as an argument; tests drive a fixed
  clock.
- An agent leaving: cues from or to it end at their current position with a 120 ms fade; queued ones are dropped.
- Run paused, session ended, Pause motion turned on, reduced motion turned on, or the scene hidden: `finishAll()`
  (every cue jumps to its end state) and ambient loops stop.
- Team mode never schedules cues.
- A layout change never cancels cues (stations do not move).

### 5.4 No replay

- On mount (and on a run id change) the scene records a **message cursor**: the key
  `{at}|{from}|{to}|{text first 32 chars}` of the newest message. Only messages after it animate. The store keeps the
  last 100, so the cursor compares `at` first and the key second.
- Tool-call counts, worktree statuses and states present at mount are baselines; only later changes cue.
- Remounting (switching to the conversation and back, changing presentation) never replays.

### 5.5 Pause motion and reduced motion

- `prefers-reduced-motion: reduce` or `data-reduce-motion="on"` (read through `useReducedMotion()` in `lib/canvas.ts`)
  or the scene's **Pause motion** toggle: no ambient loops, no cues, no tweens; every event is shown in its end state
  in the same frame it arrives; camera moves are instant. Lamps, poses, props and words carry every state.
- Pause motion is remembered for the app session (a module-level value), not saved to settings. It is hidden in team
  mode, where nothing moves.
- The render loop under these modes runs only on demand (section 9.2).

---

## 6. Interaction

### 6.1 Pointer

- **Hover** a worker button: its nameplate shows and its station gets a 0.15 emissive lift, instant (no tween).
- **Click** a worker: `onSelect(id)`. Live opens the existing agent inspector in the live panel; team opens the
  existing role panel. The selected station gets the selection ring. Clicking empty floor does nothing (pan only);
  selection clears through the inspector as today.
- **Plan board** button: `onOpenPlan()` (live: the existing Plan side tab).
- Drag pans, wheel zooms (section 2).

### 6.2 Labels and nameplates (DOM overlay)

All text is DOM, positioned with `transform: translate3d()` from projected anchor points, updated in the same frame
as a camera change and not otherwise. Never text in WebGL.

- **Nameplate** above each station: line 1 the name (`--text-small`, 12 px, weight 600, one line, ellipsis at 18 characters,
  full name in the accessible name); line 2 the status icon and word, a middle dot, the activity truncated at 40
  characters, and the plan step chip ("p3") when one applies. Team mode: name only.
- **Visibility**, in priority order: selected, focused, hovered, Needs you, Failed, merge conflict, then everyone
  else when `ppm >= 18`. Greedy placement in that order; a plate that would overlap a placed plate is skipped. At
  most 24 plates. The first four kinds are never skipped (they push lower ones out).
- **Line signs** and the **dock label** ("Main checkout · {k} merged") and **plan board label** ("Plan · {done} of
  {total} done", plus " · {b} blocked" when any) show when on screen, below nameplates in priority.
- Plates use `--surface-2` at 92 percent opacity, a 1 px `--border-default` border, `--radius-sm` (6 px),
  `--elev-1`, and `--text-primary` / `--text-secondary` (all present in `tokens.css` in every theme block).

### 6.3 Keyboard

- The floor is one Tab stop: the selected worker's button, else the booth, else the first station. Arrow keys move
  between workers by the pure `nextFocus(layout, id, key)`:
  - Left / Right: previous / next slot in the same row; past the end, the next row's first slot (reading order).
  - Up / Down: the station in the row above / below whose x is nearest; from row 0, Up goes to the booth; from the
    booth, Down goes to row 0 slot 0.
  - Home: the booth. End: the last placed station. The plan board is reached by Up from the booth.
  - Vacant slots are skipped.
- Enter or Space: select (open the inspector). Delete or Backspace (team mode only): `onRemove(id)` (the host
  confirms, as today).
- Shift+Arrow, `+`, `-`, `0`: camera (section 2).
- Focus moving to a worker pans it into view. Focus is never moved by the scene on its own, except back to a worker
  by `focusWorker` when the host asks (Back to floor, Escape from the inspector).

### 6.4 Find a worker

A `Find a worker` button in the scene's control row opens a `Popover` with a labelled search `Input`
("Search workers") and a list of native buttons, one per agent (live) or role (team): current session first in
layout order, then a group "Earlier sessions" (live, chains only). Each row: name, status word, line ("Line 3").
Typing filters by name or handle, case-insensitive. Choosing a current-session row closes the popover, focuses the
worker on the floor (pan into view) and selects it; an earlier-session row selects it (opens the inspector) without
touching the floor. Escape closes and returns focus to the button. Empty result: "No worker matches “{query}”."

### 6.5 Floor log

A `<details>` strip at the bottom of the scene, summary "Floor log ({n})", closed by default, listing at most 50
entries newest first in a 160 px scrolling list. It is the text record of what moved; it is not a live region. Live
mode only. Entry templates (times use the app's existing short time formatter; **unverified**: its name):

| Event | Text |
| --- | --- |
| New agent with a parent | "{time} {parent} assigned work to {child}" |
| New root | "{time} {name} started the shift" |
| Message to an agent | "{time} {sender} to {recipient}: “{first 80 characters}”" |
| Message to someone off the floor | "{time} {sender} to {toHandle}: “{first 80 characters}”" |
| State word change (not Running to Running) | "{time} {name}: {status word}" |
| Merged | "{time} {name}'s branch merged into the main checkout" or "… into {parent}'s branch" |
| Conflict, review, held, empty | "{time} {name}'s branch has a merge conflict" / "… is waiting for your review" / "… is held" / "{time} {name} changed no files" |
| Plan | "{time} Plan updated: {done} of {total} steps done" |
| Run paused / resumed / ended | "{time} Line stopped: run paused" / "{time} Run resumed" / "{time} Shift over" |

Message text is agent output, so it is untrusted: rendered only as React text, never as HTML or a URL.

### 6.6 Modes

| | Live (`LiveRunView`) | Team (`TeamView`) | Settings sample (`CanvasPreview`) |
| --- | --- | --- | --- |
| Workers | Agents of the run (current session on the floor, earlier sessions in Find) | Roles | Fixed five-agent sample |
| Lamps, cues, log, plan board, dock, Pause motion | yes | no | no |
| Select | Agent inspector | Role panel | none (inert) |
| Delete | no | `onRemove` | no |
| Rendering | WebGL2 or floor plan | WebGL2 or floor plan | Static PNG: `sample-dark.png` or `sample-light.png` by `data-theme`, 480 x 260 px at 2x; until those exist (slice 6) the floor plan of the sample team, inert |
| Accessible name | Group "Factory floor, {n} workers" | "Factory floor, {n} roles" | Wrapper `role="img"`, "Static sample factory floor" |

The presentation choice in settings shows the same PNG as its thumbnail, with the description "A 3D factory view of
your team". The scene palette choices are hidden while Factory Floor is chosen.

### 6.7 Scene controls

One `role="toolbar"` row, `aria-label="Factory floor controls"`, at the bottom left of the stage (the scene's own
controls, allowed over the stage): `Find a worker` (Button), `Zoom out`, `Zoom in`, `Fit` (`IconButton`s with those
labels), `Pause motion` (toggle Button with `aria-pressed`, live only). Below a stage width of 560 px (container
query on `.factory-scene`) Find and Pause motion become `IconButton`s with the same labels. The floor log strip sits at
the bottom right. Neither may cover the stage by more than 48 px of height.

### 6.8 Host chrome

- Live inspector: a "Back to floor" button at the top of the live panel when Factory Floor is shown and an agent is
  selected. It, and Escape inside the panel, return focus to that worker's button through `focusWorker(id)`; they
  change nothing in the run.
- Team role panel: "Back to floor" likewise.
- Team hint line: "Select a role to edit it. With a role focused, Enter edits it, Delete removes it and the arrow keys
  move between stations."
- "Load earlier sessions" stays available for scenes (not only the existing one) and, after loading, focuses the Find
  a worker button.

---

## 7. Accessibility

### 7.1 Structure

- `<canvas aria-hidden="true" tabindex="-1">` never takes focus or announces.
- The **mirror**: `<div role="group" aria-label="Factory floor, {n} workers" aria-describedby="{hint id}">`
  holding native `<button type="button">` elements in layout reading order: booth, plan board (live, when a plan
  exists), then rows top to bottom, slots west to east. Vacant slots have no button.
- Hidden hint (visually hidden, referenced by the group): "Arrow keys move between workers. Enter opens a worker.
  Shift with arrow keys pans. Plus, minus and 0 zoom and fit." Team adds "Delete removes a role."
- Each worker button: absolutely positioned over the projected station footprint's bounding box, at least
  24 x 24 px (centred when the footprint is smaller), transparent background in the 3D view.
  - Accessible name: "{name}, {status word}" (booth: "{name}, control booth, {status word}"; team: "{name}, role").
  - `aria-describedby` a hidden span: activity; "Line {n}, station {slot + 1}" or "Runs line {m}"; "Reports to
    {parent}"; the worktree phrase ("Working in its own branch", "Branch merged", "Merge conflict", "Waiting for your
    review"); "Plan step {id}: {title}". At most 200 characters.
  - Selected: `aria-current="true"`.
  - Data hooks: `data-testid="factory-worker"`, `data-factory-worker-id`, `data-state` (AgentState or `role`),
    `data-lamp` (off, running, needs-you, failed), `data-kind`, `data-line`, `data-slot`.
- Buttons for off-screen workers stay in the DOM (keyboard reaches them) clipped out of view; focusing one pans it
  in before its ring paints.

### 7.2 Focus ring

`:focus-visible` on a worker button: 2 px solid `var(--focus-ring)` outline at 2 px offset, plus a 1 px inner
`--surface-0` ring, so the ring separates from any scene colour behind it. Instant, never animated. The 3D selection
ring is separate and shows selection, not focus.

### 7.3 Pointer parity

Everything a pointer does has a key: select (Enter, Space), remove (Delete, team), pan (Shift+Arrow), zoom and fit
(`+`, `-`, `0`, the app menu and the control buttons), find (Find a worker), plan (plan board button), log (the
`details` summary).

### 7.4 Contrast

Overlay text always sits on a plate (section 6.2): text tokens on `--surface-2` meet 4.5:1 in both themes by token
design; the UI Engineer measures the rendered pairs at 92 percent plate opacity over the brightest and darkest scene
colours of each theme (floor, lit lamp) and records the numbers. Plate border against the floor: 3:1. Lamp colours
are status tokens; the lamp position cue covers users who cannot tell them apart.

### 7.5 Announcements

Through the frame's existing `useFrameAnnounce()` only (no new live region). Live mode only, never at mount:
"{name} failed" and "{name}'s branch has a merge conflict". At most one announcement per 2 s; several in a window
coalesce ("2 workers failed"). Needs you is not announced here because the decision tray already announces its cards.
Motion, messages and tool calls are never announced.

### 7.6 Fallback floor plan

Same mirror, made visible: each button is drawn as a station tile (border, name, status icon and word) at the
same layout positions under a straight top-down projection, with the same keyboard, find, log and camera controls.
It is a complete UI, not an error page.

---

## 8. Fallback and failure states

| Case | Detection | What shows | Exact copy | What the user can do |
| --- | --- | --- | --- | --- |
| No WebGL2 | Probe: `canvas.getContext('webgl2', { failIfMajorPerformanceCaveat: true })`, then without the flag (software: low quality, no notice). Null both times. The probe context is released with `WEBGL_lose_context`. Cached for the app session. | Floor plan + info `Banner` at the top of the stage, dismissible for the session | Title "3D view unavailable". Body "This computer did not give OrgAI WebGL 2, so the factory is shown as a floor plan." | "Use Graph" (sets the presentation to Graph) |
| Three chunk failed to load | The lazy import rejects | Floor plan + warning `Banner` | Title "3D view did not load". Body "OrgAI could not load the 3D renderer. Showing the floor plan." | "Try 3D again", "Use Graph" |
| Context lost | `webglcontextlost` (call `preventDefault()` so restore can happen) | Loop stops; a centred stage note over a dimmed last frame; announced once through the frame | "The 3D view stopped. Restoring…" | Wait |
| Restored | `webglcontextrestored` | Engine rebuilds every GPU resource from the current model; one frame; note goes away | | |
| Not restored in 5 s, or the third loss within 10 minutes | Timer, counter | Floor plan + warning `Banner` | Title "3D view stopped". Body "The graphics context was lost and did not come back. Showing the floor plan." (third loss: "The 3D view stopped 3 times, so OrgAI switched to the floor plan for this session.") | "Try 3D again", "Use Graph" |
| Model asset failed (GLB phase only) | `GLTFLoader.parse` error or manifest hash mismatch | Procedural stand-in for that object class; a quiet note in the control row | "Some models did not load; simple shapes are shown." | Nothing needed |
| Very large team | More than 120 current-session agents | Floor plan + info `Banner` | Title "Large team". Body "This team has {n} agents. The 3D floor shows up to 120, so the floor plan is shown." | "Use Graph" |
| Run not started / no root | No current-session root | Empty hall with the gantry; centred stage text | "The floor opens when the run starts." | |
| Team with no roles | Zero roles | The Team view's existing empty state | (existing copy) | (existing actions) |

`Try 3D again` re-runs the probe and the import once; on success the 3D view returns with the same camera.
A developer switch, `localStorage['orgai.factory.renderer'] = 'floor-plan'`, forces the floor plan (used by e2e);
it is not user-facing and is documented only in the agent notes.

---

## 9. Performance

### 9.1 Budget (targets; measured as stated)

| Measure | Target | How measured |
| --- | --- | --- |
| Idle frames | 0 frames in 3 s with no running agent, no cue, no camera move | Frame counter in the test state |
| Ambient-only frame rate | at most 31 fps (render every other display frame) | Frame counter over 3 s |
| Frame CPU time (scene update + `renderer.render`) | p95 at most 6 ms at 40 agents, 1600 x 1000, all cue caps full | `performance.now()` ring buffer of 120 frames in the test state |
| Frame interval during a cue burst | p95 at most 20 ms on a 60 Hz display | rAF timestamps over 5 s; recorded with the GPU string from `WEBGL_debug_renderer_info` when exposed |
| Draw calls | at most 120 main pass and 40 shadow pass, at any team size up to 120 | `renderer.info.render.calls` after a frame |
| Triangles | at most 250,000 per frame at 40 agents, near zoom | `renderer.info.render.triangles` |
| Texture and shadow memory | at most 24 MB (the 2048 shadow map is 16 MB of it) | Sum of own `DataTexture` sizes and shadow map size; `renderer.info.memory` counts |
| Device pixel ratio | `min(devicePixelRatio, 1.5)`; 1 at low quality | |
| Time to first frame | at most 250 ms from mount with the chunk cached; at most 700 ms cold | `performance.mark` at mount and after the first render, in the test state |
| Bundle: lazy chunk (three and the factory engine) | at most 230 kB gzip | `npm run build`, then gzip size of the chunk files |
| Bundle: main renderer chunk growth | at most 4 kB gzip | Same, before and after |
| GLB total | 0 in the first build; at most 1.5 MB if Q2 says yes | Manifest test |
| Leak | After 20 mounts and unmounts, the next mount's `renderer.info.memory` geometries and textures equal the first mount's, and one live engine exists | Test state `engines`, `geometries`, `textures` |

Performance numbers are recorded, not asserted, in CI (runner GPUs are unknown); the structural ones (idle frames,
draw calls, triangles, leak counts) are asserted whenever the 3D path runs. A local `E2E_FACTORY_PERF=1` mode asserts
the timing targets on the developer's machine and prints them for the report.

### 9.2 Render loop rules

- One `requestAnimationFrame` loop per engine, started by `requestFrame(reason)` and stopped when no reason remains.
  Reasons: camera tween, active cues, ambient loops (motion full and at least one running station), a one-off
  invalidation (model, theme, resize, LOD).
- Stops while `document.visibilityState === 'hidden'`, while an `IntersectionObserver` says the stage is not
  visible, and on unmount. One frame on becoming visible.
- `InstancedMesh` for every repeated part; shared materials (one per palette role); geometries built once per
  engine; per-instance matrices and colours updated only for instances that changed.
- DOM mirror and labels update positions only on camera change (refs and `transform`, no React state); React
  re-renders only on model change.
- **Quality steps** (one way per mount): high (DPR 1.5, shadows 2048, MSAA) → low (DPR 1, shadows 1024) when the
  frame interval p95 exceeds 24 ms over 2 s of animation → minimal (shadows off, far LOD at all zooms) if it still
  does. Software WebGL starts at minimal.
- Dispose on unmount: cancel the loop, remove listeners and observers, dispose every geometry, material and texture
  from the engine's registry, `renderer.dispose()`, then `renderer.forceContextLoss()` so Chromium frees the
  context at once (Chromium limits live contexts per page, about 16, **unverified** for Electron 45).

---

## 10. Module plan

Hard boundary: nothing under `lib/factory/` or `components/canvas/factory/` imports from `lib/office/` or
`components/canvas/office/`, and nothing there imports the factory. A unit test (`lib/factory/boundary.test.ts`)
reads every factory source file and fails on such an import. Shared non-scene modules are fine: `lib/agentActivity`,
`lib/agentTree`, `lib/runStatus`, `lib/canvas` (`useCanvasOptions`, `useReducedMotion`), `lib/useCssVar`,
`lib/useExitPresence` (`tokenMs`), `components/layout/CanvasFrame` (`useFrameAnnounce`), `components/ui/*`.

### 10.1 Pure modules: `src/renderer/src/lib/factory/` (no three, no DOM; each with `*.test.ts`)

The modules never import three; a test file may (the camera agreement test imports three's math classes).

| File | Exports |
| --- | --- |
| `types.ts` | All interfaces below |
| `agentView.ts` | `factoryAgent(agent, opts)` and `factoryRole(role)` → `FactoryAgentInput`; status word map |
| `layout.ts` | Constants of 3.1, `layoutFloor(input, memory)`, `EMPTY_LAYOUT_MEMORY` |
| `routes.ts` | Floor-paint routes, carrier arcs (`arcPoint(from, to, t)`), dock and pad slots |
| `model.ts` | `buildFloorModel(input, layout, needsYouIds, plan, runStatus)` → `FloorModel` (lamps, poses, props, board) |
| `cues.ts` | `diffCues(prev, next, cursor)`, `CueScheduler`, `messageKey`, `messageCursor` |
| `motion.ts` | `FACTORY_CYCLE_MS = 2800`, every duration, speed and cap of section 5, `ambientSet(model, onScreen)` |
| `camera.ts` | Section 2 maths |
| `navigation.ts` | `nextFocus(layout, id, key)`, `tabStop(layout, selectedId)` |
| `labels.ts` | `placeLabels(candidates, ppm)` (priority, collision, cap 24) |
| `floorLog.ts` | Event to log line (section 6.5), cap 50 |
| `palette.ts` | `FACTORY_PALETTE.dark` / `.light`, `lampFor(state)` |
| `snapshot.ts` | `factoryTestState(...)` → `FactoryTestState` |
| `capability.ts` | `probeWebGL2(createCanvas)` (canvas factory injected so it is testable), forced-fallback key |
| `boundary.test.ts` | The import boundary check |

### 10.2 Components: `src/renderer/src/components/canvas/factory/`

| File | Role |
| --- | --- |
| `FactoryScene.tsx` | Public component. Probe, chooses 3D or floor plan, owns model, memory, scheduler, mirror, labels, controls, log, notices, test state; exposes the handle. Lazy-imports `FactoryCanvas`. |
| `FactoryCanvas.tsx` | The only file that imports `three` (with `engine/`): mounts the canvas, creates `FactoryEngine`, wires resize, visibility and context-loss events. |
| `engine/FactoryEngine.ts` | Non-React class: `setModel`, `setView`, `setTheme`, `setMotion`, `requestFrame`, `projectAll()`, `rebuild()`, `dispose()`, `stats()` |
| `engine/instancing.ts`, `engine/poses.ts`, `engine/cueRender.ts` | Instance pools, pose joint tables, cue drawing |
| `builders/*.ts` | Technical Artist: `floor.ts`, `hall.ts`, `booth.ts`, `dock.ts`, `board.ts`, `station.ts`, `machines.ts`, `robot.ts`, `stackLight.ts`, `props.ts`, `materials.ts`, `lighting.ts`, `dataTextures.ts` |
| `FactoryMirror.tsx` | Mirror buttons (also the floor plan tiles) |
| `FactoryLabels.tsx` | Nameplates, line signs, dock and board labels |
| `FactoryControls.tsx`, `FactoryFind.tsx`, `FactoryLog.tsx`, `FactoryNotice.tsx` | Chrome |
| `FactorySample.tsx` | Settings sample and thumbnail |
| `assets/` loader (`engine/assets.ts`) | GLB phase only |

Styles: `src/renderer/src/styles/factory.css` (scene, mirror, floor plan, labels, notices; Scene Engineer) and
`src/renderer/src/styles/factory-chrome.css` (controls, find, log; UI Engineer). Both carry the reduced-motion rule
with both selectors. No new colour tokens are needed; if one is, it goes in every theme block of `tokens.css`.

### 10.3 Key interfaces

```ts
// lib/factory/types.ts
import type { AgentMessage, AgentState, RunPlan, RunStatus, WorktreeStatus } from '@shared/types'
import type { StatusWord } from '../runStatus'

export interface FactoryAgentInput {
  id: string
  name: string
  parentId: string | null
  /** roleSlug (live) or role.id (team): equal keys share a machine silhouette. */
  roleKey: string
  handle?: string
  /** 'role' in team mode. */
  state: AgentState | 'role'
  statusWord: StatusWord | 'Role'
  activity: string
  toolCalls: number
  worktree?: { status: WorktreeStatus; mergeTarget: 'main' | 'parent' }
  startedAt: number
  session: 'current' | 'earlier'
}

export interface Vec2 { x: number; z: number }
export type StationKind = 'booth' | 'lead' | 'bench'
export interface PlacedStation { id: string; kind: StationKind; variant: 0 | 1 | 2 | 3; line: number; row: number; slot: number; center: Vec2 }
export interface FloorLine { number: number; leadId: string; rows: number[]; count: number }
export interface FloorRoute { line: number; points: Vec2[]; lane: number }
export interface Bounds { minX: number; maxX: number; minZ: number; maxZ: number }
export interface FloorLayout {
  stations: Record<string, PlacedStation>
  /** Reading order: booth first, then rows north to south, slots west to east. */
  order: string[]
  lines: FloorLine[]
  vacant: { line: number; row: number; slot: number; center: Vec2 }[]
  routes: FloorRoute[]
  rows: number
  hall: Bounds
  /** Fit target: booth, dock, board and stations. */
  content: Bounds
  booth: Vec2 | null
  dock: Vec2
  board: Vec2
}
export interface LayoutMemory {
  runKey: string
  lines: Record<string, { number: number; rows: number[]; count: number }>
  slots: Record<string, { lead: string; slot: number }>
  nextLine: number
  nextRow: number
}

export type Lamp = 'off' | 'running' | 'needs-you' | 'failed'
export type Pose = 'console' | 'machine' | 'dispatch' | 'signal' | 'rest' | 'docked' | 'down'
export type Ambient = 'none' | 'screen' | 'machine'
export type CrateAt = 'pad' | 'hold' | 'hold-striped' | 'dock' | 'parent-pad'
export interface WorkerModel {
  id: string; name: string; kind: StationKind; statusWord: StatusWord | 'Role'; activity: string
  lamp: Lamp; pose: Pose; ambient: Ambient
  shutter: boolean; barrier: boolean; fenced: boolean
  crate?: { at: CrateAt; lamp: Lamp }
  stepIds: string[]
}
export interface FloorModel {
  mode: 'live' | 'team'
  layout: FloorLayout
  workers: Record<string, WorkerModel>
  hall: 'on' | 'paused' | 'ended'
  board?: { total: number; done: number; blocked: number; lamps: ('pending' | 'active' | 'done' | 'blocked' | 'skipped')[]; overflow: number }
  dockCrates: number
  earlier: { id: string; name: string; statusWord: StatusWord }[]
}

export type CueKind = 'arrive' | 'leave' | 'tote' | 'capsule' | 'part' | 'crate' | 'shutter' | 'barrier' | 'pose' | 'hall'
export interface Cue {
  id: string
  kind: CueKind
  /** Station the cue belongs to (arrive, leave, part, shutter, barrier, pose) or starts from (tote, capsule, crate). */
  from?: string
  /** Target station; null for a capsule leaving the floor; 'dock' for a crate merged into the main checkout. */
  to?: string | null | 'dock'
  count?: number
  start: number
  duration: number
}
export interface ActiveCue extends Cue { progress: number }

// components/canvas/factory/FactoryScene.tsx
export interface FactorySceneHandle {
  zoomIn(): void
  zoomOut(): void
  fit(): void
  /** Focuses the worker's button and pans it into view; false when the id is not on the floor. */
  focusWorker(id: string): boolean
}
export interface FactorySceneProps {
  mode: 'live' | 'team'
  agents: readonly FactoryAgentInput[]
  messages: readonly AgentMessage[]
  plan?: RunPlan | null
  runStatus?: RunStatus
  /** Agent ids named by open decisions (permission, question, rules, merge review); proposals count as the root. */
  needsYouIds?: readonly string[]
  runId?: string
  /** Team mode: memory key. */
  projectId?: string
  selectedId?: string
  onSelect(id: string): void
  onRemove?(id: string): void
  onOpenPlan?(): void
  /** Fallback banners' "Use Graph". */
  onUseGraph(): void
  controlRef?: Ref<FactorySceneHandle>
}

// lib/factory/snapshot.ts: the test hook, serialised into <output hidden data-testid="factory-state">
export interface FactoryTestState {
  renderer: 'webgl2' | 'floor-plan'
  reason?: 'no-webgl2' | 'chunk-failed' | 'context-lost' | 'too-many' | 'forced'
  quality: 'high' | 'low' | 'minimal'
  mode: 'live' | 'team'
  motion: 'full' | 'reduced' | 'paused'
  workers: { id: string; line: number; row: number; slot: number; x: number; z: number; lamp: Lamp; pose: Pose; statusWord: string; fenced: boolean; crate?: CrateAt; ambient: Ambient }[]
  lines: { number: number; leadId: string; rows: number[] }[]
  vacant: number
  cues: { kind: CueKind; from?: string; to?: string | null }[]
  cuesStarted: number
  messageCursor: string | null
  view: { ppm: number; targetX: number; targetZ: number }
  loop: 'running' | 'idle' | 'stopped'
  frames: number
  engines: number
  perf?: { drawCalls: number; shadowCalls: number; triangles: number; geometries: number; textures: number; frameP95Ms: number; intervalP95Ms: number; firstFrameMs: number; gpu?: string }
}
```

The test state is written at most twice a second and on every model change. It holds ids, numbers and words only
(no message text).

### 10.4 Test ids

`factory-scene` (root; `data-mode`, `data-renderer`, `data-motion`, `data-quality`), `factory-canvas`,
`factory-floor` (mirror group), `factory-worker` (per button, data hooks in 7.1), `factory-plan-board`,
`factory-nameplate`, `factory-line-sign`, `factory-dock`, `factory-controls`, `factory-find`, `factory-find-input`,
`factory-find-result`, `factory-zoom-in`, `factory-zoom-out`, `factory-fit`, `factory-pause-motion`, `factory-log`,
`factory-log-entry`, `factory-notice`, `factory-use-graph`, `factory-retry-3d`, `factory-context-lost`,
`factory-state`, `factory-sample`; host: `canvas-presentation-factory-floor` (follows the existing radio pattern),
`factory-agent-back`, `factory-role-back`.

### 10.5 e2e

New `e2e/factory-floor.mjs` (token-free, mock adapter, throwaway data dir), standalone in `e2e:free`. The same
change updates the `e2e:free` list in `package.json`, adds a rule to `scripts/e2e-select.mjs` **before** the broad
canvas rule (first match wins): `components/canvas/factory/**`, `lib/factory/**`, `styles/factory*.css`,
`assets/factory/**`, `e2e/factory-floor.mjs` → `['factory-floor', 'canvas']`, with a case in
`scripts/e2e-select.test.mjs`, and updates CLAUDE.md's e2e:free list.

---

## 11. Build slices

Roles: **SE** Scene Engineer (deep), **TA** Technical Artist (everyday), **UIE** UI Engineer, **QA** QA Engineer,
**RV** Reviewer. Hot files (`src/shared/types.ts`, `package.json`, `CLAUDE.md`, `.orgai/ARCHITECTURE.md`) take one
claim at a time; each is owned by exactly one slice piece below. The UI Lead keeps the docs: this file's
implementation notes, `docs/agent-notes/renderer.md`, `.orgai/ARCHITECTURE.md` and `CLAUDE.md`.

### Slice 1: dependency, contract, empty floor, fallback (1a, 1b, 1c in parallel)

First, SE commits `lib/factory/types.ts` and a stub `FactoryScene.tsx` exporting the section 10.3 props and handle
(renders an empty `factory-scene` div) and messages UIE, so 1a type-checks against it.

- **1a UIE (contract and hosts).** `src/shared/types.ts` (`CanvasPresentation` and `CANVAS_PRESENTATIONS` gain
  `'factory-floor'`), `src/shared/canvasPresets.test.ts`, `src/main/store/settings.test.ts` (normalisation keeps
  `'factory-floor'`; `settings.ts` needs no code change because it validates against `CANVAS_PRESENTATIONS`),
  `lib/canvasSettings.ts` (option "Factory Floor"), `lib/canvas.ts` and `lib/canvas.test.ts` (new helpers
  `isScenePresentation(p)`, true for anything but 'graph', and `usesScenePalette(p)`, true only for the existing
  scene), `components/canvas/CanvasPresentationChoices.tsx`, `CanvasPreview.tsx`, `CanvasStyleButton.tsx`,
  `CanvasPresetGroup.tsx`, `components/settings/CanvasSection.tsx`, `styles/canvas-settings.css`,
  `views/LiveRunView.tsx`, `views/TeamView.tsx` (replace the scene-versus-graph checks with the helpers; mount
  `FactoryScene` with the props of 10.3, including `plan`, `runStatus`, `needsYouIds`; route the menu's zoom and fit
  to whichever scene handle is active; Back to floor; hint copy).
  The existing presentation keeps its behaviour exactly; its e2e must still pass.
- **1b SE (engine shell).** `package.json` and `package-lock.json` (`three` 0.187.0 and `@types/three` at the
  matching version, both exact; the `e2e:factory-floor` entry in `e2e:free`), `lib/factory/{types,capability,
  snapshot,boundary.test}.ts` with tests, `components/canvas/factory/{FactoryScene,FactoryCanvas,FactoryNotice,
  FactoryMirror,FactorySample}.tsx`, `engine/FactoryEngine.ts`, `styles/factory.css`. Empty hall (floor, walls,
  gantry, booth placeholder box), lights, theme switch, fit, render-on-demand, visibility stop, context loss and
  restore, dispose, test state, the floor plan path and all section 8 notices.
- **1c QA.** `e2e/factory-floor.mjs` (choose the presentation in settings; the scene mounts; `data-renderer`; forced
  floor plan via the developer key; notices and "Use Graph"; both themes; 1024 x 640 and 1600 x 1000 with no page
  scroll; zero `securitypolicyviolation` events), `scripts/e2e-select.mjs`, `scripts/e2e-select.test.mjs`. Also
  tries, in the e2e launch only, Chromium's software WebGL switches (`--use-angle=swiftshader`,
  `--enable-unsafe-swiftshader`; **unverified** in Electron 45) so CI can exercise the 3D path; if they work, adds
  them to the launch options of this script only (never to the product).
- **RV** reviews the new dependency (licence, size, no `eval` or `new Function` in the shipped chunk, CSP unchanged).

Proves: the dependency loads lazily under the unchanged CSP in the built app (an existing lazy chunk, `mermaid` in
`useDiagramDraw.ts`, already loads this way; the packed asar app is **unverified** until QA or the user runs it),
the presentation round-trips through settings, and the scene degrades to a usable floor plan without WebGL.

### Slice 2: layout, stations, workers, mirror, team mode (2a, 2b, 2c in parallel after slice 1)

- **2a SE.** `lib/factory/{layout,routes,camera,navigation,labels}.ts` with tests, `agentView.ts` (team half),
  `engine/instancing.ts`, `FactoryLabels.tsx`, mirror positioning and keyboard in `FactoryMirror.tsx`, camera input
  (drag, wheel, keys, tweens) in `FactoryCanvas.tsx`.
- **2b TA.** `builders/*.ts`, `lib/factory/palette.ts` with test, `assets/factory/manifest.json` (empty list and its
  schema test), screenshot review of every object in both themes at near, mid and far.
- **2c UIE.** `FactoryControls.tsx`, `FactoryFind.tsx`, `styles/factory-chrome.css`.
- **QA** extends `e2e/factory-floor.mjs`: team mode with 1, 5, 15 and 40 roles (written through the projects API in
  the script), coordinates from the test state equal the section 3.3 table, keyboard walk, Find, Delete confirms.

Proves: deterministic layout at every size, the full keyboard and pointer path, and team mode end to end.

### Slice 3: live state (3a, 3b in parallel after slice 2)

- **3a SE.** `lib/factory/{agentView (live half),model}.ts` with tests, `engine/poses.ts`, ambient loops with the
  cap, plan board, dock, worktree fence and crates in their end states, hall states.
- **3b QA.** Live checks with an `ORGAI_MOCK_SCRIPT` work script (spawns with parents, tool steps, a `[mock:fatigue]`
  style permission ask, plan and plan updates, a finish): lamps, poses and words per state, plan board counts,
  needs-you from a pending card. A 40-agent live run from 39 `spawn` steps. **Unverified**: that the mock allows 39
  spawns under the run's subagent limits, sets `state: 'tool'` during tool steps and counts `usage.toolCalls`, and
  creates worktrees in the fixture repo; if any fails, the Adapter Engineer adds a `[mock:factory-floor]` marker and
  that becomes a dependency of this slice.

Proves: every state reads correctly with no motion at all, which is also the reduced-motion baseline.

### Slice 4: cues and motion (after slice 3)

- **SE.** `lib/factory/{cues,motion,floorLog}.ts` with tests (fixed clock: caps, coalescing, cancellation on leave,
  finishAll, no replay across remounts), `engine/cueRender.ts`, Pause motion wiring, announcements.
- **UIE.** `FactoryLog.tsx` and its styles in `factory-chrome.css`.
- **QA.** e2e: message capsules appear in the test state only for messages after mount; nothing cues under
  `data-reduce-motion="on"` or Pause motion; remount does not replay; caps hold during a burst.
- The UI Lead runs `review-animations` on the diff and a Product Designer motion pass may tune values inside the
  caps of section 5, from measured screenshots and recordings, not from code.

### Slice 5 (only if Q2 is yes): bundled CC0 models

- **TA.** `assets/factory/models/*.glb`, `licenses/*.txt`, manifest entries, the hash test, triangle and size check.
- **SE.** `engine/assets.ts` (inline import, decode, `GLTFLoader.parse`, material replacement, procedural fallback),
  possibly `electron.vite.config.ts` (`assetsInclude`).
- **RV** reviews the asset handling (no network, no blob or data fetch, CSP unchanged) and the licences.

### Slice 6: hardening and sample

- **SE.** Quality steps, leak check support, performance numbers in the test state, the `E2E_FACTORY_PERF=1` mode.
- **TA.** `sample-dark.png` and `sample-light.png` rendered from the real scene with the sample team (a small script
  under `scripts/`, run by hand), swapped into `FactorySample.tsx`.
- **QA.** The gate: typecheck, the whole unit suite, build, `factory-floor` and `canvas` e2e, the 40-agent stress
  and leak cases.
- **RV** on the whole interactive change; Critical and High findings block. A mock UX walkthrough of live and team
  mode at both sizes and both themes.

Parallelism: 1a, 1b, 1c together; 2a, 2b, 2c together; 3a with 3b; slices 4 and 5 can run side by side (disjoint
files) once 3 lands; 6 last.

---

## 12. Verification plan

| Check | Where | Notes |
| --- | --- | --- |
| Pure modules | vitest beside each `lib/factory/*.ts` | Layout examples and property test, camera agreement with three's projection, navigation table, labels collision and caps, model state table (every `AgentState` x worktree status), cue scheduler on a fixed clock, log templates, palette contrast rule (robot vs floor luminance), import boundary |
| Scene state | `e2e/factory-floor.mjs` reading `factory-state` and the mirror's data hooks | Never pixels. Runs both renderers when WebGL2 exists, the floor plan always |
| Both themes | e2e and screenshots | Theme switch updates without a rebuild (test state `engines` stays 1) |
| Both sizes | 1024 x 640 and 1600 x 1000 | No page scroll; controls compact below 560 px stage width; nameplates readable |
| Reduced motion | `data-reduce-motion="on"` and the OS setting | No cues, no ambient, end states immediate; `loop` is `idle` after events |
| Pause motion | Toggle | Same as reduced; remembered across remounts in the session |
| Keyboard | e2e and by hand | One Tab stop, arrows, Home and End, Enter, Delete (team), Shift+Arrow, `+`, `-`, `0`, Find, Back to floor and Escape return focus |
| Accessibility tree | By hand with the app driver | Canvas hidden; names and descriptions as in 7.1; screen-reader speech **not verified** unless someone runs one |
| 40-agent stress | Team (40 roles) and live (39 spawns) | Draw calls and triangles under budget; label cap 24; ambient cap 12 |
| Mount and unmount | Toggle presentation 20 times | Leak criteria of 9.1 |
| CSP | e2e listener | Zero `securitypolicyviolation` events in both renderers |
| Screenshot review | TA with the app running | Both themes, near, mid and far, every state; recorded in this file's implementation notes |
| UX walkthrough | ux-researcher on mock data | Live and team, both sizes and themes, first-time user |
| Reviewer | After slices 1, 5 and 6 | Dependency, assets, interactive UI |

---

## 13. Open decisions for the owner

| # | Question | Recommendation | Cost of the alternative |
| --- | --- | --- | --- |
| Q1 | Robots or human workers? | **Robots.** Agents are not people; robots need no skin tones, genders or faces, and a wheeled robot never implies walking. | Humans need a varied, respectful set of figures and more triangles per worker (about 2,000), and invite reading emotion into poses. |
| Q2 | Fully procedural art or a bundled CC0 kit for the robot and machines? | **Procedural first**, then decide from the slice 2 screenshots. | A kit (Kenney Factory and Conveyor kits, Quaternius robots or KayKit; CC0 reported, **GLB availability and licence text unverified**) adds slice 5: about 1 to 1.5 MB, material remapping, a provenance manifest and a Reviewer pass. Gains finer silhouettes and possibly animated robots. |
| Q3 | Camera rotation? | **No rotation in the first build.** | Four 90 degree steps (Q and E) cost: keyboard arrows must follow the view, labels and lamps must face the camera, the booth and gantry need detail on every side, and screenshots double. About one slice. |
| Q4 | Earlier sessions of a chain on the floor? | **No**: listed in Find a worker only; the floor is one shift. | A second hall per earlier session costs layout, camera bounds and a lot of extra stations at 40-plus agents. |
| Q5 | Offer the 2D floor plan as a user choice (not just a fallback)? | **Not now**; it exists and could be exposed later at low cost. | One more settings option and its copy. |
| Q6 | Name in settings | **"Factory Floor"**, description "A 3D factory view of your team". | None. |

---

## 14. Integration

Factory Floor is a third value of the canvas presentation setting, beside Graph and the existing Pocket Office scene.
It shares only the slot those presentations plug into: the setting (`CanvasPresentation` in `src/shared/types.ts`,
normalised by `src/main/store/settings.ts`, read through `useCanvasOptions()` in `lib/canvas.ts`), the presentation
choices and sample in settings, and the scene position in `LiveRunView` and `TeamView` with the
`zoomIn / zoomOut / fit` handle used by the app menu. The literal `'pocket-office'` is tested in about ten places
today (shared types, `canvasSettings.ts`, `CanvasPresentationChoices`, `CanvasPreview`, `CanvasStyleButton`,
`CanvasPresetGroup`, `CanvasSection`, `canvas-settings.css`, both views and three test files); slice 1a replaces the
scene-versus-graph checks with `isScenePresentation()` and the palette checks with `usesScenePalette()`, so neither
view special-cases one scene. Nothing in Factory Floor imports Pocket Office code, assets, styles or constants, and
the scene palette setting does not apply to it.

---

## 15. What is unverified

- `three` 0.187.0 sizes (about 181 kB gzip for the package) and how well named imports tree-shake in this build;
  the matching `@types/three` version.
- That three r187's core contains no `eval` or `new Function` (the CSP has no `unsafe-eval`).
- `GLTFLoader` turning embedded images into blob URLs in r187, and Vite `?inline` for `.glb`.
- That the lazy three chunk loads in the packed, sandboxed, asar-packaged app (the built app under `file://` already
  loads lazy chunks such as `mermaid`).
- WebGL2 availability on GitHub's windows-latest and macos-15 runners, and the software WebGL switches in Electron 45.
- WebGPU status in Electron 45 (not used).
- Chromium's live-context limit in Electron 45.
- Every performance target in section 9 (no code exists yet).
- The perspective size variation at 28 degrees, the readability of the 55 degree pitch and every palette value:
  to be checked on screenshots.
- The mock adapter's ability to produce 39 spawns, `tool` states, `toolCalls` counts and worktrees for e2e.
- The LiveRunView variable that lists pending decisions and whether each item exposes its agent id directly.
- The name of the app's short time formatter used by the run log.
- Screen-reader speech for the mirror.

## Implementation notes

### Slice 1 (2026-11-19): dependency, contract, empty floor, fallback

Built by the Scene Engineer (1b), a UI Engineer (1a) and a second UI Engineer standing in for QA (1c, the QA role was
not available to the UI Lead); integrated, measured and documented by the UI Lead. Machine: Windows 11, NVIDIA GeForce
RTX 3060, Electron 45.2.3.

**Owner decisions taken during the slice (deviations from section 11).**

- **Live only.** Factory Floor is not mounted in `TeamView.tsx` and that file was not edited (the Team tab run is
  removing scenes from the Team editor). Dropped from 1a: the Team mount, `factory-role-back` and the Team hint line.
  `FactoryScene` keeps `mode: 'team'` in its props, pure modules and tests; it is just unreachable. With
  `'factory-floor'` saved, Team shows the Graph (its checks only test `'pocket-office'`); `e2e/factory-floor.mjs`
  asserts that. Section 6.6's Team column and 6.8's team items are therefore not built.
- `package.json` belonged to 1b; the UI Lead applied it with `npm install --package-lock-only` (no `npm install` in
  worktrees), then restored the lockfile's existing `libc` fields that the local npm dropped, so the lockfile diff is
  additions only (three, @types/three and its five dev-only dependencies).

**Other deviations.**

- Key light direction (0.45, -1, 0.35): section 4.2's (-0.45, -1, 0.35) points south-west, contradicting its own words
  "from the north-west, pointing south-east"; the x sign was taken as a typo.
- Ambient light: 0.15 dark, 0.25 light (section 4.3 gives no value); for the Technical Artist to tune.
- Context lost: the canvas is hidden behind the note instead of "a dimmed last frame" (Chromium discards the frame and
  paints a grey broken-image placeholder).
- After a restore, three re-creates its background state with a black clear colour; `rebuild()` now re-applies the
  theme (found on the slice 1 screenshot, fixed and re-shot).
- Mirror and floor plan: slice 1 tiles flow (booth band first, then a grid in creation order) because layout arrives in
  slice 2. In the 3D view the tiles sit over the bottom of the stage (at most 45 percent of its height); no arrow keys,
  no hint text, `focusWorker` focuses without panning. Lamp rule and status word live in `FactoryMirror` until
  `model.ts`. The empty-hall size, booth constants, palette and a minimal fit live in the engine until slice 2's
  `layout.ts`, `palette.ts` and `camera.ts`.
- `needsYouIds` source (section 15 item): `DecisionItem` has no agent id, so `RunView` derives `needsYouIds` from
  `run.permissions`, `run.questions`, `run.ruleRequests`, `run.mergeReviews` and open MCP install requests (by
  `agentId`), plus the root when `run.proposals` is non-empty. The state-to-word map is local to `LiveRunView.tsx`
  until slice 3's `agentView.ts`.
- "Back to floor" or "Load earlier sessions" for an agent not on the floor focus Find a worker, and until Find exists
  (slice 2) the first worker button (Reviewer M1).
- Settings sample: the floor plan of a fixed five-agent team (Orchestrator, Architect, Reviewer, Developer, Tester)
  until slice 6's PNGs.
- `e2e/pocket-office.mjs` now expects three presentation choices.

**Measured.**

| Measure | Value | How |
| --- | --- | --- |
| Lazy chunk `FactoryCanvas-*.js` (three + engine) | 1,242,585 B raw, **250,906 B gzip** as built (final head): over the 230 kB target | `npm run build`, Node `zlib.gzipSync` level 9 on the file in `out/renderer/assets` |
| Same chunk minified (estimate) | 542,980 B raw, 134,033 B gzip | Scene Engineer, rolldown `minifySync` on the built chunk; the app's renderer build is not minified (owner: no build-config change in this slice) |
| Main renderer JS chunk | 1,371,346 B gzip base (1bb61695) to 1,375,844 B at the final head: **+4,498 B**, over the 4 kB target | Same method, base built from `git archive` of the base commit |
| Main CSS | 117,758 B to 119,018 B gzip: +1,260 B | Same |
| `eval(`, `new Function`, `WebAssembly`, `.wasm` files | 0 in both chunks and under `out/` | grep of the built files; Reviewer confirmed |
| WebGL2 on this machine | yes; GPU "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002504) Direct3D11 vs_5_0 ps_5_0, D3D11)" | `WEBGL_debug_renderer_info` in the test state |
| renderer.info, empty hall with booth | 7 draw calls main pass, 6 shadow pass, 74 triangles, 7 geometries, 4 textures | test state `perf` |
| Time to first frame | 621 ms cold first launch, 196.5 ms next launch, 25 to 59 ms warm remounts (Scene Engineer); 252.7 ms in the UI Lead's screenshot launch | test state `perf.firstFrameMs` |
| Idle frames | 0 over 3 s; a theme switch costs one frame and keeps `engines` 1 | test state |
| Fit | ppm 20.68 at 1024 x 640, 27.55 at 1600 x 1000 (live stage with the decision tray open) | test state `view` |
| 20 mounts and unmounts | `engines` 1, 7 geometries and 4 textures on the first and last mount, one canvas | Scene Engineer, built app |

**Section 15 items.**

- Confirmed: the lazy three chunk loads in the built app under the unchanged CSP (zero `securitypolicyviolation`
  events in `e2e/factory-floor.mjs`); r187's shipped chunk has no `eval` or `new Function`; WebGL2 is available here.
- Confirmed: Chromium's software WebGL switches `--use-angle=swiftshader --enable-unsafe-swiftshader` work in Electron
  45 on this machine: GPU string "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader
  driver)", and the context passes `failIfMajorPerformanceCaveat`, so the probe takes the 3D path. `--use-gl=angle`
  adds nothing. `--disable-gpu` alone gives no strict context and a "Microsoft Basic Render Driver" loose one. The
  switches are on by default in `e2e/factory-floor.mjs` only (`E2E_FACTORY_SWGL=0` uses the GPU).
- Size: three r187 in this build is 250.9 kB gzip unminified (the 181 kB figure is not reached without minification).
- Still unverified: the packed asar app (`npm run pack` was not run), GitHub runners, Chromium's live-context limit,
  every section 9 target beyond those above, screen-reader speech, macOS and Linux.

**Checks (UI Lead, integrated worktree).** `npm run typecheck` clean. Whole unit suite: 21 failures out of 13,863,
none in changed files: the six known symlink EPERM tests, CLI tests that read `node_modules` inside the worktree (which
has none: ink, the Claude Agent SDK, TUI colour panes) and two load timeouts (`folderConfigTrust`, `selfControlGate`)
that pass alone; renderer, shared and settings tests 2,967 of 2,967 after the final fixes. `npm run build` passes.
`e2e/factory-floor.mjs` 54 of 54 on SwiftShader and on the GPU; `e2e/canvas.mjs` 612 passed, 0 failed (also re-run
after the final fixes: all checks passed);
`e2e/office.mjs` 422 passed, 0 failed (`pocket-office.mjs` runs inside both).

**Reviewer (dependency pass).** No Critical or High. M1 (focus to a missing Find button): fixed. M2 (with Factory
Floor chosen, Graph styles are hidden in the Team popover and in settings although Team still shows the Graph; the
description "A 3D factory view of your team" is untrue for Team): open, it depends on the Team tab run removing scenes
from Team and is for the owner. L1, L2 (budgets): recorded above. L3 (engine constructor leak on a part-way failure):
fixed. L4 (a harmless stray timer after unmount): open. L5 ("Try 3D again" after a genuine chunk failure may fail at
once, Chromium caches failed module fetches): open, unverified. L6 (boundary test scanned only the factory folders):
fixed, the three and static-`FactoryCanvas` rules now scan every renderer file. L7 (docs): done in this pass.

**Screenshots** (`docs/design/factory-floor-shots/slice-1/`, live mode on a mock run with the orchestrator and one
implementer waiting on a permission card; looked at by the UI Lead):

- `live-dark-1600x1000-webgl.png`: dark floor slab, a faint grid visible only on the southern strip, a raised gantry deck
  along the north, the booth box casting a shadow onto the deck, walls as a darker rim. Clear colour matches the stage.
  Slice 1 tiles bottom left ("Orchestrator, Control booth, Running"; "implementer-1, Needs you"). Most of the hall at
  fit is gantry deck, so the empty floor reads as a raised platform rather than a hall.
- `live-light-1600x1000-webgl.png`: same in light grey; deck and floor values are close, the wall rim is lighter than the
  floor. Readable.
- `live-dark-1024x640-webgl.png`, `live-light-1024x640-webgl.png`: the stage is about 240 px tall with the decision card
  open; the booth box's top is cut by the stage top, and the second tile ("implementer-1") is clipped at the bottom with
  a scrollbar on the mirror. Defect for slice 2 (fit and mirror positions).
- `live-*-floorplan.png` (both themes, both sizes): the booth band with the Orchestrator tile, then the implementer
  tile; tokens in both themes; no page scroll.
- `notice-no-webgl2-*.png`: info banner "3D view unavailable" with the exact body and "Use Graph", dismiss button,
  floor plan below. `notice-chunk-failed-*.png`: warning banner "3D view did not load", "Try 3D again" and "Use
  Graph". Copy matches section 8 in both themes.
- `notice-context-lost-dark-1600x1000.png`: the stage is dark with the centred note "The 3D view stopped. Restoring…";
  tiles stay usable. `context-restored-dark-1600x1000.png`: the hall is back with the correct clear colour (after the
  fix; the first shot had a black clear colour).
- `settings-dark-1600x1000.png`, `settings-light-1600x1000.png`: three presentation cards; the Factory Floor thumbnail
  is a cropped floor plan showing "Orchest" cut off, weaker than the Graph and Pocket Office thumbnails (slice 6 PNG
  replaces it). The preview below is the inert five-agent floor plan.
- `live-dark-1600x1000-new-run.png`: before a run starts the Live tab shows the existing "Give Orchestrator something
  to do" start screen, so "The floor opens when the run starts." is not seen there.
- Section 8 notices not shot: "3D view stopped" (not restored in 5 s, third loss), "Large team" (needs more than 120
  agents) and the model-asset note (GLB phase only).

**Open after slice 1.** Reviewer M2, L4, L5; the 1024 x 640 crop and mirror clipping (slice 2); the Technical Artist's
palette pass (the empty hall reads as a platform; deck and floor are close in light); the settings thumbnail (slice 6);
the lazy chunk and main chunk budgets (minification is an owner decision); the packed asar app.
