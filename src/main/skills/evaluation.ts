import type { Project, RunRecord, RunSummary, SkillEvaluationReport, SkillSuggestion } from '@shared/types'
import type { ProjectCompletionInput } from '../runtime/runManager'
import type { SkillEvaluationApi, SkillServiceApi } from './types'

/** What SkillEvaluationService needs. The constructor signature is the contract index.ts wires; keep it. */
export interface SkillEvaluationDeps {
  /** Reports persist under `<dataDir>/skill-evaluations/<projectId>.json`. */
  dataDir: string
  project(projectId: string): Project | null
  /** The project's runs, newest first or any order (persisted summaries; RunManager.list). */
  listRuns(projectId: string): RunSummary[]
  /** One run with its transcript (RunManager.get). */
  getRun(runId: string): RunRecord | null
  skills: SkillServiceApi
  /** One-shot completion on the project's connection (RunManager.completeForProject). */
  complete(project: Project, input: ProjectCompletionInput): Promise<{ text: string; model?: string }>
}

/**
 * skills:evaluate and its persisted reports. The checks themselves are pure (evaluate.ts).
 * CONTRACT STUB: the Runtime Engineer replaces every body; the class name, constructor and interface stay.
 */
export class SkillEvaluationService implements SkillEvaluationApi {
  constructor(private deps: SkillEvaluationDeps) {}

  async evaluate(_projectId: string): Promise<SkillEvaluationReport> {
    void this.deps
    throw new Error('Skill evaluation is not implemented yet')
  }
  last(_projectId: string): SkillEvaluationReport | null {
    return null
  }
  suggestion(_projectId: string, _suggestionId: string): SkillSuggestion {
    throw new Error('Suggestion not found')
  }
  markApplied(_projectId: string, _suggestionId: string, _skillId: string): void {}
}
