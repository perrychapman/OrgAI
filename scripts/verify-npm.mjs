#!/usr/bin/env node
// Checks the npm package of the orgai command (Wave 7, docs/design/cli-standalone.md 3.4, verify-npm steps 1-7).
// Token-free: every run is the mock adapter (ORGAI_MOCK=1) on a fresh temp data folder; nothing is published.
//
//   node scripts/verify-npm.mjs                               check release/npm/orgai-<version>.tgz
//   node scripts/verify-npm.mjs --tarball <file.tgz>          check another tarball
//   node scripts/verify-npm.mjs --keep                        keep the temp folders (their paths are printed)
//
// The installs go through a local registry on 127.0.0.1 (startLocalRegistry) that serves the tarball as a published
// version (with `_hasShrinkwrap: true`, as the public registry marks a package that contains npm-shrinkwrap.json) and
// passes every other request to the upstream registry (`npm config get registry`). npm honours a dependency's
// shrinkwrap only when its manifest says so, which a plain `npm i -g ./file.tgz` never does (read from npm 11.12.1's
// arborist and observed: such an install re-resolved six packages to newer versions), so this is the closest local
// stand-in for `npm i -g orgai-cli` after publishing. That the public registry sets `_hasShrinkwrap` is UNVERIFIED here.
//
// Steps, each printed as one ok / fail / skip line; exit 0 only when none fails:
//   (1)  `npm i -g orgai-cli@<version>` into a temp prefix: the installed tree equals the shrinkwrap's entries for this platform
//        (os / cpu; Linux accepts either libc build), this platform's Claude runtime package is there, install.json
//        says npm, and no package has an install script missing from scripts/npm-install-scripts-allowlist.json
//   (1b) with an empty allowlist: the same install with --ignore-scripts into a second prefix, then `orgai --version`
//   (2)  `orgai --version` prints the version and `channel npm`
//   (3)  `orgai --output-format json doctor`: install channel npm; a Claude runtime check, when doctor has one, is ok;
//        no check failed; the vault check is reported when doctor has one
//   (4)  the Claude runtime answers `--version` (token-free)
//   (5)  `ORGAI_MOCK=1 orgai exec --create-project` on a temp git repo: exit 0, outcome 'completed'
//        (the command hosts itself; no app, no background host)
//   (6)  vault across processes: `secrets init --key-file`, a LiteLLM connection at a local fake proxy (127.0.0.1,
//        answers /v1/models only for a synthetic bearer that is never printed), `connections set-secret litellm
//        --stdin` in one process and `connections test litellm` in a fresh one (connected); another valid key file
//        through ORGAI_CLI_VAULT_KEY_FILE reads as key-mismatch; after `set-secret --clear` the test says disconnected.
//        SKIP only when the build has no `orgai secrets` (exit 2 "not available in this build"); the vault is merged, so
//        it runs. The flow was driven by hand against the built bundle with a throwaway data folder (Wave 7 integration).
//   (8)  the CLI's own data folder: a fresh install writes `product.json` marking it orgai-cli, and a decoy ORGAI_DATA_DIR
//        (the app's variable) stays empty: the CLI ignores it
//   (7)  Codex, when `codex` is on PATH or ORGAI_CODEX_PATH names it: `--version` and an app-server `initialize`
//        handshake on a temp CODEX_HOME (token-free per the Codex schema; UNVERIFIED until run). SKIP otherwise.
//
// Writes only its temp folders (outside the checkout; removed at the end unless --keep). npm downloads the pinned
// dependencies from the registry (the user's npm config and cache apply). A host left behind (there should be none: the
// CLI's host ends with its command) is stopped by the pid in the temp data folder's daemon.json only. Windows: orgai.cmd runs through `cmd.exe /d /s /c` with fixed arguments.
import { createHash, randomBytes } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  NPM_PACKAGE_NAME,
  claudeNativePackage,
  compareInstalledTree,
  compareTopLevel,
  globalLayout,
  tarballName,
  unlistedInstallScripts
} from './lib/npmPackage.mjs'
import { npmInvocation } from './build-npm-package.mjs'

/** A key file only its owner can read (Windows: restrict the DACL to this user, as the key-file custodian demands). */
function writeRestrictedKeyFile(file, bytes) {
  fs.writeFileSync(file, bytes, { mode: 0o600 })
  if (process.platform !== 'win32') return
  const who = spawnSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' })
  const sid = /"(S-1-[0-9-]+)"\s*$/m.exec(who.stdout ?? '')?.[1]
  if (!sid) throw new Error('could not read the user SID')
  const r = spawnSync('icacls.exe', [file, '/inheritance:r', '/grant:r', `*${sid}:F`, '/remove:g', '*S-1-5-18', '*S-1-5-32-544'], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`icacls failed: ${r.stdout} ${r.stderr}`)
}
import { baseVerifyEnv, cleanupDaemon, execOutcome, launchCommand, makeFixtureRepo, spawnRunner, versionMatches } from './lib/verifyCommon.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const ALLOWLIST_FILE = path.join('scripts', 'npm-install-scripts-allowlist.json')
export const CHECK_TIMEOUT_MS = 120_000
export const INSTALL_TIMEOUT_MS = 15 * 60_000
export const EXEC_PROMPT = '[mock:exec-plan] verify the npm package'
/** The model the fake LiteLLM proxy lists. */
export const FAKE_MODEL = 'verify-npm-model'

/** Parses the command line; throws a plain sentence for anything else. */
export function parseArgs(argv) {
  const out = { tarball: undefined, keep: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--keep') out.keep = true
    else if (a === '--tarball') {
      const v = argv[++i]
      if (!v || v.startsWith('--')) throw new Error('--tarball needs a file.')
      out.tarball = v
    } else if (a.startsWith('--tarball=')) {
      const v = a.slice('--tarball='.length)
      if (!v) throw new Error('--tarball needs a file.')
      out.tarball = v
    } else throw new Error(`Unknown argument ${a}. Use: verify-npm [--tarball <file.tgz>] [--keep]`)
  }
  return out
}

/** The PATH key of an environment (Path on Windows), else 'PATH'. */
export function pathKey(env) {
  return Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
}

/** `env` with `dir` first on PATH (so the bin's `#!/usr/bin/env node` and npm's .cmd run this node). Pure. */
export function withNodeFirst(env, dir, platform) {
  const key = pathKey(env)
  const sep = platform === 'win32' ? ';' : ':'
  return { ...env, [key]: env[key] ? `${dir}${sep}${env[key]}` : dir }
}

/** The environment of `npm install`: the prefix and quiet flags; the caller's npm config otherwise applies. Pure. */
export function npmEnv(base, prefix) {
  const out = {}
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !/^npm_config_(prefix|global|ignore_scripts|omit|include|production)$/i.test(k)) out[k] = v
  return { ...out, npm_config_prefix: prefix, npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false', npm_config_loglevel: 'warn' }
}

/**
 * The orgai children's environment on top of verifyCommon's baseVerifyEnv: an ambient vault key file or Claude path of the
 * person running the check never reaches the installed CLI (step 4 checks the installed runtime, step 6 its own key
 * file). Pure.
 */
export function npmCliEnv(base, cliDataDir) {
  const out = {}
  for (const [k, v] of Object.entries(base)) if (!/^ORGAI_(CLI_)?VAULT_/i.test(k) && k.toUpperCase() !== 'ORGAI_CLAUDE_PATH') out[k] = v
  // The CLI has its own data folder variable; the app's ORGAI_DATA_DIR is not its setting and must change nothing.
  if (cliDataDir !== undefined) {
    out.ORGAI_CLI_DATA_DIR = cliDataDir
    delete out.ORGAI_DATA_DIR
  }
  // Whatever the person had, an installed CLI must never reach the real OS keychain: keep (or set) the isolation flag.
  out.ORGAI_CLI_VAULT_NO_OS_KEYSTORE = '1'
  return out
}

/** True when `--version` output names `channel npm`. Pure. */
export function versionSaysNpm(stdout) {
  return /\bchannel npm\b/.test(String(stdout ?? ''))
}

function parseJson(text) {
  const s = String(text ?? '').trim()
  if (!s) return undefined
  try {
    return JSON.parse(s)
  } catch {
    const last = s.split(/\r?\n/).filter(Boolean).at(-1)
    try {
      return JSON.parse(last)
    } catch {
      return undefined
    }
  }
}

/**
 * The `orgai --output-format json doctor` document of an npm install (step 3). Returns { ok, problems, notes }. Pure.
 * The Claude runtime and vault checks belong to other work packages: required to be ok / reported only when present.
 */
export function checkNpmDoctor(stdout) {
  const doc = parseJson(stdout)
  const checks = Array.isArray(doc?.checks) ? doc.checks : undefined
  if (!checks) return { ok: false, problems: ['the doctor output is not a JSON document with checks'], notes: [] }
  const problems = []
  const notes = []
  const channel = checks.find((c) => c?.id === 'install-channel')
  if (!channel) problems.push('no install-channel check')
  else if (!/\bchannel npm\b/.test(String(channel.detail ?? ''))) problems.push(`install-channel says ${channel.detail}`)
  const claude = checks.find((c) => /claude/i.test(String(c?.id ?? '')))
  if (!claude) notes.push('no Claude runtime check in this build')
  else if (claude.status !== 'ok') problems.push(`${claude.id} is ${claude.status}: ${claude.detail}`)
  else notes.push(`${claude.id}: ${claude.detail}`)
  const vault = checks.find((c) => /vault|secret/i.test(String(c?.id ?? '')))
  notes.push(vault ? `${vault.id}: ${vault.status} ${vault.detail}` : 'no vault check in this build')
  for (const c of checks) if (c?.status === 'fail') problems.push(`${c.id} failed: ${c.detail}`)
  return { ok: problems.length === 0, problems, notes }
}

/** `secrets` command output that says this build has no vault yet (step 6 is then skipped). Pure. */
export function vaultNotBuilt(run) {
  return run.code === 2 && /not available in this build/i.test(`${run.stderr ?? ''}${run.stdout ?? ''}`)
}

/** The vault state in a `secrets status --output-format json` document, searched shallowly. Pure. */
export function vaultState(stdout) {
  const doc = parseJson(stdout)
  if (!doc || typeof doc !== 'object') return undefined
  for (const v of [doc.secrets?.state, doc.state, doc.vault?.state, doc.status?.state, doc.status]) if (typeof v === 'string') return v
  return undefined
}

/**
 * The connection state in a `connections test <id> --output-format json` document. The shape is src/cli/commands/
 * connections.ts runTest's: `{ id, status: ConnectionStatus['state'], detail?, account?, ok }`. Pure.
 */
export function connectionTestState(stdout) {
  const doc = parseJson(stdout)
  return doc && typeof doc === 'object' && typeof doc.status === 'string' ? doc.status : undefined
}

/**
 * Every package installed under `<packageDir>/node_modules` (scopes and nested node_modules included):
 * Map location (posix, relative to packageDir) -> { version, manifest, hasBindingGyp }. Links are not followed.
 */
export function listInstalledTree(packageDir, fsApi = fs) {
  const out = new Map()
  const visit = (dirRel) => {
    const abs = path.join(packageDir, ...dirRel.split('/'))
    let names
    try {
      names = fsApi.readdirSync(abs, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of names) {
      if (ent.name.startsWith('.')) continue
      if (ent.name.startsWith('@') && ent.isDirectory()) {
        let scoped
        try {
          scoped = fsApi.readdirSync(path.join(abs, ent.name), { withFileTypes: true })
        } catch {
          continue
        }
        for (const s of scoped) if (s.isDirectory() && !s.name.startsWith('.')) addPackage(`${dirRel}/${ent.name}/${s.name}`)
      } else if (ent.isDirectory()) addPackage(`${dirRel}/${ent.name}`)
    }
  }
  const addPackage = (rel) => {
    const abs = path.join(packageDir, ...rel.split('/'))
    let manifest
    try {
      manifest = JSON.parse(fsApi.readFileSync(path.join(abs, 'package.json'), 'utf8'))
    } catch {
      return
    }
    out.set(rel, { version: manifest.version, manifest, hasBindingGyp: fsApi.existsSync(path.join(abs, 'binding.gyp')) })
    visit(`${rel}/node_modules`)
  }
  visit('node_modules')
  return out
}

/** Bytes of the regular files under `dir` (links not followed); 0 when unreadable. */
export function folderBytes(dir, fsApi = fs) {
  let total = 0
  const walk = (d) => {
    let ents
    try {
      ents = fsApi.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of ents) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile()) {
        try {
          total += fsApi.statSync(p).size
        } catch {
          // gone
        }
      }
    }
  }
  walk(dir)
  return total
}

/** The first `name` on PATH (POSIX: the file; Windows: PATHEXT order), else undefined. */
export function whichOnPath(name, env, platform, exists = (p) => fs.existsSync(p) && fs.statSync(p).isFile()) {
  const list = env[pathKey(env)]
  if (!list) return undefined
  const p = platform === 'win32' ? path.win32 : path.posix
  const exts = platform === 'win32' ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase()) : ['']
  for (const dir of list.split(platform === 'win32' ? ';' : ':')) {
    if (!dir || !p.isAbsolute(dir)) continue
    for (const ext of exts) {
      const f = p.join(dir, `${name}${ext}`)
      if (exists(f)) return f
    }
  }
  return undefined
}

/**
 * A fake LiteLLM proxy on 127.0.0.1 that answers GET /v1/models (and /model/info) with one model only when the bearer
 * or x-api-key equals `key`; 401 otherwise. Resolves { url, close, hits }. The key is never logged.
 */
export function startFakeLiteLLM(key) {
  const hits = { authorized: 0, refused: 0 }
  const server = http.createServer((req, res) => {
    const auth = String(req.headers.authorization ?? '')
    const given = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : String(req.headers['x-api-key'] ?? '')
    const okKey = given.length === key.length && createHash('sha256').update(given).digest('hex') === createHash('sha256').update(key).digest('hex')
    const url = String(req.url ?? '').split('?')[0]
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (req.method !== 'GET' || (url !== '/v1/models' && url !== '/model/info')) return send(404, { error: 'not found' })
    if (!okKey) {
      hits.refused++
      return send(401, { error: { message: 'invalid key' } })
    }
    hits.authorized++
    if (url === '/model/info') return send(200, { data: [{ model_name: FAKE_MODEL, model_info: { mode: 'chat' } }] })
    return send(200, { object: 'list', data: [{ id: FAKE_MODEL, object: 'model' }] })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({ url: `http://127.0.0.1:${port}`, hits, close: () => new Promise((r) => server.close(() => r())) })
    })
  })
}

/**
 * The files of a .tgz (ustar, as `npm pack` writes): Map name -> Buffer, for names `pick` accepts. Pure apart from
 * gunzip; refuses sizes past the archive.
 */
export function readTgz(bytes, pick = () => true) {
  const tarBuf = zlib.gunzipSync(bytes)
  if (tarBuf.length < 512 || tarBuf.length % 512 !== 0) throw new Error('the tarball is truncated or not a tar archive')
  const out = new Map()
  let off = 0
  const str = (b) => b.toString('utf8').replace(/\0.*$/s, '')
  while (off + 512 <= tarBuf.length) {
    const h = tarBuf.subarray(off, off + 512)
    if (h.every((x) => x === 0)) break
    const name = str(h.subarray(0, 100))
    const prefix = str(h.subarray(345, 500))
    const size = parseInt(str(h.subarray(124, 136)).trim() || '0', 8)
    const type = String.fromCharCode(h[156] || 48)
    const full = prefix ? `${prefix}/${name}` : name
    if (!Number.isFinite(size) || size < 0 || off + 512 + size > tarBuf.length) throw new Error('the tarball is truncated or not a tar archive')
    if ((type === '0' || type === '\0') && pick(full)) out.set(full, Buffer.from(tarBuf.subarray(off + 512, off + 512 + size)))
    off += 512 + Math.ceil(size / 512) * 512
  }
  return out
}

/**
 * The packument the local registry serves for the tarball's package: one version, marked `_hasShrinkwrap` when the
 * tarball holds npm-shrinkwrap.json, both dist-tags on it. Pure.
 */
export function packumentFor(pkg, { tarballUrl, integrity, shasum, hasShrinkwrap }) {
  const manifest = { ...pkg, _id: `${pkg.name}@${pkg.version}`, _hasShrinkwrap: hasShrinkwrap === true, dist: { tarball: tarballUrl, integrity, shasum } }
  return { _id: pkg.name, name: pkg.name, 'dist-tags': { latest: pkg.version, next: pkg.version }, versions: { [pkg.version]: manifest } }
}

/** The registry path of a package name (`orgai`, `@s%2fname`). Pure. */
export function registryPathOf(name) {
  return name.startsWith('@') ? `/${name.replace('/', '%2f')}` : `/${name}`
}

/**
 * A registry on 127.0.0.1 that serves `tarball` as `pkg.name@pkg.version` and passes every other GET to `upstream`
 * (status, headers and body as they come). Resolves { url, close, requests }.
 */
export function startLocalRegistry({ tarball, pkg, hasShrinkwrap, upstream }) {
  const bytes = fs.readFileSync(tarball)
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`
  const shasum = createHash('sha1').update(bytes).digest('hex')
  const own = registryPathOf(pkg.name)
  const file = `${own}/-/${tarballName(pkg.name, pkg.version)}`
  const up = new URL(upstream.endsWith('/') ? upstream : `${upstream}/`)
  const requests = { own: 0, proxied: 0, failed: 0 }
  let base = ''
  const server = http.createServer((req, res) => {
    const url = String(req.url ?? '/')
    const pathOnly = url.split('?')[0]
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405)
      return res.end()
    }
    if (pathOnly === own || pathOnly.toLowerCase() === own.toLowerCase()) {
      requests.own++
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify(packumentFor(pkg, { tarballUrl: `${base}${file}`, integrity, shasum, hasShrinkwrap })))
    }
    if (pathOnly === file) {
      requests.own++
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': bytes.length })
      return res.end(bytes)
    }
    requests.proxied++
    const target = new URL(url.replace(/^\//, ''), up)
    const client = target.protocol === 'http:' ? http : https
    const headers = { accept: req.headers.accept ?? '*/*', 'user-agent': req.headers['user-agent'] ?? 'orgai-verify-npm', 'accept-encoding': 'identity' }
    const out = client.get(target, { headers }, (upRes) => {
      const h = { ...upRes.headers }
      delete h['transfer-encoding']
      delete h.connection
      res.writeHead(upRes.statusCode ?? 502, h)
      upRes.pipe(res)
    })
    out.on('error', (e) => {
      requests.failed++
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' })
      res.end(`upstream error: ${e.message}`)
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${server.address().port}`
      resolve({ url: `${base}/`, requests, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()) }) })
    })
  })
}

/**
 * Spawns `codex app-server`, sends `initialize` and waits for its answer (id 1). Resolves { ok, detail }; never
 * rejects. `command` / `prefix` come from launchCommand on Windows (a .cmd shim) or the binary itself.
 */
export function codexHandshake({ command, args, env, cwd, timeoutMs = 20_000, windowsVerbatimArguments = false }) {
  return new Promise((resolve) => {
    let child
    let buf = ''
    let settled = false
    const done = (r) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        child?.kill()
      } catch {
        // gone
      }
      resolve(r)
    }
    const timer = setTimeout(() => done({ ok: false, detail: `no initialize answer within ${timeoutMs / 1000} s` }), timeoutMs)
    try {
      child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, windowsVerbatimArguments })
    } catch (e) {
      done({ ok: false, detail: String(e?.message ?? e) })
      return
    }
    child.on('error', (e) => done({ ok: false, detail: String(e?.message ?? e) }))
    child.on('exit', (code) => done({ ok: false, detail: `app-server exited ${code} before answering` }))
    child.stdin.on('error', () => {})
    child.stdout.on('data', (d) => {
      buf += d
      for (const line of buf.split('\n').slice(0, -1)) {
        let msg
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        if (msg?.id === 1) done(msg.error ? { ok: false, detail: `initialize error: ${JSON.stringify(msg.error).slice(0, 300)}` } : { ok: true, detail: 'initialize answered' })
      }
      buf = buf.slice(buf.lastIndexOf('\n') + 1)
    })
    const init = { id: 1, method: 'initialize', params: { clientInfo: { name: 'orgai-verify', title: 'OrgAI verify-npm', version: '0' }, capabilities: { experimentalApi: true, requestAttestation: false } } }
    child.stdin.write(JSON.stringify(init) + '\n')
  })
}

function readAllowlist(root) {
  const file = path.join(root, ALLOWLIST_FILE)
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!Array.isArray(doc?.allowed) || !doc.allowed.every((s) => typeof s === 'string')) throw new Error(`${ALLOWLIST_FILE} must hold { "allowed": ["name@version", ...] }`)
  return doc.allowed
}

const tail = (s, n = 600) => {
  const t = String(s ?? '').trim()
  return t.length > n ? `...${t.slice(-n)}` : t
}
const showRun = (r) =>
  `${r.timedOut ? 'timed out, killed' : `exit ${r.code ?? r.signal}`}${r.stdout?.trim() ? `; stdout: ${tail(r.stdout)}` : ''}${r.stderr?.trim() ? `; stderr: ${tail(r.stderr)}` : ''}`

/**
 * Runs every step; returns the exit code (0 only when none failed). `deps` are for tests: root, platform, arch, env,
 * run (spawnRunner's shape), log, tmpDir, execPath, handshake, fakeProxy, localRegistry, git.
 */
export async function main(argv = process.argv.slice(2), deps = {}) {
  const {
    root = ROOT,
    platform = process.platform,
    arch = process.arch,
    env = process.env,
    run = spawnRunner,
    log = console.log,
    tmpDir = os.tmpdir(),
    execPath = process.execPath,
    handshake = codexHandshake,
    fakeProxy = startFakeLiteLLM,
    localRegistry = startLocalRegistry,
    git
  } = deps
  let opts
  try {
    opts = parseArgs(argv)
  } catch (e) {
    log(`verify-npm: ${e.message}`)
    return 2
  }
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
  const tarball = path.resolve(opts.tarball ?? path.join(root, 'release', 'npm', tarballName(NPM_PACKAGE_NAME, version)))
  if (!fs.existsSync(tarball)) {
    log(`verify-npm: no tarball at ${tarball}; run node scripts/build-npm-package.mjs first`)
    return 2
  }
  const results = []
  const report = (id, status, detail) => {
    results.push({ id, status })
    log(`${status === 'ok' ? 'ok  ' : status === 'skip' ? 'skip' : 'fail'}  ${id}  ${detail}`)
  }
  const tgzBytes = fs.readFileSync(tarball)
  const sum = createHash('sha256').update(tgzBytes).digest('hex')
  let pkg
  let hasShrinkwrap
  try {
    const files = readTgz(tgzBytes, (n) => n === 'package/package.json' || n === 'package/npm-shrinkwrap.json')
    pkg = JSON.parse(files.get('package/package.json')?.toString('utf8') ?? 'null')
    hasShrinkwrap = files.has('package/npm-shrinkwrap.json')
  } catch (e) {
    log(`verify-npm: ${tarball} could not be read: ${e.message}`)
    return 2
  }
  if (!pkg?.name || pkg.version !== version) {
    log(`verify-npm: ${tarball} holds ${pkg?.name}@${pkg?.version}, expected version ${version}`)
    return 2
  }
  log(`Checking ${tarball} (${pkg.name}@${version}, sha256 ${sum}) on ${platform}-${arch}, Node ${process.versions.node}`)

  const work = fs.mkdtempSync(path.join(tmpDir, 'orgai-verify-npm-'))
  const made = [work]
  const prefix = path.join(work, 'prefix')
  const userDataDir = path.join(work, 'data')
  fs.mkdirSync(prefix)
  fs.mkdirSync(userDataDir)
  const nodeDir = path.dirname(execPath)
  const npm = npmInvocation(env, execPath, platform)
  let registry
  const npmInstall = (into, extra) =>
    run({
      command: npm.command,
      args: [...npm.prefix, 'install', '--global', '--prefix', into, '--registry', registry.url, ...extra, `${pkg.name}@${pkg.version}`],
      cwd: work,
      env: withNodeFirst(npmEnv(env, into), nodeDir, platform),
      timeoutMs: INSTALL_TIMEOUT_MS
    })
  const layout = globalLayout(platform, prefix)
  // A decoy ORGAI_DATA_DIR (the app's variable) rides along: the CLI must ignore it and keep to ORGAI_CLI_DATA_DIR.
  const decoyAppDir = path.join(work, 'app-data-decoy')
  fs.mkdirSync(decoyAppDir)
  const childEnv = { ...withNodeFirst(npmCliEnv(baseVerifyEnv(env), userDataDir), nodeDir, platform), ORGAI_DATA_DIR: decoyAppDir }
  const orgaiAt = (bin, args, cwd, extra = {}) => {
    const cmd = launchCommand(platform, bin, args, env)
    return run({ ...cmd, cwd, env: { ...childEnv, ...(extra.env ?? {}) }, timeoutMs: CHECK_TIMEOUT_MS, ...(extra.input !== undefined ? { input: extra.input } : {}) })
  }
  const orgai = (args, cwd = userDataDir, extra) => orgaiAt(layout.bin, args, cwd, extra)
  let proxy
  try {
    // (1) install
    let allowlist = []
    let allowlistProblem
    try {
      allowlist = readAllowlist(root)
    } catch (e) {
      allowlistProblem = e.message
    }
    const cfg = await run({ command: npm.command, args: [...npm.prefix, 'config', 'get', 'registry'], cwd: work, env: withNodeFirst(npmEnv(env, prefix), nodeDir, platform), timeoutMs: CHECK_TIMEOUT_MS })
    const upstream = cfg.code === 0 && /^https?:\/\//.test(cfg.stdout.trim()) ? cfg.stdout.trim() : 'https://registry.npmjs.org/'
    registry = await localRegistry({ tarball, pkg, hasShrinkwrap, upstream })
    log(`Installing through a local registry (${registry.url}, upstream ${upstream}; shrinkwrap ${hasShrinkwrap ? 'in the tarball' : 'MISSING'})`)
    const inst = await npmInstall(prefix, [])
    const installed = inst.code === 0 && fs.existsSync(layout.bin) && fs.existsSync(layout.packageDir)
    if (!installed) {
      report('(1) install', 'fail', `npm install -g failed: ${showRun(inst)}`)
      for (const id of ['(2) --version', '(3) doctor', '(4) claude runtime', '(5) exec', '(6) vault', '(7) codex', '(8) data folder']) report(id, 'skip', 'skipped: the install failed')
      return finish()
    }
    const problems1 = []
    const notes1 = []
    const tree = listInstalledTree(layout.packageDir)
    const versions = new Map([...tree].map(([k, v]) => [k, v.version]))
    let shrinkwrap
    if (hasShrinkwrap) {
      try {
        shrinkwrap = JSON.parse(fs.readFileSync(path.join(layout.packageDir, 'npm-shrinkwrap.json'), 'utf8'))
      } catch {
        problems1.push('the installed package has no readable npm-shrinkwrap.json')
      }
    }
    if (shrinkwrap) {
      const cmp = compareInstalledTree(shrinkwrap, versions, platform, arch)
      if (cmp.missing.length) problems1.push(`missing: ${cmp.missing.join(', ')}`)
      if (cmp.extra.length) problems1.push(`not in the shrinkwrap: ${cmp.extra.join(', ')}`)
      for (const w of cmp.wrongVersion) problems1.push(`${w.location} is ${w.installed}, shrinkwrap says ${w.expected}`)
      if (cmp.otherPlatforms.length) {
        const mb = Math.round(cmp.otherPlatforms.reduce((n, loc) => n + folderBytes(path.join(layout.packageDir, ...loc.split('/'))), 0) / 1e6)
        problems1.push(
          `npm installed ${cmp.otherPlatforms.length} package(s) for other platforms from the shrinkwrap (${mb} MB: ${cmp.otherPlatforms.map((l) => l.slice(l.lastIndexOf('/') + 1)).join(', ')}); this npm applies no os / cpu check to a dependency's shrinkwrap`
        )
      }
    } else if (!hasShrinkwrap) {
      const top = compareTopLevel(pkg.dependencies ?? {}, versions, platform, arch)
      problems1.push(...top.problems)
      notes1.push('no shrinkwrap in the tarball: only the direct dependencies are pinned')
    }
    const native = claudeNativePackage(platform, arch)
    const nativeLoc = [`node_modules/${native}`, `node_modules/${native}-musl`].find((l) => tree.has(l))
    if (!nativeLoc) problems1.push(`this platform's Claude runtime (${native}) is not installed`)
    let info
    try {
      info = JSON.parse(fs.readFileSync(path.join(layout.packageDir, 'out', 'cli', 'install.json'), 'utf8'))
    } catch {
      info = undefined
    }
    if (info?.channel !== 'npm' || info?.version !== version) problems1.push(`out/cli/install.json is ${JSON.stringify(info)}`)
    if (allowlistProblem) problems1.push(allowlistProblem)
    else {
      const unlisted = unlistedInstallScripts(new Map([...tree].map(([k, v]) => [k, { ...v.manifest, hasBindingGyp: v.hasBindingGyp }])), allowlist)
      for (const u of unlisted) problems1.push(`${u.name}@${u.version} runs ${u.scripts.join(', ')} at install and is not in ${ALLOWLIST_FILE}`)
    }
    report(
      '(1) install',
      problems1.length === 0 ? 'ok' : 'fail',
      problems1.length
        ? problems1.join('; ')
        : `${tree.size} packages ${shrinkwrap ? `match the shrinkwrap for ${platform}-${arch}` : 'installed'}; ${native} present; no unlisted install scripts${notes1.length ? ` (${notes1.join('; ')})` : ''}`
    )

    // (1b) --ignore-scripts, only when nothing needs a script and step 1 passed: a second full install after a failed
    // step 1 (most often npm installing every platform's Claude runtime from the shrinkwrap, about 2 GB) only repeats
    // that download for a result that is already a failure.
    if (problems1.length > 0) report('(1b) --ignore-scripts', 'skip', 'skipped: step 1 failed, so a second full install would tell nothing new')
    else if (!allowlistProblem && allowlist.length === 0) {
      const prefix2 = path.join(work, 'prefix-ignore-scripts')
      fs.mkdirSync(prefix2)
      const r = await npmInstall(prefix2, ['--ignore-scripts'])
      const bin2 = globalLayout(platform, prefix2).bin
      if (r.code !== 0 || !fs.existsSync(bin2)) report('(1b) --ignore-scripts', 'fail', `npm install -g --ignore-scripts failed: ${showRun(r)}`)
      else {
        const v = await orgaiAt(bin2, ['--version'], userDataDir)
        const ok = v.code === 0 && versionMatches(v.stdout, version)
        report('(1b) --ignore-scripts', ok ? 'ok' : 'fail', ok ? 'installs and runs without install scripts' : showRun(v))
      }
    } else report('(1b) --ignore-scripts', 'skip', 'the allowlist is not empty: some package needs its install script')

    // (2) --version
    const v = await orgai(['--version'])
    const vOk = v.code === 0 && versionMatches(v.stdout, version) && versionSaysNpm(v.stdout)
    report('(2) --version', vOk ? 'ok' : 'fail', vOk ? v.stdout.trim() : `expected ${version} and "channel npm": ${showRun(v)}`)

    // (3) doctor
    const d = await orgai(['--output-format', 'json', 'doctor'])
    const doc = checkNpmDoctor(d.stdout)
    report('(3) doctor', !d.timedOut && doc.ok ? 'ok' : 'fail', `${doc.ok ? 'install channel npm, no check failed' : doc.problems.join('; ')}${doc.notes.length ? ` (${doc.notes.join('; ')})` : ''}`)

    // (4) Claude runtime --version
    if (!nativeLoc) report('(4) claude runtime', 'fail', `${native} is not installed`)
    else {
      const exe = path.join(layout.packageDir, ...nativeLoc.split('/'), platform === 'win32' ? 'claude.exe' : 'claude')
      const claudeHome = path.join(work, 'claude-config')
      fs.mkdirSync(claudeHome)
      const r = await run({ command: exe, args: ['--version'], cwd: work, env: { ...childEnv, CLAUDE_CONFIG_DIR: claudeHome }, timeoutMs: CHECK_TIMEOUT_MS })
      const ok = r.code === 0 && /\d+\.\d+\.\d+/.test(r.stdout)
      report('(4) claude runtime', ok ? 'ok' : 'fail', ok ? `${path.relative(layout.packageDir, exe)} --version: ${r.stdout.trim()}` : showRun(r))
    }

    // (5) exec: the command hosts itself, no app
    const repo = path.join(work, 'repo')
    fs.mkdirSync(repo)
    let repoOk = true
    try {
      makeFixtureRepo(repo, git)
    } catch (e) {
      repoOk = false
      report('(5) exec', 'fail', `could not make the fixture git repo: ${e.message}`)
    }
    if (repoOk) {
      const r = await orgai(['exec', '--create-project', '--output-format', 'json', EXEC_PROMPT], repo)
      const o = execOutcome(r.stdout)
      const ok = r.code === 0 && o?.outcome === 'completed'
      report('(5) exec', ok ? 'ok' : 'fail', ok ? "exit 0, outcome 'completed' with no app installed" : `expected exit 0 and 'completed', got ${o?.outcome ?? 'none'}: ${showRun(r)}`)
      await cleanupDaemon(userDataDir, { log }).catch(() => {})
    }

    // (6) vault across processes
    const s0 = await orgai(['--output-format', 'json', 'secrets', 'status'])
    if (vaultNotBuilt(s0)) report('(6) vault', 'skip', '`orgai secrets` is not in this build yet (the vault work package is not merged)')
    else {
      const problems6 = []
      const keyDir = path.join(work, 'keys')
      fs.mkdirSync(keyDir, { mode: 0o700 })
      const keyFile = path.join(keyDir, 'vault.key')
      const synthetic = `sk-verify-${randomBytes(18).toString('hex')}`
      proxy = await fakeProxy(synthetic)
      const outputs = [s0]
      const step = async (label, args, extra) => {
        // A mock inproc host uses no OS key store without a key file (Wave 7 review), so every call names this one.
        const r = await orgai([...args], userDataDir, { ...extra, env: { ORGAI_CLI_VAULT_KEY_FILE: keyFile, ...(extra?.env ?? {}) } })
        outputs.push(r)
        if (r.code !== 0) problems6.push(`${label}: ${showRun(r)}`)
        return r
      }
      await step('secrets init', ['secrets', 'init', '--key-file', keyFile])
      // A fresh data folder has no proxy: add one (its id is generated), then store, read and clear its key.
      const added = await step('proxy add', ['--output-format', 'json', 'connections', 'proxy', 'add', '--name', 'verify-npm', '--kind', 'litellm', '--anthropic-url', proxy.url])
      let proxyId
      try {
        proxyId = JSON.parse(added.stdout).id
      } catch {
        // reported below
      }
      if (typeof proxyId !== 'string' || !/^proxy-[0-9a-f]{8}$/.test(proxyId)) {
        problems6.push('proxy add: no proxy id in its answer')
        proxyId = 'proxy-00000000'
      }
      await step('set-secret', ['connections', 'set-secret', proxyId, '--stdin'], { input: `${synthetic}\n` })
      const testState = async () => {
        const r = await orgai(['--output-format', 'json', 'connections', 'test', proxyId], userDataDir, { env: { ORGAI_CLI_VAULT_KEY_FILE: keyFile } })
        outputs.push(r)
        return connectionTestState(r.stdout)
      }
      const connected = await testState()
      if (connected !== 'connected') problems6.push(`a fresh process reads the stored key: expected connected, got ${connected ?? 'no answer'}`)
      const otherKey = path.join(keyDir, 'other.key')
      writeRestrictedKeyFile(otherKey, randomBytes(32))
      const mm = await orgai(['--output-format', 'json', 'secrets', 'status'], userDataDir, { env: { ORGAI_CLI_VAULT_KEY_FILE: otherKey } })
      outputs.push(mm)
      const mmState = vaultState(mm.stdout)
      if (mmState !== 'key-mismatch') problems6.push(`another key file: expected key-mismatch, got ${mmState ?? showRun(mm)}`)
      await step('clear', ['connections', 'set-secret', proxyId, '--clear'])
      const after = await testState()
      if (after !== 'disconnected') problems6.push(`after the delete: expected disconnected, got ${after ?? 'no answer'}`)
      // Never echo a problem that could carry the key: only say that it leaked.
      if (outputs.some((r) => `${r.stdout}${r.stderr}`.includes(synthetic))) {
        problems6.length = 0
        problems6.push('the synthetic key was printed by an orgai command')
      }
      report('(6) vault', problems6.length === 0 ? 'ok' : 'fail', problems6.length ? problems6.join('; ') : `key file vault: stored in one process, read in another (proxy saw ${proxy.hits.authorized} authorized request(s)); key-mismatch and delete as expected`)
    }

    // (8) the CLI's own data folder: a fresh install marks it for the CLI; the app's ORGAI_DATA_DIR changed nothing
    {
      const problems8 = []
      try {
        const marker = JSON.parse(fs.readFileSync(path.join(userDataDir, 'product.json'), 'utf8'))
        if (marker.product !== 'orgai-cli') problems8.push(`product.json says ${JSON.stringify(marker.product)}, expected "orgai-cli"`)
      } catch (e) {
        problems8.push(`no readable product.json in the CLI data folder (${e.code ?? e.message})`)
      }
      if (fs.readdirSync(decoyAppDir).length > 0) problems8.push(`ORGAI_DATA_DIR was not ignored: ${decoyAppDir} holds ${fs.readdirSync(decoyAppDir).join(', ')}`)
      report('(8) data folder', problems8.length === 0 ? 'ok' : 'fail', problems8.length ? problems8.join('; ') : 'product.json marks the CLI folder (orgai-cli); ORGAI_DATA_DIR was ignored')
    }

    // (7) Codex, bring-your-own
    const codex = env.ORGAI_CODEX_PATH && fs.existsSync(env.ORGAI_CODEX_PATH) ? env.ORGAI_CODEX_PATH : whichOnPath('codex', env, platform)
    if (!codex) report('(7) codex', 'skip', 'no codex on PATH and no ORGAI_CODEX_PATH (Codex is bring-your-own)')
    else {
      const codexHome = path.join(work, 'codex-home')
      fs.mkdirSync(codexHome, { mode: 0o700 })
      const codexEnv = { ...childEnv, CODEX_HOME: codexHome }
      const viaCmd = platform === 'win32' && /\.(cmd|bat)$/i.test(codex)
      const ver = await run({ ...(viaCmd ? launchCommand(platform, codex, ['--version'], env) : { command: codex, args: ['--version'] }), cwd: work, env: codexEnv, timeoutMs: CHECK_TIMEOUT_MS })
      const hs = ver.code === 0 ? await handshake({ ...(viaCmd ? launchCommand(platform, codex, ['app-server'], env) : { command: codex, args: ['app-server'] }), cwd: work, env: codexEnv }) : { ok: false, detail: 'skipped' }
      const ok = ver.code === 0 && hs.ok
      report('(7) codex', ok ? 'ok' : 'fail', ok ? `${codex}: ${ver.stdout.trim()}; ${hs.detail}` : `${codex}: ${ver.code === 0 ? hs.detail : showRun(ver)}`)
    }
  } finally {
    await proxy?.close().catch(() => {})
    await registry?.close().catch(() => {})
    await cleanupDaemon(userDataDir, { log }).catch((e) => log(`Could not check for a leftover host: ${e.message}`))
    if (opts.keep) log(`Kept ${work}`)
    else
      for (const dir of made) {
        try {
          fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
        } catch (e) {
          log(`Could not remove ${dir}: ${e.message}`)
        }
      }
  }
  return finish()

  function finish() {
    const failed = results.filter((r) => r.status === 'fail')
    const skipped = results.filter((r) => r.status === 'skip')
    log(failed.length ? `${failed.length} step(s) failed.` : `All steps passed${skipped.length ? ` (${skipped.length} skipped)` : ''}.`)
    return failed.length ? 1 : 0
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(`verify-npm: ${e?.stack ?? e}`)
      process.exit(1)
    }
  )
}
