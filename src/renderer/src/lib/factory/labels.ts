// Factory Floor label placement (docs/design/factory-floor.md section 6.2). Pure: which nameplates, line signs and the
// dock and board labels show for one camera, by priority, collision and the cap of 24 plates.
import type { ScreenRect } from './camera'

/** Why a nameplate wants to show, highest first. */
export type LabelReason = 'selected' | 'focused' | 'hovered' | 'needs-you' | 'failed' | 'conflict' | 'other'
export type LabelKind = 'nameplate' | 'sign' | 'dock' | 'board'

export const LABEL_REASONS: readonly LabelReason[] = ['selected', 'focused', 'hovered', 'needs-you', 'failed', 'conflict', 'other']
/** These are never skipped: they show even when they overlap, and push lower plates out. */
export const NEVER_SKIPPED: ReadonlySet<LabelReason> = new Set(['selected', 'focused', 'hovered', 'needs-you'])
/** At most this many nameplates (the never-skipped ones always show). */
export const LABEL_CAP = 24
/** Everyone else's nameplate shows from this zoom. */
export const ALL_PLATES_PPM = 18

export interface LabelCandidate {
  /** Unique within its kind (a worker id, a sign key, 'dock', 'board'). */
  id: string
  kind: LabelKind
  /** Nameplates: the highest reason that applies. Other kinds ignore it. */
  reason?: LabelReason
  /** Where the label would sit, in stage px. */
  rect: ScreenRect
  /** Tie-break within a reason: reading order (smaller first). */
  order: number
}

export interface PlaceOptions {
  ppm: number
  stage: { width: number; height: number }
  cap?: number
}

/** The key placeLabels returns for a candidate. */
export const labelKey = (c: Pick<LabelCandidate, 'kind' | 'id'>): string => `${c.kind}:${c.id}`

const overlaps = (a: ScreenRect, b: ScreenRect): boolean => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
const onStage = (r: ScreenRect, w: number, h: number): boolean => r.right > 0 && r.bottom > 0 && r.left < w && r.top < h

const KIND_RANK: Record<LabelKind, number> = { nameplate: 0, sign: 1, dock: 2, board: 3 }

/**
 * Greedy placement in priority order (section 6.2): selected, focused, hovered, Needs you, Failed, merge conflict, then
 * everyone else when ppm >= 18; then line signs and the dock and board labels. A plate that would overlap a placed one
 * is skipped, except the never-skipped kinds. At most `cap` nameplates beyond the never-skipped ones. Off-stage labels
 * never show. Returns the keys (labelKey) of the labels to show, in placement order.
 */
export function placeLabels(candidates: readonly LabelCandidate[], opts: PlaceOptions): string[] {
  const cap = opts.cap ?? LABEL_CAP
  const { width, height } = opts.stage
  const rank = (c: LabelCandidate): number => (c.kind === 'nameplate' ? LABEL_REASONS.indexOf(c.reason ?? 'other') : LABEL_REASONS.length + KIND_RANK[c.kind])
  const sorted = candidates
    .filter((c) => onStage(c.rect, width, height))
    .filter((c) => c.kind !== 'nameplate' || (c.reason ?? 'other') !== 'other' || opts.ppm >= ALL_PLATES_PPM)
    .sort((a, b) => rank(a) - rank(b) || a.order - b.order)
  const placed: LabelCandidate[] = []
  let plates = 0
  for (const c of sorted) {
    const forced = c.kind === 'nameplate' && NEVER_SKIPPED.has(c.reason ?? 'other')
    if (!forced) {
      if (c.kind === 'nameplate' && plates >= cap) continue
      if (placed.some((p) => overlaps(p.rect, c.rect))) continue
    }
    placed.push(c)
    if (c.kind === 'nameplate') plates++
  }
  return placed.map(labelKey)
}
