/**
 * Wave 7 integration: the secret-vault wiring against the REAL SecretStore (secretChannels.test.ts keeps the fake
 * FixtureVaultStore, which can log every call; this file proves the same contract holds when nothing is faked in the
 * vault path). openSecretStore opens a real vault through the real key-file custodian (a file in a temp folder outside
 * the data folder; the OS schemes would write real keychain items, which no test may do), bootOrgAIHost serves it as an
 * inproc host, and HostDispatcher.invokeRpc runs the registry's storesSecret predicates and prepareWrite:
 *
 * - a call that stores a value creates the vault (vault.json, key file) before the value is stored, and the value reads back;
 * - a clear, and a call that stores nothing, never creates a vault or a key file;
 * - an OAuth commit prepares itself (writer);
 * - the store refuses resetVault while a sign-in or a token refresh is in flight (the dispatcher installed the hook).
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DaemonInfo, HostScope, Project } from '../../shared/types'
import { LITELLM_KEY, mcpLibrarySecretKey, mcpSecretKey, openSecretStore, type SecretStore } from '../store/secrets'
import { noCipher } from '../store/vaultTesting'
import { VAULT_KEY_FILE_ENV, VAULT_MESSAGES } from '../store/vaultTypes'

vi.mock('electron', () => {
  throw new Error('electron must not be imported by the host bootstrap')
})

const { bootOrgAIHost } = await import('./bootstrap')
type OrgAIHost = import('./bootstrap').OrgAIHost

const ALL: readonly HostScope[] = ['read', 'operate', 'decide', 'configure']
const CTX = { surface: 'inproc' as const, grantedScopes: ALL }
const info: DaemonInfo = { hostInstanceId: 'abcdef012345', pid: 4242, endpoint: '/tmp/x.sock', state: 'starting', startedAt: 1_700_000_000_000, hostKind: 'inproc' }

let root: string
let keyDir: string
let keyFile: string
let dataDir: string
let host: OrgAIHost
let secrets: SecretStore
let project: Project

const rpc = <T = unknown>(channel: string, ...params: unknown[]): Promise<T> => host.dispatcher.invokeRpc(channel, params, CTX) as Promise<T>
const vaultExists = (): boolean => existsSync(join(dataDir, 'vault.json'))

beforeEach(async () => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'secret-real-')))
  keyDir = realpathSync.native(mkdtempSync(join(tmpdir(), 'secret-real-key-')))
  chmodSync(keyDir, 0o700)
  keyFile = join(keyDir, 'vault.key')
  dataDir = join(root, 'data')
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(join(root, 'project'), { recursive: true })
  secrets = await openSecretStore({
    dataDir,
    userDataDir: root,
    hostKind: 'inproc',
    cipher: noCipher,
    env: { [VAULT_KEY_FILE_ENV]: keyFile },
    log: () => undefined,
    retryMs: 0
  })
  host = bootOrgAIHost({
    env: { userDataDir: root, logsDir: join(root, 'logs'), appVersion: '9.9.9-test', isPackaged: false },
    dataDir,
    hostKind: 'inproc',
    ownership: { info, markReady: () => true, markDraining: () => true, release: () => {} },
    safeStorage: noCipher,
    secretStore: secrets,
    openExternal: () => {},
    mock: true,
    startBackground: false,
    housekeeping: { sweepStaleSkillDirs: () => {} },
    processEnv: {},
    homeDir: join(root, 'home')
  })
  // The one proxy the connection channels store a key for (a migrated 'litellm' proxy keeps the key name LITELLM_KEY).
  host.settings.setProxies([{ id: 'litellm', name: 'LiteLLM', kind: 'litellm', anthropicBaseUrl: 'http://localhost:4000/', enabled: true, hasApiKey: false, tierModels: {} }])
  project = await rpc<Project>('projects:create', { name: 'Real', path: join(root, 'project'), brief: '', mock: true })
  const server = { id: 'mcp-a', name: 'srv-a', transport: 'stdio', command: 'npx', args: ['-y', 'srv-a@1.0.0'], secretEnv: ['A_TOKEN'], enabled: true, source: 'user', addedAt: '' }
  await rpc('mcp:upsert', { projectId: project.id, spec: server })
  await rpc('mcpLibrary:upsert', { id: 'mcpl_one', name: 'lib-one', transport: 'stdio', command: 'npx', args: ['-y', 'lib-one@1.0.0'], secretEnv: ['LIB_ONE'], source: 'user', addedAt: '' })
})

afterEach(async () => {
  await host?.runs.stopAll({ reason: 'quit' }).catch(() => {})
  host?.dispose()
  rmSync(root, { recursive: true, force: true })
  rmSync(keyDir, { recursive: true, force: true })
})

describe('invokeRpc and the storesSecret predicates over the real SecretStore', () => {
  it('nothing stored so far: no vault, no key file', () => {
    expect(secrets.state()).toBe('absent')
    expect(vaultExists()).toBe(false)
    expect(existsSync(keyFile)).toBe(false)
  })

  it('connections:setSecret with a value prepares (creates the vault and key file) and the value reads back', async () => {
    await rpc('connections:setSecret', { id: 'litellm', apiKey: 'sk-real' })
    expect(secrets.state()).toBe('open')
    expect(vaultExists()).toBe(true)
    expect(existsSync(keyFile)).toBe(true)
    expect(secrets.get(LITELLM_KEY)).toBe('sk-real')
  })

  it('a clear or a blank value on a host with no vault never creates one', async () => {
    await rpc('connections:setSecret', { id: 'litellm', apiKey: null })
    await rpc('connections:setSecret', { id: 'litellm', apiKey: '  ' })
    await rpc('mcp:setSecret', { projectId: project.id, serverId: 'mcp-a', kind: 'env', name: 'A_TOKEN', value: null })
    await rpc('mcpLibrary:setSecret', { libraryId: 'mcpl_one', kind: 'env', name: 'LIB_ONE', value: null })
    expect(secrets.state()).toBe('absent')
    expect(vaultExists()).toBe(false)
    expect(existsSync(keyFile)).toBe(false)
  })

  it('mcp:setSecret, mcpLibrary:setSecret and connectors:setToken store through the prepared vault', async () => {
    await rpc('mcp:setSecret', { projectId: project.id, serverId: 'mcp-a', kind: 'env', name: 'A_TOKEN', value: 'a-real' })
    expect(secrets.state()).toBe('open')
    await rpc('mcpLibrary:setSecret', { libraryId: 'mcpl_one', kind: 'env', name: 'LIB_ONE', value: 'l-real' })
    expect(secrets.get(mcpSecretKey(project.id, 'mcp-a', 'env', 'A_TOKEN'))).toBe('a-real')
    expect(secrets.get(mcpLibrarySecretKey('mcpl_one', 'env', 'LIB_ONE'))).toBe('l-real')
    await rpc('connectors:add', { connectorId: 'zapier' })
    await rpc('connectors:setToken', { connectorId: 'zapier', token: 'zap-real' })
    expect(secrets.keys('mcplib:').length).toBeGreaterThanOrEqual(2)
  })

  it('a value stored by one host is read by the next host that opens the same folder', async () => {
    await rpc('connections:setSecret', { id: 'litellm', apiKey: 'sk-persist' })
    const next = await openSecretStore({ dataDir, userDataDir: root, hostKind: 'node', cipher: noCipher, env: { [VAULT_KEY_FILE_ENV]: keyFile }, log: () => undefined, retryMs: 0 })
    expect(next.state()).toBe('open')
    expect(next.get(LITELLM_KEY)).toBe('sk-persist')
    next.dispose()
  })

  it('the mock OAuth commit prepares by itself (writer) and secure storage holds the tokens', async () => {
    await rpc('connectors:add', { connectorId: 'notion' })
    const entry = (await rpc<{ entry: { id: string; connectorId?: string } }[]>('mcpLibrary:list')).find((l) => l.entry.connectorId === 'notion')!
    expect(secrets.state()).toBe('absent')
    await rpc('mcp:authorize', { libraryId: entry.entry.id })
    expect(secrets.state()).toBe('open')
    expect(secrets.keys('mcplib:').some((k) => k.includes(':oauth:'))).toBe(true)
  })

  it('resetVault is refused while a sign-in or a token refresh is in flight, and works once they end', async () => {
    await rpc('connections:setSecret', { id: 'litellm', apiKey: 'sk-reset' })
    const mcp = host.services.mcp as unknown as { activeAuthorizationCount: () => number; refreshingCount: () => number }
    const a = vi.spyOn(mcp, 'activeAuthorizationCount').mockReturnValue(1)
    await expect(secrets.resetVault({ confirm: true })).rejects.toThrow(VAULT_MESSAGES.resetBusy)
    a.mockReturnValue(0)
    const r = vi.spyOn(mcp, 'refreshingCount').mockReturnValue(2)
    await expect(secrets.resetVault({ confirm: true })).rejects.toThrow(VAULT_MESSAGES.resetBusy)
    r.mockReturnValue(0)
    expect(vaultExists()).toBe(true)
    await expect(secrets.resetVault({ confirm: true })).resolves.toMatchObject({ movedTo: expect.stringContaining('vault.json.reset-') })
    expect(secrets.state()).toBe('absent')
  })
})
