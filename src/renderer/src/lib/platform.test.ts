import { describe, expect, it } from 'vitest'
import { examplePath, isMacPlatform, modKeyLabel } from './platform'

describe('platform helpers', () => {
  it('detects mac', () => {
    expect(isMacPlatform('MacIntel')).toBe(true)
    expect(isMacPlatform('Win32')).toBe(false)
    expect(modKeyLabel('MacIntel')).toBe('Cmd')
    expect(modKeyLabel('Linux x86_64')).toBe('Ctrl')
  })
  it('example paths follow the platform', () => {
    expect(examplePath('repo', 'Win32')).toBe('C:\\path\\to\\repo')
    expect(examplePath('repo', 'MacIntel')).toBe('~/Projects/repo')
  })
})
