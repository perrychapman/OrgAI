import type {
  CapabilityApplyInput,
  CapabilityApplyResult,
  CapabilityDiscoverInput,
  CapabilityDiscovery,
  CapabilityItem,
  CapabilityProgressEvent,
  CapabilityRecommendInput,
  CapabilitySourceStatus,
  CapabilityUndoInput,
  CapabilityUndoResult,
  CapabilityWarning,
  McpServerSpec,
  Project,
  TeamDismissInput,
  TeamRecommendations,
  TeamRestoreInput,
  TeamReview,
  TeamReviewInput
} from '@shared/types'

/**
 * Main-process contracts of the Team assistant (src/main/capabilities/). ipc.ts and index.ts depend only on
 * CapabilityServiceApi. The source modules return SourceResult; service.ts merges them into one CapabilityDiscovery
 * and keeps the payloads in an in-memory snapshot keyed by the discovery digest, so apply never takes a path, a spec
 * or file content from the renderer.
 */

/** The capabilities:* channels 1:1. */
export interface CapabilityServiceApi {
  discover(input: CapabilityDiscoverInput): Promise<CapabilityDiscovery>
  recommend(input: CapabilityRecommendInput): Promise<TeamRecommendations>
  /** Stop a running discover/recommend; unknown ids are ignored. */
  cancel(requestId: string): void
  apply(input: CapabilityApplyInput): Promise<CapabilityApplyResult>
  undo(input: CapabilityUndoInput): CapabilityUndoResult
  /** Drop snapshots, the undo and the persisted review of a removed project. */
  forgetProject(projectId: string): void
  /** capabilities:review (manual or 'opened'). */
  review(input: TeamReviewInput): Promise<TeamReview>
  lastReview(projectId: string): TeamReview | null
  dismiss(input: TeamDismissInput): TeamReview
  /** capabilities:restore: forget one dismissal; its recommendation returns to pending when still useful. */
  restore(input: TeamRestoreInput): TeamReview
  /**
   * A work run of the project reached an outcome (index.ts calls it from the run-event broadcast for kind 'work'
   * only, never setup-like or harness runs). Debounced, never awaited, never throws.
   */
  runEnded(projectId: string, runId: string): void
  /** Stop timers and in-flight work at quit. */
  dispose(): void
}

/**
 * What apply needs to turn a candidate into a project item, kept in main only (never crosses IPC).
 * - skillFolder: a repo or local skill folder. `dir` is the absolute folder and `rootReal` the real root it was read
 *   under (the FolderReader root); apply re-reads it (no file content is kept in the snapshot) and refuses when `sourceDigest` no longer matches.
 * - skillMd: a GitHub SKILL.md (already fetched, bounded); stored as the only file.
 * - mcpSpec: a sanitized project server definition (local config or registry): no env or header values, secret
 *   slot names only, key-like args removed, URL query scrubbed. Pinned or the item carries blockedReason.
 * - connector: a catalog connector id.
 * - libraryMcp / librarySkill: link a library entry. projectMcp / projectSkill: grants only.
 */
export type CandidatePayload =
  | { type: 'skillFolder'; dir: string; rootReal: string; sourceDigest: string; sourceRef: string; source: 'repo' | 'local' }
  | { type: 'skillMd'; text: string; url: string }
  | { type: 'mcpSpec'; spec: McpServerSpec }
  | { type: 'connector'; connectorId: string }
  | { type: 'libraryMcp'; libraryId: string }
  | { type: 'librarySkill'; libraryId: string }
  | { type: 'projectMcp'; serverId: string }
  | { type: 'projectSkill'; skillId: string }

export interface DiscoveredCandidate {
  item: CapabilityItem
  payload: CandidatePayload
}

/** What one source module returns. Never thrown: failures become warnings and a source state. */
export interface SourceResult {
  candidates: DiscoveredCandidate[]
  sources: CapabilitySourceStatus[]
  warnings: CapabilityWarning[]
}

/** Where local discovery looks. Injected so tests use fixture folders and never the real home. */
export interface LocalContext {
  /** Absolute project folder (the stored project's path). */
  projectPath: string
  /** The user's home dir (os.homedir(), or `<data>/mock-home` under ORGAI_MOCK=1). */
  homeDir: string
  /** Environment for CLAUDE_CODE_PLUGIN_CACHE_DIR, APPDATA, XDG_CONFIG_HOME, CODEX_HOME. */
  env: Record<string, string | undefined>
  platform: NodeJS.Platform
}

/** Outside fetches. `mock` makes them network-free fixtures. */
export interface OutsideContext {
  fetch: typeof fetch
  mock: boolean
  /** Registry search words (already derived and capped). */
  queries: string[]
  signal?: AbortSignal
}

/** Progress sink (service.ts forwards to the capabilities:progress push). */
export type ProgressSink = (event: Omit<CapabilityProgressEvent, 'projectId' | 'requestId'>) => void
