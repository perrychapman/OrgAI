/**
 * Integration (Wave 7, the flow of verify-npm step 6): the real CLI bundle, `--host inproc`, the real SecretStore and
 * the real key-file custodian, a LiteLLM connection at a fake proxy on 127.0.0.1. `secrets init --key-file`, a key set
 * through stdin in one process and tested in a fresh one (connected, so the vault was read across processes), another
 * key file reading as key-mismatch, and the key cleared (disconnected). No tokens, no OS key store.
 *
 * Needs the built bundle (`npm run build`): skipped when out/cli/orgai.mjs is missing, a failure when
 * ORGAI_REQUIRE_NODE_HOST_INT=1. POSIX only.
 */
import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const bundle = resolve(here, '..', '..', 'out', 'cli', 'orgai.mjs')
const posix = process.platform !== 'win32'
const required = process.env.ORGAI_REQUIRE_NODE_HOST_INT === '1'

let work: string
let data: string
let keys: string
let proxy: Server | undefined
const hits = { authorized: 0, refused: 0 }

beforeEach(() => {
  work = realpathSync(mkdtempSync(join(posix ? '/tmp' : tmpdir(), 'wpv-')))
  data = join(work, 'data')
  keys = join(work, 'keys')
  mkdirSync(data)
  mkdirSync(keys, { mode: 0o700 })
  hits.authorized = 0
  hits.refused = 0
})
afterEach(async () => {
  await new Promise<void>((r) => (proxy ? proxy.close(() => r()) : r()))
  proxy = undefined
  rmSync(work, { recursive: true, force: true })
})

function startProxy(key: string): Promise<string> {
  proxy = createServer((req, res) => {
    const auth = String(req.headers.authorization ?? '')
    const given = auth.startsWith('Bearer ') ? auth.slice(7) : String(req.headers['x-api-key'] ?? '')
    const url = String(req.url ?? '').split('?')[0]
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (req.method !== 'GET' || (url !== '/v1/models' && url !== '/model/info')) return send(404, { error: 'not found' })
    if (given !== key) {
      hits.refused += 1
      return send(401, { error: { message: 'invalid key' } })
    }
    hits.authorized += 1
    if (url === '/model/info') return send(200, { data: [{ model_name: 'vault-int', model_info: { mode: 'chat' } }] })
    return send(200, { object: 'list', data: [{ id: 'vault-int', object: 'model' }] })
  })
  return new Promise((r) => proxy!.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(proxy!.address() as { port: number }).port}`)))
}

interface Ran {
  code: number | null
  stdout: string
  stderr: string
}
function orgai(args: string[], extra: { input?: string; env?: Record<string, string> } = {}): Promise<Ran> {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ORGAI_')) env[k] = v
  Object.assign(env, { ORGAI_DATA_DIR: data, ORGAI_MOCK: '1', NO_COLOR: '1', ORGAI_VAULT_KEY_FILE: join(keys, 'vault.key'), ...(extra.env ?? {}) })
  return new Promise((res) => {
    const c = spawn(process.execPath, [bundle, '--host', 'inproc', ...args], { env })
    let stdout = ''
    let stderr = ''
    c.stdout.on('data', (d: Buffer) => (stdout += d))
    c.stderr.on('data', (d: Buffer) => (stderr += d))
    c.on('close', (code) => res({ code, stdout, stderr }))
    c.stdin.end(extra.input ?? '')
  })
}
const json = (r: Ran): Record<string, unknown> => JSON.parse(r.stdout) as Record<string, unknown>

describe.runIf(posix && required)('vault CLI bundle (CI after the build)', () => {
  it('out/cli/orgai.mjs is built', () => {
    expect(existsSync(bundle)).toBe(true)
  })
})

describe.skipIf(!posix || !existsSync(bundle))('the vault across CLI processes (real bundle, real custodian)', () => {
  it('init --key-file, set in one process, read in another, key-mismatch with another key, cleared', async () => {
    const synthetic = `sk-verify-${randomBytes(18).toString('hex')}`
    const url = await startProxy(synthetic)
    const keyFile = join(keys, 'vault.key')
    const all: Ran[] = []
    const step = async (args: string[], extra?: { input?: string; env?: Record<string, string> }): Promise<Ran> => {
      const r = await orgai(args, extra)
      all.push(r)
      return r
    }

    const before = await step(['--output-format', 'json', 'secrets', 'status'])
    expect(before.code).toBe(0)
    expect((json(before).secrets as { state: string }).state).toBe('absent')
    expect((await step(['secrets', 'init', '--key-file', keyFile])).code).toBe(0)
    expect(existsSync(join(data, 'data', 'vault.json'))).toBe(true)
    // A fresh data folder has no proxy: add one (its id is generated).
    const added = await step(['--output-format', 'json', 'connections', 'proxy', 'add', '--name', 'vault cli', '--kind', 'litellm', '--anthropic-url', url])
    expect(added.code).toBe(0)
    const proxyId = json(added).id as string
    expect(proxyId).toMatch(/^proxy-[0-9a-f]{8}$/)
    expect((await step(['connections', 'set-secret', proxyId, '--stdin'], { input: `${synthetic}\n` })).code).toBe(0)
    // The key is in secure storage, not in secrets.json.
    expect(existsSync(join(data, 'data', 'secrets.json')) ? readFileSync(join(data, 'data', 'secrets.json'), 'utf8') : '').not.toContain(synthetic)

    const connected = await step(['--output-format', 'json', 'connections', 'test', proxyId])
    expect(json(connected).status).toBe('connected')
    expect(hits.authorized).toBeGreaterThan(0)

    const otherKey = join(keys, 'other.key')
    writeFileSync(otherKey, randomBytes(32), { mode: 0o600 })
    chmodSync(otherKey, 0o600)
    const mismatch = await step(['--output-format', 'json', 'secrets', 'status'], { env: { ORGAI_VAULT_KEY_FILE: otherKey } })
    expect((json(mismatch).secrets as { state: string }).state).toBe('key-mismatch')

    expect((await step(['connections', 'set-secret', proxyId, '--clear'])).code).toBe(0)
    const after = await step(['--output-format', 'json', 'connections', 'test', proxyId])
    expect(json(after).status).toBe('disconnected')
    // No command printed the key.
    expect(all.some((r) => `${r.stdout}${r.stderr}`.includes(synthetic))).toBe(false)
  }, 120_000)
})
