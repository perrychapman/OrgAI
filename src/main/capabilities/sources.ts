import type {
  CapabilityFlag,
  CapabilityItem,
  ConnectorInfo,
  McpLibraryInfo,
  McpServerInfo,
  McpServerSpec,
  Project,
  Role,
  SkillInfo,
  SkillLibraryInfo
} from '@shared/types'
import { CONNECTORS, connectorVariant } from '@shared/connectors'
import { capabilityId, clampText, isKeyLikeArg, scrubUrl } from './sanitize'
import type { DiscoveredCandidate, SourceResult } from './types'

/**
 * Sources that need no file reads or network: what this project already has, the app-wide MCP and skill libraries,
 * and the curated connectors. Pure over their inputs (the service passes the stores' current lists). Never throws.
 */

/** Role ids an MCP server reaches now: `roles` undefined = every role; else slugs plus explicit Role.mcpServers grants. */
export function mcpGrantedTo(roles: Role[], spec: Pick<McpServerSpec, 'id' | 'roles'>): string[] {
  return roles.filter((r) => spec.roles === undefined || spec.roles.includes(r.slug) || (r.mcpServers ?? []).includes(spec.id)).map((r) => r.id)
}

/** A display target for a server: command + args without key-like values, or the scrubbed URL. */
export function specTarget(spec: Pick<McpServerSpec, 'transport' | 'command' | 'args' | 'url'>): string {
  if (spec.transport === 'stdio') return clampText([spec.command ?? '', ...(spec.args ?? []).filter((a) => !isKeyLikeArg(a))].join(' '), 200)
  return clampText(scrubUrl(spec.url) ?? '', 200)
}

function flagsFor(spec: Pick<McpServerSpec, 'transport'>): CapabilityFlag[] {
  return spec.transport === 'stdio' ? ['runsCode'] : ['remote']
}

/** Items already in the project: its skills and servers (connector links are shown on the catalog item instead). */
export function discoverProject(project: Project, skills: SkillInfo[], servers: McpServerInfo[]): SourceResult {
  const out: SourceResult = { candidates: [], sources: [], warnings: [] }
  for (const s of skills) {
    const spec = s.spec
    const item: CapabilityItem = {
      id: capabilityId('project', 'skill', spec.id, spec.name),
      kind: 'skill',
      origin: 'project',
      source: 'project',
      sourceLabel: 'This project',
      name: clampText(spec.name, 64),
      description: clampText(spec.description),
      digest: spec.digest,
      flags: [],
      needsSecrets: [],
      inProject: { kind: 'skill', id: spec.id, grantedTo: [...s.grantedTo], enabled: spec.enabled },
      notes: []
    }
    if (s.libraryMissing) item.blockedReason = 'Its skill library entry was removed.'
    out.candidates.push({ item, payload: { type: 'projectSkill', skillId: spec.id } })
  }
  for (const info of servers) {
    const spec = info.spec
    if (spec.connectorId) continue
    const item: CapabilityItem = {
      id: capabilityId('project', 'mcp', spec.id, spec.name),
      kind: 'mcp',
      origin: 'project',
      source: 'project',
      sourceLabel: 'This project',
      name: clampText(spec.name, 64),
      description: clampText(spec.description ?? ''),
      transport: spec.transport,
      target: specTarget(spec),
      flags: flagsFor(spec),
      needsSecrets: [...info.missingSecrets],
      inProject: { kind: 'mcp', id: spec.id, grantedTo: mcpGrantedTo(project.roles, spec), enabled: spec.enabled },
      notes: []
    }
    if (spec.registry?.version) item.version = spec.registry.version
    if (info.libraryMissing) item.blockedReason = 'Its MCP library entry was removed.'
    out.candidates.push({ item, payload: { type: 'projectMcp', serverId: spec.id } })
  }
  const count = out.candidates.length
  out.sources.push({ source: 'project', label: 'This project', locations: [], state: count ? 'found' : 'empty', count })
  return out
}

/** Library entries this project does not link yet (connector entries are covered by the catalog). */
export function discoverLibrary(project: Project, mcpLibrary: McpLibraryInfo[], skillLibrary: SkillLibraryInfo[]): SourceResult {
  const out: SourceResult = { candidates: [], sources: [], warnings: [] }
  const linkedMcp = new Set((project.mcpServers ?? []).map((s) => s.libraryId).filter(Boolean))
  const linkedSkills = new Set((project.skills ?? []).map((s) => s.libraryId).filter(Boolean))
  for (const info of mcpLibrary) {
    const e = info.entry
    if (e.connectorId || linkedMcp.has(e.id)) continue
    const item: CapabilityItem = {
      id: capabilityId('library', 'mcp', e.id, e.name),
      kind: 'mcp',
      origin: 'library',
      source: 'library',
      sourceLabel: 'Your library',
      name: clampText(e.name, 64),
      description: clampText(e.description ?? ''),
      transport: e.transport,
      target: specTarget(e),
      flags: flagsFor(e),
      needsSecrets: [...info.missingSecrets],
      notes: []
    }
    if (e.registry?.version) item.version = e.registry.version
    out.candidates.push({ item, payload: { type: 'libraryMcp', libraryId: e.id } })
  }
  for (const info of skillLibrary) {
    const e = info.entry
    if (linkedSkills.has(e.id)) continue
    out.candidates.push({
      item: {
        id: capabilityId('library', 'skill', e.id, e.name),
        kind: 'skill',
        origin: 'library',
        source: 'library',
        sourceLabel: 'Your library',
        name: clampText(e.name, 64),
        description: clampText(e.description),
        digest: e.digest,
        flags: [],
        needsSecrets: [],
        notes: []
      },
      payload: { type: 'librarySkill', libraryId: e.id }
    })
  }
  const count = out.candidates.length
  out.sources.push({ source: 'library', label: 'Your library', locations: [], state: count ? 'found' : mcpLibrary.length + skillLibrary.length ? 'empty' : 'missing', count })
  return out
}

/** Every curated connector, with its gallery state and whether this project links it already. */
export function discoverCatalog(project: Project, connectors: ConnectorInfo[]): SourceResult {
  const out: SourceResult = { candidates: [], sources: [], warnings: [] }
  const byId = new Map(connectors.map((c) => [c.connector.id, c]))
  for (const def of CONNECTORS) {
    const info = byId.get(def.id)
    const variant = connectorVariant(def, info?.variant)
    const flags: CapabilityFlag[] = ['remote']
    if (def.variants.some((v) => !v.readOnly)) flags.push('canChange')
    if (!def.verified) flags.push('unverified')
    const item: CapabilityItem = {
      id: capabilityId('catalog', 'connector', def.id, def.id),
      kind: 'connector',
      origin: 'catalog',
      source: 'catalog',
      sourceLabel: 'Curated',
      location: clampText(scrubUrl(def.docsUrl) ?? '', 200) || undefined,
      name: clampText(def.name, 64),
      description: clampText(def.description),
      transport: variant.transport,
      target: clampText(scrubUrl(variant.url) ?? '', 200),
      flags,
      needsSecrets: [],
      connectorId: def.id,
      connectorState: info?.state ?? 'available',
      readOnlyAvailable: def.variants.some((v) => v.readOnly),
      notes: (def.notes ?? []).slice(0, 4).map((n) => clampText(n, 200))
    }
    if (!item.location) delete item.location
    const libraryId = info?.library?.entry.id
    const link = libraryId ? (project.mcpServers ?? []).find((s) => s.libraryId === libraryId) : undefined
    if (link) item.inProject = { kind: 'mcp', id: link.id, grantedTo: mcpGrantedTo(project.roles, link), enabled: link.enabled }
    out.candidates.push({ item, payload: { type: 'connector', connectorId: def.id } })
  }
  out.sources.push({ source: 'catalog', label: 'Curated connectors', locations: [], state: out.candidates.length ? 'found' : 'empty', count: out.candidates.length })
  return out
}

/** Merge helper: drop repo/local/library/outside items that duplicate something the project already has (same kind and name). */
export function dropProjectDuplicates(candidates: DiscoveredCandidate[]): DiscoveredCandidate[] {
  const have = new Set(candidates.filter((c) => c.item.origin === 'project').map((c) => `${c.item.kind}\0${c.item.name}`))
  const seen = new Set<string>()
  return candidates.filter((c) => {
    if (seen.has(c.item.id)) return false
    seen.add(c.item.id)
    return c.item.origin === 'project' || c.item.origin === 'catalog' || !have.has(`${c.item.kind}\0${c.item.name}`)
  })
}

