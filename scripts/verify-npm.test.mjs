// node --test scripts/verify-npm.test.mjs (npm run test:scripts). Pure helpers, the local servers on 127.0.0.1, and
// main() with an injected runner, registry and proxy; never runs npm or a real orgai.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { globalLayout } from './lib/npmPackage.mjs'
import {
  checkNpmDoctor,
  folderBytes,
  listInstalledTree,
  main,
  npmCliEnv,
  npmEnv,
  packumentFor,
  parseArgs,
  readTgz,
  registryPathOf,
  startFakeLiteLLM,
  startLocalRegistry,
  vaultNotBuilt,
  vaultState,
  connectionTestState,
  versionSaysNpm,
  whichOnPath,
  withNodeFirst
} from './verify-npm.mjs'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version

/** A gzipped ustar archive of { name: string | Buffer }. */
function makeTgz(files) {
  const blocks = []
  for (const [name, content] of Object.entries(files)) {
    const body = Buffer.isBuffer(content) ? content : Buffer.from(content)
    const h = Buffer.alloc(512)
    h.write(name, 0, 100)
    h.write('0000644\0', 100)
    h.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124)
    h.write('00000000000\0', 136)
    h.write('        ', 148)
    h[156] = 48
    h.write('ustar\0', 257)
    let sum = 0
    for (const b of h) sum += b
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148)
    blocks.push(h, body, Buffer.alloc((512 - (body.length % 512)) % 512))
  }
  blocks.push(Buffer.alloc(1024))
  return zlib.gzipSync(Buffer.concat(blocks))
}

const tempDir = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `orgai-vnpm-${n}-`))

test('parseArgs', () => {
  assert.deepEqual(parseArgs([]), { tarball: undefined, keep: false })
  assert.deepEqual(parseArgs(['--tarball', 'a.tgz', '--keep']), { tarball: 'a.tgz', keep: true })
  assert.deepEqual(parseArgs(['--tarball=b.tgz']), { tarball: 'b.tgz', keep: false })
  assert.throws(() => parseArgs(['--tarball']), /needs a file/)
  assert.throws(() => parseArgs(['--x']), /Unknown argument/)
})

test('environment helpers', () => {
  assert.deepEqual(withNodeFirst({ Path: 'C:\\a' }, 'C:\\node', 'win32'), { Path: 'C:\\node;C:\\a' })
  assert.deepEqual(withNodeFirst({}, '/n', 'linux'), { PATH: '/n' })
  const e = npmEnv({ HOME: '/h', npm_config_prefix: '/old', NPM_CONFIG_OMIT: 'optional', npm_config_registry: 'r', x: undefined }, '/p')
  assert.equal(e.npm_config_prefix, '/p')
  assert.equal(e.NPM_CONFIG_OMIT, undefined, 'an ambient --omit=optional would drop the Claude runtime')
  assert.equal(e.npm_config_registry, 'r')
  assert.equal(e.HOME, '/h')
  assert.equal('x' in e, false)
  assert.deepEqual(npmCliEnv({ ORGAI_VAULT_KEY_FILE: '/k', ORGAI_CLAUDE_PATH: '/c', ORGAI_MOCK: '1' }), { ORGAI_MOCK: '1' })
})

test('output readers', () => {
  assert.equal(versionSaysNpm('0.1.6 channel npm commit abc'), true)
  assert.equal(versionSaysNpm('0.1.6 channel app'), false)
  assert.equal(vaultNotBuilt({ code: 2, stderr: 'orgai: `orgai secrets` is not available in this build yet.' }), true)
  assert.equal(vaultNotBuilt({ code: 0, stdout: '{}' }), false)
  assert.equal(vaultState(JSON.stringify({ state: 'key-mismatch' })), 'key-mismatch')
  assert.equal(vaultState(JSON.stringify({ vault: { state: 'open' } })), 'open')
  assert.equal(vaultState('nope'), undefined)
  assert.equal(connectionTestState(JSON.stringify({ id: 'litellm', status: 'connected', ok: true })), 'connected')
  assert.equal(connectionTestState(JSON.stringify({ state: 'connected' })), undefined)
  assert.equal(connectionTestState('nope'), undefined)
})

test('checkNpmDoctor', () => {
  const doc = (checks) => JSON.stringify({ ok: true, checks })
  const ok = checkNpmDoctor(doc([{ id: 'install-channel', status: 'ok', detail: 'channel npm, version 1' }, { id: 'node', status: 'ok', detail: 'x' }]))
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.notes, ['no Claude runtime check in this build', 'no vault check in this build'])
  const bad = checkNpmDoctor(
    doc([
      { id: 'install-channel', status: 'ok', detail: 'channel dev' },
      { id: 'claude-runtime', status: 'warn', detail: 'missing' },
      { id: 'vault', status: 'ok', detail: 'open (key-file)' },
      { id: 'launcher', status: 'fail', detail: 'no app' }
    ])
  )
  assert.equal(bad.ok, false)
  assert.deepEqual(bad.problems, ['install-channel says channel dev', 'claude-runtime is warn: missing', 'launcher failed: no app'])
  assert.deepEqual(bad.notes, ['vault: ok open (key-file)'])
  assert.equal(checkNpmDoctor('garbage').ok, false)
})

test('listInstalledTree walks scopes and nested node_modules; folderBytes sums files', () => {
  const dir = tempDir('tree')
  try {
    const add = (rel, pkg, extra = {}) => {
      const d = path.join(dir, ...rel.split('/'))
      fs.mkdirSync(d, { recursive: true })
      fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify(pkg))
      for (const [f, t] of Object.entries(extra)) fs.writeFileSync(path.join(d, f), t)
    }
    add('node_modules/a', { name: 'a', version: '1.0.0' })
    add('node_modules/@s/b', { name: '@s/b', version: '2.0.0' }, { 'binding.gyp': '{}' })
    add('node_modules/a/node_modules/c', { name: 'c', version: '3.0.0' })
    fs.mkdirSync(path.join(dir, 'node_modules', '.bin'))
    fs.mkdirSync(path.join(dir, 'node_modules', 'not-a-package'))
    const t = listInstalledTree(dir)
    assert.deepEqual([...t.keys()].sort(), ['node_modules/@s/b', 'node_modules/a', 'node_modules/a/node_modules/c'])
    assert.equal(t.get('node_modules/@s/b').hasBindingGyp, true)
    assert.equal(t.get('node_modules/a/node_modules/c').version, '3.0.0')
    assert.ok(folderBytes(path.join(dir, 'node_modules')) > 0)
    assert.equal(folderBytes(path.join(dir, 'missing')), 0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('whichOnPath', () => {
  const files = new Set(['/b/codex', 'C:\\t\\codex.cmd'])
  const exists = (p) => files.has(p)
  assert.equal(whichOnPath('codex', { PATH: '/a:/b:relative' }, 'linux', exists), '/b/codex')
  assert.equal(whichOnPath('codex', { Path: 'C:\\t' }, 'win32', exists), 'C:\\t\\codex.cmd')
  assert.equal(whichOnPath('codex', {}, 'linux', exists), undefined)
})

test('readTgz and the packument', () => {
  const tgz = makeTgz({ 'package/package.json': '{"name":"orgai","version":"1.0.0"}', 'package/npm-shrinkwrap.json': '{}', 'package/out/cli/orgai.mjs': 'x' })
  const files = readTgz(tgz, (n) => n.endsWith('.json'))
  assert.deepEqual([...files.keys()], ['package/package.json', 'package/npm-shrinkwrap.json'])
  assert.throws(() => readTgz(zlib.gzipSync(Buffer.from('short'))), /truncated|not a tar/)
  const p = packumentFor({ name: 'orgai', version: '1.0.0' }, { tarballUrl: 'http://x/orgai/-/orgai-1.0.0.tgz', integrity: 'sha512-i', shasum: 's', hasShrinkwrap: true })
  assert.deepEqual(p['dist-tags'], { latest: '1.0.0', next: '1.0.0' })
  assert.equal(p.versions['1.0.0']._hasShrinkwrap, true)
  assert.equal(p.versions['1.0.0'].dist.tarball, 'http://x/orgai/-/orgai-1.0.0.tgz')
  assert.equal(registryPathOf('@orgai/cli'), '/@orgai%2fcli')
})

async function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    http
      .get(url, { headers }, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }))
      })
      .on('error', reject)
  })
}

test('the fake LiteLLM answers only the synthetic key', async () => {
  const proxy = await startFakeLiteLLM('sk-test-123')
  try {
    assert.equal((await get(`${proxy.url}/v1/models`)).status, 401)
    assert.equal((await get(`${proxy.url}/v1/models`, { authorization: 'Bearer sk-test-12' })).status, 401)
    const ok = await get(`${proxy.url}/v1/models`, { authorization: 'Bearer sk-test-123' })
    assert.equal(ok.status, 200)
    assert.equal(JSON.parse(ok.body).data[0].id, 'verify-npm-model')
    assert.equal((await get(`${proxy.url}/model/info`, { 'x-api-key': 'sk-test-123' })).status, 200)
    assert.equal((await get(`${proxy.url}/key/info`, { authorization: 'Bearer sk-test-123' })).status, 404)
    assert.deepEqual(proxy.hits, { authorized: 2, refused: 2 })
  } finally {
    await proxy.close()
  }
})

test('the local registry serves the tarball and proxies everything else upstream', async () => {
  const dir = tempDir('reg')
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ upstream: req.url }))
  })
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r))
  try {
    const tgz = path.join(dir, 'orgai-1.0.0.tgz')
    fs.writeFileSync(tgz, 'tarball-bytes')
    const reg = await startLocalRegistry({ tarball: tgz, pkg: { name: 'orgai', version: '1.0.0', dependencies: { zod: '4.1.0' } }, hasShrinkwrap: true, upstream: `http://127.0.0.1:${upstream.address().port}` })
    try {
      const doc = JSON.parse((await get(`${reg.url}orgai`)).body)
      const v = doc.versions['1.0.0']
      assert.equal(v._hasShrinkwrap, true)
      assert.deepEqual(v.dependencies, { zod: '4.1.0' })
      const file = await get(v.dist.tarball)
      assert.equal(file.body.toString(), 'tarball-bytes')
      assert.match(v.dist.integrity, /^sha512-/)
      assert.deepEqual(JSON.parse((await get(`${reg.url}zod`)).body), { upstream: '/zod' })
      assert.deepEqual(reg.requests, { own: 2, proxied: 1, failed: 0 })
    } finally {
      await reg.close()
    }
  } finally {
    upstream.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

/** A fake root with package.json and the allowlist, and a tarball in release/npm. */
function fakeRoot({ shrinkwrap = true } = {}) {
  const root = tempDir('root')
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'orgai', version: VERSION }))
  fs.mkdirSync(path.join(root, 'scripts'))
  fs.writeFileSync(path.join(root, 'scripts', 'npm-install-scripts-allowlist.json'), JSON.stringify({ allowed: [] }))
  const pkg = { name: 'orgai', version: VERSION, dependencies: { a: '1.0.0' } }
  const sw = { packages: { '': {}, 'node_modules/a': { version: '1.0.0' }, [`node_modules/@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`]: { version: '0.3.1', optional: true } } }
  fs.mkdirSync(path.join(root, 'release', 'npm'), { recursive: true })
  const files = { 'package/package.json': JSON.stringify(pkg) }
  if (shrinkwrap) files['package/npm-shrinkwrap.json'] = JSON.stringify(sw)
  fs.writeFileSync(path.join(root, 'release', 'npm', `orgai-${VERSION}.tgz`), makeTgz(files))
  return { root, pkg, sw }
}

/** A runner that "installs" the package into the prefix and answers orgai, claude and npm config. */
function fakeRun(calls, { pkg, sw }, answers = {}) {
  return async (cmd) => {
    calls.push(cmd)
    const a = cmd.args
    if (a.includes('config')) return { code: 0, stdout: 'https://registry.example/\n', stderr: '' }
    if (a.includes('install')) {
      const prefix = a[a.indexOf('--prefix') + 1]
      const { packageDir, bin } = globalLayout(process.platform, prefix)
      const put = (rel, json) => {
        fs.mkdirSync(path.join(packageDir, rel), { recursive: true })
        fs.writeFileSync(path.join(packageDir, rel, 'package.json'), JSON.stringify(json))
      }
      put('.', pkg)
      if (sw) fs.writeFileSync(path.join(packageDir, 'npm-shrinkwrap.json'), JSON.stringify(sw))
      fs.mkdirSync(path.join(packageDir, 'out', 'cli'), { recursive: true })
      fs.writeFileSync(path.join(packageDir, 'out', 'cli', 'install.json'), JSON.stringify({ channel: 'npm', version: VERSION }))
      put('node_modules/a', { name: 'a', version: '1.0.0', ...(answers.script ? { scripts: { postinstall: 'node x' } } : {}) })
      put(`node_modules/@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`, { name: 'native', version: '0.3.1' })
      if (answers.otherPlatform) put('node_modules/@anthropic-ai/claude-agent-sdk-plan9-mips', { name: 'other', version: '0.3.1' })
      fs.mkdirSync(path.dirname(bin), { recursive: true })
      fs.writeFileSync(bin, '')
      return { code: 0, stdout: '', stderr: '' }
    }
    if (a.includes('--version') && /claude(\.exe)?$/.test(cmd.command)) return { code: 0, stdout: '2.1.312 (Claude Code)\n', stderr: '' }
    if (a.includes('--version')) return { code: 0, stdout: `${VERSION} channel npm commit abc\n`, stderr: '' }
    if (a.includes('doctor')) return { code: 0, stdout: JSON.stringify({ ok: true, checks: [{ id: 'install-channel', status: 'ok', detail: 'channel npm' }] }), stderr: '' }
    if (a.includes('exec')) return answers.exec ?? { code: 0, stdout: JSON.stringify({ outcome: 'completed', exitCode: 0 }), stderr: '' }
    if (a.includes('secrets')) return answers.secrets ?? { code: 2, stdout: '', stderr: 'orgai: `orgai secrets` is not available in this build yet.' }
    return { code: 9, stdout: '', stderr: `unexpected ${a.join(' ')}` }
  }
}

async function runMain(fake, answers, extraDeps = {}) {
  const calls = []
  const lines = []
  const tmp = tempDir('tmp')
  try {
    const code = await main([], {
      root: fake.root,
      run: extraDeps.wrapRun ? extraDeps.wrapRun(fakeRun(calls, fake, answers)) : fakeRun(calls, fake, answers),
      ...(extraDeps.fakeProxy ? { fakeProxy: extraDeps.fakeProxy } : {}),
      log: (l) => lines.push(l),
      tmpDir: tmp,
      env: { PATH: '', HOME: os.homedir(), ORGAI_SECRET_X: 'shh', ORGAI_VAULT_KEY_FILE: '/mine.key' },
      git: () => {},
      localRegistry: async () => ({ url: 'http://127.0.0.1:1/', requests: {}, close: async () => {} })
    })
    return { code, calls, out: lines.join('\n'), leftovers: fs.readdirSync(tmp) }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

test('main: a matching install passes, vault and codex skip, temp dirs removed', async () => {
  const fake = fakeRoot()
  try {
    const r = await runMain(fake)
    assert.equal(r.code, 0, r.out)
    for (const id of ['(1) install', '(1b) --ignore-scripts', '(2) --version', '(3) doctor', '(4) claude runtime', '(5) exec auto']) assert.match(r.out, new RegExp(`ok +${id.replace(/[()]/g, '\\$&')}`), id)
    assert.match(r.out, /skip +\(6\) vault/)
    assert.match(r.out, /skip +\(7\) codex/)
    assert.deepEqual(r.leftovers, [])
    const installs = r.calls.filter((c) => c.args.includes('install'))
    assert.equal(installs.length, 2)
    assert.ok(installs[0].args.includes(`orgai@${VERSION}`) && installs[0].args.includes('--registry'))
    assert.ok(installs[1].args.includes('--ignore-scripts'))
    const exec = r.calls.find((c) => c.args.includes('exec'))
    assert.ok(exec.args.includes('auto'))
    assert.equal(exec.env.ORGAI_MOCK, '1')
    assert.equal(exec.env.ORGAI_SECRET_X, undefined)
    assert.equal(exec.env.ORGAI_VAULT_KEY_FILE, undefined)
    assert.ok(exec.env.PATH.startsWith(path.dirname(process.execPath)))
  } finally {
    fs.rmSync(fake.root, { recursive: true, force: true })
  }
})

test('main: an unlisted install script, a wrong version and a failed exec each fail', async () => {
  const fake = fakeRoot()
  try {
    const r = await runMain(fake, { script: true, exec: { code: 1, stdout: '', stderr: 'no app' } })
    assert.equal(r.code, 1)
    assert.match(r.out, /fail +\(1\) install +a@1\.0\.0 runs postinstall at install/)
    assert.match(r.out, /fail +\(5\) exec auto/)
    fake.sw.packages['node_modules/a'].version = '1.0.1'
    fs.writeFileSync(path.join(fake.root, 'release', 'npm', `orgai-${VERSION}.tgz`), makeTgz({ 'package/package.json': JSON.stringify(fake.pkg), 'package/npm-shrinkwrap.json': '{}' }))
    const w = await runMain(fake)
    assert.match(w.out, /fail +\(1\) install +node_modules\/a is 1\.0\.0, shrinkwrap says 1\.0\.1/)
  } finally {
    fs.rmSync(fake.root, { recursive: true, force: true })
  }
})

test('main: a failed step 1 (another platform\'s runtime installed) skips step 1b instead of a second full install', async () => {
  const fake = fakeRoot()
  try {
    fake.sw.packages['node_modules/@anthropic-ai/claude-agent-sdk-plan9-mips'] = { version: '0.3.1', optional: true, os: ['plan9'], cpu: ['mips'] }
    fs.writeFileSync(path.join(fake.root, 'release', 'npm', `orgai-${VERSION}.tgz`), makeTgz({ 'package/package.json': JSON.stringify(fake.pkg), 'package/npm-shrinkwrap.json': JSON.stringify(fake.sw) }))
    const r = await runMain(fake, { otherPlatform: true })
    assert.equal(r.code, 1)
    assert.match(r.out, /fail +\(1\) install +npm installed 1 package\(s\) for other platforms/)
    assert.match(r.out, /skip +\(1b\) --ignore-scripts +skipped: step 1 failed/)
    assert.equal(r.calls.filter((c) => c.args.includes('install')).length, 1, 'one install only')
    assert.match(r.out, /ok +\(2\) --version/, 'the later steps still run')
  } finally {
    fs.rmSync(fake.root, { recursive: true, force: true })
  }
})

test('main: without a shrinkwrap only the direct dependencies are compared', async () => {
  const fake = fakeRoot({ shrinkwrap: false })
  try {
    const r = await runMain({ ...fake, sw: undefined })
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /ok +\(1\) install .*only the direct dependencies are pinned/)
  } finally {
    fs.rmSync(fake.root, { recursive: true, force: true })
  }
})

test('main: a missing tarball or an unknown argument exits 2', async () => {
  const lines = []
  assert.equal(await main(['--nope'], { log: (l) => lines.push(l) }), 2)
  const root = tempDir('empty')
  try {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '1.0.0' }))
    assert.equal(await main([], { root, log: (l) => lines.push(l) }), 2)
    assert.match(lines.at(-1), /no tarball/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

/**
 * A fake vault behind `orgai secrets` / `connections`: one stored LiteLLM key shared across "processes" (calls), a
 * key-mismatch answer when ORGAI_VAULT_KEY_FILE names another key file, and the shapes of the real commands
 * (connections.ts runTest: `{ id, status, ok }`; SecretsStatusResult: `{ state, ... }`). `leak` prints the key.
 */
function fakeVault({ leak = false, staleAfterClear = false } = {}) {
  const st = { key: undefined, keyFile: undefined, cmds: [] }
  const wrap = (inner) => async (cmd) => {
    const a = cmd.args
    const has = (...w) => w.every((x) => a.includes(x))
    if (has('secrets')) st.cmds.push(a.slice(a.indexOf('secrets')).join(' '))
    if (has('connections')) st.cmds.push(a.slice(a.indexOf('connections')).join(' '))
    if (has('secrets', 'status')) {
      const other = cmd.env.ORGAI_VAULT_KEY_FILE
      const state = other && st.keyFile && other !== st.keyFile ? 'key-mismatch' : st.keyFile ? 'open' : 'absent'
      return { code: 0, stdout: JSON.stringify({ state, scheme: 'key-file', counts: { vault: st.key ? 1 : 0, legacy: 0, unreadable: 0, overlay: 0 } }), stderr: '' }
    }
    if (has('secrets', 'init')) {
      st.keyFile = a[a.indexOf('--key-file') + 1]
      return { code: 0, stdout: '', stderr: '' }
    }
    if (has('connections', 'update')) return { code: 0, stdout: '', stderr: '' }
    if (has('connections', 'set-secret', '--stdin')) {
      st.key = String(cmd.input ?? '').trim()
      return { code: 0, stdout: '', stderr: '' }
    }
    if (has('connections', 'set-secret', '--clear')) {
      if (!staleAfterClear) st.key = undefined
      return { code: 0, stdout: '', stderr: '' }
    }
    if (has('connections', 'test')) {
      const status = st.key ? 'connected' : 'disconnected'
      return { code: st.key ? 0 : 5, stdout: JSON.stringify({ id: 'litellm', status, ok: !!st.key, ...(leak && st.key ? { detail: `key ${st.key}` } : {}) }), stderr: '' }
    }
    return inner(cmd)
  }
  const proxy = async (key) => {
    st.proxyKey = key
    return { url: 'http://127.0.0.1:9/', hits: { authorized: 1, refused: 0 }, close: async () => {} }
  }
  return { st, wrap, proxy }
}

test('main step (6): a working key-file vault passes: stored, read in another process, key-mismatch, then cleared', async () => {
  const fake = fakeRoot()
  const v = fakeVault()
  try {
    const r = await runMain(fake, {}, { wrapRun: v.wrap, fakeProxy: v.proxy })
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /ok +\(6\) vault +key file vault: stored in one process, read in another/)
    assert.ok(v.st.proxyKey.startsWith('sk-verify-'), 'the proxy gets the synthetic key')
    assert.doesNotMatch(r.out, new RegExp(v.st.proxyKey))
    assert.deepEqual(
      v.st.cmds.map((c) => c.replace(/--key-file \S+/, '--key-file K').replace(/--base-url \S+/, '--base-url U')),
      [
        'secrets status',
        'secrets init --key-file K',
        'connections update litellm --base-url U --enable',
        'connections set-secret litellm --stdin',
        'connections test litellm',
        'secrets status',
        'connections set-secret litellm --clear',
        'connections test litellm'
      ]
    )
  } finally {
    fs.rmSync(fake.root, { recursive: true, force: true })
  }
})

test('main step (6): a key that survives the delete fails; a printed key fails without echoing it', async () => {
  const fake = fakeRoot()
  try {
    const stale = fakeVault({ staleAfterClear: true })
    const r = await runMain(fake, {}, { wrapRun: stale.wrap, fakeProxy: stale.proxy })
    assert.equal(r.code, 1)
    assert.match(r.out, /fail +\(6\) vault +after the delete: expected disconnected, got connected/)
    const leak = fakeVault({ leak: true })
    const l = await runMain(fake, {}, { wrapRun: leak.wrap, fakeProxy: leak.proxy })
    assert.equal(l.code, 1)
    assert.match(l.out, /fail +\(6\) vault +the synthetic key was printed by an orgai command/)
    assert.doesNotMatch(l.out, new RegExp(leak.st.proxyKey))
  } finally {
    fs.rmSync(fake.root, { recursive: true, force: true })
  }
})
