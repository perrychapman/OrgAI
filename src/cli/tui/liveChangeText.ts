/**
 * One-line status notice for a host change the user saved while a run is live
 * (the `run.liveChange` event): what this run does with it, and what waits.
 * A run that is not on screen is named by its tag (who).
 */

import type { LiveChangeWhat, LiveRunChange, RunSummary } from '../../shared/types'

export interface LiveChangeNotice {
  text: string
  tone: 'ok' | 'warn'
}

const WHAT_NAME: Record<LiveChangeWhat, string> = {
  mcpServers: 'MCP servers',
  skills: 'Skills',
  orgChart: 'The team',
  grants: 'Role grants'
}

function subject(what: readonly LiveChangeWhat[]): string {
  const names: string[] = []
  for (const w of what) {
    const name = WHAT_NAME[w]
    if (!name || names.includes(name)) continue
    names.push(name)
  }
  if (names.length === 0) return 'The change'
  if (names.length === 1) return names[0]
  if (names.length === 2) {
    const second = names[1] === 'The team' ? 'the team' : names[1]
    return `${names[0]} and ${second}`
  }
  return 'The change'
}

export function liveChangeNotice(
  change: LiveRunChange,
  what: readonly LiveChangeWhat[],
  who?: string
): LiveChangeNotice | undefined {
  if (change.availability === 'pending') return undefined

  const s = subject(what)
  // "this run" is the run on screen. Any other run is named by its tag, also inside the host's own sentences.
  const run = who ?? 'this run'
  const named = (t: string): string => (who ? t.replace(/\bthis run\b/gi, who) : t)
  let text: string
  let tone: 'ok' | 'warn'
  switch (change.availability) {
    case 'now':
      text = `${s}: ${run} uses the change now.`
      tone = 'ok'
      break
    case 'after-idle':
      text = `${s}: ${run} takes the change when it is next idle.`
      tone = 'ok'
      break
    default:
      text = `${s}: ${run} uses the change from the next run.`
      tone = 'warn'
      break
  }

  const reason = typeof change.reason === 'string' ? named(change.reason.trim()) : ''
  // A 'next-run' reason that itself says "next run" ("This run takes org chart changes from the next run.", "Some
  // grants name a server this run does not have; they apply from the next run.") already carries the sentence above
  // and often says which part waits, so it stands in for that sentence. Any other reason ("The run was still
  // starting ...", "OrgAI could not apply it ...") is added after it.
  // A run that is not on screen must stay named: its reason stands in only when it carries the tag itself.
  const standsIn = change.availability === 'next-run' && reason.toLowerCase().includes('next run') && (!who || reason.includes(who))
  if (reason && standsIn) text = `${s}: ${reason}`
  else if (reason) text += ` ${reason}`

  const deferred = Array.isArray(change.deferred) ? change.deferred : []
  if (deferred.length === 1) text += ' 1 role waits for the next run.'
  else if (deferred.length > 1) text += ` ${deferred.length} roles wait for the next run.`

  const notes = Array.isArray(change.notes) ? change.notes : []
  if (notes.length > 0 && typeof notes[0].note === 'string') text += ` ${named(notes[0].note.trim())}`

  return { text, tone }
}

/**
 * Whether a live run takes a team change saved in this terminal itself (RunManager.applyProjectChange): a team work
 * run this terminal hosts that is not stopping (RunManager skips a stopping run). A single-assistant or Chat run, any
 * other kind of run, and a run another terminal hosts keep the team they started with until their next run.
 */
export function takesSavedTeam(s: Pick<RunSummary, 'kind' | 'quick' | 'team' | 'liveElsewhere' | 'status'>): boolean {
  return s.kind === 'work' && !s.quick && s.team !== 'single' && !s.liveElsewhere && s.status !== 'stopping'
}
