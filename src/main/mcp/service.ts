import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, basename } from 'node:path'
import type {
  McpMutationResult,
  McpRegistrySearchInput,
  McpRegistrySearchResult,
  McpSecretInput,
  McpServerInfo,
  McpServerSpec,
  McpTestResult,
  McpUpsertInput,
  PluginSpec,
  PluginUpsertInput,
  Project
} from '@shared/types'
import type { ProjectStore } from '../store/projects'
import { mcpProjectPrefix, mcpSecretKey, mcpSecretPrefix, type SecretStore } from '../store/secrets'
import type { ResolvedMcpServer } from '../runtime/types'
import { searchRegistry } from './registry'
import { testServer } from './probe'
import { assertValidSpec } from './validate'

/**
 * The main-process side of MCP servers and plugins: persists Project.mcpServers / Project.plugins, keeps
 * secret values in the SecretStore and nowhere else, and hands resolved servers to runs. The lead wires the
 * public methods 1:1 into the mcp:* and plugins:* IPC channels. No method returns or logs a secret value.
 */
export class McpService {
  private projects: ProjectStore
  private secrets: SecretStore
  private fetchImpl: typeof fetch

  constructor(deps: { projects: ProjectStore; secrets: SecretStore; fetch?: typeof fetch }) {
    this.projects = deps.projects
    this.secrets = deps.secrets
    this.fetchImpl = deps.fetch ?? fetch
  }

  private project(projectId: string): Project {
    const p = this.projects.get(projectId)
    if (!p) throw new Error('Project not found')
    return p
  }

  private info(projectId: string, spec: McpServerSpec): McpServerInfo {
    const envSet = (spec.secretEnv ?? []).filter((n) => this.secrets.has(mcpSecretKey(projectId, spec.id, 'env', n)))
    const headersSet = (spec.secretHeaders ?? []).filter((n) => this.secrets.has(mcpSecretKey(projectId, spec.id, 'header', n)))
    const missingSecrets = [...(spec.secretEnv ?? []).filter((n) => !envSet.includes(n)), ...(spec.secretHeaders ?? []).filter((n) => !headersSet.includes(n))]
    return { spec, envSet, headersSet, missingSecrets }
  }

  list(projectId: string): McpServerInfo[] {
    return (this.project(projectId).mcpServers ?? []).map((s) => this.info(projectId, s))
  }

  private result(project: Project): McpMutationResult {
    return { project, servers: (project.mcpServers ?? []).map((s) => this.info(project.id, s)) }
  }

  upsert(input: McpUpsertInput): McpMutationResult {
    const project = this.project(input.projectId)
    const existing = project.mcpServers ?? []
    assertValidSpec(input.spec, existing)
    const spec: McpServerSpec = { ...input.spec }
    const idx = existing.findIndex((s) => s.id === spec.id)
    const next = idx === -1 ? [...existing, spec] : existing.map((s, i) => (i === idx ? spec : s))
    if (idx !== -1) this.dropOrphanSecrets(project.id, existing[idx], spec)
    return this.result(this.projects.save({ ...project, mcpServers: next }))
  }

  /** Delete stored values of secret slots an edit removed. */
  private dropOrphanSecrets(projectId: string, before: McpServerSpec, after: McpServerSpec): void {
    for (const n of before.secretEnv ?? []) if (!(after.secretEnv ?? []).includes(n)) this.secrets.delete(mcpSecretKey(projectId, before.id, 'env', n))
    for (const n of before.secretHeaders ?? []) if (!(after.secretHeaders ?? []).includes(n)) this.secrets.delete(mcpSecretKey(projectId, before.id, 'header', n))
  }

  remove(input: { projectId: string; serverId: string }): McpMutationResult {
    const project = this.project(input.projectId)
    const existing = project.mcpServers ?? []
    if (!existing.some((s) => s.id === input.serverId)) throw new Error('MCP server not found')
    this.secrets.deletePrefix(mcpSecretPrefix(project.id, input.serverId))
    const roles = project.roles.map((r) => (r.mcpServers?.includes(input.serverId) ? { ...r, mcpServers: r.mcpServers.filter((id) => id !== input.serverId) } : r))
    return this.result(this.projects.save({ ...project, roles, mcpServers: existing.filter((s) => s.id !== input.serverId) }))
  }

  setSecret(input: McpSecretInput): McpMutationResult {
    const project = this.project(input.projectId)
    const spec = (project.mcpServers ?? []).find((s) => s.id === input.serverId)
    if (!spec) throw new Error('MCP server not found')
    const slots = input.kind === 'env' ? spec.secretEnv : spec.secretHeaders
    if (!slots?.includes(input.name)) throw new Error(`"${input.name}" is not a secret ${input.kind === 'env' ? 'environment variable' : 'header'} of ${spec.name}.`)
    if (typeof input.value === 'string' && input.kind === 'header' && /[\r\n]/.test(input.value)) throw new Error('A header value must be a single line.')
    this.secrets.set(mcpSecretKey(project.id, spec.id, input.kind, input.name), input.value)
    return this.result(project)
  }

  /** Start the saved server (with its stored secrets) and list its tools. */
  async test(input: { projectId: string; serverId: string }): Promise<McpTestResult> {
    const spec = (this.project(input.projectId).mcpServers ?? []).find((s) => s.id === input.serverId)
    if (!spec) throw new Error('MCP server not found')
    return testServer(this.resolve(input.projectId, spec), 20_000, this.fetchImpl)
  }

  registrySearch(input: McpRegistrySearchInput): Promise<McpRegistrySearchResult> {
    return searchRegistry(input, this.fetchImpl)
  }

  // ---------- plugins ----------

  upsertPlugin(input: PluginUpsertInput): Project {
    const project = this.project(input.projectId)
    const plugin = { ...input.plugin }
    if (typeof plugin.path !== 'string' || !isAbsolute(plugin.path)) throw new Error('The plugin path must be an absolute path.')
    const manifest = join(plugin.path, '.claude-plugin', 'plugin.json')
    if (!existsSync(manifest)) throw new Error('No plugin manifest found: expected .claude-plugin/plugin.json in that folder.')
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(manifest, 'utf8'))
    } catch {
      throw new Error('The plugin manifest .claude-plugin/plugin.json is not valid JSON.')
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('The plugin manifest must be a JSON object.')
    const declared = (parsed as { name?: unknown }).name
    if (!plugin.name?.trim()) plugin.name = typeof declared === 'string' && declared.trim() ? declared.trim() : basename(plugin.path)
    const existing = project.plugins ?? []
    const idx = existing.findIndex((p) => p.id === plugin.id)
    const next: PluginSpec[] = idx === -1 ? [...existing, plugin] : existing.map((p, i) => (i === idx ? plugin : p))
    return this.projects.save({ ...project, plugins: next })
  }

  removePlugin(input: { projectId: string; pluginId: string }): Project {
    const project = this.project(input.projectId)
    return this.projects.save({ ...project, plugins: (project.plugins ?? []).filter((p) => p.id !== input.pluginId) })
  }

  /** Forget every stored secret of one server (SetupService calls it when a proposal removes the server). */
  removeServerSecrets(projectId: string, serverId: string): void {
    this.secrets.deletePrefix(mcpSecretPrefix(projectId, serverId))
  }

  /** The project is being deleted: forget every secret of its MCP servers. */
  removeProjectSecrets(projectId: string): void {
    this.secrets.deletePrefix(mcpProjectPrefix(projectId))
  }

  // ---------- for RunManager ----------

  enabledServers(project: Project): McpServerSpec[] {
    return (project.mcpServers ?? []).filter((s) => s.enabled)
  }

  /**
   * The spec with secret values filled in from the SecretStore. `extra` holds run-scoped values by slot
   * name (a server approved for this run only); it wins over stored values.
   */
  resolve(projectId: string, spec: McpServerSpec, extra: Record<string, string> = {}): ResolvedMcpServer {
    const env: Record<string, string> = { ...(spec.env ?? {}) }
    const headers: Record<string, string> = { ...(spec.headers ?? {}) }
    for (const n of spec.secretEnv ?? []) {
      const v = Object.hasOwn(extra, n) ? extra[n] : this.secrets.get(mcpSecretKey(projectId, spec.id, 'env', n))
      if (v) env[n] = v
    }
    for (const n of spec.secretHeaders ?? []) {
      const v = Object.hasOwn(extra, n) ? extra[n] : this.secrets.get(mcpSecretKey(projectId, spec.id, 'header', n))
      if (v) headers[n] = v
    }
    return { spec, env, headers }
  }

  /** Save an approved install ('project' scope): the spec joins Project.mcpServers and its secrets go to safeStorage. */
  persistInstall(projectId: string, spec: McpServerSpec, secrets: Record<string, string> = {}): Project {
    const project = this.project(projectId)
    const existing = project.mcpServers ?? []
    assertValidSpec(spec, existing)
    const saved: McpServerSpec = { ...spec, source: spec.source === 'registry' ? 'registry' : 'agent' }
    for (const n of saved.secretEnv ?? []) if (secrets[n]) this.secrets.set(mcpSecretKey(projectId, saved.id, 'env', n), secrets[n])
    for (const n of saved.secretHeaders ?? []) if (secrets[n]) this.secrets.set(mcpSecretKey(projectId, saved.id, 'header', n), secrets[n])
    const idx = existing.findIndex((s) => s.id === saved.id)
    const next = idx === -1 ? [...existing, saved] : existing.map((s, i) => (i === idx ? saved : s))
    return this.projects.save({ ...project, mcpServers: next })
  }
}

