import type { Project, RunSummary } from '@shared/types'
import type { RunState } from '../../store/useAppStore'
import { needsYou } from '../../lib/runChains'
import { statusOfRun, type RunStatusView } from '../../lib/runStatus'
import type { BadgeTone } from '../ui/Badge'
import type { RunTone } from '../../lib/runStatus'

/** One shared status of a conversation: its newest session, with the live record's open cards when the store holds it. */
export function groupStatus(live: RunState | undefined, newest: RunSummary, project: Project | undefined): RunStatusView {
  return statusOfRun(live ?? { summary: newest }, project, !!live && needsYou(live))
}

/** History is the one place status is content: the shared status words in the Badge tones (running is cyan). */
export const STATUS_BADGE: Record<RunTone, BadgeTone> = {
  'is-running': 'working',
  warn: 'attention',
  idle: 'neutral',
  paused: 'neutral',
  ok: 'success',
  danger: 'danger',
  stopped: 'neutral'
}
