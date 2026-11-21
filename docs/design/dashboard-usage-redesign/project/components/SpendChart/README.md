Stacked bars of the chosen metric over time, with a metric switch, legend toggles and a crosshair tooltip.

**Provide:** buckets with a value per series, the series order, the chosen metric, and which series are hidden.

- Stacked areas, largest series at the bottom.

- Series take `chart-s1` to `chart-s5` in order, then `chart-other`. Segments are separated by a 1 px `chart-hatch` gap.
- Unpriced usage is hatched in `chart-unknown` and never drawn as zero.
- A crosshair follows the pointer; with focus on the plot, Left and Right move it a bucket, Home and End jump to the ends. The tooltip and the value text name the date, the total and each series.
- A legend chip toggles its series; a hidden series is struck through with a hollow swatch.
- The Table button shows the same numbers as a table.
- The areas wipe in left to right, once per filter change the person makes.
