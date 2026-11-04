import { useCallback, useEffect, useRef, useState } from 'react'
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
 * Spec 4.3. `lastSeen` is the time the user last left the Dashboard (localStorage `orgai.dashboardSeenAt`).
 * - No stored value (first ever load): the current time is written and used, so nothing shows.
 * - On unmount the stored value advances to this visit's start, but only when the view moved away inside the app. A
 *   reload, quit or window close never advances it, so runs cut by a quit still show after relaunch.
 * - `markAllSeen` writes now and updates `lastSeen`.
 */
export function useLastSeen(): { lastSeen: number; markAllSeen: () => void } {
  const visitStart = useRef(0)
  const [lastSeen, setLastSeen] = useState<number>(() => {
    const now = Date.now()
    visitStart.current = now
    const store = storage()
    const stored = readLastSeen(store)
    if (stored !== null) return stored
    writeLastSeen(store, now)
    return now
  })

  useEffect(
    () => () => {
      if (useAppStore.getState().view === 'projects') return
      const store = storage()
      // Never move backwards: "Mark all seen" may have written a later time during this visit.
      writeLastSeen(store, Math.max(readLastSeen(store) ?? 0, visitStart.current))
    },
    []
  )

  const markAllSeen = useCallback(() => {
    const now = Date.now()
    writeLastSeen(storage(), now)
    setLastSeen(now)
  }, [])

  return { lastSeen, markAllSeen }
}
