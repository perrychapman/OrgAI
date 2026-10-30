import { randomBytes } from 'node:crypto'
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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

/** Copy one skill; returns false (after calling `warn`) when any listed file is unsafe, leaving the skill out. */
function copySkill(skill: RunSkill, target: string, warn: (m: string) => void): boolean {
  let root: string
  try {
    root = realpathSync(skill.dir)
  } catch {
    warn(`Skill "${skill.name}" left out: its folder is missing.`)
    return false
  }
  if (!safeRelative(skill.name) || skill.name.includes('/')) {
    warn(`Skill "${skill.name}" left out: unsafe name.`)
    return false
  }
  const skillRoot = join(target, 'skills', skill.name)
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
      if (file.path === 'SKILL.md') {
        const text = readFileSync(source, 'utf8')
        if (shellInjectionProblem(skillBody(text))) throw new Error('SKILL.md uses shell injection (!`command`), which OrgAI does not run')
        writeFileSync(dest, sanitizedSkillMd(skill, text))
      } else copyFileSync(source, dest)
    }
    if (!skill.files.some((f) => f.path === 'SKILL.md')) throw new Error('SKILL.md is not listed')
    return true
  } catch (e) {
    rmSync(skillRoot, { recursive: true, force: true })
    warn(`Skill "${skill.name}" left out: ${(e as Error).message}`)
    return false
  }
}

/** Build the run-scoped plugin directory. Skills that fail validation are logged through `warn` and left out. */
export function buildSkillPlugin(skills: RunSkill[], runId: string, warn: (message: string) => void = () => {}): SkillPlugin {
  const path = mkdtempSync(join(tmpdir(), 'orgai-skills-'))
  const pluginName = `orgai-${randomBytes(4).toString('hex')}`
  const names = new Map<string, RunSkill>()
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
      if (copySkill(skill, path, (m) => warn(`${m} (run ${runId})`))) names.set(qualifiedSkillName(pluginName, skill.name), skill)
    }
  } catch (e) {
    cleanup()
    throw e
  }
  return { path, pluginName, cleanup, names }
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
