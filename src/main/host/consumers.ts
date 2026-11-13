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
 * Every start time is a canonical tagged token from startTokens.ts (one format per platform, the same for a single pid
 * and for the table). A recorded child with `start: null` is uncertain until it is seen to exit; a failed table read
 * never clears or certifies anything.
 *
 * Liveness and cwd lookups are injectable; the defaults use startTokens.ts and `lsof -a -d cwd -Fn` (macOS/Linux; on
 * Windows the cwd check is 'unavailable' and the caller treats the case as uncertain).
 *
 * Electron-free; relative imports only.
 */
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { probeOsLock } from '../store/shared/osLock'
import { writeFileAtomic } from '../store/shared/atomicWrite'
import { readStartTokenTable, sameStartToken, startTokenOfSync, type StartTokenTable } from './startTokens'
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
  /** Canonical start token (startTokens.ts). `null` when it could not be read: uncertain until seen exited. */
  start: string | null
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
    if (q.start !== undefined && q.start !== null && typeof q.start !== 'string') return null
  }
  for (const c of Object.values(o.chains as Record<string, unknown>)) {
    const q = c as Record<string, unknown>
    if (!q || !strs(q.worktrees) || !strs(q.mcpBuildDirs)) return null
    if (q.scratchDir !== undefined && typeof q.scratchDir !== 'string') return null
  }
  const data = raw as ConsumerEvidenceData
  // A missing start is no token.
  data.descendants = data.descendants.map((d) => ({ pid: d.pid, start: typeof d.start === 'string' ? d.start : null, since: d.since }))
  return data
}

export interface ConsumerEvidenceOptions {
  file: string
  hostInstanceId?: string
  /** The host process whose descendants are recorded (default this process). */
  hostPid?: number
  /** Pids left out with their subtree (the desktop host's own Chromium helpers). */
  exclude?: ReadonlySet<number>
  /** Start-token table reader (default startTokens.ts readStartTokenTable); null means unreadable. */
  readTable?: () => Promise<StartTokenTable | null>
  /** Start token of a just-spawned pid (default startTokenOfSync, synchronous). */
  startTokenOf?: (pid: number) => string | null | 'gone'
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
  /** In-memory only: a counter bumped by every descendant record, and the counter value at which each pid was recorded. */
  private seq = 0
  private readonly recordedAt = new Map<number, number>()

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

  /**
   * Replace a pending spawn with the child's pid and start token. Durable, synchronous. A token that cannot be read
   * records `start: null` (uncertain until seen exited); a child already gone is not recorded.
   */
  resolvePendingSpawn(id: string, child: { pid: number; startToken?: string | null }): void {
    const token = child.startToken !== undefined ? child.startToken : this.safeStartToken(child.pid)
    if (token !== 'gone') this.addDescendant(child.pid, token, true)
    this.data.pending = this.data.pending.filter((p) => p.id !== id)
    this.flush()
  }

  /** Clear a pending spawn whose own start failed (never for an unreadable snapshot). Durable, synchronous. */
  clearPendingSpawn(id: string): void {
    const before = this.data.pending.length
    this.data.pending = this.data.pending.filter((p) => p.id !== id)
    if (this.data.pending.length !== before) this.flush()
  }

  private safeStartToken(pid: number): string | null | 'gone' {
    try {
      return (this.opts.startTokenOf ?? ((p: number) => startTokenOfSync(p, this.platform)))(pid)
    } catch {
      return null
    }
  }

  /** `own`: the token comes from the host's own spawn of this pid (authoritative: it may fill a null token). */
  private addDescendant(pid: number, start: string | null, own = false): void {
    const known = this.data.descendants.find((d) => d.pid === pid)
    if (known) {
      if (known.start === null) {
        if (own && start !== null) known.start = start
        return
      }
      if (start === null || sameStartToken(known.start, start)) return
      // a different incarnation of the same pid: the recorded one has exited
      this.data.descendants = this.data.descendants.filter((d) => d !== known)
    }
    this.data.descendants.push({ pid, start, since: this.now() })
    this.recordedAt.set(pid, ++this.seq)
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

  /** Live (non-root) descendants of the host in the table, breadth first; `exclude` pids are left out with their subtree. */
  private descendantRows(table: StartTokenTable): { pid: number; token: string | null }[] {
    const hostPid = this.opts.hostPid ?? process.pid
    const children = new Map<number, number[]>()
    for (const [pid, row] of table) {
      if (pid === row.ppid) continue
      const list = children.get(row.ppid)
      if (list) list.push(pid)
      else children.set(row.ppid, [pid])
    }
    const ft = (t: string | null | undefined): bigint | undefined => (t && t.startsWith('ft:') ? BigInt(t.slice(3)) : undefined)
    const out: { pid: number; token: string | null }[] = []
    const seen = new Set<number>([hostPid])
    const queue = [hostPid]
    while (queue.length) {
      const pid = queue.shift()!
      const parentTicks = ft(table.get(pid)?.token)
      for (const c of children.get(pid) ?? []) {
        if (seen.has(c)) continue
        const row = table.get(c)!
        // Windows never re-parents: a child created before its claimed parent is a stale-parent orphan.
        const childTicks = ft(row.token)
        if (parentTicks !== undefined && (childTicks === undefined || childTicks < parentTicks)) continue
        seen.add(c)
        if (this.opts.exclude?.has(c)) continue
        queue.push(c)
        out.push({ pid: c, token: row.token })
      }
    }
    return out
  }

  /**
   * Fold one start-token table into the CURRENT state (synchronously, at commit time): add every newly seen live
   * descendant of the host, and drop a recorded descendant only when the table shows it exited (pid missing, or a
   * different token: pid reuse). A reparented descendant stays recorded. A recorded child with a null token stays until
   * its pid is missing; an unreadable token in the table certifies nothing. Entries recorded after `sinceSeq` (the
   * `recordSeq` captured before the table read began) are not judged by this table. Returns whether anything changed.
   */
  snapshot(table: StartTokenTable, sinceSeq: number = Number.POSITIVE_INFINITY): boolean {
    const before = JSON.stringify(this.data.descendants)
    this.data.descendants = this.data.descendants.filter((d) => {
      if ((this.recordedAt.get(d.pid) ?? 0) > sinceSeq) return true
      const row = table.get(d.pid)
      if (!row) return false
      if (d.start === null || row.token === null) return true
      return sameStartToken(d.start, row.token)
    })
    const have = new Set(this.data.descendants.map((d) => d.pid))
    for (const row of this.descendantRows(table)) if (!have.has(row.pid)) this.addDescendant(row.pid, row.token)
    for (const pid of [...this.recordedAt.keys()]) if (!this.data.descendants.some((d) => d.pid === pid)) this.recordedAt.delete(pid)
    const changed = JSON.stringify(this.data.descendants) !== before
    if (changed) this.flush()
    return changed
  }

  /** Read the table and fold it into the current state when the read finishes. An unreadable table changes nothing. */
  async refresh(): Promise<boolean> {
    const startedAt = this.seq
    const table = await (this.opts.readTable ?? (() => readStartTokenTable(this.platform)))()
    if (!table) return false
    return this.snapshot(table, startedAt)
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
  /**
   * Whether `pid` is still the process recorded with `start`: true, false, or 'unknown' (a null recorded token, or the
   * current token cannot be read). Default: startTokens.ts.
   */
  isAlive?: (pid: number, start: string | null) => boolean | 'unknown'
  /** Pids whose working directory is inside any of `paths`; 'unavailable' where there is no such check (Windows). */
  cwdHolders?: (paths: string[]) => CwdHolders | Promise<CwdHolders>
  /** OrgAI-private folders to check in addition to the chain resources in the evidence (harness-workspace, auth-cwd). */
  privatePaths?: string[]
}

export type ConsumerCheckResult = 'pass' | { status: 'live'; pids: number[] } | 'uncertain'

/** Default liveness from startTokens.ts: 'gone' is false; a null recorded or current token is 'unknown'; else a token comparison. */
export function defaultIsAlive(pid: number, start: string | null): boolean | 'unknown' {
  const cur = startTokenOfSync(pid)
  if (cur === 'gone') return false
  if (cur === null || start === null) return 'unknown'
  return sameStartToken(start, cur)
}

/**
 * Pids from `lsof -a -d cwd -Fn` output whose cwd is a path inside one of `paths` (or equal to it). lsof is a POSIX
 * tool and prints POSIX paths, so the separator is always '/' (not path.sep), whatever platform parses the text.
 */
export function parseLsofCwd(text: string, paths: string[], exclude: ReadonlySet<number> = new Set()): number[] {
  const sep = '/'
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
  table: ReadonlyMap<number, { ppid: number }> | null
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
 * The consumer check (4.8): 'uncertain' when the evidence is missing/unreadable or a pending spawn is unresolved or a recorded descendant's token is unknown (null) and its pid still exists;
 * `{ status: 'live', pids }` when a recorded descendant is alive with its start token or a process holds its cwd inside
 * a private path; 'pass' otherwise. A found process wins over uncertainty (the refusal names the pids). A cwd check
 * that is 'unavailable' makes the case uncertain.
 */
export async function consumerCheck(opts: ConsumerCheckOptions): Promise<ConsumerCheckResult> {
  const ev = readEvidence(opts.evidenceFile)
  if (!ev) return 'uncertain'
  const isAlive = opts.isAlive ?? defaultIsAlive
  const live = new Set<number>()
  let unknown = false
  for (const d of ev.descendants) {
    const a = isAlive(d.pid, d.start)
    if (a === true) live.add(d.pid)
    else if (a === 'unknown') unknown = true
  }

  const paths = new Set<string>(opts.privatePaths ?? [])
  for (const c of Object.values(ev.chains)) {
    if (c.scratchDir) paths.add(c.scratchDir)
    for (const w of c.worktrees) paths.add(w)
  }
  const holders = await (opts.cwdHolders ?? defaultCwdHolders())([...paths])
  if (holders !== 'unavailable') for (const p of holders) live.add(p)

  if (live.size > 0) return { status: 'live', pids: [...live].sort((a, b) => a - b) }
  if (ev.pending.length > 0 || unknown || holders === 'unavailable') return 'uncertain'
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

