import { createHash } from 'node:crypto'
import { closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, renameSync, rmSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isInside } from '../quick/scratch'

/**
 * Built MCP servers (review M5). A server the MCP assistant builds lives in a scratch workspace that is swept once
 * its run is pruned and that the agent can still change after the user approved it. On approval the workspace is
 * copied to `<data>/mcp-builds/<entryId>/` (a snapshot: regular files only, no links, bounded). No dependencies are
 * installed: a server that needs node_modules must bundle or vendor them (node_modules is never copied).
 */

export const BUILD_MAX_FILES = 2000
export const BUILD_MAX_BYTES = 50 * 1024 * 1024
/** Directory names never copied. */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.claude'])
/** The only shape a build dir name (a library entry id) can have. */
const ENTRY_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

export function buildsRoot(dataDir: string): string {
  return join(dataDir, 'mcp-builds')
}

/** `<data>/mcp-builds/<entryId>` for an id-shaped entry id, else null. */
export function buildDirFor(dataDir: string, entryId: unknown): string | null {
  if (typeof entryId !== 'string' || !ENTRY_ID.test(entryId)) return null
  return join(buildsRoot(dataDir), entryId)
}

/** Delete a build dir (only that exact direct child of mcp-builds, never a link). Never throws. */
export function removeBuildDir(dataDir: string, entryId: unknown): void {
  const dir = buildDirFor(dataDir, entryId)
  if (!dir) return
  try {
    if (existsSync(dir) && lstatSync(dir).isDirectory()) rmSync(dir, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
}

interface Listed {
  rel: string
  abs: string
  size: number
}

/** Walk a directory: regular files only, links skipped, realpath-confined, capped. Throws a readable error. */
function listFiles(workspace: string): Listed[] {
  const realRoot = realpathSync.native(workspace)
  const out: Listed[] = []
  let bytes = 0
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name)
      let st
      try {
        st = lstatSync(abs)
      } catch {
        continue
      }
      // Symlinks, junctions and anything that is not a plain file or directory are neither followed nor copied.
      if (st.isSymbolicLink()) continue
      if (!st.isDirectory() && !st.isFile()) continue
      if (st.isDirectory() && SKIP_DIRS.has(name)) continue
      let real: string
      try {
        real = realpathSync.native(abs)
      } catch {
        continue
      }
      if (!isInside(realRoot, real)) continue
      if (st.isDirectory()) {
        walk(abs)
        continue
      }
      if (out.length + 1 > BUILD_MAX_FILES) throw new Error(`The built server has more than ${BUILD_MAX_FILES} files. Bundle it into fewer files and try again.`)
      bytes += st.size
      if (bytes > BUILD_MAX_BYTES) throw new Error(`The built server is larger than ${BUILD_MAX_BYTES / 1024 / 1024} MB. Bundle it smaller and try again.`)
      out.push({ rel: relative(workspace, abs).split(sep).join('/'), abs, size: st.size })
    }
  }
  walk(workspace)
  return out
}

/** sha256 hex over the sorted relative paths and file bytes. */
function digestFiles(files: Array<{ rel: string; abs: string }>): string {
  const h = createHash('sha256')
  for (const f of [...files].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))) {
    h.update(`${f.rel}\0`)
    const fd = openSync(f.abs, 'r')
    try {
      const buf = Buffer.alloc(65536)
      let n: number
      while ((n = readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n))
    } finally {
      closeSync(fd)
    }
    h.update('\0')
  }
  return h.digest('hex')
}

/** Digest of an existing build dir, by the same rules as the copy. */
export function digestBuildDir(dir: string): string {
  return digestFiles(listFiles(dir))
}

export interface StagedBuild {
  files: number
  bytes: number
  digest: string
  /** Move the staged copy to `<data>/mcp-builds/<entryId>/`, replacing an earlier build. */
  install(): InstalledBuild
  /** Drop the staged copy (when install was never called). */
  discard(): void
}

export interface InstalledBuild {
  dir: string
  /** The save failed: remove the new build and put the earlier one back. */
  rollback(): void
  /** The save worked: drop the earlier build. */
  finish(): void
}

/**
 * Copy `workspace` into a temp dir under mcp-builds (caps checked first, nothing in the final place changes). The
 * caller installs it only after everything else validated.
 */
export function stageBuild(dataDir: string, entryId: string, workspace: string): StagedBuild {
  const dir = buildDirFor(dataDir, entryId)
  if (!dir) throw new Error('The server id is not valid for a build copy.')
  const files = listFiles(workspace)
  const root = buildsRoot(dataDir)
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const stamp = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const tmp = join(root, `.tmp-${entryId}-${stamp}`)
  const old = join(root, `.old-${entryId}-${stamp}`)
  try {
    mkdirSync(tmp, { mode: 0o700 })
    for (const f of files) {
      const to = join(tmp, ...f.rel.split('/'))
      mkdirSync(dirname(to), { recursive: true })
      copyFileSync(f.abs, to)
    }
    const digest = digestFiles(files.map((f) => ({ rel: f.rel, abs: join(tmp, ...f.rel.split('/')) })))
    return {
      files: files.length,
      bytes: files.reduce((n, f) => n + f.size, 0),
      digest,
      discard: () => rmSync(tmp, { recursive: true, force: true }),
      install: () => {
        const hadOld = existsSync(dir)
        if (hadOld) renameSync(dir, old)
        try {
          renameSync(tmp, dir)
        } catch (e) {
          if (hadOld) renameSync(old, dir)
          throw e
        }
        return {
          dir,
          rollback: () => {
            try {
              rmSync(dir, { recursive: true, force: true })
              if (hadOld) renameSync(old, dir)
            } catch {
              /* best effort */
            }
          },
          finish: () => {
            if (hadOld) rmSync(old, { recursive: true, force: true })
          }
        }
      }
    }
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true })
    throw e
  }
}

/** Is `p` an absolute path inside `workspace` (lexically, after resolve)? */
export function insideWorkspace(workspace: string, p: unknown): p is string {
  return typeof p === 'string' && isAbsolute(p) && isInside(workspace, p)
}

/** Map a workspace path to the same relative path under the copy dir. */
export function rewritePath(workspace: string, dir: string, p: string): string {
  return join(dir, relative(resolve(workspace), resolve(p)))
}
