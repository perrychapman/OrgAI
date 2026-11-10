import type { Building } from '../../../lib/office/building'
import { cueFrame, officeState, type CueFrame, type OfficeState } from '../../../lib/office/cues'
import type { Direction } from '../../../lib/office/motion'
import type { DeskSet } from '../../../lib/office/themes'
import { OFFICE_TILE } from '../../../lib/office/layout'
import { WORKER_FEET, silhouettes, type OfficeAgent } from './officeArt'

/** Where a walking person is this render, in anchor pixels (the same units as a desk anchor times 16). */
export interface Walker { x: number; y: number; direction: Direction; pose: string; phase: string }
export interface Pin { x: number; y: number; direction: Direction }

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
  phase: string
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
    const frame = cueFrame({ id: agent.id, state, stateTick: null, animated: false, talking: false }, 0, mode)
    let x = desk.anchor.x * OFFICE_TILE
    let y = desk.anchor.y * OFFICE_TILE
    let direction: Direction = frame.direction
    let pose: string = frame.pose
    let phase = 'rest'
    let cue = frame.cue
    const walker = input.walkers.get(agent.id)
    if (walker && walker.phase !== 'done') {
      x = walker.x; y = walker.y; direction = walker.direction; pose = walker.pose; phase = walker.phase; cue = 'walking'
    }
    const pin = input.pinned.get(agent.id)
    if (pin) { x = pin.x; y = pin.y; direction = pin.direction; phase = 'pinned'; cue = frame.cue }
    input.rendered.set(agent.id, { x, y, direction })
    const room = building.rooms.find(candidate => candidate.id === desk.roomId)
    const set = deskSets.get(agent.id)
    const text = personText(agent, mode)
    views.push({
      id: agent.id, name: agent.name, state,
      silhouette: silhouettes[(input.appearances.get(agent.id) ?? 0) % silhouettes.length],
      x, y: y + 8 - WORKER_FEET[1] + (phase === 'rest' ? frame.offsetY : 0), depth: y + 8, anchor: { x, y }, phase,
      frame: { ...frame, pose: pose as CueFrame['pose'], direction, cue },
      desk: set ? { x: desk.furniture.x * OFFICE_TILE, y: desk.furniture.y * OFFICE_TILE, desk: set.desk, chair: set.chair } : null,
      mug: input.mugs.has(agent.id),
      roomLabel: room?.label ?? '',
      ...text
    })
  }
  return views
}
