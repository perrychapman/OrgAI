import { describe, expect, it } from 'vitest'
import type { RunEndedBy, RunStatus } from '@shared/types'
import { HOST_END_NOTE, endedByOf, runStatus, statusOfRun, statusText } from './runStatus'
import { continuationDivider, endedComposerCopy } from './runChains'

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
    expect(runStatus('finished', { endedWithApp: true })).toMatchObject({ word: 'Stopped', tone: 'stopped', note: 'Ended when OrgAI closed' })
    expect(runStatus('finished').tone).toBe('ok')
  })

  it('explains a run that ended with the app, only when finished', () => {
    expect(runStatus('finished', { endedWithApp: true }).note).toBe('Ended when OrgAI closed')
    expect(runStatus('finished').note).toBeUndefined()
    expect(runStatus('error', { endedWithApp: true }).note).toBeUndefined()
  })
})

describe('host-finalized end reasons (policy, budget)', () => {
  const summary = (endedBy: RunEndedBy) => ({ status: 'finished' as const, kind: 'work' as const, endedBy })
  const rootStopped = { r: { parentId: null, activity: 'Stopped' } }

  it('a run ended by its exec policy reads Stopped, never a plain Finished (review Low)', () => {
    expect(endedByOf({ endedBy: 'policy' })).toBeUndefined()
    const view = statusOfRun({ summary: summary('policy') }, undefined, false)
    expect(view).toEqual({ word: 'Stopped', tone: 'stopped', note: HOST_END_NOTE.policy })
    expect(statusText(view)).toBe('Stopped by its exec policy')
  })

  it('a run ended at its budget reads Stopped at its budget limit (review Low)', () => {
    expect(endedByOf({ endedBy: 'budget' })).toBeUndefined()
    const view = statusOfRun({ summary: summary('budget') }, undefined, false)
    expect(view).toEqual({ word: 'Stopped', tone: 'stopped', note: HOST_END_NOTE.budget })
    expect(statusText(view)).toBe('Stopped at its budget limit')
  })

  it('a failed exec run still reads Failed; the root agent label is never the source', () => {
    expect(statusOfRun({ summary: { ...summary('policy'), status: 'error' } }, undefined, false).word).toBe('Failed')
    for (const by of ['policy', 'budget'] as RunEndedBy[]) {
      expect(statusText(statusOfRun({ summary: summary(by), agents: rootStopped }, undefined, false))).toBe(HOST_END_NOTE[by as 'policy' | 'budget'])
    }
  })

  it('keeps the user and app wording', () => {
    expect(statusText(statusOfRun({ summary: summary('user') }, undefined, false))).toBe('Stopped')
    expect(statusText(statusOfRun({ summary: summary('app') }, undefined, false))).toBe('Ended when OrgAI closed')
    expect(statusText(statusOfRun({ summary: { status: 'finished', kind: 'work', endedWithApp: true } }, undefined, false))).toBe(
      'Ended when OrgAI closed'
    )
  })

  it('does not treat policy or budget as cut by OrgAI closing in chain copy', () => {
    const base = { id: 'a', projectId: 'p', startedAt: 1_000, endedAt: 2_000, status: 'finished' as const }
    for (const by of ['policy', 'budget'] as RunEndedBy[]) {
      const copy = endedComposerCopy({ ...base, endedBy: by }, { continuable: true, now: 3_000 })
      expect(copy.notice).toBeUndefined()
      const divider = continuationDivider({ ...base, endedBy: by }, { ...base, id: 'b', startedAt: 5_000 })
      expect(divider.label).not.toBe('Continued after OrgAI closed')
    }
    expect(endedComposerCopy({ ...base, endedBy: 'app' }, { continuable: true, now: 3_000 }).notice).toBeDefined()
  })
})
