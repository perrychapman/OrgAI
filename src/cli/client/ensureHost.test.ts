import { describe, expect, it } from 'vitest'
import type { DaemonInfo } from '../../shared/types'
import { SECRET_ENV_IGNORED_WARNING, SECRET_ENV_REFUSAL } from '../secretOverlay'
import { FakeHostClient, fakeContext, fakeInproc, noHost } from '../testing/fakeContext'
import { EXIT, HOST_STARTING_WAIT_MS, type HostLauncherResolution } from '../types'
import {
  ENSURE_HOST_READY_TIMEOUT_MS,
  ensureHost,
  INPROC_FALLBACK_NOTE,
  INPROC_SECRETS_NOTE,
  MANAGEMENT_INPROC,
  NO_BACKGROUND_HOST_MESSAGE
} from './ensureHost'

const ready: DaemonInfo = { hostInstanceId: 'bbbbbbbbbbbb', pid: 77, endpoint: '/tmp/y.sock', state: 'ready', startedAt: 1, hostKind: 'headless-host' }
const BACKGROUND = ['headless-host', 'desktop', 'node']
const found: HostLauncherResolution = { status: 'found', command: '/Applications/OrgAI.app/Contents/MacOS/OrgAI', args: [], source: 'installed' }
const absent: HostLauncherResolution = { status: 'absent', message: 'OrgAI app not found' }

describe('ensureHost', () => {
  it('connects to a running host with the scopes, waiting up to 15 s while it starts', async () => {
    const h = new FakeHostClient()
    const f = fakeContext({ connect: [h] })
    const r = await ensureHost(f.ctx, ['read', 'operate'])
    expect(r).toEqual({ client: h, started: false })
    expect(HOST_STARTING_WAIT_MS).toBe(15_000)
    expect(f.connectCalls).toEqual([{ scopes: ['read', 'operate'], opts: { clientKind: 'cli', waitStartingMs: HOST_STARTING_WAIT_MS } }])
    expect(f.launcherCalls).toEqual([])
  })

  it('no host, app found: spawns that app headless, waits for a background host, then connects', async () => {
    const h = new FakeHostClient()
    const f = fakeContext({ connect: [noHost(), h], launcher: { locate: () => found, waitForReady: async () => ready } })
    const r = await ensureHost(f.ctx, ['read', 'operate'], { interactive: false })
    expect(r.client).toBe(h)
    expect(r.started).toBe(true)
    expect(f.launcherCalls).toEqual([
      { method: 'spawn', args: { headless: true, app: { command: '/Applications/OrgAI.app/Contents/MacOS/OrgAI', args: [], source: 'installed' } } },
      { method: 'waitForReady', args: { timeoutMs: ENSURE_HOST_READY_TIMEOUT_MS, hostKinds: BACKGROUND } }
    ])
    expect(f.connectCalls).toHaveLength(2)
    expect(f.inprocCalls).toEqual([])
    expect(f.err()).toBe('')
  })

  it('no host and the app never gets ready: exit 6; broken: exit 1 naming the path, never in-process; a failed start: exit 1', async () => {
    const f = fakeContext({ connect: [noHost()], launcher: { waitForReady: async () => null } })
    await expect(ensureHost(f.ctx, ['read'])).rejects.toMatchObject({ exitCode: EXIT.hostBusy })
    const g = fakeContext({
      connect: [noHost()],
      launcher: { locate: () => ({ status: 'broken', path: '/Applications/OrgAI.app/Contents/MacOS/OrgAI', message: 'The OrgAI app at /Applications/OrgAI.app is incomplete' }) },
      inproc: async () => fakeInproc()
    })
    await expect(ensureHost(g.ctx, ['read'])).rejects.toMatchObject({ exitCode: EXIT.failure, message: expect.stringContaining('/Applications/OrgAI.app') })
    expect(g.inprocCalls).toEqual([])
    expect(g.launcherCalls).toEqual([])
    const k = fakeContext({
      connect: [noHost()],
      launcher: {
        waitForReady: async () => {
          throw new Error('exited with code 6')
        }
      }
    })
    await expect(ensureHost(k.ctx, ['read'])).rejects.toMatchObject({ exitCode: EXIT.failure, message: expect.stringContaining('exited with code 6') })
  })

  it('--host auto, no host and no app: runs in-process with one stderr note (text mode only), for every caller', async () => {
    const inproc = fakeInproc()
    const h = new FakeHostClient()
    const f = fakeContext({ connect: [noHost(), h], launcher: { locate: () => absent }, inproc: async () => inproc })
    const r = await ensureHost(f.ctx, ['read', 'operate'])
    expect(r).toEqual({ client: h, inproc, started: true })
    expect(f.inprocCalls).toEqual([undefined])
    expect(f.launcherCalls).toEqual([])
    expect(f.err()).toBe(`${INPROC_FALLBACK_NOTE}\n`)
    // A second call of the same command (init's Architect after its withHost) does not repeat the note.
    await ensureHost(f.ctx, ['read'], { clientKind: 'tui' })
    expect(f.err()).toBe(`${INPROC_FALLBACK_NOTE}\n`)
    // JSON output: no note.
    const j = fakeContext({ globals: { outputFormat: 'json' }, connect: [noHost(), h], launcher: { locate: () => absent }, inproc: async () => fakeInproc() })
    await ensureHost(j.ctx, ['read'])
    expect(j.err()).toBe('')
  })

  it('a management command passes its background options to the in-process host; a failed connect stops it', async () => {
    const inproc = fakeInproc()
    const f = fakeContext({ connect: [noHost(), { ok: false, reason: 'auth_failed', message: 'bad proof' }], launcher: { locate: () => absent }, inproc: async () => inproc })
    await expect(ensureHost(f.ctx, ['read'], { inproc: MANAGEMENT_INPROC })).rejects.toMatchObject({ exitCode: EXIT.auth })
    expect(f.inprocCalls).toEqual([MANAGEMENT_INPROC])
    expect(MANAGEMENT_INPROC.background).toEqual({ connectionProbes: true, modelDiscovery: false, communityPrices: false, usageMonitor: false })
    expect(inproc.stops).toEqual([true])
  })

  it('--host daemon never runs in-process: the app when found, else the Node background host hook, else a clear failure', async () => {
    const h = new FakeHostClient()
    const app = fakeContext({ globals: { host: 'daemon' }, connect: [noHost(), h], launcher: { locate: () => found, waitForReady: async () => ready }, inproc: async () => fakeInproc() })
    expect((await ensureHost(app.ctx, ['read'])).started).toBe(true)
    expect(app.launcherCalls.map((c) => c.method)).toEqual(['spawn', 'waitForReady'])
    expect(app.inprocCalls).toEqual([])

    const nodeReady: DaemonInfo = { ...ready, hostKind: 'node' }
    const node = fakeContext({
      globals: { host: 'daemon' },
      connect: [noHost(), h],
      launcher: { locate: () => absent, startBackground: async () => ({ pid: 5 }), waitForReady: async () => nodeReady },
      inproc: async () => fakeInproc()
    })
    expect(await ensureHost(node.ctx, ['read'])).toEqual({ client: h, started: true })
    expect(node.launcherCalls).toEqual([
      { method: 'startBackground', args: 'node' },
      { method: 'waitForReady', args: { timeoutMs: ENSURE_HOST_READY_TIMEOUT_MS, hostKinds: BACKGROUND } }
    ])
    expect(node.inprocCalls).toEqual([])
    expect(node.err()).toBe('')

    const refused = fakeContext({
      globals: { host: 'daemon' },
      connect: [noHost()],
      launcher: {
        locate: () => absent,
        startBackground: async () => {
          throw new Error('Terminal access is off')
        }
      }
    })
    await expect(ensureHost(refused.ctx, ['read'])).rejects.toMatchObject({ exitCode: EXIT.failure, message: expect.stringContaining('Terminal access is off') })

    const none = fakeContext({ globals: { host: 'daemon' }, connect: [noHost()], launcher: { locate: () => absent }, inproc: async () => fakeInproc() })
    await expect(ensureHost(none.ctx, ['read'])).rejects.toMatchObject({ exitCode: EXIT.failure, message: NO_BACKGROUND_HOST_MESSAGE })
    expect(none.inprocCalls).toEqual([])
  })

  it('terminal access off: exit 1 naming App settings > Terminal access, and no app is started', async () => {
    const f = fakeContext({ connect: [{ ok: false, reason: 'disabled', message: '' }] })
    await expect(ensureHost(f.ctx, ['read'])).rejects.toMatchObject({ exitCode: EXIT.failure, message: expect.stringContaining('App settings') })
    await expect(ensureHost(f.ctx, ['read'])).rejects.toMatchObject({ message: expect.stringContaining('Terminal access') })
    expect(f.launcherCalls).toEqual([])
  })

  it('a failed handshake proof is exit 5; draining or still starting exit 6', async () => {
    const a = fakeContext({ connect: [{ ok: false, reason: 'auth_failed', message: 'The handshake proof did not verify.' }] })
    await expect(ensureHost(a.ctx, ['read'])).rejects.toMatchObject({ exitCode: EXIT.auth })
    const d = fakeContext({ connect: [{ ok: false, reason: 'draining', message: 'OrgAI is shutting down.' }] })
    await expect(ensureHost(d.ctx, ['read'])).rejects.toMatchObject({ exitCode: EXIT.hostBusy })
    const s = fakeContext({ connect: [{ ok: false, reason: 'starting', message: 'OrgAI is starting.' }] })
    await expect(ensureHost(s.ctx, ['read'])).rejects.toMatchObject({ exitCode: EXIT.hostBusy })
  })

  it('--host inproc: starts the in-process host, then connects to its socket; a failed connect stops it', async () => {
    const inproc = fakeInproc()
    const h = new FakeHostClient()
    const f = fakeContext({ globals: { host: 'inproc' }, connect: [h], inproc: async () => inproc })
    const r = await ensureHost(f.ctx, ['read', 'operate'])
    expect(r).toEqual({ client: h, inproc, started: true })
    expect(f.launcherCalls).toEqual([])
    expect(inproc.stops).toEqual([])
    expect(f.err()).toBe('')

    const other = fakeInproc()
    const g = fakeContext({ globals: { host: 'inproc' }, connect: [{ ok: false, reason: 'auth_failed', message: 'bad proof' }], inproc: async () => other })
    await expect(ensureHost(g.ctx, ['read'])).rejects.toMatchObject({ exitCode: EXIT.auth })
    expect(other.stops).toEqual([true])
  })

  it("passes clientKind 'tui' through (the terminal UI is an interactive client)", async () => {
    const h = new FakeHostClient()
    const f = fakeContext({ connect: [h] })
    await ensureHost(f.ctx, ['read', 'operate', 'decide'], { clientKind: 'tui' })
    expect(f.connectCalls).toEqual([{ scopes: ['read', 'operate', 'decide'], opts: { clientKind: 'tui', waitStartingMs: HOST_STARTING_WAIT_MS } }])
    const inproc = fakeInproc()
    const g = fakeContext({ globals: { host: 'inproc' }, connect: [h], inproc: async () => inproc })
    await ensureHost(g.ctx, ['read'], { clientKind: 'tui' })
    expect(g.connectCalls[0].opts).toEqual({ clientKind: 'tui', waitStartingMs: HOST_STARTING_WAIT_MS })
  })
})

describe('ensureHost: environment secrets under --host auto (4.1, round 6 item 8)', () => {
  it('no live host: runs in-process even when an app is found (never spawns it), with a note', async () => {
    for (const secretEnv of [
      { explicit: true, ambient: false, usesSecrets: false },
      { explicit: false, ambient: true, usesSecrets: false },
      { explicit: false, ambient: true, usesSecrets: true }
    ]) {
      const inproc = fakeInproc()
      const h = new FakeHostClient()
      const f = fakeContext({ connect: [noHost(), h], launcher: { locate: () => found }, inproc: async () => inproc, secretEnv })
      expect(await ensureHost(f.ctx, ['read'])).toEqual({ client: h, inproc, started: true })
      expect(f.launcherCalls).toEqual([])
      expect(f.err()).toBe(`${INPROC_SECRETS_NOTE}\n`)
    }
  })

  it('a live host: an explicit --secret-env is refused (exit 2) and the connection closed', async () => {
    const h = new FakeHostClient()
    const f = fakeContext({ connect: [h], secretEnv: { explicit: true, ambient: false, usesSecrets: false } })
    await expect(ensureHost(f.ctx, ['read'])).rejects.toMatchObject({ exitCode: EXIT.usage, message: SECRET_ENV_REFUSAL })
    expect(h.closed).toBe(true)
  })

  it('a live host: an ambient ORGAI_SECRET_* is refused by a secret-using command, else warned about once', async () => {
    const h = new FakeHostClient()
    const f = fakeContext({ connect: [h], secretEnv: { explicit: false, ambient: true, usesSecrets: true } })
    await expect(ensureHost(f.ctx, ['read', 'operate'])).rejects.toMatchObject({ exitCode: EXIT.usage, message: SECRET_ENV_REFUSAL })
    expect(h.closed).toBe(true)

    const h2 = new FakeHostClient()
    const g = fakeContext({ globals: { outputFormat: 'json' }, connect: [h2], secretEnv: { explicit: false, ambient: true, usesSecrets: false } })
    expect(await ensureHost(g.ctx, ['read'])).toEqual({ client: h2, started: false })
    await ensureHost(g.ctx, ['read'])
    // A warning a script should still see: printed in JSON mode too, once per command.
    expect(g.err()).toBe(`${SECRET_ENV_IGNORED_WARNING}\n`)
    expect(h2.closed).toBe(false)
  })

  it('no secrets: a live host is used as before', async () => {
    const h = new FakeHostClient()
    const f = fakeContext({ connect: [h] })
    expect(await ensureHost(f.ctx, ['read'])).toEqual({ client: h, started: false })
    expect(f.err()).toBe('')
  })
})
