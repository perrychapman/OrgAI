# OrgAI UX review: Hide finished agents (canvas fold)

Reviewer: UX Researcher. Build: dev `d6e57b6` ("Fix folded finished-agent groups"), `npm run build`, `ORGAI_MOCK=1`, fresh temp `ORGAI_DATA_DIR` per script (e2e/lib.mjs `launch`). No tokens spent. Window `setContentSize` 1600x1000 and 1024x640, dark and light via `data-theme`, mouse plus a keyboard pass at 1024x640. Spec: `docs/design/spec.md` 2.5 "Folding finished agents"; CLAUDE.md Renderer "Canvas fold".

Shots and raw numbers: `e2e/shots/ux/fold/` (gitignored; the brief allowed this one doc only, so the shots are not committed beside it). `results.json` / `results2.json` hold every sampled state and timeline. Drivers: `e2e/shots/ux/fold/walk.mjs` (deep tree, continue, flat run), `walk2.mjs` (a 27-agent tree from a custom `ORGAI_MOCK_SCRIPT` work script, 700 ms per step), `walk3.mjs` (slow cadence; written, never run, see "Not driven").

Runs walked:

- Deep tree `[mock:deep-tree]`, 1200 ms per step: root -> mock-lead -> mock-lead-report-1 / -2 (shots 01-31).
- Continue of that chain with `[mock:deep-tree]` again, which gives an earlier-session group (shots 32-35).
- Default mock run with no marker, the flat case with 2 reports (shots 36-39).
- Wide tree, 27 agents: 8 direct reports plus 3 leads with 5 reports each, all finishing at staggered times (shots 40-57). This is the closest the mock gets to the user's 27-agent report.

## Verdict: PARTLY FIXED

Once a run goes quiet, the fold matches the spec. The reported bug is gone: there are no parentless "N done" nodes beside the root. A finished subtree is one group under its nearest visible ancestor, with an edge (shots 10, 22, 43). The group's count and cost cover the whole subtree. The toolbar "(N)" always equals the sum of the group counts (3 -> 2 -> 0 while expanding the deep tree; 26 -> 15 -> 10 on the wide tree; 6 = 3 + "Earlier: 3" after a continue). One-level expand works and its announcement fires.

Two problems keep this from being fixed for the user's case:

1. While a busy run keeps sending events, nothing folds at all (H1). On the 27-agent run every finished agent stayed on the canvas until the root went Idle. The chart sat at zoom 0.3 with unreadable nodes (shot 41).
2. Every name the fold shows is the role name. The tooltip, the side-panel list, the "under <name>" line and the announcement all read "Implementer" for every member (H2). With one role across 26 reports, the list cannot tell agents apart.

## Status of the reported issue

| Reported (27-agent run) | Status | Evidence |
| --- | --- | --- |
| Finished groups are a row of tiny "N done $x" nodes beside the orchestrator | Fixed | Shots 10, 43: one group under the root with a dashed edge; the deep tree folds into a single "3 done" (`group:root`, `data-count=3`), not one group per parent. |
| No edges to the groups | Fixed | Edge `e-root-group:root` exists in every folded state; the lead's group has its edge after expand (shot 13). |
| Groups count and price the subtree | Fixed | "3 done $0.0057" = 0.00285 + 0.001425 + 0.001425 (shot 12 rows); "26 done" on the wide tree. |
| Folding while the run is live | **Open (new H1)** | Wide tree: direct-1 finished at about 5 s and was still on the canvas at 52 s; the first fold came at 53 s, 4 s after Idle (results2.json timeline). |

## Findings

### High

**H1. Finished agents do not fold while the run keeps producing events.**
- Flow: start the wide run (27 agents, one step every 700 ms) with Hide finished on, and watch.
- What happens:
  - Nothing folds for 49 s, although direct-1 to direct-4 reported back in the first 8 s.
  - The canvas grows to 27 nodes at zoom 0.3 (shot 41 at 13 s: 11 agents, 5 of them "Reported back", none folded).
  - At 53 s, after the root went Idle, everything folds in two jumps: "20 + 4", then "26" a second later.
  - The deep tree with 1200 ms steps did the same. Both reports were done by 11 s and nothing folded until 19 s, after the root's turn ended (results.json timeline).
- Cause (code read): `LiveRunView.tsx`, the grace ticker effect at about lines 330-336. It runs `setInterval(..., 1500)` with deps `[agents, collapseFinished]`. Every `agent.upsert` gives a new `agents` array, which clears and restarts the interval before it fires. `now` therefore stays frozen while events arrive faster than every 1.5 s, and `isSettled` (6 s grace) never turns true. A real run streams updates constantly, so in practice folding only happens when the run pauses. This is exactly when the user does not need it.
- Owner: `src/renderer/src/views/LiveRunView.tsx` (ticker); the test gap is in `e2e/runs.mjs`.
- Expected: an agent folds about 6 s after it ends, whatever else is happening.
- Fix: drive the tick from the next deadline, not from `agents` identity. One way: compute `next = min(endedAt + COLLAPSE_GRACE_MS)` over done or failed, unsettled agents, then `setTimeout(() => setNow(Date.now()), next - Date.now())` keyed on that number. Another: keep one interval whose deps are only `[collapseFinished, hasPending]`.
- Check: add an e2e step with `delayMs` 700 and 15 or more steps after a report finishes. While the run tab still says Running, that report's node is gone and a group with its count exists within 8 s of its finish. Today `e2e/runs.mjs` only checks the fold after the run is idle, so it cannot catch this.

**H2. Group members are named only by role, so the list, tooltip, "under" lines and announcement are ambiguous.**
- Flow: select the "3 done" group (1 click) and read the side panel.
- What happens:
  - All three rows read "Implementer", and two say "under Implementer" (shot 12).
  - On the wide tree, 26 rows read "Implementer" and "under Implementer" (shot 44). Only the mock's result text happens to mention the handle.
  - The node tooltip reads "Implementer, Implementer, Implementer".
  - The expand announcement says "Showing 5 agents under Implementer" (walk2, lead-c).
  - The agent nodes themselves show the handle on their second line ("mock-lead · sonnet-4-5", shot 14), so the canvas and the list disagree.
- Owner: `components/FinishedList.tsx` (`a.name`), `components/DoneGroupNode.tsx` (`names`, button label `Show reports under ${parentName}`), `views/LiveRunView.tsx` (`underOf`, `groupParentName`, the `arrival` text).
- Expected: each row names the agent the way its node does. A row shows the handle (mock-lead-report-1) with the role as secondary text, and the "under" line reads "under mock-lead".
- Fix: one helper, `agentLabel(a)` (handle when set, else name), used by the list title, the tooltip, `underOf`, `groupParentName` and the chevron's aria-label. Keep the role as the caption.
- Check: on `[mock:deep-tree]` the list rows read mock-lead, mock-lead-report-2 and mock-lead-report-1, and the last two say "under mock-lead". The announcement after expanding the lead's group reads "Showing 2 agents under mock-lead".

### Medium

**M1. Fold-back is hidden, and the switch says "on" while nothing is hidden.**
- Flow: expand "3 done", then "2 done" (2 clicks).
- What happens:
  - All four agents show while the switch still reads "Hide finished agents", on, with no count (shot 14).
  - There is no control on the expanded parent or anywhere else to fold that branch back.
  - The only way back is the switch: off, then on (2 clicks). That also throws away every other expansion. The behaviour is explained only in the switch's `title` tooltip.
  - Code read, not driven (walk3): `expandedGroups[root]` stays true for the rest of the run. After expanding the root's group mid-run, every later finished direct report of the root stays on the canvas until the switch is toggled. Expanding once silently turns folding off for that parent.
- Owner: `views/LiveRunView.tsx` (`expandedGroups`, toolbar), `components/AgentNode.tsx`.
- Expected: the user can fold an expanded branch back where they opened it, and new finishes under an expanded parent still fold.
- Fix:
  - Give an expanded parent a "Hide reports under <handle>" chevron-up IconButton (the twin of the group's chevron) that deletes its key.
  - While any group is expanded, show "Fold all again" next to the switch, or reset `expandedGroups[key]` when a new member settles under that key.
- Check:
  - After expanding the deep tree's root group, the Implementer node has a "Hide reports under mock-lead" button (the root's button is named after the root), and 1 click on it shows "3 done" again.
  - After expanding the root's group mid-run, a report that finishes later folds into a group under the root within 8 s.

**M2. Expanding a large group fits everything at minimum zoom, and the chart is unreadable or clipped.**
- Flow: wide tree folded, then click the chevron on "26 done" (1 click).
- What happens:
  - 11 direct reports plus 3 "5 done" groups at zoom 0.3 (shot 46 at 1600: about 4 px text).
  - At 1024x640 the groups are 72x17 px and the end nodes are cut off at both canvas edges (shots 51, 53: `group:lead-c` at x=52 while the canvas starts at x=56).
  - Turning the switch off shows all 27 at the same zoom (shot 49).
- Owner: `views/LiveRunView.tsx` (topology `fitView` after an expand), `lib/layout.ts`.
- Expected: after an expand the user can read what appeared.
- Fix: after an expand, fit to the expanded parent plus its new children with a readable minimum zoom (about 0.6), and keep the rest of the chart reachable by pan. Alternatively, cap one expand at about 8 nodes and leave the rest in a "+N more done" group.
- Check: at 1024x640, expanding "26 done" leaves the shown report nodes at zoom 0.6 or more and fully inside `.react-flow`'s box.

**M3. Keyboard: Enter or Space on a focused group does nothing, so the side-panel list is mouse-only.**
- Flow, 1024x640 dark:
  - Tab from the switch reaches the zoom buttons, the legend, Show conversation, each agent node, then the group node.
  - Enter and then Space on the focused group (shots 53-55): `selected` stays false, and the list never opens.
  - Tab once more reaches "Show reports under Implementer". Enter expands, focus moves to the parent node (lead-c), and the frame announces "Showing 5 agents under Implementer". That part works.
  - The computed `outline` of the focused node wrapper is `none`, so whether a visible focus ring exists on group and agent nodes is unverified (the close-up was not driven).
  - In the deep-tree pass, Enter on the root node changed nothing either, but the root was already selected, so that proves nothing for agent nodes.
- Owner: `views/LiveRunView.tsx` (only `onNodeClick` selects; React Flow's keyboard selection is not wired to `selectAgent`), node CSS.
- Fix: handle Enter and Space on a focused node (`onKeyDown` on the node wrapper, or `onNodesChange` select changes) with `selectAgent(node.id)`. Give `.react-flow__node:focus-visible` a token focus ring. Give the group node an aria-label such as "3 finished agents under Orchestrator".
- Check: with the side panel open, Tab to "3 done" and press Enter; the panel shows "3 finished agents under Orchestrator". The focused node shows a 2 px focus ring in both themes.

**M4. Folds cascade and the view jumps more than once.**
- What happens:
  - On the deep tree the lead's reports folded into "2 done" under mock-lead at 19.0 s. At 20.5 s that group vanished into "3 done" under the root.
  - Each change re-runs `fitView` with a 500 ms animation, so the chart re-laid out twice in 1.5 s.
  - On the wide run the viewport transform changed 28 times. The user cannot keep reading a node while the chart re-fits under them.
- Owner: `views/LiveRunView.tsx` (topology effect).
- Fix: when a parent will itself settle within the grace window, fold its reports with it in one step. Do not auto-fit after the user has zoomed or panned by hand; offer Fit to view instead.
- Check: on `[mock:deep-tree]` the canvas goes from 4 agents to 1 agent plus "3 done" with no intermediate "2 done" state.

### Low

- **L1. The group node does not say what it is.** "3 done $0.0057" has no noun, and the chevron is the only sign that it opens. `aria-label` on the node is null. Use "3 finished agents" (or "3 done" with "agents" in the caption) and the aria-label from M3. Owner: `DoneGroupNode.tsx`.
- **L2. Earlier-session groups.**
  - "Earlier: 3 agents" sits to the right of this session's "3 done" (shot 33), so it reads as later. The spec asks for it above; this is a known gap.
  - Expanding it shows the whole earlier subtree at once (shot 35), unlike the one-level rule.
  - The expanded earlier agents look identical to this session's agents.
  - The panel head reads "3 finished agents under an earlier session" (shot 34).
  - Suggest: order the earlier group first (left), give expanded earlier nodes a dashed "earlier" style, and head the list "3 agents from an earlier session".
- **L3. Sibling order is reversed.** mock-lead-report-2 is drawn left of mock-lead-report-1 (shots 14, 35). Lay out reports in spawn order. Owner: `lib/layout.ts` / `treeLayout` input order.
- **L4. The list is crowded in a narrow panel.** At 1024 the "done" badge wraps onto its own line (shot 26), making rows about 110 px tall. 26 rows need a long scroll with no filter or grouping by parent (shot 44). Suggest grouping rows under their direct report, or a compact single-line row under 360 px.
- **L5. Cost precision varies between neighbours.** The same view shows "$0.0057", "$0.00285" and "$0.004275+" (shots 13, 38). This comes from `costView`; consider fixed 2 significant digits under $0.01. This is cosmetic and not specific to the fold.

### What works (keep)

- The group sits under its nearest visible ancestor with an edge, and is legible at zoom 1 in both themes (shots 10, 20, 22, 25). Nothing floats over the canvas.
- The toolbar count always matches the groups: 3, 2, 26, 15, 10, and 6 with an earlier session.
- Selecting a group at 1024 opens the collapsed side panel on the list (shot 26).
- "Show on chart" in the panel expands and moves focus to the parent (shot 18).
- Expand announcements: "Showing 1 agent under Orchestrator", "Showing 2 agents under Implementer", "Showing 3 agents under an earlier session".
- The flat default run folds into one "2 done $0.004275+" group. The unpriced report shows "unknown" and the group cost is a lower bound (shots 37, 38).

## Click counts (deep tree, mouse)

| Task | Clicks |
| --- | --- |
| See which agents a group holds | 1 (group body), then read the list. With H2 open, the names do not tell them apart. |
| See one indirect report on the chart | 2 (root chevron, then lead chevron) |
| Read one folded agent's transcript | 2 (group body, list row) |
| Fold back after expanding | 2 (switch off, switch on), with no visible hint; this also resets every other expansion |
| Keyboard: open the group list | not possible (M3) |
| Keyboard: expand a group | Tab to the node, Tab once more, Enter (works) |

## Not driven

- `walk3.mjs` (slow cadence, 2 s steps) never ran: the coordinator stopped all app driving because the windows took focus from the user. Not seen as a result:
  - An agent folding mid-run when events pause long enough.
  - A selected agent folding into its group (the code marks the group selected; the panel behaviour is unseen).
  - The sticky expansion in M1 (code read only).
  - Focus-ring close-ups in both themes.
  - Enter on an unselected agent node.
- Failed and unmerged counts: the mock has no failing-report step and no worktree conflicts.
- The light-theme keyboard pass.
- Reduced motion.
- A relaunch with folded groups.
- A real 27-agent run on Claude or Codex: H1 is inferred from the mock cadence and the code, not from a live run.

## Suggested order of work

1. H1, the grace ticker, plus an e2e check that a report folds while the run is still Running.
2. H2, one `agentLabel` helper for the list, tooltip, "under" lines, chevron label and announcement.
3. M3, keyboard select on nodes and a visible focus ring.
4. M1, a local fold-back control, and new finishes under an expanded parent still folding.
5. M2 and M4, readable fit after an expand and no cascading re-fits.
6. L1-L5.
