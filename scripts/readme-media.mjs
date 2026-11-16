// Captures the README media (docs/media/*.gif and *.png) from the BUILT app on the mock adapter. Token-free: ORGAI_MOCK=1,
// a fresh temp data dir, no provider, no network. Run `npm run media:readme` (it builds first, `--no-build` skips that).
//
// How: Playwright's Electron launcher drives the app the way e2e/lib.mjs does. Frames are grabbed in the main process
// with webContents.capturePage(), downscaled to 960 px wide by Electron, and encoded with gifenc (pure JS, one global
// palette, unchanged pixels transparent so static UI costs almost nothing). Stills are plain page screenshots.
// Projects live in a neutral folder at the drive root (C:\orgai-media or /tmp/orgai-media), so no home path or user name
// shows in a picture. A fake cursor (an overlay div, nothing from the app) shows where the clicks land.
//
// Options: --only=hero,chat (scene names), --no-build, --keep (leave the working folder).
import { execFileSync, spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import gifenc from 'gifenc'
import { APP_DIR, DATA_DIR, check, finish, findProject, git, gotoProjects, launch, log, makeFixtureRepo, openProject, openProjectForm, sleep, writeFile } from '../e2e/lib.mjs'

process.env.ORGAI_MOCK = '1'
for (const k of ['ORGAI_MOCK_GH', 'ORGAI_MOCK_GIT', 'ORGAI_MOCK_SCRIPT']) delete process.env[k]

const { GIFEncoder, applyPalette, quantize } = gifenc

const OUT = path.join(APP_DIR, 'docs', 'media')
const args = process.argv.slice(2)
const only = (args.find((a) => a.startsWith('--only=')) ?? '').slice(7).split(',').filter(Boolean)
const wanted = (name) => only.length === 0 || only.includes(name)

// --dump writes every 8th captured frame as a PNG under <working folder>/frames, for looking at the timing.
const DUMP = args.includes('--dump')
let currentScene = ''
const GIF_WIDTH = 960
const FRAME_MS = 100
const GIF_MAX_BYTES = 4 * 1024 * 1024
const WIN_W = 1440
const WIN_H = 900

if (!args.includes('--no-build')) {
  log('building')
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], { cwd: APP_DIR, stdio: 'inherit', shell: process.platform === 'win32' })
}

// A neutral working folder: no user name in any path a picture can show.
const ROOT = process.platform === 'win32' ? path.join(path.parse(os.tmpdir()).root, 'orgai-media') : '/tmp/orgai-media'
if (fs.existsSync(ROOT) && !fs.existsSync(path.join(ROOT, '.orgai-media'))) {
  console.error(`${ROOT} exists and was not made by this script; move it away first.`)
  process.exit(1)
}
fs.rmSync(ROOT, { recursive: true, force: true })
fs.mkdirSync(OUT, { recursive: true })
fs.mkdirSync(ROOT, { recursive: true })
fs.writeFileSync(path.join(ROOT, '.orgai-media'), 'made by scripts/readme-media.mjs')
const DUMP_DIR = path.join(ROOT, 'frames')
if (DUMP) fs.mkdirSync(DUMP_DIR, { recursive: true })
const CLONES = path.join(ROOT, 'clones')
fs.mkdirSync(CLONES, { recursive: true })

/** A fixture repo named like a real project, committed. */
function repo(name, title) {
  const dir = path.join(ROOT, name)
  makeFixtureRepo(name, { at: dir })
  writeFile(dir, 'package.json', JSON.stringify({ name, version: '0.1.0', type: 'module', scripts: { start: 'node src/server.js', test: 'node --test test/*.test.js' } }, null, 2) + '\n')
  writeFile(dir, 'README.md', `# ${title}\n\nA small service. Used for the OrgAI README media.\n`)
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', 'name the project'])
  return dir
}

// The mock script file is read per run; `{}` means the default. The office scene writes its own and restores this.
const MOCK_SCRIPT = path.join(ROOT, 'mock-script.json')
fs.writeFileSync(MOCK_SCRIPT, '{}')
process.env.ORGAI_MOCK_SCRIPT = MOCK_SCRIPT

const { app, page } = await launch({ shotPrefix: 'readme-media' })
page.setDefaultTimeout(15_000)

// ---------- Window, theme, cursor ----------

async function setSize(w, h) {
  await app.evaluate(({ BrowserWindow }, [cw, ch]) => BrowserWindow.getAllWindows()[0].setContentSize(cw, ch), [w, h])
  await page.waitForFunction((cw) => Math.abs(window.innerWidth - cw) <= 1, w, { timeout: 10_000 }).catch(() => {})
  await page.evaluate(() => window.dispatchEvent(new Event('resize')))
  await sleep(500)
}
async function setTheme(theme) {
  await page.evaluate(async (t) => {
    const s = await window.orgai.settings.get()
    await window.orgai.settings.set({ ...s, appearance: { ...s.appearance, theme: t } })
  }, theme)
  await sleep(500)
}
async function installCursor() {
  await page.evaluate(() => {
    if (document.getElementById('media-cursor')) return
    const style = document.createElement('style')
    style.textContent = '@keyframes media-ripple{from{transform:scale(.3);opacity:.9}to{transform:scale(1.6);opacity:0}}'
    document.head.appendChild(style)
    const cur = document.createElement('div')
    cur.id = 'media-cursor'
    cur.style.cssText = 'position:fixed;left:0;top:0;width:20px;height:20px;z-index:2147483647;pointer-events:none;display:none'
    cur.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24"><path d="M3 2l7 19 3-8 8-3z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>'
    document.body.appendChild(cur)
    addEventListener('mousemove', (e) => {
      cur.style.display = 'block'
      cur.style.transform = `translate(${e.clientX - 3}px,${e.clientY - 2}px)`
    }, true)
    addEventListener('mousedown', (e) => {
      const r = document.createElement('div')
      r.style.cssText = `position:fixed;left:${e.clientX - 16}px;top:${e.clientY - 16}px;width:32px;height:32px;border-radius:50%;border:2px solid #4da3ff;z-index:2147483646;pointer-events:none;animation:media-ripple .45s ease-out forwards`
      document.body.appendChild(r)
      setTimeout(() => r.remove(), 500)
    }, true)
  })
}

let mouse = { x: 720, y: 450 }
/** Glide the cursor to the centre of a locator in small steps (so frames show it travelling), then click it. */
async function click(loc, { force = false } = {}) {
  await loc.scrollIntoViewIfNeeded().catch(() => {})
  const box = await loc.boundingBox()
  if (box) {
    const tx = box.x + box.width / 2
    const ty = box.y + box.height / 2
    const n = 7
    for (let i = 1; i <= n; i++) {
      const e = i / n
      const k = e * e * (3 - 2 * e)
      await page.mouse.move(mouse.x + (tx - mouse.x) * k, mouse.y + (ty - mouse.y) * k)
      await sleep(30)
    }
    mouse = { x: tx, y: ty }
    await sleep(120)
  }
  await loc.click({ force })
}
/** Type like a person, slowly enough to read in a GIF. */
async function type(loc, text, delay = 28) {
  await click(loc)
  await loc.fill('')
  await loc.pressSequentially(text, { delay })
}
const hold = (ms) => sleep(ms)

// ---------- Recording and encoding ----------

function recorder() {
  let running = false
  const frames = []
  let loop
  const grab = () =>
    app.evaluate(async ({ BrowserWindow }, [w, png]) => {
      const win = BrowserWindow.getAllWindows()[0]
      const img = (await win.webContents.capturePage()).resize({ width: w, quality: 'best' })
      const { width, height } = img.getSize()
      return { width, height, b64: img.toBitmap().toString('base64'), png: png ? img.toPNG().toString('base64') : null }
    }, [GIF_WIDTH, DUMP && frames.length % 8 === 0])
  return {
    start() {
      running = true
      loop = (async () => {
        while (running) {
          const t0 = Date.now()
          try {
            const f = await grab()
            if (f.png) fs.writeFileSync(path.join(DUMP_DIR, `${currentScene}-${String(frames.length).padStart(3, '0')}.png`), Buffer.from(f.png, 'base64'))
            const bgra = Buffer.from(f.b64, 'base64')
            const rgba = new Uint8Array(bgra.length)
            for (let i = 0; i < bgra.length; i += 4) {
              rgba[i] = bgra[i + 2]
              rgba[i + 1] = bgra[i + 1]
              rgba[i + 2] = bgra[i]
              rgba[i + 3] = 255
            }
            frames.push({ t: t0, width: f.width, height: f.height, rgba })
          } catch (e) {
            log('frame skipped:', String(e.message).slice(0, 80))
          }
          const rest = FRAME_MS - (Date.now() - t0)
          if (rest > 0) await sleep(rest)
        }
      })()
    },
    async stop() {
      running = false
      await loop
      return frames
    }
  }
}

const sameFrame = (a, b) => Buffer.compare(Buffer.from(a.buffer, a.byteOffset, a.length), Buffer.from(b.buffer, b.byteOffset, b.length)) === 0

/** Encode frames to a GIF buffer. `step` keeps every nth frame (delays are merged). */
function encodeGif(frames, { step = 1, lastHoldMs = 1200, maxColors = 255 } = {}) {
  const kept = frames.filter((_, i) => i % step === 0 || i === frames.length - 1)
  // Merge identical neighbours into one longer frame.
  const merged = []
  for (let i = 0; i < kept.length; i++) {
    const f = kept[i]
    const next = kept[i + 1]
    const delay = Math.min(3000, next ? Math.max(20, next.t - f.t) : lastHoldMs)
    const prev = merged[merged.length - 1]
    if (prev && sameFrame(prev.rgba, f.rgba)) prev.delay += delay
    else merged.push({ rgba: f.rgba, width: f.width, height: f.height, delay })
  }
  // One palette for the whole clip, from a sparse sample of every few frames.
  const picks = merged.filter((_, i) => i % Math.max(1, Math.floor(merged.length / 12)) === 0)
  const sample = new Uint8Array(picks.reduce((n, f) => n + Math.ceil(f.rgba.length / 4 / 5) * 4, 0))
  let o = 0
  for (const f of picks) for (let p = 0; p < f.rgba.length; p += 20) sample.set(f.rgba.subarray(p, p + 4), (o += 4) - 4)
  const palette = quantize(sample.subarray(0, o), maxColors, { format: 'rgb444' })
  const full = palette.slice()
  while (full.length < 256) full.push([0, 0, 0])
  const TRANSPARENT = 255
  const gif = GIFEncoder()
  let prevIdx = null
  for (const f of merged) {
    const idx = applyPalette(f.rgba, palette, 'rgb444')
    const out = prevIdx ? new Uint8Array(idx) : idx
    if (prevIdx) for (let i = 0; i < idx.length; i++) if (idx[i] === prevIdx[i]) out[i] = TRANSPARENT
    gif.writeFrame(out, f.width, f.height, { palette: full, delay: f.delay, transparent: !!prevIdx, transparentIndex: TRANSPARENT, dispose: 1, repeat: 0 })
    prevIdx = idx
  }
  gif.finish()
  return { bytes: Buffer.from(gif.bytes()), seconds: merged.reduce((n, f) => n + f.delay, 0) / 1000, frames: merged.length }
}

const outputs = []
async function saveGif(name, frames) {
  let best
  for (const step of [1, 2, 3]) {
    best = encodeGif(frames, { step })
    if (best.bytes.length <= GIF_MAX_BYTES) break
    log(`${name}.gif is ${(best.bytes.length / 1048576).toFixed(1)} MB at step ${step}; thinning frames`)
  }
  const file = path.join(OUT, `${name}.gif`)
  fs.writeFileSync(file, best.bytes)
  outputs.push(file)
  log(`${name}.gif ${best.frames} frames, ${best.seconds.toFixed(1)} s, ${(best.bytes.length / 1024).toFixed(0)} KB`)
  check(best.bytes.length <= GIF_MAX_BYTES, `${name}.gif is under 4 MB`)
  check(best.seconds >= 8 && best.seconds <= 15, `${name}.gif lasts 8-15 s`, `${best.seconds.toFixed(1)} s`)
}
async function still(name) {
  await page.evaluate(() => {
    const c = document.getElementById('media-cursor')
    if (c) c.style.display = 'none'
  })
  await sleep(150)
  const file = path.join(OUT, `${name}.png`)
  await page.screenshot({ path: file })
  outputs.push(file)
  log(`${name}.png`)
}

// ---------- Helpers shared by scenes ----------

const NAME_HERO = 'acme-billing'
const NAME_SETUP = 'acme-notes'
const NAME_ENG = 'Acme Corp review'

const waitIdle = (ms = 60_000) =>
  page.waitForFunction(() => /Idle|Needs you/.test(document.querySelector('.run-tab[aria-selected=true]')?.textContent ?? ''), null, { timeout: ms }).catch(() => {})

/** The New project form, for a code project from an existing folder (typed, then submitted). */
async function openLive() {
  await page.locator('[data-testid=tab-live]').click().catch(() => {})
  await page.locator('.new-run, [data-testid=run-meta]').first().waitFor()
}
async function startRunTyped(text) {
  if (!(await page.locator('.new-run').count())) {
    await page.keyboard.press('Control+t')
    await page.locator('.new-run').waitFor()
  }
  const ta = page.locator('.composer textarea')
  await type(ta, text)
  await hold(300)
  await click(page.locator('.composer .btn.primary'))
}
async function createCode(name, dir, { setup = false } = {}) {
  await gotoProjects(page)
  const form = await openProjectForm(page)
  await form.locator('[data-testid=project-kind-option][data-kind=code] input[type=radio]').check({ force: true })
  await form.getByRole('radio', { name: 'Existing code', exact: true }).check({ force: true })
  await form.locator('input[placeholder*="repo"]').fill(dir)
  await form.locator('input[placeholder*="Defaults to the folder name"]').fill(name)
  const box = form.locator('[data-testid=architect-setup]')
  if ((await box.isChecked()) !== setup) await form.locator('label.checkbox', { hasText: 'Set up with the Architect' }).click()
  return form
}
async function submitCode(form, setup) {
  await click(form.getByRole('button', { name: setup ? 'Create and start setup' : 'Create project' }))
  await page.waitForSelector('[data-testid=dashboard]', { state: 'detached', timeout: 120_000 })
}

async function ensureProject(name, title) {
  await gotoProjects(page)
  if (await findProject(page, name)) return
  const form = await createCode(name, repo(name, title))
  await submitCode(form, false)
}
async function setCanvasPresentation(presentation) {
  await page.evaluate(async (p) => {
    const { dataDir: _d, appVersion: _v, ...s } = await window.orgai.settings.get()
    await window.orgai.settings.set({ ...s, appearance: { ...s.appearance, canvas: { ...s.appearance.canvas, presentation: p, scenePalette: 'color' } } })
  }, presentation)
  await sleep(500)
}

// ---------- Scenes ----------

const scenes = {
  // Hero: a work run on a code project; the chart fills in, a permission card appears and is approved.
  async hero() {
    const dir = repo(NAME_HERO, 'Acme Billing')
    const form = await createCode(NAME_HERO, dir)
    await submitCode(form, false)
    check(!!(await findProject(page, NAME_HERO)), 'acme-billing created')
    await openLive()
    await installCursor()
    await sleep(600)
    const rec = recorder()
    rec.start()
    await hold(500)
    await startRunTyped('Add a /health endpoint to the billing service, with a test.')
    const card = page.locator('section.frame-tray article.decision-card[data-kind="permission"]')
    await card.first().waitFor({ timeout: 60_000 })
    await hold(1700)
    await click(card.first().getByRole('button', { name: 'Allow once' }))
    await waitIdle()
    await hold(800)
    const frames = await rec.stop()
    await saveGif('hero', frames)
    await setTheme('light')
    await hold(600)
    await still('hero-light')
    await setTheme('dark')
  },

  // Setup: the Architect proposes the architecture, org chart and settings; each card is approved.
  async setup() {
    const dir = repo(NAME_SETUP, 'Acme Notes')
    const form = await createCode(NAME_SETUP, dir, { setup: true })
    await installCursor()
    const rec = recorder()
    rec.start()
    await hold(800)
    await submitCode(form, true)
    const started = Date.now()
    const kinds = []
    while (Date.now() - started < 90_000) {
      const card = page.locator('article.decision-card').first()
      if (await card.count()) {
        kinds.push(await card.getAttribute('data-kind'))
        await hold(800)
        // Proposals say Approve; the Architect's one shell command is a permission card (Allow once).
        const button = card.getByRole('button', { name: /^(Approve|Allow once)$/ })
        if (await button.count()) await click(button.first())
        await hold(300)
        continue
      }
      const p = await findProject(page, NAME_SETUP)
      if (p?.setup?.state === 'complete') break
      await sleep(250)
    }
    await hold(900)
    // The chart the Architect proposed, in the Team editor.
    await click(page.getByRole('button', { name: 'Open Team' }))
    await page.locator('.editor [data-testid=team-panel-tabs]').waitFor()
    await hold(800)
    const frames = await rec.stop()
    log('setup cards:', kinds.join(', '))
    await saveGif('setup', frames)
    // A fuller chart for the still: the hero project's default team, with one role open.
    await openProject(page, NAME_HERO)
    await page.locator('[data-testid=tab-team]').click()
    await page.locator('.editor [data-testid=team-panel-tabs]').waitFor()
    await page.locator('.react-flow__node', { hasText: 'Orchestrator' }).first().click()
    await sleep(1200)
    await still('team')
  },

  // Chat: the assistant that needs no project.
  async chat() {
    await click(page.locator('[data-testid=nav-assistant][data-id=quick]'))
    const ta = page.locator('[data-testid=assistant-start-quick] .composer textarea')
    await ta.waitFor()
    await installCursor()
    const rec = recorder()
    rec.start()
    await hold(1200)
    await type(ta, 'Which of my projects needs attention first?')
    await hold(400)
    await ta.press('Enter')
    await page.getByText('Your turn. Reply, ask a follow-up, or end the session.').first().waitFor({ timeout: 60_000 })
    await hold(1500)
    const follow = page.locator('.composer textarea').last()
    await type(follow, 'Thanks. Summarise it in one line.')
    await follow.press('Enter')
    await sleep(1800)
    await hold(1500)
    const frames = await rec.stop()
    await saveGif('chat', frames)
  },

  // From GitHub: the third New project segment, cloning a mock repository (local git, no network).
  async clone() {
    await gotoProjects(page)
    const form = await openProjectForm(page)
    await installCursor()
    await form.locator('[data-testid=project-kind-option][data-kind=code] input[type=radio]').check({ force: true })
    const rec = recorder()
    rec.start()
    await hold(900)
    await click(form.locator('label', { hasText: 'From GitHub' }).first())
    const tid = (id) => page.locator(`[data-testid=${id}]`)
    await tid('repo-source').waitFor()
    await type(tid('repo-source'), 'mock-org/with-agents')
    await tid('repo-parent').fill(CLONES)
    await tid('repo-folder').fill('with-agents')
    await hold(1200)
    await click(tid('repo-clone'))
    await tid('repo-cloned-line').waitFor({ timeout: 60_000 })
    await tid('setup-choice').waitFor({ timeout: 10_000 })
    await hold(2600)
    const frames = await rec.stop()
    await saveGif('clone', frames)
    await page.keyboard.press('Escape')
    await sleep(500)
  },

  // Knowledge: an engagement, a recorded run, the tab's list and then the graph.
  async knowledge() {
    const wf = path.join(ROOT, 'acme-review')
    fs.mkdirSync(wf, { recursive: true })
    await gotoProjects(page)
    const form = await openProjectForm(page)
    await form.locator('[data-testid=project-kind-option][data-kind=engagement] input[type=radio]').check({ force: true })
    await form.getByLabel('Name', { exact: true }).fill(NAME_ENG)
    await form.locator('[data-testid=new-project-client]').fill('Acme Corp')
    await form.getByLabel('Working folder', { exact: true }).fill(wf)
    const arch = form.locator('[data-testid=architect-setup]')
    if (await arch.isChecked()) await form.locator('label.checkbox', { hasText: 'Start with the setup interview' }).click()
    await form.getByRole('button', { name: 'Create project', exact: true }).click()
    await page.waitForSelector('[data-testid=dashboard]', { state: 'detached', timeout: 60_000 })
    const eng = await findProject(page, NAME_ENG)
    await page.locator('[data-testid=tab-live]').click().catch(() => {})
    await page.locator('.new-run').waitFor()
    const ta = page.locator('.composer textarea')
    await ta.fill('Summarise the kickoff call [mock:knowledge]')
    await page.locator('.composer .btn.primary').click()
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      const g = await page.evaluate((id) => window.orgai.knowledge.get(id), eng.id)
      if (g.nodes.length >= 4) break
      await sleep(300)
    }
    await waitIdle()
    await installCursor()
    await sleep(600)
    const rec = recorder()
    rec.start()
    await hold(1200)
    await click(page.locator('[data-testid=tab-knowledge]'))
    await page.locator('[data-testid=knowledge-row]').first().waitFor()
    await hold(1800)
    await hold(1200)
    await click(page.locator('[data-testid=knowledge-view-switch] label', { hasText: 'Graph' }).first())
    await page.locator('[data-testid=knowledge-neural]').waitFor()
    await page.waitForFunction(() => document.querySelector('[data-testid=knowledge-neural]')?.getAttribute('data-settled') === 'true', null, { timeout: 30_000 }).catch(() => {})
    await hold(3500)
    const frames = await rec.stop()
    await saveGif('knowledge', frames)
  },

  // Dashboard: projects, with a decision waiting. Start a run on the setup project and leave its card open.
  async dashboard() {
    await openProject(page, NAME_SETUP)
    await page.locator('[data-testid=tab-live]').click().catch(() => {})
    await page.waitForSelector('.composer textarea, .new-run')
    if (!(await page.locator('.new-run').count())) {
      await page.keyboard.press('Control+t')
      await page.locator('.new-run').waitFor()
    }
    await page.locator('.composer textarea').fill('Rename the notes route to /api/notes')
    await page.locator('.composer .btn.primary').click()
    await page.locator('section.frame-tray article.decision-card').first().waitFor({ timeout: 60_000 })
    await gotoProjects(page)
    await page.locator('[data-testid=project-tile]').first().waitFor()
    await sleep(1500)
    await still('dashboard')
  },

  // Office: a mock run in the Pocket Office presentation; reports walk in, work, and message each other.
  async office() {
    const NAME = 'acme-portal'
    await ensureProject(NAME, 'Acme Portal')
    await setCanvasPresentation('pocket-office')
    await setSize(1600, 1000)
    const script = {
      delayMs: 500,
      work: [
        { type: 'spawn', id: 'office-a', name: 'office-a', description: 'Review the portal API' },
        { type: 'spawn', id: 'office-b', name: 'office-b', description: 'Check the tests' },
        { type: 'wait', ms: 1500 },
        { type: 'message', to: 'office-a', text: 'Please review the portal API before we ship it.' },
        { type: 'wait', ms: 3000 },
        { type: 'message', from: 'office-a', to: 'root', text: 'On it.' },
        { type: 'wait', ms: 1500 },
        { type: 'message', to: 'office-b', text: 'Run the full test suite' },
        { type: 'wait', ms: 120_000 }
      ]
    }
    fs.writeFileSync(MOCK_SCRIPT, JSON.stringify(script))
    try {
      await openLive()
      await installCursor()
      const rec = recorder()
      rec.start()
      await hold(600)
      await startRunTyped('Review the portal and check its tests.')
      await page.locator('[data-testid=office-scene]').first().waitFor({ timeout: 20_000 })
      await page.locator('[data-testid=office-bubble]').first().waitFor({ timeout: 40_000 })
      await hold(3200)
      const frames = await rec.stop()
      await saveGif('office', frames)
    } finally {
      await page.evaluate(async () => {
        for (const r of await window.orgai.runs.listLive()) await window.orgai.runs.stop(r.id).catch(() => {})
      })
      fs.writeFileSync(MOCK_SCRIPT, '{}')
      await setCanvasPresentation('graph')
      await setSize(WIN_W, WIN_H)
    }
  },

  // Run settings: the Model, Effort, Permission and Goal chips above the composer, with the Permission picker open.
  async 'run-settings'() {
    const NAME = 'acme-portal'
    await ensureProject(NAME, 'Acme Portal')
    await openProject(page, NAME)
    await openLive()
    if (!(await page.locator('.new-run').count())) {
      await page.keyboard.press('Control+t')
      await page.locator('.new-run').waitFor()
    }
    await page.locator('[data-testid=run-settings]').first().waitFor()
    await page.locator('.composer textarea').fill('Add pagination to the invoices list')
    await sleep(800)
    await page.locator('[data-testid=run-permission-change]').click()
    await page.locator('[data-testid=run-permission-picker]').waitFor({ state: 'visible' })
    await sleep(600)
    await still('run-settings')
    await page.keyboard.press('Escape')
    await page.locator('.composer textarea').fill('')
  }
}

// ---------- Run ----------

try {
  await setSize(WIN_W, WIN_H)
  await setTheme('dark')
  for (const [name, fn] of Object.entries(scenes)) {
    if (!wanted(name)) continue
    log(`--- scene ${name}`)
    currentScene = name
    try {
      await fn()
    } catch (e) {
      check(false, `scene ${name}`, String(e.stack ?? e).split('\n').slice(0, 4).join(' | '))
      await page.screenshot({ path: path.join(ROOT, `failed-${name}.png`) }).catch(() => {})
    }
  }
} finally {
  // End what is still live so the CLI listing below reads Stopped, not "Ended when OrgAI closed".
  await page
    .evaluate(async () => {
      for (const r of await window.orgai.runs.listLive()) await window.orgai.runs.stop(r.id).catch(() => {})
    })
    .catch(() => {})
  await sleep(1500)
  await app.close().catch(() => {})
}

// ---------- CLI text ----------

/**
 * Real output of the CLI against its own fresh temp folder (the CLI shares nothing with the app, so the app's DATA_DIR is
 * never read): one mock exec seeds a project and a run, then the read-only commands print them.
 */
async function cliText() {
  const CLI = path.join(APP_DIR, 'out', 'cli', 'orgai.mjs')
  const CLI_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'orgai-readme-cli-'))
  const run = (a, cwd = ROOT) =>
    new Promise((resolve) => {
      const env = { ...process.env, ORGAI_CLI_DATA_DIR: CLI_DIR, ORGAI_CLI_VAULT_NO_OS_KEYSTORE: '1', ORGAI_MOCK: '1', NO_COLOR: '1' }
      delete env.ORGAI_DATA_DIR
      const child = spawn(process.execPath, ['--disable-sigusr1', CLI, '--no-color', ...a], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      let err = ''
      child.stdout.on('data', (d) => (out += d))
      child.stderr.on('data', (d) => (err += d))
      const t = setTimeout(() => child.kill('SIGKILL'), 60_000)
      child.on('close', (code) => {
        clearTimeout(t)
        resolve({ code, out, err })
      })
    })
  const clean = (s) => s.split(CLI_DIR).join('<data>').split(os.tmpdir()).join('<tmp>').replace(/\r/g, '')
  const parts = []
  const seed = await run(['exec', '--create-project', '--output-format', 'json', '[mock:exec-plan] Add a health endpoint'], path.join(ROOT, NAME_HERO))
  log(`orgai exec (seed) -> exit ${seed.code}`)
  for (const a of [['runs', 'list', '--project', path.join(ROOT, NAME_HERO)], ['projects', 'list']]) {
    const r = await run(a)
    log(`orgai ${a.slice(0, 2).join(' ')} -> exit ${r.code}`)
    if (r.code === 0 && r.out.trim()) parts.push(`$ orgai ${a.slice(0, 2).join(' ')}\n${clean(r.out).trimEnd()}`)
  }
  const file = path.join(OUT, 'cli-output.txt')
  fs.writeFileSync(file, parts.join('\n\n') + '\n')
  outputs.push(file)
  fs.rmSync(CLI_DIR, { recursive: true, force: true, maxRetries: 3 })
}
if (wanted('cli')) await cliText().catch((e) => check(false, 'cli text', String(e.message)))

// ---------- Summary ----------

let total = 0
for (const f of outputs) {
  const size = fs.statSync(f).size
  total += size
  console.log(`${path.relative(APP_DIR, f).replace(/\\/g, '/')}  ${(size / 1024).toFixed(0)} KB`)
}
console.log(`total ${(total / 1048576).toFixed(2)} MB`)
check(total < 15 * 1048576, 'docs/media stays under 15 MB')
if (!args.includes('--keep')) fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
finish('readme-media')
