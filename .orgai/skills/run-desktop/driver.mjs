// Line-oriented REPL that launches the BUILT OrgAI Electron app with playwright-core and drives it.
// Start: node .claude/skills/run-desktop/driver.mjs   (run `npm run build` first)
// Each command prints its result followed by a line "OK" or "ERR <message>".
import { _electron as electron } from 'playwright-core'
import { createRequire } from 'node:module'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as readline from 'node:readline'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const APP_DIR = process.env.ORGAI_APP_DIR ? path.resolve(process.env.ORGAI_APP_DIR) : path.resolve(HERE, '..', '..', '..')
const SHOTS = process.env.ORGAI_SHOTS_DIR ? path.resolve(process.env.ORGAI_SHOTS_DIR) : path.join(APP_DIR, 'e2e', 'shots')

const HELP = `commands:
  launch                 start the built app and wait for the window
  ss <name>              screenshot to ${SHOTS}${path.sep}<name>.png
  click <css or text>    click the first element matching a CSS selector, else the first element with that text
  type <css> <text>      fill an input or textarea (\`backtick-quote\` a selector that contains spaces)
  press <key>            keyboard press, e.g. Enter, Control+A, Escape
  text <css>             print innerText of the first match
  eval <js>              evaluate a JS expression in the renderer (window.orgai.* is the app API); prints JSON
  quit                   close the app and exit`

let app = null
let page = null

function needPage() {
  if (!page) throw new Error('app not launched; run "launch" first')
  return page
}

/** CSS selector if it parses and matches something, otherwise text. */
async function resolve(target) {
  const p = needPage()
  try {
    const css = p.locator(target)
    if ((await css.count()) > 0) return css.first()
  } catch {
    /* not a valid selector */
  }
  const byText = p.getByText(target, { exact: true })
  if ((await byText.count()) > 0) return byText.first()
  const loose = p.getByText(target)
  if ((await loose.count()) > 0) return loose.first()
  throw new Error(`nothing matches ${JSON.stringify(target)}`)
}

const commands = {
  async launch() {
    if (app) return 'already launched'
    if (!fs.existsSync(path.join(APP_DIR, 'out', 'main', 'index.js'))) throw new Error(`no build in ${APP_DIR}/out; run npm run build`)
    const executablePath = createRequire(path.join(APP_DIR, 'package.json'))('electron')
    app = await electron.launch({ executablePath, args: [APP_DIR], cwd: APP_DIR, timeout: 60_000 })
    page = await app.firstWindow()
    page.on('dialog', (d) => {
      console.log(`[dialog accepted] ${d.message()}`)
      void d.accept()
    })
    page.on('console', (m) => {
      if (m.type() === 'error') console.log(`[console.error] ${m.text().slice(0, 300)}`)
    })
    page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`))
    await page.waitForSelector('.sidebar', { timeout: 60_000 })
    return `launched ${APP_DIR}`
  },
  async ss(name) {
    if (!name) throw new Error('usage: ss <name>')
    fs.mkdirSync(SHOTS, { recursive: true })
    const file = path.join(SHOTS, `${name.replace(/\.png$/i, '')}.png`)
    await needPage().screenshot({ path: file })
    return file
  },
  async click(target) {
    if (!target) throw new Error('usage: click <css or text>')
    await (await resolve(target)).click({ timeout: 10_000 })
    return `clicked ${target}`
  },
  async type(rest) {
    // A selector containing spaces goes in backticks: type `input[placeholder="My app"]` hello
    const m = /^`([^`]+)`\s+([\s\S]*)$/.exec(rest ?? '') ?? /^(\S+)\s+([\s\S]*)$/.exec(rest ?? '')
    if (!m) throw new Error('usage: type <css> <text>  (backtick-quote a selector that has spaces)')
    await needPage().locator(m[1]).first().fill(m[2], { timeout: 10_000 })
    return `typed into ${m[1]}`
  },
  async press(key) {
    if (!key) throw new Error('usage: press <key>')
    await needPage().keyboard.press(key)
    return `pressed ${key}`
  },
  async text(css) {
    if (!css) throw new Error('usage: text <css>')
    return await needPage().locator(css).first().innerText({ timeout: 10_000 })
  },
  async eval(js) {
    if (!js) throw new Error('usage: eval <js>')
    // Wrap so both expressions and promises work; window.orgai calls return promises.
    const value = await needPage().evaluate(`(async () => (${js}))()`)
    return JSON.stringify(value, null, 2) ?? 'undefined'
  },
  async quit() {
    await app?.close().catch(() => {})
    app = null
    page = null
    process.exit(0)
  },
  async help() {
    return HELP
  }
}

console.log(`OrgAI driver. App dir: ${APP_DIR}\n${HELP}`)
const rl = readline.createInterface({ input: process.stdin, terminal: false })
for await (const raw of rl) {
  const line = raw.trim()
  if (!line || line.startsWith('#')) continue
  const sp = line.indexOf(' ')
  const cmd = sp === -1 ? line : line.slice(0, sp)
  const arg = sp === -1 ? '' : line.slice(sp + 1).trim()
  const fn = commands[cmd]
  if (!fn) {
    console.log(`ERR unknown command ${cmd}; try help`)
    continue
  }
  try {
    const out = await fn(arg)
    if (out) console.log(out)
    console.log('OK')
  } catch (e) {
    console.log(`ERR ${String(e?.message ?? e).split('\n')[0]}`)
  }
}
await commands.quit()
