import type {
  CapabilityApplyInput,
  CapabilityApplyResult,
  CapabilityDiscoverInput,
  CapabilityDiscovery,
  CapabilityGrantInput,
  CapabilityProgressEvent,
  CapabilityRecommendInput,
  CapabilityUndoInput,
  CapabilityUndoResult,
  Project,
  RunRecord,
  RunSummary,
  TeamDismissInput,
  TeamRecommendations,
  TeamReview,
  TeamReviewInput,
  TeamReviewSummary
} from '@shared/types'
import type { McpService } from '../mcp/service'
import type { ProjectStore } from '../store/projects'
import type { ProjectCompletionInput } from '../runtime/runManager'
import type { SkillServiceApi } from '../skills/types'
import type { CapabilityServiceApi } from './types'

/** What index.ts hands the service. */
export interface CapabilityServiceDeps {
  projects: ProjectStore
  skills: SkillServiceApi
  mcp: McpService
  /** One-shot completion on the project's connection (RunManager.completeForProject). */
  complete(project: Project, input: ProjectCompletionInput): Promise<{ text: string; model?: string }>
  /** capabilities:progress push to every window. */
  progress(event: CapabilityProgressEvent): void
  /** capabilities:reviewUpdated push to every window. */
  reviewUpdated(summary: TeamReviewSummary): void
  /** Reviews persist under `<dataDir>/team-reviews/<projectId>.json`. */
  dataDir: string
  /** The project's persisted run summaries (RunManager.list) and one record with its transcript (RunManager.get). */
  listRuns(projectId: string): RunSummary[]
  getRun(runId: string): RunRecord | null
  /** A saved project reaches every window (index.ts broadcasts a project.updated RunEvent). */
  onProjectChanged(project: Project): void
  /** The user's home dir; under ORGAI_MOCK=1 index.ts passes `<data>/mock-home` (seeded fixtures). */
  homeDir: string
  env: Record<string, string | undefined>
  platform: NodeJS.Platform
  /** ORGAI_MOCK=1: outside fetches are network-free fixtures. */
  mock: boolean
  fetch?: typeof fetch
}

/** Placeholder until the implementation lands (runtime-engineer brief). Every call rejects. */
export class CapabilityService implements CapabilityServiceApi {
  constructor(private deps: CapabilityServiceDeps) {}
  private todo(): never {
    void this.deps
    throw new Error('The Team assistant is not available yet.')
  }
  discover(_input: CapabilityDiscoverInput): Promise<CapabilityDiscovery> {
    return Promise.reject(new Error('The Team assistant is not available yet.'))
  }
  recommend(_input: CapabilityRecommendInput): Promise<TeamRecommendations> {
    return Promise.reject(new Error('The Team assistant is not available yet.'))
  }
  cancel(_requestId: string): void {}
  apply(_input: CapabilityApplyInput): Promise<CapabilityApplyResult> {
    return Promise.reject(new Error('The Team assistant is not available yet.'))
  }
  undo(_input: CapabilityUndoInput): CapabilityUndoResult {
    return this.todo()
  }
  setGrant(_input: CapabilityGrantInput): Project {
    return this.todo()
  }
  forgetProject(_projectId: string): void {}
  review(_input: TeamReviewInput): Promise<TeamReview> {
    return Promise.reject(new Error('The Team assistant is not available yet.'))
  }
  lastReview(_projectId: string): TeamReview | null {
    return null
  }
  dismiss(_input: TeamDismissInput): TeamReview {
    return this.todo()
  }
  runEnded(_projectId: string, _runId: string): void {}
  dispose(): void {}
}
