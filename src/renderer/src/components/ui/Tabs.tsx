import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent, ReactElement, ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { Icon } from './Icon'

export interface TabItem {
  id: string
  label: string
  icon?: LucideIcon
  /** Quiet count after the label (e.g. pending cards). */
  count?: number
  /** Spoken name of the count, e.g. "3 suggestions"; the tab's accessible name becomes "<label>, <countLabel>". */
  countLabel?: string
  countTestId?: string
  disabled?: boolean
  testId?: string
}

export const tabDomId = (prefix: string, id: string): string => `${prefix}-tab-${id}`
export const panelDomId = (prefix: string, id: string): string => `${prefix}-panel-${id}`

/** The tablist the user last changed, and when: a TabPanel that mounts right after it fades in (docs/design/motion.md 3.6). */
const lastUserChange = { prefix: '', at: 0 }
const USER_CHANGE_WINDOW_MS = 400

/**
 * Underline tabs. role=tablist with a roving tabindex: only the selected tab is in the tab order, Left/Right
 * (and Home/End) move focus and select (automatic activation). Pair with `TabPanel` using the same `idPrefix`.
 */
export function Tabs({
  tabs,
  value,
  onChange,
  label,
  idPrefix,
  compact,
  controls = true,
  className
}: {
  tabs: TabItem[]
  value: string
  onChange: (id: string) => void
  /** Accessible name of the tablist. */
  label: string
  /** Prefix for tab and panel ids (use a stable string, e.g. 'project'). */
  idPrefix: string
  /** 32 px high instead of 40. */
  compact?: boolean
  /** Set false when no TabPanel follows (a topbar switcher), so aria-controls does not dangle. */
  controls?: boolean
  className?: string
}): ReactElement {
  const refs = useRef(new Map<string, HTMLButtonElement>())
  const listRef = useRef<HTMLDivElement>(null)
  const enabled = tabs.filter((t) => !t.disabled)
  const change = (id: string): void => {
    lastUserChange.prefix = idPrefix
    lastUserChange.at = Date.now()
    onChange(id)
  }

  // One 2 px indicator slides under the selected tab (transform only). It is measured before paint and on resize;
  // `data-ready` turns the transition on after the first measure, and a resize snaps (data-snap) instead of gliding.
  const [bar, setBar] = useState<{ x: number; w: number } | null>(null)
  const [ready, setReady] = useState(false)
  const signature = tabs.map((t) => `${t.id}:${t.label}:${t.count ?? ''}`).join('|')
  const measure = (): void => {
    const list = listRef.current
    const el = refs.current.get(value)
    if (!list || !el || el.offsetWidth === 0) {
      setBar((b) => (b === null ? b : null))
      return
    }
    const pad = parseFloat(getComputedStyle(el).paddingLeft) || 0
    const x = el.offsetLeft + pad
    const w = Math.max(0, el.offsetWidth - pad * 2)
    setBar((b) => (b && b.x === x && b.w === w ? b : { x, w }))
  }
  useLayoutEffect(measure, [value, signature])
  const measureRef = useRef(measure)
  measureRef.current = measure
  // The observer lives across selection changes (review M3): a new observer always fires once right after layout, and
  // that snap would cancel the slide a tab change just started. Its first callback is skipped; later ones are resizes.
  useEffect(() => {
    setReady(true)
    const list = listRef.current
    if (!list || typeof ResizeObserver === 'undefined') return undefined
    let first = true
    const ro = new ResizeObserver(() => {
      if (first) {
        first = false
        return
      }
      list.setAttribute('data-snap', '')
      measureRef.current()
      requestAnimationFrame(() => list.removeAttribute('data-snap'))
    })
    ro.observe(list)
    for (const el of refs.current.values()) ro.observe(el)
    return () => ro.disconnect()
  }, [signature])

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const i = enabled.findIndex((t) => t.id === value)
    let next = -1
    if (e.key === 'ArrowRight') next = (i + 1) % enabled.length
    else if (e.key === 'ArrowLeft') next = (i - 1 + enabled.length) % enabled.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = enabled.length - 1
    if (next < 0 || enabled.length === 0) return
    e.preventDefault()
    const target = enabled[next]
    change(target.id)
    refs.current.get(target.id)?.focus()
  }

  return (
    <div
      ref={listRef}
      role="tablist"
      data-ready={ready && bar ? '' : undefined}
      aria-label={label}
      aria-orientation="horizontal"
      className={['tabs-list', compact ? 'compact' : '', className ?? ''].filter(Boolean).join(' ')}
      onKeyDown={onKeyDown}
    >
      {tabs.map((t) => {
        const selected = t.id === value
        return (
          <button
            key={t.id}
            ref={(el) => {
              if (el) refs.current.set(t.id, el)
              else refs.current.delete(t.id)
            }}
            type="button"
            role="tab"
            id={tabDomId(idPrefix, t.id)}
            aria-selected={selected}
            aria-controls={controls ? panelDomId(idPrefix, t.id) : undefined}
            tabIndex={selected ? 0 : -1}
            disabled={t.disabled}
            className="tabs-tab"
            data-testid={t.testId}
            aria-label={t.count !== undefined && t.count > 0 && t.countLabel ? `${t.label}, ${t.countLabel}` : undefined}
            onClick={() => change(t.id)}
          >
            {t.icon && <Icon icon={t.icon} size="sm" />}
            {t.label}
            {t.count !== undefined && t.count > 0 && <span className="tabs-count" data-testid={t.countTestId}>{t.count}</span>}
          </button>
        )
      })}
      {bar && <span className="tabs-indicator" aria-hidden="true" style={{ '--tab-x': `${bar.x}px`, '--tab-w': bar.w } as CSSProperties} />}
    </div>
  )
}

/** The panel for one tab. Renders nothing while another tab is selected. */
export function TabPanel({
  idPrefix,
  id,
  value,
  className,
  children
}: {
  idPrefix: string
  id: string
  value: string
  className?: string
  children: ReactNode
}): ReactElement | null {
  if (id !== value) return null
  return (
    <TabPanelBody idPrefix={idPrefix} id={id} className={className}>
      {children}
    </TabPanelBody>
  )
}

/** Mounts when its tab is selected; a user's tab change a moment ago (this tablist only) gives it the view fade. */
function TabPanelBody({ idPrefix, id, className, children }: { idPrefix: string; id: string; className?: string; children: ReactNode }): ReactElement {
  const [fade] = useState(() => lastUserChange.prefix === idPrefix && Date.now() - lastUserChange.at < USER_CHANGE_WINDOW_MS)
  return (
    <div
      role="tabpanel"
      id={panelDomId(idPrefix, id)}
      aria-labelledby={tabDomId(idPrefix, id)}
      tabIndex={0}
      className={[className, fade ? 'motion-view' : ''].filter(Boolean).join(' ') || undefined}
    >
      {children}
    </div>
  )
}
