import type { ReactElement, ReactNode } from 'react'

/**
 * The Knowledge filter chip: the same markup and classes as `ui/Chip` (so the look is the shared one), plus the kind
 * mark before the label and the `data-kind` / `data-origin` hooks the tab's scripts select by (`ui/Chip` takes only a
 * test id). A native toggle button: `selected` is announced through aria-pressed and shown by fill, edge and weight.
 */
export function KnowledgeChip({
  selected,
  onClick,
  mark,
  count,
  testId,
  kind,
  origin,
  children
}: {
  selected: boolean
  onClick: () => void
  /** A decorative mark (KindMark) in front of the label. */
  mark?: ReactNode
  count?: number
  testId: string
  kind?: string
  origin?: string
  children: ReactNode
}): ReactElement {
  return (
    <button type="button" className={`ui-chip tone-neutral knowledge-chip${selected ? ' is-selected' : ''}`} aria-pressed={selected} data-testid={testId} data-kind={kind} data-origin={origin} onClick={onClick}>
      {mark}
      <span className="ui-chip-label">{children}</span>
      {count !== undefined && <span className="ui-chip-count tabular"> {count}</span>}
    </button>
  )
}
