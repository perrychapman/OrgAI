import { randomBytes } from 'node:crypto'
import { lstatSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { OutputKind, RunOutput } from '@shared/types'
import {
  OUTPUTS_MAX,
  OUTPUT_DESCRIPTION_MAX_CHARS,
  OUTPUT_ID_RE,
  OUTPUT_KINDS,
  OUTPUT_PATH_MAX_CHARS,
  OUTPUT_TITLE_MAX_CHARS
} from '@shared/types'
import { isSafeId } from '@shared/defaults'
import { hiddenCharIn } from '../capabilities/sanitize'
import { log } from '../log'
import { pathKey } from '../quick/scratch'
import { atomicWrite, ensurePlainDir, projectDataDir, readPlain } from '../store/projectData'

/**
 * The outputs index: `<data>/projects/<id>/outputs.json` = { version: 1, outputs: [...] } (no `missing`). Reads drop junk
 * entry by entry; a file that exists but is not a { version: 1, outputs: [] } JSON object reads as empty and refuses
 * every write (never overwritten), like store/knowledge.ts.
 */

const INDEX_MAX_BYTES = 16 * 1024 * 1024

export function outputsFile(dataDir: string, projectId: string): string {
  return join(projectDataDir(dataDir, projectId), 'outputs.json')
}

export function newOutputId(): string {
  return `out_${randomBytes(8).toString('hex')}`
}

const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0

function short(x: unknown, max: number, min = 1): string | undefined {
  return typeof x === 'string' && x.length >= min && x.length <= max && !hiddenCharIn(x) ? x : undefined
}

/** One stored entry validated field by field; undefined when junk. */
export function cleanOutput(x: unknown, projectId: string): RunOutput | undefined {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return undefined
  const o = x as Record<string, unknown>
  if (typeof o.id !== 'string' || !OUTPUT_ID_RE.test(o.id)) return undefined
  if (typeof o.kind !== 'string' || !OUTPUT_KINDS.includes(o.kind as OutputKind)) return undefined
  if (o.source !== 'produced' && o.source !== 'registered') return undefined
  const title = short(o.title, OUTPUT_TITLE_MAX_CHARS)
  const fileName = short(o.fileName, 255)
  const path = short(o.path, OUTPUT_PATH_MAX_CHARS)
  const relPath = short(o.relPath, OUTPUT_PATH_MAX_CHARS)
  const runId = short(o.runId, 200)
  if (!title || !fileName || !path || !relPath || !runId || !isAbsolute(path)) return undefined
  if (!finite(o.bytes) || !finite(o.createdAt)) return undefined
  const out: RunOutput = {
    id: o.id,
    projectId,
    runId,
    kind: o.kind as OutputKind,
    title,
    fileName,
    path,
    relPath,
    bytes: o.bytes,
    createdAt: o.createdAt,
    source: o.source
  }
  if (o.agentId !== undefined) {
    const a = short(o.agentId, 200)
    if (a) out.agentId = a
  }
  if (o.role !== undefined) {
    const r = short(o.role, 200)
    if (r) out.role = r
  }
  if (o.description !== undefined) {
    if (typeof o.description === 'string' && o.description.length <= OUTPUT_DESCRIPTION_MAX_CHARS && !hiddenCharIn(o.description, { prose: true })) {
      if (o.description) out.description = o.description
    }
  }
  if (o.updatedAt !== undefined && finite(o.updatedAt)) out.updatedAt = o.updatedAt
  return out
}

type Loaded = { outputs: RunOutput[]; state: 'missing' | 'ok' | 'unreadable' }

export function unreadableMessage(file: string): string {
  return `The outputs list could not be read (damaged or too large); nothing was saved. Fix or remove ${file}.`
}

export interface OutputStore {
  list(projectId: string): RunOutput[]
  get(projectId: string, id: string): RunOutput | undefined
  byPath(projectId: string, path: string): RunOutput | undefined
  /** Adds an entry (id and projectId filled in); drops the oldest past OUTPUTS_MAX. */
  add(projectId: string, entry: Omit<RunOutput, 'id' | 'projectId'>): RunOutput
  /** Replaces fields of an existing entry (id, projectId, createdAt, runId, source kept). */
  update(projectId: string, id: string, patch: Partial<Omit<RunOutput, 'id' | 'projectId' | 'createdAt' | 'runId' | 'source'>>): RunOutput | undefined
  remove(projectId: string, id: string): boolean
}

export function createOutputStore(dataDir: string): OutputStore {
  function load(projectId: string): Loaded {
    const file = outputsFile(dataDir, projectId)
    let present = false
    try {
      lstatSync(file)
      present = true
    } catch {
      present = false
    }
    if (!present) return { outputs: [], state: 'missing' }
    const raw = readPlain(file, INDEX_MAX_BYTES)
    if (!raw) return { outputs: [], state: 'unreadable' }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw.text)
    } catch {
      return { outputs: [], state: 'unreadable' }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { outputs: [], state: 'unreadable' }
    const p = parsed as { version?: unknown; outputs?: unknown }
    if (p.version !== 1 || !Array.isArray(p.outputs)) return { outputs: [], state: 'unreadable' }
    const seen = new Set<string>()
    const outputs: RunOutput[] = []
    for (const e of p.outputs) {
      const c = cleanOutput(e, projectId)
      if (c && !seen.has(c.id)) {
        seen.add(c.id)
        outputs.push(c)
      }
    }
    return { outputs, state: 'ok' }
  }

  function save(projectId: string, outputs: RunOutput[]): void {
    const dir = projectDataDir(dataDir, projectId)
    ensurePlainDir(dataDir, projectId, dir)
    const stored = outputs.map((o) => {
      const { missing: _m, ...rest } = o as RunOutput & { missing?: true }
      void _m
      return rest
    })
    atomicWrite(outputsFile(dataDir, projectId), JSON.stringify({ version: 1, outputs: stored }))
  }

  function loadForWrite(projectId: string): RunOutput[] {
    if (!isSafeId(projectId)) throw new Error('That output is not in this project\'s list.')
    const l = load(projectId)
    if (l.state === 'unreadable') throw new Error(unreadableMessage(outputsFile(dataDir, projectId)))
    return l.outputs
  }

  const keyOf = (p: string): string => pathKey(p)

  return {
    list(projectId) {
      if (!isSafeId(projectId)) return []
      return load(projectId).outputs.slice()
    },
    get(projectId, id) {
      return this.list(projectId).find((o) => o.id === id)
    },
    byPath(projectId, path) {
      const k = keyOf(path)
      return this.list(projectId).find((o) => keyOf(o.path) === k)
    },
    add(projectId, entry) {
      const all = loadForWrite(projectId)
      const created: RunOutput = { ...entry, id: newOutputId(), projectId }
      all.push(created)
      if (all.length > OUTPUTS_MAX) {
        all.sort((a, b) => a.createdAt - b.createdAt)
        const drop = all.splice(0, all.length - OUTPUTS_MAX)
        log.info(`outputs: project ${projectId} passed ${OUTPUTS_MAX} entries; forgot the ${drop.length} oldest (their files stay)`)
      }
      save(projectId, all)
      return created
    },
    update(projectId, id, patch) {
      const all = loadForWrite(projectId)
      const i = all.findIndex((o) => o.id === id)
      if (i < 0) return undefined
      const next: RunOutput = { ...all[i], ...patch }
      all[i] = next
      save(projectId, all)
      return next
    },
    remove(projectId, id) {
      const all = loadForWrite(projectId)
      const next = all.filter((o) => o.id !== id)
      if (next.length === all.length) return false
      save(projectId, next)
      return true
    }
  }
}
