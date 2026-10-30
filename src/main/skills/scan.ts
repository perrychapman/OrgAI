import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'
import {
  AGENT_IMPORT_MAX_CHOICES,
  SKILL_REPO_ROOTS,
  type SkillFileInfo,
  type SkillImportChoice,
  type SkillImportInvalid,
  type SkillImportItem,
  type SkillRepoRoot,
  type SkillSpec
} from '@shared/types'
import { digestFiles, fileInfos, FolderReader, looksLikeScript, type FileData } from './files'
import { composeSkillMd, skillFromMd } from './skillMd'

/**
 * Finds skill folders in a repository (or one folder the user picked). The input is untrusted: nothing is executed,
 * nothing leaves the folder, links are skipped, .git is never read and every count and size is capped. Never throws.
 */

/** Candidate skill folders looked at in one repo scan. */
export const SKILL_MAX_CANDIDATES = 100

export interface ScannedSkill {
  root: SkillRepoRoot | null
  /** Project-relative, '/'-separated; for a single folder, its name. */
  repoPath: string
  name: string
  description: string
  body: string
  files: SkillFileInfo[]
  data: FileData[]
  totalBytes: number
  scripts: string[]
  /** Digest of the files OrgAI stores (SKILL.md rewritten). */
  digest: string
  /** Digest of the folder as found in the repo; binds the preview so apply notices a change. */
  sourceDigest: string
  notes: string[]
}

export interface RepoScan {
  skills: ScannedSkill[]
  invalid: SkillImportInvalid[]
  warnings: string[]
  roots: SkillRepoRoot[]
  /** sha256 binding every scanned candidate (path and content digest, or its invalid reason). */
  digest: string
}

function build(files: FileData[], folderName: string, repoPath: string, root: SkillRepoRoot | null): ScannedSkill | string {
  const md = files.find((f) => f.path === 'SKILL.md')
  if (!md) return 'There is no SKILL.md in the folder.'
  const parsed = skillFromMd(md.data.toString('utf8'), folderName)
  if (!parsed.ok) return parsed.reason
  // Only name and description are kept: allowed-tools, hooks and the like never reach a stored copy.
  const stored = files.map((f) => (f.path === 'SKILL.md' ? { path: f.path, data: Buffer.from(composeSkillMd({ name: parsed.name, description: parsed.description, body: parsed.body }), 'utf8') } : f))
  return {
    root,
    repoPath,
    name: parsed.name,
    description: parsed.description,
    body: parsed.body,
    files: fileInfos(stored),
    data: stored,
    totalBytes: stored.reduce((n, f) => n + f.data.length, 0),
    scripts: stored.filter((f) => f.path !== 'SKILL.md' && looksLikeScript(f.path, f.data)).map((f) => f.path),
    digest: digestFiles(stored),
    sourceDigest: digestFiles(files),
    notes: parsed.notes
  }
}

/** UNC and device paths (two leading slashes or backslashes, so also the \\?\ and \\.\ prefixes): never touched by the fs. */
export function isNetworkOrDevicePath(p: string): boolean {
  return /^[\\/]{2}/.test(p)
}

/** Every skill folder under the known roots of the project folder. */
export function scanRepoSkills(projectPath: string): RepoScan {
  const out: RepoScan = { skills: [], invalid: [], warnings: [], roots: [], digest: '' }
  const finish = (): RepoScan => {
    const h = createHash('sha256')
    for (const s of out.skills) h.update(`ok\0${s.repoPath}\0${s.sourceDigest}\n`)
    for (const i of out.invalid) h.update(`bad\0${i.repoPath}\0${i.reason}\n`)
    for (const w of out.warnings) h.update(`warn\0${w}\n`)
    out.digest = h.digest('hex')
    return out
  }
  try {
    if (typeof projectPath === 'string' && isNetworkOrDevicePath(projectPath)) {
      out.warnings.push('Network and device paths are not scanned; use a folder on this computer.')
      return finish()
    }
    if (typeof projectPath !== 'string' || !isAbsolute(projectPath)) {
      out.warnings.push('The project folder is not an absolute path.')
      return finish()
    }
    let rootReal: string
    try {
      rootReal = realpathSync(projectPath)
      if (!statSync(rootReal).isDirectory()) throw new Error('not a folder')
    } catch {
      out.warnings.push('The project folder could not be read.')
      return finish()
    }
    const reader = new FolderReader(rootReal)
    let candidates = 0
    for (const root of SKILL_REPO_ROOTS) {
      const rootAbs = join(rootReal, ...root.split('/'))
      let st
      try {
        st = lstatSync(rootAbs)
      } catch {
        continue
      }
      if (st.isSymbolicLink()) {
        out.roots.push(root)
        out.invalid.push({ repoPath: root, reason: 'symlink' })
        continue
      }
      if (!st.isDirectory()) continue
      let real: string
      try {
        real = realpathSync(rootAbs)
      } catch {
        continue
      }
      if (real.toLowerCase() !== rootAbs.toLowerCase()) {
        out.roots.push(root)
        out.invalid.push({ repoPath: root, reason: 'symlink (the path goes through a link)' })
        continue
      }
      out.roots.push(root)
      let names: string[]
      try {
        names = readdirSync(rootAbs).sort()
      } catch {
        out.warnings.push(`${root}: could not be read`)
        continue
      }
      for (const name of names) {
        if (!reader.spend()) {
          out.warnings.push(`More than 5,000 folder entries: the rest of the skill folders were not looked at (first skipped: ${root}/${name}).`)
          return finish()
        }
        const folderAbs = join(rootAbs, name)
        const repoPath = `${root}/${name}`
        let fst
        try {
          fst = lstatSync(folderAbs)
        } catch {
          continue
        }
        if (fst.isSymbolicLink()) {
          out.invalid.push({ repoPath, reason: 'symlink' })
          continue
        }
        if (!fst.isDirectory()) continue
        let inner: string[]
        try {
          inner = readdirSync(folderAbs)
        } catch {
          out.invalid.push({ repoPath, reason: 'The folder could not be read.' })
          continue
        }
        // A SKILL.md named exactly so makes a candidate; a link of that name is reported by the folder read.
        if (!inner.includes('SKILL.md')) continue
        if (++candidates > SKILL_MAX_CANDIDATES) {
          out.warnings.push(`Only the first ${SKILL_MAX_CANDIDATES} skill folders are looked at (first skipped: ${repoPath}).`)
          return finish()
        }
        const read = reader.read(folderAbs)
        if (!read.ok) {
          out.invalid.push({ repoPath, reason: read.reason })
          if (reader.exhausted) {
            out.warnings.push('More than 5,000 folder entries: the scan stopped.')
            return finish()
          }
          continue
        }
        const skill = build(read.files, name, repoPath, root)
        if (typeof skill === 'string') out.invalid.push({ repoPath, reason: skill })
        else {
          skill.notes.push(...read.notes)
          out.skills.push(skill)
        }
      }
    }
    return finish()
  } catch (e) {
    out.warnings.push(`The scan failed: ${e instanceof Error ? e.message : 'unexpected error'}`)
    return finish()
  }
}

/** One absolute folder the user picked (SKILL.md at its top). */
export function scanSkillFolder(path: string): { skill: ScannedSkill } | { invalid: string } {
  try {
    if (typeof path === 'string' && isNetworkOrDevicePath(path)) return { invalid: 'Network and device paths are not allowed; use a folder on this computer.' }
    if (typeof path !== 'string' || !isAbsolute(path)) return { invalid: 'Use the full path of the skill folder.' }
    let st
    try {
      st = lstatSync(path)
    } catch {
      return { invalid: 'The folder does not exist.' }
    }
    if (st.isSymbolicLink()) return { invalid: 'symlink: choose the real folder, not a link to it.' }
    if (!st.isDirectory()) return { invalid: 'That is not a folder.' }
    const real = realpathSync(path)
    const read = new FolderReader(real).read(real)
    if (!read.ok) return { invalid: read.reason }
    const folder = basename(real)
    const skill = build(read.files, folder, folder, null)
    if (typeof skill === 'string') return { invalid: skill }
    skill.notes.push(...read.notes)
    return { skill }
  } catch (e) {
    return { invalid: e instanceof Error ? e.message : 'The folder could not be read.' }
  }
}

export interface ImportPlan {
  items: SkillImportItem[]
  /** Roles to grant per item key, from the choices. */
  grants: Map<string, string[]>
}

/**
 * Items for a scan against the project's skills, with the choices applied. 'add' for a new name; 'update' when a
 * project skill has the repoPath (or, failing that, the name and source 'repo') and another digest; 'unchanged' for
 * the same digest; 'skip' for a later duplicate name or a name used by another skill. Choices set include and the
 * grants; unknown keys and roles are refused with a readable error.
 */
export function planImport(scan: RepoScan, skills: SkillSpec[], roleIds: Set<string>, choices: SkillImportChoice[] | undefined): ImportPlan {
  if (choices !== undefined && !Array.isArray(choices)) throw new Error('The choices are not a list.')
  if ((choices?.length ?? 0) > AGENT_IMPORT_MAX_CHOICES) throw new Error(`At most ${AGENT_IMPORT_MAX_CHOICES} choices can be sent.`)
  const keys = new Set(scan.skills.map((s) => s.repoPath))
  const chosen = new Map<string, SkillImportChoice>()
  for (const c of choices ?? []) {
    if (!c || typeof c !== 'object' || typeof c.key !== 'string' || !keys.has(c.key)) throw new Error(`Unknown skill in the choices: ${typeof c?.key === 'string' ? c.key : '(no key)'}. Refresh the preview.`)
    if (typeof c.include !== 'boolean') throw new Error(`Choice for ${c.key} needs include true or false.`)
    if (c.roleIds !== undefined) {
      if (!Array.isArray(c.roleIds) || c.roleIds.some((r) => typeof r !== 'string')) throw new Error(`The roles chosen for ${c.key} are not a list of ids.`)
      for (const r of c.roleIds) if (!roleIds.has(r)) throw new Error(`Unknown role in the choices for ${c.key}: ${r}.`)
    }
    chosen.set(c.key, c)
  }
  const own = skills.filter((s) => !s.libraryId)
  const firstOf = new Map<string, string>()
  const items: SkillImportItem[] = []
  const grants = new Map<string, string[]>()
  for (const s of scan.skills) {
    const notes = [...s.notes]
    const existing = own.find((e) => e.source === 'repo' && e.repoPath === s.repoPath) ?? own.find((e) => e.source === 'repo' && e.name === s.name && !scan.skills.some((o) => o.repoPath === e.repoPath))
    const item: SkillImportItem = {
      key: s.repoPath,
      root: s.root as SkillRepoRoot,
      repoPath: s.repoPath,
      name: s.name,
      description: s.description,
      body: s.body,
      files: s.files,
      totalBytes: s.totalBytes,
      scripts: s.scripts,
      digest: s.digest,
      action: 'add',
      notes
    }
    const dup = firstOf.get(s.name)
    if (dup) {
      item.action = 'skip'
      item.duplicateOf = dup
      notes.push(`Another skill named "${s.name}" is in ${dup}; this one is left out.`)
    } else {
      firstOf.set(s.name, s.repoPath)
      const clash = skills.find((o) => o.name === s.name && o.id !== existing?.id)
      if (clash) {
        item.action = 'skip'
        item.nameConflict = true
        notes.push(`The project already has a skill named "${s.name}"; rename or remove it first.`)
      } else if (existing) {
        item.existingSkillId = existing.id
        item.action = existing.digest === s.digest && existing.repoPath === s.repoPath ? 'unchanged' : 'update'
        if (existing.repoPath !== s.repoPath) notes.push(`Replaces the skill imported from ${existing.repoPath}.`)
      }
    }
    const c = chosen.get(s.repoPath)
    if (c) {
      if (!c.include) item.action = 'skip'
      if (c.roleIds) grants.set(s.repoPath, [...new Set(c.roleIds)])
    }
    if (item.action === 'update' && !grants.has(s.repoPath)) notes.push('Content changed; existing role grants are kept.')
    items.push(item)
  }
  return { items, grants }
}
