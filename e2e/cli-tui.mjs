// The interactive terminal UI end to end (cli-spec 5 and 8, Wave 4 gate), driven through a pseudo-terminal
// (e2e/ptyDriver.mjs: python3 stdlib pty or `script`, no native addon). Run `npm run build` first. Mock adapter only
// (ORGAI_MOCK=1): no tokens. No Electron: TUIs run on `--host inproc` or as `--host daemon` clients of a long-lived
// `daemon start --host inproc --foreground`. Every scripted turn comes from an ORGAI_MOCK_SCRIPT JSON in the data dir.
//
// SKIPs (exit 0, "SKIP cli-tui: ...") on win32, when no pty backend passes ptyDriver's probe (tty, size, resize, raw
// input and a real SIGTSTP stop), and while out/cli/tui.mjs is still the Wave 4 contracts stub.
//
// a. Full screen at 120x30 (`--host inproc tui`): \x1b[?1049h and \x1b[?2004h are written, the status bar names the
//    project, a typed prompt starts a run whose text appears; /quit (Ctrl+D as a fallback, plus the inproc stop
//    confirmation) leaves the alternate screen: the tail has \x1b[?1049l, \x1b[?2004l, \x1b[?25h and the exit is 0.
// b. Resize 120x30 -> 100x30 (stacked: the transcript starts at the left edge, the agents pane above it) -> 120x30
//    (split: the transcript sits right of the agents pane); no \x1b[?1049l / \x1b[?1049h during the resizes.
// c. Inline at 90x20 (below 100x24 at launch): no \x1b[?1049h at all; transcript rows land in the primary scrollback;
//    the footer names the project.
// d. Ctrl+Z (\x1a) in both modes: \x1b[?2004l and \x1b[?25h (full screen also \x1b[?1049l) are written and `ps` shows
//    the TUI stopped (T); SIGCONT re-enables bracketed paste, re-enters \x1b[?1049h only in full screen, redraws, and
//    typed text reaches the composer again.
// e. Split escapes: a mock text step whose `partials` cut an OSC 52 clipboard write, an OSC 8 link and a CSI clear
//    (plus a distinctive SGR) across chunks: the raw pty output never carries their payloads; the visible text does.
// f. Paste safety (daemon host): with a permission card open, a bracketed paste of "y\na\n" into the composer leaves
//    the card pending (inbox) and resolves nothing; the composer shows the text.
// g. Card-swap guard and exact payloads (daemon host, plus `watch <run> --output-format stream-json`): two permission
//    cards back to back: `y` allows card 1; a `y` within 200 ms of the tray drawing card 2 is ignored (still pending, no
//    second permission.resolved); after 1 s `n` + Enter denies it with message 'Denied by user'. Then a question
//    (`2` + Enter: selected [second label]), a rules request (`r`: grant, scope run), an MCP install (`n`: not
//    approved) and a skills proposal (`d`: declined), each resolved with decidedBy.surface 'tui'. Two-step: `a` on a
//    further permission card resolves nothing within 1 s; `orgai decide <id> deny` from another process resolves it
//    (surface 'cli') and the TUI says "Resolved in another window".
// i. The org tree (ux-review-tui-org.md, `[mock:deep-tree]` on the mock's default script, full screen 120x40): the root, mock-lead
//    and its two reports; once they finish and the 6 s grace passes they fold (reports first, "2 done", then mock-lead with
//    them, "3 done" under the root; the run is still open); Right on the "3 done" row unfolds it and selects mock-lead; `n`
//    with nothing waiting says so; Enter on mock-lead opens the
//    agent inspector (facts and its own transcript); `?` opens the which-key overlay with the glyph legend; Esc closes the
//    overlay, then the inspector; `z` roots the tree at mock-lead (breadcrumb) and Z goes back. The `n` jump to a waiting
//    agent, message marks and the run chips have no mock source here: unit tests only.
// h. SIGTERM in full screen: the tail has \x1b[?1049l and \x1b[?25h and the exit code is 143.
//
// Not covered here (unit tests only): merge review cards (the mock has no worktrees), the pager, TERM=dumb Enter
// confirmation, and CSI-u / modifyOtherKeys Ctrl+. forms.
//
// The UI strings this script reads are collected in UI below; keep them in step with src/cli/tui when they change.
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { APP_DIR, DATA_DIR, allowFullTerminalAccess, check, finish, log, makeFixtureRepo, removeFixture, sleep } from './lib.mjs'
import { probePty, spawnTui } from './ptyDriver.mjs'

const CLI = path.join(APP_DIR, 'out', 'cli', 'orgai.mjs')
const TUI_BUNDLE = path.join(APP_DIR, 'out', 'cli', 'tui.mjs')
const DAEMON_JSON = path.join(DATA_DIR, 'data', 'run', 'daemon.json')

/** UI words and argv the checks depend on (W4-T3/T5 own the real ones). */
const UI = {
  fullscreenArgs: ['tui'],
  inlineArgs: ['tui'], // at 90x20 the TUI picks inline by size; `--inline` forces it at any size
  resolvedElsewhere: /Resolved in another window/i,
  /** The agents pane's heading (soft check: the layout is judged by where the transcript text starts). */
  treeHeading: /\b(Agents|Org|Team)\b/
}

const skip = (why) => {
  console.log(`SKIP cli-tui: ${why}`)
  process.exit(0)
}

if (process.platform === 'win32') skip('pseudo-terminal tests do not run on Windows')
if (!fs.existsSync(CLI) || !fs.existsSync(TUI_BUNDLE)) {
  console.log('out/cli/orgai.mjs or out/cli/tui.mjs missing. Run `npm run build` first.')
  process.exit(1)
}
if (fs.readFileSync(TUI_BUNDLE, 'utf8').includes('not implemented (Wave 4)')) skip('out/cli/tui.mjs is still the Wave 4 contracts stub')
const backend = await probePty()
if (!backend) skip('no pseudo-terminal backend works here (need python3, or script + perl with job control)')
log(`pty backend: ${backend}`)

// ---------- Mock scripts ----------

const OSC52 = '\x1b]52;c;SGVsbG8=\x07'
const OSC8_URL = 'https://evil.example/e2e-osc8'
const OSC8 = `\x1b]8;;${OSC8_URL}\x1b\\click-me\x1b]8;;\x1b\\`
const CSI_CLEAR = '\x1b[2J'
const SGR_ODD = '\x1b[38;5;123m'
const SPLIT_TEXT = `E2E-SPLIT-START ${OSC52} mid ${OSC8} then ${CSI_CLEAR}${SGR_ODD}E2E-SPLIT-END`
const cuts = [SPLIT_TEXT.indexOf('\x1b]52') + 3, SPLIT_TEXT.indexOf(OSC8_URL) + 10, SPLIT_TEXT.indexOf(CSI_CLEAR) + 2]
const SPLIT_PARTIALS = [...cuts.map((c) => SPLIT_TEXT.slice(0, c)), SPLIT_TEXT]

const scrollLines = Array.from({ length: 28 }, (_, i) => `E2E scroll line ${i + 1}`).join('\n')
const SIMPLE = {
  delayMs: 100,
  work: [
    { type: 'text', text: 'E2E-MARK-ALPHA the run started.' },
    { type: 'text', text: scrollLines },
    { type: 'text', text: 'E2E-MARK-OMEGA all done.' }
  ],
  reply: 'E2E reply to: {text}'
}
const ESCAPES = { delayMs: 150, work: [{ type: 'text', text: SPLIT_TEXT, partials: SPLIT_PARTIALS }, { type: 'text', text: 'E2E-ESC-DONE' }] }
const QUESTION_LABELS = ['Alpha option', 'Bravo option', 'Charlie option']
const CARDS = {
  delayMs: 100,
  work: [
    { type: 'text', text: 'E2E-CARDS-START' },
    { type: 'tool', name: 'Bash', input: { command: 'npm run card-one' }, ask: true, result: 'card one ran' },
    { type: 'tool', name: 'Bash', input: { command: 'npm run card-two' }, ask: true, result: 'card two ran' },
    { type: 'harness', name: 'ask_user', retryOnRevise: false, args: { question: 'E2E: which option?', options: QUESTION_LABELS.map((label) => ({ label })), allowFreeText: false } },
    { type: 'harness', name: 'request_permission_rules', args: { rules: ['Bash(npm run lint:*)'], reason: 'E2E: run the linter' } },
    {
      type: 'harness',
      name: 'request_mcp_install',
      retryOnRevise: false,
      args: { reason: 'E2E: an MCP install card.', manual: { name: 'e2e-mcp', transport: 'stdio', command: 'npx', args: ['-y', 'e2e-mcp-server@1.0.0'] } }
    },
    {
      type: 'harness',
      name: 'propose_skills',
      retryOnRevise: false,
      args: {
        title: 'E2E skill',
        rationale: 'E2E: a proposal card.',
        items: [{ action: 'create', scope: 'project', draft: { name: 'e2e-skill', description: 'Use for the e2e proposal.', body: 'Say e2e.' } }]
      }
    },
    { type: 'tool', name: 'Bash', input: { command: 'npm run card-three' }, ask: true, result: 'card three ran' },
    { type: 'text', text: 'E2E-CARDS-DONE' }
  ]
}
const scriptFile = (name, script) => {
  const f = path.join(DATA_DIR, `mock-${name}.json`)
  fs.writeFileSync(f, JSON.stringify(script))
  return f
}
const SCRIPTS = { simple: scriptFile('simple', SIMPLE), escapes: scriptFile('escapes', ESCAPES), cards: scriptFile('cards', CARDS) }

// ---------- Processes ----------

const baseEnv = (script) => {
  const env = { ...process.env, ORGAI_DATA_DIR: DATA_DIR, ORGAI_MOCK: '1', NO_COLOR: '1', TERM: 'xterm-256color', ORGAI_MOCK_SCRIPT: script, LANG: 'en_US.UTF-8' }
  // No script: the mock's default script, which understands the [mock:deep-tree] marker in the prompt.
  if (!script) delete env.ORGAI_MOCK_SCRIPT
  delete env.ELECTRON_RUN_AS_NODE
  delete env.CI // Ink's is-in-ci would turn interactive rendering off
  delete env.FORCE_COLOR
  return env
}

/** A plain (non-pty) CLI process; done resolves { code, out, err }. */
function start(args, { cwd, env = baseEnv(SCRIPTS.simple), onOut } = {}) {
  const child = spawn(process.execPath, [CLI, '--no-color', ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  let err = ''
  child.stdout.on('data', (d) => {
    out += d
    onOut?.(out)
  })
  child.stderr.on('data', (d) => (err += d))
  const done = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code: code ?? (signal ? 128 : 1), out, err })))
  return { child, done }
}
async function cli(args, opts = {}) {
  const { child, done } = start(args, opts)
  const t = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 60_000)
  const r = await done
  clearTimeout(t)
  return r
}
const json = (s) => {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}
const show = (r) => `exit ${r.code} ${r.out.slice(-300)} ${r.err.slice(-300)}`
const esc = (s) => JSON.stringify(s)
async function until(what, fn, ms = 30_000, every = 150) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = await fn()
    if (v) return v
    await sleep(every)
  }
  throw new Error(`timed out waiting for ${what}`)
}

/** Start a TUI on the pty. */
function tui(args, { cols, rows, script = SCRIPTS.simple, cwd }) {
  return spawnTui([process.execPath, CLI, '--no-color', ...args], { cols, rows, cwd, env: baseEnv(script) })
}
/** Type text one key at a time (a multi-byte chunk could look like a paste to a heuristic parser). */
async function type(t, text) {
  for (const ch of text) {
    t.write(ch)
    await sleep(8)
  }
}
/** First (row, col) where `re` matches on the screen, or null. */
function locate(t, re) {
  const lines = t.screenLines()
  for (let row = 0; row < lines.length; row++) {
    const m = lines[row].match(re)
    // lineStart: where the text on that row begins (a transcript row may carry an agent prefix before the match).
    if (m) return { row, col: m.index, lineStart: lines[row].search(/\S/) }
  }
  return null
}
/** Quit the TUI: /quit, then Ctrl+D, then the inproc stop confirmation; returns the exit info. */
async function quit(t, { confirm = false } = {}) {
  await type(t, '/quit')
  t.key('enter')
  const tries = [async () => undefined, async () => t.key('ctrl+d'), async () => (confirm ? t.write('y') : undefined), async () => t.key('enter')]
  for (const step of tries) {
    await step()
    const e = await Promise.race([t.exited, sleep(2500).then(() => null)])
    if (e) return e
  }
  return null
}

const repo = makeFixtureRepo('cli-tui')
const open = []
let daemon
try {
  // ---------- Project ----------
  const made = await cli(['--host', 'inproc', 'exec', '--output-format', 'json', '--create-project', '--team', 'single', 'hello'], { cwd: repo, timeoutMs: 120_000 })
  check(made.code === 0, 'exec --create-project makes the fixture a project', show(made))
  const status = json((await cli(['status', '--output-format', 'json'], { cwd: repo })).out)
  const projectName = status?.project?.name
  check(typeof projectName === 'string' && projectName.length > 0, 'status names the project', JSON.stringify(status)?.slice(0, 300))

  // ---------- a, b, d: full screen ----------
  {
    const t = tui(['--host', 'inproc', ...UI.fullscreenArgs], { cols: 120, rows: 30, cwd: repo })
    open.push(t)
    try {
      await t.waitFor((r) => r.includes('\x1b[?1049h') && r.includes('\x1b[?2004h'), 30_000, { raw: true })
      check(true, 'a: full screen at 120x30 enters the alternate screen and bracketed paste')
      await t.waitFor(projectName, 20_000)
      check(true, 'a: the status bar names the project')
      await type(t, 'E2E start the run')
      t.key('enter')
      await t.waitFor('E2E-MARK-ALPHA', 30_000)
      check(true, 'a: a prompt typed in the composer starts a run')
      await t.waitFor('E2E-MARK-OMEGA', 30_000).catch(() => undefined)
      await sleep(400)

      // b. Resize.
      const splitAt = locate(t, /E2E-MARK-(ALPHA|OMEGA)/)
      check(!!splitAt && splitAt.col >= 25, 'b: at 120 columns the transcript sits beside the agents pane (split)', esc(t.screen()))
      const mark = t.raw().length
      await t.resize(100, 30)
      await sleep(900)
      const stackedAt = locate(t, /E2E-MARK-(ALPHA|OMEGA)/)
      const treeAt = locate(t, UI.treeHeading)
      check(!!stackedAt && stackedAt.lineStart < 10, 'b: at 100 columns the transcript starts at the left edge (stacked)', esc(t.screen()))
      check(!treeAt || !stackedAt || treeAt.row < stackedAt.row, 'b: stacked: the agents pane is above the transcript', esc(t.screen()))
      await t.resize(120, 30)
      await sleep(900)
      const splitAgain = locate(t, /E2E-MARK-(ALPHA|OMEGA)/)
      check(!!splitAgain && splitAgain.col >= 25, 'b: back at 120 columns the layout is split again', esc(t.screen()))
      const during = t.rawSince(mark)
      check(!during.includes('\x1b[?1049l') && !during.includes('\x1b[?1049h'), 'b: resizing never leaves or re-enters the alternate screen', esc(during.slice(-200)))

      // d. Suspend / continue in full screen.
      const before = t.raw().length
      t.key('ctrl+z')
      await t.waitFor((r) => r.includes('\x1b[?2004l') && r.includes('\x1b[?25h') && r.includes('\x1b[?1049l'), 10_000, { raw: true, since: before })
      check(true, 'd: full screen Ctrl+Z leaves the alternate screen, turns paste off and shows the cursor')
      const stopped = await until('the TUI to stop', () => t.stat().includes('T'), 5_000).then(() => true, () => false)
      check(stopped, 'd: full screen Ctrl+Z stops the TUI process', t.stat())
      const cont = t.raw().length
      await t.signal('SIGCONT')
      await t.waitFor((r) => r.includes('\x1b[?1049h') && r.includes('\x1b[?2004h'), 10_000, { raw: true, since: cont })
      check(true, 'd: SIGCONT re-enters the alternate screen and bracketed paste')
      await t.waitFor(projectName, 10_000)
      await type(t, 'E2E-AFTER-CONT')
      await t.waitFor('E2E-AFTER-CONT', 10_000)
      check(true, 'd: after SIGCONT the screen redraws and typed text reaches the composer')
      for (let i = 0; i < 'E2E-AFTER-CONT'.length; i++) t.key('backspace')
      await sleep(300)

      // a. Quit.
      const tail = t.raw().length
      const e = await quit(t, { confirm: true })
      const end = t.rawSince(tail)
      check(e?.code === 0, 'a: quitting exits 0', JSON.stringify(e) + esc(t.screen().slice(-400)))
      check(end.includes('\x1b[?1049l') && end.includes('\x1b[?2004l') && end.includes('\x1b[?25h'), 'a: quitting leaves the alternate screen, turns paste off and shows the cursor', esc(end.slice(-200)))
    } finally {
      await t.close()
    }
  }

  // ---------- c, d: inline ----------
  {
    const t = tui(['--host', 'inproc', ...UI.inlineArgs], { cols: 90, rows: 20, cwd: repo })
    open.push(t)
    try {
      await t.waitFor(projectName, 30_000)
      await type(t, 'E2E inline run')
      t.key('enter')
      await t.waitFor((r) => r.includes('E2E-MARK-OMEGA'), 40_000, { raw: true })
      await sleep(800)
      check(!t.raw().includes('\x1b[?1049h'), 'c: inline at 90x20 never enters the alternate screen')
      const back = t.scrollback().join('\n')
      check(back.includes('E2E-MARK-ALPHA') && back.includes('E2E scroll line 1'), 'c: transcript rows land in the primary scrollback', esc(back.slice(-400)))
      const footer = t.screenLines().filter((l) => l.trim()).slice(-4).join('\n')
      check(footer.includes(projectName), 'c: the pinned footer names the project', esc(t.screen()))

      const before = t.raw().length
      t.key('ctrl+z')
      await t.waitFor((r) => r.includes('\x1b[?2004l') && r.includes('\x1b[?25h'), 10_000, { raw: true, since: before })
      const stopped = await until('the TUI to stop', () => t.stat().includes('T'), 5_000).then(() => true, () => false)
      check(stopped, 'd: inline Ctrl+Z turns paste off, shows the cursor and stops the TUI', t.stat())
      const cont = t.raw().length
      await t.signal('SIGCONT')
      await t.waitFor('\x1b[?2004h', 10_000, { raw: true, since: cont })
      await type(t, 'E2E-INLINE-CONT')
      await t.waitFor('E2E-INLINE-CONT', 10_000)
      check(!t.raw().includes('\x1b[?1049'), 'd: inline SIGCONT re-enables paste, never touches the alternate screen, and input works', esc(t.rawSince(cont).slice(-200)))
      for (let i = 0; i < 'E2E-INLINE-CONT'.length; i++) t.key('backspace')
      await sleep(300)
      const e = await quit(t, { confirm: true })
      check(e?.code === 0, 'c: the inline TUI quits with 0', JSON.stringify(e))
    } finally {
      await t.close()
    }
  }

  // ---------- e: split escape sequences ----------
  {
    const t = tui(['--host', 'inproc', ...UI.fullscreenArgs], { cols: 120, rows: 30, cwd: repo, script: SCRIPTS.escapes })
    open.push(t)
    try {
      await t.waitFor(projectName, 30_000)
      await type(t, 'E2E escapes')
      t.key('enter')
      await t.waitFor('E2E-ESC-DONE', 40_000)
      await sleep(500)
      const raw = t.raw()
      check(!raw.includes('SGVsbG8') && !raw.includes('\x1b]52'), 'e: the split OSC 52 clipboard write never reaches the terminal', esc(raw.slice(raw.indexOf('E2E-SPLIT') - 20, raw.indexOf('E2E-SPLIT') + 200)))
      check(!raw.includes(OSC8_URL) && !raw.includes('\x1b]8;'), 'e: the split OSC 8 link never reaches the terminal')
      check(!raw.includes(SGR_ODD) && !raw.includes('\x1b[38;5;123m'), 'e: the agent SGR after the split CSI clear never reaches the terminal')
      const screen = t.screen()
      check(screen.includes('click-me') && screen.includes('E2E-SPLIT-END') && !screen.includes('52;c'), 'e: the visible text is shown without the escape payloads', esc(screen))
      await quit(t, { confirm: true })
    } finally {
      await t.close()
    }
  }

  // ---------- f, g: a daemon host ----------
  // `--host daemon` TUIs are other processes: answering cards needs Terminal access 'full' (review H2).
  allowFullTerminalAccess()
  daemon = start(['--host', 'inproc', 'daemon', 'start', '--foreground'], { cwd: repo, env: baseEnv(SCRIPTS.cards) })
  await until('the inproc daemon to be ready', () => json(fs.existsSync(DAEMON_JSON) ? fs.readFileSync(DAEMON_JSON, 'utf8') : '')?.state === 'ready', 60_000)
  {
    const inbox = async () => json((await cli(['--host', 'daemon', 'inbox', '--output-format', 'json'], { cwd: repo })).out)?.items ?? []
    const t = tui(['--host', 'daemon', '--', 'E2E cards run'], { cols: 120, rows: 30, cwd: repo, script: SCRIPTS.cards })
    open.push(t)
    let watch
    try {
      await t.waitFor('E2E-CARDS-START', 40_000)
      const first = await until('the first permission card in the inbox', async () => (await inbox())[0], 30_000)
      const runId = first.runId
      // The watch stream: every event with the time it arrived.
      const events = []
      let buf = ''
      watch = start(['--host', 'daemon', 'watch', runId, '--output-format', 'stream-json'], { cwd: repo, env: baseEnv(SCRIPTS.cards) })
      watch.child.stdout.on('data', (d) => {
        buf += d
        let i
        while ((i = buf.indexOf('\n')) !== -1) {
          const line = json(buf.slice(0, i))
          buf = buf.slice(i + 1)
          if (line?.type === 'event' && line.event) events.push({ at: Date.now(), e: line.event })
        }
      })
      const ev = (type, pred = () => true) => events.find((x) => x.e.type === type && pred(x.e))
      const waitEv = (what, type, pred, ms = 30_000) => until(what, () => ev(type, pred), ms, 25)
      const cmdOf = (e) => e.request?.input?.command
      await sleep(1500) // the watch is subscribed

      // f. Paste safety.
      t.paste('y\na\n')
      await sleep(1200)
      const stillOne = (await inbox()).some((x) => x.requestId === first.requestId)
      check(stillOne && !ev('permission.resolved'), 'f: a pasted "y\\na\\n" in the composer resolves no card', JSON.stringify(await inbox()))
      check(/y\s*\n?\s*a/.test(t.screen()) || t.screen().includes('y a') || t.screen().includes('ya'), 'f: the composer shows the pasted text', esc(t.screen()))
      t.key('ctrl+c') // clears the composer (once; twice would detach)
      await sleep(1200)

      // g. Card 1 allowed with `y` from the tray (F2).
      const req1 = ev('permission.request', (e) => cmdOf(e) === 'npm run card-one')?.e.request ?? { id: first.requestId }
      t.key('f2')
      await sleep(250)
      t.write('y')
      const res1 = await waitEv('card 1 resolved', 'permission.resolved', (e) => e.requestId === req1.id)
      check(res1.e.decidedBy?.surface === 'tui', "g: `y` allows card 1 (permission.resolved decidedBy.surface 'tui')", JSON.stringify(res1.e))
      const ok1 = await waitEv('card 1 tool result', 'transcript', (e) => e.entry?.block?.kind === 'tool_result' && e.entry.block.content === 'card one ran', 10_000).then(() => true, () => false)
      check(ok1, 'g: card 1 ran as allowed (tool result "card one ran")')

      // The swap guard: a `y` right after card 2 appears is ignored. The key goes in only once the tray has drawn card 2
      // (its "Allow once" hint back on screen after card 1's left), so a guard-less tray would allow it; a key sent
      // before the card is drawn would only prove the card was not there yet.
      const card1Gone = await t.waitFor((s) => !s.includes('Allow once'), 10_000).then(() => true, () => false)
      check(card1Gone, "g: card 1's hints leave the tray once it is allowed", esc(t.screen()))
      const req2ev = await waitEv('card 2', 'permission.request', (e) => cmdOf(e) === 'npm run card-two')
      // An unfocused tray shows "Alt+D to answer" instead of its keys (issue #25), a focused one "Allow once".
      await t.waitFor((s) => /Allow once|Alt\+D to answer/.test(s) && s.includes('card-two'), 10_000)
      const drawnAt = Date.now()
      t.write('\x1bOQy') // F2 (in case focus moved while the tray was empty) and `y`, right after card 2 is drawn
      const lag = Date.now() - drawnAt
      await sleep(1000)
      const req2 = req2ev.e.request
      const pending2 = (await inbox()).some((x) => x.requestId === req2.id)
      check(lag < 200 && pending2 && !ev('permission.resolved', (e) => e.requestId === req2.id), 'g: a key within 750 ms of a card swap is ignored (card 2 drawn and still pending)', `lag ${lag} ms, pending ${pending2}`)
      t.key('f2')
      await sleep(200)
      t.write('n')
      await sleep(400)
      t.key('enter')
      const res2 = await waitEv('card 2 resolved', 'permission.resolved', (e) => e.requestId === req2.id)
      const denied2 = await waitEv('card 2 deny result', 'transcript', (e) => e.entry?.block?.kind === 'tool_result' && e.entry.block.isError && e.entry.block.content === 'Denied by user', 10_000).then(() => true, () => false)
      check(res2.e.decidedBy?.surface === 'tui' && denied2, "g: `n` + Enter denies card 2 with message 'Denied by user'", JSON.stringify(res2.e))

      // Question: option 2.
      const q = await waitEv('the question', 'question.request')
      await sleep(900)
      t.key('f2')
      await sleep(200)
      t.write('2')
      await sleep(300)
      t.key('enter')
      const qr = await waitEv('the question answered', 'question.resolved', (e) => e.questionId === q.e.question.id)
      check(qr.e.decidedBy?.surface === 'tui' && JSON.stringify(qr.e.answer?.selected) === JSON.stringify([QUESTION_LABELS[1]]), 'g: `2` + Enter answers the question with the second option', JSON.stringify(qr.e))

      // Rules: grant for the run.
      const rq = await waitEv('the rules request', 'rules.request')
      await sleep(900)
      t.key('f2')
      await sleep(200)
      t.write('r')
      const rr = await waitEv('the rules request answered', 'rules.resolved', (e) => e.requestId === rq.e.request.id)
      check(rr.e.decidedBy?.surface === 'tui' && rr.e.decision?.behavior === 'grant' && rr.e.decision?.scope === 'run', "g: `r` grants the rules for the run ({ behavior: 'grant', scope: 'run' })", JSON.stringify(rr.e))

      // MCP install: deny.
      const mq = await waitEv('the MCP install request', 'mcpInstall.request')
      await sleep(900)
      t.key('f2')
      await sleep(200)
      t.write('n')
      await sleep(400)
      t.key('enter') // a deny note prompt, if any; ignored by the next card's guard otherwise
      const mr = await waitEv('the MCP install answered', 'mcpInstall.resolved', (e) => e.requestId === mq.e.request.id)
      check(mr.e.decidedBy?.surface === 'tui' && mr.e.outcome?.approved === false, 'g: `n` denies the MCP install (outcome not approved)', JSON.stringify(mr.e))

      // Proposal: decline.
      const pq = await waitEv('the skills proposal', 'proposal.request')
      await sleep(900)
      t.key('f2')
      await sleep(200)
      t.write('d')
      await sleep(400)
      t.key('enter')
      const pr = await waitEv('the proposal answered', 'proposal.resolved', (e) => e.proposalId === pq.e.proposal.id)
      check(pr.e.decidedBy?.surface === 'tui' && pr.e.decision?.behavior === 'decline', 'g: `d` declines the proposal', JSON.stringify(pr.e))

      // Two-step: `a` opens a confirmation; another process resolves the card meanwhile.
      const c3 = await waitEv('card 3', 'permission.request', (e) => cmdOf(e) === 'npm run card-three')
      await sleep(900)
      t.key('f2')
      await sleep(200)
      t.write('a')
      await sleep(1000)
      check(!ev('permission.resolved', (e) => e.requestId === c3.e.request.id), 'g: `a` (always allow) waits for its second step')
      const other = await cli(['--host', 'daemon', 'decide', c3.e.request.id, 'deny'], { cwd: repo })
      check(other.code === 0, 'g: `orgai decide <id> deny` from another process applies', show(other))
      const r3 = await waitEv('card 3 resolved', 'permission.resolved', (e) => e.requestId === c3.e.request.id)
      check(r3.e.decidedBy?.surface === 'cli', "g: card 3 was decided by the CLI (surface 'cli')", JSON.stringify(r3.e))
      const notice = await t.waitFor(UI.resolvedElsewhere, 10_000).then(() => true, () => false)
      check(notice, 'g: the TUI closes the confirmation with "Resolved in another window"', esc(t.screen()))
      await t.waitFor('E2E-CARDS-DONE', 30_000).catch(() => undefined)

      const e = await quit(t)
      check(e?.code === 0, 'g: the daemon-client TUI quits with 0 and leaves runs running', `${JSON.stringify(e)} ${esc(t.screen())}`)
    } finally {
      watch?.child.kill('SIGINT')
      await t.close()
    }
  }
  daemon.child.kill('SIGINT')
  {
    const tk = setTimeout(() => daemon.child.kill('SIGKILL'), 20_000)
    await daemon.done
    clearTimeout(tk)
    daemon = undefined
  }

  // ---------- i: the org tree, inspector and keys overlay ----------
  {
    const t = tui(['--host', 'inproc', ...UI.fullscreenArgs], { cols: 120, rows: 40, script: '', cwd: repo })
    open.push(t)
    try {
      await t.waitFor(projectName, 30_000)
      await type(t, '[mock:deep-tree] E2E deep tree')
      t.key('enter')
      await t.waitFor('mock-lead', 40_000)
      check(true, 'i: the deep-tree run shows mock-lead in the agents pane')
      // The reports finish at once; after the 6 s grace they fold into one row while the run is still open.
      // The reports fold first ("2 done"); mock-lead ends a moment later and folds with them into "3 done" under the
      // root. Keys sent between those two moments land on rows that then move, so wait for the final shape (the
      // earlier fixed-sleep version lost Enter to exactly that: it hit the "3 done" row and unfolded it).
      const folded = await t.waitFor(/\b[23] done\b/, 30_000).then(() => true, () => false)
      check(folded, 'i: the finished reports fold into a "done" row after the grace', esc(t.screen()))
      const settled = await t.waitFor(/\b3 done\b/, 30_000).then(() => true, () => false)
      check(settled, 'i: mock-lead folds with its reports into one "3 done" row', esc(t.screen()))

      t.key('tab') // the agents pane
      await t.waitFor(/Enter details|Enter\/Right unfold/, 5_000).catch(() => undefined)
      t.write('n')
      await t.waitFor('Nothing needs you.', 5_000).then(
        () => check(true, 'i: `n` with nothing waiting says so'),
        () => check(false, 'i: `n` with nothing waiting says so', esc(t.screen()))
      )
      // Selection starts on the root; the "3 done" group is the next row. Wait for it to be the selected row.
      t.key('down')
      const onGroup = await t.waitFor(/^> .*\b3 done\b/m, 5_000).then(() => true, () => false)
      check(onGroup, 'i: Down selects the "3 done" row', esc(t.screen()))
      t.key('right')
      // Wait for the tree row itself (the name also sits in the transcript beside it) and for the selection to move to it.
      const open2 = await t.waitFor(/^> .*mock-lead\s+Finished/m, 8_000).then(() => true, () => false)
      check(open2, 'i: Right on the "3 done" row unfolds it and selects mock-lead', esc(t.screen()))

      // Enter on the agent row (not a group) opens its inspector.
      t.key('enter')
      const inspector = await t.waitFor('transcript (this agent', 8_000).then(() => true, () => false)
      check(inspector, 'i: Enter on an agent opens the inspector with its own transcript', esc(t.screen()))
      check(/model|turns|tool call|now /.test(t.screen()), 'i: the inspector shows the facts the mock reports', esc(t.screen()))

      t.write('?')
      const keys = await t.waitFor('Keys: Agent inspector', 8_000).then(() => true, () => false)
      check(keys, 'i: `?` opens the keys overlay of the inspector', esc(t.screen()))
      // The title can arrive in an earlier pty chunk than the body; wait for the legend instead of reading one frame.
      const legend = await t.waitFor(/finished/, 5_000).then(() => /idle/.test(t.screen()), () => false)
      check(legend, 'i: the overlay carries the glyph legend', esc(t.screen()))
      t.key('esc')
      await sleep(400)
      check(!t.screen().includes('Keys: Agent inspector'), 'i: Esc closes the overlay', esc(t.screen()))
      check(t.screen().includes('transcript (this agent'), 'i: ... and leaves the inspector open', esc(t.screen()))
      t.key('esc')
      await sleep(500)
      check(!t.screen().includes('transcript (this agent'), 'i: Esc closes the inspector', esc(t.screen()))

      t.write('z')
      const zoomed = await t.waitFor('Focus: ', 5_000).then(() => true, () => false)
      check(zoomed, 'i: `z` roots the tree at the agent (breadcrumb in the title)', esc(t.screen()))
      t.write('Z')
      await sleep(500)
      check(!t.screen().includes('Focus: '), 'i: Z goes back to the whole run', esc(t.screen()))

      // Focus is still on the agents pane (typing there is not the composer); Esc goes back to the composer.
      t.key('esc')
      await sleep(400)
      const e = await quit(t, { confirm: true })
      check(e?.code === 0, 'i: quitting exits 0', JSON.stringify(e))
    } finally {
      await t.close()
    }
  }

  // ---------- h: SIGTERM cleanup ----------
  {
    const t = tui(['--host', 'inproc', ...UI.fullscreenArgs], { cols: 120, rows: 30, cwd: repo })
    open.push(t)
    try {
      await t.waitFor(projectName, 30_000)
      const tail = t.raw().length
      await t.signal('SIGTERM')
      const e = await Promise.race([t.exited, sleep(15_000).then(() => null)])
      const end = t.rawSince(tail)
      check(end.includes('\x1b[?1049l') && end.includes('\x1b[?25h'), 'h: SIGTERM in full screen leaves the alternate screen and shows the cursor', esc(end.slice(-200)))
      check(e?.code === 143, 'h: SIGTERM exits 143', JSON.stringify(e))
    } finally {
      await t.close()
    }
  }
} catch (e) {
  check(false, 'cli-tui ran to the end', e instanceof Error ? e.stack : String(e))
  const last = open.at(-1)
  if (last) log(`last screen:\n${last.screen()}`)
} finally {
  for (const t of open) await t.close().catch(() => undefined)
  if (daemon) {
    daemon.child.kill('SIGINT')
    const tk = setTimeout(() => daemon.child.kill('SIGKILL'), 20_000)
    await daemon.done
    clearTimeout(tk)
  }
  if (fs.existsSync(DAEMON_JSON)) await cli(['daemon', 'stop', '--force'], { cwd: APP_DIR, timeoutMs: 30_000 }).catch(() => undefined)
  removeFixture(repo)
  log('done')
}
finish('cli-tui')
