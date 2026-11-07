import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { findOnPath, gitExecutable, lsofExecutable, neutralCwd, psExecutable, system32Path, windowsPowerShellPath, windowsSystemRoot } from './systemBinaries'

// Review H1: system programs by absolute path, git never from a cwd. The win32 cases run with platform injection only
// (UNVERIFIED on Windows).

describe('windows system paths', () => {
  it('builds System32 paths from SystemRoot, else C:\\Windows', () => {
    expect(windowsSystemRoot({ SystemRoot: 'D:\\WINDOWS\\' })).toBe('D:\\WINDOWS')
    expect(windowsSystemRoot({ SYSTEMROOT: 'E:/Win' })).toBe('E:\\Win')
    expect(windowsSystemRoot({ windir: 'F:\\W' })).toBe('F:\\W')
    expect(windowsSystemRoot({})).toBe('C:\\Windows')
    expect(system32Path('icacls.exe', { SystemRoot: 'D:\\WINDOWS' })).toBe('D:\\WINDOWS\\System32\\icacls.exe')
    expect(windowsPowerShellPath({})).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  })

  it('never trusts a relative, root-relative, UNC or odd SystemRoot', () => {
    for (const bad of ['Windows', '.\\Windows', '\\Windows', '\\\\server\\share', 'C:\\Win"dows', 'C:\\%X%', 'C:'])
      expect(windowsSystemRoot({ SystemRoot: bad })).toBe('C:\\Windows')
  })

  it('neutralCwd is the temp dir', () => {
    expect(neutralCwd()).toBe(tmpdir())
  })
})

describe('findOnPath', () => {
  const files = (set: string[]) => (p: string) => set.includes(p)

  it('win32: only <dir>\\<name>.exe in drive-path entries; never the cwd, a relative entry, UNC or a .cmd shim', () => {
    const env = { Path: '.;bin;;"C:\\Program Files\\Git\\cmd";\\\\srv\\tools;D:\\tools' }
    const isFile = files(['bin\\git.exe', '.\\git.exe', '\\\\srv\\tools\\git.exe', 'C:\\Program Files\\Git\\cmd\\git.exe', 'D:\\tools\\git.exe'])
    expect(findOnPath('git', { platform: 'win32', env, isFile })).toBe('C:\\Program Files\\Git\\cmd\\git.exe')
    expect(findOnPath('git', { platform: 'win32', env: { Path: '.;bin' }, isFile })).toBeUndefined()
    expect(findOnPath('git', { platform: 'win32', env: { PATH: 'C:\\x' }, isFile: files(['C:\\x\\git.cmd']) })).toBeUndefined()
  })

  it('posix: absolute entries only', () => {
    const isFile = files(['git', './git', '/usr/bin/git'])
    expect(findOnPath('git', { platform: 'linux', env: { PATH: ':.:rel:/usr/bin' }, isFile })).toBe('/usr/bin/git')
    expect(findOnPath('git', { platform: 'linux', env: { PATH: ':.' }, isFile })).toBeUndefined()
  })
})

describe('gitExecutable', () => {
  it('win32: an absolute git.exe or undefined, never a bare name', () => {
    expect(gitExecutable({ platform: 'win32', env: { Path: 'C:\\Git\\cmd' }, isFile: (p) => p === 'C:\\Git\\cmd\\git.exe' })).toBe('C:\\Git\\cmd\\git.exe')
    // Not on PATH: Git for Windows' own install folder.
    expect(gitExecutable({ platform: 'win32', env: { Path: '', ProgramFiles: 'C:\\Program Files' }, isFile: (p) => p === 'C:\\Program Files\\Git\\cmd\\git.exe' })).toBe(
      'C:\\Program Files\\Git\\cmd\\git.exe'
    )
    expect(gitExecutable({ platform: 'win32', env: { Path: '.' }, isFile: () => true })).toBeUndefined()
  })

  it('posix: the absolute PATH hit, else the bare name', () => {
    expect(gitExecutable({ platform: 'darwin', env: { PATH: '/opt/homebrew/bin:/usr/bin' }, isFile: (p) => p === '/usr/bin/git' })).toBe('/usr/bin/git')
    expect(gitExecutable({ platform: 'linux', env: { PATH: '' }, isFile: () => false })).toBe('git')
  })

  it('ps and lsof use fixed absolute paths in order, never PATH', () => {
    expect(psExecutable({ platform: 'linux', isFile: () => true })).toBe('/bin/ps')
    expect(psExecutable({ platform: 'darwin', isFile: (p) => p === '/usr/bin/ps' })).toBe('/usr/bin/ps')
    expect(lsofExecutable({ platform: 'darwin', isFile: () => true })).toBe('/usr/sbin/lsof')
    expect(lsofExecutable({ platform: 'linux', isFile: (p) => p === '/usr/bin/lsof' })).toBe('/usr/bin/lsof')
  })

  it('ps and lsof are undefined when none exists or on win32', () => {
    expect(psExecutable({ platform: 'linux', isFile: () => false })).toBeUndefined()
    expect(lsofExecutable({ platform: 'darwin', isFile: () => false })).toBeUndefined()
    expect(psExecutable({ platform: 'win32', isFile: () => true })).toBeUndefined()
  })

  it.skipIf(process.platform === 'win32')('finds the real git here', () => {
    const g = gitExecutable()
    expect(g).toBeTruthy()
  })
})
