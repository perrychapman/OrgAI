/**
 * ConnectionService and the Wave 7 secret vault (cli-standalone.md 5.4, 5.5): the LiteLLM probe says why a stored
 * key cannot be read instead of "set it again", and an explicit clear (set-secret --clear, logout) asks the store
 * first and changes nothing when it refuses. A FixtureVaultStore stands in for the vault; no network.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProjectStore } from '../store/projects'
import { LITELLM_KEY } from '../store/secrets'
import { SettingsStore } from '../store/settings'
import { FixtureVaultStore } from '../store/vaultStore.fixture'
import { VAULT_MESSAGES } from '../store/vaultTypes'
import { ConnectionService } from './service'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200 })
const proxyFetch = (async (url: string | URL | Request) =>
  String(url).endsWith('/v1/models') ? json({ data: [{ id: 'claude-sonnet-4-5' }] }) : json({ data: [] })) as unknown as typeof fetch

async function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'orgai-connvault-'))
  dirs.push(dataDir)
  const settings = new SettingsStore(dataDir)
  const secrets = new FixtureVaultStore(dataDir)
  const service = new ConnectionService({
    dataDir,
    settings,
    projects: new ProjectStore(dataDir),
    secrets,
    broadcast: () => {},
    openExternal: vi.fn(async () => {}),
    fetch: proxyFetch,
    anthropicProbe: async () => ({ state: 'connected' }),
    logInfo: () => {},
    now: () => 1000
  })
  await service.update({ ...settings.get().connections.litellm, baseUrl: 'http://localhost:4000/' })
  await service.setSecret({ id: 'litellm', apiKey: 'sk-test-key' })
  return { settings, secrets, service }
}

describe('LiteLLM key and the vault', () => {
  it('a key this host cannot read probes as error with the store reason, never "set it again"', async () => {
    const { secrets, service } = await setup()
    secrets.unreadable.set(LITELLM_KEY, VAULT_MESSAGES.pendingLegacy)
    expect(await service.test('litellm')).toMatchObject({ state: 'error', detail: VAULT_MESSAGES.pendingLegacy })
    secrets.unreadable.set(LITELLM_KEY, VAULT_MESSAGES.locked('run security unlock-keychain'))
    expect(await service.test('litellm')).toMatchObject({ state: 'error', detail: 'The secret vault is locked: run security unlock-keychain' })
    secrets.unreadable.clear()
    expect(await service.test('litellm')).toMatchObject({ state: 'connected' })
  })

  it('set-secret --clear and logout are refused with the store sentence before anything changes', async () => {
    const { secrets, service, settings } = await setup()
    secrets.clearRefusals.set(LITELLM_KEY, VAULT_MESSAGES.clearRefusedCorrupt)
    await expect(service.setSecret({ id: 'litellm', apiKey: null })).rejects.toThrow(VAULT_MESSAGES.clearRefusedCorrupt)
    await expect(service.setSecret({ id: 'litellm', apiKey: '   ' })).rejects.toThrow(VAULT_MESSAGES.clearRefusedCorrupt)
    await expect(service.logout('litellm')).rejects.toThrow(VAULT_MESSAGES.clearRefusedCorrupt)
    expect(secrets.get(LITELLM_KEY)).toBe('sk-test-key')
    expect(settings.get().connections.litellm).toMatchObject({ hasApiKey: true })
    // A new value is never a clear.
    await service.setSecret({ id: 'litellm', apiKey: 'sk-new' })
    expect(secrets.get(LITELLM_KEY)).toBe('sk-new')
    secrets.clearRefusals.clear()
    await service.logout('litellm')
    expect(secrets.has(LITELLM_KEY)).toBe(false)
  })
})
