import type { Building } from '../../../lib/office/building'
import { cueFrame, officeState, type CueFrame, type CuePerson, type OfficeCue, type OfficeState } from '../../../lib/office/cues'
import type { Direction } from '../../../lib/office/motion'
import type { DeskSet } from '../../../lib/office/themes'
import { OFFICE_TILE } from '../../../lib/office/layout'
import { silhouettes, spriteTop, type OfficeAgent } from './officeArt'

/** Where a walking person is this render, in anchor pixels (the same units as a desk anchor times 16). `cue` defaults to `walking`; arrivals say `arriving`. */
export interface Walker { x: number; y: number; direction: Direction; pose: string; phase: string; cue?: OfficeCue }
export interface Pin { x: number; y: number; direction: Direction }

/** What the clock (`useOfficeClock`) tells a render so React and the imperative frames agree: the clock's tick and each person's cue inputs. */
export interface PersonCues { tick: number; person(id: string, state: OfficeState): CuePerson }

/** Everything `OfficeSprites` needs to draw one person: pure data, no DOM. */
export interface PersonView {
  id: string
  name: string
  state: OfficeState
  silhouette: string
  /** Sprite top-left in building pixels (what `data-office-x/y` reports). */
  x: number
  y: number
  depth: number
  /** The anchor the sprite stands on, building pixels. */
  anchor: { x: number; y: number }
  /** The desk anchor (where the person sits), building pixels. */
  home: { x: number; y: number }
  phase: string
  /** At the desk this render (rest, or focus-pinned at the desk): the clock may change this person's frames. */
  seated: boolean
  /** Built from an arrival walk: the clock owns the position until the walk ends. */
  arrival: boolean
  /** Waiting for a walk slot outside the building: not drawn yet. */
  queued: boolean
  frame: CueFrame
  /** Desk furniture top-left in building pixels, with the art names. */
  desk: { x: number; y: number; desk: string; chair: string } | null
  mug: boolean
  roomLabel: string
  /** Plate second line: the status word in Live, the department in Team. */
  line: string
  ariaLabel: string
  title: string
}

export interface PeopleInput {
  /** Agents in building order (lobby first, then rooms in sequence, slot order). */
  order: readonly OfficeAgent[]
  building: Building
  deskSets: ReadonlyMap<string, DeskSet>
  /** Agent ids that sit behind a `mug` prop (drawn above their desk). */
  mugs: ReadonlySet<string>
  appearances: ReadonlyMap<string, number>
  mode: 'live' | 'team' | 'sample'
  walkers: ReadonlyMap<string, Walker>
  pinned: ReadonlyMap<string, Pin>
  /** Written for every person: where the sprite stands this render (focus pins it there). */
  rendered: Map<string, Pin>
  /** Clock inputs for this render; without them every person is drawn in the static frame (Team, Sample, tests). */
  cues?: PersonCues
  /** Arrivals waiting for a walk slot: no person is drawn for them yet. */
  queued?: ReadonlySet<string>
}

/** Agents whose desk carries a `mug` prop from the room look (drawn in `OfficeSprites`, above the desk). */
export function mugOwners(building: Building, props: readonly { name: string; x: number; y: number }[]): Set<string> {
  const mugs = new Set(props.filter(prop => prop.name === 'mug').map(prop => `${prop.x},${prop.y}`))
  const owners = new Set<string>()
  for (const desk of building.desks.values()) if (mugs.has(`${desk.furniture.x},${desk.furniture.y}`)) owners.add(desk.agentId)
  return owners
}

const sentence =(agent: OfficeAgent): string => `${agent.statusLabel ?? agent.status}${agent.context ? `, ${agent.context}` : ''}`

/** Plate text and names for one person (section 7: Team shows the department, Live the status word). */
export function personText(agent: OfficeAgent, mode: 'live' | 'team' | 'sample'): { line: string; ariaLabel: string; title: string } {
  if (mode === 'team') {
    const department = agent.central ? 'Orchestrators' : agent.departmentName
    return { line: department, ariaLabel: `${agent.name}, ${department}`, title: `${agent.name} · ${department}` }
  }
  return {
    line: agent.statusLabel ?? agent.status,
    ariaLabel: `${agent.name}, ${sentence(agent)}`,
    title: `${agent.name} · ${agent.statusLabel ?? agent.status}${agent.context ? ` · ${agent.context}` : ''}`
  }
}

export function buildPersonViews(input: PeopleInput): PersonView[] {
  const { building, deskSets, mode } = input
  const views: PersonView[] = []
  for (const agent of input.order) {
    const desk = building.desks.get(agent.id)
    if (!desk) continue
    const state = officeState(agent.status)
    const person = input.cues?.person(agent.id, state) ?? { id: agent.id, state, stateTick: null, animated: false, talking: false }
    const frame = cueFrame(person, input.cues?.tick ?? 0, mode)
    const homeX = desk.anchor.x * OFFICE_TILE
    const homeY = desk.anchor.y * OFFICE_TILE
    let x = homeX
    let y = homeY
    let direction: Direction = frame.direction
    let pose: string = frame.pose
    let phase = 'rest'
    let cue = frame.cue
    let seated = true
    let arrival = false
    const walker = input.walkers.get(agent.id)
    if (walker && walker.phase !== 'done') {
      x = walker.x; y = walker.y; direction = walker.direction; pose = walker.pose; phase = walker.phase; cue = walker.cue ?? 'walking'
      seated = false
      arrival = walker.cue === 'arriving' || walker.phase === 'arrive' || walker.phase === 'sit'
    }
    const pin = input.pinned.get(agent.id)
    let rendered: Pin = { x, y, direction }
    if (pin) {
      const atDesk = pin.x === homeX && pin.y === homeY
      x = pin.x; y = pin.y; direction = atDesk ? frame.direction : pin.direction; phase = 'pinned'; cue = frame.cue; seated = atDesk; arrival = false
      rendered = { x, y, direction }
    } else if (arrival) rendered = { x: homeX, y: homeY, direction: 'up' } // focus during an arrival seats the person at the desk
    input.rendered.set(agent.id, rendered)
    const room = building.rooms.find(candidate => candidate.id === desk.roomId)
    const set = deskSets.get(agent.id)
    const text = personText(agent, mode)
    views.push({
      id: agent.id, name: agent.name, state,
      silhouette: silhouettes[(input.appearances.get(agent.id) ?? 0) % silhouettes.length],
      x, y: spriteTop(y) + (seated ? frame.offsetY : 0), depth: y + 8, anchor: { x, y }, home: { x: homeX, y: homeY }, phase, seated, arrival,
      queued: input.queued?.has(agent.id) ?? false,
      frame: { ...frame, pose: pose as CueFrame['pose'], direction, cue },
      desk: set ? { x: desk.furniture.x * OFFICE_TILE, y: desk.furniture.y * OFFICE_TILE, desk: set.desk, chair: set.chair } : null,
      mug: input.mugs.has(agent.id),
      roomLabel: room?.label ?? '',
      ...text
    })
  }
  return views
}
