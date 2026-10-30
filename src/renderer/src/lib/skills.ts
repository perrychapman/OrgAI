import type {
  Role,
  SkillDraft,
  SkillEvaluationReport,
  SkillFinding,
  SkillImportChoice,
  SkillImportItem,
  SkillImportPreview,
  SkillInfo,
  SkillLibraryInfo,
  SkillSource,
  SkillSuggestion,
  SkillUseCount
} from '@shared/types'
import { AGENT_IMPORT_MAX_CHOICES, SKILL_BODY_MAX_CHARS } from '@shared/types'
import { skillDescriptionProblem, skillNameProblem } from '@shared/defaults'

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

function joinWords(parts: string[]): string {
  if (parts.length <= 1) return parts.join('')
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

const SOURCE_LABELS: Record<SkillSource, string> = {
  user: 'Written in OrgAI',
  repo: 'From the repository',
  suggestion: 'From a suggestion',
  library: 'From the library'
}

export function sourceLabel(source: SkillSource): string {
  return SOURCE_LABELS[source] ?? source
}

/** "Roles: none", "Roles: all 4 roles", "Roles: Writer, QA" (up to 3 names), "Roles: 5 roles". */
export function grantSummary(info: Pick<SkillInfo, 'grantedTo'>, roles: Pick<Role, 'id' | 'name'>[]): string {
  const known = new Set(roles.map((r) => r.id))
  const ids = [...new Set(info.grantedTo)].filter((id) => known.has(id))
  if (ids.length === 0) return 'Roles: none'
  if (roles.length > 1 && ids.length === roles.length) return `Roles: all ${roles.length} roles`
  if (ids.length <= 3) {
    const names = ids.map((id) => roles.find((r) => r.id === id)?.name ?? id)
    return `Roles: ${names.join(', ')}`
  }
  return `Roles: ${ids.length} roles`
}

/** "Not used by any project" / "Used by 2 projects: A (Writer, QA), B". */
export function usedByLine(usedBy: SkillLibraryInfo['usedBy']): string {
  if (usedBy.length === 0) return 'Not used by any project'
  const byProject = new Map<string, { name: string; roles: string[] }>()
  for (const u of usedBy) {
    const hit = byProject.get(u.projectId) ?? { name: u.projectName, roles: [] }
    for (const r of u.roleNames) if (!hit.roles.includes(r)) hit.roles.push(r)
    byProject.set(u.projectId, hit)
  }
  const parts = [...byProject.values()].map((p) => (p.roles.length ? `${p.name} (${p.roles.join(', ')})` : p.name))
  return `Used by ${plural(byProject.size, 'project')}: ${parts.join(', ')}`
}

export interface ConfirmCopy {
  title: string
  body: string
  confirmLabel: string
}

/** Wording of the confirm dialog before a project skill is deleted, or a linked one unlinked. */
export function removeConfirmCopy(info: Pick<SkillInfo, 'spec' | 'grantedTo'>, roleNames: string[], kind: 'delete' | 'unlink'): ConfirmCopy {
  const name = info.spec.name
  const grants =
    roleNames.length > 0 ? ` ${joinWords(roleNames)} will lose access to it.` : info.grantedTo.length > 0 ? ' Roles that hold it will lose access.' : ''
  if (kind === 'unlink') {
    return {
      title: `Unlink ${name}?`,
      body: `The skill stays in the library; only this project stops using it.${grants}`,
      confirmLabel: 'Unlink'
    }
  }
  return {
    title: `Delete ${name}?`,
    body: `This removes the skill and its files from this project. It cannot be undone.${grants}`,
    confirmLabel: 'Delete'
  }
}

export interface DraftProblems {
  name: string | null
  description: string | null
  body: string | null
}

/** Field problems of a draft (null = fine). The body must be non-empty and at most SKILL_BODY_MAX_CHARS. */
export function draftProblems(draft: SkillDraft): DraftProblems {
  const body = !draft.body.trim()
    ? 'A skill needs instructions.'
    : draft.body.length > SKILL_BODY_MAX_CHARS
      ? `The instructions are too long (at most ${SKILL_BODY_MAX_CHARS.toLocaleString('en-US')} characters).`
      : null
  return { name: skillNameProblem(draft.name), description: skillDescriptionProblem(draft.description), body }
}

export function hasDraftProblems(p: DraftProblems): boolean {
  return p.name !== null || p.description !== null || p.body !== null
}

/** Visible warning for a skill that carries scripts, or null. */
export function skillElevatedHint(scripts: string[]): string | null {
  return scripts.length > 0 ? 'Includes scripts; may run shell commands' : null
}

const SEVERITY_RANK: Record<SkillFinding['severity'], number> = { warning: 0, info: 1 }

/** Sort key: warnings first. */
export function severityOrder(severity: SkillFinding['severity']): number {
  return SEVERITY_RANK[severity] ?? 2
}

export function sortFindings(findings: SkillFinding[]): SkillFinding[] {
  return findings
    .map((f, i) => ({ f, i }))
    .sort((a, b) => severityOrder(a.f.severity) - severityOrder(b.f.severity) || a.i - b.i)
    .map((x) => x.f)
}

/** Why the model-assisted step did not run, in words (null when it ran). */
export function skippedReasonText(reason: SkillEvaluationReport['skippedReason'] | undefined, error?: string): string | null {
  switch (reason) {
    case 'disabled':
      return 'Model-assisted suggestions are off. Turn them on in the skill settings.'
    case 'no-gaps':
      return 'No repeated work was found, so no new skills were suggested.'
    case 'budget':
      return 'Suggestions were skipped: the estimate was over the token budget.'
    case 'error':
      return `Suggestions failed${error ? `: ${error}` : '.'} The checks above still ran.`
    default:
      return null
  }
}

export function appliedCount(suggestions: SkillSuggestion[]): number {
  return suggestions.filter((s) => s.appliedSkillId).length
}

/** "Checked May 3, 14:05 · 2 findings · 1 suggestion · 1 applied". */
export function evaluationSummary(report: Pick<SkillEvaluationReport, 'at' | 'findings' | 'suggestions'>, now: number = Date.now()): string {
  const d = new Date(report.at)
  const sameYear = d.getFullYear() === new Date(now).getFullYear()
  const when = d.toLocaleString('en-US', { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }), hour: '2-digit', minute: '2-digit', hour12: false })
  const parts = [`Checked ${when}`, plural(report.findings.length, 'finding'), plural(report.suggestions.length, 'suggestion')]
  const applied = appliedCount(report.suggestions)
  if (applied > 0) parts.push(`${applied} applied`)
  return parts.join(' · ')
}

/** "Found 3 skills in .claude/skills." (several roots: "... in .claude/skills and .agents/skills."); null when none. */
export function importFoundLine(preview: Pick<SkillImportPreview, 'items'> | null | undefined): string | null {
  const items = preview?.items ?? []
  if (items.length === 0) return null
  const roots = [...new Set(items.map((i) => i.root))]
  return `Found ${plural(items.length, 'skill')} in ${joinWords(roots)}.`
}

/** Skills the import would add or update (not yet in the project). */
export function importNotImportedCount(preview: Pick<SkillImportPreview, 'items'> | null | undefined): number {
  return (preview?.items ?? []).filter((i) => i.action === 'add' || i.action === 'update').length
}

/** Banner line for skills in the repository that are not in the project. */
export function skillsNotImportedLine(count: number): string {
  return `Found ${plural(count, 'skill')} in the repository that ${count === 1 ? 'is' : 'are'} not in this project.`
}

export type SkillBannerMemory = 'dismissed' | 'imported'

export const skillBannerKey = (projectId: string): string => `orgai.skills-import-banner.${projectId}`

export function readSkillBannerMemory(storage: Pick<Storage, 'getItem'> | undefined, projectId: string): SkillBannerMemory | null {
  try {
    const v = storage?.getItem(skillBannerKey(projectId))
    return v === 'dismissed' || v === 'imported' ? v : null
  } catch {
    return null
  }
}

export function writeSkillBannerMemory(storage: Pick<Storage, 'setItem'> | undefined, projectId: string, value: SkillBannerMemory): void {
  try {
    storage?.setItem(skillBannerKey(projectId), value)
  } catch {
    /* storage unavailable: the banner just comes back next time */
  }
}

export function skillBannerVisible(notImported: number, memory: SkillBannerMemory | null): boolean {
  return notImported > 0 && memory === null
}

/** The user's edits to one previewed skill. Unset fields keep what the importer chose. */
export interface SkillImportEdit {
  include?: boolean
  roleIds?: string[]
}

/** Initial inclusion: everything that would add or update, unless its name conflicts. */
export function defaultIncluded(item: Pick<SkillImportItem, 'action' | 'nameConflict'>): boolean {
  return (item.action === 'add' || item.action === 'update') && !item.nameConflict
}

/** The choices sent to previewImport / applyImport: only keys the user edited, capped at AGENT_IMPORT_MAX_CHOICES. */
export function buildSkillChoices(edits: Record<string, SkillImportEdit>): SkillImportChoice[] {
  return Object.entries(edits)
    .slice(0, AGENT_IMPORT_MAX_CHOICES)
    .map(([key, e]) => ({ key, include: e.include ?? true, ...(e.roleIds !== undefined ? { roleIds: e.roleIds } : {}) }))
}

export function skillImportButtonLabel(count: number): string {
  return `Import ${plural(count, 'skill')}`
}

/** "Imported 2 skills (1 updated)." */
export function skillImportedSummary(added: number, updated: number): string {
  const total = added + updated
  return `Imported ${plural(total, 'skill')}${updated > 0 ? ` (${updated} updated)` : ''}.`
}

/** RunUsage.skills as a line: "api-design x3, pdf". Empty string when none. */
export function skillUseLine(skills: SkillUseCount[] | undefined, max = 5): string {
  const list = skills ?? []
  const shown = list.slice(0, max).map((s) => (s.loads > 1 ? `${s.name} x${s.loads}` : s.name))
  if (list.length > max) shown.push(`+${list.length - max} more`)
  return shown.join(', ')
}

export function skillUseTotal(skills: SkillUseCount[] | undefined): number {
  return (skills ?? []).reduce((n, s) => n + s.loads, 0)
}

/** Activity text for a skill load, e.g. "Loaded skill api-design". */
export function skillActivityText(name: string): string {
  return `Loaded skill ${name}`
}
