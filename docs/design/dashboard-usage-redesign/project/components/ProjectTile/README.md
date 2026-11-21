A project as a tile: name, team, the state of its latest run, folder and spend.

**Provide:** the project's name, client or team size, up to eight role colours, the latest run's state word and caption, the folder name, the spend if any, and whether it is pinned.

- Tiles sit on `surface-2` and never take a state tint.
- A pinned tile has an `accent-border` edge and an `accent-faint` wash, and sorts first.
- The whole tile opens the project; the pin is a separate button after it in tab order.
- Hover lifts the tile 2 px with `elev-1`.
- Show the cost only when something was spent.
- On arrival tiles rise with at most six stagger steps.
