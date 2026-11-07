import { describe, expect, it, beforeEach } from 'vitest'
import type { ConnectionInfo, Project, Role } from '@shared/types'
import { newProject } from '@shared/defaults'
import { setConnectionRegistry } from './connectionLabel'
import { connectionTag, connectionTagTitle, connectionsViewOf, isPinned, pinnedRoles, roleProblemText, roleProblems, runsOnOptions, showRunsOn } from './roleConnection'

const anthropic: ConnectionInfo = {
  connection: { id: 'anthropic', enabled: true, auth: { kind: 'subscription' }, tierModels: {} },
  status: { state: 'connected' } as ConnectionInfo['status'],
  modelCount: 4,
  isDefault: true
}
const openai: ConnectionInfo = {
  connection: { id: 'openai', enabled: false, auth: { kind: 'chatgpt' }, tierModels: {} },
  status: { state: 'disconnected' } as ConnectionInfo['status'],
  modelCount: 3,
  isDefault: false
}
const proxy = (enabled: boolean, state: 'connected' | 'disconnected' = 'connected'): ConnectionInfo => ({
  connection: { id: 'proxy-1234abcd', name: 'Gateway', kind: 'litellm', enabled, anthropicBaseUrl: 'https://p.example', hasApiKey: true, tierModels: {} },
  status: { state } as ConnectionInfo['status'],
  modelCount: 9,
  isDefault: false
})

function project(pin?: string): Project {
  const p = newProject({ name: 'Demo', path: '/tmp/demo', brief: '' })
  const roles: Role[] = p.roles.map((r, i) => (i === 1 && pin ? { ...r, connection: pin } : r))
  return { ...p, provider: { ...p.provider, id: 'claude', connection: 'anthropic' }, roles }
}

describe('roleConnection', () => {
  beforeEach(() => setConnectionRegistry([anthropic, openai, proxy(true)]))

  it('rebuilds the connections view', () => {
    const v = connectionsViewOf([anthropic, openai, proxy(true)])
    expect(v?.connections?.anthropic.id).toBe('anthropic')
    expect(v?.proxies?.map((p) => p.id)).toEqual(['proxy-1234abcd'])
    expect(connectionsViewOf(null)).toBeUndefined()
  })

  it('knows pinned roles and never pins the root', () => {
    const p = project('proxy-1234abcd')
    expect(pinnedRoles(p).map((r) => r.id)).toEqual([p.roles[1].id])
    const root = p.roles.find((r) => r.reportsTo === null)!
    expect(isPinned({ ...root, connection: 'proxy-1234abcd' }, p)).toBe(false)
  })

  it('lists Runs on options and keeps a removed pin visible', () => {
    const p = project('proxy-00000000')
    const opts = runsOnOptions(p.roles[1], p, [anthropic, openai, proxy(true)])
    expect(opts.map((o) => o.label)).toEqual(['Project default (Anthropic)', 'Gateway', 'Removed proxy'])
    expect(showRunsOn(p.roles[1], p, [anthropic])).toBe(true)
    expect(showRunsOn(project().roles[1], project(), [anthropic, openai])).toBe(false)
    expect(showRunsOn(project().roles[1], project(), [anthropic, proxy(true)])).toBe(true)
  })

  it('reports problems in the role panel words', () => {
    const p = project('proxy-1234abcd')
    const list = [anthropic, openai, proxy(false)]
    setConnectionRegistry(list)
    const out = roleProblems(p, list)
    expect(out).toHaveLength(1)
    expect(out[0].text).toBe(`${p.roles[1].name} runs on Gateway, which is not set up or is turned off. Connect it in App settings or change the role's Runs on.`)
    expect(roleProblemText({ roleName: 'Reviewer', connection: 'openai', problem: 'disconnected' })).toBe(
      "Reviewer runs on OpenAI, which is not connected. Connect it in App settings or change the role's Runs on."
    )
    expect(roleProblems(p, null)).toEqual([])
  })

  it('tags only a connection other than the base', () => {
    expect(connectionTag('openai', 'anthropic')).toBe('OpenAI')
    expect(connectionTag('anthropic', 'anthropic')).toBeNull()
    expect(connectionTag(undefined, 'anthropic')).toBeNull()
    expect(connectionTagTitle('openai', 'anthropic')).toBe("Runs on OpenAI, not this project's default (Anthropic)")
  })
})
