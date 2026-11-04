/**
 * Renderer-side mirror of the "MCP per-project secrets and custom connector presets" contracts (src/shared/types.ts on
 * dev at b503d03). This branch was cut before that merge, so the shared declarations are not visible here; this module
 * mirrors them field for field and reaches the preload through `window.orgai` with a cast. After the merge, switch the
 * imports to '@shared/types' and drop the casts (the shapes are identical). Every accessor tolerates the API being
 * absent (a build without the runtime side) by returning undefined, so callers can hide the surface.
 */

import type { ConnectorCategory, ConnectorInfo, McpLibraryEntry, McpLibraryInfo, McpMutationResult, McpServerInfo, McpServerSpec, McpTransport } from '@shared/types'

/** Most names McpLibraryEntry.perProjectEnv may list. */
export const MCP_PER_PROJECT_ENV_MAX = 20
/** Longest value of one envOverrides / headerOverrides entry. */
export const MCP_OVERRIDE_VALUE_MAX = 2000
/** Most custom connector presets. */
export const USER_CONNECTOR_PRESETS_MAX = 100

/** Fields the merged contract adds to McpServerSpec (and so to library entries and linked specs). */
export interface McpScopeSpecFields {
  /** Library entries: every linking project keeps its own env / header secret values (no fallback to the entry's). */
  perProjectSecrets?: boolean
  /** Library entries: non-secret env (stdio) / header (http, sse) names a linking project may set. */
  perProjectEnv?: string[]
  /** Linked project servers: this project's values for perProjectEnv names (stdio env). */
  envOverrides?: Record<string, string>
  /** Linked project servers: like envOverrides for http / sse headers. */
  headerOverrides?: Record<string, string>
  /** Main-only: the entry was made from a custom preset. */
  connectorCustom?: true
}

export type ScopedSpec = McpServerSpec & McpScopeSpecFields
export type ScopedLibraryEntry = McpLibraryEntry & Omit<McpScopeSpecFields, 'envOverrides' | 'headerOverrides'>

/** McpServerInfo.secretScope: where envSet / headersSet / missingSecrets were read. */
export type SecretScope = 'project' | 'library'

export interface ProjectSecretsRow {
  projectId: string
  projectName: string
  serverId: string
  missingSecrets: string[]
}

export type UserConnectorAuth =
  | { kind: 'none' }
  | { kind: 'oauth'; scopes?: string[] }
  | { kind: 'token'; header: string; prefix?: string; label: string; help: string; link?: string }

export interface UserConnectorVariant {
  id: string
  label: string
  description?: string
  transport: McpTransport
  url?: string
  headers?: Record<string, string>
  command?: string
  args?: string[]
  env?: Record<string, string>
  readOnly: boolean
  auth: UserConnectorAuth
}

export interface UserConnectorDef {
  id: string
  name: string
  vendor: string
  publisher: 'user'
  category: ConnectorCategory
  description: string
  status?: 'preview' | 'stable'
  docsUrl?: string
  variants: UserConnectorVariant[]
  defaultVariant: string
  setup?: string[]
  notes?: string[]
  aliases?: string[]
  verified: false
  origin?: 'kit'
}

export interface McpCopyFromLibraryInput {
  projectId: string
  serverId: string
  copySecrets: boolean
}

export interface McpProjectOverridesInput {
  projectId: string
  serverId: string
  env?: Record<string, string>
  headers?: Record<string, string>
}

export interface McpProjectApi {
  copyFromLibrary(input: McpCopyFromLibraryInput): Promise<McpMutationResult>
  setOverrides(input: McpProjectOverridesInput): Promise<McpMutationResult>
}

export interface ConnectorPresetsApi {
  list(): Promise<UserConnectorDef[]>
  upsert(def: UserConnectorDef): Promise<UserConnectorDef[]>
  remove(input: { id: string }): Promise<UserConnectorDef[]>
}

interface ScopeApiHost {
  mcpProject?: McpProjectApi
  connectorPresets?: ConnectorPresetsApi
}

function host(): ScopeApiHost {
  return (typeof window !== 'undefined' ? (window.orgai as unknown as ScopeApiHost) : {}) ?? {}
}

/** window.orgai.mcpProject, or undefined when this build has no runtime side for it. */
export function mcpProjectApi(): McpProjectApi | undefined {
  return host().mcpProject
}

/** window.orgai.connectorPresets, or undefined when this build has no runtime side for it. */
export function connectorPresetsApi(): ConnectorPresetsApi | undefined {
  return host().connectorPresets
}

/** The merged fields of a spec, library entry or linked server. */
export function scopeFields(spec: McpServerSpec | McpLibraryEntry): McpScopeSpecFields {
  return spec as McpScopeSpecFields
}

/** McpServerInfo.secretScope ('library' when absent). */
export function secretScopeOf(info: McpServerInfo): SecretScope {
  return (info as McpServerInfo & { secretScope?: SecretScope }).secretScope ?? 'library'
}

/** McpLibraryInfo.projectSecrets (entries with perProjectSecrets only). */
export function projectSecretsOf(info: McpLibraryInfo): ProjectSecretsRow[] | undefined {
  return (info as McpLibraryInfo & { projectSecrets?: ProjectSecretsRow[] }).projectSecrets
}

/** ConnectorInfo.custom / preset (custom presets only). */
export function presetOf(info: ConnectorInfo): UserConnectorDef | undefined {
  const c = info as ConnectorInfo & { custom?: true; preset?: UserConnectorDef }
  return c.custom ? c.preset : undefined
}

/** True for a tile made from the user's own preset. */
export function isCustomConnector(info: ConnectorInfo): boolean {
  return (info as ConnectorInfo & { custom?: true }).custom === true
}
