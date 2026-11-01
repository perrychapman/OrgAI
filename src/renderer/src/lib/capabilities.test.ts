import { describe, expect, it } from 'vitest'
import { SAFE_ID } from '@shared/defaults'
import { accessChoiceOffered, accessSentence, clampText, flagViews, foldProgress, fullAllowed, newRequestId, pinLabel, sourceBadge, stripControl, suggestionsLine, sinceLine, skillsFirst, resultsHeadText, gapsJumpText, readDismissed } from './capabilities'

describe('capabilities helpers', () => {
  it('makes safe request ids', () => {
    expect(SAFE_ID.test(newRequestId())).toBe(true)
    expect(newRequestId()).not.toBe(newRequestId())
  })
  it('clamps untrusted text', () => {
    expect(clampText('a\u0000b\n\n c')).toBe('a b c')
    expect(clampText('x'.repeat(50), 10).length).toBe(10)
  })
  it('lists flags with the needed secrets', () => {
    const v = flagViews({ flags: ['runsCode', 'canChange'], needsSecrets: ['GITHUB_TOKEN'] })
    expect(v.map((f) => f.label)).toEqual(['Runs code on this machine', 'Can change data', 'Needs: GITHUB_TOKEN'])
  })
  it('words sources and pins', () => {
    expect(sourceBadge({ origin: 'repo', sourceLabel: 'x' })).toBe('Found in this repo')
    expect(sourceBadge({ origin: 'local', sourceLabel: 'Claude Code' })).toBe('On this computer: Claude Code')
    expect(pinLabel({ version: '1.0.0' })).toBe('Pinned: 1.0.0')
    expect(pinLabel({ digest: 'abcdefabcdefabcdef' })).toBe('Digest: abcdefabcdef')
    expect(pinLabel({})).toBeNull()
  })
  it('gates full access on write tools', () => {
    expect(fullAllowed([{ tools: ['Read'] }])).toBe(false)
    expect(fullAllowed([{ tools: ['Read', 'Bash'] }])).toBe(true)
    expect(fullAllowed([])).toBe(false)
    expect(accessChoiceOffered({ kind: 'skill', flags: [] })).toBe(false)
    expect(accessChoiceOffered({ kind: 'connector', flags: [], readOnlyAvailable: true })).toBe(true)
    expect(accessChoiceOffered({ kind: 'mcp', flags: ['canChange'] })).toBe(false)
  })
  it('writes the access sentence', () => {
    expect(accessSentence(['Reviewer'], 'GitHub', 'read', 'connector')).toBe('Reviewer can read through GitHub.')
    expect(accessSentence([], 'GitHub', 'read', 'mcp')).toMatch(/Nobody/)
    expect(accessSentence(['A', 'B', 'C'], 'x', 'full', 'mcp')).toBe('3 roles can use x.')
    expect(accessSentence(['A'], 'x', 'read', 'mcp')).toBe('A can use x.')
    expect(accessSentence(['A'], 'x', 'full', 'connector')).toBe('A can read and change things through x.')
  })
  it('keeps a long command whole', () => {
    const long = 'npx -y pkg@1.0.0 ' + 'x'.repeat(380) + ' --tail'
    expect(stripControl(long)).toBe(long)
    expect(stripControl('a\u0000b')).toBe('a b')
  })
  it('folds progress by label', () => {
    let rows = foldProgress([], { projectId: 'p', requestId: 'r', phase: 'registry', state: 'running' })
    rows = foldProgress(rows, { projectId: 'p', requestId: 'r', phase: 'registry', state: 'rateLimited', message: 'busy' })
    expect(rows).toHaveLength(1)
    expect(rows[0].state).toBe('rateLimited')
  })
  it('summarises suggestions', () => {
    expect(suggestionsLine(undefined)).toBeNull()
    expect(suggestionsLine({ pendingCount: 3, newCount: 3 })).toBe('3 suggestions since your last run')
    expect(suggestionsLine({ pendingCount: 1, newCount: 0 })).toBe('1 suggestion waiting')
  })
  it('words the since line and gaps jump', () => {
    expect(sinceLine(1)).toBe('1 suggestion since your last run')
    expect(sinceLine(12)).toBe('12 suggestions since your last run')
    expect(sinceLine(0)).toBeNull()
    expect(gapsJumpText(1)).toBe('and 1 gap')
    expect(gapsJumpText(2)).toBe('and 2 gaps')
  })
  it('orders skills first, stably', () => {
    const items = { a: { kind: 'connector' as const }, b: { kind: 'skill' as const }, c: { kind: 'connector' as const }, d: { kind: 'skill' as const } }
    expect(skillsFirst([{ candidateId: 'a' }, { candidateId: 'b' }, { candidateId: 'c' }, { candidateId: 'd' }], items).map((r) => r.candidateId)).toEqual(['b', 'd', 'a', 'c'])
  })
  it('words the results head', () => {
    expect(resultsHeadText(2, 'the whole team', 2, false)).toBe('2 to review')
    expect(resultsHeadText(3, 'Reviewer', 14, true)).toBe('3 to review for Reviewer · 11 waiting for the whole team')
  })
  it('validates the dismissed list', () => {
    const review = { dismissed: [{ candidateId: 'x', name: 'Alpha', kind: 'skill', dismissedAt: 't' }, { candidateId: 'y', at: 'u' }, { nope: 1 }, null], discovery: { items: [{ id: 'y', name: 'Beta', kind: 'connector' as const }] } }
    expect(readDismissed(review)).toEqual([
      { candidateId: 'x', name: 'Alpha', kind: 'skill', dismissedAt: 't' },
      { candidateId: 'y', name: 'Beta', kind: 'connector', dismissedAt: 'u' }
    ])
    expect(readDismissed({ dismissed: 'bad' })).toEqual([])
    expect(readDismissed(null)).toEqual([])
  })
  it('names the curated vendor', () => {
    expect(sourceBadge({ origin: 'catalog', sourceLabel: 'x', name: 'Whatever' })).toBe('Curated · Whatever')
  })
})
