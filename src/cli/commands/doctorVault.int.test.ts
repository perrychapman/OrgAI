/**
 * Integration (Wave 7): `orgai doctor` through the REAL context and the REAL check groups (install, runtime, secrets)
 * together, hostless, over a data folder holding a vault written by the real SecretStore with the real key-file
 * custodian. Only the claude / codex lookups are faked (they would run a real binary) and git.
 */
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openSecretStore } from '../../main/store/secrets'
import { noCipher } from '../../main/store/vaultTesting'
import { VAULT_KEY_FILE_ENV } from '../../main/store/vaultTypes'
import { buildContext } from '../context'
import { runtimeCheckProbes } from '../doctor/runtimeChecks'
import { EXIT } from '../types'
import { doctorProbes, runDoctor } from './doctor'

const realProbes = { ...doctorProbes }
const realRuntimeProbes = { ...runtimeCheckProbes }
let root: string
let keyDir: string
let dataDir: string

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'doctor-vault-')))
  keyDir = realpathSync.native(mkdtempSync(join(tmpdir(), 'doctor-vault-key-')))
  chmodSync(keyDir, 0o700)
  dataDir = join(root, 'data')
  mkdirSync(dataDir, { recursive: true })
  doctorProbes.gitVersion = async () => 'git version 2.50.0'
  doctorProbes.homeDir = () => root
  runtimeCheckProbes.claude = () => ({ ok: true, path: '/fake/claude', source: 'sdk' })
  runtimeCheckProbes.codexLookup = () => ({ binary: { path: '/fake/codex', source: 'package' } })
  runtimeCheckProbes.codexCheck = async (binary) => ({ ok: true, binary, version: '0.166.0' })
})
afterEach(() => {
  Object.assign(doctorProbes, realProbes)
  Object.assign(runtimeCheckProbes, realRuntimeProbes)
  rmSync(root, { recursive: true, force: true })
  rmSync(keyDir, { recursive: true, force: true })
})

async function doctor(): Promise<{ code: number; checks: { id: string; status: string; detail: string }[] }> {
  let out = ''
  const ctx = buildContext({
    globals: { host: 'auto', outputFormat: 'json', color: false, secretEnv: [], dataDir: root },
    env: { PATH: process.env.PATH ?? '', ORGAI_DAEMON_IDLE_MINUTES: '0' },
    cwd: root,
    platform: process.platform,
    io: { stdout: { write: (s: string) => ((out += s), true) }, stderr: { write: () => true }, stdinIsTTY: false }
  })
  const code = await runDoctor(ctx, [])
  return { code, checks: (JSON.parse(out) as { checks: { id: string; status: string; detail: string }[] }).checks }
}

describe('orgai doctor with the real groups', () => {
  it('shows the install, runtime and secrets checks together, with a not-yet-created vault', async () => {
    const { code, checks } = await doctor()
    const ids = checks.map((c) => c.id)
    expect(ids).toEqual(expect.arrayContaining(['install-channel', 'orgai-on-path', 'claude-runtime', 'codex-runtime', 'vault', 'legacy-secrets']))
    expect(ids).not.toContain('doctor')
    expect(checks.find((c) => c.id === 'vault')?.detail).toMatch(/Not created yet/)
    expect(code === EXIT.ok || code === EXIT.failure).toBe(true)
  })

  it('reports the vault the real store made, without opening it', async () => {
    const store = await openSecretStore({ dataDir, userDataDir: root, hostKind: 'node', cipher: noCipher, env: { [VAULT_KEY_FILE_ENV]: join(keyDir, 'k') }, log: () => undefined, retryMs: 0 })
    await store.prepareWrite()
    store.set('litellm.apiKey', 'sk-doctor-secret')
    store.dispose()
    const { checks } = await doctor()
    const vault = checks.find((c) => c.id === 'vault')!
    expect(vault.status).toBe('ok')
    expect(vault.detail).toMatch(/Present \(.*key file.*\): 1 secret/i)
    expect(JSON.stringify(checks)).not.toContain('sk-doctor-secret')
  })
})
