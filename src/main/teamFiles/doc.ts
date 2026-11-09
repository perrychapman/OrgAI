import type { Effort, McpRegistryRef, McpTransport, ModelTier, PermissionMode, SkillEvaluationSettings, TeamReviewSettings } from '@shared/types'

/**
 * The team as files hold it: the one document every step of team files works on (parse, serialize, digest, gate,
 * delta). It carries nothing per computer: no ids, positions, timestamps, absolute paths, secrets or connection. Arrays
 * whose order has no meaning are sorted, so two computers build the same document. Structured-clone and JSON safe (the
 * approved snapshot is this document as JSON).
 */

export interface TeamSettingsDoc {
  brief: string
  permissionMode: PermissionMode
  maxBudgetUsd?: number
  maxSubagentDepth?: number
  maxConcurrentSubagents?: number
  maxWindowShare?: number
  preferEverydayNearLimit?: boolean
  isolateWriters?: boolean
  reviewMerges?: boolean
  autoContinue?: boolean
  maxAutoContinues?: number
  runMessaging?: boolean
  teamReview?: TeamReviewSettings
  skillEvaluation?: SkillEvaluationSettings
}

/** One role: `.orgai/agents/<slug>.md`. References are slugs and names. */
export interface TeamRoleDoc {
  slug: string
  name: string
  description: string
  /** Order kept: it is the author's. */
  responsibilities: string[]
  prompt: string
  /** Sorted. */
  tools: string[]
  /** The role's tier. Exactly one of tier and model is set. */
  tier?: ModelTier
  /** A really pinned model id, or 'inherit'. */
  model?: string
  effort?: Effort
  canSpawn: boolean
  /** Sorted slugs. */
  spawnable: string[]
  /** Sorted slugs, a subset of `spawnable` (Role.requiredReports). Absent when none; front matter key `required_reports`. */
  requiredReports?: string[]
  /** Slug; null for the root. */
  reportsTo: string | null
  color: string
  /** Sorted skill names. */
  skills: string[]
  /** Sorted server names: explicit grants (Role.mcpServers). */
  mcpServers: string[]
}

/** One skill file. Text has LF line endings; `base64` only for a file that is not text. */
export interface TeamSkillFileDoc {
  path: string
  text?: string
  base64?: string
}

/** One skill: `.orgai/skills/<name>/`. SKILL.md is re-emitted from name, description and body. */
export interface TeamSkillDoc {
  name: string
  description: string
  /** LF line endings, trimmed (parseFrontmatter's rule). */
  body: string
  /** Every file but SKILL.md, sorted by path. */
  files: TeamSkillFileDoc[]
  enabled: boolean
}

/** One server in `.orgai/mcp.json`: secret NAMES only. */
export interface TeamMcpDoc {
  name: string
  transport: McpTransport
  command?: string
  args?: string[]
  /** Sorted by key when written. */
  env?: Record<string, string>
  /** Sorted. */
  secretEnv?: string[]
  url?: string
  headers?: Record<string, string>
  /** Sorted. */
  secretHeaders?: string[]
  description?: string
  enabled: boolean
  /** Sorted role slugs; absent = every role (McpServerSpec.roles). */
  roles?: string[]
  /** So another computer can match its connector. Its library entry's definition wins when it matches. */
  connectorId?: string
  connectorVariant?: string
  /** The server came from the app-wide library here; another computer links an identical entry, else keeps a copy. */
  fromLibrary?: true
  registry?: McpRegistryRef
}

export interface TeamDoc {
  settings: TeamSettingsDoc
  /** Sorted by slug. */
  roles: TeamRoleDoc[]
  /** Sorted by name. */
  skills: TeamSkillDoc[]
  /** Sorted by name. */
  mcp: TeamMcpDoc[]
}

/** One file of the team as text or bytes, folder-relative and '/'-separated. */
export interface TeamFile {
  path: string
  data: Buffer
}

/** Lstat identity of the team files: unchanged means nothing needs parsing. In memory only. */
export type TeamFilesStamp = string
