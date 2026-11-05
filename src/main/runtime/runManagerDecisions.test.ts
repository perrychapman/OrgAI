import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CardKind, DecisionOptions, DecisionOutcome, HeadlessDecisionPolicy, RunEvent, RunOverrides } from '@shared/types'
import { DEFAULT_HEADLESS_DECISION_POLICY, HEADLESS_POLICY_DENY_MESSAGE } from '@shared/types'
import { RunManager, type RunManagerOptions } from './runManager'
import { RunStore } from '../store/runs'
import type { SetupService } from '../setup/service'
import type { RuntimeAdapter, RuntimeContext } from './types'
import { mcpSpec, project as makeProject } from './testHelpers'

vi.mock('../log', () => ({ logRunEvent: () => {}, logPermission: () => {}, log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } }))

let dir: string
let events: RunEvent[]

beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'orgai-decide-')))
  events = []
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

function rig(options: RunManagerOptions = {}, applyProposal: () => unknown = () => proj()) {
  const ctxs: RuntimeContext[] = []
  const adapter: RuntimeAdapter = {
    id: 'mock',
    complete: async () => '',
    start: async (ctx) => {
      ctxs.push(ctx)
      ctx.emit({ type: 'run.status', runId: ctx.run.id, status: 'running', sessionId: `s-${ctxs.length}` })
      let end!: () => void
      const finished = new Promise<void>((r) => (end = r))
      return {
        send: async () => {},
        interrupt: async () => {},
        stop: async () => {
          ctx.emit({ type: 'run.status', runId: ctx.run.id, status: 'finished' })
          end()
        },
        finished,
        settlement: () => ({ rootTurnGen: 0, rootIdle: false, continuationSettled: false, nudgeTurn1Sent: false, quiescent: false })
      }
    }
  }
  const setup = { applyProposal: vi.fn(applyProposal), markScaffolded: vi.fn(), markArchitectureUpdated: vi.fn(), hiddenContext: vi.fn(() => ''), complete: vi.fn() } as unknown as SetupService
  const store = new RunStore(join(dir, 'data'))
  const m = new RunManager({ mock: adapter }, (e) => void events.push(e), store, setup, () => 100, { dataDir: join(dir, 'data'), ...options })
  return { m, ctxs, store }
}

const folder = (): string => {
  const p = join(dir, 'work')
  mkdirSync(p, { recursive: true })
  return p
}
const proj = () => makeProject({ id: 'p1', path: folder(), runMessaging: true })

/** Raise one card of `kind` on the run; resolves with what the agent got. */
function raise(ctx: RuntimeContext, kind: CardKind): Promise<unknown> {
  switch (kind) {
    case 'permission':
      return ctx.requestPermission({ agentId: 'root', toolName: 'Bash', input: { command: 'ls' }, summary: 'ls' })
    case 'question':
      return ctx.requestQuestion({ agentId: 'root', question: 'Which?', options: [{ label: 'A' }, { label: '(Recommended) B' }], allowMultiple: false, allowFreeText: false })
    case 'proposal':
      return ctx.requestProposal({ kind: 'mcpServers', agentId: 'root', title: 'Add', summary: '', payload: { servers: [] } } as never)
    case 'rules':
      return ctx.requestPermissionRules!({ agentId: 'root', rules: ['Bash(npm test:*)'], reason: 'tests' } as never)
    case 'merge':
      return ctx.requestMergeReview({ agentId: 'a1', agentName: 'Eng', branch: 'b', path: '/w', changedFiles: [], stat: '', patch: '' })
    case 'mcpInstall':
      return ctx.requestMcpInstall!({ agentId: 'root', reason: 'need it', spec: mcpSpec({ id: 'mcp-new' }), requiredSecrets: [] })
  }
}

const REQUEST_TYPE: Record<CardKind, string> = {
  permission: 'permission.request',
  question: 'question.request',
  proposal: 'proposal.request',
  rules: 'rules.request',
  merge: 'merge.request',
  mcpInstall: 'mcpInstall.request'
}
const RESOLVED_TYPE: Record<CardKind, string> = {
  permission: 'permission.resolved',
  question: 'question.resolved',
  proposal: 'proposal.resolved',
  rules: 'rules.resolved',
  merge: 'merge.resolved',
  mcpInstall: 'mcpInstall.resolved'
}

/** The id of the newest card of `kind` from its *.request event. */
function cardId(kind: CardKind): string {
  const e = [...events].reverse().find((x) => x.type === REQUEST_TYPE[kind]) as Record<string, unknown> | undefined
  const obj = (e?.request ?? e?.question ?? e?.proposal ?? e?.review) as { id: string; revision?: number }
  return obj.id
}
function cardRevision(kind: CardKind): number | undefined {
  const e = [...events].reverse().find((x) => x.type === REQUEST_TYPE[kind]) as Record<string, unknown> | undefined
  return ((e?.request ?? e?.question ?? e?.proposal ?? e?.review) as { revision?: number }).revision
}

const DECISIONS: Record<CardKind, { decide: (m: RunManager, runId: string, id: string, opts: DecisionOptions) => DecisionOutcome; effective: string }> = {
  permission: { decide: (m, r, id, o) => m.decide(r, id, { behavior: 'deny', message: 'no' }, o), effective: 'deny' },
  question: { decide: (m, r, id, o) => m.answerQuestion(r, id, { selected: ['A'] }, o), effective: 'answer' },
  proposal: { decide: (m, r, id, o) => m.decideProposal(r, id, { behavior: 'decline' }, o), effective: 'decline' },
  rules: { decide: (m, r, id, o) => m.decideRules(r, id, { behavior: 'deny' }, o), effective: 'deny' },
  merge: { decide: (m, r, id, o) => m.decideMerge(r, id, { behavior: 'hold' }, o), effective: 'hold' },
  mcpInstall: { decide: (m, r, id, o) => m.answerMcpInstall(r, id, { approved: false, scope: 'run' }, o), effective: 'deny' }
}

const KINDS: CardKind[] = ['permission', 'question', 'proposal', 'rules', 'merge', 'mcpInstall']

describe('decision outcomes', () => {
  it.each(KINDS)('%s: applied, stale-revision, already-resolved, not-found', async (kind) => {
    const { m, ctxs } = rig()
    const run = await m.start({ project: proj(), prompt: 'go' })
    const waiting = raise(ctxs[0], kind)
    const id = cardId(kind)
    expect(cardRevision(kind)).toBe(1)
    expect(m.findDecision(id)).toEqual({ status: 'pending', requestId: id, runId: run.id, projectId: 'p1', kind, revision: 1 })
    const { decide, effective } = DECISIONS[kind]
    expect(decide(m, run.id, id, { expectedRevision: 2 })).toEqual({ status: 'stale-revision', runId: run.id, requestId: id })
    // Still pending after a stale answer.
    expect(m.findDecision(id).status).toBe('pending')
    const by = { surface: 'cli' as const, reportedPid: 42 }
    expect(decide(m, run.id, id, { expectedRevision: 1, decidedBy: by })).toEqual({ status: 'applied', runId: run.id, requestId: id, effectiveDecision: effective, decidedBy: by })
    await waiting
    const resolved = events.find((e) => e.type === RESOLVED_TYPE[kind]) as { decidedBy?: unknown }
    expect(resolved.decidedBy).toEqual(by)
    expect(decide(m, run.id, id, {})).toEqual({ status: 'already-resolved', runId: run.id, requestId: id, effectiveDecision: effective, decidedBy: by })
    expect(m.findDecision(id)).toMatchObject({ status: 'applied', runId: run.id, kind, effectiveDecision: effective, decidedBy: by })
    expect(decide(m, run.id, 'nope', {})).toEqual({ status: 'not-found', requestId: 'nope' })
    expect(m.findDecision('nope')).toEqual({ status: 'not-found', requestId: 'nope' })
    await m.stopAll()
  })

  it.each(KINDS)('%s: a card cancelled by the run end reads cancelled', async (kind) => {
    const { m, ctxs } = rig()
    const run = await m.start({ project: proj(), prompt: 'go' })
    const waiting = raise(ctxs[0], kind)
    const id = cardId(kind)
    await m.stop(run.id)
    await waiting
    expect(DECISIONS[kind].decide(m, run.id, id, {})).toEqual({ status: 'cancelled', runId: run.id, requestId: id })
    expect(m.findDecision(id)).toMatchObject({ status: 'cancelled', kind, runId: run.id })
  })

  it('an approval the harness could not apply is applied + applyError + revise', async () => {
    const { m, ctxs } = rig({}, () => {
      throw new Error('bad payload')
    })
    const run = await m.start({ project: proj(), prompt: 'go' })
    const waiting = raise(ctxs[0], 'proposal')
    const id = cardId('proposal')
    const out = m.decideProposal(run.id, id, { behavior: 'approve' }, { decidedBy: { surface: 'desktop' } })
    expect(out).toMatchObject({ status: 'applied', effectiveDecision: 'revise', decidedBy: { surface: 'desktop' } })
    expect(out.applyError).toMatch(/bad payload/)
    expect(await waiting).toMatchObject({ behavior: 'revise' })
    await m.stopAll()
  })

  it('an approved install that the harness refused reads deny', async () => {
    const { m, ctxs } = rig()
    const run = await m.start({ project: proj(), prompt: 'go' })
    const waiting = raise(ctxs[0], 'mcpInstall')
    const id = cardId('mcpInstall')
    // A changed id is refused by settleInstall.
    const out = m.answerMcpInstall(run.id, id, { approved: true, scope: 'run', spec: mcpSpec({ id: 'other' }) })
    expect(out.effectiveDecision).toBe('deny')
    expect(await waiting).toMatchObject({ approved: false })
    await m.stopAll()
  })
})

describe('headless decision policy', () => {
  const policy = (over: Partial<HeadlessDecisionPolicy> = {}): HeadlessDecisionPolicy => ({ ...DEFAULT_HEADLESS_DECISION_POLICY, ...over })
  const exec = (over: Partial<HeadlessDecisionPolicy> = {}, more: RunOverrides = {}): RunOverrides => ({ execMode: true, decisionPolicy: policy(over), ...more })
  const finalized = () => events.filter((e) => e.type === 'run.finalized') as Extract<RunEvent, { type: 'run.finalized' }>[]

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  })

  it('denies a permission after the request went out, decidedBy policy', async () => {
    const { m, ctxs } = rig()
    const run = await m.start({ project: proj(), prompt: 'go', overrides: exec() })
    const waiting = raise(ctxs[0], 'permission')
    const id = cardId('permission')
    // The request event is out and nothing answered yet.
    expect(m.findDecision(id).status).toBe('pending')
    await vi.advanceTimersByTimeAsync(0)
    expect(await waiting).toEqual({ behavior: 'deny', message: HEADLESS_POLICY_DENY_MESSAGE })
    const resolved = events.find((e) => e.type === 'permission.resolved') as Extract<RunEvent, { type: 'permission.resolved' }>
    expect(resolved.decidedBy).toEqual({ surface: 'policy' })
    expect(m.findDecision(id)).toMatchObject({ status: 'applied', effectiveDecision: 'deny', decidedBy: { surface: 'policy' } })
    expect(m.summary(run.id)?.execOutcome).toBeUndefined()
    await m.stop(run.id)
  })

  it('declines proposals and ends needs-decision at maxAutoDenials', async () => {
    const { m, ctxs } = rig()
    const run = await m.start({ project: proj(), prompt: 'go', overrides: exec({ maxAutoDenials: 2 }) })
    const first = raise(ctxs[0], 'proposal')
    await vi.advanceTimersByTimeAsync(0)
    expect(await first).toMatchObject({ behavior: 'decline' })
    expect(finalized()).toHaveLength(0)
    const second = raise(ctxs[0], 'rules')
    await vi.advanceTimersByTimeAsync(0)
    expect(await second).toMatchObject({ behavior: 'deny' })
    await vi.advanceTimersByTimeAsync(100)
    expect(m.summary(run.id)).toMatchObject({ execOutcome: 'needs-decision', endedBy: 'policy', status: 'finished' })
    expect(finalized()).toHaveLength(1)
  })

  it('a conservative answer does not count as a denial', async () => {
    const { m, ctxs } = rig()
    const run = await m.start({ project: proj(), prompt: 'go', overrides: exec({ question: 'conservative', maxAutoDenials: 1 }) })
    const answer = raise(ctxs[0], 'question')
    await vi.advanceTimersByTimeAsync(0)
    expect(await answer).toEqual({ selected: ['(Recommended) B'] })
    await vi.advanceTimersByTimeAsync(100)
    expect(m.summary(run.id)?.execOutcome).toBeUndefined()
    await m.stop(run.id)
  })

  it('merge holds keep the branch and never count toward maxAutoDenials', async () => {
    const { m, ctxs } = rig()
    const run = await m.start({ project: proj(), prompt: 'go', overrides: exec({ merge: 'hold', maxAutoDenials: 2 }) })
    for (let i = 0; i < 4; i++) {
      const held = raise(ctxs[0], 'merge')
      await vi.advanceTimersByTimeAsync(0)
      expect(await held).toEqual({ behavior: 'hold' })
    }
    await vi.advanceTimersByTimeAsync(100)
    expect(m.summary(run.id)?.execOutcome).toBeUndefined()
    expect(finalized()).toHaveLength(0)
    await m.stop(run.id)
  })

  it("'fail' ends the run as needs-decision", async () => {
    const { m, ctxs } = rig()
    const run = await m.start({ project: proj(), prompt: 'go', overrides: exec() })
    // Default question policy is 'fail'.
    const waiting = raise(ctxs[0], 'question')
    await vi.advanceTimersByTimeAsync(100)
    expect(m.summary(run.id)).toMatchObject({ execOutcome: 'needs-decision', endedBy: 'policy' })
    // The card was cancelled with the run.
    expect(await waiting).toEqual({ selected: [] })
  })

  it("'wait' times out into needs-decision; a human answer in time clears it", async () => {
    const { m, ctxs } = rig()
    const run = await m.start({ project: proj(), prompt: 'go', overrides: exec({ merge: 'wait', waitTimeoutMs: 10_000 }) })
    const first = raise(ctxs[0], 'merge')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(m.decideMerge(run.id, cardId('merge'), { behavior: 'merge' }, { decidedBy: { surface: 'tui' } }).status).toBe('applied')
    expect(await first).toEqual({ behavior: 'merge' })
    await vi.advanceTimersByTimeAsync(20_000)
    expect(m.summary(run.id)?.execOutcome).toBeUndefined()
    void raise(ctxs[0], 'merge')
    await vi.advanceTimersByTimeAsync(9_000)
    expect(m.summary(run.id)?.execOutcome).toBeUndefined()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(m.summary(run.id)).toMatchObject({ execOutcome: 'needs-decision', endedBy: 'policy' })
  })

  it('waits humanGraceMs while an interactive client is attached', async () => {
    let clients = 1
    const { m, ctxs } = rig({ interactiveClients: () => clients })
    const run = await m.start({ project: proj(), prompt: 'go', overrides: exec({ humanGraceMs: 30_000 }) })
    const waiting = raise(ctxs[0], 'permission')
    const id = cardId('permission')
    await vi.advanceTimersByTimeAsync(29_000)
    expect(m.findDecision(id).status).toBe('pending')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(await waiting).toMatchObject({ behavior: 'deny' })
    // A human answer inside the grace window wins and the policy does nothing.
    clients = 2
    const second = raise(ctxs[0], 'permission')
    const id2 = cardId('permission')
    await vi.advanceTimersByTimeAsync(1_000)
    m.decide(run.id, id2, { behavior: 'allow', scope: 'once' }, { decidedBy: { surface: 'desktop' } })
    expect(await second).toMatchObject({ behavior: 'allow' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(m.findDecision(id2)).toMatchObject({ status: 'applied', effectiveDecision: 'allow', decidedBy: { surface: 'desktop' } })
    await m.stop(run.id)
  })

  it('a non-exec run gets no policy', async () => {
    const { m, ctxs } = rig()
    const run = await m.start({ project: proj(), prompt: 'go' })
    void raise(ctxs[0], 'permission')
    await vi.advanceTimersByTimeAsync(120_000)
    expect(m.findDecision(cardId('permission')).status).toBe('pending')
    await m.stop(run.id)
  })
})
