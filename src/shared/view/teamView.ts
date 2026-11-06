import type { Project, Role } from '@shared/types'
import { servicesForRole } from './roleServices'

/** The old project tab id for the org chart. A remembered or stale 'org' means the Team tab. */
export function normalizeView<T extends string>(view: T | 'org'): Exclude<T, 'org'> | 'team' {
  return (view === 'org' ? 'team' : view) as Exclude<T, 'org'> | 'team'
}

export interface CapabilityCounts {
  tools: number
  connections: number
  skills: number
}

/** What a role can use, counted for its node: built-in tools, enabled and granted connections, skills still in the project. */
export function capabilityCounts(
  project: Pick<Project, 'mcpServers' | 'skills'>,
  role: Pick<Role, 'slug' | 'tools' | 'mcpServers' | 'skills'>
): CapabilityCounts {
  const known = new Set((project.skills ?? []).map((s) => s.id))
  return {
    tools: role.tools.length,
    connections: servicesForRole(project, role).length,
    skills: (role.skills ?? []).filter((id) => known.has(id)).length
  }
}

export interface CapabilityPart {
  key: keyof CapabilityCounts
  n: number
  /** Singular or plural noun matching n. */
  word: string
}

/** Parts of the compact capability line. Zero counts are omitted. */
export function capabilityParts(c: CapabilityCounts): CapabilityPart[] {
  const parts: CapabilityPart[] = []
  if (c.tools > 0) parts.push({ key: 'tools', n: c.tools, word: c.tools === 1 ? 'tool' : 'tools' })
  if (c.connections > 0) parts.push({ key: 'connections', n: c.connections, word: c.connections === 1 ? 'connection' : 'connections' })
  if (c.skills > 0) parts.push({ key: 'skills', n: c.skills, word: c.skills === 1 ? 'skill' : 'skills' })
  return parts
}

/** Spoken form: "3 tools, 1 connection, 2 skills" ("No tools" when everything is zero). */
export function capabilityLabel(c: CapabilityCounts): string {
  const parts = capabilityParts(c)
  if (parts.length === 0) return 'No tools'
  return parts.map((p) => `${p.n} ${p.word}`).join(', ')
}
