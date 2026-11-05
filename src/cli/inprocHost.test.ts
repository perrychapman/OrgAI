import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LITELLM_KEY, type SecretStore } from '../main/store/secrets'
import { fakeCustody } from '../main/store/vaultTesting'
import { VaultNotReady } from '../main/store/vaultTypes'
import { inprocCliRoots, startInprocHost, type InprocHost } from './inprocHost'
import { CliError } from './types'

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
  const h = await startInprocHost({ userDataDir, dataDir, env: { ORGAI_MOCK: '1', ORGAI_DAEMON_IDLE_MINUTES: '0' }, mock: true, overlay, logging: false, startBackground: false, ...extra })
  started.push(h)
  return h
}

const secretsOf = (h: InprocHost): SecretStore => (h.host.services.connections as unknown as { deps: { secrets: SecretStore } }).deps.secrets

describe('startInprocHost', () => {
  it('owns the data dir as a ready inproc host, turns terminal access on, and serves the overlay over the vault', async () => {
    const h = await start(new Map([[LITELLM_KEY, 'sk-overlay']]))
    const daemon = JSON.parse(readFileSync(join(dataDir, 'run', 'daemon.json'), 'utf8')) as Record<string, unknown>
    expect(daemon).toMatchObject({ hostKind: 'inproc', state: 'ready', pid: process.pid })
    // For this session only (never saved), with every scope: the CLI process owns this host.
    expect(h.host.settings.get().terminalServer).toBe(false)
    expect(h.host.terminalAccess()).toEqual({ enabled: true, level: 'full' })
    expect(h.status()).toMatchObject({ hostKind: 'inproc', state: 'ready', mock: true, dataDir })
    const secrets = secretsOf(h)
    expect(secrets.get(LITELLM_KEY)).toBe('sk-overlay')
    // Wave 7: no vault until a value is stored, and only after prepareWrite (the bug trap of 5.6)
    expect(secrets.state()).toBe('absent')
    expect(() => secrets.set(LITELLM_KEY, 'other')).toThrow(VaultNotReady)
    // the default custodian is unavailable until the platform custodians are wired in: values are refused with why
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

  it('a second host on the same data dir is refused with exit 6', async () => {
    await start()
    const err = await startInprocHost({ userDataDir, dataDir, env: {}, mock: true, overlay: new Map(), logging: false, startBackground: false }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CliError)
    expect((err as CliError).exitCode).toBe(6)
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
