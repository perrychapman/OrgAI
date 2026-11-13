/**
 * Argument parsing for the CLI (cli-spec 6.1). No dependency: a small strict parser. Unknown flags are usage errors
 * (exit 2); `--` ends flag parsing and everything after it is positional (a prompt may start with '-').
 */
import { CliError, EXIT, type CliGlobals, type OutputFormat } from './types'

export interface FlagDef {
  type: 'string' | 'boolean'
  /** One-letter alias, without the dash. */
  short?: string
  /** string flags only: may repeat; the value is then a string[]. */
  multiple?: boolean
  /**
   * string flags only: `--name` alone is allowed and reads as `true`; a value must be attached (`--name=value`), it never
   * takes the next argument (so `--evolve "do the task"` keeps the prompt positional).
   */
  optionalValue?: boolean
}

export type FlagSpec = Record<string, FlagDef>

/** Parsed values: boolean flags are booleans, multiple string flags string[], other string flags a string. */
export type FlagValues<S extends FlagSpec> = {
  [K in keyof S]?: S[K]['type'] extends 'boolean' ? boolean : S[K]['multiple'] extends true ? string[] : S[K]['optionalValue'] extends true ? string | boolean : string
}

export interface ParsedFlags<S extends FlagSpec> {
  values: FlagValues<S>
  positionals: string[]
}

const usage = (message: string): CliError => new CliError(message, EXIT.usage)

/**
 * Parse `args` against `spec`. Accepted: `--name value`, `--name=value`, `-x value`, `--bool`, `-b`; a lone `-` is a
 * positional (stdin). A string flag without a value, `--bool=x`, a repeated single flag or an unknown flag throws
 * CliError(exit 2).
 */
export function parseFlags<S extends FlagSpec>(args: readonly string[], spec: S): ParsedFlags<S> {
  const values: Record<string, unknown> = {}
  const positionals: string[] = []
  const byShort = new Map<string, string>()
  for (const [name, def] of Object.entries(spec)) if (def.short) byShort.set(def.short, name)

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') {
      positionals.push(...args.slice(i + 1))
      break
    }
    if (arg === '-' || !arg.startsWith('-')) {
      positionals.push(arg)
      continue
    }
    let name: string | undefined
    let inline: string | undefined
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=')
      const raw = eq === -1 ? arg.slice(2) : arg.slice(2, eq)
      if (eq !== -1) inline = arg.slice(eq + 1)
      name = Object.hasOwn(spec, raw) ? raw : undefined
      if (!name) throw usage(`Unknown option --${raw}.`)
    } else {
      const short = arg.slice(1)
      name = short.length === 1 ? byShort.get(short) : undefined
      if (!name) throw usage(`Unknown option ${arg}.`)
    }
    const def = spec[name]
    if (def.type === 'boolean') {
      if (inline !== undefined) throw usage(`Option --${name} takes no value.`)
      values[name] = true
      continue
    }
    let value = inline
    if (value === undefined && def.optionalValue) {
      if (values[name] !== undefined) throw usage(`Option --${name} was given more than once.`)
      values[name] = true
      continue
    }
    if (value === undefined) {
      if (i + 1 >= args.length) throw usage(`Option --${name} needs a value.`)
      value = args[++i]
    }
    if (def.multiple) {
      const list = (values[name] as string[] | undefined) ?? []
      list.push(value)
      values[name] = list
    } else {
      if (values[name] !== undefined) throw usage(`Option --${name} was given more than once.`)
      values[name] = value
    }
  }
  return { values: values as FlagValues<S>, positionals }
}

const OUTPUT_FORMATS: readonly OutputFormat[] = ['text', 'json', 'stream-json']

/** Global flags that take a value. */
const GLOBAL_VALUE_FLAGS = new Set(['--data-dir', '--output-format', '--project', '--secret-env'])

/**
 * Pull the global flags (--data-dir <dir>, --output-format text|json|stream-json,
 * --project <id-or-path>, --no-color, repeated --secret-env <spec>) out of `argv` from anywhere before `--`; `rest`
 * keeps everything else in order, including `--` and what follows it. Bad values throw CliError(exit 2).
 */
export function splitGlobalFlags(argv: readonly string[]): { globals: CliGlobals; rest: string[] } {
  const globals: CliGlobals = { outputFormat: 'text', color: true, secretEnv: [] }
  const rest: string[] = []
  const seen = new Set<string>()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') {
      rest.push(...argv.slice(i))
      break
    }
    if (arg === '--no-color') {
      globals.color = false
      continue
    }
    const eq = arg.indexOf('=')
    const flag = arg.startsWith('--') && eq !== -1 ? arg.slice(0, eq) : arg
    if (flag === '--host') throw usage('Option --host is gone: orgai always runs its own host in this process.')
    if (!GLOBAL_VALUE_FLAGS.has(flag)) {
      rest.push(arg)
      continue
    }
    let value: string
    if (eq !== -1 && flag !== arg) value = arg.slice(eq + 1)
    else {
      if (i + 1 >= argv.length) throw usage(`Option ${flag} needs a value.`)
      value = argv[++i]
    }
    if (flag !== '--secret-env') {
      if (seen.has(flag)) throw usage(`Option ${flag} was given more than once.`)
      seen.add(flag)
    }
    switch (flag) {
      case '--data-dir':
        if (!value) throw usage('Option --data-dir needs a folder.')
        globals.dataDir = value
        break
      case '--output-format':
        if (!(OUTPUT_FORMATS as readonly string[]).includes(value)) throw usage(`Option --output-format must be one of ${OUTPUT_FORMATS.join(', ')}.`)
        globals.outputFormat = value as OutputFormat
        break
      case '--project':
        if (!value) throw usage('Option --project needs a project id or folder.')
        globals.project = value
        break
      case '--secret-env':
        if (!value) throw usage('Option --secret-env needs <owner>:<kind>:<name>=<ENV_VAR>.')
        globals.secretEnv.push(value)
        break
    }
  }
  return { globals, rest }
}
