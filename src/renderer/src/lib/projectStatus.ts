import type { RunStatusView } from './runStatus'
import { relativeTime } from './runChains'

export interface ProjectStatusInput {
  /** Live (open) runs of the project and how many of them wait for the user. */
  open: number
  needsYou: number
  /** The newest run of the project, live or from history, with its status word (from lib/runStatus.ts). */
  newest?: { startedAt: number; status: Pick<RunStatusView, 'word'> }
  now?: number
}

export interface ProjectStatus {
  /** Dot class of the project row: 'warn' when something needs you, 'is-running' with open runs, else ''. */
  dot: 'warn' | 'is-running' | ''
  needsYou: number
  open: number
  /** One line for the tooltip and the active row; '' for a project with no runs. */
  subtitle: string
  /** Accessible-name suffix, e.g. "2 need you"; '' when nothing waits. */
  needsLabel: string
}

/** The one place that turns run counts into the sidebar's project state (dot, subtitle, accessible text). */
export function projectStatus(input: ProjectStatusInput): ProjectStatus {
  const { open, needsYou, newest, now } = input
  const dot = needsYou > 0 ? 'warn' : open > 0 ? 'is-running' : ''
  const subtitle =
    open > 0
      ? [`${open} open`, needsYou > 0 ? `${needsYou} needs you` : ''].filter(Boolean).join(' · ')
      : newest
        ? `Last run ${relativeTime(newest.startedAt, now)} · ${newest.status.word}`
        : ''
  return { dot, needsYou, open, subtitle, needsLabel: needsYou === 0 ? '' : needsYou === 1 ? '1 needs you' : `${needsYou} need you` }
}
