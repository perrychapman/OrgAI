import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { isNetworkOrDevicePath } from '../skills/scan'
import type { CapabilitySourceId } from '@shared/types'
import type { LocalContext } from './types'

/**
 * Where local discovery looks, and the one bounded reader every config file goes through. Everything derives from
 * the injected LocalContext (never os.homedir() or process.env). Pure path math plus read-only fs calls; never throws.
 */

/** A file or folder and the trusted base it must stay under (no link anywhere between base and the path). */
export interface LocalLocation {
  path: string
  base: string
}

export interface RepoConfigFile extends LocalLocation {
  /** Project-relative display name. */
  display: string
  /** Which key holds the servers: .vscode/mcp.json uses `servers`. */
  key: 'mcpServers' | 'servers'
}

export interface LocalPaths {
  skillRoots: Array<LocalLocation & { source: Extract<CapabilitySourceId, 'claude-skills' | 'agents-skills' | 'copilot-skills'> }>
  pluginsFile: LocalLocation | null
  /** Folders a plugin's installPath may resolve into (not yet realpath'd). */
  pluginRoots: string[]
  claudeJson: LocalLocation | null
  claudeDesktop: LocalLocation | null
  cursor: LocalLocation | null
  codex: LocalLocation | null
  repo: RepoConfigFile[]
}

/** An absolute, non-UNC, non-device path that is a string. */
export function usablePath(p: unknown): p is string {
  return typeof p === 'string' && p.length > 0 && p.length < 4096 && !p.includes('\0') && isAbsolute(p) && !isNetworkOrDevicePath(p)
}

export function localPaths(ctx: LocalContext): LocalPaths {
  const out: LocalPaths = { skillRoots: [], pluginsFile: null, pluginRoots: [], claudeJson: null, claudeDesktop: null, cursor: null, codex: null, repo: [] }
  const env = ctx.env ?? {}
  const home = ctx.homeDir
  if (usablePath(home)) {
    const at = (...parts: string[]): LocalLocation => ({ path: join(home, ...parts), base: home })
    out.skillRoots.push({ source: 'claude-skills', ...at('.claude', 'skills') })
    out.skillRoots.push({ source: 'agents-skills', ...at('.agents', 'skills') })
    out.skillRoots.push({ source: 'copilot-skills', ...at('.copilot', 'skills') })
    out.pluginsFile = at('.claude', 'plugins', 'installed_plugins.json')
    out.pluginRoots.push(join(home, '.claude', 'plugins'))
    out.claudeJson = at('.claude.json')
    out.cursor = at('.cursor', 'mcp.json')
    const file = 'claude_desktop_config.json'
    if (ctx.platform === 'win32') {
      const appData = usablePath(env.APPDATA) ? env.APPDATA : join(home, 'AppData', 'Roaming')
      out.claudeDesktop = { path: join(appData, 'Claude', file), base: appData }
    } else if (ctx.platform === 'darwin') {
      out.claudeDesktop = at('Library', 'Application Support', 'Claude', file)
    } else {
      const xdg = usablePath(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : null
      out.claudeDesktop = xdg ? { path: join(xdg, 'Claude', file), base: xdg } : at('.config', 'Claude', file)
    }
    const codexHome = usablePath(env.CODEX_HOME) ? env.CODEX_HOME : null
    out.codex = codexHome ? { path: join(codexHome, 'config.toml'), base: codexHome } : at('.codex', 'config.toml')
  }
  const cache = env.CLAUDE_CODE_PLUGIN_CACHE_DIR
  if (usablePath(cache)) out.pluginRoots.push(cache)
  const proj = ctx.projectPath
  if (usablePath(proj)) {
    out.repo.push({ path: join(proj, '.mcp.json'), base: proj, display: '.mcp.json', key: 'mcpServers' })
    out.repo.push({ path: join(proj, '.cursor', 'mcp.json'), base: proj, display: '.cursor/mcp.json', key: 'mcpServers' })
    out.repo.push({ path: join(proj, '.vscode', 'mcp.json'), base: proj, display: '.vscode/mcp.json', key: 'servers' })
  }
  return out
}

const FOLD = process.platform === 'win32' || process.platform === 'darwin'

export function samePathFold(a: string, b: string): boolean {
  return FOLD ? a.toLowerCase() === b.toLowerCase() : a === b
}

/** Whether `target` is `base` or inside it (lexical, both absolute; case-folded where the OS is). */
export function insideFold(base: string, target: string): boolean {
  const b = FOLD ? base.toLowerCase() : base
  const t = FOLD ? target.toLowerCase() : target
  const rel = relative(b, t)
  if (rel === '') return true
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep)
}

/**
 * The real path of `abs` when no link lies between `base` and it (realpath equals the real base plus the relative
 * remainder), else null. A missing path is null too.
 */
export function confinedReal(abs: string, base: string): string | null {
  try {
    if (!usablePath(abs) || !usablePath(base) || !insideFold(base, abs)) return null
    const realBase = realpathSync(base)
    const expected = join(realBase, relative(base, abs))
    const real = realpathSync(abs)
    return samePathFold(real, expected) ? real : null
  } catch {
    return null
  }
}

export type BoundedRead =
  | { ok: true; text: string }
  | { ok: false; state: 'missing' | 'unsafe' | 'big' | 'error'; reason: string }

/**
 * One bounded read of a regular file under `base`: lstat (a link is refused), realpath confinement, then a single
 * O_NOFOLLOW descriptor checked with fstat. Over `cap` bytes is 'big'. Never throws.
 */
export function readBoundedText(abs: string, base: string, cap: number): BoundedRead {
  let fd: number | undefined
  try {
    if (!usablePath(abs) || !usablePath(base)) return { ok: false, state: 'unsafe', reason: 'not a local absolute path' }
    let st
    try {
      st = lstatSync(abs)
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: false, state: 'missing', reason: 'not found' }
      return { ok: false, state: 'error', reason: 'could not be read' }
    }
    if (st.isSymbolicLink()) return { ok: false, state: 'unsafe', reason: 'is a link, skipped' }
    if (!st.isFile()) return { ok: false, state: 'unsafe', reason: 'is not a regular file, skipped' }
    if (confinedReal(abs, base) === null) return { ok: false, state: 'unsafe', reason: 'the path goes through a link, skipped' }
    // Windows gap: constants.O_NOFOLLOW is undefined there, so this open can follow a symlink or junction swapped in
    // after the lstat above. What remains is the realpath confinement check just before and the fstat regular-file
    // check just after; a swap in the short window between them is a TOCTOU race we accept (read-only, capped, and
    // the content is only ever parsed as data, never executed).
    fd = openSync(abs, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const fst = fstatSync(fd)
    if (!fst.isFile()) return { ok: false, state: 'unsafe', reason: 'is not a regular file, skipped' }
    if (fst.size > cap) return { ok: false, state: 'big', reason: 'too large, skipped' }
    const buf = Buffer.alloc(cap + 1)
    let len = 0
    while (len < buf.length) {
      const n = readSync(fd, buf, len, buf.length - len, len)
      if (n <= 0) break
      len += n
    }
    if (len > cap) return { ok: false, state: 'big', reason: 'too large, skipped' }
    return { ok: true, text: buf.subarray(0, len).toString('utf8').replace(/^﻿/, '') }
  } catch {
    return { ok: false, state: 'error', reason: 'could not be read' }
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        /* ignore */
      }
    }
  }
}
