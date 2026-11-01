import { lstatSync, readdirSync, realpathSync } from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'
import type { CapabilitySourceId, CapabilitySourceStatus } from '@shared/types'
import { SKILL_REPO_ROOTS } from '@shared/types'
import { digestFiles, FolderReader, type FileData } from '../skills/files'
import { buildScannedSkill, isNetworkOrDevicePath, scanRepoSkills, SKILL_MAX_CANDIDATES, type ScannedSkill } from '../skills/scan'
import { capabilityId, clampText, displayPath } from './sanitize'
import { confinedReal, insideFold, localPaths, readBoundedText, samePathFold, usablePath } from './paths'
import type { CandidatePayload, DiscoveredCandidate, LocalContext, SourceResult } from './types'

/**
 * Skill folders found on this computer: the repo's own roots and other tools' folders under the home. Everything read
 * is untrusted: links are refused, caps apply, SKILL.md is re-emitted with name and description only. Never throws.
 */

/** Local skills across every home root and plugin. */
export const LOCAL_SKILL_TOTAL_CAP = 200
const PLUGINS_FILE_CAP = 1024 * 1024
const MAX_PLUGINS = 100
const MAX_ENTRIES_PER_PLUGIN = 5

type SkillFolderPayload = Extract<CandidatePayload, { type: 'skillFolder' }>

const LABELS: Record<'claude-skills' | 'agents-skills' | 'copilot-skills', string> = {
  'claude-skills': 'Claude Code',
  'agents-skills': 'Agent skills folder',
  'copilot-skills': 'GitHub Copilot'
}

const STATUS_LABELS: Record<string, string> = {
  'repo-skills': 'Repository skills',
  'claude-skills': 'Claude Code skills',
  'agents-skills': 'Agent skills folder',
  'copilot-skills': 'GitHub Copilot skills',
  'claude-plugins': 'Claude Code plugins'
}

function skillItem(
  s: ScannedSkill,
  origin: 'repo' | 'local',
  source: CapabilitySourceId,
  sourceLabel: string,
  dir: string,
  location: string
): DiscoveredCandidate['item'] {
  return {
    id: capabilityId(origin, 'skill', dir, s.name),
    kind: 'skill',
    origin,
    source,
    sourceLabel: clampText(sourceLabel, 80),
    location,
    name: clampText(s.name, 64),
    description: clampText(s.description),
    digest: s.digest,
    flags: s.scripts.length ? ['scripts'] : [],
    needsSecrets: [],
    notes: s.notes.slice(0, 5).map((n) => clampText(n, 200))
  }
}

export function discoverRepoSkills(ctx: LocalContext): SourceResult {
  const out: SourceResult = { candidates: [], sources: [], warnings: [] }
  try {
    const scan = scanRepoSkills(ctx.projectPath)
    let rootReal: string | null = null
    try {
      rootReal = realpathSync(ctx.projectPath)
    } catch {
      rootReal = null
    }
    for (const w of scan.warnings) out.warnings.push({ source: 'repo-skills', message: clampText(w, 300) })
    for (const i of scan.invalid) out.warnings.push({ source: 'repo-skills', location: clampText(i.repoPath, 200), message: `Skipped: ${clampText(i.reason, 250)}` })
    if (rootReal) {
      for (const s of scan.skills) {
        const dir = join(rootReal, ...s.repoPath.split('/'))
        const payload: SkillFolderPayload = { type: 'skillFolder', dir, rootReal, sourceDigest: s.sourceDigest, files: s.data, sourceRef: s.repoPath, source: 'repo' }
        out.candidates.push({ item: skillItem(s, 'repo', 'repo-skills', 'This repository', dir, s.repoPath), payload })
      }
    }
    const state = out.candidates.length ? 'found' : scan.roots.length ? 'empty' : 'missing'
    out.sources.push({
      source: 'repo-skills',
      label: STATUS_LABELS['repo-skills']!,
      locations: (scan.roots.length ? scan.roots : [...SKILL_REPO_ROOTS]).slice(0, 10),
      state,
      count: out.candidates.length
    })
  } catch {
    out.sources.push({ source: 'repo-skills', label: STATUS_LABELS['repo-skills']!, locations: [], state: 'error', count: 0, message: 'The repository skills could not be read.' })
  }
  return out
}

interface Budget {
  left: number
  capped: boolean
}

/**
 * Skill folders directly under one root. `base` is the trusted ancestor the root may not leave through a link.
 * Returns the state of the root.
 */
function scanRoot(
  rootAbs: string,
  base: string,
  source: CapabilitySourceId,
  sourceLabel: string,
  home: string,
  budget: Budget,
  out: SourceResult
): 'found' | 'empty' | 'missing' | 'error' {
  const shown = displayPath(rootAbs, home)
  const warn = (message: string, location = shown): void => {
    out.warnings.push({ source, location, message })
  }
  if (!usablePath(rootAbs)) {
    warn('Skipped: not a local absolute path.')
    return 'error'
  }
  let st
  try {
    st = lstatSync(rootAbs)
  } catch {
    return 'missing'
  }
  if (st.isSymbolicLink()) {
    warn('Skipped: the folder is a link.')
    return 'error'
  }
  if (!st.isDirectory()) return 'missing'
  const rootReal = confinedReal(rootAbs, base)
  if (!rootReal) {
    warn('Skipped: the path goes through a link.')
    return 'error'
  }
  let names: string[]
  try {
    names = readdirSync(rootReal).sort()
  } catch {
    warn('Skipped: the folder could not be read.')
    return 'error'
  }
  const reader = new FolderReader(rootReal)
  let candidates = 0
  let found = 0
  for (const name of names) {
    if (!reader.spend()) {
      warn('More than 5,000 folder entries: the rest was not looked at.')
      break
    }
    const folderAbs = join(rootReal, name)
    const loc = displayPath(folderAbs, home)
    let fst
    try {
      fst = lstatSync(folderAbs)
    } catch {
      continue
    }
    if (fst.isSymbolicLink()) {
      warn('Skipped: the skill folder is a link.', loc)
      continue
    }
    if (!fst.isDirectory()) continue
    let inner: string[]
    try {
      inner = readdirSync(folderAbs)
    } catch {
      warn('Skipped: the folder could not be read.', loc)
      continue
    }
    if (!inner.includes('SKILL.md')) continue
    if (++candidates > SKILL_MAX_CANDIDATES) {
      warn(`Only the first ${SKILL_MAX_CANDIDATES} skill folders are looked at.`)
      break
    }
    if (budget.left <= 0) {
      budget.capped = true
      break
    }
    const read = reader.read(folderAbs)
    if (!read.ok) {
      warn(`Skipped: ${clampText(read.reason, 250)}`, loc)
      if (reader.exhausted) break
      continue
    }
    const skill = buildScannedSkill(read.files, name, name, null)
    if (typeof skill === 'string') {
      warn(`Skipped: ${clampText(skill, 250)}`, loc)
      continue
    }
    skill.notes.push(...read.notes)
    budget.left--
    found++
    const payload: SkillFolderPayload = {
      type: 'skillFolder',
      dir: folderAbs,
      rootReal,
      sourceDigest: skill.sourceDigest,
      files: skill.data,
      sourceRef: displayPath(folderAbs, home),
      source: 'local'
    }
    out.candidates.push({ item: skillItem(skill, 'local', source, sourceLabel, folderAbs, loc), payload })
  }
  return found ? 'found' : 'empty'
}

function parsePluginEntries(value: unknown): Array<{ key: string; paths: string[] }> {
  const out: Array<{ key: string; paths: string[] }> = []
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out
  const plugins = (value as { plugins?: unknown }).plugins
  if (!plugins || typeof plugins !== 'object' || Array.isArray(plugins)) return out
  for (const [key, v] of Object.entries(plugins as Record<string, unknown>)) {
    if (out.length >= MAX_PLUGINS) break
    const list = Array.isArray(v) ? v : [v]
    const paths: string[] = []
    for (const e of list.slice(0, MAX_ENTRIES_PER_PLUGIN)) {
      if (e && typeof e === 'object' && typeof (e as { installPath?: unknown }).installPath === 'string') paths.push((e as { installPath: string }).installPath)
    }
    out.push({ key, paths: [...new Set(paths)] })
  }
  return out
}

/** Skills of the user's other tools: Claude Code, agent folders, Copilot and installed Claude Code plugins. */
export function discoverLocalSkills(ctx: LocalContext): SourceResult {
  const out: SourceResult = { candidates: [], sources: [], warnings: [] }
  const budget: Budget = { left: LOCAL_SKILL_TOTAL_CAP, capped: false }
  const home = ctx.homeDir
  try {
    const paths = localPaths(ctx)
    for (const root of paths.skillRoots) {
      const before = out.candidates.length
      const state = scanRoot(root.path, root.base, root.source, LABELS[root.source], home, budget, out)
      out.sources.push({
        source: root.source,
        label: STATUS_LABELS[root.source]!,
        locations: [displayPath(root.path, home)],
        state,
        count: out.candidates.length - before
      })
    }
    out.sources.push(discoverPlugins(ctx, paths, home, budget, out))
    if (budget.capped) out.warnings.push({ source: 'claude-skills', message: `Only the first ${LOCAL_SKILL_TOTAL_CAP} local skills are listed.` })
  } catch {
    out.sources.push({ source: 'claude-skills', label: STATUS_LABELS['claude-skills']!, locations: [], state: 'error', count: 0, message: 'Local skills could not be read.' })
  }
  return out
}

function discoverPlugins(ctx: LocalContext, paths: ReturnType<typeof localPaths>, home: string, budget: Budget, out: SourceResult): CapabilitySourceStatus {
  const source: CapabilitySourceId = 'claude-plugins'
  const status = (state: CapabilitySourceStatus['state'], count: number, locations: string[], message?: string): CapabilitySourceStatus => ({
    source,
    label: STATUS_LABELS[source]!,
    locations: locations.slice(0, 10),
    state,
    count,
    ...(message ? { message } : {})
  })
  const file = paths.pluginsFile
  if (!file) return status('missing', 0, [])
  const loc = displayPath(file.path, home)
  const read = readBoundedText(file.path, file.base, PLUGINS_FILE_CAP)
  if (!read.ok) {
    if (read.state === 'missing') return status('missing', 0, [loc])
    out.warnings.push({ source, location: loc, message: `Skipped: ${read.reason}.` })
    return status('error', 0, [loc], `Skipped: ${read.reason}.`)
  }
  let json: unknown
  try {
    json = JSON.parse(read.text)
  } catch {
    out.warnings.push({ source, location: loc, message: 'Skipped: the file is not valid JSON.' })
    return status('error', 0, [loc], 'The file is not valid JSON.')
  }
  const realRoots: string[] = []
  for (const r of paths.pluginRoots) {
    try {
      realRoots.push(realpathSync(r))
    } catch {
      /* missing root */
    }
  }
  const before = out.candidates.length
  const locations = [loc]
  for (const plugin of parsePluginEntries(json)) {
    const at = plugin.key.lastIndexOf('@')
    const name = at > 0 ? plugin.key.slice(0, at) : plugin.key
    if (!/^[\w.-]{1,64}$/.test(name)) {
      out.warnings.push({ source, location: loc, message: 'Skipped a plugin with an unusual name.' })
      continue
    }
    for (const install of plugin.paths) {
      if (!isAbsolute(install) || isNetworkOrDevicePath(install) || install.includes('\0')) {
        out.warnings.push({ source, location: loc, message: `Skipped plugin ${name}: its folder is not a local absolute path.` })
        continue
      }
      let installReal: string
      try {
        installReal = realpathSync(install)
      } catch {
        continue
      }
      if (!realRoots.some((r) => insideFold(r, installReal))) {
        out.warnings.push({ source, location: loc, message: `Skipped plugin ${name}: its folder is outside the Claude Code plugins folder.` })
        continue
      }
      const skillsDir = join(installReal, 'skills')
      locations.push(displayPath(skillsDir, home))
      scanRoot(skillsDir, installReal, source, `Claude Code plugin ${name}`, home, budget, out)
    }
  }
  const count = out.candidates.length - before
  return status(count ? 'found' : 'empty', count, locations)
}

/**
 * Re-reads a skill folder at apply time with the same rules. Refuses when the folder changed since discovery.
 */
export function rereadSkillFolder(payload: SkillFolderPayload): { ok: true; files: FileData[]; digest: string } | { ok: false; reason: string } {
  const changed = { ok: false as const, reason: 'The skill changed since the recommendation; run it again.' }
  try {
    if (!usablePath(payload.dir) || !usablePath(payload.rootReal)) return { ok: false, reason: 'The skill folder is not a local absolute path.' }
    let real: string
    try {
      real = realpathSync(payload.rootReal)
    } catch {
      return changed
    }
    if (!samePathFold(real, payload.rootReal)) return changed
    const read = new FolderReader(payload.rootReal).read(payload.dir)
    if (!read.ok) return { ok: false, reason: `The skill folder could not be read: ${clampText(read.reason, 200)}` }
    if (digestFiles(read.files) !== payload.sourceDigest) return changed
    const skill = buildScannedSkill(read.files, basename(payload.dir), basename(payload.dir), null)
    if (typeof skill === 'string') return { ok: false, reason: clampText(skill, 250) }
    return { ok: true, files: skill.data, digest: skill.digest }
  } catch {
    return { ok: false, reason: 'The skill folder could not be read.' }
  }
}

