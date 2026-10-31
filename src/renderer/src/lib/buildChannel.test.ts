import { describe, expect, it } from 'vitest'
import { devBuildLabel, isDevBuild } from './buildChannel'

describe('isDevBuild', () => {
  it('detects dev prerelease tags', () => {
    expect(isDevBuild('0.1.5-dev')).toBe(true)
    expect(isDevBuild('0.1.5-dev.3')).toBe(true)
    expect(isDevBuild('1.0.0-alpha.dev.1+abc')).toBe(true)
  })
  it('rejects releases and other prereleases', () => {
    expect(isDevBuild('0.1.5')).toBe(false)
    expect(isDevBuild('0.1.5-beta.1')).toBe(false)
    expect(isDevBuild('0.1.5+dev')).toBe(false)
    expect(isDevBuild('')).toBe(false)
    expect(isDevBuild(undefined)).toBe(false)
  })
  it('labels', () => expect(devBuildLabel('0.1.5-dev')).toBe('Dev build 0.1.5-dev'))
})
