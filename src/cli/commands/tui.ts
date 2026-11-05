/**
 * TUI commands (cli-spec 5; routing lands with W4-T5): `orgai tui`, `orgai attach`, bare `orgai` / `orgai -- <prompt>`
 * and `orgai resume` without --exec. Never statically imports react, ink or any ../tui/*.tsx: the TUI is reached only
 * through `await import('../tui/index')` (the out/cli/tui.mjs chunk; lazyTui.test.ts). Stubs until W4-T5 lands.
 */
import type { CliContext, CommandFn } from '../types'

export const runTuiCommand: CommandFn = async (ctx, args) => {
  void [ctx, args]
  const { runTui } = await import('../tui/index')
  void runTui
  throw new Error('not implemented (Wave 4)')
}

export const runAttach: CommandFn = async (ctx, args) => {
  void [ctx, args]
  throw new Error('not implemented (Wave 4)')
}

export async function runDefaultTui(ctx: CliContext, args: string[]): Promise<number> {
  void [ctx, args]
  throw new Error('not implemented (Wave 4)')
}

export async function runResumeTui(ctx: CliContext, args: string[]): Promise<number> {
  void [ctx, args]
  throw new Error('not implemented (Wave 4)')
}
