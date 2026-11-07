# Terminal style

The terminal follows [the design specification](spec.md), its [visual refinement](ui-review-2.md),
and the current text colors in `src/renderer/src/styles/tokens.css`. The terminal equivalents live
in `src/cli/tui/theme.ts`; tests check token parity and text contrast in both themes.

| Element | Treatment |
| --- | --- |
| Logo | White on dark, dark ink on light; a brief violet sweep followed by a long quiet interval |
| Commands, selected controls, prompt marker | Violet accent text |
| Agent names | Bold, low-saturation brand tint; never a status hue |
| Active work | Blue glyph and state label; only thinking labels shimmer |
| Agent exchanges | Slate-blue direction marker, tinted sender/recipient, secondary body text |
| Tools, paths, code | Secondary ink; prefix and indentation distinguish them from prose |
| Success, attention, error | Green, amber, red respectively, always with words or glyphs |
| Conversation | Terminal foreground, with bold headings and restrained inline formatting |
| Input | Paired foreground and surface from the theme; readable secondary placeholders |

The logo sweep is an explicit brand exception to the otherwise work-only motion rule. It appears
only in the welcome/setup header, with one shared phase across the two logo rows. Menus, input
surfaces, completed work and message bodies remain still. There is no glow or gradient behind text.
Reduced motion, no color, screen readers, dumb terminals, inline mode and terminal suspension keep
the logo static. Meaningful secondary text uses a foreground token without an additional dim effect.

`ORGAI_THEME=dark` or `ORGAI_THEME=light` overrides `COLORFGBG`; dark is the fallback when the terminal
does not advertise its theme. `ORGAI_REDUCED_MOTION=1` disables animation. Layout follows terminal
dimensions, with plain text labels and selection markers preserved when styling is disabled.

Previews use the actual Ink components with simulated task events, rendered entirely offscreen:
[dark](../media/tui-team-dark.gif) and [light](../media/tui-team-light.gif).
