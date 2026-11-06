import { describe, expect, it } from 'vitest'
import { keepsHostBusy, runActivityState, type RunActivityInput } from './runActivity'
import { ROOT_AGENT_ID } from './types'

const base: RunActivityInput = {
  status: 'idle',
  openCards: 0,
  held: false,
  limitHold: false,
  agents: [{ id: ROOT_AGENT_ID, state: 'idle' }],
  peerMessagesPending: false
}
const settled = { rootTurnGen: 1, rootIdle: true, continuationSettled: true, nudgeTurn1Sent: false, quiescent: true }

describe('runActivityState', () => {
  it('a root in a turn is working; starting too', () => {
    expect(runActivityState({ ...base, status: 'running' })).toBe('working')
    expect(runActivityState({ ...base, status: 'starting' })).toBe('working')
  })

  it('an idle run with nothing pending only waits on the user', () => {
    expect(runActivityState(base)).toBe('waiting')
    expect(runActivityState({ ...base, settlement: settled })).toBe('waiting')
  })

  it('an open card, an interrupt hold or a usage-limit hold is waiting, even mid-turn', () => {
    expect(runActivityState({ ...base, status: 'running', openCards: 1 })).toBe('waiting')
    expect(runActivityState({ ...base, status: 'running', held: true })).toBe('waiting')
    expect(runActivityState({ ...base, limitHold: true })).toBe('waiting')
  })

  it('idle while reports work, peer messages are queued or the adapter has work pending is working', () => {
    expect(runActivityState({ ...base, agents: [...base.agents, { id: 'r1', state: 'tool' }] })).toBe('working')
    expect(runActivityState({ ...base, agents: [...base.agents, { id: 'r1', state: 'done' }] })).toBe('waiting')
    expect(runActivityState({ ...base, peerMessagesPending: true })).toBe('working')
    expect(runActivityState({ ...base, settlement: { ...settled, quiescent: false } })).toBe('working')
    expect(runActivityState({ ...base, settlement: { ...settled, rootIdle: false } })).toBe('working')
  })

  it('a due continuation nudge is working, but not before the first root turn ended', () => {
    expect(runActivityState({ ...base, settlement: { ...settled, continuationSettled: false } })).toBe('working')
    expect(runActivityState({ ...base, settlement: { ...settled, rootTurnGen: 0, continuationSettled: false } })).toBe('waiting')
  })

  it('stopping is ending; ended or paused statuses wait', () => {
    expect(runActivityState({ ...base, status: 'stopping' })).toBe('ending')
    expect(runActivityState({ ...base, status: 'paused' })).toBe('waiting')
    expect(runActivityState({ ...base, status: 'finished' })).toBe('waiting')
  })
})

describe('keepsHostBusy', () => {
  it('everything but a waiting run, unless an exec run is still in flight', () => {
    expect(keepsHostBusy('working', false)).toBe(true)
    expect(keepsHostBusy('ending', false)).toBe(true)
    expect(keepsHostBusy('waiting', false)).toBe(false)
    expect(keepsHostBusy('waiting', true)).toBe(true)
  })
})
