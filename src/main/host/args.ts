/**
 * Electron-free argument builders and pure helpers shared by the host dispatcher and ipc.ts (cli-spec Wave 1). Every
 * renderer (or RPC) input is rebuilt here field by field before a service sees it; ipc.ts re-exports these names for
 * its existing tests. Relative imports only (noElectronImport.test.ts).
 */
import { existsSync } from 'node:fs'
import type {
  AppSettings,
  CapabilityApplyInput,
  CapabilityDiscoverInput,
  CapabilityRecommendInput,
  CapabilityUndoInput,
  ConnectionId,
  ConnectionSecretInput,
  ConnectorAddInput,
  ConnectorPresetRemoveInput,
  ConnectorTokenInput,
  EngagementDocumentUpdate,
  EngagementNoteRef,
  EngagementNoteSaveInput,
  KnowledgeDismissLinkInput,
  KnowledgeEdgeSaveInput,
  KnowledgeFactInput,
  KnowledgeItemRef,
  KnowledgeNodeSaveInput,
  ImageAttachment,
  McpAnswerInstallInput,
  McpCopyFromLibraryInput,
  McpInstallDecision,
  McpServerSpec,
  MergeDecision,
  PermissionDecision,
  PermissionRuleDecision,
  QuestionAnswer,
  ContinueRunInput,
  SendRunInput,
  StartRunInput,
  McpLibrarySecretInput,
  McpProjectOverridesInput,
  McpSecretInput,
  ModelsQuery,
  OrgTemplateApplyInput,
  OrgTemplateSaveInput,
  Project,
  ProjectRemoveInput,
  ProjectRemoveResult,
  ProposalDecision,
  QuickRunInput,
  QuickRunPromoteInput,
  RunOverrides,
  RunSummary,
  TeamDismissInput,
  TeamRestoreInput,
  TeamReviewInput
} from '../../shared/types'
import {
  HARNESS_PROJECT_ID,
  KNOWLEDGE_FACT_MAX_CHARS,
  KNOWLEDGE_LINK_ID_RE,
  KNOWLEDGE_NODE_FACTS_MAX,
  PROPOSAL_NOTE_MAX_CHARS,
  QUICK_RUN_MAX_PROMPT_CHARS,
  isVirtualProjectId
} from '../../shared/types'
import { isConnectionId, isSafeId, projectKindOf } from '../../shared/defaults'
import { stripSettingsInfo } from '../appInfo'
import { hiddenCharIn } from '../capabilities/sanitize'
import { harnessProject as buildHarnessProject } from '../mcp/assist'
import { scratchDirFor, validateQuickFolder } from '../quick/scratch'
import { sanitizeImages } from '../runtime/attachments'
import { runOverridesArgs } from '../runtime/runOverrides'
import { allowRuleRefusal, ruleSaveRefusal } from '../runtime/permissionRules'
import { isValidRule } from '../runtime/ruleMatch'
import { knowledgeNodeCount } from '../store/knowledge'
import { appRulesExist, engagementDocumentExists, listNotes, skillEvaluationFile, teamReviewFile } from '../store/projectData'
import { isValidId } from '../windowScope'

/**
 * The project a harness-level run continues or auto-resumes in. A build session (summary.buildWorkspace) gets its
 * workspace back (harnessProject allowBuild) only when the recorded path is exactly a <data>/quick/quick_<id> scratch
 * dir that still exists; a forged or vanished path throws instead of running without the workspace. Exported for tests.
 */
export function harnessProjectFor(
  summary: Pick<RunSummary, 'buildWorkspace'>,
  settings: AppSettings,
  dataDir: string,
  mock: boolean,
  exists: (p: string) => boolean = existsSync
): Project {
  const ws = summary.buildWorkspace
  if (ws === undefined) return buildHarnessProject(settings, dataDir, { mock })
  const dir = scratchDirFor(dataDir, ws)
  if (!dir || !exists(dir)) throw new Error("This build session's workspace is gone; start a new one.")
  return buildHarnessProject(settings, dataDir, { mock, allowBuild: true, workspace: dir })
}

/**
 * The settings the renderer sees (settings:get / settings:set results, the settings:changed push): defaultConnection
 * is the effective default, never the stored value (defaultConnectionChosen still says whether the user picked it;
 * settings:set keeps the stored value whatever is echoed back). Pure; exported for tests and index.ts.
 */
export function withEffectiveDefault(s: AppSettings, effective: ConnectionId): AppSettings {
  return { ...s, defaultConnection: effective }
}

/** Longest instruction accepted for the MCP and Skill assistants; longer is cut. */
export const ASSIST_INSTRUCTION_MAX_CHARS = 8000
/**
 * Checks a continued or messaged quick run: prompt at most QUICK_RUN_MAX_PROMPT_CHARS (refused, never cut) and, for a
 * non-scratch folder, validateQuickFolder again (it may have become a link into the data dir). Exported for tests.
 */
export function checkQuickContinue(summary: Pick<RunSummary, 'quick'>, text: unknown, dataDir: string, validate: (folder: unknown, dataDir: string) => unknown = validateQuickFolder): void {
  if (!summary.quick) return
  if (typeof text === 'string' && text.length > QUICK_RUN_MAX_PROMPT_CHARS) {
    throw new Error(`That message is too long (at most ${QUICK_RUN_MAX_PROMPT_CHARS.toLocaleString('en-US')} characters).`)
  }
  if (!summary.quick.scratch) validate(summary.quick.folder, dataDir)
}

/** Longest folder path accepted for a quick run; QuickRunService validates the folder itself. */
const QUICK_FOLDER_MAX_CHARS = 4096

/**
 * Renderer input for runs:startQuick / runs:promoteQuick rebuilt field by field: a prompt that is text, trimmed and at
 * most QUICK_RUN_MAX_PROMPT_CHARS (longer is refused, never cut), a folder as text (checked by QuickRunService), the
 * team only 'single' | 'default' (anything else is 'single'), allowEdits only when the literal true, images through
 * the run image sanitizer; any other field is dropped. Exported for tests.
 */
export const quickArgs = {
  start(input: unknown): QuickRunInput {
    const i = obj<Record<string, unknown>>(input)
    if (typeof i.prompt !== 'string') throw new Error('Type what you want done.')
    const prompt = i.prompt.trim()
    if (prompt.length > QUICK_RUN_MAX_PROMPT_CHARS) throw new Error(`That message is too long (at most ${QUICK_RUN_MAX_PROMPT_CHARS.toLocaleString('en-US')} characters).`)
    const images = sanitizeImages(i.images)
    if (!prompt && !images.length) throw new Error('Type what you want done.')
    const out: QuickRunInput = { prompt, team: i.team === 'default' ? 'default' : 'single', allowEdits: i.allowEdits === true }
    if (typeof i.folder === 'string' && i.folder.trim()) {
      if (i.folder.length > QUICK_FOLDER_MAX_CHARS) throw new Error('That folder path is too long.')
      out.folder = i.folder
    }
    if (images.length) out.images = images
    // Headless exec overrides (cli-spec 6.2(1)), strictly: a bad value is refused as bad_request. The dispatcher drops
    // them on the desktop surface and checks the scope on the others.
    const overrides = runOverridesArgs(i.overrides)
    if (overrides) out.overrides = overrides
    return out
  },
  promote(input: unknown): QuickRunPromoteInput {
    const i = obj<Record<string, unknown>>(input)
    if (!isSafeId(i.runId)) throw new Error('Quick run not found.')
    const name = typeof i.name === 'string' ? i.name.trim() : ''
    if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error('Give the project a name of 1 to 80 characters.')
    return { runId: i.runId, name }
  }
}

/** The Skill assistant / MCP assistant instruction: text only, trimmed, cut at ASSIST_INSTRUCTION_MAX_CHARS. */
function instructionArg(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, ASSIST_INSTRUCTION_MAX_CHARS) : undefined
}

/**
 * skills:startAssist input. Scope 'library' (explicit, or no projectId) runs on the virtual SKILLS_PROJECT_ID. Scope
 * 'project' needs a projectId that is a safe id, not virtual and a stored project (`isStored`). Exported for tests.
 */
export function skillAssistArgs(input: unknown, isStored: (projectId: string) => boolean): { library: true; instruction?: string } | { library: false; projectId: string; instruction?: string } {
  const i = obj<Record<string, unknown>>(input)
  const instruction = instructionArg(i.instruction)
  const base = instruction ? { instruction } : {}
  if (i.scope === 'library' || i.projectId === undefined || i.projectId === null || i.projectId === '') return { library: true, ...base }
  if (!isSafeId(i.projectId) || isVirtualProjectId(i.projectId) || !isStored(i.projectId)) throw new Error('Project not found')
  return { library: false, projectId: i.projectId, ...base }
}

/**
 * mcp:startAssist input. allowBuild is only ever the literal true, and only for library scope (the app-wide
 * assistant): a project-scope request with allowBuild is refused rather than silently ignored, because the user
 * would expect a build workspace. Exported for tests.
 */
export function mcpAssistArgs(input: unknown): { library: boolean; projectId: string; instruction?: string; allowBuild: boolean } {
  const i = obj<Record<string, unknown>>(input)
  const library = i.scope === 'library'
  const allowBuild = i.allowBuild === true
  if (allowBuild && !library) throw new Error('Building a server is available in the app-wide MCP assistant only.')
  const instruction = instructionArg(i.instruction)
  return { library, projectId: library ? HARNESS_PROJECT_ID : typeof i.projectId === 'string' ? i.projectId : '', allowBuild, ...(instruction ? { instruction } : {}) }
}

// ---------- Team templates, engagement document and notes, project removal ----------

/** A project id for a stored project: a valid id that is not virtual. */
export function storedIdArg(id: unknown): string {
  if (!isSafeId(id) || isVirtualProjectId(id)) throw new Error('Project not found')
  return id
}

/** projects:remove / projects:removePreview input: a bare id, or { projectId, removeRuns? } (extra fields dropped). */
export function projectRemoveArgs(input: unknown): { projectId: string; removeRuns: boolean | undefined } {
  if (typeof input === 'string') {
    if (isVirtualProjectId(input)) throw new Error('This assistant project cannot be removed.')
    return { projectId: storedIdArg(input), removeRuns: undefined }
  }
  const i = obj<Partial<ProjectRemoveInput>>(input)
  if (typeof i.projectId === 'string' && isVirtualProjectId(i.projectId)) throw new Error('This assistant project cannot be removed.')
  if (i.removeRuns !== undefined && typeof i.removeRuns !== 'boolean') throw new Error('Invalid removal options.')
  return { projectId: storedIdArg(i.projectId), removeRuns: i.removeRuns }
}

/** Runs are removed by default; an engagement always removes them (false is ignored there). */
export function effectiveRemoveRuns(kind: 'code' | 'engagement', asked: boolean | undefined): boolean {
  return kind === 'engagement' ? true : asked !== false
}

export interface RemovalDeps {
  dataDir: string
  /** The stored project, or null when it is already gone. */
  project: Project | null
  /** Run records the project has (RunManager.list). */
  runCount(projectId: string): number
}

/**
 * What removing a project deletes, gathered before anything is deleted. projects:remove returns it (with the run
 * count RunManager reports) and projects:removePreview returns it as is, so the two always agree. Best effort: a
 * failing lookup counts as nothing. `removeRuns` is the effective value (effectiveRemoveRuns).
 */
export function removalFacts(deps: RemovalDeps, projectId: string, removeRuns: boolean): ProjectRemoveResult {
  const safe = <T>(fn: () => T, fallback: T): T => {
    try {
      return fn()
    } catch {
      return fallback
    }
  }
  const runs = safe(() => deps.runCount(projectId), 0)
  const exists = (file: string | null): boolean => !!file && safe(() => existsSync(file), false)
  return {
    projectId,
    kind: projectKindOf(deps.project),
    runsRemoved: removeRuns ? runs : 0,
    runsKept: removeRuns ? 0 : runs,
    notesRemoved: safe(() => listNotes(deps.dataDir, projectId).length, 0),
    skillsRemoved: deps.project?.skills?.length ?? 0,
    documentRemoved: engagementDocumentExists(deps.dataDir, projectId),
    rulesRemoved: appRulesExist(deps.dataDir, projectId),
    teamReviewRemoved: exists(teamReviewFile(deps.dataDir, projectId)),
    skillEvaluationRemoved: exists(skillEvaluationFile(deps.dataDir, projectId)),
    knowledgeRemoved: safe(() => knowledgeNodeCount(deps.dataDir, projectId), 0)
  }
}

const NOTE_ID = /^note_[A-Za-z0-9_-]{1,100}$/

/** Renderer input of the templates:* and engagement channels, rebuilt field by field (extra fields dropped). */
export const templateEngagementArgs = {
  projectId(input: unknown): string {
    return storedIdArg(input)
  },
  templateId(input: unknown): string {
    if (!isSafeId(input)) throw new Error('Template not found')
    return input
  },
  saveTemplate(input: unknown): OrgTemplateSaveInput {
    const i = obj<Record<string, unknown>>(input)
    if (typeof i.name !== 'string') throw new Error('Give the template a name.')
    if (i.description !== undefined && typeof i.description !== 'string') throw new Error('The template description must be text.')
    return { projectId: storedIdArg(i.projectId), name: i.name, ...(typeof i.description === 'string' ? { description: i.description } : {}) }
  },
  applyTemplate(input: unknown): OrgTemplateApplyInput {
    const i = obj<Record<string, unknown>>(input)
    if (i.mode !== 'replace' && i.mode !== 'merge') throw new Error('Choose whether the template replaces the org chart or is added to it.')
    return { projectId: storedIdArg(i.projectId), templateId: templateEngagementArgs.templateId(i.templateId), mode: i.mode }
  },
  updateDocument(input: unknown): EngagementDocumentUpdate {
    const i = obj<Record<string, unknown>>(input)
    if (typeof i.text !== 'string') throw new Error('The engagement document must be text.')
    if (i.expectedUpdatedAt !== undefined && (typeof i.expectedUpdatedAt !== 'number' || !Number.isFinite(i.expectedUpdatedAt) || i.expectedUpdatedAt < 0)) {
      throw new Error('Invalid document version.')
    }
    return { projectId: storedIdArg(i.projectId), text: i.text, ...(typeof i.expectedUpdatedAt === 'number' ? { expectedUpdatedAt: i.expectedUpdatedAt } : {}) }
  },
  noteRef(input: unknown): EngagementNoteRef {
    const i = obj<Record<string, unknown>>(input)
    if (typeof i.noteId !== 'string' || !NOTE_ID.test(i.noteId)) throw new Error('Note not found')
    return { projectId: storedIdArg(i.projectId), noteId: i.noteId }
  },
  saveNote(input: unknown): EngagementNoteSaveInput {
    const i = obj<Record<string, unknown>>(input)
    if (typeof i.title !== 'string') throw new Error('The title must be text.')
    if (typeof i.text !== 'string') throw new Error('The note must be text.')
    let noteId: string | undefined
    if (i.noteId !== undefined && i.noteId !== null) {
      if (typeof i.noteId !== 'string' || !NOTE_ID.test(i.noteId)) throw new Error('Note not found')
      noteId = i.noteId
    }
    if (i.retired !== undefined && i.retired !== null && typeof i.retired !== 'boolean') throw new Error('retired must be true or false.')
    let expectedUpdatedAt: number | undefined
    if (i.expectedUpdatedAt !== undefined && i.expectedUpdatedAt !== null) {
      if (typeof i.expectedUpdatedAt !== 'number' || !Number.isFinite(i.expectedUpdatedAt)) throw new Error('expectedUpdatedAt must be a number.')
      if (!noteId) throw new Error('expectedUpdatedAt needs a noteId.')
      expectedUpdatedAt = i.expectedUpdatedAt
    }
    return {
      projectId: storedIdArg(i.projectId),
      ...(noteId ? { noteId } : {}),
      title: i.title,
      text: i.text,
      ...(typeof i.retired === 'boolean' ? { retired: i.retired } : {}),
      ...(expectedUpdatedAt !== undefined ? { expectedUpdatedAt } : {})
    }
  }
}

const isKnowledgeId = (x: unknown, prefix: string): x is string => isSafeId(x) && x.startsWith(prefix)

/** An optional id field: undefined / null = absent; anything else must be a string with the prefix, else `refusal`. */
function optionalKnowledgeId(x: unknown, prefix: string, refusal: string): string | undefined {
  if (x === undefined || x === null) return undefined
  if (!isKnowledgeId(x, prefix)) throw new Error(refusal)
  return x
}

/** An optional string field: undefined / null = absent; anything else must be a string. */
function optionalText(x: unknown, label: string): string | undefined {
  if (x === undefined || x === null) return undefined
  if (typeof x !== 'string') throw new Error(`${label} must be text.`)
  return x
}

function optionalBoolean(x: unknown, label: string): boolean | undefined {
  if (x === undefined || x === null) return undefined
  if (typeof x !== 'boolean') throw new Error(`${label} must be true or false.`)
  return x
}

function optionalTextList(x: unknown, label: string): string[] | undefined {
  if (x === undefined || x === null) return undefined
  if (!Array.isArray(x) || x.some((s) => typeof s !== 'string')) throw new Error(`${label} must be a list of text.`)
  return [...(x as string[])]
}

/**
 * Renderer input of the knowledge:* channels, rebuilt field by field (extra fields dropped, wrong types refused with a
 * short message). String content (lengths, hidden characters, keys, caps) is the store's to validate.
 */
export const knowledgeArgs = {
  projectId(input: unknown): string {
    return storedIdArg(input)
  },
  saveNode(input: unknown): KnowledgeNodeSaveInput {
    const i = obj<Record<string, unknown>>(input)
    const projectId = storedIdArg(i.projectId)
    const nodeId = optionalKnowledgeId(i.nodeId, 'kn_', 'Entity not found')
    // With nodeId, kind and name may be left out (kept from the stored node): an append-only save (cli-spec 3.6).
    const kind = i.kind === undefined || i.kind === null ? undefined : i.kind
    const name = i.name === undefined || i.name === null ? undefined : i.name
    if (kind !== undefined ? typeof kind !== 'string' : !nodeId) throw new Error('The kind must be text.')
    if (name !== undefined ? typeof name !== 'string' : !nodeId) throw new Error('The name must be text.')
    const aliases = optionalTextList(i.aliases, 'Aliases')
    const summary = optionalText(i.summary, 'The summary')
    const noteIds = optionalTextList(i.noteIds, 'Note links')
    const retired = optionalBoolean(i.retired, 'retired')
    let facts: KnowledgeFactInput[] | undefined
    if (i.facts !== undefined && i.facts !== null) {
      if (!Array.isArray(i.facts)) throw new Error('Facts must be a list.')
      facts = i.facts.map((raw): KnowledgeFactInput => {
        const f = obj<Record<string, unknown>>(raw)
        const id = optionalKnowledgeId(f.id, 'kf_', 'Fact not found')
        if (typeof f.text !== 'string') throw new Error('A fact must be text.')
        const flag = optionalBoolean(f.retired, 'A fact\'s retired flag')
        return { ...(id ? { id } : {}), text: f.text, ...(flag !== undefined ? { retired: flag } : {}) }
      })
    }
    // cli-spec 3.6 item 3: atomic fact append and compare-and-set, validated again by the store.
    let appendFacts: string[] | undefined
    if (i.appendFacts !== undefined && i.appendFacts !== null) {
      const list = i.appendFacts
      if (!Array.isArray(list) || list.length > KNOWLEDGE_NODE_FACTS_MAX || list.some((s) => typeof s !== 'string' || s.length > KNOWLEDGE_FACT_MAX_CHARS)) {
        throw new Error(`Facts to add must be a list of at most ${KNOWLEDGE_NODE_FACTS_MAX} texts of at most ${KNOWLEDGE_FACT_MAX_CHARS} characters.`)
      }
      appendFacts = [...(list as string[])]
    }
    let expectedUpdatedAt: number | undefined
    if (i.expectedUpdatedAt !== undefined && i.expectedUpdatedAt !== null) {
      if (typeof i.expectedUpdatedAt !== 'number' || !Number.isFinite(i.expectedUpdatedAt)) throw new Error('expectedUpdatedAt must be a finite number.')
      expectedUpdatedAt = i.expectedUpdatedAt
    }
    return {
      projectId,
      ...(nodeId ? { nodeId } : {}),
      ...(typeof kind === 'string' ? { kind } : {}),
      ...(typeof name === 'string' ? { name } : {}),
      ...(aliases ? { aliases } : {}),
      ...(summary !== undefined ? { summary } : {}),
      ...(facts ? { facts } : {}),
      ...(noteIds ? { noteIds } : {}),
      ...(retired !== undefined ? { retired } : {}),
      ...(appendFacts ? { appendFacts } : {}),
      ...(expectedUpdatedAt !== undefined ? { expectedUpdatedAt } : {})
    }
  },
  /** projectId plus exactly one of nodeId / edgeId. */
  itemRef(input: unknown): KnowledgeItemRef {
    const i = obj<Record<string, unknown>>(input)
    const projectId = storedIdArg(i.projectId)
    const nodeId = optionalKnowledgeId(i.nodeId, 'kn_', 'Entity not found')
    const edgeId = optionalKnowledgeId(i.edgeId, 'ke_', 'Relation not found')
    if ((nodeId === undefined) === (edgeId === undefined)) throw new Error('Name exactly one of nodeId or edgeId.')
    return { projectId, ...(nodeId ? { nodeId } : {}), ...(edgeId ? { edgeId } : {}) }
  },
  saveEdge(input: unknown): KnowledgeEdgeSaveInput {
    const i = obj<Record<string, unknown>>(input)
    const projectId = storedIdArg(i.projectId)
    const edgeId = optionalKnowledgeId(i.edgeId, 'ke_', 'Relation not found')
    if (typeof i.from !== 'string' || typeof i.to !== 'string') throw new Error('Name the two entities to relate.')
    if (typeof i.relation !== 'string') throw new Error('The relation must be text.')
    const note = optionalText(i.note, 'The note')
    const retired = optionalBoolean(i.retired, 'retired')
    return {
      projectId,
      ...(edgeId ? { edgeId } : {}),
      from: i.from,
      to: i.to,
      relation: i.relation,
      ...(note !== undefined ? { note } : {}),
      ...(retired !== undefined ? { retired } : {})
    }
  },
  /** projectId plus a link id of the KNOWLEDGE_LINK_ID_RE shape; extra fields dropped. */
  dismissLink(input: unknown): KnowledgeDismissLinkInput {
    const i = obj<Record<string, unknown>>(input)
    const projectId = storedIdArg(i.projectId)
    if (typeof i.linkId !== 'string' || !KNOWLEDGE_LINK_ID_RE.test(i.linkId)) throw new Error('That is not a connection id.')
    return { projectId, linkId: i.linkId }
  }
}

/** A plain object argument, or {} (handlers validate the fields; services re-check ids against the stores). */
export function obj<T>(input: unknown): T {
  return (input && typeof input === 'object' ? input : {}) as T
}

/** A project id that may name a stored project (the harness project has no skills). */
export function projectIdArg(id: unknown): string {
  if (!isValidId(id) || isVirtualProjectId(id)) throw new Error('Project not found')
  return id
}

/** Role ids per apply; more is refused. */
const CAPABILITY_MAX_ROLE_IDS = 100

/**
 * Renderer input for capabilities:* rebuilt field by field: only known fields with the right shape reach the service,
 * so a renderer can never smuggle a path, a spec or file content into apply. Exported for tests.
 */
export const capabilityArgs = {
  discover(input: unknown): CapabilityDiscoverInput {
    const i = obj<Record<string, unknown>>(input)
    const out: CapabilityDiscoverInput = { projectId: projectIdArg(i.projectId), includeOutside: i.includeOutside === true }
    if (typeof i.query === 'string' && i.query.trim()) out.query = i.query.trim().slice(0, 100)
    if (i.requestId !== undefined) {
      if (!isValidId(i.requestId)) throw new Error('Invalid request id')
      out.requestId = i.requestId
    }
    return out
  },
  recommend(input: unknown): CapabilityRecommendInput {
    const i = obj<Record<string, unknown>>(input)
    const out: CapabilityRecommendInput = { ...capabilityArgs.discover(input), scope: {} }
    const scope = obj<Record<string, unknown>>(i.scope)
    if (scope.roleId !== undefined) {
      if (!isValidId(scope.roleId)) throw new Error('Role not found')
      out.scope = { roleId: scope.roleId }
    }
    return out
  },
  apply(input: unknown): CapabilityApplyInput {
    const i = obj<Record<string, unknown>>(input)
    if (typeof i.digest !== 'string' || !/^[a-f0-9]{64}$/.test(i.digest)) throw new Error('Run the recommendations again first: the result is missing or out of date.')
    if (!Array.isArray(i.roleIds) || i.roleIds.length === 0) throw new Error('Choose at least one role.')
    if (i.roleIds.length > CAPABILITY_MAX_ROLE_IDS || !i.roleIds.every((r) => isValidId(r))) throw new Error('Unknown role in the choice.')
    if (i.access !== undefined && i.access !== 'read' && i.access !== 'full') throw new Error('Access must be read or full.')
    const out: CapabilityApplyInput = {
      projectId: projectIdArg(i.projectId),
      digest: i.digest,
      roleIds: [...new Set(i.roleIds as string[])]
    }
    // Omitted access means the recommendation's own access (else 'read'); the service still enforces the write-tools rule.
    if (i.access === 'read' || i.access === 'full') out.access = i.access
    if (i.recommendationId !== undefined) {
      if (!isValidId(i.recommendationId)) throw new Error('Recommendation not found')
      out.recommendationId = i.recommendationId
    }
    if (i.candidateId !== undefined) {
      if (!isValidId(i.candidateId)) throw new Error('Candidate not found')
      out.candidateId = i.candidateId
    }
    if (!out.recommendationId && !out.candidateId) throw new Error('Name a recommendation or a candidate.')
    return out
  },
  undo(input: unknown): CapabilityUndoInput {
    const i = obj<Record<string, unknown>>(input)
    const projectId = projectIdArg(i.projectId)
    if (!isValidId(i.undoId)) throw new Error('Nothing to undo')
    return { projectId, undoId: i.undoId }
  },
  review(input: unknown): TeamReviewInput {
    const i = obj<Record<string, unknown>>(input)
    const trigger = i.trigger === 'opened' ? 'opened' : 'manual'
    const out: TeamReviewInput = { projectId: projectIdArg(i.projectId), trigger }
    if (i.requestId !== undefined) {
      if (!isValidId(i.requestId)) throw new Error('Invalid request id')
      out.requestId = i.requestId
    }
    // Outside fetches and the model step are the user's explicit call: never on the throttled 'opened' trigger.
    if (trigger === 'manual') {
      out.includeOutside = i.includeOutside === true
      out.useModel = i.useModel === true
    }
    return out
  },
  dismiss(input: unknown): TeamDismissInput {
    const i = obj<Record<string, unknown>>(input)
    const projectId = projectIdArg(i.projectId)
    const out: TeamDismissInput = { projectId }
    if (i.recommendationId !== undefined) {
      if (!isValidId(i.recommendationId)) throw new Error('Recommendation not found')
      out.recommendationId = i.recommendationId
    }
    if (i.candidateId !== undefined) {
      if (!isValidId(i.candidateId)) throw new Error('Candidate not found')
      out.candidateId = i.candidateId
    }
    if (!out.recommendationId && !out.candidateId) throw new Error('Recommendation not found')
    return out
  },
  restore(input: unknown): TeamRestoreInput {
    const i = obj<Record<string, unknown>>(input)
    const projectId = projectIdArg(i.projectId)
    if (!isValidId(i.candidateId)) throw new Error('Candidate not found')
    return { projectId, candidateId: i.candidateId }
  }
}

/**
 * connections:test / connections:logout input: a known ConnectionId (an own entry of CONNECTION_IDS, never a
 * prototype key), else "Unknown connection". Exported for tests.
 */
export function connectionIdArg(raw: unknown): ConnectionId {
  if (!isConnectionId(raw)) throw new Error('Unknown connection')
  return raw
}

/** Longest LiteLLM key accepted over IPC (connections:setSecret). */
export const CONNECTION_SECRET_MAX_CHARS = 4000

/**
 * connections:setSecret input rebuilt as `{ id: 'litellm', apiKey: string | null }`: the key is printable text
 * without line breaks or control characters (it becomes an env var and an Authorization header), at most
 * CONNECTION_SECRET_MAX_CHARS; '' or null clears it. Anything else is refused; extra fields are dropped. The error
 * never echoes the value. Exported for tests.
 */
export function connectionSecretArgs(raw: unknown): ConnectionSecretInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Only the LiteLLM connection has a stored secret')
  const i = raw as Record<string, unknown>
  if (i.id !== 'litellm') throw new Error('Only the LiteLLM connection has a stored secret')
  if (i.apiKey === null || i.apiKey === undefined) return { id: 'litellm', apiKey: null }
  if (typeof i.apiKey !== 'string') throw new Error('The API key must be text.')
  if (i.apiKey.length > CONNECTION_SECRET_MAX_CHARS) throw new Error(`The API key is too long (at most ${CONNECTION_SECRET_MAX_CHARS} characters).`)
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(i.apiKey.trim())) throw new Error('The API key contains line breaks or hidden characters.')
  return { id: 'litellm', apiKey: i.apiKey }
}

/**
 * models:list / models:refresh input rebuilt: undefined or null for every enabled connection, else an object whose
 * `connection` is absent or a known ConnectionId; other fields are dropped. Exported for tests.
 */
export function modelsQueryArg(raw: unknown): ModelsQuery | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Unknown connection')
  const connection = (raw as Record<string, unknown>).connection
  if (connection === undefined) return {}
  return { connection: connectionIdArg(connection) }
}

/**
 * settings:set input: a plain object (anything else is refused), merged onto the stored settings (never onto the
 * defaults, so a field the renderer left out keeps its stored value). The main-owned fields always keep their stored
 * values: defaultConnection, defaultConnectionChosen and defaultConnectionReplaced (change the default only through
 * connections:setDefault), connections and its providerAuth mirror (connections:update / setSecret), and
 * terminalServerChosen (set here once a save changes terminalServer). The AppSettingsInfo extras are dropped. Pure; exported for tests. SettingsStore.set normalizes the rest.
 */
export function settingsSetArgs(raw: unknown, stored: AppSettings): AppSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Settings must be an object.')
  const proto = Object.getPrototypeOf(raw)
  if (proto !== Object.prototype && proto !== null) throw new Error('Settings must be an object.')
  const incoming = stripSettingsInfo(raw as AppSettings)
  const {
    defaultConnection: _dc,
    defaultConnectionChosen: _chosen,
    defaultConnectionReplaced: _replaced,
    connections: _connections,
    providerAuth: _auth,
    terminalServerChosen: _terminalChosen,
    terminalAccessLevelChosen: _levelChosen,
    ...rest
  } = incoming
  // A field whose kind differs from the stored one's (a non-array modelPrices, a string flag, null) is dropped, so a
  // malformed save never wipes a stored value. undefined still clears an optional field; a field with nothing stored
  // goes through to SettingsStore normalization.
  const kindOf = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v)
  const storedFields = stored as unknown as Record<string, unknown>
  for (const [key, value] of Object.entries(rest)) {
    const was = Object.hasOwn(storedFields, key) ? storedFields[key] : undefined
    if (value !== undefined && was !== undefined && kindOf(value) !== kindOf(was)) delete (rest as Record<string, unknown>)[key]
  }
  const out: AppSettings = { ...stored, ...rest }
  out.defaultConnection = stored.defaultConnection
  out.connections = stored.connections
  out.providerAuth = stored.providerAuth
  delete out.defaultConnectionChosen
  delete out.defaultConnectionReplaced
  if (stored.defaultConnectionChosen !== undefined) out.defaultConnectionChosen = stored.defaultConnectionChosen
  if (stored.defaultConnectionReplaced !== undefined) out.defaultConnectionReplaced = stored.defaultConnectionReplaced
  // terminalServerChosen is main-owned: it sticks once a save changed Terminal access, so a later headless boot
  // never overrides the user's choice (bootstrap.ts).
  delete out.terminalServerChosen
  if (stored.terminalServerChosen === true || (out.terminalServer === true) !== (stored.terminalServer === true)) out.terminalServerChosen = true
  // terminalAccessLevelChosen likewise (Wave 7, round 6 item 11): set once a save names a level other than the stored
  // one (picking 'operate' explicitly over an unset level counts), so `orgai daemon start` never asks again.
  delete out.terminalAccessLevelChosen
  const level = out.terminalAccessLevel
  if (stored.terminalAccessLevelChosen === true || ((level === 'full' || level === 'operate') && level !== stored.terminalAccessLevel)) out.terminalAccessLevelChosen = true
  return out
}

/** Longest pasted connector token accepted over IPC; McpService re-checks the header value it builds. */
export const CONNECTOR_TOKEN_MAX_CHARS = 4000
/** Catalog ids and variant ids are lowercase kebab-case, at most 64 chars. */
const CONNECTOR_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/

function connectorObject(input: unknown): Record<string, unknown> & { connectorId: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Unknown connector.')
  const i = input as Record<string, unknown>
  if (typeof i.connectorId !== 'string' || !CONNECTOR_ID_RE.test(i.connectorId)) throw new Error('Unknown connector.')
  return i as Record<string, unknown> & { connectorId: string }
}

/**
 * Renderer input for connectors:add / connectors:setToken rebuilt field by field: a catalog-shaped connector id (and
 * variant id), or a bounded token string / null; any other field is dropped and a wrong shape is refused. McpService
 * still resolves the ids against the catalog. Exported for tests.
 */
export const connectorArgs = {
  add(input: unknown): ConnectorAddInput {
    const i = connectorObject(input)
    const out: ConnectorAddInput = { connectorId: i.connectorId }
    if (i.variant !== undefined) {
      if (typeof i.variant !== 'string' || !CONNECTOR_ID_RE.test(i.variant)) throw new Error('Unknown connector variant.')
      out.variant = i.variant
    }
    return out
  },
  setToken(input: unknown): ConnectorTokenInput {
    const i = connectorObject(input)
    if (i.token === null) return { connectorId: i.connectorId, token: null }
    if (typeof i.token !== 'string') throw new Error('The token must be text.')
    if (i.token.length > CONNECTOR_TOKEN_MAX_CHARS) throw new Error(`The token is too long (at most ${CONNECTOR_TOKEN_MAX_CHARS} characters).`)
    return { connectorId: i.connectorId, token: i.token }
  }
}

/**
 * mcp:copyFromLibrary input rebuilt field by field: a plain object with projectId and serverId matching SAFE_ID and a
 * boolean copySecrets; extra fields are dropped, anything else is refused. Exported for tests.
 */
export function mcpCopyArgs(input: unknown): McpCopyFromLibraryInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid copy request.')
  const i = input as Record<string, unknown>
  if (!isSafeId(i.projectId) || !isSafeId(i.serverId) || typeof i.copySecrets !== 'boolean') throw new Error('Invalid copy request.')
  return { projectId: i.projectId, serverId: i.serverId, copySecrets: i.copySecrets }
}

function secretArgs(input: unknown, idField: 'projectId' | 'libraryId'): Record<string, unknown> {
  const bad = (): never => {
    throw new Error('Invalid secret.')
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return bad()
  const proto = Object.getPrototypeOf(input)
  if (proto !== Object.prototype && proto !== null) return bad()
  const i = input as Record<string, unknown>
  const own = (k: string): unknown => (Object.hasOwn(i, k) ? i[k] : undefined)
  if (!isSafeId(own(idField))) return bad()
  const kind = own('kind')
  if (kind !== 'env' && kind !== 'header') return bad()
  const name = own('name')
  if (typeof name !== 'string' || name.length < 1 || name.length > 128) return bad()
  const value = own('value')
  if (value !== null) {
    if (typeof value !== 'string' || value.length > 4000 || hiddenCharIn(value)) return bad()
  }
  const out: Record<string, unknown> = { [idField]: own(idField), kind, name, value }
  if (idField === 'projectId') {
    if (!isSafeId(own('serverId'))) return bad()
    out.serverId = own('serverId')
  }
  return out
}

/** mcp:setSecret input rebuilt field by field; "Invalid secret." never echoes the value. Exported for tests. */
export function mcpSecretArgs(input: unknown): McpSecretInput {
  return secretArgs(input, 'projectId') as unknown as McpSecretInput
}

/** mcpLibrary:setSecret input rebuilt field by field. Exported for tests. */
export function mcpLibrarySecretArgs(input: unknown): McpLibrarySecretInput {
  return secretArgs(input, 'libraryId') as unknown as McpLibrarySecretInput
}

/** Most names one mcp:setProjectOverrides map may carry (the entry's perProjectEnv is capped at 20 anyway). */
export const OVERRIDES_MAX_KEYS = 50

/**
 * mcp:setProjectOverrides input rebuilt field by field: a plain object with SAFE_ID projectId and serverId and, for
 * env and headers each, absent or a plain object of at most OVERRIDES_MAX_KEYS string values; anything else is refused
 * ("Invalid overrides."), extra fields are dropped. McpService.setProjectOverrides filters names and checks values.
 * Exported for tests.
 */
export function mcpOverridesArgs(input: unknown): McpProjectOverridesInput {
  const bad = (): never => {
    throw new Error('Invalid overrides.')
  }
  const isPlainObject = (v: unknown): v is Record<string, unknown> => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false
    const proto = Object.getPrototypeOf(v)
    return proto === Object.prototype || proto === null
  }
  if (!isPlainObject(input)) return bad()
  if (!isSafeId(input.projectId) || !isSafeId(input.serverId)) return bad()
  const out: McpProjectOverridesInput = { projectId: input.projectId, serverId: input.serverId }
  for (const field of ['env', 'headers'] as const) {
    const given = Object.hasOwn(input, field) ? input[field] : undefined
    if (given === undefined) continue
    if (!isPlainObject(given)) return bad()
    const entries = Object.entries(given)
    if (entries.length > OVERRIDES_MAX_KEYS) return bad()
    const map: Record<string, string> = {}
    for (const [k, v] of entries) {
      if (typeof v !== 'string' || k === '__proto__') return bad()
      map[k] = v
    }
    out[field] = map
  }
  return out
}

/** connectorPresets:remove input rebuilt as `{ id }`: a kebab-case id of at most 64 characters, else "Unknown connector." Exported for tests. */
export function presetRemoveArgs(input: unknown): ConnectorPresetRemoveInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Unknown connector.')
  const id = (input as Record<string, unknown>).id
  if (typeof id !== 'string' || !CONNECTOR_ID_RE.test(id)) throw new Error('Unknown connector.')
  return { id }
}

/** Longest permission rule accepted over IPC (permissions:add / permissions:remove). */
export const PERMISSION_RULE_MAX_CHARS = 1000

/**
 * Renderer input for permissions:add / permissions:remove rebuilt as `{ projectId, rule }`: both strings, the project
 * id at most 200 chars, the rule trimmed, non-empty and at most PERMISSION_RULE_MAX_CHARS; anything else is refused
 * (review re-check L8). Exported for tests.
 */
export function permissionRuleArgs(input: unknown): { projectId: string; rule: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Project not found')
  const i = input as Record<string, unknown>
  if (typeof i.projectId !== 'string' || !i.projectId || i.projectId.length > 200) throw new Error('Project not found')
  if (typeof i.rule !== 'string') throw new Error('The rule must be text.')
  const rule = i.rule.trim()
  if (!rule) throw new Error('The rule is empty.')
  if (rule.length > PERMISSION_RULE_MAX_CHARS) throw new Error(`The rule is too long (at most ${PERMISSION_RULE_MAX_CHARS} characters).`)
  return { projectId: i.projectId, rule }
}

/**
 * Why permissions:add refuses a rule, or null (reviewer-3 L4): bad grammar, a blanket or ambiguous path rule
 * (ruleSaveRefusal), a destructive or wildcard shell rule (isUnsafeAllowRule) or a shell prefix that grants far more
 * than one command (isTooBroadPrefix: `curl:*`, `docker compose:*`, `npx tsx:*`). Exact shell rules stay allowed
 * unless destructive. Exported for tests.
 */
export function permissionAddRefusal(rule: string): string | null {
  if (!isValidRule(rule)) return 'A rule looks like Tool(prefix:*), Tool(exact command) or a bare tool name, e.g. Bash(npm test:*)'
  const refusal = ruleSaveRefusal(rule)
  if (refusal) return refusal
  return allowRuleRefusal(rule)
}

/** Most secret values one proposal decision may carry, and the longest key / value. */
export const PROPOSAL_SECRETS_MAX = 100
const PROPOSAL_SECRET_KEY_MAX = 300
const PROPOSAL_SECRET_VALUE_MAX = 4000

/**
 * setup:decide input rebuilt field by field: runId and proposalId strings, and a decision of exactly one known
 * behavior. approve: optional `secrets`, a plain object of at most PROPOSAL_SECRETS_MAX non-empty string values
 * (keys at most 300 chars, values at most 4,000); revise: `feedback` text; decline: optional `note` text (both at
 * most PROPOSAL_NOTE_MAX_CHARS). Every other field is dropped and a wrong shape is refused. Exported for tests.
 */
export function proposalDecideArgs(input: unknown): { runId: string; proposalId: string; decision: ProposalDecision } & ExpectedRevision {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Unknown proposal decision.')
  const i = input as Record<string, unknown>
  if (typeof i.runId !== 'string' || !i.runId || i.runId.length > 200) throw new Error('Unknown run.')
  if (typeof i.proposalId !== 'string' || !i.proposalId || i.proposalId.length > 200) throw new Error('Unknown proposal.')
  const d = i.decision
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error('Unknown proposal decision.')
  const dec = d as Record<string, unknown>
  const text = (v: unknown, what: string): string => {
    if (typeof v !== 'string') throw new Error(`The ${what} must be text.`)
    if (v.length > PROPOSAL_NOTE_MAX_CHARS) throw new Error(`The ${what} is too long (at most ${PROPOSAL_NOTE_MAX_CHARS} characters).`)
    return v
  }
  const head = { runId: i.runId, proposalId: i.proposalId, ...expectedRevisionArg(i) }
  if (dec.behavior === 'approve') {
    if (dec.secrets === undefined) return { ...head, decision: { behavior: 'approve' } }
    if (!dec.secrets || typeof dec.secrets !== 'object' || Array.isArray(dec.secrets)) throw new Error('Secrets must be name-value pairs.')
    const entries = Object.entries(dec.secrets as Record<string, unknown>)
    if (entries.length > PROPOSAL_SECRETS_MAX) throw new Error(`At most ${PROPOSAL_SECRETS_MAX} secret values.`)
    const secrets: Record<string, string> = Object.create(null) as Record<string, string>
    for (const [k, v] of entries) {
      if (!k || k.length > PROPOSAL_SECRET_KEY_MAX) throw new Error('Unknown secret slot.')
      if (typeof v !== 'string') throw new Error('A secret value must be text.')
      if (v.length > PROPOSAL_SECRET_VALUE_MAX) throw new Error(`A secret value is too long (at most ${PROPOSAL_SECRET_VALUE_MAX} characters).`)
      if (v) secrets[k] = v
    }
    return { ...head, decision: Object.keys(secrets).length ? { behavior: 'approve', secrets } : { behavior: 'approve' } }
  }
  if (dec.behavior === 'revise') return { ...head, decision: { behavior: 'revise', feedback: text(dec.feedback, 'feedback') } }
  if (dec.behavior === 'decline') {
    if (dec.note === undefined) return { ...head, decision: { behavior: 'decline' } }
    const note = text(dec.note, 'note').trim()
    return { ...head, decision: note ? { behavior: 'decline', note } : { behavior: 'decline' } }
  }
  throw new Error('Unknown proposal decision.')
}


// ---------- Decision cards and run messages (cli-spec 3.3(3): deep validators for channels with no other builder) ----------

/** A refusal of a malformed input: the dispatcher's invokeRpc reports it as `bad_request`. */
export function badInput(message: string): Error {
  return Object.assign(new Error(message), { code: 'bad_request' })
}

/** The optional card revision a decision is bound to (cli-spec 5.3(2)); RunManager answers 'stale-revision' on a mismatch. */
export interface ExpectedRevision {
  expectedRevision?: number
}

/**
 * A decision input's `expectedRevision`: absent when undefined or null, else a non-negative safe integer (anything
 * else is refused as bad_request). Returned as a spreadable object so an absent revision adds no key.
 */
export function expectedRevisionArg(i: Record<string, unknown>): ExpectedRevision {
  const v = i.expectedRevision
  if (v === undefined || v === null) return {}
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw badInput('expectedRevision must be a whole number >= 0.')
  return { expectedRevision: v }
}

/** Longest free text on a decision (a deny message, a question note, an install note). */
export const DECISION_TEXT_MAX_CHARS = 20_000
/** Most labels a question answer may carry (RunManager keeps only the offered ones). */
export const QUESTION_SELECTED_MAX = 200
/** Most secret values an MCP install answer may carry. */
export const INSTALL_SECRETS_MAX = 50
/** Longest run message or prompt (work runs; quick runs are capped by QUICK_RUN_MAX_PROMPT_CHARS in checkQuickContinue). */
export const RUN_MESSAGE_MAX_CHARS = 1_000_000

const isPlain = (v: unknown): v is Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

/** A required id field (run, request, card): text of 1 to 200 characters. */
function refField(i: Record<string, unknown>, key: string, what: string): string {
  const v = i[key]
  if (typeof v !== 'string' || !v || v.length > 200) throw badInput(`Unknown ${what}.`)
  return v
}

/** Optional text: undefined and null are absent; anything else must be text of at most `max`. */
function decisionText(v: unknown, what: string, max = DECISION_TEXT_MAX_CHARS): string | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string') throw badInput(`The ${what} must be text.`)
  if (v.length > max) throw badInput(`The ${what} is too long (at most ${max.toLocaleString('en-US')} characters).`)
  return v
}

function cardInput(input: unknown, what: string): { i: Record<string, unknown>; decision: Record<string, unknown> } {
  if (!isPlain(input)) throw badInput(`Unknown ${what}.`)
  if (!isPlain(input.decision)) throw badInput(`Unknown ${what}.`)
  return { i: input, decision: input.decision }
}

/** runs:decide: { runId, requestId, decision: PermissionDecision }, rebuilt; extra fields dropped. */
export function permissionDecideArgs(input: unknown): { runId: string; requestId: string; decision: PermissionDecision } & ExpectedRevision {
  const { i, decision: d } = cardInput(input, 'permission decision')
  const head = { runId: refField(i, 'runId', 'run'), requestId: refField(i, 'requestId', 'permission request'), ...expectedRevisionArg(i) }
  if (d.behavior === 'allow') {
    if (d.scope === undefined || d.scope === null) return { ...head, decision: { behavior: 'allow' } }
    if (d.scope !== 'once' && d.scope !== 'session' && d.scope !== 'project') throw badInput('Unknown permission scope.')
    return { ...head, decision: { behavior: 'allow', scope: d.scope } }
  }
  if (d.behavior === 'deny') {
    const message = decisionText(d.message, 'message')
    if (message === undefined) throw badInput('A denial needs a message for the agent.')
    return { ...head, decision: { behavior: 'deny', message } }
  }
  throw badInput('Unknown permission decision.')
}

/** permissions:decideRequest: { runId, requestId, decision: PermissionRuleDecision }, rebuilt. */
export function ruleDecideArgs(input: unknown): { runId: string; requestId: string; decision: PermissionRuleDecision } & ExpectedRevision {
  const { i, decision: d } = cardInput(input, 'rule decision')
  const head = { runId: refField(i, 'runId', 'run'), requestId: refField(i, 'requestId', 'rule request'), ...expectedRevisionArg(i) }
  if (d.behavior === 'grant') {
    if (d.scope !== 'run' && d.scope !== 'project') throw badInput('Unknown grant scope.')
    return { ...head, decision: { behavior: 'grant', scope: d.scope } }
  }
  if (d.behavior === 'deny') {
    const message = decisionText(d.message, 'message')
    return { ...head, decision: message === undefined ? { behavior: 'deny' } : { behavior: 'deny', message } }
  }
  throw badInput('Unknown rule decision.')
}

/** merges:decide: { runId, reviewId, decision: MergeDecision }, rebuilt. */
export function mergeDecideArgs(input: unknown): { runId: string; reviewId: string; decision: MergeDecision } & ExpectedRevision {
  const { i, decision: d } = cardInput(input, 'merge decision')
  const head = { runId: refField(i, 'runId', 'run'), reviewId: refField(i, 'reviewId', 'merge review'), ...expectedRevisionArg(i) }
  if (d.behavior === 'merge' || d.behavior === 'discard' || d.behavior === 'hold') return { ...head, decision: { behavior: d.behavior } }
  throw badInput('Unknown merge decision.')
}

/** setup:answer: { runId, questionId, answer: QuestionAnswer }, rebuilt (RunManager keeps only the offered labels). */
export function questionAnswerArgs(input: unknown): { runId: string; questionId: string; answer: QuestionAnswer } & ExpectedRevision {
  if (!isPlain(input) || !isPlain(input.answer)) throw badInput('Unknown answer.')
  const a = input.answer
  const head = { runId: refField(input, 'runId', 'run'), questionId: refField(input, 'questionId', 'question'), ...expectedRevisionArg(input) }
  if (!Array.isArray(a.selected)) throw badInput('The answer must list the chosen options.')
  if (a.selected.length > QUESTION_SELECTED_MAX) throw badInput(`At most ${QUESTION_SELECTED_MAX} options.`)
  if (!a.selected.every((l) => typeof l === 'string')) throw badInput('Every chosen option must be text.')
  const text = decisionText(a.text, 'note')
  return { ...head, answer: text === undefined ? { selected: [...(a.selected as string[])] } : { selected: [...(a.selected as string[])], text } }
}

/**
 * mcp:answerInstall: { runId, requestId, decision: McpInstallDecision }, rebuilt by type. RunManager.settleInstall
 * still decides what an approval may change (the edited spec is allowlisted onto the request there).
 */
export function installAnswerArgs(input: unknown): McpAnswerInstallInput & ExpectedRevision {
  const { i, decision: d } = cardInput(input, 'install answer')
  const head = { runId: refField(i, 'runId', 'run'), requestId: refField(i, 'requestId', 'install request'), ...expectedRevisionArg(i) }
  if (typeof d.approved !== 'boolean') throw badInput('An install answer must say whether it is approved.')
  let scope: McpInstallDecision['scope'] = 'run'
  if (d.scope !== undefined && d.scope !== null) {
    if (d.scope !== 'run' && d.scope !== 'project' && d.scope !== 'library') throw badInput('Unknown install scope.')
    scope = d.scope
  }
  const decision: McpInstallDecision = { approved: d.approved, scope }
  const note = decisionText(d.note, 'note')
  if (note !== undefined) decision.note = note
  if (d.secrets !== undefined && d.secrets !== null) {
    if (!isPlain(d.secrets)) throw badInput('Secrets must be name-value pairs.')
    const entries = Object.entries(d.secrets)
    if (entries.length > INSTALL_SECRETS_MAX) throw badInput(`At most ${INSTALL_SECRETS_MAX} secret values.`)
    const secrets: Record<string, string> = Object.create(null) as Record<string, string>
    for (const [k, v] of entries) {
      if (!k || k.length > 200) throw badInput('Unknown secret slot.')
      if (typeof v !== 'string' || v.length > 4_000) throw badInput('A secret value must be text of at most 4,000 characters.')
      secrets[k] = v
    }
    decision.secrets = secrets
  }
  if (d.spec !== undefined && d.spec !== null) {
    if (!isPlain(d.spec)) throw badInput('The edited server must be an object.')
    decision.spec = d.spec as unknown as McpServerSpec
  }
  return { ...head, decision }
}

/** A run message's text and images: text (may be empty when images come along), images an array or absent. */
function messageParts(text: unknown, images: unknown, what: string): { text: string; images?: ImageAttachment[] } {
  if (typeof text !== 'string') throw badInput(`The ${what} must be text.`)
  if (text.length > RUN_MESSAGE_MAX_CHARS) throw badInput(`The ${what} is too long.`)
  if (images === undefined || images === null) return { text }
  // Items are checked (type, size, count) by RunManager's sanitizeImages; here only the container.
  if (!Array.isArray(images)) throw badInput('Images must be a list.')
  return { text, images: images as ImageAttachment[] }
}

/** runs:start: { projectId, prompt, scaffold?, images?, team? }, rebuilt; team only 'single'. */
export function startRunArgs(input: unknown): StartRunInput {
  if (!isPlain(input)) throw badInput('Unknown run input.')
  if (!isValidId(input.projectId)) throw badInput('Project not found')
  const { text, images } = messageParts(input.prompt, input.images, 'prompt')
  if (input.scaffold !== undefined && input.scaffold !== null && typeof input.scaffold !== 'boolean') throw badInput('scaffold must be true or false.')
  const overrides: RunOverrides | undefined = runOverridesArgs(input.overrides)
  return {
    projectId: input.projectId,
    prompt: text,
    ...(input.scaffold === true ? { scaffold: true } : {}),
    ...(images ? { images } : {}),
    ...(input.team === 'single' ? { team: 'single' as const } : {}),
    ...(overrides ? { overrides } : {})
  }
}

/** runs:send: { runId, text, images? }, rebuilt; every other field (overrides, exec included) is dropped. */
export function runMessageArgs(input: unknown): SendRunInput {
  if (!isPlain(input)) throw badInput('Unknown run message.')
  const runId = refField(input, 'runId', 'run')
  const { text, images } = messageParts(input.text, input.images, 'message')
  return { runId, text, ...(images ? { images } : {}) }
}

/**
 * runs:continue: runMessageArgs plus the headless fields (cli-spec 6.2(1)): `overrides` strictly through
 * runOverridesArgs and `exec` only as a literal boolean (anything else but undefined / null is bad_request). The
 * dispatcher drops both on the desktop surface. A decisionPolicy keeps only the fields the client gave: RunManager
 * merges them over the chain's policy (continuedOverrides) and fills the rest with the defaults.
 */
export function continueRunArgs(input: unknown): ContinueRunInput {
  const base = runMessageArgs(input)
  const i = input as Record<string, unknown>
  const overrides = runOverridesArgs(i.overrides, { partialPolicy: true })
  if (i.exec !== undefined && i.exec !== null && typeof i.exec !== 'boolean') throw badInput('exec must be true or false.')
  return { ...base, ...(overrides ? { overrides } : {}), ...(typeof i.exec === 'boolean' ? { exec: i.exec } : {}) }
}
