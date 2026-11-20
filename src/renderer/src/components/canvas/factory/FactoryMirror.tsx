// The Factory Floor's DOM mirror (docs/design/factory-floor.md sections 6.3, 7.1 and 7.6): one native button per worker
// in layout reading order, positioned over the projected station footprint. In the 3D view the buttons are transparent
// (the canvas shows the stations); in the floor plan they are the station tiles, drawn over a plain backdrop of the hall
// under a straight top-down projection. Positions are written by the scene's camera callback (placeAll) through the
// placement registry, never through React state.
import { useCallback, useId, useRef, type KeyboardEvent, type ReactElement, type Ref } from 'react'
import { Activity, Check, CircleAlert, OctagonX, Pause, Square, type LucideIcon } from 'lucide-react'
import { Icon } from '../../ui/Icon'
import type { FactoryAgentInput, FloorLayout, Lamp, StationKind } from '../../../lib/factory/types'
import { projectFootprint, type Box3, type CameraView, type Stage } from '../../../lib/factory/camera'
import { routeSegments } from '../../../lib/factory/routes'
import { BOARD_SIZE, DOCK_SIZE, GANTRY_MAX_Z, GANTRY_MIN_Z, STATION_SIZE } from '../../../lib/factory/layout'

export interface MirrorEntry {
  id: string
  name: string
  kind: StationKind
  state: FactoryAgentInput['state']
  lamp: Lamp
  word: FactoryAgentInput['statusWord']
  line: number
  slot: number
  /** The hidden description (section 7.1), at most 200 characters. */
  description: string
}

/** An element the camera callback positions over a world box (its screen bounding rectangle, at least `min` px, centred). */
export interface Placement {
  el: HTMLElement
  box: Box3
  min?: number
}
export type PlacementRegistry = Map<string, Placement>

/** Writes every registered element's position and size for one view (no React state; section 9.2). */
export function placeAll(registry: PlacementRegistry, view: CameraView, stage: Stage): void {
  for (const { el, box, min = 0 } of registry.values()) {
    const r = projectFootprint(view, stage, box)
    let left = r.left
    let top = r.top
    let w = r.right - r.left
    let h = r.bottom - r.top
    if (w < min) {
      left -= (min - w) / 2
      w = min
    }
    if (h < min) {
      top -= (min - h) / 2
      h = min
    }
    el.style.transform = `translate(${Math.round(left * 10) / 10}px, ${Math.round(top * 10) / 10}px)`
    el.style.width = `${Math.round(w * 10) / 10}px`
    el.style.height = `${Math.round(h * 10) / 10}px`
  }
}

const WORD_ICON: Partial<Record<MirrorEntry['word'], LucideIcon>> = {
  Running: Activity,
  'Needs you': CircleAlert,
  Failed: OctagonX,
  Idle: Pause,
  Paused: Pause,
  Finished: Check,
  Stopped: Square
}
export function wordIcon(word: MirrorEntry['word']): LucideIcon | undefined {
  return WORD_ICON[word]
}

function accessibleName(e: MirrorEntry, mode: 'live' | 'team'): string {
  if (mode === 'team') return `${e.name}, role`
  return e.kind === 'booth' ? `${e.name}, control booth, ${e.word}` : `${e.name}, ${e.word}`
}

/** Section 7.1 hint (live wording; team adds the Delete sentence). */
export function hintText(mode: 'live' | 'team'): string {
  const base = 'Arrow keys move between workers. Enter opens a worker. Shift with arrow keys pans. Plus, minus and 0 zoom and fit.'
  return mode === 'team' ? `${base} Delete removes a role.` : base
}

/** A line sign in the floor plan: "Line {n}" over the lead's name, in the head zone at the row's centre z. */
export interface PlanSign {
  key: string
  line: number
  lead: string
  z: number
}

/** Minimum hit target (section 7.1). */
export const MIN_TARGET_PX = 24

export interface FactoryMirrorProps {
  mode: 'live' | 'team'
  entries: readonly MirrorEntry[]
  renderer: 'webgl2' | 'floor-plan'
  layout: FloorLayout
  selectedId?: string
  /** The one Tab stop (section 6.3). */
  tabStopId: string | null
  /** World box of a worker's button (footprint with height in 3D). */
  boxFor(id: string): Box3
  registry: PlacementRegistry
  /** Worker buttons by id (focus, focusWorker). */
  buttons: Map<string, HTMLButtonElement>
  /** Live, with a plan: the board is on the floor (backdrop label in the plan). */
  board: boolean
  /** Floor plan: line signs drawn in the head zone (the 3D view's signs are labels). */
  planSigns: readonly PlanSign[]
  onSelect(id: string): void
  /** Keys on a worker button (navigation, camera, remove); the scene decides. */
  onKey(id: string, e: KeyboardEvent<HTMLButtonElement>): void
  /** A worker button got focus; `pointer` when a press caused it (no pan). */
  onFocusWorker(id: string, pointer: boolean): void
  onBlurWorker(id: string): void
  onHover(id: string | null): void
  mirrorRef?: Ref<HTMLDivElement>
}

export function FactoryMirror(props: FactoryMirrorProps): ReactElement {
  const { mode, entries, renderer, layout, selectedId, tabStopId, boxFor, registry, buttons, board, planSigns, onSelect, onKey, onFocusWorker, onBlurWorker, onHover, mirrorRef } = props
  const n = entries.length
  const label = mode === 'team' ? `Factory floor, ${n} ${n === 1 ? 'role' : 'roles'}` : `Factory floor, ${n} ${n === 1 ? 'worker' : 'workers'}`
  const plan = renderer === 'floor-plan'
  const pressed = useRef<string | null>(null)
  const idBase = `factory${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const hintId = `${idBase}-hint`

  const place = useCallback(
    (key: string, box: Box3, min?: number) => (el: HTMLElement | null) => {
      if (el) registry.set(key, { el, box, min })
      else registry.delete(key)
    },
    [registry]
  )

  const tile = (e: MirrorEntry, i: number): ReactElement => {
    const glyph = mode === 'live' ? WORD_ICON[e.word] : undefined
    const descId = `${idBase}-d${i}`
    const ref = place(`worker:${e.id}`, boxFor(e.id), MIN_TARGET_PX)
    return (
      <button
        key={e.id}
        ref={(el) => {
          ref(el)
          if (el) buttons.set(e.id, el)
          else buttons.delete(e.id)
        }}
        type="button"
        className="factory-worker"
        data-testid="factory-worker"
        data-factory-worker-id={e.id}
        data-state={e.state}
        data-lamp={e.lamp}
        data-kind={e.kind}
        data-line={e.line}
        data-slot={e.slot}
        tabIndex={e.id === tabStopId ? 0 : -1}
        aria-label={accessibleName(e, mode)}
        aria-describedby={e.description ? descId : undefined}
        aria-current={selectedId === e.id ? 'true' : undefined}
        onPointerDown={() => {
          pressed.current = e.id
        }}
        onFocus={() => {
          const pointer = pressed.current === e.id
          pressed.current = null
          onFocusWorker(e.id, pointer)
        }}
        onBlur={() => onBlurWorker(e.id)}
        onPointerEnter={() => onHover(e.id)}
        onPointerLeave={() => onHover(null)}
        onClick={() => onSelect(e.id)}
        onKeyDown={(ev) => onKey(e.id, ev)}
      >
        {e.description && (
          <span id={descId} hidden>
            {e.description}
          </span>
        )}
        {plan && (
          <span className="factory-worker-face" aria-hidden="true">
            <span className="factory-worker-name">{e.name}</span>
            {e.kind === 'booth' && <span className="factory-worker-kind">Control booth</span>}
            {mode === 'live' && (
              <span className="factory-worker-status">
                {glyph && <Icon icon={glyph} size="xs" />}
                <span className="factory-worker-word">{e.word}</span>
              </span>
            )}
          </span>
        )}
      </button>
    )
  }

  const hall = layout.hall
  const flat = (minX: number, maxX: number, minZ: number, maxZ: number): Box3 => ({ minX, maxX, minY: 0, maxY: 0, minZ, maxZ })
  const rectBox = (c: { x: number; z: number }, w: number, d: number): Box3 => flat(c.x - w / 2, c.x + w / 2, c.z - d / 2, c.z + d / 2)

  return (
    <div ref={mirrorRef} className="factory-mirror" data-renderer={renderer} role="group" aria-label={label} aria-describedby={hintId} data-testid="factory-floor">
      <span id={hintId} hidden>
        {hintText(mode)}
      </span>
      {plan && (
        <div className="factory-plan" aria-hidden="true">
          <div className="factory-plan-hall" ref={place('plan:hall', flat(hall.minX, hall.maxX, hall.minZ, hall.maxZ))} />
          <div className="factory-plan-gantry" ref={place('plan:gantry', flat(hall.minX, hall.maxX, GANTRY_MIN_Z, GANTRY_MAX_Z))} />
          {mode === 'live' && (
            <div className="factory-plan-zone" ref={place('plan:dock', rectBox(layout.dock, DOCK_SIZE.w, DOCK_SIZE.d))}>
              <span>Main checkout</span>
            </div>
          )}
          {mode === 'live' && board && (
            <div className="factory-plan-zone" ref={place('plan:board', rectBox(layout.board, BOARD_SIZE.w, BOARD_SIZE.d + 0.6))}>
              <span>Plan</span>
            </div>
          )}
          {routeSegments(layout.routes).map((s, i) => {
            const horizontal = Math.abs(Math.cos(s.rotY)) > 0.5
            const half = s.length / 2
            const w = 0.2
            const box = horizontal ? flat(s.center.x - half, s.center.x + half, s.center.z - w / 2, s.center.z + w / 2) : flat(s.center.x - w / 2, s.center.x + w / 2, s.center.z - half, s.center.z + half)
            return <div key={`r${i}`} className="factory-plan-route" ref={place(`plan:route:${i}`, box)} />
          })}
          {planSigns.map((s) => (
            <div key={s.key} className="factory-plan-sign" data-testid="factory-line-sign" data-line={s.line} data-shown="true" ref={place(`plan:sign:${s.key}`, flat(0.2, 3.8, s.z - 1.3, s.z + 1.3))}>
              <span className="factory-plan-sign-line">Line {s.line}</span>
              <span className="factory-plan-sign-lead">{s.lead}</span>
            </div>
          ))}
          {layout.vacant.map((v) => (
            <div key={v.id} className="factory-plan-vacant" ref={place(`plan:vacant:${v.id}`, rectBox(v.center, STATION_SIZE, STATION_SIZE))} />
          ))}
        </div>
      )}
      {entries.map(tile)}
    </div>
  )
}
