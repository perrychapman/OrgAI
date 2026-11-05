/** Pure view-model selectors over TuiState (W4-T1). Stub until W4-T1 lands. */
import type {
  ComposerMode,
  OrgTreeRow,
  PartialRow,
  PlanView,
  StatusSummary,
  TranscriptRow,
  TrayCard,
  TuiState,
  WorktreeRow
} from './types'

export function trayCards(s: TuiState): TrayCard[] {
  void s
  throw new Error('not implemented (Wave 4)')
}

export function topCard(s: TuiState): TrayCard | undefined {
  void s
  throw new Error('not implemented (Wave 4)')
}

export function orgTreeRows(s: TuiState): OrgTreeRow[] {
  void s
  throw new Error('not implemented (Wave 4)')
}

export function transcriptRows(s: TuiState): { rows: TranscriptRow[]; omitted: number } {
  void s
  throw new Error('not implemented (Wave 4)')
}

export function partialRows(s: TuiState): PartialRow[] {
  void s
  throw new Error('not implemented (Wave 4)')
}

export function planView(s: TuiState): PlanView | undefined {
  void s
  throw new Error('not implemented (Wave 4)')
}

export function worktreeRows(s: TuiState): WorktreeRow[] {
  void s
  throw new Error('not implemented (Wave 4)')
}

export function statusSummary(s: TuiState): StatusSummary {
  void s
  throw new Error('not implemented (Wave 4)')
}

export function composerMode(s: TuiState): ComposerMode {
  void s
  throw new Error('not implemented (Wave 4)')
}
