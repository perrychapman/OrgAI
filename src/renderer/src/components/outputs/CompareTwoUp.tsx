// Compare for drawings: two viewports (older, newer) with linked pan and zoom, and for diagrams and SVG a "Source changes"
// view (the text changes). docs/design/outputs-2.md 12.2. Read only: the viewport here is this file's own small one, because the
// shared PanZoomSurface keeps its transform inside usePanZoom and cannot be driven from two places.
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactElement, ReactNode, Ref } from 'react'
import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { Maximize2, ZoomIn, ZoomOut } from 'lucide-react'
import type { OutputDiff, RunOutput } from '@shared/types'
import { IconButton } from '../ui/IconButton'
import { SegmentedControl } from '../ui/SegmentedControl'
import { Switch } from '../ui/Switch'
import { isSafeImageDataUrl, svgDataUrl } from '../../lib/outputPreview'
import { svgNaturalSize } from '../../lib/outputZoom'
import { viewerTheme } from '../../lib/diagramExport'
import { DRAG_SLOP, KEY_ZOOM_STEP, actualView, clampView, fitView, panBy, percentLabel, viewKey, zoomAt, type Box, type Size, type View } from '../../lib/diagramView'
import { useDiagramDraw } from './diagram/useDiagramDraw'
import { ShadowSvg } from './diagram/PanZoomSurface'
import { svgTextSize } from './SvgPreview'
import CompareText from './CompareText'
import { previewTextOf, useVersionPreview, type VersionPreviewState } from './CompareParts'
import '../../styles/outputs-compare.css'

export interface CompareTwoUpProps {
  output: RunOutput
  a: number
  b: number
  diff: OutputDiff
  announce(text: string): void
}

type Side = 'a' | 'b'
interface SideApi {
  zoomBy(f: number): void
  fit(): void
  actual(): void
}

function appTheme(): 'light' | 'dark' {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'
}

function useAppTheme(): 'light' | 'dark' {
  const [t, setT] = useState(appTheme)
  useEffect(() => {
    const obs = new MutationObserver(() => setT(appTheme()))
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => obs.disconnect()
  }, [])
  return t
}

interface ViewportProps {
  side: Side
  label: string
  natural: Size | null
  /** The user's view of this side (null = fitted). */
  free: View | null
  onFree(side: Side, v: View | null): void
  apiRef: Ref<SideApi>
  children: ReactNode
  stale?: boolean
}

function Viewport({ side, label, natural, free, onFree, apiRef, children }: ViewportProps): ReactElement {
  const [el, setEl] = useState<HTMLDivElement | null>(null)
  const [box, setBox] = useState<Box>({ w: 0, h: 0 })
  const [dragging, setDragging] = useState(false)
  useEffect(() => {
    if (!el) return undefined
    const read = (): void => setBox((b) => (Math.abs(b.w - el.clientWidth) < 0.5 && Math.abs(b.h - el.clientHeight) < 0.5 ? b : { w: el.clientWidth, h: el.clientHeight }))
    read()
    if (typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [el])
  const ready = natural !== null && box.w > 0 && box.h > 0
  const fitted = ready ? fitView(box, natural) : { k: 1, x: 0, y: 0 }
  const view = ready ? (free ? clampView(free, box, natural) : fitted) : fitted
  const live = useRef({ view, box, natural, ready })
  live.current = { view, box, natural, ready }

  const commit = useCallback((v: View): void => onFree(side, v), [onFree, side])
  const around = useCallback((f: number, at?: { x: number; y: number }): void => {
    const { view: v, box: b, ready: ok } = live.current
    if (ok) commit(zoomAt(v, at ?? { x: b.w / 2, y: b.h / 2 }, f))
  }, [commit])
  useImperativeHandle(
    apiRef,
    () => ({
      zoomBy: (f) => around(f),
      fit: () => onFree(side, null),
      actual: () => {
        const { view: v, box: b, natural: n, ready: ok } = live.current
        if (ok && n) commit(actualView(v, b, n))
      }
    }),
    [around, commit, onFree, side]
  )

  useEffect(() => {
    if (!el) return undefined
    const onWheel = (e: WheelEvent): void => {
      if (!(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      const r = el.getBoundingClientRect()
      const f = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.01))
      around(f, { x: e.clientX - r.left, y: e.clientY - r.top })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [el, around])

  const drag = useRef<{ id: number; x: number; y: number; moved: number } | null>(null)
  const down = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // nothing to capture
    }
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: 0 }
    setDragging(true)
  }
  const move = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    const dx = e.clientX - d.x
    const dy = e.clientY - d.y
    d.x = e.clientX
    d.y = e.clientY
    d.moved += Math.abs(dx) + Math.abs(dy)
    if (d.moved < DRAG_SLOP || !live.current.ready) return
    commit(panBy(live.current.view, dx, dy))
  }
  const up = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (drag.current?.id === e.pointerId) drag.current = null
    setDragging(false)
  }
  const key = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    const act = viewKey(e)
    if (!act) return
    if (act.type === 'pan') commit(panBy(live.current.view, act.dx, act.dy))
    else if (act.type === 'zoom') around(act.factor)
    else if (act.type === 'fit') onFree(side, null)
    else if (act.type === 'actual') {
      const { view: v, box: b, natural: n } = live.current
      if (n) commit(actualView(v, b, n))
    } else return
    e.preventDefault()
  }
  return (
    <div className="compare-twoup-pane" data-side={side}>
      <h5 className="compare-col-head">{label}</h5>
      <div className="compare-viewport-wrap">
        <div
          ref={setEl}
          className="compare-viewport"
          data-testid={`output-compare-view-${side}`}
          data-k={view.k.toFixed(4)}
          data-x={view.x.toFixed(1)}
          data-y={view.y.toFixed(1)}
          data-mode={free ? 'free' : 'fit'}
          data-dragging={dragging ? 'true' : undefined}
          role="group"
          aria-roledescription="viewer"
          aria-label={`${label}. Arrow keys move, plus and minus zoom, 0 fits.`}
          tabIndex={0}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
          onKeyDown={key}
          onDoubleClick={() => onFree(side, null)}
        >
          <div
            className="compare-viewport-content"
            style={{ width: natural?.w, height: natural?.h, transform: ready ? `translate(${view.x}px, ${view.y}px) scale(${view.k})` : undefined, visibility: ready || !natural ? undefined : 'hidden' }}
          >
            {children}
          </div>
        </div>
      </div>
    </div>
  )
}

function Mermaid({ text, theme, onSize }: { text: string; theme: 'light' | 'dark'; onSize(s: Size | null): void }): ReactElement {
  const { drawn, good } = useDiagramDraw(text, viewerTheme(theme, false), true)
  const natural = useMemo(() => (good ? svgNaturalSize(good.getAttribute('viewBox'), good.getAttribute('width'), good.getAttribute('height')) : null), [good])
  useEffect(() => onSize(natural), [natural, onSize])
  if (!good) return <span className="compare-note">{drawn.state === 'error' ? 'This version does not draw.' : drawn.state === 'refused' ? 'This version was not shown.' : 'Drawing...'}</span>
  return <ShadowSvg root={good} size={natural} label="Diagram" />
}

function Picture({ output, label, p, free, onFree, apiRef, side, theme }: { output: RunOutput; label: string; p: VersionPreviewState; free: View | null; onFree(side: Side, v: View | null): void; apiRef: Ref<SideApi>; side: Side; theme: 'light' | 'dark' }): ReactElement {
  const [size, setSize] = useState<Size | null>(null)
  const text = previewTextOf(p)
  const dataUrl = p.state === 'ready' && p.preview.kind === 'image' ? p.preview.dataUrl : null
  const fromText = useMemo(() => (output.kind === 'svg' && text ? svgTextSize(text) : null), [output.kind, text])
  const natural = output.kind === 'mermaid' ? size : (fromText ?? size)
  let content: ReactElement
  if (p.state === 'loading') content = <span className="compare-note">Loading...</span>
  else if (p.state === 'error') content = <span className="compare-note">Could not load this version.</span>
  else if (output.kind === 'mermaid') content = text === null ? <span className="compare-note">This version cannot be shown.</span> : <Mermaid text={text} theme={theme} onSize={setSize} />
  else if (output.kind === 'svg') {
    content = text === null ? <span className="compare-note">This version cannot be shown.</span> : <img className="compare-img" src={svgDataUrl(text)} alt="" draggable={false} onLoad={(e) => !fromText && e.currentTarget.naturalWidth > 0 && setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} />
  } else if (dataUrl && isSafeImageDataUrl(dataUrl)) {
    content = <img className="compare-img" src={dataUrl} alt="" draggable={false} onLoad={(e) => e.currentTarget.naturalWidth > 0 && setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} />
  } else content = <span className="compare-note">This version cannot be shown.</span>
  return (
    <Viewport side={side} label={label} natural={natural} free={free} onFree={onFree} apiRef={apiRef}>
      {content}
    </Viewport>
  )
}

type View2 = 'drawings' | 'source'

export default function CompareTwoUp({ output, a, b, diff, announce }: CompareTwoUpProps): ReactElement {
  const [linked, setLinked] = useState(true)
  const [free, setFree] = useState<{ a: View | null; b: View | null }>({ a: null, b: null })
  const [which, setWhich] = useState<View2>('drawings')
  const theme = useAppTheme()
  const aPrev = useVersionPreview(output, a)
  const bPrev = useVersionPreview(output, b)
  const apiA = useRef<SideApi>(null)
  const apiB = useRef<SideApi>(null)
  const linkedRef = useRef(linked)
  linkedRef.current = linked
  const onFree = useCallback((side: Side, v: View | null): void => {
    setFree((f) => {
      if (v === null) return linkedRef.current ? { a: null, b: null } : { ...f, [side]: null }
      return linkedRef.current ? { a: v, b: v } : { ...f, [side]: v }
    })
  }, [])
  const each = (fn: (api: SideApi) => void): void => {
    if (linked) fn((apiA.current ?? apiB.current) as SideApi)
    else {
      if (apiA.current) fn(apiA.current)
      if (apiB.current) fn(apiB.current)
    }
  }
  const k = free.a?.k
  const hasSource = output.kind === 'mermaid' || output.kind === 'svg'
  return (
    <div className="compare-pane" data-testid="output-compare-twoup" data-view={which}>
      <div className="compare-bar">
        {hasSource && (
          <div data-testid="output-compare-view">
            <SegmentedControl<View2>
              label="Show"
              value={which}
              options={[
                { value: 'drawings', label: 'Drawings' },
                { value: 'source', label: 'Source changes' }
              ]}
              onChange={setWhich}
            />
          </div>
        )}
        {which === 'drawings' && (
          <>
            <label className="compare-switch">
              <Switch checked={linked} onChange={setLinked} label="Link pan and zoom" testId="output-compare-link" />
              <span aria-hidden="true">Link pan and zoom</span>
            </label>
            <div className="compare-zoom" role="group" aria-label="Zoom">
              <IconButton icon={ZoomOut} label="Zoom out" size="sm" testId="output-compare-zoom-out" onClick={() => each((x) => x.zoomBy(1 / KEY_ZOOM_STEP))} />
              <IconButton icon={ZoomIn} label="Zoom in" size="sm" testId="output-compare-zoom-in" onClick={() => each((x) => x.zoomBy(KEY_ZOOM_STEP))} />
              <IconButton icon={Maximize2} label="Fit both" size="sm" testId="output-compare-fit" onClick={() => each((x) => x.fit())} />
              <span className="compare-nav-count" data-testid="output-compare-zoom-readout">{k === undefined ? 'Fit' : percentLabel(k)}</span>
            </div>
          </>
        )}
      </div>
      {which === 'source' && hasSource ? (
        diff.kind === 'text' ? (
          <CompareText output={output} a={a} b={b} diff={diff} announce={announce} />
        ) : (
          <p className="compare-note">{diff.kind === 'none' ? diff.reason : 'The source of these versions cannot be compared.'}</p>
        )
      ) : (
        <div className="compare-twoup" data-testid="output-compare-drawings">
          <Picture output={output} label={`Version ${a}`} p={aPrev} free={free.a} onFree={onFree} apiRef={apiA} side="a" theme={theme} />
          <Picture output={output} label={`Version ${b}`} p={bPrev} free={free.b} onFree={onFree} apiRef={apiB} side="b" theme={theme} />
        </div>
      )}
    </div>
  )
}
