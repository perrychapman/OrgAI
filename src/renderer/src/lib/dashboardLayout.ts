/**
 * The person's Dashboard arrangement (docs/design/dashboard-overhaul.md section 4.2): the order and hidden list of the
 * six arrangeable sections and the pinned projects. Pure; kept in renderer localStorage under `orgai.dashboardLayout`
 * (a view preference of this machine's window: main has no reader for it). Every function returns a new object.
 */

export const DASH_SECTIONS = ['resume', 'today', 'working', 'week', 'engagements', 'projects'] as const
export type DashSectionId = (typeof DASH_SECTIONS)[number]

export interface DashboardLayout {
  v: 1
  /** Every id exactly once. */
  order: DashSectionId[]
  /** A subset of `order`. */
  hidden: DashSectionId[]
  /** Project ids, in the order they were pinned, at most `PIN_LIMIT`. */
  pinned: string[]
}

export const LAYOUT_KEY = 'orgai.dashboardLayout'
export const PIN_LIMIT = 24

export const DEFAULT_LAYOUT: DashboardLayout = { v: 1, order: [...DASH_SECTIONS], hidden: [], pinned: [] }

/** The section titles, as headings and in every customise string ("Move Today up"). */
export const SECTION_TITLES: Record<DashSectionId, string> = {
  resume: 'Pick up where you left off',
  today: 'Today',
  working: 'Working now',
  week: 'Your week',
  engagements: 'Engagements',
  projects: 'Projects'
}

/** Half-width sections pair up in two tracks; Projects always takes the full row. */
const HALF: ReadonlySet<DashSectionId> = new Set<DashSectionId>(['resume', 'today', 'working', 'week', 'engagements'])

const isSection = (v: unknown): v is DashSectionId => typeof v === 'string' && (DASH_SECTIONS as readonly string[]).includes(v)

function fresh(): DashboardLayout {
  return { v: 1, order: [...DASH_SECTIONS], hidden: [], pinned: [] }
}

function uniqueSections(raw: unknown): DashSectionId[] {
  if (!Array.isArray(raw)) return []
  const out: DashSectionId[] = []
  for (const v of raw) if (isSection(v) && !out.includes(v)) out.push(v)
  return out
}

/**
 * Whatever was stored, a valid layout: unknown ids dropped, missing ids appended in default order, duplicates and
 * non-strings dropped, pins past the limit dropped; anything that is not a version-1 object is the default.
 */
export function normalizeLayout(raw: unknown): DashboardLayout {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fresh()
  const r = raw as Record<string, unknown>
  if (r.v !== 1) return fresh()
  const order = uniqueSections(r.order)
  // A section added after the layout was stored goes in at its default place (before the first default successor that is
  // present), so an older layout gains Engagements above Projects rather than after it.
  DASH_SECTIONS.forEach((id, i) => {
    if (order.includes(id)) return
    const after = DASH_SECTIONS.slice(i + 1)
      .map((n) => order.indexOf(n))
      .filter((n) => n >= 0)
    if (after.length === 0) order.push(id)
    else order.splice(Math.min(...after), 0, id)
  })
  const hidden = uniqueSections(r.hidden)
  const pinned: string[] = []
  if (Array.isArray(r.pinned)) {
    for (const p of r.pinned) {
      if (typeof p !== 'string' || p.length === 0 || pinned.includes(p)) continue
      if (pinned.length >= PIN_LIMIT) break
      pinned.push(p)
    }
  }
  return { v: 1, order, hidden, pinned }
}

/** Move a section one place; a no-op (the same object) at the ends. */
export function moveSection(l: DashboardLayout, id: DashSectionId, dir: 'up' | 'down'): DashboardLayout {
  const i = l.order.indexOf(id)
  const j = dir === 'up' ? i - 1 : i + 1
  if (i < 0 || j < 0 || j >= l.order.length) return l
  const order = [...l.order]
  ;[order[i], order[j]] = [order[j], order[i]]
  return { ...l, order }
}

export function setHidden(l: DashboardLayout, id: DashSectionId, hidden: boolean): DashboardLayout {
  const has = l.hidden.includes(id)
  if (hidden === has) return l
  return { ...l, hidden: hidden ? [...l.hidden, id] : l.hidden.filter((h) => h !== id) }
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

/** Order and hidden back to the default; pins are kept (a pin is about a project, not the layout). */
export function resetLayout(l: DashboardLayout): DashboardLayout {
  return { v: 1, order: [...DASH_SECTIONS], hidden: [], pinned: [...l.pinned] }
}

export function isDefaultArrangement(l: DashboardLayout): boolean {
  return l.hidden.length === 0 && l.order.every((id, i) => id === DASH_SECTIONS[i])
}

export interface PlacedSection {
  id: DashSectionId
  span: 'half' | 'full'
}

/**
 * Pairing in two tracks (section 2.2): walking the visible sections in order, two consecutive half-width sections share
 * a row; a half-width section with no partner takes the full row. In one track everything is full.
 */
export function placeSections(visible: readonly DashSectionId[], twoTracks: boolean): PlacedSection[] {
  if (!twoTracks) return visible.map((id) => ({ id, span: 'full' }))
  const out: PlacedSection[] = []
  let i = 0
  while (i < visible.length) {
    const id = visible[i]
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

/** "Today moved up. Position 2 of 5." */
export function movedText(l: DashboardLayout, id: DashSectionId, dir: 'up' | 'down'): string {
  return `${SECTION_TITLES[id]} moved ${dir}. Position ${l.order.indexOf(id) + 1} of ${l.order.length}.`
}

/** "Today is already first." / "Today is already last." */
export function atEndText(id: DashSectionId, dir: 'up' | 'down'): string {
  return `${SECTION_TITLES[id]} is already ${dir === 'up' ? 'first' : 'last'}.`
}
