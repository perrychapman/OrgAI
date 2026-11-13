/**
 * Chain claim tests (no tokens). Child processes run TypeScript through the vite-node CLI (the loader this repo ships;
 * there is no tsx; see store/shared/testing/viteNode.ts), started with an absolute script path written to a temp folder.
 */
import { type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LockBusyError } from '../store/shared/osLock'
import {
  ChainMissingError,
  ChainWriteError,
  assertChainWrite,
  claimChain,
  claimExecChain,
  classifyChain,
  computeChainIds,
  computeChainIdsDetailed,
  execChainLockKey,
  invalidateChainWrite,
  isChainWriteValid,
  readChainRecord,
  withChainClaim,
  writeChainRecord,
  type ChainWrite
} from './chainClaim'
import * as chainClaimModule from './chainClaim'
import { killAndWait, spawnViteNode } from '../store/shared/testing/viteNode'

const MODULE = resolve(__dirname, 'chainClaim.ts')

let dir: string
const children: ChildProcess[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chainclaim-'))
  mkdirSync(join(dir, 'control', 'locks'), { recursive: true })
})
afterEach(async () => {
  // Wait for the children to exit first: on Windows a lock file a live child holds cannot be unlinked (EBUSY).
  await killAndWait(children)
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})
const control = (): string => join(dir, 'control')

function runChild(source: string): ChildProcess {
  const file = join(dir, `child-${children.length}.ts`)
  writeFileSync(file, source)
  const c = spawnViteNode(file, [], { stdio: ['ignore', 'pipe', 'inherit'] })
  children.push(c)
  return c
}
function firstLine(c: ChildProcess): Promise<string> {
  return new Promise((res, rej) => {
    let buf = ''
    c.stdout!.on('data', (d: Buffer) => {
      buf += String(d)
      const i = buf.indexOf('\n')
      if (i >= 0) res(buf.slice(0, i))
    })
    c.once('error', rej)
    c.once('exit', () => rej(new Error(`child exited: ${buf}`)))
  })
}
const exited = (c: ChildProcess): Promise<void> => new Promise((r) => (c.exitCode !== null || c.signalCode ? r() : c.once('exit', () => r())))

const r = (id: string, startedAt: number, extra: { resumedFrom?: string; sessionId?: string } = {}) => ({ id: `run_${id}`, startedAt, ...extra })

describe('computeChainIds', () => {
  it('follows a resumedFrom chain to its oldest member', () => {
    const m = computeChainIds([r('c', 3, { resumedFrom: 'run_b' }), r('a', 1), r('b', 2, { resumedFrom: 'run_a' }), r('x', 0)])
    expect(m.get('run_a')).toBe('run_a')
    expect(m.get('run_b')).toBe('run_a')
    expect(m.get('run_c')).toBe('run_a')
    expect(m.get('run_x')).toBe('run_x')
  })
  it('joins members that share a session id even when the middle was pruned', () => {
    const m = computeChainIds([r('a', 1, { sessionId: 's1' }), r('c', 3, { sessionId: 's1', resumedFrom: 'run_gone' })])
    expect(m.get('run_a')).toBe('run_a')
    expect(m.get('run_c')).toBe('run_a')
  })
  it('ignores empty session ids', () => {
    const m = computeChainIds([r('a', 1, { sessionId: '' }), r('b', 2, { sessionId: '' })])
    expect(m.get('run_b')).toBe('run_b')
  })
  it('keeps a dangling predecessor out of the component', () => {
    const m = computeChainIds([r('b', 5, { resumedFrom: 'run_missing' }), r('c', 6, { resumedFrom: 'run_missing' })])
    expect(m.get('run_b')).toBe('run_b')
    expect(m.get('run_c')).toBe('run_c')
  })
  it('survives cycles and picks the oldest', () => {
    const m = computeChainIds([r('a', 2, { resumedFrom: 'run_b' }), r('b', 1, { resumedFrom: 'run_a' }), r('c', 3, { resumedFrom: 'run_c' })])
    expect(m.get('run_a')).toBe('run_b')
    expect(m.get('run_b')).toBe('run_b')
    expect(m.get('run_c')).toBe('run_c')
  })
  it('breaks a startedAt tie by id', () => {
    const m = computeChainIds([r('b', 1, { sessionId: 's' }), r('a', 1, { sessionId: 's' })])
    expect(m.get('run_b')).toBe('run_a')
  })
  it('skips and reports invalid ids', () => {
    const d = computeChainIdsDetailed([r('a', 1), { id: '../evil', startedAt: 0 }, { id: 'run_' + 'x'.repeat(81), startedAt: 0 }, r('b', 2, { resumedFrom: '../evil' })])
    expect(d.invalid).toEqual(['../evil', 'run_' + 'x'.repeat(81)])
    expect([...d.chains.keys()].sort()).toEqual(['run_a', 'run_b'])
    expect(d.chains.get('run_b')).toBe('run_b')
  })
})

describe('classifyChain', () => {
  const live = (h: string): boolean => h === 'live'
  const rec = (state: 'open' | 'clean' | 'legacy-uncertain', hostId = 'dead') => ({ hostId, state, since: 1 })
  it('follows the table', () => {
    expect(classifyChain(rec('clean'), live)).toBe('normal')
    expect(classifyChain(rec('open', 'dead'), live)).toBe('unclean')
    expect(classifyChain(rec('open', 'live'), live)).toBe('normal')
    expect(classifyChain(rec('legacy-uncertain'), live)).toBe('uncertain')
    expect(classifyChain(null, live)).toBe('uncertain')
    expect(classifyChain(null, live, { hasFormat2Runs: false })).toBe('normal')
  })
})

describe('ownership record', () => {
  it('round-trips and refuses garbage', () => {
    const chains = join(control(), 'chains')
    expect(readChainRecord(chains, 'run_a')).toBeNull()
    writeChainRecord(chains, 'run_a', { hostId: 'h', state: 'open', since: 5, lingering: [1, 2] })
    expect(readChainRecord(chains, 'run_a')).toEqual({ hostId: 'h', state: 'open', since: 5, lingering: [1, 2] })
    writeFileSync(join(chains, 'run_b.json'), '{nope')
    expect(() => readChainRecord(chains, 'run_b')).toThrow()
    writeFileSync(join(chains, 'run_c.json'), '{"hostId":"h","state":"weird","since":1}')
    expect(() => readChainRecord(chains, 'run_c')).toThrow()
    expect(() => readChainRecord(chains, '../x')).toThrow()
  })
})

describe('claimChain', () => {
  it('a second claim of the same chain fails at once', async () => {
    const a = await claimChain({ controlDir: control(), chainId: 'run_a', hostId: 'h1' })
    await expect(claimChain({ controlDir: control(), chainId: 'run_a', hostId: 'h2' })).rejects.toBeInstanceOf(LockBusyError)
    const b = await claimChain({ controlDir: control(), chainId: 'run_b', hostId: 'h1' })
    b.release(false)
    a.release(false)
    const again = await claimChain({ controlDir: control(), chainId: 'run_a', hostId: 'h2' })
    again.release(false)
  })
  it('writes open on claim and clean on release(true); release(false) leaves open', async () => {
    const chains = join(control(), 'chains')
    const a = await claimChain({ controlDir: control(), chainId: 'run_a', hostId: 'h1', now: () => 7 })
    expect(readChainRecord(chains, 'run_a')).toEqual({ hostId: 'h1', state: 'open', since: 7 })
    a.release(true)
    a.release(true)
    expect(readChainRecord(chains, 'run_a')?.state).toBe('clean')
    const b = await claimChain({ controlDir: control(), chainId: 'run_a', hostId: 'h1' })
    b.release(false)
    expect(readChainRecord(chains, 'run_a')?.state).toBe('open')
  })
  it('writeOpen false leaves the previous record for classification', async () => {
    const chains = join(control(), 'chains')
    writeChainRecord(chains, 'run_a', { hostId: 'old', state: 'clean', since: 1 })
    const a = await claimChain({ controlDir: control(), chainId: 'run_a', hostId: 'h1', writeOpen: false })
    expect(readChainRecord(chains, 'run_a')?.hostId).toBe('old')
    a.markOpen()
    expect(readChainRecord(chains, 'run_a')?.hostId).toBe('h1')
    a.release(false)
  })
  it('rejects invalid chain ids', async () => {
    await expect(claimChain({ controlDir: control(), chainId: '../x', hostId: 'h' })).rejects.toThrow(/Invalid chain id/)
  })
  it('is free again after the holder is killed with SIGKILL', async () => {
    const child = runChild(`
      import { claimChain } from ${JSON.stringify(MODULE)}
      const c = await claimChain({ controlDir: ${JSON.stringify(control())}, chainId: 'run_k', hostId: 'child' })
      console.log('held')
      setInterval(() => {}, 1000)
    `)
    expect(await firstLine(child)).toBe('held')
    await expect(claimChain({ controlDir: control(), chainId: 'run_k', hostId: 'me' })).rejects.toBeInstanceOf(LockBusyError)
    child.kill('SIGKILL')
    await exited(child)
    // The record stays open: a dead host's chain is unclean.
    expect(classifyChain(readChainRecord(join(control(), 'chains'), 'run_k'), () => false)).toBe('unclean')
    const c = await claimChain({ controlDir: control(), chainId: 'run_k', hostId: 'me' })
    c.release(true)
  }, 30_000)
})

describe('exec chain claim', () => {
  it('validates ids and claims once', async () => {
    expect(execChainLockKey('proj_1', 'ec_1')).toMatch(/^execchain-[0-9a-f]{32}$/)
    // Dashes cannot make two different pairs collide (the key is a hash of both ids).
    expect(execChainLockKey('a-b', 'c')).not.toBe(execChainLockKey('a', 'b-c'))
    expect(execChainLockKey('p', 'a/b')).toMatch(/^execchain-[0-9a-f]{32}$/)
    expect(() => execChainLockKey('', 'ec')).toThrow()
    expect(() => execChainLockKey('p', 'x'.repeat(201))).toThrow()
    const h = await claimExecChain(control(), 'proj_1', 'ec_1')
    await expect(claimExecChain(control(), 'proj_1', 'ec_1')).rejects.toBeInstanceOf(LockBusyError)
    const other = await claimExecChain(control(), 'proj_1', 'ec_2')
    other.release()
    h.release()
    ;(await claimExecChain(control(), 'proj_1', 'ec_1')).release()
  })
})

describe('withChainClaim', () => {
  it('claims, classifies, verifies, runs, releases', async () => {
    writeChainRecord(join(control(), 'chains'), 'run_a', { hostId: 'dead', state: 'open', since: 1 })
    let seen: ChainWrite | undefined
    const out = await withChainClaim(
      control(),
      'run_a',
      () => true,
      async (token, ctx) => {
        seen = token
        assertChainWrite(token, 'run_a')
        expect(ctx.classification).toBe('unclean')
        await expect(claimChain({ controlDir: control(), chainId: 'run_a', hostId: 'x' })).rejects.toBeInstanceOf(LockBusyError)
        return 42
      }
    )
    expect(out).toBe(42)
    expect(isChainWriteValid(seen as ChainWrite)).toBe(false)
    ;(await claimChain({ controlDir: control(), chainId: 'run_a', hostId: 'x' })).release(false)
  })
  it('refuses a missing chain and releases', async () => {
    let ran = false
    await expect(withChainClaim(control(), 'run_a', () => false, async () => void (ran = true))).rejects.toBeInstanceOf(ChainMissingError)
    expect(ran).toBe(false)
    ;(await claimChain({ controlDir: control(), chainId: 'run_a', hostId: 'x' })).release(false)
  })
  it('fails busy while a session holds the chain and releases when fn throws', async () => {
    const s = await claimChain({ controlDir: control(), chainId: 'run_a', hostId: 'h' })
    await expect(withChainClaim(control(), 'run_a', () => true, async () => 1)).rejects.toBeInstanceOf(LockBusyError)
    s.release(true)
    await expect(withChainClaim(control(), 'run_a', () => true, async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    ;(await claimChain({ controlDir: control(), chainId: 'run_a', hostId: 'x' })).release(false)
  })
  it('classifies a missing record as uncertain and a clean one as normal', async () => {
    const seen: string[] = []
    await withChainClaim(control(), 'run_a', () => true, async (_t, ctx) => void seen.push(ctx.classification))
    writeChainRecord(join(control(), 'chains'), 'run_a', { hostId: 'h', state: 'clean', since: 1 })
    await withChainClaim(control(), 'run_a', () => true, async (_t, ctx) => void seen.push(ctx.classification))
    expect(seen).toEqual(['uncertain', 'normal'])
  })
})

describe('ChainWrite token', () => {
  it('cannot be forged and exposes no constructor', async () => {
    const exported = Object.keys(chainClaimModule)
    expect(exported.filter((k) => /issue|createChainWrite|makeChainWrite|newChainWrite/i.test(k))).toEqual([])
    expect(() => assertChainWrite({ chainId: 'run_a' } as unknown as ChainWrite, 'run_a')).toThrow(ChainWriteError)
    expect(() => assertChainWrite(undefined, 'run_a')).toThrow(ChainWriteError)
    const a = await claimChain({ controlDir: control(), chainId: 'run_a', hostId: 'h' })
    expect(() => assertChainWrite({ ...a.token }, 'run_a')).toThrow(ChainWriteError)
    assertChainWrite(a.token, 'run_a')
    expect(() => assertChainWrite(a.token, 'run_b')).toThrow(/not run_b/)
    a.release(false)
  })
  it('invalidate and release both stop writes', async () => {
    const a = await claimChain({ controlDir: control(), chainId: 'run_a', hostId: 'h' })
    invalidateChainWrite(a.token)
    expect(isChainWriteValid(a.token)).toBe(false)
    expect(() => assertChainWrite(a.token, 'run_a')).toThrow(/no longer valid/)
    a.release(true)
    const b = await claimChain({ controlDir: control(), chainId: 'run_a', hostId: 'h' })
    b.release(false)
    expect(() => assertChainWrite(b.token, 'run_a')).toThrow(ChainWriteError)
    expect(existsSync(join(control(), 'chains', 'run_a.json'))).toBe(true)
    expect(readFileSync(join(control(), 'chains', 'run_a.json'), 'utf8')).toContain('open')
  })
})
