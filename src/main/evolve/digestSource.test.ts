import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, RunRecord, RunSummary } from '../../shared/types'
import { RunStore } from '../store/runs'
import { runDigester, type RunDigest } from '../store/runDigest'
import { project, run } from './fixtures'
import { createEvolveService, type EvolveServiceDeps } from './service'
import { isMeasuredRun, isTrialRun } from './telemetry'

/**
 * Self-healing efficiency step 1: the engine reads digests the host's RunStore caches beside each record, so a pass
 * parses no record it digested before. Ports wired as host/bootstrap.ts wires them.
 */

let dataDir: string
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'orgai-evolve-digest-'))
})
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

function hostPorts(store: RunStore, p: Project): EvolveServiceDeps {
  return {
    dataDir,
    now: () => 1_000,
    getProject: (id) => (id === p.id ? p : undefined),
    updateProject: () => p,
    listRunRecords: (projectId, limit) => {
      const out: RunRecord[] = []
      for (const s of store.list(projectId)) {
        if (out.length >= limit) break
        if (!isMeasuredRun({ summary: s })) continue
        const rec = store.getRecord(s.id)
        if (rec) out.push(rec)
      }
      return out
    },
    listRunSummaries: (projectId, limit) => store.list(projectId).filter((s) => isTrialRun({ summary: s })).slice(0, limit),
    getRunRecord: (runId) => store.getRecord(runId) ?? undefined,
    listRunDigests: (projectId, limit) => {
      const out: RunDigest[] = []
      for (const s of store.list(projectId)) {
        if (out.length >= limit) break
        if (!isMeasuredRun({ summary: s })) continue
        const d = store.getDigest(s.id)
        if (d) out.push(d)
      }
      return out
    },
    getRunDigest: (runId) => store.getDigest(runId) ?? undefined
  }
}

function save(store: RunStore, r: RunRecord): void {
  store.upsert(r.summary as RunSummary)
  store.saveRecord(r)
}

const runs = (n: number): RunRecord[] => Array.from({ length: n }, () => run({ agents: [{ slug: 'dev' }, { slug: 'review' }] }))

describe('evolve reads cached run digests', () => {
  it('a second analysis parses no record; a new run is the only record parsed after it', async () => {
    const store = new RunStore(dataDir)
    store.digester = runDigester
    const p = project()
    for (const r of runs(4)) save(store, r)
    const svc = createEvolveService(hostPorts(store, p))
    const read = vi.spyOn(store, 'getRecord')
    const first = await svc.analyze({ projectId: p.id })
    expect(read).toHaveBeenCalledTimes(4)
    read.mockClear()
    const second = await svc.analyze({ projectId: p.id })
    expect(read).not.toHaveBeenCalled()
    expect(second.diagnosis).toEqual(first.diagnosis)
    const [fresh] = runs(1)
    save(store, fresh)
    read.mockClear()
    const third = await svc.analyze({ projectId: p.id })
    expect(read.mock.calls.map((c) => c[0])).toEqual([fresh.summary.id])
    expect(third.diagnosis.runIds[0]).toBe(fresh.summary.id)
  })

  it('settling a trial reads digests: only a run never digested is parsed', async () => {
    const store = new RunStore(dataDir)
    store.digester = runDigester
    let p = project()
    const clean = (n: number, t0: number): RunRecord[] =>
      Array.from({ length: n }, (_, i) => run({ startedAt: t0 + i * 1000, agents: [{ slug: 'dev', turns: 3, out: 400 }, { slug: 'dev', turns: 3, out: 400 }], assignments: [{ tier: 'deep' }, { tier: 'deep' }] }))
    for (const r of clean(8, 1_000_000)) save(store, r)
    const NOW = 5_000_000
    const svc = createEvolveService({ ...hostPorts(store, p), now: () => NOW, getProject: (id) => (id === p.id ? p : undefined), updateProject: (_id, fn) => (p = fn(p)) })
    const applied = await svc.apply({ projectId: p.id })
    expect(applied.applied).toBe(true)
    const trial = clean(3, NOW + 10)
    for (const r of trial) save(store, r)
    // Two of the window's runs were digested already (in the host: by their own post-run pass or the Team review).
    store.getDigest(trial[0].summary.id)
    store.getDigest(trial[1].summary.id)
    const read = vi.spyOn(store, 'getRecord')
    const res = await svc.afterRun({ projectId: p.id, evolve: false })
    expect(res.ratchet).toBe('promoted')
    expect(read.mock.calls.map((c) => c[0])).toEqual([trial[2].summary.id])
  })

  it('without digest ports (the bench) the records are digested and the diagnosis is the same', async () => {
    const store = new RunStore(dataDir)
    store.digester = runDigester
    const p = project()
    for (const r of runs(4)) save(store, r)
    const { listRunDigests: _l, getRunDigest: _g, listRunSummaries: _s, getRunRecord: _r, ...recordsOnly } = hostPorts(store, p)
    const viaDigests = await createEvolveService(hostPorts(store, p)).analyze({ projectId: p.id })
    const viaRecords = await createEvolveService(recordsOnly).analyze({ projectId: p.id })
    expect(viaRecords.diagnosis).toEqual(viaDigests.diagnosis)
  })
})
