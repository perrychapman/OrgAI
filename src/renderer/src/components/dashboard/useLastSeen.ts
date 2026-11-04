import { useCallback, useEffect, useRef, useState } from 'react'
import { readLastSeen, writeLastSeen } from '../../lib/dashboard'
import { useAppStore } from '../../store/useAppStore'

/** When the user last pressed "Mark all seen" (or, before that, the first load). Runs cut while waiting stay until then. */
const CLEARED_KEY = 'orgai.dashboardClearedAt'

function storage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function readCleared(store: Storage | null): number | null {
  try {
    const n = Number(store?.getItem(CLEARED_KEY))
    return Number.isFinite(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

function writeCleared(store: Storage | null, ms: number): void {
  try {
    store?.setItem(CLEARED_KEY, String(Math.floor(ms)))
  } catch {
    // ignore
  }
}

/**
 * Spec 4.3. `lastSeen` is the time the user last left the Dashboard (localStorage `orgai.dashboardSeenAt`).
 * - No stored value (first ever load): the current time is written and used, so nothing shows.
 * - On unmount the stored value advances to this visit's start, but only when the view moved away inside the app. A
 *   reload, quit or window close never advances it, so runs cut by a quit still show after relaunch.
 * - `markAllSeen` writes now and updates `lastSeen` and `clearedAt`.
 * - `clearedAt` moves only on `markAllSeen`: runs cut while they waited on the user (Continue rows) stay until then,
 *   however often the user leaves the Dashboard.
 */
export function useLastSeen(): { lastSeen: number; clearedAt: number; markAllSeen: () => void } {
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
  const [clearedAt, setClearedAt] = useState<number>(() => {
    const store = storage()
    const stored = readCleared(store)
    if (stored !== null) return stored
    // First load with this key: nothing older than the last-seen time resurfaces.
    const initial = readLastSeen(store) ?? Date.now()
    writeCleared(store, initial)
    return initial
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
    writeCleared(storage(), now)
    setLastSeen(now)
    setClearedAt(now)
  }, [])

  return { lastSeen, clearedAt, markAllSeen }
}
