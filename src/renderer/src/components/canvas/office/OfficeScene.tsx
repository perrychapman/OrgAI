import { useEffect, useImperativeHandle, useMemo, useRef, useState, type CSSProperties, type Ref } from 'react'
import type { AgentMessage } from '@shared/types'
import { useReducedMotion } from '../../../lib/canvas'
import { assignDepartmentSlots, buildingBlocked, buildingDesk, buildingLayout, buildingProps, DESKS_PER_ROOM, floorBounds, OFFICE_TILE, route } from '../../../lib/office/layout'
import { baseline, finish, ingest } from '../../../lib/office/scheduler'
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
const silhouettes = ['crop', 'part', 'bun', 'wide', 'long', 'cap']
function identity(id: string): number { let n = 0; for (const c of id) n = (n * 31 + c.charCodeAt(0)) >>> 0; return n }
function frameStyle(frame: Frame, url: string, x: number, y: number, depth: number): CSSProperties {
  return { left: x, top: y, width: frame.w, height: frame.h, backgroundImage: `url(${url})`, backgroundPosition: `-${frame.x}px -${frame.y}px`, zIndex: depth }
}

export function OfficeScene({ agents, messages, onSelect, onRemove, selectedId, mode, runId, palette = 'color', controlRef }: OfficeSceneProps) {
  const reduced = useReducedMotion()
  const announce = useFrameAnnounce()
  const [floor, setFloor] = useState(0)
  const [zoom, setZoom] = useState(1)
  const [tick, setTick] = useState(Date.now())
  const stage = useRef<HTMLDivElement>(null)
  const [bounds, setBounds] = useState({ width: 0, height: 0 })
  const slots = useRef(new Map<string, number>())
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
  const crossSeen = useRef<readonly AgentMessage[]>(messages)
  const [crossFloor, setCrossFloor] = useState<AgentMessage[]>([])
  const schedulerRun = useRef(runId)
  if (schedulerRun.current !== runId) { scheduler.current = baseline(messages); schedulerRun.current = runId }
  const [, redraw] = useState(0)
  useEffect(() => {
    if (schedulerGeometryReset.current) { scheduler.current = baseline(messages); crossSeen.current = messages.slice(); setCrossFloor([]); schedulerGeometryReset.current = false; redraw(n => n + 1); return }
    let overlap = Math.min(crossSeen.current.length, messages.length)
    while (overlap > 0 && !crossSeen.current.slice(-overlap).every((message, i) => message === messages[i])) overlap--
    const fresh = messages.slice(overlap).filter(message => {
      const from = layout.rooms.find(r => r.agents.includes(message.from)); const to = layout.rooms.find(r => r.agents.includes(message.to ?? ''))
      return from && to && from.floor !== to.floor
    })
    crossSeen.current = messages.slice()
    if (mode === 'live' && !document.hidden && fresh.length) setCrossFloor(previous => [...previous, ...fresh].slice(-3))
    if (mode !== 'live') setCrossFloor(previous => previous.length ? [] : previous)
    scheduler.current = mode === 'live' ? ingest(scheduler.current, messages, ids, Date.now(), !document.hidden, reduced) : baseline(messages)
    redraw(n => n + 1)
  }, [messages, ids, mode, reduced, geometryKey])
  useEffect(() => {
    const change = () => { scheduler.current = baseline(messages); crossSeen.current = messages.slice(); setCrossFloor([]); redraw(n => n + 1) }
    document.addEventListener('visibilitychange', change)
    return () => document.removeEventListener('visibilitychange', change)
  }, [messages])
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
  return <section className="office-scene" data-testid="office-scene" data-mode={mode} data-palette={palette} data-room={currentFloor + 1} data-floor={currentFloor + 1}>
    {mode === 'team' && <p>Team layout · roles, not live activity</p>}{mode === 'sample' && <p>Sample office · example agents</p>}
    <div className="office-controls"><Button size="sm" onClick={() => setZoom(z => Math.max(1, z - 1))}>Zoom out</Button><span data-testid="office-zoom" data-zoom={zoom}>{zoom}×</span><Button size="sm" onClick={() => setZoom(z => Math.min(4, z + 1))}>Zoom in</Button><Button size="sm" onClick={fit}>Fit</Button>
      <Button size="sm" disabled={currentFloor === 0} onClick={() => setFloor(r => Math.max(0, r - 1))}>Previous floor</Button><span data-floor={currentFloor + 1}>Floor {currentFloor + 1} of {layout.floorCount}</span><Button size="sm" disabled={currentFloor >= layout.floorCount - 1} onClick={() => setFloor(r => Math.min(layout.floorCount - 1, r + 1))}>Next floor</Button></div>
    <div className="office-stage" data-testid="office-stage" data-width={width} data-height={height} data-floor={currentFloor + 1} ref={stage} tabIndex={0} aria-label="Office scene, scroll to pan">
      <div className="office-map" data-testid="office-floor" style={{ width: Math.max(layout.width * OFFICE_TILE * zoom, bounds.width), height: Math.max(layout.height * OFFICE_TILE * zoom, bounds.height) }}><div className="office-pixels" aria-hidden="true" style={{ width: width * OFFICE_TILE, height: height * OFFICE_TILE, transform: `scale(${zoom})` }}>
        {Array.from({ length: width * height }, (_, i) => { const x = i % width; const y = Math.floor(i / width); const horizontal = rooms.some(r => (y === r.y && x >= r.x && x < r.x + 20) || (y === r.y + 21 && x >= r.x && x < r.x + 20 && x !== r.x + 9 && x !== r.x + 10)); const vertical = rooms.some(r => y > r.y && y < r.y + 21 && (x === r.x || x === r.x + 19)); const f = tileFrames[horizontal || vertical ? 'tile.08' : 'tile.00']; return <i className="office-sprite" key={`t${i}`} style={{ ...frameStyle(f, tiles, x * 16, y * 16, 0), transform: vertical ? 'rotate(90deg)' : undefined }} /> })}
        {rooms.flatMap(room => buildingProps(room).map(p => <i className="office-sprite" key={`${room.id}-${p.name}`} style={frameStyle(propFrames[`prop.${p.name}`], props, p.x * 16, p.y * 16, p.y * 16 + atlas.props[p.name].depthAnchor[1])} />))}
        {visibleAgents.map(a => { const desk = deskOf(a); const x = desk.furniture.x * 16; const y = desk.furniture.y * 16; const f = propFrames['prop.desk']; const crt = propFrames['prop.crt']; const chair = propFrames['prop.chair']; const depth = y + atlas.props.desk.depthAnchor[1]; return <span key={`d${a.id}`}><i className="office-sprite" style={frameStyle(chair, props, x + 2 * OFFICE_TILE, y, y + atlas.props.chair.depthAnchor[1])} /><i className="office-sprite" style={frameStyle(f, props, x, y, depth)} /><i className="office-sprite" style={frameStyle(crt, props, x, y, depth + 1)} /></span> })}
        {visibleAgents.map(a => {
          const desk = deskOf(a)
          let x = desk.anchor.x * 16; let y = desk.anchor.y * 16
          // One walker at a time avoids crossings; other deliveries retain their captions.
          const delivery = deliveries[0]?.message.from === a.id && visibleAgents.some(other => other.id === deliveries[0].message.to) ? deliveries[0] : undefined
          let direction = 'up'
          let pose = a.status === 'failed' || a.status === 'error' ? 'error' : a.status === 'finished' || a.status === 'done' ? 'done' : a.status === 'waiting' ? 'wait' : 'work'
          if (delivery && !reduced && delivery.message.to) {
            const target = deskOf(visibleAgents.find(other => other.id === delivery.message.to)!)
            const blocked = buildingBlocked(rooms, visibleAgents, slots.current)
            for (const other of visibleAgents) if (other.id !== a.id && other.id !== delivery.message.to) {
              const p = deskOf(other).anchor; blocked.add(`${p.x},${p.y}`)
            }
            const path = route(desk.anchor, target.anchor, blocked, height, width).slice(0, -1)
            const step = Math.min(path.length - 1, Math.floor(Math.max(0, tick - delivery.started) / 2000 * path.length))
            if (step >= 0 && path[step]) {
              x = path[step].x * 16; y = path[step].y * 16
              const next = path[Math.min(step + 1, path.length - 1)]
              if (next) direction = next.x > path[step].x ? 'right' : next.x < path[step].x ? 'left' : next.y > path[step].y ? 'down' : 'up'
              pose = step % 2 ? 'walk-1' : 'walk-2'
            }
          }
          const f = workerFrames[`worker.${silhouettes[identity(a.id) % silhouettes.length]}.${direction}.${pose}`]
          return <i className="office-sprite" data-office-sprite-id={a.id} key={a.id} style={frameStyle(f, workers, x, y - 8, y - 8 + atlas.workerFeet[1])} />
        })}
      </div>{rooms.map(room => <div className="office-room-label" key={room.id} data-office-department-id={JSON.parse(room.id)[0]} style={{ left: (room.x + 1) * OFFICE_TILE * zoom, top: room.y * OFFICE_TILE * zoom }}>{room.label}</div>)}{visibleAgents.map(a => { const room = rooms.find(r => r.agents.includes(a.id))!; const local = slots.current.get(JSON.stringify([a.central ? '__central__' : a.departmentId, a.id]))! % DESKS_PER_ROOM; return <button type="button" className="office-nameplate" key={a.id} data-office-worker-id={a.id} aria-pressed={a.id === selectedId} style={{ left: (room.x + 3 + (local % 4) * 4) * OFFICE_TILE * zoom, top: (room.y + 2 + Math.floor(local / 4) * 8) * OFFICE_TILE * zoom }} onClick={() => selectAgent(a)} onKeyDown={e => removeOnDelete(e, a)}><span>{a.name}</span><span>{a.statusLabel ?? a.status}</span></button> })}</div>
    </div>
    <div data-testid="office-deliveries" data-active={mode === 'live' && !reduced ? scheduler.current.active.length : 0} data-queued={mode === 'live' && !reduced ? scheduler.current.queued.length : 0}>{deliveries.slice(0, Math.max(0, 3 - crossFloor.length)).map((d, i) => { const from = layout.rooms.find(r => r.agents.includes(d.message.from)); const to = layout.rooms.find(r => r.agents.includes(d.message.to ?? '')); return <p key={i} data-testid="office-caption" title={d.message.text}>{from && to && from.floor !== to.floor && <span>Floor {from.floor + 1} to floor {to.floor + 1}: </span>}{d.message.text.length > 80 ? `${d.message.text.slice(0, 80)}…` : d.message.text}{d.count > 1 ? ` (${d.count} messages)` : ''}<span className="office-full-message"> Full available message: {d.message.text}</span></p> })}</div>
    {crossFloor.map((message, i) => { const from = layout.rooms.find(r => r.agents.includes(message.from)); const to = layout.rooms.find(r => r.agents.includes(message.to ?? '')); return from && to && <p key={i} data-testid="office-caption" title={message.text}>Floor {from.floor + 1} to floor {to.floor + 1}: {message.text.length > 80 ? `${message.text.slice(0, 80)}…` : message.text}<span className="office-full-message"> Full available message: {message.text}</span></p> })}
    <div className="office-roster" aria-label="Agents" role="region"><strong>Agents ({agents.length})</strong>{agents.map(a => <button type="button" key={a.id} data-office-agent-id={a.id} data-office-agent-context={a.context} aria-pressed={a.id === selectedId} onClick={() => selectAgent(a)} onKeyDown={e => removeOnDelete(e, a)}><span>{a.name}</span> <span>{a.statusLabel ?? a.status}</span>{a.context && <span> · {a.context}</span>}{a.activity && <span> · {a.activity}</span>}</button>)}</div>
  </section>
}
