# Motion inventory (pre-walk)

Date 2026-11-07. Scope: every renderer surface except Outputs internals. Inventory only, no fixes.

## Method and limits

Source inventory: grep of `src/renderer/src/styles` for `transition`, `animation`, `@keyframes`, `@starting-style`,
`view-transition`, and a read of the tokens and reduced-motion blocks. I did NOT drive the built app for this pass
(no screenshots, no frame timing), so "abrupt" below is inferred from the absence of any transition or animation
rule on the element or its container, not seen. Nothing was checked by eye at 1024x640 / 1600x1000, in light or dark,
or with the keyboard. A follow-up walk should confirm the High items before specs are written.

## What exists today

Tokens (`tokens.css`): `--dur-fast` 100ms, `--dur-base` 160ms, `--dur-slow` 260ms, `--ease-out`
cubic-bezier(.2,.8,.2,1), `--ease-in-out`, `--dur-pulse` 1800ms. Several rules ignore them (`ease`, `80ms`, `120ms`,
`1.4s` literals).

Keyframes (12 in total): `breathe` (global; opacity .45-1, scale .97-1.03; used with 1s, 1.4s, 1.5s, 1.6s periods in
five places: run.css 114 and 260, run-tabs 133, shell 81 and 451, ui 362), `spin`, `ripple`, `blink`, `pop-in`
(0.94 scale + fade, 260ms), `dash-breathe` (1800ms), `dash-row-in` (fade + 4px rise, 160ms), `dash-row-fade`,
`dash-strip-grow` (260ms), `msg-dots` (3s, message edges), `neural-card-in` (80ms), `skill-flash` (1.8s, new skill row
highlight).

Transitions (about 30 rules, almost all colour or border only): buttons (bg, border, transform at 100ms), run node
(border, shadow, opacity at 160ms), hex fill, resize handle (bg and grip opacity), usage bars (width 260ms),
chevrons on two disclosures (canvas Customise, mcp, settings: rotate 100ms), editor input focus, tile hover.

Reduced motion: honoured well. `prefers-reduced-motion` and `[data-reduce-motion='on']` both force
0.01ms durations and single iteration globally, spinners and skeletons stop, and the dashboard marks, strip, flow edges
and neural card carry their own overrides. No motion found that escapes it. Gap to check: JS-driven motion
(neural graph engine, React Flow `fitView` duration, scrollIntoView, `scrollTo` behaviour) is not covered by CSS.

## What is missing (nothing animates)

No `@starting-style`, no view transitions, no exit animations anywhere (the dashboard comment states "rows never
animate out"), no `::backdrop` rule, no dialog or popover enter/exit.

## By surface

| Surface | State change | Animates now | Abrupt | Priority |
|---|---|---|---|---|
| Sidebar full to rail | grid column 232px to 56px, labels vanish | nothing (grid-template-columns not transitioned) | whole shell snaps; labels pop | High |
| Sidebar resize handle | drag | handle grip fades 120ms | fine (drag is direct) | Low |
| Project list, assistants group | select, collapse client group | hover bg only | group collapse snaps; selection indicator jumps | Medium |
| Account popover, all popovers/menus (`popover=auto`) | open/close | none | pop-in, no exit | High (frequent) |
| Topbar tabs | switch Live/History/Team/Settings | none visible | underline jumps; view swaps with no cross-fade | High |
| Dashboard Needs you | row arrives or leaves | none found | rows pop in, leaving rows vanish and reflow siblings | High |
| Dashboard Right now band | agent rows | `dash-row-in` 160ms for new agent rows; marks breathe 1800ms | rows never animate out; band appearing/hiding (`data-now-empty`) snaps and the grid reflows | Medium |
| Activity strip | load | `dash-strip-grow` 260ms bars | readout change on focus is instant (fine) | Low |
| Project tiles | hover, status change | border/bg 100ms | tile status caption swap, tile insertion, "Show N more" reveal snaps | Medium |
| New project dialog | open, kind radio swaps fields, Repo panel, clone progress | none | open pops; field swap changes height abruptly (layout shift); sticky action block appears | High |
| Confirm dialogs, shortcuts dialog, all `Dialog`s | open/close | none | pop, no backdrop fade | High |
| Run tabs | open/close/switch tab, new run "+" | tab status dot breathes 1.4s | tab insert/remove snaps, selected underline jumps | Medium |
| Canvas nodes | node appears | `pop-in` 260ms scale+fade; border/shadow 160ms | edges appear instantly with the node; repositioning after layout (new agent shifts siblings) is a jump, not a glide | High |
| Done-group fold/expand | agents fold into group, expand | none (no transition on node position) | children vanish and group appears in one frame; refit jumps | High |
| Decision tray cards | card arrives, resolves | no tray motion found | arrives with no cue (users miss it); resolve removes instantly; stage height changes when tray fills (layout shift) | High |
| Side panel tabs, collapse to rail | tab swap, collapse | none | content swaps, panel snaps in/out | Medium |
| Side panel resize | drag | none (direct) | fine; composer move at 480px (`data-side-wide`) snaps | Low |
| Transcript rows | rows stream | none | rows pop in; scroll-follow is instant; "Jump to latest" appears abruptly | High |
| Composer | focus, send, ended-state swap | focus ring only | send clears with no feedback; notice appears snap | Medium |
| Conversation/agents layout toggle | switch | none | whole stage swaps | Medium |
| History | rows, sessions toggle, Trends | hover | member rows expand instantly; Trends charts/bars: usage bars width 260ms only | Medium |
| Team tab | role panel open, Catalog, disclosures | skill-flash 1.8s on new skill; chevrons 100ms | role panel slides in? no; panel and `details` content open instantly; dialogs pop | Medium |
| Settings | pane switch, Advanced disclosure, switches | chevron rotate 100ms | pane content swaps; disclosure height jumps; switch thumb: no transition found in grep (verify) | Medium |
| Knowledge list | rows, detail panel | none | selection and panel open snap; retire/delete notice appears abruptly | Medium |
| Knowledge graph | settle, recall pulses, card | canvas engine pulses; `neural-card-in` 80ms | List/Graph switch snaps | Low |
| Connectors gallery and dialogs | filter, tile state, highlight | 2s `data-highlight` (state) | grid reorders on filter instantly; dialog pops | Medium |
| Assistants start pages | chips fill field, examples | none | page swaps | Low |
| Banners and notices (Banner, tray-announce, run-tabs notice, import/undo notices) | appear/dismiss | none | pop in, vanish; push content down (layout shift) | High (frequent) |
| Toasts | none exist | n/a | n/a | n/a |
| Focus transitions (keyboard) | focus ring | `--ring` box-shadow, mostly static | ring appears instantly; roving focus in tiles/listbox has no motion (acceptable) | Low |
| Spinners and saving | spin 0.8-1.6s | yes | `save-indicator` fine | Low |

## Existing motion that feels wrong or inconsistent

1. `breathe` has five different periods (1s, 1.4s, 1.5s, 1.6s) next to the 1800ms `--dur-pulse` dashboard breathe;
   several live cues on one screen pulse out of phase. Run.css:260 at 1s is the most agitated.
2. `pop-in` (scale 0.94) on every canvas node replays on remount (view switch, refit, fold) so a whole tree
   re-pops, which reads as flicker instead of "new".
3. `skill-flash` 1.8s is long.
4. Literal durations bypass tokens: `neural-card-in` 80ms, layout.css 120ms fallback, `ease` instead of `--ease-out`.
5. Max-width of the motion vocabulary: transforms and colour only; nothing uses height/size transitions.

## Top 15 opportunities, ranked

1. Dialog and popover enter/exit: fade + 4-6px rise (160ms) and a backdrop fade, using `@starting-style` and
   `transition-behavior: allow-discrete` on `dialog` / `[popover]`. Every surface uses one.
2. Decision tray: slide/fade in a new card and a one-time attention cue on the Needs-you bell; animate resolve.
3. Needs you rows and Banners/notices: enter with `dash-row-in`, exit with a short fade plus height collapse so siblings glide.
4. Sidebar full/rail: transition `grid-template-columns` (var(--dur-slow)), fade labels.
5. Canvas layout glide: animate node position changes (`transform` transition on React Flow nodes) so new agents, folds
   and layout switches move instead of jump; keep `pop-in` only for truly new ids.
6. Done-group fold/expand: crossfade children into the group chip, and animate edges.
7. Transcript rows: short fade/rise on new rows (cap per frame), smooth scroll-follow, animated "Jump to latest".
8. Topbar tab underline slide and a 120ms view cross-fade on tab switch.
9. Disclosures (`details`, Advanced settings, Customise, sessions toggle): animate height with `interpolate-size` /
   `::details-content`.
10. New project dialog: animate height when kind or setup choice swaps fields; fade the clone progress block.
11. Run tabs: insert/remove width + fade, sliding selected indicator.
12. Side panel: slide on collapse/expand and a 120ms tab content crossfade.
13. Dashboard band show/hide and "Show N more": height/opacity reveal instead of grid snap.
14. Switch thumbs, checkbox ticks, radio dots: confirm and add 100ms transitions (grep found none for switches).
15. Unify live cues: one breathe period (`--dur-pulse`) and token-only durations; keep the reduced-motion block.

## Guardrails for whoever specs this

Use tokens only; exits at most 120ms; no looping motion except live agents and spinners; stagger at most 6 items;
JS motion (React Flow fit duration, scroll) must read `useReducedMotion`; add e2e checks that
`data-reduce-motion='on'` gives computed `animation-duration` 0.01ms and no layout shift at 1024x640.
