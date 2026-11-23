import type { RunStatus } from '@shared/types'
import type { KnowledgeItem } from './knowledge'
import { itemRetired, itemSource } from './knowledge'

/**
 * What the Knowledge tab says about runs that are working right now. Every figure traces to real data: a run counts
 * while its status is starting or running, an item counts when its recorded source names such a run. Pure.
 */
export interface Recording {
  /** Runs of this project that are working now. */
  runs: number
  /** Live items those runs recorded. */
  items: number
}

const WORKING: readonly RunStatus[] = ['starting', 'running']

export function recordingNow(items: readonly KnowledgeItem[], runs: readonly { id: string; status: RunStatus }[]): Recording {
  const working = new Set(runs.filter((r) => WORKING.includes(r.status)).map((r) => r.id))
  if (working.size === 0) return { runs: 0, items: 0 }
  let n = 0
  for (const i of items) {
    if (itemRetired(i)) continue
    const s = itemSource(i)
    if (s.by === 'agent' && s.runId && working.has(s.runId)) n++
  }
  return { runs: working.size, items: n }
}

/** "The team is working", "The team is working · 6 recorded in the current run"; null when nothing is running. */
export function recordingText(r: Recording): string | null {
  if (r.runs === 0) return null
  if (r.items === 0) return 'The team is working'
  return `The team is working · ${r.items} recorded in ${r.runs === 1 ? 'the current run' : 'the current runs'}`
}
