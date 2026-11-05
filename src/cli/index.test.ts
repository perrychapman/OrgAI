import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CliContext } from './types'

const calls: { name: string; args: string[]; ctx: CliContext }[] = []
const stub = (name: string) =>
  vi.fn(async (ctx: CliContext, args: string[]) => {
    calls.push({ name, args, ctx })
    return 0
  })

vi.mock('./commands/status', () => ({ runStatus: stub('status') }))
vi.mock('./commands/runs', () => ({ runRuns: stub('runs') }))
vi.mock('./commands/watch', () => ({ runWatch: stub('watch') }))
vi.mock('./commands/inbox', () => ({ runInbox: stub('inbox') }))
vi.mock('./commands/daemon', () => ({ runDaemon: stub('daemon') }))
vi.mock('./commands/app', () => ({ runApp: stub('app') }))
vi.mock('./commands/doctor', () => ({
  runDoctor: vi.fn(async () => {
    throw new Error('boom')
  })
}))
vi.mock('./commands/completions', () => ({ runCompletions: stub('completions') }))

const { main, editDistance, TUI_LATER_NOTE } = await import('./index')
const { CLI_VERSION } = await import('./version')
const { SECRET_ENV_REFUSAL } = await import('./secretOverlay')

function io() {
  const o = { out: '', err: '' }
  return {
    o,
    io: {
      stdout: { write: (s: string) => void (o.out += s), isTTY: true },
      stderr: { write: (s: string) => void (o.err += s) },
      stdinIsTTY: false
    }
  }
}

const run = async (argv: string[], env: NodeJS.ProcessEnv = {}) => {
  const t = io()
  const code = await main(argv, { env, cwd: '/tmp', platform: 'linux', io: t.io })
  return { code, ...t.o }
}

beforeEach(() => {
  calls.length = 0
})

describe('orgai routing', () => {
  it('routes each Wave 2 command with its arguments', async () => {
    for (const [argv, name, args] of [
      [['status'], 'status', []],
      [['runs', 'list', '--limit', '3'], 'runs', ['list', '--limit', '3']],
      [['--project', 'p1', 'runs', 'show', 'R2'], 'runs', ['show', 'R2']],
      [['watch', 'R1'], 'watch', ['R1']],
      [['inbox', '--all-projects'], 'inbox', ['--all-projects']],
      [['daemon', 'stop', '--force'], 'daemon', ['stop', '--force']],
      [['app', '--run', 'R1'], 'app', ['--run', 'R1']],
      [['completions', 'zsh'], 'completions', ['zsh']]
    ] as const) {
      calls.length = 0
      const r = await run([...argv])
      expect(r.code, argv.join(' ')).toBe(0)
      expect(calls).toHaveLength(1)
      expect(calls[0].name).toBe(name)
      expect(calls[0].args).toEqual(args)
    }
  })

  it('builds the context from the globals', async () => {
    await run(['--data-dir', '/d/ud', '--project', 'p1', '--no-color', 'status'])
    const ctx = calls[0].ctx
    expect(ctx.paths).toEqual({ userDataDir: '/d/ud', dataDir: '/d/ud/data' })
    expect(ctx.globals).toMatchObject({ project: 'p1', color: false, host: 'auto' })
    expect(ctx.version).toBe(CLI_VERSION)
    await run(['status'], { NO_COLOR: '1' })
    expect(calls[1].ctx.globals.color).toBe(false)
    await run(['status'])
    expect(calls[2].ctx.globals.color).toBe(true)
  })

  it('prints the version', async () => {
    for (const v of ['--version', '-V', 'version']) expect(await run([v])).toMatchObject({ code: 0, out: `${CLI_VERSION}\n` })
  })

  it('prints help, command help and the TUI note for a bare orgai', async () => {
    const bare = await run([])
    expect(bare.code).toBe(0)
    expect(bare.out).toContain('Usage: orgai <command>')
    expect(bare.out).toContain(TUI_LATER_NOTE)
    const h = await run(['--help'])
    expect(h.out).toContain('status')
    expect(h.out).toContain('--data-dir')
    expect((await run(['help', 'runs'])).out).toContain('Usage: orgai runs list')
    expect((await run(['runs', '--help'])).out).toContain('--all-projects')
    expect(calls).toHaveLength(0)
  })

  it('an unavailable command exits 2', async () => {
    const r = await run(['exec', 'hi'])
    expect(r.code).toBe(2)
    expect(r.err).toContain('`orgai exec` is not available in this build yet.')
  })

  it('an unknown command exits 2 with a did-you-mean', async () => {
    const r = await run(['stauts'])
    expect(r.code).toBe(2)
    expect(r.err).toContain("Did you mean 'status'?")
    const far = await run(['zzzzzzzz'])
    expect(far.code).toBe(2)
    expect(far.err).not.toContain('Did you mean')
    expect(editDistance('daemn', 'daemon')).toBe(1)
  })

  it('refuses secret overrides outside --host inproc with exit 2, but not for completions', async () => {
    const r = await run(['status'], { ORGAI_SECRET_LITELLM_API_KEY: 'sk' })
    expect(r.code).toBe(2)
    expect(r.err).toContain(SECRET_ENV_REFUSAL)
    expect(calls).toHaveLength(0)
    expect((await run(['--secret-env', 'mcp:p:s:env:X=V', 'runs', 'list'])).code).toBe(2)
    expect((await run(['completions', 'bash'], { ORGAI_SECRET_X: '1' })).code).toBe(0)
  })

  it('with --host inproc, collects and scrubs the secrets', async () => {
    const env: NodeJS.ProcessEnv = { ORGAI_SECRET_LITELLM_API_KEY: 'sk', TOKEN: 't', PATH: '/bin' }
    const r = await run(['--host', 'inproc', '--secret-env', 'mcp:p:s:env:X=TOKEN', 'status'], env)
    expect(r.code).toBe(0)
    expect(env).toEqual({ PATH: '/bin' })
    expect((await run(['--host', 'inproc', '--secret-env', 'mcp:p:s:env:X=MISSING', 'status'], {})).code).toBe(2)
  })

  it('a usage error in the global flags exits 2; a plain error exits 1 without a stack', async () => {
    expect((await run(['--host', 'nope', 'status'])).code).toBe(2)
    const r = await run(['doctor'])
    expect(r.code).toBe(1)
    expect(r.err).toBe('orgai: boom\n')
    const d = await run(['doctor'], { ORGAI_CLI_DEBUG: '1' })
    expect(d.err).toContain('at ')
  })
})
