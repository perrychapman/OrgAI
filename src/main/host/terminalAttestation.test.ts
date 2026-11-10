import { describe, expect, it } from 'vitest'
import {
  agentKindOf,
  attestThisTerminal,
  decideTerminalAttestation,
  devPathOfTty,
  gatherTerminalFacts,
  parseProcTable,
  processLabel,
  type ProcRow,
  type TerminalFacts
} from './terminalAttestation'

const TTY = 'ttys001'
const RDEV = 0x1000001

/** launchd -> Terminal (no tty) -> login -> zsh -> orgai (pid 400), the user's own terminal tab. */
function userTable(extra: ProcRow[] = []): ProcRow[] {
  return [
    { pid: 1, ppid: 0, args: '/sbin/launchd' },
    { pid: 100, ppid: 1, args: '/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal' },
    { pid: 200, ppid: 100, tty: TTY, args: 'login -pf me' },
    { pid: 300, ppid: 200, tty: TTY, args: '-zsh' },
    { pid: 400, ppid: 300, tty: TTY, args: 'node /usr/local/lib/node_modules/orgai-cli/out/cli/orgai.mjs' },
    ...extra
  ]
}

function facts(over: Partial<TerminalFacts> = {}): TerminalFacts {
  return { platform: 'darwin', pid: 400, stdinIsTty: true, stdoutIsTty: true, stdinRdev: RDEV, stdoutRdev: RDEV, cttyRdev: RDEV, table: userTable(), ...over }
}

const both = (f: TerminalFacts) => ({ identity: decideTerminalAttestation(f, { coResident: false }), full: decideTerminalAttestation(f, { coResident: true }) })

describe('decideTerminalAttestation: the user terminal passes', () => {
  it("the user's own tab, with a job of its shell beside it", () => {
    const f = facts({ table: userTable([{ pid: 500, ppid: 300, tty: TTY, args: 'vim notes.md' }]) })
    expect(both(f)).toEqual({ identity: { ok: true, tty: TTY }, full: { ok: true, tty: TTY } })
  })

  it('Linux: pts names, a terminal emulator under systemd --user', () => {
    const table: ProcRow[] = [
      { pid: 1, ppid: 0, args: '/sbin/init' },
      { pid: 900, ppid: 1, args: '/usr/lib/systemd/systemd --user' },
      { pid: 910, ppid: 900, args: '/usr/libexec/gnome-terminal-server' },
      { pid: 920, ppid: 910, tty: 'pts/3', args: 'bash' },
      { pid: 930, ppid: 920, tty: 'pts/3', args: 'node /home/me/.npm-global/bin/orgai' }
    ]
    // The orgai command itself matches the host pattern, but only ancestors and other processes are judged.
    expect(decideTerminalAttestation(facts({ platform: 'linux', pid: 930, table }), { coResident: true })).toEqual({ ok: true, tty: 'pts/3' })
  })

  it('the ps child that read the table is skipped by pid', () => {
    const f = facts({ table: userTable([{ pid: 777, ppid: 400, tty: TTY, args: '/bin/ps -A -ww -o pid=,ppid=,tty=,args=' }]), ignorePids: [777] })
    expect(decideTerminalAttestation(f, { coResident: true }).ok).toBe(true)
  })
})

describe('decideTerminalAttestation: every refusal path', () => {
  it('Windows and other platforms', () => {
    for (const platform of ['win32', 'freebsd'] as const) expect(decideTerminalAttestation(facts({ platform }), { coResident: false })).toMatchObject({ ok: false, code: 'unsupported_platform' })
  })

  it('stdin or stdout redirected (exec in a pipe, a hook, an MCP server, `orgai < file`)', () => {
    expect(decideTerminalAttestation(facts({ stdinIsTty: false }), { coResident: false })).toMatchObject({ ok: false, code: 'not_a_terminal' })
    expect(decideTerminalAttestation(facts({ stdoutIsTty: false }), { coResident: false })).toMatchObject({ ok: false, code: 'not_a_terminal' })
  })

  it('no process table, or this process missing from it (fail closed)', () => {
    expect(decideTerminalAttestation(facts({ table: undefined }), { coResident: false })).toMatchObject({ ok: false, code: 'process_table_unavailable' })
    expect(decideTerminalAttestation(facts({ table: userTable().filter((r) => r.pid !== 400) }), { coResident: false })).toMatchObject({ ok: false, code: 'process_table_unavailable' })
  })

  it('an ancestor missing from the table (a gap could hide an agent)', () => {
    const table = userTable().filter((r) => r.pid !== 200)
    expect(decideTerminalAttestation(facts({ table }), { coResident: false })).toMatchObject({ ok: false, code: 'process_table_unavailable' })
  })

  it('no controlling terminal (an agent Bash tool runs without one)', () => {
    const table = userTable().map((r) => (r.pid === 400 ? { ...r, tty: undefined } : r))
    expect(decideTerminalAttestation(facts({ table }), { coResident: false })).toMatchObject({ ok: false, code: 'no_controlling_terminal' })
  })

  it('stdin or stdout on another terminal than the controlling one (a second pty passed in), or unknown devices', () => {
    expect(decideTerminalAttestation(facts({ stdinRdev: RDEV + 1 }), { coResident: false })).toMatchObject({ ok: false, code: 'stdio_not_controlling_terminal' })
    expect(decideTerminalAttestation(facts({ stdoutRdev: RDEV + 1 }), { coResident: false })).toMatchObject({ ok: false, code: 'stdio_not_controlling_terminal' })
    expect(decideTerminalAttestation(facts({ cttyRdev: undefined }), { coResident: false })).toMatchObject({ ok: false, code: 'stdio_not_controlling_terminal' })
    expect(decideTerminalAttestation(facts({ stdinRdev: undefined }), { coResident: false })).toMatchObject({ ok: false, code: 'stdio_not_controlling_terminal' })
  })

  it('an agent ancestor: script / expect / python pty / tmux attach run from an agent shell, orgai exec wrapping, a hook or MCP server', () => {
    // claude (on the user's tty) -> its Bash tool (no tty) -> a python pty -> zsh -> orgai.
    const table: ProcRow[] = [
      ...userTable().filter((r) => r.pid !== 400),
      { pid: 350, ppid: 300, tty: TTY, args: 'claude --dangerously-skip-permissions' },
      { pid: 360, ppid: 350, args: '/bin/zsh -c python3 pty.py' },
      { pid: 370, ppid: 360, args: 'python3 pty.py' },
      { pid: 380, ppid: 370, tty: 'ttys009', args: '-zsh' },
      { pid: 400, ppid: 380, tty: 'ttys009', args: 'node /x/orgai.mjs' }
    ]
    const r = decideTerminalAttestation(facts({ table }), { coResident: false })
    expect(r).toMatchObject({ ok: false, code: 'agent_ancestor' })
    expect(r.ok ? '' : r.reason).toContain('claude, pid 350')
    // Codex, the SDK's node entry, a `/usr/bin/command claude` wrapper and npx codex count as well.
    // `script -q /dev/null orgai` names orgai itself: refused as well (the nearest match answers).
    const script = table.map((row) => (row.pid === 370 ? { ...row, args: 'script -q /dev/null orgai' } : row))
    expect(decideTerminalAttestation(facts({ table: script }), { coResident: false })).toMatchObject({ ok: false, code: 'agent_ancestor' })
    for (const args of ['/opt/codex/bin/codex app-server', 'node /x/node_modules/@anthropic-ai/claude-agent-sdk/cli.js', '/bin/sh /usr/bin/command claude --x', 'npm exec codex', 'node /x/node_modules/@openai/codex/bin/codex.js']) {
      const t = table.map((row) => (row.pid === 350 ? { ...row, args } : row))
      expect(decideTerminalAttestation(facts({ table: t }), { coResident: false }), args).toMatchObject({ ok: false, code: 'agent_ancestor' })
    }
  })

  it('another OrgAI host as an ancestor: an agent of the user TUI (mock adapter tools run in it), a second host on another data folder, the app', () => {
    for (const args of ['node /usr/local/bin/orgai', 'node /repo/out/cli/orgai.mjs --data-dir /tmp/other', '/Applications/OrgAI.app/Contents/MacOS/OrgAI', 'node /x/lib/node_modules/orgai-cli/out/cli/orgai.mjs']) {
      const table: ProcRow[] = [
        ...userTable().filter((r) => r.pid !== 400),
        { pid: 350, ppid: 300, tty: TTY, args },
        { pid: 360, ppid: 350, tty: TTY, args: '/bin/sh -c orgai' },
        { pid: 400, ppid: 360, tty: TTY, args: 'node /x/orgai.mjs' }
      ]
      const r = decideTerminalAttestation(facts({ table }), { coResident: false })
      expect(r, args).toMatchObject({ ok: false, code: 'agent_ancestor' })
      expect(r.ok ? '' : r.reason, args).toContain('another OrgAI')
    }
  })

  it('a process this orgai started holds the terminal (an agent that could TIOCSTI keys): refused with coResident only', () => {
    const f = facts({ table: userTable([{ pid: 600, ppid: 400, tty: TTY, args: '/x/claude --output-format stream-json' }, { pid: 610, ppid: 600, tty: TTY, args: 'node mcp-server.js' }]) })
    expect(decideTerminalAttestation(f, { coResident: false }).ok).toBe(true)
    const r = decideTerminalAttestation(f, { coResident: true })
    expect(r).toMatchObject({ ok: false, code: 'process_shares_terminal' })
    expect(r.ok ? '' : r.reason).toContain('pid 600')
    // Any descendant, not only agent runtimes (a tool, a pager, git).
    const g = facts({ table: userTable([{ pid: 601, ppid: 400, tty: TTY, args: 'git status' }]) })
    expect(decideTerminalAttestation(g, { coResident: true })).toMatchObject({ ok: false, code: 'process_shares_terminal' })
  })

  it('an agent runtime on the terminal as a job of the shell (`claude &` in the same tab)', () => {
    const f = facts({ table: userTable([{ pid: 800, ppid: 300, tty: TTY, args: 'claude' }]) })
    expect(decideTerminalAttestation(f, { coResident: true })).toMatchObject({ ok: false, code: 'agent_on_terminal' })
  })

  it('a stray process on the terminal: one that escaped its tree by double-forking, or was reparented to a subreaper', () => {
    const orphan = facts({ table: userTable([{ pid: 700, ppid: 1, tty: TTY, args: 'python3 -c pass' }]) })
    expect(decideTerminalAttestation(orphan, { coResident: true })).toMatchObject({ ok: false, code: 'stray_process_on_terminal' })
    // Reparented to an ancestor that is not on the terminal (systemd --user, the terminal emulator): still stray.
    const adopted = facts({ table: userTable([{ pid: 701, ppid: 100, tty: TTY, args: 'sleep 1000' }]) })
    expect(decideTerminalAttestation(adopted, { coResident: true })).toMatchObject({ ok: false, code: 'stray_process_on_terminal' })
  })

  it('RESIDUAL (documented, not refused): a daemonizing tmux server hides who started it', () => {
    // An agent runs `tmux new-session -d orgai`: the server reparents to launchd, so nothing in the table names the agent.
    // This is the residual risk stated in docs/agent-notes/cli-host.md; such an agent can already run arbitrary commands.
    const table: ProcRow[] = [
      { pid: 1, ppid: 0, args: '/sbin/launchd' },
      { pid: 900, ppid: 1, args: 'tmux new-session -d' },
      { pid: 910, ppid: 900, tty: 'ttys020', args: '-zsh' },
      { pid: 400, ppid: 910, tty: 'ttys020', args: 'node /x/orgai.mjs' }
    ]
    expect(decideTerminalAttestation(facts({ table }), { coResident: true }).ok).toBe(true)
  })
})

describe('helpers', () => {
  it('parseProcTable reads macOS and Linux ps output; no tty is undefined; junk lines are skipped', () => {
    const text = ['    1     0 ??       /sbin/launchd', '  300   200 ttys001  -zsh', '  930   920 pts/3    node /x y', '  12    1 ?        [kworker/0:1]', 'garbage', '  5 4 -'].join('\n')
    expect(parseProcTable(text)).toEqual([
      { pid: 1, ppid: 0, args: '/sbin/launchd' },
      { pid: 300, ppid: 200, tty: 'ttys001', args: '-zsh' },
      { pid: 930, ppid: 920, tty: 'pts/3', args: 'node /x y' },
      { pid: 12, ppid: 1, args: '[kworker/0:1]' },
      { pid: 5, ppid: 4, args: '' }
    ])
  })

  it('devPathOfTty accepts ps names only', () => {
    expect(devPathOfTty('ttys003')).toBe('/dev/ttys003')
    expect(devPathOfTty('pts/3')).toBe('/dev/pts/3')
    for (const bad of ['../etc/passwd', '/dev/ttys003', 'pts/../../x', '', 'a b']) expect(devPathOfTty(bad), bad).toBeUndefined()
  })

  it('agentKindOf: agents, OrgAI hosts, and look-alikes that are neither', () => {
    expect(agentKindOf('claude')).toBe('agent')
    expect(agentKindOf('/Users/me/.local/bin/claude --resume')).toBe('agent')
    expect(agentKindOf('C:\\tools\\codex.exe exec')).toBe('agent')
    expect(agentKindOf('node /usr/local/bin/orgai tui')).toBe('host')
    expect(agentKindOf('/Applications/OrgAI.app/Contents/MacOS/OrgAI')).toBe('host')
    for (const s of ['-zsh', 'vim claude.md', 'node server.js', 'grep orgai-cli-notes', 'login -pf me', 'claudette']) expect(agentKindOf(s), s).toBeUndefined()
  })

  it('processLabel names the program, never the arguments', () => {
    expect(processLabel('/usr/bin/python3 -c "import secret"')).toBe('python3')
    expect(processLabel('')).toBe('a process')
    expect(processLabel('\u001b[31mevil')).toBe('31mevil')
  })
})

describe('gathering on this machine', () => {
  it.runIf(process.platform === 'darwin' || process.platform === 'linux')('reads a process table that contains this process; the verdict is whatever the decision says for those facts', async () => {
    const f = await gatherTerminalFacts()
    expect(f.pid).toBe(process.pid)
    expect(f.table?.some((r) => r.pid === process.pid)).toBe(true)
    // The ps child ran in its own session: it never shows on any terminal.
    const ps = f.table?.find((r) => f.ignorePids?.includes(r.pid))
    if (ps) expect(ps.tty).toBeUndefined()
    const r = await attestThisTerminal({ coResident: true })
    expect(typeof r.ok).toBe('boolean')
  })
})
