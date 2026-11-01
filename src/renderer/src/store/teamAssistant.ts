import { create } from 'zustand'
import type { TeamReview, TeamReviewSummary } from '@shared/types'

interface TeamAssistantState {
  summaries: Record<string, TeamReviewSummary>
  setSummary: (projectId: string, s: TeamReviewSummary) => void
  /** The user has seen the new items: zero newCount, keep the pending count. */
  clearNew: (projectId: string) => void
}

export const useTeamAssistantStore = create<TeamAssistantState>((set) => ({
  summaries: {},
  setSummary: (projectId, s) => set((st) => ({ summaries: { ...st.summaries, [projectId]: s } })),
  clearNew: (projectId) =>
    set((st) => {
      const cur = st.summaries[projectId]
      if (!cur || cur.newCount === 0) return st
      return { summaries: { ...st.summaries, [projectId]: { ...cur, newCount: 0 } } }
    })
}))

export function useTeamReviewSummary(projectId: string | null | undefined): TeamReviewSummary | undefined {
  return useTeamAssistantStore((s) => (projectId ? s.summaries[projectId] : undefined))
}

/** Map a persisted review to the badge summary. */
export function summaryFromReview(r: TeamReview): TeamReviewSummary {
  return {
    projectId: r.projectId,
    checkedAt: r.checkedAt,
    trigger: r.trigger,
    mode: r.mode,
    pendingCount: r.pendingCount,
    newCount: r.newCandidateIds.length,
    evidenceCount: r.evidence.length
  }
}

const seeded = new Set<string>()

/** Seed a project's summary from its last persisted review once (a pushed summary wins). */
export function seedTeamReview(projectId: string): void {
  if (seeded.has(projectId)) return
  seeded.add(projectId)
  void window.orgai.capabilities
    .lastReview(projectId)
    .then((r) => {
      if (!r) return
      if (useTeamAssistantStore.getState().summaries[projectId]) return
      useTeamAssistantStore.getState().setSummary(projectId, summaryFromReview(r))
    })
    .catch(() => seeded.delete(projectId))
}

let unsubscribe: (() => void) | null = null

/** Subscribe once to main's review pushes. Safe to call repeatedly. */
export function initTeamAssistant(): void {
  if (unsubscribe) return
  unsubscribe = window.orgai.onTeamReviewUpdated((s) => useTeamAssistantStore.getState().setSummary(s.projectId, s))
}
