import { afterEach, describe, expect, it } from 'vitest'
import type { ConnectionInfo, HostScope, Project, ProviderModel, Role } from '../../shared/types'
import { manageDeps } from '../manage'
import { fakeContext, FakeHostClient, project, type FakeContextOptions } from '../testing/fakeContext'
import { CliError, EXIT } from '../types'
import { runTeam } from './team'
import { applyRoleEdits, chartProblem, listArg, roleEditDeps, spendSentences, type ModelEnv } from './teamRoleEdit'

const ALL: { grantedScopes: HostScope[] } = { grantedScopes: ['read', 'operate', 'decide', 'configure'] }
const realDeps = { ...manageDeps }
const realEdit = { ...roleEditDeps }
afterEach(() => {
  Object.assign(manageDeps, realDeps)
  Object.assign(roleEditDeps, realEdit)
})

const PROXY = 'proxy-0123abcd'
const TIERS = { top: 'claude-fable-5', deep: 'claude-opus-5', everyday: 'claude-sonnet-5', fast: 'claude-haiku-5' }
const model = (id: string, connection: string): ProviderModel => ({ id, label: id, connection, family: connection === PROXY ? 'openai' : 'claude', adapter: connection === PROXY ? 'codex' : 'claude' }) as ProviderModel
const CONNECTIONS = [
  { connection: { id: 'anthropic', tierModels: TIERS }, status: { state: 'connected' }, modelCount: 5 },
  { connection: { id: PROXY, name: 'Gateway', tierModels: { everyday: 'gw-mid', fast: 'gw-small' } }, status: { state: 'connected' }, modelCount: 2 }
] as unknown as ConnectionInfo[]
const CATALOG = [...Object.values(TIERS).map((id) => model(id, 'anthropic')), model('claude-legacy-1', 'anthropic'), model('gw-mid', PROXY), model('gw-small', PROXY)]
const ENV: ModelEnv = { connections: CONNECTIONS, catalog: CATALOG }

const role = (over: Partial<Role> & Pick<Role, 'id'>): Role => ({
  slug: over.id,
  name: over.id[0].toUpperCase() + over.id.slice(1),
  description: '',
  responsibilities: [],
  prompt: `You are ${over.id}.`,
  tools: ['Read'],
  model: TIERS.everyday,
  tier: 'everyday',
  effort: 'medium',
  canSpawn: false,
  spawnable: [],
  reportsTo: 'lead',
  position: { x: 0, y: 0 },
  color: '#000',
  ...over
})
const lead = role({ id: 'lead', model: TIERS.deep, tier: 'deep', canSpawn: true, spawnable: ['dev', 'qa'], requiredReports: ['qa'], reportsTo: null, tools: ['Read', 'Edit'] })
const dev = role({ id: 'dev', canSpawn: true, spawnable: ['intern'] })
const qa = role({ id: 'qa', effort: 'low', staffing: { mode: 'fixed' } })
const intern = role({ id: 'intern', reportsTo: 'dev', model: TIERS.fast, tier: 'fast' })
const P = project('p1', '/work', {
  name: 'App',
  provider: { id: 'claude', label: 'Claude', auth: { mode: 'subscription' }, connection: 'anthropic' },
  roles: [lead, dev, qa, intern],
  mcpServers: [{ id: 'mcp_gh', name: 'github', transport: 'stdio', enabled: true, source: 'user', addedAt: 'x' }]
} as unknown as Partial<Project>)

function setup(o: FakeContextOptions & { project?: Project } = {}) {
  const proj = o.project ?? P
  const client = new FakeHostClient(
    {
      'projects:list': () => [proj],
      'projects:get': () => structuredClone(proj),
      'projects:save': (p) => (p as [Project])[0],
      'connections:list': () => CONNECTIONS,
      'models:list': () => CATALOG
    },
    { hello: ALL }
  )
  const f = fakeContext({ connect: [client], cwd: '/work', ...o })
  return { f, client }
}

async function run(args: string[], o: FakeContextOptions & { project?: Project } = {}) {
  const s = setup(o)
  let code: number
  let err = ''
  try {
    code = await runTeam(s.f.ctx, ['role', ...args])
  } catch (e) {
    if (!(e instanceof CliError)) throw e
    code = e.exitCode
    err = e.message
  }
  const saves = s.client.callsOf('projects:save') as [Project][]
  const savedRoles = saves.length ? saves[0][0].roles : null
  return { code, out: s.f.out(), err: `${s.f.err()}${err}`, saves: saves.length, savedRoles, roleOf: (id: string) => savedRoles?.find((r) => r.id === id), client: s.client }
}

describe('team role set', () => {
  it('sets every flag on a role and saves the whole project once', async () => {
    const r = await run([
      'set', 'dev',
      '--name', 'Backend Dev', '--description', 'Builds the API', '--prompt', 'Build it.',
      '--model', 'fast', '--effort', 'low', '--staffing', 'auto', '--min-tier', 'fast', '--max-effort', 'low',
      '--tools', 'Read,grep', '--add-tool', 'Bash', '--rm-tool', 'Grep',
      '--can-spawn', 'on', '--spawnable', 'intern', '--required-reports', 'intern', '--connection', 'inherit', '--mcp', 'github', '--yes'
    ])
    expect(r.err).toBe('')
    expect(r.code).toBe(0)
    expect(r.saves).toBe(1)
    expect(r.roleOf('dev')).toMatchObject({
      name: 'Backend Dev',
      slug: 'backend-dev',
      description: 'Builds the API',
      prompt: 'Build it.',
      model: TIERS.fast,
      tier: 'fast',
      effort: 'low',
      staffing: { mode: 'auto', minTier: 'fast', maxEffort: 'low' },
      tools: ['Read', 'Bash'],
      canSpawn: true,
      spawnable: ['intern'],
      requiredReports: ['intern'],
      mcpServers: ['mcp_gh']
    })
    expect(r.out).toContain('Saved Backend Dev [backend-dev].')
    expect(r.out).toContain('model: claude-sonnet-5 (everyday) -> claude-haiku-5 (fast)')
    expect(r.out).toContain('effort: medium -> low')
  })

  it('JSON returns the role before and after', async () => {
    const r = await run(['set', 'qa', '--effort', 'none', '--yes'], { globals: { outputFormat: 'json' } })
    expect(r.err).toBe('')
    expect(r.code).toBe(0)
    const doc = JSON.parse(r.out)
    expect(doc.role.before).toMatchObject({ id: 'qa', effort: 'low' })
    expect(doc.role.after.effort).toBeUndefined()
    expect(doc.spend).toEqual(["Qa's reasoning effort is removed, so it runs at the default effort (medium) instead of low. This may spend more."])
  })

  it('a raise needs --yes without a terminal and says why (the team files gate sentences); lowering never asks', async () => {
    let r = await run(['set', 'dev', '--effort', 'xhigh'])
    expect(r.code).toBe(EXIT.usage)
    expect(r.saves).toBe(0)
    expect(r.err).toContain("May spend more: Dev's reasoning effort is raised and may spend more.")
    expect(r.err).toContain('--yes')
    r = await run(['set', 'dev', '--effort', 'xhigh', '--yes'])
    expect(r.code).toBe(0)
    expect(r.roleOf('dev')?.effort).toBe('xhigh')
    r = await run(['set', 'dev', '--model', 'top'])
    expect(r.err).toContain("Dev's model changes and may spend more.")
    // Automatic with its own effort (low) as the ceiling spends no more; a raised ceiling does.
    r = await run(['set', 'qa', '--staffing', 'auto'])
    expect(r.code).toBe(0)
    r = await run(['set', 'qa', '--staffing', 'auto', '--max-effort', 'high'])
    expect(r.code).toBe(EXIT.usage)
    expect(r.err).toMatch(/Qa becomes automatic and may be picked up to high effort \(it ran at low\)/)
    r = await run(['set', 'qa', '--can-spawn', 'on'])
    expect(r.err).toContain('Qa may create subagents, which may spend more.')
    r = await run(['set', 'dev', '--connection', PROXY])
    expect(r.err).toContain(`Dev runs on Gateway instead of`)
    // Automatic to fixed may spend more (a fixed role always runs at its configured tier), as in the team files gate.
    r = await run(['set', 'dev', '--staffing', 'fixed'])
    expect(r.err).toContain('Dev becomes fixed')
    // Lowering: no question.
    for (const args of [['set', 'dev', '--effort', 'low'], ['set', 'dev', '--model', 'fast'], ['set', 'dev', '--max-effort', 'low'], ['set', 'dev', '--can-spawn', 'off']]) {
      r = await run(args)
      expect(r.code, args.join(' ')).toBe(0)
    }
  })

  it('at a terminal the spend question is asked; no = nothing saved', async () => {
    let asked = ''
    manageDeps.ttyConfirm = async (q: string) => ((asked = q), false)
    const r = await run(['set', 'dev', '--effort', 'max'], { stdinIsTTY: true })
    expect(r.code).toBe(EXIT.failure)
    expect(asked).toContain('May spend more')
    expect(r.saves).toBe(0)
  })

  it('a connection change moves a tier role to that tier on the new connection, and inherit returns', async () => {
    const r = await run(['set', 'dev', '--connection', PROXY, '--yes'])
    expect(r.code).toBe(0)
    expect(r.roleOf('dev')).toMatchObject({ connection: PROXY, model: 'gw-mid', tier: 'everyday' })
    const back = await run(['set', 'dev', '--connection', 'inherit'], { project: { ...P, roles: [lead, { ...dev, connection: PROXY, model: 'gw-mid' }, qa, intern] } })
    expect(back.code).toBe(0)
    expect(back.roleOf('dev')?.connection).toBeUndefined()
    expect(back.roleOf('dev')?.model).toBe(TIERS.everyday)
  })

  it('refuses with errors naming the flag, and saves nothing', async () => {
    const cases: [string[], string][] = [
      [['set', 'ghost', '--effort', 'low'], 'no role "ghost"'],
      [['set', 'dev'], 'Nothing to change'],
      [['set', 'dev', '--model', 'gpt-9'], '--model: gpt-9 is not in the model catalog'],
      [['set', 'dev', '--model', '--x'], '--model: give a tier'],
      [['set', 'dev', '--spawnable', 'qa'], '--spawnable: Qa does not report to Dev'],
      [['set', 'dev', '--required-reports', 'intern', '--spawnable', 'none'], "--required-reports: Intern not in Dev's spawnable list"],
      [['set', 'dev', '--tools', 'Read,Teleport'], '--tools: unknown tool "Teleport"'],
      [['set', 'dev', '--rm-tool', 'Bash'], '--rm-tool: Dev does not have Bash'],
      [['set', 'dev', '--name', 'QA'], '--name: the slug "qa" is taken by Qa'],
      [['set', 'lead', '--connection', PROXY], "--connection: Lead is the top of the chart"],
      [['set', 'lead', '--staffing', 'auto'], '--staffing: Lead is the top of the chart'],
      [['set', 'dev', '--min-tier', 'top'], "--min-tier: top is above Dev's own tier (everyday)"],
      [['set', 'dev', '--staffing', 'fixed', '--max-effort', 'low'], '--min-tier and --max-effort apply to automatic staffing'],
      [['set', 'dev', '--model', 'claude-legacy-1', '--staffing', 'auto'], 'runs on an exact model'],
      [['set', 'dev', '--connection', 'proxy-ffffffff'], 'is not a connection on this computer'],
      [['set', 'dev', '--mcp', 'slack'], '--mcp: no MCP server "slack"'],
      [['set', 'dev', '--effort', 'huge'], '--effort must be'],
      [['set', 'dev', '--can-spawn', 'yes'], '--can-spawn must be on or off'],
      [['set', 'dev', '--prompt', 'x', '--prompt-file', '/p'], 'Give the prompt one way'],
      [['set', 'dev', '--edit'], '--edit opens your editor and needs an interactive terminal']
    ]
    for (const [args, msg] of cases) {
      const r = await run(args)
      expect(r.code, args.join(' ')).toBe(EXIT.usage)
      expect(r.err, args.join(' ')).toContain(msg)
      expect(r.saves).toBe(0)
    }
  })

  it('--force accepts a model id outside the catalog (an exact model: no tier)', async () => {
    const r = await run(['set', 'intern', '--model', 'claude-next-1', '--force', '--yes'])
    expect(r.code).toBe(0)
    expect(r.roleOf('intern')).toMatchObject({ model: 'claude-next-1' })
    expect(r.roleOf('intern')?.tier).toBeUndefined()
  })

  it('--edit opens the editor on the current prompt at an interactive terminal', async () => {
    let given = ''
    roleEditDeps.editText = async (_ctx, initial) => ((given = initial), 'Edited prompt.')
    const s = setup({ stdinIsTTY: true })
    ;(s.f.ctx.io.stdout as { isTTY?: boolean }).isTTY = true
    expect(await runTeam(s.f.ctx, ['role', 'set', 'dev', '--edit'])).toBe(0)
    expect(given).toBe('You are dev.')
    expect((s.client.callsOf('projects:save')[0] as [Project])[0].roles.find((r) => r.id === 'dev')?.prompt).toBe('Edited prompt.')
  })
})

describe('team role add', () => {
  it('adds the desktop default role under the manager (everyday, read-only tools) with no question', async () => {
    const r = await run(['add', 'Docs Writer', '--reports-to', 'qa', '--yes'])
    expect(r.code).toBe(0)
    const added = r.savedRoles?.find((x) => x.slug === 'docs-writer')
    expect(added).toMatchObject({ name: 'Docs Writer', model: TIERS.everyday, tier: 'everyday', tools: ['Read', 'Glob', 'Grep'], reportsTo: 'qa', canSpawn: false })
    // The manager may now spawn it (TeamView addRole), which is a spawning switch: it was asked (--yes) and said.
    expect(r.roleOf('qa')).toMatchObject({ canSpawn: true, spawnable: [added!.id] })
    expect(r.out).toContain('Qa can now create subagents, because Docs Writer reports to it.')
  })

  it('without --yes, a manager that starts spawning is a raise (exit 2); under a spawning manager no question', async () => {
    let r = await run(['add', 'Docs Writer', '--reports-to', 'qa'])
    expect(r.code).toBe(EXIT.usage)
    expect(r.err).toContain('Qa may create subagents')
    r = await run(['add', 'Docs Writer', '--reports-to', 'lead'])
    expect(r.code).toBe(0)
    r = await run(['add', 'Docs Writer', '--reports-to', 'lead', '--model', 'top'])
    expect(r.code).toBe(EXIT.usage)
    expect(r.err).toContain("Docs Writer's model changes and may spend more.")
  })

  it('JSON has before null and the new role; needs --reports-to; refuses a taken slug', async () => {
    const j = await run(['add', 'Docs', '--reports-to', 'lead', '--effort', 'low', '--yes'], { globals: { outputFormat: 'json' } })
    expect(j.err).toBe('')
    expect(j.code).toBe(0)
    const doc = JSON.parse(j.out)
    expect(doc.role.before).toBeNull()
    expect(doc.role.after).toMatchObject({ name: 'Docs', effort: 'low', reportsTo: 'lead' })
    expect((await run(['add', 'Docs'])).err).toContain('--reports-to')
    expect((await run(['add', 'Dev', '--reports-to', 'lead'])).err).toContain('the slug "dev" is taken')
    expect((await run(['add', 'X', '--reports-to', 'ghost'])).err).toContain('--reports-to: no role "ghost"')
  })
})

describe('team role move', () => {
  it('moves under a new manager: the old one stops spawning it, the new one may (asked when it starts spawning)', async () => {
    let r = await run(['move', 'qa', '--reports-to', 'dev'])
    expect(r.code).toBe(0)
    expect(r.roleOf('qa')?.reportsTo).toBe('dev')
    expect(r.roleOf('lead')).toMatchObject({ spawnable: ['dev'] })
    expect(r.roleOf('lead')?.requiredReports).toBeUndefined()
    expect(r.roleOf('dev')?.spawnable).toEqual(['intern', 'qa'])
    r = await run(['move', 'intern', '--reports-to', 'qa'])
    expect(r.code).toBe(EXIT.usage)
    expect(r.err).toContain('Qa may create subagents')
  })

  it('refuses the root, a loop and an unknown manager', async () => {
    expect((await run(['move', 'lead', '--reports-to', 'dev'])).err).toContain('top of the chart')
    expect((await run(['move', 'dev', '--reports-to', 'intern'])).err).toContain('that would make a loop')
    expect((await run(['move', 'dev', '--reports-to', 'ghost'])).err).toContain('--reports-to: no role "ghost"')
    expect((await run(['move', 'dev'])).err).toContain('--reports-to')
  })
})

describe('team role rm', () => {
  it('refuses the root, and a role with reports unless --reparent-to', async () => {
    expect((await run(['rm', 'lead', '--yes'])).err).toContain('cannot be removed')
    const r = await run(['rm', 'dev', '--yes'])
    expect(r.code).toBe(EXIT.usage)
    expect(r.err).toContain('Intern reports to Dev; give --reparent-to')
    expect((await run(['rm', 'dev', '--reparent-to', 'intern', '--yes'])).err).toContain('--reparent-to: Intern is Dev or one of its reports')
  })

  it('needs --yes without a terminal; removes, reparents and cleans references; JSON carries previousRoles', async () => {
    expect((await run(['rm', 'qa'])).code).toBe(EXIT.usage)
    const r = await run(['rm', 'dev', '--reparent-to', 'lead', '--yes'], { globals: { outputFormat: 'json' } })
    expect(r.code).toBe(0)
    expect(r.savedRoles?.map((x) => x.id)).toEqual(['lead', 'qa', 'intern'])
    expect(r.roleOf('intern')?.reportsTo).toBe('lead')
    expect(r.roleOf('lead')?.spawnable).toEqual(['qa', 'intern'])
    const doc = JSON.parse(r.out)
    expect(doc).toMatchObject({ removed: { id: 'dev' }, reparentedTo: 'lead', moved: ['intern'], roles: 3 })
    expect(doc.previousRoles.map((x: Role) => x.id)).toEqual(['lead', 'dev', 'qa', 'intern'])
    const q = await run(['rm', 'qa', '--yes'])
    expect(q.roleOf('lead')).toMatchObject({ spawnable: ['dev'] })
    expect(q.roleOf('lead')?.requiredReports).toBeUndefined()
  })
})

describe('team role show', () => {
  it('names effort, staffing in words and the connection it runs on', async () => {
    const pinned = { ...dev, connection: PROXY, model: 'gw-mid', staffing: { mode: 'auto' as const, minTier: 'fast' as const, maxEffort: 'high' as const } }
    const r = await run(['dev'], { project: { ...P, roles: [lead, pinned, qa, intern] } })
    expect(r.code).toBe(0)
    expect(r.out).toContain('  effort: medium')
    expect(r.out).toContain('  staffing: automatic, from fast up to everyday, at most high effort')
    expect(r.out).toContain('  runs on: Gateway (pinned; the project runs on')
    const q = await run(['show', 'qa'])
    expect(q.out).toContain('  staffing: always as configured: everyday at low effort')
    expect(q.out).toContain("(the project's connection)")
    const l = await run(['lead'])
    expect(l.out).toContain('(the top of the chart)')
  })
})

describe('pure helpers', () => {
  it('listArg splits commas; none and empty are []', () => {
    expect(listArg(' a, b,,c ')).toEqual(['a', 'b', 'c'])
    expect(listArg('none')).toEqual([])
    expect(listArg('')).toEqual([])
  })

  it('chartProblem: one root, no loop, known managers, unique slugs for touched roles', () => {
    expect(chartProblem([lead, dev, qa, intern], '--x')).toBeNull()
    expect(chartProblem([lead, { ...dev, reportsTo: null }], '--x')).toContain('exactly one top role')
    expect(chartProblem([lead, { ...dev, reportsTo: 'intern' }, intern], '--x')).toContain('loop')
    expect(chartProblem([lead, { ...dev, reportsTo: 'ghost' }], '--x')).toContain('not in the chart')
    expect(chartProblem([lead, dev, { ...qa, slug: 'dev' }], '--x', new Set(['qa']))).toContain('share the slug')
    expect(chartProblem([lead, dev, { ...qa, slug: 'dev' }], '--x', new Set(['intern']))).toBeNull()
  })

  it('spendSentences: lowering says nothing; staffing to automatic, a new connection and spawning say why', () => {
    const lower = { ...dev, effort: 'low' as const, model: TIERS.fast, tier: 'fast' as const }
    expect(spendSentences(P, [dev], [lower])).toEqual([])
    const s = spendSentences(P, [qa], [{ ...qa, staffing: { mode: 'auto', maxEffort: 'high' }, connection: PROXY, canSpawn: true }], undefined, (id) => (id === PROXY ? 'Gateway' : 'Anthropic'))
    expect(s.join(' ')).toMatch(/Qa becomes automatic.*This may spend more\./)
    expect(s).toContain('Qa runs on Gateway instead of Anthropic, with its models and prices. This may spend more.')
    expect(s).toContain('Qa may create subagents, which may spend more.')
    // The project set to always-as-configured: switching a role to automatic changes nothing it may spend.
    expect(spendSentences({ ...P, staffing: 'fixed' }, [qa], [{ ...qa, staffing: { mode: 'auto' } }])).toEqual([])
  })

  it('applyRoleEdits leaves the input role untouched', () => {
    const before = structuredClone(dev)
    applyRoleEdits(P, P.roles, dev, { effort: 'max', tools: 'Read' }, ENV)
    expect(dev).toEqual(before)
  })
})
