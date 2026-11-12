import { describe, expect, it } from 'vitest'
import { parseDefaultTuiArgs } from './commands/tui'
import { DEFAULT_TUI_FLAGS } from './commandTable'
import { interactiveOverrides, parseSlashRunArgs, SLASH_RUN_FLAG_NAMES } from './runStartFlags'
import { EXIT } from './types'

describe('parseSlashRunArgs (/new, /ask)', () => {
  it('takes leading flags in every form and keeps the prompt as typed', () => {
    expect(parseSlashRunArgs('--goal speed --strict-delegation fix the bug')).toEqual({ prompt: 'fix the bug', overrides: { goal: 'speed', strictDelegation: true } })
    expect(parseSlashRunArgs('--permission-mode=plan  line one\nline two')).toEqual({ prompt: 'line one\nline two', overrides: { permissionMode: 'plan' } })
    expect(parseSlashRunArgs('fix --goal later')).toEqual({ prompt: 'fix --goal later' })
    expect(parseSlashRunArgs('--goal cost')).toEqual({ prompt: '', overrides: { goal: 'cost' } })
    expect(parseSlashRunArgs('-- --goal is text')).toEqual({ prompt: '--goal is text' })
    expect(parseSlashRunArgs('')).toEqual({ prompt: '' })
  })

  it("validates with exec's parsers; other options are refused", () => {
    expect(() => parseSlashRunArgs('--goal fastest go')).toThrow(expect.objectContaining({ exitCode: EXIT.usage, message: '--goal must be one of balanced, speed, cost.' }))
    expect(() => parseSlashRunArgs('--permission-mode yolo go')).toThrow(/--permission-mode must be one of/)
    expect(() => parseSlashRunArgs('--goal')).toThrow('Option --goal needs a value.')
    expect(() => parseSlashRunArgs('--goal speed --goal cost x')).toThrow('more than once')
    expect(() => parseSlashRunArgs('--max-budget 2 go')).toThrow('Unknown option --max-budget. Use --goal, --permission-mode, --strict-delegation, or put the prompt after --.')
    expect(SLASH_RUN_FLAG_NAMES).toEqual(['goal', 'permission-mode', 'strict-delegation'])
  })
})

describe('interactiveOverrides', () => {
  it('never sets execMode; refuses headless-only flags', () => {
    expect(interactiveOverrides({ goal: 'speed', 'max-budget': '2.5', 'no-auto-continue': true })).toEqual({ goal: 'speed', maxBudgetUsd: 2.5, autoContinue: false })
    expect(interactiveOverrides({})).toBeUndefined()
    expect(() => interactiveOverrides({ 'on-permission': 'deny' })).toThrow('--on-permission applies to headless runs only (orgai exec)')
    expect(() => interactiveOverrides({ 'wait-for-reset': true })).toThrow(/headless runs only/)
  })
})

describe('bare orgai run flags', () => {
  it('parses the exec run flags for the first run, with or without a prompt', () => {
    expect(parseDefaultTuiArgs(['--goal', 'cost', '--strict-delegation', '--', 'build it'])).toMatchObject({ prompt: 'build it', overrides: { goal: 'cost', strictDelegation: true } })
    expect(parseDefaultTuiArgs(['--permission-mode', 'acceptEdits'])).toMatchObject({ prompt: '', overrides: { permissionMode: 'acceptEdits' } })
    expect(parseDefaultTuiArgs(['--inline']).overrides).toBeUndefined()
    expect(() => parseDefaultTuiArgs(['--max-budget', 'x'])).toThrow('--max-budget needs an amount in USD (0 or more).')
    expect(() => parseDefaultTuiArgs(['--on-question', 'fail'])).toThrow(/headless runs only/)
  })

  it('the help and the router know the flags', () => {
    const names = DEFAULT_TUI_FLAGS.map((f) => f.name)
    for (const n of ['goal', 'permission-mode', 'strict-delegation', 'max-budget', 'no-auto-continue']) expect(names).toContain(n)
    expect(names).not.toContain('on-permission')
  })
})
