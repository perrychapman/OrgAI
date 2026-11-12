import { describe, expect, it } from 'vitest'
import {
  chooseAnimated, cueFrame, glanceFor, GLANCE_GAP_TICKS, GLANCE_TICKS, hashId, initialGlances, isTypingBurst, officeState, oneShotInProgress,
  stepGlances, type CuePerson, type GlanceState, type LoopCandidate, type OfficeState
} from './cues'

const STATES: OfficeState[] = ['idle', 'running', 'waiting', 'finished', 'failed']
const person = (over: Partial<CuePerson> = {}): CuePerson => ({ id: 'a', state: 'running', stateTick: null, animated: true, talking: false, ...over })
const POSES = new Set(['idle', 'work', 'type', 'wait', 'hand', 'done', 'error', 'walk-1', 'walk-2'])
const SCREENS = new Set(['crt', 'crt-b', 'crt-off', 'crt-error'])

describe('officeState', () => {
  it('collapses runtime statuses to the five office states', () => {
    for (const s of ['starting', 'thinking', 'tool', 'delegating', 'running']) expect(officeState(s)).toBe('running')
    expect(officeState('waiting')).toBe('waiting')
    for (const s of ['done', 'finished']) expect(officeState(s)).toBe('finished')
    for (const s of ['error', 'failed']) expect(officeState(s)).toBe('failed')
    for (const s of ['idle', 'Role', 'unknown', '']) expect(officeState(s)).toBe('idle')
  })
})

describe('hashId', () => {
  it('is a stable unsigned 32-bit hash', () => {
    expect(hashId('a')).toBe(hashId('a'))
    expect(hashId('a')).not.toBe(hashId('b'))
    for (const id of ['', 'a', 'agent-1', 'x'.repeat(200)]) { const h = hashId(id); expect(Number.isInteger(h) && h >= 0 && h < 2 ** 32).toBe(true) }
    expect(hashId('')).toBe(0x811c9dc5)
  })
})

describe('cueFrame state grammar', () => {
  it('only ever outputs known poses and screens, deterministically, for every state over a full period and beyond', () => {
    for (const state of STATES) for (const animated of [true, false]) for (const talking of [true, false]) for (const stateTick of [null, 0, 7]) {
      for (let tick = 0; tick < 80; tick++) {
        const p = person({ id: `p-${state}`, state, animated, talking, stateTick })
        const f = cueFrame(p, tick, 'live')
        expect(f).toEqual(cueFrame({ ...p }, tick, 'live'))
        expect(POSES.has(f.pose) && SCREENS.has(f.screen)).toBe(true)
        expect(['up', 'down']).toContain(f.direction)
        expect([0, 1]).toContain(f.offsetY)
        expect([null, 'wait', 'done', 'error', 'talk']).toContain(f.mark)
      }
    }
  })

  it('running: work/type up, lit screen flickering, no mark; typing burst 8 ticks then 12 held; period 20', () => {
    const id = 'a'; const phase = hashId(id) % 20
    const frames = Array.from({ length: 20 }, (_, t) => cueFrame(person({ id }), t - phase + 20 * 3, 'live'))
    expect(frames.map(f => f.pose)).toEqual(['type', 'type', 'work', 'work', 'type', 'type', 'work', 'work', ...Array(12).fill('work')])
    for (const f of frames) expect(f).toMatchObject({ direction: 'up', mark: null, cue: 'typing', offsetY: 0 })
    expect(new Set(Array.from({ length: 40 }, (_, t) => cueFrame(person(), t, 'live').screen))).toEqual(new Set(['crt', 'crt-b']))
    for (let t = 0; t < 40; t++) expect(cueFrame(person(), t, 'live').pose).toBe(cueFrame(person(), t + 20, 'live').pose)
    expect(isTypingBurst(id, 20 * 3 - phase)).toBe(true)
    expect(isTypingBurst(id, 20 * 3 - phase + 8)).toBe(false)
  })

  it('running screen flicker holds each frame 4 ticks', () => {
    const screens = Array.from({ length: 24 }, (_, t) => cueFrame(person(), t, 'live').screen)
    let run = 1; const runs: number[] = []
    for (let i = 1; i < screens.length; i++) { if (screens[i] === screens[i - 1]) run++; else { runs.push(run); run = 1 } }
    expect(runs.length).toBeGreaterThan(2)
    expect(runs.slice(1).every(r => r === 4)).toBe(true)
  })

  it('people do not all move in lockstep', () => {
    const poses = new Set(Array.from({ length: 12 }, (_, i) => cueFrame(person({ id: `agent-${i}` }), 0, 'live').pose + cueFrame(person({ id: `agent-${i}` }), 0, 'live').screen))
    expect(poses.size).toBeGreaterThan(1)
  })

  it('idle: idle up, dark screen, no mark, never loops', () => {
    for (let t = 0; t < 40; t++) expect(cueFrame(person({ state: 'idle' }), t, 'live')).toEqual({ pose: 'idle', direction: 'up', screen: 'crt-off', mark: null, cue: 'none', offsetY: 0 })
  })

  it('waiting: wait/hand down every 4 ticks, steady screen, wait mark', () => {
    const frames = Array.from({ length: 16 }, (_, t) => cueFrame(person({ state: 'waiting' }), t, 'live'))
    expect(new Set(frames.map(f => f.pose))).toEqual(new Set(['wait', 'hand']))
    for (const f of frames) expect(f).toMatchObject({ direction: 'down', screen: 'crt', mark: 'wait', cue: 'waving', offsetY: 0 })
    let run = 1; const runs: number[] = []
    for (let i = 1; i < frames.length; i++) { if (frames[i].pose === frames[i - 1].pose) run++; else { runs.push(run); run = 1 } }
    expect(runs.slice(1).every(r => r === 4)).toBe(true)
  })

  it('finished: cheer for 6 ticks from stateTick, then settled idle down with the done mark', () => {
    const p = person({ state: 'finished', stateTick: 10 })
    for (let t = 10; t < 16; t++) expect(cueFrame(p, t, 'live')).toEqual({ pose: 'done', direction: 'down', screen: 'crt-off', mark: 'done', cue: 'cheering', offsetY: 0 })
    for (let t = 16; t < 60; t++) expect(cueFrame(p, t, 'live')).toEqual({ pose: 'idle', direction: 'down', screen: 'crt-off', mark: 'done', cue: 'none', offsetY: 0 })
    expect(cueFrame(person({ state: 'finished', stateTick: null }), 0, 'live').pose).toBe('idle')
  })

  it('failed: error down with crt-error; slump 3 ticks, then held one pixel lower; settled failed starts lower', () => {
    const p = person({ state: 'failed', stateTick: 5 })
    for (let t = 5; t < 8; t++) expect(cueFrame(p, t, 'live')).toEqual({ pose: 'error', direction: 'down', screen: 'crt-error', mark: 'error', cue: 'slumping', offsetY: 0 })
    for (let t = 8; t < 60; t++) expect(cueFrame(p, t, 'live')).toEqual({ pose: 'error', direction: 'down', screen: 'crt-error', mark: 'error', cue: 'none', offsetY: 1 })
    expect(cueFrame(person({ state: 'failed', stateTick: null }), 0, 'live')).toMatchObject({ cue: 'none', offsetY: 1 })
  })

  it('one-shots report when they are over', () => {
    expect(oneShotInProgress('finished', 10, 15)).toBe(true)
    expect(oneShotInProgress('finished', 10, 16)).toBe(false)
    expect(oneShotInProgress('failed', 10, 12)).toBe(true)
    expect(oneShotInProgress('failed', 10, 13)).toBe(false)
    expect(oneShotInProgress('running', 10, 11)).toBe(false)
    expect(oneShotInProgress('finished', null, 0)).toBe(false)
  })

  it('animated: false gives the static equivalents with cue none at every tick', () => {
    const expected: Record<OfficeState, object> = {
      idle: { pose: 'idle', direction: 'up', screen: 'crt-off', mark: null, offsetY: 0 },
      running: { pose: 'work', direction: 'up', screen: 'crt', mark: null, offsetY: 0 },
      waiting: { pose: 'hand', direction: 'down', screen: 'crt', mark: 'wait', offsetY: 0 },
      finished: { pose: 'idle', direction: 'down', screen: 'crt-off', mark: 'done', offsetY: 0 },
      failed: { pose: 'error', direction: 'down', screen: 'crt-error', mark: 'error', offsetY: 1 }
    }
    for (const state of STATES) for (let t = 0; t < 30; t++) expect(cueFrame(person({ state, animated: false, stateTick: 0 }), t, 'live')).toEqual({ ...expected[state], cue: 'none' })
  })

  it('talk mark wins over the state mark while talking, then the state mark returns', () => {
    expect(cueFrame(person({ state: 'running', talking: true }), 3, 'live').mark).toBe('talk')
    expect(cueFrame(person({ state: 'waiting', talking: true }), 3, 'live').mark).toBe('talk')
    expect(cueFrame(person({ state: 'waiting', talking: false }), 3, 'live').mark).toBe('wait')
    expect(cueFrame(person({ state: 'running', talking: true, animated: false }), 3, 'live')).toMatchObject({ mark: 'talk', pose: 'work' })
  })

  it('team mode is idle up with a steady screen and nothing else; sample is one static work pose', () => {
    for (const state of STATES) for (let t = 0; t < 30; t++) {
      expect(cueFrame(person({ state, talking: true, stateTick: 0 }), t, 'team')).toEqual({ pose: 'idle', direction: 'up', screen: 'crt', mark: null, cue: 'none', offsetY: 0 })
      expect(cueFrame(person({ state, talking: true, stateTick: 0 }), t, 'sample')).toEqual({ pose: 'work', direction: 'up', screen: 'crt', mark: null, cue: 'none', offsetY: 0 })
    }
  })

  it('glance turns a seated running or idle person for its window only, keeping screen and state', () => {
    const running = person({ glanceUntil: 105, glanceDirection: 'right' })
    expect(cueFrame(running, 100, 'live')).toMatchObject({ pose: 'work', direction: 'right', cue: 'glance', mark: null })
    expect(cueFrame(running, 105, 'live').cue).toBe('typing')
    expect(cueFrame(person({ state: 'idle', glanceUntil: 105, glanceDirection: 'left' }), 100, 'live')).toEqual({ pose: 'idle', direction: 'left', screen: 'crt-off', mark: null, cue: 'glance', offsetY: 0 })
    expect(cueFrame(person({ state: 'waiting', glanceUntil: 105, glanceDirection: 'left' }), 100, 'live').cue).toBe('waving')
    expect(cueFrame(person({ glanceUntil: 105, glanceDirection: 'left' }), 100, 'team').cue).toBe('none')
  })
})

describe('chooseAnimated', () => {
  const c = (id: string, over: Partial<LoopCandidate> = {}): LoopCandidate => ({ id, state: 'running', selected: false, focused: false, inExchange: false, order: Number(id.slice(1)), ...over })
  it('caps at 12 in priority order: waiting, selected/focused, exchange, then running by order', () => {
    const people: LoopCandidate[] = Array.from({ length: 20 }, (_, i) => c(`r${i}`))
    people.push(c('r30', { state: 'waiting', order: 30 }), c('r31', { state: 'waiting', order: 31 }))
    people.push(c('r40', { selected: true, order: 40 }), c('r41', { focused: true, order: 41 }))
    people.push(c('r50', { inExchange: true, order: 50 }))
    const chosen = chooseAnimated(people)
    expect(chosen.size).toBe(12)
    for (const id of ['r30', 'r31', 'r40', 'r41', 'r50']) expect(chosen.has(id)).toBe(true)
    for (let i = 0; i < 7; i++) expect(chosen.has(`r${i}`)).toBe(true)
    expect(chosen.has('r7')).toBe(false)
  })
  it('lets waiting win a tight cap and shortens ties by order', () => {
    const people = [c('r1', { selected: true }), c('r2', { state: 'waiting', order: 2 }), c('r3', { inExchange: true }), c('r0')]
    expect([...chooseAnimated(people, 2)].sort()).toEqual(['r1', 'r2'])
    expect([...chooseAnimated(people, 3)].sort()).toEqual(['r1', 'r2', 'r3'])
    expect(chooseAnimated(people, 0).size).toBe(0)
  })
  it('never loops idle, finished or failed unless a one-shot is playing', () => {
    const people = [c('r1', { state: 'idle', selected: true }), c('r2', { state: 'finished' }), c('r3', { state: 'failed' }), c('r4', { state: 'finished', oneShot: true }), c('r5', { state: 'failed', oneShot: true })]
    expect([...chooseAnimated(people)].sort()).toEqual(['r4', 'r5'])
  })
  it('is deterministic whatever the input order', () => {
    const people = Array.from({ length: 30 }, (_, i) => c(`r${i}`))
    expect([...chooseAnimated(people.slice().reverse())].sort()).toEqual([...chooseAnimated(people)].sort())
  })
})

describe('glances', () => {
  const ids = Array.from({ length: 8 }, (_, i) => `agent-${i}`)
  const everyone = (over: Partial<{ eligible: boolean; typingBurst: boolean }> = {}) => ids.map(id => ({ id, eligible: true, typingBurst: false, ...over }))

  it('starts the first glance 25 to 40 s after the baseline, never before', () => {
    const s0 = initialGlances(ids, 100)
    const starts: number[] = []
    let state = s0
    for (let t = 100; t < 100 + 400; t++) { state = stepGlances(state, everyone(), t); if (state.active?.untilTick === t + GLANCE_TICKS) starts.push(t) }
    expect(starts.length).toBeGreaterThan(0)
    expect(starts[0] - 100).toBeGreaterThanOrEqual(208)
    expect(starts[0] - 100).toBeLessThan(208 + 125)
  })

  it('keeps one glance at a time, 5 ticks long, at least 25 ticks apart', () => {
    let state: GlanceState = initialGlances(ids, 0)
    const starts: { t: number; id: string }[] = []
    let concurrent = 0
    for (let t = 0; t < 4000; t++) {
      const before = state.active
      state = stepGlances(state, everyone(), t)
      if (state.active && state.active !== before) { starts.push({ t, id: state.active.id }); expect(state.active.untilTick - t).toBe(GLANCE_TICKS) }
      const people = ids.filter(id => glanceFor(state, id, t).glanceUntil !== undefined)
      concurrent = Math.max(concurrent, people.length)
    }
    expect(starts.length).toBeGreaterThan(10)
    expect(concurrent).toBe(1)
    for (let i = 1; i < starts.length; i++) expect(starts[i].t - starts[i - 1].t).toBeGreaterThanOrEqual(GLANCE_TICKS + GLANCE_GAP_TICKS)
    const first = starts[0].id
    const mine = starts.filter(s => s.id === first).map(s => s.t)
    for (let i = 1; i < mine.length; i++) expect(mine[i] - mine[i - 1]).toBeGreaterThanOrEqual(208)
  })

  it('spaces simultaneously due people at least 3 s apart', () => {
    let state = initialGlances(ids, 0)
    state = { ...state, nextDue: new Map(ids.map(id => [id, 10])) }
    const starts: number[] = []
    for (let t = 0; t < 120; t++) { const before = state.active; state = stepGlances(state, everyone(), t); if (state.active && state.active !== before) starts.push(t) }
    expect(starts).toEqual([10, 40, 70, 100])
  })

  it('defers a due glance during a typing burst and runs it when the burst ends', () => {
    let state = initialGlances(['a'], 0)
    state = { ...state, nextDue: new Map([['a', 10]]) }
    for (let t = 10; t < 20; t++) { state = stepGlances(state, [{ id: 'a', eligible: true, typingBurst: true }], t); expect(state.active).toBeNull() }
    state = stepGlances(state, [{ id: 'a', eligible: true, typingBurst: false }], 20)
    expect(state.active).toMatchObject({ id: 'a', untilTick: 25 })
  })

  it('never glances an ineligible person and cuts a glance short when they join an exchange', () => {
    let state = { ...initialGlances(['a'], 0) }
    state = { ...state, nextDue: new Map([['a', 10]]) }
    expect(stepGlances(state, [{ id: 'a', eligible: false, typingBurst: false }], 50).active).toBeNull()
    state = stepGlances(state, [{ id: 'a', eligible: true, typingBurst: false }], 50)
    expect(state.active?.id).toBe('a')
    expect(stepGlances(state, [{ id: 'a', eligible: false, typingBurst: false }], 51).active).toBeNull()
  })

  it('tracks arrivals and departures and returns the same state when nothing changes', () => {
    let state = initialGlances(['a'], 0)
    state = stepGlances(state, [{ id: 'a', eligible: true, typingBurst: false }, { id: 'b', eligible: true, typingBurst: false }], 1)
    expect([...state.nextDue.keys()].sort()).toEqual(['a', 'b'])
    expect(stepGlances(state, [{ id: 'a', eligible: true, typingBurst: false }, { id: 'b', eligible: true, typingBurst: false }], 2)).toBe(state)
    expect([...stepGlances(state, [{ id: 'b', eligible: true, typingBurst: false }], 3).nextDue.keys()]).toEqual(['b'])
  })

  it('is deterministic', () => {
    const run = () => { let s = initialGlances(ids, 0); const out: unknown[] = []; for (let t = 0; t < 1500; t++) { s = stepGlances(s, everyone(), t); out.push(s.active) } return out }
    expect(run()).toEqual(run())
  })
})
