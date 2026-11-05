import { afterEach, describe, expect, it } from 'vitest'
import type { HostScope, Project } from '../../shared/types'
import { resetSkewWarning } from '../runRef'
import { fakeContext, FakeHostClient, project, rpcError, type Answer } from '../testing/fakeContext'
import { CliError } from '../types'
import { runPermissions } from './permissions'

const ALL: { grantedScopes: HostScope[] } = { grantedScopes: ['read', 'operate', 'decide', 'configure'] }
afterEach(() => resetSkewWarning())

const P = project('p1', '/work', { name: 'App', allowedDirectories: ['/data/shared'], referenceDirectories: ['/data/ref'] } as Partial<Project>)

function setup(answers: Record<string, Answer>, opts: { project?: Project; format?: 'text' | 'json' } = {}) {
  const proj = opts.project ?? P
  const client = new FakeHostClient({ 'projects:list': () => [proj], 'projects:get': () => proj, ...answers }, { hello: ALL })
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

describe('permissions list', () => {
  it('lists rules with labels and the rules location', async () => {
    const { f } = setup({ 'permissions:list': () => ['Bash(npm test:*)', 'mcp__github'] })
    expect(await runPermissions(f.ctx, ['list'])).toBe(0)
    expect(f.out()).toContain('Bash(npm test:*)')
    expect(f.out()).toContain('mcp__github  (All tools of github)')
    expect(f.out()).toContain('/work/.claude/settings.local.json')
  })

  it('an engagement keeps its rules in the app', async () => {
    const { f } = setup({ 'permissions:list': () => [] }, { project: project('e1', '/work', { kind: 'engagement' } as Partial<Project>), format: 'json' })
    expect(await runPermissions(f.ctx, ['list'])).toBe(0)
    expect(JSON.parse(f.out())).toMatchObject({ location: 'app', rules: [] })
  })
})

describe('permissions add / remove', () => {
  it('add sends the rule (configure scope)', async () => {
    const { f, client } = setup({ 'permissions:add': () => ['Bash(npm test:*)'] })
    expect(await runPermissions(f.ctx, ['add', 'Bash(npm test:*)'])).toBe(0)
    expect(client.callsOf('permissions:add')).toEqual([[{ projectId: 'p1', rule: 'Bash(npm test:*)' }]])
    expect(f.connectCalls[0].scopes).toEqual(['read', 'configure'])
  })

  it('a too-broad refusal (bad_request) is exit 2 with the host sentence', async () => {
    const { f } = setup({ 'permissions:add': () => Promise.reject(rpcError({ code: 'bad_request', message: 'Bash(curl:*) is too broad: it can fetch anything.' })) })
    await expect(runPermissions(f.ctx, ['add', 'Bash(curl:*)'])).rejects.toMatchObject({ exitCode: 2, message: 'Bash(curl:*) is too broad: it can fetch anything.' })
  })

  it('another host failure is exit 1', async () => {
    const { f } = setup({ 'permissions:add': () => Promise.reject(rpcError({ code: 'frame_too_large', message: 'Too big.' })) })
    expect(await exitOf(runPermissions(f.ctx, ['add', 'Read']))).toBe(1)
  })

  it('remove of an unknown rule is exit 2; a known one is removed', async () => {
    let s = setup({ 'permissions:list': () => ['Read'], 'permissions:remove': () => [] })
    expect(await exitOf(runPermissions(s.f.ctx, ['remove', 'Write']))).toBe(2)
    expect(s.client.callsOf('permissions:remove')).toEqual([])
    s = setup({ 'permissions:list': () => ['Read'], 'permissions:remove': () => [] })
    expect(await runPermissions(s.f.ctx, ['remove', 'Read'])).toBe(0)
    expect(s.client.callsOf('permissions:remove')).toEqual([[{ projectId: 'p1', rule: 'Read' }]])
  })

  it('a rule with control characters is refused before connecting', async () => {
    const { f } = setup({})
    expect(await exitOf(runPermissions(f.ctx, ['add', 'Bash(\x1b[2J)']))).toBe(2)
    expect(f.connectCalls).toEqual([])
  })
})

describe('permissions mode', () => {
  it('shows the mode with its short name', async () => {
    const { f } = setup({})
    expect(await runPermissions(f.ctx, ['mode'])).toBe(0)
    expect(f.out()).toContain('Permission mode: default (Ask for everything risky)')
  })

  it('validates the value before connecting', async () => {
    const { f } = setup({})
    expect(await exitOf(runPermissions(f.ctx, ['mode', 'yolo']))).toBe(2)
    expect(f.connectCalls).toEqual([])
  })

  it('sets the mode through projects:get + projects:save', async () => {
    const { f, client } = setup({ 'projects:save': (p) => (p as [Project])[0] })
    expect(await runPermissions(f.ctx, ['mode', 'acceptEdits'])).toBe(0)
    expect((client.callsOf('projects:save')[0] as [Project])[0]).toMatchObject({ id: 'p1', permissionMode: 'acceptEdits' })
    expect(f.out()).toContain('acceptEdits (Auto-accept edits)')
  })
})

describe('permissions folders / reference', () => {
  it('add resolves a relative folder against cwd and saves it', async () => {
    const { f, client } = setup({ 'projects:save': (p) => (p as [Project])[0] })
    expect(await runPermissions(f.ctx, ['folders', 'add', '../lib'])).toBe(0)
    expect((client.callsOf('projects:save')[0] as [Project])[0].allowedDirectories).toEqual(['/data/shared', '/lib'])
    expect(f.out()).toContain('  /lib')
  })

  it('reference add / remove', async () => {
    let s = setup({ 'projects:save': (p) => (p as [Project])[0] })
    expect(await runPermissions(s.f.ctx, ['reference', 'add', 'docs'])).toBe(0)
    expect((s.client.callsOf('projects:save')[0] as [Project])[0].referenceDirectories).toEqual(['/data/ref', '/work/docs'])
    s = setup({ 'projects:save': (p) => (p as [Project])[0] })
    expect(await runPermissions(s.f.ctx, ['reference', 'remove', '/data/ref/'])).toBe(0)
    expect((s.client.callsOf('projects:save')[0] as [Project])[0].referenceDirectories).toEqual([])
  })

  it('a folder already in the other list is exit 2 without saving', async () => {
    const { f, client } = setup({ 'projects:save': (p) => (p as [Project])[0] })
    expect(await exitOf(runPermissions(f.ctx, ['folders', 'add', '/data/ref']))).toBe(2)
    expect(await exitOf(runPermissions(setup({}).f.ctx, ['reference', 'add', '/data/shared']))).toBe(2)
    expect(client.callsOf('projects:save')).toEqual([])
  })

  it('names a folder main dropped (exit 1)', async () => {
    const { f } = setup({ 'projects:save': (p) => ({ ...(p as [Project])[0], allowedDirectories: ['/data/shared'] }) })
    expect(await exitOf(runPermissions(f.ctx, ['folders', 'add', '/']))).toBe(1)
    expect(f.out()).toContain('/ was not saved')
  })

  it('list shows the folders', async () => {
    const { f } = setup({})
    expect(await runPermissions(f.ctx, ['folders'])).toBe(0)
    expect(f.out()).toContain('/data/shared')
  })
})
