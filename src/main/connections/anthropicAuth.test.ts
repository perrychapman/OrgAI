import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { anthropicStatus, claudeCandidatePaths, dedupeByRealpath } from './anthropicAuth'

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

describe('dedupeByRealpath', () => {
  it('keeps the first spelling of paths that resolve to the same file', () => {
    const links: Record<string, string> = {
      '/opt/homebrew/bin/claude': '/opt/homebrew/Cellar/claude/1.0/bin/claude',
      '/opt/homebrew/Cellar/claude/1.0/bin/claude': '/opt/homebrew/Cellar/claude/1.0/bin/claude',
      '/Users/me/.local/bin/claude': '/Users/me/.claude/local/claude',
      '/Users/me/.claude/local/claude': '/Users/me/.claude/local/claude'
    }
    const real = (p: string): string => {
      if (!(p in links)) throw new Error('ENOENT')
      return links[p]
    }
    expect(
      dedupeByRealpath(
        ['/opt/homebrew/bin/claude', '/Users/me/.local/bin/claude', '/opt/homebrew/Cellar/claude/1.0/bin/claude', '/Users/me/.claude/local/claude', 'claude'],
        real
      )
    ).toEqual(['/opt/homebrew/bin/claude', '/Users/me/.local/bin/claude', 'claude'])
  })
})

describe('anthropicStatus (API key)', () => {
  it('is connected only when the env var is set', async () => {
    expect((await anthropicStatus({ kind: 'apiKey', envVar: 'K' }, { K: 'x' })).state).toBe('connected')
    expect((await anthropicStatus({ kind: 'apiKey', envVar: 'K' }, {})).state).toBe('disconnected')
  })
})
