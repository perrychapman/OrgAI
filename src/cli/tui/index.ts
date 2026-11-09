/**
 * The lazy TUI entry (built as out/cli/tui.mjs). Only reached through `await import('../tui/index')` from
 * commands/tui.ts, so ink and react load only when the TUI starts (lazyTui.test.ts).
 *
 * Order (cli-spec 5.1): check the terminals, build the TuiEnv, choose the buffer mode ONCE, connect to the host before
 * touching the screen (connection errors print normally through the CliError path), resolve what to open, open the
 * session, then take the terminal (raw mode, bracketed paste, alternate screen) and render Ink over a stdin it never
 * reads. Raw stdin goes through KeyParser (a 50 ms timer flushes a lone ESC) into the App's one dispatcher.
 */
import { PassThrough } from 'node:stream'
import { render } from 'ink'
import { createElement } from 'react'
import { CliError, EXIT, type CliContext } from '../types'
import { App, type ExitInfo, type InputSource } from './App'
import { KeyParser } from './input/keys'
import { sanitizeTty } from './sanitizeTty'
import { connectTuiHost, openTuiSession } from './session'
import { SEQ, chooseBufferMode, createTerminal, gateWrites } from './terminal'
import { terminalThemeFor } from './theme'
import type { BufferMode, InputEvent, OpenTuiSessionOptions, TuiEnv, TuiHostConnection, TuiLaunch } from './types'

export const NO_TTY_MESSAGE = 'The terminal UI needs a terminal; use orgai exec for scripts.'
export const DETACHED_MESSAGE = 'Detached; the run keeps going.'
/** A lone ESC is a key of its own after this long without the rest of a sequence. */
export const ESC_FLUSH_MS = 50
/** Console lines kept while the TUI owns the screen (printed to stderr afterwards). */
const CONSOLE_KEEP = 200

export interface TuiFlags {
  inline: boolean
  screenReader: boolean
}

export interface RunTuiOptions {
  /** Resolve what to open once connected (run refs, onboarding); commands/tui.ts supplies it. */
  prepare?(conn: TuiHostConnection): Promise<TuiLaunch>
  stdin?: NodeJS.ReadStream
  stdout?: NodeJS.WriteStream
  stderr?: { write(s: string): unknown }
}

/** The TuiEnv for this process (colour, TERM=dumb, Unicode). */
export function tuiEnvFor(ctx: Pick<CliContext, 'env' | 'globals' | 'platform'>, flags: TuiFlags, bufferMode: BufferMode): TuiEnv {
  const dumb = ctx.env.TERM === 'dumb'
  const locale = ctx.env.LC_ALL || ctx.env.LC_CTYPE || ctx.env.LANG || ''
  return {
    bufferMode,
    screenReader: flags.screenReader,
    color: ctx.globals.color && !ctx.env.NO_COLOR,
    dumbTerminal: dumb,
    bracketedPaste: !dumb,
    terminalTheme: terminalThemeFor(ctx.env),
    unicode: !dumb && (ctx.platform === 'win32' || /utf-?8/i.test(locale)),
    ...(ctx.env.ORGAI_REDUCED_MOTION === '1' ? { reducedMotion: true } : {})
  }
}

/** Raw stdin -> KeyParser -> InputEvents, with the lone-ESC flush timer. */
export function keyInput(stdin: NodeJS.ReadStream, bracketedPaste: boolean, timers: { set: typeof setTimeout; clear: typeof clearTimeout } = { set: setTimeout, clear: clearTimeout }): InputSource & { close(): void } {
  const parser = new KeyParser({ bracketedPaste })
  const listeners = new Set<(e: InputEvent) => void>()
  let timer: ReturnType<typeof setTimeout> | undefined
  const emit = (events: InputEvent[]): void => {
    for (const e of events) for (const fn of [...listeners]) fn(e)
  }
  const onData = (chunk: Buffer | string): void => {
    if (timer !== undefined) timers.clear(timer)
    emit(parser.feed(typeof chunk === 'string' ? chunk : chunk.toString('utf8')))
    timer = timers.set(() => {
      timer = undefined
      emit(parser.flush())
    }, ESC_FLUSH_MS)
  }
  stdin.on('data', onData)
  return {
    subscribe(fn) {
      listeners.add(fn)
      return () => void listeners.delete(fn)
    },
    close() {
      stdin.off('data', onData)
      if (timer !== undefined) timers.clear(timer)
      listeners.clear()
    }
  }
}

type ConsoleMethod = 'log' | 'info' | 'warn' | 'error' | 'debug'
const CONSOLE_METHODS: readonly ConsoleMethod[] = ['log', 'info', 'warn', 'error', 'debug']

/** Nothing else may write to the screen while Ink draws: console output is held and printed after restoring. */
function holdConsole(): () => string[] {
  const saved = CONSOLE_METHODS.map((m) => [m, console[m]] as const)
  const held: string[] = []
  for (const m of CONSOLE_METHODS) {
    console[m] = (...args: unknown[]): void => {
      if (m === 'debug' || m === 'log' || m === 'info') return
      if (held.length < CONSOLE_KEEP) held.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '))
    }
  }
  return () => {
    for (const [m, fn] of saved) console[m] = fn
    return held
  }
}

export async function runTui(ctx: CliContext, launch: TuiLaunch, flags: TuiFlags, opts: RunTuiOptions = {}): Promise<number> {
  const stdin = opts.stdin ?? process.stdin
  const stdout = opts.stdout ?? process.stdout
  const stderr = opts.stderr ?? process.stderr
  if (!ctx.io.stdinIsTTY || ctx.io.stdout.isTTY !== true) throw new CliError(NO_TTY_MESSAGE, EXIT.usage)

  const bufferMode = chooseBufferMode({
    isTTY: stdout.isTTY === true,
    cols: stdout.columns ?? 0,
    rows: stdout.rows ?? 0,
    inline: flags.inline,
    screenReader: flags.screenReader,
    ...(ctx.env.TERM !== undefined ? { term: ctx.env.TERM } : {})
  })
  const env = tuiEnvFor(ctx, flags, bufferMode)

  // Connect before the alternate screen: refusals and errors print as usual.
  const conn = await connectTuiHost(ctx)
  const stopInproc = conn.inproc !== undefined
  let session
  let resolved: TuiLaunch
  try {
    resolved = opts.prepare ? await opts.prepare(conn) : launch
    const sessionOpts: OpenTuiSessionOptions = {
      folder: resolved.onboarding?.folder ?? ctx.cwd,
      ...(resolved.project ? { project: resolved.project } : {}),
      ...(resolved.runId ? { runId: resolved.runId } : {}),
      ...(resolved.readOnlyReason ? { readOnlyReason: resolved.readOnlyReason } : {})
    }
    session = await openTuiSession(conn, sessionOpts)
  } catch (e) {
    await conn.close({ stopInproc }).catch(() => undefined)
    throw e
  }

  // The in-process host already logs to its file only (context.ts quietInproc); anything else is held.
  const releaseConsole = conn.inproc ? () => [] as string[] : holdConsole()
  const terminal = createTerminal({ stdout, stdin, bufferMode, bracketedPaste: env.bracketedPaste })
  const input = keyInput(stdin, env.bracketedPaste)
  let result: { code: number; info?: ExitInfo; error?: unknown } | undefined
  let finish!: (r: { code: number; info?: ExitInfo; error?: unknown }) => void
  const exited = new Promise<{ code: number; info?: ExitInfo; error?: unknown }>((r) => {
    finish = (x) => {
      if (result) return
      result = x
      r(x)
    }
  })

  terminal.enter()
  const inkStdin = Object.assign(new PassThrough(), { isTTY: false }) as unknown as NodeJS.ReadStream
  const instance = render(
    createElement(App, {
      session,
      terminal,
      env,
      launch: resolved,
      conn,
      input,
      processEnv: ctx.env,
      openSession: (o: OpenTuiSessionOptions) => openTuiSession(conn, o),
      onExit: (code: number, info?: ExitInfo) => finish({ code, ...(info ? { info } : {}) })
    }),
    {
      // Ink never paints while the pager (or a stop) owns the terminal; see gateWrites.
      stdout: gateWrites(stdout, () => terminal.suspended, env.bufferMode === 'fullscreen'),
      stdin: inkStdin,
      stderr: stdout,
      exitOnCtrlC: false,
      patchConsole: false,
      interactive: stdout.isTTY === true,
      alternateScreen: false,
      isScreenReaderEnabled: env.screenReader
    }
  )
  // After SIGCONT or the pager the screen holds someone else's output: redraw from scratch.
  const offResume = terminal.onResume(() => {
    if (bufferMode === 'fullscreen') stdout.write(SEQ.clear)
    instance.clear()
  })
  instance.waitUntilExit().then(
    () => finish({ code: EXIT.ok }),
    (error: unknown) => finish({ code: EXIT.failure, error })
  )

  const { code, info, error } = await exited
  input.close()
  offResume()
  try {
    instance.unmount()
  } catch {
    // Already unmounted (a render error).
  }
  terminal.restore()
  const held = releaseConsole()
  for (const line of held) stderr.write(`orgai: ${sanitizeTty(line)}\n`)
  if (error) stderr.write(`orgai: ${sanitizeTty(error instanceof Error ? error.message : String(error))}\n`)
  const last = info?.session ?? session
  await last.close().catch(() => undefined)
  if (last !== session) await session.close().catch(() => undefined)
  await conn.close({ stopInproc }).catch((e: unknown) => {
    stderr.write(`orgai: Could not stop the in-process host: ${sanitizeTty(e instanceof Error ? e.message : String(e))}\n`)
  })
  if (info?.message) stderr.write(`${sanitizeTty(info.message).replace(/\s+/g, ' ').trim()}\n`)
  else if (info?.detachedLive && !stopInproc) stderr.write(`${DETACHED_MESSAGE}\n`)
  return code
}
