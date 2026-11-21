import type { FocusEventHandler, ReactElement, ReactNode, Ref } from 'react'
import { createContext, useContext, useLayoutEffect } from 'react'
import { ChevronDown, ChevronUp, type LucideIcon } from 'lucide-react'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { DEFAULT_LAYOUT, SECTION_TITLES, type DashboardLayout, type DashSectionId } from '../../lib/dashboardLayout'
import { NARROW_CAPS, type DashCaps } from './dashCaps'

/**
 * What every Dashboard section reads from the page (docs/design/dashboard-overhaul.md sections 4.2, 6, 7): the person's
 * layout, whether customise mode is on, the caps for the current width, the page's one live region and the pin action.
 * Provided by DashboardView. `DashSection` is the frame every arrangeable section renders through.
 */

/** A message for the page's one live region; `seq` rises with every message so a repeated text still speaks. */
export interface DashboardAnnouncement {
  text: string
  seq: number
}

export interface DashboardCtx {
  layout: DashboardLayout
  customising: boolean
  caps: DashCaps
  /** Speak through `dashboard-live` (never for counts, costs, times or rows appearing). */
  announce: (text: string) => void
  /** Pin or unpin a project, announce the result and return whether the pin state changed (false at the limit). */
  togglePin: (projectId: string, name: string) => boolean
  /** Customise actions (section 6.3); they announce and move focus themselves. */
  move: (id: DashSectionId, dir: 'up' | 'down') => void
  setSectionHidden: (id: DashSectionId, hidden: boolean) => void
  /** Each section says whether it has something to show, so the page can pair the visible ones (`placeSections`). */
  reportEmpty: (id: DashSectionId, empty: boolean) => void
  spanOf: (id: DashSectionId) => 'half' | 'full'
}

const noop = (): void => undefined

export const DashboardContext = createContext<DashboardCtx>({
  layout: DEFAULT_LAYOUT,
  customising: false,
  caps: NARROW_CAPS,
  announce: noop,
  togglePin: () => false,
  move: noop,
  setSectionHidden: noop,
  reportEmpty: noop,
  spanOf: () => 'full'
})

export function useDashboard(): DashboardCtx {
  return useContext(DashboardContext)
}

/** Fixed regions drawn through the same frame: never hidden, moved or listed in Customise, drawn only with content. */
export type FixedSectionId = 'now'
const FIXED_TITLES: Record<FixedSectionId, string> = { now: 'Right now' }

export interface DashSectionProps {
  id: DashSectionId | FixedSectionId
  /** The section's own test id (`dash-resume`, `dash-today`, ...), on the `section` element. */
  testId: string
  /** True when there is nothing to show: outside customise mode nothing renders. */
  empty: boolean
  /** Decorative glyph before the h2 (the section card's header icon). */
  icon?: LucideIcon
  /** Full number shown in mono beside the h2; omitted when undefined or zero. */
  count?: number
  /** Extra content on the heading line after the count (a date caption, the band's counts line). */
  headExtra?: ReactNode
  /** Extra class names for the `section`. */
  className?: string
  sectionRef?: Ref<HTMLElement>
  headingRef?: Ref<HTMLHeadingElement>
  /** Extra attributes for the `section` (data-*). */
  sectionData?: Record<`data-${string}`, string | number | undefined>
  onFocus?: FocusEventHandler<HTMLElement>
  onBlur?: FocusEventHandler<HTMLElement>
  children?: ReactNode
}

/** The heading id of a section, for `aria-labelledby` and for focus moves. */
export const sectionHeadingId = (id: DashSectionId | FixedSectionId): string => `dash-h-${id}`

/**
 * The frame of one arrangeable section: a grid slot (`dash-section[data-section][data-state]`) holding, while customising,
 * the control row, and the `section` with its h2. Outside customise mode a hidden or empty section renders nothing.
 */
export function DashSection({ id, testId, empty, icon, count, headExtra, className, sectionRef, headingRef, sectionData, onFocus, onBlur, children }: DashSectionProps): ReactElement | null {
  const { layout, customising, reportEmpty, spanOf, move, setSectionHidden } = useDashboard()
  const fixed = id === 'now'
  const hidden = id !== 'now' && layout.hidden.includes(id)
  useLayoutEffect(() => {
    if (id !== 'now') reportEmpty(id, empty)
  }, [id, empty, reportEmpty])
  useLayoutEffect(
    () => () => {
      if (id !== 'now') reportEmpty(id, true)
    },
    [id, reportEmpty]
  )

  if (fixed && empty) return null
  if (!customising && (hidden || empty)) return null
  const title = id === 'now' ? FIXED_TITLES[id] : SECTION_TITLES[id]
  const arrangeable = id !== 'now' && customising
  const state = hidden ? 'hidden' : empty ? 'empty' : 'shown'
  const index = id === 'now' ? -1 : layout.order.indexOf(id)
  const doMove = (dir: 'up' | 'down'): void => {
    if (id !== 'now') move(id, dir)
  }
  const doHide = (h: boolean): void => {
    if (id !== 'now') setSectionHidden(id, h)
  }
  const first = index <= 0
  const last = index >= layout.order.length - 1
  return (
    <div className="dash-slot" data-testid="dash-section" data-section={id} data-state={state} data-span={customising || id === 'now' ? 'full' : spanOf(id)}>
      {arrangeable && (
        <div className="dash-section-controls motion-fade" role="group" aria-label={hidden ? `Arrange ${title}, hidden` : empty ? `Arrange ${title}, nothing to show right now` : `Arrange ${title}`} data-testid="dash-section-controls" data-section={id}>
          <span className="dash-section-controls-title" aria-hidden="true">
            {hidden ? `${title}, hidden` : empty ? `${title}: nothing to show right now.` : title}
          </span>
          {/* Native buttons with the IconButton look: aria-disabled (not disabled) at the ends keeps focus and still announces. */}
          <button
            type="button"
            className="icon-btn size-sm"
            data-testid="dash-section-up"
            aria-label={`Move ${title} up`}
            title={`Move ${title} up`}
            aria-disabled={first ? 'true' : undefined}
            onClick={() => doMove('up')}
          >
            <Icon icon={ChevronUp} size="sm" />
          </button>
          <button
            type="button"
            className="icon-btn size-sm"
            data-testid="dash-section-down"
            aria-label={`Move ${title} down`}
            title={`Move ${title} down`}
            aria-disabled={last ? 'true' : undefined}
            onClick={() => doMove('down')}
          >
            <Icon icon={ChevronDown} size="sm" />
          </button>
          {hidden ? (
            <Button variant="ghost" size="sm" testId="dash-section-show" ariaLabel={`Show ${title}`} onClick={() => doHide(false)}>
              Show
            </Button>
          ) : (
            <Button variant="ghost" size="sm" testId="dash-section-hide" ariaLabel={`Hide ${title}`} onClick={() => doHide(true)}>
              Hide
            </Button>
          )}
        </div>
      )}
      {!hidden && !empty && (
        <section
          ref={sectionRef}
          className={className ? `dash-section ${className}` : 'dash-section'}
          data-testid={testId}
          aria-labelledby={sectionHeadingId(id)}
          onFocus={onFocus}
          onBlur={onBlur}
          {...sectionData}
        >
          <div className="dash-section-head">
            {icon && (
              <span className="dash-section-icon" aria-hidden="true">
                <Icon icon={icon} size="sm" />
              </span>
            )}
            <h2 id={sectionHeadingId(id)} ref={headingRef} tabIndex={-1} data-section-heading="">
              {title}
            </h2>
            {count !== undefined && count > 0 && <span className="dash-count">{count}</span>}
            {headExtra}
          </div>
          {children}
        </section>
      )}
    </div>
  )
}
