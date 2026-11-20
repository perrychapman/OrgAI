// What the Factory Floor shows (docs/design/factory-floor.md sections 1.4, 4.4 and 10.3): the pure scene model, the
// static end state of every agent, worktree, plan step and run status. Slice 3 has no motion: `ambient` stays 'none'
// (slice 4 adds the loops and cues on top of these end states). Pure: no three, no DOM.
import type { AgentState, PlanStep, RunPlan, RunStatus, WorktreeStatus } from '@shared/types'
import type { StatusWord } from '../runStatus'
import { factoryLamp, factoryWord } from './agentView'
import type { CrateAt, FactoryAgentInput, FloorLayout, FloorModel, Lamp, Pose, StationKind, WorkerModel } from './types'

/** The plan board shows one lamp per step for at most this many steps; the rest count as overflow. */
export const BOARD_LAMPS = 12

type BoardLamp = NonNullable<FloorModel['board']>['lamps'][number]
const STEP_LAMP: Record<PlanStep['status'], BoardLamp> = {
  pending: 'pending',
  in_progress: 'active',
  done: 'done',
  blocked: 'blocked',
  skipped: 'skipped'
}

/** Section 1.4: the worker's pose. A lamp of Failed or Needs you wins; otherwise the agent state decides. */
export function factoryPose(state: AgentState | 'role', lamp: Lamp, kind: StationKind): Pose {
  if (lamp === 'failed') return 'down'
  if (lamp === 'needs-you') return 'signal'
  switch (state) {
    case 'starting':
    case 'thinking':
      return 'console'
    case 'tool':
      return 'machine'
    case 'delegating':
      return kind === 'bench' ? 'console' : 'dispatch'
    case 'done':
      return 'docked'
    default:
      // idle, role (and waiting / error, which the lamp already covered)
      return 'rest'
  }
}

/** Section 1.4: the worktree's fence and crate (end states). No worktree: neither. */
export function factoryWorktree(wt: FactoryAgentInput['worktree']): { fenced: boolean; crate?: { at: CrateAt; lamp: Lamp } } {
  if (!wt) return { fenced: false }
  const crate = (at: CrateAt, lamp: Lamp = 'off'): { at: CrateAt; lamp: Lamp } => ({ at, lamp })
  const s: WorktreeStatus = wt.status
  switch (s) {
    case 'active':
      return { fenced: true }
    case 'merging':
    case 'waiting-children':
      return { fenced: true, crate: crate('pad') }
    case 'merged':
      return { fenced: false, crate: crate(wt.mergeTarget === 'parent' ? 'parent-pad' : 'dock') }
    case 'conflict':
      return { fenced: true, crate: crate('hold-striped') }
    case 'review':
      return { fenced: true, crate: crate('pad', 'needs-you') }
    case 'held':
      return { fenced: true, crate: crate('hold') }
    default:
      // empty, removed
      return { fenced: false }
  }
}

/**
 * Section 1.4: the in-progress plan steps each current agent owns. A step's `owner` names a worker when it equals
 * exactly one current agent's handle, or else (no handle match, or a shared handle) the roleKey of exactly one current
 * agent. No match or an ambiguous one: no chip.
 */
export function stepOwners(plan: RunPlan | null | undefined, agents: readonly FactoryAgentInput[]): Map<string, string[]> {
  const out = new Map<string, string[]>()
  if (!plan) return out
  for (const step of plan.steps) {
    if (step.status !== 'in_progress' || !step.owner) continue
    const owner = step.owner
    let match = agents.filter((a) => a.handle !== undefined && a.handle === owner)
    if (match.length !== 1) match = agents.filter((a) => a.roleKey === owner)
    if (match.length !== 1) continue
    const id = match[0].id
    const list = out.get(id)
    if (list) list.push(step.id)
    else out.set(id, [step.id])
  }
  return out
}

/** Section 1.4: the hall light level. */
export function factoryHall(runStatus: RunStatus | undefined, mode: 'live' | 'team'): FloorModel['hall'] {
  if (mode === 'team') return 'on'
  if (runStatus === 'paused') return 'paused'
  if (runStatus === 'finished' || runStatus === 'error') return 'ended'
  return 'on'
}

/** Section 1.4: the plan board's counts and its first twelve step lamps. */
export function factoryBoard(plan: RunPlan): NonNullable<FloorModel['board']> {
  const total = plan.steps.length
  let done = 0
  let blocked = 0
  for (const s of plan.steps) {
    if (s.status === 'done') done++
    else if (s.status === 'blocked') blocked++
  }
  return {
    total,
    done,
    blocked,
    lamps: plan.steps.slice(0, BOARD_LAMPS).map((s) => STEP_LAMP[s.status] ?? 'pending'),
    overflow: Math.max(0, total - BOARD_LAMPS)
  }
}

/**
 * Builds the floor model from the scene input. `input` may hold earlier-session agents (they go to `earlier`, never on
 * the floor). `mode` defaults to 'live'; team mode has no lamps, plan board, dock count or hall states.
 */
export function buildFloorModel(
  input: readonly FactoryAgentInput[],
  layout: FloorLayout,
  needsYouIds: readonly string[],
  plan: RunPlan | null | undefined,
  runStatus: RunStatus | undefined,
  mode: 'live' | 'team' = 'live'
): FloorModel {
  const live = mode === 'live'
  const needs = new Set(live ? needsYouIds : [])
  const current = input.filter((a) => a.session === 'current')
  const steps = live ? stepOwners(plan, current) : new Map<string, string[]>()
  const planBlocked = live && plan?.status === 'blocked'
  const workers: Record<string, WorkerModel> = {}
  let dockCrates = 0
  for (const a of current) {
    const wt = live ? factoryWorktree(a.worktree) : { fenced: false }
    // Every current-session branch merged into the main checkout counts, placed or not (the engine draws at most nine).
    if (wt.crate?.at === 'dock') dockCrates++
    const st = layout.stations[a.id]
    if (!st) continue
    let lamp: Lamp = live ? factoryLamp(a, needs) : 'off'
    // The root's booth also signals a blocked plan (section 1.4), unless it failed.
    if (st.kind === 'booth' && planBlocked && lamp !== 'failed') lamp = 'needs-you'
    workers[a.id] = {
      id: a.id,
      name: a.name,
      kind: st.kind,
      statusWord: live ? factoryWord(a, lamp) : a.statusWord,
      activity: live ? a.activity : '',
      lamp,
      pose: factoryPose(live ? a.state : 'role', lamp, st.kind),
      ambient: 'none',
      shutter: live && a.state === 'done',
      barrier: live && a.state === 'error',
      fenced: wt.fenced,
      ...(wt.crate ? { crate: wt.crate } : {}),
      stepIds: steps.get(a.id) ?? []
    }
  }
  const earlier: FloorModel['earlier'] = live
    ? input
        .filter((a) => a.session === 'earlier')
        .map((a) => ({ id: a.id, name: a.name, statusWord: (a.statusWord === 'Role' ? 'Idle' : a.statusWord) as StatusWord }))
    : []
  return {
    mode,
    layout,
    workers,
    hall: factoryHall(runStatus, mode),
    ...(live && plan ? { board: factoryBoard(plan) } : {}),
    dockCrates: live ? dockCrates : 0,
    earlier
  }
}
