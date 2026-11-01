import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { discoverLocalMcp } from '../capabilities/localMcp'
import { discoverLocalSkills } from '../capabilities/localSkills'
import { seedMockHome } from '../capabilities/mockHome'
import { buildRecommendPrompt, parseRecommendAnswer } from '../capabilities/recommend'
import { MockAdapter } from './mock'
import { orgChart, project } from './testHelpers'

interface Answer {
  recommendations: { candidateId: string; roleIds: string[]; reason: string; access: string }[]
  gaps: { roleId: string; need: string }[]
}

const ROLES = ['role boss | name=Boss | root=yes | x=1', 'role dev | name=Dev | root=no | x=2', 'role qa | name=QA | root=no'].join('\n')
const CANDS = [
  'candidate c-conn | kind=connector | origin=catalog | name=Slack',
  'candidate c-gh | kind=connector | origin=catalog | name=GitHub',
  'candidate c-reg | kind=mcp | origin=registry | name=reg',
  'candidate c-loc | kind=mcp | origin=local | name=loc',
  'candidate c-skill | kind=skill | origin=repo | name=sk',
  'candidate c-lib | kind=skill | origin=library | name=lib'
].join('\n')

async function ask(prompt: string, extra: { signal?: AbortSignal; onUsage?: () => void } = {}): Promise<Answer> {
  const out = await new MockAdapter().complete({ system: 's', prompt, kind: 'recommend', ...extra } as never)
  return JSON.parse(out) as Answer
}

describe('mock recommend completion', () => {
  it('orders picks and targets the first non-root role', async () => {
    const a = await ask(`intro\n${ROLES}\n${CANDS}\n`)
    expect(a.recommendations.map((r) => r.candidateId)).toEqual(['c-skill', 'c-loc', 'c-reg', 'c-gh'])
    expect(a.recommendations.every((r) => r.roleIds[0] === 'dev' && r.access === 'read' && r.reason)).toBe(true)
    expect(a.gaps).toEqual([{ roleId: 'dev', need: 'No skill covers writing tests for this role (mock gap).' }])
  })
  it('uses the first connector when none mentions github', async () => {
    const a = await ask(`${ROLES}\ncandidate c1 | kind=connector | origin=catalog | name=Slack\ncandidate c2 | kind=connector | origin=catalog | name=Notion`)
    expect(a.recommendations.map((r) => r.candidateId)).toEqual(['c1'])
  })
  it('falls back to the first three candidates', async () => {
    const a = await ask(`${ROLES}\n${[1, 2, 3, 4].map((i) => `candidate k${i} | kind=skill | origin=library | name=n${i}`).join('\n')}`)
    expect(a.recommendations.map((r) => r.candidateId)).toEqual(['k1', 'k2', 'k3'])
  })
  it('honours the scope line', async () => {
    const a = await ask(`scope qa\n${ROLES}\n${CANDS}`)
    expect(a.recommendations[0]!.roleIds).toEqual(['qa'])
    expect(a.gaps[0]!.roleId).toBe('qa')
  })
  it('falls back to the first role when all are root', async () => {
    const a = await ask(`role a | name=A | root=yes\nrole b | name=B | root=yes\n${CANDS}`)
    expect(a.recommendations[0]!.roleIds).toEqual(['a'])
  })
  it('answers empty with no roles', async () => {
    expect(await ask(CANDS)).toEqual({ recommendations: [], gaps: [] })
  })
  it('throws on the fail marker and on abort, and reports usage', async () => {
    await expect(ask(`${ROLES}\n[mock:recommend-fail]`)).rejects.toThrow('Mock recommend failure')
    const ac = new AbortController()
    ac.abort()
    await expect(ask(ROLES, { signal: ac.signal })).rejects.toThrow('cancelled')
    const onUsage = vi.fn()
    await ask(ROLES, { onUsage })
    expect(onUsage).toHaveBeenCalledTimes(1)
  })

  it('also picks the local code-review skill for the scoped role', async () => {
    const cands = [CANDS, 'candidate c-cr | kind=skill | origin=local | name=code-review'].join('\n')
    const a = await ask(`scope qa\n${ROLES}\n${cands}`)
    const cr = a.recommendations.find((r) => r.candidateId === 'c-cr')
    expect(cr?.roleIds).toEqual(['qa'])
    // A different local skill is not picked.
    const b = await ask(`${ROLES}\n${CANDS}\ncandidate c-x | kind=skill | origin=local | name=other`)
    expect(b.recommendations.map((r) => r.candidateId)).not.toContain('c-x')
  })

  it('answers a mock-home prompt with GitHub access and the code-review skill, and the answer parses', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orgai-mockrec-'))
    try {
      const home = join(root, 'home')
      seedMockHome(home)
      const ctx = { projectPath: join(root, 'repo'), homeDir: home, env: {}, platform: process.platform }
      const local = [...discoverLocalSkills(ctx).candidates, ...discoverLocalMcp(ctx).candidates].map((c) => c.item)
      const gh = { ...local[0]!, id: 'gh-conn', kind: 'connector', origin: 'catalog', name: 'GitHub', description: 'Repos' } as (typeof local)[number]
      const all = [...local, gh]
      const proj = project({ roles: orgChart() })
      const { prompt } = buildRecommendPrompt(proj, all, {})
      const out = await new MockAdapter().complete({ system: 's', prompt, kind: 'recommend' } as never)
      const parsed = parseRecommendAnswer(out, all, proj.roles, {}, 'salt')
      expect(parsed.ok).toBe(true)
      if (!parsed.ok) return
      const names = parsed.recommendations.map((r) => all.find((i) => i.id === r.candidateId)?.name)
      expect(names).toContain('code-review')
      expect(names).toContain('GitHub')
      expect(parsed.recommendations.length).toBeGreaterThanOrEqual(1)
      expect(parsed.recommendations.every((r) => r.roleIds[0] === 'r-eng')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
