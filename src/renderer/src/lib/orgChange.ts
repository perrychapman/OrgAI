import type { ProjectKind, ProposalKind, RunSummary } from '@shared/types'
import { runName, RUN_NAME_EXCERPT_CHARS } from './runLabels'
import { proposalKindLabel } from './decisionTitle'
import { runKindLabel } from './assistants'

/**
 * Org change sessions (docs/design/ux-review-org-change-session-pre.md): an ordinary setup run started from the Team
 * tab's "Revise with the Architect" or Settings > Maintenance. The prompt is the only thing that marks one (main sets no
 * title for setup runs), so the prompt wording below is the contract between the start paths and every label.
 */

/** Prefix of a targeted change: "Revise this project's org chart and setup: <what should change>". */
export const ORG_CHANGE_PREFIX = "Revise this project's org chart and setup: "

/** The full review of a code project (nothing written in the start form, or Maintenance's review). */
export const ORG_REVIEW_PROMPT = 'Review this project and revise its architecture document, org chart and settings where they no longer fit the code.'

/** The full review of an engagement (no repository, no architecture document). */
export const ORG_REVIEW_PROMPT_ENGAGEMENT = 'Review this engagement and revise its plan, org chart and settings where they no longer fit the work.'

/** Earlier Maintenance wording, so its runs read as reviews too. */
const LEGACY_REVIEW_PREFIX = 'Review .orgai/ARCHITECTURE.md against the current code'

export const ORG_CHANGE_KIND_LABEL = 'Org change'
export const ORG_REVIEW_TITLE = 'Org chart review'

/** The setup prompt for a change ("" or whitespace = the full review). */
export function orgChangePrompt(text: string, kind: ProjectKind = 'code'): string {
  const t = text.replace(/\s+/g, ' ').trim()
  if (t) return `${ORG_CHANGE_PREFIX}${t}`
  return kind === 'engagement' ? ORG_REVIEW_PROMPT_ENGAGEMENT : ORG_REVIEW_PROMPT
}

type Kinded = Pick<RunSummary, 'kind' | 'prompt'>

function isReviewPrompt(prompt: string): boolean {
  return prompt === ORG_REVIEW_PROMPT || prompt === ORG_REVIEW_PROMPT_ENGAGEMENT || prompt.startsWith(LEGACY_REVIEW_PREFIX)
}

/** True for a setup run started as an org change or an org chart review. */
export function isOrgChangeRun(s: Partial<Kinded> | null | undefined): boolean {
  if (!s || s.kind !== 'setup' || typeof s.prompt !== 'string') return false
  const p = s.prompt.trim()
  return p.startsWith(ORG_CHANGE_PREFIX.trim()) || isReviewPrompt(p)
}

const TITLE_LEAD = 'Org chart: '

/**
 * "Org chart: add a database specialist" (the change, first letter lowered unless it starts an acronym, trailing
 * period dropped, cut at a word near RUN_NAME_EXCERPT_CHARS with an ellipsis), "Org chart review" for a full review,
 * null for any other run.
 */
export function orgChangeTitle(s: Partial<Kinded> | null | undefined): string | null {
  if (!isOrgChangeRun(s)) return null
  const p = (s?.prompt ?? '').replace(/\s+/g, ' ').trim()
  if (isReviewPrompt(p)) return ORG_REVIEW_TITLE
  let text = p.slice(ORG_CHANGE_PREFIX.trim().length).trim().replace(/[.!\s]+$/, '')
  if (!text) return ORG_REVIEW_TITLE
  if (/^[A-Z][a-z]/.test(text)) text = text[0].toLowerCase() + text.slice(1)
  const room = RUN_NAME_EXCERPT_CHARS
  if (text.length > room) {
    const cut = text.slice(0, room)
    const space = cut.lastIndexOf(' ')
    text = `${(space >= room / 2 ? cut.slice(0, space) : cut.slice(0, room - 1)).replace(/[\s,;:.-]+$/, '')}…`
  }
  return `${TITLE_LEAD}${text}`
}

/** The name a run goes by everywhere in the renderer: the org change title, else the shared run name. */
export function displayRunName(s: (Kinded & { title?: string }) | undefined): string {
  return orgChangeTitle(s) ?? runName(s)
}

/** The kind word shown in History and kind chips: "Org change" for an org change session, else the usual label. */
export function runKindWord(s: Pick<RunSummary, 'kind' | 'quick' | 'prompt'> & Partial<Pick<RunSummary, 'team'>>): string {
  return isOrgChangeRun(s) ? ORG_CHANGE_KIND_LABEL : runKindLabel(s)
}

export interface SetupBannerInput {
  summary: Pick<RunSummary, 'kind' | 'prompt' | 'status' | 'endedWithApp'> & { endedBy?: RunSummary['endedBy'] }
  /** The project's setup state is 'complete'. */
  setupComplete: boolean
  /** The run was cut while it was doing something (renderer `RunState.cutWhile`). */
  cut: boolean
  /** Proposal kinds the user approved in this view. */
  approved: readonly ProposalKind[]
}

/**
 * Whether the "Setup complete" / "Org change applied" banner may show (walk M2): only for a setup run that ended or went
 * idle on its own, never one cut off by a quit or crash; an org change session also needs an approval seen here, since
 * the project's setup state was already complete before it started.
 */
export function setupBannerShows({ summary, setupComplete, cut, approved }: SetupBannerInput): boolean {
  if (summary.kind !== 'setup' || !setupComplete) return false
  if (summary.status !== 'finished' && summary.status !== 'idle') return false
  if (cut || summary.endedWithApp || summary.endedBy === 'app') return false
  return !isOrgChangeRun(summary) || approved.length > 0
}

/** "Org change applied: org chart, settings", naming what the user approved in this session. */
export function orgChangeBannerTitle(approved: readonly ProposalKind[], projectKind?: ProjectKind): string {
  const words = approved.map((k) => {
    const label = proposalKindLabel(k, projectKind)
    return /^[A-Z][a-z]/.test(label) ? label[0].toLowerCase() + label.slice(1) : label
  })
  return `Org change applied: ${words.join(', ')}`
}

/** The live org change session of a project the Team tab points at: needs-you first, else the newest. */
export function liveOrgChangeRun<T extends { summary: RunSummary }>(runs: readonly T[], projectId: string, isLive: (r: T) => boolean, waiting: (r: T) => boolean): T | null {
  let best: T | null = null
  for (const r of runs) {
    if (r.summary.projectId !== projectId || !isOrgChangeRun(r.summary) || !isLive(r)) continue
    if (!best) best = r
    else if (waiting(r) !== waiting(best)) best = waiting(r) ? r : best
    else if (r.summary.startedAt > best.summary.startedAt) best = r
  }
  return best
}
