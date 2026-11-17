import { beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { trackedChildCount } from '../host/shutdown'
import {
  CODEX_NOT_INSTALLED_MESSAGE,
  CODEX_PINNED_VERSION,
  CODEX_SUPPORTED_RANGE,
  defaultCodexVersionRunner,
  checkCodexBinary,
  checkCodexRuntime,
  clearCodexVersionCache,
  codexVersion,
  codexVersionSupported,
  lookupCodexBinary,
  parseCodexVersion,
  shimTargets,
  type CodexBinary
} from './codexBinary'
import { ELF, FakeLookupFs, MACHO, PE } from './fakeLookupFs'
import type { ModuleResolver } from './executableLookup'

const noModules: ModuleResolver = () => undefined
const mac = { platform: 'darwin' as const, arch: 'arm64', bundleDir: '/b/out/cli', resolveModule: noModules }
const MAC_VENDOR = 'vendor/aarch64-apple-darwin'

const POSIX_SH_SHIM = `#!/bin/sh
basedir=$(dirname "$(echo "$0" | sed -e 's,\\\\,/,g')")
exec node  "$basedir/node_modules/@openai/codex/bin/codex.js" "$@"
`
const CMD_SHIM = `@ECHO off\r
GOTO start\r
:find_dp0\r
SET dp0=%~dp0\r
EXIT /b\r
:start\r
SETLOCAL\r
CALL :find_dp0\r
endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r
`
const PS1_SHIM = `#!/usr/bin/env pwsh
$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent
  & "node$exe"  "$basedir/node_modules/@openai/codex/bin/codex.js" $args
`

describe('lookupCodexBinary (cli-standalone 6.2)', () => {
  it('ORGAI_CODEX_PATH decides: native used, bad values refused and never passed over', () => {
    const fs = new FakeLookupFs({ '/opt/codex': MACHO, '/opt/codex-path-less': MACHO, '/usr/bin/codex': ELF }, ['/opt/dir', '/opt/codex-path'])
    expect(lookupCodexBinary({ ...mac, fs, env: { ORGAI_CODEX_PATH: '/opt/codex', PATH: '/usr/bin' } })).toEqual({ binary: { path: '/opt/codex', source: 'env', pathDir: '/opt/codex-path' } })
    expect(lookupCodexBinary({ ...mac, fs, env: { ORGAI_CODEX_PATH: '/opt/nope', PATH: '/usr/bin' } }).problem).toBe(
      'ORGAI_CODEX_PATH names /opt/nope, which does not exist; Codex is not installed there.'
    )
    expect(lookupCodexBinary({ ...mac, fs, env: { ORGAI_CODEX_PATH: '/opt/dir' } }).problem).toMatch(/not a regular file/)
    expect(lookupCodexBinary({ ...mac, fs, env: { ORGAI_CODEX_PATH: 'codex' } }).problem).toMatch(/must be an absolute path/)
  })

  it('the per-platform package through createRequire, rewritten out of app.asar, with codex-path', () => {
    const root = '/R/app.asar.unpacked/node_modules/@openai/codex-darwin-arm64'
    const fs = new FakeLookupFs({ [`${root}/${MAC_VENDOR}/bin/codex`]: MACHO }, [`${root}/${MAC_VENDOR}/codex-path`])
    const resolveModule: ModuleResolver = (spec) => (spec === '@openai/codex-darwin-arm64/package.json' ? '/R/app.asar/node_modules/@openai/codex-darwin-arm64/package.json' : undefined)
    expect(lookupCodexBinary({ ...mac, fs, env: {}, resolveModule, bundleDir: '/elsewhere' })).toEqual({
      binary: { path: `${root}/${MAC_VENDOR}/bin/codex`, pathDir: `${root}/${MAC_VENDOR}/codex-path`, source: 'package' }
    })
    // A packaged bundle finds it without createRequire.
    expect(lookupCodexBinary({ ...mac, fs, env: {}, bundleDir: '/R/app.asar.unpacked/out/cli' }).binary?.source).toBe('package')
  })

  it('PATH: a native binary (Homebrew link) is used through its real path, with an adjacent codex-path', () => {
    const real = '/opt/homebrew/Caskroom/codex/0.167.0/codex'
    const fs = new FakeLookupFs({ [real]: MACHO }, ['/opt/homebrew/Caskroom/codex/0.167.0/codex-path']).link('/opt/homebrew/bin/codex', real)
    expect(lookupCodexBinary({ ...mac, fs, env: { PATH: '/opt/homebrew/bin' } })).toEqual({
      binary: { path: real, source: 'path', pathDir: '/opt/homebrew/Caskroom/codex/0.167.0/codex-path', via: '/opt/homebrew/bin/codex' }
    })
  })

  it('PATH: an npm link to bin/codex.js maps to the nested or hoisted platform package, never the shim', () => {
    const pkg = '/usr/local/lib/node_modules/@openai/codex'
    const nested = `${pkg}/node_modules/@openai/codex-darwin-arm64/${MAC_VENDOR}`
    const fs = new FakeLookupFs({ [`${pkg}/bin/codex.js`]: '#!/usr/bin/env node\n', [`${nested}/bin/codex`]: MACHO }, [`${nested}/codex-path`]).link('/usr/local/bin/codex', `${pkg}/bin/codex.js`)
    expect(lookupCodexBinary({ ...mac, fs, env: { PATH: '/usr/local/bin' } })).toEqual({
      binary: { path: `${nested}/bin/codex`, pathDir: `${nested}/codex-path`, source: 'path', via: '/usr/local/bin/codex' }
    })
    const hoisted = `/usr/local/lib/node_modules/@openai/codex-darwin-arm64/${MAC_VENDOR}`
    const fs2 = new FakeLookupFs({ [`${pkg}/bin/codex.js`]: '#!/usr/bin/env node\n', [`${hoisted}/bin/codex`]: MACHO }).link('/usr/local/bin/codex', `${pkg}/bin/codex.js`)
    expect(lookupCodexBinary({ ...mac, fs: fs2, env: { PATH: '/usr/local/bin' } }).binary).toEqual({ path: `${hoisted}/bin/codex`, source: 'path', via: '/usr/local/bin/codex' })
  })

  it('PATH: a #! sh shim is read for its $basedir target', () => {
    const native = `/p/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex`
    const fs = new FakeLookupFs({ '/p/codex': POSIX_SH_SHIM, [native]: ELF })
    expect(lookupCodexBinary({ platform: 'linux', arch: 'x64', resolveModule: noModules, bundleDir: '/b', fs, env: { PATH: '/p' } }).binary).toEqual({
      path: native,
      source: 'path',
      via: '/p/codex'
    })
  })

  it('Windows: codex.exe, codex.cmd, codex.ps1 in that order per folder; the extensionless sh script is skipped; .cmd and .ps1 map to codex.exe', () => {
    const npm = 'C:\\Users\\me\\AppData\\Roaming\\npm'
    const exe = `${npm}\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe`
    const win = { platform: 'win32' as const, arch: 'x64', resolveModule: noModules, bundleDir: 'C:\\b' }
    for (const [name, text] of [['codex.cmd', CMD_SHIM], ['codex.ps1', PS1_SHIM]] as const) {
      const fs = new FakeLookupFs({ [`${npm}\\codex`]: POSIX_SH_SHIM, [`${npm}\\${name}`]: text, [exe]: PE })
      expect(lookupCodexBinary({ ...win, fs, env: { Path: `C:\\Windows;${npm}` } }).binary).toEqual({ path: exe, source: 'path', via: `${npm}\\${name}` })
      // The sh script was never classified.
      expect(fs.reads).not.toContain(`${npm}\\codex`)
    }
    // A native codex.exe earlier in the same folder wins over the shims.
    const fs = new FakeLookupFs({ [`${npm}\\codex.exe`]: PE, [`${npm}\\codex.cmd`]: CMD_SHIM, [exe]: PE })
    expect(lookupCodexBinary({ ...win, fs, env: { Path: npm } }).binary).toEqual({ path: `${npm}\\codex.exe`, source: 'path' })
  })

  it('a native launcher on PATH is followed to the real codex: Scoop shim.exe and Volta volta-shim (review round 1)', () => {
    const win = { platform: 'win32' as const, arch: 'x64', resolveModule: noModules, bundleDir: 'C:\\b' }
    // Scoop: shims\codex.exe is shim.exe; codex.shim names the real program.
    const shims = 'C:\\Users\\me\\scoop\\shims'
    const app = 'C:\\Users\\me\\scoop\\apps\\codex\\current\\codex.exe'
    let fs = new FakeLookupFs({ [`${shims}\\codex.exe`]: PE, [`${shims}\\codex.shim`]: `path = "${app}"\r\n`, [app]: PE })
    expect(lookupCodexBinary({ ...win, fs, env: { Path: shims } }).binary).toEqual({ path: app, source: 'path', via: `${shims}\\codex.exe` })
    // Older Scoop writes the path unquoted; a target that is itself an npm shim maps to the native package.
    const npm = 'C:\\Users\\me\\AppData\\Roaming\\npm'
    const vendorExe = `${npm}\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe`
    fs = new FakeLookupFs({ [`${shims}\\codex.exe`]: PE, [`${shims}\\codex.shim`]: `path = ${npm}\\codex.cmd\n`, [`${npm}\\codex.cmd`]: CMD_SHIM, [vendorExe]: PE })
    expect(lookupCodexBinary({ ...win, fs, env: { Path: shims } }).binary).toEqual({ path: vendorExe, source: 'path', via: `${shims}\\codex.exe` })
    // A .shim naming nothing usable leaves the hit as it was.
    fs = new FakeLookupFs({ [`${shims}\\codex.exe`]: PE, [`${shims}\\codex.shim`]: 'path = C:\\gone\\codex.exe\n' })
    expect(lookupCodexBinary({ ...win, fs, env: { Path: shims } }).binary).toEqual({ path: `${shims}\\codex.exe`, source: 'path' })

    // Volta on Windows: bin\codex.exe is volta-shim; the package image holds the real binary.
    const volta = 'C:\\Users\\me\\AppData\\Local\\Volta'
    const image = `${volta}\\tools\\image\\packages\\@openai\\codex`
    const voltaExe = `${image}\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe`
    fs = new FakeLookupFs({ [`${volta}\\bin\\codex.exe`]: PE, [voltaExe]: PE }, [image])
    expect(lookupCodexBinary({ ...win, fs, env: { Path: `${volta}\\bin` } }).binary).toEqual({ path: voltaExe, source: 'path', via: `${volta}\\bin\\codex.exe` })
    // Volta on macOS: ~/.volta/bin/codex links to volta-shim; lib/node_modules layout, hoisted platform package.
    const home = '/Users/me/.volta'
    const macImage = `${home}/tools/image/packages/@openai/codex`
    const macExe = `${macImage}/lib/node_modules/@openai/codex-darwin-arm64/${MAC_VENDOR}/bin/codex`
    fs = new FakeLookupFs({ [`${home}/bin/volta-shim`]: MACHO, [macExe]: MACHO }, [macImage]).link(`${home}/bin/codex`, `${home}/bin/volta-shim`)
    expect(lookupCodexBinary({ ...mac, fs, env: { PATH: `${home}/bin` } }).binary).toEqual({ path: macExe, source: 'path', via: `${home}/bin/codex` })
    // ORGAI_CODEX_PATH naming the launcher is the user's choice: used as is.
    expect(lookupCodexBinary({ ...mac, fs, env: { ORGAI_CODEX_PATH: `${home}/bin/codex` } }).binary).toEqual({ path: `${home}/bin/volta-shim`, source: 'env', via: `${home}/bin/codex` })
    // An ordinary native codex in a bin folder without a Volta image is used as is.
    fs = new FakeLookupFs({ '/usr/local/bin/codex': MACHO })
    expect(lookupCodexBinary({ ...mac, fs, env: { PATH: '/usr/local/bin' } }).binary).toEqual({ path: '/usr/local/bin/codex', source: 'path' })
  })

  it('never the cwd; an unmappable shim is named in the problem; nothing found says how to install', () => {
    const fs = new FakeLookupFs({ codex: MACHO, '/s/codex': '#!/bin/sh\nexec something-else "$@"\n', '/t/codex': 'plain text' })
    const r = lookupCodexBinary({ ...mac, fs, env: { PATH: ':.:rel:/s:/t' } })
    expect(r.binary).toBeUndefined()
    expect(r.problem).toBe(
      `${CODEX_NOT_INSTALLED_MESSAGE} (/s/codex is an npm shim whose native package (@openai/codex-darwin-arm64) was not found; reinstall @openai/codex@0.167.0; /t/codex is neither a native Codex executable nor an npm shim)`
    )
    expect(lookupCodexBinary({ ...mac, fs: new FakeLookupFs(), env: {} })).toEqual({ problem: CODEX_NOT_INSTALLED_MESSAGE })
  })

  it('ORGAI_CODEX_PATH naming a POSIX wrapper script is used as is; a Windows .cmd / .ps1 there stays refused (review round 2)', () => {
    const wrapper = '#!/bin/sh\nexport FOO=1\nexec /opt/real/codex "$@"\n'
    const fs = new FakeLookupFs({ '/home/u/bin/codex-wrapper': wrapper })
    expect(lookupCodexBinary({ ...mac, fs, env: { ORGAI_CODEX_PATH: '/home/u/bin/codex-wrapper' } })).toEqual({ binary: { path: '/home/u/bin/codex-wrapper', source: 'env' } })
    expect(lookupCodexBinary({ platform: 'linux', arch: 'x64', resolveModule: noModules, bundleDir: '/b', fs, env: { ORGAI_CODEX_PATH: '/home/u/bin/codex-wrapper' } }).binary?.source).toBe('env')
    // An npm sh shim whose package is gone is also the user's choice on POSIX.
    const fs2 = new FakeLookupFs({ '/p/codex': POSIX_SH_SHIM })
    expect(lookupCodexBinary({ ...mac, fs: fs2, env: { ORGAI_CODEX_PATH: '/p/codex' } }).binary).toEqual({ path: '/p/codex', source: 'env' })
    // Plain text is still refused.
    const fs3 = new FakeLookupFs({ '/p/codex': 'plain text' })
    expect(lookupCodexBinary({ ...mac, fs: fs3, env: { ORGAI_CODEX_PATH: '/p/codex' } }).problem).toMatch(/neither a native Codex executable nor an npm shim/)
    // Windows cannot spawn a .cmd / .ps1 without a shell.
    const win = { platform: 'win32' as const, arch: 'x64', resolveModule: noModules, bundleDir: 'C:\\b' }
    for (const [name, text] of [['codex.cmd', CMD_SHIM], ['codex.ps1', PS1_SHIM]] as const) {
      const shim = `C:\\npm\\${name}`
      const r = lookupCodexBinary({ ...win, fs: new FakeLookupFs({ [shim]: text }), env: { ORGAI_CODEX_PATH: shim } })
      expect(r.binary).toBeUndefined()
      expect(r.problem).toMatch(/^ORGAI_CODEX_PATH: .* is an npm shim whose native package/)
    }
  })

  it('shimTargets finds the prefix each shim style uses', () => {
    expect(shimTargets(POSIX_SH_SHIM)).toEqual(['$basedir/node_modules/@openai/codex/bin/codex.js'])
    expect(shimTargets(CMD_SHIM)).toEqual(['%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js'])
    expect(shimTargets(PS1_SHIM)).toEqual(['$basedir/node_modules/@openai/codex/bin/codex.js'])
    expect(shimTargets('exec node "/usr/lib/node_modules/@openai/codex/bin/codex.js" "$@"')).toEqual(['/usr/lib/node_modules/@openai/codex/bin/codex.js'])
    expect(shimTargets('"C:\\nodejs\\node_modules\\@openai\\codex\\bin\\codex.js"')).toEqual(['C:\\nodejs\\node_modules\\@openai\\codex\\bin\\codex.js'])
    expect(shimTargets('node @openai/codex/bin/codex.js')).toEqual([])
    expect(shimTargets('nothing')).toEqual([])
  })

  it('a large single-line #! script on PATH is read in linear time (review round 2: the old lazy regex took ~680 ms)', () => {
    const big = `#!/usr/bin/env node\n${'/a'.repeat(8_000)}`
    const fs = new FakeLookupFs({ '/s/codex': big })
    const started = performance.now()
    for (let i = 0; i < 5; i++) shimTargets(big)
    const r = lookupCodexBinary({ ...mac, fs, env: { PATH: '/s' } })
    const took = performance.now() - started
    expect(r.binary).toBeUndefined()
    expect(took).toBeLessThan(100)
  })

  it('a later PATH folder is used when an earlier hit cannot be mapped', () => {
    const fs = new FakeLookupFs({ '/s/codex': '#!/bin/sh\n', '/n/codex': MACHO })
    expect(lookupCodexBinary({ ...mac, fs, env: { PATH: '/s:/n' } }).binary).toEqual({ path: '/n/codex', source: 'path' })
  })

  it('this checkout finds the real bundled package (default resolver and file system, no PATH)', () => {
    const r = lookupCodexBinary({ env: {} })
    if (r.binary) expect(r.binary.source).toBe('package')
    else expect(r.problem).toBe(CODEX_NOT_INSTALLED_MESSAGE)
  })
})

describe('Codex version (cli-standalone 6.2)', () => {
  beforeEach(() => clearCodexVersionCache())

  it('the pin matches package.json and is inside the supported range (review round 2)', () => {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../../package.json'), 'utf8')) as { dependencies: Record<string, string> }
    expect(pkg.dependencies['@openai/codex']).toBe(CODEX_PINNED_VERSION)
    expect(codexVersionSupported(CODEX_PINNED_VERSION)).toBe(true)
    expect(CODEX_SUPPORTED_RANGE).toBe(CODEX_PINNED_VERSION.replace(/\.\d+$/, '.x'))
  })

  it('a failed --version spawn leaves nothing in the shutdown registry (review round 2)', async () => {
    const before = trackedChildCount('codex --version')
    const missing = resolve(tmpdir(), 'orgai-definitely-not-codex', 'codex')
    await expect(defaultCodexVersionRunner({ path: missing })).rejects.toThrow(/ENOENT/)
    await new Promise((r) => setTimeout(r, 20))
    expect(trackedChildCount('codex --version')).toBe(before)
  })

  it('parses and ranges versions', () => {
    expect(parseCodexVersion('codex-cli 0.167.0\n')).toBe('0.167.0')
    expect(parseCodexVersion('codex 0.167.1-alpha.2')).toBe('0.167.1-alpha.2')
    expect(parseCodexVersion('nothing here')).toBeUndefined()
    expect(codexVersionSupported('0.167.0')).toBe(true)
    expect(codexVersionSupported('0.167.12')).toBe(true)
    // The previous pin is refused too: the range moves with the pin, it does not widen.
    expect(codexVersionSupported('0.166.0')).toBe(false)
    expect(codexVersionSupported('0.168.0')).toBe(false)
    expect(codexVersionSupported('1.166.0')).toBe(false)
  })

  it('caches by realpath + mtime + size; a changed binary is asked again; failures are not cached', async () => {
    const fs = new FakeLookupFs({ '/c/codex': { head: MACHO, mtimeMs: 5, size: 100 } }).link('/l/codex', '/c/codex')
    let calls = 0
    let answer = 'codex-cli 0.167.0'
    const run = async (): Promise<string> => {
      calls++
      return answer
    }
    expect(await codexVersion({ path: '/l/codex' }, { fs, run })).toBe('0.167.0')
    expect(await codexVersion({ path: '/c/codex' }, { fs, run })).toBe('0.167.0')
    expect(calls).toBe(1)
    fs.file('/c/codex', { head: MACHO, mtimeMs: 6, size: 100 })
    answer = 'codex-cli 0.167.1'
    expect(await codexVersion({ path: '/c/codex' }, { fs, run })).toBe('0.167.1')
    expect(calls).toBe(2)
    fs.file('/c/codex', { head: MACHO, mtimeMs: 7, size: 100 })
    answer = 'garbage'
    await expect(codexVersion({ path: '/c/codex' }, { fs, run })).rejects.toThrow(/printed no version/)
    await expect(codexVersion({ path: '/c/codex' }, { fs, run })).rejects.toThrow(/printed no version/)
    expect(calls).toBe(4)
  })

  it('refuses an unsupported or unreadable version from the package or PATH, warns for ORGAI_CODEX_PATH, skips a hand-made binary', async () => {
    const fs = new FakeLookupFs({ '/c/codex': MACHO })
    const v = (out: string) => async () => out
    const fail = async (): Promise<string> => {
      throw new Error('spawn EACCES')
    }
    const bin = (source?: CodexBinary['source']): CodexBinary => ({ path: '/c/codex', ...(source ? { source } : {}) })
    expect(await checkCodexBinary(bin('path'), { fs, run: v('codex-cli 0.167.0') })).toEqual({ ok: true, binary: bin('path'), version: '0.167.0' })
    clearCodexVersionCache()
    expect(await checkCodexBinary(bin('package'), { fs, run: v('codex-cli 0.170.2') })).toEqual({
      ok: false,
      binary: bin('package'),
      version: '0.170.2',
      reason: 'Codex 0.170.2 is not supported; install @openai/codex@0.167.0'
    })
    clearCodexVersionCache()
    const env = await checkCodexBinary(bin('env'), { fs, run: v('codex-cli 0.170.2') })
    expect(env).toMatchObject({ ok: true, version: '0.170.2' })
    expect(env.ok && env.warning).toMatch(/^Codex 0\.170\.2 at \/c\/codex \(ORGAI_CODEX_PATH\) is not a tested version/)
    clearCodexVersionCache()
    expect(await checkCodexBinary(bin('path'), { fs, run: fail })).toMatchObject({ ok: false, reason: /could not be read \(spawn EACCES\)/ })
    expect(await checkCodexBinary(bin('env'), { fs, run: fail })).toMatchObject({ ok: true, warning: /could not be read/ })
    let ran = false
    expect(await checkCodexBinary(bin(), { fs, run: async () => ((ran = true), '') })).toEqual({ ok: true, binary: bin() })
    expect(ran).toBe(false)
  })

  it('checkCodexRuntime: lookup problems pass through without running anything', async () => {
    let ran = false
    const r = await checkCodexRuntime({ ...mac, fs: new FakeLookupFs(), env: {}, run: async () => ((ran = true), '') })
    expect(r).toEqual({ ok: false, reason: CODEX_NOT_INSTALLED_MESSAGE })
    expect(ran).toBe(false)
    const fs = new FakeLookupFs({ '/n/codex': ELF })
    expect(await checkCodexRuntime({ ...mac, fs, env: { PATH: '/n' }, run: async () => 'codex-cli 0.167.0' })).toEqual({
      ok: true,
      binary: { path: '/n/codex', source: 'path' },
      version: '0.167.0'
    })
  })
})
