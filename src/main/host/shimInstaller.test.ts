import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type { Stats } from 'node:fs'
import { join as nodeJoin } from 'node:path'
import { createCliShimService, dirOnPath, NO_LAUNCHER_REASON, type CliShimDeps } from './shimInstaller'
import { CLI_SHIM_MARKER, packagedLayout, parseCliShim, renderCliShim } from './packagedLayout'

// These tests drive the service with an injected 'darwin' platform, which uses POSIX path rules (absolute = leading '/').
// On Windows node:path would give 'C:\...' paths those rules do not accept, so build every path with forward slashes
// and no drive letter (Windows fs resolves '/Users/...' against the current drive, which is the temp dir's drive here).
const join = (...parts: string[]): string => nodeJoin(...parts).replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')
const quiet ={ info: () => {}, warn: () => {} }
let root: string
let home: string
let resources: string
let launcher: string
let shim: string
let binDir: string

function fakeInstall(dir: string): { resources: string; launcher: string } {
  const res = join(dir, 'OrgAI.app', 'Contents', 'Resources')
  mkdirSync(join(res, 'bin'), { recursive: true })
  const l = join(res, 'bin', 'orgai')
  writeFileSync(l, '#!/bin/sh\n', { mode: 0o755 })
  return { resources: res, launcher: l }
}

beforeEach(() => {
  // The drive-less paths resolve against the current drive, so on Windows the root must live on it: the CI runner's
  // temp dir is on C: while the checkout (cwd) is on D:. Elsewhere the temp dir is fine.
  const base = process.platform === 'win32' ? nodeJoin(process.cwd(), 'node_modules', '.cache') : tmpdir()
  mkdirSync(base, { recursive: true })
  root = mkdtempSync(join(base, 'orgai-shim-'))
  home = join(root, 'home')
  mkdirSync(home)
  ;({ resources, launcher } = fakeInstall(join(root, 'Applications')))
  shim = join(home, '.local', 'bin', 'orgai')
  binDir = join(home, '.local', 'bin')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function deps(over: Partial<CliShimDeps> = {}): CliShimDeps {
  return {
    platform: 'darwin',
    isPackaged: true,
    dataDirOverride: false,
    resourcesPath: resources,
    userDataDir: join(home, 'Library', 'Application Support', 'OrgAI'),
    home,
    env: {},
    loginPath: '/usr/bin:/bin',
    log: quiet,
    ...over
  }
}

describe('availability', () => {
  it('is unavailable when not packaged', () => {
    const s = createCliShimService(deps({ isPackaged: false })).status()
    expect(s.state).toBe('unavailable')
    expect(s.reason).toBe('The orgai command can be added only from the installed OrgAI app, not from a development build. The npm package installs its own orgai.')
  })
  it('is unavailable with a data-dir override', () => {
    const s = createCliShimService(deps({ dataDirOverride: true })).status()
    expect(s.reason).toBe('OrgAI was started with ORGAI_DATA_DIR; manage the orgai command from a normal launch.')
  })
  it('cannot install when translocated or on a disk image', async () => {
    for (const res of ['/private/var/folders/x/AppTranslocation/ABC/d/OrgAI.app/Contents/Resources', '/Volumes/OrgAI/OrgAI.app/Contents/Resources']) {
      const r = await createCliShimService(deps({ resourcesPath: res })).install()
      expect(r.ok).toBe(false)
      expect(r.status.state).toBe('unavailable')
      expect(r.message).toMatch(/Applications folder/)
    }
  })
  it('cannot install from an AppImage or the portable build', async () => {
    expect((await createCliShimService(deps({ platform: 'linux', env: { APPIMAGE: '/x/OrgAI.AppImage' } })).install()).message).toMatch(/AppImage/)
    expect((await createCliShimService(deps({ platform: 'win32', env: { PORTABLE_EXECUTABLE_DIR: 'C:\\p' } })).install()).message).toMatch(/portable/)
  })
  it('cannot install without a launcher file (an app that ships none): says where the command comes from', async () => {
    rmSync(launcher)
    const svc = createCliShimService(deps())
    expect(svc.status()).toMatchObject({ state: 'not-installed', installable: false })
    const r = await svc.install()
    expect(r.ok).toBe(false)
    expect(r.message).toBe(NO_LAUNCHER_REASON)
    expect(existsSync(shim)).toBe(false)
  })
  it('a launcher that is a folder does not count', async () => {
    rmSync(launcher)
    mkdirSync(launcher)
    expect((await createCliShimService(deps()).install()).status.state).toBe('unavailable')
  })
  it('an old shim is still classified and removed when the app ships no launcher; a foreign file is not', async () => {
    const svc = createCliShimService(deps())
    expect((await svc.install()).ok).toBe(true)
    rmSync(launcher)
    expect(svc.status()).toMatchObject({ state: 'outdated', installable: false })
    const r = await svc.uninstall()
    expect(r.ok).toBe(true)
    expect(existsSync(shim)).toBe(false)
    writeFileSync(shim, '#!/bin/sh\necho mine\n')
    expect((await svc.uninstall()).ok).toBe(false)
    expect(existsSync(shim)).toBe(true)
  })
})

describe('install', () => {
  it('installs, then reports installed; onInstalled runs once', async () => {
    const onInstalled = vi.fn()
    const svc = createCliShimService(deps({ onInstalled }))
    const before = svc.status()
    expect(before).toMatchObject({ state: 'not-installed', path: shim, binDir, onPath: false })
    const r = await svc.install()
    expect(r.ok).toBe(true)
    expect(r.message).toBe(`Installed the orgai command at ${shim}. ${binDir} is not on your PATH yet; add it in your shell profile.`)
    // Unix permission bits do not exist on Windows files (stat reports 0o666/0o444).
    if (process.platform !== 'win32') expect(statSync(shim).mode & 0o777).toBe(0o755)
    const text = readFileSync(shim, 'utf8')
    expect(text).toContain(CLI_SHIM_MARKER)
    expect(parseCliShim(text, 'darwin')).toEqual({ launcher })
    expect(r.status).toMatchObject({ state: 'installed', target: launcher })
    expect(svc.status().state).toBe('installed')
    expect(onInstalled).toHaveBeenCalledTimes(1)
  })
  it('an onInstalled throw still gives ok:true', async () => {
    const svc = createCliShimService(
      deps({
        loginPath: `/usr/bin:${binDir}`,
        onInstalled: async () => {
          throw new Error('boom')
        }
      })
    )
    const r = await svc.install()
    expect(r.ok).toBe(true)
    expect(r.message).toBe(`Installed the orgai command at ${shim}.`)
  })
  it('refuses a foreign regular file and leaves it untouched', async () => {
    mkdirSync(binDir, { recursive: true })
    writeFileSync(shim, '#!/bin/sh\necho mine\n')
    const svc = createCliShimService(deps())
    expect(svc.status().state).toBe('foreign')
    const r = await svc.install()
    expect(r.ok).toBe(false)
    expect(r.message).toBe(`${shim} already exists and was not written by OrgAI. Remove or rename it to install the orgai command.`)
    expect(readFileSync(shim, 'utf8')).toBe('#!/bin/sh\necho mine\n')
  })
  // Creating a file symlink on Windows needs Developer Mode or admin (EPERM otherwise); the lstat guard is platform-independent.
  it.skipIf(process.platform === 'win32')('refuses a symlink, even to an OrgAI shim, and never writes through it', async () => {
    mkdirSync(binDir, { recursive: true })
    const real = join(root, 'elsewhere')
    const ownText = renderCliShim({ platform: 'darwin', launcher: '/old/orgai' })
    writeFileSync(real, ownText)
    symlinkSync(real, shim)
    const svc = createCliShimService(deps())
    expect(svc.status().state).toBe('foreign')
    expect((await svc.install()).ok).toBe(false)
    expect(await svc.refreshOnLaunch()).toBe('skipped')
    expect((await svc.uninstall()).ok).toBe(false)
    expect(lstatSync(shim).isSymbolicLink()).toBe(true)
    expect(readFileSync(real, 'utf8')).toBe(ownText)
  })
  it('leaves no tmp file after a rename failure', async () => {
    const svc = createCliShimService(
      deps({
        fs: {
          renameSync: () => {
            throw new Error('EXDEV simulated')
          }
        }
      })
    )
    const r = await svc.install()
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/EXDEV simulated/)
    expect(readdirSync(binDir)).toEqual([])
  })
  it('a foreign file appearing before the rename is not replaced', async () => {
    const svc = createCliShimService(
      deps({
        fs: {
          chmodSync: (p, m) => {
            chmodSync(p, m)
            writeFileSync(shim, 'theirs\n')
          }
        }
      })
    )
    const r = await svc.install()
    expect(r.ok).toBe(false)
    expect(readFileSync(shim, 'utf8')).toBe('theirs\n')
    expect(readdirSync(binDir)).toEqual(['orgai'])
  })
})

describe('outdated and refreshOnLaunch', () => {
  it('rewrites a shim for another launcher, then reports unchanged', async () => {
    mkdirSync(binDir, { recursive: true })
    writeFileSync(shim, renderCliShim({ platform: 'darwin', launcher: '/Old/OrgAI.app/Contents/Resources/bin/orgai' }), { mode: 0o755 })
    const svc = createCliShimService(deps())
    expect(svc.status()).toMatchObject({ state: 'outdated', target: '/Old/OrgAI.app/Contents/Resources/bin/orgai' })
    expect(await svc.refreshOnLaunch()).toBe('refreshed')
    expect(parseCliShim(readFileSync(shim, 'utf8'), 'darwin')).toEqual({ launcher })
    expect(svc.status().state).toBe('installed')
    expect(await svc.refreshOnLaunch()).toBe('unchanged')
    expect(readdirSync(binDir)).toEqual(['orgai'])
  })
  it('never creates a missing shim', async () => {
    const svc = createCliShimService(deps())
    expect(await svc.refreshOnLaunch()).toBe('skipped')
    expect(existsSync(shim)).toBe(false)
  })
  it('skips when unavailable and never throws', async () => {
    expect(await createCliShimService(deps({ isPackaged: false })).refreshOnLaunch()).toBe('skipped')
    mkdirSync(binDir, { recursive: true })
    writeFileSync(shim, renderCliShim({ platform: 'darwin', launcher: '/old/orgai' }))
    const svc = createCliShimService(
      deps({
        fs: {
          writeFileSync: () => {
            throw new Error('EACCES')
          }
        }
      })
    )
    expect(await svc.refreshOnLaunch()).toBe('skipped')
  })
  it('leaves a newer-format shim alone (review L)', async () => {
    mkdirSync(binDir, { recursive: true })
    const v2 = renderCliShim({ platform: 'darwin', launcher: '/Old/orgai' }).replace(CLI_SHIM_MARKER, 'orgai-shim v2')
    writeFileSync(shim, v2, { mode: 0o755 })
    expect(await createCliShimService(deps()).refreshOnLaunch()).toBe('skipped')
    expect(readFileSync(shim, 'utf8')).toBe(v2)
  })
  it('leaves a shim for another install that is still on disk alone (review L)', async () => {
    const other = fakeInstall(join(root, 'UserApps'))
    mkdirSync(binDir, { recursive: true })
    const text = renderCliShim({ platform: 'darwin', launcher: other.launcher })
    writeFileSync(shim, text, { mode: 0o755 })
    const svc = createCliShimService(deps())
    expect(await svc.refreshOnLaunch()).toBe('skipped')
    expect(readFileSync(shim, 'utf8')).toBe(text)
    expect(svc.status()).toMatchObject({ state: 'outdated', target: other.launcher })
    // Once that copy is gone (moved or deleted), the next launch points the shim here.
    rmSync(other.launcher)
    expect(await svc.refreshOnLaunch()).toBe('refreshed')
    expect(parseCliShim(readFileSync(shim, 'utf8'), 'darwin')).toEqual({ launcher })
  })
  it('a marker without a readable exec line is left alone', async () => {
    mkdirSync(binDir, { recursive: true })
    writeFileSync(shim, `#!/bin/sh\n# ${CLI_SHIM_MARKER}: x\nexec /unquoted "$@"\n`)
    expect(await createCliShimService(deps()).refreshOnLaunch()).toBe('skipped')
  })
  it('a foreign file is never touched by the refresh', async () => {
    mkdirSync(binDir, { recursive: true })
    writeFileSync(shim, 'mine\n')
    expect(await createCliShimService(deps()).refreshOnLaunch()).toBe('skipped')
    expect(readFileSync(shim, 'utf8')).toBe('mine\n')
  })
})

describe('uninstall', () => {
  it('removes only an own shim and keeps the bin folder', async () => {
    const svc = createCliShimService(deps())
    expect(await svc.uninstall()).toMatchObject({ ok: true, message: 'The orgai command is not installed.' })
    await svc.install()
    writeFileSync(join(binDir, 'other'), 'x')
    const r = await svc.uninstall()
    expect(r.ok).toBe(true)
    expect(r.status.state).toBe('not-installed')
    expect(existsSync(shim)).toBe(false)
    expect(readdirSync(binDir)).toEqual(['other'])
  })
  it('refuses a foreign file', async () => {
    mkdirSync(binDir, { recursive: true })
    writeFileSync(shim, 'mine\n')
    const r = await createCliShimService(deps()).uninstall()
    expect(r.ok).toBe(false)
    expect(readFileSync(shim, 'utf8')).toBe('mine\n')
  })
})

describe('userDataDir line', () => {
  it('is omitted for the default userDataDir', async () => {
    await createCliShimService(deps()).install()
    expect(readFileSync(shim, 'utf8')).not.toContain('ORGAI_DATA_DIR')
  })
  it('is written for a non-default userDataDir, as the userDataDir itself', async () => {
    const custom = join(root, 'profile')
    const svc = createCliShimService(deps({ userDataDir: custom }))
    await svc.install()
    const parsed = parseCliShim(readFileSync(shim, 'utf8'), 'darwin')
    expect(parsed).toEqual({ launcher, userDataDir: custom })
    expect(parsed?.userDataDir).not.toMatch(/[\\/]data$/)
    expect(svc.status().state).toBe('installed')
    // The same launcher with the default userDataDir reads as outdated and is refreshed.
    const plain = createCliShimService(deps())
    expect(plain.status().state).toBe('outdated')
    expect(await plain.refreshOnLaunch()).toBe('refreshed')
    expect(readFileSync(shim, 'utf8')).not.toContain('ORGAI_DATA_DIR')
  })
})

describe('onPath', () => {
  it('true, false and unknown', () => {
    expect(createCliShimService(deps({ loginPath: `/usr/bin:${binDir}` })).status().onPath).toBe(true)
    expect(createCliShimService(deps({ loginPath: '/usr/bin' })).status().onPath).toBe(false)
    expect(createCliShimService(deps({ loginPath: '' })).status().onPath).toBeUndefined()
    expect('onPath' in createCliShimService(deps({ loginPath: undefined, env: {} })).status()).toBe(false)
    expect(createCliShimService(deps({ loginPath: undefined, env: { PATH: `${binDir}/` } })).status().onPath).toBe(true)
  })
  it('folds case on darwin and win32, not on linux; ignores trailing separators; expands ~', () => {
    expect(dirOnPath('/Users/a/.local/bin', '/USERS/A/.local/bin/', 'darwin', '/Users/a')).toBe(true)
    expect(dirOnPath('/home/a/.local/bin', '/HOME/a/.local/bin', 'linux', '/home/a')).toBe(false)
    expect(dirOnPath('/home/a/.local/bin', '/usr/bin:~/.local/bin//', 'linux', '/home/a')).toBe(true)
    expect(dirOnPath('C:\\Users\\A\\AppData\\Local\\OrgAI\\bin', 'C:\\Windows;c:\\users\\a\\appdata\\local\\orgai\\bin\\', 'win32', 'C:\\Users\\A')).toBe(true)
    expect(dirOnPath('C:\\x', '', 'win32', 'C:\\Users\\A')).toBeUndefined()
  })
})

const posixOnly = process.platform === 'win32' ? it.skip : it

describe('otherCli (Wave 7, cli-standalone.md 8.2)', () => {
  /** An npm install's bin folder: <prefix>/bin/orgai -> ../lib/node_modules/orgai/out/cli/orgai.mjs with install.json. */
  function npmInstall(version: string): string {
    const cli = join(root, 'npm', 'lib', 'node_modules', 'orgai', 'out', 'cli')
    mkdirSync(cli, { recursive: true })
    writeFileSync(join(cli, 'orgai.mjs'), '', { mode: 0o755 })
    writeFileSync(join(cli, 'install.json'), JSON.stringify({ channel: 'npm', version }))
    mkdirSync(join(root, 'npm', 'bin'), { recursive: true })
    symlinkSync(join(cli, 'orgai.mjs'), join(root, 'npm', 'bin', 'orgai'))
    return join(root, 'npm', 'bin')
  }

  posixOnly('names an npm orgai on the login PATH, before or after the shim folder', async () => {
    const npmBin = npmInstall('0.2.0')
    const before = createCliShimService(deps({ loginPath: `${npmBin}:${binDir}` })).status()
    expect(before).toMatchObject({ state: 'not-installed', otherCli: { path: join(npmBin, 'orgai'), channel: 'npm', version: '0.2.0' } })
    const svc = createCliShimService(deps({ loginPath: `${binDir}:${npmBin}` }))
    await svc.install()
    // Our own shim first on PATH is skipped: the npm one is still reported.
    expect(svc.status()).toMatchObject({ state: 'installed', otherCli: { path: join(npmBin, 'orgai'), channel: 'npm' } })
  })

  posixOnly('ignores this install\'s shim and a link to this install\'s launcher; none when PATH is unknown', async () => {
    const svc = createCliShimService(deps({ loginPath: binDir }))
    await svc.install()
    expect(svc.status().otherCli).toBeUndefined()
    mkdirSync(join(root, 'linkbin'))
    symlinkSync(launcher, join(root, 'linkbin', 'orgai'))
    expect(createCliShimService(deps({ loginPath: `${join(root, 'linkbin')}:${binDir}` })).status().otherCli).toBeUndefined()
    expect(createCliShimService(deps({ loginPath: '' })).status().otherCli).toBeUndefined()
  })

  posixOnly('this install\'s launcher folder on PATH itself (VS Code style) is ours, not another command', () => {
    expect(createCliShimService(deps({ loginPath: `${join(resources, 'bin')}:/usr/bin` })).status().otherCli).toBeUndefined()
    // Also with the real launcher text and bundle, read by the PATH reader as an app launcher.
    writeFileSync(launcher, '#!/bin/sh\n# The orgai command of a packaged OrgAI (cli-spec 7, Wave 6).\n')
    const cli = join(resources, 'app.asar.unpacked', 'out', 'cli')
    mkdirSync(cli, { recursive: true })
    writeFileSync(join(cli, 'orgai.mjs'), '', { mode: 0o755 })
    writeFileSync(join(cli, 'install.json'), JSON.stringify({ channel: 'app', version: '0.1.7' }))
    const npmBin = npmInstall('0.2.0')
    expect(createCliShimService(deps({ loginPath: `${join(resources, 'bin')}:${npmBin}` })).status().otherCli).toEqual({ path: join(npmBin, 'orgai'), channel: 'npm', version: '0.2.0' })
  })

  it('a PATH entry whose path is this launcher counts as ours even when the reader gives no launcher', () => {
    const status = createCliShimService(deps({ findOnPath: () => [{ path: launcher, kind: 'unknown' }, { path: '/x/orgai', kind: 'npm', channel: 'npm' }] })).status()
    expect(status.otherCli).toEqual({ path: '/x/orgai', channel: 'npm' })
  })

  posixOnly('npm\'s own link at the shim path (npm prefix ~/.local) is another orgai, named as 8.2 says, never "remove it"', async () => {
    // npm prefix ~/.local: npm writes ~/.local/bin/orgai -> ../lib/node_modules/orgai/out/cli/orgai.mjs
    const cli = join(home, '.local', 'lib', 'node_modules', 'orgai', 'out', 'cli')
    mkdirSync(cli, { recursive: true })
    writeFileSync(join(cli, 'orgai.mjs'), '', { mode: 0o755 })
    writeFileSync(join(cli, 'install.json'), JSON.stringify({ channel: 'npm', version: '0.2.0' }))
    mkdirSync(binDir, { recursive: true })
    symlinkSync(join(cli, 'orgai.mjs'), shim)
    const svc = createCliShimService(deps({ loginPath: `${binDir}:/usr/bin` }))
    const status = svc.status()
    expect(status).toMatchObject({ state: 'foreign', otherCli: { path: shim, channel: 'npm', version: '0.2.0' } })
    expect(status.reason).toBe(`The orgai command from npm (0.2.0) is on your PATH at ${shim}. OrgAI leaves it alone.`)
    expect(status.reason).not.toMatch(/Remove or rename/)
    const r = await svc.install()
    expect(r.ok).toBe(false)
    expect(r.message).toBe(status.reason)
    expect(lstatSync(shim).isSymbolicLink()).toBe(true)
  })

  posixOnly('an unknown file at the shim path still reads as foreign with the remove-or-rename reason', () => {
    mkdirSync(binDir, { recursive: true })
    writeFileSync(shim, '#!/bin/sh\necho mine\n', { mode: 0o755 })
    const status = createCliShimService(deps({ loginPath: `${binDir}:/usr/bin` })).status()
    expect(status).toMatchObject({ state: 'foreign', otherCli: { path: shim } })
    expect(status.reason).toMatch(/was not written by OrgAI\. Remove or rename it/)
  })

  it('an npm or archive orgai later on PATH wins over an earlier unknown one (it is the one that blocks Install)', () => {
    const later = createCliShimService(
      deps({ findOnPath: () => [{ path: '/usr/local/bin/orgai', kind: 'unknown' }, { path: '/opt/homebrew/bin/orgai', kind: 'npm', channel: 'npm', version: '0.2.0' }] })
    ).status()
    expect(later.otherCli).toEqual({ path: '/opt/homebrew/bin/orgai', channel: 'npm', version: '0.2.0' })
    const archive = createCliShimService(
      deps({ findOnPath: () => [{ path: '/a/orgai', kind: 'dev', channel: 'dev' }, { path: '/b/orgai', kind: 'archive', channel: 'archive' }] })
    ).status()
    expect(archive.otherCli).toEqual({ path: '/b/orgai', channel: 'archive' })
    // with no npm or archive one, the first other one in PATH order
    const first = createCliShimService(deps({ findOnPath: () => [{ path: '/a/orgai', kind: 'unknown' }, { path: '/b/orgai', kind: 'dev', channel: 'dev' }] })).status()
    expect(first.otherCli).toEqual({ path: '/a/orgai' })
  })

  it('a PATH reader that throws leaves otherCli unset and logs', () => {
    const warn = vi.fn()
    const status = createCliShimService(
      deps({
        log: { info: () => {}, warn },
        findOnPath: () => {
          throw new Error('boom')
        }
      })
    ).status()
    expect(status.otherCli).toBeUndefined()
    expect(status.state).toBe('not-installed')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('boom'))
  })

  it('passes channel and version through, and leaves them out when unknown', () => {
    const status = createCliShimService(deps({ findOnPath: () => [{ path: '/x/orgai', kind: 'unknown' }] })).status()
    expect(status.otherCli).toEqual({ path: '/x/orgai' })
  })
})

describe('win32', () => {
  it('renders the .cmd shim under LOCALAPPDATA', async () => {
    // Build a Windows-shaped layout, stubbing the fs so the win32 path strings never touch this machine's disk.
    const res = 'C:\\Program Files\\OrgAI\\resources'
    const winLauncher = packagedLayout('win32', res).launcher
    const files = new Map<string, string>()
    const st = (isFile: boolean, size = 0) => ({ isFile: () => isFile, isSymbolicLink: () => false, size }) as unknown as Stats
    const enoent = (): never => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    }
    const svc = createCliShimService(
      deps({
        platform: 'win32',
        resourcesPath: res,
        home: 'C:\\Users\\A',
        userDataDir: 'C:\\Users\\A\\AppData\\Roaming\\OrgAI',
        env: { LOCALAPPDATA: 'C:\\Users\\A\\AppData\\Local', APPDATA: 'C:\\Users\\A\\AppData\\Roaming' },
        loginPath: 'C:\\Windows',
        fs: {
          statSync: (p) => (p === winLauncher ? st(true) : enoent()),
          lstatSync: (p) => (files.has(p) ? st(true, files.get(p)!.length) : enoent()),
          readFileSync: (p) => files.get(p) ?? enoent(),
          writeFileSync: (p, d) => void files.set(p, d),
          chmodSync: () => {},
          renameSync: (a, b) => {
            files.set(b, files.get(a)!)
            files.delete(a)
          },
          unlinkSync: (p) => void files.delete(p),
          mkdirSync: () => undefined,
          realpathSync: (p) => p
        }
      })
    )
    const path = 'C:\\Users\\A\\AppData\\Local\\OrgAI\\bin\\orgai.cmd'
    expect(svc.status()).toMatchObject({ state: 'not-installed', path, binDir: 'C:\\Users\\A\\AppData\\Local\\OrgAI\\bin', onPath: false })
    const r = await svc.install()
    expect(r.ok).toBe(true)
    expect(r.message).toMatch(/add it to your user Path\.$/)
    const text = files.get(path)!
    expect(text).toContain('\r\n')
    expect(text).not.toContain('ORGAI_DATA_DIR=')
    expect(parseCliShim(text, 'win32')).toEqual({ launcher: winLauncher })
    expect([...files.keys()]).toEqual([path])
    expect(svc.status().state).toBe('installed')
  })
})
