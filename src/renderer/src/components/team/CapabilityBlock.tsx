import type { ReactElement, ReactNode } from 'react'
import { Plus } from 'lucide-react'
import { Button } from '../ui/Button'

export type CapabilityKind = 'tools' | 'connections' | 'skills'

/**
 * One group of "What it can use": heading, one-line summary, the chips or rows, and the scoped Add control. An empty
 * group swaps the secondary "+ Add" for a primary action plus an "Ask the Team assistant" link, so the user never has
 * to leave to act.
 */
export function CapabilityGroup({
  id,
  title,
  summary,
  helper,
  actions,
  empty,
  children,
  testId
}: {
  id: string
  title: string
  summary?: ReactNode
  helper?: string
  /** Right of the heading when the group has content (the "+ Add" or "Edit" button). */
  actions?: ReactNode
  /** Set when the group has nothing: replaces `children` and `actions`. */
  empty?: { text: string; primaryLabel: string; primaryTestId: string; onPrimary: () => void; onAsk?: () => void }
  children?: ReactNode
  testId: string
}): ReactElement {
  return (
    <section className="role-cap-group" aria-labelledby={`${id}-title`} data-testid={testId}>
      <div className="role-cap-head">
        <h4 className="side-section-title" id={`${id}-title`}>
          {title}
        </h4>
        {!empty && actions && <div className="role-cap-actions">{actions}</div>}
      </div>
      {summary && !empty && <p className="role-cap-summary" data-testid={`${testId}-summary`}>{summary}</p>}
      {helper && <p className="hint">{helper}</p>}
      {empty ? (
        <div className="role-cap-empty">
          <p className="hint">{empty.text}</p>
          <div className="role-cap-empty-actions">
            <Button variant="primary" size="sm" icon={Plus} testId={empty.primaryTestId} onClick={empty.onPrimary}>
              {empty.primaryLabel}
            </Button>
            {empty.onAsk && (
              <button type="button" className="mcp-link" onClick={empty.onAsk} data-testid="role-ask-assistant">
                <span className="mcp-link-text">Ask the Team assistant</span>
              </button>
            )}
          </div>
        </div>
      ) : (
        children
      )}
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
