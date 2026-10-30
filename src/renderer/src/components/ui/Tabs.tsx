import { useRef } from 'react'
import type { KeyboardEvent, ReactElement, ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { Icon } from './Icon'

export interface TabItem {
  id: string
  label: string
  icon?: LucideIcon
  /** Quiet count after the label (e.g. pending cards). */
  count?: number
  disabled?: boolean
  testId?: string
}

export const tabDomId = (prefix: string, id: string): string => `${prefix}-tab-${id}`
export const panelDomId = (prefix: string, id: string): string => `${prefix}-panel-${id}`

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
  const enabled = tabs.filter((t) => !t.disabled)

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
    onChange(target.id)
    refs.current.get(target.id)?.focus()
  }

  return (
    <div
      role="tablist"
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
            onClick={() => onChange(t.id)}
          >
            {t.icon && <Icon icon={t.icon} size="sm" />}
            {t.label}
            {t.count !== undefined && t.count > 0 && <span className="tabs-count">{t.count}</span>}
          </button>
        )
      })}
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
    <div role="tabpanel" id={panelDomId(idPrefix, id)} aria-labelledby={tabDomId(idPrefix, id)} tabIndex={0} className={className}>
      {children}
    </div>
  )
}
