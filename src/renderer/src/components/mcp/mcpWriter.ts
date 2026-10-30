import type { McpLibraryInfo, McpMutationResult, McpSecretKind, McpServerSpec, Project, Role } from '@shared/types'
import { libraryEntryFromSpec } from '@shared/defaults'

/**
 * Where the shared add / edit forms write: a project (mcp.*) or the app-wide library (mcpLibrary.*). `roles` is the
 * role list the form offers, or null when the destination has no role access (the library).
 */
export interface McpWriter {
  roles: Role[] | null
  upsert(spec: McpServerSpec): Promise<void>
  setSecret(serverId: string, kind: McpSecretKind, name: string, value: string | null): Promise<void>
}

export function projectWriter(project: Project, onResult: (r: McpMutationResult) => void): McpWriter {
  return {
    roles: project.roles,
    upsert: async (spec) => onResult(await window.orgai.mcp.upsert({ projectId: project.id, spec })),
    setSecret: async (serverId, kind, name, value) => onResult(await window.orgai.mcp.setSecret({ projectId: project.id, serverId, kind, name, value }))
  }
}

export function libraryWriter(onList: (list: McpLibraryInfo[]) => void): McpWriter {
  return {
    roles: null,
    upsert: async (spec) => onList(await window.orgai.mcpLibrary.upsert(libraryEntryFromSpec(spec, spec.id))),
    setSecret: async (libraryId, kind, name, value) => onList(await window.orgai.mcpLibrary.setSecret({ libraryId, kind, name, value }))
  }
}
