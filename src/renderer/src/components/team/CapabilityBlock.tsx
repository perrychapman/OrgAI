import type { ReactElement, ReactNode } from 'react'
import { Plus } from 'lucide-react'
import { Button } from '../ui/Button'

export type CapabilityKind = 'tools' | 'connections' | 'skills'

/**
 * One group of "What it can use": heading, one-line summary, the chips or rows, and the scoped Add control. An empty
 * group is one line: heading, muted "None yet" and the secondary Add button. `description` (what the group is) is the
 * heading's title text, so the long explanation stays out of the panel.
 */
export function CapabilityGroup({
  id,
  title,
  description,
  summary,
  helper,
  actions,
  empty,
  children,
  testId
}: {
  id: string
  title: string
  /** Longer explanation, shown as the heading's tooltip. */
  description?: string
  summary?: ReactNode
  helper?: string
  /** Right of the heading when the group has content (the "+ Add" or "Edit" button). */
  actions?: ReactNode
  /** Set when the group has nothing: one line with the secondary Add; replaces `children` and `actions`. */
  empty?: { addLabel: string; addTestId: string; onAdd: () => void }
  children?: ReactNode
  testId: string
}): ReactElement {
  return (
    <section className="role-cap-group" aria-labelledby={`${id}-title`} aria-describedby={description ? `${id}-desc` : undefined} data-testid={testId} data-empty={empty ? 'true' : undefined}>
      <div className="role-cap-head">
        <h4 className="side-section-title" id={`${id}-title`} title={description}>
          {title}
        </h4>
        {empty && <span className="role-cap-none">None yet</span>}
        {empty ? (
          <div className="role-cap-actions">
            <AddButton label={empty.addLabel} testId={empty.addTestId} onClick={empty.onAdd} />
          </div>
        ) : (
          actions && <div className="role-cap-actions">{actions}</div>
        )}
      </div>
      {description && (
        <span className="sr-only" id={`${id}-desc`}>
          {description}
        </span>
      )}
      {summary && !empty && <p className="role-cap-summary" data-testid={`${testId}-summary`}>{summary}</p>}
      {helper && !empty && <p className="hint">{helper}</p>}
      {!empty && children}
    </section>
  )
}

/** The secondary "+ Add" button of a non-empty group. */
export function AddButton({ label, testId, onClick }: { label: string; testId: string; onClick: () => void }): ReactElement {
  return (
    <Button size="sm" icon={Plus} ariaLabel={label} testId={testId} onClick={onClick}>
      Add
    </Button>
  )
}
