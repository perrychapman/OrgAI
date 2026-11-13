/**
 * Host claim, registry and admission (docs/design/parallel-sessions.md 4.5, 4.6).
 *
 * Every host (TUI, exec, management command, desktop) claims `host-<hostInstanceId>` exclusive for its whole life
 * (`claimHost`), writes `control/hosts/<id>.json` and an initial empty `control/hosts/<id>.children.json` BEFORE it
 * returns, so nothing can be spawned before evidence exists. A host is live exactly when its lock is held. Hostless
 * readers use `listHosts`, which only probes (never writes or removes). `takeAdmission` takes the `admission` lock
 * shared (every host, waits) or exclusive (conversion, the desktop; claim).
 *
 * `controlDir` is the control folder itself (`<data folder>/control`, controlPaths(...).root); locks live in
 * `<controlDir>/locks`, registry entries in `<controlDir>/hosts`.
 *
 * Electron-free; relative imports only.
 */
import { mkdirSync, readdirSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { acquireOsLock, LockFileUnsafeError, probeOsLock, type OsLockHandle } from '../store/shared/osLock'
import { unlinkDurable, writeFileAtomic } from '../store/shared/atomicWrite'
import { emptyEvidenceText } from './consumers'
import { HOST_INSTANCE_ID_RE } from './identity'

export interface HostInfo {
  pid: number
  hostKind: string
  appVersion: string
  ownerCwd: string
  projectId?: string
  command: string
  startedAt: string | number
  /** The version epoch E (6.3) read before claiming; the one value version retirement trusts. */
  epoch: number
}

export interface HostRegistryEntry extends HostInfo {
  hostInstanceId: string
}

export const ADMISSION_SHARED_WAIT_MS = 30_000

const locksDir = (controlDir: string): string => join(controlDir, 'locks')
const hostsDir = (controlDir: string): string => join(controlDir, 'hosts')
export const hostLockPath = (controlDir: string, id: string): string => join(locksDir(controlDir), `host-${id}.lock`)
export const hostRegistryPath = (controlDir: string, id: string): string => join(hostsDir(controlDir), `${id}.json`)
export const hostChildrenPath = (controlDir: string, id: string): string => join(hostsDir(controlDir), `${id}.children.json`)
export const admissionLockPath = (controlDir: string): string => join(locksDir(controlDir), 'admission.lock')

export interface HostHandle {
  readonly hostInstanceId: string
  readonly lockPath: string
  readonly registryPath: string
  readonly childrenPath: string
  /**
   * Release the claim. `clean: true` (a normal exit) first removes this host's own json files and, after releasing the
   * lock, its own lock file: the only lock file ever deleted (4.1). Without it everything stays for the next
   * housekeeper (the host is then dead-and-known).
   */
  release(opts?: { clean?: boolean }): void
}

/** Claim `host-<id>` for the process lifetime and write the registry entry and empty evidence. Throws LockBusyError if the id is taken. */
export async function claimHost(opts: { controlDir: string; hostInstanceId: string; info: HostInfo }): Promise<HostHandle> {
  const { controlDir, hostInstanceId: id } = opts
  if (!HOST_INSTANCE_ID_RE.test(id)) throw new Error(`Invalid host instance id: ${String(id)}`)
  mkdirSync(locksDir(controlDir), { recursive: true, mode: 0o700 })
  mkdirSync(hostsDir(controlDir), { recursive: true, mode: 0o700 })
  const lockPath = hostLockPath(controlDir, id)
  const registryPath = hostRegistryPath(controlDir, id)
  const childrenPath = hostChildrenPath(controlDir, id)
  const lock = await acquireOsLock(lockPath, 'exclusive', { waitMs: 0 })
  try {
    // Evidence first: the registry entry is what makes a host known, and the evidence must exist by then.
    writeFileAtomic(childrenPath, emptyEvidenceText(id))
    const entry: HostRegistryEntry = { ...opts.info, hostInstanceId: id }
    writeFileAtomic(registryPath, JSON.stringify(entry, null, 2) + '\n')
  } catch (e) {
    lock.release()
    throw e
  }
  let done = false
  return {
    hostInstanceId: id,
    lockPath,
    registryPath,
    childrenPath,
    release(rel = {}) {
      if (done) return
      done = true
      if (rel.clean) {
        // Registry entry first (the host stops being known), then the evidence.
        for (const f of [registryPath, childrenPath]) {
          try {
            unlinkDurable(f)
          } catch {
            /* best effort: a leftover is swept by housekeeping once the lock is free */
          }
        }
      }
      lock.release()
      if (rel.clean) {
        try {
          unlinkSync(lockPath)
        } catch {
          /* already gone */
        }
      }
    }
  }
}

export type HostState = 'live' | 'dead' | 'unknown'

export interface HostListing {
  hostInstanceId: string
  /** live: lock held; dead: lock free or its file gone; unknown: the lock file is unusable (fail closed). */
  state: HostState
  /** The registry entry, or null when it exists but cannot be read (blocks retirement like a missing one). */
  info: HostRegistryEntry | null
  registryPath: string
  childrenPath: string
}

export interface HostList {
  /** Every registry entry, live or dead. */
  hosts: HostListing[]
  /** Held `host-<id>.lock` files with no registry entry: live hosts that block all version retirement (4.5). */
  unregistered: string[]
}

function probe(path: string): HostState {
  try {
    const p = probeOsLock(path)
    return p === 'held' ? 'live' : 'dead'
  } catch (e) {
    if (e instanceof LockFileUnsafeError) return 'unknown'
    return 'unknown'
  }
}

function readEntry(file: string, id: string): HostRegistryEntry | null {
  try {
    const o = JSON.parse(readFileSync(file, 'utf8')) as Partial<HostRegistryEntry>
    if (!o || o.hostInstanceId !== id || !Number.isSafeInteger(o.pid) || typeof o.epoch !== 'number') return null
    return o as HostRegistryEntry
  } catch {
    return null
  }
}

/** For hostless readers: registry entries with live/dead by probing the host locks, plus held locks without an entry. Writes nothing. */
export function listHosts(controlDir: string): HostList {
  const hosts: HostListing[] = []
  const ids = new Set<string>()
  let names: string[] = []
  try {
    names = readdirSync(hostsDir(controlDir))
  } catch {
    /* no hosts folder yet */
  }
  for (const n of names) {
    const m = /^([0-9a-f]{12})\.json$/.exec(n)
    if (!m) continue
    const id = m[1]
    ids.add(id)
    hosts.push({
      hostInstanceId: id,
      state: probe(hostLockPath(controlDir, id)),
      info: readEntry(join(hostsDir(controlDir), n), id),
      registryPath: hostRegistryPath(controlDir, id),
      childrenPath: hostChildrenPath(controlDir, id)
    })
  }
  const unregistered: string[] = []
  let locks: string[] = []
  try {
    locks = readdirSync(locksDir(controlDir))
  } catch {
    /* no locks folder yet */
  }
  for (const n of locks) {
    const m = /^host-([0-9a-f]{12})\.lock$/.exec(n)
    if (!m || ids.has(m[1])) continue
    if (probe(join(locksDir(controlDir), n)) !== 'dead') unregistered.push(m[1])
  }
  hosts.sort((a, b) => (a.hostInstanceId < b.hostInstanceId ? -1 : 1))
  unregistered.sort()
  return { hosts, unregistered }
}

/** Live hosts as `{ pid, childrenFile }`, the input of consumers.ts collectExcludedPids. */
export function liveHostRefs(list: HostList): { pid: number; childrenFile: string }[] {
  return list.hosts.filter((h) => h.state === 'live' && h.info).map((h) => ({ pid: h.info!.pid, childrenFile: h.childrenPath }))
}

/**
 * Take `admission` (4.6): shared (every host; waits, default 30 s) or exclusive (conversion and other lone operations,
 * the desktop; a claim: `waitMs` 0 unless given). Throws LockBusyError when it cannot.
 */
export async function takeAdmission(controlDir: string, mode: 'shared' | 'exclusive', waitMs?: number): Promise<OsLockHandle> {
  mkdirSync(locksDir(controlDir), { recursive: true, mode: 0o700 })
  return acquireOsLock(admissionLockPath(controlDir), mode, { waitMs: waitMs ?? (mode === 'shared' ? ADMISSION_SHARED_WAIT_MS : 0) })
}
