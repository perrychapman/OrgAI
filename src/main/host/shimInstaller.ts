/**
 * Cleanup of the old orgai command shim an older OrgAI app wrote (cli-standalone-default.md 5.3). The app writes no
 * shim any more: this module only looks at the file at the shim path and removes it when it is OrgAI's own.
 * packagedLayout.ts holds the shim path and the marker test. No electron import.
 *
 * Rules: a file at the shim path that does not carry the OrgAI marker (or is a symlink, or not a regular file) is
 * never touched. Ownership is checked again right before the unlink. Nothing here edits a shell profile, the registry
 * or PATH.
 */
import * as nodeFs from 'node:fs'
import { log as appLog } from '../log'
import { cliShimPath, isOrgaiShim } from './packagedLayout'

/** The file-system calls the service makes (sync node:fs shapes); injectable so tests can simulate races. */
export interface OldShimFs {
  lstatSync: (path: string) => nodeFs.Stats
  readFileSync: (path: string, encoding: 'utf8') => string
  unlinkSync: (path: string) => void
}

export interface OldShimDeps {
  platform: NodeJS.Platform
  home: string
  env: NodeJS.ProcessEnv
  fs?: Partial<OldShimFs>
  log?: { info: (m: string) => void; warn: (m: string) => void }
}

/** 'none': nothing at the path. 'ours': a regular file with the OrgAI marker. 'foreign': anything else there. */
export type OldShimKind = 'none' | 'ours' | 'foreign'

export interface OldShimResult {
  ok: boolean
  message: string
}

export interface OldShimService {
  /** Where the old shim lived (`~/.local/bin/orgai`, `%LOCALAPPDATA%\OrgAI\bin\orgai.cmd`). */
  path(): string
  inspect(): OldShimKind
  /** Removes the shim when it is OrgAI's; a foreign file is refused and left alone. Never throws. */
  remove(): OldShimResult
}

/** A shim is a few hundred bytes: anything bigger at the path is not ours and is never read whole. */
const SHIM_MAX_BYTES = 64 * 1024

const defaultFs: OldShimFs = {
  lstatSync: (p) => nodeFs.lstatSync(p),
  readFileSync: (p, e) => nodeFs.readFileSync(p, e),
  unlinkSync: (p) => nodeFs.unlinkSync(p)
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function isMissing(e: unknown): boolean {
  const code = (e as { code?: unknown } | undefined)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

export function createOldShimService(deps: OldShimDeps): OldShimService {
  const fs: OldShimFs = { ...defaultFs, ...(deps.fs ?? {}) }
  const log = deps.log ?? appLog
  const path = cliShimPath(deps.platform, deps.env, deps.home)

  /** What sits at the shim path. Never follows a symlink. */
  function inspect(): OldShimKind {
    let st: nodeFs.Stats
    try {
      st = fs.lstatSync(path)
    } catch (e) {
      return isMissing(e) ? 'none' : 'foreign'
    }
    if (st.isSymbolicLink() || !st.isFile() || st.size > SHIM_MAX_BYTES) return 'foreign'
    try {
      return isOrgaiShim(fs.readFileSync(path, 'utf8')) ? 'ours' : 'foreign'
    } catch {
      return 'foreign'
    }
  }

  function remove(): OldShimResult {
    const before = inspect()
    if (before === 'none') return { ok: true, message: 'The old orgai command is already gone.' }
    if (before === 'foreign') return { ok: false, message: `${path} was not written by OrgAI. OrgAI leaves it alone.` }
    try {
      // Re-check right before the unlink: only a regular file with the marker is removed.
      if (inspect() !== 'ours') return { ok: false, message: `${path} was not written by OrgAI. OrgAI leaves it alone.` }
      fs.unlinkSync(path)
    } catch (e) {
      if (isMissing(e)) return { ok: true, message: 'The old orgai command is already gone.' }
      log.warn(`old orgai command: removing ${path} failed: ${errorText(e)}`)
      return { ok: false, message: `OrgAI could not remove the old orgai command: ${errorText(e)}` }
    }
    log.info(`old orgai command: removed ${path}.`)
    return { ok: true, message: `Removed the old orgai command (${path}).` }
  }

  return { path: () => path, inspect, remove }
}
