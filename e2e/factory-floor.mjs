// Factory Floor, slice 1 (docs/design/factory-floor.md sections 6.6, 7.1, 8, 10.4, 10.5, 12). Token-free: mock adapter, temp data dir.
// Checks: the presentation choice in App settings, the scene mounting in Live (Team keeps the Graph: Factory Floor is
// Live only by owner decision 2026-11-19), the renderer it picked (the script
// passes on either path: 'webgl2' or 'floor-plan'), the developer key that forces the floor plan or the section 8 notices,
// "Use Graph", both themes, both window sizes with no page scroll, zero CSP violations, the mirror group and the hidden
// canvas, and that Pocket Office is still selectable. Slice 2+ checks (layout, stations, cues) are not here.
//
// Software WebGL: this launch (and only this one) adds Chromium's SwiftShader switches so a runner without a GPU still
// takes the 3D path. Measured on Electron here: without them the GPU is used; with them the context reports
// "SwiftShader" and stays webgl2 even with failIfMajorPerformanceCaveat. They are on by default so the 3D path is the same
// everywhere; E2E_FACTORY_SWGL=0 keeps the machine's own GPU. Never added to the product.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { _electron as electron } from 'playwright-core'
import { APP_DIR, DATA_DIR, SHOTS_DIR, TMP, check, cleanup, createProject, electronBinary, endSession, finish, log, makeFixtureRepo, openAppSettings, openProject, openTeam, projectTab, sleep } from './lib.mjs'

process.env.ORGAI_MOCK = '1'
const scriptFile = path.join(fs.mkdtempSync(path.join(TMP, 'orgai-e2e-factory-script-')), 'script.json')
fs.writeFileSync(scriptFile, JSON.stringify({ delayMs: 300 }))
process.env.ORGAI_MOCK_SCRIPT = scriptFile

const NAME = 'E2E factory floor (orgai test)'
const repo = makeFixtureRepo('factory')
const SWGL = process.env.E2E_FACTORY_SWGL !== '0'
const KEY = 'orgai.factory.renderer'

fs.mkdirSync(SHOTS_DIR, { recursive: true })
const app = await electron.launch({
  executablePath: electronBinary(),
  args: ['--use-mock-keychain', ...(SWGL ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : []), APP_DIR],
  cwd: APP_DIR,
  timeout: 60_000,
  env: { ...process.env, ORGAI_DATA_DIR: DATA_DIR }
})
const page = await app.firstWindow()
page.on('dialog', (d) => void d.accept())
page.on('console', (m) => {
  if (m.type() === 'error') log('console.error:', m.text().slice(0, 200))
})
page.on('pageerror', (e) => log('pageerror:', e.message.slice(0, 200)))
// Counts CSP violations from the first script of every document (survives reloads in this page).
await page.addInitScript(() => {
  window.__cspViolations = []
  document.addEventListener('securitypolicyviolation', (e) => window.__cspViolations.push(`${e.violatedDirective} ${e.blockedURI}`))
})
await page.waitForSelector('.sidebar', { timeout: 60_000 })
await page.evaluate(() => {
  for (const k of Object.keys(localStorage).filter((x) => x.startsWith('orgai.'))) localStorage.removeItem(k)
  window.__cspViolations = []
  document.addEventListener('securitypolicyviolation', (e) => window.__cspViolations.push(`${e.violatedDirective} ${e.blockedURI}`))
})
await page.reload()
await page.waitForSelector('[data-testid=dashboard], .editor', { timeout: 60_000 })
let shots = 0
const shot = (name) => page.screenshot({ path: path.join(SHOTS_DIR, `factory-floor-${String(++shots).padStart(2, '0')}-${name}.png`) }).catch(() => {})

const resizeTo = async (w, h) => {
  await app.evaluate(({ BrowserWindow }, [cw, ch]) => BrowserWindow.getAllWindows()[0].setContentSize(cw, ch), [w, h])
  await page.waitForFunction((cw) => Math.abs(window.innerWidth - cw) <= 1, w, { timeout: 10_000 }).catch(() => {})
  await page.evaluate(() => window.dispatchEvent(new Event('resize')))
  await sleep(500)
}
const setAppearance = async (patch, canvas = {}) => {
  await page.evaluate(
    async ([p, c]) => {
      const info = await window.orgai.settings.get()
      const { dataDir: _d, appVersion: _v, ...s } = info
      const a = s.appearance
      await window.orgai.settings.set({ ...s, appearance: { ...a, ...p, canvas: { ...a.canvas, ...c } } })
    },
    [patch, canvas]
  )
  await sleep(450)
}
const setCanvas = (c) => setAppearance({}, c)
const html = (n) => page.evaluate((a) => document.documentElement.getAttribute(a), n)
const noPageScroll = () =>
  page.evaluate(() => {
    const s = document.scrollingElement
    return s.scrollHeight <= s.clientHeight + 1 && s.scrollWidth <= s.clientWidth + 1
  })
const scene = (mode) => page.locator(`[data-testid=factory-scene]${mode ? `[data-mode=${mode}]` : ''}`).first()
const state = async () => JSON.parse((await page.locator('[data-testid=factory-state]').first().evaluate((el) => el.textContent || el.value || '{}')) || '{}')
/** Remount the scene (graph, then back) so the developer key is read again. */
const remount = async () => {
  await setCanvas({ presentation: 'graph' })
  await page.locator('[data-testid=factory-scene]').first().waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {})
  await setCanvas({ presentation: 'factory-floor' })
}
const setKey = (v) => page.evaluate(([k, val]) => (val === null ? localStorage.removeItem(k) : localStorage.setItem(k, val)), [KEY, v])

/** What every mounted scene must satisfy, whichever renderer it picked. Returns the renderer. */
const checkMounted = async (mode, label) => {
  await scene(mode).waitFor({ timeout: 20_000 })
  await page.waitForFunction(() => !!document.querySelector('[data-testid=factory-scene]')?.getAttribute('data-renderer'), null, { timeout: 20_000 })
  const renderer = await scene(mode).getAttribute('data-renderer')
  check(renderer === 'webgl2' || renderer === 'floor-plan', `${label}: scene mounts with a renderer`, String(renderer))
  const st = await state().catch(() => null)
  check(!!st && st.renderer === renderer && st.mode === mode, `${label}: factory-state agrees with the scene`, JSON.stringify(st)?.slice(0, 200))
  const group = page.locator('[data-testid=factory-floor]').first()
  check((await group.count()) === 1 && (await group.getAttribute('role')) === 'group', `${label}: the mirror group exists`)
  check(/^Factory floor,/.test((await group.getAttribute('aria-label')) ?? ''), `${label}: the mirror's name starts "Factory floor,"`, String(await group.getAttribute('aria-label')))
  const canvases = page.locator('[data-testid=factory-canvas]')
  // The 3D path mounts its canvas once the lazy chunk has loaded, after data-renderer is set.
  if (renderer === 'webgl2') await canvases.first().waitFor({ state: 'attached', timeout: 15_000 }).catch(() => {})
  if (await canvases.count()) {
    check((await canvases.first().getAttribute('aria-hidden')) === 'true', `${label}: the canvas is aria-hidden`)
    check(renderer === 'webgl2', `${label}: a canvas appears only on the 3D path`)
  } else check(renderer === 'floor-plan', `${label}: no canvas means the floor plan`)
  return renderer
}

let projectOpen = false
try {
  await resizeTo(1024, 640)
  const project = await createProject(page, { mode: 'existing', path: repo, name: NAME })
  check(!!project, 'project created on the mock adapter')

  // ---------- Settings: choose Factory Floor ----------
  await openAppSettings(page)
  const section = page.locator('[data-testid=canvas-section]')
  await section.waitFor({ timeout: 10_000 })
  const radio = section.locator('[data-testid=canvas-presentation-factory-floor]')
  check((await radio.count()) === 1, 'settings offer the Factory Floor presentation')
  await radio.check({ force: true })
  await page.waitForFunction(() => document.documentElement.dataset.canvasPresentation === 'factory-floor', null, { timeout: 10_000 }).catch(() => {})
  check((await html('data-canvas-presentation')) === 'factory-floor', 'choosing Factory Floor sets the presentation')
  const saved = await page.evaluate(async () => (await window.orgai.settings.get()).appearance.canvas.presentation)
  check(saved === 'factory-floor', 'the presentation is saved in settings', String(saved))

  // ---------- Factory Floor is Live only (owner decision 2026-11-19): Team keeps the Graph ----------
  await openProject(page, NAME)
  projectOpen = true
  await openTeam(page)
  await page.locator('.react-flow').first().waitFor({ timeout: 15_000 }).catch(() => {})
  check((await page.locator('.react-flow').count()) > 0, 'Team shows the Graph while Factory Floor is chosen')
  check((await page.locator('[data-testid=factory-scene]').count()) === 0, 'Team never mounts the factory scene')
  await shot('team-graph')

  await projectTab(page, 'Live').click()
  const ta = page.locator('.composer textarea')
  await ta.waitFor({ timeout: 10_000 })
  await ta.fill('Factory floor check build')
  await page.locator('.composer .btn.primary').click()
  await page.locator('[data-testid=run-meta]').waitFor({ timeout: 15_000 })
  const liveRenderer = await checkMounted('live', 'Live')
  const liveName = await page.locator('[data-testid=factory-floor]').first().getAttribute('aria-label')
  check(/^Factory floor, \d+ workers?$/.test(liveName ?? ''), 'Live: the mirror says workers', String(liveName))
  await shot('live')
  log('live renderer:', liveRenderer, 'gpu:', (await state().catch(() => ({}))).perf?.gpu)

  // ---------- Both themes and both sizes (Live) ----------
  for (const [w, h] of [[1024, 640], [1600, 1000]]) {
    await resizeTo(w, h)
    for (const theme of ['dark', 'light']) {
      await setAppearance({ theme })
      for (const mode of ['live']) {
        await scene(mode).waitFor({ timeout: 15_000 })
        const st = await state().catch(() => null)
        check(!!st && ['webgl2', 'floor-plan'].includes(st.renderer), `${mode} scene state readable at ${w}x${h} ${theme}`)
        if (st?.renderer === 'webgl2') check(st.engines === 1, `theme switch keeps one engine at ${w}x${h} ${theme} (${mode})`, String(st.engines))
        check(await noPageScroll(), `${mode} has no page scroll at ${w}x${h} ${theme}`)
        await shot(`${mode}-${w}x${h}-${theme}`)
      }
    }
  }
  await resizeTo(1024, 640)
  await setAppearance({ theme: 'dark' })

  // ---------- Forced floor plan, notices, Use Graph (Live scene, reads the key at mount) ----------
  await setKey('floor-plan')
  await remount()
  await scene('live').waitFor({ timeout: 15_000 })
  await page.waitForFunction(() => document.querySelector('[data-testid=factory-scene]')?.getAttribute('data-renderer') === 'floor-plan', null, { timeout: 10_000 }).catch(() => {})
  check((await scene('live').getAttribute('data-renderer')) === 'floor-plan', 'the developer key forces the floor plan')
  check((await scene('live').getAttribute('data-reason')) === 'forced', 'the forced floor plan reports reason forced')
  const forced = await state()
  check(forced.renderer === 'floor-plan' && forced.reason === 'forced', 'factory-state reports floor-plan / forced', JSON.stringify(forced).slice(0, 160))
  check((await page.locator('[data-testid=factory-canvas]').count()) === 0, 'the forced floor plan has no canvas')
  check((await page.locator('[data-testid=factory-notice]').count()) === 0, 'the forced floor plan shows no notice')
  check((await page.locator('[data-testid=factory-floor]').count()) === 1, 'the floor plan keeps the mirror group')
  check(await noPageScroll(), 'forced floor plan has no page scroll at 1024x640')
  await shot('forced-floor-plan')

  for (const [value, notice, retry] of [['no-webgl2', 'no-webgl2', false], ['chunk-failed', 'chunk-failed', true]]) {
    await setKey(value)
    await remount()
    await scene('live').waitFor({ timeout: 15_000 })
    await page.locator('[data-testid=factory-notice]').first().waitFor({ timeout: 15_000 }).catch(() => {})
    const n = page.locator('[data-testid=factory-notice]').first()
    check((await n.count()) === 1 && (await n.getAttribute('data-notice')) === notice, `${value}: the ${notice} notice shows`, String(await n.getAttribute('data-notice').catch(() => null)))
    check((await scene('live').getAttribute('data-renderer')) === 'floor-plan' && (await scene('live').getAttribute('data-reason')) === value, `${value}: the floor plan shows with reason ${value}`)
    check((await page.locator('[data-testid=factory-use-graph]').count()) === 1, `${value}: Use Graph is offered`)
    if (retry) {
      check((await page.locator('[data-testid=factory-retry-3d]').count()) === 1, 'chunk-failed: Try 3D again is offered')
      await page.locator('[data-testid=factory-retry-3d]').click()
      await sleep(600)
      check((await page.locator('[data-testid=factory-notice]').count()) === 1, 'chunk-failed: Try 3D again fails again while the key is set')
    }
    await shot(`notice-${value}`)
  }

  // Use Graph returns to the graph canvas.
  await page.locator('[data-testid=factory-use-graph]').click()
  await page.waitForFunction(() => document.documentElement.dataset.canvasPresentation === 'graph', null, { timeout: 10_000 }).catch(() => {})
  check((await html('data-canvas-presentation')) === 'graph', 'Use Graph sets the presentation back to Graph')
  await page.locator('.react-flow').first().waitFor({ timeout: 10_000 }).catch(() => {})
  check((await page.locator('.react-flow').count()) > 0, 'the graph canvas shows after Use Graph')
  check((await page.locator('[data-testid=factory-scene]').count()) === 0, 'the scene is gone after Use Graph')

  // Without the key the real path comes back.
  await setKey(null)
  await setCanvas({ presentation: 'factory-floor' })
  const again = await checkMounted('live', 'Live after clearing the key')
  check(again === liveRenderer, 'the same renderer returns once the key is removed', `${liveRenderer} -> ${again}`)

  // ---------- Pocket Office is still selectable ----------
  await setCanvas({ presentation: 'pocket-office' })
  await page.locator('[data-testid=office-scene]').first().waitFor({ timeout: 15_000 }).catch(() => {})
  check((await page.locator('[data-testid=office-scene]').count()) > 0, 'Pocket Office still mounts afterwards')
  check((await page.locator('[data-testid=factory-scene]').count()) === 0, 'no factory scene beside Pocket Office')
  await setCanvas({ presentation: 'graph' })

  // ---------- CSP ----------
  const violations = await page.evaluate(() => window.__cspViolations ?? [])
  check(violations.length === 0, 'zero securitypolicyviolation events', violations.slice(0, 3).join(' | '))
} catch (e) {
  check(false, 'factory-floor script ran to the end', e.stack ?? String(e))
  await shot('failure')
} finally {
  await page.evaluate((k) => localStorage.removeItem(k), KEY).catch(() => {})
  if (projectOpen) await endSession(page).catch(() => {})
  await cleanup(app, page, NAME)
}
finish('factory-floor')
