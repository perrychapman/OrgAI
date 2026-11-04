import type { ReactElement, RefObject } from 'react'
import { useEffect, useId, useRef, useState } from 'react'
import { Search, X } from 'lucide-react'
import type { ItemOrigin, KnowledgeFilter } from '../../lib/knowledge'
import { Icon } from '../ui/Icon'
import { IconButton } from '../ui/IconButton'
import { Switch } from '../ui/Switch'

/** How long typing in the search box waits before the list filters (spec 2). */
export const SEARCH_DEBOUNCE_MS = 150

/**
 * The Knowledge tab's filter column (docs/design/knowledge.md section 2): search, kind chips with counts, origin chips,
 * the "Show retired" switch and the count line with "Show new". A `<form role="search">` headed "Show" (rec 14).
 */
export function KnowledgeFilters({
  domId,
  filter,
  kinds,
  origins,
  onChange,
  countText,
  hiddenNew,
  onShowNew,
  searchRef
}: {
  domId: string
  filter: KnowledgeFilter
  kinds: readonly { kind: string; label: string; count: number }[]
  origins: Record<ItemOrigin, number>
  onChange: (next: Partial<KnowledgeFilter>) => void
  countText: string
  /** Items a live run recorded that the filters hide (0 = no "Show new"). */
  hiddenNew: number
  onShowNew: () => void
  searchRef?: RefObject<HTMLInputElement | null>
}): ReactElement {
  const uid = useId()
  const [text, setText] = useState(filter.query)
  const timer = useRef<number | undefined>(undefined)
  // A query cleared elsewhere ("Clear search" in the empty state) empties the box too.
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
  const toggleKind = (kind: string): void => {
    const on = filter.kinds.includes(kind)
    onChange({ kinds: on ? filter.kinds.filter((k) => k !== kind) : [...filter.kinds, kind] })
  }
  const toggleOrigin = (origin: ItemOrigin): void => {
    const on = filter.origins.includes(origin)
    onChange({ origins: on ? filter.origins.filter((o) => o !== origin) : [...filter.origins, origin] })
  }

  return (
    <form id={domId} className="knowledge-filters" role="search" aria-labelledby={`${uid}-title`} data-testid="knowledge-filters" tabIndex={-1} onSubmit={(e) => e.preventDefault()}>
      <h2 id={`${uid}-title`} className="knowledge-filters-title">
        Show
      </h2>
      <div className="knowledge-search">
        <label htmlFor={`${uid}-search`} className="sr-only">
          Search
        </label>
        <span className="knowledge-search-icon" aria-hidden="true">
          <Icon icon={Search} size="sm" />
        </span>
        <input
          id={`${uid}-search`}
          ref={searchRef}
          className="input"
          type="search"
          value={text}
          placeholder="Name, fact or note"
          autoComplete="off"
          spellCheck={false}
          data-testid="knowledge-search"
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
          <span className="knowledge-search-clear">
            <IconButton
              icon={X}
              size="sm"
              label="Clear search"
              testId="knowledge-search-clear"
              onClick={() => {
                setQuery('', true)
                searchRef?.current?.focus()
              }}
            />
          </span>
        )}
      </div>
      <fieldset className="knowledge-chips-set">
        <legend className="knowledge-legend">Kind</legend>
        <div className="knowledge-chips">
          <button type="button" className="knowledge-chip" data-testid="knowledge-kind-all" aria-pressed={filter.kinds.length === 0} onClick={() => onChange({ kinds: [] })}>
            All kinds
          </button>
          {kinds.map((k) => (
            <button key={k.kind} type="button" className="knowledge-chip" data-testid="knowledge-kind" data-kind={k.kind} aria-pressed={filter.kinds.includes(k.kind)} onClick={() => toggleKind(k.kind)}>
              {k.label}
              <span className="knowledge-chip-n"> {k.count}</span>
            </button>
          ))}
        </div>
      </fieldset>
      <fieldset className="knowledge-chips-set">
        <legend className="knowledge-legend">Recorded by</legend>
        <div className="knowledge-chips">
          <button type="button" className="knowledge-chip" data-testid="knowledge-origin" data-origin="user" aria-pressed={filter.origins.includes('user')} onClick={() => toggleOrigin('user')}>
            You<span className="knowledge-chip-n"> {origins.user}</span>
          </button>
          <button type="button" className="knowledge-chip" data-testid="knowledge-origin" data-origin="agent" aria-pressed={filter.origins.includes('agent')} onClick={() => toggleOrigin('agent')}>
            Agents<span className="knowledge-chip-n"> {origins.agent}</span>
          </button>
        </div>
      </fieldset>
      <div className="knowledge-switch-row">
        <span className="knowledge-switch-label">Show retired</span>
        <Switch checked={filter.showRetired} label="Show retired" testId="knowledge-show-retired" onChange={(v) => onChange({ showRetired: v })} />
      </div>
      <p className="knowledge-count" data-testid="knowledge-count">
        <span>{countText}</span>
        {hiddenNew > 0 && (
          <button type="button" className="link-btn" data-testid="knowledge-show-new" onClick={onShowNew}>
            Show new
          </button>
        )}
      </p>
    </form>
  )
}
