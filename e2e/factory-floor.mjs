// Factory Floor, slice 1 (docs/design/factory-floor.md sections 6.6, 7.1, 8, 10.4, 10.5, 12). Token-free: mock adapter, temp data dir.
// Checks: the presentation choice in App settings, the scene mounting in Live (Team keeps the Graph: Factory Floor is
// Live only by owner decision 2026-11-19), the renderer it picked (the script
// passes on either path: 'webgl2' or 'floor-plan'), the developer key that forces the floor plan or the section 8 notices,
// "Use Graph", both themes, both window sizes with no page scroll, zero CSP violations, the mirror group and the hidden
// canvas, and that Pocket Office is still selectable. Slice 2 and 3 add layout, stations and live state; slice 4 adds the
// cue checks (section "Slice 4: cues and motion": no replay at mount, capsules, totes, parts and crates for events after
// mount, the caps under a burst, reduced motion and Pause motion, the floor log, idle frames). Gated scripts: see
// docs/agent-notes/core-runtime.md "Factory Floor mock". Slice 6 (hardening) adds: the 40-agent stress with the whole cue burst
// (draw calls, shadow calls, triangles, the label and ambient caps at fit and near zoom), the 20-toggle mount leak check, the
// Large team fallback (121 scripted spawns), the settings sample (static image, no second engine), the CSP count after the 3D
// and the floor-plan sections, and the E2E_FACTORY_PERF=1 mode (asserts the section 9.1 timing targets; run it with
// E2E_FACTORY_SWGL=0 on a real GPU). The "PERF ..." lines at the end print the numbers in every mode.
//
// Software WebGL: this launch (and only this one) adds Chromium's SwiftShader switches so a runner without a GPU still
// takes the 3D path. Measured on Electron here: without them the GPU is used; with them the context reports
// "SwiftShader" and stays webgl2 even with failIfMajorPerformanceCaveat. They are on by default so the 3D path is the same
// everywhere; E2E_FACTORY_SWGL=0 keeps the machine's own GPU. Never added to the product.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { _electron as electron } from 'playwright-core'
import { APP_DIR, DATA_DIR, SHOTS_DIR, TMP, check, cleanup, createProject, electronBinary, endSession as endSessionLib, finish, log, makeFixtureRepo, openAppSettings, openProject, openTeam, projectTab, scaleApp, scalePage, setReduceMotion, sleep, t } from './lib.mjs'
// A run of 40 to 122 agents leaves the renderer busy for many seconds (a normal desktop: about 20 s to end the large team; a
// two-core runner with the renderer throttled three times: over 30 s, the click's default budget). Every click that starts
// or ends such a run waits for the renderer to answer instead of timing out at the default.
const BUSY_CLICK_MS = 150_000
const endSession = (page) => endSessionLib(page, { timeout: BUSY_CLICK_MS })

process.env.ORGAI_MOCK = '1'
const scriptFile = path.join(fs.mkdtempSync(path.join(TMP, 'orgai-e2e-factory-script-')), 'script.json')
fs.writeFileSync(scriptFile, JSON.stringify({ delayMs: 300 }))
process.env.ORGAI_MOCK_SCRIPT = scriptFile

const NAME = 'E2E factory floor (orgai test)'
const repo = makeFixtureRepo('factory')
const SWGL = process.env.E2E_FACTORY_SWGL !== '0'
// E2E_FACTORY_PLAN=1 forces the floor plan for the whole run (the developer key below is set before the first mount), so
// every slice 2 case also runs on the path a runner without WebGL2 (GitHub's macOS) takes. Default: the machine's own path.
const PLAN = process.env.E2E_FACTORY_PLAN === '1'
const KEY = 'orgai.factory.renderer'
// E2E_FACTORY_PERF=1 (local, with E2E_FACTORY_SWGL=0 on a real GPU) asserts the section 9.1 timing targets. Without it the
// timing numbers are only recorded and printed ("PERF ..." lines at the end); the structural ones are always asserted.
const PERF = process.env.E2E_FACTORY_PERF === '1'
/** Numbers for the PERF block (printed at the end of every run). */
const rec = {}
const SOFTWARE_GPU = /swiftshader|llvmpipe|software|basic render/i

fs.mkdirSync(SHOTS_DIR, { recursive: true })
const app = await electron.launch({
  executablePath: electronBinary(),
  args: ['--use-mock-keychain', ...(SWGL ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : []), APP_DIR],
  cwd: APP_DIR,
  timeout: t(60_000),
  env: { ...process.env, ORGAI_DATA_DIR: DATA_DIR }
})
scaleApp(app)
const page = await app.firstWindow()
scalePage(page)
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
await page.waitForSelector('.sidebar', { timeout: t(60_000) })
// E2E_CPU_THROTTLE=3 slows the renderer's main thread three times. The software GPU process is not slowed by it: to starve
// that one too, run the script under `start /affinity 5 /wait /b node e2e/factory-floor.mjs` on Windows (two cores).
if (Number(process.env.E2E_CPU_THROTTLE) > 1) {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: Number(process.env.E2E_CPU_THROTTLE) })
  log('cpu throttle', process.env.E2E_CPU_THROTTLE)
}
await page.evaluate(() => {
  for (const k of Object.keys(localStorage).filter((x) => x.startsWith('orgai.'))) localStorage.removeItem(k)
  window.__cspViolations = []
  document.addEventListener('securitypolicyviolation', (e) => window.__cspViolations.push(`${e.violatedDirective} ${e.blockedURI}`))
})
if (PLAN) await page.evaluate((k) => localStorage.setItem(k, 'floor-plan'), KEY)
await page.reload()
await page.waitForSelector('[data-testid=dashboard], .editor', { timeout: t(60_000) })
let shots = 0
const shot = (name) => page.screenshot({ path: path.join(SHOTS_DIR, `factory-floor-${String(++shots).padStart(2, '0')}-${name}.png`) }).catch(() => {})

const resizeTo = async (w, h) => {
  await app.evaluate(({ BrowserWindow }, [cw, ch]) => BrowserWindow.getAllWindows()[0].setContentSize(cw, ch), [w, h])
  await page.waitForFunction((cw) => Math.abs(window.innerWidth - cw) <= 1, w, { timeout: t(10_000) }).catch(() => {})
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
  await page.locator('[data-testid=factory-scene]').first().waitFor({ state: 'detached', timeout: t(10_000) }).catch(() => {})
  await setCanvas({ presentation: 'factory-floor' })
}
const setKey = (v) => page.evaluate(([k, val]) => (val === null ? localStorage.removeItem(k) : localStorage.setItem(k, val)), [KEY, v])

/** What every mounted scene must satisfy, whichever renderer it picked. Returns the renderer. */
const checkMounted = async (mode, label) => {
  await scene(mode).waitFor({ timeout: t(20_000) })
  await page.waitForFunction(() => !!document.querySelector('[data-testid=factory-scene]')?.getAttribute('data-renderer'), null, { timeout: t(20_000) })
  const renderer = await scene(mode).getAttribute('data-renderer')
  check(renderer === 'webgl2' || renderer === 'floor-plan', `${label}: scene mounts with a renderer`, String(renderer))
  const st = await state().catch(() => null)
  check(!!st && st.renderer === renderer && st.mode === mode, `${label}: factory-state agrees with the scene`, JSON.stringify(st)?.slice(0, 200))
  const group = page.locator('[data-testid=factory-floor]').first()
  check((await group.count()) === 1 && (await group.getAttribute('role')) === 'group', `${label}: the mirror group exists`)
  check(/^Factory floor,/.test((await group.getAttribute('aria-label')) ?? ''), `${label}: the mirror's name starts "Factory floor,"`, String(await group.getAttribute('aria-label')))
  const canvases = page.locator('[data-testid=factory-canvas]')
  // The 3D path mounts its canvas once the lazy chunk has loaded, after data-renderer is set.
  if (renderer === 'webgl2') await canvases.first().waitFor({ state: 'attached', timeout: t(15_000) }).catch(() => {})
  if (await canvases.count()) {
    check((await canvases.first().getAttribute('aria-hidden')) === 'true', `${label}: the canvas is aria-hidden`)
    check(renderer === 'webgl2', `${label}: a canvas appears only on the 3D path`)
  } else check(renderer === 'floor-plan', `${label}: no canvas means the floor plan`)
  return renderer
}

// ---------- Slice 2 helpers: live floors of 1, 5, 15 and 40 agents ----------
const workerBtn = (id) => page.locator(`[data-testid=factory-worker][data-factory-worker-id="${id}"]`)
const activeWorkerId = async () => {
  const r = await page.evaluate(() => {
    const a = document.activeElement
    const id = a?.getAttribute?.('data-factory-worker-id') ?? null
    return { id, what: id ? '' : `${a?.tagName}.${a?.className}[${a?.getAttribute?.('data-testid') ?? ''}] scenes=${document.querySelectorAll('[data-testid=factory-scene]').length}` }
  })
  if (!r.id && process.env.E2E_FACTORY_DEBUG) log('focus is not on a worker:', r.what)
  return r.id
}
/** Poll the test state until `pred(state)` holds (the state is written at most twice a second). Returns the state, or null on timeout. */
const untilState = async (pred, timeout = 8000) => {
  const end = Date.now() + t(timeout)
  let st = null
  while (Date.now() < end) {
    st = await state().catch(() => null)
    if (st && pred(st)) return st
    await sleep(150)
  }
  return null
}
/** The camera after a tween: wait until the view stops changing across two reads. */
const settledView = async () => {
  let prev = null
  for (let i = 0; i < 20; i++) {
    const v = (await state()).view
    if (prev && Math.abs(v.ppm - prev.ppm) < 0.005 && Math.abs(v.targetX - prev.targetX) < 0.005 && Math.abs(v.targetZ - prev.targetZ) < 0.005) return v
    prev = v
    await sleep(650)
  }
  return (await state()).view
}

/** The section 3.2 algorithm, written out again here as the test oracle. `agents`: spawn order [{ id, parent }] (parent null = root's reports). */
const FLOOR_LINE = { stationX: (slot) => 6 + 4 * (slot % 8), stationZ: (row) => 1.5 + 7 * row }
function referenceLayout(agents) {
  const lines = new Map([['root', { number: 1, rows: [0], count: 0 }]])
  let nextLine = 2
  let nextRow = 1
  const out = new Map()
  for (const a of agents) {
    const lead = a.parent ?? 'root'
    if (!lines.has(lead)) lines.set(lead, { number: nextLine++, rows: [nextRow++], count: 0 })
    const line = lines.get(lead)
    const slot = line.count++
    const ri = Math.floor(slot / 8)
    if (ri === line.rows.length) line.rows.push(nextRow++)
    const row = line.rows[ri]
    out.set(a.id, { line: line.number, row, slot, x: FLOOR_LINE.stationX(slot), z: FLOOR_LINE.stationZ(row) })
  }
  return out
}
/** The sections 3.3 worked examples, as the spec states them (the oracle above is also checked against these). */
const SPEC_5 = { fa: [1, 0, 0, 6, 1.5], fb: [1, 0, 1, 10, 1.5], fa1: [2, 1, 0, 6, 8.5], fb1: [3, 2, 0, 6, 15.5] }
const SPEC_15 = (() => {
  const t = { fa: [1, 0, 0, 6, 1.5], fb: [1, 0, 1, 10, 1.5], fc: [1, 0, 2, 14, 1.5] }
  for (const [lead, line, row, n] of [['fa', 2, 1, 4], ['fb', 3, 2, 4], ['fc', 4, 3, 3]]) for (let i = 1; i <= n; i++) t[`${lead}${i}`] = [line, row, i - 1, 6 + 4 * (i - 1), 1.5 + 7 * row]
  return t
})()
/** Spawn order of the section 3.3 trees (leads first, then each lead's reports in lead order). */
const TREE_5 = [['fa', null], ['fb', null], ['fa1', 'fa'], ['fb1', 'fb']]
const TREE_15 = [['fa', null], ['fb', null], ['fc', null], ...[['fa', 4], ['fb', 4], ['fc', 3]].flatMap(([lead, n]) => Array.from({ length: n }, (_, i) => [`${lead}${i + 1}`, lead]))]

/** The first role the root may spawn (the mock's own choice), used for every spawn so the roster accepts the script. */
const spawnSlug = async () => {
  const p = await page.evaluate((n) => window.orgai.projects.list().then((l) => l.find((x) => x.name === n)), NAME)
  const root = p.roles.find((r) => r.reportsTo === null)
  const first = p.roles.find((r) => root.spawnable.includes(r.id)) ?? p.roles.find((r) => r.reportsTo !== null)
  return first.slug
}
const writeScript = (work) => fs.writeFileSync(scriptFile, JSON.stringify(work ? { delayMs: 300, work } : { delayMs: 300 }))
const spawnWork = (tree, slug) => [
  ...tree.map(([id, parent]) => ({ type: 'spawn', id, name: id, role: slug, description: `Floor ${id}`, ...(parent ? { parent } : {}) })),
  { type: 'text', text: 'The floor is staffed.' }
]
/** Start a fresh Live run with `prompt` (the previous one is ended first). */
let runsStarted = 0
const startLiveRun = async (prompt, metaTimeout = 15_000) => {
  if (runsStarted++ > 0 || (await page.getByRole('button', { name: 'End session' }).count())) await endSession(page)
  await projectTab(page, 'Live').click()
  await page.keyboard.press('Control+t')
  await page.locator('.new-run').waitFor({ timeout: t(8000) }).catch(() => {})
  const ta = page.locator('.composer textarea')
  await ta.waitFor({ timeout: t(10_000) })
  await ta.fill(prompt)
  await page.locator('.composer .btn.primary').click()
  const metaFrom = Date.now()
  // The ready state is the run header MOUNTED for the new run (the composer is gone and a run-meta is in the DOM), read by
  // interval polling inside the page. It used to be Playwright's "visible" wait on run-meta, which (a) polls with
  // requestAnimationFrame, so a renderer that draws a frame every few hundred ms (a software GPU under 122 agents) answers
  // late or not at all, and (b) is false by design while the frame is narrower than 340 px (layout.css hides .run-meta there,
  // and the header folds chips into its "more" menu), so a layout state looked like "the run never started". CI windows-latest
  // 2026-11-24 waited 300 s with the run on screen (122 workers, tab Idle) and a run-meta the page counted as shown.
  await page
    .waitForFunction(() => !document.querySelector('.new-run') && !!document.querySelector('[data-testid=run-meta]'), null, { timeout: t(metaTimeout), polling: 250 })
    .then(() => {
      if (Date.now() - metaFrom > 15_000) log(`startLiveRun(${JSON.stringify(prompt)}): the run view took ${Math.round((Date.now() - metaFrom) / 1000)} s to show`)
    })
    .catch(async (error) => {
      // What the page showed when the run never appeared.
      const seen = await page
        .evaluate(() => {
          const m = document.querySelector('[data-testid=run-meta]')
          const box = m?.getBoundingClientRect()
          return {
            metas: [...document.querySelectorAll('[data-testid=run-meta]')].map((x) => (x.getClientRects().length ? 'shown' : 'hidden')),
            metaBox: box ? [Math.round(box.width), Math.round(box.height)] : null,
            metaVisibility: m ? getComputedStyle(m).visibility : null,
            frameWidth: Math.round(document.querySelector('.canvas-frame')?.getBoundingClientRect().width ?? 0),
            window: [innerWidth, innerHeight],
            hidden: document.hidden,
            workers: document.querySelectorAll('[data-testid=factory-worker]').length,
            scenes: document.querySelectorAll('[data-testid=factory-scene]').length,
            newRun: !!document.querySelector('.new-run'),
            draft: document.querySelector('.composer textarea')?.value ?? null,
            endSession: [...document.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'End session'),
            tab: document.querySelector('.run-tab[aria-selected=true]')?.textContent?.trim() ?? null
          }
        })
        .catch(() => ({}))
      log(`startLiveRun(${JSON.stringify(prompt)}) found no run header after ${t(metaTimeout)} ms: ${JSON.stringify(seen)}`)
      throw error
    })
}
/** Wait until the mirror has `n` workers and the scene has a readable state of that size. */
const waitForFloor = async (n, extra = () => true, timeout = Number(process.env.E2E_FACTORY_WAIT_MS) || 90_000) => {
  const st = await untilState((s) => s.mode === 'live' && s.workers.length === n && extra(s), timeout)
  const mirrored = await page.waitForFunction((k) => document.querySelectorAll('[data-testid=factory-worker]').length === k, n, { timeout: t(10_000) }).then(() => true).catch(() => false)
  if (!st || !mirrored) {
    const ids = await page.evaluate(() => [...document.querySelectorAll('[data-testid=factory-worker]')].map((b) => b.getAttribute('data-factory-worker-id')))
    log(`waitForFloor(${n}) gave up: state workers ${st ? st.workers.length : 'unreadable'}, mirror ${ids.length}: ${ids.join(',')}`)
  }
  return st
}

/** Section 3.3: state coordinates and the mirror's data hooks against `expected` (id -> [line, row, slot, x, z]). */
async function checkPlacement(label, st, expected) {
  const booth = await page.locator('[data-testid=factory-worker][data-kind=booth]').getAttribute('data-factory-worker-id')
  check(!!booth, `${label}: the root is the booth`)
  const ids = Object.keys(expected)
  const got = Object.fromEntries(st.workers.map((w) => [w.id, w]))
  const rest = st.workers.filter((w) => w.id !== booth)
  check(rest.length === ids.length && ids.every((id) => got[id]), `${label}: the floor holds exactly the expected stations`, rest.map((w) => w.id).join(','))
  const bad = ids.filter((id) => {
    const w = got[id]
    const e = expected[id]
    return !w || w.line !== e[0] || w.row !== e[1] || w.slot !== e[2] || Math.abs(w.x - e[3]) > 0.01 || Math.abs(w.z - e[4]) > 0.01
  })
  check(bad.length === 0, `${label}: line, row, slot, x and z equal the section 3.3 table`, bad.map((id) => `${id} want ${expected[id]} got ${JSON.stringify(got[id] && [got[id].line, got[id].row, got[id].slot, got[id].x, got[id].z])}`).join('; '))
  await checkMirrorHooks(label, st, booth)
}
/** The mirror buttons' data-line, data-slot and data-kind agree with the state. */
async function checkMirrorHooks(label, st, booth) {
  const leads = new Set(st.lines.map((l) => l.leadId))
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid=factory-worker]')].map((b) => ({ id: b.getAttribute('data-factory-worker-id'), line: b.getAttribute('data-line'), slot: b.getAttribute('data-slot'), kind: b.getAttribute('data-kind') }))
  )
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]))
  const wrong = []
  for (const w of st.workers) {
    const r = byId[w.id]
    if (!r) wrong.push(`${w.id}: no button`)
    else if (w.id === booth) {
      if (r.kind !== 'booth') wrong.push(`${w.id}: kind ${r.kind}`)
    } else if (r.line !== String(w.line) || r.slot !== String(w.slot) || r.kind !== (leads.has(w.id) ? 'lead' : 'bench')) wrong.push(`${w.id}: ${JSON.stringify(r)} vs line ${w.line} slot ${w.slot}`)
  }
  check(rows.length === st.workers.length && wrong.length === 0, `${label}: the mirror's data-line, data-slot and data-kind agree with the state`, wrong.slice(0, 3).join('; '))
}

/** Section 6.3 keyboard walk on the mirror. `booth` is the root's id. */
async function keyboardWalk(label, booth) {
  const st0 = await state()
  const stations = st0.workers.filter((w) => w.id !== booth).sort((a, b) => a.row - b.row || a.slot - b.slot)
  const tabStops = await page.locator('[data-testid=factory-worker][tabindex="0"]').count()
  check(tabStops === 1, `${label}: exactly one factory-worker is a Tab stop`, String(tabStops))
  const total = await page.locator('[data-testid=factory-worker]').count()
  check((await page.locator('[data-testid=factory-worker][tabindex="-1"]').count()) === total - 1, `${label}: every other worker has tabindex -1`)
  const press = async (key) => {
    await page.keyboard.press(key)
    await sleep(150)
    return activeWorkerId()
  }
  const first = stations[0]
  await page.locator('[data-testid=factory-worker][tabindex="0"]').focus()
  check(await page.evaluate(() => document.activeElement?.matches('[data-testid=factory-worker]')), `${label}: the Tab stop takes focus`)
  check((await press('Home')) === booth, `${label}: Home goes to the booth`)
  check((await press('ArrowDown')) === first.id, `${label}: Down from the booth goes to row 0 slot 0`, String(await activeWorkerId()))
  check((await press('ArrowUp')) === booth, `${label}: Up from row 0 goes to the booth`)
  await press('ArrowDown')
  const row0 = stations.filter((w) => w.row === 0)
  if (row0.length > 1) {
    check((await press('ArrowRight')) === row0[1].id, `${label}: Right moves to the next slot`)
    check((await press('ArrowLeft')) === row0[0].id, `${label}: Left moves to the previous slot`)
  }
  // Down and Up between rows: a station and the one below it at the same x.
  const below = stations.find((w) => stations.some((o) => o.row === w.row + 1 && Math.abs(o.x - w.x) < 0.01))
  if (below) {
    const target = stations.find((o) => o.row === below.row + 1 && Math.abs(o.x - below.x) < 0.01)
    await workerBtn(below.id).focus()
    check((await press('ArrowDown')) === target.id, `${label}: Down goes to the station below at the same x`, `${below.id} -> ${await activeWorkerId()}, want ${target.id}`)
    const up = await press('ArrowUp')
    check(up === below.id, `${label}: Up returns to the station above`, `${target.id} (row ${target.row}, x ${target.x}) -> ${up}, want ${below.id} (row ${below.row}, x ${below.x}); row above: ${stations.filter((o) => o.row === target.row - 1).map((o) => `${o.id}@${o.x}`).join(' ')}`)
  }
  // Reading order across a row end: last of one row, first of the next.
  const wrapFrom = stations.find((w, i) => stations[i + 1] && stations[i + 1].row > w.row)
  if (wrapFrom) {
    const next = stations[stations.indexOf(wrapFrom) + 1]
    await workerBtn(wrapFrom.id).focus()
    check((await press('ArrowRight')) === next.id, `${label}: Right past the end of a row goes to the next row's first slot`)
    check((await press('ArrowLeft')) === wrapFrom.id, `${label}: Left from a row start goes to the previous row's last slot`)
  }
  const last = stations[stations.length - 1]
  check((await press('End')) === last.id, `${label}: End goes to the last placed station`, `${await activeWorkerId()} want ${last.id}`)
  check((await press('Home')) === booth, `${label}: Home returns to the booth`)

  // Camera keys. The fit value is the reference for "0".
  await page.keyboard.press('0')
  const fit = await settledView()
  check(fit.ppm > 0, `${label}: the view has a scale`, JSON.stringify(fit))
  await page.keyboard.press('+')
  const zin = await untilState((s) => s.view.ppm > fit.ppm + 0.01, 5000)
  check(!!zin, `${label}: + zooms in`, String((await state()).view.ppm))
  const zoomed = await settledView()
  await page.keyboard.press('-')
  const zout = await untilState((s) => s.view.ppm < zoomed.ppm - 0.01, 5000)
  check(!!zout, `${label}: - zooms out`, String((await state()).view.ppm))
  await page.keyboard.press('0')
  const back = await untilState((s) => Math.abs(s.view.ppm - fit.ppm) < 0.05, 5000)
  check(!!back, `${label}: 0 fits again (ppm returns to ${fit.ppm})`, String((await state()).view.ppm))
  for (const [axis, keys] of [['targetX', ['Shift+ArrowRight', 'Shift+ArrowLeft']], ['targetZ', ['Shift+ArrowDown', 'Shift+ArrowUp']]]) {
    const before = (await settledView())[axis]
    let moved = false
    for (const k of keys) {
      await page.keyboard.press(k)
      moved = !!(await untilState((s) => Math.abs(s.view[axis] - before) > 0.01, 3000))
      if (moved) break
    }
    check(moved, `${label}: Shift+Arrow pans (view.${axis} changes)`)
    await settledView()
  }
  await page.keyboard.press('0')
  await settledView()

  // Enter selects: the live inspector opens with the back button, and the worker is the selected Tab stop.
  await workerBtn(last.id).focus()
  await page.keyboard.press('Enter')
  const back2 = page.locator('[data-testid=factory-agent-back]')
  await back2.waitFor({ timeout: t(8000) }).catch(() => {})
  check((await back2.count()) === 1, `${label}: Enter selects and opens the live inspector (Back to floor exists)`)
  check((await workerBtn(last.id).getAttribute('aria-current')) === 'true', `${label}: the selected worker has aria-current`)
  check((await page.locator('[data-testid=factory-worker][tabindex="0"]').getAttribute('data-factory-worker-id')) === last.id, `${label}: the selected worker is the Tab stop`)
  await back2.click()
  await sleep(300)
  check((await activeWorkerId()) === last.id, `${label}: Back to floor returns focus to that worker`, String(await activeWorkerId()))
}

/** Section 6.4: Find a worker. `stations` are state workers (not the booth); handles equal ids in these scripts. */
async function findWalk(label, st) {
  const find = page.locator('[data-testid=factory-find]').first()
  const findBtn = (await find.evaluate((el) => el.tagName)) === 'BUTTON' ? find : find.locator('button').first()
  const input = page.locator('[data-testid=factory-find-input]')
  const results = page.locator('[data-testid=factory-find-result]')
  await findBtn.click()
  await input.waitFor({ timeout: t(5000) })
  check(true, `${label}: Find opens a search field`)
  const target = st.workers.find((w) => w.row >= 1) ?? st.workers[st.workers.length - 1]
  await input.fill(target.id.toUpperCase())
  await sleep(250)
  check((await results.count()) >= 1 && (await results.first().innerText()).toLowerCase().includes(target.id.toLowerCase()), `${label}: Find filters by handle, case-insensitively`, String(await results.count()))
  const names = await page.evaluate(() => [...document.querySelectorAll('[data-testid=factory-worker] .factory-worker-name')].map((n) => n.textContent ?? ''))
  const nm = names[names.length - 1]
  if (nm) {
    await input.fill(nm.toUpperCase())
    await sleep(250)
    const want = names.filter((n) => n.toLowerCase().includes(nm.toLowerCase())).length
    check((await results.count()) === want, `${label}: Find filters by name, case-insensitively`, `${await results.count()} results, want ${want}`)
  }
  await input.fill('zz-nobody-zz')
  await sleep(250)
  check((await results.count()) === 0 && (await page.getByText('No worker matches “zz-nobody-zz”.').count()) >= 1, `${label}: Find says No worker matches “{query}”.`)
  await input.fill(target.id)
  await sleep(250)
  await results.first().click()
  await sleep(400)
  check((await input.count()) === 0, `${label}: choosing a result closes Find`)
  check((await activeWorkerId()) === target.id, `${label}: the chosen worker's button has focus`, String(await activeWorkerId()))
  check((await workerBtn(target.id).getAttribute('aria-current')) === 'true', `${label}: the chosen worker is selected`)
  check((await page.locator('[data-testid=factory-agent-back]').count()) === 1, `${label}: the chosen worker's inspector opens`)
  await findBtn.click()
  await input.waitFor({ timeout: t(5000) })
  await page.keyboard.press('Escape')
  await sleep(300)
  check((await input.count()) === 0, `${label}: Escape closes Find`)
  check(await page.evaluate(() => document.activeElement?.closest('[data-testid=factory-find]') !== null || document.activeElement?.matches('[data-testid=factory-find]')), `${label}: Escape returns focus to Find`)
}

/** Section 6.7: the control row, at both sizes. */
async function controlsWalk(label) {
  const bar = page.locator('[data-testid=factory-controls]').first()
  check((await bar.count()) === 1 && (await bar.getAttribute('role')) === 'toolbar', `${label}: factory-controls is a toolbar`)
  check((await bar.getAttribute('aria-label')) === 'Factory floor controls', `${label}: the toolbar is named "Factory floor controls"`, String(await bar.getAttribute('aria-label')))
  for (const [w, h] of [[1024, 640], [1600, 1000]]) {
    await resizeTo(w, h)
    check(await noPageScroll(), `${label}: no page scroll at ${w}x${h}`)
    const box = await bar.boundingBox()
    check(!!box && box.height <= 48.5, `${label}: the control row is at most 48 px tall at ${w}x${h}`, String(box?.height))
  }
  await resizeTo(1024, 640)
  await page.locator('[data-testid=factory-fit]').click()
  const fit = await settledView()
  await page.locator('[data-testid=factory-zoom-in]').click()
  check(!!(await untilState((s) => s.view.ppm > fit.ppm + 0.01, 5000)), `${label}: Zoom in raises view.ppm`)
  const zoomed = await settledView()
  await page.locator('[data-testid=factory-zoom-out]').click()
  check(!!(await untilState((s) => s.view.ppm < zoomed.ppm - 0.01, 5000)), `${label}: Zoom out lowers view.ppm`)
  await settledView()
  await page.locator('[data-testid=factory-zoom-in]').click()
  await settledView()
  await page.locator('[data-testid=factory-fit]').click()
  check(!!(await untilState((s) => Math.abs(s.view.ppm - fit.ppm) < 0.05, 5000)), `${label}: Fit returns view.ppm to ${fit.ppm}`, String((await state()).view.ppm))
}

// ---------- Slice 3: live state (sections 1.4, 4.4, 6.2, 7.1, 10.3 to 10.5) ----------
// NEW-HOOK assertions go through `chk3`: the same check(), but the failure detail always carries what the hook returned.
const chk3 = (ok, name, got) => check(ok, `[slice3] ${name}`, `got: ${typeof got === 'string' ? got : JSON.stringify(got)}`)
const wOf = (st, id) => st?.workers?.find((w) => w.id === id)
/** The mirror button's data hooks and its accessible description text. */
const mirrorOf = (id) =>
  page.evaluate((wid) => {
    const b = document.querySelector(`[data-testid=factory-worker][data-factory-worker-id="${wid}"]`)
    if (!b) return null
    const desc = (b.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean).map((i) => document.getElementById(i)?.textContent ?? '').join(' ')
    const d = b.dataset
    return { state: d.state, lamp: d.lamp, pose: d.pose, status: d.status, fenced: d.fenced, crate: d.crate ?? null, steps: d.steps ?? '', name: b.getAttribute('aria-label') ?? b.textContent ?? '', desc }
  }, id)
/** lamp / pose / status word / fenced / crate of one worker, in the state and on the mirror. `want`: { lamp, pose, fenced, crate, shutter, barrier }. */
async function checkWorker(label, st, id, want) {
  const w = wOf(st, id)
  if (!w) return chk3(false, `${label}: ${id} is on the floor`, (st?.workers ?? []).map((x) => x.id).join(','))
  const have = { lamp: w.lamp, pose: w.pose, statusWord: w.statusWord, fenced: w.fenced, crate: w.crate ?? null, shutter: w.shutter, barrier: w.barrier }
  for (const k of Object.keys(want)) {
    const exp = want[k]
    const ok = Array.isArray(exp) ? exp.includes(have[k]) : have[k] === exp
    chk3(ok, `${label}: ${id} ${k} is ${Array.isArray(exp) ? exp.join(' or ') : exp}`, have)
  }
  chk3(typeof w.statusWord === 'string' && w.statusWord.length > 0, `${label}: ${id} has a status word`, have)
  const m = await mirrorOf(id)
  chk3(!!m && m.lamp === w.lamp && m.pose === w.pose && m.status === w.statusWord && m.fenced === String(!!w.fenced) && (m.crate ?? null) === (w.crate ?? null), `${label}: ${id} mirror hooks agree with the state`, { mirror: m && { ...m, desc: undefined }, state: have })
  chk3(!!m && m.name.includes(`, ${w.statusWord}`), `${label}: ${id} accessible name ends ", {status word}"`, m?.name)
}
const WORKTREE_PHRASE = { active: 'Working in its own branch', merging: 'Working in its own branch', merged: 'Branch merged', conflict: 'Merge conflict', review: 'Waiting for your review' }

// ---------- Slice 6 helpers: budgets, quality, near zoom (sections 9.1, 9.2, 12) ----------
const chk6 = (ok, name, got) => check(ok, `[slice6] ${name}`, `got: ${typeof got === 'string' ? got : JSON.stringify(got)}`)
const QUALITY_RANK = { minimal: 0, low: 1, high: 2 }
const BUDGET = { drawCalls: 120, shadowCalls: 40, triangles: 250_000, plates: 24, ambient: 12, memoryBytes: 24 * 1024 * 1024, pixelRatio: 1.5 }
const shownPlates = () => page.locator('[data-testid=factory-nameplate][data-shown="true"]').count()
/** A read of the test state that carries `perf` (3D path only, after the first frame). */
const untilPerf = (timeout = 15_000) => untilState((s) => s.renderer === 'webgl2' && !!s.perf && s.perf.drawCalls > 0, timeout)
/** Section 9.1 structural budgets on one state read of the 3D path: draw calls, shadow calls, triangles, labels, ambient loops, memory, pixel ratio, quality. */
async function checkBudgets(label, st, { plates = true } = {}) {
  if (!st || st.renderer !== 'webgl2') return log(`skip budgets for ${label}: the floor plan has no render pass`)
  const p = st.perf
  chk6(!!p, `${label}: the test state carries perf`, st && Object.keys(st))
  if (!p) return
  chk6(p.drawCalls > 0 && p.drawCalls <= BUDGET.drawCalls, `${label}: at most ${BUDGET.drawCalls} draw calls`, p.drawCalls)
  chk6(p.shadowCalls <= BUDGET.shadowCalls, `${label}: at most ${BUDGET.shadowCalls} shadow-pass calls`, p.shadowCalls)
  chk6(p.triangles > 0 && p.triangles <= BUDGET.triangles, `${label}: at most ${BUDGET.triangles} triangles`, p.triangles)
  const looping = st.workers.filter((w) => w.ambient && w.ambient !== 'none').length
  chk6(looping <= BUDGET.ambient, `${label}: at most ${BUDGET.ambient} stations loop`, looping)
  if (plates) {
    const n = await shownPlates()
    chk6(n <= BUDGET.plates, `${label}: at most ${BUDGET.plates} nameplates are shown`, n)
    rec[`${label} plates`] = n
  }
  rec[`${label} drawCalls/shadowCalls/triangles`] = `${p.drawCalls}/${p.shadowCalls}/${p.triangles}`
}
/** Memory, pixel ratio and quality rules on a state read of the 3D path (the section 9.1 rows that do not depend on timing). */
function checkQualityState(label, st) {
  if (!st || st.renderer !== 'webgl2' || !st.perf) return
  const p = st.perf
  chk6(typeof p.memoryBytes === 'number' && p.memoryBytes > 0, `${label}: perf.memoryBytes is reported (own textures plus shadow map, above 0)`, p.memoryBytes)
  chk6(p.memoryBytes <= BUDGET.memoryBytes, `${label}: texture and shadow memory is at most 24 MB`, p.memoryBytes)
  chk6(typeof p.pixelRatio === 'number' && p.pixelRatio > 0 && p.pixelRatio <= BUDGET.pixelRatio, `${label}: pixel ratio is at most 1.5`, p.pixelRatio)
  if (st.quality !== 'high') chk6(p.pixelRatio === 1, `${label}: pixel ratio is 1 at ${st.quality} quality`, { quality: st.quality, pixelRatio: p.pixelRatio })
  chk6(st.qualityStart in QUALITY_RANK && QUALITY_RANK[st.quality] <= QUALITY_RANK[st.qualityStart], `${label}: quality never rises above where the mount started (start ${st.qualityStart}, now ${st.quality})`, { start: st.qualityStart, now: st.quality })
}
/** Zoom in with the toolbar until the near band (ppm 36 or more; the limit is 60), each press waiting for the camera. */
async function zoomNear() {
  let v = (await state()).view
  for (let i = 0; i < 10 && v.ppm < 36; i++) {
    const before = v.ppm
    await page.locator('[data-testid=factory-zoom-in]').click()
    await untilState((s) => s.view.ppm > before + 0.01, 3000)
    // The tween is over once two reads 350 ms apart agree.
    let prev = -1
    for (let k = 0; k < 12; k++) {
      v = (await state()).view
      if (Math.abs(v.ppm - prev) < 0.005) break
      prev = v.ppm
      await sleep(350)
    }
  }
  return v
}

let projectOpen = false
try {
  await resizeTo(1024, 640)
  const project = await createProject(page, { mode: 'existing', path: repo, name: NAME })
  check(!!project, 'project created on the mock adapter')

  // ---------- Settings: choose Factory Floor ----------
  await openAppSettings(page)
  await page.getByRole('tab', { name: 'Appearance', exact: true }).click()
  const section = page.locator('[data-testid=canvas-section]')
  await section.waitFor({ timeout: t(10_000) })
  const radio = section.locator('[data-testid=canvas-presentation-factory-floor]')
  check((await radio.count()) === 1, 'settings offer the Factory Floor presentation')
  await radio.check({ force: true })
  await page.waitForFunction(() => document.documentElement.dataset.canvasPresentation === 'factory-floor', null, { timeout: t(10_000) }).catch(() => {})
  check((await html('data-canvas-presentation')) === 'factory-floor', 'choosing Factory Floor sets the presentation')
  const saved = await page.evaluate(async () => (await window.orgai.settings.get()).appearance.canvas.presentation)
  check(saved === 'factory-floor', 'the presentation is saved in settings', String(saved))

  // ---------- Factory Floor is Live only (owner decision 2026-11-19): Team keeps the Graph ----------
  await openProject(page, NAME)
  projectOpen = true
  await openTeam(page)
  await page.locator('.react-flow').first().waitFor({ timeout: t(15_000) }).catch(() => {})
  check((await page.locator('.react-flow').count()) > 0, 'Team shows the Graph while Factory Floor is chosen')
  check((await page.locator('[data-testid=factory-scene]').count()) === 0, 'Team never mounts the factory scene')
  check((await page.locator('[data-testid=factory-pause-motion]').count()) === 0, '[slice4] Team has no Pause motion button (live only)')
  await shot('team-graph')

  await projectTab(page, 'Live').click()
  const ta = page.locator('.composer textarea')
  await ta.waitFor({ timeout: t(10_000) })
  await ta.fill('Factory floor check build')
  await page.locator('.composer .btn.primary').click()
  await page.locator('[data-testid=run-meta]').waitFor({ timeout: t(15_000) })
  const liveRenderer = await checkMounted('live', 'Live')
  const liveName = await page.locator('[data-testid=factory-floor]').first().getAttribute('aria-label')
  check(/^Factory floor, \d+ workers?$/.test(liveName ?? ''), 'Live: the mirror says workers', String(liveName))
  await shot('live')
  log('live renderer:', liveRenderer, 'gpu:', (await state().catch(() => ({}))).perf?.gpu)
  // Slice 6: the first (cold) 3D mount of this launch. Its first-frame time is the cold figure of section 9.1.
  rec.renderer = liveRenderer
  if (liveRenderer === 'webgl2') {
    const first = await untilState((s) => s.renderer === 'webgl2' && !!s.perf && s.perf.drawCalls > 0, 15_000)
    if (first) {
      rec.firstFrameColdMs = first.perf.firstFrameMs
      rec.gpu = first.perf.gpu ?? '(not exposed)'
      rec.qualityStartFirstMount = first.qualityStart
      rec.firstMountGeometries = first.perf.geometries
      rec.firstMountTextures = first.perf.textures
      // Section 9.2: software WebGL starts at minimal (SwiftShader passes failIfMajorPerformanceCaveat, so the probe
      // reads the renderer string); a hardware GPU starts at high.
      if (first.perf.gpu) {
        const sw = SOFTWARE_GPU.test(first.perf.gpu)
        check(first.qualityStart === (sw ? 'minimal' : 'high'), `[slice6] the first mount starts at ${sw ? 'minimal (software WebGL)' : 'high (hardware GPU)'}`, { gpu: first.perf.gpu, start: first.qualityStart })
      }
    }
  }

  // ---------- Both themes and both sizes (Live) ----------
  for (const [w, h] of [[1024, 640], [1600, 1000]]) {
    await resizeTo(w, h)
    for (const theme of ['dark', 'light']) {
      await setAppearance({ theme })
      for (const mode of ['live']) {
        await scene(mode).waitFor({ timeout: t(15_000) })
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

  // ---------- Slice 2: live floors of 1, 5, 15 and 40 agents (section 3.3), mock adapter ----------
  // The oracle itself must reproduce the spec's own tables before it judges the app.
  const o5 = referenceLayout(TREE_5.map(([id, parent]) => ({ id, parent })))
  const o15 = referenceLayout(TREE_15.map(([id, parent]) => ({ id, parent })))
  const same = (o, spec) => Object.entries(spec).every(([id, e]) => { const r = o.get(id); return r && [r.line, r.row, r.slot, r.x, r.z].every((v, i) => v === e[i]) })
  check(same(o5, SPEC_5) && same(o15, SPEC_15), 'the test oracle reproduces the section 3.3 tables for 5 and 15 agents')

  const slug = await spawnSlug()
  const boothOf = () => page.locator('[data-testid=factory-worker][data-kind=booth]').getAttribute('data-factory-worker-id')

  // 1 agent: the booth only.
  writeScript([{ type: 'text', text: 'Only the root is on the floor.' }])
  await startLiveRun('Factory floor one agent')
  const s1 = await waitForFloor(1)
  check(!!s1, '1 agent: the floor has one worker', JSON.stringify(s1?.workers.map((w) => w.id)))
  if (s1) {
    check((await page.locator('[data-testid=factory-worker]').count()) === 1 && (await page.locator('[data-testid=factory-worker]').first().getAttribute('data-kind')) === 'booth', '1 agent: the only station is the booth')
    check(s1.vacant === 0 && s1.lines.length <= 1, '1 agent: no vacancies, at most the root line', JSON.stringify(s1.lines))
    check(/^Factory floor, 1 worker$/.test((await page.locator('[data-testid=factory-floor]').getAttribute('aria-label')) ?? ''), '1 agent: the mirror says "1 worker"')
  }
  await shot('floor-1')

  // 5 agents.
  writeScript(spawnWork(TREE_5, slug))
  await startLiveRun('Factory floor five agents')
  const s5 = await waitForFloor(5)
  check(!!s5, '5 agents: the floor holds root plus four stations')
  if (s5) await checkPlacement('5 agents', s5, SPEC_5)
  await shot('floor-5')

  // 15 agents: placement, keyboard walk, Find, controls.
  writeScript(spawnWork(TREE_15, slug))
  await startLiveRun('Factory floor fifteen agents')
  const s15 = await waitForFloor(15)
  check(!!s15, '15 agents: the floor holds root plus fourteen stations')
  if (s15) {
    await checkPlacement('15 agents', s15, SPEC_15)
    const booth = await boothOf()
    await keyboardWalk('15 agents', booth)
    await findWalk('15 agents', await state())
    await controlsWalk('15 agents')
  }
  await shot('floor-15')

  // 40 agents: the mock's [mock:factory-floor] tour (root, 3 leads, 9 sub-leads, 27 workers; ff-w333 removed). Invariants, not a table.
  writeScript(null)
  await startLiveRun('Factory floor forty agents [mock:factory-floor]')
  // The 39 stations took 94 s to show on windows-latest (the default wait is 90 s); a wait that passes costs only what it takes.
  const s40 = await waitForFloor(39, (s) => s.vacant === 1, 150_000)
  check(!!s40, '40 agents: 39 stations stand and the removed ff-w333 is one vacant slot', JSON.stringify(s40 && { n: s40.workers.length, vacant: s40.vacant }))
  if (s40) {
    const booth = await boothOf()
    // Slice 3, per-state cues. The mock holds ff-w111 in state tool after MOCK_FACTORY_FLOOR_READY until the card of ff-w211 is
    // answered (below), not for a fixed time: a runner that shows the tour a minute late applies the whole backlog without a
    // render in between, so a 5 s hold was never shown (CI windows-latest, and a two-core, 6x throttled run here: the state
    // went from ff-w111 thinking to the plan blocked and the card pending in one write, and never showed the machine). Every
    // READY condition is now a standing state, so reading it from here whenever the runner gets to it is enough.
    // READY follows the plan update (p2 blocked), ff-w111's tool steps and ff-w211's background card, so key the snapshot on
    // all three: ff-w123 failing alone comes before the plan update and before the tool hold (first slice 3 run).
    const ready = (s) => s.mode === 'live' && wOf(s, 'ff-w123')?.lamp === 'failed' && s.board?.blocked === 1 && wOf(s, 'ff-w211')?.lamp === 'needs-you' && wOf(s, 'ff-w111')?.pose === 'machine'
    const snap = await untilState(ready, 150_000)
    chk3(!!snap, 'MOCK_FACTORY_FLOOR_READY is reached (plan blocked, ff-w211 card pending, ff-w111 at its machine)', wOf(await state(), 'ff-w111'))
    if (snap) {
      await checkWorker('tool', snap, 'ff-w111', { lamp: 'running', pose: 'machine', fenced: true, shutter: false, barrier: false })
      const bootS = snap
      await checkWorker('starting', bootS, 'ff-w121', { lamp: 'running', pose: 'console', shutter: false, barrier: false })
      await checkWorker('idle', bootS, 'ff-w122', { lamp: 'off', pose: 'rest', shutter: false, barrier: false })
      await checkWorker('error', bootS, 'ff-w123', { lamp: 'failed', pose: 'down', barrier: true, shutter: false })
      await checkWorker('done', bootS, 'ff-w131', { pose: 'docked', shutter: true, barrier: false })
      // Leads are 'delegating' only while a spawn is in flight; by READY the mock has moved some of them on (ff-l1 reads
      // 'thinking'). So the pose is checked against the state the mirror reports: delegating -> dispatch, thinking -> console.
      for (const [label, id] of [['lead', 'ff-l1'], ['sub-lead', 'ff-s11'], ['lead', 'ff-l2'], ['sub-lead', 'ff-s21']]) {
        const st = (await mirrorOf(id))?.state
        const pose = st === 'delegating' ? 'dispatch' : st === 'thinking' || st === 'starting' ? 'console' : null
        if (pose) await checkWorker(`${st} ${label}`, bootS, id, { pose })
        else log(`skip ${id} pose check: state ${st}`)
      }
      await checkWorker('root', bootS, booth, { pose: ['console', 'dispatch', 'rest'] })
      // Fenced and crate placement per worktree status (sections 1.4 and 4.4).
      await checkWorker('worktree active', bootS, 'ff-w111', { fenced: true })
      await checkWorker('worktree merging', bootS, 'ff-w112', { fenced: true, crate: 'pad' })
      await checkWorker('worktree merged (main)', bootS, 'ff-w113', { fenced: false, crate: 'dock' })
      await checkWorker('worktree merged (parent)', bootS, 'ff-w131', { fenced: false, crate: 'parent-pad' })
      await checkWorker('worktree conflict', bootS, 'ff-w212', { fenced: true, crate: 'hold-striped' })
      await checkWorker('worktree review', bootS, 'ff-w132', { fenced: true, crate: 'pad' })
      chk3(wOf(bootS, 'ff-w132')?.crateLamp === 'needs-you', 'review crate lamp is needs-you', wOf(bootS, 'ff-w132'))
      await checkWorker('worktree held', bootS, 'ff-w133', { fenced: true, crate: 'hold' })
      await checkWorker('worktree waiting-children', bootS, 'ff-s13', { fenced: true, crate: 'pad' })
      await checkWorker('worktree empty', bootS, 'ff-w211', { fenced: false, crate: null })
      if (wOf(bootS, 'ff-w213')) await checkWorker('worktree removed', bootS, 'ff-w213', { fenced: false, crate: null })
      for (const [id, status] of [['ff-w111', 'active'], ['ff-w113', 'merged'], ['ff-w212', 'conflict'], ['ff-w132', 'review']]) {
        const m = await mirrorOf(id)
        chk3(!!m && m.desc.includes(WORKTREE_PHRASE[status]), `${id} description says "${WORKTREE_PHRASE[status]}"`, m?.desc)
      }
      // Slice 4: only Running stations loop, at most 12 (section 5.1); Needs you, Failed, Idle and Finished never do.
      const looping = snap.workers.filter((w) => w.ambient && w.ambient !== 'none')
      chk3(looping.length <= 12 && looping.every((w) => w.lamp === 'running'), 'only running stations loop, at most 12', looping.map((w) => `${w.id}:${w.ambient}:${w.lamp}`))
      chk3(snap.dockCrates === 1, 'dockCrates is 1', snap.dockCrates)
      chk3(snap.hall === 'on', 'hall is on while the run is live', snap.hall)
      chk3((await page.locator('[data-testid=factory-scene]').first().getAttribute('data-hall')) === 'on', 'factory-scene data-hall is on', await page.locator('[data-testid=factory-scene]').first().getAttribute('data-hall'))
      // Plan board (p1 in_progress owned by ff-l1, p2 blocked on ff-w111, p3 pending) and the step chip.
      const b = snap.board
      chk3(!!b && b.total === 3 && b.done === 0 && b.blocked === 1 && !b.overflow, 'board is 0 of 3 done, 1 blocked, no overflow', b)
      const lamps = (b?.lamps ?? []).map((l) => (typeof l === 'string' ? l : l.lamp ?? l.state ?? l.status))
      chk3(JSON.stringify(lamps) === JSON.stringify(['active', 'blocked', 'pending']), 'board lamps are [active, blocked, pending]', b?.lamps)
      const chipped = snap.workers.filter((w) => (w.stepIds ?? []).includes('p1')).map((w) => w.id)
      chk3(chipped.length === 1 && chipped[0] === 'ff-l1', 'only ff-l1 carries the p1 step chip', chipped)
      const ml1 = await mirrorOf('ff-l1')
      chk3(!!ml1 && ml1.steps.split(/\s+/).includes('p1') && /Plan step p1:/.test(ml1.desc), 'ff-l1 mirror: data-steps has p1 and the description says "Plan step p1: {title}"', ml1)
      const mw = await mirrorOf('ff-w111')
      chk3(!!mw && !mw.steps.split(/\s+/).includes('p2') && !/Plan step p2/.test(mw.desc), 'a blocked step puts no chip on its owner ff-w111', mw)
      const pb = page.locator('[data-testid=factory-plan-board]')
      const pbName = (await pb.count()) ? ((await pb.first().getAttribute('aria-label')) ?? (await pb.first().innerText())) : null
      chk3(pbName === 'Plan, 0 of 3 steps done, 1 blocked', 'plan board button name', pbName)
      chk3((await pb.count()) === 1 && (await pb.first().getAttribute('data-total')) === '3' && (await pb.first().getAttribute('data-done')) === '0' && (await pb.first().getAttribute('data-blocked')) === '1', 'plan board data-total/done/blocked', pbName)
      // 3D-only labels (DOM overlay over the canvas).
      if (snap.renderer === 'webgl2') {
        // textContent: a label off-stage or skipped by the label budget is hidden, and innerText of a hidden node is ''.
        const bl = ((await page.locator('[data-testid=factory-board-label]').first().textContent({ timeout: t(5000) }).catch(() => '')) ?? '').replace(/\s+/g, ' ').trim()
        chk3(bl === 'Plan · 0 of 3 done · 1 blocked', 'board label text', bl)
        const dk = page.locator('[data-testid=factory-dock]').first()
        const dkText = ((await dk.textContent({ timeout: t(5000) }).catch(() => '')) ?? '').replace(/\s+/g, ' ').trim()
        chk3(dkText === 'Main checkout · 1 merged' && (await dk.getAttribute('data-count').catch(() => null)) === '1', 'dock label text and data-count', dkText)
        const plates = page.locator('[data-testid=factory-nameplate][data-shown="true"]')
        const nShown = await plates.count()
        chk3(nShown > 0 && nShown <= 24, '40-agent floor: at most 24 nameplates are shown (label cap)', nShown)
        const pl = await page.evaluate(() => [...document.querySelectorAll('[data-testid=factory-nameplate][data-shown="true"]')].slice(0, 40).map((n) => ({ s: n.getAttribute('data-status'), t: n.getAttribute('data-steps') })))
        chk3(pl.every((p) => p.s), 'every shown nameplate carries data-status', pl.slice(0, 3))
      } else log('skip 3D-only label checks (board label, dock label, nameplates): the floor plan has no label overlay')
    }
    const ids = s40.workers.map((w) => w.id)
    check(!ids.includes('ff-w333'), '40 agents: the removed ff-w333 is not on the floor')
    check(s40.workers.filter((w) => w.id !== booth).every((w) => w.x === 6 + 4 * (w.slot % 8) && w.z === 1.5 + 7 * w.row), '40 agents: every station x = 6 + 4 * (slot % 8) and z = 1.5 + 7 * row')
    const seen = new Set()
    const dup = s40.workers.filter((w) => w.id !== booth).filter((w) => seen.size === seen.add(`${w.x},${w.z}`).size)
    check(dup.length === 0, '40 agents: no two stations share a position', dup.map((w) => w.id).join(','))
    check(s40.workers.filter((w) => w.id !== booth).every((w) => w.slot >= 0 && Math.floor(w.slot / 8) <= w.row), '40 agents: slots are non-negative and rows are real')
    // The oracle in spawn order (ff-w333 spawned, then vacant: its slot is held, so later slots are unaffected).
    const F = ['ff-l1', 'ff-l2', 'ff-l3']
    const order = []
    F.forEach((l, a) => {
      order.push({ id: l, parent: null })
      for (let b = 1; b <= 3; b++) {
        const sub = `ff-s${a + 1}${b}`
        order.push({ id: sub, parent: l })
        for (let c = 1; c <= 3; c++) order.push({ id: `ff-w${a + 1}${b}${c}`, parent: sub })
      }
    })
    const ref = referenceLayout(order)
    // The scene mounted before the first spawn, so placement was incremental: no compaction, ff-w333's slot stays held.
    const refBad = s40.workers.filter((w) => w.id !== booth).filter((w) => { const r = ref.get(w.id); return !r || r.line !== w.line || r.row !== w.row || r.slot !== w.slot }).map((w) => w.id)
    check(refBad.length === 0, '40 agents: stations sit where the append-only algorithm puts them (spawn order, depth first)', refBad.slice(0, 5).join(','))
    const leadsWithReports = F.concat(F.flatMap((l, a) => [1, 2, 3].map((b) => `ff-s${a + 1}${b}`)))
    const lineLeads = new Set(s40.lines.map((l) => l.leadId))
    check(leadsWithReports.every((id) => lineLeads.has(id)) && lineLeads.has(booth), '40 agents: the root and each lead with reports own a line', [...lineLeads].join(','))
    check(s40.lines.length === 13 && s40.lines.some((l) => l.number === 1), '40 agents: 13 lines (root, 3 leads, 9 sub-leads)', JSON.stringify(s40.lines.map((l) => l.number)))
    await checkMirrorHooks('40 agents', s40, booth)
    // The tour's background permission ask (ff-w211) arrives after the removal; a new decision card takes focus on mount
    // (DecisionCard's existing auto-focus), so the keyboard walk starts only once the card is there.
    const card = await page.locator('.decision-card').first().waitFor({ timeout: t(20_000) }).then(() => true).catch(() => false)
    check(card, '40 agents: the tour\'s permission card is in the tray before the keyboard walk')
    await sleep(400)
    // A pending card on a NON-root agent (ff-w211) is a needs-you cue on that worker.
    const needs = await untilState((s) => wOf(s, 'ff-w211')?.lamp === 'needs-you', 8000)
    chk3(!!needs, 'ff-w211 lamp is needs-you while its Bash card is pending', wOf(await state(), 'ff-w211'))
    if (needs) {
      await checkWorker('needs-you', needs, 'ff-w211', { lamp: 'needs-you', pose: 'signal', statusWord: 'Needs you' })
      chk3(wOf(needs, booth)?.lamp !== 'needs-you', 'the root is not needs-you for a card on ff-w211', wOf(needs, booth))
    }
    await keyboardWalk('40 agents', booth)
    // Answer the card: the cue clears.
    const allow = page.locator('.decision-card .decision-footer .btn.primary').first()
    if (await allow.count()) {
      await allow.click()
      const cleared = await untilState((s) => wOf(s, 'ff-w211')?.lamp !== 'needs-you' && wOf(s, 'ff-w211')?.pose !== 'signal', 10_000)
      chk3(!!cleared, 'answering the card clears ff-w211 needs-you', wOf(await state(), 'ff-w211'))
    } else chk3(false, 'the permission card still has an Allow button after the keyboard walk', await page.locator('.decision-card').count())
    // Idle: once the tour is over nothing changes and the render loop stays still (3D path only).
    const calm = await untilState((s) => s.hall === 'on' && wOf(s, 'ff-w111')?.pose !== 'machine', 15_000)
    // Slice 4: a running station loops (section 5.1), so the render loop is only idle when no station is running. The tour
    // leaves leads in `delegating`, which is running; there the frame growth is recorded, not asserted (section 9.1), and
    // the slice 4 section below asserts the idle case on a script that ends with every agent at rest.
    if (calm?.renderer === 'webgl2') {
      // Slice 6: the steady 40-agent floor at fit is inside the budgets (the stress run below adds the burst and near zoom).
      const tourPerf = await untilPerf(8000)
      chk6(!!tourPerf && tourPerf.workers.length === 39, '40-agent tour: the floor holds 39 workers (40 spawned, ff-w333 removed) when the budgets are read', tourPerf?.workers.length)
      await checkBudgets('40-agent tour at fit', tourPerf)
      await sleep(1500)
      const s0 = await state()
      const anyRunning = s0.workers.some((w) => w.lamp === 'running')
      await sleep(3000)
      const s1 = await state()
      if (!anyRunning) chk3(typeof s0.frames === 'number' && s0.frames === s1.frames, 'idle: frames unchanged over 3 s once nothing changes', { f0: s0.frames, f1: s1.frames })
      else log(`tour: ${s1.frames - s0.frames} frames in 3 s with ${s0.workers.filter((w) => w.lamp === 'running').length} running stations (ambient only, recorded)`)
    } else log('skip idle frames check: no 3D render loop on the floor plan')
    // The plan board button opens the Plan side tab.
    const pbtn = page.locator('[data-testid=factory-plan-board]').first()
    if (await pbtn.count()) {
      // Keyboard path (section 7.3): the board button can sit off-stage at the 40-agent fit, where a pointer cannot reach it.
      await pbtn.focus()
      await page.keyboard.press('Enter')
      await sleep(400)
      const tab = page.locator('[data-testid=side-tab-plan]').first()
      const sel = (await tab.getAttribute('aria-selected').catch(() => null)) ?? (await tab.getAttribute('aria-current').catch(() => null)) ?? (await tab.getAttribute('data-active').catch(() => null))
      chk3(sel === 'true', 'the plan board button opens the Plan tab', sel)
    } else chk3(false, 'the plan board button exists', 0)
    for (const [w, h] of [[1024, 640], [1600, 1000]]) {
      await resizeTo(w, h)
      check(await noPageScroll(), `40 agents: no page scroll at ${w}x${h}`)
    }
    await resizeTo(1024, 640)
  }
  await shot('floor-40')
  // Ended hall (section 1.4): End session on the tour run; agents keep their end lamps.
  if (s40) {
    const before = await state()
    await endSession(page)
    const ended = await untilState((s) => s.hall === 'ended', 15_000)
    chk3(!!ended, 'End session: the hall is ended', await state().then((s) => s.hall).catch(() => null))
    if (ended) {
      chk3((await page.locator('[data-testid=factory-scene]').first().getAttribute('data-hall')) === 'ended', 'factory-scene data-hall is ended', await page.locator('[data-testid=factory-scene]').first().getAttribute('data-hall'))
      const lampOf = (st, id) => wOf(st, id)?.lamp
      for (const [id, lamp] of [['ff-w123', 'failed'], ['ff-w131', 'off']]) chk3(lampOf(ended, id) === lampOf(before, id) && lampOf(ended, id) === lamp, `ended hall: ${id} keeps its end lamp (${lamp})`, { before: lampOf(before, id), after: lampOf(ended, id) })
    }
  }
  writeScript(null)

  // ---------- Slice 3: blocked plan, paused hall, ended hall ----------
  await startLiveRun('Factory floor blocked plan [mock:exec-blocked]')
  // mark_blocked sets the plan's status to blocked without blocking a step, so board.blocked may stay 0: key on the root.
  const blocked = await untilState((s) => s.mode === 'live' && !!s.board && s.workers[0]?.lamp === 'needs-you', 30_000)
  chk3(!!blocked, '[mock:exec-blocked]: a blocked plan makes the root lamp needs-you', await state().then((s) => ({ board: s.board, root: s.workers[0] })).catch(() => null))
  if (blocked) {
    const rootId = await boothOf()
    await checkWorker('blocked plan', blocked, rootId, { lamp: 'needs-you', pose: 'signal', statusWord: 'Needs you' })
  }

  await startLiveRun('Factory floor paused [mock:factory-floor-pause]')
  // The tour is the 40-agent tour again, then a usage limit: on windows-latest the renderer showed it 80 s late (the 39
  // stations alone took 84 s), so the wait for the paused hall is as long as that run can take, not 60 s.
  const paused = await untilState((s) => s.hall === 'paused', 180_000)
  chk3(!!paused, '[mock:factory-floor-pause]: the hall is paused', await state().then((s) => s.hall).catch(() => null))
  chk3((await page.locator('[data-testid=factory-scene]').first().getAttribute('data-hall')) === 'paused', 'factory-scene data-hall is paused', await page.locator('[data-testid=factory-scene]').first().getAttribute('data-hall'))
  // ---------- Slice 4: cues and motion (sections 1.4, 5, 6.5, 6.7, 7.5, 9.1, 10.3, 10.4) ----------
  // Fixtures are timed custom work scripts (core-runtime.md "Factory Floor mock": tool holdMs, agentState, worktree, message).
  // Every gated script starts with a permission card on the root (`ask`): the run stands still until this script answers it,
  // so the scene is mounted and its test state read BEFORE the events happen, and nothing here depends on a sleep.
  // The cue lists are read from the state's `recentCues` (the state is written twice a second), accumulated across polls.
  const chk4 = (ok, name, got) => check(ok, `[slice4] ${name}`, `got: ${typeof got === 'string' ? got : JSON.stringify(got)}`)
  const MSG_AGENT = 'Please review the cue fixture now, zebra-lunch-7'
  const MSG_USER = 'Cue fixture is ready for your review, otter-dock-9'
  // Text after the 32 characters the message cursor may carry: must never reach the test state.
  const TAILS = [MSG_AGENT.slice(35), MSG_USER.slice(38)]
  const GATE = { type: 'tool', name: 'Bash', input: { command: 'cue-gate --hold' }, ask: true, result: 'ok' }
  const writeTimed = (work, delayMs) => fs.writeFileSync(scriptFile, JSON.stringify({ delayMs, work }))
  /** One lead (cq-a), two workers under it (cq-b, cq-c): spawn with parent, message to an agent and to the user, a tool call, a merge into main, a conflict, end states. */
  const cueEvents = () => [
    { type: 'spawn', id: 'cq-a', name: 'cq-a', role: slug, description: 'Cue lead' },
    { type: 'spawn', id: 'cq-b', name: 'cq-b', role: slug, parent: 'cq-a', description: 'Cue worker' },
    { type: 'spawn', id: 'cq-c', name: 'cq-c', role: slug, parent: 'cq-a', description: 'Cue second worker' },
    { type: 'message', from: 'cq-a', to: 'cq-b', text: MSG_AGENT },
    { type: 'message', from: 'cq-b', to: 'user', text: MSG_USER },
    { type: 'tool', agent: 'cq-b', name: 'Read', input: { file_path: 'cue.ts' }, result: 'x', holdMs: 2500 },
    { type: 'worktree', agent: 'cq-b', status: 'active' },
    { type: 'worktree', agent: 'cq-b', status: 'merging', mergeTarget: 'main' },
    { type: 'worktree', agent: 'cq-b', status: 'merged', mergeTarget: 'main' },
    { type: 'worktree', agent: 'cq-c', status: 'conflict', mergeTarget: 'main' },
    { type: 'agentState', agent: 'cq-c', state: 'error', activity: 'Merge failed' },
    { type: 'agentState', agent: 'cq-b', state: 'done' },
    { type: 'agentState', agent: 'cq-a', state: 'done' },
    { type: 'text', text: 'Cue events done.' }
  ]
  const cueDone = (s) => s.mode === 'live' && !!wOf(s, 'cq-b')?.shutter && wOf(s, 'cq-b')?.crate === 'dock' && !!wOf(s, 'cq-c')?.barrier && s.workers[0]?.lamp === 'off'
  /** Poll the state until `pred`; `each(state)` sees every state read. Returns the satisfying state or null. */
  const watch = async (pred, timeout, each = () => {}) => {
    const end = Date.now() + t(timeout)
    while (Date.now() < end) {
      const st = await state().catch(() => null)
      if (st) {
        await each(st)
        if (pred(st)) return st
      }
      await sleep(120)
    }
    return null
  }
  /** Accumulates what the polls saw: every cue ever listed, the most stations looping, any message text in the state. */
  const collector = () => {
    const c = { cues: new Map(), maxLooping: 0, kinds: new Set(), leaked: false, each: null }
    c.each = (st) => {
      for (const q of [...(st.recentCues ?? []), ...(st.cues ?? [])]) c.cues.set(JSON.stringify(q), q)
      const looping = st.workers.filter((w) => w.ambient && w.ambient !== 'none')
      c.maxLooping = Math.max(c.maxLooping, looping.length)
      for (const w of looping) c.kinds.add(`${w.id}:${w.ambient}`)
      const json = JSON.stringify(st)
      if (TAILS.some((t) => json.includes(t))) c.leaked = true
    }
    c.has = (kind, from, to) => [...c.cues.values()].some((q) => q.kind === kind && q.from === from && (to === undefined || q.to === to))
    return c
  }
  const allowGate = async () => {
    const allow = page.locator('.decision-card .decision-footer .btn.primary').first()
    await allow.waitFor({ timeout: t(20_000) })
    await allow.click({ timeout: BUSY_CLICK_MS })
  }
  /** Start a gated run and return the state read while it waits at the gate (the scene is mounted, nothing has happened). */
  const startGated = async (label, work, delayMs) => {
    writeTimed([GATE, ...work], delayMs)
    await startLiveRun(`Factory floor cues ${label}`)
    await page.locator('.decision-card').first().waitFor({ timeout: t(30_000) })
    return untilState((s) => s.mode === 'live' && s.workers[0]?.lamp === 'needs-you', 40_000)
  }
  /**
   * Waits until the model is quiet: no cue and the workers' visible state (lamp, pose, props, crate, word) unchanged for
   * 2 s. A mock run keeps changing lamps and poses for a second or two after its last scripted marker, and each of
   * those is a real (on-demand) frame or cue, so windows that expect nothing start only after this.
   */
  const quiet = async (timeout = 20_000) => {
    const sig = (s) => JSON.stringify(s.workers.map((w) => [w.id, w.lamp, w.pose, w.shutter, w.barrier, w.crate ?? '', w.statusWord, w.fenced]))
    const end = Date.now() + t(timeout)
    let last = ''
    let since = Date.now()
    while (Date.now() < end) {
      const s = await state().catch(() => null)
      if (s) {
        const k = sig(s)
        if (k !== last || s.cues.length) {
          last = k
          since = Date.now()
        } else if (Date.now() - since >= 2000) return s
      }
      await sleep(150)
    }
    return null
  }
  /** Idle render loop (3D path): no cue, nothing looping, loop idle, frames constant over 3 s. The floor plan has no loop. */
  const idleFrames = async (label) => {
    await quiet()
    const calm = await untilState((s) => s.cues.length === 0 && s.workers.every((w) => w.ambient === 'none' && w.lamp !== 'running') && (s.renderer !== 'webgl2' || s.loop === 'idle'), 20_000)
    chk4(!!calm, `${label}: no cue, no running station and (3D) loop idle`, await state().then((s) => ({ cues: s.cues.length, loop: s.loop, running: s.workers.filter((w) => w.lamp === 'running').map((w) => w.id) })).catch(() => null))
    if (calm?.renderer === 'webgl2') {
      await sleep(1000)
      const f0 = (await state()).frames
      await sleep(3000)
      const s1 = await state()
      chk4(typeof f0 === 'number' && f0 === s1.frames && s1.loop === 'idle', `${label}: frames stay constant over 3 s and the loop is idle`, { f0, f1: s1.frames, loop: s1.loop })
      return s1.frames - f0
    } else log(`skip ${label} frames check: no 3D render loop on the floor plan`)
    return null
  }
  /** Switch to the conversation and back through the run layout toggle (the scene unmounts and mounts again). */
  const viaConversation = async () => {
    const t = page.locator('[data-testid=run-layout-toggle]')
    await t.click()
    await page.locator('[data-testid=factory-scene]').first().waitFor({ state: 'detached', timeout: t(10_000) }).catch(() => {})
    await page.locator('[data-testid=run-conversation]').first().waitFor({ timeout: t(10_000) }).catch(() => {})
    await t.click()
    await scene('live').waitFor({ timeout: t(20_000) })
    return untilState((s) => s.mode === 'live', 20_000)
  }
  /** A fresh mount reads the events as baseline: nothing cues, nothing logs, the message cursor is set, and it stays so. */
  const checkNoReplay = async (label, via, motion) => {
    // Remount once the run is quiet: a change after the new mount is a real event and may cue.
    await quiet()
    const st = await via()
    chk4(!!st && st.cuesStarted === 0 && st.recentCues.length === 0 && st.cues.length === 0, `${label}: a fresh mount starts no cue`, st && { cuesStarted: st.cuesStarted, recent: st.recentCues.length, cues: st.cues.length })
    chk4(!!st && st.logEntries === 0, `${label}: a fresh mount has an empty floor log`, st?.logEntries)
    chk4(!!st && typeof st.messageCursor === 'string' && st.messageCursor.length > 0, `${label}: the message cursor is set at mount`, st?.messageCursor)
    if (motion) chk4(st?.motion === motion, `${label}: the mount's motion is ${motion}`, st?.motion)
    await sleep(3000)
    const st2 = await state().catch(() => null)
    chk4(!!st2 && st2.cuesStarted === 0 && st2.recentCues.length === 0 && st2.logEntries === 0, `${label}: still nothing cued or logged 3 s later`, st2 && { cuesStarted: st2.cuesStarted, recent: st2.recentCues.length, log: st2.logEntries })
    return st2
  }
  const pauseBtn = page.locator('[data-testid=factory-pause-motion]')
  const focusedTestId = () => page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? null)
  /** Section 6.7: walk the toolbar from Fit to Pause motion with the keyboard (Tab, then ArrowRight if the row roves). Returns the key that worked. */
  const reachPauseByKeyboard = async () => {
    for (const key of ['Tab', 'ArrowRight', 'Shift+Tab']) {
      await page.locator('[data-testid=factory-fit]').focus()
      for (let i = 0; i < 8; i++) {
        if ((await focusedTestId()) === 'factory-pause-motion') return key
        await page.keyboard.press(key)
        await sleep(80)
      }
      if ((await focusedTestId()) === 'factory-pause-motion') return key
    }
    return null
  }
  const pressed = () => pauseBtn.getAttribute('aria-pressed')
  /** Section 5.5 invariants for any state written under reduced motion or Pause motion. `base` is the state read at the gate. */
  const quietViolations = (s, base) => {
    const bad = []
    if (s.cues.length) bad.push(`cues active ${JSON.stringify(s.cues)}`)
    if (s.cuesStarted !== base.cuesStarted) bad.push(`cuesStarted ${s.cuesStarted} != ${base.cuesStarted}`)
    if (s.recentCues.length !== base.recentCues.length) bad.push(`recentCues grew to ${s.recentCues.length}`)
    for (const w of s.workers) {
      if (w.ambient !== 'none') bad.push(`${w.id} ambient ${w.ambient}`)
      if (w.barrier !== (w.lamp === 'failed')) bad.push(`${w.id} barrier ${w.barrier} with lamp ${w.lamp}`)
      if (w.barrier && w.pose !== 'down') bad.push(`${w.id} barrier but pose ${w.pose}`)
      if (w.shutter && w.pose !== 'docked') bad.push(`${w.id} shutter but pose ${w.pose}`)
      if (w.crate === 'dock' && w.fenced) bad.push(`${w.id} crate on the dock but still fenced`)
      if (w.lamp === 'needs-you' && w.pose !== 'signal') bad.push(`${w.id} needs-you but pose ${w.pose}`)
    }
    return bad
  }

  // -- Pre-mount events are baseline: the whole script runs, THEN the scene mounts again (graph, then Factory Floor). --
  writeTimed(cueEvents(), 300)
  await startLiveRun('Factory floor cues before mount')
  const preDone = await watch(cueDone, 90_000)
  chk4(!!preDone, 'pre-mount run: the events finished (cq-b shutter and dock crate, cq-c barrier, root idle)', await state().then((s) => s.workers.map((w) => `${w.id}:${w.lamp}`)).catch(() => null))
  await sleep(2500)
  await checkNoReplay('remount after events (presentation switch)', async () => {
    await remount()
    await scene('live').waitFor({ timeout: t(20_000) })
    return untilState((s) => s.mode === 'live' && wOf(s, 'cq-b'), 20_000)
  })
  const baseline = await state().catch(() => null)
  if (baseline) {
    // Everything already true at mount is shown in its end state (section 1.4), without a cue.
    chk4(!!wOf(baseline, 'cq-b')?.shutter && wOf(baseline, 'cq-b')?.crate === 'dock' && wOf(baseline, 'cq-b')?.pose === 'docked', 'mount after events: cq-b is docked with its crate on the dock', wOf(baseline, 'cq-b'))
    chk4(!!wOf(baseline, 'cq-c')?.barrier && wOf(baseline, 'cq-c')?.lamp === 'failed', 'mount after events: cq-c shows its barrier and Failed lamp', wOf(baseline, 'cq-c'))
    chk4(baseline.cuePeaks.carriers === 0 && baseline.cuePeaks.parts === 0 && baseline.cuePeaks.crates === 0 && baseline.cuePeaks.ambient === 0, 'mount after events: no cue peak was ever reached', baseline.cuePeaks)
  }
  await idleFrames('idle run after remount')

  // -- Full motion: events after mount cue; the floor log lists what moved. --
  const basePre = await startGated('full motion', cueEvents(), 500)
  chk4(!!basePre && basePre.motion === 'full', 'full motion run: the scene starts in motion full', basePre?.motion)
  chk4(!!basePre && Array.isArray(basePre.recentCues) && basePre.cuePeaks && typeof basePre.logEntries === 'number' && 'messageCursor' in basePre, 'the test state carries recentCues, cuePeaks, logEntries and messageCursor', basePre && Object.keys(basePre))
  // Pause motion exists in live mode only (Team never mounts the scene, checked above), is in the toolbar and a toggle.
  const bar = page.locator('[data-testid=factory-controls]').first()
  chk4((await pauseBtn.count()) === 1 && (await bar.locator('[data-testid=factory-pause-motion]').count()) === 1, 'Pause motion is one button inside the factory toolbar in live mode', await pauseBtn.count())
  chk4((await pauseBtn.getAttribute('aria-pressed')) === 'false', 'Pause motion starts not pressed (aria-pressed false)', await pauseBtn.getAttribute('aria-pressed'))
  const logBefore = page.locator('[data-testid=factory-log]').first()
  chk4((await logBefore.count()) === 1 && (await logBefore.evaluate((d) => d.tagName === 'DETAILS' && !d.open)), 'the floor log is a closed details by default', await logBefore.count())
  const col = collector()
  col.each(basePre ?? { recentCues: [], cues: [], workers: [] })
  await allowGate()
  const fullDone = await watch(cueDone, 90_000, col.each)
  chk4(!!fullDone, 'full motion run: the events finished', await state().then((s) => s.workers.map((w) => `${w.id}:${w.lamp}`)).catch(() => null))
  const fin = fullDone ?? (await state())
  chk4(fin.cuesStarted > basePre.cuesStarted, 'events after mount start cues (cuesStarted grows)', { before: basePre.cuesStarted, after: fin.cuesStarted })
  chk4(col.has('capsule', 'cq-a', 'cq-b'), 'a message to an agent is a capsule from the sender to the recipient', [...col.cues.values()].filter((q) => q.kind === 'capsule'))
  chk4(col.has('capsule', 'cq-b', null), 'a message to the user is a capsule with to null', [...col.cues.values()].filter((q) => q.kind === 'capsule'))
  chk4(col.has('tote', 'cq-a', 'cq-b'), 'a spawn with a parent flies a tote from the parent to the child', [...col.cues.values()].filter((q) => q.kind === 'tote'))
  chk4(col.has('arrive', 'cq-b'), 'the spawned station gets an arrive cue', [...col.cues.values()].filter((q) => q.kind === 'arrive'))
  chk4(col.has('part', 'cq-b'), 'a tool call on a station pops a part there', [...col.cues.values()].filter((q) => q.kind === 'part'))
  chk4(col.has('crate', 'cq-b', 'dock'), 'a branch merged into main sends a crate to the dock', [...col.cues.values()].filter((q) => q.kind === 'crate'))
  chk4([...col.kinds].some((k) => k.startsWith('cq-b:')), 'a running station loops (cq-b has an ambient loop while it works)', [...col.kinds])
  chk4(!col.leaked, 'message text never appears in the factory-state JSON (sampled on every poll)')
  chk4(fin.cuePeaks.carriers >= 1 && fin.cuePeaks.carriers <= 6 && fin.cuePeaks.perSender <= 2, 'the cue peaks count the carriers within the caps', fin.cuePeaks)
  // The floor log: opens, lists what moved, newest first, matches logEntries.
  const logEl = page.locator('[data-testid=factory-log]').first()
  const logN = await untilState((s) => s.logEntries >= 8, 8000)
  chk4(!!logN, 'the floor log holds at least 8 entries for the scripted events', await state().then((s) => s.logEntries).catch(() => null))
  await logEl.locator('summary').click()
  await sleep(300)
  const stLog = await state()
  const summaryText = ((await logEl.locator('summary').textContent()) ?? '').replace(/\s+/g, ' ').trim()
  chk4(summaryText === `Floor log ${stLog.logEntries}`, 'the summary says "Floor log n" with n = logEntries', { summaryText, logEntries: stLog.logEntries })
  const readEntries = () => page.locator('[data-testid=factory-log-entry]').evaluateAll((els) => els.map((e) => ({ text: (e.textContent ?? '').replace(/\s+/g, ' ').trim(), at: e.querySelector('time')?.getAttribute('datetime') ?? null })))
  let entries = await readEntries()
  // The state and the list are two reads: an entry that arrives between them makes them differ by one (windows-latest,
  // 2026-11-23: 15 rendered against 14). Read both again until they agree, for a few seconds.
  let logCount = stLog.logEntries
  for (let i = 0; i < 20 && entries.length !== logCount; i++) {
    await sleep(250)
    logCount = (await state()).logEntries
    entries = await readEntries()
  }
  chk4(entries.length === logCount && entries.length <= 50, 'one factory-log-entry per entry (at most 50)', { rendered: entries.length, logEntries: logCount })
  const idx = (re) => entries.findIndex((e) => re.test(e.text))
  const wordB = wOf(stLog, 'cq-b')?.statusWord
  const wordC = wOf(stLog, 'cq-c')?.statusWord
  const expectLines = [
    // The child's name is the label at its first upsert: the mock's spawn upsert has no handle yet, so it is the role
    // name ("Implementer"), not "cq-b" (recorded as an open item in the spec's slice 4 notes).
    ['assigned', /cq-a assigned work to \S+/],
    ['message to an agent with the quoted text', new RegExp(`cq-a to cq-b: .{0,2}${MSG_AGENT}`)],
    ['message to the user with the quoted text', new RegExp(`cq-b to \\S+: .{0,2}${MSG_USER}`)],
    ['state word of the failed worker', new RegExp(`cq-c: ${wordC}`)],
    ['state word of the finished worker', new RegExp(`cq-b: ${wordB}`)],
    ['merged into the main checkout', /cq-b[’']s branch merged into the main checkout/],
    ['merge conflict', /cq-c[’']s branch has a merge conflict/]
  ]
  for (const [what, re] of expectLines) chk4(idx(re) >= 0, `the floor log has the ${what} line`, entries.slice(0, 12).map((e) => e.text))
  chk4(wordC === 'Failed', 'cq-c reads Failed in the state', wordC)
  const iAssigned = idx(/cq-a assigned work to \S+/)
  const iMerged = idx(/branch merged into the main checkout/)
  const iConflict = idx(/branch has a merge conflict/)
  chk4(iAssigned >= 0 && iMerged >= 0 && iConflict >= 0 && iConflict < iMerged && iMerged < iAssigned, 'the floor log is newest first (conflict above merged above assigned)', { iAssigned, iMerged, iConflict })
  const times = entries.map((e) => Date.parse(e.at ?? '')).filter((t) => !Number.isNaN(t))
  chk4(times.length === 0 || times.every((t, i) => i === 0 || t <= times[i - 1]), 'entry times never increase down the list', times.slice(0, 6))
  chk4((await page.locator('[data-testid=factory-log] [aria-live], [data-testid=factory-log][aria-live]').count()) === 0, 'the floor log is not a live region')
  await shot('cues-log-open')
  // Idle after the run, then remount: the events of this run are baseline for the next mount.
  await idleFrames('full motion run at rest')
  await checkNoReplay('remount via the conversation', viaConversation, 'full')
  await checkNoReplay('remount via the presentation switch', async () => {
    await remount()
    await scene('live').waitFor({ timeout: t(20_000) })
    return untilState((s) => s.mode === 'live', 20_000)
  }, 'full')

  // -- Burst: the caps of section 5.2 hold. --
  /**
   * The burst script for `leads` and `workers` (ids). `hold`: ms to wait after the last burst event; `finish`: mark every agent
   * done at the end (false leaves the workers running so a later window can measure ambient-only frames).
   */
  const burstSteps = (leads, workers, { hold = 2500, finish = true } = {}) => [
    ...leads.map((id) => ({ type: 'spawn', id, name: id, role: slug, description: `Burst ${id}` })),
    ...workers.map((id, i) => ({ type: 'spawn', id, name: id, role: slug, parent: leads[i % leads.length], description: `Burst ${id}` })),
    // Four senders, six messages each to different recipients, interleaved, plus workers messaging the user.
    ...Array.from({ length: 6 }, (_, k) => leads.map((l, li) => ({ type: 'message', from: l, to: workers[(li * 3 + k) % workers.length], text: `Burst ${l} note ${k}` }))).flat(),
    ...workers.slice(0, 3).map((w) => ({ type: 'message', from: w, to: 'user', text: `Burst ${w} done` })),
    // Many stations, two tool calls each.
    ...[0, 1].flatMap((r) => workers.map((w) => ({ type: 'tool', agent: w, name: 'Read', input: { file_path: `${w}-${r}.ts` }, result: 'x' }))),
    // Stations that keep running: 7 at their machine, the rest at the console, over the cap of 12 (4 leads are delegating too).
    ...workers.map((w, i) => ({ type: 'agentState', agent: w, state: i < 7 ? 'tool' : 'thinking', activity: 'Burst work' })),
    // Several merges at once: all merging, then all merged (6 crates against a cap of 4), two conflicts.
    ...workers.slice(0, 6).map((w) => ({ type: 'worktree', agent: w, status: 'merging', mergeTarget: 'main' })),
    ...workers.slice(0, 6).map((w) => ({ type: 'worktree', agent: w, status: 'merged', mergeTarget: 'main' })),
    ...workers.slice(6, 8).map((w) => ({ type: 'worktree', agent: w, status: 'conflict', mergeTarget: 'main' })),
    ...(hold ? [{ type: 'wait', ms: hold }] : []),
    ...(finish ? [...workers, ...leads].map((id) => ({ type: 'agentState', agent: id, state: 'done' })) : []),
    { type: 'text', text: 'Burst done.' }
  ]
  const leads = ['bl1', 'bl2', 'bl3', 'bl4']
  const workers = Array.from({ length: 14 }, (_, i) => `bw${String(i + 1).padStart(2, '0')}`)
  const burst = burstSteps(leads, workers)
  const burstBase = await startGated('burst', burst, 25)
  chk4(!!burstBase, 'burst run: the scene is mounted at the gate', null)
  const bcol = collector()
  await allowGate()
  const burstDone = await watch((s) => s.mode === 'live' && workers.every((w) => wOf(s, w)?.shutter) && s.workers[0]?.lamp === 'off', 240_000, bcol.each)
  chk4(!!burstDone, 'burst run: every station finished', await state().then((s) => ({ n: s.workers.length, shutters: s.workers.filter((w) => w.shutter).length })).catch(() => null))
  const bst = burstDone ?? (await state())
  const pk = bst.cuePeaks
  log('burst peaks:', JSON.stringify(pk), 'cuesStarted', bst.cuesStarted, 'log', bst.logEntries, 'max looping seen', bcol.maxLooping)
  chk4(pk.carriers <= 6 && pk.perSender <= 2, 'burst: at most 6 carriers in flight and 2 per sender', pk)
  chk4(pk.parts <= 12, 'burst: at most 12 parts in flight', pk)
  chk4(pk.crates <= 4, 'burst: at most 4 crates in flight', pk)
  chk4(pk.arrivalsPerSecond <= 12, 'burst: at most 12 arrivals animate per second', pk)
  chk4(pk.ambient <= 12 && bcol.maxLooping <= 12, 'burst: at most 12 stations loop at once', { pk: pk.ambient, polled: bcol.maxLooping })
  chk4(pk.carriers >= 1 && pk.parts >= 1 && pk.crates >= 1 && pk.arrivalsPerSecond >= 1, 'burst: the counters saw carriers, parts, crates and arrivals', pk)
  // The scheduler's own peak is the evidence. The polled maximum can be 0 on a slow runner (Windows CI, SwiftShader):
  // the test state is written twice a second and the burst's running window can fall between two polls.
  chk4(pk.ambient > 0, 'burst: stations that run do loop (ambient peak above 0)', { pk: pk.ambient, polled: bcol.maxLooping })
  // 18 assignments, 27 messages, 18 finished words and 8 merge lines are far more than 50: the cap is what holds.
  chk4(bst.logEntries === 50, 'burst: the floor log is capped at 50 (the burst has more than 50 events)', bst.logEntries)
  const burstOpen = await page.locator('[data-testid=factory-log]').first().evaluate((d) => d.open)
  if (!burstOpen) await page.locator('[data-testid=factory-log] summary').first().click()
  await sleep(300)
  const burstRendered = await page.locator('[data-testid=factory-log-entry]').count()
  const stBurst = await state()
  chk4(burstRendered === stBurst.logEntries && burstRendered <= 50, 'burst: the open log renders exactly logEntries entries (at most 50)', { burstRendered, logEntries: stBurst.logEntries })
  await idleFrames('burst run at rest')

  // ---------- Slice 6: 40-agent stress (sections 9.1 and 12) ----------
  // Root, 4 leads and 35 workers (exactly 40 agents) at 1600 x 1000 with the whole burst on top, so every cue cap is reached.
  // The draw calls, shadow calls, triangles, label cap, ambient cap and frame timings are read while it runs (fit), again in
  // an ambient-only window (frames over a few seconds), and at near zoom. The structural numbers are always asserted on the
  // 3D path; the timing targets only with E2E_FACTORY_PERF=1 on a real GPU (otherwise recorded for the PERF block).
  const perfCheck = (ok, name, got) => {
    // A software renderer's timings say nothing about section 9.1: with the flag they are still recorded, not asserted.
    const software = SOFTWARE_GPU.test(rec.gpu ?? '')
    if (PERF && !software) chk6(ok, `[perf] ${name}`, got)
    else log(`${ok ? 'within' : 'over'} target (recorded only${PERF ? ': software renderer' : ''}): ${name} ${typeof got === 'string' ? got : JSON.stringify(got)}`)
  }
  /** Frames per second from state reads: the time each distinct frame count was first seen, over `ms`. */
  const frameRate = async (ms) => {
    const seen = []
    const end = Date.now() + ms // a sampling window, not a wait: never scaled
    while (Date.now() < end) {
      const s = await state().catch(() => null)
      if (s && (seen.length === 0 || seen[seen.length - 1].frames !== s.frames)) seen.push({ frames: s.frames, at: Date.now() })
      await sleep(80)
    }
    if (seen.length < 2) return { fps: 0, frames: 0, seconds: ms / 1000 }
    const a = seen[0]
    const b = seen[seen.length - 1]
    return { fps: ((b.frames - a.frames) * 1000) / (b.at - a.at), frames: b.frames - a.frames, seconds: (b.at - a.at) / 1000 }
  }
  const sLeads = ['sl1', 'sl2', 'sl3', 'sl4']
  const sWorkers = Array.from({ length: 35 }, (_, i) => `sw${String(i + 1).padStart(2, '0')}`)
  await resizeTo(1600, 1000)
  const stressBase = await startGated('stress forty agents', burstSteps(sLeads, sWorkers, { hold: 0, finish: false }), 25)
  chk6(!!stressBase, '40-agent stress: the scene is mounted at the gate (1600x1000)', null)
  const scol = collector()
  const mx = { calls: 0, shadow: 0, tris: 0, frameP95: 0, intervalP95: 0, plates: 0, animated: 0, reads: 0, qualities: new Set() }
  let tick = 0
  let burstFrom = Date.now()
  const sampleStress = async (s) => {
    scol.each(s)
    mx.qualities.add(s.quality)
    if (s.renderer !== 'webgl2' || !s.perf) return
    const p = s.perf
    mx.reads++
    mx.calls = Math.max(mx.calls, p.drawCalls)
    mx.shadow = Math.max(mx.shadow, p.shadowCalls)
    mx.tris = Math.max(mx.tris, p.triangles)
    // Timing rings fill while frames render: count a read once a cue is in flight and the burst is a second old.
    if (s.cues.length > 0 && Date.now() - burstFrom > 1000) {
      mx.animated++
      mx.frameP95 = Math.max(mx.frameP95, p.frameP95Ms)
      mx.intervalP95 = Math.max(mx.intervalP95, p.intervalP95Ms)
    }
    if (++tick % 3 === 0) mx.plates = Math.max(mx.plates, await shownPlates())
  }
  // The burst can leave the renderer busy for minutes (CI windows-latest: the stress run took 203 s and a poll from here read
  // one state with perf data in all that time: every CDP read waited behind the renderer's own work). So the budgets are
  // also read inside the page, on every write of the test state (a MutationObserver sees each one, whatever the main thread
  // was doing in between), and merged below with what the polls from here saw.
  await page.evaluate(() => {
    const mx = { reads: 0, calls: 0, shadow: 0, tris: 0, plates: 0, animated: 0, frameP95: 0, intervalP95: 0, qualities: [] }
    window.__ffMx = mx
    window.__ffMxFrom = performance.now()
    window.__ffMxObserver?.disconnect()
    const el = document.querySelector('[data-testid=factory-state]')
    if (!el) return
    let tick = 0
    window.__ffMxObserver = new MutationObserver(() => {
      try {
        const s = JSON.parse(el.textContent || '{}')
        if (s.quality && !mx.qualities.includes(s.quality)) mx.qualities.push(s.quality)
        if (s.renderer !== 'webgl2' || !s.perf) return
        const p = s.perf
        mx.reads++
        mx.calls = Math.max(mx.calls, p.drawCalls)
        mx.shadow = Math.max(mx.shadow, p.shadowCalls)
        mx.tris = Math.max(mx.tris, p.triangles)
        if ((s.cues ?? []).length > 0 && performance.now() - window.__ffMxFrom > 1000) {
          mx.animated++
          mx.frameP95 = Math.max(mx.frameP95, p.frameP95Ms)
          mx.intervalP95 = Math.max(mx.intervalP95, p.intervalP95Ms)
        }
        if (++tick % 3 === 0) mx.plates = Math.max(mx.plates, document.querySelectorAll('[data-testid=factory-nameplate][data-shown="true"]').length)
      } catch {
        // a half-written state: the next write is read again
      }
    })
    window.__ffMxObserver.observe(el, { childList: true, characterData: true, subtree: true })
  })
  burstFrom = Date.now()
  await allowGate()
  // Section 9.1's method for the frame interval: rAF timestamps over 5 s from the start of the burst (once the gate is
  // released, so no pre-burst idle frames dilute it), in the page.
  await page.evaluate(() => {
    window.__ffMxFrom = performance.now()
    const ts = []
    window.__ffRaf = ts
    const end = performance.now() + 5000
    const step = (t) => {
      ts.push(t)
      if (t < end) requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
  })
  const stressRun = await watch((s) => s.mode === 'live' && s.workers.length === 40 && sWorkers.slice(0, 6).every((w) => wOf(s, w)?.crate === 'dock') && s.cues.length === 0, 300_000, sampleStress)
  chk6(!!stressRun, '40-agent stress: all 40 agents are on the floor and the six merged crates reached the dock', await state().then((s) => ({ n: s.workers.length, cues: s.cues.length })).catch(() => null))
  const sst = stressRun ?? (await state())
  // What the page read on its own writes (see above) joins what the polls saw; each figure is a peak, so the larger one stands.
  const pm = await page.evaluate(() => (window.__ffMxObserver?.disconnect(), window.__ffMx ?? null)).catch(() => null)
  if (pm) {
    log('stress burst reads: polled', mx.reads, 'in the page', pm.reads, `(${pm.animated} with a cue in flight)`)
    mx.reads = Math.max(mx.reads, pm.reads)
    mx.animated = Math.max(mx.animated, pm.animated)
    for (const k of ['calls', 'shadow', 'tris', 'plates', 'frameP95', 'intervalP95']) mx[k] = Math.max(mx[k], pm[k])
    for (const q of pm.qualities) mx.qualities.add(q)
  }
  const spk = sst.cuePeaks
  log('stress burst peaks:', JSON.stringify(spk), 'cuesStarted', sst.cuesStarted, 'looping seen', scol.maxLooping, 'renderer', sst.renderer, 'quality', sst.qualityStart, '->', sst.quality)
  chk6(spk.carriers <= 6 && spk.perSender <= 2 && spk.parts <= 12 && spk.crates <= 4 && spk.arrivalsPerSecond <= 12, '40-agent stress: carriers 6 (2 per sender), parts 12, crates 4 and arrivals 12 per second are never exceeded', spk)
  chk6(spk.ambient <= 12 && scol.maxLooping <= 12, '40-agent stress: at most 12 stations loop at once (peak and polled)', { peak: spk.ambient, polled: scol.maxLooping })
  chk6(spk.carriers >= 1 && spk.parts >= 1 && spk.crates >= 1 && spk.arrivalsPerSecond >= 1 && spk.ambient > 0, '40-agent stress: the counters saw carriers, parts, crates, arrivals and ambient loops', spk)
  rec['stress cue peaks'] = JSON.stringify(spk)
  if (PERF) chk6(spk.carriers === 6 && spk.parts === 12 && spk.crates === 4 && spk.ambient === 12, '[perf] 40-agent stress: every cue cap is full (carriers 6, parts 12, crates 4, ambient 12)', spk)
  if (sst.renderer === 'webgl2') {
    // How many states the poll catches during the burst depends on the runner: a slow windows-latest run read 4
    // (2026-11-23). Three reads still make the peaks below a peak, not a single sample.
    chk6(mx.reads >= 3, '40-agent stress: the budgets were read on at least 3 states during the burst', mx.reads)
    chk6(mx.calls <= BUDGET.drawCalls, `40-agent stress (fit, burst): draw calls stay at most ${BUDGET.drawCalls} (peak of ${mx.reads} reads)`, mx.calls)
    chk6(mx.shadow <= BUDGET.shadowCalls, `40-agent stress (fit, burst): shadow-pass calls stay at most ${BUDGET.shadowCalls}`, mx.shadow)
    chk6(mx.tris <= BUDGET.triangles, `40-agent stress (fit, burst): triangles stay at most ${BUDGET.triangles}`, mx.tris)
    chk6(mx.plates <= BUDGET.plates, `40-agent stress (fit, burst): at most ${BUDGET.plates} nameplates are shown`, mx.plates)
    rec['stress burst frameP95Ms (max)'] = mx.frameP95
    rec['stress burst intervalP95Ms (max)'] = mx.intervalP95
    rec['stress burst budgets (draw/shadow/triangles/plates)'] = `${mx.calls}/${mx.shadow}/${mx.tris}/${mx.plates}`
    rec['stress animated reads'] = mx.animated
    perfCheck(mx.animated >= 3 && mx.frameP95 <= 6, 'frame CPU time p95 at most 6 ms during the burst (40 agents, 1600x1000, caps full)', { frameP95Ms: mx.frameP95, reads: mx.animated })
    // The engine's ring (last 120 full-rate intervals) is recorded as a worst rolling read; the asserted figure is the
    // spec's: the p95 of page rAF intervals over the burst's first 5 s.
    const raf = await page.evaluate(() => {
      const ts = window.__ffRaf ?? []
      const d = ts.slice(1).map((t, i) => t - ts[i]).sort((a, b) => a - b)
      // The display period is the median interval; "dropped" are intervals over 1.5 periods (the 20 ms target is for 60 Hz).
      const period = d.length ? d[Math.floor(d.length / 2)] : 0
      const dropped = d.filter((x) => x > 1.5 * period).length
      return { n: d.length, p95: d.length ? d[Math.min(d.length - 1, Math.ceil(d.length * 0.95) - 1)] : 0, max: d.length ? d[d.length - 1] : 0, period, droppedShare: d.length ? dropped / d.length : 0 }
    })
    rec['stress burst rAF interval p95 over 5 s (page)'] = `${raf.p95.toFixed(1)} ms over ${raf.n} intervals, max ${raf.max.toFixed(1)} ms, display period ${raf.period.toFixed(1)} ms, ${(raf.droppedShare * 100).toFixed(1)} % over 1.5 periods`
    perfCheck(raf.n >= 100 && raf.p95 <= 20, 'frame interval p95 at most 20 ms during the burst (page rAF over 5 s)', raf)
    checkQualityState('40-agent stress after the burst', sst)
    rec.qualityStart = sst.qualityStart
    rec.qualityAfterBurst = sst.quality
    rec.memoryBytes = sst.perf?.memoryBytes
    rec.pixelRatio = sst.perf?.pixelRatio
    rec.gpu = sst.perf?.gpu ?? rec.gpu ?? '(not exposed)'

    // Ambient-only: running stations loop, no cue, no camera move.
    const amb = await quiet(40_000)
    const ambRunning = amb ? amb.workers.filter((w) => w.lamp === 'running').length : 0
    const ambLooping = amb ? amb.workers.filter((w) => w.ambient !== 'none').length : 0
    chk6(!!amb && ambRunning > 12 && ambLooping >= 1 && ambLooping <= 12, '40-agent stress: more than 12 stations run and 1 to 12 of them loop (no cue in flight)', { running: ambRunning, looping: ambLooping })
    const fr = await frameRate(4000)
    rec['ambient-only frames per second'] = Number(fr.fps.toFixed(1))
    rec['ambient-only frames/seconds'] = `${fr.frames}/${fr.seconds.toFixed(2)}`
    chk6(fr.frames > 0, '40-agent stress: the render loop runs while stations loop (frames grow in the ambient window)', fr)
    perfCheck(fr.fps <= 31, 'ambient-only frame rate at most 31 fps', { fps: Number(fr.fps.toFixed(1)), frames: fr.frames, seconds: Number(fr.seconds.toFixed(2)) })
    const ambState = await untilPerf(5000)
    await checkBudgets('40-agent stress at fit (ambient)', ambState)
    checkQualityState('40-agent stress at fit (ambient)', ambState)

    // Near zoom: the LOD that draws the most.
    const near = await zoomNear()
    rec['near zoom ppm'] = near.ppm
    chk6(near.ppm >= 24, '40-agent stress: the toolbar zoom reaches the near band (ppm 24 or more)', near)
    await sleep(700)
    const nearState = await untilPerf(5000)
    chk6(!!nearState && nearState.workers.length === 40, '40-agent stress at near zoom: still 40 workers', nearState?.workers.length)
    await checkBudgets('40-agent stress at near zoom', nearState)
    checkQualityState('40-agent stress at near zoom', nearState)
    await page.locator('[data-testid=factory-fit]').click()
    await untilState((s) => Math.abs(s.view.ppm - near.ppm) > 1, 4000)
    await settledView()
    // PERF: quality never stepped down on a GPU.
    mx.qualities.add((await state()).quality)
    rec.qualitiesSeen = [...mx.qualities].join(',')
    if (PERF && !SOFTWARE_GPU.test(rec.gpu ?? '')) chk6(sst.qualityStart === 'high' && [...mx.qualities].every((q) => q === 'high'), '[perf] qualityStart and quality are high on a GPU through the whole stress run', { start: sst.qualityStart, seen: [...mx.qualities] })
  } else log('skip the 40-agent stress budgets: the floor plan has no render pass')
  // The stress floor at rest: ending the session stops every station; the render loop goes idle (0 frames in 3 s).
  await endSession(page)
  const idleDelta = await idleFrames('40-agent stress run at rest')
  if (idleDelta !== null) rec['idle frames over 3 s'] = idleDelta
  await resizeTo(1024, 640)

  // -- Reduced motion (html data-reduce-motion="on") and Pause motion: end states at once, no cue, no loop. --
  const quietRun = async (mode) => {
    const want = mode === 'reduced' ? 'reduced' : 'paused'
    if (mode === 'reduced') await setReduceMotion(page, 'on')
    let base = await startGated(`${mode}`, cueEvents(), 400)
    chk4(!!base, `${mode}: the scene is mounted at the gate`, null)
    if (!base) return
    if (mode === 'paused') {
      const how = await reachPauseByKeyboard()
      chk4(!!how, 'Pause motion is reachable by keyboard in the toolbar', how)
      if (!how) await pauseBtn.focus()
      await page.keyboard.press('Space')
      await page.waitForFunction(() => document.querySelector('[data-testid=factory-pause-motion]')?.getAttribute('aria-pressed') === 'true', null, { timeout: t(5000) }).catch(() => {})
      chk4((await pressed()) === 'true', 'Pause motion pressed: aria-pressed true', await pressed())
      // Keyboard toggle both ways, then pressed again for the run.
      await page.keyboard.press('Space')
      chk4((await pressed()) === 'false', 'Space toggles Pause motion off again', await pressed())
      await page.keyboard.press('Space')
      chk4((await pressed()) === 'true', 'Space toggles Pause motion on again', await pressed())
    }
    base = await untilState((s) => s.motion === want, 8000)
    chk4(!!base, `${mode}: the test state motion is ${want}`, await state().then((s) => s.motion).catch(() => null))
    if (!base) return
    chk4((await scene('live').getAttribute('data-motion')) === want, `${mode}: factory-scene data-motion is ${want}`, await scene('live').getAttribute('data-motion'))
    chk4(base.cues.length === 0 && base.workers.every((w) => w.ambient === 'none'), `${mode}: no cue and no ambient loop at the gate`, base.cues)
    if (mode === 'reduced') chk4(base.cuesStarted === 0 && base.recentCues.length === 0, 'reduced: no cue was ever started', { cuesStarted: base.cuesStarted, recent: base.recentCues.length })
    const bad = []
    const qcol = collector()
    await allowGate()
    const done = await watch(cueDone, 90_000, (s) => {
      qcol.each(s)
      bad.push(...quietViolations(s, base).map((v) => v))
    })
    chk4(!!done, `${mode}: the events finished and the end states are on the floor`, await state().then((s) => s.workers.map((w) => `${w.id}:${w.lamp}`)).catch(() => null))
    chk4(bad.length === 0, `${mode}: every state written has no cue, no ambient and consistent end states (lamp, pose, shutter, barrier, crate)`, [...new Set(bad)].slice(0, 6))
    const fin = done ?? (await state())
    chk4(fin.cuesStarted === base.cuesStarted && fin.recentCues.length === base.recentCues.length, `${mode}: cuesStarted did not change over the events`, { before: base.cuesStarted, after: fin.cuesStarted })
    chk4(fin.cuePeaks.carriers === base.cuePeaks.carriers && fin.cuePeaks.parts === base.cuePeaks.parts && fin.cuePeaks.crates === base.cuePeaks.crates && fin.cuePeaks.ambient === base.cuePeaks.ambient, `${mode}: the cue peaks did not move (peaks count since mount; the root may have looped before Pause was pressed)`, { base: base.cuePeaks, after: fin.cuePeaks })
    chk4(fin.motion === want, `${mode}: motion stays ${want} through the events`, fin.motion)
    chk4(!qcol.leaked, `${mode}: message text never appears in the factory-state JSON`)
    // The end states are final facts, not tweens.
    chk4(wOf(fin, 'cq-b')?.pose === 'docked' && wOf(fin, 'cq-b')?.crate === 'dock' && wOf(fin, 'cq-c')?.pose === 'down' && wOf(fin, 'cq-c')?.lamp === 'failed', `${mode}: cq-b is docked with its dock crate, cq-c is down and Failed`, [wOf(fin, 'cq-b'), wOf(fin, 'cq-c')])
    // The log still lists what happened (it is text, not motion).
    chk4(fin.logEntries >= 8, `${mode}: the floor log still lists the events`, fin.logEntries)
    if (fin.renderer === 'webgl2') {
      await quiet()
      const idle = await untilState((s) => s.loop === 'idle', 6000)
      chk4(!!idle, `${mode}: the render loop is idle shortly after the events`, await state().then((s) => s.loop).catch(() => null))
      await sleep(800)
      const f0 = (await state()).frames
      await sleep(3000)
      const s1 = await state()
      chk4(f0 === s1.frames && s1.loop === 'idle', `${mode}: frames do not grow over 3 s with nothing changing`, { f0, f1: s1.frames, loop: s1.loop })
    } else log(`skip ${mode} loop and frames checks: no 3D render loop on the floor plan`)
    if (mode === 'paused') {
      // Pause motion is remembered across remounts for the session (a module-level value).
      for (const [label, via] of [['the conversation', viaConversation], ['the presentation switch', async () => { await remount(); await scene('live').waitFor({ timeout: t(20_000) }); return untilState((s) => s.mode === 'live', 20_000) }]]) {
        await checkNoReplay(`paused, remount via ${label}`, via, 'paused')
        await pauseBtn.waitFor({ timeout: t(10_000) })
        chk4((await pressed()) === 'true', `paused, remount via ${label}: Pause motion is still pressed`, await pressed())
      }
    }
  }
  await quietRun('reduced')
  chk4((await html('data-reduce-motion')) === 'on', 'reduced: the html attribute data-reduce-motion is on', await html('data-reduce-motion'))
  await setReduceMotion(page, 'off')
  const afterReduced = await untilState((s) => s.motion === 'full', 8000)
  chk4(!!afterReduced, 'turning reduced motion off returns the scene to full motion', await state().then((s) => s.motion).catch(() => null))
  await quietRun('paused')
  // Release Pause motion so nothing later runs paused (the value lives for the app session).
  if ((await pauseBtn.count()) && (await pressed()) === 'true') {
    await pauseBtn.click()
    chk4(!!(await untilState((s) => s.motion === 'full', 8000)), 'a second press of Pause motion returns the scene to full motion', await state().then((s) => s.motion).catch(() => null))
  }
  await shot('cues-done')
  writeScript(null)

  // ---------- Slice 6: Large team fallback (section 8): more than 120 current-session agents ----------
  // The mock takes any number of scripted spawns: a `spawn` step is never checked against the root's spawnable list or
  // against maxConcurrentSubagents (src/main/runtime/mock.ts, spawnStep and the deep-tree comment: scripted spawns are the
  // harness's own fixture), so 121 spawns under the root put 122 current-session agents on the floor. The reason is judged in
  // FactoryScene's order (forced, no WebGL2, too many, ...), so the notice can only show where the 3D path would run.
  if (liveRenderer === 'webgl2' && !PLAN) {
    const LARGE = 121
    const big = Array.from({ length: LARGE }, (_, i) => ({ type: 'spawn', id: `lt${String(i + 1).padStart(3, '0')}`, name: `lt${String(i + 1).padStart(3, '0')}`, role: slug, description: `Large team ${i + 1}` }))
    writeTimed([...big, { type: 'text', text: 'The large team is staffed.' }], 15)
    // After the 40-agent stress and the cue phases a SwiftShader runner can take longer to end the last session and show
    // the new run (CI windows-latest hit the 15 s default here twice): this one start waits longer. 45 s was not enough
    // either: on 2026-11-23 three windows-latest runs timed out here with the run already on screen and idle (tab
    // "R14 Factory floor large team Idle", End session shown) but its run-meta not drawn yet, so the wait was 120 s. The
    // renderer applies 121 spawns a render at a time: on two cores at a 6x throttle the run view took 113 s to show (and a
    // first try at 120 s failed once), and the stress phase before it took windows-latest 203 s, so the waits follow the renderer.
    await startLiveRun('Factory floor large team', 300_000)
    const bigState = await untilState((s) => s.mode === 'live' && s.workers.length >= LARGE + 1, 240_000)
    chk6(!!bigState, `large team: ${LARGE + 1} agents (root and ${LARGE} spawns) are on the floor`, await state().then((s) => s.workers.length).catch(() => null))
    if (bigState) {
      const n = bigState.workers.length
      await page.waitForFunction((k) => document.querySelectorAll('[data-testid=factory-worker]').length === k, n, { timeout: t(15_000) }).catch(() => {})
      const notice = page.locator('[data-testid=factory-notice]').first()
      await notice.waitFor({ timeout: t(15_000) }).catch(() => {})
      const fin = (await untilState((s) => s.reason === 'too-many' && s.workers.length === n, 15_000)) ?? (await state())
      chk6(n > 120, 'large team: more than 120 agents', n)
      chk6(fin.renderer === 'floor-plan' && fin.reason === 'too-many', 'large team: the test state says floor-plan with reason too-many', { renderer: fin.renderer, reason: fin.reason })
      chk6((await scene('live').getAttribute('data-renderer')) === 'floor-plan' && (await scene('live').getAttribute('data-reason')) === 'too-many', 'large team: factory-scene data-renderer floor-plan and data-reason too-many')
      chk6((await notice.getAttribute('data-notice')) === 'too-many', 'large team: factory-notice has data-notice too-many', await notice.getAttribute('data-notice').catch(() => null))
      const noticeText = ((await notice.innerText()) ?? '').replace(/\s+/g, ' ').trim()
      chk6(noticeText.includes('Large team'), 'large team: the notice title is "Large team"', noticeText)
      chk6(noticeText.includes(`This team has ${n} agents. The 3D floor shows up to 120, so the floor plan is shown.`), `large team: the body reads "This team has ${n} agents. The 3D floor shows up to 120, so the floor plan is shown."`, noticeText)
      chk6((await page.locator('[data-testid=factory-use-graph]').count()) === 1, 'large team: Use Graph is offered')
      chk6((await page.locator('[data-testid=factory-retry-3d]').count()) === 0, 'large team: there is no Try 3D again (retrying cannot help)')
      chk6((await page.locator('[data-testid=factory-canvas]').count()) === 0 && fin.engines === 0, 'large team: no canvas and no engine', { engines: fin.engines })
      chk6((await page.locator('[data-testid=factory-worker]').count()) === n, 'large team: the floor plan mirror lists every agent', await page.locator('[data-testid=factory-worker]').count())
      for (const [w, h] of [[1024, 640], [1600, 1000]]) {
        await resizeTo(w, h)
        for (const theme of ['dark', 'light']) {
          await setAppearance({ theme })
          await notice.waitFor({ timeout: t(10_000) }).catch(() => {})
          chk6(await noPageScroll(), `large team: no page scroll at ${w}x${h} ${theme}`)
          await shot(`notice-large-team-${theme}-${w}x${h}`)
        }
      }
      await resizeTo(1024, 640)
      await setAppearance({ theme: 'dark' })
    }
    await endSession(page)
    writeScript(null)
  } else log(`skip the Large team case: the 3D path is not what this run takes (renderer ${liveRenderer}${PLAN ? ', floor plan forced' : ''}); the too-many reason is judged after forced and no-WebGL2`)

  // A paused run offers Resume now and Cancel auto-resume, not End session: the ended hall is checked on the tour run above.
  // A plain run keeps a scene mounted for the forced-renderer checks below.
  writeScript([{ type: 'text', text: 'Only the root is on the floor.' }])
  await startLiveRun('Factory floor after live state')
  await waitForFloor(1)
  writeScript(null)

  // ---------- Slice 6: mount and unmount leak (section 9.1 "Leak", section 12) ----------
  // The presentation is toggled graph <-> factory floor 20 times on this one-agent run (no cue, so the quality governor
  // never steps). Geometries and textures of the next mount equal those of the first mount on this run, `engines` is 1 (the 3D
  // path) with exactly one canvas; on the floor plan there is no engine and no canvas at any mount. The toggle writes the
  // setting straight away and waits on the DOM (no fixed sleeps), so the loop takes seconds.
  {
    const setPresentationFast = (presentation) =>
      page.evaluate(async (pr) => {
        const info = await window.orgai.settings.get()
        const { dataDir: _d, appVersion: _v, ...s } = info
        await window.orgai.settings.set({ ...s, appearance: { ...s.appearance, canvas: { ...s.appearance.canvas, presentation: pr } } })
      }, presentation)
    /** The scene is mounted again: its renderer is chosen and (3D) the first frame's perf is in the state. */
    const mounted = async () => {
      await scene('live').waitFor({ timeout: t(20_000) })
      await page.waitForFunction(() => !!document.querySelector('[data-testid=factory-scene]')?.getAttribute('data-renderer'), null, { timeout: t(20_000) })
      const kind = await scene('live').getAttribute('data-renderer')
      if (kind === 'webgl2') {
        await page.locator('[data-testid=factory-canvas]').first().waitFor({ state: 'attached', timeout: t(15_000) }).catch(() => {})
        return untilPerf(15_000)
      }
      return untilState((s) => s.mode === 'live', 15_000)
    }
    /** Two reads 600 ms apart agree on geometries and textures (kits finish building after the first frame). */
    const settledCounts = async () => {
      let prev = await untilPerf(10_000)
      for (let i = 0; prev && i < 8; i++) {
        await sleep(600)
        const cur = await untilPerf(5000)
        if (!cur) break
        if (cur.perf.geometries === prev.perf.geometries && cur.perf.textures === prev.perf.textures) return cur
        prev = cur
      }
      return prev
    }
    const toggled = await mounted()
    const kind = toggled?.renderer ?? (await scene('live').getAttribute('data-renderer'))
    const firstMount = kind === 'webgl2' ? await settledCounts() : toggled
    const first = firstMount?.perf ? { geometries: firstMount.perf.geometries, textures: firstMount.perf.textures } : null
    chk6(kind === 'floor-plan' || !!first, 'leak: the first 3D mount reports geometries and textures', firstMount?.perf)
    const seen = []
    const t0 = Date.now()
    for (let i = 1; i <= 20; i++) {
      await setPresentationFast('graph')
      await page.locator('[data-testid=factory-scene]').first().waitFor({ state: 'detached', timeout: t(15_000) }).catch(() => {})
      await setPresentationFast('factory-floor')
      const st = await mounted()
      const canvases = await page.locator('[data-testid=factory-canvas]').count()
      seen.push({ i, renderer: st?.renderer ?? null, engines: st?.engines ?? -1, canvases, geometries: st?.perf?.geometries ?? null, textures: st?.perf?.textures ?? null })
    }
    const last = kind === 'webgl2' ? await settledCounts() : await state()
    log(`leak: 20 toggles in ${((Date.now() - t0) / 1000).toFixed(1)} s; first ${JSON.stringify(first)}; last ${JSON.stringify(last?.perf && { geometries: last.perf.geometries, textures: last.perf.textures })}`)
    rec['leak first mount geometries/textures'] = first ? `${first.geometries}/${first.textures}` : 'n/a (floor plan)'
    if (kind === 'webgl2') {
      chk6(seen.every((s) => s.renderer === 'webgl2'), 'leak: all 20 remounts take the 3D path again', seen.filter((s) => s.renderer !== 'webgl2').slice(0, 3))
      chk6(!!first && !!last?.perf && last.perf.geometries === first.geometries && last.perf.textures === first.textures, 'leak: after 20 toggles the next mount has the same geometries and textures as the first', { first, last: last?.perf && { geometries: last.perf.geometries, textures: last.perf.textures } })
      chk6(!!first && seen.every((s) => s.geometries !== null && s.geometries <= first.geometries && s.textures <= first.textures), 'leak: no mount in between ever held more geometries or textures than the first', seen.filter((s) => !first || s.geometries > first.geometries || s.textures > first.textures).slice(0, 3))
      chk6(last?.engines === 1 && seen.every((s) => s.engines === 1), 'leak: exactly one engine after every toggle (state engines is 1)', { last: last?.engines, others: seen.filter((s) => s.engines !== 1).slice(0, 3) })
      chk6((await page.locator('[data-testid=factory-canvas]').count()) === 1 && seen.every((s) => s.canvases === 1), 'leak: exactly one factory-canvas in the document after every toggle', seen.filter((s) => s.canvases !== 1).slice(0, 3))
      rec.firstFrameCachedMs = last?.perf?.firstFrameMs
      rec.memoryBytes = last?.perf?.memoryBytes ?? rec.memoryBytes
      checkQualityState('leak: the 21st mount', last)
    } else {
      chk6(seen.every((s) => s.renderer === 'floor-plan' && s.engines === 0 && s.canvases === 0) && last?.engines === 0, 'leak: on the floor plan path no engine exists and no canvas is mounted at any of the 20 remounts', seen.filter((s) => s.engines !== 0 || s.canvases !== 0).slice(0, 3))
    }
    // First-frame figures of section 9.1: cold is the launch's first 3D mount, cached a later one.
    if (kind === 'webgl2') {
      if (rec.firstFrameColdMs !== undefined) perfCheck(rec.firstFrameColdMs <= 700, 'time to first frame at most 700 ms on the cold first mount', rec.firstFrameColdMs)
      perfCheck(typeof rec.firstFrameCachedMs === 'number' && rec.firstFrameCachedMs <= 250, 'time to first frame at most 250 ms on a later (cached) mount', rec.firstFrameCachedMs)
    }
  }

  // CSP after the 3D sections (the listener counts every violation since the page loaded).
  {
    const v = await page.evaluate(() => window.__cspViolations ?? [])
    check(v.length === 0, `zero securitypolicyviolation events after the ${liveRenderer} renderer sections`, v.slice(0, 3).join(' | '))
  }

  // ---------- Forced floor plan, notices, Use Graph (Live scene, reads the key at mount) ----------
  await setKey('floor-plan')
  await remount()
  await scene('live').waitFor({ timeout: t(15_000) })
  await page.waitForFunction(() => document.querySelector('[data-testid=factory-scene]')?.getAttribute('data-renderer') === 'floor-plan', null, { timeout: t(10_000) }).catch(() => {})
  check((await scene('live').getAttribute('data-renderer')) === 'floor-plan', 'the developer key forces the floor plan')
  check((await scene('live').getAttribute('data-reason')) === 'forced', 'the forced floor plan reports reason forced')
  const forced = await state()
  check(forced.renderer === 'floor-plan' && forced.reason === 'forced', 'factory-state reports floor-plan / forced', JSON.stringify(forced).slice(0, 160))
  check((await page.locator('[data-testid=factory-canvas]').count()) === 0, 'the forced floor plan has no canvas')
  check((await page.locator('[data-testid=factory-notice]').count()) === 0, 'the forced floor plan shows no notice')
  check((await page.locator('[data-testid=factory-floor]').count()) === 1, 'the floor plan keeps the mirror group')
  check(await noPageScroll(), 'forced floor plan has no page scroll at 1024x640')
  await shot('forced-floor-plan')

  // FactoryScene decides the reason in this order: forced floor-plan, no WebGL2, too many agents, context lost, chunk failed.
  // A machine whose probe finds no WebGL2 (the macOS CI runner: its Live scene is already the floor plan above) therefore
  // can never reach 'chunk-failed': the forced chunk failure is moot and the no-webgl2 notice (no Try 3D again) is correct.
  // With E2E_FACTORY_PLAN the live renderer says nothing about WebGL2, so ask the browser.
  const noWebgl2Here = PLAN ? !(await page.evaluate(() => !!document.createElement('canvas').getContext('webgl2'))) : liveRenderer !== 'webgl2'
  for (const [value, notice, retry] of [['no-webgl2', 'no-webgl2', false], ['chunk-failed', noWebgl2Here ? 'no-webgl2' : 'chunk-failed', !noWebgl2Here]]) {
    await setKey(value)
    await remount()
    await scene('live').waitFor({ timeout: t(15_000) })
    await page.locator('[data-testid=factory-notice]').first().waitFor({ timeout: t(15_000) }).catch(() => {})
    const n = page.locator('[data-testid=factory-notice]').first()
    check((await n.count()) === 1 && (await n.getAttribute('data-notice')) === notice, `${value}: the ${notice} notice shows`, String(await n.getAttribute('data-notice').catch(() => null)))
    check((await scene('live').getAttribute('data-renderer')) === 'floor-plan' && (await scene('live').getAttribute('data-reason')) === notice, `${value}: the floor plan shows with reason ${notice}`)
    check((await page.locator('[data-testid=factory-use-graph]').count()) === 1, `${value}: Use Graph is offered`)
    if (retry) {
      check((await page.locator('[data-testid=factory-retry-3d]').count()) === 1, 'chunk-failed: Try 3D again is offered')
      await page.locator('[data-testid=factory-retry-3d]').click()
      await sleep(600)
      check((await page.locator('[data-testid=factory-notice]').count()) === 1, 'chunk-failed: Try 3D again fails again while the key is set')
    } else if (value === 'chunk-failed') {
      check((await page.locator('[data-testid=factory-retry-3d]').count()) === 0, 'chunk-failed on a machine without WebGL2: the no-webgl2 notice has no Try 3D again')
    }
    await shot(`notice-${value}`)
  }

  // CSP after the floor-plan sections (forced, no WebGL2, chunk failure): the count is cumulative and must still be zero.
  {
    const v = await page.evaluate(() => window.__cspViolations ?? [])
    check(v.length === 0, 'zero securitypolicyviolation events after the floor-plan renderer sections', v.slice(0, 3).join(' | '))
  }

  // Use Graph returns to the graph canvas.
  await page.locator('[data-testid=factory-use-graph]').click()
  await page.waitForFunction(() => document.documentElement.dataset.canvasPresentation === 'graph', null, { timeout: t(10_000) }).catch(() => {})
  check((await html('data-canvas-presentation')) === 'graph', 'Use Graph sets the presentation back to Graph')
  await page.locator('.react-flow').first().waitFor({ timeout: t(10_000) }).catch(() => {})
  check((await page.locator('.react-flow').count()) > 0, 'the graph canvas shows after Use Graph')
  check((await page.locator('[data-testid=factory-scene]').count()) === 0, 'the scene is gone after Use Graph')

  // Without the key the real path comes back.
  await setKey(PLAN ? 'floor-plan' : null)
  await setCanvas({ presentation: 'factory-floor' })
  const again = await checkMounted('live', 'Live after clearing the key')
  check(again === liveRenderer, 'the same renderer returns once the key is removed', `${liveRenderer} -> ${again}`)

  // ---------- Pocket Office is still selectable ----------
  await setCanvas({ presentation: 'pocket-office' })
  await page.locator('[data-testid=office-scene]').first().waitFor({ timeout: t(15_000) }).catch(() => {})
  check((await page.locator('[data-testid=office-scene]').count()) > 0, 'Pocket Office still mounts afterwards')
  check((await page.locator('[data-testid=factory-scene]').count()) === 0, 'no factory scene beside Pocket Office')
  await setCanvas({ presentation: 'graph' })

  // ---------- Slice 6: the settings sample (section 6.6): a static PNG for the app theme, never a second engine ----------
  // FactorySample.tsx (Technical Artist, slice 6): wrapper div.factory-sample[role=img][aria-label="Static sample factory
  // floor"] holding ONE <img alt="" data-testid=factory-sample-image data-sample-theme="dark|light"> and no canvas. Both the
  // presentation choice's thumbnail and (with Factory Floor chosen) the preview render it. The checks FAIL until that change lands.
  await setCanvas({ presentation: 'factory-floor' })
  await openAppSettings(page)
  await page.getByRole('tab', { name: 'Appearance', exact: true }).click()
  await page.locator('[data-testid=canvas-section]').waitFor({ timeout: t(10_000) })
  const readSamples = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('[data-testid=factory-sample]')].map((el) => {
        const img = el.querySelector('[data-testid=factory-sample-image]')
        return {
          role: el.getAttribute('role'),
          name: el.getAttribute('aria-label'),
          images: el.querySelectorAll('img').length,
          canvases: el.querySelectorAll('canvas').length,
          alt: img ? img.getAttribute('alt') : null,
          theme: img ? img.getAttribute('data-sample-theme') : null,
          naturalWidth: img ? img.naturalWidth : 0,
          preview: !!el.closest('[data-testid=canvas-preview]')
        }
      })
    )
  for (const theme of ['dark', 'light']) {
    await setAppearance({ theme })
    await page.waitForFunction((t) => { const i = document.querySelector('[data-testid=factory-sample-image]'); return !!i && i.getAttribute('data-sample-theme') === t && i.complete && i.naturalWidth > 0 }, theme, { timeout: t(8000) }).catch(() => {})
    check((await html('data-theme')) === theme, `[slice6 sample] the app theme is ${theme}`, String(await html('data-theme')))
    const samples = await readSamples()
    check(samples.length >= 1 && samples.some((s) => s.preview), `[slice6 sample] ${theme}: the settings page shows the sample (the preview with Factory Floor chosen, and the thumbnail)`, `${samples.length} samples, ${samples.filter((s) => s.preview).length} previews`)
    check(samples.every((s) => s.role === 'img' && s.name === 'Static sample factory floor'), `[slice6 sample] ${theme}: every factory-sample is role img named "Static sample factory floor"`, JSON.stringify(samples.map((s) => [s.role, s.name])))
    check(samples.every((s) => s.images === 1 && s.alt === ''), `[slice6 sample] ${theme}: each sample holds exactly one <img alt="">`, JSON.stringify(samples.map((s) => [s.images, s.alt])))
    check(samples.every((s) => s.theme === theme), `[slice6 sample] ${theme}: each image's data-sample-theme is ${theme}`, JSON.stringify(samples.map((s) => s.theme)))
    check(samples.length > 0 && samples.every((s) => s.naturalWidth > 0), `[slice6 sample] ${theme}: each image loaded (naturalWidth above 0)`, JSON.stringify(samples.map((s) => s.naturalWidth)))
    check(samples.every((s) => s.canvases === 0), `[slice6 sample] ${theme}: no canvas inside a sample`, JSON.stringify(samples.map((s) => s.canvases)))
    // No second engine: no canvas outside a live scene anywhere on the page; a live scene mounted elsewhere keeps engines at 1.
    const strayCanvases = await page.evaluate(() => [...document.querySelectorAll('[data-testid=factory-canvas]')].filter((c) => !c.closest('[data-testid=factory-scene]')).length)
    check(strayCanvases === 0, `[slice6 sample] ${theme}: no factory-canvas outside a live scene on the settings page`, String(strayCanvases))
    const liveScenes = await page.locator('[data-testid=factory-scene]').count()
    if (liveScenes > 0) {
      const st = await state().catch(() => null)
      check(!!st && (st.renderer === 'floor-plan' ? st.engines === 0 : st.engines === 1) && (await page.locator('[data-testid=factory-canvas]').count()) <= 1, `[slice6 sample] ${theme}: a live scene elsewhere keeps its one engine (the sample adds none)`, JSON.stringify(st && { renderer: st.renderer, engines: st.engines }))
    } else log(`settings ${theme}: no live scene is mounted beside the sample (no state to read), canvases on the page: ${await page.locator('[data-testid=factory-canvas]').count()}`)
    check((await page.locator('[data-testid=factory-canvas]').count()) <= 1, `[slice6 sample] ${theme}: at most one factory-canvas on the page`, String(await page.locator('[data-testid=factory-canvas]').count()))
    await shot(`settings-sample-${theme}`)
  }
  await setAppearance({ theme: 'dark' })

  // ---------- CSP ----------
  const violations = await page.evaluate(() => window.__cspViolations ?? [])
  check(violations.length === 0, 'zero securitypolicyviolation events', violations.slice(0, 3).join(' | '))
} catch (e) {
  check(false, 'factory-floor script ran to the end', e.stack ?? String(e))
  await shot('failure')
} finally {
  // One block of numbers for the UI Lead's table (section 9.1): always printed, asserted only with E2E_FACTORY_PERF=1 on a real GPU.
  rec.devicePixelRatio = await page.evaluate(() => window.devicePixelRatio).catch(() => undefined)
  log(`PERF ---- Factory Floor timing and budget numbers (${PERF ? 'asserted: E2E_FACTORY_PERF=1' : 'recorded only'}; ${SWGL ? 'SwiftShader switches on' : 'the machine GPU'}${PLAN ? '; floor plan forced' : ''}) ----`)
  for (const [k, v] of Object.entries(rec)) log(`PERF ${k}: ${v}`)
  log('PERF ---- end ----')
  await page.evaluate((k) => localStorage.removeItem(k), KEY).catch(() => {})
  if (projectOpen) await endSession(page).catch(() => {})
  await cleanup(app, page, NAME)
}
finish('factory-floor')
