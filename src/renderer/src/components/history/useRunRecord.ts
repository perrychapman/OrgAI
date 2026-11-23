import { useEffect, useState } from 'react'
import type { RunRecord, RunSummary } from '@shared/types'
import { useAppStore } from '../../store/useAppStore'

export type RecordPhase = 'loading' | 'ready' | 'failed'

/**
 * The full record (agents, plan) of one run for the History detail panel. A run the store already holds with its agents
 * is read from the store (it stays current while live); any other is fetched once through runs:get and again when its
 * status or end time changes. `phase` tells loading from failed (the fetch threw or main had no such run) so the panel
 * can say which instead of leaving a section out silently.
 */
export function useRunRecord(run: Pick<RunSummary, 'id' | 'status' | 'endedAt'> | undefined): { record: RunRecord | null; phase: RecordPhase } {
  const id = run?.id
  const fromStore = useAppStore((s) => (id ? s.runs[id] : undefined))
  const usable = !!fromStore && Object.keys(fromStore.agents ?? {}).length > 0
  const [fetched, setFetched] = useState<{ id: string; record: RunRecord | null; failed: boolean } | null>(null)
  const version = run ? `${run.status}:${run.endedAt ?? ''}` : ''

  useEffect(() => {
    if (!id || usable) return
    let live = true
    window.orgai.runs
      .get(id)
      .then((record) => {
        if (live) setFetched({ id, record: record ?? null, failed: !record })
      })
      .catch(() => {
        if (live) setFetched((f) => (f && f.id === id && f.record ? f : { id, record: null, failed: true }))
      })
    return () => {
      live = false
    }
  }, [id, usable, version])

  if (!id) return { record: null, phase: 'loading' }
  if (usable && fromStore) return { record: fromStore as RunRecord, phase: 'ready' }
  if (fetched && fetched.id === id) return fetched.record ? { record: fetched.record, phase: 'ready' } : { record: null, phase: 'failed' }
  return { record: null, phase: 'loading' }
}
