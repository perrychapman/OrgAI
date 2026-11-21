# Motion

Motion in OrgAI says one of three things: *this just arrived*, *this is alive*, or *this is the same thing in a new place*. Anything else is decoration and is left out.

## Rules

- Animate `transform` and `opacity` only. The exceptions are SVG stroke tracing (`stroke-dashoffset`), the clip wipe that reveals a chart, and the button-controlled height collapse.
- Use the tokens. Never write a literal duration or easing.
- Nothing blocks input. Every state is complete and clickable the moment it appears; motion only decorates the way in.
- Reduced motion (the system preference, or Appearance > Reduce motion) collapses every duration to 0.01 ms, every distance to 0 and every start scale to 1. Loops stop; their static cue stays. Check both switches in CSS and read `useReducedMotion()` in script.
- Two looping motions exist, and both mean "alive": the breathing working mark (at most 12) and the signal dot that travels a reporting line in Team pulse while agents message. Nothing else loops.
- Stagger at most 6 items by `motion-stagger`; later items arrive with the sixth.

## The vocabulary

| Recipe | What it says | Tokens |
| --- | --- | --- |
| Rise | A row, card or view arrived | `dur-base`, `ease-out`, `motion-distance-sm` |
| Rise, large | A page band arrived | `dur-slow`, `ease-out`, `motion-distance` |
| Pop | A popover, chip or badge appeared | `dur-base`, `ease-out`, `motion-scale-from` |
| Ring | Look here once (a new decision) | `dur-slow` × 2.3, `ease-out`, `accent` |
| Ping | A count rose (the bell) | `dur-slow`, `ease-out` |
| Slide | The same indicator, new place (KPI bar, tab underline) | `dur-slow`, `ease-in-out` |
| Breathe | An agent is working | `dur-pulse`, `ease-in-out`, `state-working` |
| Draw | Data drawing itself: arcs and reporting lines trace, areas and sparklines wipe in left to right, heatmap columns fade in, figures count up | `dur-draw`, `ease-out` |
| Signal | Agents are talking: a dot travels the line between them | 2.4 s a trip, linear |
| Collapse | A button-controlled region opens or closes | `dur-base`, `ease-in-out` |
| Exit | Something left | `dur-fast`, `ease-in`, opacity only |

Draw and its `dur-draw` token are the redesign's additions. Everything else is the app's existing motion system.

## Page arrival (new)

The Dashboard and Usage pages stage their arrival once, when the person navigates to them or the app opens on them:

1. The Briefing (or the Usage pacing header) rises large. Its figures count up from zero over `dur-draw`.
2. The bands below rise in reading order, staggered by `motion-stagger`, at most six steps.
3. Charts draw: Team pulse traces its lines and pops its nodes, arcs trace clockwise, areas wipe in left to right. Total time from navigation to rest is under 800 ms.

Returning to a page within the same session without a data change skips the staging; the page appears at rest. A live update (an agent starting, a decision arriving) animates only the thing that changed.

## Live updates

- A new decision row rises and rings once. The Needs you count pings.
- An agent row that starts working gains its breathing mark; its activity line cross-fades (`dur-fade`) when the text changes, at most once a second.
- A figure that changes tweens from the old value to the new over `dur-slow`. Skip the tween for a change under 1%, and never tween from unknown.
- A plan step that completes fills its segment with `dur-slow`; the row does not move.
- Rows that reorder glide to their new place (FLIP, `dur-slow`), at most 8 rows.

## Never

- No motion on first paint beyond the page arrival above.
- No parallax, no scroll-linked animation, no looping shimmer or skeleton sweep.
- No spring on layout. `ease-spring` is for switch thumbs and popovers.
- No animation of colour to signal state on its own; state always has a static cue too.
