---
name: ux-walkthrough
description: "Walk a user-facing OrgAI change in the running app on mock data, at both window sizes and in both themes with a keyboard pass, and write the findings to docs/design/ux-review-*.md. Use when a brief asks for a UX walkthrough or re-walk, or after a user-facing change lands."
---

# Mock-data UX walkthrough

The project requires a walkthrough for user-facing changes. It never spends tokens. You report what you saw; you do not fix code.

## Set up

1. Read the spec for the feature in `docs/design/` and any earlier `ux-review-<topic>*.md`. A re-walk checks those findings first.
2. Record the short SHA you built, then run `npm run build`.
3. Drive the app with a script on `e2e/lib.mjs`. Set `process.env.ORGAI_MOCK = '1'` at the top, as the e2e scripts do. `launch()` gives a fresh temp data dir, so your walk never touches the real profile. Use `run-desktop` for quick looks.
4. Keep walk scripts, shots and raw results under `e2e/shots/ux/<topic>/` (gitignored). Do not commit them.

## Mock data

- The default script plays a work run with reports and an approval. Follow-ups get `Mock reply to: <text>`.
- Prompt markers change a run: `[mock:deep-tree]`, `[mock:fatigue]`, `[mock:config-change]`, `[mock:mcp-midrun]`, `[mock:no-price]`, `[mock:computed-cost]`, `[mock:title-fail]`, `[mock:auth-fail]`.
- `ORGAI_MOCK_SCRIPT=<path to JSON>` loads a custom script. See `docs/testing.md` section 3.
- If the mock cannot produce a state, say so in the report. Do not imply you saw it.

## Walk

Cover this matrix for the changed screens:

- 1600x1000 and 1024x640. Set the size in the main process with `setContentSize`.
- Dark and light, through `data-theme`.
- Mouse first, then a keyboard-only pass at one size.

Walk as a first-time user would, and look at:

- Task: can they finish it, and do they know it worked? What happens next?
- States: empty, loading, error, long text, many items, ended runs, relaunch.
- Layout: page scroll or shift at 1024x640, clipped text, a tray or panel squeezing the canvas.
- Words: status vocabulary, plain language, numbers that add up.
- Accessibility: focus order, visible ring, focus after an action, announcements.

Compare with the spec. Take a screenshot for every finding, and sample real numbers when a claim depends on them.

## Write the report

Write `docs/design/ux-review-<topic>.md`, adding `-2`, `-3` for a re-walk. Write only this file unless the brief allows more.

1. **Header**: reviewer role, build SHA, how it ran (`ORGAI_MOCK=1`, sizes, themes, keyboard), the spec it was compared with, where the shots are.
2. **Verdict**: a one-word status such as FIXED, PARTLY FIXED or NOT FIXED, then a short paragraph on what matters most.
3. **Status table**: on a re-walk, each earlier item with Fixed or Open and its evidence.
4. **Findings, ranked** `H1`, `M1`, `L1`. Each gives the screen, shot name, steps to reproduce, what the user experiences and a concrete fix.
   - High: a user cannot finish a task, loses something or is misled.
   - Medium: it works, but is meaningfully confusing or harder.
   - Low: polish.
5. **Not driven**: everything you did not exercise, and why, such as native folder pickers or states the mock cannot produce.

State only what you observed. If you read something in code without seeing it, label it that way.
