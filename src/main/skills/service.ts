import type {
  Project,
  Role,
  SkillContent,
  SkillCreateInput,
  SkillDraft,
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
  SkillUpdateInput
} from '@shared/types'
import type { ProjectStore } from '../store/projects'
import type { RunSkill } from '../runtime/types'
import type { SkillRunSource, SkillServiceApi } from './types'

/** What SkillService needs. The constructor signature is the contract index.ts wires; keep it. */
export interface SkillServiceDeps {
  /** OrgAI's data dir (`<userData>/data`): skill-library.json, skills/<entryId>/, project-skills/<projectId>/<skillId>/. */
  dataDir: string
  projects: ProjectStore
  /** A library change (index.ts broadcasts skillLibrary:changed). */
  onLibraryChanged?(entries: SkillLibraryInfo[]): void
  /** A project saved by a library change (unlink on remove, promote), broadcast like a run's project.updated. */
  onProjectChanged?(project: Project): void
}

const NOT_YET = 'Skills are not implemented yet'

/**
 * Project skills, the app-wide skill library and the repo import.
 * CONTRACT STUB: the Runtime Engineer replaces every body; the class name, constructor and interfaces stay.
 */
export class SkillService implements SkillServiceApi, SkillRunSource {
  constructor(private deps: SkillServiceDeps) {}

  list(_projectId: string): SkillInfo[] {
    return []
  }
  read(_input: { projectId: string; skillId: string }): SkillContent {
    throw new Error(NOT_YET)
  }
  create(_input: SkillCreateInput, _source?: SkillSpec['source']): SkillMutationResult {
    throw new Error(NOT_YET)
  }
  update(_input: SkillUpdateInput): SkillMutationResult {
    throw new Error(NOT_YET)
  }
  remove(_input: { projectId: string; skillId: string }): SkillMutationResult {
    throw new Error(NOT_YET)
  }
  linkLibrary(_input: SkillLinkLibraryInput): SkillMutationResult {
    throw new Error(NOT_YET)
  }
  promote(_input: { projectId: string; skillId: string }): SkillMutationResult {
    throw new Error(NOT_YET)
  }
  previewImport(_input: SkillImportInput): SkillImportPreview {
    throw new Error(NOT_YET)
  }
  applyImport(_input: SkillImportApplyInput): SkillImportApplyResult {
    throw new Error(NOT_YET)
  }
  undoImport(_input: { projectId: string; undoId: string }): SkillMutationResult {
    throw new Error(NOT_YET)
  }
  libraryList(): SkillLibraryInfo[] {
    return []
  }
  libraryRead(_input: { libraryId: string }): SkillContent {
    throw new Error(NOT_YET)
  }
  libraryCreate(_draft: SkillDraft): SkillLibraryInfo[] {
    throw new Error(NOT_YET)
  }
  libraryAddFromFolder(_input: SkillLibraryFolderInput): SkillLibraryInfo[] {
    throw new Error(NOT_YET)
  }
  libraryUpdate(_input: { libraryId: string; draft: SkillDraft }): SkillLibraryInfo[] {
    throw new Error(NOT_YET)
  }
  libraryRemove(_input: { libraryId: string }): SkillLibraryInfo[] {
    throw new Error(NOT_YET)
  }
  withLibrary(project: Project): Project {
    return project
  }
  removeProjectFiles(_projectId: string): void {}
  forRun(_project: Project, _roles: Role[]): RunSkill[] {
    void this.deps
    return []
  }
}
