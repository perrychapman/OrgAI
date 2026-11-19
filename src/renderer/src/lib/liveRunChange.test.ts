import { describe, expect, it } from 'vitest'
import type { LiveRunChange } from '@shared/types'
import { effectOf, inferAction, liveChangeLines, serverReach, skillReach, type LiveChangeAction } from './liveRunChange'

const AVAIL: LiveRunChange['availability'][] = ['now', 'after-idle', 'pending', 'next-run']

describe('effectOf', () => {
  const table: [LiveChangeAction, string[]][] = [
    [{ kind: 'grant', name: 'api-design' }, ['Can use api-design now', 'Can use api-design once its agents are idle', 'Applying access to api-design', 'Can use api-design from the next run']],
    [{ kind: 'revoke', name: 'Context7' }, ['No longer uses Context7', 'Stops using Context7 once its agents are idle', 'Removing Context7', 'Stops using Context7 from the next run']],
    [
      { kind: 'saved-ungranted', name: 'api-design' },
      [
        'Has api-design; no role can load it yet',
        'Gets api-design once its agents are idle; no role can load it yet',
        'Applying api-design; no role can load it yet',
        'Gets api-design from the next run; no role can load it yet'
      ]
    ],
    [
      { kind: 'updated', name: 'api-design' },
      ['Updated api-design is in use now', 'Updated api-design is in use once its agents are idle', 'Updated api-design is being applied', 'Updated api-design is in use from the next run']
    ],
    [{ kind: 'changed' }, ['Change is in use now', 'Change is in use once its agents are idle', 'Change is being applied', 'Change is in use from the next run']]
  ]
  for (const [action, expected] of table) {
    it(`words every availability for ${action.kind}`, () => {
      expect(AVAIL.map((a) => effectOf(action, a))).toEqual(expected)
    })
  }

  it('never says a revoke is in use or an ungranted save is usable', () => {
    for (const a of AVAIL) {
      expect(effectOf({ kind: 'revoke', name: 'X' }, a)).not.toMatch(/in use|Can use/)
      expect(effectOf({ kind: 'saved-ungranted', name: 'X' }, a)).toMatch(/no role can load it yet/)
      expect(effectOf({ kind: 'saved-ungranted', name: 'X' }, a)).not.toMatch(/Can use|in use now/)
    }
  })
})

describe('inferAction', () => {
  const a = (reach: number) => ({ id: 'a', name: 'api-design', reach })
  it('reads a new item with and without roles', () => {
    expect(inferAction([], [a(1)])).toEqual({ kind: 'grant', name: 'api-design' })
    expect(inferAction([], [a(0)])).toEqual({ kind: 'saved-ungranted', name: 'api-design' })
  })
  it('reads a grant and a revoke', () => {
    expect(inferAction([a(0)], [a(1)])).toEqual({ kind: 'grant', name: 'api-design' })
    expect(inferAction([a(2)], [a(1)])).toEqual({ kind: 'revoke', name: 'api-design' })
    expect(inferAction([a(1)], [])).toEqual({ kind: 'revoke', name: 'api-design' })
  })
  it('falls back to the general action', () => {
    expect(inferAction(null, [a(1)])).toEqual({ kind: 'changed' })
    expect(inferAction([a(1)], [a(1)])).toEqual({ kind: 'changed' })
    expect(inferAction([a(0)], [])).toEqual({ kind: 'changed' })
    expect(inferAction([], [a(1), { id: 'b', name: 'b', reach: 1 }])).toEqual({ kind: 'changed' })
  })
  it('counts every-role servers and switched-off items', () => {
    expect(serverReach({ id: 'x', name: 'x', enabled: true }).reach).toBe(Infinity)
    expect(serverReach({ id: 'x', name: 'x', enabled: false, roles: ['a'] }).reach).toBe(0)
    expect(skillReach({ spec: { id: 's', name: 's', enabled: true }, grantedTo: ['r'] }).reach).toBe(1)
    expect(skillReach({ spec: { id: 's', name: 's', enabled: false }, grantedTo: ['r'] }).reach).toBe(0)
  })
})

describe('liveChangeLines', () => {
  it('is empty without runs', () => {
    expect(liveChangeLines(undefined)).toEqual([])
    expect(liveChangeLines([])).toEqual([])
  })

  it('puts the run title last, in quotes, after the effect', () => {
    const lines = liveChangeLines(
      [
        { runId: 'a', title: 'Fix login', availability: 'now' },
        { runId: 'b', title: 'Write docs', availability: 'after-idle' },
        { runId: 'c', title: 'Audit', availability: 'next-run', reason: 'A report is mid-edit.' },
        { runId: 'd', title: 'Ship', availability: 'pending' }
      ],
      { kind: 'grant', name: 'api-design' }
    )
    expect(lines.map((l) => l.text)).toEqual([
      'Can use api-design now · run “Fix login”',
      'Can use api-design once its agents are idle · run “Write docs”',
      'Can use api-design from the next run · run “Audit”',
      'Applying access to api-design · run “Ship”'
    ])
    expect(lines[2].full).toBe('Can use api-design from the next run · run “Audit”. A report is mid-edit.')
  })

  it('truncates long titles inside the quotes but keeps the full one', () => {
    const title = 'x'.repeat(200)
    const [l] = liveChangeLines([{ runId: 'a', title, availability: 'now' }], { kind: 'revoke', name: 'Context7' })
    expect(l.title).toBe(title)
    expect(l.text.startsWith('No longer uses Context7 · run “')).toBe(true)
    expect(l.text.endsWith('…”')).toBe(true)
    expect(l.full).toContain(title)
  })

  it('handles an empty title and a missing reason', () => {
    const [l] = liveChangeLines([{ runId: 'a', title: '  ', availability: 'next-run' }])
    expect(l.text).toBe('Change is in use from the next run · run “Untitled run”')
    expect(l.full).toBe(l.text)
  })
})
