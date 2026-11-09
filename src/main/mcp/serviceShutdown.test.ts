// Wave 7 (cli-standalone.md round 6 item 9): mcp:authorize leases only its final commit, and McpService.dispose()
// (the drain's quiesce) aborts every interactive authorization so Quit and the host's shutdown never wait on a browser.
// Fake flow, no network.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpLibraryEntry } from '@shared/types'
import { ProjectStore } from '../store/projects'
import { McpLibraryStore } from '../store/mcpLibrary'
import { SecretStore } from '../store/secrets'
import { McpService } from './service'
import type { AuthorizeFlowInput } from './oauth'

const cipher = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from(`enc:${s}`),
  decryptString: (b: Buffer) => b.toString().slice(4)
}
const NOW = Date.parse('2026-06-01T00:00:00.000Z')
const entry: McpLibraryEntry = { id: 'mcpl_1', name: 'docs', transport: 'http', url: 'https://docs.test/mcp', source: 'user', addedAt: '2026-01-01T00:00:00.000Z' }
const flowResult = {
  config: { resource: 'https://docs.test/mcp', clientId: 'cid', clientSource: 'dcr' as const, authorizedAt: new Date(NOW).toISOString() },
  tokens: { accessToken: 'AT-1' }
}

let dir: string
let secrets: SecretStore
let library: McpLibraryStore
let leases: string[]
let held: number

function build(runAuthorization: (i: AuthorizeFlowInput) => Promise<typeof flowResult>): McpService {
  return new McpService({
    projects: new ProjectStore(join(dir, 'data')),
    secrets,
    library,
    now: () => NOW,
    openExternal: async () => {},
    oauth: { runAuthorization: runAuthorization as never, refreshTokens: vi.fn() },
    commitLease: (label) => {
      leases.push(label)
      held++
      let done = false
      return () => {
        if (done) return
        done = true
        held--
      }
    }
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orgai-mcp-shutdown-'))
  secrets = new SecretStore(join(dir, 'data'), cipher)
  library = new McpLibraryStore(join(dir, 'data'))
  library.save(entry)
  leases = []
  held = 0
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('McpService authorize and shutdown', () => {
  it('holds no lease while the browser is open, one around the final commit, and releases it', async () => {
    let callback!: () => void
    const cb = new Promise<void>((r) => (callback = r))
    let heldDuringWait = -1
    let heldDuringCommit = -1
    const svc = build(async () => {
      await new Promise((r) => setTimeout(r, 10))
      heldDuringWait = held
      await cb
      return flowResult
    })
    // The token write is the commit: count the lease while it happens.
    const set = secrets.set.bind(secrets)
    vi.spyOn(secrets, 'set').mockImplementation((k: string, v: string | null) => {
      if (k.includes('accessToken')) heldDuringCommit = held
      return set(k, v)
    })
    const p = svc.authorize({ libraryId: 'mcpl_1' })
    await vi.waitFor(() => expect(heldDuringWait).toBe(0))
    expect(svc.activeAuthorizationCount()).toBe(1)
    callback()
    await expect(p).resolves.toMatchObject({ state: 'authorized' })
    expect(heldDuringCommit).toBe(1)
    expect(leases).toEqual(['mcp:authorize commit'])
    expect(held).toBe(0)
  })

  it('dispose() aborts a waiting authorization: it resolves cancelled, stores nothing, and new ones are refused', async () => {
    const svc = build(
      (i) =>
        new Promise((_resolve, reject) => {
          i.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        })
    )
    const p = svc.authorize({ libraryId: 'mcpl_1' })
    await vi.waitFor(() => expect(svc.activeAuthorizationCount()).toBe(1))
    svc.dispose()
    await expect(p).resolves.toEqual({ state: 'error', error: 'Authorization was cancelled.' })
    expect(svc.activeAuthorizationCount()).toBe(0)
    expect(secrets.keys('mcplib:mcpl_1:')).toEqual([])
    expect(held).toBe(0)
    await expect(svc.authorize({ libraryId: 'mcpl_1' })).rejects.toThrow(/shutting down/)
    svc.dispose()
  })

  it('a flow that completes after dispose() never commits its tokens', async () => {
    let finish!: () => void
    const gate = new Promise<void>((r) => (finish = r))
    const svc = build(async () => {
      await gate
      return flowResult
    })
    const p = svc.authorize({ libraryId: 'mcpl_1' })
    await vi.waitFor(() => expect(svc.activeAuthorizationCount()).toBe(1))
    svc.dispose()
    finish()
    await expect(p).resolves.toMatchObject({ state: 'error' })
    expect(secrets.keys('mcplib:mcpl_1:')).toEqual([])
    expect(held).toBe(0)
  })
})
