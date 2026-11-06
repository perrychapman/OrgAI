import { afterEach, describe, expect, it } from 'vitest'
import type { CardKind, DecisionLookup, DecisionOutcome, HostScope, PendingCards } from '../../shared/types'
import { TERMINAL_FULL_ACCESS_HINT } from '../client/ensureHost'
import { FakeHostClient, fakeContext, noHost, rpcError, type FakeContextOptions } from '../testing/fakeContext'
import { EXIT, HOST_STARTING_WAIT_MS } from '../types'
import { reservedSecretSourceProblem } from '../secretOverlay'
import { decideDeps, runDecide } from './decide'

const RUN = 'run_abc123'
const REQ = 'req_1'

const emptyCards = (): PendingCards => ({ permissions: [], questions: [], proposals: [], ruleRequests: [], mergeReviews: [], mcpInstalls: [] })

function cardsFor(kind: CardKind, extra: Record<string, unknown> = {}): PendingCards {
  const c = emptyCards()
  const base = { id: REQ, runId: RUN, agentId: 'root', createdAt: 1, revision: 4 }
  if (kind === 'permission') c.permissions.push({ ...base, toolName: 'Bash', input: {}, summary: 'Run npm test', ...extra } as never)
  if (kind === 'rules') c.ruleRequests.push({ ...base, rules: ['Bash(npm test:*)'], reason: 'tests', flagged: [], ...extra } as never)
  if (kind === 'proposal') {
    c.proposals.push({
      ...base,
      title: 'Add GitHub',
      kind: 'mcpServers',
      payload: { upsert: [], rationale: 'r', secrets: [{ serverId: 'gh', kind: 'env', name: 'GITHUB_TOKEN' }] },
      ...extra
    } as never)
  }
  if (kind === 'question') c.questions.push({ ...base, question: 'Which DB?', options: [{ label: 'Postgres' }, { label: 'SQLite' }], allowMultiple: false, allowFreeText: true, ...extra } as never)
  if (kind === 'merge') c.mergeReviews.push({ ...base, agentName: 'impl', branch: 'worktree-agent-1', path: '/x', changedFiles: [], stat: '', patch: '', ...extra } as never)
  if (kind === 'mcpInstall') c.mcpInstalls.push({ ...base, reason: 'need it', spec: { id: 's', name: 'srv' }, requiredSecrets: ['API_KEY'], ...extra } as never)
  return c
}

const CHANNEL: Record<CardKind, string> = {
  permission: 'runs:decide',
  rules: 'permissions:decideRequest',
  proposal: 'setup:decide',
  question: 'setup:answer',
  merge: 'merges:decide',
  mcpInstall: 'mcp:answerInstall'
}

interface Setup {
  kind?: CardKind
  lookup?: DecisionLookup
  cardExtra?: Record<string, unknown>
  outcome?: Partial<DecisionOutcome> | (() => unknown)
  opts?: FakeContextOptions
  /** hello.grantedScopes (default read + decide). */
  scopes?: HostScope[]
}

function setup(s: Setup = {}) {
  const kind = s.kind ?? 'permission'
  const lookup: DecisionLookup = s.lookup ?? { status: 'pending', requestId: REQ, runId: RUN, projectId: 'p1', kind, revision: 4 }
  const host = new FakeHostClient({
    'runs:findDecision': () => lookup,
    'runs:pendingCards': () => cardsFor(kind, s.cardExtra),
    [CHANNEL[kind]]: typeof s.outcome === 'function' ? s.outcome : () => ({ status: 'applied', runId: RUN, requestId: REQ, effectiveDecision: 'x', ...(s.outcome ?? {}) })
  }, { hello: { grantedScopes: s.scopes ?? ['read', 'decide'] } })
  const f = fakeContext({ connect: [host], ...s.opts })
  return { f, host, sent: () => host.callsOf(CHANNEL[kind]) }
}

afterEach(() => {
  decideDeps.confirm = async () => false
})

describe('orgai decide: payloads per kind and verb (cli-spec 5.3)', () => {
  const cases: [CardKind, string[], unknown][] = [
    ['permission', ['allow'], { runId: RUN, requestId: REQ, expectedRevision: 4, decision: { behavior: 'allow', scope: 'once' } }],
    ['permission', ['allow-session'], { runId: RUN, requestId: REQ, expectedRevision: 4, decision: { behavior: 'allow', scope: 'session' } }],
    ['permission', ['allow-project', '--yes'], { runId: RUN, requestId: REQ, expectedRevision: 4, decision: { behavior: 'allow', scope: 'project' } }],
    ['permission', ['deny'], { runId: RUN, requestId: REQ, expectedRevision: 4, decision: { behavior: 'deny', message: 'Denied by user' } }],
    ['permission', ['deny', '--message', 'Use yarn'], { runId: RUN, requestId: REQ, expectedRevision: 4, decision: { behavior: 'deny', message: 'Use yarn' } }],
    ['rules', ['grant'], { runId: RUN, requestId: REQ, expectedRevision: 4, decision: { behavior: 'grant', scope: 'run' } }],
    ['rules', ['grant-project', '-y'], { runId: RUN, requestId: REQ, expectedRevision: 4, decision: { behavior: 'grant', scope: 'project' } }],
    ['rules', ['deny'], { runId: RUN, requestId: REQ, expectedRevision: 4, decision: { behavior: 'deny' } }],
    ['rules', ['deny', '--note', 'too broad'], { runId: RUN, requestId: REQ, expectedRevision: 4, decision: { behavior: 'deny', message: 'too broad' } }],
    ['proposal', ['approve'], { runId: RUN, proposalId: REQ, expectedRevision: 4, decision: { behavior: 'approve' } }],
    ['proposal', ['revise', '--note', 'fewer roles'], { runId: RUN, proposalId: REQ, expectedRevision: 4, decision: { behavior: 'revise', feedback: 'fewer roles' } }],
    ['proposal', ['decline'], { runId: RUN, proposalId: REQ, expectedRevision: 4, decision: { behavior: 'decline' } }],
    ['proposal', ['decline', '--note', 'no'], { runId: RUN, proposalId: REQ, expectedRevision: 4, decision: { behavior: 'decline', note: 'no' } }],
    ['question', ['answer', '--option', 'SQLite'], { runId: RUN, questionId: REQ, expectedRevision: 4, answer: { selected: ['SQLite'] } }],
    ['question', ['answer', '--pick', '1', '--text', 'with pgvector'], { runId: RUN, questionId: REQ, expectedRevision: 4, answer: { selected: ['Postgres'], text: 'with pgvector' } }],
    ['question', ['answer', '--text', 'neither'], { runId: RUN, questionId: REQ, expectedRevision: 4, answer: { selected: [], text: 'neither' } }],
    ['merge', ['merge'], { runId: RUN, reviewId: REQ, expectedRevision: 4, decision: { behavior: 'merge' } }],
    ['merge', ['hold'], { runId: RUN, reviewId: REQ, expectedRevision: 4, decision: { behavior: 'hold' } }],
    ['merge', ['discard', '--yes'], { runId: RUN, reviewId: REQ, expectedRevision: 4, decision: { behavior: 'discard' } }],
    ['mcpInstall', ['allow'], { runId: RUN, requestId: REQ, expectedRevision: 4, decision: { approved: true, scope: 'run' } }],
    ['mcpInstall', ['save-project', '--yes'], { runId: RUN, requestId: REQ, expectedRevision: 4, decision: { approved: true, scope: 'project' } }],
    ['mcpInstall', ['save-library', '--yes'], { runId: RUN, requestId: REQ, expectedRevision: 4, decision: { approved: true, scope: 'library' } }],
    ['mcpInstall', ['deny', '--note', 'not needed'], { runId: RUN, requestId: REQ, expectedRevision: 4, decision: { approved: false, scope: 'run', note: 'not needed' } }]
  ]
  for (const [kind, argv, payload] of cases) {
    it(`${kind} ${argv.join(' ')}`, async () => {
      const { f, host, sent } = setup({ kind })
      expect(await runDecide(f.ctx, [REQ, ...argv])).toBe(EXIT.ok)
      expect(sent()).toEqual([[payload]])
      expect(f.connectCalls[0].scopes).toEqual(['read', 'decide'])
      // A starting host is waited for as long as ensureHost waits (cli-standalone.md 4.1 step 2).
      expect(f.connectCalls[0].opts).toMatchObject({ waitStartingMs: HOST_STARTING_WAIT_MS })
      expect(host.callsOf('runs:findDecision')).toEqual([[REQ]])
      expect(host.callsOf('runs:pendingCards')).toEqual([[RUN]])
      expect(host.closed).toBe(true)
    })
  }

  it('--revision overrides the lookup revision', async () => {
    const { f, sent } = setup({ kind: 'merge' })
    await runDecide(f.ctx, [REQ, 'hold', '--revision', '2'])
    expect(sent()).toEqual([[{ runId: RUN, reviewId: REQ, expectedRevision: 2, decision: { behavior: 'hold' } }]])
    const g = setup()
    await expect(runDecide(g.f.ctx, [REQ, 'allow', '--revision', 'x'])).rejects.toMatchObject({ exitCode: EXIT.usage })
  })
})

describe('orgai decide: refusals', () => {
  it('a verb the kind does not take is exit 2 naming the valid verbs', async () => {
    const { f, sent } = setup({ kind: 'merge' })
    await expect(runDecide(f.ctx, [REQ, 'allow'])).rejects.toMatchObject({ exitCode: EXIT.usage, message: expect.stringContaining('merge, hold, discard') })
    expect(sent()).toEqual([])
  })

  it('durable verbs without --yes are exit 2 off a terminal', async () => {
    for (const [kind, verb] of [
      ['permission', 'allow-project'],
      ['rules', 'grant-project'],
      ['merge', 'discard'],
      ['mcpInstall', 'save-project'],
      ['mcpInstall', 'save-library']
    ] as [CardKind, string][]) {
      const { f, sent } = setup({ kind })
      await expect(runDecide(f.ctx, [REQ, verb])).rejects.toMatchObject({ exitCode: EXIT.usage, message: expect.stringContaining('--yes') })
      expect(sent()).toEqual([])
    }
  })

  it('on a terminal a durable verb asks y/N; no is exit 1 and sends nothing', async () => {
    const asked: string[] = []
    decideDeps.confirm = async (q) => (asked.push(q), false)
    const { f, sent } = setup({ kind: 'merge' })
    f.ctx.io.stdinIsTTY = true
    f.ctx.io.stdout.isTTY = true
    await expect(runDecide(f.ctx, [REQ, 'discard'])).rejects.toMatchObject({ exitCode: EXIT.failure })
    expect(asked).toHaveLength(1)
    expect(sent()).toEqual([])
    decideDeps.confirm = async () => true
    const g = setup({ kind: 'merge' })
    g.f.ctx.io.stdinIsTTY = true
    g.f.ctx.io.stdout.isTTY = true
    expect(await runDecide(g.f.ctx, [REQ, 'discard'])).toBe(EXIT.ok)
    expect(g.sent()).toHaveLength(1)
  })

  it('revise needs --note', async () => {
    const { f } = setup({ kind: 'proposal' })
    await expect(runDecide(f.ctx, [REQ, 'revise'])).rejects.toMatchObject({ exitCode: EXIT.usage })
  })

  it('answer flags on other kinds are exit 2', async () => {
    const { f } = setup({ kind: 'permission' })
    await expect(runDecide(f.ctx, [REQ, 'allow', '--option', 'x'])).rejects.toMatchObject({ exitCode: EXIT.usage })
  })

  it('bad usage: wrong arity, bad request id', async () => {
    const { f } = setup()
    await expect(runDecide(f.ctx, [REQ])).rejects.toMatchObject({ exitCode: EXIT.usage })
    await expect(runDecide(f.ctx, ['a b', 'allow'])).rejects.toMatchObject({ exitCode: EXIT.usage })
  })
})

describe('orgai decide: secrets from the environment', () => {
  it('proposal approve reads NAME=ENV_VAR and never echoes the value', async () => {
    const { f, sent } = setup({ kind: 'proposal', opts: { env: { MY_GH: 'ghp_secretvalue' }, globals: { outputFormat: 'json' } } })
    expect(await runDecide(f.ctx, [REQ, 'approve', '--secret', 'gh:env:GITHUB_TOKEN=MY_GH'])).toBe(EXIT.ok)
    expect(sent()).toEqual([[{ runId: RUN, proposalId: REQ, expectedRevision: 4, decision: { behavior: 'approve', secrets: { 'gh:env:GITHUB_TOKEN': 'ghp_secretvalue' } } }]])
    expect(f.out()).not.toContain('ghp_secretvalue')
    expect(f.err()).not.toContain('ghp_secretvalue')
  })

  it('mcpInstall allow carries secrets', async () => {
    const { f, sent } = setup({ kind: 'mcpInstall', opts: { env: { K: 'v1' } } })
    await runDecide(f.ctx, [REQ, 'allow', '--secret', 'API_KEY=K'])
    expect(sent()).toEqual([[{ runId: RUN, requestId: REQ, expectedRevision: 4, decision: { approved: true, scope: 'run', secrets: { API_KEY: 'v1' } } }]])
    expect(f.out()).not.toContain('v1')
    // Taken out of the environment once read (review M13).
    expect(f.ctx.env.K).toBeUndefined()
  })

  it('a missing or empty variable, an unknown slot or a bad spec is exit 2 and sends nothing', async () => {
    for (const [env, spec] of [
      [{}, 'API_KEY=NOPE'],
      [{ E: '' }, 'API_KEY=E'],
      [{ E: 'x' }, 'OTHER=E'],
      [{ E: 'x' }, 'API_KEY=not-a-var'],
      [{ E: 'x' }, 'API_KEY']
    ] as [Record<string, string>, string][]) {
      const { f, sent } = setup({ kind: 'mcpInstall', opts: { env } })
      await expect(runDecide(f.ctx, [REQ, 'allow', '--secret', spec])).rejects.toMatchObject({ exitCode: EXIT.usage })
      expect(sent()).toEqual([])
    }
  })

  it('an ORGAI_SECRET_* source is refused with its own message (prepareContext scrubbed it; review round 2)', async () => {
    const { f, sent } = setup({ kind: 'mcpInstall', opts: { env: {} } })
    await expect(runDecide(f.ctx, [REQ, 'allow', '--secret', 'API_KEY=ORGAI_SECRET_TOKEN'])).rejects.toMatchObject({
      exitCode: EXIT.usage,
      message: reservedSecretSourceProblem('ORGAI_SECRET_TOKEN', '--secret API_KEY')
    })
    expect(sent()).toEqual([])
  })

  it('--secret on a verb that takes none is exit 2', async () => {
    const { f } = setup({ kind: 'mcpInstall', opts: { env: { K: 'v' } } })
    await expect(runDecide(f.ctx, [REQ, 'deny', '--secret', 'API_KEY=K'])).rejects.toMatchObject({ exitCode: EXIT.usage })
  })
})

describe('orgai decide: question answers', () => {
  it('single choice takes one selection; options must be offered; --pick range', async () => {
    for (const argv of [
      ['--option', 'Postgres', '--option', 'SQLite'],
      ['--pick', '1', '--pick', '2'],
      ['--option', 'MySQL'],
      ['--pick', '3'],
      ['--pick', '0'],
      []
    ]) {
      const { f, sent } = setup({ kind: 'question' })
      await expect(runDecide(f.ctx, [REQ, 'answer', ...argv])).rejects.toMatchObject({ exitCode: EXIT.usage })
      expect(sent()).toEqual([])
    }
  })

  it('multi choice keeps every pick once; --text refused without free text', async () => {
    const { f, sent } = setup({ kind: 'question', cardExtra: { allowMultiple: true, allowFreeText: false } })
    await runDecide(f.ctx, [REQ, 'answer', '--option', 'SQLite', '--pick', '1', '--pick', '2'])
    expect(sent()).toEqual([[{ runId: RUN, questionId: REQ, expectedRevision: 4, answer: { selected: ['SQLite', 'Postgres'] } }]])
    const g = setup({ kind: 'question', cardExtra: { allowMultiple: true, allowFreeText: false } })
    await expect(runDecide(g.f.ctx, [REQ, 'answer', '--pick', '1', '--text', 'x'])).rejects.toMatchObject({ exitCode: EXIT.usage })
  })
})

describe('orgai decide: lookups and outcomes', () => {
  it('not-found lookup is exit 2', async () => {
    const { f, sent } = setup({ lookup: { status: 'not-found', requestId: REQ } })
    expect(await runDecide(f.ctx, [REQ, 'allow'])).toBe(EXIT.usage)
    expect(f.err()).toContain('No pending decision')
    expect(sent()).toEqual([])
  })

  it('tombstones are exit 1 naming who resolved them', async () => {
    const applied = setup({ lookup: { status: 'applied', requestId: REQ, runId: RUN, kind: 'permission', effectiveDecision: 'allow', decidedBy: { surface: 'desktop' }, at: 1 } })
    expect(await runDecide(applied.f.ctx, [REQ, 'allow'])).toBe(EXIT.failure)
    expect(applied.f.err()).toContain('Resolved by the OrgAI app')
    expect(applied.sent()).toEqual([])
    const cancelled = setup({ lookup: { status: 'cancelled', requestId: REQ, runId: RUN, kind: 'merge', at: 1 } })
    expect(await runDecide(cancelled.f.ctx, [REQ, 'merge'])).toBe(EXIT.failure)
    expect(cancelled.f.err()).toContain('cancelled')
  })

  it('applied is exit 0 and shows applyError', async () => {
    const { f } = setup({ kind: 'proposal', outcome: { effectiveDecision: 'revise', applyError: 'Server id taken' } })
    expect(await runDecide(f.ctx, [REQ, 'approve'])).toBe(EXIT.ok)
    expect(f.out()).toContain('revise')
    expect(f.out()).toContain('Server id taken')
  })

  it('stale-revision, already-resolved and cancelled outcomes are exit 1', async () => {
    const stale = setup({ outcome: { status: 'stale-revision' } })
    expect(await runDecide(stale.f.ctx, [REQ, 'allow'])).toBe(EXIT.failure)
    expect(stale.f.err()).toContain('The card changed; run orgai inbox again')
    const done = setup({ outcome: { status: 'already-resolved', decidedBy: { surface: 'tui', reportedPid: 77 } } })
    expect(await runDecide(done.f.ctx, [REQ, 'allow'])).toBe(EXIT.failure)
    expect(done.f.err()).toContain('Resolved by the terminal UI (pid 77)')
    const gone = setup({ outcome: { status: 'cancelled' } })
    expect(await runDecide(gone.f.ctx, [REQ, 'allow'])).toBe(EXIT.failure)
    const nf = setup({ outcome: { status: 'not-found' } })
    expect(await runDecide(nf.f.ctx, [REQ, 'allow'])).toBe(EXIT.usage)
  })

  it('a card missing from pendingCards reads as changed (exit 1)', async () => {
    const { f, host, sent } = setup()
    host.answers['runs:pendingCards'] = () => emptyCards()
    expect(await runDecide(f.ctx, [REQ, 'allow'])).toBe(EXIT.failure)
    expect(sent()).toEqual([])
  })

  it('an older host answering nothing counts as applied', async () => {
    const { f } = setup({ outcome: () => undefined })
    expect(await runDecide(f.ctx, [REQ, 'deny'])).toBe(EXIT.ok)
    expect(f.out()).toContain('deny')
  })

  it('a host error is exit 1 with a sanitized message', async () => {
    const { f } = setup({
      outcome: () => {
        throw rpcError({ code: 'bad_request', message: 'Nope \x1b]52;c;ZXZpbA==\x07 refused' })
      }
    })
    await expect(runDecide(f.ctx, [REQ, 'allow'])).rejects.toMatchObject({ exitCode: EXIT.failure, message: expect.not.stringContaining('\x1b') })
  })

  it('no host is exit 1 and never starts one', async () => {
    const f = fakeContext({ connect: [noHost()] })
    await expect(runDecide(f.ctx, [REQ, 'allow'])).rejects.toMatchObject({
      exitCode: EXIT.failure,
      message: 'No OrgAI host is running; pending decisions live only in a running host.'
    })
    expect(f.launcherCalls).toEqual([])
  })

  it('json output shape', async () => {
    const { f } = setup({ kind: 'merge', opts: { globals: { outputFormat: 'json' } }, outcome: { effectiveDecision: 'merge', decidedBy: { surface: 'cli' } } })
    expect(await runDecide(f.ctx, [REQ, 'merge'])).toBe(EXIT.ok)
    const j = JSON.parse(f.out())
    expect(Object.keys(j)[0]).toBe('schemaVersion')
    expect(j).toMatchObject({ requestId: REQ, kind: 'merge', outcome: { status: 'applied', runId: RUN, requestId: REQ, effectiveDecision: 'merge' } })
    const nf = setup({ lookup: { status: 'not-found', requestId: REQ }, opts: { globals: { outputFormat: 'json' } } })
    expect(await runDecide(nf.f.ctx, [REQ, 'allow'])).toBe(EXIT.usage)
    expect(JSON.parse(nf.f.out())).toMatchObject({ requestId: REQ, kind: null, outcome: { status: 'not-found' } })
  })

  it('host strings are sanitized in text output', async () => {
    const { f } = setup({ outcome: { effectiveDecision: 'allow\x1b[31m\x07', applyError: 'bad \x1b]0;title\x07 thing' } })
    await runDecide(f.ctx, [REQ, 'allow'])
    expect(f.out()).not.toMatch(/\x1b|\x07/)
    const g = setup({ lookup: { status: 'applied', requestId: REQ, runId: RUN, kind: 'permission', effectiveDecision: '\x1b[2Jallow', at: 1 } })
    await runDecide(g.f.ctx, [REQ, 'allow'])
    expect(g.f.err()).not.toMatch(/\x1b/)
  })
})

describe('orgai decide: Terminal access level (review H2)', () => {
  it("a host that withheld 'decide' is exit 1 naming the setting, and nothing is looked up or sent", async () => {
    const { f, host, sent } = setup({ scopes: ['read'] })
    await expect(runDecide(f.ctx, [REQ, 'allow'])).rejects.toMatchObject({ exitCode: EXIT.failure, message: expect.stringContaining(TERMINAL_FULL_ACCESS_HINT) })
    expect(host.callsOf('runs:findDecision')).toHaveLength(0)
    expect(sent()).toHaveLength(0)
    expect(host.closed).toBe(true)
  })
})
