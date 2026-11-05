import { describe, expect, it } from 'vitest'
import { resolveRunRef } from './runRef'
import { CliError, EXIT } from './types'

const runs = [
  { id: 'run_aaaaaa111', projectId: 'p1', startedAt: 100 },
  { id: 'run_aaaaaa222', projectId: 'p1', startedAt: 200 },
  { id: 'run_bbbbbb333', projectId: 'p1', startedAt: 300 },
  { id: 'run_cccccc444', projectId: 'p2', startedAt: 50 }
]

function usageError(fn: () => unknown): CliError {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(CliError)
    expect((e as CliError).exitCode).toBe(EXIT.usage)
    return e as CliError
  }
  throw new Error('expected a CliError')
}

describe('resolveRunRef', () => {
  it('accepts a full id', () => {
    expect(resolveRunRef('run_cccccc444', { runs })).toBe('run_cccccc444')
  })

  it('R3 and r3 index the project runs by start order', () => {
    expect(resolveRunRef('R3', { runs, projectId: 'p1' })).toBe('run_bbbbbb333')
    expect(resolveRunRef('r1', { runs, projectId: 'p1' })).toBe('run_aaaaaa111')
    expect(resolveRunRef('R1', { runs, projectId: 'p2' })).toBe('run_cccccc444')
  })

  it('R# needs a project and an existing index', () => {
    expect(usageError(() => resolveRunRef('R2', { runs })).message).toMatch(/needs a project/)
    expect(usageError(() => resolveRunRef('R9', { runs, projectId: 'p1' })).message).toMatch(/no run R9/)
  })

  it('a unique prefix of at least 6 chars', () => {
    expect(resolveRunRef('run_bb', { runs })).toBe('run_bbbbbb333')
    expect(usageError(() => resolveRunRef('run_b', { runs })).message).toMatch(/at least 6/)
  })

  it('ambiguous and unknown refs are usage errors', () => {
    expect(usageError(() => resolveRunRef('run_aaaaaa', { runs })).message).toMatch(/matches 2 runs/)
    expect(usageError(() => resolveRunRef('run_zzzzzz', { runs })).message).toMatch(/No run matches/)
    expect(usageError(() => resolveRunRef('../etc', { runs })).message).toMatch(/not a run id/)
    usageError(() => resolveRunRef('', { runs }))
  })
})
