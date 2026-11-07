import type { ReactElement } from 'react'
import { useEffect, useId, useRef, useState } from 'react'
import { Search } from 'lucide-react'
import type { OutputKind } from '@shared/types'
import { kindLabel } from '../../lib/outputs'
import type { KindCount, OutputsFilter } from '../../lib/outputsList'
import { Icon } from '../ui/Icon'
import { Input } from '../ui/Input'
import { Select } from '../ui/Select'
import OutputKindIcon from './OutputKindIcon'

/** How long typing in the search box waits before the list filters. */
const SEARCH_DEBOUNCE_MS = 150

/**
 * The Outputs tab's filter column (docs/design/outputs.md section 8): one `<form role="search">` with the search box,
 * the kind chips (kinds in use, counted over the other filters), the run filter and the count line. The announcement
 * of the count is the view's one status region.
 */
export function OutputsFilters({
  filter,
  kinds,
  runs,
  countText,
  onChange
}: {
  filter: OutputsFilter
  kinds: readonly KindCount[]
  runs: readonly { value: string; label: string }[]
  countText: string
  onChange: (next: Partial<OutputsFilter>) => void
}): ReactElement {
  const uid = useId()
  const [text, setText] = useState(filter.query)
  const timer = useRef<number | undefined>(undefined)
  // A query cleared elsewhere ("Clear the filters") empties the box too.
  useEffect(() => {
    if (filter.query === '') setText('')
  }, [filter.query])
  useEffect(() => () => window.clearTimeout(timer.current), [])

  const setQuery = (value: string, atOnce = false): void => {
    setText(value)
    window.clearTimeout(timer.current)
    if (atOnce) onChange({ query: value })
    else timer.current = window.setTimeout(() => onChange({ query: value }), SEARCH_DEBOUNCE_MS)
  }
  const toggleKind = (kind: OutputKind): void => {
    const on = filter.kinds.includes(kind)
    onChange({ kinds: on ? filter.kinds.filter((k) => k !== kind) : [...filter.kinds, kind] })
  }

  return (
    <form className="outputs-filters" role="search" aria-labelledby={`${uid}-title`} data-testid="outputs-filters" onSubmit={(e) => e.preventDefault()}>
      <h2 id={`${uid}-title`} className="outputs-filters-title">
        Show
      </h2>
      <div className="outputs-search">
        <label htmlFor={`${uid}-search`} className="sr-only">
          Search
        </label>
        <span className="outputs-search-icon" aria-hidden="true">
          <Icon icon={Search} size="sm" />
        </span>
        <Input
          id={`${uid}-search`}
          type="search"
          value={text}
          placeholder="Title, file, kind or role"
          autoComplete="off"
          spellCheck={false}
          data-testid="outputs-search"
          onChange={(v) => setQuery(v)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && text) {
              e.preventDefault()
              e.stopPropagation()
              setQuery('', true)
            }
          }}
        />
      </div>
      <fieldset className="outputs-chips-set">
        <legend className="outputs-legend">Kind</legend>
        <div className="outputs-chips">
          <button type="button" className="outputs-chip" data-testid="outputs-kind-all" aria-pressed={filter.kinds.length === 0} onClick={() => onChange({ kinds: [] })}>
            All kinds
          </button>
          {kinds.map((k) => (
            <button key={k.kind} type="button" className="outputs-chip" data-testid="outputs-kind" data-kind={k.kind} aria-pressed={filter.kinds.includes(k.kind)} title={kindLabel(k.kind)} onClick={() => toggleKind(k.kind)}>
              <OutputKindIcon kind={k.kind} size="xs" />
              {k.label}
              <span className="outputs-chip-n"> {k.count}</span>
            </button>
          ))}
        </div>
      </fieldset>
      <div className="outputs-run-filter">
        <label htmlFor={`${uid}-run`} className="outputs-legend">
          Run
        </label>
        <span data-testid="outputs-run-filter">
          <Select id={`${uid}-run`} value={filter.runId} options={[{ value: '', label: 'All runs' }, ...runs]} onChange={(runId) => onChange({ runId })} />
        </span>
      </div>
      <p className="outputs-count" data-testid="outputs-count">
        {countText}
      </p>
    </form>
  )
}
