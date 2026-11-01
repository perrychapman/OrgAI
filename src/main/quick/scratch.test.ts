import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isTrustRestrictedRun, isWorkspaceConfigPath } from './scratch'

describe('isTrustRestrictedRun', () => {
  it('covers quick runs and build sessions only', () => {
    expect(isTrustRestrictedRun(undefined)).toBe(false)
    expect(isTrustRestrictedRun({})).toBe(false)
    expect(isTrustRestrictedRun({ buildWorkspace: '/x/quick/quick_a' })).toBe(true)
    expect(isTrustRestrictedRun({ quick: { folder: '/x', team: 'single', allowEdits: false, gitRepo: false } })).toBe(true)
  })
})

describe('isWorkspaceConfigPath', () => {
  let ws: string
  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), 'orgai-wscfg-'))
  })
  afterEach(() => rmSync(ws, { recursive: true, force: true }))

  it('protects .claude and anything below it, absolute or relative', () => {
    expect(isWorkspaceConfigPath(ws, join(ws, '.claude'))).toBe(true)
    expect(isWorkspaceConfigPath(ws, join(ws, '.claude', 'settings.local.json'))).toBe(true)
    expect(isWorkspaceConfigPath(ws, '.claude/settings.json')).toBe(true)
    expect(isWorkspaceConfigPath(ws, join(ws, 'sub', '..', '.claude', 'x'))).toBe(true)
  })

  it('allows ordinary files', () => {
    expect(isWorkspaceConfigPath(ws, join(ws, 'server.mjs'))).toBe(false)
    expect(isWorkspaceConfigPath(ws, 'src/.claude-notes.md')).toBe(false)
    expect(isWorkspaceConfigPath(ws, join(ws, 'pkg', '.claude', 'x'))).toBe(false)
  })

  it('fails closed on junk input', () => {
    expect(isWorkspaceConfigPath(ws, undefined)).toBe(true)
    expect(isWorkspaceConfigPath(ws, '')).toBe(true)
    expect(isWorkspaceConfigPath(ws, 42)).toBe(true)
  })

  it('catches a link inside the workspace that points at its .claude dir', () => {
    mkdirSync(join(ws, '.claude'))
    try {
      symlinkSync(join(ws, '.claude'), join(ws, 'cfg'), 'junction')
    } catch {
      return // no link support here
    }
    expect(isWorkspaceConfigPath(ws, join(ws, 'cfg', 'settings.json'))).toBe(true)
  })
})
