import { describe, expect, it } from 'vitest'
import { allowedDirectoryRisk } from './allowedDirectories'

describe('allowedDirectoryRisk on darwin folds case (reviewer-3 M3)', () => {
  const mac = { platform: 'darwin' as const, home: '/Users/u', projectPath: '/Users/u/proj' }

  it('refuses another case spelling of a credential folder, home, the data folder or a folder containing the project', () => {
    for (const d of ['/Users/u/.SSH', '/Users/u/.Aws/x', '/users/u/Library/Keychains', '/USERS/U', '/Users/U/Documents/powershell']) {
      expect(allowedDirectoryRisk(d, mac), d).toBe('unsafe')
    }
    expect(allowedDirectoryRisk('/Users/u/Data/x', { ...mac, deniedDirs: ['/Users/u/data'] })).toBe('unsafe')
  })

  it('reads another case spelling of the project as the project', () => {
    expect(allowedDirectoryRisk('/Users/u/PROJ/sub', mac)).toBe('project')
    expect(allowedDirectoryRisk('/Users/u/notes', mac)).toBeNull()
  })

  it('linux stays case-sensitive', () => {
    const linux = { platform: 'linux' as const, home: '/home/u', projectPath: '/home/u/proj' }
    expect(allowedDirectoryRisk('/home/u/.SSH', linux)).toBeNull()
    expect(allowedDirectoryRisk('/home/u/.ssh', linux)).toBe('unsafe')
    expect(allowedDirectoryRisk('/home/u/PROJ', linux)).toBeNull()
  })
})
