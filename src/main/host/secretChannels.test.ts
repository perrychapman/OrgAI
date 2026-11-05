/**
 * Channel coverage of the secret vault (docs/design/cli-standalone.md 5.6 "Test", round 6 item 4). A mock in-process
 * host (bootOrgAIHost, hostKind 'inproc', the mock adapter) is seeded with a project, a project MCP server, library
 * entries, connectors and a work run holding pending MCP-proposal and MCP-install cards. Every channel that reaches the
 * SecretStore is then driven through HostDispatcher.invokeRpc with a value and with a clear (or without a value), on a
 * store that is 'absent' before each call, as on a fresh Node host:
 *
 * - a call that stores a value must have prepared the vault first, either through its storesSecret predicate (the
 *   dispatcher) or through the writer itself (OAuth commits); set() on an unprepared vault throws VaultNotReady and is
 *   recorded as a violation, so a channel that stores without either fails here;
 * - a clear, a removal or a call that stores nothing never prepares (never creates a vault or a keychain item).
 *
 * The real vault is WP-G's; FixtureVaultStore enforces the 'absent' bug trap. No tokens, no network, no keychain.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { DaemonInfo, HostScope, McpLibraryInfo, PendingCards, Project, RunSummary } from '../../shared/types'
import { MCP_HARNESS_TOOLS } from '../../shared/types'
import { FixtureVaultStore } from '../store/vaultStore.fixture'
import { STORES_SECRET } from './storesSecret'

vi.mock('electron', () => {
  throw new Error('electron must not be imported by the host bootstrap')
})

const { bootOrgAIHost } = await import('./bootstrap')
type OrgAIHost = import('./bootstrap').OrgAIHost

const ALL: readonly HostScope[] = ['read', 'operate', 'decide', 'configure']
const CTX = { surface: 'inproc' as const, grantedScopes: ALL }
const info: DaemonInfo = { hostInstanceId: 'abcdef012345', pid: 4242, endpoint: '/tmp/x.sock', state: 'starting', startedAt: 1_700_000_000_000, hostKind: 'inproc' }

let root: string
let host: OrgAIHost
let secrets: FixtureVaultStore
let project: Project
let run: RunSummary
const savedScript = process.env.ORGAI_MOCK_SCRIPT

/** The work run's script: two proposals and three install requests, each with a secret slot, answered in order. */
const SCRIPT = {
  delayMs: 0,
  work: [
    { type: 'harness', name: MCP_HARNESS_TOOLS.proposeServers, retryOnRevise: false, args: { title: 'A', rationale: 'r', upsert: [{ name: 'prop-a', transport: 'stdio', command: 'npx', args: ['-y', 'prop-a@1.0.0'], secretEnv: ['PROP_A'] }] } },
    { type: 'harness', name: MCP_HARNESS_TOOLS.proposeServers, retryOnRevise: false, args: { title: 'B', rationale: 'r', upsert: [{ name: 'prop-b', transport: 'stdio', command: 'npx', args: ['-y', 'prop-b@1.0.0'], secretEnv: ['PROP_B'] }] } },
    ...['inst-c', 'inst-d', 'inst-e'].map((name) => ({
      type: 'harness',
      name: MCP_HARNESS_TOOLS.requestInstall,
      retryOnRevise: false,
      args: { reason: 'coverage', manual: { name, transport: 'stdio', command: 'npx', args: ['-y', `${name}@1.0.0`], secretEnv: ['INST_TOKEN'] } }
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
}

/** Channel -> how it was driven ('value' stored something; 'none' was a clear or stored nothing). */
const driven = new Map<string, Set<'value' | 'none'>>()

/**
 * One call on a fresh 'absent' vault. 'value': at least one value stored, each after a prepare in this call.
 * 'none': nothing stored, no prepare, the vault still 'absent'.
 */
async function measure(kind: 'value' | 'none', channel: string, ...params: unknown[]): Promise<Measured> {
  secrets.forgetVault()
  secrets.log.length = 0
  const violationsBefore = secrets.violations.length
  await rpc(channel, ...params)
  const log = [...secrets.log]
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
  return { stored, origins, deleted: log.filter((e) => e.op === 'delete' || e.op === 'deletePrefix').length }
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

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'orgai-secret-channels-'))
  const dataDir = join(root, 'data')
  mkdirSync(join(root, 'project'), { recursive: true })
  mkdirSync(dataDir, { recursive: true })
  const scriptFile = join(root, 'script.json')
  writeFileSync(scriptFile, JSON.stringify(SCRIPT))
  process.env.ORGAI_MOCK_SCRIPT = scriptFile
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

  // Seed: a project with a project-only server (and one without secrets), two library entries linked to it, connectors.
  project = await rpc<Project>('projects:create', { name: 'Secrets', path: join(root, 'project'), brief: '', mock: true })
  const server = (id: string, name: string, secretEnv?: string[]) => ({ id, name, transport: 'stdio', command: 'npx', args: ['-y', `${name}@1.0.0`], ...(secretEnv ? { secretEnv } : {}), enabled: true, source: 'user', addedAt: '' })
  await rpc('mcp:upsert', { projectId: project.id, spec: server('mcp-a', 'srv-a', ['A_TOKEN']) })
  await rpc('mcp:upsert', { projectId: project.id, spec: server('mcp-b', 'srv-b') })
  await rpc('mcp:upsert', { projectId: project.id, spec: server('mcp-gone', 'srv-gone', ['GONE_TOKEN']) })
  for (const [id, name, slot] of [['mcpl_one', 'lib-one', 'LIB_ONE'], ['mcpl_two', 'lib-two', 'LIB_TWO'], ['mcpl_gone', 'lib-gone', 'LIB_GONE']]) {
    await rpc('mcpLibrary:upsert', { id, name, transport: 'stdio', command: 'npx', args: ['-y', `${name}@1.0.0`], secretEnv: [slot], source: 'user', addedAt: '' })
  }
  await rpc('mcp:linkLibrary', { projectId: project.id, libraryId: 'mcpl_one' })
  await rpc('mcp:linkLibrary', { projectId: project.id, libraryId: 'mcpl_two' })
  await rpc('connectors:add', { connectorId: 'zapier' })
  await rpc('connectors:add', { connectorId: 'notion' })
  await rpc('connectors:add', { connectorId: 'github', variant: 'app-readonly' })
  run = await rpc<RunSummary>('runs:start', { projectId: project.id, prompt: 'Cover every secret channel.' })
}, 60_000)

afterAll(async () => {
  await host?.runs.stopAll({ reason: 'quit' }).catch(() => {})
  host?.dispose()
  if (savedScript === undefined) delete process.env.ORGAI_MOCK_SCRIPT
  else process.env.ORGAI_MOCK_SCRIPT = savedScript
  rmSync(root, { recursive: true, force: true })
})

const libraryEntry = async (connectorId: string): Promise<McpLibraryInfo> => (await rpc<McpLibraryInfo[]>('mcpLibrary:list')).find((l) => l.entry.connectorId === connectorId)!

describe('every channel that reaches SecretStore prepares before a value and never for a clear (5.6, round 6 item 4)', () => {
  it('connections:setSecret', async () => {
    expect((await measure('value', 'connections:setSecret', { id: 'litellm', apiKey: 'sk-cov' })).origins).toEqual(['dispatcher'])
    expect((await measure('none', 'connections:setSecret', { id: 'litellm', apiKey: null })).deleted).toBeGreaterThan(0)
    await measure('none', 'connections:setSecret', { id: 'litellm', apiKey: '  ' })
  })

  it('connectors:setToken', async () => {
    expect((await measure('value', 'connectors:setToken', { connectorId: 'zapier', token: 'zap-cov' })).origins).toEqual(['dispatcher'])
    expect((await measure('none', 'connectors:setToken', { connectorId: 'zapier', token: null })).deleted).toBeGreaterThan(0)
  })

  it('mcp:setSecret and mcpLibrary:setSecret', async () => {
    expect((await measure('value', 'mcp:setSecret', { projectId: project.id, serverId: 'mcp-a', kind: 'env', name: 'A_TOKEN', value: 'a-cov' })).origins).toEqual(['dispatcher'])
    await measure('none', 'mcp:setSecret', { projectId: project.id, serverId: 'mcp-a', kind: 'env', name: 'A_TOKEN', value: null })
    await measure('value', 'mcp:setSecret', { projectId: project.id, serverId: 'mcp-a', kind: 'env', name: 'A_TOKEN', value: 'a-cov' })
    await measure('value', 'mcp:setSecret', { projectId: project.id, serverId: 'mcp-gone', kind: 'env', name: 'GONE_TOKEN', value: 'g-cov' })
    expect((await measure('value', 'mcpLibrary:setSecret', { libraryId: 'mcpl_one', kind: 'env', name: 'LIB_ONE', value: 'l1-cov' })).origins).toEqual(['dispatcher'])
    await measure('none', 'mcpLibrary:setSecret', { libraryId: 'mcpl_one', kind: 'env', name: 'LIB_ONE', value: null })
    for (const [libraryId, name] of [['mcpl_one', 'LIB_ONE'], ['mcpl_two', 'LIB_TWO'], ['mcpl_gone', 'LIB_GONE']]) {
      await measure('value', 'mcpLibrary:setSecret', { libraryId, kind: 'env', name, value: `${name}-cov` })
    }
  })

  it('setup:decide on MCP proposal cards: with values, and without', async () => {
    const first = await pending((c) => c.proposals.length === 1)
    const a = first.proposals[0]
    const slot = a.kind === 'mcpServers' ? a.payload.secrets![0] : undefined
    expect(slot?.name).toBe('PROP_A')
    const r = await measure('value', 'setup:decide', { runId: run.id, proposalId: a.id, decision: { behavior: 'approve', secrets: { [`${slot!.serverId}:env:PROP_A`]: 'pa-cov' } } })
    expect(r.origins).toEqual(['dispatcher'])
    const second = await pending((c) => c.proposals.length === 1 && c.proposals[0].id !== a.id)
    await measure('none', 'setup:decide', { runId: run.id, proposalId: second.proposals[0].id, decision: { behavior: 'approve' } })
  })

  it("mcp:answerInstall on install cards: project with a value, 'run' with a value (memory only), project without", async () => {
    const c = (await pending((x) => x.mcpInstalls.length === 1)).mcpInstalls[0]
    expect((await measure('value', 'mcp:answerInstall', { runId: run.id, requestId: c.id, decision: { approved: true, scope: 'project', secrets: { INST_TOKEN: 'i-cov' } } })).origins).toEqual(['dispatcher'])
    const d = (await pending((x) => x.mcpInstalls.length === 1 && x.mcpInstalls[0].id !== c.id)).mcpInstalls[0]
    await measure('none', 'mcp:answerInstall', { runId: run.id, requestId: d.id, decision: { approved: true, scope: 'run', secrets: { INST_TOKEN: 'run-only' } } })
    const e = (await pending((x) => x.mcpInstalls.length === 1 && x.mcpInstalls[0].id !== d.id)).mcpInstalls[0]
    await measure('none', 'mcp:answerInstall', { runId: run.id, requestId: e.id, decision: { approved: true, scope: 'project' } })
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
    // A sign-in that ends before any token (a token connector has no OAuth) stores nothing and never prepares.
    const zapier = await libraryEntry('zapier')
    await measure('none', 'mcp:authorize', { libraryId: zapier.entry.id })
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

  it('removals delete without ever preparing', async () => {
    expect((await measure('none', 'mcp:remove', { projectId: project.id, serverId: 'mcp-gone' })).deleted).toBeGreaterThan(0)
    expect((await measure('none', 'mcpLibrary:remove', { libraryId: 'mcpl_gone' })).deleted).toBeGreaterThan(0)
  })

  it('covered every storesSecret channel with a value and without; no value ever reached an unprepared vault', () => {
    for (const channel of Object.keys(STORES_SECRET)) {
      expect([...(driven.get(channel) ?? [])].sort(), channel).toEqual(['none', 'value'])
    }
    expect(secrets.violations).toEqual([])
  })
})
