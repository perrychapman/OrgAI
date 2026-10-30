import type { KeyboardEvent, PointerEvent, ReactElement } from 'react'
import { useRef } from 'react'
import { dragWidth, keyWidth } from '../../lib/panelWidth'

/**
 * A thin vertical drag handle on the edge of a column (a `role="separator"`). It lives inside the column it resizes,
 * on the edge facing the neighbour, so it never overlaps the canvas. `edge="end"` is a left column's right edge
 * (dragging right grows it); `edge="start"` is a right column's left edge (dragging left grows it).
 * Pointer drag (captured), arrow keys (Shift for bigger steps), Home/End and double-click to reset.
 */
export function ResizeHandle({
  label,
  value,
  min,
  max,
  edge,
  onChange,
  onReset,
  testId
}: {
  label: string
  value: number
  min: number
  max: number
  edge: 'start' | 'end'
  onChange: (next: number) => void
  onReset: () => void
  testId?: string
}): ReactElement {
  const dir = edge === 'end' ? 1 : -1
  const drag = useRef<{ x: number; w: number } | null>(null)
  const down = (e: PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { x: e.clientX, w: value }
    document.documentElement.setAttribute('data-resizing', 'true')
    e.preventDefault()
    e.currentTarget.focus()
  }
  const move = (e: PointerEvent<HTMLDivElement>): void => {
    if (drag.current) onChange(dragWidth(drag.current.w, e.clientX - drag.current.x, dir, min, max))
  }
  const up = (e: PointerEvent<HTMLDivElement>): void => {
    drag.current = null
    document.documentElement.removeAttribute('data-resizing')
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
  }
  const key = (e: KeyboardEvent<HTMLDivElement>): void => {
    const next = keyWidth(value, e.key, e.shiftKey, dir, min, max)
    if (next === null) return
    e.preventDefault()
    onChange(next)
  }
  return (
    <div
      className="resize-handle"
      data-edge={edge}
      data-testid={testId}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onDoubleClick={onReset}
      onKeyDown={key}
    />
  )
}
