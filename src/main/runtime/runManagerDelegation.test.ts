import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExecOutcome, Role, RunEvent, RunOverrides } from '@shared/types'
import { DELEGATION_CLAIM_TOKEN, DELEGATION_EARLY_TOKEN, DELEGATION_FIX_TOKEN, DELEGATION_OK_TOKEN, DELEGATION_SKIP_TOKEN, DEEP_TREE_TOKEN, EXEC_PLAN_TOKEN, MockAdapter } from './mock'
import { RunManager } from './runManager'
import { RunStore } from '../store/runs'
import type { SetupService } from '../setup/service'
import type { RuntimeAdapter, RuntimeContext } from './types'
import { project as makeProject, role } from './testHelpers'

vi.mock('../log', () => ({ logRunEvent: () => {}, logPermission: () => {}, log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } }))

// Required delegation on the host side (docs/design/delegation-enforcement.md 4.3-4.5, 5.2, 5.6, 5.8), with the mock adapter.

let dir: string
let events: RunEvent[]

beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'orgai-dlg-')))
  events = []
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** lead (root) -> mgr (requires policy and evidence) -> policy, evidence. */
function chart(over: { mgrRequired?: string[]; rootRequired?: string[] } = {}): Role[] {
  const mgrRequired = over.mgrRequired ?? ['r-pol', 'r-evi']
  return [
    role({ id: 'r-lead', slug: 'lead', name: 'Lead', canSpawn: true, spawnable: ['r-mgr'], ...(over.rootRequired ? { requiredReports: over.rootRequired } : {}) }),
    role({ id: 'r-mgr', slug: 'mgr', name: 'Manager', canSpawn: true, spawnable: ['r-pol', 'r-evi'], reportsTo: 'r-lead', ...(mgrRequired.length ? { requiredReports: mgrRequired } : {}) }),
    role({ id: 'r-pol', slug: 'policy', name: 'Policy Analyst', reportsTo: 'r-mgr' }),
    role({ id: 'r-evi', slug: 'evidence', name: 'Evidence Reviewer', reportsTo: 'r-mgr' })
  ]
}

function rig(roles: Role[], projectOver: Parameters<typeof makeProject>[0] = {}) {
  const path = join(dir, 'work')
  mkdirSync(path, { recursive: true })
  const p = makeProject({ id: 'p1', path, roles, autoContinue: false, maxSubagentDepth: 3, maxConcurrentSubagents: 4, ...projectOver })
  const store = new RunStore(join(dir, 'data'))
  const setup = { applyProposal: vi.fn(), markScaffolded: vi.fn(), markArchitectureUpdated: vi.fn(), hiddenContext: vi.fn(() => ''), complete: vi.fn() } as unknown as SetupService
  const m = new RunManager({ mock: new MockAdapter({ script: { delayMs: 0 } }) }, (e) => void events.push(e), store, setup, () => 100, { dataDir: join(dir, 'data') })
  return { m, p, store }
}

const finalized = () => events.filter((e): e is Extract<RunEvent, { type: 'run.finalized' }> => e.type === 'run.finalized')
const delegationEvents = () => events.filter((e): e is Extract<RunEvent, { type: 'run.delegation' }> => e.type === 'run.delegation')

async function runExec(r: ReturnType<typeof rig>, prompt: string, over: RunOverrides = {}): Promise<ExecOutcome | undefined> {
  const run = await r.m.start({ project: r.p, prompt, overrides: { execMode: true, ...over } })
  await vi.waitFor(() => expect(finalized()).toHaveLength(1), { timeout: 8000, interval: 20 })
  return r.m.summary(run.id)?.execOutcome ?? r.store.get(run.id)?.execOutcome
}

const toolResults = (): string[] =>
  events.flatMap((e) => (e.type === 'transcript' && e.entry.block.kind === 'tool_result' ? [String(e.entry.block.content)] : []))

describe('RunManager required delegation (mock adapter)', () => {
  it('ok: the manager spawns both workers; the run completes and the receipt is delivered', async () => {
    const r = rig(chart())
    const outcome = await runExec(r, `go ${DELEGATION_OK_TOKEN} ${EXEC_PLAN_TOKEN}`)
    expect(outcome).toBe('completed')
    const summary = finalized()[0].summary
    expect(summary.delegation).toMatchObject({ failed: 0, corrected: 0, rootVerdict: 'adaptive' })
    expect(toolResults().some((t) => t.startsWith('Harness receipt for') && t.includes('policy ✔') && t.includes('evidence ✔'))).toBe(true)
    expect(delegationEvents().length).toBeGreaterThan(0)
    const record = r.store.getRecord(summary.id)
    expect(record?.delegation?.receipts.filter((x) => x.delivered)).toHaveLength(3)
    const mgr = Object.values(record!.agents).find((a) => a.roleSlug === 'mgr')
    expect(mgr?.delegation).toMatchObject({ verdict: 'ok', corrected: false })
  })

  it('early: a manager that finishes before its workers waits, then reports once both are delivered', async () => {
    const r = rig(chart())
    const outcome = await runExec(r, `go ${DELEGATION_EARLY_TOKEN} ${EXEC_PLAN_TOKEN}`)
    expect(outcome).toBe('completed')
    expect(finalized()[0].summary.delegation).toMatchObject({ failed: 0, corrected: 0, rootVerdict: 'adaptive' })
    const record = r.store.getRecord(finalized()[0].summary.id)
    expect(record?.delegation?.receipts.filter((x) => x.delivered)).toHaveLength(3)
    expect(Object.values(record!.agents).find((a) => a.roleSlug === 'mgr')?.delegation).toMatchObject({ verdict: 'ok' })
    expect(toolResults().some((t) => t.startsWith('Harness receipt for') && t.includes('policy ✔') && t.includes('evidence ✔'))).toBe(true)
  })

  it('fix: the correction is recorded once, the manager complies and the run completes', async () => {
    const r = rig(chart())
    const outcome = await runExec(r, `go ${DELEGATION_FIX_TOKEN} ${EXEC_PLAN_TOKEN}`)
    expect(outcome).toBe('completed')
    expect(finalized()[0].summary.delegation).toMatchObject({ failed: 0, corrected: 1 })
    expect(delegationEvents().at(-1)?.summary.corrected).toBe(1)
  })

  it('skip under strict exec ends delegation-incomplete', async () => {
    const r = rig(chart({ mgrRequired: [] }))
    const outcome = await runExec(r, `go ${DELEGATION_SKIP_TOKEN} ${EXEC_PLAN_TOKEN}`, { strictDelegation: true })
    expect(outcome).toBe('delegation-incomplete')
    expect(finalized()[0].summary.endedBy).toBe('policy')
    expect(finalized()[0].summary.delegation).toMatchObject({ failed: 2, corrected: 2, rootVerdict: 'failed', subtreeFailed: true }) // strict: the manager, then the root (its one correction came through nudge)
  })

  it('skip with requiredReports ends delegation-incomplete and the failure line reaches the lead', async () => {
    const r = rig(chart())
    expect(await runExec(r, `go ${DELEGATION_SKIP_TOKEN}`)).toBe('delegation-incomplete')
    expect(toolResults().some((t) => t.includes('FAILED its required delegation'))).toBe(true)
  })

  it('claim: the receipt shows the workers missing whatever the report says', async () => {
    const r = rig(chart())
    await runExec(r, `go ${DELEGATION_CLAIM_TOKEN}`)
    const delivered = toolResults().find((t) => t.includes('I spawned both workers'))
    expect(delivered).toContain('policy ✗ never spawned')
    expect(delivered).toContain('evidence ✗ never spawned')
  })

  it('a root with valid receipts that never called complete_plan is ok', async () => {
    const r = rig(chart({ mgrRequired: [], rootRequired: ['r-mgr'] }))
    const outcome = await runExec(r, `go ${DELEGATION_OK_TOKEN}`)
    expect(outcome).toBe('completed-unplanned')
    expect(finalized()[0].summary.delegation?.rootVerdict).toBe('ok')
  })

  it('no obligations and no strict: nothing is recorded or emitted', async () => {
    const r = rig(chart({ mgrRequired: [] }))
    const outcome = await runExec(r, `go ${DEEP_TREE_TOKEN}`)
    expect(outcome).toBe('completed-unplanned')
    expect(delegationEvents()).toHaveLength(0)
    expect(finalized()[0].summary.delegation).toBeUndefined()
    expect(r.store.getRecord(finalized()[0].summary.id)?.delegation).toBeUndefined()
  })

  it('preflight refuses an exec run whose required report is too deep, before the session starts', async () => {
    const start = vi.spyOn(MockAdapter.prototype, 'start')
    try {
      const r = rig(chart(), { maxSubagentDepth: 1 })
      const outcome = await runExec(r, `go ${DELEGATION_OK_TOKEN}`)
      expect(outcome).toBe('delegation-incomplete')
      expect(start).not.toHaveBeenCalled()
      const record = r.store.getRecord(finalized()[0].summary.id)
      expect(record?.delegation?.problems[0]).toContain('depth limit')
      expect(record?.logs.some((l) => l.level === 'error' && l.message.includes('depth limit'))).toBe(true)
    } finally {
      start.mockRestore()
    }
  })

  it('preflight only warns on an interactive run, which goes on', async () => {
    const r = rig(chart(), { maxSubagentDepth: 1 })
    const run = await r.m.start({ project: r.p, prompt: 'hello' })
    expect(events.some((e) => e.type === 'log' && e.level === 'warn' && e.message.includes('depth limit'))).toBe(true)
    expect(r.m.summary(run.id)?.status).not.toBe('error')
    await r.m.stopAll()
  })
})

describe('exec quiescence correction and the held gate (fake adapter)', () => {
  it('sends the root one correction through nudge, stays live, then fails delegation-incomplete', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    try {
      const nudges: string[] = []
      let ctx!: RuntimeContext
      let gen = 0
      let rootIdle = false
      const adapter: RuntimeAdapter = {
        id: 'mock',
        complete: async () => '',
        start: vi.fn(async (c: RuntimeContext) => {
          ctx = c
          let end!: () => void
          const finished = new Promise<void>((resolve) => (end = resolve))
          c.emit({ type: 'run.status', runId: c.run.id, status: 'running' })
          return {
            send: async () => {},
            interrupt: async () => {},
            nudge: async (t: string) => void nudges.push(t),
            stop: async () => {
              c.emit({ type: 'run.status', runId: c.run.id, status: 'finished' })
              end()
            },
            finished,
            settlement: () => ({ rootTurnGen: gen, rootIdle, continuationSettled: true, nudgeTurn1Sent: true, quiescent: true })
          }
        })
      }
      const path = join(dir, 'w2')
      mkdirSync(path, { recursive: true })
      const p = makeProject({ id: 'p1', path, roles: chart({ mgrRequired: [], rootRequired: ['r-mgr'] }), autoContinue: false })
      const store = new RunStore(join(dir, 'data2'))
      const setup = { markScaffolded: vi.fn(), hiddenContext: vi.fn(() => ''), complete: vi.fn() } as unknown as SetupService
      const m = new RunManager({ mock: adapter }, (e) => void events.push(e), store, setup, () => 100, { dataDir: join(dir, 'data2') })
      const run = await m.start({ project: p, prompt: 'go', overrides: { execMode: true } })
      const endTurn = (): void => {
        gen++
        rootIdle = true
        ctx.onRootTurnEnded?.({ turnGen: gen, ok: true })
        ctx.emit({ type: 'run.status', runId: run.id, status: 'idle' })
      }
      endTurn()
      await vi.advanceTimersByTimeAsync(3000)
      expect(nudges).toHaveLength(1)
      expect(nudges[0]).toContain('you cannot finish yet')
      expect(finalized()).toHaveLength(0)
      // While the correction is pending the run is not settled; a second turn end settles it.
      endTurn()
      await vi.advanceTimersByTimeAsync(3000)
      expect(nudges).toHaveLength(1)
      expect(finalized()).toHaveLength(1)
      expect(m.summary(run.id)?.execOutcome).toBe('delegation-incomplete')
      expect(m.summary(run.id)?.delegation).toMatchObject({ failed: 1, corrected: 1, rootVerdict: 'failed' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('complete_plan is refused once, then accepted as a recorded failure', async () => {
    const { completePlan } = await import('./harnessTools')
    let gateCtx!: RuntimeContext
    let plan: import('@shared/types').RunPlan | undefined = { goal: 'g', steps: [], status: 'active', autoContinues: 0, updatedAt: 0 }
    const adapter: RuntimeAdapter = {
      id: 'mock',
      complete: async () => '',
      start: async (c: RuntimeContext) => {
        gateCtx = c
        c.emit({ type: 'run.status', runId: c.run.id, status: 'running' })
        return { send: async () => {}, interrupt: async () => {}, stop: async () => {}, finished: new Promise<void>(() => {}) }
      }
    }
    const path = join(dir, 'w3')
    mkdirSync(path, { recursive: true })
    const p = makeProject({ id: 'p1', path, roles: chart({ mgrRequired: [], rootRequired: ['r-mgr'] }) })
    const store = new RunStore(join(dir, 'data3'))
    const setup = { markScaffolded: vi.fn(), hiddenContext: vi.fn(() => ''), complete: vi.fn() } as unknown as SetupService
    const m = new RunManager({ mock: adapter }, (e) => void events.push(e), store, setup, () => 100, { dataDir: join(dir, 'data3') })
    await m.start({ project: p, prompt: 'go' })
    const ctx = Object.assign(Object.create(gateCtx) as RuntimeContext, {
      getPlan: () => plan,
      updatePlan: async (next: import('@shared/types').RunPlan) => void (plan = next)
    })
    const call = (): Promise<string> => completePlan.handler(ctx, { summary: 'done' }, {} as never, {}) as Promise<string>
    const first = await call()
    expect(first).toMatch(/^REFUSED: .*must delegate to Manager/s)
    expect(plan?.status).toBe('active')
    const second = await call()
    expect(second).toContain('recorded as failing its required delegation')
    expect(plan?.status).toBe('done')
    await m.stopAll()
  })

  it('a held run cannot be corrected: the check fails at once', async () => {
    let ctx!: RuntimeContext
    const adapter: RuntimeAdapter = {
      id: 'mock',
      complete: async () => '',
      start: async (c: RuntimeContext) => {
        ctx = c
        c.emit({ type: 'run.status', runId: c.run.id, status: 'running' })
        return { send: async () => {}, interrupt: async () => {}, stop: async () => {}, finished: new Promise<void>(() => {}) }
      }
    }
    const path = join(dir, 'w4')
    mkdirSync(path, { recursive: true })
    const p = makeProject({ id: 'p1', path, roles: chart({ mgrRequired: [], rootRequired: ['r-mgr'] }) })
    const store = new RunStore(join(dir, 'data4'))
    const setup = { markScaffolded: vi.fn(), hiddenContext: vi.fn(() => ''), complete: vi.fn() } as unknown as SetupService
    const m = new RunManager({ mock: adapter }, (e) => void events.push(e), store, setup, () => 100, { dataDir: join(dir, 'data4') })
    const run = await m.start({ project: p, prompt: 'go' })
    Reflect.get(m, 'runs').get(run.id).limitHold = true
    const d = ctx.delegation!.completion('root', { canCorrect: true, canWait: true, reportText: '', provisional: true })
    expect(d.action).toBe('fail')
    await m.stopAll()
  })
})
