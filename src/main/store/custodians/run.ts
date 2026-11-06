/**
 * Running one custodian helper (cli-standalone.md 5.3): an absolute executable, `shell: false`, `cwd: os.tmpdir()`,
 * values only on stdin / stdout, CUSTODIAN_TIMEOUT_MS, the caller's allowlisted environment, and the child registered
 * with host/shutdown.ts trackChildProcess so a host at its hard limit kills it. stderr is kept only in memory for
 * classification (callers reduce it to a CustodyFailure) and never logged. Electron-free; relative imports only.
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { isAbsolute as posixIsAbsolute } from 'node:path/posix'
import { isAbsolute as win32IsAbsolute } from 'node:path/win32'
import { tmpdir } from 'node:os'
import type { Readable, Writable } from 'node:stream'
import { trackChildProcess } from '../../host/shutdown'
import { CUSTODIAN_TIMEOUT_MS } from '../vaultTypes'

/** What runHelper needs of a child (a ChildProcess fits; tests pass fakes). */
export interface CustodianChild {
  readonly pid?: number
  readonly stdin: Writable | null
  readonly stdout: Readable | null
  readonly stderr: Readable | null
  kill(signal?: NodeJS.Signals | number): boolean
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  once(event: 'error', listener: (err: Error) => void): unknown
  once(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
}

export interface CustodianSpawnOptions {
  cwd: string
  env: Record<string, string>
  shell: false
  windowsHide: true
  stdio: ['pipe', 'pipe', 'pipe']
}

/** child_process.spawn's shape for custodian helpers; tests inject fakes. */
export type CustodianSpawner = (file: string, args: readonly string[], options: CustodianSpawnOptions) => CustodianChild

export const defaultSpawner: CustodianSpawner = (file, args, options) => nodeSpawn(file, [...args], options) as unknown as CustodianChild

/** stdout above this kills the helper (a key or a DPAPI blob is a few hundred bytes). */
export const HELPER_STDOUT_MAX = 64 * 1024
/** stderr kept for classification. */
export const HELPER_STDERR_MAX = 4 * 1024

export interface HelperResult {
  /** Exit code; null when killed or never started. */
  code: number | null
  stdout: Buffer
  /** At most HELPER_STDERR_MAX bytes, for classification only. Never log it. */
  stderr: string
  timedOut: boolean
  /** Set when the helper could not be started (ENOENT, EACCES...) or its pipes failed. */
  spawnError?: NodeJS.ErrnoException
  /** stdout went over HELPER_STDOUT_MAX and the helper was killed. */
  overflow: boolean
}

export interface RunHelperOptions {
  spawner: CustodianSpawner
  env: Record<string, string>
  /** Written to stdin, then stdin is closed. Omitted: stdin is closed at once. */
  stdin?: string | Buffer
  timeoutMs?: number
  /** Registry label (`custodian:<scheme>`). */
  label: string
  platform?: NodeJS.Platform
}

/** True for an absolute path on `platform` (a bare name is never run: Windows searches the cwd first). */
export function isAbsoluteExecutable(file: string, platform: NodeJS.Platform = process.platform): boolean {
  if (!file || file.includes('\0')) return false
  return platform === 'win32' ? /^[A-Za-z]:[\\/]/.test(file) && win32IsAbsolute(file) : posixIsAbsolute(file)
}

/** Runs one helper to completion. Never rejects: every failure is in the result. */
export function runHelper(file: string, args: readonly string[], opts: RunHelperOptions): Promise<HelperResult> {
  const timeoutMs = opts.timeoutMs ?? CUSTODIAN_TIMEOUT_MS
  return new Promise<HelperResult>((resolve) => {
    if (!isAbsoluteExecutable(file, opts.platform)) {
      const err = Object.assign(new Error('not an absolute executable path'), { code: 'ENOENT' }) as NodeJS.ErrnoException
      resolve({ code: null, stdout: Buffer.alloc(0), stderr: '', timedOut: false, spawnError: err, overflow: false })
      return
    }
    let child: CustodianChild
    try {
      child = opts.spawner(file, args, { cwd: tmpdir(), env: opts.env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (e) {
      resolve({ code: null, stdout: Buffer.alloc(0), stderr: '', timedOut: false, spawnError: e as NodeJS.ErrnoException, overflow: false })
      return
    }
    const untrack = trackChildProcess(child, opts.label)
    const out: Buffer[] = []
    let outLen = 0
    let err = ''
    let timedOut = false
    let overflow = false
    let spawnError: NodeJS.ErrnoException | undefined
    let done = false
    const finish = (code: number | null): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      untrack()
      const stdout = Buffer.concat(out)
      for (const b of out) b.fill(0)
      resolve({ code, stdout, stderr: err, timedOut, overflow, ...(spawnError ? { spawnError } : {}) })
    }
    const kill = (): void => {
      try {
        child.kill('SIGKILL')
      } catch {
        // Already gone.
      }
    }
    const timer = setTimeout(() => {
      timedOut = true
      kill()
      // A child that never reports 'close' after SIGKILL must not hold the caller forever.
      setTimeout(() => finish(null), 1_000).unref?.()
    }, timeoutMs)
    timer.unref?.()

    child.stdout?.on('data', (chunk: Buffer | string) => {
      const b = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      outLen += b.length
      if (outLen > HELPER_STDOUT_MAX) {
        overflow = true
        kill()
        return
      }
      out.push(Buffer.from(b))
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      if (err.length >= HELPER_STDERR_MAX) return
      err = (err + String(chunk)).slice(0, HELPER_STDERR_MAX)
    })
    child.once('error', (e: Error) => {
      spawnError = e as NodeJS.ErrnoException
      finish(null)
    })
    child.once('close', (code: number | null) => finish(code))

    const stdin = child.stdin
    if (stdin) {
      // EPIPE when the helper exits before reading: the exit code tells what happened.
      stdin.on('error', () => undefined)
      try {
        if (opts.stdin !== undefined) stdin.end(opts.stdin)
        else stdin.end()
      } catch {
        // The 'close' / 'error' handlers settle the result.
      }
    }
  })
}

/** The helper output as text (stdout is ASCII for every helper: base64, hex, markers). */
export function stdoutText(r: HelperResult): string {
  return r.stdout.toString('utf8')
}

/** A vault id: VAULT_ID_BYTES random bytes in lowercase or uppercase hex (it goes into helper argv and stdin). */
export function isVaultId(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-fA-F]{32}$/.test(v)
}

/** Strict base64 of exactly 32 bytes (44 characters, one '=' pad), else undefined. */
export function decodeKeyBase64(text: string): Buffer | undefined {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(text)) return undefined
  const b = Buffer.from(text, 'base64')
  if (b.length !== 32) {
    b.fill(0)
    return undefined
  }
  return b
}

/** Strict base64 (standard alphabet, padded); the DPAPI blob read back from vault.json is checked with it. */
export function isStrictBase64(text: string, maxLength = 64 * 1024): boolean {
  return text.length > 0 && text.length <= maxLength && text.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(text)
}
