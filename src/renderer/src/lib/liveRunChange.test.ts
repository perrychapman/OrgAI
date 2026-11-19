import { describe, expect, it } from 'vitest'
import { liveChangeLines } from './liveRunChange'

describe('liveChangeLines', () => {
  it('is empty without runs', () => {
    expect(liveChangeLines(undefined)).toEqual([])
    expect(liveChangeLines([])).toEqual([])
  })

  it('maps every availability', () => {
    const lines = liveChangeLines([
      { runId: 'a', title: 'Fix login', availability: 'now' },
      { runId: 'b', title: 'Write docs', availability: 'after-idle' },
      { runId: 'c', title: 'Audit', availability: 'next-run', reason: 'A report is mid-edit.' },
      { runId: 'd', title: 'Ship', availability: 'pending' }
    ])
    expect(lines.map((l) => l.text)).toEqual([
      'Fix login: in use now',
      'Write docs: once the agents are idle',
      'Audit: from the next run: A report is mid-edit',
      'Ship: being applied'
    ])
  })

  it('truncates long titles but keeps the full one', () => {
    const title = 'x'.repeat(200)
    const [l] = liveChangeLines([{ runId: 'a', title, availability: 'now' }])
    expect(l.title).toBe(title)
    expect(l.text.length).toBeLessThan(80)
    expect(l.text).toContain('…')
  })

  it('handles an empty title and a missing reason', () => {
    const lines = liveChangeLines([
      { runId: 'a', title: '  ', availability: 'next-run' }
    ])
    expect(lines[0].text).toBe('Untitled run: from the next run')
  })
})
