---
name: better-accessibility
description: "Accessibility rules and review format for OrgAI's renderer: native elements, focus, keyboard paths, names, live regions, motion, contrast. Use when building or reviewing interactive UI, dialogs, cards, forms or dynamic status text, or when walking a screen by keyboard."
---

# Accessibility

Most accessibility is free if you use the platform. Native elements ship with keyboard support, real labels announce themselves and a visible focus ring is one CSS rule. When unsure, take the platform default over a custom rebuild, and remove ARIA rather than add it.

Reviewing means two walks. Keyboard-only, where every flow completes without a mouse. Then a check that every control exposes a name, a role and its state, read from the accessibility tree.

## In OrgAI

- Start from `components/ui`: `IconButton` requires `label`, `Button` takes `ariaLabel`, and `Dialog` and `ConfirmDialog` with `useConfirm` handle dialogs. Do not rebuild them.
- Composite grids use `useRovingFocus` (one Tab stop, arrow keys).
- Honor both `prefers-reduced-motion` and `data-reduce-motion="on"`.
- A frame's card errors speak through its one `tray-announce` (`useFrameAnnounce`). Do not add a second live region beside it.
- Colors come from tokens, so a contrast check covers both themes.
- This is a desktop app. Check it at 1024x640 and 1600x1000. Report 320 px reflow and browser zoom as `Not verified` unless you tested them.

The resource files below may name `better-colors`, `better-typography`, `better-layout` or `better-interface`. Those skills are not installed here, so apply the rules in this file instead.

## Native elements first

The first rule of ARIA: don't use ARIA when a native element exists. `<button>` for actions, `<a href>` for navigation, never `<div onClick>`. See [semantics-and-aria.md](semantics-and-aria.md).

## Visible focus rings

Style `:focus-visible`, not bare `:focus`. A custom ring needs a focus token. Verify it against every adjacent color it crosses, at least a `2px` solid perimeter or an equivalent visible area. Never use `outline: none` without a verified replacement, and preserve system colors in forced-colors mode. Recipes are in [focus-and-keyboard.md](focus-and-keyboard.md).

## Full keyboard support

Every pointer interaction needs a keyboard path. Escape closes overlays, arrow keys move within composite widgets, Tab moves between widgets, Enter and Space activate. Use only `tabindex="0"` and `tabindex="-1"`; positive values break the order.

## Trap and restore focus

Modals set `inert` on the background, move focus inside on open and return focus to the trigger on close. When an element that holds focus disappears, move focus somewhere sensible.

## Minimum hit area

The WCAG 2.5.8 Level AA baseline is a 24x24 CSS-pixel target or one of its exceptions. Aim for 40x40 on desktop where density permits, and extend with a pseudo-element when the visible element should stay smaller. Extended hit areas must not overlap. See [hit-areas.md](hit-areas.md).

## Label every control

Every input gets a `<label for>` or a wrapping `<label>`. A placeholder is never a label. Never block paste; users paste keys and tokens. See [forms.md](forms.md).

## Errors that announce

Keep submit enabled until the request starts. Validate on submit, mark failing fields `aria-invalid="true"`, point `aria-describedby` at the inline error and focus the first invalid field. Use native `disabled` when a control is unavailable. Use `aria-disabled="true"` only when it must stay focusable, and then block its behavior in code.

## Accessible names

Icon-only buttons need a descriptive name. Visible label text must appear in the accessible name. Decorative elements get `aria-hidden="true"`, never on a focusable element.

## Don't rely on color alone

Status needs a redundant cue: an icon or text alongside the color. Measure the rendered pair: 4.5:1 for normal text, 3:1 for large text and UI components. When a pair fails, report it and the requirement it misses, and leave the colors alone unless asked.

## Motion

Under reduced motion, replace slides and scales with opacity crossfades and drop autoplay. Toasts carrying an action or an error stay until dismissed. See [motion-and-zoom.md](motion-and-zoom.md).

## Announce dynamic content

`aria-describedby` carries field validation. A polite live region (`role="status"`) carries non-urgent updates such as result counts. `role="alert"` carries urgent errors and nothing else. Repeated polite announcements need a stable empty region rendered before its text updates. See [screen-readers.md](screen-readers.md).

## Alt text and structure

Decorative images get `alt=""`, informative images describe the meaning, functional images describe the action. Headings form a coherent outline without skipped levels, with one primary `<main>` landmark.

## Reporting

**Severity.** `HIGH` prevents a task, hides content from assistive technology, or is a systemic failure. `MEDIUM` makes an interaction meaningfully harder. `LOW` is isolated polish.

**Verification.** Without running the app: accessible names, keyboard handlers on non-native controls, focus styles, motion guards and bound labels. With it (see `run-desktop`): tab the flow in order, read names and roles from the accessibility tree, and confirm a visible focus indicator at every stop. Report every check you could not run as `Not verified`.

**Format.** One row per root cause, ordered by severity, listing every location:

| Severity | Location | Before | After | Why |
| --- | --- | --- | --- | --- |

`Location` is `path/to/file:line`. `Why` names the principle and the user impact.

End with `Block` when any `HIGH` remains, `Approve` otherwise. Never `Approve` coverage you did not inspect. With nothing to report, state "No actionable accessibility findings" and report what you verified.
