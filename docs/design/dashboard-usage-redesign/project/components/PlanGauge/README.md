A plan window or budget as an arc with its percentage and reset time.

**Provide:** the percentage used, the window or budget name, the reset or amount line, and the level.

- The arc uses `brand-ui-from`; from 80% it turns `warning`, and `danger` when limited. The percentage text changes to the matching text colour, so the level never lives in the arc alone.
- Show the tightest window per connection, at most two gauges, then "+N more".
- Hidden for API keys and wherever the provider reports nothing.
- On arrival the arc traces clockwise and the percentage counts up.
