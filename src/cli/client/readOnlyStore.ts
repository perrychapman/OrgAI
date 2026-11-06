/**
 * ReadOnlyStoreReader (cli-spec 3.2(3)): projects and runs straight from the data dir, for read-only commands that
 * cannot (or need not) reach a host. Never writes, never migrates, never touches `startup.mkdir` (it only reads its
 * owner.json). Pending decision cards live only in a host's memory, so `liveInboxAvailable` is always false.
 *
 * - A live host in state 'starting' (or a live startup.mkdir owner) is polled for up to 2,000 ms; if it is still
 *   starting the files are read as they are (hostState 'starting', nothing normalized).
 * - A live 'ready' / 'draining' host: hostState as advertised, nothing normalized (its runs may really be live).
 * - No live host: hostState 'stopped' and every non-terminal run is normalized in memory with
 *   normalizeCrashedRunSummary (finished, endedBy 'app'), exactly what the next host boot would write.
 */
import { closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import { join } from 'node:path'
import type { DaemonInfo, Project, RunRecord, RunSummary } from '../../shared/types'
import { parseJsonSafe } from '../../main/host/jsonCodec'
import { readDaemonInfo, runDirOf } from '../../main/host/ownership'
import { PARAM_ID_PATTERN } from '../../main/host/params'
import { isLiveProcessCached } from '../../main/host/processInfo'
import { parseProjectsFile } from '../../main/store/projects'
import { normalizeCrashedRunSummary, parseRunIndex, runRecordFileName } from '../../main/store/runs'
import type { ReadOnlySnapshot } from '../types'

export const PROJECTS_FILE_MAX_BYTES = 64 * 1024 * 1024
export const RUNS_INDEX_MAX_BYTES = 64 * 1024 * 1024
export const RUN_RECORD_MAX_BYTES = 256 * 1024 * 1024
const OWNER_JSON_MAX_BYTES = 64 * 1024
const POLL_MS = 100

export interface ReadOnlyStoreOptions {
  dataDir: string
  /** How long a starting host is waited for. Default 2000. */
  waitStartingMs?: number
  isLive?: (pid: number, startTime?: string) => boolean
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

/**
 * A regular file's text, read without following a symlink swap past lstat; undefined when missing, not a regular
 * file or larger than `maxBytes`. Never throws.
 */
export function readCappedFile(path: string, maxBytes: number): string | undefined {
  let fd: number | undefined
  try {
    const st = lstatSync(path)
    if (!st.isFile() || st.size > maxBytes) return undefined
    fd = openSync(path, 'r')
    const fst = fstatSync(fd)
    if (!fst.isFile() || fst.size > maxBytes) return undefined
    const buf = Buffer.alloc(fst.size)
    let off = 0
    while (off < buf.length) {
      const n = readSync(fd, buf, off, buf.length - off, off)
      if (n <= 0) break
      off += n
    }
    return buf.subarray(0, off).toString('utf8')
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // ignore
      }
    }
  }
}

function readJson(path: string, maxBytes: number): unknown {
  const text = readCappedFile(path, maxBytes)
  if (text === undefined) return undefined
  try {
    return parseJsonSafe(text)
  } catch {
    return undefined
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const NON_TERMINAL = new Set(['starting', 'running', 'idle', 'paused', 'stopping'])

/** The live owner of `<run>/startup.mkdir`, if any (read only: owner.json, never the directory itself). */
function startupOwnerLive(dataDir: string, isLive: (pid: number, start?: string) => boolean): boolean {
  const owner = readJson(join(runDirOf(dataDir), 'startup.mkdir', 'owner.json'), OWNER_JSON_MAX_BYTES)
  if (!isObj(owner) || typeof owner.pid !== 'number' || !Number.isInteger(owner.pid) || owner.pid <= 0) return false
  return isLive(owner.pid, typeof owner.processStartTime === 'string' ? owner.processStartTime : undefined)
}

export class ReadOnlyStoreReader {
  constructor(private readonly opts: ReadOnlyStoreOptions) {}

  async read(): Promise<ReadOnlySnapshot> {
    const { dataDir } = this.opts
    const isLive = this.opts.isLive ?? ((pid: number, start?: string) => isLiveProcessCached(pid, start))
    const now = this.opts.now ?? Date.now
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
    const deadline = now() + (this.opts.waitStartingMs ?? 2000)

    let daemon: DaemonInfo | null
    let live: boolean
    let starting: boolean
    for (;;) {
      daemon = readDaemonInfo(dataDir)
      live = !!daemon && isLive(daemon.pid, daemon.processStartTime)
      starting = live ? daemon!.state === 'starting' : startupOwnerLive(dataDir, isLive)
      if (!starting || now() >= deadline) break
      await sleep(Math.min(POLL_MS, Math.max(1, deadline - now())))
    }

    const hostState: ReadOnlySnapshot['hostState'] = starting ? 'starting' : live ? daemon!.state : 'stopped'
    const normalize = hostState === 'stopped'
    const at = now()
    const fix = (r: RunSummary): RunSummary => (normalize && NON_TERMINAL.has(r.status) ? normalizeCrashedRunSummary(r, at) : r)

    let projects: Project[] = []
    const rawProjects = readJson(join(dataDir, 'projects.json'), PROJECTS_FILE_MAX_BYTES)
    if (isObj(rawProjects)) {
      projects = parseProjectsFile(rawProjects).projects.filter((p): p is Project => isObj(p) && typeof p.id === 'string')
    }
    const runs = parseRunIndex(readJson(join(dataDir, 'runs.json'), RUNS_INDEX_MAX_BYTES))
      .map(fix)
      .sort((a, b) => (typeof b.startedAt === 'number' ? b.startedAt : 0) - (typeof a.startedAt === 'number' ? a.startedAt : 0))
    const byId = new Map(runs.map((r) => [r.id, r]))

    const readRecord = (runId: string): RunRecord | null => {
      if (typeof runId !== 'string' || !PARAM_ID_PATTERN.test(runId)) return null
      const raw = readJson(join(dataDir, 'runs', runRecordFileName(runId)), RUN_RECORD_MAX_BYTES)
      if (!isObj(raw)) return null
      const record = raw as unknown as RunRecord
      // The index is the source of truth for status (as RunStore.getRecord); a record alone is normalized too.
      const indexed = byId.get(runId)
      const summary = indexed ?? (isObj(record.summary) && typeof record.summary.id === 'string' ? fix(record.summary) : undefined)
      if (!summary) return null
      return {
        ...record,
        summary,
        agents: isObj(record.agents) ? record.agents : {},
        transcript: Array.isArray(record.transcript) ? record.transcript : [],
        logs: Array.isArray(record.logs) ? record.logs : []
      }
    }

    return {
      hostState,
      liveInboxAvailable: false,
      ...(daemon ? { daemon } : {}),
      projects,
      runs,
      readRecord
    }
  }
}

/** One read-only snapshot of `dataDir`. */
export function readOnlySnapshot(opts: ReadOnlyStoreOptions): Promise<ReadOnlySnapshot> {
  return new ReadOnlyStoreReader(opts).read()
}
