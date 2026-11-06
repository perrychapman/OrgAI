import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isSharedInprocHost, markSharedHost, sharedHostMarkerPath } from './sharedHost'

let base: string
let dataDir: string
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'shh-'))
  dataDir = join(base, 'data')
  mkdirSync(join(dataDir, 'run'), { recursive: true })
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

describe('shared in-process host marker (WP-B review round 2)', () => {
  it('marks, reports and unmarks one host id', () => {
    const id = 'abcdef012345'
    expect(isSharedInprocHost(dataDir, id)).toBe(false)
    const unmark = markSharedHost(dataDir, id, 4242)
    expect(isSharedInprocHost(dataDir, id)).toBe(true)
    expect(isSharedInprocHost(dataDir, 'aaaaaaaaaaaa')).toBe(false)
    if (process.platform !== 'win32') expect(statSync(sharedHostMarkerPath(dataDir, id)!).mode & 0o777).toBe(0o600)
    unmark()
    unmark()
    expect(isSharedInprocHost(dataDir, id)).toBe(false)
  })

  it('never builds a path from an id that is not a host instance id', () => {
    expect(sharedHostMarkerPath(dataDir, '../daemon')).toBeUndefined()
    expect(isSharedInprocHost(dataDir, '../../x')).toBe(false)
    expect(() => markSharedHost(dataDir, 'nope')).toThrow(/Invalid host instance id/)
  })

  it('a new shared host removes markers left by crashed ones, and nothing else in run/', () => {
    writeFileSync(join(dataDir, 'run', 'inproc-shared-111111111111'), '1\n')
    writeFileSync(join(dataDir, 'run', 'daemon.json'), '{}')
    markSharedHost(dataDir, '222222222222')
    expect(readdirSync(join(dataDir, 'run')).sort()).toEqual(['daemon.json', 'inproc-shared-222222222222'])
    expect(existsSync(join(dataDir, 'run', 'daemon.json'))).toBe(true)
  })
})
