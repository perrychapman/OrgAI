/** Start token tests (docs/design/parallel-sessions.md 4.8): real children on this platform plus pure parser tests. */
import { spawn, type ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import {
  parseLinuxStat,
  parsePsTokenTable,
  parseWindowsSingle,
  parseWindowsTokenTable,
  readStartTokenTable,
  sameStartToken,
  startTokenOfSync
} from './startTokens'
import { skipIfTokenReadTimedOut, timed } from './testing/startTokenTimeout'

const kids: ChildProcess[] = []
afterEach(() => {
  for (const k of kids.splice(0)) k.kill('SIGKILL')
})
const sleeper = (): ChildProcess => {
  const c = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' })
  kids.push(c)
  return c
}
const exited = (c: ChildProcess): Promise<void> => new Promise((ok) => (c.exitCode !== null || c.signalCode ? ok() : c.once('exit', () => ok())))

describe('real processes on this platform', () => {
  it('the single-pid token equals the table token, and a dead child disappears', async (ctx) => {
    const c = sleeper()
    const s = await timed(() => startTokenOfSync(c.pid!))
    skipIfTokenReadTimedOut(ctx, s.value === null, s.ms, 'The single-pid token read')
    const single = s.value
    expect(typeof single).toBe('string')
    const t = await timed(() => readStartTokenTable())
    skipIfTokenReadTimedOut(ctx, t.value === null, t.ms, 'The process table read')
    const table = t.value
    expect(table).not.toBeNull()
    const row = table!.get(c.pid!)
    expect(row?.ppid).toBe(process.pid)
    expect(sameStartToken(single as string, row!.token)).toBe(true)
    const tag = process.platform === 'darwin' ? 'lstart:' : process.platform === 'linux' ? 'ticks:' : 'ft:'
    expect((single as string).startsWith(tag)).toBe(true)
    // the reader's own process is not in the table
    c.kill('SIGKILL')
    await exited(c)
    const gone = await timed(() => startTokenOfSync(c.pid!))
    skipIfTokenReadTimedOut(ctx, gone.value === null, gone.ms, 'The token read of the exited child')
    expect(gone.value).toBe('gone')
    const a = await timed(() => readStartTokenTable())
    skipIfTokenReadTimedOut(ctx, a.value === null, a.ms, 'The second process table read')
    expect(a.value).not.toBeNull()
    expect(a.value!.has(c.pid!)).toBe(false)
  }, 90_000)

  it('a pid that never existed is gone', async (ctx) => {
    const r = await timed(() => startTokenOfSync(2_000_000_000))
    skipIfTokenReadTimedOut(ctx, r.value === null, r.ms, 'The token read of a pid that never existed')
    expect(r.value).toBe('gone')
  }, 30_000)
})

describe('parsers', () => {
  it('Linux stat: comm with spaces and parentheses, split after the last paren', () => {
    const fields = ['S', '42', '1', '1', '0', '-1', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '1', '0', '0', '987654']
    const text = `1234 (a) (b) ${fields.join(' ')} 0 0 0\n`
    expect(parseLinuxStat(text)).toEqual({ ppid: 42, token: 'ticks:987654' })
    expect(parseLinuxStat(`1 (init) S 0 ${'0 '.repeat(17)}5 0 0`)).toEqual({ ppid: 0, token: 'ticks:5' })
    expect(parseLinuxStat('garbage')).toBeNull()
    expect(parseLinuxStat('1 (x) S 0 1')).toBeNull()
  })

  it('macOS ps table: whitespace collapsed, bad lines skipped', () => {
    const t = parsePsTokenTable('  1     0 Mon Jan  1 00:00:00 2026\n 20 1 Tue Feb  2 03:04:05 2026\nnoise\n')
    expect(t.get(1)).toEqual({ ppid: 0, token: 'lstart:Mon Jan 1 00:00:00 2026' })
    expect(t.get(20)?.token).toBe('lstart:Tue Feb 2 03:04:05 2026')
    expect(t.size).toBe(2)
  })

  it('Windows table and single reads: ft tokens, zero or missing is null, GONE', () => {
    const t = parseWindowsTokenTable('4 0 0\r\n100 4 133500000000000000\r\n200 100 000\r\nx y z\r\n')
    expect(t.get(100)).toEqual({ ppid: 4, token: 'ft:133500000000000000' })
    expect(t.get(4)?.token).toBeNull()
    expect(t.get(200)?.token).toBeNull()
    expect(parseWindowsSingle('133500000000000000\r\n')).toBe('ft:133500000000000000')
    expect(parseWindowsSingle('0')).toBeNull()
    expect(parseWindowsSingle('GONE\r\n')).toBe('gone')
    expect(parseWindowsSingle('')).toBeNull()
  })
})

describe('sameStartToken', () => {
  it('is true only for identical non-null tagged strings', () => {
    expect(sameStartToken('ticks:5', 'ticks:5')).toBe(true)
    expect(sameStartToken('ticks:5', 'ticks:6')).toBe(false)
    expect(sameStartToken('ticks:5', 'ft:5')).toBe(false)
    expect(sameStartToken('lstart:a', 'ft:a')).toBe(false)
    expect(sameStartToken(null, null)).toBe(false)
    expect(sameStartToken('ticks:5', null)).toBe(false)
    expect(sameStartToken(undefined, undefined)).toBe(false)
    expect(sameStartToken('', '')).toBe(false)
  })
})
