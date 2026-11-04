import { afterEach, describe, expect, it, vi } from 'vitest'

const fsCalls: string[] = []

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const existsSync = vi.fn((p: string) => {
    fsCalls.push(`exists:${String(p)}`)
    return actual.existsSync(p)
  })
  const realpath = Object.assign(
    vi.fn((p: string) => {
      fsCalls.push(`realpath:${String(p)}`)
      return actual.realpathSync(p)
    }),
    {
      native: vi.fn((p: string) => {
        fsCalls.push(`native:${String(p)}`)
        return actual.realpathSync.native(p)
      })
    }
  )
  return { ...actual, existsSync, realpathSync: realpath }
})

import { canonicalDeep, isNetworkPath } from './scratch'

afterEach(() => {
  fsCalls.length = 0
  vi.unstubAllGlobals()
})

describe('canonicalDeep network paths (H-A)', () => {
  it.runIf(process.platform === 'win32')('never touches the file system for UNC and device paths on win32', () => {
    for (const p of ['\\\\host\\share\\x', '//host/s/x', '\\\\?\\UNC\\host\\share\\x', '\\\\.\\pipe\\x', '\\\\localhost\\C$\\x']) {
      const out = canonicalDeep(p)
      expect(typeof out).toBe('string')
      expect(isNetworkPath(out)).toBe(true)
    }
    expect(fsCalls).toEqual([])
  })

  it('still resolves an ordinary path through the file system', () => {
    canonicalDeep(process.cwd())
    expect(fsCalls.length).toBeGreaterThan(0)
  })

  it('classifies network prefixes per platform', () => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')!
    try {
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      expect(isNetworkPath('/net/host/x')).toBe(true)
      expect(isNetworkPath('/Network/Servers/x')).toBe(true)
      expect(isNetworkPath('/Users/me')).toBe(false)
      expect(isNetworkPath('/network-tools/x')).toBe(false)
      Object.defineProperty(process, 'platform', { value: 'win32' })
      expect(isNetworkPath('\\\\host\\s')).toBe(true)
      expect(isNetworkPath('C:\\x')).toBe(false)
      Object.defineProperty(process, 'platform', { value: 'linux' })
      expect(isNetworkPath('//host/s')).toBe(false)
    } finally {
      Object.defineProperty(process, 'platform', original)
    }
  })
})
