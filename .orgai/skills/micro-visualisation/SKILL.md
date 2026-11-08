---
name: micro-visualisation
description: "Rules for small data instruments in OrgAI's renderer: inline SVG sparklines, ledger strips, bars, rings and marks drawn with tokens, scale and tick choices, encoding unknown versus zero, text alternatives and keyboard readouts. Use when showing counts, costs, usage or time over days inside a card, row or band, or when specifying such an element in docs/design."
---

# OrgAI micro-visualisation

Small instruments show one fact the user checks at a glance, in the space of a row. No chart library (none is installed); inline SVG or CSS, tokens only, both themes.

## Choose the instrument

- **A share of a limit** (plan window, budget): a bar, `UsageBar` / `SpendBar` in components/UsageMeter.tsx. Do not draw a new one.
- **A value per day** (runs, cost, waiting time): a ledger strip of fixed-width columns, one per day, newest at the right, today marked (`--dash-strip-today`). The Dashboard's `ActivityStrip.tsx` with `lib/activityStrip.ts` is the reference.
- **Composition of a few parts** (roles in a team, agents by state): a row of marks (`.dash-mark`, `KindMark`), at most 8, then "+N". Never a pie.
- **A trend of many points**: a sparkline only when the screen already has the numbers somewhere; a sparkline alone is decoration.

## Scale and ticks

- Counts use a linear scale from zero. Money and tokens per day are spiky: use a square-root scale when the largest day is more than 8 times the median, and say so in the readout ("scale: square root"). Never a log scale (zero days vanish).
- Bars are at least 2 px tall when the value is above zero, so a small day never reads as empty.
- Ticks: at most one label per 7 columns on a 14-day strip (the two ends and today), weekday initials only when a column is 20 px or wider. Labels sit on one row; never rotate text.
- Fixed geometry per size: the component declares its heights (tall / compact / dense) in the spec and e2e measures them.

## Encoding

- **Unknown is not zero.** A day whose runs have no price shows a hollow or hatched mark with `data-cost-kind=unknown`, and a partly priced day `partial` with the sum shown as a lower bound ("$0.42+"). Every cost goes through `lib/cost.ts` `costView` and `ui/Cost.tsx`. The empty day is a hairline, the unknown day a mark; they must differ in shape, not only colour.
- Colour comes from tokens with a state meaning (`--state-*`, `--dash-strip-bar`, role colours through the existing edge mix); never a new palette. One hue per quantity; two quantities on one strip use shape (bar and tick), not two hues.
- Shape carries the meaning in forced-colours and in print: ring, dot, ring-dot, hatched.

## Interaction and text

- Every instrument has a text alternative: a visually hidden sentence or a `<table>` with `<caption>` and `th scope`, kept in sync from the same model the drawing uses (one pure function, unit-tested).
- A readout in place: hover or focus on a column updates one plain `<p>` under the strip (not a live region); arrow keys move the column, Enter or Space pins it (`aria-pressed`), Escape unpins. The group has one Tab stop (`useRovingFocus`) and a name ("Runs and cost per day, last 14 days").
- Numbers are mono (`--font-mono`, tabular). Dates through `lib/dates.ts`.
- A tooltip is never the only way to read a value.

## Sizing

- Instruments size from their container (container queries), never the window. Declare the minimum width at which labels appear and what drops first below it (labels, then weekday initials, then the readout).

## Checks before hand-off

- Unit tests for the pure model: scale choice, bar heights at the minimum, unknown / partial / zero encoding, label positions, the text alternative.
- e2e: column count, today marker, readout changes on ArrowLeft, cost never "$0.00" for an unknown day, measured height per size.
- Look at it in both themes at 1024x640 and 1600x1000 with a flat week, a spiky week and an empty week, and say which you saw.
