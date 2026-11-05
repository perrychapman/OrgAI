// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { cutWhile, endedByOf, runStatus, settleEndedAgents, statusOfRun, statusText } from './runStatus'

const agent = (id: string, parentId: string | null, state: string, activity: string) => ({ id, parentId, state: state as never, activity, endedAt: undefined as number | undefined })

describe('endedBy status words', () => {
  it('reads user as Stopped with the user note', () => {
    const v = runStatus('finished', { endedBy: 'user' })
    expect(v).toMatchObject({ word: 'Stopped', note: 'You ended this session' })
    expect(statusText(v)).toBe('Stopped')
  })
  it('reads app as Stopped, shown as "Ended when OrgAI closed"', () => {
    const v = runStatus('finished', { endedBy: 'app' })
    expect(v.word).toBe('Stopped')
    expect(statusText(v)).toBe('Ended when OrgAI closed')
  })
  it('reads the old endedWithApp flag as app', () => {
    expect(statusText(runStatus('finished', { endedWithApp: true }))).toBe('Ended when OrgAI closed')
    expect(endedByOf({ endedWithApp: true })).toBe('app')
  })
  it('lets app beat the stopped fallback and endedBy beat the flag', () => {
    expect(statusText(runStatus('finished', { endedBy: 'app', stopped: true }))).toBe('Ended when OrgAI closed')
    expect(endedByOf({ endedBy: 'user', endedWithApp: true })).toBe('user')
  })
  it('uses the stopped root label only for an old record with no end reason', () => {
    const agents = { a: { parentId: null, activity: 'Stopped' } }
    expect(statusOfRun({ summary: { status: 'finished', kind: 'work' }, agents }, undefined, false).word).toBe('Stopped')
    // A summary that says how it ended wins over the agent label.
    expect(statusOfRun({ summary: { status: 'finished', kind: 'work', endedBy: 'app' }, agents: { a: { parentId: null, activity: 'Finished' } } }, undefined, false).word).toBe('Stopped')
    expect(statusOfRun({ summary: { status: 'finished', kind: 'work' }, agents: { a: { parentId: null, activity: 'Finished' } } }, undefined, false).word).toBe('Finished')
  })
  it('does not apply an end reason to a failed run', () => {
    expect(runStatus('error', { endedBy: 'app' }).word).toBe('Failed')
  })
})

describe('cutWhile', () => {
  it('is working when any agent was busy', () => {
    expect(cutWhile({ r: agent('r', null, 'idle', 'Idle'), w: agent('w', 'r', 'tool', 'Reading') })).toBe('working')
  })
  it('is waiting when the root sat idle or an agent asked the user', () => {
    expect(cutWhile({ r: agent('r', null, 'idle', 'Idle') })).toBe('waiting')
    expect(cutWhile({ r: agent('r', null, 'waiting', 'Needs approval: Bash') })).toBe('waiting')
  })
  it('defaults to working with no agents', () => {
    expect(cutWhile(undefined)).toBe('working')
    expect(cutWhile({})).toBe('working')
  })
})

describe('settleEndedAgents', () => {
  const agents = { r: agent('r', null, 'thinking', 'Thinking'), w: agent('w', 'r', 'waiting', 'Waiting for you'), d: agent('d', 'r', 'done', 'Finished') }
  it('leaves live runs untouched (same object)', () => {
    expect(settleEndedAgents({ status: 'running' }, agents)).toBe(agents)
    expect(settleEndedAgents({ status: 'paused' }, agents)).toBe(agents)
  })
  it('settles an ended run so nothing reads Thinking or Waiting', () => {
    const out = settleEndedAgents({ status: 'finished', endedBy: 'app', endedAt: 5 }, agents)
    expect(out.r).toMatchObject({ activity: 'Ended when OrgAI closed', state: 'done', endedAt: 5 })
    expect(out.w).toMatchObject({ activity: 'Stopped', state: 'done' })
    expect(out.d).toBe(agents.d)
  })
  it('marks open agents of a failed run as failed', () => {
    const out = settleEndedAgents({ status: 'error' }, agents)
    expect(out.r).toMatchObject({ activity: 'Failed', state: 'error' })
    expect(out.w).toMatchObject({ activity: 'Failed', state: 'error' })
  })
  it('returns the same object when nothing changes', () => {
    const settled = settleEndedAgents({ status: 'finished', endedBy: 'user' }, agents)
    expect(settleEndedAgents({ status: 'finished', endedBy: 'user' }, settled)).toBe(settled)
  })
})
