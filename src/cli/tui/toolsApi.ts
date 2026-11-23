/**
 * The host calls behind the TUI's /mcp and /skills views: the channels the `orgai mcp` and `orgai skills` commands
 * use. Reads go on the session's shared read connection, writes on a one-call 'configure' connection
 * (TuiConnection.callConfigured), so the host stays the authority and validates every save. Each write is ONE edit
 * of ONE item: the host passes exactly that to the live team runs this terminal hosts (dispatcher.ts oneStep).
 */
import type { McpLibraryInfo, McpMutationResult, McpServerInfo, Project, SkillContent, SkillInfo, SkillLibraryInfo, SkillMutationResult } from '../../shared/types'

/** One field of one MCP server: on / off, or the roles that may use it (role slugs; undefined = every role). */
export type McpPatch = { enabled: boolean } | { roles: string[] | undefined }
/** One field of one skill: on / off, or the complete set of roles (ids) that hold it afterwards. */
export type SkillPatch = { enabled: boolean } | { roleIds: string[] }

export interface TuiToolsApi {
  /** projects:get (read): a fresh copy of the project (its roles, for the role lists). */
  project(id: string): Promise<Project>
  /** mcp:list (read). */
  mcpServers(projectId: string): Promise<McpServerInfo[]>
  /** mcpLibrary:list (read). */
  mcpLibrary(): Promise<McpLibraryInfo[]>
  /**
   * mcp:upsert (configure) with one field changed. The server is read afresh (mcp:list) right before the save, so the
   * spec sent differs from the listed one in that field alone (hostChange.ts terminalUpsertField).
   */
  setMcp(projectId: string, serverId: string, patch: McpPatch): Promise<McpMutationResult>
  /** mcp:linkLibrary (configure): add a library entry to the project, for every role. */
  linkMcp(projectId: string, libraryId: string): Promise<McpMutationResult>
  /** mcp:remove (configure). */
  removeMcp(projectId: string, serverId: string): Promise<McpMutationResult>
  /** skills:list (read). */
  skills(projectId: string): Promise<SkillInfo[]>
  /** skillLibrary:list (read). */
  skillLibrary(): Promise<SkillLibraryInfo[]>
  /** skills:read (read): the skill's text and files. */
  readSkill(projectId: string, skillId: string): Promise<SkillContent>
  /** skills:update (configure) with one field. */
  updateSkill(projectId: string, skillId: string, patch: SkillPatch): Promise<SkillMutationResult>
  /** skills:linkLibrary (configure): add a library skill to the project, granted to these roles. */
  linkSkill(projectId: string, libraryId: string, roleIds: string[]): Promise<SkillMutationResult>
  /** skills:remove (configure). */
  removeSkill(projectId: string, skillId: string): Promise<SkillMutationResult>
}

/** The spec mcp:upsert gets for one patch: the listed spec with that one field set (`roles: undefined` drops the list). */
export function patchedMcpSpec<T extends { enabled: boolean; roles?: string[] }>(spec: T, patch: McpPatch): T {
  if ('enabled' in patch) return { ...spec, enabled: patch.enabled }
  const next = { ...spec }
  if (patch.roles === undefined) delete next.roles
  else next.roles = [...patch.roles]
  return next
}
