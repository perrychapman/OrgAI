/**
 * Approved MCP proposals and the Wave 7 secret vault (cli-standalone.md round 6 item 10), on real stores and services
 * with a FixtureVaultStore: the values typed on the card are stored before projects.json or mcp-library.json changes;
 * a store that cannot take them now (locked, damaged, or a write that fails after preparation) refuses the approval
 * with nothing applied, the earlier values intact and the card still open, waiting for secrets (never swallowed). No
 * secret value ever reaches an event.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, ProposalDecision, RunEvent } from '@shared/types'
import { MCP_HARNESS_TOOLS, proposalSecretKey } from '@shared/types'
import { RunManager } from './runManager'
import { harnessToolsFor } from './harnessTools'
import type { RuntimeAdapter, RuntimeContext } from './types'
import { RunStore } from '../store/runs'
import { ProjectStore } from '../store/projects'
import { McpLibraryStore } from '../store/mcpLibrary'
import { mcpOAuthKey } from '../store/secrets'
import { FixtureVaultStore } from '../store/vaultStore.fixture'
import { McpService } from '../mcp/service'
import { SetupService } from '../setup/service'

vi.mock('../log', () => ({ logRunEvent: () => {}, logPermission: () => {}, log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } }))

const SECRET = 'ghp_vaultsecretvalue987'

let dir: string
let events: RunEvent[]
let store: ProjectStore
let secrets: FixtureVaultStore
let mcp: McpService
let setup: SetupService

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orgai-vaultprop-'))
  mkdirSync(join(dir, 'repo'))
  events = []
  const data = join(dir, 'data')
  store = new ProjectStore(data)
  secrets = new FixtureVaultStore(data)
  mcp = new McpService({ projects: store, secrets, library: new McpLibraryStore(data) })
  setup = new SetupService(store, {
    mcp: { libraryEntries: () => mcp.libraryEntries(), applyProposal: (id, pl, opts) => mcp.applyProposal(id, pl, opts), applyLibraryProposal: (pl, opts) => mcp.applyLibraryProposal(pl, opts) }
  })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function waitFor<T extends RunEvent>(pred: (e: RunEvent) => e is T, after = 0, timeoutMs = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = (): void => {
      const hit = events.slice(after).find(pred)
      if (hit) return resolve(hit)
      if (Date.now() - started > timeoutMs) return reject(new Error(`timed out; saw ${events.map((e) => e.type).join(', ')}`))
      setTimeout(tick, 2)
    }
    tick()
  })
}

async function rig() {
  const p: Project = store.create({ name: 'Vault', path: join(dir, 'repo'), brief: '' })
  const ctxs: RuntimeContext[] = []
  const adapter: RuntimeAdapter = {
    id: 'claude',
    complete: async () => '',
    start: async (ctx) => {
      ctxs.push(ctx)
      ctx.emit({ type: 'run.status', runId: ctx.run.id, status: 'running' })
      return { send: async () => {}, interrupt: async () => {}, stop: async () => {}, finished: new Promise<void>(() => {}) }
    }
  }
  const m = new RunManager({ claude: adapter }, (e) => void events.push(e), new RunStore(join(dir, 'data')), setup, () => 100, {
    mcp: {
      enabledServers: (pr) => mcp.enabledServers(pr),
      resolve: (pid, spec, extra) => mcp.resolve(pid, spec, extra),
      persistInstall: (pid, spec, values, scope) => mcp.persistInstall(pid, spec, values, scope),
      withLibrary: (pr) => mcp.withLibrary(pr),
      skippedServers: (pr) => mcp.skippedServers(pr),
      libraryEntries: () => mcp.libraryEntries(),
      storeProposalSecrets: (pid, pl, values) => mcp.storeProposalSecrets(pid, pl, values),
      secretsRefusal: () => mcp.secretsRefusal(),
      searchRegistry: async () => ({ entries: [] })
    }
  })
  const run = await m.start({ project: p, prompt: 'go' })
  const tools = harnessToolsFor(ctxs[0], { configChanged: async () => ({ availability: 'after-idle' }) })
  type Card = Extract<RunEvent, { type: 'proposal.request' }>
  /** Ask for a server with one secret slot (same name = a redefinition); resolves with the card (the tool keeps waiting). */
  const propose = async (version = '1.2.3', value = SECRET) => {
    const at = events.length
    const pending = tools
      .find((t) => t.name === MCP_HARNESS_TOOLS.proposeServers)!
      .call({ title: 'Add gh', rationale: 'r', upsert: [{ name: 'gh', transport: 'stdio', command: 'npx', args: ['-y', `gh-mcp@${version}`], secretEnv: ['GH_TOKEN'] }] }, {})
    const card = await waitFor((e): e is Card => e.type === 'proposal.request', at)
    const slot = card.proposal.kind === 'mcpServers' ? card.proposal.payload.secrets![0] : undefined
    const withSecret: ProposalDecision = { behavior: 'approve', secrets: { [proposalSecretKey(slot!)]: value } }
    return { pending, card, withSecret }
  }
  return { p, m, run, propose }
}

describe('MCP proposal secrets and the vault (round 6 item 10)', () => {
  it('values the vault cannot take now refuse the approval before anything is applied; the card stays open', async () => {
    const { p, m, run, propose } = await rig()
    const { pending, card, withSecret } = await propose()
    secrets.setState('locked')
    const before = JSON.stringify(store.get(p.id))
    expect(() => m.decideProposal(run.id, card.proposal.id, withSecret)).toThrow(/^The secret values could not be saved: The secret vault is locked.*Nothing was applied; the card is still open\.$/)
    expect(JSON.stringify(store.get(p.id))).toBe(before)
    expect(m.pendingCards(run.id).proposals.map((x) => x.id)).toEqual([card.proposal.id])
    expect(events.some((e) => e.type === 'proposal.resolved')).toBe(false)
    // Unlocked: the same card approves and stores the value.
    secrets.setState('open')
    expect(m.decideProposal(run.id, card.proposal.id, withSecret)).toMatchObject({ status: 'applied' })
    expect(await pending).toMatch(/^APPROVED/)
    const gh = store.get(p.id)!.mcpServers!.find((s) => s.name === 'gh')!
    expect(mcp.resolve(p.id, gh).env.GH_TOKEN).toBe(SECRET)
    expect(JSON.stringify(events)).not.toContain(SECRET)
    await m.stopAll()
  })

  it('an approval without values is not held back by a locked vault (the server waits for its secret)', async () => {
    const { p, m, run, propose } = await rig()
    const { pending, card } = await propose()
    secrets.setState('locked')
    m.decideProposal(run.id, card.proposal.id, { behavior: 'approve' })
    expect(await pending).toMatch(/^APPROVED/)
    expect(store.get(p.id)!.mcpServers!.map((s) => s.name)).toEqual(['gh'])
    const resolved = events.find((e) => e.type === 'proposal.resolved')
    expect(resolved).toMatchObject({ decision: { behavior: 'approve', waitingForSecrets: ['gh'] } })
    await m.stopAll()
  })

  it('a write the store refuses after preparation applies nothing, leaves no value and keeps the card open', async () => {
    const { p, m, run, propose } = await rig()
    const { pending, card, withSecret } = await propose()
    const before = JSON.stringify(store.get(p.id))
    secrets.failSet = () => true
    expect(() => m.decideProposal(run.id, card.proposal.id, withSecret)).toThrow(/^The secret values could not be saved: could not write .*Nothing was applied; the card is still open\.$/)
    expect(JSON.stringify(store.get(p.id))).toBe(before)
    expect(secrets.keys('mcp:')).toEqual([])
    expect(m.pendingCards(run.id).proposals.map((x) => x.id)).toEqual([card.proposal.id])
    expect(events.some((e) => e.type === 'proposal.resolved' || e.type === 'project.updated')).toBe(false)
    // The write works again: the same card approves and the value is there.
    secrets.failSet = undefined
    expect(m.decideProposal(run.id, card.proposal.id, withSecret)).toMatchObject({ status: 'applied' })
    expect(await pending).toMatch(/^APPROVED/)
    const gh = store.get(p.id)!.mcpServers!.find((s) => s.name === 'gh')!
    expect(mcp.resolve(p.id, gh).env.GH_TOKEN).toBe(SECRET)
    expect(events.find((e) => e.type === 'proposal.resolved')).toMatchObject({ decision: { behavior: 'approve' } })
    expect(JSON.stringify(events)).not.toContain(SECRET)
    await m.stopAll()
  })

  it('a redefinition that clears the stored secret never applies when its new value cannot be saved (Argon 6)', async () => {
    const { p, m, run, propose } = await rig()
    const first = await propose('1.2.3', SECRET)
    m.decideProposal(run.id, first.card.proposal.id, first.withSecret)
    expect(await first.pending).toMatch(/^APPROVED/)
    const NEW = 'ghp_newvaluefortheredefinition'
    const second = await propose('2.0.0', NEW)
    const before = JSON.stringify(store.get(p.id))
    secrets.failSet = () => true
    expect(() => m.decideProposal(run.id, second.card.proposal.id, second.withSecret)).toThrow(/Nothing was applied; the card is still open/)
    // Neither the new definition nor a lost value: the old server keeps its old secret.
    expect(JSON.stringify(store.get(p.id))).toBe(before)
    const old = store.get(p.id)!.mcpServers!.find((s) => s.name === 'gh')!
    expect(old.args).toEqual(['-y', 'gh-mcp@1.2.3'])
    expect(mcp.resolve(p.id, old).env.GH_TOKEN).toBe(SECRET)
    expect(m.pendingCards(run.id).proposals.map((x) => x.id)).toEqual([second.card.proposal.id])
    secrets.failSet = undefined
    m.decideProposal(run.id, second.card.proposal.id, second.withSecret)
    expect(await second.pending).toMatch(/^APPROVED/)
    const now = store.get(p.id)!.mcpServers!.find((s) => s.name === 'gh')!
    expect(now.args).toEqual(['-y', 'gh-mcp@2.0.0'])
    expect(mcp.resolve(p.id, now).env.GH_TOKEN).toBe(NEW)
    expect(JSON.stringify(events)).not.toContain(SECRET)
    expect(JSON.stringify(events)).not.toContain(NEW)
    await m.stopAll()
  })

  it('a run start refreshes an expiring sign-in through the writer, which prepares the vault itself (runs:start, 5.6)', async () => {
    // A fresh Node host: no vault until something stores a value.
    const data = join(dir, 'data')
    secrets = new FixtureVaultStore(data, { lazy: true })
    const refreshTokens = vi.fn(async () => ({ accessToken: 'AT-new', refreshToken: 'RT-new', expiresAt: '2099-01-01T00:00:00.000Z' }))
    const runAuthorization = vi.fn()
    mcp = new McpService({ projects: store, secrets, library: new McpLibraryStore(data), oauth: { runAuthorization, refreshTokens } })
    const p: Project = store.create({ name: 'Refresh', path: join(dir, 'repo'), brief: '' })
    store.save({
      ...p,
      mcpServers: [
        {
          id: 'mcp-o',
          name: 'docs',
          transport: 'http',
          url: 'https://docs.test/mcp',
          enabled: true,
          source: 'user',
          addedAt: '',
          oauth: { resource: 'https://docs.test/mcp', tokenEndpoint: 'https://as.test/token', clientId: 'cid', clientSource: 'dcr', authorizedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-01-01T01:00:00.000Z' }
        }
      ]
    })
    await secrets.prepareWrite()
    secrets.set(mcpOAuthKey(p.id, 'mcp-o', 'refreshToken'), 'RT-old')
    secrets.forgetVault()
    secrets.log.length = 0
    // Like the Claude and Codex adapters: the session resolves its servers when it starts.
    const adapter: RuntimeAdapter = {
      id: 'claude',
      complete: async () => '',
      start: async (ctx) => {
        await ctx.resolvedMcpServers?.()
        ctx.emit({ type: 'run.status', runId: ctx.run.id, status: 'running' })
        return { send: async () => {}, interrupt: async () => {}, stop: async () => {}, finished: new Promise<void>(() => {}) }
      }
    }
    const m = new RunManager({ claude: adapter }, (e) => void events.push(e), new RunStore(data), setup, () => 100, {
      mcp: {
        enabledServers: (pr) => mcp.enabledServers(pr),
        resolve: (pid, spec, extra) => mcp.resolve(pid, spec, extra),
        prepareForRun: (pid, specs) => mcp.prepareForRun(pid, specs),
        persistInstall: (pid, spec, values, scope) => mcp.persistInstall(pid, spec, values, scope),
        withLibrary: (pr) => mcp.withLibrary(pr),
        skippedServers: (pr) => mcp.skippedServers(pr),
        libraryEntries: () => mcp.libraryEntries(),
        searchRegistry: async () => ({ entries: [] })
      }
    })
    await m.start({ project: store.get(p.id)!, prompt: 'go' })
    await vi.waitFor(() => expect(secrets.get(mcpOAuthKey(p.id, 'mcp-o', 'accessToken'))).toBe('AT-new'))
    expect(refreshTokens).toHaveBeenCalledTimes(1)
    expect(secrets.violations).toEqual([])
    const ops = secrets.log.map((e) => (e.op === 'prepare' ? `prepare:${e.origin}` : e.op === 'set' && e.value ? 'set' : '')).filter(Boolean)
    expect(ops[0]).toBe('prepare:writer')
    expect(ops.filter((o) => o.startsWith('prepare')).every((o) => o === 'prepare:writer')).toBe(true)
    expect(ops.slice(-2)).toEqual(['set', 'set'])
    await m.stopAll()
  })
})
