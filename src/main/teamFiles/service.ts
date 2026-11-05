import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  SKILL_MAX_PER_PROJECT,
  TEAM_FILES_AGENTS_DIR,
  TEAM_FILES_JSON,
  TEAM_FILES_LIST_MAX,
  TEAM_FILES_MAX_ROLES,
  TEAM_FILES_MCP_JSON,
  TEAM_FILES_SKILLS_DIR,
  isVirtualProjectId,
  type ConnectionId,
  type McpLibraryEntry,
  type McpServerSpec,
  type Project,
  type ProjectPathCheck,
  type SkillSpec,
  type TeamFileProblem,
  type TeamFilesActionResult,
  type TeamFilesCommitResult,
  type TeamFilesFound,
  type TeamFilesOffReason,
  type TeamFilesStatus
} from '@shared/types'
import { linkedSpec, modelForTier, newId, projectConnection, projectKindOf, writesToProjectFolder, type TierContext } from '@shared/defaults'
import { reviewTarget } from '../capabilities/sanitize'
import { assertValidSpec } from '../mcp/validate'
import { serverSignature } from '../kit/format'
import { commitPaths, pathKey, teamFilesStatusGit } from '../runtime/worktrees'
import { digestFiles, fileInfos, type FileData } from '../skills/files'
import { parseSkillMd, normalizeDescription } from '../skills/skillMd'
import { cleanProjectPath, type ProjectStore } from '../store/projects'
import { maskKeyLike } from '../runtime/codexAppServer'
import { mcpSpecFromDoc, rolesFromDoc, settingsFromDoc, teamKey, docFromProject, type DocFromProject } from './project'
import type { TeamDoc, TeamFile, TeamMcpDoc, TeamSkillDoc, TeamSkillFileDoc } from './doc'
import { canonicalJson, normalizeText } from './digest'
import { applyTeamDelta, sameTeam } from './delta'
import { describeChanges, gateTeam } from './gate'
import { parseTeamFiles, skillScripts, type ParsedTeam } from './parse'
import { serializeMcpJson, serializeRole, serializeSkill, serializeTeam, serializeTeamJson } from './serialize'
import { readTeamFolder, teamFilesStampOf, writeTeamFiles, type TeamFolderRead } from './disk'
import { TeamFilesStore, type TeamFilesState } from './store'

/**
 * Team files: the service between the project cache, the approved snapshot and the `.orgai/` folder (design: ARCHITECTURE.md
 * "Team files"). The pure core decides (parse, gate, delta, project mapping); this file does the I/O and the bookkeeping.
 * Synchronous except `commit` and the git status (`withGit`). Repository content is untrusted: nothing is applied to the
 * cache or the runs except through the gate, and nothing here follows a link.
 */

export const STALE_MESSAGE = 'The team files changed since you looked. Review them again.'
const PENDING_WARNING = 'This run uses the last approved team: the team files in the folder have changes waiting for your approval.'
const COMMIT_MESSAGE = 'Update OrgAI team files'
const ELEVATED = ['Bash', 'Edit', 'Write', 'NotebookEdit']
const GENERATIONS_KEPT = 4

export interface TeamFilesDeps {
  /** OrgAI's data dir. */
  dataDir: string
  projects: ProjectStore
  /** The connection's tier mapping (ConnectionService.importModelContext). Missing: the builtin catalog. */
  modelContext?(connection: ConnectionId): TierContext
  /** Keep provider.id on the adapter the models need (ConnectionService.withAdapter). */
  withAdapter?(project: Project): Project
  skills: {
    readFiles(projectId: string, spec: SkillSpec): FileData[] | null
    storeFiles(projectId: string, skillId: string, files: FileData[]): void
    removeFiles(projectId: string, skillId: string): void
  }
  mcp: {
    libraryEntries(): McpLibraryEntry[]
    /** The library entry of a catalog connector, added when there is none; undefined when it cannot be linked. */
    connectorEntry(connectorId: string, variant?: string): McpLibraryEntry | undefined
    removeServerSecrets(projectId: string, serverId: string): void
  }
  /** A project's status changed (index.ts: teamFiles:changed to every window). */
  broadcastStatus?(status: TeamFilesStatus): void
  /** A project changed because the files did (index.ts: a project.updated event). */
  broadcastProject?(project: Project): void
  now?(): number
  warn?(message: string): void
}

interface Applied {
  project: Project
  commit(): void
  rollback(): void
}

interface Generation {
  updatedAt: string
  doc: TeamDoc
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
const unique = (list: string[]): string[] => [...new Set(list)]
const cap = <T>(list: T[], n = TEAM_FILES_LIST_MAX): T[] => (list.length > n ? list.slice(0, n) : list)
const isHeldPath = (path: string, held: readonly string[]): boolean => held.some((h) => path === h || path.startsWith(`${h}/`) || h.startsWith(`${path}/`))
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

function firstLine(text: string): string {
  return (text.split(/\r?\n/).find((l) => l.trim()) ?? '').trim().slice(0, 300)
}

function toDocFile(f: FileData): TeamSkillFileDoc {
  if (!f.data.includes(0)) {
    try {
      return { path: f.path, text: normalizeText(new TextDecoder('utf-8', { fatal: true }).decode(f.data)) }
    } catch {
      /* not text */
    }
  }
  return { path: f.path, base64: f.data.toString('base64') }
}

/** The comparable content of a stored skill folder: description, body and files (SKILL.md left out). Null without SKILL.md. */
function contentOf(files: FileData[]): { description: string; body: string; files: TeamSkillFileDoc[] } | null {
  const md = files.find((f) => f.path === 'SKILL.md')
  if (!md) return null
  const p = parseSkillMd(md.data.toString('utf8'))
  return {
    description: typeof p.description === 'string' ? normalizeDescription(p.description) : '',
    body: normalizeText(p.body).trim(),
    files: files.filter((f) => f.path !== 'SKILL.md').map(toDocFile).sort((a, b) => cmp(a.path, b.path))
  }
}

/** A skill document as the stored folder (SKILL.md and files, folder-relative paths). */
function skillFileData(s: TeamSkillDoc): FileData[] {
  const prefix = `${TEAM_FILES_SKILLS_DIR}/${s.name}/`
  return serializeSkill(s).map((f) => ({ path: f.path.slice(prefix.length), data: f.data }))
}

function sameSkillContent(files: FileData[], d: TeamSkillDoc): boolean {
  const c = contentOf(files)
  return !!c && c.description === d.description && c.body === d.body && canonicalJson(c.files) === canonicalJson([...d.files].sort((a, b) => cmp(a.path, b.path)))
}

// ---------- what to write ----------

export interface WritePlan {
  write: TeamFile[]
  remove: string[]
}

/**
 * The files that must change to turn `diskDoc` (what the folder says) into `newDisk`. An item is rewritten only when its
 * parsed content differs or its file is missing, so a CRLF checkout or a hand-formatted file of equal content is left
 * alone. Removals are only for items `diskDoc` had and `newDisk` does not.
 */
export function planTeamWrite(existingPaths: ReadonlySet<string>, diskDoc: TeamDoc, newDisk: TeamDoc): WritePlan {
  const write: TeamFile[] = []
  const remove: string[] = []
  const buf = (s: string): Buffer => Buffer.from(s, 'utf8')
  const teamNew = serializeTeamJson(newDisk)
  if (!existingPaths.has(TEAM_FILES_JSON) || serializeTeamJson(diskDoc) !== teamNew) write.push({ path: TEAM_FILES_JSON, data: buf(teamNew) })
  const oldRoles = new Map(diskDoc.roles.map((r) => [r.slug, r]))
  for (const r of newDisk.roles) {
    const path = `${TEAM_FILES_AGENTS_DIR}/${r.slug}.md`
    const old = oldRoles.get(r.slug)
    const text = serializeRole(r)
    if (!existingPaths.has(path) || !old || serializeRole(old) !== text) write.push({ path, data: buf(text) })
  }
  const newSlugs = new Set(newDisk.roles.map((r) => r.slug))
  for (const r of diskDoc.roles) {
    const path = `${TEAM_FILES_AGENTS_DIR}/${r.slug}.md`
    if (!newSlugs.has(r.slug) && existingPaths.has(path)) remove.push(path)
  }
  const mcpNew = serializeMcpJson(newDisk.mcp)
  const mcpOld = serializeMcpJson(diskDoc.mcp)
  if (mcpNew !== null) {
    if (!existingPaths.has(TEAM_FILES_MCP_JSON) || mcpOld !== mcpNew) write.push({ path: TEAM_FILES_MCP_JSON, data: buf(mcpNew) })
  } else if (mcpOld !== null && existingPaths.has(TEAM_FILES_MCP_JSON)) remove.push(TEAM_FILES_MCP_JSON)
  const oldSkills = new Map(diskDoc.skills.map((s) => [s.name, s]))
  const skillSig = (s: TeamSkillDoc): string => serializeSkill(s).map((f) => `${f.path}\0${f.data.toString('base64')}`).join('\n')
  for (const s of newDisk.skills) {
    const old = oldSkills.get(s.name)
    const files = serializeSkill(s)
    if (!old || skillSig(old) !== skillSig(s) || files.some((f) => !existingPaths.has(f.path))) write.push(...files)
  }
  const newNames = new Set(newDisk.skills.map((s) => s.name))
  for (const s of diskDoc.skills) if (!newNames.has(s.name)) remove.push(`${TEAM_FILES_SKILLS_DIR}/${s.name}`)
  return { write, remove }
}

export class TeamFilesService {
  private store: TeamFilesStore
  private memo = new Map<string, { key: string; status: TeamFilesStatus }>()
  private versions = new Map<string, number>()
  private docMemo = new Map<string, { key: string; result: DocFromProject }>()
  private generations = new Map<string, Generation[]>()
  private inHook = new Set<string>()
  private lastBroadcast = new Map<string, string>()
  private adoptions = new Map<string, TeamDoc>()
  private lastFocusCheck = 0

  constructor(private deps: TeamFilesDeps) {
    this.store = new TeamFilesStore(deps.dataDir)
  }

  // ---------- small helpers ----------

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  private warn(message: string): void {
    if (this.deps.warn) this.deps.warn(message)
    else console.warn(`Team files: ${message}`)
  }

  private nowIso(): string {
    return new Date(this.now()).toISOString()
  }

  private bump(projectId: string): void {
    this.versions.set(projectId, (this.versions.get(projectId) ?? 0) + 1)
    this.memo.delete(projectId)
  }

  private stored(projectId: string): Project {
    const p = this.deps.projects.get(projectId)
    if (!p || isVirtualProjectId(projectId)) throw new Error('Project not found')
    return p
  }

  private skillContent(projectId: string, spec: SkillSpec): { body: string; files: TeamSkillFileDoc[] } | null {
    const files = this.deps.skills.readFiles(projectId, spec)
    if (!files) return null
    const c = contentOf(files)
    return c ? { body: c.body, files: c.files } : null
  }

  /** The project as a document (memoized on what the files hold). */
  private docOf(project: Project): DocFromProject {
    const key = teamKey(project)
    const hit = this.docMemo.get(project.id)
    if (hit && hit.key === key) return hit.result
    const result = docFromProject(project, (spec) => this.skillContent(project.id, spec))
    this.docMemo.set(project.id, { key, result })
    return result
  }

  private recordGeneration(project: Project): void {
    const list = this.generations.get(project.id) ?? []
    list.push({ updatedAt: project.updatedAt, doc: this.docOf(project).doc })
    this.generations.set(project.id, list.slice(-GENERATIONS_KEPT))
  }

  private skeleton(project: Project): TeamFilesStatus {
    return {
      projectId: project.id,
      projectName: project.name,
      state: 'in-sync',
      isGitRepo: !!project.path && existsSync(join(project.path, '.git')),
      uncommitted: false,
      uncommittedFiles: [],
      changes: [],
      applied: [],
      problems: [],
      notes: [],
      warnings: []
    }
  }

  private off(project: Project, reason: TeamFilesOffReason, sharedWith?: Project): TeamFilesStatus {
    const s = this.skeleton(project)
    s.state = 'off'
    s.offReason = reason
    if (sharedWith) s.sharedWith = { projectId: sharedWith.id, projectName: sharedWith.name }
    return s
  }

  /** The project that owns this folder's team files: the oldest code project with the folder (createdAt, then id). */
  private ownerOf(project: Project): Project {
    let key: string
    try {
      key = pathKey(project.path)
    } catch {
      return project
    }
    const same = this.deps.projects
      .list()
      .filter((p) => !isVirtualProjectId(p.id) && writesToProjectFolder(p) && !!p.path)
      .filter((p) => {
        try {
          return pathKey(p.path) === key
        } catch {
          return false
        }
      })
    same.sort((a, b) => cmp(a.createdAt, b.createdAt) || cmp(a.id, b.id))
    return same[0] ?? project
  }

  /** Why team files do not apply to this project, or null when they do. */
  private offState(project: Project): TeamFilesStatus | null {
    if (isVirtualProjectId(project.id)) return this.off(project, 'virtual')
    if (!writesToProjectFolder(project)) return this.off(project, 'engagement')
    if (!project.path || !existsSync(project.path)) return this.off(project, 'no-folder')
    const owner = this.ownerOf(project)
    if (owner.id !== project.id) return this.off(project, 'shared-folder', owner)
    if (this.store.readState(project.id).removed) return this.off(project, 'removed')
    return null
  }

  /** Whether team files read and write for this stored project. */
  applies(project: Project): boolean {
    try {
      return !!this.deps.projects.get(project.id) && this.offState(project) === null
    } catch {
      return false
    }
  }

  private tierContext(project: Project): TierContext | undefined {
    try {
      return this.deps.modelContext?.(projectConnection(project))
    } catch {
      return undefined
    }
  }

  // ---------- applying a document to the cache ----------

  private serverFor(d: TeamMcpDoc, x: McpServerSpec | undefined, lib: McpLibraryEntry[], nowIso: string): McpServerSpec {
    const link = (entry: McpLibraryEntry): McpServerSpec => {
      const keep = x && x.libraryId === entry.id ? x : undefined
      return linkedSpec(entry, {
        id: keep?.id ?? newId('mcp'),
        enabled: d.enabled,
        ...(d.roles ? { roles: d.roles } : {}),
        addedAt: keep?.addedAt ?? nowIso,
        ...(keep?.envOverrides ? { envOverrides: keep.envOverrides } : {}),
        ...(keep?.headerOverrides ? { headerOverrides: keep.headerOverrides } : {})
      })
    }
    if (d.connectorId) {
      // The library entry's definition wins; the file's url is never used for a catalog connector.
      let entry = lib.find((e) => e.connectorId === d.connectorId && e.connectorCustom !== true && e.name === d.name && (d.connectorVariant === undefined || e.connectorVariant === d.connectorVariant))
      if (!entry) {
        try {
          entry = this.deps.mcp.connectorEntry(d.connectorId, d.connectorVariant)
        } catch {
          entry = undefined
        }
        if (entry && entry.name !== d.name) entry = undefined
      }
      if (entry) return link(entry)
    } else if (d.fromLibrary) {
      const sig = serverSignature({ name: d.name, transport: d.transport, command: d.command, args: d.args, url: d.url, env: d.env, headers: d.headers, secretEnv: d.secretEnv, secretHeaders: d.secretHeaders, description: d.description } as Parameters<typeof serverSignature>[0])
      const entry = lib.find((e) => e.name === d.name && !e.connectorId && serverSignature(e as unknown as Parameters<typeof serverSignature>[0]) === sig)
      if (entry) return link(entry)
    }
    // A project-only copy. The same target, env and headers keep the server's id (and so its stored secrets); anything
    // else is a new server, so a pulled change of url or command never carries this computer's secrets to a new target.
    const same: McpServerSpec | undefined = x && !x.libraryId ? { ...x, secretEnv: d.secretEnv, secretHeaders: d.secretHeaders } : undefined
    const spec = mcpSpecFromDoc(d, same, newId('mcp'), nowIso)
    delete spec.connectorId
    delete spec.connectorVariant
    return spec
  }

  /**
   * The project with the team of `doc` applied: skills (files stored first), servers (library links where the file names
   * one), roles (ids kept per slug) and settings. Items the project holds but its own document cannot carry (a server
   * refused by the credential checks, a built server, an unreadable skill) survive with their grants. Nothing is saved:
   * `commit()` after the caller's save does the irreversible cleanup (secrets of replaced servers, removed skill files),
   * `rollback()` undoes the stored skill files. Throws (after rolling back) when the document cannot be applied.
   */
  private applyDoc(project: Project, doc: TeamDoc): Applied {
    const undo: Array<() => void> = []
    const after: Array<() => void> = []
    const rollback = (): void => {
      for (const f of undo.reverse()) {
        try {
          f()
        } catch {
          /* best effort */
        }
      }
    }
    try {
      const current = this.docOf(project).doc
      const nowIso = this.nowIso()
      const projectId = project.id

      // --- skills
      const existingSkills = project.skills ?? []
      const skillNamesNow = new Set(current.skills.map((s) => s.name))
      const localSkills = existingSkills.filter((s) => !skillNamesNow.has(s.name))
      const skillByName = new Map(existingSkills.filter((s) => skillNamesNow.has(s.name)).map((s) => [s.name, s]))
      const skills: SkillSpec[] = []
      const skillIdByName = new Map<string, string>()
      for (const d of doc.skills) {
        if (localSkills.some((s) => s.name === d.name)) continue
        if (skills.length + localSkills.length >= SKILL_MAX_PER_PROJECT) throw new Error(`A project has at most ${SKILL_MAX_PER_PROJECT} skills.`)
        const x = skillByName.get(d.name)
        const files = skillFileData(d)
        let spec: SkillSpec
        const stored = (id: string): { digest: string; files: SkillSpec['files'] } => ({ digest: digestFiles(files), files: fileInfos(files) })
        if (x) {
          const cur = this.deps.skills.readFiles(projectId, x)
          if (cur && sameSkillContent(cur, d)) spec = { ...x, description: d.description, enabled: d.enabled }
          else if (x.libraryId) {
            // A changed file for a linked skill: the link is dropped and the file's copy is the project's own.
            this.deps.skills.storeFiles(projectId, x.id, files)
            undo.push(() => this.deps.skills.removeFiles(projectId, x.id))
            const { libraryId: _l, ...rest } = x
            void _l
            spec = { ...rest, description: d.description, enabled: d.enabled, source: 'repo', repoPath: `${TEAM_FILES_SKILLS_DIR}/${d.name}`, ...stored(x.id), updatedAt: nowIso }
          } else {
            this.deps.skills.storeFiles(projectId, x.id, files)
            undo.push(() => (cur ? this.deps.skills.storeFiles(projectId, x.id, cur) : this.deps.skills.removeFiles(projectId, x.id)))
            spec = { ...x, description: d.description, enabled: d.enabled, ...stored(x.id), updatedAt: nowIso }
          }
        } else {
          const id = newId('skill')
          this.deps.skills.storeFiles(projectId, id, files)
          undo.push(() => this.deps.skills.removeFiles(projectId, id))
          spec = { id, name: d.name, description: d.description, enabled: d.enabled, source: 'repo', repoPath: `${TEAM_FILES_SKILLS_DIR}/${d.name}`, ...stored(id), addedAt: nowIso, updatedAt: nowIso }
        }
        skills.push(spec)
        skillIdByName.set(d.name, spec.id)
      }
      const docSkillNames = new Set(doc.skills.map((s) => s.name))
      for (const [name, x] of skillByName) if (!docSkillNames.has(name) && !x.libraryId) after.push(() => this.deps.skills.removeFiles(projectId, x.id))

      // --- servers
      const lib = this.deps.mcp.libraryEntries()
      const existingServers = project.mcpServers ?? []
      const serverNamesNow = new Set(current.mcp.map((m) => m.name))
      const localServers = existingServers.filter((s) => !serverNamesNow.has(s.name))
      const serverByName = new Map(existingServers.filter((s) => serverNamesNow.has(s.name)).map((s) => [s.name, s]))
      const servers: McpServerSpec[] = []
      const serverIdByName = new Map<string, string>()
      for (const d of doc.mcp) {
        if (localServers.some((s) => s.name === d.name)) continue
        const x = serverByName.get(d.name)
        const spec = this.serverFor(d, x, lib, nowIso)
        if (!spec.libraryId) assertValidSpec(spec, [...localServers, ...servers])
        servers.push(spec)
        serverIdByName.set(d.name, spec.id)
        if (x && x.id !== spec.id) after.push(() => this.deps.mcp.removeServerSecrets(projectId, x.id))
      }
      const docServerNames = new Set(doc.mcp.map((m) => m.name))
      for (const [name, x] of serverByName) if (!docServerNames.has(name)) after.push(() => this.deps.mcp.removeServerSecrets(projectId, x.id))

      // --- roles and settings
      const base: Project = { ...project, skills: [...skills, ...localSkills], mcpServers: [...servers, ...localServers] }
      if (!base.skills?.length) delete base.skills
      if (!base.mcpServers?.length) delete base.mcpServers
      const tiers = this.tierContext(project)
      const localSkillIds = new Set(localSkills.map((s) => s.id))
      const roles = rolesFromDoc(base, doc, {
        tierModel: (tier) => (tiers ? modelForTier(tier, tiers)?.model : undefined),
        serverId: (name) => serverIdByName.get(name),
        skillId: (name) => skillIdByName.get(name),
        keepServerIds: localServers.map((s) => s.id)
      })
      const prior = new Map((project.roles ?? []).map((r) => [r.id, r]))
      for (const r of roles) {
        const keep = (prior.get(r.id)?.skills ?? []).filter((id) => localSkillIds.has(id))
        if (keep.length) r.skills = unique([...(r.skills ?? []), ...keep])
      }
      let next = settingsFromDoc({ ...base, roles }, doc)
      if (this.deps.withAdapter) next = this.deps.withAdapter(next)
      return {
        project: next,
        commit: () => {
          for (const f of after) {
            try {
              f()
            } catch (e) {
              this.warn(`cleanup after applying the team failed: ${e instanceof Error ? e.message : String(e)}`)
            }
          }
        },
        rollback
      }
    } catch (e) {
      rollback()
      throw e
    }
  }

  /** applyDoc, saved without the hook; rolls the skill files back when the save throws. */
  private applyAndSave(project: Project, doc: TeamDoc): Project {
    const ap = this.applyDoc(project, doc)
    let saved: Project
    try {
      saved = this.deps.projects.saveInternal(ap.project)
    } catch (e) {
      ap.rollback()
      throw e
    }
    ap.commit()
    this.deps.broadcastProject?.(saved)
    return saved
  }

  // ---------- reading the folder ----------

  private load(folder: string, base: TeamDoc | null): { read: TeamFolderRead; parsed: ParsedTeam } {
    const read = readTeamFolder(folder)
    const parsed = parseTeamFiles(read.files, { base, agentsDirExists: read.agentsDirExists, readProblems: read.readProblems })
    return { read, parsed }
  }

  /**
   * Writes the delta (beforeDoc to afterDoc) onto what the folder says now. Returns ok false when a file that should have
   * been written could not be (a held path is not a failure); `st` gets lastKnownDigest and rejectedDigest updated.
   */
  private writeDisk(folder: string, base: TeamDoc, beforeDoc: TeamDoc, afterDoc: TeamDoc, st: TeamFilesState): { ok: boolean; written: string[] } {
    const { read, parsed } = this.load(folder, base)
    if (!read.orgaiOk) return { ok: false, written: [] }
    const diskDoc = parsed.doc ?? base
    const newDisk = applyTeamDelta(diskDoc, beforeDoc, afterDoc)
    const plan = planTeamWrite(new Set(read.files.map((f) => f.path)), diskDoc, newDisk)
    if (!plan.write.length && !plan.remove.length) {
      if (parsed.digest) st.lastKnownDigest = parsed.digest
      return { ok: true, written: [] }
    }
    const res = writeTeamFiles(folder, plan.write, plan.remove, parsed.heldPaths)
    const failed = res.skipped.filter((p) => !isHeldPath(p, parsed.heldPaths))
    const reparsed = this.load(folder, base).parsed
    if (st.rejectedDigest && st.rejectedDigest === parsed.digest && reparsed.digest) st.rejectedDigest = reparsed.digest
    if (reparsed.digest) st.lastKnownDigest = reparsed.digest
    return { ok: failed.length === 0, written: [...res.written, ...res.removed] }
  }

  // ---------- check ----------

  /**
   * Looks at the folder and brings the cache, the approved snapshot and the status up to date. `firstWrite` lets a project
   * whose folder has no team files yet get them written once (project open, run start); every other caller (window focus,
   * attention list) never writes a file. Changes the gate allows are applied at once; the rest wait for approval.
   */
  check(projectId: string, opts: { firstWrite?: boolean } = {}): TeamFilesStatus {
    const project = this.stored(projectId)
    const off = this.offState(project)
    if (off) return off
    const keyOf = (p: Project): string => `${teamFilesStampOf(p.path)}|${p.updatedAt}|${p.path}|${this.versions.get(projectId) ?? 0}`
    const hit = this.memo.get(projectId)
    if (hit && hit.key === keyOf(project) && !(opts.firstWrite && hit.status.offReason === 'not-written')) return hit.status
    let status: TeamFilesStatus
    try {
      status = this.evaluate(project, opts)
    } catch (e) {
      this.warn(`could not check ${projectId}: ${e instanceof Error ? e.message : String(e)}`)
      status = this.skeleton(project)
      status.state = 'problem'
      status.problems = [{ file: '.orgai', message: 'The team files could not be checked. The last approved team stays.' }]
    }
    const after = this.deps.projects.get(projectId) ?? project
    this.memo.set(projectId, { key: keyOf(after), status })
    return status
  }

  private problemStatus(project: Project, problems: TeamFileProblem[], st: TeamFilesState, notes: string[] = [], warnings: TeamFilesStatus['warnings'] = []): TeamFilesStatus {
    const s = this.skeleton(project)
    s.state = 'problem'
    s.problems = cap(problems)
    s.notes = cap(notes)
    s.warnings = cap(warnings)
    if (st.applied?.length) s.applied = cap(st.applied)
    if (st.undo) s.undo = st.undo
    if (st.lastUndo) s.lastUndo = st.lastUndo
    return s
  }

  private evaluate(project: Project, opts: { firstWrite?: boolean }): TeamFilesStatus {
    const id = project.id
    const folder = project.path
    let st = this.store.readState(id)
    let approved = this.store.readApproved(id)
    let { read, parsed } = this.load(folder, approved)
    const d = this.docOf(project)
    const blockedProblem: TeamFileProblem[] = d.blocked ? [{ file: '.orgai', message: d.blocked }] : []
    const notes = (): string[] => [...d.notes, ...parsed.notes]
    const warnings = (): TeamFilesStatus['warnings'] => [...d.warnings, ...parsed.warnings]

    if (!read.orgaiOk) return this.problemStatus(project, read.readProblems, st, notes(), warnings())

    // No snapshot yet.
    if (!approved) {
      if (!parsed.present) {
        const anything = read.files.length > 0 || read.agentsDirExists || read.readProblems.length > 0
        if (anything) return this.problemStatus(project, [...parsed.problems, ...blockedProblem], st, notes(), warnings())
        if (!opts.firstWrite) return this.off(project, 'not-written')
        if (d.blocked) return this.problemStatus(project, blockedProblem, st, notes(), warnings())
        const res = writeTeamFiles(folder, serializeTeam(d.doc), [], [])
        if (res.skipped.length) return this.problemStatus(project, [{ file: res.skipped[0], message: 'It could not be written.' }], st, notes(), warnings())
        approved = d.doc
        this.store.writeApproved(id, approved)
        st = { ...st, migrated: true }
        ;({ read, parsed } = this.load(folder, approved))
        if (parsed.digest) st.lastKnownDigest = parsed.digest
        delete st.firstSeen
        this.store.writeState(id, st)
        this.bump(id)
        const s = this.skeleton(project)
        s.notes = cap(notes())
        s.warnings = cap(warnings())
        s.problems = cap([...parsed.problems, ...blockedProblem])
        if (s.problems.length) s.state = 'problem'
        if (parsed.digest) s.digest = parsed.digest
        return s
      }
      if (!parsed.doc) return this.problemStatus(project, [...parsed.problems, ...blockedProblem], st, notes(), warnings())
      // Files from elsewhere and nothing approved here: the cache is the baseline and every difference waits.
      approved = d.doc
      this.store.writeApproved(id, approved)
      st = { ...st, migrated: true, firstSeen: true }
      this.store.writeState(id, st)
      this.bump(id)
    }

    // A write that failed earlier is retried while the folder can take it.
    if (st.dirtyBefore && !d.blocked && read.orgaiOk) {
      const w = this.writeDisk(folder, approved, st.dirtyBefore, d.doc, st)
      if (w.ok) {
        delete st.dirtyBefore
        this.store.writeState(id, st)
      }
      ;({ read, parsed } = this.load(folder, approved))
    }

    if (!parsed.doc) return this.problemStatus(project, [...parsed.problems, ...blockedProblem], st, notes(), warnings())

    const firstSeen = st.firstSeen === true
    const g = gateTeam(approved, parsed.doc, { firstSeen })
    let current = project
    if (!sameTeam(g.effective, approved)) {
      // What the gate lets through is applied now; the previous team stays one Undo away.
      this.recordGeneration(project)
      try {
        current = this.applyAndSave(project, g.effective)
      } catch (e) {
        this.warn(`could not apply the team files of ${id}: ${e instanceof Error ? e.message : String(e)}`)
        return this.problemStatus(project, [{ file: '.orgai', message: 'The team in the files could not be applied. The last approved team stays.' }], st, notes(), warnings())
      }
      const files = unique(g.applied.map((c) => c.file))
      this.store.writeUndo(id, approved)
      this.store.writeApproved(id, g.effective)
      st.undo = { at: this.nowIso(), label: `Undo the ${plural(g.applied.length, 'change', 'changes')} applied from the files`, files: cap(files) }
      st.applied = cap(g.applied)
      approved = g.effective
    }
    st.lastKnownDigest = parsed.digest
    if (!g.pending.length) delete st.firstSeen
    this.store.writeState(id, st)
    this.bump(id)

    const s = this.skeleton(current)
    s.problems = cap([...parsed.problems, ...blockedProblem])
    s.changes = cap(g.pending)
    s.applied = cap(st.applied ?? [])
    s.notes = cap(notes())
    s.warnings = cap(warnings())
    s.digest = parsed.digest
    if (g.pending.length && firstSeen) s.firstSeen = true
    if (s.problems.length) s.state = 'problem'
    else if (g.pending.length) s.state = st.rejectedDigest && st.rejectedDigest === parsed.digest ? 'rejected' : 'pending'
    else s.state = 'in-sync'
    if (st.undo) s.undo = st.undo
    if (st.lastUndo) s.lastUndo = st.lastUndo
    return s
  }

  // ---------- statuses for the app ----------

  /** teamFiles:status: checks the folder (writing a code project's files the first time) and broadcasts a change. */
  status(projectId: string): TeamFilesStatus {
    const s = this.check(projectId, { firstWrite: true })
    this.broadcastIfChanged(s)
    return s
  }

  private key(s: TeamFilesStatus): string {
    return JSON.stringify(s)
  }

  private broadcastIfChanged(status: TeamFilesStatus): void {
    const key = this.key(status)
    if (this.lastBroadcast.get(status.projectId) === key) return
    this.lastBroadcast.set(status.projectId, key)
    try {
      this.deps.broadcastStatus?.(status)
    } catch (e) {
      this.warn(`broadcast failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /** The status with git's view of the team files filled in (the only async part of a status). */
  async withGit(status: TeamFilesStatus): Promise<TeamFilesStatus> {
    if (!status.isGitRepo || status.state === 'off') return status
    try {
      const project = this.deps.projects.get(status.projectId)
      if (!project) return status
      const g = await teamFilesStatusGit(project.path)
      if (!g.ok) return { ...status, isGitRepo: false }
      return { ...status, uncommitted: g.files.length > 0, uncommittedFiles: cap(g.files) }
    } catch {
      return status
    }
  }

  /** teamFiles:listAttention: every applicable project with state 'pending' or 'problem'. Reads only: no first write. */
  listAttention(): TeamFilesStatus[] {
    const out: TeamFilesStatus[] = []
    for (const p of this.deps.projects.list()) {
      try {
        if (isVirtualProjectId(p.id)) continue
        const s = this.check(p.id, { firstWrite: false })
        if (s.state === 'pending' || s.state === 'problem') out.push(s)
      } catch {
        /* one project never hides the others */
      }
    }
    return out
  }

  /** Boot and window focus: check every applicable project (no first write) and broadcast the ones whose status changed. */
  async checkAll(): Promise<void> {
    for (const p of this.deps.projects.list()) {
      try {
        if (isVirtualProjectId(p.id) || !writesToProjectFolder(p)) continue
        const s = await this.withGit(this.check(p.id, { firstWrite: false }))
        this.broadcastIfChanged(s)
      } catch (e) {
        this.warn(`check of ${p.id} failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }

  /** Window focus, at most once per `minMs` (2 s). */
  focused(minMs = 2000): void {
    const t = this.now()
    if (t - this.lastFocusCheck < minMs) return
    this.lastFocusCheck = t
    void this.checkAll().catch(() => undefined)
  }

  private notifyLater(projectId: string): void {
    setImmediate(() => {
      void (async () => {
        try {
          if (!this.deps.projects.get(projectId)) return
          this.broadcastIfChanged(await this.withGit(this.check(projectId, { firstWrite: false })))
        } catch {
          /* a status push is best effort */
        }
      })()
    })
  }

  // ---------- the save hook ----------

  /**
   * ProjectStore.save calls this for every main-process save. The folder is ingested first (so a pulled change is not
   * lost), then this save's delta is applied to the approved team and to what the folder says, and only the files that
   * change are written. Pending or rejected changes in a file survive. Never throws.
   */
  beforeSave(before: Project | null, next: Project): Project {
    if (!before || this.inHook.has(next.id)) return next
    this.inHook.add(next.id)
    try {
      return this.beforeSaveInner(before, next)
    } catch (e) {
      this.warn(`the save hook failed for ${next.id}: ${e instanceof Error ? e.message : String(e)}`)
      try {
        const st = this.store.readState(next.id)
        if (!st.dirtyBefore) {
          st.dirtyBefore = this.docOf(before).doc
          this.store.writeState(next.id, st)
          this.bump(next.id)
        }
      } catch {
        /* nothing more to do */
      }
      return next
    } finally {
      this.inHook.delete(next.id)
    }
  }

  private beforeSaveInner(before: Project, next: Project): Project {
    const id = next.id
    if (this.offState(next) !== null) return next
    if (teamKey(before) === teamKey(next)) return next
    if (!this.store.readApproved(id)) return next // not opened yet: the first migration happens at open
    // Ingest first, so a pulled change is part of the team this save builds on.
    this.check(id, { firstWrite: false })
    const stored = this.deps.projects.get(id) ?? before
    const ingested = stored.updatedAt !== before.updatedAt
    const st = this.store.readState(id)
    const approved = this.store.readApproved(id)
    if (!approved) return next
    const gen = this.generations.get(id)?.find((g) => g.updatedAt === next.updatedAt)
    const beforeDoc = st.dirtyBefore ?? (gen ? gen.doc : this.docOf(stored).doc)
    const after = this.docOf(next)
    if (after.blocked) {
      // The team cannot be written as files until the user fixes it; remember where the unwritten change started.
      st.dirtyBefore ??= beforeDoc
      this.store.writeState(id, st)
      this.bump(id)
      return next
    }
    const newApproved = applyTeamDelta(approved, beforeDoc, after.doc)
    const changed = !sameTeam(beforeDoc, after.doc)
    let result = next
    // A save built from a copy older than an ingest (the renderer's, or a service's read before the pull) would revert
    // what was pulled: the project is rebuilt from the merged team, keeping this save's per-computer fields.
    const stale = ingested || !sameTeam(after.doc, newApproved)
    if (stale) {
      try {
        const ap = this.applyDoc(next, newApproved)
        ap.commit()
        result = ap.project
      } catch (e) {
        this.warn(`could not keep the pulled team changes in this save: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    if (!changed && !stale) return next
    if (!sameTeam(newApproved, approved)) this.store.writeApproved(id, newApproved)
    if (changed) {
      const w = this.writeDisk(next.path, newApproved, beforeDoc, after.doc, st)
      if (w.ok) delete st.dirtyBefore
      else st.dirtyBefore ??= beforeDoc
      // A local change ends the Undo of an earlier one.
      if (st.undo) {
        delete st.undo
        delete st.applied
        this.store.writeUndo(id, null)
      }
      this.store.writeState(id, st)
    }
    this.bump(id)
    this.notifyLater(id)
    return result
  }

  // ---------- actions ----------

  private requireApplicable(projectId: string): Project {
    const project = this.stored(projectId)
    const off = this.offState(project)
    if (off) throw new Error(off.offReason === 'shared-folder' ? `Another project (${off.sharedWith?.projectName ?? 'another project'}) owns the team files of this folder.` : 'Team files are not in use for this project.')
    return project
  }

  private result(projectId: string): TeamFilesActionResult {
    const status = this.check(projectId, { firstWrite: false })
    this.broadcastIfChanged(status)
    return { project: this.stored(projectId), status }
  }

  approve(input: { projectId: string; digest: string }): TeamFilesActionResult {
    const project = this.requireApplicable(input.projectId)
    const id = project.id
    const st = this.store.readState(id)
    const approved = this.store.readApproved(id)
    const { parsed } = this.load(project.path, approved)
    if (!parsed.doc) throw new Error(`Fix the problem in ${parsed.problems[0]?.file ?? TEAM_FILES_JSON} first.`)
    if (input.digest !== parsed.digest) throw new Error(STALE_MESSAGE)
    if (parsed.problems.length) throw new Error(`Fix the problem in ${parsed.problems[0].file} first.`)
    const pending = approved ? gateTeam(approved, parsed.doc, { firstSeen: st.firstSeen === true }).pending : []
    this.recordGeneration(project)
    this.applyAndSave(project, parsed.doc)
    if (approved && !sameTeam(approved, parsed.doc)) {
      this.store.writeUndo(id, approved)
      st.undo = { at: this.nowIso(), label: `Undo approving ${plural(pending.length, 'change', 'changes')}`, files: cap(unique(pending.map((c) => c.file))) }
    }
    this.store.writeApproved(id, parsed.doc)
    delete st.firstSeen
    delete st.rejectedDigest
    st.migrated = true
    st.lastKnownDigest = parsed.digest
    this.store.writeState(id, st)
    this.bump(id)
    return this.result(id)
  }

  reject(input: { projectId: string; digest: string }): TeamFilesActionResult {
    const project = this.requireApplicable(input.projectId)
    const id = project.id
    const approved = this.store.readApproved(id)
    const { parsed } = this.load(project.path, approved)
    if (!parsed.doc) throw new Error(`Fix the problem in ${parsed.problems[0]?.file ?? TEAM_FILES_JSON} first.`)
    if (input.digest !== parsed.digest) throw new Error(STALE_MESSAGE)
    const st = this.store.readState(id)
    st.rejectedDigest = parsed.digest
    this.store.writeState(id, st)
    this.bump(id)
    return this.result(id)
  }

  undo(input: { projectId: string }): TeamFilesActionResult {
    const project = this.requireApplicable(input.projectId)
    const id = project.id
    const st = this.store.readState(id)
    const undoDoc = this.store.readUndo(id)
    const approved = this.store.readApproved(id)
    if (!st.undo || !undoDoc || !approved) throw new Error('There is nothing to undo.')
    const info = st.undo
    this.recordGeneration(project)
    this.applyAndSave(project, undoDoc)
    this.store.writeApproved(id, undoDoc)
    const w = this.writeDisk(project.path, undoDoc, approved, undoDoc, st)
    this.store.writeUndo(id, null)
    delete st.undo
    delete st.applied
    st.lastUndo = { at: this.nowIso(), label: info.label.replace(/^Undo/, 'Undid'), files: cap(w.written) }
    this.store.writeState(id, st)
    this.bump(id)
    return this.result(id)
  }

  /** Turns team files back on after "Remove OrgAI files": writes the files from the current team. */
  enable(input: { projectId: string }): TeamFilesActionResult {
    const project = this.stored(input.projectId)
    const off = this.offState(project)
    if (off && off.offReason !== 'removed') throw new Error('Team files are not available for this project.')
    const id = project.id
    const st = this.store.readState(id)
    const d = this.docOf(project)
    if (d.blocked) throw new Error(d.blocked)
    const { parsed } = this.load(project.path, null)
    const res = writeTeamFiles(project.path, serializeTeam(d.doc), [], parsed.heldPaths)
    const failed = res.skipped.filter((p) => !isHeldPath(p, parsed.heldPaths))
    if (failed.length) throw new Error(`Could not write ${failed[0]}.`)
    delete st.removed
    delete st.firstSeen
    delete st.rejectedDigest
    delete st.dirtyBefore
    delete st.undo
    delete st.applied
    st.migrated = true
    this.store.writeApproved(id, d.doc)
    this.store.writeUndo(id, null)
    const re = this.load(project.path, d.doc).parsed
    if (re.digest) st.lastKnownDigest = re.digest
    this.store.writeState(id, st)
    this.bump(id)
    return this.result(id)
  }

  /** "Remove OrgAI files" ran: no later save recreates the files until `enable`. */
  markRemoved(projectId: string): void {
    const st = this.store.readState(projectId)
    st.removed = true
    this.store.writeState(projectId, st)
    this.bump(projectId)
    try {
      this.broadcastIfChanged(this.check(projectId, { firstWrite: false }))
    } catch {
      /* the project may be gone */
    }
  }

  /** teamFiles:commit: stage and commit only the team files. Never pushes. */
  async commit(input: { projectId: string }): Promise<TeamFilesCommitResult> {
    const project = this.requireApplicable(input.projectId)
    const done = async (ok: boolean, message: string, committed: string[]): Promise<TeamFilesCommitResult> => ({
      ok,
      message,
      committed,
      status: await this.withGit(this.check(project.id, { firstWrite: false }))
    })
    if (!existsSync(join(project.path, '.git'))) return done(false, 'This folder is not a git repository, so there is nothing to commit to.', [])
    const g = await teamFilesStatusGit(project.path)
    if (!g.ok) return done(false, firstLine(maskKeyLike(g.error ?? '')) || 'Git could not report the state of the team files.', [])
    if (!g.files.length) return done(true, 'Nothing to commit.', [])
    const r = await commitPaths(project.path, g.files, COMMIT_MESSAGE)
    if (!r.committed) return done(false, firstLine(maskKeyLike(r.error ?? '')) || 'Git did not commit the team files.', [])
    const result = await done(true, `Committed ${plural(g.files.length, 'team file', 'team files')}.`, g.files)
    this.broadcastIfChanged(result.status)
    return result
  }

  // ---------- a folder with a team in it ----------

  /** ProjectPathCheck.teamFiles: the team found in a folder, read without touching anything. Never throws. */
  found(path: unknown, check: Pick<ProjectPathCheck, 'isDirectory'>): TeamFilesFound | undefined {
    try {
      const root = cleanProjectPath(path)
      if (!root || !check.isDirectory) return undefined
      const read = readTeamFolder(root)
      if (!read.orgaiOk) return undefined
      const parsed = parseTeamFiles(read.files, { base: null, agentsDirExists: read.agentsDirExists, readProblems: read.readProblems })
      if (!parsed.present) return undefined
      const doc = parsed.doc
      const out: TeamFilesFound = { roleCount: doc?.roles.length ?? 0, roles: [], skills: [], mcpServers: [], changes: [], problems: cap(parsed.problems), warnings: cap(parsed.warnings) }
      if (!doc) return out
      const roots = doc.roles.filter((r) => r.reportsTo === null)
      const rest = doc.roles.filter((r) => r.reportsTo !== null)
      out.roles = [...roots, ...rest].slice(0, TEAM_FILES_MAX_ROLES).map((r) => ({
        name: r.name,
        slug: r.slug,
        prompt: r.prompt,
        tools: [...r.tools],
        elevated: [...r.tools.filter((t) => ELEVATED.includes(t)), ...(r.canSpawn ? ['canSpawn'] : [])],
        reportsTo: r.reportsTo
      }))
      out.skills = cap(doc.skills.map((s) => ({ name: s.name, description: s.description, scripts: skillScripts(s) })))
      out.mcpServers = cap(
        doc.mcp.map((m) => ({
          name: m.name,
          target: reviewTarget({ transport: m.transport, command: m.command, args: m.args, url: m.url, env: m.env, headers: m.headers }).target,
          secretNames: [...(m.secretEnv ?? []), ...(m.secretHeaders ?? [])],
          ...(m.connectorId ? { connectorId: m.connectorId } : {})
        }))
      )
      out.changes = cap(describeChanges(null, doc))
      if (!parsed.problems.length && parsed.digest) out.digest = parsed.digest
      return out
    } catch {
      return undefined
    }
  }

  /**
   * ProjectStore.create option: the new project with the folder's team applied (never the default chart). Refuses a stale
   * digest or a folder with problems with a readable message.
   */
  createFromFolder(project: Project, digest: string): Project {
    if (!writesToProjectFolder(project) || projectKindOf(project) === 'engagement') throw new Error('Team files are for code projects only.')
    const { read, parsed } = this.load(project.path, null)
    if (!read.orgaiOk) throw new Error(read.readProblems[0]?.message ?? 'The .orgai folder cannot be used.')
    if (!parsed.present || !parsed.doc) throw new Error(parsed.problems[0] ? `Fix the problem in ${parsed.problems[0].file} first.` : 'There are no team files in this folder.')
    if (digest !== parsed.digest) throw new Error(STALE_MESSAGE)
    if (parsed.problems.length) throw new Error(`Fix the problem in ${parsed.problems[0].file} first.`)
    const empty: Project = { ...project, roles: [], mcpServers: [], skills: [] }
    const ap = this.applyDoc(empty, parsed.doc)
    ap.commit()
    this.adoptions.set(project.id, parsed.doc)
    return ap.project
  }

  /** After createFromFolder's project is stored: the folder's team is the approved team. */
  adopted(projectId: string, doc?: TeamDoc): void {
    const d = doc ?? this.adoptions.get(projectId)
    this.adoptions.delete(projectId)
    if (!d) return
    const project = this.deps.projects.get(projectId)
    this.store.writeApproved(projectId, d)
    const st = this.store.readState(projectId)
    st.migrated = true
    delete st.firstSeen
    if (project?.path) {
      const re = this.load(project.path, d).parsed
      if (re.digest) st.lastKnownDigest = re.digest
    }
    this.store.writeState(projectId, st)
    this.bump(projectId)
  }

  // ---------- runs ----------

  /**
   * RunManager.start calls this for work and setup runs of a stored code project: the folder is checked (and its files
   * written the first time), and the run gets the fresh stored project. Changes waiting for approval are not used:
   * the run uses the last approved team and gets one warning. A rejected state is silent. Never throws.
   */
  beforeRun(project: Project): { project: Project; warning?: string } {
    try {
      if (!this.applies(project)) return { project }
      const status = this.check(project.id, { firstWrite: true })
      this.broadcastIfChanged(status)
      const fresh = this.deps.projects.get(project.id) ?? project
      if (status.state === 'pending') return { project: fresh, warning: PENDING_WARNING }
      if (status.state === 'problem') {
        const file = status.problems[0]?.file
        return { project: fresh, warning: `This run uses the last approved team: ${file ? `the team files have a problem in ${file}` : 'the team files have a problem'}.` }
      }
      return { project: fresh }
    } catch (e) {
      this.warn(`could not check the team files before a run: ${e instanceof Error ? e.message : String(e)}`)
      return { project }
    }
  }
}
