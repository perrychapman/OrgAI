// Run outputs (types.ts "Run outputs"): the main-process service contract between the outputs module
// (src/main/outputs/*: index store, versions, notes, path rules, writers, previews) and its callers (RunManager's
// RuntimeContext.outputs binding, the outputs:* IPC handlers, the watcher). Electron-free.
import type {
  OutputCompareInput,
  OutputDeleteInput,
  OutputDeletePreview,
  OutputDiff,
  OutputKind,
  OutputNote,
  OutputNoteAddInput,
  OutputNoteUpdateInput,
  OutputPreview,
  OutputProduceInput,
  OutputReadInput,
  OutputRegisterInput,
  OutputRestoreResult,
  OutputRevisionRequest,
  OutputSaveEditInput,
  OutputSaveEditResult,
  OutputSourceResult,
  OutputThumb,
  OutputUpdateInput,
  OutputVersion,
  OutputVersionSource,
  RunOutput
} from '@shared/types'

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

/**
 * A produce / register success.
 * - `created` true: a new output (v1).
 * - `created` false, `versioned` true: a new version was added to an existing output (identity rule).
 * - `created` false, `versioned` false: nothing about the content changed (same digest); title / description may have.
 * `previous` describes the version before this call when there was one (the tool's "the user edited version 2 at
 * 11:04" remark uses it when its source is 'edit' or 'external'). `answered` is the revision request id this version
 * answered, if any.
 */
export interface OutputWriteResult {
  output: RunOutput
  created: boolean
  versioned?: boolean
  previous?: { n: number; source: OutputVersionSource; at: number }
  answered?: string
}

/** read_output answers (structured; harnessTools.ts fences and words them). */
export type OutputReadResult =
  | { action: 'list'; items: { id: string; title: string; kind: OutputKind; version: number; openNotes: number; relPath: string }[]; more: number }
  | { action: 'read'; id: string; title: string; kind: OutputKind; version: number; text: string; truncated: boolean }
  | { action: 'notes'; id: string; title: string; version: number; notes: OutputNote[] }

/** Options of createOutputsService. Everything is optional; tests inject fakes. */
export interface OutputsServiceOptions {
  /**
   * Move a file to the OS trash (Electron shell.trashItem in index.ts). Missing or throwing = the file is deleted for
   * good (unlink) and OutputDeletePreview.trash is false.
   */
  trash?: (path: string) => Promise<void>
  /** Clock (tests). */
  now?: () => number
}

/** Per-output change notification raised by the service itself (the watcher's external versions, revision ends). */
export interface OutputsServiceEvents {
  onChange?: (projectId: string, ids: string[], what: 'version' | 'notes' | 'revision' | 'watch' | 'removed' | 'updated') => void
}

/**
 * The outputs service (`createOutputsService(dataDir, options)` in src/main/outputs/service.ts). Every refusal of an
 * agent path (produce / register / read) and of forget / delete / update / notes throws an Error whose message is one
 * plain sentence (the harness tool shows it after "REFUSED: "; IPC rejects with it). The user-facing write channels
 * with a result union (readSource, saveEdit, restore) answer `{ refused }` instead of throwing for a rule refusal;
 * they throw only for an unknown project or output.
 *
 * Every change to an output's file and index (produce, register, saveEdit, restore, external, delete) is serialized per
 * output (one queue per output id) and takes the snapshot before the index write.
 */
export interface OutputsServiceApi {
  /** Render / validate the content, write `<projectPath>/outputs/<fileName>` (identity rule: a new version of an indexed path) and index it. */
  produce(scope: OutputScope, input: OutputProduceInput, source: OutputSource): Promise<OutputWriteResult>
  /** Check the path rules and index an existing file (a known path adds a version when its content changed). */
  register(scope: OutputScope, input: OutputRegisterInput, source: OutputSource): Promise<OutputWriteResult>
  /** Newest first; an entry whose file is gone carries missing: true (never dropped). */
  list(projectId: string): RunOutput[]
  /** One entry, or undefined for an unknown id. */
  get(projectId: string, outputId: string): RunOutput | undefined
  /**
   * Never throws for a bad file (kind 'none' with a reason); throws only for an unknown project or id. `version`
   * missing or current = the file on disk (checked path); an older version = its snapshot.
   */
  preview(scope: OutputScope, outputId: string, version?: number): Promise<OutputPreview>
  /**
   * The entry's path after re-checking it against the index and the containment rules (inside projectPath or an
   * allowed folder, regular file, no link, not a reference folder, not the data folder, not under .git). For
   * outputs:open / reveal / saveAs. Throws a plain sentence otherwise.
   */
  checkedPath(scope: OutputScope, outputId: string): string
  /**
   * checkedPath plus the open allowlist (paths.ts OPENABLE_EXTENSIONS, judged on the real file's extension, not the
   * stored kind). For outputs:open only; reveal and saveAs use checkedPath. Optional so older fakes still compile;
   * callers without it must apply isOpenablePath themselves.
   */
  openablePath?(scope: OutputScope, outputId: string): string
  /** Remove the index entry and its versions, notes and revision requests (the file stays). Returns the list afterwards. */
  forget(projectId: string, outputId: string): RunOutput[]
  /**
   * Remove the output and its file, any source: re-check the path (regular file, the entry's real path, confinement),
   * trash it (unlink when trash is unavailable or fails), remove snapshots, notes and requests. A missing file just
   * removes the entry. `expectedVersionCount` must equal the stored version count (it may be absent only for a produced
   * output with one version); else throws "This output changed. Check it and delete again.". Returns the list afterwards.
   */
  delete(scope: OutputScope, input: Omit<OutputDeleteInput, 'projectId'>): Promise<RunOutput[]>
  /** What delete would remove (for the confirm). Throws only for an unknown project or id. */
  deletePreview(scope: OutputScope, outputId: string): OutputDeletePreview

  // ---- outputs 2: versions ----
  /** Newest first. Unknown id throws. */
  versions(projectId: string, outputId: string): OutputVersion[]
  /** An editable kind's text of one version (snapshot; the current version is read from disk after a path check). */
  readSource(scope: OutputScope, outputId: string, version: number): Promise<OutputSourceResult>
  /** Thumbnail of one version; never throws for a bad file ('none'). Queued 2 at a time. */
  thumb(scope: OutputScope, outputId: string, version: number): Promise<OutputThumb>
  /** Compare two versions; never throws for a bad file ('none' with a reason). Runs in the preview queue. */
  compare(scope: OutputScope, input: Omit<OutputCompareInput, 'projectId'>): Promise<OutputDiff>
  /** Save the user's text as a new version (source 'edit'); `stale` when baseVersion is not current and forceNew is not set. */
  saveEdit(scope: OutputScope, input: Omit<OutputSaveEditInput, 'projectId'>): Promise<OutputSaveEditResult>
  /** Snapshot any uncaptured change as 'external' first, then write version `version`'s bytes as a new version (source 'restore'). */
  restore(scope: OutputScope, outputId: string, version: number): Promise<OutputRestoreResult>
  /** Title / description / a version label. No file change, no new version. Throws a sentence on bad input. */
  update(projectId: string, input: Omit<OutputUpdateInput, 'projectId'>): RunOutput
  /**
   * Stat the file; when size or mtime moved since the last captured version (or since `settledSince`), hash it and add
   * an 'external' version when the digest differs. Never throws (logs once per output per hour); returns the entry
   * when a version was added. The watcher applies the settle rule before calling it.
   */
  captureExternal(scope: OutputScope, outputId: string): Promise<RunOutput | null>
  /** lstat of the current file for the watcher: size and mtime, or null when missing / not a regular file / refused by the path rules. */
  statCurrent(scope: OutputScope, outputId: string): { size: number; mtimeMs: number } | null

  // ---- outputs 2: notes (user only) ----
  /** All versions, oldest first. */
  notes(projectId: string, outputId: string): OutputNote[]
  noteAdd(projectId: string, input: Omit<OutputNoteAddInput, 'projectId'>): OutputNote
  noteUpdate(projectId: string, input: Omit<OutputNoteUpdateInput, 'projectId'>): OutputNote
  noteRemove(projectId: string, outputId: string, noteId: string): OutputNote[]

  // ---- outputs 2: revise requests ----
  /** Newest first. */
  revisions(projectId: string, outputId: string): OutputRevisionRequest[]
  /**
   * Record a request after RunManager accepted the message (id made by the caller with newRevisionId so the composed
   * message can name it). Marks `noteIds` notes 'sent' with sentIn = id.
   */
  recordRevision(projectId: string, request: Omit<OutputRevisionRequest, 'answeredBy' | 'endedAt'>): OutputRevisionRequest
  /** A run reached an outcome: unanswered requests of that run get endedAt. Returns the output ids touched. */
  runEnded(projectId: string, runId: string): string[]

  // ---- outputs 2: agents ----
  /** read_output (list / read / notes). Throws a sentence for a refusal (image, pdf, other: "OrgAI cannot read this kind of file as text."). */
  readForAgent(scope: OutputScope, input: OutputReadInput): Promise<OutputReadResult>
}
