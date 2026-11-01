import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isSafeId } from '@shared/defaults'
import type { CapabilityRecommendation, TeamDismissal, TeamReview, TeamReviewSummary } from '@shared/types'

/**
 * The persisted Team review: `<dataDir>/team-reviews/<projectId>.json`, written atomically (temp file + rename).
 * A missing, oversized or malformed file reads as null. Never throws.
 */

const REVIEW_FILE_CAP = 8 * 1024 * 1024

export function reviewFile(dataDir: string, projectId: string): string | null {
  return isSafeId(projectId) ? join(dataDir, 'team-reviews', `${projectId}.json`) : null
}

const isArr = Array.isArray
const isStr = (v: unknown): v is string => typeof v === 'string'

/** The review when it has the expected shape for this project, else null. */
export function normalizeReview(v: unknown, projectId: string): TeamReview | null {
  if (!v || typeof v !== 'object' || isArr(v)) return null
  const r = v as Partial<TeamReview>
  if (r.projectId !== projectId || !isStr(r.checkedAt) || !isStr(r.digest)) return null
  const d = r.discovery
  if (!d || typeof d !== 'object' || !isArr(d.items) || !isArr(d.sources) || !isArr(d.warnings) || !isStr(d.digest)) return null
  if (!isArr(r.recommendations) || !isArr(r.gaps) || !isArr(r.evidence) || !isArr(r.dismissed) || !isArr(r.newCandidateIds)) return null
  if (r.mode !== 'free' && r.mode !== 'model') return null
  const validRec = (x: CapabilityRecommendation | undefined): boolean => !!x && isStr(x.id) && isStr(x.candidateId) && isArr(x.roleIds) && x.roleIds.every(isStr)
  const recommendations = r.recommendations.filter(validRec)
  // Dismissals: a malformed entry is dropped, a malformed held recommendation is forgotten, and a missing name is
  // filled from the review's own discovery (entries saved before names were kept).
  const names = new Map(d.items.map((i) => [i.id, i]))
  const dismissed: TeamDismissal[] = []
  for (const x of r.dismissed as TeamDismissal[]) {
    if (!x || !isStr(x.candidateId) || !isStr(x.fingerprint) || !isStr(x.at)) continue
    const out: TeamDismissal = { ...x }
    if (out.recommendation !== undefined && !validRec(out.recommendation)) delete out.recommendation
    const known = names.get(x.candidateId)
    if (!isStr(out.name) && known) out.name = known.name
    if (!isStr(out.kind) && known) out.kind = known.kind
    dismissed.push(out)
  }
  return {
    ...(r as TeamReview),
    recommendations,
    dismissed,
    pendingCount: recommendations.length,
    runsSinceModel: Number.isFinite(r.runsSinceModel) && (r.runsSinceModel as number) >= 0 ? Math.floor(r.runsSinceModel as number) : 0
  }
}

export function readReview(dataDir: string, projectId: string): TeamReview | null {
  const file = reviewFile(dataDir, projectId)
  if (!file) return null
  try {
    if (statSync(file).size > REVIEW_FILE_CAP) return null
    return normalizeReview(JSON.parse(readFileSync(file, 'utf8')), projectId)
  } catch {
    return null
  }
}

export function writeReview(dataDir: string, review: TeamReview): boolean {
  const file = reviewFile(dataDir, review.projectId)
  if (!file) return false
  const tmp = `${file}.${process.pid}.tmp`
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(tmp, JSON.stringify(review), 'utf8')
    renameSync(tmp, file)
    return true
  } catch {
    rmSync(tmp, { force: true })
    return false
  }
}

export function removeReview(dataDir: string, projectId: string): void {
  const file = reviewFile(dataDir, projectId)
  if (file) rmSync(file, { force: true })
}

export function reviewSummary(r: TeamReview): TeamReviewSummary {
  return {
    projectId: r.projectId,
    checkedAt: r.checkedAt,
    trigger: r.trigger,
    mode: r.mode,
    pendingCount: r.recommendations.length,
    newCount: r.newCandidateIds.length,
    evidenceCount: r.evidence.length
  }
}
