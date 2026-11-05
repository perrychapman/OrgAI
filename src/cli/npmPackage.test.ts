// The npm package of the orgai command (cli-standalone.md 3.1): scripts/lib/npmPackage.mjs builds its package.json
// and shrinkwrap from the repo's lockfile. These tests keep its dependency list in step with what the CLI bundle
// imports (packaging.ts) and the SDK's declared peers, so a new external import or a new peer cannot ship unresolved.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  NPM_RUNTIME_PACKAGES,
  NODE_ENGINES,
  claudeNativePackage,
  cliDependencyNames,
  compareInstalledTree,
  compareTopLevel,
  dependencyClosure,
  entryMatchesPlatform,
  globalLayout,
  installInfoFor,
  isPrerelease,
  listAdmits,
  npmPackageJson,
  pinnedVersions,
  readmeText,
  resolveLocation,
  shrinkwrapFor,
  tarballName,
  unlistedInstallScripts,
  type Lockfile
} from '../../scripts/lib/npmPackage.mjs'
import { readInstallInfo } from './installInfo'
import { CLI_RUNTIME_PACKAGES } from './packaging'

const ROOT = join(__dirname, '..', '..')
const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')) as Lockfile
const sdkPkg = JSON.parse(readFileSync(join(ROOT, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'), 'utf8')) as {
  version: string
  peerDependencies?: Record<string, string>
}
const repoPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }

describe('the published dependency list', () => {
  it('is CLI_RUNTIME_PACKAGES minus @openai/codex plus the SDK peers', () => {
    expect(NPM_RUNTIME_PACKAGES).toEqual(CLI_RUNTIME_PACKAGES.filter((p) => p !== '@openai/codex'))
    const peers = Object.keys(sdkPkg.peerDependencies ?? {})
    expect(peers.length).toBeGreaterThan(0)
    const expected = [...new Set([...CLI_RUNTIME_PACKAGES.filter((p) => p !== '@openai/codex'), ...peers])].sort()
    expect(cliDependencyNames(sdkPkg)).toEqual(expected)
  })

  it('pins every dependency exactly to the lockfile and satisfies the SDK', () => {
    const deps = pinnedVersions(lock, cliDependencyNames(sdkPkg))
    for (const [name, version] of Object.entries(deps)) {
      expect(version).toMatch(/^\d+\.\d+\.\d+/)
      expect(lock.packages[`node_modules/${name}`].version).toBe(version)
    }
    expect(deps['@anthropic-ai/claude-agent-sdk']).toBe(sdkPkg.version)
    const pkg = npmPackageJson({ version: repoPkg.version, dependencies: deps })
    expect(pkg).toMatchObject({ name: 'orgai', version: repoPkg.version, type: 'module', bin: { orgai: 'out/cli/orgai.mjs' }, engines: { node: NODE_ENGINES } })
    expect(pkg).not.toHaveProperty('scripts')
    expect(pkg.files).toContain('npm-shrinkwrap.json')
  })

  it('shrinkwraps the closure only: every platform runtime optional, no repo-only package, each entry pinned', () => {
    const deps = pinnedVersions(lock, cliDependencyNames(sdkPkg))
    const sw = shrinkwrapFor(lock, npmPackageJson({ version: repoPkg.version, dependencies: deps }))
    const locs = Object.keys(sw.packages)
    expect(sw.packages['']).toMatchObject({ name: 'orgai', dependencies: deps })
    for (const name of Object.keys(deps)) expect(locs).toContain(`node_modules/${name}`)
    for (const repoOnly of ['electron', 'react', 'vitest', '@openai/codex', 'electron-builder']) expect(locs).not.toContain(`node_modules/${repoOnly}`)
    for (const plat of ['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64']) {
      expect(sw.packages[`node_modules/@anthropic-ai/claude-agent-sdk-${plat}`]).toMatchObject({ optional: true })
    }
    for (const [loc, e] of Object.entries(sw.packages)) {
      if (loc === '') continue
      expect(e.version, loc).toBeTruthy()
      expect(e.resolved, loc).toMatch(/^https:\/\/registry\.npmjs\.org\//)
      expect(e.integrity, loc).toMatch(/^sha512-/)
      for (const flag of ['dev', 'devOptional', 'peer']) expect(e, loc).not.toHaveProperty(flag)
    }
  })
})

describe('dependencyClosure', () => {
  const synthetic: Lockfile = {
    packages: {
      '': {},
      'node_modules/a': { version: '1.0.0', dependencies: { b: '^1', c: '^1' }, optionalDependencies: { 'a-native': '1.0.0', gone: '1' } },
      'node_modules/a-native': { version: '1.0.0', os: ['darwin'], dependencies: { d: '1' } },
      'node_modules/a/node_modules/b': { version: '1.5.0' },
      'node_modules/b': { version: '2.0.0' },
      'node_modules/c': { version: '1.0.0', dependencies: { b: '^2' }, peerDependencies: { z: '*', opt: '*' }, peerDependenciesMeta: { opt: { optional: true } } },
      'node_modules/d': { version: '1.0.0' },
      'node_modules/z': { version: '3.0.0' },
      'node_modules/opt': { version: '1.0.0' },
      'node_modules/unrelated': { version: '1.0.0' }
    }
  }

  it('resolves like require(): nearest node_modules walking up', () => {
    expect(resolveLocation(synthetic.packages, 'node_modules/a', 'b')).toBe('node_modules/a/node_modules/b')
    expect(resolveLocation(synthetic.packages, 'node_modules/c', 'b')).toBe('node_modules/b')
    expect(resolveLocation(synthetic.packages, 'node_modules/a/node_modules/b', 'c')).toBe('node_modules/c')
    expect(resolveLocation(synthetic.packages, 'node_modules/a', 'missing')).toBeUndefined()
  })

  it('marks optional-only packages, keeps required peers, skips optional peers and missing optionals', () => {
    const c = dependencyClosure(synthetic, ['a'])
    expect([...c.entries()]).toEqual([
      ['node_modules/a', { optional: false }],
      ['node_modules/a-native', { optional: true }],
      ['node_modules/a/node_modules/b', { optional: false }],
      ['node_modules/b', { optional: false }],
      ['node_modules/c', { optional: false }],
      ['node_modules/d', { optional: true }],
      ['node_modules/z', { optional: false }]
    ])
  })

  it('throws for a required dependency the lockfile lacks', () => {
    const broken: Lockfile = { packages: { 'node_modules/a': { version: '1.0.0', dependencies: { nope: '1' } } } }
    expect(() => dependencyClosure(broken, ['a'])).toThrow(/nope \(needed by a\) is not in package-lock\.json/)
    expect(() => pinnedVersions(broken, ['missing'])).toThrow(/missing is not in package-lock\.json/)
  })
})

describe('installed tree checks', () => {
  const sw: Lockfile = {
    packages: {
      '': {},
      'node_modules/a': { version: '1.0.0' },
      'node_modules/a-darwin-arm64': { version: '1.0.0', os: ['darwin'], cpu: ['arm64'], optional: true },
      'node_modules/a-linux-x64': { version: '1.0.0', os: ['linux'], cpu: ['x64'], optional: true },
      'node_modules/a-linux-x64-musl': { version: '1.0.0', os: ['linux'], cpu: ['x64'], optional: true },
      'node_modules/notwin': { version: '1.0.0', os: ['!win32'] }
    }
  }

  it('applies os and cpu lists as npm does', () => {
    expect(listAdmits(undefined, 'x')).toBe(true)
    expect(listAdmits(['darwin'], 'linux')).toBe(false)
    expect(listAdmits(['!win32'], 'linux')).toBe(true)
    expect(listAdmits(['!win32'], 'win32')).toBe(false)
    expect(entryMatchesPlatform({ os: ['darwin'], cpu: ['arm64'] }, 'darwin', 'arm64')).toBe(true)
    expect(entryMatchesPlatform({ os: ['darwin'], cpu: ['arm64'] }, 'darwin', 'x64')).toBe(false)
  })

  it('accepts exactly this platform\'s entries, and on Linux either libc build', () => {
    const mac = new Map([
      ['node_modules/a', '1.0.0'],
      ['node_modules/a-darwin-arm64', '1.0.0'],
      ['node_modules/notwin', '1.0.0']
    ])
    expect(compareInstalledTree(sw, mac, 'darwin', 'arm64')).toMatchObject({ ok: true, missing: [], extra: [] })
    const linux = new Map([
      ['node_modules/a', '1.0.0'],
      ['node_modules/a-linux-x64', '1.0.0'],
      ['node_modules/notwin', '1.0.0']
    ])
    expect(compareInstalledTree(sw, linux, 'linux', 'x64').ok).toBe(true)
    const bad = new Map([
      ['node_modules/a', '1.0.1'],
      ['node_modules/a-linux-x64', '1.0.0'],
      ['node_modules/extra', '9.9.9']
    ])
    const r = compareInstalledTree(sw, bad, 'darwin', 'arm64')
    expect(r.ok).toBe(false)
    expect(r.missing).toEqual(['node_modules/a-darwin-arm64', 'node_modules/notwin'])
    expect(r.extra).toEqual(['node_modules/extra'])
    expect(r.otherPlatforms).toEqual(['node_modules/a-linux-x64'])
    expect(r.wrongVersion).toEqual([{ location: 'node_modules/a', expected: '1.0.0', installed: '1.0.1' }])
  })

  it('without a shrinkwrap compares the direct dependencies and refuses other platforms\' runtimes', () => {
    const deps = { '@anthropic-ai/claude-agent-sdk': '0.3.1', zod: '4.1.0' }
    const ok = new Map([
      ['node_modules/@anthropic-ai/claude-agent-sdk', '0.3.1'],
      ['node_modules/@anthropic-ai/claude-agent-sdk-linux-x64', '0.3.1'],
      ['node_modules/@anthropic-ai/claude-agent-sdk-linux-x64-musl', '0.3.1'],
      ['node_modules/zod', '4.1.0'],
      ['node_modules/transitive', '9.0.0']
    ])
    expect(compareTopLevel(deps, ok, 'linux', 'x64')).toEqual({ ok: true, problems: [] })
    const bad = new Map([
      ['node_modules/@anthropic-ai/claude-agent-sdk', '0.3.2'],
      ['node_modules/@anthropic-ai/claude-agent-sdk-darwin-x64', '0.3.1']
    ])
    expect(compareTopLevel(deps, bad, 'darwin', 'arm64').problems).toEqual([
      '@anthropic-ai/claude-agent-sdk is 0.3.2, package.json pins 0.3.1',
      'zod is not installed',
      '@anthropic-ai/claude-agent-sdk-darwin-x64 (another platform\'s runtime) is installed'
    ])
  })

  it('lists install scripts that are not allowlisted', () => {
    type Manifest = { name?: string; version?: string; scripts?: Record<string, string>; hasBindingGyp?: boolean }
    const manifests = new Map<string, Manifest>([
      ['node_modules/a', { name: 'a', version: '1.0.0', scripts: { test: 'x', postinstall: 'node x.js' } }],
      ['node_modules/b', { name: 'b', version: '2.0.0', hasBindingGyp: true }],
      ['node_modules/c', { name: 'c', version: '1.0.0', scripts: { preinstall: '' } }],
      ['node_modules/ok', { name: 'ok', version: '1.0.0', scripts: { install: 'x' } }]
    ])
    expect(unlistedInstallScripts(manifests, ['ok@1.0.0'])).toEqual([
      { location: 'node_modules/a', name: 'a', version: '1.0.0', scripts: ['postinstall'] },
      { location: 'node_modules/b', name: 'b', version: '2.0.0', scripts: ['install (binding.gyp)'] }
    ])
  })

  it('names the global layout, the tarball, the native package and prerelease versions', () => {
    expect(globalLayout('linux', '/t/prefix')).toEqual({ packageDir: '/t/prefix/lib/node_modules/orgai', binDir: '/t/prefix/bin', bin: '/t/prefix/bin/orgai' })
    expect(globalLayout('win32', 'C:\\t\\prefix')).toEqual({ packageDir: 'C:\\t\\prefix\\node_modules\\orgai', binDir: 'C:\\t\\prefix', bin: 'C:\\t\\prefix\\orgai.cmd' })
    expect(tarballName('orgai', '0.1.6')).toBe('orgai-0.1.6.tgz')
    expect(tarballName('@orgai/cli', '0.1.6')).toBe('orgai-cli-0.1.6.tgz')
    expect(claudeNativePackage('darwin', 'arm64')).toBe('@anthropic-ai/claude-agent-sdk-darwin-arm64')
    expect(isPrerelease('0.1.6-dev1')).toBe(true)
    expect(isPrerelease('0.1.6')).toBe(false)
  })
})

describe('install.json and README', () => {
  it('writes an install.json the CLI reads back', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orgai-installinfo-'))
    try {
      writeFileSync(join(dir, 'install.json'), JSON.stringify(installInfoFor('npm', '0.1.6-dev1', '1a2b3c4d5e6f')))
      expect(readInstallInfo({ bundleDir: dir })).toEqual({ channel: 'npm', version: '0.1.6-dev1', commit: '1a2b3c4d5e6f', source: 'file' })
      writeFileSync(join(dir, 'install.json'), JSON.stringify(installInfoFor('app', '0.1.6', 'unknown')))
      expect(readInstallInfo({ bundleDir: dir })).toEqual({ channel: 'app', version: '0.1.6', source: 'file' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    expect(() => installInfoFor('dev', '0.1.6')).toThrow()
    expect(() => installInfoFor('npm', '0.1.6; rm -rf')).toThrow()
  })

  it('README covers install, hosts, secrets, the app and the key-file warning', () => {
    const t = readmeText({ version: '0.1.6' })
    for (const words of ['npm i -g orgai', '## Hosts', '## Secrets', '## The app and this package', '--key-file', 'Anyone who can read that key file can read every stored secret']) {
      expect(t).toContain(words)
    }
  })
})
