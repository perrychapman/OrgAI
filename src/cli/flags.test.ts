import { describe, expect, it } from 'vitest'
import { parseFlags, splitGlobalFlags } from './flags'
import { CliError, EXIT } from './types'

const usageError = (fn: () => unknown): CliError => {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(CliError)
    expect((e as CliError).exitCode).toBe(EXIT.usage)
    return e as CliError
  }
  throw new Error('expected a usage error')
}

describe('parseFlags', () => {
  const spec = {
    all: { type: 'boolean', short: 'a' },
    limit: { type: 'string', short: 'n' },
    tag: { type: 'string', multiple: true }
  } as const

  it('parses long, inline, short, boolean and repeated flags around positionals', () => {
    const r = parseFlags(['list', '--limit', '5', '-a', '--tag=x', 'more', '--tag', 'y'], spec)
    expect(r.values).toEqual({ limit: '5', all: true, tag: ['x', 'y'] })
    expect(r.positionals).toEqual(['list', 'more'])
    expect(parseFlags(['-n', '3', '-'], spec)).toEqual({ values: { limit: '3' }, positionals: ['-'] })
  })

  it('an optionalValue flag reads true alone, takes only an attached value and never the next argument', () => {
    const s = { evolve: { type: 'string', optionalValue: true }, quiet: { type: 'boolean' } } as const
    expect(parseFlags(['--evolve', 'prompt text', '--quiet'], s)).toEqual({ values: { evolve: true, quiet: true }, positionals: ['prompt text'] })
    expect(parseFlags(['--evolve=hybrid', 'p'], s)).toEqual({ values: { evolve: 'hybrid' }, positionals: ['p'] })
    expect(() => parseFlags(['--evolve', '--evolve=hybrid'], s)).toThrow(/more than once/)
    expect(() => parseFlags(['--evolve=a', '--evolve'], s)).toThrow(/more than once/)
  })

  it('stops at -- and keeps dashes after it as positionals', () => {
    const r = parseFlags(['--all', '--', '--limit', '-x'], spec)
    expect(r.values).toEqual({ all: true })
    expect(r.positionals).toEqual(['--limit', '-x'])
  })

  it('refuses unknown flags, missing values, values on booleans and a repeated single flag with exit 2', () => {
    usageError(() => parseFlags(['--nope'], spec))
    usageError(() => parseFlags(['-z'], spec))
    usageError(() => parseFlags(['--limit'], spec))
    usageError(() => parseFlags(['--all=yes'], spec))
    usageError(() => parseFlags(['--limit', '1', '--limit', '2'], spec))
    usageError(() => parseFlags(['--__proto__'], spec))
  })
})

describe('splitGlobalFlags', () => {
  it('defaults', () => {
    expect(splitGlobalFlags([])).toEqual({ globals: { outputFormat: 'text', color: true, secretEnv: [] }, rest: [] })
  })

  it('pulls global flags from anywhere before --', () => {
    const r = splitGlobalFlags(['runs', '--data-dir', '/d', 'list', '--limit', '3', '--output-format', 'json', '--no-color', '--project', 'p1'])
    expect(r.globals).toEqual({ dataDir: '/d', outputFormat: 'json', color: false, project: 'p1', secretEnv: [] })
    expect(r.rest).toEqual(['runs', 'list', '--limit', '3'])
  })

  it('leaves everything after -- alone', () => {
    const r = splitGlobalFlags(['exec', '--', '--host', 'daemon', '--no-color'])
    expect(r.globals.color).toBe(true)
    expect(r.rest).toEqual(['exec', '--', '--host', 'daemon', '--no-color'])
  })

  it('collects repeated --secret-env', () => {
    const r = splitGlobalFlags(['--secret-env', 'lib:env:A=ENV_A', 'exec', '--secret-env=lib:env:B=ENV_B'])
    expect(r.globals.secretEnv).toEqual(['lib:env:A=ENV_A', 'lib:env:B=ENV_B'])
    expect(r.rest).toEqual(['exec'])
  })

  it('refuses bad values, missing values and repeats with exit 2', () => {
    usageError(() => splitGlobalFlags(['--host', 'inproc']))
    usageError(() => splitGlobalFlags(['--host=daemon']))
    usageError(() => splitGlobalFlags(['--output-format', 'yaml']))
    usageError(() => splitGlobalFlags(['--data-dir']))
    usageError(() => splitGlobalFlags(['--project=']))
    usageError(() => splitGlobalFlags(['--data-dir', '/a', '--data-dir', '/b']))
  })
})
