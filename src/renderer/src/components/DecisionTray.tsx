import type { ReactElement, ReactNode } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { decisionFocus } from './DecisionCard'
import { IconButton } from './ui/IconButton'

export interface DecisionItem {
  key: string
  /** Short action text for the list ("Run npm test", "Question"). Rendered as plain text, never as markup. */
  label: string
  node: ReactNode
}

/**
 * The open decisions of a run: when there are several, a list of all of them (one chip each, with a count and
 * previous/next) above the selected card. The cards come through unchanged; only one is mounted at a time, so a
 * card never loses its draft text because a sibling arrived. `onPin` fires on the first touch inside the card.
 */
export default function DecisionTray({
  items,
  selected,
  onSelect,
  onPin
}: {
  items: DecisionItem[]
  selected: number
  onSelect: (index: number) => void
  onPin: () => void
}): ReactElement | null {
  if (items.length === 0) return null
  const go = (to: number): void => {
    decisionFocus.suppress = true
    onSelect(to)
  }
  const current = items[selected] ?? items[items.length - 1]
  return (
    <>
      {items.length > 1 && (
        <div className="decision-stepper" role="group" aria-label="Pending decisions">
          <span className="decision-stepper-title">
            Decisions <span className="decision-count">{items.length}</span>
          </span>
          <ul className="decision-list">
            {items.map((it, i) => (
              <li key={it.key}>
                <button
                  type="button"
                  className="decision-chip"
                  aria-current={i === selected ? 'true' : undefined}
                  title={it.label}
                  onClick={() => go(i)}
                >
                  <span className="decision-chip-n">{i + 1}</span>
                  <span className="decision-chip-label">{it.label}</span>
                </button>
              </li>
            ))}
          </ul>
          <span className="decision-steps">
            <IconButton icon={ChevronLeft} label="Previous decision" size="sm" disabled={selected === 0} onClick={() => go(selected - 1)} />
            <span aria-live="polite">
              {selected + 1} of {items.length}
            </span>
            <IconButton icon={ChevronRight} label="Next decision" size="sm" disabled={selected === items.length - 1} onClick={() => go(selected + 1)} />
          </span>
        </div>
      )}
      <div key={current.key} className="decision" onPointerDownCapture={onPin} onKeyDownCapture={onPin}>
        {current.node}
      </div>
    </>
  )
}
