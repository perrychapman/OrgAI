// The interactive terminal UI end to end (cli-spec 5 and 8, Wave 4 gate), driven through a pseudo-terminal
// (e2e/ptyDriver.mjs: python3 stdlib pty or `script`, no native addon). Run `npm run build` first. Mock adapter only
// (ORGAI_MOCK=1): no tokens. No Electron: each TUI hosts itself (one orgai at a time). Every scripted turn comes from an ORGAI_MOCK_SCRIPT JSON in the data dir.
//
// SKIPs (exit 0, "SKIP cli-tui: ...") on win32, when no pty backend passes ptyDriver's probe (tty, size, resize, raw
// input and a real SIGTSTP stop), and while out/cli/tui.mjs is still the Wave 4 contracts stub.
//
// a. Full screen at 120x30 (`tui`): \x1b[?1049h and \x1b[?2004h are written, the status bar names the
//    project, a typed prompt starts a run whose text appears; /quit (Ctrl+D as a fallback, plus the inproc stop
//    confirmation) leaves the alternate screen: the tail has \x1b[?1049l, \x1b[?2004l, \x1b[?25h and the exit is 0.
// b. Resize 120x30 -> 100x30 (stacked: the transcript starts at the left edge, the agents pane above it) -> 120x30
//    (split: the transcript sits left of the agents pane); no \x1b[?1049l / \x1b[?1049h during the resizes.
// c. Inline at 90x20 (below 100x24 at launch): no \x1b[?1049h at all; transcript rows land in the primary scrollback;
//    the footer carries the status bar. (The status bar drops the project name first when it does not fit, so these
//    steps wait on "N need you", drawn once the project is loaded; the name is asserted through `orgai status`.)
// d. Ctrl+Z (\x1a) in both modes: \x1b[?2004l and \x1b[?25h (full screen also \x1b[?1049l) are written and `ps` shows
//    the TUI stopped (T); SIGCONT re-enables bracketed paste, re-enters \x1b[?1049h only in full screen, redraws, and
//    typed text reaches the composer again.
// e. Split escapes: a mock text step whose `partials` cut an OSC 52 clipboard write, an OSC 8 link and a CSI clear
//    (plus a distinctive SGR) across chunks: the raw pty output never carries their payloads; the visible text does.
// f. Paste safety: with a permission card open, a bracketed paste of "y\na\n" into the composer resolves nothing (the
//    tool never runs); the composer shows the text. While the TUI runs, a second `orgai connections list` is refused at
//    once (exit 6, naming the first orgai's folder and pid), `runs list` answers from the files with the snapshot note and
//    `status` has no live cards (spec 4.2, 4.3).
// g. Cards in the TUI that owns the folder: `y` from the tray allows card 1 (its tool result is shown); card 2 is denied
//    with `n` + Enter (its tool never runs); then the question (F2, `2`, Enter), the rules request (`r`), the MCP install
//    (`n`, Enter), the proposal (`d`, Enter) and card three (`a` only opens a confirmation, Esc cancels, `y` allows it); the
//    saved run holds each answer; `status` beside the TUI has liveInboxAvailable false and no cards; /quit asks to stop the live runs and exits 0.
// i. The org tree (ux-review-tui-org.md, `[mock:deep-tree]` on the mock's default script, full screen 120x40): the root, mock-lead
//    and its two reports; configured team members stay visible after the 6 s grace, with unstarted roles Available.
//    Down selects mock-lead; `n`
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
import { APP_DIR, DATA_DIR, check, finish, log, makeFixtureRepo, removeFixture, sleep } from './lib.mjs'
import { probePty, spawnTui } from './ptyDriver.mjs'
import { writeFileSync as markWrite } from 'node:fs'
import { join as markJoin } from 'node:path'
// The CLI marks its own data folder (spec 3.1); this script seeds files before the first command, so it marks it itself.
markWrite(markJoin(DATA_DIR, 'product.json'), `${JSON.stringify({ product: 'orgai-cli', version: 1 })}\n`, { mode: 0o600 })

const CLI = path.join(APP_DIR, 'out', 'cli', 'orgai.mjs')
const TUI_BUNDLE = path.join(APP_DIR, 'out', 'cli', 'tui.mjs')
const DAEMON_JSON = path.join(DATA_DIR, 'data', 'run', 'daemon.json')

/** UI words and argv the checks depend on (W4-T3/T5 own the real ones). */
const UI = {
  fullscreenArgs: ['tui'],
  inlineArgs: ['tui'], // at 90x20 the TUI picks inline by size; `--inline` forces it at any size
  /** The notice the TUI showed when another window answered a card: no longer possible, checked to stay absent. */
  resolvedElsewhere: /Resolved (by (the |something)|in another window)/i,
  /** The agents pane's heading (soft check: the layout is judged by where the transcript text starts). */
  treeHeading: /\b(Agents|Org|Team)\b/,
  /** Fullscreen welcomes a loaded project; the inline footer retains its decision count. */
  statusReady: /\bneeds? you\b|What would you like your team to work on\?|(?:Message|Send to continue) R\d+/
}

// An unfocused tray shows only "Alt+D or F2 to answer"; a focused one shows "Approve" / "Allow once".
const CARD_ON_SCREEN = /Approve|Allow once|to answer/

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
  const env = { ...process.env, ORGAI_CLI_DATA_DIR: DATA_DIR, ORGAI_MOCK: '1', NO_COLOR: '1', TERM: 'xterm-256color', ORGAI_MOCK_SCRIPT: script, LANG: 'en_US.UTF-8' }
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
try {
  // ---------- Project ----------
  const made = await cli(['exec', '--output-format', 'json', '--create-project', '--team', 'single', 'hello'], { cwd: repo, timeoutMs: 120_000 })
  check(made.code === 0, 'exec --create-project makes the fixture a project', show(made))
  const status = json((await cli(['status', '--output-format', 'json'], { cwd: repo })).out)
  const projectName = status?.project?.name
  check(typeof projectName === 'string' && projectName.length > 0, 'status names the project', JSON.stringify(status)?.slice(0, 300))

  // ---------- a, b, d: full screen ----------
  {
    const t = tui([...UI.fullscreenArgs], { cols: 120, rows: 30, cwd: repo })
    open.push(t)
    try {
      await t.waitFor((r) => r.includes('\x1b[?1049h') && r.includes('\x1b[?2004h'), 30_000, { raw: true })
      check(true, 'a: full screen at 120x30 enters the alternate screen and bracketed paste')
      await t.waitFor(UI.statusReady, 20_000)
      check(true, 'a: the status bar shows the project is loaded (the name itself is dropped first when it does not fit)')
      await type(t, 'E2E start the run')
      t.key('enter')
      await t.waitFor('E2E-MARK-ALPHA', 30_000)
      check(true, 'a: a prompt typed in the composer starts a run')
      await t.waitFor('E2E-MARK-OMEGA', 30_000).catch(() => undefined)
      await sleep(400)

      // b. Resize.
      const splitAt = locate(t, /E2E-MARK-(ALPHA|OMEGA)/)
      const splitTree = locate(t, UI.treeHeading)
      check(!!splitAt && !!splitTree && splitAt.col < splitTree.col && splitTree.col >= 70, 'b: at 120 columns the agent room sits right of the transcript', esc(t.screen()))
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
      const treeAgain = locate(t, UI.treeHeading)
      check(!!splitAgain && !!treeAgain && splitAgain.col < treeAgain.col && treeAgain.col >= 70, 'b: back at 120 columns the agent room is on the right again', esc(t.screen()))
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
      await t.waitFor(UI.statusReady, 10_000)
      await type(t, 'E2E-AFTER-CONT')
      await t.waitFor('E2E-AFTER-CONT', 10_000)
      check(true, 'd: after SIGCONT the screen redraws and typed text reaches the composer')
      for (let i = 0; i < 'E2E-AFTER-CONT'.length; i++) t.key('backspace')
      await sleep(300)

      // a. Quit.
      t.key('ctrl+d')
      await t.waitFor(s => s.includes('Quit and stop') && /Message R\d+/.test(s), 10_000)
      const confirmRow = locate(t, /Quit and stop/)
      const inputRow = locate(t, /Message R\d+/)
      check(t.screen().includes('E2E-MARK-OMEGA') && !!confirmRow && !!inputRow && inputRow.row - confirmRow.row <= 5,
        'a: quit confirmation stays above the input and preserves the conversation', esc(t.screen()))
      t.key('escape')
      await t.waitFor(s => !s.includes('Quit and stop'), 10_000)
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
    const t = tui([...UI.inlineArgs], { cols: 90, rows: 20, cwd: repo })
    open.push(t)
    try {
      await t.waitFor(UI.statusReady, 30_000)
      await type(t, 'E2E inline run')
      t.key('enter')
      await t.waitFor((r) => r.includes('E2E-MARK-OMEGA'), 40_000, { raw: true })
      await sleep(800)
      check(!t.raw().includes('\x1b[?1049h'), 'c: inline at 90x20 never enters the alternate screen')
      const back = t.scrollback().join('\n')
      check(back.includes('E2E-MARK-ALPHA') && back.includes('E2E scroll line 1'), 'c: transcript rows land in the primary scrollback', esc(back.slice(-400)))
      const footer = t.screenLines().filter((l) => l.trim()).slice(-4).join('\n')
      check(UI.statusReady.test(footer), 'c: the pinned footer carries the status bar', esc(t.screen()))

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
    const t = tui([...UI.fullscreenArgs], { cols: 120, rows: 30, cwd: repo, script: SCRIPTS.escapes })
    open.push(t)
    try {
      await t.waitFor(UI.statusReady, 30_000)
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

  // ---------- f, g: cards in the TUI that owns the folder ----------
  // The TUI is the only process that can answer its cards (spec 4.4). Every other `orgai` is refused at once, and the
  // read-only commands answer from the files beside it.
  {
    const t = tui(['--', 'E2E cards run'], { cols: 120, rows: 30, cwd: repo, script: SCRIPTS.cards })
    open.push(t)
    try {
      await t.waitFor('E2E-CARDS-START', 40_000)
      await t.waitFor(CARD_ON_SCREEN, 30_000)

      // h2. A second orgai: refused at once with exit 6; the read-only commands work beside it.
      const began = Date.now()
      const second = await cli(['connections', 'list'], { cwd: repo })
      check(second.code === 6 && /orgai is already running in another terminal \(.*, pid \d+\)\. Use that one, or quit it first\./.test(second.err), 'a second orgai is refused with exit 6 naming the first', show(second))
      check(Date.now() - began < 15_000, 'the refusal came at once', `${Date.now() - began} ms`)
      const beside = await cli(['runs', 'list'], { cwd: repo })
      check(beside.code === 0 && beside.err.includes('this is a saved snapshot'), 'runs list beside the TUI is a saved snapshot', show(beside))
      const statusBeside = await cli(['status', '--output-format', 'json'], { cwd: repo })
      check(statusBeside.code === 0, 'status beside the TUI answers from the saved files', show(statusBeside))

      // An idle empty prompt focuses the arriving inline approval; Esc returns to drafting.
      await t.waitFor('Enter confirm', 5000)
      check(t.screen().includes('> [y]'), 'f: a new approval selects Allow once on an idle prompt', esc(t.screen()))
      t.key('escape')
      await t.waitFor('Shift+Tab to choose', 5000)
      await sleep(100)
      // f. Paste safety.
      t.paste('y\na\n')
      await sleep(1200)
      check(!t.screen().includes('card one ran'), 'f: a pasted "y\\na\\n" in the composer resolves no card', esc(t.screen()))
      check(/y\s*\n?\s*a/.test(t.screen()) || t.screen().includes('y a') || t.screen().includes('ya'), 'f: the composer shows the pasted text', esc(t.screen()))
      t.key('ctrl+c') // clears the composer (once; twice would quit)
      await sleep(1200)

      // g. Card 1 allowed with Enter from the inline choices (F2): its tool ran.
      t.key('f2')
      await sleep(250)
      t.key('enter')
      await t.waitFor('card one ran', 20_000)
      check(true, 'g: Enter allows card 1 (its tool result "card one ran" is shown)')

      // Focus the new card before acting so this exercises the arrival guard, not an unfocused composer.
      await t.waitFor(s => s.includes('card-two') && s.includes('Allow once'), 20_000)
      const cardTwoDrawnAt = Date.now()
      t.key('f2')
      await t.waitFor(s => s.includes('card-two') && s.includes('Enter confirm'), 5000)
      const cardTwoInputLag = Date.now() - cardTwoDrawnAt
      t.write('y')
      const guardShown = await t.waitFor(/(?:card just changed|card only just arrived)/i, 2000).then(() => true, () => false)
      check(cardTwoInputLag < 200 && guardShown && t.screen().includes('card-two') && CARD_ON_SCREEN.test(t.screen()) && !t.screen().includes('card two ran'),
        'g: a focused action inside the card-swap guard is ignored and explains why', `lag ${cardTwoInputLag} ms; ${esc(t.screen())}`)
      // After the guard, `n` + Enter denies it and the card leaves the tray.
      await sleep(900)
      t.key('f2')
      await sleep(200)
      t.write('n')
      await sleep(300)
      t.key('enter')
      const gone = await t.waitFor((s) => !CARD_ON_SCREEN.test(s), 15_000).then(() => true, () => false)
      check(gone, 'g: card 2 left the tray after `n` + Enter', esc(t.screen()))
      check(!t.screen().includes('card two ran'), 'g: `n` + Enter denies card 2 (its tool never ran)', esc(t.screen()))

      // Each next card is drawn at once; wait for its words, let the 750 ms swap guard pass, then open the tray (F2).
      const focusCard = async (what, words) => {
        await t.waitFor(words, 25_000)
        await sleep(900)
        t.key('f2')
        await sleep(250)
        log(`answering ${what}`)
      }
      // Question: option 2.
      await focusCard('the question', 'which option')
      t.write('2')
      await sleep(300)
      t.key('enter')
      // Rules request: grant for the run.
      await focusCard('the rules request', 'npm run lint')
      t.write('r')
      // MCP install: deny (a deny note prompt, if any, is closed by Enter).
      await focusCard('the MCP install', 'e2e-mcp')
      t.write('n')
      await sleep(400)
      t.key('enter')
      // Skills proposal: decline.
      await focusCard('the proposal', 'e2e-skill')
      t.write('d')
      await sleep(400)
      t.key('enter')
      // Card three, two steps: `a` (always allow) only asks; Esc cancels it and the card stays; then `y` allows it once.
      await focusCard('card three', 'card-three')
      t.write('a')
      const asked = await t.waitFor(/Esc cancels/, 10_000).then(() => true, () => false)
      check(asked, 'g: `a` (always allow) opens a confirmation instead of deciding', esc(t.screen()))
      t.key('esc')
      await sleep(800)
      check(!t.screen().includes('card three ran') && CARD_ON_SCREEN.test(t.screen()), 'g: Esc cancels the confirmation and card three is still pending', esc(t.screen()))
      t.write('y')
      const threeGone = await t.waitFor((sc) => !CARD_ON_SCREEN.test(sc), 15_000).then(() => true, () => false)
      check(threeGone, 'g: after the cancelled confirmation `y` answers card three (it leaves the tray)', esc(t.screen()))
      await t.waitFor('E2E-CARDS-DONE', 30_000).catch(() => undefined)
      // The words of a card another window resolved are gone from this build: the owning terminal answers everything.
      check(!UI.resolvedElsewhere.test(t.screen()), 'g: no "resolved elsewhere" notice appears (nothing else can answer a card)', esc(t.screen()))

      // Beside the TUI, status has no live inbox and no cards (spec 4.3).
      const statusMid = json((await cli(['status', '--output-format', 'json'], { cwd: repo })).out)
      const withoutInbox = Object.keys(statusMid ?? {}).filter((k) => k !== 'liveInboxAvailable')
      check(statusMid?.liveInboxAvailable === false && !withoutInbox.some((k) => /card|pending|inbox|decision/i.test(k)), 'g: status beside the TUI has liveInboxAvailable false and no card entries', JSON.stringify(statusMid)?.slice(0, 300))

      const e = await quit(t, { confirm: true })
      check(e?.code === 0, 'g: the TUI quits with 0 (runs end with it)', `${JSON.stringify(e)} ${esc(t.screen())}`)
    } finally {
      await t.close()
    }
  }
  check(!fs.existsSync(DAEMON_JSON), 'the folder is free after the TUI quits')
  // The saved run holds the answers: card 1 ran, card 2 was denied by the user and never ran (read hostless after quit).
  {
    const listed = await cli(['runs', 'list', '--output-format', 'json'], { cwd: repo })
    const cardsRun = json(listed.out)?.runs?.find((r) => r?.summary?.prompt === 'E2E cards run')
    check(!!cardsRun, 'g: the cards run is among the saved runs', show(listed))
    const saved = await cli(['runs', 'show', cardsRun?.summary?.id ?? 'R1', '--transcript', '--output-format', 'json'], { cwd: repo })
    check(saved.code === 0 && saved.out.includes('card one ran'), 'g: the saved run shows card 1 ran', show(saved))
    check(saved.out.includes('Denied by user') && !saved.out.includes('card two ran'), 'g: the saved run shows card 2 "Denied by user" and no "card two ran"', show(saved))
    check(saved.out.includes('card three ran'), 'g: the saved run shows card three ran after its confirmation was cancelled', show(saved))
    // The other cards' answers, from the record (a tool result per card; the run record keeps no decidedBy surface).
    const raw = saved.out
    check(raw.includes(QUESTION_LABELS[1]) && !/"content":"(Alpha|Charlie) option"/.test(raw), 'g: the saved run holds the question answer (the second label)', raw.slice(0, 400))
    check(/GRANTED \(this run only\): Bash\(npm run lint:\*\)/.test(raw), "g: the saved run shows the rules request granted for the run only", raw.slice(0, 400))
    check(/user denied installing this server/.test(raw), 'g: the saved run shows the MCP install denied (not approved)', raw.slice(0, 400))
    check(/DECLINED\. The user declined this proposal/.test(raw), 'g: the saved run shows the proposal declined', raw.slice(0, 400))
  }

  // ---------- i: the org tree, inspector and keys overlay ----------
  {
    const t = tui([...UI.fullscreenArgs], { cols: 120, rows: 40, script: '', cwd: repo })
    open.push(t)
    try {
      await t.waitFor(UI.statusReady, 30_000)
      await type(t, '[mock:deep-tree] E2E deep tree')
      t.key('enter')
      await t.waitFor('mock-lead', 40_000)
      check(true, 'i: the deep-tree run shows mock-lead in the agents pane')
      // Configured roles stay visible after their agents finish. Unstarted roles remain Available.
      await t.waitFor(/^.{79}.*mock-lead[^\n]*\n.{79}[ │]+Finished/m, 30_000)
      await sleep(7000)
      check(/^.{79}.*mock-lead[^\n]*\n.{79}[ │]+Finished/m.test(t.screen()), 'i: the configured team stays visible after the settle grace', esc(t.screen()))
      check(/Team 4/.test(t.screen()) && /Reviewer[^\n]*\n.{79}[ │]+Available/.test(t.screen()) && /Researcher[^\n]*\n.{79}[ │]+Available/.test(t.screen()),
        'i: the sidebar includes configured roles that have not started', esc(t.screen()))

      t.key('tab') // conversation on the left
      t.key('tab') // agents on the right
      await t.waitFor(/Enter details|Enter\/Right unfold/, 5_000).catch(() => undefined)
      t.write('n')
      await t.waitFor('Nothing needs you.', 5_000).then(
        () => check(true, 'i: `n` with nothing waiting says so'),
        () => check(false, 'i: `n` with nothing waiting says so', esc(t.screen()))
      )
      // At 120 columns the 41-column agent room begins at column 79. Match its selection marker,
      // not a prompt or a mention in the conversation to its left. The next row after the root is mock-lead.
      t.key('down')
      const open2 = await t.waitFor(/^.{79}> .*mock-lead[^\n]*\n.{79}[ │]+Finished/m, 8_000).then(() => true, () => false)
      check(open2, 'i: Down selects the finished team member', esc(t.screen()))

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
    const t = tui([...UI.fullscreenArgs], { cols: 120, rows: 30, cwd: repo })
    open.push(t)
    try {
      await t.waitFor(UI.statusReady, 30_000)
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
  removeFixture(repo)
  log('done')
}
finish('cli-tui')
