// Factory Floor labels (docs/design/factory-floor.md section 6.2): nameplates above stations, line signs in the head
// zone, the dock and plan board labels. DOM text only, on plates in the theme's tokens. React renders every candidate
// once per model change (hidden); the scene's camera callback calls update(), which projects anchors, runs the pure
// placeLabels (priority, collision, cap 24) and writes transform and visibility directly. The layer is aria-hidden: the
// mirror carries the same names and words for assistive technology.
import { useImperativeHandle, useLayoutEffect, useRef, type ReactElement, type Ref } from 'react'
import { Icon } from '../../ui/Icon'
import { project, type CameraView, type Stage, type Vec3 } from '../../../lib/factory/camera'
import { placeLabels, labelKey, type LabelCandidate, type LabelKind, type LabelReason } from '../../../lib/factory/labels'
import { GANTRY_TOP } from '../../../lib/factory/layout'
import { wordIcon, type MirrorEntry } from './FactoryMirror'

export interface LabelFocus {
  selectedId: string | null
  focusedId: string | null
  hoveredId: string | null
}

export interface FactoryLabelsHandle {
  update(view: CameraView, stage: Stage, focus: LabelFocus): void
}

export interface NameplateData {
  entry: MirrorEntry
  activity: string
  /** World anchor of the plate's bottom centre. */
  anchor: Vec3
  /** The worker's branch has a merge conflict. */
  conflict: boolean
}

export interface SignData {
  key: string
  line: number
  text: string
  anchor: Vec3
}

export interface FactoryLabelsProps {
  mode: 'live' | 'team'
  /** Nameplates show in the 3D view only (the floor plan's tiles carry the same text). */
  plates: readonly NameplateData[]
  signs: readonly SignData[]
  dock?: { text: string; anchor: Vec3 } | null
  board?: { text: string; anchor: Vec3 } | null
  handleRef?: Ref<FactoryLabelsHandle>
}

/** Section 6.2: the name is cut at 18 characters, the activity at 40 (full text stays in the mirror's name). */
export function clip(text: string, max: number): string {
  const t = text.trim()
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t
}

const GAP = 4

function baseReason(p: NameplateData): LabelReason {
  if (p.entry.lamp === 'needs-you') return 'needs-you'
  if (p.entry.lamp === 'failed') return 'failed'
  if (p.conflict) return 'conflict'
  return 'other'
}

export function FactoryLabels({ mode, plates, signs, dock, board, handleRef }: FactoryLabelsProps): ReactElement {
  const els = useRef(new Map<string, HTMLElement>())
  const sizes = useRef(new Map<string, { w: number; h: number }>())
  const latest = useRef({ plates, signs, dock, board })
  latest.current = { plates, signs, dock, board }

  // Text changed: measure again on the next update.
  useLayoutEffect(() => {
    sizes.current.clear()
  }, [plates, signs, dock, board])

  useImperativeHandle(handleRef, () => ({
    update(view: CameraView, stage: Stage, focus: LabelFocus) {
      const { plates: ps, signs: ss, dock: d, board: b } = latest.current
      const size = (key: string): { w: number; h: number } | null => {
        const cached = sizes.current.get(key)
        if (cached) return cached
        const el = els.current.get(key)
        if (!el) return null
        const s = { w: el.offsetWidth, h: el.offsetHeight }
        sizes.current.set(key, s)
        return s
      }
      const candidates: LabelCandidate[] = []
      const where = new Map<string, { left: number; top: number }>()
      const add = (kind: LabelKind, id: string, anchor: Vec3, order: number, align: 'above' | 'left', reason?: LabelReason): void => {
        const key = labelKey({ kind, id })
        const s = size(key)
        if (!s) return
        const p = project(view, stage, anchor)
        if (p.depth <= 0) return
        const left = align === 'above' ? p.x - s.w / 2 : p.x
        const top = align === 'above' ? p.y - s.h - GAP : p.y - s.h / 2
        where.set(key, { left, top })
        candidates.push({ id, kind, reason, order, rect: { left, top, right: left + s.w, bottom: top + s.h } })
      }
      ps.forEach((p, i) => {
        const id = p.entry.id
        const reason: LabelReason =
          id === focus.selectedId ? 'selected' : id === focus.focusedId ? 'focused' : id === focus.hoveredId ? 'hovered' : baseReason(p)
        add('nameplate', id, p.anchor, i, 'above', reason)
      })
      ss.forEach((s, i) => add('sign', s.key, s.anchor, i, 'left'))
      if (d) add('dock', 'dock', d.anchor, 0, 'above')
      if (b) add('board', 'board', b.anchor, 0, 'above')
      const shown = new Set(placeLabels(candidates, { ppm: view.ppm, stage }))
      for (const [key, el] of els.current) {
        const at = where.get(key)
        const on = !!at && shown.has(key)
        if (on) el.style.transform = `translate(${Math.round(at.left)}px, ${Math.round(at.top)}px)`
        if ((el.getAttribute('data-shown') === 'true') !== on) el.setAttribute('data-shown', on ? 'true' : 'false')
      }
    }
  }), [])

  const reg = (key: string) => (el: HTMLElement | null): void => {
    if (el) els.current.set(key, el)
    else els.current.delete(key)
  }

  return (
    <div className="factory-labels" aria-hidden="true">
      {plates.map((p) => {
        const glyph = mode === 'live' ? wordIcon(p.entry.word) : undefined
        const activity = clip(p.activity, 40)
        return (
          <div key={p.entry.id} ref={reg(labelKey({ kind: 'nameplate', id: p.entry.id }))} className="factory-nameplate" data-testid="factory-nameplate" data-factory-worker-id={p.entry.id} data-lamp={p.entry.lamp} data-shown="false">
            <span className="factory-nameplate-name">{clip(p.entry.name, 18)}</span>
            {mode === 'live' && (
              <span className="factory-nameplate-status">
                {glyph && <Icon icon={glyph} size="xs" />}
                <span>{p.entry.word}</span>
                {activity && <span className="factory-nameplate-activity">· {activity}</span>}
              </span>
            )}
          </div>
        )
      })}
      {signs.map((s) => (
        <div key={s.key} ref={reg(labelKey({ kind: 'sign', id: s.key }))} className="factory-line-sign" data-testid="factory-line-sign" data-line={s.line} data-shown="false">
          {s.text}
        </div>
      ))}
      {dock && (
        <div ref={reg(labelKey({ kind: 'dock', id: 'dock' }))} className="factory-zone-label" data-testid="factory-dock" data-shown="false">
          {dock.text}
        </div>
      )}
      {board && (
        <div ref={reg(labelKey({ kind: 'board', id: 'board' }))} className="factory-zone-label" data-testid="factory-board-label" data-shown="false">
          {board.text}
        </div>
      )}
    </div>
  )
}

/** Height above the deck of the dock and board labels when the kits give no anchor. */
export const ZONE_LABEL_Y = GANTRY_TOP + 0.6
