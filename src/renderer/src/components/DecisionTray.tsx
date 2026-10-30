import type { ReactElement, ReactNode } from 'react'
import type { KeyboardEvent } from 'react'
import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { decisionFocus } from './DecisionCard'
import { Icon } from './ui/Icon'

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
  const listRef = useRef<HTMLUListElement>(null)
  // Keep the selected chip in view when stepping with Previous/Next.
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[aria-current="true"]')?.scrollIntoView?.({ inline: 'nearest', block: 'nearest' })
  }, [selected, items.length])
  // The chips are one Tab stop (roving tabindex): the focused chip, else the selected one.
  const [focused, setFocused] = useState<number | null>(null)
  if (items.length === 0) return null
  const rover = Math.min(focused ?? selected, items.length - 1)
  const onChipKey = (e: KeyboardEvent<HTMLButtonElement>, i: number): void => {
    const to = e.key === 'ArrowRight' ? Math.min(i + 1, items.length - 1) : e.key === 'ArrowLeft' ? Math.max(i - 1, 0) : e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : -1
    if (to < 0) return
    e.preventDefault()
    setFocused(to)
    listRef.current?.querySelectorAll<HTMLElement>('.decision-chip')[to]?.focus()
  }
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
          <ul
            className="decision-list"
            ref={listRef}
            onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(null)
            }}
          >
            {items.map((it, i) => (
              <li key={it.key}>
                <button
                  type="button"
                  className="decision-chip"
                  aria-current={i === selected ? 'true' : undefined}
                  aria-label={`Decision ${i + 1}: ${it.label}`}
                  title={it.label}
                  tabIndex={i === rover ? 0 : -1}
                  onFocus={() => setFocused(i)}
                  onKeyDown={(e) => onChipKey(e, i)}
                  onClick={() => go(i)}
                >
                  <span className="decision-chip-n">{i + 1}</span>
                  <span className="decision-chip-label">{it.label}</span>
                </button>
              </li>
            ))}
          </ul>
          <span className="decision-steps">
            <button
              type="button"
              className="icon-btn size-sm"
              aria-label="Previous decision"
              title="Previous decision"
              aria-disabled={selected === 0 || undefined}
              onClick={() => {
                if (selected > 0) go(selected - 1)
              }}
            >
              <Icon icon={ChevronLeft} size="sm" />
            </button>
            <span>
              {selected + 1} of {items.length}
            </span>
            <button
              type="button"
              className="icon-btn size-sm"
              aria-label="Next decision"
              title="Next decision"
              aria-disabled={selected === items.length - 1 || undefined}
              onClick={() => {
                if (selected < items.length - 1) go(selected + 1)
              }}
            >
              <Icon icon={ChevronRight} size="sm" />
            </button>
          </span>
        </div>
      )}
      <div key={current.key} className="decision" onPointerDownCapture={onPin} onKeyDownCapture={onPin}>
        {current.node}
      </div>
    </>
  )
}
