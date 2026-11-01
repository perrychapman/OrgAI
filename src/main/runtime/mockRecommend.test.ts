import { describe, expect, it, vi } from 'vitest'
import { MockAdapter } from './mock'

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
})
