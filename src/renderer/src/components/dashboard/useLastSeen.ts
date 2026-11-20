import { useEffect, useRef, useState } from 'react'
import { readLastSeen, writeLastSeen } from '../../lib/dashboard'
import { useAppStore } from '../../store/useAppStore'

function storage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

/**
 * docs/design/dashboard-overhaul.md 5.4. `lastSeen` is the time the person last left the Dashboard (localStorage
 * `orgai.dashboardSeenAt`).
 * - No stored value (first ever load): the current time is written and used, and `firstVisit` is true (the brief then
 *   speaks of "the past 7 days").
 * - On unmount the stored value advances to this visit's start, but only when the view moved away inside the app. A
 *   reload, quit or window close never advances it, so runs cut by a quit still show after relaunch.
 * The old `orgai.dashboardClearedAt` value (the retired Clear) is ignored, not deleted.
 */
export function useLastSeen(): { lastSeen: number; firstVisit: boolean } {
  const visitStart = useRef(0)
  const [state] = useState<{ lastSeen: number; firstVisit: boolean }>(() => {
    const now = Date.now()
    visitStart.current = now
    const store = storage()
    const stored = readLastSeen(store)
    if (stored !== null) return { lastSeen: stored, firstVisit: false }
    writeLastSeen(store, now)
    return { lastSeen: now, firstVisit: true }
  })

  useEffect(
    () => () => {
      if (useAppStore.getState().view === 'projects') return
      const store = storage()
      writeLastSeen(store, Math.max(readLastSeen(store) ?? 0, visitStart.current))
    },
    []
  )

  return state
}
