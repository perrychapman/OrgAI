import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SELF_CONTROL_DENIAL_MESSAGE, SELF_CONTROL_UNCHECKED_MESSAGE, checkSelfControlDenial, commandRunsOrgaiCli, controlProtectedPaths, type SelfControlContext } from './selfControlGate'

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
        join(root, 'secrets.json.bak')
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
      // Past the word limit (2,000).
      `true ${Array.from({ length: 2100 }, (_, k) => `w${k}`).join(' ')}; ${secret}`,
      // Past the segment budget (2,000) before the CLI call.
      `${Array(2100).fill(':').join('; ')}; orgai runs stop R1`,
      // Over 32 KB.
      `echo ${'a'.repeat(33 * 1024)}; ${secret}`,
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

  it('never throws', () => {
    expect(checkSelfControlDenial('Read', { file_path: '/x' }, null as unknown as SelfControlContext)).toBeNull()
    expect(checkSelfControlDenial('Bash', { command: 'orgai' }, { protectedPaths: null as unknown as string[] })).toBe(SELF_CONTROL_DENIAL_MESSAGE)
    expect(checkSelfControlDenial('Read', null, { protectedPaths: ['/x'] })).toBeNull()
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
