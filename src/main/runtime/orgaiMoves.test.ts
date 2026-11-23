import { beforeEach, describe, expect, it } from 'vitest'
import { ORGAI_MOVES_KEPT, movedOnlyByOrgAi, orgAiGeneration, recordOrgAiMove, resetOrgAiMoves, type HeadState } from './orgaiMoves'

const at = (head: string, branch = 'refs/heads/main'): HeadState => ({ head, branch })
const ROOT = '/repo/main'

beforeEach(resetOrgAiMoves)

describe('the ledger of OrgAI\'s own HEAD moves', () => {
  it('a move advances the generation; a move that went nowhere does not', () => {
    expect(orgAiGeneration(ROOT)).toBe(0)
    recordOrgAiMove(ROOT, at('a'), at('b'))
    expect(orgAiGeneration(ROOT)).toBe(1)
    recordOrgAiMove(ROOT, at('b'), at('b'))
    expect(orgAiGeneration(ROOT)).toBe(1)
    expect(orgAiGeneration('/repo/other')).toBe(0)
  })

  it('a chain of OrgAI moves from the pinned HEAD to HEAD now is explained', () => {
    recordOrgAiMove(ROOT, at('a'), at('b'))
    recordOrgAiMove(ROOT, at('b'), at('c'))
    expect(movedOnlyByOrgAi(ROOT, at('a'), 0, at('c'))).toBe(true)
    // A pin taken after the first move only needs the later one.
    expect(movedOnlyByOrgAi(ROOT, at('b'), 1, at('c'))).toBe(true)
  })

  it('nothing moved since the pin: not "moved by OrgAI" (the caller sees no drift in that case)', () => {
    recordOrgAiMove(ROOT, at('a'), at('b'))
    expect(movedOnlyByOrgAi(ROOT, at('b'), 1, at('b'))).toBe(false)
  })

  it('someone else\'s commit between two OrgAI moves breaks the chain', () => {
    recordOrgAiMove(ROOT, at('a'), at('b'))
    // The user commits b -> x; OrgAI's next merge starts from x.
    recordOrgAiMove(ROOT, at('x'), at('y'))
    expect(movedOnlyByOrgAi(ROOT, at('a'), 0, at('y'))).toBe(false)
  })

  it('a commit after OrgAI\'s last move leaves HEAD somewhere the ledger did not take it', () => {
    recordOrgAiMove(ROOT, at('a'), at('b'))
    expect(movedOnlyByOrgAi(ROOT, at('a'), 0, at('z'))).toBe(false)
  })

  it('a branch switch is a move too; a different branch at the same commit is not the same state', () => {
    recordOrgAiMove(ROOT, at('a', 'refs/heads/feature'), at('m', 'refs/heads/main'))
    expect(movedOnlyByOrgAi(ROOT, at('a', 'refs/heads/feature'), 0, at('m', 'refs/heads/main'))).toBe(true)
    expect(movedOnlyByOrgAi(ROOT, at('a', 'refs/heads/feature'), 0, at('m', 'detached'))).toBe(false)
  })

  it('a pin older than the moves kept cannot be explained', () => {
    let at0 = at('h0')
    for (let i = 1; i <= ORGAI_MOVES_KEPT + 3; i++) {
      const next = at(`h${i}`)
      recordOrgAiMove(ROOT, at0, next)
      at0 = next
    }
    expect(movedOnlyByOrgAi(ROOT, at('h0'), 0, at0)).toBe(false)
    // A recent pin still is.
    expect(movedOnlyByOrgAi(ROOT, at(`h${ORGAI_MOVES_KEPT}`), ORGAI_MOVES_KEPT, at0)).toBe(true)
  })

  // With several orgai sessions on one data folder the ledger is per process: a merge another session made into the
  // same checkout is not in it. That must read as someone else's change (the merge gate then refuses), never as OrgAI's.
  it('a move another session made is not in this process\'s ledger, so it reads as a change by someone else', () => {
    // This session pinned HEAD at a; another session merged a -> b; nothing here was recorded.
    expect(movedOnlyByOrgAi(ROOT, at('a'), 0, at('b'))).toBe(false)
    // This session then makes its own move from where the other left HEAD: the chain does not start at the pin.
    recordOrgAiMove(ROOT, at('b'), at('c'))
    expect(movedOnlyByOrgAi(ROOT, at('a'), 0, at('c'))).toBe(false)
    // Another session's later move after this one's is not explained either.
    expect(movedOnlyByOrgAi(ROOT, at('b'), 0, at('d'))).toBe(false)
  })

  it('checkouts are separate ledgers', () => {
    recordOrgAiMove(ROOT, at('a'), at('b'))
    expect(movedOnlyByOrgAi('/repo/other', at('a'), 0, at('b'))).toBe(false)
  })
})
