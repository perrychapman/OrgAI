/**
 * The person's Dashboard arrangement (docs/design/dashboard-usage-redesign/project/dashboard.md "What is personal"): the
 * order and hidden list of the arrangeable sections, the pinned projects, the focus figure of Your week and whether the
 * page's live loops are paused. Pure; kept in renderer localStorage under `orgai.dashboardLayout` (a view preference of
 * this machine's window: main has no reader for it). Every function returns a new object.
 *
 * Needs you and Right now are fixed regions of the page and are never in this list: personalisation never hides a
 * decision. Engagements, Commits and To-dos are kept from the previous Dashboard as optional sections after Projects
 * (implementation-notes.md, deviation D1).
 *
 * Version 2 replaced version 1 (resume, today, working, week, engagements, projects). A version-1 value migrates:
 * resume becomes Pick up, today becomes Up next and To-dos, working is dropped (Right now is fixed), order and hidden
 * are kept for the rest, pins are kept.
 */

export const DASH_SECTIONS = ['week', 'pickup', 'upnext', 'projects', 'engagements', 'commits', 'todos'] as const
export type DashSectionId = (typeof DASH_SECTIONS)[number]

/** The figure that leads Your week (its sparkline in the accent text colour). */
export const FOCUS_FIGURES = ['spend', 'runs', 'time', 'decisions'] as const
export type FocusFigure = (typeof FOCUS_FIGURES)[number]

export interface DashboardLayout {
  v: 2
  /** Every id exactly once. */
  order: DashSectionId[]
  /** A subset of `order`. */
  hidden: DashSectionId[]
  /** Project ids, in the order they were pinned, at most `PIN_LIMIT`. */
  pinned: string[]
  /** Which figure leads Your week. */
  focus: FocusFigure
  /** Pause motion: the breathing marks and the Team pulse signal show their end state (a static cue). */
  motionPaused: boolean
}

export const LAYOUT_KEY = 'orgai.dashboardLayout'
export const PIN_LIMIT = 24

export const DEFAULT_LAYOUT: DashboardLayout = { v: 2, order: [...DASH_SECTIONS], hidden: [], pinned: [], focus: 'spend', motionPaused: false }

/** The section titles, as headings and in every customise string ("Move Up next up"). */
export const SECTION_TITLES: Record<DashSectionId, string> = {
  week: 'Your week',
  pickup: 'Pick up',
  upnext: 'Up next',
  projects: 'Projects',
  engagements: 'Engagements',
  commits: 'Commits this week',
  todos: 'To-dos'
}

export const FOCUS_TITLES: Record<FocusFigure, string> = { spend: 'Spend', runs: 'Runs', time: 'Agent time', decisions: 'Decisions' }

/** Sections that may share a row in two tracks; Your week and Projects always take the full row. */
const HALF: ReadonlySet<DashSectionId> = new Set<DashSectionId>(['pickup', 'upnext', 'engagements', 'commits', 'todos'])

const isSection = (v: unknown): v is DashSectionId => typeof v === 'string' && (DASH_SECTIONS as readonly string[]).includes(v)
const isFocus = (v: unknown): v is FocusFigure => typeof v === 'string' && (FOCUS_FIGURES as readonly string[]).includes(v)

function fresh(): DashboardLayout {
  return { v: 2, order: [...DASH_SECTIONS], hidden: [], pinned: [], focus: 'spend', motionPaused: false }
}

/** Version-1 ids to their version-2 successors (in order); `working` has none. */
const V1_MAP: Record<string, DashSectionId[]> = {
  resume: ['pickup'],
  today: ['upnext', 'todos'],
  working: [],
  week: ['week'],
  engagements: ['engagements'],
  projects: ['projects']
}

/** The version-1 default order after mapping (with or without the later Engagements). */
const V1_DEFAULT_MAPPED = 'pickup,upnext,todos,week,engagements,projects'

function uniqueSections(raw: unknown, v1: boolean): DashSectionId[] {
  if (!Array.isArray(raw)) return []
  const out: DashSectionId[] = []
  for (const v of raw) {
    const ids = v1 ? (typeof v === 'string' && Object.hasOwn(V1_MAP, v) ? V1_MAP[v]! : []) : isSection(v) ? [v] : []
    for (const id of ids) if (!out.includes(id)) out.push(id)
  }
  return out
}

function pinsOf(raw: unknown): string[] {
  const pinned: string[] = []
  if (!Array.isArray(raw)) return pinned
  for (const p of raw) {
    if (typeof p !== 'string' || p.length === 0 || pinned.includes(p)) continue
    if (pinned.length >= PIN_LIMIT) break
    pinned.push(p)
  }
  return pinned
}

/**
 * Whatever was stored, a valid layout: unknown ids dropped, missing ids inserted at their default place (before the
 * first default successor that is present), duplicates and non-strings dropped, pins past the limit dropped; a
 * version-1 object migrates; anything else is the default.
 */
export function normalizeLayout(raw: unknown): DashboardLayout {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fresh()
  const r = raw as Record<string, unknown>
  if (r.v !== 1 && r.v !== 2) return fresh()
  const v1 = r.v === 1
  let order = uniqueSections(r.order, v1)
  // A version-1 layout in the old default order takes the new default order; otherwise ids it never had go last.
  if (v1 && order.join() === V1_DEFAULT_MAPPED) order = [...DASH_SECTIONS]
  if (v1) for (const id of DASH_SECTIONS) if (!order.includes(id)) order.push(id)
  DASH_SECTIONS.forEach((id, i) => {
    if (order.includes(id)) return
    const after = DASH_SECTIONS.slice(i + 1)
      .map((n) => order.indexOf(n))
      .filter((n) => n >= 0)
    if (after.length === 0) order.push(id)
    else order.splice(Math.min(...after), 0, id)
  })
  const hidden = uniqueSections(r.hidden, v1)
  return {
    v: 2,
    order,
    hidden,
    pinned: pinsOf(r.pinned),
    focus: isFocus(r.focus) ? r.focus : 'spend',
    motionPaused: r.motionPaused === true
  }
}

/** Move a section one place; a no-op (the same object) at the ends. */
export function moveSection(l: DashboardLayout, id: DashSectionId, dir: 'up' | 'down'): DashboardLayout {
  const i = l.order.indexOf(id)
  const j = dir === 'up' ? i - 1 : i + 1
  if (i < 0 || j < 0 || j >= l.order.length) return l
  const order = [...l.order]
  ;[order[i], order[j]] = [order[j]!, order[i]!]
  return { ...l, order }
}

export function setHidden(l: DashboardLayout, id: DashSectionId, hidden: boolean): DashboardLayout {
  const has = l.hidden.includes(id)
  if (hidden === has) return l
  return { ...l, hidden: hidden ? [...l.hidden, id] : l.hidden.filter((h) => h !== id) }
}

export function setFocus(l: DashboardLayout, focus: FocusFigure): DashboardLayout {
  return l.focus === focus || !isFocus(focus) ? l : { ...l, focus }
}

export function setMotionPaused(l: DashboardLayout, paused: boolean): DashboardLayout {
  return l.motionPaused === paused ? l : { ...l, motionPaused: paused }
}

/** Pin (append) or unpin (remove) a project. Past the limit a pin is refused: the same object comes back. */
export function togglePin(l: DashboardLayout, projectId: string): DashboardLayout {
  if (l.pinned.includes(projectId)) return { ...l, pinned: l.pinned.filter((p) => p !== projectId) }
  if (l.pinned.length >= PIN_LIMIT) return l
  return { ...l, pinned: [...l.pinned, projectId] }
}

/** Drop pins of projects that no longer exist (run when projects load and after a delete). */
export function pruneLayoutPins(l: DashboardLayout, knownProjectIds: Iterable<string>): DashboardLayout {
  const known = new Set(knownProjectIds)
  const pinned = l.pinned.filter((p) => known.has(p))
  return pinned.length === l.pinned.length ? l : { ...l, pinned }
}

/** Order, hidden and the focus figure back to the default; pins and Pause motion are kept (they are not the layout). */
export function resetLayout(l: DashboardLayout): DashboardLayout {
  return { v: 2, order: [...DASH_SECTIONS], hidden: [], pinned: [...l.pinned], focus: 'spend', motionPaused: l.motionPaused }
}

export function isDefaultArrangement(l: DashboardLayout): boolean {
  return l.hidden.length === 0 && l.focus === 'spend' && l.order.every((id, i) => id === DASH_SECTIONS[i])
}

export interface PlacedSection {
  id: DashSectionId
  span: 'half' | 'full'
}

/**
 * Pairing in two tracks: walking the visible sections in order, two consecutive half-width sections share a row; a
 * half-width section with no partner takes the full row. In one track everything is full.
 */
export function placeSections(visible: readonly DashSectionId[], twoTracks: boolean): PlacedSection[] {
  if (!twoTracks) return visible.map((id) => ({ id, span: 'full' }))
  const out: PlacedSection[] = []
  let i = 0
  while (i < visible.length) {
    const id = visible[i]!
    const next = visible[i + 1]
    if (HALF.has(id) && next !== undefined && HALF.has(next)) {
      out.push({ id, span: 'half' }, { id: next, span: 'half' })
      i += 2
    } else {
      out.push({ id, span: 'full' })
      i += 1
    }
  }
  return out
}

/** The stored layout, normalised; the default when nothing is stored or storage throws. */
export function readLayout(storage: Pick<Storage, 'getItem'> | null | undefined): DashboardLayout {
  try {
    const text = storage?.getItem(LAYOUT_KEY)
    if (!text) return fresh()
    return normalizeLayout(JSON.parse(text))
  } catch {
    return fresh()
  }
}

/** Never throws: a failing storage keeps the layout in memory for the session. */
export function writeLayout(storage: Pick<Storage, 'setItem'> | null | undefined, l: DashboardLayout): void {
  try {
    storage?.setItem(LAYOUT_KEY, JSON.stringify(l))
  } catch {
    // ignore
  }
}

/** "Up next moved up. Position 2 of 7." */
export function movedText(l: DashboardLayout, id: DashSectionId, dir: 'up' | 'down'): string {
  return `${SECTION_TITLES[id]} moved ${dir}. Position ${l.order.indexOf(id) + 1} of ${l.order.length}.`
}

/** "Your week is already first." / "To-dos is already last." */
export function atEndText(id: DashSectionId, dir: 'up' | 'down'): string {
  return `${SECTION_TITLES[id]} is already ${dir === 'up' ? 'first' : 'last'}.`
}
