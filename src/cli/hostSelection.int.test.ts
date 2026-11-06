/**
 * Integration (Wave 7, cli-standalone.md 4.1 step 4): `--host auto` with no live host and no app runs a real in-process
 * host for a management command (withHost), and a second host-backed step of the same command (init's Architect
 * after its withHost) gets a fresh in-process host after the first one stopped. Two contexts on one data folder (two
 * terminals): one command never uses another command's own in-process host (it waits for it to end), and does use a
 * shared one (`daemon start --host inproc`; WP-B review round 2). Mock adapter, a temp data folder, the OS certificate
 * reader mocked; no tokens, no network.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../main/systemCerts', () => ({ trustSystemCertificates: () => undefined, stopSystemCertRead: () => undefined }))

import { buildContext } from './context'
import { INPROC_FALLBACK_NOTE, OTHER_COMMAND_HOST_NOTE } from './client/ensureHost'
import { withHost } from './manage'
import type { CliContext } from './types'

let userDataDir: string
beforeEach(() => {
  userDataDir = realpathSync(mkdtempSync(join(tmpdir(), 'hsel-')))
})
afterEach(() => rmSync(userDataDir, { recursive: true, force: true }))

function context(): { ctx: CliContext; err: () => string } {
  let err = ''
  const ctx = buildContext({
    globals: { host: 'auto', outputFormat: 'text', color: false, secretEnv: [], dataDir: userDataDir },
    env: { ORGAI_MOCK: '1', ORGAI_DAEMON_IDLE_MINUTES: '0', PATH: process.env.PATH ?? '' },
    cwd: userDataDir,
    platform: process.platform,
    io: { stdout: { write: () => true }, stderr: { write: (s: string) => ((err += s), true) }, stdinIsTTY: false }
  })
  // This checkout may or may not be built; the test is about the case where no app exists at all.
  ctx.launcher = { ...ctx.launcher, locate: () => ({ status: 'absent', message: 'OrgAI app not found' }) }
  return { ctx, err: () => err }
}

describe('host selection without the app', () => {
  it('runs a management command in-process, then starts a fresh in-process host for the next step', async () => {
    const { ctx, err } = context()
    const first = await withHost(ctx, ['read'], async (client) => {
      expect(client.hello.hostKind).toBe('inproc')
      return client.call<unknown[]>('projects:list', [])
    })
    expect(Array.isArray(first)).toBe(true)
    expect(err()).toBe(`${INPROC_FALLBACK_NOTE}\n`)
    // The first host stopped and released the folder; a second step of the same command starts another one.
    const second = await withHost(ctx, ['read', 'configure'], async (client) => {
      expect(client.hello.grantedScopes).toEqual(expect.arrayContaining(['read', 'configure']))
      return client.hello.hostInstanceId
    })
    expect(typeof second).toBe('string')
    expect(err()).toBe(`${INPROC_FALLBACK_NOTE}\n`)
    // And nothing is left behind: a plain connect finds no host.
    const res = await ctx.connect(['read'], { waitStartingMs: 0 })
    expect(res.ok).toBe(false)
  }, 30_000)
})

describe('two terminals on one data folder (WP-B review round 2)', () => {
  it("never uses another command's own in-process host: waits for it to end, then runs its own", async () => {
    const b = context()
    const a = context()
    const events: string[] = []
    let releaseB!: () => void
    const bHolds = new Promise<void>((r) => (releaseB = r))
    let bInside!: () => void
    const bReady = new Promise<void>((r) => (bInside = r))
    const bDone = withHost(b.ctx, ['read'], async (client) => {
      expect(client.hello.hostKind).toBe('inproc')
      bInside()
      await bHolds
      events.push('b fn done')
    }).then(() => events.push('b host stopped'))
    await bReady
    const aDone = withHost(a.ctx, ['read', 'operate'], async (client) => {
      events.push('a fn')
      expect(client.hello.hostKind).toBe('inproc')
      // A's own host: B's is gone, so nothing B does can stop it.
      return client.call<unknown[]>('projects:list', [])
    })
    // A waits while B's host is up (B would otherwise drain A's work with force when it ends).
    for (let t = 0; t < 200 && !a.err().includes(OTHER_COMMAND_HOST_NOTE); t++) await new Promise((r) => setTimeout(r, 50))
    await new Promise((r) => setTimeout(r, 300))
    expect(events).toEqual([])
    expect(a.err()).toBe(`${OTHER_COMMAND_HOST_NOTE}\n`)
    releaseB()
    await bDone
    expect(Array.isArray(await aDone)).toBe(true)
    expect(events).toEqual(['b fn done', 'b host stopped', 'a fn'])
    expect(a.err()).toBe(`${OTHER_COMMAND_HOST_NOTE}\n${INPROC_FALLBACK_NOTE}\n`)
  }, 60_000)

  it('uses a shared in-process host (daemon start --host inproc) and leaves it running', async () => {
    const shared = context()
    const handle = await shared.ctx.startInproc({ shared: true })
    try {
      const a = context()
      const kind = await withHost(a.ctx, ['read'], async (client) => client.hello.hostKind)
      expect(kind).toBe('inproc')
      expect(a.err()).toBe('')
      // Still serving: another connect reaches it.
      const res = await a.ctx.connect(['read'], { waitStartingMs: 0 })
      expect(res.ok).toBe(true)
      if (res.ok) res.client.close()
    } finally {
      await handle.stop(true)
    }
  }, 60_000)
})
