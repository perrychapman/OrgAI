---
name: frontend-design
description: "OrgAI's renderer design rules: tokens, shared components, layout regions, copy, both themes and the window sizes to check. Use when building or changing any React component, view, style or user-facing text in src/renderer, or when specifying a screen in docs/design."
---

# OrgAI frontend design

OrgAI has an established visual system. Extend it and do not introduce a new aesthetic. Read the relevant file in `docs/design/` first (`spec.md`, plus the feature's own doc), and `.orgai/ARCHITECTURE.md` under Theme layer, UI primitives, Renderer UI and Conventions.

## Build with what exists

- Controls: `src/renderer/src/components/ui` (Button, IconButton, Input, Textarea, Select, Checkbox, Switch, SegmentedControl, Dialog, ConfirmDialog with `useConfirm`, Popover, Tabs, Badge, Banner, SettingRow, EmptyState, Cost, Icon). Check here before writing a new control. `IconButton` requires `label`; `Button` takes `ariaLabel`.
- Layout: `components/layout` (`CanvasFrame` with `FrameToolbar`, `FrameStage`, `FrameTray`, `FrameFooter`; `SidePanel`; `ResizeHandle`). Responsive behaviour comes from container queries on layout regions.
- Radix and react-resizable-panels are not installed. A new dependency needs a real reason and an exact pinned version.

## Styling

- Tokens only, from `styles/tokens.css`: never hardcode hex colors, shadows, radii, font sizes or z-indexes.
- A new color token goes in every theme block in `tokens.css` (dark, light and the `prefers-color-scheme` system block). `styles/tokens.test.ts` checks the file.
- Fonts are the `--font-sans` and `--font-mono` stacks. The CSP allows fonts only from `'self'` and `data:`, and images likewise, so remote fonts and images will not load.
- Hierarchy comes from the type scale, weight and spacing, not uppercase micro-labels. Use sentence case and at most one primary action per region.
- Icons are lucide-react through `Icon`, never Unicode glyphs.
- Appearance comes through `<html>` attributes and CSS vars set by `lib/theme.ts`. Views never read appearance settings. For a resolved color in a prop (React Flow), use `lib/useCssVar.ts`.
- Motion must respect both `prefers-reduced-motion` and `data-reduce-motion="on"`.

## Structure rules

- Nothing floats over the React Flow canvas except its own controls. Decision cards go in `FrameTray`; banners and notices go in layout regions.
- No `div` or `span` with `onClick`, and no native `confirm()`.
- Scroll inside settings with `lib/scrollWithin.ts`, never `scrollIntoView`, so the window does not shift.

## Words and values

- Run status words come only from `lib/runStatus.ts`, and agent end labels from `activity.ts`. Do not invent synonyms.
- Every cost goes through `lib/cost.ts` `costView` and `ui/Cost.tsx`. An unknown cost is never shown as $0.
- "Needs you" counts decisions, through `lib/needsYou.ts`.
- Use plain words in connector flows: service, sign in, can read, can read and change.
- Vendor specifics stay out of the renderer, which only consumes normalized events.

## Before you hand off

- Look at the result in dark and light, at 1024x640 and 1600x1000.
- Every control works by keyboard with a visible `:focus-visible` ring. See `better-accessibility`.
- Add `data-testid` hooks for new surfaces and update e2e selectors in the same change.
- Say which states you looked at and which you did not: empty, loading, error, long text, narrow panel.
