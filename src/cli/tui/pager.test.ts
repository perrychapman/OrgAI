import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { pagerCommand, parsePagerEnv, showInPager } from './pager'
import { sanitizeDiffForPager } from './sanitizeTty'

const onPath =
  (...names: string[]) =>
  (name: string): string | null =>
    names.includes(name) ? `/usr/bin/${name}` : null

describe('pagerCommand', () => {
  it('splits PAGER on whitespace with no shell parsing; quotes stay literal', () => {
    expect(parsePagerEnv('less -R -F')).toEqual({ file: 'less', args: ['-R', '-F'] })
    expect(parsePagerEnv('  most  ')).toEqual({ file: 'most', args: [] })
    expect(parsePagerEnv('less "-R -X"')).toEqual({ file: 'less', args: ['"-R', '-X"'] })
    expect(parsePagerEnv("bat --paging='always'")).toEqual({ file: 'bat', args: ["--paging='always'"] })
  })

  it('refuses shell metacharacters and empty values', () => {
    for (const v of ['less; rm -rf ~', 'less | tee x', 'less && x', 'less > x', 'less < x', 'less $(id)', 'less `id`', 'less $HOME', 'sh -c (x)', 'less &', '', '   ', 'less\nrm']) {
      expect(parsePagerEnv(v)).toBeNull()
    }
    expect(parsePagerEnv(undefined)).toBeNull()
  })

  it('falls back to less -R, then more, then null', () => {
    expect(pagerCommand({ PAGER: 'less; id' }, onPath('less', 'more'))).toEqual({ file: 'less', args: ['-R'] })
    expect(pagerCommand({}, onPath('less', 'more'))).toEqual({ file: 'less', args: ['-R'] })
    expect(pagerCommand({}, onPath('more'))).toEqual({ file: 'more', args: [] })
    expect(pagerCommand({}, onPath())).toBeNull()
    expect(pagerCommand({ PAGER: 'most -s' }, onPath())).toEqual({ file: 'most', args: ['-s'] })
  })
})

class FakeStdin extends EventEmitter {
  written = ''
  ended = false
  constructor(private readonly epipe = false) {
    super()
  }
  end(data?: string): void {
    if (data) this.written += data
    this.ended = true
    if (this.epipe) queueMicrotask(() => this.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })))
  }
}

class FakeChild extends EventEmitter {
  constructor(readonly stdin: FakeStdin) {
    super()
  }
}

function fakeSpawn(opts: { epipe?: boolean; throws?: boolean; error?: boolean } = {}) {
  const calls: { file: string; args: string[]; options: Record<string, unknown> }[] = []
  let child: FakeChild | undefined
  const spawn = vi.fn((file: string, args: string[], options: Record<string, unknown>) => {
    calls.push({ file, args, options })
    if (opts.throws) throw new Error('spawn failed')
    child = new FakeChild(new FakeStdin(opts.epipe))
    const c = child
    setTimeout(() => (opts.error ? c.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })) : c.emit('exit', 0)), 5)
    return c
  })
  return { spawn: spawn as never, calls, child: () => child }
}

describe('showInPager', () => {
  const evil = 'diff --git a/x b/x\n+ok \u001b]52;c;aGk=\u0007line\n-gone \u001b[2J\u001b[31mred\n context'

  it('spawns with shell: false and stdio pipe/inherit/inherit, writes the sanitized diff, suspends and resumes', async () => {
    const order: string[] = []
    const f = fakeSpawn()
    const res = await showInPager(evil, {
      env: { PAGER: 'less -R' },
      suspend: () => order.push('suspend'),
      resume: () => order.push('resume'),
      spawn: f.spawn,
      which: onPath('less')
    })
    expect(res).toBe('shown')
    expect(order).toEqual(['suspend', 'resume'])
    expect(f.calls).toHaveLength(1)
    expect(f.calls[0].file).toBe('less')
    expect(f.calls[0].args).toEqual(['-R'])
    expect(f.calls[0].options).toMatchObject({ stdio: ['pipe', 'inherit', 'inherit'], shell: false })
    const written = f.child()!.stdin.written
    expect(f.child()!.stdin.ended).toBe(true)
    expect(written).toBe(sanitizeDiffForPager(evil))
    // Only trusted SGR is left.
    const escapes = written.match(/\u001b\[[0-9;]*[A-Za-z]/g) ?? []
    for (const e of escapes) expect(['\u001b[31m', '\u001b[32m', '\u001b[0m']).toContain(e)
    expect(written).not.toMatch(/\u001b\]|\u0007|\u001b\[2J/)
  })

  it('returns no-pager without suspending when there is none', async () => {
    const suspend = vi.fn()
    const resume = vi.fn()
    expect(await showInPager('x', { env: {}, suspend, resume, spawn: fakeSpawn().spawn, which: onPath() })).toBe('no-pager')
    expect(suspend).not.toHaveBeenCalled()
    expect(resume).not.toHaveBeenCalled()
  })

  it('resumes even when spawn throws or the child errors', async () => {
    for (const opts of [{ throws: true }, { error: true }]) {
      const suspend = vi.fn()
      const resume = vi.fn()
      await expect(showInPager('x', { env: {}, suspend, resume, spawn: fakeSpawn(opts).spawn, which: onPath('less') })).rejects.toThrow()
      expect(suspend).toHaveBeenCalledTimes(1)
      expect(resume).toHaveBeenCalledTimes(1)
    }
  })

  it('ignores EPIPE when the user quits the pager early', async () => {
    const resume = vi.fn()
    const res = await showInPager('x\n'.repeat(10), { env: {}, suspend: () => {}, resume, spawn: fakeSpawn({ epipe: true }).spawn, which: onPath('less') })
    expect(res).toBe('shown')
    expect(resume).toHaveBeenCalledTimes(1)
  })
})
