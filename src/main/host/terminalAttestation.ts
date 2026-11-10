/**
 * Terminal attestation for approvals at the terminal (cli-parity 3.4). Electron-free, relative imports only.
 *
 * What it is for: approvals of team files and folder config trust are taken only from the orgai terminal UI, by a
 * person at a terminal the host checks here. This removes the scripted ways an agent could approve (a command, a flag,
 * an environment variable, a pty an agent opens, a multiplexer it drives); it raises the cost of the rest. It is not a
 * boundary against code that already runs as the user with arbitrary commands (that code can rewrite OrgAI's data
 * folder directly); docs/agent-notes/cli-host.md lists the residual risks.
 *
 * The orgai host runs inside the orgai process and its socket serves that process only (the in-memory owner proof,
 * socketServer.ts), so the process checked is this one. Everything comes from the operating system, never from the
 * client, its flags or its environment:
 *
 *   1. macOS or Linux (Windows has no controlling terminal and no ps here: refused).
 *   2. stdin and stdout are terminals and the same device as `/dev/<tty>` of this pid's controlling terminal.
 *   3. No ancestor is a terminal multiplexer (tmux, screen, zellij, dtach, abduco): any program of the user can type
 *      into a pane and read it back.
 *   4. No ancestor (to launchd / init) is an agent runtime or an OrgAI host.
 *   5. The terminal was opened by a trusted launcher: the session leader (the topmost ancestor that holds this same
 *      terminal) is a direct child of a terminal application or sshd, identified by its executable path (allow-list
 *      TERMINAL_APPS, system locations only), or, for sshd only, by a root-owned process of that name. A pty opened by
 *      python, script, expect, node, or a leader whose parent is pid 1 (a double-forked escapee) fails. Unknown fails.
 *   6. (coResident: at the offer and again after the key press) every other process whose controlling terminal is
 *      this one, and every process that has the terminal device open at all, is this process, an ancestor, the
 *      launcher, or a job of the terminal's shell that is not an agent. A process OrgAI started (agents, MCP servers,
 *      tools), an agent, or a stray process refuses; so does a list of openers that cannot be read.
 *
 * The ps and lsof children run from fixed absolute paths with a minimal environment and a neutral cwd, in a new session
 * (no controlling terminal) and with no terminal file descriptors; their pids are left out. A fact that cannot be read
 * refuses (fail closed).
 */
import { spawn } from 'node:child_process'
import { fstatSync, readFileSync, readdirSync, readlinkSync, statSync } from 'node:fs'
import { isatty } from 'node:tty'
import { lsofExecutable, neutralCwd, psExecutable } from './systemBinaries'

/** One row of the process table: pid, parent pid, owner uid, controlling terminal (undefined for none), command line. */
export interface ProcRow {
  pid: number
  ppid: number
  uid?: number
  tty?: string
  args: string
}

/** What the OS says about one process beyond its row: its executable path and kernel name (each when readable). */
export interface ProcInfo {
  exe?: string
  name?: string
}

/** What the operating system says about this process and its terminal. Gathered by gatherTerminalFacts. */
export interface TerminalFacts {
  platform: NodeJS.Platform
  pid: number
  stdinIsTty: boolean
  stdoutIsTty: boolean
  /** st_rdev of fd 0 and fd 1 (character devices only). */
  stdinRdev?: number
  stdoutRdev?: number
  /** st_rdev of `/dev/<tty>` for the controlling terminal ps reports for `pid`. */
  cttyRdev?: number
  /** The process table; undefined when it could not be read. */
  table?: ProcRow[]
  /** Executable and kernel name of the session leader's parent and grandparent (keyed by pid). */
  procInfo?: Readonly<Record<number, ProcInfo>>
  /** Pids that have the terminal device open (lsof -t / /proc/<pid>/fd); undefined = could not be listed. */
  ttyOpeners?: readonly number[]
  /** Pids to leave out of the checks (the ps and lsof children). */
  ignorePids?: readonly number[]
}

export type AttestationRefusal =
  | 'unsupported_platform'
  | 'not_a_terminal'
  | 'process_table_unavailable'
  | 'no_controlling_terminal'
  | 'stdio_not_controlling_terminal'
  | 'multiplexer'
  | 'agent_ancestor'
  | 'untrusted_terminal'
  | 'process_shares_terminal'
  | 'agent_on_terminal'
  | 'stray_process_on_terminal'
  | 'terminal_openers_unavailable'

export type AttestationResult = { ok: true; tty: string } | { ok: false; code: AttestationRefusal; reason: string }

/** The host's attestation of this process (approvals:offer and approvals:answer pass coResident: true). */
export type AttestTerminalFn = (opts: { coResident: boolean }) => Promise<AttestationResult>

/** Max parent hops walked. */
export const ATTEST_MAX_HOPS = 64
/** How long ps / lsof may take. */
export const ATTEST_PS_TIMEOUT_MS = 2000

/** The sentence every refusal of a launcher or multiplexer ends with. */
export const OPEN_PLAIN_TERMINAL = 'Open a plain terminal window (or an ssh session) yourself and run orgai there.'

/**
 * Terminal applications by executable path, per platform. System locations only on Linux (not writable by the user).
 * On macOS Terminal.app sits on the sealed system volume; the others live in /Applications, which an admin account can
 * write (a residual risk named in the agent note). Anything not listed is refused: a terminal missing here is added by
 * a code change with a test, never by configuration an agent could write.
 */
export const TERMINAL_APPS: Readonly<Record<'darwin' | 'linux', readonly string[]>> = {
  darwin: [
    '/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal',
    '/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal',
    '/Applications/iTerm.app/Contents/MacOS/iTerm2',
    '/Applications/Ghostty.app/Contents/MacOS/ghostty',
    '/Applications/WezTerm.app/Contents/MacOS/wezterm-gui',
    '/Applications/Alacritty.app/Contents/MacOS/alacritty',
    '/Applications/kitty.app/Contents/MacOS/kitty',
    '/usr/sbin/sshd',
    '/usr/libexec/sshd-session'
  ],
  linux: [
    '/usr/libexec/gnome-terminal-server',
    '/usr/lib/gnome-terminal/gnome-terminal-server',
    '/usr/lib/gnome-terminal-server',
    '/usr/bin/kgx',
    '/usr/bin/gnome-console',
    '/usr/bin/konsole',
    '/usr/bin/xfce4-terminal',
    '/usr/bin/mate-terminal',
    '/usr/bin/lxterminal',
    '/usr/bin/tilix',
    '/usr/bin/xterm',
    '/usr/bin/urxvt',
    '/usr/bin/alacritty',
    '/usr/bin/kitty',
    '/usr/bin/foot',
    '/usr/bin/ghostty',
    '/usr/bin/wezterm-gui',
    '/usr/sbin/sshd',
    '/usr/lib/openssh/sshd-session',
    '/usr/libexec/openssh/sshd-session',
    '/usr/libexec/sshd-session'
  ]
}

/** sshd's process names: trusted by name only for a root-owned process (a same-user process cannot become root). */
const SSHD_NAMES: ReadonlySet<string> = new Set(['sshd', 'sshd-session', 'sshd-auth'])

/**
 * Agent runtimes and OrgAI hosts by command line. Matched anywhere as a whole word or path component (a wrapper such as
 * `/usr/bin/command claude` or `npx codex` counts), case-insensitively for orgai. A false match refuses (the safe side);
 * the reason names the process. Only ancestors and co-resident processes are judged, whose command lines were set by
 * whoever started them.
 */
const AGENT_PATTERNS: readonly RegExp[] = [
  /(?:^|[\s/\\])(?:claude|codex|claude-code)(?:\.exe)?(?=\s|$)/,
  /@anthropic-ai[/\\]claude-(?:agent-sdk|code)/,
  /@openai[/\\]codex/,
  /(?:^|[\s/\\])codex-app-server(?=\s|$)/
]
const HOST_PATTERNS: readonly RegExp[] = [
  /(?:^|[\s/\\])orgai(?:\.m?js|\.cjs|\.exe)?(?=\s|$)/i,
  /[/\\]orgai-cli[/\\]/i,
  /[/\\]OrgAI\.app[/\\]/
]
/** Terminal multiplexers, by the program word of a command line (`tmux: server`, `/usr/bin/screen -S x`, `zellij`). */
const MULTIPLEXER_RE = /^(?:\S*[/\\])?(tmux|screen|zellij|dtach|abduco)(?::|\s|$)/i

/** 'agent' for an agent runtime, 'host' for an OrgAI host, undefined for anything else. */
export function agentKindOf(args: string): 'agent' | 'host' | undefined {
  if (AGENT_PATTERNS.some((re) => re.test(args))) return 'agent'
  if (HOST_PATTERNS.some((re) => re.test(args))) return 'host'
  return undefined
}

/** The multiplexer a command line runs (lowercase), else undefined. */
export function multiplexerOf(args: string): string | undefined {
  return MULTIPLEXER_RE.exec(args.trim())?.[1]?.toLowerCase()
}

/** A short, safe name for a process in a refusal: the first word's last path part, at most 40 characters. */
export function processLabel(args: string): string {
  const first = args.trim().split(/\s+/)[0] ?? ''
  const base = first.split(/[/\\]/).pop() ?? ''
  const clean = base.replace(/[^\w.@+-]/g, '').slice(0, 40)
  return clean || 'a process'
}

/** `ps -A -ww -o pid=,ppid=,uid=,tty=,args=` output as rows; a tty of `?` / `??` / `-` is none. Junk lines are skipped. */
export function parseProcTable(text: string): ProcRow[] {
  const rows: ProcRow[] = []
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)(?:\s(.*))?$/.exec(line)
    if (!m) continue
    const tty = m[4]
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), uid: Number(m[3]), ...(/^[?-]+$/.test(tty) ? {} : { tty }), args: (m[5] ?? '').trim() })
  }
  return rows
}

/** `lsof -t` output: one pid per line. */
export function parsePidList(text: string): number[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^\d+$/.test(l))
    .map(Number)
}

const TTY_NAME_RE = /^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9/]{0,31}$/

/** `/dev/<tty>` for a ps tty name (macOS `ttys003`, Linux `pts/3`), or undefined for anything unexpected. */
export function devPathOfTty(tty: string): string | undefined {
  return TTY_NAME_RE.test(tty) ? `/dev/${tty}` : undefined
}

/**
 * The session leader of `self`'s terminal as the ancestry shows it: the topmost of self and its ancestors that hold the
 * same controlling terminal without a gap. Undefined when self has none.
 */
export function sessionLeaderOf(byPid: ReadonlyMap<number, ProcRow>, self: ProcRow): ProcRow | undefined {
  if (!self.tty) return undefined
  let leader = self
  for (let hop = 0; hop < ATTEST_MAX_HOPS; hop++) {
    const up = byPid.get(leader.ppid)
    if (!up || up.pid === leader.pid || up.tty !== self.tty) return leader
    leader = up
  }
  return leader
}

/**
 * Is `launcher` (the session leader's parent) a terminal application or sshd? By executable path on the allow-list;
 * or, for sshd only, a root-owned process of that name, or a same-user sshd process whose executable cannot be read and
 * whose own parent is a root-owned sshd (privilege separation). Pid 1 and anything unknown are not.
 */
export function trustedLauncher(platform: 'darwin' | 'linux', launcher: ProcRow, launcherParent: ProcRow | undefined, info: Readonly<Record<number, ProcInfo>>): boolean {
  if (launcher.pid <= 1) return false
  const own = info[launcher.pid] ?? {}
  if (own.exe) return TERMINAL_APPS[platform].includes(own.exe)
  const isSshd = (row: ProcRow | undefined): boolean => !!row && SSHD_NAMES.has((info[row.pid]?.name ?? '').toLowerCase())
  if (launcher.uid === 0) return isSshd(launcher)
  return isSshd(launcher) && !!launcherParent && launcherParent.uid === 0 && launcherParent.pid > 1 && isSshd(launcherParent)
}

const refuse = (code: AttestationRefusal, reason: string): AttestationResult => ({ ok: false, code, reason })

/**
 * The decision (pure). `coResident` adds check 6 of the file header. The first failed check answers; the reason is one
 * sentence for the terminal, naming the process when one is the cause.
 */
export function decideTerminalAttestation(f: TerminalFacts, opts: { coResident: boolean }): AttestationResult {
  if (f.platform !== 'darwin' && f.platform !== 'linux') {
    return refuse('unsupported_platform', 'Approving at the terminal works on macOS and Linux only.')
  }
  const platform = f.platform
  if (!f.stdinIsTty || !f.stdoutIsTty) {
    return refuse('not_a_terminal', 'This orgai is not attached to a terminal (its input or output is redirected).')
  }
  if (!f.table) return refuse('process_table_unavailable', 'OrgAI could not read the process list to check this terminal; try again.')
  const byPid = new Map<number, ProcRow>()
  for (const r of f.table) byPid.set(r.pid, r)
  const self = byPid.get(f.pid)
  if (!self) return refuse('process_table_unavailable', 'OrgAI could not find itself in the process list; try again.')
  if (!self.tty) return refuse('no_controlling_terminal', 'This orgai has no controlling terminal.')
  if (f.stdinRdev === undefined || f.stdoutRdev === undefined || f.cttyRdev === undefined) {
    return refuse('stdio_not_controlling_terminal', 'OrgAI could not confirm that its keys come from its own terminal.')
  }
  if (f.stdinRdev !== f.cttyRdev || f.stdoutRdev !== f.cttyRdev) {
    return refuse('stdio_not_controlling_terminal', 'This orgai reads keys from a terminal other than its own controlling terminal.')
  }
  // Ancestors, nearest first; each must exist in the table (a gap could hide an agent).
  const ancestors: ProcRow[] = []
  let pid = self.ppid
  for (let hop = 0; hop < ATTEST_MAX_HOPS && pid > 1; hop++) {
    const row = byPid.get(pid)
    if (!row) return refuse('process_table_unavailable', 'OrgAI could not follow this terminal back to the session that started it; try again.')
    ancestors.push(row)
    if (row.ppid === row.pid) break
    pid = row.ppid
  }
  for (const a of ancestors) {
    const mux = multiplexerOf(a.args)
    if (mux) return refuse('multiplexer', `This orgai runs inside ${mux} (pid ${a.pid}), where any program of yours can type into the pane and read it. ${OPEN_PLAIN_TERMINAL}`)
  }
  for (const a of ancestors) {
    const kind = agentKindOf(a.args)
    if (kind) {
      const what = kind === 'agent' ? 'an agent' : 'another OrgAI'
      return refuse('agent_ancestor', `This orgai was started from inside ${what} (${processLabel(a.args)}, pid ${a.pid}); approvals are never taken there.`)
    }
  }
  const leader = sessionLeaderOf(byPid, self)!
  const launcher = byPid.get(leader.ppid)
  const info = f.procInfo ?? {}
  if (!launcher || !trustedLauncher(platform, launcher, byPid.get(launcher.ppid), info)) {
    const who = launcher ? `${processLabel(info[launcher.pid]?.exe ?? launcher.args)}, pid ${launcher.pid}` : `pid ${leader.ppid}`
    return refuse('untrusted_terminal', `This terminal was not opened by a terminal application or sshd OrgAI knows (${who}). ${OPEN_PLAIN_TERMINAL}`)
  }
  if (!opts.coResident) return { ok: true, tty: self.tty }

  const ignore = new Set(f.ignorePids ?? [])
  const ancestorPids = new Set(ancestors.map((a) => a.pid))
  // The shell side of the terminal: ancestors that hold this same terminal (login shell, subshells).
  const shellPids = new Set(ancestors.filter((a) => a.tty === self.tty).map((a) => a.pid))
  /** How `row` descends: from this orgai ('self'), from the terminal's shell ('shell'), or neither. */
  const lineage = (row: ProcRow): 'self' | 'shell' | 'none' => {
    let p = row.ppid
    for (let hop = 0; hop < ATTEST_MAX_HOPS && p > 1; hop++) {
      if (p === f.pid) return 'self'
      if (shellPids.has(p)) return 'shell'
      const up = byPid.get(p)
      if (!up || up.ppid === p) return 'none'
      p = up.ppid
    }
    return 'none'
  }
  /** Why `row`, on or holding this terminal, may not be there; undefined when it may. */
  const intruder = (row: ProcRow): AttestationResult | undefined => {
    if (row.pid === f.pid || ignore.has(row.pid) || ancestorPids.has(row.pid) || row.pid === launcher.pid) return undefined
    const label = `${processLabel(row.args)}, pid ${row.pid}`
    const from = lineage(row)
    if (from === 'self') return refuse('process_shares_terminal', `A process OrgAI started shares this terminal (${label}); approve once it has ended (stop the run first).`)
    if (agentKindOf(row.args)) return refuse('agent_on_terminal', `An agent or another OrgAI is attached to this terminal (${label}).`)
    if (from === 'none') return refuse('stray_process_on_terminal', `A process that was not started from this terminal's shell is attached to it (${label}).`)
    return undefined
  }
  for (const row of f.table) {
    if (row.tty !== self.tty) continue
    const bad = intruder(row)
    if (bad) return bad
  }
  // Processes that hold the terminal device open without it being their controlling terminal (they could read keys or
  // draw over the screen) are judged the same way; a list that cannot be read refuses.
  // This process always has it open: a list without it was not really read.
  if (!f.ttyOpeners || !f.ttyOpeners.includes(f.pid)) return refuse('terminal_openers_unavailable', 'OrgAI could not list the processes that have this terminal open; try again.')
  for (const opener of f.ttyOpeners) {
    if (opener === f.pid || ignore.has(opener)) continue
    const row = byPid.get(opener)
    if (!row) return refuse('stray_process_on_terminal', `A process that is not in the process list has this terminal open (pid ${opener}).`)
    const bad = intruder(row)
    if (bad) return bad
  }
  return { ok: true, tty: self.tty }
}

// ---------- Gathering the facts (I/O) ----------

const FIXED_ENV = { LC_ALL: 'C', LANG: 'C', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }

/** Run a fixed binary in its own session with no terminal fds; resolves stdout (lsof's exit 1 with output counts). */
function runFixed(file: string, args: string[], timeoutMs: number, okCodes: readonly number[] = [0]): Promise<{ out: string; pid?: number }> {
  return new Promise((resolve, reject) => {
    let out = ''
    let size = 0
    let settled = false
    const child = spawn(file, args, { cwd: neutralCwd(), env: FIXED_ENV, stdio: ['ignore', 'pipe', 'ignore'], detached: true, windowsHide: true })
    const finish = (err?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (err) reject(err)
      else resolve({ out, ...(child.pid ? { pid: child.pid } : {}) })
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(new Error(`${file} timed out`))
    }, timeoutMs)
    child.stdout?.on('data', (b: Buffer) => {
      size += b.length
      if (size > 32 * 1024 * 1024) {
        child.kill('SIGKILL')
        finish(new Error('output too large'))
        return
      }
      out += b.toString('utf8')
    })
    child.on('error', (e) => finish(e))
    child.on('close', (code) => finish(code !== null && okCodes.includes(code) ? undefined : new Error(`${file} exited ${String(code)}`)))
  })
}

/** The process table through the fixed ps. Resolves the rows and the ps pid. */
export async function readProcTable(timeoutMs = ATTEST_PS_TIMEOUT_MS): Promise<{ rows: ProcRow[]; psPid?: number }> {
  const ps = psExecutable()
  if (!ps) throw new Error('ps not found')
  const r = await runFixed(ps, ['-A', '-ww', '-o', 'pid=,ppid=,uid=,tty=,args='], timeoutMs)
  return { rows: parseProcTable(r.out), ...(r.pid ? { psPid: r.pid } : {}) }
}

/** Executable path and kernel name of `pid` (each undefined when unreadable: another user's process, a race). */
async function procInfoOf(platform: 'darwin' | 'linux', pid: number): Promise<ProcInfo> {
  const out: ProcInfo = {}
  if (platform === 'linux') {
    try {
      out.exe = readlinkSync(`/proc/${pid}/exe`)
    } catch {
      /* not readable */
    }
    try {
      out.name = readFileSync(`/proc/${pid}/comm`, 'utf8').trim()
    } catch {
      /* gone */
    }
    return out
  }
  const lsof = lsofExecutable()
  if (lsof) {
    try {
      // The first txt entry is the executable (checked on Darwin 25; argv[0] does not change it).
      const r = await runFixed(lsof, ['-nP', '-a', '-p', String(pid), '-d', 'txt', '-Fn'], ATTEST_PS_TIMEOUT_MS, [0, 1])
      const line = r.out.split('\n').find((l) => l.startsWith('n'))
      if (line) out.exe = line.slice(1)
    } catch {
      /* not readable */
    }
  }
  const ps = psExecutable()
  if (ps) {
    try {
      // ucomm: the kernel's name from the executable file, not argv[0].
      const r = await runFixed(ps, ['-o', 'ucomm=', '-p', String(pid)], ATTEST_PS_TIMEOUT_MS)
      const name = r.out.trim()
      if (name) out.name = name
    } catch {
      /* gone */
    }
  }
  return out
}

/** Pids with `dev` open: lsof -t on macOS, /proc/<pid>/fd on Linux (the user's own processes). Throws when it cannot list. */
async function ttyOpenersOf(platform: 'darwin' | 'linux', dev: string): Promise<{ pids: number[]; helper?: number }> {
  if (platform === 'linux') {
    const pids: number[] = []
    for (const name of readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue
      let fds: string[]
      try {
        fds = readdirSync(`/proc/${name}/fd`)
      } catch {
        continue
      }
      for (const fd of fds) {
        try {
          if (readlinkSync(`/proc/${name}/fd/${fd}`) === dev) {
            pids.push(Number(name))
            break
          }
        } catch {
          /* closed meanwhile */
        }
      }
    }
    return { pids }
  }
  const lsof = lsofExecutable()
  if (!lsof) throw new Error('lsof not found')
  // Exit 1 with no output is lsof's "nothing found"; this process itself always has the terminal open, so a real list
  // is never empty.
  const r = await runFixed(lsof, ['-nP', '-t', dev], ATTEST_PS_TIMEOUT_MS, [0, 1])
  return { pids: parsePidList(r.out), ...(r.pid ? { helper: r.pid } : {}) }
}

function charRdev(read: () => { isCharacterDevice(): boolean; rdev: number }): number | undefined {
  try {
    const st = read()
    return st.isCharacterDevice() ? st.rdev : undefined
  } catch {
    return undefined
  }
}

/** Everything decideTerminalAttestation needs about this process. Never throws (missing facts refuse there). */
export async function gatherTerminalFacts(opts: { coResident: boolean } = { coResident: true }): Promise<TerminalFacts> {
  const facts: TerminalFacts = {
    platform: process.platform,
    pid: process.pid,
    stdinIsTty: isatty(0),
    stdoutIsTty: isatty(1),
    stdinRdev: charRdev(() => fstatSync(0)),
    stdoutRdev: charRdev(() => fstatSync(1))
  }
  const platform = facts.platform
  if (platform !== 'darwin' && platform !== 'linux') return facts
  const ignore: number[] = []
  try {
    const { rows, psPid } = await readProcTable()
    facts.table = rows
    if (psPid) ignore.push(psPid)
    const byPid = new Map(rows.map((r) => [r.pid, r]))
    const self = byPid.get(process.pid)
    const dev = self?.tty ? devPathOfTty(self.tty) : undefined
    if (dev) facts.cttyRdev = charRdev(() => statSync(dev))
    const leader = self ? sessionLeaderOf(byPid, self) : undefined
    const launcher = leader ? byPid.get(leader.ppid) : undefined
    if (launcher && launcher.pid > 1) {
      const info: Record<number, ProcInfo> = { [launcher.pid]: await procInfoOf(platform, launcher.pid) }
      const up = byPid.get(launcher.ppid)
      if (up && up.pid > 1) info[up.pid] = await procInfoOf(platform, up.pid)
      facts.procInfo = info
    }
    if (opts.coResident && dev) {
      try {
        const o = await ttyOpenersOf(platform, dev)
        facts.ttyOpeners = o.pids
        if (o.helper) ignore.push(o.helper)
      } catch {
        // facts.ttyOpeners stays undefined: refused as terminal_openers_unavailable.
      }
    }
  } catch {
    // facts.table stays undefined: refused as process_table_unavailable.
  }
  if (ignore.length) facts.ignorePids = ignore
  return facts
}

/** The real attestation of this process (the in-process orgai host passes it to the approval gate). */
export const attestThisTerminal: AttestTerminalFn = async (opts) => decideTerminalAttestation(await gatherTerminalFacts(opts), opts)
