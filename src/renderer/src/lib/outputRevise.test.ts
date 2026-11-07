import { describe, expect, it } from 'vitest'
import {
  answeredSentence,
  canRevise,
  consequenceLine,
  defaultTarget,
  diagramFixInstruction,
  endedSentence,
  formatWarningApplies,
  pendingSentence,
  placeholderFor,
  targetOfValue,
  targetOptions,
  validateInstruction
} from './outputRevise'

describe('canRevise', () => {
  it('refuses unreadable kinds and missing files', () => {
    expect(canRevise({ kind: 'docx' }).ok).toBe(true)
    for (const kind of ['image', 'pdf', 'other'] as const) {
      expect(canRevise({ kind })).toEqual({ ok: false, reason: 'OrgAI cannot read this kind of file as text.' })
    }
    expect(canRevise({ kind: 'markdown', missing: true }).ok).toBe(false)
  })
})

describe('targets', () => {
  const opts = {
    runs: [
      { runId: 'r2', label: 'R2', state: 'live' as const, madeCurrent: true },
      { runId: 'r3', label: 'R3', state: 'held' as const, madeCurrent: false },
      { runId: 'r1', label: 'R1', state: 'continuable' as const, madeCurrent: false },
      { runId: 'r4', label: 'R4', state: 'live' as const, madeCurrent: false }
    ],
    newRunAllowed: true
  }
  it('labels in main order and ends with a new run', () => {
    expect(targetOptions(opts).map((o) => o.label)).toEqual([
      'R2 (still running)',
      'R3, waiting for you to answer a question first',
      'R1, continue the conversation',
      'R4 (running)',
      'A new run'
    ])
  })
  it('defaults to the first run that is not held', () => {
    expect(defaultTarget(targetOptions(opts))).toBe('run:r2')
    expect(defaultTarget(targetOptions({ runs: [{ runId: 'r3', label: 'R3', state: 'held', madeCurrent: true }], newRunAllowed: true }))).toBe('new')
    expect(defaultTarget([])).toBe('')
  })
  it('round trips values', () => {
    expect(targetOfValue('run:r2')).toEqual({ type: 'run', runId: 'r2' })
    expect(targetOfValue('new')).toEqual({ type: 'new' })
  })
})

describe('wording', () => {
  it('states the consequence', () => {
    expect(consequenceLine(3)).toBe('The result will be version 4. Version 3 stays.')
  })
  it('warns only for office kinds changed outside', () => {
    expect(formatWarningApplies('docx', [{ source: 'agent' }, { source: 'external' }])).toBe(true)
    expect(formatWarningApplies('markdown', [{ source: 'external' }])).toBe(false)
    expect(formatWarningApplies('pptx', null)).toBe(false)
  })
  it('has per-kind placeholders', () => {
    expect(placeholderFor('mermaid', 'whole')).toContain('box')
    expect(placeholderFor('docx', 'notes')).toContain('optional')
  })
  it('words pending, answered and ended', () => {
    expect(pendingSentence('R2', new Date(2026, 10, 7, 11, 4).getTime())).toBe("Waiting for the team's new version. Sent to R2 at 11:04.")
    expect(answeredSentence('Analyst', 4)).toBe('Analyst made version 4.')
    expect(endedSentence('R2')).toBe('R2 ended without a new version.')
  })
  it('names the line in the diagram prompt', () => {
    expect(diagramFixInstruction('Parse error on line 3:\nfoo', 3)).toContain('line 3')
  })
})

describe('validateInstruction', () => {
  it('needs text for whole and selection, not for notes', () => {
    expect(validateInstruction('whole', '  ')).toBe('Say what should change.')
    expect(validateInstruction('notes', '', 2)).toBeNull()
    expect(validateInstruction('selection', 'Shorter')).toBeNull()
  })
  it('refuses hidden characters and over-long text', () => {
    expect(validateInstruction('whole', 'a‮b')).toMatch(/hidden/)
    expect(validateInstruction('whole', 'a\u0000b')).toMatch(/hidden/)
    expect(validateInstruction('whole', 'line\nbreak\tok')).toBeNull()
    expect(validateInstruction('whole', 'x'.repeat(4001))).toMatch(/4,000/)
  })
})
