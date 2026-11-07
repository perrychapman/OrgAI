import { create } from 'zustand'
import type { TeamReview, TeamReviewSummary } from '@shared/types'
import type { AssistantResult } from '../lib/capabilities'
import type { AppliedInfo } from '../components/team/CapabilityCard'

export interface CardState {
  busy?: boolean
  error?: string | null
  applied?: AppliedInfo
}

/** What the Recommend pane shows for one project. Lives here so it survives a tab switch (the pane unmounts). */
export interface TeamSession {
  result: AssistantResult | null
  cards: Record<string, CardState>
  /** Dismissed recommendation ids and candidate ids (a new recommend result is filtered by both). */
  dismissed: string[]
  dismissedCandidates: string[]
  gapsHidden: string[]
}

export const EMPTY_SESSION: TeamSession = { result: null, cards: {}, dismissed: [], dismissedCandidates: [], gapsHidden: [] }

interface TeamAssistantState {
  summaries: Record<string, TeamReviewSummary>
  setSummary: (projectId: string, s: TeamReviewSummary) => void
  /** The user has seen the new items: zero newCount, keep the pending count. */
  clearNew: (projectId: string) => void
  sessions: Record<string, TeamSession>
  updateSession: (projectId: string, patch: (s: TeamSession) => Partial<TeamSession>) => void
}

export const useTeamAssistantStore = create<TeamAssistantState>((set) => ({
  summaries: {},
  setSummary: (projectId, s) => set((st) => ({ summaries: { ...st.summaries, [projectId]: s } })),
  clearNew: (projectId) =>
    set((st) => {
      const cur = st.summaries[projectId]
      if (!cur || cur.newCount === 0) return st
      return { summaries: { ...st.summaries, [projectId]: { ...cur, newCount: 0 } } }
    }),
  sessions: {},
  updateSession: (projectId, patch) =>
    set((st) => {
      const cur = st.sessions[projectId] ?? EMPTY_SESSION
      return { sessions: { ...st.sessions, [projectId]: { ...cur, ...patch(cur) } } }
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
