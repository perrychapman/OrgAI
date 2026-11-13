import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ORDER, dataLockPath, withLocks, type LockSpec } from './lockOrder'
import { SharedJsonFile } from './sharedJsonFile'
import { killAndWait, spawnViteNode } from './testing/viteNode'
import type { ChildProcess } from 'node:child_process'

interface Doc {
  n: number
  a?: string
  b?: string
}

let dir: string
let control: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sharedjson-'))
  control = join(dir, 'control')
  mkdirSync(join(control, 'locks'), { recursive: true })
  file = join(dir, 'doc.json')
})
afterEach(async () => {
  // A child still running after a failed case holds the lock file open (EBUSY on Windows): wait for it first.
  await killAndWait(children)
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

const parse = (raw: unknown): Doc => {
  if (typeof raw !== 'object' || raw === null || typeof (raw as Doc).n !== 'number') throw new Error('bad doc')
  return raw as Doc
}
const make = (): SharedJsonFile<Doc> => new SharedJsonFile<Doc>({ file, controlDir: control, parse, empty: () => ({ n: 0 }) })

describe('SharedJsonFile basics', () => {
  it('reads empty on a missing file, update creates it, no temp files left, mode 0600', async () => {
    const f = make()
    expect(f.read()).toEqual({ n: 0 })
    expect(existsSync(file)).toBe(false)
    const out = await f.update((c) => ({ ...c, n: c.n + 1 }))
    expect(out).toEqual({ n: 1 })
    expect(f.read()).toEqual({ n: 1 })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ n: 1 })
    expect(readdirSync(dir).filter((x) => x.includes('.tmp-'))).toEqual([])
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('never hands the cached object to fn', async () => {
    const f = make()
    await f.update(() => ({ n: 1, a: 'x' }))
    const cached = f.read()
    await f.update((c) => {
      expect(c).not.toBe(cached)
      c.n = 99
      throw new Error('abort')
    }).catch(() => undefined)
    expect(f.read()).toEqual({ n: 1, a: 'x' })
    expect(cached.n).toBe(1)
  })

  it('sees an external write on the next read and fires onExternalChange (not for own writes)', async () => {
    const f = make()
    const seen: Doc[] = []
    f.onExternalChange((v) => seen.push(v))
    expect(f.read()).toEqual({ n: 0 })
    await f.update(() => ({ n: 1 }))
    f.read()
    expect(seen).toEqual([])
    writeFileSync(file, JSON.stringify({ n: 7, a: 'ext' }))
    expect(f.read()).toEqual({ n: 7, a: 'ext' })
    expect(seen).toEqual([{ n: 7, a: 'ext' }])
    f.read()
    expect(seen).toHaveLength(1)
  })

  it('keeps the last good copy on a parse failure and refuses update naming the file', async () => {
    const f = make()
    await f.update(() => ({ n: 5 }))
    writeFileSync(file, '{ not json')
    expect(f.read()).toEqual({ n: 5 })
    expect(f.lastError).not.toBeNull()
    await expect(f.update((c) => c)).rejects.toThrow(file)
    expect(readFileSync(file, 'utf8')).toBe('{ not json')
    writeFileSync(file, JSON.stringify({ n: 6 }))
    expect(f.read()).toEqual({ n: 6 })
    expect(f.lastError).toBeNull()
    await expect(f.update((c) => ({ n: c.n + 1 }))).resolves.toEqual({ n: 7 })
  })

  it('refuses a result its own parse rejects, leaving the file alone', async () => {
    const f = make()
    await f.update(() => ({ n: 1 }))
    await expect(f.update(() => ({ n: 'x' }) as unknown as Doc)).rejects.toThrow('bad doc')
    expect(f.read()).toEqual({ n: 1 })
  })
})

describe('SharedJsonFile locking', () => {
  const tx = (key: string, order: number): LockSpec => ({
    key,
    path: dataLockPath(control, key),
    mode: 'exclusive',
    kind: 'transaction',
    order,
    waitMs: 2000
  })

  it('update inside withLocks([config]) reuses the held lock', async () => {
    const f = make()
    await withLocks([tx('config', ORDER.config)], async () => {
      await f.update((c) => ({ n: c.n + 1 }))
      await f.update((c) => ({ n: c.n + 1 }))
    })
    expect(f.read()).toEqual({ n: 2 })
  })

  it('update inside a lower-order transaction lock works', async () => {
    const f = make()
    await withLocks([tx('team-x', ORDER.team)], async () => {
      await f.update(() => ({ n: 3 }))
    })
    expect(f.read()).toEqual({ n: 3 })
  })

  it('concurrent updates in one process serialize', async () => {
    const f = make()
    await Promise.all(Array.from({ length: 20 }, () => f.update(async (c) => ({ n: c.n + 1 }))))
    expect(f.read().n).toBe(20)
  })
})

// Children cannot import the TS module through plain node, so they run under the vite-node CLI (testing/viteNode.ts),
// with the script placed in the test's temp dir and the module imported by absolute path.
const modulePath = resolve(__dirname, 'sharedJsonFile.ts')

const children: ChildProcess[] = []

function runChild(script: string, args: string[]): Promise<void> {
  return new Promise((res, rej) => {
    const c = spawnViteNode(script, args, { stdio: ['ignore', 'inherit', 'inherit'], cwd: process.cwd() })
    children.push(c)
    c.on('error', rej)
    c.on('exit', (code) => (code === 0 ? res() : rej(new Error(`child exited ${code}`))))
  })
}

function childScript(body: string): string {
  const p = join(dir, `child-${Math.random().toString(36).slice(2)}.ts`)
  writeFileSync(
    p,
    `import { SharedJsonFile } from ${JSON.stringify(modulePath)}
const [file, control, tag, count] = process.argv.slice(2)
const f = new SharedJsonFile<any>({ file, controlDir: control, parse: (r) => r as any, empty: () => ({ n: 0 }) })
;(async () => {
${body}
})().then(() => process.exit(0), (e) => { console.error(e); process.exit(1) })
`
  )
  return p
}

describe('SharedJsonFile across processes', () => {
  it('two processes x 200 updates of one counter end at exactly 400', async () => {
    const script = childScript(`for (let i = 0; i < Number(count); i++) await f.update((c) => ({ ...c, n: c.n + 1 }))`)
    await Promise.all([runChild(script, [file, control, 'a', '200']), runChild(script, [file, control, 'b', '200'])])
    expect(JSON.parse(readFileSync(file, 'utf8')).n).toBe(400)
    expect(readdirSync(dir).filter((x) => x.includes('.tmp-'))).toEqual([])
  }, 120_000)

  it('two processes editing different fields both survive', async () => {
    const script = childScript(`for (let i = 0; i < Number(count); i++) await f.update((c) => ({ ...c, [tag]: String(i) }))`)
    await Promise.all([runChild(script, [file, control, 'a', '30']), runChild(script, [file, control, 'b', '30'])])
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ n: 0, a: '29', b: '29' })
  }, 120_000)
})
