import type { ReactElement } from 'react'

/** Interface stub (UI Lead): replaced by the Team pulse implementation. */
export interface TeamPulseProps {
  /** Page arrival in progress: lines trace from the root outward, then nodes pop in. */
  arriving: boolean
  /** Pause motion (layout.motionPaused) or reduced motion: no breathing, no signal; static cues stay. */
  paused: boolean
  /** With no open run, the pinned (else most recent) project's team is drawn at rest. */
  restProjectId: string | null
}

export function TeamPulse(_props: TeamPulseProps): ReactElement | null {
  return null
}
