// Drawn note regions and the region tool (docs/design/outputs-2.md 11.2). Hosts (PanZoomSurface for diagram / svg / image,
// the slide viewer's stage) render <RegionLayer> inside their transformed content box, sized to the drawing's natural size,
// so regions follow pan and zoom, and call the key handler from the viewport's onKeyDown first.
import type { KeyboardEvent, PointerEvent as ReactPointerEvent, ReactElement } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { SlideBox } from '@shared/types'
import { anchorDescription, boxFromPoints, defaultBox, isDeliberate, moveBox, pinNumbers, regionAnchor, resizeBox, stepFractions } from '../../lib/outputNotes'
import { notesOfVersion, useOutputDetail } from './outputDetailContext'
import '../../styles/outputs-notes.css'

export interface RegionLayerProps {
  /** 1-based slide number on a deck, absent for image / svg / diagram. */
  slide?: number
  /** The drawing's natural size in its own units (viewBox or pixels); regions are stored as fractions of it. */
  naturalW: number
  naturalH: number
  /** Texts of shapes whose bounds intersect a box (fractions); diagrams and slides supply it, images do not. */
  labelsIn?: (box: SlideBox) => string[]
}

/** The toolbar's Add note listens for this to open the composer once a region is confirmed. */
export const NOTE_COMPOSE_EVENT = 'orgai:output-note-compose'

// ---------- the keyboard draft (one at a time: only one surface has focus) ----------

interface Draft {
  slide: number
  shape: 'box' | 'ellipse'
  box: SlideBox
}
let draft: Draft | null = null
const listeners = new Set<() => void>()
function setDraft(next: Draft | null): void {
  draft = next
  listeners.forEach((l) => l())
}
function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
const getDraft = (): Draft | null => draft

function Shape({ shape, box, className }: { shape: 'box' | 'ellipse'; box: SlideBox; className: string }): ReactElement {
  return shape === 'ellipse' ? (
    <ellipse className={className} cx={box.x + box.w / 2} cy={box.y + box.h / 2} rx={box.w / 2} ry={box.h / 2} vectorEffect="non-scaling-stroke" />
  ) : (
    <rect className={className} x={box.x} y={box.y} width={box.w} height={box.h} vectorEffect="non-scaling-stroke" />
  )
}

export default function RegionLayer({ slide, naturalW, naturalH, labelsIn }: RegionLayerProps): ReactElement | null {
  const ctx = useOutputDetail()
  const root = useRef<HTMLDivElement>(null)
  const live = useDraftState()
  const [drag, setDrag] = useState<{ a: { x: number; y: number }; b: { x: number; y: number } } | null>(null)
  const tool = ctx?.regionTool ?? 'off'
  const notes = useMemo(() => notesOfVersion(ctx?.notes ?? null, ctx?.version ?? 0), [ctx?.notes, ctx?.version])
  const pins = useMemo(() => pinNumbers(notes, ctx?.version ?? 0), [notes, ctx?.version])

  useEffect(() => {
    if (tool === 'off' && draft) setDraft(null)
  }, [tool])
  useEffect(() => () => setDraft(null), [])

  const point = useCallback((e: ReactPointerEvent<HTMLDivElement>): { x: number; y: number } => {
    const r = root.current?.getBoundingClientRect()
    if (!r || r.width <= 0 || r.height <= 0) return { x: 0, y: 0 }
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }
  }, [])

  if (!ctx || ctx.mode === 'compare' || naturalW <= 0 || naturalH <= 0) return null
  const here = (s: number | undefined): boolean => (s ?? 0) === (slide ?? 0)
  const regions = notes.flatMap((n) => (n.anchor.type === 'region' && here(n.anchor.slide) ? [{ note: n, a: n.anchor }] : []))
  const sel = ctx.selection?.anchor.type === 'region' && here(ctx.selection.anchor.slide) ? ctx.selection.anchor : null
  const kd = live && live.slide === (slide ?? 0) ? live : null

  const down = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (tool === 'off' || e.button !== 0) return
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // A synthetic pointer id has nothing to capture.
    }
    const p = point(e)
    setDraft(null)
    setDrag({ a: p, b: p })
  }
  const move = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (drag) setDrag({ a: drag.a, b: point(e) })
  }
  const up = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (!drag) return
    const box = boxFromPoints(drag.a, point(e))
    setDrag(null)
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      // Already released.
    }
    if (!isDeliberate(box) || tool === 'off') return
    const anchor = regionAnchor(tool, box, slide, labelsIn?.(box))
    ctx.setSelection({ anchor, description: anchorDescription(anchor) })
    ctx.announce('Area marked. Choose Add note to write it.')
  }
  const dragBox = drag ? boxFromPoints(drag.a, drag.b) : null

  return (
    <div
      ref={root}
      className="output-region-layer"
      data-testid="output-region-layer"
      data-tool={tool}
      data-regions={regions.length}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={() => setDrag(null)}
    >
      <svg className="output-region-svg" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true" focusable="false">
        {regions.map(({ note, a }) => (
          <Shape key={note.id} shape={a.shape} box={a} className={`output-region-shape${ctx.shownNote === note.id ? ' shown' : ''}`} />
        ))}
        {sel && <Shape shape={sel.shape} box={sel} className="output-region-shape pending" />}
        {kd && <Shape shape={kd.shape} box={kd.box} className="output-region-shape draft" />}
        {dragBox && tool !== 'off' && <Shape shape={tool} box={dragBox} className="output-region-shape draft" />}
      </svg>
      {regions.map(({ note, a }) => (
        <span
          key={note.id}
          className="output-region-pin"
          data-testid="output-region-pin"
          data-note={note.id}
          data-status={note.status}
          data-shown={ctx.shownNote === note.id ? 'true' : undefined}
          style={{ left: `${a.x * 100}%`, top: `${a.y * 100}%` }}
          onClick={() => ctx.showNote(note.id)}
          aria-hidden="true"
        >
          {pins.get(note.id)}
        </span>
      ))}
    </div>
  )
}

function useDraftState(): Draft | null {
  return useSyncExternalStore(subscribe, getDraft, getDraft)
}

/**
 * The region tool's keyboard path for a focused viewport: Enter places a default box in `visible` (fractions), arrows
 * move it, Shift+arrows resize, Enter confirms, Esc cancels. Returns true when it handled the key (the host then does
 * nothing more with it).
 */
export function useRegionKeys(opts: { slide?: number; labelsIn?: (box: SlideBox) => string[] }): (e: KeyboardEvent, visible: SlideBox) => boolean {
  const ctx = useOutputDetail()
  const ctxRef = useRef(ctx)
  ctxRef.current = ctx
  const optsRef = useRef(opts)
  optsRef.current = opts
  return useCallback((e: KeyboardEvent, visible: SlideBox): boolean => {
    const c = ctxRef.current
    if (!c || c.regionTool === 'off' || c.mode === 'compare') return false
    if (e.target !== e.currentTarget) return false
    const key = optsRef.current.slide ?? 0
    const own = draft && draft.slide === key ? draft : null
    const stop = (): true => {
      e.preventDefault()
      e.stopPropagation()
      return true
    }
    if (e.key === 'Escape') {
      if (own) {
        setDraft(null)
        c.announce('Area cancelled.')
      } else {
        c.setRegionTool('off')
        if (c.selection?.anchor.type === 'region') c.setSelection(null)
        c.announce('Area tool off.')
      }
      return stop()
    }
    if (e.key === 'Enter') {
      if (own) {
        const anchor = regionAnchor(own.shape, own.box, optsRef.current.slide, optsRef.current.labelsIn?.(own.box))
        setDraft(null)
        c.setSelection({ anchor, description: anchorDescription(anchor) })
        window.setTimeout(() => window.dispatchEvent(new CustomEvent(NOTE_COMPOSE_EVENT)), 0)
      } else if (c.selection?.anchor.type === 'region') {
        window.dispatchEvent(new CustomEvent(NOTE_COMPOSE_EVENT))
      } else {
        setDraft({ slide: key, shape: c.regionTool, box: defaultBox(visible) })
        c.announce('Area placed. Arrow keys move it, Shift with arrows resizes it, Enter confirms, Escape cancels.')
      }
      return stop()
    }
    if (own && (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      const el = e.currentTarget as HTMLElement
      const { dx, dy } = stepFractions(visible, el.clientWidth, el.clientHeight)
      const sx = e.key === 'ArrowLeft' ? -dx : e.key === 'ArrowRight' ? dx : 0
      const sy = e.key === 'ArrowUp' ? -dy : e.key === 'ArrowDown' ? dy : 0
      setDraft({ ...own, box: e.shiftKey ? resizeBox(own.box, sx, sy) : moveBox(own.box, sx, sy) })
      return stop()
    }
    return false
  }, [])
}
