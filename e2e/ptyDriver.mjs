// A pseudo-terminal driver for the TUI end-to-end test (e2e/cli-tui.mjs). No native addons.
//
// Backends (pick with E2E_PTY=script|python; default: the first that passes `probePty()`):
// - 'script': the system `script` binary (macOS `script -q /dev/null ...`, Linux `script -qfec "<cmd>" /dev/null`)
//   with piped stdin / stdout, running a small perl job-control wrapper inside the pty. The wrapper sets the initial
//   size with `stty cols C rows R` on its own pty BEFORE the command starts (the TUI picks its buffer mode once at
//   launch), then starts the command as the foreground job of its own process group. Without that a pty session
//   leader's group is orphaned and the kernel silently discards SIGTSTP (Ctrl+Z would never stop the TUI).
// - 'python': e2e/pty-helper.py (python3 stdlib pty + termios + fcntl), the same job-control layout; resizes go
//   through a control pipe (TIOCSWINSZ on the master).
// The probe also checks job control (a raised SIGTSTP really stops the command, SIGCONT resumes it). Seen on macOS
// 26 (Darwin 25.5): `script` drives tty, size, resize and raw input, but the pty goes away once the foreground job
// stops, so the probe rejects it and picks 'python'. The 'script' backend is untested on Linux.
// Both write the command's pid to a pid file, and its exit code (128 + signal when killed) to <pidfile>.exit.
// Resizing the 'script' backend runs `stty -f /dev/<tty> cols C rows R` (darwin; `stty -F` on linux) on the TUI's tty
// (from `ps -o tty= -p <pid>`); the kernel then sends SIGWINCH to the foreground job, and we send one more ourselves.
//
// Output is kept raw (for escape-sequence assertions) and fed to a small VT emulator (cursor moves, erase, scroll,
// alternate screen) so `screen()` returns the visible grid as text lines; `text()` is the raw stream with escapes
// stripped. Never kills anything but processes it started.
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const PTY_HELPER = path.join(HERE, 'pty-helper.py')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Key bytes the TUI understands (cli-spec 5.3; W4-T4 parser). */
export const KEYS = {
  enter: '\r',
  esc: '\x1b',
  escape: '\x1b',
  tab: '\t',
  backtab: '\x1b[Z',
  'shift+tab': '\x1b[Z',
  backspace: '\x7f',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  f2: '\x1bOQ',
  'alt+d': '\x1bd',
  'ctrl+.': '\x1b[46;5u',
  'ctrl+c': '\x03',
  'ctrl+d': '\x04',
  'ctrl+z': '\x1a',
  space: ' '
}

// ---------- Job-control wrapper for the 'script' backend (perl, always present on macOS and most Linux) ----------

const PERL_WRAPPER = String.raw`
use strict; use POSIX qw(:sys_wait_h setpgid tcsetpgrp getpgrp);
my ($pidfile, $cols, $rows, @cmd) = @ARGV;
system('stty', 'cols', $cols, 'rows', $rows) == 0 or warn "stty failed\n";
my $pid = fork(); defined $pid or die "fork: $!";
if (!$pid) {
  setpgid(0, 0); $SIG{TTOU} = 'IGNORE'; tcsetpgrp(0, getpgrp()); $SIG{TTOU} = 'DEFAULT';
  exec { $cmd[0] } @cmd; POSIX::_exit(127);
}
setpgid($pid, $pid);
sub put { my ($f, $v) = @_; open(my $h, '>', "$f.tmp") or return; print $h $v; close $h; rename("$f.tmp", $f) }
put($pidfile, $pid);
while (1) {
  my $r = waitpid($pid, WUNTRACED);
  if ($r == -1) { put("$pidfile.exit", 1); exit 1 }
  next if WIFSTOPPED($?);
  my $code = WIFEXITED($?) ? WEXITSTATUS($?) : 128 + WTERMSIG($?);
  put("$pidfile.exit", $code); exit $code;
}
`

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`

function has(bin) {
  return spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { stdio: 'ignore' }).status === 0
}

function scriptArgv(inner) {
  if (process.platform === 'darwin') return { cmd: 'script', args: ['-q', '/dev/null', ...inner] }
  return { cmd: 'script', args: ['-qfec', inner.map(shq).join(' '), '/dev/null'] }
}

// ---------- A small VT emulator ----------

class Screen {
  constructor(cols, rows) {
    this.cols = cols
    this.rows = rows
    this.main = this.blank()
    this.alt = null
    this.x = 0
    this.y = 0
    this.saved = [0, 0]
    this.state = 'normal'
    this.seq = ''
    /** Lines scrolled off the top of the main (primary) buffer, oldest first; the alternate screen keeps none. */
    this.scrollback = []
  }
  blank() {
    return Array.from({ length: this.rows }, () => Array(this.cols).fill(' '))
  }
  get grid() {
    return this.alt ?? this.main
  }
  resize(cols, rows) {
    const fit = (g) => {
      const out = Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => g[r]?.[c] ?? ' '))
      return out
    }
    this.main = fit(this.main)
    if (this.alt) this.alt = fit(this.alt)
    this.cols = cols
    this.rows = rows
    this.x = Math.min(this.x, cols - 1)
    this.y = Math.min(this.y, rows - 1)
  }
  lineFeed() {
    if (this.y < this.rows - 1) this.y++
    else {
      const g = this.grid
      const gone = g.shift()
      if (!this.alt) {
        this.scrollback.push(gone.join('').replace(/\s+$/, ''))
        if (this.scrollback.length > 5000) this.scrollback.shift()
      }
      g.push(Array(this.cols).fill(' '))
    }
  }
  put(ch) {
    if (this.x >= this.cols) {
      this.x = 0
      this.lineFeed()
    }
    this.grid[this.y][this.x] = ch
    this.x++
  }
  eraseLine(mode) {
    const row = this.grid[this.y]
    const [a, b] = mode === 1 ? [0, this.x + 1] : mode === 2 ? [0, this.cols] : [this.x, this.cols]
    for (let i = a; i < Math.min(b, this.cols); i++) row[i] = ' '
  }
  eraseScreen(mode) {
    const g = this.grid
    if (mode === 2 || mode === 3) {
      for (const row of g) row.fill(' ')
      return
    }
    this.eraseLine(mode === 1 ? 1 : 0)
    if (mode === 1) for (let r = 0; r < this.y; r++) g[r].fill(' ')
    else for (let r = this.y + 1; r < this.rows; r++) g[r].fill(' ')
  }
  csi(body, final) {
    const priv = body.startsWith('?')
    const ps = (priv ? body.slice(1) : body).split(';').map((n) => (n === '' ? NaN : Number(n)))
    const n = (i, d = 1) => (Number.isFinite(ps[i]) && ps[i] > 0 ? ps[i] : d)
    const clampX = () => (this.x = Math.max(0, Math.min(this.cols - 1, this.x)))
    const clampY = () => (this.y = Math.max(0, Math.min(this.rows - 1, this.y)))
    if (priv) {
      if ((final === 'h' || final === 'l') && ps.includes(1049)) {
        if (final === 'h') {
          this.saved = [this.x, this.y]
          this.alt = this.blank()
        } else {
          this.alt = null
          ;[this.x, this.y] = this.saved
        }
      }
      return
    }
    switch (final) {
      case 'A': this.y -= n(0); clampY(); break
      case 'B': this.y += n(0); clampY(); break
      case 'C': this.x += n(0); clampX(); break
      case 'D': this.x -= n(0); clampX(); break
      case 'E': this.y += n(0); this.x = 0; clampY(); break
      case 'F': this.y -= n(0); this.x = 0; clampY(); break
      case 'G': this.x = n(0) - 1; clampX(); break
      case 'd': this.y = n(0) - 1; clampY(); break
      case 'H':
      case 'f': this.y = n(0) - 1; this.x = n(1) - 1; clampX(); clampY(); break
      case 'J': this.eraseScreen(Number.isFinite(ps[0]) ? ps[0] : 0); break
      case 'K': this.eraseLine(Number.isFinite(ps[0]) ? ps[0] : 0); break
      case 'S': for (let i = 0; i < n(0); i++) { this.grid.shift(); this.grid.push(Array(this.cols).fill(' ')) } break
      case 'T': for (let i = 0; i < n(0); i++) { this.grid.pop(); this.grid.unshift(Array(this.cols).fill(' ')) } break
      case 's': this.saved = [this.x, this.y]; break
      case 'u': [this.x, this.y] = this.saved; break
      default: break // m (SGR), r (margins), etc.: no effect on the text grid here
    }
  }
  feed(str) {
    for (const ch of str) {
      const c = ch.codePointAt(0)
      switch (this.state) {
        case 'normal':
          if (ch === '\x1b') this.state = 'esc'
          else if (ch === '\r') this.x = 0
          else if (ch === '\n') this.lineFeed()
          else if (ch === '\b') this.x = Math.max(0, this.x - 1)
          else if (ch === '\t') this.x = Math.min(this.cols - 1, (Math.floor(this.x / 8) + 1) * 8)
          else if (c === 0x9b) { this.state = 'csi'; this.seq = '' }
          else if (c >= 0x20 && c !== 0x7f && !(c >= 0x80 && c < 0xa0)) this.put(ch)
          break
        case 'esc':
          if (ch === '[') { this.state = 'csi'; this.seq = '' }
          else if (ch === ']') { this.state = 'osc'; this.seq = '' }
          else if (ch === 'P' || ch === '_' || ch === '^' || ch === 'X') { this.state = 'str'; this.seq = '' }
          else if (ch === '7') { this.saved = [this.x, this.y]; this.state = 'normal' }
          else if (ch === '8') { [this.x, this.y] = this.saved; this.state = 'normal' }
          else if (ch === '(' || ch === ')' || ch === '#') this.state = 'skip1'
          else this.state = 'normal'
          break
        case 'skip1':
          this.state = 'normal'
          break
        case 'csi':
          if (c >= 0x40 && c <= 0x7e) {
            this.csi(this.seq, ch)
            this.state = 'normal'
          } else this.seq += ch
          break
        case 'osc':
        case 'str':
          if (ch === '\x07') this.state = 'normal'
          else if (ch === '\x1b') this.state = 'strEsc'
          break
        case 'strEsc':
          this.state = ch === '\\' ? 'normal' : this.state === 'strEsc' ? 'osc' : 'normal'
          break
      }
    }
  }
  text() {
    return this.grid.map((r) => r.join('').replace(/\s+$/, '')).join('\n')
  }
}

/** Escapes stripped from a raw stream (CSI, OSC to BEL / ST, DCS / APC / PM, two-byte ESC), other C0 except \n dropped. */
export function stripEscapes(s) {
  return s
    .replace(/\x1b\][\s\S]*?(\x07|\x1b\\|$)/g, '')
    .replace(/\x1b[P_^X][\s\S]*?(\x1b\\|$)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[()#]./g, '')
    .replace(/\x1b./g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
}

// ---------- Spawning ----------

// The probe program: reports its tty and size, its size after a resize, and that it was really stopped by a raised
// SIGTSTP (Ctrl+Z in raw mode, as the TUI does it) and continued.
const PROBE_PROG = `
const o = process.stdout
o.write('TTY ' + o.isTTY + ' ' + o.columns + 'x' + o.rows + '\\n')
process.stdin.setRawMode(true)
o.on('resize', () => o.write('SIZE ' + o.columns + 'x' + o.rows + '\\n'))
process.on('SIGCONT', () => o.write('CONT\\n'))
process.stdin.on('data', (d) => {
  const s = d.toString('latin1')
  if (s === '\\x1a') { o.write('SUSP\\n'); setTimeout(() => process.kill(process.pid, 'SIGTSTP'), 20) }
  else if (s === 'q') process.exit(7)
  else o.write('GOT ' + JSON.stringify(s) + '\\n')
})
setTimeout(() => process.exit(9), 20000)
`

/** true when `backend` gives a real tty, the initial size, resizes, raw input and job control (stop + continue). */
async function probeBackend(backend) {
  const t = spawnPty([process.execPath, '-e', PROBE_PROG], { cols: 77, rows: 21, backend })
  try {
    await t.waitFor('TTY true 77x21', 10_000)
    await t.resize(81, 22)
    await t.waitFor('SIZE 81x22', 5_000)
    t.write('\x1a')
    await t.waitFor('SUSP', 5_000)
    let stopped = false
    for (let i = 0; i < 40 && !stopped; i++) {
      await sleep(50)
      stopped = t.stat().includes('T')
    }
    if (!stopped) return false
    await t.signal('SIGCONT')
    await t.waitFor('CONT', 5_000)
    t.write('x')
    await t.waitFor('GOT "x"', 5_000)
    t.write('q')
    const e = await Promise.race([t.exited, sleep(5_000).then(() => null)])
    return e?.code === 7
  } catch {
    return false
  } finally {
    await t.close()
  }
}

/** Which backend to use, or null when neither works here (win32 always null). Cached. */
let chosen
export async function probePty() {
  if (chosen !== undefined) return chosen
  chosen = null
  if (process.platform === 'win32') return null
  const order = process.env.E2E_PTY ? [process.env.E2E_PTY] : ['script', 'python']
  for (const backend of order) {
    if (backend === 'script' && !(has('script') && has('perl') && has('stty'))) continue
    if (backend === 'python' && !has('python3')) continue
    try {
      if (await probeBackend(backend)) {
        chosen = backend
        break
      }
    } catch {
      /* try the next one */
    }
  }
  return chosen
}

/**
 * Start `argv` on a pty of cols x rows. Returns the handle described in the file header.
 * opts: { cols, rows, env, cwd, backend }
 */
export function spawnPty(argv, { cols = 120, rows = 30, env = process.env, cwd = process.cwd(), backend = chosen ?? 'script' } = {}) {
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'orgai-pty-'))
  const pidfile = path.join(tmp, 'pid')
  let child
  if (backend === 'python') {
    child = spawn('python3', ['-I', PTY_HELPER, '--pidfile', pidfile, '--cols', String(cols), '--rows', String(rows), '--', ...argv], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe', 'pipe']
    })
  } else {
    const { cmd, args } = scriptArgv(['perl', '-e', PERL_WRAPPER, pidfile, String(cols), String(rows), ...argv])
    // Node's 'pipe' stdin is a socketpair, and macOS script refuses it ("tcgetattr/ioctl: Operation not supported on
    // socket"); `cat |` hands script a real pipe and relays every keystroke unbuffered.
    child = spawn('/bin/sh', ['-c', 'cat | exec "$@"', 'sh', cmd, ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
  }
  const screen = new Screen(cols, rows)
  const chunks = []
  let rawText = ''
  let errText = ''
  const waiters = new Set()
  const decoder = new TextDecoder('utf-8')
  const notify = () => {
    for (const w of waiters) w()
  }
  child.stdout.on('data', (d) => {
    chunks.push(d)
    const s = decoder.decode(d, { stream: true })
    rawText += s
    screen.feed(s)
    notify()
  })
  child.stderr.on('data', (d) => (errText += d))
  child.stdin.on('error', () => undefined)
  let exitInfo = null
  const exited = new Promise((resolve) => {
    let stdoutEnded = false
    child.stdout.on('end', () => (stdoutEnded = true))
    // 'exit', not 'close': the script backend's `cat` keeps stderr open until our stdin closes.
    child.on('exit', async (code, signal) => {
      for (let i = 0; i < 20 && !stdoutEnded; i++) await sleep(25)
      child.stdin.destroy()
      let tuiCode = null
      try {
        tuiCode = Number(fs.readFileSync(`${pidfile}.exit`, 'utf8'))
      } catch {
        /* the wrapper never wrote it */
      }
      exitInfo = { code: Number.isFinite(tuiCode) && tuiCode !== null ? tuiCode : (code ?? (signal ? 128 : 1)), wrapperCode: code, signal }
      notify()
      resolve(exitInfo)
    })
  })

  const readPid = () => {
    try {
      const n = Number(fs.readFileSync(pidfile, 'utf8'))
      return Number.isInteger(n) && n > 0 ? n : undefined
    } catch {
      return undefined
    }
  }

  const handle = {
    backend,
    child,
    get pid() {
      return readPid()
    },
    get exitInfo() {
      return exitInfo
    },
    exited,
    get size() {
      return { cols: screen.cols, rows: screen.rows }
    },
    /** The pid of the command once the wrapper has started it. */
    async waitPid(ms = 10_000) {
      const end = Date.now() + ms
      while (Date.now() < end) {
        const p = readPid()
        if (p) return p
        if (exitInfo) break
        await sleep(25)
      }
      throw new Error('the pty command never started')
    },
    write(bytes) {
      if (!child.stdin.destroyed) child.stdin.write(bytes)
    },
    paste(text) {
      handle.write(`\x1b[200~${text}\x1b[201~`)
    },
    key(name) {
      const k = KEYS[String(name).toLowerCase()]
      if (k === undefined) throw new Error(`unknown key ${name}`)
      handle.write(k)
    },
    /** Raw output so far (decoded UTF-8; escapes intact). */
    raw() {
      return rawText
    },
    rawBytes() {
      return Buffer.concat(chunks)
    },
    /** Raw output from character offset `from` on. */
    rawSince(from) {
      return rawText.slice(from)
    },
    /** The emulated visible grid (one string per row, trailing spaces cut). */
    screen() {
      return screen.text()
    },
    screenLines() {
      return screen.text().split('\n')
    },
    /** Lines that scrolled off the primary buffer (inline mode's scrollback), oldest first. */
    scrollback() {
      return screen.scrollback.slice()
    },
    /** Whether the emulated terminal is on the alternate screen right now. */
    onAltScreen() {
      return screen.alt !== null
    },
    /** Raw output with escapes stripped. */
    text() {
      return stripEscapes(rawText)
    },
    stderr() {
      return errText
    },
    /** Wait until the screen (or, with { raw: true }, the raw stream) matches; returns the match. */
    waitFor(what, ms = 15_000, { raw = false, since = 0 } = {}) {
      const test = () => {
        const hay = raw ? rawText.slice(since) : screen.text()
        if (typeof what === 'function') return what(hay) || null
        if (what instanceof RegExp) return hay.match(what)
        return hay.includes(what) ? what : null
      }
      return new Promise((resolve, reject) => {
        const hit = test()
        if (hit) return resolve(hit)
        const done = () => {
          clearTimeout(timer)
          waiters.delete(check)
        }
        const check = () => {
          const h = test()
          if (h) {
            done()
            resolve(h)
          } else if (exitInfo) {
            done()
            reject(new Error(`exited (${exitInfo.code}) before ${what}`))
          }
        }
        const timer = setTimeout(() => {
          done()
          reject(new Error(`timed out after ${ms} ms waiting for ${what}`))
        }, ms)
        waiters.add(check)
      })
    },
    /** Resize the pty; the emulated screen follows. */
    async resize(cols, rows) {
      const pid = await handle.waitPid()
      if (backend === 'python') child.stdio[3].write(`resize ${cols} ${rows}\n`)
      else {
        const tty = execFileSync('ps', ['-o', 'tty=', '-p', String(pid)], { encoding: 'utf8' }).trim()
        if (!tty || tty === '?' || tty === '??') throw new Error(`no tty for pid ${pid}`)
        const dev = tty.startsWith('/dev/') ? tty : `/dev/${tty}`
        execFileSync('stty', [process.platform === 'darwin' ? '-f' : '-F', dev, 'cols', String(cols), 'rows', String(rows)])
      }
      screen.resize(cols, rows)
      await sleep(30)
      try {
        process.kill(pid, 'SIGWINCH')
      } catch {
        /* gone */
      }
    },
    /** Send a signal to the command (never to anything else). */
    async signal(sig) {
      const pid = await handle.waitPid()
      if (exitInfo) return false
      try {
        process.kill(pid, sig)
        return true
      } catch {
        return false
      }
    },
    /** `ps -o stat=` of the command ('' once gone). */
    stat() {
      const pid = readPid()
      if (!pid || exitInfo) return ''
      const r = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' })
      return (r.stdout || '').trim()
    },
    /** Kill the command (SIGTERM, then SIGKILL) and the wrapper; idempotent. Removes the temp dir. */
    async close({ graceMs = 3000 } = {}) {
      if (!exitInfo) {
        const pid = readPid()
        if (pid) {
          try {
            process.kill(pid, 'SIGCONT')
            process.kill(pid, 'SIGTERM')
          } catch {
            /* gone */
          }
        }
        const t = setTimeout(() => {
          if (pid)
            try {
              process.kill(pid, 'SIGKILL')
            } catch {
              /* gone */
            }
          child.kill('SIGKILL')
        }, graceMs)
        await exited
        clearTimeout(t)
      }
      child.stdin.destroy()
      fs.rmSync(tmp, { recursive: true, force: true })
      return exitInfo
    }
  }
  return handle
}

/** spawnPty with the cli-tui.mjs signature: `argv` is the whole command line. */
export const spawnTui = (argv, opts) => spawnPty(argv, opts)
