import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, RunRecord, SkillInfo, TranscriptEntry } from '@shared/types'
import { project, runSummary } from '../runtime/testHelpers'
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
