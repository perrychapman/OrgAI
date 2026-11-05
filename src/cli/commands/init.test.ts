import { afterEach, describe, expect, it } from 'vitest'
import type { HostScope, Project, ProjectPathCheck } from '../../shared/types'
import { resetSkewWarning } from '../runRef'
import { fakeContext, FakeHostClient, project, type Answer } from '../testing/fakeContext'
import { CliError, EXIT, type ProjectResolution } from '../types'
import { ARCHITECT_LABEL, INIT_NO_TTY_MESSAGE, initDeps, runInit } from './init'
import type { InteractiveRunSpec } from './interactive'

const realDeps = { ...initDeps }
afterEach(() => {
  Object.assign(initDeps, realDeps)
  resetSkewWarning()
})

const ALL: { grantedScopes: HostScope[] } = { grantedScopes: ['read', 'operate', 'decide', 'configure'] }
const check = (extra: Partial<ProjectPathCheck> = {}): ProjectPathCheck => ({ exists: true, isDirectory: true, isGitRepo: true, suggestedName: 'repo', empty: false, ...extra })

async function caught(p: Promise<unknown>): Promise<CliError> {
  try {
    await p
  } catch (e) {
    expect(e).toBeInstanceOf(CliError)
    return e as CliError
  }
  throw new Error('expected a CliError')
}

function host(extra: Record<string, Answer> = {}): FakeHostClient {
  return new FakeHostClient(
    {
      'projects:list': () => [],
      'projects:checkPath': () => check(),
      'projects:create': (params) => project('p_new', (params as [{ path: string }])[0].path, { name: (params as [{ name: string }])[0].name }),
      'projects:get': (params) => project((params as [string])[0], '/work/repo', { name: 'Repo' }),
      'projects:save': (params) => (params as [Project])[0],
      ...extra
    },
    { hello: ALL }
  )
}

function setup(o: { tty?: boolean; client?: FakeHostClient; resolve?: (p: Project[]) => ProjectResolution; json?: boolean } = {}) {
  const client = o.client ?? host()
  const f = fakeContext({ connect: [client], cwd: '/work/repo', stdinIsTTY: o.tty === true, ...(o.resolve ? { resolveProject: o.resolve } : {}), globals: o.json ? { outputFormat: 'json' } : {} })
  if (o.tty) f.ctx.io.stdout.isTTY = true
  const interactive: { spec: InteractiveRunSpec; flags: unknown }[] = []
  initDeps.runInteractiveRun = async (_ctx, spec, flags) => {
    interactive.push({ spec, flags })
    return 0
  }
  return { f, client, interactive }
}

describe('orgai init', () => {
  it('no terminal without --skip-architect is exit 2 before any host starts', async () => {
    const s = setup()
    const e = await caught(runInit(s.f.ctx, []))
    expect(e).toMatchObject({ exitCode: EXIT.usage, message: INIT_NO_TTY_MESSAGE })
    expect(s.f.connectCalls).toEqual([])
    expect(s.interactive).toEqual([])
  })

  it('refuses inside a managed agent worktree (exit 2)', async () => {
    const s = setup({ tty: true, resolve: () => ({ via: 'none', managedWorktree: { mainCheckout: '/work/main' } }) })
    const e = await caught(runInit(s.f.ctx, ['--skip-architect']))
    expect(e.exitCode).toBe(EXIT.usage)
    expect(e.message).toContain('/work/main')
    expect(s.f.connectCalls).toEqual([])
  })

  it('--skip-architect creates the project and exits 0 (JSON: project)', async () => {
    const s = setup({ json: true })
    expect(await runInit(s.f.ctx, ['--skip-architect', '--name', 'Repo'])).toBe(0)
    expect(s.client.callsOf('projects:create')).toEqual([[{ name: 'Repo', path: '/work/repo', brief: '', kind: 'code' }]])
    expect(JSON.parse(s.f.out())).toMatchObject({ project: { id: 'p_new', name: 'Repo', kind: 'code' }, existing: false })
    expect(s.f.connectCalls[0].scopes).toEqual(['read', 'configure'])
    expect(s.interactive).toEqual([])
  })

  it('an existing project with --skip-architect exits 0 and creates nothing', async () => {
    const client = host({ 'projects:checkPath': () => check({ existingProjectId: 'p1', existingProjectName: 'Repo' }) })
    const s = setup({ client })
    expect(await runInit(s.f.ctx, ['--skip-architect'])).toBe(0)
    expect(s.f.out()).toBe('Already an OrgAI project: Repo\n')
    expect(client.callsOf('projects:create')).toEqual([])
  })

  it('the Architect path creates the project, then runs setup:start on it', async () => {
    const s = setup({ tty: true })
    expect(await runInit(s.f.ctx, ['--kind', 'engagement', '--client', 'Acme', '--inline'])).toBe(0)
    expect(s.client.callsOf('projects:create')).toEqual([[{ name: 'repo', path: '/work/repo', brief: '', kind: 'engagement' }]])
    expect((s.client.callsOf('projects:save')[0] as [Project])[0]).toMatchObject({ client: 'Acme' })
    expect(s.interactive).toEqual([
      {
        spec: { channel: 'setup:start', input: { projectId: 'p_new' }, label: ARCHITECT_LABEL, noTtyMessage: INIT_NO_TTY_MESSAGE },
        flags: { inline: true, screenReader: false }
      }
    ])
  })

  it('an existing project starts the Architect on it without creating', async () => {
    const client = host({ 'projects:checkPath': () => check({ existingProjectId: 'p1', existingProjectName: 'Repo' }) })
    const s = setup({ tty: true, client })
    initDeps.runInteractiveRun = async (_c, spec) => (s.interactive.push({ spec, flags: undefined }), 130)
    expect(await runInit(s.f.ctx, [])).toBe(130)
    expect(client.callsOf('projects:create')).toEqual([])
    expect(s.interactive[0].spec.input).toEqual({ projectId: 'p1' })
  })

  it('refuses a bad --kind and a file instead of a folder with exit 2', async () => {
    expect((await caught(runInit(setup().f.ctx, ['--skip-architect', '--kind', 'web']))).exitCode).toBe(EXIT.usage)
    const s = setup({ client: host({ 'projects:checkPath': () => check({ isDirectory: false }) }) })
    expect((await caught(runInit(s.f.ctx, ['--skip-architect']))).exitCode).toBe(EXIT.usage)
  })
})
