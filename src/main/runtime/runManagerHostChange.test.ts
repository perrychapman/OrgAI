import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpServerSpec, Project, Proposal, RunEvent, SkillSpec } from '@shared/types'
import { RunManager } from './runManager'
import type { RuntimeAdapter, RuntimeContext, RuntimeSession } from './types'
import type { ConfigChange, ConfigChangeResult } from './harnessTools'
import { RunStore } from '../store/runs'
import { ProjectStore } from '../store/projects'
import { SetupService } from '../setup/service'
import { orgChart, role } from './testHelpers'
import { MockAdapter, type MockSession } from './mock'

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

function rig(opts: { hook?: Hook; cliHost?: boolean; gate?: Promise<void>; waitMs?: number } = {}) {
  const ctxs: RuntimeContext[] = []
  const calls: ConfigChange[] = []
  const sends: string[] = []
  const hook: Hook = opts.hook ?? (async () => ({ availability: 'now' }))
  const adapter: RuntimeAdapter = {
    id: 'mock',
    complete: async () => '',
    start: async (ctx) => {
      ctxs.push(ctx)
      if (opts.gate) await opts.gate
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
  const options = {
    ...(opts.cliHost ? {} : { liveRosterCards: true as const, liveHostChanges: true as const }),
    ...(opts.waitMs ? { liveHostChangeWaitMs: opts.waitMs } : {}),
    // As bootstrap.ts wires it: a card's fan-out reads the stored project before the apply through it.
    resolveProject: (id: string) => store.get(id)
  }
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

/** An mcp:* / skills:* save: `before` is a copy of the stored project read first, as the handlers read it. */
function itemSave(p: Project, edit: (copy: Project) => Project): { before: Project; saved: Project } {
  const before = structuredClone(store.get(p.id)!)
  const saved = store.save(edit(structuredClone(before)))
  return { before, saved }
}

const skill = (id: string, name: string, over: Partial<SkillSpec> = {}): SkillSpec => ({ id, name, description: 'd', enabled: true, source: 'local', ...over }) as SkillSpec
const mcpOf = (ctx: RuntimeContext, id: string): McpServerSpec | undefined => ctx.mcpServers!().find((s) => s.id === id)
const roleOf = (ctx: RuntimeContext, id: string) => ctx.roles.find((r) => r.id === id)!

describe('applyProjectChange: MCP servers and skills (mcp:* / skills:*)', () => {
  it('a server the user added reaches ctx.mcpServers(); a pulled server in the same save does not', async () => {
    const p = newProject()
    const { m, ctxs, calls } = rig({ hook: async () => ({ availability: 'after-idle' }) })
    const run = await m.start({ project: p, prompt: 'go' })
    const ctx = ctxs[0]
    const s = itemSave(p, (c) => ({ ...c, mcpServers: [server('m-docs', 'docs'), server('m-new', 'tracker'), server('m-pulled', 'pulled')] }))
    const [res] = await m.applyProjectChange(p.id, s.saved, { kind: 'mcp', ids: ['m-new'], names: ['tracker'], label: 'the MCP server tracker', before: s.before })
    expect(ctx.mcpServers!().map((x) => x.id)).toEqual(['m-docs', 'm-new'])
    expect(calls).toEqual([{ mcp: { upserted: ['tracker'], removed: [] } }])
    expect(res.availability).toBe('after-idle')
    expect(logs(run.id)).toContain('You changed the MCP server tracker; this run uses it once the agents are idle.')
    // Removal.
    const s2 = itemSave(p, (c) => ({ ...c, mcpServers: [server('m-docs', 'docs'), server('m-pulled', 'pulled')] }))
    await m.applyProjectChange(p.id, s2.saved, { kind: 'mcp', ids: ['m-new'], names: ['tracker'], label: 'the MCP server tracker', before: s2.before, fields: [] })
    expect(ctx.mcpServers!().map((x) => x.id)).toEqual(['m-docs'])
    expect(calls[1]).toEqual({ mcp: { upserted: [], removed: ['tracker'] } })
    await m.stopAll()
  })

  it('M1: mcp:upsert of a server never brings in a stored grant or a stored launch change the run did not take', async () => {
    const p = newProject()
    const { m, ctxs, calls } = rig()
    await m.start({ project: p, prompt: 'go' })
    const ctx = ctxs[0]
    // Stored while the run was live but not taken by it (e.g. approved for the next run in Team files review).
    store.save({ ...store.get(p.id)!, roles: store.get(p.id)!.roles.map((r) => (r.id === 'r-eng' ? { ...r, mcpServers: ['m-docs'] } : r)), mcpServers: [{ ...server('m-docs', 'docs'), command: 'evil' }] })
    expect(roleOf(ctx, 'r-eng').mcpServers).toEqual([])
    // The user's Settings edit of the same server: the form holds the stored spec; only its args change.
    const s = itemSave(p, (c) => ({ ...c, mcpServers: c.mcpServers!.map((x) => (x.id === 'm-docs' ? { ...x, args: ['-y', 'docs@2.0.0'] } : x)) }))
    const spec = s.saved.mcpServers!.find((x) => x.id === 'm-docs')!
    await m.applyProjectChange(p.id, s.saved, { kind: 'mcp', ids: ['m-docs'], names: ['docs'], label: 'the MCP server docs', before: s.before, fields: Object.keys(spec) })
    expect(roleOf(ctx, 'r-eng').mcpServers).toEqual([])
    expect(ctx.project.roles.find((r) => r.id === 'r-eng')!.mcpServers).toEqual([])
    expect(mcpOf(ctx, 'm-docs')).toMatchObject({ command: 'npx', args: ['-y', 'docs@2.0.0'] })
    expect(calls).toEqual([{ mcp: { upserted: ['docs'], removed: [] } }])
    await m.stopAll()
  })

  it('M1: mcp:setProjectOverrides moves only the override maps, never a stored launch change of that server', async () => {
    const p = newProject()
    const { m, ctxs } = rig()
    await m.start({ project: p, prompt: 'go' })
    const ctx = ctxs[0]
    store.save({ ...store.get(p.id)!, mcpServers: [{ ...server('m-docs', 'docs'), command: 'evil', args: ['--pwn'] }] })
    const s = itemSave(p, (c) => ({ ...c, mcpServers: c.mcpServers!.map((x) => (x.id === 'm-docs' ? { ...x, envOverrides: { REGION: 'eu' } } : x)) }))
    await m.applyProjectChange(p.id, s.saved, { kind: 'mcp', ids: ['m-docs'], names: ['docs'], label: 'the MCP server docs', before: s.before, fields: ['envOverrides'] })
    expect(mcpOf(ctx, 'm-docs')).toMatchObject({ command: 'npx', args: ['-y', 'docs@1.0.0'], envOverrides: { REGION: 'eu' } })
    await m.stopAll()
  })

  it('M1: skills:update of a skill never brings in a stored grant the run did not take; its own roleIds do move', async () => {
    const p0 = newProject()
    const p = store.save({ ...p0, skills: [skill('s-notes', 'notes')] })
    const { m, ctxs, calls } = rig()
    await m.start({ project: p, prompt: 'go' })
    const ctx = ctxs[0]
    store.save({ ...store.get(p.id)!, roles: store.get(p.id)!.roles.map((r) => (r.id === 'r-rev' ? { ...r, skills: ['s-notes'] } : r)) })
    expect(roleOf(ctx, 'r-rev').skills).toBeUndefined()
    // A draft edit (description) with no roleIds: the stored grant to the reviewer stays out.
    const s = itemSave(p, (c) => ({ ...c, skills: c.skills!.map((x) => (x.id === 's-notes' ? { ...x, description: 'Better notes.' } : x)) }))
    await m.applyProjectChange(p.id, s.saved, { kind: 'skills', ids: ['s-notes'], names: ['notes'], label: 'the skill notes', before: s.before })
    expect(roleOf(ctx, 'r-rev').skills).toBeUndefined()
    expect(ctx.project.skills!.find((x) => x.id === 's-notes')!.description).toBe('Better notes.')
    expect(calls).toEqual([{ skills: true }])
    // roleIds [r-eng] (the complete set): the engineer gains it; the reviewer's stored grant is dropped by the save.
    const s2 = itemSave(p, (c) => ({ ...c, roles: c.roles.map((r) => (r.id === 'r-eng' ? { ...r, skills: ['s-notes'] } : r.id === 'r-rev' ? { ...r, skills: [] } : r)) }))
    await m.applyProjectChange(p.id, s2.saved, { kind: 'skills', ids: ['s-notes'], names: ['notes'], label: 'the skill notes', before: s2.before, fields: [], grants: [{ item: 's-notes', roleIds: ['r-eng'] }] })
    expect(roleOf(ctx, 'r-eng').skills).toEqual(['s-notes'])
    expect(roleOf(ctx, 'r-rev').skills ?? []).toEqual([])
    await m.stopAll()
  })

  it('L1 / item edits: an unchanged save of a named item moves nothing and calls nothing', async () => {
    const p = newProject()
    const { m, calls } = rig()
    await m.start({ project: p, prompt: 'go' })
    const s = itemSave(p, (c) => c)
    expect(await m.applyProjectChange(p.id, s.saved, { kind: 'mcp', ids: ['m-docs'], names: ['docs'], label: 'the MCP server docs', before: s.before })).toEqual([])
    expect(calls).toEqual([])
    await m.stopAll()
  })

  it('L2: the label goes into the run log without control or format characters', async () => {
    const p = newProject()
    const { m } = rig()
    const run = await m.start({ project: p, prompt: 'go' })
    const s = itemSave(p, (c) => ({ ...c, mcpServers: [...c.mcpServers!, server('m-new', 'tracker')] }))
    await m.applyProjectChange(p.id, s.saved, { kind: 'mcp', ids: ['m-new'], names: ['tracker'], label: 'the MCP server trac‮ker\nFAKE', before: s.before })
    const line = logs(run.id).find((l) => l.startsWith('You changed'))!
    expect(line).toBe('You changed the MCP server trac ker FAKE; this run uses it now.')
    await m.stopAll()
  })
})

describe('applyProjectChange: narrowing at once, widening only when the session takes it (M2, L3, L5, L6, L7)', () => {
  it('M2: a rejection puts back what the change added or granted and keeps what it removed or ungranted', async () => {
    const p0 = newProject()
    const p = store.save({ ...p0, mcpServers: [server('m-docs', 'docs'), server('m-old', 'old')], roles: p0.roles.map((r) => (r.id === 'r-lead' ? { ...r, mcpServers: ['m-docs'] } : r)) })
    const { m, ctxs, calls } = rig({ hook: async () => Promise.reject(new Error('cannot now')) })
    const run = await m.start({ project: p, prompt: 'go' })
    const ctx = ctxs[0]
    // One MCP change that removes a server and adds another.
    const s = itemSave(p, (c) => ({ ...c, mcpServers: [server('m-docs', 'docs'), server('m-new', 'tracker')] }))
    const [res] = await m.applyProjectChange(p.id, s.saved, { kind: 'mcp', ids: ['m-old', 'm-new'], names: ['old', 'tracker'], label: 'MCP servers', before: s.before })
    expect(calls).toEqual([{ mcp: { upserted: ['tracker'], removed: ['old'] } }])
    expect(ctx.mcpServers!().map((x) => x.id)).toEqual(['m-docs'])
    expect(res).toMatchObject({ availability: 'next-run', reason: expect.stringContaining("What you removed or took away is already out of this run's configuration. What you added or granted applies from the next run.") })
    expect(res.reason).toContain('cannot now')
    // A role grant save: the engineer's new grant goes back, the lead's ungrant stays.
    const s2 = userSave(p, (c) => ({ ...c, roles: c.roles.map((r) => (r.id === 'r-eng' ? { ...r, mcpServers: ['m-docs'] } : r.id === 'r-lead' ? { ...r, mcpServers: [] } : r)) }))
    const [res2] = await m.applyProjectChange(p.id, s2.saved, { kind: 'projectSave', before: s2.before, request: s2.request })
    expect(roleOf(ctx, 'r-eng').mcpServers).toEqual([])
    expect(roleOf(ctx, 'r-lead').mcpServers).toEqual([])
    expect(ctx.project.roles.find((r) => r.id === 'r-eng')!.mcpServers).toEqual([])
    expect(res2.availability).toBe('next-run')
    expect(logs(run.id).filter((l) => l.includes('could not take it'))).toHaveLength(2)
    await m.stopAll()
  })

  it('re-review L-a: a rejected change puts back only its own fields; a later change of the same server stays', async () => {
    const p = newProject()
    const finishers: ((e?: Error) => void)[] = []
    const { m, ctxs } = rig({ hook: () => new Promise<ConfigChangeResult>((res, rej) => finishers.push((e) => (e ? rej(e) : res({ availability: 'now' })))), waitMs: 10 })
    await m.start({ project: p, prompt: 'go' })
    const ctx = ctxs[0]
    const a = itemSave(p, (c) => ({ ...c, mcpServers: c.mcpServers!.map((x) => ({ ...x, args: ['-y', 'docs@2.0.0'] })) }))
    expect((await m.applyProjectChange(p.id, a.saved, { kind: 'mcp', ids: ['m-docs'], names: ['docs'], label: 'A', before: a.before }))[0].availability).toBe('pending')
    const b = itemSave(p, (c) => ({ ...c, mcpServers: c.mcpServers!.map((x) => ({ ...x, envOverrides: { R: 'eu' } })) }))
    await m.applyProjectChange(p.id, b.saved, { kind: 'mcp', ids: ['m-docs'], names: ['docs'], label: 'B', before: b.before, fields: ['envOverrides'] })
    finishers[1]()
    finishers[0](new Error('no'))
    await vi.waitFor(() => expect(mcpOf(ctx, 'm-docs')!.args).toEqual(['-y', 'docs@1.0.0']))
    expect(mcpOf(ctx, 'm-docs')!.envOverrides).toEqual({ R: 'eu' })
    await m.stopAll()
  })

  it('re-review L-b: a grant to a skill the run does not have is not reported as in use', async () => {
    const p = newProject()
    const { m, ctxs, calls } = rig()
    const run = await m.start({ project: p, prompt: 'go' })
    // Stored after the run started: the run does not have it.
    store.save({ ...store.get(p.id)!, skills: [skill('s-late', 'late')] })
    const s = itemSave(p, (c) => ({ ...c, roles: c.roles.map((r) => (r.id === 'r-eng' ? { ...r, skills: ['s-late'] } : r)) }))
    const [res] = await m.applyProjectChange(p.id, s.saved, { kind: 'skills', ids: ['s-late'], names: ['late'], label: 'the skill late', before: s.before, fields: [], grants: [{ item: 's-late', roleIds: ['r-eng'] }] })
    expect(res).toMatchObject({ availability: 'next-run', reason: expect.stringContaining('does not have') })
    expect(roleOf(ctxs[0], 'r-eng').skills).toBeUndefined()
    expect(calls).toEqual([])
    expect(logs(run.id).some((l) => l.includes('uses it now'))).toBe(false)
    await m.stopAll()
  })

  it('M2: a rejection of a change that only takes away answers now and keeps it', async () => {
    const p0 = newProject()
    const p = store.save({ ...p0, roles: p0.roles.map((r) => (r.id === 'r-lead' ? { ...r, mcpServers: ['m-docs'] } : r)) })
    const { m, ctxs, calls } = rig({ hook: async () => Promise.reject(new Error('busy')) })
    await m.start({ project: p, prompt: 'go' })
    const s = userSave(p, (c) => ({ ...c, roles: c.roles.map((r) => (r.id === 'r-lead' ? { ...r, mcpServers: [] } : r)) }))
    const [res] = await m.applyProjectChange(p.id, s.saved, { kind: 'projectSave', before: s.before, request: s.request })
    // L3: an ungrant names no server; the empty list still tells the session to re-read the grants.
    expect(calls).toEqual([{ mcp: { upserted: [], removed: [] } }])
    expect(roleOf(ctxs[0], 'r-lead').mcpServers).toEqual([])
    expect(res).toMatchObject({ availability: 'now', reason: expect.stringContaining("What you removed or took away is already out of this run's configuration.") })
    await m.stopAll()
  })

  it("M2 / L7: no answer within the wait is 'pending': nothing is put back and the log says it is still being applied", async () => {
    const p = newProject()
    let finish: (r: ConfigChangeResult) => void = () => {}
    const { m, ctxs } = rig({ hook: () => new Promise<ConfigChangeResult>((r) => (finish = r)), waitMs: 20 })
    const run = await m.start({ project: p, prompt: 'go' })
    const s = userSave(p, (c) => ({ ...c, roles: c.roles.map((r) => (r.id === 'r-eng' ? { ...r, mcpServers: ['m-docs'] } : r)) }))
    const [res] = await m.applyProjectChange(p.id, s.saved, { kind: 'projectSave', before: s.before, request: s.request })
    expect(res.availability).toBe('pending')
    expect(roleOf(ctxs[0], 'r-eng').mcpServers).toEqual(['m-docs'])
    expect(logs(run.id)).toContain('You changed role grants; OrgAI is still applying it to this run. This log says when it is in place.')
    expect(logs(run.id).some((l) => l.includes('next run'))).toBe(false)
    finish({ availability: 'after-idle' })
    await vi.waitFor(() => expect(logs(run.id)).toContain('You changed role grants; this run uses it once the agents are idle.'))
    expect(roleOf(ctxs[0], 'r-eng').mcpServers).toEqual(['m-docs'])
    await m.stopAll()
  })

  it('L5: a session without hostConfigChanged takes removals and ungrants at once; grants and new servers wait', async () => {
    const p0 = newProject()
    const p = store.save({ ...p0, mcpServers: [server('m-docs', 'docs'), server('m-old', 'old')], roles: p0.roles.map((r) => (r.id === 'r-lead' ? { ...r, mcpServers: ['m-docs', 'm-old'] } : r)) })
    const { m, ctxs } = rig({ hook: 'absent' })
    await m.start({ project: p, prompt: 'go' })
    const ctx = ctxs[0]
    const s = itemSave(p, (c) => ({ ...c, mcpServers: [server('m-docs', 'docs'), server('m-new', 'tracker')] }))
    const [res] = await m.applyProjectChange(p.id, s.saved, { kind: 'mcp', ids: ['m-old', 'm-new'], names: ['old', 'tracker'], label: 'MCP servers', before: s.before })
    expect(ctx.mcpServers!().map((x) => x.id)).toEqual(['m-docs'])
    expect(roleOf(ctx, 'r-lead').mcpServers).toEqual(['m-docs'])
    expect(res).toMatchObject({ availability: 'next-run', reason: "This run's session cannot take changes while it is live. What you removed or took away is already out of this run's configuration. The rest applies from the next run." })
    const s2 = userSave(p, (c) => ({ ...c, roles: c.roles.map((r) => (r.id === 'r-lead' ? { ...r, mcpServers: [] } : r.id === 'r-eng' ? { ...r, mcpServers: ['m-docs'] } : r)) }))
    await m.applyProjectChange(p.id, s2.saved, { kind: 'projectSave', before: s2.before, request: s2.request })
    expect(roleOf(ctx, 'r-lead').mcpServers).toEqual([])
    expect(roleOf(ctx, 'r-eng').mcpServers).toEqual([])
    await m.stopAll()
  })

  it('L6: a run whose session is not open yet says it is still starting and takes only what was taken away', async () => {
    const p0 = newProject()
    const p = store.save({ ...p0, roles: p0.roles.map((r) => (r.id === 'r-lead' ? { ...r, mcpServers: ['m-docs'] } : r)) })
    let open: () => void = () => {}
    const { m, ctxs } = rig({ gate: new Promise<void>((r) => (open = r)) })
    const started = m.start({ project: p, prompt: 'go' })
    await vi.waitFor(() => expect(ctxs).toHaveLength(1))
    const s = userSave(p, (c) => ({ ...c, roles: c.roles.map((r) => (r.id === 'r-lead' ? { ...r, mcpServers: [] } : r.id === 'r-eng' ? { ...r, mcpServers: ['m-docs'] } : r)) }))
    const [res] = await m.applyProjectChange(p.id, s.saved, { kind: 'projectSave', before: s.before, request: s.request })
    expect(res).toMatchObject({ availability: 'next-run', reason: "The run is still starting. What you removed or took away is already out of this run's configuration. The rest applies from the next run." })
    expect(roleOf(ctxs[0], 'r-lead').mcpServers).toEqual([])
    expect(roleOf(ctxs[0], 'r-eng').mcpServers).toEqual([])
    open()
    await started
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
    const s = itemSave(p, (c) => ({ ...c, skills: [skill('s1', 'notes')] }))
    const [res] = await m.applyProjectChange(p.id, s.saved, { kind: 'skills', ids: ['s1'], names: ['notes'], label: 'the skill notes', before: s.before })
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
    const s = itemSave(p, (c) => ({ ...c, skills: [skill('s1', 'n')] }))
    expect(await m.applyProjectChange(p.id, s.saved, { kind: 'skills', ids: ['s1'], names: ['n'], label: 'l', before: s.before }, { exceptRunId: a.id })).toEqual([])
    expect(await m.applyProjectChange('other', { ...s.saved, id: 'other' }, { kind: 'skills', ids: ['s1'], names: ['n'], label: 'l', before: s.before })).toEqual([])
    expect(calls).toEqual([])
    await m.stopAll()
  })
})

describe('end to end: the real RunManager with the mock adapter', () => {
  it('a desktop save of a grant and of an org chart role reaches an idle mock run: host configChanges, a next-message notice, no send, one log line', async () => {
    // Accept edits: the mock's engineer edits a file, and no permission card should hold the run before it is idle.
    const p = store.save({ ...newProject(), permissionMode: 'acceptEdits' })
    const adapter = new MockAdapter({ script: { delayMs: 0 } })
    const sessions: MockSession[] = []
    const sent: string[] = []
    const start = adapter.start.bind(adapter)
    adapter.start = async (ctx) => {
      const s = (await start(ctx)) as MockSession
      const send = s.send.bind(s)
      s.send = async (text: string) => {
        sent.push(text)
        return send(text)
      }
      sessions.push(s)
      return s
    }
    const m = new RunManager({ mock: adapter }, (e) => void events.push(e), new RunStore(join(dir, 'data')), setup, () => 100, { liveRosterCards: true, liveHostChanges: true, resolveProject: (id) => store.get(id) })
    const run = await m.start({ project: p, prompt: 'go' })
    await vi.waitFor(() => expect(events.filter((e) => e.type === 'run.status' && e.runId === run.id).map((e) => (e as { status: string }).status)).toContain('idle'), { timeout: 10_000 })
    const session = sessions[0]
    expect(session.liveRoster).toBe(true)
    const sentBefore = sent.length
    const s = userSave(p, (c) => ({ ...c, roles: c.roles.map((r) => (r.id === 'r-eng' ? { ...r, mcpServers: ['m-docs'], prompt: 'Build with docs.' } : r)) }))
    const [res] = await m.applyProjectChange(p.id, s.saved, { kind: 'projectSave', before: s.before, request: s.request })
    expect(res).toMatchObject({ runId: run.id, availability: 'now' })
    expect(session.configChanges).toEqual([{ roles: { added: [], changed: ['r-eng'], removed: [] }, mcp: { upserted: ['docs'], removed: [] }, host: true }])
    expect(session.hostNotices).toHaveLength(1)
    expect(session.hostNotices[0].delivery).toBe('next-message')
    expect(sent.length).toBe(sentBefore)
    expect(logs(run.id).filter((l) => l.startsWith('You changed'))).toEqual(['You changed the org chart and role grants; this run uses it now.'])
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
