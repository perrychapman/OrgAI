import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement } from 'react'
import { OFFICE_TILE_PX, type Rect, type Size } from '../../../lib/office/camera'
import { bubbleDurationMs, bubbleText, DEFAULT_BUBBLE_TIMING, DEFAULT_JOURNEY_TIMING, TALK_MARK_TICKS, type BubbleTiming } from '../../../lib/office/motion'
import { bubbleWindow, deliveryEnd, type Delivery } from '../../../lib/office/scheduler'
import { tokenMs } from '../../../lib/useExitPresence'
import { WORKER_SIZE } from './officeArt'
import type { SpriteRegistry } from './OfficeSprites'

/**
 * Speech bubbles above recipients (rework spec section 4). `bubbles` are the active deliveries for this render (newest
 * per recipient, at most three), `positions` maps a person id to the sprite's top-left in building pixels (what
 * `data-office-x/y` reports). The layer lives in the world's coordinate space (screen pixels, not scaled by zoom), is
 * `aria-hidden` and `pointer-events: none`: the strip and the inspector carry the full text, nothing is announced.
 */
export interface OfficeBubble {
  /** Stable key: one per delivery. */
  id: string
  /** Recipient (the bubble sits above this person). */
  to: string
  /** Sender id and display name (`{Sender}: {text}`). */
  from: string
  sender: string
  text: string
}
export interface OfficeBubblesProps {
  bubbles: readonly OfficeBubble[]
  positions: ReadonlyMap<string, { x: number; y: number }>
  zoom: number
  /** Building area in tiles (the camera's `area`) and the world's size in screen pixels: bubbles stay inside it. */
  area: Rect
  size: Size
  /** The person registry: a bubble that has to flip below its person clears that person's nameplate. */
  spriteRefs?: SpriteRegistry
}

/** Bubble timing from the `--office-bubble-*` tokens (no literal ms in components). */
export function bubbleTiming(): BubbleTiming {
  return {
    baseMs: tokenMs('--office-bubble-base') || DEFAULT_BUBBLE_TIMING.baseMs,
    perCharMs: tokenMs('--office-bubble-per-char') || DEFAULT_BUBBLE_TIMING.perCharMs,
    maxMs: tokenMs('--office-bubble-max') || DEFAULT_BUBBLE_TIMING.maxMs
  }
}

/** Give every delivery its readable time from the tokens (the scheduler's default is the same formula with the shipped values). */
export function applyBubbleTiming(deliveries: readonly Delivery[], timing: BubbleTiming): void {
  for (const delivery of deliveries) if (delivery.bubbleMs === undefined) delivery.bubbleMs = bubbleDurationMs(delivery.message.text, timing)
}

/** People in an exchange right now: sender and recipient of every delivery from its start until its walk and bubble are over. */
export function exchangeParticipants(deliveries: readonly Delivery[], now: number): Set<string> {
  const ids = new Set<string>()
  for (const delivery of deliveries) {
    if (now < delivery.started || now >= deliveryEnd(delivery) || !delivery.message.to) continue
    ids.add(delivery.message.from); ids.add(delivery.message.to)
  }
  return ids
}

const keys = new WeakMap<object, number>()
let nextKey = 1
/** One stable id per message object, so a bubble keeps its DOM node while it is shown. */
export function bubbleKey(delivery: Delivery): string {
  let key = keys.get(delivery.message)
  if (key === undefined) { key = nextKey++; keys.set(delivery.message, key) }
  return `bubble-${key}`
}

/**
 * Nothing renders per frame outside walks (bubble-only phases, reduced motion, Pause), so wake the scene at the next
 * boundary of any delivery: talk mark end, bubble start and end, delivery end.
 */
export function useDeliveryBoundaries(deliveries: readonly Delivery[], motionOff: boolean, now: number): void {
  const [, wake] = useState(0)
  const stepMs = useMemo(() => tokenMs('--office-step-duration') || DEFAULT_JOURNEY_TIMING.stepMs, [])
  let next = Infinity
  for (const delivery of deliveries) {
    const window = bubbleWindow(delivery)
    const walkEnd = delivery.durationMs !== undefined ? delivery.started + delivery.durationMs : Infinity
    for (const time of [delivery.started, delivery.started + TALK_MARK_TICKS * stepMs, window.start, window.end, walkEnd, deliveryEnd(delivery)]) if (time > now && time < next) next = time
  }
  useEffect(() => {
    // Also with motion on: the delivery loop only renders per frame while someone walks, not during bubble-only phases.
    if (!Number.isFinite(next)) return
    const timer = window.setTimeout(() => wake(count => count + 1), Math.max(0, next - Date.now()) + 1)
    return () => window.clearTimeout(timer)
  }, [motionOff, next])
}

/** Gap between the bubble's tail tip and the top of the person's state mark, and the tail's own height. */
const GAP = 3
const TAIL = 8
const EDGE = 2
const FALLBACK_PLATE = 40

/** When a bubble opens sideways below the plate, its tail sits this far in from the bubble's edge. */
const BELOW_TAIL_INSET = 14

interface BubbleViewProps { bubble: OfficeBubble; x: number; y: number; senderX: number | null; zoom: number; area: Rect; size: Size; spriteRefs?: SpriteRegistry }

function BubbleView({ bubble, x, y, senderX, zoom, area, size, spriteRefs }: BubbleViewProps): ReactElement {
  const ref = useRef<HTMLDivElement>(null)
  const shown = bubbleText(bubble.text)
  const senderCentre = senderX === null ? null : Math.round((senderX + WORKER_SIZE.width / 2 - area.x * OFFICE_TILE_PX) * zoom)
  // Screen pixels inside the world: head centre, the top of the 16 x 16 mark above the head, and the target's bottom edge.
  const centre = Math.round((x + WORKER_SIZE.width / 2 - area.x * OFFICE_TILE_PX) * zoom)
  const markTop = Math.round((y - 13 - area.y * OFFICE_TILE_PX) * zoom)
  const boxBottom = Math.round((y + WORKER_SIZE.height / 2 - area.y * OFFICE_TILE_PX) * zoom + Math.max(24, WORKER_SIZE.height * zoom) / 2)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const width = element.offsetWidth
    const height = element.offsetHeight
    const fits = size.width >= width + 2 * EDGE
    const clampLeft = (value: number): number => fits ? Math.min(Math.max(value, EDGE), size.width - width - EDGE) : (size.width - width) / 2
    let left = clampLeft(centre - width / 2)
    let top = markTop - GAP - TAIL - height
    let placement = 'above'
    if (top < 0) {
      const plate = spriteRefs?.current.get(bubble.to)?.plate
      const below = boxBottom + 2 + (plate && plate.offsetHeight ? plate.offsetHeight : FALLBACK_PLATE) + GAP + TAIL
      if (below + height <= size.height) {
        top = below; placement = 'below'
        // Below the recipient's plate the bubble shares a row with the neighbours' plates: open it away from the sender,
        // whose plate shows for the exchange, so it does not cover their name.
        if (senderCentre !== null && senderCentre !== centre) left = clampLeft(senderCentre < centre ? centre - BELOW_TAIL_INSET : centre - width + BELOW_TAIL_INSET)
      } else top = Math.max(0, top)
    }
    element.style.left = `${Math.round(left)}px`
    element.style.top = `${Math.round(top)}px`
    element.style.setProperty('--office-bubble-tail', `${Math.round(Math.min(Math.max(centre - left, 10), Math.max(10, width - 10)))}px`)
    element.dataset.placement = placement
  }, [centre, markTop, boxBottom, size.width, size.height, shown, spriteRefs, bubble.to, senderCentre])
  return <div
    ref={ref} className="office-bubble" aria-hidden="true" data-testid="office-bubble" data-office-bubble-for={bubble.to} data-office-bubble-from={bubble.from}
    data-placement="above" style={{ left: centre, top: markTop } as CSSProperties}
  >
    <span className="office-bubble-text"><b>{bubble.sender}:</b> {shown}</span>
  </div>
}

export function OfficeBubbles({ bubbles, positions, zoom, area, size, spriteRefs }: OfficeBubblesProps): ReactElement | null {
  if (!bubbles.length) return null
  return <div className="office-bubbles" aria-hidden="true">
    {bubbles.map(bubble => {
      const at = positions.get(bubble.to)
      return at ? <BubbleView key={bubble.id} bubble={bubble} x={at.x} y={at.y} senderX={positions.get(bubble.from)?.x ?? null} zoom={zoom} area={area} size={size} spriteRefs={spriteRefs} /> : null
    })}
  </div>
}
