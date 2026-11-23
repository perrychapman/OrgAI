import { defaultRoles, engagementRoles } from '@shared/defaults'
import type { OrgTemplateInfo, ProjectKind, Role } from '@shared/types'
import { ORG_TEMPLATE_ROLE_NAMES_MAX } from '@shared/types'
import { buildOrgExport } from './import/export'

/**
 * UI overhaul: the app's own starting charts as read-only templates. They are built from the same functions new projects
 * take their chart from (`defaultRoles`, `engagementRoles`), so they cannot drift from what a new project starts with.
 * They are never stored: not in templates.json, not counted against ORG_TEMPLATES_MAX. Only how often each was applied
 * is kept (TemplateService, in the index).
 */
export const BUILTIN_CODE_TEMPLATE_ID = 'builtin:code'
export const BUILTIN_ENGAGEMENT_TEMPLATE_ID = 'builtin:engagement'
export const BUILTIN_TEMPLATE_IDS = [BUILTIN_CODE_TEMPLATE_ID, BUILTIN_ENGAGEMENT_TEMPLATE_ID] as const

export function isBuiltinTemplateId(id: unknown): id is (typeof BUILTIN_TEMPLATE_IDS)[number] {
  return typeof id === 'string' && (BUILTIN_TEMPLATE_IDS as readonly string[]).includes(id)
}

const META: Record<(typeof BUILTIN_TEMPLATE_IDS)[number], { name: string; description: string; kind: ProjectKind; roles: () => Role[] }> = {
  [BUILTIN_CODE_TEMPLATE_ID]: {
    name: 'Code team',
    description: 'The team new code projects start with: an orchestrator over an implementer, a reviewer and a researcher.',
    kind: 'code',
    roles: () => defaultRoles()
  },
  [BUILTIN_ENGAGEMENT_TEMPLATE_ID]: {
    name: 'Engagement team',
    description: 'The neutral team new engagements start with: an engagement lead over a specialist, an analyst, a writer and a reviewer.',
    kind: 'engagement',
    roles: () => engagementRoles()
  }
}

/** A built-in template: its list entry (no appliedCount; the service adds it) and its org.json text. */
export function builtinTemplate(id: string): { info: OrgTemplateInfo; orgText: string } | null {
  if (!isBuiltinTemplateId(id)) return null
  const meta = META[id]
  const roles = meta.roles()
  const ordered = [...roles.filter((r) => r.reportsTo === null), ...roles.filter((r) => r.reportsTo !== null)]
  const info: OrgTemplateInfo = {
    id,
    name: meta.name,
    description: meta.description,
    kind: meta.kind,
    roleCount: roles.length,
    roleNames: ordered.map((r) => r.name).slice(0, ORG_TEMPLATE_ROLE_NAMES_MAX),
    createdAt: 0,
    updatedAt: 0,
    builtIn: true
  }
  // A fixed export time keeps the text the same on every call.
  const orgText = `${JSON.stringify(buildOrgExport({ name: meta.name, roles }, new Date(0)), null, 2)}\n`
  return { info, orgText }
}

/** Both built-in templates, code first. */
export function builtinTemplates(): OrgTemplateInfo[] {
  return BUILTIN_TEMPLATE_IDS.map((id) => (builtinTemplate(id) as { info: OrgTemplateInfo }).info)
}
