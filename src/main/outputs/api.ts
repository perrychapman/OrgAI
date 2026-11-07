// Run outputs (types.ts "Run outputs"): the main-process service contract between the outputs module
// (src/main/outputs/*: index store, path rules, writers, previews) and its callers (RunManager's RuntimeContext.outputs
// binding, the outputs:* IPC handlers). Electron-free.
import type { OutputPreview, OutputProduceInput, OutputRegisterInput, RunOutput } from '@shared/types'

/**
 * The folders a call may touch, resolved by the caller from the stored Project at call time. `projectPath` is the
 * project folder (produced files go to `<projectPath>/outputs/`); `allowedDirectories` are Project.allowedDirectories
 * (registered files may live there too); `referenceDirectories` are Project.referenceDirectories (never accepted).
 */
export interface OutputScope {
  projectId: string
  projectPath: string
  allowedDirectories: readonly string[]
  referenceDirectories: readonly string[]
}

/** Who made an output: filled by RunManager from the run's agent record, never by the agent. */
export interface OutputSource {
  runId: string
  agentId?: string
  role?: string
}

/** A produce / register success. `created` false = an existing entry was updated (re-register or overwrite). */
export interface OutputWriteResult {
  output: RunOutput
  created: boolean
}

/**
 * The outputs service (`createOutputsService(dataDir)` in src/main/outputs/service.ts). Every refusal throws an Error
 * whose message is one plain sentence (the harness tool shows it after "REFUSED: "; IPC rejects with it).
 */
export interface OutputsServiceApi {
  /** Render / validate the content, write `<projectPath>/outputs/<fileName>` and index it. */
  produce(scope: OutputScope, input: OutputProduceInput, source: OutputSource): Promise<OutputWriteResult>
  /** Check the path rules and index (or update) an existing file. */
  register(scope: OutputScope, input: OutputRegisterInput, source: OutputSource): Promise<OutputWriteResult>
  /** Newest first; an entry whose file is gone carries missing: true (never dropped). */
  list(projectId: string): RunOutput[]
  /** One entry, or undefined for an unknown id. */
  get(projectId: string, outputId: string): RunOutput | undefined
  /** Never throws for a bad file (kind 'none' with a reason); throws only for an unknown project or id. */
  preview(scope: OutputScope, outputId: string): Promise<OutputPreview>
  /**
   * The entry's path after re-checking it against the index and the containment rules (inside projectPath or an
   * allowed folder, regular file, no link, not a reference folder, not the data folder, not under .git). For
   * outputs:open / reveal / saveAs. Throws a plain sentence otherwise.
   */
  checkedPath(scope: OutputScope, outputId: string): string
  /** Remove the index entry only. Returns the list afterwards. */
  forget(projectId: string, outputId: string): RunOutput[]
  /** Remove the entry and its file: only a regular file under `<projectPath>/outputs/`. Returns the list afterwards. */
  delete(scope: OutputScope, outputId: string): RunOutput[]
}
