import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RPC_PRE_AUTH_FRAME_MAX_BYTES } from '../../shared/types'
import {
  HELLO_REQUEST_ID,
  LineReader,
  RPC_NUMERIC_CODE,
  clientProof,
  encodeFrame,
  errorDataOf,
  hostProof,
  isHexNonce,
  isNotification,
  isRequest,
  isResponse,
  newNonce,
  parseFrame,
  parseWhoamiSid,
  proofMatches,
  readDaemonSecret,
  restrictDaemonSecretAcl,
  secretAclArgs,
  system32Exe,
  rpcError,
  rpcNotification,
  rpcParseError,
  rpcRequest,
  rpcResult,
  type ClientProofFields,
  type HostProofFields
} from './protocol'

const SECRET = 'ab'.repeat(32)

const client: ClientProofFields = {
  protocolVersion: 1,
  hostInstanceId: '0123456789ab',
  hostNonce: 'a'.repeat(64),
  clientNonce: 'b'.repeat(64),
  clientKind: 'cli',
  clientVersion: '0.1.6',
  pid: 4242,
  cwd: '/work/repo',
  requestedScopes: ['read', 'operate']
}

const host: HostProofFields = {
  protocolVersion: 1,
  hostInstanceId: '0123456789ab',
  clientNonce: 'b'.repeat(64),
  hostNonce: 'a'.repeat(64),
  hostKind: 'desktop',
  appVersion: '0.1.6',
  dataDir: '/data',
  mock: false,
  grantedScopes: ['read']
}

describe('nonces and proofs', () => {
  it('makes 64-hex nonces', () => {
    const a = newNonce()
    expect(isHexNonce(a)).toBe(true)
    expect(newNonce()).not.toBe(a)
    expect(isHexNonce('A'.repeat(64))).toBe(false)
    expect(isHexNonce('a'.repeat(63))).toBe(false)
    expect(isHexNonce(42)).toBe(false)
  })

  it('client proofs are deterministic lowercase hex and bind every field', () => {
    const p = clientProof(SECRET, client)
    expect(p).toMatch(/^[0-9a-f]{64}$/)
    expect(clientProof(SECRET, { ...client })).toBe(p)
    expect(clientProof('cd'.repeat(32), client)).not.toBe(p)
    const changes: Partial<ClientProofFields>[] = [
      { cwd: '/work/other' },
      { pid: 4243 },
      { requestedScopes: ['read'] },
      { requestedScopes: ['operate', 'read'] },
      { clientKind: 'tui' },
      { clientVersion: '0.1.7' },
      { hostNonce: 'c'.repeat(64) },
      { clientNonce: 'c'.repeat(64) },
      { hostInstanceId: 'ba9876543210' }
    ]
    for (const c of changes) expect(clientProof(SECRET, { ...client, ...c })).not.toBe(p)
  })

  it('host proofs bind every field and differ from the client proof domain', () => {
    const p = hostProof(SECRET, host)
    expect(p).toMatch(/^[0-9a-f]{64}$/)
    expect(hostProof(SECRET, { ...host })).toBe(p)
    const changes: Partial<HostProofFields>[] = [
      { hostKind: 'inproc' },
      { dataDir: '/data2' },
      { mock: true },
      { grantedScopes: ['read', 'operate'] },
      { appVersion: '0.1.7' },
      { clientNonce: 'c'.repeat(64) }
    ]
    for (const c of changes) expect(hostProof(SECRET, { ...host, ...c })).not.toBe(p)
    // Swapping the nonces must not let a host proof pass as a client one.
    expect(p).not.toBe(clientProof(SECRET, client))
  })

  it('proofMatches compares in constant time and rejects junk', () => {
    const p = clientProof(SECRET, client)
    expect(proofMatches(p, p)).toBe(true)
    expect(proofMatches(p, clientProof(SECRET, { ...client, pid: 1 }))).toBe(false)
    expect(proofMatches(p, p.toUpperCase())).toBe(false)
    expect(proofMatches(p, p.slice(0, 62))).toBe(false)
    expect(proofMatches(p, `${p}00`)).toBe(false)
    expect(proofMatches(p, undefined)).toBe(false)
    expect(proofMatches(p, 123)).toBe(false)
    expect(proofMatches(p, 'z'.repeat(64))).toBe(false)
    expect(proofMatches('junk', p)).toBe(false)
  })
})

describe('LineReader', () => {
  it('splits lines, skips blank ones and keeps a multi-byte character split across chunks', () => {
    const r = new LineReader()
    const bytes = Buffer.from('{"a":"héllo €"}\n\n  \n{"b":1}\n', 'utf8')
    // Cut inside the 3-byte euro sign.
    const euro = bytes.indexOf(Buffer.from('€', 'utf8'))
    const first = r.push(bytes.subarray(0, euro + 1))
    expect(first.lines).toEqual([])
    expect(first.pendingBytes).toBe(euro + 1)
    const second = r.push(bytes.subarray(euro + 1))
    expect(second.lines).toEqual(['{"a":"héllo €"}', '{"b":1}'])
    expect(second.pendingBytes).toBe(0)
    expect(second.overflow).toBe(false)
  })

  it('reports the unterminated tail size', () => {
    const r = new LineReader()
    expect(r.push('abc').pendingBytes).toBe(3)
    expect(r.push('de').pendingBytes).toBe(5)
    const out = r.push('f\ng')
    expect(out.lines).toEqual(['abcdef'])
    expect(out.pendingBytes).toBe(1)
  })

  it('accepts a line of exactly maxLineBytes and overflows at one byte more', () => {
    const at = new LineReader()
    expect(at.maxLineBytes).toBe(RPC_PRE_AUTH_FRAME_MAX_BYTES)
    const ok = at.push(`${'x'.repeat(RPC_PRE_AUTH_FRAME_MAX_BYTES)}\n`)
    expect(ok.overflow).toBe(false)
    expect(ok.lines[0]).toHaveLength(RPC_PRE_AUTH_FRAME_MAX_BYTES)

    const over = new LineReader()
    const bad = over.push(`${'x'.repeat(RPC_PRE_AUTH_FRAME_MAX_BYTES + 1)}\n`)
    expect(bad.overflow).toBe(true)
    // Sticky: nothing more comes out.
    expect(over.push('{"a":1}\n')).toEqual({ lines: [], overflow: true, pendingBytes: 0 })
    expect(over.overflow).toBe(true)
  })

  it('overflows on an unterminated tail past the cap, across chunks, keeping earlier complete lines', () => {
    const r = new LineReader()
    r.maxLineBytes = 10
    expect(r.push('1234567890').overflow).toBe(false)
    const out = r.push('1')
    expect(out.overflow).toBe(true)

    const r2 = new LineReader()
    r2.maxLineBytes = 4
    const mixed = r2.push('ab\nabcdefgh')
    expect(mixed.lines).toEqual(['ab'])
    expect(mixed.overflow).toBe(true)
  })

  it('takes a raised cap after authentication', () => {
    const r = new LineReader()
    r.push('{"hello":1}\n')
    r.maxLineBytes = RPC_PRE_AUTH_FRAME_MAX_BYTES * 4
    const big = r.push(`${'y'.repeat(RPC_PRE_AUTH_FRAME_MAX_BYTES * 2)}\n`)
    expect(big.overflow).toBe(false)
    expect(big.lines[0]).toHaveLength(RPC_PRE_AUTH_FRAME_MAX_BYTES * 2)
  })
})

describe('frames and JSON-RPC shapes', () => {
  it('encodes one line and parses with the safe reviver', () => {
    const f = encodeFrame(rpcRequest(HELLO_REQUEST_ID, 'host.hello', { a: 1 }))
    expect(f.endsWith('\n')).toBe(true)
    expect(f.slice(0, -1)).not.toContain('\n')
    const parsed = parseFrame('{"jsonrpc":"2.0","id":2,"method":"x","params":{"__proto__":{"polluted":1},"ok":true}}')
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      const params = (parsed.message as { params: Record<string, unknown> }).params
      expect(Object.hasOwn(params, '__proto__')).toBe(false)
      expect(params.ok).toBe(true)
    }
    const bad = parseFrame('{nope')
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error.code).toBe('bad_request')
    expect(() => encodeFrame({ n: 1n })).toThrow()
  })

  it('builds and recognises requests, notifications and responses', () => {
    expect(isRequest(rpcRequest(3, 'runs:list', []))).toBe(true)
    expect(isRequest({ jsonrpc: '2.0', method: 'x' })).toBe(false)
    expect(isRequest({ jsonrpc: '2.0', id: 1, method: 'x', params: 'str' })).toBe(false)
    expect(isNotification(rpcNotification('runs:event', { seq: 1 }))).toBe(true)
    expect(isNotification(rpcRequest(1, 'x'))).toBe(false)
    expect(isResponse(rpcResult(4, { ok: true }))).toBe(true)
    expect(rpcResult(4, undefined).result).toBeNull()
    expect(isResponse({ jsonrpc: '2.0', id: 4 })).toBe(false)
    expect(isResponse({ jsonrpc: '2.0', id: 4, result: 1, error: { code: 1 } })).toBe(false)
  })

  it('maps host codes to numeric JSON-RPC codes and keeps the string code in data', () => {
    expect(RPC_NUMERIC_CODE.unknown_channel).toBe(-32601)
    expect(RPC_NUMERIC_CODE.bad_request).toBe(-32602)
    expect(RPC_NUMERIC_CODE.auth_failed).toBe(-32000)
    const e = rpcError(7, { code: 'host_starting', message: 'Starting', retryAfterMs: 250 })
    expect(e.error.code).toBe(-32000)
    expect(e.error.data).toEqual({ code: 'host_starting', message: 'Starting', retryAfterMs: 250 })
    expect(isResponse(e)).toBe(true)
    expect(errorDataOf(e)).toEqual({ code: 'host_starting', message: 'Starting', retryAfterMs: 250 })
    const p = rpcParseError()
    expect(p.id).toBeNull()
    expect(p.error.code).toBe(-32700)
    expect(p.error.data.code).toBe('bad_request')
    expect(errorDataOf({ jsonrpc: '2.0', id: 1, error: { code: -1, message: 'm', data: 'junk' as never } })).toEqual({ code: 'bad_request', message: 'm' })
  })
})

describe('readDaemonSecret', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })
  const dataDir = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'orgai-proto-'))
    dirs.push(d)
    mkdirSync(join(d, 'run'), { mode: 0o700 })
    return d
  }
  const posix = process.platform !== 'win32'

  it('reads a 0600 secret, trimmed', () => {
    const d = dataDir()
    writeFileSync(join(d, 'run', 'daemon.secret'), `${SECRET}\n`, { mode: 0o600 })
    expect(readDaemonSecret(d)).toBe(SECRET)
  })

  it('is undefined when missing, oversized or not hex', () => {
    const d = dataDir()
    expect(readDaemonSecret(d)).toBeUndefined()
    writeFileSync(join(d, 'run', 'daemon.secret'), 'zz'.repeat(32), { mode: 0o600 })
    expect(readDaemonSecret(d)).toBeUndefined()
    writeFileSync(join(d, 'run', 'daemon.secret'), SECRET + ' '.repeat(2000), { mode: 0o600 })
    expect(readDaemonSecret(d)).toBeUndefined()
  })

  it.skipIf(!posix)('refuses a 0644 file', () => {
    const d = dataDir()
    const p = join(d, 'run', 'daemon.secret')
    writeFileSync(p, SECRET, { mode: 0o600 })
    chmodSync(p, 0o644)
    expect(readDaemonSecret(d)).toBeUndefined()
  })

  it.skipIf(!posix)('refuses a symlink', () => {
    const d = dataDir()
    const real = join(d, 'elsewhere.secret')
    writeFileSync(real, SECRET, { mode: 0o600 })
    symlinkSync(real, join(d, 'run', 'daemon.secret'))
    expect(readDaemonSecret(d)).toBeUndefined()
  })
})

describe('restrictDaemonSecretAcl (win32, review H2 (3); UNVERIFIED on Windows)', () => {
  const env = { SystemRoot: 'D:\\Win' }
  it('runs whoami and icacls by absolute System32 path from the temp folder, granting the user SID only', async () => {
    const calls: { file: string; args: string[]; cwd: string }[] = []
    const run = async (file: string, args: string[], o: { cwd: string }): Promise<string> => {
      calls.push({ file, args, cwd: o.cwd })
      return file.endsWith('whoami.exe') ? '"pc\\me","S-1-5-21-111-222-333-1001"\r\n' : 'processed file\r\n'
    }
    expect(await restrictDaemonSecretAcl('C:\\data\\run\\daemon.secret', { env, run })).toBeUndefined()
    expect(calls.map((c) => c.file)).toEqual(['D:\\Win\\System32\\whoami.exe', 'D:\\Win\\System32\\icacls.exe'])
    expect(calls[0].args).toEqual(['/user', '/fo', 'csv', '/nh'])
    expect(calls[1].args).toEqual(['C:\\data\\run\\daemon.secret', '/inheritance:r', '/grant:r', '*S-1-5-21-111-222-333-1001:F'])
    expect(calls.every((c) => c.cwd === tmpdir())).toBe(true)
  })

  it('answers a reason, never throws', async () => {
    expect(await restrictDaemonSecretAcl('p', { env, run: async () => 'no sid here' })).toBe('whoami named no user SID')
    const failing = async (file: string): Promise<string> => {
      if (file.endsWith('icacls.exe')) throw new Error('Access is denied.')
      return '"pc\\me","S-1-5-21-1-2-3-500"'
    }
    expect(await restrictDaemonSecretAcl('p', { env, run: failing })).toBe('icacls failed: Access is denied.')
    expect(await restrictDaemonSecretAcl('p', { env, run: async () => Promise.reject(new Error('nope')) })).toBe('whoami failed: nope')
  })

  it('system32Exe falls back to windir, then C:\\Windows; parseWhoamiSid reads the CSV', () => {
    expect(system32Exe('icacls.exe', { windir: 'E:\\W' })).toBe('E:\\W\\System32\\icacls.exe')
    expect(system32Exe('icacls.exe', {})).toBe('C:\\Windows\\System32\\icacls.exe')
    expect(parseWhoamiSid('"a\\b","S-1-12-1-2-3"')).toBe('S-1-12-1-2-3')
    expect(parseWhoamiSid('S-x')).toBeUndefined()
    expect(secretAclArgs('f', 'S-1-5-18')).toEqual(['f', '/inheritance:r', '/grant:r', '*S-1-5-18:F'])
    expect(secretAclArgs('d', 'S-1-5-18', true)).toEqual(['d', '/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)F'])
  })
})
