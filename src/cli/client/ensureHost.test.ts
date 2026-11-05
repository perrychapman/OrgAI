import { afterEach, describe, expect, it } from 'vitest'
import type { DaemonInfo } from '../../shared/types'
import { FakeHostClient, fakeContext, fakeInproc, noHost } from '../testing/fakeContext'
import { EXIT } from '../types'
import { ENSURE_HOST_READY_TIMEOUT_MS, ensureHost, missingScopesError, NODE_TERMINAL_FULL_ACCESS_HINT, TERMINAL_FULL_ACCESS_HINT } from './ensureHost'
import { NODE_HOST_TERMINAL_OFF, nodeHostDeps } from '../nodeHost'

const realNodeDeps = { ...nodeHostDeps }
afterEach(() => Object.assign(nodeHostDeps, realNodeDeps))

const ready: DaemonInfo = { hostInstanceId: 'bbbbbbbbbbbb', pid: 77, endpoint: '/tmp/y.sock', state: 'ready', startedAt: 1, hostKind: 'headless-host' }

describe('ensureHost', () => {
  it('connects to a running host with the scopes, waiting while it starts', async () => {
    const h = new FakeHostClient()
    const f = fakeContext({ connect: [h] })
    const r = await ensureHost(f.ctx, ['read', 'operate'])
    expect(r).toEqual({ client: h, started: false })
    expect(f.connectCalls).toEqual([{ scopes: ['read', 'operate'], opts: { clientKind: 'cli', waitStartingMs: 2000 } }])
    expect(f.launcherCalls).toEqual([])
  })

  it('no host: starts the app headless, waits for an Electron host, then connects', async () => {
    const h = new FakeHostClient()
    const f = fakeContext({ connect: [noHost(), h], launcher: { waitForReady: async () => ready } })
    const r = await ensureHost(f.ctx, ['read', 'operate'], { interactive: false })
    expect(r.client).toBe(h)
    expect(r.started).toBe(true)
    expect(f.launcherCalls).toEqual([
      { method: 'resolve', args: undefined },
      { method: 'spawn', args: { headless: true } },
      { method: 'waitForReady', args: { timeoutMs: ENSURE_HOST_READY_TIMEOUT_MS, hostKinds: ['headless-host', 'desktop'] } }
    ])
    expect(f.connectCalls).toHaveLength(2)
  })

  it('no host and the app never gets ready: exit 6; cannot be found or fails to start: exit 1', async () => {
    const f = fakeContext({ connect: [noHost()], launcher: { waitForReady: async () => null } })
    await expect(ensureHost(f.ctx, ['read'])).rejects.toMatchObject({ exitCode: EXIT.hostBusy })
    const g = fakeContext({ connect: [noHost()], launcher: { resolve: () => ({ error: 'OrgAI app not found.' }) } })
    await expect(ensureHost(g.ctx, ['read'])).rejects.toMatchObject({ exitCode: EXIT.failure, message: 'OrgAI app not found.' })
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

    const other = fakeInproc()
    const g = fakeContext({ globals: { host: 'inproc' }, connect: [{ ok: false, reason: 'auth_failed', message: 'bad proof' }], inproc: async () => other })
    await expect(ensureHost(g.ctx, ['read'])).rejects.toMatchObject({ exitCode: EXIT.auth })
    expect(other.stops).toEqual([true])
  })

  it("passes clientKind 'tui' through (the terminal UI is an interactive client)", async () => {
    const h = new FakeHostClient()
    const f = fakeContext({ connect: [h] })
    await ensureHost(f.ctx, ['read', 'operate', 'decide'], { clientKind: 'tui' })
    expect(f.connectCalls).toEqual([{ scopes: ['read', 'operate', 'decide'], opts: { clientKind: 'tui', waitStartingMs: 2000 } }])
    const inproc = fakeInproc()
    const g = fakeContext({ globals: { host: 'inproc' }, connect: [h], inproc: async () => inproc })
    await ensureHost(g.ctx, ['read'], { clientKind: 'tui' })
    expect(g.connectCalls[0].opts).toEqual({ clientKind: 'tui', waitStartingMs: 2000 })
  })

  it('--host daemon with no app anywhere starts the Node host and waits for kind node (Wave 7, 4.1 / 4.2)', async () => {
    nodeHostDeps.installInfo = () => ({ channel: 'npm', source: 'file' })
    nodeHostDeps.terminalAccess = () => ({ terminalServer: false, terminalServerChosen: false, level: 'operate', levelChosen: false, enabledForBackground: true })
    const node: DaemonInfo = { ...ready, hostKind: 'node' }
    const h = new FakeHostClient()
    const absent = { locate: () => ({ status: 'absent' as const, message: 'none' }) }
    const f = fakeContext({ globals: { host: 'daemon' }, connect: [noHost(), h], launcher: { ...absent, startBackground: () => ({ hostKinds: ['node'] }), waitForReady: async () => node } })
    const r = await ensureHost(f.ctx, ['read'])
    expect(r).toEqual({ client: h, started: true })
    // No level chosen: nothing asks here, so a note names the level and how to change it (review round 1).
    expect(f.err()).toContain('Terminal access: operate')
    expect(f.err()).toContain('orgai terminal-access --level full')
    expect(f.launcherCalls).toEqual([
      { method: 'startBackground', args: 'node' },
      { method: 'waitForReady', args: { timeoutMs: ENSURE_HOST_READY_TIMEOUT_MS, hostKinds: ['node'] } }
    ])
    // Terminal access stored off: refused, nothing started.
    nodeHostDeps.terminalAccess = () => ({ terminalServer: false, terminalServerChosen: true, level: 'operate', levelChosen: false, enabledForBackground: false })
    const g = fakeContext({ globals: { host: 'daemon' }, launcher: { ...absent, startBackground: () => ({ hostKinds: ['node'] }) } })
    await expect(ensureHost(g.ctx, ['read'])).rejects.toMatchObject({ exitCode: EXIT.failure, message: NODE_HOST_TERMINAL_OFF })
    expect(g.launcherCalls).toEqual([])
    // An app found: the app, as before.
    const a = fakeContext({ globals: { host: 'daemon' }, connect: [noHost(), new FakeHostClient()], launcher: { startBackground: () => ({ hostKinds: ['node'] }), waitForReady: async () => ready } })
    await ensureHost(a.ctx, ['read'])
    expect(a.launcherCalls.map((c) => c.method)).toEqual(['resolve', 'spawn', 'waitForReady'])
  })

  it('a Node host that withheld a scope names the orgai commands, not App settings (review round 1)', () => {
    const node = new FakeHostClient({}, { hello: { hostKind: 'node', grantedScopes: ['read', 'operate'] } })
    const e = missingScopesError(node, ['read', 'decide'])
    expect(e?.message).toBe(`The OrgAI host did not grant the 'decide' access this needs. ${NODE_TERMINAL_FULL_ACCESS_HINT}`)
    expect(e?.message).not.toContain('App settings')
    const app = new FakeHostClient({}, { hello: { hostKind: 'headless-host', grantedScopes: ['read'] } })
    expect(missingScopesError(app, ['configure'])?.message).toContain(TERMINAL_FULL_ACCESS_HINT)
  })
})
