import type { AgentImportScan, AgentImportSource, Effort, ModelTier } from '@shared/types'

/**
 * Internal (main-process only) types of the agent importer. Parsers turn untrusted repo files into
 * ImportedAgent records; convert.ts turns those into OrgAI Roles. Nothing here crosses IPC.
 */

/** Caps. The repo is untrusted: every read is bounded. */
export const IMPORT_LIMITS = {
  /** Most agent definitions taken across all sources; the rest are dropped with a warning. */
  maxAgents: 40,
  /** Longest prompt kept, in characters; longer prompts are cut with a note. */
  maxPromptChars: 20_000,
  /** Largest file read, in bytes; larger files are skipped with a warning. */
  maxFileBytes: 256 * 1024,
  /** Most files read in one scan (agent and instruction files together); the rest are skipped with a warning. */
  maxFiles: 200
} as const

/** One agent definition as read from a file, before any mapping. Strings are raw (untrusted) but bounded. */
export interface ImportedAgent {
  source: AgentImportSource
  /** Project-relative path with forward slashes. */
  file: string
  /** Display name (Claude `name`, opencode file name or config key, Roo `name`...). Never empty. */
  name: string
  /** OrgAI exports only: the role's slug, used for reportsTo / spawnable references. */
  slug?: string
  description: string
  /** System prompt body, already capped at IMPORT_LIMITS.maxPromptChars. */
  prompt: string
  /** The model as written ('sonnet', 'anthropic/claude-sonnet-4-5', 'gpt-5-mini', 'inherit'...). Missing = not given. */
  model?: string
  effort?: Effort
  /**
   * Tool names as written (foreign names, lowercase or not). undefined = the file gave no tool list
   * (meaning "all tools" for Claude Code; the converter picks a sensible default).
   */
  tools?: string[]
  /** Tool names the file explicitly removes (Claude disallowedTools, opencode `tools: { x: false }` or `permission: { x: deny }`). */
  deniedTools?: string[]
  /** OrgAI exports only. */
  canSpawn?: boolean
  color?: string
  responsibilities?: string[]
  /** OrgAI exports only: the manager's slug, null for the root. undefined = not given (flat source). */
  reportsTo?: string | null
  /** OrgAI exports only: slugs this role may spawn. */
  spawnable?: string[]
  /** OrgAI exports only: the role's tier. */
  tier?: ModelTier
  /** opencode `mode: primary` (or `all`): a candidate root. */
  primary?: boolean
  /** Readable notes for the preview (truncated prompt, ignored fields...). */
  notes: string[]
}

/** What a parser returns for one file. Parsers never throw. */
export interface ParseResult {
  agents: ImportedAgent[]
  warnings: string[]
}

/** The full scan: the IPC summary plus the parsed agents (in AGENT_IMPORT_SOURCES order, then file order). */
export interface ImportScanResult {
  scan: AgentImportScan
  agents: ImportedAgent[]
}
