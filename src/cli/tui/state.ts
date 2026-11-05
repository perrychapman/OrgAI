/** TUI state reducer (W4-T1): snapshots and runs:event params into TuiState. Pure. Stub until W4-T1 lands. */
import type { RunsEventParams } from '../../shared/types'
import type { SnapshotResult } from '../client/runStream'
import type { Tone, TuiState } from './types'

export function createInitialState(folder: string): TuiState {
  void folder
  throw new Error('not implemented (Wave 4)')
}

export function applySnapshot(s: TuiState, res: SnapshotResult, opts: { activeRunId?: string }): TuiState {
  void [s, res, opts]
  throw new Error('not implemented (Wave 4)')
}

export function applyEvent(s: TuiState, p: RunsEventParams): TuiState {
  void [s, p]
  throw new Error('not implemented (Wave 4)')
}

export function addNotice(s: TuiState, text: string, tone?: Tone, now?: number): TuiState {
  void [s, text, tone, now]
  throw new Error('not implemented (Wave 4)')
}
