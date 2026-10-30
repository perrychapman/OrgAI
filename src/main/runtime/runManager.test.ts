import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentInstance, ImageAttachment, McpServerSpec, Project, Proposal, RunEvent, RunSummary } from '@shared/types'
import type { RuntimeAdapter, RuntimeContext, RuntimeSession } from './types'
import { ROOT_AGENT_ID } from './types'
import { RESUME_TEXT, RUN_MESSAGE_INBOUND_LIMIT, RUN_MESSAGE_LIMIT, RUN_MESSAGE_QUEUE_LIMIT, RUN_MESSAGE_RECEIVE_TIMEOUT_MS, RunManager, sessionChain, type RunManagerOptions } from './runManager'
import { MockAdapter, type MockScript, type MockSession } from './mock'
import { harnessToolsFor } from './harnessTools'
import { RunStore } from '../store/runs'
import type { SetupService } from '../setup/service'
import { project as makeProject, runSummary } from './testHelpers'
import { SET_PLAN_NUDGE, SET_PLAN_SUMMARY, limitReachedText } from './continuation'

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

describe('RunManager stored records', () => {
  it('breaks a parent cycle in a record read from the store', () => {
    const p = makeProject({ path: join(dir, 'repo') })
    const { m, store } = manager(p)
    const agent = (id: string, parentId: string | null, startedAt: number): AgentInstance => ({
      id, roleId: null, roleSlug: id, name: id, parentId, spawnToolUseId: null, state: 'done', activity: '',
      inputTokens: 0, outputTokens: 0, costUsd: 0, startedAt
    })
    // The shape of run_mvu37llxrwm72owl: a resumed lead re-parented under the report it spawned.
    store.saveRecord({
      summary: runSummary({ id: 'run-cycle', projectId: p.id, status: 'finished' }),
      agents: {
        root: agent('root', null, 0),
        lead: agent('lead', 'report', 1),
        report: agent('report', 'lead', 3),
        other: agent('other', 'lead', 2)
      },
      transcript: [],
      logs: []
    })
    const agents = m.get('run-cycle')!.agents
    expect(agents.lead.parentId).toBe('root')
    expect(agents.report.parentId).toBe('lead')
    expect(agents.other.parentId).toBe('lead')
    expect(store.getRecord('run-cycle')!.agents.lead.parentId).toBe('report')
  })
})

describe('RunManager image attachments', () => {
  const PNG = 'iVBORw0KGgo='
  const good: ImageAttachment = { mediaType: 'image/png', data: PNG, name: 'a.png' }
  const bad = { mediaType: 'image/svg+xml', data: 'AAAA' } as unknown as ImageAttachment

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

  describe('permission rule requests', () => {
    const script = (command: string): MockScript => ({
      work: [
        { type: 'harness', name: 'request_permission_rules', args: { rules: ['Bash(gh:*)', 'Bash(git push:*)'], reason: 'Publish the repo' } },
        { type: 'tool', name: 'Bash', input: { command }, ask: true, result: 'published' }
      ]
    })

    it('a grant for the run lets the retried call through without a card and stays out of the settings file', async () => {
      const p = makeProject({ path: join(dir, 'repo') })
      const { m } = manager(p, script('gh repo create a/b --public && git push -u origin main'))
      const run = await m.start({ project: p, prompt: 'Publish' })
      const req = await waitFor(isType('rules.request'))
      expect(req.request).toMatchObject({ agentId: 'root', rules: ['Bash(gh:*)', 'Bash(git push:*)'], reason: 'Publish the repo', flagged: ['Bash(git push:*)'] })
      m.decideRules(run.id, req.request.id, { behavior: 'grant', scope: 'run' })
      await waitFor(isType('rules.resolved'))
      await waitFor(isType('run.status', (e) => e.status === 'idle'))
      const blocks = events.filter(isType('transcript')).map((e) => e.entry.block)
      expect(blocks.find((b) => b.kind === 'tool_result' && /GRANTED \(this run only\)/.test(String(b.content)))).toBeTruthy()
      expect(blocks.find((b) => b.kind === 'tool_result' && b.content === 'published')).toBeTruthy()
      expect(events.some((e) => e.type === 'permission.request')).toBe(false)
      expect(existsSync(join(p.path, '.claude', 'settings.local.json'))).toBe(false)
      expect(events.some((e) => e.type === 'log' && /Allowed Bash\(gh:\*\), Bash\(git push:\*\) for this run/.test(e.message))).toBe(true)
      await m.stop(run.id)
    })

    it('a project grant saves the rules to .claude/settings.local.json', async () => {
      const p = makeProject({ path: join(dir, 'repo') })
      const { m } = manager(p, script('gh repo view'))
      const run = await m.start({ project: p, prompt: 'Publish' })
      const req = await waitFor(isType('rules.request'))
      m.decideRules(run.id, req.request.id, { behavior: 'grant', scope: 'project' })
      await waitFor(isType('run.status', (e) => e.status === 'idle'))
      const saved = JSON.parse(readFileSync(join(p.path, '.claude', 'settings.local.json'), 'utf8')) as { permissions: { allow: string[] } }
      expect(saved.permissions.allow).toEqual(['Bash(gh:*)', 'Bash(git push:*)'])
      expect(events.filter(isType('transcript')).some((e) => e.entry.block.kind === 'tool_result' && /GRANTED \(saved for this project\)/.test(String(e.entry.block.content)))).toBe(true)
      await m.stop(run.id)
    })

    it('a denial reaches the agent with the note, and the next call still asks', async () => {
      const p = makeProject({ path: join(dir, 'repo') })
      const { m } = manager(p, script('gh repo view'))
      const run = await m.start({ project: p, prompt: 'Publish' })
      const req = await waitFor(isType('rules.request'))
      m.decideRules(run.id, req.request.id, { behavior: 'deny', message: 'Keep it private' })
      const perm = await waitFor(isType('permission.request'))
      expect(perm.request.toolName).toBe('Bash')
      expect(events.filter(isType('transcript')).some((e) => e.entry.block.kind === 'tool_result' && /^DENIED: Keep it private\./.test(String(e.entry.block.content)))).toBe(true)
      await m.stop(run.id)
      await waitFor(isType('run.status', (e) => e.status === 'finished'))
    })

    it('stopping the run denies an open request', async () => {
      const p = makeProject({ path: join(dir, 'repo') })
      const { m } = manager(p, script('gh repo view'))
      const run = await m.start({ project: p, prompt: 'Publish' })
      const req = await waitFor(isType('rules.request'))
      await m.stop(run.id)
      const resolved = await waitFor(isType('rules.resolved'))
      expect(resolved).toMatchObject({ requestId: req.request.id, decision: { behavior: 'deny', message: 'Run ended' }, cancelled: true })
      expect(events.filter(isType('rules.resolved'))).toHaveLength(1)
    })
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
    const req = await waitFor(isType('permission.request'))
    await m.stop(run.id)
    const finished = await waitFor(isType('run.status', (e) => e.status === 'finished'))
    expect(events.some((e) => e.type === 'run.status' && e.status === 'stopping')).toBe(true)
    // The card is cancelled before the terminal status goes out, exactly once.
    const resolved = events.filter(isType('permission.resolved'))
    expect(resolved).toEqual([{ type: 'permission.resolved', runId: run.id, requestId: req.request.id, cancelled: true }])
    expect(events.indexOf(resolved[0])).toBeLessThan(events.indexOf(finished))
    // No node keeps saying "Waiting for you" / "Needs approval" once the session ended.
    await vi.waitFor(() => expect(m.summaryOf(run.id)).toBeUndefined())
    const agents = Object.values(m.get(run.id)?.agents ?? {})
    expect(agents.find((a) => a.id === 'root')).toMatchObject({ state: 'done', activity: 'Stopped' })
    expect(agents.find((a) => a.id === 'mock-report-1')).toMatchObject({ state: 'done', activity: 'Stopped' })
    const lastRoot = events.filter(isType('agent.upsert', (e) => e.agent.id === 'root')).at(-1)
    expect(lastRoot?.agent.activity).toBe('Stopped')
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
        'Harness: plan 1 of 2 done. Remaining: p2 Verify. Continue with the next step; mark steps with update_plan as you go. ' +
          "When all are done, run the project's verification (build/tests) and call complete_plan. " +
          'Stop only for a real decision: ask_user, or mark_blocked with the reason.'
      )
      expect(
        events.some(
          (e) =>
            e.type === 'transcript' && e.entry.source === 'harness' && e.entry.block.kind === 'system' &&
            e.entry.block.detail === session.harnessMessages[0] && e.entry.block.text === 'Continuing: 1 of 2 steps done, next "Verify".'
        )
      ).toBe(true)
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
      await waitFor(isType('transcript', (e) => e.entry.block.kind === 'system' && e.entry.block.detail === SET_PLAN_NUDGE && e.entry.block.text === SET_PLAN_SUMMARY))
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

describe('RunManager.pendingCards (runs:pendingCards)', () => {
  const empty = { permissions: [], questions: [], proposals: [], ruleRequests: [], mergeReviews: [], mcpInstalls: [] }

  it('lists a pending permission and a pending question, drops each once answered, and is empty after the end', async () => {
    const p = makeProject({ path: join(dir, 'repo') })
    const script: MockScript = {
      work: [
        { type: 'tool', name: 'Edit', input: { file_path: 'a.ts', old_string: 'a', new_string: 'b' }, ask: true, background: true, result: 'ok' },
        { type: 'harness', name: 'ask_user', args: { question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] } },
        { type: 'text', text: 'done' }
      ]
    }
    const { m } = manager(p, script)
    const run = await m.start({ project: p, prompt: 'Go' })
    const perm = await waitFor(isType('permission.request'))
    const q = await waitFor(isType('question.request'))

    const cards = m.pendingCards(run.id)
    expect(cards.permissions).toEqual([perm.request])
    expect(cards.questions).toEqual([q.question])
    expect(cards.proposals).toEqual([])
    expect(structuredClone(cards)).toEqual(cards)

    m.decide(run.id, perm.request.id, { behavior: 'allow' })
    expect(m.pendingCards(run.id).permissions).toEqual([])
    expect(m.pendingCards(run.id).questions).toEqual([q.question])
    m.answerQuestion(run.id, q.question.id, { selected: ['A'] })
    expect(m.pendingCards(run.id)).toEqual(empty)

    await waitFor(isType('run.status', (e) => e.status === 'idle'))
    await m.stop(run.id)
    await waitFor(isType('run.status', (e) => e.status === 'finished'))
    expect(m.pendingCards(run.id)).toEqual(empty)
  })

  it('is empty for an unknown run and for a run that ended with a card open', async () => {
    const p = makeProject({ path: join(dir, 'repo') })
    const { m } = manager(p)
    expect(m.pendingCards('nope')).toEqual(empty)
    const run = await m.start({ project: p, prompt: 'Change x' })
    await waitFor(isType('permission.request'))
    expect(m.pendingCards(run.id).permissions).toHaveLength(1)
    await m.stop(run.id)
    await waitFor(isType('run.status', (e) => e.status === 'finished'))
    expect(m.pendingCards(run.id)).toEqual(empty)
  })

  it("returns a setup run's pending proposal", async () => {
    const p = makeProject({ path: join(dir, 'repo'), setup: { kind: 'existing', state: 'in_progress' } })
    const script: MockScript = {
      setup: [{ type: 'harness', name: 'propose_settings', args: { title: 'S', rationale: 'r', brief: 'b' }, retryOnRevise: false }]
    }
    const { m } = manager(p, script)
    const run = await m.start({ project: p, prompt: 'Set it up', kind: 'setup' })
    const req = await waitFor(isType('proposal.request'))
    expect(m.pendingCards(run.id).proposals).toEqual([req.proposal])
    m.decideProposal(run.id, req.proposal.id, { behavior: 'approve' })
    expect(m.pendingCards(run.id).proposals).toEqual([])
    await m.stop(run.id)
    await waitFor(isType('run.status', (e) => e.status === 'finished'))
  })
})

describe('RunManager adapter selection, connections and MCP', () => {
  /** A recording adapter whose session stays open until `end()`. */
  function recorder(id: 'claude' | 'codex' | 'mock') {
    const ctxs: RuntimeContext[] = []
    let end = (): void => {}
    const adapter: RuntimeAdapter = {
      id,
      complete: async () => '',
      start: async (ctx) => {
        ctxs.push(ctx)
        ctx.emit({ type: 'run.status', runId: ctx.run.id, status: 'running' })
        return {
          send: async () => {},
          interrupt: async () => {},
          stop: async () => end(),
          finished: new Promise<void>((r) => (end = r))
        }
      }
    }
    return { adapter, ctxs, end: () => end() }
  }

  const litellm = (rootModel: string, others: Record<string, string> = {}): Project => {
    const base = makeProject({ path: join(dir, 'repo'), provider: { id: 'claude', label: 'Claude', auth: { kind: 'subscription' }, connection: 'litellm' } })
    const roles = base.roles.map((r) => ({ ...r, model: r.reportsTo === null ? rootModel : (others[r.slug] ?? rootModel) }))
    return { ...base, roles }
  }

  function setupManager(p: Project, adapters: ConstructorParameters<typeof RunManager>[0], options: RunManagerOptions = {}) {
    const store = new RunStore(join(dir, 'data'))
    const m = new RunManager(adapters, (e) => events.push(e), store, fakeSetup(p).service, () => 100, options)
    return { m, store }
  }

  describe('adapter selection', () => {
    it('picks the adapter by the root role family on LiteLLM', async () => {
      const claude = recorder('claude')
      const codex = recorder('codex')
      const { m } = setupManager(litellm('gpt-5'), { claude: claude.adapter, codex: codex.adapter })
      await m.start({ project: litellm('gpt-5'), prompt: 'go' })
      expect(codex.ctxs).toHaveLength(1)
      expect(claude.ctxs).toHaveLength(0)
      await m.start({ project: litellm('sonnet'), prompt: 'go' })
      expect(claude.ctxs).toHaveLength(1)
      expect(m.adapterFor(litellm('gpt-5'))).toBe(codex.adapter)
      await m.stopAll()
    })

    it('refuses a work run whose roles mix families, before creating the run', async () => {
      const claude = recorder('claude')
      const codex = recorder('codex')
      const p = litellm('sonnet', { engineer: 'gpt-5', reviewer: 'gpt-5' })
      const { m, store } = setupManager(p, { claude: claude.adapter, codex: codex.adapter })
      await expect(m.start({ project: p, prompt: 'go' })).rejects.toThrow(
        "Roles Engineer, Reviewer use OpenAI-family models, but this LiteLLM project's orchestrator runs on Claude. Pick models of one family."
      )
      expect(store.list(p.id)).toEqual([])
      expect(events).toEqual([])
      expect(claude.ctxs.length + codex.ctxs.length).toBe(0)
    })

    it('lets setup and mcp-assist runs start with mismatched roles on the root adapter', async () => {
      const claude = recorder('claude')
      const p = litellm('sonnet', { engineer: 'gpt-5' })
      const { m } = setupManager(p, { claude: claude.adapter })
      await m.start({ project: p, prompt: 'set up', kind: 'setup' })
      await m.start({ project: p, prompt: 'mcp', kind: 'mcp-assist' })
      expect(claude.ctxs.map((c) => c.run.kind)).toEqual(['setup', 'mcp-assist'])
      await m.stopAll()
    })

    it('reports a missing adapter and passes the catalog to the choice', async () => {
      const codex = recorder('codex')
      const p = litellm('gpt-5')
      const catalog = vi.fn(() => [{ id: 'gpt-5', label: 'g', connection: 'litellm' as const, family: 'claude' as const, adapter: 'claude' as const, source: 'builtin' as const }])
      const { m } = setupManager(p, { codex: codex.adapter }, { catalog })
      // the catalog says gpt-5 is a Claude-family model here, so the Claude adapter is needed and absent
      await expect(m.start({ project: p, prompt: 'go' })).rejects.toThrow('No runtime adapter for provider "claude"')
      expect(catalog).toHaveBeenCalled()
    })

    it('hands the resolved connection to the adapter, and a failure refuses the start', async () => {
      const claude = recorder('claude')
      const p = litellm('sonnet')
      const connection = { connection: 'litellm' as const, adapter: 'claude' as const, env: { ANTHROPIC_BASE_URL: 'http://proxy' } }
      const resolveConnection = vi.fn(() => connection)
      const { m } = setupManager(p, { claude: claude.adapter }, { resolveConnection })
      await m.start({ project: p, prompt: 'go' })
      expect(claude.ctxs[0].connection).toBe(connection)
      expect(resolveConnection).toHaveBeenCalledWith(p, expect.objectContaining({ adapter: 'claude', connection: 'litellm', mismatched: [] }))
      const before = m['store'].list(p.id).length
      const failing = setupManager(p, { claude: claude.adapter }, { resolveConnection: () => { throw new Error('LiteLLM is not connected') } })
      await expect(failing.m.start({ project: p, prompt: 'go' })).rejects.toThrow('LiteLLM is not connected')
      expect(failing.store.list(p.id)).toHaveLength(before)
      await m.stopAll()
    })
  })

  describe('mcp-assist runs', () => {
    it('use the built-in assistant role and its context, never the project roles', async () => {
      const rec = recorder('mock')
      const p = makeProject({ path: join(dir, 'repo'), brief: 'Orders API', mcpServers: [{ id: 'mcp-1', name: 'github', transport: 'http', url: 'https://x.test', enabled: true, source: 'user', addedAt: '' }] })
      const { m } = setupManager(p, { mock: rec.adapter })
      const run = await m.start({ project: p, prompt: 'Connect GitHub', kind: 'mcp-assist' })
      const ctx = rec.ctxs[0]
      expect(run.kind).toBe('mcp-assist')
      expect(ctx.roles.map((r) => r.slug)).toEqual(['mcp-assistant'])
      expect(ctx.hiddenContext).toContain('Orders API')
      expect(ctx.hiddenContext).toContain('name=github')
      // the assistant manages servers, it does not run them
      expect(ctx.mcpServers!()).toEqual([])
      expect(ctx.plugins!()).toEqual([])
      await m.stopAll()
    })
  })

  describe('request_mcp_install flow', () => {
    const spec = (over: Partial<McpServerSpec> = {}): McpServerSpec => ({
      id: 'mcp-new',
      name: 'github',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'pkg@1.2.3'],
      secretEnv: ['GITHUB_TOKEN'],
      enabled: true,
      source: 'agent',
      addedAt: '',
      ...over
    })
    const SECRET = 'ghp_super_secret_value'

    function withMcp(p: Project) {
      const rec = recorder('mock')
      const mcp = {
        enabledServers: vi.fn((proj: Project) => (proj.mcpServers ?? []).filter((s) => s.enabled)),
        resolve: vi.fn((_pid: string, s: McpServerSpec, extra?: Record<string, string>) => ({ spec: s, env: { ...(s.env ?? {}), ...(extra ?? {}) }, headers: {} })),
        persistInstall: vi.fn((_pid: string, s: McpServerSpec, _secrets: Record<string, string>): Project => ({ ...p, mcpServers: [...(p.mcpServers ?? []), s] })),
        searchRegistry: vi.fn(async () => ({ entries: [] }))
      }
      const { m } = setupManager(p, { mock: rec.adapter }, { mcp })
      return { ...rec, m, mcp }
    }

    async function ask(ctx: RuntimeContext, s: McpServerSpec = spec()) {
      const after = events.length
      const pending = ctx.requestMcpInstall!({ agentId: 'root', reason: 'triage issues', spec: s, requiredSecrets: ['GITHUB_TOKEN'] })
      const req = await waitFor(isType('mcpInstall.request'), after)
      return { pending, req: req.request }
    }

    it('scope run: keeps the server and its secrets in memory only, events carry no secrets', async () => {
      const p = makeProject({ path: join(dir, 'repo') })
      const { m, ctxs, mcp } = withMcp(p)
      const run = await m.start({ project: p, prompt: 'go' })
      const ctx = ctxs[0]
      const { pending, req } = await ask(ctx)
      expect(req).toMatchObject({ runId: run.id, reason: 'triage issues', spec: { name: 'github' } })
      expect(ctx.pendingInteractions()).toBe(1)
      m.answerMcpInstall(run.id, req.id, { approved: true, scope: 'run', secrets: { GITHUB_TOKEN: SECRET, STRAY: 'x' }, note: 'ok' })
      const decision = await pending
      expect(decision).toEqual({ approved: true, scope: 'run', note: 'ok' })
      expect(ctx.pendingInteractions()).toBe(0)
      expect(ctx.mcpServers!().map((s) => s.name)).toEqual(['github'])
      expect(mcp.persistInstall).not.toHaveBeenCalled()
      const resolved = await ctx.resolvedMcpServers!()
      expect(resolved[0].env.GITHUB_TOKEN).toBe(SECRET)
      expect(await ctx.resolveMcpSecrets!('mcp-new')).toEqual({ env: { GITHUB_TOKEN: SECRET }, headers: {} })
      const out = events.find(isType('mcpInstall.resolved'))!
      expect(out.outcome).toEqual({ approved: true, scope: 'run', note: 'ok' })
      expect(JSON.stringify(events)).not.toContain(SECRET)
      expect(JSON.stringify(m.get(run.id))).not.toContain(SECRET)
      await m.stopAll()
      await vi.waitFor(() => expect(m.summaryOf(run.id)).toBeUndefined())
    })

    it('scope project: persists through the MCP service and broadcasts the project', async () => {
      const p = makeProject({ path: join(dir, 'repo') })
      const { m, ctxs, mcp } = withMcp(p)
      const run = await m.start({ project: p, prompt: 'go' })
      const ctx = ctxs[0]
      const { pending, req } = await ask(ctx)
      m.answerMcpInstall(run.id, req.id, { approved: true, scope: 'project', secrets: { GITHUB_TOKEN: SECRET } })
      expect(await pending).toMatchObject({ approved: true, scope: 'project' })
      expect(mcp.persistInstall).toHaveBeenCalledWith(p.id, expect.objectContaining({ name: 'github' }), { GITHUB_TOKEN: SECRET }, 'project')
      expect(events.find(isType('project.updated', (e) => (e.project.mcpServers?.length ?? 0) === 1))).toBeTruthy()
      // the project's server is served through enabledServers, not duplicated as a run server
      expect(ctx.mcpServers!().map((s) => s.id)).toEqual(['mcp-new'])
      expect(JSON.stringify(events)).not.toContain(SECRET)
      await m.stopAll()
    })

    it('uses the spec the user edited and denies an invalid edit with a note', async () => {
      const p = makeProject({ path: join(dir, 'repo') })
      const { m, ctxs } = withMcp(p)
      const run = await m.start({ project: p, prompt: 'go' })
      const ctx = ctxs[0]
      const first = await ask(ctx)
      m.answerMcpInstall(run.id, first.req.id, { approved: true, scope: 'run', spec: spec({ args: ['-y', 'pkg@9.9.9'] }) })
      expect((await first.pending).spec?.args).toEqual(['-y', 'pkg@9.9.9'])
      expect(ctx.mcpServers!()[0].args).toEqual(['-y', 'pkg@9.9.9'])

      const second = await ask(ctx, spec({ id: 'mcp-other', name: 'docs' }))
      m.answerMcpInstall(run.id, second.req.id, { approved: true, scope: 'run', spec: spec({ id: 'mcp-other', name: 'docs', args: ['-y', 'pkg@latest'] }) })
      const denied = await second.pending
      expect(denied.approved).toBe(false)
      expect(denied.note).toMatch(/not pinned/)
      expect(ctx.mcpServers!().map((s) => s.name)).toEqual(['github'])
      await m.stopAll()
    })

    it('a deny passes the note through; unknown or repeated answers are ignored', async () => {
      const p = makeProject({ path: join(dir, 'repo') })
      const { m, ctxs } = withMcp(p)
      const run = await m.start({ project: p, prompt: 'go' })
      const { pending, req } = await ask(ctxs[0])
      m.answerMcpInstall(run.id, 'nope', { approved: true, scope: 'run' })
      m.answerMcpInstall(run.id, req.id, { approved: false, scope: 'run', note: 'use GitLab' })
      m.answerMcpInstall(run.id, req.id, { approved: true, scope: 'run' })
      expect(await pending).toEqual({ approved: false, scope: 'run', note: 'use GitLab' })
      expect(ctxs[0].mcpServers!()).toEqual([])
      await m.stopAll()
    })

    it('a run that ends resolves pending installs as denied', async () => {
      const p = makeProject({ path: join(dir, 'repo') })
      const { m, ctxs, end } = withMcp(p)
      const run = await m.start({ project: p, prompt: 'go' })
      const { pending, req } = await ask(ctxs[0])
      end()
      expect(await pending).toEqual({ approved: false, scope: 'run' })
      const resolved = events.find(isType('mcpInstall.resolved', (e) => e.requestId === req.id))
      expect(resolved?.outcome).toEqual({ approved: false, scope: 'run' })
      await vi.waitFor(() => expect(m.summaryOf(run.id)).toBeUndefined())
    })

    it('exposes project servers and enabled plugins, and the registry search', async () => {
      const server = spec({ id: 'mcp-p', name: 'docs', secretEnv: [] })
      const p = makeProject({
        path: join(dir, 'repo'),
        mcpServers: [server, { ...server, id: 'mcp-off', name: 'off', enabled: false }],
        plugins: [
          { id: 'pl1', name: 'on', path: '/x', enabled: true },
          { id: 'pl2', name: 'off', path: '/y', enabled: false }
        ]
      })
      const { m, ctxs, mcp } = withMcp(p)
      await m.start({ project: p, prompt: 'go' })
      expect(ctxs[0].mcpServers!().map((s) => s.id)).toEqual(['mcp-p'])
      expect(ctxs[0].plugins!().map((x) => x.id)).toEqual(['pl1'])
      await ctxs[0].searchMcpRegistry!({ query: 'x' })
      expect(mcp.searchRegistry).toHaveBeenCalledWith({ query: 'x' })
      expect((await ctxs[0].resolvedMcpServers!()).map((r) => r.spec.id)).toEqual(['mcp-p'])
      await m.stopAll()
    })

    // Security review H1: a renderer-edited install spec is not trusted.
    it('refuses an edit that changes the requested id', async () => {
      const p = makeProject({ path: join(dir, 'repo') })
      const { m, ctxs, mcp } = withMcp(p)
      const run = await m.start({ project: p, prompt: 'go' })
      const { pending, req } = await ask(ctxs[0])
      m.answerMcpInstall(run.id, req.id, { approved: true, scope: 'project', spec: spec({ id: 'mcp-p' }) })
      const d = await pending
      expect(d.approved).toBe(false)
      expect(d.note).toMatch(/keep the requested id/)
      expect(mcp.persistInstall).not.toHaveBeenCalled()
      await m.stopAll()
    })

    it('refuses a requested id that already exists in the project, the library or the run', async () => {
      const existing = spec({ id: 'mcp-p', name: 'docs', secretEnv: [], enabled: false })
      const p = makeProject({ path: join(dir, 'repo'), mcpServers: [existing] })
      const rec = recorder('mock')
      const mcp = {
        enabledServers: vi.fn((proj: Project) => (proj.mcpServers ?? []).filter((s) => s.enabled)),
        resolve: vi.fn((_pid: string, s: McpServerSpec) => ({ spec: s, env: {}, headers: {} })),
        persistInstall: vi.fn((): Project => p),
        searchRegistry: vi.fn(async () => ({ entries: [] })),
        libraryEntries: vi.fn(() => [{ id: 'mcpl_x', name: 'lib', transport: 'stdio' as const, command: 'npx', source: 'user' as const, addedAt: '' }])
      }
      const { m } = setupManager(p, { mock: rec.adapter }, { mcp })
      const run = await m.start({ project: p, prompt: 'go' })
      const ctx = rec.ctxs[0]
      for (const id of ['mcp-p', 'mcpl_x']) {
        const { pending, req } = await ask(ctx, spec({ id, name: `n-${id}`.replace('_', '-') }))
        m.answerMcpInstall(run.id, req.id, { approved: true, scope: 'run' })
        const d = await pending
        expect(d.approved).toBe(false)
        expect(d.note).toMatch(/already exists/)
      }
      const first = await ask(ctx, spec({ id: 'mcp-run', name: 'run-one' }))
      m.answerMcpInstall(run.id, first.req.id, { approved: true, scope: 'run' })
      expect((await first.pending).approved).toBe(true)
      const again = await ask(ctx, spec({ id: 'mcp-run', name: 'run-two' }))
      m.answerMcpInstall(run.id, again.req.id, { approved: true, scope: 'run' })
      expect((await again.pending).note).toMatch(/already exists/)
      expect(mcp.persistInstall).not.toHaveBeenCalled()
      await m.stopAll()
    })

    it('merges only allowlisted edits and strips oauth, libraryId and library source', async () => {
      const p = makeProject({ path: join(dir, 'repo') })
      const { m, ctxs, mcp } = withMcp(p)
      const run = await m.start({ project: p, prompt: 'go' })
      const { pending, req } = await ask(ctxs[0])
      const edit = {
        ...spec({ name: 'gh', description: 'mine', transport: 'http', libraryId: 'mcpl_x', source: 'library', oauth: { tokenEndpoint: 'https://attacker.test/token' } }),
        projectOnly: true
      } as McpServerSpec
      m.answerMcpInstall(run.id, req.id, { approved: true, scope: 'project', spec: edit })
      const d = await pending
      expect(d.approved).toBe(true)
      const saved = mcp.persistInstall.mock.calls[0][1] as McpServerSpec & { projectOnly?: boolean }
      expect(saved).toMatchObject({ id: 'mcp-new', name: 'gh', description: 'mine', transport: 'stdio', source: 'agent' })
      expect(saved.oauth).toBeUndefined()
      expect(saved.libraryId).toBeUndefined()
      expect(saved.projectOnly).toBeUndefined()
      expect(d.spec).toEqual(saved)
      await m.stopAll()
    })

    it('a run-scoped server never reads stored secrets: only the values typed on the card', async () => {
      const p = makeProject({ path: join(dir, 'repo') })
      const { m, ctxs, mcp } = withMcp(p)
      const run = await m.start({ project: p, prompt: 'go' })
      const { pending, req } = await ask(ctxs[0])
      m.answerMcpInstall(run.id, req.id, { approved: true, scope: 'run', secrets: { GITHUB_TOKEN: SECRET } })
      await pending
      mcp.resolve.mockClear()
      const resolved = await ctxs[0].resolvedMcpServers!()
      expect(resolved[0].env).toEqual({ GITHUB_TOKEN: SECRET })
      expect(mcp.resolve).not.toHaveBeenCalled()
      await m.stopAll()
    })

    it('mcp-assist runs cannot request installs (the gap on the harness project)', async () => {
      const p = makeProject({ path: join(dir, 'repo') })
      const { m, ctxs } = withMcp(p)
      await m.start({ project: p, prompt: 'mcp', kind: 'mcp-assist' })
      expect(ctxs[0].requestMcpInstall).toBeUndefined()
      await m.stopAll()
    })
  })
})

describe('request_mcp_install through RunManager and the mock adapter', () => {
  const SECRET = 'ghp_mock_secret_value'
  const installStep = {
    type: 'harness' as const,
    name: 'request_mcp_install',
    args: { reason: 'Triage the issues', manual: { name: 'github', transport: 'stdio', command: 'npx', args: ['-y', 'gh-mcp@1.2.3'], secretEnv: ['GITHUB_TOKEN'] } }
  }
  const script: MockScript = { work: [installStep, { type: 'text', text: 'Done.' }] }

  function withMcp(p: Project) {
    const mcp = {
      enabledServers: vi.fn((proj: Project) => (proj.mcpServers ?? []).filter((s) => s.enabled)),
      resolve: vi.fn((_pid: string, s: McpServerSpec, extra?: Record<string, string>) => ({ spec: s, env: { ...(s.env ?? {}), ...(extra ?? {}) }, headers: {} })),
      persistInstall: vi.fn((_pid: string, s: McpServerSpec, _secrets: Record<string, string>): Project => ({ ...p, mcpServers: [...(p.mcpServers ?? []), s] })),
      searchRegistry: vi.fn(async () => ({ entries: [] }))
    }
    return { ...manager(p, script, { mcp }), mcp }
  }

  async function toolResult(): Promise<string> {
    const hit = await waitFor(isType('transcript', (e) => e.entry.block.kind === 'tool_result'))
    return (hit.entry.block as { kind: 'tool_result'; content: string }).content
  }

  it('approve with scope project: emits the request, persists the server and tells the agent its tool prefix', async () => {
    const p = makeProject({ path: join(dir, 'repo') })
    const { m, mcp } = withMcp(p)
    const run = await m.start({ project: p, prompt: 'go' })
    const { request } = await waitFor(isType('mcpInstall.request'))
    expect(request).toMatchObject({ runId: run.id, agentId: 'root', reason: 'Triage the issues', requiredSecrets: ['GITHUB_TOKEN'], spec: { name: 'github', source: 'agent' } })
    m.answerMcpInstall(run.id, request.id, { approved: true, scope: 'project', secrets: { GITHUB_TOKEN: SECRET } })
    const text = await toolResult()
    expect(text).toMatch(/approved installing github for this project/)
    expect(text).toContain('mcp__github__')
    expect(mcp.persistInstall).toHaveBeenCalledWith(p.id, expect.objectContaining({ name: 'github' }), { GITHUB_TOKEN: SECRET }, 'project')
    expect(events.find(isType('mcpInstall.resolved'))?.outcome).toMatchObject({ approved: true, scope: 'project' })
    expect(JSON.stringify(events)).not.toContain(SECRET)
    await m.stopAll()
  })

  it('deny: nothing is saved and the agent is told to find another route', async () => {
    const p = makeProject({ path: join(dir, 'repo') })
    const { m, mcp } = withMcp(p)
    const run = await m.start({ project: p, prompt: 'go' })
    const { request } = await waitFor(isType('mcpInstall.request'))
    m.answerMcpInstall(run.id, request.id, { approved: false, scope: 'run', note: 'Use the gh CLI instead.' })
    const text = await toolResult()
    expect(text).toMatch(/denied installing this server/)
    expect(text).toContain('Use the gh CLI instead.')
    expect(text).toMatch(/Find another way/)
    expect(mcp.persistInstall).not.toHaveBeenCalled()
    await m.stopAll()
  })
})

describe('sessionChain', () => {
  const r = (id: string, over: Partial<RunSummary> = {}): RunSummary => runSummary({ id, status: 'finished', ...over })

  it('follows resumedFrom links both ways and shared session ids, and ignores other projects', () => {
    const runs = [
      r('a', { sessionId: 's1' }),
      r('b', { sessionId: 's2', resumedFrom: 'a' }), // the provider gave the resumed session a new id
      r('c', { resumedFrom: 'b' }), // a continuation whose init never arrived
      r('d', { sessionId: 's2' }), // shares b's session without a link
      r('x', { sessionId: 's9' }),
      r('other', { projectId: 'p2', sessionId: 's1' })
    ]
    const ids = (from: string): string[] => sessionChain(runs, runs.find((x) => x.id === from)!).map((x) => x.id).sort()
    expect(ids('a')).toEqual(['a', 'b', 'c', 'd'])
    expect(ids('c')).toEqual(['a', 'b', 'c', 'd'])
    expect(ids('x')).toEqual(['x'])
  })

  it('survives resumedFrom cycles and dangling links', () => {
    const runs = [r('a', { resumedFrom: 'b' }), r('b', { resumedFrom: 'a' }), r('c', { resumedFrom: 'gone' })]
    expect(sessionChain(runs, runs[0]).map((x) => x.id).sort()).toEqual(['a', 'b'])
    expect(sessionChain(runs, runs[2]).map((x) => x.id)).toEqual(['c'])
  })
})

describe('RunManager session chains', () => {
  it('refuses a second continuation while one is live, and continues from the newest run once it ended', async () => {
    const p = makeProject({ path: join(dir, 'repo') })
    const { m } = manager(p, { work: [{ type: 'text', text: 'ok' }] })
    const run = await m.start({ project: p, prompt: 'First job' })
    await waitFor(isType('run.status', (e) => e.runId === run.id && e.status === 'idle'))
    await m.stop(run.id)
    await vi.waitFor(() => expect(m.summaryOf(run.id)).toBeUndefined())
    const sessionId = m.summary(run.id)?.sessionId
    expect(sessionId).toBeTruthy()

    const next = await m.continueRun(p, run.id, 'Second message, which is long enough that the excerpt has to cut it short somewhere')
    // Refused at once, whether or not the continuation's init has arrived.
    const refusal = m.continueRun(p, run.id, 'Again')
    await expect(refusal).rejects.toThrow(/^Session already open: run run_[A-Za-z0-9_-]+ \("Second message/)
    await expect(refusal).rejects.toThrow(`run ${next.id} (`)
    await expect(refusal).rejects.toThrow(/reply there instead\.$/)
    await waitFor(isType('run.status', (e) => e.runId === next.id && e.status === 'idle'))
    await expect(m.continueRun(p, next.id, 'x')).rejects.toThrow('Run is still active')
    await expect(m.continueRun(p, run.id, 'Again')).rejects.toThrow(`Session already open: run ${next.id} `)
    const message = await m.continueRun(p, run.id, 'Again').then(
      () => '',
      (e: Error) => e.message
    )
    expect(/run (run_[A-Za-z0-9_-]+)/.exec(message)?.[1]).toBe(next.id)

    await m.stop(next.id)
    await vi.waitFor(() => expect(m.summaryOf(next.id)).toBeUndefined())
    const seen = events.length
    const third = await m.continueRun(p, run.id, 'Third')
    expect(third.resumedFrom).toBe(next.id)
    const init = await waitFor(isType('run.status', (e) => e.runId === third.id && !!e.sessionId), seen)
    expect(init.sessionId).toBe(sessionId)
    const notice = await waitFor(isType('log', (e) => e.runId === third.id && e.message.includes('newest run of this session')), seen)
    expect(notice.level).toBe('info')
    expect(notice.message).toContain(next.id)
    expect(notice.message).toContain(run.id)
    await m.stopAll()
  })

  it('resumes the newest run of the chain when the provider changed the session id, and hands over a paused newest run', async () => {
    const ctxs: RuntimeContext[] = []
    const adapter: RuntimeAdapter = {
      id: 'mock',
      complete: async () => '',
      start: async (ctx) => {
        ctxs.push(ctx)
        ctx.emit({ type: 'run.status', runId: ctx.run.id, status: 'running', sessionId: `s-${ctxs.length}` })
        ctx.emit({ type: 'run.status', runId: ctx.run.id, status: 'finished' })
        return { send: async () => {}, interrupt: async () => {}, stop: async () => {}, finished: Promise.resolve() }
      }
    }
    const p = makeProject({ path: join(dir, 'repo') })
    const store = new RunStore(join(dir, 'data'))
    const m = new RunManager({ mock: adapter }, (e) => events.push(e), store, fakeSetup(p).service, () => 100)
    const first = await m.start({ project: p, prompt: 'one' })
    const second = await m.continueRun(p, first.id, 'two')
    expect(ctxs[1].resumeSessionId).toBe('s-1')
    await vi.waitFor(() => expect(m.summaryOf(second.id)).toBeUndefined())
    store.upsert({ ...store.get(second.id)!, status: 'paused', autoResume: true, pausedUntil: Date.now() + 60_000 })
    const third = await m.continueRun(p, first.id, 'three')
    expect(third.resumedFrom).toBe(second.id)
    expect(ctxs[2].resumeSessionId).toBe('s-2')
    expect(store.get(second.id)).toMatchObject({ status: 'finished', autoResume: false })
  })

  it('continues a run that ended with the app (finished, session kept) from its own session', async () => {
    const p = makeProject({ path: join(dir, 'repo') })
    const { m, store } = manager(p, { work: [{ type: 'text', text: 'ok' }] })
    const run = await m.start({ project: p, prompt: 'Cut short' })
    await waitFor(isType('run.status', (e) => e.runId === run.id && e.status === 'idle'))
    await m.stop(run.id)
    await vi.waitFor(() => expect(m.summaryOf(run.id)).toBeUndefined())
    const sessionId = m.summary(run.id)?.sessionId
    expect(sessionId).toBeTruthy()
    store.upsert({ ...store.get(run.id)!, status: 'finished', endedWithApp: true })
    const next = await m.continueRun(p, run.id, 'Pick up where we left off')
    expect(next.resumedFrom).toBe(run.id)
    await m.stopAll()
  })

  it('leaves a paused run untouched when the continuation is refused because the session is open', async () => {
    const p = makeProject({ path: join(dir, 'repo') })
    const { m, store } = manager(p, { work: [{ type: 'text', text: 'ok' }] })
    const run = await m.start({ project: p, prompt: 'First' })
    await waitFor(isType('run.status', (e) => e.runId === run.id && e.status === 'idle'))
    await m.stop(run.id)
    await vi.waitFor(() => expect(m.summaryOf(run.id)).toBeUndefined())
    const next = await m.continueRun(p, run.id, 'Second')
    store.upsert({ ...store.get(run.id)!, status: 'paused', autoResume: true, pausedUntil: Date.now() + 60_000 })
    await expect(m.continueRun(p, run.id, 'Third')).rejects.toThrow(`Session already open: run ${next.id} `)
    // The guard runs before the hand-over, so the refused paused run keeps autoResume (it does NOT end with false).
    expect(store.get(run.id)).toMatchObject({ status: 'paused', autoResume: true })
    await m.stopAll()
  })

  it('does not treat a live run of another session as holding this one', async () => {
    const p = makeProject({ path: join(dir, 'repo') })
    const { m } = manager(p, { work: [{ type: 'text', text: 'ok' }] })
    const a = await m.start({ project: p, prompt: 'A' })
    await waitFor(isType('run.status', (e) => e.runId === a.id && e.status === 'idle'))
    await m.stop(a.id)
    await vi.waitFor(() => expect(m.summaryOf(a.id)).toBeUndefined())
    const b = await m.start({ project: p, prompt: 'B' })
    await waitFor(isType('run.status', (e) => e.runId === b.id && e.status === 'idle'))
    const next = await m.continueRun(p, a.id, 'more A')
    expect(next.resumedFrom).toBe(a.id)
    await m.stopAll()
  })
})

/** A MockAdapter that remembers each run's RuntimeContext and session. */
class CapturingAdapter extends MockAdapter {
  readonly ctxs = new Map<string, RuntimeContext>()
  readonly bySession = new Map<string, MockSession>()
  override async start(ctx: RuntimeContext): Promise<RuntimeSession> {
    this.ctxs.set(ctx.run.id, ctx)
    const session = await super.start(ctx)
    this.bySession.set(ctx.run.id, session as MockSession)
    return session
  }
}

/** `projects`: the saved projects RunManager resolves (resolveProject), so tests can flip settings mid-run. */
function multiManager(script: MockScript = {}, projects?: Map<string, Project>) {
  const setup = fakeSetup(makeProject())
  const store = new RunStore(join(dir, 'data'))
  const adapter = new CapturingAdapter({ script: { delayMs: 0, ...script } })
  const m = new RunManager({ mock: adapter }, (e) => events.push(e), store, setup.service, () => 100, projects ? { resolveProject: (id) => projects.get(id) } : {})
  const tool = (runId: string, name: string, args?: unknown): Promise<string> => {
    const t = harnessToolsFor(adapter.ctxs.get(runId)!).find((x) => x.name === name)!
    return t.call(args)
  }
  return { m, store, adapter, tool }
}

describe('concurrent runs', () => {
  const ask: MockScript = { work: [{ type: 'tool', name: 'Bash', input: { command: 'ls' }, ask: true }] }

  it('runs three work runs at once across two projects with independent permission cards', async () => {
    const pa = makeProject({ id: 'pa', name: 'Alpha', path: join(dir, 'a') })
    const pb = makeProject({ id: 'pb', name: 'Beta', path: join(dir, 'b') })
    const { m } = multiManager(ask)
    const a1 = await m.start({ project: pa, prompt: 'A one' })
    const a2 = await m.start({ project: pa, prompt: 'A two' })
    const b1 = await m.start({ project: pb, prompt: 'B one' })
    const ids = [a1.id, a2.id, b1.id]
    const cards = new Map<string, string>()
    for (const id of ids) {
      const req = await waitFor(isType('permission.request', (e) => e.runId === id))
      cards.set(id, req.request.id)
    }
    expect(m.liveRuns().map((r) => r.id).sort()).toEqual([...ids].sort())
    expect(m.liveRunCount()).toBe(3)
    for (const id of ids) expect(events.filter(isType('transcript', (e) => e.runId === id && e.entry.block.kind === 'user'))).toHaveLength(1)

    // Deciding one card leaves the others pending.
    m.decide(a1.id, cards.get(a1.id)!, { behavior: 'allow' })
    await waitFor(isType('permission.resolved', (e) => e.runId === a1.id))
    expect(events.some((e) => e.type === 'permission.resolved' && e.runId !== a1.id)).toBe(false)
    m.decide(b1.id, cards.get(b1.id)!, { behavior: 'deny', message: 'no' })
    await waitFor(isType('permission.resolved', (e) => e.runId === b1.id))
    expect(events.some((e) => e.type === 'permission.resolved' && e.runId === a2.id)).toBe(false)

    // Stopping one run leaves the other two live.
    await m.stop(a2.id)
    await vi.waitFor(() => expect(m.summaryOf(a2.id)).toBeUndefined())
    expect(m.liveRuns().map((r) => r.id).sort()).toEqual([a1.id, b1.id].sort())
    await m.stopAll()
  })

  it('removes a run whose adapter fails to start from the live runs', async () => {
    const p = makeProject({ path: join(dir, 'repo') })
    const store = new RunStore(join(dir, 'data'))
    const failing = { start: async () => Promise.reject(new Error('no binary')) } as unknown as RuntimeAdapter
    const m = new RunManager({ mock: failing }, (e) => events.push(e), store, fakeSetup(p).service, () => 100)
    const run = await m.start({ project: p, prompt: 'x' })
    expect(m.liveRunCount()).toBe(0)
    expect(m.liveRuns()).toEqual([])
    expect(m.summary(run.id)).toMatchObject({ status: 'error', error: 'no binary' })
  })

  it('keeps summary.status current through send() and stop()', async () => {
    const p = makeProject({ path: join(dir, 'repo') })
    const { m } = manager(p, { work: [{ type: 'text', text: 'ok' }] })
    const run = await m.start({ project: p, prompt: 'x' })
    await waitFor(isType('run.status', (e) => e.status === 'idle'))
    expect(m.liveRuns()[0].status).toBe('idle')
    const sent = m.send(run.id, 'more')
    expect(m.liveRuns()[0].status).toBe('running')
    await sent
    const stopped = m.stop(run.id)
    expect(m.summaryOf(run.id)?.status).toBe('stopping')
    await stopped
    await vi.waitFor(() => expect(m.summaryOf(run.id)).toBeUndefined())
  })
})

describe('cross-run messaging', () => {
  const idleScript: MockScript = { work: [{ type: 'text', text: 'working' }], setup: [{ type: 'text', text: 'asking' }] }
  const idle = (id: string) => waitFor(isType('run.status', (e) => e.runId === id && e.status === 'idle'))

  /** Runs a (project Alpha) and b (project Beta); both projects have runMessaging on unless told otherwise. */
  async function two(messaging: { pa?: boolean; pb?: boolean } = {}) {
    const pa = makeProject({ id: 'pa', name: 'Alpha', path: join(dir, 'a'), runMessaging: messaging.pa ?? true })
    const pb = makeProject({ id: 'pb', name: 'Beta', path: join(dir, 'b'), runMessaging: messaging.pb ?? true })
    const projects = new Map<string, Project>([
      [pa.id, pa],
      [pb.id, pb]
    ])
    const h = multiManager(idleScript, projects)
    const a = await h.m.start({ project: pa, prompt: 'Build\nthe API' })
    const b = await h.m.start({ project: pb, prompt: 'Build the UI' })
    await idle(a.id)
    await idle(b.id)
    return { ...h, projects, pa, pb, a, b }
  }

  it('delivers a message, emits run.message on both runs and records transcript blocks', async () => {
    const { m, adapter, tool, a, b } = await two()
    const out = await tool(a.id, 'message_run', { runId: b.id, message: '  I am editing src/api.ts  ' })
    expect(out).toMatch(/^DELIVERED/)
    const sentMsg = events.find(isType('run.message', (e) => e.runId === a.id))!
    expect(sentMsg).toMatchObject({ direction: 'out', peerRunId: b.id, peerProjectId: 'pb', peerProjectName: 'Beta', peerPrompt: 'Build the UI', text: 'I am editing src/api.ts' })
    const gotMsg = events.find(isType('run.message', (e) => e.runId === b.id))!
    expect(gotMsg).toMatchObject({ direction: 'in', peerRunId: a.id, peerProjectId: 'pa', peerProjectName: 'Alpha', peerPrompt: 'Build the API' })

    const session = adapter.bySession.get(b.id)!
    expect(session.peerMessages).toEqual([{ fromRunId: a.id, fromProjectName: 'Alpha', fromPrompt: 'Build the API', text: 'I am editing src/api.ts' }])
    expect(session.harnessMessages).toHaveLength(1)

    const sysTexts = (id: string): string[] => m.get(id)!.transcript.filter((t) => t.block.kind === 'system').map((t) => (t.block as { text: string }).text)
    expect(sysTexts(a.id)).toContain(`Sent to run ${b.id} (Beta: Build the UI): I am editing src/api.ts`)
    expect(sysTexts(b.id)).toContain(`Note from run ${a.id} (Alpha: Build the API), from its orchestrator: I am editing src/api.ts`)

    await m.stopAll()
    await vi.waitFor(() => expect(m.liveRunCount()).toBe(0))
    expect(sysTexts(a.id).some((t) => t.startsWith('Sent to run'))).toBe(true)
    expect(sysTexts(b.id).some((t) => t.startsWith('Note from run'))).toBe(true)
    // The receiver's row never looks like the user typed it.
    expect(m.get(b.id)!.transcript.filter((t) => t.block.kind === 'user').map((t) => (t.block as { text: string }).text)).not.toContain('I am editing src/api.ts')
  })

  it('answers not-found, not-live and refused', async () => {
    const { m, tool, a, b, pa } = await two()
    expect(await tool(a.id, 'message_run', { runId: 'run-nope', message: 'hi' })).toMatch(/^NOT FOUND/)
    expect(await tool(a.id, 'message_run', { runId: a.id, message: 'hi' })).toMatch(/^REFUSED/)
    const s = await m.start({ project: pa, prompt: 'setup', kind: 'setup' })
    expect(await tool(a.id, 'message_run', { runId: s.id, message: 'hi' })).toMatch(/^REFUSED/)
    await m.stop(b.id)
    await vi.waitFor(() => expect(m.summaryOf(b.id)).toBeUndefined())
    expect(await tool(a.id, 'message_run', { runId: b.id, message: 'hi' })).toMatch(/^NOT LIVE/)
    await m.stopAll()
  })

  it('refuses a setup-like sender and an empty message', async () => {
    const { m, adapter, a, b, pa } = await two()
    const s = await m.start({ project: pa, prompt: 'setup', kind: 'setup' })
    const ctxS = adapter.ctxs.get(s.id)!
    expect(await ctxS.messageRun!(a.id, 'hi')).toEqual({ result: 'refused', refusal: 'not-work' })
    expect(ctxS.listRuns!()).toEqual([])
    expect(await adapter.ctxs.get(a.id)!.messageRun!(b.id, '   ')).toEqual({ result: 'refused', refusal: 'empty' })
    await m.stopAll()
  })

  it('list_runs excludes the caller and setup runs and includes other projects', async () => {
    const { m, tool, a, b, pa } = await two()
    await m.start({ project: pa, prompt: 'setup', kind: 'setup' })
    const out = await tool(a.id, 'list_runs')
    const rows = out.split('\n').filter((l) => l.startsWith(b.id))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toContain(b.id)
    expect(rows[0]).toContain('Beta')
    expect(rows[0]).toContain('Build the UI')
    expect(out).not.toContain(a.id)
    await m.stopAll()
  })

  it('caps each direction of a run pair', async () => {
    const { m, tool, a, b, pa } = await two()
    const c = await m.start({ project: pa, prompt: 'Third run' })
    await idle(c.id)
    for (let i = 0; i < RUN_MESSAGE_LIMIT; i++) expect(await tool(a.id, 'message_run', { runId: b.id, message: `m${i}` })).toMatch(/^DELIVERED/)
    expect(await tool(a.id, 'message_run', { runId: b.id, message: 'one more' })).toMatch(/^REFUSED: message cap reached.*report to the user/)
    // The other direction, and another pair, have their own budgets.
    expect(await tool(b.id, 'message_run', { runId: a.id, message: 'reply' })).toMatch(/^DELIVERED/)
    expect(await tool(a.id, 'message_run', { runId: c.id, message: 'hi c' })).toMatch(/^DELIVERED/)
    await m.stopAll()
  })

  it('is opt-in per project: both projects must allow it, and the refusal names the one that does not', async () => {
    const { m, adapter, tool, a, b, projects, pa, pb } = await two({ pb: false })
    const out = await tool(a.id, 'message_run', { runId: b.id, message: 'hi' })
    expect(out).toMatch(/^REFUSED: cross-run messaging is off for "Beta"\./)
    expect(out).toContain('"Let runs message each other" in Project settings')
    expect(await adapter.ctxs.get(b.id)!.messageRun!(a.id, 'hi')).toEqual({ result: 'refused', refusal: 'messaging-off', offProjects: ['Beta'] })
    expect(adapter.bySession.get(b.id)!.peerMessages).toEqual([])
    expect(events.filter(isType('run.message'))).toEqual([])
    // list_runs still shows the run, with its messaging flag.
    const row = (await tool(a.id, 'list_runs')).split('\n').find((l) => l.startsWith(b.id))
    expect(row).toContain('| off |')
    // A project that did not opt in does not reveal its prompt, and does not read others' either.
    expect(row).toContain('(hidden: messaging is off)')
    expect(row).not.toContain('Build the UI')
    expect(adapter.ctxs.get(b.id)!.listRuns!().map((p) => p.prompt)).toEqual([''])
    // Turning it on in the saved project applies to the live runs at once.
    projects.set(pb.id, { ...pb, runMessaging: true })
    expect(await tool(a.id, 'message_run', { runId: b.id, message: 'hi' })).toMatch(/^DELIVERED/)
    // Both off: both are named.
    projects.set(pa.id, { ...pa, runMessaging: false })
    projects.set(pb.id, { ...pb, runMessaging: false })
    expect(await adapter.ctxs.get(a.id)!.messageRun!(b.id, 'hi')).toEqual({ result: 'refused', refusal: 'messaging-off', offProjects: ['Alpha', 'Beta'] })
    // An ended run answers not-live without naming its project.
    projects.set(pa.id, { ...pa, runMessaging: true })
    await m.stop(b.id)
    await vi.waitFor(() => expect(m.summaryOf(b.id)).toBeUndefined())
    expect(await adapter.ctxs.get(a.id)!.messageRun!(b.id, 'hi')).toEqual({ result: 'not-live' })
    await m.stopAll()
  })

  it('needs only the shared flag within one project, and defaults to off', async () => {
    const pa = makeProject({ id: 'pa', name: 'Alpha', path: join(dir, 'a') })
    const projects = new Map<string, Project>([[pa.id, pa]])
    const { m, tool } = multiManager(idleScript, projects)
    const a1 = await m.start({ project: pa, prompt: 'one' })
    const a2 = await m.start({ project: pa, prompt: 'two' })
    await idle(a1.id)
    await idle(a2.id)
    expect(await tool(a1.id, 'message_run', { runId: a2.id, message: 'hi' })).toMatch(/^REFUSED: cross-run messaging is off for "Alpha"\./)
    projects.set(pa.id, { ...pa, runMessaging: true })
    expect(await tool(a1.id, 'message_run', { runId: a2.id, message: 'hi' })).toMatch(/^DELIVERED/)
    await m.stopAll()
  })

  describe('a peer never overrides the user', () => {
    const inFor = (id: string) => events.filter(isType('run.message', (e) => e.runId === id && e.direction === 'in'))
    const sysTexts = (m: RunManager, id: string): string[] => m.get(id)!.transcript.filter((t) => t.block.kind === 'system').map((t) => (t.block as { text: string }).text)

    it('delivers to a run that is not waiting on its user at once', async () => {
      const { m, adapter, tool, a, b } = await two()
      expect(await tool(a.id, 'message_run', { runId: b.id, message: 'now' })).toMatch(/^DELIVERED/)
      expect(adapter.bySession.get(b.id)!.peerMessages.map((p) => p.text)).toEqual(['now'])
      expect(inFor(b.id)).toHaveLength(1)
      await m.stopAll()
    })

    it('queues a message for an interrupted run and delivers it after the user speaks', async () => {
      const { m, adapter, tool, a, b } = await two()
      await m.interrupt(b.id)
      const out = await tool(a.id, 'message_run', { runId: b.id, message: 'heads up' })
      expect(out).toBe(`QUEUED: run ${b.id} is waiting on its user; delivered when it resumes. Continue your own work and do not resend it.`)
      const session = adapter.bySession.get(b.id)!
      expect(session.peerMessages).toEqual([])
      expect(session.harnessMessages).toEqual([])
      // The sender's side is recorded at send time and says it was queued; the receiver's only at delivery.
      expect(events.filter(isType('run.message', (e) => e.runId === a.id && e.direction === 'out'))).toHaveLength(1)
      expect(sysTexts(m, a.id).some((t) => t.startsWith(`Queued for run ${b.id}`) && t.endsWith('heads up'))).toBe(true)
      expect(inFor(b.id)).toEqual([])
      expect(sysTexts(m, b.id).some((t) => t.startsWith('Note from run'))).toBe(false)

      const before = events.length
      await m.send(b.id, 'carry on')
      await vi.waitFor(() => expect(session.peerMessages.map((p) => p.text)).toEqual(['heads up']))
      expect(inFor(b.id)).toHaveLength(1)
      // The user's message comes first.
      const userAt = events.findIndex((e, i) => i >= before && e.type === 'transcript' && e.runId === b.id && e.entry.block.kind === 'user')
      const inAt = events.findIndex((e, i) => i >= before && e.type === 'run.message' && e.runId === b.id)
      expect(userAt).toBeGreaterThanOrEqual(0)
      expect(inAt).toBeGreaterThan(userAt)
      // Not held any more: the next message goes straight through.
      await idle(b.id)
      expect(await tool(a.id, 'message_run', { runId: b.id, message: 'again' })).toMatch(/^DELIVERED/)
      await m.stopAll()
    })

    it('queues a message for a run with a pending permission card and delivers it once decided', async () => {
      const pa = makeProject({ id: 'pa', name: 'Alpha', path: join(dir, 'a'), runMessaging: true })
      const pb = makeProject({ id: 'pb', name: 'Beta', path: join(dir, 'b'), runMessaging: true })
      const projects = new Map<string, Project>([
        [pa.id, pa],
        [pb.id, pb]
      ])
      const { m, adapter, tool } = multiManager({ work: [{ type: 'tool', name: 'Bash', input: { command: 'ls' }, ask: true }] }, projects)
      const a = await m.start({ project: pa, prompt: 'A' })
      const b = await m.start({ project: pb, prompt: 'B' })
      const card = await waitFor(isType('permission.request', (e) => e.runId === b.id))
      await waitFor(isType('permission.request', (e) => e.runId === a.id))
      // The sender's own pending card does not stop it from sending.
      expect(await tool(a.id, 'message_run', { runId: b.id, message: 'wait for me' })).toMatch(/^QUEUED/)
      const session = adapter.bySession.get(b.id)!
      expect(session.peerMessages).toEqual([])
      expect(inFor(b.id)).toEqual([])
      m.decide(b.id, card.request.id, { behavior: 'allow' })
      await vi.waitFor(() => expect(session.peerMessages.map((p) => p.text)).toEqual(['wait for me']))
      expect(inFor(b.id)).toHaveLength(1)
      await m.stopAll()
    })

    it('refuses as busy beyond the queue limit and drops held messages when the run ends', async () => {
      const { m, adapter, tool, a, b } = await two()
      await m.interrupt(b.id)
      for (let i = 0; i < RUN_MESSAGE_QUEUE_LIMIT; i++) expect(await tool(a.id, 'message_run', { runId: b.id, message: `q${i}` })).toMatch(/^QUEUED/)
      expect(await adapter.ctxs.get(a.id)!.messageRun!(b.id, 'one more')).toEqual({ result: 'refused', refusal: 'busy' })
      expect(await tool(a.id, 'message_run', { runId: b.id, message: 'one more' })).toMatch(/^REFUSED: busy/)
      await m.stop(b.id)
      await vi.waitFor(() => expect(m.summaryOf(b.id)).toBeUndefined())
      expect(adapter.bySession.get(b.id)!.peerMessages).toEqual([])
      const warns = events.filter(isType('log', (e) => e.level === 'warn'))
      expect(warns.some((e) => e.runId === b.id && e.message.startsWith(`${RUN_MESSAGE_QUEUE_LIMIT} held messages`))).toBe(true)
      expect(warns.filter((e) => e.runId === a.id && e.message.startsWith('Your queued message'))).toHaveLength(RUN_MESSAGE_QUEUE_LIMIT)
      await m.stopAll()
    })

    it('keeps held messages in order when a direct message arrives mid-flush', async () => {
      const { m, adapter, a, b } = await two()
      const ctx = adapter.ctxs.get(a.id)!
      await m.interrupt(b.id)
      for (const t of ['q1', 'q2', 'q3']) expect(await ctx.messageRun!(b.id, t)).toEqual({ result: 'queued' })
      const session = adapter.bySession.get(b.id)!
      const original = session.receive!.bind(session)
      const done: string[] = []
      let q4: Promise<unknown> | undefined
      session.receive = async (msg) => {
        // The inbox is empty while q3 is in flight, so q4 takes the direct path during this flush.
        if (msg.text === 'q3') q4 = ctx.messageRun!(b.id, 'q4')
        await new Promise((r) => setTimeout(r, msg.text === 'q3' ? 40 : 5))
        done.push(msg.text)
        return original(msg)
      }
      // send() does not wait on the flush it starts.
      await m.send(b.id, 'carry on')
      await vi.waitFor(() => expect(q4).toBeDefined())
      expect(await q4).toEqual({ result: 'delivered' })
      expect(done).toEqual(['q1', 'q2', 'q3', 'q4'])
      expect(session.peerMessages.map((p) => p.text)).toEqual(['q1', 'q2', 'q3', 'q4'])
      await m.stopAll()
    })

    it('holds messages after a usage-limit report until the user sends again', async () => {
      const { m, adapter, a, b } = await two()
      const ctx = adapter.ctxs.get(a.id)!
      adapter.ctxs.get(b.id)!.rateLimited({ window: 'five_hour' })
      expect(await ctx.messageRun!(b.id, 'limited')).toEqual({ result: 'queued' })
      const session = adapter.bySession.get(b.id)!
      expect(session.peerMessages).toEqual([])
      await m.send(b.id, 'try again')
      await vi.waitFor(() => expect(session.peerMessages.map((p) => p.text)).toEqual(['limited']))
      // The hold lifted: the next message goes straight through.
      await idle(b.id)
      expect(await ctx.messageRun!(b.id, 'after')).toEqual({ result: 'delivered' })
      await m.stopAll()
    })

    describe('a receive that never settles', () => {
      afterEach(() => {
        vi.useRealTimers()
      })

      /** Make b's session hang forever on the message `stuck`; every other message goes through. */
      function hangOn(session: MockSession, stuck: string): void {
        const original = session.receive!.bind(session)
        session.receive = (msg) => (msg.text === stuck ? new Promise<void>(() => undefined) : original(msg))
      }
      const warnsFor = (id: string) => events.filter(isType('log', (e) => e.runId === id && e.level === 'warn')).map((e) => e.message)

      it("never holds up the user's send, and the timeout moves the inbox on", async () => {
        const { m, adapter, a, b } = await two()
        const ctx = adapter.ctxs.get(a.id)!
        const session = adapter.bySession.get(b.id)!
        hangOn(session, 'stuck')
        await m.interrupt(b.id)
        expect(await ctx.messageRun!(b.id, 'stuck')).toEqual({ result: 'queued' })
        expect(await ctx.messageRun!(b.id, 'next')).toEqual({ result: 'queued' })
        vi.useFakeTimers({ shouldAdvanceTime: true })
        // Resolves although the flush it started is stuck on the first held message.
        await m.send(b.id, 'carry on')
        expect(session.peerMessages).toEqual([])
        await vi.advanceTimersByTimeAsync(RUN_MESSAGE_RECEIVE_TIMEOUT_MS)
        await vi.waitFor(() => expect(session.peerMessages.map((p) => p.text)).toEqual(['next']))
        expect(warnsFor(a.id).some((w) => w.includes(`Run ${b.id} did not accept the message`))).toBe(true)
        expect(warnsFor(b.id).some((w) => w.includes(`from run ${a.id} did not finish`))).toBe(true)
        await m.stopAll()
      })

      it('refuses a direct sender with timeout and delivers the next message', async () => {
        const { m, adapter, tool, a, b } = await two()
        const ctx = adapter.ctxs.get(a.id)!
        const session = adapter.bySession.get(b.id)!
        hangOn(session, 'stuck')
        vi.useFakeTimers({ shouldAdvanceTime: true })
        const first = tool(a.id, 'message_run', { runId: b.id, message: 'stuck' })
        // Still behind the stuck message, so it waits in the inbox rather than overtaking it.
        expect(await ctx.messageRun!(b.id, 'next')).toEqual({ result: 'queued' })
        await vi.advanceTimersByTimeAsync(RUN_MESSAGE_RECEIVE_TIMEOUT_MS)
        expect(await first).toBe(`REFUSED: run ${b.id} did not accept the message in time; it may be busy. Try again later or report to the user.`)
        await vi.waitFor(() => expect(session.peerMessages.map((p) => p.text)).toEqual(['next']))
        // The chain is free again: a fast receive is delivered at once.
        expect(await ctx.messageRun!(b.id, 'fast')).toEqual({ result: 'delivered' })
        await m.stopAll()
      })

      it('leaves a fast receive alone', async () => {
        const { m, adapter, a, b } = await two()
        const ctx = adapter.ctxs.get(a.id)!
        vi.useFakeTimers({ shouldAdvanceTime: true })
        expect(await ctx.messageRun!(b.id, 'quick')).toEqual({ result: 'delivered' })
        await vi.advanceTimersByTimeAsync(RUN_MESSAGE_RECEIVE_TIMEOUT_MS * 2)
        expect(adapter.bySession.get(b.id)!.peerMessages.map((p) => p.text)).toEqual(['quick'])
        expect([...warnsFor(a.id), ...warnsFor(b.id)].filter((w) => w.includes('did not'))).toEqual([])
        await m.stopAll()
      })
    })

    it('keeps the hold when the user message fails to send', async () => {
      const { m, adapter, a, b } = await two()
      const ctx = adapter.ctxs.get(a.id)!
      const session = adapter.bySession.get(b.id)!
      session.send = async () => {
        throw new Error('send failed')
      }
      await m.interrupt(b.id)
      await expect(m.send(b.id, 'hello')).rejects.toThrow('send failed')
      expect(await ctx.messageRun!(b.id, 'still held')).toEqual({ result: 'queued' })
      adapter.ctxs.get(b.id)!.rateLimited({})
      await expect(m.send(b.id, 'hello again')).rejects.toThrow('send failed')
      expect(await ctx.messageRun!(b.id, 'held too')).toEqual({ result: 'queued' })
      expect(session.peerMessages).toEqual([])
      await m.stopAll()
    })
  })

  it('marks its system rows as harness rows', async () => {
    const { m, a, b, tool } = await two()
    await m.interrupt(b.id)
    expect(await tool(a.id, 'message_run', { runId: b.id, message: 'queued one' })).toMatch(/^QUEUED/)
    await m.send(b.id, 'resume')
    await idle(b.id)
    expect(await tool(a.id, 'message_run', { runId: b.id, message: 'direct one' })).toMatch(/^DELIVERED/)
    const rows = [...m.get(a.id)!.transcript, ...m.get(b.id)!.transcript].filter(
      (t) => t.block.kind === 'system' && /^(Sent to run|Queued for run|Note from run)/.test((t.block as { text: string }).text)
    )
    expect(rows.length).toBeGreaterThanOrEqual(4)
    for (const r of rows) expect(r.source).toBe('harness')
    await m.stopAll()
  })

  it('caps what one run may receive from all runs together', async () => {
    const { m, adapter, tool, a, b, pa } = await two()
    const senders = [a]
    while (senders.length * RUN_MESSAGE_LIMIT < RUN_MESSAGE_INBOUND_LIMIT + RUN_MESSAGE_LIMIT) {
      const r = await m.start({ project: pa, prompt: `sender ${senders.length}` })
      await idle(r.id)
      senders.push(r)
    }
    let sent = 0
    for (const s of senders) {
      for (let i = 0; i < RUN_MESSAGE_LIMIT && sent < RUN_MESSAGE_INBOUND_LIMIT; i++, sent++) {
        expect(await adapter.ctxs.get(s.id)!.messageRun!(b.id, `m${sent}`)).toEqual({ result: 'delivered' })
      }
    }
    const last = senders[senders.length - 1]
    expect(await adapter.ctxs.get(last.id)!.messageRun!(b.id, 'over')).toEqual({ result: 'refused', refusal: 'cap', cap: 'inbound' })
    expect(await tool(last.id, 'message_run', { runId: b.id, message: 'over' })).toMatch(/^REFUSED: message cap reached: that run has taken the most/)
    // The pair cap names itself too.
    expect(await adapter.ctxs.get(a.id)!.messageRun!(b.id, 'over')).toEqual({ result: 'refused', refusal: 'cap', cap: 'pair' })
    // The recipient can still send.
    expect(await tool(b.id, 'message_run', { runId: a.id, message: 'reply' })).toMatch(/^DELIVERED/)
    await m.stopAll()
  })

  it('warns on both runs and answers not-live when receive throws', async () => {
    const { m, adapter, tool, a, b } = await two()
    adapter.bySession.get(b.id)!.receive = async () => {
      throw new Error('boom')
    }
    expect(await tool(a.id, 'message_run', { runId: b.id, message: 'hi' })).toMatch(/^NOT LIVE/)
    expect(events.filter(isType('log', (e) => e.level === 'warn')).map((e) => e.runId).sort()).toEqual([a.id, b.id].sort())
    await m.stopAll()
  })
})

describe('MCP library, OAuth preparation and the harness project', () => {
  const entry = { id: 'mcpl_1', name: 'docs', transport: 'http' as const, url: 'https://docs.test/mcp', source: 'user' as const, addedAt: '2026-01-01T00:00:00.000Z' }
  const oauthSpec = (name: string): McpServerSpec => ({
    id: `id-${name}`,
    name,
    transport: 'http',
    url: `https://${name}.test/mcp`,
    oauth: { clientId: 'c' },
    enabled: true,
    source: 'library',
    addedAt: ''
  })

  function recorder() {
    const ctxs: RuntimeContext[] = []
    const adapter: RuntimeAdapter = {
      id: 'mock',
      complete: async () => '',
      start: async (ctx) => {
        ctxs.push(ctx)
        ctx.emit({ type: 'run.status', runId: ctx.run.id, status: 'running' })
        return { send: async () => {}, interrupt: async () => {}, stop: async () => {}, finished: new Promise<void>(() => {}) }
      }
    }
    return { adapter, ctxs }
  }

  function setupMgr(p: Project, mcp: NonNullable<RunManagerOptions['mcp']>) {
    const rec = recorder()
    const setup = fakeSetup(p)
    const applyLibraryProposal = vi.fn()
    ;(setup.service as unknown as { applyLibraryProposal: typeof applyLibraryProposal }).applyLibraryProposal = applyLibraryProposal
    const m = new RunManager({ mock: rec.adapter }, (e) => events.push(e), new RunStore(join(dir, 'data')), setup.service, () => 100, { mcp })
    return { m, ...rec, setup, applyLibraryProposal }
  }

  const baseMcp = (over: Partial<NonNullable<RunManagerOptions['mcp']>> = {}): NonNullable<RunManagerOptions['mcp']> => ({
    enabledServers: (proj) => (proj.mcpServers ?? []).filter((s) => s.enabled),
    resolve: (_pid, s) => ({ spec: s, env: {}, headers: {} }),
    persistInstall: vi.fn((): Project => makeProject()),
    searchRegistry: vi.fn(async () => ({ entries: [] })),
    ...over
  })

  it('refreshes OAuth servers before resolving and warns once per unauthorized server per run', async () => {
    const p = makeProject({ path: join(dir, 'repo'), mcpServers: [oauthSpec('github'), oauthSpec('docs')] })
    const prepareForRun = vi.fn(async (_pid: string, specs: McpServerSpec[]) => specs.filter((s) => s.name === 'github').map((s) => s.name))
    const { m, ctxs } = setupMgr(p, baseMcp({ prepareForRun }))
    const run = await m.start({ project: p, prompt: 'go' })
    const ctx = ctxs[0]
    await ctx.resolvedMcpServers!()
    await ctx.resolvedMcpServers!()
    await ctx.resolveMcpSecrets!('id-github')
    expect(prepareForRun).toHaveBeenCalledWith(p.id, expect.arrayContaining([expect.objectContaining({ name: 'github' })]))
    const warns = events.filter(isType('log', (e) => e.level === 'warn' && e.runId === run.id))
    expect(warns.map((w) => w.message)).toEqual([
      'MCP server "github" needs authorization: open Settings > MCP servers and choose Authorize. It starts without credentials in this run.'
    ])
    await m.stopAll()
  })

  it('hands the adapter the library-refreshed project', async () => {
    const p = makeProject({ path: join(dir, 'repo'), mcpServers: [oauthSpec('docs')] })
    const withLibrary = vi.fn((proj: Project): Project => ({ ...proj, mcpServers: (proj.mcpServers ?? []).map((s) => ({ ...s, url: 'https://moved.test/mcp' })) }))
    const { m, ctxs } = setupMgr(p, baseMcp({ withLibrary }))
    await m.start({ project: p, prompt: 'go' })
    expect(withLibrary).toHaveBeenCalled()
    expect(ctxs[0].project.mcpServers?.[0].url).toBe('https://moved.test/mcp')
    expect(ctxs[0].mcpServers!()[0].url).toBe('https://moved.test/mcp')
    await m.stopAll()
  })

  it('accepts the harness project for mcp-assist only, with the library in the context', async () => {
    const harness = makeProject({ id: 'harness', name: 'OrgAI', path: join(dir, 'repo'), roles: [] })
    const { m, ctxs, setup, applyLibraryProposal } = setupMgr(harness, baseMcp({ libraryEntries: () => [entry] }))
    await expect(m.start({ project: harness, prompt: 'go' })).rejects.toThrow(/Only the MCP assistant/)
    await expect(m.start({ project: harness, prompt: 'go', kind: 'setup' })).rejects.toThrow(/Only the MCP assistant/)
    expect(ctxs).toHaveLength(0)
    const run = await m.start({ project: harness, prompt: 'Help me', kind: 'mcp-assist' })
    const ctx = ctxs[0]
    expect(ctx.hiddenContext).toContain('app-wide MCP library')
    expect(ctx.hiddenContext).toContain('name=docs id=mcpl_1')
    expect(ctx.mcpLibrary!()).toEqual([entry])
    expect(ctx.mcpServers!()).toEqual([])

    const pending = ctx.requestProposal({ kind: 'mcpServers', agentId: 'root', title: 't', payload: { scope: 'library', upsert: [], rationale: 'r' } })
    const req = await waitFor(isType('proposal.request'))
    m.decideProposal(run.id, req.proposal.id, { behavior: 'approve' })
    expect(await pending).toEqual({ behavior: 'approve' })
    expect(applyLibraryProposal).toHaveBeenCalledWith(expect.objectContaining({ scope: 'library' }))
    expect(setup.raw.applyProposal).not.toHaveBeenCalled()
    expect(events.some((e) => e.type === 'project.updated')).toBe(false)
    await m.stopAll()
  })

  it('a failing library proposal answers REVISE without touching a project', async () => {
    const harness = makeProject({ id: 'harness', path: join(dir, 'repo'), roles: [] })
    const { m, ctxs, applyLibraryProposal } = setupMgr(harness, baseMcp())
    applyLibraryProposal.mockImplementation(() => {
      throw new Error('name clash')
    })
    const run = await m.start({ project: harness, prompt: 'go', kind: 'mcp-assist' })
    const pending = ctxs[0].requestProposal({ kind: 'mcpServers', agentId: 'root', title: 't', payload: { scope: 'library', upsert: [], rationale: 'r' } })
    const req = await waitFor(isType('proposal.request'))
    m.decideProposal(run.id, req.proposal.id, { behavior: 'approve' })
    expect(await pending).toMatchObject({ behavior: 'revise', feedback: expect.stringContaining('name clash') })
    await m.stopAll()
  })

  it('install scope library persists through the MCP service with scope library', async () => {
    const p = makeProject({ path: join(dir, 'repo') })
    const spec: McpServerSpec = { id: 'mcp-new', name: 'github', transport: 'stdio', command: 'npx', args: ['-y', 'gh-mcp@1.2.3'], enabled: true, source: 'agent', addedAt: '' }
    const persistInstall = vi.fn((): Project => ({ ...p, mcpServers: [{ ...spec, source: 'library', libraryId: 'mcpl_9' }] }))
    const { m, ctxs } = setupMgr(p, baseMcp({ persistInstall }))
    const run = await m.start({ project: p, prompt: 'go' })
    const pending = ctxs[0].requestMcpInstall!({ agentId: 'root', reason: 'r', spec, requiredSecrets: [] })
    const req = await waitFor(isType('mcpInstall.request'))
    m.answerMcpInstall(run.id, req.request.id, { approved: true, scope: 'library' })
    expect(await pending).toMatchObject({ approved: true, scope: 'library' })
    expect(persistInstall).toHaveBeenCalledWith(p.id, expect.objectContaining({ name: 'github' }), {}, 'library')
    expect(events.find(isType('mcpInstall.resolved'))?.outcome.scope).toBe('library')
    await m.stopAll()
  })
})

describe('run titles', () => {
  it('a work run on the mock adapter gets run.title and a persisted summary.title', async () => {
    const p = makeProject({ path: join(dir, 'repo') })
    const { m, store } = manager(p)
    const completeSpy = vi.spyOn(MockAdapter.prototype, 'complete')
    const run = await m.start({ project: p, prompt: 'fix the "login" bug, now please' })
    const e = await waitFor(isType('run.title', (x) => x.runId === run.id))
    expect(e.title).toBe('Fix the login bug')
    expect(completeSpy.mock.calls[0][0]).toMatchObject({ kind: 'title' })
    // The mock adapter has no fast model: no model is forced.
    expect(completeSpy.mock.calls[0][0].model).toBeUndefined()
    completeSpy.mockRestore()
    // The title follows the status 'starting' event, never precedes it.
    expect(events.findIndex(isType('run.status'))).toBeLessThan(events.indexOf(e))
    expect(m.summaryOf(run.id)?.title).toBe('Fix the login bug')
    expect(store.get(run.id)?.title).toBe('Fix the login bug')
    await m.stop(run.id)
    await vi.waitFor(() => expect(m.summaryOf(run.id)).toBeUndefined())
    // Survives a reload: runs.json index and the run record.
    const reloaded = new RunStore(join(dir, 'data'))
    expect(reloaded.get(run.id)?.title).toBe('Fix the login bug')
    expect(reloaded.getRecord(run.id)?.summary.title).toBe('Fix the login bug')
    expect(events.filter(isType('run.title'))).toHaveLength(1)
  })

  it('passes the fast model and the run connection to the completion', async () => {
    const p = makeProject({ path: join(dir, 'repo') })
    const connection = { connection: 'litellm' as const, adapter: 'mock' as const, env: { ANTHROPIC_BASE_URL: 'http://proxy' } }
    const fastModel = vi.fn(() => 'proxy-fast')
    const { m } = manager(p, {}, { resolveConnection: () => connection, fastModel })
    const completeSpy = vi.spyOn(MockAdapter.prototype, 'complete')
    const run = await m.start({ project: p, prompt: 'Build the API for the billing service' })
    await waitFor(isType('run.title', (x) => x.runId === run.id))
    expect(fastModel).toHaveBeenCalledWith(expect.objectContaining({ id: p.id }), expect.objectContaining({ adapter: 'mock' }))
    expect(completeSpy.mock.calls[0][0]).toMatchObject({ kind: 'title', model: 'proxy-fast', connection, cwd: expect.any(String) })
    completeSpy.mockRestore()
    await m.stop(run.id)
  })

  it('setup runs and image-only prompts get no title', async () => {
    const p = makeProject({ path: join(dir, 'repo') })
    const { m } = manager(p)
    const completeSpy = vi.spyOn(MockAdapter.prototype, 'complete')
    const setupRun = await m.start({ project: p, prompt: 'Set this project up', kind: 'setup' })
    const imageRun = await m.start({ project: p, prompt: '  ', images: [{ mediaType: 'image/png', data: 'iVBORw0KGgo=', name: 'a.png' }] })
    await sleep(30)
    expect(completeSpy).not.toHaveBeenCalled()
    completeSpy.mockRestore()
    expect(events.some((e) => e.type === 'run.title')).toBe(false)
    expect(m.summaryOf(setupRun.id)?.title).toBeUndefined()
    expect(m.summaryOf(imageRun.id)?.title).toBeUndefined()
    await m.stop(setupRun.id)
    await m.stop(imageRun.id)
  })

  it('an authentication failure ends the run failed with a readable error naming the connection', async () => {
    const p = makeProject({ path: join(dir, 'repo') })
    const connection = { connection: 'litellm' as const, adapter: 'mock' as const }
    const { m } = manager(p, {}, { resolveConnection: () => connection })
    const run = await m.start({ project: p, prompt: 'Do it [mock:auth-fail]' })
    const status = await waitFor(isType('run.status', (e) => e.status === 'error'))
    expect(status.error).toMatch(/^The LiteLLM connection was refused/)
    expect(status.error).toMatch(/Settings > Connections/)
    expect(events.some((e) => e.type === 'permission.request')).toBe(false)
    await sleep(20)
    const record = m.get(run.id)
    expect(record?.summary).toMatchObject({ status: 'error', error: status.error })
    expect(record?.agents[ROOT_AGENT_ID]?.state).toBe('error')
    const blocks = record?.transcript.map((t) => ({ block: t.block, source: t.source })) ?? []
    expect(blocks.some((b) => b.block.kind === 'system' && b.source === 'harness')).toBe(true)
    expect(blocks.some((b) => b.block.kind === 'text' && /Invalid API key/.test((b.block as { text: string }).text))).toBe(false)
  })

  it('a failing completion leaves the run healthy and untitled', async () => {
    const p = makeProject({ path: join(dir, 'repo') })
    const { m } = manager(p)
    const run = await m.start({ project: p, prompt: 'Change x [mock:title-fail]' })
    const req = await waitFor(isType('permission.request'))
    m.decide(run.id, req.request.id, { behavior: 'allow' })
    await waitFor(isType('run.status', (e) => e.status === 'idle'))
    expect(events.some((e) => e.type === 'run.title')).toBe(false)
    expect(m.summaryOf(run.id)?.title).toBeUndefined()
    expect(m.summaryOf(run.id)?.status).toBe('idle')
    await m.stop(run.id)
  })

  it('a title that lands after the run ended is still saved and broadcast', async () => {
    const p = makeProject({ path: join(dir, 'repo') })
    let release!: (t: string) => void
    const adapter: RuntimeAdapter = {
      id: 'mock',
      complete: () => new Promise<string>((r) => (release = r)),
      start: async (ctx) => {
        ctx.emit({ type: 'run.status', runId: ctx.run.id, status: 'running', sessionId: 's-1' })
        ctx.emit({ type: 'run.status', runId: ctx.run.id, status: 'finished' })
        return { send: async () => {}, interrupt: async () => {}, stop: async () => {}, finished: Promise.resolve() }
      }
    }
    const store = new RunStore(join(dir, 'data'))
    const m = new RunManager({ mock: adapter }, (e) => events.push(e), store, fakeSetup(p).service, () => 100)
    const run = await m.start({ project: p, prompt: 'Ship the release' })
    await vi.waitFor(() => expect(m.summaryOf(run.id)).toBeUndefined())
    release('Ship the release notes')
    const e = await waitFor(isType('run.title'))
    expect(e).toEqual({ type: 'run.title', runId: run.id, title: 'Ship the release notes' })
    expect(store.get(run.id)?.title).toBe('Ship the release notes')
    expect(new RunStore(join(dir, 'data')).getRecord(run.id)?.summary.title).toBe('Ship the release notes')
  })

  it('stopping a run aborts its pending title and leaves it untitled', async () => {
    const p = makeProject({ path: join(dir, 'repo') })
    const { m, store } = manager(p)
    const completeSpy = vi.spyOn(MockAdapter.prototype, 'complete')
    const run = await m.start({ project: p, prompt: 'Fix the login bug [mock:title-slow]' })
    expect(completeSpy).toHaveBeenCalledTimes(1)
    const signal = completeSpy.mock.calls[0][0].signal
    completeSpy.mockRestore()
    await m.stop(run.id)
    expect(signal?.aborted).toBe(true)
    await sleep(80)
    expect(events.some((e) => e.type === 'run.title')).toBe(false)
    expect(store.get(run.id)?.title).toBeUndefined()
  })

  it('stopAll aborts a title still pending for a run that already ended', async () => {
    const p = makeProject({ path: join(dir, 'repo') })
    let signal: AbortSignal | undefined
    const adapter: RuntimeAdapter = {
      id: 'mock',
      complete: (i) => {
        signal = i.signal
        return new Promise<string>(() => {})
      },
      start: async (ctx) => {
        ctx.emit({ type: 'run.status', runId: ctx.run.id, status: 'running', sessionId: 's-1' })
        ctx.emit({ type: 'run.status', runId: ctx.run.id, status: 'finished' })
        return { send: async () => {}, interrupt: async () => {}, stop: async () => {}, finished: Promise.resolve() }
      }
    }
    const store = new RunStore(join(dir, 'data'))
    const m = new RunManager({ mock: adapter }, (e) => events.push(e), store, fakeSetup(p).service, () => 100)
    const run = await m.start({ project: p, prompt: 'Ship the release' })
    await vi.waitFor(() => expect(m.summaryOf(run.id)).toBeUndefined())
    expect(signal?.aborted).toBe(false)
    await m.stopAll()
    expect(signal?.aborted).toBe(true)
  })

  it('removing a project aborts a title still pending for one of its ended runs', async () => {
    const p = makeProject({ path: join(dir, 'repo') })
    let signal: AbortSignal | undefined
    const adapter: RuntimeAdapter = {
      id: 'mock',
      complete: (i) => {
        signal = i.signal
        return new Promise<string>(() => {})
      },
      start: async (ctx) => {
        ctx.emit({ type: 'run.status', runId: ctx.run.id, status: 'running', sessionId: 's-1' })
        ctx.emit({ type: 'run.status', runId: ctx.run.id, status: 'finished' })
        return { send: async () => {}, interrupt: async () => {}, stop: async () => {}, finished: Promise.resolve() }
      }
    }
    const store = new RunStore(join(dir, 'data'))
    const m = new RunManager({ mock: adapter }, (e) => events.push(e), store, fakeSetup(p).service, () => 100)
    const run = await m.start({ project: p, prompt: 'Ship the release' })
    await vi.waitFor(() => expect(m.summaryOf(run.id)).toBeUndefined())
    await m.removeProject('some-other-project')
    expect(signal?.aborted).toBe(false)
    await m.removeProject(p.id)
    expect(signal?.aborted).toBe(true)
  })

  it('a title that lands after the project was deleted writes nothing', async () => {
    const p = makeProject({ path: join(dir, 'repo') })
    let release!: (t: string) => void
    const adapter: RuntimeAdapter = {
      id: 'mock',
      complete: () => new Promise<string>((r) => (release = r)),
      start: async (ctx) => {
        ctx.emit({ type: 'run.status', runId: ctx.run.id, status: 'running', sessionId: 's-1' })
        return { send: async () => {}, interrupt: async () => {}, stop: async () => {}, finished: new Promise<void>(() => {}) }
      }
    }
    const store = new RunStore(join(dir, 'data'))
    const m = new RunManager({ mock: adapter }, (e) => events.push(e), store, fakeSetup(p).service, () => 100)
    const run = await m.start({ project: p, prompt: 'Ship the release' })
    await m.removeProject(p.id)
    release('Ship the release notes')
    await sleep(20)
    expect(events.some((e) => e.type === 'run.title')).toBe(false)
    expect(store.get(run.id)).toBeNull()
    expect(new RunStore(join(dir, 'data')).getRecord(run.id)).toBeNull()
  })

  it('a continuation gets its own title; an auto-resume keeps the earlier one', async () => {
    const p = makeProject({ path: join(dir, 'repo') })
    const prompts: string[] = []
    const adapter: RuntimeAdapter = {
      id: 'mock',
      complete: async (input) => {
        prompts.push(input.prompt)
        return `Title ${prompts.length}`
      },
      start: async (ctx) => {
        ctx.emit({ type: 'run.status', runId: ctx.run.id, status: 'running', sessionId: 's-1' })
        ctx.emit({ type: 'run.status', runId: ctx.run.id, status: 'finished' })
        return { send: async () => {}, interrupt: async () => {}, stop: async () => {}, finished: Promise.resolve() }
      }
    }
    const store = new RunStore(join(dir, 'data'))
    const m = new RunManager({ mock: adapter }, (e) => events.push(e), store, fakeSetup(p).service, () => 100)
    const first = await m.start({ project: p, prompt: 'First task' })
    await vi.waitFor(() => expect(store.get(first.id)?.title).toBe('Title 1'))
    const second = await m.continueRun(p, first.id, 'Second task')
    await vi.waitFor(() => expect(store.get(second.id)?.title).toBe('Title 2'))
    // The follow-up is titled with the task it continues as context.
    expect(prompts[0]).not.toContain('This continues the task')
    expect(prompts[1]).toContain('This continues the task: <earlier_task>Title 1</earlier_task>')
    expect(prompts[1]).toContain('<message>\nSecond task\n</message>')
    const resumed = await m.continueRun(p, second.id, RESUME_TEXT)
    expect(resumed.title).toBe('Title 2')
    await sleep(20)
    expect(prompts).toHaveLength(2)
    expect(store.get(second.id)?.title).toBe('Title 2')
  })
})
