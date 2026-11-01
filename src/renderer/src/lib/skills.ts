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
  library: 'From the library',
  local: 'From this computer',
  github: 'From GitHub'
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
    const hit = byProject.get(u.projectId) ?? {
      name: u.projectName,
      roles: []
    }
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
  return {
    name: skillNameProblem(draft.name),
    description: skillDescriptionProblem(draft.description),
    body
  }
}

export function hasDraftProblems(p: DraftProblems): boolean {
  return p.name !== null || p.description !== null || p.body !== null
}

/** Visible warning for a skill that carries scripts, or null. */
export function skillElevatedHint(scripts: string[]): string | null {
  return scripts.length > 0 ? 'Includes scripts; may run shell commands' : null
}

const SEVERITY_RANK: Record<SkillFinding['severity'], number> = {
  warning: 0,
  info: 1
}

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
  const when = d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  })
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
    .map(([key, e]) => ({
      key,
      include: e.include ?? true,
      ...(e.roleIds !== undefined ? { roleIds: e.roleIds } : {})
    }))
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

/** Paths of a skill's files that look like scripts (a scripts/ folder or a runnable extension). Feeds `skillElevatedHint`. */
export function skillScriptPaths(files: readonly { path: string }[] | undefined): string[] {
  return (files ?? []).map((f) => f.path).filter((p) => /(^|\/)scripts\//i.test(p) || /\.(sh|bash|zsh|ps1|bat|cmd|py|js|mjs|cjs|ts|rb|pl)$/i.test(p))
}

// ---------- Evaluation results ----------

/** "2 findings, 1 suggestion" (zero parts left out); "no findings" when both are zero. */
export function evaluationCounts(report: Pick<SkillEvaluationReport, 'findings' | 'suggestions'>): string {
  const parts: string[] = []
  if (report.findings.length > 0) parts.push(plural(report.findings.length, 'finding'))
  if (report.suggestions.length > 0) parts.push(plural(report.suggestions.length, 'suggestion'))
  return parts.length > 0 ? parts.join(', ') : 'no findings'
}

/** Label of the Last evaluation disclosure: "Show 2 findings, 1 suggestion" / "Hide 2 findings, 1 suggestion". */
export function evaluationToggleLabel(report: Pick<SkillEvaluationReport, 'findings' | 'suggestions'> | null, open: boolean): string {
  if (!report) return open ? 'Hide' : 'Show'
  return `${open ? 'Hide' : 'Show'} ${evaluationCounts(report)}`
}

/** Live-region text after an evaluation: "Evaluation finished, 2 findings, 1 suggestion". */
export function evaluationAnnouncement(report: Pick<SkillEvaluationReport, 'findings' | 'suggestions'>): string {
  return `Evaluation finished, ${plural(report.findings.length, 'finding')}, ${plural(report.suggestions.length, 'suggestion')}`
}

/** Suggestions still waiting for a decision: not applied and not dismissed. */
export function openSuggestionCount(report: Pick<SkillEvaluationReport, 'suggestions'> | null, dismissed: ReadonlySet<string> = new Set()): number {
  return (report?.suggestions ?? []).filter((s) => !s.appliedSkillId && !dismissed.has(s.id)).length
}

/** Evidence lines of a finding. Count and runs are one line ("Seen 3 times in 3 runs"), not two that state the same fact. */
export function evidenceLines(e: SkillFinding['evidence'] | undefined): string[] {
  if (!e) return []
  const lines: string[] = []
  if (e.paths?.length) lines.push(`Missing paths: ${e.paths.join(', ')}`)
  if (e.sequence?.length) lines.push(`Tool sequence: ${e.sequence.join(' > ')}`)
  if (typeof e.similarity === 'number') lines.push(`Similarity: ${Math.round(e.similarity * 100)}%`)
  const runs = e.runIds?.length ?? 0
  if (typeof e.count === 'number') {
    const times = `Seen ${e.count} ${e.count === 1 ? 'time' : 'times'}`
    lines.push(times)
  } else if (runs > 0 && !e.sequence?.length) {
    lines.push(`In ${plural(runs, 'run')}`)
  }
  return lines
}

// ---------- Role access ----------

/** True when the skill is on but no role of the project may load it, so no agent ever gets it. */
export function loadableByNoRole(info: Pick<SkillInfo, 'spec' | 'grantedTo' | 'libraryMissing'>, roles: Pick<Role, 'id'>[]): boolean {
  if (!info.spec.enabled || info.libraryMissing) return false
  const known = new Set(roles.map((r) => r.id))
  return !info.grantedTo.some((id) => known.has(id))
}

export type SkillAddVerb = 'created' | 'added' | 'applied' | 'imported'

/** Success notice after a skill is added. It says so when no role can load it. */
export function skillAddedNotice(name: string, verb: SkillAddVerb, roleCount: number): { tone: 'success' | 'warning'; title: string; body: string } {
  if (roleCount > 0) {
    return {
      tone: 'success',
      title: `${name} ${verb}.`,
      body: `${plural(roleCount, 'role')} can load it.`
    }
  }
  return {
    tone: 'warning',
    title: `${name} ${verb}.`,
    body: 'No role can load it yet. Until you choose roles, no agent loads it.'
  }
}

/** Notice after Promote to library. */
export function promotedNotice(name: string): string {
  return `${name} is now in the library. Edits happen there.`
}

/** Badge text for a project skill: a linked one is just "Library", the rest name where they came from. */
export function projectProvenance(spec: Pick<SkillInfo['spec'], 'libraryId' | 'source'>): string {
  return spec.libraryId ? 'Library' : sourceLabel(spec.source)
}

/** Projects that use a library skill, each once, with the roles holding it ("Used by" as a list). */
export function usedByList(usedBy: SkillLibraryInfo['usedBy']): { projectId: string; projectName: string; roles: string[] }[] {
  const byProject = new Map<string, { projectId: string; projectName: string; roles: string[] }>()
  for (const u of usedBy) {
    const hit = byProject.get(u.projectId) ?? {
      projectId: u.projectId,
      projectName: u.projectName,
      roles: []
    }
    for (const r of u.roleNames) if (!hit.roles.includes(r)) hit.roles.push(r)
    byProject.set(u.projectId, hit)
  }
  return [...byProject.values()]
}

/** One line per project that loses a library skill: "Atlas: Writer and QA lose access." (roles from usedBy[].roleNames). */
export function libraryRemoveLines(usedBy: SkillLibraryInfo['usedBy']): string[] {
  return usedByList(usedBy).map((p) =>
    p.roles.length > 0 ? `${p.projectName}: ${joinWords(p.roles)} ${p.roles.length === 1 ? 'loses' : 'lose'} access.` : `${p.projectName}: no role holds it.`
  )
}

// ---------- Import wording ----------

/** Banner sentence with the counts named once: "Skills in .claude/skills: 2 can be imported, 1 cannot." */
export function importBannerLine(importable: number, refused: number, roots: string[]): string {
  const where = roots.length > 0 ? ` in ${joinWords(roots)}` : ''
  return `Skills${where}: ${importable} can be imported${refused > 0 ? `, ${refused} cannot` : ''}.`
}

/** Quiet line kept after an import: "1 skill in the repository cannot be imported." */
export function refusedSkillsLine(count: number): string {
  return `${plural(count, 'skill')} in the repository cannot be imported.`
}

/** The keys named by an importer note ("Dropped frontmatter keys: allowed-tools, hooks."), or []. */
export function droppedKeysOf(notes: readonly string[]): string[] {
  for (const n of notes) {
    const m = /^Dropped frontmatter keys: ([^\n]+?)\.?$/.exec(n)
    if (m) {
      return m[1]
        .split(',')
        .map((k) => k.trim())
        .filter(Boolean)
    }
  }
  return []
}

/** "deploy-check: dropped allowed-tools, hooks, which OrgAI does not run". */
export function droppedKeysLine(name: string, keys: string[]): string {
  return `${name}: dropped ${keys.join(', ')}, which OrgAI does not run`
}

// ---------- Body refusal ----------

/** True for the server's refusal of a body that runs shell commands when loaded. */
export function isBodyRefusal(message: string): boolean {
  return message.includes('Runs shell commands when loaded')
}

/** Splits text so !`...` can be shown in a code span. */
export function codeSpans(text: string): { text: string; code: boolean }[] {
  return text
    .split(/(!`[^`]*`)/)
    .filter((t) => t.length > 0)
    .map((t) => ({ text: t, code: /^!`[^`]*`$/.test(t) }))
}
