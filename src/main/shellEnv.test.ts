import { describe, expect, it } from 'vitest'
import { applyShellPath, compareVersionsDesc, mergePaths, parseMarkedValue, resolveShellPath, wellKnownDirs } from './shellEnv'

describe('parseMarkedValue', () => {
  it('extracts the value between markers and ignores banners', () => {
    expect(parseMarkedValue('welcome\n<<a:b:c>>\n', '<<', '>>')).toBe('a:b:c')
  })
  it('uses the last start marker and returns undefined when absent or empty', () => {
    expect(parseMarkedValue('<<old>> noise <<new>>', '<<', '>>')).toBe('new')
    expect(parseMarkedValue('nothing', '<<', '>>')).toBeUndefined()
    expect(parseMarkedValue('<<>>', '<<', '>>')).toBeUndefined()
    expect(parseMarkedValue('<<unterminated', '<<', '>>')).toBeUndefined()
  })
})

describe('mergePaths', () => {
  it('keeps first-list order, de-duplicates and drops empties', () => {
    expect(mergePaths([['/a', '/b', ''], ['/b', '/c'], ['/a', '/d']])).toEqual(['/a', '/b', '/c', '/d'])
  })
})

describe('compareVersionsDesc', () => {
  it('sorts newest first, numerically', () => {
    expect(['v18.2.0', 'v22.10.1', 'v22.9.0', 'v9.0.0'].sort(compareVersionsDesc)).toEqual(['v22.10.1', 'v22.9.0', 'v18.2.0', 'v9.0.0'])
  })
})

describe('wellKnownDirs', () => {
  it('lists only existing directories and picks the newest nvm node', () => {
    const present = new Set(['/opt/homebrew/bin', '/Users/me/.cargo/bin', '/Users/me/.nvm/versions/node/v22.10.0/bin'])
    const dirs = wellKnownDirs('/Users/me', (p) => present.has(p.replace(/\\/g, '/')), () => ['v20.1.0', 'v22.10.0', 'junk'])
    expect(dirs.map((d) => d.replace(/\\/g, '/'))).toEqual(['/opt/homebrew/bin', '/Users/me/.nvm/versions/node/v22.10.0/bin', '/Users/me/.cargo/bin'])
  })
  it('survives a missing nvm directory', () => {
    expect(
      wellKnownDirs('/h', () => false, () => {
        throw new Error('ENOENT')
      })
    ).toEqual([])
  })
})

describe('resolveShellPath', () => {
  const none = { exists: () => false, readdir: () => [] }

  it('is a no-op on win32 and never runs a shell', () => {
    let ran = false
    const r = resolveShellPath({ platform: 'win32', env: { PATH: 'C:\\x' }, run: () => ((ran = true), ''), ...none })
    expect(ran).toBe(false)
    expect(r.path).toBe('C:\\x')
    expect(r.added).toEqual([])
  })

  it('merges the login shell PATH after the existing one', () => {
    const r = resolveShellPath({
      platform: 'darwin',
      env: { PATH: '/usr/bin:/bin', SHELL: '/bin/zsh' },
      seed: 's',
      run: (shell, args) => {
        expect(shell).toBe('/bin/zsh')
        expect(args[0]).toBe('-ilc')
        return 'banner\n__ORGAI_PATH_s_START__/opt/homebrew/bin:/usr/bin:/Users/me/.volta/bin__ORGAI_PATH_s_END__'
      },
      ...none
    })
    expect(r.path).toBe('/usr/bin:/bin:/opt/homebrew/bin:/Users/me/.volta/bin')
    expect(r.added).toEqual(['/opt/homebrew/bin', '/Users/me/.volta/bin'])
    expect(r.fromShell).toBe(true)
  })

  it('falls back to /bin/zsh on darwin without SHELL and still adds well-known dirs when the shell fails', () => {
    let used = ''
    const r = resolveShellPath({
      platform: 'darwin',
      env: { PATH: '/usr/bin' },
      home: '/h',
      run: (shell) => {
        used = shell
        throw new Error('timed out\nmore')
      },
      exists: (p) => p === '/opt/homebrew/bin',
      readdir: () => []
    })
    expect(used).toBe('/bin/zsh')
    expect(r.path).toBe('/usr/bin:/opt/homebrew/bin')
    expect(r.fromShell).toBe(false)
    expect(r.note).toContain('timed out')
  })

  it('uses /bin/bash on linux without SHELL', () => {
    let used = ''
    resolveShellPath({ platform: 'linux', env: {}, run: (s) => ((used = s), ''), ...none })
    expect(used).toBe('/bin/bash')
  })
})

describe('applyShellPath', () => {
  it('writes PATH on darwin and leaves it alone on win32', () => {
    const mac: NodeJS.ProcessEnv = { PATH: '/usr/bin' }
    applyShellPath({ platform: 'darwin', env: mac, run: () => '', exists: () => false, readdir: () => [] })
    expect(mac.PATH).toBe('/usr/bin')
    const mac2: NodeJS.ProcessEnv = { PATH: '/usr/bin' }
    applyShellPath({ platform: 'darwin', env: mac2, seed: 'x', run: () => '__ORGAI_PATH_x_START__/opt/homebrew/bin__ORGAI_PATH_x_END__', exists: () => false, readdir: () => [] })
    expect(mac2.PATH).toBe('/usr/bin:/opt/homebrew/bin')
    const win: NodeJS.ProcessEnv = { PATH: 'C:\\x' }
    applyShellPath({ platform: 'win32', env: win })
    expect(win.PATH).toBe('C:\\x')
  })
  it('never throws', () => {
    expect(() => applyShellPath({ platform: 'darwin', env: { PATH: '/a' }, exists: () => { throw new Error('x') }, readdir: () => { throw new Error('y') }, run: () => { throw new Error('z') } })).not.toThrow()
  })
})
