import { describe, expect, it } from 'vitest'
import type { AgentState, RunPlan, RunStatus, WorktreeStatus } from '@shared/types'
import { FACTORY_STATUS_WORD } from './agentView'
import { CueScheduler, diffCues, messageCursor, messageKey, messagesAfter } from './cues'
import { EMPTY_LAYOUT_MEMORY, GANTRY_TOP, layoutFloor, layoutTeam } from './layout'
import { buildFloorModel } from './model'
import {
  ARRIVE_MS,
  BARRIER_MS,
  CANCEL_FADE_MS,
  CAPSULE_ROOF_MS,
  CAPSULE_ROOF_RISE,
  HALL_MS,
  LEAVE_MS,
  PART_MS,
  POSE_MS,
  SHUTTER_MS
} from './motion'
import { dockSlot, holdPad, outfeedPad } from './routes'
import type { CueRequest, FactoryAgentInput, FloorFrame, LayoutMemory } from './types'

// ---------------------------------------------------------------- fixtures

function agent(id: string, parentId: string | null, startedAt: number, extra: Partial<FactoryAgentInput> = {}): FactoryAgentInput {
  const state = (extra.state ?? 'thinking') as AgentState
  return {
    id,
    name: id.toUpperCase(),
    parentId,
    roleKey: 'r',
    handle: id,
    state,
    statusWord: FACTORY_STATUS_WORD[state],
    activity: '',
    toolCalls: 0,
    startedAt,
    session: 'current',
    ...extra
  }
}
const withState = (a: FactoryAgentInput, state: AgentState): FactoryAgentInput => ({ ...a, state, statusWord: FACTORY_STATUS_WORD[state] })
const withWt = (a: FactoryAgentInput, status: WorktreeStatus, mergeTarget: 'main' | 'parent' = 'main'): FactoryAgentInput => ({ ...a, worktree: { status, mergeTarget } })

type Msg = FloorFrame['messages'][number]

/** A run as it evolves: layout memory threads through frames like the scene's (append-only). */
class Run {
  private memory: LayoutMemory = EMPTY_LAYOUT_MEMORY
  frame(agents: FactoryAgentInput[], opts: { messages?: Msg[]; status?: RunStatus; plan?: RunPlan | null; needs?: string[] } = {}): FloorFrame {
    const r = layoutFloor({ runKey: 'run', agents }, this.memory)
    this.memory = r.memory
    return { model: buildFloorModel(agents, r.layout, opts.needs ?? [], opts.plan, opts.status), agents, messages: opts.messages ?? [] }
  }
}

const msg = (at: number, from: string, to: string | null, text = `m${at}`, toHandle?: string): Msg => ({ at, from, to, text, ...(toHandle ? { toHandle } : {}) })
const plan = (done: number, total: number): RunPlan => ({
  goal: 'g',
  steps: Array.from({ length: total }, (_, i) => ({ id: `p${i + 1}`, title: 's', status: i < done ? 'done' : 'pending' })),
  status: 'active',
  autoContinues: 0,
  updatedAt: 0
})

const NOW = 1_000_000
const root = agent('root', null, 0)
const a = agent('a', 'root', 1)
const b = agent('b', 'root', 2)

// Positions (layout.ts): booth centre (7, -6) on the gantry; line 1 row 0 slot 0 at (6, 1.5), slot 1 at (10, 1.5).
const BOOTH = { x: 7, z: -6 }
const A = { x: 6, z: 1.5 }
const B = { x: 10, z: 1.5 }

// ---------------------------------------------------------------- diffCues

describe('diffCues: mount baseline and no replay (section 5.4)', () => {
  it('prev null: no cues, no events, cursor = newest message, whatever is already true', () => {
    const run = new Run()
    const messages = Array.from({ length: 100 }, (_, i) => msg(i, 'root', 'a'))
    const f = run.frame(
      [root, withWt({ ...withState(a, 'tool'), toolCalls: 40 }, 'merged'), withWt(withState(b, 'error'), 'conflict')],
      { messages, status: 'paused', plan: plan(1, 3) }
    )
    const d = diffCues(null, f, null, NOW)
    expect(d.cues).toEqual([])
    expect(d.events).toEqual([])
    expect(d.cursor).toBe(messageKey(messages[99]))
    // A passed cursor is ignored at mount (a run id change re-baselines).
    expect(diffCues(null, f, 'stale', NOW).cursor).toBe(messageKey(messages[99]))
    expect(diffCues(null, run.frame([root]), null, NOW).cursor).toBeNull()
  })

  it('remount never replays: a new baseline then the same frame gives nothing', () => {
    const run = new Run()
    const messages = Array.from({ length: 100 }, (_, i) => msg(i, 'root', 'a'))
    const f = run.frame([root, { ...a, toolCalls: 9 }], { messages })
    const base = diffCues(null, f, null, NOW)
    const again = diffCues(f, f, base.cursor, NOW)
    expect(again).toEqual({ cues: [], events: [], cursor: base.cursor })
  })

  it('team mode: nothing, cursor kept', () => {
    const roles = [{ ...root, state: 'role' as const, statusWord: 'Role' as const }, { ...a, state: 'role' as const, statusWord: 'Role' as const }]
    const layout = layoutTeam(roles, 'team:p').layout
    const m = buildFloorModel(roles, layout, [], null, undefined, 'team')
    const prev: FloorFrame = { model: { ...m, layout: { ...layout, stations: {}, order: [] } }, agents: [], messages: [] }
    const next: FloorFrame = { model: m, agents: roles, messages: [msg(5, 'root', 'a')] }
    expect(diffCues(prev, next, 'k', NOW)).toEqual({ cues: [], events: [], cursor: 'k' })
  })
})

describe('messageCursor and messagesAfter', () => {
  it('key and cursor', () => {
    expect(messageKey(msg(5, 'x', null, 'y'.repeat(40)))).toBe(`5|x||${'y'.repeat(32)}`)
    expect(messageCursor([])).toBeNull()
    expect(messageCursor([msg(1, 'a', 'b'), msg(2, 'b', 'a', 'hi')])).toBe('2|b|a|hi')
  })

  it('cursor in the list: everything after it', () => {
    const list = [msg(1, 'a', 'b'), msg(2, 'a', 'b'), msg(3, 'a', 'b')]
    expect(messagesAfter(list, messageKey(list[1]))).toEqual([list[2]])
    expect(messagesAfter(list, messageKey(list[2]))).toEqual([])
    expect(messagesAfter(list, null)).toEqual(list)
  })

  it('older messages fall out of the 100: the cursor still finds only the new ones', () => {
    const all = Array.from({ length: 105 }, (_, i) => msg(i, 'a', 'b'))
    const before = all.slice(0, 100)
    const cursor = messageCursor(before)
    expect(messagesAfter(all.slice(5), cursor)).toEqual(all.slice(100))
  })

  it('cursor no longer in the list: compares at, then key; never replays older messages', () => {
    const cursor = messageKey(msg(50, 'a', 'b', 'x'))
    const list = [msg(10, 'a', 'b'), msg(50, 'a', 'b', 'a'), msg(50, 'a', 'b', 'z'), msg(60, 'b', 'a')]
    expect(messagesAfter(list, cursor)).toEqual([list[2], list[3]])
    const older = Array.from({ length: 100 }, (_, i) => msg(i, 'a', 'b'))
    expect(messagesAfter(older, messageKey(msg(500, 'q', null)))).toEqual([])
    expect(messagesAfter(older, 'garbage')).toEqual([])
  })
})

describe('diffCues: agents arriving and leaving (section 1.4)', () => {
  it('a new root: started, no cue (the booth lights in one frame)', () => {
    const run = new Run()
    const prev = run.frame([])
    const d = diffCues(prev, run.frame([root]), null, NOW)
    expect(d.cues).toEqual([])
    expect(d.events).toEqual([{ kind: 'started', at: NOW, name: 'ROOT' }])
  })

  it('a new agent with its parent on the floor: assigned, tote from the parent, then the arrive after it lands', () => {
    const run = new Run()
    const prev = run.frame([root])
    const d = diffCues(prev, run.frame([root, a]), null, NOW)
    expect(d.events).toEqual([{ kind: 'assigned', at: NOW, parent: 'ROOT', child: 'A', childId: 'a' }])
    expect(d.cues).toHaveLength(2)
    const [tote, arrive] = d.cues
    expect(tote.kind).toBe('tote')
    expect(tote).toMatchObject({ from: 'root', to: 'a', path: { from: BOOTH, to: A, fromY: GANTRY_TOP, toY: 0 } })
    // hypot(1, 7.5) = 7.566 m at 8 m/s
    expect(tote.duration).toBeCloseTo(945.8, 1)
    expect(arrive).toMatchObject({ kind: 'arrive', from: 'a', duration: ARRIVE_MS, path: { from: A, to: A, fromY: 0, toY: 0 } })
    expect(arrive.delay).toBe(tote.duration)
  })

  it('parent and child arriving together: each gets its tote in reading order', () => {
    const run = new Run()
    const prev = run.frame([root])
    const l = agent('l', 'root', 1)
    const w = agent('w', 'l', 2)
    const d = diffCues(prev, run.frame([root, l, w]), null, NOW)
    expect(d.cues.map((c) => `${c.kind}:${c.from}>${c.to ?? ''}`)).toEqual(['tote:root>l', 'arrive:l>', 'tote:l>w', 'arrive:w>'])
    expect(d.events.map((e) => e.kind)).toEqual(['assigned', 'assigned'])
  })

  it('a new agent without a parent on the floor: arrive at once, no tote', () => {
    const run = new Run()
    const prev = run.frame([root])
    const orphan = agent('o', 'gone', 3)
    const d = diffCues(prev, run.frame([root, orphan]), null, NOW)
    expect(d.cues).toEqual([{ kind: 'arrive', from: 'o', duration: ARRIVE_MS, path: { from: A, to: A, fromY: 0, toY: 0 } }])
    expect(d.events).toEqual([])
  })

  it('an agent removed: leave at its old station, left event (no tool or state cues for it)', () => {
    const run = new Run()
    const prev = run.frame([root, a, b])
    const d = diffCues(prev, run.frame([root, b]), null, NOW)
    expect(d.cues).toEqual([{ kind: 'leave', from: 'a', duration: LEAVE_MS, path: { from: A, to: A, fromY: 0, toY: 0 } }])
    expect(d.events).toEqual([{ kind: 'left', at: NOW, id: 'a', name: 'A' }])
  })
})

describe('diffCues: work on the floor', () => {
  it('tool calls: one part per diff with count = the increase; none for a decrease or no change', () => {
    const run = new Run()
    const prev = run.frame([root, { ...a, toolCalls: 2 }])
    const d = diffCues(prev, run.frame([root, { ...a, toolCalls: 5 }]), null, NOW)
    expect(d.cues).toEqual([{ kind: 'part', from: 'a', count: 3, duration: PART_MS, path: { from: A, to: A, fromY: 0, toY: 0 } }])
    expect(diffCues(prev, run.frame([root, { ...a, toolCalls: 1 }]), null, NOW).cues).toEqual([])
    expect(diffCues(prev, run.frame([root, { ...a, toolCalls: 2 }]), null, NOW).cues).toEqual([])
  })

  it('Running to Running: a pose blend, no state line', () => {
    const run = new Run()
    const prev = run.frame([root, a])
    const d = diffCues(prev, run.frame([root, withState(a, 'tool')]), null, NOW)
    expect(d.cues).toEqual([{ kind: 'pose', from: 'a', pose: { from: 'console', to: 'machine' }, duration: POSE_MS, path: { from: A, to: A, fromY: 0, toY: 0 } }])
    expect(d.events).toEqual([])
  })

  it('done lowers the shutter; error drops the barrier; back again raises them; state lines', () => {
    const run = new Run()
    const prev = run.frame([root, a, b])
    const next = run.frame([root, withState(a, 'done'), withState(b, 'error')])
    const d = diffCues(prev, next, null, NOW)
    const kinds = d.cues.map((c) => `${c.kind}:${c.from}`)
    expect(kinds).toEqual(['pose:a', 'shutter:a', 'pose:b', 'barrier:b'])
    expect(d.cues[1]).toMatchObject({ lower: true, duration: SHUTTER_MS })
    expect(d.cues[3]).toMatchObject({ lower: true, duration: BARRIER_MS })
    expect(d.events).toEqual([
      { kind: 'state', at: NOW, id: 'a', name: 'A', word: 'Finished' },
      { kind: 'state', at: NOW, id: 'b', name: 'B', word: 'Failed' }
    ])
    const back = diffCues(next, run.frame([root, a, b]), null, NOW)
    expect(back.cues.filter((c) => c.kind === 'shutter' || c.kind === 'barrier').map((c) => c.lower)).toEqual([false, false])
  })

  it('Needs you from a decision: pose to signal and a state line', () => {
    const run = new Run()
    const prev = run.frame([root, a])
    const d = diffCues(prev, run.frame([root, a], { needs: ['a'] }), null, NOW)
    expect(d.cues.map((c) => c.pose)).toEqual([{ from: 'console', to: 'signal' }])
    expect(d.events).toEqual([{ kind: 'state', at: NOW, id: 'a', name: 'A', word: 'Needs you' }])
  })
})

describe('diffCues: worktrees', () => {
  it('merged into main: a crate from the outfeed pad to the next dock slot; two in one change take two slots', () => {
    const run = new Run()
    const c = agent('c', 'root', 3)
    const prev = run.frame([root, withWt(a, 'merging'), withWt(b, 'merging'), withWt(c, 'merged')])
    expect(prev.model.dockCrates).toBe(1)
    const d = diffCues(prev, run.frame([root, withWt(a, 'merged'), withWt(b, 'merged'), withWt(c, 'merged')]), null, NOW)
    const crates = d.cues.filter((x) => x.kind === 'crate')
    expect(crates).toHaveLength(2)
    const dock = prev.model.layout.dock
    expect(crates[0]).toMatchObject({ from: 'a', to: 'dock', dest: 'dock', slot: 1, path: { from: outfeedPad(A), to: dockSlot(1, dock), fromY: 0, toY: GANTRY_TOP } })
    expect(crates[1]).toMatchObject({ from: 'b', dest: 'dock', slot: 2 })
    expect(crates[0].duration).toBeGreaterThanOrEqual(800)
    expect(crates[0].duration).toBeLessThanOrEqual(2400)
    expect(d.events).toEqual([
      { kind: 'merged', at: NOW, name: 'A', into: 'main' },
      { kind: 'merged', at: NOW, name: 'B', into: 'main' }
    ])
  })

  it('the tenth dock crate has no slot and flies to the dock centre', () => {
    const run = new Run()
    const others = Array.from({ length: 9 }, (_, i) => withWt(agent(`m${i}`, 'root', 10 + i), 'merged'))
    const prev = run.frame([root, withWt(a, 'merging'), ...others])
    const d = diffCues(prev, run.frame([root, withWt(a, 'merged'), ...others]), null, NOW)
    const crate = d.cues.find((x) => x.kind === 'crate')
    expect(crate?.slot).toBeUndefined()
    expect(crate?.path?.to).toEqual(prev.model.layout.dock)
  })

  it('merged into the parent: a crate to the parent pad', () => {
    const run = new Run()
    const l = agent('l', 'root', 1)
    const w = agent('w', 'l', 2)
    const prev = run.frame([root, l, withWt(w, 'merging', 'parent')])
    const next = run.frame([root, l, withWt(w, 'merged', 'parent')])
    const d = diffCues(prev, next, null, NOW)
    const lc = next.model.layout.stations.l.center
    expect(d.cues).toEqual([
      expect.objectContaining({ kind: 'crate', from: 'w', to: 'l', dest: 'parent-pad', path: expect.objectContaining({ to: outfeedPad(lc) }) })
    ])
    expect(d.events).toEqual([{ kind: 'merged', at: NOW, name: 'W', into: 'L' }])
  })

  it('conflict and held: a crate slides to the hold pad once; review and empty: lines only', () => {
    const run = new Run()
    const prev = run.frame([root, withWt(a, 'merging'), withWt(b, 'active')])
    const mid = run.frame([root, withWt(a, 'conflict'), withWt(b, 'review')])
    const d = diffCues(prev, mid, null, NOW)
    expect(d.cues).toEqual([expect.objectContaining({ kind: 'crate', from: 'a', dest: 'hold', path: expect.objectContaining({ from: outfeedPad(A), to: holdPad(A) }) })])
    expect(d.events).toEqual([
      { kind: 'branch', at: NOW, id: 'a', name: 'A', status: 'conflict' },
      { kind: 'branch', at: NOW, id: 'b', name: 'B', status: 'review' }
    ])
    const held = diffCues(mid, run.frame([root, withWt(a, 'held'), withWt(b, 'empty')]), null, NOW)
    expect(held.cues).toEqual([])
    expect(held.events.map((e) => (e.kind === 'branch' ? e.status : e.kind))).toEqual(['held', 'empty'])
  })

  it('a held crate that merges starts from the hold pad', () => {
    const run = new Run()
    const prev = run.frame([root, withWt(a, 'held')])
    const d = diffCues(prev, run.frame([root, withWt(a, 'merged')]), null, NOW)
    expect(d.cues[0].path?.from).toEqual(holdPad(A))
  })

  it('active, merging, waiting-children, removed: no cue and no line', () => {
    const run = new Run()
    let prev = run.frame([root, a])
    for (const s of ['active', 'merging', 'waiting-children', 'removed'] as WorktreeStatus[]) {
      const next = run.frame([root, withWt(a, s)])
      expect(diffCues(prev, next, null, NOW)).toEqual({ cues: [], events: [], cursor: null })
      prev = next
    }
  })
})

describe('diffCues: messages', () => {
  it('only messages after the cursor; agent to agent flies station to station', () => {
    const run = new Run()
    const old = msg(1, 'a', 'b', 'old')
    const prev = run.frame([root, a, b], { messages: [old] })
    const cursor = diffCues(null, prev, null, NOW).cursor
    const fresh = msg(2, 'a', 'b', 'hello')
    const next = run.frame([root, a, b], { messages: [old, fresh] })
    const d = diffCues(prev, next, cursor, NOW)
    expect(d.cues).toHaveLength(1)
    expect(d.cues[0]).toMatchObject({ kind: 'capsule', from: 'a', to: 'b', count: 1, duration: 500, path: { from: A, to: B, fromY: 0, toY: 0 } })
    expect(d.events).toEqual([{ kind: 'message', at: NOW, sender: 'A', recipient: 'B', text: 'hello', offFloor: false }])
    expect(d.cursor).toBe(messageKey(fresh))
    expect(diffCues(next, next, d.cursor, NOW).cues).toEqual([])
  })

  it('to null or someone off the floor: rises into the roof; a sender off the floor: a line, no capsule', () => {
    const run = new Run()
    const prev = run.frame([root, a])
    const next = run.frame([root, a], { messages: [msg(1, 'root', null, 'hi', 'user'), msg(2, 'a', 'ghost', 'yo', 'ghost-1'), msg(3, 'ghost', 'a', 'boo')] })
    const d = diffCues(prev, next, null, NOW)
    expect(d.cues).toEqual([
      { kind: 'capsule', from: 'root', to: null, count: 1, duration: CAPSULE_ROOF_MS, path: { from: BOOTH, to: BOOTH, fromY: GANTRY_TOP, toY: GANTRY_TOP + CAPSULE_ROOF_RISE } },
      { kind: 'capsule', from: 'a', to: null, count: 1, duration: CAPSULE_ROOF_MS, path: { from: A, to: A, fromY: 0, toY: CAPSULE_ROOF_RISE } }
    ])
    expect(d.events).toEqual([
      { kind: 'message', at: NOW, sender: 'ROOT', recipient: 'user', text: 'hi', offFloor: true },
      { kind: 'message', at: NOW, sender: 'A', recipient: 'ghost-1', text: 'yo', offFloor: true },
      { kind: 'message', at: NOW, sender: 'ghost', recipient: 'A', text: 'boo', offFloor: false }
    ])
  })
})

describe('diffCues: plan and run', () => {
  it('plan done or total change: a line; same counts: none', () => {
    const run = new Run()
    const prev = run.frame([root], { plan: plan(1, 3) })
    expect(diffCues(prev, run.frame([root], { plan: plan(2, 3) }), null, NOW).events).toEqual([{ kind: 'plan', at: NOW, done: 2, total: 3 }])
    expect(diffCues(prev, run.frame([root], { plan: plan(1, 4) }), null, NOW).events).toEqual([{ kind: 'plan', at: NOW, done: 1, total: 4 }])
    expect(diffCues(prev, run.frame([root], { plan: plan(1, 3) }), null, NOW).events).toEqual([])
    expect(diffCues(run.frame([root]), run.frame([root], { plan: plan(0, 2) }), null, NOW).events).toEqual([{ kind: 'plan', at: NOW, done: 0, total: 2 }])
  })

  it('paused, resumed, ended: a hall cue and a run line', () => {
    const run = new Run()
    const on = run.frame([root])
    const paused = run.frame([root], { status: 'paused' })
    const ended = run.frame([root], { status: 'finished' })
    const hall = (d: ReturnType<typeof diffCues>): CueRequest | undefined => d.cues.find((c) => c.kind === 'hall')
    const p = diffCues(on, paused, null, NOW)
    expect(hall(p)).toEqual({ kind: 'hall', hall: { from: 'on', to: 'paused' }, duration: HALL_MS })
    expect(p.events).toContainEqual({ kind: 'run', at: NOW, status: 'paused' })
    expect(diffCues(paused, on, null, NOW).events).toContainEqual({ kind: 'run', at: NOW, status: 'resumed' })
    expect(diffCues(on, ended, null, NOW).events).toContainEqual({ kind: 'run', at: NOW, status: 'ended' })
    expect(diffCues(on, run.frame([root], { status: 'running' }), null, NOW).cues).toEqual([])
  })
})

// ---------------------------------------------------------------- CueScheduler

const capsule = (from: string, to: string | null, duration = 1000): CueRequest => ({ kind: 'capsule', from, to, count: 1, duration })
const T = 10_000

describe('CueScheduler: carriers (section 5.2)', () => {
  it('at most 6 in flight and 2 per sender; the rest queue and start as room frees', () => {
    const s = new CueScheduler()
    const reqs: CueRequest[] = []
    for (let i = 0; i < 5; i++) for (const to of ['x', 'y']) reqs.push(capsule(`s${i}`, to))
    s.push(reqs, T)
    expect(s.advance(T)).toHaveLength(6)
    expect(s.started).toBe(6)
    expect(s.peaks()).toMatchObject({ carriers: 6, perSender: 2 })
    expect(s.busy(T)).toBe(true)
    const later = s.advance(T + 1000)
    expect(later).toHaveLength(4)
    expect(later.map((c) => c.from)).toEqual(['s3', 's3', 's4', 's4'])
    expect(later.every((c) => c.start === T + 1000 && c.progress === 0)).toBe(true)
    expect(s.started).toBe(10)
    expect(s.advance(T + 2000)).toEqual([])
    expect(s.busy(T + 2000)).toBe(false)
    expect(s.peaks()).toMatchObject({ carriers: 6, perSender: 2 })
  })

  it('one sender: 2 fly, the others wait; a different sender still flies', () => {
    const s = new CueScheduler()
    s.push(['a', 'b', 'c', 'd'].map((to) => capsule('lead', to)), T)
    s.push([capsule('other', 'a')], T)
    const active = s.advance(T)
    expect(active.map((c) => `${c.from}>${c.to}`)).toEqual(['lead>a', 'lead>b', 'other>a'])
  })

  it('capsules from one sender to one recipient within 800 ms coalesce; after that, a new capsule', () => {
    const s = new CueScheduler()
    s.push([capsule('a', 'b', 1500)], T)
    s.push([capsule('a', 'b', 1500)], T + 400)
    s.push([capsule('a', 'b', 1500)], T + 800)
    expect(s.advance(T + 800)).toHaveLength(1)
    expect(s.advance(T + 800)[0].count).toBe(3)
    expect(s.started).toBe(1)
    s.push([capsule('a', 'b', 1500)], T + 801)
    expect(s.advance(T + 801).map((c) => c.count)).toEqual([3, 1])
    expect(s.started).toBe(2)
    // A different recipient (or the roof) never coalesces.
    s.push([capsule('a', null, 600)], T + 802)
    expect(s.advance(T + 802)).toHaveLength(2)
  })

  it('a queued capsule takes every later one with the same sender and recipient, whatever the time', () => {
    const s = new CueScheduler()
    s.push([capsule('a', 'x'), capsule('a', 'y')], T)
    s.push([capsule('a', 'z')], T)
    s.push([capsule('a', 'z')], T + 900)
    s.push([capsule('a', 'z')], T + 950)
    const after = s.advance(T + 1000)
    expect(after).toHaveLength(1)
    expect(after[0]).toMatchObject({ to: 'z', count: 3 })
    expect(s.started).toBe(3)
  })

  it('the capsule queue holds at most 12; the oldest queued ones are dropped from the animation', () => {
    const s = new CueScheduler()
    s.push(['p', 'q', 'r'].flatMap((from) => [capsule(from, 'x'), capsule(from, 'y')]), T)
    const queued: CueRequest[] = Array.from({ length: 15 }, (_, i) => capsule(`w${i}`, 'x'))
    s.push(queued, T)
    expect(s.advance(T)).toHaveLength(6)
    expect(s.started).toBe(6)
    let t = T
    const seen: string[] = []
    while (s.busy(t)) {
      t += 1000
      for (const c of s.advance(t)) if (c.start === t) seen.push(c.from ?? '')
    }
    expect(seen).toEqual(Array.from({ length: 12 }, (_, i) => `w${i + 3}`))
    expect(s.started).toBe(18)
  })

  it('a tote that cannot fly is dropped and its arrive starts at once', () => {
    const s = new CueScheduler()
    s.push([capsule('root', 'x'), capsule('root', 'y')], T)
    s.push([{ kind: 'tote', from: 'root', to: 'c', duration: 900 }, { kind: 'arrive', from: 'c', duration: ARRIVE_MS, delay: 900 }], T)
    const active = s.advance(T)
    expect(active.map((c) => c.kind)).toEqual(['capsule', 'capsule', 'arrive'])
    expect(active[2]).toMatchObject({ start: T, delay: 0 })
  })

  it('an arrive behind a flying tote waits: returned with progress 0 until the tote lands', () => {
    const s = new CueScheduler()
    s.push([{ kind: 'tote', from: 'root', to: 'c', duration: 900 }, { kind: 'arrive', from: 'c', duration: ARRIVE_MS, delay: 900 }], T)
    const now = s.advance(T + 450)
    expect(now.map((c) => [c.kind, c.progress])).toEqual([
      ['tote', 0.5],
      ['arrive', 0]
    ])
    expect(s.advance(T + 1000).map((c) => [c.kind, c.progress])).toEqual([['arrive', 0.5]])
    expect(s.busy(T + 1099)).toBe(true)
    expect(s.busy(T + 1100)).toBe(false)
    expect(s.advance(T + 1100)).toEqual([])
  })
})

describe('CueScheduler: parts, crates, arrivals', () => {
  const part = (from: string, count = 1): CueRequest => ({ kind: 'part', from, count, duration: PART_MS })

  it('one part in flight and one queued per station; increases during flight add to the queued one', () => {
    const s = new CueScheduler()
    s.push([part('a')], T)
    s.push([part('a', 2)], T + 100)
    s.push([part('a', 3)], T + 200)
    expect(s.advance(T + 200)).toHaveLength(1)
    expect(s.started).toBe(1)
    const next = s.advance(T + PART_MS)
    expect(next).toHaveLength(1)
    expect(next[0]).toMatchObject({ start: T + PART_MS, count: 5 })
    expect(s.started).toBe(2)
    expect(s.advance(T + 2 * PART_MS)).toEqual([])
    expect(s.busy(T + 2 * PART_MS)).toBe(false)
  })

  it('at most 12 parts in flight across stations; a part over the global cap is dropped', () => {
    const s = new CueScheduler()
    s.push(Array.from({ length: 14 }, (_, i) => part(`st${i}`)), T)
    expect(s.advance(T)).toHaveLength(12)
    expect(s.started).toBe(12)
    expect(s.peaks().parts).toBe(12)
    expect(s.busy(T + PART_MS)).toBe(false)
  })

  it('at most 4 crates in flight; the others land at once (never pushed)', () => {
    const s = new CueScheduler()
    s.push(Array.from({ length: 6 }, (_, i) => ({ kind: 'crate', from: `c${i}`, to: 'dock', dest: 'dock', slot: i, duration: 1000 }) as CueRequest), T)
    expect(s.advance(T).map((c) => c.from)).toEqual(['c0', 'c1', 'c2', 'c3'])
    expect(s.started).toBe(4)
    expect(s.peaks().crates).toBe(4)
    s.push([{ kind: 'crate', from: 'c9', dest: 'hold', duration: 800 }], T + 1000)
    expect(s.advance(T + 1000)).toHaveLength(1)
  })

  it('at most 12 arrivals start in any 1 s window; the rest appear at once', () => {
    const s = new CueScheduler()
    const arrive = (id: string, delay = 0): CueRequest => ({ kind: 'arrive', from: id, duration: ARRIVE_MS, delay })
    s.push(Array.from({ length: 15 }, (_, i) => arrive(`n${i}`)), T)
    expect(s.advance(T)).toHaveLength(12)
    s.push([arrive('late')], T + 999)
    expect(s.advance(T + 999)).toHaveLength(0)
    s.push([arrive('next')], T + 1000)
    expect(s.advance(T + 1000)).toHaveLength(1)
    expect(s.peaks().arrivalsPerSecond).toBe(12)
  })

  it('a delayed arrive counts when it starts, not when pushed', () => {
    const s = new CueScheduler()
    const arrive = (id: string, delay = 0): CueRequest => ({ kind: 'arrive', from: id, duration: ARRIVE_MS, delay })
    s.push(Array.from({ length: 12 }, (_, i) => arrive(`now${i}`)), T)
    s.push(Array.from({ length: 12 }, (_, i) => arrive(`later${i}`, 1500)), T)
    expect(s.started).toBe(24)
    s.push([arrive('extra', 1200)], T + 300) // starts at T + 1500 with the twelve delayed ones
    expect(s.started).toBe(24)
    s.push([arrive('between', 600)], T + 300) // starts at T + 900: a window holds the first 12
    expect(s.started).toBe(24)
    expect(s.peaks().arrivalsPerSecond).toBe(12)
  })

  it('other cues pass straight through', () => {
    const s = new CueScheduler()
    s.push(
      [
        { kind: 'pose', from: 'a', pose: { from: 'console', to: 'machine' }, duration: POSE_MS },
        { kind: 'shutter', from: 'a', lower: true, duration: SHUTTER_MS },
        { kind: 'barrier', from: 'b', lower: true, duration: BARRIER_MS },
        { kind: 'leave', from: 'c', duration: LEAVE_MS },
        { kind: 'hall', hall: { from: 'on', to: 'paused' }, duration: HALL_MS }
      ],
      T
    )
    expect(s.advance(T).map((c) => c.kind)).toEqual(['pose', 'shutter', 'barrier', 'leave', 'hall'])
  })
})

describe('CueScheduler: cancellation, finishAll, recent', () => {
  it('cancelFor: cues from or to the worker stop where they are and fade over 120 ms; queued and delayed ones drop', () => {
    const s = new CueScheduler()
    s.push([capsule('a', 'gone'), capsule('gone', 'b'), capsule('a', 'c')], T)
    s.push([capsule('a', 'gone')], T + 900) // queued (a has 2 in flight)
    s.push([{ kind: 'part', from: 'gone', count: 1, duration: PART_MS }, { kind: 'part', from: 'gone', count: 1, duration: PART_MS }], T)
    s.push([{ kind: 'tote', from: 'x', to: 'y', duration: 1000 }, { kind: 'arrive', from: 'gone', duration: ARRIVE_MS, delay: 1000 }], T)
    s.push([{ kind: 'leave', from: 'gone', duration: LEAVE_MS }], T + 500)
    s.cancelFor('gone', T + 500)
    const at = s.advance(T + 500)
    const byKey = new Map(at.map((c) => [`${c.kind}:${c.from}>${c.to ?? ''}`, c]))
    expect([...byKey.keys()].sort()).toEqual(['capsule:a>c', 'capsule:a>gone', 'capsule:gone>b', 'leave:gone>', 'part:gone>', 'tote:x>y'].sort())
    expect(byKey.get('capsule:a>gone')).toMatchObject({ progress: 0.5, opacity: 1 })
    expect(byKey.get('leave:gone>')).toMatchObject({ opacity: 1 })
    const mid = s.advance(T + 560)
    const fading = mid.find((c) => c.to === 'gone')
    expect(fading?.progress).toBe(0.5)
    expect(fading?.opacity).toBeCloseTo(0.5)
    expect(mid.find((c) => c.to === 'c')?.opacity).toBe(1)
    const end = s.advance(T + 500 + CANCEL_FADE_MS)
    // The station's own leave (160 ms from T + 500) is never cancelled.
    expect(end.map((c) => `${c.kind}:${c.from}>${c.to ?? ''}`).sort()).toEqual(['capsule:a>c', 'leave:gone>', 'tote:x>y'])
    // The queued capsule and part for it never start.
    expect(s.advance(T + 5000)).toEqual([])
    expect(s.busy(T + 5000)).toBe(false)
  })

  it('finishAll ends everything at once; advance returns nothing afterwards', () => {
    const s = new CueScheduler()
    s.push(Array.from({ length: 10 }, (_, i) => capsule(`s${i % 3}`, `r${i}`)), T)
    s.push([{ kind: 'arrive', from: 'z', duration: ARRIVE_MS, delay: 800 }], T)
    s.finishAll()
    expect(s.advance(T + 1)).toEqual([])
    expect(s.busy(T + 1)).toBe(false)
    expect(s.advance(T + 5000)).toEqual([])
  })

  it('recent keeps the last 40 accepted, oldest first; started counts accepted only', () => {
    const s = new CueScheduler()
    for (let i = 0; i < 50; i++) s.push([{ kind: 'pose', from: `w${i}`, duration: POSE_MS }], T + i)
    expect(s.started).toBe(50)
    const r = s.recent()
    expect(r).toHaveLength(40)
    expect(r[0].from).toBe('w10')
    expect(r[39].from).toBe('w49')
    expect(new Set(r.map((c) => c.id)).size).toBe(40)
  })

  it('a new scheduler starts empty (no replay across remounts)', () => {
    const s = new CueScheduler()
    expect(s.advance(T)).toEqual([])
    expect(s.recent()).toEqual([])
    expect(s.peaks()).toEqual({ carriers: 0, perSender: 0, parts: 0, crates: 0, arrivalsPerSecond: 0 })
  })
})

describe('diffCues into the scheduler: a burst holds every cap', () => {
  it('40 workers messaging and calling tools at once', () => {
    const run = new Run()
    const workers = Array.from({ length: 40 }, (_, i) => agent(`w${i}`, 'root', i + 1))
    const prev = run.frame([root, ...workers])
    const msgs: Msg[] = []
    for (let i = 0; i < 40; i++) for (let k = 0; k < 3; k++) msgs.push(msg(100 + i * 3 + k, `w${i}`, `w${(i + k + 1) % 40}`))
    const next = run.frame([root, ...workers.map((w) => ({ ...w, toolCalls: 4 }))], { messages: msgs })
    const d = diffCues(prev, next, null, NOW)
    expect(d.events.filter((e) => e.kind === 'message')).toHaveLength(120)
    const s = new CueScheduler()
    s.push(d.cues, T)
    for (let t = T; t < T + 20_000; t += 16) s.advance(t)
    expect(s.peaks()).toEqual({ carriers: 6, perSender: 2, parts: 12, crates: 0, arrivalsPerSecond: 0 })
    expect(s.busy(T + 20_000)).toBe(false)
  })
})
