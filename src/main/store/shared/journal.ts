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

export interface JournalStep {
  id: string
  kind: string
  args: unknown
  started?: boolean
  done?: boolean
  undone?: boolean
}

export type JournalState = 'active' | 'abandoned' | 'committed' | 'needs-attention'

export interface SharedLocatorSpec {
  cacheJournalDir: string
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
   * Added beyond the spec's record shape: recovery needs the shared-locator location and folder id to repair or
   * remove shared locators, and `controlDir` alone cannot supply them (spec gap, see report).
   */
  sharedLocators?: SharedLocatorSpec
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

export class JournalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'JournalError'
  }
}

export function assertOpId(opId: string): void {
  if (!OP_ID_RE.test(opId)) throw new JournalError(`Invalid journal operation id ${JSON.stringify(opId)}`)
}
export function assertResourceKey(key: string): void {
  if (!KEY_RE.test(key) || key === '.' || key === '..') throw new JournalError(`Invalid journal resource key ${JSON.stringify(key)}`)
}
function assertFolderId(id: string): void {
  if (!FOLDER_ID_RE.test(id)) throw new JournalError(`Invalid folder id ${JSON.stringify(id)}`)
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
function writeLocators(controlDir: string, record: JournalRecord): void {
  const touched = new Set<string>()
  for (const key of record.resources) {
    const dir = join(byResourceDir(controlDir), key)
    ensureDir(dir)
    touchEmpty(join(dir, record.opId))
    touched.add(dir)
  }
  const sh = record.sharedLocators
  if (sh) {
    for (const key of sh.resourceKeys) {
      const dir = join(sh.cacheJournalDir, key)
      ensureDir(dir)
      writeFileAtomic(sharedLocatorPath(sh.cacheJournalDir, key, sh.folderId, record.opId), JSON.stringify({ dataFolder: dataFolderOf(controlDir), opId: record.opId }))
      touched.add(dir)
    }
  }
  for (const dir of touched) fsyncDirectory(dir)
  // The new key directories themselves must be reachable after a power loss.
  fsyncDirectory(byResourceDir(controlDir))
  if (sh) fsyncDirectory(sh.cacheJournalDir)
}

/** The data folder is the parent of `control/`. */
function dataFolderOf(controlDir: string): string {
  return join(controlDir, '..')
}

/** Remove every locator (local and shared) of the record, then fsync directories. Missing is fine. */
function removeLocators(controlDir: string, record: JournalRecord): void {
  const dirs: string[] = []
  for (const key of record.resources) {
    const dir = join(byResourceDir(controlDir), key)
    unlinkDurable(join(dir, record.opId))
    tryRmdir(dir)
    dirs.push(byResourceDir(controlDir))
  }
  const sh = record.sharedLocators
  if (sh) {
    for (const key of sh.resourceKeys) {
      const dir = join(sh.cacheJournalDir, key)
      unlinkDurable(sharedLocatorPath(sh.cacheJournalDir, key, sh.folderId, record.opId))
      tryRmdir(dir)
      dirs.push(sh.cacheJournalDir)
    }
  }
  for (const d of new Set(dirs)) fsyncDirectory(d)
}

/** Step (4): locators, then the canonical journal, directories fsynced. */
function removeJournal(controlDir: string, record: JournalRecord): void {
  removeLocators(controlDir, record)
  unlinkDurable(canonicalPath(controlDir, record.opId))
  fsyncDirectory(opsDir(controlDir))
}

function validateRecord(raw: unknown, opId: string): JournalRecord {
  const r = raw as Partial<JournalRecord> | null
  if (
    !r || typeof r !== 'object' || r.opId !== opId || typeof r.op !== 'string' || !Array.isArray(r.steps) ||
    !Array.isArray(r.resources) || !Array.isArray(r.requiredLocks) || (r.rule !== 'forward' && r.rule !== 'back') ||
    !['active', 'abandoned', 'committed', 'needs-attention'].includes(r.state as string)
  ) {
    throw new JournalError(`Journal ${opId} is unreadable`)
  }
  for (const k of r.resources) assertResourceKey(k as string)
  return r as JournalRecord
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
  assertOpId(record.opId)
  for (const k of record.resources) assertResourceKey(k)
  const ids = new Set<string>()
  for (const s of record.steps) {
    if (ids.has(s.id)) throw new JournalError(`Duplicate step id ${JSON.stringify(s.id)}`)
    ids.add(s.id)
  }
  const full: JournalRecord = {
    ...record,
    steps: record.steps.map((s) => ({ ...s })),
    state: 'active'
  }
  if (opts?.sharedLocators) {
    const sh = opts.sharedLocators
    assertFolderId(sh.folderId)
    for (const k of sh.resourceKeys) assertResourceKey(k)
    full.sharedLocators = { cacheJournalDir: sh.cacheJournalDir, resourceKeys: [...sh.resourceKeys], folderId: sh.folderId }
  }
  writeLocators(controlDir, full)
  const h: JournalHandle = { controlDir, record: full }
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
  removeJournal(controlDir, record)
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
  const h = handlers[step.kind]
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
  removeJournal(h.controlDir, h.record)
  return { status: 'rolled-back' }
}

/**
 * Recover one journal per spec 4.9. Idempotent. The caller holds the journal's `requiredLocks`.
 * Missing journal: `removed` (nothing to do).
 */
export async function recoverJournal(controlDir: string, opId: string, handlers: StepHandlers): Promise<RecoverResult> {
  const record = readJournal(controlDir, opId)
  if (!record) return { status: 'removed' }
  const h: JournalHandle = { controlDir, record }
  if (record.state === 'committed') {
    removeJournal(controlDir, record)
    return { status: 'committed' }
  }
  if (record.state === 'needs-attention') {
    const a = record.attention
    return { status: 'needs-attention', stepId: a?.stepId ?? '', reason: a?.reason ?? 'needs attention' }
  }
  if (!record.steps.some((s) => s.started || s.done)) {
    removeJournal(controlDir, record)
    return { status: 'removed' }
  }
  writeLocators(controlDir, record) // repair: only for started journals
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
  handlers: StepHandlers
): Promise<RecoverResult> {
  const record = readJournal(controlDir, opId)
  if (!record) return { status: 'removed' }
  if (record.state !== 'needs-attention') throw new JournalError(`Journal ${opId} is not in needs-attention`)
  const h: JournalHandle = { controlDir, record }
  if (action === 'discard') {
    removeJournal(controlDir, record)
    return { status: 'removed' }
  }
  writeLocators(controlDir, record)
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
  removeJournal(controlDir, record)
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
