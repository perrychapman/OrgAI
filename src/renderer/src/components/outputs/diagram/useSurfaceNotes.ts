import { useCallback, useEffect, useRef, useState } from 'react'

const NOTICE_MS = 8000

export interface SurfaceNotes {
  /** Text of the surface's one polite `output-live` region. */
  live: string
  /** The visible, non-live notice line. */
  notice: string
  speak: (text: string) => void
  /** Shows the notice and speaks it. */
  notify: (text: string) => void
}

/** The one live region and the one visible notice line of a viewer (used by the SVG and image surfaces; the diagram has its own). */
export function useSurfaceNotes(): SurfaceNotes {
  const [live, setLive] = useState('')
  const [notice, setNotice] = useState('')
  const speakTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const speak = useCallback((t: string): void => {
    setLive('')
    if (speakTimer.current) clearTimeout(speakTimer.current)
    speakTimer.current = setTimeout(() => setLive(t), 60)
  }, [])
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
  return { live, notice, speak, notify }
}
