import type { ReactElement, ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { Plus } from 'lucide-react'
import { Popover } from '../ui/Popover'
import { Icon } from '../ui/Icon'

export interface ChooserItem {
  id: string
  label: string
  /** One plain-text line under the label (untrusted text is rendered as text only). */
  description?: string
  /** Leading mark, decorative. */
  lead?: ReactNode
}

/**
 * Scoped "+ Add" chooser for one group of the role's "What it can use": a popover list of what is not granted yet, plus
 * an optional footer action (for example a link to the Catalog). Choosing an item calls `onPick` and closes; the group
 * then moves focus to the new row. Esc closes and returns focus to the "+ Add" button (Popover).
 */
export function CapabilityChooser({
  label,
  buttonLabel = 'Add',
  items,
  emptyText,
  onPick,
  footer,
  testId
}: {
  /** Accessible name of the list, e.g. "Add a connection to Reviewer". */
  label: string
  buttonLabel?: string
  items: ChooserItem[]
  emptyText: string
  onPick: (id: string) => void
  footer?: { label: string; icon?: LucideIcon; onClick: () => void; testId?: string }
  testId?: string
}): ReactElement {
  return (
    <Popover
      label={label}
      trigger={
        <>
          <Icon icon={Plus} size="sm" />
          {buttonLabel}
        </>
      }
      triggerLabel={label}
      triggerClassName="btn sm"
      triggerTestId={testId}
      className="capability-chooser"
      placement="bottom-end"
    >
      {({ close }) => (
        <div className="capability-chooser-body">
          {items.length === 0 ? (
            <p className="hint capability-chooser-empty">{emptyText}</p>
          ) : (
            <ul className="capability-chooser-list" aria-label={label}>
              {items.map((it) => (
                <li key={it.id}>
                  <button
                    type="button"
                    className="capability-chooser-item"
                    data-testid="capability-chooser-item"
                    data-name={it.label}
                    onClick={() => {
                      onPick(it.id)
                      close()
                    }}
                  >
                    {it.lead}
                    <span className="capability-chooser-text">
                      <span className="capability-chooser-name">{it.label}</span>
                      {it.description && <span className="capability-chooser-desc">{it.description}</span>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {footer && (
            <button
              type="button"
              className="capability-chooser-item capability-chooser-footer"
              data-testid={footer.testId}
              onClick={() => {
                footer.onClick()
                close()
              }}
            >
              {footer.icon && <Icon icon={footer.icon} size="sm" />}
              <span className="capability-chooser-name">{footer.label}</span>
            </button>
          )}
        </div>
      )}
    </Popover>
  )
}
