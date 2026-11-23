import type { ReactElement, ReactNode } from 'react'

export type ChipTone = 'neutral' | 'accent' | 'working' | 'warning' | 'success' | 'danger'

/**
 * Filter chip (UI overhaul, Components board): a native toggle button, 28 px, pill shaped. `selected` is announced
 * through aria-pressed and shown by fill and weight, never colour alone. `count` follows the label as text.
 */
export function Chip({
  selected,
  onClick,
  children,
  count,
  tone = 'neutral',
  disabled,
  className,
  'aria-label': ariaLabel,
  'data-testid': testId
}: {
  selected?: boolean
  onClick?: () => void
  children: ReactNode
  count?: number
  tone?: ChipTone
  disabled?: boolean
  className?: string
  'aria-label'?: string
  'data-testid'?: string
}): ReactElement {
  const cls = ['ui-chip', `tone-${tone}`, selected ? 'is-selected' : '', className ?? ''].filter(Boolean).join(' ')
  return (
    <button
      type="button"
      className={cls}
      aria-pressed={selected === undefined ? undefined : selected}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={onClick}
      data-testid={testId}
    >
      <span className="ui-chip-label">{children}</span>
      {count !== undefined && <span className="ui-chip-count tabular">{count}</span>}
    </button>
  )
}
