// Renders the Factory Floor settings sample PNGs from the REAL scene (docs/design/factory-floor.md section 6.6, slice 6).
// RUN BY HAND, never in CI (it needs a GPU and takes about a minute):
//
//   npm run build                                   # the script drives the built app in out/
//   node scripts/render-factory-sample.mjs          # writes sample-dark.png and sample-light.png
//   node scripts/render-factory-sample.mjs --out some/dir --ppm 15 --target 8,10 --labels
//
// Method. Token-free: ORGAI_MOCK=1, a throwaway ORGAI_DATA_DIR (e2e/lib.mjs), a mock script that spawns the section 3.3
// five-agent team and sets the states of FactorySample.tsx: Orchestrator (booth, Running), Architect (lead, Running),
// Reviewer (lead, Idle), Developer (under Architect, Needs you), Tester (under Reviewer, Finished). The app runs on the
// machine's GPU (E2E_FACTORY_SWGL=1 forces SwiftShader instead). Pause motion is pressed so the frame is a static end
// state (no ambient loop phase). Then the window zoom factor is set to 2 and the Factory Floor stage is pinned to the top
// left corner of the window as a 480 x 260 CSS px box (everything else hidden), so the engine lays the scene out in a real
// 480 x 260 stage and the labels have their real CSS size. The camera is driven only by the scene's own keys (0 fit, + zoom,
// Shift+Arrow pan) until the view reads the wanted ppm and target. The stage is cropped with webContents.capturePage, which
// returns device pixels: 960 x 520 at the zoom factor 2. Note the engine caps its pixel ratio at 1.5 (section 9.1), so the
// WebGL canvas holds 720 x 390 pixels and the browser scales it to 960 x 520; DOM labels are drawn at the full 960 x 520.
// The default frame is the scene's own Fit (the whole 30 x 32 m hall: ppm about 8.7, the far band, so the robots are the
// far capsules). The DOM labels are left out by default: at 480 px wide the five nameplates cover the stations, and the
// sample is a picture (alt ""), not a readable view. The controls, floor log and focus rings are always hidden.
//
// Options: --out DIR, --ppm N (zoom in steps of 1.25 from Fit, default Fit) with --target X,Z (floor point at the centre,
// moved in 4 m steps), --labels (nameplates on), --themes dark,light, --debug (also saves a full-window screenshot per
// theme next to the PNGs).
import * as fs from 'node:fs'
import * as path from 'node:path'
import { _electron as electron } from 'playwright-core'
import { APP_DIR, DATA_DIR, TMP, electronBinary, makeFixtureRepo, createProject, endSession, cleanup, log, sleep } from '../e2e/lib.mjs'

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback
}
const flag = (name) => args.includes(`--${name}`)
const OUT = path.resolve(opt('out', path.join(APP_DIR, 'src/renderer/src/assets/factory')))
const PPM = Number(opt('ppm', '0')) // 0 = Fit
const [TX, TZ] = opt('target', '15,9.5').split(',').map(Number)
const LABELS = flag('labels')
const THEMES = opt('themes', 'dark,light').split(',')
const W = 480
const H = 260
const ZOOM = 2
const SWGL = process.env.E2E_FACTORY_SWGL === '1'

process.env.ORGAI_MOCK = '1'
const NAME = 'Factory sample (orgai render)'
const scriptFile = path.join(fs.mkdtempSync(path.join(TMP, 'orgai-factory-sample-script-')), 'script.json')

/** Section 3.3's five agents. Spawn order is the layout order: leads first, then each lead's report. */
const TEAM = [
  { id: 'architect', slug: 'researcher', name: 'Architect', state: 'thinking' },
  { id: 'reviewer', slug: 'reviewer', name: 'Reviewer', state: 'idle' },
  { id: 'developer', slug: 'implementer', name: 'Developer', parent: 'architect', state: 'waiting' },
  { id: 'tester', slug: 'tester', name: 'Tester', parent: 'reviewer', state: 'done' }
]
fs.writeFileSync(
  scriptFile,
  JSON.stringify({
    delayMs: 250,
    work: [
      ...TEAM.map((a) => ({ type: 'spawn', id: a.id, name: a.id, role: a.slug, description: `Sample ${a.name}`, ...(a.parent ? { parent: a.parent } : {}) })),
      ...TEAM.map((a) => ({ type: 'agentState', agent: a.id, state: a.state, activity: a.state === 'waiting' ? 'Waiting for your approval' : a.state === 'done' ? 'Finished' : undefined })),
      // The root ends in a long tool call (Running, at its console); a stop or End session cuts it short.
      { type: 'tool', name: 'Read', input: { file_path: 'README.md' }, result: 'ok', holdMs: 600_000 }
    ]
  })
)
process.env.ORGAI_MOCK_SCRIPT = scriptFile

fs.mkdirSync(OUT, { recursive: true })
const repo = makeFixtureRepo('factory-sample')
const app = await electron.launch({
  executablePath: electronBinary(),
  args: ['--use-mock-keychain', ...(SWGL ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : []), APP_DIR],
  cwd: APP_DIR,
  timeout: 60_000,
  env: { ...process.env, ORGAI_DATA_DIR: DATA_DIR }
})
const page = await app.firstWindow()
page.on('dialog', (d) => void d.accept())
page.on('pageerror', (e) => log('pageerror:', e.message.slice(0, 200)))
let failed = false
try {
  await page.waitForSelector('.sidebar', { timeout: 60_000 })
  await page.evaluate(() => {
    for (const k of Object.keys(localStorage).filter((x) => x.startsWith('orgai.'))) localStorage.removeItem(k)
  })
  await page.reload()
  await page.waitForSelector('[data-testid=dashboard], .editor', { timeout: 60_000 })

  const setAppearance = async (patch, canvas = {}) => {
    await page.evaluate(
      async ([p, c]) => {
        const info = await window.orgai.settings.get()
        const { dataDir: _d, appVersion: _v, ...s } = info
        await window.orgai.settings.set({ ...s, appearance: { ...s.appearance, ...p, canvas: { ...s.appearance.canvas, ...c } } })
      },
      [patch, canvas]
    )
    await sleep(500)
  }
  const resizeTo = async (w, h) => {
    await app.evaluate(({ BrowserWindow }, [cw, ch]) => BrowserWindow.getAllWindows()[0].setContentSize(cw, ch), [w, h])
    await sleep(500)
  }
  const state = async () => JSON.parse((await page.locator('[data-testid=factory-state]').first().evaluate((el) => el.textContent || el.value || '{}')) || '{}')
  const untilState = async (pred, timeout = 20_000) => {
    const end = Date.now() + timeout
    while (Date.now() < end) {
      const st = await state().catch(() => null)
      if (st && pred(st)) return st
      await sleep(150)
    }
    return null
  }

  // Zoom first: the engine reads devicePixelRatio once when it is created, so the scene must mount at the final zoom.
  await app.evaluate(({ BrowserWindow }, z) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(z), ZOOM)
  await resizeTo(1600, 1000)
  const project = await createProject(page, { mode: 'existing', path: repo, name: NAME })
  if (!project) throw new Error('project not created')
  // Name the roles after the sample team: the nameplates read the role name. Slugs stay, so the mock accepts the spawns.
  await page.evaluate(async (name) => {
    const p = (await window.orgai.projects.list()).find((x) => x.name === name)
    const names = { orchestrator: 'Orchestrator', researcher: 'Architect', reviewer: 'Reviewer', implementer: 'Developer' }
    const roles = p.roles.map((r) => ({ ...r, name: names[r.slug] ?? r.name }))
    const impl = roles.find((r) => r.slug === 'implementer')
    roles.push({ ...impl, id: `${impl.id}-tester`, slug: 'tester', name: 'Tester' })
    await window.orgai.projects.save({ ...p, roles })
  }, NAME)
  await setAppearance({ theme: 'dark' }, { presentation: 'factory-floor' })
  await page.locator(`.sidebar [data-testid=nav-project][data-name="${NAME}"]`).first().click()
  await page.waitForSelector('[data-testid=dashboard]', { state: 'detached', timeout: 10_000 })
  await page.getByRole('tablist', { name: 'Project sections' }).getByRole('tab', { name: /^Live/ }).click()
  const ta = page.locator('.composer textarea')
  await ta.waitFor({ timeout: 10_000 })
  await ta.fill('Factory sample render')
  await page.locator('.composer .btn.primary').click()
  await page.locator('[data-testid=run-meta]').waitFor({ timeout: 15_000 })
  await page.locator('[data-testid=factory-scene]').first().waitFor({ timeout: 20_000 })

  // The five states of FactorySample.tsx, with no cue left in flight.
  // The state lists the booth first, then the stations in layout order (architect, reviewer, developer, tester).
  const want = ['running', 'running', 'off', 'needs-you', 'off']
  const ready = await untilState((s) => s.renderer === 'webgl2' && s.workers.length === 5 && s.cues.length === 0 && s.workers.every((w, i) => want[i] === w.lamp), 40_000)
  if (!ready) throw new Error(`the sample team never stood: ${JSON.stringify((await state()).workers?.map((w) => [w.id, w.lamp, w.statusWord]))}`)
  log('team:', ready.workers.map((w) => `${w.id} ${w.statusWord} (${w.lamp})`).join(', '), '| gpu:', ready.perf?.gpu ?? 'n/a')
  const pause = page.locator('[data-testid=factory-pause-motion]')
  if ((await pause.getAttribute('aria-pressed')) !== 'true') await pause.click()
  await untilState((s) => s.motion === 'paused' || s.workers.every((w) => w.ambient === 'none'), 10_000)

  // Pin the stage as a 480 x 260 box in the corner of the window (already zoomed to 2, see above).
  const style = await page.addStyleTag({
    content: `
      #root { visibility: hidden !important; }
      .factory-scene { visibility: visible !important; position: fixed !important; left: 0 !important; top: 0 !important; width: ${W}px !important; height: ${H}px !important; z-index: 2147483000 !important; }
      .factory-scene [data-testid=factory-controls], .factory-scene [data-testid=factory-log], .factory-scene [data-testid=factory-notice] { display: none !important; }
      /* The mirror stays focusable (the camera keys act on a focused worker) but is invisible and has no focus ring. */
      .factory-scene .factory-mirror, .factory-scene .factory-mirror * { opacity: 0 !important; outline: none !important; box-shadow: none !important; pointer-events: none !important; }
      ${LABELS ? '' : '.factory-scene .factory-labels, .factory-scene [data-testid=factory-nameplate], .factory-scene [data-testid=factory-line-sign], .factory-scene [data-testid=factory-dock], .factory-scene [data-testid=factory-board-label] { display: none !important; }'}
    `
  })
  await sleep(800)
  if (flag('debug')) {
    log(
      'rects',
      JSON.stringify(
        await page.evaluate(() => {
          const r = (sel) => {
            const b = document.querySelector(sel)?.getBoundingClientRect()
            return b && [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)]
          }
          const c = document.querySelector('canvas[data-testid=factory-canvas]')
          return { dpr: window.devicePixelRatio, inner: [innerWidth, innerHeight], scene: r('.factory-scene'), stage: r('.factory-stage'), canvas: r('canvas[data-testid=factory-canvas]'), canvasPx: c && [c.width, c.height] }
        })
      )
    )
  }

  // Frame with the scene's own keys. Keys act on a worker button (focus it first); the buttons are hidden after.
  const frame = async () => {
    await page.evaluate(() => document.querySelector('[data-testid=factory-worker]')?.focus())
    await page.keyboard.press('0')
    let st = await untilState((s) => s.view.ppm > 0, 5000)
    const settle = async () => {
      // The test state is written at most twice a second: wait for a write after the move, then for two equal ones.
      let prev = ''
      await sleep(700)
      for (let i = 0; i < 20; i++) {
        await sleep(600)
        const v = (await state()).view
        const k = `${v.ppm.toFixed(3)},${v.targetX.toFixed(3)},${v.targetZ.toFixed(3)}`
        if (k === prev) return v
        prev = k
      }
      return (await state()).view
    }
    let v = await settle()
    for (let i = 0; PPM > 0 && i < 12 && v.ppm < PPM / 1.125; i++) {
      await page.keyboard.press('+')
      v = await settle()
    }
    for (let i = 0; PPM > 0 && i < 12 && v.ppm > PPM * 1.125; i++) {
      await page.keyboard.press('-')
      v = await settle()
    }
    for (let i = 0; PPM > 0 && i < 30; i++) {
      const dx = TX - v.targetX
      const dz = TZ - v.targetZ
      if (Math.abs(dx) < 2 && Math.abs(dz) < 2) break
      const key = Math.abs(dx) >= Math.abs(dz) ? (dx > 0 ? 'Shift+ArrowRight' : 'Shift+ArrowLeft') : dz > 0 ? 'Shift+ArrowDown' : 'Shift+ArrowUp'
      await page.keyboard.press(key)
      v = await settle()
    }
    await page.evaluate(() => document.activeElement?.blur?.())
    await sleep(400)
    st = await state()
    return st.view
  }

  for (const theme of THEMES) {
    // The theme change is made through the settings store; the stage keeps its size and the engine recolours in place.
    await setAppearance({ theme })
    await untilState((s) => s.cues.length === 0, 5000)
    await sleep(600)
    const view = await frame()
    log(`${theme}: view ppm ${view.ppm.toFixed(2)} target ${view.targetX.toFixed(1)},${view.targetZ.toFixed(1)}`)
    const png = await app.evaluate(async ({ BrowserWindow }, rect) => {
      const img = await BrowserWindow.getAllWindows()[0].webContents.capturePage(rect)
      const size = img.getSize()
      return { size, data: img.toPNG().toString('base64') }
    }, { x: 0, y: 0, width: W * ZOOM, height: H * ZOOM })
    const file = path.join(OUT, `sample-${theme}.png`)
    fs.writeFileSync(file, Buffer.from(png.data, 'base64'))
    log(`wrote ${path.relative(APP_DIR, file)} ${png.size.width}x${png.size.height} px, ${fs.statSync(file).size} bytes`)
    if (png.size.width !== W * ZOOM || png.size.height !== H * ZOOM) log(`WARNING: expected ${W * ZOOM} x ${H * ZOOM}`)
    if (flag('debug')) await page.screenshot({ path: path.join(OUT, `debug-${theme}.png`) })
  }
  await style.evaluate((el) => el.remove())
} catch (e) {
  failed = true
  console.error(e.stack ?? String(e))
} finally {
  await page.evaluate(() => document.querySelectorAll('style').forEach((s) => s.textContent?.includes('2147483000') && s.remove())).catch(() => {})
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1)).catch(() => {})
  await endSession(page).catch(() => {})
  await cleanup(app, page, NAME)
}
process.exitCode = failed ? 1 : 0
