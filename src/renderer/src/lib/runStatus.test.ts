import { describe, expect, it } from 'vitest'
import type { RunStatus } from '@shared/types'
import { runStatus } from './runStatus'

describe('runStatus', () => {
  it('maps every RunStatus to the shared vocabulary', () => {
    const expected: Record<RunStatus, [string, string]> = {
      starting: ['Running', 'is-running'],
      running: ['Running', 'is-running'],
      stopping: ['Running', 'is-running'],
      idle: ['Idle', 'idle'],
      paused: ['Paused', 'paused'],
      finished: ['Finished', 'ok'],
      error: ['Failed', 'danger']
    }
    for (const [status, [word, tone]] of Object.entries(expected)) {
      const v = runStatus(status as RunStatus)
      expect([status, v.word, v.tone]).toEqual([status, word, tone])
    }
  })

  it('notes a stopping run but keeps the word Running', () => {
    expect(runStatus('stopping')).toEqual({ word: 'Running', tone: 'is-running', note: 'Stopping' })
    expect(runStatus('running').note).toBeUndefined()
  })

  it('lets waiting win over every status', () => {
    for (const s of ['running', 'idle', 'finished', 'error', 'paused'] as RunStatus[]) {
      expect(runStatus(s, { waiting: true })).toEqual({ word: 'Needs you', tone: 'warn' })
    }
  })

  it('gives a stopped run the neutral stopped tone, not the info blue of Idle', () => {
    expect(runStatus('finished', { stopped: true })).toMatchObject({ word: 'Stopped', tone: 'stopped' })
    expect(runStatus('idle').tone).toBe('idle')
    // A run cut off when the app closed is an abnormal end: neutral, never the success tone.
    expect(runStatus('finished', { endedWithApp: true })).toMatchObject({ word: 'Finished', tone: 'stopped', note: 'Ended when OrgAI closed' })
    expect(runStatus('finished').tone).toBe('ok')
  })

  it('explains a run that ended with the app, only when finished', () => {
    expect(runStatus('finished', { endedWithApp: true }).note).toBe('Ended when OrgAI closed')
    expect(runStatus('finished').note).toBeUndefined()
    expect(runStatus('error', { endedWithApp: true }).note).toBeUndefined()
  })
})
