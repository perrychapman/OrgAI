import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppNavigateEvent, Project, Proposal, QuickRunInfo, RunEvent } from '@shared/types'
import { OPEN_IN_APP_MIN_INTERVAL_MS, OPEN_IN_APP_PER_RUN_MAX } from '@shared/types'
import { RunManager, type RunManagerOptions } from './runManager'
import { RunStore } from '../store/runs'
import type { SetupService } from '../setup/service'
import type { RuntimeAdapter, RuntimeContext, SelfKnowledgeHooks } from './types'
import { project as makeProject } from './testHelpers'

vi.mock('../log', () => ({ logRunEvent: () => {}, logPermission: () => {}, log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } }))
// The atlas skeleton has no project-scope data yet: give a few pinned ids a scope.
vi.mock('@shared/view/atlas', async (orig) => {
  const actual = await orig<typeof import('@shared/view/atlas')>()
  const scopes: Record<string, string> = { dashboard: 'app', 'chat-start': 'assistant', 'project-settings-general': 'project', 'project-knowledge': 'engagement', 'project-live': 'run' }
  return { ...actual, atlasSurface: (id: string) => (scopes[id] ? { ...(actual.atlasSurface(id as never) ?? { id, kind: 'view', path: [id], reach: [] }), scope: scopes[id] } : actual.atlasSurface(id as never)) }
})

let dir: string
let events: RunEvent[]

beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'orgai-rmsk-')))
  events = []
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(1_000_000)
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

const folder = (): string => {
  const p = join(dir, 'work')
  mkdirSync(p, { recursive: true })
  return p
}
const quickInfo = (): QuickRunInfo => ({ folder: folder(), team: 'single', allowEdits: false, gitRepo: false })
const quickProj = (): Project => makeProject({ id: 'quick', name: 'Chat', path: folder(), runMessaging: false })

function hooks(over: Partial<SelfKnowledgeHooks> = {}): SelfKnowledgeHooks & { navigate: ReturnType<typeof vi.fn>; applyAppSettings: ReturnType<typeof vi.fn>; reference: ReturnType<typeof vi.fn> } {
  return {
    reference: vi.fn(async () => ({ text: 'ref' })),
    navigate: vi.fn(() => true),
    settings: vi.fn(() => ({ appearance: { theme: 'dark' } }) as never),
    applyAppSettings: vi.fn(),
    ...over
  } as never
}

function rig(options: RunManagerOptions = {}) {
  const ctxs: RuntimeContext[] = []
  const adapter: RuntimeAdapter = {
    id: 'mock',
    complete: async () => '',
    start: async (ctx) => {
      ctxs.push(ctx)
      ctx.emit({ type: 'run.status', runId: ctx.run.id, status: 'running', sessionId: 's' })
      return { send: async () => {}, interrupt: async () => {}, stop: async () => {}, finished: new Promise<void>(() => {}) }
    }
  }
  const raw = {
    applyProposal: vi.fn((_id: string, _p: Proposal, _o?: unknown) => makeProject({ id: 'p_real', name: 'Real' })),
    applySkillsLibraryProposal: vi.fn(),
    applyLibraryProposal: vi.fn(),
    markScaffolded: vi.fn(),
    markArchitectureUpdated: vi.fn(),
    hiddenContext: vi.fn(() => 'profile')
  }
  const store = new RunStore(join(dir, 'data'))
  const m = new RunManager({ mock: adapter }, (e) => void events.push(e), store, raw as unknown as SetupService, () => 100, options)
  return { m, ctxs, raw }
}

const stored = (id: string, over: Partial<Project> = {}): Project => makeProject({ id, name: `Name ${id}`, ...over })

async function chat(options: RunManagerOptions) {
  const r = rig(options)
  await r.m.start({ project: quickProj(), prompt: 'hi', quick: quickInfo() })
  return { ...r, ctx: r.ctxs[0] }
}

describe('self-knowledge context hooks', () => {
  it('binds nothing without options.selfKnowledge', async () => {
    const { ctx } = await chat({})
    expect(ctx.appReference).toBeUndefined()
    expect(ctx.navigate).toBeUndefined()
    expect(ctx.appSettings).toBeUndefined()
    expect(ctx.storedProject).toBeUndefined()
  })

  it('Chat gets reference (with status), navigate, appSettings and storedProject', async () => {
    const sk = hooks()
    const { ctx } = await chat({ selfKnowledge: sk, resolveProject: (id) => (id === 'p_real' ? stored('p_real') : id === 'quick' ? quickProj() : null) })
    await ctx.appReference!({ action: 'status' })
    expect(sk.reference).toHaveBeenCalledWith({ action: 'status' }, { status: true })
    expect(ctx.navigate).toBeTypeOf('function')
    expect(ctx.appSettings!()).toEqual({ appearance: { theme: 'dark' } })
    expect(ctx.storedProject!('p_real')?.id).toBe('p_real')
    expect(ctx.storedProject!('quick')).toBeUndefined()
    expect(ctx.storedProject!('harness')).toBeUndefined()
    expect(ctx.storedProject!('missing')).toBeUndefined()
  })

  it('a work run gets only the reference, with status refused', async () => {
    const sk = hooks()
    const { m, ctxs } = rig({ selfKnowledge: sk })
    await m.start({ project: makeProject({ path: folder() }), prompt: 'work' })
    const ctx = ctxs[0]
    await ctx.appReference!({ action: 'search', query: 'x' })
    expect(sk.reference).toHaveBeenCalledWith({ action: 'search', query: 'x' }, { status: false })
    expect(ctx.navigate).toBeUndefined()
    expect(ctx.appSettings).toBeUndefined()
    expect(ctx.storedProject).toBeUndefined()
  })

  it('setup-like runs get navigate but not the proposal context', async () => {
    const sk = hooks()
    const { m, ctxs } = rig({ selfKnowledge: sk })
    await m.start({ project: makeProject({ id: 'skills', roles: [], path: folder() }), prompt: 'x', kind: 'skill-assist' })
    const ctx = ctxs[0]
    expect(ctx.navigate).toBeTypeOf('function')
    expect(ctx.appSettings).toBeUndefined()
    await ctx.appReference!({ action: 'status' })
    expect(sk.reference).toHaveBeenCalledWith({ action: 'status' }, { status: true })
  })
})

describe('navigate (open_in_app)', () => {
  const resolveProject = (id: string): Project | null => (id === 'p_code' ? stored('p_code') : id === 'p_eng' ? stored('p_eng', { kind: 'engagement' }) : null)

  it('opens an app place, drops a projectId, and writes one harness row', async () => {
    const sk = hooks()
    const { ctx } = await chat({ selfKnowledge: sk, resolveProject })
    const out = ctx.navigate!({ surfaceId: 'dashboard', projectId: 'p_code' }, {})
    expect(out).toEqual({ ok: true, path: expect.any(String) })
    const event = sk.navigate.mock.calls[0][0] as AppNavigateEvent
    expect(event).toMatchObject({ surfaceId: 'dashboard', runId: expect.any(String) })
    expect(event).not.toHaveProperty('projectId')
    expect(event.agentLabel.length).toBeGreaterThan(0)
    expect(event.agentLabel.length).toBeLessThanOrEqual(80)
    const rows = events.filter((e) => e.type === 'transcript' && e.entry.source === 'harness' && e.entry.block.kind === 'system' && /^Opened .* for you$/.test(e.entry.block.text))
    expect(rows).toHaveLength(1)
  })

  it('needs a stored project for project and engagement places, and an engagement for engagement places', async () => {
    const sk = hooks()
    const { ctx } = await chat({ selfKnowledge: sk, resolveProject })
    const step = (): void => void vi.setSystemTime(Date.now() + OPEN_IN_APP_MIN_INTERVAL_MS)
    expect(ctx.navigate!({ surfaceId: 'project-settings-general' }, {})).toMatchObject({ ok: false, refusal: expect.stringContaining('projectId') })
    expect(ctx.navigate!({ surfaceId: 'project-settings-general', projectId: 'nope' }, {})).toMatchObject({ ok: false, refusal: expect.stringContaining('No such project') })
    expect(ctx.navigate!({ surfaceId: 'project-settings-general', projectId: 'quick' }, {})).toMatchObject({ ok: false })
    expect(ctx.navigate!({ surfaceId: 'project-knowledge', projectId: 'p_code' }, {})).toMatchObject({ ok: false, refusal: expect.stringContaining('engagement') })
    expect(sk.navigate).not.toHaveBeenCalled()
    expect(ctx.navigate!({ surfaceId: 'project-settings-general', projectId: 'p_code' }, {})).toMatchObject({ ok: true })
    step()
    expect(ctx.navigate!({ surfaceId: 'project-knowledge', projectId: 'p_eng' }, {})).toMatchObject({ ok: true })
    expect((sk.navigate.mock.calls[1][0] as AppNavigateEvent).projectId).toBe('p_eng')
    // A run place may omit the project.
    step()
    expect(ctx.navigate!({ surfaceId: 'project-live' }, {})).toMatchObject({ ok: true })
    expect(sk.navigate.mock.calls[2][0]).not.toHaveProperty('projectId')
  })

  it('refuses an unknown surface id', async () => {
    const { ctx } = await chat({ selfKnowledge: hooks(), resolveProject })
    expect(ctx.navigate!({ surfaceId: 'x' as never }, {})).toMatchObject({ ok: false })
  })

  it('allows one place per interval', async () => {
    const sk = hooks()
    const { ctx } = await chat({ selfKnowledge: sk, resolveProject })
    expect(ctx.navigate!({ surfaceId: 'dashboard' }, {}).ok).toBe(true)
    expect(ctx.navigate!({ surfaceId: 'dashboard' }, {})).toEqual({ ok: false, refusal: 'Wait a moment before opening another place.' })
    vi.setSystemTime(Date.now() + OPEN_IN_APP_MIN_INTERVAL_MS - 1)
    expect(ctx.navigate!({ surfaceId: 'dashboard' }, {}).ok).toBe(false)
    vi.setSystemTime(Date.now() + 1)
    expect(ctx.navigate!({ surfaceId: 'dashboard' }, {}).ok).toBe(true)
    expect(sk.navigate).toHaveBeenCalledTimes(2)
  })

  it('stops at the per-run maximum', async () => {
    const sk = hooks()
    const { ctx } = await chat({ selfKnowledge: sk, resolveProject })
    for (let i = 0; i < OPEN_IN_APP_PER_RUN_MAX; i++) {
      expect(ctx.navigate!({ surfaceId: 'dashboard' }, {}).ok).toBe(true)
      vi.setSystemTime(Date.now() + OPEN_IN_APP_MIN_INTERVAL_MS)
    }
    expect(ctx.navigate!({ surfaceId: 'dashboard' }, {})).toEqual({ ok: false, refusal: `Already opened ${OPEN_IN_APP_PER_RUN_MAX} places in this run.` })
    expect(sk.navigate).toHaveBeenCalledTimes(OPEN_IN_APP_PER_RUN_MAX)
  })

  it('says so when no window can show it, and counts nothing then', async () => {
    const sk = hooks({ navigate: vi.fn(() => false) })
    const { ctx } = await chat({ selfKnowledge: sk, resolveProject })
    expect(ctx.navigate!({ surfaceId: 'dashboard' }, {})).toEqual({ ok: false, refusal: 'No OrgAI window is open to show it in.' })
    expect(ctx.navigate!({ surfaceId: 'dashboard' }, {})).toEqual({ ok: false, refusal: 'No OrgAI window is open to show it in.' })
    expect(events.some((e) => e.type === 'transcript' && e.entry.block.kind === 'system' && /^Opened/.test(e.entry.block.text))).toBe(false)
  })
})

describe('proposal apply paths', () => {
  const appPayload = { rationale: 'r', changes: [{ field: 'appearance.theme', from: 'dark', to: 'light', label: 'Theme' }] }

  it('appSettings: calls applyAppSettings with the payload, effect now, approve', async () => {
    const sk = hooks()
    const { m, ctx } = await chat({ selfKnowledge: sk })
    const pending = ctx.requestProposal({ kind: 'appSettings', agentId: 'root', title: 'T', payload: appPayload } as never)
    const card = events.find((e): e is Extract<RunEvent, { type: 'proposal.request' }> => e.type === 'proposal.request')!
    expect(card.proposal.effect).toBe('now')
    m.decideProposal(ctx.run.id, card.proposal.id, { behavior: 'approve' })
    expect(await pending).toEqual({ behavior: 'approve' })
    expect(sk.applyAppSettings).toHaveBeenCalledWith(appPayload)
  })

  it('appSettings: a refusal from the settings path comes back as revise', async () => {
    const sk = hooks({ applyAppSettings: vi.fn(() => { throw new Error('Theme is not valid.') }) })
    const { m, ctx } = await chat({ selfKnowledge: sk })
    const pending = ctx.requestProposal({ kind: 'appSettings', agentId: 'root', title: 'T', payload: appPayload } as never)
    const card = events.find((e): e is Extract<RunEvent, { type: 'proposal.request' }> => e.type === 'proposal.request')!
    const outcome = m.decideProposal(ctx.run.id, card.proposal.id, { behavior: 'approve' })
    expect(await pending).toEqual({ behavior: 'revise', feedback: 'The harness could not apply this proposal: Theme is not valid.' })
    expect(outcome).toMatchObject({ applyError: expect.stringContaining('Theme is not valid.') })
  })

  it('appSettings from a work run is refused', async () => {
    const sk = hooks()
    const { m, ctxs } = rig({ selfKnowledge: sk })
    await m.start({ project: makeProject({ path: folder() }), prompt: 'work' })
    const ctx = ctxs[0]
    const pending = ctx.requestProposal({ kind: 'appSettings', agentId: 'root', title: 'T', payload: appPayload } as never)
    const card = events.find((e): e is Extract<RunEvent, { type: 'proposal.request' }> => e.type === 'proposal.request')!
    m.decideProposal(ctx.run.id, card.proposal.id, { behavior: 'approve' })
    expect(await pending).toMatchObject({ behavior: 'revise', feedback: expect.stringContaining('only be changed from Chat') })
    expect(sk.applyAppSettings).not.toHaveBeenCalled()
  })

  const settingsReq = { kind: 'settings', agentId: 'root', title: 'T', payload: { rationale: 'r', autoContinue: true }, target: { projectId: 'p_real', projectName: 'Real' } }

  it('targeted settings: re-resolves the project, applies with targeted, broadcasts project.updated, stays next-run', async () => {
    const { m, ctx, raw } = await chat({ selfKnowledge: hooks(), resolveProject: (id) => (id === 'p_real' ? stored('p_real') : null) })
    const pending = ctx.requestProposal(settingsReq as never)
    const card = events.find((e): e is Extract<RunEvent, { type: 'proposal.request' }> => e.type === 'proposal.request')!
    expect(card.proposal.effect).toBe('next-run')
    expect(card.proposal.target).toEqual({ projectId: 'p_real', projectName: 'Real' })
    m.decideProposal(ctx.run.id, card.proposal.id, { behavior: 'approve' })
    expect(await pending).toEqual({ behavior: 'approve' })
    expect(raw.applyProposal).toHaveBeenCalledTimes(1)
    expect(raw.applyProposal.mock.calls[0][0]).toBe('p_real')
    expect(raw.applyProposal.mock.calls[0][2]).toEqual({ targeted: true })
    const updated = events.find((e): e is Extract<RunEvent, { type: 'project.updated' }> => e.type === 'project.updated')
    expect(updated).toMatchObject({ runId: ctx.run.id, project: { id: 'p_real' } })
  })

  it('targeted settings: a vanished project revises and applies nothing', async () => {
    let present = true
    const { m, ctx, raw } = await chat({ selfKnowledge: hooks(), resolveProject: (id) => (id === 'p_real' && present ? stored('p_real') : null) })
    const pending = ctx.requestProposal(settingsReq as never)
    present = false
    const card = events.find((e): e is Extract<RunEvent, { type: 'proposal.request' }> => e.type === 'proposal.request')!
    m.decideProposal(ctx.run.id, card.proposal.id, { behavior: 'approve' })
    expect(await pending).toMatchObject({ behavior: 'revise', feedback: expect.stringContaining('no longer exists') })
    expect(raw.applyProposal).not.toHaveBeenCalled()
  })

  it('a target from any run other than Chat is refused, and never on a virtual project', async () => {
    const { m, ctxs, raw } = rig({ selfKnowledge: hooks(), resolveProject: (id) => (id === 'p_real' ? stored('p_real') : null) })
    await m.start({ project: makeProject({ path: folder() }), prompt: 'work' })
    const ctx = ctxs[0]
    const pending = ctx.requestProposal(settingsReq as never)
    const card = events.find((e): e is Extract<RunEvent, { type: 'proposal.request' }> => e.type === 'proposal.request')!
    m.decideProposal(ctx.run.id, card.proposal.id, { behavior: 'approve' })
    expect(await pending).toMatchObject({ behavior: 'revise', feedback: expect.stringContaining('Only Chat') })
    expect(raw.applyProposal).not.toHaveBeenCalled()
    const chatRun = await chat({ selfKnowledge: hooks(), resolveProject: (id) => (id === 'quick' ? quickProj() : null) })
    const p2 = chatRun.ctx.requestProposal({ ...settingsReq, target: { projectId: 'quick', projectName: 'Chat' } } as never)
    const c2 = events.filter((e): e is Extract<RunEvent, { type: 'proposal.request' }> => e.type === 'proposal.request').at(-1)!
    chatRun.m.decideProposal(chatRun.ctx.run.id, c2.proposal.id, { behavior: 'approve' })
    expect(await p2).toMatchObject({ behavior: 'revise' })
    expect(chatRun.raw.applyProposal).not.toHaveBeenCalled()
  })
})
