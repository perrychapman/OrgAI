/**
 * Consumers: processes a host started (docs/design/parallel-sessions.md 4.8). The OS frees a dead host's locks, but the
 * agents, shells, git, MCP servers or Codex processes it started may still run. This module is
 *
 * - the evidence a live host keeps (`control/hosts/<hostId>.children.json`): pending spawns, every descendant it has
 *   ever recorded until it was seen to exit (a reparented descendant stays listed), and per-chain resources (scratch
 *   folder, worktrees, MCP build directories). Writes are durable and synchronous (temp file + fsync + rename through
 *   atomicWrite), because the Claude spawn function must record before and right after `child_process.spawn` returns;
 * - the consumer check a reader runs on a dead host's evidence: 'pass', `{ status: 'live', pids }` or 'uncertain';
 * - the retention rule (`canRemoveDeadHostEvidence`): evidence goes only with a free host lock AND a passing check.
 *
 * Liveness and cwd lookups are injectable; the defaults use processInfo.ts and `lsof -a -d cwd -Fn` (macOS/Linux; on
 * Windows the cwd check is 'unavailable' and the caller treats the case as uncertain).
 *
 * Electron-free; relative imports only.
 */
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join, sep } from 'node:path'
import { probeOsLock } from '../store/shared/osLock'
import { writeFileAtomic } from '../store/shared/atomicWrite'
import { descendantsOf, parseProcessTable, readProcessTable, type ProcessTable } from './shutdown'
import { processLiveness, processStartTime, sameStartTime } from './processInfo'
import { neutralCwd } from './systemBinaries'

export const EVIDENCE_VERSION = 1

export interface PendingSpawn {
  id: string
  /** Absent for host-level processes (Codex app-server, MCP stdio servers, git checks). */
  chainId?: string
  kind: string
  since: number
}

export interface RecordedDescendant {
  pid: number
  /** Opaque start time (process table text, whitespace collapsed; or processStartTime). Absent when unknown. */
  start?: string
  since: number
}

export interface ChainResources {
  scratchDir?: string
  worktrees: string[]
  mcpBuildDirs: string[]
}

export interface ConsumerEvidenceData {
  version: typeof EVIDENCE_VERSION
  hostInstanceId?: string
  updatedAt: number
  pending: PendingSpawn[]
  descendants: RecordedDescendant[]
  chains: Record<string, ChainResources>
}

export function emptyEvidence(hostInstanceId?: string, now = Date.now()): ConsumerEvidenceData {
  return { version: EVIDENCE_VERSION, ...(hostInstanceId ? { hostInstanceId } : {}), updatedAt: now, pending: [], descendants: [], chains: {} }
}

export function emptyEvidenceText(hostInstanceId?: string): string {
  return JSON.stringify(emptyEvidence(hostInstanceId), null, 2) + '\n'
}

const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim()

/**
 * Whether two start times can be the same process. Unknown on either side matches (the caller never reports a process
 * gone when unsure); a Windows FILETIME tick count against an ISO instant cannot be compared and also matches.
 */
export function startsMatch(a: string | undefined, b: string | undefined, platform: NodeJS.Platform = process.platform): boolean {
  if (a === undefined || b === undefined || a === '' || b === '') return true
  const x = collapse(a)
  const y = collapse(b)
  if (x === y) return true
  if (platform === 'win32') {
    const xd = /^\d+$/.test(x)
    const yd = /^\d+$/.test(y)
    if (xd !== yd) return true
  }
  return sameStartTime(x, y, platform)
}

/** Read and validate an evidence file; null when missing, unreadable or malformed. */
export function readEvidence(file: string): ConsumerEvidenceData | null {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (o.version !== EVIDENCE_VERSION || !Array.isArray(o.pending) || !Array.isArray(o.descendants)) return null
  if (!o.chains || typeof o.chains !== 'object' || Array.isArray(o.chains)) return null
  const strs = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string')
  for (const p of o.pending) {
    const q = p as Record<string, unknown>
    if (!q || typeof q.id !== 'string' || typeof q.kind !== 'string' || typeof q.since !== 'number') return null
    if (q.chainId !== undefined && typeof q.chainId !== 'string') return null
  }
  for (const d of o.descendants) {
    const q = d as Record<string, unknown>
    if (!q || !Number.isSafeInteger(q.pid) || (q.pid as number) <= 0) return null
    if (q.start !== undefined && typeof q.start !== 'string') return null
  }
  for (const c of Object.values(o.chains as Record<string, unknown>)) {
    const q = c as Record<string, unknown>
    if (!q || !strs(q.worktrees) || !strs(q.mcpBuildDirs)) return null
    if (q.scratchDir !== undefined && typeof q.scratchDir !== 'string') return null
  }
  return raw as ConsumerEvidenceData
}

export interface ConsumerEvidenceOptions {
  file: string
  hostInstanceId?: string
  /** The host process whose descendants are recorded (default this process). */
  hostPid?: number
  /** Pids left out with their subtree (the desktop host's own Chromium helpers). */
  exclude?: ReadonlySet<number>
  /** Process-table reader (default shutdown.ts readProcessTable). */
  readTable?: () => Promise<ProcessTable | null>
  /** Start time of a just-spawned pid (default processStartTime, synchronous). */
  startTimeOf?: (pid: number) => string | undefined
  now?: () => number
  platform?: NodeJS.Platform
}

/**
 * The live host's evidence writer. Every mutator updates memory and writes the file durably before returning; a failed
 * write throws (the caller must not spawn then). Starts from the file's current content when it is valid, else empty.
 */
export class ConsumerEvidence {
  private data: ConsumerEvidenceData
  private readonly now: () => number
  private readonly platform: NodeJS.Platform
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(private readonly opts: ConsumerEvidenceOptions) {
    this.now = opts.now ?? Date.now
    this.platform = opts.platform ?? process.platform
    this.data = readEvidence(opts.file) ?? emptyEvidence(opts.hostInstanceId, this.now())
    if (opts.hostInstanceId) this.data.hostInstanceId = opts.hostInstanceId
  }

  get file(): string {
    return this.opts.file
  }

  /** A copy of the current evidence. */
  current(): ConsumerEvidenceData {
    return JSON.parse(JSON.stringify(this.data)) as ConsumerEvidenceData
  }

  private flush(): void {
    this.data.updatedAt = this.now()
    writeFileAtomic(this.opts.file, JSON.stringify(this.data, null, 2) + '\n')
  }

  /** Record a pending spawn before the process is started. Durable, synchronous. Returns its id. */
  recordPendingSpawn(spawn: { chainId?: string; kind: string }): string {
    const id = randomBytes(6).toString('hex')
    this.data.pending.push({ id, ...(spawn.chainId ? { chainId: spawn.chainId } : {}), kind: spawn.kind, since: this.now() })
    try {
      this.flush()
    } catch (e) {
      this.data.pending = this.data.pending.filter((p) => p.id !== id)
      throw e
    }
    return id
  }

  /** Replace a pending spawn with the child's pid and start time. Durable, synchronous. */
  resolvePendingSpawn(id: string, child: { pid: number; startTime?: string }): void {
    const start = child.startTime ?? this.safeStartTime(child.pid)
    this.addDescendant(child.pid, start)
    this.data.pending = this.data.pending.filter((p) => p.id !== id)
    this.flush()
  }

  /** Clear a pending spawn whose own start failed (never for an unreadable snapshot). Durable, synchronous. */
  clearPendingSpawn(id: string): void {
    const before = this.data.pending.length
    this.data.pending = this.data.pending.filter((p) => p.id !== id)
    if (this.data.pending.length !== before) this.flush()
  }

  private safeStartTime(pid: number): string | undefined {
    try {
      return (this.opts.startTimeOf ?? ((p: number) => processStartTime(p, this.platform)))(pid)
    } catch {
      return undefined
    }
  }

  private addDescendant(pid: number, start: string | undefined): void {
    const s = start === undefined ? undefined : collapse(start)
    const known = this.data.descendants.find((d) => d.pid === pid)
    if (known) {
      if (startsMatch(known.start, s, this.platform)) {
        if (known.start === undefined && s !== undefined) known.start = s
        return
      }
      this.data.descendants = this.data.descendants.filter((d) => d !== known)
    }
    this.data.descendants.push({ pid, ...(s !== undefined ? { start: s } : {}), since: this.now() })
  }

  /** Set or replace one chain's resources (scratch folder, worktree paths, MCP build directories). */
  setChainResources(chainId: string, res: { scratchDir?: string; worktrees?: string[]; mcpBuildDirs?: string[] }): void {
    this.data.chains[chainId] = {
      ...(res.scratchDir ? { scratchDir: res.scratchDir } : {}),
      worktrees: [...(res.worktrees ?? [])],
      mcpBuildDirs: [...(res.mcpBuildDirs ?? [])]
    }
    this.flush()
  }

  /** Drop a chain's resources (run end, after its processes are gone). */
  clearChainResources(chainId: string): void {
    if (chainId in this.data.chains) {
      delete this.data.chains[chainId]
      this.flush()
    }
  }

  /**
   * Fold one process table into the evidence: add every newly seen live descendant of the host, and drop a recorded
   * descendant only when the table shows it exited (missing, zombie, or a different start time: pid reuse). A
   * reparented descendant is still recorded even though it is no longer under the host. Returns whether it changed.
   */
  snapshot(table: ProcessTable): boolean {
    const before = JSON.stringify(this.data.descendants)
    const hostPid = this.opts.hostPid ?? process.pid
    const kept = this.data.descendants.filter((d) => {
      const row = table.get(d.pid)
      if (!row || row.zombie) return false
      return startsMatch(d.start, row.start, this.platform)
    })
    this.data.descendants = kept
    for (const row of descendantsOf(table, hostPid, this.opts.exclude)) this.addDescendant(row.pid, row.start)
    const changed = JSON.stringify(this.data.descendants) !== before
    if (changed) this.flush()
    return changed
  }

  /** Read the process table and fold it in. An unreadable table changes nothing. */
  async refresh(): Promise<boolean> {
    const table = await (this.opts.readTable ?? (() => readProcessTable()))()
    if (!table) return false
    return this.snapshot(table)
  }

  /** Refresh every `intervalMs` (spec: 5 s). The timer does not keep the process alive. */
  start(intervalMs = 5000): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      this.refresh().catch(() => undefined)
    }, intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }
}

// ---------- consumer check ----------

export type CwdHolders = number[] | 'unavailable'

export interface ConsumerCheckOptions {
  evidenceFile: string
  /** True when `pid` is (probably) still the process that recorded `startTime`. Unknown answers must be true. */
  isAlive?: (pid: number, startTime?: string) => boolean
  /** Pids whose working directory is inside any of `paths`; 'unavailable' where there is no such check (Windows). */
  cwdHolders?: (paths: string[]) => CwdHolders | Promise<CwdHolders>
  /** OrgAI-private folders to check in addition to the chain resources in the evidence (harness-workspace, auth-cwd). */
  privatePaths?: string[]
}

export type ConsumerCheckResult = 'pass' | { status: 'live'; pids: number[] } | 'uncertain'

/** Default liveness: pid probe plus start-time comparison; an unknown start time counts as alive (never reports gone when unsure). */
export function defaultIsAlive(pid: number, startTime?: string): boolean {
  const platform = process.platform
  const liveness = processLiveness(pid, startTime === undefined ? undefined : startTime, {
    // Windows table ticks and processStartTime instants are not comparable: probe by pid only there.
    startTimeOf: (p) => {
      const cur = processStartTime(p, platform)
      if (cur === undefined) return undefined
      return startsMatch(startTime, cur, platform) ? startTime : cur
    }
  })
  return liveness !== 'dead'
}

/** Pids from `lsof -a -d cwd -Fn` output whose cwd is a path inside one of `paths` (or equal to it). */
export function parseLsofCwd(text: string, paths: string[], exclude: ReadonlySet<number> = new Set()): number[] {
  const roots = paths.map((p) => (p.endsWith(sep) ? p.slice(0, -1) : p)).filter((p) => p.length > 0)
  const out = new Set<number>()
  let pid: number | undefined
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('p')) pid = Number(line.slice(1))
    else if (line.startsWith('n') && pid !== undefined && Number.isSafeInteger(pid)) {
      const dir = line.slice(1)
      if (exclude.has(pid)) continue
      if (roots.some((r) => dir === r || dir.startsWith(r + sep))) out.add(pid)
    }
  }
  return [...out].sort((a, b) => a - b)
}

/** The default cwd check: `lsof -a -d cwd -Fn`. 'unavailable' on Windows and when lsof cannot run. */
export function defaultCwdHolders(exclude: ReadonlySet<number> | (() => ReadonlySet<number> | Promise<ReadonlySet<number>>) = new Set()) {
  return async (paths: string[]): Promise<CwdHolders> => {
    if (process.platform === 'win32') return 'unavailable'
    if (paths.length === 0) return []
    const skip = typeof exclude === 'function' ? await exclude() : exclude
    const text = await new Promise<string | null>((resolve) => {
      try {
        execFile(
          'lsof',
          ['-a', '-d', 'cwd', '-Fn'],
          { encoding: 'utf8', timeout: 15_000, maxBuffer: 64 * 1024 * 1024, cwd: neutralCwd(), windowsHide: true },
          // lsof exits 1 when it found nothing on some systems and prints warnings for unreadable processes: judge the output.
          (err, stdout) => resolve(err && !stdout ? null : String(stdout ?? ''))
        )
      } catch {
        resolve(null)
      }
    })
    if (text === null) return 'unavailable'
    return parseLsofCwd(text, paths, skip)
  }
}

/** Pids the cwd check must not count: this process, its ancestors, live hosts and their recorded descendants. */
export function collectExcludedPids(opts: {
  table: ProcessTable | null
  liveHosts: { pid: number; childrenFile: string }[]
  selfPid?: number
}): Set<number> {
  const out = new Set<number>()
  const self = opts.selfPid ?? process.pid
  out.add(self)
  if (opts.table) {
    let pid = opts.table.get(self)?.ppid
    const seen = new Set<number>()
    while (pid !== undefined && pid > 0 && !seen.has(pid)) {
      seen.add(pid)
      out.add(pid)
      pid = opts.table.get(pid)?.ppid
    }
  } else if (typeof process.ppid === 'number') out.add(process.ppid)
  for (const h of opts.liveHosts) {
    out.add(h.pid)
    for (const d of readEvidence(h.childrenFile)?.descendants ?? []) out.add(d.pid)
  }
  return out
}

/**
 * The consumer check (4.8): 'uncertain' when the evidence is missing/unreadable or a pending spawn is unresolved;
 * `{ status: 'live', pids }` when a recorded descendant is alive with its start time or a process holds its cwd inside
 * a private path; 'pass' otherwise. A found process wins over uncertainty (the refusal names the pids). A cwd check
 * that is 'unavailable' makes the case uncertain.
 */
export async function consumerCheck(opts: ConsumerCheckOptions): Promise<ConsumerCheckResult> {
  const ev = readEvidence(opts.evidenceFile)
  if (!ev) return 'uncertain'
  const isAlive = opts.isAlive ?? defaultIsAlive
  const live = new Set<number>()
  for (const d of ev.descendants) if (isAlive(d.pid, d.start)) live.add(d.pid)

  const paths = new Set<string>(opts.privatePaths ?? [])
  for (const c of Object.values(ev.chains)) {
    if (c.scratchDir) paths.add(c.scratchDir)
    for (const w of c.worktrees) paths.add(w)
  }
  const holders = await (opts.cwdHolders ?? defaultCwdHolders())([...paths])
  if (holders !== 'unavailable') for (const p of holders) live.add(p)

  if (live.size > 0) return { status: 'live', pids: [...live].sort((a, b) => a - b) }
  if (ev.pending.length > 0 || holders === 'unavailable') return 'uncertain'
  return 'pass'
}

export interface CanRemoveOptions extends Omit<ConsumerCheckOptions, 'evidenceFile'> {
  /** The control directory (`<data>/control`). */
  controlDir: string
  hostInstanceId: string
}

/**
 * Evidence retention (4.8): a dead host's children.json, registry entry and lock file may be removed only when its lock
 * is free (or already gone) and its consumer check passes. Uncertain evidence keeps them. (The user's confirmation,
 * `--after-crash`, is the caller's other path and does not come through here.)
 */
export async function canRemoveDeadHostEvidence(opts: CanRemoveOptions): Promise<boolean> {
  const lock = probeOsLock(join(opts.controlDir, 'locks', `host-${opts.hostInstanceId}.lock`))
  if (lock === 'held') return false
  const result = await consumerCheck({ ...opts, evidenceFile: join(opts.controlDir, 'hosts', `${opts.hostInstanceId}.children.json`) })
  return result === 'pass'
}

/** Test and tooling helper: parse a `ps` table text. */
export { parseProcessTable }
