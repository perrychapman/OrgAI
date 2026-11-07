import { spawn as nodeSpawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import tls from 'node:tls'
import { log } from './log'

/**
 * The parts of node:tls used here; injectable for tests. Both are feature-detected (trustSystemCertificates skips with
 * a reason when either is missing), never assumed from a version: getCACertificates arrived in Node 22.15 / 23.10 and
 * setDefaultCACertificates in 22.19 / 24.5 (per @types/node 22 for the 22.x minors; the 24.x minor is UNVERIFIED).
 * `orgai doctor` warns below that floor (src/cli/doctor/installChecks.ts node-certs).
 */
export interface CertApi {
  getCACertificates?: (type?: 'default' | 'system' | 'bundled' | 'extra') => string[]
  setDefaultCACertificates?: (certs: string[]) => void
}

export interface CertLogger {
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
}

/** 'pending': the darwin child is still reading; 'applied': the store was consulted (it may have added nothing); 'unavailable': it could not be read. */
export type CertTrustState = 'pending' | 'applied' | 'unavailable'

export interface TrustResult {
  /** Certificates added on top of the defaults. */
  added: number
  /** Set when the defaults were left untouched. */
  skipped?: string
  elapsedMs: number
  state: CertTrustState
}

/** The least of a child process this module uses; a fake in tests. */
export interface CertChild {
  stdout: { on(event: 'data', cb: (chunk: Buffer | string) => void): unknown; on(event: 'error', cb: (e: Error) => void): unknown } | null
  on(event: 'error', cb: (e: Error) => void): unknown
  on(event: 'close', cb: (code: number | null, signal: string | null) => void): unknown
  kill(): unknown
  unref?(): unknown
}
export type CertSpawner = (command: string, args: string[], options: { cwd: string; env: Record<string, string>; stdio: ['ignore', 'pipe', 'ignore']; windowsHide: true }) => CertChild

export interface TrustOptions {
  platform?: NodeJS.Platform
  api?: CertApi
  logger?: CertLogger
  now?: () => number
  spawner?: CertSpawner
  execPath?: string
  /** Where the child's minimal environment is taken from. */
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  maxBytes?: number
  setTimer?: (cb: () => void, ms: number) => unknown
  clearTimer?: (t: unknown) => void
  /** Called once when the darwin read settles. */
  onSettled?: (r: TrustResult) => void
}

/** A darwin read is killed after this long and OrgAI carries on with the default roots (the child costs the main process nothing while it waits). */
export const SYSTEM_CERT_READ_TIMEOUT_MS = 120_000
/** The most the child may print. A Keychain with a few hundred roots is well under 1 MB. */
export const SYSTEM_CERT_MAX_BYTES = 8 * 1024 * 1024

/** Run by `electron -e` with ELECTRON_RUN_AS_NODE=1: prints the system store as a JSON array of PEM strings. */
export const SYSTEM_CERT_SCRIPT = "process.stdout.write(JSON.stringify(require('node:tls').getCACertificates('system')))"

/** The only variables the child gets: what the Keychain read needs, no tokens, no NODE_OPTIONS. */
const CHILD_ENV_KEYS = ['HOME', 'PATH', 'USER', 'LOGNAME', 'TMPDIR', 'SystemRoot', 'windir', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']

export function childEnvFor(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of CHILD_ENV_KEYS) {
    const v = env[k]
    if (typeof v === 'string' && v) out[k] = v
  }
  out.ELECTRON_RUN_AS_NODE = '1'
  return out
}

const PEM_START = '-----BEGIN CERTIFICATE-----'

/** The child's stdout as a list of PEM strings, or null when it is anything else. */
export function parseCertOutput(text: string): string[] | null {
  try {
    const v: unknown = JSON.parse(text)
    if (!Array.isArray(v)) return null
    for (const c of v) if (typeof c !== 'string' || !c.startsWith(PEM_START)) return null
    return v as string[]
  } catch {
    return null
  }
}

let state: CertTrustState = 'pending'
let stopCurrent: (() => void) | null = null

/** What the certificate setup did: hints about TLS failures read this. */
export function systemCertTrust(): CertTrustState {
  return state
}

/** Kills a darwin read that is still running (quit). Safe to call any time. */
export function stopSystemCertRead(): void {
  try {
    stopCurrent?.()
  } catch {
    /* quitting */
  }
}

type Merge = { added: number; skipped?: string; state: CertTrustState; set: boolean }

/** The union of the defaults and the system certificates, set on the main thread. Never throws. */
function mergeAndSet(api: CertApi, system: string[] | null, failure?: string): Merge {
  try {
    if (failure) return { added: 0, skipped: failure, state: 'unavailable', set: false }
    if (typeof api.getCACertificates !== 'function' || typeof api.setDefaultCACertificates !== 'function') {
      return { added: 0, skipped: 'this runtime has no certificate API', state: 'unavailable', set: false }
    }
    const defaults = api.getCACertificates('default')
    const sys = system ?? api.getCACertificates('system')
    if (!Array.isArray(defaults) || !Array.isArray(sys)) return { added: 0, skipped: 'the certificate API returned something unexpected', state: 'unavailable', set: false }
    if (sys.length === 0) return { added: 0, skipped: 'the system store holds no certificates', state: 'applied', set: false }
    const seen = new Set<string>()
    const merged: string[] = []
    for (const cert of [...defaults, ...sys]) {
      if (typeof cert !== 'string' || seen.has(cert)) continue
      seen.add(cert)
      merged.push(cert)
    }
    const added = merged.length - new Set(defaults.filter((c) => typeof c === 'string')).size
    if (added <= 0) return { added: 0, skipped: 'the system store adds nothing to the defaults', state: 'applied', set: false }
    api.setDefaultCACertificates(merged)
    return { added, state: 'applied', set: true }
  } catch (e) {
    return { added: 0, skipped: `could not read or set certificates (${e instanceof Error ? e.message.slice(0, 120) : 'unknown error'})`, state: 'unavailable', set: false }
  }
}

/**
 * Main-process fetches (undici) trust only Node's bundled roots, so a machine behind an inspecting corporate CA
 * installed in the OS store fails with UNABLE_TO_GET_ISSUER_CERT_LOCALLY (issue #16). This sets the default CA list
 * to the defaults (bundled roots plus NODE_EXTRA_CA_CERTS) followed by the system store's extra certificates.
 * Never throws, never shrinks trust: any failure leaves the defaults as they were. Logs counts and timing only,
 * never certificate contents.
 *
 * Windows and Linux read the store synchronously. On macOS `getCACertificates('system')` asks the Security framework
 * to evaluate every Keychain certificate, which can stall (nodejs/node#63313; public reports of 5 s to about 10 s, one of 107 s, anthropics/claude-code#76079), so a child
 * (this executable with ELECTRON_RUN_AS_NODE=1, minimal env) reads it instead: killed after SYSTEM_CERT_READ_TIMEOUT_MS,
 * on quit, or past SYSTEM_CERT_MAX_BYTES of output, and the main thread only merges and sets. Until it finishes
 * (`systemCertTrust()` is 'pending') fetches use the defaults.
 */
export function trustSystemCertificates(options: TrustOptions = {}): TrustResult {
  const platform = options.platform ?? process.platform
  const api = options.api ?? (tls as unknown as CertApi)
  const logger = options.logger ?? log
  const now = options.now ?? (() => performance.now())
  const start = now()
  const say = (kind: 'info' | 'warn', text: string): void => {
    try {
      logger[kind](text)
    } catch {
      /* logging must not break boot */
    }
  }
  const finish = (m: Merge, warn: boolean): TrustResult => {
    const elapsedMs = Math.round((now() - start) * 10) / 10
    state = m.state
    if (m.skipped) say(warn ? 'warn' : 'info', `System certificates not added: ${m.skipped} (${elapsedMs} ms)`)
    else say('info', `System certificates: ${m.added} added to the default trust list in ${elapsedMs} ms`)
    return { added: m.added, skipped: m.skipped, elapsedMs, state: m.state }
  }
  /** Reading failures warn; a store that was read but adds nothing is information. */
  const warnFor = (m: Merge): boolean => m.state === 'unavailable'

  if (platform !== 'darwin') {
    const m = mergeAndSet(api, null)
    return finish(m, warnFor(m))
  }

  state = 'pending'
  stopCurrent = null
  let settled = false
  let child: CertChild | null = null
  let timer: unknown
  const clear = options.clearTimer ?? ((t: unknown) => clearTimeout(t as NodeJS.Timeout))
  const settle = (system: string[] | null, failure?: string): void => {
    if (settled) return
    settled = true
    stopCurrent = null
    if (timer !== undefined) clear(timer)
    try {
      child?.kill()
    } catch {
      /* already gone */
    }
    const m = mergeAndSet(api, system, failure)
    const r = finish(m, warnFor(m))
    try {
      options.onSettled?.(r)
    } catch {
      /* a callback must not break boot */
    }
  }
  stopCurrent = () => settle(null, 'OrgAI quit before the read finished')

  try {
    const spawner = options.spawner ?? (nodeSpawn as unknown as CertSpawner)
    const timeoutMs = options.timeoutMs ?? SYSTEM_CERT_READ_TIMEOUT_MS
    const maxBytes = options.maxBytes ?? SYSTEM_CERT_MAX_BYTES
    child = spawner(options.execPath ?? process.execPath, ['-e', SYSTEM_CERT_SCRIPT], {
      cwd: tmpdir(),
      env: childEnvFor(options.env ?? process.env),
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true
    })
    try {
      child.unref?.()
    } catch {
      /* optional */
    }
    child.stdout?.on('error', () => undefined) // a broken pipe must not surface as an unhandled error; 'close' settles
    const chunks: Buffer[] = []
    let bytes = 0
    child.stdout?.on('data', (chunk) => {
      if (settled) return
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      bytes += buf.length
      if (bytes > maxBytes) settle(null, 'the certificate reader printed too much output')
      else chunks.push(buf)
    })
    child.on('error', (e) => settle(null, `could not start the certificate reader (${e?.message ? String(e.message).slice(0, 120) : 'unknown error'})`))
    child.on('close', (code, signal) => {
      if (settled) return
      if (code !== 0) return settle(null, `the certificate reader exited with ${code ?? signal ?? 'no code'}`)
      const parsed = parseCertOutput(Buffer.concat(chunks).toString('utf8'))
      if (!parsed) return settle(null, 'the certificate reader printed something unexpected')
      settle(parsed)
    })
    const setT = options.setTimer ?? ((cb: () => void, ms: number) => setTimeout(cb, ms))
    timer = setT(() => settle(null, `the certificate reader took longer than ${timeoutMs / 1000} s`), timeoutMs)
    if (!settled) (timer as { unref?: () => void } | undefined)?.unref?.()
  } catch (e) {
    settle(null, `could not start the certificate reader (${e instanceof Error ? e.message.slice(0, 120) : 'unknown error'})`)
  }
  return { added: 0, elapsedMs: Math.round((now() - start) * 10) / 10, state }
}
