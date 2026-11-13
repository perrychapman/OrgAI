/**
 * Generic journal engine for multi-file operations (docs/design/parallel-sessions.md 4.9). Operation-agnostic: a
 * journal is a list of steps, each with a `kind` that names a `StepHandler` (precondition, postcondition, idempotent
 * apply, optional conditional inverse). Phase 1 is dormant: no service uses it yet.
 *
 * `controlDir` is the `control/` directory (`controlPaths(root).root`). Layout under it:
 *   journal/ops/<opId>.json                    the canonical journal (the only source of state)
 *   journal/by-resource/<key>/<opId>           empty local locator per resource key
 * and, for shared files (output files), `<cacheJournalDir>/<key>/<folderId>-<opId>.json` = `{ dataFolder, opId }`.
 *
 * Durable ordering (4.9): (1) every locator is written and its directory fsynced, THEN the canonical journal;
 * (2) per step: `started` (durable), effect, `done` (durable); (3) `committed` only when every step is done;
 * (4) locators removed, then the canonical journal, directories fsynced. State is always read from the canonical file.
 *
 * Electron-free; relative imports only.
 */
import { mkdirSync, openSync, closeSync, readFileSync, readdirSync, rmdirSync } from 'node:fs'
import { join } from 'node:path'
import { fsyncDirectory as fsyncDirectoryRaw, unlinkDurable as unlinkDurableRaw, writeFileAtomic } from './atomicWrite'
import { isLockKey } from './lockOrder'

export interface JournalStep {
  id: string
  kind: string
  args: unknown
  started?: boolean
  done?: boolean
  undone?: boolean
}

export type JournalState = 'active' | 'abandoned' | 'committed' | 'needs-attention'

/** What beginJournal needs to write shared locators. `cacheJournalDir` is never persisted (see PersistedSharedLocators). */
export interface SharedLocatorSpec {
  cacheJournalDir: string
  resourceKeys: string[]
  folderId: string
}

/**
 * The shared-locator part of a canonical journal. The cache directory is deliberately absent: a journal file is data
 * another process could have planted, so recovery takes the directory from its caller (the user cache it computes
 * itself), never from the file. A legacy `cacheJournalDir` field in a file is ignored.
 */
export interface PersistedSharedLocators {
  resourceKeys: string[]
  folderId: string
}

export interface JournalRecord {
  opId: string
  op: string
  hostId: string
  requiredLocks: string[]
  resources: string[]
  rule: 'forward' | 'back'
  steps: JournalStep[]
  state: JournalState
  /**
   * Added beyond the spec's record shape: recovery needs the shared-locator keys and folder id to repair or remove
   * shared locators, and `controlDir` alone cannot supply them (spec gap, see report).
   */
  sharedLocators?: PersistedSharedLocators
  /** Added: the step that put the journal into needs-attention, and why. */
  attention?: { stepId: string; reason: string }
}

export interface StepHandler {
  /** The target is in the state before the step. */
  pre(args: unknown): boolean
  /** The target already shows the step's effect. */
  post(args: unknown): boolean
  apply(args: unknown): void | Promise<void>
  inverse?(args: unknown): void | Promise<void>
}

export type StepHandlers = Record<string, StepHandler>

export interface JournalHandle {
  controlDir: string
  record: JournalRecord
  /** The caller's cache journal directory; required when `record.sharedLocators` is set. */
  cacheJournalDir?: string
}

export interface RecoverOptions {
  /** The user cache journal directory, computed by the caller (cachePaths().journal); never read from the journal. */
  cacheJournalDir?: string
}

export type RecoverResult =
  | { status: 'removed' }
  | { status: 'committed' }
  | { status: 'rolled-back' }
  | { status: 'needs-attention'; stepId: string; reason: string }

export interface PendingJournal {
  opId: string
  record: JournalRecord
}

const OP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/
const FOLDER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
/** Step ids and step kinds: plain names (a kind is looked up as an own property of the handler table). */
const STEP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/

export class JournalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'JournalError'
  }
}

export function assertOpId(opId: string): void {
  if (typeof opId !== 'string' || !OP_ID_RE.test(opId)) throw new JournalError(`Invalid journal operation id ${JSON.stringify(opId)}`)
}
export function assertResourceKey(key: string): void {
  if (typeof key !== 'string' || !KEY_RE.test(key) || key === '.' || key === '..') {
    throw new JournalError(`Invalid journal resource key ${JSON.stringify(key)}`)
  }
}
function assertFolderId(id: string): void {
  if (typeof id !== 'string' || !FOLDER_ID_RE.test(id)) throw new JournalError(`Invalid folder id ${JSON.stringify(id)}`)
}
function assertRequiredLock(key: string): void {
  if (typeof key !== 'string' || !isLockKey(key)) throw new JournalError(`Invalid required lock ${JSON.stringify(key)}`)
}

/** Validate every name a journal carries (shared by beginJournal and the reader). Throws JournalError. */
function assertRecordNames(r: {
  opId: string
  resources: readonly string[]
  requiredLocks: readonly string[]
  steps: readonly { id: string; kind: string }[]
}): void {
  assertOpId(r.opId)
  for (const k of r.resources) assertResourceKey(k)
  for (const k of r.requiredLocks) assertRequiredLock(k)
  const ids = new Set<string>()
  for (const s of r.steps) {
    if (typeof s.id !== 'string' || !STEP_NAME_RE.test(s.id)) throw new JournalError(`Invalid step id ${JSON.stringify(s.id)}`)
    if (typeof s.kind !== 'string' || !STEP_NAME_RE.test(s.kind)) throw new JournalError(`Invalid step kind ${JSON.stringify(s.kind)}`)
    if (ids.has(s.id)) throw new JournalError(`Duplicate step id ${JSON.stringify(s.id)}`)
    ids.add(s.id)
  }
}

// ---------------------------------------------------------------- paths

const opsDir = (controlDir: string): string => join(controlDir, 'journal', 'ops')
const byResourceDir = (controlDir: string): string => join(controlDir, 'journal', 'by-resource')
export const canonicalPath = (controlDir: string, opId: string): string => join(opsDir(controlDir), `${opId}.json`)
export const localLocatorPath = (controlDir: string, key: string, opId: string): string =>
  join(byResourceDir(controlDir), key, opId)
export const sharedLocatorPath = (cacheJournalDir: string, key: string, folderId: string, opId: string): string =>
  join(cacheJournalDir, key, `${folderId}-${opId}.json`)

// ---------------------------------------------------------------- low-level helpers

/** `unlinkDurable` throws ENOENT when the parent directory is gone (its fsync); here a missing path is fine. */
function unlinkDurable(file: string): void {
  try {
    unlinkDurableRaw(file)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
}

function fsyncDirectory(dir: string): boolean {
  try {
    return fsyncDirectoryRaw(dir)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw e
  }
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
}

function touchEmpty(file: string): void {
  closeSync(openSync(file, 'a', 0o600))
}

/** The cache directory for a record's shared locators; fails closed when the record has some and the caller gave none. */
function cacheDirFor(record: JournalRecord, cacheJournalDir: string | undefined): string | null {
  if (!record.sharedLocators) return null
  if (typeof cacheJournalDir !== 'string' || cacheJournalDir.length === 0) {
    throw new JournalError(`Journal ${record.opId} has shared locators; the cache journal directory must be given`)
  }
  return cacheJournalDir
}

function persist(h: JournalHandle): void {
  ensureDir(opsDir(h.controlDir))
  writeFileAtomic(canonicalPath(h.controlDir, h.record.opId), JSON.stringify(h.record))
}

function tryRmdir(dir: string): void {
  try {
    rmdirSync(dir)
  } catch {
    /* not empty or gone */
  }
}

/** Create every missing local and shared locator, fsyncing their directories. Never touches the canonical file. */
function writeLocators(controlDir: string, record: JournalRecord, cacheJournalDir: string | undefined): void {
  const cacheDir = cacheDirFor(record, cacheJournalDir)
  const touched = new Set<string>()
  for (const key of record.resources) {
    const dir = join(byResourceDir(controlDir), key)
    ensureDir(dir)
    touchEmpty(join(dir, record.opId))
    touched.add(dir)
  }
  const sh = record.sharedLocators
  if (sh && cacheDir) {
    for (const key of sh.resourceKeys) {
      const dir = join(cacheDir, key)
      ensureDir(dir)
      writeFileAtomic(sharedLocatorPath(cacheDir, key, sh.folderId, record.opId), JSON.stringify({ dataFolder: dataFolderOf(controlDir), opId: record.opId }))
      touched.add(dir)
    }
  }
  for (const dir of touched) fsyncDirectory(dir)
  // The new key directories themselves must be reachable after a power loss.
  fsyncDirectory(byResourceDir(controlDir))
  if (cacheDir) fsyncDirectory(cacheDir)
}

/** The data folder is the parent of `control/`. */
function dataFolderOf(controlDir: string): string {
  return join(controlDir, '..')
}

/** Remove every locator (local and shared) of the record, then fsync directories. Missing is fine. */
function removeLocators(controlDir: string, record: JournalRecord, cacheJournalDir: string | undefined): void {
  const cacheDir = cacheDirFor(record, cacheJournalDir)
  const dirs: string[] = []
  for (const key of record.resources) {
    const dir = join(byResourceDir(controlDir), key)
    unlinkDurable(join(dir, record.opId))
    tryRmdir(dir)
    dirs.push(byResourceDir(controlDir))
  }
  const sh = record.sharedLocators
  if (sh && cacheDir) {
    for (const key of sh.resourceKeys) {
      const dir = join(cacheDir, key)
      unlinkDurable(sharedLocatorPath(cacheDir, key, sh.folderId, record.opId))
      tryRmdir(dir)
      dirs.push(cacheDir)
    }
  }
  for (const d of new Set(dirs)) fsyncDirectory(d)
}

/** Step (4): locators, then the canonical journal, directories fsynced. */
function removeJournal(controlDir: string, record: JournalRecord, cacheJournalDir: string | undefined): void {
  removeLocators(controlDir, record, cacheJournalDir)
  unlinkDurable(canonicalPath(controlDir, record.opId))
  fsyncDirectory(opsDir(controlDir))
}

const isBool = (v: unknown): boolean => v === undefined || typeof v === 'boolean'

/**
 * Validate a canonical journal read from disk (it is data: any process with access to control/ could have written
 * it). Every name that becomes a path or a lookup key is checked; the result is rebuilt from known fields only, so a
 * planted `cacheJournalDir` or any other extra field never reaches recovery.
 */
function validateRecord(raw: unknown, opId: string): JournalRecord {
  const unreadable = (): JournalError => new JournalError(`Journal ${opId} is unreadable`)
  const r = raw as Partial<JournalRecord> | null
  if (
    !r || typeof r !== 'object' || r.opId !== opId || typeof r.op !== 'string' || typeof r.hostId !== 'string' ||
    !Array.isArray(r.steps) || !Array.isArray(r.resources) || !Array.isArray(r.requiredLocks) ||
    (r.rule !== 'forward' && r.rule !== 'back') ||
    !['active', 'abandoned', 'committed', 'needs-attention'].includes(r.state as string)
  ) {
    throw unreadable()
  }
  const steps: JournalStep[] = []
  for (const s of r.steps as unknown[]) {
    const x = s as Partial<JournalStep> | null
    if (!x || typeof x !== 'object' || !isBool(x.started) || !isBool(x.done) || !isBool(x.undone)) throw unreadable()
    const step: JournalStep = { id: x.id as string, kind: x.kind as string, args: x.args }
    if (x.started !== undefined) step.started = x.started
    if (x.done !== undefined) step.done = x.done
    if (x.undone !== undefined) step.undone = x.undone
    steps.push(step)
  }
  const out: JournalRecord = {
    opId,
    op: r.op,
    hostId: r.hostId,
    requiredLocks: [...(r.requiredLocks as string[])],
    resources: [...(r.resources as string[])],
    rule: r.rule,
    steps,
    state: r.state as JournalState
  }
  assertRecordNames(out)
  if (r.sharedLocators !== undefined) {
    const sh = r.sharedLocators as Partial<PersistedSharedLocators> | null
    if (!sh || typeof sh !== 'object' || !Array.isArray(sh.resourceKeys)) throw unreadable()
    assertFolderId(sh.folderId as string)
    for (const k of sh.resourceKeys) assertResourceKey(k as string)
    out.sharedLocators = { resourceKeys: [...sh.resourceKeys], folderId: sh.folderId as string }
  }
  if (r.attention !== undefined) {
    const a = r.attention as { stepId?: unknown; reason?: unknown } | null
    if (!a || typeof a !== 'object' || typeof a.stepId !== 'string' || typeof a.reason !== 'string') throw unreadable()
    out.attention = { stepId: a.stepId, reason: a.reason }
  }
  return out
}

/** Read the canonical journal; null when absent; throws JournalError when unreadable. */
export function readJournal(controlDir: string, opId: string): JournalRecord | null {
  assertOpId(opId)
  let text: string
  try {
    text = readFileSync(canonicalPath(controlDir, opId), 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new JournalError(`Journal ${opId} is unreadable`)
  }
  return validateRecord(raw, opId)
}

// ---------------------------------------------------------------- begin / run / commit

/**
 * Durable ordering step (1): locators first (fsynced), then the canonical journal. Throws on invalid ids or keys
 * before writing anything.
 */
export function beginJournal(
  controlDir: string,
  record: Omit<JournalRecord, 'state'> & { state?: JournalState },
  opts?: { sharedLocators?: SharedLocatorSpec }
): JournalHandle {
  assertRecordNames(record)
  const full: JournalRecord = {
    ...record,
    steps: record.steps.map((s) => ({ ...s })),
    state: 'active'
  }
  // A shared-locator spec on the record itself is never trusted (it may carry a directory); only opts count.
  delete full.sharedLocators
  let cacheJournalDir: string | undefined
  if (opts?.sharedLocators) {
    const sh = opts.sharedLocators
    assertFolderId(sh.folderId)
    for (const k of sh.resourceKeys) assertResourceKey(k)
    full.sharedLocators = { resourceKeys: [...sh.resourceKeys], folderId: sh.folderId }
    cacheJournalDir = sh.cacheJournalDir
  }
  writeLocators(controlDir, full, cacheJournalDir)
  const h: JournalHandle = { controlDir, record: full, cacheJournalDir }
  persist(h)
  return h
}

function stepOf(record: JournalRecord, stepId: string): JournalStep {
  const s = record.steps.find((x) => x.id === stepId)
  if (!s) throw new JournalError(`Unknown journal step ${JSON.stringify(stepId)}`)
  return s
}

/** Mark started (durable), apply, mark done (durable). A throw from apply leaves the step started. */
export async function runStep(journal: JournalHandle, stepId: string, handler: StepHandler): Promise<void> {
  const step = stepOf(journal.record, stepId)
  if (journal.record.state !== 'active') throw new JournalError(`Journal ${journal.record.opId} is ${journal.record.state}`)
  if (step.done) return
  step.started = true
  persist(journal)
  await handler.apply(step.args)
  step.done = true
  persist(journal)
}

/** Mark an in-memory journal abandoned (the operation threw); recovery by whoever holds `requiredLocks` follows. */
export function abandonJournal(journal: JournalHandle): void {
  if (journal.record.state !== 'active') return
  journal.record.state = 'abandoned'
  persist(journal)
}

/** `committed` (durable) only when every step is done, then step (4). */
export function commitJournal(journal: JournalHandle): void {
  const { record, controlDir } = journal
  const pending = record.steps.filter((s) => !s.done)
  if (pending.length > 0) throw new JournalError(`Journal ${record.opId} has unfinished steps: ${pending.map((s) => s.id).join(', ')}`)
  record.state = 'committed'
  persist(journal)
  removeJournal(controlDir, record, journal.cacheJournalDir)
}

// ---------------------------------------------------------------- finding

/**
 * Pending journals under any of `resourceKeys`, found through locators; state always comes from the canonical file.
 * A locator whose canonical journal is missing is stale and removed.
 */
export function findPendingJournals(controlDir: string, resourceKeys: readonly string[]): PendingJournal[] {
  const out = new Map<string, PendingJournal>()
  for (const key of resourceKeys) {
    assertResourceKey(key)
    const dir = join(byResourceDir(controlDir), key)
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    for (const opId of names) {
      if (!OP_ID_RE.test(opId)) continue
      if (out.has(opId)) continue
      const record = readJournal(controlDir, opId)
      if (!record) {
        unlinkDurable(join(dir, opId))
        tryRmdir(dir)
        continue
      }
      out.set(opId, { opId, record })
    }
  }
  return [...out.values()]
}

// ---------------------------------------------------------------- recovery

function needsAttention(h: JournalHandle, stepId: string, reason: string): RecoverResult {
  h.record.state = 'needs-attention'
  h.record.attention = { stepId, reason }
  persist(h)
  return { status: 'needs-attention', stepId, reason }
}

function handlerFor(handlers: StepHandlers, step: JournalStep): StepHandler {
  // Own properties only: a kind such as `constructor` must not resolve through the prototype.
  const h = Object.prototype.hasOwnProperty.call(handlers, step.kind) ? handlers[step.kind] : undefined
  if (!h) throw new JournalError(`No handler for step kind ${JSON.stringify(step.kind)}`)
  return h
}

async function rollForward(h: JournalHandle, handlers: StepHandlers): Promise<RecoverResult> {
  for (const step of h.record.steps) {
    if (step.done) continue
    const handler = handlerFor(handlers, step)
    if (handler.post(step.args)) {
      step.done = true
      persist(h)
    } else if (handler.pre(step.args)) {
      step.started = true
      persist(h)
      await handler.apply(step.args)
      step.done = true
      persist(h)
    } else {
      return needsAttention(h, step.id, `Step ${step.id} (${step.kind}): the target changed outside the operation`)
    }
  }
  commitJournal(h)
  return { status: 'committed' }
}

async function rollBack(h: JournalHandle, handlers: StepHandlers): Promise<RecoverResult> {
  for (const step of [...h.record.steps].reverse()) {
    if (!(step.started || step.done) || step.undone) continue
    const handler = handlerFor(handlers, step)
    if (handler.post(step.args)) {
      if (!handler.inverse) return needsAttention(h, step.id, `Step ${step.id} (${step.kind}) has no inverse`)
      await handler.inverse(step.args)
      step.undone = true
      persist(h)
    } else if (handler.pre(step.args)) {
      step.undone = true // the effect never landed
      persist(h)
    } else {
      return needsAttention(h, step.id, `Step ${step.id} (${step.kind}): the target changed outside the operation`)
    }
  }
  removeJournal(h.controlDir, h.record, h.cacheJournalDir)
  return { status: 'rolled-back' }
}

/**
 * Recover one journal per spec 4.9. Idempotent. The caller holds the journal's `requiredLocks`.
 * Missing journal: `removed` (nothing to do). A journal with shared locators needs `opts.cacheJournalDir` (the
 * caller's own cache journal directory); without it recovery throws JournalError before touching anything.
 */
export async function recoverJournal(controlDir: string, opId: string, handlers: StepHandlers, opts: RecoverOptions = {}): Promise<RecoverResult> {
  const record = readJournal(controlDir, opId)
  if (!record) return { status: 'removed' }
  if (record.state !== 'needs-attention') cacheDirFor(record, opts.cacheJournalDir)
  const h: JournalHandle = { controlDir, record, cacheJournalDir: opts.cacheJournalDir }
  if (record.state === 'committed') {
    removeJournal(controlDir, record, opts.cacheJournalDir)
    return { status: 'committed' }
  }
  if (record.state === 'needs-attention') {
    const a = record.attention
    return { status: 'needs-attention', stepId: a?.stepId ?? '', reason: a?.reason ?? 'needs attention' }
  }
  if (!record.steps.some((s) => s.started || s.done)) {
    removeJournal(controlDir, record, opts.cacheJournalDir)
    return { status: 'removed' }
  }
  writeLocators(controlDir, record, opts.cacheJournalDir) // repair: only for started journals
  return record.rule === 'forward' ? rollForward(h, handlers) : rollBack(h, handlers)
}

/**
 * The manual path (`doctor --resolve-journal`). `finish`: complete the operation by the rule as far as the handlers
 * allow, and treat the stuck steps as settled (forward: done; back: undone), then remove the journal. `discard`:
 * remove locators and the journal as they are, touching no target.
 */
export async function resolveNeedsAttention(
  controlDir: string,
  opId: string,
  action: 'finish' | 'discard',
  handlers: StepHandlers,
  opts: RecoverOptions = {}
): Promise<RecoverResult> {
  const record = readJournal(controlDir, opId)
  if (!record) return { status: 'removed' }
  if (record.state !== 'needs-attention') throw new JournalError(`Journal ${opId} is not in needs-attention`)
  cacheDirFor(record, opts.cacheJournalDir)
  const h: JournalHandle = { controlDir, record, cacheJournalDir: opts.cacheJournalDir }
  if (action === 'discard') {
    removeJournal(controlDir, record, opts.cacheJournalDir)
    return { status: 'removed' }
  }
  writeLocators(controlDir, record, opts.cacheJournalDir)
  if (record.rule === 'forward') {
    for (const step of record.steps) {
      if (step.done) continue
      const handler = handlerFor(handlers, step)
      if (!handler.post(step.args) && handler.pre(step.args)) {
        step.started = true
        persist(h)
        await handler.apply(step.args)
      }
      step.done = true
      persist(h)
    }
    commitJournal(h)
    return { status: 'committed' }
  }
  for (const step of [...record.steps].reverse()) {
    if (!(step.started || step.done) || step.undone) continue
    const handler = handlerFor(handlers, step)
    if (handler.post(step.args) && handler.inverse) await handler.inverse(step.args)
    step.undone = true
    persist(h)
  }
  removeJournal(controlDir, record, opts.cacheJournalDir)
  return { status: 'rolled-back' }
}

// ---------------------------------------------------------------- shared locators across data folders

export type ForeignJournalState = 'absent' | 'committed' | 'pending' | 'unreadable'

export interface SharedLocatorCheck {
  proceed: boolean
  refusalFolder?: string
  reason?: 'pending' | 'unreadable'
}

/**
 * Called under `output-file-<hash>`: look at every shared locator for `key` from a different folder. Absent or
 * committed foreign journals (or a gone folder, which `readForeignJournal` reports as absent) make the locator stale:
 * removed, and the operation proceeds. A pending journal refuses (finish it from that folder); an unreadable one
 * refuses with doctor guidance.
 */
export function checkSharedLocators(
  cacheJournalDir: string,
  key: string,
  ownFolderId: string,
  readForeignJournal: (dataFolder: string, opId: string) => ForeignJournalState
): SharedLocatorCheck {
  assertResourceKey(key)
  assertFolderId(ownFolderId)
  const dir = join(cacheJournalDir, key)
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return { proceed: true }
  }
  const ownPrefix = `${ownFolderId}-`
  let refusal: SharedLocatorCheck | null = null
  for (const name of names) {
    if (!name.endsWith('.json') || name.startsWith(ownPrefix)) continue
    const file = join(dir, name)
    let loc: { dataFolder?: unknown; opId?: unknown } | null = null
    try {
      loc = JSON.parse(readFileSync(file, 'utf8')) as { dataFolder?: unknown; opId?: unknown }
    } catch {
      loc = null
    }
    if (!loc || typeof loc.dataFolder !== 'string' || typeof loc.opId !== 'string' || !OP_ID_RE.test(loc.opId)) {
      refusal ??= { proceed: false, reason: 'unreadable' }
      continue
    }
    let state: ForeignJournalState
    try {
      state = readForeignJournal(loc.dataFolder, loc.opId)
    } catch {
      state = 'unreadable'
    }
    if (state === 'absent' || state === 'committed') {
      unlinkDurable(file)
    } else if (state === 'pending') {
      refusal ??= { proceed: false, refusalFolder: loc.dataFolder, reason: 'pending' }
    } else {
      refusal ??= { proceed: false, refusalFolder: loc.dataFolder, reason: 'unreadable' }
    }
  }
  tryRmdir(dir)
  return refusal ?? { proceed: true }
}

/** A folder's own recovery removes its shared locators for `key` whose canonical journal is absent. Returns count. */
export function removeStaleOwnSharedLocators(controlDir: string, cacheJournalDir: string, key: string, folderId: string): number {
  assertResourceKey(key)
  assertFolderId(folderId)
  const dir = join(cacheJournalDir, key)
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return 0
  }
  const prefix = `${folderId}-`
  let n = 0
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('.json')) continue
    const opId = name.slice(prefix.length, -'.json'.length)
    if (!OP_ID_RE.test(opId)) continue
    if (readJournal(controlDir, opId) === null) {
      unlinkDurable(join(dir, name))
      n++
    }
  }
  tryRmdir(dir)
  return n
}
