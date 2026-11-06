import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { SEQ, chooseBufferMode, createTerminal, gateWrites } from './terminal'
import type { BufferMode } from './types'

class FakeStdout extends EventEmitter {
  columns = 120
  rows = 40
  isTTY = true
  out = ''
  write(s: string): boolean {
    this.out += s
    return true
  }
}

class FakeStdin extends EventEmitter {
  isTTY = true
  raw: boolean[] = []
  paused = true
  encoding?: string
  setRawMode(on: boolean): this {
    this.raw.push(on)
    return this
  }
  setEncoding(e: string): this {
    this.encoding = e
    return this
  }
  resume(): this {
    this.paused = false
    return this
  }
  pause(): this {
    this.paused = true
    return this
  }
}

class FakeProc extends EventEmitter {
  pid = 4242
  platform: NodeJS.Platform = 'darwin'
  kills: [number, string][] = []
  exits: number[] = []
  errText = ''
  stderr = { write: (s: string) => void (this.errText += s) }
  kill(pid: number, sig: string): boolean {
    this.kills.push([pid, sig])
    return true
  }
  exit(code: number): void {
    this.exits.push(code)
  }
}

function setup(bufferMode: BufferMode, opts: { platform?: NodeJS.Platform; bracketedPaste?: boolean } = {}) {
  const stdout = new FakeStdout()
  const stdin = new FakeStdin()
  const proc = new FakeProc()
  if (opts.platform) proc.platform = opts.platform
  const term = createTerminal({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    bufferMode,
    bracketedPaste: opts.bracketedPaste ?? true,
    proc: proc as unknown as NodeJS.Process
  })
  return { stdout, stdin, proc, term }
}

describe('chooseBufferMode', () => {
  const base = { isTTY: true, cols: 100, rows: 24, inline: false, screenReader: false, term: 'xterm-256color' }
  it('full-screen from 100x24, inline below or when asked', () => {
    expect(chooseBufferMode(base)).toBe('fullscreen')
    expect(chooseBufferMode({ ...base, cols: 99 })).toBe('inline')
    expect(chooseBufferMode({ ...base, rows: 23 })).toBe('inline')
    expect(chooseBufferMode({ ...base, inline: true })).toBe('inline')
    expect(chooseBufferMode({ ...base, screenReader: true })).toBe('inline')
    expect(chooseBufferMode({ ...base, term: 'dumb' })).toBe('inline')
    expect(chooseBufferMode({ ...base, isTTY: false })).toBe('inline')
    expect(chooseBufferMode({ ...base, cols: Number.NaN })).toBe('inline')
  })
})

describe('createTerminal', () => {
  it('enter: alternate screen, bracketed paste and hidden cursor in full-screen; raw mode on', () => {
    const { stdout, stdin, term } = setup('fullscreen')
    term.enter()
    expect(stdout.out).toContain(SEQ.altEnter)
    expect(stdout.out).toContain(SEQ.pasteOn)
    expect(stdout.out).toContain(SEQ.cursorHide)
    expect(stdin.raw).toEqual([true])
    expect(stdin.encoding).toBe('utf8')
    expect(stdin.paused).toBe(false)
  })

  it('enter inline: no alternate screen', () => {
    const { stdout, term } = setup('inline')
    term.enter()
    expect(stdout.out).not.toContain(SEQ.altEnter)
    expect(stdout.out).toContain(SEQ.pasteOn)
  })

  it('no bracketed paste when it is off (TERM=dumb)', () => {
    const { stdout, term } = setup('inline', { bracketedPaste: false })
    term.enter()
    expect(stdout.out).not.toContain(SEQ.pasteOn)
  })

  for (const mode of ['fullscreen', 'inline'] as const) {
    it(`${mode}: SIGTSTP suspends, removes its listener and takes the default stop; SIGCONT restores the same mode`, () => {
      const { stdout, stdin, proc, term } = setup(mode)
      const resumed = vi.fn()
      term.onResume(resumed)
      term.enter()
      stdout.out = ''
      expect(proc.listenerCount('SIGTSTP')).toBe(1)
      proc.emit('SIGTSTP')
      expect(stdout.out).toContain(SEQ.pasteOff)
      expect(stdout.out).toContain(SEQ.cursorShow)
      expect(stdout.out.includes(SEQ.altLeave)).toBe(mode === 'fullscreen')
      expect(stdin.raw.at(-1)).toBe(false)
      expect(stdin.paused).toBe(true)
      expect(proc.listenerCount('SIGTSTP')).toBe(0)
      expect(proc.kills).toEqual([[4242, 'SIGTSTP']])
      expect(term.suspended).toBe(true)

      stdout.out = ''
      proc.emit('SIGCONT')
      expect(stdout.out.includes(SEQ.altEnter)).toBe(mode === 'fullscreen')
      expect(stdout.out).toContain(SEQ.pasteOn)
      expect(stdin.raw.at(-1)).toBe(true)
      expect(proc.listenerCount('SIGTSTP')).toBe(1)
      expect(resumed).toHaveBeenCalledTimes(1)
      expect(term.suspended).toBe(false)
    })
  }

  it('stopSelf (Ctrl+Z) behaves like SIGTSTP; win32 skips job control', () => {
    const a = setup('fullscreen')
    a.term.enter()
    a.term.stopSelf()
    expect(a.proc.kills).toEqual([[4242, 'SIGTSTP']])
    const b = setup('fullscreen', { platform: 'win32' })
    b.term.enter()
    expect(b.proc.listenerCount('SIGTSTP')).toBe(0)
    expect(b.proc.listenerCount('SIGCONT')).toBe(0)
    b.term.stopSelf()
    expect(b.proc.kills).toEqual([])
  })

  it('suspend / resume for the pager keep the startup mode', () => {
    const { stdout, term } = setup('inline')
    term.enter()
    stdout.out = ''
    term.suspend()
    term.resume()
    expect(stdout.out).not.toContain(SEQ.altEnter)
    expect(stdout.out).not.toContain(SEQ.altLeave)
  })

  it('reports resizes and never switches the buffer', () => {
    const { stdout, term } = setup('fullscreen')
    term.enter()
    const sizes: [number, number][] = []
    term.onResize((c, r) => sizes.push([c, r]))
    stdout.out = ''
    stdout.columns = 80
    stdout.rows = 20
    stdout.emit('resize')
    expect(sizes).toEqual([[80, 20]])
    expect(stdout.out).not.toContain('1049')
    expect(term.bufferMode).toBe('fullscreen')
    expect(term.size()).toEqual({ cols: 80, rows: 20 })
  })

  it('restore is synchronous, complete and idempotent, and removes every listener', () => {
    const { stdout, stdin, proc, term } = setup('fullscreen')
    term.enter()
    stdout.out = ''
    term.restore()
    expect(stdout.out).toBe(SEQ.pasteOff + SEQ.cursorShow + SEQ.sgrReset + SEQ.altLeave)
    expect(stdin.raw.at(-1)).toBe(false)
    for (const ev of ['SIGTSTP', 'SIGCONT', 'SIGTERM', 'SIGINT', 'SIGHUP', 'exit', 'uncaughtException', 'unhandledRejection']) {
      expect(proc.listenerCount(ev), ev).toBe(0)
    }
    expect(stdout.listenerCount('resize')).toBe(0)
    stdout.out = ''
    term.restore()
    expect(stdout.out).toBe('')
    term.resume()
    expect(stdout.out).toBe('')
  })

  it('inline restore never leaves the alternate screen', () => {
    const { stdout, term } = setup('inline')
    term.enter()
    stdout.out = ''
    term.restore()
    expect(stdout.out).not.toContain(SEQ.altLeave)
    expect(stdout.out).toContain(SEQ.cursorShow)
  })

  it('crash and signal cleanup restore first, then exit with 1 / 143 / 130 / 129', () => {
    for (const [ev, code, arg] of [
      ['uncaughtException', 1, new Error('kaboom')],
      ['unhandledRejection', 1, 'nope'],
      ['SIGTERM', 143, undefined],
      ['SIGINT', 130, undefined],
      ['SIGHUP', 129, undefined]
    ] as const) {
      const { stdout, proc, term } = setup('fullscreen')
      term.enter()
      stdout.out = ''
      proc.emit(ev, arg)
      expect(stdout.out, ev).toContain(SEQ.altLeave)
      expect(proc.exits, ev).toEqual([code])
      if (ev === 'uncaughtException') expect(proc.errText).toContain('kaboom')
    }
  })

  it('the crash text is sanitized before it reaches the terminal', () => {
    const { proc, term } = setup('fullscreen')
    term.enter()
    proc.emit('unhandledRejection', new Error('bad \u001b]52;c;aGk=\u0007 \u001b[2Jthing'))
    expect(proc.errText).toContain('bad')
    expect(proc.errText).not.toContain('\u001b')
    expect(proc.errText).not.toContain('\u0007')
  })

  it('while the pager owns the terminal: Ctrl+C is ignored, Ctrl+Z stops without touching the modes, SIGCONT waits for the pager', () => {
    const { stdout, stdin, proc, term } = setup('fullscreen')
    term.enter()
    const resumed = vi.fn()
    term.onResume(resumed)
    term.suspendForChild()
    expect(term.suspended).toBe(true)
    stdout.out = ''
    const rawBefore = stdin.raw.length
    proc.emit('SIGINT')
    expect(proc.exits).toEqual([])
    proc.emit('SIGTSTP')
    expect(proc.kills).toEqual([[4242, 'SIGTSTP']])
    proc.emit('SIGCONT')
    expect(stdout.out).toBe('')
    expect(stdin.raw.length).toBe(rawBefore)
    expect(resumed).not.toHaveBeenCalled()
    expect(proc.listenerCount('SIGTSTP')).toBe(1)
    term.resumeFromChild()
    expect(term.suspended).toBe(false)
    expect(stdout.out).toContain(SEQ.altEnter)
    expect(resumed).toHaveBeenCalledTimes(1)
    // Signals are handled again once the pager is gone.
    proc.emit('SIGINT')
    expect(proc.exits).toEqual([130])
  })

  it('the exit event restores', () => {
    const { stdout, proc, term } = setup('fullscreen')
    term.enter()
    stdout.out = ''
    proc.emit('exit', 0)
    expect(stdout.out).toContain(SEQ.altLeave)
  })
})

describe('gateWrites', () => {
  it('drops writes while held (calling their callback) and passes everything else through', async () => {
    const written: string[] = []
    const stream = Object.assign(new EventEmitter(), {
      columns: 100,
      rows: 30,
      isTTY: true,
      write(chunk: string, cb?: () => void) {
        written.push(chunk)
        cb?.()
        return true
      }
    })
    let held = false
    const gated = gateWrites(stream as unknown as NodeJS.WriteStream, () => held)
    gated.write('a')
    held = true
    const cb = vi.fn()
    expect(gated.write('b', cb)).toBe(true)
    await Promise.resolve()
    expect(cb).toHaveBeenCalledTimes(1)
    held = false
    gated.write('c')
    expect(written).toEqual(['a', 'c'])
    expect(gated.columns).toBe(100)
    expect(gated.isTTY).toBe(true)
    const onResize = vi.fn()
    gated.on('resize', onResize)
    stream.emit('resize')
    expect(onResize).toHaveBeenCalledTimes(1)
    gated.off('resize', onResize)
    expect(stream.listenerCount('resize')).toBe(0)
  })
})
