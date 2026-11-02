import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TeamReview } from '@shared/types'
import { normalizeReview, readReview, removeReview, REVIEW_MAX_ROLE_IDS, reviewFile, reviewSummary, writeReview } from './reviewStore'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orgai-review-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function review(over: Partial<TeamReview> = {}): TeamReview {
  return {
    projectId: 'p1',
    checkedAt: '2026-01-01T00:00:00.000Z',
    trigger: 'manual',
    mode: 'free',
    discovery: { projectId: 'p1', items: [], sources: [], warnings: [], includeOutside: false, digest: 'd', createdAt: '2026-01-01T00:00:00.000Z' },
    digest: 'd',
    newCandidateIds: [],
    recommendations: [],
    gaps: [],
    evidence: [],
    dismissed: [],
    pendingCount: 0,
    runsSinceModel: 0,
    ...over
  }
}
const rec = { id: 'rec-1', candidateId: 'cap-1', kind: 'skill' as const, roleIds: ['r1'], reason: 'x', access: 'read' as const }

describe('reviewFile', () => {
  it('lives under team-reviews and refuses path-like ids', () => {
    expect(reviewFile(dir, 'p1')).toBe(join(dir, 'team-reviews', 'p1.json'))
    for (const bad of ['../x', 'a/b', 'a\\b', '', '..', 'a b']) expect(reviewFile(dir, bad)).toBeNull()
  })
})

describe('normalizeReview', () => {
  it('keeps a valid review and recounts pending', () => {
    const n = normalizeReview(review({ recommendations: [rec], pendingCount: 99 }), 'p1')!
    expect(n.pendingCount).toBe(1)
    expect(n.recommendations).toEqual([rec])
  })
  it('rejects wrong shapes', () => {
    expect(normalizeReview(null, 'p1')).toBeNull()
    expect(normalizeReview([], 'p1')).toBeNull()
    expect(normalizeReview('x', 'p1')).toBeNull()
    expect(normalizeReview(review({ projectId: 'other' }), 'p1')).toBeNull()
    expect(normalizeReview({ ...review(), discovery: undefined }, 'p1')).toBeNull()
    expect(normalizeReview({ ...review(), discovery: { items: 'no' } }, 'p1')).toBeNull()
    expect(normalizeReview({ ...review(), recommendations: 'no' }, 'p1')).toBeNull()
    expect(normalizeReview({ ...review(), mode: 'weird' }, 'p1')).toBeNull()
    expect(normalizeReview({ ...review(), digest: 5 }, 'p1')).toBeNull()
    expect(normalizeReview({ ...review(), dismissed: null }, 'p1')).toBeNull()
  })
  it('drops malformed recommendations and fixes runsSinceModel', () => {
    const n = normalizeReview({ ...review(), recommendations: [rec, { id: 1 }, null, { id: 'a', candidateId: 'b', roleIds: 'x' }], runsSinceModel: -3 }, 'p1')!
    expect(n.recommendations).toEqual([rec])
    expect(n.runsSinceModel).toBe(0)
    expect(normalizeReview({ ...review(), runsSinceModel: 2.7 }, 'p1')!.runsSinceModel).toBe(2)
  })
})

describe('normalizeReview field by field (review L1)', () => {
  it('rebuilds recommendations: bad kind or roles drop the entry, reason and access are coerced, extra keys go', () => {
    const n = normalizeReview(
      {
        ...review(),
        recommendations: [
          { ...rec, reason: { evil: true }, access: 'admin', extra: 'x' },
          { ...rec, id: 'rec-2', kind: 'plugin' },
          { ...rec, id: 'rec-3', roleIds: ['../x', 'a b'] },
          { ...rec, id: 'rec-4', roleIds: ['r1', 'r1', '../x', 'r2'], reason: `long ${'y'.repeat(400)}‮`, access: 'full' }
        ]
      },
      'p1'
    )!
    expect(n.recommendations).toHaveLength(2)
    expect(n.recommendations[0]).toEqual({ id: 'rec-1', candidateId: 'cap-1', kind: 'skill', roleIds: ['r1'], reason: '', access: 'read' })
    expect(n.recommendations[1]!.roleIds).toEqual(['r1', 'r2'])
    expect(n.recommendations[1]!.access).toBe('full')
    expect(n.recommendations[1]!.reason.length).toBeLessThanOrEqual(300)
    expect(n.recommendations[1]!.reason).not.toContain('‮')
  })

  it('caps role ids per recommendation', () => {
    const roleIds = Array.from({ length: REVIEW_MAX_ROLE_IDS + 20 }, (_, i) => `r${i}`)
    expect(normalizeReview(review({ recommendations: [{ ...rec, roleIds }] }), 'p1')!.recommendations[0]!.roleIds).toHaveLength(REVIEW_MAX_ROLE_IDS)
  })

  it('rebuilds dismissals: clamped name, whitelisted kind, cleaned recommendation, no other keys', () => {
    const n = normalizeReview(
      {
        ...review(),
        dismissed: [
          { candidateId: 'cap-1', fingerprint: 'f', at: 'now', name: `n${'z'.repeat(100)}`, kind: 'weird', extra: 1, recommendation: { ...rec, reason: { o: 1 }, access: 'yes' } },
          { candidateId: 'cap-2', fingerprint: 'f', at: 'now', kind: 'mcp', recommendation: { ...rec, kind: 'nope' } },
          { candidateId: 'cap-3', fingerprint: 5, at: 'now' },
          'junk'
        ]
      },
      'p1'
    )!
    expect(n.dismissed).toHaveLength(2)
    const [one, two] = n.dismissed
    expect(Object.keys(one!).sort()).toEqual(['at', 'candidateId', 'fingerprint', 'name', 'recommendation'])
    expect(one!.name!.length).toBeLessThanOrEqual(64)
    expect(one!.recommendation).toEqual({ ...rec, reason: '', access: 'read' })
    expect(two).toEqual({ candidateId: 'cap-2', fingerprint: 'f', at: 'now', kind: 'mcp' })
  })

  it('drops unknown top-level keys and bad optional fields', () => {
    const n = normalizeReview({ ...review(), extra: 'x', stub: 'yes', modelInput: 'all', modelSkipped: 'whatever', tokensUsed: -1, trigger: 'weird', newCandidateIds: ['a', 2] }, 'p1')! as unknown as Record<string, unknown>
    expect(n.extra).toBeUndefined()
    expect(n.stub).toBeUndefined()
    expect(n.modelInput).toBeUndefined()
    expect(n.modelSkipped).toBeUndefined()
    expect(n.tokensUsed).toBeUndefined()
    expect(n.trigger).toBe('manual')
    expect(n.newCandidateIds).toEqual(['a'])
    const ok = normalizeReview(review({ stub: true, modelInput: 'proactive', modelSkipped: 'pendingFull', tokensUsed: 12, trigger: 'runEnded' }), 'p1')!
    expect(ok).toMatchObject({ stub: true, modelInput: 'proactive', modelSkipped: 'pendingFull', tokensUsed: 12, trigger: 'runEnded' })
  })
})

describe('persistence', () => {
  it('round-trips and removes', () => {
    expect(readReview(dir, 'p1')).toBeNull()
    expect(writeReview(dir, review({ recommendations: [rec] }))).toBe(true)
    expect(readReview(dir, 'p1')!.recommendations).toEqual([rec])
    expect(readdirSync(join(dir, 'team-reviews'))).toEqual(['p1.json'])
    removeReview(dir, 'p1')
    expect(readReview(dir, 'p1')).toBeNull()
    expect(() => removeReview(dir, 'p1')).not.toThrow()
  })
  it('refuses to write a path-like project id', () => {
    expect(writeReview(dir, review({ projectId: '../evil' }))).toBe(false)
    expect(() => removeReview(dir, '../evil')).not.toThrow()
  })
  it('reads corrupt or foreign files as null', () => {
    mkdirSync(join(dir, 'team-reviews'))
    writeFileSync(join(dir, 'team-reviews', 'p1.json'), '{not json')
    expect(readReview(dir, 'p1')).toBeNull()
    writeFileSync(join(dir, 'team-reviews', 'p2.json'), JSON.stringify(review({ projectId: 'p1' })))
    expect(readReview(dir, 'p2')).toBeNull()
  })
  it('summarizes', () => {
    expect(reviewSummary(review({ recommendations: [rec], newCandidateIds: ['a', 'b'] }))).toMatchObject({ projectId: 'p1', pendingCount: 1, newCount: 2, evidenceCount: 0, trigger: 'manual', mode: 'free' })
  })
})

describe('normalizeReview dismissals', () => {
  it('drops malformed entries, forgets a malformed held recommendation and fills a missing name from the discovery', () => {
    const item = { id: 'cap-1', kind: 'skill', origin: 'repo', source: 'repo-skills', sourceLabel: 'x', name: 'code-review', description: '', flags: [], needsSecrets: [], notes: [] }
    const r = review({
      discovery: { projectId: 'p1', items: [item as never], sources: [], warnings: [], includeOutside: false, digest: 'd', createdAt: '2026-01-01T00:00:00.000Z' },
      dismissed: [
        { candidateId: 'cap-1', fingerprint: 'f', at: 'a' },
        { candidateId: 'cap-2', fingerprint: 'f', at: 'a', name: 'kept', kind: 'mcp', recommendation: { id: 'rec-1', candidateId: 'cap-2', roleIds: 'r1' } as never },
        { candidateId: 7, fingerprint: 'f', at: 'a' } as never
      ]
    })
    const out = normalizeReview(JSON.parse(JSON.stringify(r)), 'p1')!
    expect(out.dismissed).toEqual([
      { candidateId: 'cap-1', fingerprint: 'f', at: 'a', name: 'code-review', kind: 'skill' },
      { candidateId: 'cap-2', fingerprint: 'f', at: 'a', name: 'kept', kind: 'mcp' }
    ])
  })
})
