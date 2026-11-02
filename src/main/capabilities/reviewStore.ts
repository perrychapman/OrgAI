import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isSafeId } from '@shared/defaults'
import type { CapabilityKind, CapabilityRecommendation, TeamDismissal, TeamReview, TeamReviewModelSkip, TeamReviewSummary } from '@shared/types'
import { clampText } from './sanitize'

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

/** Most role ids one stored recommendation keeps (a stored file is untrusted; roles are far fewer in practice). */
export const REVIEW_MAX_ROLE_IDS = 200
const KINDS: ReadonlySet<string> = new Set<CapabilityKind>(['skill', 'mcp', 'connector'])
const isKind = (v: unknown): v is CapabilityKind => isStr(v) && KINDS.has(v)
const SKIPS: ReadonlySet<string> = new Set<TeamReviewModelSkip>(['autoOff', 'autoFree', 'noChange', 'everyRuns', 'budget', 'error', 'timeout', 'cancelled', 'mockFree', 'pendingFull'])

/** A stored recommendation rebuilt field by field, or null when its id, candidate, kind or roles are unusable. */
function cleanRec(v: unknown): CapabilityRecommendation | null {
  if (!v || typeof v !== 'object' || isArr(v)) return null
  const x = v as Record<string, unknown>
  if (!isStr(x.id) || !isStr(x.candidateId) || !isKind(x.kind) || !isArr(x.roleIds)) return null
  const roleIds = [...new Set(x.roleIds.filter(isSafeId))].slice(0, REVIEW_MAX_ROLE_IDS)
  if (!roleIds.length) return null
  return {
    id: x.id,
    candidateId: x.candidateId,
    kind: x.kind,
    roleIds,
    reason: isStr(x.reason) ? clampText(x.reason, 300) : '',
    access: x.access === 'full' ? 'full' : 'read'
  }
}

/** The review when it has the expected shape for this project, else null. */
export function normalizeReview(v: unknown, projectId: string): TeamReview | null {
  if (!v || typeof v !== 'object' || isArr(v)) return null
  const r = v as Partial<TeamReview>
  if (r.projectId !== projectId || !isStr(r.checkedAt) || !isStr(r.digest)) return null
  const d = r.discovery
  if (!d || typeof d !== 'object' || !isArr(d.items) || !isArr(d.sources) || !isArr(d.warnings) || !isStr(d.digest)) return null
  if (!isArr(r.recommendations) || !isArr(r.gaps) || !isArr(r.evidence) || !isArr(r.dismissed) || !isArr(r.newCandidateIds)) return null
  if (r.mode !== 'free' && r.mode !== 'model') return null
  const recommendations = r.recommendations.map(cleanRec).filter((x): x is CapabilityRecommendation => !!x)
  // Dismissals: rebuilt field by field (a malformed entry is dropped, a malformed held recommendation is forgotten),
  // and a missing name or kind is filled from the review's own discovery (entries saved before names were kept).
  const names = new Map(d.items.map((i) => [i.id, i]))
  const dismissed: TeamDismissal[] = []
  for (const x of r.dismissed as unknown[]) {
    if (!x || typeof x !== 'object') continue
    const e = x as Record<string, unknown>
    if (!isStr(e.candidateId) || !isStr(e.fingerprint) || !isStr(e.at)) continue
    const out: TeamDismissal = { candidateId: e.candidateId, fingerprint: e.fingerprint, at: e.at }
    const known = names.get(e.candidateId)
    const name = isStr(e.name) ? clampText(e.name, 64) : known ? clampText(known.name, 64) : ''
    if (name) out.name = name
    const kind = isKind(e.kind) ? e.kind : known && isKind(known.kind) ? known.kind : undefined
    if (kind) out.kind = kind
    const rec = e.recommendation === undefined ? null : cleanRec(e.recommendation)
    if (rec) out.recommendation = rec
    dismissed.push(out)
  }
  // Only the known keys; unknown ones in the file are dropped.
  return {
    projectId,
    checkedAt: r.checkedAt,
    trigger: r.trigger === 'runEnded' || r.trigger === 'opened' ? r.trigger : 'manual',
    mode: r.mode,
    ...(isStr(r.modelSkipped) && SKIPS.has(r.modelSkipped) ? { modelSkipped: r.modelSkipped } : {}),
    discovery: d,
    digest: r.digest,
    newCandidateIds: r.newCandidateIds.filter(isStr),
    recommendations,
    gaps: r.gaps,
    evidence: r.evidence,
    dismissed,
    pendingCount: recommendations.length,
    runsSinceModel: Number.isFinite(r.runsSinceModel) && (r.runsSinceModel as number) >= 0 ? Math.floor(r.runsSinceModel as number) : 0,
    ...(Number.isFinite(r.tokensUsed) && (r.tokensUsed as number) >= 0 ? { tokensUsed: r.tokensUsed } : {}),
    ...(r.modelInput === 'proactive' || r.modelInput === 'full' ? { modelInput: r.modelInput } : {}),
    ...(r.stub === true ? { stub: true as const } : {})
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
