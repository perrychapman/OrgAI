import type { ReactElement } from 'react'
import { Button } from '../ui/Button'
import { Chip } from '../ui/Chip'
import { Select } from '../ui/Select'
import { FILTER_LABEL, summaryText, type InboxFilter, type InboxFilters } from '../../lib/inbox'

/**
 * The Inbox header: the title, the summary (the same numbers as the sidebar badge and the Needs-you popover), one chip
 * per kind present, the project filter and "Answer in order". Chips are native toggles in a labelled group.
 */
export default function InboxHeader({
  waitingCount,
  finishedCount,
  counts,
  projects,
  filters,
  canAnswer,
  onFilters,
  onAnswerInOrder
}: {
  waitingCount: number
  finishedCount: number
  counts: { all: number; kinds: { filter: InboxFilter; count: number }[] }
  projects: { id: string; name: string; count: number }[]
  filters: InboxFilters
  canAnswer: boolean
  onFilters: (f: InboxFilters) => void
  onAnswerInOrder: () => void
}): ReactElement {
  const any = counts.all > 0
  return (
    <header className="inbox-header">
      <h1 className="inbox-title" tabIndex={-1}>Inbox</h1>
      <span className="inbox-summary" data-testid="inbox-summary" data-waiting={waitingCount} data-finished={finishedCount}>
        {summaryText(waitingCount, finishedCount)}
      </span>
      {any && (
        <div className="inbox-chips" role="group" aria-label="Show" data-testid="inbox-chips">
          <Chip selected={filters.filter === 'all'} count={counts.all} data-testid="inbox-chip-all" onClick={() => onFilters({ ...filters, filter: 'all' })}>
            All
          </Chip>
          {counts.kinds.map((k) => (
            <Chip key={k.filter} selected={filters.filter === k.filter} count={k.count} data-testid={`inbox-chip-${k.filter}`} onClick={() => onFilters({ ...filters, filter: k.filter })}>
              {FILTER_LABEL[k.filter]}
            </Chip>
          ))}
        </div>
      )}
      <span className="inbox-header-gap" />
      {projects.length > 1 && (
        <Select
          label="Project"
          value={filters.project}
          onChange={(project) => onFilters({ ...filters, project })}
          options={[{ value: 'all', label: 'All projects' }, ...projects.map((p) => ({ value: p.id, label: `${p.name} (${p.count})` }))]}
        />
      )}
      {canAnswer && (
        <Button variant="primary" size="sm" testId="inbox-answer-order" onClick={onAnswerInOrder}>
          Answer in order
        </Button>
      )}
    </header>
  )
}
