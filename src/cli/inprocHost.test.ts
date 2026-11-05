import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LITELLM_KEY, READ_ONLY_SECRETS_MESSAGE, type SecretStore } from '../main/store/secrets'
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

const start = async (overlay: Map<string, string> = new Map()): Promise<InprocHost> => {
  const h = await startInprocHost({ userDataDir, dataDir, env: { ORGAI_MOCK: '1', ORGAI_DAEMON_IDLE_MINUTES: '0' }, mock: true, overlay, logging: false, startBackground: false })
  started.push(h)
  return h
}

const secretsOf = (h: InprocHost): SecretStore => (h.host.services.connections as unknown as { deps: { secrets: SecretStore } }).deps.secrets

describe('startInprocHost', () => {
  it('owns the data dir as a ready inproc host, turns terminal access on, and serves the overlay read-only', async () => {
    const h = await start(new Map([[LITELLM_KEY, 'sk-overlay']]))
    const daemon = JSON.parse(readFileSync(join(dataDir, 'run', 'daemon.json'), 'utf8')) as Record<string, unknown>
    expect(daemon).toMatchObject({ hostKind: 'inproc', state: 'ready', pid: process.pid })
    expect(h.host.settings.get().terminalServer).toBe(true)
    expect(h.status()).toMatchObject({ hostKind: 'inproc', state: 'ready', mock: true, dataDir })
    const secrets = secretsOf(h)
    expect(secrets.get(LITELLM_KEY)).toBe('sk-overlay')
    expect(() => secrets.set(LITELLM_KEY, 'other')).toThrow(READ_ONLY_SECRETS_MESSAGE)
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
