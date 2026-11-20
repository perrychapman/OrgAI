// Factory Floor scene controls (docs/design/factory-floor.md section 6.7): one role=toolbar row at the bottom left of the
// stage with Find a worker, Zoom out, Zoom in, Fit and (live only) Pause motion. Arrow keys, Home and End move between
// the controls; only one is a Tab stop (the roving tabindex used by the Outputs diagram toolbar).
import { useLayoutEffect, useRef, type KeyboardEvent, type ReactElement, type ReactNode } from 'react'
import { Maximize, Pause, ZoomIn, ZoomOut } from 'lucide-react'
import { Button } from '../../ui/Button'
import { IconButton } from '../../ui/IconButton'
import '../../../styles/factory-chrome.css'

export interface FactoryControlsProps {
  /** The <FactoryFind/> element. */
  find: ReactNode
  onZoomIn(): void
  onZoomOut(): void
  onFit(): void
  /** Live only; omitted in slice 2 (renders nothing). */
  pauseMotion?: { pressed: boolean; onToggle(): void }
}

/** The row's controls in DOM order, outside any open popover. */
function itemsOf(bar: HTMLElement): HTMLElement[] {
  return Array.from(bar.querySelectorAll<HTMLElement>('button')).filter((el) => !el.closest('[popover]') && !(el as HTMLButtonElement).disabled)
}

export function FactoryControls({ find, onZoomIn, onZoomOut, onFit, pauseMotion }: FactoryControlsProps): ReactElement {
  const ref = useRef<HTMLDivElement>(null)
  const active = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => {
    const bar = ref.current
    if (!bar) return
    const items = itemsOf(bar)
    if (items.length === 0) return
    if (!active.current || !items.includes(active.current)) active.current = items[0]
    for (const el of items) el.tabIndex = el === active.current ? 0 : -1
  })
  const onFocus = (): void => {
    const el = document.activeElement as HTMLElement | null
    const bar = ref.current
    if (!el || !bar || el.closest('[popover]')) return
    const items = itemsOf(bar)
    if (items.includes(el)) {
      active.current = el
      for (const it of items) it.tabIndex = it === el ? 0 : -1
    }
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const bar = ref.current
    if (!bar || (e.target as HTMLElement).closest('[popover]')) return
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return
    if (e.altKey || e.ctrlKey || e.metaKey) return
    const items = itemsOf(bar)
    const at = items.indexOf(e.target as HTMLElement)
    if (at < 0) return
    e.preventDefault()
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : e.key === 'ArrowRight' ? (at + 1) % items.length : (at - 1 + items.length) % items.length
    items[next]?.focus()
  }
  return (
    <div ref={ref} className="factory-controls" role="toolbar" aria-label="Factory floor controls" data-testid="factory-controls" onKeyDown={onKeyDown} onFocus={onFocus}>
      {find}
      <IconButton icon={ZoomOut} label="Zoom out" onClick={onZoomOut} testId="factory-zoom-out" />
      <IconButton icon={ZoomIn} label="Zoom in" onClick={onZoomIn} testId="factory-zoom-in" />
      <IconButton icon={Maximize} label="Fit" onClick={onFit} testId="factory-fit" />
      {pauseMotion && (
        <Button size="sm" icon={Pause} ariaLabel="Pause motion" pressed={pauseMotion.pressed} onClick={pauseMotion.onToggle} testId="factory-pause-motion" className="factory-pause-btn">
          <span className="factory-chrome-label">Pause motion</span>
        </Button>
      )}
    </div>
  )
}
