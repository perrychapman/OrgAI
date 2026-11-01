import type { ReactElement } from 'react'
import type { CapabilityGap, Role } from '@shared/types'
import { clampText } from '../../lib/capabilities'
import { Button } from '../ui/Button'

/** What the team still lacks, with no apply of its own. Text is the assistant's (untrusted), shown as plain text. */
export function CapabilityGaps({
  gaps,
  roles,
  onDismiss,
  onAsk
}: {
  gaps: CapabilityGap[]
  roles: Role[]
  onDismiss: (index: number) => void
  /** Open the Architect to describe the need. */
  onAsk?: () => void
}): ReactElement | null {
  if (gaps.length === 0) return null
  return (
    <section className="capability-gaps" aria-labelledby="capability-gaps-title" data-testid="capability-gaps">
      <h3 className="side-section-title" id="capability-gaps-title">
        Gaps
      </h3>
      <ul className="capability-gap-list">
        {gaps.map((g, i) => {
          const role = roles.find((r) => r.id === g.roleId)
          return (
            <li key={`${g.roleId}-${i}`} className="capability-gap" data-testid="capability-gap">
              <span className="capability-gap-text">
                {role && <strong>{clampText(role.name, 40)}: </strong>}
                {clampText(g.need)}
              </span>
              <span className="row gap-2">
                {onAsk && (
                  <Button size="sm" variant="ghost" onClick={onAsk}>
                    Ask the Architect
                  </Button>
                )}
                <Button size="sm" variant="ghost" ariaLabel={`Dismiss gap: ${clampText(g.need, 60)}`} onClick={() => onDismiss(i)}>
                  Dismiss
                </Button>
              </span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
