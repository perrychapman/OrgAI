import { describe, expect, it } from 'vitest'
import type { AgentState, PlanStep, RunPlan, RunStatus, WorktreeStatus } from '@shared/types'
import { FACTORY_STATUS_WORD } from './agentView'
import { EMPTY_LAYOUT_MEMORY, layoutFloor, layoutTeam } from './layout'
import { BOARD_LAMPS, buildFloorModel, factoryBoard, factoryHall, factoryPose, factoryWorktree, stepOwners } from './model'
import type { CrateAt, FactoryAgentInput, Lamp, Pose } from './types'

function agent(id: string, parentId: string | null, startedAt: number, extra: Partial<FactoryAgentInput> = {}): FactoryAgentInput {
  const state = (extra.state ?? 'thinking') as AgentState
  return {
    id,
    name: id.toUpperCase(),
    parentId,
    roleKey: 'implementer',
    handle: id,
    state,
    statusWord: FACTORY_STATUS_WORD[state],
    activity: `doing ${id}`,
    toolCalls: 0,
    startedAt,
    session: 'current',
    ...extra
  }
}

/** Root (booth) -> lead `l` (a lead: it has a report) -> bench `w`. */
function floor(w: Partial<FactoryAgentInput>, rootExtra: Partial<FactoryAgentInput> = {}): FactoryAgentInput[] {
  return [agent('root', null, 0, rootExtra), agent('l', 'root', 1, { state: 'delegating', roleKey: 'lead' }), agent('w', 'l', 2, w)]
}

function model(input: FactoryAgentInput[], opts: { needs?: string[]; plan?: RunPlan | null; status?: RunStatus; mode?: 'live' | 'team' } = {}) {
  const layout = layoutFloor({ runKey: 'r', agents: input }, EMPTY_LAYOUT_MEMORY).layout
  return buildFloorModel(input, layout, opts.needs ?? [], opts.plan, opts.status, opts.mode)
}

function plan(steps: Partial<PlanStep>[], status: RunPlan['status'] = 'active'): RunPlan {
  return {
    goal: 'g',
    steps: steps.map((s, i) => ({ id: `p${i + 1}`, title: `Step ${i + 1}`, status: 'pending', ...s })),
    status,
    autoContinues: 0,
    updatedAt: 0
  }
}

const STATES: AgentState[] = ['starting', 'thinking', 'tool', 'waiting', 'delegating', 'idle', 'done', 'error']
const WORKTREES: WorktreeStatus[] = ['active', 'merging', 'merged', 'empty', 'conflict', 'removed', 'review', 'held', 'waiting-children']

/** Section 1.4 expectations, written out independently of the implementation. */
const EXPECT_LAMP: Record<AgentState, Lamp> = {
  starting: 'running',
  thinking: 'running',
  tool: 'running',
  delegating: 'running',
  waiting: 'needs-you',
  idle: 'off',
  done: 'off',
  error: 'failed'
}
const EXPECT_POSE_BENCH: Record<AgentState, Pose> = {
  starting: 'console',
  thinking: 'console',
  tool: 'machine',
  delegating: 'console',
  waiting: 'signal',
  idle: 'rest',
  done: 'docked',
  error: 'down'
}
const EXPECT_WT: Record<WorktreeStatus, { fenced: boolean; main?: CrateAt; parent?: CrateAt; crateLamp?: Lamp }> = {
  active: { fenced: true },
  merging: { fenced: true, main: 'pad', parent: 'pad' },
  merged: { fenced: false, main: 'dock', parent: 'parent-pad' },
  empty: { fenced: false },
  conflict: { fenced: true, main: 'hold-striped', parent: 'hold-striped' },
  removed: { fenced: false },
  review: { fenced: true, main: 'pad', parent: 'pad', crateLamp: 'needs-you' },
  held: { fenced: true, main: 'hold', parent: 'hold' },
  'waiting-children': { fenced: true, main: 'pad', parent: 'pad' }
}

describe('buildFloorModel: every agent state x every worktree status (section 1.4)', () => {
  for (const state of STATES) {
    for (const wt of WORKTREES) {
      for (const target of ['main', 'parent'] as const) {
        it(`${state}, worktree ${wt} into ${target}`, () => {
          const m = model(floor({ state, statusWord: FACTORY_STATUS_WORD[state], worktree: { status: wt, mergeTarget: target } }))
          const w = m.workers.w
          expect(w.kind).toBe('bench')
          expect(w.lamp).toBe(EXPECT_LAMP[state])
          expect(w.pose).toBe(EXPECT_POSE_BENCH[state])
          expect(w.statusWord).toBe(FACTORY_STATUS_WORD[state])
          expect(w.shutter).toBe(state === 'done')
          expect(w.barrier).toBe(state === 'error')
          expect(w.ambient).toBe('none')
          const e = EXPECT_WT[wt]
          expect(w.fenced).toBe(e.fenced)
          const at = target === 'main' ? e.main : e.parent
          if (at) expect(w.crate).toEqual({ at, lamp: e.crateLamp ?? 'off' })
          else expect(w.crate).toBeUndefined()
          expect(m.dockCrates).toBe(wt === 'merged' && target === 'main' ? 1 : 0)
        })
      }
    }
  }

  it('no worktree: no fence, no crate', () => {
    const w = model(floor({ state: 'tool' })).workers.w
    expect(w.fenced).toBe(false)
    expect(w.crate).toBeUndefined()
  })
})

describe('lamps and poses', () => {
  it('an open decision makes any non-failed agent Needs you and signal', () => {
    for (const state of STATES) {
      const w = model(floor({ state, statusWord: FACTORY_STATUS_WORD[state] }), { needs: ['w'] }).workers.w
      if (state === 'error') {
        expect([w.lamp, w.pose, w.statusWord]).toEqual(['failed', 'down', 'Failed'])
      } else {
        expect([w.lamp, w.pose, w.statusWord]).toEqual(['needs-you', 'signal', 'Needs you'])
      }
      // shutter and barrier follow the state, not the lamp
      expect(w.shutter).toBe(state === 'done')
      expect(w.barrier).toBe(state === 'error')
    }
  })

  it('delegating: dispatch for the booth and leads, console for benches', () => {
    const m = model(floor({ state: 'delegating' }, { state: 'delegating' }))
    expect(m.workers.root.kind).toBe('booth')
    expect(m.workers.root.pose).toBe('dispatch')
    expect(m.workers.l.kind).toBe('lead')
    expect(m.workers.l.pose).toBe('dispatch')
    expect(m.workers.w.pose).toBe('console')
  })

  it('factoryPose: roles rest', () => {
    expect(factoryPose('role', 'off', 'bench')).toBe('rest')
    expect(factoryPose('role', 'off', 'booth')).toBe('rest')
  })

  it('a blocked plan lights the booth Needs you unless it failed; other workers are untouched', () => {
    const blocked = plan([{ status: 'blocked' }], 'blocked')
    const m = model(floor({ state: 'thinking' }, { state: 'idle' }), { plan: blocked })
    expect([m.workers.root.lamp, m.workers.root.pose, m.workers.root.statusWord]).toEqual(['needs-you', 'signal', 'Needs you'])
    expect(m.workers.w.lamp).toBe('running')
    const failed = model(floor({}, { state: 'error' }), { plan: blocked })
    expect([failed.workers.root.lamp, failed.workers.root.pose]).toEqual(['failed', 'down'])
    const active = model(floor({}, { state: 'idle' }), { plan: plan([{ status: 'blocked' }], 'active') })
    expect(active.workers.root.lamp).toBe('off')
  })
})

describe('worktree helper', () => {
  it('no worktree', () => {
    expect(factoryWorktree(undefined)).toEqual({ fenced: false })
  })
})

describe('plan board and step chips', () => {
  it('counts steps and maps the first twelve lamps; overflow beyond', () => {
    const statuses: PlanStep['status'][] = ['pending', 'in_progress', 'done', 'blocked', 'skipped']
    const steps = Array.from({ length: 15 }, (_, i) => ({ status: statuses[i % 5] }))
    const b = factoryBoard(plan(steps))
    expect(b.total).toBe(15)
    expect(b.done).toBe(3)
    expect(b.blocked).toBe(3)
    expect(b.lamps).toHaveLength(BOARD_LAMPS)
    expect(b.lamps.slice(0, 5)).toEqual(['pending', 'active', 'done', 'blocked', 'skipped'])
    expect(b.overflow).toBe(3)
    expect(factoryBoard(plan([])).overflow).toBe(0)
  })

  it('live with a plan has a board; no plan or team mode has none', () => {
    expect(model(floor({}), { plan: plan([{ status: 'done' }, { status: 'blocked' }, {}]) }).board).toEqual({
      total: 3,
      done: 1,
      blocked: 1,
      lamps: ['done', 'blocked', 'pending'],
      overflow: 0
    })
    expect(model(floor({})).board).toBeUndefined()
    expect(model(floor({}), { plan: null }).board).toBeUndefined()
  })

  it('an in-progress step owned by exactly one handle, else exactly one roleKey, puts its id on that worker', () => {
    const input = [
      agent('root', null, 0, { roleKey: 'orchestrator' }),
      agent('a', 'root', 1, { roleKey: 'implementer', handle: 'impl-a' }),
      agent('b', 'root', 2, { roleKey: 'implementer', handle: 'impl-b' }),
      agent('c', 'root', 3, { roleKey: 'reviewer', handle: 'rev' })
    ]
    const p = plan([
      { status: 'in_progress', owner: 'impl-a' }, // p1: handle -> a
      { status: 'in_progress', owner: 'reviewer' }, // p2: one roleKey -> c
      { status: 'in_progress', owner: 'implementer' }, // p3: ambiguous role -> none
      { status: 'in_progress', owner: 'nobody' }, // p4: no match
      { status: 'pending', owner: 'impl-b' }, // p5: not in progress
      { status: 'in_progress' }, // p6: no owner
      { status: 'in_progress', owner: 'impl-a' } // p7: second step on a
    ])
    const m = model(input, { plan: p })
    expect(m.workers.a.stepIds).toEqual(['p1', 'p7'])
    expect(m.workers.b.stepIds).toEqual([])
    expect(m.workers.c.stepIds).toEqual(['p2'])
    expect(m.workers.root.stepIds).toEqual([])
  })

  it('a handle shared by two agents is ambiguous and falls back to the role key', () => {
    const input = [agent('root', null, 0, { roleKey: 'boss' }), agent('a', 'root', 1, { handle: 'x', roleKey: 'one' }), agent('b', 'root', 2, { handle: 'x', roleKey: 'x' })]
    expect([...stepOwners(plan([{ status: 'in_progress', owner: 'x' }]), input).entries()]).toEqual([['b', ['p1']]])
    const noRole = input.map((a) => ({ ...a, roleKey: 'one' }))
    expect([...stepOwners(plan([{ status: 'in_progress', owner: 'x' }]), noRole).entries()]).toEqual([])
    const single = [agent('root', null, 0, { roleKey: 'boss' }), agent('a', 'root', 1, { handle: 'h', roleKey: 'x' })]
    expect([...stepOwners(plan([{ status: 'in_progress', owner: 'x' }]), single).entries()]).toEqual([['a', ['p1']]])
  })

  it('earlier-session agents never own a step', () => {
    const input = [agent('root', null, 0), agent('old', null, -5, { session: 'earlier', handle: 'old' })]
    expect(model(input, { plan: plan([{ status: 'in_progress', owner: 'old' }]) }).workers.root.stepIds).toEqual([])
  })
})

describe('hall, dock and earlier sessions', () => {
  it('hall level follows the run status', () => {
    const table: [RunStatus | undefined, string][] = [
      [undefined, 'on'],
      ['starting', 'on'],
      ['running', 'on'],
      ['idle', 'on'],
      ['stopping', 'on'],
      ['paused', 'paused'],
      ['finished', 'ended'],
      ['error', 'ended']
    ]
    for (const [status, hall] of table) {
      expect(factoryHall(status, 'live')).toBe(hall)
      expect(model(floor({}), { status }).hall).toBe(hall)
    }
    expect(factoryHall('paused', 'team')).toBe('on')
  })

  it('end states keep their lamps when the hall ends', () => {
    const m = model(floor({ state: 'error' }), { status: 'finished' })
    expect(m.hall).toBe('ended')
    expect(m.workers.w.lamp).toBe('failed')
  })

  it('dockCrates counts every current branch merged into main', () => {
    const input = [agent('root', null, 0)]
    for (let i = 0; i < 12; i++) input.push(agent(`m${i}`, 'root', i + 1, { state: 'done', worktree: { status: 'merged', mergeTarget: i === 0 ? 'parent' : 'main' } }))
    input.push(agent('old', null, -1, { session: 'earlier', worktree: { status: 'merged', mergeTarget: 'main' } }))
    expect(model(input).dockCrates).toBe(11)
  })

  it('earlier agents are listed, never on the floor', () => {
    const input = [agent('root', null, 5), agent('old', null, 0, { session: 'earlier', state: 'done', statusWord: 'Finished' })]
    const m = model(input)
    expect(Object.keys(m.workers)).toEqual(['root'])
    expect(m.earlier).toEqual([{ id: 'old', name: 'OLD', statusWord: 'Finished' }])
  })
})

describe('team mode', () => {
  it('roles: no lamps, rest pose, no props, board, dock or hall states', () => {
    const roles: FactoryAgentInput[] = [
      { ...agent('r0', null, 0), state: 'role', statusWord: 'Role', activity: '' },
      { ...agent('r1', 'r0', 1), state: 'role', statusWord: 'Role', activity: '' }
    ]
    const layout = layoutTeam(roles, 'team:p').layout
    const m = buildFloorModel(roles, layout, ['r1'], plan([{ status: 'in_progress', owner: 'r1' }], 'blocked'), 'paused', 'team')
    expect(m.mode).toBe('team')
    expect(m.hall).toBe('on')
    expect(m.board).toBeUndefined()
    expect(m.dockCrates).toBe(0)
    expect(m.earlier).toEqual([])
    for (const w of Object.values(m.workers)) {
      expect(w).toMatchObject({ lamp: 'off', pose: 'rest', statusWord: 'Role', shutter: false, barrier: false, fenced: false, stepIds: [], ambient: 'none' })
      expect(w.crate).toBeUndefined()
    }
  })
})
