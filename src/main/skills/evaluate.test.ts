import { describe, expect, it } from 'vitest'
import type { SkillInfo, TranscriptEntry } from '@shared/types'
import { role, runSummary } from '../runtime/testHelpers'
import { correctionFindings, evaluateSkills, qualityFindings, referencedPaths, relativePathCandidate, toolSequenceFindings, vagueReason, type EvalInput, type EvalRun } from './evaluate'

const GOOD = 'Use when filling in or reading PDF forms, extracting text and merging documents.'
function skill(id: string, over: Partial<SkillInfo['spec']> = {}, info: Partial<SkillInfo> = {}): SkillInfo {
  return {
    spec: { id, name: id, description: GOOD, enabled: true, source: 'user', digest: 'x', files: [{ path: 'SKILL.md', bytes: 1 }], addedAt: '', updatedAt: '', ...over },
    grantedTo: [],
    ...info
  }
}
let n = 0
const tool = (agentId: string, name: string): TranscriptEntry => ({ id: `e${n++}`, agentId, at: n, block: { kind: 'tool_use', id: `t${n}`, name, input: {} } })
const user = (text: string, source?: 'harness'): TranscriptEntry => ({ id: `e${n++}`, agentId: 'a', at: n, block: { kind: 'user', text }, ...(source ? { source } : {}) })
const run = (id: string, transcript: TranscriptEntry[], skills?: { skillId: string; loads: number }[]): EvalRun => ({
  summary: runSummary({ id, usage: skills ? ({ skills: skills.map((s) => ({ ...s, name: s.skillId, roles: [] })) } as never) : undefined }),
  transcript
})
const input = (over: Partial<EvalInput> = {}): EvalInput => ({ roles: [], skills: [], runs: [], pathExists: () => true, ...over })
const kinds = (fs: { kind: string }[]): string[] => fs.map((f) => f.kind)

describe('quality findings', () => {
  it('neverGranted: enabled and no role grants it', () => {
    const f = qualityFindings(input({ skills: [{ info: skill('a'), skillMd: '' }] }))
    expect(kinds(f)).toContain('neverGranted')
    const granted = qualityFindings(input({ roles: [role({ id: 'r', slug: 'r', skills: ['a'] })], skills: [{ info: skill('a'), skillMd: '' }] }))
    expect(kinds(granted)).not.toContain('neverGranted')
    const off = qualityFindings(input({ skills: [{ info: skill('a', { enabled: false }), skillMd: '' }] }))
    expect(kinds(off)).not.toContain('neverGranted')
  })

  it('neverLoaded needs 3 runs and a grant, and no loads', () => {
    const roles = [role({ id: 'r', slug: 'r', skills: ['a'] })]
    const skills = [{ info: skill('a', {}, { grantedTo: ['r'] }), skillMd: '' }]
    const two = qualityFindings(input({ roles, skills, runs: [run('1', []), run('2', [])] }))
    expect(kinds(two)).not.toContain('neverLoaded')
    const three = qualityFindings(input({ roles, skills, runs: [run('1', []), run('2', []), run('3', [])] }))
    expect(kinds(three)).toContain('neverLoaded')
    const loaded = qualityFindings(input({ roles, skills, runs: [run('1', []), run('2', [], [{ skillId: 'a', loads: 1 }]), run('3', [])] }))
    expect(kinds(loaded)).not.toContain('neverLoaded')
  })

  it('overlap reports a similar pair once with rounded similarity', () => {
    const skills = [
      { info: skill('a', { description: 'Use when filling in PDF forms and extracting PDF text' }), skillMd: '' },
      { info: skill('b', { description: 'Use when filling PDF forms and extracting text from PDF' }), skillMd: '' },
      { info: skill('c', { description: 'Run database migrations before deploying the schema changes' }), skillMd: '' }
    ]
    const f = qualityFindings(input({ skills })).filter((x) => x.kind === 'overlap')
    expect(f).toHaveLength(1)
    expect(f[0].skillIds).toEqual(['a', 'b'])
    expect(f[0].evidence?.similarity).toBeGreaterThanOrEqual(0.6)
    expect(String(f[0].evidence?.similarity)).toMatch(/^\d(\.\d{1,2})?$/)
  })

  it('vagueDescription: short, few words or generic; reasonable ones pass', () => {
    const vague = (d: string): boolean => kinds(qualityFindings(input({ skills: [{ info: skill('a', { description: d }), skillMd: '' }] }))).includes('vagueDescription')
    expect(vague('PDF helper')).toBe(true)
    expect(vague('Helper utility for various misc stuff and things in general work')).toBe(true)
    expect(vague('General helper tools for various common tasks and other work, plus deploys')).toBe(true)
    expect(vague(GOOD)).toBe(false)
    // The UX walkthrough's false positive (ux-review-skills-2 P1-3): 8 words, only 5 of them meaningful.
    expect(vague('Use before deploying to verify the release checklist.')).toBe(false)
    // Specific without a "when" cue is not vague any more.
    expect(vague('Fills in PDF forms and extracts text from scanned documents quickly')).toBe(false)
    // Mostly generic words pass when they say when to use the skill.
    expect(vague('Helper tools for common tasks; use when the release checklist runs')).toBe(false)
  })

  it('vagueReason states one reason per rule', () => {
    expect(vagueReason('PDF helper')).toBe('only 10 characters')
    expect(vagueReason('Supercalifragilistic expialidocious antidisestablishment')).toBe('only 3 words')
    expect(vagueReason('Helper utility for various misc stuff and things in general work')).toBe('only generic words')
    expect(vagueReason('General helper tools for various common tasks and other work, plus deploys')).toBe('mostly generic words and no cue for when to use it')
    expect(vagueReason('Use before deploying to verify the release checklist.')).toBeNull()
  })

  it('vagueReason is linear on long input', () => {
    const long = 'word '.repeat(50_000) + 'when deploying'
    const t = performance.now()
    vagueReason(long)
    expect(performance.now() - t).toBeLessThan(500)
  })

  it('neverLoaded evidence has no zero count', () => {
    const runs = [1, 2, 3].map((i) => run(String(i), []))
    const f = qualityFindings(input({ roles: [role({ id: 'r', slug: 'r', skills: ['a'] })], skills: [{ info: skill('a', {}, { grantedTo: ['r'] }), skillMd: '' }], runs })).find((x) => x.kind === 'neverLoaded')
    expect(f).toBeDefined()
    expect(f?.evidence?.count).toBeUndefined()
  })

  it('libraryMissing', () => {
    const f = qualityFindings(input({ skills: [{ info: skill('a', {}, { libraryMissing: true }), skillMd: '' }] }))
    expect(kinds(f)).toContain('libraryMissing')
    expect(kinds(qualityFindings(input({ skills: [{ info: skill('a'), skillMd: '' }] })))).not.toContain('libraryMissing')
  })

  it('stale reports the missing paths only', () => {
    const md = 'See `docs/api.md` and [guide](docs/guide.md) and src/old/thing.ts. Also https://x.dev/a/b.md and ../secret/x.txt.'
    const f = qualityFindings(input({ skills: [{ info: skill('a'), skillMd: md }], pathExists: (p) => p === 'docs/api.md' })).find((x) => x.kind === 'stale')
    expect(f?.evidence?.paths).toEqual(['docs/guide.md', 'src/old/thing.ts'])
    const none = qualityFindings(input({ skills: [{ info: skill('a'), skillMd: md }], pathExists: () => true }))
    expect(kinds(none)).not.toContain('stale')
  })

  it('stale never probes escaping, absolute, URL or own-file paths', () => {
    const probed: string[] = []
    const md = ['`/etc/passwd.txt`', '`C:/Windows/x.dll`', '`../up/x.md`', '`a/../b.md`', 'https://e.com/a/b.md', 'github.com/o/r.md', '`scripts/fill.py`', '`~/x/y.md`', '`ok/dir/file.md`'].join('\n')
    qualityFindings(input({ skills: [{ info: skill('a', { files: [{ path: 'SKILL.md', bytes: 1 }, { path: 'scripts/fill.py', bytes: 1 }] }), skillMd: md }], pathExists: (p) => (probed.push(p), true) }))
    expect(probed).toEqual(['ok/dir/file.md'])
  })

  it('stale caps at 50 paths per skill', () => {
    const md = Array.from({ length: 200 }, (_, i) => `\`dir/f${i}.md\``).join('\n')
    expect(referencedPaths(md, [])).toHaveLength(50)
  })

  it('relativePathCandidate rules', () => {
    expect(relativePathCandidate('./src/a.ts')).toBe('src/a.ts')
    expect(relativePathCandidate('a.ts')).toBeNull()
    expect(relativePathCandidate('src/dir')).toBeNull()
    expect(relativePathCandidate('src/*.ts')).toBeNull()
    expect(relativePathCandidate('src/a.ts#L10')).toBe('src/a.ts')
  })

  it('ids are stable and unique within a report', () => {
    const f = qualityFindings(input({ skills: [{ info: skill('a'), skillMd: '' }, { info: skill('b'), skillMd: '' }] }))
    expect(new Set(f.map((x) => x.id)).size).toBe(f.length)
    expect(f.every((x) => !x.title.includes('\n'))).toBe(true)
  })
})

describe('gap findings', () => {
  const seq = ['Read', 'Grep', 'Edit', 'Bash']
  const runWith = (id: string, names: string[]): EvalRun => run(id, names.map((nm) => tool('a', nm)))

  it('repeatedToolSequence needs 3 runs and distinct tools', () => {
    expect(toolSequenceFindings([runWith('1', seq), runWith('2', seq)])).toHaveLength(0)
    const f = toolSequenceFindings([runWith('1', seq), runWith('2', seq), runWith('3', seq)])
    expect(f).toHaveLength(1)
    expect(f[0].evidence).toEqual({ sequence: seq, runIds: ['1', '2', '3'] })
    expect(f[0].title).toContain('3 runs')
    expect(f[0].detail).not.toMatch(/[0-9]/)
    const same = Array(6).fill('Read')
    expect(toolSequenceFindings([runWith('1', same), runWith('2', same), runWith('3', same)])).toHaveLength(0)
  })

  it('counts a window once per run and keeps top 5', () => {
    const many = Array.from({ length: 8 }, (_, i) => [`T${i}`, 'X', 'Y', 'Z'])
    const runs = [1, 2, 3].map((i) => runWith(String(i), [...many.flat(), ...seq, ...seq]))
    const f = toolSequenceFindings(runs)
    expect(f.length).toBeLessThanOrEqual(5)
    expect(f.every((x) => x.evidence?.runIds?.length === 3 && x.evidence.count === undefined)).toBe(true)
  })

  it('does not join tool calls of different agents', () => {
    const mixed = (id: string): EvalRun => run(id, [tool('a', 'Read'), tool('b', 'Grep'), tool('a', 'Edit'), tool('b', 'Bash')])
    expect(toolSequenceFindings([mixed('1'), mixed('2'), mixed('3')])).toHaveLength(0)
  })

  it('repeatedCorrection groups similar corrections across 2 runs', () => {
    const r = (id: string, fix: string): EvalRun => run(id, [user('Please add a login page'), user(fix), user('thanks looks good')])
    const f = correctionFindings([
      r('1', "No, don't use var, always use const for declarations"),
      r('2', "Don't use var again, always use const declarations please"),
      r('3', 'No, run the linter before committing the change')
    ])
    expect(f).toHaveLength(1)
    expect(f[0].evidence?.runIds).toEqual(['1', '2'])
    expect(f[0].detail).toContain('use var')
    expect(f[0].detail).not.toContain('\n')
  })

  it('ignores the first message, harness rows and single-run repeats', () => {
    const one = run('1', [user("Don't use var, always use const declarations"), user("Don't use var, always use const declarations", 'harness')])
    const two = run('2', [user('Start'), user("Don't use var, always use const declarations")])
    expect(correctionFindings([one, two])).toHaveLength(0)
    const same = run('3', [user('Start'), user("Don't use var, always use const declarations"), user("Don't use var, always use const declarations")])
    expect(correctionFindings([same])).toHaveLength(0)
  })

  it('caps the excerpt at 160 characters', () => {
    const long = "Don't " + 'verylongword '.repeat(60)
    const mk = (id: string): EvalRun => run(id, [user('Start'), user(long)])
    const f = correctionFindings([mk('1'), mk('2')])
    expect(f).toHaveLength(1)
    const quoted = f[0].detail.match(/"([^"]*)"/)![1]
    expect(quoted.length).toBeLessThanOrEqual(160)
  })

  it('is linear-time on a large transcript', () => {
    const big: TranscriptEntry[] = []
    for (let i = 0; i < 20_000; i++) big.push(tool('a', `T${i % 7}`))
    for (let i = 0; i < 2_000; i++) big.push(user(i === 0 ? 'first' : `Don't do thing number ${i} again, always variant ${i % 13}`))
    const runs = Array.from({ length: 20 }, (_, i) => run(String(i), big))
    const t0 = Date.now()
    const out = evaluateSkills(input({ runs }))
    expect(Date.now() - t0).toBeLessThan(3000)
    expect(out.gaps.length).toBeGreaterThan(0)
  })
})
