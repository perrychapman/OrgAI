import { describe, expect, it } from 'vitest'
import type { Project, RunSummary } from '@shared/types'
import { activityText, engagementFacts, engagementOpenLabel, engagementTiles, visibleEngagements } from './engagementTiles'

const DAY = 24 * 3600_000
const NOW = 30 * DAY
const proj = (id: string, extra: Partial<Project> = {}): Project => ({ id, name: id, path: `/p/${id}`, kind: 'engagement', ...extra }) as Project
const run = (projectId: string, startedAt: number, endedAt?: number): RunSummary => ({ id: `${projectId}${startedAt}`, projectId, startedAt, endedAt }) as RunSummary

describe('engagementTiles', () => {
  it('keeps engagements only and orders by newest activity, no runs last', () => {
    const projects = [proj('a'), proj('b'), proj('c'), { ...proj('code'), kind: 'code' } as Project]
    const tiles = engagementTiles(projects, [run('a', NOW - 5000), run('b', NOW - 9000, NOW - 1000)], NOW)
    expect(tiles.map((t) => t.project.id)).toEqual(['b', 'a', 'c'])
    expect(tiles[2].activity).toBe('No runs yet')
  })
  it('formats activity', () => {
    expect(activityText(NOW - 2 * DAY, NOW)).toBe('2d ago')
    expect(activityText(NOW - 30_000, NOW)).toBe('just now')
    expect(activityText(0, NOW)).toBe('No runs yet')
  })
  it('builds facts, capped at three, hiding zero lazy counts', () => {
    const p = proj('a', { referenceDirectories: ['/x', '/y'] })
    const f = engagementFacts(p, [run('a', NOW - 1000), run('a', NOW - 20 * DAY)], NOW, { notes: 4, knowledge: 9 })
    expect(f.map((x) => x.kind)).toEqual(['runs', 'folders', 'notes'])
    expect(f[0].label).toBe('1 run this week')
    expect(f[1].label).toBe('2 reference folders')
    expect(engagementFacts(proj('b'), [], NOW, { notes: 0 }).map((x) => x.kind)).toEqual(['runs'])
  })
  it('caps visible tiles and counts hidden', () => {
    const t = [1, 2, 3, 4, 5, 6]
    expect(visibleEngagements(t, false)).toEqual({ shown: [1, 2, 3, 4], hidden: 2 })
    expect(visibleEngagements(t, true).shown).toHaveLength(6)
  })
  it('names the open button', () => {
    expect(engagementOpenLabel('Tax', 'Acme')).toBe('Open Tax, engagement, Acme')
    expect(engagementOpenLabel('Tax', '')).toBe('Open Tax, engagement')
  })
})
