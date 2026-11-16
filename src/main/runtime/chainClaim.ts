/**
 * Chain identity, the chain ownership record and the chain claim (docs/design/parallel-sessions.md 4.3, 5.2-5.3).
 *
 * - `computeChainIds`: connected components over `resumedFrom` edges and shared non-empty `sessionId`s (the rule of
 *   `sessionChain` in runManager.ts and `chainOf` in shared/view/runChains.ts), id = the component's oldest member.
 *   Pass the runs of one project (membership never crosses projects).
 * - The ownership record `control/chains/<chainId>.json` and `classifyChain`.
 * - `ChainWrite`: an opaque write token. The only constructors are inside this module (`claimChain`,
 *   `withChainClaim`); a token is recognised by identity (a WeakSet), so a structurally similar object is refused.
 *   Tokens are invalidated by `invalidateChainWrite` (title cap) and when the claim is released.
 * - `claimChain` / `withChainClaim` / `claimExecChain`: claims never wait (`waitMs` 0); a busy claim throws
 *   LockBusyError, which the caller turns into exit 6.
 *
 * Dormant: nothing calls this yet. Electron-free; relative imports only.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { writeFileAtomic } from '../store/shared/atomicWrite'
import { dataLockPath, withLocks, type LockSpec } from '../store/shared/lockOrder'
import { acquireOsLock, type OsLockHandle } from '../store/shared/osLock'

// ---------- chain identity ----------

export const RUN_ID_RE = /^run_[A-Za-z0-9_-]{1,80}$/

export interface ChainSummaryInput {
  id: string
  startedAt: number | string
  resumedFrom?: string
  sessionId?: string
}

export interface ChainIdsResult {
  /** runId -> chainId, for every valid run. */
  chains: Map<string, string>
  /** Ids that failed validation; they are skipped (not in `chains`) and never join a component. */
  invalid: string[]
}

function startedKey(v: number | string): number {
  if (typeof v === 'number') return v
  const t = Date.parse(v)
  return Number.isFinite(t) ? t : 0
}

/** Union-find over resumedFrom edges (predecessor present in the input) and shared non-empty session ids. */
export function computeChainIdsDetailed(summaries: readonly ChainSummaryInput[]): ChainIdsResult {
  const invalid: string[] = []
  const runs = new Map<string, ChainSummaryInput>()
  for (const s of summaries) {
    if (typeof s.id !== 'string' || !RUN_ID_RE.test(s.id)) {
      invalid.push(String(s.id))
      continue
    }
    if (!runs.has(s.id)) runs.set(s.id, s)
  }
  const parent = new Map<string, string>()
  for (const id of runs.keys()) parent.set(id, id)
  const find = (x: string): string => {
    let r = x
    while (parent.get(r) !== r) r = parent.get(r) as string
    let c = x
    while (parent.get(c) !== r) {
      const n = parent.get(c) as string
      parent.set(c, r)
      c = n
    }
    return r
  }
  const union = (a: string, b: string): void => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }
  const bySession = new Map<string, string>()
  for (const s of runs.values()) {
    if (s.resumedFrom && runs.has(s.resumedFrom)) union(s.id, s.resumedFrom) // a dangling predecessor adds nothing
    if (typeof s.sessionId === 'string' && s.sessionId.length > 0) {
      const first = bySession.get(s.sessionId)
      if (first === undefined) bySession.set(s.sessionId, s.id)
      else union(s.id, first)
    }
  }
  const oldest = new Map<string, ChainSummaryInput>()
  for (const s of runs.values()) {
    const root = find(s.id)
    const cur = oldest.get(root)
    if (!cur || startedKey(s.startedAt) < startedKey(cur.startedAt) || (startedKey(s.startedAt) === startedKey(cur.startedAt) && s.id < cur.id)) {
      oldest.set(root, s)
    }
  }
  const chains = new Map<string, string>()
  for (const s of runs.values()) chains.set(s.id, (oldest.get(find(s.id)) as ChainSummaryInput).id)
  return { chains, invalid }
}

/** runId -> chainId (invalid ids are skipped; use computeChainIdsDetailed to see them). */
export function computeChainIds(summaries: readonly ChainSummaryInput[]): Map<string, string> {
  return computeChainIdsDetailed(summaries).chains
}

export function assertChainId(chainId: string): void {
  if (typeof chainId !== 'string' || !RUN_ID_RE.test(chainId)) throw new Error(`Invalid chain id ${JSON.stringify(chainId)}.`)
}

// ---------- ownership record ----------

export type ChainState = 'open' | 'clean' | 'legacy-uncertain'

export interface ChainRecord {
  hostId: string
  state: ChainState
  since: number
  /** Pids of descendants still running while the record stays open (4.3). */
  lingering?: number[]
}

export type ChainClass = 'normal' | 'unclean' | 'uncertain'

export function chainRecordPath(chainsDir: string, chainId: string): string {
  assertChainId(chainId)
  return join(chainsDir, `${chainId}.json`)
}

/** Read a record. null when missing; throws on a garbled file (fail closed: the caller must not treat it as clean). */
export function readChainRecord(chainsDir: string, chainId: string): ChainRecord | null {
  const file = chainRecordPath(chainsDir, chainId)
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    throw new Error(`The chain record ${file} is not valid JSON.`)
  }
  const r = v as Partial<ChainRecord> | null
  if (!r || typeof r !== 'object' || typeof r.hostId !== 'string' || typeof r.since !== 'number' || !(r.state === 'open' || r.state === 'clean' || r.state === 'legacy-uncertain')) {
    throw new Error(`The chain record ${file} has an unexpected shape.`)
  }
  const out: ChainRecord = { hostId: r.hostId, state: r.state, since: r.since }
  if (Array.isArray(r.lingering) && r.lingering.every((n) => Number.isInteger(n))) out.lingering = r.lingering
  return out
}

/** Write a record atomically (durable). Call under the chain claim. */
export function writeChainRecord(chainsDir: string, chainId: string, record: ChainRecord): void {
  const file = chainRecordPath(chainsDir, chainId)
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  writeFileAtomic(file, JSON.stringify(record) + '\n')
}

export interface ClassifyOptions {
  /** Whether the chain has format-2 runs; decides what a missing record means. Default true. */
  hasFormat2Runs?: boolean
}

/**
 * Classify under the chain claim (4.3): clean -> normal; open -> unclean when its host is not live (a live host
 * re-claiming its own chain, e.g. after a failed final write, is normal); legacy-uncertain -> uncertain; a missing
 * record -> uncertain for a chain with format-2 runs, normal otherwise.
 */
export function classifyChain(record: ChainRecord | null, isHostLive: (hostId: string) => boolean, opts: ClassifyOptions = {}): ChainClass {
  if (!record) return (opts.hasFormat2Runs ?? true) ? 'uncertain' : 'normal'
  if (record.state === 'clean') return 'normal'
  if (record.state === 'legacy-uncertain') return 'uncertain'
  return isHostLive(record.hostId) ? 'normal' : 'unclean'
}

// ---------- ChainWrite token ----------

declare const chainWriteBrand: unique symbol

/** Opaque proof that the holder owns the chain claim. Obtain one only from claimChain / withChainClaim. */
export interface ChainWrite {
  readonly [chainWriteBrand]: true
  readonly chainId: string
}

const issued = new WeakMap<object, { chainId: string; valid: boolean }>()

function issueToken(chainId: string): ChainWrite {
  const token = Object.freeze({ chainId }) as unknown as ChainWrite
  issued.set(token, { chainId, valid: true })
  return token
}

/** Invalidate a token (title cap, release): later assertChainWrite calls throw. */
export function invalidateChainWrite(token: ChainWrite): void {
  const s = issued.get(token)
  if (s) s.valid = false
}

export function isChainWriteValid(token: ChainWrite): boolean {
  return issued.get(token)?.valid === true
}

export class ChainWriteError extends Error {
  readonly code = 'chain-write'
  constructor(message: string) {
    super(message)
    this.name = 'ChainWriteError'
  }
}

/** For RunStore: refuse a forged, invalidated or wrong-chain token. */
export function assertChainWrite(token: ChainWrite | undefined | null, chainId: string): void {
  const s = token ? issued.get(token) : undefined
  if (!s) throw new ChainWriteError('A chain write needs a token from a held chain claim.')
  if (!s.valid) throw new ChainWriteError(`The chain write token for ${s.chainId} is no longer valid.`)
  if (s.chainId !== chainId) throw new ChainWriteError(`The chain write token is for ${s.chainId}, not ${chainId}.`)
}

// ---------- claims ----------

export const chainLockKey = (chainId: string): string => {
  assertChainId(chainId)
  return `chain-${chainId}`
}

/**
 * `execchain-<hash>` where the hash covers the project id and the exec chain id (the exec budget is per project, 4.3).
 * Hashed so ids with dashes or other characters can never make two different pairs share a key.
 */
export function execChainLockKey(projectId: string, execChainId: string): string {
  if (typeof projectId !== 'string' || projectId.length === 0 || projectId.length > 200) throw new Error('Invalid project id.')
  if (typeof execChainId !== 'string' || execChainId.length === 0 || execChainId.length > 200) throw new Error('Invalid exec chain id.')
  const hash = createHash('sha256').update(`${projectId}\0${execChainId}`).digest('hex').slice(0, 32)
  return `execchain-${hash}`
}

export function chainClaimSpec(controlDir: string, chainId: string): LockSpec {
  const key = chainLockKey(chainId)
  return { key, path: dataLockPath(controlDir, key), mode: 'exclusive', kind: 'claim' }
}

export function execChainClaimSpec(controlDir: string, projectId: string, execChainId: string): LockSpec {
  const key = execChainLockKey(projectId, execChainId)
  return { key, path: dataLockPath(controlDir, key), mode: 'exclusive', kind: 'claim' }
}

export interface ChainClaim {
  readonly chainId: string
  readonly token: ChainWrite
  /**
   * Release the claim and invalidate the token. `clean` true first writes the ownership record `clean`; false leaves
   * the record as it is (`open`), as a failed settlement must. Safe to call twice.
   */
  release(clean: boolean): void
}

/** Claim an exec chain (after the chain claim, 4.3). Throws LockBusyError when held. */
export async function claimExecChain(controlDir: string, projectId: string, execChainId: string): Promise<OsLockHandle> {
  const spec = execChainClaimSpec(controlDir, projectId, execChainId)
  return acquireOsLock(spec.path, 'exclusive', { waitMs: 0 })
}

/**
 * Claim `chain-<chainId>` (waitMs 0; LockBusyError when another holder has it, in this process or another) and write
 * the ownership record `open` under it (4.3: before anything for the chain is spawned or written); a new claim starts a
 * fresh `open` (no `lingering`). A caller that must classify the previous record first reads it under the claim with
 * `writeOpen: false`, then calls `markOpen()`.
 */
export async function claimChain(opts: {
  controlDir: string
  chainId: string
  hostId: string
  /** Default true. false: leave the old record untouched until markOpen() (so it can be classified first). */
  writeOpen?: boolean
  now?: () => number
}): Promise<ChainClaim & { markOpen(): void }> {
  const { controlDir, chainId, hostId } = opts
  const spec = chainClaimSpec(controlDir, chainId)
  const chainsDir = join(controlDir, 'chains')
  const handle = await acquireOsLock(spec.path, 'exclusive', { waitMs: 0 })
  const now = opts.now ?? Date.now
  const token = issueToken(chainId)
  let released = false
  const markOpen = (): void => writeChainRecord(chainsDir, chainId, { hostId, state: 'open', since: now() })
  try {
    if (opts.writeOpen !== false) markOpen()
  } catch (e) {
    invalidateChainWrite(token)
    handle.release()
    throw e
  }
  return {
    chainId,
    token,
    markOpen,
    release(clean: boolean): void {
      if (released) return
      released = true
      try {
        if (clean) writeChainRecord(chainsDir, chainId, { hostId, state: 'clean', since: now() })
      } finally {
        invalidateChainWrite(token)
        handle.release()
      }
    }
  }
}

export class ChainMissingError extends Error {
  readonly code = 'chain-missing'
  constructor(readonly chainId: string) {
    super(`The conversation ${chainId} no longer exists.`)
    this.name = 'ChainMissingError'
  }
}

export interface WithChainClaimContext {
  token: ChainWrite
  /** What the ownership record said when the claim was taken (before this claim marked it open). */
  classification: ChainClass
  previous: ChainRecord | null
}

/**
 * Stored-run writes and housekeeping (4.3 "RunStore enforces it"): claim the chain (busy -> LockBusyError), read and
 * classify the ownership record, verify the chain exists (`verifyExists`, injected: at least one summary carries the
 * chainId, re-read from disk by the caller), run `fn`, release. The record is left as found (this is not a session:
 * a `clean` record stays `clean`, an unclean one stays for the consumer check) and the claim is released without
 * rewriting it; an `fn` that settles the chain itself calls release through its own claimChain instead.
 *
 * `isHostLive` and `hasFormat2Runs` default to "no host is live" and true.
 */
export async function withChainClaim<T>(
  controlDir: string,
  chainId: string,
  verifyExists: () => boolean,
  fn: (token: ChainWrite, ctx: WithChainClaimContext) => Promise<T>,
  opts: { isHostLive?: (hostId: string) => boolean; hasFormat2Runs?: boolean } = {}
): Promise<T> {
  const spec = chainClaimSpec(controlDir, chainId)
  return withLocks([spec], async () => {
    const previous = readChainRecord(join(controlDir, 'chains'), chainId)
    const classification = classifyChain(previous, opts.isHostLive ?? (() => false), { hasFormat2Runs: opts.hasFormat2Runs })
    if (!verifyExists()) throw new ChainMissingError(chainId)
    const token = issueToken(chainId)
    try {
      return await fn(token, { token, classification, previous })
    } finally {
      invalidateChainWrite(token)
    }
  })
}

/** Test/diagnostic helper: whether a claim file exists at all. */
export function chainClaimFileExists(controlDir: string, chainId: string): boolean {
  return existsSync(chainClaimSpec(controlDir, chainId).path)
}
