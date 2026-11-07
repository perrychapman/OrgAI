import type { ReactElement } from 'react'
import { X } from 'lucide-react'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import type { UsageChip } from '../../lib/usageOverview'

/**
 * The active filter chips (3.5): one per narrowing that is not the default, each with a remove button, then "Clear all
 * filters". Chips are plain list items; the page announces additions and removals through usage-live.
 */
export default function UsageChips({ chips, onRemove, onClear }: { chips: readonly UsageChip[]; onRemove: (chip: UsageChip) => void; onClear: () => void }): ReactElement | null {
  if (chips.length === 0) return null
  return (
    <ul className="usage-chips" data-testid="usage-chips" aria-label="Active filters">
      {chips.map((c) => (
        <li key={c.key} className="usage-chip" data-testid="usage-chip" data-kind={c.kind} data-chip={c.key} title={c.title}>
          <span className="usage-chip-text">{c.text}</span>
          <button type="button" className="usage-chip-remove" aria-label={c.removeLabel} data-testid="usage-chip-remove" data-chip={c.key} onClick={() => onRemove(c)}>
            <Icon icon={X} size="xs" />
          </button>
        </li>
      ))}
      <li className="usage-chips-clear">
        <Button variant="ghost" size="sm" onClick={onClear} testId="usage-clear-all">
          Clear all filters
        </Button>
      </li>
    </ul>
  )
}
