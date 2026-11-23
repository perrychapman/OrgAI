import { useEffect, useMemo, useState } from 'react'
import type { Schedule, ScheduleCostReport, ScheduleHistoryEntry } from '@shared/types'

export type InsightStatus = 'loading' | 'ok' | 'failed'
export interface CostsState {
  status: InsightStatus
  /** Absent while loading, after a failure, or when main answers something that is not a report (unknown). */
  report?: ScheduleCostReport
}
export interface HistoryState {
  status: InsightStatus
  entries?: ScheduleHistoryEntry[]
}

/** Changes whenever a schedule's stored figures could have: its last entry, update time, enabled state. */
function signature(list: readonly Schedule[]): string {
  return list.map((s) => `${s.id}:${s.updatedAt}:${s.lastEntry?.at ?? 0}:${s.lastEntry?.outcome ?? ''}:${s.enabled ? 1 : 0}`).join('|')
}

/**
 * Weekly cost figures and the last-runs peek for every schedule (runInsights.scheduleCosts / scheduleHistory). The
 * history call is a peek: it never clears the unread count. A rejected call is "failed", an answer of another shape
 * is treated as unknown (no report / no entries), never as zero.
 */
export function useScheduleInsights(list: readonly Schedule[] | null): { costs: CostsState; histories: Record<string, HistoryState> } {
  const [costs, setCosts] = useState<CostsState>({ status: 'loading' })
  const [histories, setHistories] = useState<Record<string, HistoryState>>({})
  const sig = useMemo(() => (list ? signature(list) : null), [list])
  // eslint-disable-next-line react-hooks/exhaustive-deps -- recomputed only when the signature changes
  const ids = useMemo(() => (list ? list.map((s) => s.id) : []), [sig])

  useEffect(() => {
    if (sig === null) return
    let live = true
    const api = window.orgai.runInsights
    if (!api || typeof api.scheduleCosts !== 'function') {
      setCosts({ status: 'failed' })
      return
    }
    api.scheduleCosts().then(
      (r) => {
        if (!live) return
        const ok = !!r && typeof r === 'object' && Array.isArray((r as ScheduleCostReport).schedules)
        setCosts({ status: 'ok', report: ok ? r : undefined })
      },
      () => live && setCosts((c) => (c.report ? c : { status: 'failed' }))
    )
    return () => {
      live = false
    }
  }, [sig])

  useEffect(() => {
    if (sig === null) return
    let live = true
    const api = window.orgai.runInsights
    for (const id of ids) {
      if (!api || typeof api.scheduleHistory !== 'function') {
        setHistories((h) => ({ ...h, [id]: { status: 'failed' } }))
        continue
      }
      api.scheduleHistory(id).then(
        (e) => live && setHistories((h) => ({ ...h, [id]: { status: 'ok', entries: Array.isArray(e) ? e : undefined } })),
        () => live && setHistories((h) => (h[id]?.entries ? h : { ...h, [id]: { status: 'failed' } }))
      )
    }
    return () => {
      live = false
    }
  }, [sig, ids])

  return { costs, histories }
}
