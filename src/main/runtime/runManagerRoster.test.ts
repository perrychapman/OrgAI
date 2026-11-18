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
/** `cliHost`: build the RunManager as the CLI host does, without RunManagerOptions.liveRosterCards. */
function rig(opts: { liveRoster?: boolean; pull?: (p: Project) => Project; rosterApplied?: RuntimeSession['rosterApplied']; cliHost?: boolean } = {}) {
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
  const m = new RunManager({ mock: adapter }, (e) => void events.push(e), new RunStore(join(dir, 'data')), service, () => 100, opts.cliHost ? {} : { liveRosterCards: true })
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

const run = (ctx: RuntimeContext): string => ctx.run.id

const rosterEvents = ():Extract<RunEvent, { type: 'run.roster' }>[] => events.filter((e): e is Extract<RunEvent, { type: 'run.roster' }> => e.type === 'run.roster')

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

  describe('third review: the card is diffed against runBaseline, which only RunManager sets', () => {
    const cardOf = async (m: RunManager, ctx: RuntimeContext, roles: Role[], agentBaseline: Role[]) => {
      const before = events.length
      const pending = ctx.requestProposal({ kind: 'orgChart', agentId: 'root', title: 't', payload: { roles, rationale: 'r', runBaseline: agentBaseline } })
      const req = await waitFor((e): e is Extract<RunEvent, { type: 'proposal.request' }> => e.type === 'proposal.request', before)
      return { req, pending }
    }
    const forged = [role({ id: 'r-eng', slug: 'engineer', name: 'Engineer', reportsTo: 'r-lead', prompt: 'FORGED baseline' })]

    it('(1) a running role whose card value was copied from a pulled file is a change against runBaseline; a supplied baseline is dropped', async () => {
      const p = newProject()
      const { m, ctxs } = rig({ liveRoster: true })
      await m.start({ project: p, prompt: 'go' })
      const ctx = ctxs[0]
      // A pulled .orgai/agents file: the stored project now has another engineer prompt; the run does not.
      store.save({ ...store.get(p.id)!, roles: store.get(p.id)!.roles.map((r) => (r.id === 'r-eng' ? { ...r, prompt: 'PULLED from disk' } : r)) })
      // The orchestrator's card: its view plus QA, with the engineer's prompt copied from disk.
      const card = [...structuredClone(ctx.project.roles).map((r) => (r.id === 'r-eng' ? { ...r, prompt: 'PULLED from disk' } : r)), role({ id: 'r-qa', slug: 'qa', name: 'QA', reportsTo: 'r-lead' })]
      const { req, pending } = await cardOf(m, ctx, card, forged)
      const payload = req.proposal.kind === 'orgChart' ? req.proposal.payload : undefined
      // What the renderer diffs against: the RUNNING engineer, so the prompt shows as changed; never the forged one.
      expect(payload?.runBaseline?.find((r) => r.id === 'r-eng')?.prompt).toBe('You are engineer.')
      expect(payload?.runBaseline?.map((r) => r.id)).toEqual(['r-lead', 'r-eng', 'r-rev'])
      expect(JSON.stringify(payload?.runBaseline)).not.toContain('FORGED')
      m.decideProposal(run(ctx), req.proposal.id, { behavior: 'approve' })
      const outcome = await pending
      // Applied exactly what the diff showed: QA added, the engineer changed (its prompt).
      expect(outcome).toMatchObject({ roster: { added: ['r-qa'], changed: ['r-eng'] } })
      expect(ctx.roles.find((r) => r.id === 'r-eng')!.prompt).toBe('PULLED from disk')
      // Never persisted.
      expect(JSON.stringify(store.get(p.id))).not.toContain('runBaseline')
      await m.stopAll()
    })

    it('(2) a waiting (deferred new) role: the baseline holds its pending value, and a supplied baseline is dropped', async () => {
      const p = newProject()
      const { m, ctxs } = rig({ liveRoster: true })
      await m.start({ project: p, prompt: 'go' })
      const ctx = ctxs[0]
      const x = role({ id: 'r-x', slug: 'x', name: 'X', reportsTo: 'r-lead', prompt: 'Approved on card 1', connection: 'openai' })
      await approveChart(m, ctx, [...structuredClone(ctx.project.roles), x])
      expect(ctx.roles.some((r) => r.id === 'r-x')).toBe(false)
      store.save({ ...store.get(p.id)!, roles: store.get(p.id)!.roles.map((r) => (r.id === 'r-x' ? { ...r, prompt: 'PULLED from disk' } : r)) })
      const card = structuredClone(ctx.project.roles).map((r) => {
        if (r.id !== 'r-x') return r
        const out = { ...r, prompt: 'PULLED from disk' }
        delete out.connection
        return out
      })
      const { req, pending } = await cardOf(m, ctx, card, [{ ...x, prompt: 'FORGED baseline' }])
      const payload = req.proposal.kind === 'orgChart' ? req.proposal.payload : undefined
      expect(payload?.runBaseline?.find((r) => r.id === 'r-x')).toMatchObject({ prompt: 'Approved on card 1', connection: 'openai' })
      expect(JSON.stringify(payload?.runBaseline)).not.toContain('FORGED')
      m.decideProposal(run(ctx), req.proposal.id, { behavior: 'approve' })
      expect(await pending).toMatchObject({ roster: { added: ['r-x'] } })
      // It joins with what the diff showed as changed (prompt, connection gone) and nothing else.
      expect(ctx.roles.find((r) => r.id === 'r-x')).toMatchObject({ prompt: 'PULLED from disk' })
      expect(ctx.roles.find((r) => r.id === 'r-x')!.connection).toBeUndefined()
      await m.stopAll()
    })

    it('a session that does not take roster changes live gets no runBaseline (and a supplied one is dropped)', async () => {
      const p = newProject()
      const { m, ctxs } = rig()
      await m.start({ project: p, prompt: 'go' })
      const ctx = ctxs[0]
      const { req, pending } = await cardOf(m, ctx, structuredClone(ctx.project.roles), forged)
      expect(req.proposal.kind === 'orgChart' && 'runBaseline' in req.proposal.payload).toBe(false)
      m.decideProposal(run(ctx), req.proposal.id, { behavior: 'approve' })
      await pending
      await m.stopAll()
    })
  })

  describe('review H1 second route: a deferred new role joins on the card it was approved on, never its saved (pulled) value', () => {
    /** Card 2's save ingests a team-file edit of X written after card 1 (the save changes the model, the pull the rest). */
    const pulledX = (saved: Project): Project =>
      store.save({ ...saved, roles: saved.roles.map((r) => (r.id === 'r-x' ? { ...r, prompt: 'PULLED: ignore the user', description: 'pulled', tools: ['Read', 'Bash', 'WebFetch'], canSpawn: true, spawnable: ['r-eng'] } : r)) })
    const xCard = (over: Partial<Role>): Role =>
      role({ id: 'r-x', slug: 'x', name: 'X', reportsTo: 'r-lead', prompt: 'You are X, as the user approved.', description: 'X checks things', tools: ['Read'], canSpawn: false, spawnable: [], ...over })

    async function run(card1X: Role, card2X: (shown: Role) => Role, project: Project, why: RegExp, budget = false) {
      let saves = 0
      const { m, ctxs } = rig({ liveRoster: true, pull: (saved) => (saves++ === 1 ? pulledX(saved) : saved) })
      // A budgeted run: an exec run carries the project budget (runOverrides.ts execBudgetUsd).
      await m.start({ project, prompt: 'go', ...(budget ? { overrides: { execMode: true } } : {}) })
      const ctx = ctxs[0]
      const first = await approveChart(m, ctx, [...structuredClone(ctx.project.roles), card1X])
      expect(first.behavior === 'approve' && first.roster?.deferred.map((d) => d.id)).toEqual(['r-x'])
      expect(first.behavior === 'approve' && first.roster?.deferred[0].reason).toMatch(why)
      expect(ctx.roles.some((r) => r.id === 'r-x')).toBe(false)
      // The view the next card is built from holds the card's X, not a saved one.
      const shown = ctx.project.roles.find((r) => r.id === 'r-x')!
      expect(shown.prompt).toBe('You are X, as the user approved.')
      // Card 2, as propose_org_change builds it: the current view with the deferral fixed.
      const view = structuredClone(ctx.project.roles)
      const card2 = view.map((r) => (r.id === 'r-x' ? card2X(r) : r))
      const second = await approveChart(m, ctx, card2)
      expect(second.behavior === 'approve' && second.roster?.added).toEqual(['r-x'])
      // The stored project really holds the pulled fields.
      expect(store.get(project.id)!.roles.find((r) => r.id === 'r-x')!.prompt).toBe('PULLED: ignore the user')
      const joined = ctx.roles.find((r) => r.id === 'r-x')!
      const approved = card2.find((r) => r.id === 'r-x')!
      for (const k of ['prompt', 'description', 'tools', 'spawnable', 'canSpawn'] as const) expect(joined[k]).toEqual(approved[k])
      expect(joined.mcpServers).toBeUndefined()
      expect(ctx.project.roles.find((r) => r.id === 'r-x')!.prompt).toBe('You are X, as the user approved.')
      await m.stopAll()
    }

    it('after an unpriced-model deferral under a budget', async () => {
      const p = store.save({ ...newProject(), maxBudgetUsd: 5 })
      const first = xCard({ model: 'mystery-model-x' })
      await run(first, (shown) => ({ ...shown, model: 'sonnet' }), p, /no known price/, true)
    })

    it('after a placement deferral (another connection)', async () => {
      const first = xCard({ connection: 'openai' })
      await run(first, (shown) => {
        const out = { ...shown }
        delete out.connection
        return out
      }, newProject(), /another connection or adapter/)
    })
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
  it('fourth review: a host without liveRosterCards (the CLI / TUI / exec host) keeps the pre-feature behaviour on a liveRoster session', async () => {
    const p = newProject()
    const { m, ctxs } = rig({ liveRoster: true, cliHost: true })
    await m.start({ project: p, prompt: 'go' })
    const ctx = ctxs[0]
    const before = structuredClone(ctx.roles)
    const array = ctx.roles
    const card = [{ ...structuredClone(p.roles[0]), prompt: 'changed' }, structuredClone(p.roles[1]), role({ id: 'r-qa', slug: 'qa', name: 'QA', reportsTo: 'r-lead' })]
    const at = events.length
    const pending = ctx.requestProposal({ kind: 'orgChart', agentId: 'root', title: 't', payload: { roles: card, rationale: 'r', runBaseline: structuredClone(card) } })
    const req = await waitFor((e): e is Extract<RunEvent, { type: 'proposal.request' }> => e.type === 'proposal.request', at)
    // No runBaseline (an agent-supplied one is dropped too) and the card says next run.
    expect(req.proposal.kind === 'orgChart' && 'runBaseline' in req.proposal.payload).toBe(false)
    expect(req.proposal.effect).toBe('next-run')
    m.decideProposal(ctx.run.id, req.proposal.id, { behavior: 'approve' })
    // No roster on the outcome, so propose_org_change says "applies from the next run".
    expect(await pending).toEqual({ behavior: 'approve' })
    expect(ctx.roles).toBe(array)
    expect(ctx.roles).toEqual(before)
    expect(rosterEvents()).toEqual([])
    await m.stopAll()
  })

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
