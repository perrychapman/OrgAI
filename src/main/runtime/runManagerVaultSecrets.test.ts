/**
 * Approved MCP proposals and the Wave 7 secret vault (cli-standalone.md round 6 item 10), on real stores and services
 * with a FixtureVaultStore: values the store cannot take now refuse the approval before anything is applied and keep
 * the card open; a write that fails after the apply is shown on the run and the servers are reported as waiting for
 * secrets (never swallowed). No secret value ever reaches an event.
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
    mcp: { libraryEntries: () => mcp.libraryEntries(), applyProposal: (id, pl, opts) => mcp.applyProposal(id, pl, opts), applyLibraryProposal: (pl) => mcp.applyLibraryProposal(pl) }
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
  /** Ask for a server with one secret slot; resolves with the card (the tool keeps waiting). */
  const propose = async () => {
    const at = events.length
    const pending = tools
      .find((t) => t.name === MCP_HARNESS_TOOLS.proposeServers)!
      .call({ title: 'Add gh', rationale: 'r', upsert: [{ name: 'gh', transport: 'stdio', command: 'npx', args: ['-y', 'gh-mcp@1.2.3'], secretEnv: ['GH_TOKEN'] }] }, {})
    const card = await waitFor((e): e is Card => e.type === 'proposal.request', at)
    const slot = card.proposal.kind === 'mcpServers' ? card.proposal.payload.secrets![0] : undefined
    const withSecret: ProposalDecision = { behavior: 'approve', secrets: { [proposalSecretKey(slot!)]: SECRET } }
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

  it('a write that fails after the apply is shown on the run and reported as waiting for secrets, never swallowed', async () => {
    const { m, run, propose } = await rig()
    const { pending, card, withSecret } = await propose()
    secrets.failSet = () => true
    m.decideProposal(run.id, card.proposal.id, withSecret)
    expect(await pending).toMatch(/^APPROVED/)
    const resolved = events.find((e) => e.type === 'proposal.resolved')
    expect(resolved).toMatchObject({ decision: { behavior: 'approve', waitingForSecrets: ['gh'] } })
    const logged = events.find((e) => e.type === 'log' && e.level === 'error' && /could not be saved/.test(e.message))
    expect(logged).toBeDefined()
    expect(JSON.stringify(events)).not.toContain(SECRET)
    await m.stopAll()
  })
})
