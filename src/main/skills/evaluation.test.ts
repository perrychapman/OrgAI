import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, RunRecord, SkillInfo, TranscriptEntry } from '@shared/types'
import { project, runSummary } from '../runtime/testHelpers'
import { RunStore } from '../store/runs'
import { runDigester } from '../store/runDigest'
import { SkillEvaluationService, confinedPathExists, type SkillEvaluationDeps } from './evaluation'
import type { SkillServiceApi } from './types'

const dirs: string[] = []
const temp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'orgai-skeval-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

let n = 0
const tool = (name: string): TranscriptEntry => ({ id: `e${n++}`, agentId: 'a', at: n, block: { kind: 'tool_use', id: `t${n}`, name, input: {} } })
const seqRecord = (id: string, startedAt: number): RunRecord => ({
  summary: runSummary({ id, startedAt }),
  agents: {},
  transcript: ['Read', 'Grep', 'Edit', 'Bash'].map(tool),
  logs: []
})

const info: SkillInfo = {
  spec: { id: 'sk1', name: 'pdf', description: 'Use when filling in or reading PDF forms and merging documents.', enabled: true, source: 'user', digest: 'x', files: [], addedAt: '', updatedAt: '' },
  grantedTo: []
}
const answer = JSON.stringify({ suggestions: [{ name: 'read-edit', description: 'Use when running the read grep edit loop.', body: 'Do it.', rationale: 'Repeats.', findingIds: ['repeatedToolSequence-1'] }] })

let dataDir: string
let repo: string
let proj: Project
let records: RunRecord[]
let complete: ReturnType<typeof vi.fn>
let svc: SkillEvaluationService

function build(over: Partial<SkillEvaluationDeps> = {}): void {
  svc = new SkillEvaluationService({
    dataDir,
    project: (id) => (id === proj.id ? proj : null),
    listRuns: () => records.map((r) => r.summary),
    getRun: (id) => records.find((r) => r.summary.id === id) ?? null,
    skills: { list: () => [info], read: () => ({ skillMd: 'See `docs/gone.md` for details.', body: '', files: [] }) } as unknown as SkillServiceApi,
    complete: complete as never,
    ...over
  })
}
beforeEach(() => {
  dataDir = temp()
  repo = temp()
  proj = project({ id: 'p1', path: repo, skillEvaluation: { enabled: true, tokenBudget: 20_000 } })
  records = [seqRecord('r1', 1), seqRecord('r2', 2), seqRecord('r3', 3)]
  complete = vi.fn(async (_p: Project, input: { onUsage?: (u: unknown) => void }) => {
    input.onUsage?.({ tokens: { input: 100, output: 50, cacheRead: 10, cacheWrite: 0 }, costUsd: 0.01, model: 'sonnet' })
    return { text: answer, model: 'sonnet' }
  })
  build()
})

describe('SkillEvaluationService.evaluate', () => {
  it('throws for an unknown project', async () => {
    await expect(svc.evaluate('nope')).rejects.toThrow('Project not found')
  })

  it('returns deterministic findings and model suggestions with reported usage', async () => {
    const r = await svc.evaluate('p1')
    expect(r.runsConsidered).toBe(3)
    expect(r.findings.map((f) => f.kind)).toEqual(expect.arrayContaining(['neverGranted', 'stale', 'repeatedToolSequence']))
    expect(r.modelAssisted).toBe(true)
    expect(r.suggestions).toHaveLength(1)
    expect(r.suggestions[0].findingIds).toEqual(['repeatedToolSequence-1'])
    expect(r.tokensUsed).toBe(160)
    expect(r.costUsd).toBe(0.01)
    expect(r.tokensEstimated).toBeUndefined()
    expect(r.model).toBe('sonnet')
    const call = complete.mock.calls[0]
    expect(call[1]).toMatchObject({ kind: 'skills', tier: 'everyday' })
    expect(call[1].signal).toBeInstanceOf(AbortSignal)
  })

  it('estimates tokens when no usage is reported', async () => {
    complete.mockImplementation(async () => ({ text: answer }))
    const r = await svc.evaluate('p1')
    expect(r.tokensEstimated).toBe(true)
    expect(r.tokensUsed).toBeGreaterThan(0)
    expect(r.costUsd).toBeNull()
  })

  it('skips when disabled', async () => {
    proj = { ...proj, skillEvaluation: { enabled: false, tokenBudget: 20_000 } }
    const r = await svc.evaluate('p1')
    expect(r.skippedReason).toBe('disabled')
    expect(r.modelAssisted).toBe(false)
    expect(complete).not.toHaveBeenCalled()
    expect(r.findings.length).toBeGreaterThan(0)
  })

  it('derives enabled from the team review when unset, and an explicit false wins', async () => {
    proj = { ...proj, skillEvaluation: { tokenBudget: 20_000 }, teamReview: { auto: 'ai', tokenBudget: 20_000, everyRuns: 3 } }
    const on = await svc.evaluate('p1')
    expect(on.modelAssisted).toBe(true)
    expect(complete).toHaveBeenCalledTimes(1)
    complete.mockClear()
    proj = { ...proj, teamReview: { auto: 'free', tokenBudget: 20_000, everyRuns: 3 } }
    const free = await svc.evaluate('p1')
    expect(free.skippedReason).toBe('disabled')
    proj = { ...proj, skillEvaluation: { enabled: false, tokenBudget: 20_000 }, teamReview: { auto: 'ai', tokenBudget: 20_000, everyRuns: 3 } }
    const off = await svc.evaluate('p1')
    expect(off.skippedReason).toBe('disabled')
    expect(complete).not.toHaveBeenCalled()
  })

  it('skips when there are no gaps', async () => {
    records = [seqRecord('r1', 1)]
    const r = await svc.evaluate('p1')
    expect(r.skippedReason).toBe('no-gaps')
    expect(complete).not.toHaveBeenCalled()
  })

  it('skips over budget without calling', async () => {
    proj = { ...proj, skillEvaluation: { enabled: true, tokenBudget: 1_000 } }
    const r = await svc.evaluate('p1')
    expect(r.skippedReason).toBe('budget')
    expect(complete).not.toHaveBeenCalled()
  })

  it('turns a failure into a one-line error and keeps findings', async () => {
    complete.mockRejectedValue(new Error('401 Bearer abcdefghijklmnop1234\nsecond line'))
    const r = await svc.evaluate('p1')
    expect(r.skippedReason).toBe('error')
    expect(r.error).not.toContain('\n')
    expect(r.error).not.toContain('abcdefghijklmnop1234')
    expect(r.error!.length).toBeLessThanOrEqual(300)
    expect(r.findings.length).toBeGreaterThan(0)
  })

  it('reads only the newest 20 work runs', async () => {
    records = Array.from({ length: 25 }, (_, i) => seqRecord(`r${i}`, i))
    records.push({ ...seqRecord('setup', 999), summary: runSummary({ id: 'setup', kind: 'setup', startedAt: 999 }) })
    const r = await svc.evaluate('p1')
    expect(r.runsConsidered).toBe(20)
  })

  it('is single-flight per project', async () => {
    let release!: () => void
    complete.mockImplementation(() => new Promise((res) => (release = () => res({ text: answer }))))
    const a = svc.evaluate('p1')
    const b = svc.evaluate('p1')
    expect(a).toBe(b)
    await vi.waitFor(() => expect(complete).toHaveBeenCalled())
    release()
    await a
    complete.mockImplementation(async () => ({ text: answer }))
    await svc.evaluate('p1')
    expect(complete).toHaveBeenCalledTimes(2)
  })
})

describe('persistence and suggestions', () => {
  it('round-trips the report and tolerates missing or corrupt files', async () => {
    expect(svc.last('p1')).toBeNull()
    const r = await svc.evaluate('p1')
    expect(svc.last('p1')).toEqual(r)
    writeFileSync(join(dataDir, 'skill-evaluations', 'p1.json'), '{not json')
    expect(svc.last('p1')).toBeNull()
    expect(svc.last('../evil')).toBeNull()
  })

  it('suggestion and markApplied', async () => {
    await svc.evaluate('p1')
    const s = svc.suggestion('p1', 'suggestion-1')
    expect(s.draft.name).toBe('read-edit')
    expect(() => svc.suggestion('p1', 'nope')).toThrow('Suggestion not found')
    svc.markApplied('p1', 'suggestion-1', 'skill-9')
    expect(svc.last('p1')!.suggestions[0].appliedSkillId).toBe('skill-9')
    expect(() => svc.suggestion('p1', 'suggestion-1')).toThrow('Suggestion already applied')
    expect(JSON.parse(readFileSync(join(dataDir, 'skill-evaluations', 'p1.json'), 'utf8')).suggestions[0].appliedSkillId).toBe('skill-9')
  })
})

describe('confinedPathExists', () => {
  it('finds files inside the root and rejects escapes', () => {
    mkdirSync(join(repo, 'docs'))
    writeFileSync(join(repo, 'docs', 'a.md'), 'x')
    const outside = temp()
    writeFileSync(join(outside, 'secret.txt'), 'x')
    const exists = confinedPathExists(repo)
    expect(exists('docs/a.md')).toBe(true)
    expect(exists('docs/missing.md')).toBe(false)
    expect(exists('../' + outside + '/secret.txt')).toBe(false)
    expect(exists(join(outside, 'secret.txt'))).toBe(false)
    expect(exists('/etc/passwd')).toBe(false)
    expect(exists('docs/../docs/a.md')).toBe(false)
    expect(exists('')).toBe(false)
  })

  it('does not follow a symlinked parent out of the root', () => {
    const outside = temp()
    writeFileSync(join(outside, 'secret.txt'), 'x')
    try {
      symlinkSync(outside, join(repo, 'link'), 'junction')
    } catch {
      return
    }
    expect(confinedPathExists(repo)('link/secret.txt')).toBe(false)
  })

  it('reports a leaf symlink as existing without following it', () => {
    const outside = temp()
    writeFileSync(join(outside, 'secret.txt'), 'x')
    try {
      symlinkSync(join(outside, 'secret.txt'), join(repo, 'leaf.txt'), 'file')
    } catch {
      return
    }
    expect(confinedPathExists(repo)('leaf.txt')).toBe(true)
  })

  it('is false for a missing root', () => {
    expect(confinedPathExists(join(repo, 'nope'))('a/b.md')).toBe(false)
  })
})

// Wave 7 (cli-standalone.md round 6 item 9): the drain's quiesce aborts an evaluation's model step.
describe('SkillEvaluationService.dispose', () => {
  it('aborts the model step in flight, keeps the last saved report, and refuses new evaluations', async () => {
    const first = await svc.evaluate('p1')
    expect(first.modelAssisted).toBe(true)
    complete.mockImplementation(
      (_p: Project, input: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => input.signal.addEventListener('abort', () => reject(new Error('aborted'))))
    )
    const p = svc.evaluate('p1')
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(2))
    expect(svc.inFlightCount()).toBe(1)
    svc.dispose()
    const cut = await p
    expect(cut.skippedReason).toBe('error')
    expect(cut.error).toBe('OrgAI shut down before the model answered.')
    expect(svc.inFlightCount()).toBe(0)
    // The saved report is still the good one.
    expect(svc.last('p1')?.modelAssisted).toBe(true)
    expect(svc.last('p1')?.suggestions).toHaveLength(1)
    await expect(svc.evaluate('p1')).rejects.toThrow(/shutting down/)
  })
})

// Self-healing efficiency step 1, second half: the evaluation reads the digests RunStore caches beside each record.
describe('SkillEvaluationService reads cached run digests', () => {
  const user = (text: string): TranscriptEntry => ({ id: `e${n++}`, agentId: 'a', at: n, block: { kind: 'user', text } })
  const finished = (id: string, startedAt: number, skills?: { skillId: string; loads: number }[]): RunRecord => ({
    summary: runSummary({ id, startedAt, endedAt: startedAt + 5, status: 'finished', ...(skills ? { usage: { skills: skills.map((s) => ({ ...s, name: s.skillId, roles: [] })) } as never } : {}) }),
    agents: {},
    transcript: [user('Add a login page'), ...['Read', 'Grep', 'Edit', 'Bash'].map(tool), user('No, always run the linter before you commit the change')],
    logs: []
  })
  let store: RunStore
  const fill = (count: number): RunRecord[] => {
    const out = Array.from({ length: count }, (_, i) => finished(`d${i}`, 100 + i, i === 3 ? [{ skillId: 'sk1', loads: 2 }] : undefined))
    for (const r of out) {
      store.upsert(r.summary)
      store.saveRecord(r)
    }
    return out
  }
  const hosted = (): void =>
    build({
      listRuns: (pid) => store.list(pid),
      getRun: (id) => store.getRecord(id),
      getDigest: (id) => store.getDigest(id)
    })
  beforeEach(() => {
    store = new RunStore(temp())
    store.digester = runDigester
  })

  it('over 20 already-digested runs parses no record', async () => {
    const recs = fill(20)
    for (const r of recs) expect(store.getDigest(r.summary.id)).not.toBeNull()
    hosted()
    const read = vi.spyOn(store, 'getRecord')
    const report = await svc.evaluate('p1')
    expect(read).not.toHaveBeenCalled()
    expect(report.runsConsidered).toBe(20)
    expect(report.findings.map((f) => f.kind)).toEqual(expect.arrayContaining(['repeatedToolSequence', 'repeatedCorrection']))
    // The next evaluation after one new run parses that run only.
    const fresh = finished('fresh', 500)
    store.upsert(fresh.summary)
    store.saveRecord(fresh)
    read.mockClear()
    const next = await svc.evaluate('p1')
    expect(read.mock.calls.map((c) => c[0])).toEqual(['fresh'])
    expect(next.runsConsidered).toBe(20)
  })

  it('gives the same findings as the records do', async () => {
    fill(8)
    hosted()
    const viaDigests = await svc.evaluate('p1')
    // The same runs through the records (no digest port, the bench's way).
    build({ listRuns: (pid) => store.list(pid), getRun: (id) => store.getRecord(id) })
    const viaRecords = await svc.evaluate('p1')
    expect(viaDigests.findings.length).toBeGreaterThan(2)
    expect(viaDigests.findings).toEqual(viaRecords.findings)
    expect(viaDigests.runsConsidered).toBe(viaRecords.runsConsidered)
  })

  it('a run still in progress is digested from the in-memory record, never through getDigest', async () => {
    const live = finished('live', 900)
    live.summary = { ...live.summary, status: 'running', endedAt: undefined }
    const getDigest = vi.fn(() => null)
    const getRun = vi.fn((id: string) => (id === 'live' ? live : store.getRecord(id)))
    build({ listRuns: () => [live.summary], getRun, getDigest })
    const report = await svc.evaluate('p1')
    expect(getDigest).not.toHaveBeenCalled()
    expect(getRun).toHaveBeenCalledWith('live')
    expect(report.runsConsidered).toBe(1)
    // An ended run still goes through the digest port first.
    build({ listRuns: () => [{ ...live.summary, status: 'finished', endedAt: 905 }], getRun, getDigest })
    await svc.evaluate('p1')
    expect(getDigest).toHaveBeenCalledWith('live')
  })

  it('a run with no readable record still counts, from its summary', async () => {
    const [r] = fill(1)
    store.upsert({ ...r.summary, id: 'ghost', startedAt: 50 })
    hosted()
    const report = await svc.evaluate('p1')
    expect(report.runsConsidered).toBe(2)
  })

  // Self-healing efficiency D7: evolution reads fresh deterministic findings, not the user's last evaluation.
  describe('fresh (deterministic findings for evolution)', () => {
    const kinds = (f: { kind: string }[] | null): string[] => (f ?? []).map((x) => x.kind)
    const addRun = (id: string, startedAt: number): void => {
      const r = finished(id, startedAt)
      store.upsert(r.summary)
      store.saveRecord(r)
    }

    it('reflects a run finished after the last evaluation, and leaves the stored evaluation and its drafts untouched', async () => {
      // The user's evaluation ran earlier, over three other runs (r1..r3), and drafted one suggestion.
      const stored = await svc.evaluate('p1')
      expect(stored.suggestions).toHaveLength(1)
      const seqRuns = (fs: { kind: string; evidence?: { runIds?: string[] } }[] | null): string[] => (fs ?? []).find((x) => x.kind === 'repeatedToolSequence')?.evidence?.runIds ?? []
      expect(seqRuns(stored.findings)).toEqual(expect.arrayContaining(['r1']))
      const file = join(dataDir, 'skill-evaluations', 'p1.json')
      const bytes = readFileSync(file, 'utf8')
      const calls = complete.mock.calls.length

      // Since then three runs finished (the host's run store now holds them).
      fill(2)
      addRun('d-late', 900)
      hosted()
      const f = svc.fresh('p1')
      expect(seqRuns(f)).toEqual(expect.arrayContaining(['d-late', 'd0', 'd1']))
      expect(seqRuns(f)).not.toContain('r1')
      // The stored evaluation is as the user left it: same bytes, same findings and drafts, no model call.
      expect(readFileSync(file, 'utf8')).toBe(bytes)
      expect(svc.last('p1')).toEqual(stored)
      expect(svc.last('p1')?.suggestions).toHaveLength(1)
      expect(seqRuns(svc.last('p1')?.findings ?? [])).not.toContain('d-late')
      expect(complete.mock.calls.length).toBe(calls)
    })

    it('writes nothing when no evaluation was ever run, and spends no tokens', () => {
      fill(5)
      hosted()
      const f = svc.fresh('p1')
      expect(kinds(f)).toContain('repeatedToolSequence')
      expect(svc.last('p1')).toBeNull()
      expect(complete).not.toHaveBeenCalled()
    })

    it('over 20 already-digested runs parses no record; one new run parses that run only', () => {
      for (const r of fill(20)) expect(store.getDigest(r.summary.id)).not.toBeNull()
      hosted()
      const read = vi.spyOn(store, 'getRecord')
      expect(svc.fresh('p1')?.length).toBeGreaterThan(0)
      expect(read).not.toHaveBeenCalled()
      addRun('fresh', 500)
      read.mockClear()
      svc.fresh('p1')
      expect(read.mock.calls.map((c) => c[0])).toEqual(['fresh'])
      // And the new digest is cached: asking again parses nothing.
      read.mockClear()
      svc.fresh('p1')
      expect(read).not.toHaveBeenCalled()
    })

    it('counts finished and failed runs only: a run in progress is never digested for evolution', () => {
      const live = finished('live', 900)
      live.summary = { ...live.summary, status: 'running', endedAt: undefined }
      const getRun = vi.fn(() => live)
      const getDigest = vi.fn(() => null)
      build({ listRuns: () => [live.summary], getRun, getDigest })
      // Only skill quality findings (the skill itself), nothing derived from a run.
      expect(kinds(svc.fresh('p1')).filter((k) => k === 'repeatedToolSequence' || k === 'repeatedCorrection' || k === 'neverLoaded')).toEqual([])
      expect(getRun).not.toHaveBeenCalled()
      expect(getDigest).not.toHaveBeenCalled()
    })

    it('is null for an unknown project or a throwing run listing (the host then falls back to the stored report)', () => {
      expect(svc.fresh('nope')).toBeNull()
      build({ listRuns: () => { throw new Error('index unreadable') } })
      expect(svc.fresh('p1')).toBeNull()
    })
  })
})
