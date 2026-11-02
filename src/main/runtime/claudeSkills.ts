import { createHash, randomBytes } from 'node:crypto'
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { SKILL_MAX_FILE_BYTES } from '@shared/types'
import { shellInjectionProblem } from '../skills/skillMd'
import type { RunSkill } from './types'

/**
 * Run-scoped skills for the Claude adapter. The granted skills are copied from OrgAI's own store into a temporary
 * plugin directory (`.claude-plugin/plugin.json` + `skills/<name>/...`), loaded through Options.plugins. The plugin
 * name namespaces them as `<plugin>:<name>` (verified in the bundled CLI source). The plugin name is random per
 * build (`orgai-<8 hex>`), so a repo skill under .claude/skills (settingSources ['project']) cannot be named to
 * collide with it; the PreToolUse gate (skillGate) is what keeps repo skills out of reach.
 */
export interface SkillPlugin {
  /** Absolute plugin directory (pass to Options.plugins). */
  path: string
  /** The unguessable plugin name; the namespace of every qualified name. */
  pluginName: string
  /** Remove the directory. Idempotent, never throws. */
  cleanup(): void
  /** Qualified name ("<plugin>:<name>") -> skill, for the skills that were copied. */
  names: Map<string, RunSkill>
  /** Skill id -> skillDigest of the source as it was copied (a config change compares the live skill against it). */
  digests: Map<string, string>
  /** Skill id -> skillDigest of a skill left out of the plugin (unchanged since, it is not retried). Missing = none. */
  refused?: Map<string, string>
}

/** Hash state for skillDigest: name, description, then every listed file's path, size and bytes, in list order. */
function digestStart(skill: Pick<RunSkill, 'name' | 'description'>) {
  const h = createHash('sha256')
  h.update(JSON.stringify([skill.name, skill.description]))
  return h
}
function digestFile(h: ReturnType<typeof createHash>, path: string, bytes: Buffer): void {
  h.update(JSON.stringify([path, bytes.length]))
  h.update(bytes)
}

/**
 * A digest of a skill's source (name, description and the listed files' bytes), or null when a listed file cannot be
 * read safely. The Claude adapter compares it with SkillPlugin.digests to tell whether the run plugin's copy is stale
 * after a config change (an 'update' rewrites the files in place, so sizes alone are not enough).
 */
export function skillDigest(skill: RunSkill): string | null {
  try {
    const h = digestStart(skill)
    for (const file of skill.files) {
      const parts = safeRelative(file.path)
      if (!parts) return null
      const source = join(skill.dir, ...parts)
      const st = lstatSync(source)
      if (!st.isFile() || st.isSymbolicLink() || st.size > SKILL_MAX_FILE_BYTES) return null
      digestFile(h, file.path, readFileSync(source))
    }
    return h.digest('hex')
  } catch {
    return null
  }
}

export const qualifiedSkillName = (pluginName: string, name: string): string => `${pluginName}:${name}`

/** A SKILL.md body with its frontmatter removed. Only the body is ever re-emitted. */
export function skillBody(markdown: string): string {
  const text = markdown.replace(/^﻿/, '')
  const m = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)
  return m ? text.slice(m[0].length) : text
}

/** Re-emit SKILL.md with only name and description, so allowed-tools, hooks, model, ... never reach the CLI. */
export function sanitizedSkillMd(skill: RunSkill, markdown: string): string {
  const description = skill.description.replace(/\s+/g, ' ').trim()
  return `---\nname: ${JSON.stringify(skill.name)}\ndescription: ${JSON.stringify(description)}\n---\n${skillBody(markdown)}`
}

/** A safe relative path from a stored file list: '/'-separated, no empty, '.', '..' or absolute parts. */
function safeRelative(path: string): string[] | null {
  if (!path || isAbsolute(path) || path.includes('\\') || path.includes('\0') || /^[a-zA-Z]:/.test(path)) return null
  const parts = path.split('/')
  if (parts.some((p) => !p || p === '.' || p === '..')) return null
  return parts
}

/** Copy one skill; returns its skillDigest, or null (after calling `warn`) when any listed file is unsafe, leaving the skill out. */
function copySkill(skill: RunSkill, target: string, warn: (m: string) => void): string | null {
  let root: string
  try {
    root = realpathSync(skill.dir)
  } catch {
    warn(`Skill "${skill.name}" left out: its folder is missing.`)
    return null
  }
  if (!safeRelative(skill.name) || skill.name.includes('/')) {
    warn(`Skill "${skill.name}" left out: unsafe name.`)
    return null
  }
  const skillRoot = join(target, 'skills', skill.name)
  const h = digestStart(skill)
  try {
    for (const file of skill.files) {
      const parts = safeRelative(file.path)
      if (!parts) throw new Error(`unsafe path ${file.path}`)
      const source = join(skill.dir, ...parts)
      const st = lstatSync(source)
      if (!st.isFile() || st.isSymbolicLink()) throw new Error(`${file.path} is not a regular file`)
      if (st.size > SKILL_MAX_FILE_BYTES) throw new Error(`${file.path} is too large`)
      const real = realpathSync(source)
      const rel = relative(root, real)
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`${file.path} resolves outside the skill folder`)
      const dest = join(skillRoot, ...parts)
      const back = relative(skillRoot, resolve(dest))
      if (back.startsWith('..') || isAbsolute(back) || back.split(sep).includes('..')) throw new Error(`${file.path} escapes`)
      mkdirSync(dirname(dest), { recursive: true })
      const bytes = readFileSync(source)
      digestFile(h, file.path, bytes)
      if (file.path === 'SKILL.md') {
        const text = bytes.toString('utf8')
        if (shellInjectionProblem(skillBody(text))) throw new Error('SKILL.md uses shell injection (!`command`), which OrgAI does not run')
        writeFileSync(dest, sanitizedSkillMd(skill, text))
      } else writeFileSync(dest, bytes)
    }
    if (!skill.files.some((f) => f.path === 'SKILL.md')) throw new Error('SKILL.md is not listed')
    return h.digest('hex')
  } catch (e) {
    rmSync(skillRoot, { recursive: true, force: true })
    warn(`Skill "${skill.name}" left out: ${(e as Error).message}`)
    return null
  }
}

export const SKILL_TEMP_PREFIX = 'orgai-skills-'
export const SKILL_TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000

/**
 * Remove run skill dirs a crash left in the temp dir. Only real directories with the prefix and an mtime older
 * than maxAgeMs go (another OrgAI instance may share the temp dir with live runs). Never throws; returns the count.
 */
export function sweepStaleSkillDirs(opts: { dir?: string; now?: number; maxAgeMs?: number } = {}): number {
  const dir = opts.dir ?? tmpdir()
  const cutoff = (opts.now ?? Date.now()) - (opts.maxAgeMs ?? SKILL_TEMP_MAX_AGE_MS)
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return 0
  }
  let removed = 0
  for (const name of names) {
    if (!name.startsWith(SKILL_TEMP_PREFIX)) continue
    try {
      const full = join(dir, name)
      const st = lstatSync(full)
      if (!st.isDirectory() || st.isSymbolicLink() || st.mtimeMs >= cutoff) continue
      rmSync(full, { recursive: true, force: true })
      removed++
    } catch {
      // skip this entry
    }
  }
  return removed
}

/** Build the run-scoped plugin directory. Skills that fail validation are logged through `warn` and left out. */
export function buildSkillPlugin(skills: RunSkill[], runId: string, warn: (message: string) => void = () => {}): SkillPlugin {
  const path = mkdtempSync(join(tmpdir(), SKILL_TEMP_PREFIX))
  const pluginName = `orgai-${randomBytes(4).toString('hex')}`
  const names = new Map<string, RunSkill>()
  const digests = new Map<string, string>()
  const refused = new Map<string, string>()
  let removed = false
  const cleanup = (): void => {
    if (removed) return
    removed = true
    try {
      rmSync(path, { recursive: true, force: true })
    } catch {
      // best effort: the OS temp dir is swept eventually
    }
  }
  try {
    mkdirSync(join(path, '.claude-plugin'), { recursive: true })
    writeFileSync(
      join(path, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: pluginName, version: '1.0.0', description: 'Skills granted in this OrgAI run' }, null, 2)
    )
    for (const skill of skills) {
      if (names.has(qualifiedSkillName(pluginName, skill.name))) continue
      const digest = copySkill(skill, path, (m) => warn(`${m} (run ${runId})`))
      if (digest === null) {
        const d = skillDigest(skill)
        if (d) refused.set(skill.id, d)
        continue
      }
      names.set(qualifiedSkillName(pluginName, skill.name), skill)
      digests.set(skill.id, digest)
    }
  } catch (e) {
    cleanup()
    throw e
  }
  return { path, pluginName, cleanup, names, digests, refused }
}

export type SkillGateResult = { allow: true; skill: RunSkill } | { allow: false; reason: string }

/**
 * Decide a Skill tool call. Only `<plugin>:<name>` of a skill granted to the calling role passes; a leading "/" is
 * stripped (the CLI does the same). Bare names, other plugins and repo skills are denied, because a bare name
 * resolves to a local (repo) skill first.
 */
export function skillGate(skillInput: unknown, roleId: string, names: Map<string, RunSkill>): SkillGateResult {
  const mine = [...names.entries()].filter(([, s]) => s.roleIds.includes(roleId)).map(([q]) => q)
  const raw = skillInput && typeof skillInput === 'object' ? (skillInput as { skill?: unknown }).skill : undefined
  const requested = typeof raw === 'string' ? raw.trim().replace(/^\//, '') : ''
  const hit = names.get(requested)
  if (hit && hit.roleIds.includes(roleId)) return { allow: true, skill: hit }
  if (names.size === 0) return { allow: false, reason: 'No skills are granted in this run.' }
  const shown = requested || '(none)'
  if (!mine.length) return { allow: false, reason: `Skill "${shown}" is not available: this role has no skills.` }
  return {
    allow: false,
    reason: `Skill "${shown}" is not available to this role. Granted skills: ${mine.map((q) => `"${q}"`).join(', ')}. Use Skill with skill: "${mine[0]}" (always the full name, including the prefix).`
  }
}

/**
 * The plugin's skills with the LIVE grants: each copied skill that is still among `live` (same id and name) carries the
 * live RunSkill.roleIds; a skill removed from the project (or renamed) is left out. The copied content stays the
 * plugin's, so the Skill gate follows a grant, ungrant or removal at the next call without a restart. Pure.
 */
export function livePluginNames(plugin: Pick<SkillPlugin, 'names'> | undefined, live: readonly RunSkill[]): Map<string, RunSkill> {
  const out = new Map<string, RunSkill>()
  if (!plugin) return out
  const byId = new Map(live.map((s) => [s.id, s]))
  for (const [qualified, copied] of plugin.names) {
    const now = byId.get(copied.id)
    if (now && now.name === copied.name) out.set(qualified, { ...copied, roleIds: [...now.roleIds] })
  }
  return out
}

/**
 * True when the run plugin no longer covers the live skills: some skill granted to a role is not in the plugin (new,
 * renamed or left out earlier), or its source changed since it was copied (digest differs or cannot be read). Skills
 * granted to no role and skills removed from the project never make it stale (the gate denies them).
 */
export function pluginStale(
  plugin: Pick<SkillPlugin, 'names' | 'digests' | 'refused'> | undefined,
  live: readonly RunSkill[],
  digest: (s: RunSkill) => string | null = skillDigest
): boolean {
  const copied = new Map([...(plugin?.names.values() ?? [])].map((s) => [s.id, s]))
  for (const s of live) {
    if (!s.roleIds.length) continue
    const old = copied.get(s.id)
    const now = digest(s)
    if (!old) {
      // Left out of this plugin before and unchanged since: a rebuild would leave it out again.
      const refused = plugin?.refused?.get(s.id)
      if (refused && now && refused === now) continue
      return true
    }
    if (old.name !== s.name) return true
    const was = plugin?.digests.get(s.id)
    if (!was || !now || was !== now) return true
  }
  return false
}
