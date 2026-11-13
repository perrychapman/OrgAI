// node --test scripts/build-npm-package.test.mjs (npm run test:scripts). Pure parts, plus main() on a fake repo in a
// temp dir with a fake `npm pack`; never runs npm.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assertInside, checkBundle, main, npmInvocation, plan, repositoryFor } from './build-npm-package.mjs'
import { readmeText } from './lib/npmPackage.mjs'
import { commitOf, main as writeInstallInfoMain } from './write-install-info.mjs'

test('plan keeps every path under release/npm', () => {
  const root = path.resolve('/repo')
  const p = plan(root, 'orgai-cli', '1.2.3')
  assert.equal(p.packageDir, path.join(root, 'release', 'npm', 'package'))
  assert.equal(p.tgz, path.join(root, 'release', 'npm', 'orgai-cli-1.2.3.tgz'))
  assert.equal(p.sha256, `${p.tgz}.sha256`)
  assert.equal(p.cliSource, path.join(root, 'out', 'cli'))
  assert.throws(() => assertInside(p.npmDir, p.npmDir))
  assert.throws(() => assertInside(p.npmDir, path.join(root, 'out')))
})

test('repositoryFor uses GITHUB_REPOSITORY when it is a plain owner/name', () => {
  assert.deepEqual(repositoryFor({ GITHUB_REPOSITORY: 'me/OrgAI' }), { type: 'git', url: 'git+https://github.com/me/OrgAI.git' })
  assert.deepEqual(repositoryFor({ GITHUB_REPOSITORY: 'x y/z' }), { type: 'git', url: 'git+https://github.com/perrychapman/OrgAI.git' })
  assert.deepEqual(repositoryFor({}), { type: 'git', url: 'git+https://github.com/perrychapman/OrgAI.git' })
})

test('npmInvocation prefers npm-cli.js and never a shell', () => {
  // Host-neutral: path.join answers with backslashes on Windows, so compare with forward slashes.
  const exists = (p) => ['/n/lib/node_modules/npm/bin/npm-cli.js', '/x/npm-cli.js'].includes(p.replaceAll('\\', '/'))
  assert.deepEqual(npmInvocation({ npm_execpath: '/x/npm-cli.js' }, '/n/bin/node', 'darwin', exists), { command: '/n/bin/node', prefix: ['/x/npm-cli.js'] })
  assert.deepEqual(npmInvocation({ npm_execpath: '/x/pnpm.cjs' }, '/n/bin/node', 'darwin', exists), { command: '/n/bin/node', prefix: [path.join('/n/bin', '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')] })
  assert.deepEqual(npmInvocation({}, '/other/node', 'linux', () => false), { command: 'npm', prefix: [] })
  assert.deepEqual(npmInvocation({ ComSpec: 'C:\\cmd.exe' }, 'C:\\n\\node.exe', 'win32', () => false), { command: 'C:\\cmd.exe', prefix: ['/d', '/s', '/c', 'npm.cmd'] })
})

test('commitOf takes the checkout HEAD first, GITHUB_SHA only without git, and shortens to 12', () => {
  const noGit = () => { throw new Error('no git') }
  const head = () => '0123456789abcdef0123456789abcdef01234567\n'
  // A hand-run Release on a tag: the checkout is the tag, GITHUB_SHA the dispatching branch head. The checkout wins.
  assert.equal(commitOf('/nowhere', { GITHUB_SHA: 'ABCDEF0123456789abcdef0123456789abcdef01' }, head), '0123456789ab')
  assert.equal(commitOf('/nowhere', { GITHUB_SHA: 'ABCDEF0123456789abcdef0123456789abcdef01' }, noGit), 'abcdef012345')
  assert.equal(commitOf('/nowhere', { GITHUB_SHA: 'ABCDEF0123456789abcdef0123456789abcdef01' }, () => 'fatal: not a git repository'), 'abcdef012345')
  assert.equal(commitOf('/nowhere', {}, noGit), undefined)
  assert.equal(commitOf('/nowhere', {}, head), '0123456789ab')
})

/** A repo with package.json, a tiny lockfile, the SDK's package.json and a built out/cli. */
function fakeRepo({ license = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orgai-npm-build-'))
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'orgai', version: '9.9.9' }))
  const lock = {
    lockfileVersion: 3,
    packages: {
      '': { name: 'orgai', version: '9.9.9' },
      'node_modules/@anthropic-ai/claude-agent-sdk': {
        version: '0.3.1',
        resolved: 'https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/-/claude-agent-sdk-0.3.1.tgz',
        integrity: 'sha512-a',
        optionalDependencies: { '@anthropic-ai/claude-agent-sdk-darwin-arm64': '0.3.1' },
        peerDependencies: { zod: '^4' }
      },
      'node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64': { version: '0.3.1', os: ['darwin'], cpu: ['arm64'], optional: true, resolved: 'https://registry.npmjs.org/x.tgz', integrity: 'sha512-b' },
      'node_modules/zod': { version: '4.1.0', resolved: 'https://registry.npmjs.org/zod/-/zod-4.1.0.tgz', integrity: 'sha512-c', dev: true },
      'node_modules/electron': { version: '45.0.0', dev: true }
    }
  }
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify(lock))
  const sdkDir = path.join(root, 'node_modules', '@anthropic-ai', 'claude-agent-sdk')
  fs.mkdirSync(sdkDir, { recursive: true })
  fs.writeFileSync(path.join(sdkDir, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-agent-sdk', version: '0.3.1', peerDependencies: { zod: '^4' } }))
  const cli = path.join(root, 'out', 'cli')
  fs.mkdirSync(cli, { recursive: true })
  fs.writeFileSync(path.join(cli, 'orgai.mjs'), '#!/usr/bin/env -S node --disable-sigusr1\n')
  fs.chmodSync(path.join(cli, 'orgai.mjs'), 0o755)
  fs.writeFileSync(path.join(cli, 'tui.mjs'), '')
  fs.writeFileSync(path.join(cli, 'inprocHost.mjs'), '')
  fs.writeFileSync(path.join(cli, 'chunk-a.mjs'), 'var CLI_VERSION = "9.9.9";\n')
  fs.writeFileSync(path.join(cli, 'install.json'), JSON.stringify({ channel: 'app', version: '9.9.9' }))
  if (license) fs.writeFileSync(path.join(root, 'LICENSE'), 'MIT\n')
  return root
}

test('checkBundle refuses a missing file and a bundle of another version', () => {
  const root = fakeRepo()
  try {
    const cli = path.join(root, 'out', 'cli')
    assert.doesNotThrow(() => checkBundle(cli, '9.9.9'))
    assert.throws(() => checkBundle(cli, '9.9.10'), /does not carry version 9\.9\.10/)
    // The minified bundle writes the version as a template literal.
    fs.writeFileSync(path.join(cli, 'orgai.mjs'), 'var C=`9.9.11`;export{C};')
    assert.doesNotThrow(() => checkBundle(cli, '9.9.11'))
    assert.throws(() => checkBundle(cli, '9.9.1'), /does not carry version 9\.9\.1/)
    fs.rmSync(path.join(cli, 'tui.mjs'))
    assert.throws(() => checkBundle(cli, '9.9.9'), /missing tui\.mjs/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('main --dry-run prints the plan and writes nothing', () => {
  const root = fakeRepo()
  try {
    const lines = []
    const r = main(['--dry-run', '--shrinkwrap'], root, (l) => lines.push(l), { env: { GITHUB_SHA: 'a'.repeat(40) } })
    const out = lines.join('\n')
    assert.match(out, /Dry run/)
    assert.match(out, /install\.json: \{"channel":"npm","version":"9\.9\.9","commit":"aaaaaaaaaaaa"\}/)
    assert.match(out, /dependencies @anthropic-ai\/claude-agent-sdk@0\.3\.1, zod@4\.1\.0/)
    assert.match(out, /npm-shrinkwrap\.json: 3 package\(s\), 1 optional/)
    assert.match(out, /no LICENSE in the repo: license UNLICENSED/)
    assert.equal(r.dryRun, true)
    assert.equal(fs.existsSync(path.join(root, 'release')), false)
    assert.throws(() => main(['--bogus'], root, () => {}), /Unknown argument/)
    assert.throws(() => main(['--shrinkwrap', '--no-shrinkwrap'], root, () => {}), /not both/)
    const plain = []
    main(['--dry-run'], root, (l) => plain.push(l))
    assert.match(plain.join('\n'), /Would leave out npm-shrinkwrap\.json \(the default/, 'no shrinkwrap unless asked')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('main writes the package folder, packs it with npm and records the sha256', () => {
  const root = fakeRepo({ license: true })
  try {
    const calls = []
    const exec = (cmd, args, opts) => {
      calls.push({ cmd, args, opts })
      fs.writeFileSync(path.join(args[args.indexOf('--pack-destination') + 1], 'orgai-cli-9.9.9.tgz'), 'tarball bytes')
    }
    const r = main(['--shrinkwrap'], root, () => {}, { env: { GITHUB_SHA: 'b'.repeat(40), GITHUB_REPOSITORY: 'me/OrgAI' }, exec, execPath: '/n/bin/node', platform: 'linux' })
    const pkgDir = path.join(root, 'release', 'npm', 'package')
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
    assert.deepEqual(pkg.bin, { orgai: 'out/cli/orgai.mjs' })
    assert.equal(fs.readFileSync(path.join(pkgDir, 'out', 'cli', 'orgai.mjs'), 'utf8').split(/\r?\n/, 1)[0], '#!/usr/bin/env -S node --disable-sigusr1')
    assert.deepEqual(pkg.dependencies, { '@anthropic-ai/claude-agent-sdk': '0.3.1', zod: '4.1.0' })
    assert.equal(pkg.scripts, undefined)
    assert.equal(pkg.license, 'SEE LICENSE IN LICENSE')
    assert.deepEqual(pkg.repository, { type: 'git', url: 'git+https://github.com/me/OrgAI.git' })
    const sw = JSON.parse(fs.readFileSync(path.join(pkgDir, 'npm-shrinkwrap.json'), 'utf8'))
    assert.deepEqual(Object.keys(sw.packages).sort(), ['', 'node_modules/@anthropic-ai/claude-agent-sdk', 'node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64', 'node_modules/zod'])
    assert.equal(sw.packages['node_modules/zod'].dev, undefined, 'repo-only flags dropped')
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(pkgDir, 'out', 'cli', 'install.json'), 'utf8')), { channel: 'npm', version: '9.9.9', commit: 'bbbbbbbbbbbb' })
    assert.ok(fs.existsSync(path.join(pkgDir, 'out', 'cli', 'chunk-a.mjs')))
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(pkgDir, 'out', 'cli', 'orgai.mjs')).mode & 0o111, 0o111)
    assert.equal(fs.readFileSync(path.join(pkgDir, 'LICENSE'), 'utf8'), 'MIT\n')
    assert.match(fs.readFileSync(path.join(pkgDir, 'README.md'), 'utf8'), /npm-shrinkwrap\.json/)
    assert.equal(calls.length, 1)
    assert.ok(calls[0].args.includes('pack') && calls[0].args.includes('--ignore-scripts'))
    assert.equal(calls[0].opts.cwd, pkgDir)
    assert.equal(calls[0].opts.env.npm_config_ignore_scripts, 'true')
    const sum = fs.readFileSync(path.join(root, 'release', 'npm', 'orgai-cli-9.9.9.tgz.sha256'), 'utf8')
    assert.equal(sum, `${r.sha256}  orgai-cli-9.9.9.tgz\n`)
    // The repo's own out/cli keeps its install.json: the package copy is the only one rewritten.
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'out', 'cli', 'install.json'), 'utf8')).channel, 'app')

    main([], root, () => {}, { env: {}, exec, execPath: '/n/bin/node', platform: 'linux' })
    assert.equal(fs.existsSync(path.join(pkgDir, 'npm-shrinkwrap.json')), false, 'a rebuild starts from an empty folder')
    const pkg2 = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
    assert.equal(pkg2.files.includes('npm-shrinkwrap.json'), false)
    assert.match(fs.readFileSync(path.join(pkgDir, 'README.md'), 'utf8'), /pins its direct dependencies/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('main refuses a stale bundle and a link in it', () => {
  const root = fakeRepo()
  try {
    fs.writeFileSync(path.join(root, 'out', 'cli', 'chunk-a.mjs'), 'var CLI_VERSION = "9.9.8";\n')
    assert.throws(() => main([], root, () => {}, { env: {}, exec: () => {} }), /does not carry version 9\.9\.9/)
    if (process.platform !== 'win32') {
      fs.writeFileSync(path.join(root, 'out', 'cli', 'chunk-a.mjs'), 'var CLI_VERSION = "9.9.9";\n')
      fs.symlinkSync('/etc/hosts', path.join(root, 'out', 'cli', 'evil.mjs'))
      assert.throws(() => main([], root, () => {}, { env: {}, exec: () => {} }), /is a link/)
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('the npm run dist scripts run electron-builder directly: the app ships no CLI bundle, so no install.json', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8'))
  const dist = Object.entries(pkg.scripts).filter(([k]) => k === 'dist' || k.startsWith('dist:'))
  assert.ok(dist.length >= 7)
  for (const [name, cmd] of dist) {
    assert.match(cmd, /electron-builder /, name)
    assert.doesNotMatch(cmd, /write-install-info/, `${name} writes no install.json`)
  }
})

test('write-install-info writes channel app and removes it again', () => {
  const root = fakeRepo()
  try {
    fs.rmSync(path.join(root, 'out', 'cli', 'install.json'))
    writeInstallInfoMain(['--channel', 'app'], root, () => {}, { GITHUB_SHA: 'c'.repeat(40) })
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'out', 'cli', 'install.json'), 'utf8')), { channel: 'app', version: '9.9.9', commit: 'cccccccccccc' })
    writeInstallInfoMain(['--remove'], root, () => {})
    assert.equal(fs.existsSync(path.join(root, 'out', 'cli', 'install.json')), false)
    assert.throws(() => writeInstallInfoMain(['--channel', 'dev'], root, () => {}, {}), /Unknown install channel/)
    assert.throws(() => writeInstallInfoMain([], root, () => {}, {}), /Use: write-install-info/)
    fs.rmSync(path.join(root, 'out', 'cli', 'orgai.mjs'))
    assert.throws(() => writeInstallInfoMain(['--channel=app'], root, () => {}, {}), /holds no CLI bundle/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('the README of a prerelease installs from the next tag, a stable one from latest', () => {
  assert.match(readmeText({ version: '0.1.6-dev1' }), /npm i -g orgai-cli@next\n/)
  assert.match(readmeText({ version: '0.1.6' }), /npm i -g orgai-cli\n/)
})

test('the README describes the standalone CLI: no daemon, no --host, no shared data folder', () => {
  const text = readmeText({ version: '0.1.6' })
  assert.doesNotMatch(text, /daemon/i)
  assert.doesNotMatch(text, /--host/)
  assert.doesNotMatch(text, /share one data folder/)
  assert.doesNotMatch(text, /connects to it|starts it in the background/)
  for (const word of ['orgai-cli', 'ORGAI_CLI_DATA_DIR', 'ORGAI_CLI_VAULT_KEY_FILE', '--data-dir']) assert.ok(text.includes(word), word)
})
