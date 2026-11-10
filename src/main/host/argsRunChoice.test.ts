import { describe, expect, it } from 'vitest'
import { EFFORTS, PERMISSION_MODES } from '@shared/types'
import { setPermissionModeArgs, startRunArgs } from './args'

const base = { projectId: 'proj_a', prompt: 'go' }

function badMessage(fn: () => unknown): string {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(Error)
    expect(e).toMatchObject({ code: 'bad_request' })
    return (e as Error).message
  }
  throw new Error('expected a bad_request refusal')
}

describe('startRunArgs per-run root choices', () => {
  it('without the three fields the output has none of them', () => {
    expect(startRunArgs(base)).toEqual({ projectId: 'proj_a', prompt: 'go' })
    expect(startRunArgs({ ...base, modelSelection: null, effort: null, permissionMode: null })).toEqual({ projectId: 'proj_a', prompt: 'go' })
    expect(startRunArgs({ ...base, modelSelection: undefined, effort: undefined, permissionMode: undefined })).toEqual({ projectId: 'proj_a', prompt: 'go' })
  })

  it('keeps a valid modelSelection rebuilt: model trimmed, extra keys dropped', () => {
    const out = startRunArgs({ ...base, modelSelection: { model: '  claude-sonnet-4  ', connection: 'anthropic', extra: 'x', y: 1 } })
    expect(out.modelSelection).toEqual({ model: 'claude-sonnet-4', connection: 'anthropic' })
    expect(Object.keys(out.modelSelection!).sort()).toEqual(['connection', 'model'])
  })

  it('accepts built-in and proxy connection ids', () => {
    expect(startRunArgs({ ...base, modelSelection: { model: 'gpt-5', connection: 'openai' } }).modelSelection?.connection).toBe('openai')
    expect(startRunArgs({ ...base, modelSelection: { model: 'm', connection: 'proxy-0123abcd' } }).modelSelection?.connection).toBe('proxy-0123abcd')
    expect(startRunArgs({ ...base, modelSelection: { model: 'm', connection: 'litellm' } }).modelSelection?.connection).toBe('litellm')
  })

  it('refuses a malformed modelSelection', () => {
    for (const v of ['sonnet', 5, true, [], ['a']]) expect(badMessage(() => startRunArgs({ ...base, modelSelection: v }))).toBe('modelSelection must be an object with a model and a connection.')
    const modelProblem = 'The model must be text of 1 to 200 characters without control characters.'
    for (const model of [undefined, 5, '', '   ', 'a'.repeat(201), 'a\nb', 'a\u0000b', 'a‮b']) {
      expect(badMessage(() => startRunArgs({ ...base, modelSelection: { model, connection: 'anthropic' } })), String(model)).toBe(modelProblem)
    }
    expect(startRunArgs({ ...base, modelSelection: { model: 'a'.repeat(200), connection: 'anthropic' } }).modelSelection?.model).toHaveLength(200)
    for (const connection of [undefined, null, 5, '', 'nope', '__proto__', 'constructor', 'proxy-xyz']) {
      expect(badMessage(() => startRunArgs({ ...base, modelSelection: { model: 'm', connection } })), String(connection)).toBe('Unknown connection.')
    }
  })

  it('keeps every known effort and refuses anything else', () => {
    for (const effort of EFFORTS) expect(startRunArgs({ ...base, effort }).effort).toBe(effort)
    for (const effort of ['extreme', '', 5, true, {}, []]) expect(badMessage(() => startRunArgs({ ...base, effort })), String(effort)).toBe('effort is not a known reasoning effort.')
  })

  it('keeps every known permission mode and refuses anything else', () => {
    for (const permissionMode of PERMISSION_MODES) expect(startRunArgs({ ...base, permissionMode }).permissionMode).toBe(permissionMode)
    for (const permissionMode of ['yolo', '', 5, false, {}, []]) {
      expect(badMessage(() => startRunArgs({ ...base, permissionMode })), String(permissionMode)).toBe('permissionMode is not a known permission mode.')
    }
  })

  it('keeps all three together next to the existing fields', () => {
    const out = startRunArgs({ ...base, team: 'single', modelSelection: { model: 'm', connection: 'anthropic' }, effort: 'high', permissionMode: 'plan', junk: 1 })
    expect(out).toEqual({ ...base, team: 'single', modelSelection: { model: 'm', connection: 'anthropic' }, effort: 'high', permissionMode: 'plan' })
  })
})

describe('setPermissionModeArgs', () => {
  it('rebuilds { runId, mode } and drops extra fields', () => {
    expect(setPermissionModeArgs({ runId: 'run_1', mode: 'acceptEdits', extra: 1 })).toEqual({ runId: 'run_1', mode: 'acceptEdits' })
    for (const mode of PERMISSION_MODES) expect(setPermissionModeArgs({ runId: 'run_1', mode }).mode).toBe(mode)
  })

  it('refuses a bad input, run id or mode as bad_request', () => {
    for (const v of [null, undefined, 'run_1', 5, [], ['run_1', 'plan']]) expect(badMessage(() => setPermissionModeArgs(v))).toBe('Unknown run.')
    for (const runId of [undefined, '', 5, 'r'.repeat(201)]) expect(badMessage(() => setPermissionModeArgs({ runId, mode: 'plan' }))).toBe('Unknown run.')
    for (const mode of [undefined, null, 'yolo', '', 5]) expect(badMessage(() => setPermissionModeArgs({ runId: 'run_1', mode })), String(mode)).toBe('mode is not a known permission mode.')
  })
})
