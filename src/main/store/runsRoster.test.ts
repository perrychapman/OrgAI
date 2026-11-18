import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RunRecord, RunSummary } from '@shared/types'
import { RUN_ROSTER_MAX, RunStore, cleanRunRoster } from './runs'

/** RunRecord.roster is rebuilt on read (review L1). */

const ok = { id: 'r-lead', slug: 'lead', name: 'Lead', color: '#7C5CFF', reportsTo: null }

describe('cleanRunRoster', () => {
  it('keeps valid entries field by field and drops junk', () => {
    expect(
      cleanRunRoster([
        ok,
        { id: 'r-qa', slug: 'qa', name: 'QA', color: '#22c58b', reportsTo: 'r-lead', added: true, extra: 'x' },
        { id: 'r-old', slug: 'old', name: 'Old', color: 'red; background:url(x)', reportsTo: 5, removed: true, added: 'yes' },
        { id: '', slug: 'x', name: 'x', color: '#000000', reportsTo: null },
        { id: 'r-no-name', slug: 'x', color: '#000000', reportsTo: null },
        'junk',
        null,
        [1]
      ])
    ).toEqual([
      { id: 'r-lead', slug: 'lead', name: 'Lead', color: '#7c5cff', reportsTo: null },
      { id: 'r-qa', slug: 'qa', name: 'QA', color: '#22c58b', reportsTo: 'r-lead', added: true },
      { id: 'r-old', slug: 'old', name: 'Old', color: '', reportsTo: null, removed: true }
    ])
  })

  it('cuts long text, caps the length and answers undefined for nothing valid', () => {
    const [one] = cleanRunRoster([{ ...ok, id: 'i'.repeat(500), slug: 's'.repeat(500), name: 'n'.repeat(500), reportsTo: 'p'.repeat(500) }])!
    expect([one.id.length, one.slug.length, one.name.length, one.reportsTo?.length]).toEqual([200, 100, 200, 200])
    expect(cleanRunRoster(Array.from({ length: 500 }, (_, i) => ({ ...ok, id: `r${i}` })))).toHaveLength(RUN_ROSTER_MAX)
    expect(cleanRunRoster([])).toBeUndefined()
    expect(cleanRunRoster([{ nope: 1 }])).toBeUndefined()
    expect(cleanRunRoster({ id: 'x' })).toBeUndefined()
    expect(cleanRunRoster('x')).toBeUndefined()
  })
})

describe('RunStore.getRecord and the roster', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orgai-runs-roster-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })
  const summary: RunSummary = { id: 'run-1', projectId: 'p1', kind: 'work', prompt: 'go', status: 'finished', startedAt: 1, totalCostUsd: 0 }
  const rec = (roster: unknown): RunRecord => ({ summary, agents: {}, transcript: [], logs: [], roster } as unknown as RunRecord)

  it('cleans a stored roster, drops one with nothing valid, and leaves a record without one alone', () => {
    const s = new RunStore(dir)
    s.saveRecord(rec([ok, { id: 7 }]))
    expect(s.getRecord('run-1')?.roster).toEqual([{ ...ok, color: '#7c5cff' }])
    s.saveRecord(rec([{ id: 7 }]))
    const dropped = s.getRecord('run-1')!
    expect('roster' in dropped).toBe(false)
    s.saveRecord({ summary, agents: {}, transcript: [], logs: [] })
    expect('roster' in s.getRecord('run-1')!).toBe(false)
  })
})
