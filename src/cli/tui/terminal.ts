/**
 * Terminal lifecycle (W4-T5): buffer mode chosen once at startup and kept across resize, SIGTSTP / SIGCONT and the
 * pager; raw mode, bracketed paste and alternate screen; crash, exit and signal cleanup. Stub until W4-T5 lands.
 */
import type { BufferMode, TerminalController } from './types'

export function chooseBufferMode(input: {
  isTTY: boolean
  cols: number
  rows: number
  inline: boolean
  screenReader: boolean
  term?: string
}): BufferMode {
  void input
  throw new Error('not implemented (Wave 4)')
}

export function createTerminal(opts: {
  stdout: NodeJS.WriteStream
  stdin: NodeJS.ReadStream
  bufferMode: BufferMode
  bracketedPaste: boolean
  proc?: NodeJS.Process
}): TerminalController {
  void opts
  throw new Error('not implemented (Wave 4)')
}
