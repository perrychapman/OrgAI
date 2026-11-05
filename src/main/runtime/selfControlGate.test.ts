import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
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
