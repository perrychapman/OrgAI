import { lstatSync, realpathSync, unlinkSync } from 'node:fs'
import { basename } from 'node:path'
import type { OutputKind, OutputPreview, OutputProduceInput, OutputRegisterInput, RunOutput } from '@shared/types'
import { OUTPUT_DESCRIPTION_MAX_CHARS, OUTPUT_KINDS, OUTPUT_TITLE_MAX_CHARS, outputKindForPath } from '@shared/types'
import { hiddenCharProblem } from '../capabilities/sanitize'
import type { OutputScope, OutputSource, OutputWriteResult, OutputsServiceApi } from './api'
import { checkDeletablePath, checkRegisteredPath, relPathFor, resolveProducedTarget, writeProduced } from './paths'
import { previewFile } from './preview'
import { createOutputStore } from './store'
import { renderProduced } from './writers'

/**
 * The run outputs service (api.ts OutputsServiceApi) over the index store, the path rules, the writers and the
 * previews. Electron-free. Every refusal is an Error whose message is one plain sentence.
 */

const NOT_LISTED = "That output is not in this project's list."

function cleanTitle(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('The title must be text.')
  const t = raw.trim()
  if (!t) throw new Error('The title is empty.')
  if (t.length > OUTPUT_TITLE_MAX_CHARS) throw new Error(`The title is longer than ${OUTPUT_TITLE_MAX_CHARS} characters.`)
  const hidden = hiddenCharProblem('The title', t)
  if (hidden) throw new Error(hidden)
  return t
}

function cleanDescription(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'string') throw new Error('The description must be text.')
  if (raw.length > OUTPUT_DESCRIPTION_MAX_CHARS) throw new Error(`The description is longer than ${OUTPUT_DESCRIPTION_MAX_CHARS} characters.`)
  const hidden = hiddenCharProblem('The description', raw, { prose: true })
  if (hidden) throw new Error(hidden)
  return raw.trim() ? raw : undefined
}

function checkScope(scope: OutputScope): void {
  if (!scope || typeof scope.projectId !== 'string' || typeof scope.projectPath !== 'string' || !scope.projectPath) throw new Error('The project folder is not known.')
}

function sourceFields(source: OutputSource): Pick<RunOutput, 'runId' | 'agentId' | 'role'> {
  const out: Pick<RunOutput, 'runId' | 'agentId' | 'role'> = { runId: source.runId }
  if (source.agentId) out.agentId = source.agentId
  if (source.role) out.role = source.role
  return out
}

/** The entry as listed: missing: true when its file is gone or no longer a regular file. */
function decorate(o: RunOutput): RunOutput {
  try {
    const st = lstatSync(o.path)
    if (st.isFile()) return { ...o }
  } catch {
    /* gone */
  }
  return { ...o, missing: true }
}

export function createOutputsService(dataDir: string): OutputsServiceApi {
  const store = createOutputStore(dataDir)

  function entryOf(projectId: string, outputId: string): RunOutput {
    const e = typeof outputId === 'string' ? store.get(projectId, outputId) : undefined
    if (!e) throw new Error(NOT_LISTED)
    return e
  }

  function list(projectId: string): RunOutput[] {
    return store
      .list(projectId)
      .map((o, i) => ({ o, i }))
      .sort((a, b) => b.o.createdAt - a.o.createdAt || b.i - a.i)
      .map((x) => decorate(x.o))
  }

  function checkedPath(scope: OutputScope, outputId: string): string {
    checkScope(scope)
    const e = entryOf(scope.projectId, outputId)
    return checkRegisteredPath(e.path, scope, dataDir).path
  }

  return {
    async produce(scope: OutputScope, input: OutputProduceInput, source: OutputSource): Promise<OutputWriteResult> {
      checkScope(scope)
      if (!input || typeof input !== 'object') throw new Error('The output request is not valid.')
      const title = cleanTitle(input.title)
      const description = cleanDescription(input.description)
      if (input.fileName !== undefined && typeof input.fileName !== 'string') throw new Error('The file name must be text.')
      const bytes = await renderProduced(input)
      // From here to the index write nothing awaits, so no other call can take the chosen name in between.
      const target = resolveProducedTarget({
        scope,
        dataDir,
        kind: input.kind,
        title,
        fileName: input.fileName,
        overwrite: input.overwrite === true,
        mayOverwrite: (abs) => {
          const e = store.byPath(scope.projectId, abs)
          return !!e && e.source === 'produced' && e.runId === source.runId
        }
      })
      const written = writeProduced(target, bytes)
      let real = target.file
      try {
        real = realpathSync.native(target.file)
      } catch {
        /* keep the logical path */
      }
      const relPath = relPathFor(scope.projectPath, real)
      const now = Date.now()
      try {
        if (target.overwrite) {
          const existing = store.byPath(scope.projectId, target.file) ?? store.byPath(scope.projectId, real)
          if (existing) {
            const patch: Partial<RunOutput> = { title, kind: input.kind, fileName: basename(real), path: real, relPath, bytes: written, updatedAt: now, ...sourceFields(source) }
            patch.description = description
            const updated = store.update(scope.projectId, existing.id, patch)
            if (updated) return { output: updated, created: false }
          }
        }
        const entry: Omit<RunOutput, 'id' | 'projectId'> = {
          ...sourceFields(source),
          kind: input.kind,
          title,
          fileName: basename(real),
          path: real,
          relPath,
          bytes: written,
          createdAt: now,
          source: 'produced'
        }
        if (description) entry.description = description
        return { output: store.add(scope.projectId, entry), created: true }
      } catch (e) {
        throw new Error(`The file was written to ${relPath} but could not be added to the outputs list: ${(e as Error).message}`)
      }
    },

    async register(scope: OutputScope, input: OutputRegisterInput, source: OutputSource): Promise<OutputWriteResult> {
      checkScope(scope)
      if (!input || typeof input !== 'object') throw new Error('The output request is not valid.')
      const title = cleanTitle(input.title)
      const description = cleanDescription(input.description)
      const checked = checkRegisteredPath(input.path, scope, dataDir)
      const kind: OutputKind = input.kind ?? outputKindForPath(checked.path)
      if (!OUTPUT_KINDS.includes(kind)) throw new Error('That kind of output is not known.')
      const now = Date.now()
      const existing = store.byPath(scope.projectId, checked.path)
      if (existing) {
        const patch: Partial<RunOutput> = { title, kind, bytes: checked.bytes, updatedAt: now, relPath: checked.relPath }
        if (description !== undefined) patch.description = description
        const updated = store.update(scope.projectId, existing.id, patch)
        if (updated) return { output: updated, created: false }
      }
      const entry: Omit<RunOutput, 'id' | 'projectId'> = {
        ...sourceFields(source),
        kind,
        title,
        fileName: basename(checked.path),
        path: checked.path,
        relPath: checked.relPath,
        bytes: checked.bytes,
        createdAt: now,
        source: 'registered'
      }
      if (description) entry.description = description
      return { output: store.add(scope.projectId, entry), created: true }
    },

    list,

    get(projectId: string, outputId: string): RunOutput | undefined {
      const e = typeof outputId === 'string' ? store.get(projectId, outputId) : undefined
      return e ? decorate(e) : undefined
    },

    async preview(scope: OutputScope, outputId: string): Promise<OutputPreview> {
      checkScope(scope)
      const e = entryOf(scope.projectId, outputId)
      let path: string
      try {
        path = checkedPath(scope, outputId)
      } catch (err) {
        return { kind: 'none', reason: (err as Error).message }
      }
      return previewFile(path, e.kind)
    },

    checkedPath,

    forget(projectId: string, outputId: string): RunOutput[] {
      if (typeof outputId !== 'string' || !store.remove(projectId, outputId)) throw new Error(NOT_LISTED)
      return list(projectId)
    },

    delete(scope: OutputScope, outputId: string): RunOutput[] {
      checkScope(scope)
      const e = entryOf(scope.projectId, outputId)
      const real = checkDeletablePath(e.path, scope)
      if (real) {
        try {
          unlinkSync(real)
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`Could not delete the file: ${(err as Error).message}`)
        }
      }
      store.remove(scope.projectId, outputId)
      return list(scope.projectId)
    }
  }
}
