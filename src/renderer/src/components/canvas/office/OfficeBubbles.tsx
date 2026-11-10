import type { ReactElement } from 'react'

/**
 * Speech bubbles above recipients (rework spec section 4). Slice S5b fills this in; the seam is fixed here:
 * `bubbles` are the active deliveries for this render (newest per recipient, at most three), `positions` maps a person
 * id to the sprite's top-left in building pixels (what `data-office-x/y` reports) and `zoom` is the camera zoom. The
 * layer sits in the world's coordinate space, above the people art and below nothing else, with `pointer-events: none`.
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
}

export function OfficeBubbles(_props: OfficeBubblesProps): ReactElement | null {
  return null
}
