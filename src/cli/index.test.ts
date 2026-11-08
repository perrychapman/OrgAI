import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { writeProductMarker } from '../main/store/productMarker'
import type { CliContext } from './types'

const calls: { name: string; args: string[]; ctx: CliContext }[] = []
const stub = (name: string) =>
  vi.fn(async (ctx: CliContext, args: string[]) => {
    calls.push({ name, args, ctx })
    return 0
  })

vi.mock('./commands/status', () => ({ runStatus: stub('status') }))
vi.mock('./commands/runs', () => ({ runRuns: stub('runs') }))
let doctorError = 'boom'
vi.mock('./commands/doctor', () => ({
  runDoctor: vi.fn(async () => {
    throw new Error(doctorError)
  })
}))
vi.mock('./commands/completions', () => ({ runCompletions: stub('completions') }))
vi.mock('./commands/projects', async (importOriginal) => ({ ...(await importOriginal<object>()), runProjects: stub('projects') }))
/** What each in-process host start received (a stub; nothing boots). */
const inprocStarts: { overlay: Map<string, string> }[] = []
vi.mock('./inprocHost', () => ({
  startInprocHost: vi.fn(async (input: { overlay: Map<string, string> }) => {
    inprocStarts.push(input)
    return { closed: new Promise(() => undefined), stop: async () => undefined, status: () => ({}) }
  })
}))
vi.mock('./commands/exec', () => ({ runExec: stub('exec'), runResume: stub('resume') }))
vi.mock('./commands/tui', () => ({
  PROMPT_HINT: 'To start the terminal UI with a prompt: orgai -- "<prompt>"',
  runTuiCommand: stub('tui'),
  defaultTuiPrintsHelp: vi.fn(() => false),
  runDefaultTui: vi.fn(async (ctx: CliContext, args: string[], opts?: { help?: () => string }) => {
    calls.push({ name: 'default', args, ctx })
    if (opts?.help) ctx.io.stdout.write(`${opts.help()}\n`)
    return 0
  })
}))

const { main, editDistance, generalHelp, ROUTES } = await import('./index')
const { CLI_VERSION } = await import('./version')
const { COMMANDS } = await import('./commandTable')
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

// One marked data folder for the file, so a test never touches the real one and sees no first-start note.
const dataDir = mkdtempSync(join(tmpdir(), 'orgai-index-'))
writeProductMarker(dataDir, 'orgai-cli')
const run = async (argv: string[], env: NodeJS.ProcessEnv = {}) => {
  const t = io()
  const code = await main(argv.includes('--data-dir') ? argv : ['--data-dir', dataDir, ...argv], { env, cwd: '/tmp', platform: 'linux', io: t.io })
  return { code, ...t.o }
}

beforeEach(() => {
  calls.length = 0
  inprocStarts.length = 0
})

describe('orgai routing', () => {
  it('routes each Wave 2 command with its arguments', async () => {
    for (const [argv, name, args] of [
      [['status'], 'status', []],
      [['runs', 'list', '--limit', '3'], 'runs', ['list', '--limit', '3']],
      [['--project', 'p1', 'runs', 'show', 'R2'], 'runs', ['show', 'R2']],
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
    const ud = join(mkdtempSync(join(tmpdir(), 'orgai-index-')), 'ud')
    await run(['--data-dir', ud, '--project', 'p1', '--no-color', 'status'])
    const ctx = calls[0].ctx
    expect(ctx.paths).toEqual({ userDataDir: ud, dataDir: join(ud, 'data') })
    expect(ctx.globals).toMatchObject({ project: 'p1', color: false })
    expect(ctx.version).toBe(CLI_VERSION)
    await run(['status'], { NO_COLOR: '1' })
    expect(calls[1].ctx.globals.color).toBe(false)
    await run(['status'])
    expect(calls[2].ctx.globals.color).toBe(true)
  })

  it('prints the version', async () => {
    for (const v of ['--version', '-V', 'version']) expect(await run([v])).toMatchObject({ code: 0, out: `${CLI_VERSION} channel dev\n` })
  })

  it('prints help and command help; a bare orgai goes to the terminal UI (which prints help without a terminal)', async () => {
    const bare = await run([])
    expect(bare.code).toBe(0)
    expect(calls.map((c) => [c.name, c.args])).toEqual([['default', []]])
    expect(bare.out).toContain('orgai <command> [options]')
    expect(bare.out).not.toContain('later version')
    calls.length = 0
    const h = await run(['--help'])
    expect(h.out).toContain('status')
    expect(h.out).toContain('--data-dir')
    expect((await run(['help', 'runs'])).out).toContain('Usage: orgai runs list')
    expect((await run(['runs', '--help'])).out).toContain('--all-projects')
    // Every flag the Wave 2 commands parse is in their help (review L).
    const helpOf = async (c: string) => (await run(['help', c])).out
    for (const f of ['--status', '--transcript', '--tail']) expect(await helpOf('runs')).toContain(f)
    expect(await helpOf('status')).toContain('--all-projects')
    for (const f of ['--run', '--inline', '--ax-screen-reader']) expect(await helpOf('tui')).toContain(f)
    expect(await helpOf('resume')).toContain('resume [runId-or-R#] [--prompt <text> | --prompt-file <path|-> | -] [--exec [exec options]]')
    expect(calls).toHaveLength(0)
  })

  it('exec, -p and resume help offer --prompt-file and say untrusted text goes in a file or on stdin (review M12)', async () => {
    for (const argv of [['help', 'exec'], ['-p', '--help'], ['help', 'resume']]) {
      const r = await run(argv)
      expect(r.code, argv.join(' ')).toBe(0)
      expect(r.out, argv.join(' ')).toContain('--prompt-file <value>')
      // The note is wrapped; compare it with the line breaks folded.
      const flat = r.out.replace(/\s+/g, ' ')
      expect(flat, argv.join(' ')).toContain('goes in a file or on stdin, never on the command line')
      expect(flat, argv.join(' ')).toContain('On Windows orgai is a .cmd file, so cmd.exe re-reads its arguments')
      // The note is the last paragraph, wrapped at 100 columns.
      const note = r.out.trimEnd().split('\n\n').at(-1) ?? ''
      expect(note.startsWith('Text you did not write'), argv.join(' ')).toBe(true)
      expect(note.split('\n').every((l) => l.length <= 100), argv.join(' ')).toBe(true)
    }
    expect(generalHelp().replace(/\s+/g, ' ')).toContain('orgai exec --prompt-file <path>. On Windows the orgai command is a .cmd file')
    expect(calls).toHaveLength(0)
  })

  it('the general help names the terminal UI flags and lists tui as a command, not as coming later; the removed commands and --host are gone', () => {
    const h = generalHelp()
    expect(h).toContain('Usage: orgai [options] [--] [prompt]')
    for (const f of ['--inline', '--ax-screen-reader', '--team']) expect(h).toContain(f)
    const later = h.split('\n').find((l) => l.startsWith('Coming later')) ?? ''
    expect(later).not.toMatch(/\btui\b/)
    expect(h).toMatch(/^ {2}tui\s/m)
    for (const gone of ['attach', 'watch', 'inbox', 'decide', 'daemon', 'app', 'terminal-access']) expect(h, gone).not.toMatch(new RegExp(`^ {2}${gone}\\s`, 'm'))
    expect(h).not.toContain('--host')
  })

  it.each(COMMANDS.filter((c) => !c.available).map((c) => c.name))('an unavailable command (%s) exits 2 before routing', async (name) => {
    const r = await run([name, 'list'])
    expect(r.code).toBe(2)
    expect(r.err).toContain(`\`orgai ${name}\` is not available in this build yet.`)
    expect(calls).toHaveLength(0)
  })

  it('the Coming later line lists exactly the unavailable commands (none, one or several)', () => {
    const later = COMMANDS.filter((c) => !c.available).map((c) => c.name)
    const line = generalHelp()
      .split('\n')
      .find((l) => l.startsWith('Coming later'))
    if (later.length === 0) expect(line).toBeUndefined()
    else expect(line).toBe(`Coming later: ${later.join(', ')}.`)
  })

  it('every command has a route and its help', async () => {
    for (const c of COMMANDS) {
      expect(typeof ROUTES[c.name], c.name).toBe('function')
      const r = await run(['help', c.name])
      expect(r.code, c.name).toBe(0)
      expect(r.out, c.name).toContain(`Usage: orgai ${c.usage}`)
    }
  })

  it('routes tui, and prompts to the terminal UI', async () => {
    for (const [argv, name, args] of [
      [['tui', '--run', 'R1'], 'tui', ['--run', 'R1']],
      [['--', 'fix', 'the', 'bug'], 'default', ['--', 'fix', 'the', 'bug']],
      [['fix the bug'], 'default', ['fix the bug']],
      [['--inline', 'fix the bug'], 'default', ['--inline', 'fix the bug']],
      [['--team', 'single', '--', 'fix'], 'default', ['--team', 'single', '--', 'fix']],
      [['--team=single', 'a b'], 'default', ['--team=single', 'a b']],
      [['--ax-screen-reader'], 'default', ['--ax-screen-reader']],
      [['--project', 'p1', '--', 'go now'], 'default', ['--', 'go now']]
    ] as const) {
      calls.length = 0
      const r = await run([...argv])
      expect(r.code, argv.join(' ')).toBe(0)
      expect(calls.map((c) => c.name), argv.join(' ')).toEqual([name])
      expect(calls[0].args, argv.join(' ')).toEqual(args)
    }
  })

  it('a single unknown word is a usage error with the prompt hint', async () => {
    const r = await run(['fix'])
    expect(r.code).toBe(2)
    expect(r.err).toContain("Unknown command 'fix'.")
    expect(r.err).toContain('orgai -- "<prompt>"')
    expect(calls).toHaveLength(0)
    // -p keeps meaning exec.
    calls.length = 0
    await run(['-p', 'fix'])
    expect(calls.map((c) => c.name)).toEqual(['exec'])
  })

  it('exec, -p / --print and resume route to their commands with their arguments', async () => {
    for (const [argv, name, args] of [
      [['exec', 'hi'], 'exec', ['hi']],
      [['-p', 'hi'], 'exec', ['hi']],
      [['--print', 'hi'], 'exec', ['hi']],
      [['--project', 'p1', '-p', 'hi'], 'exec', ['hi']],
      [['resume', 'R1', '--exec'], 'resume', ['R1', '--exec']]
    ] as const) {
      calls.length = 0
      const r = await run([...argv])
      expect(r.code, argv.join(' ')).toBe(0)
      expect(calls.map((c) => c.name), argv.join(' ')).toEqual([name])
      expect(calls[0].args, argv.join(' ')).toEqual(args)
    }
    const h = await run(['-p', '--help'])
    expect(h.code).toBe(0)
    expect(h.out).toContain('Usage: orgai exec')
    expect((await run(['help', 'resume'])).out).toContain('--exec')
  })

  it('an unknown command exits 2 with a did-you-mean', async () => {
    const r = await run(['stauts'])
    expect(r.code).toBe(2)
    expect(r.err).toContain("Did you mean 'status'?")
    const far = await run(['zzzzzzzz'])
    expect(far.code).toBe(2)
    expect(far.err).not.toContain('Did you mean')
    expect(editDistance('stauts', 'status')).toBe(2)
  })

  it('the removed commands are unknown commands (exit 2), and runs has no message, interrupt or stop', async () => {
    for (const gone of ['daemon', 'app', 'terminal-access', 'watch', 'inbox', 'decide', 'attach']) {
      const r = await run([gone])
      expect(r.code, gone).toBe(2)
      expect(r.err, gone).toMatch(/Unknown command/i)
    }
    expect((await run(['--host', 'inproc', 'status'])).code).toBe(2)
    expect(calls).toHaveLength(0)
  })

  it('environment secrets: a read-only command refuses an explicit --secret-env and ignores an ambient one with one warning', async () => {
    for (const argv of [['runs', 'list'], ['status'], ['doctor'], ['projects', 'list'], ['projects', 'show', 'p1'], ['completions', 'bash']]) {
      const r = await run(['--secret-env', 'mcp:p:s:env:X=V', ...argv], { V: 'v' })
      expect(r.code, argv.join(' ')).toBe(2)
      expect(r.err).toContain(SECRET_ENV_REFUSAL)
    }
    expect(calls).toHaveLength(0)
    for (const argv of [['status'], ['runs', 'list']]) {
      const env: NodeJS.ProcessEnv = { ORGAI_SECRET_LITELLM_API_KEY: 'sk', PATH: '/bin' }
      const r = await run(argv, env)
      expect(r.code, argv.join(' ')).toBe(0)
      expect(r.err).toBe('ORGAI_SECRET_* ignored: this command does not start a host\n')
      expect(env).toEqual({ PATH: '/bin' })
    }
    // Completions leaves an ambient variable alone, as it always did.
    const env: NodeJS.ProcessEnv = { ORGAI_SECRET_X: '1' }
    expect((await run(['completions', 'bash'], env)).code).toBe(0)
  })

  it('an ignored ambient secret never reaches a host: the overlay is dropped', async () => {
    const env: NodeJS.ProcessEnv = { ORGAI_SECRET_LITELLM_API_KEY: 'sk', PATH: '/bin' }
    await run(['status'], env)
    await calls.at(-1)!.ctx.startInproc()
    expect(inprocStarts).toHaveLength(1)
    expect([...inprocStarts[0].overlay]).toEqual([])
  })

  it('a command that runs a host collects and scrubs the secrets and gives its host the overlay', async () => {
    const env: NodeJS.ProcessEnv = { ORGAI_SECRET_LITELLM_API_KEY: 'sk', TOKEN: 't', PATH: '/bin' }
    const r = await run(['--secret-env', 'mcp:p:s:env:X=TOKEN', 'exec', 'hello'], env)
    expect(r.code).toBe(0)
    expect(r.err).toBe('')
    expect(env).toEqual({ PATH: '/bin' })
    await calls.at(-1)!.ctx.startInproc()
    expect([...inprocStarts[0].overlay]).toEqual([['connection:litellm:apiKey', 'sk'], ['mcp:p:s:env:X', 't']])
    // A --secret-env naming an unset variable is still a usage error.
    expect((await run(['--secret-env', 'mcp:p:s:env:X=NOPE', 'exec', 'hello'], {})).code).toBe(2)
    // The same for the terminal UI and a bare prompt.
    for (const argv of [['tui'], ['--', 'fix the bug'], ['connections', 'list']]) {
      const e: NodeJS.ProcessEnv = { ORGAI_SECRET_LITELLM_API_KEY: 'sk', PATH: '/bin' }
      calls.length = 0
      inprocStarts.length = 0
      await run(argv, e)
      expect(e, argv.join(' ')).toEqual({ PATH: '/bin' })
    }
  })

  it('bare orgai that only prints help (no terminal) does so before the secret refusal and the scrub', async () => {
    const tui = await import('./commands/tui')
    vi.mocked(tui.defaultTuiPrintsHelp).mockReturnValue(true)
    try {
      const r = await run([], { ORGAI_SECRET_LITELLM_API_KEY: 'sk' })
      expect(r.code).toBe(0)
      expect(r.out).toContain('orgai <command> [options]')
      expect(calls).toHaveLength(0)
    } finally {
      vi.mocked(tui.defaultTuiPrintsHelp).mockReturnValue(false)
    }
  })

  it('a usage error in the global flags exits 2; a plain error exits 1 without a stack', async () => {
    const gone = await run(['--host', 'inproc', 'status'])
    expect(gone.code).toBe(2)
    expect(gone.err).toContain('--host is gone')
    const r = await run(['doctor'])
    expect(r.code).toBe(1)
    expect(r.err).toBe('orgai: boom\n')
    const d = await run(['doctor'], { ORGAI_CLI_DEBUG: '1' })
    expect(d.err).toContain('at ')
  })

  it('sanitizes error text before it reaches the terminal (review L)', async () => {
    doctorError = 'refused \u001b]52;c;ZXZpbA==\u0007now \u001b[2Jcleared'
    try {
      const r = await run(['doctor'])
      expect(r.code).toBe(1)
      expect(r.err).not.toContain('\u001b')
      expect(r.err).not.toContain('\u0007')
      expect(r.err.startsWith('orgai: refused')).toBe(true)
    } finally {
      doctorError = 'boom'
    }
  })
})

describe('ELECTRON_RUN_AS_NODE under the packaged launcher (cli-spec 7, Wave 6)', () => {
  it('is scrubbed under an Electron runtime and kept under plain Node', async () => {
    const { scrubElectronRunAsNode } = await import('./index')
    const env: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: '1', PATH: '/bin' }
    expect(scrubElectronRunAsNode(env, { node: '24.22.1', electron: '45.1.0' })).toBe(true)
    expect(env).toEqual({ PATH: '/bin' })
    expect(scrubElectronRunAsNode(env, { node: '24.22.1', electron: '45.1.0' })).toBe(false)
    const plain: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: '1' }
    expect(scrubElectronRunAsNode(plain, { node: '24.22.1' })).toBe(false)
    expect(plain).toEqual({ ELECTRON_RUN_AS_NODE: '1' })
  })

  it('importing the module never touches process.env', async () => {
    // index.ts scrubs only in its entry path (isEntry), never on a plain import.
    process.env.ELECTRON_RUN_AS_NODE = '1'
    try {
      await import('./index')
      expect(process.env.ELECTRON_RUN_AS_NODE).toBe('1')
    } finally {
      delete process.env.ELECTRON_RUN_AS_NODE
    }
  })
})
