import { describe, expect, it } from 'vitest'
import { commandSummary, compactToolRows } from './streamRows'
import type { TranscriptRow } from './types'

const row = (key: string, kind: TranscriptRow['kind'], toolUseId?: string, over: Partial<TranscriptRow> = {}): TranscriptRow => ({
  key, kind, toolUseId, runId: 'run', agentId: 'lead', agentLabel: 'Lead', text: key, ...over
})

describe('compact conversation tools', () => {
  it('folds completed parallel calls while preserving a still-running call', () => {
    const rows = [row('a', 'tool', 'a'), row('b', 'tool', 'b'), row('b-out', 'result', 'b'), row('a-out', 'result', 'a'), row('pending', 'tool', 'c')]
    expect(compactToolRows(rows).map(r => r.text)).toEqual(['2 tool calls completed', 'pending'])
    expect(compactToolRows(rows, true)).toEqual(rows)
  })

  it('never hides errors, unmatched output, duplicate IDs or another agent\'s result', () => {
    for (const rows of [
      [row('a', 'tool', 'a'), row('fail', 'error', 'a')],
      [row('a', 'tool', 'a'), row('out', 'result', 'other')],
      [row('a', 'tool', 'a'), row('out', 'result', 'a', { agentId: 'other' })],
      [row('a', 'tool', 'a'), row('duplicate', 'tool', 'a'), row('out', 'result', 'a')]
    ]) expect(compactToolRows(rows)).toEqual(rows)
  })

  it('does not label an unmatched or interrupted command as completed', () => {
    const call = row('call', 'tool', 'a', { summary: 'Ran npm test', pendingSummary: 'Command: npm test' })
    expect(compactToolRows([call])[0].text).toBe('Command: npm test')
    expect(compactToolRows([call, row('failed', 'error', 'a')])[0].text).toBe('Command: npm test')
    expect(compactToolRows([call, row('ok', 'result', 'a')])[0].text).toBe('Ran npm test')
  })

  it('restores command and result details when expanded', () => {
    const rows = [row('call', 'tool', 'a', { summary: 'Ran pwd', detail: 'Ran /bin/zsh -lc pwd' }), row('out', 'result', 'a', { detail: '/work/project' })]
    expect(compactToolRows(rows).map(r => r.text)).toEqual(['Ran pwd'])
    expect(compactToolRows(rows, true).map(r => r.text)).toEqual(['Ran /bin/zsh -lc pwd', '/work/project'])
  })

  it('unwraps only recognizable shell launchers for display', () => {
    expect(commandSummary('/bin/zsh -lc pwd')).toBe('pwd')
    expect(commandSummary('/bin/bash -lc "npm test && npm run lint"')).toBe('npm test && npm run lint')
    expect(commandSummary('/bin/bash -lc "a" && "b"')).toBe('"a" && "b"')
    expect(commandSummary('custom --command "keep this"')).toBe('custom --command "keep this"')
  })
})
