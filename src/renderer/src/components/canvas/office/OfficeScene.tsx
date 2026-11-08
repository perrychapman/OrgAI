import { useEffect, useImperativeHandle, useMemo, useRef, useState, type CSSProperties, type Ref } from 'react'
import type { AgentMessage } from '@shared/types'
import { useReducedMotion } from '../../../lib/canvas'
import { assignDesks, deskForSlot, OFFICE_TILE, ROOM_HEIGHT, ROOM_WIDTH, route } from '../../../lib/office/layout'
import { baseline, finish, ingest } from '../../../lib/office/scheduler'
import { Button } from '../../ui/Button'
import atlas from '../../../assets/pocket-office/atlas.json'
import tilesNeutral from '../../../assets/pocket-office/tiles-neutral.png'
import tilesGreen from '../../../assets/pocket-office/tiles-green.png'
import propsNeutral from '../../../assets/pocket-office/props-neutral.png'
import propsGreen from '../../../assets/pocket-office/props-green.png'
import workersNeutral from '../../../assets/pocket-office/workers-neutral.png'
import workersGreen from '../../../assets/pocket-office/workers-green.png'
import '../../../styles/office.css'

export interface OfficeAgent { id: string; name: string; status: string; activity?: string; context?: string }
export interface OfficeSceneHandle { zoomIn(): void; zoomOut(): void; fit(): void }
export interface OfficeSceneProps {
  agents: OfficeAgent[]; messages: AgentMessage[]; onSelect(id: string): void; onRemove?(id: string): void
  selectedId?: string; mode: 'live' | 'team' | 'sample'; runId?: string
  palette?: 'neutral' | 'green'; controlRef?: Ref<OfficeSceneHandle>
}
type Frame = { x: number; y: number; w: number; h: number }
const silhouettes = ['crop', 'part', 'bun', 'wide', 'long', 'cap']
function identity(id: string): number { let n = 0; for (const c of id) n = (n * 31 + c.charCodeAt(0)) >>> 0; return n }
function frameStyle(frame: Frame, url: string, x: number, y: number, depth: number): CSSProperties {
  return { left: x, top: y, width: frame.w, height: frame.h, backgroundImage: `url(${url})`, backgroundPosition: `-${frame.x}px -${frame.y}px`, zIndex: depth }
}

export function OfficeScene({ agents, messages, onSelect, onRemove, selectedId, mode, runId, palette = 'neutral', controlRef }: OfficeSceneProps) {
  const reduced = useReducedMotion()
  const [room, setRoom] = useState(0)
  const [zoom, setZoom] = useState(1)
  const [tick, setTick] = useState(Date.now())
  const stage = useRef<HTMLDivElement>(null)
  const slots = useRef(new Map<string, number>())
  const slotRun = useRef(runId)
  if (slotRun.current !== runId) { slots.current = new Map(); slotRun.current = runId }
  slots.current = assignDesks(slots.current, agents.map(a => a.id))
  const maxRoom = Math.max(0, ...agents.map(a => deskForSlot(slots.current.get(a.id)!).room))
  const currentRoom = Math.min(room, maxRoom)
  const visibleAgents = agents.filter(a => deskForSlot(slots.current.get(a.id)!).room === currentRoom)
  const ids = useMemo(() => new Set(agents.map(a => a.id)), [agents])
  const scheduler = useRef(baseline(messages))
  const schedulerRun = useRef(runId)
  if (schedulerRun.current !== runId) { scheduler.current = baseline(messages); schedulerRun.current = runId }
  const [, redraw] = useState(0)
  useEffect(() => {
    scheduler.current = mode === 'live' ? ingest(scheduler.current, messages, ids, Date.now(), !document.hidden, reduced) : baseline(messages)
    redraw(n => n + 1)
  }, [messages, ids, mode, reduced])
  useEffect(() => {
    const change = () => { scheduler.current = baseline(messages); redraw(n => n + 1) }
    document.addEventListener('visibilitychange', change)
    return () => document.removeEventListener('visibilitychange', change)
  }, [messages])
  useEffect(() => {
    if (mode !== 'live' || reduced || document.hidden || !scheduler.current.active.length) return
    let handle = 0
    const frame = () => {
      const now = Date.now(); scheduler.current = finish(scheduler.current, now); setTick(now)
      if (scheduler.current.active.length) handle = requestAnimationFrame(frame)
    }
    handle = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(handle)
  }, [messages, mode, reduced, currentRoom])
  useImperativeHandle(controlRef, () => ({ zoomIn: () => setZoom(z => Math.min(4, z + 1)), zoomOut: () => setZoom(z => Math.max(1, z - 1)), fit: () => setZoom(Math.max(1, Math.min(4, Math.floor((stage.current?.clientWidth ?? ROOM_WIDTH * OFFICE_TILE) / (ROOM_WIDTH * OFFICE_TILE))))) }), [])
  const tiles = palette === 'green' ? tilesGreen : tilesNeutral
  const props = palette === 'green' ? propsGreen : propsNeutral
  const workers = palette === 'green' ? workersGreen : workersNeutral
  const propFrames = atlas.sheets.props.frames as Record<string, Frame>
  const workerFrames = atlas.sheets.workers.frames as Record<string, Frame>
  const tileFrames = atlas.sheets.tiles.frames as Record<string, Frame>
  const deliveries = scheduler.current.active.filter(d => {
    const from = slots.current.get(d.message.from); const to = d.message.to ? slots.current.get(d.message.to) : undefined
    return from !== undefined && to !== undefined && to !== null && deskForSlot(from).room === currentRoom && deskForSlot(to).room === currentRoom
  })
  return <section className="office-scene" data-testid="office-scene" data-mode={mode} data-palette={palette} data-room={currentRoom + 1}>
    {mode === 'team' && <p>Team layout · roles, not live activity</p>}{mode === 'sample' && <p>Sample office · example agents</p>}
    <div className="office-controls"><Button size="sm" onClick={() => setZoom(z => Math.max(1, z - 1))}>Zoom out</Button><span>{zoom}×</span><Button size="sm" onClick={() => setZoom(z => Math.min(4, z + 1))}>Zoom in</Button><Button size="sm" onClick={() => setZoom(1)}>Fit</Button>
      <Button size="sm" disabled={currentRoom === 0} onClick={() => setRoom(r => Math.max(0, r - 1))}>Previous room</Button><span>Room {currentRoom + 1} of {maxRoom + 1}</span><Button size="sm" disabled={currentRoom >= maxRoom} onClick={() => setRoom(r => Math.min(maxRoom, r + 1))}>Next room</Button></div>
    <div className="office-stage" ref={stage} tabIndex={0} aria-label="Office scene, scroll to pan">
      <div className="office-map" style={{ width: ROOM_WIDTH * OFFICE_TILE * zoom, height: ROOM_HEIGHT * OFFICE_TILE * zoom }} aria-hidden="true"><div className="office-pixels" style={{ width: ROOM_WIDTH * OFFICE_TILE, height: ROOM_HEIGHT * OFFICE_TILE, transform: `scale(${zoom})` }}>
        {Array.from({ length: ROOM_WIDTH * ROOM_HEIGHT }, (_, i) => { const x = i % ROOM_WIDTH; const y = Math.floor(i / ROOM_WIDTH); const f = tileFrames[y === 0 ? 'tile.08' : 'tile.00']; return <i className="office-sprite" key={`t${i}`} style={frameStyle(f, tiles, x * 16, y * 16, 0)} /> })}
        {visibleAgents.map(a => { const desk = deskForSlot(slots.current.get(a.id)!); const x = desk.furniture.x * 16; const y = desk.furniture.y * 16; const f = propFrames['prop.desk']; const crt = propFrames['prop.crt']; return <span key={`d${a.id}`}><i className="office-sprite" style={frameStyle(f, props, x, y, y + 32)} /><i className="office-sprite" style={frameStyle(crt, props, x, y, y + 33)} /></span> })}
        {visibleAgents.map(a => { const desk = deskForSlot(slots.current.get(a.id)!); let x = desk.anchor.x * 16; let y = desk.anchor.y * 16; const delivery = deliveries.find(d => d.message.from === a.id); let direction = 'up'; let pose = a.status === 'failed' || a.status === 'error' ? 'error' : a.status === 'finished' || a.status === 'done' ? 'done' : a.status === 'waiting' ? 'wait' : 'work'; if (delivery && !reduced && delivery.message.to) { const target = deskForSlot(slots.current.get(delivery.message.to)!); const path = route(desk.anchor, target.anchor); const step = Math.min(path.length - 1, Math.floor((tick - delivery.received) / 220)); if (step >= 0 && path[step]) { x = path[step].x * 16; y = path[step].y * 16; const next = path[Math.min(step + 1, path.length - 1)]; if (next) direction = next.x > path[step].x ? 'right' : next.x < path[step].x ? 'left' : next.y > path[step].y ? 'down' : 'up'; pose = step % 2 ? 'walk-1' : 'walk-2' } } const f = workerFrames[`worker.${silhouettes[identity(a.id) % silhouettes.length]}.${direction}.${pose}`]; return <i className="office-sprite" key={a.id} style={frameStyle(f, workers, x, y - 8, y + 23)} /> })}
      </div></div>
    </div>
    <div data-testid="office-deliveries" data-active={mode === 'live' ? scheduler.current.active.length : 0} data-queued={mode === 'live' ? scheduler.current.queued.length : 0}>{deliveries.map((d, i) => <p key={i} data-testid="office-caption" title={d.message.text}>{d.message.text.length > 80 ? `${d.message.text.slice(0, 80)}…` : d.message.text}{d.count > 1 ? ` (${d.count} messages)` : ''}<span className="office-full-message"> Full available message: {d.message.text}</span></p>)}</div>
    <div className="office-roster" aria-label="Agents" role="region"><strong>Agents ({agents.length})</strong>{agents.map(a => <button type="button" key={a.id} data-office-agent-id={a.id} data-office-agent-context={a.context} aria-pressed={a.id === selectedId} onClick={() => { setRoom(deskForSlot(slots.current.get(a.id)!).room); onSelect(a.id) }} onKeyDown={e => { if (e.key === 'Delete' && onRemove) { e.preventDefault(); onRemove(a.id) } }}><span>{a.name}</span> <span>{a.status}</span>{a.context && <span> · {a.context}</span>}{a.activity && <span> · {a.activity}</span>}</button>)}</div>
  </section>
}
