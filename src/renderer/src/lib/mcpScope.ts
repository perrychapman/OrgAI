/**
 * Accessors for the "MCP per-project secrets and custom connector presets" contracts. The types and limits live in
 * '@shared/types' and are re-exported here so callers keep one import. Every accessor tolerates the API being absent
 * (a build without the runtime side) by returning undefined, so callers can hide the surface.
 */

import {
  MCP_OVERRIDE_VALUE_MAX,
  MCP_PER_PROJECT_ENV_MAX,
  USER_CONNECTOR_PRESETS_MAX,
  type ConnectorInfo,
  type McpLibraryEntry,
  type McpLibraryInfo,
  type McpServerInfo,
  type McpServerSpec,
  type OrgAIApi,
  type UserConnectorDef
} from '@shared/types'

export { MCP_OVERRIDE_VALUE_MAX, MCP_PER_PROJECT_ENV_MAX, USER_CONNECTOR_PRESETS_MAX }
export type {
  McpCopyFromLibraryInput,
  McpProjectOverridesInput,
  UserConnectorAuth,
  UserConnectorDef,
  UserConnectorVariant
} from '@shared/types'

/** The per-project fields a spec, library entry or linked server may carry (entries have no overrides). */
export type McpScopeSpecFields = Pick<McpServerSpec, 'perProjectSecrets' | 'perProjectEnv' | 'envOverrides' | 'headerOverrides' | 'connectorCustom'>

/** A spec or library entry; the per-project fields are part of the shared type now. */
export type ScopedSpec = McpServerSpec
export type ScopedLibraryEntry = McpLibraryEntry

/** McpServerInfo.secretScope: where envSet / headersSet / missingSecrets were read. */
export type SecretScope = NonNullable<McpServerInfo['secretScope']>

export type ProjectSecretsRow = NonNullable<McpLibraryInfo['projectSecrets']>[number]

export type McpProjectApi = OrgAIApi['mcpProject']
export type ConnectorPresetsApi = OrgAIApi['connectorPresets']

/** window.orgai.mcpProject, or undefined when this build has no runtime side for it. */
export function mcpProjectApi(): McpProjectApi | undefined {
  return typeof window === 'undefined' ? undefined : window.orgai?.mcpProject
}

/** window.orgai.connectorPresets, or undefined when this build has no runtime side for it. */
export function connectorPresetsApi(): ConnectorPresetsApi | undefined {
  return typeof window === 'undefined' ? undefined : window.orgai?.connectorPresets
}

/** The per-project fields of a spec, library entry or linked server. */
export function scopeFields(spec: McpServerSpec | McpLibraryEntry): McpScopeSpecFields {
  return spec
}

/** McpServerInfo.secretScope ('library' when absent). */
export function secretScopeOf(info: McpServerInfo): SecretScope {
  return info.secretScope ?? 'library'
}

/** McpLibraryInfo.projectSecrets (entries with perProjectSecrets only). */
export function projectSecretsOf(info: McpLibraryInfo): ProjectSecretsRow[] | undefined {
  return info.projectSecrets
}

/** ConnectorInfo.custom / preset (custom presets only). */
export function presetOf(info: ConnectorInfo): UserConnectorDef | undefined {
  return info.custom ? info.preset : undefined
}

/** True for a tile made from the user's own preset. */
export function isCustomConnector(info: ConnectorInfo): boolean {
  return info.custom === true
}
