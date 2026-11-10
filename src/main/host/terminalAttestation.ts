/**
 * Terminal attestation for approvals at the terminal (cli-parity 3.4, principle 4: nothing an agent can run may approve
 * what an agent did). Electron-free, relative imports only.
 *
 * The orgai host runs inside the orgai process and its socket serves that process only (the in-memory owner proof,
 * socketServer.ts), so the client of an approval call is provably this process. What has to be shown is that this
 * process is a terminal session of the user and that nothing OrgAI (or another agent) started can type into it. The host
 * reads that from the operating system, never from the client, its flags or its environment:
 *
 *   1. macOS or Linux (Windows has no controlling terminal and no ps here: refused).
 *   2. stdin and stdout are terminals, and both are this process's controlling terminal (same device as `/dev/<tty>`
 *      that ps reports for this pid), so the keys come from that terminal and not from a pipe or a second pty.
 *   3. No ancestor of this process (walked to launchd / init) is an agent runtime (claude, codex, the Claude Agent SDK,
 *      @openai/codex) or an OrgAI host (another orgai, the OrgAI app). An agent's shell, an MCP server, a hook, a
 *      `script` / `expect` / python pty it opens, `orgai exec` wrapping: all of these descend from the agent runtime.
 *   4. (coResident, checked when an approval is offered and again after the key press) every other process whose
 *      controlling terminal is this one is either an ancestor of this process or a job of the shell that started it.
 *      Refused: a process this orgai started (its agents, MCP servers, tools: they could push keys into the terminal
 *      with TIOCSTI), any agent runtime, and any process on the terminal that does not descend from its shell (a
 *      process that escaped an agent's tree by double-forking still holds the terminal).
 *
 * The ps table is read with a fixed absolute ps, a fixed minimal environment and a neutral cwd, in a new session (the ps
 * child has no controlling terminal and is skipped by pid anyway). A table that cannot be read refuses (fail closed).
 *
 * What this cannot see (stated in docs/agent-notes/cli-host.md): a process that left every agent tree before it acted
 * (a launchd / cron / at job, a daemonizing tmux or screen server, `open -a Terminal`) and then drives a terminal it
 * opened itself, or the user's own terminal through the emulator's or multiplexer's automation (tmux send-keys and
 * capture-pane, AppleScript, kitty / wezterm remote control). Such code already runs as the user with arbitrary
 * commands and can rewrite the approved team in the data folder directly; the attestation does not claim to stop it.
 */
import { spawn } from 'node:child_process'
import { fstatSync, statSync } from 'node:fs'
import { isatty } from 'node:tty'
import { neutralCwd, psExecutable } from './systemBinaries'

/** One row of the process table: pid, parent pid, controlling terminal (undefined for none) and the command line. */
export interface ProcRow {
  pid: number
  ppid: number
  tty?: string
  args: string
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
  /** Pids to leave out of the checks (the ps child that produced the table). */
  ignorePids?: readonly number[]
}

export type AttestationRefusal =
  | 'unsupported_platform'
  | 'not_a_terminal'
  | 'process_table_unavailable'
  | 'no_controlling_terminal'
  | 'stdio_not_controlling_terminal'
  | 'agent_ancestor'
  | 'process_shares_terminal'
  | 'agent_on_terminal'
  | 'stray_process_on_terminal'

export type AttestationResult = { ok: true; tty: string } | { ok: false; code: AttestationRefusal; reason: string }

/** The host's attestation of this process (socketServer at hello: identity only; approval calls: coResident too). */
export type AttestTerminalFn = (opts: { coResident: boolean }) => Promise<AttestationResult>

/** Max parent hops walked. */
export const ATTEST_MAX_HOPS = 64
/** How long ps may take. */
export const ATTEST_PS_TIMEOUT_MS = 2000

/**
 * Agent runtimes and OrgAI hosts by command line. Matched anywhere in the command line as a whole word or path
 * component, case-insensitively for orgai: a wrapper (`/usr/bin/command claude ...`, `npx codex`) counts as well. A
 * false match refuses, which is the safe side; the reason names the process so the user can tell.
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

/** 'agent' for an agent runtime, 'host' for an OrgAI host, undefined for anything else. */
export function agentKindOf(args: string): 'agent' | 'host' | undefined {
  if (AGENT_PATTERNS.some((re) => re.test(args))) return 'agent'
  if (HOST_PATTERNS.some((re) => re.test(args))) return 'host'
  return undefined
}

/** A short, safe name for a process in a refusal: the first word's last path part, at most 40 characters. */
export function processLabel(args: string): string {
  const first = args.trim().split(/\s+/)[0] ?? ''
  const base = first.split(/[/\\]/).pop() ?? ''
  const clean = base.replace(/[^\w.@+-]/g, '').slice(0, 40)
  return clean || 'a process'
}

/** `ps -A -ww -o pid=,ppid=,tty=,args=` output as rows; a tty of `?` / `??` / `-` is none. Lines that do not parse are skipped. */
export function parseProcTable(text: string): ProcRow[] {
  const rows: ProcRow[] = []
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)(?:\s(.*))?$/.exec(line)
    if (!m) continue
    const tty = m[3]
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), ...(/^[?-]+$/.test(tty) ? {} : { tty }), args: (m[4] ?? '').trim() })
  }
  return rows
}

const TTY_NAME_RE = /^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9/]{0,31}$/

/** `/dev/<tty>` for a ps tty name (macOS `ttys003`, Linux `pts/3`), or undefined for anything unexpected. */
export function devPathOfTty(tty: string): string | undefined {
  return TTY_NAME_RE.test(tty) ? `/dev/${tty}` : undefined
}

const refuse = (code: AttestationRefusal, reason: string): AttestationResult => ({ ok: false, code, reason })

/**
 * The decision (pure). `coResident` adds check 4 of the file header. The first failed check answers; the reason is one
 * sentence for the terminal, naming the process when one is the cause.
 */
export function decideTerminalAttestation(f: TerminalFacts, opts: { coResident: boolean }): AttestationResult {
  if (f.platform !== 'darwin' && f.platform !== 'linux') {
    return refuse('unsupported_platform', 'Approving at the terminal works on macOS and Linux only.')
  }
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
    const kind = agentKindOf(a.args)
    if (kind) {
      const what = kind === 'agent' ? 'an agent' : 'another OrgAI'
      return refuse('agent_ancestor', `This orgai was started from inside ${what} (${processLabel(a.args)}, pid ${a.pid}); approvals are never taken there.`)
    }
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
  for (const row of f.table) {
    if (row.tty !== self.tty || row.pid === f.pid || ignore.has(row.pid) || ancestorPids.has(row.pid)) continue
    const label = `${processLabel(row.args)}, pid ${row.pid}`
    const from = lineage(row)
    if (from === 'self') {
      return refuse('process_shares_terminal', `A process OrgAI started shares this terminal (${label}); approve once it has ended (stop the run first).`)
    }
    if (agentKindOf(row.args)) return refuse('agent_on_terminal', `An agent or another OrgAI is attached to this terminal (${label}).`)
    if (from === 'none') return refuse('stray_process_on_terminal', `A process that was not started from this terminal's shell is attached to it (${label}).`)
  }
  return { ok: true, tty: self.tty }
}

// ---------- Gathering the facts (I/O) ----------

/** The process table through the fixed ps, in a new session, with a fixed environment. Resolves the rows and the ps pid. */
export function readProcTable(timeoutMs = ATTEST_PS_TIMEOUT_MS): Promise<{ rows: ProcRow[]; psPid?: number }> {
  const ps = psExecutable()
  if (!ps) return Promise.reject(new Error('ps not found'))
  return new Promise((resolve, reject) => {
    let out = ''
    let size = 0
    let settled = false
    const child = spawn(ps, ['-A', '-ww', '-o', 'pid=,ppid=,tty=,args='], {
      cwd: neutralCwd(),
      env: { LC_ALL: 'C', LANG: 'C', PATH: '/usr/bin:/bin' },
      stdio: ['ignore', 'pipe', 'ignore'],
      detached: true,
      windowsHide: true
    })
    const finish = (err?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (err) reject(err)
      else resolve({ rows: parseProcTable(out), ...(child.pid ? { psPid: child.pid } : {}) })
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(new Error('ps timed out'))
    }, timeoutMs)
    child.stdout?.on('data', (b: Buffer) => {
      size += b.length
      if (size > 32 * 1024 * 1024) {
        child.kill('SIGKILL')
        finish(new Error('ps output too large'))
        return
      }
      out += b.toString('utf8')
    })
    child.on('error', (e) => finish(e))
    child.on('close', (code) => finish(code === 0 ? undefined : new Error(`ps exited ${String(code)}`)))
  })
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
export async function gatherTerminalFacts(): Promise<TerminalFacts> {
  const facts: TerminalFacts = {
    platform: process.platform,
    pid: process.pid,
    stdinIsTty: isatty(0),
    stdoutIsTty: isatty(1),
    stdinRdev: charRdev(() => fstatSync(0)),
    stdoutRdev: charRdev(() => fstatSync(1))
  }
  if (facts.platform !== 'darwin' && facts.platform !== 'linux') return facts
  try {
    const { rows, psPid } = await readProcTable()
    facts.table = rows
    if (psPid) facts.ignorePids = [psPid]
    const tty = rows.find((r) => r.pid === process.pid)?.tty
    const dev = tty ? devPathOfTty(tty) : undefined
    if (dev) facts.cttyRdev = charRdev(() => statSync(dev))
  } catch {
    // facts.table stays undefined: refused as process_table_unavailable.
  }
  return facts
}

/** The real attestation of this process (the in-process orgai host passes it to the socket server and the dispatcher). */
export const attestThisTerminal: AttestTerminalFn = async (opts) => decideTerminalAttestation(await gatherTerminalFacts(), opts)
