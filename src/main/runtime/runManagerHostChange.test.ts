import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpServerSpec, Project, Proposal, RunEvent } from '@shared/types'
import { RunManager } from './runManager'
import type { RuntimeAdapter, RuntimeContext, RuntimeSession } from './types'
import type { ConfigChange, ConfigChangeResult } from './harnessTools'
import { RunStore } from '../store/runs'
import { ProjectStore } from '../store/projects'
import { SetupService } from '../setup/service'
import { orgChart, role } from './testHelpers'

vi.mock('../log', () => ({ logRunEvent: () => {}, logPermission: () => {}, log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } }))

/**
 * Host changes in a live run (hostChange.ts, RunManager.applyProjectChange): a desktop save or another session's
 * approved card reaches live work runs of the project, moving only what the user's action named.
 */

let dir: string
let events: RunEvent[]
let store: ProjectStore
let setup: SetupService

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orgai-hostchange-'))
  mkdirSync(join(dir, 'repo'))
  events = []
  store = new ProjectStore(join(dir, 'data'))
  setup = new SetupService(store)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const server = (id: string, name: string): McpServerSpec =>
  ({ id, name, transport: 'stdio', command: 'npx', args: ['-y', `${name}@1.0.0`], enabled: true, source: 'user', addedAt: '' }) as McpServerSpec

type Hook = ((change: ConfigChange) => Promise<ConfigChangeResult>) | 'absent'

function rig(opts: { hook?: Hook; cliHost?: boolean } = {}) {
  const ctxs: RuntimeContext[] = []
  const calls: ConfigChange[] = []
  const sends: string[] = []
  const hook: Hook = opts.hook ?? (async () => ({ availability: 'now' }))
  const adapter: RuntimeAdapter = {
    id: 'mock',
    complete: async () => '',
    start: async (ctx) => {
      ctxs.push(ctx)
      ctx.emit({ type: 'run.status', runId: ctx.run.id, status: 'running' })
      const session: RuntimeSession = {
        send: async (text: string) => void sends.push(text),
        interrupt: async () => {},
        stop: async () => {},
        finished: new Promise<void>(() => {}),
        liveRoster: true,
        ...(hook === 'absent'
          ? {}
          : {
              hostConfigChanged: (c: ConfigChange) => {
                calls.push(structuredClone(c))
                return hook(c)
              }
            })
      }
      return session
    }
  }
  const options = opts.cliHost ? {} : { liveRosterCards: true as const, liveHostChanges: true as const }
  const m = new RunManager({ mock: adapter }, (e) => void events.push(e), new RunStore(join(dir, 'data')), setup, () => 100, options)
  return { m, ctxs, calls, sends }
}

function newProject(): Project {
  const p = store.create({ name: 'Host', path: join(dir, 'repo'), brief: '' })
  const roles = orgChart()
  roles[1].mcpServers = []
  return store.save({ ...p, provider: { ...p.provider, id: 'mock' }, roles, mcpServers: [server('m-docs', 'docs')] })
}

const logs = (runId: string): string[] => events.filter((e): e is Extract<RunEvent, { type: 'log' }> => e.type === 'log' && e.runId === runId).map((e) => e.message)

/** The user's save: `edit` changes their copy; `ingest` is what the store's save hook also pulled from team files. */
function userSave(p: Project, edit: (copy: Project) => Project, ingest: (saved: Project) => Project = (x) => x): { before: Project; request: Project; saved: Project } {
  const before = store.get(p.id)!
  const request = edit(structuredClone(before))
  const saved = store.save(ingest(structuredClone(request)))
  return { before, request, saved }
}

describe('applyProjectChange: org chart edits from the editor (projects:save)', () => {
  it('moves only the edited field of the edited role, in place, and tells the session once', async () => {
    const p = newProject()
    const { m, ctxs, calls } = rig()
    const run = await m.start({ project: p, prompt: 'go' })
    const ctx = ctxs[0]
    const eng = ctx.roles[1]
    const s = userSave(p, (c) => ({ ...c, roles: c.roles.map((r) => (r.id === 'r-eng' ? { ...r, prompt: 'Build carefully.' } : r)) }))
    const out = await m.applyProjectChange(p.id, s.saved, { kind: 'projectSave', before: s.before, request: s.request })
    expect(out).toEqual([{ runId: run.id, title: expect.any(String), availability: 'now' }])
    expect(ctx.roles[1]).toBe(eng)
    expect(eng.prompt).toBe('Build carefully.')
    expect(calls).toEqual([{ roles: { added: [], changed: ['r-eng'], removed: [] } }])
    expect(logs(run.id)).toContain('You changed the org chart; this run uses it now.')
    expect(structuredClone(out)).toEqual(out)
    await m.stopAll()
  })

  it('INVARIANT: an agent-edited team file granting a role an MCP server and a skill, ingested by an unrelated user save, never reaches the live run', async () => {
    const p = newProject()
    const { m, ctxs, calls } = rig()
    const run = await m.start({ project: p, prompt: 'go' })
    const ctx = ctxs[0]
    // The user only edits the lead's description; the same save ingests the agents' edits of .orgai files: a grant of
    // the docs server and a skill to the engineer, a new prompt for the reviewer and a whole new role.
    const s = userSave(
      p,
      (c) => ({ ...c, roles: c.roles.map((r) => (r.id === 'r-lead' ? { ...r, description: 'Leads.' } : r)) }),
      (x) => ({
        ...x,
        roles: [
          ...x.roles.map((r) => (r.id === 'r-eng' ? { ...r, mcpServers: ['m-docs'], skills: ['s-pulled'] } : r.id === 'r-rev' ? { ...r, prompt: 'INGESTED' } : r)),
          role({ id: 'r-pulled', slug: 'pulled', reportsTo: 'r-lead' })
        ]
      })
    )
    expect(s.saved.roles.find((r) => r.id === 'r-eng')!.mcpServers).toEqual(['m-docs'])
    await m.applyProjectChange(p.id, s.saved, { kind: 'projectSave', before: s.before, request: s.request })
    const byId = new Map(ctx.roles.map((r) => [r.id, r]))
    expect(byId.get('r-lead')!.description).toBe('Leads.')
    expect(byId.get('r-eng')!.mcpServers).toEqual([])
    expect(byId.get('r-eng')!.skills).toBeUndefined()
    expect(byId.get('r-rev')!.prompt).toBe('You are reviewer.')
    expect(byId.has('r-pulled')).toBe(false)
    // The harness tools' view (the next card's base) holds none of it either.
    const view = new Map(ctx.project.roles.map((r) => [r.id, r]))
    expect(view.get('r-eng')!.mcpServers).toEqual([])
    expect(view.get('r-rev')!.prompt).toBe('You are reviewer.')
    expect(view.has('r-pulled')).toBe(false)
    expect(calls).toEqual([{ roles: { added: [], changed: ['r-lead'], removed: [] } }])
    // A later approved MCP card for that same server moves only the card's own grants (the pull stays out).
    const before = events.length
    const pending = ctx.requestProposal({ kind: 'mcpServers', agentId: 'root', title: 't', payload: { upsert: [{ ...server('m-docs', 'docs'), roles: [] }], rationale: 'r' } } as Omit<Proposal, 'id' | 'runId' | 'createdAt' | 'effect'>)
    await new Promise((r) => setTimeout(r, 5))
    const card = events.slice(before).find((e): e is Extract<RunEvent, { type: 'proposal.request' }> => e.type === 'proposal.request')!
    m.decideProposal(run.id, card.proposal.id, { behavior: 'approve' })
    await pending
    expect(ctx.roles.find((r) => r.id === 'r-eng')!.skills).toBeUndefined()
    await m.stopAll()
  })

  it('an unrelated save (no role or grant change) touches nothing and returns nothing', async () => {
    const p = newProject()
    const { m, calls } = rig()
    await m.start({ project: p, prompt: 'go' })
    const s = userSave(p, (c) => ({ ...c, brief: 'New brief' }), (x) => ({ ...x, roles: x.roles.map((r) => (r.id === 'r-eng' ? { ...r, mcpServers: ['m-docs'] } : r)) }))
    expect(await m.applyProjectChange(p.id, s.saved, { kind: 'projectSave', before: s.before, request: s.request })).toEqual([])
    expect(calls).toEqual([])
    await m.stopAll()
  })

  it('grants the user named move onto ctx.roles; a grant of a server the run lacks waits for the next run', async () => {
    const p = newProject()
    const { m, ctxs, calls } = rig()
    const run = await m.start({ project: p, prompt: 'go' })
    const ctx = ctxs[0]
    const s = userSave(p, (c) => ({ ...c, roles: c.roles.map((r) => (r.id === 'r-eng' ? { ...r, mcpServers: ['m-docs', 'm-missing'] } : r)) }))
    const [res] = await m.applyProjectChange(p.id, s.saved, { kind: 'projectSave', before: s.before, request: s.request })
    expect(ctx.roles.find((r) => r.id === 'r-eng')!.mcpServers).toEqual(['m-docs'])
    expect(ctx.project.roles.find((r) => r.id === 'r-eng')!.mcpServers).toEqual(['m-docs'])
    expect(calls).toEqual([{ mcp: { upserted: ['docs'], removed: [] } }])
    expect(res).toMatchObject({ runId: run.id, availability: 'now', reason: expect.stringContaining('does not have') })
    // An ungrant moves at once too.
    const s2 = userSave(p, (c) => ({ ...c, roles: c.roles.map((r) => (r.id === 'r-eng' ? { ...r, mcpServers: [] } : r)) }))
    await m.applyProjectChange(p.id, s2.saved, { kind: 'projectSave', before: s2.before, request: s2.request })
    expect(ctx.roles.find((r) => r.id === 'r-eng')!.mcpServers).toEqual([])
    await m.stopAll()
  })

  it('keeps the deferrals: the root keeps its model, a new role reusing a removed slug waits', async () => {
    const p = newProject()
    const { m, ctxs } = rig()
    await m.start({ project: p, prompt: 'go' })
    const ctx = ctxs[0]
    const s1 = userSave(p, (c) => ({ ...c, roles: c.roles.filter((r) => r.id !== 'r-rev').map((r) => (r.id === 'r-lead' ? { ...r, model: 'opus', spawnable: ['r-eng'] } : r)) }))
    await m.applyProjectChange(p.id, s1.saved, { kind: 'projectSave', before: s1.before, request: s1.request })
    expect(ctx.roles.map((r) => r.id)).toEqual(['r-lead', 'r-eng'])
    expect(ctx.roles[0].model).toBe('sonnet')
    expect(ctx.roles[0].spawnable).toEqual(['r-eng'])
    const s2 = userSave(p, (c) => ({ ...c, roles: [...c.roles, role({ id: 'r-rev2', slug: 'reviewer', name: 'Reviewer 2', reportsTo: 'r-lead' })] }))
    const [res] = await m.applyProjectChange(p.id, s2.saved, { kind: 'projectSave', before: s2.before, request: s2.request })
    expect(ctx.roles.map((r) => r.id)).toEqual(['r-lead', 'r-eng'])
    expect(res).toMatchObject({ availability: 'next-run', deferred: [{ name: 'Reviewer 2', reason: expect.stringContaining('removed earlier') }] })
    await m.stopAll()
  })
})

describe('applyProjectChange: MCP servers and skills (mcp:* / skills:*)', () => {
  it('a server the user added reaches ctx.mcpServers(); a pulled server in the same save does not', async () => {
    const p = newProject()
    const { m, ctxs, calls } = rig({ hook: async () => ({ availability: 'after-idle' }) })
    const run = await m.start({ project: p, prompt: 'go' })
    const ctx = ctxs[0]
    const saved = store.save({ ...store.get(p.id)!, mcpServers: [server('m-docs', 'docs'), server('m-new', 'tracker'), server('m-pulled', 'pulled')] })
    const [res] = await m.applyProjectChange(p.id, saved, { kind: 'mcp', ids: ['m-new'], names: ['tracker'], label: 'the MCP server tracker' })
    expect(ctx.mcpServers!().map((s) => s.id)).toEqual(['m-docs', 'm-new'])
    expect(calls).toEqual([{ mcp: { upserted: ['tracker'], removed: [] } }])
    expect(res.availability).toBe('after-idle')
    expect(logs(run.id)).toContain('You changed the MCP server tracker; this run uses it once the agents are idle.')
    // Removal.
    const saved2 = store.save({ ...store.get(p.id)!, mcpServers: [server('m-docs', 'docs')] })
    await m.applyProjectChange(p.id, saved2, { kind: 'mcp', ids: ['m-new'], names: ['tracker'], label: 'the MCP server tracker' })
    expect(ctx.mcpServers!().map((s) => s.id)).toEqual(['m-docs'])
    expect(calls[1]).toEqual({ mcp: { upserted: [], removed: ['tracker'] } })
    await m.stopAll()
  })

  it('a skills change tells the session skills: true', async () => {
    const p = newProject()
    const { m, calls } = rig()
    await m.start({ project: p, prompt: 'go' })
    const [res] = await m.applyProjectChange(p.id, store.get(p.id)!, { kind: 'skills', ids: ['s1'], names: ['notes'], label: 'the skill notes' })
    expect(calls).toEqual([{ skills: true }])
    expect(res.availability).toBe('now')
    await m.stopAll()
  })
})

describe('applyProjectChange: hosts, sessions and run states', () => {
  it('the CLI / TUI / exec host keeps the old behaviour: nothing moves, the session is never called', async () => {
    const p = newProject()
    const { m, ctxs, calls } = rig({ cliHost: true })
    await m.start({ project: p, prompt: 'go' })
    const s = userSave(p, (c) => ({ ...c, roles: c.roles.map((r) => (r.id === 'r-eng' ? { ...r, prompt: 'X', mcpServers: ['m-docs'] } : r)) }))
    expect(await m.applyProjectChange(p.id, s.saved, { kind: 'projectSave', before: s.before, request: s.request })).toEqual([])
    expect(ctxs[0].roles[1].prompt).toBe('You are engineer.')
    expect(ctxs[0].roles[1].mcpServers).toEqual([])
    expect(calls).toEqual([])
    await m.stopAll()
  })

  it('a session without hostConfigChanged keeps the run as it is and says next run', async () => {
    const p = newProject()
    const { m, ctxs } = rig({ hook: 'absent' })
    const run = await m.start({ project: p, prompt: 'go' })
    const s = userSave(p, (c) => ({ ...c, roles: c.roles.map((r) => (r.id === 'r-eng' ? { ...r, prompt: 'X', mcpServers: ['m-docs'] } : r)) }))
    const [res] = await m.applyProjectChange(p.id, s.saved, { kind: 'projectSave', before: s.before, request: s.request })
    expect(res).toMatchObject({ runId: run.id, availability: 'next-run', reason: expect.any(String) })
    expect(ctxs[0].roles[1].prompt).toBe('You are engineer.')
    expect(ctxs[0].roles[1].mcpServers).toEqual([])
    expect(logs(run.id).some((l) => l.startsWith('You changed the org chart and role grants; this run uses it from the next run'))).toBe(true)
    await m.stopAll()
  })

  it('a rejection reports next run with the reason and a warning line', async () => {
    const p = newProject()
    const { m } = rig({ hook: async () => Promise.reject(new Error('cannot now')) })
    const run = await m.start({ project: p, prompt: 'go' })
    const [res] = await m.applyProjectChange(p.id, store.get(p.id)!, { kind: 'skills', ids: ['s1'], names: ['notes'], label: 'the skill notes' })
    expect(res).toMatchObject({ availability: 'next-run', reason: expect.stringContaining('cannot now') })
    expect(logs(run.id).some((l) => l.includes('could not take it'))).toBe(true)
    await m.stopAll()
  })

  it('a held run takes the state but is never woken; a run with an open card keeps the card open', async () => {
    const p = newProject()
    const { m, ctxs, calls, sends } = rig()
    const run = await m.start({ project: p, prompt: 'go' })
    const ctx = ctxs[0]
    await m.interrupt(run.id)
    const sendsBefore = sends.length
    const pending = ctx.requestProposal({ kind: 'mcpServers', agentId: 'root', title: 't', payload: { upsert: [server('m-x', 'x')], rationale: 'r' } } as Omit<Proposal, 'id' | 'runId' | 'createdAt' | 'effect'>)
    void pending
    const s = userSave(p, (c) => ({ ...c, roles: c.roles.map((r) => (r.id === 'r-eng' ? { ...r, mcpServers: ['m-docs'] } : r)) }))
    const [res] = await m.applyProjectChange(p.id, s.saved, { kind: 'projectSave', before: s.before, request: s.request })
    expect(res.availability).toBe('now')
    expect(ctx.roles[1].mcpServers).toEqual(['m-docs'])
    expect(calls).toHaveLength(1)
    expect(sends.length).toBe(sendsBefore)
    expect(m.liveRunFacts(run.id)?.pendingCards).toBe(1)
    expect(logs(run.id).some((l) => l.includes('with your next message'))).toBe(true)
    await m.stopAll()
  })

  it('skips other projects, setup-like runs and the excepted run', async () => {
    const p = newProject()
    const { m, calls } = rig()
    const a = await m.start({ project: p, prompt: 'go' })
    expect(await m.applyProjectChange(p.id, store.get(p.id)!, { kind: 'skills', ids: ['s1'], names: ['n'], label: 'l' }, { exceptRunId: a.id })).toEqual([])
    expect(await m.applyProjectChange('other', { ...store.get(p.id)!, id: 'other' }, { kind: 'skills', ids: ['s1'], names: ['n'], label: 'l' })).toEqual([])
    expect(calls).toEqual([])
    await m.stopAll()
  })
})

describe('approved cards of another session reach the other live runs', () => {
  it("a work run's approved MCP card reaches a second live work run of the project as source 'card'", async () => {
    const p = newProject()
    const { m, ctxs, calls } = rig()
    const a = await m.start({ project: p, prompt: 'one' })
    const b = await m.start({ project: p, prompt: 'two' })
    const before = events.length
    const pending = ctxs[0].requestProposal({ kind: 'mcpServers', agentId: 'root', title: 't', payload: { upsert: [server('m-new', 'tracker')], rationale: 'r' } } as Omit<Proposal, 'id' | 'runId' | 'createdAt' | 'effect'>)
    await new Promise((r) => setTimeout(r, 5))
    const card = events.slice(before).find((e): e is Extract<RunEvent, { type: 'proposal.request' }> => e.type === 'proposal.request')!
    m.decideProposal(a.id, card.proposal.id, { behavior: 'approve' })
    await pending
    await new Promise((r) => setTimeout(r, 10))
    expect(ctxs[1].mcpServers!().map((s) => s.id)).toContain('m-new')
    // The second run heard it through hostConfigChanged (the first through its own tool's configChanged).
    expect(calls).toEqual([{ mcp: { upserted: ['tracker'], removed: [] } }])
    expect(logs(b.id).some((l) => l.startsWith('You approved the MCP servers tracker in another session; this run uses it now.'))).toBe(true)
    await m.stopAll()
  })

  it("an org chart card's fan-out moves only what the card changed against its own baseline", async () => {
    const p = newProject()
    const { m, ctxs } = rig()
    const a = await m.start({ project: p, prompt: 'one' })
    await m.start({ project: p, prompt: 'two' })
    const card = structuredClone(ctxs[0].project.roles).map((r) => (r.id === 'r-rev' ? { ...r, prompt: 'Review twice.' } : r))
    const before = events.length
    const pending = ctxs[0].requestProposal({ kind: 'orgChart', agentId: 'root', title: 't', payload: { roles: card, rationale: 'r' } })
    await new Promise((r) => setTimeout(r, 5))
    const req = events.slice(before).find((e): e is Extract<RunEvent, { type: 'proposal.request' }> => e.type === 'proposal.request')!
    m.decideProposal(a.id, req.proposal.id, { behavior: 'approve' })
    await pending
    await new Promise((r) => setTimeout(r, 10))
    expect(ctxs[1].roles.find((r) => r.id === 'r-rev')!.prompt).toBe('Review twice.')
    expect(ctxs[1].roles.find((r) => r.id === 'r-eng')!.prompt).toBe('You are engineer.')
    await m.stopAll()
  })
})
