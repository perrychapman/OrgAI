import { useCallback, useImperativeHandle, useMemo, useRef, useState, type CSSProperties, type Ref } from 'react'
import type { AgentMessage } from '@shared/types'
import { useReducedMotion } from '../../../lib/canvas'
import { buildingBlocked, buildingLayout, EMPTY_BUILDING_MEMORY, rememberTeam, type BuildingMemory } from '../../../lib/office/building'
import { cameraArea, contentSize, mapOffset, zoomLabel, zoomName, OFFICE_TILE_PX, type Point } from '../../../lib/office/camera'
import { assignAppearances } from '../../../lib/office/layout'
import type { Point as WalkPoint } from '../../../lib/office/motion'
import { furnishBuilding } from '../../../lib/office/themes'
import { Button } from '../../ui/Button'
import { useFrameAnnounce } from '../../layout/CanvasFrame'
import { recentMessages } from '../../../lib/office/messageCursor'
import { activeBubbles } from '../../../lib/office/scheduler'
import { applyBubbleTiming, bubbleKey, bubbleTiming, exchangeParticipants, OfficeBubbles, useDeliveryBoundaries, type OfficeBubble } from './OfficeBubbles'
import { OfficeBuilding, OfficeRoomLabels, TABLETOP_PROPS } from './OfficeBuilding'
import { OfficeDirectory } from './OfficeDirectory'
import { OfficeSprites, type SpriteRefs } from './OfficeSprites'
import { OfficeStrip } from './OfficeStrip'
import { silhouettes, WORKER_FEET, type OfficeAgent, type OfficePalette } from './officeArt'
import { buildPersonViews, mugOwners } from './officePeople'
import { OfficeOffscreen, type OffscreenItem } from './OfficeOffscreen'
import { officeState } from '../../../lib/office/cues'
import { useOfficeCamera } from './useOfficeCamera'
import { useOfficeClock } from './useOfficeClock'
import { useOfficeDeliveries } from './useOfficeDeliveries'
import '../../../styles/office.css'

export type { OfficeAgent } from './officeArt'
export interface OfficeSceneHandle { zoomIn(): void; zoomOut(): void; fit(): void }
export interface OfficeSceneProps {
  agents: OfficeAgent[]; messages: AgentMessage[]; onSelect(id: string): void; onRemove?(id: string): void
  selectedId?: string; mode: 'live' | 'team' | 'sample'; runId?: string
  palette?: OfficePalette; controlRef?: Ref<OfficeSceneHandle>
}

/** One building per team (rework spec section 1): wiring only. Layout, camera and deliveries live in their own modules. */
export function OfficeScene({ agents: allAgents, messages, onSelect, onRemove, selectedId, mode, runId, palette = 'color', controlRef }: OfficeSceneProps) {
  const agents = mode === 'sample' ? allAgents.slice(0, 1) : allAgents
  const reduced = useReducedMotion()
  const announce = useFrameAnnounce()
  const [paused, setPaused] = useState(false)
  const motionOff = reduced || paused
  const stage = useRef<HTMLDivElement>(null)
  const spriteRefs = useRef(new Map<string, SpriteRefs>())
  const arriving = useRef(new Map<string, readonly WalkPoint[]>()) // arrival walks in progress (clock-owned, read by deliveries)

  // Memory: slots and first-seen order survive for a live run (nobody moves when someone leaves); Team uses input order.
  const memory = useRef<BuildingMemory>(EMPTY_BUILDING_MEMORY)
  const memoryRun = useRef(runId)
  if (memoryRun.current !== runId) { memory.current = EMPTY_BUILDING_MEMORY; memoryRun.current = runId }
  const layoutAgents = agents.map(({ id, departmentId, departmentName, central }) => ({ id, departmentId, departmentName, central }))
  memory.current = mode === 'live' ? rememberTeam(memory.current, layoutAgents) : EMPTY_BUILDING_MEMORY
  const appearances = useRef(new Map<string, number>())
  appearances.current = assignAppearances(appearances.current, agents.map(agent => agent.id), silhouettes.length)

  const layoutKey = JSON.stringify(layoutAgents)
  const remembered = memory.current
  const building = useMemo(() => buildingLayout(layoutAgents, remembered, mode), [layoutKey, remembered, mode]) // eslint-disable-line react-hooks/exhaustive-deps
  const furnished = useMemo(() => furnishBuilding(building), [building])
  const staticProps = useMemo(() => furnished.props.filter(prop => !TABLETOP_PROPS.has(prop.name)), [furnished])
  const blocked = useMemo(() => buildingBlocked(building, furnished.props), [building, furnished])
  const mugs = useMemo(() => mugOwners(building, furnished.props), [building, furnished])
  const area = useMemo(() => cameraArea(building.bounds, building.frontDoor !== null), [building])
  const lobby = building.rooms.find(room => room.kind === 'lobby') ?? null
  const byId = new Map(agents.map(agent => [agent.id, agent]))
  const order = building.rooms.flatMap(room => room.agents).map(id => byId.get(id)).filter((agent): agent is OfficeAgent => !!agent)
  const rooms = new Map(order.map(agent => [agent.id, building.rooms.find(room => room.id === building.desks.get(agent.id)?.roomId)?.label ?? '']))
  /** Sprite top-left at rest, building pixels: the camera tracks these through layout changes. */
  const positions = useMemo(() => {
    const result = new Map<string, Point>()
    for (const [id, desk] of building.desks) result.set(id, { x: desk.anchor.x * OFFICE_TILE_PX, y: desk.anchor.y * OFFICE_TILE_PX + 8 - WORKER_FEET[1] })
    return result
  }, [building])

  const camera = useOfficeCamera({
    stage, area, lobby: lobby ? { x: lobby.x, y: lobby.y, width: lobby.width, height: lobby.height } : null, resetKey: runId, motionOff, selectedId, positions,
    describe: id => { const agent = byId.get(id); const room = rooms.get(id); return agent ? `Showing ${agent.name}${room && room !== agent.name ? `, ${room}` : ''}` : null }, announce
  })
  const deliveries = useOfficeDeliveries({ messages, mode, runId, motionOff, building, blocked, agentIds: order.map(agent => agent.id), arriving })
  // S5b: bubbles and the exchange pair come from the same deliveries; readable time from the tokens.
  const bubbleTimings = useMemo(bubbleTiming, [])
  applyBubbleTiming(deliveries.deliveries, bubbleTimings)
  useDeliveryBoundaries(deliveries.deliveries, motionOff, deliveries.now)
  const clock = useOfficeClock({ mode, runId, motionOff, building, blocked, area, zoom: camera.zoom, order, selectedId, deliveries, spriteRefs, arriving })
  const people = buildPersonViews({
    order, building, deskSets: furnished.deskSets, mugs, appearances: appearances.current, mode, walkers: clock.withArrivals(deliveries.walkers), pinned: deliveries.pinned, rendered: deliveries.rendered,
    cues: clock.cues, queued: clock.queued
  })
  clock.bind(people)

  const latest = useRef({ byId, onSelect, onRemove, announce, show: camera.show, reveal: camera.reveal, queued: clock.queued })
  latest.current = { byId, onSelect, onRemove, announce, show: camera.show, reveal: camera.reveal, queued: clock.queued }
  const selectId = useCallback((id: string) => {
    const agent = latest.current.byId.get(id)
    latest.current.onSelect(id)
    if (agent) latest.current.announce?.(`${agent.name}, ${agent.statusLabel ?? agent.status}${agent.context ? `, ${agent.context}` : ''}, selected`)
  }, [])
  const removeId = useCallback((id: string) => latest.current.onRemove?.(id), [])
  const revealId = useCallback((id: string) => latest.current.reveal(id), [])
  /** Select, then pan to and ring the person (Find a person; the strip's Show buttons use this too). One announcement: "Showing ...". */
  // Someone still waiting outside to walk in is not drawn yet: select them (the inspector opens) but do not pan, ring or announce a spot they are not at.
  const showPerson = useCallback((id: string) => { latest.current.onSelect(id); if (!latest.current.queued.has(id)) latest.current.show(id) }, [])

  useImperativeHandle(controlRef, () => ({ zoomIn: camera.zoomIn, zoomOut: camera.zoomOut, fit: camera.fit }), [camera.zoomIn, camera.zoomOut, camera.fit])

  const { zoom, client } = camera
  const content = contentSize({ area, zoom })
  const offset = mapOffset({ area, zoom, client })
  const names = new Map(agents.map(agent => [agent.id, agent.name]))
  const positionsNow = new Map(people.map(person => [person.id, { x: person.x, y: person.y }]))
  const bubbles: OfficeBubble[] = activeBubbles({ ...deliveries.scheduler, active: [...deliveries.deliveries] }, deliveries.now)
    .map(delivery => ({ id: bubbleKey(delivery), to: delivery.message.to!, from: delivery.message.from, sender: names.get(delivery.message.from) ?? delivery.message.from, text: delivery.message.text }))
  const exchangeIds = exchangeParticipants(deliveries.deliveries, deliveries.now)
  // People a cue is happening on right now (a bubble, or Needs you); the off-screen chips name the ones outside the stage.
  const cueItems: OffscreenItem[] = mode !== 'live' ? [] : [
    ...order.filter(agent => officeState(agent.status) === 'waiting').map(agent => ({ id: agent.id, name: agent.name, reason: 'needs you' as const })),
    ...bubbles.filter(bubble => byId.get(bubble.to)?.status !== 'waiting').map(bubble => ({ id: bubble.to, name: names.get(bubble.to) ?? bubble.to, reason: 'message' as const }))
  ]
  return <section
    className="office-scene" onFocusCapture={deliveries.onFocusCapture}
    style={{ '--office-label-width': `${Math.max(96, 4 * OFFICE_TILE_PX * zoom - 4)}px` } as CSSProperties}
    data-testid="office-scene" data-mode={mode} data-palette={palette} data-plates={zoom >= 2 ? 'always' : 'hover'} data-paused={paused ? 'true' : undefined}
    data-office-clock={clock.running ? 'running' : 'stopped'} data-office-animated={clock.animated}
  >
    {mode === 'team' && <p>Team layout · roles, not live activity</p>}{mode === 'sample' && <p>Sample office · example agents</p>}
    <div className="office-controls">
      <Button size="sm" onClick={camera.zoomOut}>Zoom out</Button>
      <span data-testid="office-zoom" data-zoom={zoom} role="img" aria-label={zoomName(zoom)}>{zoomLabel(zoom)}</span>
      <Button size="sm" onClick={camera.zoomIn}>Zoom in</Button>
      <Button size="sm" onClick={camera.fit}>Fit</Button>
      {mode === 'live' && <Button
        size="sm" testId="office-pause" pressed={paused} onClick={() => setPaused(value => !value)}
        inert={reduced} title={reduced ? 'Motion is already off: Reduce motion is on in Settings' : undefined}
      >Pause motion</Button>}
      <OfficeOffscreen stage={stage} items={cueItems} positions={positionsNow} area={area} zoom={zoom} client={client} onShow={showPerson} />
    </div>
    <div
      className="office-stage" data-testid="office-stage" data-width={building.bounds.width} data-height={building.bounds.height}
      ref={stage} tabIndex={0} role="group" aria-label="Office scene. Arrow keys pan, plus and minus zoom, 0 fits the building, Home resets the view." {...camera.stageProps}
    >
      <div className="office-map" data-testid="office-floor" style={{ width: Math.max(content.width, client.width), height: Math.max(content.height, client.height) }}>
        <div className="office-world" style={{ left: offset.x, top: offset.y, width: content.width, height: content.height }}>
          <OfficeBuilding building={building} tiles={furnished.tiles} props={staticProps} palette={palette} zoom={zoom} area={area} />
          <OfficeRoomLabels building={building} area={area} zoom={zoom} />
          <OfficeSprites
            people={people} area={area} zoom={zoom} palette={palette} paused={paused} selectedId={selectedId} foundId={camera.foundId} exchangeIds={exchangeIds}
            spriteRefs={spriteRefs} onSelect={selectId} onRemove={onRemove ? removeId : undefined} onReveal={revealId}
          />
          <OfficeBubbles bubbles={bubbles} positions={positionsNow} zoom={zoom} area={area} size={content} spriteRefs={spriteRefs} />
        </div>
      </div>
    </div>
    <OfficeStrip
      mode={mode} motionOff={motionOff} names={names} messages={recentMessages(messages, 3)}
      active={deliveries.scheduler.active.length} queued={deliveries.scheduler.queued.length} onShow={showPerson}
    />
    {!agents.length && <p className="office-empty">The office is ready. People appear here when your team starts work.</p>}
    <OfficeDirectory agents={agents} rooms={rooms} selectedId={selectedId} onPick={agent => showPerson(agent.id)} onRemove={onRemove} />
  </section>
}
