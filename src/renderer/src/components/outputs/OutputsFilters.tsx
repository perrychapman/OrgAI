import type { ReactElement, RefObject } from 'react'
import { useEffect, useId, useRef, useState } from 'react'
import { Search, X } from 'lucide-react'
import type { OutputKind } from '@shared/types'
import type { OutputsFilter, RunOption } from '../../lib/outputsList'
import { Icon } from '../ui/Icon'
import { IconButton } from '../ui/IconButton'
import { Select } from '../ui/Select'
import OutputKindIcon from './OutputKindIcon'

/** How long typing in the search box waits before the list filters. */
export const SEARCH_DEBOUNCE_MS = 150

/**
 * The Outputs tab's filter column (docs/design/outputs.md section 8): one `<form role="search">` with the search box
 * (Esc clears), kind chips for kinds in use, the run filter and the count line.
 */
export function OutputsFilters({
  filter,
  kinds,
  runs,
  countText,
  onChange,
  searchRef
}: {
  filter: OutputsFilter
  kinds: readonly { kind: OutputKind; label: string; count: number }[]
  runs: readonly RunOption[]
  countText: string
  onChange: (next: Partial<OutputsFilter>) => void
  searchRef?: RefObject<HTMLInputElement | null>
}): ReactElement {
  const uid = useId()
  const inner = useRef<HTMLInputElement | null>(null)
  const input = searchRef ?? inner
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
  const toggle = (kind: OutputKind): void => onChange({ kinds: filter.kinds.includes(kind) ? filter.kinds.filter((k) => k !== kind) : [...filter.kinds, kind] })
  // A run that left the list (every output of it forgotten) must not leave a filter nobody can see.
  const runValue = runs.some((r) => r.value === filter.runId) ? filter.runId : ''

  return (
    <form className="outputs-filters" role="search" aria-labelledby={`${uid}-title`} data-testid="outputs-filters" onSubmit={(e) => e.preventDefault()}>
      <h2 id={`${uid}-title`} className="outputs-filters-title">
        Show
      </h2>
      <div className="outputs-search">
        <label htmlFor={`${uid}-search`} className="sr-only">
          Search outputs
        </label>
        <span className="outputs-search-icon" aria-hidden="true">
          <Icon icon={Search} size="sm" />
        </span>
        <input
          id={`${uid}-search`}
          ref={input}
          className="input"
          type="search"
          value={text}
          placeholder="Title, file or role"
          autoComplete="off"
          spellCheck={false}
          data-testid="outputs-search"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && text) {
              e.preventDefault()
              e.stopPropagation()
              setQuery('', true)
            }
          }}
        />
        {text && (
          <span className="outputs-search-clear">
            <IconButton
              icon={X}
              size="sm"
              label="Clear search"
              testId="outputs-search-clear"
              onClick={() => {
                setQuery('', true)
                input.current?.focus()
              }}
            />
          </span>
        )}
      </div>
      <fieldset className="outputs-chips-set">
        <legend className="outputs-legend">Kind</legend>
        <div className="outputs-chips">
          <button type="button" className="outputs-chip" data-testid="outputs-kind-all" aria-pressed={filter.kinds.length === 0} onClick={() => onChange({ kinds: [] })}>
            All kinds
          </button>
          {kinds.map((k) => (
            <button key={k.kind} type="button" className="outputs-chip" data-testid="outputs-kind" data-kind={k.kind} aria-pressed={filter.kinds.includes(k.kind)} onClick={() => toggle(k.kind)}>
              <OutputKindIcon kind={k.kind} size="sm" />
              {k.label}
              <span className="outputs-chip-n"> {k.count}</span>
            </button>
          ))}
        </div>
      </fieldset>
      <div className="outputs-run-filter" data-testid="outputs-run-filter">
        <label htmlFor={`${uid}-run`} className="outputs-legend">
          Run
        </label>
        <Select id={`${uid}-run`} value={runValue} options={runs.map((r) => ({ value: r.value, label: r.label }))} onChange={(v) => onChange({ runId: v })} />
      </div>
      <p className="outputs-count" data-testid="outputs-count">
        {countText}
      </p>
    </form>
  )
}
