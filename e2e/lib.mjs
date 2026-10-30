// Shared helpers for the OrgAI end-to-end scripts. Each script launches the BUILT app (run `npm run build` first)
// with playwright-core's Electron driver, works against a throwaway fixture repository under os.tmpdir(), and
// removes its OrgAI project at the end. The app runs against a fresh temp data dir per script (ORGAI_DATA_DIR, which
// replaces userData and holds the logs too), or against ORGAI_DATA_DIR if you set it yourself.
import { _electron as electron } from 'playwright-core'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

export const E2E_DIR = path.dirname(fileURLToPath(import.meta.url))
export const APP_DIR = path.resolve(E2E_DIR, '..')
export const SHOTS_DIR = path.join(E2E_DIR, 'shots')

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)

/** os.tmpdir() with symlinks resolved (macOS: /var/folders/... is /private/var/folders/...), as the app reports paths. */
export const TMP = fs.realpathSync.native(os.tmpdir())

// One data dir per script run, shared by every launch() in it (history.mjs restarts the app). A dir we created is
// removed when the script passes and kept (path printed) when it fails, so its logs/main.log can be read.
const ownDataDir = !process.env.ORGAI_DATA_DIR?.trim()
export const DATA_DIR = ownDataDir ? fs.mkdtempSync(path.join(TMP, 'orgai-e2e-data-')) : path.resolve(process.env.ORGAI_DATA_DIR.trim())
process.on('exit', (code) => {
  if (!ownDataDir) return
  let used = true
  try {
    used = fs.readdirSync(DATA_DIR).length > 0
  } catch {
    used = false
  }
  if ((code || process.exitCode) && used) {
    console.log(`data dir kept for inspection: ${DATA_DIR}`)
    return
  }
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch {
    /* a file the app still holds; the OS temp cleaner gets it */
  }
})

/** Path of the Electron binary. The `electron` package's main export is that path (electron.exe on Windows). */
export function electronBinary() {
  const require = createRequire(path.join(APP_DIR, 'package.json'))
  const bin = require('electron')
  if (typeof bin !== 'string' || !fs.existsSync(bin)) throw new Error(`Electron binary not found (got ${bin}). Run npm install.`)
  return bin
}

// ---------- Checks ----------

const failures = []

/** Record a check. Failures are collected and reported by `finish()`. */
export function check(ok, what, detail = '') {
  if (ok) log(`PASS ${what}`)
  else {
    failures.push(what)
    log(`FAIL ${what}${detail ? ` -- ${detail}` : ''}`)
  }
  return ok
}

/** Print the summary and set the exit code. */
export function finish(name) {
  if (failures.length) {
    console.log(`\n${name}: ${failures.length} check(s) failed:\n  - ${failures.join('\n  - ')}`)
    process.exitCode = 1
  } else console.log(`\n${name}: all checks passed`)
}

/** For token-spending scripts: print the cost warning and exit unless --yes was passed. */
export function requireYes(name, estimate) {
  console.log(`\n${name} drives REAL agent sessions and spends API tokens (roughly ${estimate}).`)
  if (!process.argv.includes('--yes')) {
    console.log('Re-run with --yes to proceed.\n')
    process.exit(2)
  }
  console.log('--yes given; proceeding.\n')
}

// ---------- Fixture repository ----------

const GIT_ID = ['-c', 'user.name=OrgAI E2E', '-c', 'user.email=e2e@orgai.local']

export function git(cwd, args) {
  return execFileSync('git', [...GIT_ID, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/** Like git() but returns `ERR …` instead of throwing; for diagnostics. */
export function gitSafe(cwd, args) {
  try {
    return git(cwd, args)
  } catch (e) {
    return `ERR ${String(e.message).split('\n')[0]}`
  }
}

export function writeFile(root, rel, content) {
  const full = path.join(root, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content, 'utf8')
}

/**
 * A tiny Express notes API in a fresh git repo under os.tmpdir(). Dependencies are not installed.
 * Returns the absolute path (Windows separators on Windows, which is what users type into the form).
 */
export function makeFixtureRepo(tag = 'fixture', { initGit = true, at } = {}) {
  if (at) fs.mkdirSync(at, { recursive: true })
  const root = at ?? fs.mkdtempSync(path.join(TMP, `orgai-e2e-${tag}-`))
  writeFile(
    root,
    'package.json',
    JSON.stringify(
      {
        name: 'tiny-notes-api',
        version: '0.1.0',
        type: 'module',
        scripts: { start: 'node src/server.js', test: 'node --test test/*.test.js' },
        dependencies: { express: '^4.19.2' }
      },
      null,
      2
    ) + '\n'
  )
  writeFile(root, 'README.md', '# tiny-notes-api\n\nA small Express API for storing notes in memory. Used as an OrgAI e2e fixture.\n\n- `npm start` runs the server on port 3000\n- `npm test` runs node\'s built-in test runner\n')
  writeFile(root, '.gitignore', 'node_modules/\n')
  writeFile(
    root,
    'src/server.js',
    `import express from 'express'
import { createStore } from './store.js'

const app = express()
app.use(express.json())
const store = createStore()

app.get('/notes', (_req, res) => res.json(store.list()))
app.post('/notes', (req, res) => {
  const note = store.add(String(req.body?.text ?? ''))
  res.status(201).json(note)
})

app.listen(3000, () => console.log('listening on 3000'))
`
  )
  writeFile(
    root,
    'src/store.js',
    `export function createStore() {
  const notes = []
  return {
    list: () => notes.slice(),
    add: (text) => {
      const note = { id: notes.length + 1, text, createdAt: new Date().toISOString() }
      notes.push(note)
      return note
    }
  }
}
`
  )
  writeFile(
    root,
    'test/store.test.js',
    `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../src/store.js'

test('adds and lists notes', () => {
  const s = createStore()
  s.add('hello')
  assert.equal(s.list().length, 1)
})
`
  )
  if (initGit) {
    git(root, ['init', '-q', '-b', 'main'])
    // The app's own git calls (merges) run without -c; give the repo an identity.
    git(root, ['config', 'user.name', 'OrgAI E2E'])
    git(root, ['config', 'user.email', 'e2e@orgai.local'])
    git(root, ['config', 'core.autocrlf', 'false'])
    git(root, ['add', '-A'])
    git(root, ['commit', '-q', '-m', 'initial notes api'])
  }
  return root
}

export function removeFixture(root) {
  if (!root || !root.startsWith(TMP)) return
  try {
    if (fs.existsSync(path.join(root, '.git'))) gitSafe(root, ['worktree', 'prune'])
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  } catch (e) {
    log('could not remove fixture', root, e.message)
  }
}

// ---------- App ----------

/**
 * Launch the built app and wait until the renderer is up. Returns { app, page, shot }.
 * Dialogs (confirm()) are accepted automatically; renderer console errors are logged.
 */
export async function launch({ shotPrefix = 'shot' } = {}) {
  if (!fs.existsSync(path.join(APP_DIR, 'out', 'main', 'index.js'))) throw new Error('out/main/index.js missing. Run `npm run build` first.')
  fs.mkdirSync(SHOTS_DIR, { recursive: true })
  // process.env is read here, so flags a script sets before launching (ORGAI_MOCK=1) still reach the app.
  const app = await electron.launch({ executablePath: electronBinary(), args: [APP_DIR], cwd: APP_DIR, timeout: 60_000, env: { ...process.env, ORGAI_DATA_DIR: DATA_DIR } })
  const page = await app.firstWindow()
  page.on('dialog', (d) => {
    log('dialog:', d.message().slice(0, 100))
    void d.accept()
  })
  page.on('console', (m) => {
    if (m.type() === 'error') log('console.error:', m.text().slice(0, 200))
  })
  page.on('pageerror', (e) => log('pageerror:', e.message.slice(0, 200)))
  await page.waitForSelector('.sidebar', { timeout: 60_000 })
  await page.waitForSelector('form.card, .live, .editor', { timeout: 60_000 })
  let n = 0
  const shot = (name) => screenshot(page, `${shotPrefix}-${String(++n).padStart(2, '0')}-${name}`)
  return { app, page, shot }
}

export async function screenshot(page, name) {
  fs.mkdirSync(SHOTS_DIR, { recursive: true })
  const file = path.join(SHOTS_DIR, `${name}.png`)
  await page.screenshot({ path: file })
  log('shot', path.relative(APP_DIR, file))
  return file
}

export async function gotoProjects(page) {
  await page.locator('.sidebar .nav-item', { hasText: 'Projects' }).first().click()
  // With no projects the form is open; otherwise it sits behind the topbar "New project" button.
  await page.waitForSelector('form.card, [data-testid=new-project], .project-card', { timeout: 10_000 })
}

/** Open the new-project form if it is closed. Returns the form locator. */
async function openProjectForm(page) {
  const form = page.locator('form.card')
  if (!(await form.count())) await page.locator('[data-testid=new-project]').click()
  await form.waitFor({ timeout: 10_000 })
  return form
}

/**
 * Create a project through the New project form.
 * mode: 'existing' (repository folder) or 'new' (idea + folder). skipSetup: tick "Skip AI setup" (token-free).
 * Resolves once the app has navigated away from the projects view.
 */
export async function createProject(page, { mode = 'existing', path: dir, name, brief = '', skipSetup = true, useMock = true }) {
  await gotoProjects(page)
  const form = await openProjectForm(page)
  await form.getByRole('radio', { name: mode === 'new' ? 'New idea' : 'Existing repository', exact: true }).check({ force: true })
  if (mode === 'new') {
    await form.locator('input[placeholder="My app"]').fill(name)
    await form.locator('textarea').first().fill(brief)
    await form.locator('input[placeholder*="new-folder"]').fill(dir)
  } else {
    await form.locator('input[placeholder*="repo"]').fill(dir)
    await form.locator('input[placeholder*="Defaults to the folder name"]').fill(name)
    if (brief) await form.locator('textarea').first().fill(brief)
  }
  // "Set up with the Architect" has the inverse meaning of skipSetup (checked = run setup).
  const box = form.locator('[data-testid=architect-setup]')
  if ((await box.isChecked()) === skipSetup) await form.locator('label.checkbox', { hasText: 'Set up with the Architect' }).click()
  if ((await box.isChecked()) === skipSetup) throw new Error('could not toggle "Set up with the Architect"')
  // The mock checkbox only exists under ORGAI_MOCK=1 and is on by default; useMock: false saves the project with the real adapter.
  const mock = form.locator('[data-testid=use-mock]')
  if ((await mock.count()) && (await mock.isChecked()) !== useMock) await form.locator('label.checkbox', { hasText: 'Use the mock adapter' }).click()
  await form.getByRole('button', { name: skipSetup ? 'Create project' : 'Create and start setup' }).click()
  // The projects view (and its form) goes away once the project exists and the app navigates to it.
  await page.waitForSelector('form.card, [data-testid=new-project]', { state: 'detached', timeout: 120_000 })
  return await findProject(page, name)
}

/** The project as the main process stores it, looked up by name. */
export async function findProject(page, name) {
  const list = await page.evaluate(() => window.orgai.projects.list())
  return list.find((p) => p.name === name)
}

/** Open a project from the sidebar. */
export async function openProject(page, name) {
  await page.locator('.sidebar .nav-item', { hasText: name }).first().click()
  await page.waitForSelector('form.card, [data-testid=new-project]', { state: 'detached', timeout: 10_000 })
}

/** Delete every project card with this name. Returns how many cards remain (0 on success). */
export async function deleteProject(page, name) {
  await gotoProjects(page)
  for (let i = 0; i < 5; i++) {
    const card = page.locator('.project-card', { hasText: name }).first()
    if (!(await card.count())) break
    await card.getByRole('button', { name: 'Delete', exact: true }).click()
    await page.getByRole('button', { name: 'Delete project', exact: true }).click()
    await sleep(700)
  }
  return page.locator('.project-card', { hasText: name }).count()
}

/** End a live session if the button is there. */
export async function endSession(page) {
  const end = page.getByRole('button', { name: 'End session' })
  if (await end.count()) {
    await end.click()
    await sleep(1500)
  }
}

/** Best-effort cleanup for a finally block: delete the project and close the app. */
export async function cleanup(app, page, name) {
  try {
    if (page && !page.isClosed()) {
      await endSession(page).catch(() => {})
      const left = await deleteProject(page, name)
      check(left === 0, `project "${name}" deleted`, `${left} card(s) left`)
    }
  } catch (e) {
    check(false, `project "${name}" deleted`, e.message)
  }
  await app?.close().catch(() => {})
}

// ---------- Token-spending helpers ----------

/**
 * Drive a setup session until the project's setup is complete (or the deadline passes).
 * decide(kind, proposal) returns 'approve' or a feedback string to request changes.
 * Nudges the Architect when it waits on a question. Returns { done, approved }.
 */
export async function driveSetup(page, name, { deadlineMs = 12 * 60_000, decide = () => 'approve', shot } = {}) {
  const started = Date.now()
  const approved = []
  let nudges = 0
  let lastNudge = 0
  while (Date.now() - started < deadlineMs) {
    const proposal = page.locator('.proposal').first()
    if (await proposal.count()) {
      const kind = (await proposal.getAttribute('class')).match(/kind-(\w+)/)?.[1]
      const title = await proposal.locator('.proposal-head strong').innerText().catch(() => '')
      log(`proposal [${kind}] "${title}"`)
      if (shot) await shot(`proposal-${kind}`)
      const verdict = decide(kind, proposal)
      if (verdict === 'approve') {
        await proposal.getByRole('button', { name: 'Approve' }).click()
        approved.push(kind)
        log('approved', kind)
      } else {
        await proposal.getByRole('button', { name: 'Request changes' }).click()
        await proposal.locator('textarea').fill(verdict)
        await proposal.getByRole('button', { name: 'Send feedback' }).click()
        log('requested changes on', kind)
      }
      await sleep(2500)
      continue
    }
    const p = await findProject(page, name)
    if (p?.setup?.state === 'complete') return { done: true, approved }

    const activity = await page.locator('.agent-node .activity').first().innerText().catch(() => '')
    if (/Waiting for you/i.test(activity) && Date.now() - lastNudge > 25_000 && nudges < 4) {
      nudges++
      lastNudge = Date.now()
      const last = await page.locator('.transcript .entry.text').last().innerText().catch(() => '')
      log('architect says:', last.replace(/\s+/g, ' ').slice(0, 300))
      const ta = page.locator('.composer textarea')
      await ta.fill('Proceed with your best judgment. No further questions needed; propose when ready.')
      await ta.press('Enter')
      log('nudged')
    }
    const status = await page.locator('.topbar .pill .dot').first().locator('..').innerText().catch(() => '')
    if (/finished|error/.test(status) && !(await page.locator('.proposal').count())) {
      log('run ended early, status:', status)
      break
    }
    await sleep(3000)
  }
  return { done: false, approved }
}

/** Directory holding per-run record files: <userData>/data/runs, where userData is the ORGAI_DATA_DIR the app got. */
export function runRecordsDir() {
  return path.join(DATA_DIR, 'data', 'runs')
}
