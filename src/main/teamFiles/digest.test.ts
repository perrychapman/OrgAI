import { describe, expect, it } from 'vitest'
import { normalizeDoc, normalizeText, teamDigest } from './digest'
import { role, sampleDoc, shuffled } from './doc.fixture'

describe('normalizeText', () => {
  it('turns CRLF and CR into LF and strips one leading BOM', () => {
    expect(normalizeText('﻿a\r\nb\rc\n')).toBe('a\nb\nc\n')
    expect(normalizeText('﻿﻿x')).toBe('﻿x')
  })
})

describe('normalizeDoc', () => {
  it('sorts unordered lists, keeps responsibilities in order and drops undefined', () => {
    const doc = sampleDoc()
    doc.roles = shuffled([role('b', { tools: ['Read', 'Bash', 'Read'], responsibilities: ['z', 'a'], effort: undefined }), ...doc.roles])
    const n = normalizeDoc(doc)
    expect(n.roles.map((r) => r.slug)).toEqual(['b', 'dev', 'lead', 'reviewer'])
    expect(n.roles[0].tools).toEqual(['Bash', 'Read'])
    expect(n.roles[0].responsibilities).toEqual(['z', 'a'])
    expect('effort' in n.roles[0]).toBe(false)
  })

  it('does not mutate its input', () => {
    const doc = sampleDoc()
    const copy = structuredClone(doc)
    normalizeDoc(doc)
    expect(doc).toEqual(copy)
  })
})

describe('teamDigest', () => {
  it('is stable across order and differs on content', () => {
    const doc = sampleDoc()
    const same = { ...doc, roles: shuffled(doc.roles), mcp: shuffled(doc.mcp) }
    expect(teamDigest(same)).toBe(teamDigest(doc))
    expect(teamDigest(doc)).toMatch(/^[0-9a-f]{64}$/)
    const changed = structuredClone(doc)
    changed.roles[0].prompt += ' more'
    expect(teamDigest(changed)).not.toBe(teamDigest(doc))
  })

  it('mixes in problem files so a changed broken file changes the digest', () => {
    const doc = sampleDoc()
    const a = teamDigest(doc, [{ file: '.orgai/agents/x.md', contentDigest: '1' }])
    expect(a).not.toBe(teamDigest(doc))
    expect(teamDigest(doc, [{ file: '.orgai/agents/x.md', contentDigest: '2' }])).not.toBe(a)
    expect(teamDigest(doc, [])).toBe(teamDigest(doc))
  })
})
