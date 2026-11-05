/**
 * Host socket wire protocol (cli-spec 3.3): handshake proofs, line framing and JSON-RPC 2.0 shapes. Shared by the
 * host's socket server (socketServer.ts) and the CLI's host client (src/cli). Electron-free, relative imports only, no
 * state beyond the LineReader instances callers own.
 *
 * Error codes: JSON-RPC wants a numeric `error.code`, so the host's string code (HostRpcErrorCode) always rides in
 * `error.data.code` and `error.code` is RPC_NUMERIC_CODE of it (unknown_channel -32601, bad_request -32602, anything
 * else -32000; an unparsable frame is -32700 with data.code 'bad_request'). Clients read `error.data.code`. This is a
 * deliberate deviation from the spec's string `error.code`.
 */
import { execFile } from 'node:child_process'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import { join } from 'node:path'
import {
  RPC_PRE_AUTH_FRAME_MAX_BYTES,
  type HostClientKind,
  type HostKind,
  type HostRpcError,
  type HostRpcErrorCode,
  type HostScope,
  type RpcChallengeFrame
} from '../../shared/types'
import { parseJsonSafe, stringifyJson } from './jsonCodec'
import { neutralCwd, system32Path } from './systemBinaries'

// ---------- Nonces and proofs ----------

const HEX64_RE = /^[0-9a-f]{64}$/

/** A fresh 32-byte random nonce as 64 lowercase hex chars. */
export function newNonce(): string {
  return randomBytes(32).toString('hex')
}

/** True for a nonce (or proof) of exactly 64 lowercase hex chars. */
export function isHexNonce(v: unknown): v is string {
  return typeof v === 'string' && HEX64_RE.test(v)
}

/** The fields the client proof binds (cli-spec 3.3(2), RpcHelloParams minus the proof, plus the challenge). */
export interface ClientProofFields {
  protocolVersion: number
  hostInstanceId: string
  hostNonce: string
  clientNonce: string
  clientKind: HostClientKind
  clientVersion: string
  pid: number
  cwd: string
  requestedScopes: readonly HostScope[]
}

/** The fields the host proof binds (cli-spec 3.3(2), RpcHelloResult minus the proof, plus both nonces). */
export interface HostProofFields {
  protocolVersion: number
  hostInstanceId: string
  clientNonce: string
  hostNonce: string
  hostKind: HostKind
  appVersion: string
  dataDir: string
  mock: boolean
  grantedScopes: readonly HostScope[]
}

function hmacHex(secretHex: string, transcript: unknown[]): string {
  return createHmac('sha256', Buffer.from(secretHex, 'hex')).update(JSON.stringify(transcript), 'utf8').digest('hex')
}

/**
 * HMAC-SHA256(daemon.secret, JSON.stringify(['client:v1', protocolVersion, hostInstanceId, hostNonce, clientNonce,
 * clientKind, clientVersion, pid, cwd, requestedScopes])) as lowercase hex.
 */
export function clientProof(secretHex: string, f: ClientProofFields): string {
  return hmacHex(secretHex, [
    'client:v1',
    f.protocolVersion,
    f.hostInstanceId,
    f.hostNonce,
    f.clientNonce,
    f.clientKind,
    f.clientVersion,
    f.pid,
    f.cwd,
    [...f.requestedScopes]
  ])
}

/**
 * HMAC-SHA256(daemon.secret, JSON.stringify(['host:v1', protocolVersion, hostInstanceId, clientNonce, hostNonce,
 * hostKind, appVersion, dataDir, mock, grantedScopes])) as lowercase hex.
 */
export function hostProof(secretHex: string, f: HostProofFields): string {
  return hmacHex(secretHex, [
    'host:v1',
    f.protocolVersion,
    f.hostInstanceId,
    f.clientNonce,
    f.hostNonce,
    f.hostKind,
    f.appVersion,
    f.dataDir,
    f.mock,
    [...f.grantedScopes]
  ])
}

/** Constant-time comparison of two proofs. False unless both are 64 lowercase hex chars and equal. */
export function proofMatches(expectedHex: unknown, givenHex: unknown): boolean {
  if (!isHexNonce(expectedHex) || !isHexNonce(givenHex)) return false
  const a = Buffer.from(expectedHex, 'hex')
  const b = Buffer.from(givenHex, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}

// ---------- daemon.secret ----------

/** `<dataDir>/run/daemon.secret`, written by ownership.ts. */
export function daemonSecretPath(dataDir: string): string {
  return join(dataDir, 'run', 'daemon.secret')
}

const SECRET_FILE_MAX_BYTES = 1024

/**
 * The handshake secret (64 lowercase hex chars), or undefined when the file is missing, not a regular file (a
 * symlink included: lstat), larger than 1 KB, readable by group or others on POSIX ((mode & 0o077) !== 0), or does
 * not hold 64 hex chars after trimming. Never throws.
 */
export function readDaemonSecret(dataDir: string, platform: NodeJS.Platform = process.platform): string | undefined {
  const path = daemonSecretPath(dataDir)
  let fd: number | undefined
  try {
    const st = lstatSync(path)
    if (!st.isFile() || st.size > SECRET_FILE_MAX_BYTES) return undefined
    if (platform !== 'win32' && (st.mode & 0o077) !== 0) return undefined
    const noFollow = platform === 'win32' ? 0 : (fsConstants.O_NOFOLLOW ?? 0)
    fd = openSync(path, fsConstants.O_RDONLY | noFollow)
    // Re-check the opened file (the path may have been swapped between lstat and open).
    const fst = fstatSync(fd)
    if (!fst.isFile() || fst.size > SECRET_FILE_MAX_BYTES || fst.ino !== st.ino) return undefined
    if (platform !== 'win32' && (fst.mode & 0o077) !== 0) return undefined
    const buf = Buffer.alloc(SECRET_FILE_MAX_BYTES + 1)
    const n = readSync(fd, buf, 0, buf.length, 0)
    if (n > SECRET_FILE_MAX_BYTES) return undefined
    const text = buf.subarray(0, n).toString('utf8').trim().toLowerCase()
    return HEX64_RE.test(text) ? text : undefined
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // ignore
      }
    }
  }
}

// ---------- daemon.secret ACL (win32) ----------

/** `%SystemRoot%\System32\<exe>` (never a bare name: Windows searches the cwd before PATH, review H1). */
export function system32Exe(exe: string, env: NodeJS.ProcessEnv = process.env): string {
  return system32Path(exe, env)
}

/** The user SID in `whoami /user /fo csv /nh` output (`"host\user","S-1-5-21-..."`); undefined when there is none. */
export function parseWhoamiSid(text: string): string | undefined {
  const m = /"(S-1-\d+(?:-\d+){1,14})"/.exec(text) ?? /\b(S-1-\d+(?:-\d+){1,14})\b/.exec(text)
  return m?.[1]
}

/**
 * icacls arguments that leave `path` with one ACE: full control for `sid` (inheritance removed, so nothing inherited
 * from the folder stays; `/grant:r` replaces any explicit grant of that SID). The SID form (`*S-1-...`) never depends on
 * USERDOMAIN / USERNAME.
 */
export function secretAclArgs(path: string, sid: string, directory = false): string[] {
  // A folder's grant is inherited by the files created in it afterwards ((OI)(CI)), so a file written there never
  // exists with a broader ACL, even for a moment.
  return [path, '/inheritance:r', '/grant:r', directory ? `*${sid}:(OI)(CI)F` : `*${sid}:F`]
}

export interface RestrictSecretAclOptions {
  env?: NodeJS.ProcessEnv
  /** `path` is a folder (the run folder): grant with object and container inheritance. */
  directory?: boolean
  /** execFile; tests inject one. Resolves stdout, rejects on a failure. */
  run?: (file: string, args: string[], opts: { cwd: string; timeoutMs: number }) => Promise<string>
}

function runFile(file: string, args: string[], opts: { cwd: string; timeoutMs: number }): Promise<string> {
  return new Promise((ok, fail) => {
    execFile(file, args, { cwd: opts.cwd, timeout: opts.timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout) =>
      err ? fail(err) : ok(String(stdout))
    )
  })
}

/**
 * win32: give daemon.secret an explicit DACL that admits the current user only (review H2 (3)): `whoami /user` for the
 * SID, then `icacls <path> /inheritance:r /grant:r *<SID>:F`, both by absolute System32 path with cwd os.tmpdir() (as
 * anthropicAuth.ts runs where.exe). Resolves undefined on success, else a short reason; never throws. This keeps other
 * Windows accounts out even when the data folder lives outside the profile; it cannot keep out programs of the same
 * user, which is what the Terminal access level (socketServer.ts grantScopes) and the self-control gate are for.
 * UNVERIFIED on Windows: the whoami / icacls output was taken from Microsoft's documentation, never run from this code.
 */
export async function restrictDaemonSecretAcl(path: string, opts: RestrictSecretAclOptions = {}): Promise<string | undefined> {
  const env = opts.env ?? process.env
  const run = opts.run ?? runFile
  const cwd = neutralCwd()
  let sid: string | undefined
  try {
    sid = parseWhoamiSid(await run(system32Exe('whoami.exe', env), ['/user', '/fo', 'csv', '/nh'], { cwd, timeoutMs: 10_000 }))
  } catch (e) {
    return `whoami failed: ${(e as Error).message}`.slice(0, 300)
  }
  if (!sid) return 'whoami named no user SID'
  try {
    await run(system32Exe('icacls.exe', env), secretAclArgs(path, sid, opts.directory === true), { cwd, timeoutMs: 10_000 })
  } catch (e) {
    return `icacls failed: ${(e as Error).message}`.slice(0, 300)
  }
  return undefined
}

// ---------- Line framing ----------

export interface LineReaderPush {
  /** Complete lines (without the '\n'), decoded as UTF-8; blank lines skipped. */
  lines: string[]
  /** A line exceeded maxLineBytes: the caller must drop the connection. Sticky. */
  overflow: boolean
  /** Bytes of the unterminated tail held so far (lets a caller budget a bulk frame while it arrives). */
  pendingBytes: number
}

/**
 * Incremental newline splitter over Buffers. Splitting on the 0x0A byte never cuts a UTF-8 sequence (no multi-byte
 * sequence contains 0x0A), so a character split across chunks decodes whole once its line is complete.
 *
 * `maxLineBytes` (starts at RPC_PRE_AUTH_FRAME_MAX_BYTES; the server raises it after host.hello) bounds one line's
 * bytes without the '\n': a line of exactly maxLineBytes passes, one byte more overflows, and so does an unterminated
 * tail that already exceeds it. Lines completed before the overflowing one in the same chunk are still returned with
 * `overflow: true`; after that, push returns nothing more.
 */
export class LineReader {
  maxLineBytes: number = RPC_PRE_AUTH_FRAME_MAX_BYTES
  private pending: Buffer[] = []
  private pendingLen = 0
  private overflowed = false

  get overflow(): boolean {
    return this.overflowed
  }

  get pendingBytes(): number {
    return this.pendingLen
  }

  push(chunk: Buffer | string): LineReaderPush {
    if (this.overflowed) return { lines: [], overflow: true, pendingBytes: 0 }
    const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
    const lines: string[] = []
    let start = 0
    while (start <= buf.length) {
      const nl = buf.indexOf(0x0a, start)
      if (nl === -1) {
        const rest = buf.length - start
        if (rest > 0) {
          if (this.pendingLen + rest > this.maxLineBytes) return this.fail(lines)
          this.pending.push(buf.subarray(start))
          this.pendingLen += rest
        }
        break
      }
      const partLen = nl - start
      if (this.pendingLen + partLen > this.maxLineBytes) return this.fail(lines)
      const line =
        this.pending.length === 0
          ? buf.toString('utf8', start, nl)
          : Buffer.concat([...this.pending, buf.subarray(start, nl)], this.pendingLen + partLen).toString('utf8')
      this.pending = []
      this.pendingLen = 0
      if (line.trim() !== '') lines.push(line)
      start = nl + 1
    }
    return { lines, overflow: false, pendingBytes: this.pendingLen }
  }

  /** Drop any buffered tail (after a socket closes). */
  reset(): void {
    this.pending = []
    this.pendingLen = 0
  }

  private fail(lines: string[]): LineReaderPush {
    this.overflowed = true
    this.reset()
    return { lines, overflow: true, pendingBytes: 0 }
  }
}

/** One frame: stringifyJson(msg) plus '\n'. Throws for values JSON cannot carry (bigint, circular...). */
export function encodeFrame(msg: unknown): string {
  return `${stringifyJson(msg)}\n`
}

export type ParsedFrame = { ok: true; message: unknown } | { ok: false; error: HostRpcError }

/** Parse one line with the safe reviver (parseJsonSafe). Never throws. */
export function parseFrame(line: string): ParsedFrame {
  try {
    return { ok: true, message: parseJsonSafe(line) }
  } catch (e) {
    return { ok: false, error: { code: 'bad_request', message: `Invalid JSON: ${(e as Error).message}` } }
  }
}

// ---------- JSON-RPC 2.0 ----------

export type JsonRpcId = number | string

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: JsonRpcId
  method: string
  params?: unknown[] | Record<string, unknown>
}

export interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

export interface JsonRpcSuccess<T = unknown> {
  jsonrpc: '2.0'
  id: JsonRpcId
  result: T
}

export interface JsonRpcErrorResponse {
  jsonrpc: '2.0'
  /** null only for a frame that could not be parsed (no id to answer). */
  id: JsonRpcId | null
  error: { code: number; message: string; data: HostRpcError }
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcErrorResponse

/** JSON-RPC numeric code per host code; the string code is in error.data.code. */
export const RPC_NUMERIC_CODE: Record<HostRpcErrorCode, number> = {
  host_starting: -32000,
  host_draining: -32000,
  terminal_server_disabled: -32000,
  unknown_channel: -32601,
  desktop_unavailable: -32000,
  agent_descendant_refused: -32000,
  stale_target_digest: -32000,
  stale_revision: -32000,
  scope_denied: -32000,
  frame_too_large: -32000,
  bad_request: -32602,
  auth_failed: -32000,
  protocol_mismatch: -32000,
  too_many_connections: -32000,
  too_many_requests: -32000
}

/** JSON-RPC parse error code (an unparsable frame). */
export const RPC_PARSE_ERROR = -32700

/** The id of the host.hello request (cli-spec 3.3(2): always 1). */
export const HELLO_REQUEST_ID = 1

export function rpcRequest(id: JsonRpcId, method: string, params?: unknown[] | Record<string, unknown>): JsonRpcRequest {
  return params === undefined ? { jsonrpc: '2.0', id, method } : { jsonrpc: '2.0', id, method, params }
}

export function rpcResult<T>(id: JsonRpcId, result: T): JsonRpcSuccess<T> {
  // JSON has no undefined: a handler that returns nothing answers null.
  return { jsonrpc: '2.0', id, result: (result === undefined ? null : result) as T }
}

export function rpcError(id: JsonRpcId | null, err: HostRpcError): JsonRpcErrorResponse {
  const data: HostRpcError = { code: err.code, message: err.message }
  if (err.retryAfterMs !== undefined) data.retryAfterMs = err.retryAfterMs
  return { jsonrpc: '2.0', id, error: { code: RPC_NUMERIC_CODE[err.code] ?? -32000, message: err.message, data } }
}

/** The answer to an unparsable frame: id null, code -32700, data.code 'bad_request'. */
export function rpcParseError(message = 'Invalid JSON'): JsonRpcErrorResponse {
  return { jsonrpc: '2.0', id: null, error: { code: RPC_PARSE_ERROR, message, data: { code: 'bad_request', message } } }
}

export function rpcNotification(method: string, params?: unknown): JsonRpcNotification {
  return params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params }
}

/** The host's first frame on a new socket. */
export function challengeFrame(hostInstanceId: string, hostNonce: string): RpcChallengeFrame {
  return { jsonrpc: '2.0', method: 'host.challenge', params: { protocolVersion: 1, hostInstanceId, hostNonce } }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isId = (v: unknown): v is JsonRpcId => (typeof v === 'number' && Number.isFinite(v)) || typeof v === 'string'
const okParams = (v: unknown): boolean => v === undefined || Array.isArray(v) || isObj(v)

export function isRequest(v: unknown): v is JsonRpcRequest {
  return isObj(v) && v.jsonrpc === '2.0' && typeof v.method === 'string' && isId(v.id) && okParams(v.params)
}

export function isNotification(v: unknown): v is JsonRpcNotification {
  return isObj(v) && v.jsonrpc === '2.0' && typeof v.method === 'string' && !Object.hasOwn(v, 'id')
}

export function isResponse(v: unknown): v is JsonRpcResponse {
  if (!isObj(v) || v.jsonrpc !== '2.0' || Object.hasOwn(v, 'method')) return false
  if (!(isId(v.id) || v.id === null)) return false
  const hasResult = Object.hasOwn(v, 'result')
  const hasError = isObj(v.error)
  return hasResult !== hasError
}

/**
 * The HostRpcError of an error response: `error.data` when it carries a string code, else a bad_request built from
 * the JSON-RPC message (a peer that is not an OrgAI host).
 */
export function errorDataOf(res: JsonRpcErrorResponse): HostRpcError {
  const data = res.error.data as unknown
  if (isObj(data) && typeof data.code === 'string' && typeof data.message === 'string') {
    const out: HostRpcError = { code: data.code as HostRpcErrorCode, message: data.message }
    if (typeof data.retryAfterMs === 'number' && Number.isFinite(data.retryAfterMs)) out.retryAfterMs = data.retryAfterMs
    return out
  }
  return { code: 'bad_request', message: typeof res.error.message === 'string' ? res.error.message : 'RPC error' }
}
