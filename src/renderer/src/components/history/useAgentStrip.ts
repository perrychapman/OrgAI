import { useEffect, useRef, useState, type RefObject } from 'react'
import type { AgentInstance, RunSummary } from '@shared/types'
import { useAppStore } from '../../store/useAppStore'

/** At most this many runs:get calls run at once for the row agent strips. */
const MAX_PARALLEL = 3
/** Cache size: the newest records kept so scrolling back does not fetch again. */
const CACHE_LIMIT = 200

export type StripPhase = 'waiting' | 'loading' | 'ready' | 'failed'
export interface StripState {
  phase: StripPhase
  agents: AgentInstance[]
}

const cache = new Map<string, AgentInstance[]>()
const failed = new Set<string>()
const queue: { key: string; id: string; done: () => void }[] = []
let running = 0

function pump(): void {
  while (running < MAX_PARALLEL && queue.length > 0) {
    const job = queue.shift()
    if (!job) break
    running++
    window.orgai.runs
      .get(job.id)
      .then((rec) => {
        if (rec) {
          cache.set(job.key, Object.values(rec.agents ?? {}))
          if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string)
          failed.delete(job.key)
        } else failed.add(job.key)
      })
      .catch(() => failed.add(job.key))
      .finally(() => {
        running--
        job.done()
        pump()
      })
  }
}

/**
 * The final agent states of one run for a History row. Nothing is fetched until the row is on screen (an
 * IntersectionObserver on `ref`), at most three runs are fetched at a time, and a result is cached per run, status and
 * end time. A run the store already holds with its agents is read from the store. 'failed' = the record could not be
 * read: the row says so, it does not draw an empty strip.
 */
export function useAgentStrip(run: Pick<RunSummary, 'id' | 'status' | 'endedAt'>, ref: RefObject<HTMLElement | null>): StripState {
  const fromStore = useAppStore((s) => s.runs[run.id])
  const storeAgents = fromStore ? Object.values(fromStore.agents ?? {}) : []
  const key = `${run.id}:${run.status}:${run.endedAt ?? ''}`
  const [, bump] = useState(0)
  const [visible, setVisible] = useState(false)
  const keyRef = useRef(key)
  keyRef.current = key

  useEffect(() => {
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined') {
      setVisible(true)
      return
    }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setVisible(true)
    })
    io.observe(el)
    return () => io.disconnect()
  }, [ref])

  const useStore = storeAgents.length > 0
  const cached = cache.get(key)
  useEffect(() => {
    if (useStore || !visible || cache.has(key) || failed.has(key)) return
    if (queue.some((j) => j.key === key)) return
    queue.push({ key, id: run.id, done: () => { if (keyRef.current === key) bump((n) => n + 1) } })
    pump()
  }, [useStore, visible, key, run.id])

  if (useStore) return { phase: 'ready', agents: storeAgents }
  if (cached) return { phase: 'ready', agents: cached }
  if (failed.has(key)) return { phase: 'failed', agents: [] }
  return { phase: visible ? 'loading' : 'waiting', agents: [] }
}
