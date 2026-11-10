/**
 * Run-start flags of the terminal UI (cli-parity 3.5): bare `orgai` takes exec's run flags for the first run it starts,
 * `/new` and `/ask` take `--goal`, `--permission-mode` and `--strict-delegation`. Validation is exec's own
 * (commands/exec.ts overridesFromFlags), so every surface accepts and refuses the same values. The TUI's runs are not
 * headless: the result never carries `execMode`, and exec's headless-only flags (card policies, stall timeout, waiting
 * for a usage reset, unmerged branches, peer messages) are refused with a pointer to `orgai exec`, since nothing would
 * act on them in an interactive run.
 */
import type { RunOverrides } from '../shared/types'
import { overridesFromFlags } from './commands/exec'
import { TUI_RUN_FLAG_NAMES, findCommand } from './commandTable'
import { parseFlags, type FlagSpec } from './flags'
import { CliError, EXIT } from './types'

/** Exec flags the terminal UI's first run takes (bare `orgai`); defined beside DEFAULT_TUI_FLAGS. */
export { TUI_RUN_FLAG_NAMES }

/** Flags of /new and /ask. */
export const SLASH_RUN_FLAG_NAMES: readonly string[] = ['goal', 'permission-mode', 'strict-delegation']

/** Exec's run flags (the `exec` entry minus how the prompt and the run start are given). */
export function execRunFlags(): FlagSpec {
  const spec: FlagSpec = {}
  const startOnly = new Set(['prompt-file', 'team', 'quick', 'allow-edits', 'create-project'])
  for (const f of findCommand('exec')?.flags ?? []) if (!startOnly.has(f.name)) spec[f.name] = { type: f.takesValue ? 'string' : 'boolean' }
  return spec
}

/**
 * RunOverrides for an interactive run from parsed exec flag values: only `allowed` names may be set (any other exec run
 * flag is a usage error naming `orgai exec`), validated by overridesFromFlags, `execMode` dropped. undefined = none.
 */
export function interactiveOverrides(values: Record<string, unknown>, allowed: readonly string[] = TUI_RUN_FLAG_NAMES): RunOverrides | undefined {
  const spec = execRunFlags()
  const headless = Object.keys(spec).find((name) => values[name] !== undefined && !allowed.includes(name))
  if (headless) throw new CliError(`--${headless} applies to headless runs only (orgai exec); here you answer the run yourself.`, EXIT.usage)
  const picked: Record<string, string | boolean | undefined> = {}
  for (const name of allowed) if (values[name] !== undefined) picked[name] = values[name] as string | boolean
  if (Object.keys(picked).length === 0) return undefined
  const { execMode: _exec, ...rest } = overridesFromFlags(picked)
  return Object.keys(rest).length ? rest : undefined
}

/**
 * `/new [--goal g] [--permission-mode m] [--strict-delegation] [--] [prompt]`: the leading flags (each `--name value`,
 * `--name=value` or the boolean) and the prompt after them, as typed. An unknown leading option is an error (a prompt
 * that starts with `--` goes after `--`).
 */
export function parseSlashRunArgs(args: string): { prompt: string; overrides?: RunOverrides } {
  const spec: FlagSpec = {}
  const all = execRunFlags()
  for (const name of SLASH_RUN_FLAG_NAMES) spec[name] = all[name]
  const tokens: string[] = []
  let rest = args.trimStart()
  for (;;) {
    const m = /^(\S+)(\s+|$)/.exec(rest)
    if (!m || !m[1].startsWith('--')) break
    if (m[1] === '--') {
      rest = rest.slice(m[0].length)
      break
    }
    const name = m[1].slice(2).split('=')[0]
    if (!Object.hasOwn(spec, name)) throw new CliError(`Unknown option --${name}. Use ${SLASH_RUN_FLAG_NAMES.map((n) => `--${n}`).join(', ')}, or put the prompt after --.`, EXIT.usage)
    tokens.push(m[1])
    rest = rest.slice(m[0].length)
    if (spec[name].type === 'string' && !m[1].includes('=')) {
      const v = /^(\S+)(\s+|$)/.exec(rest)
      if (!v) throw new CliError(`Option --${name} needs a value.`, EXIT.usage)
      tokens.push(v[1])
      rest = rest.slice(v[0].length)
    }
  }
  const { values } = parseFlags(tokens, spec)
  const overrides = interactiveOverrides(values as Record<string, unknown>, SLASH_RUN_FLAG_NAMES)
  return { prompt: rest.trim(), ...(overrides ? { overrides } : {}) }
}
