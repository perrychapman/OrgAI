import { describe, expect, it } from 'vitest'
import type { RunSummary } from '@shared/types'
import {
  ORG_CHANGE_PREFIX,
  ORG_REVIEW_PROMPT,
  ORG_REVIEW_PROMPT_ENGAGEMENT,
  displayRunName,
  isOrgChangeRun,
  liveOrgChangeRun,
  orgChangeBannerTitle,
  orgChangePrompt,
  setupBannerShows,
  orgChangeTitle,
  runKindWord
} from './orgChange'

const setup = (prompt: string): { kind: 'setup'; prompt: string } => ({ kind: 'setup', prompt })

describe('orgChangePrompt', () => {
  it('prefixes the change and falls back to the full review per kind', () => {
    expect(orgChangePrompt('  Add a  database specialist. ')).toBe(`${ORG_CHANGE_PREFIX}Add a database specialist.`)
    expect(orgChangePrompt('')).toBe(ORG_REVIEW_PROMPT)
    expect(orgChangePrompt('   ', 'engagement')).toBe(ORG_REVIEW_PROMPT_ENGAGEMENT)
  })
})

describe('isOrgChangeRun', () => {
  it('is true only for setup runs started as a change or review', () => {
    expect(isOrgChangeRun(setup(orgChangePrompt('x')))).toBe(true)
    expect(isOrgChangeRun(setup(ORG_REVIEW_PROMPT))).toBe(true)
    expect(isOrgChangeRun(setup('Review .orgai/ARCHITECTURE.md against the current code and propose ...'))).toBe(true)
    expect(isOrgChangeRun({ kind: 'work', prompt: orgChangePrompt('x') })).toBe(false)
    expect(isOrgChangeRun(setup('Retrospective on the run "Do it": review how the org chart performed.'))).toBe(false)
    expect(isOrgChangeRun(setup('Set up this project with me.'))).toBe(false)
    expect(isOrgChangeRun(null)).toBe(false)
    expect(isOrgChangeRun({ kind: 'setup' })).toBe(false)
  })
})

describe('orgChangeTitle', () => {
  it('names the change', () => {
    expect(orgChangeTitle(setup(orgChangePrompt('Add a database specialist under the orchestrator.')))).toBe('Org chart: add a database specialist under the…')
    expect(orgChangeTitle(setup(orgChangePrompt('Add a DB expert.')))).toBe('Org chart: add a DB expert')
    expect(orgChangeTitle(setup(orgChangePrompt('QA lead please')))).toBe('Org chart: QA lead please')
  })
  it('names a review', () => {
    expect(orgChangeTitle(setup(ORG_REVIEW_PROMPT))).toBe('Org chart review')
    expect(orgChangeTitle(setup(ORG_REVIEW_PROMPT_ENGAGEMENT))).toBe('Org chart review')
  })
  it('cuts a long word run without a space', () => {
    const t = orgChangeTitle(setup(orgChangePrompt('x'.repeat(80)))) ?? ''
    expect(t.endsWith('…')).toBe(true)
    expect(t.length).toBeLessThanOrEqual('Org chart: '.length + 40)
  })
  it('is null for other runs', () => {
    expect(orgChangeTitle(setup('Set up this project with me.'))).toBeNull()
  })
})

describe('displayRunName and runKindWord', () => {
  it('prefers the org change title', () => {
    expect(displayRunName({ ...setup(orgChangePrompt('Add a tester')), title: 'ignored' })).toBe('Org chart: add a tester')
    expect(displayRunName({ kind: 'work', prompt: 'Fix the build', title: 'Fix build' })).toBe('Fix build')
    expect(runKindWord(setup(ORG_REVIEW_PROMPT))).toBe('Org change')
    expect(runKindWord(setup('Set up this project with me.'))).toBe('Setup')
    expect(runKindWord({ kind: 'work', prompt: 'x' })).toBe('Run')
  })
})

describe('setupBannerShows', () => {
  const base = { setupComplete: true, cut: false, approved: [] as ('orgChart' | 'settings')[] }
  const first = { kind: 'setup' as const, prompt: 'Set up this project with me.', status: 'finished' as const }
  const change = { ...first, prompt: orgChangePrompt('Add a tester') }
  it('shows for a first setup that ended on its own', () => {
    expect(setupBannerShows({ ...base, summary: first })).toBe(true)
    expect(setupBannerShows({ ...base, summary: { ...first, status: 'idle' } })).toBe(true)
  })
  it('never shows for a run cut off by a quit (walk M2)', () => {
    expect(setupBannerShows({ ...base, summary: { ...first, endedBy: 'app', endedWithApp: true } })).toBe(false)
    expect(setupBannerShows({ ...base, summary: first, cut: true })).toBe(false)
    expect(setupBannerShows({ ...base, summary: { ...first, status: 'running' } })).toBe(false)
    expect(setupBannerShows({ ...base, setupComplete: false, summary: first })).toBe(false)
  })
  it('needs an approval for an org change', () => {
    expect(setupBannerShows({ ...base, summary: change })).toBe(false)
    expect(setupBannerShows({ ...base, summary: change, approved: ['orgChart'] })).toBe(true)
    expect(orgChangeBannerTitle(['orgChart', 'settings'])).toBe('Org change applied: org chart, run settings')
    expect(orgChangeBannerTitle(['architecture'], 'engagement')).toBe('Org change applied: engagement plan')
  })
})

describe('liveOrgChangeRun', () => {
  const run = (id: string, startedAt: number, prompt = orgChangePrompt('x'), projectId = 'p'): { summary: RunSummary } => ({
    summary: { id, projectId, kind: 'setup', prompt, startedAt, status: 'running' } as RunSummary
  })
  it('picks a waiting session first, then the newest', () => {
    const a = run('a', 1)
    const b = run('b', 2)
    const other = run('c', 3, 'Set up this project with me.')
    const elsewhere = run('d', 4, orgChangePrompt('x'), 'q')
    expect(liveOrgChangeRun([a, b, other, elsewhere], 'p', () => true, () => false)?.summary.id).toBe('b')
    expect(liveOrgChangeRun([a, b], 'p', () => true, (r) => r.summary.id === 'a')?.summary.id).toBe('a')
    expect(liveOrgChangeRun([a, b], 'p', () => false, () => false)).toBeNull()
  })
})
