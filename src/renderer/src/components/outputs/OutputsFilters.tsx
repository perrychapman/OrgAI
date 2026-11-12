import type { KeyboardEvent, ReactElement } from 'react'
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
/** The roving key of the "All kinds" chip (no kind id looks like this). */
const ALL_CHIP = '*'

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

  // ---- the kind chips are one Tab stop: a roving tabindex that starts on the pressed chip (All kinds when none) ----
  const chipRefs = useRef(new Map<string, HTMLButtonElement>())
  const setChipRef = (key: string, el: HTMLButtonElement | null): void => {
    if (el) chipRefs.current.set(key, el)
    else chipRefs.current.delete(key)
  }
  const chipKeys = [ALL_CHIP, ...kinds.map((k) => k.kind as string)]
  const [roving, setRoving] = useState<string | null>(null)
  const defaultStop = kinds.find((k) => filter.kinds.includes(k.kind))?.kind ?? ALL_CHIP
  const stop = roving && chipKeys.includes(roving) ? roving : defaultStop
  const onChipKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.altKey || e.ctrlKey || e.metaKey) return
    const at = chipKeys.indexOf((e.target as HTMLElement).closest<HTMLElement>('button')?.dataset.testid === 'outputs-kind-all' ? ALL_CHIP : ((e.target as HTMLElement).closest<HTMLElement>('button')?.dataset.kind ?? ''))
    if (at < 0) return
    let to = -1
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') to = (at + 1) % chipKeys.length
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') to = (at - 1 + chipKeys.length) % chipKeys.length
    else if (e.key === 'Home') to = 0
    else if (e.key === 'End') to = chipKeys.length - 1
    if (to < 0) return
    e.preventDefault()
    setRoving(chipKeys[to])
    chipRefs.current.get(chipKeys[to])?.focus()
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
      <div className="outputs-chips-set">
        <span id={`${uid}-kind`} className="outputs-legend">
          Kind
        </span>
        <div role="toolbar" aria-labelledby={`${uid}-kind`} aria-orientation="horizontal" className="outputs-chips" data-testid="outputs-kinds" onKeyDown={onChipKey}>
          <button
            type="button"
            ref={(el) => setChipRef(ALL_CHIP, el)}
            className="outputs-chip"
            data-testid="outputs-kind-all"
            aria-pressed={filter.kinds.length === 0}
            tabIndex={stop === ALL_CHIP ? 0 : -1}
            onFocus={() => setRoving(ALL_CHIP)}
            onClick={() => onChange({ kinds: [] })}
          >
            All kinds
          </button>
          {kinds.map((k) => (
            <button
              key={k.kind}
              type="button"
              ref={(el) => setChipRef(k.kind, el)}
              className="outputs-chip"
              data-testid="outputs-kind"
              data-kind={k.kind}
              aria-pressed={filter.kinds.includes(k.kind)}
              tabIndex={stop === k.kind ? 0 : -1}
              title={kindLabel(k.kind)}
              onFocus={() => setRoving(k.kind)}
              onClick={() => toggleKind(k.kind)}
            >
              <OutputKindIcon kind={k.kind} size="xs" />
              {k.label}
              <span className="outputs-chip-n"> {k.count}</span>
            </button>
          ))}
        </div>
      </div>
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
