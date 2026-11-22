import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The real reader would spawn a child that reads the OS certificate store; every test here injects or turns it off,
// except the default check below, which sees these spies.
const certs = vi.hoisted(() => ({ trust: [] as unknown[], stops: 0 }))
vi.mock('../main/systemCerts', () => ({
  trustSystemCertificates: (o: unknown) => void certs.trust.push(o),
  stopSystemCertRead: () => void certs.stops++
}))

import { LITELLM_KEY, READ_ONLY_SECRETS_MESSAGE, type SecretStore } from '../main/store/secrets'
import { fakeCustody } from '../main/store/vaultTesting'
import { VaultNotReady } from '../main/store/vaultTypes'
import { connectProbe } from '../main/host/ownership'
import { connectHost } from './client/hostClient'
import { INPROC_HARD_LIMIT_MESSAGE, inprocCliRoots, inprocHardLimitExit, memoryStreamPair, startInprocHost, type InprocHost } from './inprocHost'
import { CliError, type HostClient } from './types'
import type { HostScope, Project, RunRecord, RunSummary } from '../shared/types'
import { CLI_VERSION } from './version'

let userDataDir: string
let dataDir: string
const started: InprocHost[] = []
/** A second host in this process needs its own instance id (two processes always have different ones). */
const SECOND = 'bbbbbbbbbbbb'

beforeEach(() => {
  userDataDir = realpathSync(mkdtempSync(join(tmpdir(), 'inp-')))
  dataDir = join(userDataDir, 'data')
})
afterEach(async () => {
  for (const h of started.splice(0)) await h.stop(true).catch(() => {})
  rmSync(userDataDir, { recursive: true, force: true })
})

const start = async (overlay: Map<string, string> = new Map(), extra: Partial<Parameters<typeof startInprocHost>[0]> = {}): Promise<InprocHost> => {
  const h = await startInprocHost({ userDataDir, dataDir, env: { ORGAI_MOCK: '1', ORGAI_DAEMON_IDLE_MINUTES: '0' }, mock: true, overlay, logging: false, startBackground: false, systemCertificates: false, ...extra })
  started.push(h)
  return h
}

const secretsOf = (h: InprocHost): SecretStore => (h.host.services.connections as unknown as { deps: { secrets: SecretStore } }).deps.secrets

describe('startInprocHost', () => {
  it('owns the data dir as a ready inproc host and serves the overlay over the vault', async () => {
    const h = await start(new Map([[LITELLM_KEY, 'sk-overlay']]))
    const daemon = JSON.parse(readFileSync(join(dataDir, 'run', 'daemon.json'), 'utf8')) as Record<string, unknown>
    expect(daemon).toMatchObject({ hostKind: 'inproc', state: 'ready', pid: process.pid })
    expect(h.status()).toMatchObject({ hostKind: 'inproc', state: 'ready', mock: true, dataDir })
    const secrets = secretsOf(h)
    expect(secrets.get(LITELLM_KEY)).toBe('sk-overlay')
    // Wave 7: no vault until a value is stored, and only after prepareWrite (the bug trap of 5.6)
    expect(secrets.state()).toBe('absent')
    expect(() => secrets.set(LITELLM_KEY, 'other')).toThrow(VaultNotReady)
    // the default custodian is the real one, which the test runner turns off for the OS key stores (vitest.config.ts): values are refused with why
    await expect(secrets.prepareWrite()).rejects.toThrow(/not available in this build yet/)
    expect(existsSync(join(dataDir, 'vault.json'))).toBe(false)
  })

  it('with a key custodian, the first stored value creates vault.json lazily (Wave 7, cli-standalone.md 5.6)', async () => {
    const custody = fakeCustody()
    const h = await start(new Map(), { custodian: custody.factory })
    const secrets = secretsOf(h)
    expect(custody.calls.create).toBe(0)
    await secrets.prepareWrite()
    secrets.set(LITELLM_KEY, 'sk-stored')
    expect(custody.calls.create).toBe(1)
    expect(secrets.state()).toBe('open')
    expect(readFileSync(join(dataDir, 'vault.json'), 'utf8')).not.toContain('sk-stored')
    expect(existsSync(join(dataDir, 'secrets.json'))).toBe(false)
    await h.stop(true)
    const again = await start(new Map(), { custodian: custody.factory })
    expect(secretsOf(again).get(LITELLM_KEY)).toBe('sk-stored')
  })

  it('writes ownerCwd to daemon.json: the folder the owning process started in', async () => {
    await start(new Map(), { cwd: '/work/some/project' })
    expect(JSON.parse(readFileSync(join(dataDir, 'run', 'daemon.json'), 'utf8')).ownerCwd).toBe('/work/some/project')
  })

  it('serves only its own process: a hello without the in-memory owner proof is refused not_owner (spec 4.1)', async () => {
    const h = await start(new Map(), { listen: true })
    expect(h.ownerKey).toMatch(/^[0-9a-f]{64}$/)
    expect(h.hostInstanceId).toBe(JSON.parse(readFileSync(join(dataDir, 'run', 'daemon.json'), 'utf8')).hostInstanceId)
    // The key is never written to the run folder.
    for (const f of readdirSync(join(dataDir, 'run'))) {
      const p = join(dataDir, 'run', f)
      if (statSync(p).isFile()) expect(readFileSync(p, 'utf8'), f).not.toContain(h.ownerKey!)
    }
    const all = ['read', 'operate', 'decide', 'configure'] as const
    const base = { dataDir, scopes: [...all], clientVersion: CLI_VERSION, cwd: userDataDir, pid: process.pid }
    // Another process that read daemon.secret (an agent's shell, a forged pid and client kind): refused before any method.
    const other = await connectHost(base)
    expect(other).toMatchObject({ ok: false, reason: 'not_owner' })
    const forged = await connectHost({ ...base, clientKind: 'tui', pid: 1 })
    expect(forged).toMatchObject({ ok: false, reason: 'not_owner' })
    // The owner key only counts for the host it belongs to.
    const wrongHost = await connectHost({ ...base, ownerKey: h.ownerKey!, ownerHostInstanceId: 'ffffffffffff' })
    expect(wrongHost).toMatchObject({ ok: false, reason: 'not_owner' })
    const owner = await connectHost({ ...base, ownerKey: h.ownerKey!, ownerHostInstanceId: h.hostInstanceId! })
    if (!owner.ok) throw new Error(owner.message)
    expect(owner.client.hello.grantedScopes).toEqual([...all])
    owner.client.close()
  })

  it('listens on nothing by default and serves its own process through connectLocal (surface inproc)', async () => {
    const h = await start()
    const daemon = JSON.parse(readFileSync(join(dataDir, 'run', 'daemon.json'), 'utf8')) as Record<string, unknown>
    expect(daemon.listening).toBe(false)
    expect(existsSync(join(dataDir, 'run', 'daemon.secret'))).toBe(false)
    // A foreign process finds no listener.
    const foreign = await connectHost({ dataDir, scopes: ['read'], clientVersion: CLI_VERSION, cwd: userDataDir, pid: process.pid })
    expect(foreign).toMatchObject({ ok: false, reason: 'refused' })
    const c = await h.connectLocal!(['read', 'operate', 'configure'], { clientKind: 'tui' })
    if (!c.ok) throw new Error(c.message)
    expect(c.client.hello.grantedScopes).toEqual(['read', 'operate', 'configure'])
    const status = await c.client.call<{ state: string }>('host.status')
    expect(status.state).toBe('ready')
    // Scopes still gate: no 'decide' was granted.
    await expect(c.client.call('runs:decide', [{}])).rejects.toMatchObject({ data: { code: 'scope_denied' } })
    // A host that needs the folder to itself (a socket, `listen: true`) is refused while this one runs, socket or not.
    await expect(startInprocHost({ userDataDir, dataDir, env: {}, mock: true, overlay: new Map(), logging: false, startBackground: false, systemCertificates: false, listen: true, hostInstanceId: SECOND })).rejects.toMatchObject({ exitCode: 6 })
    c.client.close()
  })

  it('a host that owns the data dir alone (an older orgai, or one serving a socket) refuses a second one at once with exit 6, naming the owner (spec 4.2)', async () => {
    // `listen: true` writes the record an orgai from before sessions writes: no `sessions`, so nobody may join it.
    await start(new Map(), { cwd: '/work/first', listen: true })
    expect(JSON.parse(readFileSync(join(dataDir, 'run', 'daemon.json'), 'utf8')).sessions).toBeUndefined()
    const began = Date.now()
    const err = await startInprocHost({ userDataDir, dataDir, env: {}, mock: true, overlay: new Map(), logging: false, startBackground: false, systemCertificates: false, hostInstanceId: SECOND }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CliError)
    expect((err as CliError).exitCode).toBe(6)
    const message = (err as CliError).message
    expect(message.startsWith(`orgai is already running in another terminal (/work/first, pid ${process.pid}). Use that one, or quit it first.`)).toBe(true)
    // Review M2 (PR 49): the way out when nothing is really running names the run folder.
    expect(message).toContain('If you are sure no OrgAI (and no orgai terminal host) is running')
    expect(message).toContain(join(dataDir, 'run'))
    expect(Date.now() - began).toBeLessThan(2000)
  })

  it('a host that listens on nothing binds a liveness-only endpoint: livenessProbe in daemon.json, accepts and closes, no daemon.secret, gone on stop', async () => {
    const h = await start()
    const daemon = JSON.parse(readFileSync(join(dataDir, 'run', 'daemon.json'), 'utf8')) as Record<string, unknown>
    expect(daemon).toMatchObject({ listening: false, livenessProbe: true, hostKind: 'inproc' })
    expect(existsSync(join(dataDir, 'run', 'daemon.secret'))).toBe(false)
    expect(await connectProbe(daemon.endpoint as string, 1000)).toBe('connected')
    await h.stop(true)
    expect(existsSync(join(dataDir, 'run', 'daemon.json'))).toBe(false)
    expect(await connectProbe(daemon.endpoint as string, 1000)).not.toBe('connected')
  })

  it('an unreadable daemon.json is the owned refusal (exit 6), not the raw ownership error (spec 4.2)', async () => {
    const first = await start(new Map())
    const file = join(dataDir, 'run', 'daemon.json')
    const good = readFileSync(file, 'utf8')
    const { writeFileSync } = await import('node:fs')
    // Unparseable, but the live owner still holds the folder: not provably stale.
    writeFileSync(file, '{ not json')
    const err = await startInprocHost({ userDataDir, dataDir, env: {}, mock: true, overlay: new Map(), logging: false, startBackground: false, systemCertificates: false }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CliError)
    expect((err as CliError).exitCode).toBe(6)
    expect((err as CliError).message).toMatch(/^orgai is already running/)
    expect((err as CliError).message).not.toContain('daemon.json')
    writeFileSync(file, good)
    await first.stop(true)
  })

  it('holds ownership warnings until logging is open: nothing reaches console or the logger beforehand', async () => {
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const { log } = await import('../main/log')
    mkdirSync(join(dataDir, 'run'), { recursive: true })
    // Unusable (no host fields) but naming a pid that is gone: reclaimed with a warning.
    writeFileSync(join(dataDir, 'run', 'daemon.json'), JSON.stringify({ pid: 2147483646 }))
    const savedConsole = { log: console.log, info: console.info, debug: console.debug, error: console.error }
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const logWarn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    try {
      await start(new Map(), { quiet: true })
      expect(consoleWarn).not.toHaveBeenCalled()
      expect(logWarn).toHaveBeenCalledWith(expect.stringContaining('replacing an unusable daemon.json'))
    } finally {
      consoleWarn.mockRestore()
      logWarn.mockRestore()
      Object.assign(console, savedConsole)
    }
  })

  it('stop(true) drains and releases daemon.json', async () => {
    const h = await start()
    await h.stop(true)
    await h.closed
    expect(existsSync(join(dataDir, 'run', 'daemon.json'))).toBe(false)
    // Stopping again is a no-op.
    await h.stop(true)
  })
})

describe('inprocCliRoots (cli-spec 7, Wave 6)', () => {
  it('covers a bundle folder wherever it sits (no packaged app layout)', () => {
    const roots = inprocCliRoots('/usr/lib/node_modules/orgai-cli/out/cli', 'darwin')
    expect(roots).toEqual(['/usr/lib/node_modules/orgai-cli/out/cli', '/usr/lib/node_modules/orgai-cli/src/cli'])
    expect(new Set(roots).size).toBe(roots.length)
  })

  it('a dev checkout keeps out/cli and src/cli only', () => {
    expect(inprocCliRoots('/repo/out/cli', 'linux')).toEqual(['/repo/out/cli', '/repo/src/cli'])
    expect(inprocCliRoots('/repo/src/cli', 'linux')).toEqual(['/repo/out/cli', '/repo/src/cli'])
  })
})

describe('startInprocHost system certificates (issue #16)', () => {
  it('trusts the OS store once after taking ownership and stops the read when the host ends', async () => {
    const calls: string[] = []
    const env = { ORGAI_MOCK: '1', ORGAI_DAEMON_IDLE_MINUTES: '0' }
    const h = await startInprocHost({
      userDataDir,
      dataDir,
      env,
      mock: true,
      overlay: new Map(),
      logging: false,
      startBackground: false,
      systemCertificates: {
        trust: (e) => {
          // Ownership is already taken: daemon.json exists before the read starts.
          calls.push(`trust:${e === env}:${existsSync(join(dataDir, 'run', 'daemon.json'))}`)
        },
        stop: () => calls.push('stop')
      }
    })
    expect(calls).toEqual(['trust:true:true'])
    await h.stop(true)
    expect(calls).toEqual(['trust:true:true', 'stop'])
  })

  it('trusts the system certificates by default even with background work off (Wave 7, 4.1 step 4)', async () => {
    certs.trust.length = 0
    certs.stops = 0
    const env = { ORGAI_MOCK: '1', ORGAI_DAEMON_IDLE_MINUTES: '0' }
    const h = await startInprocHost({ userDataDir, dataDir, env, mock: true, overlay: new Map(), logging: false, startBackground: false })
    expect(certs.trust).toEqual([{ env }])
    await h.stop(true)
    expect(certs.stops).toBeGreaterThanOrEqual(1)
  })

  it('does nothing with systemCertificates false, and a host that fails to take ownership never starts the read', async () => {
    const calls: string[] = []
    const hooks = { trust: () => calls.push('trust'), stop: () => calls.push('stop') }
    const first = await startInprocHost({ userDataDir, dataDir, env: {}, mock: true, overlay: new Map(), logging: false, startBackground: false, systemCertificates: false, listen: true })
    started.push(first)
    const err = await startInprocHost({ userDataDir, dataDir, env: {}, mock: true, overlay: new Map(), logging: false, startBackground: false, systemCertificates: hooks, hostInstanceId: SECOND }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CliError)
    expect(calls).toEqual([])
  })
})

describe('sessions: several hosts on one data folder (docs/design/cli-sessions.md)', () => {
  const all = ['read', 'operate', 'configure', 'decide'] as HostScope[]
  const clientOf = async (h: InprocHost): Promise<HostClient> => {
    const c = await h.connectLocal!(all, {})
    if (!c.ok) throw new Error(c.message)
    return c.client
  }
  const daemon = (): Record<string, unknown> | undefined => {
    try {
      return JSON.parse(readFileSync(join(dataDir, 'run', 'daemon.json'), 'utf8')) as Record<string, unknown>
    } catch {
      return undefined
    }
  }
  const until = async (what: string, fn: () => Promise<boolean>): Promise<void> => {
    const end = Date.now() + 20_000
    while (Date.now() < end) {
      if (await fn()) return
      await new Promise((r) => setTimeout(r, 25))
    }
    throw new Error(`timed out waiting for ${what}`)
  }

  it('a second host joins: both are ready, one is advertised, each sees the other', async () => {
    const first = await start(new Map(), { cwd: '/work/first', command: 'tui' })
    const second = await start(new Map(), { cwd: '/work/second', command: 'exec', hostInstanceId: SECOND })
    expect([first.status().state, second.status().state]).toEqual(['ready', 'ready'])
    expect([first.ownership.advertised, second.ownership.advertised]).toEqual([true, false])
    expect(daemon()).toMatchObject({ hostInstanceId: first.hostInstanceId, sessions: true, state: 'ready' })
    expect(first.otherSessions!().map((s) => [s.cwd, s.command])).toEqual([['/work/second', 'exec']])
    expect(second.otherSessions!().map((s) => [s.cwd, s.command])).toEqual([['/work/first', 'tui']])
    // The advertised one ends: the record names the other at once, and it knows it is the advertised host now.
    await first.stop(true)
    expect(daemon()).toMatchObject({ hostInstanceId: SECOND, sessions: true })
    expect(second.ownership.adopt()).toBe(true)
    expect(second.otherSessions!()).toEqual([])
    await second.stop(true)
    expect(daemon()).toBeUndefined()
    expect(existsSync(join(dataDir, 'run', 'sessions', `${SECOND}.json`))).toBe(false)
  })

  it('housekeeping runs only for a host that is alone on the folder', async () => {
    const orphan = (name: string): string => join(dataDir, 'runs', `${name}.json`)
    mkdirSync(join(dataDir, 'runs'), { recursive: true })
    writeFileSync(orphan('run_left_by_nobody'), '{}')
    const first = await start()
    // Alone at its start: a record file no run points to is removed.
    expect(existsSync(orphan('run_left_by_nobody'))).toBe(false)
    // While it runs, a file appears that the index does not list (a run another session is just creating looks like this).
    writeFileSync(orphan('run_being_created'), '{}')
    const second = await start(new Map(), { hostInstanceId: SECOND })
    expect(existsSync(orphan('run_being_created'))).toBe(true)
    await first.stop(true)
    await second.stop(true)
    // The next lone host cleans it up.
    const third = await start()
    expect(existsSync(orphan('run_being_created'))).toBe(false)
    void third
  })

  it('two hosts work in the same project: each hosts its own run, reads the other\'s, and neither undoes the other\'s saves', async () => {
    const dirA = join(userDataDir, 'proj-a')
    mkdirSync(dirA)
    const first = await start(new Map(), { cwd: '/term/one', command: 'tui' })
    const second = await start(new Map(), { cwd: '/term/two', command: 'tui', hostInstanceId: SECOND })
    const a = await clientOf(first)
    const b = await clientOf(second)
    const projA = await a.call<Project>('projects:create', [{ name: 'Alpha', path: dirA, brief: '', mock: true }])
    // Each terminal opens the project and learns who else is in it.
    expect(first.openProject!(projA.id)).toEqual({ ok: true, others: [] })
    expect(second.openProject!(projA.id)).toMatchObject({ ok: true, others: [{ pid: process.pid, cwd: '/term/one' }] })

    // A run in each, in the one project.
    const runA = await a.call<RunSummary>('runs:start', [{ projectId: projA.id, prompt: 'first terminal', team: 'single' }])
    const runB = await b.call<RunSummary>('runs:start', [{ projectId: projA.id, prompt: 'second terminal', team: 'single' }])
    const statusOf = async (c: HostClient, id: string): Promise<string | undefined> => (await c.call<RunRecord | null>('runs:get', [id]))?.summary.status
    await until('both runs to go idle', async () => (await statusOf(a, runA.id)) === 'idle' && (await statusOf(b, runB.id)) === 'idle')

    // Each sees both runs; the other terminal's is marked with where it is live.
    const seenByB = await b.call<RunSummary[]>('runs:list', [projA.id])
    expect(seenByB.map((r) => r.id).sort()).toEqual([runA.id, runB.id].sort())
    expect(seenByB.find((r) => r.id === runA.id)?.liveElsewhere).toEqual({ pid: process.pid, cwd: '/term/one', command: 'tui' })
    expect(seenByB.find((r) => r.id === runB.id)?.liveElsewhere).toBeUndefined()
    expect((await a.call<RunSummary[]>('runs:list', [projA.id])).find((r) => r.id === runB.id)?.liveElsewhere).toMatchObject({ cwd: '/term/two' })
    // Its record can be read here as its host last saved it (a live record is written every 1.5 s), marked the same way.
    await until('the first host to save its run record', async () => (await b.call<RunRecord | null>('runs:get', [runA.id])) !== null)
    expect((await b.call<RunRecord | null>('runs:get', [runA.id]))?.summary).toMatchObject({ id: runA.id, status: 'idle', liveElsewhere: { cwd: '/term/one' } })

    // A run is steered where it is hosted: the other terminal cannot send to it or stop it.
    for (const [channel, params] of [
      ['runs:send', [{ runId: runA.id, text: 'from the other terminal' }]],
      ['runs:stop', [runA.id]]
    ] as const) {
      await expect(b.call(channel, [...params])).rejects.toMatchObject({ data: { code: 'session_busy' } })
    }
    await expect(b.call('runs:send', [{ runId: runA.id, text: 'x' }])).rejects.toThrow(/is live in another orgai session \(\/term\/one, pid \d+\)/)
    await b.call('runs:send', [{ runId: runB.id, text: 'more from the second terminal' }])
    expect(await statusOf(a, runA.id)).toBe('idle')

    // Both save the project from copies read before the other's save: both changes are kept.
    const copyA = await a.call<Project>('projects:get', [projA.id])
    const copyB = await b.call<Project>('projects:get', [projA.id])
    await a.call('projects:save', [{ ...copyA, brief: 'the brief, from terminal one' }])
    await b.call('projects:save', [{ ...copyB, name: 'Alpha renamed in terminal two' }])
    for (const c of [a, b]) {
      expect(await c.call<Project>('projects:get', [projA.id])).toMatchObject({ brief: 'the brief, from terminal one', name: 'Alpha renamed in terminal two' })
    }

    // What needs the project alone is refused while the other terminal is in it: removing it, taking OrgAI out of it.
    await expect(b.call('projects:remove', [{ projectId: projA.id }])).rejects.toMatchObject({ data: { code: 'session_busy' } })
    await expect(b.call('projects:remove', [{ projectId: projA.id }])).rejects.toThrow(/is open in another orgai session \(\/term\/one, pid \d+\)\. Quit it there first\./)
    await expect(b.call('maintenance:uninstallRepo', [projA.id])).rejects.toThrow(/is open in another orgai session/)
    expect((await a.call<Project[]>('projects:list', [])).map((p) => p.id)).toEqual([projA.id])

    const index = JSON.parse(readFileSync(join(dataDir, 'runs.json'), 'utf8')) as { runs: RunSummary[]; owners: Record<string, string> }
    expect(index.owners).toEqual({ [runA.id]: first.hostInstanceId, [runB.id]: SECOND })
    expect(JSON.stringify(index)).not.toContain('liveElsewhere')

    // The first terminal quits with its run open: the second sees that run ended, and now has the project to itself.
    a.close()
    await first.stop(true)
    expect((await b.call<RunRecord | null>('runs:get', [runA.id]))?.summary).toMatchObject({ status: 'finished', endedBy: 'app' })
    expect((await b.call<RunSummary[]>('runs:list', [projA.id])).some((r) => r.liveElsewhere)).toBe(false)
    expect(second.openProject!(projA.id)).toEqual({ ok: true, others: [] })
    // Its own run was never touched by the other terminal's end.
    await until('the second run to go idle again', async () => (await statusOf(b, runB.id)) === 'idle')
    b.close()
  }, 60_000)

  it('settings one host saves reach the other, and neither drops the other\'s change', async () => {
    const first = await start()
    const second = await start(new Map(), { hostInstanceId: SECOND })
    const a = await clientOf(first)
    const b = await clientOf(second)
    const before = await b.call<Record<string, unknown>>('settings:get', [])
    await a.call('settings:set', [{ ...(await a.call<Record<string, unknown>>('settings:get', [])), defaultMaxBudgetUsd: 9 }])
    // b still holds the settings from before a's save and changes another field.
    await b.call('settings:set', [{ ...before, displayName: 'Ada' }])
    expect(await a.call<Record<string, unknown>>('settings:get', [])).toMatchObject({ defaultMaxBudgetUsd: 9, displayName: 'Ada' })
    a.close()
    b.close()
  })
})

describe('inprocHardLimitExit (cli-standalone.md 4.3)', () => {
  it('ends the process with EXIT.failure and tells the terminal from the last exit listener', () => {
    const order: string[] = []
    const listeners: (() => void)[] = []
    const proc = {
      once: (ev: string, fn: () => void) => {
        order.push(`once:${ev}`)
        listeners.push(fn)
        return proc
      },
      exit: (code?: number) => {
        order.push(`exit:${code}`)
        // process.exit runs the 'exit' listeners (the terminal UI's restore was registered earlier, so it runs first).
        for (const l of listeners) l()
        return undefined as never
      }
    }
    inprocHardLimitExit(proc as unknown as Pick<NodeJS.Process, 'once' | 'exit'>, (s) => void order.push(`write:${s.trim()}`))
    expect(order).toEqual(['once:exit', 'exit:1', `write:${INPROC_HARD_LIMIT_MESSAGE}`])
  })
})

describe('memoryStreamPair', () => {
  const tick = (): Promise<void> => new Promise((r) => setImmediate(r))
  it('a writer waits while the reader is full, and goes on once the reader reads (socket-like backpressure)', async () => {
    const [a, b] = memoryStreamPair(16)
    b.pause()
    let written = 0
    a.write(Buffer.alloc(32, 1), () => written++)
    await tick()
    expect(written).toBe(0)
    const got: Buffer[] = []
    b.on('data', (c: Buffer) => got.push(c))
    b.resume()
    await tick()
    await tick()
    expect(written).toBe(1)
    expect(Buffer.concat(got).length).toBe(32)
    a.destroy()
  })
  it('a write parked on a full reader settles when either side is destroyed', async () => {
    const [a, b] = memoryStreamPair(16)
    b.pause()
    let settled = 0
    a.on('error', () => undefined)
    a.write(Buffer.alloc(32, 1), () => settled++)
    await tick()
    expect(settled).toBe(0)
    b.destroy()
    await tick()
    await tick()
    expect(settled).toBe(1)
  })
  it('defaults to a 1 MiB high-water mark, which is backpressure and not a cap: a frame of several MiB still flows whole', async () => {
    const [a, b] = memoryStreamPair()
    expect(a.writableHighWaterMark).toBe(1024 * 1024)
    expect(b.readableHighWaterMark).toBe(1024 * 1024)
    const frame = Buffer.alloc(5 * 1024 * 1024 + 123, 7)
    const chunks: Buffer[] = []
    b.on('data', (c: Buffer) => chunks.push(c))
    const done = new Promise<void>((r) => b.on('end', () => r()))
    await new Promise<void>((ok) => a.write(frame, () => ok()))
    a.end()
    await done
    const got = Buffer.concat(chunks)
    expect(got.length).toBe(frame.length)
    expect(got.equals(frame)).toBe(true)
  })
  it('a small write completes at once, and ending one side ends the other', async () => {
    const [a, b] = memoryStreamPair()
    let written = 0
    const got: Buffer[] = []
    b.on('data', (c: Buffer) => got.push(c))
    const ended = new Promise<void>((r) => b.on('end', () => r()))
    a.write(Buffer.from('hi'), () => written++)
    a.end()
    await ended
    expect(written).toBe(1)
    expect(Buffer.concat(got).toString()).toBe('hi')
  })
})
