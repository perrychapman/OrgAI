/**
 * Best-effort peer process ancestry check of a socket client (cli-spec 3.4(2)). Electron-free, relative imports only.
 *
 * What it does: one `ps -A -o pid=,ppid=` (150 ms timeout) parsed into a pid -> ppid table, then a walk from the
 * client's parent up to 64 hops. Reaching the host's pid means the client is a descendant of the host (an agent's
 * shell, a claude SDK subprocess, codex app-server, an MCP server...) and the server refuses it with
 * 'agent_descendant_refused'.
 *
 * Honest limits (UNVERIFIED / deferred):
 * - The pid is client-asserted (host.hello params.pid). An agent can claim any pid, and a process that double-forks
 *   (reparented to init / launchd) is no longer a descendant. This check is defence in depth only; the real gates are
 *   Terminal access (AppSettings.terminalServer), its level (AppSettings.terminalAccessLevel: by default a client gets
 *   read and operate only, never decide or configure; socketServer.ts grantScopes) and the self-control denial gate
 *   (checkSelfControlDenial).
 * - Socket-to-PID mapping (macOS only): with the accepted socket's fd, one `lsof -nP -U -F pfdn` (same 150 ms budget,
 *   run beside ps) finds the kernel address of the host's end of the socket (`d0x...` on that fd) and every process
 *   holding the other end (`n->0x...` naming that address). Those are the real peers; the ancestry walk then runs on
 *   them instead of the claimed pid (any descendant refuses). When lsof fails, times out or finds no peer, the claimed
 *   pid is walked as before. Linux has no such mapping here (`/proc/<pid>/fd` gives inodes but not the peer; that needs
 *   sock_diag / `ss -xp`), so it walks the claimed pid only. The lsof field format was checked on this Mac (Darwin 25);
 *   other macOS versions are unverified.
 * - win32 answers 'unavailable' (no ps; GetNamedPipeClientProcessId needs a native addon). The socket server accepts
 *   such a client, so on Windows an agent holding daemon.secret is told apart from the user by nothing here: the scope
 *   cap is what keeps it from 'decide' / 'configure' unless the user chose full Terminal access (review H2).
 * - A client claiming the host's own pid (cli-standalone.md round 6 item 6): on macOS the claim proves nothing, so the
 *   shortcut sits after the OS mapping. Only a mapped peer equal to the host's pid (an in-process client: the host holds
 *   both ends of the socket) passes; a claim of the host's pid with no mapped peer (no socket fd, lsof failed or found
 *   none) is 'unavailable', never 'ok', and the mapped peers are walked as for any claim, so an agent's shell claiming
 *   the host's pid is 'descendant'. Linux and other platforms keep the shortcut: a claimed pid equal to the host's is
 *   'ok' (only strict descendants count), since nothing there maps the socket to its peer. The inproc host's own client
 *   is recognised by its owner proof (RpcHelloParams.ownerProof), never by pid.
 */
import { execFile } from 'node:child_process'

export type PeerCheckResult = 'ok' | 'descendant' | 'unavailable'

export interface PeerCheckOptions {
  hostPid?: number
  platform?: NodeJS.Platform
  timeoutMs?: number
  /** pid -> ppid table; default: `ps -A -o pid=,ppid=`. Tests inject one. */
  psTable?: () => Promise<Map<number, number>>
  /** The host's fd of the accepted socket (darwin socket-to-PID mapping); absent = walk the claimed pid only. */
  socketFd?: number
  /** `lsof -nP -U -F pfdn` output; default runs lsof. Tests inject one. */
  lsofText?: () => Promise<string>
}

/** Max parent hops walked from the client. */
export const PEER_CHECK_MAX_HOPS = 64

/** Parse `ps -o pid=,ppid=` output (two integers per line; anything else skipped). */
export function parsePsTable(text: string): Map<number, number> {
  const out = new Map<number, number>()
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line)
    if (!m) continue
    out.set(Number(m[1]), Number(m[2]))
  }
  return out
}

function psTableOf(timeoutMs: number): Promise<Map<number, number>> {
  return new Promise((resolve, reject) => {
    execFile('ps', ['-A', '-o', 'pid=,ppid='], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      if (err) reject(err)
      else resolve(parsePsTable(String(stdout)))
    })
  })
}

function lsofTextOf(timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('lsof', ['-nP', '-U', '-F', 'pfdn'], { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      // lsof exits 1 when some process could not be read but still prints the rest.
      const text = String(stdout ?? '')
      if (err && !text) reject(err)
      else resolve(text)
    })
  })
}

/**
 * The pids holding the other end of the host's socket `fd` (lsof -F pfdn output: `p<pid>`, `f<fd>`, `d<device>`,
 * `n<name>` lines). Empty when the host's fd or any peer is missing.
 */
export function socketPeersOf(lsof: string, hostPid: number, fd: number): number[] {
  interface Entry {
    pid: number
    fd: string
    device?: string
    name?: string
  }
  const entries: Entry[] = []
  let pid = -1
  let cur: Entry | undefined
  for (const line of lsof.split('\n')) {
    const tag = line[0]
    const value = line.slice(1)
    if (tag === 'p') {
      pid = Number(value)
      cur = undefined
    } else if (tag === 'f') {
      cur = { pid, fd: value }
      entries.push(cur)
    } else if (tag === 'd' && cur) cur.device = value
    else if (tag === 'n' && cur) cur.name = value
  }
  const own = entries.find((e) => e.pid === hostPid && e.fd === String(fd))
  const device = own?.device?.toLowerCase()
  if (!device || !/^0x[0-9a-f]+$/.test(device)) return []
  const peers = new Set<number>()
  for (const e of entries) {
    if (e === own || !Number.isSafeInteger(e.pid) || e.pid <= 0) continue
    if (e.name?.toLowerCase() === `->${device}`) peers.add(e.pid)
  }
  return [...peers]
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('peer check timed out')), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e: unknown) => {
        clearTimeout(t)
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    )
  })
}

/** Walk the table from claimedPid's parent: 'descendant' on reaching hostPid, 'unavailable' on a missing pid. */
export function ancestryOf(table: ReadonlyMap<number, number>, claimedPid: number, hostPid: number): PeerCheckResult {
  let pid = table.get(claimedPid)
  if (pid === undefined) return 'unavailable'
  for (let hop = 0; hop < PEER_CHECK_MAX_HOPS; hop++) {
    if (pid === hostPid) return 'descendant'
    if (pid <= 1) return 'ok'
    const next = table.get(pid)
    if (next === undefined) return 'unavailable'
    if (next === pid) return 'ok'
    pid = next
  }
  return 'ok'
}

/** Never throws. */
export async function checkPeerAncestry(claimedPid: number, opts: PeerCheckOptions = {}): Promise<PeerCheckResult> {
  const hostPid = opts.hostPid ?? process.pid
  const platform = opts.platform ?? process.platform
  const timeoutMs = opts.timeoutMs ?? 150
  if (!Number.isSafeInteger(claimedPid) || claimedPid <= 0) return 'unavailable'
  // Off macOS the claim of the host's own pid is taken as an in-process client (no OS mapping exists there).
  if (platform !== 'darwin' && claimedPid === hostPid) return 'ok'
  if (!opts.psTable && platform !== 'darwin' && platform !== 'linux') return 'unavailable'
  const mapping =
    platform === 'darwin' && opts.socketFd !== undefined && Number.isSafeInteger(opts.socketFd) && opts.socketFd >= 0
      ? withTimeout(opts.lsofText ? opts.lsofText() : lsofTextOf(timeoutMs), timeoutMs).then(
          (text) => socketPeersOf(text, hostPid, opts.socketFd!),
          () => [] as number[]
        )
      : Promise.resolve([] as number[])
  try {
    const [table, peers] = await Promise.all([withTimeout(opts.psTable ? opts.psTable() : psTableOf(timeoutMs), timeoutMs), mapping])
    // macOS: a claim of the host's pid passes only through a mapped peer equal to it (below), never on its own.
    if (peers.length === 0 && claimedPid === hostPid) return 'unavailable'
    // The OS-mapped peers when known (a mapped peer that is the host itself is an in-process client: ok), else the claimed pid.
    const pids = peers.length > 0 ? peers : [claimedPid]
    let result: PeerCheckResult = 'ok'
    for (const pid of pids) {
      if (pid === hostPid) continue
      const r = ancestryOf(table, pid, hostPid)
      if (r === 'descendant') return 'descendant'
      if (r === 'unavailable') result = 'unavailable'
    }
    return result
  } catch {
    return 'unavailable'
  }
}

/** The OS fd of a net.Socket (unix only; undefined when Node does not expose one). */
export function socketFdOf(socket: unknown): number | undefined {
  const fd = (socket as { _handle?: { fd?: unknown } } | null)?._handle?.fd
  return typeof fd === 'number' && Number.isSafeInteger(fd) && fd >= 0 ? fd : undefined
}
