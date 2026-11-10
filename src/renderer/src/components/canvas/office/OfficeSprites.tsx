import { memo, type CSSProperties, type KeyboardEvent, type MutableRefObject, type ReactElement } from 'react'
import type { OfficeMarkName } from '../../../lib/office/cues'
import { OFFICE_TILE_PX, type Rect } from '../../../lib/office/camera'
import { depthOffset, frameBackground, propFrames, sheetsFor, workerFrames, workerFrameName, WORKER_SIZE, type OfficePalette } from './officeArt'
import type { PersonView } from './officePeople'

/**
 * Desks, people art, state marks and the native person buttons (rework spec sections 2, 7 and 8).
 *
 * Imperative seam for the clock (slice S4): every person registers its elements in `spriteRefs`, so frames can change
 * without a React render:
 *   art    the 16 x 24 worker sprite; write `style.backgroundPosition` (a frame's `-x px -y px`) and `style.top`
 *   screen the desk's `crt` frame (`prop.crt`, `crt-b`, `crt-off`, `crt-error`); write `style.backgroundPosition`
 *   mark   a 16 x 16 element above the head, always rendered; hidden and without `data-testid` when no mark shows.
 *          To show one write `hidden = false`, `dataset.mark`, `setAttribute('data-testid', 'office-mark')` and the
 *          `prop.mark-*` background position.
 *   button the native person button; plate the nameplate inside it
 * A React render rewrites the static frame, so a clock that owns an element must keep the same values it wrote.
 */
export interface SpriteRefs {
  art: HTMLElement | null
  screen: HTMLElement | null
  mark: HTMLElement | null
  button: HTMLButtonElement | null
  plate: HTMLElement | null
}
export type SpriteRegistry = MutableRefObject<Map<string, SpriteRefs>>

export interface OfficeSpritesProps {
  /** People in building order: this is the Tab order. */
  people: readonly PersonView[]
  area: Rect
  zoom: number
  palette: OfficePalette
  /** Pause motion is on: the clock (S4) must not run. */
  paused: boolean
  selectedId?: string
  /** The person the Find ring is drawn on. */
  foundId: string | null
  /** People in a message exchange: their plates show at every zoom, inverted (S5b). */
  exchangeIds?: ReadonlySet<string>
  spriteRefs: SpriteRegistry
  onSelect(id: string): void
  onRemove?(id: string): void
  /** A person got keyboard focus: bring them into view. */
  onReveal(id: string): void
}

function register(registry: SpriteRegistry, id: string, key: keyof SpriteRefs, element: HTMLElement | null): void {
  const entry = registry.current.get(id) ?? { art: null, screen: null, mark: null, button: null, plate: null }
  ;(entry as unknown as Record<string, HTMLElement | null>)[key] = element
  if (Object.values(entry).every(value => value === null)) registry.current.delete(id)
  else registry.current.set(id, entry)
}

interface DeskProps { id: string; x: number; y: number; desk: string; chair: string; screen: string; mug: boolean; propSheet: string; registry: SpriteRegistry }
/** Chair, desk, optional mug and the screen. The screen frame is the one thing the clock changes. */
const Desk = memo(function Desk({ id, x, y, desk, chair, screen, mug, propSheet, registry }: DeskProps): ReactElement {
  const place = (name: string, left: number, extra = 0): CSSProperties => ({ left, top: y, zIndex: y + depthOffset(name) + extra, ...frameBackground(propFrames[`prop.${name}`], propSheet) })
  return <>
    <i className="office-sprite office-desk-part" data-office-desk-for={id} style={place(chair, x + 2 * OFFICE_TILE_PX)} />
    <i className="office-sprite office-desk-part" data-office-desk-for={id} style={place(desk, x)} />
    {mug && <i className="office-sprite office-desk-part" data-office-desk-for={id} style={place('mug', x, 1)} />}
    <i className="office-sprite office-screen" data-office-screen-for={id} data-office-screen={screen} ref={element => register(registry, id, 'screen', element)} style={place(screen, x, 2)} />
  </>
})

interface ArtProps {
  id: string; silhouette: string; direction: string; pose: string; x: number; y: number; depth: number
  state: string; phase: string; cue: string; mark: OfficeMarkName | null; workerSheet: string; propSheet: string; registry: SpriteRegistry
}
const Art = memo(function Art({ id, silhouette, direction, pose, x, y, depth, state, phase, cue, mark, workerSheet, propSheet, registry }: ArtProps): ReactElement {
  const frame = workerFrames[workerFrameName(silhouette, direction, pose)] ?? workerFrames[workerFrameName(silhouette, 'down', 'idle')]
  const markFrame = mark ? propFrames[`prop.mark-${mark}`] : null
  return <>
    <i
      className="office-sprite office-person-art" data-office-sprite-id={id} data-office-motion-phase={phase} data-office-x={x} data-office-y={y}
      data-office-state={state} data-office-cue={cue} ref={element => register(registry, id, 'art', element)}
      style={{ left: x, top: y, zIndex: depth, ...frameBackground(frame, workerSheet) }}
    />
    <i
      className="office-sprite office-mark" aria-hidden="true" hidden={!mark} data-agent-id={id} data-mark={mark ?? undefined}
      data-testid={mark ? 'office-mark' : undefined} ref={element => register(registry, id, 'mark', element)}
      style={{ left: x, top: y - 13, zIndex: depth + 1000, ...(markFrame ? frameBackground(markFrame, propSheet) : { width: 16, height: 16 }) }}
    />
  </>
})

interface TargetProps {
  id: string; name: string; line: string; ariaLabel: string; title: string
  left: number; top: number; width: number; height: number
  selected: boolean; found: boolean; exchange: boolean
  registry: SpriteRegistry
  onSelect(id: string): void; onRemove?(id: string): void; onReveal(id: string): void
}
const Target = memo(function Target({ id, name, line, ariaLabel, title, left, top, width, height, selected, found, exchange, registry, onSelect, onRemove, onReveal }: TargetProps): ReactElement {
  return <button
    type="button" className="office-person" data-office-worker-id={id} data-testid="pocket-office-agent" data-agent-id={id}
    data-office-found={found ? 'true' : undefined} data-office-exchange={exchange ? 'true' : undefined}
    aria-label={ariaLabel} aria-pressed={selected} title={title} ref={element => register(registry, id, 'button', element)}
    style={{ left, top, width, height }}
    onClick={() => onSelect(id)}
    onFocus={event => { if (event.currentTarget.matches(':focus-visible')) onReveal(id) }}
    onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => { if (event.key === 'Delete' && onRemove) { event.preventDefault(); onRemove(id) } }}
  >
    <span className="office-person-label" ref={element => register(registry, id, 'plate', element)}>
      <span className="office-person-name">{name}</span>
      <span className="office-person-line">{line}</span>
    </span>
  </button>
})

/** Target size and position for a sprite at `zoom`: 16 x 24 sprite, but never smaller than 24 x 24 CSS px. */
export function targetBox(x: number, y: number, area: Rect, zoom: number): { left: number; top: number; width: number; height: number } {
  const width = Math.max(24, WORKER_SIZE.width * zoom)
  const height = Math.max(24, WORKER_SIZE.height * zoom)
  const centreX = (x + WORKER_SIZE.width / 2 - area.x * OFFICE_TILE_PX) * zoom
  const centreY = (y + WORKER_SIZE.height / 2 - area.y * OFFICE_TILE_PX) * zoom
  return { left: Math.round(centreX - width / 2), top: Math.round(centreY - height / 2), width, height }
}

export function OfficeSprites({ people, area, zoom, palette, paused, selectedId, foundId, exchangeIds, spriteRefs, onSelect, onRemove, onReveal }: OfficeSpritesProps): ReactElement {
  const sheets = sheetsFor(palette)
  return <>
    <div
      className="office-pixels" aria-hidden="true" data-office-paused={paused ? 'true' : undefined}
      style={{ width: area.width * OFFICE_TILE_PX, height: area.height * OFFICE_TILE_PX, transform: `scale(${zoom}) translate(${-area.x * OFFICE_TILE_PX}px, ${-area.y * OFFICE_TILE_PX}px)` }}
    >
      {people.map(person => person.desk && <Desk key={`desk-${person.id}`} id={person.id} x={person.desk.x} y={person.desk.y} desk={person.desk.desk} chair={person.desk.chair} screen={`${person.frame.screen}`} mug={person.mug} propSheet={sheets.props} registry={spriteRefs} />)}
      {people.map(person => <Art
        key={`art-${person.id}`} id={person.id} silhouette={person.silhouette} direction={person.frame.direction} pose={person.frame.pose}
        x={person.x} y={person.y} depth={person.depth} state={person.state} phase={person.phase} cue={person.frame.cue} mark={person.frame.mark}
        workerSheet={sheets.workers} propSheet={sheets.props} registry={spriteRefs}
      />)}
    </div>
    <div className="office-people">
      {people.map(person => <Target
        key={`target-${person.id}`} id={person.id} name={person.name} line={person.line} ariaLabel={person.ariaLabel} title={person.title}
        {...targetBox(person.x, person.y, area, zoom)} selected={person.id === selectedId} found={person.id === foundId} exchange={exchangeIds?.has(person.id) ?? false}
        registry={spriteRefs} onSelect={onSelect} onRemove={onRemove} onReveal={onReveal}
      />)}
    </div>
  </>
}
