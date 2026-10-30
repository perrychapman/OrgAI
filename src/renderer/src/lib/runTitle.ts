import type { RunSummary } from '../../../shared/types'

/** A run.title event applied to a history list: the row for that run gets the title, other lists come back untouched. */
export function withRunTitle(list: RunSummary[], runId: string, title: string): RunSummary[] {
  return list.some((h) => h.id === runId) ? list.map((h) => (h.id === runId ? { ...h, title } : h)) : list
}
