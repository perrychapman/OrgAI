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

  it('explains a run that ended with the app, only when finished', () => {
    expect(runStatus('finished', { endedWithApp: true }).note).toBe('Ended when OrgAI closed')
    expect(runStatus('finished').note).toBeUndefined()
    expect(runStatus('error', { endedWithApp: true }).note).toBeUndefined()
  })
})
