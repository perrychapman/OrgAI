import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { canWriteDir, dataDirOverride, logsDir, pickLogsDir, startupLine } from './log'

// No vi.mock('electron'): log.ts must load and log in plain Node (cli-spec 3.1.1).

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

describe('installLogging', () => {
  const base = mkdtempSync(join(tmpdir(), 'orgai-loginstall-'))
  const saved = { error: console.error, warn: console.warn }
  afterAll(() => {
    console.error = saved.error
    console.warn = saved.warn
    rmSync(base, { recursive: true, force: true })
  })

  it('falls back to <tmpdir>/orgai-logs before it runs', async () => {
    vi.resetModules()
    const fresh = await import('./log')
    expect(fresh.logsDir()).toBe(join(tmpdir(), 'orgai-logs'))
    expect(logsDir()).toBeTruthy()
  })

  it('creates env.logsDir and writes main.log there with the startup line', async () => {
    vi.resetModules()
    const fresh = await import('./log')
    const dir = join(base, 'nested', 'logs')
    const silent = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      fresh.installLogging({ userDataDir: base, logsDir: dir, appVersion: '9.9.9-test', isPackaged: false })
      fresh.log.info('hello from the test')
      console.warn('mirrored warning')
    } finally {
      silent.mockRestore()
    }
    expect(fresh.logsDir()).toBe(dir)
    expect(fresh.logPath()).toBe(join(dir, 'main.log'))
    const text = readFileSync(join(dir, 'main.log'), 'utf8')
    expect(text).toMatch(/OrgAI 9\.9\.9-test starting \(node /)
    expect(text).not.toContain('electron')
    expect(text).toContain('hello from the test')
    expect(existsSync(join(dir, 'main.log'))).toBe(true)
  })
})

describe('startupLine', () => {
  it('names electron only when the env carries its version', () => {
    expect(startupLine({ userDataDir: '/u', logsDir: '/l', appVersion: '1.2.3', isPackaged: true })).toMatch(/^OrgAI 1\.2\.3 starting \(node .*packaged=true\)$/)
    expect(startupLine({ userDataDir: '/u', logsDir: '/l', appVersion: '1.2.3', isPackaged: false, electronVersion: '40.0.0' })).toContain('(electron 40.0.0, node ')
  })
})
