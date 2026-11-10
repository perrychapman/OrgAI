import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EXEC_OUTCOMES, EXEC_OUTCOME_EXIT_CODE, type ExecOutcome, type StaffingAssignment, type StaffingSource, type Project, type RunEvent, type RunRecord, type RunsSubscribeResult, type RunSummary, type TranscriptEntry } from '../../shared/types'
import { FakeHostClient, fakeContext, fakeInproc, flush, project, record, summary, type FakeContextOptions } from '../testing/fakeContext'
import { EXIT } from '../types'
const resumeTui = vi.hoisted(() => ({ calls: [] as string[][] }))
vi.mock('./tui', () => ({
  runResumeTui: async (_ctx: unknown, args: string[]) => {
    resumeTui.calls.push(args)
    return 0
  }
}))

import { execIo, lastRootText, overridesFromFlags, runExec, runResume, UNREGISTERED_MESSAGE } from './exec'

const p1 = project('p1', '/work/app', { name: 'App', permissionMode: 'default' } as Partial<Project>)
const RUN = 'run_exec01'
const text = (id: string, t: string, agentId = 'root'): TranscriptEntry => ({ id, agentId, at: 1, block: { kind: 'text', text: t } })
const ev = (seq: number, event: RunEvent) => ({ seq, event })
const started = (extra: Partial<RunSummary> = {}): RunSummary => summary(RUN, { status: 'starting', startedAt: 100, prompt: 'do it', ...extra })

function snapshotOf(rec: RunRecord | undefined, seq = 10, extra: Partial<Extract<RunsSubscribeResult, { mode: 'snapshot' }>['snapshot']> = {}): RunsSubscribeResult {
  return {
    mode: 'snapshot',
    hostInstanceId: 'aaaaaaaaaaaa',
    seq,
    filterKey: 'fk1',
    snapshot: { liveRuns: rec ? [rec.summary] : [], pendingCards: {}, ...(rec ? { activeRun: rec } : {}), recentEndedRuns: [], ...extra }
  }
}

const finalSummary = (outcome: ExecOutcome, extra: Partial<RunSummary> = {}): RunSummary =>
  summary(RUN, { status: outcome === 'rate-limited' ? 'paused' : 'finished', startedAt: 100, execOutcome: outcome, totalCostUsd: 0.25, ...extra })
const finalized = (seq: number, outcome: ExecOutcome, runId = RUN) =>
  ev(seq, { type: 'run.finalized', runId, execChainId: RUN, outcome, summary: { ...finalSummary(outcome), id: runId } })

interface HostOpts {
  answers?: Record<string, (params: unknown) => unknown>
  scopes?: string[]
  rec?: RunRecord
}
function execHost(o: HostOpts = {}): FakeHostClient {
  const rec = o.rec ?? record(started({ status: 'running' }), { transcript: [text('e1', 'Working on it')] })
  return new FakeHostClient(
    {
      'projects:list': () => [p1],
      'runs:list': () => [],
      'runs:start': () => started(),
      'runs:subscribe': () => snapshotOf(rec),
      'runs:get': () => record(finalSummary('completed'), { transcript: [text('e1', 'Working on it'), text('e2', 'All done.')] }),
      'runs:stop': () => undefined,
      ...o.answers
    },
    { hello: { grantedScopes: (o.scopes ?? ['read', 'operate', 'configure']) as never } }
  )
}

const live = (o: FakeContextOptions = {}) => fakeContext({ cwd: '/work/app', store: { hostState: 'ready', projects: [p1] }, ...o })

async function until(fn: () => boolean, what = 'condition'): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (fn()) return
    await flush()
  }
  throw new Error(`timed out waiting for ${what}`)
}
const subscribed = (h: FakeHostClient) => until(() => h.callsOf('runs:subscribe').length > 0, 'runs:subscribe')

const realIo = { ...execIo }
let stdin = ''
beforeEach(() => {
  stdin = ''
  execIo.readStdin = async () => stdin
  execIo.timers = { sleep: () => Promise.resolve(), now: () => Date.now() }
})
afterEach(() => Object.assign(execIo, realIo))

describe('exec flags', () => {
  it('--goal sets overrides.goal for each value; a bad value names the three; absent leaves it out', () => {
    for (const goal of ['balanced', 'speed', 'cost']) expect(overridesFromFlags({ goal })).toEqual({ execMode: true, goal })
    expect(overridesFromFlags({})).not.toHaveProperty('goal')
    expect(() => overridesFromFlags({ goal: 'fast' })).toThrow(expect.objectContaining({ exitCode: EXIT.usage, message: '--goal must be one of balanced, speed, cost.' }))
  })

  it('maps every flag to RunOverrides, always execMode', () => {
    expect(overridesFromFlags({})).toEqual({ execMode: true })
    expect(
      overridesFromFlags({
        'permission-mode': 'plan',
        'no-auto-continue': true,
        'max-auto-continues': '7',
        'max-cost': '1.5',
        'allow-unpriced-budget': true,
        'allow-unmerged': true,
        'allow-peer-messages': true,
        'wait-for-reset': true,
        'stall-timeout': '90',
        'on-permission': 'deny',
        'on-rules': 'fail',
        'on-mcp-install': 'deny',
        'on-question': 'conservative',
        'on-proposal': 'decline',
        'on-merge': 'hold',
        'max-auto-denials': '3'
      })
    ).toEqual({
      execMode: true,
      permissionMode: 'plan',
      autoContinue: false,
      maxAutoContinues: 7,
      maxBudgetUsd: 1.5,
      allowUnpricedBudget: true,
      allowUnmerged: true,
      allowPeerMessages: true,
      waitForReset: true,
      execStallTimeoutMs: 90_000,
      decisionPolicy: { permission: 'deny', rules: 'fail', mcpInstall: 'deny', question: 'conservative', proposal: 'decline', merge: 'hold', maxAutoDenials: 3 }
    })
    expect(overridesFromFlags({ 'max-budget': '0' })).toEqual({ execMode: true, maxBudgetUsd: 0 })
    // The longest timer the host can arm, in whole seconds.
    expect(overridesFromFlags({ 'stall-timeout': '2147483' })).toEqual({ execMode: true, execStallTimeoutMs: 2_147_483_000 })
    // A policy that waits is refused: nothing else can answer an orgai run's cards (cli-standalone-default.md 4.3).
    for (const flag of ['on-permission', 'on-rules', 'on-mcp-install', 'on-question', 'on-proposal', 'on-merge']) {
      expect(() => overridesFromFlags({ [flag]: 'wait' }), flag).toThrow(expect.objectContaining({ exitCode: EXIT.usage, message: expect.stringContaining('wait is not available') }))
    }
    expect(overridesFromFlags({ 'on-question': 'fail' })).toEqual({ execMode: true, decisionPolicy: { question: 'fail' } })
  })

  it.each([
    [['--max-budget', '1', '--max-cost', '2', 'x']],
    [['--max-budget', '-1', 'x']],
    [['--max-budget', 'abc', 'x']],
    [['--max-cost', 'Infinity', 'x']],
    [['--max-auto-continues', '501', 'x']],
    [['--max-auto-continues', '1.5', 'x']],
    [['--stall-timeout', '0', 'x']],
    // Above 2^31 - 1 ms a host timer would fire after 1 ms.
    [['--stall-timeout', '2200000', 'x']],
    [['--wait-timeout', '2147484', 'x']],
    [['--human-grace', '2592000', 'x']],
    [['--wait-timeout', 'soon', 'x']],
    [['--on-question', 'maybe', 'x']],
    [['--permission-mode', 'yolo', 'x']],
    [['--goal', 'fastest', 'x']],
    [['--team', 'big', 'x']],
    [['--quick', '--create-project', 'x']],
    [['--allow-edits', 'x']],
    [['--bogus', 'x']],
    [['one', 'two']]
  ])('%j is a usage error (exit 2) before any host is touched', async (argv) => {
    const f = live()
    await expect(runExec(f.ctx, argv)).rejects.toMatchObject({ exitCode: EXIT.usage })
    expect(f.connectCalls).toHaveLength(0)
  })
})

describe('orgai exec: prompt and project', () => {
  it('reads the prompt from stdin for "-" and when no positional is given with a non-TTY stdin', async () => {
    for (const argv of [['-'], []]) {
      stdin = 'from stdin'
      const h = execHost({ answers: { 'runs:subscribe': () => snapshotOf(record(finalSummary('completed'))) } })
      const f = live({ connect: [h] })
      expect(await runExec(f.ctx, argv)).toBe(EXIT.ok)
      expect(h.callsOf('runs:start')[0]).toMatchObject([{ projectId: 'p1', prompt: 'from stdin' }])
      // The follower never counts as an interactive client (it must not hold a policy's humanGraceMs window).
      expect(h.callsOf('runs:subscribe')[0]).toMatchObject([{ followChains: true, nonInteractive: true }])
    }
  })

  it('--prompt-file reads the prompt from a file (BOM dropped) or "-" from stdin, never from argv (review M12)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orgai-exec-prompt-'))
    try {
      const file = join(dir, 'prompt.txt')
      // Text a cmd.exe command line would break on: quotes, & and |.
      const hostile = '\ufeffFix "issue" & echo pwned | more\n'
      writeFileSync(file, hostile, 'utf8')
      for (const [argv, want] of [
        [['--prompt-file', file], hostile.slice(1)],
        [['--prompt-file', '-'], 'from stdin']
      ] as const) {
        stdin = 'from stdin'
        const h = execHost({ answers: { 'runs:subscribe': () => snapshotOf(record(finalSummary('completed'))) } })
        // A non-TTY stdin is not read when a file is given.
        const f = live({ connect: [h] })
        expect(await runExec(f.ctx, [...argv]), argv.join(' ')).toBe(EXIT.ok)
        expect(h.callsOf('runs:start')[0], argv.join(' ')).toMatchObject([{ projectId: 'p1', prompt: want }])
      }
      // Relative to the cwd.
      const h = execHost({ answers: { 'runs:subscribe': () => snapshotOf(record(finalSummary('completed'))) } })
      const rel = fakeContext({ cwd: dir, store: { hostState: 'ready', projects: [p1] }, connect: [h], resolveProject: () => ({ via: 'flag', project: p1 }) })
      expect(await runExec(rel.ctx, ['--prompt-file', 'prompt.txt'])).toBe(EXIT.ok)
      expect(h.callsOf('runs:start')[0]).toMatchObject([{ prompt: hostile.slice(1) }])

      const refused = async (argv: string[], message: string) => {
        const f = live({ stdinIsTTY: true })
        await expect(runExec(f.ctx, argv), argv.join(' ')).rejects.toMatchObject({ exitCode: EXIT.usage, message: expect.stringContaining(message) })
        expect(f.connectCalls, argv.join(' ')).toEqual([])
      }
      await refused(['--prompt-file', file, 'also argv'], 'not both')
      await refused(['--prompt-file', file, '-'], 'not both')
      await refused(['--prompt-file', join(dir, 'missing.txt')], 'could not read')
      await refused(['--prompt-file', dir], 'is not a file')
      writeFileSync(join(dir, 'empty.txt'), '  \n')
      await refused(['--prompt-file', join(dir, 'empty.txt')], 'Give a prompt')
      writeFileSync(join(dir, 'big.txt'), Buffer.alloc(1024 * 1024 + 1, 0x61))
      await refused(['--prompt-file', join(dir, 'big.txt')], 'larger than 1024 KB')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('an empty prompt is exit 2', async () => {
    stdin = '   \n'
    const f = live()
    await expect(runExec(f.ctx, [])).rejects.toMatchObject({ exitCode: EXIT.usage })
    const t = live({ stdinIsTTY: true })
    await expect(runExec(t.ctx, [])).rejects.toMatchObject({ exitCode: EXIT.usage })
  })

  it('refuses inside an OrgAI-managed agent worktree, naming the main checkout', async () => {
    const f = live({ resolveProject: () => ({ via: 'none', managedWorktree: { mainCheckout: '/work/app' } }) })
    await expect(runExec(f.ctx, ['hi'])).rejects.toMatchObject({ exitCode: EXIT.usage, message: expect.stringContaining('/work/app') })
    expect(f.connectCalls).toHaveLength(0)
  })

  it('an unregistered folder is exit 2: without a host from the saved data, with a host from projects:list', async () => {
    const f = fakeContext({ cwd: '/work/other', store: { projects: [p1] } })
    await expect(runExec(f.ctx, ['hi'])).rejects.toMatchObject({ exitCode: EXIT.usage, message: UNREGISTERED_MESSAGE })
    expect(f.connectCalls).toHaveLength(0)

    const h = execHost()
    const g = fakeContext({ cwd: '/work/other', store: { hostState: 'ready' }, connect: [h] })
    await expect(runExec(g.ctx, ['hi'])).rejects.toMatchObject({ exitCode: EXIT.usage, message: UNREGISTERED_MESSAGE })
    expect(h.callsOf('runs:start')).toHaveLength(0)
    expect(h.closed).toBe(true)
  })

  it('--quick starts a Chat run in this folder with the overrides', async () => {
    const h = execHost({ answers: { 'runs:startQuick': () => started({ projectId: 'quick' }), 'runs:subscribe': () => snapshotOf(record(finalSummary('completed-unplanned'))) } })
    const f = fakeContext({ cwd: '/work/other', connect: [h] })
    expect(await runExec(f.ctx, ['--quick', '--allow-edits', '--no-auto-continue', 'look around'])).toBe(EXIT.ok)
    expect(h.callsOf('runs:startQuick')[0]).toEqual([{ prompt: 'look around', folder: '/work/other', team: 'single', allowEdits: true, overrides: { execMode: true, autoContinue: false } }])
    expect(f.connectCalls.map((c) => c.scopes)).toEqual([['read', 'operate']])
  })

  it('--create-project creates the folder project (configure scope) and starts on it; --team single', async () => {
    const created = project('p9', '/work/other', { name: 'other' })
    const h = execHost({ answers: { 'projects:list': () => [], 'projects:create': () => created, 'runs:subscribe': () => snapshotOf(record(finalSummary('completed'))) } })
    const f = fakeContext({ cwd: '/work/other', env: { ORGAI_MOCK: '1' }, connect: [h] })
    expect(await runExec(f.ctx, ['--create-project', '--team', 'single', 'go'])).toBe(EXIT.ok)
    expect(f.connectCalls.map((c) => c.scopes)).toEqual([['read', 'operate', 'configure']])
    expect(h.callsOf('projects:create')[0]).toEqual([{ name: 'other', path: '/work/other', brief: '', mock: true }])
    expect(h.callsOf('runs:start')[0]).toEqual([{ projectId: 'p9', prompt: 'go', team: 'single', overrides: { execMode: true } }])
  })

  it("asks for 'configure' only when the overrides widen the project", async () => {
    const h = execHost({ answers: { 'runs:subscribe': () => snapshotOf(record(finalSummary('completed'))) } })
    const f = live({ connect: [h] })
    expect(await runExec(f.ctx, ['--permission-mode', 'plan', '--max-budget', '2', 'narrow'])).toBe(EXIT.ok)
    expect(f.connectCalls.map((c) => c.scopes)).toEqual([['read', 'operate']])

    const a = execHost()
    const b = execHost({ answers: { 'runs:subscribe': () => snapshotOf(record(finalSummary('completed'))) } })
    const g = live({ connect: [a, b] })
    expect(await runExec(g.ctx, ['--permission-mode', 'bypassPermissions', 'wide'])).toBe(EXIT.ok)
    expect(g.connectCalls.map((c) => c.scopes)).toEqual([['read', 'operate'], ['read', 'operate', 'configure']])
    expect(a.closed).toBe(true)
    expect(a.callsOf('runs:start')).toHaveLength(0)
    expect(b.callsOf('runs:start')[0]).toMatchObject([{ overrides: { permissionMode: 'bypassPermissions' } }])

    const c = execHost()
    const d = execHost({ scopes: ['read', 'operate'] })
    const k = live({ connect: [c, d] })
    await expect(runExec(k.ctx, ['--allow-peer-messages', 'wide'])).rejects.toMatchObject({ exitCode: EXIT.failure, message: expect.stringContaining("'configure'") })
  })
})

describe('orgai exec: following and outcomes', () => {
  it.each(EXEC_OUTCOMES.map((o) => [o]))('waits for run.finalized %s and exits with its code', async (outcome) => {
    const h = execHost()
    const f = live({ connect: [h] })
    const done = runExec(f.ctx, ['do it'])
    await subscribed(h)
    h.push('runs:event', ev(11, { type: 'run.status', runId: RUN, status: 'idle' }))
    await flush()
    h.push('runs:event', finalized(12, outcome))
    expect(await done).toBe(EXEC_OUTCOME_EXIT_CODE[outcome])
    expect(h.closed).toBe(true)
    expect(f.signalListeners()).toBe(0)
  })

  it('takes the outcome from a snapshot that is already final', async () => {
    const h = execHost({ answers: { 'runs:subscribe': () => snapshotOf(undefined, 20, { recentEndedRuns: [finalSummary('blocked')] }) } })
    const f = live({ connect: [h], globals: { outputFormat: 'json' } })
    expect(await runExec(f.ctx, ['do it'])).toBe(3)
    expect(JSON.parse(f.out())).toMatchObject({ outcome: 'blocked', exitCode: 3, runId: RUN })
  })

  it('follows a chain successor until its run.finalized', async () => {
    const h = execHost()
    const f = live({ connect: [h] })
    const done = runExec(f.ctx, ['--wait-for-reset', 'do it'])
    await subscribed(h)
    h.push('runs:event', ev(11, { type: 'run.status', runId: RUN, status: 'paused', autoResume: true, pauseReason: 'Usage limit' }))
    h.push('runs:event', ev(12, { type: 'run.status', runId: 'run_next02', status: 'running' }))
    h.push('runs:event', ev(13, { type: 'transcript', runId: 'run_next02', entry: text('e9', 'Resumed') }))
    h.push('runs:event', finalized(14, 'completed', 'run_next02'))
    expect(await done).toBe(EXIT.ok)
    expect(f.out()).toContain('R2 Orchestrator: Resumed')
  })

  it('text: transcript rows and status words (sanitized), then the outcome line', async () => {
    const h = execHost({ rec: record(started({ status: 'running', title: 'Exec' }), { transcript: [text('e1', 'Hi \u001b[31mred\u001b[0m there')] }) })
    const f = live({ connect: [h] })
    const done = runExec(f.ctx, ['do it'])
    await subscribed(h)
    h.push('runs:event', ev(11, { type: 'transcript', runId: RUN, entry: text('e2', 'Second \u001b]0;title\u0007 row') }))
    h.push('runs:event', ev(12, { type: 'question.request', runId: RUN, question: { id: 'q1', runId: RUN, agentId: 'root', question: 'Which DB?', options: [], allowMultiple: false, allowFreeText: true, createdAt: 1 } }))
    h.push('runs:event', finalized(13, 'completed'))
    expect(await done).toBe(0)
    const out = f.out()
    expect(out).not.toContain('\u001b')
    expect(out).not.toContain('\u0007')
    expect(out).toContain('R1 Orchestrator: Hi')
    expect(out).toContain('R1 Orchestrator: Second')
    expect(out).toContain('R1 Needs you: Question: Which DB? (request q1)')
    expect(out.trimEnd().split('\n').at(-1)).toBe('Completed · Finished · $0.25')
  })

  it('text: one line per staffed report (every source), once, sanitized; json keeps the raw event only', async () => {
    const asg = (agentId: string, source: StaffingSource, over: Partial<StaffingAssignment> = {}): StaffingAssignment => ({ agentId, roleId: 'engineer', tier: 'everyday', model: 'sonnet', effort: 'medium', source, at: 1, ...over })
    const sources: StaffingSource[] = ['orchestrator', 'role', 'profile', 'clamped', 'plan-guard', 'escalated']
    const assignments = sources.map((src, i) => asg(`w${i}`, src, { note: src === 'clamped' ? 'only fast\u001b[31m allowed' : undefined }))
    const h = execHost()
    const f = live({ connect: [h] })
    const done = runExec(f.ctx, ['do it'])
    await subscribed(h)
    h.push('runs:event', ev(11, { type: 'agent.upsert', runId: RUN, agent: { ...record(started()).agents[0]!, id: 'w0', parentId: 'root', name: 'Engineer', handle: 'engineer-1' } }))
    h.push('runs:event', ev(12, { type: 'staffing.updated', runId: RUN, staffing: { goal: 'balanced', assignments } }))
    h.push('runs:event', ev(13, { type: 'staffing.updated', runId: RUN, staffing: { goal: 'balanced', assignments: [...assignments, asg('', 'role')] } }))
    h.push('runs:event', finalized(14, 'completed'))
    expect(await done).toBe(0)
    const out = f.out()
    expect(out).not.toContain('\u001b')
    expect(out).toContain('R1 engineer-1 on everyday / medium (chosen by the orchestrator)')
    expect(out).toContain('engineer on everyday / medium (the role\'s setting)')
    expect(out).toContain("(from this project's history)")
    expect(out).toContain('(capped by the role: only fast allowed)')
    expect(out).toContain('(moved down by the plan guard)')
    expect(out).toContain('(raised after a failed attempt)')
    expect(out.match(/on everyday/g)).toHaveLength(6)

    const h2 = execHost()
    const g = live({ connect: [h2], globals: { outputFormat: 'json' } })
    const done2 = runExec(g.ctx, ['do it'])
    await subscribed(h2)
    h2.push('runs:event', ev(11, { type: 'staffing.updated', runId: RUN, staffing: { goal: 'balanced', assignments } }))
    h2.push('runs:event', finalized(12, 'completed'))
    await done2
    expect(g.out()).not.toContain(' on everyday')
  })

  it('text: one line per compaction with the agent\'s name and the ordinal (compaction investigation 2026-11-10)', async () => {
    const h = execHost()
    const f = live({ connect: [h] })
    const done = runExec(f.ctx, ['do it'])
    await subscribed(h)
    h.push('runs:event', ev(11, { type: 'agent.upsert', runId: RUN, agent: { ...record(started()).agents[0]!, id: 'root', name: 'Lead' } }))
    for (let i = 0; i < 3; i++) h.push('runs:event', ev(12 + i, { type: 'agent.compacted', runId: RUN, agentId: 'root', at: i, trigger: 'auto' }))
    h.push('runs:event', finalized(15, 'completed'))
    expect(await done).toBe(0)
    const out = f.out()
    expect(out).toContain('R1 Lead compacted its context (1st time).')
    expect(out).toContain('R1 Lead compacted its context (3rd time).')
  })

  it('json: one document at the end with the root agent result', async () => {
    const h = execHost()
    const f = live({ connect: [h], globals: { outputFormat: 'json' } })
    const done = runExec(f.ctx, ['do it'])
    await subscribed(h)
    h.push('runs:event', ev(11, { type: 'transcript', runId: RUN, entry: text('e2', 'noise') }))
    h.push('runs:event', finalized(12, 'needs-decision'))
    expect(await done).toBe(3)
    const doc = JSON.parse(f.out())
    expect(doc).toMatchObject({ schemaVersion: 1, runId: RUN, execChainId: RUN, outcome: 'needs-decision', exitCode: 3, status: 'Finished', result: 'All done.' })
    expect(doc.summary.execOutcome).toBe('needs-decision')
  })

  it('stream-json: a snapshot line, every event with seq / atSeq, then a result line', async () => {
    const h = execHost()
    const f = live({ connect: [h], globals: { outputFormat: 'stream-json' } })
    const done = runExec(f.ctx, ['do it'])
    await subscribed(h)
    h.push('runs:event', { atSeq: 10, event: { type: 'agent.partial', runId: RUN, agentId: 'root', text: 'typ' } })
    h.push('runs:event', ev(11, { type: 'transcript', runId: RUN, entry: text('e2', 'row') }))
    h.push('runs:event', ev(11, { type: 'transcript', runId: RUN, entry: text('e2', 'row') }))
    h.push('runs:event', ev(12, { type: 'transcript', runId: RUN, entry: { ...text('media', ''), block: { kind: 'media', media: { kind: 'image', image: { mediaType: 'image/png', data: 'U0VDUkVU' } } } } }))
    h.push('runs:event', finalized(13, 'completed'))
    expect(await done).toBe(0)
    const lines = f.out().trimEnd().split('\n').map((l) => JSON.parse(l))
    expect(lines.map((l) => l.type)).toEqual(['snapshot', 'event', 'event', 'event', 'event', 'result'])
    expect(lines[1]).toMatchObject({ schemaVersion: 1, atSeq: 10 })
    expect(lines[2]).toMatchObject({ seq: 11, event: { type: 'transcript' } })
    expect(lines[3].event.entry.block.media.image).toEqual({ mediaType: 'image/png', byteLength: 6, omittedBase64: true })
    expect(f.out()).not.toContain('U0VDUkVU')
    expect(lines[4]).toMatchObject({ seq: 13, event: { type: 'run.finalized' } })
    expect(lines[5]).toMatchObject({ schemaVersion: 1, type: 'result', outcome: 'completed', exitCode: 0, result: 'All done.' })
  })

  it('SIGINT calls runs:stop on the newest run and exits 130 once it is finalized; SIGTERM 143', async () => {
    for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143]] as const) {
      const h = execHost()
      const f = live({ connect: [h] })
      const done = runExec(f.ctx, ['do it'])
      await subscribed(h)
      f.signal(sig)
      await flush()
      expect(h.callsOf('runs:stop')).toEqual([[RUN]])
      h.push('runs:event', finalized(11, 'interrupted'))
      expect(await done).toBe(code)
      expect(f.out()).toContain('Interrupted')
    }
  })

  it('a second signal exits at once; no confirmation within the wait exits too', async () => {
    const h = execHost()
    const f = live({ connect: [h], globals: { outputFormat: 'json' } })
    const done = runExec(f.ctx, ['do it'])
    await subscribed(h)
    f.signal('SIGINT')
    f.signal('SIGINT')
    expect(await done).toBe(130)
    expect(JSON.parse(f.out())).toMatchObject({ outcome: null, exitCode: 130, runId: RUN })

    execIo.stopWaitMs = 5
    const g = execHost()
    const k = live({ connect: [g] })
    const waiting = runExec(k.ctx, ['do it'])
    await subscribed(g)
    k.signal('SIGTERM')
    expect(await waiting).toBe(143)
    expect(k.err()).toContain('did not confirm')
  })

  it('a host that goes away for good is exit 1 with the outcome unknown', async () => {
    let t = 0
    execIo.timers = { sleep: async () => void (t += 10_000), now: () => t }
    const h = execHost()
    const f = live({ connect: [h, { ok: false, reason: 'no_host', message: 'gone' }] })
    const done = runExec(f.ctx, ['do it'])
    await subscribed(h)
    h.hostClose(new Error('reset'))
    expect(await done).toBe(EXIT.failure)
    expect(f.err()).toContain("The OrgAI host went away; the run's outcome is unknown.")
  })

  it('starts the in-process host and stops it (force) after the run', async () => {
    const inproc = fakeInproc()
    const h = execHost()
    const f = live({ connect: [h], inproc: async () => inproc })
    const done = runExec(f.ctx, ['do it'])
    await subscribed(h)
    h.push('runs:event', finalized(11, 'completed'))
    expect(await done).toBe(0)
    expect(inproc.stops).toEqual([true])
  })

  it('a refused start is an error and still stops the inproc host', async () => {
    const inproc = fakeInproc()
    const h = execHost({
      answers: {
        'runs:start': () => {
          throw Object.assign(new Error('overrides.maxBudgetUsd must be a finite number >= 0.'), { data: { code: 'bad_request', message: 'x' } })
        }
      }
    })
    const f = live({ connect: [h], inproc: async () => inproc })
    await expect(runExec(f.ctx, ['do it'])).rejects.toMatchObject({ exitCode: EXIT.usage })
    expect(inproc.stops).toEqual([true])
  })
})

describe('orgai resume', () => {
  it('without --exec opens the terminal UI; exec-only flags without --exec and TUI flags with it are refused', async () => {
    const f = live()
    resumeTui.calls.length = 0
    expect(await runResume(f.ctx, ['R1', '--prompt', 'more'])).toBe(0)
    expect(await runResume(f.ctx, ['--inline'])).toBe(0)
    expect(resumeTui.calls).toEqual([['R1', '--prompt', 'more'], ['--inline']])
    await expect(runResume(f.ctx, ['R1', '--max-budget', '1'])).rejects.toMatchObject({ exitCode: EXIT.usage, message: expect.stringContaining('--max-budget needs --exec') })
    await expect(runResume(f.ctx, ['R1', '--on-permission', 'wait'])).rejects.toMatchObject({ exitCode: EXIT.usage })
    await expect(runResume(f.ctx, ['R1', '--exec', '--inline', '--prompt', 'x'])).rejects.toMatchObject({ exitCode: EXIT.usage, message: expect.stringContaining('--inline applies to the terminal UI') })
    expect(resumeTui.calls).toHaveLength(2)
    expect(f.connectCalls).toEqual([])
  })

  it('continues R# with exec: true and follows the new run', async () => {
    const old = summary('run_old001', { startedAt: 50, status: 'finished', execOutcome: 'completed' })
    const h = execHost({ answers: { 'runs:list': () => [old], 'runs:continue': () => started({ resumedFrom: 'run_old001' }) } })
    const f = live({ connect: [h] })
    const done = runResume(f.ctx, ['R1', '--exec', '--prompt', 'more', '--max-budget', '1'])
    await subscribed(h)
    expect(h.callsOf('runs:continue')[0]).toEqual([{ runId: 'run_old001', text: 'more', overrides: { execMode: true, maxBudgetUsd: 1 }, exec: true }])
    h.push('runs:event', finalized(11, 'completed'))
    expect(await done).toBe(0)
  })

  it('defaults to the newest ended run and reads "-" from stdin', async () => {
    stdin = 'piped'
    const runs = [summary('run_live03', { startedAt: 300, status: 'running' }), summary('run_end002', { startedAt: 200, status: 'finished' }), summary('run_end001', { startedAt: 100 })]
    const h = execHost({ answers: { 'runs:list': () => runs, 'runs:continue': () => started(), 'runs:subscribe': () => snapshotOf(record(finalSummary('incomplete-plan'))) } })
    const f = live({ connect: [h] })
    expect(await runResume(f.ctx, ['-', '--exec'])).toBe(3)
    expect(h.callsOf('runs:continue')[0]).toMatchObject([{ runId: 'run_end002', text: 'piped', exec: true }])
  })

  it('--prompt-file gives the message; with --prompt or - it is refused, and without --exec it needs --exec', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orgai-resume-prompt-'))
    try {
      const file = join(dir, 'more.txt')
      writeFileSync(file, 'more "from" a file & co')
      const old = summary('run_old001', { startedAt: 50, status: 'finished', execOutcome: 'completed' })
      const h = execHost({ answers: { 'runs:list': () => [old], 'runs:continue': () => started({ resumedFrom: 'run_old001' }) } })
      const f = live({ connect: [h] })
      const done = runResume(f.ctx, ['R1', '--exec', '--prompt-file', file])
      await subscribed(h)
      expect(h.callsOf('runs:continue')[0]).toEqual([{ runId: 'run_old001', text: 'more "from" a file & co', overrides: { execMode: true }, exec: true }])
      h.push('runs:event', finalized(11, 'completed'))
      expect(await done).toBe(0)

      const g = live()
      for (const argv of [
        ['R1', '--exec', '--prompt-file', file, '--prompt', 'x'],
        ['R1', '-', '--exec', '--prompt-file', file]
      ]) {
        await expect(runResume(g.ctx, argv), argv.join(' ')).rejects.toMatchObject({ exitCode: EXIT.usage, message: expect.stringContaining('Give one of') })
      }
      await expect(runResume(g.ctx, ['R1', '--prompt-file', file])).rejects.toMatchObject({ exitCode: EXIT.usage, message: expect.stringContaining('--prompt-file needs --exec') })
      expect(g.connectCalls).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses inside a managed worktree and without a message', async () => {
    const f = live({ resolveProject: () => ({ via: 'none', managedWorktree: { mainCheckout: '/work/app' } }) })
    await expect(runResume(f.ctx, ['--exec', '--prompt', 'x'])).rejects.toMatchObject({ exitCode: EXIT.usage })
    const g = live({ stdinIsTTY: true })
    await expect(runResume(g.ctx, ['--exec'])).rejects.toMatchObject({ exitCode: EXIT.usage })
  })
})

describe('lastRootText', () => {
  it('is the root agent last non-harness text', () => {
    const s = summary('r')
    expect(lastRootText(record(s, { transcript: [text('a', 'one'), text('b', 'report', 'w1'), { ...text('c', 'nudge'), source: 'harness' }] }))).toBe('one')
    expect(lastRootText(null)).toBeNull()
  })
})
