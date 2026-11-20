import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ContextLossWatch,
  FACTORY_3D_MAX_AGENTS,
  currentAgentCount,
  factoryNotice,
  factoryReason,
  noticeCopy,
  type LostState,
  type ReasonInput
} from './fallback'
import { CONTEXT_LOSS_WINDOW_MS, CONTEXT_RESTORE_TIMEOUT_MS } from './capability'

const OK: ReasonInput = { forced: null, webgl2: true, rendererFailed: false, currentAgents: 5, lost: 'none', chunkFailed: false }
const agents = (current: number, earlier = 0): { session: 'current' | 'earlier' }[] => [
  ...Array.from({ length: earlier }, () => ({ session: 'earlier' as const })),
  ...Array.from({ length: current }, () => ({ session: 'current' as const }))
]

describe('factoryReason', () => {
  it('shows 3D when nothing is wrong', () => {
    expect(factoryReason(OK)).toBeUndefined()
  })

  it('shows 3D up to 120 current-session agents and the floor plan from 121', () => {
    expect(FACTORY_3D_MAX_AGENTS).toBe(120)
    expect(factoryReason({ ...OK, currentAgents: currentAgentCount(agents(120)) })).toBeUndefined()
    expect(factoryReason({ ...OK, currentAgents: currentAgentCount(agents(121)) })).toBe('too-many')
  })

  it('never counts earlier-session agents', () => {
    expect(currentAgentCount(agents(120, 30))).toBe(120)
    expect(factoryReason({ ...OK, currentAgents: currentAgentCount(agents(120, 30)) })).toBeUndefined()
    expect(currentAgentCount([])).toBe(0)
  })

  it('orders the reasons forced > no-webgl2 > too-many > context-lost > chunk-failed', () => {
    const all: ReasonInput = { forced: 'floor-plan', webgl2: false, rendererFailed: true, currentAgents: 500, lost: 'third', chunkFailed: true }
    expect(factoryReason(all)).toBe('forced')
    expect(factoryReason({ ...all, forced: null })).toBe('no-webgl2')
    expect(factoryReason({ ...all, forced: null, webgl2: true, rendererFailed: false })).toBe('too-many')
    expect(factoryReason({ ...all, forced: null, webgl2: true, rendererFailed: false, currentAgents: 120 })).toBe('context-lost')
    expect(factoryReason({ ...all, forced: null, webgl2: true, rendererFailed: false, currentAgents: 120, lost: 'none' })).toBe('chunk-failed')
  })

  it('maps each cause to its reason', () => {
    expect(factoryReason({ ...OK, forced: 'no-webgl2' })).toBe('no-webgl2')
    expect(factoryReason({ ...OK, webgl2: false })).toBe('no-webgl2')
    expect(factoryReason({ ...OK, rendererFailed: true })).toBe('no-webgl2')
    expect(factoryReason({ ...OK, lost: 'gave-up' })).toBe('context-lost')
    expect(factoryReason({ ...OK, lost: 'third' })).toBe('context-lost')
    // Restoring keeps the 3D view (the stage note shows over the last frame).
    expect(factoryReason({ ...OK, lost: 'restoring' })).toBeUndefined()
    expect(factoryReason({ ...OK, chunkFailed: true })).toBe('chunk-failed')
  })
})

describe('factoryNotice and noticeCopy', () => {
  it('picks the banner for each reason', () => {
    expect(factoryNotice(undefined, 'none', false)).toBeNull()
    expect(factoryNotice('forced', 'none', false)).toBeNull()
    expect(factoryNotice('no-webgl2', 'none', false)).toBe('no-webgl2')
    expect(factoryNotice('no-webgl2', 'none', true)).toBeNull()
    expect(factoryNotice('too-many', 'none', true)).toBe('too-many')
    expect(factoryNotice('context-lost', 'gave-up', false)).toBe('lost')
    expect(factoryNotice('context-lost', 'third', false)).toBe('third-loss')
    expect(factoryNotice('chunk-failed', 'none', false)).toBe('chunk-failed')
  })

  it('uses the exact section 8 copy', () => {
    expect(noticeCopy('too-many', 121)).toEqual({
      tone: 'info',
      title: 'Large team',
      body: 'This team has 121 agents. The 3D floor shows up to 120, so the floor plan is shown.',
      retry: false,
      dismissible: false
    })
    expect(noticeCopy('no-webgl2', 0)).toMatchObject({ tone: 'info', title: '3D view unavailable', body: 'This computer did not give OrgAI WebGL 2, so the factory is shown as a floor plan.', retry: false, dismissible: true })
    expect(noticeCopy('chunk-failed', 0)).toMatchObject({ tone: 'warning', title: '3D view did not load', body: 'OrgAI could not load the 3D renderer. Showing the floor plan.', retry: true })
    expect(noticeCopy('lost', 0)).toMatchObject({ tone: 'warning', title: '3D view stopped', body: 'The graphics context was lost and did not come back. Showing the floor plan.', retry: true })
    expect(noticeCopy('third-loss', 0)).toMatchObject({ tone: 'warning', title: '3D view stopped', body: 'The 3D view stopped 3 times, so OrgAI switched to the floor plan for this session.', retry: true })
  })
})

describe('ContextLossWatch', () => {
  let clock = 0
  let session: { losses: number[]; floorPlanForSession: boolean }
  let changes: LostState[]
  const make = (): ContextLossWatch =>
    new ContextLossWatch({
      now: () => clock,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      session,
      onChange: (s) => changes.push(s)
    })

  beforeEach(() => {
    vi.useFakeTimers()
    clock = 1_000_000
    session = { losses: [], floorPlanForSession: false }
    changes = []
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('gives up when the context is not restored within 5 s', () => {
    const w = make()
    expect(w.lost()).toBe('restoring')
    vi.advanceTimersByTime(CONTEXT_RESTORE_TIMEOUT_MS - 1)
    expect(w.state).toBe('restoring')
    vi.advanceTimersByTime(1)
    expect(w.state).toBe('gave-up')
    expect(changes).toEqual(['restoring', 'gave-up'])
    expect(session.floorPlanForSession).toBe(false)
  })

  it('a restore inside 5 s returns to 3D and cancels the timeout', () => {
    const w = make()
    w.lost()
    vi.advanceTimersByTime(4_000)
    w.restored()
    expect(w.state).toBe('none')
    vi.advanceTimersByTime(10_000)
    expect(w.state).toBe('none')
    expect(changes).toEqual(['restoring', 'none'])
  })

  it('a late restore after giving up changes nothing', () => {
    const w = make()
    w.lost()
    vi.advanceTimersByTime(CONTEXT_RESTORE_TIMEOUT_MS)
    w.restored()
    expect(w.state).toBe('gave-up')
  })

  it('the third loss within ten minutes switches to the floor plan for the session at once', () => {
    const w = make()
    w.lost()
    w.restored()
    clock += 60_000
    w.lost()
    w.restored()
    clock += 60_000
    expect(w.lost()).toBe('third')
    expect(session.floorPlanForSession).toBe(true)
    expect(session.losses).toHaveLength(3)
    // No restore timer is left running for the third loss.
    expect(vi.getTimerCount()).toBe(0)
    w.restored()
    expect(w.state).toBe('third')
    // A new mount in the same session starts on the floor plan.
    expect(make().state).toBe('third')
  })

  it('losses older than ten minutes do not count towards the third', () => {
    const w = make()
    w.lost()
    w.restored()
    clock += 60_000
    w.lost()
    w.restored()
    clock += CONTEXT_LOSS_WINDOW_MS
    expect(w.lost()).toBe('restoring')
    expect(session.floorPlanForSession).toBe(false)
  })

  it('reset ("Try 3D again") forgets the losses and the session switch', () => {
    const w = make()
    w.lost()
    w.lost()
    w.lost()
    expect(w.state).toBe('third')
    w.reset()
    expect(w.state).toBe('none')
    expect(session).toEqual({ losses: [], floorPlanForSession: false })
  })

  it('dispose clears the restore timer', () => {
    const w = make()
    w.lost()
    w.dispose()
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(CONTEXT_RESTORE_TIMEOUT_MS * 2)
    expect(w.state).toBe('restoring')
  })
})
