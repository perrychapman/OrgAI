import { useCallback, useEffect, useRef, useState } from 'react'
import { useOutputDetail } from '../outputDetailContext'

const NOTICE_MS = 8000

export interface SurfaceNotes {
  /** Text of the surface's own polite `output-live` region (unused when `routed`). */
  live: string
  /**
   * True inside an output detail or viewer: speech goes through the detail's one `output-live` (spec 14.2), so the
   * surface renders no live region of its own.
   */
  routed: boolean
  /** The visible, non-live notice line. */
  notice: string
  speak: (text: string) => void
  /** Shows the notice and speaks it. */
  notify: (text: string) => void
}

/** The live route and the one visible notice line of a viewer (used by the SVG and image surfaces; the diagram has its own). */
export function useSurfaceNotes(): SurfaceNotes {
  const detail = useOutputDetail()
  const announce = detail?.announce
  const [live, setLive] = useState('')
  const [notice, setNotice] = useState('')
  const speakTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const speak = useCallback(
    (t: string): void => {
      if (announce) {
        announce(t)
        return
      }
      setLive('')
      if (speakTimer.current) clearTimeout(speakTimer.current)
      speakTimer.current = setTimeout(() => setLive(t), 60)
    },
    [announce]
  )
  const notify = useCallback(
    (t: string): void => {
      setNotice(t)
      speak(t)
      if (noticeTimer.current) clearTimeout(noticeTimer.current)
      noticeTimer.current = setTimeout(() => setNotice(''), NOTICE_MS)
    },
    [speak]
  )
  useEffect(
    () => () => {
      if (speakTimer.current) clearTimeout(speakTimer.current)
      if (noticeTimer.current) clearTimeout(noticeTimer.current)
    },
    []
  )
  return { live, routed: !!announce, notice, speak, notify }
}
