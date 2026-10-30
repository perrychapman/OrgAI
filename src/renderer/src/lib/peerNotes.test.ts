import { describe, expect, it } from 'vitest'
import { parsePeerNote } from './peerNotes'

describe('parsePeerNote', () => {
  it('reads a sent note', () => {
    expect(parsePeerNote('Sent to run run_b (Beta Web: Fix header): please rebase')).toEqual({
      direction: 'out',
      runId: 'run_b',
      peer: 'Beta Web: Fix header',
      body: 'please rebase'
    })
  })
  it('reads a received note', () => {
    expect(parsePeerNote('Note from run run_a (Alpha: Add caching), from its orchestrator: the API changed\nsee src/db.ts')).toEqual({
      direction: 'in',
      runId: 'run_a',
      peer: 'Alpha: Add caching',
      body: 'the API changed\nsee src/db.ts'
    })
  })
  it('keeps markdown-looking peer text as is', () => {
    expect(parsePeerNote('Note from run r (P: x), from its orchestrator: **bold** [link](http://x)')?.body).toBe('**bold** [link](http://x)')
  })
  it('ignores other system rows', () => {
    expect(parsePeerNote('Continued from run run_a')).toBeNull()
    expect(parsePeerNote('Sent to nobody')).toBeNull()
  })
})
