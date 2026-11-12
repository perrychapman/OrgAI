import { describe, expect, it, beforeEach } from 'vitest'
import type { ConnectionInfo, Project, Role } from '@shared/types'
import { newProject } from '@shared/defaults'
import { setConnectionRegistry } from './connectionLabel'
import { BRIDGED_NOTE, bridgedLimits, connectionTag, connectionTagTitle, connectionsViewOf, groupConnectionNote, isPinned, isWriterRole, modelFoldSummary, pinnedRoles, rootRunsOnLine, roleProblemText, roleProblems, runsOnDefaultText, runsOnHintText, runsOnOptions, showRunsOn } from './roleConnection'

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

  it('words the bridged limits, the writer line only for writers', () => {
    const quiet = bridgedLimits('proxy-1234abcd', false)
    expect(quiet).toContain('its own session on Gateway')
    expect(quiet).toContain('answers its lead once and cannot be messaged')
    expect(quiet).toContain('not bridged')
    expect(quiet).not.toContain('no worktree')
    expect(bridgedLimits('proxy-1234abcd', true)).toContain('project folder with no worktree')
    expect(runsOnHintText('proxy-1234abcd', false)).toContain('Bills and routes through Gateway')
    expect(runsOnDefaultText('anthropic')).toBe('Runs on the project default, Anthropic.')
    expect(BRIDGED_NOTE).toContain('cannot be messaged')
    expect(isWriterRole({ tools: ['Read', 'Bash'] })).toBe(true)
    expect(isWriterRole({ tools: ['Read', 'Grep'] })).toBe(false)
  })

  it('words the fold summary, the root line and the group tooltip', () => {
    expect(modelFoldSummary('Everyday', 'proxy-1234abcd', 'anthropic')).toBe('Everyday · Runs on Gateway')
    expect(modelFoldSummary('Everyday', 'anthropic', 'anthropic')).toBe('Everyday')
    expect(rootRunsOnLine('anthropic')).toBe("The orchestrator runs on the project's connection (Anthropic); change it in Project settings > Connection.")
    expect(groupConnectionNote([{ connection: 'anthropic' }, { connection: 'proxy-1234abcd' }, {}], 'anthropic')).toBe(' · ran on Gateway')
    expect(groupConnectionNote([{ connection: 'anthropic' }], 'anthropic')).toBe('')
    expect(groupConnectionNote([{ connection: 'proxy-1234abcd' }], undefined)).toBe('')
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

  it('shows a role that names the project\'s own connection as kept, not as the default', () => {
    const p = project('anthropic')
    const opts = runsOnOptions(p.roles[1], p, [anthropic, openai, proxy(true)])
    expect(opts.map((o) => o.value)).toEqual(['', 'anthropic', 'proxy-1234abcd'])
    expect(opts[1].label).toBe('Anthropic (kept if the project switches)')
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
