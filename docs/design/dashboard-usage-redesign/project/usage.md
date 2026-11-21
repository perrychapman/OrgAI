# Usage

The Usage page answers: *how much, on what, is it on pace, and where is it wasted*. The `UsagePage` card shows the whole page.

## Reading order

1. **Filter bar** (sticky): period, projects, kinds, and the chips line. Unchanged.
2. **Pacing**: a hero card with the period's spend as the page's one `figure`, the pace against the previous period, a burn dial of spend against the projection, and the plan or budget gauges.
3. **KPI band**: Estimated cost, Tokens, Runs, Wall time. Cost, Tokens and Runs choose the chart metric.
4. **Spend over time** beside **Where it went** (Project, Model, Role, Connection).
5. **Efficiency**: four measures, each with a one-line reading.
6. **Runs worth a look** beside **Cost by tier**.
7. **All runs**, closed.

From a 900 px container the hero row is two columns (chart 7, breakdown 5). Under 760 px the KPI band is two rows of two.

## New

- **Pacing header**. The figure counts up on arrival. The projection is a straight line from spend so far over elapsed time in the period, labelled "Projected" and shown only once a fifth of the period has passed and every run in it is priced; otherwise the line reads "Projection needs more data" or "Projection hidden: some usage is not priced".
- **Plan and budget gauges** on this page: each connection's tightest window, or a proxy's budget, as an arc with its reset time.
- **Readings** on Efficiency: each measure gets one plain sentence ("Reports overlap 1.8×: the team is working in parallel").
- **Spend over time as stacked areas** with a crosshair that follows the pointer or the arrow keys, replacing the stacked bars.
- **Ribbon and donut**: Where it went opens with a proportional ribbon; Cost by tier is a donut.
- **Draw motion**: areas wipe in, the dial and donut trace, ranked bars fill, figures count up, once per filter change the person makes.
- **Dashboard hand-off**: arriving from a Your week figure keeps that figure's metric pressed in the KPI band.

## Retired

- The closed **Definitions** section. Each definition moves to a tooltip on the label it defines.
- The Efficiency **More signals** disclosure. The four measures and their readings are the section; the remaining signals move into Runs worth a look as reasons.
- The separate hidden readout under the chart. The crosshair tooltip and the Table view carry the same values.

## Kept as is

- Every figure goes through the cost view: unknown is never `$0`, a lower bound reads `$0.42+`, the "N of M priced" chip stays on the Cost tile.
- Chart colours, their order and measured contrast; hatching for unpriced usage.
- Legend toggles, Compare with previous period, the crosshair, the Table button, CSV export.
- A row or segment click narrows the page and never scrolls it.
- Motion only on the person's own changes; a live run updating in the background tweens figures and nothing else.
