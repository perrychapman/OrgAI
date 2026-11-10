import { useLayoutEffect, useRef, type ReactElement } from 'react'
import type { Building } from '../../../lib/office/building'
import type { Rect } from '../../../lib/office/camera'
import { OFFICE_TILE } from '../../../lib/office/layout'
import type { PlacedProp, PlacedTile } from '../../../lib/office/themes'
import { depthOffset, propFrames, sheetsFor, tileFrames, type OfficePalette } from './officeArt'

/**
 * The static layer: floors, rugs, door mats, walls and every prop that is not a tabletop item, drawn once into one
 * canvas per layout, palette or zoom change (rework spec section 5). The canvas backing store matches the zoom and the
 * device pixel ratio, with smoothing off, so pixels stay hard-edged at 0.5x, 1x and every step up. People, desks,
 * screens, marks and bubbles are DOM and sit above this layer.
 */
export interface OfficeBuildingProps {
  building: Building
  tiles: readonly PlacedTile[]
  /** Props drawn into the canvas (no tabletop items: those belong to the desks in `OfficeSprites`). */
  props: readonly PlacedProp[]
  palette: OfficePalette
  zoom: number
  /** Drawn rectangle in tiles (building bounds plus the cell outside the front door). */
  area: Rect
}

/** Props on a desk are DOM so they sit above it. */
export const TABLETOP_PROPS: ReadonlySet<string> = new Set(['mug'])
/** Largest backing store we ask for; beyond this the canvas is drawn at a lower density and scaled up (still pixelated). */
const MAX_BACKING_PIXELS = 36_000_000

const images = new Map<string, HTMLImageElement>()
const pending = new Map<string, Promise<HTMLImageElement>>()
function loadImage(url: string): Promise<HTMLImageElement> {
  const ready = images.get(url)
  if (ready) return Promise.resolve(ready)
  let promise = pending.get(url)
  if (!promise) {
    promise = new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image()
      image.onload = () => { images.set(url, image); resolve(image) }
      image.onerror = () => reject(new Error(`Could not load ${url}`))
      image.src = url
    })
    pending.set(url, promise)
  }
  return promise
}

/** Backing-store pixels per building pixel: the zoom times the device ratio, capped so a huge building at 4x stays drawable. */
export function backingScale(area: Rect, zoom: number, ratio: number): number {
  const wanted = zoom * Math.max(1, ratio)
  const world = area.width * OFFICE_TILE * area.height * OFFICE_TILE
  return Math.min(wanted, Math.sqrt(MAX_BACKING_PIXELS / Math.max(1, world)))
}

interface Drawing { tiles: readonly PlacedTile[]; props: readonly PlacedProp[]; area: Rect; scale: number; tileSheet: HTMLImageElement; propSheet: HTMLImageElement }

function paint(canvas: HTMLCanvasElement, d: Drawing): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.imageSmoothingEnabled = false
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  const edge = (tile: number, origin: number): number => Math.round((tile - origin) * OFFICE_TILE * d.scale)
  for (const tile of d.tiles) {
    const frame = tileFrames[tile.frame]
    if (!frame) continue
    const x0 = edge(tile.x, d.area.x); const y0 = edge(tile.y, d.area.y)
    const w = edge(tile.x + 1, d.area.x) - x0; const h = edge(tile.y + 1, d.area.y) - y0
    if (!tile.rotate) { ctx.drawImage(d.tileSheet, frame.x, frame.y, frame.w, frame.h, x0, y0, w, h); continue }
    ctx.save()
    ctx.translate(x0 + w / 2, y0 + h / 2)
    ctx.rotate((tile.rotate * Math.PI) / 180)
    ctx.drawImage(d.tileSheet, frame.x, frame.y, frame.w, frame.h, -w / 2, -h / 2, w, h)
    ctx.restore()
  }
  const sorted = [...d.props].sort((a, b) => (a.y * OFFICE_TILE + depthOffset(a.name)) - (b.y * OFFICE_TILE + depthOffset(b.name)) || a.x - b.x)
  for (const prop of sorted) {
    const frame = propFrames[`prop.${prop.name}`]
    if (!frame) continue
    const x0 = edge(prop.x, d.area.x); const y0 = edge(prop.y, d.area.y)
    ctx.drawImage(d.propSheet, frame.x, frame.y, frame.w, frame.h, x0, y0, Math.round(frame.w * d.scale), Math.round(frame.h * d.scale))
  }
}

/** `{Department} · {n}` on each room's north wall; DOM so the text stays crisp at every zoom and in the accessibility tree. */
export function OfficeRoomLabels({ building, area, zoom }: { building: Building; area: Rect; zoom: number }): ReactElement {
  return <>{building.rooms.map(room => <div
    className="office-room-label" key={room.id} data-office-department-id={room.group} data-office-room-label={room.label}
    style={{ left: (room.x + 1 - area.x) * OFFICE_TILE * zoom, top: (room.y - area.y) * OFFICE_TILE * zoom, maxWidth: (room.width - 2) * OFFICE_TILE * zoom }}
  >{room.label} · {room.agents.length}</div>)}</>
}

export function OfficeBuilding({ building, tiles, props, palette, zoom, area }: OfficeBuildingProps): ReactElement {
  const canvas = useRef<HTMLCanvasElement>(null)
  const ratio = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1
  const scale = backingScale(area, zoom, ratio)
  const width = Math.max(1, Math.round(area.width * OFFICE_TILE * scale))
  const height = Math.max(1, Math.round(area.height * OFFICE_TILE * scale))
  const sheets = sheetsFor(palette)
  // The cells outside the front door get a mat so arrivals do not step out of a blank edge.
  const entrance = building.frontDoorCells.map(cell => ({ x: cell.x - 1, y: cell.y, frame: 'tile.43' }))
  useLayoutEffect(() => {
    const element = canvas.current
    if (!element) return
    let cancelled = false
    const drawing = (tileSheet: HTMLImageElement, propSheet: HTMLImageElement): Drawing => ({ tiles: [...tiles, ...entrance], props, area, scale, tileSheet, propSheet })
    const done = (): void => { element.dataset.drawn = 'true' }
    const cachedTiles = images.get(sheets.tiles)
    const cachedProps = images.get(sheets.props)
    element.dataset.drawn = 'false'
    if (cachedTiles && cachedProps) { paint(element, drawing(cachedTiles, cachedProps)); done(); return }
    void Promise.all([loadImage(sheets.tiles), loadImage(sheets.props)]).then(([tileSheet, propSheet]) => {
      if (cancelled) return
      paint(element, drawing(tileSheet, propSheet)); done()
    }).catch(() => undefined)
    return () => { cancelled = true }
  }, [tiles, props, area.x, area.y, area.width, area.height, scale, width, height, sheets.tiles, sheets.props])
  return <canvas
    ref={canvas} className="office-building" data-testid="office-building" aria-hidden="true"
    data-tile-count={tiles.length + entrance.length} data-prop-count={props.length}
    width={width} height={height}
    style={{ width: area.width * OFFICE_TILE * zoom, height: area.height * OFFICE_TILE * zoom }}
  />
}
