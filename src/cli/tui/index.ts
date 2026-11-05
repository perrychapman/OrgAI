/**
 * The lazy TUI entry (built as out/cli/tui.mjs). Only reached through `await import('../tui/index')` from
 * commands/tui.ts, so ink and react load only when the TUI starts (lazyTui.test.ts). Stub until W4-T5 lands.
 */
import type { CliContext } from '../types'
import { App } from './App'
import type { TuiLaunch } from './types'

export async function runTui(ctx: CliContext, launch: TuiLaunch, flags: { inline: boolean; screenReader: boolean }): Promise<number> {
  void [ctx, launch, flags, App]
  throw new Error('not implemented (Wave 4)')
}
