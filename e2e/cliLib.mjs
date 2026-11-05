// Shared helpers of the Wave 5 CLI e2e scripts (cli-projects, cli-org, cli-connections, cli-mcp, cli-skills-kit).
// Run `npm run build` first. Mock adapter only (ORGAI_MOCK=1): no tokens, no network. Every host is `--host inproc`
// (a pure-Node host in a CLI process); `startDaemon()` keeps one alive for the script. `hostRpc` is a raw
// authenticated JSON-RPC client in plain JS, so a script can seed state (e.g. engagement projects) without depending
// on another task's commands.
import { spawn } from 'node:child_process'
import { createHmac, randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as net from 'node:net'
import * as path from 'node:path'
import { APP_DIR, DATA_DIR, sleep } from './lib.mjs'

process.env.ORGAI_MOCK = '1'

export const CLI = path.join(APP_DIR, 'out', 'cli', 'orgai.mjs')
/** `<userDataDir>/data`: where the host keeps run/daemon.json and run/daemon.secret. */
export const HOST_DATA_DIR = path.join(DATA_DIR, 'data')
export const DAEMON_JSON = path.join(HOST_DATA_DIR, 'run', 'daemon.json')
export const DAEMON_SECRET = path.join(HOST_DATA_DIR, 'run', 'daemon.secret')

export const ENV = { ...process.env, ORGAI_DATA_DIR: DATA_DIR, ORGAI_MOCK: '1', NO_COLOR: '1' }
delete ENV.ELECTRON_RUN_AS_NODE

const PACKAGE_VERSION = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version

/** Exit 1 with a hint when the CLI bundle is missing. */
export function requireBuild() {
  if (!fs.existsSync(CLI)) {
    console.log('out/cli/orgai.mjs missing. Run `npm run build` first.')
    process.exit(1)
  }
}

/** Start the CLI (always --no-color); returns { child, done } where done resolves { code, signal, out, err }. */
export function startCli(args, { cwd = APP_DIR, input, env } = {}) {
  const stdin = input === undefined ? 'ignore' : 'pipe'
  const child = spawn(process.execPath, [CLI, '--no-color', ...args], { cwd, env: { ...ENV, ...env }, stdio: [stdin, 'pipe', 'pipe'] })
  let out = ''
  let err = ''
  child.stdout.on('data', (d) => (out += d))
  child.stderr.on('data', (d) => (err += d))
  if (input !== undefined) {
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  }
  const done = new Promise((resolve) => {
    child.on('close', (code, signal) => resolve({ code: code ?? (signal ? 128 : 1), signal, out, err }))
  })
  return { child, done }
}

/** Run the CLI to the end (SIGKILL after timeoutMs). Resolves { code, out, err }. stdin is piped only with `input`. */
export async function cli(args, { cwd, input, env, timeoutMs = 90_000 } = {}) {
  const { child, done } = startCli(args, { cwd, input, env })
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
  const r = await done
  clearTimeout(timer)
  return { code: r.code, out: r.out, err: r.err }
}

/** JSON.parse, or null. */
export function json(s) {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

/** A one-line summary of a CLI result for check() details. */
export const show = (r) => `exit ${r.code} ${r.out.slice(-400)} ${r.err.slice(-400)}`

export async function until(what, fn, ms = 30_000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = await fn()
    if (v) return v
    await sleep(250)
  }
  throw new Error(`timed out waiting for ${what}`)
}

export const readDaemon = () => json(fs.existsSync(DAEMON_JSON) ? fs.readFileSync(DAEMON_JSON, 'utf8') : '')

let daemon
/** `daemon start --host inproc --foreground` (kept running), resolved once daemon.json says 'ready'. */
export async function startDaemon({ cwd = APP_DIR } = {}) {
  daemon = startCli(['--host', 'inproc', 'daemon', 'start', '--foreground'], { cwd })
  let exited
  daemon.done.then((r) => (exited = r))
  await until('the inproc daemon to be ready', () => {
    if (exited) throw new Error(`the inproc daemon exited early: ${show(exited)}`)
    return readDaemon()?.state === 'ready'
  })
  return daemon
}

/** `daemon stop --force`, then wait for daemon.json to go (and the foreground process to end). */
export async function stopDaemon() {
  const r = await cli(['daemon', 'stop', '--force'], { timeoutMs: 30_000 })
  await until('daemon.json to go', () => !fs.existsSync(DAEMON_JSON), 30_000).catch(() => undefined)
  if (daemon) {
    const left = await Promise.race([daemon.done, sleep(10_000).then(() => null)])
    if (!left) daemon.child.kill('SIGKILL')
    daemon = undefined
  }
  return r
}

const hmac = (secretHex, transcript) => createHmac('sha256', Buffer.from(secretHex, 'hex')).update(JSON.stringify(transcript), 'utf8').digest('hex')

/**
 * One authenticated JSON-RPC call on its own connection (host.challenge -> host.hello with the client:v1 proof of
 * src/main/host/protocol.ts -> the request). clientVersion is package.json's, so 'configure' is not skew-limited.
 * Resolves the result; rejects with the error data ({ code, message }).
 */
export function hostRpc(method, params = [], scopes = ['read', 'operate', 'decide', 'configure'], { timeoutMs = 60_000, cwd = APP_DIR } = {}) {
  const info = readDaemon()
  if (!info?.endpoint) return Promise.reject({ code: 'no_host', message: 'No daemon.json; start a host first.' })
  const secret = fs.readFileSync(DAEMON_SECRET, 'utf8').trim()
  return new Promise((resolve, reject) => {
    const socket = net.connect(info.endpoint)
    let buf = ''
    let step = 'challenge'
    let clientNonce
    let hostNonce
    const timer = setTimeout(() => finish(reject, { code: 'timeout', message: `${method} did not answer in ${timeoutMs} ms` }), timeoutMs)
    function finish(fn, v) {
      clearTimeout(timer)
      socket.destroy()
      fn(v)
    }
    const send = (msg) => socket.write(`${JSON.stringify(msg)}\n`)
    socket.on('error', (e) => finish(reject, { code: 'socket', message: e.message }))
    socket.on('close', () => finish(reject, { code: 'closed', message: `the host closed the connection during ${step}` }))
    socket.on('data', (d) => {
      buf += d
      let nl
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (!line.trim()) continue
        const msg = json(line)
        if (!msg) return finish(reject, { code: 'bad_frame', message: line.slice(0, 200) })
        if (step === 'challenge' && msg.method === 'host.challenge') {
          hostNonce = msg.params.hostNonce
          clientNonce = randomBytes(32).toString('hex')
          const base = { protocolVersion: 1, clientKind: 'cli', clientVersion: PACKAGE_VERSION, pid: process.pid, cwd, clientNonce, requestedScopes: [...scopes] }
          const clientProof = hmac(secret, ['client:v1', base.protocolVersion, info.hostInstanceId, hostNonce, clientNonce, base.clientKind, base.clientVersion, base.pid, base.cwd, base.requestedScopes])
          step = 'hello'
          send({ jsonrpc: '2.0', id: 1, method: 'host.hello', params: { ...base, clientProof } })
        } else if (step === 'hello' && msg.id === 1) {
          if (msg.error) return finish(reject, msg.error.data ?? { code: 'hello', message: msg.error.message })
          const h = msg.result
          const expected = hmac(secret, ['host:v1', h.protocolVersion, h.hostInstanceId, clientNonce, hostNonce, h.hostKind, h.appVersion, h.dataDir, h.mock, h.grantedScopes])
          if (expected !== h.hostProof) return finish(reject, { code: 'auth_failed', message: 'host proof did not verify' })
          step = 'call'
          send({ jsonrpc: '2.0', id: 2, method, params })
        } else if (step === 'call' && msg.id === 2) {
          if (msg.error) return finish(reject, msg.error.data ?? { code: 'rpc', message: msg.error.message })
          return finish(resolve, msg.result)
        }
        // Anything else (notifications) is skipped.
      }
    })
  })
}

/** Create an OrgAI project on the mock adapter at `dir` over hostRpc (kind 'code' or 'engagement'). Resolves the Project. */
export function seedProject(dir, { name = path.basename(dir), kind = 'code', brief = '' } = {}) {
  return hostRpc('projects:create', [{ name, path: dir, brief, kind, mock: true }])
}
