import type { KeyboardEvent, ReactElement } from 'react'
import { useLayoutEffect, useRef } from 'react'
import { Copy, Maximize2, Minimize2, MoreHorizontal, PictureInPicture2, SquareArrowOutUpRight } from 'lucide-react'
import { Button } from '../../ui/Button'
import { IconButton } from '../../ui/IconButton'
import { Icon } from '../../ui/Icon'
import { Popover } from '../../ui/Popover'
import { SegmentedControl } from '../../ui/SegmentedControl'
import { Switch } from '../../ui/Switch'
import { ZoomBar } from '../ZoomControl'
import { ExportMenuItems, ExportPopover, MenuAction, type ExportApi } from './DiagramExport'
import type { PanZoom } from './usePanZoom'

export type DiagramMode = 'diagram' | 'split' | 'source'

const MODE_OPTIONS: { value: DiagramMode; label: string }[] = [
  { value: 'diagram', label: 'Diagram' },
  { value: 'split', label: 'Split' },
  { value: 'source', label: 'Source' }
]

/**
 * The toolbar's controls in DOM order, outside any open popover (their own keys are theirs). A radio group counts as one
 * control, its checked radio: Chromium never lets Tab land on an unchecked radio of a group with a checked one, so an
 * unchecked radio as the roving stop would drop the whole toolbar out of the Tab order. Up/Down change the mode natively.
 */
function itemsOf(bar: HTMLElement): HTMLElement[] {
  return Array.from(bar.querySelectorAll<HTMLElement>('button, input[type=radio]')).filter(
    (el) => !el.closest('[popover]') && !(el as HTMLButtonElement).disabled && !(el instanceof HTMLInputElement && el.type === 'radio' && !el.checked)
  )
}

/** Arrow keys move between the toolbar's controls; only one is a Tab stop (a roving tabindex set after every render). */
function useRoving(): { ref: React.RefObject<HTMLDivElement | null>; onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void; onFocus: () => void } {
  const ref = useRef<HTMLDivElement>(null)
  const active = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => {
    const bar = ref.current
    if (!bar) return
    const items = itemsOf(bar)
    if (items.length === 0) return
    if (!active.current || !items.includes(active.current)) active.current = items[0]
    for (const el of items) el.tabIndex = el === active.current ? 0 : -1
    // A radio that lost its check (the mode changed) leaves the roving set; it must not keep an old tabindex 0.
    for (const r of Array.from(bar.querySelectorAll<HTMLInputElement>('input[type=radio]'))) if (!r.checked && !r.closest('[popover]')) r.tabIndex = -1
  })
  const onFocus = (): void => {
    const el = document.activeElement as HTMLElement | null
    const bar = ref.current
    if (!el || !bar || el.closest('[popover]')) return
    if (itemsOf(bar).includes(el)) {
      active.current = el
      for (const it of itemsOf(bar)) it.tabIndex = it === el ? 0 : -1
    }
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const bar = ref.current
    if (!bar || (e.target as HTMLElement).closest('[popover]')) return
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return
    // Alt+Left/Right steps between outputs (stepKeyHandler); other modifiers keep their own jobs.
    if (e.altKey || e.ctrlKey || e.metaKey) return
    const items = itemsOf(bar)
    const at = items.indexOf(e.target as HTMLElement)
    if (at < 0) return
    e.preventDefault()
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : e.key === 'ArrowRight' ? (at + 1) % items.length : (at - 1 + items.length) % items.length
    items[next]?.focus()
  }
  return { ref, onKeyDown, onFocus }
}

/** Arrow keys inside the More menu. */
function onMenuKey(e: KeyboardEvent<HTMLDivElement>): void {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[role^=menuitem]:not(:disabled)'))
  if (items.length === 0) return
  e.preventDefault()
  const at = items.indexOf(document.activeElement as HTMLButtonElement)
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : e.key === 'ArrowDown' ? (at + 1) % items.length : (at - 1 + items.length) % items.length
  items[next]?.focus()
}

export interface DiagramToolbarProps {
  mode: DiagramMode
  onMode: (m: DiagramMode) => void
  pz: PanZoom
  /** Whether there is a drawing to zoom, overview and export. */
  hasDrawing: boolean
  overview: boolean
  onOverview: () => void
  light: boolean
  onLight: (on: boolean) => void
  exportApi: ExportApi
  onCopySource: () => void
  /** Under 560 px of container width everything after the zoom group moves into More. */
  narrow: boolean
  context: 'detail' | 'dialog'
  onOpenLarge?: () => void
  full?: boolean
  onToggleFull?: () => void
}

/** One row (36 px) of controls over the viewer, a role=toolbar with one Tab stop (docs/design/outputs-2.md 8.2). */
export function DiagramToolbar(p: DiagramToolbarProps): ReactElement {
  const rov = useRoving()
  const showZoom = p.mode !== 'source' && p.hasDrawing
  const extras = (
    <>
      {p.hasDrawing && (
        <button type="button" className="btn ghost sm diagram-toggle" aria-pressed={p.overview} data-testid="diagram-overview-toggle" title="Show a small map of the whole drawing (O)" onClick={p.onOverview}>
          Overview
        </button>
      )}
      <span className="diagram-light">
        <Switch checked={p.light} onChange={p.onLight} label="Light drawing" testId="diagram-light-toggle" title="Draw it in light colours, as it would print" />
        <span aria-hidden="true">Light drawing</span>
      </span>
      <ExportPopover api={p.exportApi} />
      <Button size="sm" variant="ghost" icon={Copy} testId="diagram-copy-source" onClick={p.onCopySource}>
        Copy source
      </Button>
    </>
  )
  return (
    <div ref={rov.ref} className="diagram-toolbar" role="toolbar" aria-label="Diagram controls" data-testid="diagram-toolbar" data-narrow={p.narrow ? 'true' : undefined} onKeyDown={rov.onKeyDown} onFocus={rov.onFocus}>
      <div data-testid="diagram-mode">
        <SegmentedControl<DiagramMode> label="Show" value={p.mode} onChange={p.onMode} options={MODE_OPTIONS} />
      </div>
      {showZoom && <ZoomBar pz={p.pz} />}
      {!p.narrow && extras}
      <span className="diagram-toolbar-end">
        {p.narrow && (
          <Popover
            trigger={<Icon icon={MoreHorizontal} size="sm" />}
            triggerClassName="icon-btn size-sm"
            triggerLabel="More diagram actions"
            triggerTitle="More diagram actions"
            triggerTestId="diagram-more"
            label="More diagram actions"
            role="menu"
            placement="bottom-end"
            testId="diagram-more-menu"
          >
            {({ close }) => (
              <div className="output-menu" role="presentation" onKeyDown={onMenuKey}>
                {p.hasDrawing && <MenuAction testId="diagram-overview-toggle" icon={PictureInPicture2} label="Overview" checked={p.overview} onClick={p.onOverview} />}
                {<MenuAction testId="diagram-light-toggle" label="Light drawing" checked={p.light} onClick={() => p.onLight(!p.light)} />}
                <MenuAction testId="diagram-copy-source" icon={Copy} label="Copy source" onClick={() => { close(); p.onCopySource() }} />
                <ExportMenuItems api={p.exportApi} close={close} />
              </div>
            )}
          </Popover>
        )}
        {p.context === 'detail' && p.onOpenLarge && (
          <Button size="sm" variant="primary" icon={SquareArrowOutUpRight} testId="output-open-large" title="Open the diagram in the larger view" onClick={p.onOpenLarge}>
            Open large
          </Button>
        )}
        {p.context === 'dialog' && p.onToggleFull && (
          <IconButton icon={p.full ? Minimize2 : Maximize2} size="sm" label={p.full ? 'Leave full window' : 'Full window'} testId="diagram-fullscreen" onClick={p.onToggleFull} />
        )}
      </span>
    </div>
  )
}

/** The toolbar of an SVG or image surface: the zoom group and, for an SVG, Export and Copy source. One Tab stop, like the diagram's. */
export function SurfaceToolbar({ pz, label, exportApi, onCopySource }: { pz: PanZoom; label: string; exportApi?: ExportApi; onCopySource?: () => void }): ReactElement {
  const rov = useRoving()
  return (
    <div ref={rov.ref} className="diagram-toolbar" role="toolbar" aria-label={label} data-testid="diagram-toolbar" onKeyDown={rov.onKeyDown} onFocus={rov.onFocus}>
      <ZoomBar pz={pz} />
      {exportApi && <ExportPopover api={exportApi} />}
      {onCopySource && (
        <Button size="sm" variant="ghost" icon={Copy} testId="diagram-copy-source" onClick={onCopySource}>
          Copy source
        </Button>
      )}
    </div>
  )
}
