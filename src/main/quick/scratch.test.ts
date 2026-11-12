import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isTrustRestrictedRun, isWorkspaceConfigPath, unreadableFolderMessage } from './scratch'

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

describe('unreadableFolderMessage (cli-standalone-default.md 4.4)', () => {
  const err = (code?: string): Error => Object.assign(new Error('x'), code ? { code } : {})
  it('macOS EPERM names the privacy setting and the program running the host', () => {
    const m = unreadableFolderMessage('/Users/a/Documents/x', err('EPERM'), 'darwin', '/usr/local/bin/node')
    expect(m).toContain('macOS blocked OrgAI from reading /Users/a/Documents/x')
    expect(m).toContain('Privacy & Security > Files and Folders')
    expect(m).toContain('/usr/local/bin/node')
  })
  it('EACCES is the folder permissions; EPERM elsewhere and unknown errors keep the code', () => {
    expect(unreadableFolderMessage('/x', err('EACCES'), 'darwin')).toBe("You do not have permission to read /x. Check the folder's permissions.")
    expect(unreadableFolderMessage('/x', err('EPERM'), 'linux')).toBe('OrgAI cannot read /x (EPERM). Check its permissions.')
    expect(unreadableFolderMessage('/x', err(), 'linux')).toBe('OrgAI cannot read /x. Check its permissions.')
  })
})
