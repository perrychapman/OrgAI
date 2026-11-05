import { describe, expect, it } from 'vitest'
import { versionLine } from './versionLine'

describe('versionLine', () => {
  it('starts with the version, then channel and commit', () => {
    expect(versionLine('0.1.6', { channel: 'npm', version: '0.1.6', commit: '1a2b3c4d5e6f', source: 'file' })).toBe('0.1.6 channel npm commit 1a2b3c4d5e6f')
    expect(versionLine('0.1.6-dev1', { channel: 'dev', source: 'absent' })).toBe('0.1.6-dev1 channel dev')
    expect(versionLine('0.1.6', { channel: 'dev', source: 'invalid', problem: 'x' })).toBe('0.1.6 channel dev')
  })
  it('names an install.json from another build', () => {
    expect(versionLine('0.1.7', { channel: 'app', version: '0.1.6', source: 'file' })).toBe('0.1.7 channel app (install.json says 0.1.6)')
  })
})
