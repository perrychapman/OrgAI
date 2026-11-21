import { useEffect, useRef, useState } from 'react'

/** How long a person's change keeps waiting for its data before the draw is given up (the fetch is debounced and async). */
export const DRAW_ARM_MS = 5_000

/**
 * Draw motion for a data drawing that is not a panel (the KPI sparklines, the dial, the donut): it draws once while
 * the page stages its arrival, and again when the person changes a filter or metric (`drawSeq` bumped) AND the new data
 * has arrived (`signature` changed). A background refresh changes the signature without a bump, so it never draws.
 * Put `key={key}` on the drawn element so a new key replays its CSS animation, and the draw class only while `draw`.
 */
export function useDrawKey(drawSeq: number, signature: string, arriving: boolean): { draw: boolean; key: number } {
  const seenSeq = useRef(drawSeq)
  const lastSignature = useRef(signature)
  const armed = useRef(false)
  const timer = useRef<number | null>(null)
  const [key, setKey] = useState(0)

  useEffect(() => {
    if (drawSeq === seenSeq.current) return
    seenSeq.current = drawSeq
    armed.current = true
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      armed.current = false
      timer.current = null
    }, DRAW_ARM_MS)
  }, [drawSeq])

  useEffect(() => {
    if (signature === lastSignature.current) return
    lastSignature.current = signature
    if (!armed.current) return
    armed.current = false
    if (timer.current !== null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
    setKey((k) => k + 1)
  }, [signature])

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current)
    },
    []
  )

  return { draw: arriving || key > 0, key }
}
