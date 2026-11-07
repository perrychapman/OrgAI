import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../main/host/fsRetry', () => ({
  renameSyncRetry: () => {
    throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
  }
}))

import { SETTINGS_FILE, writeTerminalAccessNow } from './terminalAccessSettings'

describe('writeTerminalAccessNow', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orgai-tas-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('removes the temp file and rethrows when the rename fails', () => {
    writeFileSync(join(dir, SETTINGS_FILE), JSON.stringify({ version: 1, settings: {} }))
    expect(() => writeTerminalAccessNow(dir, { on: true })).toThrow('EPERM')
    expect(readdirSync(dir)).toEqual([SETTINGS_FILE])
    expect(existsSync(join(dir, SETTINGS_FILE))).toBe(true)
  })
})
