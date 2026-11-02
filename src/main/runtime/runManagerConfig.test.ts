import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpServerSpec, Project, RunEvent } from '@shared/types'
import { MCP_HARNESS_TOOLS, SKILL_ASSIST_HARNESS_TOOLS, SKILL_HARNESS_TOOLS, proposalSecretKey, type ProposalDecision } from '@shared/types'
import { PROPOSAL_TOOLS } from '@shared/setup'
import { RunManager } from './runManager'
import { MockAdapter, CONFIG_CHANGE_TOKEN, MOCK_CONFIG_SERVER, MOCK_CONFIG_SKILL } from './mock'
import { harnessToolsFor, type ConfigChange } from './harnessTools'
import type { RuntimeAdapter, RuntimeContext } from './types'
import { RunStore } from '../store/runs'
import { ProjectStore } from '../store/projects'
import { SecretStore } from '../store/secrets'
import { McpLibraryStore } from '../store/mcpLibrary'
import { McpService } from '../mcp/service'
import { SkillService } from '../skills/service'
import { SetupService } from '../setup/service'

// The real logger writes under Electron's userData; tests have no Electron.
vi.mock('../log', () => ({ logRunEvent: () => {}, logPermission: () => {}, log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } }))

/**
 * End to end on real stores and services (ProjectStore, SecretStore, McpService, SkillService, SetupService) with
 * RunManager: a work run's orchestrator changes its own project's MCP and skill configuration behind approval cards,
 * and the approved change reaches the live run.
 */

let dir: string
let events: RunEvent[]
let store: ProjectStore
let mcp: McpService
let skills: SkillService
let setup: SetupService

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orgai-cfg-'))
  mkdirSync(join(dir, 'repo'))
  events = []
  const data = join(dir, 'data')
  store = new ProjectStore(data)
  const secrets = new SecretStore(data, { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() })
  mcp = new McpService({ projects: store, secrets, library: new McpLibraryStore(data) })
  skills = new SkillService({ dataDir: data, projects: store })
  setup = new SetupService(store, {
    mcp: { libraryEntries: () => mcp.libraryEntries(), applyProposal: (id, pl, opts) => mcp.applyProposal(id, pl, opts), applyLibraryProposal: (pl) => mcp.applyLibraryProposal(pl) },
    skills: { applyProposal: (id, pl) => skills.applyProposal(id, pl) }
  })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function manager(adapters: ConstructorParameters<typeof RunManager>[0]): RunManager {
  return new RunManager(adapters, (e) => void events.push(e), new RunStore(join(dir, 'data')), setup, () => 100, {
    mcp: {
      enabledServers: (p) => mcp.enabledServers(p),
      resolve: (pid, spec, extra) => mcp.resolve(pid, spec, extra),
      persistInstall: (pid, spec, values, scope) => mcp.persistInstall(pid, spec, values, scope),
      withLibrary: (p) => mcp.withLibrary(p),
      skippedServers: (p) => mcp.skippedServers(p),
      libraryEntries: () => mcp.libraryEntries(),
      storeProposalSecrets: (pid, pl, values) => mcp.storeProposalSecrets(pid, pl, values),
      searchRegistry: async () => ({ entries: [] })
    },
    skills,
    skillAssist: { catalog: (pid) => ({ library: skills.libraryList(), project: pid ? skills.list(pid) : [] }), read: () => null }
  })
}

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

const proposalOf =
  (kind: string) =>
  (e: RunEvent): e is Extract<RunEvent, { type: 'proposal.request' }> =>
    e.type === 'proposal.request' && e.proposal.kind === kind

function newProject(): Project {
  return store.create({ name: 'Cfg', path: join(dir, 'repo'), brief: '' })
}

describe('a work run changes its own MCP and skill configuration (mock adapter)', () => {
  it('proposes a project-only server and a skill, the user approves, the live run sees both', async () => {
    const p = newProject()
    const root = p.roles.find((r) => r.reportsTo === null)!
    const m = manager({ mock: new MockAdapter({ script: { delayMs: 0 } }) })
    const run = await m.start({ project: { ...p, provider: { ...p.provider, id: 'mock' } }, prompt: `Change the config ${CONFIG_CHANGE_TOKEN}` })

    const mcpCard = await waitFor(proposalOf('mcpServers'))
    expect(mcpCard.proposal.effect).toBe('now')
    const payload = mcpCard.proposal.kind === 'mcpServers' ? mcpCard.proposal.payload : undefined
    expect(payload?.upsert.map((s) => [s.name, s.projectOnly, s.roles])).toEqual([[MOCK_CONFIG_SERVER, true, [root.slug]]])
    m.decideProposal(run.id, mcpCard.proposal.id, { behavior: 'approve' })

    const skillCard = await waitFor(proposalOf('skills'))
    expect(skillCard.proposal.effect).toBe('now')
    m.decideProposal(run.id, skillCard.proposal.id, { behavior: 'approve' })

    await waitFor((e): e is RunEvent => e.type === 'transcript' && e.entry.block.kind === 'text' && e.entry.block.text === 'Config change done.')
    // Saved to the project only, never to the MCP library.
    const saved = store.get(p.id)!
    expect(saved.mcpServers?.map((s) => s.name)).toEqual([MOCK_CONFIG_SERVER])
    expect(mcp.libraryEntries()).toEqual([])
    const skill = saved.skills?.find((s) => s.name === MOCK_CONFIG_SKILL)
    expect(skill).toBeDefined()
    expect(saved.roles.find((r) => r.id === root.id)?.skills).toEqual([skill!.id])
    // load_skill read the live skills: the skill created mid-run loaded and counted.
    expect(events.some((e) => e.type === 'skill.used' && e.name === MOCK_CONFIG_SKILL)).toBe(true)
    // Both tools told the agent the change is in effect now (the mock answers configChanged with 'now').
    const all = JSON.stringify(events)
    expect(all).toContain('in effect now')
    // proposal.resolved never carries secrets and the project broadcast went out.
    expect(events.filter((e) => e.type === 'proposal.resolved').every((e) => e.type === 'proposal.resolved' && !('secrets' in e.decision))).toBe(true)
    await m.stopAll()
  })
})

describe('approved changes reach the live context (real services, capturing adapter)', () => {
  async function rig() {
    let p = newProject()
    const root = p.roles.find((r) => r.reportsTo === null)!
    const other = p.roles.find((r) => r.reportsTo !== null)!
    // An existing server granted to `other` through Role.mcpServers, and a skill granted to `other`.
    const server: McpServerSpec = { id: 'mcp-docs', name: 'docs', transport: 'stdio', command: 'npx', args: ['-y', 'docs-mcp@1.0.0'], enabled: true, source: 'user', addedAt: '', roles: [root.slug], projectOnly: true } as McpServerSpec
    mcp.upsert({ projectId: p.id, spec: server })
    p = store.get(p.id)!
    store.save({ ...p, roles: p.roles.map((r) => (r.id === other.id ? { ...r, mcpServers: ['mcp-docs'] } : r)) })
    skills.create({ projectId: p.id, draft: { name: 'triage', description: 'Use for triage.', body: 'Triage it.' }, roleIds: [other.id] })
    p = store.get(p.id)!
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
    const m = manager({ claude: adapter })
    const run = await m.start({ project: p, prompt: 'go' })
    const ctx = ctxs[0]
    const changes: ConfigChange[] = []
    const tools = harnessToolsFor(ctx, { configChanged: async (c) => (changes.push(c), { availability: 'after-idle' }) })
    const call = (name: string, args: unknown, caller = {}) => tools.find((t) => t.name === name)!.call(args, caller)
    /** Call a proposal tool, approve its card (with an optional decision), return the tool's text. */
    type Card = Extract<RunEvent, { type: 'proposal.request' }>
    const approve = async (name: string, args: unknown, decide: (card: Card) => ProposalDecision = () => ({ behavior: 'approve' })) => {
      const at = events.length
      const pending = call(name, args)
      const card = await waitFor((e): e is Card => e.type === 'proposal.request', at)
      m.decideProposal(run.id, card.proposal.id, decide(card))
      return { text: await pending, card, at }
    }
    return { p, root, other, m, run, ctx, tools, call, approve, changes }
  }

  it('the effect is after-turn on a real adapter, and a skill ungrant is enforced on the next call', async () => {
    const { other, ctx, call, approve, changes, m } = await rig()
    expect(ctx.skills!().map((s) => s.name)).toEqual(['triage'])
    expect(await call(SKILL_HARNESS_TOOLS.load, { name: 'triage' }, { agentId: 'a1', roleId: other.id })).not.toContain('REFUSED')
    const { text, card } = await approve(SKILL_ASSIST_HARNESS_TOOLS.propose, { title: 'Ungrant', rationale: 'r', items: [{ action: 'grant', scope: 'project', name: 'triage', roles: [] }] })
    expect(card.proposal.effect).toBe('after-turn')
    expect(text).toMatch(/^APPROVED/)
    expect(changes).toContainEqual({ skills: true })
    // Grants recomputed: no role loads it any more, so the next call is refused.
    expect(ctx.skills!()).toEqual([])
    expect(await call(SKILL_HARNESS_TOOLS.load, { name: 'triage' }, { agentId: 'a1', roleId: other.id })).toContain('REFUSED')
    await m.stopAll()
  })

  it('a name-only MCP change disables a server in the live run and reports it to the adapter', async () => {
    const { ctx, approve, changes, m } = await rig()
    expect(ctx.mcpServers!().map((s) => s.name)).toEqual(['docs'])
    const { text } = await approve(MCP_HARNESS_TOOLS.proposeServers, { title: 'Off', rationale: 'r', upsert: [{ name: 'docs', enabled: false }] })
    expect(text).toMatch(/^APPROVED/)
    expect(ctx.mcpServers!()).toEqual([])
    expect(changes.some((c) => c.mcp?.upserted.includes('docs'))).toBe(true)
    await m.stopAll()
  })

  it('secrets typed on the card are stored, never broadcast, and an unset slot is reported as waiting', async () => {
    const { ctx, approve, m, p } = await rig()
    const SECRET = 'ghp_supersecretvalue123'
    const { text, card, at } = await approve(
      MCP_HARNESS_TOOLS.proposeServers,
      {
        title: 'Two',
        rationale: 'r',
        upsert: [
          { name: 'gh', transport: 'stdio', command: 'npx', args: ['-y', 'gh-mcp@1.2.3'], secretEnv: ['GH_TOKEN'] },
          { name: 'db', transport: 'stdio', command: 'npx', args: ['-y', 'db-mcp@1.2.3'], secretEnv: ['DB_URL'] }
        ]
      },
      (c) => {
        const slots = c.proposal.kind === 'mcpServers' ? (c.proposal.payload.secrets ?? []) : []
        const gh = slots.find((s) => s.name === 'GH_TOKEN')!
        return { behavior: 'approve', secrets: { [proposalSecretKey(gh)]: SECRET, 'mcp-unknown:env:X': 'ignored' } }
      }
    )
    expect(text).toMatch(/^APPROVED/)
    // gh got its value and is live; db still waits for its secret.
    expect(ctx.mcpServers!().map((s) => s.name).sort()).toEqual(['docs', 'gh'])
    expect(text).toContain('Not started because a secret slot is empty: db.')
    const resolved = events.slice(at).find((e) => e.type === 'proposal.resolved' && e.proposalId === card.proposal.id)
    expect(resolved).toMatchObject({ decision: { behavior: 'approve', waitingForSecrets: ['db'] } })
    expect(JSON.stringify(events)).not.toContain(SECRET)
    const gh = store.get(p.id)!.mcpServers!.find((s) => s.name === 'gh')!
    expect(mcp.resolve(p.id, gh).env.GH_TOKEN).toBe(SECRET)
    await m.stopAll()
  })

  it('a declined proposal applies nothing and the same proposal is not shown again in the run', async () => {
    const { approve, call, m, p } = await rig()
    const args = { title: 'Off', rationale: 'r', upsert: [{ name: 'docs', enabled: false }] }
    const { text } = await approve(MCP_HARNESS_TOOLS.proposeServers, args, () => ({ behavior: 'decline', note: 'Keep it on.' }))
    expect(text).toContain('DECLINED. The user declined this proposal. Note from the user: Keep it on.')
    expect(text).toContain('do not propose the same change again this run')
    expect(store.get(p.id)!.mcpServers![0].enabled).toBe(true)
    const at = events.length
    const again = await call(MCP_HARNESS_TOOLS.proposeServers, { ...args, rationale: 'different wording' })
    expect(again).toContain('no card was shown')
    expect(events.slice(at).some((e) => e.type === 'proposal.request')).toBe(false)
    await m.stopAll()
  })

  it('an approved org change keeps role ids and every grant', async () => {
    const { approve, m, p, other } = await rig()
    const before = store.get(p.id)!
    const drafts = before.roles.map((r) => ({
      name: r.name,
      slug: r.slug,
      description: r.description,
      responsibilities: r.responsibilities,
      prompt: r.id === other.id ? `${r.prompt} Sharper.` : r.prompt,
      tools: r.tools,
      model: 'everyday',
      canSpawn: r.canSpawn,
      spawnable: r.spawnable.map((id) => before.roles.find((x) => x.id === id)!.name),
      reportsTo: r.reportsTo ? before.roles.find((x) => x.id === r.reportsTo)!.name : null
    }))
    const { text } = await approve(PROPOSAL_TOOLS.orgChange, { title: 'Sharpen', rationale: 'r', roles: drafts })
    expect(text).toMatch(/^APPROVED/)
    const after = store.get(p.id)!
    expect(after.roles.map((r) => r.id)).toEqual(before.roles.map((r) => r.id))
    const kept = after.roles.find((r) => r.id === other.id)!
    expect(kept.prompt).toContain('Sharper.')
    expect(kept.mcpServers).toEqual(['mcp-docs'])
    expect(kept.skills).toEqual(before.roles.find((r) => r.id === other.id)!.skills)
    expect(after.mcpServers![0].roles).toEqual(before.mcpServers![0].roles)
    await m.stopAll()
  })

  it('an ungrant also drops explicit Role.mcpServers grants, and the run cannot label provenance or write the library', async () => {
    const { approve, ctx, m, p, other, root } = await rig()
    // other holds docs through an explicit Role.mcpServers grant; limiting docs to root removes it (review M2).
    const { text } = await approve(MCP_HARNESS_TOOLS.proposeServers, { title: 'Root only', rationale: 'r', upsert: [{ name: 'docs', roles: [root.slug] }] })
    expect(text).toMatch(/^APPROVED/)
    expect(store.get(p.id)!.roles.find((r) => r.id === other.id)!.mcpServers).toEqual([])
    // A registry label from the agent is dropped (review M4) and the new server stays in the project (review M3).
    const { card } = await approve(MCP_HARNESS_TOOLS.proposeServers, {
      title: 'New',
      rationale: 'r',
      upsert: [{ name: 'fake', transport: 'stdio', command: 'npx', args: ['-y', 'fake-mcp@1.0.0'], source: 'registry', registry: { name: 'io.github.official/x', version: '1.0.0', registryType: 'npm', identifier: 'x' } }]
    })
    const spec = card.proposal.kind === 'mcpServers' ? card.proposal.payload.upsert[0] : undefined
    expect(spec?.source).toBe('agent')
    expect(spec?.registry).toBeUndefined()
    expect(mcp.libraryEntries()).toEqual([])
    expect(ctx.project.mcpServers!.find((s) => s.name === 'fake')!.libraryId).toBeUndefined()
    await m.stopAll()
  })
})
