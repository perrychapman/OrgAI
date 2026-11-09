# Compact decision layout: focused UX verification

Reviewer: UX Researcher. Built worktree `1c145d4f`, mock fixture from `e2e/runs.mjs`, fresh temporary data directory. Inspected 1024x640 and 1440x900, dark and light, panel open and closed. Screenshots: `e2e/shots/ux/compact-*`.

Verdict: FIXED for the observed option clipping. No High or Medium blocker observed in the exercised flow.

## Earlier finding

Third option clipped behind Submit at 1024: fixed. Both themes and panel states show all three complete rows. At 1024 the third row spans y=407.7–435.1, the scroll body spans y=345.0–474.4, and the footer begins at y=474.4. At 1440 all rows fit as well. No copy change is recommended.

The composer retains “Replying to Orchestrator” and the Enter, Shift+Enter and paste hints in all eight states. At 1024 the free-text field is partly visible and the question body can scroll; the options and Submit remain visible. ArrowDown selected the second radio; Tab reached the free-text field. Clicking Submit recorded “Fixed window” and removed the question. Clicking Change model opened its connection and model controls.

## Not driven

The keyboard check began with programmatic focus on the first radio; a complete keyboard-only journey, visible focus rings, keyboard submission and keyboard access to Change model were not verified. Every option was not individually submitted; free-text entry and scrolling to its end were not exercised. Expanded proposals, assistive technology, and live providers were outside this focused check. No feature code was changed.
