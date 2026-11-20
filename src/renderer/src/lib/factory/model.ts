// What the Factory Floor shows (docs/design/factory-floor.md sections 1.4, 4.4 and 10.3): the pure scene model. Pure.
// SLICE 3 CONTRACT STUB (UI Lead): the signature is fixed; the Scene Engineer (3a) replaces the body with the full
// section 1.4 / 4.4 mapping (poses, shutter, barrier, fence, crates, plan step chips, board, dock, hall, earlier).
import type { RunPlan, RunStatus } from '@shared/types'
import { factoryLamp, factoryWord } from './agentView'
import type { FactoryAgentInput, FloorLayout, FloorModel, WorkerModel } from './types'

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
  void runStatus
  const needs = new Set(needsYouIds)
  const workers: Record<string, WorkerModel> = {}
  for (const a of input) {
    const st = layout.stations[a.id]
    if (!st || a.session !== 'current') continue
    const lamp = factoryLamp(a, needs)
    workers[a.id] = {
      id: a.id,
      name: a.name,
      kind: st.kind,
      statusWord: factoryWord(a, lamp),
      activity: a.activity,
      lamp,
      pose: 'rest',
      ambient: 'none',
      shutter: false,
      barrier: false,
      fenced: false,
      stepIds: []
    }
  }
  return {
    mode,
    layout,
    workers,
    hall: 'on',
    ...(mode === 'live' && plan ? { board: { total: plan.steps.length, done: 0, blocked: 0, lamps: [], overflow: 0 } } : {}),
    dockCrates: 0,
    earlier: []
  }
}
