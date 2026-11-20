import { create } from 'zustand'
import type { LiveRunChange, Role, RunEvent } from '@shared/types'
import { isOrgChartChange, liveChangeLines, roleChangeAction, type LiveChangeAction, type LiveChangeLine } from '../lib/liveRunChange'

/** How long the line stays after the last answer to a save. A later save of the same project replaces it. */
export const LIVE_CHANGE_NOTE_MS = 20_000

/** A save never keeps its line longer than this after it was made, however late a slow run answers. */
export const LIVE_CHANGE_NOTE_MAX_MS = 30_000

/** Events of one org chart save for different runs arrive within this window; they share one note. */
const SAME_SAVE_MS = 5_000

/** A role diff or a "this surface saved" mark is read for an event that arrives within this window. */
const ROUTE_MS = 8_000

/**
 * The surface that made a save, so only that place shows (and announces) the line: the Connections section, the Skills
 * section, the role inspector of one role, or the org chart editor (its saves return nothing, so the line comes from the
 * run.liveChange event).
 */
export type LiveChangeSurface = 'mcp' | 'skills' | 'orgChart' | `role:${string}`

/** Which group of the role inspector a note belongs to: its line sits under that group's header. */
export type LiveChangePart = 'connections' | 'skills'

export interface LiveChangeNoteState {
  surface: LiveChangeSurface
  /** Only for the role inspector: the group the line sits under. */
  part?: LiveChangePart
  lines: LiveChangeLine[]
  /** The answers the lines were worded from (same order), so a line can be worded again. */
  changes: LiveRunChange[]
  /** What the save did, kept so a 'pending' line can be worded again when its final answer arrives. */
  action: LiveChangeAction
  at: number
}

interface LiveChangeState {
  /** The newest note per project id (one at a time); absent when the last save reached no live run. */
  notes: Record<string, LiveChangeNoteState>
}

export const useLiveChangeStore = create<LiveChangeState>(() => ({ notes: {} }))

const timers = new Map<string, number>()

function clearTimer(projectId: string): void {
  const prev = timers.get(projectId)
  if (prev !== undefined) window.clearTimeout(prev)
  timers.delete(projectId)
}

function drop(projectId: string): void {
  clearTimer(projectId)
  useLiveChangeStore.setState((s) => {
    if (!s.notes[projectId]) return s
    const notes = { ...s.notes }
    delete notes[projectId]
    return { notes }
  })
}

/**
 * Shows `note` (or nothing) for the project and restarts its expiry: 20 s after this answer (the final one, once a
 * pending line is replaced), but never later than 30 s after the save itself.
 */
function show(projectId: string, note: LiveChangeNoteState | null): void {
  clearTimer(projectId)
  useLiveChangeStore.setState((s) => {
    const notes = { ...s.notes }
    if (note && note.lines.length) notes[projectId] = note
    else delete notes[projectId]
    return { notes }
  })
  if (!note || !note.lines.length) return
  const left = Math.max(0, Math.min(LIVE_CHANGE_NOTE_MS, note.at + LIVE_CHANGE_NOTE_MAX_MS - Date.now()))
  timers.set(projectId, window.setTimeout(() => drop(projectId), left))
}

/**
 * Call with every mcp / skills mutation result of a project: shows the lines on the surface that saved, or clears the
 * old ones. `action` says what the user did so the line can say what changed; `part` puts a role inspector line under
 * the group it belongs to.
 */
export function reportLiveRuns(
  projectId: string,
  surface: LiveChangeSurface,
  liveRuns: LiveRunChange[] | undefined,
  action: LiveChangeAction = { kind: 'changed' },
  part?: LiveChangePart
): void {
  const changes = liveRuns ?? []
  // The role inspector's skills chooser reports through useProjectSkills, which names no group: it is the Skills one.
  const group = part ?? (surface.startsWith('role:') ? 'skills' : undefined)
  show(projectId, { surface, ...(group ? { part: group } : {}), lines: liveChangeLines(changes, action), changes, action, at: Date.now() })
}

// ---------- routing an org chart save made from the role inspector ----------

const expected = new Map<string, { surface: LiveChangeSurface; part: LiveChangePart; at: number }>()

/**
 * The role inspector is about to save through the project save (a skill removed, a role's connection list narrowed). That
 * save returns nothing, so its run.liveChange event is drawn on this surface, under this group, instead of the org chart
 * editor's.
 */
export function expectInspectorSave(projectId: string, surface: LiveChangeSurface, part: LiveChangePart): void {
  expected.set(projectId, { surface, part, at: Date.now() })
}

// ---------- what an org chart save did to the roster ----------

type RoleKey = Pick<Role, 'id' | 'name' | 'prompt'>
const rosters = new Map<string, { prev: RoleKey[] | null; cur: RoleKey[]; at: number }>()

function sameRoster(a: RoleKey[], b: RoleKey[]): boolean {
  return a.length === b.length && a.every((r, i) => r.id === b[i].id && r.name === b[i].name && r.prompt === b[i].prompt)
}

/** The roster change made lately, when it can be named (one role added, removed or its prompt edited); null otherwise. */
function recentRosterAction(projectId: string): LiveChangeAction | null {
  const h = rosters.get(projectId)
  return h?.prev && Date.now() - h.at < ROUTE_MS ? roleChangeAction(h.prev, h.cur) : null
}

/**
 * Call with a project's roles whenever they change (the always-mounted org chart note does). The last change is kept so a
 * save's line can say "Added X" / "Removed X" / "Updated X"; a line that is already up is worded again.
 */
export function trackRoles(projectId: string, roles: Pick<Role, 'id' | 'name' | 'prompt'>[]): void {
  const cur = roles.map((r) => ({ id: r.id, name: r.name, prompt: r.prompt }))
  const h = rosters.get(projectId)
  if (!h) {
    rosters.set(projectId, { prev: null, cur, at: 0 })
    return
  }
  if (sameRoster(h.cur, cur)) return
  rosters.set(projectId, { prev: h.cur, cur, at: Date.now() })
  const note = useLiveChangeStore.getState().notes[projectId]
  if (!note || note.surface !== 'orgChart' || (note.action.kind !== 'orgchart' && note.action.kind !== 'updated' && note.action.kind !== 'role-added' && note.action.kind !== 'role-removed')) return
  if (Date.now() - note.at > ROUTE_MS) return
  const action = recentRosterAction(projectId) ?? { kind: 'orgchart' as const }
  useLiveChangeStore.setState((s) => ({ notes: { ...s.notes, [projectId]: { ...note, action, lines: liveChangeLines(note.changes, action) } } }))
}

/**
 * A run.liveChange event (main sends one per live run per applied change, and a second one when a 'pending' answer
 * resolves). Each save shows once, on the surface that made it:
 * - an org chart save returns nothing, so the event makes the line on the 'orgChart' surface (events of one save for
 *   several runs share one note; a pending line is replaced by its final one), or on the role inspector's surface when
 *   it made the save (expectInspectorSave);
 * - an mcp / skills save already shows the line from its result, so the event only replaces that save's 'pending' line
 *   with the final answer and never adds a second line.
 */
export function reportLiveEvent(e: Extract<RunEvent, { type: 'run.liveChange' }>): void {
  const prev = useLiveChangeStore.getState().notes[e.projectId]
  const orgChart = isOrgChartChange(e.what)
  if (!orgChart) {
    if (!prev || e.change.availability === 'pending') return
    const idx = prev.lines.findIndex((l) => l.runId === e.runId && l.availability === 'pending')
    if (idx < 0) return
    const [line] = liveChangeLines([e.change], prev.action)
    const lines = prev.lines.slice()
    lines[idx] = line
    const changes = prev.changes.slice()
    changes[idx] = e.change
    show(e.projectId, { ...prev, lines, changes })
    return
  }
  const now = Date.now()
  const mark = expected.get(e.projectId)
  const routed = mark && now - mark.at < ROUTE_MS && !!e.change.grants?.length ? mark : null
  const surface: LiveChangeSurface = routed ? routed.surface : 'orgChart'
  const action: LiveChangeAction = routed ? { kind: 'changed' } : (recentRosterAction(e.projectId) ?? { kind: 'orgchart' })
  const sameSave =
    !!prev && prev.surface === surface && (now - prev.at < SAME_SAVE_MS || prev.changes.some((c) => c.runId === e.runId && c.availability === 'pending'))
  const kept = sameSave && prev ? prev.changes : []
  const at = kept.findIndex((c) => c.runId === e.runId)
  const changes = kept.slice()
  if (at >= 0) changes[at] = e.change
  else changes.push(e.change)
  // liveChangeLines words each run from the grants it reports (a skill removed) when the action is generic.
  show(e.projectId, {
    surface,
    ...(routed ? { part: routed.part } : {}),
    lines: liveChangeLines(changes, action),
    changes,
    action,
    at: sameSave && prev ? prev.at : now
  })
}
