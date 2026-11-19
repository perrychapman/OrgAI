import type { LiveRunChange } from '@shared/types'

/**
 * What the user just did, as the caller knows it. The wording of the status line is built from this plus each run's
 * availability, so the line says what changed and cannot contradict the banner beside it.
 */
export type LiveChangeAction =
  /** A role was given a skill or connection (a grant, or switching it on). */
  | { kind: 'grant'; name: string }
  /** A role lost a skill or connection (a revoke, or switching it off, or removing it). */
  | { kind: 'revoke'; name: string }
  /** A skill or connection was saved but no role can load it yet. */
  | { kind: 'saved-ungranted'; name: string }
  /** The content of something already granted was edited. */
  | { kind: 'updated'; name: string }
  /** Anything else (import, suggestion, several items at once): no single name to give. */
  | { kind: 'changed' }

/** One status line per live run a saved change reached. `text` is the whole line; `title` is the run's full title. */
export interface LiveChangeLine {
  runId: string
  title: string
  /** What happened, without the run's title: "Can use api-design now", "No longer uses Context7", ... */
  effect: string
  /** The full line without truncation (the tooltip). */
  full: string
  text: string
}

/** How many roles can use one item (Infinity = every role); 0 when it is switched off. */
export interface ItemReach {
  id: string
  name: string
  reach: number
}

/** A project server's reach: `roles` undefined = every role; disabled = nobody. */
export function serverReach(s: { id: string; name: string; enabled: boolean; roles?: string[] }): ItemReach {
  return { id: s.id, name: s.name, reach: s.enabled ? (s.roles === undefined ? Number.POSITIVE_INFINITY : s.roles.length) : 0 }
}

/** A project skill's reach: the roles granted it; disabled = nobody. */
export function skillReach(s: { spec: { id: string; name: string; enabled: boolean }; grantedTo: string[] }): ItemReach {
  return { id: s.spec.id, name: s.spec.name, reach: s.spec.enabled ? s.grantedTo.length : 0 }
}

/**
 * What a save did, read from the list before and after it (the saves come from many dialogs and rows that cannot each
 * say). Exactly one item changing gives a named action; several, or none visible, give the general one. Pure.
 */
export function inferAction(before: ItemReach[] | null, after: ItemReach[]): LiveChangeAction {
  if (!before) return { kind: 'changed' }
  const was = new Map(before.map((i) => [i.id, i]))
  const now = new Map(after.map((i) => [i.id, i]))
  const moves: LiveChangeAction[] = []
  for (const i of after) {
    const old = was.get(i.id)
    if (!old) moves.push(i.reach > 0 ? { kind: 'grant', name: i.name } : { kind: 'saved-ungranted', name: i.name })
    else if (i.reach > old.reach) moves.push({ kind: 'grant', name: i.name })
    else if (i.reach < old.reach) moves.push({ kind: 'revoke', name: i.name })
  }
  for (const o of before) if (!now.has(o.id) && o.reach > 0) moves.push({ kind: 'revoke', name: o.name })
  return moves.length === 1 ? moves[0] : { kind: 'changed' }
}

const MAX_TITLE = 40

function squash(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function clamp(text: string, max: number): string {
  const t = squash(text)
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t
}

/** The effect on one run, status first. "its agents" because the subject (the run) follows at the end of the line. */
export function effectOf(action: LiveChangeAction, availability: LiveRunChange['availability']): string {
  const n = 'name' in action ? action.name : ''
  switch (action.kind) {
    case 'grant':
      return { now: `Can use ${n} now`, 'after-idle': `Can use ${n} once its agents are idle`, pending: `Applying access to ${n}`, 'next-run': `Can use ${n} from the next run` }[availability]
    case 'revoke':
      return { now: `No longer uses ${n}`, 'after-idle': `Stops using ${n} once its agents are idle`, pending: `Removing ${n}`, 'next-run': `Stops using ${n} from the next run` }[availability]
    case 'saved-ungranted': {
      const tail = '; no role can load it yet'
      return { now: `Has ${n}${tail}`, 'after-idle': `Gets ${n} once its agents are idle${tail}`, pending: `Applying ${n}${tail}`, 'next-run': `Gets ${n} from the next run${tail}` }[availability]
    }
    case 'updated':
      return {
        now: `Updated ${n} is in use now`,
        'after-idle': `Updated ${n} is in use once its agents are idle`,
        pending: `Updated ${n} is being applied`,
        'next-run': `Updated ${n} is in use from the next run`
      }[availability]
    case 'changed':
      return { now: 'Change is in use now', 'after-idle': 'Change is in use once its agents are idle', pending: 'Change is being applied', 'next-run': 'Change is in use from the next run' }[availability]
  }
}

/**
 * The lines the user sees after a save: nothing when no live run was reached. Pure. The run's title comes last, in quotes,
 * so a truncated title never lands before the effect; the reason for a deferral stays in the tooltip.
 */
export function liveChangeLines(liveRuns: LiveRunChange[] | undefined, action: LiveChangeAction = { kind: 'changed' }): LiveChangeLine[] {
  if (!liveRuns?.length) return []
  return liveRuns.map((c) => {
    const title = squash(c.title) || 'Untitled run'
    const effect = effectOf(action, c.availability)
    const reason = c.availability === 'next-run' ? squash(c.reason ?? '').replace(/\.$/, '') : ''
    return {
      runId: c.runId,
      title,
      effect,
      full: `${effect} · run “${title}”${reason ? `. ${reason}.` : ''}`,
      text: `${effect} · run “${clamp(title, MAX_TITLE)}”`
    }
  })
}
