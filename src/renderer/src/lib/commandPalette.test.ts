import { describe, expect, it } from 'vitest'
import { buildPaletteItems, flatten, PER_GROUP_IDLE, rankItems, resultsPhrase, scoreItem, sectionsFor, stepIndex, wordScore, type PaletteInput } from './commandPalette'

const input = (over: Partial<PaletteInput> = {}): PaletteInput => ({
  projects: [
    { id: 'p1', name: 'Notes API', kind: 'code' },
    { id: 'p2', name: 'Acme onboarding', kind: 'engagement', client: 'Acme Corp' }
  ],
  runs: [{ runId: 'r1', projectId: 'p1', label: 'R2: Add response caching', needsYou: true }],
  projectNames: new Map([['p1', 'Notes API']]),
  current: { name: 'Notes API', tabs: [{ view: 'run', label: 'Live' }, { view: 'history', label: 'History' }, { view: 'team', label: 'Team' }], activeView: 'run' },
  helpers: [
    { id: 'quick', label: 'Chat' },
    { id: 'harness', label: 'MCP assistant' }
  ],
  waiting: 3,
  ...over
})

describe('buildPaletteItems', () => {
  it('lists projects, open runs, destinations, tabs of the open project and the two create actions', () => {
    const items = buildPaletteItems(input())
    const ids = items.map((i) => i.id)
    expect(ids).toContain('project:p1')
    expect(ids).toContain('run:r1')
    expect(ids).toContain('view:inbox')
    expect(ids).toContain('view:appSettings')
    expect(ids).toContain('assistant:quick')
    expect(ids).toContain('new:project')
    expect(ids).toContain('new:chat')
    // The tab already shown is not offered.
    expect(ids).toContain('tab:history')
    expect(ids).not.toContain('tab:run')
  })

  it('offers no tabs on an app-level screen', () => {
    expect(buildPaletteItems(input({ current: null })).some((i) => i.group === 'This project')).toBe(false)
  })

  it('says what a project is and marks a run that needs the user', () => {
    const items = buildPaletteItems(input())
    expect(items.find((i) => i.id === 'project:p2')?.hint).toBe('Engagement · Acme Corp')
    expect(items.find((i) => i.id === 'project:p1')?.hint).toBe('Code project')
    expect(items.find((i) => i.id === 'run:r1')).toMatchObject({ attention: true, hint: 'Notes API' })
    expect(items.find((i) => i.id === 'view:inbox')?.hint).toBe('3 waiting on you')
  })
})

describe('wordScore', () => {
  it('ranks exact over prefix over word start over inside', () => {
    expect(wordScore('chat', 'Chat')).toBe(100)
    expect(wordScore('ch', 'Chat')).toBe(90)
    expect(wordScore('api', 'Notes API')).toBe(75)
    expect(wordScore('ote', 'Notes API')).toBe(55)
  })
  it('finds letters in order only when they sit close and the word has three letters', () => {
    expect(wordScore('cch', 'caching')).toBeGreaterThan(0)
    expect(wordScore('cx', 'caching')).toBe(0)
    expect(wordScore('ng', 'caching')).toBeGreaterThan(0) // inside, not fuzzy
    expect(wordScore('ahg', 'Add response caching')).toBe(0)
  })
  it('never matches empty text', () => {
    expect(wordScore('a', '')).toBe(0)
  })
})

describe('scoreItem and rankItems', () => {
  const items = buildPaletteItems(input())
  it('needs every word to match', () => {
    expect(scoreItem('notes api', { label: 'Notes API' })).toBeGreaterThan(0)
    expect(scoreItem('notes zzz', { label: 'Notes API' })).toBe(0)
  })
  it('matches the hint and keywords at a lower weight', () => {
    const byLabel = scoreItem('settings', { label: 'App settings' })
    const byKeyword = scoreItem('theme', { label: 'App settings', keywords: ['theme'] })
    expect(byKeyword).toBeGreaterThan(0)
    expect(byKeyword).toBeLessThan(byLabel)
    expect(rankItems(items, 'acme corp').map((i) => i.id)).toEqual(['project:p2'])
  })
  it('puts the best match first and keeps default order on ties', () => {
    const r = rankItems(items, 'ca').map((i) => i.id)
    expect(r[0]).toBe('run:r1') // "R2: Add response caching" has "ca" at a word start... also "Chat" does not start with ca
    expect(rankItems(items, 'chat')[0].id).toBe('assistant:quick')
  })
  it('keeps the whole list for an empty or blank query and respects the limit when typing', () => {
    expect(rankItems(items, '  ')).toHaveLength(items.length)
    expect(rankItems(items, 'e', 2).length).toBeLessThanOrEqual(2)
  })
  it('returns nothing for a query that matches nothing', () => {
    expect(rankItems(items, 'qqqqzzzz')).toEqual([])
    expect(sectionsFor(items, 'qqqqzzzz')).toEqual([])
  })
})

describe('sectionsFor', () => {
  it('groups in heading order when nothing is typed and drops empty groups', () => {
    const s = sectionsFor(buildPaletteItems(input({ runs: [] })), '')
    expect(s.map((x) => x.group)).toEqual(['This project', 'Go to', 'Projects', 'Create'])
  })
  it('caps each idle group but a typed query reaches the rest', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ id: `x${i}`, name: `Alpha ${i}`, kind: 'code' as const }))
    const items = buildPaletteItems(input({ projects: many }))
    expect(sectionsFor(items, '').find((s) => s.group === 'Projects')?.items).toHaveLength(PER_GROUP_IDLE)
    expect(flatten(sectionsFor(items, 'alpha')).length).toBe(20)
  })
  it('is one flat list without a heading when something is typed', () => {
    const s = sectionsFor(buildPaletteItems(input()), 'notes')
    expect(s).toHaveLength(1)
    expect(s[0].group).toBeNull()
  })
})

describe('stepIndex and resultsPhrase', () => {
  it('wraps around and handles an empty list', () => {
    expect(stepIndex(0, -1, 3)).toBe(2)
    expect(stepIndex(2, 1, 3)).toBe(0)
    expect(stepIndex(-1, 1, 3)).toBe(0)
    expect(stepIndex(-1, -1, 3)).toBe(2)
    expect(stepIndex(0, 1, 0)).toBe(-1)
  })
  it('speaks counts', () => {
    expect(resultsPhrase(0)).toBe('No results')
    expect(resultsPhrase(1)).toBe('1 result')
    expect(resultsPhrase(5)).toBe('5 results')
  })
})
