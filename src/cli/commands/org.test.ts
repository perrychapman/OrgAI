import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentImportItem, AgentImportPreview, CapabilityRecommendation, HostScope, Project, Role, TeamReview } from '../../shared/types'
import { manageDeps } from '../manage'
import { fakeContext, FakeHostClient, flush, project, rpcError, summary, record, type Answer } from '../testing/fakeContext'
import { CliError, EXIT } from '../types'
import * as interactive from './interactive'
import { applyDraftRoles, checkArg, parseDraftFile, roleTree, runOrg, spendNote } from './org'

const ALL: { grantedScopes: HostScope[] } = { grantedScopes: ['read', 'operate', 'decide', 'configure'] }
const realDeps = { ...manageDeps }
afterEach(() => {
  Object.assign(manageDeps, realDeps)
  vi.restoreAllMocks()
})

function role(id: string, extra: Partial<Role> = {}): Role {
  return {
    id,
    slug: id,
    name: id[0].toUpperCase() + id.slice(1),
    description: '',
    responsibilities: [],
    prompt: `You are ${id}.`,
    tools: ['Read'],
    model: 'sonnet',
    tier: 'everyday',
    canSpawn: false,
    spawnable: [],
    reportsTo: null,
    position: { x: 0, y: 0 },
    color: '#000',
    ...extra
  }
}

const roles = [
  role('lead', { canSpawn: true, spawnable: ['dev'], tier: 'deep', model: 'opus', mcpServers: ['mcp1'], skills: ['sk1'] }),
  role('dev', { reportsTo: 'lead', name: 'Dev\x1b[31mRED\x1b]0;pwn\x07', tools: ['Read', 'Edit', 'Bash'] }),
  role('qa', { reportsTo: 'dev' })
]
const P = project('p1', '/work', {
  name: 'App',
  roles,
  mcpServers: [{ id: 'mcp1', name: 'github', transport: 'stdio', command: 'x', args: [], enabled: true, roles: [] } as never],
  skills: [{ id: 'sk1', name: 'code-review', description: 'd' } as never]
} as Partial<Project>)

function setup(answers: Record<string, Answer>, opts: { tty?: boolean; format?: 'text' | 'json'; project?: Project; clients?: number } = {}) {
  const proj = opts.project ?? P
  const make = (): FakeHostClient => new FakeHostClient({ 'projects:list': () => [proj], 'projects:get': () => proj, ...answers }, { hello: ALL })
  const clients = Array.from({ length: opts.clients ?? 1 }, make)
  const f = fakeContext({ connect: clients, cwd: '/work', stdinIsTTY: !!opts.tty, globals: { outputFormat: opts.format ?? 'text' } })
  if (opts.tty) f.ctx.io.stdout.isTTY = true
  return { f, client: clients[0], clients }
}

async function exitOf(p: Promise<number>): Promise<number> {
  try {
    return await p
  } catch (e) {
    if (e instanceof CliError) return e.exitCode
    throw e
  }
}

describe('checkArg', () => {
  it('refuses empty, long and control-character arguments', () => {
    expect(() => checkArg('id', '')).toThrow(/Missing/)
    expect(() => checkArg('id', 'x'.repeat(201))).toThrow(/200/)
    expect(() => checkArg('id', 'a\x1bb')).toThrow(/control/)
    expect(checkArg('id', 'ok-1')).toBe('ok-1')
  })
})

describe('org show', () => {
  it('renders the reporting tree with grants and limits, sanitizing role names', async () => {
    const { f } = setup({})
    expect(await runOrg(f.ctx, ['show'])).toBe(0)
    const out = f.out()
    expect(out).not.toContain('\x1b')
    expect(out).toContain('  Lead [lead] · deep')
    expect(out).toMatch(/\n {4}DevRED.*\[dev\] · everyday/)
    expect(out).toMatch(/\n {6}Qa \[qa\]/)
    expect(out).toContain('spawns: DevRED')
    expect(out).toContain('MCP: github · skills: code-review')
    expect(out).toContain('Subagent limits: depth 3 (automatic), 8 at once (automatic)')
  })

  it('JSON keeps the model id and depth', async () => {
    const { f } = setup({}, { format: 'json' })
    expect(await runOrg(f.ctx, ['show'])).toBe(0)
    const v = JSON.parse(f.out())
    expect(v.roles.map((r: { id: string; depth: number }) => [r.id, r.depth])).toEqual([['lead', 0], ['dev', 1], ['qa', 2]])
    expect(v.roles[0]).toMatchObject({ model: 'opus', tier: 'deep', mcpServers: ['mcp1'], skills: ['sk1'] })
  })

  it('roleTree survives a cycle', () => {
    const cyc = [role('a', { reportsTo: 'b' }), role('b', { reportsTo: 'a' })]
    expect(roleTree(cyc).map((r) => r.role.id).sort()).toEqual(['a', 'b'])
  })
})

describe('org import', () => {
  const item = (extra: Partial<AgentImportItem> = {}): AgentImportItem => ({
    key: 'claude:.claude/agents/x.md#x',
    roleId: 'r-x',
    name: 'X',
    slug: 'x',
    source: 'claude',
    file: '.claude/agents/x.md',
    description: '',
    model: 'sonnet',
    modelReason: 'kept',
    tools: ['Read', 'Bash'],
    toolsDropped: [],
    canSpawn: false,
    reportsTo: null,
    promptExcerpt: 'Do \x1b[2Jthings',
    promptLength: 10,
    prompt: 'Do things',
    elevatedTools: ['Bash'],
    action: 'add',
    slugConflict: false,
    notes: [],
    ...extra
  })
  const preview = (extra: Partial<AgentImportPreview> = {}): AgentImportPreview => ({
    mode: 'merge',
    roles,
    items: [item()],
    replacedRoleIds: [],
    warnings: [],
    connection: 'anthropic',
    instructionFiles: [],
    digest: 'd'.repeat(64),
    ...extra
  })
  const scan = { sources: [{ source: 'claude', label: 'Claude Code', files: ['.claude/agents/x.md'], agentCount: 1 }], instructionFiles: [], warnings: [] }

  it('previews, confirms with --yes and applies with the digest', async () => {
    const { f, client } = setup({
      'projects:scanAgents': () => scan,
      'projects:previewImport': () => preview(),
      'projects:applyImport': () => ({ project: { ...P, roles: [...roles, role('x')] }, previousRoles: roles })
    })
    expect(await runOrg(f.ctx, ['import', '--yes'])).toBe(0)
    expect(client.callsOf('projects:scanAgents')).toEqual([['/work']])
    expect(client.callsOf('projects:previewImport')).toEqual([[{ projectId: 'p1', mode: 'merge' }]])
    expect(client.callsOf('projects:applyImport')).toEqual([[{ projectId: 'p1', mode: 'merge', digest: 'd'.repeat(64) }]])
    expect(f.out()).toContain('elevated: Bash')
    expect(f.out()).not.toContain('\x1b')
    expect(f.out()).not.toContain('Desktop Team tab') // the Desktop cannot undo a CLI import
    expect(f.out()).not.toContain('cannot be undone') // a merge that drops or replaces nothing
  })

  it('a replacing import says it cannot be undone and --json keeps the previous chart', async () => {
    let asked = ''
    manageDeps.ttyConfirm = async (q) => ((asked = q), true)
    const { f } = setup(
      {
        'projects:scanAgents': () => scan,
        'projects:previewImport': () => preview({ mode: 'replace', replacedRoleIds: ['lead'] }),
        'projects:applyImport': () => ({ project: { ...P, roles: [role('x')] }, previousRoles: roles })
      },
      { tty: true }
    )
    expect(await runOrg(f.ctx, ['import', '--mode', 'replace'])).toBe(0)
    expect(asked).toContain('This cannot be undone.')
    expect(f.out()).toContain('This cannot be undone from the CLI')
    expect(f.out()).not.toContain('Desktop Team tab')
    const j = setup(
      {
        'projects:scanAgents': () => scan,
        'projects:previewImport': () => preview({ mode: 'replace', replacedRoleIds: ['lead'] }),
        'projects:applyImport': () => ({ project: { ...P, roles: [role('x')] }, previousRoles: roles })
      },
      { format: 'json' }
    )
    expect(await runOrg(j.f.ctx, ['import', '--mode', 'replace', '--yes'])).toBe(0)
    expect(JSON.parse(j.f.out()).previousRoles.map((r: { id: string }) => r.id)).toEqual(roles.map((r) => r.id))
  })

  it('without --yes and without a terminal it refuses with exit 2 and applies nothing', async () => {
    const { f, client } = setup({ 'projects:scanAgents': () => scan, 'projects:previewImport': () => preview(), 'projects:applyImport': () => ({}) })
    expect(await exitOf(runOrg(f.ctx, ['import']))).toBe(EXIT.usage)
    expect(client.callsOf('projects:applyImport')).toEqual([])
  })

  it('replacements need the confirmation even with sources chosen', async () => {
    let asked = ''
    manageDeps.ttyConfirm = async (q) => ((asked = q), false)
    const { f, client } = setup(
      { 'projects:scanAgents': () => scan, 'projects:previewImport': () => preview({ replacedRoleIds: ['lead'] }), 'projects:applyImport': () => ({}) },
      { tty: true }
    )
    expect(await exitOf(runOrg(f.ctx, ['import', '--source', 'claude', '--mode', 'replace']))).toBe(1)
    expect(asked).toContain('drop or replace 1 existing role')
    expect(client.callsOf('projects:previewImport')).toEqual([[{ projectId: 'p1', mode: 'replace', sources: ['claude'] }]])
    expect(client.callsOf('projects:applyImport')).toEqual([])
  })

  it('a stale digest is exit 1 with the re-run sentence', async () => {
    const { f } = setup({
      'projects:scanAgents': () => scan,
      'projects:previewImport': () => preview(),
      'projects:applyImport': () => Promise.reject(rpcError({ code: 'bad_request', message: 'The agent definitions in the folder changed since the preview. Review the import again.' }))
    })
    await expect(runOrg(f.ctx, ['import', '--yes'])).rejects.toMatchObject({ exitCode: 1, message: 'The folder changed since the preview; run it again.' })
  })

  it('refuses an unknown source with exit 2 before connecting', async () => {
    const { f } = setup({})
    expect(await exitOf(runOrg(f.ctx, ['import', '--source', 'nope']))).toBe(2)
    expect(f.connectCalls).toEqual([])
  })
})

describe('org retro', () => {
  const work = summary('run_work_1', { projectId: 'p1', kind: 'work', status: 'finished' })
  const base = (s = work): Record<string, Answer> => ({
    'runs:list': () => [s],
    'runs:get': () => record(s)
  })

  it('refuses a run of a virtual project with exit 2', async () => {
    const quick = summary('run_quick_1', { projectId: 'quick', kind: 'work', quick: true } as never)
    const { f } = setup(base(quick))
    expect(await exitOf(runOrg(f.ctx, ['retro', 'run_quick_1']))).toBe(2)
  })

  it('refuses a non-work run with exit 2', async () => {
    const setupRun = summary('run_setup_1', { projectId: 'p1', kind: 'setup' })
    const { f } = setup(base(setupRun))
    expect(await exitOf(runOrg(f.ctx, ['retro', 'R1']))).toBe(2)
  })

  it('without a terminal (or with --output-format json) it is refused: the run lives only inside this orgai (exit 2), and --no-attach is gone', async () => {
    const { f } = setup(base())
    const spy = vi.spyOn(interactive, 'runInteractiveRun')
    expect(await exitOf(runOrg(f.ctx, ['retro', 'R1']))).toBe(2)
    expect(await exitOf(runOrg(f.ctx, ['retro', 'R1', '--no-attach']))).toBe(2)
    expect(spy).not.toHaveBeenCalled()
  })

  it('with a terminal it hands the run to runInteractiveRun', async () => {
    const { f } = setup(base(), { tty: true })
    const spy = vi.spyOn(interactive, 'runInteractiveRun').mockResolvedValue(0)
    expect(await runOrg(f.ctx, ['retro', 'R1'])).toBe(0)
    expect(spy.mock.calls[0][1]).toMatchObject({ channel: 'setup:retro', input: { projectId: 'p1', runId: 'run_work_1' }, label: 'Org retrospective' })
  })
})

describe('Team assistant', () => {
  const rec: CapabilityRecommendation = { id: 'rec-1', candidateId: 'cap-1', kind: 'skill', roleIds: ['dev'], reason: 'Tests \x1b[1mbold', access: 'read' }
  const discovery = {
    projectId: 'p1',
    items: [{ id: 'cap-1', kind: 'skill', origin: 'repo', source: 'repo-skills', sourceLabel: 'This repository', name: 'tester', description: '', flags: [], needsSecrets: [], notes: [], target: 'npx -y\x1b]0;x\x07 pkg@1' }],
    sources: [],
    warnings: [],
    includeOutside: false,
    digest: 'a'.repeat(64),
    createdAt: 'now'
  }
  const review: TeamReview = {
    projectId: 'p1',
    checkedAt: '2026-11-05T00:00:00Z',
    trigger: 'manual',
    mode: 'free',
    discovery: discovery as never,
    digest: 'a'.repeat(64),
    newCandidateIds: [],
    recommendations: [rec],
    gaps: [],
    evidence: [],
    dismissed: [],
    pendingCount: 1,
    runsSinceModel: 0
  }

  it('discover streams capabilities:progress and cancels on interrupt with exit 130', async () => {
    let release!: (v: unknown) => void
    const { f, client } = setup({
      'host.subscribe': (p) => (p as [unknown])[0],
      'capabilities:discover': () => new Promise((r) => (release = r)),
      'capabilities:cancel': () => undefined
    })
    const p = runOrg(f.ctx, ['discover'])
    await flush()
    const input = (client.callsOf('capabilities:discover')[0] as [{ requestId: string; includeOutside: boolean }])[0]
    expect(input.includeOutside).toBe(false)
    expect(client.callsOf('host.subscribe')).toEqual([[{ topics: ['capabilities'] }]])
    client.push('capabilities:progress', { projectId: 'p1', requestId: input.requestId, phase: 'repo-skills', state: 'done', count: 2, message: 'ok\x1b[2J' })
    client.push('capabilities:progress', { projectId: 'p1', requestId: 'other', phase: 'x', state: 'running' })
    f.signal('SIGINT')
    expect(await p).toBe(130)
    expect(client.callsOf('capabilities:cancel')).toEqual([[{ requestId: input.requestId }]])
    expect(f.err()).toContain('repo-skills done (2): ok')
    expect(f.err()).not.toContain('\x1b')
    expect(f.err()).not.toMatch(/^x running/m)
    release(discovery)
  })

  it('recommend prints ids, access and the sanitized target', async () => {
    const { f, client } = setup({
      'host.subscribe': () => ({}),
      'capabilities:recommend': () => ({ projectId: 'p1', scope: {}, discovery, recommendations: [rec], gaps: [], digest: 'a'.repeat(64), mode: 'fallback', fallbackReason: 'noCandidates', createdAt: 'now' })
    })
    expect(await runOrg(f.ctx, ['recommend', '--outside'])).toBe(0)
    expect((client.callsOf('capabilities:recommend')[0] as [{ includeOutside: boolean }])[0].includeOutside).toBe(true)
    expect(f.out()).toContain('rec-1  skill tester -> DevRED (read access)')
    expect(f.out()).toContain('target: npx -y pkg@1')
    expect(f.out()).not.toContain('\x1b')
  })

  it('apply sends the recommendation, its candidate, roles and digest; prints the undo id', async () => {
    const { f, client } = setup({
      'capabilities:lastReview': () => review,
      'capabilities:apply': () => ({ project: P, applied: { kind: 'skill', id: 'sk2', name: 'tester', action: 'added', roleIds: ['dev'], access: 'read' }, undoId: 'undo-9', notes: [] })
    })
    expect(await runOrg(f.ctx, ['apply', 'rec-1'])).toBe(0)
    expect(client.callsOf('capabilities:apply')).toEqual([[{ projectId: 'p1', digest: 'a'.repeat(64), roleIds: ['dev'], recommendationId: 'rec-1', candidateId: 'cap-1' }]])
    expect(f.out()).toContain('orgai org undo undo-9')
    expect(f.connectCalls[0].scopes).toEqual(['read', 'configure'])
  })

  it('apply with --role and --access overrides; a stale refusal is exit 1', async () => {
    const { f, client } = setup({
      'capabilities:lastReview': () => review,
      'capabilities:apply': () => Promise.reject(rpcError({ code: 'bad_request', message: 'The recommendations are out of date: what OrgAI found has changed since. Run them again.' }))
    })
    expect(await exitOf(runOrg(f.ctx, ['apply', 'rec-1', '--role', 'Lead', '--access', 'full']))).toBe(1)
    expect(client.callsOf('capabilities:apply')[0]).toEqual([{ projectId: 'p1', digest: 'a'.repeat(64), roleIds: ['lead'], recommendationId: 'rec-1', candidateId: 'cap-1', access: 'full' }])
  })

  it('undo, dismiss and restore payloads', async () => {
    let s = setup({ 'capabilities:undo': () => ({ project: P }) })
    expect(await runOrg(s.f.ctx, ['undo', 'undo-9'])).toBe(0)
    expect(s.client.callsOf('capabilities:undo')).toEqual([[{ projectId: 'p1', undoId: 'undo-9' }]])
    s = setup({ 'capabilities:dismiss': () => review })
    expect(await runOrg(s.f.ctx, ['dismiss', 'rec-1'])).toBe(0)
    expect(s.client.callsOf('capabilities:dismiss')).toEqual([[{ projectId: 'p1', recommendationId: 'rec-1' }]])
    s = setup({ 'capabilities:dismiss': () => review })
    expect(await runOrg(s.f.ctx, ['dismiss', 'cap-1', '--candidate'])).toBe(0)
    expect(s.client.callsOf('capabilities:dismiss')).toEqual([[{ projectId: 'p1', candidateId: 'cap-1' }]])
    s = setup({ 'capabilities:restore': () => review })
    expect(await runOrg(s.f.ctx, ['restore', 'cap-1'])).toBe(0)
    expect(s.client.callsOf('capabilities:restore')).toEqual([[{ projectId: 'p1', candidateId: 'cap-1' }]])
  })

  it('review shows the last review; --recheck runs a manual one', async () => {
    let s = setup({ 'capabilities:lastReview': () => review })
    expect(await runOrg(s.f.ctx, ['review'])).toBe(0)
    expect(s.f.out()).toContain('1 pending recommendation')
    s = setup({ 'host.subscribe': () => ({}), 'capabilities:review': () => review })
    expect(await runOrg(s.f.ctx, ['review', '--recheck', '--model'])).toBe(0)
    const input = (s.client.callsOf('capabilities:review')[0] as [Record<string, unknown>])[0]
    expect(input).toMatchObject({ projectId: 'p1', trigger: 'manual', includeOutside: false, useModel: true })
  })

  it('draft sends the instruction with a long timeout and prints the roles', async () => {
    const { f, client } = setup({ 'draft:orgChart': () => ({ roles: [role('arch')], rationale: 'Because' }) })
    const spy = vi.spyOn(client, 'call')
    expect(await runOrg(f.ctx, ['draft', 'a', 'small', 'team'])).toBe(0)
    const call = spy.mock.calls.find((c) => c[0] === 'draft:orgChart')!
    expect(call[1]).toEqual([{ projectId: 'p1', instruction: 'a small team', mode: 'revise' }])
    expect(((call as unknown[])[2] as { timeoutMs: number }).timeoutMs).toBeGreaterThanOrEqual(600_000)
    expect(f.out()).toContain('Arch [arch]')
  })
})

describe('org draft --apply and --from', () => {
  const drafted = [role('arch', { tier: 'top', model: 'opus' }), role('dev', { reportsTo: 'arch' })]
  const saveAnswer = (p: Project) => ({ 'projects:save': (a: unknown[]) => ({ ...p, ...(a[0] as object) }) }) as unknown as Record<string, Answer>
  const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'orgdraft-'))

  it('without --yes and without a terminal it previews and refuses (exit 2), saving nothing', async () => {
    const { f, client } = setup({ 'draft:orgChart': () => ({ roles: drafted, rationale: 'Why' }), ...saveAnswer(P) })
    expect(await exitOf(runOrg(f.ctx, ['draft', 'a', 'team', '--apply']))).toBe(2)
    expect(f.out()).toContain('Arch [arch]')
    expect(client.callsOf('projects:save')).toHaveLength(0)
  })

  it('--apply --yes saves the drafted chart, with previousRoles and the spend sentence in JSON', async () => {
    const { f, client } = setup({ 'draft:orgChart': () => ({ roles: drafted, rationale: '' }), ...saveAnswer(P) }, { format: 'json' })
    expect(await runOrg(f.ctx, ['draft', 'a', 'team', '--apply', '--yes'])).toBe(0)
    const saved = (client.callsOf('projects:save')[0] as [Project])[0]
    expect(saved.roles.map((r) => r.id)).toEqual(['arch', 'dev'])
    const out = JSON.parse(f.out())
    expect(out).toMatchObject({ applied: true, mode: 'replace', roles: 2, dropped: ['lead', 'qa'] })
    expect(out.previousRoles.map((r: Role) => r.id)).toEqual(['lead', 'dev', 'qa'])
    expect(out.spendNote).toMatch(/may spend more/)
  })

  it('--mode merge keeps the current roles', async () => {
    const { f, client } = setup({ 'draft:orgChart': () => ({ roles: [role('ops')], rationale: '' }), ...saveAnswer(P) })
    expect(await runOrg(f.ctx, ['draft', 'x', '--apply', '--yes', '--mode', 'merge'])).toBe(0)
    expect((client.callsOf('projects:save')[0] as [Project])[0].roles.map((r) => r.id)).toEqual(['lead', 'dev', 'qa', 'ops'])
  })

  it('--from reads a printed draft, never calls draft:orgChart and saves it', async () => {
    const dir = tmp()
    const file = path.join(dir, 'd.json')
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, project: {}, draft: { roles: drafted, rationale: 'r' } }))
    const { f, client } = setup(saveAnswer(P))
    expect(await runOrg(f.ctx, ['draft', '--from', file, '--apply', '--yes'])).toBe(0)
    expect(client.callsOf('draft:orgChart')).toHaveLength(0)
    expect(client.callsOf('projects:save')).toHaveLength(1)
    fs.rmSync(dir, { recursive: true })
  })

  it('--from refuses untrusted garbage and a missing --apply with exit 2', async () => {
    const dir = tmp()
    const file = path.join(dir, 'bad.json')
    fs.writeFileSync(file, JSON.stringify({ roles: [{ id: 'a\x1b', slug: 's', name: 'n' }] }))
    const { f, client } = setup(saveAnswer(P))
    expect(await exitOf(runOrg(f.ctx, ['draft', '--from', file, '--apply', '--yes']))).toBe(2)
    expect(await exitOf(runOrg(f.ctx, ['draft', '--from', file]))).toBe(2)
    expect(await exitOf(runOrg(f.ctx, ['draft', '--from', path.join(dir, 'missing.json'), '--apply', '--yes']))).toBe(2)
    expect(client.callsOf('projects:save')).toHaveLength(0)
    fs.rmSync(dir, { recursive: true })
  })

  it('parseDraftFile accepts the printed shape, a bare roles object and an array; rejects duplicates', () => {
    expect(parseDraftFile(JSON.stringify({ draft: { roles: drafted } })).roles).toHaveLength(2)
    expect(parseDraftFile(JSON.stringify({ roles: drafted })).roles).toHaveLength(2)
    expect(parseDraftFile(JSON.stringify(drafted)).roles).toHaveLength(2)
    expect(() => parseDraftFile(JSON.stringify([drafted[0], drafted[0]]))).toThrow(/repeats/)
    expect(() => parseDraftFile('nope')).toThrow(/valid JSON/)
    expect(() => parseDraftFile('[]')).toThrow(/no roles/)
  })

  it('applyDraftRoles merges by slug and renames colliding ids', () => {
    const cur = [role('a'), role('b')]
    const out = applyDraftRoles(cur, [role('x', { slug: 'b' }), role('a', { slug: 'new', reportsTo: 'x' })], 'merge')
    expect(out.map((r) => r.id)).toEqual(['a', 'b', 'a-2'])
    expect(out.find((r) => r.slug === 'new')!.reportsTo).toBe('b')
    expect(out.find((r) => r.id === 'b')!.slug).toBe('b')
  })

  it('spendNote only speaks when tiers rise or staffing is newly on', () => {
    const cur = [role('a', { tier: 'deep' })]
    expect(spendNote(cur, [role('a', { tier: 'everyday' })], {})).toBeUndefined()
    expect(spendNote(cur, [role('a', { tier: 'top' })], {})).toMatch(/may spend more/)
    expect(spendNote(cur, [role('a', { tier: 'deep', staffing: { mode: 'auto' } })], {})).toMatch(/may spend more/)
    expect(spendNote(cur, [role('a', { tier: 'deep', staffing: { mode: 'auto' } })], { staffing: 'fixed' })).toBeUndefined()
  })
})

describe('org revise', () => {
  it('starts the Architect on the existing project with the instruction', async () => {
    const { f } = setup({}, { tty: true })
    const spy = vi.spyOn(interactive, 'runInteractiveRun').mockResolvedValue(0)
    expect(await runOrg(f.ctx, ['revise', 'add', 'a', 'QA', 'lead'])).toBe(0)
    expect(spy.mock.calls[0][1]).toMatchObject({ channel: 'setup:start', input: { projectId: 'p1', instruction: 'add a QA lead' } })
  })

  it('needs an instruction and a terminal (exit 2)', async () => {
    const spy = vi.spyOn(interactive, 'runInteractiveRun').mockResolvedValue(0)
    expect(await exitOf(runOrg(setup({}, { tty: true }).f.ctx, ['revise']))).toBe(2)
    expect(await exitOf(runOrg(setup({}).f.ctx, ['revise', 'x']))).toBe(2)
    expect(await exitOf(runOrg(setup({}, { tty: true, format: 'json' }).f.ctx, ['revise', 'x']))).toBe(2)
    expect(spy).not.toHaveBeenCalled()
  })
})
