/**
 * Provider session bindings (docs/design/parallel-sessions.md 4.3 "Provider session binding"): `control/sessions/
 * <key>.json` `{ chainId }` with key = sha256(`<adapter>\0<sessionId>`) says which chain owns a provider session id.
 * Callers hold the chain claim. Publication is atomic and never overwrites: write `<key>.json.tmp-<host>-<random>`
 * with `wx`, fsync, `link` to `<key>.json`, unlink the tmp; EEXIST reads the existing file (same chain = idempotent
 * success, another chain = conflict, unreadable = refuse, never overwrite).
 *
 * Dormant: nothing calls this yet. Electron-free; relative imports only.
 */
import { createHash } from 'node:crypto'
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, unlinkSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { fsyncDirectory, tempPathFor } from '../store/shared/atomicWrite'
import { assertChainId } from './chainClaim'

export type BindingAdapter = 'claude' | 'codex' | 'mock'

export type BindResult =
  | { ok: true; created: boolean }
  | { ok: false; reason: 'conflict'; otherChainId: string }
  | { ok: false; reason: 'unreadable' }

export function bindingKey(adapter: BindingAdapter, sessionId: string): string {
  if (adapter !== 'claude' && adapter !== 'codex' && adapter !== 'mock') throw new Error(`Invalid adapter ${JSON.stringify(adapter)}.`)
  if (typeof sessionId !== 'string' || sessionId.length === 0) throw new Error('A provider session id must be a non-empty string.')
  return createHash('sha256').update(`${adapter}\0${sessionId}`).digest('hex')
}

const BINDING_FILE_RE = /^[0-9a-f]{64}\.json$/

function parseBinding(text: string): string | null {
  try {
    const v = JSON.parse(text) as { chainId?: unknown }
    return v && typeof v.chainId === 'string' && /^run_[A-Za-z0-9_-]{1,80}$/.test(v.chainId) ? v.chainId : null
  } catch {
    return null
  }
}

/** Bind a provider session to a chain (under that chain's claim). Never overwrites an existing binding. */
export function bindProviderSession(opts: { sessionsDir: string; adapter: BindingAdapter; sessionId: string; chainId: string }): BindResult {
  assertChainId(opts.chainId)
  const key = bindingKey(opts.adapter, opts.sessionId)
  mkdirSync(opts.sessionsDir, { recursive: true })
  const target = join(opts.sessionsDir, `${key}.json`)
  // tempPathFor appends `.tmp-<host>-<random>` to the target name, as the spec's naming requires.
  const tmp = tempPathFor(target)
  const fd = openSync(tmp, 'wx', 0o600)
  try {
    const bytes = Buffer.from(JSON.stringify({ chainId: opts.chainId }) + '\n', 'utf8')
    let off = 0
    while (off < bytes.length) off += writeSync(fd, bytes, off, bytes.length - off)
    fsyncSync(fd)
  } catch (e) {
    closeSync(fd)
    try {
      unlinkSync(tmp)
    } catch {
      /* best effort */
    }
    throw e
  }
  closeSync(fd)
  try {
    linkSync(tmp, target)
    fsyncDirectory(opts.sessionsDir)
    return { ok: true, created: true }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    let text: string
    try {
      text = readFileSync(target, 'utf8')
    } catch {
      return { ok: false, reason: 'unreadable' }
    }
    const other = parseBinding(text)
    if (other === null) return { ok: false, reason: 'unreadable' }
    if (other === opts.chainId) return { ok: true, created: false }
    return { ok: false, reason: 'conflict', otherChainId: other }
  } finally {
    try {
      unlinkSync(tmp)
    } catch {
      /* best effort */
    }
  }
}

export interface BindingEntry {
  key: string
  /** null when the file is garbled. */
  chainId: string | null
}

/** Every binding file (temp files and strangers are ignored). */
export function listBindings(sessionsDir: string): BindingEntry[] {
  let names: string[]
  try {
    names = readdirSync(sessionsDir)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw e
  }
  const out: BindingEntry[] = []
  for (const n of names.sort()) {
    if (!BINDING_FILE_RE.test(n)) continue
    let chainId: string | null = null
    try {
      chainId = parseBinding(readFileSync(join(sessionsDir, n), 'utf8'))
    } catch {
      /* unreadable: reported as null */
    }
    out.push({ key: n.slice(0, -5), chainId })
  }
  return out
}

/** Remove the bindings of a chain (5.2; under its claim). Garbled files are left alone. Returns how many were removed. */
export function removeBindingsForChain(sessionsDir: string, chainId: string): number {
  assertChainId(chainId)
  let n = 0
  for (const b of listBindings(sessionsDir)) {
    if (b.chainId !== chainId) continue
    try {
      unlinkSync(join(sessionsDir, `${b.key}.json`))
      n++
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    }
  }
  if (n > 0) fsyncDirectory(sessionsDir)
  return n
}
