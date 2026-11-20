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
import { mcpServersForRole } from '@shared/defaults'
import { mcpCallDenial } from './mcpGrants'

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

function rig(opts: { hook?: Hook; cliHost?: boolean; gate?: Promise<void>; waitMs?: number; mcp?: boolean } = {}) {
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
    resolveProject: (id: string) => store.get(id),
    // A minimal McpService for request_mcp_install approvals saved to the project.
    ...(opts.mcp
      ? {
          mcp: {
            enabledServers: (p: Project) => (p.mcpServers ?? []).filter((s) => s.enabled),
            persistInstall: (id: string, spec: McpServerSpec) => store.save({ ...store.get(id)!, mcpServers: [...(store.get(id)!.mcpServers ?? []), spec] })
          } as never
        }
      : {})
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
    // Review L3: the answer (broadcast) carries a fixed sentence; the adapter's text stays in the run log.
    expect(res.reason).toMatch(/^The session could not take it\./)
    expect(res.reason).not.toContain('cannot now')
    expect(liveEvents(run.id)[0].change.reason).not.toContain('cannot now')
    expect(logs(run.id).some((l) => l.includes('could not take it (cannot now)'))).toBe(true)
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
    expect(res).toMatchObject({ availability: 'next-run', reason: 'The session could not take it. What you added or granted applies from the next run.' })
    expect(logs(run.id).some((l) => l.includes('could not take it (cannot now)'))).toBe(true)
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

type LiveEvent = Extract<RunEvent, { type: 'run.liveChange' }>
const liveEvents = (runId?: string): LiveEvent[] => events.filter((e): e is LiveEvent => e.type === 'run.liveChange' && (!runId || e.runId === runId))
/** The editor's rename: name and slug change together (the slug follows the name). */
const rename = (c: Project, id: string, name: string, slug: string, extra: Partial<Project['roles'][number]> = {}): Project => ({
  ...c,
  roles: c.roles.map((r) => (r.id === id ? { ...r, name, slug, ...extra } : r))
})

describe('follow-up item 1: the run.liveChange event', () => {
  it('projects:save: one event per run with what, source, projectId and the returned answer; never recorded', async () => {
    const p = newProject()
    const { m } = rig()
    const run = await m.start({ project: p, prompt: 'go' })
    const s = userSave(p, (c) => ({ ...c, roles: c.roles.map((r) => (r.id === 'r-eng' ? { ...r, prompt: 'Build carefully.' } : r)) }))
    const [res] = await m.applyProjectChange(p.id, s.saved, { kind: 'projectSave', before: s.before, request: s.request })
    expect(liveEvents()).toEqual([{ type: 'run.liveChange', runId: run.id, projectId: p.id, source: 'user', what: ['orgChart'], change: res }])
    expect(structuredClone(liveEvents()[0])).toEqual(liveEvents()[0])
    // Not recorded: the stored run record has no trace of it.
    const record = new RunStore(join(dir, 'data')).getRecord(run.id)
    expect(JSON.stringify(record ?? {})).not.toContain('liveChange')
    await m.stopAll()
  })

  it('item 4: a role inspector ungrant through projects:save is reported as grants with the role and item named', async () => {
    const p0 = newProject()
    const p = store.save({ ...p0, skills: [skill('s-notes', 'notes')], roles: p0.roles.map((r) => (r.id === 'r-eng' ? { ...r, mcpServers: ['m-docs'], skills: ['s-notes'] } : r)) })
    const { m } = rig()
    const run = await m.start({ project: p, prompt: 'go' })
    const s = userSave(p, (c) => ({ ...c, roles: c.roles.map((r) => (r.id === 'r-eng' ? { ...r, mcpServers: [], skills: [] } : r)) }))
    const [res] = await m.applyProjectChange(p.id, s.saved, { kind: 'projectSave', before: s.before, request: s.request })
    expect(res.grants).toEqual(
      expect.arrayContaining([
        { role: 'Engineer', item: 'docs', kind: 'mcpServer', granted: false },
        { role: 'Engineer', item: 'notes', kind: 'skill', granted: false }
      ])
    )
    expect(res.grants).toHaveLength(2)
    // A projects:save always names the org chart surface, grants-only saves too.
    expect(liveEvents(run.id)).toEqual([expect.objectContaining({ what: ['orgChart', 'grants'], change: res })])
    await m.stopAll()
  })

  it('mcp:* and skills:* routes: what names the item kind, and a grant-only skill change names grants', async () => {
    const p0 = newProject()
    const p = store.save({ ...p0, skills: [skill('s-notes', 'notes')] })
    const { m } = rig()
    const run = await m.start({ project: p, prompt: 'go' })
    const a = itemSave(p, (c) => ({ ...c, mcpServers: [...c.mcpServers!, server('m-new', 'tracker')] }))
    await m.applyProjectChange(p.id, a.saved, { kind: 'mcp', ids: ['m-new'], names: ['tracker'], label: 'the MCP server tracker', before: a.before })
    const b = itemSave(p, (c) => ({ ...c, roles: c.roles.map((r) => (r.id === 'r-eng' ? { ...r, skills: ['s-notes'] } : r)) }))
    await m.applyProjectChange(p.id, b.saved, { kind: 'skills', ids: ['s-notes'], names: ['notes'], label: 'the skill notes', before: b.before, fields: [], grants: [{ item: 's-notes', roleIds: ['r-eng'] }] })
    expect(liveEvents(run.id).map((e) => e.what)).toEqual([['mcpServers'], ['grants']])
    expect(liveEvents(run.id)[1].change.grants).toEqual([{ role: 'Engineer', item: 'notes', kind: 'skill', granted: true }])
    // Item routes never name the org chart surface, not even with grants: an mcp:upsert that narrows a server's roles
    // and a skills:update that ungrants.
    const c = itemSave(p, (cp) => ({ ...cp, mcpServers: cp.mcpServers!.map((x) => ({ ...x, roles: ['engineer'] })) }))
    await m.applyProjectChange(p.id, c.saved, { kind: 'mcp', ids: ['m-docs'], names: ['docs'], label: 'the MCP server docs', before: c.before, fields: Object.keys(c.saved.mcpServers![0]) })
    const d = itemSave(p, (cp) => ({ ...cp, roles: cp.roles.map((r) => (r.id === 'r-eng' ? { ...r, skills: [] } : r)) }))
    await m.applyProjectChange(p.id, d.saved, { kind: 'skills', ids: ['s-notes'], names: ['notes'], label: 'the skill notes', before: d.before, fields: [], grants: [{ item: 's-notes', roleIds: [] }] })
    expect(liveEvents(run.id)).toHaveLength(4)
    expect(liveEvents(run.id).map((e) => e.what)).toEqual([['mcpServers'], ['grants'], ['mcpServers'], ['grants']])
    expect(liveEvents(run.id).some((e) => e.what.includes('orgChart'))).toBe(false)
    await m.stopAll()
  })

  it("another session's approved card reaches the other run as source 'card'", async () => {
    const p = newProject()
    const { m, ctxs } = rig()
    const a = await m.start({ project: p, prompt: 'one' })
    const b = await m.start({ project: p, prompt: 'two' })
    const before = events.length
    const pending = ctxs[0].requestProposal({ kind: 'mcpServers', agentId: 'root', title: 't', payload: { upsert: [server('m-new', 'tracker')], rationale: 'r' } } as Omit<Proposal, 'id' | 'runId' | 'createdAt' | 'effect'>)
    await new Promise((r) => setTimeout(r, 5))
    const card = events.slice(before).find((e): e is Extract<RunEvent, { type: 'proposal.request' }> => e.type === 'proposal.request')!
    m.decideProposal(a.id, card.proposal.id, { behavior: 'approve' })
    await pending
    await vi.waitFor(() => expect(liveEvents(b.id)).toHaveLength(1))
    expect(liveEvents(b.id)[0]).toMatchObject({ source: 'card', what: ['mcpServers'], change: { availability: 'now' } })
    expect(liveEvents(a.id)).toEqual([])
    await m.stopAll()
  })

  it("'pending' is followed by a second event with the final availability", async () => {
    const p = newProject()
    let finish: (r: ConfigChangeResult) => void = () => {}
    const { m } = rig({ hook: () => new Promise<ConfigChangeResult>((r) => (finish = r)), waitMs: 20 })
    const run = await m.start({ project: p, prompt: 'go' })
    const s = userSave(p, (c) => ({ ...c, roles: c.roles.map((r) => (r.id === 'r-eng' ? { ...r, mcpServers: ['m-docs'] } : r)) }))
    const [res] = await m.applyProjectChange(p.id, s.saved, { kind: 'projectSave', before: s.before, request: s.request })
    expect(res.availability).toBe('pending')
    expect(liveEvents(run.id).map((e) => e.change.availability)).toEqual(['pending'])
    finish({ availability: 'after-idle' })
    await vi.waitFor(() => expect(liveEvents(run.id).map((e) => e.change.availability)).toEqual(['pending', 'after-idle']))
    expect(liveEvents(run.id)[1].what).toEqual(['orgChart', 'grants'])
    await m.stopAll()
  })

  it('the CLI / TUI / exec host emits nothing; an adapter-emitted run.liveChange is dropped', async () => {
    const p = newProject()
    const { m, ctxs } = rig({ cliHost: true })
    const run = await m.start({ project: p, prompt: 'go' })
    const s = userSave(p, (c) => ({ ...c, roles: c.roles.map((r) => (r.id === 'r-eng' ? { ...r, prompt: 'X', mcpServers: ['m-docs'] } : r)) }))
    await m.applyProjectChange(p.id, s.saved, { kind: 'projectSave', before: s.before, request: s.request })
    ctxs[0].emit({ type: 'run.liveChange', runId: run.id, projectId: p.id, source: 'user', what: ['grants'], change: { runId: run.id, title: 'x', availability: 'now' } })
    expect(liveEvents()).toEqual([])
    await m.stopAll()
  })
})

describe('follow-up item 2: a rename reaches the live run (the run keeps its slug)', () => {
  it('rename only: the name applies now, the slug stays, and it is reported as applied with a note', async () => {
    const p = newProject()
    const { m, ctxs, calls } = rig()
    const run = await m.start({ project: p, prompt: 'go' })
    const ctx = ctxs[0]
    const eng = roleOf(ctx, 'r-eng')
    const s = userSave(p, (c) => rename(c, 'r-eng', 'Engineer Prime', 'engineer-prime'))
    expect(s.saved.roles.find((r) => r.id === 'r-eng')!.slug).toBe('engineer-prime')
    const [res] = await m.applyProjectChange(p.id, s.saved, { kind: 'projectSave', before: s.before, request: s.request })
    expect(roleOf(ctx, 'r-eng')).toBe(eng)
    expect(eng).toMatchObject({ name: 'Engineer Prime', slug: 'engineer' })
    expect(ctx.project.roles.find((r) => r.id === 'r-eng')).toMatchObject({ name: 'Engineer Prime', slug: 'engineer' })
    expect(res).toEqual({ runId: run.id, title: expect.any(String), availability: 'now', notes: [{ name: 'Engineer Prime', note: 'Renamed to Engineer Prime. This run keeps calling it engineer until the next run.' }] })
    expect(calls).toEqual([{ roles: { added: [], changed: ['r-eng'], removed: [] } }])
    expect(logs(run.id)).toContain('You changed the org chart; this run uses it now. Renamed to Engineer Prime. This run keeps calling it engineer until the next run.')
    // The saved project keeps the new slug: the save path is unchanged.
    expect(store.get(p.id)!.roles.find((r) => r.id === 'r-eng')!.slug).toBe('engineer-prime')
    await m.stopAll()
  })

  it('rename plus a prompt edit: both apply, the slug stays', async () => {
    const p = newProject()
    const { m, ctxs } = rig()
    await m.start({ project: p, prompt: 'go' })
    const s = userSave(p, (c) => rename(c, 'r-eng', 'Builder', 'builder', { prompt: 'Build it.' }))
    const [res] = await m.applyProjectChange(p.id, s.saved, { kind: 'projectSave', before: s.before, request: s.request })
    expect(roleOf(ctxs[0], 'r-eng')).toMatchObject({ name: 'Builder', slug: 'engineer', prompt: 'Build it.' })
    expect(res.availability).toBe('now')
    expect(res.deferred).toBeUndefined()
    expect(res.notes).toEqual([{ name: 'Builder', note: 'Renamed to Builder. This run keeps calling it engineer until the next run.' }])
    await m.stopAll()
  })

  it('rename then a second unrelated save: no phantom slug edit, the renamed role is untouched', async () => {
    const p = newProject()
    const { m, ctxs, calls } = rig()
    await m.start({ project: p, prompt: 'go' })
    const s1 = userSave(p, (c) => rename(c, 'r-eng', 'Builder', 'builder'))
    await m.applyProjectChange(p.id, s1.saved, { kind: 'projectSave', before: s1.before, request: s1.request })
    const s2 = userSave(p, (c) => ({ ...c, roles: c.roles.map((r) => (r.id === 'r-rev' ? { ...r, prompt: 'Review twice.' } : r)) }))
    const [res] = await m.applyProjectChange(p.id, s2.saved, { kind: 'projectSave', before: s2.before, request: s2.request })
    expect(res).toEqual({ runId: expect.any(String), title: expect.any(String), availability: 'now' })
    expect(calls.at(-1)).toEqual({ roles: { added: [], changed: ['r-rev'], removed: [] } })
    expect(roleOf(ctxs[0], 'r-eng')).toMatchObject({ name: 'Builder', slug: 'engineer' })
    expect(roleOf(ctxs[0], 'r-rev').prompt).toBe('Review twice.')
    // A second rename names the slug the run kept.
    const s3 = userSave(p, (c) => rename(c, 'r-eng', 'Maker', 'maker'))
    const [res3] = await m.applyProjectChange(p.id, s3.saved, { kind: 'projectSave', before: s3.before, request: s3.request })
    expect(res3.notes).toEqual([{ name: 'Maker', note: 'Renamed to Maker. This run keeps calling it engineer until the next run.' }])
    await m.stopAll()
  })

  it('rename then a new role with the old slug waits (the run still uses it); with the new slug it joins', async () => {
    const p = newProject()
    const { m, ctxs } = rig()
    await m.start({ project: p, prompt: 'go' })
    const s1 = userSave(p, (c) => rename(c, 'r-eng', 'Builder', 'builder'))
    await m.applyProjectChange(p.id, s1.saved, { kind: 'projectSave', before: s1.before, request: s1.request })
    const s2 = userSave(p, (c) => ({ ...c, roles: [...c.roles, role({ id: 'r-new', slug: 'engineer', name: 'New Engineer', reportsTo: 'r-lead' })] }))
    expect(s2.saved.roles.find((r) => r.id === 'r-new')!.slug).toBe('engineer')
    const [res2] = await m.applyProjectChange(p.id, s2.saved, { kind: 'projectSave', before: s2.before, request: s2.request })
    expect(res2).toMatchObject({ availability: 'next-run', deferred: [{ name: 'New Engineer', reason: 'A role in this run already uses this slug; this role joins from the next run.' }] })
    expect(ctxs[0].roles.filter((r) => r.slug === 'engineer').map((r) => r.id)).toEqual(['r-eng'])
    // A different new role with the saved (new) slug of nothing in the run joins.
    const s3 = userSave(p, (c) => ({ ...c, roles: [...c.roles.filter((r) => r.id !== 'r-new'), role({ id: 'r-qa', slug: 'qa', name: 'QA', reportsTo: 'r-lead' })] }))
    await m.applyProjectChange(p.id, s3.saved, { kind: 'projectSave', before: s3.before, request: s3.request })
    expect(ctxs[0].roles.map((r) => r.slug)).toEqual(['lead', 'engineer', 'reviewer', 'qa'])
    await m.stopAll()
  })

  it('a new role with the renamed role\'s new slug joins under it; the run never has two roles with one slug', async () => {
    const p = newProject()
    const { m, ctxs } = rig()
    await m.start({ project: p, prompt: 'go' })
    const s1 = userSave(p, (c) => rename(c, 'r-eng', 'Builder', 'builder'))
    await m.applyProjectChange(p.id, s1.saved, { kind: 'projectSave', before: s1.before, request: s1.request })
    // Rename again (saved slug "maker"), then add a role taking "builder", the slug the save gave the role first.
    const s2 = userSave(p, (c) => ({ ...rename(c, 'r-eng', 'Maker', 'maker'), roles: [...rename(c, 'r-eng', 'Maker', 'maker').roles, role({ id: 'r-b', slug: 'builder', name: 'Builder 2', reportsTo: 'r-lead' })] }))
    await m.applyProjectChange(p.id, s2.saved, { kind: 'projectSave', before: s2.before, request: s2.request })
    const slugs = ctxs[0].roles.map((r) => r.slug)
    expect(slugs).toEqual(['lead', 'engineer', 'reviewer', 'builder'])
    expect(new Set(slugs).size).toBe(slugs.length)
    await m.stopAll()
  })

  it('rename of a role with a running agent: the agent keeps resolving to its role by slug, with the new name', async () => {
    const p = newProject()
    const { m, ctxs } = rig()
    const run = await m.start({ project: p, prompt: 'go' })
    const ctx = ctxs[0]
    const agent = { id: 'a-eng', roleId: 'r-eng', roleSlug: 'engineer', name: 'Engineer', parentId: 'root', spawnToolUseId: 't1', state: 'tool' as const, activity: 'editing', inputTokens: 0, outputTokens: 0, costUsd: 0, startedAt: 1 }
    ctx.emit({ type: 'agent.upsert', runId: run.id, agent })
    const s = userSave(p, (c) => rename(c, 'r-eng', 'Builder', 'builder'))
    const [res] = await m.applyProjectChange(p.id, s.saved, { kind: 'projectSave', before: s.before, request: s.request })
    expect(res.availability).toBe('now')
    expect(ctx.roles.find((r) => r.slug === agent.roleSlug)).toMatchObject({ id: 'r-eng', name: 'Builder' })
    expect(events.some((e) => e.type === 'agent.remove')).toBe(false)
    // The roster the renderer reads keeps the slug and shows the new name.
    const roster = events.filter((e): e is Extract<RunEvent, { type: 'run.roster' }> => e.type === 'run.roster').at(-1)!
    expect(roster.roster.find((r) => r.id === 'r-eng')).toMatchObject({ slug: 'engineer', name: 'Builder' })
    await m.stopAll()
  })

  it("an org chart card fanned out from another session renames in the other run; the card's own run keeps its rule", async () => {
    const p = newProject()
    const { m, ctxs } = rig()
    const a = await m.start({ project: p, prompt: 'one' })
    const b = await m.start({ project: p, prompt: 'two' })
    const card = structuredClone(ctxs[0].project.roles).map((r) => (r.id === 'r-rev' ? { ...r, name: 'Checker', slug: 'checker' } : r))
    const before = events.length
    const pending = ctxs[0].requestProposal({ kind: 'orgChart', agentId: 'root', title: 't', payload: { roles: card, rationale: 'r' } })
    await new Promise((r) => setTimeout(r, 5))
    const req = events.slice(before).find((e): e is Extract<RunEvent, { type: 'proposal.request' }> => e.type === 'proposal.request')!
    m.decideProposal(a.id, req.proposal.id, { behavior: 'approve' })
    await pending
    await vi.waitFor(() => expect(liveEvents(b.id)).toHaveLength(1))
    expect(roleOf(ctxs[1], 'r-rev')).toMatchObject({ name: 'Checker', slug: 'reviewer' })
    expect(liveEvents(b.id)[0].change.notes).toEqual([{ name: 'Checker', note: 'Renamed to Checker. This run keeps calling it reviewer until the next run.' }])
    // The proposing run defers a slug change on its own card (runRoster.ts slugChange), as before.
    expect(roleOf(ctxs[0], 'r-rev')).toMatchObject({ name: 'Reviewer', slug: 'reviewer' })
    await m.stopAll()
  })

  it('INVARIANT: a team-file pull that changes a role\'s slug, then an unrelated user save, moves neither slug nor name', async () => {
    const p = newProject()
    const { m, ctxs, calls } = rig()
    await m.start({ project: p, prompt: 'go' })
    // The same save as the user's lead edit ingests an agent's rename of the engineer in .orgai files.
    const s1 = userSave(
      p,
      (c) => ({ ...c, roles: c.roles.map((r) => (r.id === 'r-lead' ? { ...r, description: 'Leads.' } : r)) }),
      (x) => rename(x, 'r-eng', 'Pulled Name', 'pulled-slug')
    )
    const [res1] = await m.applyProjectChange(p.id, s1.saved, { kind: 'projectSave', before: s1.before, request: s1.request })
    expect(res1.notes).toBeUndefined()
    // A later unrelated save: `before` now holds the pulled slug and name, equal on both sides.
    const s2 = userSave(p, (c) => ({ ...c, roles: c.roles.map((r) => (r.id === 'r-rev' ? { ...r, prompt: 'Review.' } : r)) }))
    const [res2] = await m.applyProjectChange(p.id, s2.saved, { kind: 'projectSave', before: s2.before, request: s2.request })
    expect(res2.notes).toBeUndefined()
    expect(roleOf(ctxs[0], 'r-eng')).toMatchObject({ name: 'Engineer', slug: 'engineer' })
    expect(ctxs[0].project.roles.find((r) => r.id === 'r-eng')).toMatchObject({ name: 'Engineer', slug: 'engineer' })
    expect(calls.map((c) => c.roles?.changed)).toEqual([['r-lead'], ['r-rev']])
    await m.stopAll()
  })

  it('slug-keyed MCP grants (McpServerSpec.roles) keep resolving for the renamed role; a later save under the new slug maps by id', async () => {
    const p0 = newProject()
    const p = store.save({ ...p0, mcpServers: [{ ...server('m-docs', 'docs'), roles: ['engineer'] }] })
    const { m, ctxs, calls } = rig()
    await m.start({ project: p, prompt: 'go' })
    const ctx = ctxs[0]
    const usable = (id: string): string[] => mcpServersForRole({ mcpServers: ctx.mcpServers!() }, roleOf(ctx, id)).map((s) => s.name)
    const denial = (id: string): string | undefined => mcpCallDenial('mcp__docs__search', { role: roleOf(ctx, id), isRoot: false }, ctx.mcpServers!())
    expect(usable('r-eng')).toEqual(['docs'])
    const s1 = userSave(p, (c) => rename(c, 'r-eng', 'Builder', 'builder'))
    await m.applyProjectChange(p.id, s1.saved, { kind: 'projectSave', before: s1.before, request: s1.request })
    expect(usable('r-eng')).toEqual(['docs'])
    expect(denial('r-eng')).toBeUndefined()
    // Another run (Team tab) remaps the slug-keyed grant to the new slug through mcp:upsert: nothing changes for the run.
    const callsBefore = calls.length
    const s2 = itemSave(p, (c) => ({ ...c, mcpServers: c.mcpServers!.map((x) => ({ ...x, roles: ['builder'] })) }))
    const spec2 = s2.saved.mcpServers![0]
    expect(await m.applyProjectChange(p.id, s2.saved, { kind: 'mcp', ids: ['m-docs'], names: ['docs'], label: 'the MCP server docs', before: s2.before, fields: Object.keys(spec2) })).toEqual([])
    expect(calls.length).toBe(callsBefore)
    expect(mcpOf(ctx, 'm-docs')!.roles).toEqual(['engineer'])
    expect(usable('r-eng')).toEqual(['docs'])
    // A later save that adds the reviewer under the new slug list: the engineer keeps it (by id), the reviewer gains it.
    const s3 = itemSave(p, (c) => ({ ...c, mcpServers: c.mcpServers!.map((x) => ({ ...x, roles: ['builder', 'reviewer'] })) }))
    await m.applyProjectChange(p.id, s3.saved, { kind: 'mcp', ids: ['m-docs'], names: ['docs'], label: 'the MCP server docs', before: s3.before, fields: Object.keys(s3.saved.mcpServers![0]) })
    expect(mcpOf(ctx, 'm-docs')!.roles).toEqual(['engineer', 'reviewer'])
    expect(usable('r-eng')).toEqual(['docs'])
    expect(usable('r-rev')).toEqual(['docs'])
    expect(usable('r-lead')).toEqual([])
    // Dropping the new slug takes it away from the renamed role (by id), nothing else.
    const s4 = itemSave(p, (c) => ({ ...c, mcpServers: c.mcpServers!.map((x) => ({ ...x, roles: ['reviewer'] })) }))
    await m.applyProjectChange(p.id, s4.saved, { kind: 'mcp', ids: ['m-docs'], names: ['docs'], label: 'the MCP server docs', before: s4.before, fields: Object.keys(s4.saved.mcpServers![0]) })
    expect(usable('r-eng')).toEqual([])
    expect(denial('r-eng')).toContain('does not grant')
    expect(usable('r-rev')).toEqual(['docs'])
    await m.stopAll()
  })
})

describe('follow-up item 3: review Lows', () => {
  it('3a: a session whose hostConfigChanged throws synchronously gets the widening part put back', async () => {
    const p = newProject()
    const { m, ctxs } = rig({
      hook: () => {
        throw new Error('sync boom')
      }
    })
    const run = await m.start({ project: p, prompt: 'go' })
    const s = userSave(p, (c) => ({ ...c, roles: c.roles.map((r) => (r.id === 'r-eng' ? { ...r, mcpServers: ['m-docs'] } : r)) }))
    const [res] = await m.applyProjectChange(p.id, s.saved, { kind: 'projectSave', before: s.before, request: s.request })
    expect(res).toMatchObject({ runId: run.id, availability: 'next-run', reason: 'OrgAI could not apply it to this run.' })
    expect(roleOf(ctxs[0], 'r-eng').mcpServers).toEqual([])
    expect(ctxs[0].project.roles.find((r) => r.id === 'r-eng')!.mcpServers).toEqual([])
    expect(liveEvents(run.id)).toEqual([expect.objectContaining({ change: res })])
    // The same for an added MCP server.
    const s2 = itemSave(p, (c) => ({ ...c, mcpServers: [...c.mcpServers!, server('m-new', 'tracker')] }))
    await m.applyProjectChange(p.id, s2.saved, { kind: 'mcp', ids: ['m-new'], names: ['tracker'], label: 'the MCP server tracker', before: s2.before })
    expect(ctxs[0].mcpServers!().map((x) => x.id)).toEqual(['m-docs'])
    await m.stopAll()
  })

  it('3b: a library-linked server whose saved copy was refreshed from the library is not a change (no restart, no log line)', async () => {
    const p0 = newProject()
    const linked = { ...server('m-lib', 'libdocs'), libraryId: 'lib-1', source: 'library' } as McpServerSpec
    const p = store.save({ ...p0, mcpServers: [server('m-docs', 'docs'), linked] })
    const { m, ctxs, calls } = rig()
    const run = await m.start({ project: p, prompt: 'go' })
    // An approved card naming the linked server (no fields limit); the handler's result refreshed it from the library.
    const before = structuredClone(store.get(p.id)!)
    const saved = { ...before, mcpServers: before.mcpServers!.map((x) => (x.id === 'm-lib' ? { ...x, args: ['-y', 'libdocs@9.9.9'] } : x)) }
    expect(await m.applyProjectChange(p.id, saved, { kind: 'mcp', ids: ['m-lib'], names: ['libdocs'], label: 'the MCP server libdocs', before })).toEqual([])
    expect(calls).toEqual([])
    expect(logs(run.id).some((l) => l.startsWith('You changed'))).toBe(false)
    // A project-owned field of it still moves.
    const saved2 = { ...saved, mcpServers: saved.mcpServers!.map((x) => (x.id === 'm-lib' ? { ...x, enabled: false } : x)) }
    await m.applyProjectChange(p.id, saved2, { kind: 'mcp', ids: ['m-lib'], names: ['libdocs'], label: 'the MCP server libdocs', before })
    // A turned-off server leaves ctx.mcpServers() (enabled servers only); the run's project holds it as changed.
    expect(mcpOf(ctxs[0], 'm-lib')).toBeUndefined()
    expect(ctxs[0].project.mcpServers!.find((x) => x.id === 'm-lib')).toMatchObject({ enabled: false, args: ['-y', 'libdocs@1.0.0'] })
    await m.stopAll()
  })

  it("3c: a late rejection during a 'pending' wait never drops a grant a later change added", async () => {
    const p = newProject()
    const finishers: ((e?: Error) => void)[] = []
    const { m, ctxs } = rig({ hook: () => new Promise<ConfigChangeResult>((res, rej) => finishers.push((e) => (e ? rej(e) : res({ availability: 'now' })))), waitMs: 10 })
    await m.start({ project: p, prompt: 'go' })
    const ctx = ctxs[0]
    const grant = (on: boolean) => userSave(p, (c) => ({ ...c, roles: c.roles.map((r) => (r.id === 'r-eng' ? { ...r, mcpServers: on ? ['m-docs'] : [] } : r)) }))
    // A grants (pending), C ungrants, B grants again; then A is rejected.
    const a = grant(true)
    expect((await m.applyProjectChange(p.id, a.saved, { kind: 'projectSave', before: a.before, request: a.request }))[0].availability).toBe('pending')
    const c = grant(false)
    await m.applyProjectChange(p.id, c.saved, { kind: 'projectSave', before: c.before, request: c.request })
    expect(roleOf(ctx, 'r-eng').mcpServers).toEqual([])
    const b = grant(true)
    await m.applyProjectChange(p.id, b.saved, { kind: 'projectSave', before: b.before, request: b.request })
    expect(roleOf(ctx, 'r-eng').mcpServers).toEqual(['m-docs'])
    finishers[1]()
    finishers[2]()
    finishers[0](new Error('late no'))
    await vi.waitFor(() => expect(logs(ctx.run.id).some((l) => l.includes('late no'))).toBe(true))
    expect(roleOf(ctx, 'r-eng').mcpServers).toEqual(['m-docs'])
    // Without a later change, a late rejection still puts its own grant back.
    const d = userSave(p, (cp) => ({ ...cp, roles: cp.roles.map((r) => (r.id === 'r-rev' ? { ...r, mcpServers: ['m-docs'] } : r)) }))
    expect((await m.applyProjectChange(p.id, d.saved, { kind: 'projectSave', before: d.before, request: d.request }))[0].availability).toBe('pending')
    finishers[3](new Error('no again'))
    await vi.waitFor(() => expect(roleOf(ctx, 'r-rev').mcpServers ?? []).toEqual([]))
    await m.stopAll()
  })
})

/** Raise a card on `ctx`'s run and approve it; resolves with the tool's outcome. */
async function approveCard(m: RunManager, ctx: RuntimeContext, req: Omit<Proposal, 'id' | 'runId' | 'createdAt' | 'effect'>) {
  const before = events.length
  const pending = ctx.requestProposal(req)
  await new Promise((r) => setTimeout(r, 5))
  const card = events.slice(before).find((e): e is Extract<RunEvent, { type: 'proposal.request' }> => e.type === 'proposal.request')!
  m.decideProposal(ctx.run.id, card.proposal.id, { behavior: 'approve' })
  return pending
}
const mcpCard = (spec: McpServerSpec) => ({ kind: 'mcpServers', agentId: 'root', title: 't', payload: { upsert: [spec], rationale: 'r' } }) as Omit<Proposal, 'id' | 'runId' | 'createdAt' | 'effect'>
const storedRole = (p: Project, id: string) => store.get(p.id)!.roles.find((r) => r.id === id)

describe('rename follow-up review: slug-keyed grants and kept slugs', () => {
  /** Rename r-eng (Builder / builder) in the editor, then add r-new under the slug the run kept (deferred slugTaken). */
  async function renamedWithNewEngineer(m: RunManager, p: Project) {
    const s1 = userSave(p, (c) => rename(c, 'r-eng', 'Builder', 'builder'))
    await m.applyProjectChange(p.id, s1.saved, { kind: 'projectSave', before: s1.before, request: s1.request })
    const s2 = userSave(p, (c) => ({ ...c, roles: [...c.roles, role({ id: 'r-new', slug: 'engineer', name: 'New Engineer', reportsTo: 'r-lead' })] }))
    const [res] = await m.applyProjectChange(p.id, s2.saved, { kind: 'projectSave', before: s2.before, request: s2.request })
    expect(res.deferred?.[0]).toMatchObject({ name: 'New Engineer' })
  }
  const usableIn = (ctx: RuntimeContext, id: string): string[] => mcpServersForRole({ mcpServers: ctx.mcpServers!() }, roleOf(ctx, id)).map((s) => s.name)
  const denialIn = (ctx: RuntimeContext, id: string, name = 'docs'): string | undefined => mcpCallDenial(`mcp__${name}__search`, { role: roleOf(ctx, id), isRoot: false }, ctx.mcpServers!())

  it('H1: mcp:upsert granting a waiting role under the slug a renamed running role kept never reaches the running role', async () => {
    const p0 = newProject()
    const p = store.save({ ...p0, mcpServers: [{ ...server('m-docs', 'docs'), roles: ['reviewer'] }] })
    const { m, ctxs } = rig()
    await m.start({ project: p, prompt: 'go' })
    const ctx = ctxs[0]
    await renamedWithNewEngineer(m, p)
    expect(ctx.project.roles.find((r) => r.id === 'r-new')).toMatchObject({ slug: 'engineer' })
    const s = itemSave(p, (c) => ({ ...c, mcpServers: c.mcpServers!.map((x) => ({ ...x, roles: ['engineer'] })) }))
    await m.applyProjectChange(p.id, s.saved, { kind: 'mcp', ids: ['m-docs'], names: ['docs'], label: 'the MCP server docs', before: s.before, fields: Object.keys(s.saved.mcpServers![0]) })
    expect(usableIn(ctx, 'r-eng')).toEqual([])
    expect(denialIn(ctx, 'r-eng')).toContain('does not grant')
    expect(mcpOf(ctx, 'm-docs')!.roles).toEqual([])
    await m.stopAll()
  })

  it("the role inspector's rename shape (roleOps.ts renamePatch): slug grants copied to ids, server roles left on the old slug", async () => {
    const p0 = newProject()
    const p = store.save({ ...p0, mcpServers: [{ ...server('m-docs', 'docs'), roles: ['engineer'] }] })
    const { m, ctxs } = rig()
    await m.start({ project: p, prompt: 'go' })
    const ctx = ctxs[0]
    // One patch: name, slug, and every server held by the old slug also granted by id. McpServerSpec.roles is not remapped.
    const s1 = userSave(p, (c) => rename(c, 'r-eng', 'Builder', 'builder', { mcpServers: ['m-docs'] }))
    expect(s1.saved.mcpServers![0].roles).toEqual(['engineer'])
    const [res] = await m.applyProjectChange(p.id, s1.saved, { kind: 'projectSave', before: s1.before, request: s1.request })
    expect(res.availability).toBe('now')
    expect(roleOf(ctx, 'r-eng')).toMatchObject({ slug: 'engineer', name: 'Builder', mcpServers: ['m-docs'] })
    expect(usableIn(ctx, 'r-eng')).toEqual(['docs'])
    expect(usableIn(ctx, 'r-rev')).toEqual([])
    // A role added later under the old slug (which the stale server list now names) never takes it from the run's role,
    // and the next save of that server is no change for the run.
    const s2 = userSave(p, (c) => ({ ...c, roles: [...c.roles, role({ id: 'r-new', slug: 'engineer', name: 'New Engineer', reportsTo: 'r-lead' })] }))
    await m.applyProjectChange(p.id, s2.saved, { kind: 'projectSave', before: s2.before, request: s2.request })
    const s3 = itemSave(p, (c) => ({ ...c, mcpServers: c.mcpServers!.map((x) => ({ ...x, args: ['-y', 'docs@2.0.0'] })) }))
    await m.applyProjectChange(p.id, s3.saved, { kind: 'mcp', ids: ['m-docs'], names: ['docs'], label: 'the MCP server docs', before: s3.before, fields: Object.keys(s3.saved.mcpServers![0]) })
    expect(mcpOf(ctx, 'm-docs')).toMatchObject({ roles: ['engineer'], args: ['-y', 'docs@2.0.0'] })
    expect(usableIn(ctx, 'r-eng')).toEqual(['docs'])
    // Dropping the stale slug in a later save takes nothing from the renamed role: it holds the server by id.
    const s4 = itemSave(p, (c) => ({ ...c, mcpServers: c.mcpServers!.map((x) => ({ ...x, roles: [] })) }))
    await m.applyProjectChange(p.id, s4.saved, { kind: 'mcp', ids: ['m-docs'], names: ['docs'], label: 'the MCP server docs', before: s4.before, fields: Object.keys(s4.saved.mcpServers![0]) })
    expect(usableIn(ctx, 'r-eng')).toEqual(['docs'])
    await m.stopAll()
  })

  it("H1: the same through another session's approved MCP card (fan-out)", async () => {
    const p = newProject()
    const { m, ctxs } = rig()
    await m.start({ project: p, prompt: 'renamed run' })
    const b = ctxs[0]
    await renamedWithNewEngineer(m, p)
    // A run started after the add has r-new running under "engineer"; its agent grants the new server to it.
    await m.start({ project: store.get(p.id)!, prompt: 'later run' })
    const a = ctxs[1]
    expect(roleOf(a, 'r-new').slug).toBe('engineer')
    await approveCard(m, a, mcpCard({ ...server('m-wiki', 'wiki'), roles: ['engineer'] }))
    expect(store.get(p.id)!.mcpServers!.find((x) => x.id === 'm-wiki')!.roles).toEqual(['engineer'])
    expect(usableIn(a, 'r-new')).toContain('wiki')
    await vi.waitFor(() => expect(mcpOf(b, 'm-wiki')).toBeDefined())
    expect(mcpOf(b, 'm-wiki')!.roles).toEqual([])
    expect(usableIn(b, 'r-eng')).not.toContain('wiki')
    expect(denialIn(b, 'r-eng', 'wiki')).toContain('does not grant')
    await m.stopAll()
  })

  it("M1 / a: the run's own MCP card saves the stored slugs and the run reads them back by id, both directions", async () => {
    const p = newProject()
    const { m, ctxs } = rig()
    await m.start({ project: p, prompt: 'go' })
    const ctx = ctxs[0]
    // One save renames both: the engineer becomes "builder", the reviewer takes "engineer". The run keeps both old slugs.
    const s = userSave(p, (c) => ({ ...c, roles: c.roles.map((r) => (r.id === 'r-eng' ? { ...r, name: 'Builder', slug: 'builder' } : r.id === 'r-rev' ? { ...r, name: 'Checker', slug: 'engineer' } : r)) }))
    await m.applyProjectChange(p.id, s.saved, { kind: 'projectSave', before: s.before, request: s.request })
    expect(ctx.roles.map((r) => r.slug)).toEqual(['lead', 'engineer', 'reviewer'])
    // The agent grants the reviewer by the run's slug: saved under the reviewer's stored slug ("engineer").
    await approveCard(m, ctx, mcpCard({ ...server('m-wiki', 'wiki'), roles: ['reviewer'] }))
    expect(store.get(p.id)!.mcpServers!.find((x) => x.id === 'm-wiki')!.roles).toEqual(['engineer'])
    // In the run: the reviewer has it, the engineer (who holds the slug text "engineer" here) does not.
    expect(mcpOf(ctx, 'm-wiki')!.roles).toEqual(['reviewer'])
    expect(usableIn(ctx, 'r-rev')).toContain('wiki')
    expect(denialIn(ctx, 'r-eng', 'wiki')).toContain('does not grant')
    // The other direction: a grant to the renamed engineer is saved under its new slug and still reaches it here.
    await approveCard(m, ctx, mcpCard({ ...server('m-tracker', 'tracker'), roles: ['engineer'] }))
    expect(store.get(p.id)!.mcpServers!.find((x) => x.id === 'm-tracker')!.roles).toEqual(['builder'])
    expect(usableIn(ctx, 'r-eng')).toContain('tracker')
    expect(usableIn(ctx, 'r-rev')).not.toContain('tracker')
    await m.stopAll()
  })

  it('M1 / a: an approved request_mcp_install saved to the project maps the slug and reaches the renamed role', async () => {
    const p = newProject()
    const { m, ctxs } = rig({ mcp: true })
    const run = await m.start({ project: p, prompt: 'go' })
    const ctx = ctxs[0]
    await renamedWithNewEngineer(m, p)
    const before = events.length
    const pending = ctx.requestMcpInstall!({ agentId: 'root', reason: 'r', spec: { ...server('m-wiki', 'wiki'), roles: ['engineer'] }, requiredSecrets: [] })
    await new Promise((r) => setTimeout(r, 5))
    const req = events.slice(before).find((e): e is Extract<RunEvent, { type: 'mcpInstall.request' }> => e.type === 'mcpInstall.request')!
    m.answerMcpInstall(run.id, req.request.id, { approved: true, scope: 'project' })
    expect((await pending).approved).toBe(true)
    expect(store.get(p.id)!.mcpServers!.find((x) => x.id === 'm-wiki')!.roles).toEqual(['builder'])
    expect(usableIn(ctx, 'r-eng')).toContain('wiki')
    await m.stopAll()
  })

  it("a: the run's own skill card grants by the kept slug land on the renamed stored role", async () => {
    const p0 = newProject()
    const p = store.save({ ...p0, skills: [skill('s-notes', 'notes')] })
    const seen: string[][] = []
    // A fake SkillService grant: `roles` (slugs) is the complete set after the change, resolved on the stored project.
    setup = new SetupService(store, {
      skills: {
        applyProposal: (pid, payload) => {
          const cur = store.get(pid!)!
          const slugs = payload.items[0].roles ?? []
          seen.push(slugs)
          return store.save({ ...cur, roles: cur.roles.map((r) => ({ ...r, skills: slugs.includes(r.slug) ? ['s-notes'] : (r.skills ?? []).filter((x) => x !== 's-notes') })) })
        }
      }
    })
    const { m, ctxs } = rig()
    await m.start({ project: p, prompt: 'go' })
    const ctx = ctxs[0]
    await renamedWithNewEngineer(m, p)
    await approveCard(m, ctx, { kind: 'skills', agentId: 'root', title: 't', payload: { items: [{ action: 'grant', draft: { name: 'notes', description: 'd', body: '' }, roles: ['engineer'], scope: 'project' }], rationale: 'r' } } as Omit<Proposal, 'id' | 'runId' | 'createdAt' | 'effect'>)
    expect(seen).toEqual([['builder']])
    expect(storedRole(p, 'r-eng')!.skills).toEqual(['s-notes'])
    expect(storedRole(p, 'r-new')!.skills ?? []).toEqual([])
    expect(roleOf(ctx, 'r-eng').skills).toEqual(['s-notes'])
    await m.stopAll()
  })

  it("b: the run's own approved org chart card never reverts the user's rename nor lands on the role holding the old slug", async () => {
    const p = newProject()
    const { m, ctxs } = rig()
    await m.start({ project: p, prompt: 'go' })
    const ctx = ctxs[0]
    await renamedWithNewEngineer(m, p)
    const card = structuredClone(ctx.project.roles).map((r) => (r.id === 'r-rev' ? { ...r, prompt: 'Review twice.' } : r))
    expect(card.find((r) => r.id === 'r-eng')).toMatchObject({ slug: 'engineer', name: 'Builder' })
    await approveCard(m, ctx, { kind: 'orgChart', agentId: 'root', title: 't', payload: { roles: card, rationale: 'r' } })
    const stored = store.get(p.id)!.roles
    expect(stored.find((r) => r.id === 'r-eng')).toMatchObject({ slug: 'builder', name: 'Builder', tools: ['Read', 'Edit', 'Write'] })
    expect(stored.find((r) => r.id === 'r-new')).toMatchObject({ slug: 'engineer', name: 'New Engineer', tools: ['Read'] })
    expect(stored.find((r) => r.id === 'r-rev')!.prompt).toBe('Review twice.')
    expect(stored).toHaveLength(4)
    // The run itself took the card as shown.
    expect(roleOf(ctx, 'r-rev').prompt).toBe('Review twice.')
    expect(roleOf(ctx, 'r-eng').slug).toBe('engineer')
    await m.stopAll()
  })

  it('b: on a host without live changes, a card built from the old name and slug keeps the stored rename and the role', async () => {
    const p = newProject()
    const { m, ctxs } = rig({ cliHost: true })
    await m.start({ project: p, prompt: 'go' })
    const ctx = ctxs[0]
    userSave(p, (c) => rename(c, 'r-eng', 'Builder', 'builder'))
    const card = structuredClone(ctx.project.roles).map((r) => (r.id === 'r-rev' ? { ...r, prompt: 'Review twice.' } : r))
    expect(card.find((r) => r.id === 'r-eng')).toMatchObject({ slug: 'engineer', name: 'Engineer' })
    await approveCard(m, ctx, { kind: 'orgChart', agentId: 'root', title: 't', payload: { roles: card, rationale: 'r' } })
    const stored = store.get(p.id)!.roles
    expect(stored.map((r) => r.id)).toEqual(['r-lead', 'r-eng', 'r-rev'])
    expect(stored.find((r) => r.id === 'r-eng')).toMatchObject({ slug: 'builder', name: 'Builder' })
    await m.stopAll()
  })

  it("L1: a late answer after 'pending' publishes no run.liveChange once the run has been stopped", async () => {
    const p = newProject()
    let finish: (r: ConfigChangeResult) => void = () => {}
    const { m } = rig({ hook: () => new Promise<ConfigChangeResult>((r) => (finish = r)), waitMs: 10 })
    const run = await m.start({ project: p, prompt: 'go' })
    const s = userSave(p, (c) => ({ ...c, roles: c.roles.map((r) => (r.id === 'r-eng' ? { ...r, mcpServers: ['m-docs'] } : r)) }))
    expect((await m.applyProjectChange(p.id, s.saved, { kind: 'projectSave', before: s.before, request: s.request }))[0].availability).toBe('pending')
    await m.stop(run.id)
    finish({ availability: 'now' })
    await vi.waitFor(() => expect(logs(run.id).some((l) => l.includes('this run uses it now'))).toBe(true))
    expect(liveEvents(run.id).map((e) => e.change.availability)).toEqual(['pending'])
    await m.stopAll()
  })

  it('L2: a grant two changes named survives the late rejection of the first', async () => {
    const p0 = newProject()
    const p = store.save({ ...p0, skills: [skill('s-notes', 'notes')] })
    const finishers: ((e?: Error) => void)[] = []
    const { m, ctxs } = rig({ hook: () => new Promise<ConfigChangeResult>((res, rej) => finishers.push((e) => (e ? rej(e) : res({ availability: 'now' })))), waitMs: 10 })
    await m.start({ project: p, prompt: 'go' })
    const ctx = ctxs[0]
    // A: the role inspector grants the engineer the skill (pending). B: skills:update from a second window, read before
    // A saved, names the same grant; the run already holds it.
    const before = structuredClone(store.get(p.id)!)
    const a = userSave(p, (c) => ({ ...c, roles: c.roles.map((r) => (r.id === 'r-eng' ? { ...r, skills: ['s-notes'] } : r)) }))
    expect((await m.applyProjectChange(p.id, a.saved, { kind: 'projectSave', before: a.before, request: a.request }))[0].availability).toBe('pending')
    expect(roleOf(ctx, 'r-eng').skills).toEqual(['s-notes'])
    await m.applyProjectChange(p.id, a.saved, { kind: 'skills', ids: ['s-notes'], names: ['notes'], label: 'the skill notes', before, fields: [], grants: [{ item: 's-notes', roleIds: ['r-eng'] }] })
    finishers[0](new Error('late no'))
    await vi.waitFor(() => expect(logs(ctx.run.id).some((l) => l.includes('late no'))).toBe(true))
    expect(roleOf(ctx, 'r-eng').skills).toEqual(['s-notes'])
    await m.stopAll()
  })
})
