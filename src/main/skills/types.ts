import type {
  Project,
  Role,
  SkillApplySuggestionInput,
  SkillContent,
  SkillCreateInput,
  SkillDraft,
  SkillEvaluationReport,
  SkillImportApplyInput,
  SkillImportApplyResult,
  SkillImportInput,
  SkillImportPreview,
  SkillInfo,
  SkillLibraryFolderInput,
  SkillLibraryInfo,
  SkillLinkLibraryInput,
  SkillMutationResult,
  SkillSpec,
  SkillSuggestion,
  SkillUpdateInput
} from '@shared/types'
import type { RunSkill } from '../runtime/types'
import type { FileData } from './files'

/** SkillServiceApi.addSnapshot input. */
export interface SkillSnapshotInput {
  projectId: string
  /** The files as read (SKILL.md first or anywhere); folderName is the name fallback for SKILL.md parsing. */
  files: FileData[]
  folderName: string
  source: 'repo' | 'local' | 'github'
  /** source 'repo': project-relative folder. */
  repoPath?: string
  /** source 'local' / 'github': display location (home as ~, or the URL). */
  sourceRef?: string
  roleIds: string[]
}

/**
 * Main-process contracts of the skills feature. SkillService (service.ts) implements SkillServiceApi and
 * SkillRunSource; SkillEvaluationService (evaluation.ts) implements SkillEvaluationApi. ipc.ts and index.ts
 * depend only on these interfaces.
 */

/** Project skills, the library and the repo import: the skills:* and skillLibrary:* channels 1:1. */
export interface SkillServiceApi {
  list(projectId: string): SkillInfo[]
  read(input: { projectId: string; skillId: string }): SkillContent
  create(input: SkillCreateInput, source?: SkillSpec['source']): SkillMutationResult
  update(input: SkillUpdateInput): SkillMutationResult
  remove(input: { projectId: string; skillId: string }): SkillMutationResult
  linkLibrary(input: SkillLinkLibraryInput): SkillMutationResult
  /**
   * Store an already-read skill snapshot (the Team assistant's apply: a repo or local folder, or a fetched SKILL.md)
   * as a new project skill and grant it to `roleIds`. SKILL.md is re-emitted with name and description only and a
   * shell-injection body is refused. Main-process only: never reachable with renderer-supplied files.
   */
  addSnapshot(input: SkillSnapshotInput): SkillMutationResult
  promote(input: { projectId: string; skillId: string }): SkillMutationResult
  previewImport(input: SkillImportInput): SkillImportPreview
  applyImport(input: SkillImportApplyInput): SkillImportApplyResult
  undoImport(input: { projectId: string; undoId: string }): SkillMutationResult
  libraryList(): SkillLibraryInfo[]
  libraryRead(input: { libraryId: string }): SkillContent
  libraryCreate(draft: SkillDraft): SkillLibraryInfo[]
  libraryAddFromFolder(input: SkillLibraryFolderInput): SkillLibraryInfo[]
  libraryUpdate(input: { libraryId: string; draft: SkillDraft }): SkillLibraryInfo[]
  libraryRemove(input: { libraryId: string }): SkillLibraryInfo[]
  /** The project with linked skills refreshed from the library (like McpService.withLibrary). */
  withLibrary(project: Project): Project
  /** Delete every stored skill file of a project (projects:remove). */
  removeProjectFiles(projectId: string): void
}

/** What RunManager asks for at run start (RuntimeContext.skills). */
export interface SkillRunSource {
  /**
   * The project's enabled, runnable skills (library link present) granted to at least one of `roles`, with
   * RunSkill.roleIds filled from Role.skills. Never throws: a broken skill is left out (and logged).
   */
  forRun(project: Project, roles: Role[]): RunSkill[]
}

/** skills:evaluate / skills:lastEvaluation and the suggestion half of skills:applySuggestion. */
export interface SkillEvaluationApi {
  evaluate(projectId: string): Promise<SkillEvaluationReport>
  last(projectId: string): SkillEvaluationReport | null
  /** The suggestion of the last report, or a readable error (unknown, already applied). */
  suggestion(projectId: string, suggestionId: string): SkillSuggestion
  /** Record that a suggestion became a project skill (persists the report). */
  markApplied(projectId: string, suggestionId: string, skillId: string): void
}

/** skills:applySuggestion, composed in ipc.ts from the two services. */
export function applySuggestion(skills: SkillServiceApi, evaluation: SkillEvaluationApi, input: SkillApplySuggestionInput): SkillMutationResult {
  const suggestion = evaluation.suggestion(input.projectId, input.suggestionId)
  const result = skills.create({ projectId: input.projectId, draft: suggestion.draft, roleIds: input.roleIds }, 'suggestion')
  const created = result.skills.find((s) => s.spec.name === suggestion.draft.name)
  if (created) evaluation.markApplied(input.projectId, input.suggestionId, created.spec.id)
  return result
}
