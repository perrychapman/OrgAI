import type { ReactElement } from 'react'

/**
 * The 12 px state mark of a run row (docs/design/dashboard-usage-redesign components/StateMark): a ring in the state
 * colour, filled for Finished and Failed. Decorative: the status word always sits beside it. Nothing here moves; a
 * working mark (which breathes) belongs to Right now, not to the rows of Pick up.
 */
export type RunMarkState = 'done' | 'failed' | 'waiting' | 'working' | 'idle'

/** The mark of a status tone from `lib/runStatus`. */
export function markOfTone(tone: string | undefined): RunMarkState {
  switch (tone) {
    case 'ok':
      return 'done'
    case 'danger':
      return 'failed'
    case 'warn':
      return 'waiting'
    case 'is-running':
      return 'working'
    default:
      return 'idle'
  }
}

export function RunMark({ state }: { state: RunMarkState }): ReactElement {
  return <span className="run-mark" data-state={state} aria-hidden="true" />
}
