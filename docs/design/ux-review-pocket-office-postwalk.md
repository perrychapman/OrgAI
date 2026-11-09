# Pocket Office postwalk

Reviewer: UX Researcher. Built commit `32fb4a51` with `npm run build`; ran the built desktop with `ORGAI_MOCK=1` and a throwaway data directory. Compared with `docs/design/pocket-office.md` and `docs/design/ux-review-pocket-office-prewalk.md`. Screenshots: `e2e/shots/ux/pocket-office-postwalk/` (gitignored). The initial window measured 1424 × 855 CSS pixels, dark theme; the requested exact size/theme matrix was not completed. No provider was used.

**Verdict: PARTLY VERIFIED.** The preference and initial interaction paths work in the observed mock session. The Settings preview still fails to frame the furnished room coherently. This is an interim review of the named commit, not verification of subsequent changes.

| Prewalk item | Status | Evidence |
| --- | --- | --- |
| Settings sample tiny, clipped and dominated by empty space | Open | `settings.png`: a small room at the left of a broad empty floor; its lower portion is below the viewport. |
| Graph controls dominate Office settings | Fixed in observed state | Office selection shows three palettes and no Graph styles or Customise. |
| Toolbar and inspector | Partly verified | `popover-settled.png`, `team-inspector.png`, `live-inspector.png`; see coverage below. |

## Medium

### M1 — Settings sample does not demonstrate the office at a useful scale

**Screen:** App settings > General > Canvas. **Shot:** `settings.png`.

1. Open App settings, select Pocket Office under Presentation, and look at the sample.
2. The example room occupies only a small area at the far left, surrounded by a large empty floor; the example person's name and status are small, on a narrow dark two-line plate. The bottom of the sample lies below the viewport.

The preview makes it difficult to understand the scene or judge a palette before selecting it. Frame a coherent furnished vignette at a readable scale, keeping the sample inert and the existing label **“Sample office · example agents”**. Keep the visible example name and status legible without requiring a hover.

## Observed interactions

- In Settings the Presentation group says **“Applies across the app, including Live and Team.”** Selecting Office immediately exposed Color, Neutral and Green, hid Graph-only controls, and announced “Canvas presentation: Pocket Office.” The Team view subsequently opened in Office, consistent with app-wide propagation in this session.
- The Team Canvas style popover opened with the checked Pocket Office native radio focused. Escape restored focus to the Canvas style button. The settled popover had computed opacity 1 and background `rgb(24, 28, 39)`; the translucent appearance in the first `popover.png` was a transition frame, not a settled finding.
- The visible Team person was a native button with accessible name “Orchestrator, Role” and `aria-pressed` state. Selecting it opened the inline role inspector. After changing floors, Back to office focused the selected Orchestrator's directory button on the other floor. A mock Live run reached “Needs you” and displayed an inspector (`live-inspector.png`).

## Not driven / not verified

Exact 1024 × 640 and 1600 × 1000 sizes, light theme, full keyboard journey, radio arrow selection, all three palette renderings, Graph customization round-trip and restart persistence were not completed. Accessible names and states were inspected in the rendered DOM for the sampled controls, not a complete platform accessibility tree. Focus-ring and text contrast, 200% zoom, reduced motion, dense/long Unicode names, many long messages and their bounded scrolling, off-floor Escape, announcement counts, role-editor and unrelated dialog behavior were not verified. No claim is made about these states. The driver cannot set exact window sizes; a main-process sizing harness is needed. The sample finding may have been addressed after this commit and requires a fresh built-app rewalk.

Accessibility disposition: **Not assessed for approval**; coverage is incomplete.

## Refined build rewalk

The lead supplied a built app based on `3f2e4ba0`, with additional popover and Graph preview refinements, through `ORGAI_APP_DIR`. A fresh mock data directory and fixture repository were used. This is a separate build from the named commit above. `final-sample-1024x640-dark.png` shows the previous sample framing issue resolved: a centered, coherent room and readable “Alex · Sample.” The sample is inert. At 1024 × 640 and 1600 × 1000, dark and light, a scripted Team walk checked all three palettes, named 24-pixel-or-larger person targets, and absence of outer horizontal scrolling. Selected settings, popover, Team inspector and Live screenshots are in the same shot folder. The sampled controls were inspected in DOM rather than a full accessibility tree.

Native radio arrows switched Graph and Office; the Graph style values survived the Office round-trip. Reload preserved the Office palette. Back and Escape returned focus to an Office person, including a directory entry when the selected person was on another floor. A mock 33-role directory and a 24-message burst were exercised; the latter respected three active and twelve queued delivery limits. In a separate run of 15 long mock messages, the Office messages section was keyboard-focusable and had a 158 px client height and 1651 px scroll height (`motion-02.png`); it visibly had its own scrollbar. This measures the sampled state, not every possible content shape.

Computed person-label text versus opaque backing contrast was 12.02:1 Color, 13.20:1 Neutral, and 10.71:1 Green in both themes. Border versus backing measured 5.76:1, 4.89:1, and 4.58:1 respectively. Focus ring against the actual floor was not measured. 200% zoom, the dense Unicode name and complete screen-reader tree remain unverified.

### M2 — Sampled same-floor message burst did not show a sustained walk

**Screen:** Live Office, refined build. **Shot:** `motion-02.png` shows the mock run and its long-message scroller, not the transient pose itself.

At 1600 × 1000, run a mock fixture that spawns a recipient and sends repeated long messages. In a 100 ms DOM sample, a same-floor delivery was active at 3851 ms and the sender's sprite changed pose; by 3960 ms it was inactive and had returned to its resting pose. Its sampled position remained at its desk. A series of screenshots did not catch a walk. This case does not establish behavior for every route, but it makes the delivery cue hard to perceive as a journey. Keep a visible, coherent walk and arrival long enough to understand, with direction and steps matching travel; retain the existing immediate message delivery and bounded queue. No copy change is required. Retest after the motion change with timed frames, including focused targets, hidden windows and reduced motion.

**Retest: fixed for the sampled journey.** On the lead's subsequent motion build with the stable caption strip, the same 15-message, 650 ms fixture at 1600 × 1000 sustained a root-to-report walk: sampled outbound at 1176 ms from (64, 81), arrival/settle at 5270 ms at (288, 81), return at 5507 ms, and the next outbound at the starting position at 9577 ms. The scene remained 985 × 732 on floor 1. `motion-fixed-00.png` through `motion-fixed-17.png` are consecutive screenshots taken with a 300 ms pause after each capture; capture time adds to each interval, so these are illustrative frames rather than precisely timed video. The orchestrator copied them before handback. Focusing the sender during outbound pinned it at (70, 81) for the 1.5-second sample. Turning reduced motion on during outbound returned it to rest at (64, 81); hiding the window held the outbound position at (68, 81) for 1.5 seconds. These are sampled observations, not complete motion approval.

On the later `ab26` lead build, a fresh mock run held the focused sender at (68, 81) during a 1.5-second sample and at the same position 900 ms after blur. A native hide held the sender at (69, 81); after approximately 12.5 seconds hidden and 700 ms after showing the window, the delivery indicator showed two active and zero queued. The mock runtime may advance differently while hidden, so this observation does not establish whether old messages replay or new events arrived. Hidden-window resume without replay, focus repin after later messages, parallel disjoint routes, distant-route fallback, camera behavior, and game feel across route lengths remain unverified. The original exact-commit M1 finding above remains evidence for that earlier build only; the refined sample addressed it.
