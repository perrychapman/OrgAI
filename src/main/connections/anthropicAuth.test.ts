import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { anthropicStatus, claudeCandidatePaths } from './anthropicAuth'

describe('claudeCandidatePaths', () => {
  it('lists the native installer and Homebrew locations that exist on macOS', () => {
    const home = '/Users/me'
    const present = new Set([join(home, '.claude', 'local', 'claude'), '/opt/homebrew/bin/claude'])
    expect(claudeCandidatePaths('darwin', home, (p) => present.has(p))).toEqual([join(home, '.claude', 'local', 'claude'), '/opt/homebrew/bin/claude'])
  })

  it('is empty on Windows and survives a throwing exists()', () => {
    expect(claudeCandidatePaths('win32', 'C:/Users/me', () => true)).toEqual([])
    expect(
      claudeCandidatePaths('linux', '/home/me', () => {
        throw new Error('EACCES')
      })
    ).toEqual([])
  })
})

describe('anthropicStatus (API key)', () => {
  it('is connected only when the env var is set', async () => {
    expect((await anthropicStatus({ kind: 'apiKey', envVar: 'K' }, { K: 'x' })).state).toBe('connected')
    expect((await anthropicStatus({ kind: 'apiKey', envVar: 'K' }, {})).state).toBe('disconnected')
  })
})
