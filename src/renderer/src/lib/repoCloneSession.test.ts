import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RepoCloneInput, RepoCloneProgress, RepoCloneResult } from '@shared/types'
import { REPO_CLONE_CANCELLED_PREFIX } from '@shared/types'
import { cancelRepoClone, clearRepoFailure, forgetRepoClone, repoSession, resetRepoSessionForTests, startRepoClone } from './repoCloneSession'

function fakeApi() {
  let resolve!: (r: RepoCloneResult) => void
  let reject!: (e: Error) => void
  const inputs: RepoCloneInput[] = []
  const unsubscribe = vi.fn()
  let progress: ((e: RepoCloneProgress) => void) | null = null
  const api = {
    repos: {
      parseSource: vi.fn(),
      tools: vi.fn(),
      clone: (input: RepoCloneInput) => {
        inputs.push(input)
        return new Promise<RepoCloneResult>((res, rej) => {
          resolve = res
          reject = rej
        })
      },
      cancelClone: vi.fn(async () => {})
    },
    onRepoCloneProgress: (cb: (e: RepoCloneProgress) => void) => {
      progress = cb
      return unsubscribe
    }
  }
  return { api, inputs, unsubscribe, resolve: (r: RepoCloneResult) => resolve(r), reject: (e: Error) => reject(e), emit: (e: RepoCloneProgress) => progress?.(e) }
}
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
const start = { source: 'o/r', mode: 'clone' as const, destination: 'C:\\p\\r', display: 'o/r' }
const result: RepoCloneResult = { path: 'C:\\p\\r', url: 'https://github.com/o/r.git', repoConfig: [] }

describe('repoCloneSession', () => {
  beforeEach(() => resetRepoSessionForTests())

  it('sends the typed source and a valid request id, never a built URL', () => {
    const f = fakeApi()
    expect(startRepoClone(start, f.api)).toBe(true)
    expect(f.inputs[0]).toMatchObject({ source: 'o/r', mode: 'clone', destination: 'C:\\p\\r' })
    expect(f.inputs[0].requestId).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
    expect(Object.keys(f.inputs[0]).sort()).toEqual(['destination', 'mode', 'requestId', 'source'])
  })

  it('refuses a second clone while one runs', () => {
    const f = fakeApi()
    startRepoClone(start, f.api)
    expect(startRepoClone(start, f.api)).toBe(false)
    expect(f.inputs).toHaveLength(1)
  })

  it('takes progress for its own request only', () => {
    const f = fakeApi()
    startRepoClone(start, f.api)
    f.emit({ requestId: 'other', phase: 'cloning', percent: 5 })
    expect(repoSession()).toMatchObject({ progress: null })
    f.emit({ requestId: f.inputs[0].requestId, phase: 'cloning', percent: 7 })
    expect(repoSession()).toMatchObject({ progress: { percent: 7 } })
  })

  it('lands a result and unsubscribes, and forget drops it', async () => {
    const f = fakeApi()
    startRepoClone(start, f.api)
    f.resolve(result)
    await settle()
    expect(repoSession()).toMatchObject({ status: 'done', result, display: 'o/r' })
    expect(f.unsubscribe).toHaveBeenCalledOnce()
    forgetRepoClone()
    expect(repoSession().status).toBe('idle')
  })

  it('cleans the IPC wrapper off a failure, and clear drops it', async () => {
    const f = fakeApi()
    startRepoClone(start, f.api)
    f.reject(new Error("Error invoking remote method 'projects:cloneRepo': Error: Not found."))
    await settle()
    expect(repoSession()).toMatchObject({ status: 'failed', message: 'Not found.', cancelled: false })
    clearRepoFailure()
    expect(repoSession().status).toBe('idle')
  })

  it('reports a stop the user asked for as cancelled', async () => {
    const f = fakeApi()
    startRepoClone(start, f.api)
    cancelRepoClone({}, f.api)
    expect(repoSession()).toMatchObject({ status: 'running', cancelling: true })
    expect(f.api.repos.cancelClone).toHaveBeenCalledWith(f.inputs[0].requestId)
    f.reject(new Error(REPO_CLONE_CANCELLED_PREFIX))
    await settle()
    expect(repoSession()).toMatchObject({ status: 'failed', cancelled: true })
  })

  it('a quiet stop leaves nothing to show, and a clone that won the race is kept', async () => {
    const f = fakeApi()
    startRepoClone(start, f.api)
    cancelRepoClone({ quiet: true }, f.api)
    f.reject(new Error(REPO_CLONE_CANCELLED_PREFIX))
    await settle()
    expect(repoSession().status).toBe('idle')

    const g = fakeApi()
    startRepoClone(start, g.api)
    cancelRepoClone({ quiet: true }, g.api)
    g.resolve(result)
    await settle()
    expect(repoSession()).toMatchObject({ status: 'done', result })
  })
})
