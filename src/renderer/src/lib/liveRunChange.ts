import type { LiveRunChange, Role } from '@shared/types'
import { serviceFor } from './roleServices'

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
  /** The content of something already granted was edited (a skill's text, a role's prompt). */
  | { kind: 'updated'; name: string }
  /** An org chart save added one role / removed one role. */
  | { kind: 'role-added'; name: string }
  | { kind: 'role-removed'; name: string }
  /** An org chart edit with no grants (a prompt, a name, the reporting lines). */
  | { kind: 'orgchart' }
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
  /** The run's answer, so a 'pending' line can be told apart and replaced by its final one. */
  availability: LiveRunChange['availability']
  /** Plain-text lines under the line, readable without a hover: a rename's caveat, roles that wait and why, a reason. */
  details: string[]
}

/** How many roles can use one item (Infinity = every role); 0 when it is switched off. */
export interface ItemReach {
  id: string
  name: string
  reach: number
}

/** A project server's reach: `roles` undefined = every role; disabled = nobody. */
export function serverReach(s: { id: string; name: string; connectorId?: string; enabled: boolean; roles?: string[] }): ItemReach {
  // The display name the connection rows show ("Context7"), not the slug the server is stored under.
  return { id: s.id, name: serviceFor(s).label, reach: s.enabled ? (s.roles === undefined ? Number.POSITIVE_INFINITY : s.roles.length) : 0 }
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

/** "a", "a and b", "a, b and c", "a, b and 2 more". */
export function joinNames(names: string[]): string {
  const list = [...new Set(names.map((n) => n.trim()).filter(Boolean))]
  if (list.length <= 1) return list[0] ?? ''
  if (list.length <= 3) return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`
  return `${list.slice(0, 2).join(', ')} and ${list.length - 2} more`
}

/**
 * What the grants a change named say it did (LiveRunChange.grants): every grant given = a grant, every grant taken =
 * a revoke, one or several items named. Null when there are none or they point both ways.
 */
export function actionFromGrants(grants: LiveRunChange['grants']): LiveChangeAction | null {
  if (!grants?.length) return null
  const given = grants.filter((g) => g.granted)
  const taken = grants.filter((g) => !g.granted)
  if (given.length && taken.length) return null
  const name = joinNames(grants.map((g) => g.item))
  return given.length ? { kind: 'grant', name } : { kind: 'revoke', name }
}

/**
 * Whether a run.liveChange event came from an org chart save (projects:save). Those saves return nothing, so they own the
 * 'orgChart' surface; mcp / skills saves answer with their own result and keep theirs. Main puts 'orgChart' in `what` for
 * every projects:save change, including one that only names grants (the role inspector's skill removal).
 */
export function isOrgChartChange(what: readonly string[]): boolean {
  return what.includes('orgChart')
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
    case 'role-added':
      return { now: `Added ${n} to this run`, 'after-idle': `Adds ${n} once its agents are idle`, pending: `Adding ${n}`, 'next-run': `Adds ${n} from the next run` }[availability]
    case 'role-removed':
      return { now: `Removed ${n} from this run`, 'after-idle': `Removes ${n} once its agents are idle`, pending: `Removing ${n}`, 'next-run': `Removes ${n} from the next run` }[availability]
    case 'orgchart':
      return {
        now: 'Org chart changes are in use now',
        'after-idle': 'Org chart changes are in use once its agents are idle',
        pending: 'Org chart changes are being applied',
        'next-run': 'Org chart changes are in use from the next run'
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
    // Several items in one save, or an org chart save with grants: the grants the run reports say what changed.
    const resolved = action.kind === 'changed' || action.kind === 'orgchart' ? (actionFromGrants(c.grants) ?? action) : action
    const effect = effectOf(resolved, c.availability)
    const reason = c.availability === 'next-run' ? squash(c.reason ?? '').replace(/\.$/, '') : ''
    const details = [
      ...(c.notes ?? []).map((n) => squash(n.note)),
      ...(c.deferred ?? []).map((d) => `${squash(d.name)} waits for the next run: ${squash(d.reason)}`),
      ...(reason ? [`${reason}.`] : [])
    ].filter(Boolean)
    return {
      runId: c.runId,
      title,
      effect,
      full: `${effect} · run “${title}”${reason ? `. ${reason}.` : ''}`,
      text: `${effect} · run “${clamp(title, MAX_TITLE)}”`,
      availability: c.availability,
      details
    }
  })
}

/**
 * What one org chart save did to the roster, read from the roles before and after it (the run.liveChange event does not
 * say). Exactly one role added or removed, or one role whose prompt changed under the same name, gives a named action;
 * a rename, several roles or nothing visible give null (the generic org chart wording, with the rename's own note). Pure.
 */
export function roleChangeAction(before: Pick<Role, 'id' | 'name' | 'prompt'>[] | null, after: Pick<Role, 'id' | 'name' | 'prompt'>[]): LiveChangeAction | null {
  if (!before) return null
  const was = new Map(before.map((r) => [r.id, r]))
  const now = new Map(after.map((r) => [r.id, r]))
  const added = after.filter((r) => !was.has(r.id))
  const removed = before.filter((r) => !now.has(r.id))
  const edited = after.filter((r) => {
    const old = was.get(r.id)
    return !!old && (old.name !== r.name || old.prompt !== r.prompt)
  })
  if (added.length + removed.length + edited.length !== 1) return null
  if (added.length) return { kind: 'role-added', name: squash(added[0].name) || 'a role' }
  if (removed.length) return { kind: 'role-removed', name: squash(removed[0].name) || 'a role' }
  const r = edited[0]
  return was.get(r.id)?.name === r.name ? { kind: 'updated', name: squash(r.name) || 'a role' } : null
}

/** What the lines of one note say as a whole: a summary line, the details every run shares (said once) and the rest per run. */
export interface LiveChangeSummary {
  /** "Org chart changes · 4 live runs: 3 now · 1 from the next run". */
  summary: string
  /** Detail rows every line carries (a rename's sentence), in the order of the first line. */
  shared: string[]
  /** Per line (same order as the input), the detail rows that are not shared. */
  own: string[][]
}

const WHEN_ORDER: LiveRunChange['availability'][] = ['now', 'pending', 'after-idle', 'next-run']
const WHEN_WORDS: Record<LiveRunChange['availability'], string> = { now: 'now', pending: 'being applied', 'after-idle': 'once idle', 'next-run': 'from the next run' }

/** The subject of a summary line, from what the user did. */
function subjectOf(action: LiveChangeAction): string {
  const n = 'name' in action ? action.name : ''
  switch (action.kind) {
    case 'grant':
      return `Access to ${n} given`
    case 'revoke':
      return `Access to ${n} removed`
    case 'saved-ungranted':
      return `${n} saved`
    case 'updated':
      return `Updated ${n}`
    case 'role-added':
      return `Added ${n}`
    case 'role-removed':
      return `Removed ${n}`
    case 'orgchart':
      return 'Org chart changes'
    case 'changed':
      return 'Change'
  }
}

/** One summary for the lines of a note, worded from their availabilities: "Change · 4 live runs: 2 now · 1 once idle · 1 from the next run". Pure. */
export function summarizeLines(lines: Pick<LiveChangeLine, 'availability' | 'details'>[], action: LiveChangeAction = { kind: 'changed' }): LiveChangeSummary {
  const parts = WHEN_ORDER.map((a) => [a, lines.filter((l) => l.availability === a).length] as const)
    .filter(([, n]) => n > 0)
    .map(([a, n]) => `${n} ${WHEN_WORDS[a]}`)
  const total = lines.length
  const summary = `${subjectOf(action)} · ${total} live run${total === 1 ? '' : 's'}: ${parts.join(' · ')}`
  const first = lines[0]?.details ?? []
  const shared = lines.length > 1 ? first.filter((d) => lines.every((l) => l.details.includes(d))) : []
  const own = lines.map((l) => l.details.filter((d) => !shared.includes(d)))
  return { summary, shared, own }
}
