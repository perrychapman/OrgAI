import { describe, expect, it } from 'vitest'
import type { CliCommandStatus } from '@shared/types'
import { cleanBlock, cliCommandNotice, cliCommandView, hasCliCommandApi, singleFlight } from './cliCommand'

const base: CliCommandStatus = { state: 'not-installed', oldShim: false, npmFound: true, tag: 'latest', command: 'npm install -g orgai-cli@latest', installing: false }

describe('cliCommandView', () => {
  it('words each state', () => {
    expect(cliCommandView(base).line).toBe('Not installed')
    expect(cliCommandView({ ...base, state: 'npm', version: '0.2.0', path: '/x/orgai' })).toMatchObject({ line: 'Installed (npm, 0.2.0)', installLabel: 'Update', runs: '/x/orgai' })
    expect(cliCommandView({ ...base, state: 'old-shim', oldShim: true }).line).toBe('Old OrgAI app command (no longer works)')
    expect(cliCommandView({ ...base, state: 'other', path: '/y/orgai' }).line).toBe('Another program named orgai')
  })
  it('offers the old shim removal whenever one is present, even behind an npm install', () => {
    expect(cliCommandView({ ...base, state: 'npm', oldShim: true }).removeOld).toBe(true)
    expect(cliCommandView(base).removeOld).toBe(false)
  })
  it('says where an old command is when the app cannot remove it', () => {
    const v = cliCommandView({ ...base, state: 'old-shim', oldShim: false, path: '/old/bin/orgai' })
    expect(v.removeOld).toBe(false)
    expect(v.removeByHand).toContain('/old/bin/orgai')
    expect(cliCommandView({ ...base, state: 'old-shim', oldShim: true, path: '/old/bin/orgai' }).removeByHand).toBeUndefined()
    expect(cliCommandView({ ...base, state: 'npm', path: '/x/orgai' }).removeByHand).toBeUndefined()
  })
  it('blocks Install without npm and hides a hostile version', () => {
    expect(cliCommandView({ ...base, npmFound: false }).installBlockedReason).toMatch(/npm was not found/)
    expect(cliCommandView({ ...base, state: 'npm', version: 'x y‮' }).line).toBe('Installed (npm)')
  })
})

describe('helpers', () => {
  it('strips hidden characters from npm output and notices', () => {
    expect(cleanBlock('a‮b\nc\u0007d')).toBe('ab\ncd')
    expect(cliCommandNotice({ ok: false, message: '', status: base })).toBe('OrgAI could not change the orgai command.')
    expect(cliCommandNotice({ ok: true, message: 'Done x', status: base })).toBe('Done x')
  })
  it('detects the API and allows one action at a time', async () => {
    expect(hasCliCommandApi({})).toBe(false)
    const f = singleFlight<number>()
    const a = f.run(async () => 1)
    expect(f.run(async () => 2)).toBeNull()
    await a
    expect(f.busy()).toBe(false)
  })
})
