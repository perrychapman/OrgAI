import { useEffect, useState, type ReactElement, type RefObject } from 'react'
import { contentSize, mapOffset, toContent, type Point, type Rect, type Size } from '../../../lib/office/camera'
import { Button } from '../../ui/Button'
import { WORKER_SIZE } from './officeArt'

/**
 * Off-screen cues (deviation from the rework spec, after the UX walk): the default 2x view crops larger buildings, so a
 * bubble or a Needs-you mark can happen outside the stage. A short chip names each such person and the direction, and
 * pans to them (the same Show as the strip). Nothing moves on its own: the camera never follows a conversation.
 */
export interface OffscreenItem { id: string; name: string; reason: 'message' | 'needs you' }
export interface OfficeOffscreenProps {
  stage: RefObject<HTMLDivElement | null>
  items: readonly OffscreenItem[]
  /** Sprite top-left per person, building pixels. */
  positions: ReadonlyMap<string, Point>
  area: Rect
  zoom: number
  client: Size
  onShow(id: string): void
}

const MAX_CHIPS = 2
const WORDS: Record<string, string> = { left: 'left', right: 'right', up: 'above', down: 'below' }
const ARROWS: Record<string, string> = { left: '←', right: '→', up: '↑', down: '↓' }

export function OfficeOffscreen({ stage, items, positions, area, zoom, client, onShow }: OfficeOffscreenProps): ReactElement | null {
  const [scroll, setScroll] = useState<Point>({ x: 0, y: 0 })
  useEffect(() => {
    const element = stage.current
    if (!element || !items.length) return
    let frame = 0
    const read = (): void => { frame = 0; setScroll(previous => previous.x === element.scrollLeft && previous.y === element.scrollTop ? previous : { x: element.scrollLeft, y: element.scrollTop }) }
    const onScroll = (): void => { if (!frame) frame = requestAnimationFrame(read) }
    read()
    element.addEventListener('scroll', onScroll, { passive: true })
    return () => { element.removeEventListener('scroll', onScroll); cancelAnimationFrame(frame) }
  }, [stage, items.length])
  if (!items.length || !client.width || !client.height) return null
  const content = contentSize({ area, zoom })
  if (content.width <= client.width && content.height <= client.height) return null
  const offset = mapOffset({ area, zoom, client })
  const away = items.flatMap(item => {
    const at = positions.get(item.id)
    if (!at) return []
    const c = toContent({ area, zoom }, { x: at.x + WORKER_SIZE.width / 2, y: at.y + WORKER_SIZE.height / 2 })
    const x = offset.x + c.x - scroll.x
    const y = offset.y + c.y - scroll.y
    const side = x < 0 ? 'left' : x > client.width ? 'right' : y < 0 ? 'up' : y > client.height ? 'down' : null
    return side ? [{ ...item, side }] : []
  })
  if (!away.length) return null
  return <span className="office-offscreen" data-testid="office-offscreen">
    {away.slice(0, MAX_CHIPS).map(item => <Button
      key={item.id} size="sm" testId="office-offscreen-show"
      ariaLabel={`Show ${item.name}, ${item.reason}, off screen ${WORDS[item.side]}`} onClick={() => onShow(item.id)}
    ><span aria-hidden="true">{ARROWS[item.side]}</span> {item.name} · {item.reason}</Button>)}
    {away.length > MAX_CHIPS && <span className="office-offscreen-more">+{away.length - MAX_CHIPS} more</span>}
  </span>
}
