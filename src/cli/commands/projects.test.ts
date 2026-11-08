import { afterEach, describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import type { HostScope, Project, ProjectPathCheck, ProjectRemoveResult } from '../../shared/types'
import { manageDeps } from '../manage'
import { fakeContext, FakeHostClient, project, rpcError, summary, type Answer } from '../testing/fakeContext'
import { CliError, EXIT } from '../types'
import { runProjects, setPatch } from './projects'

const realDeps = { ...manageDeps }
afterEach(() => {
  Object.assign(manageDeps, realDeps)
})

const ALL: { grantedScopes: HostScope[] } = { grantedScopes: ['read', 'operate', 'decide', 'configure'] }

async function caught(p: Promise<unknown>): Promise<CliError> {
  try {
    await p
  } catch (e) {
    expect(e).toBeInstanceOf(CliError)
    return e as CliError
  }
  throw new Error('expected a CliError')
}

const P1 = project('p1', '/work/app', { name: 'App', roles: [{ id: 'r1', reportsTo: null }, { id: 'r2', reportsTo: 'r1' }] as never })
const E1 = project('e1', '/work/acme', { name: 'Acme \x1b[31mreview', kind: 'engagement', client: 'Acme Corp' })

const check = (extra: Partial<ProjectPathCheck> = {}): ProjectPathCheck => ({ exists: true, isDirectory: true, isGitRepo: true, suggestedName: 'repo', empty: false, ...extra })

function host(extra: Record<string, Answer> = {}, store: Project[] = [P1, E1]): FakeHostClient {
  const byId = (params: unknown) => store.find((p) => p.id === (params as [string])[0]) ?? null
  return new FakeHostClient(
    {
      'projects:list': () => store,
      'projects:get': byId,
      'projects:checkPath': () => check(),
      'templates:list': () => [{ id: 'tpl_1', name: 'Team', description: '', kind: 'code', roleCount: 2, roleNames: [], createdAt: 1, updatedAt: 1 }],
      'projects:create': (params) => project('p_new', (params as [{ path: string }])[0].path, { name: (params as [{ name: string }])[0].name, kind: (params as [{ kind: 'code' }])[0].kind }),
      'projects:save': (params) => (params as [Project])[0],
      ...extra
    },
    { hello: ALL }
  )
}

function run(args: string[], o: { client?: FakeHostClient; env?: NodeJS.ProcessEnv; json?: boolean; cwd?: string; tty?: boolean; saved?: Project[] } = {}) {
  const client = o.client ?? host()
  const f = fakeContext({ connect: [client], store: { projects: o.saved ?? [P1, E1] }, cwd: o.cwd ?? '/work/app', env: o.env ?? {}, globals: o.json ? { outputFormat: 'json' } : {}, stdinIsTTY: o.tty === true })
  if (o.tty) f.ctx.io.stdout.isTTY = true
  return { f, client, done: runProjects(f.ctx, args) }
}

describe('projects list / show / check', () => {
  it('lists name, kind, client, folder and id (text sanitized, virtual projects left out)', async () => {
    const quick = project('quick', '/q', { name: 'Chat' })
    const { f, client, done } = run(['list'], { saved: [P1, E1, quick] })
    expect(await done).toBe(0)
    // Read from the saved files: no host is started or asked.
    expect(f.inprocCalls).toEqual([])
    expect(client.calls).toEqual([])
    const out = f.out()
    expect(out).toMatch(/NAME\s+KIND\s+CLIENT\s+FOLDER\s+ID/)
    expect(out).toContain('Engagement')
    expect(out).toContain('Acme Corp')
    expect(out).not.toContain('\x1b[31m')
    expect(out).not.toContain('Chat')
  })

  it('lists as JSON', async () => {
    const { f, done } = run(['list'], { json: true })
    expect(await done).toBe(0)
    const doc = JSON.parse(f.out())
    expect(doc.schemaVersion).toBe(1)
    expect(doc.projects).toEqual([
      { id: 'p1', name: 'App', kind: 'code', path: '/work/app' },
      { id: 'e1', name: 'Acme \x1b[31mreview', kind: 'engagement', client: 'Acme Corp', path: '/work/acme' }
    ])
  })

  it('shows the cwd project with automatic limits, and an id argument', async () => {
    const a = run(['show'])
    expect(await a.done).toBe(0)
    expect(a.f.out()).toContain('Subagent depth:  Automatic (2)')
    expect(a.f.out()).toContain('Concurrent:      Automatic (8)')
    expect(a.f.out()).toContain('Budget per run:  no cap')
    expect(a.f.inprocCalls).toEqual([])
    expect(a.client.calls).toEqual([])

    const b = run(['show', 'e1'], { json: true, saved: [P1, { ...E1, maxSubagentDepth: 3, maxBudgetUsd: 5 } as Project] })
    expect(await b.done).toBe(0)
    const doc = JSON.parse(b.f.out())
    expect(doc.project).toMatchObject({ id: 'e1', kind: 'engagement', client: 'Acme Corp', maxBudgetUsd: 5, limits: { depth: 3, concurrency: 8, explicit: { depth: true, concurrency: false } } })
  })

  it('show with no project here is exit 2', async () => {
    const e = await caught(run(['show'], { cwd: '/elsewhere' }).done)
    expect(e.exitCode).toBe(EXIT.usage)
  })

  it('checks a folder: agent sources, instruction files, an existing project', async () => {
    const client = host({
      'projects:checkPath': () =>
        check({ agentSources: [{ source: 'claude', label: 'Claude Code', agentCount: 2 }], instructionFiles: ['AGENTS.md'], existingProjectId: 'p1', existingProjectName: 'App' })
    })
    const { f, done } = run(['check', 'sub'], { client })
    expect(await done).toBe(0)
    expect(client.callsOf('projects:checkPath')).toEqual([[resolve('/work/app/sub')]])
    expect(f.out()).toContain('Claude Code: 2 agents (claude)')
    expect(f.out()).toContain('Instruction files: AGENTS.md')
    expect(f.out()).toContain('Already a project: App (p1)')
    const j = run(['check'], { json: true })
    expect(await j.done).toBe(0)
    expect(JSON.parse(j.f.out())).toMatchObject({ folder: resolve('/work/app'), check: { exists: true, isGitRepo: true } })
  })

  it('an unknown subcommand is exit 2', async () => {
    expect((await caught(run(['nope']).done)).exitCode).toBe(EXIT.usage)
    expect((await caught(run([]).done)).exitCode).toBe(EXIT.usage)
  })
})

describe('projects create', () => {
  const created = (client: FakeHostClient) => (client.callsOf('projects:create')[0] as [Record<string, unknown>])[0]

  it('sends mock only with ORGAI_MOCK=1', async () => {
    const a = run(['create', '/work/new', '--name', 'New'], { cwd: '/work' })
    expect(await a.done).toBe(0)
    expect(created(a.client)).toEqual({ name: 'New', path: resolve('/work/new'), brief: '', kind: 'code' })
    const b = run(['create', '/work/new'], { cwd: '/work', env: { ORGAI_MOCK: '1' } })
    expect(await b.done).toBe(0)
    expect(created(b.client)).toMatchObject({ name: 'repo', mock: true })
  })

  it('--import-agents sends every source checkPath found; none found is exit 2', async () => {
    const client = host({
      'projects:checkPath': () =>
        check({ agentSources: [{ source: 'claude', label: 'Claude Code', agentCount: 2 }, { source: 'codex', label: 'Codex', agentCount: 1 }] })
    })
    const a = run(['create', '/work/new', '--import-agents'], { cwd: '/work', client })
    expect(await a.done).toBe(0)
    expect(created(client)).toMatchObject({ importAgents: ['claude', 'codex'] })
    const e = await caught(run(['create', '/work/new', '--import-agents'], { cwd: '/work' }).done)
    expect(e.exitCode).toBe(EXIT.usage)
  })

  it('--template sends templateId after checking it exists; an unknown one is exit 2', async () => {
    const a = run(['create', '/work/new', '--template', 'tpl_1'], { cwd: '/work' })
    expect(await a.done).toBe(0)
    expect(created(a.client)).toMatchObject({ templateId: 'tpl_1' })
    const b = run(['create', '/work/new', '--template', 'tpl_x'], { cwd: '/work' })
    expect((await caught(b.done)).exitCode).toBe(EXIT.usage)
    expect(b.client.callsOf('projects:create')).toEqual([])
  })

  it('refuses --import-agents with --template, a bad --kind and --client on code, before any host', async () => {
    for (const args of [['--import-agents', '--template', 't'], ['--kind', 'nope'], ['--client', 'Acme']]) {
      const r = run(['create', '/work/new', ...args], { cwd: '/work' })
      expect((await caught(r.done)).exitCode).toBe(EXIT.usage)
      expect(r.f.connectCalls).toEqual([])
    }
  })

  it('--client follows up with projects:get + projects:save on an engagement', async () => {
    const store: Project[] = [P1]
    const client = host({
      'projects:create': (params) => {
        const p = project('e_new', '/work/new', { name: 'Eng', kind: 'engagement' })
        store.push(p)
        void params
        return p
      }
    }, store)
    const r = run(['create', '/work/new', '--kind', 'engagement', '--client', ' Acme ', '--brief', 'Review'], { cwd: '/work', client, json: true })
    expect(await r.done).toBe(0)
    expect(created(client)).toMatchObject({ kind: 'engagement', brief: 'Review' })
    expect(client.callsOf('projects:get')).toEqual([['e_new']])
    expect((client.callsOf('projects:save')[0] as [Project])[0]).toMatchObject({ id: 'e_new', client: 'Acme' })
    expect(JSON.parse(r.f.out()).project).toMatchObject({ id: 'e_new', client: 'Acme' })
  })

  it('an already registered folder is exit 1 naming it; a missing folder exit 2', async () => {
    const a = run(['create', '.'], { client: host({ 'projects:checkPath': () => check({ existingProjectId: 'p1', existingProjectName: 'App' }) }) })
    const e = await caught(a.done)
    expect(e.exitCode).toBe(EXIT.failure)
    expect(e.message).toContain('"App" (p1)')
    const b = run(['create', '/nope'], { client: host({ 'projects:checkPath': () => check({ exists: false, isDirectory: false }) }) })
    expect((await caught(b.done)).exitCode).toBe(EXIT.usage)
  })

  it('a host refusal maps through hostError', async () => {
    const client = host({ 'projects:create': () => Promise.reject(rpcError({ code: 'bad_request', message: 'That folder is OrgAI data.' })) })
    const e = await caught(run(['create', '/work/new'], { cwd: '/work', client }).done)
    expect(e).toMatchObject({ exitCode: EXIT.usage, message: 'That folder is OrgAI data.' })
  })
})

describe('projects set', () => {
  it('maps every flag, with null for the cleared fields', () => {
    expect(
      setPatch(E1, {
        name: ' New ',
        client: '',
        brief: 'b',
        'max-budget': 'none',
        'max-depth': 'auto',
        'max-concurrent': '4',
        'plan-guard': 'auto',
        'auto-continue': 'off',
        'max-auto-continues': '5',
        'run-messaging': 'on',
        'isolate-writers': 'off'
      })
    ).toEqual({
      name: 'New',
      client: null,
      brief: 'b',
      maxBudgetUsd: null,
      maxSubagentDepth: null,
      maxConcurrentSubagents: 4,
      preferEverydayNearLimit: null,
      preferSonnetNearLimit: null,
      autoContinue: false,
      maxAutoContinues: 5,
      runMessaging: true,
      isolateWriters: false
    })
    expect(setPatch(P1, { 'max-budget': '2.5', 'max-depth': '3', 'plan-guard': 'on' })).toEqual({
      maxBudgetUsd: 2.5,
      maxSubagentDepth: 3,
      preferEverydayNearLimit: true,
      preferSonnetNearLimit: true
    })
    expect(setPatch(P1, { 'plan-guard': 'off' })).toEqual({ preferEverydayNearLimit: false, preferSonnetNearLimit: false })
  })

  it('refuses bad values with exit 2', () => {
    const bad: Record<string, string>[] = [
      { 'max-budget': '0' },
      { 'max-budget': 'abc' },
      { 'max-depth': '9' },
      { 'max-concurrent': '0' },
      { 'plan-guard': 'maybe' },
      { 'auto-continue': 'yes' },
      { name: '  ' },
      { client: 'Acme' }
    ]
    for (const v of bad) {
      try {
        setPatch(P1, v)
        throw new Error(`accepted ${JSON.stringify(v)}`)
      } catch (e) {
        expect((e as CliError).exitCode).toBe(EXIT.usage)
      }
    }
  })

  it('reads, saves the whole project with the patch (null clears) and prints the saved values', async () => {
    const stored = { ...P1, maxBudgetUsd: 5, maxSubagentDepth: 3 } as Project
    const client = host({ 'projects:save': (params) => {
      const p = { ...(params as [Project])[0] } as Record<string, unknown>
      for (const k of Object.keys(p)) if (p[k] === null) delete p[k]
      return p
    } }, [stored])
    const r = run(['set', '--max-budget', 'none', '--max-depth', 'auto'], { client })
    expect(await r.done).toBe(0)
    const sent = (client.callsOf('projects:save')[0] as [Record<string, unknown>])[0]
    expect(sent).toMatchObject({ id: 'p1', name: 'App', maxBudgetUsd: null, maxSubagentDepth: null })
    expect(Object.hasOwn(sent, 'maxBudgetUsd')).toBe(true)
    expect(r.f.out()).toContain('Saved App.')
    expect(r.f.out()).toContain('Budget per run:  no cap')
    expect(r.f.out()).toContain('Subagent depth:  Automatic (2)')
  })

  it('no flags is exit 2', async () => {
    expect((await caught(run(['set']).done)).exitCode).toBe(EXIT.usage)
  })
})

describe('projects remove', () => {
  const preview: ProjectRemoveResult = {
    projectId: 'p1',
    kind: 'code',
    runsRemoved: 3,
    runsKept: 0,
    notesRemoved: 0,
    skillsRemoved: 1,
    documentRemoved: false,
    rulesRemoved: true,
    teamReviewRemoved: false,
    skillEvaluationRemoved: false,
    knowledgeRemoved: 0
  }
  const client = (p: ProjectRemoveResult = preview) => host({ 'projects:removePreview': () => p, 'projects:remove': () => p })

  it('prints the counts and removes with --yes', async () => {
    const c = client()
    const r = run(['remove', '--yes'], { client: c })
    expect(await r.done).toBe(0)
    expect(r.f.err()).toContain('3 run records')
    expect(r.f.err()).toContain('1 project skill')
    expect(r.f.err()).toContain('the saved permission rules')
    expect(c.callsOf('projects:removePreview')).toEqual([[{ projectId: 'p1', removeRuns: true }]])
    expect(c.callsOf('projects:remove')).toEqual([[{ projectId: 'p1', removeRuns: true }]])
  })

  it('--keep-runs sends removeRuns false', async () => {
    const c = client({ ...preview, runsRemoved: 0, runsKept: 3 })
    const r = run(['remove', 'p1', '--keep-runs', '-y'], { client: c })
    expect(await r.done).toBe(0)
    expect(c.callsOf('projects:remove')).toEqual([[{ projectId: 'p1', removeRuns: false }]])
    expect(r.f.err()).toContain('Kept: 3 run records')
  })

  it('engagements say they always forget their runs', async () => {
    const c = client({ ...preview, projectId: 'e1', kind: 'engagement' })
    const r = run(['remove', 'e1', '--keep-runs', '--yes'], { client: c })
    expect(await r.done).toBe(0)
    expect(r.f.err()).toContain('Engagements always forget their runs')
  })

  it('asks on a terminal; a no removes nothing (exit 1)', async () => {
    const questions: string[] = []
    manageDeps.ttyConfirm = async (q) => (questions.push(q), false)
    const c = client()
    const r = run(['remove'], { client: c, tty: true })
    expect(await r.done).toBe(EXIT.failure)
    expect(questions).toEqual(['Remove "App" from OrgAI?'])
    expect(c.callsOf('projects:remove')).toEqual([])
    manageDeps.ttyConfirm = async () => true
    const c2 = client()
    expect(await run(['remove'], { client: c2, tty: true }).done).toBe(0)
    expect(c2.callsOf('projects:remove')).toHaveLength(1)
  })

  it('no terminal and no --yes is exit 2', async () => {
    const c = client()
    const e = await caught(run(['remove'], { client: c }).done)
    expect(e.exitCode).toBe(EXIT.usage)
    expect(c.callsOf('projects:remove')).toEqual([])
  })
})

describe('projects save-chat', () => {
  const quickRun = summary('run_quick1', { projectId: 'quick', quick: { folder: '/work/chatdir', team: 'single', allowEdits: false, gitRepo: false } })
  const workRun = summary('run_work01', { projectId: 'p1' })
  const client = (extra: Record<string, Answer> = {}) =>
    host({
      'runs:list': (params) => ((params as [string])[0] === 'quick' ? [quickRun] : (params as [string])[0] === 'p1' ? [workRun] : []),
      'runs:promoteQuick': (params) => ({ kind: 'created', project: project('p_chat', '/work/chatdir', { name: (params as [{ name: string }])[0].name }), run: { ...quickRun, projectId: 'p_chat' } }),
      ...extra
    })

  it('promotes a Chat run with the folder name by default', async () => {
    const c = client()
    const r = run(['save-chat', 'run_quick1'], { client: c })
    expect(await r.done).toBe(0)
    expect(c.callsOf('runs:promoteQuick')).toEqual([[{ runId: 'run_quick1', name: 'chatdir' }]])
    expect(r.f.out()).toContain('Saved the Chat as chatdir (p_chat).')
  })

  it('refuses a non-quick run and a scratch Chat with exit 2', async () => {
    expect((await caught(run(['save-chat', 'run_work01'], { client: client() }).done)).exitCode).toBe(EXIT.usage)
    const scratch = { ...quickRun, quick: { ...quickRun.quick!, scratch: true as const } }
    const c = client({ 'runs:list': (params) => ((params as [string])[0] === 'quick' ? [scratch] : []) })
    expect((await caught(run(['save-chat', 'run_quick1'], { client: c }).done)).exitCode).toBe(EXIT.usage)
    expect(c.callsOf('runs:promoteQuick')).toEqual([])
  })

  it('an existing project answer is exit 1', async () => {
    const c = client({ 'runs:promoteQuick': () => ({ kind: 'existing', projectId: 'p1', name: 'App' }) })
    const r = run(['save-chat', 'run_quick1', '--name', 'X'], { client: c, json: true })
    expect(await r.done).toBe(EXIT.failure)
    expect(JSON.parse(r.f.out())).toMatchObject({ saved: false, existing: { projectId: 'p1' } })
  })
})
