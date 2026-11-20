import { useCallback, useEffect, useState } from 'react'
import { LAYOUT_KEY, normalizeLayout, readLayout, writeLayout, type DashboardLayout } from '../../lib/dashboardLayout'

function storage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

/**
 * The person's Dashboard layout (docs/design/dashboard-overhaul.md 4.2, 6.4): read once on mount, written on every change,
 * and followed through the `storage` event so a second window agrees. A storage that throws keeps the layout in memory.
 */
export function useDashboardLayout(): [DashboardLayout, (change: (l: DashboardLayout) => DashboardLayout) => void] {
  const [layout, setLayout] = useState<DashboardLayout>(() => readLayout(storage()))

  useEffect(() => {
    const onStorage = (e: StorageEvent): void => {
      if (e.key !== LAYOUT_KEY) return
      let parsed: unknown = null
      try {
        parsed = e.newValue ? JSON.parse(e.newValue) : null
      } catch {
        parsed = null
      }
      setLayout(normalizeLayout(parsed))
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const update = useCallback((change: (l: DashboardLayout) => DashboardLayout) => {
    setLayout((prev) => {
      const next = change(prev)
      if (next !== prev) writeLayout(storage(), next)
      return next
    })
  }, [])

  return [layout, update]
}
