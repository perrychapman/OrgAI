/**
 * Channel coverage of secure storage (docs/design/cli-standalone.md 5.6 "Test", round 6 item 4). A mock in-process
 * host (bootOrgAIHost, hostKind 'inproc', the mock adapter) is seeded with a project, project MCP servers (one with an
 * OAuth sign-in about to expire), library entries (one with an OAuth sign-in), connectors and a work run holding
 * pending MCP-proposal and MCP-install cards. Every channel that reaches the SecretStore is then driven through
 * HostDispatcher.invokeRpc with a value and with a clear (or without a value), on a store whose vault is put back to
 * 'absent' before each call (FixtureVaultStore.forgetVault). That is not a whole fresh Node host: values stored by
 * earlier calls stay readable across forgetVault (they are the seed the next call works on). A fresh host's realistic
 * case, values the OrgAI app saved that a Node host reads as pending-legacy (5.4), is driven separately with
 * seedAppValue: moves refuse them and explicit clears are refused, without preparing.
 *
 * - a call that stores a value must have prepared the vault first, either through its storesSecret predicate (the
 *   dispatcher) or through the writer itself (OAuth commits, token refreshes); set() on an unprepared vault throws
 *   VaultNotReady and is recorded as a violation, so a channel that stores without either fails here;
 * - a clear, a removal or a call that stores nothing never prepares (never creates a vault or a keychain item).
 *
 * The last test enumerates every mutation channel of the host registry: each one is driven here, named in
 * COVERED_ELSEWHERE with the test that drives its secret path, or named in NEVER_WRITES_SECRETS with the reason it
 * never stores, deletes or prepares a secret. A new channel is unaccounted for until someone decides which.
 *
 * The real vault is WP-G's; FixtureVaultStore enforces the 'absent' bug trap. No tokens, no network (fetch is a stub
 * that answers the fake token endpoint), no keychain.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { DaemonInfo, HostScope, KitBundleExportResult, KitImportPreview, McpLibraryInfo, McpOAuthConfig, PendingCards, Project, RunSummary } from '../../shared/types'
import { MCP_HARNESS_TOOLS } from '../../shared/types'
import type { McpLibraryStore } from '../store/mcpLibrary'
import { LITELLM_KEY, mcpLibraryOAuthKey, mcpLibrarySecretKey, mcpOAuthKey, mcpSecretKey } from '../store/secrets'
import { VAULT_MESSAGES } from '../store/vaultTypes'
import { FixtureVaultStore } from '../store/vaultStore.fixture'
import { requestEntries } from './registry'
import { STORES_SECRET } from './storesSecret'

vi.mock('electron', () => {
  throw new Error('electron must not be imported by the host bootstrap')
})

const { bootOrgAIHost } = await import('./bootstrap')
type OrgAIHost = import('./bootstrap').OrgAIHost

const ALL: readonly HostScope[] = ['read', 'operate', 'decide', 'configure']
const CTX = { surface: 'inproc' as const, grantedScopes: ALL }
const info: DaemonInfo = { hostInstanceId: 'abcdef012345', pid: 4242, endpoint: '/tmp/x.sock', state: 'starting', startedAt: 1_700_000_000_000, hostKind: 'inproc' }
const TOKEN_ENDPOINT = 'https://as.test/token'

let root: string
let host: OrgAIHost
let secrets: FixtureVaultStore
let project: Project
let run: RunSummary
const savedScript = process.env.ORGAI_MOCK_SCRIPT
let issued = 0

/** fetch: the fake authorization server's token endpoint answers a rotated pair; every other URL is down. */
const fakeFetch = vi.fn(async (input: unknown): Promise<Response> => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
  if (url === TOKEN_ENDPOINT) {
    issued += 1
    return new Response(JSON.stringify({ access_token: `AT-${issued}`, refresh_token: `RT-${issued}`, expires_in: 3600, token_type: 'Bearer' }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  }
  return new Response('down', { status: 503 })
})

const manual = (name: string, slot: string) => ({ name, transport: 'stdio', command: 'npx', args: ['-y', `${name}@1.0.0`], secretEnv: [slot] })

/** The work run's script: three proposals and four install requests, each with a secret slot, answered in order. */
const SCRIPT = {
  delayMs: 0,
  work: [
    ...['prop-a', 'prop-b', 'prop-c'].map((name) => ({
      type: 'harness',
      name: MCP_HARNESS_TOOLS.proposeServers,
      retryOnRevise: false,
      args: { title: name, rationale: 'r', upsert: [manual(name, 'PROP_TOKEN')] }
    })),
    ...['inst-c', 'inst-d', 'inst-e', 'inst-f'].map((name) => ({
      type: 'harness',
      name: MCP_HARNESS_TOOLS.requestInstall,
      retryOnRevise: false,
      args: { reason: 'coverage', manual: manual(name, 'INST_TOKEN') }
    })),
    { type: 'text', text: 'Coverage script done.' }
  ]
}

const rpc = <T = unknown>(channel: string, ...params: unknown[]): Promise<T> => host.dispatcher.invokeRpc(channel, params, CTX) as Promise<T>

/** What one measured call did to the store. */
interface Measured {
  stored: string[]
  origins: ('dispatcher' | 'writer')[]
  deleted: number
  /** A 'none' call the handler refused (the refusal must still never prepare or store). */
  refused?: string
}

/** Channel -> how it was driven ('value' stored something; 'none' was a clear or stored nothing). */
const driven = new Map<string, Set<'value' | 'none'>>()

/**
 * One call on a fresh 'absent' vault. 'value': at least one value stored, each after a prepare in this call.
 * 'none': nothing stored, no prepare, the vault still 'absent'.
 */
async function measure(kind: 'value' | 'none', channel: string, ...params: unknown[]): Promise<Measured> {
  secrets.forgetVault()
  secrets.opLog.length = 0
  const violationsBefore = secrets.violations.length
  let refused: string | undefined
  try {
    await rpc(channel, ...params)
  } catch (e) {
    if (kind === 'value') throw e
    refused = e instanceof Error ? e.message : String(e)
  }
  const log = [...secrets.opLog]
  const stored = secrets.storedKeys()
  const origins = secrets.prepares().map((p) => p.origin)
  expect(secrets.violations.slice(violationsBefore), `${channel}: stored without preparing`).toEqual([])
  if (kind === 'value') {
    expect(stored.length, `${channel}: expected a stored value`).toBeGreaterThan(0)
    const firstPrepare = log.findIndex((e) => e.op === 'prepare')
    const firstSet = log.findIndex((e) => e.op === 'set' && e.value)
    expect(firstPrepare, `${channel}: prepared before the first value`).toBeGreaterThanOrEqual(0)
    expect(firstPrepare).toBeLessThan(firstSet)
  } else {
    expect(stored, `${channel}: stored a value`).toEqual([])
    expect(origins, `${channel}: prepared without storing`).toEqual([])
    expect(secrets.state(), `${channel}: created a vault`).toBe('absent')
  }
  if (!driven.has(channel)) driven.set(channel, new Set())
  driven.get(channel)!.add(kind)
  return { stored, origins, deleted: log.filter((e) => e.op === 'delete' || e.op === 'deletePrefix').length, ...(refused !== undefined ? { refused } : {}) }
}

/** Seed a value outside any measured call (the vault is prepared first, as a writer would). */
async function seed(key: string, value: string): Promise<void> {
  await secrets.prepareWrite()
  secrets.set(key, value)
}

async function pending(predicate: (c: PendingCards) => boolean): Promise<PendingCards> {
  let cards: PendingCards | undefined
  await vi.waitFor(
    () => {
      cards = host.runs.pendingCards(run.id)
      expect(predicate(cards)).toBe(true)
    },
    { timeout: 10_000, interval: 5 }
  )
  return cards!
}

/** An OAuth sign-in whose access token has expired (doRefresh refreshes it before a test or a run). */
const expiring = (url: string): McpOAuthConfig => ({
  resource: url,
  tokenEndpoint: TOKEN_ENDPOINT,
  clientId: 'cov-client',
  clientSource: 'dcr',
  authorizedAt: '2026-01-01T00:00:00.000Z',
  expiresAt: '2026-01-01T01:00:00.000Z'
})

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'orgai-secret-channels-'))
  const dataDir = join(root, 'data')
  mkdirSync(join(root, 'project'), { recursive: true })
  mkdirSync(join(root, 'project-2'), { recursive: true })
  mkdirSync(dataDir, { recursive: true })
  const scriptFile = join(root, 'script.json')
  writeFileSync(scriptFile, JSON.stringify(SCRIPT))
  process.env.ORGAI_MOCK_SCRIPT = scriptFile
  // McpService takes the global fetch when it is built: the stub goes in before the boot.
  vi.stubGlobal('fetch', fakeFetch)
  secrets = new FixtureVaultStore(dataDir, { lazy: true })
  host = bootOrgAIHost({
    env: { userDataDir: root, logsDir: join(root, 'logs'), appVersion: '9.9.9-test', isPackaged: false },
    dataDir,
    hostKind: 'inproc',
    ownership: { info, markReady: () => true, markDraining: () => true, release: () => {} },
    safeStorage: { isEncryptionAvailable: () => false, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() },
    secretStore: secrets,
    openExternal: () => {},
    mock: true,
    startBackground: false,
    housekeeping: { sweepStaleSkillDirs: () => {} },
    processEnv: {},
    homeDir: join(root, 'home')
  })

  // Seed: a project with project-only servers (stdio with and without secrets, http with an expiring sign-in, plain
  // http), library entries linked to it (one with a sign-in), and connectors.
  // The one proxy the connection channels store a key for (a migrated 'litellm' proxy keeps the key name LITELLM_KEY).
  host.settings.setProxies([{ id: 'litellm', name: 'LiteLLM', kind: 'litellm', anthropicBaseUrl: 'http://localhost:4000/', enabled: true, hasApiKey: false, tierModels: {} }])
  project = await rpc<Project>('projects:create', { name: 'Secrets', path: join(root, 'project'), brief: '', mock: true })
  const server = (id: string, name: string, secretEnv?: string[]) => ({ id, name, transport: 'stdio', command: 'npx', args: ['-y', `${name}@1.0.0`], ...(secretEnv ? { secretEnv } : {}), enabled: true, source: 'user', addedAt: '' })
  const remote = (id: string, name: string, url: string) => ({ id, name, transport: 'http', url, enabled: true, source: 'user', addedAt: '' })
  await rpc('mcp:upsert', { projectId: project.id, spec: server('mcp-a', 'srv-a', ['A_TOKEN']) })
  await rpc('mcp:upsert', { projectId: project.id, spec: server('mcp-b', 'srv-b') })
  await rpc('mcp:upsert', { projectId: project.id, spec: server('mcp-gone', 'srv-gone', ['GONE_TOKEN']) })
  await rpc('mcp:upsert', { projectId: project.id, spec: server('mcp-up', 'srv-up', ['UP_ONE', 'UP_TWO']) })
  await rpc('mcp:upsert', { projectId: project.id, spec: remote('mcp-oauth', 'srv-oauth', 'https://oauth.test/mcp') })
  await rpc('mcp:upsert', { projectId: project.id, spec: remote('mcp-plain', 'srv-plain', 'https://plain.test/mcp') })
  const stored = host.services.projects.get(project.id)!
  host.services.projects.save({ ...stored, mcpServers: stored.mcpServers!.map((s) => (s.id === 'mcp-oauth' ? { ...s, oauth: expiring('https://oauth.test/mcp') } : s)) })
  await seed(mcpOAuthKey(project.id, 'mcp-oauth', 'accessToken'), 'AT-0')
  await seed(mcpOAuthKey(project.id, 'mcp-oauth', 'refreshToken'), 'RT-0')
  for (const [id, name, slot] of [['mcpl_one', 'lib-one', 'LIB_ONE'], ['mcpl_two', 'lib-two', 'LIB_TWO'], ['mcpl_gone', 'lib-gone', 'LIB_GONE'], ['mcpl_three', 'lib-three', 'LIB_THREE'], ['mcpl_up', 'lib-up', 'LIB_UP'], ['mcpl_kit', 'lib-kit', 'LIB_KIT']]) {
    await rpc('mcpLibrary:upsert', { id, name, transport: 'stdio', command: 'npx', args: ['-y', `${name}@1.0.0`], secretEnv: [slot], source: 'user', addedAt: '' })
  }
  await rpc('mcpLibrary:upsert', { id: 'mcpl_oauth', name: 'lib-oauth', transport: 'http', url: 'https://liboauth.test/mcp', source: 'user', addedAt: '' })
  // Library OAuth state is main-only (never from an upsert): seeded on the service's own store.
  const lib = (host.services.mcp as unknown as { library: McpLibraryStore }).library
  lib.save({ ...lib.get('mcpl_oauth')!, oauth: expiring('https://liboauth.test/mcp') })
  await seed(mcpLibraryOAuthKey('mcpl_oauth', 'refreshToken'), 'RT-lib-0')
  await rpc('mcp:linkLibrary', { projectId: project.id, libraryId: 'mcpl_one' })
  await rpc('mcp:linkLibrary', { projectId: project.id, libraryId: 'mcpl_two' })
  await rpc('connectors:add', { connectorId: 'zapier' })
  await rpc('connectors:add', { connectorId: 'notion' })
  await rpc('connectors:add', { connectorId: 'deepwiki' })
  await rpc('connectors:add', { connectorId: 'github', variant: 'app-readonly' })
  await rpc('connectors:add', { connectorId: 'neon', variant: 'readonly' })
  run = await rpc<RunSummary>('runs:start', { projectId: project.id, prompt: 'Cover every secret channel.' })
}, 60_000)

afterAll(async () => {
  await host?.runs.stopAll({ reason: 'quit' }).catch(() => {})
  host?.dispose()
  vi.unstubAllGlobals()
  if (savedScript === undefined) delete process.env.ORGAI_MOCK_SCRIPT
  else process.env.ORGAI_MOCK_SCRIPT = savedScript
  rmSync(root, { recursive: true, force: true })
})

const libraryEntry = async (connectorId: string): Promise<McpLibraryInfo> => (await rpc<McpLibraryInfo[]>('mcpLibrary:list')).find((l) => l.entry.connectorId === connectorId)!

/**
 * Mutation channels that reach the store only along a path another test drives (the mock adapter, or a flow this host
 * cannot reach without tokens), each with where that path is driven.
 */
const COVERED_ELSEWHERE: Record<string, string> = {
  'runs:start': 'token refresh through the adapter (ctx.resolvedMcpServers -> prepareForRun -> doRefresh, writer-prepared): runManagerVaultSecrets.test.ts "a run start refreshes"; the mock adapter never resolves servers',
  'runs:continue': 'the same session start as runs:start (a continued run is a new adapter session over the same ctx)',
  'runs:resumeNow': 'the same session start as runs:start (a resumed run is a new adapter session over the same ctx)',
  'capabilities:apply': 'McpService.upsert / connectorsAdd / linkLibrary, never with a value (a server with a missing secret is saved disabled): mcp:upsert, connectors:add and mcp:linkLibrary are driven here',
  'capabilities:undo': 'McpService.remove / libraryRemove: mcp:remove and mcpLibrary:remove are driven here',
  'secrets:init': "the vault's own management (SecretStoreApi.initVault): dispatcher.test.ts secrets:* and WP-G's store tests",
  'secrets:reset': "the vault's own management (SecretStoreApi.resetVault, refused while a sign-in or refresh runs): dispatcher.test.ts",
  'secrets:undelete': "the vault's own management (SecretStoreApi.undelete): dispatcher.test.ts",
  'secrets:confirmDelete': "the vault's own management (SecretStoreApi.confirmDeletes): dispatcher.test.ts"
}

/** Mutation channels that never store, delete or prepare a secret (reading has / get / status does not count). */
const NEVER_WRITES_SECRETS: Record<string, string> = {
  'connections:removeProxy': "removes the proxy and deletes its key (a removal's delete never prepares)",
  'teamFiles:status': 'writes the project folder\'s team files only, no secrets',
  'outputs:forget': 'removes an output index entry in the project data folder only, no secrets',
  'outputs:delete': 'deletes an output file and its index entry, versions and notes, no secrets',
  'outputs:saveEdit': 'writes an output file and its stored version in the project and data folders, no secrets',
  'outputs:restore': 'writes an output file and its stored version in the project and data folders, no secrets',
  'outputs:update': 'renames an output in its index entry, no secrets',
  'outputs:noteAdd': 'writes a note in the project data folder, no secrets',
  'outputs:noteUpdate': 'edits a note in the project data folder, no secrets',
  'outputs:noteRemove': 'removes a note in the project data folder, no secrets',
  'outputs:revise': 'sends a message through RunManager like a user message, no secrets',
  'outputs:watch': 'polls an output file with lstat, in memory only, no secrets',
  'outputs:unwatch': 'drops an in-memory watch, no secrets',
  // Runs: setup-like and virtual-project runs carry no project MCP servers (bare); run-scoped installs carry no OAuth.
  'runs:startQuick': 'quick runs are bare (no project servers to refresh)',
  'setup:start': 'setup runs are bare',
  'setup:retro': 'setup-like, bare',
  'mcp:startAssist': 'harness project, bare',
  'skills:startAssist': 'setup-like, bare',
  'runs:send': 'delivers a message; no server preparation',
  'runs:switchModel': 'selects a root model without changing permissions; runtime resolves routing without exposing secrets',
  'runs:interrupt': 'stops a turn',
  'runs:stop': 'ends a run',
  'runs:cancelAutoResume': 'clears a timer',
  'runs:decide': 'permission cards carry no secret values',
  'permissions:decideRequest': 'permission rules only',
  'setup:answer': 'question cards carry no secret values',
  'merges:decide': 'git merge review',
  'runs:promoteQuick': 'moves a run record',
  'window:openRun': 'desktop window',
  'host.stop': 'drain only (McpService.dispose aborts flows, writes nothing)',
  'usage:refresh': 'reads the LiteLLM key (get), never writes',
  'connections:test': 'reads the LiteLLM key',
  'models:refresh': 'reads the LiteLLM key',
  'connections:connect': 'probes; the key is set only by connections:setSecret',
  'connections:update': 'settings only',
  'connections:login': 'CLI / Codex sign-in, outside the SecretStore',
  'connections:cancelLogin': 'aborts a CLI sign-in',
  'connections:setDefault': 'settings only',
  'settings:set': 'keeps connections / providerAuth as stored (settingsSetArgs)',
  'projects:create': 'reads whether the LiteLLM key exists (creationConnection)',
  'projects:save': 'mcpServers and plugins are kept as stored (saveFromRenderer)',
  'projects:remapModels': 'roles only',
  'projects:applyImport': 'roles only (grants kept)',
  'projects:exportOrg': 'writes .orgai/org.json, no secrets',
  'projects:updateEngagementDocument': 'project data only',
  'projects:saveNote': 'project data only',
  'projects:removeNote': 'project data only',
  'permissions:add': 'rules files',
  'permissions:remove': 'rules files',
  'mcp:cancelAuthorize': 'aborts a flow; the flow itself stores nothing once aborted',
  'mcp:setProjectOverrides': 'plain (non-secret) env / header overrides on the link',
  'connectorPresets:upsert': 'presets hold no values',
  'connectorPresets:remove': 'refused while an entry uses the preset',
  'plugins:upsert': 'plugins hold no secrets',
  'plugins:remove': 'plugins hold no secrets',
  'skills:create': 'skills', 'skills:update': 'skills', 'skills:remove': 'skills', 'skills:linkLibrary': 'skills', 'skills:promote': 'skills',
  'skills:applyImport': 'skills', 'skills:undoImport': 'skills', 'skills:applySuggestion': 'skills', 'skills:evaluate': 'skills',
  'skillLibrary:create': 'skills', 'skillLibrary:addFromBundle': 'skills', 'skillLibrary:update': 'skills', 'skillLibrary:remove': 'skills',
  'capabilities:discover': 'token-free discovery, secret names only',
  'capabilities:recommend': 'a recommendation, nothing applied',
  'capabilities:cancel': 'aborts a model call',
  'capabilities:review': 'team review state',
  'capabilities:dismiss': 'team review state',
  'capabilities:restore': 'team review state',
  'draft:orgChart': 'a model call, nothing stored',
  'maintenance:integrateWorktree': 'git', 'maintenance:discardWorktree': 'git', 'maintenance:uninstallRepo': 'repository files',
  'templates:saveFromProject': 'roles only', 'templates:remove': 'templates', 'templates:apply': 'roles only (ids and grants kept)',
  'knowledge:saveNode': 'knowledge graph', 'knowledge:removeNode': 'knowledge graph', 'knowledge:saveEdge': 'knowledge graph',
  'knowledge:removeEdge': 'knowledge graph', 'knowledge:clear': 'knowledge graph', 'knowledge:dismissLink': 'knowledge graph',
  'kit:exportBundle': 'reads the library (secret-free); values never go in a kit'
}

describe('every channel that reaches SecretStore prepares before a value and never for a clear (5.6, round 6 item 4)', () => {
  it('connections:setSecret and connections:logout', async () => {
    expect((await measure('value', 'connections:setSecret', { id: 'litellm', apiKey: 'sk-cov' })).origins).toEqual(['dispatcher'])
    expect((await measure('none', 'connections:setSecret', { id: 'litellm', apiKey: null })).deleted).toBeGreaterThan(0)
    await measure('none', 'connections:setSecret', { id: 'litellm', apiKey: '  ' })
    await measure('value', 'connections:setSecret', { id: 'litellm', apiKey: 'sk-cov-2' })
    expect((await measure('none', 'connections:logout', 'litellm')).deleted).toBeGreaterThan(0)
    expect(secrets.has(LITELLM_KEY)).toBe(false)
    // A new proxy with a key stores it (prepared first); without one it stores nothing and never prepares.
    expect((await measure('value', 'connections:createProxy', { name: 'Second', anthropicBaseUrl: 'http://localhost:5000/', apiKey: 'sk-new' })).origins).toEqual(['dispatcher'])
    await measure('none', 'connections:createProxy', { name: 'Third', anthropicBaseUrl: 'http://localhost:6000/' })
  })

  it('connectors:setToken, and connectors:add switching the access of an entry not yet connected', async () => {
    expect((await measure('value', 'connectors:setToken', { connectorId: 'zapier', token: 'zap-cov' })).origins).toEqual(['dispatcher'])
    expect((await measure('none', 'connectors:setToken', { connectorId: 'zapier', token: null })).deleted).toBeGreaterThan(0)
    const neon = await libraryEntry('neon')
    expect(neon.entry.connectorVariant).toBe('readonly')
    expect((await measure('none', 'connectors:add', { connectorId: 'neon', variant: 'full' })).deleted).toBeGreaterThan(0)
    expect((await libraryEntry('neon')).entry.connectorVariant).toBe('full')
  })

  it('mcp:setSecret and mcpLibrary:setSecret', async () => {
    expect((await measure('value', 'mcp:setSecret', { projectId: project.id, serverId: 'mcp-a', kind: 'env', name: 'A_TOKEN', value: 'a-cov' })).origins).toEqual(['dispatcher'])
    await measure('none', 'mcp:setSecret', { projectId: project.id, serverId: 'mcp-a', kind: 'env', name: 'A_TOKEN', value: null })
    await measure('value', 'mcp:setSecret', { projectId: project.id, serverId: 'mcp-a', kind: 'env', name: 'A_TOKEN', value: 'a-cov' })
    await measure('value', 'mcp:setSecret', { projectId: project.id, serverId: 'mcp-gone', kind: 'env', name: 'GONE_TOKEN', value: 'g-cov' })
    expect((await measure('value', 'mcpLibrary:setSecret', { libraryId: 'mcpl_one', kind: 'env', name: 'LIB_ONE', value: 'l1-cov' })).origins).toEqual(['dispatcher'])
    await measure('none', 'mcpLibrary:setSecret', { libraryId: 'mcpl_one', kind: 'env', name: 'LIB_ONE', value: null })
    for (const [libraryId, name] of [['mcpl_one', 'LIB_ONE'], ['mcpl_two', 'LIB_TWO'], ['mcpl_gone', 'LIB_GONE'], ['mcpl_up', 'LIB_UP'], ['mcpl_kit', 'LIB_KIT']]) {
      await measure('value', 'mcpLibrary:setSecret', { libraryId, kind: 'env', name, value: `${name}-cov` })
    }
  })

  it('mcp:upsert and mcpLibrary:upsert: retargets and dropped slots delete without preparing', async () => {
    await measure('value', 'mcp:setSecret', { projectId: project.id, serverId: 'mcp-up', kind: 'env', name: 'UP_ONE', value: 'u1' })
    const up = { id: 'mcp-up', name: 'srv-up', transport: 'stdio', command: 'npx', args: ['-y', 'srv-up@1.0.0'], secretEnv: ['UP_TWO'], enabled: true, source: 'user', addedAt: '' }
    expect((await measure('none', 'mcp:upsert', { projectId: project.id, spec: up })).deleted).toBeGreaterThan(0)
    expect(secrets.has(mcpSecretKey(project.id, 'mcp-up', 'env', 'UP_ONE'))).toBe(false)
    // An http server whose address changes loses its sign-in (retarget).
    await seed(mcpOAuthKey(project.id, 'mcp-plain', 'accessToken'), 'AT-plain')
    const moved = { id: 'mcp-plain', name: 'srv-plain', transport: 'http', url: 'https://plain-2.test/mcp', enabled: true, source: 'user', addedAt: '' }
    expect((await measure('none', 'mcp:upsert', { projectId: project.id, spec: moved })).deleted).toBeGreaterThan(0)
    expect(secrets.has(mcpOAuthKey(project.id, 'mcp-plain', 'accessToken'))).toBe(false)
    // A library entry dropping its slot, and one turning per-project values on, delete the entry's own values.
    const libUp = { id: 'mcpl_up', name: 'lib-up', transport: 'stdio', command: 'npx', args: ['-y', 'lib-up@1.0.0'], secretEnv: ['LIB_UP'], source: 'user', addedAt: '' }
    expect((await measure('none', 'mcpLibrary:upsert', { ...libUp, perProjectSecrets: true })).deleted).toBeGreaterThan(0)
    expect(secrets.has(mcpLibrarySecretKey('mcpl_up', 'env', 'LIB_UP'))).toBe(false)
    expect((await measure('none', 'mcpLibrary:upsert', { ...libUp, perProjectSecrets: false, secretEnv: [] })).deleted).toBeGreaterThan(0)
  })

  it('mcp:linkLibrary clears what a new link id might inherit, without preparing', async () => {
    const r = await measure('none', 'mcp:linkLibrary', { projectId: project.id, libraryId: 'mcpl_three' })
    expect(r.deleted).toBeGreaterThan(0)
  })

  it('mcp:test and mcpLibrary:test: an expired sign-in is refreshed by the writer, which prepares itself; nothing to refresh never prepares', async () => {
    const t = await measure('value', 'mcp:test', { projectId: project.id, serverId: 'mcp-oauth' })
    expect(t.origins.length).toBeGreaterThan(0)
    expect(new Set(t.origins)).toEqual(new Set(['writer']))
    expect(t.stored).toEqual([mcpOAuthKey(project.id, 'mcp-oauth', 'accessToken'), mcpOAuthKey(project.id, 'mcp-oauth', 'refreshToken')])
    expect(secrets.get(mcpOAuthKey(project.id, 'mcp-oauth', 'refreshToken'))).toMatch(/^RT-\d+$/)
    // Now fresh: a second test refreshes nothing.
    await measure('none', 'mcp:test', { projectId: project.id, serverId: 'mcp-oauth' })
    await measure('none', 'mcp:test', { projectId: project.id, serverId: 'mcp-plain' })
    const l = await measure('value', 'mcpLibrary:test', { libraryId: 'mcpl_oauth' })
    expect(new Set(l.origins)).toEqual(new Set(['writer']))
    expect(l.stored).toContain(mcpLibraryOAuthKey('mcpl_oauth', 'accessToken'))
    await measure('none', 'mcpLibrary:test', { libraryId: 'mcpl_oauth' })
  })

  it('setup:decide on MCP proposal cards: with values, with values for no slot of the card, and without', async () => {
    const first = await pending((c) => c.proposals.length === 1)
    const a = first.proposals[0]
    const slot = a.kind === 'mcpServers' ? a.payload.secrets![0] : undefined
    expect(slot?.name).toBe('PROP_TOKEN')
    const r = await measure('value', 'setup:decide', { runId: run.id, proposalId: a.id, decision: { behavior: 'approve', secrets: { [`${slot!.serverId}:env:PROP_TOKEN`]: 'pa-cov' } } })
    expect(r.origins).toEqual(['dispatcher'])
    // A stray key names no slot of this card: nothing is stored, so no vault is created.
    const second = (await pending((c) => c.proposals.length === 1 && c.proposals[0].id !== a.id)).proposals[0]
    await measure('none', 'setup:decide', { runId: run.id, proposalId: second.id, decision: { behavior: 'approve', secrets: { 'mcp_nope:env:PROP_TOKEN': 'stray' } } })
    const third = (await pending((c) => c.proposals.length === 1 && c.proposals[0].id !== second.id)).proposals[0]
    await measure('none', 'setup:decide', { runId: run.id, proposalId: third.id, decision: { behavior: 'approve' } })
  })

  it("mcp:answerInstall on install cards: project with a value, 'run' (memory only), a name the server lacks, project without", async () => {
    const c = (await pending((x) => x.mcpInstalls.length === 1)).mcpInstalls[0]
    expect((await measure('value', 'mcp:answerInstall', { runId: run.id, requestId: c.id, decision: { approved: true, scope: 'project', secrets: { INST_TOKEN: 'i-cov' } } })).origins).toEqual(['dispatcher'])
    const d = (await pending((x) => x.mcpInstalls.length === 1 && x.mcpInstalls[0].id !== c.id)).mcpInstalls[0]
    await measure('none', 'mcp:answerInstall', { runId: run.id, requestId: d.id, decision: { approved: true, scope: 'run', secrets: { INST_TOKEN: 'run-only' } } })
    const e = (await pending((x) => x.mcpInstalls.length === 1 && x.mcpInstalls[0].id !== d.id)).mcpInstalls[0]
    await measure('none', 'mcp:answerInstall', { runId: run.id, requestId: e.id, decision: { approved: true, scope: 'project', secrets: { NOT_A_SLOT: 'stray' } } })
    const f = (await pending((x) => x.mcpInstalls.length === 1 && x.mcpInstalls[0].id !== e.id)).mcpInstalls[0]
    await measure('none', 'mcp:answerInstall', { runId: run.id, requestId: f.id, decision: { approved: true, scope: 'project' } })
  })

  it('mcp:authorize: a client secret through the predicate, the tokens through the flow itself; mcp:revokeAuth never prepares', async () => {
    const github = await libraryEntry('github')
    const withSecret = await measure('value', 'mcp:authorize', { libraryId: github.entry.id, clientId: 'cov-client', clientSecret: 'cov-secret' })
    expect(withSecret.origins).toEqual(['dispatcher', 'writer'])
    const notion = await libraryEntry('notion')
    const tokenOnly = await measure('value', 'mcp:authorize', { libraryId: notion.entry.id })
    expect(tokenOnly.origins).toEqual(['writer'])
    expect(tokenOnly.stored.every((k) => k.includes(':oauth:'))).toBe(true)
    expect((await measure('none', 'mcp:revokeAuth', { libraryId: notion.entry.id })).deleted).toBeGreaterThan(0)
    // A sign-in that ends before any token (a token or no-auth connector) stores nothing and never prepares, even when
    // a client secret was typed.
    const zapier = await libraryEntry('zapier')
    await measure('none', 'mcp:authorize', { libraryId: zapier.entry.id })
    await measure('none', 'mcp:authorize', { libraryId: zapier.entry.id, clientSecret: 'never-stored' })
    const deepwiki = await libraryEntry('deepwiki')
    await measure('none', 'mcp:authorize', { libraryId: deepwiki.entry.id, clientSecret: 'never-stored' })
    expect((await measure('none', 'mcp:authorize', { projectId: project.id, serverId: 'mcp-b', clientSecret: 'never-stored' })).refused).toMatch(/Only http and sse servers/)
  })

  it('kit:applyBundle replacing a server clears its stored values without preparing', async () => {
    const bundle = await rpc<KitBundleExportResult>('kit:exportBundle', { include: { mcpServers: ['mcpl_kit'] } })
    await rpc('mcpLibrary:upsert', { id: 'mcpl_kit', name: 'lib-kit', transport: 'stdio', command: 'npx', args: ['-y', 'lib-kit@2.0.0'], secretEnv: ['LIB_KIT'], source: 'user', addedAt: '' })
    await seed(mcpLibrarySecretKey('mcpl_kit', 'env', 'LIB_KIT'), 'kit-value')
    const preview = await rpc<KitImportPreview>('kit:previewBundle', { fileName: bundle.fileName, rawBytesBase64: bundle.rawBytesBase64 })
    const choices = preview.items.map((i) => ({ key: i.key, action: i.status === 'different' ? ('replace' as const) : ('skip' as const) }))
    expect(choices.some((c) => c.action === 'replace')).toBe(true)
    const r = await measure('none', 'kit:applyBundle', { rawBytesBase64: bundle.rawBytesBase64, digest: preview.digest, targetDigest: preview.targetDigest, choices })
    expect(r.deleted).toBeGreaterThan(0)
    expect(secrets.has(mcpLibrarySecretKey('mcpl_kit', 'env', 'LIB_KIT'))).toBe(false)
  })

  it('mcp:promote and mcp:copyFromLibrary carry readable values through the predicate; nothing to carry never prepares', async () => {
    expect((await measure('value', 'mcp:promote', { projectId: project.id, serverId: 'mcp-a' })).origins).toEqual(['dispatcher'])
    await measure('none', 'mcp:promote', { projectId: project.id, serverId: 'mcp-b' })
    const links = (await rpc<{ spec: { id: string; libraryId?: string } }[]>('mcp:list', project.id)).filter((s) => s.spec.libraryId)
    const one = links.find((s) => s.spec.libraryId === 'mcpl_one')!
    const two = links.find((s) => s.spec.libraryId === 'mcpl_two')!
    expect((await measure('value', 'mcp:copyFromLibrary', { projectId: project.id, serverId: one.spec.id, copySecrets: true })).origins).toEqual(['dispatcher'])
    await measure('none', 'mcp:copyFromLibrary', { projectId: project.id, serverId: two.spec.id, copySecrets: false })
  })

  it("values the OrgAI app saved (pending-legacy here) are never carried or cleared, and a value over one prepares first (5.4, 5.5)", async () => {
    // A project-only server, a library entry linked with copySecrets, a per-project link, a token connector and the
    // LiteLLM key, each holding only the app's value.
    await rpc('mcp:upsert', { projectId: project.id, spec: { id: 'mcp-app', name: 'srv-app', transport: 'stdio', command: 'npx', args: ['-y', 'srv-app@1.0.0'], secretEnv: ['APP_TOKEN'], enabled: true, source: 'user', addedAt: '' } })
    const appKey = mcpSecretKey(project.id, 'mcp-app', 'env', 'APP_TOKEN')
    secrets.seedAppValue(appKey, 'from-the-app')
    for (const [id, name, slot, perProject] of [['mcpl_app', 'lib-app', 'LIB_APP', false], ['mcpl_pp', 'lib-pp', 'LIB_PP', true]] as const) {
      await rpc('mcpLibrary:upsert', { id, name, transport: 'stdio', command: 'npx', args: ['-y', `${name}@1.0.0`], secretEnv: [slot], source: 'user', addedAt: '', ...(perProject ? { perProjectSecrets: true } : {}) })
      await rpc('mcp:linkLibrary', { projectId: project.id, libraryId: id })
    }
    const links = (await rpc<{ spec: { id: string; libraryId?: string } }[]>('mcp:list', project.id)).filter((s) => s.spec.libraryId)
    const appLink = links.find((s) => s.spec.libraryId === 'mcpl_app')!.spec.id
    const ppLink = links.find((s) => s.spec.libraryId === 'mcpl_pp')!.spec.id
    const libKey = mcpLibrarySecretKey('mcpl_app', 'env', 'LIB_APP')
    const ppKey = mcpSecretKey(project.id, ppLink, 'env', 'LIB_PP')
    secrets.seedAppValue(libKey, 'lib-from-the-app')
    secrets.seedAppValue(ppKey, 'pp-from-the-app')
    const zapier = await libraryEntry('zapier')
    const zapKey = mcpLibrarySecretKey(zapier.entry.id, 'header', zapier.entry.secretHeaders![0])
    secrets.seedAppValue(zapKey, 'Bearer zap-from-the-app')
    secrets.seedAppValue(LITELLM_KEY, 'sk-from-the-app')
    for (const k of [appKey, libKey, ppKey, zapKey, LITELLM_KEY]) expect(secrets.status(k), k).toEqual({ unreadable: VAULT_MESSAGES.pendingLegacy })
    const before = JSON.stringify(host.services.projects.get(project.id))

    // Moves: the predicate sees an unreadable source (no prepare) and the handler refuses before any change.
    const refused = async (channel: string, input: unknown, sentence: string): Promise<void> => {
      const r = await measure('none', channel, input)
      expect(r.refused, channel).toContain(sentence)
      expect(r.deleted, `${channel} deleted something`).toBe(0)
    }
    await refused('mcp:promote', { projectId: project.id, serverId: 'mcp-app' }, VAULT_MESSAGES.moveRefused('APP_TOKEN', 'srv-app', VAULT_MESSAGES.pendingLegacy))
    await refused('mcp:copyFromLibrary', { projectId: project.id, serverId: appLink, copySecrets: true }, VAULT_MESSAGES.moveRefused('LIB_APP', 'lib-app', VAULT_MESSAGES.pendingLegacy))
    await refused('mcp:copyFromLibrary', { projectId: project.id, serverId: ppLink, copySecrets: false }, VAULT_MESSAGES.moveRefused('LIB_PP', 'lib-pp', VAULT_MESSAGES.pendingLegacy))
    expect(JSON.stringify(host.services.projects.get(project.id))).toBe(before)

    // Explicit clears: refused while there is no vault (5.5), so the app's copy is never dropped from here.
    await refused('mcp:setSecret', { projectId: project.id, serverId: 'mcp-app', kind: 'env', name: 'APP_TOKEN', value: null }, VAULT_MESSAGES.clearRefusedLegacyOnly)
    await refused('mcpLibrary:setSecret', { libraryId: 'mcpl_app', kind: 'env', name: 'LIB_APP', value: '' }, VAULT_MESSAGES.clearRefusedLegacyOnly)
    await refused('connectors:setToken', { connectorId: 'zapier', token: null }, VAULT_MESSAGES.clearRefusedLegacyOnly)
    await refused('connections:setSecret', { id: 'litellm', apiKey: null }, VAULT_MESSAGES.clearRefusedLegacyOnly)
    for (const k of [appKey, libKey, ppKey, zapKey, LITELLM_KEY]) expect(secrets.status(k), k).toEqual({ unreadable: VAULT_MESSAGES.pendingLegacy })

    // A Node write over the app's value prepares first and supersedes it (round 6 item 1); the move then carries it.
    expect((await measure('value', 'mcp:setSecret', { projectId: project.id, serverId: 'mcp-app', kind: 'env', name: 'APP_TOKEN', value: 'from-node' })).origins).toEqual(['dispatcher'])
    expect(secrets.status(appKey)).toBe('set')
    expect((await measure('value', 'mcp:promote', { projectId: project.id, serverId: 'mcp-app' })).origins).toEqual(['dispatcher'])
  })

  it('removals delete without ever preparing', async () => {
    expect((await measure('none', 'mcp:remove', { projectId: project.id, serverId: 'mcp-gone' })).deleted).toBeGreaterThan(0)
    expect((await measure('none', 'mcpLibrary:remove', { libraryId: 'mcpl_gone' })).deleted).toBeGreaterThan(0)
    const other = await rpc<Project>('projects:create', { name: 'Gone', path: join(root, 'project-2'), brief: '', mock: true })
    await rpc('mcp:upsert', { projectId: other.id, spec: { id: 'mcp-x', name: 'srv-x', transport: 'stdio', command: 'npx', args: ['-y', 'srv-x@1.0.0'], secretEnv: ['X'], enabled: true, source: 'user', addedAt: '' } })
    await seed(mcpSecretKey(other.id, 'mcp-x', 'env', 'X'), 'x')
    expect((await measure('none', 'projects:remove', { projectId: other.id, removeRuns: true })).deleted).toBeGreaterThan(0)
    expect(secrets.keys(`mcp:${other.id}:`)).toEqual([])
  })

  it('accounts for every mutation channel: driven here, covered elsewhere, or never writing a secret', () => {
    const mutations = requestEntries()
      .filter(([, e]) => e.scope !== 'read' && e.scope !== 'desktop_only' && !e.transport)
      .map(([c]) => c)
    const unaccounted = mutations.filter((c) => !driven.has(c) && !Object.hasOwn(COVERED_ELSEWHERE, c) && !Object.hasOwn(NEVER_WRITES_SECRETS, c))
    expect(unaccounted, 'decide for each: drive it here, or list it with its reason').toEqual([])
    // The lists name real mutation channels only, and a channel driven here is not also excused.
    for (const c of [...Object.keys(COVERED_ELSEWHERE), ...Object.keys(NEVER_WRITES_SECRETS)]) {
      expect(mutations, c).toContain(c)
      expect(driven.has(c), `${c} is driven here; drop it from the lists`).toBe(false)
    }
    // Every storesSecret channel was driven both with a value and without one.
    for (const channel of Object.keys(STORES_SECRET)) {
      expect([...(driven.get(channel) ?? [])].sort(), channel).toEqual(['none', 'value'])
    }
    expect(secrets.violations).toEqual([])
  })
})
