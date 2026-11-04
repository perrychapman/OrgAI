/**
 * Team templates (docs/design/engagement-2.md section 3): pure helpers for the Team tab dialogs, the New project form
 * and the App settings list. No IPC, no React.
 */

import type { OrgTemplateInfo, Project, ProjectKind } from '@shared/types'

/** localStorage key of the template last used for a new project (preselected next time while it still exists). */
export const LAST_TEMPLATE_KEY = 'orgai.lastTemplateId'

/** Role names shown before "and N more". */
const ROLE_NAMES_SHOWN = 4

/** "Engagement" / "Code project". */
export function templateKindLabel(kind: ProjectKind): string {
  return kind === 'engagement' ? 'Engagement' : 'Code project'
}

/** The lower-case form inside a sentence: "engagement" / "code project". */
export function templateKindNoun(kind: ProjectKind): string {
  return kind === 'engagement' ? 'engagement' : 'code project'
}

/** "3 roles" / "1 role". */
export function roleCountText(count: number): string {
  return `${count} role${count === 1 ? '' : 's'}`
}

/** "5 roles: Lead, Analyst, Writer, Reviewer and 1 more". */
export function roleNamesLine(template: Pick<OrgTemplateInfo, 'roleCount' | 'roleNames'>): string {
  const names = template.roleNames.slice(0, ROLE_NAMES_SHOWN)
  const total = Math.max(template.roleCount, template.roleNames.length)
  const more = total - names.length
  const list = names.join(', ')
  if (names.length === 0) return roleCountText(total)
  return `${roleCountText(total)}: ${list}${more > 0 ? ` and ${more} more` : ''}`
}

/** "Saved 4 Nov 2026" from epoch ms (the date the template was last written). */
export function savedDateLine(ms: number): string {
  const d = new Date(ms)
  if (!Number.isFinite(d.getTime())) return 'Saved'
  return `Saved ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`
}

/** Templates of the project's kind first, then the rest ("Other kinds"). Each group keeps the list order. */
export function groupTemplatesByKind(templates: OrgTemplateInfo[], kind: ProjectKind): { same: OrgTemplateInfo[]; other: OrgTemplateInfo[] } {
  return { same: templates.filter((t) => t.kind === kind), other: templates.filter((t) => t.kind !== kind) }
}

/** "Made for a code project. Roles may speak in that kind's terms." for a template of another kind; null otherwise. */
export function kindNote(templateKind: ProjectKind, projectKind: ProjectKind): string | null {
  if (templateKind === projectKind) return null
  return `Made for ${templateKind === 'engagement' ? 'an' : 'a'} ${templateKindNoun(templateKind)}. Roles may speak in that kind's terms.`
}

/** "<name> (N roles)" for the New project Select. */
export function templateOptionLabel(t: Pick<OrgTemplateInfo, 'name' | 'roleCount'>): string {
  return `${t.name} (${roleCountText(t.roleCount)})`
}

/** The bullets of the Save dialog's "What goes in" list, then the "Not included" sentence. */
export function whatGoesIn(project: Pick<Project, 'roles' | 'kind'>): { included: string[]; excluded: string } {
  const engagement = project.kind === 'engagement'
  return {
    included: [
      `${roleCountText(project.roles.length)} with their instructions, models as tiers and tools`,
      'Which skills and services each role may use, by name',
      `Kind: ${templateKindLabel(engagement ? 'engagement' : 'code')}`
    ],
    excluded: engagement
      ? 'Not included: secret values, folders, the engagement plan, context notes and run history.'
      : 'Not included: secret values, folders and run history.'
  }
}

/** Skills and services the project holds outside the library that a role can use: a new project will not have them. */
export function localItemNames(project: Pick<Project, 'roles' | 'skills' | 'mcpServers'>): { skills: string[]; services: string[] } {
  const granted = new Set<string>()
  for (const r of project.roles) for (const id of r.skills ?? []) granted.add(id)
  const skills = (project.skills ?? []).filter((s) => !s.libraryId && granted.has(s.id)).map((s) => s.name)
  const slugs = new Set(project.roles.map((r) => r.slug))
  const direct = new Set<string>()
  for (const r of project.roles) for (const id of r.mcpServers ?? []) direct.add(id)
  const services = (project.mcpServers ?? [])
    .filter((s) => !s.libraryId && (direct.has(s.id) || s.roles === undefined || s.roles.some((slug) => slugs.has(slug))))
    .map((s) => s.name)
  return { skills, services }
}

/** The warning line for the Save dialog, or null when everything used is in the library. */
export function localItemsLine(project: Pick<Project, 'roles' | 'skills' | 'mcpServers'>): string | null {
  const { skills, services } = localItemNames(project)
  const all = [...skills, ...services]
  if (all.length === 0) return null
  return `Not in your library, so a new project will not have them: ${all.join(', ')}.`
}

/** A template with the same name (case-insensitive, trimmed), or undefined. */
export function duplicateTemplate(templates: readonly OrgTemplateInfo[] | null | undefined, name: string): OrgTemplateInfo | undefined {
  const want = name.trim().toLowerCase()
  if (!want) return undefined
  return (templates ?? []).find((t) => t.name.trim().toLowerCase() === want)
}

/** The Save dialog's default name. */
export function defaultTemplateName(projectName: string, max: number): string {
  return `${projectName.trim()} team`.slice(0, max)
}

/** True when main refused a save because the name is taken (so the field error and Replace it show). */
export function isNameTakenError(message: string): boolean {
  return /already|taken|exists/i.test(message)
}

export function readLastTemplateId(storage: Pick<Storage, 'getItem'> | undefined): string | null {
  try {
    return storage?.getItem(LAST_TEMPLATE_KEY) || null
  } catch {
    return null
  }
}

export function writeLastTemplateId(storage: Pick<Storage, 'setItem'> | undefined, id: string): void {
  try {
    storage?.setItem(LAST_TEMPLATE_KEY, id)
  } catch {
    /* storage unavailable: the next form starts on the first template */
  }
}

/** The template the New project Select starts on: the last used one while it still exists, else the first of this kind, else the first. */
export function initialTemplateId(templates: readonly OrgTemplateInfo[], kind: ProjectKind, last: string | null): string {
  if (last && templates.some((t) => t.id === last)) return last
  return (templates.find((t) => t.kind === kind) ?? templates[0])?.id ?? ''
}
