import type { ReactElement, ReactNode, RefObject } from 'react'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { Search, SlidersHorizontal, X } from 'lucide-react'
import type { ItemOrigin, KnowledgeFilter } from '../../lib/knowledge'
import { NOTE_KIND } from '../../lib/knowledge'
import { Icon } from '../ui/Icon'
import { IconButton } from '../ui/IconButton'
import { Popover } from '../ui/Popover'
import { Switch } from '../ui/Switch'
import { KindMark } from './KindMark'

/** How long typing in the search box waits before the list filters (spec 2). */
export const SEARCH_DEBOUNCE_MS = 150
/** Band width under which You, Agents, Show retired and Inferred links move into "More filters" (graph-2 section 1.2). */
export const BAND_COMPACT_PX = 720

/** "More filters" / "More filters, 2 on". */
export function moreFiltersLabel(on: number): string {
  return on > 0 ? `More filters, ${on} on` : 'More filters'
}

/**
 * The Knowledge tab's filters: a column beside the list (docs/design/knowledge.md section 2) or, in Graph view, a chip
 * band above the canvas (docs/design/knowledge-graph-2.md section 1.2). One `<form role="search">` in both layouts, so
 * the same chips stay in the DOM when the view switches. In the band Notes has no chip (notes are not drawn), "Show",
 * "Kind" and "Recorded by" are for screen readers only, and under 720 px of band You, Agents, Show retired and Inferred
 * links sit in a "More filters" popover.
 */
export function KnowledgeFilters({
  domId,
  layout,
  filter,
  kinds,
  origins,
  onChange,
  countText,
  hiddenNew,
  onShowNew,
  showInferred,
  onShowInferred,
  searchRef
}: {
  domId: string
  layout: 'band' | 'column'
  filter: KnowledgeFilter
  kinds: readonly { kind: string; label: string; count: number }[]
  origins: Record<ItemOrigin, number>
  onChange: (next: Partial<KnowledgeFilter>) => void
  countText: string
  /** Items a live run recorded that the filters hide (0 = no "Show new"). */
  hiddenNew: number
  onShowNew: () => void
  /** The Graph view's "Inferred links" switch (band only). */
  showInferred: boolean
  onShowInferred: (on: boolean) => void
  searchRef?: RefObject<HTMLInputElement | null>
}): ReactElement {
  const uid = useId()
  const band = layout === 'band'
  const formRef = useRef<HTMLFormElement>(null)
  const innerSearch = useRef<HTMLInputElement | null>(null)
  // Clear search always lands in the box (its own button is about to go).
  const searchInput = searchRef ?? innerSearch
  const [text, setText] = useState(filter.query)
  const timer = useRef<number | undefined>(undefined)
  const [narrow, setNarrow] = useState(false)
  const compact = band && narrow
  // A query cleared elsewhere ("Clear search" in the empty state) empties the box too.
  useEffect(() => {
    if (filter.query === '') setText('')
  }, [filter.query])
  useEffect(() => () => window.clearTimeout(timer.current), [])

  // The band's width decides which controls are inline (a container query cannot unmount the duplicates).
  useLayoutEffect(() => {
    const el = formRef.current
    if (!el || !band) return undefined
    const measure = (): void => setNarrow(el.clientWidth < BAND_COMPACT_PX)
    measure()
    if (typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [band])
  // Controls that moved into the popover took focus with them: land it on More filters instead of the page.
  const wasFocused = useRef<string | null>(null)
  useLayoutEffect(() => {
    if (!compact) return
    const id = wasFocused.current
    wasFocused.current = null
    if (id) formRef.current?.querySelector<HTMLElement>('[data-testid=knowledge-filters-more]')?.focus()
  }, [compact])
  useEffect(() => {
    const el = formRef.current
    if (!el) return undefined
    const onFocusIn = (e: FocusEvent): void => {
      const t = e.target as HTMLElement | null
      wasFocused.current = t?.closest('[data-moves]') ? (t.getAttribute('data-testid') ?? 'x') : null
    }
    el.addEventListener('focusin', onFocusIn)
    return () => el.removeEventListener('focusin', onFocusIn)
  }, [])

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
  const originChips = (
    <>
      <button type="button" className="knowledge-chip" data-testid="knowledge-origin" data-origin="user" aria-pressed={filter.origins.includes('user')} onClick={() => toggleOrigin('user')}>
        You<span className="knowledge-chip-n"> {origins.user}</span>
      </button>
      <button type="button" className="knowledge-chip" data-testid="knowledge-origin" data-origin="agent" aria-pressed={filter.origins.includes('agent')} onClick={() => toggleOrigin('agent')}>
        Agents<span className="knowledge-chip-n"> {origins.agent}</span>
      </button>
    </>
  )
  const retiredSwitch = (
    <div className="knowledge-switch-row">
      <span className="knowledge-switch-label">Show retired</span>
      <Switch checked={filter.showRetired} label="Show retired" testId="knowledge-show-retired" onChange={(v) => onChange({ showRetired: v })} />
    </div>
  )
  const inferredSwitch = (
    <div className="knowledge-switch-row">
      <span className="knowledge-switch-label">Inferred links</span>
      <Switch checked={showInferred} label="Inferred links" testId="knowledge-inferred-links" onChange={onShowInferred} />
    </div>
  )
  const moreOn = filter.origins.length + (filter.showRetired ? 1 : 0) + (showInferred ? 1 : 0)
  const shownKinds = band ? kinds.filter((k) => k.kind !== NOTE_KIND) : kinds
  const mark = (kind: string): ReactNode => (kind === NOTE_KIND ? <span className="knowledge-kind-mark knowledge-note-dot" data-testid="knowledge-kind-mark" data-mark="dot" aria-hidden="true" /> : <KindMark kind={kind} />)

  return (
    <form
      ref={formRef}
      id={domId}
      className="knowledge-filters"
      role="search"
      aria-labelledby={`${uid}-title`}
      data-testid="knowledge-filters"
      data-layout={layout}
      data-compact={compact ? 'true' : 'false'}
      tabIndex={-1}
      onSubmit={(e) => e.preventDefault()}
    >
      <h2 id={`${uid}-title`} className={band ? 'knowledge-filters-title sr-only' : 'knowledge-filters-title'}>
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
          ref={searchInput}
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
                searchInput.current?.focus()
              }}
            />
          </span>
        )}
      </div>
      {band && !compact && (
        <>
          <fieldset className="knowledge-chips-set knowledge-origins" data-moves="true">
            <legend className="knowledge-legend sr-only">Recorded by</legend>
            <div className="knowledge-chips">{originChips}</div>
          </fieldset>
          <div className="knowledge-inline-switch" data-moves="true">
            {retiredSwitch}
          </div>
          <div className="knowledge-inline-switch" data-moves="true">
            {inferredSwitch}
          </div>
        </>
      )}
      {compact && (
        <Popover
          trigger={
            <>
              <Icon icon={SlidersHorizontal} size="sm" />
              {moreFiltersLabel(moreOn)}
            </>
          }
          triggerClassName="btn sm"
          triggerTestId="knowledge-filters-more"
          label="More filters"
          placement="bottom-start"
          className="knowledge-more-panel"
          testId="knowledge-filters-more-panel"
        >
          <fieldset className="knowledge-chips-set">
            <legend className="knowledge-legend">Recorded by</legend>
            <div className="knowledge-chips">{originChips}</div>
          </fieldset>
          {retiredSwitch}
          {inferredSwitch}
        </Popover>
      )}
      <fieldset className="knowledge-chips-set knowledge-kinds">
        <legend className={band ? 'knowledge-legend sr-only' : 'knowledge-legend'}>Kind</legend>
        <div className="knowledge-chips">
          <button type="button" className="knowledge-chip" data-testid="knowledge-kind-all" aria-pressed={filter.kinds.length === 0} onClick={() => onChange({ kinds: [] })}>
            All kinds
          </button>
          {shownKinds.map((k) => (
            <button key={k.kind} type="button" className="knowledge-chip" data-testid="knowledge-kind" data-kind={k.kind} aria-pressed={filter.kinds.includes(k.kind)} onClick={() => toggleKind(k.kind)}>
              {mark(k.kind)}
              {k.label}
              <span className="knowledge-chip-n"> {k.count}</span>
            </button>
          ))}
        </div>
      </fieldset>
      {!band && (
        <>
          <fieldset className="knowledge-chips-set">
            <legend className="knowledge-legend">Recorded by</legend>
            <div className="knowledge-chips">{originChips}</div>
          </fieldset>
          {retiredSwitch}
        </>
      )}
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
