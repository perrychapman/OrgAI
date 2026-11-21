import { useId, type FocusEvent, type KeyboardEvent, type PointerEvent, type ReactElement, type ReactNode } from 'react'

/**
 * A definition on the label it defines (docs/design/dashboard-usage-redesign usage.md: the closed Definitions section is
 * retired). The tip is a `role="tooltip"` element that the label describes (`aria-describedby`), so a screen reader
 * reads it with the label; it shows on hover and on keyboard focus, and Esc hides it until the pointer or focus leaves
 * (WCAG 1.4.13: dismissible, hoverable, persistent). It is never the only way to read a value: it holds a definition only.
 */

/** Esc hides the tip of the closest host until pointer or focus leaves it. */
export const tipHandlers = {
  onKeyDown: (e: KeyboardEvent<HTMLElement>): void => {
    if (e.key !== 'Escape') return
    const host = e.currentTarget.closest<HTMLElement>('[data-tip-host]')
    if (host && !host.dataset.tipOff) host.dataset.tipOff = 'true'
  },
  onBlur: (e: FocusEvent<HTMLElement>): void => {
    const host = e.currentTarget.closest<HTMLElement>('[data-tip-host]')
    if (host && !host.contains(e.relatedTarget as Node | null)) delete host.dataset.tipOff
  },
  onPointerLeave: (e: PointerEvent<HTMLElement>): void => {
    const host = e.currentTarget.closest<HTMLElement>('[data-tip-host]')
    if (host && !host.matches(':focus-within')) delete host.dataset.tipOff
  }
}

/** The tooltip element itself; the label or tile that it defines points at it with aria-describedby={id}. */
export function DefinitionTip({ id, text, className }: { id: string; text: string; className?: string }): ReactElement {
  return (
    <span id={id} role="tooltip" className={className ? `usage-term-tip ${className}` : 'usage-term-tip'} data-testid="usage-term-tip">
      {text}
    </span>
  )
}

/**
 * A label that carries its definition: one keyboard stop (tabIndex 0, so the tip is reachable without a pointer),
 * the definition read as its description. Use inside a `dt` or a heading line; `align="end"` opens the tip leftwards
 * for a label near the right edge.
 */
export default function DefinedTerm({
  text,
  children,
  align = 'start',
  testId = 'usage-term'
}: {
  text: string
  children: ReactNode
  align?: 'start' | 'end'
  testId?: string
}): ReactElement {
  const id = useId()
  return (
    <span className="usage-term-host" data-tip-host="" data-align={align} onPointerLeave={tipHandlers.onPointerLeave} onBlur={tipHandlers.onBlur}>
      <span className="usage-term" tabIndex={0} aria-describedby={id} data-testid={testId} onKeyDown={tipHandlers.onKeyDown}>
        {children}
      </span>
      <DefinitionTip id={id} text={text} />
    </span>
  )
}
