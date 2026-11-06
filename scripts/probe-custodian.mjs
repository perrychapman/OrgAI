#!/usr/bin/env node
/**
 * Token-free key custodian probe (cli-standalone.md 5.3). Spends no model tokens and uses no network, but it DOES write
 * to this user's OS key store (the macOS login keychain, the Linux desktop keyring) or creates a key file, so run it
 * only with the user's consent, once per check (never in a loop).
 *
 * What it does, with a throwaway vault id (16 random bytes, never an OrgAI vault's):
 *   1. probe()  - can a key be created and read now? (reports ok / locked / missing / unavailable / denied / timeout)
 *   2. create() - makes one item (keychain: generic password service "OrgAI Vault", account <id>; secret-service:
 *                 attributes service orgai vault <id>; dpapi-user: a DPAPI blob, nothing stored in the OS; key-file:
 *                 a new file in a temp folder unless --key-file is given)
 *   3. open()   - in a FRESH node process (the custody record goes over the child's stdin), which prints only the
 *                 sha256 of the key, never the key; the parent compares it with its own
 *   4. removeItem() - deletes the item again in a finally block, whatever happened before: for the OS stores
 *                 (keychain, secret-service) always, because create() can store the item and then fail (a read-back
 *                 that times out at an unlock prompt, a key mismatch), with 'missing' counted as fine; for key-file only
 *                 when this run created the file (a file given with --key-file that already existed is never touched)
 * It also reports how a missing item reads: open() on a second throwaway id that was never created. On macOS it records
 * the raw answers of `security default-keychain` and `security show-keychain-info <default keychain>` (exit codes and
 * the non-secret settings line), so a run with the login keychain locked (over SSH, or after `security lock-keychain`)
 * shows what a locked keychain returns.
 *
 * Nothing it prints holds a key: only step results, failure kinds, the custodian's reason sentences and timings. The
 * custodian code is bundled from src/main/store/custodians/index.ts with esbuild into a temp folder (deleted at the end).
 *
 * What it can confirm (each is UNVERIFIED until it has run on that platform): macOS `security -i -q` reading the add
 * command from a pipe, the exit codes for a missing item, no prompt for an item `security` created, the locked wording
 * over SSH; Windows PowerShell DPAPI scripts and latency; Linux secret-tool search / store / lookup and their exit codes.
 *
 * Usage: node scripts/probe-custodian.mjs [--scheme keychain|dpapi-user|secret-service|key-file] [--key-file <path>] [--json]
 *   --scheme    default: the platform's OS scheme (key-file when ORGAI_VAULT_KEY_FILE is set)
 *   --key-file  for key-file: the path to create (must not exist; deleted at the end). Default: a temp folder.
 *   --json      print the report as JSON only
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ENTRY = join(ROOT, 'src', 'main', 'store', 'custodians', 'index.ts')
const CHILD_TIMEOUT_MS = 30_000

function arg(name) {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const sha = (buf) => createHash('sha256').update(buf).digest('hex')

async function bundle(dir) {
  const { build } = await import('esbuild')
  const out = join(dir, 'custodians.mjs')
  await build({ entryPoints: [ENTRY], bundle: true, platform: 'node', format: 'esm', target: 'node20', outfile: out, logLevel: 'silent' })
  return out
}

/** The custodian for this run: fake data folders in the temp dir so a key file is never inside a real one. */
function makeCustodian(mod, work, scheme, keyFile) {
  const opts = {
    dataDir: join(work, 'userData', 'data'),
    userDataDir: join(work, 'userData'),
    env: process.env,
    ...(keyFile ? { keyFile } : {})
  }
  return mod.createCustodian(scheme, opts)
}

function failureOf(e) {
  if (e && typeof e === 'object' && typeof e.kind === 'string' && typeof e.reason === 'string') return { ok: false, kind: e.kind, reason: e.reason }
  return { ok: false, kind: 'error', reason: String(e?.message ?? e).slice(0, 300) }
}

async function step(report, name, fn) {
  const t = Date.now()
  try {
    const value = await fn()
    report.steps.push({ step: name, ok: true, ms: Date.now() - t, ...(value && typeof value === 'object' && !Buffer.isBuffer(value) ? value : {}) })
    return value
  } catch (e) {
    report.steps.push({ step: name, ms: Date.now() - t, ...failureOf(e) })
    return undefined
  }
}

/** Child mode: open the key with the custody record from stdin and print only its sha256. */
async function childOpen() {
  const bundlePath = arg('--bundle')
  const chunks = []
  for await (const c of process.stdin) chunks.push(c)
  const { scheme, vaultId, custody, work, keyFile } = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  const mod = await import(pathToFileURL(bundlePath).href)
  const c = makeCustodian(mod, work, scheme, keyFile)
  try {
    const key = await c.open(vaultId, custody)
    process.stdout.write(JSON.stringify({ ok: true, sha256: sha(key), bytes: key.length }))
    key.fill(0)
  } catch (e) {
    process.stdout.write(JSON.stringify(failureOf(e)))
  }
}

function openInFreshProcess(bundlePath, payload) {
  return new Promise((resolveOpen) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--child-open', '--bundle', bundlePath], {
      cwd: tmpdir(),
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true
    })
    let out = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), CHILD_TIMEOUT_MS)
    child.stdout.on('data', (c) => (out += c))
    child.on('error', (e) => resolveOpen({ ok: false, kind: 'error', reason: String(e.message) }))
    child.on('close', (code) => {
      clearTimeout(timer)
      try {
        resolveOpen(JSON.parse(out))
      } catch {
        resolveOpen({ ok: false, kind: 'error', reason: `child exited ${code} without a result` })
      }
    })
    child.stdin.end(JSON.stringify(payload))
  })
}

/** The raw keychain answers the probe classifies (no item is read; show-keychain-info prints only settings). */
function keychainInfo() {
  const run = (args) => {
    const r = spawnSync('/usr/bin/security', args, { cwd: tmpdir(), encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] })
    return { args: args.join(' '), exit: r.status, signal: r.signal ?? undefined, stdout: (r.stdout ?? '').trim().slice(0, 200), stderr: (r.stderr ?? '').trim().slice(0, 200) }
  }
  const def = run(['default-keychain'])
  const m = /^\s*"(\/[^"]*)"\s*$/.exec(def.stdout)
  return { defaultKeychain: def, showKeychainInfo: m ? run(['show-keychain-info', m[1]]) : 'no default keychain path', bareShowKeychainInfo: run(['show-keychain-info']) }
}

async function main() {
  if (process.argv.includes('--child-open')) return childOpen()
  const jsonOnly = process.argv.includes('--json')
  const work = mkdtempSync(join(tmpdir(), 'orgai-custodian-probe-'))
  const report = { platform: process.platform, scheme: null, vaultId: null, steps: [] }
  try {
    const bundlePath = await bundle(work)
    const mod = await import(pathToFileURL(bundlePath).href)
    const scheme = arg('--scheme') ?? mod.chooseCustodyScheme({ env: process.env, platform: process.platform })
    if (!scheme) throw new Error(`No OS key scheme on ${process.platform}; try --scheme key-file`)
    const keyFile = scheme === 'key-file' ? (arg('--key-file') ?? join(work, 'keys', 'probe.key')) : undefined
    if (keyFile && !arg('--key-file')) (await import('node:fs')).mkdirSync(dirname(keyFile), { recursive: true, mode: 0o700 })
    report.scheme = scheme
    const vaultId = randomBytes(16).toString('hex')
    report.vaultId = vaultId
    const custodian = makeCustodian(mod, work, scheme, keyFile)
    const osStore = scheme === 'keychain' || scheme === 'secret-service'
    let custody = { scheme, ...(keyFile ? { keyFile } : {}) }
    let fileCreated = false

    try {
      if (scheme === 'keychain' && process.platform === 'darwin') {
        await step(report, 'keychain-info', async () => keychainInfo())
      }

      await step(report, 'probe', async () => {
        const p = await custodian.probe()
        if (!p.ok) throw p
        return {}
      })

      let dekHash
      const created = await step(report, 'create', async () => {
        const { dek, wrapped, keyFile: createdKeyFile } = await custodian.create(vaultId)
        if (scheme === 'key-file') fileCreated = true
        dekHash = sha(dek)
        dek.fill(0)
        if (wrapped) custody = { ...custody, wrapped }
        // The path create() names for custody.keyFile (the canonical spelling), as the store records it.
        if (scheme === 'key-file') custody = { ...custody, keyFile: createdKeyFile ?? custodian.canonicalPath() }
        return { bytes: 32, wrapped: wrapped ? `${wrapped.length} chars` : undefined }
      })

      if (created !== undefined) {
        await step(report, 'create-again-refused', async () => {
          try {
            const again = await custodian.create(vaultId)
            again.dek.fill(0)
          } catch (e) {
            return { refused: true, ...failureOf(e), ok: true }
          }
          // dpapi-user stores nothing in the OS, so a second create is expected to succeed there.
          return { refused: false }
        })
        await step(report, 'open-fresh-process', async () => {
          const r = await openInFreshProcess(bundlePath, { scheme, vaultId, custody, work, keyFile })
          if (!r.ok) throw r
          return { sameKey: r.sha256 === dekHash, bytes: r.bytes }
        })
      }

      await step(report, 'open-missing-item', async () => {
        const other = randomBytes(16).toString('hex')
        const missingCustody = scheme === 'key-file' ? { scheme, keyFile: join(work, 'keys', 'never.key') } : { scheme, ...(custody.wrapped ? { wrapped: 'AAAA' } : {}) }
        try {
          const k = await makeCustodian(mod, work, scheme, scheme === 'key-file' ? missingCustody.keyFile : undefined).open(other, missingCustody)
          k.fill(0)
          return { unexpected: 'opened' }
        } catch (e) {
          return { reportedAs: failureOf(e).kind, reason: failureOf(e).reason }
        }
      })
    } finally {
      // An OS store may hold the item even when create() failed after storing it; a key file is removed only when this
      // run made it. dpapi-user stores nothing.
      if (osStore || fileCreated) {
        await step(report, 'remove', async () => {
          try {
            await custodian.removeItem(vaultId, custody)
          } catch (e) {
            if (e && e.kind === 'missing') return { wasThere: false }
            throw e
          }
          return {}
        })
      }
    }
  } catch (e) {
    report.steps.push({ step: 'setup', ...failureOf(e) })
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
  if (jsonOnly) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } else {
    console.log(`Custodian probe on ${report.platform}, scheme ${report.scheme ?? '(none)'}, throwaway vault id ${report.vaultId ?? '-'}`)
    for (const s of report.steps) {
      const { step: name, ok, ms, ...rest } = s
      console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name} (${ms ?? 0} ms) ${JSON.stringify(rest)}`)
    }
  }
  process.exitCode = report.steps.some((s) => !s.ok) ? 1 : 0
}

await main()
