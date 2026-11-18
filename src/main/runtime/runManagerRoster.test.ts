import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, Proposal, ProposalOutcome, Role, RunEvent } from '@shared/types'
import { RunManager } from './runManager'
import type { RuntimeAdapter, RuntimeContext, RuntimeSession } from './types'
import { RunStore } from '../store/runs'
import { ProjectStore } from '../store/projects'
import { SetupService } from '../setup/service'
import { orgChart, role } from './testHelpers'

// The real logger writes under Electron's userData; tests have no Electron.
vi.mock('../log', () => ({ logRunEvent: () => {}, logPermission: () => {}, log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } }))

/**
 * An approved org chart in the same work run (propose_org_change, 2026-11-18): RunManager applies the proposal's own
 * roles to ctx.roles in place when the session declares liveRoster, on real ProjectStore / SetupService.
 */

let dir: string
let events: RunEvent[]
let store: ProjectStore
let setup: SetupService

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orgai-roster-'))
  mkdirSync(join(dir, 'repo'))
  events = []
  store = new ProjectStore(join(dir, 'data'))
  setup = new SetupService(store)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** A fake adapter: records every ctx and answers with a session that does (or does not) take roster changes live. */
function rig(opts: { liveRoster?: boolean; pull?: (p: Project) => Project; rosterApplied?: RuntimeSession['rosterApplied'] } = {}) {
  const ctxs: RuntimeContext[] = []
  const adapter: RuntimeAdapter = {
    id: 'mock',
    complete: async () => '',
    start: async (ctx) => {
      ctxs.push(ctx)
      ctx.emit({ type: 'run.status', runId: ctx.run.id, status: 'running' })
      const session: RuntimeSession = {
        send: async () => {},
        interrupt: async () => {},
        stop: async () => {},
        finished: new Promise<void>(() => {}),
        ...(opts.liveRoster ? { liveRoster: true } : {}),
        ...(opts.rosterApplied ? { rosterApplied: opts.rosterApplied } : {})
      }
      return session
    }
  }
  // A team-file pull ingested by the same save: the setup service answers with the saved project plus the pull.
  const service = opts.pull
    ? (Object.assign(Object.create(setup) as SetupService, { applyProposal: (id: string, p: Proposal, o?: never) => opts.pull!(setup.applyProposal(id, p, o)) }) as SetupService)
    : setup
  const m = new RunManager({ mock: adapter }, (e) => void events.push(e), new RunStore(join(dir, 'data')), service, () => 100, {})
  return { m, ctxs }
}

function newProject(): Project {
  const p = store.create({ name: 'Roster', path: join(dir, 'repo'), brief: '' })
  const roles = orgChart()
  roles[1].mcpServers = []
  return store.save({ ...p, provider: { ...p.provider, id: 'mock' }, roles })
}

async function approveChart(m: RunManager, ctx: RuntimeContext, roles: Role[]): Promise<ProposalOutcome> {
  const before = events.length
  const pending = ctx.requestProposal({ kind: 'orgChart', agentId: 'root', title: 't', payload: { roles, rationale: 'r' } })
  const card = await waitFor((e): e is Extract<RunEvent, { type: 'proposal.request' }> => e.type === 'proposal.request', before)
  m.decideProposal(ctx.run.id, card.proposal.id, { behavior: 'approve' })
  return pending
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

const rosterEvents = (): Extract<RunEvent, { type: 'run.roster' }>[] => events.filter((e): e is Extract<RunEvent, { type: 'run.roster' }> => e.type === 'run.roster')

describe('an approved org chart reaches the same work run (liveRoster session)', () => {
  it('updates ctx.roles in place for add, change, remove and a root change; the outcome, event and record say what moved', async () => {
    const p = newProject()
    const { m, ctxs } = rig({ liveRoster: true })
    const run = await m.start({ project: p, prompt: 'go' })
    const ctx = ctxs[0]
    const array = ctx.roles
    const [lead, eng] = ctx.roles
    const card = (() => {
      const r = structuredClone(p.roles)
      r[0] = { ...r[0], prompt: 'Lead with QA', spawnable: ['r-eng', 'r-qa'] }
      r[1] = { ...r[1], name: 'Builder' }
      return [r[0], r[1], role({ id: 'r-qa', slug: 'qa', name: 'QA', reportsTo: 'r-lead' })]
    })()
    const outcome = await approveChart(m, ctx, card)
    expect(outcome).toEqual({ behavior: 'approve', roster: { added: ['r-qa'], changed: ['r-lead', 'r-eng'], removed: ['r-rev'], deferred: [] } })
    expect(ctx.roles).toBe(array)
    expect(ctx.roles.map((r) => r.id)).toEqual(['r-lead', 'r-eng', 'r-qa'])
    expect(ctx.roles[0]).toBe(lead)
    expect(ctx.roles[1]).toBe(eng)
    expect(lead).toMatchObject({ prompt: 'Lead with QA', spawnable: ['r-eng', 'r-qa'], reportsTo: null })
    expect(eng.name).toBe('Builder')
    // The removed role is kept for agents that started on it.
    expect(ctx.retiredRoles!().map((r) => r.id)).toEqual(['r-rev'])
    // The harness tools' view of the project no longer lists it either.
    expect(ctx.project.roles.map((r) => r.id)).toEqual(['r-lead', 'r-eng', 'r-qa'])
    const [ev] = rosterEvents()
    expect(ev).toEqual({
      type: 'run.roster',
      runId: run.id,
      change: { added: ['r-qa'], changed: ['r-lead', 'r-eng'], removed: ['r-rev'], deferred: [] },
      roster: [
        { id: 'r-lead', slug: 'lead', name: 'Lead', color: '#fff', reportsTo: null },
        { id: 'r-eng', slug: 'engineer', name: 'Builder', color: '#fff', reportsTo: 'r-lead' },
        { id: 'r-qa', slug: 'qa', name: 'QA', color: '#fff', reportsTo: 'r-lead', added: true },
        { id: 'r-rev', slug: 'reviewer', name: 'Reviewer', color: '#fff', reportsTo: 'r-lead', removed: true }
      ]
    })
    expect(structuredClone(ev)).toEqual(ev)
    // The card said so before the decision.
    const req = events.find((e): e is Extract<RunEvent, { type: 'proposal.request' }> => e.type === 'proposal.request')!
    expect(req.proposal.effect).toBe('now')
    // Persisted with the record (relaunch restore).
    await m.stopAll()
    expect(new RunStore(join(dir, 'data')).getRecord(run.id)?.roster?.map((r) => [r.id, r.removed ?? false])).toEqual([
      ['r-lead', false],
      ['r-eng', false],
      ['r-qa', false],
      ['r-rev', true]
    ])
  })

  it('never widens grants and keeps a same-save team-file pull out of the run', async () => {
    const p = newProject()
    const pull = (saved: Project): Project => ({
      ...saved,
      roles: [
        ...saved.roles.map((r) => (r.id === 'r-eng' ? { ...r, mcpServers: ['m-pulled'], skills: ['s-pulled'] } : r.id === 'r-rev' ? { ...r, prompt: 'INGESTED' } : r)),
        role({ id: 'r-pulled', slug: 'pulled', reportsTo: 'r-lead' })
      ]
    })
    const { m, ctxs } = rig({ liveRoster: true, pull })
    await m.start({ project: p, prompt: 'go' })
    const ctx = ctxs[0]
    // The card renames the engineer, keeps the reviewer, adds QA (whose card copy carries grants it must not get).
    const card = structuredClone(p.roles)
    card[1] = { ...card[1], name: 'Builder' }
    card.push(role({ id: 'r-qa', slug: 'qa', name: 'QA', reportsTo: 'r-lead', mcpServers: ['m1'], skills: ['s1'] }))
    const outcome = await approveChart(m, ctx, card)
    expect(outcome.behavior === 'approve' && outcome.roster).toEqual({ added: ['r-qa'], changed: ['r-eng'], removed: [], deferred: [] })
    const byId = new Map(ctx.roles.map((r) => [r.id, r]))
    expect(byId.get('r-eng')).toMatchObject({ name: 'Builder', mcpServers: [] })
    expect(byId.get('r-eng')!.skills).toBeUndefined()
    expect(byId.get('r-qa')!.mcpServers).toBeUndefined()
    expect(byId.get('r-qa')!.skills).toBeUndefined()
    expect(byId.get('r-rev')!.prompt).toBe('You are reviewer.')
    expect(byId.has('r-pulled')).toBe(false)
    await m.stopAll()
  })

  it('a removed role whose report is still running: the report stays as it started, the role stays named, it is not spawnable', async () => {
    const p = newProject()
    const { m, ctxs } = rig({ liveRoster: true })
    const run = await m.start({ project: p, prompt: 'go' })
    const ctx = ctxs[0]
    const agent = { id: 'a-rev', roleId: 'r-rev', roleSlug: 'reviewer', name: 'Reviewer', parentId: 'root', spawnToolUseId: 't1', state: 'tool' as const, activity: 'reading', inputTokens: 0, outputTokens: 0, costUsd: 0, startedAt: 1 }
    ctx.emit({ type: 'agent.upsert', runId: run.id, agent })
    const outcome = await approveChart(m, ctx, structuredClone(p.roles).filter((r) => r.id !== 'r-rev'))
    expect(outcome.behavior === 'approve' && outcome.roster?.removed).toEqual(['r-rev'])
    // Nothing touched the running report.
    expect(events.some((e) => e.type === 'agent.remove')).toBe(false)
    const upserts = events.filter((e): e is Extract<RunEvent, { type: 'agent.upsert' }> => e.type === 'agent.upsert' && e.agent.id === 'a-rev')
    expect(upserts.at(-1)!.agent).toMatchObject({ state: 'tool', roleId: 'r-rev' })
    // Its role is no longer in the roster agents spawn from, but its name and colour stay available.
    expect(ctx.roles.some((r) => r.id === 'r-rev')).toBe(false)
    expect(ctx.retiredRoles!()).toEqual([expect.objectContaining({ id: 'r-rev', name: 'Reviewer', color: '#fff' })])
    expect(rosterEvents()[0].roster.at(-1)).toEqual({ id: 'r-rev', slug: 'reviewer', name: 'Reviewer', color: '#fff', reportsTo: 'r-lead', removed: true })
    await m.stopAll()
  })

  it('review H1: a same-save pull of a role on approval #1 never reaches ctx.roles on approval #2, whose card is built from ctx.project.roles', async () => {
    const p = newProject()
    let pulls = 0
    // Approval #1's save also pulls new tools, model and tier for the engineer from the team files (persisted).
    const pull = (saved: Project): Project => {
      if (pulls++ > 0) return saved
      return store.save({ ...saved, roles: saved.roles.map((r) => (r.id === 'r-eng' ? { ...r, tools: ['Read', 'Bash', 'WebFetch'], model: 'opus', tier: 'deep', prompt: 'PULLED' } : r)) })
    }
    const { m, ctxs } = rig({ liveRoster: true, pull })
    await m.start({ project: p, prompt: 'go' })
    const ctx = ctxs[0]
    const engBefore = structuredClone(ctx.roles.find((r) => r.id === 'r-eng')!)
    // Approval #1 renames the reviewer only.
    const first = structuredClone(p.roles)
    first[2] = { ...first[2], name: 'Checker' }
    expect(await approveChart(m, ctx, first)).toMatchObject({ roster: { changed: ['r-rev'] } })
    // The run's view of its roles is the run's own roles: the pulled fields are not there.
    expect(ctx.project.roles.find((r) => r.id === 'r-eng')).toEqual(engBefore)
    // Approval #2, as propose_org_change builds it: the current view plus a new role; the engineer is untouched.
    const second = [...structuredClone(ctx.project.roles), role({ id: 'r-qa', slug: 'qa', name: 'QA', reportsTo: 'r-lead' })]
    expect(await approveChart(m, ctx, second)).toMatchObject({ roster: { added: ['r-qa'], changed: [] } })
    const eng = ctx.roles.find((r) => r.id === 'r-eng')!
    expect(eng).toEqual(engBefore)
    expect(eng.tools).toEqual(['Read', 'Edit', 'Write'])
    expect(eng.model).toBe('sonnet')
    expect(eng.tier).toBeUndefined()
    await m.stopAll()
  })

  it('review M1: rosterApplied is called synchronously with the ids, after ctx.roles moved; a throw is caught and logged', async () => {
    const p = newProject()
    const seen: { change: unknown; rolesThen: string[] }[] = []
    let ctxRef: RuntimeContext | undefined
    const rosterApplied = vi.fn((change: { added: string[]; changed: string[]; removed: string[] }) => {
      seen.push({ change, rolesThen: ctxRef!.roles.map((r) => r.id) })
    })
    const { m, ctxs } = rig({ liveRoster: true, rosterApplied })
    await m.start({ project: p, prompt: 'go' })
    const ctx = (ctxRef = ctxs[0])
    const card = [structuredClone(p.roles[0]), { ...structuredClone(p.roles[1]), name: 'Builder' }, role({ id: 'r-qa', slug: 'qa', name: 'QA', reportsTo: 'r-lead' })]
    // Synchronous: decideProposal applies and calls the session before it returns.
    const before = events.length
    const pending = ctx.requestProposal({ kind: 'orgChart', agentId: 'root', title: 't', payload: { roles: card, rationale: 'r' } })
    const req = await waitFor((e): e is Extract<RunEvent, { type: 'proposal.request' }> => e.type === 'proposal.request', before)
    m.decideProposal(ctx.run.id, req.proposal.id, { behavior: 'approve' })
    expect(rosterApplied).toHaveBeenCalledTimes(1)
    expect(seen[0]).toEqual({ change: { added: ['r-qa'], changed: ['r-eng'], removed: ['r-rev'] }, rolesThen: ['r-lead', 'r-eng', 'r-qa'] })
    await pending
    await m.stopAll()

    // A throwing implementation does not stop the change.
    events = []
    const throwing = vi.fn(() => {
      throw new Error('boom')
    })
    const { log } = await import('../log')
    const warn = vi.spyOn(log, 'warn')
    const r2 = rig({ liveRoster: true, rosterApplied: throwing })
    await r2.m.start({ project: newProject(), prompt: 'go' })
    const ctx2 = r2.ctxs[0]
    const outcome = await approveChart(r2.m, ctx2, [...structuredClone(p.roles), role({ id: 'r-qa', slug: 'qa', name: 'QA', reportsTo: 'r-lead' })])
    expect(throwing).toHaveBeenCalledTimes(1)
    expect(outcome).toMatchObject({ behavior: 'approve', roster: { added: ['r-qa'] } })
    expect(ctx2.roles.some((r) => r.id === 'r-qa')).toBe(true)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("rosterApplied threw: boom"))
    await r2.m.stopAll()
  })

  it('defers a role on another connection with a reason and applies the rest', async () => {
    const p = newProject()
    const { m, ctxs } = rig({ liveRoster: true })
    await m.start({ project: p, prompt: 'go' })
    const ctx = ctxs[0]
    const card = [...structuredClone(p.roles), role({ id: 'r-far', slug: 'far', name: 'Far', reportsTo: 'r-lead', connection: 'openai' }), role({ id: 'r-qa', slug: 'qa', name: 'QA', reportsTo: 'r-lead' })]
    const outcome = await approveChart(m, ctx, card)
    const roster = outcome.behavior === 'approve' ? outcome.roster : undefined
    expect(roster?.added).toEqual(['r-qa'])
    expect(roster?.deferred.map((d) => d.id)).toEqual(['r-far'])
    expect(roster?.deferred[0].reason).toMatch(/another connection or adapter.*next run/)
    expect(ctx.roles.some((r) => r.id === 'r-far')).toBe(false)
    await m.stopAll()
  })
})

describe('runs that keep their roles', () => {
  it('a session without liveRoster: ctx.roles unchanged, no roster, the card says next run', async () => {
    const p = newProject()
    const { m, ctxs } = rig()
    await m.start({ project: p, prompt: 'go' })
    const ctx = ctxs[0]
    const before = structuredClone(ctx.roles)
    const card = [structuredClone(p.roles[0]), role({ id: 'r-qa', slug: 'qa', name: 'QA', reportsTo: 'r-lead' })]
    expect(await approveChart(m, ctx, card)).toEqual({ behavior: 'approve' })
    expect(ctx.roles).toEqual(before)
    expect(rosterEvents()).toEqual([])
    const req = events.find((e): e is Extract<RunEvent, { type: 'proposal.request' }> => e.type === 'proposal.request')!
    expect(req.proposal.effect).toBe('next-run')
    await m.stopAll()
  })

  it('a setup run keeps the Architect even on a liveRoster session', async () => {
    const p = newProject()
    const { m, ctxs } = rig({ liveRoster: true })
    await m.start({ project: p, prompt: 'go', kind: 'setup' })
    const ctx = ctxs[0]
    const before = structuredClone(ctx.roles)
    const outcome = await approveChart(m, ctx, [...structuredClone(p.roles), role({ id: 'r-qa', slug: 'qa', name: 'QA', reportsTo: 'r-lead' })])
    expect(outcome).toEqual({ behavior: 'approve' })
    expect(ctx.roles).toEqual(before)
    expect(rosterEvents()).toEqual([])
    await m.stopAll()
  })
})
