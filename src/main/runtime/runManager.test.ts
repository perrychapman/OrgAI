import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImageAttachment, Project, Proposal, RunEvent } from '@shared/types'
import type { RuntimeAdapter, RuntimeContext } from './types'
import { RESUME_TEXT, RunManager, type RunManagerOptions } from './runManager'
import { MockAdapter, type MockScript } from './mock'
import { RunStore } from '../store/runs'
import type { SetupService } from '../setup/service'
import { project as makeProject } from './testHelpers'
import { SET_PLAN_NUDGE, limitReachedText } from './continuation'

// The real logger writes under Electron's userData; tests have no Electron.
vi.mock('../log', () => ({ logRunEvent: () => {}, logPermission: () => {}, log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } }))

let dir: string
let events: RunEvent[]

function waitFor<T extends RunEvent>(pred: (e: RunEvent) => e is T, after = 0, timeoutMs = 3000): Promise<T> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = (): void => {
      const hit = events.slice(after).find(pred)
      if (hit) return resolve(hit)
      if (Date.now() - started > timeoutMs) return reject(new Error(`timed out waiting; saw ${events.map((e) => e.type).join(', ')}`))
      setTimeout(tick, 2)
    }
    tick()
  })
}

const isType =
  <K extends RunEvent['type']>(type: K, extra: (e: Extract<RunEvent, { type: K }>) => boolean = () => true) =>
  (e: RunEvent): e is Extract<RunEvent, { type: K }> =>
    e.type === type && extra(e as Extract<RunEvent, { type: K }>)

function fakeSetup(p: Project) {
  const applied: Proposal[] = []
  const completed: string[] = []
  const service = {
    applyProposal: vi.fn((_id: string, proposal: Proposal) => {
      applied.push(proposal)
      return p
    }),
    complete: vi.fn((_id: string, summary: string) => {
      completed.push(summary)
      return p
    }),
    markScaffolded: vi.fn(() => p),
    markArchitectureUpdated: vi.fn(() => p),
    hiddenContext: vi.fn(() => 'profile')
  }
  return { service: service as unknown as SetupService, applied, completed, raw: service }
}

function manager(p: Project, script: MockScript = {}, options: RunManagerOptions = {}) {
  const setup = fakeSetup(p)
  const store = new RunStore(join(dir, 'data'))
  const adapter = new MockAdapter({ script: { delayMs: 0, ...script } })
  const m = new RunManager({ mock: adapter }, (e) => events.push(e), store, setup.service, () => 100, options)
  return { m, store, setup, adapter }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orgai-rm-'))
  events = []
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('RunManager image attachments', () => {
  const PNG = 'iVBORw0KGgo='
  const good: ImageAttachment = { mediaType: 'image/png', data: PNG, name: 'a.png' }
  const bad = { mediaType: 'image/svg+xml', data: PNG } as unknown as ImageAttachment

  function fake(live = false) {
    const ctxs: RuntimeContext[] = []
    const sends: Array<[string, ImageAttachment[] | undefined]> = []
    const adapter: RuntimeAdapter = {
      id: 'mock',
      complete: async () => '',
      start: async (ctx) => {
        ctxs.push(ctx)
        ctx.emit({ type: 'run.status', runId: ctx.run.id, status: 'running', sessionId: `s-${ctxs.length}` })
        ctx.emit({ type: 'run.status', runId: ctx.run.id, status: 'finished' })
        return {
          send: async (text, images) => void sends.push([text, images]),
          interrupt: async () => {},
          stop: async () => {},
          finished: live ? new Promise<void>(() => {}) : Promise.resolve()
        }
      }
    }
    const p = makeProject({ path: join(dir, 'repo') })
    const m = new RunManager({ mock: adapter }, (e) => events.push(e), new RunStore(join(dir, 'data')), fakeSetup(p).service, () => 100)
    return { m, p, ctxs, sends }
  }

  it('sanitizes images on start and passes only valid ones', async () => {
    const { m, p, ctxs } = fake()
    await m.start({ project: p, prompt: 'look', images: [good, bad] })
    expect(ctxs[0].images).toEqual([good])
    await m.start({ project: p, prompt: 'none', images: [bad] })
    expect(ctxs[1].images).toBeUndefined()
    await m.start({ project: p, prompt: 'plain' })
    expect(ctxs[2].images).toBeUndefined()
  })

  it('threads images through send and rejects empty sends', async () => {
    const { m, p, sends } = fake(true)
    const run = await m.start({ project: p, prompt: 'go' })
    await m.send(run.id, 'hi', [good, bad])
    await m.send(run.id, '', [good])
    await m.send(run.id, 'text only')
    expect(sends).toEqual([
      ['hi', [good]],
      ['', [good]],
      ['text only', undefined]
    ])
    await expect(m.send(run.id, '  ', [bad])).rejects.toThrow('Nothing to send')
    await expect(m.send(run.id, '')).rejects.toThrow('Nothing to send')
    expect(sends).toHaveLength(3)
  })

  it('continueRun accepts image-only input and rejects empty', async () => {
    const { m, p, ctxs } = fake()
    const run = await m.start({ project: p, prompt: 'go' })
    const next = await m.continueRun(p, run.id, '', [good, bad])
    expect(ctxs[1].images).toEqual([good])
    expect(ctxs[1].resumeSessionId).toBe('s-1')
    expect(next.prompt).toBe('')
    await expect(m.continueRun(p, run.id, '   ', [bad])).rejects.toThrow('Nothing to send')
    await expect(m.continueRun(p, run.id, '')).rejects.toThrow('Nothing to send')
    await m.continueRun(p, run.id, 'again')
    expect(ctxs[2].images).toBeUndefined()
  })
})

describe('RunManager with the mock adapter', () => {
  it('names reports by handle and turns agent messages into events and transcript lines', async () => {
    const p = makeProject({ path: join(dir, 'repo') })
    const { m } = manager(p, {
      work: [
        { type: 'spawn', id: 'e1', role: 'engineer', description: 'Build the API' },
        { type: 'spawn', id: 'e2', role: 'engineer', description: 'Build the client' },
        { type: 'message', from: 'e1', to: 'engineer-2', text: 'The API lives in src/api.ts' },
        { type: 'message', from: 'e2', to: 'lead', text: 'Got it' },
        { type: 'finish', id: 'e1', result: 'ok' },
        { type: 'finish', id: 'e2', result: 'ok' }
      ]
    })
    const run = await m.start({ project: p, prompt: 'Build it' })
    await waitFor(isType('run.status', (e) => e.status === 'idle'))
    const handles = events.filter(isType('agent.upsert')).map((e) => [e.agent.id, e.agent.handle])
    expect(handles).toContainEqual(['e1', 'engineer-1'])
    expect(handles).toContainEqual(['e2', 'engineer-2'])
    const messages = events.filter(isType('agent.message'))
    expect(messages.map((e) => [e.from, e.to, e.toHandle, e.text])).toEqual([
      ['e1', 'e2', 'engineer-2', 'The API lives in src/api.ts'],
      ['e2', 'root', 'lead', 'Got it']
    ])
    const record = m.get(run.id)!
    expect(record.transcript.some((t) => t.agentId === 'e1' && t.block.kind === 'system' && t.block.text === '→ engineer-2: The API lives in src/api.ts')).toBe(true)
    await m.stop(run.id)
  })

  it('runs a scripted work session end to end', async () => {
    const p = makeProject({ path: join(dir, 'repo') })
    const { m } = manager(p)
    const run = await m.start({ project: p, prompt: 'Change x' })

    const req = await waitFor(isType('permission.request'))
    expect(req.request.toolName).toBe('Edit')
    expect(req.request.agentId).toBe('mock-report-1')
    expect(req.request.summary).toBe('Editing example.ts')
    expect(req.request.ruleLabels).toEqual(['Edit'])
    m.decide(run.id, req.request.id, { behavior: 'allow' })

    await waitFor(isType('run.status', (e) => e.status === 'idle'))
    const types = events.map((e) => e.type)
    expect(types[0]).toBe('run.status')
    expect(events.find(isType('run.status', (e) => e.status === 'running'))?.sessionId).toBe(`mock-${run.id}`)
    expect(types.indexOf('permission.resolved')).toBeGreaterThan(types.indexOf('permission.request'))
    expect(types.lastIndexOf('run.cost')).toBeLessThan(types.lastIndexOf('run.status'))

    const transcript = events.filter(isType('transcript')).map((e) => e.entry)
    expect(transcript[0]).toMatchObject({ agentId: 'root', block: { kind: 'user', text: 'Change x' } })
    const spawn = transcript.find((t) => t.block.kind === 'tool_use' && t.block.name === 'Agent')
    expect(spawn?.agentId).toBe('root')
    expect(transcript.some((t) => t.agentId === 'mock-report-1' && t.block.kind === 'tool_result' && t.block.content === 'File updated.')).toBe(true)

    const report = events.filter(isType('agent.upsert', (e) => e.agent.id === 'mock-report-1')).map((e) => e.agent)
    expect(report[0]).toMatchObject({ parentId: 'root', roleSlug: 'engineer', name: 'Engineer' })
    expect(report.at(-1)).toMatchObject({ state: 'done', activity: 'Reported back', spawnToolUseId: spawn?.block.kind === 'tool_use' ? spawn.block.id : '' })
    expect(report.some((a) => a.state === 'waiting')).toBe(true)

    expect(m.summary(run.id)?.status).toBe('idle')
    expect(m.summary(run.id)?.totalCostUsd).toBeGreaterThan(0)

    // Follow-up message, then stop.
    const before = events.length
    await m.send(run.id, 'thanks')
    await waitFor(isType('run.status', (e) => e.status === 'idle'), before)
    expect(events.slice(before).some((e) => e.type === 'transcript' && e.entry.block.kind === 'text' && e.entry.block.text === 'Mock reply to: thanks')).toBe(true)

    await m.stop(run.id)
    await waitFor(isType('run.status', (e) => e.status === 'finished'))
    await vi.waitFor(() => expect(m.summaryOf(run.id)).toBeUndefined())
    const record = m.get(run.id)
    expect(record?.summary.status).toBe('finished')
    expect(Object.values(record?.agents ?? {}).every((a) => a.state === 'done')).toBe(true)
    expect(record?.transcript.length).toBe(events.filter((e) => e.type === 'transcript').length)
  })

  it('reports a denied permission to the model as an error result', async () => {
    const p = makeProject({ path: join(dir, 'repo') })
    const { m } = manager(p)
    const run = await m.start({ project: p, prompt: 'Change x' })
    const req = await waitFor(isType('permission.request'))
    m.decide(run.id, req.request.id, { behavior: 'deny', message: 'Not now' })
    await waitFor(isType('run.status', (e) => e.status === 'idle'))
    const result = events
      .filter(isType('transcript'))
      .map((e) => e.entry.block)
      .find((b) => b.kind === 'tool_result' && b.isError)
    expect(result).toMatchObject({ content: 'Not now' })
    await m.stop(run.id)
  })

  it('stopping while a permission is pending ends the run and denies the request', async () => {
    const p = makeProject({ path: join(dir, 'repo') })
    const { m } = manager(p)
    const run = await m.start({ project: p, prompt: 'Change x' })
    await waitFor(isType('permission.request'))
    await m.stop(run.id)
    await waitFor(isType('run.status', (e) => e.status === 'finished'))
    expect(events.some((e) => e.type === 'run.status' && e.status === 'stopping')).toBe(true)
  })

  it('applies setup proposals through the SetupService and completes setup', async () => {
    const p = makeProject({ path: join(dir, 'repo'), setup: { kind: 'existing', state: 'in_progress' } })
    const { m, setup } = manager(p)
    const run = await m.start({ project: p, prompt: 'Set it up', kind: 'setup', hiddenContext: 'profile' })

    const root = await waitFor(isType('agent.upsert', (e) => e.agent.id === 'root'))
    expect(root.agent.roleSlug).toBe('architect')

    const perm = await waitFor(isType('permission.request'))
    expect(perm.request.toolName).toBe('Bash')
    expect(perm.request.ruleLabels).toEqual(['Bash(git:*)'])
    m.decide(run.id, perm.request.id, { behavior: 'allow', scope: 'session' })

    // Ask for changes on the first architecture proposal; the mock proposes again.
    const first = await waitFor(isType('proposal.request'))
    expect(first.proposal.kind).toBe('architecture')
    m.decideProposal(run.id, first.proposal.id, { behavior: 'revise', feedback: 'More detail' })
    let seen = events.length
    for (const kind of ['architecture', 'orgChart', 'settings'] as const) {
      const next = await waitFor(isType('proposal.request', (e) => e.proposal.id !== first.proposal.id), seen)
      expect(next.proposal.kind).toBe(kind)
      seen = events.indexOf(next) + 1
      m.decideProposal(run.id, next.proposal.id, { behavior: 'approve' })
    }
    await waitFor(isType('run.status', (e) => e.status === 'idle'))

    expect(setup.applied.map((x) => x.kind)).toEqual(['architecture', 'orgChart', 'settings'])
    const chart = setup.applied[1]
    expect(chart.kind === 'orgChart' && chart.payload.roles.map((r) => r.slug)).toEqual(['lead', 'engineer'])
    expect(setup.completed).toEqual(['Mock setup finished: architecture, org chart and settings were approved.'])
    expect(events.filter((e) => e.type === 'project.updated')).toHaveLength(4)

    const results = events
      .filter(isType('transcript'))
      .map((e) => e.entry.block)
      .flatMap((b) => (b.kind === 'tool_result' ? [b.content] : []))
    expect(results.filter((t) => t.startsWith('REVISE. The user asked for changes:\nMore detail'))).toHaveLength(1)
    expect(results.filter((t) => t.startsWith('APPROVED.'))).toHaveLength(3)
    expect(results).toContain('Setup is marked complete. Give the user a brief closing message.')
    expect(events.find(isType('agent.upsert', (e) => e.agent.activity === 'Proposing the org chart…'))?.agent.state).toBe('waiting')

    await m.stop(run.id)
    await waitFor(isType('run.status', (e) => e.status === 'finished'))
  })

  it('surfaces a proposal the SetupService cannot apply as REVISE', async () => {
    const p = makeProject({ path: join(dir, 'repo'), setup: { kind: 'existing', state: 'in_progress' } })
    const script: MockScript = {
      setup: [{ type: 'harness', name: 'propose_settings', args: { title: 'S', rationale: 'r', brief: 'b' }, retryOnRevise: false }]
    }
    const { m, setup } = manager(p, script)
    setup.raw.applyProposal.mockImplementation(() => {
      throw new Error('disk full')
    })
    const run = await m.start({ project: p, prompt: 'Set it up', kind: 'setup' })
    const req = await waitFor(isType('proposal.request'))
    m.decideProposal(run.id, req.proposal.id, { behavior: 'approve' })
    await waitFor(isType('run.status', (e) => e.status === 'idle'))
    const result = events
      .filter(isType('transcript'))
      .map((e) => e.entry.block)
      .find((b) => b.kind === 'tool_result')
    expect(result).toMatchObject({ content: 'REVISE. The user asked for changes:\nThe harness could not apply this proposal: disk full' })
    expect(events.some((e) => e.type === 'log' && e.level === 'error' && e.message.includes('disk full'))).toBe(true)
    await m.stop(run.id)
  })

  it('refuses a provider with no registered adapter', async () => {
    const p = makeProject({ path: join(dir, 'repo'), provider: { id: 'claude', label: 'Claude', auth: { kind: 'subscription' } } })
    const { m } = manager(p)
    expect(() => m.adapterFor(p)).toThrow('No runtime adapter for provider "claude"')
  })

  describe('unattended execution', () => {
    const fast: RunManagerOptions = { continuationDelayMs: 5 }

    it('reminds the orchestrator of remaining steps until the plan is complete', async () => {
      const p = makeProject({ path: join(dir, 'repo') })
      const { m, adapter } = manager(
        p,
        {
          work: [
            { type: 'plan', goal: 'Ship it', steps: ['Build', 'Verify'] },
            { type: 'planUpdate', steps: [{ id: 'p1', status: 'done' }] },
            { type: 'text', text: 'Step 1 is done. Shall I continue?' }
          ],
          continue: [[{ type: 'planUpdate', steps: [{ id: 'p2', status: 'done' }] }, { type: 'planComplete', summary: 'Built and verified' }]]
        },
        fast
      )
      const run = await m.start({ project: p, prompt: 'Ship it' })
      const done = await waitFor(isType('plan.updated', (e) => e.plan.status === 'done'))
      expect(done.plan.autoContinues).toBe(1)
      await waitFor(isType('run.status', (e) => e.status === 'idle'), events.indexOf(done))
      await sleep(60)
      const session = adapter.sessions[0]
      expect(session.harnessMessages).toHaveLength(1)
      expect(session.harnessMessages[0]).toBe(
        'Harness: plan progress 1 of 2 done. Remaining: p2 Verify. Continue with the next step now; mark steps with update_plan as you go. ' +
          "When every step is done, run the project's verification (build/tests) and call complete_plan. " +
          'Only stop for a genuine decision: call ask_user, or mark_blocked with the reason.'
      )
      expect(events.some((e) => e.type === 'transcript' && e.entry.block.kind === 'system' && e.entry.block.text === session.harnessMessages[0])).toBe(true)
      expect(events.some((e) => e.type === 'agent.upsert' && e.agent.id === 'root' && e.agent.activity === 'Continuing: Verify')).toBe(true)
      expect(m.get(run.id)?.plan).toMatchObject({ status: 'done', summary: 'Built and verified', autoContinues: 1 })
      expect(events.some((e) => e.type === 'log' && e.message === 'Plan set: Ship it (2 steps).')).toBe(true)
      await m.stop(run.id)
      await vi.waitFor(() => expect(m.summaryOf(run.id)).toBeUndefined())
      expect(m.get(run.id)?.plan?.status).toBe('done')
    })

    it('stops at the automatic-continue limit with a warning', async () => {
      const p = makeProject({ path: join(dir, 'repo'), maxAutoContinues: 2 })
      const { m, adapter } = manager(p, { work: [{ type: 'plan', goal: 'G', steps: ['Never finished'] }] }, fast)
      const run = await m.start({ project: p, prompt: 'Go' })
      await waitFor(isType('log', (e) => e.level === 'warn' && e.message.startsWith('Automatic-continue limit reached (2)')))
      await sleep(40)
      expect(adapter.sessions[0].harnessMessages).toHaveLength(2)
      expect(m.get(run.id)?.plan?.autoContinues).toBe(2)
      expect(events.some((e) => e.type === 'transcript' && e.entry.block.kind === 'system' && e.entry.block.text === limitReachedText(2))).toBe(true)
      await m.stop(run.id)
    })

    it('does not nudge while a permission card is pending', async () => {
      const p = makeProject({ path: join(dir, 'repo') })
      const { m, adapter } = manager(
        p,
        { work: [{ type: 'plan', goal: 'G', steps: ['A', 'B'] }, { type: 'tool', name: 'Bash', input: { command: 'npm test' }, ask: true, background: true }] },
        fast
      )
      const run = await m.start({ project: p, prompt: 'Go' })
      const req = await waitFor(isType('permission.request'))
      await waitFor(isType('run.status', (e) => e.status === 'idle'))
      await sleep(60)
      expect(adapter.sessions[0].harnessMessages).toHaveLength(0)
      expect(m.get(run.id)?.plan?.autoContinues).toBe(0)
      m.decide(run.id, req.request.id, { behavior: 'allow' })
      await m.stop(run.id)
    })

    it('asks once for a plan when a turn ends without one', async () => {
      const p = makeProject({ path: join(dir, 'repo') })
      const { m, adapter } = manager(p, { work: [{ type: 'text', text: 'Done with the first part.' }] }, fast)
      const run = await m.start({ project: p, prompt: 'Go' })
      await waitFor(isType('transcript', (e) => e.entry.block.kind === 'system' && e.entry.block.text === SET_PLAN_NUDGE))
      await sleep(60)
      expect(adapter.sessions[0].harnessMessages).toEqual([SET_PLAN_NUDGE])
      await m.stop(run.id)
    })

    it('stays quiet when the project turns automatic continue off, and for setup runs', async () => {
      const p = makeProject({ path: join(dir, 'repo'), autoContinue: false, setup: { kind: 'existing', state: 'in_progress' } })
      const { m, adapter } = manager(p, { work: [{ type: 'plan', goal: 'G', steps: ['A'] }], setup: [{ type: 'text', text: 'Hello' }] }, fast)
      const work = await m.start({ project: p, prompt: 'Go' })
      const setupRun = await m.start({ project: { ...p, autoContinue: true }, prompt: 'Set up', kind: 'setup' })
      await sleep(80)
      expect(adapter.sessions.map((s) => s.harnessMessages.length)).toEqual([0, 0])
      await m.stop(work.id)
      await m.stop(setupRun.id)
    })

    it('tells the user when the orchestrator marks the plan blocked, and carries the plan into a continued run', async () => {
      const p = makeProject({ path: join(dir, 'repo') })
      const { m, adapter } = manager(
        p,
        { work: [{ type: 'plan', goal: 'G', steps: ['A', 'B'] }, { type: 'harness', name: 'mark_blocked', args: { reason: 'Pick a database' } }] },
        fast
      )
      const run = await m.start({ project: p, prompt: 'Go' })
      await waitFor(isType('plan.updated', (e) => e.plan.status === 'blocked'))
      await waitFor(isType('run.status', (e) => e.status === 'idle'))
      await sleep(40)
      expect(adapter.sessions[0].harnessMessages).toHaveLength(0)
      expect(events.some((e) => e.type === 'transcript' && e.entry.block.kind === 'system' && e.entry.block.text.includes('Pick a database'))).toBe(true)
      await m.stop(run.id)
      await vi.waitFor(() => expect(m.summaryOf(run.id)).toBeUndefined())
      const seen = events.length
      const next = await m.continueRun(p, run.id, 'Use Postgres')
      const carried = await waitFor(isType('plan.updated', (e) => e.runId === next.id), seen)
      expect(carried.plan).toMatchObject({ status: 'blocked', blockedReason: 'Pick a database', autoContinues: 0 })
      await m.stopAll()
    })
  })

  describe('usage limits', () => {
    const HOUR = 60 * 60 * 1000
    const limitScript: MockScript = { work: [{ type: 'text', text: 'Working on it' }, { type: 'rateLimit', window: 'five_hour', untilInMs: HOUR }] }

    afterEach(() => {
      vi.useRealTimers()
    })

    it('pauses a run that ends at a usage limit and resumes it when the window resets', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      const p = makeProject({ path: join(dir, 'repo') })
      const { m, store } = manager(p, limitScript, { resolveProject: () => p })
      const run = await m.start({ project: p, prompt: 'Big job' })

      const paused = await waitFor(isType('run.status', (e) => e.status === 'paused'))
      expect(events.some((e) => e.type === 'run.status' && e.status === 'finished' && e.runId === run.id)).toBe(false)
      expect(events.some((e) => e.type === 'usage.status' && e.usage.status === 'rejected')).toBe(true)
      expect(paused.autoResume).toBe(true)
      expect(paused.pausedUntil).toBeGreaterThan(Date.now() + HOUR - 5000)
      expect(paused.pauseReason).toContain('five-hour usage limit')
      expect(paused.pauseReason).toContain('worktrees')
      await vi.waitFor(() => expect(m.summaryOf(run.id)).toBeUndefined())
      expect(store.get(run.id)).toMatchObject({ status: 'paused', autoResume: true, pausedUntil: paused.pausedUntil })
      expect(m.hasAutoResume(run.id)).toBe(true)

      const continueRun = vi.spyOn(m, 'continueRun')
      vi.advanceTimersByTime(HOUR + 1000)
      await vi.waitFor(() => expect(continueRun).toHaveBeenCalledWith(p, run.id, RESUME_TEXT))
      const next = await continueRun.mock.results[0].value
      expect(next.resumedFrom).toBe(run.id)
      expect(store.get(run.id)).toMatchObject({ status: 'finished', autoResume: false })
      await m.stopAll()
    })

    it('falls back to a short pause when the limit gives no reset time', async () => {
      const p = makeProject({ path: join(dir, 'repo') })
      const { m } = manager(p, { work: [{ type: 'rateLimit' }] }, { resolveProject: () => p })
      const before = Date.now()
      await m.start({ project: p, prompt: 'Go' })
      const paused = await waitFor(isType('run.status', (e) => e.status === 'paused'))
      expect(paused.pausedUntil).toBeGreaterThanOrEqual(before + 5 * 60 * 1000)
      await m.stopAll()
    })

    it('cancelAutoResume keeps the run paused; resumeNow continues it', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      const p = makeProject({ path: join(dir, 'repo') })
      const { m, store } = manager(p, limitScript, { resolveProject: () => p })
      const run = await m.start({ project: p, prompt: 'Big job' })
      await waitFor(isType('run.status', (e) => e.status === 'paused'))
      await vi.waitFor(() => expect(m.summaryOf(run.id)).toBeUndefined())

      const continueRun = vi.spyOn(m, 'continueRun')
      const seen = events.length
      m.cancelAutoResume(run.id)
      expect(m.hasAutoResume(run.id)).toBe(false)
      expect(store.get(run.id)).toMatchObject({ status: 'paused', autoResume: false })
      expect(events.slice(seen).find(isType('run.status'))).toMatchObject({ status: 'paused', autoResume: false })
      vi.advanceTimersByTime(2 * HOUR)
      await Promise.resolve()
      expect(continueRun).not.toHaveBeenCalled()

      const next = await m.resumeNow(run.id)
      expect(continueRun).toHaveBeenCalledWith(p, run.id, RESUME_TEXT)
      expect(next.resumedFrom).toBe(run.id)
      await expect(m.resumeNow(run.id)).rejects.toThrow('Run is not paused')
      await m.stopAll()
    })

    it('a run the user stops is not paused', async () => {
      const p = makeProject({ path: join(dir, 'repo') })
      const { m } = manager(p, { work: [{ type: 'text', text: 'hi' }] })
      const run = await m.start({ project: p, prompt: 'Go' })
      await waitFor(isType('run.status', (e) => e.status === 'idle'))
      await m.stop(run.id)
      await waitFor(isType('run.status', (e) => e.status === 'finished'))
      expect(events.some((e) => e.type === 'run.status' && e.status === 'paused')).toBe(false)
    })
  })
})
