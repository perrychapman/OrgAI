import { describe, expect, it } from 'vitest'
import {
  CLAUDE_PATH_ENV,
  claudeExecutable,
  claudeNativePackages,
  claudePathCandidateSentence,
  claudeResolutionMessage,
  claudeRuntimeMissingMessage,
  claudeWellKnownPaths,
  detectMusl,
  requireClaudeExecutable,
  resetMuslCache
} from './claudeBinary'
import { FakeLookupFs, MACHO, PE } from './fakeLookupFs'
import type { ModuleResolver } from './executableLookup'

const RES = '/Applications/OrgAI.app/Contents/Resources'
const APP_BIN = `${RES}/app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`

/** A resolver that answers from a fixed table: spec -> resolved path. */
const resolver = (table: Record<string, string>, calls: [string, string][] = []): ModuleResolver => (spec, from) => {
  calls.push([spec, from])
  return table[spec]
}

describe('claudeExecutable (cli-standalone 6.1)', () => {
  const base = { platform: 'darwin' as const, arch: 'arm64', home: '/Users/me' }

  it('refuses an ORGAI_CLAUDE_PATH that names a .cmd / .bat / .ps1 shim: the SDK spawns without a shell (review round 1)', () => {
    for (const shim of ['C:\\npm\\claude.cmd', 'C:\\npm\\claude.BAT', 'C:\\npm\\claude.ps1']) {
      const fs = new FakeLookupFs({ [shim]: new Uint8Array([0x40, 0x65]) })
      const r = claudeExecutable({ [CLAUDE_PATH_ENV]: shim }, { platform: 'win32', arch: 'x64', fs, resolveModule: resolver({}) })
      expect(r).toEqual({ ok: false, reason: `ORGAI_CLAUDE_PATH names ${shim}, a script shim OrgAI cannot run; name the claude executable itself (claude.exe on Windows).` })
    }
    // A native claude.exe chosen the same way is fine.
    const exe = 'C:\\tools\\claude.exe'
    const fs = new FakeLookupFs({ [exe]: PE })
    expect(claudeExecutable({ [CLAUDE_PATH_ENV]: exe }, { platform: 'win32', arch: 'x64', fs, resolveModule: resolver({}) })).toEqual({ ok: true, path: exe, source: 'env' })
  })

  it('reads the process report for musl at most once per process (review round 1)', () => {
    resetMuslCache()
    let reads = 0
    const report = { getReport: () => (reads++, { header: {} }) }
    expect(detectMusl('linux', report, 'linux')).toBe(true)
    expect(detectMusl('linux', report, 'linux')).toBe(true)
    expect(reads).toBe(1)
    // Other platforms never read it.
    expect(detectMusl('darwin', report, 'darwin')).toBe(false)
    expect(reads).toBe(1)
    resetMuslCache()
    expect(detectMusl('linux', { getReport: () => ({ header: { glibcVersionRuntime: '2.39' } }) }, 'linux')).toBe(false)
    resetMuslCache()
  })

  it('ORGAI_CLAUDE_PATH wins when it is an absolute regular file, and is never passed over when it is not', () => {
    const fs = new FakeLookupFs({ '/opt/claude': MACHO, [APP_BIN]: MACHO }, ['/opt/dir'])
    const opts = { ...base, fs, bundleDir: `${RES}/app.asar/out/main`, resolveModule: resolver({}) }
    expect(claudeExecutable({ [CLAUDE_PATH_ENV]: ' /opt/claude ' }, opts)).toEqual({ ok: true, path: '/opt/claude', source: 'env' })
    expect(claudeExecutable({ [CLAUDE_PATH_ENV]: '/opt/missing' }, opts)).toEqual({ ok: false, reason: 'ORGAI_CLAUDE_PATH names /opt/missing, which does not exist.' })
    expect(claudeExecutable({ [CLAUDE_PATH_ENV]: '/opt/dir' }, opts)).toEqual({ ok: false, reason: 'ORGAI_CLAUDE_PATH names /opt/dir, which is not a regular file.' })
    expect(claudeExecutable({ [CLAUDE_PATH_ENV]: 'claude' }, opts)).toEqual({ ok: false, reason: 'ORGAI_CLAUDE_PATH must be an absolute path (it is claude).' })
    // Blank counts as unset.
    expect(claudeExecutable({ [CLAUDE_PATH_ENV]: '  ' }, opts)).toEqual({ ok: true, path: APP_BIN, source: 'app' })
  })

  it('a packaged app uses the unpacked native package beside app.asar (main bundle and CLI bundle)', () => {
    const fs = new FakeLookupFs({ [APP_BIN]: MACHO })
    for (const bundleDir of [`${RES}/app.asar/out/main`, `${RES}/app.asar.unpacked/out/cli`]) {
      expect(claudeExecutable({}, { ...base, fs, bundleDir, resolveModule: resolver({}) })).toEqual({ ok: true, path: APP_BIN, source: 'app' })
    }
  })

  it('a createRequire hit inside app.asar is rewritten to app.asar.unpacked', () => {
    const fs = new FakeLookupFs({ [APP_BIN]: MACHO })
    const table = { '@anthropic-ai/claude-agent-sdk-darwin-arm64/package.json': `${RES}/app.asar/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/package.json` }
    // A bundle folder outside the archive (so the direct check does not answer first).
    expect(claudeExecutable({}, { ...base, fs, bundleDir: '/elsewhere/out/cli', resolveModule: resolver(table) })).toEqual({ ok: true, path: APP_BIN, source: 'app' })
  })

  it('the SDK package resolved from the bundle (dev checkout, npm install)', () => {
    const bin = '/usr/lib/node_modules/orgai/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude'
    const fs = new FakeLookupFs({ [bin]: MACHO })
    const calls: [string, string][] = []
    const table = { '@anthropic-ai/claude-agent-sdk-darwin-arm64/package.json': bin.replace(/claude$/, 'package.json') }
    const r = claudeExecutable({}, { ...base, fs, bundleDir: '/usr/lib/node_modules/orgai/out/cli', resolveModule: resolver(table, calls) })
    expect(r).toEqual({ ok: true, path: bin, source: 'sdk' })
    expect(calls).toEqual([['@anthropic-ai/claude-agent-sdk-darwin-arm64/package.json', '/usr/lib/node_modules/orgai/out/cli']])
  })

  it('a native package npm nested under the SDK (version conflict) is found from the SDK folder (review round 2)', () => {
    const sdkDir = '/usr/lib/node_modules/orgai/node_modules/@anthropic-ai/claude-agent-sdk'
    const bin = `${sdkDir}/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`
    const fs = new FakeLookupFs({ [bin]: MACHO })
    const bundleDir = '/usr/lib/node_modules/orgai/out/cli'
    const calls: [string, string][] = []
    const nested: ModuleResolver = (spec, from) => {
      calls.push([spec, from])
      if (spec === '@anthropic-ai/claude-agent-sdk' && from === bundleDir) return `${sdkDir}/sdk.mjs`
      if (spec === '@anthropic-ai/claude-agent-sdk-darwin-arm64/package.json' && from === sdkDir) return bin.replace(/claude$/, 'package.json')
      return undefined
    }
    expect(claudeExecutable({ PATH: '' }, { ...base, fs, bundleDir, resolveModule: nested })).toEqual({ ok: true, path: bin, source: 'sdk' })
    expect(calls).toEqual([
      ['@anthropic-ai/claude-agent-sdk-darwin-arm64/package.json', bundleDir],
      ['@anthropic-ai/claude-agent-sdk', bundleDir],
      ['@anthropic-ai/claude-agent-sdk-darwin-arm64/package.json', sdkDir]
    ])
  })

  it('refuses an ORGAI_CLAUDE_PATH that names a .js / .mjs / .cjs file: the probe could not run it the way the SDK does (review round 2)', () => {
    for (const js of ['/opt/claude-code/cli.js', '/opt/claude-code/cli.mjs', '/opt/claude-code/cli.CJS']) {
      const fs = new FakeLookupFs({ [js]: '#!/usr/bin/env node\n' })
      expect(claudeExecutable({ [CLAUDE_PATH_ENV]: js }, { ...base, fs, resolveModule: resolver({}) })).toEqual({
        ok: false,
        reason: `ORGAI_CLAUDE_PATH names ${js}, a JavaScript file; name the native claude executable itself.`
      })
    }
  })

  it('a .cmd / .ps1 claude on PATH is named with advice that works: point ORGAI_CLAUDE_PATH at the executable (review round 2)', () => {
    expect(claudePathCandidateSentence('C:\\npm\\claude.cmd')).toBe(
      'A claude on PATH at C:\\npm\\claude.cmd is a script shim OrgAI cannot run; set ORGAI_CLAUDE_PATH to the claude executable it starts (claude.exe).'
    )
    expect(claudePathCandidateSentence('C:\\npm\\claude.ps1')).toMatch(/script shim OrgAI cannot run/)
    expect(claudePathCandidateSentence('C:\\tools\\claude.exe')).toBe('A claude on PATH at C:\\tools\\claude.exe is not used; set ORGAI_CLAUDE_PATH to use it.')
  })

  it('a resolved package without its binary does not count', () => {
    const fs = new FakeLookupFs({})
    const table = { '@anthropic-ai/claude-agent-sdk-darwin-arm64/package.json': '/x/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/package.json' }
    const r = claudeExecutable({ PATH: '' }, { ...base, fs, bundleDir: '/x/out/cli', resolveModule: resolver(table) })
    expect(r).toEqual({ ok: false, reason: claudeRuntimeMissingMessage('darwin', 'arm64') })
  })

  it('none: the missing-runtime sentence, naming (never using) a claude on PATH or in a well-known folder', () => {
    const fs = new FakeLookupFs({ '/usr/local/bin/claude': MACHO, '/Users/me/.local/bin/claude': MACHO })
    const opts = { ...base, fs, bundleDir: '/x/out/cli', resolveModule: resolver({}) }
    const onPath = claudeExecutable({ PATH: '/nope:relative:/usr/local/bin' }, opts)
    expect(onPath).toEqual({ ok: false, reason: claudeRuntimeMissingMessage('darwin', 'arm64'), pathCandidate: '/usr/local/bin/claude' })
    if (onPath.ok) throw new Error('unreachable')
    expect(claudeResolutionMessage(onPath)).toBe(
      'The Claude runtime for darwin-arm64 is not installed; reinstall orgai without --omit=optional, or set ORGAI_CLAUDE_PATH. A claude on PATH at /usr/local/bin/claude is not used; set ORGAI_CLAUDE_PATH to use it.'
    )
    expect(claudeExecutable({ PATH: '' }, opts)).toMatchObject({ ok: false, pathCandidate: '/Users/me/.local/bin/claude' })
    expect(() => requireClaudeExecutable({ PATH: '' }, opts)).toThrow(/darwin-arm64 is not installed.*\.local\/bin\/claude is not used/)
  })

  it('never searches the cwd: relative and empty PATH entries are skipped', () => {
    const fs = new FakeLookupFs({ 'claude': MACHO, './claude': MACHO, 'bin/claude': MACHO })
    const r = claudeExecutable({ PATH: ':.:bin' }, { ...base, fs, bundleDir: '/x', resolveModule: resolver({}) })
    expect(r).toEqual({ ok: false, reason: claudeRuntimeMissingMessage('darwin', 'arm64') })
  })

  it('Windows: claude.exe in the package, and a PATH shim is only named', () => {
    const exe = 'C:\\P\\OrgAI\\resources\\app.asar.unpacked\\node_modules\\@anthropic-ai\\claude-agent-sdk-win32-x64\\claude.exe'
    const fs = new FakeLookupFs({ [exe]: MACHO, 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd': '@ECHO off' })
    const win = { platform: 'win32' as const, arch: 'x64', fs, resolveModule: resolver({}), home: 'C:\\Users\\me' }
    expect(claudeExecutable({}, { ...win, bundleDir: 'C:\\P\\OrgAI\\resources\\app.asar\\out\\main' })).toEqual({ ok: true, path: exe, source: 'app' })
    const none = claudeExecutable({ Path: '"C:\\Users\\me\\AppData\\Roaming\\npm";\\\\server\\share' }, { ...win, bundleDir: 'C:\\dev\\out\\cli' })
    expect(none).toEqual({ ok: false, reason: claudeRuntimeMissingMessage('win32', 'x64'), pathCandidate: 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd' })
  })

  it('Linux tries glibc then musl (musl first without glibc), as the SDK does', () => {
    expect(claudeNativePackages('linux', 'x64')).toEqual(['@anthropic-ai/claude-agent-sdk-linux-x64', '@anthropic-ai/claude-agent-sdk-linux-x64-musl'])
    expect(claudeNativePackages('linux', 'arm64', true)).toEqual(['@anthropic-ai/claude-agent-sdk-linux-arm64-musl', '@anthropic-ai/claude-agent-sdk-linux-arm64'])
    const musl = '/n/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64-musl/claude'
    const fs = new FakeLookupFs({ [musl]: MACHO })
    const table = { '@anthropic-ai/claude-agent-sdk-linux-x64-musl/package.json': musl.replace(/claude$/, 'package.json') }
    expect(claudeExecutable({}, { platform: 'linux', arch: 'x64', preferMusl: false, fs, bundleDir: '/n/out/cli', resolveModule: resolver(table) })).toEqual({
      ok: true,
      path: musl,
      source: 'sdk'
    })
  })

  it('well-known folders are POSIX only', () => {
    expect(claudeWellKnownPaths('win32', 'C:\\Users\\me')).toEqual([])
    expect(claudeWellKnownPaths('darwin', '/Users/me')).toEqual(['/Users/me/.claude/local/claude', '/Users/me/.local/bin/claude', '/opt/homebrew/bin/claude', '/usr/local/bin/claude'])
  })

  it('evaluates per call: a later ORGAI_CLAUDE_PATH is seen at once', () => {
    const fs = new FakeLookupFs({ '/a/claude': MACHO, '/b/claude': MACHO })
    const opts = { ...base, fs, bundleDir: '/x', resolveModule: resolver({}) }
    const env: NodeJS.ProcessEnv = { [CLAUDE_PATH_ENV]: '/a/claude' }
    expect(requireClaudeExecutable(env, opts)).toBe('/a/claude')
    env[CLAUDE_PATH_ENV] = '/b/claude'
    expect(requireClaudeExecutable(env, opts)).toBe('/b/claude')
  })

  it('this checkout resolves the real SDK package (the default resolver and file system)', () => {
    const r = claudeExecutable({})
    // The optional native package is installed for the developer's platform; elsewhere the sentence names it.
    if (r.ok) expect(r.source).toBe('sdk')
    else expect(r.reason).toBe(claudeRuntimeMissingMessage(process.platform, process.arch))
  })
})
