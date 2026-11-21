# Dashboard

The Dashboard is the person's home. It answers, in order: *what needs me, what is happening, what changed while I was away, where do I pick up*. The `DashboardPage` card shows the whole page.

## Reading order

1. **Briefing**: a hero card with the greeting, one status sentence, what changed since the last visit, the quick actions, **Team pulse** (the live org chart in miniature) and plan limits as gauges.
2. **Needs you**: every open decision, answerable inline. Drawn only when there is one.
3. **Right now**: open runs with their agents, plan progress and breathing marks. Drawn only while a run is open.
4. **Your week**: four stat cards with area sparklines, and the activity map of when the team worked. Each opens Usage.
5. **Pick up**: paused and recently ended runs that can be continued, newest first.
6. **Up next**: the next schedule firings.
7. **Projects**: pinned first, then by last activity.

From a 880 px container the work area is two columns: Needs you and Your week on the left, Right now on the right. From 1280 px, Pick up and Up next sit side by side. Under 880 px everything is one column in the order above.

## What is personal

| Choice | Where it shows | Default |
| --- | --- | --- |
| Display name | The Briefing greeting | None; the greeting is the time of day alone |
| Last visit | "Since yesterday 18:40: 4 runs finished, 1 failed" in the Briefing; the Recently ended marker | Kept already (`useLastSeen`) |
| Pinned projects | First in Projects with an `accent-border` edge; in the quick actions as "Continue <project>" | None |
| Section order and visibility | Your week, Pick up, Up next and Projects can be reordered or hidden from Customise | The order above, all shown |
| Focus figure | Which figure leads Your week (Spend, Runs, Agent time, Decisions) | Spend |

Needs you and Right now are never hidden or reordered.

## New

- **Briefing** replaces the one-line status bar with a hero card. The status sentence stays.
- **Team pulse**: every agent of the open runs as a node on its reporting line; working nodes breathe, messages travel the lines.
- **Activity map**: a 14-day by four-hour heatmap of when runs started.
- **Since you were last here**: a summary line built from the last-seen time the Dashboard already keeps.
- **Plan gauges**: the tightest plan window per connection as an arc with its reset time, instead of a 4 px bar.
- **Your week**: stat cards that open the Usage page on the same period.
- **Pick up**: one continue-first list. "Continue" sends the person to the composer of the newest run in that chain.
- **Up next**: the next schedule firings, with Pause all when schedules exist.
- **Pinned projects** and **Customise**.
- **Page arrival** and live motion as described in `motion.md`.

## Retired

- The status bar's app facts (version, Dev and Mock badges). They already show in the sidebar and in About.
- Separate **Paused** and **Recently ended** lists. Both are rows of Pick up, each with its state word.
- **To set up** as its own list. Setup gaps become a checklist line in the Briefing ("2 things to set up") that opens the same rows in a popover.
- The 14-day bar strip in both sizes. The activity map replaces it.

## Kept as is

- Inline answers and their safety rules: Allow once and Deny only, and only when the whole request is visible on the row.
- The 250 ms band snapshot, the caps per width, and the one polite live region.
- Project tile content: client, team marks, run caption, chips, cost only when something was spent.
- Every count of decisions comes from the same source as the bell.

## Needs new data

- The display name and the Customise choices need a place to be saved (an app setting for the name; per-install storage for layout).
- Up next reads the schedules the Schedules page already lists.
- The activity map needs run start times bucketed by local day and four-hour block.
- The "since" summary needs counts by outcome from run history since the last-seen time.
