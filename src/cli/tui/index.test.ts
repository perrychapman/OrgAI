import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeContext } from '../testing/fakeContext'
import { CliError, EXIT } from '../types'

const h = vi.hoisted(() => ({
  element: undefined as undefined | { props: Record<string, unknown> },
  unmounted: 0,
  connectError: undefined as Error | undefined,
  conn: undefined as unknown,
  session: undefined as unknown,
  connects: 0
}))

vi.mock('ink', () => ({
  render: (el: { props: Record<string, unknown> }) => {
    h.element = el
    return { unmount: () => void h.unmounted++, clear: () => undefined, waitUntilExit: () => new Promise(() => undefined) }
  }
}))
vi.mock('./App', () => ({ App: () => null }))
vi.mock('./input/keys', () => ({
  KeyParser: class {
    feed(chunk: string) {
      return [...chunk].map((ch) => ({ type: 'key', name: ch === '\x1b' ? 'escape' : 'char', ch, ctrl: false, alt: false, shift: false, raw: ch }))
    }
    flush() {
      return [{ type: 'key', name: 'escape', ctrl: false, alt: false, shift: false, raw: '\x1b' }]
    }
  },
  isTrayFocusKey: () => false
}))
vi.mock('./session', () => ({
  connectTuiHost: async () => {
    h.connects++
    if (h.connectError) throw h.connectError
    return h.conn
  },
  openTuiSession: async () => h.session
}))

const { DETACHED_MESSAGE, ESC_FLUSH_MS, NO_TTY_MESSAGE, keyInput, runTui, tuiEnvFor } = await import('./index')

class Out extends EventEmitter {
  isTTY = true
  columns = 120
  rows = 40
  text = ''
  write(s: string) {
    this.text += s
    return true
  }
}
class In extends EventEmitter {
  isTTY = true
  setRawMode() {
    return this
  }
  setEncoding() {
    return this
  }
  resume() {
    return this
  }
  pause() {
    return this
  }
}

function ttyCtx(env: NodeJS.ProcessEnv = {}) {
  const f = fakeContext({ stdinIsTTY: true, env })
  ;(f.ctx.io.stdout as { isTTY?: boolean }).isTTY = true
  return f
}

afterEach(() => {
  h.element = undefined
  h.unmounted = 0
  h.connectError = undefined
  h.connects = 0
})

describe('tuiEnvFor', () => {
  const ctx = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform = 'darwin', color = true) => ({ env, platform, globals: { color } as never })
  it('reads TERM=dumb, the locale, NO_COLOR and --no-color', () => {
    expect(tuiEnvFor(ctx({ LANG: 'en_GB.UTF-8' }), { inline: false, screenReader: false }, 'fullscreen')).toEqual({
      bufferMode: 'fullscreen',
      screenReader: false,
      color: true,
      dumbTerminal: false,
      bracketedPaste: true,
      unicode: true
    })
    expect(tuiEnvFor(ctx({ TERM: 'dumb', LANG: 'en_GB.UTF-8' }), { inline: false, screenReader: false }, 'inline')).toMatchObject({ dumbTerminal: true, bracketedPaste: false, unicode: false })
    expect(tuiEnvFor(ctx({ LANG: 'C' }), { inline: false, screenReader: true }, 'inline')).toMatchObject({ unicode: false, screenReader: true })
    expect(tuiEnvFor(ctx({ LC_ALL: 'en_US.utf8', LANG: 'C' }), { inline: false, screenReader: false }, 'inline').unicode).toBe(true)
    expect(tuiEnvFor(ctx({}, 'win32'), { inline: false, screenReader: false }, 'inline').unicode).toBe(true)
    expect(tuiEnvFor(ctx({ NO_COLOR: '1' }), { inline: false, screenReader: false }, 'inline').color).toBe(false)
    expect(tuiEnvFor(ctx({}, 'darwin', false), { inline: false, screenReader: false }, 'inline').color).toBe(false)
  })
})

describe('keyInput', () => {
  it('feeds chunks through the parser and flushes a lone ESC after the timeout', () => {
    vi.useFakeTimers()
    try {
      const stdin = new In()
      const src = keyInput(stdin as unknown as NodeJS.ReadStream, true)
      const got: string[] = []
      src.subscribe((e) => got.push(e.type === 'key' ? e.name : 'paste'))
      stdin.emit('data', Buffer.from('a'))
      expect(got).toEqual(['char'])
      vi.advanceTimersByTime(ESC_FLUSH_MS)
      expect(got).toEqual(['char', 'escape'])
      src.close()
      stdin.emit('data', 'b')
      expect(got).toHaveLength(2)
      expect(stdin.listenerCount('data')).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('runTui', () => {
  it('needs a terminal on both ends: exit 2 before connecting', async () => {
    const f = fakeContext({ stdinIsTTY: false })
    await expect(runTui(f.ctx, {}, { inline: false, screenReader: false })).rejects.toMatchObject({ exitCode: EXIT.usage, message: NO_TTY_MESSAGE })
    expect(h.connects).toBe(0)
  })

  it('a connection failure propagates before the screen is touched', async () => {
    h.connectError = new CliError('busy', EXIT.hostBusy)
    const out = new Out()
    await expect(runTui(ttyCtx().ctx, {}, { inline: false, screenReader: false }, { stdout: out as never, stdin: new In() as never })).rejects.toMatchObject({ exitCode: EXIT.hostBusy })
    expect(out.text).toBe('')
  })

  it('a prepare failure closes the connection and rethrows', async () => {
    const close = vi.fn(async () => undefined)
    h.conn = { close }
    const out = new Out()
    await expect(
      runTui(ttyCtx().ctx, {}, { inline: false, screenReader: false }, {
        stdout: out as never,
        stdin: new In() as never,
        prepare: async () => {
          throw new CliError('bad ref', EXIT.usage)
        }
      })
    ).rejects.toMatchObject({ exitCode: EXIT.usage })
    expect(close).toHaveBeenCalledWith({ stopInproc: false })
    expect(out.text).toBe('')
  })

  it('renders the App in full-screen, restores the terminal on exit, closes, and prints the detach note', async () => {
    const connClose = vi.fn(async () => undefined)
    const sessionClose = vi.fn(async () => undefined)
    h.conn = { close: connClose }
    h.session = { close: sessionClose }
    const out = new Out()
    const err = { text: '', write(s: string) { this.text += s } }
    const stdin = new In()
    const done = runTui(ttyCtx({ LANG: 'en_US.UTF-8', TERM: 'xterm' }).ctx, {}, { inline: false, screenReader: false }, {
      stdout: out as never,
      stdin: stdin as never,
      stderr: err,
      prepare: async () => ({ prompt: 'go' })
    })
    for (let i = 0; i < 20 && !h.element; i++) await new Promise((r) => setTimeout(r, 1))
    expect(out.text).toContain('\x1b[?1049h')
    const props = h.element!.props as { env: { bufferMode: string }; launch: unknown; onExit(code: number, info: unknown): void }
    expect(props.env.bufferMode).toBe('fullscreen')
    expect(props.launch).toEqual({ prompt: 'go' })
    props.onExit(0, { session: h.session, detachedLive: true })
    expect(await done).toBe(0)
    expect(h.unmounted).toBe(1)
    expect(out.text).toContain('\x1b[?1049l')
    expect(sessionClose).toHaveBeenCalledWith({ stopInproc: false })
    expect(connClose).toHaveBeenCalledWith({ stopInproc: false })
    expect(err.text).toContain(DETACHED_MESSAGE)
    expect(stdin.listenerCount('data')).toBe(0)
    expect(process.listenerCount('SIGTSTP')).toBe(0)
  })

  it('an inproc host is stopped on exit and never prints the detach note; --inline never enters the alternate screen', async () => {
    const connClose = vi.fn(async () => undefined)
    h.conn = { close: connClose, inproc: {} }
    h.session = { close: vi.fn(async () => undefined) }
    const out = new Out()
    const err = { text: '', write(s: string) { this.text += s } }
    const done = runTui(ttyCtx().ctx, {}, { inline: true, screenReader: false }, { stdout: out as never, stdin: new In() as never, stderr: err })
    for (let i = 0; i < 20 && !h.element; i++) await new Promise((r) => setTimeout(r, 1))
    ;(h.element!.props as { onExit(code: number, info: unknown): void }).onExit(0, { session: h.session, detachedLive: true })
    expect(await done).toBe(0)
    expect(out.text).not.toContain('\x1b[?1049')
    expect(connClose).toHaveBeenCalledWith({ stopInproc: true })
    expect(err.text).not.toContain(DETACHED_MESSAGE)
  })
})
