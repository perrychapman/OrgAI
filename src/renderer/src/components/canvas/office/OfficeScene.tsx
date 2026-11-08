import { useEffect, useImperativeHandle, useMemo, useRef, useState, type CSSProperties, type Ref } from 'react'
import type { AgentMessage } from '@shared/types'
import { useReducedMotion } from '../../../lib/canvas'
import { assignAppearances, assignDepartmentSlots, buildingBlocked, buildingDesk, buildingLayout, buildingProps, clearWorkerPath, DESKS_PER_ROOM, floorBounds, OFFICE_TILE, route } from '../../../lib/office/layout'
import { baseline, finish, ingest } from '../../../lib/office/scheduler'
import { consumeSceneMessages } from '../../../lib/office/messageCursor'
import { Button } from '../../ui/Button'
import { useFrameAnnounce } from '../../layout/CanvasFrame'
import atlas from '../../../assets/pocket-office/atlas.json'
import tilesNeutral from '../../../assets/pocket-office/tiles-neutral.png'
import tilesGreen from '../../../assets/pocket-office/tiles-green.png'
import propsNeutral from '../../../assets/pocket-office/props-neutral.png'
import propsGreen from '../../../assets/pocket-office/props-green.png'
import workersNeutral from '../../../assets/pocket-office/workers-neutral.png'
import workersGreen from '../../../assets/pocket-office/workers-green.png'
import tilesColor from '../../../assets/pocket-office/tiles-color.png'
import propsColor from '../../../assets/pocket-office/props-color.png'
import workersColor from '../../../assets/pocket-office/workers-color.png'
import '../../../styles/office.css'

export interface OfficeAgent { id: string; name: string; status: string; statusLabel?: string; activity?: string; context?: string; departmentId: string; departmentName: string; departmentLeadId: string; central: boolean }
export interface OfficeSceneHandle { zoomIn(): void; zoomOut(): void; fit(): void }
export interface OfficeSceneProps {
  agents: OfficeAgent[]; messages: AgentMessage[]; onSelect(id: string): void; onRemove?(id: string): void
  selectedId?: string; mode: 'live' | 'team' | 'sample'; runId?: string
  palette?: 'color' | 'neutral' | 'green'; controlRef?: Ref<OfficeSceneHandle>
}
type Frame = { x: number; y: number; w: number; h: number }
const silhouettes = [...new Set(Object.keys(atlas.sheets.workers.frames).map(name => name.split('.')[1]))]
function frameStyle(frame: Frame, url: string, x: number, y: number, depth: number): CSSProperties {
  return { left: x, top: y, width: frame.w, height: frame.h, backgroundImage: `url(${url})`, backgroundPosition: `-${frame.x}px -${frame.y}px`, zIndex: depth }
}

export function OfficeScene({ agents, messages, onSelect, onRemove, selectedId, mode, runId, palette = 'color', controlRef }: OfficeSceneProps) {
  const reduced = useReducedMotion()
  const announce = useFrameAnnounce()
  const [floor, setFloor] = useState(0)
  const [zoom, setZoom] = useState(2)
  const [tick, setTick] = useState(Date.now())
  const stage = useRef<HTMLDivElement>(null)
  const [bounds, setBounds] = useState({ width: 0, height: 0 })
  const initialScaleSet = useRef(false)
  useEffect(() => {
    if (initialScaleSet.current || !bounds.width || !bounds.height) return
    initialScaleSet.current = true
    setZoom(bounds.height < 320 ? 1 : 2)
  }, [bounds])
  const slots = useRef(new Map<string, number>())
  const appearances = useRef(new Map<string, number>())
  appearances.current = assignAppearances(appearances.current, agents.map(agent => agent.id), silhouettes.length)
  const schedulerGeometryReset = useRef(false)
  const slotRun = useRef(runId)
  if (slotRun.current !== runId) { slots.current = new Map(); slotRun.current = runId }
  slots.current = assignDepartmentSlots(slots.current, agents)
  const layout = buildingLayout(agents, slots.current, bounds.width, bounds.height, zoom)
  const selectedFloor = layout.rooms.find(r => r.agents.includes(selectedId ?? ''))?.floor
  const currentFloor = Math.min(floor, layout.floorCount - 1)
  const rooms = layout.rooms.filter(r => r.floor === currentFloor)
  const visibleAgents = agents.filter(a => rooms.some(r => r.agents.includes(a.id)))
  const deskOf = (a: OfficeAgent) => {
    const room = layout.rooms.find(r => r.agents.includes(a.id))!
    const local = slots.current.get(JSON.stringify([a.central ? '__central__' : a.departmentId, a.id]))! % DESKS_PER_ROOM
    return buildingDesk(room, local)
  }
  const { width, height } = floorBounds(layout, bounds.width, bounds.height, zoom)
  useEffect(() => {
    if (!stage.current) return
    const observer = new ResizeObserver(([entry]) => {
      const width = Math.floor(entry.contentRect.width); const height = Math.floor(entry.contentRect.height)
      setBounds(previous => previous.width === width && previous.height === height ? previous : { width, height })
    })
    observer.observe(stage.current)
    return () => observer.disconnect()
  }, [])
  const placementKey = JSON.stringify(layout.rooms.map(r => [r.id, r.floor, r.x, r.y]))
  const geometryKey = JSON.stringify([placementKey, width, height, currentFloor])
  const previousGeometry = useRef(geometryKey)
  if (previousGeometry.current !== geometryKey) {
    previousGeometry.current = geometryKey
    schedulerGeometryReset.current = true
  }
  useEffect(() => { if (selectedFloor !== undefined) setFloor(selectedFloor) }, [placementKey, selectedFloor])
  const selectAgent = (a: OfficeAgent) => {
    setFloor(layout.rooms.find(r => r.agents.includes(a.id))?.floor ?? 0)
    onSelect(a.id)
    announce?.(`${a.name}, ${a.statusLabel ?? a.status}${a.context ? `, ${a.context}` : ''}, selected`)
  }
  const removeOnDelete = (event: React.KeyboardEvent<HTMLButtonElement>, agent: OfficeAgent) => {
    if (event.key === 'Delete' && onRemove) { event.preventDefault(); onRemove(agent.id) }
  }
  const eligibleIds = visibleAgents.filter(a => !['finished', 'done', 'failed', 'error'].includes(a.status.toLowerCase())).map(a => a.id)
  const idsKey = JSON.stringify(eligibleIds)
  const ids = useMemo(() => new Set<string>(JSON.parse(idsKey)), [idsKey])
  const scheduler = useRef(baseline(messages))
  const crossSeen = useRef({ runId, seen: messages as readonly AgentMessage[] })
  const [crossFloorState, setCrossFloor] = useState<AgentMessage[]>([])
  const crossFloor = crossSeen.current.runId === runId ? crossFloorState : []
  const schedulerRun = useRef(runId)
  if (schedulerRun.current !== runId) { scheduler.current = baseline(messages); schedulerRun.current = runId }
  const [, redraw] = useState(0)
  useEffect(() => {
    const incoming = consumeSceneMessages(crossSeen.current, runId, messages)
    crossSeen.current = incoming.cursor
    if (schedulerGeometryReset.current || incoming.reset) { scheduler.current = baseline(messages); setCrossFloor([]); schedulerGeometryReset.current = false; redraw(n => n + 1); return }
    const fresh = incoming.fresh.filter(message => {
      const from = layout.rooms.find(r => r.agents.includes(message.from)); const to = layout.rooms.find(r => r.agents.includes(message.to ?? ''))
      return from && to && from.floor !== to.floor
    })
    if (mode === 'live' && !document.hidden && fresh.length) setCrossFloor(previous => [...previous, ...fresh].slice(-3))
    if (mode !== 'live') setCrossFloor(previous => previous.length ? [] : previous)
    scheduler.current = mode === 'live' ? ingest(scheduler.current, messages, ids, Date.now(), !document.hidden, reduced) : baseline(messages)
    redraw(n => n + 1)
  }, [messages, ids, mode, reduced, geometryKey, runId])
  useEffect(() => {
    const change = () => { scheduler.current = baseline(messages); crossSeen.current = { runId, seen: messages.slice() }; setCrossFloor([]); redraw(n => n + 1) }
    document.addEventListener('visibilitychange', change)
    return () => document.removeEventListener('visibilitychange', change)
  }, [messages, runId])
  useEffect(() => {
    if (!crossFloor.length) return
    const timer = window.setTimeout(() => setCrossFloor([]), 8000)
    return () => window.clearTimeout(timer)
  }, [crossFloor])
  useEffect(() => {
    if (mode !== 'live' || reduced || document.hidden || !scheduler.current.active.length) return
    let handle = 0
    const frame = () => {
      if (document.hidden) { scheduler.current = baseline(messages); return }
      const now = Date.now(); scheduler.current = finish(scheduler.current, now); setTick(now)
      if (scheduler.current.active.length) handle = requestAnimationFrame(frame)
    }
    handle = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(handle)
  }, [messages, mode, reduced, currentFloor, ids, geometryKey])
  useEffect(() => {
    if (!reduced || !scheduler.current.active.length) return
    const timer = window.setTimeout(() => { scheduler.current = finish(scheduler.current, Date.now()); redraw(n => n + 1) }, 8000)
    return () => window.clearTimeout(timer)
  }, [messages, reduced, ids])
  const fit = () => setZoom(Math.max(1, Math.min(4, Math.floor(Math.min(bounds.width / (22 * OFFICE_TILE), bounds.height / (24 * OFFICE_TILE))))))
  useImperativeHandle(controlRef, () => ({ zoomIn: () => setZoom(z => Math.min(4, z + 1)), zoomOut: () => setZoom(z => Math.max(1, z - 1)), fit }), [bounds])
  const tiles = palette === 'green' ? tilesGreen : palette === 'neutral' ? tilesNeutral : tilesColor
  const props = palette === 'green' ? propsGreen : palette === 'neutral' ? propsNeutral : propsColor
  const workers = palette === 'green' ? workersGreen : palette === 'neutral' ? workersNeutral : workersColor
  const propFrames = atlas.sheets.props.frames as Record<string, Frame>
  const workerFrames = atlas.sheets.workers.frames as Record<string, Frame>
  const tileFrames = atlas.sheets.tiles.frames as Record<string, Frame>
  const deliveries = scheduler.current.active.filter(d => {
    return agents.some(a => a.id === d.message.from) && agents.some(a => a.id === d.message.to)
  })
  // The artwork and its native hit target consume the same rendered position.
  const workersOnFloor = visibleAgents.map(a => {
    const desk = deskOf(a)
    let x = desk.anchor.x * OFFICE_TILE; let y = desk.anchor.y * OFFICE_TILE
    const delivery = deliveries[0]?.message.from === a.id && visibleAgents.some(other => other.id === deliveries[0].message.to) ? deliveries[0] : undefined
    let direction = 'down'
    let pose = a.status === 'failed' || a.status === 'error' ? 'error' : a.status === 'finished' || a.status === 'done' ? 'done' : a.status === 'waiting' ? 'wait' : 'work'
    if (delivery && !reduced && delivery.message.to) {
      const target = deskOf(visibleAgents.find(other => other.id === delivery.message.to)!)
      const blocked = buildingBlocked(rooms, visibleAgents, slots.current)
      for (const other of visibleAgents) if (other.id !== a.id && other.id !== delivery.message.to) {
        const p = deskOf(other).anchor; blocked.add(`${p.x},${p.y}`)
      }
      const path = clearWorkerPath(route(desk.anchor, target.anchor, blocked, height, width), visibleAgents.filter(other => other.id !== a.id).map(other => deskOf(other).anchor))
      const step = Math.min(path.length - 1, Math.floor(Math.max(0, tick - delivery.started) / 2000 * path.length))
      if (step >= 0 && path[step]) {
        x = path[step].x * OFFICE_TILE; y = path[step].y * OFFICE_TILE
        const next = path[Math.min(step + 1, path.length - 1)]
        if (next) direction = next.x > path[step].x ? 'right' : next.x < path[step].x ? 'left' : next.y > path[step].y ? 'down' : 'up'
        pose = step % 2 ? 'walk-1' : 'walk-2'
      }
    }
    const frame = workerFrames[`worker.${silhouettes[appearances.current.get(a.id)!]}.${direction}.${pose}`]
    return { agent: a, frame, x, y: y + 8 - atlas.workerFeet[1], depth: y + 8 }
  })
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const container = stage.current
      const person = container?.querySelector<HTMLElement>('.office-person')
      if (!container || !person) return
      const viewport = container.getBoundingClientRect()
      const target = person.getBoundingClientRect()
      const label = person.querySelector<HTMLElement>('.office-person-label')?.getBoundingClientRect()
      const bottom = Math.max(target.bottom, label?.bottom ?? target.bottom)
      if (target.top < viewport.top) container.scrollTop += target.top - viewport.top - 8
      else if (bottom > viewport.bottom) container.scrollTop += bottom - viewport.bottom + 8
    })
    return () => cancelAnimationFrame(frame)
  }, [geometryKey, zoom])
  return <section className="office-scene" data-testid="office-scene" data-mode={mode} data-palette={palette} data-room={currentFloor + 1} data-floor={currentFloor + 1}>
    {mode === 'team' && <p>Team layout · roles, not live activity</p>}{mode === 'sample' && <p>Sample office · example agents</p>}
    <div className="office-controls"><Button size="sm" onClick={() => setZoom(z => Math.max(1, z - 1))}>Zoom out</Button><span data-testid="office-zoom" data-zoom={zoom}>{zoom}×</span><Button size="sm" onClick={() => setZoom(z => Math.min(4, z + 1))}>Zoom in</Button><Button size="sm" onClick={fit}>Fit</Button>
      <Button size="sm" disabled={currentFloor === 0} onClick={() => setFloor(r => Math.max(0, r - 1))}>Previous floor</Button><span data-floor={currentFloor + 1}>Floor {currentFloor + 1} of {layout.floorCount}</span><Button size="sm" disabled={currentFloor >= layout.floorCount - 1} onClick={() => setFloor(r => Math.min(layout.floorCount - 1, r + 1))}>Next floor</Button></div>
    <div className="office-stage" data-testid="office-stage" data-width={width} data-height={height} data-floor={currentFloor + 1} ref={stage} tabIndex={0} aria-label="Office scene, scroll to pan">
      <div className="office-map" data-testid="office-floor" style={{ width: Math.max(layout.width * OFFICE_TILE * zoom, bounds.width), height: Math.max(layout.height * OFFICE_TILE * zoom, bounds.height) }}><div className="office-pixels" aria-hidden="true" style={{ width: width * OFFICE_TILE, height: height * OFFICE_TILE, transform: `scale(${zoom})` }}>
        {Array.from({ length: width * height }, (_, i) => { const x = i % width; const y = Math.floor(i / width); const horizontal = rooms.some(r => (y === r.y && x >= r.x && x < r.x + r.width) || (y === r.y + r.height - 1 && x >= r.x && x < r.x + r.width && x !== r.x + Math.floor(r.width / 2) - 1 && x !== r.x + Math.floor(r.width / 2))); const vertical = rooms.some(r => y > r.y && y < r.y + r.height - 1 && (x === r.x || x === r.x + r.width - 1)); const f = tileFrames[horizontal || vertical ? 'tile.08' : (x + y * 3) % 11 === 0 ? 'tile.03' : 'tile.00']; return <i className="office-sprite" key={`t${i}`} style={{ ...frameStyle(f, tiles, x * 16, y * 16, 0), transform: vertical ? 'rotate(90deg)' : undefined }} /> })}
        {rooms.flatMap(room => Array.from({ length: room.width === 12 ? 15 : 14 }, (_, index) => {
          const columns = room.width === 12 ? 5 : 7
          const x = room.x + (room.width === 12 && room.agents.length === 1 ? 6 : 1) + index % columns
          const y = room.y + 2 + Math.floor(index / columns)
          return <i className="office-sprite" key={`${room.id}-rug-${index}`} style={frameStyle(tileFrames['tile.16'], tiles, x * OFFICE_TILE, y * OFFICE_TILE, 0)} />
        }))}
        {rooms.flatMap(room => buildingProps(room).map(p => <i className="office-sprite" key={`${room.id}-${p.key}`} style={frameStyle(propFrames[`prop.${p.name}`], props, p.x * 16, p.y * 16, p.y * 16 + atlas.props[p.name].depthAnchor[1])} />))}
        {visibleAgents.map(a => { const desk = deskOf(a); const x = desk.furniture.x * 16; const y = desk.furniture.y * 16; const f = propFrames['prop.desk']; const crt = propFrames['prop.crt']; const chair = propFrames['prop.chair']; const depth = y + atlas.props.desk.depthAnchor[1]; return <span key={`d${a.id}`}><i className="office-sprite" style={frameStyle(chair, props, x + 2 * OFFICE_TILE, y, y + atlas.props.chair.depthAnchor[1])} /><i className="office-sprite" style={frameStyle(f, props, x, y, depth)} /><i className="office-sprite" style={frameStyle(crt, props, x, y, depth + 1)} /></span> })}
        {workersOnFloor.map(({ agent, frame, x, y, depth }) => <i className="office-sprite office-person-art" data-office-sprite-id={agent.id} key={agent.id} style={frameStyle(frame, workers, x, y, depth)} />)}
      </div>{rooms.map(room => <div className="office-room-label" key={room.id} data-office-department-id={JSON.parse(room.id)[0]} style={{ left: (room.x + 1) * OFFICE_TILE * zoom, top: room.y * OFFICE_TILE * zoom, maxWidth: (room.width - 2) * OFFICE_TILE * zoom }}>{room.label} · {room.agents.length}</div>)}{workersOnFloor.map(({ agent: a, x, y }) => <button type="button" className="office-person" key={a.id} data-office-worker-id={a.id} data-testid="pocket-office-agent" data-agent-id={a.id} aria-label={`${a.name}, ${a.statusLabel ?? a.status}${a.context ? `, ${a.context}` : ''}`} aria-pressed={a.id === selectedId} title={`${a.name} · ${a.statusLabel ?? a.status}${a.context ? ` · ${a.context}` : ''}`} style={{ left: x * zoom - Math.max(0, 24 - 16 * zoom) / 2, top: y * zoom, width: Math.max(24, 16 * zoom), height: 24 * zoom }} onClick={() => selectAgent(a)} onKeyDown={e => removeOnDelete(e, a)}><span className="office-person-label"><span>{a.name}</span><span>{a.statusLabel ?? a.status}</span></span></button>)}</div>
    </div>
    <div data-testid="office-deliveries" data-active={mode === 'live' && !reduced ? scheduler.current.active.length : 0} data-queued={mode === 'live' && !reduced ? scheduler.current.queued.length : 0}>{deliveries.slice(0, Math.max(0, 3 - crossFloor.length)).map((d, i) => { const from = layout.rooms.find(r => r.agents.includes(d.message.from)); const to = layout.rooms.find(r => r.agents.includes(d.message.to ?? '')); return <p key={i} data-testid="office-caption" title={d.message.text}>{from && to && from.floor !== to.floor && <span>Floor {from.floor + 1} to floor {to.floor + 1}: </span>}{d.message.text.length > 80 ? `${d.message.text.slice(0, 80)}…` : d.message.text}{d.count > 1 ? ` (${d.count} messages)` : ''}<span className="office-full-message"> Full available message: {d.message.text}</span></p> })}</div>
    {crossFloor.map((message, i) => { const from = layout.rooms.find(r => r.agents.includes(message.from)); const to = layout.rooms.find(r => r.agents.includes(message.to ?? '')); return from && to && <p key={i} data-testid="office-caption" title={message.text}>Floor {from.floor + 1} to floor {to.floor + 1}: {message.text.length > 80 ? `${message.text.slice(0, 80)}…` : message.text}<span className="office-full-message"> Full available message: {message.text}</span></p> })}
    {!agents.length && <p className="office-empty">The office is ready. People appear here when your team starts work.</p>}
    <details className="office-directory"><summary>Find a person · {agents.length} across {layout.floorCount} {layout.floorCount === 1 ? 'floor' : 'floors'}</summary><div className="office-roster" aria-label="All people, including earlier sessions" role="region">{agents.map(a => <button type="button" key={a.id} data-office-agent-id={a.id} data-office-agent-context={a.context} data-office-floor={(layout.rooms.find(room => room.agents.includes(a.id))?.floor ?? 0) + 1} aria-pressed={a.id === selectedId} onClick={() => selectAgent(a)} onKeyDown={e => removeOnDelete(e, a)}><span>{a.name}</span> <span>{a.statusLabel ?? a.status}</span>{a.context && <span> · {a.context}</span>}{a.activity && <span> · {a.activity}</span>}</button>)}</div></details>
  </section>
}
