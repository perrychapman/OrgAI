/** Provider session binding tests (no tokens). Two-process races run TypeScript through the vite-node CLI (store/shared/testing/viteNode.ts). */
import { type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { bindProviderSession, bindingKey, listBindings, removeBindingsForChain } from './sessionBinding'
import { killAndWait, spawnViteNode } from '../store/shared/testing/viteNode'
const MODULE = resolve(__dirname, 'sessionBinding.ts')

let dir: string
let sessions: string
const children: ChildProcess[] = []
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sessbind-'))
  sessions = join(dir, 'control', 'sessions')
})
afterEach(async () => {
  await killAndWait(children)
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

const bind = (chainId: string, sessionId = 's1', adapter: 'claude' | 'codex' | 'mock' = 'claude') => bindProviderSession({ sessionsDir: sessions, adapter, sessionId, chainId })

describe('bindProviderSession', () => {
  it('keys by adapter and session id', () => {
    expect(bindingKey('claude', 's1')).toMatch(/^[0-9a-f]{64}$/)
    expect(bindingKey('claude', 's1')).not.toBe(bindingKey('codex', 's1'))
    expect(() => bindingKey('claude', '')).toThrow()
  })
  it('creates, is idempotent for the same chain, conflicts for another', () => {
    expect(bind('run_a')).toEqual({ ok: true, created: true })
    expect(bind('run_a')).toEqual({ ok: true, created: false })
    expect(bind('run_b')).toEqual({ ok: false, reason: 'conflict', otherChainId: 'run_a' })
    expect(JSON.parse(readFileSync(join(sessions, bindingKey('claude', 's1') + '.json'), 'utf8'))).toEqual({ chainId: 'run_a' })
    // the same id under another adapter is a different binding
    expect(bind('run_b', 's1', 'codex')).toEqual({ ok: true, created: true })
    expect(readdirSync(sessions).filter((n) => n.includes('.tmp-'))).toEqual([])
  })
  it('a leftover tmp file never blocks', () => {
    bind('run_a', 'other')
    const key = bindingKey('claude', 's1')
    writeFileSync(join(sessions, `${key}.json.tmp-deadhost-abcdef123456`), 'partial')
    expect(bind('run_a')).toEqual({ ok: true, created: true })
    expect(listBindings(sessions).map((b) => b.chainId)).toEqual(['run_a', 'run_a'])
  })
  it('refuses to overwrite a garbled existing binding', () => {
    const file = join(sessions, bindingKey('claude', 's1') + '.json')
    bind('run_a', 'seed')
    writeFileSync(file, '{"chainId":')
    expect(bind('run_a')).toEqual({ ok: false, reason: 'unreadable' })
    expect(readFileSync(file, 'utf8')).toBe('{"chainId":')
    writeFileSync(file, '{"chainId":"../x"}')
    expect(bind('run_a')).toEqual({ ok: false, reason: 'unreadable' })
  })
  it('rejects an invalid chain id', () => {
    expect(() => bind('../x')).toThrow(/Invalid chain id/)
  })
  it('exactly one chain wins when two processes bind at once', async () => {
    const start = Date.now() + 2500
    const mk = (chain: string): ChildProcess => {
      const file = join(dir, `bind-${chain}.ts`)
      writeFileSync(
        file,
        `import { bindProviderSession } from ${JSON.stringify(MODULE)}
const wait = ${start} - Date.now()
const t = Date.now() + wait
while (Date.now() < t) {}
console.log(JSON.stringify(bindProviderSession({ sessionsDir: ${JSON.stringify(sessions)}, adapter: 'claude', sessionId: 'race', chainId: ${JSON.stringify(chain)} })))
`
      )
      const c = spawnViteNode(file, [], { stdio: ['ignore', 'pipe', 'inherit'] })
      children.push(c)
      return c
    }
    const out = (c: ChildProcess): Promise<{ ok: boolean; reason?: string; otherChainId?: string }> =>
      new Promise((res, rej) => {
        let buf = ''
        c.stdout!.on('data', (d: Buffer) => (buf += String(d)))
        c.once('error', rej)
        c.once('exit', () => {
          try {
            res(JSON.parse(buf.trim().split('\n').pop() as string))
          } catch (e) {
            rej(new Error(`bad child output: ${buf}`))
          }
        })
      })
    const [ra, rb] = await Promise.all([out(mk('run_a')), out(mk('run_b'))])
    expect([ra.ok, rb.ok].filter(Boolean)).toHaveLength(1)
    const loser = ra.ok ? rb : ra
    const winner = ra.ok ? 'run_a' : 'run_b'
    expect(loser).toMatchObject({ ok: false, reason: 'conflict', otherChainId: winner })
    expect(listBindings(sessions)).toEqual([{ key: bindingKey('claude', 'race'), chainId: winner }])
    expect(readdirSync(sessions).filter((n) => n.includes('.tmp-'))).toEqual([])
  }, 30_000)
})

describe('listBindings / removeBindingsForChain', () => {
  it('lists, ignores strangers, removes only the chain and leaves garbled files', () => {
    expect(listBindings(join(dir, 'nowhere'))).toEqual([])
    bind('run_a', 's1')
    bind('run_a', 's2')
    bind('run_b', 's3')
    writeFileSync(join(sessions, 'README'), 'x')
    writeFileSync(join(sessions, 'f'.repeat(64) + '.json'), 'garbage')
    expect(listBindings(sessions)).toHaveLength(4)
    expect(listBindings(sessions).filter((b) => b.chainId === null)).toHaveLength(1)
    expect(removeBindingsForChain(sessions, 'run_a')).toBe(2)
    expect(removeBindingsForChain(sessions, 'run_a')).toBe(0)
    expect(listBindings(sessions).map((b) => b.chainId).sort()).toEqual([null, 'run_b'])
    expect(existsSync(join(sessions, 'f'.repeat(64) + '.json'))).toBe(true)
  })
})
