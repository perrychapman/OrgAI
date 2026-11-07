import type { KeyboardEvent, ReactElement } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { Maximize, Minus, Plus } from 'lucide-react'
import { Button } from '../ui/Button'
import { IconButton } from '../ui/IconButton'
import { ZOOM_MAX, ZOOM_MIN, scaleOf, stepZoom, zoomKeyAction, zoomPercent, type ZoomValue } from '../../lib/outputZoom'

export interface Zoom {
  value: ZoomValue
  /** The numeric scale shown now (Fit resolved against the region). */
  scale: number
  /** The drawing's size at that scale in px, or null while its own size is unknown. */
  size: { w: number; h: number } | null
  setValue: (v: ZoomValue) => void
  step: (dir: 'in' | 'out') => void
  /** Ref callback for the focusable scroll region the drawing sits in. */
  regionRef: (el: HTMLElement | null) => void
  /** Keys + / - / 0 while the region has focus. */
  onKeyDown: (e: KeyboardEvent<HTMLElement>) => void
}

/** Zoom state for a drawing of `natural` px (null = unknown), fitted to the scroll region it is given. */
export function useZoom(natural: { w: number; h: number } | null): Zoom {
  const [value, setValue] = useState<ZoomValue>('fit')
  const [region, setRegion] = useState<HTMLElement | null>(null)
  const [box, setBox] = useState({ w: 0, h: 0 })
  useEffect(() => {
    if (!region) return undefined
    const read = (): void => {
      const cs = getComputedStyle(region)
      const w = region.clientWidth - parseFloat(cs.paddingLeft || '0') - parseFloat(cs.paddingRight || '0')
      const h = region.clientHeight - parseFloat(cs.paddingTop || '0') - parseFloat(cs.paddingBottom || '0')
      setBox((b) => (Math.abs(b.w - w) < 1 && Math.abs(b.h - h) < 1 ? b : { w, h }))
    }
    read()
    if (typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(read)
    ro.observe(region)
    return () => ro.disconnect()
  }, [region])
  const scale = natural ? scaleOf(value, natural, box) : 1
  const step = useCallback(
    (dir: 'in' | 'out') => setValue((was) => stepZoom(natural ? scaleOf(was, natural, box) : 1, dir)),
    [natural, box]
  )
  const onKeyDown = (e: KeyboardEvent<HTMLElement>): void => {
    const act = zoomKeyAction(e)
    if (!act) return
    e.preventDefault()
    if (act === 'actual') setValue(1)
    else step(act)
  }
  return {
    value,
    scale,
    size: natural ? { w: natural.w * scale, h: natural.h * scale } : null,
    setValue,
    step,
    regionRef: setRegion,
    onKeyDown
  }
}

/** Zoom out, Fit, 100%, Zoom in. `data-value` is "fit" or the scale (1 = 100%). */
export function ZoomBar({ zoom }: { zoom: Zoom }): ReactElement {
  const fit = zoom.value === 'fit'
  return (
    <div className="output-zoom" role="group" aria-label="Zoom" data-testid="output-mermaid-zoom" data-value={fit ? 'fit' : String(zoom.scale)}>
      <IconButton icon={Minus} size="sm" label="Zoom out" testId="output-zoom-out" disabled={zoom.scale <= ZOOM_MIN} onClick={() => zoom.step('out')} />
      <Button size="sm" variant={fit ? 'secondary' : 'ghost'} testId="output-zoom-fit" ariaLabel="Fit to window" title="Fit the drawing to the preview" icon={Maximize} onClick={() => zoom.setValue('fit')}>
        Fit
      </Button>
      <Button size="sm" variant={!fit && zoom.scale === 1 ? 'secondary' : 'ghost'} testId="output-zoom-actual" ariaLabel="Actual size, 100 percent" onClick={() => zoom.setValue(1)}>
        100%
      </Button>
      <IconButton icon={Plus} size="sm" label="Zoom in" testId="output-zoom-in" disabled={zoom.scale >= ZOOM_MAX} onClick={() => zoom.step('in')} />
      <span className="output-quiet output-zoom-readout" data-testid="output-zoom-readout" role="status">
        {zoomPercent(zoom.scale)}
      </span>
    </div>
  )
}
