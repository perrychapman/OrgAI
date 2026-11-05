// mcp:authorize announceUrl / openBrowser (cli-spec 6.3(5), `orgai mcp auth`): fake flow, fake opener, no network.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpAuthorizeInput, McpAuthorizeUrlUpdate, McpLibraryEntry } from '@shared/types'
import { ProjectStore } from '../store/projects'
import { McpLibraryStore } from '../store/mcpLibrary'
import { SecretStore } from '../store/secrets'
import { MOCK_AUTHORIZE_URL, McpService } from './service'
import type { AuthorizeFlowInput } from './oauth'

const cipher = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from(`enc:${s}`),
  decryptString: (b: Buffer) => b.toString().slice(4)
}
const NOW = Date.parse('2026-06-01T00:00:00.000Z')
const AUTH_URL = 'https://as.test/authorize?client_id=cid&redirect_uri=http%3A%2F%2F127.0.0.1%3A40123%2Fcallback&state=s1&code_challenge=c'

let dir: string
let projects: ProjectStore
let secrets: SecretStore
let library: McpLibraryStore
let announced: McpAuthorizeUrlUpdate[]
let order: string[]
const openExternal = vi.fn(async (_url: string) => {
  order.push('open')
})
const runAuthorization = vi.fn()
const refreshTokens = vi.fn()

const entry: McpLibraryEntry = { id: 'mcpl_1', name: 'docs', transport: 'http', url: 'https://docs.test/mcp', source: 'user', addedAt: '2026-01-01T00:00:00.000Z' }

const flowResult = {
  config: { resource: 'https://docs.test/mcp', clientId: 'cid', clientSource: 'dcr' as const, authorizedAt: new Date(NOW).toISOString() },
  tokens: { accessToken: 'AT-1' }
}

function build(mock = false): McpService {
  return new McpService({
    projects,
    secrets,
    library,
    now: () => NOW,
    openExternal,
    oauth: { runAuthorization, refreshTokens },
    onAuthorizeUrl: (u) => {
      order.push('announce')
      announced.push(u)
    },
    mock
  })
}

/** A fake flow: opens the URL, then waits until the test delivers the callback. */
function waitingFlow(): { callback: () => void; opened: Promise<void> } {
  let callback!: () => void
  let opened!: () => void
  const openedP = new Promise<void>((r) => (opened = r))
  const cb = new Promise<void>((r) => (callback = r))
  runAuthorization.mockImplementation(async (i: AuthorizeFlowInput) => {
    await i.openExternal(AUTH_URL)
    opened()
    order.push('waiting')
    await cb
    return flowResult
  })
  return { callback, opened: openedP }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orgai-authurl-'))
  projects = new ProjectStore(join(dir, 'data'))
  secrets = new SecretStore(join(dir, 'data'), cipher)
  library = new McpLibraryStore(join(dir, 'data'))
  library.save(entry)
  announced = []
  order = []
  openExternal.mockClear()
  runAuthorization.mockReset()
  refreshTokens.mockReset()
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('mcp:authorize announceUrl / openBrowser', () => {
  it('announceUrl sends target, url and redirectUri before the flow waits, then opens the browser', async () => {
    const svc = build()
    const f = waitingFlow()
    const p = svc.authorize({ libraryId: 'mcpl_1', announceUrl: true })
    await f.opened
    expect(announced).toEqual([{ target: { libraryId: 'mcpl_1' }, url: AUTH_URL, redirectUri: 'http://127.0.0.1:40123/callback', openedBrowser: true, at: NOW }])
    expect(order).toEqual(['announce', 'open', 'waiting'])
    f.callback()
    expect((await p).state).toBe('authorized')
    expect(JSON.stringify(announced)).not.toContain('AT-1')
  })

  it('openBrowser false never calls openExternal and still completes when the callback arrives', async () => {
    const svc = build()
    const f = waitingFlow()
    const p = svc.authorize({ libraryId: 'mcpl_1', announceUrl: true, openBrowser: false })
    await f.opened
    expect(openExternal).not.toHaveBeenCalled()
    expect(announced[0]).toMatchObject({ openedBrowser: false, url: AUTH_URL })
    f.callback()
    expect((await p).state).toBe('authorized')
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('without the flags behaves as before: no announcement, the opener is the flow opener', async () => {
    const svc = build()
    const f = waitingFlow()
    const p = svc.authorize({ libraryId: 'mcpl_1' })
    await f.opened
    f.callback()
    expect((await p).state).toBe('authorized')
    expect(announced).toEqual([])
    expect(openExternal).toHaveBeenCalledWith(AUTH_URL)
    expect((runAuthorization.mock.calls[0][0] as AuthorizeFlowInput).openExternal).toBe(openExternal)
  })

  it('an opener failure with openBrowser true is unchanged (the flow sees the throw)', async () => {
    const svc = build()
    openExternal.mockRejectedValueOnce(new Error('no browser'))
    runAuthorization.mockImplementation(async (i: AuthorizeFlowInput) => {
      await i.openExternal(AUTH_URL)
      return flowResult
    })
    const status = await svc.authorize({ libraryId: 'mcpl_1', announceUrl: true })
    expect(status.state).toBe('error')
    expect(status.error).toContain('no browser')
    expect(announced).toHaveLength(1)
  })

  it('ignores non-boolean flag values', async () => {
    const svc = build()
    const f = waitingFlow()
    const input = { libraryId: 'mcpl_1', announceUrl: 'yes', openBrowser: 0 } as unknown as McpAuthorizeInput
    const p = svc.authorize(input)
    await f.opened
    f.callback()
    await p
    expect(announced).toEqual([])
    expect(openExternal).toHaveBeenCalledTimes(1)
  })

  it('a project-only server announces its project target; a linked one announces as given', async () => {
    const pid = projects.create({ name: 'p', path: join(dir, 'repo'), brief: '' }).id
    const cur = projects.get(pid)!
    projects.save({
      ...cur,
      mcpServers: [{ id: 'mcp-1', name: 'remote', transport: 'http', url: 'https://docs.test/mcp', enabled: true, source: 'user', addedAt: '2026-01-01T00:00:00.000Z' }]
    })
    const svc = build()
    const f = waitingFlow()
    const p = svc.authorize({ projectId: pid, serverId: 'mcp-1', announceUrl: true, openBrowser: false })
    await f.opened
    f.callback()
    await p
    expect(announced[0].target).toEqual({ projectId: pid, serverId: 'mcp-1' })
  })

  it('mock mode announces the fixed fake URL with openedBrowser false and never opens', async () => {
    const svc = build(true)
    const info = svc.connectorsAdd({ connectorId: 'linear' })
    const status = await svc.authorize({ libraryId: info.entry.id, announceUrl: true })
    expect(status.state).toBe('authorized')
    expect(announced).toEqual([{ target: { libraryId: info.entry.id }, url: MOCK_AUTHORIZE_URL, redirectUri: 'http://127.0.0.1:38917/callback', openedBrowser: false, at: NOW }])
    expect(openExternal).not.toHaveBeenCalled()
    expect(runAuthorization).not.toHaveBeenCalled()
  })

  it('mock mode without announceUrl announces nothing', async () => {
    const svc = build(true)
    const info = svc.connectorsAdd({ connectorId: 'linear' })
    await svc.authorize({ libraryId: info.entry.id })
    expect(announced).toEqual([])
  })
})
