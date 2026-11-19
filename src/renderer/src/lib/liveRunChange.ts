import type { LiveRunChange } from '@shared/types'

/** One status line per live run a saved change reached. `text` is the whole line; `title` is the run's full title. */
export interface LiveChangeLine {
  runId: string
  title: string
  /** What happened to the run, without its title: "in use now", "once the agents are idle", ... */
  outcome: string
  text: string
}

const MAX_TITLE = 48

function clamp(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t
}

function outcomeOf(c: LiveRunChange): string {
  switch (c.availability) {
    case 'now':
      return 'in use now'
    case 'after-idle':
      return 'once the agents are idle'
    case 'pending':
      return 'being applied'
    case 'next-run': {
      const reason = (c.reason ?? '').replace(/\s+/g, ' ').trim().replace(/\.$/, '')
      return reason ? `from the next run: ${reason}` : 'from the next run'
    }
  }
}

/** The lines the user sees after a save: nothing when no live run was reached. Pure. */
export function liveChangeLines(liveRuns: LiveRunChange[] | undefined): LiveChangeLine[] {
  if (!liveRuns?.length) return []
  return liveRuns.map((c) => {
    const title = c.title.replace(/\s+/g, ' ').trim() || 'Untitled run'
    const outcome = outcomeOf(c)
    return { runId: c.runId, title, outcome, text: `${clamp(title, MAX_TITLE)}: ${outcome}` }
  })
}
