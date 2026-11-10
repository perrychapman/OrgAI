import { describe, expect, it } from 'vitest'
import {
  TERMINAL_APPS,
  agentKindOf,
  attestThisTerminal,
  decideTerminalAttestation,
  devPathOfTty,
  gatherTerminalFacts,
  multiplexerOf,
  parsePidList,
  parseProcTable,
  processLabel,
  sessionLeaderOf,
  trustedLauncher,
  type ProcInfo,
  type ProcRow,
  type TerminalFacts
} from './terminalAttestation'

const TTY = 'ttys001'
const RDEV = 0x1000001
const ME = 501
const TERMINAL = '/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal'

/** launchd -> Terminal.app (no tty) -> login (root, the session leader) -> zsh -> orgai (pid 400): the user's own tab. */
function userTable(extra: ProcRow[] = []): ProcRow[] {
  return [
    { pid: 1, ppid: 0, uid: 0, args: '/sbin/launchd' },
    { pid: 100, ppid: 1, uid: ME, args: TERMINAL },
    { pid: 200, ppid: 100, uid: 0, tty: TTY, args: 'login -pf me' },
    { pid: 300, ppid: 200, uid: ME, tty: TTY, args: '-zsh' },
    { pid: 400, ppid: 300, uid: ME, tty: TTY, args: 'node /usr/local/lib/node_modules/orgai-cli/out/cli/orgai.mjs' },
    ...extra
  ]
}

function facts(over: Partial<TerminalFacts> = {}): TerminalFacts {
  return {
    platform: 'darwin',
    pid: 400,
    stdinIsTty: true,
    stdoutIsTty: true,
    stdinRdev: RDEV,
    stdoutRdev: RDEV,
    cttyRdev: RDEV,
    table: userTable(),
    procInfo: { 100: { exe: TERMINAL, name: 'Terminal' } },
    ttyOpeners: [300, 400],
    ...over
  }
}

const full = (f: TerminalFacts) => decideTerminalAttestation(f, { coResident: true })

describe('decideTerminalAttestation: the user terminal passes', () => {
  it("the user's own Terminal.app tab, with a job of its shell beside it (on the terminal and holding it open)", () => {
    const f = facts({ table: userTable([{ pid: 500, ppid: 300, uid: ME, tty: TTY, args: 'vim notes.md' }]), ttyOpeners: [300, 400, 500] })
    expect(full(f)).toEqual({ ok: true, tty: TTY })
    expect(decideTerminalAttestation(f, { coResident: false })).toEqual({ ok: true, tty: TTY })
  })

  it('Linux: a gnome-terminal tab (pts names, the server under systemd --user)', () => {
    const table: ProcRow[] = [
      { pid: 1, ppid: 0, uid: 0, args: '/sbin/init' },
      { pid: 900, ppid: 1, uid: 1000, args: '/usr/lib/systemd/systemd --user' },
      { pid: 910, ppid: 900, uid: 1000, args: '/usr/libexec/gnome-terminal-server' },
      { pid: 920, ppid: 910, uid: 1000, tty: 'pts/3', args: 'bash' },
      { pid: 930, ppid: 920, uid: 1000, tty: 'pts/3', args: 'node /home/me/.npm-global/bin/orgai' }
    ]
    const f = facts({ platform: 'linux', pid: 930, table, procInfo: { 910: { exe: '/usr/libexec/gnome-terminal-server', name: 'gnome-terminal-' } }, ttyOpeners: [920, 930] })
    expect(full(f)).toEqual({ ok: true, tty: 'pts/3' })
  })

  it('ssh: a root sshd as the launcher (macOS), and Linux privilege separation (a same-user sshd-session under root sshd)', () => {
    const mac: ProcRow[] = [
      { pid: 1, ppid: 0, uid: 0, args: '/sbin/launchd' },
      { pid: 50, ppid: 1, uid: 0, args: 'sshd: me [priv]' },
      { pid: 300, ppid: 50, uid: ME, tty: TTY, args: '-zsh' },
      { pid: 400, ppid: 300, uid: ME, tty: TTY, args: 'node /x/orgai.mjs' }
    ]
    expect(full(facts({ table: mac, procInfo: { 50: { name: 'sshd' } } })).ok).toBe(true)
    const linux: ProcRow[] = [
      { pid: 1, ppid: 0, uid: 0, args: '/sbin/init' },
      { pid: 40, ppid: 1, uid: 0, args: 'sshd: /usr/sbin/sshd -D [listener]' },
      { pid: 50, ppid: 40, uid: 0, args: 'sshd-session: me [priv]' },
      { pid: 60, ppid: 50, uid: 1000, args: 'sshd-session: me@pts/0' },
      { pid: 300, ppid: 60, uid: 1000, tty: 'pts/0', args: '-bash' },
      { pid: 400, ppid: 300, uid: 1000, tty: 'pts/0', args: 'node /x/orgai.mjs' }
    ]
    // The unprivileged sshd-session's executable is not readable; its parent is root's sshd-session.
    expect(full(facts({ platform: 'linux', table: linux, procInfo: { 60: { name: 'sshd-session' }, 50: { name: 'sshd-session' } } })).ok).toBe(true)
  })

  it('the ps / lsof children are skipped by pid', () => {
    const f = facts({ table: userTable([{ pid: 777, ppid: 400, uid: ME, tty: TTY, args: '/bin/ps -A' }]), ignorePids: [777, 778], ttyOpeners: [300, 400, 778] })
    expect(full(f).ok).toBe(true)
  })
})

describe('decideTerminalAttestation: every refusal path', () => {
  it('Windows and other platforms', () => {
    for (const platform of ['win32', 'freebsd'] as const) expect(full(facts({ platform }))).toMatchObject({ ok: false, code: 'unsupported_platform' })
  })

  it('stdin or stdout redirected (exec in a pipe, a hook, an MCP server, `orgai < file`)', () => {
    expect(full(facts({ stdinIsTty: false }))).toMatchObject({ ok: false, code: 'not_a_terminal' })
    expect(full(facts({ stdoutIsTty: false }))).toMatchObject({ ok: false, code: 'not_a_terminal' })
  })

  it('no process table, this process missing, or a gap in its ancestry (fail closed)', () => {
    expect(full(facts({ table: undefined }))).toMatchObject({ ok: false, code: 'process_table_unavailable' })
    expect(full(facts({ table: userTable().filter((r) => r.pid !== 400) }))).toMatchObject({ ok: false, code: 'process_table_unavailable' })
    expect(full(facts({ table: userTable().filter((r) => r.pid !== 200) }))).toMatchObject({ ok: false, code: 'process_table_unavailable' })
  })

  it('no controlling terminal (an agent Bash tool runs without one)', () => {
    const table = userTable().map((r) => (r.pid === 400 ? { ...r, tty: undefined } : r))
    expect(full(facts({ table }))).toMatchObject({ ok: false, code: 'no_controlling_terminal' })
  })

  it('stdin or stdout on another terminal than the controlling one, or unknown devices', () => {
    expect(full(facts({ stdinRdev: RDEV + 1 }))).toMatchObject({ ok: false, code: 'stdio_not_controlling_terminal' })
    expect(full(facts({ stdoutRdev: RDEV + 1 }))).toMatchObject({ ok: false, code: 'stdio_not_controlling_terminal' })
    expect(full(facts({ cttyRdev: undefined }))).toMatchObject({ ok: false, code: 'stdio_not_controlling_terminal' })
  })

  it('an agent ancestor: a python pty under an agent shell, `script ... orgai`, codex, the SDK, wrappers', () => {
    const table: ProcRow[] = [
      ...userTable().filter((r) => r.pid !== 400),
      { pid: 350, ppid: 300, uid: ME, tty: TTY, args: 'claude --dangerously-skip-permissions' },
      { pid: 360, ppid: 350, uid: ME, args: '/bin/zsh -c python3 pty.py' },
      { pid: 370, ppid: 360, uid: ME, args: 'python3 pty.py' },
      { pid: 380, ppid: 370, uid: ME, tty: 'ttys009', args: '-zsh' },
      { pid: 400, ppid: 380, uid: ME, tty: 'ttys009', args: 'node /x/orgai.mjs' }
    ]
    const r = full(facts({ table }))
    expect(r).toMatchObject({ ok: false, code: 'agent_ancestor' })
    expect(r.ok ? '' : r.reason).toContain('claude, pid 350')
    const script = table.map((row) => (row.pid === 370 ? { ...row, args: 'script -q /dev/null orgai' } : row))
    expect(full(facts({ table: script }))).toMatchObject({ ok: false, code: 'agent_ancestor' })
    for (const args of ['/opt/codex/bin/codex app-server', 'node /x/node_modules/@anthropic-ai/claude-agent-sdk/cli.js', '/bin/sh /usr/bin/command claude --x', 'npm exec codex', 'node /x/node_modules/@openai/codex/bin/codex.js']) {
      const t = table.map((row) => (row.pid === 350 ? { ...row, args } : row))
      expect(full(facts({ table: t })), args).toMatchObject({ ok: false, code: 'agent_ancestor' })
    }
  })

  it('another OrgAI host as an ancestor (a second host on another data folder, the app)', () => {
    for (const args of ['node /usr/local/bin/orgai', 'node /repo/out/cli/orgai.mjs --data-dir /tmp/other', '/Applications/OrgAI.app/Contents/MacOS/OrgAI']) {
      const table: ProcRow[] = [
        ...userTable().filter((r) => r.pid !== 400),
        { pid: 350, ppid: 300, uid: ME, tty: TTY, args },
        { pid: 360, ppid: 350, uid: ME, tty: TTY, args: '/bin/sh -c x' },
        { pid: 400, ppid: 360, uid: ME, tty: TTY, args: 'node /x/orgai.mjs' }
      ]
      const r = full(facts({ table }))
      expect(r, args).toMatchObject({ ok: false, code: 'agent_ancestor' })
      expect(r.ok ? '' : r.reason).toContain('another OrgAI')
    }
  })

  it('F1: a pty an agent made itself and then left (double fork, reparented to pid 1) is not opened by a terminal application', () => {
    // `( python3 ptyrun.py ... & )` from an agent: python holds the master, its parent is launchd; orgai runs on the pty.
    const table: ProcRow[] = [
      { pid: 1, ppid: 0, uid: 0, args: '/sbin/launchd' },
      { pid: 370, ppid: 1, uid: ME, args: 'python3 ptyrun.py node probe.mjs' },
      { pid: 400, ppid: 370, uid: ME, tty: 'ttys009', args: 'node /x/orgai.mjs' }
    ]
    const r = full(facts({ table, procInfo: { 370: { exe: '/opt/homebrew/bin/python3.13', name: 'python3.13' } }, ttyOpeners: [370, 400] }))
    expect(r).toMatchObject({ ok: false, code: 'untrusted_terminal' })
    expect(r.ok ? '' : r.reason).toContain('python3.13, pid 370')
    expect(r.ok ? '' : r.reason).toContain('Open a plain terminal window')
    // The same with argv[0] set to look like Terminal: judged by the executable, not the command line.
    const spoof = table.map((row) => (row.pid === 370 ? { ...row, args: TERMINAL } : row))
    expect(full(facts({ table: spoof, procInfo: { 370: { exe: '/opt/homebrew/bin/python3.13' } } })).ok).toBe(false)
    // script, expect, node, unbuffer as the launcher; a leader whose parent is pid 1; an unreadable executable.
    for (const exe of ['/usr/bin/script', '/usr/bin/expect', '/usr/local/bin/node', '/opt/homebrew/bin/unbuffer', '/tmp/Terminal']) {
      expect(full(facts({ table, procInfo: { 370: { exe } } })).ok, exe).toBe(false)
    }
    const orphanLeader: ProcRow[] = [{ pid: 1, ppid: 0, uid: 0, args: '/sbin/launchd' }, { pid: 400, ppid: 1, uid: ME, tty: 'ttys009', args: 'node /x/orgai.mjs' }]
    expect(full(facts({ table: orphanLeader }))).toMatchObject({ ok: false, code: 'untrusted_terminal' })
    expect(full(facts({ table, procInfo: {} }))).toMatchObject({ ok: false, code: 'untrusted_terminal' })
  })

  it('F1: a same-user process named sshd is not sshd (its parent is not a root sshd); a root process of another name is not either', () => {
    const table: ProcRow[] = [
      { pid: 1, ppid: 0, uid: 0, args: '/sbin/launchd' },
      { pid: 360, ppid: 1, uid: ME, args: 'sshd-session: me@pts/0' },
      { pid: 370, ppid: 360, uid: ME, args: 'sshd-session: me@pts/0' },
      { pid: 400, ppid: 370, uid: ME, tty: 'ttys009', args: 'node /x/orgai.mjs' }
    ]
    expect(full(facts({ table, procInfo: { 370: { name: 'sshd-session' }, 360: { name: 'sshd-session' } } }))).toMatchObject({ ok: false, code: 'untrusted_terminal' })
    // `login -pf me <program>` started by an agent: login is root, but login is not a launcher OrgAI accepts.
    const login = table.map((row) => (row.pid === 370 ? { ...row, uid: 0, args: 'login -pf me python3 x.py' } : row))
    expect(full(facts({ table: login, procInfo: { 370: { name: 'login' } } }))).toMatchObject({ ok: false, code: 'untrusted_terminal' })
  })

  it('F2: inside tmux, screen, zellij, dtach or abduco (by the process tree, never TMUX / STY)', () => {
    for (const args of ['tmux new-session -d -s x', 'tmux: server', '/usr/bin/screen -S work', 'zellij --session a', 'dtach -A /tmp/s zsh', 'abduco -c s']) {
      const table: ProcRow[] = [
        { pid: 1, ppid: 0, uid: 0, args: '/sbin/launchd' },
        { pid: 90, ppid: 1, uid: ME, args },
        { pid: 300, ppid: 90, uid: ME, tty: 'ttys020', args: '-zsh' },
        { pid: 400, ppid: 300, uid: ME, tty: 'ttys020', args: 'node /x/orgai.mjs' }
      ]
      const r = full(facts({ table, procInfo: { 90: { exe: '/opt/homebrew/bin/tmux' } } }))
      expect(r, args).toMatchObject({ ok: false, code: 'multiplexer' })
      expect(r.ok ? '' : r.reason).toContain('Open a plain terminal window')
    }
    // tmux inside a Terminal.app tab: still refused (the multiplexer is an ancestor).
    const nested = userTable().map((r) => (r.pid === 400 ? { ...r, ppid: 320, tty: 'ttys030' } : r))
    nested.push({ pid: 310, ppid: 300, uid: ME, tty: TTY, args: 'tmux attach' }, { pid: 320, ppid: 310, uid: ME, tty: 'ttys030', args: '-zsh' })
    expect(full(facts({ table: nested }))).toMatchObject({ ok: false, code: 'multiplexer' })
  })

  it('a process this orgai started holds the terminal (an agent that could push keys): refused with coResident only', () => {
    const f = facts({ table: userTable([{ pid: 600, ppid: 400, uid: ME, tty: TTY, args: '/x/claude --output-format stream-json' }]) })
    expect(decideTerminalAttestation(f, { coResident: false }).ok).toBe(true)
    const r = full(f)
    expect(r).toMatchObject({ ok: false, code: 'process_shares_terminal' })
    expect(r.ok ? '' : r.reason).toContain('pid 600')
    expect(full(facts({ table: userTable([{ pid: 601, ppid: 400, uid: ME, tty: TTY, args: 'git status' }]) }))).toMatchObject({ ok: false, code: 'process_shares_terminal' })
  })

  it('an agent runtime on the terminal as a job of the shell (`claude &` in the same tab)', () => {
    expect(full(facts({ table: userTable([{ pid: 800, ppid: 300, uid: ME, tty: TTY, args: 'claude' }]) }))).toMatchObject({ ok: false, code: 'agent_on_terminal' })
  })

  it('a stray process on the terminal: double-forked, or reparented to an ancestor that is not on the terminal', () => {
    expect(full(facts({ table: userTable([{ pid: 700, ppid: 1, uid: ME, tty: TTY, args: 'python3 -c pass' }]) }))).toMatchObject({ ok: false, code: 'stray_process_on_terminal' })
    expect(full(facts({ table: userTable([{ pid: 701, ppid: 100, uid: ME, tty: TTY, args: 'sleep 1000' }]) }))).toMatchObject({ ok: false, code: 'stray_process_on_terminal' })
  })

  it('F3: a process that has the terminal device open without it being its controlling terminal', () => {
    // Opened /dev/ttys001 by path from elsewhere (it could read keys or draw over the overlay).
    const stray = facts({ table: userTable([{ pid: 710, ppid: 1, uid: ME, args: 'python3 reader.py' }]), ttyOpeners: [300, 400, 710] })
    expect(full(stray)).toMatchObject({ ok: false, code: 'stray_process_on_terminal' })
    // An agent of this orgai holding it open through an inherited fd.
    const child = facts({ table: userTable([{ pid: 720, ppid: 400, uid: ME, args: 'node mcp.js' }]), ttyOpeners: [300, 400, 720] })
    expect(full(child)).toMatchObject({ ok: false, code: 'process_shares_terminal' })
    // An opener that is not in the table (it started after ps ran).
    expect(full(facts({ ttyOpeners: [300, 400, 999] }))).toMatchObject({ ok: false, code: 'stray_process_on_terminal' })
    // The list could not be read, or does not even hold this process: fail closed.
    expect(full(facts({ ttyOpeners: undefined }))).toMatchObject({ ok: false, code: 'terminal_openers_unavailable' })
    expect(full(facts({ ttyOpeners: [] }))).toMatchObject({ ok: false, code: 'terminal_openers_unavailable' })
    // Not asked without coResident.
    expect(decideTerminalAttestation(facts({ ttyOpeners: undefined }), { coResident: false }).ok).toBe(true)
  })

  it('RESIDUAL (documented, not refused): a visible window an agent opens with the terminal application itself', () => {
    // `open -a Terminal script.command`: Terminal.app launches login and the shell exactly as for the user.
    expect(full(facts()).ok).toBe(true)
  })
})

describe('helpers', () => {
  it('parseProcTable reads macOS and Linux ps output with uids; no tty is undefined; junk lines are skipped', () => {
    const text = ['    1     0     0 ??       /sbin/launchd', '  300   200   501 ttys001  -zsh', '  930   920  1000 pts/3    node /x y', '  12    1     0 ?        [kworker/0:1]', 'garbage', '  5 4 0 -'].join('\n')
    expect(parseProcTable(text)).toEqual([
      { pid: 1, ppid: 0, uid: 0, args: '/sbin/launchd' },
      { pid: 300, ppid: 200, uid: 501, tty: 'ttys001', args: '-zsh' },
      { pid: 930, ppid: 920, uid: 1000, tty: 'pts/3', args: 'node /x y' },
      { pid: 12, ppid: 1, uid: 0, args: '[kworker/0:1]' },
      { pid: 5, ppid: 4, uid: 0, args: '' }
    ])
    expect(parsePidList('40040\n40070\nlsof: WARNING x\n\n')).toEqual([40040, 40070])
  })

  it('devPathOfTty accepts ps names only', () => {
    expect(devPathOfTty('ttys003')).toBe('/dev/ttys003')
    expect(devPathOfTty('pts/3')).toBe('/dev/pts/3')
    for (const bad of ['../etc/passwd', '/dev/ttys003', 'pts/../../x', '', 'a b']) expect(devPathOfTty(bad), bad).toBeUndefined()
  })

  it('sessionLeaderOf: the topmost ancestor on the same terminal', () => {
    const byPid = new Map(userTable().map((r) => [r.pid, r]))
    expect(sessionLeaderOf(byPid, byPid.get(400)!)?.pid).toBe(200)
  })

  it('trustedLauncher: the allow-list per platform, and nothing else', () => {
    const row = (pid: number, uid: number): ProcRow => ({ pid, ppid: 1, uid, args: 'x' })
    const info = (exe?: string, name?: string): Record<number, ProcInfo> => ({ 5: { ...(exe ? { exe } : {}), ...(name ? { name } : {}) } })
    for (const exe of TERMINAL_APPS.darwin) expect(trustedLauncher('darwin', row(5, ME), undefined, info(exe)), exe).toBe(true)
    for (const exe of TERMINAL_APPS.linux) expect(trustedLauncher('linux', row(5, 1000), undefined, info(exe)), exe).toBe(true)
    // Linux paths are not accepted on macOS and the reverse; user-writable copies never.
    expect(trustedLauncher('darwin', row(5, ME), undefined, info('/usr/bin/xterm'))).toBe(false)
    expect(trustedLauncher('linux', row(5, 1000), undefined, info(TERMINAL))).toBe(false)
    expect(trustedLauncher('darwin', row(5, ME), undefined, info('/Users/me/Applications/iTerm.app/Contents/MacOS/iTerm2'))).toBe(false)
    expect(trustedLauncher('darwin', row(5, ME), undefined, info(undefined, 'Terminal'))).toBe(false)
    // Root sshd by name; pid 1 never, whatever it says.
    expect(trustedLauncher('darwin', row(5, 0), undefined, info(undefined, 'sshd'))).toBe(true)
    expect(trustedLauncher('darwin', { pid: 1, ppid: 0, uid: 0, args: 'sshd' }, undefined, { 1: { name: 'sshd' } })).toBe(false)
    expect(trustedLauncher('darwin', row(5, 0), undefined, info(undefined, 'login'))).toBe(false)
  })

  it('agentKindOf and multiplexerOf', () => {
    expect(agentKindOf('claude')).toBe('agent')
    expect(agentKindOf('/Users/me/.local/bin/claude --resume')).toBe('agent')
    expect(agentKindOf('node /usr/local/bin/orgai tui')).toBe('host')
    for (const s of ['-zsh', 'vim claude.md', 'node server.js', 'login -pf me', 'claudette']) expect(agentKindOf(s), s).toBeUndefined()
    expect(multiplexerOf('/opt/homebrew/bin/tmux -L x new')).toBe('tmux')
    expect(multiplexerOf('SCREEN -S x')).toBe('screen')
    for (const s of ['vim screen.md', '-zsh', 'tmuxinator start']) expect(multiplexerOf(s), s).toBeUndefined()
  })

  it('processLabel names the program, never the arguments', () => {
    expect(processLabel('/usr/bin/python3 -c "import secret"')).toBe('python3')
    expect(processLabel('')).toBe('a process')
  })
})

describe('gathering on this machine', () => {
  it.runIf(process.platform === 'darwin' || process.platform === 'linux')('reads a process table that contains this process; the verdict is whatever the decision says for those facts', async () => {
    const f = await gatherTerminalFacts()
    expect(f.pid).toBe(process.pid)
    expect(f.table?.some((r) => r.pid === process.pid && typeof r.uid === 'number')).toBe(true)
    const ps = f.table?.find((r) => f.ignorePids?.includes(r.pid))
    if (ps) expect(ps.tty).toBeUndefined()
    const r = await attestThisTerminal({ coResident: true })
    expect(typeof r.ok).toBe('boolean')
  })
})
