import { useEffect, useState } from 'react'
import type { RunRecord, RunSummary } from '@shared/types'
import { useAppStore } from '../../store/useAppStore'

/**
 * The full record (agents, plan) of one run for the History detail panel. A run the store already holds with its agents
 * is read from the store (it stays current while live); any other is fetched once through runs:get and again when its
 * status or end time changes. Null while loading, when the run is unknown, or when the fetch failed: the panel then
 * leaves out the sections that need it.
 */
export function useRunRecord(run: Pick<RunSummary, 'id' | 'status' | 'endedAt'> | undefined): RunRecord | null {
  const id = run?.id
  const fromStore = useAppStore((s) => (id ? s.runs[id] : undefined))
  const usable = !!fromStore && Object.keys(fromStore.agents ?? {}).length > 0
  const [fetched, setFetched] = useState<{ id: string; record: RunRecord } | null>(null)
  const version = run ? `${run.status}:${run.endedAt ?? ''}` : ''

  useEffect(() => {
    if (!id || usable) return
    let live = true
    window.orgai.runs
      .get(id)
      .then((record) => {
        if (live && record) setFetched({ id, record })
      })
      .catch(() => {
        if (live) setFetched((f) => (f && f.id === id ? f : null))
      })
    return () => {
      live = false
    }
  }, [id, usable, version])

  if (!id) return null
  if (usable && fromStore) return fromStore as RunRecord
  return fetched && fetched.id === id ? fetched.record : null
}
