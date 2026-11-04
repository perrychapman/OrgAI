import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  SKILL_MAX_FILE_BYTES,
  SKILL_MAX_PER_PROJECT,
  SKILL_MAX_TOTAL_BYTES,
  type Project,
  type Role,
  type SkillContent,
  type SkillCreateInput,
  type SkillDraft,
  type SkillImportApplyInput,
  type SkillImportApplyResult,
  type SkillImportInput,
  type SkillImportPreview,
  type SkillInfo,
  type SkillLibraryEntry,
  type SkillLibraryFolderInput,
  type SkillLibraryInfo,
  type SkillLinkLibraryInput,
  type SkillMutationResult,
  type SkillSpec,
  type SkillProposalItem,
  type SkillsProposalPayload,
  type SkillUpdateInput
} from '@shared/types'
import { isSafeId, newId } from '@shared/defaults'
import type { ProjectStore } from '../store/projects'
import { SkillLibraryStore } from '../store/skillLibrary'
import type { RunSkill } from '../runtime/types'
import type { SkillRunSource, SkillServiceApi, SkillSnapshotInput } from './types'
import { childPath, digestFiles, fileInfos, readStoredFolder, removeFolder, writeFolder, type FileData } from './files'
import { composeSkillMd, parseSkillMd, skillFromMd, validDraft } from './skillMd'
import { skillProposalProblem } from './assist'
import { buildScannedSkill, planImport, scanRepoSkills, scanSkillFolder, type ScannedSkill } from './scan'

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

const STALE = 'The skills folder changed since the preview; refresh it.'

interface UndoRecord {
  undoId: string
  projectId: string
  undoDir: string
  prevSkills: SkillSpec[] | undefined
  /** Each role's Role.skills before the apply (undefined = the key was absent). */
  prevGrants: Map<string, string[] | undefined>
  added: string[]
  /** Updated skill ids whose folder was backed up under undoDir/<id>. */
  updated: string[]
}

/** A linked project skill: the snapshot fields come from the library entry, the rest stays the project's. */
function linkedSnapshot(entry: SkillLibraryEntry, spec: Pick<SkillSpec, 'id' | 'enabled' | 'addedAt'>): SkillSpec {
  return {
    id: spec.id,
    name: entry.name,
    description: entry.description,
    enabled: spec.enabled,
    source: 'library',
    digest: entry.digest,
    files: entry.files,
    addedAt: spec.addedAt,
    updatedAt: entry.updatedAt,
    libraryId: entry.id
  }
}

/** SKILL.md plus the given resource files, size-checked. Throws a readable error. */
function assembleFiles(draft: SkillDraft, resources: FileData[]): FileData[] {
  const md = Buffer.from(composeSkillMd(draft), 'utf8')
  if (md.length > SKILL_MAX_FILE_BYTES) throw new Error(`SKILL.md is larger than ${SKILL_MAX_FILE_BYTES / 1024} KB; shorten the instructions.`)
  const files = [{ path: 'SKILL.md', data: md }, ...resources.filter((f) => f.path !== 'SKILL.md')]
  if (files.reduce((n, f) => n + f.data.length, 0) > SKILL_MAX_TOTAL_BYTES) throw new Error(`The skill is larger than ${SKILL_MAX_TOTAL_BYTES / 1024 / 1024} MB.`)
  return files
}

/**
 * Project skills, the app-wide skill library and the repo import. Files live under the data dir (a project skill in
 * project-skills/<projectId>/<skillId>/, a library entry in skills/<entryId>/); specs live in Project.skills and the
 * library index. A repo import is a snapshot copy: the repository is never written.
 */
export class SkillService implements SkillServiceApi, SkillRunSource {
  private library: SkillLibraryStore
  private libRoot: string
  private projRoot: string
  private undos = new Map<string, UndoRecord>()

  constructor(private deps: SkillServiceDeps) {
    this.library = new SkillLibraryStore(deps.dataDir)
    this.libRoot = resolve(deps.dataDir, 'skills')
    this.projRoot = resolve(deps.dataDir, 'project-skills')
    // Backups of an earlier session can never be undone: clear them.
    try {
      if (existsSync(this.projRoot)) for (const name of readdirSync(this.projRoot)) removeFolder(join(this.projRoot, name, '.undo'))
    } catch {
      /* best effort */
    }
  }

  // ---------- helpers ----------

  private now(): string {
    return new Date().toISOString()
  }

  private project(projectId: string): Project {
    const p = isSafeId(projectId) ? this.deps.projects.get(projectId) : null
    if (!p) throw new Error('Project not found')
    return p
  }

  private libDir(entryId: string): string {
    return childPath(this.libRoot, entryId)
  }

  private ownDir(projectId: string, skillId: string): string {
    return childPath(this.projRoot, projectId, skillId)
  }

  /** The folder holding a project skill's files (a link's is the library entry's). */
  private specDir(projectId: string, spec: SkillSpec): string {
    return spec.libraryId ? this.libDir(spec.libraryId) : this.ownDir(projectId, spec.id)
  }

  /** The project with linked snapshots refreshed from the library, and the links whose entry is gone. */
  private refreshed(project: Project): { project: Project; missing: Set<string> } {
    const missing = new Set<string>()
    if (!project.skills?.length) return { project, missing }
    const skills = project.skills.map((s) => {
      if (!s.libraryId) return s
      const entry = this.library.get(s.libraryId)
      if (!entry) {
        missing.add(s.id)
        return s
      }
      return linkedSnapshot(entry, s)
    })
    return { project: { ...project, skills }, missing }
  }

  private infos(project: Project): SkillInfo[] {
    const r = this.refreshed(project)
    return (r.project.skills ?? []).map((spec) => ({
      spec,
      grantedTo: project.roles.filter((role) => role.skills?.includes(spec.id)).map((role) => role.id),
      ...(r.missing.has(spec.id) ? { libraryMissing: true as const } : {})
    }))
  }

  private result(project: Project, rolesUpdated?: { roleId: string; roleName: string }[]): SkillMutationResult {
    return {
      project: this.refreshed(project).project,
      skills: this.infos(project),
      ...(rolesUpdated?.length ? { rolesUpdated } : {})
    }
  }

  private notifyLibrary(): void {
    this.deps.onLibraryChanged?.(this.libraryList())
  }

  private checkRoleIds(project: Project, roleIds: unknown): string[] {
    if (roleIds === undefined) return []
    if (!Array.isArray(roleIds) || roleIds.some((r) => typeof r !== 'string')) throw new Error('The roles are not a list of ids.')
    const known = new Set(project.roles.map((r) => r.id))
    for (const id of roleIds) if (!known.has(id)) throw new Error(`Unknown role: ${id}`)
    return [...new Set(roleIds as string[])]
  }

  /** The roles with `skillId` granted to exactly `roleIds`, and the roles that lost it. */
  private setGrants(roles: Role[], skillId: string, roleIds: string[]): { roles: Role[]; lost: { roleId: string; roleName: string }[] } {
    const lost: { roleId: string; roleName: string }[] = []
    const out = roles.map((r) => {
      const has = r.skills?.includes(skillId) ?? false
      const want = roleIds.includes(r.id)
      if (want && !has) return { ...r, skills: [...(r.skills ?? []), skillId] }
      if (!want && has) {
        lost.push({ roleId: r.id, roleName: r.name })
        return { ...r, skills: (r.skills ?? []).filter((id) => id !== skillId) }
      }
      return r
    })
    return { roles: out, lost }
  }

  private dropGrants(roles: Role[], skillIds: string[]): { roles: Role[]; lost: { roleId: string; roleName: string }[] } {
    const lost: { roleId: string; roleName: string }[] = []
    const out = roles.map((r) => {
      if (!r.skills?.some((id) => skillIds.includes(id))) return r
      lost.push({ roleId: r.id, roleName: r.name })
      return { ...r, skills: r.skills.filter((id) => !skillIds.includes(id)) }
    })
    return { roles: out, lost }
  }

  private assertNameFree(names: string[], name: string, where: string): void {
    if (names.includes(name)) throw new Error(`${where} already has a skill named "${name}".`)
  }

  private expireUndo(projectId: string): void {
    const rec = this.undos.get(projectId)
    this.undos.delete(projectId)
    try {
      removeFolder(rec?.undoDir ?? join(childPath(this.projRoot, projectId), '.undo'))
    } catch {
      /* best effort */
    }
  }

  private storedContent(dir: string): SkillContent {
    const files = readStoredFolder(dir)
    const md = files.find((f) => f.path === 'SKILL.md')
    if (!md) throw new Error('The skill has no SKILL.md.')
    const text = md.data.toString('utf8')
    return { skillMd: text, body: parseSkillMd(text).body, files: fileInfos(files) }
  }

  // ---------- project skills ----------

  list(projectId: string): SkillInfo[] {
    return this.infos(this.project(projectId))
  }

  read(input: { projectId: string; skillId: string }): SkillContent {
    const project = this.project(input.projectId)
    const spec = this.refreshed(project).project.skills?.find((s) => s.id === input.skillId)
    if (!spec) throw new Error('Skill not found')
    if (spec.libraryId && !this.library.get(spec.libraryId)) throw new Error(`${spec.name} was removed from the skill library.`)
    return this.storedContent(this.specDir(project.id, spec))
  }

  create(input: SkillCreateInput, source: SkillSpec['source'] = 'user'): SkillMutationResult {
    if (source === 'library') throw new Error('Use skills:linkLibrary to add a skill from the library.')
    const project = this.project(input?.projectId)
    const draft = validDraft(input.draft)
    const existing = this.refreshed(project).project.skills ?? []
    if (existing.length >= SKILL_MAX_PER_PROJECT) throw new Error(`A project has at most ${SKILL_MAX_PER_PROJECT} skills.`)
    this.assertNameFree(existing.map((s) => s.name), draft.name, 'This project')
    const roleIds = this.checkRoleIds(project, input.roleIds)
    const files = assembleFiles(draft, [])
    const now = this.now()
    const spec: SkillSpec = {
      id: newId('skill'),
      name: draft.name,
      description: draft.description,
      enabled: true,
      source,
      digest: digestFiles(files),
      files: fileInfos(files),
      addedAt: now,
      updatedAt: now
    }
    const dir = this.ownDir(project.id, spec.id)
    writeFolder(dir, files)
    try {
      const granted = this.setGrants(project.roles, spec.id, roleIds)
      const saved = this.deps.projects.save({ ...project, roles: granted.roles, skills: [...(project.skills ?? []), spec] })
      this.expireUndo(project.id)
      return this.result(saved)
    } catch (e) {
      removeFolder(dir)
      throw e
    }
  }

  update(input: SkillUpdateInput): SkillMutationResult {
    const project = this.project(input?.projectId)
    const stored = (project.skills ?? []).find((s) => s.id === input.skillId)
    if (!stored) throw new Error('Skill not found')
    if (stored.libraryId && input.draft !== undefined) throw new Error('This skill comes from the skill library. Edit it in the skill library.')
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new Error('enabled must be true or false.')
    let spec = stored
    if (input.draft !== undefined) {
      const draft = validDraft(input.draft)
      const others = (this.refreshed(project).project.skills ?? []).filter((s) => s.id !== stored.id)
      this.assertNameFree(others.map((s) => s.name), draft.name, 'This project')
      const dir = this.ownDir(project.id, stored.id)
      const files = assembleFiles(draft, readStoredFolder(dir))
      writeFolder(dir, files)
      spec = { ...spec, name: draft.name, description: draft.description, digest: digestFiles(files), files: fileInfos(files), updatedAt: this.now() }
    }
    if (input.enabled !== undefined) spec = { ...spec, enabled: input.enabled }
    let roles = project.roles
    let lost: { roleId: string; roleName: string }[] = []
    if (input.roleIds !== undefined) {
      const g = this.setGrants(roles, stored.id, this.checkRoleIds(project, input.roleIds))
      roles = g.roles
      lost = g.lost
    }
    const saved = this.deps.projects.save({ ...project, roles, skills: (project.skills ?? []).map((s) => (s.id === stored.id ? spec : s)) })
    this.expireUndo(project.id)
    return this.result(saved, lost)
  }

  remove(input: { projectId: string; skillId: string }): SkillMutationResult {
    const project = this.project(input?.projectId)
    const spec = (project.skills ?? []).find((s) => s.id === input.skillId)
    if (!spec) throw new Error('Skill not found')
    const dropped = this.dropGrants(project.roles, [spec.id])
    const saved = this.deps.projects.save({ ...project, roles: dropped.roles, skills: (project.skills ?? []).filter((s) => s.id !== spec.id) })
    // A linked skill is only unlinked: the files belong to the library entry.
    if (!spec.libraryId) removeFolder(this.ownDir(project.id, spec.id))
    this.expireUndo(project.id)
    return this.result(saved, dropped.lost)
  }

  linkLibrary(input: SkillLinkLibraryInput): SkillMutationResult {
    const project = this.project(input?.projectId)
    const entry = isSafeId(input.libraryId) ? this.library.get(input.libraryId) : undefined
    if (!entry) throw new Error('Library skill not found')
    const existing = this.refreshed(project).project.skills ?? []
    if (existing.some((s) => s.libraryId === entry.id)) throw new Error(`${entry.name} is already linked to this project.`)
    if (existing.length >= SKILL_MAX_PER_PROJECT) throw new Error(`A project has at most ${SKILL_MAX_PER_PROJECT} skills.`)
    this.assertNameFree(existing.map((s) => s.name), entry.name, 'This project')
    const roleIds = this.checkRoleIds(project, input.roleIds)
    const link = linkedSnapshot(entry, { id: newId('skill'), enabled: true, addedAt: this.now() })
    const granted = this.setGrants(project.roles, link.id, roleIds)
    const saved = this.deps.projects.save({ ...project, roles: granted.roles, skills: [...(project.skills ?? []), link] })
    this.expireUndo(project.id)
    return this.result(saved)
  }

  addSnapshot(input: SkillSnapshotInput): SkillMutationResult {
    const project = this.project(input?.projectId)
    const built = buildScannedSkill(input.files, input.folderName, input.repoPath ?? input.folderName, null)
    if (typeof built === 'string') throw new Error(built)
    const existing = this.refreshed(project).project.skills ?? []
    if (existing.length >= SKILL_MAX_PER_PROJECT) throw new Error(`A project has at most ${SKILL_MAX_PER_PROJECT} skills.`)
    this.assertNameFree(existing.map((s) => s.name), built.name, 'This project')
    if (built.totalBytes > SKILL_MAX_TOTAL_BYTES) throw new Error(`The skill is larger than ${SKILL_MAX_TOTAL_BYTES / 1024 / 1024} MB.`)
    const roleIds = this.checkRoleIds(project, input.roleIds)
    const now = this.now()
    const spec: SkillSpec = {
      id: newId('skill'),
      name: built.name,
      description: built.description,
      enabled: true,
      source: input.source,
      ...(input.source === 'repo' && input.repoPath ? { repoPath: input.repoPath } : {}),
      ...(input.source !== 'repo' && input.sourceRef ? { sourceRef: input.sourceRef.slice(0, 500) } : {}),
      digest: built.digest,
      files: built.files,
      addedAt: now,
      updatedAt: now
    }
    const dir = this.ownDir(project.id, spec.id)
    writeFolder(dir, built.data)
    try {
      const granted = this.setGrants(project.roles, spec.id, roleIds)
      const saved = this.deps.projects.save({ ...project, roles: granted.roles, skills: [...(project.skills ?? []), spec] })
      this.expireUndo(project.id)
      return this.result(saved)
    } catch (e) {
      removeFolder(dir)
      throw e
    }
  }

  /** Copy a project-only skill into the library and relink the project's skill to it (same id, grants kept). */
  promote(input: { projectId: string; skillId: string }): SkillMutationResult {
    const project = this.project(input?.projectId)
    const spec = (project.skills ?? []).find((s) => s.id === input.skillId)
    if (!spec) throw new Error('Skill not found')
    if (spec.libraryId) throw new Error(`${spec.name} is already part of the skill library.`)
    const entries = this.library.list()
    if (entries.length >= SKILL_MAX_PER_PROJECT) throw new Error(`The skill library holds at most ${SKILL_MAX_PER_PROJECT} skills.`)
    this.assertNameFree(entries.map((e) => e.name), spec.name, 'The skill library')
    const ownDir = this.ownDir(project.id, spec.id)
    // Re-emit SKILL.md with only name and description: a copy stored before that rule is cleaned here.
    const files = readStoredFolder(ownDir).map((f) => {
      if (f.path !== 'SKILL.md') return f
      const r = skillFromMd(f.data.toString('utf8'), spec.name)
      if (!r.ok) throw new Error(r.reason)
      return { path: f.path, data: Buffer.from(composeSkillMd({ name: r.name, description: r.description, body: r.body }), 'utf8') }
    })
    const entry: SkillLibraryEntry = {
      id: newId('skilllib'),
      name: spec.name,
      description: spec.description,
      source: spec.source,
      digest: digestFiles(files),
      files: fileInfos(files),
      addedAt: spec.addedAt,
      updatedAt: spec.updatedAt
    }
    const libDir = this.libDir(entry.id)
    writeFolder(libDir, files)
    let saved: Project
    try {
      this.library.save(entry)
      saved = this.deps.projects.save({ ...project, skills: (project.skills ?? []).map((s) => (s.id === spec.id ? linkedSnapshot(entry, s) : s)) })
    } catch (e) {
      this.library.remove(entry.id)
      removeFolder(libDir)
      throw e
    }
    removeFolder(ownDir)
    this.expireUndo(project.id)
    this.notifyLibrary()
    return this.result(saved)
  }

  // ---------- repo import ----------

  previewImport(input: SkillImportInput): SkillImportPreview {
    const project = this.project(input?.projectId)
    const scan = scanRepoSkills(project.path)
    const plan = planImport(scan, this.refreshed(project).project.skills ?? [], new Set(project.roles.map((r) => r.id)), input.choices)
    return { items: plan.items, invalid: scan.invalid, warnings: scan.warnings, roots: scan.roots, digest: scan.digest }
  }

  applyImport(input: SkillImportApplyInput): SkillImportApplyResult {
    const project = this.project(input?.projectId)
    if (typeof input.digest !== 'string' || !input.digest) throw new Error('Preview the import first: the preview digest is required.')
    const scan = scanRepoSkills(project.path)
    if (scan.digest !== input.digest) throw new Error(STALE)
    const skills = this.refreshed(project).project.skills ?? []
    const plan = planImport(scan, skills, new Set(project.roles.map((r) => r.id)), input.choices)
    const todo = plan.items.filter((i) => i.action === 'add' || i.action === 'update')
    if (!todo.length) throw new Error('Nothing to import: every skill is unchanged or left out.')
    if (skills.length + todo.filter((i) => i.action === 'add').length > SKILL_MAX_PER_PROJECT) throw new Error(`A project has at most ${SKILL_MAX_PER_PROJECT} skills.`)
    const byPath = new Map<string, ScannedSkill>(scan.skills.map((s) => [s.repoPath, s]))

    this.expireUndo(project.id)
    const undoId = newId('undo')
    const undoDir = join(childPath(this.projRoot, project.id), '.undo', undoId)
    const now = this.now()
    const added: string[] = []
    const updated: string[] = []
    const backedUp: string[] = []
    const newSkills = new Map<string, SkillSpec>()
    try {
      for (const item of todo) {
        const s = byPath.get(item.key)
        if (!s) throw new Error(STALE)
        if (item.action === 'add') {
          const id = newId('skill')
          writeFolder(this.ownDir(project.id, id), s.data)
          added.push(id)
          newSkills.set(
            id,
            { id, name: s.name, description: s.description, enabled: true, source: 'repo', repoPath: s.repoPath, digest: s.digest, files: s.files, addedAt: now, updatedAt: now }
          )
        } else {
          const old = skills.find((k) => k.id === item.existingSkillId)
          if (!old) throw new Error(STALE)
          const dir = this.ownDir(project.id, old.id)
          if (existsSync(dir)) {
            writeFolder(join(undoDir, old.id), readStoredFolder(dir))
            backedUp.push(old.id)
          }
          writeFolder(dir, s.data)
          updated.push(old.id)
          newSkills.set(old.id, { ...old, name: s.name, description: s.description, source: 'repo', repoPath: s.repoPath, digest: s.digest, files: s.files, updatedAt: now })
        }
      }
      let roles = project.roles
      const prevGrants = new Map<string, string[] | undefined>(project.roles.map((r) => [r.id, r.skills ? [...r.skills] : undefined]))
      for (const item of todo) {
        const wanted = plan.grants.get(item.key)
        if (!wanted) continue
        const id = item.action === 'add' ? added[todo.filter((i) => i.action === 'add').indexOf(item)] : item.existingSkillId
        if (id) roles = this.setGrants(roles, id, wanted).roles
      }
      const nextSkills = [...skills.map((k) => newSkills.get(k.id) ?? k), ...added.map((id) => newSkills.get(id) as SkillSpec)]
      const saved = this.deps.projects.save({ ...project, roles, skills: nextSkills })
      this.undos.set(project.id, { undoId, projectId: project.id, undoDir, prevSkills: project.skills, prevGrants, added, updated: backedUp })
      return { ...this.result(saved), added, updated, undoId }
    } catch (e) {
      for (const id of added) removeFolder(this.ownDir(project.id, id))
      for (const id of backedUp) {
        try {
          writeFolder(this.ownDir(project.id, id), readStoredFolder(join(undoDir, id)))
        } catch {
          /* best effort */
        }
      }
      removeFolder(undoDir)
      throw e
    }
  }

  undoImport(input: { projectId: string; undoId: string }): SkillMutationResult {
    const project = this.project(input?.projectId)
    const rec = this.undos.get(project.id)
    if (!rec || rec.undoId !== input.undoId) throw new Error('Nothing to undo')
    for (const id of rec.updated) writeFolder(this.ownDir(project.id, id), readStoredFolder(join(rec.undoDir, id)))
    for (const id of rec.added) removeFolder(this.ownDir(project.id, id))
    const prevSkills = rec.prevSkills
    const known = new Set((prevSkills ?? []).map((s) => s.id))
    const roles = project.roles.map((r) => {
      if (rec.prevGrants.has(r.id)) {
        const { skills: _drop, ...rest } = r
        const prev = rec.prevGrants.get(r.id)
        return prev === undefined ? rest : { ...rest, skills: prev }
      }
      return r.skills ? { ...r, skills: r.skills.filter((id) => known.has(id)) } : r
    })
    const next: Project = { ...project, roles }
    if (prevSkills === undefined) delete next.skills
    else next.skills = prevSkills
    const saved = this.deps.projects.save(next)
    this.expireUndo(project.id)
    return this.result(saved)
  }

  // ---------- library ----------

  libraryList(): SkillLibraryInfo[] {
    const all = this.deps.projects.list()
    return this.library.list().map((entry) => ({
      entry,
      usedBy: all.flatMap((p) =>
        (p.skills ?? [])
          .filter((s) => s.libraryId === entry.id)
          .map((s) => ({ projectId: p.id, projectName: p.name, skillId: s.id, roleNames: p.roles.filter((r) => r.skills?.includes(s.id)).map((r) => r.name) }))
      )
    }))
  }

  private entry(libraryId: string): SkillLibraryEntry {
    const e = isSafeId(libraryId) ? this.library.get(libraryId) : undefined
    if (!e) throw new Error('Library skill not found')
    return e
  }

  libraryRead(input: { libraryId: string }): SkillContent {
    return this.storedContent(this.libDir(this.entry(input?.libraryId).id))
  }

  private newEntry(name: string, description: string, source: SkillLibraryEntry['source'], files: FileData[]): SkillLibraryEntry {
    const now = this.now()
    return { id: newId('skilllib'), name, description, source, digest: digestFiles(files), files: fileInfos(files), addedAt: now, updatedAt: now }
  }

  private addEntry(entry: SkillLibraryEntry, files: FileData[]): void {
    const entries = this.library.list()
    if (entries.length >= SKILL_MAX_PER_PROJECT) throw new Error(`The skill library holds at most ${SKILL_MAX_PER_PROJECT} skills.`)
    this.assertNameFree(entries.map((e) => e.name), entry.name, 'The skill library')
    const dir = this.libDir(entry.id)
    writeFolder(dir, files)
    try {
      this.library.save(entry)
    } catch (e) {
      removeFolder(dir)
      throw e
    }
  }

  libraryCreate(draft: SkillDraft): SkillLibraryInfo[] {
    const d = validDraft(draft)
    const files = assembleFiles(d, [])
    this.addEntry(this.newEntry(d.name, d.description, 'user', files), files)
    this.notifyLibrary()
    return this.libraryList()
  }

  libraryAddFromFolder(input: SkillLibraryFolderInput): SkillLibraryInfo[] {
    const scanned = scanSkillFolder(input?.path)
    if ('invalid' in scanned) throw new Error(scanned.invalid)
    const s = scanned.skill
    this.addEntry(this.newEntry(s.name, s.description, 'user', s.data), s.data)
    this.notifyLibrary()
    return this.libraryList()
  }

  libraryUpdate(input: { libraryId: string; draft: SkillDraft }): SkillLibraryInfo[] {
    const prev = this.entry(input?.libraryId)
    const d = validDraft(input.draft)
    this.assertNameFree(this.library.list().filter((e) => e.id !== prev.id).map((e) => e.name), d.name, 'The skill library')
    // A renamed entry must not collide with another skill of a project that links it.
    for (const p of this.deps.projects.list()) {
      if (!p.skills?.some((s) => s.libraryId === prev.id)) continue
      const clash = p.skills.find((s) => s.libraryId !== prev.id && s.name === d.name)
      if (clash) throw new Error(`The project ${p.name} already has a skill named "${d.name}".`)
    }
    const dir = this.libDir(prev.id)
    const files = assembleFiles(d, readStoredFolder(dir))
    writeFolder(dir, files)
    const entry: SkillLibraryEntry = { ...prev, name: d.name, description: d.description, digest: digestFiles(files), files: fileInfos(files), updatedAt: this.now() }
    this.library.save(entry)
    for (const p of this.deps.projects.list()) {
      if (!p.skills?.some((s) => s.libraryId === entry.id)) continue
      const saved = this.deps.projects.save({ ...p, skills: p.skills.map((s) => (s.libraryId === entry.id ? linkedSnapshot(entry, s) : s)) })
      this.deps.onProjectChanged?.(saved)
    }
    this.notifyLibrary()
    return this.libraryList()
  }

  libraryRemove(input: { libraryId: string }): SkillLibraryInfo[] {
    const entry = this.entry(input?.libraryId)
    for (const p of this.deps.projects.list()) {
      const links = (p.skills ?? []).filter((s) => s.libraryId === entry.id).map((s) => s.id)
      if (!links.length) continue
      const dropped = this.dropGrants(p.roles, links)
      const saved = this.deps.projects.save({ ...p, roles: dropped.roles, skills: (p.skills ?? []).filter((s) => s.libraryId !== entry.id) })
      this.expireUndo(p.id)
      this.deps.onProjectChanged?.(saved)
    }
    this.library.remove(entry.id)
    removeFolder(this.libDir(entry.id))
    this.notifyLibrary()
    return this.libraryList()
  }

  /** For the practice kit: a library skill's files (read from OrgAI's own folder). Throws "Library skill not found". */
  libraryFilesForKit(libraryId: string): { name: string; description: string; files: FileData[] } {
    const entry = this.entry(libraryId)
    return { name: entry.name, description: entry.description, files: readStoredFolder(this.libDir(entry.id)) }
  }

  /**
   * For the practice kit: add a validated skill to the library, or replace the files of `replaceId` (same name; every
   * project that links it is refreshed). The caller has already validated name, description and files (buildScannedSkill).
   */
  libraryImportForKit(input: { name: string; description: string; files: FileData[] }, replaceId?: string): SkillLibraryEntry {
    if (replaceId === undefined) {
      const entry = this.newEntry(input.name, input.description, 'user', input.files)
      this.addEntry(entry, input.files)
      this.notifyLibrary()
      return entry
    }
    const prev = this.entry(replaceId)
    if (prev.name !== input.name) throw new Error('The library skill has another name.')
    const dir = this.libDir(prev.id)
    writeFolder(dir, input.files)
    const entry: SkillLibraryEntry = { ...prev, description: input.description, source: 'user', digest: digestFiles(input.files), files: fileInfos(input.files), updatedAt: this.now() }
    this.library.save(entry)
    for (const p of this.deps.projects.list()) {
      if (!p.skills?.some((s) => s.libraryId === entry.id)) continue
      const saved = this.deps.projects.save({ ...p, skills: p.skills.map((s) => (s.libraryId === entry.id ? linkedSnapshot(entry, s) : s)) })
      this.deps.onProjectChanged?.(saved)
    }
    this.notifyLibrary()
    return entry
  }

  // ---------- shared ----------

  withLibrary(project: Project): Project {
    const r = this.refreshed(project)
    if (!r.missing.size) return r.project
    return { ...r.project, skills: (r.project.skills ?? []).map((s) => (r.missing.has(s.id) ? { ...s, enabled: false } : s)) }
  }

  removeProjectFiles(projectId: string): void {
    if (!isSafeId(projectId)) return
    this.undos.delete(projectId)
    try {
      removeFolder(childPath(this.projRoot, projectId))
    } catch {
      /* best effort */
    }
  }

  /**
   * Apply an approved Skill assistant proposal (SetupService hooks.skills). projectId null = library scope. Every
   * item is validated before anything is written. Returns the saved project (project session) or null (library).
   * Items are applied in order through the same paths as the UI (create, update, libraryCreate, libraryUpdate); the
   * checks (skillProposalProblem plus capacity and rename clashes with linked projects) run first, so a refused item
   * leaves everything untouched. A write that still fails midway rolls back everything (snapshotForProposal) and throws.
   */
  /**
   * Snapshot what applyProposal can touch (library entries and files, every project's skills and roles, project skill
   * files) so a failure midway puts it all back. Call the result to restore, `.discard()` when done.
   */
  private snapshotForProposal(): (() => void) & { discard: () => void } {
    const tmp = mkdtempSync(join(tmpdir(), 'orgai-skills-snap-'))
    const entries = this.library.list()
    const projects = this.deps.projects.list().map((p) => structuredClone(p))
    const copy = (from: string, name: string): void => {
      if (existsSync(from)) cpSync(from, join(tmp, name), { recursive: true, verbatimSymlinks: true })
    }
    copy(this.libRoot, 'lib')
    projects.forEach((p, i) => {
      if (isSafeId(p.id)) copy(childPath(this.projRoot, p.id), `proj-${i}`)
    })
    const restore = (): void => {
      try {
        const keep = new Set(entries.map((e) => e.id))
        for (const e of this.library.list()) if (!keep.has(e.id)) this.library.remove(e.id)
        for (const e of entries) this.library.save(e)
        rmSync(this.libRoot, { recursive: true, force: true })
        if (existsSync(join(tmp, 'lib'))) cpSync(join(tmp, 'lib'), this.libRoot, { recursive: true, verbatimSymlinks: true })
        projects.forEach((p, i) => {
          if (!isSafeId(p.id)) return
          const dir = childPath(this.projRoot, p.id)
          rmSync(dir, { recursive: true, force: true })
          if (existsSync(join(tmp, `proj-${i}`))) cpSync(join(tmp, `proj-${i}`), dir, { recursive: true, verbatimSymlinks: true })
          const saved = this.deps.projects.save(p)
          this.deps.onProjectChanged?.(saved)
        })
        this.notifyLibrary()
      } catch (err) {
        console.error('Skill proposal rollback failed:', err instanceof Error ? err.message : err)
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    }
    return Object.assign(restore, { discard: () => rmSync(tmp, { recursive: true, force: true }) })
  }

  /** opts.projectOnly (work runs, review L3): scope 'library' items are refused here too, not only by propose_skills. */
  applyProposal(projectId: string | null, payload: SkillsProposalPayload, opts: { projectOnly?: boolean } = {}): Project | null {
    const items = payload?.items
    const project = projectId === null ? null : this.project(projectId)
    const lib = this.library.list()
    const view = project ? this.refreshed(project).project : null
    const problem = skillProposalProblem(items, {
      projectSession: project !== null,
      roleSlugs: project ? project.roles.map((r) => r.slug) : [],
      library: lib.map((e) => ({ id: e.id, name: e.name })),
      projectSkills: (view?.skills ?? []).map((s) => ({ id: s.id, name: s.name, ...(s.libraryId ? { libraryId: s.libraryId } : {}) })),
      ...(opts.projectOnly ? { allowLibrary: false } : {})
    })
    if (problem) throw new Error(problem)
    const libCreates = items.filter((i) => i.scope === 'library' && i.action === 'create').length
    if (lib.length + libCreates > SKILL_MAX_PER_PROJECT) throw new Error(`The skill library holds at most ${SKILL_MAX_PER_PROJECT} skills.`)
    const projCreates = items.filter((i) => i.scope === 'project' && (i.action === 'create' || i.action === 'link')).length
    if ((view?.skills?.length ?? 0) + projCreates > SKILL_MAX_PER_PROJECT) throw new Error(`A project has at most ${SKILL_MAX_PER_PROJECT} skills.`)
    for (const it of items) {
      if (it.scope !== 'library' || it.action !== 'update') continue
      const name = it.draft.name.trim()
      for (const p of this.deps.projects.list()) {
        const clash = p.skills?.find((s) => s.libraryId !== it.libraryId && s.name === name && p.skills?.some((l) => l.libraryId === it.libraryId))
        if (clash) throw new Error(`The project ${p.name} already has a skill named "${name}".`)
      }
    }
    const roleIdOf = (slug: string): string => {
      const role = project?.roles.find((r) => r.slug === slug)
      if (!role) throw new Error(`There is no role "${slug}" in this project.`)
      return role.id
    }
    const roleIds = (item: SkillProposalItem): string[] | undefined => (item.roles === undefined ? undefined : [...new Set(item.roles.map(roleIdOf))])
    const restore = this.snapshotForProposal()
    try {
      for (const it of items) {
        if (it.scope === 'library') {
          if (it.action === 'create') this.libraryCreate(it.draft)
          else this.libraryUpdate({ libraryId: it.libraryId as string, draft: it.draft })
          continue
        }
        const ids = roleIds(it)
        if (it.action === 'link') {
          this.linkLibrary({ projectId: project!.id, libraryId: it.libraryId as string, ...(ids ? { roleIds: ids } : {}) })
        } else if (it.action === 'grant' || it.action === 'remove') {
          const name = it.draft.name.trim()
          const skill = (this.refreshed(this.project(project!.id)).project.skills ?? []).find((s) => s.name === name)
          if (!skill) throw new Error(`This project has no skill named "${name}".`)
          if (it.action === 'remove') this.remove({ projectId: project!.id, skillId: skill.id })
          else
            this.update({
              projectId: project!.id,
              skillId: skill.id,
              ...(ids ? { roleIds: ids } : {}),
              ...(typeof it.enabled === 'boolean' ? { enabled: it.enabled } : {})
            })
        } else if (it.action === 'create') {
          this.create({ projectId: project!.id, draft: it.draft, ...(ids ? { roleIds: ids } : {}) }, 'user')
        } else {
          const name = it.draft.name.trim()
          const skill = (this.refreshed(this.project(project!.id)).project.skills ?? []).find((s) => s.name === name)
          if (!skill) throw new Error(`This project has no skill named "${name}".`)
          this.update({ projectId: project!.id, skillId: skill.id, draft: it.draft, ...(ids ? { roleIds: ids } : {}) })
        }
      }
    } catch (e) {
      restore()
      throw e
    }
    restore.discard()
    return project ? this.project(project.id) : null
  }

  forRun(project: Project, roles: Role[]): RunSkill[] {
    try {
      const r = this.refreshed(project)
      const out: RunSkill[] = []
      for (const spec of r.project.skills ?? []) {
        try {
          if (!spec.enabled || r.missing.has(spec.id)) continue
          const roleIds = roles.filter((role) => role.skills?.includes(spec.id)).map((role) => role.id)
          if (!roleIds.length) continue
          const dir = this.specDir(project.id, spec)
          if (!existsSync(join(dir, 'SKILL.md'))) {
            console.error(`Skill ${spec.name}: SKILL.md is missing, left out of the run`)
            continue
          }
          out.push({ id: spec.id, name: spec.name, description: spec.description, dir, files: spec.files, roleIds })
        } catch (e) {
          console.error(`Skill ${spec.name} left out of the run:`, e instanceof Error ? e.message : e)
        }
      }
      return out
    } catch (e) {
      console.error('Skills could not be listed for the run:', e instanceof Error ? e.message : e)
      return []
    }
  }
}
