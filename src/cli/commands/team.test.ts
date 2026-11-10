import { afterEach, describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import type { HostScope, OrgTemplateInfo, Project, Role } from '../../shared/types'
import { manageDeps } from '../manage'
import { fakeContext, FakeHostClient, project, rpcError, type Answer } from '../testing/fakeContext'
import { CliError } from '../types'
import { runTeam } from './team'

const ALL: { grantedScopes: HostScope[] } = { grantedScopes: ['read', 'operate', 'decide', 'configure'] }
const realDeps = { ...manageDeps }
afterEach(() => {
  Object.assign(manageDeps, realDeps)
})

const lead: Role = {
  id: 'lead',
  slug: 'lead',
  name: 'Lead',
  description: 'Runs things',
  responsibilities: ['Plan'],
  prompt: 'You lead.‮evil​\nLine two \x1b[31mred',
  tools: ['Read'],
  model: 'opus',
  tier: 'deep',
  canSpawn: true,
  spawnable: ['dev'],
  reportsTo: null,
  position: { x: 0, y: 0 },
  color: '#000',
  skills: ['sk1']
}
const dev: Role = { ...lead, id: 'dev', slug: 'dev', name: 'Dev', prompt: 'You build.', canSpawn: false, spawnable: [], reportsTo: 'lead', tier: 'everyday', model: 'sonnet', skills: [] }
const P = project('p1', '/work', { name: 'App', roles: [lead, dev], plugins: [{ id: 'plg1', name: 'fmt', path: '/plugins/fmt', enabled: true }] } as Partial<Project>)
const T: OrgTemplateInfo = { id: 'tpl_1', name: 'Web team', description: 'Two roles', kind: 'code', roleCount: 2, roleNames: ['Lead', 'Dev'], createdAt: 1, updatedAt: 1 }

function setup(answers: Record<string, Answer>, opts: { format?: 'text' | 'json' } = {}) {
  const client = new FakeHostClient({ 'projects:list': () => [P], 'templates:list': () => [T], ...answers }, { hello: ALL })
  const f = fakeContext({ connect: [client], cwd: '/work', globals: { outputFormat: opts.format ?? 'text' } })
  return { f, client }
}

async function exitOf(p: Promise<number>): Promise<number> {
  try {
    return await p
  } catch (e) {
    if (e instanceof CliError) return e.exitCode
    throw e
  }
}

describe('team templates', () => {
  it('lists (bare and list)', async () => {
    for (const args of [['templates'], ['templates', 'list']]) {
      const { f } = setup({})
      expect(await runTeam(f.ctx, args)).toBe(0)
      expect(f.out()).toContain('tpl_1  Web team (code, 2 roles')
    }
  })

  it('saves from the project with name and description', async () => {
    const { f, client } = setup({ 'templates:saveFromProject': () => T })
    expect(await runTeam(f.ctx, ['templates', 'save', '--name', 'Web team', '--description', 'Two roles'])).toBe(0)
    expect(client.callsOf('templates:saveFromProject')).toEqual([[{ projectId: 'p1', name: 'Web team', description: 'Two roles' }]])
    expect(f.connectCalls[0].scopes).toEqual(['read', 'configure'])
  })

  it('save needs --name', async () => {
    const { f } = setup({})
    expect(await exitOf(runTeam(f.ctx, ['templates', 'save']))).toBe(2)
  })

  it('apply needs a confirmation; --yes applies (replace by default) and says it cannot be undone', async () => {
    let s = setup({ 'templates:apply': () => ({ project: P, previousRoles: [] }) })
    expect(await exitOf(runTeam(s.f.ctx, ['templates', 'apply', 'tpl_1']))).toBe(2)
    expect(s.client.callsOf('templates:apply')).toEqual([])
    s = setup({ 'templates:apply': () => ({ project: P, previousRoles: P.roles }) })
    expect(await runTeam(s.f.ctx, ['templates', 'apply', 'tpl_1', '--yes'])).toBe(0)
    expect(s.client.callsOf('templates:apply')).toEqual([[{ projectId: 'p1', templateId: 'tpl_1', mode: 'replace' }]])
    // The Desktop Team tab cannot undo a CLI apply (its Undo comes only from applies the renderer made), so never promise it.
    expect(s.f.out()).not.toContain('Desktop Team tab')
    expect(s.f.out()).toContain('This cannot be undone from the CLI')
    expect(s.f.out()).toContain(`The previous chart had ${P.roles.length} roles.`)
  })

  it('apply of an unknown template is exit 2', async () => {
    const { f } = setup({})
    expect(await exitOf(runTeam(f.ctx, ['templates', 'apply', 'nope', '--yes']))).toBe(2)
  })

  it('remove with --yes', async () => {
    const { f, client } = setup({ 'templates:remove': () => [] })
    expect(await runTeam(f.ctx, ['templates', 'remove', 'tpl_1', '--yes'])).toBe(0)
    expect(client.callsOf('templates:remove')).toEqual([['tpl_1']])
  })
})

describe('team roles / role', () => {
  it('lists name, tier, manager and grants', async () => {
    const { f } = setup({})
    expect(await runTeam(f.ctx, ['roles'])).toBe(0)
    expect(f.out()).toContain('Lead [lead] · deep · root · 1 grant')
    expect(f.out()).toContain('Dev [dev] · everyday · reports to Lead · 0 grants')
  })

  it('shows one role with hidden characters made visible and escapes stripped', async () => {
    const { f } = setup({})
    expect(await runTeam(f.ctx, ['role', 'Lead'])).toBe(0)
    const out = f.out()
    expect(out).toContain('You lead.\\u202eevil\\u200b')
    expect(out).toContain('hidden characters')
    expect(out).not.toContain('\x1b')
    expect(out).not.toContain('‮')
    expect(out).toContain('    Line two')
  })

  it('an unknown role is exit 2', async () => {
    const { f } = setup({})
    expect(await exitOf(runTeam(f.ctx, ['role', 'ghost']))).toBe(2)
  })

  it('JSON carries the whole role', async () => {
    const { f } = setup({}, { format: 'json' })
    expect(await runTeam(f.ctx, ['role', 'dev'])).toBe(0)
    expect(JSON.parse(f.out())).toMatchObject({ role: { id: 'dev', prompt: 'You build.' }, promptHasHiddenCharacters: false })
  })
})

describe('team plugins', () => {
  it('lists', async () => {
    const { f } = setup({})
    expect(await runTeam(f.ctx, ['plugins'])).toBe(0)
    expect(f.out()).toContain('plg1  fmt · /plugins/fmt')
  })

  it('add resolves a relative path and sends the PluginSpec', async () => {
    const { f, client } = setup({ 'plugins:upsert': (p) => ({ ...P, plugins: [(p as [{ plugin: unknown }])[0].plugin] }) })
    expect(await runTeam(f.ctx, ['plugins', 'add', '--path', 'tools/fmt', '--name', 'Formatter', '--skip-mcp', '--disabled'])).toBe(0)
    const input = (client.callsOf('plugins:upsert')[0] as [{ projectId: string; plugin: Record<string, unknown> }])[0]
    expect(input.projectId).toBe('p1')
    expect(input.plugin).toMatchObject({ name: 'Formatter', path: resolve('/work/tools/fmt'), enabled: false, skipMcpDiscovery: true })
    expect(String(input.plugin.id)).toMatch(/^plugin_/)
  })

  it('add passes a host refusal through', async () => {
    const { f } = setup({ 'plugins:upsert': () => Promise.reject(rpcError({ code: 'bad_request', message: 'No plugin manifest found: expected .claude-plugin/plugin.json in that folder.' })) })
    await expect(runTeam(f.ctx, ['plugins', 'add', '/x'])).rejects.toMatchObject({ exitCode: 2, message: expect.stringContaining('No plugin manifest') })
  })

  it('remove needs --yes without a terminal, then sends the id', async () => {
    let s = setup({ 'plugins:remove': () => ({ ...P, plugins: [] }) })
    expect(await exitOf(runTeam(s.f.ctx, ['plugins', 'remove', 'plg1']))).toBe(2)
    s = setup({ 'plugins:remove': () => ({ ...P, plugins: [] }) })
    expect(await runTeam(s.f.ctx, ['plugins', 'remove', 'plg1', '--yes'])).toBe(0)
    expect(s.client.callsOf('plugins:remove')).toEqual([[{ projectId: 'p1', pluginId: 'plg1' }]])
  })
})

describe('team files (cli-parity 3.4)', () => {
  const pending = {
    projectId: 'p1',
    projectName: 'App',
    state: 'pending',
    digest: 'ab'.repeat(32),
    isGitRepo: true,
    uncommitted: true,
    uncommittedFiles: ['.orgai/team.json'],
    changes: [{ id: 'role:lead:staffing', kind: 'role', name: 'Lead', file: '.orgai/team.json', action: 'changed', summary: 'Lead may use the deep tier.', needsApproval: true, reason: 'May spend more' }],
    applied: [],
    problems: [],
    notes: [],
    warnings: []
  }

  it('status (bare and status) lists the pending changes with read scope only, and says where approving is done', async () => {
    for (const args of [['files'], ['files', 'status']]) {
      const { f, client } = setup({ 'teamFiles:listAttention': () => [pending] })
      expect(await runTeam(f.ctx, args)).toBe(0)
      expect(f.connectCalls[0].scopes).toEqual(['read'])
      expect(client.callsOf('teamFiles:listAttention')).toHaveLength(1)
      expect(f.out()).toContain('App: 1 change waits for approval')
      expect(f.out()).toContain('- May spend more: Lead may use the deep tier.')
      expect(f.out()).toContain('done in the OrgAI desktop app for now')
    }
  })

  it('status --output-format json carries every status; nothing pending says so', async () => {
    const { f } = setup({ 'teamFiles:listAttention': () => [pending] }, { format: 'json' })
    expect(await runTeam(f.ctx, ['files', 'status'])).toBe(0)
    const j = JSON.parse(f.out())
    expect(j.teamFiles[0].digest).toBe('ab'.repeat(32))
    expect(j.approve).toMatch(/desktop app/)
    const empty = setup({ 'teamFiles:listAttention': () => [] })
    expect(await runTeam(empty.f.ctx, ['files'])).toBe(0)
    expect(empty.f.out()).toContain('No team-file changes wait for approval.')
  })

  it('approve / reject / undo / commit / enable decide nothing: exit 2 naming the desktop app, no host started, --yes or not', async () => {
    for (const sub of ['approve', 'reject', 'undo', 'commit', 'enable']) {
      for (const extra of [[], ['--yes'], ['p1', '--output-format', 'json']]) {
        const { f, client } = setup({})
        let err: unknown
        try {
          await runTeam(f.ctx, ['files', sub, ...extra])
        } catch (e) {
          err = e
        }
        expect(err, sub).toBeInstanceOf(CliError)
        expect((err as CliError).exitCode).toBe(2)
        expect((err as CliError).message).toMatch(/desktop app/)
        expect(f.inprocCalls, sub).toHaveLength(0)
        expect(client.calls, sub).toEqual([])
      }
    }
  })
})
