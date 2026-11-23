import type { ReactElement, ReactNode } from 'react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Chip } from '../ui/Chip'
import { useRovingFocus } from '../connectors/useRovingFocus'

/**
 * Gallery with a detail panel (ui-overhaul Providers, Tools, Skills and Templates boards): a search field and filter
 * chips, one or more titled sections of glass tiles, and a glass aside describing the selected tile. Tiles are native
 * buttons with aria-pressed (selected) and aria-controls (the aside); the whole grid is one tab stop with arrow keys,
 * Home and End (useRovingFocus), and Enter / Space selects. Selecting never moves focus; when the aside sits below the
 * grid (narrow widths) it is scrolled into view, without smooth scrolling under reduced motion.
 *
 * Callers own the data: pass real items only (never sample data). Anything interactive inside a tile other than the
 * select button (a switch, a menu) goes in `trailing`, rendered beside the button rather than inside it.
 */

export type GalleryTone = 'ok' | 'warn' | 'off' | 'info' | 'danger' | 'working'

export interface GalleryItem {
  id: string
  name: string
  /** Section id from `sections`. */
  section: string
  /** Filter id from `filters` ('all' always matches). */
  filter?: string
  /** One line under the name ("Code · all projects"). */
  tag?: ReactNode
  /** One or two lines describing what it does. */
  summary?: ReactNode
  /** Status line with a coloured dot; the text carries the state, never the colour alone. */
  status?: { text: string; tone: GalleryTone }
  /** Leading mark: a logo or an initial; defaults to the name's first letter on a neutral tile. */
  mark?: ReactNode
  /** Extra text the search matches (name, tag text and summary text should be included by the caller if wanted). */
  searchText?: string
  /** Dashed outline: an "add your own" tile. */
  dashed?: boolean
  /** Shown at reduced emphasis (turned off). */
  dimmed?: boolean
  /** Controls beside the select button (a switch); positioned top right of the tile. */
  trailing?: ReactNode
  testId?: string
  /** Extra data-* attributes on the tile (e2e hooks such as data-provider), keys without the "data-" prefix. */
  data?: Record<string, string>
}

export interface GallerySection {
  id: string
  label: ReactNode
  note?: ReactNode
  /** Buttons on the section's title row (Add proxy). */
  actions?: ReactNode
  /** Shown (and the section kept) when it has no tiles; without it an empty section is hidden. */
  emptyNote?: ReactNode
  /** Heading id (a focus target after a removal) and test id. */
  headingId?: string
  headingTestId?: string
  /** Shown under the title row, e.g. a limit reason. */
  footnote?: ReactNode
}

export interface GalleryFilter {
  id: string
  label: string
}

export function SettingsGallery({
  label,
  items,
  sections,
  filters,
  searchLabel,
  searchPlaceholder,
  selected,
  onSelect,
  renderDetail,
  empty,
  toolbar,
  testId
}: {
  /** Accessible name of the gallery region (the aside is "<label>: <item name>"). */
  label: string
  items: GalleryItem[]
  sections: GallerySection[]
  filters?: GalleryFilter[]
  searchLabel?: string
  searchPlaceholder?: string
  /** Selected item id; null or a missing id shows the first visible item. */
  selected: string | null
  onSelect: (id: string) => void
  /** The aside's content for the selected item (use the Detail* parts below). */
  renderDetail: (item: GalleryItem) => ReactNode
  /** Shown instead of the sections when nothing matches. */
  empty?: ReactNode
  /** Extra controls on the search row (right side). */
  toolbar?: ReactNode
  testId?: string
}): ReactElement {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')
  const grid = useRef<HTMLDivElement>(null)
  const aside = useRef<HTMLElement>(null)
  const roving = useRovingFocus(grid, '.settings-gallery-pick')
  const asideId = useId()
  const searchId = useId()

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return items.filter((i) => {
      if (filter !== 'all' && i.filter !== filter) return false
      if (!q) return true
      return `${i.name} ${i.searchText ?? ''}`.toLowerCase().includes(q)
    })
  }, [items, query, filter])

  const current = visible.find((i) => i.id === selected) ?? items.find((i) => i.id === selected) ?? visible[0] ?? null

  // Keep the parent's selection in step when it points at nothing (first load, a removed item).
  useEffect(() => {
    if (current && current.id !== selected) onSelect(current.id)
  }, [current, selected, onSelect])

  const pick = (id: string): void => {
    onSelect(id)
    const el = aside.current
    if (!el) return
    const box = el.getBoundingClientRect()
    if (box.top > window.innerHeight - 80 || box.bottom < 0) {
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.dataset.reduceMotion === 'on'
      el.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' })
    }
  }

  const shownSections = sections
    .map((s) => ({ ...s, cards: visible.filter((i) => i.section === s.id) }))
    .filter((s) => s.cards.length > 0 || (s.emptyNote !== undefined && !query.trim() && filter === 'all'))

  return (
    <div className="settings-gallery" data-testid={testId}>
      <div className="settings-gallery-main" role="region" aria-label={label}>
        <div className="settings-gallery-tools">
          {searchLabel && (
            <>
              <label className="sr-only" htmlFor={searchId}>
                {searchLabel}
              </label>
              <input
                id={searchId}
                className="input settings-gallery-search"
                type="search"
                value={query}
                placeholder={searchPlaceholder ?? searchLabel}
                onChange={(e) => setQuery(e.target.value)}
                data-testid={testId ? `${testId}-search` : undefined}
              />
            </>
          )}
          {filters && filters.length > 1 && (
            <div className="settings-gallery-chips" role="group" aria-label="Filter">
              {[{ id: 'all', label: 'All' }, ...filters].map((f) => (
                <Chip key={f.id} selected={filter === f.id} onClick={() => setFilter(f.id)} data-testid={testId ? `${testId}-filter-${f.id}` : undefined}>
                  {f.label}
                </Chip>
              ))}
            </div>
          )}
          {toolbar && <div className="settings-gallery-toolbar">{toolbar}</div>}
        </div>
        <div ref={grid} className="settings-gallery-sections" onKeyDown={roving.onKeyDown} onFocus={roving.onFocus}>
          {shownSections.every((s) => s.cards.length === 0 && s.emptyNote === undefined) && (empty ?? <p className="settings-gallery-empty">Nothing matches.</p>)}
          {shownSections.map((s) => (
            <section key={s.id} className="settings-gallery-section" aria-labelledby={s.headingId ?? `${asideId}-${s.id}`}>
              <div className="settings-gallery-section-head">
                <h3 id={s.headingId ?? `${asideId}-${s.id}`} className="settings-gallery-section-title" tabIndex={s.headingId ? -1 : undefined} data-testid={s.headingTestId}>
                  {s.label}
                </h3>
                {s.note && <span className="settings-gallery-section-note">{s.note}</span>}
                {s.actions && <span className="settings-gallery-section-actions">{s.actions}</span>}
              </div>
              {s.footnote}
              {s.cards.length === 0 && s.emptyNote}
              {s.cards.length > 0 && (
              <ul className="settings-gallery-grid" role="list">
                {s.cards.map((i) => {
                  const isSel = current?.id === i.id
                  return (
                    <li
                      key={i.id}
                      className={`settings-gallery-tile glass motion-lift${isSel ? ' is-selected' : ''}${i.dashed ? ' is-dashed' : ''}${i.dimmed ? ' is-dimmed' : ''}${i.trailing ? ' has-trailing' : ''}`}
                      data-testid={i.testId}
                      {...Object.fromEntries(Object.entries(i.data ?? {}).map(([k, v]) => [`data-${k}`, v]))}
                    >
                      <button
                        type="button"
                        className="settings-gallery-pick"
                        aria-pressed={isSel}
                        aria-controls={`${asideId}-aside`}
                        onClick={() => pick(i.id)}
                      >
                        <span className="settings-gallery-tile-head">
                          <span className="settings-gallery-mark" aria-hidden="true">
                            {i.mark ?? i.name.slice(0, 1).toUpperCase()}
                          </span>
                          <span className="settings-gallery-names">
                            <span className="settings-gallery-name" title={i.name}>
                              {i.name}
                            </span>
                            {i.tag && <span className="settings-gallery-tag">{i.tag}</span>}
                          </span>
                        </span>
                        {i.summary && <span className="settings-gallery-summary">{i.summary}</span>}
                        {i.status && <GalleryStatus status={i.status} />}
                      </button>
                      {i.trailing && <div className="settings-gallery-trailing">{i.trailing}</div>}
                    </li>
                  )
                })}
              </ul>
              )}
            </section>
          ))}
        </div>
      </div>
      {current && (
        <aside
          ref={aside}
          id={`${asideId}-aside`}
          className="settings-gallery-aside glass"
          aria-label={`${label}: ${current.name}`}
          data-testid={testId ? `${testId}-detail` : undefined}
        >
          {renderDetail(current)}
        </aside>
      )}
    </div>
  )
}

export function GalleryStatus({ status }: { status: { text: string; tone: GalleryTone } }): ReactElement {
  return (
    <span className={`settings-gallery-status tone-${status.tone}`}>
      <span className={`settings-gallery-dot${status.tone === 'warn' ? ' motion-breathe' : ''}`} aria-hidden="true" />
      {status.text}
    </span>
  )
}

/** Aside header: mark, name (h3) and tag line. */
export function DetailHeader({ mark, name, tag, actions }: { mark?: ReactNode; name: string; tag?: ReactNode; actions?: ReactNode }): ReactElement {
  return (
    <div className="settings-detail-head">
      <span className="settings-gallery-mark is-large" aria-hidden="true">
        {mark ?? name.slice(0, 1).toUpperCase()}
      </span>
      <div className="settings-detail-names">
        <h3 className="settings-detail-name">{name}</h3>
        {tag && <div className="settings-detail-tag">{tag}</div>}
      </div>
      {actions}
    </div>
  )
}

/** Tinted note with a status dot: what this is doing right now, in one or two sentences. */
export function DetailNote({ tone, children, testId }: { tone: GalleryTone; children: ReactNode; testId?: string }): ReactElement {
  return (
    <div className={`settings-detail-note tone-${tone}`} data-testid={testId}>
      <span className="settings-gallery-dot" aria-hidden="true" />
      <div>{children}</div>
    </div>
  )
}

export type DetailMark = 'can' | 'cannot' | 'plain'

/**
 * A titled list ("The team can", "The team cannot"). Each mark is drawn (check, cross, dot) and also spoken: the
 * list's title names it, and the marks are aria-hidden.
 */
export function DetailList({
  title,
  mark,
  items,
  testId
}: {
  title: string
  mark: DetailMark
  items: { text: ReactNode; side?: ReactNode; key?: string }[]
  testId?: string
}): ReactElement | null {
  if (items.length === 0) return null
  return (
    <div className="settings-detail-block" data-testid={testId}>
      <div className="settings-detail-label">{title}</div>
      <ul className={`settings-detail-list mark-${mark}`}>
        {items.map((it, n) => (
          <li key={it.key ?? n}>
            <span className="settings-detail-mark" aria-hidden="true">
              {mark === 'can' ? '✓' : mark === 'cannot' ? '×' : '·'}
            </span>
            <span className="settings-detail-text">{it.text}</span>
            {it.side && <span className="settings-detail-side">{it.side}</span>}
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Label / value rows ("Signed in as", "Pays through"). */
export function DetailFacts({ rows, testId }: { rows: { label: string; value: ReactNode }[]; testId?: string }): ReactElement | null {
  if (rows.length === 0) return null
  return (
    <dl className="settings-detail-facts" data-testid={testId}>
      {rows.map((r) => (
        <div key={r.label} className="settings-detail-fact">
          <dt>{r.label}</dt>
          <dd>{r.value}</dd>
        </div>
      ))}
    </dl>
  )
}

/** A titled group of static chips ("Roles that use it"). */
export function DetailChips({ title, chips, empty }: { title: string; chips: string[]; empty?: string }): ReactElement {
  return (
    <div className="settings-detail-block">
      <div className="settings-detail-label">{title}</div>
      <div className="settings-detail-chips">
        {chips.length === 0 ? <span className="settings-detail-chip is-empty">{empty ?? 'None yet'}</span> : chips.map((c) => <span key={c} className="settings-detail-chip">{c}</span>)}
      </div>
    </div>
  )
}

/** A titled free block (a body, a form, a preview). */
export function DetailBlock({ title, children, testId }: { title?: string; children: ReactNode; testId?: string }): ReactElement {
  return (
    <div className="settings-detail-block" data-testid={testId}>
      {title && <div className="settings-detail-label">{title}</div>}
      {children}
    </div>
  )
}

/** The aside's action row. */
export function DetailActions({ children }: { children: ReactNode }): ReactElement {
  return <div className="settings-detail-actions">{children}</div>
}
