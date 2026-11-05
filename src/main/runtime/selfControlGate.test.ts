import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  SELF_CONTROL_DENIAL_MESSAGE,
  SELF_CONTROL_UNCHECKED_MESSAGE,
  checkSelfControlDenial,
  commandRunsOrgaiCli,
  controlProtectedPaths,
  orgaiCliRootsOf,
  readControlProtectedPaths,
  stripDataHeredocs,
  vaultPrefixProtections,
  type SelfControlContext
} from './selfControlGate'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('controlProtectedPaths', () => {
  it('lists run, secrets.json and codex, plus the runtime dir when given', () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'orgai-scg-')))
    dirs.push(base)
    const data = join(base, 'data')
    mkdirSync(data)
    const paths = controlProtectedPaths(data)
    expect(paths).toEqual([join(data, 'run'), join(data, 'secrets.json'), join(data, 'codex')])
    const rt = join(base, 'rt')
    expect(controlProtectedPaths(data, rt)).toContain(rt)
  })

  it('Wave 7: appends the vault key files as exact paths, after the others', () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'orgai-scg-')))
    dirs.push(base)
    const data = join(base, 'data')
    mkdirSync(data)
    const key = join(base, 'keys', 'orgai.key')
    const paths = controlProtectedPaths(data, undefined, { vaultKeyFiles: [key, ''] })
    expect(paths).toEqual([join(data, 'run'), join(data, 'secrets.json'), join(data, 'codex'), key])
    expect(controlProtectedPaths(data, undefined, { vaultKeyFiles: [] })).toEqual(controlProtectedPaths(data))
  })

  it('carries both spellings through a dir symlink, deduped', () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'orgai-scg-')))
    dirs.push(base)
    const real = join(base, 'real')
    mkdirSync(join(real, 'run'), { recursive: true })
    const link = join(base, 'link')
    symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir')
    const paths = controlProtectedPaths(link)
    for (const p of ['run', 'secrets.json', 'codex']) {
      expect(paths).toContain(join(link, p))
      expect(paths).toContain(join(real, p))
    }
    expect(new Set(paths).size).toBe(paths.length)
    expect(paths).toHaveLength(6)
  })

  it('never includes the data dir itself, quick/, project-skills/ or skills/', () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'orgai-scg-')))
    dirs.push(base)
    const data = join(base, 'data')
    const paths = controlProtectedPaths(data, join(base, 'rt'))
    for (const p of [data, join(data, 'quick'), join(data, 'project-skills'), join(data, 'skills')]) expect(paths).not.toContain(p)
    for (const p of paths) expect(p.startsWith(join(data, 'quick')) || p.startsWith(join(data, 'skills')) || p.startsWith(join(data, 'project-skills'))).toBe(false)
  })
})

describe('checkSelfControlDenial', () => {
  function setup(): { data: string; link: string; real: string; rt: string; refs: string[]; home: string } {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'orgai-scg-')))
    dirs.push(base)
    const real = join(base, 'real-data')
    for (const d of ['run', 'codex', 'quick/quick_x', 'project-skills', 'skills']) mkdirSync(join(real, d), { recursive: true })
    const link = join(base, 'data')
    symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir')
    const rt = join(base, 'rt')
    mkdirSync(rt)
    return { data: link, link, real, rt, refs: controlProtectedPaths(link, rt), home: base }
  }
  const deny = (tool: string, input: unknown, ctx: SelfControlContext): string | null => checkSelfControlDenial(tool, input, ctx)

  it('denies file tools at or under run/, secrets.json, codex/ and the runtime dir, in both spellings', () => {
    const s = setup()
    const ctx: SelfControlContext = { protectedPaths: s.refs, home: s.home }
    for (const root of [s.link, s.real]) {
      const targets = [join(root, 'run', 'daemon.secret'), join(root, 'run'), join(root, 'secrets.json'), join(root, 'codex', 'auth.json')]
      for (const t of targets) {
        expect(deny('Read', { file_path: t }, ctx)).toBe(SELF_CONTROL_DENIAL_MESSAGE)
        expect(deny('Edit', { file_path: t, old_string: 'a', new_string: 'b' }, ctx)).toBe(SELF_CONTROL_DENIAL_MESSAGE)
        expect(deny('Write', { file_path: t, content: 'x' }, ctx)).toBe(SELF_CONTROL_DENIAL_MESSAGE)
        expect(deny('MultiEdit', { file_path: t, edits: [] }, ctx)).toBe(SELF_CONTROL_DENIAL_MESSAGE)
        expect(deny('NotebookEdit', { notebook_path: t }, ctx)).toBe(SELF_CONTROL_DENIAL_MESSAGE)
        expect(deny('Grep', { pattern: 'token', path: t }, ctx)).toBe(SELF_CONTROL_DENIAL_MESSAGE)
        expect(deny('Glob', { pattern: '*', path: t }, ctx)).toBe(SELF_CONTROL_DENIAL_MESSAGE)
      }
      expect(deny('Glob', { pattern: join(root, 'run', '*.json') }, ctx)).toBe(SELF_CONTROL_DENIAL_MESSAGE)
      expect(deny('Grep', { pattern: join(root, 'codex') }, ctx)).toBe(SELF_CONTROL_DENIAL_MESSAGE)
    }
    expect(deny('Read', { file_path: join(s.rt, 'd-1.sock') }, ctx)).toBe(SELF_CONTROL_DENIAL_MESSAGE)
    // A protected list holding only one spelling still catches the other.
    expect(deny('Read', { file_path: join(s.real, 'run', 'daemon.json') }, { protectedPaths: [join(s.link, 'run')] })).toBe(SELF_CONTROL_DENIAL_MESSAGE)
    expect(deny('Read', { file_path: join(s.link, 'run', 'daemon.json') }, { protectedPaths: [join(s.real, 'run')] })).toBe(SELF_CONTROL_DENIAL_MESSAGE)
  })

  it.runIf(process.platform === 'darwin' || process.platform === 'win32')('folds case on darwin and win32', () => {
    const s = setup()
    expect(deny('Read', { file_path: join(s.real, 'RUN', 'Daemon.Secret') }, { protectedPaths: s.refs })).toBe(SELF_CONTROL_DENIAL_MESSAGE)
  })

  it('resolves relative targets against cwd and ~ against home', () => {
    const s = setup()
    const ctx: SelfControlContext = { protectedPaths: s.refs, cwd: s.data, home: s.home }
    expect(deny('Read', { file_path: 'run/daemon.secret' }, ctx)).toBe(SELF_CONTROL_DENIAL_MESSAGE)
    expect(deny('Write', { file_path: './secrets.json' }, ctx)).toBe(SELF_CONTROL_DENIAL_MESSAGE)
    expect(deny('Read', { file_path: '../codex/x' }, { ...ctx, cwd: join(s.data, 'skills') })).toBe(SELF_CONTROL_DENIAL_MESSAGE)
    expect(deny('Read', { file_path: '~/data/run/daemon.json' }, ctx)).toBe(SELF_CONTROL_DENIAL_MESSAGE)
    expect(deny('Glob', { pattern: '~/data/run/*' }, ctx)).toBe(SELF_CONTROL_DENIAL_MESSAGE)
    // Without a cwd a relative target names nothing.
    expect(deny('Read', { file_path: 'run/daemon.secret' }, { protectedPaths: s.refs })).toBeNull()
    // A relative Glob pattern is not a target.
    expect(deny('Glob', { pattern: 'run/*' }, { protectedPaths: s.refs })).toBeNull()
  })

  it('allows quick scratch dirs, project-skills, skills and the data dir root', () => {
    const s = setup()
    const ctx: SelfControlContext = { protectedPaths: s.refs, home: s.home }
    for (const root of [s.link, s.real]) {
      for (const t of [
        join(root, 'quick', 'quick_x', 'a.txt'),
        join(root, 'project-skills', 'p', 's', 'SKILL.md'),
        join(root, 'skills', 'x', 'SKILL.md'),
        root,
        join(root, 'projects.json'),
        join(root, 'runner', 'x'),
        join(root, 'my-secrets.json'),
        join(root, 'vaults', 'vault.json')
      ]) {
        expect(deny('Read', { file_path: t }, ctx)).toBeNull()
        expect(deny('Write', { file_path: t, content: '' }, ctx)).toBeNull()
      }
      // A recursive search from the data dir root descends into run/ and codex/ (review M): denied.
      expect(deny('Glob', { pattern: '**/*', path: root }, ctx)).toBe(SELF_CONTROL_DENIAL_MESSAGE)
      expect(deny('Glob', { pattern: '**/*.md', path: join(root, 'skills') }, ctx)).toBeNull()
      expect(deny('Grep', { pattern: 'x', path: join(root, 'quick', 'quick_x') }, ctx)).toBeNull()
    }
    expect(deny('Read', { file_path: s.home }, ctx)).toBeNull()
    // Unknown tools, missing paths and an empty list never deny.
    expect(deny('WebFetch', { url: join(s.data, 'run') }, ctx)).toBeNull()
    expect(deny('Read', {}, ctx)).toBeNull()
    expect(deny('Read', { file_path: join(s.data, 'run') }, { protectedPaths: [] })).toBeNull()
  })

  it('denies Bash commands that run the orgai CLI', () => {
    const s = setup()
    const ctx: SelfControlContext = { protectedPaths: s.refs, cwd: s.home, home: s.home }
    for (const command of [
      'orgai status',
      '/usr/local/bin/orgai runs list',
      'env FOO=1 orgai',
      'FOO=1 BAR=2 orgai watch',
      'npx orgai status',
      'npx -y orgai@latest status',
      'npm exec -- orgai status',
      'pnpm dlx orgai',
      'nohup orgai daemon start &',
      'time command exec orgai x',
      'ELECTRON_RUN_AS_NODE=1 electron x',
      'env ELECTRON_RUN_AS_NODE=1 /Applications/OrgAI.app/Contents/MacOS/OrgAI cli.js',
      'export ELECTRON_RUN_AS_NODE=1',
      'node out/cli/orgai.mjs status',
      'node ./out/cli/orgai.mjs',
      'node /opt/whatever/orgai.js status',
      "bash -c 'orgai x'",
      'sh -lc "orgai daemon stop"',
      'npm test && orgai status',
      'ls | orgai inbox',
      'echo "$(orgai status)"',
      'echo `orgai status`',
      './node_modules/.bin/orgai status',
      'C:\\tools\\orgai.exe status',
      'orgai.cmd status'
    ]) {
      expect(deny('Bash', { command }, ctx), command).toBe(SELF_CONTROL_DENIAL_MESSAGE)
    }
  })

  it('denies Bash commands that name or run inside a protected path', () => {
    const s = setup()
    const ctx: SelfControlContext = { protectedPaths: s.refs, cwd: s.home, home: s.home }
    for (const command of [
      `cat ${join(s.data, 'run', 'daemon.secret')}`,
      `cat ${join(s.real, 'run', 'daemon.secret')}`,
      `cd ${s.data} && cat run/daemon.secret`,
      `cd ${s.data}; cp secrets.json /tmp/x`,
      `grep -r token ${join(s.data, 'codex')}`,
      'cat ~/data/secrets.json',
      `bash -c 'cat ${join(s.data, 'run', 'daemon.json')}'`
    ]) {
      expect(deny('Bash', { command }, ctx), command).toBe(SELF_CONTROL_DENIAL_MESSAGE)
    }
    expect(deny('Bash', { command: 'ls' }, { ...ctx, cwd: join(s.data, 'run') })).toBe(SELF_CONTROL_DENIAL_MESSAGE)
  })

  it("matches an interpreter run of this install's CLI folders only, never a project's src/cli (review M)", () => {
    const s = setup()
    const app = join(s.home, 'OrgAI-app')
    const ctx: SelfControlContext = { protectedPaths: s.refs, cwd: app, home: s.home, cliRoots: [join(app, 'out', 'cli'), join(app, 'src', 'cli')] }
    for (const command of ['tsx src/cli/index.ts', 'bun run src/cli/index.ts', `node ${join(app, 'out', 'cli', 'x.mjs')}`, 'deno run out/cli/app.ts']) {
      expect(deny('Bash', { command }, ctx), command).toBe(SELF_CONTROL_DENIAL_MESSAGE)
    }
    const project: SelfControlContext = { ...ctx, cwd: join(s.home, 'proj') }
    for (const command of [
      'node src/cli/index.js --help',
      'npx tsx src/cli/main.ts',
      'bun test src/cli/',
      'deno run out/cli/app.ts',
      'npm run build && node out/cli/foo.js',
      'grep -rn "ELECTRON_RUN_AS_NODE=" .',
      "echo 'ELECTRON_RUN_AS_NODE=1 is set by the launcher'",
      'echo $env:ELECTRON_RUN_AS_NODE'
    ]) {
      expect(deny('Bash', { command }, project), command).toBeNull()
    }
    // No configured roots: only the orgai file names count.
    expect(deny('Bash', { command: 'tsx src/cli/index.ts' }, { protectedPaths: s.refs, cwd: app, cliRoots: [] })).toBeNull()
  })

  it('denies $HOME spellings and globs that reach a protected path (review M)', () => {
    const s = setup()
    const ctx: SelfControlContext = { protectedPaths: s.refs, cwd: join(s.home, 'proj'), home: s.home }
    for (const command of [
      'cat "$HOME/data/run/daemon.secret"',
      'cat ${HOME}/data/run/daemon.secret',
      'cat $HOME/data/codex/auth.json',
      'cat ~/data/r*/daemon.secret',
      `cat ${s.data}/r?n/daemon.secret`,
      `ls ${s.data}/r*`,
      `cat ${s.data}/[r]un/daemon.json`,
      `cat ${s.data}/*/auth.json`,
      `cat ${s.data}/secrets.*`
    ]) {
      expect(deny('Bash', { command }, ctx), command).toBe(SELF_CONTROL_DENIAL_MESSAGE)
    }
    expect(deny('PowerShell', { command: 'Get-Content $env:USERPROFILE/data/secrets.json' }, ctx)).toBe(SELF_CONTROL_DENIAL_MESSAGE)
    for (const command of ['ls $HOME', 'ls $HOME/data', `ls ${s.data}/*.md`, `cat ${s.data}/q*/notes.md`, 'echo $HOMEDIR/run/x', `ls ${s.data}/p*`]) {
      expect(deny('Bash', { command }, ctx), command).toBeNull()
    }
  })

  it('denies Grep / Glob searches rooted at the data dir or an ancestor of a protected path (review M)', () => {
    const s = setup()
    const ctx: SelfControlContext = { protectedPaths: s.refs, cwd: join(s.home, 'proj'), home: s.home }
    expect(deny('Grep', { pattern: '^[0-9a-f]{64}$', path: s.data, output_mode: 'content' }, ctx)).toBe(SELF_CONTROL_DENIAL_MESSAGE)
    expect(deny('Grep', { pattern: 'x', path: s.real }, ctx)).toBe(SELF_CONTROL_DENIAL_MESSAGE)
    expect(deny('Grep', { pattern: 'x', path: '~', glob: '**/run/daemon.secret' }, ctx)).toBe(SELF_CONTROL_DENIAL_MESSAGE)
    expect(deny('Grep', { pattern: 'x' }, { ...ctx, cwd: s.home })).toBe(SELF_CONTROL_DENIAL_MESSAGE)
    expect(deny('Glob', { pattern: '**/daemon.secret', path: s.home }, ctx)).toBe(SELF_CONTROL_DENIAL_MESSAGE)
    expect(deny('Glob', { pattern: 'data/run/*' }, { ...ctx, cwd: s.home })).toBe(SELF_CONTROL_DENIAL_MESSAGE)
    expect(deny('Glob', { pattern: 'd*/c*/*', path: s.home }, ctx)).toBe(SELF_CONTROL_DENIAL_MESSAGE)
    // secrets.json is protected itself, so a glob that can match it is denied.
    expect(deny('Glob', { pattern: 'data/*.json', path: s.home }, ctx)).toBe(SELF_CONTROL_DENIAL_MESSAGE)
    // Searches that cannot reach one stay allowed.
    expect(deny('Grep', { pattern: 'x' }, ctx)).toBeNull()
    expect(deny('Grep', { pattern: 'x', path: join(s.data, 'skills') }, ctx)).toBeNull()
    expect(deny('Glob', { pattern: '*.md', path: s.home }, ctx)).toBeNull()
    expect(deny('Glob', { pattern: 'data/*.md', path: s.home }, ctx)).toBeNull()
    expect(deny('Glob', { pattern: 'src/**/*.ts' }, ctx)).toBeNull()
  })

  it('denies PowerShell ELECTRON_RUN_AS_NODE and protected paths', () => {
    const s = setup()
    const ctx: SelfControlContext = { protectedPaths: s.refs, cwd: s.home, home: s.home }
    expect(deny('PowerShell', { command: '$env:ELECTRON_RUN_AS_NODE=1; & electron x' }, ctx)).toBe(SELF_CONTROL_DENIAL_MESSAGE)
    expect(deny('PowerShell', { command: '$env:ELECTRON_RUN_AS_NODE = "1"' }, ctx)).toBe(SELF_CONTROL_DENIAL_MESSAGE)
    expect(deny('PowerShell', { command: 'Set-Item env:ELECTRON_RUN_AS_NODE 1' }, ctx)).toBe(SELF_CONTROL_DENIAL_MESSAGE)
    expect(deny('PowerShell', { command: "& 'C:\\Program Files\\OrgAI\\orgai.exe' status" }, ctx)).toBe(SELF_CONTROL_DENIAL_MESSAGE)
    expect(deny('PowerShell', { command: `Get-Content ${join(s.data, 'secrets.json')}` }, ctx)).toBe(SELF_CONTROL_DENIAL_MESSAGE)
    expect(deny('PowerShell', { command: `Get-Content -Path:${join(s.data, 'run', 'daemon.secret')}` }, ctx)).toBe(SELF_CONTROL_DENIAL_MESSAGE)
  })

  it('reads win32 spellings (platform win32)', () => {
    const refs = ['C:\\Users\\me\\AppData\\Roaming\\OrgAI\\secrets.json', 'C:\\Users\\me\\AppData\\Roaming\\OrgAI\\run']
    const ctx: SelfControlContext = { protectedPaths: refs, platform: 'win32', cwd: 'C:\\Users\\me', home: 'C:\\Users\\me' }
    expect(deny('PowerShell', { command: 'Get-Content C:\\Users\\me\\AppData\\Roaming\\OrgAI\\secrets.json' }, ctx)).toBe(SELF_CONTROL_DENIAL_MESSAGE)
    expect(deny('PowerShell', { command: 'Get-Content c:\\users\\ME\\appdata\\roaming\\orgai\\RUN\\daemon.secret' }, ctx)).toBe(SELF_CONTROL_DENIAL_MESSAGE)
    expect(deny('Read', { file_path: 'C:/Users/me/AppData/Roaming/OrgAI/run/daemon.json' }, ctx)).toBe(SELF_CONTROL_DENIAL_MESSAGE)
    expect(deny('PowerShell', { command: 'Get-ChildItem C:\\Users\\me\\AppData\\Roaming\\OrgAI' }, ctx)).toBeNull()
    // UNC words are a fail-closed answer for reference folders, never a self-control denial.
    expect(deny('PowerShell', { command: 'Get-Content \\\\host\\share\\x' }, ctx)).toBeNull()
    expect(deny('Read', { file_path: '\\\\host\\share\\x' }, ctx)).toBeNull()
  })

  it('does not deny parents, untrackable cds or other node scripts', () => {
    const s = setup()
    const ctx: SelfControlContext = { protectedPaths: s.refs, cwd: s.home, home: s.home }
    for (const command of [
      'cd ~ && npm test',
      `ls ${s.data}`,
      `ls ${s.real}`,
      `cd ${s.data} && ls`,
      `cat ${join(s.data, 'quick', 'quick_x', 'notes.md')}`,
      `ls ${join(s.data, 'skills')}`,
      'cd $X && cat run/daemon.secret',
      'cd - && cat run/daemon.secret',
      'node scripts/build.mjs',
      'node out/main/index.js',
      'npm run build',
      'git commit -m "orgai status fix"',
      'echo orgai',
      'grep -rn orgai src',
      'echo $ELECTRON_RUN_AS_NODE',
      'cat src/client/index.ts',
      `echo ${'a'.repeat(30 * 1024)}`,
      `echo ${'x '.repeat(1500)}`,
      `bash -c "git commit -m 'a b'"`
    ]) {
      expect(deny('Bash', { command }, ctx), command.slice(0, 80)).toBeNull()
    }
    expect(deny('Bash', {}, ctx)).toBeNull()
    expect(deny('Bash', { command: 42 }, ctx)).toBeNull()
  })

  it('denies a command the scanners cannot read to the end, so bypassPermissions never runs it unread (review High)', () => {
    const s = setup()
    const ctx: SelfControlContext = { protectedPaths: s.refs, cwd: s.home, home: s.home }
    const secret = `cat "${join(s.data, 'run', 'daemon.secret')}"`
    expect(deny('Bash', { command: secret }, ctx)).toBe(SELF_CONTROL_DENIAL_MESSAGE)
    for (const command of [
      // Past the gate's word limit (20,000; review M3 raised it from 2,000).
      `true ${Array.from({ length: 20_100 }, (_, k) => `w${k}`).join(' ')}; ${secret}`,
      // Past the segment budget (2,000) before the CLI call.
      `${Array(2100).fill(':').join('; ')}; orgai runs stop R1`,
      // Over 256 KB (was 32 KB).
      `echo ${'a'.repeat(257 * 1024)}; ${secret}`,
      // Shells nested deeper than three levels.
      `bash -c "bash -c 'bash -c \"bash -c orgai\"'"`
    ]) {
      expect(deny('Bash', { command }, ctx), command.slice(0, 80)).toBe(SELF_CONTROL_UNCHECKED_MESSAGE)
    }
    expect(deny('Bash', { command: 'orgai runs stop R1' }, ctx)).toBe(SELF_CONTROL_DENIAL_MESSAGE)
    // Also with no protected paths (the CLI check alone).
    expect(deny('Bash', { command: `${Array(2100).fill(':').join('; ')}; orgai runs stop R1` }, { protectedPaths: [] })).toBe(SELF_CONTROL_UNCHECKED_MESSAGE)
    expect(commandRunsOrgaiCli(`${Array(2100).fill(':').join('; ')}; echo hi`)).toBe(true)
  })

  it('never throws; an internal error fails closed for shell tools only (review M2)', () => {
    expect(checkSelfControlDenial('Read', { file_path: '/x' }, null as unknown as SelfControlContext)).toBeNull()
    expect(checkSelfControlDenial('Bash', { command: 'orgai' }, { protectedPaths: null as unknown as string[] })).toBe(SELF_CONTROL_DENIAL_MESSAGE)
    expect(checkSelfControlDenial('Read', null, { protectedPaths: ['/x'] })).toBeNull()
    // A context that throws while it is read: the shell command is refused unchecked, never let through.
    const throwing = {
      get protectedPaths(): string[] {
        throw new Error('boom')
      }
    } as unknown as SelfControlContext
    expect(checkSelfControlDenial('Bash', { command: 'ls' }, throwing)).toBe(SELF_CONTROL_UNCHECKED_MESSAGE)
    expect(checkSelfControlDenial('PowerShell', { command: 'Get-ChildItem' }, throwing)).toBe(SELF_CONTROL_UNCHECKED_MESSAGE)
    expect(checkSelfControlDenial('Read', { file_path: '/x' }, throwing)).toBeNull()
    expect(checkSelfControlDenial('Bash', { command: 'ls' }, null as unknown as SelfControlContext)).toBe(SELF_CONTROL_UNCHECKED_MESSAGE)
  })

  it('refuses shell commands when the protected paths are unavailable, file tools go on (review M2)', () => {
    const ctx: SelfControlContext = { protectedPaths: [], pathsUnavailable: true, cwd: '/work' }
    expect(deny('Bash', { command: 'ls' }, ctx)).toBe(SELF_CONTROL_UNCHECKED_MESSAGE)
    expect(deny('PowerShell', { command: 'Get-ChildItem' }, ctx)).toBe(SELF_CONTROL_UNCHECKED_MESSAGE)
    // The CLI check still names the real reason first.
    expect(deny('Bash', { command: 'orgai status' }, ctx)).toBe(SELF_CONTROL_DENIAL_MESSAGE)
    expect(deny('Read', { file_path: '/work/x' }, ctx)).toBeNull()
    expect(deny('Bash', { command: '' }, ctx)).toBeNull()
    // Without the flag an empty list keeps the CLI-only check (contexts with no source: tests, drafts).
    expect(deny('Bash', { command: 'ls' }, { protectedPaths: [] })).toBeNull()
  })

  it('readControlProtectedPaths: no source is not unavailable; a throwing, empty or junk source is', () => {
    expect(readControlProtectedPaths(undefined)).toEqual({ paths: [], unavailable: false })
    expect(readControlProtectedPaths(() => ['/d/run', '', 42 as unknown as string])).toEqual({ paths: ['/d/run'], unavailable: false })
    expect(readControlProtectedPaths(() => [])).toEqual({ paths: [], unavailable: true })
    expect(readControlProtectedPaths(() => null as unknown as string[])).toEqual({ paths: [], unavailable: true })
    expect(
      readControlProtectedPaths(() => {
        throw new Error('x')
      })
    ).toEqual({ paths: [], unavailable: true })
  })
})

describe('false positives in ordinary work (review M3)', () => {
  function setupData(): { data: string; refs: string[]; home: string; proj: string } {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'orgai-scg-fp-')))
    dirs.push(home)
    // No spaces: an unquoted path with one would be two words to bash too.
    const data = join(home, 'Library', 'OrgAI')
    for (const d of ['run', 'codex', 'skills']) mkdirSync(join(data, d), { recursive: true })
    const proj = join(home, 'proj')
    mkdirSync(proj)
    return { data, refs: controlProtectedPaths(data), home, proj }
  }
  const deny = (tool: string, input: unknown, ctx: SelfControlContext): string | null => checkSelfControlDenial(tool, input, ctx)

  it('a large data-only heredoc is neither denied for its size nor read as commands', () => {
    const s = setupData()
    const ctx: SelfControlContext = { protectedPaths: s.refs, cwd: s.proj, home: s.home }
    const big = Array.from({ length: 4000 }, (_, k) => `export const v${k} = ${k} // orgai status ~/Library/OrgAI/run/daemon.secret`).join('\n')
    expect(big.length).toBeGreaterThan(256 * 1024)
    for (const command of [
      `cat > src/big.ts <<'EOF'\n${big}\nEOF`,
      `cat <<"EOF" > src/big.ts\n${big}\nEOF\nnpm test`,
      `cat > notes.md <<-EOF\n\t${big.split('\n').slice(0, 50).join('\n\t')}\n\tEOF`,
      `tee src/big.ts > /dev/null <<'EOF'\n${big}\nEOF`,
      `git commit -q -F - <<'EOF'\nA message naming orgai runs stop R1\nEOF`,
      `git commit -m "$(cat <<'EOF'\nRefactor the orgai CLI\n\nCo-Authored-By: x\nEOF\n)"`,
      `gh pr create --title "x" --body "$(cat <<'EOF'\n## Summary\n- orgai status works\n${big.slice(0, 40_000)}\nEOF\n)"`
    ]) {
      expect(deny('Bash', { command }, ctx), command.slice(0, 60)).toBeNull()
    }
  })

  it('a heredoc that feeds code, names files to run, or that the parser is not sure of is still read', () => {
    const s = setupData()
    const ctx: SelfControlContext = { protectedPaths: s.refs, cwd: s.proj, home: s.home }
    const secret = join(s.data, 'run', 'daemon.secret')
    for (const command of [
      // Fed to a shell or interpreter, piped on, or run afterwards.
      `bash <<'EOF'\norgai runs stop R1\nEOF`,
      `sh -s <<'EOF'\norgai status\nEOF`,
      `cat <<'EOF' | sh\norgai status\nEOF`,
      `cat <<'EOF' > /tmp/x.sh\norgai status\nEOF\nsh /tmp/x.sh`,
      `cat <<'EOF' > /tmp/x.sh && bash /tmp/x.sh\norgai status\nEOF`,
      `cat <<'EOF'; orgai status\nx\nEOF`,
      `cat > run.sh <<'EOF'\ncat ${secret}\nEOF\nchmod +x run.sh && ./run.sh`,
      `cat <<'EOF' > a\nx\nEOF\norgai status`,
      `cat <<'A' <<'B'\nx\nA\ny\nB\norgai status`,
      `cat <<'EOF' | xargs cat\n${secret}\nEOF`,
      `xargs cat <<'EOF'\n${secret}\nEOF`,
      // An unquoted delimiter expands $( ) in the body.
      `cat <<EOF > out.txt\n$(cat ${secret})\nEOF`,
      // Not a data sink.
      `python3 - <<'EOF'\nimport os; os.system('cat ${secret}')\nEOF`,
      `git apply <<'EOF'\n--- ${secret}\nEOF`,
      // A substitution that is not a git / gh message value.
      `cat "$(cat <<'EOF'\n${secret}\nEOF\n)"`,
      // Arithmetic shift, a continued body, a comment hiding the operator.
      `echo $((1<<2))\ncat ${secret}\n2`,
      `cat <<EOF\nEO\\\nF\ncat ${secret}\nEOF`,
      `# cat <<EOF\ncat ${secret}\nEOF`,
      `echo "<<EOF"\ncat ${secret}\nEOF`,
      `echo \\<<EOF\ncat ${secret}\nEOF`,
      // Unterminated: bash reads to the end as the body, the scanners read it all.
      `cat <<'EOF'\ncat ${secret}`
    ]) {
      expect(deny('Bash', { command }, ctx), command.slice(0, 60)).not.toBeNull()
    }
    // The operator line itself is always read.
    expect(deny('Bash', { command: `cat > ${secret} <<'EOF'\nx\nEOF` }, ctx)).toBe(SELF_CONTROL_DENIAL_MESSAGE)
    expect(stripDataHeredocs(`cat <<'EOF' > a\nbody\nEOF\necho done`)).toBe(`cat <<'EOF' > a\necho done`)
    expect(stripDataHeredocs('no heredoc here')).toBe('no heredoc here')
    // PowerShell has no here-documents of this form: nothing is stripped there.
    expect(deny('PowerShell', { command: `cat <<'EOF'\nGet-Content ${secret}\nEOF` }, ctx)).toBe(SELF_CONTROL_DENIAL_MESSAGE)
  })

  it('a long git add of many files is checked, not refused for its length', () => {
    const s = setupData()
    const ctx: SelfControlContext = { protectedPaths: s.refs, cwd: s.proj, home: s.home }
    const files = Array.from({ length: 3000 }, (_, k) => `src/components/feature-${k}/component-file-${k}.tsx`)
    const command = `git add ${files.join(' ')}`
    expect(command.length).toBeGreaterThan(32 * 1024)
    const t0 = Date.now()
    expect(deny('Bash', { command }, ctx)).toBeNull()
    expect(Date.now() - t0).toBeLessThan(5000)
    expect(deny('Bash', { command: `${command} ${join(s.data, 'secrets.json')}` }, ctx)).toBe(SELF_CONTROL_DENIAL_MESSAGE)
  })

  it('text piped into an interpreter running a script file is data, not the CLI', () => {
    const ctx: SelfControlContext = { protectedPaths: [], cwd: '/work/repo', platform: 'darwin', cliRoots: [] }
    for (const command of [
      'grep -rn orgai src | node x.mjs',
      'grep -rn orgai src | node scripts/count.mjs --json',
      'echo orgai | node --no-warnings x.mjs',
      'git log --grep orgai | bun run scripts/x.ts',
      'grep -rn orgai src | tsx scripts/x.ts',
      'echo orgai status | bash scripts/check.sh',
      'echo orgai | deno run x.ts'
    ]) {
      expect(deny('Bash', { command }, ctx), command).toBeNull()
    }
    for (const command of [
      'echo orgai status | node',
      'echo orgai status | node -',
      'echo orgai status | node -e "eval(require(\'fs\').readFileSync(0, \'utf8\'))"',
      'echo orgai status | node --input-type module',
      'echo orgai status | node -r ./x.js',
      'echo orgai status | sh',
      'echo orgai status | bash -s',
      'echo orgai status | bash -c "$(cat)"',
      'echo orgai status | bash -',
      'echo orgai status | deno eval'
    ]) {
      expect(deny('Bash', { command }, ctx), command).toBe(SELF_CONTROL_DENIAL_MESSAGE)
    }
  })

  it('test runners over the install\'s own src/cli are not the CLI when the install is the repo being edited', () => {
    const app = '/Users/me/OrgAI'
    const ctx: SelfControlContext = { protectedPaths: [], cwd: app, platform: 'darwin', cliRoots: orgaiCliRootsOf(app, 'darwin') }
    for (const command of [
      'node --test src/cli/commands/exec.test.ts',
      'node --test src/cli/',
      'node --test --test-reporter spec src/cli',
      "node --test 'src/cli/**/*.test.ts'",
      'tsx --test src/cli/output.test.ts',
      'npx tsx --test src/cli/output.test.ts',
      'bun test src/cli/',
      'bun test src/cli/output.test.ts',
      'deno test src/cli',
      'node node_modules/.bin/vitest run src/cli',
      'node node_modules/vitest/vitest.mjs run src/cli/output.test.ts',
      'bun run vitest src/cli',
      'vitest run src/cli',
      'npx vitest run src/cli/commands',
      'npx vitest src/cli/tui/selectors.test.ts'
    ]) {
      expect(deny('Bash', { command }, ctx), command).toBeNull()
    }
    // Running the CLI itself is still the CLI, test flag or not.
    for (const command of [
      'node --test src/cli/index.ts',
      'node --test out/cli/orgai.mjs',
      'node --test out/cli/',
      'bun test out/cli/orgai.mjs',
      'tsx src/cli/index.ts',
      'bun run src/cli/index.ts',
      'node src/cli/output.test.ts'
    ]) {
      expect(deny('Bash', { command }, ctx), command).toBe(SELF_CONTROL_DENIAL_MESSAGE)
    }
  })

  it('Grep / Glob rooted at home are allowed with a source-file filter, never into a protected folder', () => {
    const s = setupData()
    const ctx: SelfControlContext = { protectedPaths: s.refs, cwd: s.proj, home: s.home }
    for (const input of [
      { pattern: 'TODO', path: s.home, glob: '*.ts' },
      { pattern: 'TODO', path: '~', glob: '**/*.{ts,tsx}' },
      { pattern: 'TODO', path: s.home, type: 'ts' },
      { pattern: 'TODO', path: s.home, type: 'markdown' },
      { pattern: 'TODO', path: s.data, glob: '*.md' }
    ]) {
      expect(deny('Grep', input, ctx), JSON.stringify(input)).toBeNull()
    }
    for (const input of [
      { pattern: '**/*.ts', path: s.home },
      { pattern: '**/*.md' },
      { pattern: '~/**/*.py' }
    ]) {
      expect(deny('Glob', input, { ...ctx, cwd: s.home }), JSON.stringify(input)).toBeNull()
    }
    for (const input of [
      { pattern: 'x', path: s.home },
      { pattern: 'x', path: s.home, glob: '*.json' },
      { pattern: 'x', path: s.home, glob: '*' },
      { pattern: 'x', path: s.home, glob: '!*.ts' },
      { pattern: 'x', path: s.home, glob: '*.{ts,json}' },
      { pattern: 'x', path: s.home, glob: '*.ts*' },
      { pattern: 'x', path: s.home, type: 'json' },
      { pattern: 'x', path: join(s.data, 'run'), glob: '*.ts' },
      { pattern: 'x', path: join(s.data, 'secrets.json'), type: 'ts' }
    ]) {
      expect(deny('Grep', input, ctx), JSON.stringify(input)).toBe(SELF_CONTROL_DENIAL_MESSAGE)
    }
    for (const input of [
      { pattern: '**/*.json', path: s.home },
      { pattern: '**/daemon.secret', path: s.home },
      { pattern: `${join(s.data, 'run')}/*.ts` },
      { pattern: '*.ts', path: join(s.data, 'codex') }
    ]) {
      expect(deny('Glob', input, ctx), JSON.stringify(input)).toBe(SELF_CONTROL_DENIAL_MESSAGE)
    }
  })
})

describe('packaged app CLI roots (cli-spec 7, Wave 6)', () => {
  const res = '/Applications/OrgAI.app/Contents/Resources'
  const roots = orgaiCliRootsOf(`${res}/app.asar`, 'darwin')
  const ctx: SelfControlContext = { protectedPaths: [], cwd: '/work/repo', platform: 'darwin', cliRoots: roots }
  const deny = (command: string, c: SelfControlContext = ctx): string | null => checkSelfControlDenial('Bash', { command }, c)

  it('orgaiCliRootsOf(<res>/app.asar) covers the unpacked bundle and the launcher folder', () => {
    expect(roots).toContain(`${res}/app.asar.unpacked/out/cli`)
    expect(roots).toContain(`${res}/bin`)
    expect(orgaiCliRootsOf(`${res}/app.asar.unpacked`, 'darwin')).toContain(`${res}/bin`)
    // A dev root gets no packaged entries.
    expect(orgaiCliRootsOf('/repo', 'darwin')).toEqual(['/repo/out/cli', '/repo/src/cli'])
  })

  it('denies every way of running the packaged CLI', () => {
    for (const command of [
      `"${res}/bin/orgai" status`,
      `node "${res}/app.asar.unpacked/out/cli/orgai.mjs" runs list`,
      `node ${res}/app.asar.unpacked/out/cli/inprocHost.mjs`,
      `sh "${res}/bin/orgai" status`,
      `bash ${res}/bin/orgai`,
      `bash -e -o pipefail ${res}/bin/orgai runs list`,
      `zsh -- ${res}/bin/orgai`,
      `dash ${res}/bin/launcher-copy`,
      'sh ./orgai status',
      `ELECTRON_RUN_AS_NODE=1 "${res}/../MacOS/OrgAI" "${res}/app.asar.unpacked/out/cli/orgai.mjs" status`,
      // Shell options that take a value (review High): the value word is not the script.
      `bash -O extglob ${res}/bin/orgai runs list`,
      `bash +O extglob ${res}/bin/orgai runs list`,
      `bash --rcfile /dev/null ${res}/bin/orgai runs list`,
      `bash --init-file /dev/null ${res}/bin/orgai status`,
      `bash --noprofile --rcfile /dev/null ${res}/bin/orgai`,
      `sh -O x ${res}/bin/orgai`,
      `bash -eo pipefail ${res}/bin/orgai`,
      `ksh -R /tmp/x ${res}/bin/orgai`,
      'bash -O extglob ~/.local/bin/orgai runs send r1 hi',
      // Input redirects and sourcing.
      `sh < ${res}/bin/orgai`,
      `sh <${res}/bin/orgai`,
      `bash -s status < ${res}/bin/orgai`,
      `cd ${res}/bin && bash -c '. ./orgai runs list' orgai`,
      `. ${res}/bin/orgai status`,
      `source ${res}/bin/orgai decide d1`,
      // env -S splits its string into assignments and a program.
      `env -S 'ELECTRON_RUN_AS_NODE=1 ${res}/../MacOS/OrgAI' /tmp/x.mjs`,
      `env --split-string='ELECTRON_RUN_AS_NODE=1 /x/OrgAI' /tmp/x.mjs`,
      `env -u FOO -S 'ELECTRON_RUN_AS_NODE=1 /x/OrgAI' /tmp/x.mjs`,
      `env -S 'orgai status'`,
      `node < ${res}/app.asar.unpacked/out/cli/orgai.mjs`
    ]) {
      expect(deny(command), command).toBe(SELF_CONTROL_DENIAL_MESSAGE)
    }
  })

  it('denies cmd /c orgai.cmd on win32', () => {
    const wres = 'C:\\Users\\me\\AppData\\Local\\Programs\\OrgAI\\resources'
    const wctx: SelfControlContext = { protectedPaths: [], cwd: 'C:\\work\\repo', platform: 'win32', shell: 'powershell', cliRoots: orgaiCliRootsOf(`${wres}\\app.asar`, 'win32') }
    expect(wctx.cliRoots).toContain(`${wres}\\bin`)
    expect(checkSelfControlDenial('PowerShell', { command: `cmd /c "${wres}\\bin\\orgai.cmd" status` }, wctx)).toBe(SELF_CONTROL_DENIAL_MESSAGE)
    expect(checkSelfControlDenial('Bash', { command: `cmd /c "${wres}\\bin\\orgai.cmd" status` }, { ...wctx, shell: 'bash' })).toBe(SELF_CONTROL_DENIAL_MESSAGE)
    expect(checkSelfControlDenial('PowerShell', { command: `node "${wres}\\app.asar.unpacked\\out\\cli\\tui.mjs"` }, wctx)).toBe(SELF_CONTROL_DENIAL_MESSAGE)
  })

  it("keeps a project's own scripts and CLI folders allowed", () => {
    for (const command of [
      'node out/cli/server.mjs',
      'node src/cli/index.ts',
      'bash scripts/build.sh',
      'sh -c "echo hi"',
      'bash -x ./run-tests.sh --watch',
      'sh out/cli/start',
      'bash -e build.sh orgai',
      'bash scripts/release.sh orgai',
      'bash -O extglob scripts/build.sh',
      'sh < scripts/setup.sh',
      '. ./venv/bin/activate',
      'source ~/.nvm/nvm.sh',
      "env -S 'FOO=1 node' scripts/x.mjs"
    ]) {
      expect(deny(command), command).toBeNull()
    }
  })
})

describe('stdin, here-strings, substitutions, find -exec, globs, braces and escapes (Wave 6 review)', () => {
  const res = '/Applications/OrgAI.app/Contents/Resources'
  const roots = orgaiCliRootsOf(`${res}/app.asar`, 'darwin')
  const ctx: SelfControlContext = { protectedPaths: [], cwd: '/work/repo', platform: 'darwin', cliRoots: roots, home: '/Users/me' }
  const deny = (command: string, c: SelfControlContext = ctx): string | null => checkSelfControlDenial('Bash', { command }, c)

  it('denies the CLI reaching a shell through stdin, a here-string, a substitution or find -exec', () => {
    for (const command of [
      'cat ~/.local/bin/orgai | sh -s status',
      `cat ${res}/bin/orgai | bash -s runs list`,
      "echo 'orgai runs stop R1' | sh",
      'echo orgai runs stop R1 | bash',
      'printf "%s\\n" "orgai decide d1 approve" | zsh',
      "echo 'x; orgai status' | tr a a | sh",
      "(echo 'orgai status') | sh",
      "echo 'orgai status' | (sh)",
      "echo 'orgai status' |& bash",
      `cat ${res}/app.asar.unpacked/out/cli/orgai.mjs | node`,
      "bash <<< 'orgai runs stop R1'",
      'bash <<<"orgai status"',
      'sh <<< orgai',
      'sh -c "$(cat ~/.local/bin/orgai)"',
      `bash -c "$(cat ${res}/bin/orgai)" x status`,
      'sh <(cat ~/.local/bin/orgai) status',
      'eval "$(echo orgai status)"',
      'find . -exec orgai status \\;',
      'find . -maxdepth 0 -execdir ~/.local/bin/orgai runs list +',
      'fd -x orgai status',
      'watch -n 5 orgai status'
    ]) {
      expect(deny(command), command).toBe(SELF_CONTROL_DENIAL_MESSAGE)
    }
  })

  it('denies a program word that is the launcher through a glob, a brace expansion or a backslash', () => {
    for (const command of [
      `${res}/bin/orga? decide d1 approve`,
      `${res}/bin/* runs list`,
      `${res}/bin/orga{i,} status`,
      `${res}/bin/{orgai,x} runs send r1 hi`,
      `${res}/bin/org\\ai status`,
      `"${res}/bin/"orga? status`,
      `cd ${res}/bin && ./orga? status`,
      `${res}/b?n/orgai status`,
      `/Applications/OrgAI.app/Contents/Res*/bin/launcher status`,
      `${res}/bin/launcher-copy status`,
      '~/.local/bin/orga* status',
      '~/.local/bin/[o]rgai status',
      'org\\ai status',
      'orga{i,} status',
      `sh ${res}/bin/orga?`,
      'sh ~/.local/bin/org\\ai status',
      `node ${res}/app.asar.unpacked/out/cli/orga?.mjs`,
      `source ${res}/bin/o*`
    ]) {
      expect(deny(command), command).toBe(SELF_CONTROL_DENIAL_MESSAGE)
    }
  })

  it('keeps ordinary pipes, globs, braces and escapes allowed', () => {
    for (const command of [
      'echo * | sort',
      'ls *.js',
      'node build.mjs src/*.js',
      'for f in $(ls *.md); do echo $f; done',
      'cat package.json | node -e "process.stdin.pipe(process.stdout)"',
      'git log --oneline | head -5',
      'echo orgai | grep org',
      'grep -rn orgai src | wc -l',
      'cat scripts/build.sh | bash',
      'mkdir -p src/{a,b}',
      'echo {1..100}',
      'cp file.{js,bak}',
      'find . -name "*.ts" -exec grep -l orgai {} \\;',
      'bash <<< "echo hi"',
      'cat <<EOF > notes.md',
      'echo a\\ b',
      'ls ./scripts/*.sh',
      'echo "$(git rev-parse HEAD)"',
      'if [ -f x ]; then echo y; fi',
      'printf "%s" "${HOME}"'
    ]) {
      expect(deny(command), command).toBeNull()
    }
  })

  it('fails closed on a brace expansion too large to read', () => {
    const big = Array.from({ length: 20 }, (_, k) => `{a${k},b${k}}`).join('')
    expect(deny(`echo ${big}`)).toBe(SELF_CONTROL_UNCHECKED_MESSAGE)
  })
})

describe('commandRunsOrgaiCli', () => {
  it('reads nested shell texts and package runners', () => {
    expect(commandRunsOrgaiCli("pwsh -NoProfile -Command 'orgai status'")).toBe(true)
    expect(commandRunsOrgaiCli('npx --package=orgai orgai-cli x')).toBe(true)
    expect(commandRunsOrgaiCli('eval orgai status')).toBe(true)
    expect(commandRunsOrgaiCli('ps -p 123')).toBe(false)
    expect(commandRunsOrgaiCli('npm install')).toBe(false)
  })
})

describe('Wave 7 gate additions (cli-standalone.md 8.4)', () => {
  /** A data dir reached through a link (lexical) and its real folder, with the vault files present. */
  function setup(): { data: string; real: string; refs: string[]; home: string; base: string } {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'orgai-scg7-')))
    dirs.push(base)
    const real = join(base, 'real-data')
    for (const d of ['run', 'codex', 'skills']) mkdirSync(join(real, d), { recursive: true })
    for (const f of ['vault.json', 'vault.json.tmp', 'secrets.json', 'projects.json']) writeFileSync(join(real, f), '{}')
    const data = join(base, 'data')
    symlinkSync(real, data, process.platform === 'win32' ? 'junction' : 'dir')
    return { data, real, refs: controlProtectedPaths(data), home: base, base }
  }
  const bash = (command: string, ctx: SelfControlContext): string | null => checkSelfControlDenial('Bash', { command }, ctx)
  const ps = (command: string, ctx: SelfControlContext): string | null => checkSelfControlDenial('PowerShell', { command }, ctx)
  const encode = (text: string): string => Buffer.from(text, 'utf16le').toString('base64')

  describe('package runners naming the package', () => {
    const ctx: SelfControlContext = { protectedPaths: [], cwd: '/work/proj', home: '/home/u' }
    it('denies npx, npm exec / x, pnpm dlx / exec, pnpx, yarn dlx, bunx and bun x with orgai or @orgai/cli', () => {
      for (const command of [
        'npx @orgai/cli status',
        'npx @orgai/cli@1.2.3 status',
        "npx '@orgai/cli@^1' status",
        'npx -y @orgai/cli@latest runs list',
        'npx --yes -- @orgai/cli status',
        'npx --package @orgai/cli orgai status',
        'npx --package=@orgai/cli -- orgai status',
        'npx --package=@orgai/cli@2.0.0 orgai',
        'npx -p @orgai/cli orgai status',
        'npx -p@orgai/cli orgai',
        'npx -p orgai@1 orgai',
        'npm exec @orgai/cli',
        'npm exec -- @orgai/cli status',
        'npm exec --package=@orgai/cli -- orgai status',
        'npm x @orgai/cli',
        'npm -y exec @orgai/cli',
        'npm --yes exec orgai status',
        'npm exec -c "orgai status"',
        'pnpm dlx @orgai/cli status',
        'pnpm exec orgai status',
        'pnpm --package=@orgai/cli dlx orgai',
        'pnpm dlx -c "orgai runs stop R1"',
        'pnpx @orgai/cli',
        'yarn dlx @orgai/cli status',
        'yarn dlx -p @orgai/cli orgai status',
        'bunx @orgai/cli status',
        'bunx orgai',
        'bun x @orgai/cli',
        'npx.cmd @orgai/cli status',
        'C:\\nodejs\\npx.cmd @orgai/cli',
        '/usr/local/bin/npx @orgai/cli status',
        // Quoting, escapes and braces.
        'npx "@orgai"/cli status',
        "npx @'orgai/cli' status",
        'npx @orgai/c\\li status',
        'npx @orga{i,x}/cli status',
        'npx @ORGAI/CLI status',
        // Aliases, tarballs and URLs.
        'npx npm:@orgai/cli status',
        'npx --package=x@npm:@orgai/cli x status',
        'npx https://registry.npmjs.org/@orgai/cli/-/cli-1.0.0.tgz',
        'npx https://registry.npmjs.org/@orgai%2fcli',
        // npx -c / --call texts.
        "npx -c 'orgai status'",
        "npx --call 'orgai daemon stop'",
        // Wrappers, nesting and pipes.
        'timeout 5 npx @orgai/cli status',
        'env FOO=1 npx @orgai/cli',
        "env -S 'npx @orgai/cli' status",
        "bash -c 'npx @orgai/cli status'",
        'sh -c "npm exec -- @orgai/cli status"',
        "echo 'npx @orgai/cli status' | sh",
        'echo "$(npx @orgai/cli status)"',
        'xargs npx @orgai/cli < ids.txt',
        // The installed package by path.
        'node node_modules/@orgai/cli/out/cli/index.mjs status',
        'node ~/.npm-global/lib/node_modules/@orgai/cli/dist/main.js',
        './node_modules/@orgai/cli/bin/run status',
        'cat node_modules/@orgai/cli/bin/run | sh'
      ]) {
        expect(bash(command, ctx), command).toBe(SELF_CONTROL_DENIAL_MESSAGE)
        expect(commandRunsOrgaiCli(command), command).toBe(true)
      }
    })

    it('allows other packages and non-running npm commands', () => {
      for (const command of [
        'npx @orgai/cli-tools status',
        'npx @other/cli status',
        'npx prettier --write .',
        'npx vitest run src/cli',
        'npm exec vitest',
        'pnpm dlx create-vite app',
        'yarn dlx eslint .',
        'bunx tsc --noEmit',
        'npm install @orgai/cli',
        'npm view @orgai/cli version',
        'npm run build',
        'npx cli status',
        'echo @orgai/cli'
      ]) {
        expect(bash(command, ctx), command).toBeNull()
      }
    })
  })

  describe('vault.json* and secrets.json* in the data folder', () => {
    it('vaultPrefixProtections finds the data folder in both spellings from the protected paths', () => {
      const s = setup()
      const dirsFound = vaultPrefixProtections(s.refs).map((p) => p.dir)
      expect(dirsFound).toContain(s.data)
      expect(dirsFound).toContain(s.real)
      expect(vaultPrefixProtections(s.refs)[0].prefixes).toEqual(['vault.json', 'secrets.json'])
      // A key file named secrets.json elsewhere (no run/ sibling) is not a data folder.
      expect(vaultPrefixProtections(['/k/secrets.json'])).toEqual([])
      expect(vaultPrefixProtections([])).toEqual([])
    })

    it('denies file tools on every vault.json* / secrets.json* sibling, lexical and canonical', () => {
      const s = setup()
      const ctx: SelfControlContext = { protectedPaths: s.refs, home: s.home }
      for (const root of [s.data, s.real]) {
        for (const name of ['vault.json', 'vault.json.tmp', 'vault.json.reset-2026-11-05T12-00-00Z', 'vault.json.corrupt-1730000000000', 'secrets.json.tmp', 'secrets.json.corrupt-x', 'secrets.json.bak', 'vault.jsonx']) {
          const t = join(root, name)
          for (const tool of ['Read', 'Edit', 'Write', 'MultiEdit']) expect(checkSelfControlDenial(tool, { file_path: t }, ctx), `${tool} ${t}`).toBe(SELF_CONTROL_DENIAL_MESSAGE)
          expect(checkSelfControlDenial('NotebookEdit', { notebook_path: t }, ctx)).toBe(SELF_CONTROL_DENIAL_MESSAGE)
          expect(checkSelfControlDenial('Grep', { pattern: 'x', path: t }, ctx)).toBe(SELF_CONTROL_DENIAL_MESSAGE)
        }
      }
      // Relative, `~` and `..` spellings.
      expect(checkSelfControlDenial('Read', { file_path: 'vault.json.tmp' }, { ...ctx, cwd: s.data })).toBe(SELF_CONTROL_DENIAL_MESSAGE)
      expect(checkSelfControlDenial('Read', { file_path: '../vault.json' }, { ...ctx, cwd: join(s.data, 'skills') })).toBe(SELF_CONTROL_DENIAL_MESSAGE)
      expect(checkSelfControlDenial('Write', { file_path: '~/data/vault.json.reset-1', content: '' }, ctx)).toBe(SELF_CONTROL_DENIAL_MESSAGE)
      expect(checkSelfControlDenial('Read', { file_path: join(s.data, '.', 'vault.json') }, ctx)).toBe(SELF_CONTROL_DENIAL_MESSAGE)
    })

    it.runIf(process.platform === 'darwin' || process.platform === 'win32')('folds case on darwin and win32', () => {
      const s = setup()
      expect(checkSelfControlDenial('Read', { file_path: join(s.real, 'Vault.JSON.tmp') }, { protectedPaths: s.refs })).toBe(SELF_CONTROL_DENIAL_MESSAGE)
      expect(bash(`cat ${join(s.data, 'SECRETS.json.corrupt-1')}`, { protectedPaths: s.refs, home: s.home })).toBe(SELF_CONTROL_DENIAL_MESSAGE)
    })

    it('follows a link to a vault file from outside the data folder', () => {
      const s = setup()
      const link = join(s.base, 'innocent.txt')
      symlinkSync(join(s.real, 'vault.json'), link)
      const ctx: SelfControlContext = { protectedPaths: s.refs, home: s.home, cwd: s.base }
      expect(checkSelfControlDenial('Read', { file_path: link }, ctx)).toBe(SELF_CONTROL_DENIAL_MESSAGE)
      expect(bash(`cat ${link}`, ctx)).toBe(SELF_CONTROL_DENIAL_MESSAGE)
      expect(bash('cat innocent.txt', ctx)).toBe(SELF_CONTROL_DENIAL_MESSAGE)
    })

    it('denies Glob / Grep searches that may match such a name in the data folder', () => {
      const s = setup()
      const ctx: SelfControlContext = { protectedPaths: s.refs, home: s.home, cwd: join(s.base, 'proj') }
      for (const input of [
        { pattern: 'vault*', path: s.data },
        { pattern: 'v?ult.json.*', path: s.real },
        { pattern: '[vs]*', path: s.data },
        { pattern: '*.tmp', path: s.data },
        { pattern: '*corrupt*', path: s.data },
        { pattern: join(s.data, '*.json') },
        { pattern: join(s.real, 'secrets.json.*') },
        { pattern: '~/data/vault.json.reset-*' }
      ]) {
        expect(checkSelfControlDenial('Glob', input, ctx), JSON.stringify(input)).toBe(SELF_CONTROL_DENIAL_MESSAGE)
      }
      for (const input of [{ pattern: 'p*', path: s.data }, { pattern: '*.md', path: s.data }, { pattern: 'vault*', path: join(s.data, 'skills') }, { pattern: join(s.data, 'proj*.json') }]) {
        expect(checkSelfControlDenial('Glob', input, ctx), JSON.stringify(input)).toBeNull()
      }
    })

    it('denies shell words naming such a file: paths, cd, $HOME, globs, quoting, escapes, braces and nesting', () => {
      const s = setup()
      const ctx: SelfControlContext = { protectedPaths: s.refs, cwd: join(s.base, 'proj'), home: s.home }
      for (const command of [
        `cat ${join(s.data, 'vault.json')}`,
        `cat ${join(s.real, 'vault.json.tmp')}`,
        `cp ${join(s.data, 'vault.json.reset-2026')} /tmp/x`,
        `base64 ${join(s.data, 'secrets.json.corrupt-1')}`,
        `cd ${s.data} && cat vault.json`,
        `cd ${s.data}; tar czf /tmp/v.tgz vault.json.corrupt-1`,
        'cat "$HOME/data/vault.json"',
        'cat ${HOME}/data/vault.json.tmp',
        'cat ~/data/vault.json',
        'cat ~/data/vault*',
        `cat ${s.data}/v*`,
        `cat ${s.data}/*.json`,
        `cat ${s.data}/*`,
        `cat ${s.data}/[v]ault.json`,
        `cat ${s.data}/vault.js?n`,
        `cat ${s.data}/*.tmp`,
        `cat ${s.data}/vault.json\\.tmp`,
        `cat ${s.data}/vau''lt.json`,
        `cat "${s.data}"/vault.json`,
        `cat '${s.data}/vault.json'`,
        `cat ${s.data}/{vault,x}.json`,
        `cat ${s.data}/{x,secrets}.json.tmp`,
        `cat ${s.data}/vault.json{,.tmp}`,
        `bash -c 'cat ${s.data}/vault.json'`,
        `sh -c "cat $HOME/data/vault.json.tmp"`,
        `echo "$(cat ${s.data}/vault.json)"`,
        `diff <(cat ${s.data}/vault.json) /dev/null`,
        `node -e "require('fs').readFileSync('${s.data}/vault.json')"`,
        `cat < ${s.data}/vault.json`,
        `ln -s ${s.data}/vault.json /tmp/v`
      ]) {
        expect(bash(command, ctx), command).toBe(SELF_CONTROL_DENIAL_MESSAGE)
      }
      for (const command of [
        `ls ${s.data}`,
        `ls ${s.data}/*.md`,
        `ls ${s.data}/p*`,
        `cat ${s.data}/projects.json`,
        `cat ${s.data}/skills/vault.json`,
        `cat ${s.data}/my-vault.json`,
        `cat ${s.data}/vaults.json`,
        'cat vault.json',
        'cat ./secrets.json.example',
        'grep -rn vault.json src'
      ]) {
        expect(bash(command, ctx), command).toBeNull()
      }
    })

    it('reads an escaped space and the folders the data folder lives in (macOS, Windows, Linux defaults)', () => {
      const base = realpathSync(mkdtempSync(join(tmpdir(), 'orgai-scg7-')))
      dirs.push(base)
      const mac = join(base, 'Library', 'Application Support', 'OrgAI')
      const win = join(base, 'AppData', 'Roaming', 'OrgAI')
      const linux = join(base, '.config', 'OrgAI')
      for (const d of [mac, win, linux]) mkdirSync(join(d, 'run'), { recursive: true })
      const ctx: SelfControlContext = { protectedPaths: [...controlProtectedPaths(mac), ...controlProtectedPaths(win), ...controlProtectedPaths(linux)], cwd: join(base, 'proj'), home: base }
      for (const command of [
        'cat ~/Library/Application\\ Support/OrgAI/vault.json',
        'cat ~/Library/Application\\ Support/OrgAI/secrets.json',
        'cat ~/Library/Application\\ Support/OrgAI/run/daemon.secret',
        `cat ${base}/Library/Application\\ Support/OrgAI/vault.json.tmp`,
        'cat "$HOME/Library/Application Support/OrgAI/vault.json"',
        'cat ~/Library/Application\\ Support/OrgAI/{x,vault}.json',
        'cat ~/Library/Application\\ Support/OrgAI/v*',
        'cat $APPDATA/OrgAI/vault.json',
        'cat ${APPDATA}/OrgAI/secrets.json.tmp',
        'cat %APPDATA%/OrgAI/vault.json',
        'cat $XDG_CONFIG_HOME/OrgAI/vault.json',
        'cat ${XDG_CONFIG_HOME}/OrgAI/run/daemon.json'
      ]) {
        expect(bash(command, ctx), command).toBe(SELF_CONTROL_DENIAL_MESSAGE)
      }
      expect(ps('Get-Content $env:APPDATA/OrgAI/vault.json', ctx)).toBe(SELF_CONTROL_DENIAL_MESSAGE)
      expect(ps('Get-Content ~/Library/Application` Support/OrgAI/vault.json', ctx)).toBe(SELF_CONTROL_DENIAL_MESSAGE)
      expect(bash('ls ~/Library/Application\\ Support/OrgAI', ctx)).toBeNull()
      expect(bash('ls $XDG_CONFIG_HOME/OrgAI', ctx)).toBeNull()
    })

    it('protects the vault key files exactly (ORGAI_VAULT_KEY_FILE and custody.keyFile), not their neighbours', () => {
      const s = setup()
      const key = join(s.base, 'keys', 'orgai.key')
      const ctx: SelfControlContext = { protectedPaths: controlProtectedPaths(s.data, undefined, { vaultKeyFiles: [key] }), cwd: join(s.base, 'proj'), home: s.home }
      expect(checkSelfControlDenial('Read', { file_path: key }, ctx)).toBe(SELF_CONTROL_DENIAL_MESSAGE)
      expect(bash(`cat ${key}`, ctx)).toBe(SELF_CONTROL_DENIAL_MESSAGE)
      expect(bash(`cat ${join(s.base, 'keys')}/*.key`, ctx)).toBe(SELF_CONTROL_DENIAL_MESSAGE)
      expect(checkSelfControlDenial('Read', { file_path: `${key}.bak` }, ctx)).toBeNull()
      // The vault prefix rule still applies with key files in the list.
      expect(bash(`cat ${join(s.data, 'vault.json')}`, ctx)).toBe(SELF_CONTROL_DENIAL_MESSAGE)
    })
  })

  it('win32 spellings: the prefix rule, %APPDATA% and drive paths (pure, no file system)', () => {
    const data = 'C:\\Users\\u\\AppData\\Roaming\\OrgAI'
    const refs = [`${data}\\run`, `${data}\\secrets.json`, `${data}\\codex`]
    const ctx: SelfControlContext = { protectedPaths: refs, platform: 'win32', home: 'C:\\Users\\u', cwd: 'C:\\work' }
    for (const t of [`${data}\\vault.json`, `${data}\\VAULT.JSON.tmp`, 'c:/users/u/appdata/roaming/orgai/secrets.json.corrupt-1']) {
      expect(checkSelfControlDenial('Read', { file_path: t }, ctx), t).toBe(SELF_CONTROL_DENIAL_MESSAGE)
    }
    expect(checkSelfControlDenial('Read', { file_path: `${data}\\projects.json` }, ctx)).toBeNull()
    for (const command of [`type ${data}\\vault.json.tmp`, 'type %APPDATA%\\OrgAI\\vault.json', `type ${data}\\v*`, 'cat /c/Users/u/AppData/Roaming/OrgAI/vault.json', `type "${data}\\vault.json. "`]) {
      expect(bash(command, ctx), command).toBe(SELF_CONTROL_DENIAL_MESSAGE)
    }
    expect(ps('Get-Content $env:APPDATA\\OrgAI\\vault.json', ctx)).toBe(SELF_CONTROL_DENIAL_MESSAGE)
    expect(ps(`Copy-Item -Path:${data}\\secrets.json.tmp -Destination C:\\x`, ctx)).toBe(SELF_CONTROL_DENIAL_MESSAGE)
    expect(ps(`Get-ChildItem ${data}`, ctx)).toBeNull()
  })

  describe('ORGAI_VAULT_* references', () => {
    const ctx: SelfControlContext = { protectedPaths: [], cwd: '/work/proj', home: '/home/u' }
    it('denies expansions, assignments, exports and environment reads of ORGAI_VAULT_*', () => {
      for (const command of [
        'echo $ORGAI_VAULT_KEY_FILE',
        'echo "${ORGAI_VAULT_KEY_FILE}"',
        'echo ${ORGAI_VAULT_KEY_FILE:-none}',
        'echo ${#ORGAI_VAULT_KEY_FILE}',
        'echo ${!ORGAI_VAULT@}',
        'cat "$ORGAI_VAULT_KEY_FILE"',
        'echo $orgai_vault_key_file',
        'ORGAI_VAULT_KEY_FILE=/tmp/k node x.js',
        'ORGAI_VAULT_KEY_FILE+=x node x.js',
        'FOO=1 ORGAI_VAULT_KEY_FILE=/tmp/k ./host',
        'env ORGAI_VAULT_KEY_FILE=/tmp/k node x.js',
        'env "ORGAI_VAULT_KEY_FILE=/tmp/k" node x.js',
        "env -S 'ORGAI_VAULT_KEY_FILE=/tmp/k node x.js'",
        'env -u ORGAI_VAULT_KEY_FILE node x.js',
        'export ORGAI_VAULT_KEY_FILE=/tmp/k',
        'export ORGAI_VAULT_KEY_FILE',
        'declare -x ORGAI_VAULT_KEY_FILE=/tmp/k',
        'unset ORGAI_VAULT_KEY_FILE',
        'printenv ORGAI_VAULT_KEY_FILE',
        'printenv -0 ORGAI_VAULT_KEY_FILE',
        'env | grep ORGAI_VAULT',
        "sh -c 'echo $ORGAI_VAULT_KEY_FILE'",
        "bash -c 'printenv ORGAI_VAULT_KEY_FILE'",
        'python3 -c "import os; print(os.environ[\'ORGAI_VAULT_KEY_FILE\'])"',
        "python3 -c \"import os; print(os.getenv('ORGAI_VAULT_KEY_FILE'))\"",
        'node -e "console.log(process.env.ORGAI_VAULT_KEY_FILE)"',
        "node -e \"console.log(process.env['ORGAI_VAULT_KEY_FILE'])\"",
        'set ORGAI_VAULT_KEY_FILE=C:\\k',
        'setx ORGAI_VAULT_KEY_FILE C:\\k',
        'echo %ORGAI_VAULT_KEY_FILE%',
        'echo !ORGAI_VAULT_KEY_FILE!'
      ]) {
        expect(bash(command, ctx), command).toBe(SELF_CONTROL_DENIAL_MESSAGE)
      }
      for (const command of [
        '$env:ORGAI_VAULT_KEY_FILE',
        "$env:ORGAI_VAULT_KEY_FILE = 'C:\\k'",
        '${env:ORGAI_VAULT_KEY_FILE}',
        'Get-Item Env:ORGAI_VAULT_KEY_FILE',
        'Get-ChildItem env:\\ORGAI_VAULT_KEY_FILE',
        'Remove-Item Env:ORGAI_VAULT_KEY_FILE',
        "[Environment]::GetEnvironmentVariable('ORGAI_VAULT_KEY_FILE')",
        "[System.Environment]::SetEnvironmentVariable('ORGAI_VAULT_KEY_FILE', 'x', 'User')"
      ]) {
        expect(ps(command, ctx), command).toBe(SELF_CONTROL_DENIAL_MESSAGE)
      }
    })

    it('allows plain mentions of the name (searching, docs, messages)', () => {
      for (const command of [
        'grep -rn ORGAI_VAULT_KEY_FILE src',
        'grep -rn "ORGAI_VAULT_KEY_FILE=" .',
        'rg ORGAI_VAULT_ docs',
        "echo 'ORGAI_VAULT_KEY_FILE names the key file'",
        'git log --grep ORGAI_VAULT'
      ]) {
        expect(bash(command, ctx), command).toBeNull()
      }
    })
  })

  describe('key custodian tools', () => {
    const ctx: SelfControlContext = { protectedPaths: [], cwd: '/work/proj', home: '/home/u' }
    it('denies security reading, writing, dumping or exporting keychain items, -i and stdin', () => {
      for (const command of [
        'security find-generic-password -s "OrgAI Vault" -a abc -w',
        '/usr/bin/security find-generic-password -w -s x',
        'security find-internet-password -s example.com',
        'security add-generic-password -s x -a y -w z',
        'security delete-generic-password -s x',
        'security dump-keychain',
        'security dump-keychain -d login.keychain',
        'security export -k login.keychain -o /tmp/x.p12',
        'security -v find-generic-password -w',
        'security -i',
        'security -q -i',
        'security -iq',
        'security -qi',
        'security',
        'security -v',
        'security -i<cmds.txt',
        'security -i < cmds.txt',
        'security < cmds.txt',
        "security -i <<< 'find-generic-password -w -s x'",
        'security -i <<EOF\nfind-generic-password -w -s x\nEOF',
        "printf 'find-generic-password -s x -w\\n' | security -i",
        'echo dump-keychain | security',
        'cat cmds | /usr/bin/security -q',
        'security show-keychain-info "OrgAI Vault"',
        "security find-key -l 'OrgAI Vault'",
        'security find-certificate -c OrgAI\\ Vault',
        'sudo security dump-keychain',
        'env FOO=1 security find-generic-password -w',
        'xcrun security find-generic-password -w',
        'xcrun --sdk macosx security -i',
        'arch -arm64 security -i',
        'launchctl asuser 501 security find-generic-password -w',
        "env -S 'security dump-keychain'",
        "bash -c 'security find-generic-password -w -s x'",
        "zsh -c \"security -i <<< 'dump-keychain'\"",
        "echo 'security dump-keychain' | sh",
        'echo "$(security find-generic-password -w -s x)"',
        'find . -exec security dump-keychain \;',
        'nohup security export -o /tmp/x &',
        "cat <<'EOF' | security -i\nfind-generic-password -w -s x\nEOF",
        // Code that calls the tool itself.
        "python3 -c \"import subprocess; subprocess.run(['security', 'find-generic-password', '-w', '-s', 'x'])\"",
        "python3.12 -c 'import os; os.system(\"security dump-keychain\")'",
        "python3 <<'EOF'\nimport subprocess\nsubprocess.run(['security', 'dump-keychain'])\nEOF",
        "python3 -c \"import keyring; print(keyring.get_password('OrgAI Vault', 'abc'))\"",
        "osascript -e 'do shell script \"security find-generic-password -w -s x\"'",
        "perl -e 'system(\"secret-tool\", \"lookup\", \"service\", \"orgai\")'",
        "node -e \"require('child_process').execSync('security -q find-generic-password -w')\"",
        "ruby -e 'puts `security dump-keychain`'",
        "python3 -c \"import secretstorage; secretstorage.dbus_init().get_object('org.freedesktop.secrets', '/')\"",
        "python -c \"import win32crypt; win32crypt.CryptUnprotectData(b)\""
      ]) {
        expect(bash(command, ctx), JSON.stringify(command)).toBe(SELF_CONTROL_DENIAL_MESSAGE)
      }
    })

    it('allows the other security subcommands and words that only mention security', () => {
      for (const command of [
        "python3 -c 'import ssl; print(ssl.OPENSSL_VERSION)'",
        "node -e \"console.log('security review done')\"",
        'security find-certificate -a -c Apple',
        'security find-identity -v -p codesigning',
        'security cms -D -i embedded.mobileprovision',
        'security verify-cert -c cert.pem',
        'security list-keychains',
        'security show-keychain-info',
        'security unlock-keychain -p "" build.keychain',
        'grep -rn security src',
        'grep -i security notes.md',
        'git log --grep security',
        'echo "run the security command"',
        'npm audit --audit-level=high # security'
      ]) {
        expect(bash(command, ctx), command).toBeNull()
      }
    })

    it('denies any secret-tool call and D-Bus clients naming the Secret Service', () => {
      for (const command of [
        'secret-tool lookup service orgai vault abc',
        'secret-tool --version',
        '/usr/bin/secret-tool search service orgai',
        'secret-tool store --label="OrgAI vault" service orgai vault abc',
        'env FOO=1 secret-tool clear service orgai',
        'echo x | secret-tool store --label=x service orgai',
        "bash -c 'secret-tool lookup service orgai vault abc'",
        'flatpak-spawn --host secret-tool lookup service orgai',
        'busctl --user call org.freedesktop.secrets /org/freedesktop/secrets org.freedesktop.Secret.Service SearchItems a{ss} 0',
        'gdbus call --session --dest org.freedesktop.secrets --object-path /org/freedesktop/secrets --method org.freedesktop.Secret.Service.SearchItems "{}"',
        'dbus-send --session --print-reply --dest=org.freedesktop.secrets /org/freedesktop/secrets org.freedesktop.DBus.Introspectable.Introspect',
        'dbus-send --session --dest=x /org/freedesktop/secrets org.freedesktop.Secret.Service.Unlock',
        'qdbus org.freedesktop.secrets',
        "sh -c 'gdbus introspect --session --dest org.freedesktop.secrets --object-path /'"
      ]) {
        expect(bash(command, ctx), command).toBe(SELF_CONTROL_DENIAL_MESSAGE)
      }
      for (const command of [
        'which secret-tool',
        'apt-get install -y libsecret-tools',
        'busctl --user list',
        'gdbus introspect --session --dest org.gnome.Shell --object-path /',
        'dbus-send --session --dest=org.freedesktop.Notifications /org/freedesktop/Notifications x',
        'grep -rn org.freedesktop.secrets src'
      ]) {
        expect(bash(command, ctx), command).toBeNull()
      }
    })

    it('denies PowerShell text naming ProtectedData or Unprotect, encoded commands included', () => {
      for (const command of [
        "pwsh -c '[Security.Cryptography.ProtectedData]::Unprotect($b, $null, 0)'",
        'powershell.exe -Command "Add-Type -AssemblyName System.Security; [System.Security.Cryptography.ProtectedData]::Unprotect($b,$e,\'CurrentUser\')"',
        'pwsh -NoProfile -Command Unprotect-CmsMessage -Path x',
        "cmd /c powershell -c [Security.Cryptography.ProtectedData]::Unprotect(1)",
        "echo '[Security.Cryptography.ProtectedData]::Unprotect(1)' | pwsh -c -",
        "echo '[Security.Cryptography.ProtectedData]::Unprotect(1)' | pwsh -",
        "pwsh <<< '[Security.Cryptography.ProtectedData]::Unprotect(1)'",
        `pwsh -EncodedCommand ${encode('[Security.Cryptography.ProtectedData]::Unprotect($b, $null, 0)')}`,
        `pwsh -enc ${encode('Unprotect-CmsMessage -Path x')}`,
        `powershell -ec ${encode('[Security.Cryptography.ProtectedData]::Unprotect(1)')}`,
        `powershell.exe -e ${encode('[Security.Cryptography.ProtectedData]::Unprotect(1)')}`,
        `pwsh -EncodedC ${encode('[Security.Cryptography.ProtectedData]::Unprotect(1)')}`,
        `bash -c "pwsh -enc ${encode('[Security.Cryptography.ProtectedData]::Unprotect(1)')}"`,
        // An encoded command running the CLI.
        `pwsh -enc ${encode('orgai runs stop R1')}`
      ]) {
        expect(bash(command, ctx), command).toBe(SELF_CONTROL_DENIAL_MESSAGE)
      }
      for (const command of [
        'Add-Type -AssemblyName System.Security; [System.Security.Cryptography.ProtectedData]::Unprotect($b, $null, "CurrentUser")',
        'Unprotect-CmsMessage -Path secret.txt',
        `powershell -EncodedCommand ${encode('[Security.Cryptography.ProtectedData]::Unprotect(1)')}`,
        `& pwsh -enc ${encode('orgai status')}`
      ]) {
        expect(ps(command, ctx), command).toBe(SELF_CONTROL_DENIAL_MESSAGE)
      }
      for (const command of ['pwsh -c Get-ChildItem', `pwsh -enc ${encode('Get-ChildItem')}`, 'grep -e abcdefgh file']) {
        expect(bash(command, ctx), command).toBeNull()
      }
      expect(ps('Get-ChildItem', ctx)).toBeNull()
    })

    it('an encoded command naming a protected path is denied', () => {
      const s = setup()
      const ctx2: SelfControlContext = { protectedPaths: s.refs, cwd: join(s.base, 'proj'), home: s.home }
      expect(bash(`pwsh -enc ${encode(`Get-Content ${join(s.data, 'vault.json')}`)}`, ctx2)).toBe(SELF_CONTROL_DENIAL_MESSAGE)
      expect(ps(`powershell -enc ${encode(`Get-Content ${join(s.data, 'run', 'daemon.secret')}`)}`, ctx2)).toBe(SELF_CONTROL_DENIAL_MESSAGE)
    })
  })
})

describe('Wave 7 scan cost', () => {
  it('reads long hostile texts in linear time (quotes, backslashes, braces, custodian words)', () => {
    const data = '/home/u/.config/OrgAI'
    const ctx: SelfControlContext = { protectedPaths: controlProtectedPaths(data), cwd: '/work', home: '/home/u', platform: 'linux' }
    const texts = [
      `echo ${'"\\'.repeat(40_000)}`,
      `echo ${"'a".repeat(40_000)}`,
      `echo ${'security '.repeat(10_000)}x && node x.js`,
      `echo ${'orgai\\'.repeat(20_000)}`,
      `echo ${'env '.repeat(20_000)}`,
      `echo ${'{a,b}'.repeat(5)}`
    ]
    for (const command of texts) {
      const t0 = Date.now()
      checkSelfControlDenial('Bash', { command }, ctx)
      expect(Date.now() - t0, command.slice(0, 40)).toBeLessThan(2000)
    }
  })
})
