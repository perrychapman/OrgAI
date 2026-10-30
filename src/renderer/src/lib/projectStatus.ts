import type { RunStatusView } from './runStatus'
import { relativeTime } from './runChains'

export interface ProjectStatusInput {
  /** Live (open) runs of the project. */
  open: number
  /** Open decisions across those runs (lib/needsYou.ts `decisionCount`). The unit of every "needs you" number. */
  decisions: number
  /** The newest run of the project, live or from history, with its status word (from lib/runStatus.ts). */
  newest?: { startedAt: number; status: Pick<RunStatusView, 'word'> }
  now?: number
}

export interface ProjectStatus {
  /** Dot class of the project row: 'warn' when something needs you, 'is-running' with open runs, else ''. */
  dot: 'warn' | 'is-running' | ''
  /** Open decisions (the row's count badge). */
  decisions: number
  open: number
  /** One line for the tooltip and the active row; '' for a project with no runs. */
  subtitle: string
  /** Accessible-name suffix, e.g. "3 need you"; '' when nothing waits. */
  needsLabel: string
}

/**
 * The one place that turns run and decision counts into the sidebar's project state (dot, subtitle, accessible text).
 * One unit per level: decisions in the badge, the label and the Needs-you row; the run count appears only as "n runs".
 */
export function projectStatus(input: ProjectStatusInput): ProjectStatus {
  const { open, decisions, newest, now } = input
  const dot = decisions > 0 ? 'warn' : open > 0 ? 'is-running' : ''
  const runs = `${open} ${open === 1 ? 'run' : 'runs'}`
  const subtitle =
    decisions > 0
      ? `${decisions} ${decisions === 1 ? 'decision' : 'decisions'} · ${runs}`
      : open > 0
        ? `${open} open`
        : newest
          ? `Last run ${relativeTime(newest.startedAt, now)} · ${newest.status.word}`
          : ''
  return { dot, decisions, open, subtitle, needsLabel: decisions === 0 ? '' : decisions === 1 ? '1 needs you' : `${decisions} need you` }
}
