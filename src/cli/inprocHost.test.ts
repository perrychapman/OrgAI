import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
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
import { connectHost } from './client/hostClient'
import { INPROC_HARD_LIMIT_MESSAGE, inprocCliRoots, inprocHardLimitExit, startInprocHost, type InprocHost } from './inprocHost'
import { CliError } from './types'
import { CLI_VERSION } from './version'

let userDataDir: string
let dataDir: string
const started: InprocHost[] = []

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
    const h = await start()
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

  it('a second host on the same data dir is refused at once with exit 6, naming the owner (spec 4.2)', async () => {
    await start(new Map(), { cwd: '/work/first' })
    const began = Date.now()
    const err = await startInprocHost({ userDataDir, dataDir, env: {}, mock: true, overlay: new Map(), logging: false, startBackground: false, systemCertificates: false }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CliError)
    expect((err as CliError).exitCode).toBe(6)
    expect((err as CliError).message).toBe(`orgai is already running in another terminal (/work/first, pid ${process.pid}). Use that one, or quit it first.`)
    expect(Date.now() - began).toBeLessThan(2000)
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
  it('covers the packaged layout from the unpacked bundle folder', () => {
    const res = '/Applications/OrgAI.app/Contents/Resources'
    const roots = inprocCliRoots(`${res}/app.asar.unpacked/out/cli`, 'darwin')
    expect(roots).toContain(`${res}/app.asar.unpacked/out/cli`)
    expect(roots).toContain(`${res}/bin`)
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
    const first = await startInprocHost({ userDataDir, dataDir, env: {}, mock: true, overlay: new Map(), logging: false, startBackground: false, systemCertificates: false })
    started.push(first)
    const err = await startInprocHost({ userDataDir, dataDir, env: {}, mock: true, overlay: new Map(), logging: false, startBackground: false, systemCertificates: hooks }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CliError)
    expect(calls).toEqual([])
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
