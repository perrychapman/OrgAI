import { describe, expect, it } from 'vitest'
import type { RunSummary } from '@shared/types'
import { adoptRecordRunState } from './runPlaceholder'

const placeholder: RunSummary = { id: 'run_1', projectId: 'p', kind: 'work', prompt: 'hi', status: 'starting', startedAt: 1, totalCostUsd: 0.02 }
const record: RunSummary = { id: 'run_1', projectId: 'p', kind: 'work', prompt: 'hi', status: 'idle', startedAt: 1, totalCostUsd: 0.01, sessionId: 's1' }

describe('adoptRecordRunState', () => {
  it('takes the record status when no run.status event reached the window', () => {
    const out = adoptRecordRunState(placeholder, record, false)
    expect(out.status).toBe('idle')
    expect(out.sessionId).toBe('s1')
    // Event-held figures stay (the trailing run.usage is newer than nothing).
    expect(out.totalCostUsd).toBe(0.02)
  })

  it('keeps the event status once a run.status event arrived', () => {
    const seen = { ...placeholder, status: 'running' as const }
    expect(adoptRecordRunState(seen, record, true)).toBe(seen)
  })

  it('carries the end facts of an ended record', () => {
    const ended: RunSummary = { ...record, status: 'finished', endedAt: 9, endedBy: 'user', error: 'x' }
    const out = adoptRecordRunState(placeholder, ended, false)
    expect(out).toMatchObject({ status: 'finished', endedAt: 9, endedBy: 'user', error: 'x' })
  })

  it('keeps a session id an event already set', () => {
    expect(adoptRecordRunState({ ...placeholder, sessionId: 'newer' }, record, false).sessionId).toBe('newer')
  })
})
