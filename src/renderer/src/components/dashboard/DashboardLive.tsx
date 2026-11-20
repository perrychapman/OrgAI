import type { ReactElement } from 'react'
import { useEffect, useRef, useState } from 'react'
import type { DashboardAnnouncement } from './DashboardContext'

const TOGETHER_MS = 1500

/**
 * The page's one polite live region `dashboard-live` (docs/design/dashboard-overhaul.md section 10): visually hidden,
 * empty on mount, it speaks only the messages passed in `announce` (never the brief, counts, costs or times); messages
 * within 1.5 s are spoken as one. Rendered inside the greeting.
 */
export function DashboardLive({ announce }: { announce: DashboardAnnouncement | null }): ReactElement {
  const [spoken, setSpoken] = useState('')
  const lastAnnounce = useRef(announce)
  const spokenRef = useRef('')
  const announceAt = useRef(0)
  useEffect(() => {
    if (lastAnnounce.current?.seq === announce?.seq) return
    lastAnnounce.current = announce
    if (!announce) return
    const t = Date.now()
    const text = t - announceAt.current < TOGETHER_MS && spokenRef.current ? `${spokenRef.current} ${announce.text}` : announce.text
    announceAt.current = t
    spokenRef.current = text
    setSpoken(text)
  }, [announce])
  return (
    <div className="sr-only" role="status" aria-live="polite" data-testid="dashboard-live">
      {spoken}
    </div>
  )
}
