import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
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
  missingScopesError,
  NO_BACKGROUND_HOST_MESSAGE,
  NODE_TERMINAL_FULL_ACCESS_HINT,
  OTHER_COMMAND_HOST_MESSAGE,
  OTHER_COMMAND_HOST_NOTE,
  TERMINAL_FULL_ACCESS_HINT
} from './ensureHost'
import { markSharedHost } from './sharedHost'
import { NODE_HOST_TERMINAL_OFF, nodeHostDeps } from '../nodeHost'
import { HostTakenError } from './launcher'

const realNodeDeps = { ...nodeHostDeps }
afterEach(() => Object.assign(nodeHostDeps, realNodeDeps))

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
      launcher: { locate: () => absent, startBackground: () => ({ pid: 5, hostKinds: ['node'] }), waitForReady: async () => nodeReady },
      inproc: async () => fakeInproc()
    })
    expect(await ensureHost(node.ctx, ['read'])).toEqual({ client: h, started: true })
    expect(node.launcherCalls).toEqual([
      { method: 'startBackground', args: 'node' },
      { method: 'waitForReady', args: { timeoutMs: ENSURE_HOST_READY_TIMEOUT_MS, hostKinds: ['node'] } }
    ])
    expect(node.inprocCalls).toEqual([])
    expect(node.err()).toContain('Terminal access: operate')

    const refused = fakeContext({
      globals: { host: 'daemon' },
      connect: [noHost()],
      launcher: {
        locate: () => absent,
        startBackground: () => {
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

describe("ensureHost: another command's own in-process host (WP-B review round 2)", () => {
  const OTHER = 'cccccccccccc'
  /** A live inproc host that belongs to another terminal's command. */
  const otherInproc = (): FakeHostClient => new FakeHostClient({}, { hello: { hostKind: 'inproc', hostInstanceId: OTHER, grantedScopes: ['read', 'operate', 'decide', 'configure'] } })
  let dirs: string[] = []
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true })
    dirs = []
  })
  const dataDirWithRun = (): { userDataDir: string; dataDir: string } => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'ens-'))
    dirs.push(userDataDir)
    const dataDir = join(userDataDir, 'data')
    mkdirSync(join(dataDir, 'run'), { recursive: true })
    return { userDataDir, dataDir }
  }

  it('--host auto never attaches to it: waits for it to go, then runs its own in-process host', async () => {
    const other = otherInproc()
    const inproc = fakeInproc()
    const h = new FakeHostClient()
    const f = fakeContext({ connect: [other, noHost(), h], launcher: { locate: () => absent }, inproc: async () => inproc })
    const r = await ensureHost(f.ctx, ['read', 'operate'])
    expect(r).toEqual({ client: h, inproc, started: true })
    expect(other.closed).toBe(true)
    expect(other.calls).toEqual([])
    expect(f.launcherCalls[0]).toEqual({ method: 'waitForGone', args: { timeoutMs: expect.any(Number), hostInstanceId: OTHER } })
    expect((f.launcherCalls[0].args as { timeoutMs: number }).timeoutMs).toBeLessThanOrEqual(HOST_STARTING_WAIT_MS)
    expect(f.err()).toBe(`${OTHER_COMMAND_HOST_NOTE}\n${INPROC_FALLBACK_NOTE}\n`)
  })

  it('still there after the wait: exit 6 with the message, nothing started', async () => {
    const other = otherInproc()
    const f = fakeContext({ connect: [other], launcher: { locate: () => absent, waitForGone: async () => false }, inproc: async () => fakeInproc() })
    await expect(ensureHost(f.ctx, ['read'])).rejects.toMatchObject({ exitCode: EXIT.hostBusy, message: OTHER_COMMAND_HOST_MESSAGE })
    expect(f.inprocCalls).toEqual([])
    expect(f.launcherCalls.map((c) => c.method)).toEqual(['waitForGone'])
    // One that keeps coming back (a fake that says gone at once) gives up after a bounded number of rounds.
    const g = fakeContext({ connect: [otherInproc()], launcher: { locate: () => absent } })
    await expect(ensureHost(g.ctx, ['read'])).rejects.toMatchObject({ exitCode: EXIT.hostBusy, message: OTHER_COMMAND_HOST_MESSAGE })
    expect(g.launcherCalls.length).toBeLessThanOrEqual(5)
  })

  it('one that is draining is waited out too, instead of exit 6', async () => {
    const draining = { ok: false as const, reason: 'draining' as const, message: 'OrgAI is shutting down.', daemon: { ...ready, hostKind: 'inproc' as const, hostInstanceId: OTHER } }
    const inproc = fakeInproc()
    const h = new FakeHostClient()
    const f = fakeContext({ connect: [draining, noHost(), h], launcher: { locate: () => absent }, inproc: async () => inproc })
    expect(await ensureHost(f.ctx, ['read'])).toEqual({ client: h, inproc, started: true })
    expect(f.launcherCalls[0]).toMatchObject({ method: 'waitForGone', args: { hostInstanceId: OTHER } })
    // A draining background host is still exit 6 (unchanged).
    const g = fakeContext({ connect: [{ ...draining, daemon: ready }] })
    await expect(ensureHost(g.ctx, ['read'])).rejects.toMatchObject({ exitCode: EXIT.hostBusy })
  })

  it('a shared in-process host (daemon start --host inproc) is attached to like any live host', async () => {
    const paths = dataDirWithRun()
    const unmark = markSharedHost(paths.dataDir, OTHER)
    const other = otherInproc()
    const f = fakeContext({ paths, connect: [other], launcher: { locate: () => absent } })
    expect(await ensureHost(f.ctx, ['read'])).toEqual({ client: other, started: false })
    expect(f.launcherCalls).toEqual([])
    expect(other.closed).toBe(false)
    // Its marker gone (the host ended): no longer attached to.
    unmark()
    const g = fakeContext({ paths, connect: [otherInproc(), noHost(), new FakeHostClient()], launcher: { locate: () => absent }, inproc: async () => fakeInproc() })
    expect((await ensureHost(g.ctx, ['read'])).started).toBe(true)
  })

  it("this context's own in-process host, still running, is attached to", async () => {
    const own = fakeInproc({ hostInstanceId: OTHER })
    const first = new FakeHostClient({}, { hello: { hostKind: 'inproc', hostInstanceId: OTHER } })
    const f = fakeContext({ globals: { host: 'inproc' }, connect: [first, otherInproc()], inproc: async () => own })
    await ensureHost(f.ctx, ['read'])
    f.ctx.globals.host = 'auto'
    const again = await ensureHost(f.ctx, ['read'])
    expect(again.started).toBe(false)
    expect(f.launcherCalls).toEqual([])
    // Once it stopped, a host with that id is no longer this context's own.
    await own.stop(true)
    await own.closed
    await Promise.resolve()
    const g = await ensureHost(f.ctx, ['read']).catch((e: unknown) => e)
    expect(g).toMatchObject({ exitCode: EXIT.hostBusy })
  })

  it('env secrets: such a host is never a live host for the refusal; the command waits, then uses them in-process', async () => {
    const inproc = fakeInproc()
    const h = new FakeHostClient()
    const f = fakeContext({ connect: [otherInproc(), noHost(), h], launcher: { locate: () => found }, inproc: async () => inproc, secretEnv: { explicit: true, ambient: false, usesSecrets: true } })
    expect(await ensureHost(f.ctx, ['read', 'operate'])).toEqual({ client: h, inproc, started: true })
    expect(f.launcherCalls.map((c) => c.method)).toEqual(['waitForGone'])
    expect(f.err()).toBe(`${OTHER_COMMAND_HOST_NOTE}\n${INPROC_SECRETS_NOTE}\n`)
  })

  it('--host daemon waits it out too, then starts a background host', async () => {
    const h = new FakeHostClient()
    const f = fakeContext({ globals: { host: 'daemon' }, connect: [otherInproc(), noHost(), h], launcher: { locate: () => found, waitForReady: async () => ready } })
    expect(await ensureHost(f.ctx, ['read'])).toEqual({ client: h, started: true })
    expect(f.launcherCalls.map((c) => c.method)).toEqual(['waitForGone', 'spawn', 'waitForReady'])
  })

  it('--host daemon with no app anywhere starts the background host and waits for kind node (Wave 7, 4.1 / 4.2)', async () => {
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
    expect(a.launcherCalls.map((c) => c.method)).toEqual(['spawn', 'waitForReady'])
  })

  it('a started host that hands off to a live host of another kind (a lost start race) uses that host (review round 2)', async () => {
    nodeHostDeps.installInfo = () => ({ channel: 'npm', source: 'file' })
    nodeHostDeps.terminalAccess = () => ({ terminalServer: false, terminalServerChosen: false, level: 'operate', levelChosen: true, enabledForBackground: true })
    const absent = { locate: () => ({ status: 'absent' as const, message: 'none' }) }
    const inproc: DaemonInfo = { ...ready, hostKind: 'inproc' }
    const taken = async (): Promise<never> => {
      throw new HostTakenError(inproc)
    }
    const h = new FakeHostClient()
    const f = fakeContext({ globals: { host: 'daemon' }, connect: [noHost(), h], launcher: { ...absent, startBackground: () => ({ hostKinds: ['node'] }), waitForReady: taken } })
    expect(await ensureHost(f.ctx, ['read'])).toEqual({ client: h, started: false })
    // The app path too.
    const k = new FakeHostClient()
    const g = fakeContext({ connect: [noHost(), k], launcher: { waitForReady: taken } })
    expect(await ensureHost(g.ctx, ['read'])).toEqual({ client: k, started: false })
    // That host refusing this terminal is the usual connect failure.
    const r = fakeContext({ connect: [noHost(), { ok: false, reason: 'disabled', message: '' }], launcher: { waitForReady: taken } })
    await expect(ensureHost(r.ctx, ['read'])).rejects.toMatchObject({ exitCode: EXIT.failure, message: expect.stringContaining('Terminal access') })
  })

  it('a background host that withheld a scope names the orgai commands, not App settings (review round 1)', () => {
    const node = new FakeHostClient({}, { hello: { hostKind: 'node', grantedScopes: ['read', 'operate'] } })
    const e = missingScopesError(node, ['read', 'decide'])
    expect(e?.message).toBe(`The OrgAI host did not grant the 'decide' access this needs. ${NODE_TERMINAL_FULL_ACCESS_HINT}`)
    expect(e?.message).not.toContain('App settings')
    const app = new FakeHostClient({}, { hello: { hostKind: 'headless-host', grantedScopes: ['read'] } })
    expect(missingScopesError(app, ['configure'])?.message).toContain(TERMINAL_FULL_ACCESS_HINT)
  })
})
