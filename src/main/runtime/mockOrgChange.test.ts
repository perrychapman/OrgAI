import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { OrgChartProposalPayload, Proposal, ProposalOutcome, Role, RunEvent } from '@shared/types'
import { RunManager } from './runManager'
import { RunStore } from '../store/runs'
import { ProjectStore } from '../store/projects'
import { SetupService } from '../setup/service'
import {
  MOCK_ORG_CHANGE_APPROVED,
  MOCK_ORG_CHANGE_DECLINED,
  MOCK_ORG_CHANGE_NONE,
  MOCK_ROSTER_REPORT,
  MOCK_ROSTER_RESULT,
  MOCK_ROSTER_TESTER,
  MockAdapter,
  ORG_CHANGE_TOKEN,
  orgChangeArgs,
  type MockScript,
  type MockSession
} from './mock'
import { applyRosterChange } from './runRoster'
import { ROOT_AGENT_ID } from './types'
import { fakeCtx, orgChart, runSummary } from './testHelpers'

// The real logger writes under Electron's userData; tests have no Electron.
vi.mock('../log', () => ({ logRunEvent: () => {}, logPermission: () => {}, log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } }))

/**
 * [mock:org-change] and the mock's live roster (RuntimeSession.liveRoster): an approved propose_org_change reaches the
 * running session through ctx.roles, which RunManager rewrites in place. The fake requestProposal below plays RunManager's
 * part with the real applyRosterChange (runRoster.ts), so the mock sees exactly what a live run would.
 */

type Recording = ReturnType<typeof fakeCtx> & { retired: Role[] }

/** A work-run context whose roles are the run's own copies, with RunManager's org-change apply on approval. */
function recordingCtx(opts: { prompt?: string; decide?: ProposalOutcome['behavior'] } = {}): Recording {
  const retired: Role[] = []
  const ctx = fakeCtx({ prompt: opts.prompt ?? `Add a role ${ORG_CHANGE_TOKEN}`, autoContinue: false }) as Recording
  ctx.roles = structuredClone(ctx.project.roles)
  ctx.retired = retired
  ctx.retiredRoles = () => retired
  ctx.requestProposal = vi.fn(async (req: Omit<Proposal, 'id' | 'runId' | 'createdAt' | 'effect'>): Promise<ProposalOutcome> => {
    const behavior = opts.decide ?? 'approve'
    if (behavior === 'decline') return { behavior: 'decline' }
    if (behavior === 'revise') return { behavior: 'revise', feedback: 'Not now.' }
    const proposed = (req.payload as OrgChartProposalPayload).roles
    const applied = applyRosterChange({ running: ctx.roles, saved: proposed, proposed })
    retired.push(...applied.retired)
    ctx.project = { ...ctx.project, roles: structuredClone(proposed) }
    return { behavior: 'approve', roster: applied.change }
  }) as Recording['requestProposal']
  return ctx
}

const rootTexts = (ctx: Recording): string[] =>
  ctx.events.flatMap((e) => (e.type === 'transcript' && e.entry.agentId === ROOT_AGENT_ID && e.entry.block.kind === 'text' ? [e.entry.block.text] : []))
const lastAgent = (ctx: Recording, id: string) =>
  ctx.events.flatMap((e) => (e.type === 'agent.upsert' && e.agent.id === id ? [e.agent] : [])).at(-1)
const toolResults = (ctx: Recording, agentId: string) =>
  ctx.events.flatMap((e) => (e.type === 'transcript' && e.entry.agentId === agentId && e.entry.block.kind === 'tool_result' ? [e.entry.block] : []))

async function start(ctx: Recording, script: MockScript = {}): Promise<MockSession> {
  return (await new MockAdapter({ script: { delayMs: 0, ...script } }).start(ctx)) as MockSession
}

async function idle(ctx: Recording): Promise<void> {
  await vi.waitFor(() => expect(ctx.events.some((e) => e.type === 'run.status' && e.status === 'idle')).toBe(true))
}

describe('orgChangeArgs', () => {
  it('keeps every role by slug and field, adds Roster Tester under the root and lets the root spawn it', () => {
    const roles = orgChart()
    const args = orgChangeArgs(roles) as { title: string; rationale: string; roles: Record<string, unknown>[] }
    expect(args.title).toBe('Add a Roster Tester')
    expect(args.rationale).toMatch(/\S/)
    expect(args.roles.map((r) => r.slug ?? null)).toEqual(['lead', 'engineer', 'reviewer', null])
    expect(args.roles[0]).toMatchObject({ name: 'Lead', canSpawn: true, spawnable: ['Engineer', 'Reviewer', MOCK_ROSTER_TESTER.name], reportsTo: null, prompt: roles[0].prompt })
    expect(args.roles[1]).toMatchObject({ name: 'Engineer', tools: ['Read', 'Edit', 'Write'], spawnable: [], reportsTo: 'Lead', description: roles[1].description })
    expect(args.roles[3]).toMatchObject({ name: MOCK_ROSTER_TESTER.name, tools: ['Read', 'Grep'], canSpawn: false, spawnable: [], reportsTo: 'Lead' })
    // Grants, models and connections are never in a draft (an org change never grants; omitted model keeps it).
    for (const d of args.roles) for (const k of ['mcpServers', 'skills', 'model', 'connection', 'id']) expect(d).not.toHaveProperty(k)
  })
})

describe('[mock:org-change] on a live-roster mock session', () => {
  it('declares liveRoster', async () => {
    const ctx = recordingCtx({ prompt: 'plain' })
    const session = await start(ctx)
    expect(session.liveRoster).toBe(true)
    await session.stop()
    await session.finished
  })

  it('approved: the new role is in ctx.roles, a report of it is spawned and finishes, and the root quotes the tool result', async () => {
    const ctx = recordingCtx()
    const array = ctx.roles
    const session = await start(ctx)
    await vi.waitFor(() => expect(rootTexts(ctx).some((t) => t.startsWith(MOCK_ORG_CHANGE_APPROVED))).toBe(true))
    await idle(ctx)
    expect(ctx.roles).toBe(array)
    const tester = ctx.roles.find((r) => r.name === MOCK_ROSTER_TESTER.name)
    expect(tester).toMatchObject({ slug: MOCK_ROSTER_TESTER.slug, reportsTo: 'r-lead', tools: ['Read', 'Grep'], canSpawn: false })
    expect(ctx.roles[0].spawnable).toContain(tester!.id)
    // The adapter heard of it once, with what RunManager applied.
    expect(session.configChanges).toEqual([{ roles: { added: [tester!.id], changed: ['r-lead'], removed: [] } }])
    // The report ran on the new role through the normal spawn path and finished.
    expect(lastAgent(ctx, MOCK_ROSTER_REPORT)).toMatchObject({ roleId: tester!.id, roleSlug: MOCK_ROSTER_TESTER.slug, name: MOCK_ROSTER_TESTER.name, parentId: ROOT_AGENT_ID, state: 'done', result: MOCK_ROSTER_RESULT })
    expect(toolResults(ctx, ROOT_AGENT_ID).some((b) => b.content === MOCK_ROSTER_RESULT && !b.isError)).toBe(true)
    const closing = rootTexts(ctx).find((t) => t.startsWith(MOCK_ORG_CHANGE_APPROVED))!
    expect(closing).toContain('APPROVED.')
    expect(closing).toContain(`Available now: you can delegate to ${MOCK_ROSTER_TESTER.name}`)
    // The default script did not run.
    expect(rootTexts(ctx)).not.toContain('Planning the work: I will read the project, delegate the change and review the result.')
    await session.stop()
    await session.finished
  })

  it.each(['decline', 'revise'] as const)('%s: nothing changes, no report, the turn ends normally', async (decide) => {
    const ctx = recordingCtx({ decide })
    const before = structuredClone(ctx.roles)
    const session = await start(ctx)
    await vi.waitFor(() => expect(rootTexts(ctx)).toContain(MOCK_ORG_CHANGE_DECLINED))
    await idle(ctx)
    expect(ctx.requestProposal).toHaveBeenCalledTimes(1)
    expect(ctx.roles).toEqual(before)
    expect(session.configChanges).toEqual([])
    expect(lastAgent(ctx, MOCK_ROSTER_REPORT)).toBeUndefined()
    await session.stop()
    await session.finished
  })

  it('on a run without propose_org_change: warns and goes on', async () => {
    // A custom script calling the orgChange step on a run kind whose tools lack propose_org_change.
    const ctx = recordingCtx({ prompt: 'x' })
    ctx.run = runSummary({ kind: 'mcp-assist' })
    const session = await start(ctx, { mcpAssist: [{ type: 'orgChange' }] })
    await vi.waitFor(() => expect(rootTexts(ctx)).toContain(MOCK_ORG_CHANGE_NONE))
    const warns = ctx.events.flatMap((e) => (e.type === 'log' && e.level === 'warn' ? [e.message] : []))
    expect(warns.some((m) => m.startsWith('Mock script calls unknown harness tool propose_org_change'))).toBe(true)
    expect(ctx.requestProposal).not.toHaveBeenCalled()
    await session.stop()
    await session.finished
  })
})

describe('mock spawn path reads the live roster', () => {
  /** The chart without Reviewer, with QA added (both through the real tool and applyRosterChange). */
  function withoutReviewerWithQa(): Record<string, unknown> {
    const args = orgChangeArgs(orgChart()) as { roles: Record<string, unknown>[] }
    const roles = args.roles.filter((r) => r.name !== 'Reviewer').map((r) => (r.name === MOCK_ROSTER_TESTER.name ? { ...r, name: 'QA' } : r))
    roles[0] = { ...roles[0], spawnable: ['Engineer', 'QA'] }
    return { title: 'Swap reviewer for QA', rationale: 'r', roles }
  }

  it('refuses a removed role at once, spawns an added one at once, and lets a running agent of the removed role finish', async () => {
    const ctx = recordingCtx({ prompt: 'go' })
    const session = await start(ctx, {
      work: [
        { type: 'spawn', id: 'rev-1', role: 'reviewer', description: 'Review before the change' },
        { type: 'harness', name: 'propose_org_change', args: withoutReviewerWithQa(), retryOnRevise: false },
        { type: 'tool', agent: 'rev-1', name: 'Read', input: { file_path: 'README.md' }, result: 'x' },
        { type: 'finish', id: 'rev-1', result: 'Reviewed on the old definition.' },
        { type: 'spawn', id: 'rev-2', role: 'reviewer', description: 'Review again' },
        { type: 'finish', id: 'rev-2', result: 'never' },
        { type: 'spawn', id: 'qa-1', role: 'qa', description: 'Check' },
        { type: 'finish', id: 'qa-1', result: 'QA done.' },
        { type: 'text', text: 'End.' }
      ]
    })
    await vi.waitFor(() => expect(rootTexts(ctx)).toContain('End.'))
    expect(ctx.roles.map((r) => r.slug)).toEqual(['lead', 'engineer', 'qa'])
    expect(ctx.retired.map((r) => r.slug)).toEqual(['reviewer'])
    const qaId = ctx.roles.find((r) => r.slug === 'qa')!.id
    expect(session.configChanges).toEqual([{ roles: { added: [qaId], changed: ['r-lead'], removed: ['r-rev'] } }])
    // The agent that started on Reviewer finished as it started (its name resolved through ctx.retiredRoles()).
    expect(lastAgent(ctx, 'rev-1')).toMatchObject({ roleId: 'r-rev', name: 'Reviewer', state: 'done', result: 'Reviewed on the old definition.' })
    // A new Reviewer is refused with a tool error; its later steps are skipped (no agent, no finish).
    expect(lastAgent(ctx, 'rev-2')).toBeUndefined()
    const refusal = toolResults(ctx, ROOT_AGENT_ID).find((b) => b.isError && /removed from this run's org chart/.test(String(b.content)))
    expect(refusal?.content).toContain('"Reviewer"')
    expect(ctx.events.some((e) => e.type === 'log' && e.level === 'warn' && e.message === "Blocked spawn: lead -> reviewer (not in this run's roles)")).toBe(true)
    // The added role is spawnable at once.
    expect(lastAgent(ctx, 'qa-1')).toMatchObject({ roleId: qaId, name: 'QA', state: 'done', result: 'QA done.' })
    await session.stop()
    await session.finished
  })

  it('refuses a role the run never had', async () => {
    const ctx = recordingCtx({ prompt: 'go' })
    const session = await start(ctx, { work: [{ type: 'spawn', id: 'x-1', role: 'ghost', description: 'Haunt' }, { type: 'finish', id: 'x-1', result: 'boo' }, { type: 'text', text: 'End.' }] })
    await vi.waitFor(() => expect(rootTexts(ctx)).toContain('End.'))
    expect(lastAgent(ctx, 'x-1')).toBeUndefined()
    expect(toolResults(ctx, ROOT_AGENT_ID).find((b) => b.isError)?.content).toBe('There is no role "ghost" in this run\'s org chart.')
    await session.stop()
    await session.finished
  })
})

describe('[mock:org-change] through RunManager (the path e2e drives)', () => {
  it('the approved chart reaches the running mock session and Roster Tester reports back in the same run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orgai-mock-roster-'))
    try {
      mkdirSync(join(dir, 'repo'))
      const events: RunEvent[] = []
      const store = new ProjectStore(join(dir, 'data'))
      const created = store.create({ name: 'Roster', path: join(dir, 'repo'), brief: '' })
      const p = store.save({ ...created, provider: { ...created.provider, id: 'mock' }, roles: orgChart() })
      const m = new RunManager({ mock: new MockAdapter({ script: { delayMs: 0 } }) }, (e) => void events.push(e), new RunStore(join(dir, 'data')), new SetupService(store), () => 100, { liveRosterCards: true })
      const run = await m.start({ project: p, prompt: `Add a role ${ORG_CHANGE_TOKEN}` })
      await vi.waitFor(() => expect(events.some((e) => e.type === 'proposal.request')).toBe(true), { timeout: 5000 })
      const card = events.find((e): e is Extract<RunEvent, { type: 'proposal.request' }> => e.type === 'proposal.request')!
      expect(card.proposal).toMatchObject({ kind: 'orgChart', title: 'Add a Roster Tester', effect: 'now' })
      m.decideProposal(run.id, card.proposal.id, { behavior: 'approve' })
      const rootText = (): string[] => events.flatMap((e) => (e.type === 'transcript' && e.entry.agentId === ROOT_AGENT_ID && e.entry.block.kind === 'text' ? [e.entry.block.text] : []))
      await vi.waitFor(() => expect(rootText().some((t) => t.startsWith(MOCK_ORG_CHANGE_APPROVED))).toBe(true), { timeout: 5000 })
      expect(rootText().find((t) => t.startsWith(MOCK_ORG_CHANGE_APPROVED))).toContain(`Available now: you can delegate to ${MOCK_ROSTER_TESTER.name}`)
      const report = events.flatMap((e) => (e.type === 'agent.upsert' && e.agent.id === MOCK_ROSTER_REPORT ? [e.agent] : [])).at(-1)
      expect(report).toMatchObject({ roleSlug: MOCK_ROSTER_TESTER.slug, name: MOCK_ROSTER_TESTER.name, state: 'done', result: MOCK_ROSTER_RESULT })
      const roster = events.find((e): e is Extract<RunEvent, { type: 'run.roster' }> => e.type === 'run.roster')
      expect(roster?.roster.find((r) => r.name === MOCK_ROSTER_TESTER.name)).toMatchObject({ slug: MOCK_ROSTER_TESTER.slug, added: true })
      expect(roster?.change).toMatchObject({ changed: ['r-lead'], removed: [], deferred: [] })
      // Saved for future runs too.
      expect(store.get(p.id)?.roles.some((r) => r.slug === MOCK_ROSTER_TESTER.slug)).toBe(true)
      await m.stopAll()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
