import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), on: () => {}, getVersion: () => '0.0.0', isPackaged: false } }))

const { canWriteDir, dataDirOverride, pickLogsDir } = await import('./log')

describe('dataDirOverride', () => {
  it('is undefined when ORGAI_DATA_DIR is unset or blank', () => {
    expect(dataDirOverride({})).toBeUndefined()
    expect(dataDirOverride({ ORGAI_DATA_DIR: '   ' })).toBeUndefined()
  })
  it('puts logs under the data dir and resolves relative values against cwd', () => {
    const abs = resolve('/ci/orgai-data')
    expect(dataDirOverride({ ORGAI_DATA_DIR: abs })).toEqual({ userData: abs, logs: join(abs, 'logs') })
    const cwd = resolve('/work')
    expect(dataDirOverride({ ORGAI_DATA_DIR: ' rel/data ' }, cwd)).toEqual({ userData: join(cwd, 'rel', 'data'), logs: join(cwd, 'rel', 'data', 'logs') })
  })
})

describe('pickLogsDir', () => {
  const boom = (): string => {
    throw new Error('Failed to get logs path')
  }

  it('takes the first writable candidate', () => {
    expect(pickLogsDir([() => '/a', () => '/b'], (d) => d === '/b')).toBe('/b')
    expect(pickLogsDir([() => '/a', () => '/b'], () => true)).toBe('/a')
  })
  it('skips candidates that throw', () => {
    expect(pickLogsDir([boom, () => '/user/logs'], () => true)).toBe('/user/logs')
  })
  it('falls back to the first resolved candidate, then to the fallback, and survives a throwing canWrite', () => {
    expect(pickLogsDir([() => '/a', () => '/b'], () => false)).toBe('/a')
    expect(
      pickLogsDir([() => '/a'], () => {
        throw new Error('EACCES')
      })
    ).toBe('/a')
    expect(pickLogsDir([boom], () => true, '/tmp/fallback')).toBe('/tmp/fallback')
  })
})

describe('canWriteDir', () => {
  it('creates a missing directory and reports it writable', () => {
    const base = mkdtempSync(join(tmpdir(), 'orgai-logtest-'))
    try {
      expect(canWriteDir(join(base, 'nested', 'logs'))).toBe(true)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})
