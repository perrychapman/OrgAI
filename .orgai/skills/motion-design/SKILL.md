---
name: motion-design
description: "Motion and animation rules for OrgAI's renderer: what may move, durations and easings through tokens, breathing and pulse choreography for live agents, stagger limits, reduced-motion handling and the e2e checks. Use when adding or changing any animation, transition, live cue or loading state in src/renderer, or when specifying motion in docs/design."
---

# OrgAI motion design

Motion in OrgAI means one thing: something is alive or just changed. It never decorates. The Live canvas, the Dashboard's Right now band and the Knowledge graph already set the vocabulary; extend it, do not invent a second one.

## What may move

- **State changes**: a row appearing or leaving, a status word changing, a card arriving. One transition of 120-200 ms on opacity and transform. Nothing else animates on a change.
- **Live cues**: an agent that is working breathes (the canvas halo, the band's `[data-breathe]` mark). Idle, waiting, done and failed never animate; waiting is a colour and a word, not a blink.
- **Progress with no end**: a loading state may pulse opacity between 0.6 and 1 at the slow rate. Never a spinner over content the user can still read.
- **Never**: layout (width, height, grid tracks), colour cycling, parallax, attention-seeking shake or bounce, motion on hover beyond a 100 ms colour change, anything on the canvas edges while the user drags.

## Rates and choreography

- Use the duration tokens (`--dur-fast`, `--dur-base`, `--dur-slow`, `--dur-pulse` in styles/tokens.css). Add a token in every theme block before using a new duration; never a literal `ms` in a component stylesheet.
- A breathing loop is 2.4-3.2 s, ease-in-out, amplitude at most 8 % of size or 0.3 of opacity. At most 12 elements breathe at once on a screen; past that, breathe the first 12 in DOM order and keep the rest static (the band's `data-breathe` cap). Stagger loops by 120-180 ms per element so a group never pulses in lockstep; the stagger comes from `animation-delay: calc(var(--i) * 150ms)` with `--i` set inline, never from JavaScript timers.
- Two loops with different rates on one screen read as noise. One rate per screen.
- Enter and leave: rows fade and slide 4 px, 160 ms; a group of rows staggers by 30 ms up to 8 rows, then the rest appear at once.
- Focus rings, selection and pressed states never animate; they must be instant.

## Reduced motion

- Every animation and transition is off under both `@media (prefers-reduced-motion: reduce)` and `:root[data-reduce-motion='on']`. Write the rule once per stylesheet with both selectors; set `animation: none` and `transition: none`, and hide purely decorative pseudo-elements (`::after` halos) with `display: none` so no static artefact remains.
- `lib/canvas.ts` `useReducedMotion()` is the one JavaScript source. Use it only to skip work (timers, rAF loops), never to pick a different layout.
- State must never be carried only by motion: a working agent still has its colour, dot and word when motion is off.

## Performance

- Animate only `transform` and `opacity`; set `will-change` only on elements that are animating now. A continuous loop on a `box-shadow` or `filter` repaints every frame; use a pseudo-element with a transformed radial gradient instead.
- One rAF loop per surface (the Knowledge graph's `neuralEngine.ts` is the model); stop it when the tab is hidden or the surface is unmounted. Never a `setInterval` for visuals.
- A hundred breathing nodes is a bug, not a feature: cap, fold or sample.

## Copy and announcement

- Motion never speaks. Live regions announce text changes only; a pulse or a row transition must not trigger an announcement.

## Checks before hand-off

- In the running app, both themes: reduce motion on, confirm `getComputedStyle(el).animationName === 'none'` for every mark and that no decorative element lingers.
- e2e: every new live cue gets a `data-*` hook (as `[data-breathe]`) and a check that it is absent or static under `data-reduce-motion='on'`.
- Say in the report which loops run on the screen, their rate and their cap, and what you looked at by eye.
