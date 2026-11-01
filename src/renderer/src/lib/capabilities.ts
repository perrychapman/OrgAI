import type {
  CapabilityAccess,
  CapabilityFlag,
  CapabilityGap,
  CapabilityItem,
  CapabilityProgressEvent,
  CapabilityRecommendation,
  CapabilitySourceId,
  CapabilitySourceStatus,
  Role,
  TeamRecommendations,
  TeamReview,
  TeamReviewSummary
} from '@shared/types'
import { CAPABILITY_OUTSIDE_ORIGINS, CAPABILITY_WRITE_TOOLS } from '@shared/types'
import { connectorById } from '@shared/connectors'

/**
 * The one adapter between the Team assistant UI and `window.orgai.capabilities`: a fresh request id per call, one
 * normalized result shape for a recommend and a review, and the pure wording helpers. Every string that came from a
 * file, a registry or GitHub is untrusted: it is only ever rendered as a text node, clamped with `clampText`.
 */

export const CAPABILITY_TEXT_MAX = 300

/** A SAFE_ID request id for progress events and cancel. */
export function newRequestId(prefix = 'cap'): string {
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().replace(/-/g, '').slice(0, 12) : Math.random().toString(36).slice(2, 14)
  return `${prefix}-${Date.now().toString(36)}-${rand}`
}

/** Untrusted text for display: control characters become spaces, whitespace collapses, long text ends in an ellipsis. */
export function clampText(s: string | undefined, max = CAPABILITY_TEXT_MAX): string {
  // eslint-disable-next-line no-control-regex
  const flat = (s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…` : flat
}

export type FlagTone = 'danger' | 'attention' | 'neutral'
export interface FlagView {
  key: string
  label: string
  tone: FlagTone
}

const FLAG_VIEW: Record<CapabilityFlag, { label: string; tone: FlagTone }> = {
  runsCode: { label: 'Runs code on this machine', tone: 'danger' },
  scripts: { label: 'Includes scripts', tone: 'attention' },
  remote: { label: 'Reaches a remote service', tone: 'neutral' },
  canChange: { label: 'Can change data', tone: 'attention' },
  unverified: { label: 'Unverified', tone: 'attention' },
  partial: { label: 'SKILL.md only', tone: 'neutral' }
}

export function flagLabel(flag: CapabilityFlag): string {
  return FLAG_VIEW[flag].label
}

/** "Needs: GITHUB_TOKEN, X_KEY" or null. Names only; values never reach the renderer. */
export function needsLabel(item: Pick<CapabilityItem, 'needsSecrets'>): string | null {
  const names = item.needsSecrets.map((n) => clampText(n, 40)).filter(Boolean)
  return names.length ? `Needs: ${names.join(', ')}` : null
}

/** Flags in a stable order: risk first. */
export function flagViews(item: Pick<CapabilityItem, 'flags' | 'needsSecrets'>): FlagView[] {
  const order: CapabilityFlag[] = ['runsCode', 'scripts', 'canChange', 'remote', 'unverified', 'partial']
  const out: FlagView[] = order.filter((f) => item.flags.includes(f)).map((f) => ({ key: f, ...FLAG_VIEW[f] }))
  const needs = needsLabel(item)
  if (needs) out.push({ key: 'needs', label: needs, tone: 'attention' })
  return out
}

export function isOutside(item: Pick<CapabilityItem, 'origin'>): boolean {
  return CAPABILITY_OUTSIDE_ORIGINS.includes(item.origin)
}

/** Source badge text per origin (docs/design/team-tab.md). */
export function sourceBadge(item: Pick<CapabilityItem, 'origin' | 'sourceLabel'> & { connectorId?: string; name?: string }): string {
  const label = clampText(item.sourceLabel, 40)
  switch (item.origin) {
    case 'repo':
      return 'Found in this repo'
    case 'local':
      return label ? `On this computer: ${label}` : 'On this computer'
    case 'library':
      return 'Your library'
    case 'project':
      return 'This project'
    case 'catalog': {
      const vendor = clampText(item.connectorId ? connectorById(item.connectorId)?.vendor : undefined, 40)
      return vendor ? `Curated · ${vendor}` : 'Curated'
    }
    default:
      return label || 'Outside source'
  }
}

/** The pin line: "Pinned: 1.2.3" or "Digest: abc123def456", or null when there is nothing to pin. */
export function pinLabel(item: Pick<CapabilityItem, 'version' | 'digest'>): string | null {
  if (item.version) return `Pinned: ${clampText(item.version, 60)}`
  if (item.digest) return `Digest: ${item.digest.slice(0, 12)}`
  return null
}

/** True when the role has a tool that lets it change things. */
export function roleCanWrite(role: Pick<Role, 'tools'>): boolean {
  return role.tools.some((t) => CAPABILITY_WRITE_TOOLS.includes(t))
}

/** Whether the access choice is worth showing: a connector with a read-only variant, or anything that can change data. */
export function accessChoiceOffered(item: Pick<CapabilityItem, 'kind' | 'readOnlyAvailable' | 'flags'>): boolean {
  // Nothing enforces read-only on a plain MCP server, so only a connector with a read-only variant offers the choice.
  return item.kind === 'connector' && item.readOnlyAvailable === true
}

/** "full" needs a write tool on every chosen role. */
export function fullAllowed(roles: readonly Pick<Role, 'tools'>[]): boolean {
  return roles.length > 0 && roles.every(roleCanWrite)
}

/** Plain sentence for the access a card grants. */
export function accessSentence(roleNames: readonly string[], itemName: string, access: CapabilityAccess, kind: CapabilityItem['kind']): string {
  if (roleNames.length === 0) return 'Nobody gets it until you choose a role.'
  const who = roleNames.length <= 2 ? roleNames.map((n) => clampText(n, 30)).join(' and ') : `${roleNames.length} roles`
  const what = clampText(itemName, 50)
  if (kind === 'skill') return `${who} can load ${what}.`
  if (kind !== 'connector') return `${who} can use ${what}.`
  return access === 'full' ? `${who} can read and change things through ${what}.` : `${who} can read through ${what}.`
}

const PHASE_LABEL: Partial<Record<CapabilitySourceId | 'model', string>> = {
  'repo-skills': 'Reading this repo',
  'repo-mcp': 'Reading this repo',
  'claude-skills': 'Checking Claude Code skills',
  'agents-skills': 'Checking agent skills on this computer',
  'copilot-skills': 'Checking Copilot skills',
  'claude-plugins': 'Checking Claude Code plugins',
  'claude-code-mcp': 'Checking Claude Code connections',
  'claude-desktop-mcp': 'Checking Claude Desktop connections',
  'cursor-mcp': 'Checking Cursor connections',
  'codex-mcp': 'Checking Codex connections',
  library: 'Checking your library',
  project: 'Checking this project',
  catalog: 'Checking the curated connectors',
  registry: 'Searching the MCP Registry',
  github: 'Searching anthropics/skills on GitHub',
  model: 'Choosing what fits each role'
}
export function phaseLabel(phase: CapabilitySourceId | 'model'): string {
  return PHASE_LABEL[phase] ?? 'Checking'
}

export type ProgressRow = { phase: CapabilityProgressEvent['phase']; label: string; state: CapabilityProgressEvent['state']; count?: number; message?: string }

/** Fold a progress event into the list (one row per label; later events replace earlier ones). */
export function foldProgress(rows: readonly ProgressRow[], e: CapabilityProgressEvent): ProgressRow[] {
  const label = phaseLabel(e.phase)
  const row: ProgressRow = { phase: e.phase, label, state: e.state, count: e.count, message: e.message ? clampText(e.message, 120) : undefined }
  const i = rows.findIndex((r) => r.label === label)
  if (i < 0) return [...rows, row]
  return rows.map((r, j) => (j === i ? row : r))
}

export function fallbackText(reason: TeamRecommendations['fallbackReason']): string {
  switch (reason) {
    case 'timeout':
      return 'the AI took too long to answer'
    case 'cancelled':
      return 'the search was cancelled'
    case 'noCandidates':
      return 'nothing was found to choose from'
    case 'invalidAnswer':
      return 'the AI gave an answer I could not use'
    default:
      return 'the AI could not be reached'
  }
}

/** Rate-limited or failed sources, one line each. */
export function sourceProblems(sources: readonly CapabilitySourceStatus[]): { source: CapabilitySourceId; text: string }[] {
  return sources
    .filter((s) => s.state === 'rateLimited' || s.state === 'error')
    .map((s) => ({
      source: s.source,
      text:
        s.state === 'rateLimited'
          ? `${clampText(s.label, 40)} is busy. ${s.retryAfterSec ? `Try again in ${s.retryAfterSec} s.` : 'Try again in a minute.'}`
          : `${clampText(s.label, 40)} did not answer.${s.message ? ` ${clampText(s.message, 120)}` : ''}`
    }))
}

/** One normalized result for the tray, from a recommend call or a review. */
export interface AssistantResult {
  origin: 'recommend' | 'review'
  digest: string
  items: Record<string, CapabilityItem>
  recommendations: CapabilityRecommendation[]
  gaps: CapabilityGap[]
  sources: CapabilitySourceStatus[]
  /** Set when a recommend did not use the AI: why, in words that finish "Recommended without the AI because ...". */
  fallbackReason?: string
  partial: boolean
  /** A review that did not run the model. */
  freeOnly: boolean
  evidenceCount: number
  checkedAt: string
}

function indexItems(items: readonly CapabilityItem[]): Record<string, CapabilityItem> {
  const out: Record<string, CapabilityItem> = {}
  for (const it of items) out[it.id] = it
  return out
}

export function fromRecommendations(r: TeamRecommendations): AssistantResult {
  return {
    origin: 'recommend',
    digest: r.digest,
    items: indexItems(r.discovery.items),
    recommendations: r.recommendations,
    gaps: r.gaps,
    sources: r.discovery.sources,
    fallbackReason: r.mode === 'fallback' ? fallbackText(r.fallbackReason) : undefined,
    partial: !!r.partial || !!r.discovery.partial,
    freeOnly: false,
    evidenceCount: 0,
    checkedAt: r.createdAt
  }
}

export function fromReview(r: TeamReview): AssistantResult {
  return {
    origin: 'review',
    digest: r.digest,
    items: indexItems(r.discovery.items),
    recommendations: r.recommendations,
    gaps: r.gaps,
    sources: r.discovery.sources,
    partial: !!r.discovery.partial,
    freeOnly: r.mode === 'free',
    evidenceCount: r.evidence.length,
    checkedAt: r.checkedAt
  }
}

/**
 * The one word for finishing an applied item's setup, used on the card, the applied row and the destination:
 * "Sign in" (OAuth connector), "Add token" (token connector) or "Add GITHUB_TOKEN" (a project server's env slot).
 */
export function setupLabel(info: { connectorId?: string; libraryId?: string; needsSetup?: { secrets: string[]; signIn: boolean } }): string {
  const n = info.needsSetup
  if (!n) return 'Finish setup'
  if (n.signIn) return 'Sign in'
  if (info.connectorId) return 'Add token'
  const first = n.secrets[0]
  return first ? `Add ${clampText(first, 40)}${n.secrets.length > 1 ? ` +${n.secrets.length - 1}` : ''}` : 'Add token'
}

/** "3 suggestions since your last run" / "1 suggestion waiting" / null. */
export function suggestionsLine(summary: Pick<TeamReviewSummary, 'pendingCount' | 'newCount'> | undefined): string | null {
  if (!summary || summary.pendingCount <= 0) return null
  const n = summary.pendingCount
  const noun = n === 1 ? 'suggestion' : 'suggestions'
  return summary.newCount > 0 ? `${n} ${noun} since your last run` : `${n} ${noun} waiting`
}

/** How many proactive cards show before "Show all". */
export const PROACTIVE_VISIBLE = 3

/** "3 suggestions since your last run" / "1 suggestion since your last run". */
export function sinceLine(n: number): string | null {
  return n > 0 ? `${n} ${n === 1 ? 'suggestion' : 'suggestions'} since your last run` : null
}

/** Skill matches first, otherwise the given order (stable). */
export function skillsFirst<T extends { candidateId: string }>(recs: readonly T[], items: Record<string, Pick<CapabilityItem, 'kind'> | undefined>): T[] {
  const rank = (r: T): number => (items[r.candidateId]?.kind === 'skill' ? 0 : 1)
  return recs.map((r, i) => ({ r, i })).sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i).map((x) => x.r)
}

/** The results heading: "3 to review for Reviewer", with the rest of the team's count when the list is narrower than the badge. */
export function resultsHeadText(open: number, scopeName: string, pending: number | undefined, scoped: boolean): string {
  if (!scoped) return `${open} to review`
  const base = `${open} to review for ${scopeName}`
  return pending !== undefined && pending > open ? `${base} · ${pending - open} waiting for the whole team` : base
}

/** "and 1 gap" / "and 3 gaps". */
export function gapsJumpText(n: number): string {
  return `and ${n} ${n === 1 ? 'gap' : 'gaps'}`
}

/** A dismissed candidate, as the tray lists it for Restore. */
export interface DismissedEntry {
  candidateId: string
  name: string
  kind: string
  dismissedAt: string
}

/**
 * The review's dismissed list, validated. Reads `{ candidateId, name, kind, dismissedAt }` (the restore contract) and
 * also the older `{ candidateId, at }`, taking the name from the review's items. Anything else is dropped.
 */
export function readDismissed(review: Pick<TeamReview, 'dismissed'> & { discovery?: { items?: readonly Pick<CapabilityItem, 'id' | 'name' | 'kind'>[] } }): DismissedEntry[] {
  const items = review.discovery?.items ?? []
  const out: DismissedEntry[] = []
  const seen = new Set<string>()
  for (const e of (review.dismissed ?? []).slice(0, 200)) {
    if (!e.candidateId || seen.has(e.candidateId)) continue
    const item = items.find((i) => i.id === e.candidateId)
    const name = clampText(e.name || item?.name, 80)
    if (!name) continue
    seen.add(e.candidateId)
    out.push({ candidateId: e.candidateId, name, kind: e.kind ?? item?.kind ?? 'mcp', dismissedAt: e.at })
  }
  return out
}

/** The capabilities API through the preload (a seam so the tray never reaches into window.orgai itself). */
export const capabilitiesApi = {
  recommend: (projectId: string, requestId: string, includeOutside: boolean, roleId?: string) =>
    window.orgai.capabilities.recommend({ projectId, requestId, includeOutside, scope: roleId ? { roleId } : undefined }),
  review: (projectId: string, trigger: 'manual' | 'opened', requestId?: string, includeOutside?: boolean) =>
    window.orgai.capabilities.review({ projectId, trigger, requestId, includeOutside }),
  lastReview: (projectId: string) => window.orgai.capabilities.lastReview(projectId),
  cancel: (requestId: string) => window.orgai.capabilities.cancel({ requestId }),
  // candidateId lets main dismiss a card from a fresh recommend() result too.
  dismiss: (projectId: string, recommendationId: string, candidateId?: string) =>
    window.orgai.capabilities.dismiss({ projectId, recommendationId, candidateId }),
  apply: (input: Parameters<typeof window.orgai.capabilities.apply>[0]) => window.orgai.capabilities.apply(input),
  undo: (projectId: string, undoId: string) => window.orgai.capabilities.undo({ projectId, undoId }),
  /** Undo a dismissal in main. */
  restore: (projectId: string, candidateId: string) => window.orgai.capabilities.restore({ projectId, candidateId }),
  onProgress: (cb: (e: CapabilityProgressEvent) => void) => window.orgai.onCapabilityProgress(cb)
}

/** Strip control characters from untrusted text but keep every other character (the full command is shown unclamped). */
export function stripControl(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ')
}
