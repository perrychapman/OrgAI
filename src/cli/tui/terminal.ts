/**
 * Terminal lifecycle (cli-spec 5.1): the buffer mode is chosen once at startup and kept across resize, SIGTSTP /
 * SIGCONT and the pager; this module owns raw mode, bracketed paste (\x1b[?2004h/l), the cursor and the alternate
 * screen (\x1b[?1049h/l), and the crash, exit and signal cleanup. Ink never touches any of them (types.ts INK_NOTES).
 *
 * Windows has no SIGTSTP / SIGCONT: those handlers are skipped there (and Ctrl+Z is ignored); unverified on Windows.
 *
 * While a child owns the terminal (the $PAGER, `suspendForChild`), the child shares our foreground process group, so
 * its Ctrl+C / Ctrl+Z reach us too: SIGINT is ignored (git does the same while its pager runs), SIGTSTP takes the
 * default stop without touching the terminal, and SIGCONT does not resume (the child still owns the screen); the
 * terminal comes back only with `resumeFromChild` once the child has exited.
 */
import { writeSync } from 'node:fs'
import { sanitizeTty } from './sanitizeTty'
import { FULLSCREEN_MIN_COLS, FULLSCREEN_MIN_ROWS, type BufferMode, type TerminalController } from './types'

export const SEQ = {
  altEnter: '\x1b[?1049h',
  altLeave: '\x1b[?1049l',
  pasteOn: '\x1b[?2004h',
  pasteOff: '\x1b[?2004l',
  cursorHide: '\x1b[?25l',
  cursorShow: '\x1b[?25h',
  sgrReset: '\x1b[0m',
  /** Clear the screen and home the cursor (a full redraw after SIGCONT in full-screen mode). */
  clear: '\x1b[2J\x1b[H'
} as const

/** Exit codes for signals received from outside (raw mode means Ctrl+C never raises SIGINT itself). */
export const SIGNAL_EXIT = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 } as const

export function chooseBufferMode(input: {
  isTTY: boolean
  cols: number
  rows: number
  inline: boolean
  screenReader: boolean
  term?: string
}): BufferMode {
  if (input.inline || input.screenReader || input.term === 'dumb' || !input.isTTY) return 'inline'
  if (!(input.cols >= FULLSCREEN_MIN_COLS) || !(input.rows >= FULLSCREEN_MIN_ROWS)) return 'inline'
  return 'fullscreen'
}

/** The controller plus what the shell needs beyond the shared contract. */
export interface TuiTerminal extends TerminalController {
  /** Called after every resume() (SIGCONT, after the pager): the App resyncs and redraws. */
  onResume(fn: () => void): () => void
  /** Ctrl+Z arrives as a key in raw mode: suspend and take the default SIGTSTP stop (no-op on win32). */
  stopSelf(): void
  /** Whether the terminal is currently suspended (SIGTSTP or the pager). */
  readonly suspended: boolean
  /** Suspend for a child that takes the foreground terminal (the pager); signals are held until resumeFromChild. */
  suspendForChild(): void
  /** The child exited: resume and handle signals again. */
  resumeFromChild(): void
}

type Proc = Pick<NodeJS.Process, 'on' | 'off' | 'kill' | 'pid' | 'exit' | 'platform'> & { stderr?: { write(s: string): unknown; fd?: number } }

export function createTerminal(opts: {
  stdout: NodeJS.WriteStream
  stdin: NodeJS.ReadStream
  bufferMode: BufferMode
  bracketedPaste: boolean
  proc?: NodeJS.Process
}): TuiTerminal {
  const { stdout, stdin, bufferMode, bracketedPaste } = opts
  const proc = (opts.proc ?? process) as unknown as Proc
  const fullscreen = bufferMode === 'fullscreen'
  const jobControl = proc.platform !== 'win32'

  let entered = false
  let restored = false
  let suspended = false
  /** A child (the pager) owns the terminal: signals are held (see the header). */
  let childOwns = false
  const resumeListeners = new Set<() => void>()
  const resizeListeners = new Set<(cols: number, rows: number) => void>()

  /** Synchronous where possible (a TTY fd), so nothing is lost before a stop or an exit. */
  const writeNow = (s: string): void => {
    if (!s) return
    const fd = (stdout as { fd?: unknown }).fd
    if (typeof fd === 'number' && stdout.isTTY === true) {
      try {
        writeSync(fd, s)
        return
      } catch {
        // Fall back to the stream (EAGAIN on a non-blocking fd).
      }
    }
    try {
      stdout.write(s)
    } catch {
      // A closed terminal: nothing left to restore.
    }
  }

  const setRaw = (on: boolean): void => {
    const s = stdin as NodeJS.ReadStream & { setRawMode?: (m: boolean) => unknown }
    if (stdin.isTTY === true && typeof s.setRawMode === 'function') {
      try {
        s.setRawMode(on)
      } catch {
        // The terminal went away.
      }
    }
  }

  /** The sequences that put the startup mode back (enter and resume). */
  const modeOn = (): void => {
    writeNow((fullscreen ? SEQ.altEnter + SEQ.cursorHide : '') + (bracketedPaste ? SEQ.pasteOn : ''))
    setRaw(true)
    try {
      stdin.setEncoding('utf8')
      stdin.resume()
    } catch {
      // ignore
    }
  }

  /** The sequences that hand the terminal back (suspend and restore). */
  const modeOff = (final: boolean): void => {
    writeNow((bracketedPaste ? SEQ.pasteOff : '') + SEQ.cursorShow + (final ? SEQ.sgrReset : '') + (fullscreen ? SEQ.altLeave : ''))
    setRaw(false)
    try {
      stdin.pause()
    } catch {
      // ignore
    }
  }

  const exitWith = (code: number): void => {
    restore()
    proc.exit(code)
  }

  const onTstp = (): void => {
    // With a child in the foreground the terminal is the child's: stop with it, leave the modes alone.
    const held = childOwns
    if (!held) suspend()
    proc.off('SIGTSTP', onTstp)
    try {
      proc.kill(proc.pid, 'SIGTSTP')
    } catch {
      // Could not stop: carry on as if resumed.
      proc.on('SIGTSTP', onTstp)
      if (!held) resume()
    }
  }
  const onCont = (): void => {
    proc.off('SIGTSTP', onTstp)
    proc.on('SIGTSTP', onTstp)
    if (!childOwns) resume()
  }
  const onTerm = (): void => exitWith(SIGNAL_EXIT.SIGTERM)
  // Ctrl+C typed into the pager reaches the whole process group; the pager handles it, we ignore it.
  const onInt = (): void => {
    if (!childOwns) exitWith(SIGNAL_EXIT.SIGINT)
  }
  const onHup = (): void => exitWith(SIGNAL_EXIT.SIGHUP)
  const onExit = (): void => restore()
  const onCrash = (err: unknown): void => {
    restore()
    // Error text can carry external words (an MCP server's stderr under --host inproc): sanitized like every exit path.
    const text = sanitizeTty(err instanceof Error ? (err.stack ?? err.message) : String(err))
    try {
      const fd = proc.stderr?.fd
      if (typeof fd === 'number') writeSync(fd, `orgai: ${text}\n`)
      else proc.stderr?.write(`orgai: ${text}\n`)
    } catch {
      // ignore
    }
    proc.exit(1)
  }
  const onStdoutResize = (): void => {
    const { cols, rows } = size()
    for (const fn of [...resizeListeners]) fn(cols, rows)
  }

  const listeners: [string, (...a: never[]) => void][] = [
    ['SIGTERM', onTerm],
    ['SIGINT', onInt],
    ['SIGHUP', onHup],
    ['exit', onExit],
    ['uncaughtException', onCrash],
    ['unhandledRejection', onCrash]
  ]
  if (jobControl) listeners.push(['SIGCONT', onCont])

  function size(): { cols: number; rows: number } {
    return { cols: stdout.columns || 80, rows: stdout.rows || 24 }
  }

  function enter(): void {
    if (entered || restored) return
    entered = true
    for (const [ev, fn] of listeners) proc.on(ev as 'exit', fn as () => void)
    if (jobControl) proc.on('SIGTSTP', onTstp)
    stdout.on('resize', onStdoutResize)
    modeOn()
  }

  function suspend(): void {
    if (!entered || restored || suspended) return
    suspended = true
    modeOff(false)
  }

  function resume(): void {
    if (!entered || restored || !suspended) return
    suspended = false
    modeOn()
    for (const fn of [...resumeListeners]) {
      try {
        fn()
      } catch {
        // A listener's failure never leaves the terminal half restored.
      }
    }
  }

  function restore(): void {
    if (restored) return
    restored = true
    if (!entered) return
    for (const [ev, fn] of listeners) proc.off(ev as 'exit', fn as () => void)
    if (jobControl) proc.off('SIGTSTP', onTstp)
    stdout.off('resize', onStdoutResize)
    resumeListeners.clear()
    resizeListeners.clear()
    if (!suspended) modeOff(true)
    else writeNow(SEQ.sgrReset)
    suspended = false
    childOwns = false
  }

  function suspendForChild(): void {
    if (!entered || restored || suspended) return
    suspend()
    childOwns = true
  }

  function resumeFromChild(): void {
    if (!childOwns) return
    childOwns = false
    resume()
  }

  return {
    bufferMode,
    bracketedPaste,
    enter,
    suspend,
    resume,
    restore,
    size,
    suspendForChild,
    resumeFromChild,
    get suspended() {
      return suspended
    },
    onResize(fn) {
      resizeListeners.add(fn)
      return () => void resizeListeners.delete(fn)
    },
    onResume(fn) {
      resumeListeners.add(fn)
      return () => void resumeListeners.delete(fn)
    },
    stopSelf() {
      if (!jobControl || !entered || restored) return
      onTstp()
    }
  }
}

/**
 * The stdout handed to Ink: every write is dropped while `held()` (the terminal is suspended for the pager or a stop),
 * so no frame lands on the child's screen. The App holds its state still while suspended (no new <Static> rows), so
 * a dropped write is only a repaint of the frame already shown; the resume listener clears and redraws. A dropped
 * write still calls its callback. Fullscreen uses a drawn composer cursor, so each renderer write keeps the native
 * cursor hidden. Lifecycle writes bypass this proxy to restore it for the pager, suspension, and exit.
 * Everything else (columns, rows, isTTY, 'resize' listeners) is the real stream's.
 */
export function gateWrites<T extends NodeJS.WritableStream>(stream: T, held: () => boolean, hideCursor = false): T {
  const write = (chunk: unknown, encOrCb?: unknown, cb?: unknown): boolean => {
    if (!held()) {
      if (hideCursor) {
        if (typeof chunk === 'string') chunk = SEQ.cursorHide + chunk + SEQ.cursorHide
        else if (chunk instanceof Uint8Array) chunk = Buffer.concat([Buffer.from(SEQ.cursorHide), chunk, Buffer.from(SEQ.cursorHide)])
      }
      return (stream.write as (...a: unknown[]) => boolean)(chunk, encOrCb, cb)
    }
    const done = typeof encOrCb === 'function' ? encOrCb : typeof cb === 'function' ? cb : undefined
    if (done) queueMicrotask(() => (done as (err?: Error | null) => void)(null))
    return true
  }
  return new Proxy(stream, {
    get(target, prop) {
      if (prop === 'write') return write
      const v: unknown = Reflect.get(target, prop, target)
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v
    }
  })
}
