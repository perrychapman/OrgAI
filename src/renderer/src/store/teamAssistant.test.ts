import { describe, expect, it } from 'vitest'
import { summaryFromReview, useTeamAssistantStore } from './teamAssistant'
import type { TeamReview, TeamReviewSummary } from '@shared/types'

const sum = (p: string, n: number, nw: number): TeamReviewSummary => ({ projectId: p, checkedAt: 'x', trigger: 'manual', mode: 'free', pendingCount: n, newCount: nw, evidenceCount: 0 })

describe('teamAssistant store', () => {
  it('sets and clears new', () => {
    const st = useTeamAssistantStore.getState()
    st.setSummary('a', sum('a', 3, 2))
    st.clearNew('a')
    expect(useTeamAssistantStore.getState().summaries.a).toMatchObject({ pendingCount: 3, newCount: 0 })
  })
  it('maps a review', () => {
    const r = { projectId: 'a', checkedAt: 'c', trigger: 'opened', mode: 'model', pendingCount: 2, newCandidateIds: ['1'], evidence: [1, 2] } as unknown as TeamReview
    expect(summaryFromReview(r)).toMatchObject({ pendingCount: 2, newCount: 1, evidenceCount: 2, mode: 'model' })
  })
})
