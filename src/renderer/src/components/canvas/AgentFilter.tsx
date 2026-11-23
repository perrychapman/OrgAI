import type { ReactElement } from 'react'
import { useId } from 'react'
import type { AgentCounts, AgentFilterValue } from '../../lib/canvasAgents'
import '../../styles/canvas-chrome.css'

const OPTIONS: { value: AgentFilterValue; label: string; count: (c: AgentCounts) => number }[] = [
  { value: 'all', label: 'All', count: (c) => c.all },
  { value: 'working', label: 'Working', count: (c) => c.working },
  { value: 'waiting', label: 'Waiting', count: (c) => c.waiting }
]

/**
 * The canvas toolbar's "Show" group: All N, Working N, Waiting N (Waiting in amber). A native radio group (arrow keys
 * move, Tab enters), so the choice and the counts are spoken: "Waiting 1". A filter that is on but whose count has
 * dropped to zero stays selectable, so the group never changes under the user's hand. `Done` is a valid value of
 * AgentFilterValue for the list, but the toolbar offers the three the board draws.
 */
export function AgentFilter({ value, onChange, counts }: { value: AgentFilterValue; onChange: (value: AgentFilterValue) => void; counts: AgentCounts }): ReactElement {
  const name = useId()
  return (
    <div className="agent-filter" role="radiogroup" aria-label="Show agents" data-testid="agent-filter">
      {OPTIONS.map((o) => (
        <label key={o.value} className="agent-filter-item" data-value={o.value} data-on={value === o.value || undefined}>
          <input type="radio" name={name} value={o.value} checked={value === o.value} onChange={() => onChange(o.value)} data-testid={`agent-filter-${o.value}`} />
          <span>{o.label}</span>
          <span className="agent-filter-count">{o.count(counts)}</span>
        </label>
      ))}
    </div>
  )
}
