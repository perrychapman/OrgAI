/**
 * `orgai terminal-access [on|off] [--level full|operate]` (Wave 7, cli-standalone.md 4.2.1, round 6 item 11): shows
 * or changes the stored Terminal access on a machine without the app.
 *
 * - No argument and no --level: prints the stored state (reads settings.json only; works while a host runs).
 * - `on` / `off` / `--level`: runs only when no host owns the data folder. It takes `<data>/run/startup.mkdir`,
 *   re-checks daemon.json inside it, writes terminalServer + terminalServerChosen and / or terminalAccessLevel +
 *   terminalAccessLevelChosen, and releases (terminalAccessSettings.ts writeTerminalAccess). A running host refuses it
 *   (exit 1: stop the background host first, or change it in the app); a startup mutex held past its wait is exit 6.
 *
 * Agents cannot run it: the self-control gate denies the orgai command. It never connects to a host.
 */
import type { TerminalAccessLevel } from '../../shared/types'
import { parseFlags } from '../flags'
import { emit, safeLine } from '../output'
import { LEVEL_WORDS, readStoredTerminalAccess, writeTerminalAccess, type StoredTerminalAccess, type TerminalAccessChange } from '../terminalAccessSettings'
import { CliError, EXIT, type CliContext, type CommandFn } from '../types'

/** Swappable in tests (the mutex options: liveness and waits). */
export const terminalAccessDeps = {
  write: (dataDir: string, change: TerminalAccessChange): Promise<StoredTerminalAccess> => writeTerminalAccess(dataDir, change)
}

function json(s: StoredTerminalAccess, changed: boolean): Record<string, string | boolean> {
  return {
    changed,
    terminalServer: s.terminalServer,
    terminalServerChosen: s.terminalServerChosen,
    terminalAccessLevel: s.level,
    terminalAccessLevelChosen: s.levelChosen,
    enabledForBackgroundHosts: s.enabledForBackground
  }
}

function lines(ctx: CliContext, s: StoredTerminalAccess, changed: boolean): string[] {
  const state = s.terminalServerChosen
    ? s.terminalServer
      ? 'on'
      : 'off'
    : 'not chosen (a background host started from a terminal accepts terminal clients for its own session)'
  const level = `${s.level}${s.levelChosen ? '' : ' (not chosen yet)'}: ${LEVEL_WORDS[s.level]}`
  return [
    `${changed ? 'Saved. ' : ''}Terminal access: ${state}.`,
    `  Level: ${level}.`,
    `  Data folder: ${safeLine(ctx.paths.dataDir)}`
  ]
}

export const runTerminalAccess: CommandFn = async (ctx: CliContext, args: string[]): Promise<number> => {
  const { values, positionals } = parseFlags(args, { level: { type: 'string' } })
  if (positionals.length > 1) throw new CliError(`Unexpected argument "${positionals[1]}".`, EXIT.usage)
  const word = positionals[0]
  if (word !== undefined && word !== 'on' && word !== 'off') throw new CliError(`Use: orgai terminal-access [on|off] [--level full|operate] (got "${word}").`, EXIT.usage)
  const raw = values.level
  if (raw !== undefined && raw !== 'full' && raw !== 'operate') throw new CliError('--level must be full or operate.', EXIT.usage)
  const level = raw as TerminalAccessLevel | undefined

  if (word === undefined && level === undefined) {
    const s = readStoredTerminalAccess(ctx.paths.dataDir)
    emit(ctx, json(s, false), () => lines(ctx, s, false))
    return EXIT.ok
  }
  const change: TerminalAccessChange = {
    ...(word !== undefined ? { on: word === 'on' } : {}),
    ...(level !== undefined ? { level } : {})
  }
  const s = await terminalAccessDeps.write(ctx.paths.dataDir, change)
  emit(ctx, json(s, true), () => lines(ctx, s, true))
  return EXIT.ok
}
