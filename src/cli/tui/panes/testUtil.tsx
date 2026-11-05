/**
 * Test helpers for the pane tests (never imported by app code): an env + InputBus provider, key events and a way to
 * turn on Ink's colour output inside vitest, where chalk detects no colour support.
 */
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ReactNode } from 'react'
import { DEFAULT_TUI_ENV, InputBus, InputBusContext, TuiEnvContext } from '../context'
import type { FocusTarget, InputEvent, KeyEvent, KeyName, TuiEnv } from '../types'

export const FULL_ENV: TuiEnv = {
  ...DEFAULT_TUI_ENV,
  bufferMode: 'fullscreen',
  color: true,
  unicode: true,
  bracketedPaste: true
}

export function env(over: Partial<TuiEnv> = {}): TuiEnv {
  return { ...FULL_ENV, ...over }
}

export function Providers(props: { env: TuiEnv; bus: InputBus; children: ReactNode }) {
  return (
    <TuiEnvContext.Provider value={props.env}>
      <InputBusContext.Provider value={props.bus}>{props.children}</InputBusContext.Provider>
    </TuiEnvContext.Provider>
  )
}

export function key(name: KeyName, over: Partial<KeyEvent> = {}): InputEvent {
  return { type: 'key', name, ctrl: false, alt: false, shift: false, raw: '', ...over }
}

export function char(ch: string): InputEvent {
  return key('char', { ch, raw: ch })
}

export function press(bus: InputBus, target: FocusTarget, ...events: InputEvent[]): boolean[] {
  return events.map((e) => bus.dispatch(e, target))
}

/** Ink's own chalk (nested under ink/node_modules), so a test can set its level; undefined when not found. */
export async function inkChalk(): Promise<{ level: number } | undefined> {
  try {
    const path = realpathSync(join(process.cwd(), 'node_modules', 'ink', 'node_modules', 'chalk', 'source', 'index.js'))
    const mod = (await import(pathToFileURL(path).href)) as { default: { level: number } }
    return mod.default
  } catch {
    return undefined
  }
}

/** Runs `fn` with Ink colour output on (chalk level 1), restoring the level after. */
export async function withInkColor<T>(fn: () => T | Promise<T>): Promise<T> {
  const chalk = await inkChalk()
  const before = chalk?.level ?? 0
  if (chalk) chalk.level = 1
  try {
    return await fn()
  } finally {
    if (chalk) chalk.level = before
  }
}

/** Escape sequences in a frame (SGR codes and anything else starting with ESC). */
export const ESC_RE = /\x1b\[/
